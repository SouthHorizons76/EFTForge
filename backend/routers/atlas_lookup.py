"""Atlas player lookup (testing): find players by nickname, and one player's profile and equipped gear.

Lookups come from Atlas' upstream provider. We only forward to it, at ATLAS_LOOKUP_URL
(e.g. http://127.0.0.1:8765, through an SSH tunnel when testing locally), add each item's
icon, picture and inventory tint from tarkov.db, and have Kitbash! draw each equipped weapon
and helmet as built (build_images, as for build previews). Each weapon also gets the
builder's own build payload ({v, g, p, a} as build-codes.js encodes it), so the page can open
it in the builder with ?build=. The provider answers with name, side, level, prestige, league
rank and edition, ending, overall stats, achievements, skills and weapon mastering, seasonal
modifiers, season progress, the favorite items and the equipped gear, each piece with
what's attached to it (`children`). Favorite weapons get their drawing and builder payload
like equipped ones, and each weapon mastering the icon and names of the first of its weapons
tarkov.db knows (`weapon`).

Admin only while it's a test, so lookups stay within the provider's limits. Without ATLAS_LOOKUP_URL (production, for now) it answers 503.
"""

import hashlib
import json
import logging
import os
import re
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

import build_images
from build_images import build_image_key, loaded_image_key
from models_armor import ArmorPiece
from models_items import Item
from models_slots import Slot
from routers import images
from routers.shared import get_db, require_admin

_logger = logging.getLogger(__name__)

router = APIRouter()

ATLAS_LOOKUP_URL = os.environ.get("ATLAS_LOOKUP_URL", "").strip().rstrip("/")
LOOKUP_TIMEOUT_SECONDS = 30  # the provider paces lookups, so one may wait a few seconds for its turn
FAVORITE_WEAPON_LIMIT = 6  # favorite weapons drawn per lookup, so a long list stays quick
_ACCOUNT_RE = re.compile(r"^[0-9]{1,12}$")
_NICKNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,15}$")


def _tpls(nodes: list) -> set[str]:
    out = set()
    for n in nodes:
        out.add(n.get("tpl"))
        out.update(a.get("tpl") for a in n.get("ammo") or [])
        out |= _tpls(n.get("children") or [])
    return {t for t in out if isinstance(t, str)}


def _add_art(nodes: list, items: dict[str, Item]) -> None:
    """Each item's icon, picture and the game's inventory tint behind it, when tarkov.db has them,
    for it and everything attached to it."""
    for n in nodes:
        item = items.get(n.get("tpl"))
        n["icon"] = item.icon_link if item else None
        n["image"] = (item.base_image_link or item.image_512_link) if item else None
        n["bg"] = item.background_color if item else None
        for a in n.get("ammo") or []:
            ammo = items.get(a.get("tpl"))
            a["icon"] = ammo.icon_link if ammo else None
        _add_art(n.get("children") or [], items)


def builder_payload(node: dict, db: Session) -> dict:
    """The weapon as the builder's share payload: pairs of (our slot id, item) in breadth-first
    order, as collectSlotPairs walks a build. Every attached part gets the builder's own
    slot_name to show; a part whose slot tarkov.db doesn't know is left out with its subtree,
    and the payload says it's incomplete."""
    pairs, complete = [], True
    queue = [node]
    while queue:
        parent = queue.pop(0)
        children = [c for c in parent.get("children") or [] if c.get("slot") != "patron_in_weapon"]
        if not children:
            continue
        slots = {
            s.slot_game_name: s
            for s in db.query(Slot).filter(Slot.parent_item_id == parent["tpl"], Slot.slot_game_name.isnot(None))
        }
        for child in children:
            slot = slots.get(child.get("slot"))
            if slot is None:
                complete = False
                continue
            child["slot_name"] = slot.slot_name
            child["slot_id"] = slot.id
            pairs.append([slot.id, child["tpl"]])
            queue.append(child)
    payload = {"v": 1, "g": node["tpl"], "p": pairs}
    ammo = _first_ammo(node)
    if ammo:
        payload["a"] = ammo
    return {"payload": payload, "complete": complete}


def armor_class(node: dict, db: Session) -> int | None:
    """The class a worn piece shows, as the Ballistics Workbench badges it (armor-sim.js
    _wornClass): the best of the item's own armor and everything in it (plates, helmet parts)."""
    tpls = {node["tpl"]} | {n["tpl"] for n in _walk(node)}
    best = max(
        (p.armor_class or 0 for p in db.query(ArmorPiece).filter(ArmorPiece.holder_item_id.in_(tpls))), default=0
    )
    return best or None


def _walk(node: dict):
    for child in node.get("children") or []:
        yield child
        yield from _walk(child)


def _instance_id(path: str) -> str:
    return hashlib.sha256(path.encode()).hexdigest()[:24]


def build_items(node: dict) -> list[dict]:
    """A gear tree from the upstream provider as the SPT-format items Kitbash! draws: the root in the
    "hideout" slot, then every attached part, breadth first. Rounds are left out; the
    render loads them itself."""
    root_id = _instance_id(node["tpl"] + ":root")
    items = [{"_id": root_id, "_tpl": node["tpl"], "slotId": "hideout", "parentId": "hideout"}]
    queue = [(node, root_id)]
    while queue:
        parent, parent_id = queue.pop(0)
        for child in parent.get("children") or []:
            if child.get("slot") == "patron_in_weapon":
                continue
            child_id = _instance_id(f"{parent_id}/{child['slot']}:{child['tpl']}")
            items.append({"_id": child_id, "_tpl": child["tpl"], "slotId": child["slot"], "parentId": parent_id})
            queue.append((child, child_id))
    return items


def _first_ammo(node: dict) -> str | None:
    for a in node.get("ammo") or []:
        return a.get("tpl")
    for child in node.get("children") or []:
        found = _first_ammo(child)
        if found:
            return found
    return None


def render(node: dict, item: Item) -> str | None:
    """A data URL of the weapon or helmet as built, or None when Kitbash! can't draw it."""
    if images._imggen_disabled or not build_images.available():
        return None
    weapon = bool(item.is_weapon)
    if not (weapon or item.armor_kind == "helmet"):
        return None
    items = build_items(node)
    ammo = _first_ammo(node) if weapon else None
    if not weapon:  # face shields down, as the Ballistics Workbench draws helmets
        items = [items[0]] + [{**i, "upd": {"Togglable": {"On": True}}} for i in items[1:]]
    try:
        key = loaded_image_key(build_image_key(node["tpl"], items), ammo, None) + ("" if weapon else ":on")
        data, _ = build_images.render_webp(key, items, ammo, None)
    except (ValueError, build_images.Unrenderable) as exc:
        _logger.info("atlas lookup: Kitbash! can't draw %s: %s", node["tpl"], exc)
        return None
    return build_images.data_url(data)


def fetch_upstream(path: str, params: dict) -> tuple[int, dict]:
    """(status, body) from Atlas' upstream provider."""
    url = f"{ATLAS_LOOKUP_URL}{path}?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=LOOKUP_TIMEOUT_SECONDS) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except ValueError:
            return e.code, {"error": "lookup", "message": f"HTTP {e.code}"}
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        reason = getattr(e, "reason", e)
        return 502, {"error": "unreachable", "message": f"Atlas' upstream provider didn't answer ({reason})"}


def _ask(path: str, params: dict) -> dict:
    """The upstream provider's answer, or its error passed on as an HTTPException."""
    if not ATLAS_LOOKUP_URL:
        raise HTTPException(status_code=503, detail="Player lookup is not configured (ATLAS_LOOKUP_URL)")
    status, body = fetch_upstream(path, params)
    if status != 200 or not isinstance(body, dict):
        message = body.get("message") if isinstance(body, dict) else None
        code = body.get("error") if isinstance(body, dict) else None
        # The provider's own status says what went wrong (session lost, paced, backend refused...)
        raise HTTPException(
            status_code=status if 400 <= status < 600 else 502,
            detail={"error": code or "lookup", "message": message or "lookup failed"},
        )
    return body


@router.get("/atlas/api/lookup/search", dependencies=[Depends(require_admin)])
def atlas_lookup_search(response: Response, nickname: str = Query(...)):
    response.headers["Cache-Control"] = "no-store"
    nickname = nickname.strip()
    if not _NICKNAME_RE.match(nickname):
        raise HTTPException(status_code=422, detail="a nickname is 3 to 15 letters, digits, _ . or -")
    return _ask("/search", {"nickname": nickname})


@router.get("/atlas/api/lookup", dependencies=[Depends(require_admin)])
def atlas_lookup(response: Response, account_id: str = Query(..., alias="accountId"), db: Session = Depends(get_db)):
    response.headers["Cache-Control"] = "no-store"
    account_id = account_id.strip()
    if not _ACCOUNT_RE.match(account_id):
        raise HTTPException(status_code=422, detail="accountId must be digits")
    body = _ask("/lookup", {"accountId": account_id})
    slots = body.get("slots") or []
    favorites = body.get("favorites") or []
    mastering = ((body.get("skills") or {}).get("mastering")) or []
    tpls = (
        _tpls(slots) | _tpls(favorites) | {t for m in mastering for t in m.get("templates") or [] if isinstance(t, str)}
    )
    items = {i.id: i for i in db.query(Item).filter(Item.id.in_(tpls))} if tpls else {}
    _add_art(slots, items)
    _add_art(favorites, items)
    for slot in slots:
        item = items.get(slot.get("tpl"))
        slot["render"] = render(slot, item) if item else None
        if item and item.is_weapon:
            slot["build"] = builder_payload(slot, db)
        elif item:
            slot["armor_class"] = armor_class(slot, db)
    weapons = [f for f in favorites if items.get(f.get("tpl")) and items[f["tpl"]].is_weapon]
    for node in weapons[:FAVORITE_WEAPON_LIMIT]:
        node["render"] = render(node, items[node["tpl"]])
        node["build"] = builder_payload(node, db)
    for m in mastering:
        m["weapon"] = mastering_weapon(m, items)
    return body


def mastering_weapon(mastering: dict, items: dict[str, Item]) -> dict | None:
    """The first of a mastering's weapons tarkov.db knows, as the page shows it."""
    for tpl in mastering.get("templates") or []:
        item = items.get(tpl)
        if item and item.is_weapon:
            return {
                "tpl": tpl,
                "icon": item.icon_link,
                "en": {"name": item.name or "", "short": item.short_name or ""},
                "ch": {"name": item.name_zh or "", "short": item.short_name_zh or ""},
            }
    return None

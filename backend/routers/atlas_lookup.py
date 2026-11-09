"""Atlas player lookup: find players by nickname, and one player's profile and equipped gear.

Lookups come from Atlas' upstream provider. We only forward to it, at ATLAS_LOOKUP_URL
(e.g. http://127.0.0.1:8765, through an SSH tunnel when testing locally), add each item's
icon, picture and inventory tint from tarkov.db, and have Kitbash! draw each equipped weapon
and helmet as built (build_images, as for build previews). A drawing goes out as its own address,
/atlas/api/lookup-art/<hash of what's drawn>, kept on disk and cached for a year by EdgeOne and
browsers, so a mode switch, a second visit or another player with the same build downloads
nothing again. It sits outside /atlas/api/lookup on purpose: nginx's flood limit there would
count each picture of a profile as a lookup. Each weapon also gets the
builder's own build payload ({v, g, p, a} as build-codes.js encodes it), so the page can open
it in the builder with ?build=. The provider answers with name, side, level, prestige, league
rank and edition, ending, overall stats, achievements, skills and weapon mastering, seasonal
modifiers, season progress, the favorite items and the equipped gear, each piece with
what's attached to it (`children`). Favorite weapons get their drawing and builder payload
like equipped ones, and each weapon mastering the icon and names of the first of its weapons
tarkov.db knows (`weapon`). Kitbash! also draws the player's character from the provider's
`customization` (head, body and feet suits) and the worn gear, face shields and NVGs as the
player left them: `character` has a headshot and a full-body address, kept like the drawings.

Every lookup names a game mode (season, pvp, pve or arena; season by default), which the provider
answers from that mode's own account; Arena's profile has its own fields (arenaStats, battlePasses).

/atlas/api/lookup/banned guesses whether an account is banned (ban_guess), so other sites
don't each redo the guess with their own mistakes.

Open to everyone. services/lookup_guard.py rate limits each IP (shared by every worker), caps the
lookups in flight at once and keeps finished answers for a minute; a cached answer costs the
asker nothing. Another site's server (a chat bot answering its users, say) can send an Atlas key
the way the change set feed takes one (X-Atlas-Key or "Authorization: Bearer atl_..."): its
lookups then count against the key's own allowance instead of its IP's, may only hold a few of
the slots, and stop the moment the key is revoked. The key is optional; a wrong one is a 403. Only a known error code goes back to the browser: the provider's own messages
and why it couldn't be reached go to the log. Without ATLAS_LOOKUP_URL it answers 503.
"""

import hashlib
import json
import logging
import os
import re
import threading
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

import build_images
from build_images import build_image_key, loaded_image_key
from config import RUNTIME_DIR
from models_armor import ArmorPiece
from models_items import Item
from models_slots import Slot
from routers import atlas, images
from routers.shared import get_client_ip, get_db
from services import lookup_guard

_logger = logging.getLogger(__name__)

router = APIRouter()

ATLAS_LOOKUP_URL = os.environ.get("ATLAS_LOOKUP_URL", "").strip().rstrip("/")
LOOKUP_TIMEOUT_SECONDS = 30  # the provider paces lookups, so one may wait a few seconds for its turn
FAVORITE_WEAPON_LIMIT = 6  # favorite weapons drawn per lookup, so a long list stays quick
_ACCOUNT_RE = re.compile(r"^[0-9]{1,12}$")
_NICKNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,15}$")
# Kitbash! drawings by the hash of what's drawn, served by /atlas/api/lookup-art. A built rifle
# is about 10 to 20 KB, so the cap holds over ten thousand; past it the least recently used go first.
ART_DIR = os.path.join(RUNTIME_DIR, "lookup_art")
ART_URL = "/atlas/api/lookup-art"
ART_DIR_BYTES = 200 * 1024 * 1024
ART_PRUNE_EVERY = 50  # stores between checks of the folder's size
_ART_NAME_RE = re.compile(r"[0-9a-f]{32}")
_art_lock = threading.Lock()
_art_stores = 0
# The equipment slots a character render dresses the player in (Kitbash!'s kitbash/character.py
# WORN), and the equipment root they hang from, under a made-up id
CHARACTER_SLOTS = ("ArmorVest", "TacticalVest", "Backpack", "Headwear", "Earpiece", "Eyewear", "FaceCover", "ArmBand")
CHARACTER_ROOT = "0" * 24
# The full body also holds a gun in its hand: the first of these the player carries (Kitbash!'s
# HANDS). The headshot never shows it, so it is left out of the headshot's items and address.
CHARACTER_GUN_SLOTS = ("FirstPrimaryWeapon", "SecondPrimaryWeapon", "Holster")
# The game modes a lookup can be for; the provider needs an account for each
LOOKUP_MODES = ("season", "pvp", "pve", "arena")
# The error codes the page knows (atlas-lookup.js errorInfo); anything else goes out as "lookup"
PUBLIC_ERRORS = {"session", "backend", "not_found", "no_profile", "mode", "bad_account", "bad_nickname", "rate", "busy"}


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
    """The address of the weapon or helmet as built (see ART_URL), or None when Kitbash! can't
    draw it. One drawn before is reused as it is, without drawing it again."""
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
        name = hashlib.sha256(key.encode()).hexdigest()[:32]
        path = os.path.join(ART_DIR, name + ".webp")
        if os.path.isfile(path):
            os.utime(path)  # recently used, so pruning keeps it
        else:
            data, _ = build_images.render_webp(key, items, ammo, None)
            _store_art(path, data)
    except (ValueError, build_images.Unrenderable) as exc:
        _logger.info("atlas lookup: Kitbash! can't draw %s: %s", node["tpl"], exc)
        return None
    except OSError as exc:
        _logger.warning("atlas lookup: couldn't keep a drawing: %s", exc)
        return None
    return f"{ART_URL}/{name}"


def character_items(slots: list, gun: bool = False) -> list[dict]:
    """The worn gear (CHARACTER_SLOTS) as the SPT-format items Kitbash! dresses a character in,
    each switch as the player left it (face shields and NVGs up or down). With gun, also the gun
    the full body holds, with everything on it."""
    roots = [slot for slot in slots if slot.get("slot") in CHARACTER_SLOTS]
    if gun:
        held = next((s for want in CHARACTER_GUN_SLOTS for s in slots if s.get("slot") == want), None)
        if held is not None:
            roots.append(held)
    items = []
    queue = [(slot, CHARACTER_ROOT) for slot in roots]
    while queue:
        node, parent_id = queue.pop(0)
        if not isinstance(node.get("tpl"), str) or not isinstance(node.get("slot"), str):
            continue
        item_id = _instance_id(f"{parent_id}/{node['slot']}:{node['tpl']}")
        item = {"_id": item_id, "_tpl": node["tpl"], "slotId": node["slot"], "parentId": parent_id}
        if isinstance(node.get("on"), bool):
            item["upd"] = {"Togglable": {"On": node["on"]}}
        items.append(item)
        queue.extend((child, item_id) for child in node.get("children") or [])
    return items


def render_character(body: dict) -> dict | None:
    """Addresses of the player's character drawn by Kitbash!, by view (headshot, full), as
    ART_URL keeps them; a view Kitbash! can't draw is None, and None when it draws neither."""
    customization = body.get("customization")
    if not isinstance(customization, dict) or images._imggen_disabled or not build_images.available():
        return None
    slots = body.get("slots") or []
    out = {}
    for view in build_images.CHARACTER_VIEWS:
        out[view] = None
        items = character_items(slots, gun=view == "full")
        try:
            key = build_images.character_key(view, customization, items)
            if key is None:
                continue
            name = hashlib.sha256(f"character:{key}".encode()).hexdigest()[:32]
            path = os.path.join(ART_DIR, name + ".webp")
            if os.path.isfile(path):
                os.utime(path)  # recently used, so pruning keeps it
            else:
                _store_art(path, build_images.render_character_webp(view, customization, items))
            out[view] = f"{ART_URL}/{name}"
        except build_images.Unrenderable as exc:
            _logger.info("atlas lookup: Kitbash! can't draw the character (%s): %s", view, exc)
        except OSError as exc:
            _logger.warning("atlas lookup: couldn't draw or keep a character (%s): %s", view, exc)
    return out if any(out.values()) else None


def _store_art(path: str, data: bytes) -> None:
    """Write a drawing whole (never half a file for a reader), and now and then drop the least
    recently used ones past ART_DIR_BYTES."""
    global _art_stores
    os.makedirs(ART_DIR, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    with _art_lock:
        _art_stores += 1
        if _art_stores % ART_PRUNE_EVERY:
            return
        prune_art()


def prune_art() -> None:
    files = []
    for entry in os.scandir(ART_DIR):
        if entry.name.endswith(".webp"):
            st = entry.stat()
            files.append((st.st_mtime, st.st_size, entry.path))
    total = sum(size for _, size, _ in files)
    if total <= ART_DIR_BYTES:
        return
    # down to 80%, so the next few stores don't each start another sweep
    for _, size, path in sorted(files):
        if total <= ART_DIR_BYTES * 0.8:
            break
        try:
            os.remove(path)
            total -= size
        except OSError:
            pass


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
        return 502, {"error": "unreachable", "message": f"no answer ({reason})"}


def _ask(path: str, params: dict) -> dict:
    """The upstream provider's answer, or its error passed on as an HTTPException with only a
    known code: its message stays in the log."""
    status, body = fetch_upstream(path, params)
    if status != 200 or not isinstance(body, dict):
        message = body.get("message") if isinstance(body, dict) else None
        code = body.get("error") if isinstance(body, dict) else None
        _logger.info("atlas lookup: %s answered %s %s: %s", path, status, code, message)
        # The provider pacing its own lookups is busy on our side, never the asker's rate limit:
        # that one only comes from lookup_guard.take, before the provider is asked
        if status == 429:
            raise HTTPException(status_code=429, detail={"error": "busy"}, headers={"Retry-After": "5"})
        # The provider's own status says what went wrong (session lost, backend refused...)
        raise HTTPException(
            status_code=status if 400 <= status < 600 else 502,
            detail={"error": code if code in PUBLIC_ERRORS else "lookup"},
        )
    return body


def _guarded(request: Request, key: tuple, work):
    """A cached answer (marked so the page can say so) when there is one; otherwise a slotted,
    counted lookup, kept for the next asker. The slot comes first, so a lookup turned away as
    busy doesn't count against the asker's allowance."""
    if not ATLAS_LOOKUP_URL:
        raise HTTPException(status_code=503, detail={"error": "unavailable"})
    # checked before the cache, so a wrong or revoked key is refused even for a kept answer
    viewer = atlas.request_key(request)
    body = lookup_guard.cached(key)
    if body is not None:
        return {**body, "cached": True}
    with lookup_guard.in_flight(keyed=viewer is not None):
        lookup_guard.take(get_client_ip(request), viewer["id"] if viewer else None)
        body = work()
    lookup_guard.remember(key, body)
    return body


def _mode(mode: str) -> str:
    if mode not in LOOKUP_MODES:
        raise HTTPException(status_code=422, detail=f"mode must be one of {', '.join(LOOKUP_MODES)}")
    return mode


@router.get("/atlas/api/lookup/search")
def atlas_lookup_search(request: Request, response: Response, nickname: str = Query(...), mode: str = "season"):
    response.headers["Cache-Control"] = "no-store"
    nickname = nickname.strip()
    if not _NICKNAME_RE.match(nickname):
        raise HTTPException(status_code=422, detail="a nickname is 3 to 15 letters, digits, _ . or -")
    params = {"nickname": nickname, "mode": _mode(mode)}
    return _guarded(request, ("search", mode, nickname.lower()), lambda: _ask("/search", params))


# What the game's nickname search answers for: a name in our own pattern that isn't a
# TarkovCitizen one (the name the game gives players it renamed), which it refuses outright
def searchable_name(nickname: str) -> bool:
    return bool(_NICKNAME_RE.match(nickname)) and not nickname.lower().startswith("tarkovcitizen")


def ban_guess(account_id: str, mode: str) -> dict:
    """Whether an account is possibly banned, guessed as tarkov.dev guesses it: the game's
    nickname search leaves banned accounts out while their profile still opens by ID, so we
    open the profile for its current nickname and search that. A profile or search another
    asker just had comes from the cache, so a check from the players page usually costs only
    the search."""
    profile = lookup_guard.cached(("lookup", mode, account_id))
    if profile is None:
        profile = _ask("/lookup", {"accountId": account_id, "mode": mode})
    nickname = str(profile.get("nickname") or "")
    out = {"accountId": account_id, "mode": mode, "nickname": nickname}
    if not searchable_name(nickname):
        return {**out, "status": "unknown", "reason": "unsearchable_name"}
    key = ("search", mode, nickname.lower())
    found = lookup_guard.cached(key)
    if found is None:
        found = _ask("/search", {"nickname": nickname, "mode": mode})
        lookup_guard.remember(key, found)
    listed = any(str(p.get("accountId")) == account_id for p in found.get("players") or [])
    return {**out, "status": "no_sign_of_ban" if listed else "possibly_banned", "reason": None}


@router.get("/atlas/api/lookup/banned")
def atlas_lookup_banned(
    request: Request, response: Response, account_id: str = Query(..., alias="accountId"), mode: str = "season"
):
    """The ban guess for other sites and the players page alike, so everyone gets the same
    answer with the same rules. Counts as one lookup against the asker's allowance."""
    response.headers["Cache-Control"] = "no-store"
    account_id = account_id.strip()
    if not _ACCOUNT_RE.match(account_id):
        raise HTTPException(status_code=422, detail="accountId must be digits")
    mode = _mode(mode)
    return _guarded(request, ("banned", mode, account_id), lambda: ban_guess(account_id, mode))


@router.get("/atlas/api/lookup")
def atlas_lookup(
    request: Request,
    response: Response,
    account_id: str = Query(..., alias="accountId"),
    db: Session = Depends(get_db),
    mode: str = "season",
):
    response.headers["Cache-Control"] = "no-store"
    account_id = account_id.strip()
    if not _ACCOUNT_RE.match(account_id):
        raise HTTPException(status_code=422, detail="accountId must be digits")
    params = {"accountId": account_id, "mode": _mode(mode)}
    return _guarded(request, ("lookup", mode, account_id), lambda: _profile(params, db))


def _profile(params: dict, db: Session) -> dict:
    """One player's profile from the provider, with our art, drawings and builder payloads added."""
    body = _ask("/lookup", params)
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
        elif item and slot.get("slot") == "TacticalVest":
            # the game only shares a rig's plates with friends of the lookup account, so an
            # armored rig's class here would come out wrong; leave its badge off
            slot["armor_class"] = None
        elif item:
            slot["armor_class"] = armor_class(slot, db)
            # the board badges the plates and helmet attachments beside their parent too
            for child in slot.get("children") or []:
                child["armor_class"] = armor_class(child, db)
    weapons = [f for f in favorites if items.get(f.get("tpl")) and items[f["tpl"]].is_weapon]
    for node in weapons[:FAVORITE_WEAPON_LIMIT]:
        node["render"] = render(node, items[node["tpl"]])
        node["build"] = builder_payload(node, db)
    for m in mastering:
        m["weapon"] = mastering_weapon(m, items)
    body["character"] = render_character(body)
    return body


@router.get("/atlas/api/lookup-art/{name}")
def atlas_lookup_art(name: str):
    """A drawing render() kept. The name is a hash of what's drawn, so it never changes."""
    # fullmatch, since $ would let a trailing newline through; and the resolved path has to
    # stay inside ART_DIR, whatever the name turns out to be
    if not _ART_NAME_RE.fullmatch(name):
        raise HTTPException(status_code=404, detail="Not found")
    root = os.path.realpath(ART_DIR)
    path = os.path.realpath(os.path.join(root, name + ".webp"))
    if not path.startswith(root + os.sep) or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(path, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000, immutable"})


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

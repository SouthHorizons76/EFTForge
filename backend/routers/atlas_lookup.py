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
With Kitbash!'s render service (KITBASH_RENDER_URL) it also has `full3d`: the full body in 3D,
every carried weapon drawn where the game puts it and one in the hands, in the game's own hold
or a custom pose. Its pictures are /atlas/api/lookup-render/<spec>/<weapon in hand>/<pose>:
the spec (what the character wears and carries) is kept on disk by its hash, so the address
names exactly one picture; each is drawn on first request (only those count against the IP's
render allowance), then kept and cached like the drawings.

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
from fastapi.responses import FileResponse, RedirectResponse
from sqlalchemy.orm import Session

import build_images
from build_images import build_image_key, loaded_image_key
from config import RUNTIME_DIR
from models_armor import ArmorPiece
from models_items import Item
from models_slots import Slot
from routers import atlas, images
from routers.shared import get_client_ip, get_db
from services import lookup_guard, player_index

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
ART_DIR_BYTES = 1024 * 1024 * 1024  # 3D full bodies are about 75 KB each, the drawings 10 to 20
# 3D full body specs (render_character3d), by the hash of what the character wears and carries
SPEC_DIR = os.path.join(RUNTIME_DIR, "lookup_specs")
SPEC_DIR_BYTES = 64 * 1024 * 1024
RENDER_URL = "/atlas/api/lookup-render"
# The weapon slots the 3D full body draws (Kitbash!'s kitbash/character.py WEAPON_SLOTS)
CHARACTER3D_WEAPON_SLOTS = ("FirstPrimaryWeapon", "SecondPrimaryWeapon", "Holster", "Scabbard")
_POSE_RE = re.compile(r"[a-z0-9_]{1,40}")
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
    return _profile_items(roots)


def _profile_items(roots: list) -> list[dict]:
    """Equipment slots and what hangs on them as SPT-format items under CHARACTER_ROOT."""
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


def render_character3d(body: dict, items: dict[str, Item] | None = None) -> dict | None:
    """The 3D full body (Kitbash!'s render service), or None without one: the spec it's drawn from
    (kept under SPEC_DIR by its hash), the weapon in hand by default and every weapon the page
    can put there, the poses for each, and the default picture's address. Nothing is drawn yet:
    the picture is drawn when its address is first asked for."""
    customization = body.get("customization")
    if not isinstance(customization, dict) or images._imggen_disabled or not build_images.character3d_available():
        return None
    slots = body.get("slots") or []
    parts = {p: customization.get(p) for p in ("head", "body", "feet")}
    worn = _profile_items([s for s in slots if s.get("slot") in CHARACTER_SLOTS])
    weapons = {}
    for slot in slots:
        if slot.get("slot") in CHARACTER3D_WEAPON_SLOTS and isinstance(slot.get("tpl"), str):
            weapons[slot["slot"]] = _profile_items([slot])
    try:
        spec = build_images.character3d_spec(parts, worn, weapons, None, None)
        if not spec["outfit"]["pieces"]:
            return None
        # each weapon's category (tarkov.db), which some custom poses aren't offered for; kept
        # with the spec, so the picture endpoint checks a pose the same way
        categories = {}
        for h, its in weapons.items():
            item = (items or {}).get(its[0]["_tpl"])
            if item is not None and item.weapon_category:
                categories[h] = item.weapon_category
        spec["categories"] = categories
        # the id goes into the picture's address, which the CDN keeps for a year, so it covers
        # the bake and CHARACTER3D_VERSION too: a new look has to be a new address
        name = hashlib.sha256(build_images.character3d_key(spec).encode()).hexdigest()[:32]
        path = os.path.join(SPEC_DIR, name + ".json")
        if os.path.isfile(path):
            os.utime(path)
        else:
            _store_spec(path, spec)
        hand = build_images.character3d_default_hand(weapons)
        hands = [h for h in CHARACTER3D_WEAPON_SLOTS if h in weapons] + [None]
        poses = {h or "none": build_images.character3d_poses(h, categories.get(h)) for h in hands}
    except (build_images.Unrenderable, KeyError, ValueError) as exc:
        _logger.info("atlas lookup: Kitbash! can't set up the 3D full body: %s", exc)
        return None
    except OSError as exc:
        _logger.warning("atlas lookup: couldn't keep a 3D full body spec: %s", exc)
        return None
    return {
        "spec": name,
        "hand": hand,
        "weapons": [{"slot": h, "tpl": weapons[h][0]["_tpl"]} for h in hands if h],
        "poses": {h: [{**p, "id": p["id"] or "default"} for p in ps] for h, ps in poses.items()},
        "url": f"{RENDER_URL}/{name}/{hand or 'none'}/default",
    }


def _store_spec(path: str, spec: dict) -> None:
    os.makedirs(SPEC_DIR, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(spec, f, separators=(",", ":"))
    os.replace(tmp, path)
    with _art_lock:
        if _art_stores % ART_PRUNE_EVERY == 0:
            _prune(SPEC_DIR, ".json", SPEC_DIR_BYTES)


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
    _prune(ART_DIR, ".webp", ART_DIR_BYTES)


def _prune(folder: str, ext: str, cap: int) -> None:
    files = []
    for entry in os.scandir(folder):
        if entry.name.endswith(ext):
            st = entry.stat()
            files.append((st.st_mtime, st.st_size, entry.path))
    total = sum(size for _, size, _ in files)
    if total <= cap:
        return
    # down to 80%, so the next few stores don't each start another sweep
    for _, size, path in sorted(files):
        if total <= cap * 0.8:
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
def atlas_lookup_search(
    request: Request, response: Response, nickname: str = Query(...), mode: str = "season", live: bool = False
):
    """Players by nickname. A name tarkov.dev's player index knows (services/player_index) is
    answered from it, without asking the game and without counting against the allowance;
    source says which ("index" or "live"). live=1 always asks the game, for a name the index
    has under an account that has since been renamed."""
    response.headers["Cache-Control"] = "no-store"
    nickname = nickname.strip()
    if not _NICKNAME_RE.match(nickname):
        raise HTTPException(status_code=422, detail="a nickname is 3 to 15 letters, digits, _ . or -")
    params = {"nickname": nickname, "mode": _mode(mode)}
    if not live and ATLAS_LOOKUP_URL:
        found = player_index.find(mode, nickname)
        if found:
            atlas.request_key(request)  # a wrong key is still refused, as for a live search
            return {"nickname": nickname, "mode": mode, "players": found, "source": "index"}
    return _guarded(request, ("search", mode, nickname.lower()), lambda: _search_live(params))


def _search_live(params: dict) -> dict:
    """The game's own search, every player it lists recorded in the player index."""
    body = _ask("/search", params)
    player_index.record(
        params["mode"],
        [(p.get("accountId"), p.get("nickname")) for p in body.get("players") or [] if isinstance(p, dict)],
    )
    return {**body, "source": "live"}


def _learn(mode: str, account_id: str, profile: dict) -> None:
    """A profile's current name, into the player index."""
    player_index.record(mode, [(account_id, profile.get("nickname"))])


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
        _learn(mode, account_id, profile)
    nickname = str(profile.get("nickname") or "")
    out = {"accountId": account_id, "mode": mode, "nickname": nickname}
    if not searchable_name(nickname):
        return {**out, "status": "unknown", "reason": "unsearchable_name"}
    key = ("search", mode, nickname.lower())
    found = lookup_guard.cached(key)
    if found is None:
        found = _search_live({"nickname": nickname, "mode": mode})
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
    art: bool = True,
):
    """A player's profile. art=0 leaves out every Kitbash! drawing (gear renders, the character in
    2D and 3D), for other sites' servers syncing stats: those are most of a lookup's work here,
    and their files would push the players page's own drawings out of the folder."""
    response.headers["Cache-Control"] = "no-store"
    account_id = account_id.strip()
    if not _ACCOUNT_RE.match(account_id):
        raise HTTPException(status_code=422, detail="accountId must be digits")
    params = {"accountId": account_id, "mode": _mode(mode)}
    full = ("lookup", mode, account_id)
    if art:
        return _guarded(request, full, lambda: _profile(params, db))
    # a profile someone just looked up with its drawings holds everything a stats sync needs, so
    # it's served as is; a stats-only one is kept under its own name, so it never stands in for
    # the page's
    key = full if lookup_guard.cached(full) is not None else ("lookup-stats", mode, account_id)
    return _guarded(request, key, lambda: _profile(params, db, art=False))


def _profile(params: dict, db: Session, art: bool = True) -> dict:
    """One player's profile from the provider, with our art, drawings and builder payloads added.
    Without art, no Kitbash! drawing is made: every render and the character come back None."""
    body = _ask("/lookup", params)
    _learn(params["mode"], params["accountId"], body)
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
        slot["render"] = render(slot, item) if item and art else None
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
        node["render"] = render(node, items[node["tpl"]]) if art else None
        node["build"] = builder_payload(node, db)
    for m in mastering:
        m["weapon"] = mastering_weapon(m, items)
    if not art:
        body["character"] = None
        return body
    body["character"] = render_character(body)
    full3d = render_character3d(body, items)
    if full3d:
        body["character"] = {**(body["character"] or {}), "full3d": full3d}
    return body


@router.get("/atlas/api/players/{mode}/{name}")
def atlas_player_index(mode: str, name: str, request: Request):
    """Atlas' player index for key holders, in tarkov.dev's shape: index.json (account ID to
    nickname) or updated.json (account ID to when Atlas last saw it, Unix ms) for one mode. Needs
    a key with the lookup scope, and isn't cached anywhere on the way, so a revoked key stops at
    once. Built at most hourly (services/player_index.export)."""
    kind = name.removesuffix(".json")
    if not name.endswith(".json") or kind not in player_index.EXPORTS or mode not in LOOKUP_MODES:
        raise HTTPException(status_code=404, detail="Not found")
    if atlas.request_key(request) is None:
        raise HTTPException(
            status_code=401,
            detail="An Atlas key with the lookup scope is required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    path = player_index.export(mode, kind)
    return FileResponse(path, media_type="application/json", headers={"Cache-Control": "private, no-store"})


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


@router.get("/atlas/api/lookup-render")
def atlas_lookup_render_account(
    request: Request,
    account_id: str = Query(..., alias="accountId"),
    mode: str = "season",
    hand: str | None = None,
    pose: str = "default",
    db: Session = Depends(get_db),
):
    """A player's 3D full body straight from the account: looks the profile up (as /atlas/api/lookup
    does, the same allowance and minute's cache, an Atlas key the same way) and redirects to its
    picture, /atlas/api/lookup-render/<spec>/<hand>/<pose>. hand: a weapon slot the player carries
    (FirstPrimaryWeapon, SecondPrimaryWeapon, Holster, Scabbard) or none, the default weapon when
    left out; pose: default (the game's own hold) or a custom pose the profile's full3d.poses lists
    for that hand. The redirect isn't cached, since the player's gear changes; the picture is."""
    account_id = account_id.strip()
    if not _ACCOUNT_RE.match(account_id):
        raise HTTPException(status_code=422, detail="accountId must be digits")
    if hand is not None and hand != "none" and hand not in CHARACTER3D_WEAPON_SLOTS:
        raise HTTPException(
            status_code=422, detail=f"hand must be none or one of {', '.join(CHARACTER3D_WEAPON_SLOTS)}"
        )
    if not _POSE_RE.fullmatch(pose):
        raise HTTPException(status_code=422, detail="pose must be default or a pose id")
    params = {"accountId": account_id, "mode": _mode(mode)}
    body = _guarded(request, ("lookup", mode, account_id), lambda: _profile(params, db))
    full3d = (body.get("character") or {}).get("full3d")
    if not full3d:
        raise HTTPException(status_code=404, detail={"error": "no_render"})
    # build the address only from what the profile offers, never from the query itself, so a hand
    # the player doesn't carry or a pose not offered for it stops here instead of at the picture
    wanted = hand or full3d.get("hand") or "none"
    offers = full3d.get("poses") or {}
    held = next((h for h in offers if h == wanted), None)
    pose_id = next((p["id"] for p in offers.get(held) or () if p.get("id") == pose), None)
    if held is None or pose_id is None:
        raise HTTPException(status_code=404, detail={"error": "no_render"})
    url = f"{RENDER_URL}/{full3d['spec']}/{held}/{pose_id}"
    return RedirectResponse(url, status_code=302, headers={"Cache-Control": "no-store"})


@router.get("/atlas/api/lookup-render/{spec}/{hand}/{pose}")
def atlas_lookup_render(spec: str, hand: str, pose: str, request: Request):
    """The 3D full body of a spec render_character3d kept, holding the weapon in `hand` (a weapon
    slot, or none) in `pose` (default: the game's own hold, or a custom pose the spec's poses
    list for that hand). Drawn on first request, then kept with the drawings; the address names
    one picture, so it's cached for a year."""
    if not _ART_NAME_RE.fullmatch(spec) or not _POSE_RE.fullmatch(pose):
        raise HTTPException(status_code=404, detail="Not found")
    if hand != "none" and hand not in CHARACTER3D_WEAPON_SLOTS:
        raise HTTPException(status_code=404, detail="Not found")
    root = os.path.realpath(SPEC_DIR)
    path = os.path.realpath(os.path.join(root, spec + ".json"))
    if not path.startswith(root + os.sep) or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Not found")
    try:
        with open(path, encoding="utf-8") as f:
            job = json.load(f)
        categories = job.pop("categories", None) or {}
        held = None if hand == "none" else hand
        if held is not None and held not in job["loadout"]["weapons"]:
            raise HTTPException(status_code=404, detail="Not found")
        offered = build_images.character3d_poses(held, categories.get(held))
        if pose != "default" and pose not in {p["id"] for p in offered if p["id"]}:
            raise HTTPException(status_code=404, detail="Not found")
        job["loadout"]["hand"] = held
        job["pose"] = None if pose == "default" else pose
        name = hashlib.sha256(f"character3d:{build_images.character3d_key(job)}".encode()).hexdigest()[:32]
    except (OSError, ValueError, KeyError, TypeError):
        raise HTTPException(status_code=404, detail="Not found")
    art = os.path.join(ART_DIR, name + ".webp")
    if os.path.isfile(art):
        os.utime(art)
    else:
        # only a picture not drawn yet counts against the IP's render allowance
        lookup_guard.take_render(get_client_ip(request))
        try:
            _store_art(art, build_images.render_character3d_webp(job))
        except build_images.Unrenderable as exc:
            _logger.warning("atlas lookup: the render service couldn't draw a 3D full body: %s", exc)
            raise HTTPException(status_code=503, detail={"error": "render"}, headers={"Retry-After": "10"})
    return FileResponse(art, media_type="image/webp", headers={"Cache-Control": "public, max-age=31536000, immutable"})


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

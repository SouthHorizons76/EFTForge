"""Atlas player lookup: open to everyone but rate limited per IP (or per Atlas key), cached for a minute, off without
ATLAS_LOOKUP_URL, and only known error codes passed on from the upstream provider."""

import os
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response


@pytest.fixture
def lookup(monkeypatch, tmp_path):
    os.environ.setdefault("IP_HASH_SECRET", "atlas-test-secret")
    os.environ.setdefault("ADMIN_API_KEY", "atlas-test-admin")
    from routers import atlas_lookup
    from services import lookup_guard, player_index

    monkeypatch.setattr(atlas_lookup, "ATLAS_LOOKUP_URL", "http://127.0.0.1:8765")
    # an empty player index of its own, so a local dev copy never answers a test's search
    monkeypatch.setattr(player_index, "_DB_PATH", str(tmp_path / "player_index.sqlite3"))
    monkeypatch.setattr(player_index, "_schema_ready", False)
    monkeypatch.setattr(player_index, "EXPORT_DIR", str(tmp_path / "player_index_export"))
    lookup_guard.clear()
    yield atlas_lookup
    lookup_guard.clear()


def _req(ip="203.0.113.5"):
    """Just enough of a Request for get_client_ip."""
    return SimpleNamespace(client=SimpleNamespace(host=ip), headers={})


class _DB:
    """Just enough of a Session for the item query."""

    def __init__(self, icons):
        self.icons = icons

    def query(self, *_):
        return self

    def filter(self, *_):
        return [
            SimpleNamespace(
                id=k,
                icon_link=v,
                base_image_link=None,
                image_512_link=f"{k}-512.webp",
                background_color="black",
                is_weapon=k in ("gun", "m4a1"),
                armor_kind=None,
                name=f"{k} name",
                short_name=k.upper(),
                name_zh=None,
                short_name_zh=None,
            )
            for k, v in self.icons.items()
        ]


BODY = {
    "nickname": "Target",
    "slots": [
        {
            "slot": "FirstPrimaryWeapon",
            "tpl": "gun",
            "children": [
                {"slot": "mod_magazine", "tpl": "mag", "children": [], "ammo": [{"tpl": "ammo", "count": 30}]}
            ],
        }
    ],
}


def test_icons_are_added_to_every_item_and_ammo(lookup, monkeypatch):
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: (200, BODY))
    monkeypatch.setattr(lookup, "render", lambda node, item: "data:image/webp;base64,x")
    monkeypatch.setattr(lookup, "builder_payload", lambda node, db: {"payload": {"g": node["tpl"]}, "complete": True})
    out = lookup.atlas_lookup(_req(), Response(), "1000002", _DB({"gun": "g.webp", "ammo": "a.webp"}))
    gun = out["slots"][0]
    assert (gun["icon"], gun["image"], gun["bg"]) == ("g.webp", "gun-512.webp", "black")
    assert gun["render"] == "data:image/webp;base64,x"
    assert gun["build"] == {"payload": {"g": "gun"}, "complete": True}
    assert gun["children"][0]["icon"] is None
    assert gun["children"][0]["ammo"][0]["icon"] == "a.webp"


def test_favorites_get_art_and_weapons_their_build(lookup, monkeypatch):
    tag = {"tpl": "tag", "children": [], "dogtag": {"nickname": "Victim"}}
    gun = {"tpl": "gun", "children": [{"slot": "mod_scope", "tpl": "scope", "children": []}]}
    body = {"slots": [], "favorites": [tag, gun]}
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: (200, body))
    monkeypatch.setattr(lookup, "render", lambda node, item: f"drawn:{node['tpl']}")
    monkeypatch.setattr(lookup, "builder_payload", lambda node, db: {"payload": {"g": node["tpl"]}, "complete": True})
    out = lookup.atlas_lookup(_req(), Response(), "1000002", _DB({"tag": "t.webp", "gun": "g.webp", "scope": "s.webp"}))
    tag, gun = out["favorites"]
    assert tag["icon"] == "t.webp" and "render" not in tag and "build" not in tag
    assert (gun["render"], gun["build"]["payload"]) == ("drawn:gun", {"g": "gun"})
    assert gun["children"][0]["icon"] == "s.webp"


def test_mastering_gets_its_first_known_weapon(lookup, monkeypatch):
    skills = {
        "common": [],
        "mastering": [
            {"id": "M4", "progress": 1925, "kills": 3, "templates": ["unknown", "m4a1"]},
            {"id": "Gone", "progress": 1, "kills": 0, "templates": ["unknown"]},
        ],
    }
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: (200, {"slots": [], "skills": skills}))
    out = lookup.atlas_lookup(_req(), Response(), "1000002", _DB({"m4a1": "m4.webp"}))
    m4, gone = out["skills"]["mastering"]
    assert m4["weapon"] == {
        "tpl": "m4a1",
        "icon": "m4.webp",
        "en": {"name": "m4a1 name", "short": "M4A1"},
        "ch": {"name": "", "short": ""},
    }
    assert gone["weapon"] is None


def test_build_items_is_a_tree_kitbash_accepts(lookup):
    from build_images import build_image_key

    gun = {
        "tpl": "5" * 24,
        "children": [
            {"slot": "mod_reciever", "tpl": "a" * 24, "children": [{"slot": "mod_scope", "tpl": "b" * 24}]},
            {"slot": "mod_magazine", "tpl": "c" * 24, "children": [], "ammo": [{"tpl": "d" * 24}]},
            {"slot": "patron_in_weapon", "tpl": "d" * 24, "children": []},
        ],
    }
    items = lookup.build_items(gun)
    assert [i["slotId"] for i in items] == ["hideout", "mod_reciever", "mod_magazine", "mod_scope"]
    build_image_key("5" * 24, items)  # raises on anything Kitbash! wouldn't take
    assert lookup._first_ammo(gun) == "d" * 24


def test_off_without_service_url(lookup, monkeypatch):
    monkeypatch.setattr(lookup, "ATLAS_LOOKUP_URL", "")
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup(_req(), Response(), "1", _DB({}))
    assert e.value.status_code == 503
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup_search(_req(), Response(), "Target_X")
    assert e.value.status_code == 503


def test_search_is_forwarded(lookup, monkeypatch):
    sent = []
    found = {"nickname": "target_x", "players": [{"accountId": "1000001", "nickname": "Target_X"}]}
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: sent.append((path, params)) or (200, found))
    assert lookup.atlas_lookup_search(_req(), Response(), " target_x ") == {**found, "source": "live"}
    assert sent == [("/search", {"nickname": "target_x", "mode": "season"})]


def test_bad_input_never_reaches_upstream(lookup, monkeypatch):
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: pytest.fail("sent"))
    for bad in ("abc", "1/../x", "1" * 13):
        with pytest.raises(HTTPException) as e:
            lookup.atlas_lookup(_req(), Response(), bad, _DB({}))
        assert e.value.status_code == 422
    for bad in ("ab", "a" * 16, "a b", "a&x=1"):
        with pytest.raises(HTTPException) as e:
            lookup.atlas_lookup_search(_req(), Response(), bad)
        assert e.value.status_code == 422


def test_upstream_errors_keep_their_status_and_code(lookup, monkeypatch):
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: (503, {"error": "session", "message": "lost"}))
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup(_req(), Response(), "1", _DB({}))
    assert e.value.status_code == 503
    assert e.value.detail == {"error": "session"}  # the message stays in the log


def test_unknown_errors_and_unreachable_reasons_stay_private(lookup, monkeypatch):
    monkeypatch.setattr(
        lookup,
        "fetch_upstream",
        lambda path, params: (502, {"error": "unreachable", "message": "no answer (10.0.0.9)"}),
    )
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup_search(_req(), Response(), "Target_X")
    assert (e.value.status_code, e.value.detail) == (502, {"error": "lookup"})


def test_routes_need_no_admin_key(lookup):
    from routers.shared import require_admin

    for route in lookup.router.routes:
        assert not any(d.dependency is require_admin for d in route.dependencies), route.path


def test_each_ip_is_rate_limited_on_its_own(lookup, monkeypatch):
    from services import lookup_guard

    monkeypatch.setattr(lookup_guard, "IP_WINDOWS", ((60, 3),))
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: (200, {"players": []}))
    for name in ("aaa", "bbb", "ccc"):
        lookup.atlas_lookup_search(_req(), Response(), name)
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup_search(_req(), Response(), "ddd")
    assert e.value.status_code == 429
    assert e.value.detail["error"] == "rate"
    assert 1 <= int(e.value.headers["Retry-After"]) <= 61
    # another IP has its own allowance, and there's no total for the server
    lookup.atlas_lookup_search(_req("198.51.100.7"), Response(), "ddd")


def test_a_repeat_comes_from_cache_and_costs_nothing(lookup, monkeypatch):
    from services import lookup_guard

    monkeypatch.setattr(lookup_guard, "IP_WINDOWS", ((60, 1),))
    sent = []
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: sent.append(path) or (200, {"players": []}))
    first = lookup.atlas_lookup_search(_req(), Response(), "Target_X")
    again = lookup.atlas_lookup_search(_req(), Response(), "target_x")
    assert sent == ["/search"]
    # marked as cached for the page, without marking the kept answer itself
    assert "cached" not in first and again == {**first, "cached": True}
    assert "cached" not in lookup_guard.cached(("search", "season", "target_x"))


def test_busy_when_every_slot_is_taken(lookup, monkeypatch):
    import threading

    from services import lookup_guard

    monkeypatch.setattr(lookup_guard, "_IN_FLIGHT", threading.BoundedSemaphore(1))
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: (200, {"players": []}))
    with lookup_guard.in_flight():
        with pytest.raises(HTTPException) as e:
            lookup.atlas_lookup_search(_req(), Response(), "Target_X")
    assert (e.value.status_code, e.value.detail) == (429, {"error": "busy"})
    lookup.atlas_lookup_search(_req(), Response(), "Target_X")  # the slot is free again


def test_busy_costs_none_of_the_allowance(lookup, monkeypatch):
    import threading

    from services import lookup_guard

    monkeypatch.setattr(lookup_guard, "IP_WINDOWS", ((60, 1),))
    monkeypatch.setattr(lookup_guard, "_IN_FLIGHT", threading.BoundedSemaphore(1))
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: (200, {"players": []}))
    with lookup_guard.in_flight():
        with pytest.raises(HTTPException):
            lookup.atlas_lookup_search(_req(), Response(), "Target_X")
    lookup.atlas_lookup_search(_req(), Response(), "Target_X")  # the one allowed lookup is still there


@pytest.fixture
def atlas_key(monkeypatch, tmp_path):
    """A live Atlas key in a throwaway key file: (key, its id)."""
    from routers import atlas

    monkeypatch.setattr(atlas, "ATLAS_KEYS_FILE", str(tmp_path / "keys.json"))
    atlas._failures.clear()
    made = atlas.admin_create_atlas_key(name="qq bot", expires_days=None)
    yield made["key"], made["id"]
    atlas._failures.clear()


def _keyed(key, ip="203.0.113.5", bearer=False):
    headers = {"authorization": f"Bearer {key}"} if bearer else {"x-atlas-key": key}
    return SimpleNamespace(client=SimpleNamespace(host=ip), headers=headers)


def test_a_key_has_its_own_allowance_instead_of_its_ips(lookup, monkeypatch, atlas_key):
    from services import lookup_guard

    key, _ = atlas_key
    monkeypatch.setattr(lookup_guard, "IP_WINDOWS", ((60, 1),))
    monkeypatch.setattr(lookup_guard, "KEY_WINDOWS", ((60, 3),))
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: (200, {"players": []}))
    # the bot's IP used up its public allowance; its key still has its own
    lookup.atlas_lookup_search(_req(), Response(), "aaa")
    for name, bearer in (("bbb", False), ("ccc", True), ("ddd", False)):
        lookup.atlas_lookup_search(_keyed(key, bearer=bearer), Response(), name)
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup_search(_keyed(key), Response(), "eee")
    assert (e.value.status_code, e.value.detail["error"]) == (429, "rate")
    # and a key's lookups never touched the IP's allowance either way
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup_search(_req(), Response(), "fff")
    assert e.value.detail["error"] == "rate"


def test_a_wrong_or_revoked_key_is_refused_even_for_a_cached_answer(lookup, monkeypatch, atlas_key):
    from routers import atlas

    key, key_id = atlas_key
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: (200, {"players": []}))
    lookup.atlas_lookup_search(_req(), Response(), "Target_X")  # now cached
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup_search(_keyed("atl_wrong"), Response(), "Target_X")
    assert e.value.status_code == 403
    lookup.atlas_lookup_search(_keyed(key), Response(), "Target_X")
    atlas.admin_revoke_atlas_key(key_id)
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup_search(_keyed(key), Response(), "Target_X")
    assert e.value.status_code == 403


def test_keyed_lookups_only_hold_their_share_of_the_slots(lookup, monkeypatch, atlas_key):
    import threading

    from services import lookup_guard

    key, _ = atlas_key
    monkeypatch.setattr(lookup_guard, "_IN_FLIGHT", threading.BoundedSemaphore(2))
    monkeypatch.setattr(lookup_guard, "_KEY_IN_FLIGHT", threading.BoundedSemaphore(1))
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: (200, {"players": []}))
    with lookup_guard.in_flight(keyed=True):
        with pytest.raises(HTTPException) as e:
            lookup.atlas_lookup_search(_keyed(key), Response(), "Target_X")
        assert (e.value.status_code, e.value.detail) == (429, {"error": "busy"})
        # the page's visitors still get the other slot
        lookup.atlas_lookup_search(_req(), Response(), "Target_X")
    # a keyed lookup turned away for want of a shared slot gives its key slot back
    with lookup_guard.in_flight(), lookup_guard.in_flight():
        with pytest.raises(HTTPException):
            lookup.atlas_lookup_search(_keyed(key), Response(), "Other_Y")
    lookup.atlas_lookup_search(_keyed(key), Response(), "Other_Y")


def test_the_provider_pacing_is_busy_not_the_askers_rate_limit(lookup, monkeypatch):
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: (429, {"error": "rate", "message": "paced"}))
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup_search(_req(), Response(), "Target_X")
    assert (e.value.status_code, e.value.detail) == (429, {"error": "busy"})


class _SlotDB:
    """Slots per parent template, for builder_payload's queries."""

    def __init__(self, slots):
        self.slots = slots  # {parent tpl: {game name: (slot id, slot name)}}
        self.parent = None

    def query(self, *_):
        return self

    def filter(self, condition, *_):
        self.parent = condition.right.value
        return [
            SimpleNamespace(id=sid, slot_name=name, slot_game_name=game)
            for game, (sid, name) in self.slots.get(self.parent, {}).items()
        ]


def test_builder_payload_maps_game_slots_to_ours(lookup):
    gun = {
        "tpl": "gun",
        "children": [
            {"slot": "mod_reciever", "tpl": "rec", "children": [{"slot": "mod_scope", "tpl": "scope", "children": []}]},
            {"slot": "mod_magazine", "tpl": "mag", "children": [], "ammo": [{"tpl": "ps"}]},
            {"slot": "mod_unknown", "tpl": "odd", "children": []},
            {"slot": "patron_in_weapon", "tpl": "ps", "children": []},
        ],
    }
    db = _SlotDB(
        {
            "gun": {"mod_reciever": ("s-rec", "Receiver"), "mod_magazine": ("s-mag", "Magazine")},
            "rec": {"mod_scope": ("s-scope", "Scope")},
        }
    )
    out = lookup.builder_payload(gun, db)
    assert out["payload"] == {
        "v": 1,
        "g": "gun",
        "p": [["s-rec", "rec"], ["s-mag", "mag"], ["s-scope", "scope"]],
        "a": "ps",
    }
    assert out["complete"] is False  # mod_unknown isn't in tarkov.db
    assert gun["children"][0]["slot_name"] == "Receiver"
    assert gun["children"][0]["slot_id"] == "s-rec"
    assert gun["children"][0]["children"][0]["slot_name"] == "Scope"


def test_the_mode_goes_upstream_and_unknown_modes_are_refused(lookup, monkeypatch):
    sent = []
    monkeypatch.setattr(
        lookup, "fetch_upstream", lambda path, params: (sent.append((path, params)) or (200, {"players": []}))
    )
    lookup.atlas_lookup_search(_req(), Response(), "Target_X")
    lookup.atlas_lookup_search(_req(), Response(), "Target_X", "arena")
    assert [params["mode"] for _, params in sent] == ["season", "arena"]
    for bad in ("", "eft", "PVP", "season&x=1"):
        with pytest.raises(HTTPException) as e:
            lookup.atlas_lookup_search(_req(), Response(), "Target_X", bad)
        assert e.value.status_code == 422
    assert len(sent) == 2


def test_an_ipv6_block_shares_one_allowance(lookup):
    from services import lookup_guard

    one = lookup_guard._who("2001:db8:1:2::1")
    assert lookup_guard._who("2001:db8:1:2:ffff::9") == one
    assert lookup_guard._who("2001:db8:1:3::1") != one
    assert lookup_guard._who("::ffff:203.0.113.5") == lookup_guard._who("203.0.113.5")
    assert lookup_guard._who("203.0.113.5") != lookup_guard._who("203.0.113.6")


def test_the_cache_stays_within_its_size(lookup, monkeypatch):
    from services import lookup_guard

    monkeypatch.setattr(lookup_guard, "CACHE_BYTES", 400)
    body = {"x": "a" * 80}  # about 90 bytes as JSON
    for n in range(10):
        lookup_guard.remember(("k", n), body)
    assert lookup_guard._cache_size <= 400
    assert lookup_guard.cached(("k", 9)) is body and lookup_guard.cached(("k", 0)) is None
    lookup_guard.remember(("big",), {"x": "a" * 200})  # over a quarter: not kept
    assert lookup_guard.cached(("big",)) is None


def test_the_client_ip_is_the_last_forwarded_entry():
    from routers.shared import get_client_ip

    def req(direct, **headers):
        return SimpleNamespace(client=SimpleNamespace(host=direct), headers=headers)

    # the CDN appends the address it saw after whatever the client wrote
    assert get_client_ip(req("127.0.0.1", **{"X-Forwarded-For": "1.2.3.4, 198.51.100.7"})) == "198.51.100.7"
    assert get_client_ip(req("127.0.0.1", **{"X-Forwarded-For": "198.51.100.7"})) == "198.51.100.7"
    assert get_client_ip(req("127.0.0.1", **{"X-Real-IP": "1.2.3.4,198.51.100.7"})) == "198.51.100.7"
    # an untrusted peer's headers count for nothing
    assert get_client_ip(req("203.0.113.9", **{"X-Forwarded-For": "1.2.3.4"})) == "203.0.113.9"
    assert get_client_ip(req("127.0.0.1")) == "127.0.0.1"


def test_a_drawing_is_kept_once_and_served_by_its_hash(lookup, monkeypatch, tmp_path):
    from routers import images

    drawn = []
    monkeypatch.setattr(lookup, "ART_DIR", str(tmp_path))
    monkeypatch.setattr(images, "_imggen_disabled", False)
    monkeypatch.setattr(lookup.build_images, "available", lambda: True)
    monkeypatch.setattr(
        lookup.build_images, "render_webp", lambda key, items, ammo, ubgl: drawn.append(key) or (b"RIFF-webp", [])
    )
    gun = {"tpl": "5" * 24, "children": [{"slot": "mod_reciever", "tpl": "a" * 24, "children": []}]}
    item = SimpleNamespace(is_weapon=True, armor_kind=None)
    url = lookup.render(gun, item)
    assert url.startswith("/atlas/api/lookup-art/") and len(url.rsplit("/", 1)[1]) == 32
    # the same build again is the same address, and isn't drawn twice
    assert lookup.render(gun, item) == url and len(drawn) == 1
    res = lookup.atlas_lookup_art(url.rsplit("/", 1)[1])
    assert res.media_type == "image/webp" and "immutable" in res.headers["Cache-Control"]
    for bad in ("../x", "A" * 32, "0" * 31, "f" * 32, url.rsplit("/", 1)[1] + "\n"):
        with pytest.raises(HTTPException) as e:
            lookup.atlas_lookup_art(bad)
        assert e.value.status_code == 404


def test_old_drawings_are_pruned_past_the_cap(lookup, monkeypatch, tmp_path):
    monkeypatch.setattr(lookup, "ART_DIR", str(tmp_path))
    monkeypatch.setattr(lookup, "ART_DIR_BYTES", 1000)
    for n in range(5):
        path = tmp_path / f"{n:032x}.webp"
        path.write_bytes(b"x" * 300)
        os.utime(path, (1000 + n, 1000 + n))
    lookup.prune_art()
    left = sorted(p.name for p in tmp_path.iterdir())
    assert sum(p.stat().st_size for p in tmp_path.iterdir()) <= 800
    assert left == [f"{n:032x}.webp" for n in (3, 4)]  # the least recently used went first


HELMET = "5aa7e276e5b5b000171d0647"
VISOR = "5aa7e373e5b5b000137b76f0"
CUSTOMIZATION = {
    "head": "62aca6a1310e67685a2fc2e7",
    "body": "6a7207abacdd524b380351b6",
    "feet": "67ab1556508ee9b6440e9c62",
    "hands": "6a7207dfb5fc03f68109f9b5",
}
DRESSED = {
    "customization": CUSTOMIZATION,
    "slots": [
        {"slot": "FirstPrimaryWeapon", "tpl": "5" * 24, "children": []},
        {
            "slot": "Headwear",
            "tpl": HELMET,
            "children": [{"slot": "mod_equipment", "tpl": VISOR, "on": True, "children": []}],
        },
        {"slot": "TacticalVest", "tpl": "544a5caa4bdc2d1a388b4568", "children": []},
        {"slot": "Eyewear", "tpl": "62a61c988ec41a51b34758d5", "children": []},
    ],
}


def test_character_items_dress_only_worn_gear_with_its_switches(lookup):
    items = lookup.character_items(DRESSED["slots"])
    assert [(i["slotId"], i["_tpl"]) for i in items] == [
        ("Headwear", HELMET),
        ("TacticalVest", "544a5caa4bdc2d1a388b4568"),
        ("Eyewear", "62a61c988ec41a51b34758d5"),
        ("mod_equipment", VISOR),
    ]
    helmet, visor = items[0], items[3]
    assert helmet["parentId"] == lookup.CHARACTER_ROOT and "upd" not in helmet
    assert visor["parentId"] == helmet["_id"] and visor["upd"] == {"Togglable": {"On": True}}
    # the same gear always gets the same ids, so the same character keeps one address
    assert lookup.character_items(DRESSED["slots"]) == items


def test_only_the_full_body_holds_a_gun_the_primary_first(lookup, monkeypatch, tmp_path):
    pistol = {"slot": "Holster", "tpl": "6" * 24, "children": []}
    rifle = {
        "slot": "SecondPrimaryWeapon",
        "tpl": "7" * 24,
        "children": [{"slot": "mod_magazine", "tpl": "8" * 24, "children": []}],
    }
    held = lookup.character_items([pistol, rifle, *DRESSED["slots"]], gun=True)
    guns = [(i["slotId"], i["_tpl"]) for i in held if i["slotId"] in lookup.CHARACTER_GUN_SLOTS]
    assert guns == [("FirstPrimaryWeapon", "5" * 24)]
    # no primary: the secondary, with what is on it; no long gun: the pistol
    held = lookup.character_items([pistol, rifle], gun=True)
    assert [(i["slotId"], i["_tpl"]) for i in held] == [("SecondPrimaryWeapon", "7" * 24), ("mod_magazine", "8" * 24)]
    assert [i["slotId"] for i in lookup.character_items([pistol], gun=True)] == ["Holster"]

    from routers import images

    seen = {}
    monkeypatch.setattr(lookup, "ART_DIR", str(tmp_path))
    monkeypatch.setattr(images, "_imggen_disabled", False)
    monkeypatch.setattr(lookup.build_images, "available", lambda: True)
    monkeypatch.setattr(lookup.build_images, "character_key", lambda view, c, items: f"k-{view}-{len(items)}")
    monkeypatch.setattr(
        lookup.build_images,
        "render_character_webp",
        lambda view, c, items: seen.__setitem__(view, [i["slotId"] for i in items]) or b"RIFF-webp",
    )
    lookup.render_character(DRESSED)
    assert "FirstPrimaryWeapon" in seen["full"] and "FirstPrimaryWeapon" not in seen["headshot"]


def test_a_character_is_drawn_once_per_view_and_kept(lookup, monkeypatch, tmp_path):
    from routers import images

    drawn = []
    monkeypatch.setattr(lookup, "ART_DIR", str(tmp_path))
    monkeypatch.setattr(images, "_imggen_disabled", False)
    monkeypatch.setattr(lookup.build_images, "available", lambda: True)
    # no feet sprites, say: the full body can't be drawn, the headshot can
    monkeypatch.setattr(
        lookup.build_images, "character_key", lambda view, c, items: f"k-{view}" if view == "headshot" else None
    )
    monkeypatch.setattr(
        lookup.build_images, "render_character_webp", lambda view, c, items: drawn.append(view) or b"RIFF-webp"
    )
    out = lookup.render_character(DRESSED)
    assert out["full"] is None and out["headshot"].startswith("/atlas/api/lookup-art/")
    assert lookup.render_character(DRESSED) == out and drawn == ["headshot"]
    assert lookup.atlas_lookup_art(out["headshot"].rsplit("/", 1)[1]).media_type == "image/webp"
    # nothing to dress, or neither view drawable: no character at all
    assert lookup.render_character({"slots": []}) is None
    monkeypatch.setattr(lookup.build_images, "character_key", lambda view, c, items: None)
    assert lookup.render_character(DRESSED) is None


def test_kitbash_draws_a_real_character(lookup, monkeypatch, tmp_path):
    import build_images
    from routers import images

    if not os.path.isfile(os.path.join(build_images.KITBASH_DIR, "data", "character-full.manifest.json")):
        pytest.skip("no Kitbash! character sprites here")
    monkeypatch.setattr(lookup, "ART_DIR", str(tmp_path))
    monkeypatch.setattr(images, "_imggen_disabled", False)
    out = lookup.render_character(DRESSED)
    from PIL import Image

    sizes = {view: Image.open(tmp_path / (url.rsplit("/", 1)[1] + ".webp")).size for view, url in out.items()}
    headshot = build_images.CHARACTER_SIZES["headshot"]
    assert sizes == {"headshot": (headshot, headshot), "full": (788, 1238)}
    # a suit Kitbash! has no sprites for draws nothing rather than a headless player
    assert lookup.render_character({**DRESSED, "customization": {**CUSTOMIZATION, "head": "f" * 24}}) is None


def _fake_provider(profiles, searches, sent):
    def fetch(path, params):
        sent.append(path)
        if path == "/lookup":
            body = profiles.get(params["accountId"])
            return (200, body) if body else (404, {"error": "no_profile", "message": "none"})
        return 200, {"players": searches.get(params["nickname"].lower(), [])}

    return fetch


def test_an_account_the_search_leaves_out_is_possibly_banned(lookup, monkeypatch):
    sent = []
    profiles = {"11457551": {"nickname": "XIAOGUAI6666"}, "6172844": {"nickname": "M0rph1ne"}}
    searches = {"m0rph1ne": [{"accountId": "14255820"}, {"accountId": "6172844"}]}
    monkeypatch.setattr(lookup, "fetch_upstream", _fake_provider(profiles, searches, sent))
    banned = lookup.atlas_lookup_banned(_req(), Response(), "11457551", "pvp")
    assert (banned["status"], banned["nickname"], banned["mode"]) == ("possibly_banned", "XIAOGUAI6666", "pvp")
    clear = lookup.atlas_lookup_banned(_req(), Response(), "6172844", "pvp")
    # matched by account ID, whatever else the search turned up
    assert clear["status"] == "no_sign_of_ban" and clear["reason"] is None
    assert sent == ["/lookup", "/search", "/lookup", "/search"]


def test_a_name_the_game_wont_search_is_unknown_not_banned(lookup, monkeypatch):
    sent = []
    profiles = {"1": {"nickname": "TarkovCitizen12"}, "2": {"nickname": "a_name_far_too_long"}}
    monkeypatch.setattr(lookup, "fetch_upstream", _fake_provider(profiles, {}, sent))
    for account in ("1", "2"):
        guess = lookup.atlas_lookup_banned(_req(), Response(), account, "pvp")
        assert (guess["status"], guess["reason"]) == ("unknown", "unsearchable_name")
    assert "/search" not in sent  # never searched, so never a false "possibly banned"


def test_the_check_reuses_a_profile_and_search_just_looked_up(lookup, monkeypatch):
    sent = []
    profiles = {"6172844": {"nickname": "M0rph1ne", "slots": []}}
    searches = {"m0rph1ne": [{"accountId": "6172844"}]}
    monkeypatch.setattr(lookup, "fetch_upstream", _fake_provider(profiles, searches, sent))
    monkeypatch.setattr(lookup, "render_character", lambda body: None, raising=False)
    lookup.atlas_lookup(_req(), Response(), "6172844", _DB({}), "pvp")
    # a live search: one answered from the player index leaves none behind for the check
    lookup.atlas_lookup_search(_req(), Response(), "M0rph1ne", "pvp", live=True)
    sent.clear()
    assert lookup.atlas_lookup_banned(_req(), Response(), "6172844", "pvp")["status"] == "no_sign_of_ban"
    assert sent == []


def test_the_ban_check_passes_on_a_missing_profile_and_bad_input(lookup, monkeypatch):
    monkeypatch.setattr(lookup, "fetch_upstream", _fake_provider({}, {}, []))
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup_banned(_req(), Response(), "99", "pvp")
    assert (e.value.status_code, e.value.detail) == (404, {"error": "no_profile"})
    for account, mode in (("abc", "pvp"), ("1", "nope")):
        with pytest.raises(HTTPException) as e:
            lookup.atlas_lookup_banned(_req(), Response(), account, mode)
        assert e.value.status_code == 422


FULL3D = {
    "spec": "a" * 32,
    "hand": "Holster",
    "weapons": [{"slot": "Holster", "tpl": "p"}],
    "poses": {"Holster": [{"id": "default"}], "none": [{"id": "default"}, {"id": "cp_empty_knuckle"}]},
    "url": "",
}


def test_render_by_account_redirects_to_the_picture(lookup, monkeypatch):
    monkeypatch.setattr(lookup, "_guarded", lambda request, key, work: {"character": {"full3d": FULL3D}})
    r = lookup.atlas_lookup_render_account(_req(), account_id="123", mode="season", hand=None, pose="default", db=None)
    assert r.status_code == 302
    assert r.headers["location"] == f"/atlas/api/lookup-render/{'a' * 32}/Holster/default"
    assert r.headers["cache-control"] == "no-store"
    r = lookup.atlas_lookup_render_account(
        _req(), account_id="123", mode="pvp", hand="none", pose="cp_empty_knuckle", db=None
    )
    assert r.headers["location"].endswith("/none/cp_empty_knuckle")
    # a weapon the player doesn't carry, or a pose not offered for the hand, ends here
    for hand, pose in (("FirstPrimaryWeapon", "default"), ("Holster", "cp_empty_knuckle"), (None, "cp_nope")):
        with pytest.raises(HTTPException) as e:
            lookup.atlas_lookup_render_account(_req(), account_id="123", mode="pvp", hand=hand, pose=pose, db=None)
        assert (e.value.status_code, e.value.detail) == (404, {"error": "no_render"})


def test_render_by_account_refuses_bad_input_and_profiles_without_one(lookup, monkeypatch):
    monkeypatch.setattr(lookup, "_guarded", lambda request, key, work: {"character": None})
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup_render_account(
            _req(), account_id="123", mode="season", hand="Pocket", pose="default", db=None
        )
    assert e.value.status_code == 422
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup_render_account(_req(), account_id="12a", mode="season", hand=None, pose="default", db=None)
    assert e.value.status_code == 422
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup_render_account(_req(), account_id="123", mode="season", hand=None, pose="default", db=None)
    assert e.value.status_code == 404


def test_a_stats_only_lookup_draws_nothing(lookup, monkeypatch):
    import copy

    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: (200, copy.deepcopy(BODY)))
    drawn = []
    monkeypatch.setattr(lookup, "render", lambda node, item: drawn.append("gear") or "x")
    monkeypatch.setattr(lookup, "render_character", lambda body: drawn.append("character") or {"full": "y"})
    monkeypatch.setattr(lookup, "render_character3d", lambda body, items=None: drawn.append("3d") or {"spec": "z"})
    monkeypatch.setattr(lookup, "builder_payload", lambda node, db: {"payload": {"g": node["tpl"]}, "complete": True})
    out = lookup.atlas_lookup(_req(), Response(), "1000002", _DB({"gun": "g.webp"}), "arena", art=False)
    assert drawn == []
    gun = out["slots"][0]
    assert gun["render"] is None and out["character"] is None
    # the cheap extras stay: icons and the builder payload
    assert gun["icon"] == "g.webp" and gun["build"]["payload"] == {"g": "gun"}
    # and it never stands in for the page's lookup, which still gets its drawings
    full = lookup.atlas_lookup(_req(), Response(), "1000002", _DB({"gun": "g.webp"}), "arena")
    assert full["slots"][0]["render"] == "x" and full["character"] == {"full": "y", "full3d": {"spec": "z"}}
    assert "cached" not in full


def test_a_stats_only_lookup_reuses_a_full_one(lookup, monkeypatch):
    import copy

    sent = []
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: sent.append(path) or (200, copy.deepcopy(BODY)))
    monkeypatch.setattr(lookup, "render", lambda node, item: "x")
    monkeypatch.setattr(lookup, "render_character", lambda body: None)
    monkeypatch.setattr(lookup, "render_character3d", lambda body, items=None: None)
    monkeypatch.setattr(lookup, "builder_payload", lambda node, db: {"payload": {}, "complete": True})
    lookup.atlas_lookup(_req(), Response(), "1000002", _DB({"gun": "g.webp"}), "arena")
    again = lookup.atlas_lookup(_req(), Response(), "1000002", _DB({"gun": "g.webp"}), "arena", art=False)
    assert sent == ["/lookup"] and again["cached"] is True


def test_a_name_the_index_knows_skips_the_game(lookup, monkeypatch):
    from services import lookup_guard, player_index

    player_index.seed("arena", [("6172844", "M0rph1ne"), ("14255820", "m0Rph1ne_"), ("abc", "bad"), ("1", "")])
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: pytest.fail("asked the game"))
    monkeypatch.setattr(lookup_guard, "IP_WINDOWS", ((60, 0),))  # no allowance left at all
    out = lookup.atlas_lookup_search(_req(), Response(), "m0rph1ne", "arena")
    assert out == {
        "nickname": "m0rph1ne",
        "mode": "arena",
        "players": [{"accountId": "6172844", "nickname": "M0rph1ne"}],
        "source": "index",
    }
    # each mode has its own index, and rows that aren't an ID with a name were left out
    assert player_index.find("season", "M0rph1ne") == []
    assert player_index.find("arena", "bad") == []


def test_live_asks_the_game_and_learns_what_it_lists(lookup, monkeypatch):
    from services import player_index

    player_index.seed("arena", [("6172844", "M0rph1ne")])
    sent = []
    found = {"players": [{"accountId": "999", "nickname": "M0rph1ne"}, {"accountId": "5", "nickname": "Other_One"}]}
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: sent.append(path) or (200, found))
    out = lookup.atlas_lookup_search(_req(), Response(), "M0rph1ne", "arena", live=True)
    assert out["source"] == "live" and sent == ["/search"]
    # the name now belongs to the account the game listed it under, and the other one is learned too
    assert player_index.find("arena", "m0rph1ne") == [{"accountId": "999", "nickname": "M0rph1ne"}]
    assert player_index.find("arena", "other_one") == [{"accountId": "5", "nickname": "Other_One"}]


def test_a_profile_lookup_teaches_the_index_a_rename(lookup, monkeypatch):
    import copy

    from services import player_index

    player_index.seed("pvp", [("1000002", "Old_Name")])
    monkeypatch.setattr(
        lookup, "fetch_upstream", lambda path, params: (200, {**copy.deepcopy(BODY), "nickname": "New_Name"})
    )
    monkeypatch.setattr(lookup, "builder_payload", lambda node, db: {"payload": {}, "complete": True})
    lookup.atlas_lookup(_req(), Response(), "1000002", _DB({"gun": "g.webp"}), "pvp", art=False)
    assert player_index.find("pvp", "old_name") == []
    assert player_index.find("pvp", "new_name") == [{"accountId": "1000002", "nickname": "New_Name"}]


def test_seeding_never_overrides_what_atlas_learned(lookup):
    from services import player_index

    player_index.record("pve", [("1", "Mine_Now")])
    added = player_index.seed("pve", [("1", "Old_Name"), ("2", "Mine_Now"), ("3", "Fresh_One")])
    # account 1 keeps the name Atlas saw; the seeded copy of its name on account 2 isn't added
    assert added == 1
    assert player_index.find("pve", "mine_now") == [{"accountId": "1", "nickname": "Mine_Now"}]
    assert player_index.find("pve", "old_name") == []
    assert player_index.was_seeded("pve") and not player_index.was_seeded("arena")


def test_a_stale_mode_keeps_only_recently_refreshed_accounts(lookup, monkeypatch):
    import time

    from services import player_index

    now = time.time() * 1000
    files = {
        "updated": [("1", now - 10 * 86400000), ("2", now - 400 * 86400000), ("3", now)],
        "index": [("1", "Active_One"), ("2", "Long_Gone"), ("3", "Just_Seen"), ("4", "No_Date")],
    }
    monkeypatch.setattr(player_index, "_stream", lambda mode, name: iter(files[name]))
    monkeypatch.setitem(player_index.SEED_MAX_AGE_DAYS, "pvp", 180)
    assert player_index.reseed("pvp") == 2
    assert [p["accountId"] for p in player_index.find("pvp", "active_one")] == ["1"]
    assert player_index.find("pvp", "long_gone") == [] and player_index.find("pvp", "no_date") == []
    # a mode without an age limit keeps every account
    assert player_index.reseed("pve") == 4


def test_the_index_files_are_read_a_chunk_at_a_time():
    from services import player_index

    data = '{"612":"M1CH","1000":"Poo\\"Man","1265":1792452788137,"7":"Naïve"}'.encode()
    expected = [("612", "M1CH"), ("1000", 'Poo"Man'), ("1265", 1792452788137), ("7", "Naïve")]
    for size in (1, 2, 5, 1000):
        chunks = [data[i:][:size] for i in range(0, len(data), size)]
        assert list(player_index.parse_entries(chunks)) == expected


def test_key_holders_get_the_index_in_tarkov_devs_shape(lookup, atlas_key):
    import json

    from services import player_index

    key, _ = atlas_key
    player_index.seed("arena", [("6172844", "M0rph1ne"), ("1000", "Seeded_One")])
    player_index.record("arena", [("1265", "Seen_By_Atlas")])
    index = json.loads(
        open(lookup.atlas_player_index("arena", "index.json", _keyed(key)).path, encoding="utf-8").read()
    )
    assert index == {"1000": "Seeded_One", "1265": "Seen_By_Atlas", "6172844": "M0rph1ne"}
    assert list(index) == ["1000", "1265", "6172844"]  # in account ID order, as tarkov.dev's
    updated_file = lookup.atlas_player_index("arena", "updated.json", _keyed(key, bearer=True))
    updated = json.loads(open(updated_file.path, encoding="utf-8").read())
    # only accounts Atlas has seen itself carry a time
    assert list(updated) == ["1265"] and updated["1265"] > 0
    assert updated_file.headers["cache-control"] == "private, no-store"


def test_the_index_needs_a_lookup_key(lookup, atlas_key):
    from routers import atlas

    key, _ = atlas_key
    with pytest.raises(HTTPException) as e:
        lookup.atlas_player_index("arena", "index.json", _req())
    assert e.value.status_code == 401
    changes_only = atlas.admin_create_atlas_key(name="feed", expires_days=None, scopes=["changes"])["key"]
    with pytest.raises(HTTPException) as e:
        lookup.atlas_player_index("arena", "index.json", _keyed(changes_only))
    assert e.value.status_code == 403
    for mode, name in (("arena", "index"), ("arena", "other.json"), ("nope", "index.json")):
        with pytest.raises(HTTPException) as e:
            lookup.atlas_player_index(mode, name, _keyed(key))
        assert e.value.status_code == 404


def test_an_index_file_is_rebuilt_at_most_hourly(lookup, monkeypatch):
    import json

    from services import player_index

    player_index.record("pve", [("1", "First_One")])
    path = player_index.export("pve", "index")
    player_index.record("pve", [("2", "Second_One")])
    assert json.loads(open(path, encoding="utf-8").read()) == {"1": "First_One"}  # still the hour's copy
    monkeypatch.setattr(player_index, "EXPORT_MAX_AGE", 0)
    assert json.loads(open(player_index.export("pve", "index"), encoding="utf-8").read()) == {
        "1": "First_One",
        "2": "Second_One",
    }

"""Atlas player lookup: open to everyone but rate limited per IP (or per Atlas key), cached for a minute, off without
ATLAS_LOOKUP_URL, and only known error codes passed on from the upstream provider."""

import os
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response


@pytest.fixture
def lookup(monkeypatch):
    os.environ.setdefault("IP_HASH_SECRET", "atlas-test-secret")
    os.environ.setdefault("ADMIN_API_KEY", "atlas-test-admin")
    from routers import atlas_lookup
    from services import lookup_guard

    monkeypatch.setattr(atlas_lookup, "ATLAS_LOOKUP_URL", "http://127.0.0.1:8765")
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
    assert lookup.atlas_lookup_search(_req(), Response(), " target_x ") == found
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

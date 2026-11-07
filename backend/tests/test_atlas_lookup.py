"""Atlas player lookup: admin only, off without ATLAS_LOOKUP_URL, and the upstream provider's errors passed on."""

import os
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, Response


@pytest.fixture
def lookup(monkeypatch):
    os.environ.setdefault("IP_HASH_SECRET", "atlas-test-secret")
    os.environ.setdefault("ADMIN_API_KEY", "atlas-test-admin")
    from routers import atlas_lookup

    monkeypatch.setattr(atlas_lookup, "ATLAS_LOOKUP_URL", "http://127.0.0.1:8765")
    return atlas_lookup


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
    out = lookup.atlas_lookup(Response(), "1000002", _DB({"gun": "g.webp", "ammo": "a.webp"}))
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
    out = lookup.atlas_lookup(Response(), "1000002", _DB({"tag": "t.webp", "gun": "g.webp", "scope": "s.webp"}))
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
    out = lookup.atlas_lookup(Response(), "1000002", _DB({"m4a1": "m4.webp"}))
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
        lookup.atlas_lookup(Response(), "1", _DB({}))
    assert e.value.status_code == 503
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup_search(Response(), "Target_X")
    assert e.value.status_code == 503


def test_search_is_forwarded(lookup, monkeypatch):
    sent = []
    found = {"nickname": "target_x", "players": [{"accountId": "1000001", "nickname": "Target_X"}]}
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: sent.append((path, params)) or (200, found))
    assert lookup.atlas_lookup_search(Response(), " target_x ") == found
    assert sent == [("/search", {"nickname": "target_x", "mode": "season"})]


def test_bad_input_never_reaches_upstream(lookup, monkeypatch):
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: pytest.fail("sent"))
    for bad in ("abc", "1/../x", "1" * 13):
        with pytest.raises(HTTPException) as e:
            lookup.atlas_lookup(Response(), bad, _DB({}))
        assert e.value.status_code == 422
    for bad in ("ab", "a" * 16, "a b", "a&x=1"):
        with pytest.raises(HTTPException) as e:
            lookup.atlas_lookup_search(Response(), bad)
        assert e.value.status_code == 422


def test_upstream_errors_keep_their_status_and_code(lookup, monkeypatch):
    monkeypatch.setattr(lookup, "fetch_upstream", lambda path, params: (503, {"error": "session", "message": "lost"}))
    with pytest.raises(HTTPException) as e:
        lookup.atlas_lookup(Response(), "1", _DB({}))
    assert e.value.status_code == 503
    assert e.value.detail == {"error": "session", "message": "lost"}


def test_route_requires_admin(lookup):
    from routers.shared import require_admin

    for route in lookup.router.routes:
        assert any(d.dependency is require_admin for d in route.dependencies), route.path


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
    lookup.atlas_lookup_search(Response(), "Target_X")
    lookup.atlas_lookup_search(Response(), "Target_X", "arena")
    assert [params["mode"] for _, params in sent] == ["season", "arena"]
    for bad in ("", "eft", "PVP", "season&x=1"):
        with pytest.raises(HTTPException) as e:
            lookup.atlas_lookup_search(Response(), "Target_X", bad)
        assert e.value.status_code == 422
    assert len(sent) == 2

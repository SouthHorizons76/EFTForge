"""services/shop_art.py: the BlastGang shop's drawings kept on this server."""

from types import SimpleNamespace

from services import shop_art

GUN = "a" * 24
RECEIVER = "b" * 24
SIGHT = "c" * 24


def _slot(slot_id, parent, name):
    return SimpleNamespace(id=slot_id, parent_item_id=parent, slot_game_name=name)


def test_pairs_become_kitbash_items_under_their_parents():
    slots = {"s1": _slot("s1", GUN, "mod_reciever"), "s2": _slot("s2", RECEIVER, "mod_scope")}
    items = shop_art._spt_items(GUN, [["s1", RECEIVER], ["s2", SIGHT]], slots)
    assert items[0] == {"_id": shop_art.ROOT_ID, "_tpl": GUN, "parentId": "hideout", "slotId": "hideout"}
    receiver, sight = items[1], items[2]
    assert (receiver["_tpl"], receiver["parentId"], receiver["slotId"]) == (RECEIVER, shop_art.ROOT_ID, "mod_reciever")
    # the sight hangs from the receiver it's on, not from the gun
    assert (sight["_tpl"], sight["parentId"], sight["slotId"]) == (SIGHT, receiver["_id"], "mod_scope")
    assert all(len(it["_id"]) == 24 for it in items)


def test_an_unknown_slot_leaves_the_item_undrawn():
    assert shop_art._spt_items(GUN, [["missing", RECEIVER]], {}) is None


def test_a_helmet_gets_a_name_of_its_own():
    items = shop_art._spt_items(GUN, [], {})
    weapon = shop_art._name(shop_art._render_key(GUN, items, False))
    helmet = shop_art._name(shop_art._render_key(GUN, items, True))
    assert weapon != helmet and len(weapon) == 32


def test_a_name_the_shop_does_not_have_is_not_served(monkeypatch, tmp_path):
    monkeypatch.setattr(shop_art, "ART_DIR", str(tmp_path))
    monkeypatch.setattr(shop_art.build_images, "available", lambda: True)
    monkeypatch.setattr(shop_art.arena, "db_stamp", lambda: "stamp")
    monkeypatch.setattr(shop_art, "_specs", {})
    monkeypatch.setattr(shop_art, "_specs_from", "stamp")
    assert shop_art.path_for("0" * 32, None, []) is None

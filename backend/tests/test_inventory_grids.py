"""Inventory geometry: container layouts from the exported data, and item sizes by the game's rules."""

import pytest

import inventory_grids

GAMMA = "5857a8bc2459772bad15db29"  # secured container, one 3 by 3 grid
CHICOM = "64be7110bf597ba84a0a41ea"  # rig with the "chicom" layout
PARATUS = "5c0e805e86f774683f3dd637"  # backpack with the "Paratus" layout


def test_a_container_without_a_layout_is_one_row():
    grid = inventory_grids.container_grid(GAMMA)
    assert grid == {"w": 189, "h": 191, "grids": [{"id": "main", "w": 3, "h": 3, "x": -1, "y": 0}]}


def test_rigs_and_backpacks_use_their_layout():
    rig = inventory_grids.container_grid(CHICOM)
    assert [g["id"] for g in rig["grids"]] == ["1", "2", "3", "4", "5", "6", "7"]
    assert all(isinstance(g["x"], (int, float)) and isinstance(g["y"], (int, float)) for g in rig["grids"])
    pack = inventory_grids.container_grid(PARATUS)
    assert [(g["id"], g["w"], g["h"]) for g in pack["grids"]] == [("main", 5, 5), ("1", 1, 2), ("2", 1, 2), ("3", 3, 2)]
    assert pack["w"] > inventory_grids.cell_px(5)


def test_no_grid_for_an_item_without_one():
    assert inventory_grids.container_grid("not-a-template") is None


@pytest.fixture
def templates(monkeypatch):
    data = {
        "items": {
            "gun": {"w": 3, "h": 1, "merges": 1, "fold": ["mod_stock", 1]},
            "stock": {"w": 1, "h": 1, "extra": [0, 2, 0, 0]},
            "can": {"w": 1, "h": 1, "extra": [0, 1, 0, 0], "forced": 1},
            "can2": {"w": 1, "h": 1, "extra": [0, 1, 0, 0], "forced": 1},
            "light": {"w": 1, "h": 1, "extra": [0, 0, 1, 0]},
            "round": {"w": 1, "h": 1, "extra": [0, 5, 0, 0]},
            "box": {"w": 1, "h": 1},
        },
        "containers": {"pack": {"grids": [["main", 4, 4], ["side", 1, 2]]}},
        "layouts": {},
    }
    monkeypatch.setattr(inventory_grids, "_data", lambda: data)
    return data


def test_attached_parts_grow_a_weapon(templates):
    gun = {
        "tpl": "gun",
        "children": [
            {"slot": "mod_stock", "tpl": "stock"},
            {"slot": "mod_muzzle", "tpl": "can", "children": [{"slot": "mod_muzzle", "tpl": "can2"}]},
            {"slot": "mod_tactical", "tpl": "light"},
            {"slot": "patron_in_weapon", "tpl": "round"},  # the chambered round never counts
        ],
    }
    # Plain extra size takes the largest (stock +2 right, light +1 up), forced adds up; the
    # can doesn't merge with its children, so the one on it doesn't count
    assert inventory_grids.cell_size(gun) == (3 + 2 + 1, 1 + 1)
    templates["items"]["can"]["merges"] = 1
    assert inventory_grids.cell_size(gun) == (3 + 2 + 1 + 1, 1 + 1)


def test_a_folded_stock_comes_off(templates):
    gun = {"tpl": "gun", "folded": True, "children": [{"slot": "mod_stock", "tpl": "stock"}]}
    # The stock's own slot stops counting, and the fold takes one off the right
    assert inventory_grids.cell_size(gun) == (2, 1)


def test_an_item_that_doesnt_merge_keeps_its_size(templates):
    assert inventory_grids.cell_size({"tpl": "box", "children": [{"slot": "x", "tpl": "stock"}]}) == (1, 1)
    assert inventory_grids.cell_size({"tpl": "unknown"}) == (1, 1)


def test_geometry_goes_on_every_container_and_what_is_inside(templates):
    wallet = {"tpl": "box", "slot": "side"}
    pack = {"tpl": "pack", "contents": [{"tpl": "gun", "slot": "main", "children": []}, wallet]}
    inventory_grids.add_geometry([pack])
    assert [g["id"] for g in pack["grid"]["grids"]] == ["main", "side"]
    assert pack["grid"]["grids"][1]["x"] == inventory_grids.cell_px(4) - 1 + inventory_grids.ROW_GAP
    assert [(c["size"], c["grid_index"]) for c in pack["contents"]] == [([3, 1], 0), ([1, 1], 1)]
    assert "grid" not in wallet

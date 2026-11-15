from sqlalchemy import Boolean, Column, Float, Integer, String, Text

from database_arena import ArenaBase


class ArenaItem(ArenaBase):
    """What Arena adds to an item: its meta points and which preset classes may carry it.

    One row per item in Arena's armory, which is every item a custom preset can hold.
    """

    __tablename__ = "arena_items"

    item_id = Column(String, primary_key=True)
    # What the item costs a preset. Ammo's is per round.
    meta_points = Column(Float, nullable=False, default=0)
    # Firepower / Defence / Utility: the bar the game used to count it under
    meta_group = Column(String, nullable=True)
    # Comma-separated preset class ids; empty means every class
    class_ids = Column(Text, nullable=True)
    # The gear slot it goes in (FirstPrimaryWeapon, Headwear...), null for weapon parts,
    # ammo and what is only carried
    gear_slot = Column(String, nullable=True, index=True)
    # Carried in a rig or pockets: magazine, ammo, medical, grenade
    carry_kind = Column(String, nullable=True, index=True)
    # The armory's own category, for grouping pickers
    category_id = Column(String, nullable=True)
    category = Column(String, nullable=True)
    category_zh = Column(String, nullable=True)
    unlocked_by_default = Column(Boolean, default=False)
    # JSON {class id: [item ids]} of mods and of ammo a class may not put on this weapon
    excluded_mods = Column(Text, nullable=True)
    excluded_ammo = Column(Text, nullable=True)
    # Inventory cells, and for what holds things the cells it offers
    width = Column(Integer, nullable=True)
    height = Column(Integer, nullable=True)
    # JSON [[w, h], ...]: a rig's grids
    grids = Column(Text, nullable=True)


class ArenaSetting(ArenaBase):
    """One JSON value Arena mode needs whole: the classes, their meta score limits, the
    stock presets, and which snapshot the database was built from."""

    __tablename__ = "arena_settings"

    key = Column(String, primary_key=True)
    value = Column(Text, nullable=False)

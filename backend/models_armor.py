from sqlalchemy import Column, String, Float, Boolean, Text, Integer, ForeignKey
from database import Base


class ArmorPiece(Base):
    """One armor component as the game sees it: the thing a shot is checked against.

    Vests, rigs and helmets carry no armor of their own in tarkov.dev's model. Their
    protection lives in locked armor slots (built-in soft inserts, helmet sections), so
    each locked slot becomes a row here with holder_item_id set to the vest/helmet and
    slot_name_id set to the slot. Items that are armor themselves (plates, face shields,
    helmet add-ons, masks) get one row with slot_name_id left null.
    """

    __tablename__ = "armor_pieces"

    id = Column(Integer, primary_key=True, autoincrement=True)
    holder_item_id = Column(String, ForeignKey("items.id"), index=True)
    slot_name_id = Column(String, nullable=True)  # e.g. Soft_armor_front, Helmet_top
    # Game template id of a built-in insert (taken from the slot's name token). Those
    # inserts aren't standalone items on tarkov.dev, so this has no items row.
    insert_item_id = Column(String, nullable=True)
    name = Column(String, nullable=True)
    name_zh = Column(String, nullable=True)

    armor_class = Column(Integer)
    durability = Column(Float)
    material = Column(String)  # EArmorMaterial name, matches the ArmorMaterials globals keys
    armor_type = Column(String, nullable=True)  # Light / Heavy / None
    blunt_throughput = Column(Float)
    ricochet_x = Column(Float, nullable=True)
    ricochet_y = Column(Float, nullable=True)
    ricochet_z = Column(Float, nullable=True)

    # Comma-separated collider names with tarkov.dev's display prefixes stripped:
    # body colliders like RibcageUp, plate colliders like Plate_Granit_SAPI_chest.
    body_colliders = Column(Text, nullable=True)
    plate_colliders = Column(Text, nullable=True)


class ArmorPlateSlot(Base):
    """An open plate slot on a carrier or armored rig, and which plates fit it."""

    __tablename__ = "armor_plate_slots"

    id = Column(Integer, primary_key=True, autoincrement=True)
    holder_item_id = Column(String, ForeignKey("items.id"), index=True)
    slot_name_id = Column(String)  # e.g. Front_plate, Left_side_plate
    plate_colliders = Column(Text, nullable=True)
    allowed_plate_ids = Column(Text, nullable=True)
    # Plates in a slot with this flag have their blunt throughput scaled by the
    # BluntDamageReduceFromSoftArmorMod global. tarkov.dev doesn't carry it, so it comes
    # from SPT game files and stays False when no SPT source is available.
    blunt_reduce_from_soft_armor = Column(Boolean, default=False)


class ArmorDefaultInsert(Base):
    """A plate or helmet attachment an armor item comes with, from its default preset.

    tarkov.dev lists a preset's contents without saying which slot each part sits in, so
    the sync places every part in the first slot of the holder that takes it.
    """

    __tablename__ = "armor_default_inserts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    holder_item_id = Column(String, ForeignKey("items.id"), index=True)
    slot_name_id = Column(String)  # a plate slot (Front_plate) or a helmet slot (mod_equipment_000)
    item_id = Column(String)

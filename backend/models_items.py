from sqlalchemy import Column, String, Float, Boolean, Text, Integer
from database import Base


class Item(Base):
    __tablename__ = "items"

    id = Column(String, primary_key=True, index=True)
    name = Column(String)
    short_name = Column(String)
    name_zh = Column(String, nullable=True)
    short_name_zh = Column(String, nullable=True)

    weight = Column(Float)
    ergonomics_modifier = Column(Float)
    recoil_modifier = Column(Float, default=0)
    accuracy_modifier = Column(Float, nullable=True)

    image_512_link = Column(String, nullable=True)
    bare_image_512_link = Column(String, nullable=True)  # item's own 512px image, not the preset
    icon_link = Column(String, nullable=True)
    base_image_link = Column(String, nullable=True)
    preset_icon_link = Column(String, nullable=True)

    weapon_category = Column(String, index=True)
    is_weapon = Column(Boolean, default=False, index=True)

    # Raw tarkov.dev category ids (item["categories"]), comma-separated like
    # conflicting_item_ids below. weapon_category above is a derived, weapon-only
    # display label; this is the full raw taxonomy membership, needed to match
    # attachment items against category-based requirements (e.g. Gunsmith task
    # "any suppressor or any muzzle brake").
    category_ids = Column(Text, nullable=True)

    # Display label for the item's most specific tarkov.dev Handbook category
    # (e.g. "Compact reflex sight", "Silencer"), derived from category_ids at
    # sync time. Used to group attachments in the optimizer's mod-filter picker.
    attachment_category = Column(String, nullable=True)
    attachment_category_zh = Column(String, nullable=True)

    base_ergonomics = Column(Float)

    factory_ergonomics = Column(Float)
    factory_weight = Column(Float)

    factory_attachment_ids = Column(Text)

    caliber = Column(String)
    magazine_capacity = Column(Integer)
    is_ammo = Column(Boolean, default=False, index=True)

    # Ammo ballistic stats
    ammo_damage = Column(Integer, nullable=True)
    penetration_power = Column(Integer, nullable=True)
    armor_damage = Column(Integer, nullable=True)
    velocity = Column(Float, nullable=True)
    tracer = Column(Boolean, nullable=True)
    tracer_color = Column(String, nullable=True)
    ammo_type = Column(String, nullable=True)
    projectile_count = Column(Integer, nullable=True)
    fragmentation_chance = Column(Float, nullable=True)
    ricochet_chance = Column(Float, nullable=True)
    stack_max_size = Column(Integer, nullable=True)
    ammo_accuracy_modifier = Column(Float, nullable=True)
    ammo_recoil_modifier = Column(Float, nullable=True)
    light_bleed_delta = Column(Float, nullable=True)
    heavy_bleed_delta = Column(Float, nullable=True)
    penetration_chance = Column(Float, nullable=True)
    penetration_power_deviation = Column(Float, nullable=True)

    conflicting_item_ids = Column(Text)
    conflicting_slot_ids = Column(Text)

    recoil_vertical = Column(Integer, nullable=True)
    recoil_horizontal = Column(Integer, nullable=True)
    factory_recoil_vertical = Column(Float, nullable=True)
    factory_recoil_horizontal = Column(Float, nullable=True)

    sighting_range = Column(Integer, nullable=True)

    # Hidden stats - from tarkov.dev API
    center_of_impact = Column(Float, nullable=True)
    camera_snap = Column(Float, nullable=True)
    deviation_curve = Column(Float, nullable=True)
    deviation_max = Column(Float, nullable=True)
    recoil_angle = Column(Integer, nullable=True)
    camera_recoil = Column(Float, nullable=True)
    convergence = Column(Float, nullable=True)
    recoil_dispersion = Column(Integer, nullable=True)

    # Hidden stats - from SPT game files (fallback)
    aim_sensitivity = Column(Float, nullable=True)
    cam_angle_step = Column(Float, nullable=True)
    mount_cam_snap = Column(Float, nullable=True)
    mount_h_rec = Column(Float, nullable=True)
    mount_v_rec = Column(Float, nullable=True)
    mount_breath = Column(Float, nullable=True)
    rec_hand_rot = Column(Float, nullable=True)
    rec_force_back = Column(Integer, nullable=True)
    rec_force_up = Column(Integer, nullable=True)
    rec_return_speed = Column(Float, nullable=True)

    trader_price = Column(Integer, nullable=True)
    trader_price_rub = Column(Integer, nullable=True)
    trader_currency = Column(String, nullable=True)
    trader_vendor = Column(String, nullable=True)
    trader_min_level = Column(Integer, nullable=True)
    task_unlock_id = Column(String, nullable=True)
    task_unlock_name = Column(String, nullable=True)
    task_unlock_name_zh = Column(String, nullable=True)

    # Heat / cooling / durability-burn factors (barrels, muzzle devices/weapon mods, ammo)
    heat_factor = Column(Float, nullable=True)
    cooling_factor = Column(Float, nullable=True)
    durability_burn_factor = Column(Float, nullable=True)

    # Muzzle velocity % modifier (barrels/muzzle devices). Not currently exposed by the
    # tarkov.dev API (no such field exists there as of writing) - stays null until it is.
    velocity_modifier = Column(Float, nullable=True)

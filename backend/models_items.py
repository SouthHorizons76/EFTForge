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

    image_512_link    = Column(String, nullable=True)
    icon_link         = Column(String, nullable=True)
    preset_icon_link  = Column(String, nullable=True)

    weapon_category = Column(String, index=True)
    is_weapon = Column(Boolean, default=False, index=True)

    base_ergonomics = Column(Float)

    factory_ergonomics = Column(Float)
    factory_weight = Column(Float)

    factory_attachment_ids = Column(Text)

    caliber = Column(String)
    magazine_capacity = Column(Integer)
    is_ammo = Column(Boolean, default=False, index=True)

    conflicting_item_ids = Column(Text)
    conflicting_slot_ids = Column(Text)

    recoil_vertical = Column(Integer, nullable=True)
    recoil_horizontal = Column(Integer, nullable=True)
    factory_recoil_vertical = Column(Float, nullable=True)
    factory_recoil_horizontal = Column(Float, nullable=True)

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

    trader_price       = Column(Integer, nullable=True)
    trader_price_rub   = Column(Integer, nullable=True)
    trader_currency    = Column(String,  nullable=True)
    trader_vendor      = Column(String,  nullable=True)
    trader_min_level   = Column(Integer, nullable=True)
    task_unlock_id     = Column(String,  nullable=True)
    task_unlock_name   = Column(String,  nullable=True)
    task_unlock_name_zh = Column(String, nullable=True)
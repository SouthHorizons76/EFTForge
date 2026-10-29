"""Weapon list, weapon images, and the single-request gun bootstrap."""

import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

import build_images
from build_images import build_image_key
from models_items import Item
from models_slot_allowed import SlotAllowedItem
from models_slots import Slot
from routers.shared import (
    EQUIP_ERGO_MAX,
    EQUIP_ERGO_MIN,
    STRENGTH_LEVEL_MAX,
    STRENGTH_LEVEL_MIN,
    get_db,
    item_name,
    item_short_name,
)
from services.build_cards import build_spt_items
from stats import _compute_stats, apply_full_mag_ammo

_logger = logging.getLogger(__name__)

router = APIRouter()


# Weapons
# ---------------------------------------------------

# tarkov.dev serves this until it renders a new weapon's images; we draw those
# with Kitbash! instead, when it has the parts.
UNKNOWN_IMAGE_512 = "https://assets.tarkov.dev/unknown-item-512.webp"


def _gun_image_512(gun: Item, bare: bool) -> str | None:
    link = gun.bare_image_512_link if bare else gun.image_512_link
    if link != UNKNOWN_IMAGE_512 or not build_images.available():
        return link
    # Relative to the API; the frontend prefixes its API base.
    return f"/guns/{gun.id}/image" + ("?bare=1" if bare else "")


@router.get("/guns")
def get_guns(lang: str = "en", db: Session = Depends(get_db)):
    guns = db.query(Item).filter(Item.is_weapon == True).all()

    result = []

    for gun in guns:

        if gun.factory_attachment_ids:
            factory_ids = gun.factory_attachment_ids.split(",")
        else:
            factory_ids = []

        result.append(
            {
                "id": gun.id,
                "name": item_name(gun, lang),
                "short_name": item_short_name(gun, lang),
                "base_ergo": gun.factory_ergonomics or gun.base_ergonomics or 0,
                "weight": gun.weight or 0,
                "icon_link": gun.icon_link,
                "preset_icon_link": gun.preset_icon_link,
                "image_512_link": _gun_image_512(gun, bare=False),
                "bare_image_512_link": _gun_image_512(gun, bare=True),
                "factory_attachment_ids": factory_ids,
                "caliber": gun.caliber,
                # Zeros the weapon in the Ballistics Workbench's drop table
                "default_ammo_id": gun.default_ammo_id,
                "weapon_category": gun.weapon_category,
                "recoil_vertical": gun.recoil_vertical,
                "recoil_horizontal": gun.recoil_horizontal,
                "sighting_range": gun.sighting_range,
                "center_of_impact": gun.center_of_impact,
                "camera_snap": gun.camera_snap,
                "deviation_curve": gun.deviation_curve,
                "deviation_max": gun.deviation_max,
                "recoil_angle": gun.recoil_angle,
                "camera_recoil": gun.camera_recoil,
                "convergence": gun.convergence,
                "recoil_dispersion": gun.recoil_dispersion,
                "fire_rate": gun.fire_rate,
                "cam_angle_step": gun.cam_angle_step,
                "mount_cam_snap": gun.mount_cam_snap,
                "mount_h_rec": gun.mount_h_rec,
                "mount_v_rec": gun.mount_v_rec,
                "mount_breath": gun.mount_breath,
                "rec_hand_rot": gun.rec_hand_rot,
                "rec_force_back": gun.rec_force_back,
                "rec_force_up": gun.rec_force_up,
                "rec_return_speed": gun.rec_return_speed,
                "recoil_damping_hand_rot": gun.recoil_damping_hand_rot,
                "recoil_return_path_damping": gun.recoil_return_path_damping,
                "recoil_return_path_offset": gun.recoil_return_path_offset,
                "recoil_stable_index_shot": gun.recoil_stable_index_shot,
                "recoil_stable_angle_step": gun.recoil_stable_angle_step,
                "recoil_stable_angle": gun.recoil_stable_angle,
                "recoil_pos_z_mult": gun.recoil_pos_z_mult,
                "recoil_center_y": gun.recoil_center_y,
                "recoil_center_z": gun.recoil_center_z,
                "trader_price": gun.trader_price,
                "trader_price_rub": gun.trader_price_rub,
                "trader_currency": gun.trader_currency,
                "trader_vendor": gun.trader_vendor,
                "trader_min_level": gun.trader_min_level,
            }
        )

    return result


@router.get("/graph/searchable-items")
def get_graph_searchable_items(db: Session = Depends(get_db)):
    from sqlalchemy import exists as sa_exists

    guns = (
        db.query(Item)
        .filter(
            Item.is_weapon == True,
            Item.caliber != "Caliber26x75",
            ~Item.name.ilike("%rocket%"),
            ~Item.name.ilike("%rshg%"),
        )
        .order_by(Item.weapon_category, Item.name)
        .all()
    )
    attachments = (
        db.query(Item)
        .filter(
            Item.is_weapon == False,
            Item.is_ammo == False,
            sa_exists().where(SlotAllowedItem.allowed_item_id == Item.id),
        )
        .order_by(Item.name)
        .all()
    )
    return {
        "guns": [
            {
                "id": g.id,
                "name": g.name,
                "short_name": g.short_name,
                "name_zh": g.name_zh,
                "short_name_zh": g.short_name_zh,
                "weapon_category": g.weapon_category,
                "base_ergonomics": g.base_ergonomics,
                "factory_ergonomics": g.factory_ergonomics,
                "recoil_vertical": g.recoil_vertical,
                "recoil_horizontal": g.recoil_horizontal,
                "factory_recoil_vertical": g.factory_recoil_vertical,
                "factory_recoil_horizontal": g.factory_recoil_horizontal,
                "icon_link": g.icon_link,
                "base_image_link": g.base_image_link,
                "image_512_link": _gun_image_512(g, bare=False),
                "bare_image_512_link": _gun_image_512(g, bare=True),
            }
            for g in guns
        ],
        "attachments": [
            {
                "id": a.id,
                "name": a.name,
                "short_name": a.short_name,
                "name_zh": a.name_zh,
                "short_name_zh": a.short_name_zh,
                "ergonomics_modifier": a.ergonomics_modifier,
                "recoil_modifier": a.recoil_modifier,
                "icon_link": a.icon_link,
                "base_image_link": a.base_image_link,
            }
            for a in attachments
        ],
    }


# ---------------------------------------------------
# Gun Init (single-request gun selection bootstrap)
# ---------------------------------------------------


def _resolve_factory_tree(
    gun_id: str,
    factory_ids: list,
    known_ids: set,
    slot_ids_by_item: dict,
    factory_allowed_by_slot: dict,
) -> dict:
    """Place a weapon's flat factory attachment list into slots, as
    {slot_id: {"item_id": ..., "children": {...}}}."""
    # Determine which factory items can fit inside another factory item's slots.
    # These are "child candidates" and must be processed after their potential parents
    # so the parent can claim its gun-level slot first.
    factory_item_ids = set(factory_ids)
    factory_child_ids: set[str] = set()
    for parent_id, slot_ids in slot_ids_by_item.items():
        if parent_id in factory_item_ids:
            for slot_id in slot_ids:
                factory_child_ids.update(fid for fid in factory_allowed_by_slot.get(slot_id, set()) if fid != parent_id)

    def _sort_ids(ids: list) -> list:
        """Parents (not a child of any factory item) first, child-candidates last."""
        return [fid for fid in ids if fid not in factory_child_ids] + [fid for fid in ids if fid in factory_child_ids]

    # Each slot is only filled once (first match wins) to prevent a later item
    # from overwriting an earlier one that already claimed that slot.
    def _resolve_children(node_item_id: str, remaining_ids: list) -> dict:
        children = {}
        node_slot_ids = slot_ids_by_item.get(node_item_id, [])
        for attachment_id in _sort_ids(remaining_ids):
            if attachment_id not in known_ids:
                continue
            for slot_id in node_slot_ids:
                if slot_id not in children and attachment_id in factory_allowed_by_slot.get(slot_id, set()):
                    other_ids = [fid for fid in remaining_ids if fid != attachment_id]
                    children[slot_id] = {
                        "item_id": attachment_id,
                        "children": _resolve_children(attachment_id, other_ids),
                    }
                    break
        return children

    return _resolve_children(gun_id, factory_ids)


def _factory_pairs(db: Session, gun: Item) -> list:
    """The weapon's factory preset as [[slot_id, item_id], ...], parents first."""
    factory_ids = [f.strip() for f in (gun.factory_attachment_ids or "").split(",") if f.strip()]
    if not factory_ids:
        return []
    known_ids = {row.id for row in db.query(Item.id).filter(Item.id.in_(factory_ids)).all()}
    slot_ids_by_item: dict[str, list] = {iid: [] for iid in {gun.id} | set(factory_ids)}
    for slot in db.query(Slot).filter(Slot.parent_item_id.in_(list(slot_ids_by_item))).all():
        slot_ids_by_item[slot.parent_item_id].append(slot.id)
    all_slot_ids = [sid for sids in slot_ids_by_item.values() for sid in sids]
    factory_allowed_by_slot: dict[str, set] = {}
    for rec in (
        db.query(SlotAllowedItem)
        .filter(SlotAllowedItem.slot_id.in_(all_slot_ids), SlotAllowedItem.allowed_item_id.in_(factory_ids))
        .all()
    ):
        factory_allowed_by_slot.setdefault(rec.slot_id, set()).add(rec.allowed_item_id)

    pairs: list = []

    def _walk(tree: dict):
        for slot_id, node in tree.items():
            pairs.append([slot_id, node["item_id"]])
            _walk(node["children"])

    _walk(_resolve_factory_tree(gun.id, factory_ids, known_ids, slot_ids_by_item, factory_allowed_by_slot))
    return pairs


@router.get("/guns/{gun_id}/image")
async def get_gun_image(gun_id: str, bare: bool = False, db: Session = Depends(get_db)):
    """The weapon's factory preset (or bare receiver) drawn by Kitbash!, for weapons
    tarkov.dev has no image for yet. Redirects to tarkov.dev's unknown-item image
    when Kitbash! lacks a part."""
    gun = db.get(Item, gun_id)
    if not gun or not gun.is_weapon:
        raise HTTPException(status_code=404, detail="Gun not found")
    # Only draw guns tarkov.dev has no image for, the ones /guns points here. Any
    # other gun goes to its tarkov.dev image, so nobody can make us draw them all.
    link = gun.bare_image_512_link if bare else gun.image_512_link
    if link != UNKNOWN_IMAGE_512:
        return RedirectResponse(
            link or UNKNOWN_IMAGE_512, status_code=302, headers={"Cache-Control": "public, max-age=3600"}
        )
    if build_images.available():
        try:
            items = build_spt_items(gun_id, [] if bare else _factory_pairs(db, gun))
            data, _ = await asyncio.to_thread(build_images.render_webp, build_image_key(gun_id, items), items)
            return Response(content=data, media_type="image/webp", headers={"Cache-Control": "public, max-age=3600"})
        except (build_images.Unrenderable, ValueError) as exc:
            _logger.info("gun-image Kitbash! cannot draw %s: %s", gun_id, exc)
    return RedirectResponse(UNKNOWN_IMAGE_512, status_code=302, headers={"Cache-Control": "public, max-age=3600"})


@router.get("/guns/{gun_id}/init")
def get_gun_init(
    gun_id: str,
    lang: str = "en",
    strength_level: int = 10,
    equip_ergo_modifier: float = 0.0,
    selected_ammo_id: str | None = None,
    selected_ubgl_ammo_id: str | None = None,
    assume_full_mag: bool = True,
    db: Session = Depends(get_db),
):
    if not (STRENGTH_LEVEL_MIN <= strength_level <= STRENGTH_LEVEL_MAX):
        raise HTTPException(
            status_code=422, detail=f"strength_level must be between {STRENGTH_LEVEL_MIN} and {STRENGTH_LEVEL_MAX}"
        )

    if not (EQUIP_ERGO_MIN <= equip_ergo_modifier <= EQUIP_ERGO_MAX):
        raise HTTPException(
            status_code=422, detail=f"equip_ergo_modifier must be between {EQUIP_ERGO_MIN} and {EQUIP_ERGO_MAX}"
        )

    gun = db.query(Item).filter(Item.id == gun_id).first()
    if not gun:
        raise HTTPException(status_code=404, detail="Gun not found")

    factory_ids = [f.strip() for f in (gun.factory_attachment_ids or "").split(",") if f.strip()]

    # Batch-load all factory attachment items (1 query)
    factory_items_map = {}
    if factory_ids:
        factory_items_map = {item.id: item for item in db.query(Item).filter(Item.id.in_(factory_ids)).all()}

    # Batch-load all slots for gun + all factory items (1 query)
    all_item_ids = {gun_id} | set(factory_ids)
    all_slots = db.query(Slot).filter(Slot.parent_item_id.in_(all_item_ids)).all()
    all_slot_ids = [s.id for s in all_slots]

    # Count allowed items per slot for has_allowed_items (1 query)
    slot_counts = {}
    if all_slot_ids:
        slot_counts = dict(
            db.query(SlotAllowedItem.slot_id, func.count(SlotAllowedItem.allowed_item_id))
            .filter(SlotAllowedItem.slot_id.in_(all_slot_ids))
            .group_by(SlotAllowedItem.slot_id)
            .all()
        )

    # Build slots_by_item for frontend slotCache population
    slots_by_item: dict[str, list] = {iid: [] for iid in all_item_ids}
    for s in all_slots:
        slots_by_item[s.parent_item_id].append(
            {
                "id": s.id,
                "parent_item_id": s.parent_item_id,
                "slot_name": s.slot_name,
                "slot_game_name": s.slot_game_name,
                "has_allowed_items": slot_counts.get(s.id, 0) > 0,
            }
        )

    # Find which factory items are allowed in which slots (1 query)
    factory_allowed_by_slot: dict[str, set] = {}
    if all_slot_ids and factory_ids:
        for rec in (
            db.query(SlotAllowedItem)
            .filter(
                SlotAllowedItem.slot_id.in_(all_slot_ids),
                SlotAllowedItem.allowed_item_id.in_(factory_ids),
            )
            .all()
        ):
            factory_allowed_by_slot.setdefault(rec.slot_id, set()).add(rec.allowed_item_id)

    # Serialize a factory attachment item (same shape as /slots/{id}/allowed-items)
    def _fmt_item(item):
        return {
            "id": item.id,
            "name": item_name(item, lang),
            "short_name": item_short_name(item, lang),
            "weight": item.weight,
            "ergonomics_modifier": item.ergonomics_modifier,
            "recoil_modifier": item.recoil_modifier,
            "accuracy_modifier": item.accuracy_modifier,
            "center_of_impact": item.center_of_impact,
            "deviation_curve": item.deviation_curve,
            "deviation_max": item.deviation_max,
            "sighting_range": item.sighting_range,
            "heat_factor": item.heat_factor,
            "cooling_factor": item.cooling_factor,
            "durability_burn_factor": item.durability_burn_factor,
            "velocity_modifier": item.velocity_modifier,
            "loudness": item.loudness,
            "icon_link": item.icon_link,
            "base_image_link": item.base_image_link,
            "conflicting_item_ids": item.conflicting_item_ids,
            "conflicting_slot_ids": item.conflicting_slot_ids,
            "magazine_capacity": item.magazine_capacity,
            "caliber": item.caliber,
            "is_weapon": item.is_weapon,
            "trader_price": item.trader_price,
            "trader_price_rub": item.trader_price_rub,
            "trader_currency": item.trader_currency,
            "trader_vendor": item.trader_vendor,
            "trader_min_level": item.trader_min_level,
        }

    slot_ids_by_item = {iid: [slot["id"] for slot in slots] for iid, slots in slots_by_item.items()}
    id_tree = _resolve_factory_tree(
        gun_id, factory_ids, set(factory_items_map), slot_ids_by_item, factory_allowed_by_slot
    )

    def _fmt_tree(tree: dict) -> dict:
        return {
            slot_id: {"item": _fmt_item(factory_items_map[node["item_id"]]), "children": _fmt_tree(node["children"])}
            for slot_id, node in tree.items()
        }

    factory_tree = _fmt_tree(id_tree)

    # Load ammo for caliber (1 query)
    ammo_list = []
    if gun.caliber:
        ammo_list = [
            {
                "id": a.id,
                "name": item_name(a, lang),
                "short_name": item_short_name(a, lang),
                "weight": a.weight,
                "icon_link": a.icon_link,
                "trader_price": a.trader_price,
                "trader_price_rub": a.trader_price_rub,
                "trader_currency": a.trader_currency,
                "trader_vendor": a.trader_vendor,
                "trader_min_level": a.trader_min_level,
            }
            for a in db.query(Item)
            .filter(
                Item.is_ammo == True,
                Item.caliber == gun.caliber,
            )
            .order_by(Item.weight.asc())
            .all()
        ]

    # Compute build stats with factory attachments
    stats = _compute_stats(gun, factory_ids, factory_items_map, strength_level, equip_ergo_modifier)

    # Apply ammo weight + heat/durability-burn if a valid ammo ID was provided.
    # Shares apply_full_mag_ammo() with /build/calculate and the optimizer's post-solve
    # final_stats - must stay in sync or the very first stats shown on gun load (from this
    # endpoint) disagree with every subsequent recalculation.
    # Falls back to the first ammo in the list (same ordering the frontend's <select>
    # defaults to) when the caller has no saved per-caliber preference yet, so a
    # first-time visitor sees a real muzzle velocity instead of "No Ammo".
    effective_ammo_id = selected_ammo_id or (ammo_list[0]["id"] if ammo_list else None)

    ammo = (
        db.query(Item).filter(Item.id == effective_ammo_id).first() if (assume_full_mag and effective_ammo_id) else None
    )
    ubgl_grenade = (
        db.query(Item).filter(Item.id == selected_ubgl_ammo_id).first()
        if (assume_full_mag and selected_ubgl_ammo_id)
        else None
    )
    apply_full_mag_ammo(stats, factory_items_map, ammo, ubgl_grenade, strength_level, equip_ergo_modifier)

    # Fetch UBGL grenade ammo list - find any factory UBGL by caliber (UBGLs are non-ammo items with a caliber)
    ubgl_ammo_list = []
    ubgl_caliber = next(
        (
            att.caliber
            for att in factory_items_map.values()
            if att.caliber and not att.is_ammo and not att.magazine_capacity
        ),
        None,
    )
    if ubgl_caliber:
        ubgl_ammo_list = [
            {
                "id": a.id,
                "name": item_name(a, lang),
                "short_name": item_short_name(a, lang),
                "weight": a.weight,
                "icon_link": a.icon_link,
                "trader_price": a.trader_price,
                "trader_price_rub": a.trader_price_rub,
                "trader_currency": a.trader_currency,
                "trader_vendor": a.trader_vendor,
                "trader_min_level": a.trader_min_level,
            }
            for a in db.query(Item)
            .filter(
                Item.is_ammo == True,
                Item.caliber == ubgl_caliber,
            )
            .order_by(Item.weight.asc())
            .all()
        ]

    return {
        "slots_by_item": slots_by_item,
        "factory_tree": factory_tree,
        "factory_attachment_ids": factory_ids,
        "ammo": ammo_list,
        "ubgl_ammo": ubgl_ammo_list,
        "stats": stats,
    }

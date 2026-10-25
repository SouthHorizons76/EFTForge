from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from models_items import Item
from models_slot_allowed import SlotAllowedItem
from models_stat_changelog import StatChangeLog
from routers.shared import get_changelog_db, get_db

router = APIRouter()

# ---------------------------------------------------
# Stat Tracker changelog
# ---------------------------------------------------


def _changelog_items(db: Session, item_ids) -> dict:
    # Look up the changelog's items that the tracker still shows: weapons, ammo and
    # anything that fits a slot. Items since removed from the game drop out here.
    item_ids = list(item_ids)
    if not item_ids:
        return {}
    items_map = {item.id: item for item in db.query(Item).filter(Item.id.in_(item_ids)).all()}
    attachment_ids = {
        row[0]
        for row in db.query(SlotAllowedItem.allowed_item_id)
        .filter(SlotAllowedItem.allowed_item_id.in_(item_ids))
        .distinct()
        .all()
    }
    return {
        item_id: item
        for item_id, item in items_map.items()
        if item.is_weapon or item.is_ammo or item_id in attachment_ids
    }


@router.get("/stat-changelog/dates")
def get_stat_changelog_dates(
    db: Session = Depends(get_db),
    changelog_db: Session = Depends(get_changelog_db),
):
    # Every UTC day that logged a change, newest first, with how many tracked items
    # changed that day. The tracker's history picker lists these.
    pairs = changelog_db.query(func.date(StatChangeLog.detected_at), StatChangeLog.item_id).distinct().all()
    tracked = _changelog_items(db, {item_id for _, item_id in pairs})
    counts = {}
    for day, item_id in pairs:
        if day and item_id in tracked:
            counts[day] = counts.get(day, 0) + 1
    return [{"date": day, "item_count": counts[day]} for day in sorted(counts, reverse=True)]


@router.get("/stat-changelog")
def get_stat_changelog(
    date: str | None = None,
    db: Session = Depends(get_db),
    changelog_db: Session = Depends(get_changelog_db),
):
    # With no date we serve the rolling recent window the tracker opens on (and older
    # clients still expect); with a YYYY-MM-DD date we serve that one UTC day from the
    # full history, which is never pruned.
    query = changelog_db.query(StatChangeLog)
    if date is None:
        query = query.filter(StatChangeLog.detected_at >= datetime.now(timezone.utc) - timedelta(days=8))
    else:
        try:
            day_start = datetime.strptime(date, "%Y-%m-%d")
        except ValueError:
            raise HTTPException(status_code=422, detail="date must be YYYY-MM-DD")
        query = query.filter(
            StatChangeLog.detected_at >= day_start,
            StatChangeLog.detected_at < day_start + timedelta(days=1),
        )
    rows = query.order_by(StatChangeLog.detected_at.desc()).all()

    items_map = _changelog_items(db, {r.item_id for r in rows})
    return [
        {
            "item_id": row.item_id,
            "item_name": item.name,
            "item_name_zh": item.name_zh,
            "icon_link": item.icon_link,
            "is_weapon": item.is_weapon,
            "is_ammo": item.is_ammo,
            "stat_name": row.stat_name,
            "old_value": row.old_value,
            "new_value": row.new_value,
            "detected_at": row.detected_at.isoformat() if row.detected_at else None,
        }
        for row in rows
        if (item := items_map.get(row.item_id)) is not None
    ]

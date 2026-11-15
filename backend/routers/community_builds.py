"""Publishing, browsing, and unlisting community builds, plus the feature kill switch."""

import json
import os
import time
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Header, Request
from sqlalchemy import func
from sqlalchemy.orm import Session

from config import RUNTIME_DIR
from models_builds import BuildComment, BuildRating, IPBan, PendingNotification, PublicBuild, PublicBuildAuthor
from models_items import Item
from routers.shared import (
    MAX_STATS_JSON_CHARS,
    check_client_ban,
    get_builds_db,
    get_client_id_hash,
    get_client_ip,
    get_db,
    get_optional_client_id_hash,
    public_card_url,
    require_admin,
    safe_json_loads,
    sanitize_build_name,
    sanitize_username,
    validate_pairs,
)
from services.build_cards import generate_and_save_build_image
from services.build_check import missing_required, required_slots
from services.arena_drawings import delete_drawings
from services.gitee import gitee_delete_image, validate_avatar_url

router = APIRouter()


# Community builds kill switch.
# Persisted via a sentinel file so it survives server restarts.
_COMMUNITY_BUILDS_LOCK_FILE = os.path.join(RUNTIME_DIR, "community_builds.lock")
_community_builds_disabled: bool = os.path.exists(_COMMUNITY_BUILDS_LOCK_FILE)


# publish rate limit: client_id_hash -> monotonic time of last successful publish
_publish_last: dict[str, float] = {}
_PUBLISH_COOLDOWN = 60.0


# ---------------------------------------------------
# Public Builds
# ---------------------------------------------------


@router.post("/builds/publish")
def publish_build(
    request: Request,
    background_tasks: BackgroundTasks,
    x_client_id: str = Header(None),
    gun_id: str = Body(...),
    build_name: str = Body(..., max_length=60),
    pairs: List[list] = Body(...),
    stats: dict | None = Body(default=None),
    ammo_id: str | None = Body(default=None),
    author_username: str | None = Body(default=None, max_length=30),
    author_avatar_url: str | None = Body(default=None),
    tags: List[str] | None = Body(default=None),
    db: Session = Depends(get_builds_db),
    db_main: Session = Depends(get_db),
):
    client_hash = get_client_id_hash(x_client_id)

    # rate limit: one publish per 60 seconds per client
    now_mono = time.monotonic()
    # evict stale entries (older than 2x cooldown) to prevent unbounded growth
    stale = [k for k, t in _publish_last.items() if now_mono - t > _PUBLISH_COOLDOWN * 2]
    for k in stale:
        del _publish_last[k]
    last = _publish_last.get(client_hash, 0.0)
    if now_mono - last < _PUBLISH_COOLDOWN:
        remaining = int(_PUBLISH_COOLDOWN - (now_mono - last))
        raise HTTPException(status_code=429, detail=f"Rate limit: wait {remaining}s before publishing again.")

    check_client_ban(client_hash, db)

    # validate gun exists
    gun = db_main.query(Item).filter(Item.id == gun_id, Item.is_weapon == True).first()
    if not gun:
        raise HTTPException(status_code=422, detail="Unknown gun_id.")

    # sanitize build name
    name = sanitize_build_name(build_name)[:60]
    if not name:
        raise HTTPException(status_code=422, detail="build_name cannot be empty.")

    # sanitize user profile fields
    u_name = sanitize_username(author_username) if author_username else None
    try:
        u_avatar = validate_avatar_url(author_avatar_url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # validate pairs format: each must be [str, str]
    if not isinstance(pairs, list):
        raise HTTPException(status_code=422, detail="pairs must be an array.")
    if len(pairs) > 200:
        raise HTTPException(status_code=422, detail="Too many pairs (max 200).")
    for p in pairs:
        if not (isinstance(p, list) and len(p) == 2 and isinstance(p[0], str) and isinstance(p[1], str)):
            raise HTTPException(status_code=422, detail="Each pair must be [slot_id, item_id].")

    validate_pairs(pairs, db_main)

    # The game won't equip a weapon with a required slot left empty, so neither do we publish one
    missing = missing_required(required_slots(db_main), gun_id, pairs)
    if missing:
        names = ",".join(sorted({name for _, _, name in missing}))
        raise HTTPException(status_code=422, detail="missing_required_parts:" + names)

    # reject if gun already has 500 community builds
    _COMMUNITY_BUILDS_LIMIT = 500
    existing_count = db.query(PublicBuild).filter(PublicBuild.gun_id == gun_id, PublicBuild.game.is_(None)).count()
    if existing_count >= _COMMUNITY_BUILDS_LIMIT:
        raise HTTPException(status_code=409, detail="community_builds_limit_reached")

    # compute total price: gun + all attachments
    all_ids = [gun_id] + [p[1] for p in pairs]
    price_rows = db_main.query(Item.id, Item.trader_price_rub).filter(Item.id.in_(all_ids)).all()
    total_price = sum(r[1] or 0 for r in price_rows) or None

    _ALLOWED_TAGS = {"meta", "budget", "cqb", "sniper", "recoil", "ergo", "pve", "beginner", "hybrid"}
    clean_tags = [t for t in (tags or []) if t in _ALLOWED_TAGS][:5]

    # stats is stored verbatim and echoed back to every client - cap its size
    stats_serialized = json.dumps(stats) if stats else None
    if stats_serialized and len(stats_serialized) > MAX_STATS_JSON_CHARS:
        raise HTTPException(status_code=422, detail="stats payload too large.")

    build = PublicBuild(
        gun_id=gun_id,
        gun_name=gun.name,
        build_name=name,
        pairs_json=json.dumps(pairs),
        ip_hash=client_hash,
        ip_snapshot=get_client_ip(request),
        author_id=None,
        is_admin_build=False,
        stats_json=stats_serialized,
        user_display_name=u_name or None,
        user_avatar_url=u_avatar or None,
        total_price_rub=total_price,
        ammo_id=ammo_id or None,
        tags_json=json.dumps(clean_tags) if clean_tags else None,
    )
    db.add(build)
    db.commit()
    db.refresh(build)

    _publish_last[client_hash] = now_mono

    # kick off image generation in the background - response returns immediately
    background_tasks.add_task(
        generate_and_save_build_image,
        build.id,
        gun_id,
        pairs,
    )

    return {"id": build.id, "published_at": build.published_at.isoformat()}


@router.get("/builds/mine")
def get_my_builds(
    x_client_id: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    if not x_client_id:
        return []
    client_hash = get_client_id_hash(x_client_id)

    rows = (
        db.query(PublicBuild)
        .filter(PublicBuild.ip_hash == client_hash, PublicBuild.game.is_(None))
        .order_by(PublicBuild.published_at.desc())
        .limit(100)
        .all()
    )
    if not rows:
        return []

    build_ids = [b.id for b in rows]

    count_rows = (
        db.query(BuildComment.build_id, func.count(BuildComment.id))
        .filter(BuildComment.build_id.in_(build_ids), BuildComment.is_deleted == False)
        .group_by(BuildComment.build_id)
        .all()
    )
    comment_counts = {bid: cnt for bid, cnt in count_rows}

    rating_rows = db.query(BuildRating).filter(BuildRating.build_id.in_(build_ids)).all()
    like_counts = {r.build_id: r.like_count for r in rating_rows}

    return [
        {
            "id": b.id,
            "gun_id": b.gun_id,
            "gun_name": b.gun_name,
            "build_name": b.build_name,
            "user_display_name": b.user_display_name,
            "user_avatar_url": b.user_avatar_url,
            "is_admin_build": False,
            "is_featured": b.is_featured,
            "published_at": b.published_at.isoformat(),
            "is_mine": True,
            "pairs": safe_json_loads(b.pairs_json),
            "stats": safe_json_loads(b.stats_json),
            "load_count": b.load_count or 0,
            "like_count": like_counts.get(b.id, 0),
            "comment_count": comment_counts.get(b.id, 0),
            "card_image_url": public_card_url(b.card_image_url),
            "ammo_id": b.ammo_id,
            "tags": safe_json_loads(b.tags_json) or [],
        }
        for b in rows
    ]


@router.get("/builds/public")
def get_public_builds(
    gun_id: str,
    x_client_id: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    if _community_builds_disabled:
        raise HTTPException(status_code=503, detail="community_builds_disabled")

    client_hash = get_optional_client_id_hash(x_client_id)

    rows = (
        db.query(PublicBuild, PublicBuildAuthor)
        .outerjoin(PublicBuildAuthor, PublicBuild.author_id == PublicBuildAuthor.id)
        .filter(PublicBuild.gun_id == gun_id, PublicBuild.game.is_(None))
        .order_by(PublicBuild.is_featured.desc(), PublicBuild.published_at.desc())
        .limit(500)
        .all()
    )

    build_ids = [b.id for b, _ in rows]
    comment_counts: dict[int, int] = {}
    if build_ids:
        count_rows = (
            db.query(BuildComment.build_id, func.count(BuildComment.id))
            .filter(BuildComment.build_id.in_(build_ids), BuildComment.is_deleted == False)
            .group_by(BuildComment.build_id)
            .all()
        )
        comment_counts = {bid: cnt for bid, cnt in count_rows}

    return [
        {
            "id": build.id,
            "gun_id": build.gun_id,
            "build_name": build.build_name,
            "author_display_name": author.display_name if author else None,
            "author_display_name_zh": author.display_name_zh if author else None,
            "author_avatar_url": author.avatar_url if author else None,
            "user_display_name": build.user_display_name,
            "user_avatar_url": build.user_avatar_url,
            "is_admin_build": build.is_admin_build,
            "is_featured": build.is_featured,
            "published_at": build.published_at.isoformat(),
            "is_mine": (client_hash is not None and build.ip_hash == client_hash),
            "pairs": safe_json_loads(build.pairs_json),
            "stats": safe_json_loads(build.stats_json),
            "total_price_rub": build.total_price_rub,
            "load_count": build.load_count or 0,
            "card_image_url": public_card_url(build.card_image_url),
            "ammo_id": build.ammo_id,
            "tags": safe_json_loads(build.tags_json) or [],
            "comment_count": comment_counts.get(build.id, 0),
        }
        for build, author in rows
    ]


# load-count cooldown: (client_ip, build_id) -> monotonic time of last counted load
_load_count_last: dict[tuple[str, int], float] = {}
_LOAD_COUNT_COOLDOWN = 60.0


@router.post("/builds/{build_id}/load")
def record_build_load(
    build_id: int,
    request: Request,
    db: Session = Depends(get_builds_db),
):
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")

    # Count at most one load per IP per build per cooldown window to deter
    # load-count inflation. Repeat loads still succeed, they just don't count.
    key = (get_client_ip(request), build_id)
    now_mono = time.monotonic()
    stale = [k for k, ts in _load_count_last.items() if now_mono - ts > _LOAD_COUNT_COOLDOWN * 2]
    for k in stale:
        del _load_count_last[k]
    if now_mono - _load_count_last.get(key, 0.0) >= _LOAD_COUNT_COOLDOWN:
        build.load_count = (build.load_count or 0) + 1
        db.commit()
        _load_count_last[key] = now_mono
    return {"load_count": build.load_count}


@router.delete("/builds/{build_id}")
def unlist_build(
    build_id: int,
    x_client_id: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    client_hash = get_client_id_hash(x_client_id)
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")
    if build.ip_hash != client_hash:
        raise HTTPException(status_code=403, detail="Not your build.")
    card_image_url = build.card_image_url
    drawings_json = build.drawings_json
    db.delete(build)
    db.commit()
    gitee_delete_image(card_image_url, build_id)
    # An Arena preset's weapon and helmet drawings
    delete_drawings(drawings_json, build_id)
    return {"unlisted": True, "build_id": build_id}


@router.get("/builds/notifications")
def get_notifications(
    x_client_id: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    client_hash = get_client_id_hash(x_client_id)

    notes = (
        db.query(PendingNotification)
        .filter(
            PendingNotification.ip_hash == client_hash,
            PendingNotification.delivered == False,
        )
        .all()
    )

    result = []
    for note in notes:
        result.append(
            {
                "type": note.type,
                "data": json.loads(note.data_json),
            }
        )
        note.delivered = True

    db.commit()
    return result


@router.get("/builds/ban-status")
def get_ban_status(x_client_id: str = Header(None), db: Session = Depends(get_builds_db)):
    client_hash = get_optional_client_id_hash(x_client_id)
    if not client_hash:
        return {"is_banned": False, "banned_until": None}
    ban = db.query(IPBan).filter(IPBan.ip_hash == client_hash).first()
    if not ban:
        return {"is_banned": False, "banned_until": None}
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if ban.banned_until is not None and ban.banned_until <= now:
        return {"is_banned": False, "banned_until": None}
    return {
        "is_banned": True,
        "banned_until": ban.banned_until.isoformat() + "Z" if ban.banned_until else None,
        "reason": ban.reason,
    }


@router.post("/admin/community-builds/disable")
def admin_disable_community_builds(request: Request, x_admin_key: str = Header(None)):
    global _community_builds_disabled
    require_admin(request, x_admin_key)
    _community_builds_disabled = True
    open(_COMMUNITY_BUILDS_LOCK_FILE, "w").close()
    return {"community_builds_enabled": False}


@router.post("/admin/community-builds/enable")
def admin_enable_community_builds(request: Request, x_admin_key: str = Header(None)):
    global _community_builds_disabled
    require_admin(request, x_admin_key)
    _community_builds_disabled = False
    if os.path.exists(_COMMUNITY_BUILDS_LOCK_FILE):
        os.remove(_COMMUNITY_BUILDS_LOCK_FILE)
    return {"community_builds_enabled": True}


@router.get("/admin/community-builds/status")
def admin_community_builds_status(request: Request, x_admin_key: str = Header(None)):
    require_admin(request, x_admin_key)
    return {"community_builds_enabled": not _community_builds_disabled}

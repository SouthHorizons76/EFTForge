"""Admin tools for community builds and their card images."""

import json
from datetime import datetime, timedelta, timezone
from typing import List

from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Header, Request
from sqlalchemy import func
from sqlalchemy.orm import Session

import build_images
from models_builds import BuildComment, BuildRating, BuildVote, PendingNotification, PublicBuild, PublicBuildAuthor
from models_items import Item
from routers.shared import get_builds_db, get_db, require_admin, sanitize_build_name, validate_pairs
from services.build_cards import (
    CARD_WAITING_PARTS,
    acquire_card_regen_lock,
    generate_and_save_build_image,
    regenerate_cards,
    start_card_migration,
)
from services.arena_drawings import delete_drawings
from services.gitee import GITEE_RAW_PREFIX, gitee_delete_image, gitee_wipe_build_images_folder

router = APIRouter()


@router.post("/admin/builds/retrigger-migrate")
async def admin_retrigger_migrate(
    request: Request,
    x_admin_key: str = Header(None),
):
    require_admin(request, x_admin_key)
    if not start_card_migration(force=True):
        return {"status": "already_running"}
    return {"status": "started"}


# ---------------------------------------------------
# Admin - Builds
# ---------------------------------------------------


@router.post("/admin/builds/publish")
def admin_publish_build(
    request: Request,
    x_admin_key: str = Header(None),
    gun_id: str = Body(...),
    build_name: str = Body(..., max_length=60),
    pairs: List[list] = Body(...),
    author_id: str | None = Body(default=None),
    stats: dict | None = Body(default=None),
    card_image_url: str | None = Body(default=None),
    ammo_id: str | None = Body(default=None),
    db: Session = Depends(get_builds_db),
    db_main: Session = Depends(get_db),
):
    require_admin(request, x_admin_key)

    gun = db_main.query(Item).filter(Item.id == gun_id, Item.is_weapon == True).first()
    if not gun:
        raise HTTPException(status_code=422, detail="Unknown gun_id.")

    name = sanitize_build_name(build_name)[:60]
    if not name:
        raise HTTPException(status_code=422, detail="build_name cannot be empty.")

    if author_id is not None:
        if not db.query(PublicBuildAuthor).filter(PublicBuildAuthor.id == author_id).first():
            raise HTTPException(status_code=422, detail="author_id not found.")

    if not isinstance(pairs, list):
        raise HTTPException(status_code=422, detail="pairs must be an array.")
    for p in pairs:
        if not (isinstance(p, list) and len(p) == 2 and isinstance(p[0], str) and isinstance(p[1], str)):
            raise HTTPException(status_code=422, detail="Each pair must be [slot_id, item_id].")

    validate_pairs(pairs, db_main)

    all_ids = [gun_id] + [p[1] for p in pairs]
    price_rows = db_main.query(Item.id, Item.trader_price_rub).filter(Item.id.in_(all_ids)).all()
    total_price = sum(r[1] or 0 for r in price_rows) or None

    build = PublicBuild(
        gun_id=gun_id,
        gun_name=gun.name,
        build_name=name,
        pairs_json=json.dumps(pairs),
        ip_hash="admin",
        ip_snapshot=None,
        author_id=author_id,
        is_admin_build=True,
        is_featured=True,
        stats_json=json.dumps(stats) if stats else None,
        total_price_rub=total_price,
        card_image_url=card_image_url,
        ammo_id=ammo_id or None,
    )
    db.add(build)
    db.commit()
    db.refresh(build)
    return {"id": build.id, "published_at": build.published_at.isoformat()}


@router.post("/admin/builds/{build_id}/feature")
def admin_feature_build(
    build_id: int,
    request: Request,
    x_admin_key: str = Header(None),
    card_image_url: str | None = Body(default=None),
    author_id: str | None = Body(default=None),
    db: Session = Depends(get_builds_db),
):
    require_admin(request, x_admin_key)
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")
    if author_id is not None:
        if not db.query(PublicBuildAuthor).filter(PublicBuildAuthor.id == author_id).first():
            raise HTTPException(status_code=422, detail="author_id not found.")
    build.is_featured = True
    if card_image_url is not None:
        build.card_image_url = card_image_url
    if author_id is not None:
        build.author_id = author_id
    db.commit()
    return {"id": build.id, "is_featured": True, "card_image_url": build.card_image_url, "author_id": build.author_id}


@router.post("/admin/builds/{build_id}/unfeature")
def admin_unfeature_build(
    build_id: int,
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    require_admin(request, x_admin_key)
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")
    build.is_featured = False
    if build.is_admin_build:
        build.card_image_url = None
        build.author_id = None
    db.commit()
    return {"id": build.id, "is_featured": False}


@router.get("/admin/builds/featured")
def admin_list_featured_builds(
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    require_admin(request, x_admin_key)
    rows = (
        db.query(PublicBuild, PublicBuildAuthor, BuildRating)
        .outerjoin(PublicBuildAuthor, PublicBuild.author_id == PublicBuildAuthor.id)
        .outerjoin(BuildRating, BuildRating.build_id == PublicBuild.id)
        .filter(PublicBuild.is_featured == True)
        .order_by(PublicBuild.is_rotating.desc(), PublicBuild.published_at.desc())
        .all()
    )
    return [
        {
            "id": b.id,
            "gun_id": b.gun_id,
            "gun_name": b.gun_name,
            "build_name": b.build_name,
            "author_id": b.author_id,
            "author_name": a.display_name if a else None,
            "published_at": b.published_at.isoformat(),
            "is_admin_build": b.is_admin_build,
            "is_rotating": b.is_rotating,
            "like_count": r.like_count if r else 0,
        }
        for b, a, r in rows
    ]


@router.post("/admin/builds/rotate-featured")
def admin_rotate_featured_builds(
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    require_admin(request, x_admin_key)

    # unfeature all builds currently in the rotation batch
    outgoing = db.query(PublicBuild).filter(PublicBuild.is_rotating == True).all()
    for b in outgoing:
        b.is_featured = False
        b.is_rotating = False

    two_weeks_ago = datetime.now(timezone.utc) - timedelta(weeks=2)

    # top 10 most-liked community builds by votes cast in the last 2 weeks
    already_featured_ids = {row[0] for row in db.query(PublicBuild.id).filter(PublicBuild.is_featured == True).all()}
    candidates = (
        db.query(PublicBuild, func.count(BuildVote.id).label("recent_likes"))
        .join(BuildVote, BuildVote.build_id == PublicBuild.id)
        .filter(
            BuildVote.created_at >= two_weeks_ago,
            BuildVote.vote == "like",
            PublicBuild.game.is_(None),
        )
        .group_by(PublicBuild.id)
        .order_by(func.count(BuildVote.id).desc())
        .limit(10 + len(already_featured_ids))  # over-fetch to skip already-featured
        .all()
    )

    incoming = []
    for build, like_count in candidates:
        if build.id in already_featured_ids:
            continue
        build.is_featured = True
        build.is_rotating = True
        incoming.append({"id": build.id, "build_name": build.build_name, "like_count": like_count})
        if len(incoming) == 10:
            break

    db.commit()
    return {
        "unfeatured": [{"id": b.id, "build_name": b.build_name} for b in outgoing],
        "featured": incoming,
    }


@router.post("/admin/builds/{build_id}/card-image")
def admin_set_card_image(
    build_id: int,
    request: Request,
    x_admin_key: str = Header(None),
    card_image_url: str | None = Body(default=None, embed=True),
    db: Session = Depends(get_builds_db),
):
    require_admin(request, x_admin_key)
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")
    build.card_image_url = card_image_url
    db.commit()
    return {"id": build.id, "card_image_url": build.card_image_url}


@router.post("/admin/builds/{build_id}/author")
def admin_set_build_author(
    build_id: int,
    request: Request,
    x_admin_key: str = Header(None),
    author_id: str | None = Body(default=..., embed=True),
    db: Session = Depends(get_builds_db),
):
    require_admin(request, x_admin_key)
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")
    if author_id is not None:
        if not db.query(PublicBuildAuthor).filter(PublicBuildAuthor.id == author_id).first():
            raise HTTPException(status_code=422, detail="author_id not found.")
    build.author_id = author_id
    db.commit()
    return {"id": build.id, "author_id": build.author_id}


@router.delete("/admin/builds/{build_id}")
def admin_delete_build(
    build_id: int,
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    require_admin(request, x_admin_key)
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")

    owner_hash = build.ip_hash
    build_name = build.build_name
    card_image_url = build.card_image_url
    drawings_json = build.drawings_json
    db.delete(build)

    # notify the owner (skip for admin-published builds)
    if owner_hash != "admin":
        db.add(
            PendingNotification(
                ip_hash=owner_hash,
                type="unlist",
                data_json=json.dumps({"build_name": build_name}),
            )
        )

    db.commit()
    gitee_delete_image(card_image_url, build_id)
    # An Arena preset's weapon and helmet drawings
    delete_drawings(drawings_json, build_id)
    return {"deleted": True, "build_id": build_id, "ip_hash": owner_hash}


@router.get("/admin/migration/status")
def admin_migration_status(
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    require_admin(request, x_admin_key)
    from config import GITEE_TOKEN, GITEE_DRY_RUN, DISABLE_BG_MIGRATE

    # Arena presets have no card picture to draw
    total = db.query(PublicBuild).filter(PublicBuild.game.is_(None)).count()
    migrated = db.query(PublicBuild).filter(PublicBuild.card_image_url.like(GITEE_RAW_PREFIX + "%")).count()
    errored = db.query(PublicBuild).filter(PublicBuild.card_image_url.like("error:%")).count()
    dry_run_count = db.query(PublicBuild).filter(PublicBuild.card_image_url.like("dryrun:%")).count()
    waiting_parts = db.query(PublicBuild).filter(PublicBuild.card_image_url == CARD_WAITING_PARTS).count()
    pending = total - migrated - errored - dry_run_count - waiting_parts

    return {
        "total": total,
        "migrated": migrated,
        "pending": pending,
        "errored": errored,
        # Retried on the next restart, once Kitbash! may draw every part.
        "waiting_parts": waiting_parts,
        "dry_run_processed": dry_run_count,
        "worker_disabled": DISABLE_BG_MIGRATE,
        "dry_run": GITEE_DRY_RUN,
        "token_set": bool(GITEE_TOKEN),
        "complete": pending == 0 and errored == 0 and waiting_parts == 0,
    }


@router.post("/admin/migration/reset")
def admin_migration_reset(
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    """Clears ALL auto-generated card image URLs so the migration worker
    re-processes every build from scratch on the next server restart."""
    require_admin(request, x_admin_key)
    count = (
        db.query(PublicBuild)
        .filter(
            PublicBuild.card_image_url.like(GITEE_RAW_PREFIX + "%")
            | PublicBuild.card_image_url.like("error:%")
            | PublicBuild.card_image_url.like("wait:%")
            | PublicBuild.card_image_url.like("dryrun:%")
        )
        .update({"card_image_url": None}, synchronize_session=False)
    )
    db.commit()
    return {"reset": count}


@router.post("/admin/migration/clear-errors")
def admin_migration_clear_errors(
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    require_admin(request, x_admin_key)
    count = (
        db.query(PublicBuild)
        .filter(PublicBuild.card_image_url.like("error:%") | PublicBuild.card_image_url.like("dryrun:%"))
        .update({"card_image_url": None}, synchronize_session=False)
    )
    db.commit()
    return {"cleared": count}


@router.post("/admin/migration/regenerate-image/{build_id}")
def admin_migration_regenerate_image(
    build_id: int,
    request: Request,
    background_tasks: BackgroundTasks,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    """Force-regenerate the card image for a single build.
    Bypasses DISABLE_BG_MIGRATE - always runs regardless of env config."""
    require_admin(request, x_admin_key)
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")
    if build.game is not None:
        raise HTTPException(status_code=422, detail="Arena presets have no card image.")
    pairs = json.loads(build.pairs_json)
    build.card_image_url = None
    db.commit()
    background_tasks.add_task(
        generate_and_save_build_image,
        build.id,
        build.gun_id,
        pairs,
    )
    return {"queued": True, "id": build_id}


@router.post("/admin/migration/regenerate-unsupported")
def admin_migration_regenerate_unsupported(
    request: Request,
    background_tasks: BackgroundTasks,
    include_errors: bool = False,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    """Redraw every community build card Kitbash! couldn't draw before (a weapon
    or parts it had no sprites for), after pulling a newer Kitbash! and
    restarting the server, since each worker loads Kitbash! once.
    include_errors also retries builds marked "error:" (upload failures and
    the like). Bypasses DISABLE_BG_MIGRATE. Progress: waiting_parts in
    /admin/migration/status counts down as cards are saved."""
    require_admin(request, x_admin_key)
    from config import GITEE_TOKEN, GITEE_DRY_RUN

    if not GITEE_TOKEN and not GITEE_DRY_RUN:
        raise HTTPException(status_code=503, detail="GITEE_TOKEN is not set.")
    if not build_images.loaded():
        raise HTTPException(status_code=503, detail="Kitbash! is not installed or failed to load.")

    marked = PublicBuild.card_image_url == CARD_WAITING_PARTS
    if include_errors:
        marked = marked | PublicBuild.card_image_url.like("error:%")
    build_ids = [
        row.id
        for row in db.query(PublicBuild.id).filter(marked).order_by(PublicBuild.is_featured.desc(), PublicBuild.id)
    ]
    if not build_ids:
        return {"queued": 0, "kitbash": build_images.version()}
    if not acquire_card_regen_lock():
        raise HTTPException(status_code=409, detail="A card regeneration batch is already running.")
    background_tasks.add_task(regenerate_cards, build_ids)
    return {"queued": len(build_ids), "kitbash": build_images.version()}


@router.post("/admin/builds/wipe-all")
def admin_wipe_all_builds(
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    """Delete every community build from the DB and wipe the Gitee build-images folder."""
    require_admin(request, x_admin_key)

    count = db.query(PublicBuild).count()

    db.query(PendingNotification).delete(synchronize_session=False)
    db.query(BuildVote).delete(synchronize_session=False)
    db.query(BuildRating).delete(synchronize_session=False)
    db.query(BuildComment).delete(synchronize_session=False)
    db.query(PublicBuild).delete(synchronize_session=False)
    db.commit()

    deleted_images = gitee_wipe_build_images_folder()

    return {"deleted_builds": count, "deleted_images": deleted_images}


@router.get("/admin/builds")
def admin_list_builds(
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    require_admin(request, x_admin_key)
    rows = db.query(PublicBuild).order_by(PublicBuild.published_at.desc()).all()
    return [
        {
            "id": b.id,
            "gun_id": b.gun_id,
            "gun_name": b.gun_name,
            "build_name": b.build_name,
            "author_id": b.author_id,
            "ip_hash": b.ip_hash,
            "ip_snapshot": b.ip_snapshot,
            "is_admin_build": b.is_admin_build,
            "published_at": b.published_at.isoformat(),
        }
        for b in rows
    ]

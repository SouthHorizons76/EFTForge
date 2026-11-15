"""Community build comments."""

import json
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Body, Depends, HTTPException, Header, Request
from sqlalchemy.orm import Session

from models_builds import BuildComment, PendingNotification, PublicBuild
from routers.shared import (
    check_client_ban,
    get_builds_db,
    get_client_id_hash,
    get_optional_client_id_hash,
    require_admin,
    sanitize_username,
    strip_html_tags,
)
from services.gitee import validate_avatar_url

router = APIRouter()


# comment rate limit: client_id_hash -> monotonic time of last successful comment
_comment_last: dict[str, float] = {}
_COMMENT_COOLDOWN = 60.0  # 1 minute


# ---------------------------------------------------
# Build Comments
# ---------------------------------------------------


@router.get("/builds/{build_id}/comments")
def get_build_comments(
    build_id: int,
    x_client_id: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")
    client_hash = get_optional_client_id_hash(x_client_id)
    rows = (
        db.query(BuildComment)
        .filter(BuildComment.build_id == build_id, BuildComment.is_deleted == False)
        .order_by(BuildComment.created_at.asc())
        .limit(100)
        .all()
    )
    return [
        {
            "id": r.id,
            "content": r.content,
            "created_at": r.created_at.isoformat(),
            "is_mine": (client_hash is not None and r.ip_hash == client_hash),
            "user_display_name": r.user_display_name,
            "user_avatar_url": r.user_avatar_url,
        }
        for r in rows
    ]


@router.post("/builds/{build_id}/comments")
def post_build_comment(
    build_id: int,
    request: Request,
    x_client_id: str = Header(None),
    content: str = Body(..., max_length=280),
    user_display_name: str | None = Body(default=None, max_length=30),
    user_avatar_url: str | None = Body(default=None),
    db: Session = Depends(get_builds_db),
):
    build = db.query(PublicBuild).filter(PublicBuild.id == build_id).first()
    if not build:
        raise HTTPException(status_code=404, detail="Build not found.")

    client_hash = get_client_id_hash(x_client_id)
    check_client_ban(client_hash, db)

    # Rate limit: 1 comment per 2 minutes
    now = time.monotonic()
    last = _comment_last.get(client_hash)
    if last is not None and now - last < _COMMENT_COOLDOWN:
        wait = int(_COMMENT_COOLDOWN - (now - last)) + 1
        raise HTTPException(status_code=429, detail=f"Please wait {wait}s before posting another comment.")

    cleaned = strip_html_tags(content).strip()
    if not cleaned:
        raise HTTPException(status_code=422, detail="Comment cannot be empty.")
    if len(cleaned) > 280:
        raise HTTPException(status_code=422, detail="Comment exceeds 280 characters.")

    c_name = sanitize_username(user_display_name) if user_display_name else None
    try:
        c_avatar = validate_avatar_url(user_avatar_url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    comment = BuildComment(
        build_id=build_id,
        ip_hash=client_hash,
        content=cleaned,
        created_at=datetime.now(timezone.utc).replace(tzinfo=None),
        user_display_name=c_name or None,
        user_avatar_url=c_avatar or None,
    )
    db.add(comment)
    db.flush()

    if build.ip_hash and client_hash != build.ip_hash:
        db.add(
            PendingNotification(
                ip_hash=build.ip_hash,
                type="new_comment",
                # The game tells the page which header button counts it: Builds, or Arena's Presets
                data_json=json.dumps({"build_id": build_id, "build_name": build.build_name, "game": build.game}),
                created_at=datetime.now(timezone.utc).replace(tzinfo=None),
                delivered=False,
            )
        )

    db.commit()
    db.refresh(comment)

    _comment_last[client_hash] = now
    return {
        "id": comment.id,
        "content": comment.content,
        "created_at": comment.created_at.isoformat(),
        "is_mine": True,
        "user_display_name": comment.user_display_name,
        "user_avatar_url": comment.user_avatar_url,
    }


@router.delete("/builds/{build_id}/comments/{comment_id}")
def delete_own_comment(
    build_id: int,
    comment_id: int,
    x_client_id: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    client_hash = get_client_id_hash(x_client_id)
    comment = (
        db.query(BuildComment)
        .filter(
            BuildComment.id == comment_id,
            BuildComment.build_id == build_id,
        )
        .first()
    )
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found.")
    if comment.is_deleted:
        raise HTTPException(status_code=404, detail="Comment not found.")
    if comment.ip_hash != client_hash:
        raise HTTPException(status_code=403, detail="You can only delete your own comments.")
    comment.is_deleted = True
    db.commit()
    return {"deleted": True, "id": comment_id}


@router.delete("/admin/builds/comments/{comment_id}")
def admin_delete_comment(
    comment_id: int,
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    require_admin(request, x_admin_key)
    comment = db.query(BuildComment).filter(BuildComment.id == comment_id).first()
    if not comment:
        raise HTTPException(status_code=404, detail="Comment not found.")
    comment.is_deleted = True
    db.commit()
    return {"deleted": True, "id": comment_id}


@router.get("/admin/builds/comments")
def admin_list_builds_with_comments(
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    require_admin(request, x_admin_key)
    rows = (
        db.query(BuildComment, PublicBuild)
        .join(PublicBuild, BuildComment.build_id == PublicBuild.id)
        .filter(BuildComment.is_deleted == False)
        .order_by(BuildComment.created_at.desc())
        .all()
    )
    builds: dict[int, dict] = {}
    for comment, build in rows:
        if build.id not in builds:
            builds[build.id] = {
                "build_id": build.id,
                "build_name": build.build_name,
                "gun_name": build.gun_name,
                "published_at": build.published_at.isoformat(),
                "comments": [],
            }
        builds[build.id]["comments"].append(
            {
                "id": comment.id,
                "content": comment.content,
                "created_at": comment.created_at.isoformat(),
            }
        )
    result = list(builds.values())
    for entry in result:
        entry["comment_count"] = len(entry["comments"])
    return result

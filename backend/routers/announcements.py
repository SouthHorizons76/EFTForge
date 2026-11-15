"""Server announcements shown in the app, and their admin endpoints.

The app polls GET /announcements every 30 seconds while it's visible, so a new one
reaches everyone within that. The answer must never sit in a cache (EdgeOne follows
our Cache-Control, and without one it may keep a stale list for minutes): it is
private, no-cache with an ETag, so browsers revalidate every poll and an unchanged
list costs a bodyless 304.
"""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Header, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from models_builds import ServerAnnouncement
from routers.shared import get_builds_db, require_admin

router = APIRouter()

ANNOUNCEMENTS_CACHE_CONTROL = "private, no-cache"


@router.get("/announcements")
def get_announcements(request: Request, db: Session = Depends(get_builds_db)):
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = (
        db.query(ServerAnnouncement)
        .filter((ServerAnnouncement.expires_at == None) | (ServerAnnouncement.expires_at > now))  # noqa: E711
        .order_by(ServerAnnouncement.created_at.desc())
        .all()
    )
    items = [
        {
            "id": r.id,
            "message": r.message,
            "level": r.level,
            "created_at": r.created_at.isoformat(),
            "expires_at": r.expires_at.isoformat() if r.expires_at else None,
            "dismissible": r.dismissible,
        }
        for r in rows
    ]
    body = json.dumps(items, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    etag = f'"{hashlib.sha256(body).hexdigest()[:32]}"'
    headers = {"Cache-Control": ANNOUNCEMENTS_CACHE_CONTROL, "ETag": etag}
    # nginx's gzip turns our ETag weak (W/"..."), so match it inside the header rather than exactly
    if etag in request.headers.get("if-none-match", ""):
        return Response(status_code=304, headers=headers)
    return Response(content=body, media_type="application/json", headers=headers)


# ---------------------------------------------------
# Admin - Announcements
# ---------------------------------------------------

_ANNOUNCEMENT_LEVEL_COLORS = {
    "info": "#4a90d9",
    "success": "#4CAF50",
    "warning": "#f5a623",
    "error": "#e74c3c",
    "critical": "#9b59b6",
}


@router.post("/admin/announcements")
def admin_create_announcement(
    request: Request,
    x_admin_key: str = Header(None),
    message: str = Body(...),
    level: Literal["info", "success", "warning", "error", "critical"] = Body(
        default="info",
        description=(
            "Toast accent color per level: "
            "info=#4a90d9 (blue), "
            "success=#4CAF50 (green), "
            "warning=#f5a623 (orange), "
            "error=#e74c3c (red, stays until dismissed), "
            "critical=#9b59b6 (purple, stays until dismissed)"
        ),
    ),
    expires_in_hours: int | None = Body(default=None),
    dismissible: bool = Body(
        default=True,
        description="When false, the toast cannot be dismissed by clicking - user must wait for it to expire or for an admin to delete it. Use for critical notices that must not be accidentally cleared.",
    ),
    db: Session = Depends(get_builds_db),
):
    """
    Post a toast announcement to all active users.

    **Choosing a level:**
    - **info** (blue) - Neutral updates: new content, features, patch notes, reminders.
    - **success** (green) - Positive news: a fix shipped, a requested feature landed, downtime resolved.
    - **warning** (orange) - Action advised: upcoming maintenance, known issue to watch out for, degraded service.
    - **error** (red) - Something is broken right now that affects users. Toast stays until dismissed.
    - **critical** (purple) - Urgent and severe: data loss risk, security issue, immediate action required. Toast stays until dismissed.

    **expires_in_hours:** leave null for a permanent announcement; set a value (e.g. 2) for time-sensitive ones that should auto-expire.

    **dismissible:** set to false to prevent users from clicking the toast away - useful for critical alerts you need everyone to see.
    """
    require_admin(request, x_admin_key)
    expires_at = None
    if expires_in_hours is not None:
        expires_at = datetime.now(timezone.utc) + timedelta(hours=expires_in_hours)
    row = ServerAnnouncement(message=message, level=level, expires_at=expires_at, dismissible=dismissible)
    db.add(row)
    db.commit()
    db.refresh(row)
    return {
        "id": row.id,
        "message": row.message,
        "level": row.level,
        "created_at": row.created_at.isoformat(),
        "expires_at": row.expires_at.isoformat() if row.expires_at else None,
        "dismissible": row.dismissible,
    }


@router.delete("/admin/announcements/{announcement_id}")
def admin_delete_announcement(
    announcement_id: int,
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    require_admin(request, x_admin_key)
    deleted = db.query(ServerAnnouncement).filter(ServerAnnouncement.id == announcement_id).delete()
    db.commit()
    if not deleted:
        raise HTTPException(status_code=404, detail="Announcement not found.")
    return {"deleted": True, "id": announcement_id}


@router.get("/admin/announcements")
def admin_list_announcements(
    request: Request,
    x_admin_key: str = Header(None),
    db: Session = Depends(get_builds_db),
):
    require_admin(request, x_admin_key)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    rows = db.query(ServerAnnouncement).order_by(ServerAnnouncement.created_at.desc()).all()
    return [
        {
            "id": r.id,
            "message": r.message,
            "level": r.level,
            "created_at": r.created_at.isoformat(),
            "expires_at": r.expires_at.isoformat() if r.expires_at else None,
            "is_active": r.expires_at is None or r.expires_at > now,
            "dismissible": r.dismissible,
        }
        for r in rows
    ]

"""User profile: avatar, display name, and account transfer."""

import base64
import hashlib
import hmac
import logging
import time

from fastapi import APIRouter, Body, Depends, HTTPException, Header, Request
from sqlalchemy.orm import Session

from config import IP_HASH_SECRET
from models_builds import BuildComment, PublicBuild
from routers.shared import CLIENT_ID_RE, check_client_ban, get_builds_db, get_client_id_hash, sanitize_username
from services.gitee import (
    AVATAR_COOLDOWN,
    GITEE_AVATAR_PREFIX,
    MAX_AVATAR_BYTES,
    process_and_upload_avatar,
    validate_avatar_url,
)

_logger = logging.getLogger(__name__)

router = APIRouter()


# account transfer rate limit
_transfer_last: dict[str, float] = {}
_TRANSFER_COOLDOWN = 60.0

# avatar upload rate limit
_avatar_last: dict[str, float] = {}

# username update rate limit
_username_last: dict[str, float] = {}
_USERNAME_COOLDOWN = 60.0


# ---------------------------------------------------
# User Profile
# ---------------------------------------------------


@router.post("/profile/avatar")
def upload_avatar(
    request: Request,
    x_client_id: str = Header(None),
    image_b64: str = Body(...),
    mime_type: str = Body("image/jpeg"),
    db: Session = Depends(get_builds_db),
):
    from config import GITEE_TOKEN, GITEE_DRY_RUN

    client_hash = get_client_id_hash(x_client_id)
    check_client_ban(client_hash, db)

    now_mono = time.monotonic()
    stale = [k for k, v in _avatar_last.items() if now_mono - v > AVATAR_COOLDOWN * 2]
    for k in stale:
        del _avatar_last[k]
    if client_hash in _avatar_last and now_mono - _avatar_last[client_hash] < AVATAR_COOLDOWN:
        wait = int(AVATAR_COOLDOWN - (now_mono - _avatar_last[client_hash])) + 1
        raise HTTPException(status_code=429, detail=f"Please wait {wait}s before uploading another avatar.")

    if not GITEE_TOKEN and not GITEE_DRY_RUN:
        raise HTTPException(status_code=503, detail="Avatar upload is not configured on this server.")

    try:
        raw_bytes = base64.b64decode(image_b64)
    except Exception:
        raise HTTPException(status_code=422, detail="Invalid base64 image data.")

    if len(raw_bytes) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail="Avatar image must be under 2 MB.")

    if GITEE_DRY_RUN:
        _avatar_last[client_hash] = now_mono
        dry_url = f"{GITEE_AVATAR_PREFIX}avatar_{client_hash[:20]}.jpg"
        return {"avatar_url": dry_url}

    try:
        avatar_url = process_and_upload_avatar(raw_bytes, client_hash)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        _logger.error("avatar-upload: failed for client %s: %s", client_hash[:8], exc)
        raise HTTPException(status_code=502, detail="Avatar upload to asset storage failed.")

    _avatar_last[client_hash] = now_mono
    return {"avatar_url": avatar_url}


@router.post("/profile/update")
def update_profile(
    x_client_id: str = Header(None),
    username: str | None = Body(default=None, max_length=30),
    avatar_url: str | None = Body(default=None),
    db: Session = Depends(get_builds_db),
):
    client_hash = get_client_id_hash(x_client_id)

    now_mono = time.monotonic()
    stale = [k for k, v in _username_last.items() if now_mono - v > _USERNAME_COOLDOWN * 2]
    for k in stale:
        del _username_last[k]
    if client_hash in _username_last and now_mono - _username_last[client_hash] < _USERNAME_COOLDOWN:
        wait = int(_USERNAME_COOLDOWN - (now_mono - _username_last[client_hash])) + 1
        raise HTTPException(status_code=429, detail=f"Please wait {wait}s before updating your profile again.")

    clean_name = sanitize_username(username) if username else None
    try:
        clean_avatar = validate_avatar_url(avatar_url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    builds = db.query(PublicBuild).filter(PublicBuild.ip_hash == client_hash, PublicBuild.is_admin_build == False).all()
    for b in builds:
        b.user_display_name = clean_name or None
        b.user_avatar_url = clean_avatar or None

    comments = db.query(BuildComment).filter(BuildComment.ip_hash == client_hash).all()
    for c in comments:
        c.user_display_name = clean_name or None
        c.user_avatar_url = clean_avatar or None

    db.commit()
    _username_last[client_hash] = now_mono
    return {"updated_builds": len(builds), "updated_comments": len(comments)}


@router.post("/profile/transfer/preview")
def transfer_preview(
    x_client_id: str = Header(None),
    old_uuid: str = Body(..., embed=True),
    db: Session = Depends(get_builds_db),
):
    current_hash = get_client_id_hash(x_client_id)
    old_uuid_clean = old_uuid.strip().lower()

    if not CLIENT_ID_RE.match(old_uuid_clean):
        raise HTTPException(status_code=400, detail="Invalid UUID format.")
    if old_uuid_clean == x_client_id.strip().lower():
        raise HTTPException(status_code=400, detail="That is your current UUID.")

    old_hash = hmac.new(IP_HASH_SECRET.encode(), old_uuid_clean.encode(), hashlib.sha256).hexdigest()

    old_builds = (
        db.query(PublicBuild).filter(PublicBuild.ip_hash == old_hash, PublicBuild.is_admin_build == False).count()
    )
    old_comments = db.query(BuildComment).filter(BuildComment.ip_hash == old_hash).count()
    cur_builds = (
        db.query(PublicBuild).filter(PublicBuild.ip_hash == current_hash, PublicBuild.is_admin_build == False).count()
    )
    cur_comments = db.query(BuildComment).filter(BuildComment.ip_hash == current_hash).count()

    return {
        "old_builds": old_builds,
        "old_comments": old_comments,
        "cur_builds": cur_builds,
        "cur_comments": cur_comments,
    }


@router.post("/profile/transfer")
def transfer_account(
    x_client_id: str = Header(None),
    old_uuid: str = Body(..., embed=True),
    username: str | None = Body(default=None, max_length=30),
    avatar_url: str | None = Body(default=None),
    db: Session = Depends(get_builds_db),
):
    current_hash = get_client_id_hash(x_client_id)

    now_mono = time.monotonic()
    stale = [k for k, v in _transfer_last.items() if now_mono - v > _TRANSFER_COOLDOWN * 2]
    for k in stale:
        del _transfer_last[k]
    if current_hash in _transfer_last and now_mono - _transfer_last[current_hash] < _TRANSFER_COOLDOWN:
        remaining = int(_TRANSFER_COOLDOWN - (now_mono - _transfer_last[current_hash]))
        raise HTTPException(status_code=429, detail=f"Rate limit: wait {remaining}s before transferring again.")

    old_uuid_clean = old_uuid.strip().lower()
    if not CLIENT_ID_RE.match(old_uuid_clean):
        raise HTTPException(status_code=400, detail="Invalid UUID format.")
    if old_uuid_clean == x_client_id.strip().lower():
        raise HTTPException(status_code=400, detail="That is your current UUID.")

    old_hash = hmac.new(IP_HASH_SECRET.encode(), old_uuid_clean.encode(), hashlib.sha256).hexdigest()

    transferred_builds = (
        db.query(PublicBuild)
        .filter(PublicBuild.ip_hash == old_hash, PublicBuild.is_admin_build == False)
        .update({"ip_hash": current_hash}, synchronize_session=False)
    )

    transferred_comments = (
        db.query(BuildComment)
        .filter(BuildComment.ip_hash == old_hash)
        .update({"ip_hash": current_hash}, synchronize_session=False)
    )

    # Apply the current account's profile to all records now under current_hash
    clean_name = sanitize_username(username) if username else None
    try:
        clean_avatar = validate_avatar_url(avatar_url)
    except ValueError:
        clean_avatar = None

    db.query(PublicBuild).filter(PublicBuild.ip_hash == current_hash, PublicBuild.is_admin_build == False).update(
        {"user_display_name": clean_name, "user_avatar_url": clean_avatar}, synchronize_session=False
    )

    db.query(BuildComment).filter(BuildComment.ip_hash == current_hash).update(
        {"user_display_name": clean_name, "user_avatar_url": clean_avatar}, synchronize_session=False
    )

    db.commit()
    _transfer_last[current_hash] = now_mono

    return {"transferred_builds": transferred_builds, "transferred_comments": transferred_comments}

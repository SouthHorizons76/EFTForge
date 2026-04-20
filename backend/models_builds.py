from datetime import datetime, timezone
from sqlalchemy import Column, Integer, String, DateTime, Boolean, Text, Index, ForeignKey, UniqueConstraint

from database_builds import BuildsBase


def _utcnow():
    return datetime.now(timezone.utc)


class PublicBuildAuthor(BuildsBase):
    __tablename__ = "public_build_authors"

    id              = Column(String, primary_key=True)   # admin-assigned slug, e.g. "shroud"
    display_name    = Column(String, nullable=False)
    display_name_zh = Column(String, nullable=True)
    avatar_url      = Column(String, nullable=True)


class PublicBuild(BuildsBase):
    __tablename__ = "public_builds"

    id             = Column(Integer, primary_key=True, autoincrement=True)
    gun_id         = Column(String, nullable=False)
    gun_name       = Column(String, nullable=False)
    build_name     = Column(String, nullable=False)      # sanitized, max 60 chars
    pairs_json     = Column(Text, nullable=False)        # JSON [[slot_id, item_id], ...]
    ip_hash        = Column(String, nullable=False)      # client_id_hash; named ip_hash for DB compat; never exposed
    ip_snapshot    = Column(String, nullable=True)       # raw client IP at publish time, for admin forensics only
    author_id      = Column(String, ForeignKey("public_build_authors.id"), nullable=True)
    published_at   = Column(DateTime, nullable=False, default=_utcnow)
    is_admin_build = Column(Boolean, nullable=False, default=False)
    is_featured    = Column(Boolean, nullable=False, default=False)  # any build can be featured by admin regardless of who published it
    is_rotating    = Column(Boolean, nullable=False, default=False)  # true when this build was promoted by the rotate-featured endpoint
    stats_json     = Column(Text, nullable=True)         # JSON {ergo,recoil_v,recoil_h,weight,eed,overswing,arm_stam}
    total_price_rub = Column(Integer, nullable=True)     # sum of all item trader_price_rub at publish time
    load_count      = Column(Integer, nullable=False, default=0)  # how many times any user has loaded this build
    card_image_url  = Column(String, nullable=True)      # optional custom card image (e.g. GitHub raw URL); overrides the default gun image
    ammo_id         = Column(String, nullable=True)      # selected ammo at save/publish time; restored on load

    __table_args__ = (
        Index("ix_public_builds_gun_id", "gun_id"),
    )


class IPBan(BuildsBase):
    __tablename__ = "ip_bans"

    ip_hash      = Column(String, primary_key=True)   # stores client_id_hash
    banned_at    = Column(DateTime, nullable=False, default=_utcnow)
    banned_until = Column(DateTime, nullable=True)    # None = permanent
    reason       = Column(String, nullable=True)


class PendingNotification(BuildsBase):
    __tablename__ = "pending_notifications"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    ip_hash    = Column(String, nullable=False)   # client_id_hash of the recipient
    type       = Column(String, nullable=False)   # "ban" | "unlist"
    data_json  = Column(Text, nullable=False)     # JSON payload
    created_at = Column(DateTime, nullable=False, default=_utcnow)
    delivered  = Column(Boolean, nullable=False, default=False)

    __table_args__ = (
        Index("ix_pending_notifications_ip_hash", "ip_hash"),
    )


class ServerAnnouncement(BuildsBase):
    __tablename__ = "server_announcements"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    message    = Column(String, nullable=False)
    level      = Column(String, nullable=False, default="info")  # "info" | "warning" | "error"
    created_at = Column(DateTime, nullable=False, default=_utcnow)
    expires_at = Column(DateTime, nullable=True)   # None = never expires


class BuildVote(BuildsBase):
    __tablename__ = "build_votes"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    build_id   = Column(Integer, nullable=False)
    ip_hash    = Column(String, nullable=False)  # HMAC-SHA256 hex, never raw IP
    vote       = Column(String, nullable=False)  # "like" or "dislike"
    created_at = Column(DateTime, nullable=False, default=_utcnow)

    __table_args__ = (
        UniqueConstraint("build_id", "ip_hash", name="uq_build_vote_build_ip"),
        Index("ix_build_vote_build_id", "build_id"),
    )


class BuildRating(BuildsBase):
    __tablename__ = "build_ratings"

    build_id      = Column(Integer, primary_key=True)
    like_count    = Column(Integer, nullable=False, default=0)
    dislike_count = Column(Integer, nullable=False, default=0)
    last_updated  = Column(DateTime, nullable=False, default=_utcnow)

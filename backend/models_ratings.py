from datetime import datetime, timezone

from sqlalchemy import Column, Integer, String, DateTime, UniqueConstraint, Index

from database_ratings import RatingsBase


class AttachmentVote(RatingsBase):
    __tablename__ = "attachment_votes"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    item_id    = Column(String, nullable=False)
    ip_hash    = Column(String, nullable=False)  # HMAC-SHA256 hex, never raw IP
    vote       = Column(String, nullable=False)  # "like" or "dislike"
    created_at = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))

    __table_args__ = (
        UniqueConstraint("item_id", "ip_hash", name="uq_vote_item_ip"),
        Index("ix_vote_item_id", "item_id"),
    )


class AttachmentRating(RatingsBase):
    __tablename__ = "attachment_ratings"

    item_id       = Column(String, primary_key=True)
    like_count    = Column(Integer, nullable=False, default=0)
    dislike_count = Column(Integer, nullable=False, default=0)
    last_updated  = Column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))

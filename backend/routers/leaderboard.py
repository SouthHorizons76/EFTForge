from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from models_builds import BuildRating, BuildVote, PublicBuild, PublicBuildAuthor
from models_items import Item
from models_ratings import AttachmentRating, AttachmentVote
from models_slot_allowed import SlotAllowedItem
from models_slots import Slot
from routers.shared import get_builds_db, get_db, get_ratings_db, public_card_url, safe_json_loads

router = APIRouter()


# ---------------------------------------------------
# Leaderboard
# ---------------------------------------------------


def _dense_rank(scores):
    """Return dense ranks for a descending-sorted list of scores.
    Tied scores share the same rank with no gaps: [50,50,50,30] -> [1,1,1,2]."""
    ranks = []
    rank = 0
    for i, score in enumerate(scores):
        if i == 0 or score != scores[i - 1]:
            rank += 1
        ranks.append(rank)
    return ranks


def _build_row_to_dict(rank, build, author, like_count):
    return {
        "rank": rank,
        "build_id": build.id,
        "build_name": build.build_name,
        "gun_id": build.gun_id,
        "gun_name": build.gun_name,
        "author_display_name": author.display_name if author else None,
        "author_display_name_zh": author.display_name_zh if author else None,
        "author_avatar_url": author.avatar_url if author else None,
        "user_display_name": build.user_display_name,
        "user_avatar_url": build.user_avatar_url,
        "like_count": like_count,
        "is_admin_build": build.is_admin_build,
        "is_featured": build.is_featured,
        "pairs": safe_json_loads(build.pairs_json),
        "stats": safe_json_loads(build.stats_json),
        "total_price_rub": build.total_price_rub,
        "card_image_url": public_card_url(build.card_image_url),
        "ammo_id": build.ammo_id,
    }


@router.get("/leaderboard/builds")
def get_leaderboard_builds(
    period: str = "2w",
    db: Session = Depends(get_builds_db),
):
    if period not in ("2w", "all"):
        raise HTTPException(status_code=400, detail='period must be "2w" or "all"')

    if period == "2w":
        two_weeks_ago = datetime.now(timezone.utc) - timedelta(weeks=2)
        rows = (
            db.query(PublicBuild, PublicBuildAuthor, func.count(BuildVote.id).label("trending_likes"))
            .join(BuildVote, BuildVote.build_id == PublicBuild.id)
            .outerjoin(PublicBuildAuthor, PublicBuild.author_id == PublicBuildAuthor.id)
            .filter(BuildVote.created_at >= two_weeks_ago, BuildVote.vote == "like", PublicBuild.game.is_(None))
            .group_by(PublicBuild.id)
            .order_by(func.count(BuildVote.id).desc())
            .limit(10)
            .all()
        )
        counts = [count for _, _, count in rows]
        ranks = _dense_rank(counts)
        return [_build_row_to_dict(ranks[i], build, author, count) for i, (build, author, count) in enumerate(rows)]
    else:
        rows = (
            db.query(PublicBuild, PublicBuildAuthor, BuildRating)
            .outerjoin(BuildRating, BuildRating.build_id == PublicBuild.id)
            .outerjoin(PublicBuildAuthor, PublicBuild.author_id == PublicBuildAuthor.id)
            .filter(BuildRating.like_count > 0, PublicBuild.game.is_(None))
            .order_by(BuildRating.like_count.desc())
            .limit(50)
            .all()
        )
        counts = [rating.like_count if rating else 0 for _, _, rating in rows]
        ranks = _dense_rank(counts)
        return [_build_row_to_dict(ranks[i], build, author, counts[i]) for i, (build, author, _) in enumerate(rows)]


@router.get("/leaderboard/attachments")
def get_leaderboard_attachments(
    period: str = "2w",
    sort: str = "likes",
    db: Session = Depends(get_ratings_db),
    db_main: Session = Depends(get_db),
):
    if period not in ("2w", "all"):
        raise HTTPException(status_code=400, detail='period must be "2w" or "all"')
    if sort not in ("likes", "dislikes"):
        raise HTTPException(status_code=400, detail='sort must be "likes" or "dislikes"')

    likes_label = func.sum(case((AttachmentVote.vote == "like", 1), else_=0))
    dislikes_label = func.sum(case((AttachmentVote.vote == "dislike", 1), else_=0))

    if period == "2w":
        two_weeks_ago = datetime.now(timezone.utc) - timedelta(weeks=2)
        order_expr = likes_label if sort == "likes" else dislikes_label
        rows = (
            db.query(
                AttachmentVote.item_id,
                likes_label.label("likes"),
                dislikes_label.label("dislikes"),
            )
            .filter(AttachmentVote.created_at >= two_weeks_ago)
            .group_by(AttachmentVote.item_id)
            .having(order_expr > 0)
            .order_by(order_expr.desc())
            .limit(20)
            .all()
        )
    else:
        order_col = AttachmentRating.like_count if sort == "likes" else AttachmentRating.dislike_count
        rows = (
            db.query(
                AttachmentRating.item_id,
                AttachmentRating.like_count.label("likes"),
                AttachmentRating.dislike_count.label("dislikes"),
            )
            .filter(order_col > 0)
            .order_by(order_col.desc())
            .limit(100)
            .all()
        )

    item_ids = [row.item_id for row in rows]
    items_map = {item.id: item for item in db_main.query(Item).filter(Item.id.in_(item_ids)).all()} if item_ids else {}

    # resolve most common slot_name for each item as its category
    category_map: dict[str, str] = {}
    if item_ids:
        slot_rows = (
            db_main.query(SlotAllowedItem.allowed_item_id, Slot.slot_name, func.count(SlotAllowedItem.id).label("cnt"))
            .join(Slot, Slot.id == SlotAllowedItem.slot_id)
            .filter(SlotAllowedItem.allowed_item_id.in_(item_ids))
            .group_by(SlotAllowedItem.allowed_item_id, Slot.slot_name)
            .all()
        )
        # keep highest count slot_name per item
        for item_id, slot_name, cnt in slot_rows:
            if item_id not in category_map or cnt > category_map.get("__cnt__" + item_id, 0):
                category_map[item_id] = slot_name
                category_map["__cnt__" + item_id] = cnt

    scores = [row.likes if sort == "likes" else row.dislikes for row in rows]
    ranks = _dense_rank(scores)

    return [
        {
            "rank": ranks[i],
            "item_id": row.item_id,
            "item_name": items_map[row.item_id].name if row.item_id in items_map else row.item_id,
            "item_name_zh": items_map[row.item_id].name_zh if row.item_id in items_map else None,
            "icon_link": items_map[row.item_id].icon_link if row.item_id in items_map else None,
            "like_count": row.likes,
            "dislike_count": row.dislikes,
            "item_category": category_map.get(row.item_id, None),
        }
        for i, row in enumerate(rows)
    ]

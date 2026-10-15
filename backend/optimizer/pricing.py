"""Picks the cheapest accessible offer for an item given trader loyalty levels,
flea access, and player level - ported from the reference optimizer's
get_available_price(), reading from EFTForge's own item_offers table instead
of a tarkov.dev-shaped offers list.
"""

DEFAULT_TRADER_LEVELS = {
    "prapor": 4,
    "skier": 4,
    "peacekeeper": 4,
    "mechanic": 4,
    "jaeger": 4,
    "ragman": 4,
    "ref": 4,
}

TRADER_DISABLED = 0


def get_best_price(
    offers: list, trader_levels: dict = None, flea_available: bool = True, player_level=None, game_mode: str = "pvp"
):
    """offers: list of dicts with vendor_normalized, trader_level, price, currency,
    price_rub, is_flea, min_level_flea, game_mode (the shape produced by loading
    ItemOffer rows).

    Returns a dict {price, currency, price_rub, vendor} for the cheapest offer the
    given player can actually access right now, or None if nothing is accessible.
    """
    if trader_levels is None:
        trader_levels = DEFAULT_TRADER_LEVELS

    best = None
    for offer in offers:
        if offer["is_flea"]:
            if not flea_available:
                continue
            # A null game_mode is pre-migration data synced before per-mode flea rows
            # existed - treat it as "pvp" rather than dropping it.
            if (offer.get("game_mode") or "pvp") != game_mode:
                continue
            min_level_flea = offer.get("min_level_flea")
            if player_level is not None and min_level_flea and min_level_flea > player_level:
                continue
        else:
            vendor = offer["vendor_normalized"]
            level = trader_levels.get(vendor, 4)
            if level == TRADER_DISABLED:
                continue
            required_level = offer.get("trader_level")
            if required_level is not None and required_level > level:
                continue

        price_rub = offer.get("price_rub")
        if price_rub is None:
            continue
        if best is None or price_rub < best["price_rub"]:
            best = {
                "price": offer.get("price"),
                "currency": offer.get("currency"),
                "price_rub": price_rub,
                "vendor": offer["vendor_normalized"],
            }

    return best


def is_level_locked(offers: list, flea_available: bool = True, player_level=None, game_mode: str = "pvp") -> bool:
    """True when the item has a priced flea offer whose min_level_flea exceeds
    player_level. Trader offers never count as locked: an item the player cannot
    buy at their current trader levels deliberately stays on the allow_unpriced
    path, matching the "Include unpriced parts" toggle's promise. Call this only
    after get_best_price() returned None, when no accessible offer exists at all.
    Unpriced rows (price_rub None) never count as locked either: a part with no
    priced offer stays "unpriced" and belongs to the solver's allow_unpriced path,
    not here.
    """
    for offer in offers:
        if offer.get("price_rub") is None:
            continue
        if not offer["is_flea"]:
            continue
        if not flea_available:
            continue
        if (offer.get("game_mode") or "pvp") != game_mode:
            continue
        min_level_flea = offer.get("min_level_flea")
        if min_level_flea and player_level is not None and min_level_flea > player_level:
            return True
    return False


def offers_by_item(item_offer_rows) -> dict:
    """Groups ItemOffer ORM rows into item_id -> [offer dict, ...]."""
    grouped: dict = {}
    for row in item_offer_rows:
        grouped.setdefault(row.item_id, []).append(
            {
                "vendor_normalized": row.vendor_normalized,
                "trader_level": row.trader_level,
                "price": row.price,
                "currency": row.currency,
                "price_rub": row.price_rub,
                "is_flea": row.is_flea,
                "min_level_flea": row.min_level_flea,
                "game_mode": row.game_mode,
            }
        )
    return grouped

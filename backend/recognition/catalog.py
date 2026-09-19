"""Match observed labels against a read-only snapshot of the item catalog."""

import re
import sqlite3
import unicodedata
from collections import defaultdict, deque
from difflib import SequenceMatcher
from pathlib import Path

from .panel import compare_stats

# Glyphs the recognizer confuses in the game's condensed label font, folded to one form.
CONFUSIONS = str.maketrans({"0": "o", "1": "i", "l": "i", "5": "s", "8": "b", "2": "z", "6": "g"})


# The inch mark in names like M-LOK 4.1" is read as a degree sign or an ordinal indicator.
# Strip that whole family first, because some of them survive the word-character filter.
INCH_MARKS = re.compile(r"[ª°º‘’“”′″'\"]+")


def normalize(text):
    # Strip before NFKC, which would otherwise fold the ordinal indicators into real letters.
    return re.sub(r"[^\w]+", "", unicodedata.normalize("NFKC", INCH_MARKS.sub("", text)).casefold())


def fold(text):
    return text.translate(CONFUSIONS)


def similarity(query, alias):
    # Compare the literal reading first so a clean match is never diluted, then retry with
    # confusable glyphs folded so GF-M0D3 can still reach GF MOD3.
    score = SequenceMatcher(None, query, alias).ratio()
    if score == 1.0:
        return score
    return max(score, SequenceMatcher(None, fold(query), fold(alias)).ratio())


class Catalog:
    def __init__(self, path):
        # Open explicitly read-only so a misspelled path cannot create an empty database.
        with sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True) as db:
            db.row_factory = sqlite3.Row
            self.items = {
                row["id"]: dict(row)
                for row in db.execute(
                    "SELECT id, name, short_name, name_zh, short_name_zh, is_weapon, icon_link FROM items"
                )
            }
            self.edges = [
                dict(row)
                for row in db.execute(
                    "SELECT s.id AS slot_id, s.parent_item_id, s.slot_name, a.allowed_item_id "
                    "FROM slots s JOIN slot_allowed_items a ON a.slot_id = s.id"
                )
            ]
        self.by_parent = defaultdict(list)
        self.by_item = defaultdict(list)
        for edge in self.edges:
            self.by_parent[edge["parent_item_id"]].append(edge)
            self.by_item[edge["allowed_item_id"]].append(edge)

    def reachable(self, weapon_id):
        seen = {weapon_id}
        queue = deque([weapon_id])
        while queue:
            for edge in self.by_parent[queue.popleft()]:
                child = edge["allowed_item_id"]
                if child not in seen:
                    seen.add(child)
                    queue.append(child)
        return seen - {weapon_id}

    def rank(self, text, ids, limit=5):
        query = normalize(text)
        if not query:
            return []
        ranked = []
        for item_id in sorted(ids):
            item = self.items[item_id]
            aliases = [normalize(item.get(key) or "") for key in ("short_name", "short_name_zh", "name", "name_zh")]
            score = max((similarity(query, alias) for alias in aliases if alias), default=0)
            if score >= 0.55:
                ranked.append(
                    {
                        "item_id": item_id,
                        "name": item["name"],
                        "short_name": item["short_name"],
                        "text_similarity": round(score, 4),
                        "icon_link": item["icon_link"],
                    }
                )
        return sorted(ranked, key=lambda row: (-row["text_similarity"], row["item_id"]))[:limit]


def resolve_weapon(catalog, text, weapon_id=None):
    weapons = {key for key, item in catalog.items.items() if item["is_weapon"]}
    weapon_candidates = catalog.rank(text, weapons)
    if weapon_id is not None and weapon_id not in weapons:
        raise ValueError("The supplied weapon ID is not a weapon in this catalog")
    if weapon_id is None and weapon_candidates:
        best = weapon_candidates[0]
        runner_up = weapon_candidates[1]["text_similarity"] if len(weapon_candidates) > 1 else 0
        unique_exact = best["text_similarity"] == 1.0 and runner_up < 1.0
        if unique_exact or (best["text_similarity"] >= 0.9 and best["text_similarity"] - runner_up >= 0.08):
            weapon_id = best["item_id"]
    return weapon_id, weapon_candidates


def analyze(catalog, observations, weapon_id=None):
    weapon_id, weapon_candidates = resolve_weapon(catalog, observations.get("weapon_text", ""), weapon_id)
    reachable = catalog.reachable(weapon_id) if weapon_id else set()
    cards = []
    for index, observation in enumerate(observations.get("cards", [])):
        label = observation.get("text", "")
        empty = normalize(label) == "none"
        candidates = [] if empty else catalog.rank(label, reachable)
        for candidate in candidates:
            candidate["possible_slots"] = [
                {key: edge[key] for key in ("slot_id", "parent_item_id", "slot_name")}
                for edge in catalog.by_item[candidate["item_id"]]
                if edge["parent_item_id"] in reachable | {weapon_id}
            ]
        cards.append(
            {
                **observation,
                "card_index": index,
                "status": "empty" if empty else ("candidates" if candidates else "unresolved"),
                "candidates": candidates,
            }
        )
    review_regions = []
    for region in observations.get("review_regions", []):
        fragments = [
            {**fragment, "candidates": catalog.rank(fragment.get("text", ""), reachable)}
            for fragment in region.get("fragments", [])
        ]
        review_regions.append({**region, "fragments": fragments})
    return {
        "schema_version": 2,
        "weapon_id": weapon_id,
        "weapon_candidates": weapon_candidates,
        "cards": cards,
        "review_regions": review_regions,
        "stats_panel": observations.get("stats_panel", {"status": "not_detected", "fields": {}}),
        "stat_comparison": compare_stats(observations.get("stats_panel", {})),
        "requires_review": True,
        "limitations": [
            "Text similarity is a ranking score, not a probability of correctness.",
            "Possible slots describe catalog reachability, not an installed or conflict-validated build.",
            "Hidden cards, duplicate instances, and missing adapters are not reconstructed.",
        ],
    }

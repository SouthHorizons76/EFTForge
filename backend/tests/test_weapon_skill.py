"""The weapon skill each weapon levels, as the checked-in SPT extract carries it.

The game ties weapon skills to item classes (SkillManager), not to tarkov.dev's handbook
categories, so a few guns level a skill their category doesn't suggest.
"""

import json
import os

from extract_spt_stats import WEAPON_SKILL_BY_PARENT, add_weapon_skills

_EXTRACT = os.path.join(os.path.dirname(__file__), "..", "spt_weapon_stats.json")


def _skills():
    with open(_EXTRACT, encoding="utf-8") as f:
        return {item_id: entry.get("WeaponSkill") for item_id, entry in json.load(f).items()}


def test_carbines_level_assault_rifles():
    skills = _skills()
    assert skills["5c07c60e0db834002330051f"] == "Assault"  # ADAR 2-15, an assault rifle class carbine
    assert skills["5dcbd56fdbd3d91b3e5468d5"] == "Assault"  # DT MDR 7.62x51


def test_revolver_class_guns_level_revolvers():
    skills = _skills()
    assert skills["60db29ce99594040e04c4a27"] == "Revolver"  # MTs-255-12, a "Shotgun" for tarkov.dev
    assert skills["6275303a9f372d6ea97f9ec7"] == "Revolver"  # Milkor M32A1


def test_add_weapon_skills_skips_classes_without_a_skill():
    data = {
        "gun": {"_parent": "5447b5e04bdc2d62278b4567"},  # Smg
        "launcher": {"_parent": "5447bedf4bdc2d87278b4568"},  # GrenadeLauncher: no weapon skill
    }
    out = add_weapon_skills({"gun": {}, "launcher": {}}, data)
    assert out == {"gun": {"WeaponSkill": "SMG"}, "launcher": {}}
    assert "5447bedf4bdc2d87278b4568" not in WEAPON_SKILL_BY_PARENT

"""A small made-up game data snapshot for the snapshot and Arena tests.

Nothing in here is real game data: the ids, names and numbers are invented, and only the
shape follows game_snapshot.py's format.
"""

ROOT = "0" * 23 + "1"


def _id(n: int) -> str:
    return f"{n:024x}"


# Class nodes
N_COMPOUND, N_WEAPON, N_RIFLE, N_PISTOL = _id(0x10), _id(0x11), _id(0x12), _id(0x13)
N_MOD, N_GEAR_MOD, N_MAGAZINE, N_FUNCTIONAL, N_SIGHTS, N_COLLIMATOR = (_id(0x20 + i) for i in range(6))
N_MASTER, N_BARREL, N_GRIP, N_MUZZLE, N_LAUNCHER = (_id(0x30 + i) for i in range(5))
N_AMMO, N_MEDS, N_KNIFE = _id(0x40), _id(0x41), _id(0x42)
N_EQUIPMENT, N_ARMORED, N_ARMOR, N_HEADWEAR, N_VEST, N_PLATE, N_BUILT_IN = (_id(0x50 + i) for i in range(7))

# Items
RIFLE, PISTOL = _id(0x100), _id(0x101)
GRIP_A, GRIP_B, BARREL, MAGAZINE, SIGHT, BRAKE, LAUNCHER = (_id(0x110 + i) for i in range(7))
ROUND_A, ROUND_B, GRENADE_ROUND = _id(0x120), _id(0x121), _id(0x122)
VEST, PLATE_A, PLATE_B, SOFT_INSERT, HELMET, CAP, RIG, KNIFE, MEDKIT = (_id(0x130 + i) for i in range(9))
NOT_IN_ARMORY = _id(0x140)

# Slots
S_GRIP, S_BARREL, S_MAG, S_SIGHT, S_MUZZLE, S_LAUNCHER = (_id(0x200 + i) for i in range(6))
S_VEST_SOFT, S_VEST_FRONT = _id(0x210), _id(0x211)

PRESET = _id(0x300)
# BlastGang's shop: the presets its rifle and vest are sold as, and the shop's items
SHOP_RIFLE_PRESET, SHOP_VEST_PRESET = _id(0x310), _id(0x311)
SHOP_RIFLE, SHOP_VEST, SHOP_GONE = _id(0x320), _id(0x321), _id(0x322)
CLASS_ASSAULT = "632f8229f6541cacd808452c"
CLASS_MARKSMAN = "632f8e11f6541cacd808452e"
CATEGORY_RIFLES = _id(0x400)


def _node(name: str, parent: str) -> dict:
    return {"_name": name, "_parent": parent, "_type": "Node", "_props": {}}


def _item(name: str, parent: str, **props) -> dict:
    return {"_name": name, "_parent": parent, "_type": "Item", "_props": props}


def _slot(slot_id: str, name: str, parent: str, allowed: list, required: bool = False, **filter_extra) -> dict:
    return {
        "_id": slot_id,
        "_name": name,
        "_parent": parent,
        "_required": required,
        "_props": {"filters": [{"Filter": allowed, **filter_extra}]},
    }


def make_snapshot() -> dict:
    items = {
        ROOT: {"_name": "Item", "_parent": "", "_type": "Node", "_props": {}},
        N_COMPOUND: _node("CompoundItem", ROOT),
        N_WEAPON: _node("Weapon", N_COMPOUND),
        N_RIFLE: _node("AssaultRifle", N_WEAPON),
        N_PISTOL: _node("Pistol", N_WEAPON),
        N_MOD: _node("Mod", N_COMPOUND),
        N_GEAR_MOD: _node("GearMod", N_MOD),
        N_MAGAZINE: _node("Magazine", N_GEAR_MOD),
        N_LAUNCHER: _node("Launcher", N_GEAR_MOD),
        N_FUNCTIONAL: _node("FunctionalMod", N_MOD),
        N_SIGHTS: _node("Sights", N_FUNCTIONAL),
        N_COLLIMATOR: _node("Collimator", N_SIGHTS),
        N_MUZZLE: _node("FlashHider", N_FUNCTIONAL),
        N_MASTER: _node("MasterMod", N_MOD),
        N_BARREL: _node("Barrel", N_MASTER),
        N_GRIP: _node("PistolGrip", N_MASTER),
        N_AMMO: _node("Ammo", ROOT),
        N_MEDS: _node("Meds", ROOT),
        N_KNIFE: _node("Knife", ROOT),
        N_EQUIPMENT: _node("Equipment", N_COMPOUND),
        N_ARMORED: _node("ArmoredEquipment", N_EQUIPMENT),
        N_ARMOR: _node("Armor", N_ARMORED),
        N_HEADWEAR: _node("Headwear", N_ARMORED),
        N_PLATE: _node("ArmorPlate", N_ARMORED),
        N_BUILT_IN: _node("BuiltInInserts", N_PLATE),
        N_VEST: _node("Vest", N_COMPOUND),
        RIFLE: _item(
            "weapon_test_rifle",
            N_RIFLE,
            Weight=3.0,
            Ergonomics=50,
            BackgroundColor="black",
            ammoCaliber="CaliberTest",
            SightingRange=100,
            RecoilForceUp=120,
            RecoilForceBack=300,
            CenterOfImpact=0.02,
            CameraSnap=3.5,
            DeviationCurve=1.3,
            DeviationMax=20,
            RecoilAngle=90,
            RecoilCamera=0.05,
            RecolDispersion=10,
            bFirerate=700,
            Velocity=1.5,
            defAmmo=ROUND_A,
            ProgressRecoilAngleOnStable={"x": 0, "y": 28},
            RecoilCenter={"x": 0, "y": -0.25, "z": 0.1},
            ArenaMetapoints=1000,
            ArenaClassAvailability=[CLASS_ASSAULT],
            MetascoreGroup="Firepower",
            weapUseType="primary",
            Slots=[
                _slot(S_GRIP, "mod_pistol_grip", RIFLE, [N_GRIP], required=True),
                _slot(S_BARREL, "mod_barrel", RIFLE, [BARREL]),
                _slot(S_MAG, "mod_magazine", RIFLE, [MAGAZINE]),
                _slot(S_SIGHT, "mod_scope", RIFLE, [SIGHT, NOT_IN_ARMORY]),
                _slot(S_LAUNCHER, "mod_launcher", RIFLE, [LAUNCHER]),
            ],
        ),
        PISTOL: _item(
            "weapon_test_pistol",
            N_PISTOL,
            Weight=0.8,
            Ergonomics=80,
            ammoCaliber="CaliberTest",
            RecoilForceUp=200,
            RecoilForceBack=250,
            # A class instead of a round, as flare guns have
            defAmmo=N_AMMO,
            ArenaMetapoints=300,
            ArenaClassAvailability=[],
            weapUseType="secondary",
        ),
        GRIP_A: _item(
            "grip_a", N_GRIP, Weight=0.1, Ergonomics=8, Recoil=-1, ArenaMetapoints=100, ConflictingItems=[S_SIGHT]
        ),
        GRIP_B: _item(
            "grip_b",
            N_GRIP,
            Weight=0.12,
            Ergonomics=10,
            Recoil=0,
            HeatFactor=1,
            ArenaMetapoints=150,
            ArenaClassAvailability=[CLASS_MARKSMAN],
        ),
        BARREL: _item(
            "barrel",
            N_BARREL,
            Weight=0.6,
            Ergonomics=-5,
            Recoil=-3,
            Accuracy=2,
            CenterOfImpact=0.03,
            DeviationCurve=1.1,
            DeviationMax=18,
            HeatFactor=0.95,
            CoolFactor=1.05,
            DurabilityBurnModificator=1,
            Velocity=-2,
            Loudness=5,
            ArenaMetapoints=200,
            ConflictingItems=[N_GRIP],
            Slots=[_slot(S_MUZZLE, "mod_muzzle", BARREL, [BRAKE])],
        ),
        MAGAZINE: _item(
            "magazine",
            N_MAGAZINE,
            Weight=0.15,
            Ergonomics=-2,
            Recoil=-9,
            ArenaMetapoints=130,
            Width=1,
            Height=2,
            Cartridges=[
                {
                    "_id": _id(0x220),
                    "_name": "cartridges",
                    "_max_count": 30,
                    "_props": {"filters": [{"Filter": [ROUND_A]}]},
                }
            ],
        ),
        SIGHT: _item(
            "sight",
            N_COLLIMATOR,
            Weight=0.2,
            Ergonomics=-1,
            Recoil=0,
            SightingRange=200,
            Loudness=0,
            Velocity=0,
            ArenaMetapoints=260,
        ),
        BRAKE: _item("brake", N_MUZZLE, Weight=0.05, Ergonomics=-2, Recoil=-8, Loudness=12, ArenaMetapoints=160),
        LAUNCHER: _item(
            "launcher",
            N_LAUNCHER,
            Weight=1.4,
            Ergonomics=-10,
            Recoil=0,
            ArenaMetapoints=500,
            Chambers=[
                {"_id": _id(0x221), "_name": "patron_in_weapon", "_props": {"filters": [{"Filter": [GRENADE_ROUND]}]}}
            ],
        ),
        ROUND_A: _item(
            "round_a",
            N_AMMO,
            Weight=0.012,
            Caliber="CaliberTest",
            Damage=50,
            PenetrationPower=40,
            PenetrationChanceObstacle=0.5,
            ArmorDamage=45,
            InitialSpeed=900,
            ammoAccr=-5,
            ammoRec=5,
            ammoType="bullet",
            StackMaxSize=60,
            HeatFactor=1.5,
            DurabilityBurnModificator=1.2,
            ArenaMetapoints=12.5,
        ),
        ROUND_B: _item(
            "round_b", N_AMMO, Weight=0.012, Caliber="CaliberTest", Damage=60, PenetrationPower=20, ArenaMetapoints=5
        ),
        GRENADE_ROUND: _item(
            "grenade_round", N_AMMO, Weight=0.2, Caliber="CaliberTestGrenade", Damage=100, ArenaMetapoints=0
        ),
        SOFT_INSERT: _item(
            "soft_insert",
            N_BUILT_IN,
            Weight=0,
            armorClass="2",
            Durability=40,
            MaxDurability=40,
            ArmorMaterial="Aramid",
            ArmorType="Light",
            BluntThroughput=0.3,
            ArenaMetapoints=1,
        ),
        VEST: _item(
            "vest",
            N_ARMOR,
            Weight=4.0,
            speedPenaltyPercent=-6,
            mousePenalty=-2,
            weaponErgonomicPenalty=-3,
            ArenaMetapoints=400,
            MetascoreGroup="Defence",
            Slots=[
                _slot(
                    S_VEST_SOFT,
                    "Soft_armor_front",
                    VEST,
                    [SOFT_INSERT],
                    Plate=SOFT_INSERT,
                    locked=True,
                    armorColliders=["RibcageUp"],
                    armorPlateColliders=[],
                ),
                _slot(
                    S_VEST_FRONT,
                    "Front_plate",
                    VEST,
                    [PLATE_A, PLATE_B],
                    Plate=PLATE_A,
                    locked=False,
                    armorColliders=[],
                    armorPlateColliders=["Plate_Granit_SAPI_chest"],
                    bluntDamageReduceFromSoftArmor=True,
                ),
            ],
        ),
        PLATE_A: _item(
            "plate_a",
            N_PLATE,
            Weight=2.0,
            armorClass=4,
            Durability=45,
            MaxDurability=45,
            ArmorMaterial="Ceramic",
            BluntThroughput=0.2,
            ArenaMetapoints=770,
        ),
        PLATE_B: _item(
            "plate_b",
            N_PLATE,
            Weight=2.6,
            armorClass=5,
            Durability=50,
            MaxDurability=50,
            ArmorMaterial="Titan",
            BluntThroughput=0.15,
            ArenaMetapoints=1200,
        ),
        HELMET: _item(
            "helmet",
            N_HEADWEAR,
            Weight=1.2,
            armorClass=3,
            Durability=30,
            MaxDurability=30,
            ArmorMaterial="UHMWPE",
            BluntThroughput=0.25,
            armorColliders=["ParietalHead"],
            BlocksEyewear=True,
            ArenaMetapoints=430,
        ),
        # Worn gear without armor still says what it keeps off, as the game's face covers do,
        # and what it can't be worn next to: the vest's built-in section (never empty) and its
        # plate slot (only while it holds a plate)
        CAP: _item(
            "cap",
            N_HEADWEAR,
            Weight=0.1,
            BlocksHeadwear=False,
            BlocksEyewear=True,
            BlocksEarpiece=True,
            BlocksFaceCover=False,
            ConflictingItems=[S_VEST_SOFT, S_VEST_FRONT],
            ArenaMetapoints=1,
        ),
        RIG: _item(
            "rig",
            N_VEST,
            Weight=0.9,
            ArenaMetapoints=180,
            MetascoreGroup="Utility",
            Width=3,
            Height=3,
            Grids=[
                {"_id": _id(0x230), "_name": "1", "_props": {"cellsH": 1, "cellsV": 2, "filters": []}},
                {"_id": _id(0x231), "_name": "2", "_props": {"cellsH": 2, "cellsV": 2, "filters": []}},
            ],
        ),
        KNIFE: _item("knife", N_KNIFE, Weight=0.2, ArenaMetapoints=1),
        MEDKIT: _item("medkit", N_MEDS, Weight=0.1, ArenaMetapoints=51, Width=1, Height=1),
        NOT_IN_ARMORY: _item("not_in_armory", N_COLLIMATOR, Weight=0.3, Ergonomics=-3, Recoil=0, ArenaMetapoints=900),
    }
    names = {
        RIFLE: ("Test rifle", "TR-1", "测试步枪", "TR-1"),
        PISTOL: ("Test pistol", "TP-1", "测试手枪", "TP-1"),
        GRIP_A: ("Grip A", "GA", "握把A", "GA"),
        GRIP_B: ("Grip B", "GB", "握把B", "GB"),
        BARREL: ("Barrel", "BRL", "枪管", "BRL"),
        MAGAZINE: ("Magazine", "MAG", "弹匣", "MAG"),
        SIGHT: ("Sight", "SGT", "瞄具", "SGT"),
        BRAKE: ("Brake", "BRK", "制退器", "BRK"),
        LAUNCHER: ("Launcher", "LCH", "榴弹发射器", "LCH"),
        ROUND_A: ("Round A", "RA", "子弹A", "RA"),
        ROUND_B: ("Round B", "RB", "子弹B", "RB"),
        GRENADE_ROUND: ("Grenade round", "GR", "榴弹", "GR"),
        SOFT_INSERT: ("Soft insert", "", "软甲", ""),
        VEST: ("Vest", "VST", "护甲", "VST"),
        PLATE_A: ("Plate A", "PA", "插板A", "PA"),
        PLATE_B: ("Plate B", "PB", "插板B", "PB"),
        HELMET: ("Helmet", "HLM", "头盔", "HLM"),
        CAP: ("Cap", "CAP", "帽子", "CAP"),
        RIG: ("Rig", "RIG", "胸挂", "RIG"),
        KNIFE: ("Knife", "KNF", "刀", "KNF"),
        MEDKIT: ("Medkit", "MED", "医疗包", "MED"),
        NOT_IN_ARMORY: ("Not in armory", "NIA", "不在军械库", "NIA"),
    }
    en = {
        "MOD_PISTOL_GRIP": "PISTOL GRIP",
        "MOD_BARREL": "BARREL",
        "MOD_MAGAZINE": "MAGAZINE",
        "MOD_SCOPE": "SCOPE",
        "MOD_MUZZLE": "MUZZLE",
    }
    en.update(
        {
            "EArenaPresetClass/Assault": "Assault",
            "EArenaPresetClass/Marksman": "Marksman",
            CATEGORY_RIFLES: "Assault rifles",
        }
    )
    zh = {"EArenaPresetClass/Assault": "突击", "EArenaPresetClass/Marksman": "狙击", CATEGORY_RIFLES: "突击步枪"}
    for item_id, (name, short, name_zh, short_zh) in names.items():
        en[f"{item_id} Name"], en[f"{item_id} ShortName"] = name, short
        zh[f"{item_id} Name"], zh[f"{item_id} ShortName"] = name_zh, short_zh

    armory_ids = [i for i in names if i != NOT_IN_ARMORY]
    armory = [
        {
            "id": _id(0x500 + n),
            "templateId": item_id,
            "handbookCategoryId": CATEGORY_RIFLES if item_id == RIFLE else "",
            "isUnlockedByDefault": item_id in (RIFLE, GRIP_A),
            "excludedMods": [],
            "excludedAmmo": [],
        }
        for n, item_id in enumerate(armory_ids)
    ]
    entry_of = {entry["templateId"]: entry["id"] for entry in armory}
    # A class may not put grip B on the rifle, nor load round B into it
    rifle_entry = next(e for e in armory if e["templateId"] == RIFLE)
    rifle_entry["excludedMods"] = [{"presetClassId": CLASS_ASSAULT, "items": [entry_of[GRIP_B], "f" * 24]}]
    rifle_entry["excludedAmmo"] = [{"presetClassId": CLASS_ASSAULT, "items": [entry_of[ROUND_B]]}]

    def inv(n, tpl, parent=None, slot=None, count=None):
        row = {"_id": _id(0x600 + n), "_tpl": tpl}
        if parent is not None:
            row["parentId"], row["slotId"] = _id(0x600 + parent), slot
        if count:
            row["upd"] = {"StackObjectsCount": count}
        return row

    stock_preset = {
        "id": _id(0x700),
        "name": "1. Test_Base",
        "typeId": CLASS_ASSAULT,
        "inventory": {
            "items": [
                inv(0, _id(0x7FF)),
                inv(1, RIFLE, 0, "FirstPrimaryWeapon"),
                inv(2, GRIP_A, 1, "mod_pistol_grip"),
                inv(3, MAGAZINE, 1, "mod_magazine"),
                inv(4, ROUND_A, 3, "cartridges", 30),
                inv(5, VEST, 0, "ArmorVest"),
                inv(6, SOFT_INSERT, 5, "soft_armor_front"),
                inv(7, PLATE_A, 5, "front_plate"),
                inv(8, _id(0x7FE), 0, "Pockets"),
                inv(9, MEDKIT, 8, "pocket1"),
                # The stash, which is no part of the preset
                inv(10, _id(0x7FD)),
                inv(11, KNIFE, 10, "hideout"),
            ]
        },
    }
    return {
        "format": 1,
        "game": "arena",
        "version": "0.0.0.1",
        "id": "abc1234",
        "detected": "2026-01-01T00:00:00+00:00",
        "items": items,
        "locale": {"en": en, "ch": zh},
        "presets": {
            PRESET: {
                "_name": "test_rifle_default",
                "_encyclopedia": RIFLE,
                "_items": [
                    {"_id": "a", "_tpl": RIFLE},
                    {"_id": "b", "_tpl": GRIP_A, "parentId": "a", "slotId": "mod_pistol_grip"},
                    {"_id": "c", "_tpl": BARREL, "parentId": "a", "slotId": "mod_barrel"},
                    {"_id": "d", "_tpl": BRAKE, "parentId": "c", "slotId": "mod_muzzle"},
                    {"_id": "e", "_tpl": NOT_IN_ARMORY, "parentId": "a", "slotId": "mod_scope"},
                ],
            }
        },
        "arena": {
            "classes": [
                {"_id": CLASS_ASSAULT, "name": "x"},
                {"_id": CLASS_MARKSMAN, "name": "y"},
                {"_id": _id(0x900), "name": "collection"},
            ],
            "boundaries": [
                {"PresetClass": "Assault", "MetascoreMin": 7500, "MetascoreMax": 10000},
                {"PresetClass": "Marksman", "MetascoreMin": 7000, "MetascoreMax": 9500},
            ],
            "presets": [
                stock_preset,
                {"id": _id(0x701), "name": "collection", "typeId": _id(0x900), "inventory": {"items": []}},
                {
                    "id": _id(0x702),
                    "name": "BGAttack",
                    "typeId": _id(0x900),
                    "gameMode": "BlastGang",
                    "inventory": {
                        "items": [inv(20, _id(0x7FC)), inv(21, PISTOL, 20, "Holster"), inv(22, KNIFE, 20, "Scabbard")]
                    },
                },
            ],
            "armory": armory,
            "blast_gang": {
                "slots": {"UberGun": 3, "Armor": 2, "Ulta": 0},
                "items": [
                    {
                        "id": SHOP_RIFLE,
                        "systemName": "TEST_RIFLE",
                        "templateId": SHOP_RIFLE_PRESET,
                        "nodeTemplateId": RIFLE,
                        "type": "UberGun",
                        "prices": {"fighter": 3000, "defence": 0},
                        "settings": {
                            "metaScoreMin": 1000,
                            "metaScoreMax": 2000,
                            "ammoTemplateId": ROUND_A,
                            "additionalAmmoAmount": 3,
                            "isMagazine": True,
                        },
                        "excludedMods": [GRIP_B, NOT_IN_ARMORY],
                        "isStarterLot": True,
                        "isSlotAvailable": True,
                    },
                    {
                        "id": SHOP_VEST,
                        "systemName": "TEST_VEST",
                        "templateId": SHOP_VEST_PRESET,
                        "nodeTemplateId": VEST,
                        "type": "Armor",
                        "prices": {"fighter": 300, "defence": 300},
                        "settings": {},
                        "requiresArmoryUnlock": True,
                        "isSlotAvailable": False,
                    },
                    # Sold as an item Arena's armory doesn't have: left out
                    {"id": SHOP_GONE, "type": "Pistol", "templateId": NOT_IN_ARMORY, "nodeTemplateId": NOT_IN_ARMORY},
                ],
                "presets": {
                    SHOP_RIFLE_PRESET: {
                        "_name": "BG_test_rifle",
                        "_parent": "r",
                        "_items": [
                            {"_id": "r", "_tpl": RIFLE},
                            {"_id": "g", "_tpl": GRIP_A, "parentId": "r", "slotId": "mod_pistol_grip"},
                            {"_id": "b", "_tpl": BARREL, "parentId": "r", "slotId": "mod_barrel"},
                            {"_id": "m", "_tpl": BRAKE, "parentId": "b", "slotId": "mod_muzzle"},
                            {"_id": "s", "_tpl": NOT_IN_ARMORY, "parentId": "r", "slotId": "mod_scope"},
                            {"_id": "q", "_tpl": MAGAZINE, "parentId": "r", "slotId": "mod_magazine"},
                            {"_id": "c", "_tpl": ROUND_A, "parentId": "q", "slotId": "cartridges"},
                        ],
                    },
                    SHOP_VEST_PRESET: {
                        "_name": "BG_test_vest",
                        "_parent": "v",
                        "_items": [
                            {"_id": "v", "_tpl": VEST},
                            {"_id": "i", "_tpl": SOFT_INSERT, "parentId": "v", "slotId": "soft_armor_front"},
                            {"_id": "p", "_tpl": PLATE_A, "parentId": "v", "slotId": "front_plate"},
                        ],
                    },
                },
            },
        },
    }

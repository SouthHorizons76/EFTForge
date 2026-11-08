// What each skill does at a given level, and its text in English and Chinese, matching the
// game's own skill tooltips. Per buff: id (also its text's key), t (S always shown, E only at
// elite, W always shown and marked elite at elite, P hidden at elite), k (the value each level
// adds, up to level 50), b (a value it starts from), cap (the most it reaches) and e (its value
// at elite where that differs; true for an elite bonus that is simply on).
EFTForge.atlasSkillBuffs = {
 "skills": {
  "Endurance": [
   {
    "id": "EnduranceBuffEnduranceInc",
    "t": "W",
    "k": 0.01,
    "e": 0.7
   },
   {
    "id": "EnduranceHands",
    "t": "E",
    "e": true
   },
   {
    "id": "EnduranceBuffJumpCostRed",
    "t": "S",
    "k": 0.006
   },
   {
    "id": "EnduranceBuffBreathTimeInc",
    "t": "S",
    "k": 0.02
   },
   {
    "id": "EnduranceBuffRestorationTimeRed",
    "t": "P",
    "k": 0.01,
    "e": 0.75
   },
   {
    "id": "EnduranceBreathElite",
    "t": "E",
    "e": true
   }
  ],
  "Strength": [
   {
    "id": "StrengthBuffJumpHeightInc",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "StrengthBuffLiftWeightInc",
    "t": "S",
    "k": 0.006
   },
   {
    "id": "StrengthBuffMeleePowerInc",
    "t": "S",
    "k": 0.006
   },
   {
    "id": "StrengthBuffSprintSpeedInc",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "StrengthBuffThrowDistanceInc",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "StrengthBuffAim",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "StrengthBuffElite",
    "t": "E",
    "e": true
   },
   {
    "id": "StrengthBuffMeleeCrits",
    "t": "E",
    "k": 0,
    "e": 0.5
   }
  ],
  "Vitality": [
   {
    "id": "VitalityBuffBleedChanceRed",
    "t": "S",
    "k": 0.012
   },
   {
    "id": "VitalityBuffSurviobilityInc",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "VitalityBuffRegeneration",
    "t": "E",
    "e": true
   },
   {
    "id": "VitalityBuffBleedStop",
    "t": "E",
    "e": true
   }
  ],
  "Health": [
   {
    "id": "HealthBreakChanceRed",
    "t": "S",
    "k": 0.012
   },
   {
    "id": "HealthEnergy",
    "t": "S",
    "k": 0.006
   },
   {
    "id": "HealthHydration",
    "t": "S",
    "k": 0.006
   },
   {
    "id": "HealthEliteAbsorbDamage",
    "t": "E",
    "e": true
   }
  ],
  "StressResistance": [
   {
    "id": "StressPainChance",
    "t": "S",
    "k": 0.01
   },
   {
    "id": "StressTremor",
    "t": "S",
    "k": 0.012
   },
   {
    "id": "StressBerserk",
    "t": "E",
    "e": true
   }
  ],
  "Metabolism": [
   {
    "id": "MetabolismEliteBuffNoDyhydration",
    "t": "E",
    "e": true
   },
   {
    "id": "MetabolismRatioPlus",
    "t": "S",
    "k": 0.01
   },
   {
    "id": "MetabolismMiscDebuffTime",
    "t": "S",
    "k": 0.01
   }
  ],
  "Immunity": [
   {
    "id": "ImmunityMiscEffects",
    "t": "S",
    "k": 0.01
   },
   {
    "id": "ImmunityPoisonBuff",
    "t": "S",
    "k": 0.01
   },
   {
    "id": "ImmunityPainKiller",
    "t": "S",
    "k": 0.006
   },
   {
    "id": "ImmunityAvoidPoisonChance",
    "t": "E",
    "k": 0,
    "e": 0.9
   },
   {
    "id": "ImmunityMiscEffectsChance",
    "t": "E",
    "k": 0,
    "e": 0.9
   }
  ],
  "Perception": [
   {
    "id": "PerceptionLootDot",
    "t": "S",
    "k": 0.02
   },
   {
    "id": "PerceptionmEliteNoIdea",
    "t": "E",
    "e": true
   }
  ],
  "Intellect": [
   {
    "id": "IntellectEliteAmmoCounter",
    "t": "E",
    "e": true
   },
   {
    "id": "IntellectEliteContainerScope",
    "t": "E",
    "e": true
   },
   {
    "id": "IntellectEliteNaturalLearner",
    "t": "E",
    "e": true
   },
   {
    "id": "IntellectLearningSpeed",
    "t": "S",
    "k": 0.02
   },
   {
    "id": "IntellectWeaponMaintance",
    "t": "S",
    "k": 0.02
   },
   {
    "id": "IntellectRepairPointsCostReduction",
    "t": "S",
    "k": 0.004
   }
  ],
  "Attention": [
   {
    "id": "AttentionEliteExtraLootExp",
    "t": "E",
    "e": true
   },
   {
    "id": "AttentionEliteLuckySearch",
    "t": "E",
    "k": 0,
    "e": 0.5
   },
   {
    "id": "AttentionLootSpeed",
    "t": "S",
    "k": 0.02
   },
   {
    "id": "AttentionRareLoot",
    "t": "S",
    "k": 0.02
   }
  ],
  "Charisma": [
   {
    "id": "CharismaDailyQuestsRerollDiscount",
    "t": "S",
    "k": 0.001
   },
   {
    "id": "CharismaHealingDiscount",
    "t": "S",
    "k": 0.001
   },
   {
    "id": "CharismaInsuranceDiscount",
    "t": "S",
    "k": 0.001
   },
   {
    "id": "CharismaExfiltrationDiscount",
    "t": "S",
    "k": 0.001
   },
   {
    "id": "CharismaScavCaseDiscount",
    "t": "E",
    "e": true
   },
   {
    "id": "CharismaFenceRepPenaltyReduction",
    "t": "E",
    "e": true
   },
   {
    "id": "CharismaAdditionalDailyQuests",
    "t": "E",
    "e": true
   }
  ],
  "Throwing": [
   {
    "id": "ThrowingStrengthBuff",
    "t": "S",
    "k": 0.005
   },
   {
    "id": "ThrowingEnergyExpenses",
    "t": "S",
    "k": 0.01
   },
   {
    "id": "ThrowingSpeedBuff",
    "t": "S",
    "k": 0.1
   },
   {
    "id": "ThrowingWeaponsBuffElite",
    "t": "E",
    "e": true
   }
  ],
  "AimDrills": [
   {
    "id": "DrawSpeed",
    "t": "S",
    "k": 0.01
   },
   {
    "id": "DrawElite",
    "t": "E",
    "e": true
   },
   {
    "id": "DrawTremor",
    "t": "E",
    "e": true
   },
   {
    "id": "DrawSound",
    "t": "S",
    "k": 0.01
   }
  ],
  "TroubleShooting": [
   {
    "id": "TroubleFixing",
    "t": "S",
    "k": 0.005
   },
   {
    "id": "TroubleFixingExamineMalfElite",
    "t": "E",
    "e": true
   },
   {
    "id": "TroubleFixingDurElite",
    "t": "E",
    "e": true
   },
   {
    "id": "TroubleFixingMagElite",
    "t": "E",
    "e": true
   },
   {
    "id": "TroubleFixingAmmoElite",
    "t": "E",
    "e": true
   }
  ],
  "Crafting": [
   {
    "id": "CraftingSingleTimeReduce",
    "t": "S",
    "k": 0.0075
   },
   {
    "id": "CraftingContinueTimeReduce",
    "t": "S",
    "k": 0.0075
   },
   {
    "id": "CraftingElite",
    "t": "E",
    "e": true
   }
  ],
  "HideoutManagement": [
   {
    "id": "HideoutExtraSlots",
    "t": "E",
    "e": true
   },
   {
    "id": "HideoutZoneBonusBoost",
    "t": "S",
    "k": 1
   },
   {
    "id": "HideoutResourceConsumption",
    "t": "S",
    "k": 0.005
   }
  ],
  "CovertMovement": [
   {
    "id": "CovertMovementSoundVolume",
    "t": "S",
    "k": 0.012
   },
   {
    "id": "CovertMovementLoud",
    "t": "P",
    "k": 0.006,
    "e": 0.6
   },
   {
    "id": "CovertMovementElite",
    "t": "E",
    "e": true
   },
   {
    "id": "CovertMovementSpeed",
    "t": "S",
    "k": 0.01,
    "b": 1
   },
   {
    "id": "CovertMovementEquipment",
    "t": "S",
    "k": 0.012
   }
  ],
  "Surgery": [
   {
    "id": "SurgerySpeed",
    "t": "W",
    "k": 0.004,
    "e": 0.4
   },
   {
    "id": "SurgeryReducePenalty",
    "t": "W",
    "k": 0.01,
    "e": 1
   }
  ],
  "Search": [
   {
    "id": "SearchDouble",
    "t": "E",
    "e": true
   },
   {
    "id": "SearchSpeed",
    "t": "P",
    "k": 0.01
   }
  ],
  "LightVests": [
   {
    "id": "LightVestMoveSpeedPenaltyReduction",
    "t": "S",
    "k": 0.006
   },
   {
    "id": "LightVestMeleeWeaponDamageReduction",
    "t": "S",
    "k": 0.006
   },
   {
    "id": "LightVestRepairDegradationReduction",
    "t": "S",
    "k": 0.008
   },
   {
    "id": "LightVestBleedingProtection",
    "t": "E",
    "e": true
   },
   {
    "id": "LightVestDeteriorationChanceOnRepairReduce",
    "t": "E",
    "e": true
   }
  ],
  "HeavyVests": [
   {
    "id": "HeavyVestMoveSpeedPenaltyReduction",
    "t": "S",
    "k": 0.005
   },
   {
    "id": "HeavyVestBluntThroughputDamageReduction",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "HeavyVestRepairDegradationReduction",
    "t": "S",
    "k": 0.01
   },
   {
    "id": "HeavyVestNoBodyDamageDeflectChance",
    "t": "E",
    "e": true
   },
   {
    "id": "HeavyVestDeteriorationChanceOnRepairReduce",
    "t": "E",
    "e": true
   }
  ],
  "WeaponTreatment": [
   {
    "id": "WeaponDurabilityLossOnShotReduce",
    "t": "S",
    "k": 0.005
   },
   {
    "id": "WearAmountRepairGunsReducePerLevel",
    "t": "S",
    "k": 0.01
   },
   {
    "id": "WearChanceRepairGunsReduceEliteLevel",
    "t": "E",
    "e": true
   }
  ],
  "MagDrills": [
   {
    "id": "MagDrillsLoadSpeed",
    "t": "S",
    "k": 0.6
   },
   {
    "id": "MagDrillsUnloadSpeed",
    "t": "S",
    "k": 0.6
   },
   {
    "id": "MagDrillsInventoryCheckSpeed",
    "t": "S",
    "k": 0.8
   },
   {
    "id": "MagDrillsInventoryCheckAccuracy",
    "t": "S",
    "k": 0.1,
    "cap": 2
   },
   {
    "id": "MagDrillsInstantCheck",
    "t": "E",
    "e": true
   },
   {
    "id": "MagDrillsLoadProgression",
    "t": "E",
    "e": true
   }
  ],
  "Pistol": [
   {
    "id": "WeaponReloadBuff",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "WeaponSwapBuff",
    "t": "S",
    "k": 0.008
   },
   {
    "id": "WeaponRecoilBuff",
    "t": "S",
    "k": 0.003
   },
   {
    "id": "WeaponDoubleMastering",
    "t": "E",
    "e": true
   },
   {
    "id": "WeaponErgonomicsBuff",
    "t": "S",
    "k": 0.002
   },
   {
    "id": "DrawElite",
    "t": "E",
    "e": true
   }
  ],
  "Revolver": [
   {
    "id": "WeaponReloadBuff",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "WeaponSwapBuff",
    "t": "S",
    "k": 0.008
   },
   {
    "id": "WeaponRecoilBuff",
    "t": "S",
    "k": 0.003
   },
   {
    "id": "WeaponDoubleMastering",
    "t": "E",
    "e": true
   },
   {
    "id": "WeaponErgonomicsBuff",
    "t": "S",
    "k": 0.002
   },
   {
    "id": "DrawElite",
    "t": "E",
    "e": true
   }
  ],
  "SMG": [
   {
    "id": "WeaponReloadBuff",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "WeaponSwapBuff",
    "t": "S",
    "k": 0.008
   },
   {
    "id": "WeaponRecoilBuff",
    "t": "S",
    "k": 0.003
   },
   {
    "id": "WeaponDoubleMastering",
    "t": "E",
    "e": true
   },
   {
    "id": "WeaponErgonomicsBuff",
    "t": "S",
    "k": 0.002
   },
   {
    "id": "DrawElite",
    "t": "E",
    "e": true
   }
  ],
  "Assault": [
   {
    "id": "WeaponReloadBuff",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "WeaponSwapBuff",
    "t": "S",
    "k": 0.008
   },
   {
    "id": "WeaponRecoilBuff",
    "t": "S",
    "k": 0.003
   },
   {
    "id": "WeaponDoubleMastering",
    "t": "E",
    "e": true
   },
   {
    "id": "WeaponErgonomicsBuff",
    "t": "S",
    "k": 0.002
   },
   {
    "id": "DrawElite",
    "t": "E",
    "e": true
   }
  ],
  "Shotgun": [
   {
    "id": "WeaponReloadBuff",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "WeaponSwapBuff",
    "t": "S",
    "k": 0.008
   },
   {
    "id": "WeaponRecoilBuff",
    "t": "S",
    "k": 0.003
   },
   {
    "id": "WeaponDoubleMastering",
    "t": "E",
    "e": true
   },
   {
    "id": "WeaponErgonomicsBuff",
    "t": "S",
    "k": 0.002
   },
   {
    "id": "DrawElite",
    "t": "E",
    "e": true
   }
  ],
  "Sniper": [
   {
    "id": "WeaponReloadBuff",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "WeaponSwapBuff",
    "t": "S",
    "k": 0.008
   },
   {
    "id": "WeaponRecoilBuff",
    "t": "S",
    "k": 0.003
   },
   {
    "id": "WeaponDoubleMastering",
    "t": "E",
    "e": true
   },
   {
    "id": "WeaponErgonomicsBuff",
    "t": "S",
    "k": 0.002
   },
   {
    "id": "DrawElite",
    "t": "E",
    "e": true
   }
  ],
  "LMG": [
   {
    "id": "WeaponReloadBuff",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "WeaponSwapBuff",
    "t": "S",
    "k": 0.008
   },
   {
    "id": "WeaponRecoilBuff",
    "t": "S",
    "k": 0.003
   },
   {
    "id": "WeaponDoubleMastering",
    "t": "E",
    "e": true
   },
   {
    "id": "WeaponErgonomicsBuff",
    "t": "S",
    "k": 0.002
   },
   {
    "id": "DrawElite",
    "t": "E",
    "e": true
   }
  ],
  "HMG": [
   {
    "id": "WeaponReloadBuff",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "WeaponSwapBuff",
    "t": "S",
    "k": 0.008
   },
   {
    "id": "WeaponRecoilBuff",
    "t": "S",
    "k": 0.003
   },
   {
    "id": "WeaponDoubleMastering",
    "t": "E",
    "e": true
   },
   {
    "id": "WeaponErgonomicsBuff",
    "t": "S",
    "k": 0.002
   },
   {
    "id": "DrawElite",
    "t": "E",
    "e": true
   }
  ],
  "Launcher": [
   {
    "id": "WeaponReloadBuff",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "WeaponSwapBuff",
    "t": "S",
    "k": 0.008
   },
   {
    "id": "WeaponRecoilBuff",
    "t": "S",
    "k": 0.003
   },
   {
    "id": "WeaponDoubleMastering",
    "t": "E",
    "e": true
   },
   {
    "id": "WeaponErgonomicsBuff",
    "t": "S",
    "k": 0.002
   },
   {
    "id": "DrawElite",
    "t": "E",
    "e": true
   }
  ],
  "AttachedLauncher": [
   {
    "id": "WeaponReloadBuff",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "WeaponSwapBuff",
    "t": "S",
    "k": 0.008
   },
   {
    "id": "WeaponRecoilBuff",
    "t": "S",
    "k": 0.003
   },
   {
    "id": "WeaponDoubleMastering",
    "t": "E",
    "e": true
   },
   {
    "id": "WeaponErgonomicsBuff",
    "t": "S",
    "k": 0.002
   },
   {
    "id": "DrawElite",
    "t": "E",
    "e": true
   }
  ],
  "Melee": [
   {
    "id": "WeaponReloadBuff",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "WeaponSwapBuff",
    "t": "S",
    "k": 0.008
   },
   {
    "id": "WeaponRecoilBuff",
    "t": "S",
    "k": 0.003
   },
   {
    "id": "WeaponDoubleMastering",
    "t": "E",
    "e": true
   },
   {
    "id": "WeaponErgonomicsBuff",
    "t": "S",
    "k": 0.002
   },
   {
    "id": "DrawElite",
    "t": "E",
    "e": true
   }
  ],
  "DMR": [
   {
    "id": "WeaponReloadBuff",
    "t": "S",
    "k": 0.004
   },
   {
    "id": "WeaponSwapBuff",
    "t": "S",
    "k": 0.008
   },
   {
    "id": "WeaponRecoilBuff",
    "t": "S",
    "k": 0.003
   },
   {
    "id": "WeaponDoubleMastering",
    "t": "E",
    "e": true
   },
   {
    "id": "WeaponErgonomicsBuff",
    "t": "S",
    "k": 0.002
   },
   {
    "id": "DrawElite",
    "t": "E",
    "e": true
   }
  ]
 },
 "text": {
  "en": {
   "EnduranceBuffEnduranceInc": "Increases stamina by [{0:0.#%}]",
   "EnduranceHands": "Increases arm endurance",
   "EnduranceBuffJumpCostRed": "Reduces jump stamina drain by [{0:0.#%}]",
   "EnduranceBuffBreathTimeInc": "Increases breath holding time by [{0:0.#%}]",
   "EnduranceBuffRestorationTimeRed": "Reduces breath recovery time by [{0:0.#%}]",
   "EnduranceBreathElite": "Breathing is independent of energy",
   "EnduranceDescription": "Endurance influences the amount of stamina and the rate of exhaustion while running or jumping, as well as holding and recovering breath.",
   "StrengthBuffJumpHeightInc": "Increases jump height by [{0:0.#%}]",
   "StrengthBuffLiftWeightInc": "Increases carrying weight by [{0:0.#%}]",
   "StrengthBuffMeleePowerInc": "Increases melee strike power by [{0:0.#%}]",
   "StrengthBuffSprintSpeedInc": "Increases movement and sprint speed by [{0:0.#%}]",
   "StrengthBuffThrowDistanceInc": "Increases throw distance by [{0:0.#%}]",
   "StrengthBuffAim": "Reduces stamina drain while aiming by [{0:0.#%}]",
   "StrengthBuffElite": "Weapons equipped on sling and on back don't count towards total character weight",
   "StrengthBuffMeleeCrits": "Increases chance to deal critical melee damage by [{0:0.#%}]",
   "StrengthDescription": "Increasing strength allows you to jump higher, sprint faster, hit harder, throw farther, and carry more weight.",
   "VitalityBuffBleedChanceRed": "Reduces bleeding chance by [{0:0.#%}]",
   "VitalityBuffSurviobilityInc": "Reduces chance of death from losing a limb by [{0:0.#%}]",
   "VitalityBuffRegeneration": "Increases health regeneration in combat",
   "VitalityBuffBleedStop": "All bleedings stop on their own",
   "VitalityDescription": "Vitality improves your chances of surviving a wound by decreasing the possibility of bleeding and instant death through critical damage of a body part.",
   "HealthBreakChanceRed": "Reduces limb fracture chance by [{0:0.#%}]",
   "HealthEnergy": "Reduces energy consumption by [{0:0.#%}]",
   "HealthHydration": "Reduces dehydration rate by [{0:0.#%}]",
   "HealthEliteAbsorbDamage": "Damage absorption",
   "HealthDescription": "Good health speeds up the recovery from the damage sustained in the raids, decreases the probability of fractures and lowers the energy and dehydration rate.",
   "StressPainChance": "Reduces pain shock chance by [{0:0.#%}]",
   "StressTremor": "Reduces tremor oscillation by [{0:0.#%}]",
   "StressBerserk": "Berserk mode access",
   "StressResistanceDescription": "Stress resistance improves the chances of withstanding injury shock, shaking hands, and tremors.",
   "MetabolismEliteBuffNoDyhydration": "You don't receive damage from exhaustion and dehydration",
   "MetabolismRatioPlus": "Increases food and drink positive effects by [{0:0.#%}]",
   "MetabolismMiscDebuffTime": "Reduces negative effect time of stimulants, food, water by [{0:0.#%}]",
   "MetabolismDescription": "Healthy metabolism improves and extends the effects of eating and drinking, and sustains the physical skills longer.",
   "ImmunityMiscEffects": "Reduces all negative effects from stimulants, food, water by [{0:0.#%}]",
   "ImmunityPoisonBuff": "Reduces poison effect force by [{0:0.#%}]",
   "ImmunityPainKiller": "Increases painkiller action time by [{0:0.#%}]",
   "ImmunityAvoidPoisonChance": "Increases chance to avoid a poison by [{0:0.#%}]",
   "ImmunityMiscEffectsChance": "Chance to gain immunity to negative effects from stimulants, food, water up to [{0:0.#%}]",
   "ImmunityDescription": "Immunity affects the susceptibility to illnesses and the effectiveness of their treatment.",
   "PerceptionLootDot": "Increases loot detection radius by [{0:0.#%}]",
   "PerceptionmEliteNoIdea": "Loot proximity notification",
   "PerceptionDescription": "Improves aiming concentration and makes detection of nearby loot easier.",
   "IntellectEliteAmmoCounter": "Ammo counter",
   "IntellectEliteContainerScope": "Guess container contents without searching",
   "IntellectEliteNaturalLearner": "You do not need a manual for item examination",
   "IntellectLearningSpeed": "Increases item examination speed by [{0:0.#%}]",
   "IntellectWeaponMaintance": "Increases weapon repair effectiveness by [{0:0.#%}]",
   "IntellectRepairPointsCostReduction": "Reduces repair kit durability consumption by [{0:0.#%}]",
   "IntellectDescription": "High intellect boosts the speed of item examination, lock picking, and improves the quality of weapon repairs.",
   "AttentionEliteExtraLootExp": "Doubles your looting EXP",
   "AttentionEliteLuckySearch": "Increases chance to instantly find an item in a container by [{0:0.#%}]",
   "AttentionLootSpeed": "Increases looting speed by [{0:0.#%}]",
   "AttentionRareLoot": "Increases item examination speed by [{0:0.#%}]",
   "AttentionDescription": "Attention increases the looting speed of various containers.",
   "CharismaDailyQuestsRerollDiscount": "Reduces operational task replacement cost by [{0:0.#%}]",
   "CharismaHealingDiscount": "Reduces after-raid healing services prices by [{0:0.#%}]",
   "CharismaInsuranceDiscount": "Reduces insurance services prices by [{0:0.#%}]",
   "CharismaExfiltrationDiscount": "Reduces paid exfil prices by [{0:0.#%}]",
   "CharismaScavCaseDiscount": "Adds a discount to Scav Case prices",
   "CharismaFenceRepPenaltyReduction": "Reduces Fence reputation penalty",
   "CharismaAdditionalDailyQuests": "Adds one more daily operational task",
   "CharismaDescription": "Mastering the art of charisma allows to receive discounts on various services.",
   "ThrowingStrengthBuff": "Increases throw strength by [{0:0.#%}]",
   "ThrowingEnergyExpenses": "Reduces required throw energy by [{0:0.#%}]",
   "ThrowingSpeedBuff": "Increases throw speed by {0:0.#%}",
   "ThrowingWeaponsBuffElite": "Throwables don't require energy and fatigue does not affect their accuracy",
   "ThrowingDescription": "The throwing weapons handling skills allow you to throw grenades farther and with less energy consumption.",
   "DrawSpeed": "Increases aiming speed by [{0:0.#%}]",
   "DrawElite": "Steady aim for the first 3 seconds with any stamina condition",
   "DrawTremor": "Reduces the tremor effect for the first 2 seconds while aiming by [50%]",
   "DrawSound": "Reduces aiming sound by [{0:0.#%}]",
   "AimDrillsDescription": "Aim drills will increase your aiming speed and will allow to perform aiming quieter.",
   "TroubleFixing": "Increases troubleshooting speed by [{0:0.#%}]",
   "TroubleFixingExamineMalfElite": "Malfunction type identification doesn't require weapon examination",
   "TroubleFixingDurElite": "Reduces weapon durability malfunction chance after fixing a malfunction from the same source by [50%]",
   "TroubleFixingMagElite": "Reduces weapon magazine malfunction chance after fixing a malfunction from the same source by [50%]",
   "TroubleFixingAmmoElite": "Reduces weapon cartridge malfunction chance after fixing a malfunction from the same source by [50%]",
   "TroubleShootingDescription": "Troubleshooting skill facilitates rectification of weapon malfunctions.",
   "CraftingSingleTimeReduce": "Reduces item crafting time by [{0:0.#%}]",
   "CraftingContinueTimeReduce": "Reduces all cyclic production time (except Bitcoin Farm) by [{0:0.#%}]",
   "CraftingElite": "Ability to craft up to two different items in a zone at once",
   "CraftingDescription": "Improving the crafting skill reduces the production time of items, including those produced cyclically.",
   "HideoutExtraSlots": "+2 fuel canister slots\n+2 water filter slots\n+2 air filter slots\n+2 Bitcoin Farm storage slots",
   "HideoutZoneBonusBoost": "Increases all percentage bonuses from Hideout zones by [{0:0.#}%]",
   "HideoutResourceConsumption": "Reduces fuel, air and water filter consumption rate by [{0:0.#%}]",
   "HideoutManagementDescription": "Efficient Hideout management allows you to use less fuel and filters in production, and increases bonuses from different Hideout zones.",
   "CovertMovementSoundVolume": "Reduces noise level of footsteps on common surfaces by [{0:0.#%}]",
   "CovertMovementLoud": "Reduces noise level of footsteps on uncommon surfaces by [{0:0.#%}]",
   "CovertMovementElite": "Covert movement becomes equally quiet on all surfaces",
   "CovertMovementSpeed": "Increases covert movement speed by [{0:0.#%}]",
   "CovertMovementEquipment": "Reduces noise level of weapons and equipment by [{0:0.#%}]",
   "CovertMovementDescription": "Covert movement makes your steps quieter and reduces the sound radius when moving slow.",
   "SurgerySpeed": "Increases surgery speed by [{0:0.#%}]",
   "SurgeryReducePenalty": "Reduces surgery HP penalty by [{0:0.#%}]",
   "SurgeryDescription": "The ability to perform field surgery may save your life in critical situations. The better you learn this skill, the faster and better you will perform combat surgeries.",
   "SearchDouble": "Search two containers at a time",
   "SearchSpeed": "Increases search speed by [{0:0.#%}]",
   "SearchDescription": "The search skill mastering allows you to search bodies and containers faster and more efficiently.",
   "LightVestMoveSpeedPenaltyReduction": "Reduces movement speed penalty while wearing light armor by [{0:0.#%}]",
   "LightVestMeleeWeaponDamageReduction": "Reduces melee damage to body parts covered by light armor by [{0:0.#%}]",
   "LightVestRepairDegradationReduction": "Reduces wear amount when using repair kits by [{0:0.#%}]",
   "LightVestBleedingProtection": "Body parts covered by light armor are immune to bleeding",
   "LightVestDeteriorationChanceOnRepairReduce": "Reduces wear chance when using repair kits by [50%]",
   "LightVestsDescription": "Light body armor wearing skill improves mobility and reduces the amount of received penetration and melee damage to your health.",
   "HeavyVestMoveSpeedPenaltyReduction": "Reduces movement speed penalty while wearing heavy armor by [{0:0.#%}]",
   "HeavyVestBluntThroughputDamageReduction": "Reduces blunt damage to body parts covered by heavy armor by [{0:0.#%}]",
   "HeavyVestRepairDegradationReduction": "Reduces wear amount when using repair kits by [{0:0.#%}]",
   "HeavyVestNoBodyDamageDeflectChance": "Chance to deflect a bullet from heavy armor",
   "HeavyVestDeteriorationChanceOnRepairReduce": "Reduces wear chance when using repair kits by [50%]",
   "HeavyVestsDescription": "Heavy body armor wearing skill reduces amount of received penetration health damage, explosive damage to health and armor and improves mobility.",
   "WeaponDurabilityLossOnShotReduce": "Reduces gun wear while shooting by [{0:0.#%}]",
   "WearAmountRepairGunsReducePerLevel": "Reduces wear amount when using repair kits",
   "WearChanceRepairGunsReduceEliteLevel": "Reduces wear chance when using repair kits by [50%]",
   "WeaponTreatmentDescription": "Weapon service and maintenance skills.",
   "MagDrillsLoadSpeed": "Increases ammo loading speed by [{0:0.#}%]",
   "MagDrillsUnloadSpeed": "Increases ammo unloading speed by [{0:0.#}%]",
   "MagDrillsInventoryCheckSpeed": "Increases magazine check speed through the context menu by [{0:0.#}%]",
   "MagDrillsInventoryCheckAccuracy": "Increases magazine check accuracy through the context menu by [{0:0.#}%]",
   "MagDrillsInstantCheck": "Magazine is checked instantly when moved to your inventory",
   "MagDrillsLoadProgression": "Magazine loading is performed faster with every loaded round",
   "MagDrillsDescription": "Skill aimed at magazine handling - loading and unloading of ammo, checking for remaining cartridges.",
   "WeaponReloadBuff": "Increases reload speed by [{0:0.#%}]",
   "WeaponSwapBuff": "Increases weapon switching speed by [{0:0.#%}]",
   "WeaponRecoilBuff": "Reduces weapon recoil by [{0:0.#%}]",
   "WeaponDoubleMastering": "Doubles mastering gain",
   "WeaponErgonomicsBuff": "Improves weapon ergonomics by [{0:0.#%}]",
   "PistolDescription": "Pistol handling skill improves the overall handling, reduces recoil and reload time of this weapon type.",
   "RevolverDescription": "Revolver handling skill improves the overall handling, reduces recoil and reload time of this weapon type.",
   "SMGDescription": "Submachine Gun handling skill improves the overall handling, reduces recoil and reload time of this weapon type.",
   "AssaultDescription": "Assault Rifle handling skill improves the overall handling, reduces recoil and reload time of this weapon type.",
   "ShotgunDescription": "Shotgun handling skill improves the overall handling, reduces recoil and reload time of this weapon type.",
   "SniperDescription": "Bolt-action Rifle handling skill improves the overall handling, reduces recoil and reload time of this weapon type.",
   "LMGDescription": "Light Machine Gun handling skill improves the overall handling, reduces recoil and reload time of this weapon type.",
   "HMGDescription": "Heavy Machine Gun handling skill improves the overall handling, reduces recoil and reload time of this weapon type.",
   "LauncherDescription": "Grenade Launcher handling skill improves the overall handling, reduces recoil and reload time of this weapon type.",
   "AttachedLauncherDescription": "Underbarrel Launcher handling skill improves the overall handling, reduces recoil and reload time of this weapon type.",
   "MeleeDescription": "Melee weapons handling skills",
   "DMRDescription": "Designated Marksman Rifle handling skill improves the overall handling, reduces recoil and reload time of this weapon type."
  },
  "ch": {
   "EnduranceBuffEnduranceInc": "提升耐力 [{0:0.#%}]",
   "EnduranceHands": "加强手臂耐力",
   "EnduranceBuffJumpCostRed": "降低跳跃时的耐力消耗 [{0:0.#%}]",
   "EnduranceBuffBreathTimeInc": "提升屏息时间 [{0:0.#%}]",
   "EnduranceBuffRestorationTimeRed": "降低呼吸恢复耗时 [{0:0.#%}]",
   "EnduranceBreathElite": "呼吸不再受能量值影响",
   "EnduranceDescription": "耐力影响跑步或跳跃时的耐力量和耐力消耗率，以及屏息时间和恢复呼吸速度。",
   "StrengthBuffJumpHeightInc": "提升跳跃高度 [{0:0.#%}]",
   "StrengthBuffLiftWeightInc": "提升负重能力 [{0:0.#%}]",
   "StrengthBuffMeleePowerInc": "提升近战攻击伤害 [{0:0.#%}]",
   "StrengthBuffSprintSpeedInc": "提升移动及冲刺速度 [{0:0.#%}]",
   "StrengthBuffThrowDistanceInc": "提升投掷距离 [{0:0.#%}]",
   "StrengthBuffAim": "降低瞄准时的耐力消耗 [{0:0.#%}]",
   "StrengthBuffElite": "已装备的武器不会计入你的角色负重（不包括背包内的武器）",
   "StrengthBuffMeleeCrits": "提高近战暴击概率 [{0:0.#%}]",
   "StrengthDescription": "增加力量可以让你跳得更高，冲刺更快，击打更用力，投掷更远，并承载更多的重量。",
   "VitalityBuffBleedChanceRed": "降低流血概率 [{0:0.#%}]",
   "VitalityBuffSurviobilityInc": "降低肢体损毁时猝死的概率 [{0:0.#%}]",
   "VitalityBuffRegeneration": "提升战斗时的生命值恢复",
   "VitalityBuffBleedStop": "所有出血可自行停止",
   "VitalityDescription": "活力可以减少身体某一部位受到致命伤害后，出血和立即死亡的概率，来提高你在受伤后存活的机会。",
   "HealthBreakChanceRed": "降低四肢骨折概率 [{0:0.#%}]",
   "HealthEnergy": "降低能量消耗 [{0:0.#%}]",
   "HealthHydration": "降低水分消耗 [{0:0.#%}]",
   "HealthEliteAbsorbDamage": "伤害吸收",
   "HealthDescription": "良好的健康可以加快被击中后伤口的回复速度，并降低骨折发生的几率，同时减少能量和水分的消耗。",
   "StressPainChance": "降低疼痛休克的概率 [{0:0.#%}]",
   "StressTremor": "降低颤栗摇晃幅度 [{0:0.#%}]",
   "StressBerserk": "狂暴模式可用",
   "StressResistanceDescription": "抗压可以提高抵抗受伤害性休克的几率，并减少因疼痛造成的手抖与颤栗。",
   "MetabolismEliteBuffNoDyhydration": "你不会因力竭或脱水受到伤害",
   "MetabolismRatioPlus": "提升饮食的增益效果 [{0:0.#%}]",
   "MetabolismMiscDebuffTime": "降低针剂和饮食的负面效果作用时间 [{0:0.#%}]",
   "MetabolismDescription": "健康的新陈代谢会改善和增强饮食的效果，并使生理类技能维持得更久。",
   "ImmunityMiscEffects": "降低所有兴奋剂和饮食的副作用 [{0:0.#%}]",
   "ImmunityPoisonBuff": "降低毒性发作时的伤害 [{0:0.#%}]",
   "ImmunityPainKiller": "提升止痛药持续时间 [{0:0.#%}]",
   "ImmunityAvoidPoisonChance": "提升免受中毒的概率 [{0:0.#%}]",
   "ImmunityMiscEffectsChance": "有 [{0:0.#%}] 几率免受兴奋剂和饮食的副作用",
   "ImmunityDescription": "免疫会影响染病几率以及治愈的速度。",
   "PerceptionLootDot": "提升战利品探测半径 [{0:0.#%}]",
   "PerceptionmEliteNoIdea": "物资临近感知",
   "PerceptionDescription": "提高瞄准专注力，并使周围战利品的发现更加容易。",
   "IntellectEliteAmmoCounter": "弹药计数器",
   "IntellectEliteContainerScope": "不用搜索也能猜到容器里的内容",
   "IntellectEliteNaturalLearner": "你不需要手册就能解析物品",
   "IntellectLearningSpeed": "提升物品检视速度 [{0:0.#%}]",
   "IntellectWeaponMaintance": "提高武器维修效果 [{0:0.#%}]",
   "IntellectRepairPointsCostReduction": "降低维修套件消耗 [{0:0.#%}]",
   "IntellectDescription": "高智力会提高检视物品和撬锁的速度，并且会提高武器维修的质量。",
   "AttentionEliteExtraLootExp": "搜索经验加倍",
   "AttentionEliteLuckySearch": "有 [{0:0.#%}] 几率在容器中瞬间找到物品",
   "AttentionLootSpeed": "提升搜刮速度 [{0:0.#%}]",
   "AttentionRareLoot": "提升物品检视速度 [{0:0.#%}]",
   "AttentionDescription": "专注可以提升搜刮各种容器的速度。",
   "CharismaDailyQuestsRerollDiscount": "降低行动任务更换消耗 [{0:0.#%}]",
   "CharismaHealingDiscount": "降低战局后治疗服务的费用 [{0:0.#%}]",
   "CharismaInsuranceDiscount": "降低保险服务费用 [{0:0.#%}]",
   "CharismaExfiltrationDiscount": "降低付费撤离点价格 [{0:0.#%}]",
   "CharismaScavCaseDiscount": "获得Scav宝箱折扣",
   "CharismaFenceRepPenaltyReduction": "降低Fence信任度惩罚",
   "CharismaAdditionalDailyQuests": "额外增加一个每日行动任务",
   "CharismaDescription": "魅力会影响商人各项服务的折扣力度。",
   "ThrowingStrengthBuff": "提升投掷力度 [{0:0.#%}]",
   "ThrowingEnergyExpenses": "降低投掷时的能量消耗 [{0:0.#%}]",
   "ThrowingSpeedBuff": "提升投掷速度 [+{0:0.#%}]",
   "ThrowingWeaponsBuffElite": "投掷不再消耗能量，且疲劳程度不影响投掷准确度",
   "ThrowingDescription": "投掷武器使用技能可以让你将手榴弹扔的更远，并且消耗更少的能量。",
   "DrawSpeed": "提升瞄准速度 [{0:0.#%}]",
   "DrawElite": "无论耐力状况如何，开始瞄准后均可在前3秒中保持稳定",
   "DrawTremor": "降低 [50%] 前2秒瞄准时的颤栗影响",
   "DrawSound": "降低瞄准声音 [{0:0.#%}]",
   "AimDrillsDescription": "瞄准训练将提高你的瞄准速度，使你瞄准时更安静",
   "TroubleFixing": "提升故障排除速度 [{0:0.#%}]",
   "TroubleFixingExamineMalfElite": "不需要检查武器就能知道故障类型",
   "TroubleFixingDurElite": "当武器因耐久度问题发生故障后，由相同原因再次发生故障的概率降低 [50%]",
   "TroubleFixingMagElite": "当武器因弹药发生故障后，由相同原因再次发生故障的概率降低 [50%]",
   "TroubleFixingAmmoElite": "当武器因弹匣发生故障后，由相同原因再次发生故障的概率降低 [50%]",
   "TroubleShootingDescription": "排除故障技能有助于排除武器故障。",
   "CraftingSingleTimeReduce": "降低制造物品的时间消耗 [{0:0.#%}]",
   "CraftingContinueTimeReduce": "降低所有循环生产（比特币矿场除外）的时间消耗 [{0:0.#%}]",
   "CraftingElite": "每个区域可以同时制造两种不同物品",
   "CraftingDescription": "提高工艺技能可以减少物品的生产时间，包括那些循环生产的物品。",
   "HideoutExtraSlots": "+2个燃料罐槽\n+2个滤水器槽\n+2个空气过滤器槽\n+2比特币储存上限",
   "HideoutZoneBonusBoost": "提升藏身处所有区域奖励值 [{0:0.#}%]",
   "HideoutResourceConsumption": "降低燃料、空气及水过滤器的消耗速率 [{0:0.#%}]",
   "HideoutManagementDescription": "高效的管理藏身处，允许您在生产中使用更少的燃料和过滤器，并增加区域奖励。",
   "CovertMovementSoundVolume": "降低在一般表面上行走时的脚步声 [{0:0.#%}]",
   "CovertMovementLoud": "降低在特殊表面上行走时的脚步声 [{0:0.#%}]",
   "CovertMovementElite": "在任何材质的表面上隐蔽行动都会同样安静。",
   "CovertMovementSpeed": "提升隐蔽行动时的速度 [{0:0.#%}]",
   "CovertMovementEquipment": "降低使用武器和装备时的声音 [{0:0.#%}]",
   "CovertMovementDescription": "隐蔽行动可以让你缓慢移动时的脚步声更轻，并缩小声音传播的范围。",
   "SurgerySpeed": "提升手术速度 [{0:0.#%}]",
   "SurgeryReducePenalty": "降低手术后的生命值上限惩罚 [{0:0.#%}]",
   "SurgeryDescription": "在紧急情况下，进行野战手术的能力可以挽救你的生命。你这个技能学得越好，你的操作就越快越好。",
   "SearchDouble": "同时搜索两个容器",
   "SearchSpeed": "提升搜索速度 [{0:0.#%}]",
   "SearchDescription": "搜索技能可以让你更加快速高效地搜索尸体及容器。",
   "LightVestMoveSpeedPenaltyReduction": "降低装备轻型护甲时的移动速度惩罚 [{0:0.#%}]",
   "LightVestMeleeWeaponDamageReduction": "降低受轻型护甲保护部位受到的近战武器伤害 [{0:0.#%}]",
   "LightVestRepairDegradationReduction": "降低使用维修套件时的消耗 [{0:0.#%}]",
   "LightVestBleedingProtection": "受轻型护甲保护的部位免疫失血",
   "LightVestDeteriorationChanceOnRepairReduce": "维修时有 [50%] 几率不产生损耗",
   "LightVestsDescription": "轻型防弹衣穿着技能可以增加机动力，降低被击穿和受近战攻击时健康的损害。",
   "HeavyVestMoveSpeedPenaltyReduction": "降低装备重型护甲时的移动速度惩罚 [{0:0.#%}]",
   "HeavyVestBluntThroughputDamageReduction": "降低受重型护甲保护部位受到的钝伤 [{0:0.#%}]",
   "HeavyVestRepairDegradationReduction": "减少使用维修套件时的消耗 [{0:0.#%}]",
   "HeavyVestNoBodyDamageDeflectChance": "重型护甲有几率跳弹",
   "HeavyVestDeteriorationChanceOnRepairReduce": "维修时有 [50%] 几率不产生损耗",
   "HeavyVestsDescription": "重型护甲穿着技能可以降低被击穿后对健康的损害，降低爆炸伤害对护甲自身和健康的影响，并且增强机动力。",
   "WeaponDurabilityLossOnShotReduce": "降低枪械在开火时的折损速率 [{0:0.#%}]",
   "WearAmountRepairGunsReducePerLevel": "减少使用维修套件时的消耗",
   "WearChanceRepairGunsReduceEliteLevel": "降低 [50%] 使用维修套件时的折损概率",
   "WeaponTreatmentDescription": "武器维护和保养技能。",
   "MagDrillsLoadSpeed": "提升装弹速度 [{0:0.#}%]",
   "MagDrillsUnloadSpeed": "提升弹药卸载速度 [{0:0.#}%]",
   "MagDrillsInventoryCheckSpeed": "增加通过快捷菜单检查弹匣的速度 [{0:0.#}%]",
   "MagDrillsInventoryCheckAccuracy": "增加通过快捷菜单检查弹匣的准确度 [{0:0.#}%]",
   "MagDrillsInstantCheck": "弹匣会在移入物品栏时被瞬间检查完毕",
   "MagDrillsLoadProgression": "每轮装填弹匣的速度随着装入的子弹数量增多而加快",
   "MagDrillsDescription": "针对弹匣掌握的技能——装填和卸载弹药以及检查弹匣中的剩余子弹数。",
   "WeaponReloadBuff": "提升换弹速度 [{0:0.#%}]",
   "WeaponSwapBuff": "提高武器切换速度 [{0:0.#%}]",
   "WeaponRecoilBuff": "降低武器后坐力 [{0:0.#%}]",
   "WeaponDoubleMastering": "双倍专精经验",
   "WeaponErgonomicsBuff": "提高武器人机功效 [{0:0.#%}]",
   "PistolDescription": "手枪使用技能可以提升对手枪的后坐力控制及总体掌握。",
   "RevolverDescription": "左轮手枪使用技能",
   "SMGDescription": "冲锋枪使用技能可以提升对冲锋枪的后坐力控制及总体掌握。",
   "AssaultDescription": "突击步枪使用技能可以提升对突击步枪的后坐力控制及总体掌握。",
   "ShotgunDescription": "霰弹枪使用技能可以提升对霰弹枪的后坐力控制及总体掌握。",
   "SniperDescription": "栓动式步枪操作技能可以提升使用栓动式步枪时的整体控枪能力、降低武器后座以及加快装填速度。",
   "LMGDescription": "轻机枪使用技能可以提升对轻机枪的后坐力控制及总体掌握。",
   "HMGDescription": "重机枪使用技能可以提升对重机枪的后坐力控制及总体掌握。",
   "LauncherDescription": "火箭发射器技能可提升对火箭筒类武器的整体控制能力，减少后坐力与装填时间。",
   "AttachedLauncherDescription": "下挂式榴弹发射器技能可提升对下挂榴弹发射器的整体控制能力，减少后坐力与装填时间。",
   "MeleeDescription": "近战武器使用技能",
   "DMRDescription": "精确射手步枪使用技能可以提升对精确射手步枪的后坐力控制及总体掌握。"
  }
 }
};

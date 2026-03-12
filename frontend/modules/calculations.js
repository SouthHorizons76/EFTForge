window.EFTForge = window.EFTForge || {};

function calcArmStamina(weight, ergo, strengthLevel, b = 0) {
    return (
        (85.5 / (weight + 0.65))
        + 9.15
        + 0.06477 * ergo * (1 + b / 2)
    ) / 1.04 * (1 + strengthLevel * 0.004);
}

function calcEED(totalErgo, totalWeight, b = 0) {
    const E = totalErgo * (1 + b);
    const KG = 0.0007556 * (E ** 2) + 0.02736 * E + 2.9159;
    return -15 * (totalWeight - KG);
}

EFTForge.calc = { calcArmStamina, calcEED };

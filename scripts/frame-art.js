const MINIS = "systems/lancer/assets/retrograde-minis/Retrograde-Minis-";

const RETROGRADE = {
    "ATLAS": "SSC-ATLAS",
    "BALOR": "Horus-BALOR",
    "BARBAROSSA": "HA-BARBAROSSA",
    "BLACK WITCH": "SSC-BLACK WITCH",
    "BLACKBEARD": "IPS-N-BLACKBEARD",
    "CALENDULA": "Horus-RKF-CALENDULA",
    "CALIBAN": "IPS-N-CALIBAN",
    "DEATH’S HEAD": "SSC-DEATHS HEAD",
    "DEATH'S HEAD": "SSC-DEATHS HEAD",
    "DRAKE": "IPS-N-DRAKE",
    "DUSK WING": "SSC-DUSK WING",
    "EMPAKAAI": "IPS-N-EMPAKAAI",
    "EMPEROR": "SSC-EMPEROR",
    "ENKIDU": "HA-ENKIDU",
    "EVEREST": "GMS",
    "GENGHIS": "HA-GENGHIS",
    "GOBLIN": "Horus-GOBLIN-2-0",
    "GORGON": "Horus-GORGON",
    "HYDRA": "Horus-HYDRA",
    "ISKANDER": "HA-ISKANDER-2-0",
    "KIDD": "IPS-N-KIDD",
    "KOBOLD": "Horus-KOBOLD",
    "LANCASTER": "IPS-N-LANCASTER",
    "LICH": "Horus-LICH",
    "MANTICORE": "Horus-MANTICORE",
    "METALMARK": "SSC-METALMARK-2-0",
    "MINOTAUR": "Horus-MINOTAUR",
    "MONARCH": "SSC-MONARCH",
    "MOURNING CLOAK": "SSC-MOURNING CLOAK",
    "NAPOLEON": "HA-NAPOLEON",
    "NELSON": "IPS-N-NELSON-2-0",
    "ORCHIS": "SSC-ORCHIS",
    "PEGASUS": "Horus-PEGASUS-2-0",
    "RALEIGH": "IPS-N-RALEIGH",
    "SAGARMATHA": "GMS",
    "SALADIN": "HA-SALADIN",
    "SHERMAN": "HA-SHERMAN",
    "STÖRTEBEKER": "IPS-N-STORTEBEKER",
    "STORTEBEKER": "IPS-N-STORTEBEKER",
    "SUNZI": "HA-SUNZI",
    "SWALLOWTAIL": "SSC-SWALLOWTAIL-2-0",
    "SWALLOWTAIL (RANGER VARIANT)": "SSC-RANGER-SWALLOWTAIL",
    "TOKUGAWA": "HA-TOKUGAWA",
    "TORTUGA": "IPS-N-TORTUGA",
    "VICEROY": "SSC-VICEROY",
    "VLAD": "IPS-N-VLAD-2-0",
    "WHITE WITCH": "SSC-WHITE WITCH",
    "“WORLDKILLER” GENGHIS MK I": "HA-GENGHIS-MK-I---WORLDKILLER",
    "ZHENG": "IPS-N-ZHENG",
    "ACE": "Corpro-ACE",
    "AEGIS": "Corpro-AEGIS",
    "ARCHER": "Corpro-ARCHER",
    "ASSASSIN": "Corpro-ASSASSIN",
    "ASSAULT": "Corpro-ASSAULT",
    "AVENGER": "Corpro-AVENGER",
    "BARRICADE": "Corpro-BARRICADE",
    "BASTION": "Corpro-BASTION",
    "BERSERKER": "Corpro-BERSERKER",
    "BOMBARD": "Corpro-BOMBARD",
    "BREACHER": "Corpro-BREACHER",
    "CATAPHRACT": "Corpro-CATAPHRACT",
    "DEMOLISHER": "Corpro-DEMOLISHER",
    "ENGINEER": "Corpro-ENGINEER",
    "GOLIATH": "Corpro-GOLIATH",
    "HIVE": "Corpro-HIVE",
    "HORNET": "Corpro-HORNET",
    "HUMAN": "Misc-HUMAN",
    "LEECH": "Corpro-LEECH",
    "LURKER": "Corpro-LURKER",
    "MIRAGE": "Corpro-MIRAGE",
    "MONSTROSITY": "Kaiju-RUGAM",
    "OPERATOR": "Corpro-OPERATOR",
    "PRIEST": "Corpro-PRIEST",
    "PYRO": "Corpro-PYRO",
    "RAINMAKER": "Corpro-RAINMAKER",
    "RONIN": "Corpro-RONIN",
    "SCOURER": "Corpro-SCOURER",
    "SCOUT": "Corpro-SCOUT",
    "SEEDER": "Corpro-SEEDER",
    "SENTINEL": "Corpro-SENTINEL",
    "SNIPER": "Corpro-SNIPER",
    "SPECTER": "Corpro-SPECTER",
    "SPITE": "Corpro-SPITE",
    "STRIDER": "Corpro-STRIDER",
    "SQUAD": "Misc-INFANTRY",
    "SUPPORT": "Corpro-SUPPORT",
    "TEMPEST": "Corpro-TEMPEST",
    "WITCH": "Corpro-WITCH"
};

const GENERIC_ICONS = /\/icons\/(svg\/mystery-man|.*\/(mech|npc|npc_class|frame)\.svg)/i;

export function retrogradeArt(name)
{
    const key = String(name ?? "").replace(/ \[K\]$/, "").trim().toUpperCase();
    return RETROGRADE[key] ? `${MINIS}${RETROGRADE[key]}.png` : "";
}

export function actorArt(actor)
{
    return actor?.img && !GENERIC_ICONS.test(actor.img) && !actor.img.startsWith("systems/lancer/") ? actor.img : "";
}

export function mechArt(mech, existing)
{
    const frameUrl = mech?.frameData?.image_url && !/nodata\.png/i.test(mech.frameData.image_url) ? mech.frameData.image_url : "";
    return actorArt(existing)
        || mech?.img?.cloud_portrait
        || mech?.cloud_portrait
        || mech?.portrait
        || frameUrl
        || retrogradeArt(mech?.frameData?.name)
        || "";
}

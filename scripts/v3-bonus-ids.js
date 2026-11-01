import { escapeHtml } from "./utils.js";

export const WEAPON_TYPE_NAMES = { Rifle: "Rifle", Cannon: "Cannon", Launcher: "Launcher", CQB: "CQB", Nexus: "Nexus", Melee: "Melee", Improvised: "Improvised" };
export const MOUNT_TYPE_NAMES = { main: "Main", heavy: "Heavy", aux: "Aux", "aux/aux": "Aux/Aux", "main/aux": "Main/Aux", flex: "Flex", superheavy: "Superheavy" };
export const ACTION_KIND_NAMES = { reaction: "Reaction", quick: "Quick action", full: "Full action" };
export const DEFENSE_SUBJECT_NAMES = { kinetic: "Kinetic", energy: "Energy", explosive: "Explosive", heat: "Heat", burn: "Burn", all: "all damage" };

const ACTION_ICONS = { reaction: "cci cci-reaction", quick: "mdi mdi-hexagon-slice-3", full: "mdi mdi-hexagon-slice-6" };
const SKILL_NAMES = { hull: "Hull", agility: "Agility", systems: "Systems", engineering: "Engineering" };
const COMPANION_STATS = { hp: "HP", size: "size", charges: "charges", armor: "Armor", evasion: "Evasion", edef: "E-Defense", heatcap: "Heat Capacity", repcap: "Repair Capacity", sensor_range: "Sensor Range", tech_attack: "Tech Attack", save: "Save Target", speed: "Speed" };

const roll = (label, desc, value = null, extra = {}) => ({ label, desc, value, roll: true, ...extra });
const stat = (label, desc, value, extra = {}) => ({ label, desc, value, mode: "all", ...extra });
const plain = (label, desc, value = null, extra = {}) => ({ label, desc, value, ...extra });

function skillRolls(suffix, labelEnd, descEnd)
{
    return Object.fromEntries(Object.entries(SKILL_NAMES).map(([key, name]) => [`${key}${suffix}`, roll(`${name} ${labelEnd}`, `Accuracy on ${name} ${descEnd}.`)]));
}

function companionStats(prefix, label, plural)
{
    const stats = Object.fromEntries(Object.entries(COMPANION_STATS).map(([key, name]) => [`${prefix}_${key}`, stat(`${label} ${name}`, `Adds ${name} to every deployed ${plural}.`, name.toUpperCase())]));
    stats[`${prefix}_resist`] = plain(`${label} resistance`, `Resistance for every deployed ${plural}.`, "AGAINST", { choices: () => DEFENSE_SUBJECT_NAMES });
    return stats;
}

export const BONUS_CATEGORIES = [
    { key: "rolls", label: "ROLLS", ids: {
        attack: roll("Attacks", "Accuracy, or a flat bonus, on attack rolls.", "FLAT BONUS", { weapons: true }),
        ranged: roll("Ranged attacks", "Accuracy on ranged attack rolls.", null, { weapons: true }),
        melee: roll("Melee attacks", "Accuracy on melee attack rolls.", null, { weapons: true }),
        tech_attack: roll("Tech attacks", "Accuracy on tech attack rolls, or a bonus to Tech Attack.", "TECH ATTACK"),
        grapple: roll("Grapple", "Accuracy, or a flat bonus, on Grapple.", "FLAT BONUS"),
        ram: roll("Ram", "Accuracy, or a flat bonus, on Ram.", "FLAT BONUS"),
        save: roll("Saves", "Accuracy on every save you make, or a bonus to your Save Target.", "SAVE TARGET"),
        check: roll("Checks", "Accuracy on every check, including structure, overheating and burn checks."),
        ...skillRolls("", "checks and saves", "checks and saves"),
        ...skillRolls("_check", "checks", "checks only"),
        ...skillRolls("_save", "saves", "saves only"),
        accuracy: plain("Skill trigger checks", "Accuracy on skill trigger checks. Shown on the sheet, not rolled.", "ACCURACY")
    } },
    { key: "stats", label: "STATS", ids: {
        hp: stat("HP", "Adds to the maximum HP.", "HP"),
        armor: stat("Armor", "Adds to Armor.", "ARMOR"),
        armor_max: stat("Max armor", "Raises the most Armor a mech can have, 4 by default.", "MAX ARMOR"),
        structure: stat("Structure", "Adds Structure.", "STRUCTURE"),
        stress: stat("Reactor stress", "Adds Reactor Stress.", "STRESS"),
        heat_cap: stat("Heat capacity", "Adds to Heat Capacity.", "HEAT CAP"),
        repcap: stat("Repair capacity", "Adds to Repair Capacity.", "REPAIRS"),
        speed: stat("Speed", "Adds to Speed.", "SPEED"),
        boost: plain("Boost distance", "Adds spaces to every Boost.", "SPACES"),
        evasion: stat("Evasion", "Adds to Evasion.", "EVASION"),
        edef: stat("E-Defense", "Adds to E-Defense.", "E-DEFENSE"),
        sensor: stat("Sensor range", "Adds to Sensor Range.", "SENSORS"),
        sp: stat("SP", "Adds System Points.", "SP"),
        size: stat("Size", "Adds to Size.", "SIZE"),
        ai_cap: stat("AI capacity", "Lets the mech carry more AI systems.", "AI"),
        limited_bonus: plain("Limited uses", "Adds uses to Limited equipment.", "USES"),
        activations: stat("Activations (NPC)", "Adds activations per round.", "ACTIVATIONS"),
        activations_pct: plain("Activation per players (NPC)", "One more activation per round once the encounter has this many player characters.", "PLAYERS"),
        sizes: stat("Size choices (NPC)", "Adds size choices when the NPC is made.", "SIZES", { placeholder: "e.g. 1, 2" })
    } },
    { key: "weapons", label: "WEAPONS", ids: {
        range: plain("Range", "Adds Range, including Threat, to weapons.", "RANGE", { weapons: true }),
        threat: plain("Threat", "Adds Threat to weapons.", "THREAT", { weapons: true, mode: "replace" }),
        min_range: plain("Minimum range", "Weapons reach at least this far on the range types picked below. Threat is added when a weapon has none.", "AT LEAST", { weapons: true }),
        thrown: plain("Thrown", "Weapons get Thrown at least this far.", "THROWN", { weapons: true }),
        damage: plain("Damage", "Adds damage to weapons.", "DAMAGE", { weapons: true, placeholder: "e.g. 2 or 1d6" }),
        knockback: plain("Knockback", "Adds Knockback to weapons.", "KNOCKBACK", { weapons: true }),
        add_weapon_type: plain("Extra weapon type", "Weapons also count as this weapon type.", "COUNTS AS", { weapons: true, choices: () => WEAPON_TYPE_NAMES }),
        no_mods: plain("No mods", "Shows that the weapon cannot take mods. Display only.", null, { weapons: true })
    } },
    { key: "mounts", label: "MOUNTS", ids: {
        mount_accuracy: plain("Mount accuracy", "Accuracy on attacks with weapons on the mount this core bonus is assigned to.", "ACCURACY"),
        mount_range: plain("Mount range", "Adds Range to weapons on that mount. Comp/Con does not apply it yet.", "RANGE"),
        mount_damage: plain("Mount damage", "Adds damage to weapons on that mount. Comp/Con does not apply it yet.", "DAMAGE"),
        add_mount: plain("Extra mount", "Adds a mount of this type.", "MOUNT TYPE", { choices: () => MOUNT_TYPE_NAMES, max: true }),
        superheavy_mounting: plain("Superheavy mounting", "Adds a Superheavy mount while the frame has fewer than 3 mounts.")
    } },
    { key: "actions", label: "ACTIONS", ids: {
        extra_action: plain("Extra action", "One more action of this kind. Reactions come back every turn, quick and full actions at the start of your turn.", "ACTION", { choices: () => ACTION_KIND_NAMES }),
        deploy_count: plain("Extra deploy", "Adds Deploy actions for deployables.", "DEPLOYS"),
        core_power: plain("Restore CORE power", "Restores CORE Power.", "CORE POWER"),
        no_cascade: plain("AI cannot cascade", "AI systems on this mech cannot cascade."),
        overcharge: plain("Overcharge track", "Replaces the Overcharge heat track.", "TRACK", { placeholder: "e.g. 1, 1d3, 1d6, 1d6+4" }),
        cheap_struct: plain("Cheap structure repair", "Halves the repair cost of Structure.", "VALUE"),
        cheap_stress: plain("Cheap stress repair", "Halves the repair cost of Reactor Stress.", "VALUE")
    } },
    { key: "defenses", label: "DEFENSES", ids: {
        immunity: plain("Immunity", "Immune to a damage type, or cannot gain a status.", "AGAINST", { choices: statusChoices => ({ ...DEFENSE_SUBJECT_NAMES, ...statusChoices }) }),
        resistance: plain("Resistance", "Half damage from a damage type.", "AGAINST", { choices: () => DEFENSE_SUBJECT_NAMES })
    } },
    { key: "deployables", label: "DEPLOYABLES", ids: companionStats("deployable", "Deployable", "deployable") },
    { key: "drones", label: "DRONES", ids: companionStats("drone", "Drone", "drone") },
    { key: "pilot", label: "PILOT", ids: {
        pilot_hp: stat("Pilot HP", "Adds to the pilot's HP.", "HP"),
        pilot_armor: stat("Pilot armor", "Adds to the pilot's Armor.", "ARMOR"),
        pilot_evasion: stat("Pilot evasion", "Adds to the pilot's Evasion.", "EVASION"),
        pilot_edef: stat("Pilot E-Defense", "Adds to the pilot's E-Defense.", "E-DEFENSE"),
        pilot_speed: stat("Pilot speed", "Adds to the pilot's Speed.", "SPEED"),
        pilot_armor_slots: stat("Pilot armor slots", "Adds pilot armor slots.", "SLOTS"),
        pilot_gear_slots: stat("Pilot gear slots", "Adds pilot gear slots.", "SLOTS"),
        pilot_weapon_slots: stat("Pilot weapon slots", "Adds pilot weapon slots.", "SLOTS"),
        skill_point: plain("Skill trigger point", "Adds skill trigger points.", "POINTS"),
        mech_skill_point: plain("Mech skill point", "Adds HASE points.", "POINTS"),
        talent_point: plain("Talent point", "Adds talent points.", "POINTS"),
        license_point: plain("License point", "Adds license points.", "POINTS"),
        cb_point: plain("Core bonus point", "Adds core bonus points.", "POINTS")
    } }
];

export const BONUS_INFO = Object.fromEntries(BONUS_CATEGORIES.flatMap(category => Object.entries(category.ids).map(([id, info]) => [id, { ...info, category: category.key }])));

export function bonusCategoryOf(id)
{
    return BONUS_INFO[id]?.category ?? null;
}

export function bonusModeOf(bonus)
{
    if (bonus?.overwrite && bonus?.replace)
        return "final";
    if (bonus?.replace)
        return "replace";
    return bonus?.overwrite ? "overwrite" : "add";
}

function valueText(value)
{
    const text = Array.isArray(value) ? value.join("/") : String(value ?? "");
    return text.replaceAll(/\{([\w-]+)\}/g, (match, name) => name.toUpperCase());
}

function signed(value)
{
    const text = valueText(value);
    return /^[+-]/.test(text) ? text : `+${text}`;
}

function choiceName(names, value)
{
    const key = String(value ?? "");
    return names[key] ?? names[key.toLowerCase()] ?? key;
}

function hasValue(value)
{
    return value !== undefined && value !== null && value !== "";
}

function statusName(id)
{
    const effect = CONFIG.statusEffects?.find(status => status.id === id);
    return effect?.name ? game.i18n.localize(effect.name) : null;
}

function choiceChip(bonus)
{
    const value = bonus.val;
    if (bonus.id === "extra_action")
    {
        const kind = String(value ?? "").toLowerCase();
        return { icon: ACTION_ICONS[kind] ?? "cci cci-reaction", text: `+1 extra ${choiceName(ACTION_KIND_NAMES, kind)}` };
    }
    if (bonus.id === "add_weapon_type")
        return { icon: "mdi mdi-sword", text: `Counts as ${choiceName(WEAPON_TYPE_NAMES, value)}` };
    if (bonus.id === "add_mount")
        return { icon: "mdi mdi-plus-box", text: `+1 ${choiceName(MOUNT_TYPE_NAMES, value)} mount${hasValue(bonus.max) ? ` while under ${bonus.max} mounts` : ""}` };
    const subject = statusName(value) ?? choiceName(DEFENSE_SUBJECT_NAMES, value);
    if (bonus.id === "immunity")
        return { icon: "mdi mdi-shield", text: `Immune to ${subject}` };
    const owner = { deployable_resist: "Deployables resist", drone_resist: "Drones resist" }[bonus.id] ?? "Resist";
    return { icon: "mdi mdi-shield-half-full", text: `${owner} ${subject}` };
}

export function bonusValueChip(bonus)
{
    const info = BONUS_INFO[bonus?.id];
    const label = info?.label ?? String(bonus?.id ?? "").replaceAll("_", " ");
    const tip = escapeHtml(info?.desc ?? "");
    if (info?.choices && hasValue(bonus.val))
        return { ...choiceChip(bonus), tip };
    if (!hasValue(bonus?.val))
        return info && !info.value && !info.roll ? { icon: "mdi mdi-plus-box", text: label, tip } : null;
    const mode = info?.mode ? bonusModeOf(bonus) : "add";
    const value = valueText(bonus.val);
    const texts = {
        add: `${signed(bonus.val)} ${label}`,
        overwrite: `${signed(bonus.val)} ${label}, highest wins`,
        replace: `${label} base ${value}`,
        final: `${label} = ${value}`
    };
    return { icon: "mdi mdi-plus-box", text: texts[mode], tip };
}

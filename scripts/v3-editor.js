import { MODULE_ID, escapeHtml } from "./utils.js";
import { BONUS_CATEGORIES, BONUS_INFO, bonusCategoryOf, bonusModeOf, WEAPON_TYPE_NAMES } from "./v3-bonus-ids.js";

const FormApplicationBase = foundry.appv1?.api?.FormApplication ?? globalThis.FormApplication;

const STATS = { hull: "HULL", agi: "AGILITY", sys: "SYSTEMS", eng: "ENGINEERING" };
const HOW_OPTIONS = {
    "": "AUTOMATIC",
    ...Object.fromEntries(Object.entries(STATS).map(([key, name]) => [`save:${key}`, `${name} SAVE`])),
    "attack:melee": "MELEE ATTACK",
    "attack:ranged": "RANGED ATTACK",
    "attack:tech": "TECH ATTACK"
};
const TARGETS = { enemy: "ENEMY", ally: "ALLY", self: "SELF", any: "ANY" };
const DURATIONS = {
    "": "REST OF THE ENCOUNTER",
    start_turn_self: "UNTIL THE START OF YOUR TURN",
    end_turn_self: "UNTIL THE END OF YOUR TURN",
    next_turn_start_self: "UNTIL THE START OF YOUR NEXT TURN",
    next_turn_end_self: "UNTIL THE END OF YOUR NEXT TURN",
    start_turn_target: "UNTIL THE START OF THE TARGET'S TURN",
    end_turn_target: "UNTIL THE END OF THE TARGET'S TURN",
    next_turn_start_target: "UNTIL THE START OF THE TARGET'S NEXT TURN",
    next_turn_end_target: "UNTIL THE END OF THE TARGET'S NEXT TURN",
    round_end_0: "UNTIL THE END OF THIS ROUND",
    round_start_1: "UNTIL THE START OF NEXT ROUND",
    round_end_1: "UNTIL THE END OF NEXT ROUND"
};
const ATTACKS = { "": "NONE", melee: "MELEE", ranged: "RANGED", tech: "TECH" };
const DAMAGE_TYPES = { Kinetic: "KINETIC", Energy: "ENERGY", Explosive: "EXPLOSIVE", Heat: "HEAT", Burn: "BURN", Variable: "VARIABLE" };
const RANGE_TYPES = { Range: "RANGE", Threat: "THREAT", Line: "LINE", Cone: "CONE", Blast: "BLAST", Burst: "BURST", Thrown: "THROWN" };
const RESIST_MODES = { resistance: "RESISTANCE", vulnerability: "VULNERABILITY", immunity: "IMMUNITY" };
const RESIST_NOTES = { resistance: "Takes half damage from that type.", vulnerability: "Takes double damage from that type.", immunity: "Takes no damage from that type, or cannot gain that status." };
const DAMAGE_SUBJECTS = { kinetic: "KINETIC", energy: "ENERGY", explosive: "EXPLOSIVE", heat: "HEAT", burn: "BURN", aoe: "AREA DAMAGE", all: "ALL DAMAGE" };
const OTHER_TYPES = { overshield: "OVERSHIELD", hp: "HP", repairs: "REPAIRS", cover: "COVER", corepower: "CORE POWER", heat: "HEAT", speed: "SPEED" };
const OTHER_NOTES = {
    overshield: "Grants that much Overshield.",
    hp: "Restores that much HP, up to the maximum.",
    repairs: "Grants that many Repairs, up to the Repair Capacity.",
    cover: "Gives cover.",
    corepower: "Restores CORE Power.",
    heat: "Heat, by that amount.",
    speed: "Speed, by that amount."
};
const PERIODS = { unlimited: "UNLIMITED", turn: "TURN", round: "ROUND", scene: "SCENE (ENCOUNTER)", mission: "MISSION" };
const HIT_TYPES = { hit: "ON A HIT", crit: "ON A CRIT", miss: "ON A MISS", attack: "ON ANY ATTACK" };
const DAMAGE_TARGETS = { "": "TARGET", self: "SELF" };
const ENTRY_TARGETS = { "": "NOT SET", enemy: "ENEMIES", ally: "ALLIES", self: "YOURSELF", any: "ANYONE" };
const COVER_LEVELS = { soft: "SOFT", hard: "HARD" };
const AREA_SHAPES = { "": "NONE", yes: "UNSPECIFIED", burst: "BURST", blast: "BLAST", cone: "CONE", line: "LINE" };
const SHAPED_AREAS = new Set(["burst", "blast", "cone", "line"]);
const MODE_OPTIONS = { add: "ADD", overwrite: "HIGHEST WINS", replace: "REPLACES BASE", final: "SET FINAL" };
const REPLACE_MODES = { add: "ADD", replace: "REPLACES BASE" };
const WEAPON_TYPES = Object.fromEntries(Object.keys(WEAPON_TYPE_NAMES).map(key => [key, key.toUpperCase()]));
const WEAPON_SIZES = { Auxiliary: "AUXILIARY", Main: "MAIN", Heavy: "HEAVY", Superheavy: "SUPERHEAVY" };
const FILTER_DAMAGE_TYPES = { Kinetic: "KINETIC", Energy: "ENERGY", Explosive: "EXPLOSIVE", Heat: "HEAT", Burn: "BURN" };
const CONDITION_IDS = ["immobilized", "impaired", "jammed", "lockon", "shredded", "slow", "stunned"];
const STATUS_IDS = ["dangerzone", "downandout", "engaged", "exposed", "hidden", "invisible", "prone", "shutdown"];
const INTERNAL_STATUS = /^(npc_tier_|resistance_)/;
const CUSTOM_WHEN = "__custom";
const OTHER_STATE = "__other";
const MULTI_SEPARATOR = "::";
const KIND_ROWS = [
    ["ON TARGETS", ["status", "special", "remove_special", "resist", "other"]],
    ["DAMAGE AND ROLLS", ["damage", "bonus_damage", "attack", "save", "range"]],
    ["RULES", ["bonus", "frequency", "duration", "target"]]
];
const CUSTOM_HINT = "On while the result is 1 or more. {exposed} and other status ids are 1 while you have that status. {grit}, {ll}, {tier} and the stats read their value.";

function hasValue(value)
{
    return value !== undefined && value !== null && value !== "";
}

function setOrDelete(target, key, value)
{
    if (value === undefined || value === null || value === "" || value === false)
        delete target[key];
    else
        target[key] = value;
}

function capitalizeType(value, fallback)
{
    const text = String(value ?? fallback);
    return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function statKey(value)
{
    const raw = typeof value === "object" && value ? value.stat : value;
    const key = String(raw ?? "").trim().toLowerCase().slice(0, 3);
    if (key === "hul")
        return "hull";
    return ["agi", "sys", "eng"].includes(key) ? key : "";
}

function tierText(value)
{
    return Array.isArray(value) ? value.join("/") : (value ?? "");
}

function parseValue(text)
{
    const raw = String(text ?? "").trim();
    if (!raw)
        return null;
    const parts = raw.split("/").map(part => part.trim());
    const values = parts.map(part => (/^-?\d+(\.\d+)?$/.test(part) ? Number(part) : part));
    if (values.length === 3)
        return values;
    return parts.length === 1 ? values[0] : raw;
}

function areaParts(value)
{
    if (value === true)
        return { shape: "yes", size: "" };
    const raw = typeof value === "string" ? value.trim() : "";
    const match = /^(burst|blast|cone|line)(.*)$/i.exec(raw);
    return match ? { shape: match[1].toLowerCase(), size: match[2].trim() } : { shape: raw, size: "" };
}

function areaValue(shape, size)
{
    if (!shape)
        return null;
    if (shape === "yes")
        return true;
    return SHAPED_AREAS.has(shape) ? `${shape} ${String(size ?? "").trim()}`.trim() : shape;
}

function flatOptions(options)
{
    return Object.fromEntries(Object.entries(options).flatMap(([key, label]) => (label && typeof label === "object" ? Object.entries(label) : [[key, label]])));
}

function listOf(value)
{
    return (Array.isArray(value) ? value : (hasValue(value) ? [value] : [])).map(String);
}

function liveStatuses()
{
    return (CONFIG.statusEffects ?? []).filter(effect => effect?.id && !INTERNAL_STATUS.test(effect.id));
}

function statusName(effect)
{
    return game.i18n.localize(effect?.name ?? effect?.id ?? "").toUpperCase();
}

function statusGroups(keyOf = id => id, labelOf = name => name)
{
    const effects = liveStatuses();
    const listed = new Set([...CONDITION_IDS, ...STATUS_IDS]);
    const pick = ids => Object.fromEntries(ids.map(id => effects.find(effect => effect.id === id)).filter(Boolean).map(effect => [keyOf(effect.id), labelOf(statusName(effect))]));
    return {
        CONDITIONS: pick(CONDITION_IDS),
        STATUSES: pick(STATUS_IDS),
        "OTHER STATES": pick([...new Set(effects.map(effect => effect.id))].filter(id => !listed.has(id)))
    };
}

function statusOptions()
{
    return flatOptions(statusGroups());
}

function statusDescription(id)
{
    const effect = CONFIG.statusEffects?.find(status => status.id === id);
    const raw = effect?.description ? game.i18n.localize(effect.description) : "";
    return raw.replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ").trim();
}

function whenOptions()
{
    return { "": "ALWAYS", ...statusGroups(id => `{${id}}`, name => `WHILE ${name}`), [CUSTOM_WHEN]: "CUSTOM EXPRESSION" };
}

function readWhen(source)
{
    const condition = String(source.condition ?? "").trim();
    if (!condition)
        return "";
    return condition in flatOptions(whenOptions()) ? condition : CUSTOM_WHEN;
}

function readHow(source)
{
    const stat = statKey(source.save);
    if (stat)
        return `save:${stat}`;
    return source.attack ? `attack:${source.attack}` : "";
}

function writeHow(target, value)
{
    const [mode, which] = String(value ?? "").split(":");
    const previous = target.save;
    delete target.save;
    delete target.attack;
    if (mode === "save")
        target.save = typeof previous === "object" && previous?.aoe ? { ...previous, stat: which } : which;
    else if (mode === "attack")
        target.attack = which;
}

function isSelfTarget(values)
{
    return [values.target_enemy, values.target_any, values.target_ally, values.damage_target].includes("self");
}

function bonusInfo(values)
{
    return BONUS_INFO[values.bonus_id] ?? null;
}

function categoryIds(category)
{
    return BONUS_CATEGORIES.find(entry => entry.key === category)?.ids ?? {};
}

function specialAttributes(item)
{
    return [...new Set(flagEntries(item).flatMap(entry => rawList(entry.data, "add_special")).map(special => (typeof special === "string" ? special : special?.attribute)).filter(Boolean))];
}

function defenseOptions(attack)
{
    return attack === "tech" ? { "": "E-DEFENSE", evasion: "EVASION" } : { "": "EVASION", edef: "E-DEFENSE" };
}

function readDefense(source)
{
    const defense = source.target_defense ?? "";
    if ((source.attack === "tech" && defense === "edef") || (source.attack !== "tech" && defense === "evasion"))
        return "";
    return defense;
}

const noop = () => {};
const select = (label, options, read, write, extra = {}) => ({ label, input: "select", options, read, write, ...extra });
const text = (label, read, write, placeholder = "", extra = {}) => ({ label, input: "text", read, write, placeholder, ...extra });
const check = (label, key, extra = {}) => ({ label, input: "checkbox", read: source => !!source[key], write: (target, value) => setOrDelete(target, key, !!value), ...extra });
const tiered = (label, key, placeholder = "", extra = {}) => text(label, source => tierText(source[key]), (target, value) => setOrDelete(target, key, parseValue(value)), placeholder, extra);
const plain = (label, key, placeholder = "", extra = {}) => text(label, source => source[key] ?? "", (target, value) => setOrDelete(target, key, String(value ?? "").trim()), placeholder, extra);
const targetSelect = (fallback) => select("TARGET", () => TARGETS, source => source.target ?? fallback, (target, value) => setOrDelete(target, "target", value === fallback ? "" : value));
const dynamic = (label, control, read, write, extra = {}) => ({ label, input: "dynamic", control, read, write, ...extra });
const multi = (label, key, choices) => ({ label, input: "multi", choices, read: source => listOf(source[key]), write: (target, value) => setOrDelete(target, key, value?.length ? value : null) });
const saveArea = source => (typeof source.save === "object" ? source.save?.aoe : null);

const FIELDS = {
    status_id: select("STATUS", () => statusGroups(), source => source.id ?? Object.keys(statusOptions())[0] ?? "", (target, value) => setOrDelete(target, "id", value)),
    status_val: select(values => (values.status_id === "immunity" ? "AGAINST" : "COVER"), values => (values.status_id === "immunity" ? statusOptions() : COVER_LEVELS), source => source.val ?? "", (target, value) => setOrDelete(target, "val", value), { when: values => ["cover", "immunity"].includes(values.status_id), resetOn: ["status_id"] }),
    target_enemy: targetSelect("enemy"),
    target_any: targetSelect("any"),
    target_ally: targetSelect("ally"),
    how: select("HOW IT LANDS", () => HOW_OPTIONS, readHow, writeHow),
    duration: select("LASTS", () => DURATIONS, source => source.duration ?? "", (target, value) => setOrDelete(target, "duration", value)),
    aoe: select("AREA", () => AREA_SHAPES, source => areaParts(source.aoe).shape, (target, value, values) => setOrDelete(target, "aoe", areaValue(value, values.aoe_size)), { when: values => !isSelfTarget(values) }),
    aoe_size: text("SIZE", source => areaParts(source.aoe).size, noop, "e.g. 2", { when: values => !isSelfTarget(values) && SHAPED_AREAS.has(values.aoe) }),
    attack: select("ATTACK", () => ATTACKS, source => source.attack ?? "", (target, value) => setOrDelete(target, "attack", value)),
    save_stat: select("STAT", () => STATS, source => statKey(source.save) || "hull", (target, value, values) =>
    {
        const aoe = areaValue(values.save_aoe, values.save_aoe_size);
        target.save = aoe ? { stat: value, aoe } : value;
    }),
    save_aoe: select("AREA", () => AREA_SHAPES, source => areaParts(saveArea(source)).shape, noop),
    save_aoe_size: text("SIZE", source => areaParts(saveArea(source)).size, noop, "e.g. 2", { when: values => SHAPED_AREAS.has(values.save_aoe) }),
    damage_type: select("TYPE", () => DAMAGE_TYPES, source => capitalizeType(source.type, "Kinetic"), (target, value) => setOrDelete(target, "type", value), { noSelf: true }),
    damage_val: tiered("AMOUNT", "val", "e.g. 2, 1d6, or 3/4/5 by tier", { noSelf: true }),
    ap: check("AP", "ap"),
    irreducible: check("IRREDUCIBLE", "irreducible"),
    overkill: check("OVERKILL", "overkill"),
    override: check("IGNORES BONUSES", "override"),
    save_half: check("HALF DAMAGE", "save_half", { when: values => String(values.how ?? "").startsWith("save:") }),
    reliable: tiered("RELIABLE", "reliable", "damage on a miss"),
    damage_bonus: tiered("SHOWN BONUS", "bonus", "e.g. 2"),
    damage_target: select("DEALT TO", () => DAMAGE_TARGETS, source => (source.target === "self" ? "self" : ""), (target, value) => setOrDelete(target, "target", value)),
    range_type: select("TYPE", () => RANGE_TYPES, source => capitalizeType(source.type, "Range"), (target, value) => setOrDelete(target, "type", value), { noSelf: true }),
    range_val: text("VALUE", source => tierText(source.val ?? source.value), (target, value) =>
    {
        delete target.value;
        setOrDelete(target, "val", parseValue(value));
    }, "e.g. 5 or 3/4/5", { noSelf: true }),
    range_min: tiered("MINIMUM", "min", "e.g. 3"),
    range_bonus: tiered("SHOWN BONUS", "bonus", "e.g. 1"),
    freq_period: select("PER", () => PERIODS, source =>
    {
        const period = String(source.frequency ?? "").split("/")[1]?.trim().toLowerCase();
        if (period === "encounter")
            return "scene";
        if (period && PERIODS[period])
            return period;
        return source.frequency ? "unlimited" : "round";
    }, noop),
    freq_count: text("USES", source => Number.parseInt(String(source.frequency ?? "").split("/")[0]) || 1, (target, value, values) =>
    {
        const period = values.freq_period;
        if (!period || period === "unlimited")
            delete target.frequency;
        else
            target.frequency = `${Math.max(1, Number.parseInt(value) || 1)}/${period}`;
    }, "e.g. 1", { when: values => values.freq_period !== "unlimited" }),
    attribute: plain("NAME", "attribute", "one short line"),
    detail: plain("SHOWN ON HOVER", "detail", "what it does"),
    end_state: select("STATE", (values, item) => ({ ...Object.fromEntries(specialAttributes(item).map(name => [name, `${name.toUpperCase()} (THIS ITEM)`])), [OTHER_STATE]: "OTHER NAME…" }), source => source.attribute || OTHER_STATE, (target, value, values) =>
        setOrDelete(target, "attribute", value === OTHER_STATE ? String(values.end_state_other ?? "").trim() : value)),
    end_state_other: plain("NAME", "unused", "exactly as it was set", { read: () => "", write: noop, when: values => values.end_state === OTHER_STATE }),
    resist_mode: select("KIND", () => RESIST_MODES, source =>
    {
        if (source.immunity)
            return "immunity";
        return source.vulnerable || source.vulnerability ? "vulnerability" : "resistance";
    }, (target, value, values) =>
    {
        ["resist", "resistance", "vulnerable", "vulnerability", "immunity"].forEach(key => delete target[key]);
        target[value] = values.resist_subject;
    }),
    resist_subject: select("AGAINST", values => (values.resist_mode === "immunity" ? { ...DAMAGE_SUBJECTS, ...statusOptions() } : DAMAGE_SUBJECTS), source =>
        String(source.immunity ?? source.resist ?? source.resistance ?? source.vulnerable ?? source.vulnerability ?? "kinetic").toLowerCase(), noop, { resetOn: ["resist_mode"] }),
    other_type: select("TYPE", () => OTHER_TYPES, source => String(source.type ?? source.id ?? "overshield").toLowerCase(), (target, value) =>
    {
        delete target.id;
        target.type = value;
    }),
    other_val: dynamic(values => OTHER_TYPES[values.other_type] ?? "VALUE", values => (values.other_type === "cover"
        ? { input: "select", options: { ...COVER_LEVELS, none: "NONE" } }
        : { input: "text", placeholder: "e.g. 4, {grit} + 4 or 2/3/4" }), source => tierText(source.val), (target, value) => setOrDelete(target, "val", parseValue(value)), { resetOn: ["other_type"] }),
    bonus_val: tiered("AMOUNT", "val", "e.g. 1d6 or 2"),
    weapon_types: multi("WEAPON TYPES", "weapon_types", WEAPON_TYPES),
    weapon_sizes: multi("WEAPON SIZES", "weapon_sizes", WEAPON_SIZES),
    damage_types: multi("DAMAGE TYPES", "damage_types", FILTER_DAMAGE_TYPES),
    range_types: multi("RANGE TYPES", "range_types", RANGE_TYPES),
    weapons_open: { label: "LIMIT", input: "checkbox", read: () => false, write: noop },
    hit_type: select("WHEN", () => HIT_TYPES, source => source.hit_type ?? "hit", (target, value) => setOrDelete(target, "hit_type", value === "hit" ? null : value)),
    bonus_damage_type: select("TYPE", () => ({ "": "SAME AS THE ATTACK", ...DAMAGE_TYPES }), source => (source.type ? capitalizeType(source.type) : ""), (target, value) => setOrDelete(target, "type", value)),
    target_defense: select("AGAINST", values => defenseOptions(values.attack), readDefense, (target, value) => setOrDelete(target, "target_defense", value), { when: values => !!values.attack, resetOn: ["attack"] }),
    can_crit: check("CAN CRIT", "can_crit", { when: values => !!values.attack }),
    accuracy: tiered("ACCURACY", "accuracy", "e.g. 1, -1 = Difficulty", { when: values => ["melee", "ranged"].includes(values.attack) }),
    attack_bonus: tiered("ATTACK BONUS", "attack_bonus", "e.g. 2", { when: values => ["melee", "ranged"].includes(values.attack) }),
    tech_accuracy: tiered("TECH ACCURACY", "tech_accuracy", "e.g. 1, -1 = Difficulty", { when: values => values.attack === "tech" }),
    tech_attack_bonus: tiered("TECH ATTACK BONUS", "tech_attack_bonus", "e.g. 2", { when: values => values.attack === "tech" }),
    bonus_category: { label: "CATEGORY", input: "categories", read: source => bonusCategoryOf(source.id ?? "attack") ?? "", write: noop },
    bonus_id: select("TYPE", values => Object.fromEntries(Object.entries(categoryIds(values.bonus_category)).map(([id, info]) => [id, info.label.toUpperCase()])), source => source.id ?? "attack", (target, value) => setOrDelete(target, "id", value)),
    bonus_value: dynamic(values => bonusInfo(values)?.value ?? "VALUE", values =>
    {
        const info = bonusInfo(values);
        if (info?.choices)
            return { input: "select", options: Object.fromEntries(Object.entries(info.choices(statusOptions())).map(([key, name]) => [key, String(name).toUpperCase()])) };
        return { input: "text", placeholder: info?.placeholder ?? "e.g. 2, {grit} or 1/2/3" };
    }, source => tierText(source.val), (target, value) => setOrDelete(target, "val", parseValue(value)), { when: values => !bonusInfo(values) || !!bonusInfo(values).value, resetOn: ["bonus_id"] }),
    bonus_accuracy: tiered("ACCURACY", "accuracy", "e.g. 1, -1 = Difficulty", { when: values => !!bonusInfo(values)?.roll }),
    bonus_mode: select("MODE", values => (bonusInfo(values)?.mode === "replace" ? REPLACE_MODES : MODE_OPTIONS), source => bonusModeOf(source), (target, value) =>
    {
        setOrDelete(target, "overwrite", value === "overwrite" || value === "final");
        setOrDelete(target, "replace", value === "replace" || value === "final");
    }, { when: values => !!bonusInfo(values)?.mode, resetOn: ["bonus_id"] }),
    bonus_max: tiered("WHILE FEWER MOUNTS THAN", "max", "e.g. 3", { when: values => !!bonusInfo(values)?.max }),
    bonus_when: select("WHEN", () => whenOptions(), readWhen, (target, value, values) =>
        setOrDelete(target, "condition", value === CUSTOM_WHEN ? String(values.bonus_when_expression ?? "").trim() : value)),
    bonus_when_expression: text("EXPRESSION", source => (readWhen(source) === CUSTOM_WHEN ? source.condition : ""), noop, "e.g. {grit} >= 3", { when: values => values.bonus_when === CUSTOM_WHEN }),
    entry_target: select("PICKS", () => ENTRY_TARGETS, source => source.target ?? "", (target, value) => setOrDelete(target, "target", value))
};

const wide = field => ({ field, wide: true });
const pills = (fields, label = "", extra = {}) => ({ pills: fields, label, wide: true, ...extra });
const note = (textOf, className = "npci-desc") => ({ note: textOf, className });
const weapons = (fields, extra = {}) => ({ weapons: fields, ...extra });
const targeting = targetField => ["TARGETING", [targetField, "how", wide("duration"), "aoe", "aoe_size"]];
const BONUS_WEAPON_FILTERS = ["weapon_types", "weapon_sizes", "range_types", "damage_types"];

export const KINDS = {
    status: { label: "STATUS", icon: "mdi mdi-alert-circle-outline", list: "add_status", groups: [
        ["STATUS", [wide("status_id"), note(values => statusDescription(values.status_id)), "status_val"]],
        targeting("target_enemy")
    ] },
    save: { label: "SAVE", icon: "cci cci-save", keys: ["save"], groups: [
        ["SAVE", [wide("save_stat"), note(() => "Targets roll this save against the whole effect. A success cancels all of it."), "save_aoe", "save_aoe_size"]]
    ] },
    damage: { label: "DAMAGE", icon: "cci cci-explosive", list: "damage", groups: [
        ["DAMAGE", ["damage_type", "damage_val", pills(["ap", "irreducible", "overkill", "override"], "TAGS"), "reliable", "damage_bonus"]],
        ["TARGETING", ["damage_target", "how", pills(["save_half"], "ON A SUCCESSFUL SAVE"), "aoe", "aoe_size"]]
    ] },
    range: { label: "RANGE", icon: "cci cci-range", list: "range", groups: [
        ["RANGE", ["range_type", "range_val", "range_min", "range_bonus", pills(["override"], "TAGS")]]
    ] },
    frequency: { label: "FREQUENCY", icon: "mdi mdi-update", keys: ["frequency"], groups: [
        ["FREQUENCY", ["freq_period", "freq_count"]]
    ] },
    duration: { label: "DURATION", icon: "mdi mdi-timer-sand", keys: ["duration"], groups: [
        ["DURATION", [wide("duration")]]
    ] },
    special: { label: "SPECIAL STATE", icon: "mdi mdi-star-four-points", list: "add_special", stringKey: "attribute", groups: [
        ["SPECIAL STATE", ["attribute", wide("detail")]],
        targeting("target_enemy")
    ] },
    remove_special: { label: "END SPECIAL STATE", icon: "mdi mdi-star-off", list: "remove_special", asString: "attribute", groups: [
        ["END SPECIAL STATE", [wide("end_state"), wide("end_state_other")]]
    ] },
    resist: { label: "RESISTANCE", icon: "mdi mdi-shield-half-full", list: "add_resist", groups: [
        ["RESISTANCE", ["resist_mode", "resist_subject", note(values => RESIST_NOTES[values.resist_mode])]],
        targeting("target_any"),
        ["", [note(values => (values.target_any === "self" && !values.how ? "Target Self and automatic: when this effect holds nothing else, L.A applies it at the start of each encounter." : null), "npci-hint")]]
    ] },
    other: { label: "OTHER EFFECT", icon: "mdi mdi-plus-box", list: "add_other", groups: [
        ["OTHER EFFECT", ["other_type", "other_val", note(values => OTHER_NOTES[values.other_type])]],
        targeting("target_ally")
    ] },
    bonus_damage: { label: "BONUS DAMAGE", icon: "cci cci-variable", list: "bonus_damage", stringKey: "val", single: true, groups: [
        ["BONUS DAMAGE", ["bonus_val", "bonus_damage_type", "hit_type", weapons(["weapon_types", "weapon_sizes"]), wide("detail")]]
    ] },
    attack: { label: "ATTACK", icon: "mdi mdi-bullseye-arrow", keys: ["attack", "target_defense", "can_crit", "accuracy", "attack_bonus", "tech_accuracy", "tech_attack_bonus"], groups: [
        ["ATTACK", ["attack", "target_defense", "accuracy", "attack_bonus", "tech_accuracy", "tech_attack_bonus", pills(["can_crit"], "TAGS")]]
    ] },
    bonus: { label: "BONUS", icon: "mdi mdi-plus-box-multiple", list: "bonuses", groups: [
        ["BONUS", [
            { categories: "bonus_category" },
            "bonus_id", "bonus_value",
            note(values => bonusInfo(values)?.desc),
            "bonus_accuracy", "bonus_mode", "bonus_max",
            "bonus_when", wide("bonus_when_expression"),
            note(values => (values.bonus_when === CUSTOM_WHEN ? CUSTOM_HINT : null), "npci-hint"),
            weapons(BONUS_WEAPON_FILTERS, { when: values => !bonusInfo(values) || !!bonusInfo(values).weapons })
        ]]
    ] },
    target: { label: "TARGET", icon: "mdi mdi-target-account", keys: ["target"], groups: [
        ["TARGET", [wide("entry_target"), note(() => "Who this effect selects first when it is used.")]]
    ] }
};

function cellFields(cell)
{
    if (typeof cell === "string")
        return [cell];
    if (cell.pills)
        return cell.pills;
    if (cell.weapons)
        return [...cell.weapons, "weapons_open"];
    if (cell.categories)
        return [cell.categories];
    return cell.field ? [cell.field] : [];
}

for (const kind of Object.values(KINDS))
    kind.fields = kind.groups.flatMap(([, cells]) => cells.flatMap(cellFields));

function flagEntries(item)
{
    return foundry.utils.deepClone(item.flags?.[MODULE_ID]?.v3?.entries ?? []);
}

function rawList(data, key)
{
    const value = data?.[key];
    if (value === undefined || value === null)
        return [];
    return Array.isArray(value) ? [...value] : [value];
}

function storeList(data, kind, values)
{
    if (!values.length)
        delete data[kind.list];
    else if (kind.single && values.length === 1)
        data[kind.list] = values[0];
    else
        data[kind.list] = values;
}

function sourceOf(kind, raw)
{
    if (kind.asString)
        return { [kind.asString]: typeof raw === "string" ? raw : (raw?.[kind.asString] ?? "") };
    if (raw && typeof raw === "object")
        return raw;
    return hasValue(raw) ? { [kind.stringKey ?? "id"]: raw } : {};
}

function hasIndex(ref)
{
    return Number.isInteger(ref.index) && ref.index >= 0;
}

function activeFields(kind, ref)
{
    return kind.fields.filter(field => !(ref.self && FIELDS[field].noSelf));
}

function fieldShown(name, values, ref)
{
    const field = FIELDS[name];
    return !(ref.self && field.noSelf) && (!field.when || field.when(values));
}

function shownFields(kind, values, ref)
{
    const shown = new Set();
    for (const [, cells] of kind.groups)
    {
        for (const cell of cells)
        {
            if (typeof cell !== "string" && cell.when && !cell.when(values))
                continue;
            cellFields(cell).filter(name => fieldShown(name, values, ref)).forEach(name => shown.add(name));
        }
    }
    return shown;
}

export function readValues(item, ref, kindName)
{
    const kind = KINDS[kindName];
    const data = flagEntries(item).find(entry => entry.path === ref.path)?.data ?? {};
    let source = data;
    if (kind.list && !ref.self)
        source = sourceOf(kind, hasIndex(ref) && !ref.isNew ? rawList(data, kind.list)[ref.index] : null);
    return Object.fromEntries(activeFields(kind, ref).map(field => [field, FIELDS[field].read(source)]));
}

async function saveEntries(item, entries)
{
    const kept = entries.filter(entry => entry.data && Object.keys(entry.data).some(key => key !== "name"));
    const pack = item.flags?.[MODULE_ID]?.v3?.pack ?? "";
    await item.update({ [`flags.${MODULE_ID}.==v3`]: { pack, entries: kept } });
}

export function applyValues(item, ref, kindName, values)
{
    const kind = KINDS[kindName];
    const entries = flagEntries(item);
    let entry = entries.find(candidate => candidate.path === ref.path);
    if (!entry)
    {
        entry = { path: ref.path, data: {} };
        entries.push(entry);
    }
    entry.data ??= {};
    const shown = shownFields(kind, values, ref);
    const writeAll = (target) => activeFields(kind, ref).forEach(field => FIELDS[field].write(target, shown.has(field) ? values[field] : undefined, values));
    if (!kind.list || ref.self)
    {
        writeAll(entry.data);
        return { entries, ref: { path: ref.path, kind: kindName, self: !!ref.self } };
    }
    const items = rawList(entry.data, kind.list);
    const editing = hasIndex(ref) && !ref.isNew && ref.index < items.length;
    const target = foundry.utils.deepClone(sourceOf(kind, editing ? items[ref.index] : null));
    writeAll(target);
    const result = kind.asString ? (target[kind.asString] ?? "") : target;
    if (kind.asString && !result)
        return { entries, ref: { path: ref.path, kind: kindName, index: -1 }, empty: true };
    const index = editing ? ref.index : items.length;
    items[index] = result;
    storeList(entry.data, kind, items);
    return { entries, ref: { path: ref.path, kind: kindName, index } };
}

export async function writeValues(item, ref, kindName, values)
{
    const applied = applyValues(item, ref, kindName, values);
    if (applied.empty)
        return;
    await saveEntries(item, applied.entries);
}

export async function deleteValue(item, ref)
{
    const kind = KINDS[ref.kind];
    const entries = flagEntries(item);
    const entry = entries.find(candidate => candidate.path === ref.path);
    if (!entry?.data || (kind.list && !ref.self && !hasIndex(ref)))
        return;
    if (ref.part === "save")
    {
        if (!kind.list || ref.self)
        {
            delete entry.data.save;
            delete entry.data.save_half;
        }
        else
        {
            const items = rawList(entry.data, kind.list);
            if (items[ref.index] && typeof items[ref.index] === "object")
            {
                items[ref.index] = { ...items[ref.index] };
                delete items[ref.index].save;
                delete items[ref.index].save_half;
                storeList(entry.data, kind, items);
            }
        }
    }
    else if (ref.self)
    {
        entries.splice(entries.indexOf(entry), 1);
    }
    else if (!kind.list)
    {
        (ref.key ? [ref.key] : kind.keys).forEach(key => delete entry.data[key]);
    }
    else
    {
        const items = rawList(entry.data, kind.list);
        items.splice(ref.index, 1);
        storeList(entry.data, kind, items);
    }
    await saveEntries(item, entries);
}

function optionsHtml(options, value)
{
    const current = String(value ?? "");
    const option = ([key, label]) => `<option value="${escapeHtml(key)}"${key === current ? " selected" : ""}>${escapeHtml(label)}</option>`;
    const parts = Object.entries(options).map(([key, label]) => (label && typeof label === "object"
        ? (Object.keys(label).length ? `<optgroup label="${escapeHtml(key)}">${Object.entries(label).map(option).join("")}</optgroup>` : "")
        : option([key, label])));
    if (hasValue(value) && !(current in flatOptions(options)))
        parts.push(option([current, current.toUpperCase()]));
    return parts.join("");
}

function resolveControl(name, value, values, item)
{
    const field = FIELDS[name];
    const control = field.input === "dynamic" ? field.control(values ?? {}, value) : field;
    if (control.input !== "select")
        return control;
    return { ...control, options: typeof control.options === "function" ? control.options(values ?? {}, item) : control.options };
}

function fieldLabel(name, values)
{
    const label = FIELDS[name].label;
    return typeof label === "function" ? label(values) : label;
}

function multiHtml(name, value, choices)
{
    const chosen = listOf(value);
    const lower = new Set(chosen.map(entry => entry.toLowerCase()));
    const known = new Set(Object.keys(choices).map(key => key.toLowerCase()));
    const extra = chosen.filter(entry => !known.has(entry.toLowerCase())).map(entry => [entry, entry.toUpperCase()]);
    return [...Object.entries(choices), ...extra].map(([key, label]) =>
        `<label class="npci-toggle"><input name="${name}${MULTI_SEPARATOR}${escapeHtml(key)}" type="checkbox"${lower.has(key.toLowerCase()) ? " checked" : ""}/><span>${escapeHtml(label)}</span></label>`).join("");
}

function categoriesHtml(name, value)
{
    return `<div class="npci-cats">${BONUS_CATEGORIES.map(category => `<label class="npci-kind${category.key === value ? " active" : ""}"><input type="radio" name="${name}" value="${category.key}"${category.key === value ? " checked" : ""}/><span>${category.label}</span></label>`).join("")}</div>`;
}

function controlHtml(name, value, values, item = null)
{
    const control = resolveControl(name, value, values, item);
    if (control.input === "select")
        return `<select name="${name}" data-type="String">${optionsHtml(control.options, value)}</select>`;
    if (control.input === "multi")
        return multiHtml(name, value, control.choices);
    return `<input name="${name}" value="${escapeHtml(value)}" type="text" data-dtype="String" placeholder="${escapeHtml(control.placeholder ?? FIELDS[name].placeholder ?? "")}"/>`;
}

function pillHtml(name, value)
{
    return `<label class="npci-toggle"><input name="${name}" type="checkbox"${value ? " checked" : ""}/><span>${escapeHtml(FIELDS[name].label)}</span></label>`;
}

function weaponsHtml(cell, values)
{
    const chosen = cell.weapons.flatMap(name => listOf(values[name]).map(entry => flatOptions(FIELDS[name].choices)[entry] ?? Object.entries(FIELDS[name].choices).find(([key]) => key.toLowerCase() === entry.toLowerCase())?.[1] ?? entry.toUpperCase()));
    const summary = chosen.length
        ? chosen.map(label => `<span class="npci-chosen">${escapeHtml(label)}</span>`).join("")
        : '<span class="npci-allnote">ALL WEAPONS</span>';
    const open = !!values.weapons_open;
    const limit = `<label class="npci-toggle npci-limit"><input name="weapons_open" type="checkbox"${open ? " checked" : ""}/><span><i class="fas fa-pen"></i> LIMIT</span></label>`;
    const rows = cell.weapons.map(name => `<div class="npci-field wide"><span class="npci-label">${escapeHtml(FIELDS[name].label)}</span><div class="npci-control">${multiHtml(name, values[name], FIELDS[name].choices)}</div></div>`).join("");
    return `<div class="npci-field wide npci-weapons"><span class="npci-label">WEAPONS</span><div class="npci-control">${summary}${limit}</div><div class="npci-weapon-rows"${open ? "" : " hidden"}>${rows}</div></div>`;
}

function cellHtml(cell, values, ref, item)
{
    if (typeof cell !== "string" && cell.when && !cell.when(values))
        return "";
    if (typeof cell !== "string" && cell.note)
    {
        const textValue = cell.note(values, item);
        return textValue ? `<div class="${cell.className}">${escapeHtml(textValue)}</div>` : "";
    }
    if (typeof cell !== "string" && cell.weapons)
        return weaponsHtml(cell, values);
    if (typeof cell !== "string" && cell.categories)
        return categoriesHtml(cell.categories, values[cell.categories]);
    if (typeof cell !== "string" && cell.pills)
    {
        const shown = cell.pills.filter(name => fieldShown(name, values, ref));
        if (!shown.length)
            return "";
        const label = cell.label ? `<span class="npci-label">${escapeHtml(cell.label)}</span>` : "";
        return `<div class="npci-field${cell.wide ? " wide" : ""}">${label}<div class="npci-control">${shown.map(name => pillHtml(name, values[name])).join("")}</div></div>`;
    }
    const name = typeof cell === "string" ? cell : cell.field;
    if (!fieldShown(name, values, ref))
        return "";
    return `<label class="npci-field${cell.wide ? " wide" : ""}"><span class="npci-label">${escapeHtml(fieldLabel(name, values))}</span><div class="npci-control">${controlHtml(name, values[name], values, item)}</div></label>`;
}

function groupsHtml(kind, values, ref, item)
{
    return kind.groups.map(([name, cells]) =>
    {
        const inner = cells.map(cell => cellHtml(cell, values, ref, item)).join("");
        if (!inner)
            return "";
        const header = name ? `<div class="lancer-header lancer-primary npci-section">${name}</div>` : "";
        return `<div class="npci-group">${header}<div class="npci-grid">${inner}</div></div>`;
    }).join("");
}

function kindTilesHtml(current)
{
    return `<div class="npci-kindrows">${KIND_ROWS.map(([label, keys]) => `<div class="npci-kindrow"><span class="npci-label">${label}</span><div class="npci-kindgrid">${keys.map(key => `<button type="button" class="npci-kind${key === current ? " active" : ""}" data-kind="${key}"><i class="${KINDS[key].icon}"></i><span>${KINDS[key].label}</span></button>`).join("")}</div></div>`).join("")}</div>`;
}

function collectValues(formData)
{
    const values = { ...formData };
    for (const [key, checked] of Object.entries(formData))
    {
        const [name, choice] = key.split(MULTI_SEPARATOR);
        if (choice === undefined)
            continue;
        values[name] ??= [];
        if (checked)
            values[name].push(choice);
    }
    return values;
}

export class V3DataEditor extends FormApplicationBase
{
    constructor(item, ref, options = {})
    {
        super({}, options);
        this.item = item;
        this.ref = ref;
        this.kindName = ref.kind ?? "status";
        this.values = null;
    }

    static get defaultOptions()
    {
        return foundry.utils.mergeObject(super.defaultOptions, {
            classes: ["lancer", "targeted-form-editor", "npci-v3-editor"],
            width: 460,
            height: "auto",
            submitOnChange: false,
            submitOnClose: false,
            closeOnSubmit: true
        });
    }

    get title()
    {
        return `${this.ref.isNew ? "Add" : "Edit"} v3 data: ${this.item.name}`;
    }

    _bodyHtml()
    {
        return groupsHtml(KINDS[this.kindName], this.values, this.ref, this.item);
    }

    async _renderInner()
    {
        const kind = KINDS[this.kindName];
        this.values ??= readValues(this.item, this.ref, this.kindName);
        const source = [this.item.name, this.ref.label].filter(Boolean).map(escapeHtml).join(" · ");
        const header = `<div class="lancer-header lancer-primary npci-head"><i class="${kind.icon} i--3 i--light"></i><span class="major">${kind.label}</span><span class="npci-source">${source}</span></div>`;
        const tiles = this.ref.isNew ? kindTilesHtml(this.kindName) : "";
        const preview = this.options.preview ? '<div class="npci-preview" hidden><span class="npci-label">On the sheet</span><div class="npci-preview-chips"></div></div>' : "";
        const buttons = `<div class="npci-buttons"><button type="submit" data-button="confirm"><i class="fas fa-save"></i> Save</button><button type="button" data-button="cancel"><i class="fas fa-times"></i> Cancel</button></div>`;
        const html = $(`<form class="lancer" autocomplete="off" onsubmit="event.preventDefault()">${header}${tiles}<div class="npci-body">${this._bodyHtml()}</div>${preview}${buttons}</form>`);
        this.form = html[0];
        return html;
    }

    _formValues()
    {
        return { ...this.values, ...collectValues(this._getSubmitData()) };
    }

    _refresh(changedName)
    {
        const previous = this.values ?? {};
        const values = this._formValues();
        if (values.bonus_category !== previous.bonus_category && "bonus_category" in values)
            values.bonus_id = Object.keys(categoryIds(values.bonus_category))[0] ?? values.bonus_id;
        for (const [name, field] of Object.entries(FIELDS))
        {
            if (field.resetOn?.some(dependency => values[dependency] !== previous[dependency]))
                delete values[name];
        }
        this.values = values;
        const body = this.element.find(".npci-body");
        body.html(this._bodyHtml());
        if (changedName)
            body.find(`[name="${changedName}"]`).trigger("focus");
        this._updatePreview();
        this.setPosition({ height: "auto" });
    }

    _updatePreview()
    {
        const box = this.element?.find(".npci-preview");
        if (!box?.length)
            return;
        const applied = applyValues(this.item, this.ref, this.kindName, this._formValues());
        const html = applied.empty ? "" : (this.options.preview(applied.entries, applied.ref) ?? "");
        box.find(".npci-preview-chips").html(html);
        box.prop("hidden", !html);
    }

    activateListeners(html)
    {
        super.activateListeners(html);
        html.find("button.npci-kind").on("click", event =>
        {
            event.preventDefault();
            this.kindName = event.currentTarget.dataset.kind;
            this.values = null;
            this.render();
        });
        html.find('button[data-button="cancel"]').on("click", event =>
        {
            event.preventDefault();
            this.close();
        });
        html.on("change", "select, input[type=checkbox], input[type=radio]", event => this._refresh(event.currentTarget.name));
        html.on("input", "input[type=text]", () => this._updatePreview());
        this._updatePreview();
    }

    async _updateObject(_event, formData)
    {
        await writeValues(this.item, this.ref, this.kindName, { ...this.values, ...collectValues(formData) });
    }
}

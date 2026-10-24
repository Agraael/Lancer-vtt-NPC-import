import { MODULE_ID } from "./utils.js";

const RESIST_TYPES = ["burn", "energy", "explosive", "heat", "kinetic"];
const DAMAGE_SUBJECTS = [...RESIST_TYPES, "aoe", "all"];
const STATUS_ALIASES = { slowed: "slow", lock_on: "lockon", "lock on": "lockon", danger_zone: "dangerzone", down_and_out: "downandout", shut_down: "shutdown" };
const SAVE_STATS = { hull: "hull", agi: "agility", agility: "agility", sys: "systems", systems: "systems", eng: "engineering", engineering: "engineering" };
const OWNER_KEYS = { traits: "trait", ranks: "rank", profiles: "profile", actions: "action", deployables: "deployable", powers: "power" };
const HOOK_KEYS = ["on_attack", "on_hit", "on_crit", "on_miss"];

function asList(value)
{
    if (value === undefined || value === null || value === "")
        return [];
    return Array.isArray(value) ? value : [value];
}

function resolveTier(value, tier)
{
    if (Array.isArray(value) && value.length === 3 && tier)
        return value[Math.min(Math.max(Number(tier), 1), 3) - 1];
    return value;
}

function normalizeStat(stat)
{
    const key = String(stat ?? "").trim().toLowerCase();
    return SAVE_STATS[key] ?? (key || null);
}

function normalizeSave(save)
{
    if (!save)
        return null;
    if (typeof save === "object")
        return { ...save, stat: normalizeStat(save.stat) };
    return { stat: normalizeStat(save) };
}

function parseDuration(duration)
{
    const raw = String(duration ?? "").trim().toLowerCase();
    if (!raw)
        return null;
    if (raw === "indefinite")
        return { raw, indefinite: true };
    if (raw === "end_of_encounter")
        return { raw, encounter: true };
    const round = /^round_(start|end)_(\d+)$/.exec(raw);
    if (round)
        return { raw, at: round[1], round: Number(round[2]) };
    const turn = /^(next_)?turn_(start|end)_([a-z]+)$/.exec(raw);
    if (turn)
        return { raw, at: turn[2], next: !!turn[1], of: turn[3] };
    const current = /^(start|end)_(next_)?turn_([a-z]+)$/.exec(raw);
    if (current)
        return { raw, at: current[1], next: !!current[2], of: current[3] };
    return { raw };
}

function parseFrequency(frequency)
{
    const raw = String(frequency ?? "").trim();
    if (!raw || raw.toLowerCase() === "unlimited")
        return null;
    const match = /^(\d+)\s*\/\s*([a-z]+)$/i.exec(raw);
    return match ? { raw, count: Number(match[1]), per: match[2].toLowerCase() } : { raw };
}

function normalizeStatusId(id)
{
    const key = String(id ?? "").trim().toLowerCase();
    return STATUS_ALIASES[key] ?? key;
}

function isKnownStatus(id)
{
    return !!CONFIG.statusEffects?.some(effect => effect.id === id);
}

function capitalize(value)
{
    const text = String(value ?? "");
    return text ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase() : null;
}

function normalizeStatuses(list, immunity)
{
    const statuses = [];
    for (const [index, entry] of asList(list).entries())
    {
        const status = typeof entry === "string" ? { id: entry } : entry;
        if (!status || typeof status !== "object")
            continue;
        const id = normalizeStatusId(status.id);
        if (id === "immunity")
        {
            immunity.push({ status: normalizeStatusId(status.val), damage: null, field: "add_status", index, ...commonFields(status) });
            continue;
        }
        const resolvedId = id === "cover" ? `cover_${String(status.val ?? "soft").toLowerCase()}` : id;
        statuses.push({
            id: resolvedId,
            raw: status.id,
            known: isKnownStatus(resolvedId),
            index,
            ...commonFields(status)
        });
    }
    return statuses;
}

function commonFields(entry)
{
    return {
        target: entry?.target ?? null,
        duration: parseDuration(entry?.duration),
        save: normalizeSave(entry?.save),
        attack: entry?.attack ?? null,
        aoe: entry?.aoe ?? false
    };
}

function normalizeResist(list, immunity, vulnerability)
{
    const resist = [];
    for (const [index, entry] of asList(list).entries())
    {
        if (!entry || typeof entry !== "object")
            continue;
        const common = { field: "add_resist", index, ...commonFields(entry) };
        if (entry.immunity)
        {
            const subject = String(entry.immunity).trim().toLowerCase();
            const damageTypes = subject === "all" ? RESIST_TYPES : [subject];
            if (DAMAGE_SUBJECTS.includes(subject))
                damageTypes.forEach(damageType => immunity.push({ status: null, damage: damageType, ...common }));
            else
                immunity.push({ status: normalizeStatusId(subject), damage: null, ...common });
            continue;
        }
        const vulnerable = String(entry.vulnerable ?? entry.vulnerability ?? "").trim().toLowerCase();
        if (vulnerable)
        {
            (vulnerable === "all" ? RESIST_TYPES : [vulnerable]).forEach(damageType => vulnerability.push({ type: damageType, ...common }));
            continue;
        }
        const type = String(entry.resist ?? entry.resistance ?? "").trim().toLowerCase();
        if (!type)
            continue;
        const types = type === "all" ? RESIST_TYPES : [type];
        for (const damageType of types)
        {
            if (entry.val === "immunity")
                immunity.push({ status: null, damage: damageType, ...common });
            else
                resist.push({ type: damageType, statusId: RESIST_TYPES.includes(damageType) ? `resistance_${damageType}` : null, ...common });
        }
    }
    return resist;
}

function normalizeSpecials(list)
{
    return asList(list).map((entry, index) =>
    {
        const special = typeof entry === "string" ? { attribute: entry } : entry;
        return {
            name: special?.attribute ?? special?.id ?? null,
            detail: special?.detail ?? null,
            index,
            ...commonFields(special)
        };
    }).filter(special => special.name);
}

function normalizeOther(list, tier)
{
    return asList(list).map((entry, index) => ({ entry, index })).filter(({ entry }) => entry && typeof entry === "object" && (entry.type ?? entry.id)).map(({ entry, index }) => ({
        type: String(entry.type ?? entry.id).toLowerCase(),
        val: resolveTier(entry.val ?? null, tier),
        index,
        ...commonFields(entry)
    }));
}

function normalizeBonusDamage(value, tier)
{
    return asList(value).map((entry, index) => ({ entry: typeof entry === "object" ? entry : { val: entry }, index })).filter(({ entry }) => entry && hasValue(entry.val)).map(({ entry, index }) => ({
        val: resolveTier(entry.val, tier),
        detail: entry.detail ?? null,
        weaponTypes: asList(entry.weapon_types),
        weaponSizes: asList(entry.weapon_sizes),
        hitType: entry.hit_type ?? null,
        index
    }));
}

function hasValue(value)
{
    return value !== undefined && value !== null && value !== "";
}

function normalizeDamage(list, tier)
{
    return asList(list).map((entry, index) => ({ entry, index })).filter(({ entry }) => entry && typeof entry === "object").map(({ entry, index }) => ({
        index,
        type: entry.type ? capitalize(entry.type) : null,
        val: resolveTier(entry.val ?? entry.damage ?? null, tier),
        ap: !!entry.ap,
        aoe: !!entry.aoe,
        target: entry.target ?? null,
        save: normalizeSave(entry.save),
        saveHalf: !!entry.save_half,
        irreducible: !!entry.irreducible,
        overkill: !!entry.overkill,
        reliable: resolveTier(entry.reliable ?? null, tier),
        bonus: entry.bonus ?? null,
        override: !!entry.override,
        attack: entry.attack ?? null
    }));
}

function describePath(path)
{
    const segments = path.split(".");
    const [first, second] = segments;
    let owner = { type: "item", index: null, path: "system" };
    if (first === "core_system")
        owner = { type: "core", index: null, path: "system.core_system" };
    else if (OWNER_KEYS[first] && /^\d+$/.test(second ?? ""))
        owner = { type: OWNER_KEYS[first], index: Number(second), path: `system.${first}.${second}` };
    const hook = segments.find(segment => HOOK_KEYS.includes(segment)) ?? null;
    let kind = "item";
    if (segments.includes("active_effects") || segments.includes("passive_effects"))
        kind = "effect";
    else if (segments.at(-2) === "damage")
        kind = "damage";
    else if (segments.at(-2) === "range")
        kind = "range";
    else if (hook)
        kind = "hook";
    else if (["actions", "active_actions", "passive_actions"].includes(segments.at(-2)))
        kind = "action";
    return { owner, hook, kind, passive: ["passive_effects", "passive_actions", "passive_bonuses"].some(segment => segments.includes(segment)) };
}

function normalizeEntry(path, data, tier)
{
    const immunity = [];
    const vulnerability = [];
    const statuses = normalizeStatuses(data.add_status, immunity);
    const resist = normalizeResist(data.add_resist, immunity, vulnerability);
    const location = describePath(path);
    return {
        path,
        ...location,
        name: data.name ?? null,
        activation: data.activation ?? null,
        attack: data.attack ?? null,
        condition: data.condition ?? null,
        target: data.target ?? null,
        duration: parseDuration(data.duration),
        frequency: parseFrequency(data.frequency),
        save: normalizeSave(data.save),
        statuses,
        specials: normalizeSpecials(data.add_special),
        removeSpecials: normalizeSpecials(data.remove_special).map(special => special.name),
        resist,
        immunity,
        vulnerability,
        damage: location.kind === "damage" ? normalizeDamage([data], tier) : normalizeDamage(data.damage, tier),
        range: location.kind === "range" ? [{ ...data, index: 0 }] : asList(data.range).map((range, index) => ({ range, index })).filter(({ range }) => range && typeof range === "object").map(({ range, index }) => ({ ...range, val: resolveTier(range.val ?? range.value, tier), index })),
        bonusDamage: normalizeBonusDamage(data.bonus_damage, tier),
        accuracy: resolveTier(data.accuracy, tier) ?? null,
        attackBonus: resolveTier(data.attack_bonus, tier) ?? null,
        techAccuracy: data.tech_accuracy ?? null,
        techAttackBonus: data.tech_attack_bonus ?? null,
        canCrit: !!data.can_crit,
        targetDefense: data.target_defense ?? null,
        bonuses: asList(data.bonuses),
        other: normalizeOther(data.add_other, tier),
        raw: data
    };
}

export function getV3Data(item, options = {})
{
    const entries = item?.flags?.[MODULE_ID]?.v3?.entries;
    if (!Array.isArray(entries))
        return [];
    const tier = options.tier ?? item.actor?.system?.tier ?? null;
    return entries.filter(entry => typeof entry?.path === "string").map(entry => normalizeEntry(entry.path, entry.data ?? {}, tier));
}

// V3 -> V2 LCP translator: rewrites a Comp/Con v3 LCP zip into the legacy v2 shape.
// active_effects become native bonuses/actions/deployables or effect text. Eidolon layers become NPC templates.

import { MODULE_ID } from "./utils.js";
import { getV3Data } from "./v3-data.js";

const JSZIP_CDN = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";

let _jszipPromise = null;
async function getJSZip()
{
    if (globalThis.JSZip)
        return globalThis.JSZip;
    if (!_jszipPromise)
    {
        _jszipPromise = import(JSZIP_CDN).then(mod => mod.default || mod.JSZip || mod);
    }
    return _jszipPromise;
}

function isV3Manifest(manifest)
{
    return manifest?.v3 === true;
}

const V3_ONLY_FILES = new Set(["lists.json", "downtime_actions.json"]);
const ON_HOOK_KEYS = ["on_attack", "on_hit", "on_crit", "on_miss"];

function hasV3Layout(zip)
{
    return Object.keys(zip.files).some(name =>
        /^npcc_.+\.json$/i.test(name) ||
        /^npct_.+\.json$/i.test(name) ||
        /^license_.+\.json$/i.test(name) ||
        name === "eidolon_layers.json" ||
        V3_ONLY_FILES.has(name)
    );
}

function hasV3Shape(value)
{
    if (Array.isArray(value))
        return value.some(hasV3Shape);
    if (!value || typeof value !== "object")
        return false;
    if (Array.isArray(value.active_effects))
        return true;
    if (ON_HOOK_KEYS.some(key => value[key] && typeof value[key] === "object"))
        return true;
    return Object.values(value).some(hasV3Shape);
}

async function hasV3Content(zip)
{
    for (const name of Object.keys(zip.files))
    {
        if (!/^[^/]+\.json$/i.test(name) || name === "lcp_manifest.json")
            continue;
        if (hasV3Shape(await readJsonIfExists(zip, name)))
            return true;
    }
    return false;
}

async function isV3Pack(zip, manifest)
{
    return isV3Manifest(manifest) || hasV3Layout(zip) || await hasV3Content(zip);
}

function translateClassStats(cls, logDropped)
{
    if (!cls.stats)
        return;
    // v3 size: scalar -> v2 [[n],[n],[n]]
    if (typeof cls.stats.size === "number")
    {
        const size = cls.stats.size;
        cls.stats.size = [[size], [size], [size]];
    }
}

function translateFeature(feat, parent, parentType, droppedEffects)
{
    // origin: v3 string → v2 object
    const originId = typeof feat.origin === "string" ? feat.origin : (parent?.id ?? null);
    const baseFlag = feat.base === true;
    feat.origin = {
        type: parentType,
        name: parent?.name ?? "",
        base: baseFlag
    };
    delete feat.base;
    feat.__v3_origin_id = originId;
    feat.__v3_base = baseFlag;

    // damage[].val -> damage[].damage
    if (Array.isArray(feat.damage))
    {
        for (const damageEntry of feat.damage)
        {
            if (damageEntry?.val !== undefined && damageEntry.damage === undefined)
            {
                damageEntry.damage = damageEntry.val;
                delete damageEntry.val;
            }
        }
    }

    // active_effects: translate to v2 bonuses/actions where possible, merge remainder into effect text.
    if (Array.isArray(feat.active_effects) && feat.active_effects.length)
    {
        const before = feat.active_effects.length;
        const lifted = liftActiveEffects(feat);
        droppedEffects.push({ feature: feat.id, total: before, lifted, textOnly: before - lifted });
        delete feat.active_effects;
    }
    else if (feat.active_effects)
    {
        delete feat.active_effects;
    }

    // v2-expected defaults
    if (feat.locked === undefined)
        feat.locked = false;
    if (feat.effect === undefined)
        feat.effect = "";
}

function rebuildFeatureListsOnClass(cls, allFeatures)
{
    if (!Array.isArray(cls.base_features))
        cls.base_features = [];
    if (!Array.isArray(cls.optional_features))
        cls.optional_features = [];
    const seenBase = new Set(cls.base_features);
    const seenOpt = new Set(cls.optional_features);
    for (const feat of allFeatures)
    {
        if (feat.__v3_origin_id !== cls.id)
            continue;
        if (feat.__v3_base)
        {
            if (!seenBase.has(feat.id))
            {
                cls.base_features.push(feat.id); seenBase.add(feat.id);
            }
        }
        else
        {
            if (!seenOpt.has(feat.id))
            {
                cls.optional_features.push(feat.id); seenOpt.add(feat.id);
            }
        }
    }
}

function stripSidecar(feat)
{
    delete feat.__v3_origin_id;
    delete feat.__v3_base;
}

// v3 active_effect -> v2 translation. Lancer 2.x models action damage/range/frequency/trigger
// and bonuses (save/attack/armor, added_damage) natively. The rest falls back to text.

const FREQUENCY_RE = /^\s*(\d+\s*\/\s*(turn|round|encounter|scene|mission|unlimited)|unlimited)\s*$/i;

function capitalizeDamageType(type)
{
    if (!type || typeof type !== "string")
        return type;
    const norm = type.trim().toLowerCase();
    const map = { kinetic: "Kinetic", energy: "Energy", explosive: "Explosive", heat: "Heat", burn: "Burn", variable: "Variable" };
    return map[norm] ?? (type.charAt(0).toUpperCase() + type.slice(1));
}
function capitalizeRangeType(type)
{
    if (!type || typeof type !== "string")
        return type;
    const norm = type.trim().toLowerCase();
    const map = { range: "Range", threat: "Threat", thrown: "Thrown", line: "Line", cone: "Cone", blast: "Blast", burst: "Burst" };
    return map[norm] ?? (type.charAt(0).toUpperCase() + type.slice(1));
}

// v2 damage.val is a string (dice expression or number). Arrays become a single joined string.
function normalizeDamageVal(value)
{
    if (value === undefined || value === null)
        return "";
    if (Array.isArray(value))
        return value.map(String).join("/");
    return String(value);
}
function toV2Damage(damage)
{
    if (!damage)
        return null;
    return { type: capitalizeDamageType(damage.type), val: normalizeDamageVal(damage.val ?? damage.damage ?? damage.amount) };
}
function toV2Range(range)
{
    if (range?.val === undefined)
        return null;
    const num = typeof range.val === "number" ? range.val : Number(range.val);
    return { type: capitalizeRangeType(range.type ?? "Range"), val: Number.isFinite(num) ? num : 0 };
}

function normalizeFrequency(freq)
{
    if (!freq || typeof freq !== "string")
        return "";
    const trimmed = freq.trim();
    if (FREQUENCY_RE.test(trimmed))
    {
        return trimmed.replace(/\s*\/\s*/, "/").replaceAll(/\b(\w)/g, char => char.toUpperCase());
    }
    return "";
}

// Text with no v2 schema home. Returns "" for a name-only active_effect so no bare `**Name**` trailer is emitted.
function renderResidualText(ae, handled, keepDataText = false)
{
    if (!ae)
        return "";
    const meta = [];
    if (ae.duration && keepDataText)
        meta.push(`Duration: ${ae.duration}`);
    if (ae.condition && !handled.trigger)
        meta.push(`When: ${ae.condition}`);
    if (ae.frequency && !handled.frequency && keepDataText)
        meta.push(`Frequency: ${normalizeFrequency(ae.frequency) || ae.frequency}`);
    const detail = !handled.detail && ae.detail ? ae.detail : "";
    const renderToken = token =>
    {
        if (token === null || token === undefined)
            return "";
        if (typeof token === "string")
            return token;
        if (typeof token === "object")
            return token.name ?? token.lid ?? token.id ?? "";
        return String(token);
    };
    const renderTokens = value => (Array.isArray(value) ? value : [value]).map(renderToken).filter(Boolean).join(", ");
    const extras = [];
    if (ae.add_status && keepDataText)
    {
        const text = renderTokens(ae.add_status); if (text)
            extras.push(`Applies status: ${text}`);
    }
    if (ae.add_resist && keepDataText)
    {
        const text = renderTokens(ae.add_resist); if (text)
            extras.push(`Grants resistance: ${text}`);
    }
    if (ae.add_special && keepDataText)
    {
        const text = renderTokens(ae.add_special); if (text)
            extras.push(`Special: ${text}`);
    }
    if (ae.remove_special && keepDataText)
    {
        const text = renderTokens(ae.remove_special); if (text)
            extras.push(`Removes special: ${text}`);
    }
    if (ae.save && typeof ae.save !== "object" && keepDataText)
        extras.push(`Save ${String(ae.save).toUpperCase()}`);
    if (typeof ae.accuracy === "number" && ae.accuracy !== 0 && keepDataText)
        extras.push(ae.accuracy > 0 ? `+${ae.accuracy} Accuracy` : `+${-ae.accuracy} Difficulty`);
    if (ae.bonus_damage && keepDataText)
    {
        const bonusDamage = (Array.isArray(ae.bonus_damage) ? ae.bonus_damage : [ae.bonus_damage]).map(toV2Damage).filter(Boolean);
        if (bonusDamage.length)
            extras.push(`Bonus damage: ${bonusDamage.map(damage => `${damage.val} ${damage.type ?? ""}`.trim()).join(", ")}`);
    }
    if (ae.save && typeof ae.save === "object")
    {
        const parts = [];
        if (ae.save.stat && keepDataText)
            parts.push(String(ae.save.stat).toUpperCase());
        if (ae.save.dc !== undefined && keepDataText)
            parts.push(String(ae.save.dc));
        const head = parts.join(" ");
        const tail = [];
        if (ae.save.on_success)
            tail.push(`success: ${ae.save.on_success}`);
        if (ae.save.on_fail)
            tail.push(`fail: ${ae.save.on_fail}`);
        if (head || tail.length)
            extras.push(`Save${head ? ` ${head}` : ""}${tail.length ? ` (${tail.join("; ")})` : ""}`);
    }
    // No meaningful body → don't emit a header-only trailer.
    if (!detail && !extras.length && !meta.length)
        return "";
    const parts = [];
    const label = ae.name ? `<strong>${ae.name}</strong>` : "";
    const header = label + (meta.length ? ` (${meta.join(", ")})` : "");
    if (header)
        parts.push(header);
    if (detail)
        parts.push(detail);
    if (extras.length)
        parts.push(extras.join(" | "));
    return parts.filter(Boolean).join(" — ");
}

// Loose-match containment: lower-case, strip markup/punctuation, collapse whitespace.
function textNormalize(value)
{
    return (value ?? "").toString().toLowerCase().replaceAll(/<[^>]*>/g, " ").replaceAll(/\*+/g, "").replaceAll(/[^\w\s]/g, " ").replaceAll(/\s+/g, " ").trim();
}
function existingContainsBody(existing, chunk)
{
    if (!existing || !chunk)
        return false;
    // Skip the bold name header so only the body is compared.
    const body = chunk.split(" — ").slice(1).join(" — ");
    if (!body)
        return true; // header-only, also filtered earlier
    return textContains(existing, body);
}

function textRestates(existing, text)
{
    const words = textNormalize(text).split(" ").filter(word => word.length > 3);
    if (words.length < 3)
        return false;
    const existingStems = new Set(textNormalize(existing).split(" ").map(word => word.slice(0, 5)));
    return words.filter(word => existingStems.has(word.slice(0, 5))).length / words.length >= (words.length < 6 ? 1 : 0.6);
}

function textContains(existing, text)
{
    const textNorm = textNormalize(text);
    return textNorm.length > 12 && textNormalize(existing).includes(textNorm);
}

function aeLooksLikeAction(ae)
{
    return !!(ae && (ae.damage || ae.range || ae.attack));
}

function liftActiveEffects(item, textField = "effect", keepDataText = false)
{
    const aes = item?.active_effects;
    if (!Array.isArray(aes) || aes.length === 0)
        return 0;
    let lifted = 0;
    const textChunks = [];

    for (const ae of aes)
    {
        if (!ae)
            continue;
        const handled = {};
        let liftedThis = false;

        // 1) Native arrays pass through unchanged (identical v2/v3 shapes).
        const permanentBonuses = !Array.isArray(ae.bonuses) || ae.condition || ae.duration ? [] : ae.bonuses.filter(bonus => bonus && !bonus.condition);
        if (permanentBonuses.length)
        {
            item.bonuses = (item.bonuses ?? []).concat(permanentBonuses);
            liftedThis = true;
        }
        if (Array.isArray(ae.actions) && ae.actions.length)
        {
            item.actions = (item.actions ?? []).concat(ae.actions);
            liftedThis = true;
        }
        if (Array.isArray(ae.deployables) && ae.deployables.length)
        {
            item.deployables = (item.deployables ?? []).concat(ae.deployables);
            liftedThis = true;
        }
        if (Array.isArray(ae.synergies) && ae.synergies.length)
        {
            item.synergies = (item.synergies ?? []).concat(ae.synergies);
            liftedThis = true;
        }
        if (Array.isArray(ae.counters) && ae.counters.length)
        {
            item.counters = (item.counters ?? []).concat(ae.counters);
            liftedThis = true;
        }

        // 2) Synthesize a v2 Action if the active_effect has action-shaped fields.
        if (aeLooksLikeAction(ae))
        {
            const action = {
                lid: ae.id ?? `ae_${Math.random().toString(36).slice(2, 8)}`,
                name: ae.name ?? "Active Effect",
                activation: ae.attack ? "Quick" : "Passive",
                frequency: normalizeFrequency(ae.frequency) || "",
                trigger: ae.condition ? String(ae.condition) : "",
                detail: ae.detail ?? "",
                tech_attack: ae.attack === "tech",
                damage: [],
                range: []
            };
            if (ae.damage)
            {
                const damages = Array.isArray(ae.damage) ? ae.damage : [ae.damage];
                for (const damageEntry of damages)
                {
                    const converted = toV2Damage(damageEntry); if (converted)
                        action.damage.push(converted);
                }
            }
            if (ae.range)
            {
                const ranges = Array.isArray(ae.range) ? ae.range : [ae.range];
                for (const rangeEntry of ranges)
                {
                    const converted = toV2Range(rangeEntry); if (converted)
                        action.range.push(converted);
                }
            }
            item.actions = (item.actions ?? []).concat([action]);
            handled.detail = !!ae.detail;
            handled.trigger = !!ae.condition;
            handled.frequency = !!ae.frequency;
            liftedThis = true;
        }

        if (liftedThis)
            lifted++;

        // 4) Residual unmapped text appended to effect.
        if (ae.detail && textRestates(item[textField], ae.detail))
            continue;
        const text = renderResidualText(ae, handled, keepDataText);
        if (text)
            textChunks.push(text);
    }

    if (textChunks.length)
    {
        const existing = typeof item[textField] === "string" ? item[textField] : "";
        // Skip chunks whose body is already present in the existing effect text
        // (v3 active_effects often restate the feature's main prose).
        const novel = textChunks.filter(chunk => !existingContainsBody(existing, chunk));
        if (novel.length)
        {
            // `effect` is an HTMLField: raw \n collapses to whitespace, use <br><br>.
            const block = novel.join("<br><br>");
            item[textField] = existing ? `${existing}<br><br>${block}` : block;
        }
    }
    return lifted;
}

// Backward-compat alias used by on_* hook coercion.
function renderActiveEffectAsText(ae)
{
    return renderResidualText(ae, {});
}

// v3 on_* hooks can be { detail, ... } objects, v2 expects a string.
function coerceOnHookString(value)
{
    if (value == null)
        return value;
    if (typeof value === "string")
        return value;
    if (typeof value === "object")
    {
        // Lift structured fields into the text.
        return typeof value.detail === "string" && value.detail.trim() ? value.detail : renderActiveEffectAsText(value);
    }
    return String(value);
}

function translateOnHooks(obj)
{
    if (!obj || typeof obj !== "object")
        return;
    for (const hook of ["on_attack", "on_hit", "on_crit", "on_miss"])
    {
        if (obj[hook] !== undefined && typeof obj[hook] !== "string")
        {
            obj[hook] = coerceOnHookString(obj[hook]);
        }
    }
}

// Lift v3 active_effects into v2 fields, strip v3-only cosmetic flags.
function stripV3Common(item, dropped, textField, keepDataText = false)
{
    if (!item || typeof item !== "object")
        return;
    if (Array.isArray(item.active_effects) && item.active_effects.length)
    {
        const before = item.active_effects.length;
        const lifted = liftActiveEffects(item, textField, keepDataText);
        if (dropped)
            dropped.push({ item: item.id ?? item.name ?? "?", total: before, lifted, textOnly: before - lifted });
    }
    markDeprecated(item);
    for (const key of ["active_effects", "flavorDescription", "brew", "deprecated"])
    {
        if (item[key] !== undefined)
            delete item[key];
    }
}

// v3 active_effects/passive_effects arrays on core_system/traits → v2 HTMLField string.
function mergeEffectArrayToHtml(effects, existing = "")
{
    if (!Array.isArray(effects))
        return "";
    const parts = [];
    for (const ae of effects)
    {
        if (!ae)
            continue;
        const label = ae.name ? `<strong>${ae.name}</strong>` : "";
        const meta = [];
        if (ae.condition)
            meta.push(`When: ${ae.condition}`);
        const header = label + (meta.length ? ` (${meta.join(", ")})` : "");
        const body = ae.detail && !textRestates(existing, ae.detail) ? ae.detail : "";
        const extras = [];
        if (ae.save && typeof ae.save === "object")
        {
            const tail = [];
            if (ae.save.on_success)
                tail.push(`success: ${ae.save.on_success}`);
            if (ae.save.on_fail)
                tail.push(`fail: ${ae.save.on_fail}`);
            if (tail.length)
                extras.push(`Save (${tail.join("; ")})`);
        }
        const extrasChunk = extras.length ? `<em>${extras.join(" | ")}</em>` : "";
        if (!body && !extrasChunk && !ae.condition)
            continue;
        const chunk = [header, body].filter(Boolean).join(" ");
        const full = [chunk, extrasChunk].filter(Boolean).join("<br>");
        if (full)
            parts.push(`<p>${full}</p>`);
    }
    return parts.join("");
}

// v2 `integrated` needs string LIDs. v3 already ships string[], this only guards inline objects.
function flattenIntegrated(item)
{
    if (!Array.isArray(item?.integrated))
        return;
    item.integrated = item.integrated
        .map(entry => typeof entry === "string" ? entry : entry?.id)
        .filter(Boolean);
}

// v2 unpackAction calls .map() on damage/range/synergy_locations, so v3 scalars and objects become arrays.
function normalizeAction(action)
{
    if (!action || typeof action !== "object")
        return;
    if (action.damage !== undefined && !Array.isArray(action.damage))
    {
        action.damage = action.damage ? [action.damage] : [];
    }
    if (action.range !== undefined && !Array.isArray(action.range))
    {
        action.range = action.range ? [action.range] : [];
    }
    if (action.synergy_locations !== undefined && !Array.isArray(action.synergy_locations))
    {
        action.synergy_locations = action.synergy_locations ? [action.synergy_locations] : [];
    }
    if (action.attack === "tech")
        action.tech_attack = true;
}

function normalizeActionsList(list)
{
    if (!Array.isArray(list))
        return;
    for (const action of list)
        normalizeAction(action);
}

// v2 unpackBonus does `data.val.toString()` blindly (lancer-c22b4371.mjs:34215).
// v3 bonuses can omit `val`, so guarantee a stringifiable value.
function normalizeBonus(bonus)
{
    if (!bonus || typeof bonus !== "object")
        return;
    if (bonus.val === undefined || bonus.val === null)
        bonus.val = "0";
    else if (typeof bonus.val !== "string")
        bonus.val = String(bonus.val);
    // checklist-array fields: coerce to arrays in case v3 ships scalars
    for (const key of ["damage_types", "range_types", "weapon_sizes", "weapon_types"])
    {
        if (bonus[key] !== undefined && !Array.isArray(bonus[key]))
            bonus[key] = bonus[key] ? [bonus[key]] : [];
    }
}

const ACCURACY_BONUS_TARGETS = {
    hull: { locations: ["hull"], label: "HULL checks and saves" },
    agility: { locations: ["agility"], label: "AGILITY checks and saves" },
    systems: { locations: ["systems"], label: "SYSTEMS checks and saves" },
    engineering: { locations: ["engineering"], label: "ENGINEERING checks and saves" },
    check: { locations: ["hase"], label: "all checks" },
    save: { locations: ["hase"], label: "saves" },
    accuracy: { locations: ["skill_check"], label: "non-combat skill checks" },
    melee: { locations: ["weapon"], weapon_types: ["Melee"], label: "melee attacks" },
    attack: { locations: ["weapon", "tech_attack"], label: "attacks" },
    tech_attack: { locations: ["tech_attack"], label: "tech attacks" },
    grapple: { locations: ["grapple"], label: "Grapple" },
    ram: { locations: ["ram"], label: "Ram" }
};

function accuracyBonusSynergy(bonus)
{
    const target = ACCURACY_BONUS_TARGETS[bonus?.id];
    if (!target)
        return null;
    const accuracy = Number(bonus.id === "accuracy" ? bonus.val : bonus.accuracy) || 0;
    const difficulty = Number(bonus.difficulty) || 0;
    if (!accuracy && !difficulty)
        return null;
    const modifiers = [accuracy ? `+${accuracy} Accuracy` : "", difficulty ? `+${difficulty} Difficulty` : ""].filter(Boolean).join(", ");
    const synergy = { locations: target.locations, detail: bonus.detail || `${modifiers} on ${target.label}` };
    if (target.weapon_types)
        synergy.weapon_types = target.weapon_types;
    return synergy;
}

function moveAccuracyBonuses(owner, bonusKey, synergyKey)
{
    if (!owner || !Array.isArray(owner[bonusKey]))
        return;
    const kept = [];
    for (const bonus of owner[bonusKey])
    {
        const synergy = accuracyBonusSynergy(bonus);
        if (!synergy)
        {
            kept.push(bonus);
            continue;
        }
        owner[synergyKey] = [...(Array.isArray(owner[synergyKey]) ? owner[synergyKey] : []), synergy];
        const val = String(bonus.val ?? "0").trim();
        if (bonus.id !== "accuracy" && val !== "" && val !== "0")
            kept.push(bonus);
    }
    owner[bonusKey] = kept;
}

function normalizeBonusesList(list)
{
    if (!Array.isArray(list))
        return;
    for (const bonus of list)
        normalizeBonus(bonus);
}

function dropConditionedBonuses(owner, bonusKey)
{
    if (Array.isArray(owner?.[bonusKey]))
        owner[bonusKey] = owner[bonusKey].filter(bonus => !bonus?.condition && !DATA_BONUS_IDS.includes(bonus?.id));
}

// Strips v3-only fields and normalizes nested actions/bonuses for Lancer's .map/.toString calls.
function stripNested(item, droppedAE)
{
    if (!item || typeof item !== "object")
        return;
    if (Array.isArray(item.deployables))
    {
        for (const deployable of item.deployables)
            if (deployable && typeof deployable === "object")
            {
                stripV3Common(deployable, droppedAE, "detail", true);
                normalizeActionsList(deployable.actions);
                dropConditionedBonuses(deployable, "bonuses");
                normalizeBonusesList(deployable.bonuses);
                moveAccuracyBonuses(deployable, "bonuses", "synergies");
            }
    }
    if (Array.isArray(item.actions))
    {
        for (const action of item.actions)
            if (action && typeof action === "object")
                stripV3Common(action, droppedAE, "detail");
        normalizeActionsList(item.actions);
    }
    for (const bonusKey of BONUS_LIST_KEYS)
        dropConditionedBonuses(item, bonusKey);
    normalizeBonusesList(item.bonuses);
    moveAccuracyBonuses(item, "bonuses", "synergies");
    // Core-system prefixed arrays (frames): active_actions / passive_actions / active_bonuses / passive_bonuses.
    normalizeActionsList(item.active_actions);
    normalizeActionsList(item.passive_actions);
    normalizeBonusesList(item.active_bonuses);
    normalizeBonusesList(item.passive_bonuses);
    moveAccuracyBonuses(item, "active_bonuses", "active_synergies");
    moveAccuracyBonuses(item, "passive_bonuses", "passive_synergies");
}

// Lift v3 core_system active_effects[]/passive_effects[] into the v2 core_system
// schema: prefixed active_*/passive_* keys, free-form text to *_effect HTMLFields.
function liftCoreSystemEffects(core, kind)
{
    const key = `${kind}_effects`;
    const effects = core?.[key];
    if (!Array.isArray(effects) || effects.length === 0)
        return;
    const bonusKey = `${kind}_bonuses`;
    const actionKey = `${kind}_actions`;
    const synergyKey = `${kind}_synergies`;
    const effectKey = `${kind}_effect`;
    for (const ae of effects)
    {
        if (!ae)
            continue;
        const permanentBonuses = !Array.isArray(ae.bonuses) || ae.condition || ae.duration ? [] : ae.bonuses.filter(bonus => bonus && !bonus.condition);
        if (permanentBonuses.length)
            core[bonusKey] = (core[bonusKey] ?? []).concat(permanentBonuses);
        if (Array.isArray(ae.actions) && ae.actions.length)
        {
            core[actionKey] = (core[actionKey] ?? []).concat(ae.actions);
        }
        if (Array.isArray(ae.synergies) && ae.synergies.length)
        {
            core[synergyKey] = (core[synergyKey] ?? []).concat(ae.synergies);
        }
        // core_system schema has top-level deployables/counters (not prefixed)
        if (Array.isArray(ae.deployables) && ae.deployables.length)
        {
            core.deployables = (core.deployables ?? []).concat(ae.deployables);
        }
        if (Array.isArray(ae.counters) && ae.counters.length)
        {
            core.counters = (core.counters ?? []).concat(ae.counters);
        }
    }
    const html = mergeEffectArrayToHtml(effects, core[effectKey]);
    if (html)
        core[effectKey] = (core[effectKey] || "") + html;
    delete core[key];
}

function translateFrame(frame, droppedAE)
{
    stripV3Common(frame, droppedAE);
    for (const key of ["specialty", "variant", "y_pos"])
        delete frame[key];
    if (Array.isArray(frame.active_counters) && !frame.core_system)
        frame.core_system = {};
    if (frame.image_url && !frame.img)
        frame.img = frame.image_url;
    delete frame.image_url;
    if (frame.core_system)
    {
        // Handle active/passive effects BEFORE stripV3Common: core_system has no
        // top-level bonuses/actions, only active_*/passive_* prefixed fields.
        liftCoreSystemEffects(frame.core_system, "active");
        liftCoreSystemEffects(frame.core_system, "passive");
        for (const key of ["flavorDescription", "brew", "deprecated"])
            delete frame.core_system[key];
        const core = frame.core_system;
        for (const [from, to] of [["active_deployables", "deployables"], ["active_counters", "counters"]])
        {
            if (Array.isArray(core[from]))
                core[to] = [...(Array.isArray(core[to]) ? core[to] : []), ...core[from]];
            delete core[from];
        }
        if (Array.isArray(frame.active_counters))
            core.counters = [...(Array.isArray(core.counters) ? core.counters : []), ...frame.active_counters];
        flattenIntegrated(frame.core_system);
        stripNested(frame.core_system, droppedAE);
    }
    if (Array.isArray(frame.traits))
    {
        for (const trait of frame.traits)
        {
            stripV3Common(trait, droppedAE, "description");
            stripNested(trait, droppedAE);
        }
    }
    flattenIntegrated(frame);
    stripNested(frame, droppedAE);
}

function translateMechWeapon(weapon, droppedAE)
{
    stripV3Common(weapon, droppedAE);
    // Drop truly v2-unsupported fields only.
    delete weapon.mod_type_override;
    delete weapon.mod_size_override;
    // Alias v3 plural forms -> v2 singular (unpacker reads singular at lancer-c22b4371.mjs:34670-34674).
    if (weapon.no_bonuses !== undefined && weapon.no_bonus === undefined)
        weapon.no_bonus = weapon.no_bonuses;
    if (weapon.no_synergies !== undefined && weapon.no_synergy === undefined)
        weapon.no_synergy = weapon.no_synergies;
    if (weapon.no_core_bonuses !== undefined && weapon.no_core_bonus === undefined)
        weapon.no_core_bonus = weapon.no_core_bonuses;
    // `no_attack` is a real v2 field (MechWeaponModel:34601), keep it.
    translateOnHooks(weapon);
    flattenIntegrated(weapon);
    stripNested(weapon, droppedAE);
    if (Array.isArray(weapon.profiles))
    {
        for (const profile of weapon.profiles)
        {
            stripV3Common(profile, droppedAE);
            translateOnHooks(profile);
            flattenIntegrated(profile);
            stripNested(profile, droppedAE);
        }
    }
}

function translateMechSystem(system, droppedAE)
{
    stripV3Common(system, droppedAE);
    flattenIntegrated(system);
    stripNested(system, droppedAE);
}

function translateWeaponMod(mod, droppedAE)
{
    stripV3Common(mod, droppedAE);
    const onHitDamage = (Array.isArray(mod.on_hit) ? mod.on_hit : [mod.on_hit])
        .flatMap(hook => (hook && typeof hook === "object" && Array.isArray(hook.damage) ? hook.damage : []))
        .map(toV2Damage)
        .filter(Boolean);
    if (onHitDamage.length)
        mod.added_damage = [...(Array.isArray(mod.added_damage) ? mod.added_damage : []), ...onHitDamage];
    translateOnHooks(mod);
    for (const [restricted, allowed, all] of [["restricted_types", "allowed_types", FILTER_VALUES.weapon_types], ["restricted_sizes", "allowed_sizes", FILTER_VALUES.weapon_sizes]])
    {
        if (Array.isArray(mod[restricted]) && mod[restricted].length && !mod[allowed]?.length)
        {
            const blocked = new Set(mod[restricted].map(value => String(value).toLowerCase()));
            mod[allowed] = all.filter(value => !blocked.has(value.toLowerCase()));
        }
        delete mod[restricted];
    }
    // v3 `allowed_types` / `allowed_sizes` are native in Lancer 2.x WeaponModModel
    // (lancer-c22b4371.mjs:35424-35425). Pass through unchanged.
}

function translatePilotGear(item, droppedAE)
{
    stripV3Common(item, droppedAE);
    translateOnHooks(item);
    stripNested(item, droppedAE);
}

function translateTalent(talent, droppedAE)
{
    stripV3Common(talent, droppedAE);
    for (const key of ["icon_url", "svg"])
        delete talent[key];
    if (Array.isArray(talent.ranks))
    {
        for (const rank of talent.ranks)
        {
            stripV3Common(rank, droppedAE, "description");
            stripNested(rank, droppedAE);
        }
    }
}

function translateReserve(reserve, droppedAE)
{
    stripV3Common(reserve, droppedAE, "description");
    stripNested(reserve, droppedAE);
}

function translateBond(bond, droppedAE)
{
    stripV3Common(bond, droppedAE);
    if (!Array.isArray(bond.powers))
        bond.powers = [];
    for (const power of bond.powers)
        stripV3Common(power, droppedAE);
}

function translateNpcClass(npcClass, droppedAE)
{
    stripV3Common(npcClass, droppedAE);
    stripNested(npcClass, droppedAE);
}

function translateNpcTemplate(template, droppedAE)
{
    stripV3Common(template, droppedAE, "description");
    stripNested(template, droppedAE);
}

function renderStatusList(statuses)
{
    if (!Array.isArray(statuses) || !statuses.length)
        return "";
    return statuses.map(status =>
    {
        if (!status)
            return "";
        if (typeof status === "string")
            return status;
        const id = status.id ?? status.name ?? "";
        if (!id)
            return "";
        return status.save ? `${id} (${status.save} save)` : id;
    }).filter(Boolean).join(", ");
}

function renderNpcActionsAsHtml(actions, existing = "", knownTrigger = "")
{
    if (!Array.isArray(actions) || !actions.length)
        return "";
    const blocks = [];
    for (const action of actions)
    {
        if (!action || typeof action !== "object")
            continue;
        const meta = [];
        if (action.activation && !NPC_ACTIVATION_TAGS[String(action.activation).toLowerCase()])
            meta.push(action.activation);
        const header = `<strong>${action.name ?? "Action"}</strong>`
            + (meta.length ? ` <em>(${meta.join(", ")})</em>` : "");
        const parts = [header];
        const detail = typeof action.detail === "string" ? action.detail
            : (action.detail ? coerceOnHookString(action.detail) : "");
        if (detail && (textContains(existing, detail) || textRestates(existing, detail)))
            continue;
        if (detail)
            parts.push(detail);
        const trigger = action.trigger && typeof action.trigger !== "string" ? coerceOnHookString(action.trigger) : (action.trigger ?? "");
        if (trigger && trigger !== knownTrigger && !textContains(existing, trigger))
            parts.push(`<strong>Trigger:</strong> ${trigger}`);
        const conditions = renderStatusList(action.add_condition);
        if (conditions)
            parts.push(`<em>Applies condition:</em> ${conditions}`);
        blocks.push(parts.join("<br>"));
    }
    return blocks.join("<br><br>");
}

function translateNpcFeatureCommon(feature, droppedAE)
{
    if (!feature)
        return;
    const featureType = NPC_FEATURE_TYPES.find(type => type.toLowerCase() === String(feature.type ?? "").toLowerCase());
    if (featureType)
        feature.type = featureType;
    markDeprecated(feature);
    feature.tags = (Array.isArray(feature.tags) ? feature.tags : []).filter(tag => !V3_ONLY_NPC_TAGS.has(tag?.id));
    if (Array.isArray(feature.actions) && feature.actions.length)
    {
        for (const action of feature.actions)
        {
            const activationTag = NPC_ACTIVATION_TAGS[String(action?.activation ?? "").toLowerCase()];
            if (activationTag && feature.type !== "Reaction")
                addTagOnce(feature, activationTag);
            const frequency = /^(\d+)\s*\/\s*(round|turn)$/i.exec(String(action?.frequency ?? "").trim());
            if (frequency)
                addTagOnce(feature, `tg_${frequency[2].toLowerCase()}`, Number(frequency[1]));
        }
        if (feature.type === "Reaction" && !feature.trigger)
        {
            const firstTrigger = feature.actions.find(action => action?.trigger)?.trigger;
            if (firstTrigger)
                feature.trigger = typeof firstTrigger === "string" ? firstTrigger : coerceOnHookString(firstTrigger);
        }
        const html = renderNpcActionsAsHtml(feature.actions, feature.effect, feature.trigger);
        if (html)
        {
            const existing = typeof feature.effect === "string" ? feature.effect : "";
            feature.effect = existing ? `${existing}<br><br>${html}` : html;
        }
        delete feature.actions;
    }
    // v3 on_attack/on_crit have no v2 home, so they are folded into `effect`.
    if (feature.on_hit !== undefined && typeof feature.on_hit !== "string")
    {
        feature.on_hit = coerceOnHookString(feature.on_hit);
    }
    const extraHookChunks = [];
    for (const [key, label] of [["on_attack", "On Attack"], ["on_crit", "On Crit"]])
    {
        if (feature[key] === undefined)
            continue;
        const text = typeof feature[key] === "string" ? feature[key] : coerceOnHookString(feature[key]);
        if (text)
            extraHookChunks.push(`<strong>${label}:</strong> ${text}`);
        delete feature[key];
    }
    if (extraHookChunks.length)
    {
        const existing = typeof feature.effect === "string" ? feature.effect : "";
        const block = extraHookChunks.join("<br><br>");
        feature.effect = existing ? `${existing}<br><br>${block}` : block;
    }
    // The unpacker iterates damage.length, so each damage val becomes a tier array.
    if (Array.isArray(feature.damage))
    {
        for (const damageEntry of feature.damage)
        {
            if (damageEntry?.damage !== undefined && !Array.isArray(damageEntry.damage))
            {
                damageEntry.damage = [damageEntry.damage, damageEntry.damage, damageEntry.damage];
            }
        }
    }
    for (const key of ["attack_bonus", "accuracy"])
    {
        if (typeof feature[key] === "number")
            feature[key] = [feature[key], feature[key], feature[key]];
    }
    // Weapon-type NPC features must have damage and range as arrays: unpackNpcFeature
    // iterates them directly (npc_feature.ts:162). Some v3 utility weapons omit these.
    if (feature.type === "Weapon")
    {
        if (!Array.isArray(feature.damage))
            feature.damage = [];
        if (!Array.isArray(feature.range))
            feature.range = [];
    }
    stripNested(feature, droppedAE);
}

function translateGeneric(item, droppedAE)
{
    stripV3Common(item, droppedAE);
    stripNested(item, droppedAE);
}

function applyItemTranslators(type, entries, droppedAE)
{
    if (!Array.isArray(entries))
        return;
    switch (type)
    {
    case "frames": for (const entry of entries)
        translateFrame(entry, droppedAE); break;
    case "weapons": for (const entry of entries)
        translateMechWeapon(entry, droppedAE); break;
    case "systems": for (const entry of entries)
        translateMechSystem(entry, droppedAE); break;
    case "mods": for (const entry of entries)
        translateWeaponMod(entry, droppedAE); break;
    case "pilot_gear": for (const entry of entries)
        translatePilotGear(entry, droppedAE); break;
    case "talents": for (const entry of entries)
        translateTalent(entry, droppedAE); break;
    case "reserves": for (const entry of entries)
        translateReserve(entry, droppedAE); break;
    case "bonds": for (const entry of entries)
        translateBond(entry, droppedAE); break;
    default: for (const entry of entries)
        translateGeneric(entry, droppedAE);
    }
}

// Dispatch a child entry inside a license_*.json collection to the right bucket.
function classifyLicenseChild(entry)
{
    if (!entry || typeof entry !== "object")
        return null;
    if (entry.data_type === "weapon")
        return "weapons";
    if (entry.data_type === "mod")
        return "mods";
    if (entry.data_type === "system")
        return "systems";
    if (entry.allowed_types !== undefined || entry.allowed_sizes !== undefined
        || entry.restricted_types !== undefined || entry.restricted_sizes !== undefined
        || entry.added_tags !== undefined || entry.added_damage !== undefined)
        return "mods";
    if (entry.mount !== undefined || entry.damage !== undefined || entry.range !== undefined)
        return "weapons";
    return "systems";
}

const SYNERGY_LOCATIONS = new Set(["any", "active_effects", "rest", "core_power", "weapon", "system", "deployable", "drone", "move", "boost", "other", "ram", "grapple", "tech_attack", "hp", "armor", "repair", "overshield", "burn", "structure", "heat", "stress", "overcharge", "skill_check", "overwatch", "skirmish", "barrage", "improvised_attack", "disengage", "stabilize", "tech", "lock_on", "bolster", "hase", "hull", "agility", "systems", "engineering", "brace", "cascade", "pilot_weapon", "mount"]);
const SYNERGY_LOCATION_ALIASES = { attack: ["weapon", "tech_attack"], weapons: ["weapon"], quick_tech: ["tech"], full_tech: ["tech"] };
const FILTER_VALUES = {
    damage_types: ["Burn", "Energy", "Explosive", "Heat", "Kinetic", "Variable"],
    range_types: ["Blast", "Burst", "Cone", "Line", "Range", "Thrown", "Threat"],
    weapon_types: ["CQB", "Cannon", "Launcher", "Melee", "Nexus", "Rifle"],
    weapon_sizes: ["Auxiliary", "Heavy", "Main", "Superheavy"]
};

const NPC_FEATURE_TYPES = ["Trait", "System", "Reaction", "Weapon", "Tech"];
const NPC_ACTIVATION_TAGS = { quick: "tg_quick_action", full: "tg_full_action", free: "tg_free_action", protocol: "tg_protocol", reaction: "tg_reaction" };
const V3_ONLY_NPC_TAGS = new Set(["tg_npc_system", "tg_npc_trait"]);
const DEPLOYABLE_NUMBER_KEYS = ["armor", "edef", "evasion", "heatcap", "save", "size", "speed"];

function addTagOnce(feature, id, val)
{
    if (feature.tags.some(tag => tag?.id === id))
        return;
    feature.tags.push(val === undefined ? { id } : { id, val });
}

function markDeprecated(item)
{
    if (item.deprecated && typeof item.name === "string" && !item.name.startsWith("[Deprecated]"))
        item.name = `[Deprecated] ${item.name}`;
}

function normalizeFilterList(key, values)
{
    const list = (Array.isArray(values) ? values : [values]).filter(value => value !== undefined && value !== null && value !== "");
    if (list.some(value => String(value).toLowerCase() === "any"))
        return [];
    return list.map(value => FILTER_VALUES[key].find(option => option.toLowerCase() === String(value).toLowerCase()) ?? value);
}

function normalizeSynergyLocations(locations)
{
    const raw = (Array.isArray(locations) ? locations : [locations])
        .flatMap(location => String(location ?? "").split(","))
        .map(location => location.trim().toLowerCase())
        .filter(Boolean);
    const mapped = [...new Set(raw.flatMap(location => SYNERGY_LOCATION_ALIASES[location] ?? [location]))]
        .filter(location => SYNERGY_LOCATIONS.has(location));
    return mapped.length || !raw.length ? mapped : ["any"];
}

function normalizeV3Shapes(value)
{
    if (Array.isArray(value))
    {
        for (const entry of value)
            normalizeV3Shapes(entry);
        return value;
    }
    if (!value || typeof value !== "object")
        return value;
    if (value.actions && typeof value.actions === "object" && !Array.isArray(value.actions))
        value.actions = [value.actions];
    for (const deployable of Array.isArray(value.deployables) ? value.deployables : [])
    {
        for (const key of DEPLOYABLE_NUMBER_KEYS)
        {
            if (typeof deployable?.[key] === "string" && Number.isNaN(Number(deployable[key])))
                delete deployable[key];
        }
    }
    if (value.locations !== undefined && value.detail !== undefined)
        value.locations = normalizeSynergyLocations(value.locations);
    for (const key of Object.keys(FILTER_VALUES))
    {
        if (value[key] !== undefined)
            value[key] = normalizeFilterList(key, value[key]);
    }
    for (const child of Object.values(value))
        normalizeV3Shapes(child);
    return value;
}

const PURE_ACTION_FIELDS = ["add_status", "add_resist", "add_special", "remove_special", "add_other", "save", "condition", "bonus_damage", "accuracy", "attack_bonus", "tech_accuracy", "tech_attack_bonus", "can_crit", "target_defense"];
const PURE_NPC_ACTION_FIELDS = ["name", "activation", "frequency", "range", "damage", ...PURE_ACTION_FIELDS];
const PURE_EFFECT_FIELDS = ["name", "condition", "frequency", "duration", "target", "damage", "range", "attack", ...PURE_ACTION_FIELDS];
const PURE_DAMAGE_FIELDS = ["ap", "aoe", "target", "save", "save_half", "irreducible", "overkill", "reliable", "bonus", "override", "attack"];
const PURE_RANGE_FIELDS = ["min", "bonus", "override"];
const NESTED_ACTION_KEYS = ["active_effects", "passive_effects", "sub_actions"];
const DIRECT_EFFECT_KEYS = ["add_status", "add_resist", "add_special", "remove_special", "add_other"];
const PURE_DIRECT_FIELDS = ["name", "activation", "condition", "frequency", "duration", "target", "save", "attack", ...DIRECT_EFFECT_KEYS];
const ACTION_LIST_KEYS = ["actions", "sub_actions", "active_actions", "passive_actions"];
const BONUS_LIST_KEYS = ["bonuses", "active_bonuses", "passive_bonuses"];
const PURE_BONUS_FIELDS = ["id", "val", "accuracy", "difficulty", "damage_types", "range_types", "weapon_types", "weapon_sizes", "overwrite", "replace", "condition", "max"];

const DATA_BONUS_IDS = ["immunity", "resistance"];

function isPureBonus(bonus)
{
    return !!bonus && typeof bonus === "object" && !!(bonus.condition || Number(bonus.accuracy) || Number(bonus.difficulty) || DATA_BONUS_IDS.includes(bonus.id));
}

function pickFields(source, fields)
{
    const picked = {};
    for (const field of fields)
    {
        const value = source?.[field];
        if (value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && !value.length))
            picked[field] = value;
    }
    return picked;
}

function addPureData(out, path, data)
{
    if (Object.keys(data).some(key => key !== "name"))
        out[path] = data;
}

function effectPureData(effect)
{
    const picked = pickFields(effect, PURE_EFFECT_FIELDS);
    const bonuses = Array.isArray(effect?.bonuses) ? effect.bonuses.filter(bonus => bonus && (effect.condition || effect.duration || bonus.condition)) : [];
    if (bonuses.length)
        picked.bonuses = bonuses;
    return picked;
}

function hookPureData(hook)
{
    const picked = pickFields(hook, PURE_EFFECT_FIELDS);
    if (Array.isArray(hook?.bonuses) && hook.bonuses.length)
        picked.bonuses = hook.bonuses;
    return picked;
}

function collectDamagePureData(list, path, out)
{
    if (!Array.isArray(list))
        return;
    list.forEach((entry, index) => addPureData(out, `${path}.${index}`, pickFields(entry, PURE_DAMAGE_FIELDS)));
}

function collectRangePureData(list, path, out)
{
    if (!Array.isArray(list))
        return;
    list.forEach((entry, index) => addPureData(out, `${path}.${index}`, pickFields(entry, PURE_RANGE_FIELDS)));
}

function collectPureData(value, path, npcFeature, out)
{
    if (Array.isArray(value))
    {
        value.forEach((entry, index) => collectPureData(entry, path ? `${path}.${index}` : String(index), npcFeature, out));
        return out;
    }
    if (!value || typeof value !== "object")
        return out;
    if ((path === "" || /^traits\.\d+$/.test(path)) && Object.keys(pickFields(value, DIRECT_EFFECT_KEYS)).length)
        addPureData(out, path, pickFields(value, PURE_DIRECT_FIELDS));
    for (const [key, child] of Object.entries(value))
    {
        const childPath = path ? `${path}.${key}` : key;
        if ((key === "active_effects" || key === "passive_effects") && Array.isArray(child))
        {
            child.forEach((effect, index) => addPureData(out, `${childPath}.${index}`, effectPureData(effect)));
        }
        else if (ACTION_LIST_KEYS.includes(key) && Array.isArray(child))
        {
            child.forEach((action, index) =>
            {
                const actionPath = `${childPath}.${index}`;
                const data = pickFields(action, npcFeature ? PURE_NPC_ACTION_FIELDS : PURE_ACTION_FIELDS);
                if (action?.attack && action.attack !== "tech")
                    data.attack = action.attack;
                addPureData(out, actionPath, data);
                collectDamagePureData(action?.damage, `${actionPath}.damage`, out);
                if (!npcFeature)
                    collectRangePureData(action?.range, `${actionPath}.range`, out);
                collectPureData(pickFields(action, NESTED_ACTION_KEYS), actionPath, npcFeature, out);
            });
        }
        else if (ON_HOOK_KEYS.includes(key) && child && typeof child === "object")
        {
            const hooks = Array.isArray(child) ? child : [child];
            hooks.forEach((hook, index) =>
            {
                const hookPath = Array.isArray(child) ? `${childPath}.${index}` : childPath;
                addPureData(out, hookPath, hookPureData(hook));
                collectDamagePureData(hook?.damage, `${hookPath}.damage`, out);
            });
        }
        else if (BONUS_LIST_KEYS.includes(key) && Array.isArray(child))
        {
            child.forEach((bonus, index) =>
            {
                if (isPureBonus(bonus))
                    addPureData(out, `${childPath}.${index}`, { bonuses: [pickFields(bonus, PURE_BONUS_FIELDS)] });
            });
        }
        else if (key === "damage" && Array.isArray(child))
        {
            collectDamagePureData(child, childPath, out);
        }
        else if (key === "range" && Array.isArray(child))
        {
            collectRangePureData(child, childPath, out);
        }
        else
        {
            collectPureData(child, childPath, npcFeature, out);
        }
    }
    return out;
}

async function collectPackPureData(zip)
{
    const pureData = {};
    for (const name of Object.keys(zip.files))
    {
        if (!/^[^/]+\.json$/i.test(name) || name === "lcp_manifest.json" || name === "eidolon_layers.json")
            continue;
        const entries = await readJsonIfExists(zip, name);
        if (!Array.isArray(entries))
            continue;
        const npcFile = /^npc/i.test(name);
        for (const entry of entries)
        {
            if (!entry || typeof entry.id !== "string")
                continue;
            const data = collectPureData(entry, "", npcFile, {});
            if (Object.keys(data).length)
                pureData[entry.id] = data;
        }
    }
    return pureData;
}

async function readJsonIfExists(zip, name)
{
    const file = zip.file(name);
    if (!file)
        return null;
    try
    {
        return normalizeV3Shapes(JSON.parse((await file.async("string")).replace(/^﻿/, "")));
    }
    catch (e)
    {
        console.warn(`lancer-npc-import | v3-lcp | Failed to parse ${name}`, e); return null;
    }
}

// Find the class/template "header" entry inside a per-file collection.
// v3 convention: the header has no `origin` field (or has `role` for classes).
function pickCollectionHeader(entries, kind)
{
    if (!Array.isArray(entries) || entries.length === 0)
        return null;
    if (kind === "Class")
        return entries.find(entry => entry?.role) ?? null;
    // Template: compcon v3 marks the header with `template: true` (ContentPackParser.ts:185).
    // Fall back to first entry with no `origin` string for older pre-release LCPs.
    return entries.find(entry => entry?.template === true)
        ?? entries.find(entry => entry && (typeof entry.origin !== "string" || !entry.origin))
        ?? null;
}

function sumActiveEffects(entries)
{
    return entries.reduce((totals, entry) =>
    {
        totals.total += entry.total ?? 0;
        totals.lifted += entry.lifted ?? 0;
        totals.textOnly += entry.textOnly ?? 0;
        return totals;
    }, { total: 0, lifted: 0, textOnly: 0 });
}

function itemCountText(summary)
{
    return Object.entries(summary.items ?? {}).map(([type, count]) => `${count} ${type}`).join(", ");
}

export async function translateV3LcpBlob(inputBlob)
{
    const JSZip = await getJSZip();
    const inZip = await JSZip.loadAsync(inputBlob);

    const manifest = await readJsonIfExists(inZip, "lcp_manifest.json");
    if (!manifest)
        throw new Error("No lcp_manifest.json in LCP");

    const isV3 = await isV3Pack(inZip, manifest);
    if (!isV3)
        return { blob: null, manifest, summary: { alreadyV2: true } };

    const pureData = await collectPackPureData(inZip);
    const droppedEffects = [];
    const droppedLayers = [];
    const outZip = new JSZip();

    // Manifest: strip v3 flag so the system doesn't think it's still v3.
    const outManifest = { ...manifest };
    delete outManifest.v3;
    outZip.file("lcp_manifest.json", JSON.stringify(outManifest, null, 2));

    // Files Lancer 2.x reads get translated, the others pass through.
    const contentBuckets = {
        frames: [],
        weapons: [],
        systems: [],
        mods: [],
        pilot_gear: [],
        skills: [],
        talents: [],
        bonds: [],
        reserves: [],
        tags: [],
        statuses: [],
        core_bonuses: []
    };
    const bucketFilename = {
        frames: "frames.json",
        weapons: "weapons.json",
        systems: "systems.json",
        mods: "mods.json",
        pilot_gear: "pilot_gear.json",
        skills: "skills.json",
        talents: "talents.json",
        bonds: "bonds.json",
        reserves: "reserves.json",
        tags: "tags.json",
        statuses: "statuses.json",
        core_bonuses: "core_bonuses.json"
    };
    for (const [bucket, file] of Object.entries(bucketFilename))
    {
        const entries = await readJsonIfExists(inZip, file);
        if (Array.isArray(entries))
            contentBuckets[bucket].push(...entries);
    }

    // v3 may split pilot gear into pilot_armor.json and pilot_weapons.json. Lancer 2.x wants one pilot_gear.json.
    for (const [file, typeTag] of [["pilot_armor.json", "Armor"], ["pilot_weapons.json", "Weapon"]])
    {
        const entries = await readJsonIfExists(inZip, file);
        if (Array.isArray(entries))
        {
            for (const entry of entries)
            {
                if (entry && entry.type === undefined)
                    entry.type = typeTag;
            }
            contentBuckets.pilot_gear.push(...entries);
        }
    }
    // Ensure any pre-existing pilot_gear entries without a type default to "Gear".
    for (const entry of contentBuckets.pilot_gear)
    {
        if (entry && entry.type === undefined)
            entry.type = "Gear";
    }

    // v3 may ship bond_powers.json separately. Lancer reads powers[] inside each bond.
    const bondPowers = await readJsonIfExists(inZip, "bond_powers.json");
    if (Array.isArray(bondPowers) && contentBuckets.bonds.length)
    {
        for (const bond of contentBuckets.bonds)
        {
            const bondId = bond?.id;
            if (!bondId)
                continue;
            const match = bondPowers.filter(power => power?.origin === bondId || power?.bond_id === bondId);
            if (match.length)
                bond.powers = (bond.powers ?? []).concat(match);
        }
    }

    // Files the Lancer 2.x system ignores but that might still be useful downstream: pass through untouched.
    const miscPassthrough = [
        "manufacturers.json", "backgrounds.json", "environments.json",
        "factions.json", "sitreps.json"
    ];
    for (const name of miscPassthrough)
    {
        const file = inZip.file(name);
        if (file)
            outZip.file(name, await file.async("string"));
    }

    // v3 license collection files: fan out into frames/weapons/systems/mods.
    const licenseNames = Object.keys(inZip.files).filter(fileName => /^license_.+\.json$/i.test(fileName));
    for (const name of licenseNames)
    {
        const entries = await readJsonIfExists(inZip, name);
        if (!Array.isArray(entries))
            continue;
        const frame = entries.find(entry => entry?.mechtype);
        if (!frame)
        {
            console.warn(`lancer-npc-import | v3-lcp | ${name}: no frame header (mechtype field)`); continue;
        }
        contentBuckets.frames.push(frame);
        const licenseMeta = {
            license: frame.name,
            license_id: frame.id,
            source: frame.source
        };
        for (const child of entries)
        {
            if (!child || child === frame)
                continue;
            const bucket = classifyLicenseChild(child);
            if (!bucket)
                continue;
            for (const [field, value] of Object.entries(licenseMeta))
            {
                if (child[field] === undefined && value !== undefined)
                    child[field] = value;
            }
            contentBuckets[bucket].push(child);
        }
    }

    // Collect NPC content. Comp/Con v3 reads every `npc_*.json` except classes/templates
    // (ContentPackParser.ts:152), so LCPs can ship split files like `npc_features_dlc.json`.
    const allClasses = (await readJsonIfExists(inZip, "npc_classes.json")) || [];
    const allTemplates = (await readJsonIfExists(inZip, "npc_templates.json")) || [];
    const allFeatures = [];
    const featureFileNames = Object.keys(inZip.files)
        .filter(fileName => /^npc_(?!classes(?:\.json)?$|templates(?:\.json)?$).+\.json$/i.test(fileName));
    for (const name of featureFileNames)
    {
        const entries = await readJsonIfExists(inZip, name);
        if (Array.isArray(entries))
            allFeatures.push(...entries);
    }

    // Per-class v3 collection files.
    const npccNames = Object.keys(inZip.files).filter(fileName => /^npcc_.+\.json$/i.test(fileName));
    for (const name of npccNames)
    {
        const entries = await readJsonIfExists(inZip, name);
        if (!Array.isArray(entries))
            continue;
        const cls = pickCollectionHeader(entries, "Class");
        if (!cls)
        {
            console.warn(`lancer-npc-import | v3-lcp | ${name}: no class header found`); continue;
        }
        translateClassStats(cls);
        const feats = entries.filter(entry => entry && entry !== cls);
        for (const feat of feats)
        {
            translateFeature(feat, cls, "Class", droppedEffects);
            allFeatures.push(feat);
        }
        allClasses.push(cls);
    }

    // Per-template v3 collection files.
    const npctNames = Object.keys(inZip.files).filter(fileName => /^npct_.+\.json$/i.test(fileName));
    for (const name of npctNames)
    {
        const entries = await readJsonIfExists(inZip, name);
        if (!Array.isArray(entries))
            continue;
        const tmpl = pickCollectionHeader(entries, "Template");
        if (!tmpl)
        {
            console.warn(`lancer-npc-import | v3-lcp | ${name}: no template header found`); continue;
        }
        const feats = entries.filter(entry => entry && entry !== tmpl);
        for (const feat of feats)
        {
            translateFeature(feat, tmpl, "Template", droppedEffects);
            allFeatures.push(feat);
        }
        allTemplates.push(tmpl);
    }

    // Handle any v2-style features that accidentally carry v3 fields.
    for (const feat of allFeatures)
    {
        if (feat.__v3_origin_id !== undefined)
            continue; // already translated
        if (typeof feat.origin === "string")
        {
            // Feature lived in legacy npc_features.json but uses v3 origin string.
            // Resolve parent from already-collected classes/templates.
            const parent = allClasses.find(cls => cls.id === feat.origin) || allTemplates.find(tmpl => tmpl.id === feat.origin);
            const parentType = allTemplates.some(tmpl => tmpl.id === feat.origin) ? "Template" : "Class";
            translateFeature(feat, parent, parentType, droppedEffects);
        }
        else if (feat.active_effects)
        {
            droppedEffects.push({ feature: feat.id, count: Array.isArray(feat.active_effects) ? feat.active_effects.length : 1 });
            delete feat.active_effects;
        }
        if (Array.isArray(feat.damage))
        {
            for (const damageEntry of feat.damage)
            {
                if (damageEntry?.val !== undefined && damageEntry.damage === undefined)
                {
                    damageEntry.damage = damageEntry.val;
                    delete damageEntry.val;
                }
            }
        }
    }

    // v2 has no layer swap, so each Eidolon layer becomes an NPC template plus features in an "Eidolons" folder.
    const eidolonTemplateLids = [];
    const eidolonFeatureLids = [];
    const eidolonZipFile = inZip.file("eidolon_layers.json");
    if (eidolonZipFile)
    {
        try
        {
            const layers = JSON.parse(await eidolonZipFile.async("string"));
            for (const layer of Array.isArray(layers) ? layers : [])
            {
                if (!layer?.id || !layer?.name)
                {
                    droppedLayers.push(layer?.id || layer?.name || "unknown");
                    continue;
                }
                eidolonTemplateLids.push(layer.id);
                // A template only has a description, so rules, hints and shards become their own features.
                allTemplates.push({
                    id: layer.id,
                    name: layer.name,
                    description: layer.appearance ? `<p><em>${layer.appearance}</em></p>` : "",
                    base_features: [],
                    optional_features: []
                });
                // Layer features → NPC features with origin=Template pointing at the layer.
                const layerTmpl = allTemplates[allTemplates.length - 1];
                const layerFeatures = Array.isArray(layer.features) ? [...layer.features] : [];

                // Rules and hints become a "<Layer>'s Rules" trait.
                if (layer.rules || layer.hints)
                {
                    const rulesParts = [];
                    if (layer.rules)
                        rulesParts.push(`<p>${layer.rules}</p>`);
                    if (layer.hints)
                        rulesParts.push(`<p><strong>Hints:</strong> ${layer.hints}</p>`);
                    layerFeatures.push({
                        id: `${layer.id}_rules`,
                        name: `${layer.name}'s Rules`,
                        origin: layer.id,
                        type: "Trait",
                        base: true,
                        effect: rulesParts.join("")
                    });
                }

                // Shards become a synthesized Trait feature "<LayerName>'s Shard" rather
                // than a wall of text in the template description.
                if (layer.shards)
                {
                    const shards = layer.shards;
                    const count = shards.count ?? "";
                    const shardDamage = Array.isArray(shards.damage)
                        ? shards.damage.map(damageEntry =>
                        {
                            const aoe = (typeof damageEntry?.aoe === "string" && damageEntry.aoe.trim()) ? ` (${damageEntry.aoe})` : "";
                            return `${damageEntry?.val ?? ""} ${damageEntry?.type ?? ""}${aoe}`.trim();
                        }).filter(Boolean).join(", ")
                        : "";
                    const shardEffect = [
                        count ? `<p><strong>Spawns:</strong> ${count} shard${count === 1 ? "" : "s"}</p>` : "",
                        shards.detail ? `<p>${shards.detail}</p>` : "",
                        shardDamage ? `<p><strong>Shard damage:</strong> ${shardDamage}</p>` : ""
                    ].filter(Boolean).join("");
                    layerFeatures.push({
                        id: `${layer.id}_shard`,
                        name: `${layer.name}'s Shard`,
                        origin: layer.id,
                        type: "Trait",
                        base: true,
                        effect: shardEffect
                    });
                }

                for (const feat of layerFeatures)
                {
                    // Eidolon layer features are always available (v3 has no "optional"),
                    // so force base: true to list them under Base Features.
                    feat.base = true;
                    // System/Trait/Reaction/Tech features carry prose in actions[].detail, not
                    // `effect`: fold it in and emit tg_*_action activation tags for the badge.
                    const activationTagMap = { Quick: "tg_quick_action", Full: "tg_full_action", Free: "tg_free_action", Protocol: "tg_protocol", Reaction: "tg_reaction" };
                    const tagsToAdd = [];
                    if (Array.isArray(feat.actions) && feat.actions.length)
                    {
                        if (!feat.effect)
                        {
                            const actionChunks = feat.actions.map(action =>
                            {
                                if (!action)
                                    return "";
                                const bits = [];
                                if (action.name)
                                    bits.push(`<strong>${action.name}</strong>`);
                                if (action.activation)
                                    bits.push(`<em>(${action.activation})</em>`);
                                const header = bits.join(" ");
                                return [header, action.detail].filter(Boolean).join(": ");
                            }).filter(Boolean);
                            if (actionChunks.length)
                                feat.effect = actionChunks.join("<br>");
                        }
                        for (const action of feat.actions)
                        {
                            const tag = activationTagMap[action?.activation];
                            if (tag)
                                tagsToAdd.push({ id: tag });
                        }
                    }
                    // attacks > 1 becomes multi-attack text. String AoE shapes are kept, a bare `aoe: true` is dropped.
                    if (feat.attacks && feat.attacks > 1)
                    {
                        const prose = `This weapon can make ${feat.attacks}/${feat.attacks}/${feat.attacks} attacks at a time. Multiple attacks may be made against the same or different targets.`;
                        feat.effect = prose + (feat.effect ? `<br>${feat.effect}` : "");
                    }
                    if (Array.isArray(feat.damage))
                    {
                        for (const damageEntry of feat.damage)
                        {
                            if (damageEntry?.aoe && typeof damageEntry.aoe === "string" && damageEntry.aoe.trim())
                            {
                                feat.effect = (feat.effect ?? "") + (feat.effect ? "<br>" : "") + `<em>AoE:</em> ${damageEntry.aoe}`;
                            }
                            delete damageEntry?.aoe;
                        }
                    }
                    delete feat.attacks;
                    // Defensive: clean up feat.tags (drop empty/invalid entries), then append
                    // our activation tags.
                    feat.tags = (Array.isArray(feat.tags) ? feat.tags : []).filter(tag => tag && typeof tag.id === "string" && tag.id);
                    for (const tag of tagsToAdd)
                        if (!feat.tags.some(existing => existing.id === tag.id))
                            feat.tags.push(tag);
                    translateFeature(feat, layerTmpl, "Template", droppedEffects);
                    allFeatures.push(feat);
                    eidolonFeatureLids.push(feat.id);
                }
            }
        }
        catch (e)
        {
            console.error("lancer-npc-import | v3-lcp | eidolon layer translation failed", e);
            droppedLayers.push("eidolon_layers.json (parse error)");
        }
    }

    // Normalize any v3-shape classes/templates that lived in the legacy flat files.
    for (const cls of allClasses)
        translateClassStats(cls);

    // Rebuild base_features / optional_features on classes + templates.
    for (const cls of allClasses)
        translateNpcClass(cls, droppedEffects);
    for (const tmpl of allTemplates)
        translateNpcTemplate(tmpl, droppedEffects);
    for (const feat of allFeatures)
        translateNpcFeatureCommon(feat, droppedEffects);

    for (const cls of allClasses)
        rebuildFeatureListsOnClass(cls, allFeatures);
    for (const tmpl of allTemplates)
        rebuildFeatureListsOnClass(tmpl, allFeatures);

    for (const feat of allFeatures)
        stripSidecar(feat);

    if (allClasses.length)
        outZip.file("npc_classes.json", JSON.stringify(allClasses, null, 2));
    if (allFeatures.length)
        outZip.file("npc_features.json", JSON.stringify(allFeatures, null, 2));
    if (allTemplates.length)
        outZip.file("npc_templates.json", JSON.stringify(allTemplates, null, 2));

    // Apply v3→v2 translators on each non-NPC bucket. Order: weapons/systems/mods first
    // so frames' flattenIntegrated fan-out can append into the same buckets before emit.
    const droppedItemEffects = [];
    const translateOrder = ["weapons", "systems", "mods", "frames", "pilot_gear",
        "skills", "talents", "bonds", "reserves", "tags", "statuses", "core_bonuses"];
    for (const bucket of translateOrder)
    {
        const entries = contentBuckets[bucket];
        if (!entries?.length)
            continue;
        applyItemTranslators(bucket, entries, droppedItemEffects);
    }
    for (const [bucket, entries] of Object.entries(contentBuckets))
    {
        if (!entries.length)
            continue;
        outZip.file(bucketFilename[bucket], JSON.stringify(entries, null, 2));
    }

    // (Eidolon layers were already translated into templates/features above.)

    const outBlob = await outZip.generateAsync({ type: "blob" });
    const itemCounts = Object.fromEntries(
        Object.entries(contentBuckets).filter(([, entries]) => entries.length).map(([bucket, entries]) => [bucket, entries.length])
    );
    return {
        blob: outBlob,
        manifest: outManifest,
        pureData,
        summary: {
            alreadyV2: false,
            classes: allClasses.length,
            features: allFeatures.length,
            templates: allTemplates.length,
            items: itemCounts,
            droppedActiveEffects: droppedEffects,
            droppedItemActiveEffects: droppedItemEffects,
            droppedEidolonLayers: droppedLayers,
            eidolonTemplateLids,
            eidolonFeatureLids
        }
    };
}

// The Lancer bundle file names are hashed per release, so parseContentPack and importCP are looked up at runtime.
let _lancerApi = null;
export async function getLancerApi()
{
    if (_lancerApi)
        return _lancerApi;
    const entrySrc = await fetch("/systems/lancer/lancer.mjs").then(resp => resp.text());

    const actorMatch = entrySrc.match(/(?:from|import)\s+['"](\.\/)?(lancer-actor-[^'"]+\.mjs)['"]/);
    const compMatch  = entrySrc.match(/(?:from|import)\s+['"](\.\/)?(comp-builder-[^'"]+\.mjs)['"]/);
    if (!actorMatch || !compMatch)
        throw new Error("v3-lcp-shim: Lancer v3 bundles not found");

    // Signature scan survives minified-name reshuffles between v3.x versions.
    const findFn = (mod, preferred, sig) =>
    {
        if (typeof mod?.[preferred] === "function") return mod[preferred];
        for (const value of Object.values(mod ?? {}))
            if (typeof value === "function") { try { if (sig.test(value.toString())) return value; } catch (_) {} }
        return null;
    };
    const [actorMod, compMod] = await Promise.all([
        import(`/systems/lancer/${actorMatch[2]}`),
        import(`/systems/lancer/${compMatch[2]}`)
    ]);
    const parse    = findFn(actorMod, "st", /loadAsync|lcp_manifest|JSZip|content_packs/);
    const importCp = findFn(compMod, "n",  /coreBonuses[\s\S]{0,400}npcClasses|npcFeatures[\s\S]{0,400}npcTemplates/);
    if (typeof parse !== "function" || typeof importCp !== "function")
        throw new Error("v3-lcp-shim: parseContentPack/importCP not found in v3 bundles");

    _lancerApi = { parseContentPack: parse, importCP: importCp };
    return _lancerApi;
}

// Download path, used when the translated pack is saved instead of imported.
async function triggerDownload(blob, filename)
{
    const save = globalThis.saveDataToFile ?? foundry.utils?.saveDataToFile;
    if (save)
    {
        try
        {
            save(blob, blob.type || "application/octet-stream", filename); return;
        }
        catch (e)
        {
            console.warn("lancer-npc-import | v3-lcp | saveDataToFile failed, falling back", e);
        }
    }
    const dataUrl = await new Promise((resolve, reject) =>
    {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
    const anchor = document.createElement("a");
    anchor.href = dataUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
}

export async function pickAndTranslateV3Lcp()
{
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".lcp,application/zip";
    const picked = await new Promise(resolve =>
    {
        input.onchange = () => resolve(input.files?.[0] ?? null);
        input.click();
    });
    if (!picked)
        return;
    try
    {
        const { blob, manifest, summary } = await translateV3LcpBlob(picked);
        if (summary.alreadyV2)
        {
            ui.notifications.info(`"${manifest.name}" is already v2. Nothing to translate.`);
            return;
        }
        const baseName = picked.name.replace(/\.lcp$/i, "");
        triggerDownload(blob, `${baseName}.v2.lcp`);
        const notes = [];
        const npcEffects = sumActiveEffects(summary.droppedActiveEffects);
        if (npcEffects.total)
            notes.push(`NPC active_effects: ${npcEffects.lifted} lifted to bonuses/actions, ${npcEffects.textOnly} text-only (of ${npcEffects.total})`);
        const itemEffects = sumActiveEffects(summary.droppedItemActiveEffects);
        if (itemEffects.total)
            notes.push(`Item active_effects: ${itemEffects.lifted} lifted, ${itemEffects.textOnly} text-only (of ${itemEffects.total})`);
        if (summary.droppedEidolonLayers.length)
            notes.push(`${summary.droppedEidolonLayers.length} eidolon layers dropped`);
        const itemCounts = itemCountText(summary);
        const message = `Translated "${manifest.name}" → v2 (${summary.classes} classes, ${summary.features} features, ${summary.templates} templates`
            + (itemCounts ? `; ${itemCounts}` : "") + ")"
            + (notes.length ? `. ${notes.join("; ")}.` : ".");
        ui.notifications.info(message);
        console.log("lancer-npc-import | v3-lcp | translation summary", summary);
    }
    catch (e)
    {
        console.error("lancer-npc-import | v3-lcp | translation failed", e);
        ui.notifications.error(`V3 LCP translation failed: ${e.message}`);
    }
}

// The translate button ONLY appears when the currently selected file is a v3 LCP,
// and it replaces the native "Import LCP" button in-place so the flow feels native.

async function detectV3File(file)
{
    if (!file)
        return false;
    try
    {
        const JSZip = await getJSZip();
        const zip = await JSZip.loadAsync(file);
        const manifest = await readJsonIfExists(zip, "lcp_manifest.json");
        return isV3Pack(zip, manifest);
    }
    catch (e)
    {
        console.warn("lancer-npc-import | v3-lcp | v3 detection failed", e);
        return false;
    }
}

// Cache translation results keyed by File so we don't re-translate between
// preview-rendering and button-click. WeakMap cleans up automatically.
const _translationCache = new WeakMap();

async function getOrTranslate(file)
{
    const cached = _translationCache.get(file);
    if (cached)
        return cached;
    const result = await translateV3LcpBlob(file);
    _translationCache.set(file, result);
    return result;
}

// Render a Lancer-style summary of v3 content into the details panel.
const V3_SUMMARY_ITEMS = [
    ["classes", "NPC classes"],
    ["features", "NPC features"],
    ["templates", "NPC templates"]
];
const V3_ITEM_LABELS = {
    frames: "frames",
    weapons: "mech weapons",
    systems: "mech systems",
    mods: "weapon mods",
    pilot_gear: "pilot gear",
    skills: "skills",
    talents: "talents",
    bonds: "bonds",
    reserves: "reserves",
    tags: "tags",
    statuses: "statuses",
    core_bonuses: "core bonuses"
};
function renderV3Summary(root, anchor, summary)
{
    // De-dupe: there can be at most one summary element across the whole manager root,
    // and it must live under the current anchor. Remove any strays from previous renders.
    const existing = Array.from(root.querySelectorAll(".lni-v3-summary"));
    let el = existing.find(node => node.parentElement === anchor);
    for (const stray of existing)
        if (stray !== el)
            stray.remove();
    // Idempotent build: hash the summary input and skip rebuilding innerHTML if unchanged,
    // which prevents MutationObserver feedback loops.
    const payloadKey = JSON.stringify({
        c: summary.classes,
        f: summary.features,
        t: summary.templates,
        i: summary.items,
        ae: summary.droppedActiveEffects?.length,
        iae: summary.droppedItemActiveEffects?.length,
        el: summary.droppedEidolonLayers?.length
    });
    if (el && el.dataset.lniKey === payloadKey)
        return el;
    if (!el)
    {
        el = document.createElement("ul");
        el.className = "lni-v3-summary";
        el.style.cssText = "list-style: none; padding: 0 8px; margin: 4px 0;";
    }
    el.dataset.lniKey = payloadKey;
    const rows = [];
    for (const [key, label] of V3_SUMMARY_ITEMS)
    {
        const count = summary[key] ?? 0;
        if (count > 0)
            rows.push([count, label]);
    }
    for (const [key, label] of Object.entries(V3_ITEM_LABELS))
    {
        const count = summary.items?.[key] ?? 0;
        if (count > 0)
            rows.push([count, label]);
    }
    const droppedAe = sumActiveEffects(summary.droppedActiveEffects ?? []).total + sumActiveEffects(summary.droppedItemActiveEffects ?? []).total;
    const droppedLayers = summary.droppedEidolonLayers?.length ?? 0;
    el.innerHTML = rows.map(([count, label]) =>
        `<li style="display: flex; align-items: center; gap: 8px; margin: 2px 0;">
            <span style="display: inline-block; min-width: 28px; padding: 2px 6px; background: #a91c1c; color: #fff; border-radius: 12px; text-align: center; font-weight: bold;">${count}</span>
            <span>${label}</span>
        </li>`
    ).join("") + (droppedAe || droppedLayers
        ? `<li style="margin-top: 6px; font-size: 0.85em; opacity: 0.75;">
               ${droppedAe ? `${droppedAe} active_effect blocks translated or text-mapped. ` : ""}
               ${droppedLayers ? `${droppedLayers} eidolon layers dropped (v3-only).` : ""}
           </li>`
        : "");
    return el;
}

// Post-import step: move imported eidolon templates / features into a dedicated
// "Eidolons" folder within their compendium pack so GMs can tell them apart at a glance.
async function sortEidolonContentIntoFolder(summary)
{
    const templateLids = summary?.eidolonTemplateLids ?? [];
    const featureLids = summary?.eidolonFeatureLids ?? [];
    if (!templateLids.length && !featureLids.length)
        return;
    const moveToEidolonFolder = async (pack, lids) =>
    {
        if (!pack || !lids.length)
            return;
        const indexEntries = pack.index.filter(entry => lids.includes(entry.system?.lid));
        if (!indexEntries.length)
            return;
        // Lancer's importCP locks packs on completion; unlock to modify, relock after.
        const wasLocked = pack.locked;
        if (wasLocked)
            await pack.configure({ locked: false });
        try
        {
            let folder = pack.folders.find(candidate => candidate.name === "Eidolons");
            if (!folder)
            {
                folder = await Folder.create(
                    { name: "Eidolons", type: pack.metadata.type },
                    { pack: pack.collection }
                );
            }
            const updates = indexEntries.map(entry => ({ _id: entry._id, folder: folder.id }));
            const documentClass = CONFIG[pack.metadata.type].documentClass;
            await documentClass.updateDocuments(updates, { pack: pack.collection });
        }
        finally
        {
            if (wasLocked)
                await pack.configure({ locked: true });
        }
    };
    const templatePack = game.packs.find(pack => pack.metadata.type === "Item" && /npc.template/i.test(pack.collection))
        ?? game.packs.get("world.npc-templates");
    const featurePack = game.packs.find(pack => pack.metadata.type === "Item" && /npc.feature/i.test(pack.collection))
        ?? game.packs.get("world.npc-features");
    const itemsPack = game.packs.get("world.npc-items"); // fallback if templates + features live in one pack
    await moveToEidolonFolder(templatePack ?? itemsPack, templateLids);
    await moveToEidolonFolder(featurePack ?? itemsPack, featureLids);
}

async function importLcpDowntime(file)
{
    const importer = game.modules.get("lancer-automations")?.api?.importDowntimeActionsJson;
    if (!importer)
        return;
    try
    {
        const JSZip = await getJSZip();
        const zip = await JSZip.loadAsync(file);
        const v3 = await readJsonIfExists(zip, "downtime_actions.json");
        const actions = await readJsonIfExists(zip, "actions.json");
        const entries = Array.isArray(v3) && v3.length
            ? v3
            : (Array.isArray(actions) ? actions.filter(entry => entry?.activation === "Downtime") : []);
        if (entries.length)
            await importer(JSON.stringify(entries));
    }
    catch (e)
    {
        console.warn("lancer-npc-import | v3-lcp | downtime import failed", e);
    }
}

async function translateSelectedV3(file)
{
    try
    {
        const { blob, manifest, summary, pureData } = await getOrTranslate(file);
        if (summary.alreadyV2)
        {
            ui.notifications.info(`"${manifest.name}" is already v2. Nothing to translate.`);
            return;
        }

        // Hand the translated zip straight to the Lancer system: parseContentPack → importCP.
        // No download, no re-select, no second click.
        ui.notifications.info(`Translating "${manifest.name}" and importing...`);
        const api = await getLancerApi();
        const arrayBuf = await blob.arrayBuffer();
        const contentPack = await api.parseContentPack(arrayBuf);
        let lastPercent = -1;
        let createdCount = 0;
        const progress = (done, total) =>
        {
            createdCount = done;
            if (!total)
                return;
            const percent = Math.floor((done / total) * 100);
            if (percent !== lastPercent && percent % 10 === 0)
            {
                console.log(`lancer-npc-import | v3-lcp | import progress ${percent}% (${done}/${total})`);
                lastPercent = percent;
            }
        };
        const importErrors = [];
        const originalConsoleError = console.error;
        console.error = (...args) =>
        {
            importErrors.push(...args.filter(arg => arg instanceof Error));
            originalConsoleError.apply(console, args);
        };
        const pack = `${manifest.name ?? ""} ${manifest.version ?? ""}`.trim();
        const flagFor = pure => ({ pack, entries: Object.entries(pure).map(([path, data]) => ({ path, data })) });
        const stampCreate = (document, data) =>
        {
            const pure = pureData?.[data?.system?.lid ?? document.system?.lid];
            if (pure)
                document.updateSource({ [`flags.${MODULE_ID}.v3`]: flagFor(pure) });
        };
        const stampUpdate = (document, changes) =>
        {
            const pure = pureData?.[document.system?.lid];
            if (pure)
                foundry.utils.setProperty(changes, `flags.${MODULE_ID}.==v3`, flagFor(pure));
            else if (document.getFlag(MODULE_ID, "v3"))
                foundry.utils.setProperty(changes, `flags.${MODULE_ID}.-=v3`, null);
        };
        const createHookId = Hooks.on("preCreateItem", stampCreate);
        const updateHookId = Hooks.on("preUpdateItem", stampUpdate);
        try
        {
            await api.importCP(contentPack, progress);
        }
        finally
        {
            console.error = originalConsoleError;
            Hooks.off("preCreateItem", createHookId);
            Hooks.off("preUpdateItem", updateHookId);
        }
        if (importErrors.length && !createdCount)
            throw importErrors[0];

        // Post-import: move eidolon content into a dedicated "Eidolons" subfolder in
        // each pack so GMs don't confuse layer templates / features with regular NPC content.
        await sortEidolonContentIntoFolder(summary);
        await importLcpDowntime(file);

        const notes = [];
        const npcEffects = sumActiveEffects(summary.droppedActiveEffects);
        if (npcEffects.total)
            notes.push(`NPC active_effects: ${npcEffects.lifted} lifted, ${npcEffects.textOnly} text-only`);
        const itemEffects = sumActiveEffects(summary.droppedItemActiveEffects);
        if (itemEffects.total)
            notes.push(`Item active_effects: ${itemEffects.lifted} lifted, ${itemEffects.textOnly} text-only`);
        if (summary.droppedEidolonLayers.length)
            notes.push(`${summary.droppedEidolonLayers.length} eidolon layers dropped`);
        if (importErrors.length)
            notes.push(`${importErrors.length} import errors, see console`);
        const itemCounts = itemCountText(summary);
        const message = `Imported "${manifest.name}" (${summary.classes} classes, ${summary.features} features, ${summary.templates} templates`
            + (itemCounts ? `; ${itemCounts}` : "") + ")"
            + (notes.length ? `. ${notes.join("; ")}.` : ".");
        ui.notifications[importErrors.length ? "warn" : "info"](message);
        console.log("lancer-npc-import | v3-lcp | import complete", summary);

        // Refresh the Compendium Manager so the installed/current column reflects the new import.
        const manager = Object.values(ui.windows).find(win => win?.constructor?.name === "LCPManager");
        manager?.render?.(false);
    }
    catch (e)
    {
        console.error("lancer-npc-import | v3-lcp | import failed", e);
        ui.notifications.error(`V3 LCP import failed: ${e.message}`);
    }
}

// Toggle the translate button per file selection. Lancer only renders its native
// "Import LCP" for parseable LCPs (v3 fails), so for v3 we inject our own button.
async function refreshButtonState(root)
{
    const importBtn = root.querySelector("button.lcp-import");
    const fileInput = root.querySelector('input[type="file"]');
    if (!importBtn && !fileInput)
        return;
    const file = fileInput?.files?.[0];
    let translateBtn = root.querySelector(".lni-translate-v3-btn");

    if (!file)
    {
        if (importBtn)
            importBtn.style.removeProperty("display");
        translateBtn?.remove();
        return;
    }

    const isV3 = await detectV3File(file);

    if (!isV3)
    {
        if (importBtn)
            importBtn.style.removeProperty("display");
        translateBtn?.remove();
        return;
    }

    // v3 path. Hide the native button if it exists.
    if (importBtn)
        importBtn.style.display = "none";

    // Find an anchor to place our button: the native button's parent if it exists,
    // else the details panel, else the file-select container, else the root.
    const anchor = importBtn?.parentElement
        ?? root.querySelector(".lcp-details")
        ?? root.querySelector(".file-select-container")
        ?? root.querySelector(".lcp-manager")
        ?? root;

    // Translate once (cached) to compute content counts for the summary preview.
    let result = null;
    try
    {
        result = await getOrTranslate(file);
    }
    catch (e)
    {
        console.error("lancer-npc-import | v3-lcp | preview translation failed", e);
    }

    // Skip our summary if the Lancer system rendered its own content-summary list
    // (detected as a .lcp-details <li> with count-shaped text) to avoid duplication.
    const nativeItems = Array.from(root.querySelectorAll(".lcp-details ul li, .lcp-details .content-summary li"))
        .filter(li =>
        {
            const text = (li.textContent ?? "").trim();
            return text.length > 0 && /\d/.test(text);
        });
    const nativeSummaryPresent = nativeItems.length > 0;

    // Ensure the button exists first so we can position the summary above it.
    if (!translateBtn)
    {
        translateBtn = document.createElement("button");
        translateBtn.type = "button";
        translateBtn.innerHTML = `<i class="cci cci-content-manager"></i> Import v3 LCP`;
    }
    const desiredClass = (importBtn?.className ? importBtn.className + " " : "") + "lni-translate-v3-btn";
    if (translateBtn.className !== desiredClass)
        translateBtn.className = desiredClass;
    if (!translateBtn.style.cssText)
    {
        translateBtn.style.cssText = "margin: 8px; padding: 8px 12px; width: calc(100% - 16px); font-size: 14px;";
    }
    if (translateBtn.parentElement !== anchor)
        anchor.appendChild(translateBtn);
    translateBtn.onclick = (ev) =>
    {
        ev.preventDefault(); translateSelectedV3(file);
    };

    // Summary goes ABOVE the translate button when visible.
    if (result?.summary && !result.summary.alreadyV2 && !nativeSummaryPresent)
    {
        const summaryEl = renderV3Summary(root, anchor, result.summary);
        if (summaryEl.parentElement !== anchor || summaryEl.nextSibling !== translateBtn)
        {
            anchor.insertBefore(summaryEl, translateBtn);
        }
    }
    else
    {
        root.querySelectorAll(".lni-v3-summary").forEach(node => node.remove());
    }
}

// Watch file-input changes and Svelte re-renders. A time-gated _muting flag set
// during refreshButtonState makes the observer ignore our own mutations.
let _muting = false;

function wireLcpManager(_app, html)
{
    const root = html instanceof HTMLElement ? html : html?.[0] ?? html;
    if (!root || root.dataset.lniV3Wired === "1")
        return;
    root.dataset.lniV3Wired = "1";

    let inFlight = false;
    let pending = false;
    let debounceTimer = null;
    const run = async () =>
    {
        if (inFlight)
        {
            pending = true; return;
        }
        inFlight = true;
        _muting = true;
        try
        {
            await refreshButtonState(root);
        }
        catch (err)
        {
            console.error("lancer-npc-import | v3-lcp | failed", err);
        }
        finally
        {
            inFlight = false;
            // Release the mute flag AFTER observer microtasks from our mutations fire.
            setTimeout(() =>
            {
                _muting = false;
            }, 50);
            if (pending)
            {
                pending = false; setTimeout(schedule, 80);
            }
        }
    };
    const schedule = () =>
    {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(run, 60);
    };

    const attachInputListener = () =>
    {
        const input = root.querySelector('input[type="file"]');
        if (input && !input.dataset.lniAttached)
        {
            input.dataset.lniAttached = "1";
            input.addEventListener("change", schedule);
        }
    };
    attachInputListener();

    root.addEventListener("click", event =>
    {
        if (!event.target.closest?.("button.lcp-import:not(.lni-translate-v3-btn)"))
            return;
        const file = root.querySelector('input[type="file"]')?.files?.[0];
        if (file)
            importLcpDowntime(file);
    });

    const observer = new MutationObserver(() =>
    {
        if (_muting)
            return; // our own mutations, ignore
        attachInputListener();
        schedule();
    });
    observer.observe(root, { childList: true, subtree: true });

    schedule();
}

export function registerV3LcpShim()
{
    Hooks.on("renderLCPManager", wireLcpManager);
    Hooks.on("renderApplicationV2", (app, html) =>
    {
        if (app?.constructor?.name === "LCPManager")
            wireLcpManager(app, html);
    });
    const mod = game.modules.get(MODULE_ID);
    if (mod)
    {
        mod.api = mod.api || {};
        mod.api.translateV3LcpBlob = translateV3LcpBlob;
        mod.api.pickAndTranslateV3Lcp = pickAndTranslateV3Lcp;
        mod.api.getV3Data = getV3Data;
    }
    console.log("lancer-npc-import | v3-lcp | registered");
}

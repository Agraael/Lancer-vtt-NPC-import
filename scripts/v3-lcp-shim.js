// V3 -> V2 LCP translator: rewrites a Comp/Con v3 LCP zip into the legacy v2 shape.
// active_effects lift into native bonuses/actions/deployables or effect text; eidolon layers drop.

const MODULE_ID = "lancer-npc-import";
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

function hasV3Layout(zip)
{
    return Object.keys(zip.files).some(name =>
        /^npcc_.+\.json$/i.test(name) ||
        /^npct_.+\.json$/i.test(name) ||
        /^license_.+\.json$/i.test(name) ||
        name === "eidolon_layers.json"
    );
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

// v3 active_effect -> v2 translation. Lancer 2.x natively models action damage/range/
// frequency/trigger and bonuses (save/attack/armor, added_damage); the rest falls back to text.

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

// Text fragments with no Lancer v2 schema equivalent on items. Returns "" when the
// active_effect has nothing beyond its name label, so we don't emit bare `**Name**` trailers.
function renderResidualText(ae, handled)
{
    if (!ae)
        return "";
    const meta = [];
    if (ae.duration)
        meta.push(`Duration: ${ae.duration}`);
    if (ae.condition && !handled.trigger)
        meta.push(`When: ${ae.condition}`);
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
    if (ae.add_status)
    {
        const text = renderTokens(ae.add_status); if (text)
            extras.push(`Applies status: ${text}`);
    }
    if (ae.add_resist)
    {
        const text = renderTokens(ae.add_resist); if (text)
            extras.push(`Grants resistance: ${text}`);
    }
    if (ae.add_special)
    {
        const text = renderTokens(ae.add_special); if (text)
            extras.push(`Special: ${text}`);
    }
    if (ae.remove_special)
    {
        const text = renderTokens(ae.remove_special); if (text)
            extras.push(`Removes special: ${text}`);
    }
    // Structured save object: surface stat/dc/on_success/on_fail in text.
    // Scalar save is already lifted into bonuses by liftActiveEffects.
    if (ae.save && typeof ae.save === "object")
    {
        const parts = [];
        if (ae.save.stat)
            parts.push(String(ae.save.stat).toUpperCase());
        if (ae.save.dc !== undefined)
            parts.push(String(ae.save.dc));
        const head = parts.join(" ");
        const tail = [];
        if (ae.save.on_success)
            tail.push(`success: ${ae.save.on_success}`);
        if (ae.save.on_fail)
            tail.push(`fail: ${ae.save.on_fail}`);
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
    return (value ?? "").toString().toLowerCase().replaceAll(/\*+/g, "").replaceAll(/[^\w\s]/g, " ").replaceAll(/\s+/g, " ").trim();
}
function existingContainsBody(existing, chunk)
{
    if (!existing || !chunk)
        return false;
    // Skip the "**Name** — " header so we compare actual body content.
    const body = chunk.split(" — ").slice(1).join(" — ");
    if (!body)
        return true; // header-only; already filtered but guard anyway
    const existingNorm = textNormalize(existing);
    const bodyNorm = textNormalize(body);
    return bodyNorm.length > 12 && existingNorm.includes(bodyNorm);
}

// Detect whether this active_effect describes an action (has attack/damage/range/trigger-shaped data).
function aeLooksLikeAction(ae)
{
    return !!(ae && (ae.damage || ae.range || ae.attack || ae.accuracy !== undefined || ae.condition || ae.frequency));
}

function liftActiveEffects(item)
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

        // 1) Native arrays pass through unchanged (identical v2/v3 shapes).
        if (Array.isArray(ae.bonuses) && ae.bonuses.length)
        {
            item.bonuses = (item.bonuses ?? []).concat(ae.bonuses);
            lifted++;
        }
        if (Array.isArray(ae.actions) && ae.actions.length)
        {
            item.actions = (item.actions ?? []).concat(ae.actions);
            lifted++;
        }
        if (Array.isArray(ae.deployables) && ae.deployables.length)
        {
            item.deployables = (item.deployables ?? []).concat(ae.deployables);
            lifted++;
        }
        if (Array.isArray(ae.synergies) && ae.synergies.length)
        {
            item.synergies = (item.synergies ?? []).concat(ae.synergies);
            lifted++;
        }
        if (Array.isArray(ae.counters) && ae.counters.length)
        {
            item.counters = (item.counters ?? []).concat(ae.counters);
            lifted++;
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
                tech_attack: !!ae.attack,
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
            lifted++;
        }

        // 3) Scalar bonus-shaped fields → item.bonuses[].
        const newBonuses = [];
        if (ae.save !== undefined && ae.save !== null && ae.save !== "")
        {
            // v3 save can be scalar (legacy) or structured {stat, dc, on_success, on_fail}.
            // Use dc as the bonus value; full structure surfaces in residual text.
            const scalarSave = typeof ae.save === "object" ? ae.save.dc : ae.save;
            if (scalarSave !== undefined && scalarSave !== null && scalarSave !== "")
                newBonuses.push({ lid: "save", val: String(scalarSave) });
        }
        if (typeof ae.accuracy === "number" && ae.accuracy !== 0)
        {
            const sign = ae.accuracy > 0 ? "+" : "";
            newBonuses.push({ lid: "attack", val: `${sign}${ae.accuracy}` });
        }
        if (ae.bonus_damage)
        {
            const bds = Array.isArray(ae.bonus_damage) ? ae.bonus_damage : [ae.bonus_damage];
            const added_damage = bds.map(toV2Damage).filter(Boolean);
            if (added_damage.length)
            {
                // added_damage attaches to a bonus. Use lid "damage" as the neutral carrier.
                newBonuses.push({ lid: "damage", val: "0", added_damage });
            }
        }
        if (newBonuses.length)
        {
            item.bonuses = (item.bonuses ?? []).concat(newBonuses);
            lifted++;
        }

        // 4) Residual unmapped text appended to effect.
        const text = renderResidualText(ae, handled);
        if (text)
            textChunks.push(text);
    }

    if (textChunks.length)
    {
        const existing = typeof item.effect === "string" ? item.effect : "";
        // Skip chunks whose body is already present in the existing effect text
        // (v3 active_effects often restate the feature's main prose).
        const novel = textChunks.filter(chunk => !existingContainsBody(existing, chunk));
        if (novel.length)
        {
            // `effect` is an HTMLField: raw \n collapses to whitespace, use <br><br>.
            const block = novel.join("<br><br>");
            item.effect = existing ? `${existing}<br><br>${block}` : block;
        }
    }
    return lifted;
}

// Backward-compat alias used by on_* hook coercion.
function renderActiveEffectAsText(ae)
{
    return renderResidualText(ae, {});
}

// v3 on_* hooks can be { detail, ... } objects; v2 expects string.
function coerceOnHookString(value)
{
    if (value == null)
        return value;
    if (typeof value === "string")
        return value;
    if (typeof value === "object")
    {
        // Lift structured fields into the text.
        return renderActiveEffectAsText(value) || value.detail || "";
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
function stripV3Common(item, dropped)
{
    if (!item || typeof item !== "object")
        return;
    if (Array.isArray(item.active_effects) && item.active_effects.length)
    {
        const before = item.active_effects.length;
        const lifted = liftActiveEffects(item);
        if (dropped)
            dropped.push({ item: item.id ?? "?", total: before, lifted, textOnly: before - lifted });
    }
    for (const key of ["active_effects", "flavorDescription", "brew", "deprecated"])
    {
        if (item[key] !== undefined)
            delete item[key];
    }
}

// v3 active_effects/passive_effects arrays on core_system/traits → v2 HTMLField string.
function mergeEffectArrayToHtml(arr)
{
    if (!Array.isArray(arr))
        return "";
    const renderToken = token =>
    {
        if (token == null)
            return "";
        if (typeof token === "string")
            return token;
        if (typeof token === "object")
            return token.name ?? token.lid ?? token.id ?? "";
        return String(token);
    };
    const renderTokens = value => (Array.isArray(value) ? value : [value]).map(renderToken).filter(Boolean).join(", ");
    const renderDamage = value => (Array.isArray(value) ? value : [value]).map(damageEntry =>
    {
        if (typeof damageEntry === "string")
            return damageEntry;
        if (typeof damageEntry === "object")
            return [damageEntry.val ?? damageEntry.damage ?? "", damageEntry.type ?? ""].filter(Boolean).join(" ");
        return String(damageEntry);
    }).filter(Boolean).join(", ");

    const parts = [];
    for (const ae of arr)
    {
        if (!ae)
            continue;
        const label = ae.name ? `<strong>${ae.name}</strong>` : "";
        const meta = [];
        if (ae.frequency)
            meta.push(ae.frequency);
        if (ae.duration)
            meta.push(ae.duration);
        if (ae.target)
            meta.push(`Target: ${ae.target}`);
        const header = label + (meta.length ? ` (${meta.join(", ")})` : "");
        const body = ae.detail ?? "";
        const extras = [];
        if (ae.add_status)
        {
            const text = renderTokens(ae.add_status); if (text)
                extras.push(`Applies status: ${text}`);
        }
        if (ae.add_resist)
        {
            const text = renderTokens(ae.add_resist); if (text)
                extras.push(`Grants resistance: ${text}`);
        }
        if (ae.add_special)
        {
            const text = renderTokens(ae.add_special); if (text)
                extras.push(`Special: ${text}`);
        }
        if (ae.remove_special)
        {
            const text = renderTokens(ae.remove_special); if (text)
                extras.push(`Removes special: ${text}`);
        }
        if (ae.damage)
        {
            const text = renderDamage(ae.damage); if (text)
                extras.push(`Damage: ${text}`);
        }
        if (ae.bonus_damage)
        {
            const text = renderDamage(ae.bonus_damage); if (text)
                extras.push(`Bonus damage: ${text}`);
        }
        if (ae.save !== undefined && ae.save !== null && ae.save !== "")
        {
            if (typeof ae.save === "object")
            {
                const parts = [];
                if (ae.save.stat)
                    parts.push(String(ae.save.stat).toUpperCase());
                if (ae.save.dc !== undefined)
                    parts.push(String(ae.save.dc));
                const head = parts.join(" ");
                const tail = [];
                if (ae.save.on_success)
                    tail.push(`success: ${ae.save.on_success}`);
                if (ae.save.on_fail)
                    tail.push(`fail: ${ae.save.on_fail}`);
                extras.push(`Save${head ? ` ${head}` : ""}${tail.length ? ` (${tail.join("; ")})` : ""}`);
            }
            else
            {
                extras.push(`Save: ${ae.save}`);
            }
        }
        const chunk = [header, body].filter(Boolean).join(" ");
        const extrasChunk = extras.length ? `<em>${extras.join(" | ")}</em>` : "";
        const full = [chunk, extrasChunk].filter(Boolean).join("<br>");
        if (full)
            parts.push(`<p>${full}</p>`);
    }
    return parts.join("");
}

// v2 `integrated` must be string LIDs, not inline objects. v3 already ships
// string[] (compcon MechWeapon.ts), so this is defensive id-extraction only.
function flattenIntegrated(item)
{
    if (!Array.isArray(item?.integrated))
        return;
    item.integrated = item.integrated
        .map(entry => typeof entry === "string" ? entry : entry?.id)
        .filter(Boolean);
}

// v2 unpackAction calls .map() on damage/range; v3 may ship scalars or objects.
// Normalize each action to array-shaped damage/range/synergy_locations.
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

function normalizeBonusesList(list)
{
    if (!Array.isArray(list))
        return;
    for (const bonus of list)
        normalizeBonus(bonus);
}

// Recursively strip v3-only fields from embedded structures and normalize
// actions/bonuses so they survive Lancer's blind .map/.toString calls.
function stripNested(item, droppedAE)
{
    if (!item || typeof item !== "object")
        return;
    if (Array.isArray(item.deployables))
    {
        for (const deployable of item.deployables)
            if (deployable && typeof deployable === "object")
            {
                stripV3Common(deployable, droppedAE);
                normalizeActionsList(deployable.actions);
                normalizeBonusesList(deployable.bonuses);
            }
    }
    if (Array.isArray(item.actions))
    {
        for (const action of item.actions)
            if (action && typeof action === "object")
                stripV3Common(action, droppedAE);
        normalizeActionsList(item.actions);
    }
    normalizeBonusesList(item.bonuses);
    // Core-system prefixed arrays (frames): active_actions / passive_actions / active_bonuses / passive_bonuses.
    normalizeActionsList(item.active_actions);
    normalizeActionsList(item.passive_actions);
    normalizeBonusesList(item.active_bonuses);
    normalizeBonusesList(item.passive_bonuses);
}

// Lift v3 core_system active_effects[]/passive_effects[] into the v2 core_system
// schema: prefixed active_*/passive_* keys, free-form text to *_effect HTMLFields.
function liftCoreSystemEffects(core, kind)
{
    const key = `${kind}_effects`;
    const arr = core?.[key];
    if (!Array.isArray(arr) || arr.length === 0)
        return;
    const bonusKey = `${kind}_bonuses`;
    const actionKey = `${kind}_actions`;
    const synergyKey = `${kind}_synergies`;
    const effectKey = `${kind}_effect`;
    for (const ae of arr)
    {
        if (!ae)
            continue;
        if (Array.isArray(ae.bonuses) && ae.bonuses.length)
        {
            core[bonusKey] = (core[bonusKey] ?? []).concat(ae.bonuses);
        }
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
    const html = mergeEffectArrayToHtml(arr);
    if (html)
        core[effectKey] = (core[effectKey] || "") + html;
    delete core[key];
}

function translateFrame(frame, droppedAE)
{
    stripV3Common(frame, droppedAE);
    for (const key of ["specialty", "variant", "y_pos"])
        delete frame[key];
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
        flattenIntegrated(frame.core_system);
        stripNested(frame.core_system, droppedAE);
    }
    if (Array.isArray(frame.traits))
    {
        for (const trait of frame.traits)
        {
            stripV3Common(trait, droppedAE);
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
    translateOnHooks(mod);
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
            stripV3Common(rank, droppedAE);
            stripNested(rank, droppedAE);
        }
    }
}

function translateReserve(reserve, droppedAE)
{
    stripV3Common(reserve, droppedAE);
    stripNested(reserve, droppedAE);
}

function translateBond(bond, droppedAE)
{
    stripV3Common(bond, droppedAE);
    if (Array.isArray(bond.powers))
    {
        for (const power of bond.powers)
            stripV3Common(power, droppedAE);
    }
}

function translateNpcClass(npcClass, droppedAE)
{
    stripV3Common(npcClass, droppedAE);
    stripNested(npcClass, droppedAE);
}

function translateNpcTemplate(template, droppedAE)
{
    stripV3Common(template, droppedAE);
    stripNested(template, droppedAE);
}

function renderTierVal(value)
{
    if (Array.isArray(value))
        return value.join("/");
    if (value === null || value === undefined)
        return "";
    return String(value);
}

function renderRangeList(ranges)
{
    if (!Array.isArray(ranges) || !ranges.length)
        return "";
    return ranges.map(range =>
    {
        if (!range || typeof range !== "object")
            return "";
        const type = range.type ?? "";
        const value = range.val !== undefined ? renderTierVal(range.val) : "";
        return value !== "" ? `${type} ${value}` : type;
    }).filter(Boolean).join(", ");
}

function renderDamageList(damages)
{
    if (!Array.isArray(damages) || !damages.length)
        return "";
    return damages.map(damage =>
    {
        if (!damage || typeof damage !== "object")
            return "";
        const value = renderTierVal(damage.val ?? damage.damage);
        return value ? `${value} ${damage.type ?? ""}`.trim() : (damage.type ?? "");
    }).filter(Boolean).join(" + ");
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

function renderNpcActionsAsHtml(actions)
{
    if (!Array.isArray(actions) || !actions.length)
        return "";
    const blocks = [];
    for (const action of actions)
    {
        if (!action || typeof action !== "object")
            continue;
        const meta = [];
        if (action.activation)
            meta.push(action.activation);
        if (action.frequency)
            meta.push(action.frequency);
        const range = renderRangeList(action.range);
        if (range)
            meta.push(range);
        const dmg = renderDamageList(action.damage);
        if (dmg)
            meta.push(dmg);
        const header = `<strong>${action.name ?? "Action"}</strong>`
            + (meta.length ? ` <em>(${meta.join(", ")})</em>` : "");
        const parts = [header];
        const detail = typeof action.detail === "string" ? action.detail
            : (action.detail ? coerceOnHookString(action.detail) : "");
        if (detail)
            parts.push(detail);
        if (action.trigger)
            parts.push(`<strong>Trigger:</strong> ${typeof action.trigger === "string" ? action.trigger : coerceOnHookString(action.trigger)}`);
        const statuses = renderStatusList(action.add_status);
        if (statuses)
            parts.push(`<em>Applies status:</em> ${statuses}`);
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
    if (Array.isArray(feature.actions) && feature.actions.length)
    {
        if (feature.type === "Reaction" && !feature.trigger)
        {
            const firstTrigger = feature.actions.find(action => action?.trigger)?.trigger;
            if (firstTrigger)
                feature.trigger = typeof firstTrigger === "string" ? firstTrigger : coerceOnHookString(firstTrigger);
        }
        const html = renderNpcActionsAsHtml(feature.actions);
        if (html)
        {
            const existing = typeof feature.effect === "string" ? feature.effect : "";
            feature.effect = existing ? `${existing}<br><br>${html}` : html;
        }
        delete feature.actions;
    }
    // Lancer NPC feature only has `on_hit` as HTML; v3 NpcWeapon also carries
    // `on_attack`/`on_crit`, so coerce and merge those into `effect` (no v2 home).
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
    // v3 NPC feature damage val guarded to tier array; unpacker iterates damage.length.
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

function applyItemTranslators(type, arr, droppedAE)
{
    if (!Array.isArray(arr))
        return;
    switch (type)
    {
    case "frames": for (const entry of arr)
        translateFrame(entry, droppedAE); break;
    case "weapons": for (const entry of arr)
        translateMechWeapon(entry, droppedAE); break;
    case "systems": for (const entry of arr)
        translateMechSystem(entry, droppedAE); break;
    case "mods": for (const entry of arr)
        translateWeaponMod(entry, droppedAE); break;
    case "pilot_gear": for (const entry of arr)
        translatePilotGear(entry, droppedAE); break;
    case "talents": for (const entry of arr)
        translateTalent(entry, droppedAE); break;
    case "reserves": for (const entry of arr)
        translateReserve(entry, droppedAE); break;
    case "bonds": for (const entry of arr)
        translateBond(entry, droppedAE); break;
    default: for (const entry of arr)
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

async function readJsonIfExists(zip, name)
{
    const file = zip.file(name);
    if (!file)
        return null;
    try
    {
        return JSON.parse(await file.async("string"));
    }
    catch (e)
    {
        console.warn(`[v3-lcp-shim] Failed to parse ${name}`, e); return null;
    }
}

// Find the class/template "header" entry inside a per-file collection.
// v3 convention: the header has no `origin` field (or has `role` for classes).
function pickCollectionHeader(arr, kind)
{
    if (!Array.isArray(arr) || arr.length === 0)
        return null;
    if (kind === "Class")
        return arr.find(entry => entry?.role) ?? null;
    // Template: compcon v3 marks the header with `template: true` (ContentPackParser.ts:185).
    // Fall back to first entry with no `origin` string for older pre-release LCPs.
    return arr.find(entry => entry?.template === true)
        ?? arr.find(entry => entry && (typeof entry.origin !== "string" || !entry.origin))
        ?? null;
}

export async function translateV3LcpBlob(inputBlob)
{
    const JSZip = await getJSZip();
    const inZip = await JSZip.loadAsync(inputBlob);

    const manifest = await readJsonIfExists(inZip, "lcp_manifest.json");
    if (!manifest)
        throw new Error("No lcp_manifest.json in LCP");

    const isV3 = isV3Manifest(manifest) || hasV3Layout(inZip);
    if (!isV3)
        return { blob: null, manifest, summary: { alreadyV2: true } };

    const droppedEffects = [];
    const droppedLayers = [];
    const outZip = new JSZip();

    // Manifest: strip v3 flag so the system doesn't think it's still v3.
    const outManifest = { ...manifest };
    delete outManifest.v3;
    outZip.file("lcp_manifest.json", JSON.stringify(outManifest, null, 2));

    // Load + translate non-NPC content files.
    // Files the Lancer 2.x system actually reads get translated; others pass through.
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
        const arr = await readJsonIfExists(inZip, file);
        if (Array.isArray(arr))
            contentBuckets[bucket].push(...arr);
    }

    // v3 may split pilot_gear.json into pilot_armor.json + pilot_weapons.json;
    // Lancer 2.x wants one pilot_gear.json with per-entry type Armor/Weapon/Gear.
    for (const [file, typeTag] of [["pilot_armor.json", "Armor"], ["pilot_weapons.json", "Weapon"]])
    {
        const arr = await readJsonIfExists(inZip, file);
        if (Array.isArray(arr))
        {
            for (const entry of arr)
            {
                if (entry && entry.type === undefined)
                    entry.type = typeTag;
            }
            contentBuckets.pilot_gear.push(...arr);
        }
    }
    // Ensure any pre-existing pilot_gear entries without a type default to "Gear".
    for (const entry of contentBuckets.pilot_gear)
    {
        if (entry && entry.type === undefined)
            entry.type = "Gear";
    }

    // v3 may ship bond_powers.json separately; Lancer reads powers[] inside each bond (unpackBond:35039).
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
        const arr = await readJsonIfExists(inZip, name);
        if (!Array.isArray(arr))
            continue;
        const frame = arr.find(entry => entry?.mechtype);
        if (!frame)
        {
            console.warn(`[v3-lcp-shim] ${name}: no frame header (mechtype field)`); continue;
        }
        contentBuckets.frames.push(frame);
        const licenseMeta = {
            license: frame.name,
            license_id: frame.id,
            source: frame.source
        };
        for (const child of arr)
        {
            if (!child || child === frame)
                continue;
            const bucket = classifyLicenseChild(child);
            if (!bucket)
                continue;
            for (const [k, v] of Object.entries(licenseMeta))
            {
                if (child[k] === undefined && v !== undefined)
                    child[k] = v;
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
        const arr = await readJsonIfExists(inZip, name);
        if (Array.isArray(arr))
            allFeatures.push(...arr);
    }

    // Per-class v3 collection files.
    const npccNames = Object.keys(inZip.files).filter(fileName => /^npcc_.+\.json$/i.test(fileName));
    for (const name of npccNames)
    {
        const arr = await readJsonIfExists(inZip, name);
        if (!Array.isArray(arr))
            continue;
        const cls = pickCollectionHeader(arr, "Class");
        if (!cls)
        {
            console.warn(`[v3-lcp-shim] ${name}: no class header found`); continue;
        }
        translateClassStats(cls);
        const feats = arr.filter(entry => entry && entry !== cls);
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
        const arr = await readJsonIfExists(inZip, name);
        if (!Array.isArray(arr))
            continue;
        const tmpl = pickCollectionHeader(arr, "Template");
        if (!tmpl)
        {
            console.warn(`[v3-lcp-shim] ${name}: no template header found`); continue;
        }
        const feats = arr.filter(entry => entry && entry !== tmpl);
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

    // Eidolon layers become NPC templates + features (v2 has no swappable-layer mechanic):
    // dumped into the compendium for manual GM use, tagged for an "Eidolons" subfolder.
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
                // NPC template schema has only description + base/optional_features. Keep
                // description to appearance flavor; rules/hints/shards become own features.
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

                // Rules + Hints become a synthesized Trait feature "<LayerName>'s Rules" so
                // the passive layer effect reads like a normal trait entry on the sheet.
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
                    const dmg = Array.isArray(shards.damage)
                        ? shards.damage.map(damageEntry =>
                        {
                            const aoe = (typeof damageEntry?.aoe === "string" && damageEntry.aoe.trim()) ? ` (${damageEntry.aoe})` : "";
                            return `${damageEntry?.val ?? ""} ${damageEntry?.type ?? ""}${aoe}`.trim();
                        }).filter(Boolean).join(", ")
                        : "";
                    const shardEffect = [
                        count ? `<p><strong>Spawns:</strong> ${count} shard${count === 1 ? "" : "s"}</p>` : "",
                        shards.detail ? `<p>${shards.detail}</p>` : "",
                        dmg ? `<p><strong>Shard damage:</strong> ${dmg}</p>` : ""
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
                    // Pad scalar attack_bonus / accuracy to tier-array shape v2 expects.
                    if (typeof feat.attack_bonus === "number")
                        feat.attack_bonus = [feat.attack_bonus, feat.attack_bonus, feat.attack_bonus];
                    if (typeof feat.accuracy === "number")
                        feat.accuracy = [feat.accuracy, feat.accuracy, feat.accuracy];
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
                    // v3 eidolon extras appended to effect: `attacks: N` (N>1) becomes
                    // multi-attack prose; string AoE shapes surface, bare `aoe: true` drops.
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
            console.error("[v3-lcp-shim] eidolon layer translation failed", e);
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
        const arr = contentBuckets[bucket];
        if (!arr?.length)
            continue;
        applyItemTranslators(bucket, arr, droppedItemEffects);
    }
    for (const [bucket, arr] of Object.entries(contentBuckets))
    {
        if (!arr.length)
            continue;
        outZip.file(bucketFilename[bucket], JSON.stringify(arr, null, 2));
    }

    // (Eidolon layers were already translated into templates/features above.)

    const outBlob = await outZip.generateAsync({ type: "blob" });
    const itemCounts = Object.fromEntries(
        Object.entries(contentBuckets).filter(([, arr]) => arr.length).map(([k, arr]) => [k, arr.length])
    );
    return {
        blob: outBlob,
        manifest: outManifest,
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

// Dynamically resolve the Lancer system's main bundle (hashed filename varies per release)
// and grab parseContentPack + importCP so we can import the translated LCP in-place.
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

// Kept for optional download path (unused by default; the button now imports directly).
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
            console.warn("[v3-lcp-shim] saveDataToFile failed, falling back", e);
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
            ui.notifications.info(`"${manifest.name}" is already v2 — nothing to translate.`);
            return;
        }
        const baseName = picked.name.replace(/\.lcp$/i, "");
        triggerDownload(blob, `${baseName}.v2.lcp`);
        const sumAE = (entries) => entries.reduce((acc, entry) =>
        {
            acc.total += entry.total ?? 0; acc.lifted += entry.lifted ?? 0; acc.textOnly += entry.textOnly ?? 0; return acc;
        }, { total: 0, lifted: 0, textOnly: 0 });
        const notes = [];
        const npcAE = sumAE(summary.droppedActiveEffects);
        if (npcAE.total)
            notes.push(`NPC active_effects: ${npcAE.lifted} lifted to bonuses/actions, ${npcAE.textOnly} text-only (of ${npcAE.total})`);
        const itemAE = sumAE(summary.droppedItemActiveEffects);
        if (itemAE.total)
            notes.push(`Item active_effects: ${itemAE.lifted} lifted, ${itemAE.textOnly} text-only (of ${itemAE.total})`);
        if (summary.droppedEidolonLayers.length)
            notes.push(`${summary.droppedEidolonLayers.length} eidolon layers dropped`);
        const itemBits = Object.entries(summary.items ?? {}).map(([k, v]) => `${v} ${k}`).join(", ");
        const msg = `Translated "${manifest.name}" → v2 (${summary.classes} classes, ${summary.features} features, ${summary.templates} templates`
            + (itemBits ? `; ${itemBits}` : "") + ")"
            + (notes.length ? `. ${notes.join("; ")}.` : ".");
        ui.notifications.info(msg);
        console.log("[v3-lcp-shim] translation summary", summary);
    }
    catch (e)
    {
        console.error("[v3-lcp-shim] translation failed", e);
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
        return isV3Manifest(manifest) || hasV3Layout(zip);
    }
    catch (e)
    {
        console.warn("[v3-lcp-shim] v3 detection failed", e);
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
    const droppedAe = (summary.droppedActiveEffects?.length ?? 0) + (summary.droppedItemActiveEffects?.length ?? 0);
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
    const tmplLids = summary?.eidolonTemplateLids ?? [];
    const featLids = summary?.eidolonFeatureLids ?? [];
    if (!tmplLids.length && !featLids.length)
        return;
    const worked = async (pack, lids) =>
    {
        if (!pack || !lids.length)
            return;
        const docs = pack.index.filter(entry => lids.includes(entry.system?.lid));
        if (!docs.length)
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
            const updates = docs.map(doc => ({ _id: doc._id, folder: folder.id }));
            const docCls = CONFIG[pack.metadata.type].documentClass;
            await docCls.updateDocuments(updates, { pack: pack.collection });
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
    await worked(templatePack ?? itemsPack, tmplLids);
    await worked(featurePack ?? itemsPack, featLids);
}

async function translateSelectedV3(file)
{
    try
    {
        const { blob, manifest, summary } = await getOrTranslate(file);
        if (summary.alreadyV2)
        {
            ui.notifications.info(`"${manifest.name}" is already v2 — nothing to translate.`);
            return;
        }

        // Hand the translated zip straight to the Lancer system: parseContentPack → importCP.
        // No download, no re-select, no second click.
        ui.notifications.info(`Translating "${manifest.name}" and importing...`);
        const api = await getLancerApi();
        const arrayBuf = await blob.arrayBuffer();
        const contentPack = await api.parseContentPack(arrayBuf);
        let lastPct = -1;
        const progress = (done, total) =>
        {
            if (!total)
                return;
            const pct = Math.floor((done / total) * 100);
            if (pct !== lastPct && pct % 10 === 0)
            {
                console.log(`[v3-lcp-shim] import progress ${pct}% (${done}/${total})`);
                lastPct = pct;
            }
        };
        await api.importCP(contentPack, progress);

        // Post-import: move eidolon content into a dedicated "Eidolons" subfolder in
        // each pack so GMs don't confuse layer templates / features with regular NPC content.
        await sortEidolonContentIntoFolder(summary);

        const sumAE = (entries) => entries.reduce((acc, entry) =>
        {
            acc.total += entry.total ?? 0; acc.lifted += entry.lifted ?? 0; acc.textOnly += entry.textOnly ?? 0; return acc;
        }, { total: 0, lifted: 0, textOnly: 0 });
        const notes = [];
        const npcAE = sumAE(summary.droppedActiveEffects);
        if (npcAE.total)
            notes.push(`NPC active_effects: ${npcAE.lifted} lifted, ${npcAE.textOnly} text-only`);
        const itemAE = sumAE(summary.droppedItemActiveEffects);
        if (itemAE.total)
            notes.push(`Item active_effects: ${itemAE.lifted} lifted, ${itemAE.textOnly} text-only`);
        if (summary.droppedEidolonLayers.length)
            notes.push(`${summary.droppedEidolonLayers.length} eidolon layers dropped`);
        const itemBits = Object.entries(summary.items ?? {}).map(([k, v]) => `${v} ${k}`).join(", ");
        const msg = `Imported "${manifest.name}" (${summary.classes} classes, ${summary.features} features, ${summary.templates} templates`
            + (itemBits ? `; ${itemBits}` : "") + ")"
            + (notes.length ? `. ${notes.join("; ")}.` : ".");
        ui.notifications.info(msg);
        console.log("[v3-lcp-shim] import complete", summary);

        // Refresh the Compendium Manager so the installed/current column reflects the new import.
        const manager = Object.values(ui.windows).find(win => win?.constructor?.name === "LCPManager");
        manager?.render?.(false);
    }
    catch (e)
    {
        console.error("[v3-lcp-shim] import failed", e);
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
        console.error("[v3-lcp-shim] preview translation failed", e);
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
            console.error("[v3-lcp-shim]", err);
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
    }
    console.log("[v3-lcp-shim] registered");
}

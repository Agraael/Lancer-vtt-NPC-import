// V3 → V2 LCP translator.
// Rewrites a Comp/Con v3 LCP zip into the legacy v2 shape so Lancer 2.x can import it.
// active_effects are lifted into v2 native bonuses/actions/deployables where shapes match,
// and appended to item effect text otherwise. Eidolon layers are dropped.

const MODULE_ID = "lancer-npc-import";
const JSZIP_CDN = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";

let _jszipPromise = null;
async function getJSZip() {
    if (globalThis.JSZip)
        return globalThis.JSZip;
    if (!_jszipPromise) {
        _jszipPromise = import(JSZIP_CDN).then(m => m.default || m.JSZip || m);
    }
    return _jszipPromise;
}

// ── Detection ───────────────────────────────────────────────────────────────

function isV3Manifest(manifest) {
    return manifest?.v3 === true;
}

function hasV3Layout(zip) {
    return Object.keys(zip.files).some(n =>
        /^npcc_.+\.json$/i.test(n) ||
        /^npct_.+\.json$/i.test(n) ||
        /^license_.+\.json$/i.test(n) ||
        n === "eidolon_layers.json"
    );
}

// ── Field translators ───────────────────────────────────────────────────────

function translateClassStats(cls, logDropped) {
    if (!cls.stats)
        return;
    // v3 size: scalar → v2 [[n],[n],[n]]
    if (typeof cls.stats.size === "number") {
        const s = cls.stats.size;
        cls.stats.size = [[s], [s], [s]];
    }
    // v3 cosmetic, v2 ignores but harmless to keep
}

function translateFeature(feat, parent, parentType, droppedEffects) {
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

    // damage[].val → damage[].damage
    if (Array.isArray(feat.damage)) {
        for (const d of feat.damage) {
            if (d?.val !== undefined && d.damage === undefined) {
                d.damage = d.val;
                delete d.val;
            }
        }
    }

    // active_effects: translate to v2 bonuses/actions where possible, merge remainder into effect text.
    if (Array.isArray(feat.active_effects) && feat.active_effects.length) {
        const before = feat.active_effects.length;
        const lifted = liftActiveEffects(feat);
        droppedEffects.push({ feature: feat.id, total: before, lifted, textOnly: before - lifted });
        delete feat.active_effects;
    } else if (feat.active_effects) {
        delete feat.active_effects;
    }

    // v2-expected defaults
    if (feat.locked === undefined)
        feat.locked = false;
    if (feat.effect === undefined)
        feat.effect = "";
}

function rebuildFeatureListsOnClass(cls, allFeatures) {
    if (!Array.isArray(cls.base_features))
        cls.base_features = [];
    if (!Array.isArray(cls.optional_features))
        cls.optional_features = [];
    const seenBase = new Set(cls.base_features);
    const seenOpt = new Set(cls.optional_features);
    for (const feat of allFeatures) {
        if (feat.__v3_origin_id !== cls.id)
            continue;
        if (feat.__v3_base) {
            if (!seenBase.has(feat.id)) {
                cls.base_features.push(feat.id); seenBase.add(feat.id);
            }
        } else {
            if (!seenOpt.has(feat.id)) {
                cls.optional_features.push(feat.id); seenOpt.add(feat.id);
            }
        }
    }
}

function stripSidecar(feat) {
    delete feat.__v3_origin_id;
    delete feat.__v3_base;
}

// ── Generic item translators (non-NPC) ──────────────────────────────────────

// v3 active_effect → v2 Lancer VTT translation.
// Lancer 2.x has native schemas for most of the fields v3 packs into active_effects:
// - action.damage[], action.range[], action.frequency, action.trigger, action.tech_attack
// - bonuses[] with lids "save", "attack", "armor", etc.
// - bonuses[] with added_damage[]
// Fields with no native structured home (add_status, add_resist, add_special) fall back to text.

const FREQUENCY_RE = /^\s*(\d+\s*\/\s*(turn|round|encounter|scene|mission|unlimited)|unlimited)\s*$/i;

function capitalizeDamageType(t) {
    if (!t || typeof t !== "string")
        return t;
    const norm = t.trim().toLowerCase();
    const map = { kinetic: "Kinetic", energy: "Energy", explosive: "Explosive", heat: "Heat", burn: "Burn", variable: "Variable" };
    return map[norm] ?? (t.charAt(0).toUpperCase() + t.slice(1));
}
function capitalizeRangeType(t) {
    if (!t || typeof t !== "string")
        return t;
    const norm = t.trim().toLowerCase();
    const map = { range: "Range", threat: "Threat", thrown: "Thrown", line: "Line", cone: "Cone", blast: "Blast", burst: "Burst" };
    return map[norm] ?? (t.charAt(0).toUpperCase() + t.slice(1));
}

// v2 damage.val is a string (dice expression or number). Arrays become a single joined string.
function normalizeDamageVal(v) {
    if (v === undefined || v === null)
        return "";
    if (Array.isArray(v))
        return v.map(String).join("/");
    return String(v);
}
function toV2Damage(d) {
    if (!d)
        return null;
    return { type: capitalizeDamageType(d.type), val: normalizeDamageVal(d.val ?? d.damage ?? d.amount) };
}
function toV2Range(r) {
    if (r?.val === undefined)
        return null;
    const n = typeof r.val === "number" ? r.val : Number(r.val);
    return { type: capitalizeRangeType(r.type ?? "Range"), val: Number.isFinite(n) ? n : 0 };
}

function normalizeFrequency(f) {
    if (!f || typeof f !== "string")
        return "";
    const t = f.trim();
    if (FREQUENCY_RE.test(t)) {
        return t.replace(/\s*\/\s*/, "/").replaceAll(/\b(\w)/g, c => c.toUpperCase());
    }
    return "";
}

// Fragments that stay as text (no Lancer v2 schema equivalent on items).
// Returns "" if the active_effect has no content beyond just its own name label,
// so we don't pollute `effect` with bare `**Name**` trailers.
function renderResidualText(ae, handled) {
    if (!ae)
        return "";
    const meta = [];
    if (ae.duration)
        meta.push(`Duration: ${ae.duration}`);
    if (ae.condition && !handled.trigger)
        meta.push(`When: ${ae.condition}`);
    const detail = !handled.detail && ae.detail ? ae.detail : "";
    const renderToken = t => {
        if (t === null || t === undefined)
            return "";
        if (typeof t === "string")
            return t;
        if (typeof t === "object")
            return t.name ?? t.lid ?? t.id ?? "";
        return String(t);
    };
    const renderTokens = v => (Array.isArray(v) ? v : [v]).map(renderToken).filter(Boolean).join(", ");
    const extras = [];
    if (ae.add_status) {
        const s = renderTokens(ae.add_status); if (s)
            extras.push(`Applies status: ${s}`);
    }
    if (ae.add_resist) {
        const s = renderTokens(ae.add_resist); if (s)
            extras.push(`Grants resistance: ${s}`);
    }
    if (ae.add_special) {
        const s = renderTokens(ae.add_special); if (s)
            extras.push(`Special: ${s}`);
    }
    if (ae.remove_special) {
        const s = renderTokens(ae.remove_special); if (s)
            extras.push(`Removes special: ${s}`);
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
function textNormalize(s) {
    return (s ?? "").toString().toLowerCase().replaceAll(/\*+/g, "").replaceAll(/[^\w\s]/g, " ").replaceAll(/\s+/g, " ").trim();
}
function existingContainsBody(existing, chunk) {
    if (!existing || !chunk)
        return false;
    // Skip the "**Name** — " header so we compare actual body content.
    const body = chunk.split(" — ").slice(1).join(" — ");
    if (!body)
        return true; // header-only; already filtered but guard anyway
    const e = textNormalize(existing);
    const c = textNormalize(body);
    return c.length > 12 && e.includes(c);
}

// Detect whether this active_effect describes an action (has attack/damage/range/trigger-shaped data).
function aeLooksLikeAction(ae) {
    return !!(ae && (ae.damage || ae.range || ae.attack || ae.accuracy !== undefined || ae.condition || ae.frequency));
}

function liftActiveEffects(item) {
    const aes = item?.active_effects;
    if (!Array.isArray(aes) || aes.length === 0)
        return 0;
    let lifted = 0;
    const textChunks = [];

    for (const ae of aes) {
        if (!ae)
            continue;
        const handled = {};

        // 1) Native arrays pass through unchanged (identical v2/v3 shapes).
        if (Array.isArray(ae.bonuses) && ae.bonuses.length) {
            item.bonuses = (item.bonuses ?? []).concat(ae.bonuses);
            lifted++;
        }
        if (Array.isArray(ae.actions) && ae.actions.length) {
            item.actions = (item.actions ?? []).concat(ae.actions);
            lifted++;
        }
        if (Array.isArray(ae.deployables) && ae.deployables.length) {
            item.deployables = (item.deployables ?? []).concat(ae.deployables);
            lifted++;
        }
        if (Array.isArray(ae.synergies) && ae.synergies.length) {
            item.synergies = (item.synergies ?? []).concat(ae.synergies);
            lifted++;
        }
        if (Array.isArray(ae.counters) && ae.counters.length) {
            item.counters = (item.counters ?? []).concat(ae.counters);
            lifted++;
        }

        // 2) Synthesize a v2 Action if the active_effect has action-shaped fields.
        if (aeLooksLikeAction(ae)) {
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
            if (ae.damage) {
                const ds = Array.isArray(ae.damage) ? ae.damage : [ae.damage];
                for (const d of ds) {
                    const v = toV2Damage(d); if (v)
                        action.damage.push(v);
                }
            }
            if (ae.range) {
                const rs = Array.isArray(ae.range) ? ae.range : [ae.range];
                for (const r of rs) {
                    const v = toV2Range(r); if (v)
                        action.range.push(v);
                }
            }
            item.actions = (item.actions ?? []).concat([action]);
            handled.detail = !!ae.detail;
            handled.trigger = !!ae.condition;
            lifted++;
        }

        // 3) Scalar bonus-shaped fields → item.bonuses[].
        const newBonuses = [];
        if (ae.save !== undefined && ae.save !== null && ae.save !== "") {
            newBonuses.push({ lid: "save", val: String(ae.save) });
        }
        if (typeof ae.accuracy === "number" && ae.accuracy !== 0) {
            const sign = ae.accuracy > 0 ? "+" : "";
            newBonuses.push({ lid: "attack", val: `${sign}${ae.accuracy}` });
        }
        if (ae.bonus_damage) {
            const bds = Array.isArray(ae.bonus_damage) ? ae.bonus_damage : [ae.bonus_damage];
            const added_damage = bds.map(toV2Damage).filter(Boolean);
            if (added_damage.length) {
                // added_damage attaches to a bonus. Use lid "damage" as the neutral carrier.
                newBonuses.push({ lid: "damage", val: "0", added_damage });
            }
        }
        if (newBonuses.length) {
            item.bonuses = (item.bonuses ?? []).concat(newBonuses);
            lifted++;
        }

        // 4) Residual unmapped text appended to effect.
        const text = renderResidualText(ae, handled);
        if (text)
            textChunks.push(text);
    }

    if (textChunks.length) {
        const existing = typeof item.effect === "string" ? item.effect : "";
        // Skip chunks whose body is already present in the existing effect text
        // (v3 active_effects often restate the feature's main prose).
        const novel = textChunks.filter(c => !existingContainsBody(existing, c));
        if (novel.length) {
            // `effect` is an HTMLField — raw \n collapses to whitespace. Use <br><br>.
            const block = novel.join("<br><br>");
            item.effect = existing ? `${existing}<br><br>${block}` : block;
        }
    }
    return lifted;
}

// Backward-compat alias used by on_* hook coercion.
function renderActiveEffectAsText(ae) {
    return renderResidualText(ae, {});
}

// v3 on_* hooks can be { detail, ... } objects; v2 expects string.
function coerceOnHookString(v) {
    if (v == null)
        return v;
    if (typeof v === "string")
        return v;
    if (typeof v === "object") {
        // Lift structured fields into the text.
        return renderActiveEffectAsText(v) || v.detail || "";
    }
    return String(v);
}

function translateOnHooks(obj) {
    if (!obj || typeof obj !== "object")
        return;
    for (const k of ["on_attack", "on_hit", "on_crit", "on_miss"]) {
        if (obj[k] !== undefined && typeof obj[k] !== "string") {
            obj[k] = coerceOnHookString(obj[k]);
        }
    }
}

// Lift v3 active_effects into v2 fields, strip v3-only cosmetic flags.
function stripV3Common(item, dropped) {
    if (!item || typeof item !== "object")
        return;
    if (Array.isArray(item.active_effects) && item.active_effects.length) {
        const before = item.active_effects.length;
        const lifted = liftActiveEffects(item);
        if (dropped)
            dropped.push({ item: item.id ?? "?", total: before, lifted, textOnly: before - lifted });
    }
    for (const k of ["active_effects", "flavorDescription", "brew", "deprecated"]) {
        if (item[k] !== undefined)
            delete item[k];
    }
}

// v3 active_effects/passive_effects arrays on core_system/traits → v2 HTMLField string.
function mergeEffectArrayToHtml(arr) {
    if (!Array.isArray(arr))
        return "";
    const parts = [];
    for (const ae of arr) {
        if (!ae)
            continue;
        const label = ae.name ? `<strong>${ae.name}</strong>` : "";
        const meta = [];
        if (ae.frequency)
            meta.push(ae.frequency);
        if (ae.duration)
            meta.push(ae.duration);
        const header = label + (meta.length ? ` (${meta.join(", ")})` : "");
        const body = ae.detail ?? "";
        const chunk = [header, body].filter(Boolean).join(" ");
        if (chunk)
            parts.push(`<p>${chunk}</p>`);
    }
    return parts.join("");
}

// v2 `integrated: ArrayField(LIDField())` — must be string LIDs, not inline objects.
// v3 `integrated` is already `string[]` per compcon's MechWeapon.ts, so this is defensive:
// if an inline object somehow slips in, we preserve its id. We deliberately do NOT fan out
// into buckets — that would require a second translator pass to normalize the extracted
// items, and v3 never actually ships inline integrateds.
function flattenIntegrated(item) {
    if (!Array.isArray(item?.integrated))
        return;
    item.integrated = item.integrated
        .map(e => typeof e === "string" ? e : e?.id)
        .filter(Boolean);
}

// v2 unpackAction calls .map() on damage/range — v3 may ship scalars or objects there.
// Normalize every action object to have array-shaped damage/range/synergy_locations.
function normalizeAction(a) {
    if (!a || typeof a !== "object")
        return;
    if (a.damage !== undefined && !Array.isArray(a.damage)) {
        a.damage = a.damage ? [a.damage] : [];
    }
    if (a.range !== undefined && !Array.isArray(a.range)) {
        a.range = a.range ? [a.range] : [];
    }
    if (a.synergy_locations !== undefined && !Array.isArray(a.synergy_locations)) {
        a.synergy_locations = a.synergy_locations ? [a.synergy_locations] : [];
    }
}

function normalizeActionsList(list) {
    if (!Array.isArray(list))
        return;
    for (const a of list)
        normalizeAction(a);
}

// v2 unpackBonus does `data.val.toString()` blindly (lancer-c22b4371.mjs:34215).
// v3 bonuses can omit `val`, so guarantee a stringifiable value.
function normalizeBonus(b) {
    if (!b || typeof b !== "object")
        return;
    if (b.val === undefined || b.val === null)
        b.val = "0";
    else if (typeof b.val !== "string")
        b.val = String(b.val);
    // checklist-array fields: coerce to arrays in case v3 ships scalars
    for (const k of ["damage_types", "range_types", "weapon_sizes", "weapon_types"]) {
        if (b[k] !== undefined && !Array.isArray(b[k]))
            b[k] = b[k] ? [b[k]] : [];
    }
}

function normalizeBonusesList(list) {
    if (!Array.isArray(list))
        return;
    for (const b of list)
        normalizeBonus(b);
}

// Recursively strip v3-only fields from embedded structures and normalize
// actions/bonuses so they survive Lancer's blind .map/.toString calls.
function stripNested(item, droppedAE) {
    if (!item || typeof item !== "object")
        return;
    if (Array.isArray(item.deployables)) {
        for (const d of item.deployables)
            if (d && typeof d === "object") {
                stripV3Common(d, droppedAE);
                normalizeActionsList(d.actions);
                normalizeBonusesList(d.bonuses);
            }
    }
    if (Array.isArray(item.actions)) {
        for (const a of item.actions)
            if (a && typeof a === "object")
                stripV3Common(a, droppedAE);
        normalizeActionsList(item.actions);
    }
    normalizeBonusesList(item.bonuses);
    // Core-system prefixed arrays (frames): active_actions / passive_actions / active_bonuses / passive_bonuses.
    normalizeActionsList(item.active_actions);
    normalizeActionsList(item.passive_actions);
    normalizeBonusesList(item.active_bonuses);
    normalizeBonusesList(item.passive_bonuses);
}

// Lift v3 core_system `active_effects[]` / `passive_effects[]` into the v2 core_system schema.
// v2 schema (lancer-c22b4371.mjs:34724-34754) uses prefixed keys: active_bonuses/active_actions
// /active_synergies and passive_bonuses/passive_actions/passive_synergies. Free-form text goes to
// `active_effect` / `passive_effect` HTMLFields.
function liftCoreSystemEffects(core, kind) {
    const key = `${kind}_effects`;
    const arr = core?.[key];
    if (!Array.isArray(arr) || arr.length === 0)
        return;
    const bonusKey = `${kind}_bonuses`;
    const actionKey = `${kind}_actions`;
    const synergyKey = `${kind}_synergies`;
    const effectKey = `${kind}_effect`;
    for (const ae of arr) {
        if (!ae)
            continue;
        if (Array.isArray(ae.bonuses) && ae.bonuses.length) {
            core[bonusKey] = (core[bonusKey] ?? []).concat(ae.bonuses);
        }
        if (Array.isArray(ae.actions) && ae.actions.length) {
            core[actionKey] = (core[actionKey] ?? []).concat(ae.actions);
        }
        if (Array.isArray(ae.synergies) && ae.synergies.length) {
            core[synergyKey] = (core[synergyKey] ?? []).concat(ae.synergies);
        }
    }
    const html = mergeEffectArrayToHtml(arr);
    if (html)
        core[effectKey] = (core[effectKey] || "") + html;
    delete core[key];
}

function translateFrame(frame, droppedAE) {
    stripV3Common(frame, droppedAE);
    for (const k of ["specialty", "variant", "y_pos"])
        delete frame[k];
    if (frame.image_url && !frame.img)
        frame.img = frame.image_url;
    delete frame.image_url;
    if (frame.core_system) {
        // Handle active_effects/passive_effects BEFORE stripping common fields,
        // because stripV3Common would send them to wrong keys (core_system lacks
        // top-level `bonuses`/`actions`; it uses active_*/passive_* prefixed fields).
        liftCoreSystemEffects(frame.core_system, "active");
        liftCoreSystemEffects(frame.core_system, "passive");
        for (const k of ["flavorDescription", "brew", "deprecated"])
            delete frame.core_system[k];
        flattenIntegrated(frame.core_system);
        stripNested(frame.core_system, droppedAE);
    }
    if (Array.isArray(frame.traits)) {
        for (const t of frame.traits) {
            stripV3Common(t, droppedAE);
            stripNested(t, droppedAE);
        }
    }
    flattenIntegrated(frame);
    stripNested(frame, droppedAE);
}

function translateMechWeapon(w, droppedAE) {
    stripV3Common(w, droppedAE);
    // Drop truly v2-unsupported fields only.
    delete w.mod_type_override;
    delete w.mod_size_override;
    // Alias v3 plural forms → v2 singular (unpacker reads singular at lancer-c22b4371.mjs:34670-34674).
    if (w.no_bonuses !== undefined && w.no_bonus === undefined)
        w.no_bonus = w.no_bonuses;
    if (w.no_synergies !== undefined && w.no_synergy === undefined)
        w.no_synergy = w.no_synergies;
    if (w.no_core_bonuses !== undefined && w.no_core_bonus === undefined)
        w.no_core_bonus = w.no_core_bonuses;
    // `no_attack` is a real v2 field (MechWeaponModel:34601) — keep it.
    translateOnHooks(w);
    flattenIntegrated(w);
    stripNested(w, droppedAE);
    if (Array.isArray(w.profiles)) {
        for (const p of w.profiles) {
            stripV3Common(p, droppedAE);
            translateOnHooks(p);
            flattenIntegrated(p);
            stripNested(p, droppedAE);
        }
    }
}

function translateMechSystem(s, droppedAE) {
    stripV3Common(s, droppedAE);
    flattenIntegrated(s);
    stripNested(s, droppedAE);
}

function translateWeaponMod(m, droppedAE) {
    stripV3Common(m, droppedAE);
    translateOnHooks(m);
    // v3 `allowed_types` / `allowed_sizes` are native in Lancer 2.x WeaponModModel
    // (lancer-c22b4371.mjs:35424-35425). Pass through unchanged.
}

function translatePilotGear(item, droppedAE) {
    stripV3Common(item, droppedAE);
    translateOnHooks(item);
    stripNested(item, droppedAE);
}

function translateTalent(t, droppedAE) {
    stripV3Common(t, droppedAE);
    for (const k of ["icon_url", "svg"])
        delete t[k];
    if (Array.isArray(t.ranks)) {
        for (const r of t.ranks) {
            stripV3Common(r, droppedAE);
            stripNested(r, droppedAE);
        }
    }
}

function translateReserve(r, droppedAE) {
    stripV3Common(r, droppedAE);
    stripNested(r, droppedAE);
}

function translateBond(b, droppedAE) {
    stripV3Common(b, droppedAE);
    if (Array.isArray(b.powers)) {
        for (const p of b.powers)
            stripV3Common(p, droppedAE);
    }
}

function translateNpcClass(c, droppedAE) {
    stripV3Common(c, droppedAE);
    stripNested(c, droppedAE);
}

function translateNpcTemplate(t, droppedAE) {
    stripV3Common(t, droppedAE);
    stripNested(t, droppedAE);
}

function translateNpcFeatureCommon(f, droppedAE) {
    if (!f)
        return;
    // Lancer NPC feature only has `on_hit` as HTML (NpcFeatureModel:35331).
    // v3 NpcWeapon also carries `on_attack` / `on_crit` (compcon NpcWeapon.ts:22-24).
    // Coerce each to a string, then merge on_attack/on_crit into the feature's `effect`
    // so the content survives (no native v2 home).
    if (f.on_hit !== undefined && typeof f.on_hit !== "string") {
        f.on_hit = coerceOnHookString(f.on_hit);
    }
    const extraHookChunks = [];
    for (const [k, label] of [["on_attack", "On Attack"], ["on_crit", "On Crit"]]) {
        if (f[k] === undefined)
            continue;
        const text = typeof f[k] === "string" ? f[k] : coerceOnHookString(f[k]);
        if (text)
            extraHookChunks.push(`<strong>${label}:</strong> ${text}`);
        delete f[k];
    }
    if (extraHookChunks.length) {
        const existing = typeof f.effect === "string" ? f.effect : "";
        const block = extraHookChunks.join("<br><br>");
        f.effect = existing ? `${existing}<br><br>${block}` : block;
    }
    // v3 NPC feature damage val guarded to tier array — unpacker iterates d.damage.length.
    if (Array.isArray(f.damage)) {
        for (const d of f.damage) {
            if (d?.damage !== undefined && !Array.isArray(d.damage)) {
                d.damage = [d.damage, d.damage, d.damage];
            }
        }
    }
    // Weapon-type NPC features must have damage and range as arrays — unpackNpcFeature
    // iterates them directly (npc_feature.ts:162). Some v3 utility weapons omit these.
    if (f.type === "Weapon") {
        if (!Array.isArray(f.damage))
            f.damage = [];
        if (!Array.isArray(f.range))
            f.range = [];
    }
    stripNested(f, droppedAE);
}

function translateGeneric(item, droppedAE) {
    stripV3Common(item, droppedAE);
    stripNested(item, droppedAE);
}

function applyItemTranslators(type, arr, droppedAE) {
    if (!Array.isArray(arr))
        return;
    switch (type) {
    case "frames": for (const x of arr)
        translateFrame(x, droppedAE); break;
    case "weapons": for (const x of arr)
        translateMechWeapon(x, droppedAE); break;
    case "systems": for (const x of arr)
        translateMechSystem(x, droppedAE); break;
    case "mods": for (const x of arr)
        translateWeaponMod(x, droppedAE); break;
    case "pilot_gear": for (const x of arr)
        translatePilotGear(x, droppedAE); break;
    case "talents": for (const x of arr)
        translateTalent(x, droppedAE); break;
    case "reserves": for (const x of arr)
        translateReserve(x, droppedAE); break;
    case "bonds": for (const x of arr)
        translateBond(x, droppedAE); break;
    default: for (const x of arr)
        translateGeneric(x, droppedAE);
    }
}

// Dispatch a child entry inside a license_*.json collection to the right bucket.
function classifyLicenseChild(entry) {
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

// ── Zip extraction helpers ──────────────────────────────────────────────────

async function readJsonIfExists(zip, name) {
    const f = zip.file(name);
    if (!f)
        return null;
    try {
        return JSON.parse(await f.async("string"));
    } catch (e) {
        console.warn(`[v3-lcp-shim] Failed to parse ${name}`, e); return null;
    }
}

// Find the class/template "header" entry inside a per-file collection.
// v3 convention: the header has no `origin` field (or has `role` for classes).
function pickCollectionHeader(arr, kind) {
    if (!Array.isArray(arr) || arr.length === 0)
        return null;
    if (kind === "Class")
        return arr.find(x => x?.role) ?? null;
    // Template: compcon v3 marks the header with `template: true` (ContentPackParser.ts:185).
    // Fall back to first entry with no `origin` string for older pre-release LCPs.
    return arr.find(x => x?.template === true)
        ?? arr.find(x => x && (typeof x.origin !== "string" || !x.origin))
        ?? null;
}

// ── Main translation ───────────────────────────────────────────────────────

export async function translateV3LcpBlob(inputBlob) {
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
    for (const [bucket, file] of Object.entries(bucketFilename)) {
        const arr = await readJsonIfExists(inZip, file);
        if (Array.isArray(arr))
            contentBuckets[bucket].push(...arr);
    }

    // v3 may split pilot_gear.json into pilot_armor.json + pilot_weapons.json.
    // Lancer 2.x expects a single pilot_gear.json with `type: "Armor"|"Weapon"|"Gear"` per entry
    // (split is done in importCP at lancer-c22b4371.mjs:35640 via `g.type == "Armor"` filters).
    for (const [file, typeTag] of [["pilot_armor.json", "Armor"], ["pilot_weapons.json", "Weapon"]]) {
        const arr = await readJsonIfExists(inZip, file);
        if (Array.isArray(arr)) {
            for (const entry of arr) {
                if (entry && entry.type === undefined)
                    entry.type = typeTag;
            }
            contentBuckets.pilot_gear.push(...arr);
        }
    }
    // Ensure any pre-existing pilot_gear entries without a type default to "Gear".
    for (const entry of contentBuckets.pilot_gear) {
        if (entry && entry.type === undefined)
            entry.type = "Gear";
    }

    // v3 may ship bond_powers.json separately; Lancer reads powers[] inside each bond (unpackBond:35039).
    const bondPowers = await readJsonIfExists(inZip, "bond_powers.json");
    if (Array.isArray(bondPowers) && contentBuckets.bonds.length) {
        for (const bond of contentBuckets.bonds) {
            const bondId = bond?.id;
            if (!bondId)
                continue;
            const match = bondPowers.filter(p => p?.origin === bondId || p?.bond_id === bondId);
            if (match.length)
                bond.powers = (bond.powers ?? []).concat(match);
        }
    }

    // Files the Lancer 2.x system ignores but that might still be useful downstream — pass through untouched.
    const miscPassthrough = [
        "manufacturers.json", "backgrounds.json", "environments.json",
        "factions.json", "sitreps.json"
    ];
    for (const name of miscPassthrough) {
        const f = inZip.file(name);
        if (f)
            outZip.file(name, await f.async("string"));
    }

    // v3 license collection files: fan out into frames/weapons/systems/mods.
    const licenseNames = Object.keys(inZip.files).filter(n => /^license_.+\.json$/i.test(n));
    for (const name of licenseNames) {
        const arr = await readJsonIfExists(inZip, name);
        if (!Array.isArray(arr))
            continue;
        const frame = arr.find(x => x?.mechtype);
        if (!frame) {
            console.warn(`[v3-lcp-shim] ${name}: no frame header (mechtype field)`); continue;
        }
        contentBuckets.frames.push(frame);
        const licenseMeta = {
            license: frame.name,
            license_id: frame.id,
            source: frame.source
        };
        for (const child of arr) {
            if (!child || child === frame)
                continue;
            const bucket = classifyLicenseChild(child);
            if (!bucket)
                continue;
            for (const [k, v] of Object.entries(licenseMeta)) {
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
        .filter(n => /^npc_(?!classes(?:\.json)?$|templates(?:\.json)?$).+\.json$/i.test(n));
    for (const name of featureFileNames) {
        const arr = await readJsonIfExists(inZip, name);
        if (Array.isArray(arr))
            allFeatures.push(...arr);
    }

    // Per-class v3 collection files.
    const npccNames = Object.keys(inZip.files).filter(n => /^npcc_.+\.json$/i.test(n));
    for (const name of npccNames) {
        const arr = await readJsonIfExists(inZip, name);
        if (!Array.isArray(arr))
            continue;
        const cls = pickCollectionHeader(arr, "Class");
        if (!cls) {
            console.warn(`[v3-lcp-shim] ${name}: no class header found`); continue;
        }
        translateClassStats(cls);
        const feats = arr.filter(x => x && x !== cls);
        for (const feat of feats) {
            translateFeature(feat, cls, "Class", droppedEffects);
            allFeatures.push(feat);
        }
        allClasses.push(cls);
    }

    // Per-template v3 collection files.
    const npctNames = Object.keys(inZip.files).filter(n => /^npct_.+\.json$/i.test(n));
    for (const name of npctNames) {
        const arr = await readJsonIfExists(inZip, name);
        if (!Array.isArray(arr))
            continue;
        const tmpl = pickCollectionHeader(arr, "Template");
        if (!tmpl) {
            console.warn(`[v3-lcp-shim] ${name}: no template header found`); continue;
        }
        const feats = arr.filter(x => x && x !== tmpl);
        for (const feat of feats) {
            translateFeature(feat, tmpl, "Template", droppedEffects);
            allFeatures.push(feat);
        }
        allTemplates.push(tmpl);
    }

    // Handle any v2-style features that accidentally carry v3 fields.
    for (const feat of allFeatures) {
        if (feat.__v3_origin_id !== undefined)
            continue; // already translated
        if (typeof feat.origin === "string") {
            // Feature lived in legacy npc_features.json but uses v3 origin string.
            // Resolve parent from already-collected classes/templates.
            const parent = allClasses.find(c => c.id === feat.origin) || allTemplates.find(t => t.id === feat.origin);
            const parentType = allTemplates.some(t => t.id === feat.origin) ? "Template" : "Class";
            translateFeature(feat, parent, parentType, droppedEffects);
        } else if (feat.active_effects) {
            droppedEffects.push({ feature: feat.id, count: Array.isArray(feat.active_effects) ? feat.active_effects.length : 1 });
            delete feat.active_effects;
        }
        if (Array.isArray(feat.damage)) {
            for (const d of feat.damage) {
                if (d?.val !== undefined && d.damage === undefined) {
                    d.damage = d.val;
                    delete d.val;
                }
            }
        }
    }

    // Eidolon layers: translate each layer → an NPC template, its features → NPC features.
    // v2 has no native "swappable layer" mechanic, so this dumps the content into the
    // compendium for GM use — no automation, no stat swapping. GM drops whichever layer
    // template onto their Eidolon NPC manually. Layer content is tagged so it can be
    // moved into a dedicated "Eidolons" subfolder after import.
    const eidolonTemplateLids = [];
    const eidolonFeatureLids = [];
    const eidolonZipFile = inZip.file("eidolon_layers.json");
    if (eidolonZipFile) {
        try {
            const layers = JSON.parse(await eidolonZipFile.async("string"));
            for (const layer of Array.isArray(layers) ? layers : []) {
                if (!layer?.id || !layer?.name) {
                    droppedLayers.push(layer?.id || layer?.name || "unknown");
                    continue;
                }
                eidolonTemplateLids.push(layer.id);
                // NPC template schema has ONLY `description` (HTMLField) + base_features +
                // optional_features (NpcTemplateModel at lancer-c22b4371.mjs:35261). Keep
                // the description to the appearance flavor only; rules/hints and shards
                // become their own synthesized features so they render like native content.
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
                if (layer.rules || layer.hints) {
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
                if (layer.shards) {
                    const s = layer.shards;
                    const count = s.count ?? "";
                    const dmg = Array.isArray(s.damage)
                        ? s.damage.map(d => {
                            const aoe = (typeof d?.aoe === "string" && d.aoe.trim()) ? ` (${d.aoe})` : "";
                            return `${d?.val ?? ""} ${d?.type ?? ""}${aoe}`.trim();
                        }).filter(Boolean).join(", ")
                        : "";
                    const shardEffect = [
                        count ? `<p><strong>Spawns:</strong> ${count} shard${count === 1 ? "" : "s"}</p>` : "",
                        s.detail ? `<p>${s.detail}</p>` : "",
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

                for (const feat of layerFeatures) {
                    // All eidolon layer features are always-available while the layer is
                    // attached — there's no "optional" concept in v3. Force `base: true`
                    // so they show up under the template's Base Features (not Optional).
                    feat.base = true;
                    // Pad scalar attack_bonus / accuracy to tier-array shape v2 expects.
                    if (typeof feat.attack_bonus === "number")
                        feat.attack_bonus = [feat.attack_bonus, feat.attack_bonus, feat.attack_bonus];
                    if (typeof feat.accuracy === "number")
                        feat.accuracy = [feat.accuracy, feat.accuracy, feat.accuracy];
                    // System/Trait/Reaction/Tech features ship their prose in actions[].detail
                    // rather than `effect`. Fold action prose into effect, and emit activation
                    // tags (tg_quick / tg_full / tg_free / tg_protocol / tg_reaction) so the
                    // Lancer sheet can show the activation badge like Comp/Con does.
                    // Tag LIDs from the Lancer system's registered tag set
                    // (lancer-c22b4371.mjs — tg_*_action form, not bare tg_*).
                    const activationTagMap = { Quick: "tg_quick_action", Full: "tg_full_action", Free: "tg_free_action", Protocol: "tg_protocol", Reaction: "tg_reaction" };
                    const tagsToAdd = [];
                    if (Array.isArray(feat.actions) && feat.actions.length) {
                        if (!feat.effect) {
                            const actionChunks = feat.actions.map(a => {
                                if (!a)
                                    return "";
                                const bits = [];
                                if (a.name)
                                    bits.push(`<strong>${a.name}</strong>`);
                                if (a.activation)
                                    bits.push(`<em>(${a.activation})</em>`);
                                const header = bits.join(" ");
                                return [header, a.detail].filter(Boolean).join(": ");
                            }).filter(Boolean);
                            if (actionChunks.length)
                                feat.effect = actionChunks.join("<br>");
                        }
                        for (const a of feat.actions) {
                            const tag = activationTagMap[a?.activation];
                            if (tag)
                                tagsToAdd.push({ id: tag });
                        }
                    }
                    // v3 eidolon extras → appended to effect in human-readable form.
                    // `attacks: N` (N>1) becomes Comp/Con-style multi-attack prose.
                    // `aoe: true` bare boolean is dropped (not meaningful); string AoE shapes
                    // ("burst 2", "cone 3") do get surfaced.
                    if (feat.attacks && feat.attacks > 1) {
                        const prose = `This weapon can make ${feat.attacks}/${feat.attacks}/${feat.attacks} attacks at a time. Multiple attacks may be made against the same or different targets.`;
                        feat.effect = prose + (feat.effect ? `<br>${feat.effect}` : "");
                    }
                    if (Array.isArray(feat.damage)) {
                        for (const d of feat.damage) {
                            if (d?.aoe && typeof d.aoe === "string" && d.aoe.trim()) {
                                feat.effect = (feat.effect ?? "") + (feat.effect ? "<br>" : "") + `<em>AoE:</em> ${d.aoe}`;
                            }
                            delete d?.aoe;
                        }
                    }
                    delete feat.attacks;
                    // Defensive: clean up feat.tags (drop empty/invalid entries), then append
                    // our activation tags.
                    feat.tags = (Array.isArray(feat.tags) ? feat.tags : []).filter(t => t && typeof t.id === "string" && t.id);
                    for (const t of tagsToAdd)
                        if (!feat.tags.some(x => x.id === t.id))
                            feat.tags.push(t);
                    translateFeature(feat, layerTmpl, "Template", droppedEffects);
                    allFeatures.push(feat);
                    eidolonFeatureLids.push(feat.id);
                }
            }
        } catch (e) {
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
    for (const bucket of translateOrder) {
        const arr = contentBuckets[bucket];
        if (!arr?.length)
            continue;
        applyItemTranslators(bucket, arr, droppedItemEffects);
    }
    for (const [bucket, arr] of Object.entries(contentBuckets)) {
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

// ── UI helpers ──────────────────────────────────────────────────────────────

// Dynamically resolve the Lancer system's main bundle (hashed filename varies per release)
// and grab parseContentPack + importCP so we can import the translated LCP in-place.
let _lancerApi = null;
async function getLancerApi() {
    if (_lancerApi)
        return _lancerApi;
    const entrySrc = await fetch("/systems/lancer/lancer.mjs").then(r => r.text());
    const match = entrySrc.match(/(?:from|import)\s+['"](\.\/)?(lancer-[^'"]+\.mjs)['"]/);
    if (!match)
        throw new Error("v3-lcp-shim: could not locate Lancer main bundle");
    const mod = await import(`/systems/lancer/${match[2]}`);
    // Exported in the system bundle as `parseContentPack as p` and `importCP as i`.
    if (typeof mod.p !== "function" || typeof mod.i !== "function") {
        throw new Error("v3-lcp-shim: Lancer API (parseContentPack/importCP) not found in bundle");
    }
    _lancerApi = { parseContentPack: mod.p, importCP: mod.i };
    return _lancerApi;
}

// Kept for optional download path (unused by default; the button now imports directly).
async function triggerDownload(blob, filename) {
    const save = globalThis.saveDataToFile ?? foundry.utils?.saveDataToFile;
    if (save) {
        try {
            save(blob, blob.type || "application/octet-stream", filename); return;
        } catch (e) {
            console.warn("[v3-lcp-shim] saveDataToFile failed, falling back", e);
        }
    }
    const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
}

export async function pickAndTranslateV3Lcp() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".lcp,application/zip";
    const picked = await new Promise(resolve => {
        input.onchange = () => resolve(input.files?.[0] ?? null);
        input.click();
    });
    if (!picked)
        return;
    try {
        const { blob, manifest, summary } = await translateV3LcpBlob(picked);
        if (summary.alreadyV2) {
            ui.notifications.info(`"${manifest.name}" is already v2 — nothing to translate.`);
            return;
        }
        const baseName = picked.name.replace(/\.lcp$/i, "");
        triggerDownload(blob, `${baseName}.v2.lcp`);
        const sumAE = (entries) => entries.reduce((acc, e) => {
            acc.total += e.total ?? 0; acc.lifted += e.lifted ?? 0; acc.textOnly += e.textOnly ?? 0; return acc;
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
    } catch (e) {
        console.error("[v3-lcp-shim] translation failed", e);
        ui.notifications.error(`V3 LCP translation failed: ${e.message}`);
    }
}

// ── LCP Manager integration ─────────────────────────────────────────────────
// The translate button ONLY appears when the currently selected file is a v3 LCP,
// and it replaces the native "Import LCP" button in-place so the flow feels native.

async function detectV3File(file) {
    if (!file)
        return false;
    try {
        const JSZip = await getJSZip();
        const zip = await JSZip.loadAsync(file);
        const manifest = await readJsonIfExists(zip, "lcp_manifest.json");
        return isV3Manifest(manifest) || hasV3Layout(zip);
    } catch (e) {
        console.warn("[v3-lcp-shim] v3 detection failed", e);
        return false;
    }
}

// Cache translation results keyed by File so we don't re-translate between
// preview-rendering and button-click. WeakMap cleans up automatically.
const _translationCache = new WeakMap();

async function getOrTranslate(file) {
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
function renderV3Summary(root, anchor, summary) {
    // De-dupe: there can be at most one summary element across the whole manager root,
    // and it must live under the current anchor. Remove any strays from previous renders.
    const existing = Array.from(root.querySelectorAll(".lni-v3-summary"));
    let el = existing.find(e => e.parentElement === anchor);
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
    if (!el) {
        el = document.createElement("ul");
        el.className = "lni-v3-summary";
        el.style.cssText = "list-style: none; padding: 0 8px; margin: 4px 0;";
    }
    el.dataset.lniKey = payloadKey;
    const rows = [];
    for (const [key, label] of V3_SUMMARY_ITEMS) {
        const n = summary[key] ?? 0;
        if (n > 0)
            rows.push([n, label]);
    }
    for (const [key, label] of Object.entries(V3_ITEM_LABELS)) {
        const n = summary.items?.[key] ?? 0;
        if (n > 0)
            rows.push([n, label]);
    }
    const droppedAe = (summary.droppedActiveEffects?.length ?? 0) + (summary.droppedItemActiveEffects?.length ?? 0);
    const droppedLayers = summary.droppedEidolonLayers?.length ?? 0;
    el.innerHTML = rows.map(([n, label]) =>
        `<li style="display: flex; align-items: center; gap: 8px; margin: 2px 0;">
            <span style="display: inline-block; min-width: 28px; padding: 2px 6px; background: #a91c1c; color: #fff; border-radius: 12px; text-align: center; font-weight: bold;">${n}</span>
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
async function sortEidolonContentIntoFolder(summary) {
    const tmplLids = summary?.eidolonTemplateLids ?? [];
    const featLids = summary?.eidolonFeatureLids ?? [];
    if (!tmplLids.length && !featLids.length)
        return;
    const worked = async (pack, lids) => {
        if (!pack || !lids.length)
            return;
        const docs = pack.index.filter(e => lids.includes(e.system?.lid));
        if (!docs.length)
            return;
        // Lancer's importCP locks packs on completion; unlock to modify, relock after.
        const wasLocked = pack.locked;
        if (wasLocked)
            await pack.configure({ locked: false });
        try {
            let folder = pack.folders.find(f => f.name === "Eidolons");
            if (!folder) {
                folder = await Folder.create(
                    { name: "Eidolons", type: pack.metadata.type },
                    { pack: pack.collection }
                );
            }
            const updates = docs.map(d => ({ _id: d._id, folder: folder.id }));
            const docCls = CONFIG[pack.metadata.type].documentClass;
            await docCls.updateDocuments(updates, { pack: pack.collection });
        } finally {
            if (wasLocked)
                await pack.configure({ locked: true });
        }
    };
    const templatePack = game.packs.find(p => p.metadata.type === "Item" && /npc.template/i.test(p.collection))
        ?? game.packs.get("world.npc-templates");
    const featurePack = game.packs.find(p => p.metadata.type === "Item" && /npc.feature/i.test(p.collection))
        ?? game.packs.get("world.npc-features");
    const itemsPack = game.packs.get("world.npc-items"); // fallback if templates + features live in one pack
    await worked(templatePack ?? itemsPack, tmplLids);
    await worked(featurePack ?? itemsPack, featLids);
}

async function translateSelectedV3(file) {
    try {
        const { blob, manifest, summary } = await getOrTranslate(file);
        if (summary.alreadyV2) {
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
        const progress = (done, total) => {
            if (!total)
                return;
            const pct = Math.floor((done / total) * 100);
            if (pct !== lastPct && pct % 10 === 0) {
                console.log(`[v3-lcp-shim] import progress ${pct}% (${done}/${total})`);
                lastPct = pct;
            }
        };
        await api.importCP(contentPack, progress);

        // Post-import: move eidolon content into a dedicated "Eidolons" subfolder in
        // each pack so GMs don't confuse layer templates / features with regular NPC content.
        await sortEidolonContentIntoFolder(summary);

        const sumAE = (entries) => entries.reduce((acc, e) => {
            acc.total += e.total ?? 0; acc.lifted += e.lifted ?? 0; acc.textOnly += e.textOnly ?? 0; return acc;
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
        const manager = Object.values(ui.windows).find(w => w?.constructor?.name === "LCPManager");
        manager?.render?.(false);
    } catch (e) {
        console.error("[v3-lcp-shim] import failed", e);
        ui.notifications.error(`V3 LCP import failed: ${e.message}`);
    }
}

// Update the button visibility in response to the current file selection.
// The native "Import LCP" button is only rendered when the Lancer system
// successfully parses an LCP — v3 LCPs fail that parse, so for v3 we inject
// the translate button into the details panel ourselves instead of swapping.
async function refreshButtonState(root) {
    const importBtn = root.querySelector("button.lcp-import");
    const fileInput = root.querySelector('input[type="file"]');
    if (!importBtn && !fileInput)
        return;
    const file = fileInput?.files?.[0];
    let translateBtn = root.querySelector(".lni-translate-v3-btn");

    if (!file) {
        if (importBtn)
            importBtn.style.removeProperty("display");
        translateBtn?.remove();
        return;
    }

    const isV3 = await detectV3File(file);

    if (!isV3) {
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
    try {
        result = await getOrTranslate(file);
    } catch (e) {
        console.error("[v3-lcp-shim] preview translation failed", e);
    }

    // If the Lancer system rendered its own content-summary list (happens when a v3
    // zip also contains legacy flat files the system can partially read), skip ours to
    // avoid duplication. Detect by finding a <li> under .lcp-details that actually has
    // count-shaped text content — ignore empty lists or non-count bullet items.
    const nativeItems = Array.from(root.querySelectorAll(".lcp-details ul li, .lcp-details .content-summary li"))
        .filter(li => {
            const text = (li.textContent ?? "").trim();
            return text.length > 0 && /\d/.test(text);
        });
    const nativeSummaryPresent = nativeItems.length > 0;

    // Ensure the button exists first so we can position the summary above it.
    if (!translateBtn) {
        translateBtn = document.createElement("button");
        translateBtn.type = "button";
        translateBtn.innerHTML = `<i class="cci cci-content-manager"></i> Import v3 LCP`;
    }
    const desiredClass = (importBtn?.className ? importBtn.className + " " : "") + "lni-translate-v3-btn";
    if (translateBtn.className !== desiredClass)
        translateBtn.className = desiredClass;
    if (!translateBtn.style.cssText) {
        translateBtn.style.cssText = "margin: 8px; padding: 8px 12px; width: calc(100% - 16px); font-size: 14px;";
    }
    if (translateBtn.parentElement !== anchor)
        anchor.appendChild(translateBtn);
    translateBtn.onclick = (ev) => {
        ev.preventDefault(); translateSelectedV3(file);
    };

    // Summary goes ABOVE the translate button when visible.
    if (result?.summary && !result.summary.alreadyV2 && !nativeSummaryPresent) {
        const summaryEl = renderV3Summary(root, anchor, result.summary);
        if (summaryEl.parentElement !== anchor || summaryEl.nextSibling !== translateBtn) {
            anchor.insertBefore(summaryEl, translateBtn);
        }
    } else {
        root.querySelectorAll(".lni-v3-summary").forEach(e => e.remove());
    }
}

// Watch for file-input changes AND Svelte re-renders of the right panel.
// Mutation-loop prevention uses a time-gated flag: refreshButtonState sets _muting=true
// while running, and the observer skips callbacks during that window. The flag clears
// via setTimeout so MO-queued microtasks from our mutations are drained first.
let _muting = false;

function wireLcpManager(_app, html) {
    const root = html instanceof HTMLElement ? html : html?.[0] ?? html;
    if (!root || root.dataset.lniV3Wired === "1")
        return;
    root.dataset.lniV3Wired = "1";

    let inFlight = false;
    let pending = false;
    let debounceTimer = null;
    const run = async () => {
        if (inFlight) {
            pending = true; return;
        }
        inFlight = true;
        _muting = true;
        try {
            await refreshButtonState(root);
        } catch (err) {
            console.error("[v3-lcp-shim]", err);
        } finally {
            inFlight = false;
            // Release the mute flag AFTER observer microtasks from our mutations fire.
            setTimeout(() => {
                _muting = false;
            }, 50);
            if (pending) {
                pending = false; setTimeout(schedule, 80);
            }
        }
    };
    const schedule = () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(run, 60);
    };

    const attachInputListener = () => {
        const input = root.querySelector('input[type="file"]');
        if (input && !input.dataset.lniAttached) {
            input.dataset.lniAttached = "1";
            input.addEventListener("change", schedule);
        }
    };
    attachInputListener();

    const observer = new MutationObserver(() => {
        if (_muting)
            return; // our own mutations — ignore
        attachInputListener();
        schedule();
    });
    observer.observe(root, { childList: true, subtree: true });

    schedule();
}

export function registerV3LcpShim() {
    Hooks.on("renderLCPManager", wireLcpManager);
    Hooks.on("renderApplicationV2", (app, html) => {
        if (app?.constructor?.name === "LCPManager")
            wireLcpManager(app, html);
    });
    const mod = game.modules.get(MODULE_ID);
    if (mod) {
        mod.api = mod.api || {};
        mod.api.translateV3LcpBlob = translateV3LcpBlob;
        mod.api.pickAndTranslateV3Lcp = pickAndTranslateV3Lcp;
    }
    console.log("[v3-lcp-shim] registered");
}

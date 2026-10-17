import { patchContext, syncEntities } from "./pilot-export-core.js";
import { findItemByLid } from "../npc-import-core.js";

const STAT_MAP = [
    ["activations", "activations"], ["armor", "armor"], ["hp", "hp"], ["evasion", "evasion"],
    ["edef", "edef"], ["heatcap", "heatcap"], ["speed", "speed"], ["sensor_range", "sensorRange"],
    ["save", "saveTarget"], ["hull", "hull"], ["agi", "agi"], ["sys", "sys"], ["eng", "eng"],
    ["size", "size"], ["structure", "structure"], ["stress", "stress"]
];

export function npcClassItem(actor)
{
    return actor?.items?.find(item => item.type === "npc_class") || null;
}

function _tierIndex(json, actor)
{
    return json.tier === "custom" ? 0 : Math.max(0, (Number(actor.system?.tier) || 1) - 1);
}

function _lidItems(actor, type)
{
    return actor.items
        .filter(item => item.type === type && item.system?.lid)
        .map(item => ({ id: item.system.lid, item }));
}

export async function missingNpcLids(json)
{
    const wanted = new Map();
    for (const [list, type] of [[json?.templates, "npc_template"], [json?.features, "npc_feature"]])
    {
        for (const entry of (Array.isArray(list) ? list : []))
        {
            if (typeof entry?.id === "string" && entry.id)
                wanted.set(entry.id, type);
        }
    }
    const found = new Set();
    for (const pack of game.packs)
    {
        if (pack.metadata.type !== "Item" || found.size === wanted.size)
            continue;
        const index = await pack.getIndex({ fields: ["system.lid", "type"] });
        for (const entry of index)
        {
            if (wanted.get(entry.system?.lid) === entry.type)
                found.add(entry.system.lid);
        }
    }
    return new Set([...wanted.keys()].filter(lid => !found.has(lid)));
}

function _featureOrigin(json, actor, item)
{
    const origin = item.system?.origin;
    if (String(origin?.type || "").toLowerCase() === "template")
    {
        const template = actor.items.find(entry => entry.type === "npc_template" && entry.name === origin?.name);
        return String(template?.system?.lid || "");
    }
    return String((typeof json.class === "string" ? json.class : json.class?.id) || "");
}

export function buildNpcPatch(json, actor, now, missing = new Set())
{
    const ctx = patchContext(json, now);
    const stats = json?.combat_data?.stats;
    const npcClass = npcClassItem(actor);
    const base = npcClass?.system?.base_stats?.[_tierIndex(json, actor)];
    if (stats?.max && base)
    {
        stats.current ??= {};
        for (const [foundryKey, ccKey] of STAT_MAP)
        {
            const value = base[foundryKey];
            if (typeof value !== "number" || stats.max[ccKey] === value)
                continue;
            ctx.set(stats.max, ccKey, value, `combat_data.stats.max.${ccKey}`);
            if (ccKey !== "heatcap")
                ctx.set(stats.current, ccKey, value, `combat_data.stats.current.${ccKey}`);
        }
    }
    else
        ctx.notes.push("No NPC class stats to export");
    const tier = Number(actor.system?.tier);
    if (json.tier !== "custom" && typeof json.tier === "number" && Number.isFinite(tier))
        ctx.set(json, "tier", tier, "tier");
    const keep = entry => missing.has(entry?.id);
    if (Array.isArray(json.templates))
    {
        syncEntities(ctx, json.templates, "templates", _lidItems(actor, "npc_template"), {
            keep,
            create: source => ({
                id: source.id,
                data: { id: source.id, name: source.item.name, description: String(source.item.system?.description || ""), base_features: [], optional_features: [] }
            })
        });
    }
    if (Array.isArray(json.features))
    {
        syncEntities(ctx, json.features, "features", _lidItems(actor, "npc_feature"), {
            keep,
            create: source => ({
                id: source.id,
                instanceId: crypto.randomUUID(),
                data: {
                    id: source.id,
                    name: source.item.name,
                    type: "Trait",
                    origin: _featureOrigin(json, actor, source.item),
                    effect: String(source.item.system?.effect || ""),
                    tags: [],
                    isUsed: false
                }
            })
        });
    }
    return { changed: ctx.changed > 0, count: ctx.changed, notes: ctx.notes };
}

export async function markCustomClass(actor)
{
    const npcClass = npcClassItem(actor);
    if (!npcClass || npcClass.name.includes("CUSTOM"))
        return false;
    const original = await findItemByLid(npcClass.system?.lid, "npc_class");
    const index = Math.max(0, (Number(actor.system?.tier) || 1) - 1);
    const current = npcClass.system?.base_stats?.[index] || {};
    const reference = original?.system?.base_stats?.[index] || {};
    const edited = STAT_MAP.some(([key]) => typeof current[key] === "number" && current[key] !== reference[key]);
    if (!edited)
        return false;
    await npcClass.update({ name: `${npcClass.name} CUSTOM` });
    return true;
}

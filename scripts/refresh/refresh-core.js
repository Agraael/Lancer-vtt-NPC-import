import { stripVolatile } from "../compendium-snapshot.js";

const SUPPORTED_ACTOR_TYPES = new Set(["npc", "mech", "pilot", "deployable"]);

export function isRefreshableActor(actor)
{
    return !!actor && SUPPORTED_ACTOR_TYPES.has(actor.type);
}

export async function buildLidIndex(progress = null, packs = null)
{
    const index = new Map();
    const itemPacks = packs ?? game.packs.filter(pack => pack.metadata.type === "Item");
    progress?.update(0, itemPacks.length, "Indexing item compendiums...");
    for (let i = 0; i < itemPacks.length; i++)
    {
        const pack = itemPacks[i];
        progress?.update(i, itemPacks.length, `Indexing: ${pack.metadata.label}`);
        let entries;
        try
        {
            entries = await pack.getIndex({ fields: ["system.lid", "type"] });
        }
        catch (err)
        {
            console.warn(`lancer-npc-import refresh: failed to index pack ${pack.collection}`, err);
            continue;
        }
        for (const entry of entries)
        {
            const lid = entry.system?.lid;
            if (!lid)
                continue;
            if (!index.has(lid))
                index.set(lid, []);
            index.get(lid).push({ pack, _id: entry._id, type: entry.type });
        }
    }
    progress?.update(itemPacks.length, itemPacks.length, "Indexing done");
    return index;
}

function chosenPackEntry(item, lidIndex)
{
    const lid = item.system?.lid;
    if (!lid)
        return null;
    const candidates = lidIndex.get(lid);
    if (!candidates?.length)
        return null;
    return candidates.find(candidate => candidate.type === item.type) || candidates[0];
}

function packDocKey(entry)
{
    return `${entry.pack.collection}/${entry._id}`;
}

export function collectNeededPackDocs(actors, lidIndex, lidWhitelist = null)
{
    const needed = new Map();
    for (const actor of actors)
    {
        for (const item of actor.items)
        {
            const lid = item.system?.lid;
            if (!lid)
                continue;
            if (lidWhitelist && !lidWhitelist.has(lid))
                continue;
            const chosen = chosenPackEntry(item, lidIndex);
            if (!chosen)
                continue;
            const key = packDocKey(chosen);
            if (!needed.has(key))
                needed.set(key, chosen);
        }
    }
    return needed;
}

export async function prefetchPackDocs(needed, progress = null, concurrency = 16)
{
    const cache = new Map();
    const entries = Array.from(needed.entries());
    const total = entries.length;
    if (!total)
        return cache;
    let done = 0;
    progress?.update(0, total, `Fetching ${total} item version(s)...`);

    for (let i = 0; i < entries.length; i += concurrency)
    {
        const batch = entries.slice(i, i + concurrency);
        await Promise.all(batch.map(async ([key, { pack, _id }]) =>
        {
            try
            {
                const doc = await pack.getDocument(_id);
                if (doc)
                    cache.set(key, doc);
            }
            catch (err)
            {
                console.warn(`refresh: failed to load ${key}`, err);
            }
            finally
            {
                done++;
            }
        }));
        progress?.update(done, total, `Fetching items: ${done}/${total}`);
    }
    return cache;
}

export async function classifyActorItems(actor, lidIndex, cache = null, lidWhitelist = null)
{
    const out = [];
    for (const item of actor.items)
    {
        const lid = item.system?.lid;
        if (!lid)
            continue;
        if (lidWhitelist && !lidWhitelist.has(lid))
            continue;
        const chosen = chosenPackEntry(item, lidIndex);
        if (!chosen)
        {
            out.push({ actorItem: item, status: "missing", lid });
            continue;
        }
        const key = packDocKey(chosen);
        let packDoc = cache?.get(key);
        if (!packDoc)
        {
            try
            {
                packDoc = await chosen.pack.getDocument(chosen._id);
                if (cache && packDoc)
                    cache.set(key, packDoc);
            }
            catch (err)
            {
                console.warn(`refresh: failed to load ${lid} from ${chosen.pack.collection}`, err);
            }
        }
        if (!packDoc)
        {
            out.push({ actorItem: item, status: "missing", lid });
            continue;
        }
        if (chosen.type !== item.type)
        {
            out.push({
                actorItem: item,
                packDoc,
                lid,
                status: "unlinked",
                diff: [{ path: "type", actor: item.type, pack: chosen.type }]
            });
            continue;
        }
        const diff = computeDiff(item, packDoc);
        out.push({
            actorItem: item,
            packDoc,
            lid,
            status: diff.length ? "modified" : "synced",
            diff
        });
    }
    return out;
}

function computeDiff(actorItem, packDoc)
{
    const actorData = stripVolatile(actorItem.toObject());
    const packData = stripVolatile(packDoc.toObject());
    const diffs = [];
    walkDiff("", actorData, packData, diffs);
    return diffs;
}

function walkDiff(prefix, actorVal, packVal, out)
{
    if (actorVal === packVal)
        return;
    const actorIsObj = actorVal && typeof actorVal === "object" && !Array.isArray(actorVal);
    const packIsObj = packVal && typeof packVal === "object" && !Array.isArray(packVal);
    if (actorIsObj && packIsObj)
    {
        const keys = new Set([...Object.keys(actorVal), ...Object.keys(packVal)]);
        for (const key of keys)
            walkDiff(prefix ? `${prefix}.${key}` : key, actorVal[key], packVal[key], out);
        return;
    }
    if (Array.isArray(actorVal) && Array.isArray(packVal))
    {
        const len = Math.max(actorVal.length, packVal.length);
        for (let index = 0; index < len; index++)
            walkDiff(`${prefix}[${index}]`, actorVal[index], packVal[index], out);
        return;
    }
    if (Array.isArray(actorVal) !== Array.isArray(packVal) && JSON.stringify(actorVal) !== JSON.stringify(packVal))
    {
        out.push({ path: prefix, actor: actorVal, pack: packVal });
        return;
    }
    if (actorVal !== packVal)
        out.push({ path: prefix, actor: actorVal, pack: packVal });
}

export async function applyRefresh(actor, selections)
{
    const updates = [];
    const replacements = [];
    for (const selection of selections)
    {
        if (selection.action === "update")
        {
            const data = selection.packDoc.toObject();
            data._id = selection.actorItem.id;
            updates.push(data);
        }
        else if (selection.action === "replace")
        {
            replacements.push(selection);
        }
    }

    const report = { updated: 0, replaced: [], failed: [] };

    if (updates.length)
    {
        try
        {
            await actor.updateEmbeddedDocuments("Item", updates);
            report.updated = updates.length;
        }
        catch (err)
        {
            console.error("refresh: update batch failed", err);
            report.failed.push({ kind: "update", error: err.message });
        }
    }

    // delete+create changes the embedded id; mech loadout slots may need re-link
    for (const replacement of replacements)
    {
        try
        {
            const oldId = replacement.actorItem.id;
            await actor.deleteEmbeddedDocuments("Item", [oldId]);
            const [created] = await actor.createEmbeddedDocuments("Item", [replacement.packDoc.toObject()]);
            report.replaced.push({ name: replacement.actorItem.name, oldId, newId: created.id });
        }
        catch (err)
        {
            console.error("refresh: replacement failed", err);
            report.failed.push({ kind: "replace", name: replacement.actorItem.name, error: err.message });
        }
    }

    return report;
}

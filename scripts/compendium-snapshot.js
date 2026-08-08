// Compendium snapshot utility for comparing LCP imports.
// Produces a deterministic JSON dump so you can diff v2-import vs v3-import results.

const MODULE_ID = "lancer-npc-import";

// Fields whose values change between imports but don't represent content differences.
const VOLATILE_KEYS = new Set([
    "_id", "_key", "_stats", "folder", "sort", "ownership", "permission",
    "pack", "uuid", "img"
]);

// System-level fields that are runtime state, not content.
const VOLATILE_SYSTEM_KEYS = new Set([
    "cascading", "destroyed", "loaded", "charged", "uses", "currentUses",
    "maxUses", "isUsed", "selected_profile_index"
]);

export function stripVolatile(obj)
{
    if (obj === null || obj === undefined)
        return obj;
    if (Array.isArray(obj))
        return obj.map(stripVolatile);
    if (typeof obj !== "object")
        return obj;
    const out = {};
    const keys = Object.keys(obj).sort();
    for (const key of keys)
    {
        if (VOLATILE_KEYS.has(key))
            continue;
        if (key === "flags")
            continue; // import timestamps, folder refs, etc.
        if (key === "system" && obj[key] && typeof obj[key] === "object")
        {
            const sys = {};
            for (const sk of Object.keys(obj[key]).sort())
            {
                if (VOLATILE_SYSTEM_KEYS.has(sk))
                    continue;
                sys[sk] = stripVolatile(obj[key][sk]);
            }
            out[key] = sys;
            continue;
        }
        out[key] = stripVolatile(obj[key]);
    }
    return out;
}

// Derive a stable sort key: prefer system.lid (Lancer content LID), else name.
function sortKey(doc)
{
    return doc.system?.lid || doc.name || doc._id || "";
}

async function snapshotPack(pack, prefix)
{
    const index = await pack.getIndex({ fields: ["system.lid", "name"] });
    let candidates = Array.from(index);
    if (prefix)
    {
        candidates = candidates.filter(entry => (entry.system?.lid || "").startsWith(prefix));
    }
    candidates.sort((docA, docB) => sortKey(docA).localeCompare(sortKey(docB)));
    const entries = [];
    for (const entry of candidates)
    {
        const doc = await pack.getDocument(entry._id);
        if (!doc)
            continue;
        const raw = doc.toObject();
        entries.push(stripVolatile(raw));
    }
    return entries;
}

/**
 * Snapshot all Lancer-system compendiums, filtered by an LID prefix.
 *
 * @param {object} opts
 * @param {string} opts.prefix    Only include entries whose system.lid starts with this (e.g. "nrfaw-npc").
 * @param {boolean} [opts.download=true]   Trigger a browser download of the JSON snapshot.
 * @param {boolean} [opts.logToConsole=true]   Also log the object to console.
 * @param {string}  [opts.label]  Label included in the filename (e.g. "v2" or "v3-translated").
 * @returns {Promise<object>} the snapshot object, keyed by pack collection id.
 */
export async function dumpLcpSnapshot({ prefix = "", download = true, logToConsole = true, label = "snapshot" } = {})
{
    const snapshot = {
        _meta: {
            generatedAt: new Date().toISOString(),
            world: game.world.id,
            system: `${game.system.id}@${game.system.version}`,
            prefix,
            label
        }
    };
    const lancerPacks = game.packs.filter(pack =>
    {
        const type = pack.metadata.packageType;
        const sys = pack.metadata.system || pack.metadata.name;
        return type === "system" || type === "world" || sys === "lancer";
    });
    for (const pack of lancerPacks)
    {
        if (!["Item", "Actor"].includes(pack.metadata.type))
            continue;
        const entries = await snapshotPack(pack, prefix);
        if (entries.length)
            snapshot[pack.collection] = entries;
    }
    if (logToConsole)
        console.log(`[compendium-snapshot] ${label}`, snapshot);
    const json = JSON.stringify(snapshot, null, 2);
    if (download)
    {
        const filename = `lancer-snapshot-${label}-${Date.now()}.json`;
        // Foundry's saveDataToFile handles Electron + browser uniformly, avoiding
        // the Microsoft Store popup that the native <a download> triggers in the desktop app.
        const save = globalThis.saveDataToFile ?? foundry.utils?.saveDataToFile;
        if (save)
        {
            save(json, "application/json", filename);
        }
        else
        {
            const blob = new Blob([json], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = filename;
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }
    // Also copy to clipboard for console-driven workflows where downloading is painful.
    try
    {
        await navigator.clipboard?.writeText(json);
    }
    catch (e) { /* clipboard write is best-effort */ }
    return snapshot;
}

/**
 * Diff two snapshots produced by dumpLcpSnapshot. Returns a structured report of
 * what's only in A, only in B, and differing between both (keyed by LID).
 */
export function diffSnapshots(snapshotA, snapshotB)
{
    const report = { onlyInA: {}, onlyInB: {}, changed: {} };
    const packIds = new Set([...Object.keys(snapshotA), ...Object.keys(snapshotB)].filter(key => key !== "_meta"));
    for (const packId of packIds)
    {
        const aEntries = new Map((snapshotA[packId] ?? []).map(entry => [entry.system?.lid || entry.name, entry]));
        const bEntries = new Map((snapshotB[packId] ?? []).map(entry => [entry.system?.lid || entry.name, entry]));
        for (const [key, aDoc] of aEntries)
        {
            if (!bEntries.has(key))
            {
                (report.onlyInA[packId] ??= []).push(key);
                continue;
            }
            const bDoc = bEntries.get(key);
            const aJson = JSON.stringify(aDoc);
            const bJson = JSON.stringify(bDoc);
            if (aJson !== bJson)
            {
                (report.changed[packId] ??= []).push({ key, aDoc, bDoc });
            }
        }
        for (const key of bEntries.keys())
        {
            if (!aEntries.has(key))
                (report.onlyInB[packId] ??= []).push(key);
        }
    }
    return report;
}

export function registerSnapshotApi()
{
    const mod = game.modules.get(MODULE_ID);
    if (!mod)
        return;
    mod.api = mod.api || {};
    mod.api.dumpLcpSnapshot = dumpLcpSnapshot;
    mod.api.diffSnapshots = diffSnapshots;
    console.log("[compendium-snapshot] api registered");
}

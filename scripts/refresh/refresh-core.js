import { stripVolatile } from "../compendium-snapshot.js";

const SUPPORTED_ACTOR_TYPES = new Set(["npc", "mech", "pilot", "deployable"]);

export function isRefreshableActor(actor) {
    return !!actor && SUPPORTED_ACTOR_TYPES.has(actor.type);
}

export async function buildLidIndex(progress = null, packs = null) {
    const index = new Map();
    const itemPacks = packs ?? game.packs.filter(p => p.metadata.type === "Item");
    progress?.update(0, itemPacks.length, "Indexing item compendiums...");
    for (let i = 0; i < itemPacks.length; i++) {
        const pack = itemPacks[i];
        progress?.update(i, itemPacks.length, `Indexing: ${pack.metadata.label}`);
        let entries;
        try {
            entries = await pack.getIndex({ fields: ["system.lid", "type"] });
        } catch (err) {
            console.warn(`lancer-npc-import refresh: failed to index pack ${pack.collection}`, err);
            continue;
        }
        for (const e of entries) {
            const lid = e.system?.lid;
            if (!lid) continue;
            if (!index.has(lid)) index.set(lid, []);
            index.get(lid).push({ pack, _id: e._id, type: e.type });
        }
    }
    progress?.update(itemPacks.length, itemPacks.length, "Indexing done");
    return index;
}

function chosenPackEntry(item, lidIndex) {
    const lid = item.system?.lid;
    if (!lid) return null;
    const candidates = lidIndex.get(lid);
    if (!candidates?.length) return null;
    return candidates.find(c => c.type === item.type) || candidates[0];
}

function packDocKey(entry) {
    return `${entry.pack.collection}/${entry._id}`;
}

export function collectNeededPackDocs(actors, lidIndex, lidWhitelist = null) {
    const needed = new Map();
    for (const actor of actors) {
        for (const item of actor.items) {
            const lid = item.system?.lid;
            if (!lid) continue;
            if (lidWhitelist && !lidWhitelist.has(lid)) continue;
            const chosen = chosenPackEntry(item, lidIndex);
            if (!chosen) continue;
            const key = packDocKey(chosen);
            if (!needed.has(key)) needed.set(key, chosen);
        }
    }
    return needed;
}

export async function prefetchPackDocs(needed, progress = null, concurrency = 16) {
    const cache = new Map();
    const entries = Array.from(needed.entries());
    const total = entries.length;
    if (!total) return cache;
    let done = 0;
    progress?.update(0, total, `Fetching ${total} item version(s)...`);

    for (let i = 0; i < entries.length; i += concurrency) {
        const batch = entries.slice(i, i + concurrency);
        await Promise.all(batch.map(async ([key, { pack, _id }]) => {
            try {
                const doc = await pack.getDocument(_id);
                if (doc) cache.set(key, doc);
            } catch (err) {
                console.warn(`refresh: failed to load ${key}`, err);
            } finally {
                done++;
            }
        }));
        progress?.update(done, total, `Fetching items: ${done}/${total}`);
    }
    return cache;
}

export async function classifyActorItems(actor, lidIndex, cache = null, lidWhitelist = null) {
    const out = [];
    for (const item of actor.items) {
        const lid = item.system?.lid;
        if (!lid) continue;
        if (lidWhitelist && !lidWhitelist.has(lid)) continue;
        const chosen = chosenPackEntry(item, lidIndex);
        if (!chosen) {
            out.push({ actorItem: item, status: "missing", lid });
            continue;
        }
        const key = packDocKey(chosen);
        let packDoc = cache?.get(key);
        if (!packDoc) {
            try {
                packDoc = await chosen.pack.getDocument(chosen._id);
                if (cache && packDoc) cache.set(key, packDoc);
            } catch (err) {
                console.warn(`refresh: failed to load ${lid} from ${chosen.pack.collection}`, err);
            }
        }
        if (!packDoc) {
            out.push({ actorItem: item, status: "missing", lid });
            continue;
        }
        if (chosen.type !== item.type) {
            out.push({
                actorItem: item, packDoc, lid, status: "unlinked",
                diff: [{ path: "type", actor: item.type, pack: chosen.type }]
            });
            continue;
        }
        const diff = computeDiff(item, packDoc);
        out.push({
            actorItem: item, packDoc, lid,
            status: diff.length ? "modified" : "synced",
            diff
        });
    }
    return out;
}

function computeDiff(actorItem, packDoc) {
    const a = stripVolatile(actorItem.toObject());
    const p = stripVolatile(packDoc.toObject());
    const diffs = [];
    walkDiff("", a, p, diffs);
    return diffs;
}

function walkDiff(prefix, a, b, out) {
    if (a === b) return;
    const aIsObj = a && typeof a === "object" && !Array.isArray(a);
    const bIsObj = b && typeof b === "object" && !Array.isArray(b);
    if (aIsObj && bIsObj) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) walkDiff(prefix ? `${prefix}.${k}` : k, a[k], b[k], out);
        return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
        const len = Math.max(a.length, b.length);
        for (let i = 0; i < len; i++) walkDiff(`${prefix}[${i}]`, a[i], b[i], out);
        return;
    }
    if (Array.isArray(a) !== Array.isArray(b) && JSON.stringify(a) !== JSON.stringify(b)) {
        out.push({ path: prefix, actor: a, pack: b });
        return;
    }
    if (a !== b) out.push({ path: prefix, actor: a, pack: b });
}

export async function applyRefresh(actor, selections) {
    const updates = [];
    const replacements = [];
    for (const s of selections) {
        if (s.action === "update") {
            const data = s.packDoc.toObject();
            data._id = s.actorItem.id;
            updates.push(data);
        } else if (s.action === "replace") {
            replacements.push(s);
        }
    }

    const report = { updated: 0, replaced: [], failed: [] };

    if (updates.length) {
        try {
            await actor.updateEmbeddedDocuments("Item", updates);
            report.updated = updates.length;
        } catch (err) {
            console.error("refresh: update batch failed", err);
            report.failed.push({ kind: "update", error: err.message });
        }
    }

    // delete+create changes the embedded id; mech loadout slots may need re-link
    for (const r of replacements) {
        try {
            const oldId = r.actorItem.id;
            await actor.deleteEmbeddedDocuments("Item", [oldId]);
            const [created] = await actor.createEmbeddedDocuments("Item", [r.packDoc.toObject()]);
            report.replaced.push({ name: r.actorItem.name, oldId, newId: created.id });
        } catch (err) {
            console.error("refresh: replacement failed", err);
            report.failed.push({ kind: "replace", name: r.actorItem.name, error: err.message });
        }
    }

    return report;
}

import { listCloudItems, patchCloudFile, cloudItemId } from "./compcon-push.js";
import { buildPilotPatch } from "./pilot-export-core.js";
import { buildNpcPatch, markCustomClass, missingNpcLids } from "./npc-export-core.js";
import { pilotRunScope } from "../pilot-import-core.js";
import { windowLog } from "../sync-log.js";
import { cloudSortKey } from "../utils.js";

function _findCloudItem(items, key, id)
{
    const item = items.find(candidate => cloudSortKey(candidate) === key)
        || items.find(candidate => cloudItemId(candidate) === id);
    if (!item)
        throw new Error("Not found in your Comp/Con account");
    return item;
}

async function _run(prefix, selection, syncLog, exportEntry)
{
    syncLog.start(selection.map(entry => ({ name: entry.name, meta: entry.meta })));
    let items;
    try
    {
        items = await listCloudItems(prefix);
    }
    catch (error)
    {
        console.error("lancer-npc-import | export | could not list Comp/Con saves", error);
        const message = error.message === "NOT_LOGGED_IN" ? "Sign in to Comp/Con first." : `Could not reach Comp/Con: ${error.message}`;
        selection.forEach((_entry, index) => syncLog.finish(index, "fail", message));
        syncLog.complete({ failed: selection.length });
        return selection.map(() => ({ ok: false }));
    }
    let exported = 0;
    let unchanged = 0;
    let failed = 0;
    const results = [];
    for (const [index, entry] of selection.entries())
    {
        syncLog.begin(index, "Exporting…");
        try
        {
            const outcome = await exportEntry(entry, items);
            for (const note of outcome.notes || [])
                syncLog.addLog(note, "warning");
            if (outcome.changed)
            {
                exported++;
                syncLog.finish(index, "ok", `Exported · ${outcome.count} field${outcome.count === 1 ? "" : "s"}`);
            }
            else
            {
                unchanged++;
                syncLog.finish(index, "same", "No changes");
            }
            results.push({ ok: true, json: outcome.json });
        }
        catch (error)
        {
            failed++;
            console.error(`lancer-npc-import | export failed for ${entry.name}:`, error);
            syncLog.finish(index, "fail", `Failed: ${error.message}`);
            results.push({ ok: false });
        }
    }
    syncLog.complete({ exported, unchanged, failed });
    return results;
}

export async function exportSelectedPilots(selection, syncLog = windowLog("Export log", "Foundry → Comp/Con"))
{
    const named = selection.map(entry => ({ ...entry, name: entry.actor?.name || entry.pilot?.name || "Pilot", meta: pilotRunScope(entry) }));
    return _run("savedata_pilot_", named, syncLog, async (entry, items) =>
    {
        if (!entry.actor)
            throw new Error("No Foundry pilot linked to this Comp/Con pilot");
        const item = _findCloudItem(items, entry.pilot?.key, entry.pilot?.id);
        const outcome = await patchCloudFile(item, (json, now) => buildPilotPatch(json, entry.actor, now, {
            includePilot: entry.includePilot !== false,
            mechIds: entry.allMechs ? null : entry.mechIds
        }));
        return { changed: outcome.changed, count: outcome.result?.count || 0, notes: outcome.result?.notes || [], json: outcome.json };
    });
}

export async function exportSelectedNPCs(selection, syncLog = windowLog("Export log", "Foundry → Comp/Con"))
{
    const named = selection.map(entry => ({ ...entry, name: entry.source?.name || entry.npc?.name || "NPC", meta: entry.npc?.names?.className || "" }));
    return _run("savedata_unit_", named, syncLog, async (entry, items) =>
    {
        const actor = entry.source;
        if (!actor)
            throw new Error("No Foundry actor to export from");
        const lid = actor.system?.lid || entry.npc?.json?.id;
        const item = _findCloudItem(items, entry.npc?.key, lid);
        const outcome = await patchCloudFile(item, async (json, now) => buildNpcPatch(json, actor, now, await missingNpcLids(json)));
        const notes = [...(outcome.result?.notes || [])];
        if (outcome.changed && await markCustomClass(actor))
            notes.push("Foundry class renamed to CUSTOM, like import names it");
        return { changed: outcome.changed, count: outcome.result?.count || 0, notes, json: outcome.json };
    });
}

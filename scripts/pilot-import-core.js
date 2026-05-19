// Pilot status detection + import action. Matches by system.cloud_id.

import { ImportProgressDialog } from "./npc-import-ui.js";

export function findExistingPilotByCloudId(cloudId) {
    if (!cloudId)
        return [];
    return game.actors.filter(a => a.type === "pilot" && a.system?.cloud_id === cloudId);
}

export function findExistingMechByLid(lid) {
    if (!lid)
        return [];
    return game.actors.filter(a =>
        (a.type === "mech" || (typeof a.is_mech === "function" && a.is_mech())) &&
        a.system?.lid === lid
    );
}

function _mechLinksTo(mechActor, pilotActor) {
    const link = mechActor.system?.pilot;
    if (!link) return false;
    if (typeof link === "string")
        return link === pilotActor.uuid || link === pilotActor.id;
    const v = link.value;
    if (!v) return false;
    if (typeof v === "string")
        return v === pilotActor.uuid || v === pilotActor.id;
    return v === pilotActor || v?.uuid === pilotActor.uuid || v?.id === pilotActor.id;
}

function _set(arr) { return new Set(arr.filter(Boolean)); }
function _eqSet(a, b) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

function _licenseList(json) {
    if (!Array.isArray(json.licenses)) return [];
    return json.licenses.map(l => {
        const id = typeof l === "string" ? l : (l.id || l.data?.id || "");
        const rank = typeof l === "string" ? 1 : (l.rank ?? l.level ?? 1);
        return `${id}:${rank}`;
    });
}

function _talentList(json) {
    if (!Array.isArray(json.talents)) return [];
    return json.talents.map(t => {
        const id = typeof t === "string" ? t : (t.id || t.lid || t.data?.id || "");
        const rank = typeof t === "string" ? 1 : (t.rank ?? t.curr_rank ?? 1);
        return `${id}:${rank}`;
    });
}

export function comparePilotWithActor(pilotData, actors) {
    if (!actors || actors.length === 0)
        return { status: "new", count: 0, reasons: [] };

    const actor = actors[0];
    const reasons = [];

    if ((pilotData.callsign || "") !== (actor.system?.callsign || ""))
        reasons.push(`callsign: ${actor.system?.callsign || "?"} → ${pilotData.callsign || "?"}`);

    if ((pilotData.level ?? 0) !== (actor.system?.level ?? 0))
        reasons.push(`level: ${actor.system?.level ?? "?"} → ${pilotData.level ?? "?"}`);

    const skills = Array.isArray(pilotData.mechSkills) ? pilotData.mechSkills : null;
    if (skills && skills.length >= 4) {
        const [h, a, s, e] = skills;
        if ((actor.system?.hull ?? -1) !== h
            || (actor.system?.agi ?? -1) !== a
            || (actor.system?.sys ?? -1) !== s
            || (actor.system?.eng ?? -1) !== e) {
            reasons.push(`HASE: ${actor.system?.hull}/${actor.system?.agi}/${actor.system?.sys}/${actor.system?.eng} → ${h}/${a}/${s}/${e}`);
        }
    }

    const cloudMechs = _set((pilotData.mechs || []).map(m => m.id));
    const actorMechs = _set(
        game.actors
            .filter(a => (a.type === "mech" || (typeof a.is_mech === "function" && a.is_mech())) && _mechLinksTo(a, actor))
            .map(m => m.system?.lid)
    );
    if (!_eqSet(cloudMechs, actorMechs)) {
        const added = [...cloudMechs].filter(x => !actorMechs.has(x)).length;
        const removed = [...actorMechs].filter(x => !cloudMechs.has(x)).length;
        if (added || removed)
            reasons.push(`mechs: ${actorMechs.size} → ${cloudMechs.size} (+${added}/-${removed})`);
    }

    const cloudLicenses = _set(_licenseList(pilotData));
    const actorLicenses = _set((actor.items || []).filter(i => i.type === "license").map(i => `${i.system?.lid}:${i.system?.curr_rank ?? 1}`));
    if (!_eqSet(cloudLicenses, actorLicenses))
        reasons.push(`licenses: ${actorLicenses.size} → ${cloudLicenses.size}`);

    const cloudTalents = _set(_talentList(pilotData));
    const actorTalents = _set((actor.items || []).filter(i => i.type === "talent").map(i => `${i.system?.lid}:${i.system?.curr_rank ?? 1}`));
    if (!_eqSet(cloudTalents, actorTalents))
        reasons.push(`talents: ${actorTalents.size} → ${cloudTalents.size}`);

    if (reasons.length > 0)
        return { status: "modified", count: actors.length, reasons };
    return { status: "synced", count: actors.length, reasons: [] };
}

function _cloudMechWeaponLids(mechData) {
    const idx = mechData.active_loadout_index ?? 0;
    const loadout = mechData.loadouts?.[idx];
    const lids = [];
    for (const mount of (loadout?.weapon_mounts || [])) {
        for (const slot of (mount.slots || [])) {
            const id = slot.weapon?.id || slot.weapon?.lid;
            if (id) lids.push(id);
        }
    }
    return lids;
}
function _cloudMechSystemLids(mechData) {
    const idx = mechData.active_loadout_index ?? 0;
    const loadout = mechData.loadouts?.[idx];
    return (loadout?.systems || []).map(s => s.id || s.lid).filter(Boolean);
}
function _actorMechWeaponLids(actor) {
    const lids = [];
    for (const mount of (actor.system?.loadout?.weapon_mounts || [])) {
        for (const slot of (mount.slots || [])) {
            const w = slot.weapon?.value;
            const lid = w?.system?.lid || w?.lid;
            if (lid) lids.push(lid);
        }
    }
    return lids;
}
function _actorMechSystemLids(actor) {
    return (actor.system?.loadout?.systems || [])
        .map(s => s.value?.system?.lid || s.value?.lid)
        .filter(Boolean);
}

export function compareMechWithActor(mechData, actor) {
    if (!actor)
        return { status: "new", reasons: [] };
    const reasons = [];

    if (mechData.name && mechData.name !== actor.name)
        reasons.push(`name: ${actor.name} → ${mechData.name}`);

    const expectedFrame = mechData.frame || mechData.frameData?.id || "";
    const actualFrame = actor.system?.loadout?.frame?.value?.system?.lid
        || actor.system?.loadout?.frame?.value?.lid
        || "";
    if (expectedFrame && actualFrame && expectedFrame !== actualFrame)
        reasons.push(`frame: ${actualFrame} → ${expectedFrame}`);

    const cloudW = _set(_cloudMechWeaponLids(mechData));
    const actorW = _set(_actorMechWeaponLids(actor));
    if (!_eqSet(cloudW, actorW)) {
        const added = [...cloudW].filter(x => !actorW.has(x)).length;
        const removed = [...actorW].filter(x => !cloudW.has(x)).length;
        reasons.push(`weapons: ${actorW.size} → ${cloudW.size} (+${added}/-${removed})`);
    }

    const cloudS = _set(_cloudMechSystemLids(mechData));
    const actorS = _set(_actorMechSystemLids(actor));
    if (!_eqSet(cloudS, actorS)) {
        const added = [...cloudS].filter(x => !actorS.has(x)).length;
        const removed = [...actorS].filter(x => !cloudS.has(x)).length;
        reasons.push(`systems: ${actorS.size} → ${cloudS.size} (+${added}/-${removed})`);
    }

    if (reasons.length > 0)
        return { status: "modified", reasons };
    return { status: "synced", reasons: [] };
}

async function _runPilotJsonParsed(actor, jsonText) {
    const sheet = actor.sheet;
    if (typeof sheet?._onPilotJsonParsed !== "function")
        throw new Error("LancerPilotSheet._onPilotJsonParsed not available");
    await sheet._onPilotJsonParsed(jsonText);
}

// mechIdsFilter: optional Set of mech ids to keep in pilotJson.mechs[]. If
// undefined, all mechs are kept (full pilot import).
export async function importOnePilot(pilotJson, { updateExisting = true, mechIdsFilter } = {}) {
    const cloudId = pilotJson.cloudID || pilotJson.id || "";
    const existing = updateExisting ? findExistingPilotByCloudId(cloudId) : [];
    let actor = existing[0] || null;
    let wasUpdate = !!actor;

    if (!actor) {
        actor = await Actor.create({
            type: "pilot",
            name: pilotJson.name || "New Pilot",
            system: { cloud_id: cloudId }
        });
    }

    let payload = pilotJson;
    if (mechIdsFilter && mechIdsFilter.size > 0 && Array.isArray(pilotJson.mechs)) {
        payload = { ...pilotJson, mechs: pilotJson.mechs.filter(m => mechIdsFilter.has(m.id)) };
    }
    await _runPilotJsonParsed(actor, JSON.stringify(payload));
    return { actor, updated: wasUpdate };
}

// Accepts either bare pilot wrappers ({ name, json, mechs }) for back-compat,
// or { pilot, mechIds: Set, allMechs: bool } entries from the tabbed dialog.
export async function importSelectedPilots(selection, updateExisting = true) {
    const progress = new ImportProgressDialog(selection.length);
    progress.render(true);
    progress.addLog(`Starting import of ${selection.length} pilot(s)...`, "info");

    let created = 0, updated = 0, failed = 0;
    for (const entry of selection) {
        const pilot = entry.pilot || entry;
        const allMechs = entry.allMechs !== false;
        const mechIds = entry.mechIds instanceof Set ? entry.mechIds : null;
        const name = pilot.name;
        try {
            progress.addLog(`Importing: ${name}...`, "info");
            const r = await importOnePilot(pilot.json, {
                updateExisting,
                mechIdsFilter: allMechs ? undefined : mechIds
            });
            if (r.updated) {
                updated++;
                progress.addLog(`✓ Updated: ${name}`, "success");
            } else {
                created++;
                progress.addLog(`✓ Created: ${name}`, "success");
            }
        } catch (e) {
            console.error(`pilot import failed for ${name}:`, e);
            progress.addLog(`✗ Failed: ${name} - ${e.message}`, "error");
            failed++;
        }
        progress.incrementProgress();
    }

    const parts = [];
    if (created) parts.push(`${created} created`);
    if (updated) parts.push(`${updated} updated`);
    if (failed)  parts.push(`${failed} failed`);
    progress.addLog(`Import completed: ${parts.join(", ")}`, failed ? "warning" : "success");
    if (created + updated > 0)
        ui.notifications.info(`✓ Imported ${created + updated} pilot(s)`);
    if (failed > 0)
        ui.notifications.warn(`✗ ${failed} pilot(s) failed`);
}

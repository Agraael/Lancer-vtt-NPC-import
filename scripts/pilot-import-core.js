// Pilot status detection + import action. Matches by system.cloud_id.

import { ImportProgressDialog } from "./npc-import-ui.js";

export function findExistingPilotByCloudId(cloudId)
{
    if (!cloudId)
        return [];
    return game.actors.filter(actor => actor.type === "pilot" && actor.system?.cloud_id === cloudId);
}

export function findExistingMechByLid(lid)
{
    if (!lid)
        return [];
    return game.actors.filter(actor =>
        (actor.type === "mech" || (typeof actor.is_mech === "function" && actor.is_mech())) &&
        actor.system?.lid === lid
    );
}

function _mechLinksTo(mechActor, pilotActor)
{
    const link = mechActor.system?.pilot;
    if (!link)
        return false;
    if (typeof link === "string")
        return link === pilotActor.uuid || link === pilotActor.id;
    const linkValue = link.value;
    if (!linkValue)
        return false;
    if (typeof linkValue === "string")
        return linkValue === pilotActor.uuid || linkValue === pilotActor.id;
    return linkValue === pilotActor || linkValue?.uuid === pilotActor.uuid || linkValue?.id === pilotActor.id;
}

function _set(arr) { return new Set(arr.filter(Boolean)); }
function _eqSet(setA, setB)
{
    if (setA.size !== setB.size)
        return false;
    for (const value of setA)
        if (!setB.has(value))
            return false;
    return true;
}

function _licenseList(json)
{
    if (!Array.isArray(json.licenses))
        return [];
    return json.licenses.map(license =>
    {
        const id = typeof license === "string" ? license : (license.id || license.data?.id || "");
        const rank = typeof license === "string" ? 1 : (license.rank ?? license.level ?? 1);
        return `${id}:${rank}`;
    });
}

function _talentList(json)
{
    if (!Array.isArray(json.talents))
        return [];
    return json.talents.map(talent =>
    {
        const id = typeof talent === "string" ? talent : (talent.id || talent.lid || talent.data?.id || "");
        const rank = typeof talent === "string" ? 1 : (talent.rank ?? talent.curr_rank ?? 1);
        return `${id}:${rank}`;
    });
}

function _skillList(json)
{
    if (!Array.isArray(json.skills))
        return [];
    return json.skills.map(skill =>
    {
        const id = typeof skill === "string" ? skill : (skill.id || skill.lid || skill.data?.id || "");
        const rank = typeof skill === "string" ? 1 : (skill.rank ?? skill.curr_rank ?? 1);
        return `${id}:${rank}`;
    });
}

export function comparePilotWithActor(pilotData, actors)
{
    if (!actors || actors.length === 0)
        return { status: "new", count: 0, reasons: [] };

    const actor = actors[0];
    const reasons = [];

    if ((pilotData.callsign || "") !== (actor.system?.callsign || ""))
        reasons.push(`callsign: ${actor.system?.callsign || "?"} → ${pilotData.callsign || "?"}`);

    if ((pilotData.level ?? 0) !== (actor.system?.level ?? 0))
        reasons.push(`level: ${actor.system?.level ?? "?"} → ${pilotData.level ?? "?"}`);

    const skills = Array.isArray(pilotData.mechSkills) ? pilotData.mechSkills : null;
    if (skills && skills.length >= 4)
    {
        const [hull, agi, sys, eng] = skills;
        if ((actor.system?.hull ?? -1) !== hull
            || (actor.system?.agi ?? -1) !== agi
            || (actor.system?.sys ?? -1) !== sys
            || (actor.system?.eng ?? -1) !== eng)
        {
            reasons.push(`HASE: ${actor.system?.hull}/${actor.system?.agi}/${actor.system?.sys}/${actor.system?.eng} → ${hull}/${agi}/${sys}/${eng}`);
        }
    }

    const cloudMechs = _set((pilotData.mechs || []).map(mech => mech.id));
    const actorMechs = _set(
        game.actors
            .filter(candidate => (candidate.type === "mech" || (typeof candidate.is_mech === "function" && candidate.is_mech())) && _mechLinksTo(candidate, actor))
            .map(mech => mech.system?.lid)
    );
    if (!_eqSet(cloudMechs, actorMechs))
    {
        const added = [...cloudMechs].filter(lid => !actorMechs.has(lid)).length;
        const removed = [...actorMechs].filter(lid => !cloudMechs.has(lid)).length;
        if (added || removed)
            reasons.push(`mechs: ${actorMechs.size} → ${cloudMechs.size} (+${added}/-${removed})`);
    }

    const cloudLicenses = _set(_licenseList(pilotData));
    const actorLicenses = _set((actor.items || []).filter(item => item.type === "license").map(item => `${item.system?.lid}:${item.system?.curr_rank ?? 1}`));
    if (!_eqSet(cloudLicenses, actorLicenses))
        reasons.push(`licenses: ${actorLicenses.size} → ${cloudLicenses.size}`);

    const cloudTalents = _set(_talentList(pilotData));
    const actorTalents = _set((actor.items || []).filter(item => item.type === "talent").map(item => `${item.system?.lid}:${item.system?.curr_rank ?? 1}`));
    if (!_eqSet(cloudTalents, actorTalents))
        reasons.push(`talents: ${actorTalents.size} → ${cloudTalents.size}`);

    const cloudSkills = _set(_skillList(pilotData));
    const actorSkills = _set((actor.items || []).filter(item => item.type === "skill").map(item => `${item.system?.lid}:${item.system?.curr_rank ?? 1}`));
    if (!_eqSet(cloudSkills, actorSkills))
        reasons.push(`skills: ${actorSkills.size} → ${cloudSkills.size}`);

    const cloudReserves = (pilotData.reserves || []).map(reserve => reserve.id || reserve.lid || reserve.data?.id).filter(Boolean);
    const actorReserves = (actor.items || []).filter(item => item.type === "reserve").map(item => item.system?.lid).filter(Boolean);
    if (cloudReserves.length !== actorReserves.length || !_eqSet(_set(cloudReserves), _set(actorReserves)))
        reasons.push(`reserves: ${actorReserves.length} → ${cloudReserves.length}`);

    // Roll up per-mech loadout changes so the pilot badge flags them without expanding.
    let modifiedMechs = 0;
    for (const mechData of (pilotData.mechs || []))
    {
        const mechActor = findExistingMechByLid(mechData.id).find(mech => _mechLinksTo(mech, actor));
        if (mechActor && compareMechWithActor(mechData, mechActor).status === "modified")
            modifiedMechs++;
    }
    if (modifiedMechs > 0)
        reasons.push(`${modifiedMechs} mech loadout${modifiedMechs > 1 ? "s" : ""} changed`);

    if (reasons.length > 0)
        return { status: "modified", count: actors.length, reasons };
    return { status: "synced", count: actors.length, reasons: [] };
}

function _cloudMechWeaponLids(mechData)
{
    const idx = mechData.active_loadout_index ?? 0;
    const loadout = mechData.loadouts?.[idx];
    const lids = [];
    for (const mount of (loadout?.weapon_mounts || []))
    {
        for (const slot of (mount.slots || []))
        {
            const id = slot.weapon?.id || slot.weapon?.lid;
            if (id)
                lids.push(id);
        }
    }
    return lids;
}
function _cloudMechSystemLids(mechData)
{
    const idx = mechData.active_loadout_index ?? 0;
    const loadout = mechData.loadouts?.[idx];
    return (loadout?.systems || []).map(system => system.id || system.lid).filter(Boolean);
}
function _actorMechWeaponLids(actor)
{
    const lids = [];
    for (const mount of (actor.system?.loadout?.weapon_mounts || []))
    {
        for (const slot of (mount.slots || []))
        {
            const weapon = slot.weapon?.value;
            const lid = weapon?.system?.lid || weapon?.lid;
            if (lid)
                lids.push(lid);
        }
    }
    return lids;
}
function _actorMechSystemLids(actor)
{
    return (actor.system?.loadout?.systems || [])
        .map(system => system.value?.system?.lid || system.value?.lid)
        .filter(Boolean);
}

export function compareMechWithActor(mechData, actor)
{
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
    if (!_eqSet(cloudW, actorW))
    {
        const added = [...cloudW].filter(lid => !actorW.has(lid)).length;
        const removed = [...actorW].filter(lid => !cloudW.has(lid)).length;
        reasons.push(`weapons: ${actorW.size} → ${cloudW.size} (+${added}/-${removed})`);
    }

    const cloudS = _set(_cloudMechSystemLids(mechData));
    const actorS = _set(_actorMechSystemLids(actor));
    if (!_eqSet(cloudS, actorS))
    {
        const added = [...cloudS].filter(lid => !actorS.has(lid)).length;
        const removed = [...actorS].filter(lid => !cloudS.has(lid)).length;
        reasons.push(`systems: ${actorS.size} → ${cloudS.size} (+${added}/-${removed})`);
    }

    if (reasons.length > 0)
        return { status: "modified", reasons };
    return { status: "synced", reasons: [] };
}

async function _runPilotJsonParsed(actor, jsonText)
{
    const sheet = actor.sheet;
    if (typeof sheet?._onPilotJsonParsed !== "function")
        throw new Error("LancerPilotSheet._onPilotJsonParsed not available");
    await sheet._onPilotJsonParsed(jsonText);
}

// mechIdsFilter: optional Set of mech ids to keep in pilotJson.mechs[]. If
// undefined, all mechs are kept (full pilot import).
export async function importOnePilot(pilotJson, { updateExisting = true, mechIdsFilter } = {})
{
    const cloudId = pilotJson.cloudID || pilotJson.id || "";
    const existing = updateExisting ? findExistingPilotByCloudId(cloudId) : [];
    let actor = existing[0] || null;
    let wasUpdate = !!actor;

    if (!actor)
    {
        actor = await Actor.create({
            type: "pilot",
            name: pilotJson.name || "New Pilot",
            system: { cloud_id: cloudId }
        });
    }

    let payload = pilotJson;
    if (mechIdsFilter && mechIdsFilter.size > 0 && Array.isArray(pilotJson.mechs))
    {
        payload = { ...pilotJson, mechs: pilotJson.mechs.filter(mech => mechIdsFilter.has(mech.id)) };
    }
    await _runPilotJsonParsed(actor, JSON.stringify(payload));
    return { actor, updated: wasUpdate };
}

// Accepts either bare pilot wrappers ({ name, json, mechs }) for back-compat,
// or { pilot, mechIds: Set, allMechs: bool } entries from the tabbed dialog.
export async function importSelectedPilots(selection, updateExisting = true)
{
    const progress = new ImportProgressDialog(selection.length);
    progress.render(true);
    progress.addLog(`Starting import of ${selection.length} pilot(s)...`, "info");

    let created = 0, updated = 0, failed = 0;
    for (const entry of selection)
    {
        const pilot = entry.pilot || entry;
        const allMechs = entry.allMechs !== false;
        const mechIds = entry.mechIds instanceof Set ? entry.mechIds : null;
        const name = pilot.name;
        try
        {
            progress.addLog(`Importing: ${name}...`, "info");
            const result = await importOnePilot(pilot.json, {
                updateExisting,
                mechIdsFilter: allMechs ? undefined : mechIds
            });
            if (result.updated)
            {
                updated++;
                progress.addLog(`✓ Updated: ${name}`, "success");
            }
            else
            {
                created++;
                progress.addLog(`✓ Created: ${name}`, "success");
            }
        }
        catch (e)
        {
            console.error(`pilot import failed for ${name}:`, e);
            progress.addLog(`✗ Failed: ${name} - ${e.message}`, "error");
            failed++;
        }
        progress.incrementProgress();
    }

    const parts = [];
    if (created)
        parts.push(`${created} created`);
    if (updated)
        parts.push(`${updated} updated`);
    if (failed)
        parts.push(`${failed} failed`);
    progress.addLog(`Import completed: ${parts.join(", ")}`, failed ? "warning" : "success");
    if (created + updated > 0)
        ui.notifications.info(`✓ Imported ${created + updated} pilot(s)`);
    if (failed > 0)
        ui.notifications.warn(`✗ ${failed} pilot(s) failed`);
}

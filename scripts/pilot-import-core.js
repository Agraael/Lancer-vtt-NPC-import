// Pilot compare and import. Matches by system.cloud_id.

import { windowLog } from "./sync-log.js";
import { isOrgReserve, orgFromItem, orgLabel, matchOrgs } from "./pilot-reserves-patch.js";
import { trimText, clampRank, frameLicenseId, reserveKey } from "./utils.js";

export function findExistingPilotByCloudId(cloudId)
{
    if (!cloudId)
        return [];
    return game.actors.filter(actor => actor.type === "pilot" && actor.system?.cloud_id === cloudId);
}

export function skillNameKey(name)
{
    return `name:skill:${trimText(name).toLowerCase()}`;
}

export async function collectKnownLids()
{
    const lids = new Map();
    const addSkillName = (type, name, uuid) =>
    {
        const key = skillNameKey(name);
        if (type === "skill" && name && !lids.has(key))
            lids.set(key, uuid);
    };
    const packs = game.packs.filter(pack => pack.documentName === "Item");
    const indexes = await Promise.all(packs.map(pack => pack.getIndex({ fields: ["system.lid"] })
        .then(index => ({ pack, index }))
        .catch(() => ({ pack, index: [] }))));
    for (const { pack, index } of indexes)
    {
        for (const entry of index)
        {
            const lid = entry.system?.lid;
            const uuid = entry.uuid || `Compendium.${pack.collection}.Item.${entry._id}`;
            if (lid && !lids.has(lid))
            {
                lids.set(lid, uuid);
                lids.set(`label:${lid}`, entry.name);
                lids.set(`img:${lid}`, entry.img || "");
            }
            addSkillName(entry.type, entry.name, uuid);
        }
    }
    for (const item of game.items)
    {
        const lid = item.system?.lid;
        if (lid && !lids.has(lid))
        {
            lids.set(lid, item.uuid);
            lids.set(`label:${lid}`, item.name);
            lids.set(`img:${lid}`, item.img || "");
        }
        addSkillName(item.type, item.name, item.uuid);
    }
    return lids;
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

export { _mechLinksTo as isMechLinkedTo };

const ROMAN = ["", "I", "II", "III"];

function _label(entry, fallbackName, field)
{
    let rank = "";
    if (entry.rank)
        rank = field === "Skill" ? ` +${entry.rank * 2}` : ` ${ROMAN[entry.rank]}`;
    return `${entry.name || fallbackName || entry.id}${rank}`;
}

function _reasonLine(change)
{
    return `${change.effect === "down" ? "▼ " : ""}${change.field}: ${change.world || "none"} → ${change.cloud || "none"}`;
}

function _pushNumberChange(changes, field, worldValue, cloudValue)
{
    const world = Number(worldValue ?? 0);
    const cloud = Number(cloudValue ?? 0);
    if (world !== cloud)
        changes.push({ field, world: String(world), cloud: String(cloud), effect: cloud < world ? "down" : "up" });
}

function _diffEntries(field, worldEntries, cloudEntries)
{
    const world = [...worldEntries];
    const unmatched = [];
    for (const entry of cloudEntries)
    {
        const index = world.findIndex(other => other.id === entry.id && other.rank === entry.rank);
        if (index >= 0)
            world.splice(index, 1);
        else
            unmatched.push(entry);
    }
    const changes = [];
    for (const entry of unmatched)
    {
        const index = world.findIndex(other => other.id === entry.id);
        const match = index >= 0 ? world.splice(index, 1)[0] : null;
        if (match)
            changes.push({ field, world: _label(match, undefined, field), cloud: _label(entry, match.name, field), effect: entry.rank < match.rank ? "down" : "up", worldUuid: match.uuid });
        else
            changes.push({ field, world: "", cloud: _label(entry, undefined, field), effect: "up" });
    }
    for (const entry of world)
        changes.push({ field, world: _label(entry, undefined, field), cloud: "", effect: "down", worldUuid: entry.uuid });
    return changes;
}

export function diffEntries(field, worldEntries, cloudEntries)
{
    return _diffEntries(field, worldEntries, cloudEntries);
}

function _actorEntries(actor, type, idOf, ranked)
{
    return (actor.items || [])
        .filter(item => item.type === type)
        .map(item => ({ id: idOf(item), name: item.name, rank: ranked ? clampRank(item.system?.curr_rank) : undefined, uuid: item.uuid }));
}

function _licenseList(json, names)
{
    if (!Array.isArray(json.licenses))
        return [];
    return json.licenses.map(license =>
    {
        const id = typeof license === "string" ? license : (license.id || license.data?.id || "");
        const rank = typeof license === "string" ? 1 : (license.rank ?? license.level ?? 1);
        return { id: frameLicenseId(id), name: names?.licenses?.[id] || "", rank: clampRank(rank) };
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
        return { id, name: typeof talent === "string" ? "" : (talent.data?.name || ""), rank: clampRank(rank) };
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
        if (typeof skill !== "string" && skill.custom)
            return { id: `custom:${trimText(id)}`, name: trimText(id), rank: clampRank(rank) };
        return { id, name: typeof skill === "string" ? "" : (skill.data?.name || ""), rank: clampRank(rank) };
    });
}

function _coreBonusList(json, names)
{
    if (!Array.isArray(json.core_bonuses))
        return [];
    return json.core_bonuses.map(bonus =>
    {
        const id = typeof bonus === "string" ? bonus : (bonus?.id || bonus?.data?.id || "");
        return { id, name: names?.coreBonuses?.[id] || (typeof bonus === "string" ? "" : (bonus?.name || "")) };
    }).filter(entry => entry.id);
}

function _gearList(json)
{
    const loadout = json.loadout || json.loadouts?.[json.active_index ?? json.active_loadout_index ?? 0] || {};
    return ["armor", "weapons", "gear"]
        .flatMap(key => loadout[key] || [])
        .filter(Boolean)
        .map(_cloudItem)
        .filter(entry => entry.id);
}

function _actorGear(actor)
{
    return (actor.items || [])
        .filter(item => ["pilot_armor", "pilot_weapon", "pilot_gear"].includes(item.type))
        .map(item => ({ id: item.system?.lid || "", name: item.name, uuid: item.uuid }))
        .filter(entry => entry.id);
}


function _reserveList(json)
{
    return (json.reserves || [])
        .map(reserve => ({ id: reserveKey(reserve.id || reserve.lid || reserve.data?.id || "", reserve.name || reserve.label), name: reserve.name || reserve.label || "" }))
        .filter(entry => entry.id);
}

function _actorReserves(actor)
{
    return (actor.items || [])
        .filter(item => item.type === "reserve" && !isOrgReserve(item))
        .map(item => ({ id: reserveKey(item.system?.lid || "", item.name), name: item.name, uuid: item.uuid }))
        .filter(entry => entry.id);
}

function _orgChanges(pilotData, actor)
{
    const cloud = (Array.isArray(pilotData.orgs) ? pilotData.orgs : []).filter(org => org && typeof org === "object");
    const { pairs, cloudOnly, worldOnly } = matchOrgs((actor.items || []).filter(isOrgReserve), cloud);
    const changes = [];
    for (const { item, org } of pairs)
    {
        if (orgFromItem(item, org) !== org)
            changes.push({ field: "Organization", world: orgLabel(orgFromItem(item)), cloud: orgLabel(org), effect: "change", worldUuid: item.uuid });
    }
    for (const org of cloudOnly.filter(entry => trimText(entry.name)))
        changes.push({ field: "Organization", world: "", cloud: orgLabel(org), effect: "up" });
    for (const item of worldOnly)
        changes.push({ field: "Organization", world: orgLabel(orgFromItem(item)), cloud: "", effect: "down", worldUuid: item.uuid });
    return changes;
}

function _clockLabel(name, value, max)
{
    return `${trimText(name)} ${Number(value) || 0}/${Number(max) || 0}`;
}

export function cloudBondClocks(list)
{
    return (Array.isArray(list) ? list : [])
        .filter(Boolean)
        .map(clock => ({ id: trimText(clock.id || clock.title), label: _clockLabel(clock.title, clock.progress, clock.segments) }));
}

function _worldBondClocks(list)
{
    return (Array.isArray(list) ? list : [])
        .filter(Boolean)
        .map(clock => ({ id: trimText(clock.lid || clock.name), label: _clockLabel(clock.name, clock.value, clock.max) }));
}

function _clockChanges(field, world, cloud)
{
    const pool = [...world];
    const changes = [];
    for (const entry of cloud)
    {
        const index = pool.findIndex(other => other.id === entry.id);
        const match = index >= 0 ? pool.splice(index, 1)[0] : null;
        if (!match)
            changes.push({ field, world: "", cloud: entry.label, effect: "up" });
        else if (match.label !== entry.label)
            changes.push({ field, world: match.label, cloud: entry.label, effect: "change" });
    }
    for (const entry of pool)
        changes.push({ field, world: entry.label, cloud: "", effect: "down" });
    return changes;
}

export function actorBond(actor)
{
    return actor?.items?.find?.(item => item.type === "bond") || null;
}

function _bondPowers(list)
{
    return (Array.isArray(list) ? list : [])
        .filter(power => power?.name)
        .map(power => ({ id: trimText(power.name), name: trimText(power.name) }));
}

function _bondChanges(pilotData, actor, names)
{
    const bond = actorBond(actor);
    const cloudBond = trimText(pilotData.bondId);
    if (!bond && !cloudBond)
        return [];
    const state = actor.system?.bond_state || {};
    const changes = [];
    if (trimText(bond?.system?.lid) !== cloudBond)
        changes.push({ field: "Bond", world: bond?.name || "", cloud: names?.bond || cloudBond, effect: "change", worldUuid: bond?.uuid });
    _pushNumberChange(changes, "Bond XP", state.xp?.value, pilotData.xp);
    _pushNumberChange(changes, "Bond stress", state.stress?.value, pilotData.stress);
    if (trimText(state.minor_ideal) !== trimText(pilotData.minorIdeal))
        changes.push({ field: "Minor ideal", world: trimText(state.minor_ideal), cloud: trimText(pilotData.minorIdeal), effect: "change" });
    const worldAnswers = Array.isArray(state.answers) ? state.answers : [];
    (Array.isArray(pilotData.bondAnswers) ? pilotData.bondAnswers : []).forEach((answer, index) =>
    {
        if (trimText(worldAnswers[index]) !== trimText(answer))
            changes.push({ field: `Bond answer ${index + 1}`, world: trimText(worldAnswers[index]), cloud: trimText(answer), effect: "change" });
    });
    const worldPowers = _bondPowers((bond?.system?.powers || []).filter(power => power?.unlocked));
    changes.push(
        ..._diffEntries("Bond power", worldPowers, _bondPowers(pilotData.bondPowers)),
        ..._clockChanges("Burden", _worldBondClocks(state.burdens), cloudBondClocks(pilotData.burdens)),
        ..._clockChanges("Clock", _worldBondClocks(state.clocks), cloudBondClocks(pilotData.clocks))
    );
    return changes;
}

function _mechResult(mechData, pilotActor)
{
    const candidates = findExistingMechByLid(mechData.id);
    const linkedMech = pilotActor ? candidates.find(mech => _mechLinksTo(mech, pilotActor)) : null;
    const existing = linkedMech || candidates[0] || null;
    const cmp = compareMechWithActor(mechData, existing);
    return { id: mechData.id, name: mechData.name || "", existing, linked: !!linkedMech, status: cmp.status, changes: cmp.changes };
}

export function comparePilotWithActor(pilotData, actors, names = {})
{
    const actor = actors?.[0] || null;
    const mechResults = (pilotData.mechs || []).map(mechData => _mechResult(mechData, actor));
    if (!actor)
        return { status: "new", count: 0, reasons: [], changes: [], lowers: false, mechResults };

    const changes = [];

    const worldName = trimText(actor.name);
    const cloudName = trimText(pilotData.name);
    if (worldName !== cloudName)
        changes.push({ field: "Name", world: worldName, cloud: cloudName, effect: "rename" });

    const worldCallsign = trimText(actor.system?.callsign);
    const cloudCallsign = trimText(pilotData.callsign);
    if (worldCallsign !== cloudCallsign)
        changes.push({ field: "Callsign", world: worldCallsign, cloud: cloudCallsign, effect: "rename" });

    _pushNumberChange(changes, "Level", actor.system?.level, pilotData.level);

    const skills = Array.isArray(pilotData.mechSkills) ? pilotData.mechSkills : null;
    if (skills && skills.length >= 4)
    {
        const [hull, agi, sys, eng] = skills;
        _pushNumberChange(changes, "Hull", actor.system?.hull, hull);
        _pushNumberChange(changes, "Agility", actor.system?.agi, agi);
        _pushNumberChange(changes, "Systems", actor.system?.sys, sys);
        _pushNumberChange(changes, "Engineering", actor.system?.eng, eng);
    }

    const cloudSkills = _skillList(pilotData);
    const customSkills = new Set(cloudSkills.filter(entry => entry.id.startsWith("custom:")).map(entry => entry.name));
    const coreSkillIds = new Set(cloudSkills.filter(entry => !entry.id.startsWith("custom:")).map(entry => entry.id));
    const skillId = item =>
    {
        const lid = item.system?.lid;
        if (lid && coreSkillIds.has(lid))
            return lid;
        return customSkills.has(trimText(item.name)) ? `custom:${trimText(item.name)}` : (lid || `custom:${trimText(item.name)}`);
    };

    changes.push(
        ..._diffEntries("Talent", _actorEntries(actor, "talent", item => item.system?.lid || "", true), _talentList(pilotData)),
        ..._diffEntries("License", _actorEntries(actor, "license", item => frameLicenseId(item.system?.lid), true), _licenseList(pilotData, names)),
        ..._diffEntries("Skill", _actorEntries(actor, "skill", skillId, true), cloudSkills),
        ..._diffEntries("Core bonus", _actorEntries(actor, "core_bonus", item => item.system?.lid || "", false), _coreBonusList(pilotData, names)),
        ..._diffEntries("Reserve", _actorReserves(actor), _reserveList(pilotData)),
        ..._orgChanges(pilotData, actor),
        ..._diffEntries("Gear", _actorGear(actor), _gearList(pilotData)),
        ..._bondChanges(pilotData, actor, names)
    );

    mechResults.forEach((result, mechIndex) =>
    {
        if (!result.linked)
            changes.push({ field: "Mech", world: "", cloud: result.name, effect: "up", detail: result.existing ? "relinked" : "new", mechIndex });
    });
    const rebuilt = new Set(mechResults.map(result => findExistingMechByLid(result.id)[0]).filter(Boolean));
    const linkedMechs = game.actors
        .filter(candidate => (candidate.type === "mech" || (typeof candidate.is_mech === "function" && candidate.is_mech())) && _mechLinksTo(candidate, actor));
    for (const mech of linkedMechs)
        if (!rebuilt.has(mech))
            changes.push({ field: "Mech", world: mech.name, cloud: "", effect: "change", detail: "not in Comp/Con, kept" });

    const reasons = changes.map(_reasonLine);

    // Roll up per-mech loadout changes so the pilot badge flags them without expanding.
    const modifiedMechs = mechResults.filter(result => result.status === "modified");
    for (const result of modifiedMechs)
        reasons.push(`${result.name}: loadout changed`);

    return {
        status: changes.length > 0 || modifiedMechs.length > 0 ? "modified" : "synced",
        count: actors.length,
        reasons,
        changes,
        lowers: changes.some(change => change.field === "Level" && change.effect === "down"),
        mechResults
    };
}

function _activeCloudLoadout(mechData)
{
    return mechData?.loadouts?.[mechData.active_loadout_index ?? 0];
}

function _cloudItem(item)
{
    const id = item.id || item.data?.id;
    return { id, name: item.flavorName || item.data?.name || id, type: item.data?.type || "" };
}

function _cloudWeaponSlots(mechData)
{
    const loadout = _activeCloudLoadout(mechData);
    if (!loadout)
        return [];
    const mounts = [
        loadout.integratedWeapon,
        loadout.improved_armament,
        loadout.superheavy_mounting,
        ...(loadout.integratedMounts || []).map(mount => ({ slots: [{ weapon: mount?.weapon }], extra: [] })),
        ...(loadout.mounts || [])
    ].filter(mount => mount?.slots?.some(slot => slot?.weapon));
    return mounts
        .flatMap(mount => [...mount.slots, ...(mount.extra || [])])
        .filter(slot => slot?.weapon);
}

export function cloudMechWeapons(mechData)
{
    return _cloudWeaponSlots(mechData).map(slot => _cloudItem(slot.weapon)).filter(weapon => weapon.id);
}

export function cloudMechMounts(mechData)
{
    const loadout = _activeCloudLoadout(mechData);
    if (!loadout)
        return [];
    const mounts = [
        { type: "Integrated", rawType: loadout.integratedWeapon?.mount_type, mount: loadout.integratedWeapon },
        { type: "Improved Armament", rawType: loadout.improved_armament?.mount_type, mount: loadout.improved_armament },
        { type: "Superheavy Mounting", rawType: loadout.superheavy_mounting?.mount_type, mount: loadout.superheavy_mounting },
        ...(loadout.integratedMounts || []).map(mount => ({ type: "Integrated", rawType: "Integrated", mount: { slots: [{ weapon: mount?.weapon }] } })),
        ...(loadout.mounts || []).map(mount => ({ type: mount?.mount_type || "Mount", rawType: mount?.mount_type, mount }))
    ];
    return mounts
        .filter(({ mount }) => mount?.slots?.some(slot => slot?.weapon))
        .map(({ type, rawType, mount }) => ({
            type,
            rawType: rawType || type,
            slots: [...mount.slots, ...(mount.extra || [])]
                .filter(slot => slot?.weapon)
                .map(slot => ({ weapon: _cloudItem(slot.weapon), mod: slot.weapon.mod ? _cloudItem(slot.weapon.mod) : null }))
                .filter(slot => slot.weapon.id)
        }))
        .filter(mount => mount.slots.length);
}

export function cloudMechLoadoutWeapons(mechData)
{
    return _cloudWeaponSlots(mechData)
        .map(slot => ({ weapon: _cloudItem(slot.weapon), mod: slot.weapon.mod ? _cloudItem(slot.weapon.mod) : null }))
        .filter(entry => entry.weapon.id);
}

function _cloudMechMods(mechData)
{
    return cloudMechLoadoutWeapons(mechData)
        .filter(entry => entry.mod?.id)
        .map(entry => ({ id: `${entry.mod.id}@${entry.weapon.id}`, name: `${entry.mod.name} (on ${entry.weapon.name})` }));
}

export function cloudMechSystems(mechData)
{
    const loadout = _activeCloudLoadout(mechData);
    return [...(loadout?.integratedSystems || []), ...(loadout?.systems || [])]
        .filter(Boolean)
        .map(_cloudItem)
        .filter(system => system.id);
}

function _actorMechWeapons(actor)
{
    const weapons = [];
    for (const mount of (actor.system?.loadout?.weapon_mounts || []))
    {
        for (const slot of (mount.slots || []))
        {
            const weapon = slot.weapon?.value;
            const lid = weapon?.system?.lid || weapon?.lid;
            if (lid)
                weapons.push({ id: lid, name: weapon.name || lid, uuid: weapon.uuid });
        }
    }
    return weapons;
}
function _actorMechMods(actor)
{
    const mods = [];
    for (const mount of (actor.system?.loadout?.weapon_mounts || []))
    {
        for (const slot of (mount.slots || []))
        {
            const mod = slot.mod?.value;
            const lid = mod?.system?.lid || mod?.lid;
            if (!lid)
                continue;
            const weapon = slot.weapon?.value;
            const weaponLid = weapon?.system?.lid || weapon?.lid || "";
            mods.push({ id: `${lid}@${weaponLid}`, name: `${mod.name || lid} (on ${weapon?.name || weaponLid || "no weapon"})`, uuid: mod.uuid });
        }
    }
    return mods;
}
function _actorMechSystems(actor)
{
    return (actor.system?.loadout?.systems || [])
        .map(system => ({ id: system.value?.system?.lid || system.value?.lid, name: system.value?.name, uuid: system.value?.uuid }))
        .filter(system => system.id);
}

export function compareMechWithActor(mechData, actor)
{
    if (!actor)
        return { status: "new", reasons: [], changes: [] };
    const changes = [];

    const cloudName = trimText(mechData.name);
    if (cloudName && cloudName !== trimText(actor.name))
        changes.push({ field: "Name", world: trimText(actor.name), cloud: cloudName, effect: "rename" });

    const expectedFrame = mechData.frame || mechData.frameData?.id || "";
    const frameItem = actor.system?.loadout?.frame?.value;
    const actualFrame = frameItem?.system?.lid
        || frameItem?.lid
        || "";
    if (expectedFrame && actualFrame && expectedFrame !== actualFrame)
        changes.push({ field: "Frame", world: frameItem.name || actualFrame, cloud: mechData.frameData?.name || expectedFrame, effect: "change" });

    const loadoutChanges = [
        ..._diffEntries("Weapon", _actorMechWeapons(actor), cloudMechWeapons(mechData)),
        ..._diffEntries("System", _actorMechSystems(actor), cloudMechSystems(mechData)),
        ..._diffEntries("Mod", _actorMechMods(actor), _cloudMechMods(mechData))
    ];
    for (const change of loadoutChanges)
        changes.push({ ...change, effect: "change" });

    if (changes.length > 0)
        return { status: "modified", reasons: changes.map(_reasonLine), changes };
    return { status: "synced", reasons: [], changes: [] };
}

async function _runPilotJsonParsed(actor, jsonText)
{
    const sheet = actor.sheet;
    if (typeof sheet?._onPilotJsonParsed !== "function")
        throw new Error("LancerPilotSheet._onPilotJsonParsed not available");
    await sheet._onPilotJsonParsed(jsonText);
}

function _isMech(actor)
{
    return actor.type === "mech" || (typeof actor.is_mech === "function" && actor.is_mech());
}

async function _setPilotLink(mechs, pilotUuid)
{
    for (const mech of mechs)
        await mech.update({ "system.pilot": pilotUuid });
}

async function _importMechsOnly(pilotActor, payload)
{
    const temp = await Actor.create({
        type: "pilot",
        name: `${pilotActor.name} (import)`,
        folder: pilotActor.folder?.id ?? null,
        ownership: foundry.utils.deepClone(pilotActor.ownership)
    });
    const targets = payload.mechs.map(mech => findExistingMechByLid(mech.id)[0]).filter(Boolean);
    try
    {
        await _setPilotLink(targets, temp.uuid);
        await _runPilotJsonParsed(temp, JSON.stringify(payload));
    }
    finally
    {
        await _setPilotLink(game.actors.filter(actor => _isMech(actor) && _mechLinksTo(actor, temp)), pilotActor.uuid);
        await temp.delete();
    }
}

// mechIdsFilter: optional Set of mech ids to keep in pilotJson.mechs[]. If
// undefined, all mechs are kept (full pilot import).
export async function importOnePilot(pilotJson, { updateExisting = true, mechIdsFilter, includePilot = true } = {})
{
    const cloudId = pilotJson.cloudID || pilotJson.id || "";
    const existing = updateExisting ? findExistingPilotByCloudId(cloudId) : [];
    let actor = existing[0] || null;
    let wasUpdate = !!actor;

    let payload = pilotJson;
    if (mechIdsFilter instanceof Set && Array.isArray(pilotJson.mechs))
    {
        payload = { ...pilotJson, mechs: pilotJson.mechs.filter(mech => mechIdsFilter.has(mech.id)) };
    }

    if (!includePilot)
    {
        if (!actor)
            throw new Error("the pilot is not in Foundry, import it with its mechs");
        await _importMechsOnly(actor, payload);
        return { actor, updated: true };
    }

    if (!actor)
    {
        actor = await Actor.create({
            type: "pilot",
            name: pilotJson.name || "New Pilot",
            system: { cloud_id: cloudId }
        });
    }

    const payloadLids = new Set((payload.mechs || []).map(mech => mech.id));
    const kept = wasUpdate
        ? game.actors.filter(candidate => _isMech(candidate) && _mechLinksTo(candidate, actor) && !payloadLids.has(candidate.system?.lid))
        : [];
    await _setPilotLink(kept, null);
    try
    {
        await _runPilotJsonParsed(actor, JSON.stringify(payload));
    }
    finally
    {
        await _setPilotLink(kept, actor.uuid);
    }
    return { actor, updated: wasUpdate };
}

// Accepts either bare pilot wrappers ({ name, json }) from JSON files,
// or { pilot, mechIds: Set, allMechs: bool, includePilot: bool } entries from the tabbed dialog.
export async function importSelectedPilots(selection, updateExisting = true, syncLog = windowLog("Import log", "Comp/Con → Foundry"))
{
    syncLog.start(selection.map(entry => ({ name: (entry.pilot || entry).name, meta: pilotRunScope(entry) })));
    let created = 0, updated = 0, failed = 0;
    const results = [];
    for (const [index, entry] of selection.entries())
    {
        const pilot = entry.pilot || entry;
        const allMechs = entry.allMechs !== false;
        const mechIds = entry.mechIds instanceof Set ? entry.mechIds : null;
        const includePilot = entry.includePilot !== false;
        syncLog.begin(index, "Importing…");
        try
        {
            const result = await importOnePilot(pilot.json, {
                updateExisting,
                mechIdsFilter: allMechs ? undefined : mechIds,
                includePilot
            });
            if (result.updated)
                updated++;
            else
                created++;
            syncLog.finish(index, "ok", result.updated ? "Updated" : "Created");
            results.push({ ok: true });
        }
        catch (e)
        {
            console.error(`lancer-npc-import | pilot import failed for ${pilot.name}:`, e);
            syncLog.finish(index, "fail", `Failed: ${e.message}`);
            failed++;
            results.push({ ok: false });
        }
    }

    syncLog.complete({ updated, created, failed });
    return results;
}

export function pilotRunScope(entry)
{
    const mechs = (entry.pilot || entry).mechs || [];
    const picked = entry.mechIds instanceof Set ? mechs.filter(mech => entry.mechIds.has(mech.id)) : mechs;
    const names = picked.map(mech => mech.name || "Mech").join(", ");
    if (entry.includePilot === false)
        return `Mechs only · ${names}`;
    if (!picked.length)
        return mechs.length ? "Pilot only" : "";
    if (picked.length === mechs.length && mechs.length > 1)
        return `Pilot + all ${mechs.length} mechs`;
    return `Pilot + ${names}`;
}

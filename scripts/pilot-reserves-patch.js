// Pilot import patch: extends Lancer's _onPilotJsonParsed to also import
// reserves/organizations and refill pool resources.

import { unwrapData, normalizePilotData } from "./v3-api.js";

export function patchPilotImportReserves()
{
    const PilotSheet = game.lancer?.applications?.LancerPilotSheet;
    if (!PilotSheet?.prototype?._onPilotJsonParsed)
    {
        console.warn('lancer-npc-import | Could not patch pilot import: LancerPilotSheet._onPilotJsonParsed not found');
        return;
    }
    const orig = PilotSheet.prototype._onPilotJsonParsed;
    PilotSheet.prototype._onPilotJsonParsed = async function (fileData)
    {
        let pilotData = null;
        let normalizedFileData = fileData;
        if (fileData)
        {
            try
            {
                pilotData = JSON.parse(fileData);
                pilotData = unwrapData(pilotData);
                normalizePilotData(pilotData);
                _preserveMechCurrentStats(pilotData);
                normalizedFileData = JSON.stringify(pilotData);
            }
            catch
            {
                // not JSON, let the original importer handle it
            }
        }
        await orig.call(this, normalizedFileData);
        if (pilotData?.reserves?.length > 0)
            await _importReserves(this.actor, pilotData.reserves);
        if (pilotData?.orgs?.length > 0)
            await _importOrganizations(this.actor, pilotData.orgs);
        await _backfillBondState(this.actor, pilotData);
        await _backfillSkillDetail(this.actor, pilotData);
        await _refillResources(this.actor);
    };
    console.log('lancer-npc-import | Patched pilot import to include reserves & organizations');
}

const _MECH_STAT_MAP = [
    ["hp", "hp.value"],
    ["overshield", "overshield.value"],
    ["burn", "burn"],
    ["heat", "heat.value"],
    ["stress", "stress.value"],
    ["structure", "structure.value"],
    ["overcharge", "overcharge.value"],
    ["repairCapacity", "repairs.value"],
    ["activations", "activations.value"],
];

// CompCon exports mech stats.current.hp as 0; the importer writes it, and hp<=0 auto-fires Lancer's
// structure-damage flow, wrecking a live mech. Carry each existing mech's real current stats instead.
function _preserveMechCurrentStats(pilotData)
{
    if (!Array.isArray(pilotData?.mechs))
        return;
    for (const mechData of pilotData.mechs)
    {
        const current = mechData?.stats?.current;
        if (!current)
            continue;
        const existing = game.actors?.find(actor =>
            typeof actor.is_mech === "function" && actor.is_mech() && actor.system?.lid === mechData.id);
        if (!existing)
            continue;
        for (const [key, path] of _MECH_STAT_MAP)
        {
            const value = foundry.utils.getProperty(existing.system, path);
            if (typeof value === "number" && Number.isFinite(value))
                current[key] = value;
        }
    }
}

export async function _backfillSkillDetail(pilot, pilotData)
{
    if (!pilot || !Array.isArray(pilotData?.skills))
        return;
    const skillItems = pilot.items.filter(item => item.type === 'skill');
    if (!skillItems.length)
        return;
    for (const skill of pilotData.skills)
    {
        const isCustom = !!skill.custom;
        const lid = skill.id;
        const wantName = isCustom ? lid : (skill.data?.name ?? lid);
        const detail = isCustom ? (skill.custom_detail || '') : (skill.data?.detail || '');
        const description = isCustom ? (skill.custom_desc || '') : (skill.data?.description || '');
        const match = skillItems.find(item => (lid && item.system?.lid === lid) || item.name === wantName);
        if (!match)
            continue;
        const updates = {};
        if (detail && detail !== (match.system?.detail ?? ''))
            updates['system.detail'] = detail;
        if (description && !(match.system?.description ?? '').trim())
            updates['system.description'] = description;
        if (Object.keys(updates).length)
            await match.update(updates);
    }
}

export async function _importReserves(pilot, reserves)
{
    if (!pilot || !reserves?.length)
        return;
    const existingLids = new Set(
        pilot.items.filter(item => item.type === 'reserve').map(item => item.system?.lid)
    );
    const toCreate = [];
    for (const reserve of reserves)
    {
        const lid = reserve.id;
        if (!lid || existingLids.has(lid))
            continue;
        let found = null;
        for (const pack of game.packs)
        {
            if (pack.documentName !== 'Item')
                continue;
            const index = await pack.getIndex({ fields: ['system.lid'] });
            const entry = index.find(indexEntry => indexEntry.system?.lid === lid);
            if (entry)
            {
                found = await pack.getDocument(entry._id);
                break;
            }
        }
        if (found)
        {
            const itemData = found.toObject();
            if (reserve.name)
                itemData.name = reserve.name;
            if (reserve.used !== undefined)
                itemData.system.used = reserve.used;
            toCreate.push(itemData);
        }
        else
        {
            const descParts = [];
            if (reserve.description)
                descParts.push(reserve.description);
            if (reserve.resource_name)
                descParts.push(`<b>Resource:</b> ${reserve.resource_name}`);
            if (reserve.resource_note)
                descParts.push(`<b>Note:</b> ${reserve.resource_note}`);
            if (reserve.resource_cost)
                descParts.push(`<b>Cost:</b> ${reserve.resource_cost}`);
            const typeMap = { 'Resource': 'Resources', 'Tactical': 'Tactical', 'Mech': 'Mech', 'Project': 'Project', 'Organization': 'Organization', 'Bonus': 'Bonus' };
            const reserveType = typeMap[reserve.type] || reserve.type || 'Resources';
            toCreate.push({
                name: reserve.name || reserve.label || 'Reserve',
                type: 'reserve',
                img: 'systems/lancer/assets/icons/reserve.svg',
                system: {
                    lid: lid,
                    type: reserveType,
                    label: reserve.label || reserve.name || '',
                    description: descParts.join('<br>') || '',
                    consumable: reserve.consumable ?? false,
                    used: reserve.used ?? false,
                },
            });
        }
    }
    if (toCreate.length > 0)
    {
        await pilot.createEmbeddedDocuments('Item', toCreate);
        console.log(`lancer-npc-import | Imported ${toCreate.length} reserve(s) for ${pilot.name}`);
    }
}

export async function _importOrganizations(pilot, orgs)
{
    if (!pilot || !orgs?.length)
        return;
    const existingNames = new Set(
        pilot.items.filter(item => item.type === 'reserve').map(item => item.name)
    );
    const toCreate = [];
    for (const org of orgs)
    {
        if (!org.name || existingNames.has(org.name))
            continue;
        const descParts = [];
        if (org.purpose)
            descParts.push(`<b>Purpose:</b> ${org.purpose}`);
        if (org.efficiency !== undefined)
            descParts.push(`<b>Efficiency:</b> ${org.efficiency}`);
        if (org.influence !== undefined)
            descParts.push(`<b>Influence:</b> ${org.influence}`);
        if (org.description)
            descParts.push(org.description);
        if (org.actions)
            descParts.push(`<b>Actions:</b> ${org.actions}`);
        toCreate.push({
            name: org.name,
            type: 'reserve',
            img: 'systems/lancer/assets/icons/reserve.svg',
            system: {
                type: 'Organization',
                label: org.purpose || 'Organization',
                description: descParts.join('<br>'),
                consumable: false,
                used: false,
            },
        });
    }
    if (toCreate.length > 0)
    {
        await pilot.createEmbeddedDocuments('Item', toCreate);
        console.log(`lancer-npc-import | Imported ${toCreate.length} organization(s) for ${pilot.name}`);
    }
}

// Backfills bond_state from the v3 pilot fields when importCC didn't.
export async function _backfillBondState(pilot, pilotData)
{
    if (!pilot || !pilotData)
        return;
    const hasBurdens = Array.isArray(pilotData.burdens) && pilotData.burdens.length > 0;
    const hasClocks = Array.isArray(pilotData.clocks) && pilotData.clocks.length > 0;
    const hasAnswers = Array.isArray(pilotData.bondAnswers) && pilotData.bondAnswers.some(answer => answer);
    const hasMinor = !!pilotData.minorIdeal;
    if (!hasBurdens && !hasClocks && !hasAnswers && !hasMinor)
        return;

    const sanitizeLid = (id) =>
    {
        const s = String(id ?? "").replace(/[^a-zA-Z0-9_]/g, "_");
        return /^[a-zA-Z]/.test(s) ? s : `b_${s}`;
    };
    const toCounter = (entry, prefix) => ({
        lid: sanitizeLid(entry.id ?? `${prefix}_${entry.title ?? "x"}`),
        name: entry.title ?? prefix,
        min: 0,
        max: Number.isFinite(entry.segments) ? entry.segments : 6,
        value: Number.isFinite(entry.progress) ? entry.progress : 0,
        default_value: 0
    });

    const update = {};
    const cur = pilot.system?.bond_state ?? {};

    if (hasBurdens && (!Array.isArray(cur.burdens) || cur.burdens.length === 0))
        update["system.bond_state.burdens"] = pilotData.burdens.map(burden => toCounter(burden, "burden"));
    if (hasClocks && (!Array.isArray(cur.clocks) || cur.clocks.length === 0))
        update["system.bond_state.clocks"] = pilotData.clocks.map(clock => toCounter(clock, "clock"));
    if (hasAnswers && (!Array.isArray(cur.answers) || cur.answers.every(answer => !answer)))
        update["system.bond_state.answers"] = pilotData.bondAnswers;
    if (hasMinor && !cur.minor_ideal)
        update["system.bond_state.minor_ideal"] = pilotData.minorIdeal;

    if (Object.keys(update).length === 0)
        return;
    await pilot.update(update);
    console.log(`lancer-npc-import | Backfilled bond_state for ${pilot.name}`, update);
}

// Fill HP/structure/stress/repairs to max, zero heat/burn/overshield.
// Polls briefly because Lancer computes mech HP max asynchronously.
export async function _refillResources(pilot)
{
    if (!pilot?.system)
        return;

    const refillOne = async (actor) =>
    {
        const update = {};
        const sys = actor.system;
        const fillKeys = ['hp', 'structure', 'stress', 'repairs'];
        const zeroKeys = ['heat', 'burn', 'overshield'];
        for (const key of fillKeys)
        {
            const pool = sys[key];
            if (pool && typeof pool === 'object' && pool.max !== undefined && pool.value !== pool.max)
                update[`system.${key}.value`] = pool.max;
        }
        for (const key of zeroKeys)
        {
            const pool = sys[key];
            if (pool && typeof pool === 'object' && pool.value !== undefined && pool.value !== 0)
                update[`system.${key}.value`] = 0;
        }
        if (Object.keys(update).length > 0)
            await actor.update(update);
    };

    const findMechs = () =>
    {
        const mechs = [];
        const seen = new Set();
        const ownedIds = pilot.system.owned_mechs || pilot.system.mechs || [];
        for (const ref of ownedIds)
        {
            const id = typeof ref === 'string' ? ref : (ref?.id || ref?.value);
            if (!id || seen.has(id))
                continue;
            const mech = game.actors.get(id);
            if (mech?.type === 'mech')
            {
                seen.add(id); mechs.push(mech);
            }
        }
        for (const actor of game.actors)
        {
            if (actor.type !== 'mech' || seen.has(actor.id))
                continue;
            const pilotRef = actor.system?.pilot;
            const pid = typeof pilotRef === 'string' ? pilotRef : (pilotRef?.id || pilotRef?.value);
            if (pid === pilot.id)
            {
                seen.add(actor.id); mechs.push(actor);
            }
        }
        return mechs;
    };

    // Wait up to 2s for mech HP max to populate.
    for (let attempt = 0; attempt < 20; attempt++)
    {
        if (findMechs().every(mech => (mech.system?.hp?.max ?? 0) > 0))
            break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    await refillOne(pilot);
    for (const mech of findMechs())
        await refillOne(mech);
}

// Wraps Lancer's pilot JSON import (_onPilotJsonParsed): active loadout only, then reserves,
// organizations, bond, mech item state and a resource refill. Also holds the organization helpers.

import { unwrapData, normalizePilotData } from "./v3-api.js";
import { trimText, sameJson } from "./utils.js";

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
                const activeOnly = Array.isArray(pilotData.loadouts) && pilotData.loadouts.length > 1 && pilotData.loadout;
                normalizedFileData = JSON.stringify(activeOnly ? { ...pilotData, loadouts: [pilotData.loadout] } : pilotData);
            }
            catch
            {
                // not JSON, let the original importer handle it
            }
        }
        await orig.call(this, normalizedFileData);
        await _backfillMechItemState(this.actor, pilotData);
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

// Comp/Con exports mech current HP as 0, and HP at 0 fires Lancer's structure flow on a live mech.
// Carry each existing mech's real current stats instead.
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

function _cloudMechWeaponEntries(loadout)
{
    const mounts = [
        loadout.integratedWeapon,
        loadout.improved_armament,
        loadout.superheavy_mounting,
        ...(loadout.integratedMounts || []).map(mount => ({ slots: [{ weapon: mount?.weapon }] })),
        ...(loadout.mounts || [])
    ];
    return mounts
        .flatMap(mount => [...(mount?.slots || []), ...(mount?.extra || [])])
        .map(slot => slot?.weapon)
        .filter(weapon => weapon?.id);
}

function _takeByLid(pool, lid)
{
    const index = pool.findIndex(entry => entry.id === lid);
    return index < 0 ? null : pool.splice(index, 1)[0];
}

async function _backfillMechItemState(pilot, pilotData)
{
    if (!pilot)
        return;
    for (const mechData of (Array.isArray(pilotData?.mechs) ? pilotData.mechs : []))
    {
        const loadout = mechData?.loadouts?.[mechData.active_loadout_index || 0];
        if (!loadout)
            continue;
        const candidates = game.actors.filter(actor => typeof actor.is_mech === "function" && actor.is_mech() && actor.system?.lid === mechData.id);
        const mech = candidates.find(actor => actor.system?.pilot?.value === pilot || actor.system?.pilot?.value?.id === pilot.id) || candidates[0];
        if (!mech)
            continue;
        const updates = [];
        const apply = (item, entry, withProfile) =>
        {
            const update = {};
            if (item.system && "destroyed" in item.system && !!item.system.destroyed !== !!entry.destroyed)
                update["system.destroyed"] = !!entry.destroyed;
            if (withProfile)
            {
                const last = Math.max(0, (item.system?.profiles?.length || 1) - 1);
                const profile = Math.min(last, Math.max(0, Number(entry.selectedProfile) || 0));
                if ((item.system?.selected_profile_index ?? 0) !== profile)
                    update["system.selected_profile_index"] = profile;
            }
            if (Object.keys(update).length)
                updates.push({ _id: item.id, ...update });
        };
        const weapons = _cloudMechWeaponEntries(loadout);
        for (const mount of (mech.system?.loadout?.weapon_mounts || []))
        {
            for (const slot of (mount?.slots || []))
            {
                const item = slot?.weapon?.value;
                const entry = item?.system?.lid ? _takeByLid(weapons, item.system.lid) : null;
                if (entry)
                    apply(item, entry, true);
            }
        }
        const systems = [...(loadout.integratedSystems || []), ...(loadout.systems || [])].filter(entry => entry?.id);
        for (const link of (mech.system?.loadout?.systems || []))
        {
            const item = link?.value;
            const entry = item?.system?.lid ? _takeByLid(systems, item.system.lid) : null;
            if (entry)
                apply(item, entry, false);
        }
        if (updates.length)
            await mech.updateEmbeddedDocuments("Item", updates);
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
    const existing = pilot.items.filter(item => item.type === 'reserve');
    const existingLids = new Set(existing.map(item => item.system?.lid));
    const claimed = new Set();
    const toUpdate = [];
    const toCreate = [];
    for (const reserve of reserves)
    {
        const lid = reserve.id;
        if (!lid)
            continue;
        if (existingLids.has(lid))
        {
            const item = existing.find(entry => entry.system?.lid === lid && !claimed.has(entry.id));
            if (item)
            {
                claimed.add(item.id);
                if (reserve.used !== undefined && !!item.system?.used !== !!reserve.used)
                    toUpdate.push({ _id: item.id, 'system.used': !!reserve.used });
            }
            continue;
        }
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
    if (toUpdate.length > 0)
        await pilot.updateEmbeddedDocuments('Item', toUpdate);
    if (toCreate.length > 0)
    {
        await pilot.createEmbeddedDocuments('Item', toCreate);
        console.log(`lancer-npc-import | Imported ${toCreate.length} reserve(s) for ${pilot.name}`);
    }
}

export const ORG_PURPOSES = ["Military", "Scientific", "Academic", "Criminal", "Humanitarian", "Industrial", "Entertainment", "Political"];

function _orgText(value)
{
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r?\n/g, "<br>");
}

export function isOrgReserve(item)
{
    return item?.type === "reserve" && item.system?.type === "Organization";
}

export function orgHtml(org)
{
    const parts = [];
    if (org.purpose)
        parts.push(`<b>Purpose:</b> ${_orgText(org.purpose)}`);
    if (org.efficiency !== undefined)
        parts.push(`<b>Efficiency:</b> ${_orgText(org.efficiency)}`);
    if (org.influence !== undefined)
        parts.push(`<b>Influence:</b> ${_orgText(org.influence)}`);
    if (org.description)
        parts.push(_orgText(org.description));
    if (org.actions)
        parts.push(`<b>Actions:</b> ${_orgText(org.actions)}`);
    return parts.join("<br>");
}

export function formatOrg(org)
{
    return {
        name: trimText(org.name),
        type: "reserve",
        img: "systems/lancer/assets/icons/reserve.svg",
        system: {
            type: "Organization",
            label: org.purpose || "Organization",
            description: orgHtml(org),
            consumable: false,
            used: !!org.used
        }
    };
}

function _htmlLines(html)
{
    const text = String(html ?? "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(?:p|div|li|h\d)>/gi, "\n");
    const body = new DOMParser().parseFromString(text, "text/html").body;
    return (body?.textContent || "").split("\n").map(line => line.trim());
}

function _parseOrg(label, html)
{
    const org = { label: _htmlLines(label).filter(Boolean).join(" "), purpose: "", efficiency: undefined, influence: undefined, description: "", actions: "" };
    const rest = [];
    const seen = new Set();
    const header = (key, line, pattern) => !rest.length && !seen.has(key) && pattern.exec(line);
    for (const line of _htmlLines(html))
    {
        if (!rest.length && !line)
            continue;
        const purpose = header("purpose", line, /^Purpose:\s*(.*)$/i);
        const efficiency = !purpose && header("efficiency", line, /^Efficiency:\s*(-?\d+)/i);
        const influence = !purpose && !efficiency && header("influence", line, /^Influence:\s*(-?\d+)/i);
        if (purpose)
        {
            seen.add("purpose");
            org.purpose = purpose[1];
        }
        else if (efficiency)
        {
            seen.add("efficiency");
            org.efficiency = Number(efficiency[1]);
        }
        else if (influence)
        {
            seen.add("influence");
            org.influence = Number(influence[1]);
        }
        else
            rest.push(line);
    }
    const actionsAt = rest.findLastIndex(line => /^Actions:/i.test(line));
    if (actionsAt >= 0)
    {
        org.actions = [rest[actionsAt].replace(/^Actions:\s*/i, ""), ...rest.slice(actionsAt + 1)].join("\n").trim();
        rest.length = actionsAt;
    }
    org.description = rest.join("\n").trim();
    return org;
}

function _orgPurpose(value)
{
    const text = trimText(value).toLowerCase();
    return ORG_PURPOSES.find(purpose => purpose.toLowerCase() === text) || "";
}

function _orgLevel(value, fallback)
{
    return Number.isFinite(value) ? Math.min(6, Math.max(0, Math.trunc(value))) : fallback;
}

export function orgFromItem(item, base = null)
{
    const found = _parseOrg(item.system?.label, item.system?.description);
    const used = !!item.system?.used;
    if (!base)
    {
        return {
            name: trimText(item.name),
            purpose: _orgPurpose(found.label) || _orgPurpose(found.purpose) || "Military",
            description: found.description,
            efficiency: _orgLevel(found.efficiency, 0),
            influence: _orgLevel(found.influence, 0),
            actions: found.actions,
            used
        };
    }
    const was = _parseOrg(base.purpose || "Organization", orgHtml(base));
    const next = { ...base };
    if (trimText(item.name) !== trimText(base.name))
        next.name = trimText(item.name);
    const purpose = _orgPurpose(found.label) || _orgPurpose(found.purpose);
    if (purpose && purpose !== _orgPurpose(base.purpose))
        next.purpose = purpose;
    if (found.efficiency !== was.efficiency)
        next.efficiency = _orgLevel(found.efficiency, base.efficiency);
    if (found.influence !== was.influence)
        next.influence = _orgLevel(found.influence, base.influence);
    if (found.description !== was.description)
        next.description = found.description;
    if (found.actions !== was.actions)
        next.actions = found.actions;
    if (used !== !!base.used)
        next.used = used;
    return sameJson(next, base) ? base : next;
}

export function orgLabel(org)
{
    return `${trimText(org.name)} (${org.purpose || "Organization"}) E${Number(org.efficiency) || 0}/I${Number(org.influence) || 0}`;
}

export function matchOrgs(items, orgs)
{
    const free = [...orgs];
    const pairs = [];
    const worldOnly = [];
    for (const item of items)
    {
        const index = free.findIndex(org => trimText(org?.name) === trimText(item.name));
        if (index < 0)
            worldOnly.push(item);
        else
            pairs.push({ item, org: free.splice(index, 1)[0] });
    }
    return { pairs, cloudOnly: free, worldOnly };
}

export async function _importOrganizations(pilot, orgs)
{
    if (!pilot || !orgs?.length)
        return;
    const existingNames = new Set(
        pilot.items.filter(isOrgReserve).map(item => trimText(item.name))
    );
    const toCreate = [];
    for (const org of orgs)
    {
        const name = trimText(org?.name);
        if (!name || existingNames.has(name))
            continue;
        toCreate.push(formatOrg(org));
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
        const lid = String(id ?? "").replace(/[^a-zA-Z0-9_]/g, "_");
        return /^[a-zA-Z]/.test(lid) ? lid : `b_${lid}`;
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

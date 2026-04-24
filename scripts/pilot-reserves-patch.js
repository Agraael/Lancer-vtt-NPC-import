// Pilot import patch: extends Lancer's _onPilotJsonParsed to also import
// reserves/organizations and refill pool resources.

import { unwrapData, normalizePilotData } from "./v3-api.js";

export function patchPilotImportReserves() {
    const PilotSheet = game.lancer?.applications?.LancerPilotSheet;
    if (!PilotSheet?.prototype?._onPilotJsonParsed) {
        console.warn('lancer-npc-import | Could not patch pilot import: LancerPilotSheet._onPilotJsonParsed not found');
        return;
    }
    const orig = PilotSheet.prototype._onPilotJsonParsed;
    PilotSheet.prototype._onPilotJsonParsed = async function (fileData) {
        let pilotData = null;
        let normalizedFileData = fileData;
        if (fileData) {
            try {
                pilotData = JSON.parse(fileData);
                pilotData = unwrapData(pilotData);
                normalizePilotData(pilotData);
                normalizedFileData = JSON.stringify(pilotData);
            } catch { /* not JSON, let original handle */ }
        }
        await orig.call(this, normalizedFileData);
        if (pilotData?.reserves?.length > 0)
            await _importReserves(this.actor, pilotData.reserves);
        if (pilotData?.orgs?.length > 0)
            await _importOrganizations(this.actor, pilotData.orgs);
        await _refillResources(this.actor);
    };
    console.log('lancer-npc-import | Patched pilot import to include reserves & organizations');
}

export async function _importReserves(pilot, reserves) {
    if (!pilot || !reserves?.length)
        return;
    const existingLids = new Set(
        pilot.items.filter(i => i.type === 'reserve').map(i => i.system?.lid)
    );
    const toCreate = [];
    for (const r of reserves) {
        const lid = r.id;
        if (!lid || existingLids.has(lid))
            continue;
        let found = null;
        for (const pack of game.packs) {
            if (pack.documentName !== 'Item')
                continue;
            const index = await pack.getIndex({ fields: ['system.lid'] });
            const entry = index.find(e => e.system?.lid === lid);
            if (entry) {
                found = await pack.getDocument(entry._id);
                break;
            }
        }
        if (found) {
            const itemData = found.toObject();
            if (r.name)
                itemData.name = r.name;
            if (r.used !== undefined)
                itemData.system.used = r.used;
            toCreate.push(itemData);
        } else {
            const descParts = [];
            if (r.description)
                descParts.push(r.description);
            if (r.resource_name)
                descParts.push(`<b>Resource:</b> ${r.resource_name}`);
            if (r.resource_note)
                descParts.push(`<b>Note:</b> ${r.resource_note}`);
            if (r.resource_cost)
                descParts.push(`<b>Cost:</b> ${r.resource_cost}`);
            const typeMap = { 'Resource': 'Resources', 'Tactical': 'Tactical', 'Mech': 'Mech', 'Project': 'Project', 'Organization': 'Organization', 'Bonus': 'Bonus' };
            const reserveType = typeMap[r.type] || r.type || 'Resources';
            toCreate.push({
                name: r.name || r.label || 'Reserve',
                type: 'reserve',
                img: 'systems/lancer/assets/icons/reserve.svg',
                system: {
                    lid: lid,
                    type: reserveType,
                    label: r.label || r.name || '',
                    description: descParts.join('<br>') || '',
                    consumable: r.consumable ?? false,
                    used: r.used ?? false,
                },
            });
        }
    }
    if (toCreate.length > 0) {
        await pilot.createEmbeddedDocuments('Item', toCreate);
        console.log(`lancer-npc-import | Imported ${toCreate.length} reserve(s) for ${pilot.name}`);
    }
}

export async function _importOrganizations(pilot, orgs) {
    if (!pilot || !orgs?.length)
        return;
    const existingNames = new Set(
        pilot.items.filter(i => i.type === 'reserve').map(i => i.name)
    );
    const toCreate = [];
    for (const org of orgs) {
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
    if (toCreate.length > 0) {
        await pilot.createEmbeddedDocuments('Item', toCreate);
        console.log(`lancer-npc-import | Imported ${toCreate.length} organization(s) for ${pilot.name}`);
    }
}

// Fill HP/structure/stress/repairs to max, zero heat/burn/overshield.
// Polls briefly because Lancer computes mech HP max asynchronously.
export async function _refillResources(pilot) {
    if (!pilot?.system)
        return;

    const refillOne = async (actor) => {
        const update = {};
        const sys = actor.system;
        const fillKeys = ['hp', 'structure', 'stress', 'repairs'];
        const zeroKeys = ['heat', 'burn', 'overshield'];
        for (const k of fillKeys) {
            const pool = sys[k];
            if (pool && typeof pool === 'object' && pool.max !== undefined && pool.value !== pool.max)
                update[`system.${k}.value`] = pool.max;
        }
        for (const k of zeroKeys) {
            const pool = sys[k];
            if (pool && typeof pool === 'object' && pool.value !== undefined && pool.value !== 0)
                update[`system.${k}.value`] = 0;
        }
        if (Object.keys(update).length > 0)
            await actor.update(update);
    };

    const findMechs = () => {
        const mechs = [];
        const seen = new Set();
        const ownedIds = pilot.system.owned_mechs || pilot.system.mechs || [];
        for (const ref of ownedIds) {
            const id = typeof ref === 'string' ? ref : (ref?.id || ref?.value);
            if (!id || seen.has(id))
                continue;
            const m = game.actors.get(id);
            if (m?.type === 'mech') {
                seen.add(id); mechs.push(m);
            }
        }
        for (const actor of game.actors) {
            if (actor.type !== 'mech' || seen.has(actor.id))
                continue;
            const pr = actor.system?.pilot;
            const pid = typeof pr === 'string' ? pr : (pr?.id || pr?.value);
            if (pid === pilot.id) {
                seen.add(actor.id); mechs.push(actor);
            }
        }
        return mechs;
    };

    // Wait up to 2s for mech HP max to populate.
    for (let i = 0; i < 20; i++) {
        if (findMechs().every(m => (m.system?.hp?.max ?? 0) > 0))
            break;
        await new Promise(r => setTimeout(r, 100));
    }

    await refillOne(pilot);
    for (const mech of findMechs())
        await refillOne(mech);
}

// Core NPC import pipeline: normalization, data compare, and actor creation.

import { uploadPortraitToServer } from "./npc-import-ui.js";
import { diffEntries } from "./pilot-import-core.js";
import { windowLog } from "./sync-log.js";

export async function importSelectedNPCs(selection, { customTierMode = 'scaled', downloadPortraits = false, updateExisting = true } = {}, syncLog = windowLog("Import log", "Comp/Con → Foundry"))
{
    syncLog.start(selection.map(entry =>
    {
        const npc = entry.npc || entry;
        return { name: npc.name, meta: entry.replace ? `Into ${entry.replace.targetActor.name}` : (npc.names?.className || "") };
    }));

    let created = 0;
    let updated = 0;
    let replaced = 0;
    let failed = 0;
    const results = [];

    for (const [index, entry] of selection.entries())
    {
        const npc = entry.npc || entry;
        const targetActor = entry.replace?.targetActor || null;
        const keepName = !!entry.replace?.keepName;

        syncLog.begin(index, "Importing…");
        try
        {
            if (entry.link)
            {
                await entry.link.update({ "system.lid": npc.json.id });
                syncLog.addLog(`Linked ${entry.link.name}`, 'info');
            }
            const result = await importNPCFromCompCon(npc.json, updateExisting, customTierMode, targetActor, keepName, syncLog, downloadPortraits, entry.onlyActors || null);

            if (result.updated)
                updated++;
            else if (result.replaced)
                replaced++;
            else
                created++;
            syncLog.finish(index, "ok", result.updated ? "Updated" : (result.replaced ? "Replaced" : "Created"));
            results.push({ ok: true });
        }
        catch (error)
        {
            console.error(`lancer-npc-import | Error importing ${npc.name}:`, error);
            syncLog.finish(index, "fail", `Failed: ${error.message}`);
            failed++;
            results.push({ ok: false });
        }
    }

    syncLog.complete({ updated, created, replaced, failed });
    return results;
}

// Comp/Con feature customizations: tier override, custom name, description.
export async function applyFeatureCustomizations(actor, npcData, syncLog = null)
{
    try
    {
        if (!npcData.items || npcData.items.length === 0)
        {
            return;
        }

        const updates = [];
        const tierOverrides = [];
        const npcTierParsed = parseTier(npcData.tier);

        for (const ccItem of npcData.items)
        {
            const feature = actor.items.find(item =>
                item.type === 'npc_feature' &&
                item.system.lid === ccItem.itemID
            );

            if (!feature)
            {
                continue;
            }

            const updateData = { _id: feature.id };
            let hasChanges = false;

            if (ccItem.flavorName)
            {
                updateData['name'] = ccItem.flavorName;
                updateData['system.custom_name'] = ccItem.flavorName;
                hasChanges = true;
            }

            if (ccItem.description)
            {
                updateData['system.custom_description'] = ccItem.description;
                hasChanges = true;
            }

            if (ccItem.tier !== undefined && ccItem.tier !== npcTierParsed)
            {
                tierOverrides.push({
                    name: ccItem.flavorName || feature.name,
                    tier: ccItem.tier
                });
            }

            if (hasChanges)
            {
                updates.push(updateData);
            }
        }

        if (updates.length > 0)
        {
            await actor.updateEmbeddedDocuments('Item', updates);
            console.log(`lancer-npc-import | Applied ${updates.length} feature customization(s) for ${actor.name}`);
        }

        if (tierOverrides.length > 0)
        {
            const featureList = tierOverrides.map(override => `${override.name} (T${override.tier})`).join(', ');
            syncLog?.addLog(`${tierOverrides.length} feature(s) with different tiers not applied: ${featureList}`, 'warning');
            console.warn(`lancer-npc-import | Features with tier overrides for ${actor.name}:`, tierOverrides);
        }
    }
    catch (error)
    {
        console.error(`lancer-npc-import | Error applying feature customizations:`, error);
        syncLog?.addLog(`Could not apply feature customizations`, 'warning');
    }
}

// Writes custom stats into the NPC class tiers, flat or scaled.
export async function applyCustomTierStats(actor, npcData, mode = 'scaled', syncLog = null)
{
    try
    {
        const npcClass = actor.items.find(item => item.type === 'npc_class' && item.system.lid === npcData.class);

        if (!npcClass)
        {
            console.warn(`lancer-npc-import | Could not find NPC class ${npcData.class} in actor items`);
            return;
        }

        const customStats = npcData.stats || {};
        const originalStats = npcClass.system.base_stats;
        // Use the NPC's actual tier as the reference for computing offsets
        const baseTierIndex = Math.max(0, parseTier(npcData.tier) - 1);

        const calculateStat = (statName, ccKey, tierIndex) =>
        {
            const customValue = customStats[ccKey];
            const originalValue = originalStats[tierIndex][statName];

            if (customValue === undefined)
            {
                return originalValue;
            }

            if (mode === 'flat')
            {
                return customValue;
            }

            if (mode === 'scaled')
            {
                const baseTierOriginal = originalStats[baseTierIndex][statName];
                const increment = originalValue - baseTierOriginal;
                return customValue + increment;
            }

            return customValue;
        };

        const newBaseStats = [0, 1, 2].map(tierIndex => ({
            activations: calculateStat('activations', 'activations', tierIndex),
            armor: calculateStat('armor', 'armor', tierIndex),
            hp: calculateStat('hp', 'hp', tierIndex),
            evasion: calculateStat('evasion', 'evade', tierIndex),
            edef: calculateStat('edef', 'edef', tierIndex),
            heatcap: calculateStat('heatcap', 'heatcap', tierIndex),
            speed: calculateStat('speed', 'speed', tierIndex),
            sensor_range: calculateStat('sensor_range', 'sensor', tierIndex),
            save: calculateStat('save', 'save', tierIndex),
            hull: calculateStat('hull', 'hull', tierIndex),
            agi: calculateStat('agi', 'agility', tierIndex),
            sys: calculateStat('sys', 'systems', tierIndex),
            eng: calculateStat('eng', 'engineering', tierIndex),
            size: calculateStat('size', 'size', tierIndex),
            structure: calculateStat('structure', 'structure', tierIndex),
            stress: calculateStat('stress', 'stress', tierIndex)
        }));

        const newName = npcClass.name.includes('CUSTOM')
            ? npcClass.name
            : `${npcClass.name} CUSTOM`;

        await npcClass.update({
            'name': newName,
            'system.base_stats': newBaseStats
        });

        console.log(`lancer-npc-import | Applied custom tier stats (${mode}) to ${newName} for ${actor.name}`);
        syncLog?.addLog(`Applied custom tier stats (${mode})`, 'info');
    }
    catch (error)
    {
        console.error(`lancer-npc-import | Error applying custom tier stats:`, error);
        syncLog?.addLog(`Could not apply custom tier stats`, 'warning');
    }
}

export function findExistingNPCsByLID(npcData)
{
    const found = [];

    if (npcData.id)
    {
        const actorsByLid = game.actors.filter(actor => actor.type === 'npc' && actor.system.lid === npcData.id);
        found.push(...actorsByLid);
    }

    return found;
}

const NPC_STATS = [
    ['hp', 'hp', 'HP'],
    ['armor', 'armor', 'Armor'],
    ['evade', 'evasion', 'Evasion'],
    ['edef', 'edef', 'E-Defense'],
    ['heatcap', 'heatcap', 'Heat Cap'],
    ['sensor', 'sensor_range', 'Sensors'],
    ['save', 'save', 'Save'],
    ['speed', 'speed', 'Speed'],
    ['size', 'size', 'Size'],
    ['activations', 'activations', 'Activations'],
    ['hull', 'hull', 'Hull'],
    ['agility', 'agi', 'Agility'],
    ['systems', 'sys', 'Systems'],
    ['engineering', 'eng', 'Engineering'],
    ['structure', 'structure', 'Structure'],
    ['stress', 'stress', 'Stress']
];

export function findSameNameNPCs(npcData)
{
    const nameLower = String(npcData.name || "").toLowerCase();
    if (!nameLower)
        return [];
    return game.actors.filter(actor => actor.type === 'npc' && actor.name.toLowerCase() === nameLower);
}

export function npcCloudTemplates(npcData, names = {})
{
    return (npcData.templates || []).filter(Boolean).map(id => ({ id, name: names.templates?.[id] || id }));
}

export function npcCloudFeatures(npcData, names = {})
{
    return (npcData.items || []).filter(item => item?.itemID).map(item => ({
        id: item.itemID,
        name: item.flavorName || names.features?.[item.itemID]?.name || item.itemID,
        type: names.features?.[item.itemID]?.type || "",
        weaponType: names.features?.[item.itemID]?.weaponType || "",
        origin: names.features?.[item.itemID]?.origin || ""
    }));
}

function _npcItems(actor, type)
{
    return actor.items
        .filter(item => item.type === type)
        .map(item => ({ id: item.system?.lid || "", name: item.name, uuid: item.uuid }))
        .filter(entry => entry.id);
}

function _npcChanges(npcData, actor, names)
{
    const changes = [];
    const npcTier = parseTier(npcData.tier);
    if (npcData.tier !== 'custom' && npcTier !== actor.system.tier)
        changes.push({ field: "Tier", world: `T${actor.system.tier}`, cloud: `T${npcTier}`, effect: "change" });

    const actorClass = actor.items.find(item => item.type === 'npc_class');
    if ((actorClass?.system.lid || "") !== (npcData.class || ""))
        changes.push({ field: "Class", world: actorClass?.name || "", cloud: names.className || npcData.class || "", effect: "change", worldUuid: actorClass?.uuid });

    changes.push(
        ...diffEntries("Template", _npcItems(actor, 'npc_template'), npcCloudTemplates(npcData, names)),
        ...diffEntries("Feature", _npcItems(actor, 'npc_feature'), npcCloudFeatures(npcData, names))
    );

    const stats = npcData.stats || {};
    const tierIndex = npcData.tier === 'custom' ? 0 : Math.max(0, actor.system.tier - 1);
    const baseStats = actorClass?.system?.base_stats?.[tierIndex];
    if (baseStats)
    {
        for (const [ccKey, baseStatKey, displayName] of NPC_STATS)
        {
            if (stats[ccKey] === undefined)
                continue;
            if (ccKey === 'size' && actor.system.size > 4)
                continue;
            const baseValue = baseStats[baseStatKey];
            if (baseValue != stats[ccKey])
                changes.push({ field: displayName, world: String(baseValue ?? ""), cloud: String(stats[ccKey]), effect: "change", stat: ccKey });
        }
    }
    return changes;
}

export function compareNPCWithActor(npcData, actors, names = {})
{
    if (!actors || actors.length === 0)
    {
        const candidates = findSameNameNPCs(npcData);
        if (candidates.length > 0)
            return { status: 'unlinked', count: candidates.length, reasons: [], changes: [], copies: [], candidates };
        return { status: 'new', count: 0, reasons: [], changes: [], copies: [], candidates: [] };
    }

    const copies = actors.map(actor => ({ actor, changes: _npcChanges(npcData, actor, names) }));
    const merged = new Map();
    for (const copy of copies)
    {
        const seen = new Map();
        for (const change of copy.changes)
        {
            const base = `${change.field}|${change.world}|${change.cloud}`;
            const occurrence = (seen.get(base) || 0) + 1;
            seen.set(base, occurrence);
            const key = `${base}#${occurrence}`;
            if (!merged.has(key))
                merged.set(key, { ...change, copies: 0 });
            merged.get(key).copies++;
        }
    }
    const changes = [...merged.values()];
    const reasons = changes.map(change => `${change.field}: ${change.world || "none"} → ${change.cloud || "none"}${actors.length > 1 ? ` (${change.copies}/${actors.length} copies)` : ""}`);
    return { status: changes.length ? 'modified' : 'synced', count: actors.length, reasons, changes, copies, candidates: [] };
}

export function cleanLid(value)
{
    const lid = typeof value === "object" && value ? (value.data?.id || value.id) : value;
    return typeof lid === "string" ? lid.trim() : "";
}

// Normalize any comp/con JSON format (v2 full objects or v3 strings) into the format
// the import function expects: class/templates as string LIDs, items array, stats at root
export function normalizeNpcData(npcData)
{
    // class: object → string LID
    if (npcData.class)
    {
        npcData.class = cleanLid(npcData.class);
    }

    // templates: objects → string LIDs
    if (Array.isArray(npcData.templates))
    {
        npcData.templates = npcData.templates.map(cleanLid).filter(Boolean);
    }

    // features (v2) → items (v3)
    if (npcData.features && !npcData.items)
    {
        npcData.items = npcData.features.map(feature => ({
            itemID: cleanLid(feature) || cleanLid(feature.itemID),
            tier: feature.tier || 1,
            flavorName: feature.flavorName || '',
            description: feature.description || '',
            destroyed: feature.destroyed || false,
            charged: feature.charged ?? true,
            uses: feature.uses || 0
        }));
    }
    if (Array.isArray(npcData.items))
    {
        for (const item of npcData.items)
        {
            if (item)
                item.itemID = cleanLid(item.itemID);
        }
    }

    // v2 stats: combat_data.stats.max → stats at root (with v3 field names)
    if (!npcData.stats && npcData.combat_data?.stats?.max)
    {
        const maxStats = npcData.combat_data.stats.max;
        npcData.stats = {
            activations: maxStats.activations,
            armor: maxStats.armor,
            hp: maxStats.hp,
            evade: maxStats.evasion,
            edef: maxStats.edef,
            heatcap: maxStats.heatcap,
            speed: maxStats.speed,
            sensor: maxStats.sensorRange,
            save: maxStats.saveTarget,
            hull: maxStats.hull,
            agility: maxStats.agi,
            systems: maxStats.sys,
            engineering: maxStats.eng,
            size: maxStats.size,
            structure: maxStats.structure,
            stress: maxStats.stress
        };
    }

    // cloud_portrait: nested → root
    if (!npcData.cloud_portrait && npcData.img?.cloud_portrait)
    {
        npcData.cloud_portrait = npcData.img.cloud_portrait;
    }

    return npcData;
}

export async function importNPCFromCompCon(npcData, updateExisting = true, customTierMode = 'scaled', targetActor = null, keepName = false, syncLog = null, downloadPortraits = false, onlyActors = null)
{
    normalizeNpcData(npcData);
    const isCustomTier = npcData.tier === 'custom';

    let existingActors = [];
    let isReplace = false;
    let localImagePath = null;

    const cloudPortrait = npcData.cloud_portrait || npcData.img?.cloud_portrait || '';
    if (downloadPortraits && cloudPortrait)
    {
        syncLog?.addLog(`Uploading portrait to server`, 'info');
        localImagePath = await uploadPortraitToServer(cloudPortrait, npcData.name);
        if (localImagePath)
        {
            syncLog?.addLog(`Portrait saved: ${localImagePath}`, 'success');
        }
    }

    if (targetActor)
    {
        // Manual replace targets the chosen actor.
        existingActors = [targetActor];
        isReplace = true;
    }
    else if (updateExisting)
    {
        existingActors = findExistingNPCsByLID(npcData);
        if (onlyActors)
        {
            existingActors = existingActors.filter(actor => onlyActors.has(actor.id));
            if (!existingActors.length)
                throw new Error("no copy selected");
        }

        if (existingActors.length > 1)
        {
            console.log(`lancer-npc-import | Found ${existingActors.length} existing NPCs matching "${npcData.name}". Updating all.`);
            syncLog?.addLog(`Found ${existingActors.length} existing copies, updating all`, 'info');
        }
    }

    const systemData = {
        tier: parseTier(npcData.tier),
        tag: npcData.tag || '',
        subtitle: npcData.subtitle || '',
        campaign: npcData.campaign || '',
        labels: npcData.labels || [],
        note: npcData.note || '',
        side: npcData.side || 'Enemy',
        lid: npcData.id || '',
        ...(npcData.class ? {
            hp: { value: 0, max: 0 },
            armor: 0,
            evasion: 0,
            edef: 0,
            heatcap: { value: 0, max: 0 },
            structure: { value: 0, max: 0 },
            stress: { value: 0, max: 0 },
            speed: 0,
            sensor: 0,
            save: 0,
            hull: 0,
            agi: 0,
            sys: 0,
            eng: 0,
            size: 0,
            activations: 0
        } : {})
    };

    let actor;
    let wasUpdated = false;
    let wasReplaced = false;

    if (existingActors.length > 0)
    {
        for (const existingActor of existingActors)
        {
            console.log(`lancer-npc-import | Updating existing NPC: ${existingActor.name}`);

            const finalSystemData = { ...systemData };
            // Keep custom sizes above 4.
            if (existingActor.system.size > 4)
            {
                finalSystemData.size = existingActor.system.size;
                console.log(`lancer-npc-import | Preserving custom size (${existingActor.system.size}) for ${existingActor.name}`);
            }

            // Only a manual replace with keepName off renames. A normal update keeps the actor's name.
            const finalName = (isReplace && !keepName) ? npcData.name : existingActor.name;

            await existingActor.update({
                name: finalName,
                system: finalSystemData
            });
        }

        actor = existingActors[0];

        if (isReplace)
        {
            wasReplaced = true;
        }
        else
        {
            wasUpdated = true;
        }
    }
    else
    {
        const finalImg = localImagePath || cloudPortrait || npcData.localImage || '';
        const finalImgForToken = localImagePath || npcData.localImage || '';

        const actorData = {
            name: npcData.name,
            type: 'npc',
            system: systemData,
            img: finalImg,
            prototypeToken: {
                texture: {
                    src: finalImgForToken
                }
            }
        };
        actor = await Actor.create(actorData);
        if (!actor)
            throw new Error('Failed to create NPC actor');
    }

    const classAndTemplates = [];
    const missingItems = [];

    if (npcData.class)
    {
        const npcClass = await findItemByLid(npcData.class, 'npc_class');
        if (npcClass)
        {
            classAndTemplates.push(npcClass.toObject());
        }
        else
        {
            missingItems.push(`Class: ${npcData.class}`);
            syncLog?.addLog(`Class not found: ${npcData.class}`, 'warning');
        }
    }

    if (npcData.templates?.length > 0)
    {
        for (const templateLid of npcData.templates)
        {
            const template = await findItemByLid(templateLid, 'npc_template');
            if (template)
            {
                classAndTemplates.push(template.toObject());
            }
            else
            {
                missingItems.push(`Template: ${templateLid}`);
                syncLog?.addLog(`Template not found: ${templateLid}`, 'warning');
            }
        }
    }

    const featuresToAdd = [];
    const missingFeatures = [];

    if (npcData.items?.length > 0)
    {
        for (const ccItem of npcData.items)
        {
            const foundItem = await findItemByLid(ccItem.itemID, 'npc_feature');
            if (foundItem)
            {
                const itemData = foundItem.toObject();
                if (ccItem.flavorName)
                    itemData.system.custom_name = ccItem.flavorName;
                if (ccItem.description)
                    itemData.system.custom_description = ccItem.description;
                if (ccItem.tier !== undefined)
                    itemData.system.tier = ccItem.tier;
                if (ccItem.destroyed !== undefined)
                    itemData.system.destroyed = ccItem.destroyed;
                if (ccItem.uses !== undefined)
                    itemData.system.uses = { value: ccItem.uses, max: ccItem.uses };
                featuresToAdd.push(itemData);
            }
            else
            {
                missingFeatures.push(ccItem.itemID);
                syncLog?.addLog(`Feature not found: ${ccItem.flavorName || ccItem.itemID}`, 'warning');
            }
        }
    }

    const actorsToUpdate = existingActors.length > 0 ? existingActors : [actor];

    for (const actorToUpdate of actorsToUpdate)
    {
        const oldClassAndTemplates = actorToUpdate.items.filter(item =>
            item.type === 'npc_class' || item.type === 'npc_template'
        );
        if (oldClassAndTemplates.length > 0)
        {
            await actorToUpdate.deleteEmbeddedDocuments('Item', oldClassAndTemplates.map(item => item.id));
        }

        // Adding the class and templates makes Lancer add their base features.
        if (classAndTemplates.length > 0)
        {
            await actorToUpdate.createEmbeddedDocuments('Item', classAndTemplates);

            // Wait for Lancer to finish adding them.
            if (actorToUpdate.npcClassSwapPromises && actorToUpdate.npcClassSwapPromises.length > 0)
            {
                console.log(`lancer-npc-import | Waiting for ${actorToUpdate.npcClassSwapPromises.length} NPC class swap(s) to complete...`);
                await Promise.all(actorToUpdate.npcClassSwapPromises);
                actorToUpdate.npcClassSwapPromises = [];
                console.log('lancer-npc-import | NPC class swaps completed');
            }
        }

        // Detect custom stats: either tier === 'custom' or stats don't match class base
        let needsCustomStats = isCustomTier;

        if (!needsCustomStats && npcData.class && npcData.stats)
        {
            const npcClass = actorToUpdate.items.find(item => item.type === 'npc_class' && item.system.lid === npcData.class);
            if (npcClass?.system.base_stats)
            {
                const tierIndex = Math.max(0, parseTier(npcData.tier) - 1);
                const base = npcClass.system.base_stats[tierIndex];
                if (base)
                {
                    const statMap = [
                        ['hp', 'hp'], ['armor', 'armor'], ['evasion', 'evade'],
                        ['edef', 'edef'], ['heatcap', 'heatcap'], ['speed', 'speed'],
                        ['sensor_range', 'sensor'], ['save', 'save'], ['hull', 'hull'],
                        ['agi', 'agility'], ['sys', 'systems'], ['eng', 'engineering'],
                        ['activations', 'activations'], ['structure', 'structure'],
                        ['stress', 'stress'], ['size', 'size']
                    ];
                    for (const [baseKey, ccKey] of statMap)
                    {
                        if (npcData.stats[ccKey] !== undefined && base[baseKey] !== undefined)
                        {
                            if (npcData.stats[ccKey] !== base[baseKey])
                            {
                                needsCustomStats = true;
                                syncLog?.addLog(`Stats differ from class base (${baseKey}: ${base[baseKey]} → ${npcData.stats[ccKey]}), applying custom stats`, 'info');
                                break;
                            }
                        }
                    }
                }
            }
        }

        if (needsCustomStats && npcData.class)
        {
            await applyCustomTierStats(actorToUpdate, npcData, customTierMode, syncLog);
        }
        else if (npcData.class && npcData.stats?.size)
        {
            // Just apply size if it differs (some classes allow multiple sizes)
            const npcClass = actorToUpdate.items.find(item => item.type === 'npc_class' && item.system.lid === npcData.class);
            if (npcClass)
            {
                const newBaseStats = npcClass.system.base_stats.map(tierStats => ({
                    ...tierStats,
                    size: npcData.stats.size
                }));
                await npcClass.update({ 'system.base_stats': newBaseStats });
            }
        }

        // Removes every feature, including the ones the templates just added.
        const allFeatures = actorToUpdate.items.filter(item => item.type === 'npc_feature');
        if (allFeatures.length > 0)
        {
            console.log(`lancer-npc-import | Removing ${allFeatures.length} auto-added features before adding Comp/Con features`);
            await actorToUpdate.deleteEmbeddedDocuments('Item', allFeatures.map(item => item.id));
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (featuresToAdd.length > 0)
        {
            await actorToUpdate.createEmbeddedDocuments('Item', featuresToAdd);
        }

        await applyFeatureCustomizations(actorToUpdate, npcData, syncLog);

        // Reset HP, structure et stress au max, heat à 0
        await actorToUpdate.update({
            'system.hp.value': actorToUpdate.system.hp.max,
            'system.heat.value': 0,
            'system.structure.value': actorToUpdate.system.structure.max,
            'system.stress.value': actorToUpdate.system.stress.max
        });

        // Sync prototype token size to the NPC's Lancer size so drops snap right. Half-size (0.5) stays 1x1 (LA handles the visual).
        const tokenSize = Math.max(1, Math.round(actorToUpdate.system?.size ?? 1));
        const proto = actorToUpdate.prototypeToken;
        if (!proto?.flags?.lancer?.manual_token_size && (proto?.width !== tokenSize || proto?.height !== tokenSize))
        {
            await actorToUpdate.update({
                'prototypeToken.width': tokenSize,
                'prototypeToken.height': tokenSize
            });
        }
    }

    if (missingFeatures.length > 0)
    {
        syncLog?.addLog(`${missingFeatures.length} feature(s) not found in compendiums`, 'warning');
        console.warn(`lancer-npc-import | Missing features for ${npcData.name}:`, missingFeatures);
    }

    const missingTotal = missingItems.length + missingFeatures.length;
    if (missingTotal > 0)
        syncLog?.addLog(`Imported with ${missingTotal} missing item(s)`, 'warning');

    return { actor, updated: wasUpdated, replaced: wasReplaced };
}

export async function findItemByLid(lid, itemType = null)
{
    for (const pack of game.packs)
    {
        if (pack.metadata.type !== 'Item')
            continue;
        const index = await pack.getIndex({ fields: ['system.lid', 'type'] });
        const entry = index.find(indexEntry =>
        {
            const matchesLid = indexEntry.system?.lid === lid;
            const matchesType = itemType ? indexEntry.type === itemType : true;
            return matchesLid && matchesType;
        });
        if (entry)
            return await pack.getDocument(entry._id);
    }
    return null;
}

export function parseTier(tier)
{
    if (tier === 'custom')
        return 1;
    if (typeof tier === 'number')
        return Math.max(1, Math.min(3, tier));
    if (typeof tier === 'string')
    {
        const num = parseInt(tier);
        if (!isNaN(num))
            return Math.max(1, Math.min(3, num));
    }
    return 1;
}

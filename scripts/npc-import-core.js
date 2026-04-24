// Core NPC import pipeline: normalization, data compare, and actor creation.

import { ImportProgressDialog, uploadPortraitToServer } from "./npc-import-ui.js";
import { selectActorMappings } from "./npc-import-files.js";

// Importer les NPCs sélectionnés depuis Comp/Con
export async function importSelectedNPCs(npcs, updateExisting = true, customTierMode = 'scaled', manualReplace = false, downloadPortraits = false) {
    let mappings = null;
    if (manualReplace) {
        const npcsForMapping = npcs.map(npc => ({ name: npc.name }));
        mappings = await selectActorMappings(npcsForMapping);

        if (mappings === null) {
            ui.notifications.info("Import cancelled");
            return;
        }
    }

    const progressDialog = new ImportProgressDialog(npcs.length);
    progressDialog.render(true);
    progressDialog.addLog(`Starting import of ${npcs.length} NPC(s) from Comp/Con...`, 'info');

    let successCount = 0;
    let errorCount = 0;
    let updateCount = 0;
    let replaceCount = 0;

    for (let i = 0; i < npcs.length; i++) {
        const npc = npcs[i];
        let targetActor = null;
        let keepName = false;

        if (mappings && mappings[i]) {
            targetActor = mappings[i].targetActor;
            keepName = mappings[i].keepName;
        }

        try {
            progressDialog.addLog(`Importing: ${npc.name}...`, 'info');
            const result = await importNPCFromCompCon(npc.json, updateExisting, customTierMode, targetActor, keepName, progressDialog, downloadPortraits);

            if (result.updated) {
                updateCount++;
                progressDialog.addLog(`✓ Updated: ${npc.name}`, 'success');
            } else if (result.replaced) {
                replaceCount++;
                progressDialog.addLog(`✓ Replaced: ${npc.name}`, 'success');
            } else {
                progressDialog.addLog(`✓ Created: ${npc.name}`, 'success');
            }
            successCount++;

        } catch (error) {
            console.error(`Error importing ${npc.name}:`, error);
            progressDialog.addLog(`✗ Failed: ${npc.name} - ${error.message}`, 'error');
            errorCount++;
        }

        progressDialog.incrementProgress();
    }

    let summaryParts = [];
    const created = successCount - replaceCount - updateCount;
    if (created > 0)
        summaryParts.push(`${created} created`);
    if (updateCount > 0)
        summaryParts.push(`${updateCount} updated`);
    if (replaceCount > 0)
        summaryParts.push(`${replaceCount} replaced`);
    if (errorCount > 0)
        summaryParts.push(`${errorCount} failed`);

    const summaryMessage = `Import completed: ${summaryParts.join(', ')}`;
    progressDialog.addLog(summaryMessage, errorCount > 0 ? 'warning' : 'success');

    if (successCount > 0) {
        ui.notifications.info(`✓ Imported ${successCount} NPC(s)`);
    }
    if (errorCount > 0) {
        ui.notifications.warn(`✗ ${errorCount} NPC(s) failed to import`);
    }
}

// Appliquer les customisations des features (tier override, custom name, description)
export async function applyFeatureCustomizations(actor, npcData, progressDialog = null) {
    try {
        if (!npcData.items || npcData.items.length === 0) {
            return;
        }

        const updates = [];
        const tierOverrides = [];
        const npcTierParsed = parseTier(npcData.tier);

        for (const ccItem of npcData.items) {
            const feature = actor.items.find(i =>
                i.type === 'npc_feature' &&
                i.system.lid === ccItem.itemID
            );

            if (!feature) {
                continue;
            }

            const updateData = { _id: feature.id };
            let hasChanges = false;

            if (ccItem.flavorName) {
                updateData['name'] = ccItem.flavorName;
                updateData['system.custom_name'] = ccItem.flavorName;
                hasChanges = true;
            }

            if (ccItem.description) {
                updateData['system.custom_description'] = ccItem.description;
                hasChanges = true;
            }

            if (ccItem.tier !== undefined && ccItem.tier !== npcTierParsed) {
                tierOverrides.push({
                    name: ccItem.flavorName || feature.name,
                    tier: ccItem.tier
                });
            }

            if (hasChanges) {
                updates.push(updateData);
            }
        }

        if (updates.length > 0) {
            await actor.updateEmbeddedDocuments('Item', updates);
            console.log(`Applied ${updates.length} feature customization(s) for ${actor.name}`);
        }

        if (tierOverrides.length > 0) {
            const featureList = tierOverrides.map(f => `${f.name} (T${f.tier})`).join(', ');
            if (progressDialog) {
                progressDialog.addLog(`  ⚠ ${tierOverrides.length} feature(s) with different tiers not applied: ${featureList}`, 'warning');
            }
            console.warn(`Features with tier overrides for ${actor.name}:`, tierOverrides);
        }
    } catch (error) {
        console.error(`Error applying feature customizations:`, error);
        if (progressDialog) {
            progressDialog.addLog(`  ⚠ Could not apply feature customizations`, 'warning');
        }
    }
}

// Appliquer les stats custom aux tiers de la classe NPC (flat ou scaled)
export async function applyCustomTierStats(actor, npcData, mode = 'scaled', progressDialog = null) {
    try {
        const npcClass = actor.items.find(i => i.type === 'npc_class' && i.system.lid === npcData.class);

        if (!npcClass) {
            console.warn(`Could not find NPC class ${npcData.class} in actor items`);
            return;
        }

        const customStats = npcData.stats || {};
        const originalStats = npcClass.system.base_stats;
        // Use the NPC's actual tier as the reference for computing offsets
        const baseTierIndex = Math.max(0, parseTier(npcData.tier) - 1);

        const calculateStat = (statName, ccKey, tierIndex) => {
            const customValue = customStats[ccKey];
            const originalValue = originalStats[tierIndex][statName];

            if (customValue === undefined) {
                return originalValue;
            }

            if (mode === 'flat') {
                return customValue;
            }

            if (mode === 'scaled') {
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

        console.log(`Applied custom tier stats (${mode}) to ${newName} for ${actor.name}`);
        if (progressDialog) {
            progressDialog.addLog(`  ✓ Applied custom tier stats (${mode})`, 'info');
        }
    } catch (error) {
        console.error(`Error applying custom tier stats:`, error);
        if (progressDialog) {
            progressDialog.addLog(`  ⚠ Could not apply custom tier stats`, 'warning');
        }
    }
}

// Chercher tous les NPCs existants par LID
export function findExistingNPCsByLID(npcData) {
    const found = [];

    if (npcData.id) {
        const actorsByLid = game.actors.filter(a => a.type === 'npc' && a.system.lid === npcData.id);
        found.push(...actorsByLid);
    }

    return found;
}

// Comparer un NPC de Comp/Con avec un acteur existant
// Retourne: { status: 'new'|'unlinked'|'synced'|'modified', count: nombre, reasons: [] }
export function compareNPCWithActor(npcData, actors) {
    // Aucun acteur trouvé par LID
    if (!actors || actors.length === 0) {
        // Vérifier si un NPC avec le même nom existe (sans LID correspondant)
        if (npcData.name) {
            const nameLower = npcData.name.toLowerCase();
            const actorsByName = game.actors.filter(a =>
                a.type === 'npc' && a.name.toLowerCase() === nameLower
            );
            if (actorsByName.length > 0) {
                return { status: 'unlinked', count: actorsByName.length, reasons: [] };
            }
        }
        return { status: 'new', count: 0, reasons: [] };
    }

    const actor = actors[0];
    const reasons = [];

    // Note: On ne compare PAS le nom - il est préservé lors des updates

    // Comparer le TIER (sauf custom)
    const npcTier = parseTier(npcData.tier);
    if (npcData.tier !== 'custom' && npcTier !== actor.system.tier) {
        reasons.push(`tier changed: ${actor.system.tier} → ${npcTier}`);
    }

    // Comparer les ITEMS par type (Class, Templates, Features)

    // 1. Comparer la CLASSE
    const actorClass = actor.items.find(i => i.type === 'npc_class');
    const actorClassLid = actorClass?.system.lid;
    if (npcData.class !== actorClassLid) {
        reasons.push(`class: ${actorClassLid || 'none'} → ${npcData.class || 'none'}`);
    }

    // 2. Comparer les TEMPLATES
    const npcTemplates = (npcData.templates || []).filter(lid => lid).sort();
    const actorTemplates = actor.items
        .filter(i => i.type === 'npc_template')
        .map(i => i.system.lid)
        .filter(lid => lid)
        .sort();

    // Différence neutre - on ne sait pas lequel est "l'original"
    if (npcTemplates.length !== actorTemplates.length ||
        !npcTemplates.every((lid, i) => lid === actorTemplates[i])) {
        reasons.push(`templates: ${actorTemplates.length} → ${npcTemplates.length}`);
    }

    // 3. Comparer les FEATURES
    const npcFeatures = (npcData.items || [])
        .map(item => item.itemID)
        .filter(lid => lid)
        .sort();
    const actorFeatures = actor.items
        .filter(i => i.type === 'npc_feature')
        .map(i => i.system.lid)
        .filter(lid => lid)
        .sort();

    // Différence neutre
    if (npcFeatures.length !== actorFeatures.length ||
        !npcFeatures.every((lid, i) => lid === actorFeatures[i])) {
        reasons.push(`features: ${actorFeatures.length} → ${npcFeatures.length}`);
    }

    // Comparer les STATS de BASE de la classe (pas les stats totales de l'acteur qui incluent les bonus d'items)
    const stats = npcData.stats || {};

    // Trouver la classe NPC
    const npcClass = actor.items.find(i => i.type === 'npc_class');

    if (npcClass && npcClass.system.base_stats) {
        // Déterminer le tier à utiliser pour la comparaison
        // Custom tier = toujours tier 0 (index 0)
        // Autres tiers = tier actuel (tier 1 = index 0, tier 2 = index 1, tier 3 = index 2)
        const isCustomTier = npcData.tier === 'custom';
        const tierIndex = isCustomTier ? 0 : Math.max(0, actor.system.tier - 1);
        const baseStats = npcClass.system.base_stats[tierIndex];

        if (baseStats) {
            const statChecks = [
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

            for (const [ccKey, baseStatKey, displayName] of statChecks) {
                if (stats[ccKey] !== undefined) {
                    // Skip size comparison if it's custom (> 4) - we preserve custom sizes
                    if (ccKey === 'size' && actor.system.size > 4) {
                        continue;
                    }

                    const baseValue = baseStats[baseStatKey];

                    if (baseValue != stats[ccKey]) {
                        reasons.push(`${displayName}: ${baseValue} → ${stats[ccKey]}`);
                    }
                }
            }
        }
    }

    if (reasons.length > 0) {
        return { status: 'modified', count: actors.length, reasons };
    }

    return { status: 'synced', count: actors.length, reasons: [] };
}

// Normalize any comp/con JSON format (v2 full objects or v3 strings) into the format
// the import function expects: class/templates as string LIDs, items array, stats at root
export function normalizeNpcData(npcData) {
    // class: object → string LID
    if (npcData.class && typeof npcData.class !== 'string') {
        npcData.class = npcData.class.data?.id || npcData.class.id || npcData.class;
    }

    // templates: objects → string LIDs
    if (Array.isArray(npcData.templates)) {
        npcData.templates = npcData.templates.map(t =>
            typeof t === 'string' ? t : (t.data?.id || t.id || t)
        );
    }

    // features (v2) → items (v3)
    if (npcData.features && !npcData.items) {
        npcData.items = npcData.features.map(f => ({
            itemID: f.data?.id || f.id || f.itemID,
            tier: f.tier || 1,
            flavorName: f.flavorName || '',
            description: f.description || '',
            destroyed: f.destroyed || false,
            charged: f.charged ?? true,
            uses: f.uses || 0
        }));
    }

    // v2 stats: combat_data.stats.max → stats at root (with v3 field names)
    if (!npcData.stats && npcData.combat_data?.stats?.max) {
        const s = npcData.combat_data.stats.max;
        npcData.stats = {
            activations: s.activations,
            armor: s.armor,
            hp: s.hp,
            evade: s.evasion,
            edef: s.edef,
            heatcap: s.heatcap,
            speed: s.speed,
            sensor: s.sensorRange,
            save: s.saveTarget,
            hull: s.hull,
            agility: s.agi,
            systems: s.sys,
            engineering: s.eng,
            size: s.size,
            structure: s.structure,
            stress: s.stress
        };
    }

    // cloud_portrait: nested → root
    if (!npcData.cloud_portrait && npcData.img?.cloud_portrait) {
        npcData.cloud_portrait = npcData.img.cloud_portrait;
    }

    return npcData;
}

export async function importNPCFromCompCon(npcData, updateExisting = true, customTierMode = 'scaled', targetActor = null, keepName = false, progressDialog = null, downloadPortraits = false) {
    normalizeNpcData(npcData);
    const isCustomTier = npcData.tier === 'custom';

    // Déterminer les acteurs à mettre à jour
    let existingActors = [];
    let isReplace = false;
    let localImagePath = null;

    const cloudPortrait = npcData.cloud_portrait || npcData.img?.cloud_portrait || '';
    if (downloadPortraits && cloudPortrait) {
        progressDialog?.addLog(`  Uploading portrait to server...`, 'info');
        localImagePath = await uploadPortraitToServer(cloudPortrait, npcData.name);
        if (localImagePath) {
            progressDialog?.addLog(`  ✓ Portrait saved: ${localImagePath}`, 'success');
        }
    }

    if (targetActor) {
        // Manual replace: utiliser l'acteur spécifié
        existingActors = [targetActor];
        isReplace = true;
    } else if (updateExisting) {
        // Chercher tous les NPCs existants par LID
        existingActors = findExistingNPCsByLID(npcData);

        if (existingActors.length > 1) {
            console.log(`Found ${existingActors.length} existing NPCs matching "${npcData.name}". Updating all.`);
            if (progressDialog) {
                progressDialog.addLog(`  Found ${existingActors.length} existing copies, updating all...`, 'info');
            }
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

    if (existingActors.length > 0) {
        // Mettre à jour tous les acteurs existants
        for (const existingActor of existingActors) {
            console.log(`Updating existing NPC: ${existingActor.name}`);

            const finalSystemData = { ...systemData };
            // Préserver les tailles custom (> 4)
            if (existingActor.system.size > 4) {
                finalSystemData.size = existingActor.system.size;
                console.log(`Preserving custom size (${existingActor.system.size}) for ${existingActor.name}`);
            }

            // Déterminer si on change le nom :
            // - Update normal : jamais changer le nom (garder celui de l'acteur)
            // - Replace manuel : changer seulement si keepName=false
            const finalName = (isReplace && !keepName) ? npcData.name : existingActor.name;

            await existingActor.update({
                name: finalName,
                system: finalSystemData
            });
        }

        actor = existingActors[0];

        if (isReplace) {
            wasReplaced = true;
        } else {
            wasUpdated = true;
        }
    } else {
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

    if (npcData.class) {
        const npcClass = await findItemByLid(npcData.class, 'npc_class');
        if (npcClass) {
            classAndTemplates.push(npcClass.toObject());
        } else {
            missingItems.push(`Class: ${npcData.class}`);
            if (progressDialog) {
                progressDialog.addLog(`  ⚠ Class not found: ${npcData.class}`, 'warning');
            }
        }
    }

    if (npcData.templates?.length > 0) {
        for (const templateLid of npcData.templates) {
            const template = await findItemByLid(templateLid, 'npc_template');
            if (template) {
                classAndTemplates.push(template.toObject());
            } else {
                missingItems.push(`Template: ${templateLid}`);
                if (progressDialog) {
                    progressDialog.addLog(`  ⚠ Template not found: ${templateLid}`, 'warning');
                }
            }
        }
    }

    const featuresToAdd = [];
    const missingFeatures = [];

    if (npcData.items?.length > 0) {
        for (const ccItem of npcData.items) {
            const foundItem = await findItemByLid(ccItem.itemID, 'npc_feature');
            if (foundItem) {
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
            } else {
                missingFeatures.push(ccItem.itemID);
                if (progressDialog) {
                    progressDialog.addLog(`  ⚠ Feature not found: ${ccItem.flavorName || ccItem.itemID}`, 'warning');
                }
            }
        }
    }

    const actorsToUpdate = existingActors.length > 0 ? existingActors : [actor];

    // Appliquer les items à tous les acteurs
    for (const actorToUpdate of actorsToUpdate) {
        // Supprimer les anciennes classes et templates
        const oldClassAndTemplates = actorToUpdate.items.filter(i =>
            i.type === 'npc_class' || i.type === 'npc_template'
        );
        if (oldClassAndTemplates.length > 0) {
            await actorToUpdate.deleteEmbeddedDocuments('Item', oldClassAndTemplates.map(i => i.id));
        }

        // Ajouter class et templates (déclenche automatiquement les base_features via hook)
        if (classAndTemplates.length > 0) {
            await actorToUpdate.createEmbeddedDocuments('Item', classAndTemplates);

            // Attendre que Lancer finisse d'ajouter les base_features
            if (actorToUpdate.npcClassSwapPromises && actorToUpdate.npcClassSwapPromises.length > 0) {
                console.log(`Waiting for ${actorToUpdate.npcClassSwapPromises.length} NPC class swap(s) to complete...`);
                await Promise.all(actorToUpdate.npcClassSwapPromises);
                actorToUpdate.npcClassSwapPromises = [];
                console.log('NPC class swaps completed');
            }
        }

        // Detect custom stats: either tier === 'custom' or stats don't match class base
        let needsCustomStats = isCustomTier;

        if (!needsCustomStats && npcData.class && npcData.stats) {
            const npcClass = actorToUpdate.items.find(i => i.type === 'npc_class' && i.system.lid === npcData.class);
            if (npcClass?.system.base_stats) {
                const tierIndex = Math.max(0, parseTier(npcData.tier) - 1);
                const base = npcClass.system.base_stats[tierIndex];
                if (base) {
                    const statMap = [
                        ['hp', 'hp'], ['armor', 'armor'], ['evasion', 'evade'],
                        ['edef', 'edef'], ['heatcap', 'heatcap'], ['speed', 'speed'],
                        ['sensor_range', 'sensor'], ['save', 'save'], ['hull', 'hull'],
                        ['agi', 'agility'], ['sys', 'systems'], ['eng', 'engineering'],
                        ['activations', 'activations'], ['structure', 'structure'],
                        ['stress', 'stress'], ['size', 'size']
                    ];
                    for (const [baseKey, ccKey] of statMap) {
                        if (npcData.stats[ccKey] !== undefined && base[baseKey] !== undefined) {
                            if (npcData.stats[ccKey] !== base[baseKey]) {
                                needsCustomStats = true;
                                if (progressDialog) {
                                    progressDialog.addLog(`  Stats differ from class base (${baseKey}: ${base[baseKey]} → ${npcData.stats[ccKey]}), applying custom stats`, 'info');
                                }
                                break;
                            }
                        }
                    }
                }
            }
        }

        if (needsCustomStats && npcData.class) {
            await applyCustomTierStats(actorToUpdate, npcData, customTierMode, progressDialog);
        } else if (npcData.class && npcData.stats?.size) {
            // Just apply size if it differs (some classes allow multiple sizes)
            const npcClass = actorToUpdate.items.find(i => i.type === 'npc_class' && i.system.lid === npcData.class);
            if (npcClass) {
                const newBaseStats = npcClass.system.base_stats.map(tierStats => ({
                    ...tierStats,
                    size: npcData.stats.size
                }));
                await npcClass.update({ 'system.base_stats': newBaseStats });
            }
        }

        // Supprimer TOUTES les features (y compris celles ajoutées par les templates)
        const allFeatures = actorToUpdate.items.filter(i => i.type === 'npc_feature');
        if (allFeatures.length > 0) {
            console.log(`Removing ${allFeatures.length} auto-added features before adding Comp/Con features`);
            await actorToUpdate.deleteEmbeddedDocuments('Item', allFeatures.map(i => i.id));
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Ajouter les features de Comp/Con
        if (featuresToAdd.length > 0) {
            await actorToUpdate.createEmbeddedDocuments('Item', featuresToAdd);
        }

        await applyFeatureCustomizations(actorToUpdate, npcData, progressDialog);

        // Reset HP, structure et stress au max, heat à 0
        await actorToUpdate.update({
            'system.hp.value': actorToUpdate.system.hp.max,
            'system.heat.value': 0,
            'system.structure.value': actorToUpdate.system.structure.max,
            'system.stress.value': actorToUpdate.system.stress.max
        });
    }

    if (missingFeatures.length > 0) {
        if (progressDialog) {
            progressDialog.addLog(`  ⚠ ${missingFeatures.length} feature(s) not found in compendiums`, 'warning');
        }
        console.warn(`Missing features for ${npcData.name}:`, missingFeatures);
    }

    if (missingItems.length > 0 || missingFeatures.length > 0) {
        const total = missingItems.length + missingFeatures.length;
        if (progressDialog) {
            progressDialog.addLog(`  ⚠ Imported with ${total} missing item(s)`, 'warning');
        }
    }

    return { actor, updated: wasUpdated, replaced: wasReplaced };
}

export async function findItemByLid(lid, itemType = null) {
    for (const pack of game.packs) {
        if (pack.metadata.type !== 'Item')
            continue;
        const index = await pack.getIndex({ fields: ['system.lid', 'type'] });
        const entry = index.find(i => {
            const matchesLid = i.system?.lid === lid;
            const matchesType = itemType ? i.type === itemType : true;
            return matchesLid && matchesType;
        });
        if (entry)
            return await pack.getDocument(entry._id);
    }
    return null;
}

export function parseTier(tier) {
    if (tier === 'custom')
        return 1;
    if (typeof tier === 'number')
        return Math.max(1, Math.min(3, tier));
    if (typeof tier === 'string') {
        const num = parseInt(tier);
        if (!isNaN(num))
            return Math.max(1, Math.min(3, num));
    }
    return 1;
}

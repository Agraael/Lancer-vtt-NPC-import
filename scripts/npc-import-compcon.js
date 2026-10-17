// Comp/Con cloud NPC import.

import {
    cdnFetch,
    unwrapData,
    liveCloudItems
} from "./v3-api.js";
import { normalizeNpcData, cleanLid } from "./npc-import-core.js";

export function detectCustomStats(json)
{
    const classStats = json.class?.data?.stats;
    const npcStats = json.combat_data?.stats?.max;
    if (!classStats || !npcStats)
        return false;

    const tier = Math.max(0, (json.tier || 1) - 1);
    const checks = [
        'hp', 'evasion', 'edef', 'heatcap', 'speed', 'armor',
        'hull', 'agi', 'sys', 'eng', 'structure', 'stress',
        'sensorRange', 'saveTarget', 'activations'
    ];

    for (const stat of checks)
    {
        const base = Array.isArray(classStats[stat]) ? classStats[stat][tier] : classStats[stat];
        if (npcStats[stat] !== undefined && base !== undefined && npcStats[stat] !== base)
            return true;
    }
    return false;
}

export function npcFromV3Json(json, key, fallbackName)
{
    if (!json)
        return null;
    if (!json.name && fallbackName)
        json.name = fallbackName;
    if (!json.name)
    {
        const cls = json.class?.data?.name || (typeof json.class === 'string' ? json.class : '');
        const tag = json.tag || '';
        json.name = [cls, tag].filter(Boolean).join(' ').trim() || 'Unnamed NPC';
    }

    const hasCustomStats = json.tier === 'custom' || detectCustomStats(json);
    const names = {
        className: typeof json.class === 'object' ? (json.class?.data?.name || '') : '',
        role: typeof json.class === 'object' ? (json.class?.data?.role || '') : '',
        templates: {},
        features: {}
    };
    for (const template of (Array.isArray(json.templates) ? json.templates : []))
    {
        const id = cleanLid(template);
        if (id && typeof template === 'object' && template.data?.name)
            names.templates[id] = template.data.name;
    }
    for (const feature of (Array.isArray(json.features) ? json.features : []))
    {
        const id = cleanLid(feature) || cleanLid(feature?.itemID);
        const origin = feature?.data?.origin;
        if (id)
        {
            names.features[id] = {
                name: feature?.data?.name || '',
                type: feature?.data?.type || '',
                weaponType: feature?.data?.weapon_type || '',
                origin: (typeof origin === 'string' ? origin : (origin?.id || origin?.name || '')).trim()
            };
        }
    }
    normalizeNpcData(json);

    const classId = typeof json.class === 'string' ? json.class : 'Unknown';
    const tierDisplay = json.tier === 'custom'
        ? 'custom'
        : (hasCustomStats ? `${json.tier || '?'} custom` : (json.tier || '?'));

    return {
        key: key || json.id || '',
        json: json,
        name: json.name,
        class: classId,
        tier: tierDisplay,
        tag: json.tag || '',
        id: json.id || '',
        custom: hasCustomStats,
        names
    };
}

export async function fetchNPCsViaV3API(progressUpdate, cloudItems)
{
    const npcItems = liveCloudItems(await cloudItems, 'savedata_unit_').filter(item => item.uri);

    console.log(`lancer-npc-import | V3 | ${npcItems.length} NPC(s) found`);

    let loaded = 0;
    const report = () => progressUpdate(loaded, npcItems.length);
    report();

    const results = await Promise.allSettled(npcItems.map(async (item) =>
    {
        try
        {
            const resp = await cdnFetch(item.uri);
            if (!resp.ok)
                throw new Error(`CDN ${resp.status}`);
            let npcJson;
            try
            {
                npcJson = unwrapData(await resp.json());
            }
            catch (e)
            {
                console.warn(`lancer-npc-import | V3 | JSON parse failed for "${item.name}" (sortkey ${item.sortkey}):`, e.message);
                return null;
            }
            return npcFromV3Json(npcJson, item.sortkey || item.uri, item.name);
        }
        finally
        {
            loaded++;
            report();
        }
    }));

    const npcs = [];
    results.forEach((result, index) =>
    {
        const item = npcItems[index];
        if (result.status === 'fulfilled' && result.value)
            npcs.push(result.value);
        else if (result.status === 'fulfilled')
            console.warn(`lancer-npc-import | V3 | Skipped "${item.name || '(no name)'}" (sortkey ${item.sortkey || '?'}): null payload`);
        else
            console.warn(`lancer-npc-import | V3 | Failed to load "${item.name}":`, result.reason);
    });

    npcs.sort((npcA, npcB) => String(npcA.name || "").localeCompare(String(npcB.name || ""), undefined, { sensitivity: "base" }));
    return npcs;
}

export async function importFromCompCon()
{
    const { openCloudActorImport } = await import("./actor-cloud-import-ui.js");
    return openCloudActorImport();
}

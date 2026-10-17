// Pilot cloud fetch. Mirror of fetchNPCsViaV3API but filtered to savedata_Pilot_*.

import {
    cdnFetch,
    unwrapData,
    normalizePilotData,
    liveCloudItems
} from "./v3-api.js";

export function pilotFromV3Json(json, key)
{
    if (!json || !json.name)
        return null;
    const names = { licenses: {}, coreBonuses: {} };
    for (const license of (Array.isArray(json.licenses) ? json.licenses : []))
    {
        const id = license?.id || license?.data?.id;
        if (id && license.stub?.name)
            names.licenses[id] = license.stub.name;
    }
    for (const coreBonus of (Array.isArray(json.core_bonuses) ? json.core_bonuses : []))
    {
        const id = coreBonus?.id || coreBonus?.data?.id;
        const name = coreBonus?.name || coreBonus?.data?.name;
        if (id && name)
            names.coreBonuses[id] = name;
    }
    normalizePilotData(json);
    const mechs = Array.isArray(json.mechs) ? json.mechs : [];
    return {
        key: key || json.cloudID || json.id || "",
        json,
        name: json.name || "Unnamed",
        callsign: json.callsign || "",
        level: json.level ?? 0,
        mechCount: mechs.length,
        mechs,
        names,
        cloudId: json.cloudID || json.id || "",
        id: json.id || json.cloudID || ""
    };
}

export async function fetchPilotsViaV3API(progressUpdate, cloudItems)
{
    const pilotItems = liveCloudItems(await cloudItems, "savedata_pilot_").filter(item => item.uri);

    let loaded = 0;
    const results = await Promise.allSettled(pilotItems.map(async (item) =>
    {
        try
        {
            const resp = await cdnFetch(item.uri);
            if (!resp.ok)
                throw new Error(`CDN ${resp.status}`);
            const pilotJson = unwrapData(await resp.json());
            return pilotFromV3Json(pilotJson, item.sortkey || item.uri);
        }
        finally
        {
            loaded++;
            progressUpdate(loaded, pilotItems.length);
        }
    }));

    const pilots = [];
    results.forEach((result, index) =>
    {
        if (result.status === "fulfilled" && result.value)
            pilots.push(result.value);
        else if (result.status === "rejected")
            console.warn(`lancer-npc-import | V3 | pilot load failed for "${pilotItems[index].name}":`, result.reason);
    });

    pilots.sort((pilotA, pilotB) => String(pilotA.name || "").localeCompare(String(pilotB.name || ""), undefined, { sensitivity: "base" }));
    return pilots;
}

// Pilot cloud fetch. Mirror of fetchNPCsViaV3API but filtered to savedata_Pilot_*.

import {
    corsProxyFetch,
    getV3ApiBase,
    getV3ApiKey,
    getV3Cdn,
    unwrapData,
    normalizePilotData
} from "./v3-api.js";
import { getValidJwt, getUserSub } from "./auth/cognito-auth.js";

async function _authHeaders()
{
    const jwt = await getValidJwt();
    if (!jwt)
        throw new Error("NOT_LOGGED_IN");
    const userId = getUserSub();
    if (!userId)
        throw new Error("NO_USER_SUB");
    return {
        headers: {
            "Content-Type": "application/json",
            "x-api-key": getV3ApiKey(),
            "Authorization": jwt
        },
        userId
    };
}

export function pilotFromV3Json(json, key)
{
    if (!json || !json.name)
        return null;
    normalizePilotData(json);
    const mechs = Array.isArray(json.mechs) ? json.mechs.map(mech => ({
        id: mech.id,
        name: mech.name,
        frame: mech.frame || mech.frameData?.id || ""
    })) : [];
    return {
        key: key || json.cloudID || json.id || "",
        json,
        name: json.name || "Unnamed",
        callsign: json.callsign || "",
        level: json.level ?? 0,
        mechCount: mechs.length,
        mechs,
        cloudId: json.cloudID || json.id || "",
        id: json.id || json.cloudID || ""
    };
}

export async function fetchPilotsViaV3API(progressUpdate)
{
    const v3Base = getV3ApiBase();
    const { headers, userId } = await _authHeaders();

    const changedUrl = `${v3Base}/user?user_id=${encodeURIComponent(userId)}&scope=changed&since=0`;
    const changedResp = await corsProxyFetch(changedUrl, { method: "GET", headers }, { json: true });
    let data;
    if (changedResp.ok)
    {
        data = await changedResp.json();
    }
    else
    {
        const allUrl = `${v3Base}/user?user_id=${encodeURIComponent(userId)}&scope=all`;
        const allResp = await corsProxyFetch(allUrl, { method: "GET", headers }, { json: true });
        if (!allResp.ok)
            throw new Error(`V3 API ${allResp.status} ${allResp.statusText}`);
        data = await allResp.json();
    }

    const items = Array.isArray(data) ? data : (data.items || data.Items || []);
    const pilotItems = items.filter(item =>
    {
        const sortKey = (item.SortKey || item.sortkey || item.sk || "").toLowerCase();
        return sortKey.startsWith("savedata_pilot_");
    });

    const v3Cdn = getV3Cdn();
    const pilots = [];
    let loaded = 0;
    const BATCH = 10;

    for (let i = 0; i < pilotItems.length; i += BATCH)
    {
        const batch = pilotItems.slice(i, i + BATCH).filter(item => item.uri);
        const results = await Promise.allSettled(
            batch.map(async (item) =>
            {
                // ?cb= busts CloudFront's per-Origin cache.
                const resp = await fetch(`${v3Cdn}/${item.uri}?cb=${Date.now()}`, { cache: "no-store" });
                if (!resp.ok)
                    throw new Error(`CDN ${resp.status}`);
                const pilotJson = unwrapData(await resp.json());
                return pilotFromV3Json(pilotJson, item.sortkey || item.uri);
            })
        );
        for (let j = 0; j < results.length; j++)
        {
            if (results[j].status === "fulfilled" && results[j].value)
                pilots.push(results[j].value);
            else if (results[j].status === "rejected")
                console.warn(`[V3] pilot load failed for "${batch[j].name}":`, results[j].reason);
        }
        loaded += batch.length;
        if (typeof progressUpdate === "function")
            progressUpdate(loaded, pilotItems.length);
    }

    pilots.sort((pilotA, pilotB) => String(pilotA.name || "").localeCompare(String(pilotB.name || ""), undefined, { sensitivity: "base" }));
    return pilots;
}

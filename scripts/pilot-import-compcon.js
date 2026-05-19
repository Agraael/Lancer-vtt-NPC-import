// Pilot cloud fetch. Mirror of fetchNPCsViaV3API but filtered to savedata_Pilot_*.

import {
    corsProxyFetch,
    getV3ApiBase,
    getV3ApiKey,
    getV3Cdn,
    unwrapData,
    normalizePilotData,
    v3Log,
    v3DebugEnabled
} from "./v3-api.js";
import { getValidJwt, getUserSub } from "./auth/cognito-auth.js";

async function _authHeaders() {
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

export function pilotFromV3Json(json, key) {
    if (!json || !json.name)
        return null;
    normalizePilotData(json);
    const mechs = Array.isArray(json.mechs) ? json.mechs.map(m => ({
        id: m.id,
        name: m.name,
        frame: m.frame || m.frameData?.id || ""
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

export async function fetchPilotsViaV3API(progressUpdate) {
    const v3Base = getV3ApiBase();
    const { headers, userId } = await _authHeaders();

    const changedUrl = `${v3Base}/user?user_id=${encodeURIComponent(userId)}&scope=changed&since=0`;
    const changedResp = await corsProxyFetch(changedUrl, { method: "GET", headers }, { json: true });
    let data;
    if (changedResp.ok) {
        data = await changedResp.json();
    } else {
        const allUrl = `${v3Base}/user?user_id=${encodeURIComponent(userId)}&scope=all`;
        const allResp = await corsProxyFetch(allUrl, { method: "GET", headers }, { json: true });
        if (!allResp.ok)
            throw new Error(`V3 API ${allResp.status} ${allResp.statusText}`);
        data = await allResp.json();
    }

    const items = Array.isArray(data) ? data : (data.items || data.Items || []);

    if (v3DebugEnabled()) {
        const prefixSet = new Map();
        for (const it of items) {
            const sk = (it.SortKey || it.sortkey || it.sk || "");
            const prefix = sk.replace(/[_-]?[0-9a-f]{6,}.*$/i, "_*");
            prefixSet.set(prefix, (prefixSet.get(prefix) || 0) + 1);
        }
        v3Log("/user scope=all sortkey prefixes", Object.fromEntries(prefixSet));
        const nonPilotNonUnit = items.filter(it => {
            const sk = (it.SortKey || it.sortkey || it.sk || "").toLowerCase();
            return !sk.startsWith("savedata_pilot_") && !sk.startsWith("savedata_unit_");
        }).slice(0, 10);
        v3Log("/user scope=all sample non-pilot/non-unit records (first 10)", nonPilotNonUnit);
    }

    const pilotItems = items.filter(item => {
        const sk = (item.SortKey || item.sortkey || item.sk || "").toLowerCase();
        return sk.startsWith("savedata_pilot_");
    });

    const v3Cdn = getV3Cdn();
    const pilots = [];
    let loaded = 0;
    const BATCH = 10;

    let _loggedFirstPilotKeys = false;
    for (let i = 0; i < pilotItems.length; i += BATCH) {
        const batch = pilotItems.slice(i, i + BATCH).filter(it => it.uri);
        const results = await Promise.allSettled(
            batch.map(async (it) => {
                const resp = await fetch(`${v3Cdn}/${it.uri}`);
                if (!resp.ok)
                    throw new Error(`CDN ${resp.status}`);
                const pilotJson = unwrapData(await resp.json());
                if (v3DebugEnabled() && !_loggedFirstPilotKeys) {
                    _loggedFirstPilotKeys = true;
                    const keys = Object.keys(pilotJson || {}).sort();
                    const folderish = keys.filter(k => /folder|group|tag|category|collection/i.test(k));
                    v3Log("first pilot JSON top-level keys", keys);
                    v3Log("first pilot folder-ish keys", folderish.length ? folderish.map(k => ({ [k]: pilotJson[k] })) : "(none)");
                }
                return pilotFromV3Json(pilotJson, it.sortkey || it.uri);
            })
        );
        for (let j = 0; j < results.length; j++) {
            if (results[j].status === "fulfilled" && results[j].value)
                pilots.push(results[j].value);
            else if (results[j].status === "rejected")
                console.warn(`[V3] pilot load failed for "${batch[j].name}":`, results[j].reason);
        }
        loaded += batch.length;
        if (typeof progressUpdate === "function")
            progressUpdate(loaded, pilotItems.length);
    }

    pilots.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
    return pilots;
}

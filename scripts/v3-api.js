// Comp/Con V3 HTTP layer: CORS proxies, endpoints, auth headers, cloud listing, pilot JSON normalization.

import { getModuleSetting } from "./utils.js";

export const CORS_PROXIES = [
    { name: "corsproxy.io",         wrap: url => `https://corsproxy.io/?${encodeURIComponent(url)}` },
    { name: "lasossis-lancer-cors", wrap: url => `https://lasossis-lancer-cors.m-cescutti.workers.dev/?url=${encodeURIComponent(url)}` },
];

let _activeProxyIndex = 0;
let _workerDownWarned = false;
let _originalFetch = null;
export const WORKER_PROXY_NAME = "lasossis-lancer-cors";

function _maybeWarnWorkerDown(proxyName)
{
    if (proxyName !== WORKER_PROXY_NAME || _workerDownWarned)
        return;
    _workerDownWarned = true;
    ui.notifications?.error(
        "My CORS Worker isn't responding. It's probably hit the free-tier daily limit, try again in a few hours.",
        { permanent: true }
    );
}

// `{ json: true }` rotates proxies on 200 + non-JSON body.
export async function corsProxyFetch(targetUrl, init, options = {})
{
    const expectJson = !!options.json;
    const fetcher = _originalFetch || window.fetch;
    let lastErr = null;
    for (let attempt = 0; attempt < CORS_PROXIES.length; attempt++)
    {
        const proxyIndex = (_activeProxyIndex + attempt) % CORS_PROXIES.length;
        const proxy = CORS_PROXIES[proxyIndex];
        try
        {
            const resp = await fetcher.call(window, proxy.wrap(targetUrl), init);
            if (resp.status === 403 || resp.status === 429 || resp.status >= 500)
            {
                console.warn(`lancer-npc-import | V3 | CORS proxy ${proxy.name} returned ${resp.status}, trying next`);
                lastErr = new Error(`Proxy ${proxy.name} returned ${resp.status}`);
                _maybeWarnWorkerDown(proxy.name);
                continue;
            }
            if (expectJson)
            {
                const text = await resp.text();
                try
                {
                    JSON.parse(text);
                }
                catch (parseErr)
                {
                    const preview = (text || "").slice(0, 80);
                    console.warn(`lancer-npc-import | V3 | CORS proxy ${proxy.name} returned non-JSON body (${preview}...), trying next`);
                    lastErr = parseErr;
                    _maybeWarnWorkerDown(proxy.name);
                    continue;
                }
                if (proxyIndex !== _activeProxyIndex)
                {
                    console.log(`lancer-npc-import | V3 | CORS proxy switched to ${proxy.name}`);
                    _activeProxyIndex = proxyIndex;
                }
                return new Response(text, {
                    status: resp.status,
                    headers: { "Content-Type": "application/json" }
                });
            }
            if (proxyIndex !== _activeProxyIndex)
            {
                console.log(`lancer-npc-import | V3 | CORS proxy switched to ${proxy.name}`);
                _activeProxyIndex = proxyIndex;
            }
            return resp;
        }
        catch (e)
        {
            console.warn(`lancer-npc-import | V3 | CORS proxy ${proxy.name} failed:`, e?.message || e);
            lastErr = e;
            _maybeWarnWorkerDown(proxy.name);
        }
    }
    throw lastErr || new Error("All CORS proxies failed");
}

function _setting(key, fallback)
{
    const value = getModuleSetting(key);
    return (typeof value === "string" && value.length > 0) ? value : fallback;
}
export function getV3ApiBase()
{
    return _setting("v3ApiBase", "https://idu55qr85i.execute-api.us-east-1.amazonaws.com/prod").replace(/\/+$/, "");
}
export function getV3ApiKey()
{
    return _setting("v3ApiKey", "Y5DnZ4miJi30iazqn9VV73A253Db7HRxamHEQeMr");
}
export function getV3Cdn()
{
    return _setting("v3Cdn", "https://ds69h3g1zxwgy.cloudfront.net").replace(/\/+$/, "");
}
export function v3DebugEnabled()
{
    return !!getModuleSetting("v3Debug", false);
}
export function v3Log(label, data)
{
    if (!v3DebugEnabled())
        return;
    console.log(`lancer-npc-import | V3 debug | ${label}`, data);
}

export function unwrapData(json)
{
    if (json && json.data && !json.name && !json.class && !json.callsign)
        return typeof json.data === 'string' ? JSON.parse(json.data) : json.data;
    return json;
}

export function latestPerUri(items)
{
    const byUri = new Map();
    for (const item of items)
    {
        const key = item.uri || item.SortKey || item.sortkey || item.sk;
        const kept = byUri.get(key);
        if (!kept || (Number(item.updated) || 0) > (Number(kept.updated) || 0))
            byUri.set(key, item);
    }
    return [...byUri.values()];
}

export function liveCloudItems(items, prefix)
{
    const wanted = prefix.toLowerCase();
    return latestPerUri(items.filter(item => (item.SortKey || item.sortkey || item.sk || "").toLowerCase().startsWith(wanted)))
        .filter(item => !item.deleted);
}

// V3 -> V2 pilot shape, used by the cloud pilot list and by pilot-reserves-patch on imports.
export function normalizePilotData(pilotData)
{
    if (!pilotData || typeof pilotData !== 'object')
        return pilotData;
    const isPilot = pilotData.itemType === 'pilot'
        || pilotData.callsign !== undefined
        || Array.isArray(pilotData.mechs);
    if (!isPilot)
        return pilotData;

    if (!pilotData.loadout && Array.isArray(pilotData.loadouts) && pilotData.loadouts.length)
    {
        const activeIndex = pilotData.active_index ?? pilotData.active_loadout_index ?? 0;
        pilotData.loadout = pilotData.loadouts[activeIndex] || pilotData.loadouts[0];
    }

    const isV3 = "originId" in pilotData || "EXPORT_TYPE" in pilotData;

    if (!isV3 && Array.isArray(pilotData.core_bonuses))
    {
        pilotData.core_bonuses = pilotData.core_bonuses.map(coreBonus =>
            typeof coreBonus === 'string' ? coreBonus : (coreBonus?.id || coreBonus?.data?.id || coreBonus)
        );
    }

    if (!isV3 && Array.isArray(pilotData.licenses))
    {
        pilotData.licenses = pilotData.licenses.map(license =>
        {
            if (typeof license === 'string')
                return { id: license, rank: 1 };
            return { id: license.id || license.data?.id || license, rank: license.rank ?? license.level ?? 1 };
        });
    }

    const bond = pilotData.bond;
    if (bond && typeof bond === "object")
    {
        if (pilotData.bondId === undefined)
            pilotData.bondId = bond.bondId ?? bond.data?.id;
        if (!Array.isArray(pilotData.bondPowers))
            pilotData.bondPowers = Array.isArray(bond.bondPowers) ? bond.bondPowers : [];
        if (!Array.isArray(pilotData.burdens))
            pilotData.burdens = Array.isArray(bond.burdens) ? bond.burdens : [];
        if (!Array.isArray(pilotData.clocks))
            pilotData.clocks = Array.isArray(bond.clocks) ? bond.clocks : [];
        if (!Array.isArray(pilotData.bondAnswers))
            pilotData.bondAnswers = Array.isArray(bond.bondAnswers) ? bond.bondAnswers : [];
        if (pilotData.minorIdeal === undefined)
            pilotData.minorIdeal = bond.minorIdeal ?? "";
        if (pilotData.xp === undefined)
            pilotData.xp = bond.xp ?? 0;
        if (pilotData.stress === undefined)
            pilotData.stress = bond.stress ?? 0;
    }
    if (pilotData.bondId === undefined && pilotData.bond_id !== undefined)
        pilotData.bondId = pilotData.bond_id;
    if (!Array.isArray(pilotData.bondPowers) && Array.isArray(pilotData.bond_powers))
        pilotData.bondPowers = pilotData.bond_powers;
    if (pilotData.bondId)
    {
        pilotData.burdens = Array.isArray(pilotData.burdens) ? pilotData.burdens : [];
        pilotData.clocks = Array.isArray(pilotData.clocks) ? pilotData.clocks : [];
        pilotData.bondAnswers = Array.isArray(pilotData.bondAnswers) ? pilotData.bondAnswers : [];
        pilotData.minorIdeal = pilotData.minorIdeal ?? "";
        pilotData.xp = pilotData.xp ?? 0;
        pilotData.stress = pilotData.stress ?? 0;
    }

    return pilotData;
}

// Lazy import to dodge the cognito-auth -> v3-api cycle.
export async function v3AuthHeaders()
{
    const { getValidJwt, getUserSub } = await import("./auth/cognito-auth.js");
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

export function cdnFetch(uri)
{
    // ?cb= busts CloudFront's per-Origin cache.
    return fetch(`${getV3Cdn()}/${uri}?cb=${Date.now()}`, { cache: "no-store" });
}

export async function fetchCloudItems()
{
    const { headers, userId } = await v3AuthHeaders();
    const userUrl = `${getV3ApiBase()}/user?user_id=${encodeURIComponent(userId)}`;
    let response = await corsProxyFetch(`${userUrl}&scope=changed&since=0`, { method: "GET", headers }, { json: true });
    if (!response.ok)
    {
        response = await corsProxyFetch(`${userUrl}&scope=all`, { method: "GET", headers }, { json: true });
        if (!response.ok)
            throw new Error(`V3 API ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : (data.items || data.Items || []);
}

// Route Lancer v2.12's native share-code import through our CORS proxy: it hits
// api.compcon.app/v3/code directly, which the API only allows from compcon.app.
const V3_CODE_HOST_MATCH = /^https?:\/\/api\.compcon\.app\/v3\/code(\?|$)/i;

export function installV3CodeFetchPatch()
{
    if (_originalFetch)
        return;
    _originalFetch = window.fetch.bind(window);

    window.fetch = async function(input, init)
    {
        const url = typeof input === "string"
            ? input
            : (input?.url || (input instanceof URL ? input.href : ""));
        if (url && V3_CODE_HOST_MATCH.test(url))
        {
            try
            {
                v3Log("v3/code intercept -> CORS proxy", url);
                return await corsProxyFetch(url, init || { method: "GET" }, { json: true });
            }
            catch (e)
            {
                console.warn("lancer-npc-import | V3 | CORS proxy failed for v3/code, falling back to direct:", e?.message || e);
            }
        }
        return _originalFetch(input, init);
    };
    console.log("lancer-npc-import | V3 | window.fetch patched: api.compcon.app/v3/code routed through CORS proxy");
}

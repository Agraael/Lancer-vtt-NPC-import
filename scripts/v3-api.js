// Thin V3 HTTP layer for NPC cloud import. Pilot import is now the system's job.

export const CORS_PROXIES = [
    { name: "corsproxy.io",         wrap: u => `https://corsproxy.io/?${encodeURIComponent(u)}` },
    { name: "lasossis-lancer-cors", wrap: u => `https://lasossis-lancer-cors.m-cescutti.workers.dev/?url=${encodeURIComponent(u)}` },
];

let _proxyIdx = 0;
let _workerDownWarned = false;
const WORKER_PROXY_NAME = "lasossis-lancer-cors";

function _maybeWarnWorkerDown(proxyName) {
    if (proxyName !== WORKER_PROXY_NAME || _workerDownWarned)
        return;
    _workerDownWarned = true;
    ui.notifications?.error(
        "My CORS Worker isn't responding. It's probably hit the free-tier daily limit, try again in a few hours.",
        { permanent: true }
    );
}

// `{ json: true }` rotates proxies on 200 + non-JSON body.
export async function corsProxyFetch(targetUrl, init, options = {}) {
    const expectJson = !!options.json;
    let lastErr = null;
    for (let attempt = 0; attempt < CORS_PROXIES.length; attempt++) {
        const idx = (_proxyIdx + attempt) % CORS_PROXIES.length;
        const proxy = CORS_PROXIES[idx];
        try {
            const resp = await window.fetch(proxy.wrap(targetUrl), init);
            if (resp.status === 403 || resp.status === 429 || resp.status >= 500) {
                console.warn(`[V3] CORS proxy ${proxy.name} returned ${resp.status}, trying next`);
                lastErr = new Error(`Proxy ${proxy.name} returned ${resp.status}`);
                _maybeWarnWorkerDown(proxy.name);
                continue;
            }
            if (expectJson) {
                const text = await resp.text();
                try {
                    JSON.parse(text);
                } catch (parseErr) {
                    const preview = (text || "").slice(0, 80);
                    console.warn(`[V3] CORS proxy ${proxy.name} returned non-JSON body (${preview}...), trying next`);
                    lastErr = parseErr;
                    _maybeWarnWorkerDown(proxy.name);
                    continue;
                }
                if (idx !== _proxyIdx) {
                    console.log(`[V3] CORS proxy switched to ${proxy.name}`);
                    _proxyIdx = idx;
                }
                return new Response(text, {
                    status: resp.status,
                    headers: { "Content-Type": "application/json" }
                });
            }
            if (idx !== _proxyIdx) {
                console.log(`[V3] CORS proxy switched to ${proxy.name}`);
                _proxyIdx = idx;
            }
            return resp;
        } catch (e) {
            console.warn(`[V3] CORS proxy ${proxy.name} failed:`, e?.message || e);
            lastErr = e;
            _maybeWarnWorkerDown(proxy.name);
        }
    }
    throw lastErr || new Error("All CORS proxies failed");
}

function _setting(key, fallback) {
    try {
        const v = game.settings.get("lancer-npc-import", key);
        return (typeof v === "string" && v.length > 0) ? v : fallback;
    } catch {
        return fallback;
    }
}
export function getV3ApiBase() {
    return _setting("v3ApiBase", "https://idu55qr85i.execute-api.us-east-1.amazonaws.com/prod").replace(/\/+$/, "");
}
export function getV3ApiKey() {
    return _setting("v3ApiKey", "Y5DnZ4miJi30iazqn9VV73A253Db7HRxamHEQeMr");
}
export function getV3Cdn() {
    return _setting("v3Cdn", "https://ds69h3g1zxwgy.cloudfront.net").replace(/\/+$/, "");
}
// Kept for share-code-test diagnostic only.
export function getV2ShareApiHosts() {
    const raw = _setting("v2ShareApi", "https://api.compcon.app/share");
    return raw.split(",").map(s => s.trim()).filter(Boolean);
}
export function getV2ShareApiPrimary() {
    return getV2ShareApiHosts()[0] || "https://api.compcon.app/share";
}
export function getV2ShareApiKey() {
    return _setting("v2ShareApiKey", "fcFvjjrnQy2hypelJQi4X9dRI55r5KuI4bC07Maf");
}
export function v3DebugEnabled() {
    try {
        return !!game.settings.get("lancer-npc-import", "v3Debug");
    } catch {
        return false;
    }
}
export function v3Log(label, data) {
    if (!v3DebugEnabled())
        return;
    console.log(`[V3-DEBUG] ${label}`, data);
}

export function unwrapData(json) {
    if (json && json.data && !json.name && !json.class && !json.callsign)
        return typeof json.data === 'string' ? JSON.parse(json.data) : json.data;
    return json;
}

// V3 -> V2 pilot shape, used by pilot-reserves-patch on JSON imports.
export function normalizePilotData(pilotData) {
    if (!pilotData || typeof pilotData !== 'object')
        return pilotData;
    const isPilot = pilotData.itemType === 'pilot'
        || pilotData.callsign !== undefined
        || Array.isArray(pilotData.mechs);
    if (!isPilot)
        return pilotData;

    if (!pilotData.loadout && Array.isArray(pilotData.loadouts) && pilotData.loadouts.length) {
        const idx = pilotData.active_index ?? pilotData.active_loadout_index ?? 0;
        pilotData.loadout = pilotData.loadouts[idx] || pilotData.loadouts[0];
    }

    if (Array.isArray(pilotData.core_bonuses)) {
        pilotData.core_bonuses = pilotData.core_bonuses.map(cb =>
            typeof cb === 'string' ? cb : (cb?.id || cb?.data?.id || cb)
        );
    }

    if (Array.isArray(pilotData.licenses)) {
        pilotData.licenses = pilotData.licenses.map(l => {
            if (typeof l === 'string')
                return { id: l, rank: 1 };
            return { id: l.id || l.data?.id || l, rank: l.rank ?? l.level ?? 1 };
        });
    }

    const b = pilotData.bond;
    if (b && typeof b === "object") {
        if (pilotData.bondId === undefined)
            pilotData.bondId = b.bondId ?? b.data?.id;
        if (!Array.isArray(pilotData.bondPowers))
            pilotData.bondPowers = Array.isArray(b.bondPowers) ? b.bondPowers : [];
        if (!Array.isArray(pilotData.burdens))
            pilotData.burdens = Array.isArray(b.burdens) ? b.burdens : [];
        if (!Array.isArray(pilotData.clocks))
            pilotData.clocks = Array.isArray(b.clocks) ? b.clocks : [];
        if (!Array.isArray(pilotData.bondAnswers))
            pilotData.bondAnswers = Array.isArray(b.bondAnswers) ? b.bondAnswers : [];
        if (pilotData.minorIdeal === undefined)
            pilotData.minorIdeal = b.minorIdeal ?? "";
        if (pilotData.xp === undefined)
            pilotData.xp = b.xp ?? 0;
        if (pilotData.stress === undefined)
            pilotData.stress = b.stress ?? 0;
    }
    if (pilotData.bondId === undefined && pilotData.bond_id !== undefined)
        pilotData.bondId = pilotData.bond_id;
    if (!Array.isArray(pilotData.bondPowers) && Array.isArray(pilotData.bond_powers))
        pilotData.bondPowers = pilotData.bond_powers;
    if (pilotData.bondId) {
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
export async function v3ApiFetch(path) {
    const { getValidJwt } = await import("./auth/cognito-auth.js");
    const v3Base = getV3ApiBase();
    const jwt = await getValidJwt();
    const headers = { "Content-Type": "application/json", "x-api-key": getV3ApiKey() };
    if (jwt)
        headers["Authorization"] = jwt;

    const targetUrl = `${v3Base}${path}`;
    const resp = await corsProxyFetch(targetUrl, { method: "GET", headers }, { json: true });
    if (!resp.ok)
        throw new Error(`V3 API ${resp.status} ${resp.statusText}`);
    return resp.json();
}

export function sanitizeName(name) {
    return (name || 'unnamed').replace(/[^a-zA-Z\d\s:]/g, " ");
}

// Compat shim for share-code-test.
export async function getJwtTokenFromV5Auth() {
    const { getValidJwt } = await import("./auth/cognito-auth.js");
    return getValidJwt();
}

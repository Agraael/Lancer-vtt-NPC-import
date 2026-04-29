// V3 compatibility patch: reroutes Storage.list/get and share-code fetches
// to the V3 API, and accepts 12-char v3 share codes on the pilot sheet.
// Sources: https://github.com/massif-press/compcon, https://github.com/Eranziel/foundryvtt-lancer

import { normalizeNpcData } from "./npc-import-core.js";

export const CORS_PROXY = "https://corsproxy.io/?";

// Settings accessors with hardcoded fallbacks for early-boot reads.
function _setting(key, fallback) {
    try {
        const v = game.settings.get("lancer-npc-import", key);
        return (typeof v === "string" && v.length > 0) ? v : fallback;
    } catch (e) {
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

let _cachedAuth = null;
let _cachedStorage = null;
let _originalStorageList = null;
let _originalStorageGet = null;
let _originalFetch = null;

// Maps fake S3 keys → CloudFront URIs for on-demand download
const _v3KeyToUri = new Map();

// v3 item data keyed by fake S3-style key
const _v3ItemDataCache = new Map();

export function getCachedAuth() {
    return _cachedAuth;
}
export function setCachedAuth(auth) {
    _cachedAuth = auth;
}
export function getCachedStorage() {
    return _cachedStorage;
}

export async function getJwtTokenFromV5Auth() {
    if (!_cachedAuth)
        return null;
    try {
        const session = await _cachedAuth.currentSession();
        return session.getIdToken().getJwtToken();
    } catch (e) {
        console.warn("[V3] Could not get JWT:", e.message);
        return null;
    }
}

export async function getUserIdFromV5Auth() {
    if (!_cachedAuth)
        return null;
    try {
        const session = await _cachedAuth.currentSession();
        return session.getIdToken().payload.sub;
    } catch (e) {
        return null;
    }
}

// v3 may wrap item data in { data: { stuff } }
export function unwrapData(json) {
    if (json && json.data && !json.name && !json.class && !json.callsign)
        return typeof json.data === 'string' ? JSON.parse(json.data) : json.data;
    return json;
}

// V3 -> V2 pilot shape conversion for Lancer's pilot parser.
export function normalizePilotData(pilotData) {
    if (!pilotData || typeof pilotData !== 'object')
        return pilotData;
    const isPilot = pilotData.itemType === 'pilot'
        || pilotData.callsign !== undefined
        || Array.isArray(pilotData.mechs);
    if (!isPilot)
        return pilotData;

    // Pilot loadout: V3 plural array -> V2 singular object
    if (!pilotData.loadout && Array.isArray(pilotData.loadouts) && pilotData.loadouts.length) {
        const idx = pilotData.active_index ?? pilotData.active_loadout_index ?? 0;
        pilotData.loadout = pilotData.loadouts[idx] || pilotData.loadouts[0];
    }

    // core_bonuses: objects -> string LIDs
    if (Array.isArray(pilotData.core_bonuses)) {
        pilotData.core_bonuses = pilotData.core_bonuses.map(cb =>
            typeof cb === 'string' ? cb : (cb?.id || cb?.data?.id || cb)
        );
    }

    // licenses: normalize to { id, rank }
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

    // Mechs kept as-is: frame is already a string LID; wrapping it breaks
    // Lancer's compendium lookup.

    return pilotData;
}

export async function v3ApiFetch(path) {
    const v3Base = getV3ApiBase();
    const jwt = await getJwtTokenFromV5Auth();
    const headers = { "Content-Type": "application/json", "x-api-key": getV3ApiKey() };
    if (jwt)
        headers["Authorization"] = jwt;

    const targetUrl = `${v3Base}${path}`;
    const fetcher = _originalFetch || window.fetch;
    const resp = await fetcher.call(window, CORS_PROXY + encodeURIComponent(targetUrl), { method: "GET", headers });
    if (!resp.ok)
        throw new Error(`V3 API ${resp.status} ${resp.statusText}`);
    return resp.json();
}

// Matches the sanitization Lancer/CompCon use for S3 keys
export function sanitizeName(name) {
    return (name || 'unnamed').replace(/[^a-zA-Z\d\s:]/g, " ");
}

// ── Storage.list / Storage.get patch ─────────────────────────────────────────
// list()  → { results: [{ key: "pilot/Name--uuid--active" }, ...] }
// get()   → { Body: Blob }  (Blob.text() gives the JSON string)

export function installStoragePatch() {
    if (!_cachedStorage)
        return;
    if (_originalStorageList)
        return; // already patched

    _originalStorageList = _cachedStorage.list.bind(_cachedStorage);
    _originalStorageGet = _cachedStorage.get.bind(_cachedStorage);

    _cachedStorage.list = async function(prefix, options) {
        if (!game.settings.get("lancer-npc-import", "useV3Endpoint")) {
            return _originalStorageList(prefix, options);
        }

        try {
            const userId = await getUserIdFromV5Auth();
            if (!userId)
                throw new Error("Not authenticated");

            const data = await v3ApiFetch(`/user?user_id=${encodeURIComponent(userId)}&scope=all`);
            let items = Array.isArray(data) ? data : (data.items || data.Items || []);

            // v3 sortkeys: savedata_Pilot_uuid, savedata_Unit_uuid (Unit = NPC)
            const v3TypeMap = { 'pilot': 'Pilot', 'npc': 'Unit' };
            const v3Type = v3TypeMap[prefix.toLowerCase()] || prefix;
            const skPrefix = `savedata_${v3Type}_`.toLowerCase();

            const matched = items.filter(item => {
                const sk = (item.SortKey || item.sortkey || item.sk || '').toLowerCase();
                return sk.startsWith(skPrefix);
            });

            if (matched.length === 0 && items.length > 0) {
                console.warn(`[V3] No "${prefix}" items found in ${items.length} total`);
            }

            // Map fake S3 keys → CloudFront URIs (data downloaded on demand in get())
            _v3KeyToUri.clear();
            _v3ItemDataCache.clear();
            const results = [];

            for (const item of matched) {
                if (!item.uri)
                    continue;
                const name = sanitizeName(item.name || 'unnamed');
                const id = item.uri.match(/([0-9a-f-]{36})\.json$/)?.[1] || crypto.randomUUID();
                const fakeKey = `${prefix}/${name}--${id}--active`;
                _v3KeyToUri.set(fakeKey, item.uri);
                results.push({ key: fakeKey });
            }

            return { results };
        } catch (e) {
            console.error(`[V3] Storage.list failed, falling back to v2:`, e);
            return _originalStorageList(prefix, options);
        }
    };

    _cachedStorage.get = async function(key, options) {
        if (!game.settings.get("lancer-npc-import", "useV3Endpoint")) {
            return _originalStorageGet(key, options);
        }

        // Cached from a previous get
        if (_v3ItemDataCache.has(key)) {
            const json = JSON.stringify(_v3ItemDataCache.get(key));
            return { Body: new Blob([json], { type: "application/json" }) };
        }

        // Download from CloudFront on demand using the URI from list()
        const uri = _v3KeyToUri.get(key);
        if (uri) {
            try {
                const resp = await fetch(`${getV3Cdn()}/${uri}`);
                if (resp.ok) {
                    const text = await resp.text();
                    const parsed = unwrapData(JSON.parse(text));
                    if (key.startsWith('pilot/'))
                        normalizePilotData(parsed);
                    else
                        normalizeNpcData(parsed);
                    _v3ItemDataCache.set(key, parsed);
                    return { Body: new Blob([JSON.stringify(parsed)], { type: "application/json" }) };
                }
            } catch (e) {
                console.warn(`[V3] CDN download failed for "${key}":`, e);
            }
        }

        return _originalStorageGet(key, options);
    };

    console.log("[V3] Storage.list and Storage.get patched");
}


// ── Share code fetch interceptor ─────────────────────────────────────────────
// Redirects api.compcon.app/share → v3 /code endpoint

export function installFetchPatch() {
    if (_originalFetch)
        return;
    _originalFetch = window.fetch;

    window.fetch = async function(input, init) {
        if (!game.settings.get("lancer-npc-import", "useV3Endpoint")) {
            return _originalFetch.call(window, input, init);
        }

        const url = typeof input === 'string' ? input : input?.url;

        const v2Hosts = getV2ShareApiHosts();
        const isV2Share = url && v2Hosts.some(h => url.startsWith(h));
        if (isV2Share) {
            try {
                const parsed = new URL(url);
                const code = parsed.searchParams.get("code");
                if (code) {
                    console.log(`[V3] Share code "${code}" → v3`);
                    const jwt = await getJwtTokenFromV5Auth();

                    const v3Headers = {
                        "Content-Type": "application/json",
                        "x-api-key": getV3ApiKey()
                    };
                    if (jwt)
                        v3Headers["Authorization"] = jwt;

                    const v3Url = `${getV3ApiBase()}/code?scope=item&codes=${encodeURIComponent(JSON.stringify([code]))}`;
                    const v3Response = await _originalFetch.call(window, CORS_PROXY + encodeURIComponent(v3Url), {
                        method: "GET",
                        headers: v3Headers
                    });

                    if (!v3Response.ok) {
                        console.warn(`[V3] /code returned ${v3Response.status}, trying v2`);
                        return _originalFetch.call(window, input, init);
                    }

                    const v3Data = await v3Response.json();
                    v3Log(`/code response for "${code}"`, v3Data);

                    // /code returns metadata with a uri; download from CDN
                    let itemData = null;
                    let rawCdnData = null;
                    const entry = Array.isArray(v3Data) ? v3Data[0] : v3Data;
                    const uri = entry?.uri;

                    if (uri) {
                        const cdnUrl = `${getV3Cdn()}/${uri}`;
                        v3Log(`CDN GET`, cdnUrl);
                        const cdnResp = await _originalFetch.call(window, cdnUrl);
                        if (cdnResp.ok) {
                            rawCdnData = await cdnResp.json();
                            v3Log(`CDN raw payload`, rawCdnData);
                            itemData = unwrapData(rawCdnData);
                            v3Log(`after unwrapData`, itemData);
                        }
                    } else if (entry?.presign?.download) {
                        const dlResp = await _originalFetch.call(window, entry.presign.download);
                        if (dlResp.ok) {
                            rawCdnData = await dlResp.json();
                            v3Log(`presign raw payload`, rawCdnData);
                            itemData = unwrapData(rawCdnData);
                        }
                    } else if (entry?.data) {
                        itemData = typeof entry.data === 'string' ? JSON.parse(entry.data) : entry.data;
                    } else if (entry?.name && (entry?.callsign || entry?.class)) {
                        itemData = entry;
                    }

                    if (itemData) {
                        // Share codes resolve to pilots or NPCs; detect and normalize.
                        if (itemData.callsign !== undefined || itemData.itemType === 'pilot' || Array.isArray(itemData.mechs)) {
                            normalizePilotData(itemData);
                            v3Log(`after normalizePilotData`, itemData);
                        }
                        // Lancer expects { presigned: url } then fetches that url for JSON.
                        // We wrap the data in a blob URL.
                        const blob = new Blob([JSON.stringify(itemData)], { type: "application/json" });
                        const blobUrl = URL.createObjectURL(blob);
                        return new Response(JSON.stringify({ presigned: blobUrl }), { status: 200, headers: { "Content-Type": "application/json" } });
                    }

                    console.warn("[V3] Could not resolve share code data:", v3Data);
                }
            } catch (e) {
                console.error("[V3] Share code redirect failed, trying v2:", e);
            }
        }

        return _originalFetch.call(window, input, init);
    };

    console.log("[V3] Fetch interceptor installed");
}


// ── Load Auth + Storage from Lancer's bundled modules ────────────────────────

export async function loadLancerAwsModules() {
    const lancerPath = "systems/lancer";
    const lancerResponse = await fetch(`/${lancerPath}/lancer.mjs`);
    if (!lancerResponse.ok)
        throw new Error("Could not fetch lancer.mjs");

    const lancerContent = await lancerResponse.text();
    const lancerHashMatch = lancerContent.match(/import\s+["']\.\/lancer-([a-f0-9]+)\.mjs["']/);
    if (!lancerHashMatch)
        throw new Error("Could not find lancer-HASH.mjs");

    const lancerHashResponse = await fetch(`/${lancerPath}/lancer-${lancerHashMatch[1]}.mjs`);
    if (!lancerHashResponse.ok)
        throw new Error("Could not fetch lancer hash file");

    const lancerHashContent = await lancerHashResponse.text();
    const awsConfigMatch = lancerHashContent.match(/await import\(["']\.\/aws-exports-([a-f0-9]+)\.mjs["']\)/);
    const authMatch = lancerHashContent.match(/\{\s*Auth\s*\}\s*=\s*await import\(["']\.\/index-([a-f0-9]+)\.mjs["']\)/);
    const storageMatch = lancerHashContent.match(/\{\s*Storage\s*\}\s*=\s*await import\(["']\.\/index-([a-f0-9]+)\.mjs["']\)/);

    if (!awsConfigMatch || !authMatch || !storageMatch) {
        throw new Error("Could not parse AWS module file names");
    }

    const [authModule, storageModule, configModule] = await Promise.all([
        import(`/${lancerPath}/index-${authMatch[1]}.mjs`),
        import(`/${lancerPath}/index-${storageMatch[1]}.mjs`),
        import(`/${lancerPath}/aws-exports-${awsConfigMatch[1]}.mjs`)
    ]);

    if (!authModule.Auth || !storageModule.Storage || !configModule.default) {
        throw new Error("AWS modules missing expected exports");
    }

    authModule.Auth.configure(configModule.default);
    storageModule.Storage.configure(configModule.default);

    _cachedAuth = authModule.Auth;
    _cachedStorage = storageModule.Storage;

    console.log("[V3] Auth + Storage loaded from Lancer system");
}

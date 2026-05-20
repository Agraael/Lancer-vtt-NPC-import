// Comp/Con cloud NPC import.

import {
    corsProxyFetch,
    getV3ApiBase,
    getV3ApiKey,
    getV3Cdn,
    unwrapData
} from "./v3-api.js";
import { normalizeNpcData } from "./npc-import-core.js";
import { getValidJwt, getUserSub } from "./auth/cognito-auth.js";

async function _getV3AuthHeaders() {
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

export function detectCustomStats(json) {
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

    for (const stat of checks) {
        const base = Array.isArray(classStats[stat]) ? classStats[stat][tier] : classStats[stat];
        if (npcStats[stat] !== undefined && base !== undefined && npcStats[stat] !== base)
            return true;
    }
    return false;
}

export function npcFromV3Json(json, key, fallbackName) {
    if (!json)
        return null;
    if (!json.name && fallbackName)
        json.name = fallbackName;
    if (!json.name) {
        const cls = json.class?.data?.name || (typeof json.class === 'string' ? json.class : '');
        const tag = json.tag || '';
        json.name = [cls, tag].filter(Boolean).join(' ').trim() || 'Unnamed NPC';
    }

    const hasCustomStats = json.tier === 'custom' || detectCustomStats(json);
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
        id: json.id || ''
    };
}

export async function fetchNPCsViaV3API(progressUpdate) {
    const v3Base = getV3ApiBase();
    const { headers, userId } = await _getV3AuthHeaders();

    const externalProgress = typeof progressUpdate === "function";
    if (!externalProgress)
        ui.notifications.info("Fetching NPC list from Comp/Con v3...");

    let data;
    const changedUrl = `${v3Base}/user?user_id=${encodeURIComponent(userId)}&scope=changed&since=0`;
    const changedResp = await corsProxyFetch(changedUrl, { method: "GET", headers }, { json: true });
    if (changedResp.ok) {
        data = await changedResp.json();
    } else {
        const allUrl = `${v3Base}/user?user_id=${encodeURIComponent(userId)}&scope=all`;
        const allResp = await corsProxyFetch(allUrl, { method: "GET", headers }, { json: true });
        if (!allResp.ok)
            throw new Error(`V3 API ${allResp.status} ${allResp.statusText}`);
        data = await allResp.json();
    }

    let items = Array.isArray(data) ? data : (data.items || data.Items || []);

    const npcItems = items.filter(item => {
        const sk = (item.SortKey || item.sortkey || item.sk || '').toLowerCase();
        return sk.startsWith('savedata_unit_');
    });

    console.log(`[V3] ${npcItems.length} NPC(s) found`);

    let loadingDialog = null;
    if (!externalProgress) {
        loadingDialog = new Dialog({
            title: "Loading NPCs",
            content: `
                <div style="text-align:center; padding: 20px;">
                    <div style="font-size: 14px; font-weight: bold; letter-spacing: 2px; color: #222;">DOWNLOADING NPC DATA</div>
                    <div style="margin: 15px 0;">
                        <div style="background: #ccc; border-radius: 4px; overflow: hidden; height: 20px;">
                            <div id="v3-loading-bar" style="background: #991e2a; height: 100%; width: 0%; transition: width 0.2s;"></div>
                        </div>
                        <div id="v3-loading-text" style="margin-top: 8px; color: #444;">0 / ${npcItems.length}</div>
                    </div>
                </div>
            `,
            buttons: {},
            close: () => {}
        }, {
            width: 350,
            classes: ["lancer-dialog-base", "lancer-no-title"]
        });
        loadingDialog.render(true);
    }

    const v3Cdn = getV3Cdn();
    const npcs = [];
    let loaded = 0;
    const BATCH_SIZE = 10;

    if (externalProgress)
        progressUpdate(0, npcItems.length);

    for (let i = 0; i < npcItems.length; i += BATCH_SIZE) {
        const batch = npcItems.slice(i, i + BATCH_SIZE).filter(item => item.uri);

        const results = await Promise.allSettled(
            batch.map(async (item) => {
                // ?cb= busts CloudFront's per-Origin cache.
                const resp = await fetch(`${v3Cdn}/${item.uri}?cb=${Date.now()}`, { cache: "no-store" });
                if (!resp.ok)
                    throw new Error(`CDN ${resp.status}`);
                let npcJson;
                try {
                    npcJson = unwrapData(await resp.json());
                } catch (e) {
                    console.warn(`[V3] JSON parse failed for "${item.name}" (sortkey ${item.sortkey}):`, e.message);
                    return null;
                }
                return npcFromV3Json(npcJson, item.sortkey || item.uri, item.name);
            })
        );

        for (let j = 0; j < results.length; j++) {
            if (results[j].status === 'fulfilled' && results[j].value)
                npcs.push(results[j].value);
            else if (results[j].status === 'fulfilled')
                console.warn(`[V3] Skipped "${batch[j].name || '(no name)'}" (sortkey ${batch[j].sortkey || '?'}): null payload`);
            else if (results[j].status === 'rejected')
                console.warn(`[V3] Failed to load "${batch[j].name}":`, results[j].reason);
        }

        loaded += batch.length;
        if (externalProgress) {
            progressUpdate(loaded, npcItems.length);
        } else if (loadingDialog?.element) {
            const pct = Math.round((loaded / npcItems.length) * 100);
            loadingDialog.element.find('#v3-loading-bar').css('width', pct + '%');
            loadingDialog.element.find('#v3-loading-text').text(`${loaded} / ${npcItems.length}`);
        }
    }

    loadingDialog?.close();
    npcs.sort((a, b) => String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" }));
    return npcs;
}

export async function importFromCompCon() {
    const { openCloudActorImport } = await import("./actor-cloud-import-ui.js");
    return openCloudActorImport();
}

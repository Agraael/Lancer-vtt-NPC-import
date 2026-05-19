// Comp/Con cloud NPC import.

import {
    corsProxyFetch,
    getV3ApiBase,
    getV3ApiKey,
    getV3Cdn,
    unwrapData
} from "./v3-api.js";
import { NPCSelectionDialog } from "./npc-import-ui.js";
import { normalizeNpcData } from "./npc-import-core.js";
import { getValidJwt, getUserSub, isLoggedIn } from "./auth/cognito-auth.js";
import { CompconLoginDialog } from "./auth/login-dialog.js";

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

export function npcFromV3Json(json, key) {
    if (!json || !json.name)
        return null;

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

export async function fetchNPCsViaV3API() {
    const v3Base = getV3ApiBase();
    const { headers, userId } = await _getV3AuthHeaders();

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

    const loadingDialog = new Dialog({
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

    const v3Cdn = getV3Cdn();
    const npcs = [];
    let loaded = 0;
    const BATCH_SIZE = 10;

    for (let i = 0; i < npcItems.length; i += BATCH_SIZE) {
        const batch = npcItems.slice(i, i + BATCH_SIZE).filter(item => item.uri);

        const results = await Promise.allSettled(
            batch.map(async (item) => {
                const resp = await fetch(`${v3Cdn}/${item.uri}`);
                if (!resp.ok)
                    throw new Error(`CDN ${resp.status}`);
                const npcJson = unwrapData(await resp.json());
                return npcFromV3Json(npcJson, item.sortkey || item.uri);
            })
        );

        for (let j = 0; j < results.length; j++) {
            if (results[j].status === 'fulfilled' && results[j].value)
                npcs.push(results[j].value);
            else if (results[j].status === 'rejected')
                console.warn(`[V3] Failed to load "${batch[j].name}":`, results[j].reason);
        }

        loaded += batch.length;
        const pct = Math.round((loaded / npcItems.length) * 100);
        if (loadingDialog.element) {
            loadingDialog.element.find('#v3-loading-bar').css('width', pct + '%');
            loadingDialog.element.find('#v3-loading-text').text(`${loaded} / ${npcItems.length}`);
        }
    }

    loadingDialog.close();
    return npcs;
}

async function _ensureLoginThenFetch() {
    if (!isLoggedIn()) {
        const signedIn = await new Promise((resolve) => {
            new CompconLoginDialog(success => resolve(!!success)).render(true);
        });
        if (!signedIn)
            return null;
    }
    return fetchNPCsViaV3API();
}

export async function importFromCompCon() {
    try {
        const validNPCs = await _ensureLoginThenFetch();
        if (validNPCs === null)
            return;

        if (!validNPCs || validNPCs.length === 0) {
            ui.notifications.warn("No NPCs found in Comp/Con roster");
            return;
        }
        new NPCSelectionDialog(validNPCs).render(true);
    } catch (error) {
        if (error.message === "NOT_LOGGED_IN") {
            ui.notifications.warn("Sign in to Comp/Con to browse cloud NPCs.");
            return;
        }
        console.error("Error fetching NPCs from Comp/Con:", error);
        ui.notifications.error(`Error: ${error.message}`);
    }
}

// Import from Comp/Con cloud flow.

import {
    CORS_PROXY,
    getV3ApiBase,
    getV3ApiKey,
    getV3Cdn,
    setCachedAuth,
    unwrapData
} from "./v3-api.js";
import { NPCSelectionDialog } from "./npc-import-ui.js";
import { normalizeNpcData } from "./npc-import-core.js";

export async function getV3AuthHeaders(Auth) {
    const session = await Auth.currentSession();
    const idToken = session.getIdToken().getJwtToken();
    const userId = session.getIdToken().payload.sub;
    return {
        headers: {
            "Content-Type": "application/json",
            "x-api-key": getV3ApiKey(),
            "Authorization": idToken
        },
        userId
    };
}

// Check if any tier's stats differ from class base stats
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

    // Detect custom stats before normalizing (needs full class object)
    const hasCustomStats = json.tier === 'custom' || detectCustomStats(json);

    // Normalize with shared function
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

export async function fetchNPCsViaV3API(Auth) {
    const v3Base = getV3ApiBase();
    const { headers, userId } = await getV3AuthHeaders(Auth);

    ui.notifications.info("Fetching NPC list from Comp/Con v3...");

    let data;
    const changedUrl = `${v3Base}/user?user_id=${encodeURIComponent(userId)}&scope=changed&since=0`;
    const changedResp = await fetch(CORS_PROXY + encodeURIComponent(changedUrl), { method: "GET", headers });
    if (changedResp.ok) {
        data = await changedResp.json();
    } else {
        const allUrl = `${v3Base}/user?user_id=${encodeURIComponent(userId)}&scope=all`;
        const allResp = await fetch(CORS_PROXY + encodeURIComponent(allUrl), { method: "GET", headers });
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

    // Show a loading dialog while downloading NPC data from CDN
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

export async function importFromCompCon() {
    try {
        ui.notifications.info("Connecting to Comp/Con...");

        let Auth, Storage, awsConfig;

        const lancerPath = game.system.id === "lancer" ? "systems/lancer" : null;
        if (!lancerPath) {
            throw new Error("Lancer system not found");
        }

        const tryImportModules = async (basePath) => {
            try {
                console.log("Auto-detecting AWS module files...");

                const lancerResponse = await fetch(`/${basePath}/lancer.mjs`);
                if (!lancerResponse.ok) {
                    throw new Error("Could not fetch lancer.mjs");
                }

                const lancerContent = await lancerResponse.text();

                const lancerHashMatch = lancerContent.match(/import\s+["']\.\/lancer-([a-f0-9]+)\.mjs["']/);
                if (!lancerHashMatch) {
                    throw new Error("Could not find lancer-HASH.mjs reference in lancer.mjs");
                }

                const lancerHashFile = `lancer-${lancerHashMatch[1]}.mjs`;
                console.log(`Found main file: ${lancerHashFile}`);

                const lancerHashResponse = await fetch(`/${basePath}/${lancerHashFile}`);
                if (!lancerHashResponse.ok) {
                    throw new Error(`Could not fetch ${lancerHashFile}`);
                }

                const lancerHashContent = await lancerHashResponse.text();

                const awsConfigMatch = lancerHashContent.match(/await import\(["']\.\/aws-exports-([a-f0-9]+)\.mjs["']\)/);
                const authMatch = lancerHashContent.match(/\{\s*Auth\s*\}\s*=\s*await import\(["']\.\/index-([a-f0-9]+)\.mjs["']\)/);
                const storageMatch = lancerHashContent.match(/\{\s*Storage\s*\}\s*=\s*await import\(["']\.\/index-([a-f0-9]+)\.mjs["']\)/);

                if (!awsConfigMatch || !authMatch || !storageMatch) {
                    throw new Error("Could not parse AWS module file names from lancer-HASH.mjs");
                }

                const configFile = `aws-exports-${awsConfigMatch[1]}.mjs`;
                const authFile = `index-${authMatch[1]}.mjs`;
                const storageFile = `index-${storageMatch[1]}.mjs`;

                console.log(`Detected AWS files: ${authFile}, ${storageFile}, ${configFile}`);

                const [authModule, storageModule, configModule] = await Promise.all([
                    import(`/${basePath}/${authFile}`),
                    import(`/${basePath}/${storageFile}`),
                    import(`/${basePath}/${configFile}`)
                ]);

                if (authModule.Auth && storageModule.Storage && configModule.default) {
                    Auth = authModule.Auth;
                    Storage = storageModule.Storage;
                    awsConfig = configModule.default;
                    console.log(`✓ Successfully auto-loaded AWS modules`);
                    return true;
                }

                return false;
            } catch (e) {
                console.warn("Could not auto-detect AWS modules, trying fallback...", e);

                const possibleHashes = [
                    { auth: "index-5139827c.mjs", storage: "index-66abcef7.mjs", config: "aws-exports-1e808d22.mjs" },
                ];

                for (const combo of possibleHashes) {
                    try {
                        const [authModule, storageModule, configModule] = await Promise.all([
                            import(`/${basePath}/${combo.auth}`),
                            import(`/${basePath}/${combo.storage}`),
                            import(`/${basePath}/${combo.config}`)
                        ]);

                        Auth = authModule.Auth;
                        Storage = storageModule.Storage;
                        awsConfig = configModule.default;

                        if (Auth && Storage && awsConfig) {
                            console.log(`✓ Successfully loaded AWS modules using fallback`);
                            return true;
                        }
                    } catch (e) {
                        continue;
                    }
                }

                return false;
            }
        };

        const loaded = await tryImportModules(lancerPath);

        if (!loaded || !Auth || !Storage || !awsConfig) {
            throw new Error("Could not load AWS modules.");
        }

        Auth.configure(awsConfig);
        Storage.configure(awsConfig);

        // Cache Auth for the V3 fetch interceptor to use
        setCachedAuth(Auth);

        try {
            await Auth.currentSession();
        } catch (e) {
            ui.notifications.error("Not logged into Comp/Con. Go to Settings → System Settings → COMP/CON Login");
            return;
        }

        ui.notifications.info("Fetching NPCs from Comp/Con...");

        const useV3 = game.settings.get("lancer-npc-import", "useV3Endpoint");
        let validNPCs = [];

        if (useV3) {
            // V3 path: use the v3 API Gateway directly
            validNPCs = await fetchNPCsViaV3API(Auth);
        } else {
            // V2 path: legacy direct S3 via Amplify Storage
            const res = await Storage.list("npc", {
                level: "protected",
                cacheControl: "no-cache",
                pageSize: 1000
            });

            const active = res.results.filter(x => x.key?.endsWith("--active"));

            if (active.length === 0) {
                ui.notifications.warn("No NPCs found in Comp/Con roster");
                return;
            }

            const v2LoadingDialog = new Dialog({
                title: "Loading NPCs",
                content: `
                    <div style="text-align:center; padding: 20px;">
                        <div style="font-size: 14px; font-weight: bold; letter-spacing: 2px; color: #222;">DOWNLOADING NPC DATA</div>
                        <div style="margin: 15px 0;">
                            <div style="background: #ccc; border-radius: 4px; overflow: hidden; height: 20px;">
                                <div id="v2-loading-bar" style="background: #991e2a; height: 100%; width: 0%; transition: width 0.2s;"></div>
                            </div>
                            <div id="v2-loading-text" style="margin-top: 8px; color: #444;">0 / ${active.length}</div>
                        </div>
                    </div>
                `,
                buttons: {},
                close: () => {}
            }, {
                width: 350,
                classes: ["lancer-dialog-base", "lancer-no-title"]
            });
            v2LoadingDialog.render(true);

            let v2Loaded = 0;
            const allNPCs = [];
            const V2_BATCH = 10;

            for (let i = 0; i < active.length; i += V2_BATCH) {
                const batch = active.slice(i, i + V2_BATCH);

                const results = await Promise.allSettled(
                    batch.map(async (item) => {
                        const data = await Storage.get(item.key, {
                            level: "protected",
                            download: true,
                            cacheControl: "no-cache"
                        });
                        const text = await data.Body.text();
                        const json = JSON.parse(text);
                        return {
                            key: item.key,
                            json: json,
                            name: json.name || 'Unnamed',
                            class: json.class || 'Unknown',
                            tier: json.tier || '?',
                            tag: json.tag || '',
                            id: json.id || ''
                        };
                    })
                );

                for (let j = 0; j < results.length; j++) {
                    if (results[j].status === 'fulfilled')
                        allNPCs.push(results[j].value);
                    else
                        console.error(`Error loading ${batch[j].key}:`, results[j].reason);
                }

                v2Loaded += batch.length;
                const pct = Math.round((v2Loaded / active.length) * 100);
                if (v2LoadingDialog.element) {
                    v2LoadingDialog.element.find('#v2-loading-bar').css('width', pct + '%');
                    v2LoadingDialog.element.find('#v2-loading-text').text(`${v2Loaded} / ${active.length}`);
                }
            }

            v2LoadingDialog.close();
            validNPCs = allNPCs;
        }

        if (validNPCs.length === 0) {
            ui.notifications.warn("No NPCs found in Comp/Con roster");
            return;
        }

        new NPCSelectionDialog(validNPCs).render(true);

    } catch (error) {
        console.error("Error fetching NPCs from Comp/Con:", error);
        ui.notifications.error(`Error: ${error.message}`);
    }
}

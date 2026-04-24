import { checkModuleUpdate } from "./version-check.js";
import { registerV3LcpShim } from "./v3-lcp-shim.js";
import { registerSnapshotApi } from "./compendium-snapshot.js";
import {
    installStoragePatch,
    installFetchPatch,
    loadLancerAwsModules
} from "./v3-api.js";
import { installPilotSheetPatch } from "./pilot-sheet-patch.js";
import { patchPilotImportReserves } from "./pilot-reserves-patch.js";
import { NPCImportDialog } from "./npc-import-ui.js";

export async function ImportNPC() {
    new NPCImportDialog().render(true);
}

Hooks.once('init', () => {
    // Option pour cocher la case par défaut
    game.settings.register("lancer-npc-import", "defaultDownloadPortrait", {
        name: "Download portraits by default",
        hint: "If enabled, the portrait download checkbox will be checked by default in the import dialog.",
        scope: "client",
        config: true,
        type: Boolean,
        default: false
    });

    // Chemin du dossier de stockage
    game.settings.register("lancer-npc-import", "portraitStoragePath", {
        name: "Portrait Storage Path",
        hint: "The folder inside 'User Data' where portraits will be saved.",
        scope: "world",
        config: true,
        type: String,
        default: "compcon_img"
    });

    // Patch to V3 endpoint
    game.settings.register("lancer-npc-import", "useV3Endpoint", {
        name: "Patch to V3 endpoint",
        hint: "Use Comp/Con V3. Required since compcon.app is V3 and api.compcon.app/share is offline. Requires reload.",
        scope: "client",
        config: true,
        type: Boolean,
        default: true,
        requiresReload: true
    });

    // Endpoint overrides, editable without code release.
    game.settings.register("lancer-npc-import", "v3ApiBase", {
        name: "V3 API Base URL",
        hint: "V3 API Gateway URL, no trailing slash.",
        scope: "world",
        config: true,
        type: String,
        default: "https://idu55qr85i.execute-api.us-east-1.amazonaws.com/prod",
        requiresReload: true
    });

    game.settings.register("lancer-npc-import", "v3ApiKey", {
        name: "V3 API Key",
        hint: "x-api-key header for V3.",
        scope: "world",
        config: true,
        type: String,
        default: "Y5DnZ4miJi30iazqn9VV73A253Db7HRxamHEQeMr",
        requiresReload: true
    });

    game.settings.register("lancer-npc-import", "v3Cdn", {
        name: "V3 CDN Base URL",
        hint: "CloudFront host for V3 item JSON, no trailing slash.",
        scope: "world",
        config: true,
        type: String,
        default: "https://ds69h3g1zxwgy.cloudfront.net",
        requiresReload: true
    });

    game.settings.register("lancer-npc-import", "v2ShareApi", {
        name: "V2 Share API URL",
        hint: "V2 share hosts intercepted by the V3 redirect. Comma-separated.",
        scope: "world",
        config: true,
        type: String,
        default: "https://api.compcon.app/share,https://ujgatmvzlg.execute-api.us-east-1.amazonaws.com/prod/share",
        requiresReload: true
    });

    game.settings.register("lancer-npc-import", "v2ShareApiKey", {
        name: "V2 Share API Key",
        hint: "x-api-key header for V2 share endpoint.",
        scope: "world",
        config: true,
        type: String,
        default: "fcFvjjrnQy2hypelJQi4X9dRI55r5KuI4bC07Maf",
        requiresReload: true
    });

    game.settings.register("lancer-npc-import", "v3Debug", {
        name: "V3 debug logging",
        hint: "Logs V3 /code response, CDN payload, unwrap/normalize steps to console.",
        scope: "client",
        config: true,
        type: Boolean,
        default: false
    });


    game.settings.register("lancer-npc-import", "lastNotifiedVersion", {
        name: "Last Notified Version",
        scope: "world",
        config: false,
        type: String,
        default: ""
    });

    // Install Storage + fetch patches during init so they're ready before
    // the Lancer system's configureAmplify() calls populatePilotCache()
    if (game.system.id === 'lancer' && game.settings.get("lancer-npc-import", "useV3Endpoint")) {
        loadLancerAwsModules().then(() => {
            installStoragePatch();
            installFetchPatch();
            console.log("[V3] Storage + fetch patches active (init)");
        }).catch(e => {
            console.error("[V3] Failed to install patches during init:", e);
        });
    }
});

Hooks.once('ready', async () => {
    if (game.system.id !== 'lancer')
        return;

    checkModuleUpdate('lancer-npc-import');
    patchPilotImportReserves();
    registerV3LcpShim();
    registerSnapshotApi();

    if (!game.settings.get("lancer-npc-import", "useV3Endpoint"))
        return;

    // Storage + fetch patches already installed during init.
    // Pilot sheet hook needs the DOM so it goes here.
    installPilotSheetPatch();
    ui.notifications.info("NPC Import: V3 patch active");
});

Hooks.on('renderActorDirectory', (_app, html) => {
    if (game.system.id !== 'lancer')
        return;

    const headerActions = html.find('.header-actions.action-buttons');
    if (headerActions.length === 0)
        return;

    const importButton = $(`
        <button class="import-npc-button" title="Import NPCs from Comp/Con or JSON files">
            <i class="fas fa-file-import"></i> Import NPCs
        </button>
    `);
    importButton.click(() => {
        ImportNPC();
    });
    headerActions.append(importButton);
});

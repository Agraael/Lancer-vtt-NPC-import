import { checkModuleUpdate } from "./version-check.js";
import { registerV3LcpShim } from "./v3-lcp-shim.js";
import { registerSnapshotApi } from "./compendium-snapshot.js";
import { patchPilotImportReserves } from "./pilot-reserves-patch.js";
import { ActorImportDialog } from "./npc-import-ui.js";
import { LcpDebugDiffMenu } from "./lcp-debug-diff.js";
import { ShareCodeTestMenu } from "./share-code-test.js";
import { RefreshItemsDialog } from "./refresh/refresh-ui.js";
import { isRefreshableActor } from "./refresh/refresh-core.js";
import { COGNITO_SETTINGS_KEYS } from "./auth/cognito-auth.js";
import { installV3CodeFetchPatch } from "./v3-api.js";

export async function ImportActor() {
    new ActorImportDialog().render(true);
}
export const ImportNPC = ImportActor;

Hooks.once('init', () => {
    if (game.system?.id === 'lancer')
        installV3CodeFetchPatch();

    game.settings.register("lancer-npc-import", "defaultDownloadPortrait", {
        name: "Download portraits by default",
        hint: "If enabled, the portrait download checkbox will be checked by default in the import dialog.",
        scope: "client",
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register("lancer-npc-import", "portraitStoragePath", {
        name: "Portrait Storage Path",
        hint: "The folder inside 'User Data' where portraits will be saved.",
        scope: "world",
        config: true,
        type: String,
        default: "compcon_img"
    });

    // Endpoint overrides, editable without code release.
    game.settings.register("lancer-npc-import", "v3ApiBase", {
        name: "V3 API Base URL",
        hint: "V3 API Gateway URL for NPC list/user data, no trailing slash.",
        scope: "world",
        config: true,
        type: String,
        default: "https://idu55qr85i.execute-api.us-east-1.amazonaws.com/prod",
        requiresReload: true
    });

    game.settings.register("lancer-npc-import", "v3ApiKey", {
        name: "V3 API Key",
        hint: "x-api-key header for the V3 API Gateway.",
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

    // Kept for the share-code-test diagnostic tool; not used in normal flow.
    game.settings.register("lancer-npc-import", "v2ShareApi", {
        name: "V2 Share API URL (diagnostic)",
        hint: "Hosts for the legacy share API. Comma-separated. Used only by Share Code Test.",
        scope: "world",
        config: false,
        type: String,
        default: "https://api.compcon.app/share,https://ujgatmvzlg.execute-api.us-east-1.amazonaws.com/prod/share"
    });

    game.settings.register("lancer-npc-import", "v2ShareApiKey", {
        name: "V2 Share API Key (diagnostic)",
        hint: "x-api-key header used by Share Code Test.",
        scope: "world",
        config: false,
        type: String,
        default: "fcFvjjrnQy2hypelJQi4X9dRI55r5KuI4bC07Maf"
    });

    // Comp/Con sign-in token storage. Hidden from the settings UI; manipulated
    // through the Sign In / Sign Out buttons in the NPC import dialog.
    game.settings.register("lancer-npc-import", COGNITO_SETTINGS_KEYS.email, {
        scope: "client", config: false, type: String, default: ""
    });
    game.settings.register("lancer-npc-import", COGNITO_SETTINGS_KEYS.idToken, {
        scope: "client", config: false, type: String, default: ""
    });
    game.settings.register("lancer-npc-import", COGNITO_SETTINGS_KEYS.refreshToken, {
        scope: "client", config: false, type: String, default: ""
    });
    game.settings.register("lancer-npc-import", COGNITO_SETTINGS_KEYS.expiry, {
        scope: "client", config: false, type: Number, default: 0
    });
    game.settings.register("lancer-npc-import", COGNITO_SETTINGS_KEYS.sub, {
        scope: "client", config: false, type: String, default: ""
    });

    game.settings.registerMenu("lancer-npc-import", "lcpDebugDiff", {
        name: "LCP Debug Diff",
        label: "Open LCP Diff Tool",
        hint: "Pick two LCPs and compare what each would import (no actual import is performed).",
        icon: "fas fa-not-equal",
        type: LcpDebugDiffMenu,
        restricted: true
    });

    game.settings.registerMenu("lancer-npc-import", "shareCodeTest", {
        name: "Share Code Test",
        label: "Open Share Code Test",
        hint: "Tests a v3 share code against each CORS proxy and shows the raw JSON response.",
        icon: "fas fa-vial",
        type: ShareCodeTestMenu,
        restricted: true
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

    game.settings.register("lancer-npc-import", "refreshItemPacks", {
        scope: "client",
        config: false,
        type: Array,
        default: []
    });

    game.settings.register("lancer-npc-import", "refreshActorPacks", {
        scope: "client",
        config: false,
        type: Array,
        default: []
    });

    // "__nofolder__" sentinel = world actors with no folder
    game.settings.register("lancer-npc-import", "refreshFolders", {
        scope: "client",
        config: false,
        type: Array,
        default: []
    });
});

Hooks.once('ready', async () => {
    if (game.system.id !== 'lancer')
        return;

    checkModuleUpdate('lancer-npc-import');
    patchPilotImportReserves();
    registerV3LcpShim();
    registerSnapshotApi();
});

Hooks.on('renderActorDirectory', (_app, html) => {
    if (game.system.id !== 'lancer')
        return;

    const headerActions = html.find('.header-actions.action-buttons');
    if (headerActions.length === 0)
        return;

    const importButton = $(`
        <button class="import-npc-button" title="Import pilots or NPCs from Comp/Con or JSON files">
            <i class="fas fa-file-import"></i> Import Actor
        </button>
    `);
    importButton.click(() => {
        ImportActor();
    });
    headerActions.append(importButton);

    const refreshButton = $(`
        <button class="refresh-actors-button" title="Refresh actor items from compendium LCPs">
            <i class="fas fa-sync"></i> Refresh actors
        </button>
    `);
    refreshButton.click(async () => {
        const dlg = await RefreshItemsDialog.forAllActors();
        if (dlg) dlg.render(true);
    });
    headerActions.append(refreshButton);
});

Hooks.on('getActorSheetHeaderButtons', (app, buttons) => {
    if (game.system.id !== 'lancer') return;
    const actor = app.actor;
    if (!isRefreshableActor(actor)) return;
    if (!actor.isOwner) return;
    buttons.unshift({
        class: 'lancer-refresh-items-btn',
        icon: 'fas fa-sync',
        label: 'Refresh',
        onclick: async () => {
            const dlg = await RefreshItemsDialog.forActor(actor);
            if (dlg) dlg.render(true);
        }
    });
});

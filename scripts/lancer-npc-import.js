import { checkModuleUpdate } from "./version-check.js";
import { registerV3LcpShim } from "./v3-lcp-shim.js";
import { registerSnapshotApi } from "./compendium-snapshot.js";
import { patchPilotImportReserves } from "./pilot-reserves-patch.js";
import { ActorImportDialog } from "./npc-import-ui.js";
import { LcpDebugDiffMenu } from "./lcp-debug-diff.js";
import { ShareCodeTestMenu } from "./share-code-test.js";
import { FixTokenSizesMenu } from "./fix-token-sizes.js";
import { RefreshItemsDialog } from "./refresh/refresh-ui.js";
import { isRefreshableActor } from "./refresh/refresh-core.js";
import { COGNITO_SETTINGS_KEYS } from "./auth/cognito-auth.js";
import { installV3CodeFetchPatch } from "./v3-api.js";
import { MODULE_ID } from "./utils.js";

export async function ImportActor()
{
    new ActorImportDialog().render(true);
}
export const ImportNPC = ImportActor;

Hooks.once('init', () =>
{
    if (game.system?.id === 'lancer')
        installV3CodeFetchPatch();

    game.settings.register(MODULE_ID, "defaultDownloadPortrait", {
        name: "Download portraits by default",
        hint: "Ticks Save portraits by default in the Comp/Con cloud dialog.",
        scope: "client",
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register(MODULE_ID, "portraitStoragePath", {
        name: "Portrait Storage Path",
        hint: "Folder inside this module's folder where portraits are saved.",
        scope: "world",
        config: true,
        type: String,
        default: "compcon_img"
    });

    // Endpoint overrides, editable without code release.
    game.settings.register(MODULE_ID, "v3ApiBase", {
        name: "V3 API Base URL",
        hint: "Comp/Con API gateway, no trailing slash. Matches what compcon.app itself uses.",
        scope: "world",
        config: true,
        type: String,
        default: "https://idu55qr85i.execute-api.us-east-1.amazonaws.com/prod",
        requiresReload: true
    });

    game.settings.register(MODULE_ID, "v3ApiKey", {
        name: "V3 API Key",
        hint: "x-api-key header for the Comp/Con API.",
        scope: "world",
        config: true,
        type: String,
        default: "Y5DnZ4miJi30iazqn9VV73A253Db7HRxamHEQeMr",
        requiresReload: true
    });

    game.settings.register(MODULE_ID, "v3Cdn", {
        name: "V3 CDN Base URL",
        hint: "CloudFront host for V3 item JSON, no trailing slash.",
        scope: "world",
        config: true,
        type: String,
        default: "https://ds69h3g1zxwgy.cloudfront.net",
        requiresReload: true
    });

    // Comp/Con sign-in storage, written by the Comp/Con Sign In dialog.
    game.settings.register(MODULE_ID, COGNITO_SETTINGS_KEYS.email, {
        scope: "client", config: false, type: String, default: ""
    });
    game.settings.register(MODULE_ID, COGNITO_SETTINGS_KEYS.idToken, {
        scope: "client", config: false, type: String, default: ""
    });
    game.settings.register(MODULE_ID, COGNITO_SETTINGS_KEYS.refreshToken, {
        scope: "client", config: false, type: String, default: ""
    });
    game.settings.register(MODULE_ID, COGNITO_SETTINGS_KEYS.expiry, {
        scope: "client", config: false, type: Number, default: 0
    });
    game.settings.register(MODULE_ID, COGNITO_SETTINGS_KEYS.sub, {
        scope: "client", config: false, type: String, default: ""
    });

    game.settings.registerMenu(MODULE_ID, "lcpDebugDiff", {
        name: "LCP Debug Diff",
        label: "Open LCP Diff Tool",
        hint: "Compares what two LCPs would import, without importing.",
        icon: "fas fa-not-equal",
        type: LcpDebugDiffMenu,
        restricted: true
    });

    game.settings.registerMenu(MODULE_ID, "shareCodeTest", {
        name: "Share Code Test",
        label: "Open Share Code Test",
        hint: "Tests a v3 share code against each CORS proxy and shows the raw JSON response.",
        icon: "fas fa-vial",
        type: ShareCodeTestMenu,
        restricted: true
    });

    game.settings.registerMenu(MODULE_ID, "fixTokenSizes", {
        name: "Fix Token Sizes",
        label: "Fix Token Sizes",
        hint: "Matches each prototype token size to the actor's Lancer size (manual sizes skipped, half-size becomes 1x1).",
        icon: "fas fa-expand",
        type: FixTokenSizesMenu,
        restricted: true
    });

    game.settings.register(MODULE_ID, "v3Debug", {
        name: "V3 debug logging",
        hint: "Logs V3 /code response, CDN payload, unwrap/normalize steps to console.",
        scope: "client",
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register(MODULE_ID, "lastNotifiedVersion", {
        name: "Last Notified Version",
        scope: "world",
        config: false,
        type: String,
        default: ""
    });

    game.settings.register(MODULE_ID, "refreshItemPacks", {
        scope: "client",
        config: false,
        type: Array,
        default: []
    });

    game.settings.register(MODULE_ID, "refreshActorPacks", {
        scope: "client",
        config: false,
        type: Array,
        default: []
    });

    // "__nofolder__" sentinel = world actors with no folder
    game.settings.register(MODULE_ID, "refreshFolders", {
        scope: "client",
        config: false,
        type: Array,
        default: []
    });
});

Hooks.once('ready', async () =>
{
    if (game.system.id !== 'lancer')
        return;

    checkModuleUpdate(MODULE_ID);
    patchPilotImportReserves();
    registerV3LcpShim();
    registerSnapshotApi();
});

Hooks.on('renderActorDirectory', (_app, htmlOrEl) =>
{
    if (game.system.id !== 'lancer')
        return;
    if (!game.user?.isGM)
        return;

    const html = htmlOrEl instanceof HTMLElement ? $(htmlOrEl) : htmlOrEl;
    const headerActions = html.find('.header-actions.action-buttons');
    if (headerActions.length === 0)
        return;

    const importButton = $(`
        <button class="import-npc-button" title="Import or export pilots and NPCs with Comp/Con, or import JSON files">
            <i class="fas fa-arrow-right-arrow-left"></i> Comp/Con Sync
        </button>
    `);
    importButton.click(() =>
    {
        ImportActor();
    });
    headerActions.append(importButton);

    const refreshButton = $(`
        <button class="refresh-actors-button" title="Refresh actor items from compendium LCPs">
            <i class="fas fa-sync"></i> Refresh actors
        </button>
    `);
    refreshButton.click(async () =>
    {
        const dialog = await RefreshItemsDialog.forAllActors();
        if (dialog)
            dialog.render(true);
    });
    headerActions.append(refreshButton);
});

Hooks.on('getActorSheetHeaderButtons', (app, buttons) =>
{
    if (game.system.id !== 'lancer')
        return;
    const actor = app.actor;
    if (!isRefreshableActor(actor))
        return;
    if (!actor.isOwner)
        return;
    buttons.unshift({
        class: 'lancer-refresh-items-btn',
        icon: 'fas fa-sync',
        label: 'Refresh',
        onclick: async () =>
        {
            const dialog = await RefreshItemsDialog.forActor(actor);
            if (dialog)
                dialog.render(true);
        }
    });
});

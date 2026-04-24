// ── Pilot sheet patch ────────────────────────────────────────────────────────
// Lancer's regex only matches 6-char v2 share codes. v3 uses 12-char codes,
// so we rebind the download button for 7+ char codes on each render.

import { getV2ShareApiPrimary, getV2ShareApiKey } from "./v3-api.js";
import { _importReserves, _importOrganizations, _refillResources } from "./pilot-reserves-patch.js";

export function installPilotSheetPatch() {
    Hooks.on('renderActorSheet', _onRenderPilotSheet);
    console.log("[V3] Pilot sheet hook installed");
}


export function _onRenderPilotSheet(app, html) {
    if (!game.settings.get("lancer-npc-import", "useV3Endpoint"))
        return;
    if (app.actor?.type !== 'pilot')
        return;
    if (!app.options.editable || !app.actor.isOwner)
        return;

    const pilot = app.actor;
    const cloudId = pilot.system.cloud_id;
    if (!cloudId)
        return;

    const download = html.find('.cloud-control[data-action*="download"]');
    if (!download.length)
        return;

    // v2 6-char codes already work with the original handler
    if (cloudId.length <= 6)
        return;
    if (!/^[A-Z0-9]{7,12}$/i.test(cloudId))
        return;

    // Rebind click for this v3 share code
    download.off('click').on('click', async (ev) => {
        ev.stopPropagation();
        ui.notifications.info("Importing character from v3 share code...");
        try {
            // Goes through our fetch interceptor -> v3 /code endpoint.
            // The interceptor already unwraps + normalizes the pilot data.
            const shareObj = await (await fetch(`${getV2ShareApiPrimary()}?code=${cloudId}`, {
                headers: { "x-api-key": getV2ShareApiKey() }
            })).json();
            const pilotData = await (await fetch(shareObj.presigned)).json();

            if (typeof app._onPilotJsonParsed === 'function') {
                await app._onPilotJsonParsed(JSON.stringify(pilotData));
            } else {
                console.error("[V3] _onPilotJsonParsed not found on pilot sheet");
                ui.notifications.error("Import failed: incompatible Lancer system version");
                return;
            }

            // Import reserves/orgs directly in case Lancer's share-code path
            // bypasses our _onPilotJsonParsed wrapper.
            if (pilotData?.reserves?.length > 0)
                await _importReserves(app.actor, pilotData.reserves);
            if (pilotData?.orgs?.length > 0)
                await _importOrganizations(app.actor, pilotData.orgs);
            await _refillResources(app.actor);
        } catch (error) {
            ui.notifications.error("Error importing from v3 share code: " + error.message);
            console.error("[V3] Share code import error:", error);
        }
    });

    console.log(`[V3] Pilot sheet patched for "${cloudId}"`);
}

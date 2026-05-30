// Tabbed cloud import dialog: Pilots | NPCs.

import { fetchNPCsViaV3API } from "./npc-import-compcon.js";
import { fetchPilotsViaV3API } from "./pilot-import-compcon.js";
import { buildNPCSelectionPanel } from "./npc-import-ui.js";
import { buildPilotSelectionPanel, importSelectedPilots } from "./pilot-import-ui.js";
import { importSelectedNPCs } from "./npc-import-core.js";
import { isLoggedIn } from "./auth/cognito-auth.js";
import { CompconLoginDialog } from "./auth/login-dialog.js";

async function _ensureLoggedIn()
{
    if (isLoggedIn())
        return true;
    return new Promise(resolve =>
    {
        new CompconLoginDialog(ok => resolve(!!ok)).render(true);
    });
}

function _loadingDialog(total)
{
    const dlg = new Dialog({
        title: "Loading Comp/Con",
        content: `
            <div style="text-align:center; padding: 20px;">
                <div style="font-size: 14px; font-weight: bold; letter-spacing: 2px; color: #222;">DOWNLOADING CLOUD DATA</div>
                <div style="margin: 15px 0;">
                    <div style="background: #ccc; border-radius: 4px; overflow: hidden; height: 20px;">
                        <div id="actor-load-bar" style="background: #991e2a; height: 100%; width: 0%; transition: width 0.2s;"></div>
                    </div>
                    <div id="actor-load-text" style="margin-top: 8px; color: #444;">Pilots 0 / ? · NPCs 0 / ?</div>
                </div>
            </div>
        `,
        buttons: {},
        close: () => {}
    }, {
        width: 380,
        classes: ["lancer-dialog-base", "lancer-no-title"]
    });
    dlg.render(true);

    const state = { p: 0, pTotal: total.pilots, n: 0, nTotal: total.npcs };
    const repaint = () =>
    {
        if (!dlg.element)
            return;
        const done = state.p + state.n;
        const tot = state.pTotal + state.nTotal;
        const pct = tot > 0 ? Math.round((done / tot) * 100) : 0;
        dlg.element.find("#actor-load-bar").css("width", pct + "%");
        dlg.element.find("#actor-load-text").text(`Pilots ${state.p} / ${state.pTotal} · NPCs ${state.n} / ${state.nTotal}`);
    };
    return {
        dialog: dlg,
        pilotProgress: (loaded, total) =>
        {
            state.p = loaded; if (total)
                state.pTotal = total; repaint();
        },
        npcProgress:   (loaded, total) =>
        {
            state.n = loaded; if (total)
                state.nTotal = total; repaint();
        },
        close: () => dlg.close()
    };
}

export class CloudActorImportDialog extends Dialog
{
    constructor(pilots, npcs)
    {
        const pilotPanel = buildPilotSelectionPanel(pilots);
        const npcPanel = buildNPCSelectionPanel(npcs);

        const content = `
            <div class="lancer-dialog-base cloud-actor-import">
                <div class="lancer-dialog-header">
                    <div class="lancer-dialog-title">COMP/CON IMPORT</div>
                    <div class="lancer-dialog-subtitle">${pilots.length} pilot(s) · ${npcs.length} NPC(s)</div>
                </div>
                <div class="cloud-import-tabs">
                    <button type="button" class="cloud-import-tab active" data-tab="pilots">
                        <i class="fas fa-user-astronaut"></i> Pilots <span class="cloud-tab-count">${pilots.length}</span>
                    </button>
                    <button type="button" class="cloud-import-tab" data-tab="npcs">
                        <i class="fas fa-robot"></i> NPCs <span class="cloud-tab-count">${npcs.length}</span>
                    </button>
                </div>
                <div class="cloud-import-tabbody" data-tab-body="pilots">${pilotPanel.html}</div>
                <div class="cloud-import-tabbody lancer-hidden" data-tab-body="npcs">${npcPanel.html}</div>
            </div>
        `;

        super({
            title: "Comp/Con Import",
            content,
            buttons: {
                import: {
                    icon: '<i class="fas fa-download"></i>',
                    label: "Import Selected",
                    callback: async (html) =>
                    {
                        const active = html.find(".cloud-import-tab.active").data("tab");
                        if (active === "pilots")
                        {
                            const $body = html.find(".cloud-import-tabbody[data-tab-body='pilots']");
                            const selected = pilotPanel.getSelected($body);
                            if (selected.length === 0)
                            {
                                ui.notifications.warn("No pilots selected");
                                return;
                            }
                            const { updateExisting } = pilotPanel.getOptions($body);
                            await importSelectedPilots(selected, updateExisting);
                        }
                        else
                        {
                            const $body = html.find(".cloud-import-tabbody[data-tab-body='npcs']");
                            const selected = npcPanel.getSelected($body);
                            if (selected.length === 0)
                            {
                                ui.notifications.warn("No NPCs selected");
                                return;
                            }
                            const o = npcPanel.getOptions($body);
                            await importSelectedNPCs(selected, o.updateExisting, o.customTierMode, o.manualReplace, o.downloadPortraits);
                        }
                    }
                },
                cancel: { icon: '<i class="fas fa-times"></i>', label: "Close" }
            },
            default: "import"
        }, {
            width: 900,
            height: "auto",
            classes: ["cloud-actor-import-dialog", "lancer-dialog-base", "lancer-no-title"]
        });

        this._pilotPanel = pilotPanel;
        this._npcPanel = npcPanel;
        this._pilots = pilots;
        this._npcs = npcs;
    }

    activateListeners(html)
    {
        super.activateListeners(html);

        const $pilotBody = html.find(".cloud-import-tabbody[data-tab-body='pilots']");
        const $npcBody = html.find(".cloud-import-tabbody[data-tab-body='npcs']");
        this._pilotPanel.activate($pilotBody);
        this._npcPanel.activate($npcBody, {
            onRefresh: () =>
            {
                // re-render the dialog so badges update after a Link Actors action
                this.close();
                new CloudActorImportDialog(this._pilots, this._npcs).render(true);
            }
        });

        const self = this;
        html.find(".cloud-import-tab").on("click", function()
        {
            const tab = $(this).data("tab");
            html.find(".cloud-import-tab").removeClass("active");
            $(this).addClass("active");
            html.find(".cloud-import-tabbody").addClass("lancer-hidden");
            html.find(`.cloud-import-tabbody[data-tab-body='${tab}']`).removeClass("lancer-hidden");
            // Foundry Dialog doesn't reflow on content swap; force a height recompute.
            self.setPosition({ height: "auto", left: self.position.left, top: self.position.top });
        });
    }
}

export async function openCloudActorImport()
{
    const signedIn = await _ensureLoggedIn();
    if (!signedIn)
        return;

    const loader = _loadingDialog({ pilots: 0, npcs: 0 });
    try
    {
        const [pilots, npcs] = await Promise.all([
            fetchPilotsViaV3API((loaded, total) => loader.pilotProgress(loaded, total)),
            fetchNPCsViaV3API((loaded, total) => loader.npcProgress(loaded, total))
        ]);
        loader.close();
        if (pilots.length === 0 && npcs.length === 0)
        {
            ui.notifications.warn("No pilots or NPCs found in Comp/Con cloud");
            return;
        }
        new CloudActorImportDialog(pilots, npcs).render(true);
    }
    catch (e)
    {
        loader.close();
        if (e.message === "NOT_LOGGED_IN")
        {
            ui.notifications.warn("Sign in to Comp/Con to browse cloud actors.");
            return;
        }
        console.error("Cloud actor import failed:", e);
        ui.notifications.error(`Error: ${e.message}`);
    }
}

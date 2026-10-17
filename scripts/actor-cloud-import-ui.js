// Comp/Con cloud dialog: Pilots | NPCs tabs, Import | Export modes.

import { fetchNPCsViaV3API } from "./npc-import-compcon.js";
import { fetchPilotsViaV3API } from "./pilot-import-compcon.js";
import { buildNPCSelectionPanel } from "./npc-import-ui.js";
import { buildPilotSelectionPanel } from "./pilot-import-ui.js";
import { importSelectedNPCs } from "./npc-import-core.js";
import { collectKnownLids, importSelectedPilots } from "./pilot-import-core.js";
import { isLoggedIn } from "./auth/cognito-auth.js";
import { CompconLoginDialog } from "./auth/login-dialog.js";
import { exportSelectedPilots, exportSelectedNPCs } from "./export/export-run.js";
import { fetchCloudItems } from "./v3-api.js";
import { SyncLog, LogDrawer } from "./sync-log.js";

function _railHtml(mode)
{
    const cloud = `<i class="fas fa-cloud"></i> COMP/CON`;
    const foundry = `<i class="fas fa-dice-d20"></i> FOUNDRY`;
    const exporting = mode === "export";
    return `
        <span class="cc-rail-src cc-rail-${mode}">${exporting ? foundry : cloud} <b>TRUTH</b></span>
        <span class="cc-rail-arrow"><span class="cc-rail-line"></span><i class="fas fa-chevron-right"></i></span>
        <span class="cc-rail-dst">${exporting ? cloud : foundry} <b>UPDATED</b></span>`;
}

async function _ensureLoggedIn()
{
    if (isLoggedIn())
        return true;
    return new Promise(resolve =>
    {
        new CompconLoginDialog(ok => resolve(!!ok)).render(true);
    });
}

function _loadingDialog()
{
    const dialog = new Dialog({
        title: "Loading Comp/Con",
        content: `
            <div style="text-align:center; padding: 20px;">
                <div style="font-size: 14px; font-weight: bold; letter-spacing: 2px; color: var(--la-ink);">DOWNLOADING CLOUD DATA</div>
                <div style="margin: 15px 0;">
                    <div style="background: #ccc; border-radius: 4px; overflow: hidden; height: 20px;">
                        <div id="actor-load-bar" style="background: #991e2a; height: 100%; width: 0%; transition: width 0.2s;"></div>
                    </div>
                    <div id="actor-load-text" style="margin-top: 8px; color: var(--la-ink-dim);">Pilots 0 / ? · NPCs 0 / ?</div>
                </div>
            </div>
        `,
        buttons: {},
        close: () => {}
    }, {
        width: 380,
        classes: ["lancer-dialog-base", "lancer-no-title"]
    });
    dialog.render(true);

    const state = { pilots: 0, pilotTotal: 0, npcs: 0, npcTotal: 0 };
    const repaint = () =>
    {
        if (!dialog.element)
            return;
        const done = state.pilots + state.npcs;
        const grandTotal = state.pilotTotal + state.npcTotal;
        const percent = grandTotal > 0 ? Math.round((done / grandTotal) * 100) : 0;
        dialog.element.find("#actor-load-bar").css("width", percent + "%");
        dialog.element.find("#actor-load-text").text(`Pilots ${state.pilots} / ${state.pilotTotal} · NPCs ${state.npcs} / ${state.npcTotal}`);
    };
    return {
        pilotProgress: (loaded, loadedTotal) =>
        {
            state.pilots = loaded;
            if (loadedTotal)
                state.pilotTotal = loadedTotal;
            repaint();
        },
        npcProgress: (loaded, loadedTotal) =>
        {
            state.npcs = loaded;
            if (loadedTotal)
                state.npcTotal = loadedTotal;
            repaint();
        },
        close: () => dialog.close()
    };
}

class CloudActorImportDialog extends Dialog
{
    constructor(pilots, npcs, knownLids = null)
    {
        const pilotPanel = buildPilotSelectionPanel(pilots, knownLids);
        const npcPanel = buildNPCSelectionPanel(npcs, knownLids);

        const content = `
            <div class="lancer-dialog-base cloud-actor-import">
                <div class="lancer-dialog-header cc-sync-head">
                    <div class="cc-sync-titles">
                        <div class="lancer-dialog-title">COMP/CON IMPORT</div>
                        <div class="lancer-dialog-subtitle">${pilots.length} pilot(s) · ${npcs.length} NPC(s)</div>
                    </div>
                    <div class="cc-rail">${_railHtml("import")}</div>
                </div>
                <div class="cloud-import-tabs">
                    <button type="button" class="cloud-import-tab active" data-tab="pilots">
                        <i class="fas fa-user-astronaut"></i> Pilots <span class="cloud-tab-count">${pilots.length}</span>
                    </button>
                    <button type="button" class="cloud-import-tab" data-tab="npcs">
                        <i class="fas fa-robot"></i> NPCs <span class="cloud-tab-count">${npcs.length}</span>
                    </button>
                    <div class="cc-sync-mode">
                        <button type="button" class="active" data-mode="import"><i class="fas fa-download"></i> Import</button>
                        <button type="button" data-mode="export"><i class="fas fa-upload"></i> Export</button>
                    </div>
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
                    callback: () => this._runSelected()
                }
            },
            default: "import"
        }, {
            width: 900,
            height: "auto",
            classes: ["cloud-actor-import-dialog", "lancer-dialog-base", "lancer-no-title"]
        });

        this._mode = "import";
        this._pilotPanel = pilotPanel;
        this._npcPanel = npcPanel;
        this._running = false;
        this._drawer = new LogDrawer(this);
    }

    _onKeyDown(event)
    {
        if (event.key === "Enter" && !event.target?.closest?.(".dialog-button"))
            return;
        return super._onKeyDown(event);
    }

    _getHeaderButtons()
    {
        return [
            { label: "Log", class: "cc-log-toggle", icon: "fas fa-list", onclick: () => this._drawer.toggle() },
            ...super._getHeaderButtons()
        ];
    }

    submit(button)
    {
        if (this._running || typeof button?.callback !== "function")
            return;
        button.callback();
    }

    async close(options = {})
    {
        if (this._running)
        {
            ui.notifications.warn("Wait for the sync to finish.");
            return;
        }
        this._drawer.destroy();
        return super.close(options);
    }

    async _runSelected()
    {
        const pilotsTab = this.element.find(".cloud-import-tab.active").data("tab") === "pilots";
        const exporting = this._mode === "export";
        const panel = pilotsTab ? this._pilotPanel : this._npcPanel;
        const selected = panel.getSelected();
        if (selected.length === 0)
        {
            ui.notifications.warn(pilotsTab ? "No pilots selected" : "No NPCs selected");
            return;
        }
        const log = new SyncLog(exporting ? "Export log" : "Import log", exporting ? "Foundry → Comp/Con" : "Comp/Con → Foundry");
        const unsubscribe = log.subscribe((_log, index) =>
        {
            const positions = index >= 0 ? [index] : [...selected.keys()];
            for (const position of positions)
                panel.setRunState(selected[position], log.entries[position]?.status);
            this._showProgress(log, exporting);
        });
        this._running = true;
        this.element.find(".cloud-actor-import").addClass("cc-locked");
        this._drawer.attach(log);
        this._drawer.show();
        let results = [];
        try
        {
            if (pilotsTab)
                results = exporting ? await exportSelectedPilots(selected, log) : await importSelectedPilots(selected, panel.getOptions().updateExisting, log);
            else
                results = exporting ? await exportSelectedNPCs(selected, log) : await importSelectedNPCs(selected, panel.getOptions(), log);
        }
        catch (error)
        {
            console.error("lancer-npc-import | sync run failed", error);
            ui.notifications.error(error.message);
        }
        finally
        {
            unsubscribe();
            this._running = false;
            this.element?.find(".cloud-actor-import").removeClass("cc-locked");
            panel.refresh(selected, results);
            selected.forEach((item, position) =>
            {
                const status = log.entries[position]?.status;
                if (status === "fail" || status === "warn")
                    panel.setRunState(item, status);
            });
            this._updateCounts();
        }
    }

    _showProgress(log, exporting)
    {
        const { done, total, percent } = log.progress;
        this.element?.find(".dialog-button[data-button='import']")
            .prop("disabled", true)
            .addClass("cc-running")
            .html(`<span class="cc-fill" style="width: ${percent}%"></span><i class="fas ${exporting ? "fa-upload" : "fa-download"}"></i> ${exporting ? "Exporting" : "Importing"} ${done} / ${total}…`);
    }

    _updateCounts()
    {
        const html = this.element;
        if (!html)
            return;
        const pilotCount = this._pilotPanel.size();
        const npcCount = this._npcPanel.size();
        html.find(".cc-sync-head .lancer-dialog-subtitle").text(`${pilotCount} pilot(s) · ${npcCount} NPC(s)`);
        html.find(".cloud-import-tab[data-tab='pilots'] .cloud-tab-count").text(pilotCount);
        html.find(".cloud-import-tab[data-tab='npcs'] .cloud-tab-count").text(npcCount);
    }

    activateListeners(html)
    {
        super.activateListeners(html);

        const $pilotBody = html.find(".cloud-import-tabbody[data-tab-body='pilots']");
        const $npcBody = html.find(".cloud-import-tabbody[data-tab-body='npcs']");
        const $importButton = html.find(".dialog-button[data-button='import']");
        const setImportLabel = () =>
        {
            if (this._running)
                return;
            const pilotsTab = html.find(".cloud-import-tab.active").data("tab") === "pilots";
            const exporting = this._mode === "export";
            const info = pilotsTab ? this._pilotPanel.summary() : this._npcPanel.summary();
            const verb = exporting ? "Export" : "Import";
            const label = info.count ? `${verb} ${info.label}` : `Select ${pilotsTab ? "pilots" : "NPCs"} to ${verb.toLowerCase()}`;
            $importButton.removeClass("cc-running").html(`<i class="fas ${exporting ? "fa-upload" : "fa-download"}"></i> ${label}`).prop("disabled", !info.count);
        };
        this._pilotPanel.activate($pilotBody, { onChange: setImportLabel });
        this._npcPanel.activate($npcBody, { onChange: setImportLabel });

        const self = this;
        html.find(".cloud-import-tab").on("click", function()
        {
            const tab = $(this).data("tab");
            html.find(".cloud-import-tab").removeClass("active");
            $(this).addClass("active");
            html.find(".cloud-import-tabbody").addClass("lancer-hidden");
            html.find(`.cloud-import-tabbody[data-tab-body='${tab}']`).removeClass("lancer-hidden");
            setImportLabel();
            // Foundry Dialog doesn't reflow on content swap; force a height recompute.
            self.setPosition({ height: "auto", left: self.position.left, top: self.position.top });
        });

        html.find(".cc-sync-mode button").on("click", function()
        {
            const mode = $(this).data("mode");
            if (mode === self._mode || self._running)
                return;
            self._mode = mode;
            html.find(".cc-sync-mode button").removeClass("active");
            $(this).addClass("active");
            self._pilotPanel.setMode(mode);
            self._npcPanel.setMode(mode);
            html.find(".cc-sync-head .lancer-dialog-title").text(mode === "export" ? "COMP/CON EXPORT" : "COMP/CON IMPORT");
            html.find(".cc-sync-head .cc-rail").html(_railHtml(mode));
            self._updateCounts();
            setImportLabel();
            self.setPosition({ height: "auto", left: self.position.left, top: self.position.top });
        });
    }
}

export async function openCloudActorImport()
{
    const signedIn = await _ensureLoggedIn();
    if (!signedIn)
        return;

    const loader = _loadingDialog();
    try
    {
        const cloudItems = fetchCloudItems();
        const [pilots, npcs, knownLids] = await Promise.all([
            fetchPilotsViaV3API(loader.pilotProgress, cloudItems),
            fetchNPCsViaV3API(loader.npcProgress, cloudItems),
            collectKnownLids().catch(error =>
            {
                console.warn("lancer-npc-import | could not index compendium LIDs", error);
                return null;
            })
        ]);
        loader.close();
        if (pilots.length === 0 && npcs.length === 0)
        {
            ui.notifications.warn("No pilots or NPCs found in Comp/Con cloud");
            return;
        }
        new CloudActorImportDialog(pilots, npcs, knownLids).render(true);
    }
    catch (error)
    {
        loader.close();
        if (error.message === "NOT_LOGGED_IN")
        {
            ui.notifications.warn("Sign in to Comp/Con to browse cloud actors.");
            return;
        }
        console.error("lancer-npc-import | Cloud actor import failed:", error);
        ui.notifications.error(`Error: ${error.message}`);
    }
}

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
});

class NPCImportDialog extends Dialog {
    constructor() {
        super({
            title: "NPC Import",
            content: `
                <style>
                    .lancer-item-icon {
                        font-size: 32px;
                    }
                    .lancer-item-name {
                        font-size: 15px;
                    }
                </style>
                <div class="lancer-dialog-base">
                    <div class="lancer-dialog-header">
                        <div class="lancer-dialog-title">NPC IMPORT // SOURCE SELECTION</div>
                        <div class="lancer-dialog-subtitle">Choose your import method</div>
                    </div>
                    <div class="lancer-items-grid">
                        <div class="lancer-item-card" data-action="files">
                            <div class="lancer-item-icon"><i class="fas fa-file-upload"></i></div>
                            <div class="lancer-item-content">
                                <div class="lancer-item-name">Import from JSON File(s)</div>
                                <div class="lancer-item-details">Always creates new NPCs</div>
                            </div>
                        </div>
                        <div class="lancer-item-card" data-action="compcon">
                            <div class="lancer-item-icon"><i class="fas fa-cloud-download-alt"></i></div>
                            <div class="lancer-item-content">
                                <div class="lancer-item-name">Import from Comp/Con</div>
                                <div class="lancer-item-details">Can update existing NPCs</div>
                            </div>
                        </div>
                    </div>
                    <div class="lancer-info-box">
                        <i class="fas fa-info-circle"></i>
                        <span><strong>Note:</strong> Custom tier NPCs will have their class modified with custom stats. Choose scaling mode when importing.</span>
                    </div>
                </div>
            `,
            buttons: {},
            default: null,
            close: () => {}
        }, {
            width: 450,
            height: "auto"
        });
    }

    activateListeners(html) {
        super.activateListeners(html);

        html.find('.lancer-item-card').click(async (event) => {
            const action = $(event.currentTarget).data('action');
            this.close();

            if (action === 'files') {
                await importFromFiles();
            } else if (action === 'compcon') {
                await importFromCompCon();
            }
        });
    }
}

class ImportProgressDialog {
    constructor(totalCount) {
        this.totalCount = totalCount;
        this.currentCount = 0;
        this.logs = [];
        this.dialog = null;
        this.closeButton = null;
    }

    render(force = false) {
        const progress = Math.round((this.currentCount / this.totalCount) * 100);

        const content = `
            <style>
                .import-progress-container {
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    height: 100%;       /* Prend toute la hauteur du parent (.dialog-content) */
                    overflow: hidden;   /* Empêche le scroll sur le conteneur global */
                }
                .import-progress-bar-container {
                    width: 100%;
                    background: #1a1a1a;
                    border: 2px solid #991e2a;
                    border-radius: 5px;
                    overflow: hidden;
                    height: 35px;
                    min-height: 35px;   /* Fixe la hauteur */
                    position: relative;
                    box-shadow: inset 0 2px 4px rgba(0,0,0,0.5);
                    flex-shrink: 0;     /* Ne jamais rétrécir la barre */
                }
                .import-progress-bar {
                    height: 100%;
                    background: linear-gradient(90deg, #991e2a, #d32f2f);
                    transition: width 0.3s ease;
                    box-shadow: 0 0 10px rgba(153, 30, 42, 0.5);
                }
                .import-progress-text {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: bold;
                    font-size: 14px;
                    color: #fff;
                    text-shadow: 0 0 8px rgba(0,0,0,1), 1px 1px 2px rgba(0,0,0,1);
                    z-index: 1;
                }
                .import-log-container {
                    background: #1a1a1a;
                    border: 1px solid #444;
                    border-radius: 3px;
                    padding: 10px;
                    overflow-y: auto;       /* Scroll uniquement ici */
                    overflow-x: hidden;
                    font-family: 'Courier New', monospace;
                    font-size: 13px;
                    line-height: 1.5;
                    flex: 1;                /* C'EST LA CLÉ : prend tout l'espace restant */
                    min-height: 0;          /* Nécessaire pour que le scroll fonctionne dans un flex */
                }
                .import-log-entry {
                    padding: 4px 0;
                    border-bottom: 1px solid #2a2a2a;
                }
                .import-log-entry:last-child {
                    border-bottom: none;
                }
                .import-log-entry.info { color: #e0e0e0; }
                .import-log-entry.success { color: #66bb6a; font-weight: 500; }
                .import-log-entry.warning { color: #ffa726; }
                .import-log-entry.error { color: #ef5350; font-weight: 500; }
                .import-log-timestamp {
                    color: #888;
                    margin-right: 10px;
                    font-weight: normal;
                }
            </style>
            <div class="import-progress-container">
                <div class="import-progress-bar-container">
                    <div class="import-progress-bar" style="width: ${progress}%"></div>
                    <div class="import-progress-text">${this.currentCount} / ${this.totalCount} NPCs (${progress}%)</div>
                </div>
                <div class="import-log-container" id="import-log">
                    ${this.logs.map(log => `
                        <div class="import-log-entry ${log.type}">
                            <span class="import-log-timestamp">[${log.time}]</span>
                            <span>${log.message}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;

        const buttons = this.currentCount >= this.totalCount ? {
            close: {
                icon: '<i class="fas fa-check"></i>',
                label: "Close",
                callback: () => this.close()
            }
        } : {};

        if (!this.dialog) {
            this.dialog = new Dialog({
                title: "NPC Import Progress",
                content: content,
                buttons: buttons,
                close: () => { this.dialog = null; }
            }, {
                width: 600,
                height: 500, // Hauteur fixe
                resizable: true,
                classes: ["lancer-import-progress-dialog"]
            });
            this.dialog.render(true);

            // Corrige le "vide gris" avec flexbox
            setTimeout(() => {
                if (this.dialog.element) {
                    const style = document.createElement('style');
                    style.textContent = `
                        /* Force la fenêtre à utiliser Flexbox vertical */
                        .lancer-import-progress-dialog .window-content {
                            display: flex !important;
                            flex-direction: column !important;
                            height: 100% !important;
                            overflow: hidden !important;
                            padding: 0 !important;
                        }
                        
                        /* Force le contenu de la dialog à s'étendre */
                        .lancer-import-progress-dialog .dialog-content {
                            flex: 1 !important; /* Prend tout l'espace disponible */
                            display: flex !important;
                            flex-direction: column !important;
                            min-height: 0 !important; /* Important pour le scroll interne */
                            padding: 12px !important;
                            overflow: hidden !important; /* Laisse le scroll à .import-log-container */
                        }
                        
                        /* Garde les boutons en bas sans qu'ils ne s'étirent */
                        .lancer-import-progress-dialog .dialog-buttons {
                            flex: 0 0 auto !important;
                            background: rgba(0,0,0,0.1);
                            border-top: 1px solid #333;
                            padding: 10px !important;
                            z-index: 10;
                        }
                    `;
                    this.dialog.element[0].appendChild(style);
                }
            }, 10);
        } else {
            if (this.dialog.element) {
                const contentDiv = this.dialog.element.find('.dialog-content')[0];
                if (contentDiv) {
                    const logContainer = this.dialog.element.find('#import-log')[0];
                    const wasAtBottom = logContainer ? (logContainer.scrollHeight - logContainer.scrollTop === logContainer.clientHeight) : true;
                    
                    contentDiv.innerHTML = content;

                    if (wasAtBottom) {
                        setTimeout(() => {
                            const newLogContainer = this.dialog.element.find('#import-log')[0];
                            if (newLogContainer) {
                                newLogContainer.scrollTop = newLogContainer.scrollHeight;
                            }
                        }, 0);
                    }
                }

                if (this.currentCount >= this.totalCount && !this.closeButton) {
                    const buttonDiv = this.dialog.element.find('.dialog-buttons')[0];
                    if (buttonDiv) {
                        buttonDiv.innerHTML = `
                            <button class="dialog-button" data-button="close">
                                <i class="fas fa-check"></i> Close
                            </button>
                        `;
                        this.dialog.element.find('button[data-button="close"]').click(() => this.close());
                        this.closeButton = true;
                    }
                }
            }
        }
    }

    addLog(message, type = 'info') {
        const now = new Date();
        const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
        this.logs.push({ message, type, time });
        this.render(false);
    }

    incrementProgress() {
        this.currentCount++;
        this.render(false);
    }

    close() {
        if (this.dialog) {
            this.dialog.close();
            this.dialog = null;
        }
    }
}

async function importFromFiles() {
    let updateExisting = true;
    let manualReplace = false;

    const scalingDialog = new Dialog({
        title: "Import Options",
        content: `
            <div class="lancer-dialog-base">
                <div class="lancer-dialog-header">
                    <div class="lancer-dialog-title">FILE IMPORT // OPTIONS</div>
                    <div class="lancer-dialog-subtitle">Choose import and scaling options</div>
                </div>
                <div style="margin-bottom: 15px;">
                    <div class="lancer-toggle-card active" data-setting="update-existing" id="update-existing-card">
                        <div class="lancer-toggle-card-icon"><i class="fas fa-check"></i></div>
                        <div class="lancer-toggle-card-text">Update existing NPCs (keep token image & settings)</div>
                        <input type="hidden" id="update-existing-files" value="true">
                    </div>
                    <div class="lancer-toggle-card" data-setting="manual-replace" id="manual-replace-card">
                        <div class="lancer-toggle-card-icon"><i class="fas fa-times"></i></div>
                        <div class="lancer-toggle-card-text">Manual replace mode (choose target actor for each NPC)</div>
                        <input type="hidden" id="manual-replace-files" value="false">
                    </div>
                </div>
                <div class="lancer-section-title">Custom Tier Scaling Mode:</div>
                <div class="lancer-scaling-cards" style="margin-bottom: 20px;">
                    <div class="lancer-scaling-card selected" data-mode="scaled">
                        <div class="lancer-scaling-card-icon"><i class="cci cci-accuracy"></i></div>
                        <div class="lancer-scaling-card-name">Scaled</div>
                        <div class="lancer-scaling-card-desc">Keep tier increments</div>
                    </div>
                    <div class="lancer-scaling-card" data-mode="flat">
                        <div class="lancer-scaling-card-icon"><i class="cci cci-difficulty"></i></div>
                        <div class="lancer-scaling-card-name">Flat</div>
                        <div class="lancer-scaling-card-desc">Same stats all tiers</div>
                    </div>
                </div>
                <input type="hidden" id="custom-tier-mode" value="scaled">
            </div>
        `,
        buttons: {
            import: {
                icon: '<i class="fas fa-file-upload"></i>',
                label: "Select Files",
                callback: async (html) => {
                    updateExisting = html.find('#update-existing-files').val() === 'true';
                    manualReplace = html.find('#manual-replace-files').val() === 'true';
                    const customTierMode = html.find('#custom-tier-mode').val();
                    await selectAndImportFiles(customTierMode, updateExisting, manualReplace);
                }
            },
            cancel: {
                icon: '<i class="fas fa-times"></i>',
                label: "Cancel"
            }
        },
        default: "import",
        render: (html) => {
            const dialogElem = html.closest('.dialog');
            const buttons = dialogElem.find('.dialog-buttons');
            buttons.css({
                'height': 'auto',
                'min-height': '50px',
                'flex': '0 0 auto'
            });
            buttons.find('button').css({
                'height': 'auto',
                'padding': '8px 16px',
                'line-height': 'normal'
            });

            html.find('.lancer-toggle-card').click(function() {
                const setting = $(this).data('setting');
                const isActive = $(this).hasClass('active');

                if (setting === 'update-existing' || setting === 'manual-replace') {
                    const otherCard = setting === 'update-existing' ? '#manual-replace-card' : '#update-existing-card';

                    $(this).toggleClass('active');
                    const icon = $(this).find('.lancer-toggle-card-icon i');
                    const hiddenInput = $(this).find('input[type="hidden"]');

                    if (isActive) {
                        icon.removeClass('fa-check').addClass('fa-times');
                        hiddenInput.val('false');
                    } else {
                        icon.removeClass('fa-times').addClass('fa-check');
                        hiddenInput.val('true');

                        html.find(otherCard).removeClass('active');
                        html.find(otherCard).find('.lancer-toggle-card-icon i').removeClass('fa-check').addClass('fa-times');
                        html.find(otherCard).find('input[type="hidden"]').val('false');
                    }
                }
            });

            html.find('.lancer-scaling-card').click(function() {
                html.find('.lancer-scaling-card').removeClass('selected');
                $(this).addClass('selected');
                const mode = $(this).data('mode');
                html.find('#custom-tier-mode').val(mode);
            });
        }
    });

    scalingDialog.render(true);
}

// Dialog pour mapper manuellement les NPCs à des acteurs existants
async function selectActorMappings(npcsToImport) {
    return new Promise((resolve) => {
        const allActors = game.actors.filter(a => a.type === 'npc');

        const actorOptions = `<option value="new">── Create New ──</option>
            ${allActors.map(actor => `<option value="${actor.id}">${actor.name}  (${actor.system.class.name ? actor.system.class.name : 'Unknown'})-(${actor.system.tier ? 'T' + actor.system.tier : 'Unknown'})</option>`).join('')}`;

        const content = `
            <style>
                .lancer-dialog-base {
                    display: flex;
                    flex-direction: column;
                    height: 100%;
                    overflow: hidden;
                }
                
                .lancer-dialog-header {
                    flex: 0 0 auto;
                    margin-bottom: 10px;
                    padding-right: 5px;
                }

                .mapping-list {
                    flex: 1;
                    overflow-y: auto;
                    overflow-x: hidden;
                    padding-right: 5px;
                    padding-bottom: 5px;
                    scrollbar-width: thin;
                    scrollbar-color: #991e2a #1a1a1a;
                }
                
                .mapping-list::-webkit-scrollbar { width: 8px; }
                .mapping-list::-webkit-scrollbar-track { background: #1a1a1a; }
                .mapping-list::-webkit-scrollbar-thumb { background-color: #991e2a; border-radius: 4px; }

                .mapping-item {
                    padding: 12px;
                    margin-bottom: 10px;
                    background: rgba(0,0,0,0.2);
                    border-radius: 3px;
                    border-left: 3px solid #991e2a;
                }
                .mapping-item-header {
                    font-weight: bold;
                    margin-bottom: 8px;
                    color: #fff;
                    font-size: 14px;
                }
                .mapping-item-controls {
                    display: grid;
                    gap: 8px;
                }
                .mapping-item select {
                    width: 100%;
                    padding: 6px;
                    font-size: 13px;
                    background: #f0f0f0;
                    color: #000;
                    border: 1px solid #ccc;
                    border-radius: 3px;
                }
                .mapping-item select option {
                    color: #000;
                    background: #fff;
                }
                .mapping-item .keep-name-toggle {
                    display: none;
                    padding: 6px 10px;
                    background: rgba(0,0,0,0.2);
                    border-radius: 3px;
                    cursor: pointer;
                    font-size: 12px;
                    border: 1px solid rgba(255,255,255,0.1);
                    color: #fff;
                }
                .mapping-item .keep-name-toggle.visible {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .mapping-item .keep-name-toggle.active {
                    background: rgba(153, 30, 42, 0.3);
                    border-color: #991e2a;
                }
            </style>
            <div class="lancer-dialog-base">
                <div class="lancer-dialog-header">
                    <div class="lancer-dialog-title">MANUAL REPLACE // TARGET MAPPING</div>
                    <div class="lancer-dialog-subtitle">Choose target actors for ${npcsToImport.length} NPC(s)</div>
                </div>
                <div class="mapping-list">
                    ${npcsToImport.map((npc, index) => `
                        <div class="mapping-item" data-index="${index}">
                            <div class="mapping-item-header">${npc.name}</div>
                            <div class="mapping-item-controls">
                                <select class="target-select" data-index="${index}">
                                    ${actorOptions}
                                </select>
                                <div class="keep-name-toggle" data-index="${index}">
                                    <i class="fas fa-times"></i>
                                    <span>Keep existing actor name</span>
                                </div>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;

        const dialog = new Dialog({
            title: "Map Target Actors",
            content: content,
            buttons: {
                import: {
                    icon: '<i class="fas fa-download"></i>',
                    label: "Import All",
                    callback: (html) => {
                        const mappings = [];
                        npcsToImport.forEach((npc, index) => {
                            const selectedValue = html.find(`.target-select[data-index="${index}"]`).val();
                            const keepName = html.find(`.keep-name-toggle[data-index="${index}"]`).hasClass('active');

                            if (selectedValue === 'new') {
                                mappings.push({ npc, targetActor: null, keepName: false });
                            } else {
                                const targetActor = game.actors.get(selectedValue);
                                mappings.push({ npc, targetActor, keepName });
                            }
                        });
                        resolve(mappings);
                    }
                },
                cancel: {
                    icon: '<i class="fas fa-times"></i>',
                    label: "Cancel",
                    callback: () => resolve(null)
                }
            },
            default: "import",
            render: (html) => {
                const win = html.closest('.window-app');
                
                win.find('.window-content').css({
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    height: '100%',
                    padding: '0'
                });

                win.find('.dialog-content').css({
                    flex: '1',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden',
                    minHeight: '0',
                    padding: '10px'
                });

                win.find('.dialog-buttons').css({
                    flex: '0 0 auto',
                    zIndex: '10',
                    background: 'rgba(0,0,0,0.2)'
                });

                const buttons = win.find('.dialog-buttons');
                buttons.css({
                    height: 'auto',
                    minHeight: '50px'
                });

                html.find('.target-select').on('change', function() {
                    const index = $(this).data('index');
                    const selectedValue = $(this).val();
                    const keepNameToggle = html.find(`.keep-name-toggle[data-index="${index}"]`);

                    if (selectedValue === 'new') {
                        keepNameToggle.removeClass('visible active');
                        keepNameToggle.find('i').removeClass('fa-check').addClass('fa-times');
                    } else {
                        keepNameToggle.addClass('visible');
                    }
                });

                html.find('.keep-name-toggle').click(function() {
                    const isActive = $(this).hasClass('active');
                    $(this).toggleClass('active');

                    const icon = $(this).find('i');
                    if (isActive) {
                        icon.removeClass('fa-check').addClass('fa-times');
                    } else {
                        icon.removeClass('fa-times').addClass('fa-check');
                    }
                });
            }
        }, {
            width: 600,
            height: 600,
            classes: ["mapping-dialog"],
            resizable: true
        });

        dialog.render(true);
    });
}

async function selectAndImportFiles(customTierMode, updateExisting = true, manualReplace = false) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.multiple = true;

    input.onchange = async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;

        const npcsToImport = [];
        for (const file of files) {
            try {
                const text = await file.text();
                const npcData = JSON.parse(text);

                if (!npcData.class || !npcData.name) {
                    ui.notifications.error(`Invalid NPC JSON: ${file.name} - missing required fields`);
                    continue;
                }

                npcsToImport.push(npcData);
            } catch (error) {
                console.error(`Error parsing ${file.name}:`, error);
                ui.notifications.error(`Failed to parse ${file.name}: ${error.message}`);
            }
        }

        if (npcsToImport.length === 0) {
            ui.notifications.warn("No valid NPCs to import");
            return;
        }

        let mappings = null;
        if (manualReplace) {
            mappings = await selectActorMappings(npcsToImport);

            if (mappings === null) {
                ui.notifications.info("Import cancelled");
                return;
            }
        }

        const progressDialog = new ImportProgressDialog(npcsToImport.length);
        progressDialog.render(true);
        progressDialog.addLog(`Starting import of ${npcsToImport.length} NPC(s)...`, 'info');

        let successCount = 0;
        let errorCount = 0;
        let updateCount = 0;
        let replaceCount = 0;

        for (let i = 0; i < npcsToImport.length; i++) {
            const npcData = npcsToImport[i];
            let targetActor = null;
            let keepName = false;

            if (mappings && mappings[i]) {
                targetActor = mappings[i].targetActor;
                keepName = mappings[i].keepName;
            }

            try {
                progressDialog.addLog(`Importing: ${npcData.name}...`, 'info');
                const result = await importNPCFromCompCon(npcData, updateExisting, customTierMode, targetActor, keepName, progressDialog);

                if (result.updated) {
                    updateCount++;
                    progressDialog.addLog(`✓ Updated: ${npcData.name}`, 'success');
                } else if (result.replaced) {
                    replaceCount++;
                    progressDialog.addLog(`✓ Replaced: ${npcData.name}`, 'success');
                } else {
                    progressDialog.addLog(`✓ Created: ${npcData.name}`, 'success');
                }
                successCount++;
            } catch (error) {
                console.error(`Error importing ${npcData.name}:`, error);
                progressDialog.addLog(`✗ Failed: ${npcData.name} - ${error.message}`, 'error');
                errorCount++;
            }

            progressDialog.incrementProgress();
        }

        let summaryParts = [];
        const created = successCount - replaceCount - updateCount;
        if (created > 0) summaryParts.push(`${created} created`);
        if (updateCount > 0) summaryParts.push(`${updateCount} updated`);
        if (replaceCount > 0) summaryParts.push(`${replaceCount} replaced`);
        if (errorCount > 0) summaryParts.push(`${errorCount} failed`);

        const summaryMessage = `Import completed: ${summaryParts.join(', ')}`;
        progressDialog.addLog(summaryMessage, errorCount > 0 ? 'warning' : 'success');

        if (successCount > 0) {
            ui.notifications.info(`✓ Imported ${successCount} NPC(s)`);
        }
        if (errorCount > 0) {
            ui.notifications.warn(`✗ ${errorCount} NPC(s) failed to import`);
        }
    };

    input.click();
}

async function importFromCompCon() {
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

        try {
            await Auth.currentSession();
        } catch (e) {
            ui.notifications.error("Not logged into Comp/Con. Go to Settings → System Settings → COMP/CON Login");
            return;
        }

        ui.notifications.info("Fetching NPCs from Comp/Con...");

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

        const allNPCs = await Promise.all(
            active.map(async (item) => {
                try {
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
                } catch (e) {
                    console.error(`Error loading ${item.key}:`, e);
                    return null;
                }
            })
        );

        const validNPCs = allNPCs.filter(n => n !== null);

        if (validNPCs.length === 0) {
            ui.notifications.warn("No valid NPCs found");
            return;
        }

        new NPCSelectionDialog(validNPCs).render(true);

    } catch (error) {
        console.error("Error fetching NPCs from Comp/Con:", error);
        ui.notifications.error(`Error: ${error.message}`);
    }
}

class NPCSelectionDialog extends Dialog {
    constructor(npcs) {
        const isDownloadChecked = game.settings.get("lancer-npc-import", "defaultDownloadPortrait") ? "checked" : "";
        const content = `
            <style>
                .npc-import-options {
                    margin-bottom: 8px;
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 10px;
                }
                .npc-import-options-left {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                }
                .npc-import-options-right {
                    display: flex;
                    flex-direction: column;
                    gap: 6px;
                }
                .npc-import-options .lancer-toggle-card {
                    padding: 6px 10px;
                    margin-bottom: 0;
                }
                .npc-import-options .lancer-toggle-card-icon {
                    font-size: 14px;
                    width: 24px;
                    height: 24px;
                }
                .npc-import-options .lancer-toggle-card-text {
                    font-size: 13px;
                }
                .npc-import-options .lancer-section-title {
                    font-size: 12px;
                    margin: 0 0 6px 0;
                    padding: 0;
                }
                .npc-import-options .lancer-scaling-card .lancer-toggle-card-icon {
                    font-size: 18px;
                }
                .npc-import-options .lancer-scaling-card .lancer-toggle-card-text {
                    text-align: left !important;
                }
                .lancer-action-btn {
                    padding: 6px 12px !important;
                    height: auto !important;
                }
                .npc-list-container {
                    max-height: 500px;
                    min-height: auto;
                }
                .npc-list-container p {
                    color: #000000;
                    font-weight: 600;
                }
                .lancer-list {
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 8px;
                    height: 500px;
                    overflow-y: auto;
                    overflow-x: hidden;
                    align-content: start;
                }
                .npc-checkbox {
                    margin: 0 10px 0 0;
                    cursor: pointer;
                    width: 18px;
                    height: 18px;
                }
                .npc-info {
                    flex: 1;
                }
                .npc-name {
                    font-weight: bold;
                    color: #000000;
                    margin-bottom: 3px;
                }
                .npc-details {
                    font-size: 0.9em;
                    color: #333333;
                }
                .npc-portrait {
                    width: 48px;
                    height: 48px;
                    object-fit: cover;
                    border-radius: 3px;
                    margin-left: 10px;
                    flex-shrink: 0;
                    border: 1px solid rgba(255, 255, 255, 0.2);
                }
                .lancer-list-item {
                    position: relative;
                    min-height: 80px;
                    max-height: 80px;
                    flex-shrink: 0;
                }
                .npc-status-badge {
                    position: absolute;
                    top: 8px;
                    right: 8px;
                    padding: 2px 5px;
                    border-radius: 10px;
                    font-size: 10px;
                    font-weight: bold;
                    text-transform: uppercase;
                    letter-spacing: 0px;
                    z-index: 10;
                    cursor: help;
                }
                .npc-status-badge.synced {
                    background: rgba(76, 175, 80, 0.9);
                    color: #fff;
                }
                .npc-status-badge.modified {
                    background: rgba(255, 152, 0, 0.9);
                    color: #fff;
                }
                .npc-status-badge.new {
                    background: rgba(33, 150, 243, 0.9);
                    color: #fff;
                }
                .npc-status-badge.unlinked {
                    background: rgba(156, 39, 176, 0.9);
                    color: #fff;
                }
                .lancer-list-item[data-status="synced"] {
                    border-left: 3px solid #4CAF50;
                }
                .lancer-list-item[data-status="modified"] {
                    border-left: 3px solid #FF9800;
                }
                .lancer-list-item[data-status="new"] {
                    border-left: 3px solid #2196F3;
                }
                .lancer-list-item[data-status="unlinked"] {
                    border-left: 3px solid #9C27B0;
                }
                .status-filter-btn:hover:not(.active) {
                    opacity: 0.8;
                    transform: translateY(-1px);
                    box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                }
                .status-filter-btn.active {
                    box-shadow: 0 2px 6px rgba(0,0,0,0.3);
                }
            </style>
            <div class="lancer-dialog-base">
                <div class="lancer-dialog-header">
                    <div class="lancer-dialog-title">COMP/CON IMPORT // NPC SELECTION</div>
                    <div class="lancer-dialog-subtitle">Select NPCs to import from your Comp/Con roster (${npcs.length} available)</div>
                </div>
                <div class="npc-import-options">
                    <div class="npc-import-options-left">
                        <div class="lancer-section-title">Import Mode:</div>
                        <div class="lancer-toggle-card active" data-setting="update-existing" id="update-existing-card-cc">
                            <div class="lancer-toggle-card-icon"><i class="fas fa-check"></i></div>
                            <div class="lancer-toggle-card-text">Update existing NPCs</div>
                            <input type="hidden" id="update-existing" value="true">
                        </div>
                        <div class="lancer-toggle-card" data-setting="manual-replace" id="manual-replace-card-cc">
                            <div class="lancer-toggle-card-icon"><i class="fas fa-times"></i></div>
                            <div class="lancer-toggle-card-text">Manual replace mode</div>
                            <input type="hidden" id="manual-replace" value="false">
                        </div>
                    </div>
                    <div class="npc-import-options-right">
                        <div class="lancer-section-title">Custom Tier Scaling:</div>
                        <div class="lancer-toggle-card lancer-scaling-card active" data-mode="scaled">
                            <div class="lancer-toggle-card-icon"><i class="cci cci-accuracy"></i></div>
                            <div class="lancer-toggle-card-text">Scaled (keep tier increments)</div>
                        </div>
                        <div class="lancer-toggle-card lancer-scaling-card" data-mode="flat">
                            <div class="lancer-toggle-card-icon"><i class="cci cci-difficulty"></i></div>
                            <div class="lancer-toggle-card-text">Flat (same stats all tiers)</div>
                        </div>
                        <input type="hidden" id="custom-tier-mode" value="scaled">
                    </div>
                </div>
                <div class="npc-list-container">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <p style="margin: 0; color: #000000; font-weight: 600;">Select NPCs</p>
                        <p style="margin: 0; color: #991e2a; font-weight: 600;">
                            <span id="selected-count">0</span> selected
                        </p>
                    </div>
                    <div class="lancer-search-container">
                        <i class="fas fa-search lancer-search-icon"></i>
                        <input type="text" id="npc-search" placeholder="Search NPCs by name" autocomplete="off">
                    </div>
                    <div class="lancer-status-filters" style="display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap;">
                        <button type="button" class="status-filter-btn active" data-status="all" style="flex: 1; min-width: 55px; padding: 4px 8px; border: 1px solid #991e2a; border-radius: 4px; background: #991e2a; color: white; cursor: pointer; font-weight: 600; font-size: 12px; transition: all 0.2s;">
                            All
                        </button>
                        <button type="button" class="status-filter-btn" data-status="new" style="flex: 1; min-width: 55px; padding: 4px 8px; border: 1px solid #2196F3; border-radius: 4px; background: white; color: #2196F3; cursor: pointer; font-weight: 600; font-size: 12px; transition: all 0.2s;">
                            + New
                        </button>
                        <button type="button" class="status-filter-btn" data-status="synced" style="flex: 1; min-width: 55px; padding: 4px 8px; border: 1px solid #4CAF50; border-radius: 4px; background: white; color: #4CAF50; cursor: pointer; font-weight: 600; font-size: 12px; transition: all 0.2s;">
                            ✓ Synced
                        </button>
                        <button type="button" class="status-filter-btn" data-status="modified" style="flex: 1; min-width: 55px; padding: 4px 8px; border: 1px solid #FF9800; border-radius: 4px; background: white; color: #FF9800; cursor: pointer; font-weight: 600; font-size: 12px; transition: all 0.2s;">
                            ⚠ Modified
                        </button>
                        <button type="button" class="status-filter-btn" data-status="unlinked" style="flex: 1; min-width: 55px; padding: 4px 8px; border: 1px solid #9C27B0; border-radius: 4px; background: white; color: #9C27B0; cursor: pointer; font-weight: 600; font-size: 12px; transition: all 0.2s;">
                            ? Unlinked
                        </button>
                    </div>
                    <div class="lancer-list">
                        ${npcs.map((npc, index) => {
                            const imageUrl = npc.json.cloud_portrait || npc.json.localImage || '';

                            const existingActors = findExistingNPCsByLID(npc.json);
                            const comparison = compareNPCWithActor(npc.json, existingActors);
                            const status = comparison.status;
                            const count = comparison.count;
                            const reasons = comparison.reasons || [];

                            // Récupérer la liste des acteurs (par LID ou par nom)
                            let actorsList = [];
                            if (existingActors.length > 0) {
                                actorsList = existingActors;
                            } else if (status === 'unlinked' && npc.json.name) {
                                const nameLower = npc.json.name.toLowerCase();
                                actorsList = game.actors.filter(a =>
                                    a.type === 'npc' && a.name.toLowerCase() === nameLower
                                );
                            }

                            let badgeText = '';
                            let badgeTooltip = '';

                            if (status === 'synced') {
                                badgeText = count > 1 ? `✓ (×${count})` : '✓';
                                badgeTooltip = count > 1
                                    ? `NPC is up to date (${count} copies in world)`
                                    : 'NPC is up to date';
                            } else if (status === 'modified') {
                                badgeText = count > 1 ? `⚠ (×${count})` : '⚠';
                                const baseTooltip = count > 1
                                    ? `NPC has changes (${count} copies in world)`
                                    : 'NPC has changes';

                                // Ajouter les raisons des modifications
                                if (reasons.length > 0) {
                                    const reasonsList = reasons.map(r => "- " + r).join('\n');
                                    badgeTooltip = `${baseTooltip}\nReasons:\n${reasonsList}`;
                                } else {
                                    badgeTooltip = baseTooltip;
                                }
                            } else if (status === 'new') {
                                badgeText = '+';
                                badgeTooltip = 'NPC does not exist in world';
                            } else if (status === 'unlinked') {
                                badgeText = count > 1 ? `? (×${count})` : '?';
                                badgeTooltip = count > 1
                                    ? `NPC with same name exists but not linked (${count} found)`
                                    : 'NPC with same name exists but not linked (no LID)';
                            }

                            // Ajouter la liste des acteurs au tooltip
                            if (actorsList.length > 0) {
                                const actorNames = actorsList.map(a => "- " + a.name).join('\n');
                                badgeTooltip += '\nActors:\n' + actorNames;
                            }

                            const badgeHTML = badgeText ? `<div class="npc-status-badge ${status}" title="${badgeTooltip}">${badgeText}</div>` : '';

                            return `
                            <label class="lancer-list-item" data-npc-name="${npc.name.toLowerCase()}" data-npc-class="${npc.class.toLowerCase()}" data-npc-tier="${npc.tier}" data-npc-tag="${(npc.tag || '').toLowerCase()}" data-status="${status}">
                                ${badgeHTML}
                                <input type="checkbox" class="npc-checkbox" data-index="${index}">
                                <div class="npc-info">
                                    <div class="npc-name">${npc.name}</div>
                                    <div class="npc-details">
                                        ${npc.class} - Tier ${npc.tier}${npc.tag ? ` - ${npc.tag}` : ''}
                                    </div>
                                </div>
                                ${imageUrl ? `<img src="${imageUrl}" class="npc-portrait" alt="${npc.name}">` : ''}
                            </label>
                        `;}).join('')}
                    </div>
                </div>
                <div class="lancer-action-buttons">
                    <button type="button" id="select-all" class="lancer-action-btn">
                        <i class="fas fa-check-square"></i> Select All
                    </button>
                    <button type="button" id="deselect-all" class="lancer-action-btn">
                        <i class="fas fa-square"></i> Deselect All
                    </button>
                    <button type="button" id="link-actors" class="lancer-action-btn">
                        <i class="fas fa-link"></i> Link Actors
                    </button>
                    <label class="lancer-action-btn" style="display: inline-flex; align-items: center; gap: 6px; margin: 0; cursor: pointer;">
                        <input type="checkbox" id="download-portraits-check" ${isDownloadChecked} style="width: 16px; height: 16px; cursor: pointer; margin: 0;">
                        <i class="fas fa-download"></i> Save Portraits to Server
                    </label>
                </div>
            </div>
        `;

        super({
            title: "Select NPCs to Import",
            content: content,
            buttons: {
                import: {
                    icon: '<i class="fas fa-download"></i>',
                    label: "Import Selected",
                    callback: async (html) => {
                        const selectedIndices = [];
                        html.find('.npc-checkbox:checked').each(function() {
                            selectedIndices.push(parseInt($(this).data('index')));
                        });

                        if (selectedIndices.length === 0) {
                            ui.notifications.warn("No NPCs selected");
                            return;
                        }

                        const updateExisting = html.find('#update-existing').val() === 'true';
                        const manualReplace = html.find('#manual-replace').val() === 'true';
                        const customTierMode = html.find('#custom-tier-mode').val();
                        const downloadPortraits = html.find('#download-portraits-check').prop('checked');
                        const selectedNPCs = selectedIndices.map(i => npcs[i]);
                        await importSelectedNPCs(selectedNPCs, updateExisting, customTierMode, manualReplace, downloadPortraits);
                    }
                },
                cancel: {
                    icon: '<i class="fas fa-times"></i>',
                    label: "Cancel"
                }
            },
            default: "import"
        }, {
            width: 850,
            height: "auto",
            classes: ["npc-import-dialog"]
        });

        this.npcs = npcs;
    }

    activateListeners(html) {
        super.activateListeners(html);

        const dialog = html.closest('.dialog');
        const buttons = dialog.find('.dialog-buttons');
        buttons.css({
            'height': 'auto',
            'min-height': '50px',
            'flex': '0 0 auto'
        });
        buttons.find('button').css({
            'height': 'auto',
            'padding': '8px 16px'
        });

        html.find('.lancer-toggle-card').click(function() {
            const setting = $(this).data('setting');
            const isActive = $(this).hasClass('active');

            if (setting === 'update-existing' || setting === 'manual-replace') {
                const otherCard = setting === 'update-existing' ? '#manual-replace-card-cc' : '#update-existing-card-cc';

                $(this).toggleClass('active');
                const icon = $(this).find('.lancer-toggle-card-icon i');
                const hiddenInput = $(this).find('input[type="hidden"]');

                if (isActive) {
                    icon.removeClass('fa-check').addClass('fa-times');
                    hiddenInput.val('false');
                } else {
                    icon.removeClass('fa-times').addClass('fa-check');
                    hiddenInput.val('true');

                    html.find(otherCard).removeClass('active');
                    html.find(otherCard).find('.lancer-toggle-card-icon i').removeClass('fa-check').addClass('fa-times');
                    html.find(otherCard).find('input[type="hidden"]').val('false');
                }
            }
        });

        html.find('.lancer-scaling-card').click(function() {
            html.find('.lancer-scaling-card').removeClass('active');
            $(this).addClass('active');
            const mode = $(this).data('mode');
            html.find('#custom-tier-mode').val(mode);
        });

        const updateCount = () => {
            const count = html.find('.npc-checkbox:checked').length;
            html.find('#selected-count').text(count);
        };

        html.find('.npc-checkbox').on('change', function() {
            const $item = $(this).closest('.lancer-list-item');
            $item.toggleClass('selected', $(this).prop('checked'));
            updateCount();
        });

        // Fonction de filtre combinée (recherche + statut)
        let currentStatusFilter = 'all';

        function applyFilters() {
            const searchTerm = html.find('#npc-search').val().toLowerCase().trim();

            html.find('.lancer-list-item').each(function() {
                const $item = $(this);
                const name = $item.data('npc-name') || '';
                const npcClass = $item.data('npc-class') || '';
                const tier = String($item.data('npc-tier') || '').toLowerCase();
                const tag = $item.data('npc-tag') || '';
                const status = $item.data('status') || '';

                // Filtre de recherche
                const matchesSearch = searchTerm === '' ||
                    name.includes(searchTerm) ||
                    npcClass.includes(searchTerm) ||
                    tier.includes(searchTerm) ||
                    tag.includes(searchTerm);

                // Filtre de statut
                const matchesStatus = currentStatusFilter === 'all' || status === currentStatusFilter;

                // Montrer l'item seulement s'il passe les deux filtres
                $item.toggleClass('lancer-hidden', !(matchesSearch && matchesStatus));
            });
        }

        // Recherche par texte
        html.find('#npc-search').on('input', applyFilters);

        // Boutons de filtre par statut
        html.find('.status-filter-btn').on('click', function() {
            const $btn = $(this);
            const status = $btn.data('status');

            // Retirer la classe active de tous les boutons
            html.find('.status-filter-btn').removeClass('active').each(function() {
                const btnStatus = $(this).data('status');
                const isActive = btnStatus === status;

                // Styles pour bouton actif/inactif
                if (isActive) {
                    $(this).addClass('active');
                    if (btnStatus === 'all') {
                        $(this).css({ background: '#991e2a', color: 'white' });
                    } else if (btnStatus === 'synced') {
                        $(this).css({ background: '#4CAF50', color: 'white' });
                    } else if (btnStatus === 'modified') {
                        $(this).css({ background: '#FF9800', color: 'white' });
                    } else if (btnStatus === 'new') {
                        $(this).css({ background: '#2196F3', color: 'white' });
                    } else if (btnStatus === 'unlinked') {
                        $(this).css({ background: '#9C27B0', color: 'white' });
                    }
                } else {
                    if (btnStatus === 'all') {
                        $(this).css({ background: 'white', color: '#991e2a' });
                    } else if (btnStatus === 'synced') {
                        $(this).css({ background: 'white', color: '#4CAF50' });
                    } else if (btnStatus === 'modified') {
                        $(this).css({ background: 'white', color: '#FF9800' });
                    } else if (btnStatus === 'new') {
                        $(this).css({ background: 'white', color: '#2196F3' });
                    } else if (btnStatus === 'unlinked') {
                        $(this).css({ background: 'white', color: '#9C27B0' });
                    }
                }
            });

            // Appliquer le filtre
            currentStatusFilter = status;
            applyFilters();
        });

        html.find('#select-all').click(() => {
            html.find('.lancer-list-item:not(.lancer-hidden)').each(function() {
                $(this).find('.npc-checkbox').prop('checked', true);
                $(this).addClass('selected');
            });
            updateCount();
        });

        html.find('#deselect-all').click(() => {
            html.find('.lancer-list-item:not(.lancer-hidden)').each(function() {
                $(this).find('.npc-checkbox').prop('checked', false);
                $(this).removeClass('selected');
            });
            updateCount();
        });

        html.find('#link-actors').click(async () => {
            const selectedIndices = [];
            html.find('.npc-checkbox:checked').each(function() {
                selectedIndices.push(parseInt($(this).data('index')));
            });

            if (selectedIndices.length === 0) {
                ui.notifications.warn("No NPCs selected");
                return;
            }

            const selectedNPCs = selectedIndices.map(i => this.npcs[i]);
            const unlinkedNPCs = selectedNPCs.filter(npc => {
                const existingActors = findExistingNPCsByLID(npc.json);
                const comparison = compareNPCWithActor(npc.json, existingActors);
                return comparison.status === 'unlinked';
            });

            if (unlinkedNPCs.length === 0) {
                ui.notifications.info("No unlinked NPCs selected");
                return;
            }

            let linkedCount = 0;
            for (const npc of unlinkedNPCs) {
                const nameLower = npc.json.name.toLowerCase();
                const actorsByName = game.actors.filter(a =>
                    a.type === 'npc' && a.name.toLowerCase() === nameLower
                );

                for (const actor of actorsByName) {
                    await actor.update({ 'system.lid': npc.json.id });
                    linkedCount++;
                }
            }

            ui.notifications.info(`✓ Linked ${linkedCount} actor(s)`);

            // Rafraîchir la dialog pour mettre à jour les badges
            this.close();
            new NPCSelectionDialog(this.npcs).render(true);
        });
    }
}

async function uploadPortraitToServer(url, npcName) {
    if (!url) return null;

    const subFolder = game.settings.get("lancer-npc-import", "portraitStoragePath");
    const folderPath = `modules/lancer-npc-import/${subFolder}`;
    const proxyUrl = "https://corsproxy.io/?"; //Pour éviter le blocage CORS
    
    try {
        // 1. Créer le dossier s'il n'existe pas
        try {
            await FilePicker.createDirectory("data", folderPath);
        } catch (e) { /* existe déjà */ }

        // 2. Récupérer l'image via le proxy
        const response = await fetch(proxyUrl + encodeURIComponent(url));
        const blob = await response.blob();
        
        // 3. Préparer le fichier
        const extension = url.split('.').pop().split(/\#|\?/)[0] || 'png';
        const fileName = `${npcName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.${extension}`;
        const file = new File([blob], fileName, { type: blob.type });

        // 4. Uploader sur Foundry
        const uploadResponse = await FilePicker.upload("data", folderPath, file);
        return uploadResponse.path;
    } catch (error) {
        console.error("Failed to upload portrait:", error);
        return null;
    }
}

// Importer les NPCs sélectionnés depuis Comp/Con
async function importSelectedNPCs(npcs, updateExisting = true, customTierMode = 'scaled', manualReplace = false, downloadPortraits = false) {
    let mappings = null;
    if (manualReplace) {
        const npcsForMapping = npcs.map(npc => ({ name: npc.name }));
        mappings = await selectActorMappings(npcsForMapping);

        if (mappings === null) {
            ui.notifications.info("Import cancelled");
            return;
        }
    }

    const progressDialog = new ImportProgressDialog(npcs.length);
    progressDialog.render(true);
    progressDialog.addLog(`Starting import of ${npcs.length} NPC(s) from Comp/Con...`, 'info');

    let successCount = 0;
    let errorCount = 0;
    let updateCount = 0;
    let replaceCount = 0;

    for (let i = 0; i < npcs.length; i++) {
        const npc = npcs[i];
        let targetActor = null;
        let keepName = false;

        if (mappings && mappings[i]) {
            targetActor = mappings[i].targetActor;
            keepName = mappings[i].keepName;
        }

        try {
            progressDialog.addLog(`Importing: ${npc.name}...`, 'info');
            const result = await importNPCFromCompCon(npc.json, updateExisting, customTierMode, targetActor, keepName, progressDialog, downloadPortraits);

            if (result.updated) {
                updateCount++;
                progressDialog.addLog(`✓ Updated: ${npc.name}`, 'success');
            } else if (result.replaced) {
                replaceCount++;
                progressDialog.addLog(`✓ Replaced: ${npc.name}`, 'success');
            } else {
                progressDialog.addLog(`✓ Created: ${npc.name}`, 'success');
            }
            successCount++;

        } catch (error) {
            console.error(`Error importing ${npc.name}:`, error);
            progressDialog.addLog(`✗ Failed: ${npc.name} - ${error.message}`, 'error');
            errorCount++;
        }

        progressDialog.incrementProgress();
    }

    let summaryParts = [];
    const created = successCount - replaceCount - updateCount;
    if (created > 0) summaryParts.push(`${created} created`);
    if (updateCount > 0) summaryParts.push(`${updateCount} updated`);
    if (replaceCount > 0) summaryParts.push(`${replaceCount} replaced`);
    if (errorCount > 0) summaryParts.push(`${errorCount} failed`);

    const summaryMessage = `Import completed: ${summaryParts.join(', ')}`;
    progressDialog.addLog(summaryMessage, errorCount > 0 ? 'warning' : 'success');

    if (successCount > 0) {
        ui.notifications.info(`✓ Imported ${successCount} NPC(s)`);
    }
    if (errorCount > 0) {
        ui.notifications.warn(`✗ ${errorCount} NPC(s) failed to import`);
    }
}

// Appliquer les customisations des features (tier override, custom name, description)
async function applyFeatureCustomizations(actor, npcData, progressDialog = null) {
    try {
        if (!npcData.items || npcData.items.length === 0) {
            return;
        }

        const updates = [];
        const tierOverrides = [];
        const npcTierParsed = parseTier(npcData.tier);

        for (const ccItem of npcData.items) {
            const feature = actor.items.find(i =>
                i.type === 'npc_feature' &&
                i.system.lid === ccItem.itemID
            );

            if (!feature) {
                continue;
            }

            const updateData = { _id: feature.id };
            let hasChanges = false;

            if (ccItem.flavorName) {
                updateData['name'] = ccItem.flavorName;
                updateData['system.custom_name'] = ccItem.flavorName;
                hasChanges = true;
            }

            if (ccItem.description) {
                updateData['system.custom_description'] = ccItem.description;
                hasChanges = true;
            }

            if (ccItem.tier !== undefined && ccItem.tier !== npcTierParsed) {
                tierOverrides.push({
                    name: ccItem.flavorName || feature.name,
                    tier: ccItem.tier
                });
            }

            if (hasChanges) {
                updates.push(updateData);
            }
        }

        if (updates.length > 0) {
            await actor.updateEmbeddedDocuments('Item', updates);
            console.log(`Applied ${updates.length} feature customization(s) for ${actor.name}`);
        }

        if (tierOverrides.length > 0) {
            const featureList = tierOverrides.map(f => `${f.name} (T${f.tier})`).join(', ');
            if (progressDialog) {
                progressDialog.addLog(`  ⚠ ${tierOverrides.length} feature(s) with different tiers not applied: ${featureList}`, 'warning');
            }
            console.warn(`Features with tier overrides for ${actor.name}:`, tierOverrides);
        }
    } catch (error) {
        console.error(`Error applying feature customizations:`, error);
        if (progressDialog) {
            progressDialog.addLog(`  ⚠ Could not apply feature customizations`, 'warning');
        }
    }
}

// Appliquer les stats custom aux tiers de la classe NPC (flat ou scaled)
async function applyCustomTierStats(actor, npcData, mode = 'scaled', progressDialog = null) {
    try {
        const npcClass = actor.items.find(i => i.type === 'npc_class' && i.system.lid === npcData.class);

        if (!npcClass) {
            console.warn(`Could not find NPC class ${npcData.class} in actor items`);
            return;
        }

        const customStats = npcData.stats || {};
        const originalStats = npcClass.system.base_stats;

        const calculateStat = (statName, ccKey, tierIndex) => {
            const customValue = customStats[ccKey];
            const originalValue = originalStats[tierIndex][statName];

            if (customValue === undefined) {
                return originalValue;
            }

            if (mode === 'flat') {
                return customValue;
            }

            if (mode === 'scaled') {
                const tier1Original = originalStats[0][statName];
                const increment = originalValue - tier1Original;
                return customValue + increment;
            }

            return customValue;
        };

        const newBaseStats = [0, 1, 2].map(tierIndex => ({
            activations: calculateStat('activations', 'activations', tierIndex),
            armor: calculateStat('armor', 'armor', tierIndex),
            hp: calculateStat('hp', 'hp', tierIndex),
            evasion: calculateStat('evasion', 'evade', tierIndex),
            edef: calculateStat('edef', 'edef', tierIndex),
            heatcap: calculateStat('heatcap', 'heatcap', tierIndex),
            speed: calculateStat('speed', 'speed', tierIndex),
            sensor_range: calculateStat('sensor_range', 'sensor', tierIndex),
            save: calculateStat('save', 'save', tierIndex),
            hull: calculateStat('hull', 'hull', tierIndex),
            agi: calculateStat('agi', 'agility', tierIndex),
            sys: calculateStat('sys', 'systems', tierIndex),
            eng: calculateStat('eng', 'engineering', tierIndex),
            size: calculateStat('size', 'size', tierIndex),
            structure: calculateStat('structure', 'structure', tierIndex),
            stress: calculateStat('stress', 'stress', tierIndex)
        }));

        const newName = npcClass.name.includes('CUSTOM')
            ? npcClass.name
            : `${npcClass.name} CUSTOM`;

        await npcClass.update({
            'name': newName,
            'system.base_stats': newBaseStats
        });

        console.log(`Applied custom tier stats (${mode}) to ${newName} for ${actor.name}`);
        if (progressDialog) {
            progressDialog.addLog(`  ✓ Applied custom tier stats (${mode})`, 'info');
        }
    } catch (error) {
        console.error(`Error applying custom tier stats:`, error);
        if (progressDialog) {
            progressDialog.addLog(`  ⚠ Could not apply custom tier stats`, 'warning');
        }
    }
}

// Chercher tous les NPCs existants par LID
function findExistingNPCsByLID(npcData) {
    const found = [];

    if (npcData.id) {
        const actorsByLid = game.actors.filter(a => a.type === 'npc' && a.system.lid === npcData.id);
        found.push(...actorsByLid);
    }

    return found;
}

// Comparer un NPC de Comp/Con avec un acteur existant
// Retourne: { status: 'new'|'unlinked'|'synced'|'modified', count: nombre, reasons: [] }
function compareNPCWithActor(npcData, actors) {
    // Aucun acteur trouvé par LID
    if (!actors || actors.length === 0) {
        // Vérifier si un NPC avec le même nom existe (sans LID correspondant)
        if (npcData.name) {
            const nameLower = npcData.name.toLowerCase();
            const actorsByName = game.actors.filter(a =>
                a.type === 'npc' && a.name.toLowerCase() === nameLower
            );
            if (actorsByName.length > 0) {
                return { status: 'unlinked', count: actorsByName.length, reasons: [] };
            }
        }
        return { status: 'new', count: 0, reasons: [] };
    }

    const actor = actors[0];
    const reasons = [];

    // Note: On ne compare PAS le nom - il est préservé lors des updates

    // Comparer le TIER (sauf custom)
    const npcTier = parseTier(npcData.tier);
    if (npcData.tier !== 'custom' && npcTier !== actor.system.tier) {
        reasons.push(`tier changed: ${actor.system.tier} → ${npcTier}`);
    }

    // Comparer les ITEMS par type (Class, Templates, Features)

    // 1. Comparer la CLASSE
    const actorClass = actor.items.find(i => i.type === 'npc_class');
    const actorClassLid = actorClass?.system.lid;
    if (npcData.class !== actorClassLid) {
        reasons.push(`class: ${actorClassLid || 'none'} → ${npcData.class || 'none'}`);
    }

    // 2. Comparer les TEMPLATES
    const npcTemplates = (npcData.templates || []).filter(lid => lid).sort();
    const actorTemplates = actor.items
        .filter(i => i.type === 'npc_template')
        .map(i => i.system.lid)
        .filter(lid => lid)
        .sort();

    // Différence neutre - on ne sait pas lequel est "l'original"
    if (npcTemplates.length !== actorTemplates.length ||
        !npcTemplates.every((lid, i) => lid === actorTemplates[i])) {
        reasons.push(`templates: ${actorTemplates.length} → ${npcTemplates.length}`);
    }

    // 3. Comparer les FEATURES
    const npcFeatures = (npcData.items || [])
        .map(item => item.itemID)
        .filter(lid => lid)
        .sort();
    const actorFeatures = actor.items
        .filter(i => i.type === 'npc_feature')
        .map(i => i.system.lid)
        .filter(lid => lid)
        .sort();

    // Différence neutre
    if (npcFeatures.length !== actorFeatures.length ||
        !npcFeatures.every((lid, i) => lid === actorFeatures[i])) {
        reasons.push(`features: ${actorFeatures.length} → ${npcFeatures.length}`);
    }

    // Comparer les STATS de BASE de la classe (pas les stats totales de l'acteur qui incluent les bonus d'items)
    const stats = npcData.stats || {};

    // Trouver la classe NPC
    const npcClass = actor.items.find(i => i.type === 'npc_class');

    if (npcClass && npcClass.system.base_stats) {
        // Déterminer le tier à utiliser pour la comparaison
        // Custom tier = toujours tier 0 (index 0)
        // Autres tiers = tier actuel (tier 1 = index 0, tier 2 = index 1, tier 3 = index 2)
        const isCustomTier = npcData.tier === 'custom';
        const tierIndex = isCustomTier ? 0 : Math.max(0, actor.system.tier - 1);
        const baseStats = npcClass.system.base_stats[tierIndex];

        if (baseStats) {
            const statChecks = [
                ['hp', 'hp', 'HP'],
                ['armor', 'armor', 'Armor'],
                ['evade', 'evasion', 'Evasion'],
                ['edef', 'edef', 'E-Defense'],
                ['heatcap', 'heatcap', 'Heat Cap'],
                ['sensor', 'sensor_range', 'Sensors'],
                ['save', 'save', 'Save'],
                ['speed', 'speed', 'Speed'],
                ['size', 'size', 'Size'],
                ['activations', 'activations', 'Activations'],
                ['hull', 'hull', 'Hull'],
                ['agility', 'agi', 'Agility'],
                ['systems', 'sys', 'Systems'],
                ['engineering', 'eng', 'Engineering'],
                ['structure', 'structure', 'Structure'],
                ['stress', 'stress', 'Stress']
            ];

            for (const [ccKey, baseStatKey, displayName] of statChecks) {
                if (stats[ccKey] !== undefined) {
                    // Skip size comparison if it's custom (> 4) - we preserve custom sizes
                    if (ccKey === 'size' && actor.system.size > 4) {
                        continue;
                    }

                    const baseValue = baseStats[baseStatKey];

                    if (baseValue != stats[ccKey]) {
                        reasons.push(`${displayName}: ${baseValue} → ${stats[ccKey]}`);
                    }
                }
            }
        }
    }

    if (reasons.length > 0) {
        return { status: 'modified', count: actors.length, reasons };
    }

    return { status: 'synced', count: actors.length, reasons: [] };
}

// Fonction principale d'import d'un NPC depuis Comp/Con
async function importNPCFromCompCon(npcData, updateExisting = true, customTierMode = 'scaled', targetActor = null, keepName = false, progressDialog = null, downloadPortraits = false) {
    const isCustomTier = npcData.tier === 'custom';

    // Déterminer les acteurs à mettre à jour
    let existingActors = [];
    let isReplace = false;
    let localImagePath = null;

     if (downloadPortraits && npcData.cloud_portrait) {
        progressDialog?.addLog(`  Uploading portrait to server...`, 'info');
        localImagePath = await uploadPortraitToServer(npcData.cloud_portrait, npcData.name);
        if (localImagePath) {
            progressDialog?.addLog(`  ✓ Portrait saved: ${localImagePath}`, 'success');
        }
    }

    if (targetActor) {
        // Manual replace: utiliser l'acteur spécifié
        existingActors = [targetActor];
        isReplace = true;
    } else if (updateExisting) {
        // Chercher tous les NPCs existants par LID
        existingActors = findExistingNPCsByLID(npcData);

        if (existingActors.length > 1) {
            console.log(`Found ${existingActors.length} existing NPCs matching "${npcData.name}". Updating all.`);
            if (progressDialog) {
                progressDialog.addLog(`  Found ${existingActors.length} existing copies, updating all...`, 'info');
            }
        }
    }

    const systemData = {
        tier: parseTier(npcData.tier),
        tag: npcData.tag || '',
        subtitle: npcData.subtitle || '',
        campaign: npcData.campaign || '',
        labels: npcData.labels || [],
        note: npcData.note || '',
        side: npcData.side || 'Enemy',
        lid: npcData.id || '',
        ...(npcData.class ? {
            hp: { value: 0, max: 0 },
            armor: 0,
            evasion: 0,
            edef: 0,
            heatcap: { value: 0, max: 0 },
            structure: { value: 0, max: 0 },
            stress: { value: 0, max: 0 },
            speed: 0,
            sensor: 0,
            save: 0,
            hull: 0,
            agi: 0,
            sys: 0,
            eng: 0,
            size: 0,
            activations: 0
        } : {})
    };

    let actor;
    let wasUpdated = false;
    let wasReplaced = false;

    if (existingActors.length > 0) {
        // Mettre à jour tous les acteurs existants
        for (const existingActor of existingActors) {
            console.log(`Updating existing NPC: ${existingActor.name}`);

            const finalSystemData = { ...systemData };
            // Préserver les tailles custom (> 4)
            if (existingActor.system.size > 4) {
                finalSystemData.size = existingActor.system.size;
                console.log(`Preserving custom size (${existingActor.system.size}) for ${existingActor.name}`);
            }

            // Déterminer si on change le nom :
            // - Update normal : jamais changer le nom (garder celui de l'acteur)
            // - Replace manuel : changer seulement si keepName=false
            const finalName = (isReplace && !keepName) ? npcData.name : existingActor.name;

            await existingActor.update({
                name: finalName,
                system: finalSystemData
            });
        }

        actor = existingActors[0];

        if (isReplace) {
            wasReplaced = true;
        } else {
            wasUpdated = true;
        }
    } else {
        const finalImg = localImagePath || npcData.cloud_portrait || npcData.localImage || '';
        const finalImgForToken = localImagePath || npcData.localImage || '';
        
        const actorData = {
            name: npcData.name,
            type: 'npc',
            system: systemData,
            img: finalImg,
            prototypeToken: {
                texture: {
                    src: finalImgForToken
                }
            }
        };
        actor = await Actor.create(actorData);
        if (!actor) throw new Error('Failed to create NPC actor');
    }

    const classAndTemplates = [];
    const missingItems = [];

    if (npcData.class) {
        const npcClass = await findItemByLid(npcData.class, 'npc_class');
        if (npcClass) {
            classAndTemplates.push(npcClass.toObject());
        } else {
            missingItems.push(`Class: ${npcData.class}`);
            if (progressDialog) {
                progressDialog.addLog(`  ⚠ Class not found: ${npcData.class}`, 'warning');
            }
        }
    }

    if (npcData.templates?.length > 0) {
        for (const templateLid of npcData.templates) {
            const template = await findItemByLid(templateLid, 'npc_template');
            if (template) {
                classAndTemplates.push(template.toObject());
            } else {
                missingItems.push(`Template: ${templateLid}`);
                if (progressDialog) {
                    progressDialog.addLog(`  ⚠ Template not found: ${templateLid}`, 'warning');
                }
            }
        }
    }

    const featuresToAdd = [];
    const missingFeatures = [];

    if (npcData.items?.length > 0) {
        for (const ccItem of npcData.items) {
            const foundItem = await findItemByLid(ccItem.itemID, 'npc_feature');
            if (foundItem) {
                const itemData = foundItem.toObject();
                if (ccItem.flavorName) itemData.system.custom_name = ccItem.flavorName;
                if (ccItem.description) itemData.system.custom_description = ccItem.description;
                if (ccItem.tier !== undefined) itemData.system.tier = ccItem.tier;
                if (ccItem.destroyed !== undefined) itemData.system.destroyed = ccItem.destroyed;
                if (ccItem.uses !== undefined) itemData.system.uses = { value: ccItem.uses, max: ccItem.uses };
                featuresToAdd.push(itemData);
            } else {
                missingFeatures.push(ccItem.itemID);
            }
        }
    }

    const actorsToUpdate = existingActors.length > 0 ? existingActors : [actor];

    // Appliquer les items à tous les acteurs
    for (const actorToUpdate of actorsToUpdate) {
        // Supprimer les anciennes classes et templates
        const oldClassAndTemplates = actorToUpdate.items.filter(i =>
            i.type === 'npc_class' || i.type === 'npc_template'
        );
        if (oldClassAndTemplates.length > 0) {
            await actorToUpdate.deleteEmbeddedDocuments('Item', oldClassAndTemplates.map(i => i.id));
        }

        // Ajouter class et templates (déclenche automatiquement les base_features via hook)
        if (classAndTemplates.length > 0) {
            await actorToUpdate.createEmbeddedDocuments('Item', classAndTemplates);

            // Attendre que Lancer finisse d'ajouter les base_features
            if (actorToUpdate.npcClassSwapPromises && actorToUpdate.npcClassSwapPromises.length > 0) {
                console.log(`Waiting for ${actorToUpdate.npcClassSwapPromises.length} NPC class swap(s) to complete...`);
                await Promise.all(actorToUpdate.npcClassSwapPromises);
                actorToUpdate.npcClassSwapPromises = [];
                console.log('NPC class swaps completed');
            }
        }

        // Appliquer les stats custom pour les custom tiers
        if (isCustomTier && npcData.class) {
            await applyCustomTierStats(actorToUpdate, npcData, customTierMode, progressDialog);
        }
        // Ou appliquer juste la taille si définie (certaines classes permettent plusieurs tailles)
        else if (!isCustomTier && npcData.class && npcData.stats?.size) {
            const npcClass = actorToUpdate.items.find(i => i.type === 'npc_class' && i.system.lid === npcData.class);
            if (npcClass) {
                const newBaseStats = npcClass.system.base_stats.map(tierStats => ({
                    ...tierStats,
                    size: npcData.stats.size
                }));
                await npcClass.update({ 'system.base_stats': newBaseStats });
            }
        }

        // Supprimer TOUTES les features (y compris celles ajoutées par les templates)
        const allFeatures = actorToUpdate.items.filter(i => i.type === 'npc_feature');
        if (allFeatures.length > 0) {
            console.log(`Removing ${allFeatures.length} auto-added features before adding Comp/Con features`);
            await actorToUpdate.deleteEmbeddedDocuments('Item', allFeatures.map(i => i.id));
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Ajouter les features de Comp/Con
        if (featuresToAdd.length > 0) {
            await actorToUpdate.createEmbeddedDocuments('Item', featuresToAdd);
        }

        await applyFeatureCustomizations(actorToUpdate, npcData, progressDialog);

        // Reset HP, structure et stress au max, heat à 0
        await actorToUpdate.update({
            'system.hp.value': actorToUpdate.system.hp.max,
            'system.heat.value': 0,
            'system.structure.value': actorToUpdate.system.structure.max,
            'system.stress.value': actorToUpdate.system.stress.max
        });
    }

    if (missingFeatures.length > 0) {
        if (progressDialog) {
            progressDialog.addLog(`  ⚠ ${missingFeatures.length} feature(s) not found in compendiums`, 'warning');
        }
        console.warn(`Missing features for ${npcData.name}:`, missingFeatures);
    }

    if (missingItems.length > 0 || missingFeatures.length > 0) {
        const total = missingItems.length + missingFeatures.length;
        if (progressDialog) {
            progressDialog.addLog(`  ⚠ Imported with ${total} missing item(s)`, 'warning');
        }
    }

    return { actor, updated: wasUpdated, replaced: wasReplaced };
}

async function findItemByLid(lid, itemType = null) {
    for (const pack of game.packs) {
        if (pack.metadata.type !== 'Item') continue;
        const index = await pack.getIndex({ fields: ['system.lid', 'type'] });
        const entry = index.find(i => {
            const matchesLid = i.system?.lid === lid;
            const matchesType = itemType ? i.type === itemType : true;
            return matchesLid && matchesType;
        });
        if (entry) return await pack.getDocument(entry._id);
    }
    return null;
}

function parseTier(tier) {
    if (tier === 'custom') return 1;
    if (typeof tier === 'number') return Math.max(1, Math.min(3, tier));
    if (typeof tier === 'string') {
        const num = parseInt(tier);
        if (!isNaN(num)) return Math.max(1, Math.min(3, num));
    }
    return 1;
}

Hooks.on('renderActorDirectory', (_app, html) => {
    if (game.system.id !== 'lancer') return;

    const headerActions = html.find('.header-actions.action-buttons');
    if (headerActions.length === 0) return;

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

// UI dialogs: source selection, progress, and NPC selection from Comp/Con.

import { CORS_PROXY } from "./v3-api.js";
import { importFromFiles } from "./npc-import-files.js";
import { importFromCompCon } from "./npc-import-compcon.js";
import {
    importSelectedNPCs,
    findExistingNPCsByLID,
    compareNPCWithActor
} from "./npc-import-core.js";

export class NPCImportDialog extends Dialog {
    constructor() {
        super({
            title: "NPC Import",
            content: `
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
            height: "auto",
            classes: ["npc-import-dialog", "lancer-dialog-base", "lancer-no-title"]
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

export class ImportProgressDialog {
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
                close: () => {
                    this.dialog = null;
                }
            }, {
                width: 600,
                height: 500, // Hauteur fixe
                resizable: true,
                classes: ["lancer-import-progress-dialog", "lancer-dialog-base", "lancer-no-title"]
            });
            this.dialog.render(true);
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

export class NPCSelectionDialog extends Dialog {
    constructor(npcs) {
        const isDownloadChecked = game.settings.get("lancer-npc-import", "defaultDownloadPortrait") ? "checked" : "";
        const content = `
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
                    <div class="npc-list-header">
                        <p class="npc-list-label">Select NPCs</p>
                        <p class="npc-list-count">
                            <span id="selected-count">0</span> selected
                        </p>
                    </div>
                    <div class="lancer-search-container">
                        <i class="fas fa-search lancer-search-icon"></i>
                        <input type="text" id="npc-search" placeholder="Search NPCs by name" autocomplete="off">
                    </div>
                    <div class="lancer-status-filters">
                        <button type="button" class="status-filter-btn active" data-status="all">All</button>
                        <button type="button" class="status-filter-btn" data-status="new">+ New</button>
                        <button type="button" class="status-filter-btn" data-status="synced">✓ Synced</button>
                        <button type="button" class="status-filter-btn" data-status="modified">⚠ Modified</button>
                        <button type="button" class="status-filter-btn" data-status="unlinked">? Unlinked</button>
                    </div>
                    <div class="lancer-list">
                        ${npcs.map((npc, index) => {
        const imageUrl = npc.json.cloud_portrait || npc.json.img?.cloud_portrait || npc.json.localImage || '';

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
                        `;
    }).join('')}
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
                    <label class="lancer-action-btn lancer-action-btn--inline">
                        <input type="checkbox" id="download-portraits-check" ${isDownloadChecked} class="lancer-action-btn__checkbox">
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
            classes: ["npc-import-dialog", "lancer-dialog-base", "lancer-no-title"]
        });

        this.npcs = npcs;
    }

    activateListeners(html) {
        super.activateListeners(html);

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
            const status = $(this).data('status');
            html.find('.status-filter-btn').removeClass('active');
            $(this).addClass('active');
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

export async function uploadPortraitToServer(url, npcName) {
    if (!url)
        return null;

    const subFolder = game.settings.get("lancer-npc-import", "portraitStoragePath");
    const folderPath = `modules/lancer-npc-import/${subFolder}`;
    const proxyUrl = CORS_PROXY;

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

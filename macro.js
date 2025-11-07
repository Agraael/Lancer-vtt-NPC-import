/**
 * NPC Import Macro for Lancer (Foundry VTT)
 * 
 * This macro allows you to import NPCs from:
 * - Local JSON files (exported from CompCon)
 * - Directly from your CompCon account (requires login)
 * 
 * Features:
 * - Import multiple NPCs at once
 * - Update existing NPCs without losing token customizations
 * - Automatically imports NPC classes, templates, and features
 * 
 * Usage:
 * 1. Run this macro
 * 2. Choose import method (JSON files or CompCon)
 * 3. Select NPCs to import
 * 4. Done!
 * 
 * Note: Custom tier NPCs default to Tier 1
 * 
 * @author Your Name
 * @version 1.0.0
 * @license MIT
 */

async function ImportNPC() {
    // Créer et afficher la dialog de sélection
    new NPCImportDialog().render(true);
}

// Dialog pour choisir la méthode d'import
class NPCImportDialog extends Dialog {
    constructor() {
        super({
            title: "Import NPCs",
            content: `
                <form style="padding: 10px;">
                    <div style="display: flex; flex-direction: column; gap: 15px;">
                        <button type="button" id="import-from-files" class="import-method-button">
                            <i class="fas fa-file-upload"></i> Import from JSON File(s)
                            <div class="button-subtitle">Always creates new NPCs</div>
                        </button>

                        <button type="button" id="import-from-compcon" class="import-method-button">
                            <i class="fas fa-cloud-download-alt"></i> Import from Comp/Con
                            <div class="button-subtitle">Can update existing NPCs</div>
                        </button>
                    </div>

                    <div class="import-info">
                        <i class="fas fa-info-circle"></i>
                        <span><strong>Note:</strong> Custom tier NPCs will have their class modified with custom stats. Choose scaling mode when importing.</span>
                    </div>
                </form>
                <style>
                    .import-method-button {
                        padding: 15px;
                        font-size: 14px;
                        font-weight: 500;
                        cursor: pointer;
                        border: 1px solid var(--color-border-dark);
                        border-radius: 3px;
                        background: rgba(0, 0, 0, 0.3);
                        color: #ffffff;
                        transition: all 0.2s;
                        text-shadow: 0 0 2px rgba(0, 0, 0, 0.8);
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        gap: 5px;
                    }
                    .import-method-button:hover {
                        background: rgba(255, 65, 65, 0.2);
                        border-color: rgba(255, 65, 65, 0.6);
                        box-shadow: 0 0 10px rgba(255, 65, 65, 0.5);
                        color: #ffffff;
                    }
                    .import-method-button i {
                        margin-right: 8px;
                    }
                    .button-subtitle {
                        font-size: 11px;
                        font-weight: 400;
                        color: #aaaaaa;
                        text-shadow: 0 0 2px rgba(0, 0, 0, 0.8);
                    }
                    .import-info {
                        margin-top: 10px;
                        padding: 10px;
                        background: rgba(100, 150, 255, 0.15);
                        border: 1px solid rgba(100, 150, 255, 0.3);
                        border-radius: 3px;
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        color: #000000ff;
                        font-size: 12px;
                    }
                    .import-info i {
                        color: #6496ff;
                        font-size: 16px;
                        flex-shrink: 0;
                    }
                    .import-info span {
                        line-height: 1.4;
                    }
                </style>
            `,
            buttons: {},
            default: null,
            close: () => {}
        }, {
            width: 400,
            height: "auto"
        });
    }

    activateListeners(html) {
        super.activateListeners(html);

        // Bouton pour import depuis fichiers
        html.find('#import-from-files').click(async () => {
            this.close();
            await importFromFiles();
        });

        // Bouton pour import depuis CompCon
        html.find('#import-from-compcon').click(async () => {
            this.close();
            await importFromCompCon();
        });
    }
}

// Import depuis fichiers JSON locaux
async function importFromFiles() {
    // D'abord, demander le mode de scaling pour les custom tiers
    const scalingDialog = new Dialog({
        title: "Custom Tier Scaling Mode",
        content: `
            <form style="padding: 10px;">
                <div style="margin-bottom: 15px; color: #000000;">
                    <p style="margin-bottom: 10px;">Choose how to apply custom tier stats:</p>
                </div>
                <div style="display: flex; flex-direction: column; gap: 10px;">
                    <label style="display: flex; align-items: center; cursor: pointer;">
                        <input type="radio" name="scaling-mode" value="scaled" checked style="margin-right: 8px;">
                        <span style="color: #000000;"><strong>Scaled</strong> - Keep tier increments (0/2/4 if base was 10/12/14)</span>
                    </label>
                    <label style="display: flex; align-items: center; cursor: pointer;">
                        <input type="radio" name="scaling-mode" value="flat" style="margin-right: 8px;">
                        <span style="color: #000000;"><strong>Flat</strong> - Same stats for all tiers (0/0/0)</span>
                    </label>
                </div>
            </form>
        `,
        buttons: {
            import: {
                icon: '<i class="fas fa-file-upload"></i>',
                label: "Select Files",
                callback: async (html) => {
                    const customTierMode = html.find('input[name="scaling-mode"]:checked').val();
                    await selectAndImportFiles(customTierMode);
                }
            },
            cancel: {
                icon: '<i class="fas fa-times"></i>',
                label: "Cancel"
            }
        },
        default: "import"
    });

    scalingDialog.render(true);
}

// Sélectionner et importer les fichiers avec le mode choisi
async function selectAndImportFiles(customTierMode) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.multiple = true;

    input.onchange = async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;

        ui.notifications.info(`Importing ${files.length} NPC(s)...`);

        let successCount = 0;
        let errorCount = 0;

        for (const file of files) {
            try {
                const text = await file.text();
                const npcData = JSON.parse(text);

                if (!npcData.class || !npcData.name) {
                    ui.notifications.error(`Invalid NPC JSON: ${file.name} - missing required fields`);
                    errorCount++;
                    continue;
                }

                ui.notifications.info(`Importing: ${npcData.name}`);
                await importNPCFromCompCon(npcData, false, customTierMode); // Pas d'update pour les fichiers
                successCount++;
            } catch (error) {
                console.error(`Error importing ${file.name}:`, error);
                ui.notifications.error(`Failed to import ${file.name}: ${error.message}`);
                errorCount++;
            }
        }

        if (successCount > 0) {
            ui.notifications.info(`✓ Successfully imported ${successCount} NPC(s)`);
        }
        if (errorCount > 0) {
            ui.notifications.warn(`✗ Failed to import ${errorCount} NPC(s)`);
        }
    };

    input.click();
}

// Import depuis CompCon
async function importFromCompCon() {
    try {
        ui.notifications.info("Connecting to Comp/Con...");

        // Charger les modules AWS dynamiquement
        let Auth, Storage, awsConfig;

        // Trouver les fichiers AWS dans le système Lancer
        const lancerPath = game.system.id === "lancer" ? "systems/lancer" : null;
        if (!lancerPath) {
            throw new Error("Lancer system not found");
        }

        // Détecter automatiquement les fichiers AWS en parsant lancer.mjs
        const tryImportModules = async (basePath) => {
            try {
                console.log("Auto-detecting AWS module files...");

                // Étape 1: Fetch lancer.mjs pour trouver lancer-HASH.mjs
                const lancerResponse = await fetch(`/${basePath}/lancer.mjs`);
                if (!lancerResponse.ok) {
                    throw new Error("Could not fetch lancer.mjs");
                }

                const lancerContent = await lancerResponse.text();

                // Extraire le nom du fichier lancer-HASH.mjs
                // Chercher: import "./lancer-XXXXX.mjs"
                const lancerHashMatch = lancerContent.match(/import\s+["']\.\/lancer-([a-f0-9]+)\.mjs["']/);
                if (!lancerHashMatch) {
                    throw new Error("Could not find lancer-HASH.mjs reference in lancer.mjs");
                }

                const lancerHashFile = `lancer-${lancerHashMatch[1]}.mjs`;
                console.log(`Found main file: ${lancerHashFile}`);

                // Étape 2: Fetch lancer-HASH.mjs pour trouver les fichiers AWS
                const lancerHashResponse = await fetch(`/${basePath}/${lancerHashFile}`);
                if (!lancerHashResponse.ok) {
                    throw new Error(`Could not fetch ${lancerHashFile}`);
                }

                const lancerHashContent = await lancerHashResponse.text();

                // Parser pour extraire les noms de fichiers AWS
                // Chercher: (await import("./aws-exports-XXXXX.mjs"))
                // Chercher: { Auth } = await import("./index-XXXXX.mjs")
                // Chercher: { Storage } = await import("./index-YYYYY.mjs")

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

                // Étape 3: Importer les modules détectés
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

                // Fallback : essayer avec des hash connus
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

        // Configurer AWS
        Auth.configure(awsConfig);
        Storage.configure(awsConfig);

        // Vérifier la session
        try {
            await Auth.currentSession();
        } catch (e) {
            ui.notifications.error("Not logged into Comp/Con. Go to Settings → System Settings → COMP/CON Login");
            return;
        }

        ui.notifications.info("Fetching NPCs from Comp/Con...");

        // Récupérer les NPCs
        const res = await Storage.list("npc", {
            level: "protected",
            cacheControl: "no-cache"
        });

        const active = res.results.filter(x => x.key?.endsWith("--active"));

        if (active.length === 0) {
            ui.notifications.warn("No NPCs found in Comp/Con roster");
            return;
        }

        // Récupérer tous les NPCs
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

        // Afficher la dialog de sélection des NPCs
        new NPCSelectionDialog(validNPCs).render(true);

    } catch (error) {
        console.error("Error fetching NPCs from Comp/Con:", error);
        ui.notifications.error(`Error: ${error.message}`);
    }
}

// Dialog pour sélectionner les NPCs à importer depuis CompCon
class NPCSelectionDialog extends Dialog {
    constructor(npcs) {
        const content = `
            <form>
                <div class="npc-import-options">
                    <label class="import-option-label">
                        <input type="checkbox" id="update-existing" checked>
                        <span>Update existing NPCs (keep token image & settings)</span>
                    </label>

                    <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255, 255, 255, 0.2);">
                        <div style="margin-bottom: 8px; color: #000000; font-weight: 600;">Custom Tier Scaling:</div>
                        <label class="import-option-label radio-label">
                            <input type="radio" name="custom-tier-mode" value="scaled" checked>
                            <span>Scaled (keep tier increments: 0/2/4 if base was 10/12/14)</span>
                        </label>
                        <label class="import-option-label radio-label">
                            <input type="radio" name="custom-tier-mode" value="flat">
                            <span>Flat (same stats for all tiers: 0/0/0)</span>
                        </label>
                    </div>
                </div>
                <div class="npc-list-container">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                        <p style="margin: 0; color: #000000; font-weight: 600;">
                            Select NPCs to import (${npcs.length} available)
                        </p>
                        <p style="margin: 0; color: #ff4141; font-weight: 600;">
                            <span id="selected-count">0</span> selected
                        </p>
                    </div>
                    <div class="npc-search-container">
                        <input type="text" id="npc-search" placeholder="Search NPCs by name, class, or tier..." autocomplete="off">
                        <i class="fas fa-search search-icon"></i>
                    </div>
                    <div class="npc-list">
                        ${npcs.map((npc, index) => {
                            const imageUrl = npc.json.cloud_portrait || npc.json.localImage || '';
                            return `
                            <label class="npc-item" data-npc-name="${npc.name.toLowerCase()}" data-npc-class="${npc.class.toLowerCase()}" data-npc-tier="${npc.tier}" data-npc-tag="${(npc.tag || '').toLowerCase()}">
                                <input type="checkbox" class="npc-checkbox" data-index="${index}">
                                <div class="npc-info">
                                    <div class="npc-name">${npc.name}</div>
                                    <div class="npc-details">
                                        ${npc.class} - Tier ${npc.tier}${npc.tag ? ` - ${npc.tag}` : ''}
                                    </div>
                                </div>
                                ${imageUrl ? `<img src="${imageUrl}" class="npc-portrait" alt="${npc.name}">` : ''}
                            </label>
                        `}).join('')}
                    </div>
                </div>
                <div class="npc-actions">
                    <button type="button" id="select-all" class="npc-action-btn">
                        <i class="fas fa-check-square"></i> Select All
                    </button>
                    <button type="button" id="deselect-all" class="npc-action-btn">
                        <i class="fas fa-square"></i> Deselect All
                    </button>
                </div>
            </form>
            <style>
                .npc-import-options {
                    margin-bottom: 15px;
                    padding: 10px;
                    background: rgba(255, 65, 65, 0.1);
                    border: 1px solid rgba(255, 65, 65, 0.3);
                    border-radius: 3px;
                }
                .import-option-label {
                    display: flex;
                    align-items: center;
                    cursor: pointer;
                    color: #000000;
                    font-weight: 600;
                }
                .import-option-label input[type="checkbox"],
                .import-option-label input[type="radio"] {
                    margin-right: 8px;
                    width: 18px;
                    height: 18px;
                    cursor: pointer;
                }
                .import-option-label span {
                    user-select: none;
                }
                .radio-label {
                    margin-left: 10px;
                    font-weight: 400;
                }
                .npc-list-container {
                    max-height: 500px;
                    min-height: auto;
                }
                .npc-list-container p {
                    color: #000000;
                    font-weight: 600;
                }
                .npc-search-container {
                    position: relative;
                    margin-bottom: 10px;
                }
                .npc-search-container input {
                    width: 100%;
                    padding: 8px 35px 8px 10px;
                    background: rgba(0, 0, 0, 0.3);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    border-radius: 3px;
                    color: #ffffff;
                    font-size: 14px;
                }
                .npc-search-container input::placeholder {
                    color: #999999;
                }
                .npc-search-container input:focus {
                    outline: none;
                    border-color: rgba(255, 65, 65, 0.6);
                    box-shadow: 0 0 5px rgba(255, 65, 65, 0.3);
                }
                .search-icon {
                    position: absolute;
                    right: 10px;
                    top: 50%;
                    transform: translateY(-50%);
                    color: #999999;
                    pointer-events: none;
                }
                .npc-item.hidden {
                    display: none;
                }
                .npc-list {
                    display: grid;
                    grid-template-columns: repeat(2, 1fr);
                    gap: 8px;
                    max-height: 400px;
                    overflow-y: auto;
                }
                .npc-item {
                    display: flex;
                    align-items: center;
                    padding: 10px;
                    background: rgba(0, 0, 0, 0.3);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 3px;
                    cursor: pointer;
                    transition: all 0.2s;
                }
                .npc-item:hover {
                    background: rgba(255, 65, 65, 0.15);
                    border-color: rgba(255, 65, 65, 0.4);
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
                .npc-actions {
                    margin-top: 15px;
                    display: flex;
                    gap: 10px;
                }
                .npc-action-btn {
                    padding: 8px 16px;
                    background: rgba(255, 255, 255, 0.9);
                    border: 1px solid rgba(0, 0, 0, 0.2);
                    border-radius: 3px;
                    cursor: pointer;
                    color: #000000;
                    font-weight: 600;
                    transition: all 0.2s;
                }
                .npc-action-btn:hover {
                    background: rgba(255, 65, 65, 0.9);
                    border-color: rgba(255, 65, 65, 1);
                    color: #ffffff;
                }
                .npc-action-btn i {
                    margin-right: 5px;
                }
            </style>
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

                        const updateExisting = html.find('#update-existing').is(':checked');
                        const customTierMode = html.find('input[name="custom-tier-mode"]:checked').val();
                        const selectedNPCs = selectedIndices.map(i => npcs[i]);
                        await importSelectedNPCs(selectedNPCs, updateExisting, customTierMode);
                    }
                },
                cancel: {
                    icon: '<i class="fas fa-times"></i>',
                    label: "Cancel"
                }
            },
            default: "import"
        }, {
            width: 600,
            height: "auto",
            classes: ["npc-import-dialog"]
        });

        this.npcs = npcs;
    }

    activateListeners(html) {
        super.activateListeners(html);

        // Fix button heights
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

        // Function to update selection count
        const updateCount = () => {
            const count = html.find('.npc-checkbox:checked').length;
            html.find('#selected-count').text(count);
        };

        // Update count when checkboxes change
        html.find('.npc-checkbox').on('change', updateCount);

        // Search functionality
        html.find('#npc-search').on('input', function() {
            const searchTerm = $(this).val().toLowerCase().trim();

            html.find('.npc-item').each(function() {
                const $item = $(this);
                const name = $item.data('npc-name') || '';
                const npcClass = $item.data('npc-class') || '';
                const tier = String($item.data('npc-tier') || '').toLowerCase();
                const tag = $item.data('npc-tag') || '';

                const matches = searchTerm === '' ||
                    name.includes(searchTerm) ||
                    npcClass.includes(searchTerm) ||
                    tier.includes(searchTerm) ||
                    tag.includes(searchTerm);

                $item.toggleClass('hidden', !matches);
            });
        });

        // Select All button (only visible NPCs)
        html.find('#select-all').click(() => {
            html.find('.npc-item:not(.hidden) .npc-checkbox').prop('checked', true);
            updateCount();
        });

        // Deselect All button (only visible NPCs)
        html.find('#deselect-all').click(() => {
            html.find('.npc-item:not(.hidden) .npc-checkbox').prop('checked', false);
            updateCount();
        });
    }
}

// Importer les NPCs sélectionnés
async function importSelectedNPCs(npcs, updateExisting = true, customTierMode = 'scaled') {
    ui.notifications.info(`Importing ${npcs.length} NPC(s)...`);

    let successCount = 0;
    let errorCount = 0;
    let updateCount = 0;

    for (const npc of npcs) {
        try {
            ui.notifications.info(`Importing: ${npc.name}`);
            const result = await importNPCFromCompCon(npc.json, updateExisting, customTierMode);

            if (result.updated) {
                updateCount++;
            }
            successCount++;
        } catch (error) {
            console.error(`Error importing ${npc.name}:`, error);
            ui.notifications.error(`Failed to import ${npc.name}: ${error.message}`);
            errorCount++;
        }
    }

    if (successCount > 0) {
        const message = updateCount > 0
            ? `✓ Successfully imported ${successCount} NPC(s) (${updateCount} updated, ${successCount - updateCount} created)`
            : `✓ Successfully imported ${successCount} NPC(s)`;
        ui.notifications.info(message);
    }
    if (errorCount > 0) {
        ui.notifications.warn(`✗ Failed to import ${errorCount} NPC(s)`);
    }
}


// Applique les customisations des features (tier override, custom name, etc.)
async function applyFeatureCustomizations(actor, npcData) {
    try {
        if (!npcData.items || npcData.items.length === 0) {
            return;
        }

        const updates = [];
        const tierOverrides = [];

        for (const ccItem of npcData.items) {
            // Trouver la feature dans l'acteur par son LID
            const feature = actor.items.find(i =>
                i.type === 'npc_feature' &&
                i.system.lid === ccItem.itemID
            );

            if (!feature) {
                continue;
            }

            const updateData = { _id: feature.id };
            let hasChanges = false;

            // Appliquer le custom name si fourni
            if (ccItem.flavorName) {
                updateData['name'] = ccItem.flavorName;
                updateData['system.custom_name'] = ccItem.flavorName;
                hasChanges = true;
            }

            // Appliquer la custom description si fournie
            if (ccItem.description) {
                updateData['system.custom_description'] = ccItem.description;
                hasChanges = true;
            }

            // Vérifier si un tier override est nécessaire
            if (ccItem.tier !== undefined && ccItem.tier !== npcData.tier) {
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

        // Avertir si des features ont des tiers différents
        if (tierOverrides.length > 0) {
            const featureList = tierOverrides.map(f => `${f.name} (T${f.tier})`).join(', ');
            ui.notifications.warn(
                `⚠ NPC "${actor.name}": ${tierOverrides.length} feature(s) with different tiers not applied: ${featureList}`,
                { permanent: false }
            );
            console.warn(`Features with tier overrides for ${actor.name}:`, tierOverrides);
        }
    } catch (error) {
        console.error(`Error applying feature customizations:`, error);
        ui.notifications.warn(`⚠ Could not apply feature customizations to "${actor.name}"`);
    }
}

// Applique les stats custom aux tiers de la classe NPC dans l'acteur
async function applyCustomTierStats(actor, npcData, mode = 'scaled') {
    try {
        // Trouver la classe NPC dans les items de l'acteur
        const npcClass = actor.items.find(i => i.type === 'npc_class' && i.system.lid === npcData.class);

        if (!npcClass) {
            console.warn(`Could not find NPC class ${npcData.class} in actor items`);
            return;
        }

        // Récupérer les stats de base de Comp/Con (sans les bonuses des templates)
        const customStats = npcData.stats || {};
        const originalStats = npcClass.system.base_stats;

        // Fonction pour calculer une stat selon le mode
        const calculateStat = (statName, ccKey, tierIndex) => {
            const customValue = customStats[ccKey];
            const originalValue = originalStats[tierIndex][statName];

            // Si pas de valeur custom définie, garder l'original
            if (customValue === undefined) {
                return originalValue;
            }

            // Mode flat: même valeur pour tous les tiers
            if (mode === 'flat') {
                return customValue;
            }

            // Mode scaled: garder les incréments entre tiers
            if (mode === 'scaled') {
                const tier1Original = originalStats[0][statName];
                const increment = originalValue - tier1Original;
                return customValue + increment;
            }

            return customValue;
        };

        // Construire les stats pour les 3 tiers
        const newBaseStats = [0, 1, 2].map(tierIndex => ({
            activations: calculateStat('activations', 'activations', tierIndex),
            armor: calculateStat('armor', 'armor', tierIndex),
            hp: calculateStat('hp', 'hp', tierIndex),
            evasion: calculateStat('evasion', 'evade', tierIndex),
            edef: calculateStat('edef', 'edef', tierIndex),
            heatcap: calculateStat('heatcap', 'heatcap', tierIndex),
            speed: calculateStat('speed', 'speed', tierIndex),
            sensor: calculateStat('sensor', 'sensor', tierIndex),
            save: calculateStat('save', 'save', tierIndex),
            hull: calculateStat('hull', 'hull', tierIndex),
            agi: calculateStat('agi', 'agility', tierIndex),
            sys: calculateStat('sys', 'systems', tierIndex),
            eng: calculateStat('eng', 'engineering', tierIndex),
            size: calculateStat('size', 'size', tierIndex),
            structure: calculateStat('structure', 'structure', tierIndex),
            stress: calculateStat('stress', 'stress', tierIndex)
        }));

        // Renommer la classe avec "CUSTOM"
        const newName = npcClass.name.includes('CUSTOM')
            ? npcClass.name
            : `${npcClass.name} CUSTOM`;

        // Mettre à jour la classe NPC avec les nouvelles stats et le nouveau nom
        await npcClass.update({
            'name': newName,
            'system.base_stats': newBaseStats
        });

        console.log(`Applied custom tier stats (${mode}) to ${newName} for ${actor.name}`);
        ui.notifications.info(`✓ Applied custom tier stats (${mode}) to "${actor.name}"`);
    } catch (error) {
        console.error(`Error applying custom tier stats:`, error);
        ui.notifications.warn(`⚠ Could not apply custom tier stats to "${actor.name}"`);
    }
}

async function importNPCFromCompCon(npcData, updateExisting = true, customTierMode = 'scaled') {
    const isCustomTier = npcData.tier === 'custom';

    // Chercher si le NPC existe déjà (par lid)
    let existingActor = null;
    if (updateExisting && npcData.id) {
        existingActor = game.actors.find(a => a.type === 'npc' && a.system.lid === npcData.id);
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

    if (existingActor) {
        // Update existant - on garde le token et l'image
        console.log(`Updating existing NPC: ${existingActor.name}`);

        await existingActor.update({
            name: npcData.name,
            system: systemData
            // On ne met PAS à jour 'img' ni 'prototypeToken'
        });

        actor = existingActor;
        wasUpdated = true;
    } else {
        // Création nouveau
        const actorData = {
            name: npcData.name,
            type: 'npc',
            system: systemData,
            img: npcData.cloud_portrait || npcData.localImage || 'icons/svg/mystery-man.svg'
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
            ui.notifications.warn(`⚠ NPC "${npcData.name}": Class not found - ${npcData.class}`);
        }
    }

    if (npcData.templates?.length > 0) {
        for (const templateLid of npcData.templates) {
            const template = await findItemByLid(templateLid, 'npc_template');
            if (template) {
                classAndTemplates.push(template.toObject());
            } else {
                missingItems.push(`Template: ${templateLid}`);
                ui.notifications.warn(`⚠ NPC "${npcData.name}": Template not found - ${templateLid}`);
            }
        }
    }

    if (classAndTemplates.length > 0) {
        await actor.createEmbeddedDocuments('Item', classAndTemplates);
    }

    await new Promise(resolve => setTimeout(resolve, 500));

    // Si custom tier, appliquer les stats custom aux tiers de la classe
    if (isCustomTier && npcData.class) {
        await applyCustomTierStats(actor, npcData, customTierMode);
    }

    const allFeatures = actor.items.filter(i => i.type === 'npc_feature');
    if (allFeatures.length > 0) {
        await actor.deleteEmbeddedDocuments('Item', allFeatures.map(i => i.id));
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

    if (featuresToAdd.length > 0) {
        await actor.createEmbeddedDocuments('Item', featuresToAdd);
    }



    // Appliquer les customisations des features (tier override, custom names, etc.)
    await applyFeatureCustomizations(actor, npcData);

    // Afficher un résumé des features manquantes
    if (missingFeatures.length > 0) {
        ui.notifications.warn(`⚠ NPC "${npcData.name}": ${missingFeatures.length} feature(s) not found in compendiums`);
        console.warn(`Missing features for ${npcData.name}:`, missingFeatures);
    }

    // Afficher un message de succès ou d'avertissement
    if (missingItems.length > 0 || missingFeatures.length > 0) {
        const total = missingItems.length + missingFeatures.length;
        ui.notifications.warn(`⚠ NPC "${npcData.name}" imported with ${total} missing item(s). Check console for details.`);
    }

    return { actor, updated: wasUpdated };
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

// ============================================================================
// EXECUTE MACRO
// ============================================================================

ImportNPC();
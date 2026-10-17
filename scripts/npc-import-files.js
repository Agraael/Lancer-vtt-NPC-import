// JSON file import. Auto-detects pilot vs NPC per file.

import { unwrapData } from "./v3-api.js";
import { windowLog } from "./sync-log.js";
import { normalizeNpcData, importSelectedNPCs } from "./npc-import-core.js";
import { importSelectedPilots } from "./pilot-import-core.js";

export function detectActorKind(json)
{
    if (!json || typeof json !== "object")
        return null;
    const hasPilotMarkers = json.callsign !== undefined
        || Array.isArray(json.mechs)
        || Array.isArray(json.loadouts)
        || json.cloudID !== undefined;
    if (hasPilotMarkers)
        return "pilot";
    const hasNpcMarkers = (json.class !== undefined)
        && (json.combat_data !== undefined || json.tier !== undefined);
    if (hasNpcMarkers)
        return "npc";
    return null;
}

export async function importFromFiles()
{
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
                    <div class="lancer-toggle-card" data-setting="manual-replace" id="manual-replace-card" title="Pick which actor each NPC overwrites instead of matching by LID. Optionally keep the actor's name.">
                        <div class="lancer-toggle-card-icon"><i class="fas fa-times"></i></div>
                        <div class="lancer-toggle-card-text">Pick target actor per NPC</div>
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
                callback: async (html) =>
                {
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
        render: (html) =>
        {
            html.find('.lancer-toggle-card').click(function()
            {
                const setting = $(this).data('setting');
                const isActive = $(this).hasClass('active');

                if (setting === 'update-existing' || setting === 'manual-replace')
                {
                    const otherCard = setting === 'update-existing' ? '#manual-replace-card' : '#update-existing-card';

                    $(this).toggleClass('active');
                    const icon = $(this).find('.lancer-toggle-card-icon i');
                    const hiddenInput = $(this).find('input[type="hidden"]');

                    if (isActive)
                    {
                        icon.removeClass('fa-check').addClass('fa-times');
                        hiddenInput.val('false');
                    }
                    else
                    {
                        icon.removeClass('fa-times').addClass('fa-check');
                        hiddenInput.val('true');

                        html.find(otherCard).removeClass('active');
                        html.find(otherCard).find('.lancer-toggle-card-icon i').removeClass('fa-check').addClass('fa-times');
                        html.find(otherCard).find('input[type="hidden"]').val('false');
                    }
                }
            });

            html.find('.lancer-scaling-card').click(function()
            {
                html.find('.lancer-scaling-card').removeClass('selected');
                $(this).addClass('selected');
                const mode = $(this).data('mode');
                html.find('#custom-tier-mode').val(mode);
            });
        }
    }, {
        classes: ["lancer-file-import-dialog", "lancer-dialog-base", "lancer-no-title"]
    });

    scalingDialog.render(true);
}

export async function selectActorMappings(npcsToImport)
{
    return new Promise((resolve) =>
    {
        const allActors = game.actors.filter(actor => actor.type === 'npc');

        const actorOptions = `<option value="new">── Create New ──</option>
            ${allActors.map(actor => `<option value="${actor.id}">${actor.name}  (${actor.system.class?.name || 'Unknown'})-(${actor.system.tier ? 'T' + actor.system.tier : 'Unknown'})</option>`).join('')}`;

        const content = `
            <div class="lancer-dialog-base">
                <div class="lancer-dialog-header">
                    <div class="lancer-dialog-title">PICK TARGET // ACTOR MAPPING</div>
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
                    callback: (html) =>
                    {
                        const mappings = [];
                        npcsToImport.forEach((npc, index) =>
                        {
                            const selectedValue = html.find(`.target-select[data-index="${index}"]`).val();
                            const keepName = html.find(`.keep-name-toggle[data-index="${index}"]`).hasClass('active');

                            if (selectedValue === 'new')
                            {
                                mappings.push({ npc, targetActor: null, keepName: false });
                            }
                            else
                            {
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
            render: (html) =>
            {
                html.find('.target-select').on('change', function()
                {
                    const index = $(this).data('index');
                    const selectedValue = $(this).val();
                    const keepNameToggle = html.find(`.keep-name-toggle[data-index="${index}"]`);

                    if (selectedValue === 'new')
                    {
                        keepNameToggle.removeClass('visible active');
                        keepNameToggle.find('i').removeClass('fa-check').addClass('fa-times');
                    }
                    else
                    {
                        keepNameToggle.addClass('visible');
                    }
                });

                html.find('.keep-name-toggle').click(function()
                {
                    const isActive = $(this).hasClass('active');
                    $(this).toggleClass('active');

                    const icon = $(this).find('i');
                    if (isActive)
                    {
                        icon.removeClass('fa-check').addClass('fa-times');
                    }
                    else
                    {
                        icon.removeClass('fa-times').addClass('fa-check');
                    }
                });
            }
        }, {
            width: 600,
            height: 600,
            classes: ["mapping-dialog", "lancer-dialog-base", "lancer-no-title"],
            resizable: true
        });

        dialog.render(true);
    });
}

export async function selectAndImportFiles(customTierMode, updateExisting = true, manualReplace = false)
{
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.multiple = true;

    input.onchange = async (event) =>
    {
        const files = Array.from(event.target.files);
        if (files.length === 0)
            return;

        const npcsToImport = [];
        const pilotsToImport = [];
        for (const file of files)
        {
            try
            {
                const text = await file.text();
                const raw = unwrapData(JSON.parse(text));
                const kind = detectActorKind(raw);

                if (kind === "pilot")
                {
                    if (!raw.name)
                    {
                        ui.notifications.error(`Invalid pilot JSON: ${file.name} - missing name`);
                        continue;
                    }
                    pilotsToImport.push({ name: raw.name, json: raw });
                }
                else if (kind === "npc")
                {
                    const npcData = normalizeNpcData(raw);
                    if (!npcData.class || !npcData.name)
                    {
                        ui.notifications.error(`Invalid NPC JSON: ${file.name} - missing required fields`);
                        continue;
                    }
                    npcsToImport.push(npcData);
                }
                else
                {
                    ui.notifications.warn(`Skipped ${file.name}: not a recognized pilot or NPC JSON`);
                }
            }
            catch (error)
            {
                console.error(`lancer-npc-import | Error parsing ${file.name}:`, error);
                ui.notifications.error(`Failed to parse ${file.name}: ${error.message}`);
            }
        }

        if (pilotsToImport.length > 0)
            await importSelectedPilots(pilotsToImport, updateExisting, windowLog("Import log", "JSON → Foundry"));

        if (npcsToImport.length === 0)
        {
            if (pilotsToImport.length === 0)
                ui.notifications.warn("No valid actors to import");
            return;
        }

        let mappings = null;
        if (manualReplace)
        {
            mappings = await selectActorMappings(npcsToImport);

            if (mappings === null)
            {
                ui.notifications.info("Import cancelled");
                return;
            }
        }

        const selection = npcsToImport.map((npcData, npcIndex) =>
        {
            const mapping = mappings?.[npcIndex];
            return { npc: { name: npcData.name, json: npcData }, replace: mapping?.targetActor ? mapping : null };
        });
        await importSelectedNPCs(selection, { customTierMode, updateExisting }, windowLog("Import log", "JSON → Foundry"));
    };

    input.click();
}

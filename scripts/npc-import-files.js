// JSON file import. Auto-detects pilot vs NPC per file.

import { unwrapData } from "./v3-api.js";
import { ImportProgressDialog } from "./npc-import-ui.js";
import { normalizeNpcData, importNPCFromCompCon } from "./npc-import-core.js";
import { importOnePilot } from "./pilot-import-core.js";

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
            ${allActors.map(actor => `<option value="${actor.id}">${actor.name}  (${actor.system.class.name ? actor.system.class.name : 'Unknown'})-(${actor.system.tier ? 'T' + actor.system.tier : 'Unknown'})</option>`).join('')}`;

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
                console.error(`Error parsing ${file.name}:`, error);
                ui.notifications.error(`Failed to parse ${file.name}: ${error.message}`);
            }
        }

        if (pilotsToImport.length > 0)
            await _importPilotFiles(pilotsToImport, updateExisting);

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

        const progressDialog = new ImportProgressDialog(npcsToImport.length);
        progressDialog.render(true);
        progressDialog.addLog(`Starting import of ${npcsToImport.length} NPC(s)...`, 'info');

        let successCount = 0;
        let errorCount = 0;
        let updateCount = 0;
        let replaceCount = 0;

        for (let i = 0; i < npcsToImport.length; i++)
        {
            const npcData = npcsToImport[i];
            let targetActor = null;
            let keepName = false;

            if (mappings && mappings[i])
            {
                targetActor = mappings[i].targetActor;
                keepName = mappings[i].keepName;
            }

            try
            {
                progressDialog.addLog(`Importing: ${npcData.name}...`, 'info');
                const result = await importNPCFromCompCon(npcData, updateExisting, customTierMode, targetActor, keepName, progressDialog);

                if (result.updated)
                {
                    updateCount++;
                    progressDialog.addLog(`✓ Updated: ${npcData.name}`, 'success');
                }
                else if (result.replaced)
                {
                    replaceCount++;
                    progressDialog.addLog(`✓ Replaced: ${npcData.name}`, 'success');
                }
                else
                {
                    progressDialog.addLog(`✓ Created: ${npcData.name}`, 'success');
                }
                successCount++;
            }
            catch (error)
            {
                console.error(`Error importing ${npcData.name}:`, error);
                progressDialog.addLog(`✗ Failed: ${npcData.name} - ${error.message}`, 'error');
                errorCount++;
            }

            progressDialog.incrementProgress();
        }

        let summaryParts = [];
        const created = successCount - replaceCount - updateCount;
        if (created > 0)
            summaryParts.push(`${created} created`);
        if (updateCount > 0)
            summaryParts.push(`${updateCount} updated`);
        if (replaceCount > 0)
            summaryParts.push(`${replaceCount} replaced`);
        if (errorCount > 0)
            summaryParts.push(`${errorCount} failed`);

        const summaryMessage = `Import completed: ${summaryParts.join(', ')}`;
        progressDialog.addLog(summaryMessage, errorCount > 0 ? 'warning' : 'success');

        if (successCount > 0)
        {
            ui.notifications.info(`✓ Imported ${successCount} NPC(s)`);
        }
        if (errorCount > 0)
        {
            ui.notifications.warn(`✗ ${errorCount} NPC(s) failed to import`);
        }
    };

    input.click();
}

async function _importPilotFiles(pilots, updateExisting)
{
    const progress = new ImportProgressDialog(pilots.length);
    progress.render(true);
    progress.addLog(`Starting import of ${pilots.length} pilot(s)...`, "info");
    let created = 0, updated = 0, failed = 0;
    for (const pilot of pilots)
    {
        try
        {
            progress.addLog(`Importing: ${pilot.name}...`, "info");
            const result = await importOnePilot(pilot.json, { updateExisting });
            if (result.updated) { updated++; progress.addLog(`✓ Updated: ${pilot.name}`, "success"); }
            else           { created++; progress.addLog(`✓ Created: ${pilot.name}`, "success"); }
        }
        catch (e)
        {
            console.error(`pilot import failed for ${pilot.name}:`, e);
            progress.addLog(`✗ Failed: ${pilot.name} - ${e.message}`, "error");
            failed++;
        }
        progress.incrementProgress();
    }
    const parts = [];
    if (created)
        parts.push(`${created} created`);
    if (updated)
        parts.push(`${updated} updated`);
    if (failed)
        parts.push(`${failed} failed`);
    progress.addLog(`Pilot import done: ${parts.join(", ")}`, failed ? "warning" : "success");
    if (created + updated > 0)
        ui.notifications.info(`✓ Imported ${created + updated} pilot(s)`);
    if (failed > 0)
        ui.notifications.warn(`✗ ${failed} pilot(s) failed`);
}

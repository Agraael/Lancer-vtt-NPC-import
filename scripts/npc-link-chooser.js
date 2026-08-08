// Per-NPC link chooser dialog: shown when Link Actors has more than one
// same-name candidate, or when the user opts in to picking explicitly.

function _esc(value)
{
    return foundry.utils.escapeHTML?.(String(value ?? "")) ?? String(value ?? "");
}

function _candidateRow(actor, checked, isLinkedAlready)
{
    const folder = actor.folder?.name ? `Folder: ${actor.folder.name}` : "(no folder)";
    const lid = actor.system?.lid ? ` · lid: ${actor.system.lid}` : "";
    const tag = isLinkedAlready ? `<span class="link-tag link-tag--linked">linked</span>` : "";
    return `
        <label class="link-candidate-row${isLinkedAlready ? " is-linked" : ""}">
            <input type="checkbox" class="link-candidate-check" data-actor-id="${actor.id}" ${checked ? "checked" : ""}>
            <div class="link-candidate-info">
                <div class="link-candidate-name">${_esc(actor.name)} ${tag}</div>
                <div class="link-candidate-meta">${_esc(folder)}${_esc(lid)}</div>
            </div>
        </label>
    `;
}

export async function showLinkChooser(cloudNpc, alreadyLinked = [])
{
    const nameLower = (cloudNpc.json?.name || cloudNpc.name || "").toLowerCase();
    const sameName = game.actors.filter(actor =>
        actor.type === "npc" && actor.name.toLowerCase() === nameLower
    );
    const initialLinkedIds = new Set(alreadyLinked.map(actor => actor.id));
    const initialUnion = [...alreadyLinked];
    for (const actor of sameName)
        if (!initialLinkedIds.has(actor.id))
            initialUnion.push(actor);
    let candidateIds = new Set(initialUnion.map(actor => actor.id));
    let checkedIds = new Set(initialUnion.map(actor => actor.id));

    return new Promise((resolve) =>
    {
        function content()
        {
            const candidates = [...candidateIds].map(id => game.actors.get(id)).filter(Boolean);
            const rows = candidates.length
                ? candidates.map(actor => _candidateRow(actor, checkedIds.has(actor.id), initialLinkedIds.has(actor.id))).join("")
                : `<div class="link-candidate-empty">No same-name NPC actors. Use "Add another actor" to pick one.</div>`;
            return `
                <div class="lancer-dialog-base link-chooser">
                    <div class="lancer-dialog-header">
                        <div class="lancer-dialog-title">LINK CLOUD NPC</div>
                        <div class="lancer-dialog-subtitle">${_esc(cloudNpc.json?.name || cloudNpc.name)}</div>
                    </div>
                    <div class="link-candidates">${rows}</div>
                    <div class="link-add-row">
                        <select id="link-add-pick">
                            <option value="">-- pick another NPC actor to link --</option>
                            ${game.actors
        .filter(actor => actor.type === "npc" && !candidateIds.has(actor.id))
        .sort((actorA, actorB) => actorA.name.localeCompare(actorB.name))
        .map(actor => `<option value="${actor.id}">${_esc(actor.name)}${actor.folder?.name ? ` (${_esc(actor.folder.name)})` : ""}</option>`)
        .join("")}
                        </select>
                        <button type="button" class="lancer-action-btn" id="link-add-btn">
                            <i class="fas fa-plus"></i> Add
                        </button>
                    </div>
                </div>
            `;
        }

        const dlg = new Dialog({
            title: "Link Cloud NPC",
            content: content(),
            buttons: {
                link: {
                    icon: '<i class="fas fa-link"></i>',
                    label: "Apply",
                    callback: (html) =>
                    {
                        const checkedNow = new Set();
                        html.find(".link-candidate-check:checked").each(function()
                        {
                            checkedNow.add($(this).data("actor-id"));
                        });
                        const toLink = [];
                        const toUnlink = [];
                        for (const id of candidateIds)
                        {
                            const actor = game.actors.get(id);
                            if (!actor)
                                continue;
                            const was = initialLinkedIds.has(id);
                            const now = checkedNow.has(id);
                            if (now)
                                toLink.push(actor);
                            else if (was)
                                toUnlink.push(actor);
                        }
                        resolve({ toLink, toUnlink });
                    }
                },
                skip: {
                    icon: '<i class="fas fa-forward"></i>',
                    label: "Skip",
                    callback: () => resolve({ toLink: [], toUnlink: [] })
                },
                cancel: {
                    icon: '<i class="fas fa-times"></i>',
                    label: "Cancel All",
                    callback: () => resolve(null)
                }
            },
            default: "link",
            close: () => resolve({ toLink: [], toUnlink: [] })
        }, {
            width: 520,
            height: "auto",
            classes: ["link-chooser-dialog", "lancer-dialog-base", "lancer-no-title"]
        });

        // Re-render when the user adds another actor.
        dlg.render(true);
        const wireAdd = () =>
        {
            const $root = dlg.element;
            if (!$root)
                return;
            $root.find("#link-add-btn").off("click").on("click", () =>
            {
                const id = String($root.find("#link-add-pick").val() || "");
                if (!id)
                    return;
                candidateIds.add(id);
                checkedIds.add(id);
                // Preserve currently checked state of others
                $root.find(".link-candidate-check").each(function()
                {
                    const aid = $(this).data("actor-id");
                    if ($(this).prop("checked"))
                        checkedIds.add(aid);
                    else
                        checkedIds.delete(aid);
                });
                const $content = $root.find(".dialog-content");
                $content.html(content());
                wireAdd();
            });
        };
        Hooks.once("renderDialog", () => wireAdd());
        setTimeout(wireAdd, 50);
    });
}

export async function applyLink(actors, npcId)
{
    for (const actor of actors)
        await actor.update({ "system.lid": npcId });
    return actors.length;
}

export async function applyUnlink(actors)
{
    for (const actor of actors)
        await actor.update({ "system.lid": "" });
    return actors.length;
}

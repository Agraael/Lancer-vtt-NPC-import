import {
    applyRefresh,
    buildLidIndex,
    classifyActorItems,
    collectNeededPackDocs,
    isRefreshableActor,
    prefetchPackDocs
} from "./refresh-core.js";
import { loadLcpFile } from "./refresh-lcp-file.js";

const STATUS_LABELS = {
    synced: "Synced",
    modified: "Modified",
    unlinked: "Unlinked",
    missing: "Missing"
};

const ACTIONABLE = new Set(["modified", "unlinked"]);

class RefreshProgressDialog
{
    constructor()
    {
        this.dialog = null;
        this.label = "Working...";
        this.current = 0;
        this.total = 0;
    }

    open(initialLabel = "Working...")
    {
        this.label = initialLabel;
        this.dialog = new Dialog({
            title: "Refresh: scanning",
            content: this.#html(),
            buttons: {},
            close: () => {}
        }, {
            width: 420,
            height: "auto",
            classes: ["lancer-refresh-progress-dialog", "lancer-dialog-base", "lancer-no-title"]
        });
        this.dialog.render(true);
    }

    update(current, total, label)
    {
        this.current = current;
        this.total = total;
        if (label)
            this.label = label;
        const root = this.dialog?.element?.[0];
        if (!root)
            return;
        const pct = total ? Math.round((current / total) * 100) : 0;
        const lbl = root.querySelector(".refresh-progress-label");
        const fill = root.querySelector(".refresh-progress-fill");
        const counts = root.querySelector(".refresh-progress-counts");
        if (lbl)
            lbl.textContent = this.label;
        if (fill)
            fill.style.width = pct + "%";
        if (counts)
            counts.textContent = `${current} / ${total}`;
    }

    close()
    {
        try { this.dialog?.close({ force: true }); }
        catch { /* ignore */ }
        this.dialog = null;
    }

    #html()
    {
        return `
            <div class="refresh-progress">
                <div class="refresh-progress-label">${escapeHtml(this.label)}</div>
                <div class="refresh-progress-bar"><div class="refresh-progress-fill" style="width:0%"></div></div>
                <div class="refresh-progress-counts">${this.current} / ${this.total}</div>
            </div>
        `;
    }
}

// yield so the progress dialog can repaint
async function tick() { return new Promise(r => setTimeout(r, 0)); }

class RefreshPackPicker
{
    static SETTING_ITEM = "refreshItemPacks";
    static SETTING_ACTOR = "refreshActorPacks";
    static SETTING_FOLDERS = "refreshFolders";
    static NOFOLDER_ID = "__nofolder__";

    static show(mode)
    {
        return new Promise(resolve =>
        {
            const itemPacks = game.packs.filter(p => p.metadata.type === "Item");
            const actorPacks = mode === "all"
                ? game.packs.filter(p => p.metadata.type === "Actor")
                : [];

            const savedItem = game.settings.get("lancer-npc-import", this.SETTING_ITEM) || [];
            const savedActor = game.settings.get("lancer-npc-import", this.SETTING_ACTOR) || [];
            const savedFolders = mode === "all"
                ? (game.settings.get("lancer-npc-import", this.SETTING_FOLDERS) || [])
                : [];
            const itemSelected = new Set(savedItem.length ? savedItem : itemPacks.map(p => p.collection));
            const actorSelected = new Set(savedActor);
            const folderSelected = new Set(savedFolders);

            const renderRow = (pack, selected) => `
                <label class="refresh-pack-row">
                    <input type="checkbox" data-collection="${escapeHtml(pack.collection)}" ${selected ? "checked" : ""}>
                    <span class="refresh-pack-label">${escapeHtml(pack.metadata.label)}</span>
                    <span class="refresh-pack-source">${escapeHtml(pack.metadata.packageName || pack.metadata.system || "")}</span>
                </label>
            `;

            const itemSection = `
                <div class="refresh-pack-section" data-kind="item">
                    <div class="refresh-pack-section-header">
                        <span><i class="fas fa-cube"></i> Item compendiums <em class="refresh-pack-required">required</em></span>
                        <span class="refresh-pack-bulk">
                            <button type="button" data-bulk="all">All</button>
                            <button type="button" data-bulk="none">None</button>
                        </span>
                    </div>
                    <div class="refresh-pack-hint">Source of truth. Each actor item is compared to its match in these packs.</div>
                    <div class="refresh-pack-list">
                        ${itemPacks.map(p => renderRow(p, itemSelected.has(p.collection))).join("")}
                    </div>
                </div>
            `;

            const actorFolders = mode === "all"
                ? game.folders.filter(f => f.type === "Actor")
                : [];
            const folderTree = [];
            const visit = (folder, depth) =>
            {
                folderTree.push({ folder, depth });
                actorFolders
                    .filter(f => f.folder?.id === folder.id)
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .forEach(c => visit(c, depth + 1));
            };
            actorFolders
                .filter(f => !f.folder)
                .sort((a, b) => a.name.localeCompare(b.name))
                .forEach(f => visit(f, 0));

            const countActorsInFolder = folderId =>
            {
                if (folderId === RefreshPackPicker.NOFOLDER_ID)
                {
                    return game.actors.filter(a => isRefreshableActor(a) && !a.folder).length;
                }
                return game.actors.filter(a => isRefreshableActor(a) && a.folder?.id === folderId).length;
            };

            const folderRows = folderTree
                .map(({ folder, depth }) => ({ folder, depth, count: countActorsInFolder(folder.id) }))
                .filter(({ count }) => count > 0)
                .map(({ folder, depth, count }) =>
                {
                    const checked = folderSelected.has(folder.id);
                    return `
                        <label class="refresh-pack-row refresh-folder-row" style="padding-left:${4 + depth * 14}px">
                            <input type="checkbox" data-folder="${escapeHtml(folder.id)}" ${checked ? "checked" : ""}>
                            <span class="refresh-pack-label"><i class="fas fa-folder"></i> ${escapeHtml(folder.name)}</span>
                            <span class="refresh-pack-source">${count} actor(s)</span>
                        </label>
                    `;
                }).join("");

            const noFolderCount = mode === "all" ? countActorsInFolder(RefreshPackPicker.NOFOLDER_ID) : 0;
            const noFolderRow = noFolderCount > 0 ? `
                <label class="refresh-pack-row refresh-folder-row">
                    <input type="checkbox" data-folder="${RefreshPackPicker.NOFOLDER_ID}" ${folderSelected.has(RefreshPackPicker.NOFOLDER_ID) ? "checked" : ""}>
                    <span class="refresh-pack-label"><i class="fas fa-folder-open"></i> (No folder)</span>
                    <span class="refresh-pack-source">${noFolderCount} actor(s)</span>
                </label>
            ` : "";

            const worldGroup = (folderTree.length || noFolderCount > 0)
                ? `
                    <div class="refresh-pack-group-header">World actors (by folder)</div>
                    ${folderRows}
                    ${noFolderRow}
                `
                : `<div class="refresh-pack-empty">No world actors.</div>`;

            const packGroup = actorPacks.length
                ? `
                    <div class="refresh-pack-group-header">Actor compendiums</div>
                    ${actorPacks.map(p => renderRow(p, actorSelected.has(p.collection))).join("")}
                `
                : "";

            const actorSection = mode === "all" ? `
                <div class="refresh-pack-section" data-kind="actor">
                    <div class="refresh-pack-section-header">
                        <span><i class="fas fa-user"></i> Actor scan targets</span>
                        <span class="refresh-pack-bulk">
                            <button type="button" data-bulk="all">All</button>
                            <button type="button" data-bulk="none">None</button>
                        </span>
                    </div>
                    <div class="refresh-pack-hint">Pick folders from the sidebar tab and/or actor compendiums.</div>
                    <div class="refresh-pack-list">
                        ${worldGroup}
                        ${packGroup}
                    </div>
                </div>
            ` : "";

            const lcpSection = `
                <div class="refresh-pack-section refresh-lcp-section">
                    <div class="refresh-pack-section-header">
                        <span><i class="fas fa-file-archive"></i> LCP file <em class="refresh-pack-optional">optional</em></span>
                    </div>
                    <div class="refresh-pack-hint">Restrict the refresh to LIDs from a single .lcp / .json file.</div>
                    <div class="refresh-lcp-row">
                        <button type="button" class="refresh-lcp-pick" data-act="lcp-pick">
                            <i class="fas fa-folder-open"></i> Choose .lcp / .json file...
                        </button>
                        <button type="button" class="refresh-lcp-clear" data-act="lcp-clear">Clear</button>
                        <input type="file" class="refresh-lcp-input" accept=".lcp,.zip,.json" style="display:none">
                    </div>
                    <div class="refresh-lcp-status">No LCP file loaded - scan covers every selected compendium item.</div>
                </div>
            `;

            const columns = mode === "all"
                ? `<div class="refresh-pack-columns">${itemSection}${actorSection}</div>`
                : itemSection;

            const content = `
                <div class="lancer-dialog-base lancer-refresh-content">
                    <div class="lancer-dialog-header">
                        <div class="lancer-dialog-title">REFRESH // PICK COMPENDIUMS</div>
                        <div class="lancer-dialog-subtitle">Only the selected packs will be scanned</div>
                    </div>
                    ${lcpSection}
                    ${columns}
                </div>
            `;

            let lcpLids = null;
            let lcpLabel = null;

            let resolved = false;
            const dlg = new Dialog({
                title: "Refresh: select compendiums",
                content,
                buttons: {
                    confirm: {
                        icon: '<i class="fas fa-check"></i>',
                        label: "Continue",
                        callback: html =>
                        {
                            const root = html instanceof HTMLElement ? html : html[0];
                            const itemColl = Array.from(root.querySelectorAll('[data-kind="item"] input[type="checkbox"]:checked'))
                                .filter(i => i.dataset.collection)
                                .map(i => i.dataset.collection);
                            let actorColl = [];
                            let folderIds = [];
                            if (mode === "all")
                            {
                                const checked = Array.from(root.querySelectorAll('[data-kind="actor"] input[type="checkbox"]:checked'));
                                actorColl = checked.filter(i => i.dataset.collection).map(i => i.dataset.collection);
                                folderIds = checked.filter(i => i.dataset.folder).map(i => i.dataset.folder);
                            }
                            game.settings.set("lancer-npc-import", RefreshPackPicker.SETTING_ITEM, itemColl);
                            if (mode === "all")
                            {
                                game.settings.set("lancer-npc-import", RefreshPackPicker.SETTING_ACTOR, actorColl);
                                game.settings.set("lancer-npc-import", RefreshPackPicker.SETTING_FOLDERS, folderIds);
                            }
                            resolved = true;
                            resolve({
                                itemPacks: itemPacks.filter(p => itemColl.includes(p.collection)),
                                actorPacks: actorPacks.filter(p => actorColl.includes(p.collection)),
                                folderIds,
                                lcpLids,
                                lcpLabel
                            });
                        }
                    },
                    cancel: {
                        icon: '<i class="fas fa-times"></i>',
                        label: "Cancel",
                        callback: () => { resolved = true; resolve(null); }
                    }
                },
                default: "confirm",
                close: () =>
                {
                    if (!resolved)
                        resolve(null);
                }
            }, {
                width: mode === "all" ? 880 : 560,
                height: "auto",
                resizable: true,
                classes: ["lancer-refresh-pack-dialog", "lancer-dialog-base", "lancer-no-title"]
            });

            dlg.render(true);

            Hooks.once("renderDialog", (app, html) =>
            {
                if (app !== dlg)
                    return;
                const root = html instanceof HTMLElement ? html : html[0];
                root.querySelectorAll('[data-bulk]').forEach(btn =>
                {
                    btn.addEventListener("click", ev =>
                    {
                        ev.preventDefault();
                        const section = btn.closest('.refresh-pack-section');
                        const checked = btn.dataset.bulk === "all";
                        section.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = checked; });
                    });
                });

                const fileInput = root.querySelector(".refresh-lcp-input");
                const status = root.querySelector(".refresh-lcp-status");
                const setStatus = (msg, ok) =>
                {
                    status.textContent = msg;
                    status.classList.toggle("refresh-lcp-status-ok", !!ok);
                };
                root.querySelector('[data-act="lcp-pick"]')?.addEventListener("click", ev =>
                {
                    ev.preventDefault();
                    fileInput?.click();
                });
                fileInput?.addEventListener("change", async ev =>
                {
                    const file = ev.target.files?.[0];
                    if (!file)
                        return;
                    setStatus(`Loading ${file.name}...`, false);
                    try
                    {
                        const r = await loadLcpFile(file);
                        if (!r.lids.size)
                        {
                            lcpLids = null;
                            lcpLabel = null;
                            setStatus(`No LIDs found in ${file.name}.`, false);
                            return;
                        }
                        lcpLids = r.lids;
                        lcpLabel = r.name + (r.version ? ` v${r.version}` : "");
                        setStatus(`Loaded "${lcpLabel}" - ${r.count} LID(s)`, true);
                    }
                    catch (err)
                    {
                        console.error("refresh: LCP load failed", err);
                        lcpLids = null;
                        lcpLabel = null;
                        setStatus(`Failed: ${err.message}`, false);
                    }
                });
                root.querySelector('[data-act="lcp-clear"]')?.addEventListener("click", ev =>
                {
                    ev.preventDefault();
                    if (fileInput)
                        fileInput.value = "";
                    lcpLids = null;
                    lcpLabel = null;
                    setStatus("No LCP file loaded - scan covers every selected compendium item.", false);
                });
            });
        });
    }
}

export class RefreshItemsDialog
{
    constructor(targets)
    {
        this.targets = targets;
        this.dialog = null;
    }

    static async forActor(actor)
    {
        if (!isRefreshableActor(actor))
        {
            ui.notifications.warn("This actor type is not supported by refresh.");
            return null;
        }
        const picked = await RefreshPackPicker.show("actor");
        if (!picked)
            return null;
        if (!picked.itemPacks.length)
        {
            ui.notifications.warn("Refresh: pick at least one item compendium - that's where the up-to-date item versions come from.");
            return null;
        }

        const progress = new RefreshProgressDialog();
        progress.open("Indexing item compendiums...");
        await tick();
        try
        {
            const lidIndex = await buildLidIndex(progress, picked.itemPacks);
            const needed = collectNeededPackDocs([actor], lidIndex, picked.lcpLids);
            const cache = await prefetchPackDocs(needed, progress);
            progress.update(0, 1, `Comparing items: ${actor.name}`);
            await tick();
            const items = await classifyActorItems(actor, lidIndex, cache, picked.lcpLids);
            const locked = actor.pack ? !!game.packs.get(actor.pack)?.locked : false;
            return new RefreshItemsDialog([{ actor, items, locked }]);
        }
        finally
        {
            progress.close();
        }
    }

    static async forAllActors()
    {
        const picked = await RefreshPackPicker.show("all");
        if (!picked)
            return null;
        if (!picked.itemPacks.length)
        {
            ui.notifications.warn("Refresh: pick at least one item compendium - that's where the up-to-date item versions come from.");
            return null;
        }
        if (!picked.folderIds.length && !picked.actorPacks.length)
        {
            ui.notifications.warn("Refresh: no actor source selected.");
            return null;
        }

        const progress = new RefreshProgressDialog();
        progress.open("Indexing item compendiums...");
        await tick();
        try
        {
            const lidIndex = await buildLidIndex(progress, picked.itemPacks);

            const folderSet = new Set(picked.folderIds);
            const includeNoFolder = folderSet.has(RefreshPackPicker.NOFOLDER_ID);
            const worldActors = game.actors.filter(a =>
            {
                if (!isRefreshableActor(a))
                    return false;
                if (!a.folder)
                    return includeNoFolder;
                return folderSet.has(a.folder.id);
            });
            const actorPacks = picked.actorPacks;

            const allActors = [];
            for (const a of worldActors)
                allActors.push({ actor: a, locked: false });

            for (let pi = 0; pi < actorPacks.length; pi++)
            {
                const pack = actorPacks[pi];
                progress.update(pi, actorPacks.length, `Loading pack: ${pack.metadata.label}`);
                await tick();
                let docs;
                try
                {
                    docs = await pack.getDocuments();
                }
                catch (err)
                {
                    console.warn(`refresh: failed to load actors from ${pack.collection}`, err);
                    continue;
                }
                for (const a of docs)
                {
                    if (isRefreshableActor(a))
                        allActors.push({ actor: a, locked: !!pack.locked });
                }
            }

            const actors = allActors.map(a => a.actor);
            const needed = collectNeededPackDocs(actors, lidIndex, picked.lcpLids);
            const cache = await prefetchPackDocs(needed, progress);

            const targets = [];
            const total = allActors.length;
            for (let i = 0; i < total; i++)
            {
                const { actor, locked } = allActors[i];
                if (i % 25 === 0)
                {
                    progress.update(i, total, `Comparing actors: ${i}/${total}`);
                    await tick();
                }
                const items = await classifyActorItems(actor, lidIndex, cache, picked.lcpLids);
                if (items.some(it => ACTIONABLE.has(it.status)))
                {
                    targets.push({ actor, items, locked });
                }
            }

            progress.update(total, total, "Done");
            return new RefreshItemsDialog(targets);
        }
        finally
        {
            progress.close();
        }
    }

    render(force = true)
    {
        if (!this.targets.length)
        {
            ui.notifications.info("Refresh: no items differ from their compendium versions.");
            return;
        }

        const titleText = this.targets.length === 1
            ? `Refresh items: ${this.targets[0].actor.name}`
            : `Refresh actors (${this.targets.length})`;

        this.dialog = new Dialog({
            title: titleText,
            content: this.#renderContent(),
            buttons: {
                apply: {
                    icon: '<i class="fas fa-sync"></i>',
                    label: "Apply selected",
                    callback: html => this.#apply(html)
                },
                cancel: {
                    icon: '<i class="fas fa-times"></i>',
                    label: "Cancel"
                }
            },
            default: "apply",
            render: html => this.#wireToolbar(html)
        }, {
            width: 800,
            height: 700,
            resizable: true,
            classes: ["lancer-refresh-dialog", "lancer-dialog-base", "lancer-no-title"]
        });
        this.dialog.render(force);
    }

    #wireToolbar(html)
    {
        const root = html instanceof HTMLElement ? html : html[0];
        if (!root)
            return;

        const search = root.querySelector(".refresh-search");
        if (search)
        {
            search.addEventListener("input", () => this.#applyFilter(root, search.value));
        }

        root.addEventListener("click", ev =>
        {
            const target = ev.target.closest('[data-act]');
            if (!target)
                return;
            const act = target.dataset.act;
            if (act === "toggle-row")
            {
                ev.preventDefault();
                const row = target.closest(".refresh-row");
                if (!row)
                    return;
                if (row.querySelector(".refresh-row-body"))
                {
                    setRowExpanded(row, row.dataset.expanded !== "1");
                }
            }
            else if (act === "toggle-section")
            {
                if (ev.target.closest("input, button, .npc-status-badge"))
                    return;
                ev.preventDefault();
                const section = target.closest(".refresh-actor-section");
                if (section)
                    setSectionExpanded(section, section.dataset.expanded !== "1");
            }
        });

        const handleClick = (sel, fn) =>
        {
            const btn = root.querySelector(sel);
            if (btn)
                btn.addEventListener("click", ev => { ev.preventDefault(); fn(root); });
        };

        handleClick('[data-act="expand-all"]', r =>
        {
            r.querySelectorAll(".refresh-actor-section").forEach(s => setSectionExpanded(s, true));
            r.querySelectorAll(".refresh-row").forEach(row => setRowExpanded(row, true));
        });
        handleClick('[data-act="collapse-all"]', r =>
        {
            r.querySelectorAll(".refresh-row").forEach(row => setRowExpanded(row, false));
        });
        handleClick('[data-act="check-all"]', r =>
        {
            r.querySelectorAll(".refresh-row").forEach(row =>
            {
                if (row.style.display === "none")
                    return;
                if (row.dataset.status !== "modified")
                    return;
                const cb = row.querySelector("input.refresh-row-cb");
                if (cb)
                    cb.checked = true;
            });
        });
        handleClick('[data-act="uncheck-all"]', r =>
        {
            r.querySelectorAll(".refresh-row").forEach(row =>
            {
                if (row.style.display === "none")
                    return;
                const cb = row.querySelector("input.refresh-row-cb");
                if (cb)
                    cb.checked = false;
            });
        });
    }

    #applyFilter(root, q)
    {
        const query = (q || "").trim().toLowerCase();
        root.querySelectorAll(".refresh-actor-section").forEach(section =>
        {
            const actorName = section.querySelector(".refresh-actor-name")?.textContent?.toLowerCase() || "";
            const actorMatches = !query || actorName.includes(query);
            let itemMatches = 0;
            section.querySelectorAll(".refresh-row").forEach(row =>
            {
                const name = row.querySelector(".refresh-row-name")?.textContent?.toLowerCase() || "";
                const show = !query || actorMatches || name.includes(query);
                row.style.display = show ? "" : "none";
                if (show && query && !actorMatches)
                    itemMatches++;
            });
            const sectionVisible = !query || actorMatches || itemMatches > 0;
            section.style.display = sectionVisible ? "" : "none";
            if (query && sectionVisible)
                setSectionExpanded(section, true);
        });
    }

    #renderContent()
    {
        const sections = this.targets.map((t, ti) => this.#renderActorSection(t, ti)).join("");
        const totals = this.#totalsLine();
        return `
            <div class="refresh-toolbar">
                <div class="refresh-toolbar-row">
                    <span class="refresh-toolbar-title">REFRESH ITEMS</span>
                    <span class="refresh-toolbar-totals">${totals}</span>
                </div>
                <div class="refresh-toolbar-controls">
                    <input type="text" class="refresh-search" placeholder="Filter by item name...">
                    <button type="button" class="refresh-toolbar-btn" data-act="check-all">Check</button>
                    <button type="button" class="refresh-toolbar-btn" data-act="uncheck-all">Uncheck</button>
                    <button type="button" class="refresh-toolbar-btn" data-act="expand-all">Expand</button>
                    <button type="button" class="refresh-toolbar-btn" data-act="collapse-all">Collapse</button>
                </div>
            </div>
            <div class="refresh-actor-list">${sections}</div>
        `;
    }

    #totalsLine()
    {
        const c = { modified: 0, unlinked: 0, synced: 0, missing: 0 };
        for (const t of this.targets)
        {
            for (const i of t.items)
                if (c[i.status] !== undefined)
                    c[i.status]++;
        }
        const parts = [];
        if (c.modified)
            parts.push(`<span class="npc-status-badge modified">${c.modified}</span>`);
        if (c.unlinked)
            parts.push(`<span class="npc-status-badge unlinked">${c.unlinked}</span>`);
        if (c.synced)
            parts.push(`<span class="npc-status-badge synced">${c.synced}</span>`);
        if (c.missing)
            parts.push(`<span class="refresh-count-missing">${c.missing} miss</span>`);
        return parts.join(" ");
    }

    #renderActorSection(t, ti)
    {
        const counts = this.#countsLine(t.items);
        const lockedNote = t.locked
            ? `<div class="lancer-info-box refresh-locked"><i class="fas fa-lock"></i><span>Pack is locked. Unlock it to refresh actors inside.</span></div>`
            : "";
        const rows = t.items
            .map((cls, ii) => this.#renderRow(cls, ti, ii, t.locked))
            .join("");
        return `
            <div class="refresh-actor-section" data-target="${ti}" data-expanded="0">
                <div class="refresh-actor-summary" data-act="toggle-section">
                    <span class="refresh-actor-toggle">▶</span>
                    <span class="refresh-actor-name">${escapeHtml(t.actor.name)}</span>
                    <span class="refresh-counts">${counts}</span>
                </div>
                <div class="refresh-actor-body" hidden>
                    ${lockedNote}
                    <div class="refresh-rows">${rows}</div>
                </div>
            </div>
        `;
    }

    #countsLine(items)
    {
        const c = { modified: 0, unlinked: 0, synced: 0, missing: 0 };
        for (const i of items)
            if (c[i.status] !== undefined)
                c[i.status]++;
        const parts = [];
        if (c.modified)
            parts.push(`<span class="npc-status-badge modified">${c.modified} mod</span>`);
        if (c.unlinked)
            parts.push(`<span class="npc-status-badge unlinked">${c.unlinked} unl</span>`);
        if (c.synced)
            parts.push(`<span class="npc-status-badge synced">${c.synced} ok</span>`);
        if (c.missing)
            parts.push(`<span class="refresh-count-missing">${c.missing} missing</span>`);
        return parts.join(" ");
    }

    #renderRow(cls, ti, ii, locked)
    {
        const checkable = ACTIONABLE.has(cls.status) && !locked;
        const checkbox = checkable
            ? `<input type="checkbox" class="refresh-row-cb" data-target="${ti}" data-row="${ii}">`
            : `<span class="refresh-row-cb-disabled"></span>`;

        const badge = `<span class="npc-status-badge ${cls.status}">${STATUS_LABELS[cls.status] || cls.status}</span>`;
        const expanded = cls.status !== "synced";
        const diffBlock = cls.diff?.length
            ? `<div class="refresh-diff">${cls.diff.map(d => this.#renderDiffLine(d)).join("")}</div>`
            : "";
        const warnBlock = cls.status === "unlinked"
            ? `<div class="refresh-warn"><i class="fas fa-exclamation-triangle"></i> Replaces the item, changes its embedded id. Mech loadout slots may need re-linking.</div>`
            : "";
        const missingBlock = cls.status === "missing"
            ? `<div class="refresh-missing">No compendium entry for LID <code>${escapeHtml(cls.lid || "")}</code></div>`
            : "";
        const body = (diffBlock || warnBlock || missingBlock)
            ? `<div class="refresh-row-body" ${expanded ? "" : "hidden"}>${diffBlock}${warnBlock}${missingBlock}</div>`
            : "";

        return `
            <div class="refresh-row" data-status="${cls.status}" data-expanded="${expanded ? "1" : "0"}">
                <div class="refresh-row-summary">
                    <span class="refresh-row-toggle" data-act="toggle-row">${body ? (expanded ? "▼" : "▶") : ""}</span>
                    ${checkbox}
                    ${badge}
                    <span class="refresh-row-name" data-act="toggle-row">${escapeHtml(cls.actorItem.name)}</span>
                    <span class="refresh-row-type">${escapeHtml(cls.actorItem.type)}</span>
                </div>
                ${body}
            </div>
        `;
    }

    #renderDiffLine(d)
    {
        return `<div class="refresh-diff-line"><code>${escapeHtml(d.path)}</code>: ${formatVal(d.actor)} → ${formatVal(d.pack)}</div>`;
    }

    async #apply(html)
    {
        const root = html instanceof HTMLElement ? html : html[0];
        const overall = { updated: 0, replaced: [], failed: [], actorsTouched: 0 };

        for (let ti = 0; ti < this.targets.length; ti++)
        {
            const t = this.targets[ti];
            if (t.locked)
                continue;
            const selections = [];
            for (let ii = 0; ii < t.items.length; ii++)
            {
                const cls = t.items[ii];
                if (!ACTIONABLE.has(cls.status))
                    continue;
                const cb = root.querySelector(`input.refresh-row-cb[data-target="${ti}"][data-row="${ii}"]`);
                if (!cb || !cb.checked)
                    continue;
                selections.push({
                    actorItem: cls.actorItem,
                    packDoc: cls.packDoc,
                    action: cls.status === "unlinked" ? "replace" : "update"
                });
            }
            if (!selections.length)
                continue;
            const r = await applyRefresh(t.actor, selections);
            overall.updated += r.updated;
            overall.replaced.push(...r.replaced);
            overall.failed.push(...r.failed);
            overall.actorsTouched++;
        }

        const parts = [];
        if (overall.updated)
            parts.push(`${overall.updated} updated`);
        if (overall.replaced.length)
            parts.push(`${overall.replaced.length} replaced`);
        if (overall.failed.length)
            parts.push(`${overall.failed.length} failed`);
        const msg = parts.length
            ? `Refresh on ${overall.actorsTouched} actor(s): ${parts.join(", ")}`
            : "Refresh: nothing to do";
        if (overall.failed.length)
            ui.notifications.warn(msg); else
            ui.notifications.info(msg);

        if (overall.replaced.length)
        {
            console.log("lancer-npc-import refresh - replaced items (oldId -> newId):", overall.replaced);
        }
    }
}

function setRowExpanded(row, expanded)
{
    row.dataset.expanded = expanded ? "1" : "0";
    const body = row.querySelector(".refresh-row-body");
    if (body)
        body.hidden = !expanded;
    const toggle = row.querySelector(".refresh-row-toggle");
    if (toggle && body)
        toggle.textContent = expanded ? "▼" : "▶";
}

function setSectionExpanded(section, expanded)
{
    section.dataset.expanded = expanded ? "1" : "0";
    const body = section.querySelector(".refresh-actor-body");
    if (body)
        body.hidden = !expanded;
    const toggle = section.querySelector(".refresh-actor-toggle");
    if (toggle)
        toggle.textContent = expanded ? "▼" : "▶";
}

function escapeHtml(s)
{
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function formatVal(v)
{
    if (v === undefined)
        return `<i class="refresh-val-missing">missing</i>`;
    if (v === null)
        return `<code>null</code>`;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s.length > 80)
    {
        return `<span class="refresh-val-trunc" title="${escapeHtml(s)}">${escapeHtml(s.slice(0, 80))}…</span>`;
    }
    return `<code>${escapeHtml(s)}</code>`;
}

// Pilot selection panel for the cloud import dialog.

import {
    findExistingPilotByCloudId,
    findExistingMechByLid,
    comparePilotWithActor,
    compareMechWithActor,
    importSelectedPilots
} from "./pilot-import-core.js";

function _escape(s)
{
    return foundry.utils.escapeHTML?.(String(s ?? "")) ?? String(s ?? "");
}

function _badge(status, count)
{
    let text = "";
    if (status === "synced")
        text = count > 1 ? `✓ (×${count})` : "✓";
    else if (status === "modified")
        text = count > 1 ? `⚠ (×${count})` : "⚠";
    else if (status === "new")
        text = "+";
    if (!text)
        return "";
    return `<div class="npc-status-badge ${status}">${text}</div>`;
}

function _mechPortrait(mech)
{
    return mech.cloud_portrait
        || mech.portrait
        || mech.img?.cloud_portrait
        || mech.img?.portrait
        || mech.frameData?.cloud_portrait
        || mech.frameData?.portrait
        || "";
}

function _mechCounts(mech)
{
    const idx = mech.active_loadout_index ?? 0;
    const loadout = mech.loadouts?.[idx];
    let weapons = 0;
    for (const mount of (loadout?.weapon_mounts || []))
        for (const slot of (mount.slots || []))
            if (slot.weapon?.id || slot.weapon?.lid)
                weapons++;
    const systems = (loadout?.systems || []).length;
    return { weapons, systems };
}

function _mechRow(mech, pilotIndex, mechIndex)
{
    const existing = findExistingMechByLid(mech.id);
    const cmp = existing.length === 0
        ? { status: "new", reasons: [] }
        : compareMechWithActor(mech, existing[0]);
    const portrait = _mechPortrait(mech);
    const tooltip = cmp.reasons?.length ? _escape(cmp.reasons.join("\n")) : "";
    const frameName = mech.frameData?.name || "";
    const frameLid = mech.frame || mech.frameData?.id || "?";
    const { weapons, systems } = _mechCounts(mech);
    const stats = mech.stats?.max || mech.stats?.current || {};
    const detailParts = [];
    detailParts.push(frameName ? `${frameName} (${frameLid})` : frameLid);
    if (weapons > 0)
        detailParts.push(`${weapons}w`);
    if (systems > 0)
        detailParts.push(`${systems}sys`);
    if (stats.hp)
        detailParts.push(`HP ${stats.hp}`);
    if (stats.structure)
        detailParts.push(`STR ${stats.structure}`);
    if (stats.stress)
        detailParts.push(`STS ${stats.stress}`);
    const detailLine = detailParts.join(" · ");
    return `
        <label class="mech-sub-row" data-status="${cmp.status}" data-pilot="${pilotIndex}" data-mech="${mechIndex}"${tooltip ? ` title="${tooltip}"` : ""}>
            <input type="checkbox" class="mech-checkbox" data-pilot="${pilotIndex}" data-mech="${mechIndex}">
            ${_badge(cmp.status, existing.length)}
            <div class="mech-info">
                <div class="mech-name">${_escape(mech.name || `Mech ${mechIndex + 1}`)}</div>
                <div class="mech-frame">${_escape(detailLine)}</div>
            </div>
            ${portrait ? `<img src="${_escape(portrait)}" class="mech-portrait" alt="${_escape(mech.name || "")}">` : ""}
        </label>
    `;
}

function _pilotDetailLine(pilot)
{
    const j = pilot.json || {};
    const parts = [`Lv${pilot.level}`];
    parts.push(`${pilot.mechCount} mech${pilot.mechCount === 1 ? "" : "s"}`);
    const licenses = Array.isArray(j.licenses) ? j.licenses.length : 0;
    if (licenses)
        parts.push(`${licenses} lic`);
    const talents = Array.isArray(j.talents) ? j.talents.length : 0;
    if (talents)
        parts.push(`${talents} tal`);
    const reserves = Array.isArray(j.reserves) ? j.reserves.length : 0;
    if (reserves)
        parts.push(`${reserves} res`);
    const orgs = Array.isArray(j.orgs) ? j.orgs.length : 0;
    if (orgs)
        parts.push(`${orgs} org`);
    if (j.player_name)
        parts.push(j.player_name);
    if (j.status)
        parts.push(j.status);
    if (j.lastCloudUpdate)
    {
        const d = new Date(j.lastCloudUpdate);
        if (!Number.isNaN(d.getTime()))
            parts.push(d.toISOString().slice(0, 10));
    }
    return parts.join(" · ");
}

function _pilotRow(pilot, index)
{
    const existing = findExistingPilotByCloudId(pilot.cloudId);
    const cmp = comparePilotWithActor(pilot.json, existing);
    const portrait = pilot.json.cloud_portrait || pilot.json.img?.cloud_portrait || pilot.json.portrait || "";
    const callsign = pilot.callsign ? `<span class="callsign">"${_escape(pilot.callsign)}"</span>` : "";
    const mechsHtml = (pilot.mechs || []).map((m, i) => _mechRow(m, index, i)).join("");
    const detailLine = _pilotDetailLine(pilot);
    const tooltip = cmp.reasons?.length ? _escape(cmp.reasons.join("\n")) : "";

    return `
        <details class="lancer-list-item pilot-row" data-status="${cmp.status}"
                 data-pilot-name="${_escape((pilot.name || "").toLowerCase())}"
                 data-pilot-callsign="${_escape((pilot.callsign || "").toLowerCase())}"${tooltip ? ` title="${tooltip}"` : ""}>
            <summary>
                <input type="checkbox" class="pilot-checkbox" data-index="${index}">
                ${_badge(cmp.status, cmp.count)}
                <div class="npc-info">
                    <div class="npc-name">${_escape(pilot.name)} ${callsign}</div>
                    <div class="npc-details">${_escape(detailLine)}</div>
                </div>
                ${portrait ? `<img src="${_escape(portrait)}" class="npc-portrait" alt="${_escape(pilot.name)}">` : ""}
            </summary>
            <div class="mech-sub-list">
                ${mechsHtml || `<div class="mech-sub-empty">No mechs</div>`}
            </div>
        </details>
    `;
}

export function buildPilotSelectionPanel(pilots)
{
    const html = `
        <div class="pilot-panel">
            <div class="npc-import-options">
                <div class="npc-import-options-left">
                    <div class="lancer-section-title">Import Mode:</div>
                    <div class="lancer-toggle-card active" data-setting="update-existing" id="update-existing-card-pilot">
                        <div class="lancer-toggle-card-icon"><i class="fas fa-check"></i></div>
                        <div class="lancer-toggle-card-text">Update existing pilots / mechs (match by cloud_id / LID)</div>
                        <input type="hidden" id="pilot-update-existing" value="true">
                    </div>
                </div>
            </div>
            <div class="npc-list-container">
                <div class="npc-list-header">
                    <p class="npc-list-label">Pilots (${pilots.length})</p>
                    <p class="npc-list-count"><span id="pilot-selected-count">0</span> selected</p>
                </div>
                <div class="lancer-search-container">
                    <i class="fas fa-search lancer-search-icon"></i>
                    <input type="text" id="pilot-search" placeholder="Search pilots by name or callsign" autocomplete="off">
                </div>
                <div class="lancer-status-filters">
                    <button type="button" class="status-filter-btn active" data-status="all">All</button>
                    <button type="button" class="status-filter-btn" data-status="new">+ New</button>
                    <button type="button" class="status-filter-btn" data-status="synced">✓ Synced</button>
                    <button type="button" class="status-filter-btn" data-status="modified">⚠ Modified</button>
                </div>
                <div class="lancer-list pilot-list">
                    ${pilots.map((p, i) => _pilotRow(p, i)).join("")}
                </div>
            </div>
            <div class="lancer-action-buttons">
                <button type="button" id="pilot-select-all" class="lancer-action-btn">
                    <i class="fas fa-check-square"></i> Select All
                </button>
                <button type="button" id="pilot-deselect-all" class="lancer-action-btn">
                    <i class="fas fa-square"></i> Deselect All
                </button>
            </div>
        </div>
    `;

    function activate($root)
    {
        const $list = $root.find(".pilot-list");
        const $search = $root.find("#pilot-search");
        const $count = $root.find("#pilot-selected-count");
        let statusFilter = "all";

        function applyFilters()
        {
            const q = String($search.val() || "").toLowerCase().trim();
            $list.find(".pilot-row").each(function()
            {
                const $r = $(this);
                const name = $r.data("pilot-name") || "";
                const cs = $r.data("pilot-callsign") || "";
                const st = $r.data("status") || "";
                const matchesSearch = !q || name.includes(q) || cs.includes(q);
                const matchesStatus = statusFilter === "all" || st === statusFilter;
                $r.toggleClass("lancer-hidden", !(matchesSearch && matchesStatus));
            });
        }
        $search.on("input", applyFilters);
        $root.find(".status-filter-btn").on("click", function()
        {
            $root.find(".status-filter-btn").removeClass("active");
            $(this).addClass("active");
            statusFilter = $(this).data("status");
            applyFilters();
        });

        function refreshCount()
        {
            const pilotCount = $list.find(".pilot-checkbox:checked").length;
            const mechCount = $list.find(".mech-checkbox:checked").length;
            $count.text(pilotCount + (mechCount > 0 ? ` (+${mechCount} mech${mechCount === 1 ? "" : "s"})` : ""));
        }

        // Pilot checkbox: selects/deselects the pilot row, and cascades to all its mechs.
        $list.on("change", ".pilot-checkbox", function()
        {
            const checked = $(this).prop("checked");
            const $row = $(this).closest(".pilot-row");
            $row.toggleClass("selected", checked);
            $row.find(".mech-checkbox").prop("checked", checked).each(function()
            {
                $(this).closest(".mech-sub-row").toggleClass("selected", checked);
            });
            refreshCount();
        });
        $list.on("click", ".pilot-checkbox", (e) => e.stopPropagation());

        // Mech checkbox: independent; highlights the mech row.
        $list.on("change", ".mech-checkbox", function()
        {
            const checked = $(this).prop("checked");
            $(this).closest(".mech-sub-row").toggleClass("selected", checked);
            refreshCount();
        });
        // Click on the mech-sub-row label naturally toggles the checkbox; stop the
        // event from also toggling the parent <details>.
        $list.on("click", ".mech-sub-row", (e) => e.stopPropagation());

        $root.find("#pilot-select-all").on("click", () =>
        {
            $list.find(".pilot-row:not(.lancer-hidden) .pilot-checkbox")
                .prop("checked", true).trigger("change");
        });
        $root.find("#pilot-deselect-all").on("click", () =>
        {
            $list.find(".pilot-row:not(.lancer-hidden) .pilot-checkbox")
                .prop("checked", false).trigger("change");
            $list.find(".mech-checkbox").prop("checked", false).trigger("change");
        });

        $root.find(".lancer-toggle-card[data-setting='update-existing']").on("click", function()
        {
            const isActive = $(this).hasClass("active");
            $(this).toggleClass("active");
            const $icon = $(this).find(".lancer-toggle-card-icon i");
            const $hidden = $(this).find("input[type='hidden']");
            if (isActive) { $icon.removeClass("fa-check").addClass("fa-times"); $hidden.val("false"); }
            else          { $icon.removeClass("fa-times").addClass("fa-check"); $hidden.val("true"); }
        });
    }

    // Returns selected pilots as { pilot, mechIds: Set } so the importer can
    // filter the mechs[] array. A pilot is included if its own checkbox is on
    // OR any of its mechs are checked.
    function getSelected($root)
    {
        const byIdx = new Map();
        $root.find(".pilot-checkbox:checked").each(function()
        {
            const idx = Number($(this).data("index"));
            if (!Number.isNaN(idx) && pilots[idx])
                byIdx.set(idx, { pilot: pilots[idx], mechIds: new Set(), allMechs: true });
        });
        $root.find(".mech-checkbox:checked").each(function()
        {
            const pIdx = Number($(this).data("pilot"));
            const mIdx = Number($(this).data("mech"));
            if (Number.isNaN(pIdx) || !pilots[pIdx])
                return;
            const mech = pilots[pIdx].mechs?.[mIdx];
            if (!mech)
                return;
            if (!byIdx.has(pIdx))
                byIdx.set(pIdx, { pilot: pilots[pIdx], mechIds: new Set(), allMechs: false });
            byIdx.get(pIdx).mechIds.add(mech.id);
        });
        return Array.from(byIdx.values());
    }

    function getOptions($root)
    {
        return {
            updateExisting: $root.find("#pilot-update-existing").val() === "true"
        };
    }

    return { html, activate, getSelected, getOptions };
}

export { importSelectedPilots };

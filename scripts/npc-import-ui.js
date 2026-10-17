// Source picker and the NPC panel of the Comp/Con cloud dialog.

import { corsProxyFetch } from "./v3-api.js";
import { importFromFiles, selectActorMappings } from "./npc-import-files.js";
import { importFromCompCon, npcFromV3Json } from "./npc-import-compcon.js";
import { setRunMark } from "./sync-log.js";
import {
    findExistingNPCsByLID,
    compareNPCWithActor,
    npcCloudTemplates,
    npcCloudFeatures,
    parseTier
} from "./npc-import-core.js";
import { portraitHtml, chipHtml, missingMark, diffChips, changesTable, plural, countLids, consumeLid, iconHtml, glyphHtml, weaponTypeIconHtml, panHtml, bindPan, mirrorChange, filterChipsHtml, SYNC_WORDS, ICON, SYS_ICONS } from "./pilot-import-ui.js";
import { retrogradeArt, actorArt } from "./frame-art.js";
import { escapeHtml, getModuleSetting, MODULE_ID } from "./utils.js";
import { isLoggedIn, getEmail } from "./auth/cognito-auth.js";
import { CompconLoginDialog } from "./auth/login-dialog.js";

function _loginStatusHtml()
{
    if (isLoggedIn())
    {
        const email = foundry.utils.escapeHTML?.(getEmail()) ?? getEmail();
        return `
            <div class="compcon-auth-status compcon-auth-status--in">
                <i class="fas fa-check-circle"></i>
                <span>Signed in as <strong>${email}</strong></span>
                <button type="button" class="compcon-auth-btn" data-action="auth">Change account</button>
            </div>`;
    }
    return `
        <div class="compcon-auth-status compcon-auth-status--out">
            <i class="fas fa-sign-in-alt"></i>
            <span>Sign in to use your Comp/Con cloud.</span>
            <button type="button" class="compcon-auth-btn" data-action="auth">Sign in</button>
        </div>`;
}

export class ActorImportDialog extends Dialog
{
    constructor()
    {
        const loggedIn = isLoggedIn();
        const cloudCardClass = loggedIn ? "lancer-item-card" : "lancer-item-card lancer-item-card--disabled";
        const cloudCardTitle = loggedIn ? "" : 'title="Sign in to use the Comp/Con cloud"';

        super({
            title: "Comp/Con Sync",
            content: `
                <div class="lancer-dialog-base">
                    <div class="lancer-dialog-header">
                        <div class="lancer-dialog-title">COMP/CON SYNC // SOURCE SELECTION</div>
                        <div class="lancer-dialog-subtitle">Pilots and NPCs, JSON or Comp/Con cloud</div>
                    </div>
                    <div class="compcon-auth-row">${_loginStatusHtml()}</div>
                    <div class="lancer-items-grid">
                        <div class="lancer-item-card" data-action="files">
                            <div class="lancer-item-icon"><i class="fas fa-file-upload"></i></div>
                            <div class="lancer-item-content">
                                <div class="lancer-item-name">Import from JSON File(s)</div>
                                <div class="lancer-item-details">Auto-detects pilot or NPC per file</div>
                            </div>
                        </div>
                        <div class="${cloudCardClass}" data-action="compcon" ${cloudCardTitle}>
                            <div class="lancer-item-icon"><i class="mdi mdi-cloud-sync"></i></div>
                            <div class="lancer-item-content">
                                <div class="lancer-item-name">Comp/Con Cloud</div>
                                <div class="lancer-item-details">Import or export pilots and NPCs</div>
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

    activateListeners(html)
    {
        super.activateListeners(html);

        html.find('.compcon-auth-btn').click((event) =>
        {
            event.preventDefault();
            event.stopPropagation();
            new CompconLoginDialog(() =>
            {
                this.close();
                new ActorImportDialog().render(true);
            }).render(true);
        });

        html.find('.lancer-item-card').click(async (event) =>
        {
            const $card = $(event.currentTarget);
            if ($card.hasClass('lancer-item-card--disabled'))
                return;
            const action = $card.data('action');
            this.close();

            if (action === 'files')
            {
                await importFromFiles();
            }
            else if (action === 'compcon')
            {
                await importFromCompCon();
            }
        });
    }
}

const NPC_STATUS = { mod: "Changed", new: "New", unl: "Unlinked", ok: "Up to date" };
const NPC_FILTERS = ["all", "mod", "new", "unl", "ok"];
const NPC_STAT_GRID = [
    ["hp", "HP", "hp"], ["armor", "ARM", "armor"], ["evade", "EVA", "evasion"], ["edef", "EDEF", "edef"],
    ["heatcap", "HEAT", "heat"], ["speed", "SPD", "mdi mdi-arrow-right-bold-hexagon-outline"], ["sensor", "SENS", "sensor"], ["save", "SAVE", "save"],
    ["hull", "HULL", "hull"], ["agility", "AGI", "agi"], ["systems", "SYS", "sys"], ["engineering", "ENG", "eng"],
    ["structure", "STRUCT", "cci cci-structure"], ["stress", "STRESS", "cci cci-reactor"], ["size", "SIZE", "size"], ["activations", "ACT", "activations"]
];
const SIZE_ICONS = { 0.5: "size_half", 1: "size_1", 2: "size_2", 3: "size_3", 4: "size_4" };
const FEATURE_TYPES = {
    Weapon: "cci cci-weapon",
    System: "cci cci-system",
    Trait: "cci cci-trait",
    Reaction: "cci cci-reaction",
    Tech: "cci cci-tech-quick"
};
const NPC_MISSING_TIP = "Not in your compendiums or world items. The import skips it.";

function _statIcon(icon, value)
{
    if (icon.includes(" "))
        return glyphHtml(icon);
    if (icon !== "size")
        return iconHtml(ICON[icon]);
    const file = SIZE_ICONS[Number(value)];
    return file ? iconHtml(`${SYS_ICONS}/white/${file}.svg`) : "";
}

function _tierIcon(json)
{
    const file = json.tier === "custom" ? "npc_tier_custom" : `npc_tier_${parseTier(json.tier)}`;
    return iconHtml(`${SYS_ICONS}/${file}.svg`);
}

function _npcStatusKey(cmp)
{
    return { new: "new", unlinked: "unl", synced: "ok" }[cmp.status] || "mod";
}

function _npcTier(json)
{
    return json.tier === "custom" ? "Custom tier" : `T${parseTier(json.tier)}`;
}

function _npcPortrait(npc, actor, cls = "")
{
    const own = actorArt(actor) || npc.json.cloud_portrait || npc.json.img?.cloud_portrait || "";
    const mini = own ? "" : retrogradeArt(npc.names?.className);
    return portraitHtml(own || mini, npc.name, [cls, mini ? "cc-pt-mini" : ""].filter(Boolean).join(" "));
}

function _originKey(origin)
{
    return String(origin || "").trim().toUpperCase();
}

function _featureChip(item, state, known, exporting = false)
{
    let tag = FEATURE_TYPES[item.type] ? glyphHtml(FEATURE_TYPES[item.type], item.type) : "";
    if (item.type === "Weapon" && item.weaponType)
        tag = weaponTypeIconHtml(item.weaponType);
    if (exporting)
    {
        if (state === "removed")
            return chipHtml(known, item.id, "cc-chip-removed", SYNC_WORDS.export.removed, `${tag}− ${escapeHtml(item.name)}`);
        if (state === "added")
            return chipHtml(null, null, "cc-chip-added", SYNC_WORDS.export.added, `${tag}+ ${escapeHtml(item.name)}`, item.uuid);
        return chipHtml(null, null, "", "", `${tag}${escapeHtml(item.name)}`, item.uuid);
    }
    if (state === "removed")
        return chipHtml(null, null, "cc-chip-removed", "In Foundry only. Removed on import.", `${tag}− ${escapeHtml(item.name)}`, item.uuid);
    const mark = missingMark(known, item.id, NPC_MISSING_TIP);
    if (state === "added")
        return chipHtml(known, item.id, "cc-chip-added", "Not in Foundry. Added on import.", `${tag}+ ${escapeHtml(item.name)}${mark}`);
    return chipHtml(known, item.id, "", "", `${tag}${escapeHtml(item.name)}${mark}`);
}

function _featureRows(npc, actor, known, exporting = false)
{
    const names = npc.names || {};
    const actorItems = actor ? [...actor.items] : [];
    const world = actorItems
        .filter(item => item.type === "npc_feature")
        .map(item => ({
            id: item.system?.lid || "",
            name: item.name,
            uuid: item.uuid,
            type: item.system?.type || "",
            weaponType: item.system?.weapon_type || "",
            origin: item.system?.origin?.name || ""
        }));
    const worldByLid = new Map(world.map(item => [item.id, item]));
    const cloud = npcCloudFeatures(npc.json, names).map(item => ({
        ...item,
        type: item.type || worldByLid.get(item.id)?.type || "",
        weaponType: item.weaponType || worldByLid.get(item.id)?.weaponType || "",
        origin: item.origin || worldByLid.get(item.id)?.origin || ""
    }));
    const templates = [
        ...npcCloudTemplates(npc.json, names),
        ...actorItems.filter(item => item.type === "npc_template").map(item => ({ id: item.system?.lid || "", name: item.name }))
    ];
    const classLid = String(npc.json.class || "").toLowerCase();
    const classKey = _originKey(names.className);
    const resolve = origin =>
    {
        const raw = String(origin || "").trim();
        if (!raw)
            return { key: "", label: "Other", kind: "" };
        const lower = raw.toLowerCase();
        const upper = _originKey(raw);
        if ((classLid && lower === classLid) || (classKey && upper === classKey))
            return { key: "class", label: names.className || known?.get?.(`label:${raw}`) || raw, kind: "Class" };
        const template = templates.find(entry => (entry.id && entry.id.toLowerCase() === lower) || _originKey(entry.name) === upper);
        if (template)
            return { key: `tpl:${_originKey(template.name)}`, label: template.name, kind: "Template" };
        const label = known?.get?.(`label:${raw}`) || raw;
        return { key: `o:${_originKey(label)}`, label, kind: lower.startsWith("npct") ? "Template" : "Other class" };
    };
    const groups = new Map();
    const group = origin =>
    {
        const info = resolve(origin);
        if (!groups.has(info.key))
            groups.set(info.key, { ...info, chips: [] });
        return groups.get(info.key);
    };
    group(npc.json.class || names.className);
    npcCloudTemplates(npc.json, names).forEach(template => group(template.id));

    const worldCounts = countLids(world.map(item => item.id));
    const cloudCounts = countLids(cloud.map(item => item.id));
    for (const item of cloud)
    {
        const kept = !actor || consumeLid(worldCounts, item.id);
        let state = kept ? "kept" : "added";
        if (exporting && !kept)
            state = "removed";
        group(item.origin).chips.push(_featureChip(item, state, known, exporting));
    }
    for (const item of world)
    {
        if (!consumeLid(cloudCounts, item.id))
            group(item.origin).chips.push(_featureChip(item, exporting ? "added" : "removed", known, exporting));
    }

    const kindIcon = kind =>
    {
        if (!kind)
            return "";
        return kind === "Template" ? iconHtml(ICON.template) : _tierIcon(npc.json);
    };
    const rows = [...groups.values()]
        .filter(entry => entry.chips.length)
        .sort((a, b) => (a.key ? 0 : 1) - (b.key ? 0 : 1))
        .map(entry => `
            <div class="cc-lrow">
                <span class="cc-mount-type">${kindIcon(entry.kind)}<span class="cc-mount-name">${panHtml(escapeHtml(entry.label))}${entry.kind ? `<small>${entry.kind}</small>` : ""}</span></span>
                <div class="cc-chips">${entry.chips.join("")}</div>
            </div>`);
    if (!rows.length)
        return "";
    return `
        <div class="cc-sec">
            <h5>Features</h5>
            <div class="cc-loadout">${rows.join("")}</div>
        </div>`;
}

export function buildNPCSelectionPanel(npcs, knownLids = null)
{
    const idCounts = countLids(npcs.map(npc => npc.json?.id).filter(Boolean));
    const entries = npcs.map((npc, index) => _diff({ npc, index, dupe: (idCounts.get(npc.json?.id) || 0) > 1 }));

    function _diff(entry)
    {
        const { npc } = entry;
        const names = npc.names || {};
        const templates = npcCloudTemplates(npc.json, names).map(template => template.name);
        entry.cmp = compareNPCWithActor(npc.json, findExistingNPCsByLID(npc.json), names);
        entry.statusKey = _npcStatusKey(entry.cmp);
        entry.search = [npc.name, names.className, ...templates, npc.tag].join(" ").toLowerCase();
        entry.extraChanges = new Map();
        return entry;
    }
    const state = {
        picked: new Set(),
        copyOff: new Map(),
        unlink: new Map(),
        replace: new Map(),
        filter: "all",
        query: "",
        focus: entries.find(entry => entry.statusKey === "mod")?.index ?? entries[0]?.index ?? null,
        scaling: "scaled",
        download: !!getModuleSetting("defaultDownloadPortrait"),
        mode: "import",
        source: new Map()
    };

    const chipLabels = { all: "All", ...NPC_STATUS };
    const html = `
        <div class="npc-panel cc-panel">
            <div class="cc-toolbar">
                <label class="cc-search">
                    <i class="fas fa-search"></i>
                    <input type="text" id="npc-search" placeholder="Search name, class, template, tag" autocomplete="off">
                </label>
                ${filterChipsHtml(NPC_FILTERS, chipLabels)}
            </div>
            <div class="cc-body">
                <div class="cc-list npc-list">${_listHtml()}</div>
                <div class="lancer-list-item cc-detail"><div class="cc-detail-scroll"></div></div>
            </div>
            <div class="cc-foot">
                <div class="cc-seg" title="How custom stats apply across tiers. Used only when a selected NPC has custom stats.">
                    <span>Custom stats</span>
                    <button type="button" data-scale="scaled" title="Keeps the class tier increments">Scaled</button>
                    <button type="button" data-scale="flat" title="Same stats at every tier">Flat</button>
                </div>
                <label class="cc-update"><input type="checkbox" id="npc-download-portraits"${state.download ? " checked" : ""}> Save portraits</label>
                <a class="cc-link" data-action="select-shown">Select shown</a>
                <a class="cc-link" data-action="clear">Clear</a>
                <span class="cc-summary"></span>
            </div>
        </div>
    `;

    function _row(entry)
    {
        const { npc, index, statusKey, cmp } = entry;
        const names = npc.names || {};
        const actor = cmp.copies[0]?.actor || cmp.candidates[0] || null;
        const dupe = entry.dupe ? `<i class="fas fa-clone cc-row-dupe" title="Listed twice in Comp/Con"></i>` : "";
        return `
            <div class="lancer-list-item cc-row cc-row-npc" data-index="${index}" data-st="${statusKey}" tabindex="0">
                <span class="cc-stripe"></span>
                <input type="checkbox" class="npc-checkbox" data-index="${index}">
                ${_npcPortrait(npc, actor)}
                <div class="cc-row-text">
                    <div class="cc-row-name">${escapeHtml(npc.name)}</div>
                    <div class="cc-row-sub">${escapeHtml([_npcTier(npc.json), names.className || npc.class].filter(Boolean).join(" · "))}</div>
                </div>
                <span class="cc-row-count">${dupe}${cmp.count > 1 ? `×${cmp.count}` : ""}</span>
                <span class="cc-dot" data-st="${statusKey}" title="${NPC_STATUS[statusKey]}"></span>
            </div>`;
    }

    function _listHtml()
    {
        return `${entries.map(_row).join("")}<div class="cc-empty lancer-hidden">No NPCs match.</div>`;
    }

    function _exporting()
    {
        return state.mode === "export";
    }

    function _inMode(entry)
    {
        return !_exporting() || entry.statusKey === "mod" || entry.statusKey === "ok";
    }

    function _source(entry)
    {
        return entry.cmp.copies[state.source.get(entry.index) ?? 0]?.actor || null;
    }

    function size()
    {
        return entries.filter(_inMode).length;
    }

    function _shown(entry)
    {
        return _inMode(entry)
            && (state.filter === "all" || entry.statusKey === state.filter)
            && (!state.query || entry.search.includes(state.query));
    }

    function _off(entry)
    {
        return state.copyOff.get(entry.index) || new Set();
    }

    function _unlinkActor(entry)
    {
        const choice = state.unlink.get(entry.index) ?? entry.cmp.candidates[0]?.id ?? "new";
        return entry.cmp.candidates.find(actor => actor.id === choice) || null;
    }

    function _target(entry)
    {
        if (_exporting())
            return _source(entry);
        const replace = state.replace.get(entry.index);
        if (replace)
            return replace.targetActor;
        if (entry.statusKey === "unl")
            return _unlinkActor(entry);
        const off = _off(entry);
        const copies = entry.cmp.copies;
        return (copies.find(copy => !off.has(copy.actor.id)) || copies[0])?.actor || null;
    }

    function _changesFor(entry, actor)
    {
        if (!actor)
            return [];
        const copy = entry.cmp.copies.find(item => item.actor === actor);
        if (copy)
            return copy.changes;
        if (!entry.extraChanges.has(actor.id))
            entry.extraChanges.set(actor.id, compareNPCWithActor(entry.npc.json, [actor], entry.npc.names || {}).changes);
        return entry.extraChanges.get(actor.id);
    }

    function _planText(entry)
    {
        const replace = state.replace.get(entry.index);
        if (replace)
            return `Overwrites ${replace.targetActor.name}${replace.keepName ? " and keeps its name" : ""}.`;
        if (entry.statusKey === "new")
            return "Creates a new NPC actor.";
        if (entry.statusKey === "unl")
        {
            const actor = _unlinkActor(entry);
            return actor ? `Links ${actor.name} to Comp/Con and updates it.` : "Creates a new actor. Same-name actors stay as they are.";
        }
        const copies = entry.cmp.copies;
        const skipped = copies.filter(copy => _off(entry).has(copy.actor.id)).length;
        if (copies.length === 1)
            return `Updates ${copies[0].actor.name}. It keeps its name.`;
        if (!skipped)
            return `Updates all ${copies.length} copies. Each keeps its name.`;
        return `Updates ${copies.length - skipped} of ${copies.length} copies. ${skipped === 1 ? "1 copy stays" : `${skipped} copies stay`} as is.`;
    }

    function _unlinkBox(entry)
    {
        const chosen = _unlinkActor(entry);
        const candidates = entry.cmp.candidates;
        const radio = (value, checked, body) => `
            <label class="cc-choice">
                <input type="radio" name="npc-unlink-${entry.index}" class="npc-unlink" value="${escapeHtml(value)}"${checked ? " checked" : ""}>
                <span>${body}</span>
            </label>`;
        const options = candidates.map(actor =>
        {
            const meta = [`T${actor.system?.tier ?? "?"}`, actor.folder?.name].filter(Boolean).join(" · ");
            const name = chipHtml(null, null, "cc-actor-name", "", `<b>${escapeHtml(actor.name)}</b>`, actor.uuid);
            return radio(actor.id, chosen === actor, `Link ${name} <small>${escapeHtml(meta)}</small> and update it`);
        }).join("");
        return `
            <div class="cc-info" data-st="unl">
                <div>Not linked. ${candidates.length === 1 ? "An actor has" : `${candidates.length} actors have`} this name but no Comp/Con ID.</div>
                ${options}
                ${radio("new", !chosen, "Create a new actor")}
            </div>`;
    }

    function _copiesSection(entry, target)
    {
        const copies = entry.cmp.copies;
        if (copies.length < 2 || state.replace.has(entry.index))
            return "";
        const picked = state.picked.has(entry.index);
        const exporting = _exporting();
        const refTitle = exporting ? "Exports from this copy. The diff below compares against it." : "The diff below compares against this copy.";
        const rows = copies.map(copy =>
        {
            const ref = copy.actor === target;
            const folder = copy.actor.folder?.name ? ` <small>${escapeHtml(copy.actor.folder.name)}</small>` : "";
            const input = exporting
                ? `<input type="radio" name="npc-source-${entry.index}" class="npc-source" data-actor="${escapeHtml(copy.actor.id)}"${ref ? " checked" : ""}>`
                : `<input type="checkbox" class="npc-copy" data-actor="${escapeHtml(copy.actor.id)}"${picked && !_off(entry).has(copy.actor.id) ? " checked" : ""}>`;
            return `
                <label class="cc-copy${ref ? " cc-copy-ref" : ""}"${ref ? ` title="${refTitle}"` : ""}>
                    ${input}
                    ${chipHtml(null, null, "cc-actor-name", "", `${escapeHtml(copy.actor.name)}${folder}`, copy.actor.uuid)}
                    <span class="cc-copy-sum">${copy.changes.length ? plural(copy.changes.length, "change") : "same as Comp/Con"}</span>
                </label>`;
        }).join("");
        return `<div class="cc-sec"><h5>Copies in Foundry</h5><div class="cc-copies">${rows}</div></div>`;
    }

    function _dossier(entry)
    {
        const { npc, cmp } = entry;
        const json = npc.json || {};
        const names = npc.names || {};
        const exporting = _exporting();
        const words = exporting ? SYNC_WORDS.export : SYNC_WORDS.import;
        const known = exporting ? null : knownLids;
        const replace = exporting ? null : state.replace.get(entry.index);
        const target = _target(entry);
        const raw = _changesFor(entry, target);
        const changes = exporting ? raw.map(mirrorChange) : raw;

        const tierLabel = exporting && target ? `T${target.system?.tier ?? "?"}` : _npcTier(json);
        const tags = [`<span class="cc-tag cc-tag-ll">${_tierIcon(json)}${escapeHtml(tierLabel)}</span>`];
        if (npc.custom && json.tier !== "custom")
            tags.push(`<span class="cc-tag">Custom stats</span>`);
        if (npc.tag)
            tags.push(`<span class="cc-tag">${escapeHtml(npc.tag)}</span>`);
        tags.push(`<span class="cc-pill" data-st="${entry.statusKey}">${NPC_STATUS[entry.statusKey]}${!exporting && cmp.count > 1 ? ` ×${cmp.count}` : ""}</span>`);

        const statChanges = new Map(raw.filter(change => change.stat).map(change => [change.stat, change]));
        const stats = json.stats || {};
        const grid = NPC_STAT_GRID
            .filter(([key]) => stats[key] !== undefined && stats[key] !== null && stats[key] !== "")
            .map(([key, label, icon]) =>
            {
                const change = statChanges.get(key);
                const value = exporting && change ? change.world : stats[key];
                const was = exporting ? stats[key] : change?.world;
                return `<span${change ? ` class="cc-stat-changed"` : ""}><b class="cc-stat-lab">${_statIcon(icon, stats[key])}${label}</b>${escapeHtml(value)}${change ? `<em>was ${escapeHtml(was || "none")}</em>` : ""}</span>`;
            }).join("");

        let body = "";
        if (!exporting && known && json.class && !known.has(json.class))
            body += `<div class="cc-warn"><i class="fas fa-exclamation-triangle"></i><div><b>Class not found.</b> ${escapeHtml(names.className || json.class)} is not in your compendiums (missing LCP?). The import cannot build this NPC.</div></div>`;
        const missing = known
            ? [...npcCloudTemplates(json, names), ...npcCloudFeatures(json, names)].filter(item => !known.has(item.id)).length
            : 0;
        if (missing)
            body += `<div class="cc-info cc-info-missing"><i class="fas fa-circle-exclamation cc-missing"></i> ${plural(missing, "item")} not in your compendiums or world items (missing LCP?). The import skips ${missing === 1 ? "it" : "them"}.</div>`;
        if (entry.dupe)
            body += `<div class="cc-warn cc-warn-dupe"><i class="fas fa-clone"></i><div>Listed twice in Comp/Con. Both entries import into the same actors, pick one.</div></div>`;

        if (exporting)
        {
            if (entry.statusKey === "ok")
                body += `<div class="cc-info" data-st="ok">No changes. Nothing to export.</div>`;
        }
        else if (replace)
            body += `<div class="cc-info" data-st="mod">Imports into <b>${escapeHtml(replace.targetActor.name)}</b>${replace.keepName ? " and keeps its name" : ""}. <a class="cc-link" data-action="cancel-replace">Cancel</a></div>`;
        else if (entry.statusKey === "new")
            body += `<div class="cc-info" data-st="new">Not in Foundry. Creates a new NPC.</div>`;
        else if (entry.statusKey === "unl")
            body += _unlinkBox(entry);
        else if (entry.statusKey === "ok")
            body += `<div class="cc-info" data-st="ok">No changes.</div>`;

        if (state.picked.has(entry.index))
        {
            const plan = exporting ? `Updates the Comp/Con NPC from ${target?.name || "the Foundry actor"}.` : _planText(entry);
            body += `<div class="cc-plan"><i class="fas ${words.icon}"></i><span>${escapeHtml(plan)}</span></div>`;
        }
        if (!exporting && !replace)
            body += `<div class="cc-alt"><a class="cc-link" data-action="retarget">Import into another actor…</a></div>`;

        const headline = changes.filter(change => !change.stat && change.field !== "Template" && change.field !== "Feature");
        if (headline.length)
            body += `<div class="cc-sec"><h5>${words.changes}</h5>${changesTable(headline, exporting)}</div>`;
        body += _copiesSection(entry, target);
        const templates = exporting
            ? (target?.items || []).filter(item => item.type === "npc_template").map(item => ({ label: item.name, lid: item.system?.lid || "", uuid: item.uuid }))
            : npcCloudTemplates(json, names).map(template => ({ label: template.name, lid: template.id }));
        body += diffChips("Templates", templates, "Template", changes, known, { tip: NPC_MISSING_TIP, icon: iconHtml(ICON.template), words });
        body += _featureRows(npc, target, known, exporting);

        const classChip = json.class
            ? `${chipHtml(known, json.class, "", "", escapeHtml(names.className || json.class))}${missingMark(known, json.class, NPC_MISSING_TIP)}`
            : "No class";
        return `
            <div class="cc-top">
                ${_npcPortrait(npc, target || cmp.candidates[0], "cc-pt-lg")}
                <div class="cc-id">
                    <h4>${escapeHtml(npc.name)}</h4>
                    <div class="cc-mech-frame">${classChip}${names.role ? ` · ${escapeHtml(names.role)}` : ""}</div>
                    <div class="cc-tags">${tags.join("")}</div>
                </div>
            </div>
            ${grid ? `<div class="cc-hase cc-npc-stats">${grid}</div>` : ""}
            ${body}`;
    }

    function summary()
    {
        const chosen = entries.filter(entry => _inMode(entry) && state.picked.has(entry.index));
        let created = 0;
        let updated = 0;
        for (const entry of chosen)
        {
            if (_exporting())
                updated++;
            else if (state.replace.has(entry.index) || (entry.statusKey === "unl" && _unlinkActor(entry)))
                updated++;
            else if (entry.statusKey === "new" || entry.statusKey === "unl")
                created++;
            else
                updated += entry.cmp.copies.filter(copy => !_off(entry).has(copy.actor.id)).length;
        }
        return {
            count: chosen.length,
            created,
            updated,
            custom: chosen.some(entry => entry.npc.custom),
            label: plural(chosen.length, "NPC")
        };
    }

    function activate($root, { onChange } = {})
    {
        const $list = $root.find(".cc-list");
        const $detail = $root.find(".cc-detail-scroll");
        let shownFocus = null;

        function renderDetail()
        {
            const entry = focused();
            $detail.html(entry ? _dossier(entry) : `<div class="cc-info">No NPC selected.</div>`);
            if (shownFocus !== state.focus)
            {
                $detail.scrollTop(0);
                $detail.removeClass("cc-enter");
                $detail[0]?.getBoundingClientRect();
                $detail.addClass("cc-enter");
                shownFocus = state.focus;
            }
        }

        function renderList()
        {
            const current = focused();
            if (!current || !_shown(current))
                state.focus = entries.find(_shown)?.index ?? null;
            $list.find(".cc-empty").toggleClass("lancer-hidden", entries.some(_shown));
            for (const entry of entries)
            {
                const picked = state.picked.has(entry.index);
                $list.find(`.cc-row[data-index="${entry.index}"]`)
                    .toggleClass("lancer-hidden", !_shown(entry))
                    .toggleClass("selected", picked)
                    .toggleClass("cc-focus", entry.index === state.focus)
                    .find(".npc-checkbox")
                    .prop("checked", picked)
                    .prop("indeterminate", picked && _off(entry).size > 0);
            }
            const pool = entries.filter(_inMode);
            for (const key of NPC_FILTERS)
            {
                const count = key === "all" ? pool.length : pool.filter(entry => entry.statusKey === key).length;
                $root.find(`.cc-chip[data-filter="${key}"] .cc-count`).text(count);
            }
            const info = summary();
            const updatedText = _exporting() ? `${info.updated} updated in Comp/Con` : `${plural(info.updated, "actor")} updated`;
            const parts = info.count
                ? [info.label, `${info.created} new`, updatedText]
                : ["Nothing selected"];
            $root.find(".cc-summary").text(parts.join(" · "));
            $root.find(".cc-seg").toggleClass("cc-off", !info.custom);
            $root.find(".cc-seg button").each(function()
            {
                $(this).toggleClass("active", $(this).data("scale") === state.scaling).prop("disabled", !info.custom);
            });
            if (typeof onChange === "function")
                onChange(info);
        }

        function render()
        {
            renderList();
            renderDetail();
        }

        function setPicked(index, picked)
        {
            state.copyOff.delete(index);
            if (picked)
                state.picked.add(index);
            else
                state.picked.delete(index);
        }

        function focused()
        {
            return entries.find(item => item.index === state.focus) || null;
        }

        $root.find("#npc-search").on("input", function()
        {
            state.query = String($(this).val() || "").toLowerCase().trim();
            render();
        }).on("keydown", event =>
        {
            if (event.key !== "Enter")
                return;
            event.preventDefault();
            event.stopPropagation();
        });
        $root.find(".cc-chip[data-filter]").on("click", function()
        {
            state.filter = $(this).data("filter");
            $root.find(".cc-chip[data-filter]").removeClass("active");
            $(this).addClass("active");
            render();
        });

        $list.on("click", ".cc-row", function(event)
        {
            const index = Number($(this).data("index"));
            if ($(event.target).is(".npc-checkbox"))
                setPicked(index, $(event.target).prop("checked"));
            else
                state.focus = index;
            render();
        });
        $list.on("keydown", ".cc-row", function(event)
        {
            if (event.target !== this || (event.key !== "Enter" && event.key !== " "))
                return;
            event.preventDefault();
            event.stopPropagation();
            state.focus = Number($(this).data("index"));
            render();
        });

        $detail.on("click", ".cc-open-sheet", async function(event)
        {
            event.preventDefault();
            event.stopPropagation();
            const doc = await fromUuid(String($(this).data("uuid") || ""));
            doc?.sheet?.render(true);
        });
        bindPan($detail);

        $detail.on("change", ".npc-copy", function()
        {
            const entry = focused();
            if (!entry)
                return;
            const ids = entry.cmp.copies.map(copy => copy.actor.id);
            const off = state.picked.has(entry.index) ? new Set(_off(entry)) : new Set(ids);
            const actorId = String($(this).attr("data-actor"));
            if ($(this).prop("checked"))
                off.delete(actorId);
            else
                off.add(actorId);
            if (off.size >= ids.length)
                setPicked(entry.index, false);
            else
            {
                state.picked.add(entry.index);
                state.copyOff.set(entry.index, off);
            }
            render();
        });

        $detail.on("change", ".npc-source", function()
        {
            const entry = focused();
            if (!entry)
                return;
            const actorId = String($(this).attr("data-actor"));
            const index = entry.cmp.copies.findIndex(copy => copy.actor.id === actorId);
            state.source.set(entry.index, Math.max(0, index));
            render();
        });

        panel.setMode = mode =>
        {
            if (mode === state.mode)
                return;
            state.mode = mode;
            state.picked.clear();
            state.copyOff.clear();
            state.filter = "all";
            setRunMark($list.find(".cc-row[data-run]"), null);
            $root.find(".cc-chip[data-filter]").removeClass("active");
            $root.find(".cc-chip[data-filter='all']").addClass("active");
            $root.find("#npc-download-portraits").closest(".cc-update").toggleClass("lancer-hidden", _exporting());
            render();
        };

        panel.setRunState = (item, status) =>
        {
            const entry = entries.find(candidate => candidate.npc === item?.npc);
            if (!entry)
                return;
            setRunMark($list.find(`.cc-row[data-index="${entry.index}"]`), status);
        };

        panel.refresh = (selection, results) =>
        {
            selection.forEach((item, position) =>
            {
                const entry = entries.find(candidate => candidate.npc === item.npc);
                const result = results[position];
                if (!entry || !result?.ok)
                    return;
                if (result.json)
                    Object.assign(entry.npc, npcFromV3Json(result.json, entry.npc.key, entry.npc.name));
                for (const choices of [state.copyOff, state.unlink, state.replace, state.source])
                    choices.delete(entry.index);
                state.picked.delete(entry.index);
            });
            entries.forEach(_diff);
            $list.html(_listHtml());
            render();
        };

        $detail.on("change", ".npc-unlink", function()
        {
            state.unlink.set(state.focus, String($(this).val()));
            state.picked.add(state.focus);
            render();
        });

        $detail.on("click", "[data-action='retarget']", async () =>
        {
            const entry = focused();
            if (!entry)
                return;
            const mapping = (await selectActorMappings([entry.npc]))?.[0];
            if (!mapping)
                return;
            if (mapping.targetActor)
            {
                state.replace.set(entry.index, { targetActor: mapping.targetActor, keepName: mapping.keepName });
                state.picked.add(entry.index);
            }
            else
                state.replace.delete(entry.index);
            render();
        });

        $detail.on("click", "[data-action='cancel-replace']", () =>
        {
            state.replace.delete(state.focus);
            render();
        });

        $root.find(".cc-seg button").on("click", function()
        {
            state.scaling = $(this).data("scale");
            renderList();
        });
        $root.find("#npc-download-portraits").on("change", function()
        {
            state.download = $(this).prop("checked");
        });
        $root.find(".cc-link[data-action='select-shown']").on("click", () =>
        {
            entries.filter(_shown).forEach(entry =>
            {
                if (!state.picked.has(entry.index))
                    setPicked(entry.index, true);
            });
            render();
        });
        $root.find(".cc-link[data-action='clear']").on("click", () =>
        {
            entries.forEach(entry => setPicked(entry.index, false));
            render();
        });

        render();
    }

    function getSelected()
    {
        if (_exporting())
            return entries.filter(entry => _inMode(entry) && state.picked.has(entry.index)).map(entry => ({ npc: entry.npc, source: _source(entry) }));
        return entries.filter(entry => state.picked.has(entry.index)).map(entry =>
        {
            const replace = state.replace.get(entry.index);
            if (replace)
                return { npc: entry.npc, replace };
            if (entry.statusKey === "unl")
            {
                const actor = _unlinkActor(entry);
                return actor ? { npc: entry.npc, link: actor } : { npc: entry.npc };
            }
            const off = _off(entry);
            if (!off.size)
                return { npc: entry.npc };
            return { npc: entry.npc, onlyActors: new Set(entry.cmp.copies.map(copy => copy.actor.id).filter(id => !off.has(id))) };
        });
    }

    function getOptions()
    {
        return { customTierMode: state.scaling, downloadPortraits: state.download };
    }

    const panel = { html, activate, getSelected, getOptions, summary, size, setMode: () => {}, setRunState: () => {}, refresh: () => {} };
    return panel;
}

export async function uploadPortraitToServer(url, npcName)
{
    if (!url)
        return null;

    const subFolder = getModuleSetting("portraitStoragePath");
    const folderPath = `modules/${MODULE_ID}/${subFolder}`;

    try
    {
        try
        {
            await FilePicker.createDirectory("data", folderPath);
        }
        catch { /* already exists */ }

        const response = await corsProxyFetch(url);
        const blob = await response.blob();

        const extension = url.split('.').pop().split(/\#|\?/)[0] || 'png';
        const fileName = `${npcName.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.${extension}`;
        const file = new File([blob], fileName, { type: blob.type });

        const uploadResponse = await FilePicker.upload("data", folderPath, file);
        return uploadResponse.path;
    }
    catch (error)
    {
        console.error("lancer-npc-import | Failed to upload portrait:", error);
        return null;
    }
}

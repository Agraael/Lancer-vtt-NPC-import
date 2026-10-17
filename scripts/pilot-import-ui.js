// Pilot panel of the Comp/Con cloud dialog, in import and export mode.

import {
    findExistingPilotByCloudId,
    comparePilotWithActor,
    cloudMechLoadoutWeapons,
    cloudMechMounts,
    cloudMechSystems,
    skillNameKey,
    cloudBondClocks,
    actorBond
} from "./pilot-import-core.js";
import { pilotFromV3Json } from "./pilot-import-compcon.js";
import { setRunMark } from "./sync-log.js";
import { mechArt, actorArt } from "./frame-art.js";
import { isOrgReserve, orgFromItem, orgLabel } from "./pilot-reserves-patch.js";
import { escapeHtml, trimText, MODULE_ID } from "./utils.js";

const STATUS_LABELS = { loss: "Loses progress", mod: "Changed", new: "New", ok: "Up to date" };
const WORDS = {
    import: {
        added: "Not in Foundry. Added on import.",
        removed: "In Foundry only. Removed on import.",
        has: "Foundry has",
        mechAdded: "Added on import.",
        mechRemoved: "Removed on import.",
        changes: "Changes on import",
        icon: "fa-download"
    },
    export: {
        added: "Not in Comp/Con. Added on export.",
        removed: "In Comp/Con only. Removed on export.",
        has: "Comp/Con has",
        mechAdded: "Added on export.",
        mechRemoved: "Removed on export.",
        changes: "Changes on export",
        icon: "fa-upload"
    }
};
const FILTERS = ["all", "loss", "mod", "new", "ok"];
const ROMAN = ["", "I", "II", "III"];
const HASE = [["Hull", "HULL", "hull"], ["Agility", "AGI", "agi"], ["Systems", "SYS", "sys"], ["Engineering", "ENG", "eng"]];
const ITEM_FIELDS = ["Talent", "License", "Skill", "Core bonus", "Reserve", "Organization", "Gear", "Bond power", "Burden", "Clock"];
const MECH_ITEM_FIELDS = ["Weapon", "System", "Mod"];
const CUSTOM_RESERVES = ["reserve_custom", "reserve_project"];
const MISSING_TIP = "Not in your compendiums or world items. The import builds it from the Comp/Con data.";
const ICONS = `modules/${MODULE_ID}/icons`;
const SYS_ICONS = "systems/lancer/assets/icons";
const ICON = {
    hp: `${ICONS}/stats/hp.svg`,
    heat: `${ICONS}/stats/heat.svg`,
    activations: `${ICONS}/stats/activations.svg`,
    hull: `${ICONS}/stats/hull.svg`,
    agi: `${ICONS}/stats/agi.svg`,
    sys: `${ICONS}/stats/sys.svg`,
    eng: `${ICONS}/stats/eng.svg`,
    skills: `${ICONS}/skills.svg`,
    armor: `${SYS_ICONS}/white/shield_outline.svg`,
    evasion: `${SYS_ICONS}/white/evasion.svg`,
    edef: `${SYS_ICONS}/white/edef.svg`,
    save: `${SYS_ICONS}/white/save.svg`,
    sensor: `${SYS_ICONS}/white/sensor.svg`,
    repair: `${SYS_ICONS}/white/repair.svg`,
    talent: `${SYS_ICONS}/white/talent.svg`,
    reserve: `${SYS_ICONS}/white/reserve_mech.svg`,
    bond: `${SYS_ICONS}/white/bond.svg`,
    coreBonus: `${SYS_ICONS}/core_bonus.svg`,
    pilotArmor: `${SYS_ICONS}/role_tank.svg`,
    frame: `${SYS_ICONS}/frame.svg`,
    weapon: `${SYS_ICONS}/weapon.svg`,
    mod: `${SYS_ICONS}/weapon_mod.svg`,
    system: `${SYS_ICONS}/mech_system.svg`,
    template: `${SYS_ICONS}/npc_template.svg`
};
const WEAPON_TYPE_ICON = {
    cqb: `${ICONS}/weapon/CQB_White.svg`,
    cannon: `${ICONS}/weapon/Canon_V2_White.svg`,
    launcher: `${ICONS}/weapon/Launcher_V2_White.svg`,
    melee: `${SYS_ICONS}/white/melee.svg`,
    nexus: `${ICONS}/weapon/Nexus_White.svg`,
    rifle: `${ICONS}/weapon/Rifle_White.svg`
};
const WEAPON_TYPE_FALLBACK = `${SYS_ICONS}/white/mech_weapon.svg`;
const MOUNT_SIZE = { "aux": 0, "aux/aux": 0, "main": 1, "main/aux": 1, "flex": 1, "improved armament": 1, "heavy": 2, "superheavy": 3, "superheavy mounting": 3 };
const RESERVE_GLYPH = {
    Mech: "cci cci-reserve-mech",
    Organization: "mdi mdi-account-multiple",
    Project: "cci cci-orbital",
    Resources: "cci cci-reserve-resource",
    Resource: "cci cci-reserve-resource",
    Tactical: "cci cci-reserve-tac",
    Bonus: "cci cci-accuracy"
};


function _icon(src, title = "", cls = "")
{
    const url = escapeHtml(src);
    return `<i class="cc-ico${cls ? ` ${cls}` : ""}" style="-webkit-mask-image:url('${url}');mask-image:url('${url}')"${title ? ` title="${escapeHtml(title)}"` : ""}></i>`;
}

function _glyph(cls, title = "")
{
    return `<i class="${cls} cc-glyph"${title ? ` title="${escapeHtml(title)}"` : ""}></i>`;
}

function _itemIcon(img)
{
    if (!img)
        return "";
    return /\.svg$/i.test(img) ? _icon(img) : `<img class="cc-item-img" src="${escapeHtml(img)}" alt="">`;
}

function _knownImg(known, lid)
{
    return lid ? known?.get?.(`img:${lid}`) || "" : "";
}

function _pan(html)
{
    return `<span class="cc-clip"><span class="cc-pan">${html}</span></span>`;
}

function _bindPan($root)
{
    $root.on("mouseenter", ".cc-mount-type", function()
    {
        const clip = $(this).find(".cc-clip")[0];
        const pan = clip?.firstElementChild;
        const overflow = pan ? pan.scrollWidth - clip.clientWidth : 0;
        if (overflow > 4)
            $(clip).stop(true).delay(300).animate({ scrollLeft: overflow }, { duration: overflow * 20, easing: "linear" });
    });
    $root.on("mouseleave", ".cc-mount-type", function()
    {
        $(this).find(".cc-clip").stop(true).animate({ scrollLeft: 0 }, { duration: 120, easing: "swing" });
    });
}

function _rankIcon(rank)
{
    const value = Math.min(3, Math.max(0, Number(rank) || 0));
    return value ? _icon(`${SYS_ICONS}/white/rank_${value}.svg`, `Rank ${value}`, "cc-rank") : "";
}

function _weaponTypeIcon(type)
{
    const key = String(type || "").toLowerCase().split(/[^a-z]+/).find(word => Object.hasOwn(WEAPON_TYPE_ICON, word));
    return _icon(key ? WEAPON_TYPE_ICON[key] : WEAPON_TYPE_FALLBACK, type || "Weapon");
}

function _sizeMark(mountType)
{
    const key = String(mountType || "").toLowerCase().trim();
    if (key === "integrated")
        return _icon(ICON.system, "Integrated");
    if (!Object.hasOwn(MOUNT_SIZE, key))
        return "";
    const level = MOUNT_SIZE[key];
    const length = 3.4;
    const gap = 2;
    const thickness = 2;
    const total = length * 4 + gap * 3;
    let bars = "";
    for (let step = 0; step < 4; step++)
    {
        const offset = total - (step + 1) * length - step * gap;
        bars += `<rect x="0" y="${offset.toFixed(2)}" width="${thickness}" height="${length}" fill="currentColor"${step <= level ? "" : ' opacity="0.25"'}/>`;
    }
    return `<svg class="cc-size" width="${thickness}" height="${total.toFixed(2)}" viewBox="0 0 ${thickness} ${total.toFixed(2)}" aria-hidden="true">${bars}</svg>`;
}

function _rankedText(value)
{
    const match = /^(.*) (I{1,3})$/.exec(String(value ?? ""));
    return match ? `${escapeHtml(match[1])}${_rankIcon(match[2].length)}` : escapeHtml(value);
}

function _rankedChange(before, after)
{
    const was = /^(.*) (I{1,3})$/.exec(String(before ?? ""));
    const now = /^(.*) (I{1,3})$/.exec(String(after ?? ""));
    if (!was || !now || was[1] !== now[1])
        return `${_rankedText(before)} → ${_rankedText(after)}`;
    return `${escapeHtml(now[1])}${_rankIcon(was[2].length)}→${_rankIcon(now[2].length)}`;
}

function _statusKey(cmp)
{
    if (cmp.status === "new")
        return "new";
    if (cmp.status === "synced")
        return "ok";
    return cmp.lowers ? "loss" : "mod";
}

function _mechStatusKey(result)
{
    if (result.status === "new")
        return "new";
    return result.status === "synced" ? "ok" : "mod";
}

function _initials(name)
{
    const parts = String(name || "?").replace(/\s'[^']+'\s/g, " ").split(/\s+/).filter(Boolean);
    return `${parts[0]?.[0] || "?"}${parts[1]?.[0] || ""}`.toUpperCase();
}

function _portrait(url, name, cls = "")
{
    return url
        ? `<img class="cc-pt ${cls}" src="${escapeHtml(url)}" alt="">`
        : `<span class="cc-pt cc-pt-initials ${cls}">${escapeHtml(_initials(name))}</span>`;
}

function _pilotPortrait(json, actor)
{
    return actorArt(actor) || json.cloud_portrait || json.img?.cloud_portrait || json.portrait || "";
}

function _frameLabel(mech)
{
    return mech.frameData
        ? [mech.frameData.source, mech.frameData.name].filter(Boolean).join(" ")
        : (mech.frame || "");
}

function _frameNames(pilot)
{
    return (pilot.mechs || []).map(mech => mech?.frameData?.name || mech?.frame || "").filter(Boolean);
}

function _ranked(name, rank)
{
    const value = Number(rank) || 0;
    return value > 0 && value <= 3 ? `${name} ${ROMAN[value]}` : name;
}

function _skillText(name, rank)
{
    const value = Number(rank) || 0;
    return value > 0 ? `${name} +${value * 2}` : name;
}

function _mirror(change)
{
    const effect = { up: "down", down: "up" }[change.effect] || change.effect;
    return { ...change, world: change.cloud, cloud: change.world, effect, worldUuid: change.cloudUuid, cloudUuid: change.worldUuid };
}

function _changesTable(changes, exporting = false)
{
    return `
        <table class="cc-changes">
            <thead><tr><th>Field</th><th>${exporting ? "Comp/Con" : "Foundry"}</th><th>${exporting ? "Foundry" : "Comp/Con"}</th><th></th></tr></thead>
            <tbody>${changes.map(change => `
                <tr>
                    <td>${escapeHtml(change.field)}</td>
                    <td>${escapeHtml(change.world || "none")}</td>
                    <td>${escapeHtml(change.cloud || "none")}</td>
                    <td class="cc-effect cc-effect-${_effectKind(change)}">${escapeHtml(_effectLabel(change))}</td>
                </tr>`).join("")}
            </tbody>
        </table>`;
}

function _effectLabel(change)
{
    if (change.detail)
        return change.detail;
    if (!change.cloud)
        return "removed";
    if (!change.world)
        return "added";
    if (change.effect === "rename")
        return "renamed";
    if (change.field !== "Level")
        return "changed";
    return change.effect === "down" ? "lower" : "higher";
}

function _isAlarm(change)
{
    return change.field === "Level" && change.effect === "down";
}

function _planText(pilot, pilotPicked, mechPicked)
{
    const mechs = pilot.mechs || [];
    const name = (mech, i) => mech?.name || `Mech ${i + 1}`;
    const picked = mechs.filter((_mech, i) => mechPicked.has(i)).map(name);
    const skipped = mechs.filter((_mech, i) => !mechPicked.has(i)).map(name);
    if (!pilotPicked && !picked.length)
        return "";
    if (!pilotPicked)
        return `Mechs only: ${picked.join(", ")}. The pilot is not touched.`;
    if (!picked.length)
        return mechs.length ? "Pilot only. Its mechs stay as they are." : "Pilot only.";
    if (!skipped.length)
        return `Pilot and ${picked.length === 1 ? picked[0] : `all ${picked.length} mechs`}.`;
    return `Pilot and ${picked.join(", ")}. ${skipped.join(", ")} ${skipped.length === 1 ? "stays" : "stay"} as is.`;
}

function _effectKind(change)
{
    if (_isAlarm(change))
        return "lower";
    if (!change.world && change.cloud)
        return "added";
    if (!change.cloud && change.world)
        return "removed";
    return "changed";
}

function _statusText(status)
{
    return String(status || "").trim().toUpperCase();
}

function _playerName(json)
{
    const name = String(json.player_name || "").trim();
    return /^[-\s]*$/.test(name) ? "" : name;
}

function _shortChange(before, after)
{
    const head = text => text.split(" ").slice(0, -1).join(" ");
    const tail = text => text.split(" ").slice(-1)[0];
    return head(before) && head(before) === head(after)
        ? `${head(after)} ${tail(before)} → ${tail(after)}`
        : `${before} → ${after}`;
}

function _missingMark(known, lid, tip = MISSING_TIP)
{
    if (!known || !lid || known.has(lid))
        return "";
    return `<i class="fas fa-circle-exclamation cc-missing" title="${tip}"></i>`;
}

function _chip(known, lid, cls, title, body, directUuid = null)
{
    const uuid = directUuid || (lid ? known?.get?.(lid) : null);
    const classes = [cls, uuid ? "cc-open-sheet" : ""].filter(Boolean).join(" ");
    const tip = [title, uuid ? "Click to open." : ""].filter(Boolean).join(" ");
    return `<span${classes ? ` class="${classes}"` : ""}${uuid ? ` data-uuid="${escapeHtml(uuid)}"` : ""}${tip ? ` title="${escapeHtml(tip)}"` : ""}>${body}</span>`;
}

function _diffChips(label, items, field, changes, known, { tip = MISSING_TIP, icon = "", ranked = false, words = WORDS.import } = {})
{
    const chips = _diffChipList(items, field, changes, known, { tip, ranked, words });
    if (!chips.length)
        return "";
    return `
        <div class="cc-sec">
            <h5>${icon}${label}</h5>
            <div class="cc-chips">${chips.join("")}</div>
        </div>`;
}

function _diffChipList(items, field, changes, known, { tip = MISSING_TIP, ranked = false, words = WORDS.import } = {})
{
    const pool = changes.filter(change => change.field === field);
    const take = item =>
    {
        const index = pool.findIndex(entry => entry.cloud === item.label);
        return index >= 0 ? pool.splice(index, 1)[0] : null;
    };
    const text = value => ranked ? _rankedText(value) : escapeHtml(value);
    const chips = items.map(item =>
    {
        const mark = _missingMark(known, item.lid, tip);
        const lead = item.icon || "";
        const change = take(item);
        if (!change)
            return _chip(known, item.lid, "", "", `${lead}${text(item.label)}${mark}`, item.uuid);
        if (!change.world)
            return _chip(known, item.lid, "cc-chip-added", words.added, `${lead}+ ${text(item.label)}${mark}`, item.uuid);
        const shift = ranked ? _rankedChange(change.world, item.label) : escapeHtml(_shortChange(change.world, item.label));
        return _chip(known, item.lid, "cc-chip-changed", `${words.has} ${change.world}.`, `${lead}${shift}${mark}`, item.uuid);
    });
    for (const change of pool.filter(entry => entry.world && !entry.cloud))
        chips.push(_chip(null, null, "cc-chip-removed", words.removed, `− ${text(change.world)}`, change.worldUuid));
    return chips;
}

function _cloudBondView(pilot)
{
    const json = pilot.json || {};
    const bondId = trimText(json.bondId);
    return {
        bondId,
        bondName: pilot.names?.bond || bondId,
        bondUuid: null,
        xp: json.xp ?? 0,
        stress: json.stress ?? 0,
        maxStress: json.bond?.maxStress ?? 8,
        ideal: trimText(json.minorIdeal),
        answers: (Array.isArray(json.bondAnswers) ? json.bondAnswers : []).map(trimText).filter(Boolean),
        powers: (Array.isArray(json.bondPowers) ? json.bondPowers : []).filter(power => power?.name).map(power => ({ label: trimText(power.name) })),
        burdens: cloudBondClocks(json.burdens).map(clock => ({ label: clock.label })),
        clocks: cloudBondClocks(json.clocks).map(clock => ({ label: clock.label }))
    };
}

function _worldClockLabels(list)
{
    return (Array.isArray(list) ? list : [])
        .filter(Boolean)
        .map(clock => ({ label: `${trimText(clock.name)} ${Number(clock.value) || 0}/${Number(clock.max) || 0}` }));
}

function _actorBondView(actor)
{
    const bond = actorBond(actor);
    const state = actor?.system?.bond_state || {};
    return {
        bondId: trimText(bond?.system?.lid),
        bondName: bond?.name || "",
        bondUuid: bond?.uuid || null,
        xp: state.xp?.value ?? 0,
        stress: state.stress?.value ?? 0,
        maxStress: state.stress?.max ?? 8,
        ideal: trimText(state.minor_ideal),
        answers: (Array.isArray(state.answers) ? state.answers : []).map(trimText).filter(Boolean),
        powers: (bond?.system?.powers || []).filter(power => power?.unlocked && power?.name).map(power => ({ label: trimText(power.name) })),
        burdens: _worldClockLabels(state.burdens),
        clocks: _worldClockLabels(state.clocks)
    };
}

function _bondSection(view, changes, known, words = WORDS.import)
{
    const bondId = view.bondId;
    const isBond = change => change.field.startsWith("Bond") || ["Minor ideal", "Burden", "Clock"].includes(change.field);
    if (!bondId && !changes.some(isBond))
        return "";
    const bondChips = _diffChipList(bondId ? [{ label: view.bondName, lid: bondId, uuid: view.bondUuid }] : [], "Bond", changes, known, { words });
    const was = field =>
    {
        const change = changes.find(entry => entry.field === field);
        return change ? `<em>was ${escapeHtml(change.world)}</em>` : "";
    };
    const stats = bondId
        ? `<div class="cc-stats"><span><i>XP</i> ${escapeHtml(view.xp)}/8${was("Bond XP")}</span><span><i>Stress</i> ${escapeHtml(view.stress)}/${escapeHtml(view.maxStress)}${was("Bond stress")}</span></div>`
        : "";
    const answers = view.answers;
    const powers = view.powers;
    const clocks = (list, field) => _diffChipList(list, field, changes, known, { words });
    const row = (label, content) => content ? `
        <div class="cc-lrow">
            <span class="cc-mount-type"><span class="cc-mount-name">${_pan(label)}</span></span>
            <div class="cc-lcell">${content}</div>
        </div>` : "";
    const chipRow = chips => chips.length ? `<div class="cc-chips">${chips.join("")}</div>` : "";
    const text = value => value ? `<div class="cc-bond-text">${escapeHtml(value)}</div>` : "";
    return `
        <div class="cc-sec">
            <h5>${_icon(ICON.bond)}Bond</h5>
            <div class="cc-loadout">
                ${row("Bond", `${chipRow(bondChips)}${stats}`)}
                ${row("Ideal", text(view.ideal))}
                ${row("Answers", answers.map(text).join(""))}
                ${row("Powers", chipRow(_diffChipList(powers, "Bond power", changes, known, { words })))}
                ${row("Burdens", chipRow(clocks(view.burdens, "Burden")))}
                ${row("Clocks", chipRow(clocks(view.clocks, "Clock")))}
            </div>
        </div>`;
}

function _pilotItems(pilot, known)
{
    const json = pilot.json || {};
    const names = pilot.names || {};
    const talents = (json.talents || []).map(talent => ({ label: _ranked(talent?.data?.name || talent?.id || "", talent?.rank), lid: talent?.id }));
    const licenses = (json.licenses || []).map(license =>
    {
        const id = typeof license === "string" ? license : (license?.id || "");
        return {
            label: _ranked(names.licenses?.[id] || license?.stub?.name || id, typeof license === "string" ? 1 : license?.rank),
            lid: id ? `lic_${String(id).replace(/^(?:lic_)+/, "")}` : ""
        };
    });
    const skills = (json.skills || []).map(skill =>
    {
        const name = skill?.custom ? skill.id : (skill?.data?.name || skill?.id || "");
        const byName = skillNameKey(name);
        const lid = !skill?.custom && (!known || known.has(skill?.id) || !known.has(byName)) ? skill?.id : byName;
        return { label: _skillText(name, skill?.rank), lid };
    });
    const coreBonuses = (json.core_bonuses || []).map(bonus =>
    {
        const id = typeof bonus === "string" ? bonus : (bonus?.id || "");
        return { label: names.coreBonuses?.[id] || bonus?.name || id, lid: id };
    });
    const reserves = (json.reserves || []).map(reserve => ({
        label: reserve?.name || reserve?.label || reserve?.id || "",
        lid: CUSTOM_RESERVES.includes(reserve?.id) ? "" : reserve?.id,
        icon: RESERVE_GLYPH[reserve?.type] ? _glyph(RESERVE_GLYPH[reserve.type], reserve.type) : ""
    }));
    const loadout = json.loadout || json.loadouts?.[json.active_index ?? json.active_loadout_index ?? 0] || {};
    const gearIcon = (key, item) =>
    {
        const img = _itemIcon(_knownImg(known, item.id || item.data?.id));
        if (key === "armor")
            return img || _icon(ICON.pilotArmor, "Armor");
        return key === "weapons" ? _weaponTypeIcon(item.data?.type) : img;
    };
    const gear = ["armor", "weapons", "gear"]
        .flatMap(key => (loadout[key] || []).filter(Boolean).map(item => ({
            label: item.flavorName || item.data?.name || item.id || "",
            lid: item.id || item.data?.id,
            icon: gearIcon(key, item)
        })));
    const orgs = (Array.isArray(json.orgs) ? json.orgs : [])
        .filter(org => org && typeof org === "object" && trimText(org.name))
        .map(org => ({ label: orgLabel(org), lid: "" }));
    const clean = list => list.filter(item => item.label);
    return { talents: clean(talents), licenses: clean(licenses), skills: clean(skills), coreBonuses: clean(coreBonuses), reserves: clean(reserves), orgs: clean(orgs), gear: clean(gear) };
}

function _currentRank(item)
{
    return Math.min(3, Math.max(1, Number(item.system?.curr_rank) || 1));
}

function _actorPilotItems(actor)
{
    const items = [...(actor?.items || [])];
    const ofType = type => items.filter(item => item.type === type);
    const entry = (item, label, icon = "") => ({ label, lid: item.system?.lid || "", uuid: item.uuid, icon });
    const gearIcon = item =>
    {
        if (item.type === "pilot_armor")
            return _icon(ICON.pilotArmor, "Armor");
        return item.type === "pilot_weapon" ? _weaponTypeIcon(item.system?.type) : _itemIcon(item.img);
    };
    const clean = list => list.filter(item => item.label);
    return {
        talents: clean(ofType("talent").map(item => entry(item, _ranked(item.name, _currentRank(item))))),
        licenses: clean(ofType("license").map(item => entry(item, _ranked(item.name, _currentRank(item))))),
        skills: clean(ofType("skill").map(item => entry(item, _skillText(item.name, _currentRank(item)), ""))),
        coreBonuses: clean(ofType("core_bonus").map(item => entry(item, item.name))),
        reserves: clean(ofType("reserve").filter(item => !isOrgReserve(item)).map(item => entry(item, item.name))),
        orgs: clean(items.filter(isOrgReserve).map(item => entry(item, orgLabel(orgFromItem(item))))),
        gear: clean(["pilot_armor", "pilot_weapon", "pilot_gear"].flatMap(ofType).map(item => entry(item, item.name, gearIcon(item))))
    };
}

function _exportStatusKey(cmp)
{
    if (cmp.status === "synced")
        return "ok";
    return (cmp.changes || []).some(change => change.field === "Level" && change.effect === "up") ? "loss" : "mod";
}

function _existingMechs(entry)
{
    return (entry.cmp.mechResults || []).map((result, mechIndex) => result.existing ? mechIndex : -1).filter(mechIndex => mechIndex >= 0);
}

function _pilotRow(entry, exporting = false)
{
    const { pilot, index } = entry;
    const statusKey = exporting ? entry.exportStatusKey : entry.statusKey;
    const frames = _frameNames(pilot);
    const name = exporting ? entry.actor?.name || pilot.name : pilot.name;
    const level = exporting ? entry.actor?.system?.level ?? pilot.level : pilot.level;
    return `
        <div class="lancer-list-item cc-row" data-index="${index}" data-st="${statusKey}" tabindex="0">
            <span class="cc-stripe"></span>
            <input type="checkbox" class="pilot-checkbox" data-index="${index}">
            ${_portrait(_pilotPortrait(pilot.json, entry.actor), name)}
            <div class="cc-row-text">
                <div class="cc-row-name">${escapeHtml(name)}</div>
                <div class="cc-row-sub">LL${escapeHtml(level)} · ${escapeHtml(frames.join(", ") || "No mechs")}</div>
            </div>
            <span class="cc-dot" data-st="${statusKey}" title="${STATUS_LABELS[statusKey]}"></span>
        </div>`;
}

function _mechStats(mech)
{
    const max = mech.stats?.max || {};
    const base = mech.frameData?.stats || {};
    const pick = (...values) => values.find(value => Number(value) > 0);
    return [
        ["HP", max.hp > 0 ? max.hp : base.hp, _icon(ICON.hp)],
        ["Heat", pick(max.heatcap, base.heatcap), _icon(ICON.heat)],
        ["Structure", pick(max.structure, base.structure), _glyph("cci cci-structure")],
        ["Stress", pick(max.stress, base.stress), _glyph("cci cci-reactor")],
        ["Repair", pick(max.repairCapacity, base.repcap), _icon(ICON.repair)]
    ].filter(([, value]) => Number(value) > 0);
}

function _plural(count, word)
{
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function _itemLid(item)
{
    return item?.system?.lid || item?.lid || "";
}

function _counts(lids)
{
    const counts = new Map();
    for (const lid of lids)
        counts.set(lid, (counts.get(lid) || 0) + 1);
    return counts;
}

function _consume(counts, lid)
{
    const count = counts.get(lid) || 0;
    if (!count)
        return false;
    counts.set(lid, count - 1);
    return true;
}

function _worldChip(item, kept, icon = "")
{
    return kept
        ? _chip(null, null, "", "", `${icon}${escapeHtml(item.name)}`, item.uuid)
        : _chip(null, null, "cc-chip-removed", "Removed on import.", `${icon}− ${escapeHtml(item.name)}`, item.uuid);
}

function _cloudChip(item, kept, known, icon = "")
{
    const mark = _missingMark(known, item.id);
    return kept
        ? _chip(known, item.id, "", "", `${icon}${escapeHtml(item.name)}${mark}`)
        : _chip(known, item.id, "cc-chip-added", "Added on import.", `${icon}+ ${escapeHtml(item.name)}${mark}`);
}

function _worldWeaponType(item)
{
    const sys = item?.system;
    const profile = sys?.active_profile ?? sys?.profiles?.[sys?.selected_profile_index ?? 0];
    return profile?.type || "";
}

function _weaponLine(weaponChip, modChips)
{
    const mods = modChips.filter(Boolean);
    return `
        <div class="cc-weapon">
            ${weaponChip}
            ${mods.length ? `<div class="cc-weapon-mods">${mods.join("")}</div>` : ""}
        </div>`;
}

function _worldMounts(actor)
{
    return (actor?.system?.loadout?.weapon_mounts || [])
        .map(mount => ({
            type: mount.type || "Mount",
            slots: (mount.slots || [])
                .filter(slot => slot.weapon?.value)
                .map(slot => ({
                    weapon: { id: _itemLid(slot.weapon.value), name: slot.weapon.value.name, uuid: slot.weapon.value.uuid, type: _worldWeaponType(slot.weapon.value) },
                    mod: slot.mod?.value ? { id: _itemLid(slot.mod.value), name: slot.mod.value.name, uuid: slot.mod.value.uuid } : null
                }))
        }))
        .filter(mount => mount.slots.length);
}

function _mergedMods(worldMod, cloudMod, known, hasWorld)
{
    const icon = _icon(ICON.mod, "Weapon mod");
    if (worldMod && cloudMod && worldMod.id === cloudMod.id)
        return [_cloudChip(cloudMod, true, known, icon)];
    return [
        worldMod ? _worldChip(worldMod, false, icon) : "",
        cloudMod ? _cloudChip(cloudMod, !hasWorld, known, icon) : ""
    ];
}

function _exportChip(item, kept, icon = "")
{
    return kept
        ? _chip(null, null, "", "", `${icon}${escapeHtml(item.name)}`, item.uuid)
        : _chip(null, null, "cc-chip-added", WORDS.export.mechAdded, `${icon}+ ${escapeHtml(item.name)}`, item.uuid);
}

function _exportRemovedChip(item, known, icon = "")
{
    return _chip(known, item.id, "cc-chip-removed", WORDS.export.mechRemoved, `${icon}− ${escapeHtml(item.name)}`);
}

function _exportSlots(worldSlots, cloudSlots, known)
{
    const modIcon = _icon(ICON.mod, "Weapon mod");
    const used = new Set();
    const lines = worldSlots.map(slot =>
    {
        const icon = _weaponTypeIcon(slot.weapon.type);
        const index = cloudSlots.findIndex((candidate, i) => !used.has(i) && candidate.weapon.id === slot.weapon.id);
        if (index >= 0)
            used.add(index);
        const cloudMod = index >= 0 ? cloudSlots[index].mod : null;
        const mods = slot.mod && cloudMod && slot.mod.id === cloudMod.id
            ? [_exportChip(slot.mod, true, modIcon)]
            : [slot.mod ? _exportChip(slot.mod, false, modIcon) : "", cloudMod ? _exportRemovedChip(cloudMod, known, modIcon) : ""];
        return _weaponLine(_exportChip(slot.weapon, index >= 0, icon), mods);
    });
    cloudSlots.forEach((slot, index) =>
    {
        if (!used.has(index))
            lines.push(_weaponLine(_exportRemovedChip(slot.weapon, known, _weaponTypeIcon(slot.weapon.type)), [slot.mod ? _exportRemovedChip(slot.mod, known, modIcon) : ""]));
    });
    return lines;
}

function _mergedSlots(worldSlots, cloudSlots, known, hasWorld, exporting = false)
{
    if (exporting)
        return _exportSlots(worldSlots, cloudSlots, known);
    const used = new Set();
    const lines = cloudSlots.map(slot =>
    {
        const icon = _weaponTypeIcon(slot.weapon.type);
        const index = worldSlots.findIndex((candidate, i) => !used.has(i) && candidate.weapon.id === slot.weapon.id);
        if (index < 0)
            return _weaponLine(_cloudChip(slot.weapon, !hasWorld, known, icon), _mergedMods(null, slot.mod, known, hasWorld));
        used.add(index);
        return _weaponLine(_cloudChip(slot.weapon, true, known, icon), _mergedMods(worldSlots[index].mod, slot.mod, known, hasWorld));
    });
    worldSlots.forEach((slot, index) =>
    {
        if (!used.has(index))
            lines.push(_weaponLine(_worldChip(slot.weapon, false, _weaponTypeIcon(slot.weapon.type)), [slot.mod ? _worldChip(slot.mod, false, _icon(ICON.mod, "Weapon mod")) : ""]));
    });
    return lines;
}

function _weaponLoadout(mech, known, actor, exporting = false)
{
    const cloudMounts = cloudMechMounts(mech);
    const worldMounts = _worldMounts(actor);
    const used = new Set();
    const pairs = cloudMounts.map(mount =>
    {
        const index = worldMounts.findIndex((candidate, i) => !used.has(i) && candidate.type.toLowerCase() === String(mount.rawType || "").toLowerCase());
        if (index >= 0)
            used.add(index);
        return { label: mount.type, world: index >= 0 ? worldMounts[index] : null, cloud: mount };
    });
    worldMounts.forEach((mount, index) =>
    {
        if (!used.has(index))
            pairs.push({ label: mount.type, world: mount, cloud: null });
    });
    if (!pairs.length)
        return "";

    const rows = pairs.map(pair => `
        <div class="cc-lrow">
            <span class="cc-mount-type">${_sizeMark(pair.label)}<span class="cc-mount-name">${_pan(escapeHtml(pair.label))}</span></span>
            <div class="cc-lcell">${_mergedSlots(pair.world?.slots || [], pair.cloud?.slots || [], known, !!actor, exporting).join("")}</div>
        </div>`);
    return `
        <div class="cc-sec">
            <h5>${_icon(ICON.weapon)}Weapons</h5>
            <div class="cc-loadout">${rows.join("")}</div>
        </div>`;
}

function _systemLoadout(mech, known, actor, exporting = false)
{
    const cloud = cloudMechSystems(mech);
    const world = (actor?.system?.loadout?.systems || [])
        .map(system => system.value)
        .filter(Boolean)
        .map(item => ({ id: _itemLid(item), name: item.name, uuid: item.uuid, img: item.img }));
    if (!cloud.length && !world.length)
        return "";
    const worldImg = new Map(world.map(item => [item.id, item.img]));
    const worldCounts = _counts(world.map(item => item.id));
    const cloudCounts = _counts(cloud.map(item => item.id));
    let chips;
    if (exporting)
    {
        chips = world.map(item => _exportChip(item, _consume(cloudCounts, item.id), _itemIcon(item.img)));
        for (const item of cloud)
        {
            if (!_consume(worldCounts, item.id))
                chips.push(_exportRemovedChip(item, known, _itemIcon(_knownImg(known, item.id))));
        }
    }
    else
    {
        chips = cloud.map(item => _cloudChip(item, !actor || _consume(worldCounts, item.id), known, _itemIcon(_knownImg(known, item.id) || worldImg.get(item.id))));
        for (const item of world)
        {
            if (!_consume(cloudCounts, item.id))
                chips.push(_worldChip(item, false, _itemIcon(item.img)));
        }
    }
    return `
        <div class="cc-sec">
            <h5>${_icon(ICON.system)}Systems</h5>
            <div class="cc-chips">${chips.join("")}</div>
        </div>`;
}

function _mechMissing(mech, known)
{
    if (!known)
        return 0;
    const lids = [
        mech.frame || mech.frameData?.id,
        ...cloudMechLoadoutWeapons(mech).flatMap(entry => [entry.weapon.id, entry.mod?.id]),
        ...cloudMechSystems(mech).map(item => item.id)
    ].filter(Boolean);
    return lids.filter(lid => !known.has(lid)).length;
}

function _mechCard(mech, result, mechIndex, checked, moves, open, known, exporting = false)
{
    const statusKey = _mechStatusKey(result);
    const art = mechArt(mech, result.existing);
    const worldWeapons = _worldMounts(result.existing).reduce((total, mount) => total + mount.slots.length, 0);
    const worldSystems = (result.existing?.system?.loadout?.systems || []).filter(system => system?.value).length;
    const weapons = exporting ? worldWeapons : cloudMechLoadoutWeapons(mech).length;
    const systems = exporting ? worldSystems : cloudMechSystems(mech).length;
    const changeCount = result.changes?.length || 0;
    const missing = exporting ? 0 : _mechMissing(mech, known);
    const summaryParts = [_plural(weapons, "weapon"), _plural(systems, "system"), changeCount ? _plural(changeCount, "change") : "no changes"];
    const summary = escapeHtml(summaryParts.join(" · "))
        + (missing ? ` · <span class="cc-missing-text" title="${MISSING_TIP}"><i class="fas fa-circle-exclamation"></i> ${missing} not in compendium</span>` : "");
    let pickTitle = result.existing ? "Update this mech from Comp/Con. Unticked, it stays as it is." : "Create this mech from Comp/Con";
    if (exporting)
        pickTitle = result.existing ? "Update this mech in Comp/Con. Unticked, it stays as it is." : "Not in Foundry. It stays as it is in Comp/Con.";
    const words = exporting ? WORDS.export : WORDS.import;

    const statLine = _mechStats(mech)
        .map(([label, value, icon]) => `<span>${icon}<i>${label}</i> ${escapeHtml(value)}</span>`)
        .join("");
    const mechChanges = (result.changes || []).map(change => exporting ? _mirror(change) : change);
    const headline = mechChanges.filter(change => !MECH_ITEM_FIELDS.includes(change.field));
    const details = `
        <div class="cc-mech-fold">
            <div class="cc-mech-clip">
                <div class="cc-mech-body">
                    ${statLine ? `<div class="cc-stats">${statLine}</div>` : ""}
                    ${headline.length ? `<div class="cc-mech-changes"><h5>${words.changes}</h5>${_changesTable(headline, exporting)}</div>` : ""}
                    ${_weaponLoadout(mech, known, result.existing, exporting)}
                    ${_systemLoadout(mech, known, result.existing, exporting)}
                </div>
            </div>
        </div>`;

    return `
        <div class="lancer-list-item cc-mech${open ? " cc-open" : ""}" data-st="${statusKey}">
            <span class="cc-stripe"></span>
            <label class="cc-mech-pick" title="${pickTitle}">
                <input type="checkbox" class="mech-checkbox" data-mech="${mechIndex}"${checked ? " checked" : ""}${exporting && !result.existing ? " disabled" : ""}>
                <span>${exporting ? "Export" : "Import"}</span>
            </label>
            <span class="cc-art cc-mech-toggle" data-mech="${mechIndex}">${art ? `<img src="${escapeHtml(art)}" alt="">` : `<i class="cci cci-frame"></i>`}</span>
            <div class="cc-mech-text cc-mech-toggle" data-mech="${mechIndex}">
                <div class="cc-mech-name">${escapeHtml(mech.name || `Mech ${mechIndex + 1}`)}</div>
                <div class="cc-mech-frame">${_icon(ICON.frame)}${_chip(known, mech.frame || mech.frameData?.id, "", "", escapeHtml(_frameLabel(mech)))}${_missingMark(known, mech.frame || mech.frameData?.id)}</div>
                <div class="cc-mech-sum">${summary}</div>
            </div>
            <span class="cc-pill" data-st="${statusKey}">${STATUS_LABELS[statusKey]}</span>
            <i class="fas fa-chevron-down cc-caret cc-mech-toggle" data-mech="${mechIndex}"></i>
            ${moves ? `<div class="cc-mech-note">Moves from ${escapeHtml(moves)} to the new copy if ticked.</div>` : ""}
            ${details}
        </div>`;
}

function _dossier(entry, options)
{
    const { pilot, cmp } = entry;
    const json = pilot.json || {};
    const exporting = options.mode === "export";
    const words = exporting ? WORDS.export : WORDS.import;
    const actor = entry.actor;
    const copy = !exporting && !options.update && cmp.status !== "new";
    const statusKey = copy ? "new" : (exporting ? entry.exportStatusKey : entry.statusKey);
    const pilotPicked = options.pilots.has(entry.index);
    const mechPicked = options.mechs.get(entry.index) || new Set();
    const raw = copy ? [] : (cmp.changes || []);
    const changes = exporting ? raw.map(_mirror) : raw;
    const name = exporting ? actor?.name || pilot.name : pilot.name;
    const callsign = exporting ? actor?.system?.callsign || "" : pilot.callsign;
    const level = exporting ? actor?.system?.level ?? pilot.level : pilot.level;
    const tags = [`<span class="cc-tag cc-tag-ll">LL${escapeHtml(level)}</span>`];
    const status = _statusText(json.status);
    if (status)
        tags.push(`<span class="cc-tag">${escapeHtml(status)}</span>`);
    const player = _playerName(json);
    if (player)
        tags.push(`<span class="cc-tag">Player: ${escapeHtml(player)}</span>`);
    tags.push(`<span class="cc-pill" data-st="${statusKey}">${STATUS_LABELS[statusKey]}${cmp.count > 1 ? ` ×${cmp.count}` : ""}</span>`);

    const skills = Array.isArray(json.mechSkills) ? json.mechSkills : [];
    const hase = HASE.map(([field, label, key], i) =>
    {
        const change = changes.find(item => item.field === field);
        const was = change ? `<em>was ${escapeHtml(change.world)}</em>` : "";
        const value = exporting ? actor?.system?.[key] ?? 0 : skills[i] ?? 0;
        return `<span${change ? ` class="cc-stat-changed"` : ""}><b class="cc-stat-lab">${_icon(ICON[key])}${label}</b>${escapeHtml(value)}${was}</span>`;
    }).join("");

    let body = "";
    const warnings = [];
    const levelDown = changes.find(change => change.field === "Level" && change.effect === "down");
    if (levelDown && exporting)
        warnings.push(`<b>Foundry is behind Comp/Con.</b> Comp/Con has LL${escapeHtml(levelDown.world)}, Foundry has LL${escapeHtml(levelDown.cloud)}. Exporting sets Comp/Con back to LL${escapeHtml(levelDown.cloud)}.`);
    else if (levelDown)
        warnings.push(`<b>Comp/Con is behind Foundry.</b> Foundry has LL${escapeHtml(levelDown.world)}, Comp/Con has LL${escapeHtml(levelDown.cloud)}. Importing sets this pilot back to LL${escapeHtml(levelDown.cloud)}.`);
    if (warnings.length)
    {
        body += `
            <div class="cc-warn">
                <i class="fas fa-exclamation-triangle"></i>
                <div>${warnings.map(line => `<div>${line}</div>`).join("")}</div>
            </div>`;
    }
    if (exporting && cmp.status === "synced")
        body += `<div class="cc-info" data-st="ok">No changes. Nothing to export.</div>`;
    else if (copy)
        body += `<div class="cc-info" data-st="new">Update is off. Creates a second copy of this pilot. The Foundry pilot is left as is.</div>`;
    else if (cmp.status === "new")
        body += `<div class="cc-info" data-st="new">Creates the pilot${pilot.mechs?.length ? ` and ${pilot.mechs.length} mech${pilot.mechs.length > 1 ? "s" : ""}` : ""}.</div>`;
    else if (cmp.status === "synced")
        body += `<div class="cc-info" data-st="ok">No build changes. Importing refills HP, structure, stress and repairs and clears heat.</div>`;
    const plan = _planText(pilot, pilotPicked, mechPicked);
    if (plan)
        body += `<div class="cc-plan"><i class="fas ${words.icon}"></i><span>${escapeHtml(plan)}</span></div>`;
    const headline = changes.filter(change => !ITEM_FIELDS.includes(change.field));
    if (headline.length)
        body += `<div class="cc-sec"><h5>${words.changes}</h5>${_changesTable(headline, exporting)}</div>`;

    const known = exporting ? null : options.known;
    const items = exporting ? _actorPilotItems(actor) : _pilotItems(pilot, known);
    const allItems = Object.values(items).flat();
    const missing = known
        ? allItems.filter(item => item.lid && !known.has(item.lid)).length
            + (pilot.mechs || []).reduce((total, mech) => total + _mechMissing(mech || {}, known), 0)
        : 0;
    if (missing)
        body += `<div class="cc-info cc-info-missing"><i class="fas fa-circle-exclamation cc-missing"></i> ${_plural(missing, "item")} not in your compendiums or world items (missing LCP?). The import builds ${missing === 1 ? "it" : "them"} from the Comp/Con data.</div>`;

    const bondView = exporting ? _actorBondView(actor) : _cloudBondView(pilot);
    body += _diffChips("Talents", items.talents, "Talent", changes, known, { icon: _icon(ICON.talent), ranked: true, words })
        + _diffChips("Licenses", items.licenses, "License", changes, known, { words })
        + _diffChips("Skill triggers", items.skills, "Skill", changes, known, { icon: _icon(ICON.skills), words })
        + _diffChips("Core bonuses", items.coreBonuses, "Core bonus", changes, known, { icon: _icon(ICON.coreBonus), words })
        + _diffChips("Reserves", items.reserves, "Reserve", changes, known, { icon: _icon(ICON.reserve), words })
        + _diffChips("Organizations", items.orgs, "Organization", changes, known, { icon: _glyph(RESERVE_GLYPH.Organization), words })
        + _bondSection(bondView, changes, known, words)
        + _diffChips("Pilot gear", items.gear, "Gear", changes, known, { icon: _glyph("mdi mdi-bag-personal-outline"), words });

    const mechs = (cmp.mechResults || []).map((result, mechIndex) =>
    {
        const moves = copy && result.existing ? (entry.actor?.name || "the Foundry pilot") : "";
        return _mechCard(pilot.mechs[mechIndex] || {}, result, mechIndex, mechPicked.has(mechIndex), moves, options.openMechs.has(mechIndex), options.known, exporting);
    }).join("");
    body += `<div class="cc-sec"><h5>Mechs</h5>${mechs || `<div class="cc-info">No mechs in this save.</div>`}</div>`;

    return `
        <div class="cc-top">
            ${_portrait(_pilotPortrait(json, entry.actor), name, "cc-pt-lg")}
            <div class="cc-id">
                <h4>${escapeHtml(name)}</h4>
                ${callsign ? `<div class="cc-callsign">"${escapeHtml(callsign)}"</div>` : ""}
                <div class="cc-tags">${tags.join("")}</div>
            </div>
        </div>
        <div class="cc-hase">${hase}</div>
        ${body}`;
}

function _filterChips(filters, labels)
{
    return filters.map(key => `<button type="button" class="cc-chip${key === "all" ? " active" : ""}" data-filter="${key}"${key === "all" ? "" : ` data-st="${key}"`}>${key === "all" ? "" : `<span class="cc-dot" data-st="${key}"></span>`}${labels[key]} <span class="cc-count"></span></button>`).join("");
}

export function buildPilotSelectionPanel(pilots, knownLids = null)
{
    const entries = pilots.map((pilot, index) => _diff({ pilot, index }));

    function _diff(entry)
    {
        const { pilot } = entry;
        const existing = findExistingPilotByCloudId(pilot.cloudId);
        const bondId = String(pilot.json?.bondId || "").trim();
        if (bondId && !pilot.names?.bond)
            pilot.names = { ...pilot.names, bond: knownLids?.get?.(`label:${bondId}`) || pilot.json.bond?.data?.name || "" };
        entry.cmp = comparePilotWithActor(pilot.json, existing, pilot.names);
        entry.statusKey = _statusKey(entry.cmp);
        entry.exportStatusKey = _exportStatusKey(entry.cmp);
        entry.search = [pilot.name, pilot.callsign, ..._frameNames(pilot)].join(" ").toLowerCase();
        entry.actor = existing[0] || null;
        return entry;
    }
    const state = {
        pilots: new Set(),
        mechs: new Map(),
        openMechs: new Map(),
        filter: "all",
        query: "",
        focus: entries.find(entry => entry.statusKey === "loss")?.index ?? entries[0]?.index ?? null,
        update: true,
        mode: "import"
    };

    const chipLabels = { all: "All", ...STATUS_LABELS };
    const html = `
        <div class="pilot-panel cc-panel">
            <div class="cc-toolbar">
                <label class="cc-search">
                    <i class="fas fa-search"></i>
                    <input type="text" id="pilot-search" placeholder="Search name, callsign, frame" autocomplete="off">
                </label>
                ${_filterChips(FILTERS, chipLabels)}
            </div>
            <div class="cc-body">
                <div class="cc-list pilot-list">${_listHtml()}</div>
                <div class="lancer-list-item cc-detail"><div class="cc-detail-scroll"></div></div>
            </div>
            <div class="cc-foot">
                <label class="cc-update"><input type="checkbox" id="pilot-update-existing" checked> Update pilots already in Foundry</label>
                <a class="cc-link" data-action="select-shown">Select shown</a>
                <a class="cc-link" data-action="clear">Clear</a>
                <span class="cc-summary"></span>
            </div>
        </div>
    `;

    function _exporting()
    {
        return state.mode === "export";
    }

    function _inMode(entry)
    {
        return !_exporting() || (!!entry.actor && entry.cmp.status !== "new");
    }

    function _entryStatusKey(entry)
    {
        return _exporting() ? entry.exportStatusKey : entry.statusKey;
    }

    function _shown(entry)
    {
        return _inMode(entry)
            && (state.filter === "all" || _entryStatusKey(entry) === state.filter)
            && (!state.query || entry.search.includes(state.query));
    }

    function _mechSet(index)
    {
        return state.mechs.get(index) || new Set();
    }

    function _picked(entry)
    {
        return _inMode(entry) && (state.pilots.has(entry.index) || _mechSet(entry.index).size > 0);
    }

    function _canSplit(entry)
    {
        return (_exporting() || state.update) && !!entry.actor;
    }

    function _unexportableMechs(entry)
    {
        return (entry.cmp.mechResults || []).map((result, mechIndex) => result.existing ? -1 : mechIndex).filter(mechIndex => mechIndex >= 0);
    }

    function size()
    {
        return entries.filter(_inMode).length;
    }

    function _listHtml()
    {
        const rows = entries.filter(_inMode).map(entry => _pilotRow(entry, _exporting())).join("");
        return `${rows}<div class="cc-empty lancer-hidden">No pilots match.</div>`;
    }

    function summary()
    {
        const chosen = entries.filter(_picked);
        const withPilot = chosen.filter(entry => state.pilots.has(entry.index));
        const created = _exporting() ? 0 : withPilot.filter(entry => !state.update || entry.cmp.status === "new").length;
        const mechs = chosen.reduce((total, entry) => total + _mechSet(entry.index).size, 0);
        const losers = _exporting() || state.update ? withPilot.filter(entry => _entryStatusKey(entry) === "loss").length : 0;
        const labelParts = [];
        if (withPilot.length)
            labelParts.push(_plural(withPilot.length, "pilot"));
        if (mechs)
            labelParts.push(_plural(mechs, "mech"));
        return { count: chosen.length, pilots: withPilot.length, created, updated: withPilot.length - created, mechs, losers, label: labelParts.join(", ") };
    }

    function activate($root, { onChange } = {})
    {
        const $list = $root.find(".cc-list");
        const $detail = $root.find(".cc-detail-scroll");
        let shownFocus = null;

        function renderDetail()
        {
            const entry = entries.find(item => item.index === state.focus);
            $detail.html(entry
                ? _dossier(entry, { pilots: state.pilots, mechs: state.mechs, update: state.update, mode: state.mode, openMechs: state.openMechs.get(entry.index) || new Set(), known: knownLids })
                : `<div class="cc-info">No pilot selected.</div>`);
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
            const focused = entries.find(entry => entry.index === state.focus);
            if (!focused || !_shown(focused))
                state.focus = entries.find(_shown)?.index ?? null;
            $list.find(".cc-empty").toggleClass("lancer-hidden", entries.some(_shown));
            for (const entry of entries)
            {
                const $row = $list.find(`.cc-row[data-index="${entry.index}"]`);
                const pilotPicked = state.pilots.has(entry.index);
                $row.toggleClass("lancer-hidden", !_shown(entry))
                    .toggleClass("selected", _picked(entry))
                    .toggleClass("cc-focus", entry.index === state.focus);
                $row.find(".pilot-checkbox")
                    .prop("checked", pilotPicked)
                    .prop("indeterminate", !pilotPicked && _mechSet(entry.index).size > 0);
            }
            const pool = entries.filter(_inMode);
            for (const key of FILTERS)
            {
                const count = key === "all" ? pool.length : pool.filter(entry => _entryStatusKey(entry) === key).length;
                $root.find(`.cc-chip[data-filter="${key}"] .cc-count`).text(count);
            }
            const info = summary();
            const parts = info.count
                ? [_plural(info.pilots, "pilot"), `${info.created} new`, _plural(info.updated, "update"), _plural(info.mechs, "mech")]
                : ["Nothing selected"];
            $root.find(".cc-summary").html(`${escapeHtml(parts.join(" · "))}${info.losers ? ` <b class="cc-down">▼ ${info.losers} lose${info.losers === 1 ? "s" : ""} progress</b>` : ""}`);
            if (typeof onChange === "function")
                onChange(info);
        }

        function render()
        {
            renderList();
            renderDetail();
        }

        function setPilot(index, picked)
        {
            const entry = entries.find(item => item.index === index);
            if (!entry)
                return;
            if (!picked)
            {
                state.pilots.delete(index);
                state.mechs.delete(index);
                return;
            }
            state.pilots.add(index);
            if (_mechSet(index).size)
                return;
            let skip = state.update ? [] : _existingMechs(entry);
            if (_exporting())
                skip = _unexportableMechs(entry);
            state.mechs.set(index, new Set((entry.pilot.mechs || []).map((_mech, mechIndex) => mechIndex).filter(mechIndex => !skip.includes(mechIndex))));
        }

        function rebuildList()
        {
            $list.html(_listHtml());
        }

        panel.setMode = mode =>
        {
            if (mode === state.mode)
                return;
            state.mode = mode;
            state.pilots.clear();
            state.mechs.clear();
            state.filter = "all";
            $root.find(".cc-chip[data-filter]").removeClass("active");
            $root.find(".cc-chip[data-filter='all']").addClass("active");
            $root.find(".cc-update").toggleClass("lancer-hidden", _exporting());
            rebuildList();
            render();
        };

        panel.setRunState = (item, status) =>
        {
            const entry = entries.find(candidate => candidate.pilot === item?.pilot);
            if (!entry)
                return;
            setRunMark($list.find(`.cc-row[data-index="${entry.index}"]`), status);
        };

        panel.refresh = (selection, results) =>
        {
            selection.forEach((item, position) =>
            {
                const entry = entries.find(candidate => candidate.pilot === item.pilot);
                const result = results[position];
                if (!entry || !result?.ok)
                    return;
                if (result.json)
                    Object.assign(entry.pilot, pilotFromV3Json(result.json, entry.pilot.key));
                state.pilots.delete(entry.index);
                state.mechs.delete(entry.index);
            });
            entries.forEach(_diff);
            rebuildList();
            render();
        };

        $root.find("#pilot-search").on("input", function()
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
            if ($(event.target).is(".pilot-checkbox"))
                setPilot(index, $(event.target).prop("checked"));
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
        _bindPan($detail);

        $detail.on("click", ".cc-mech-toggle", function()
        {
            const mechIndex = Number($(this).data("mech"));
            const open = state.openMechs.get(state.focus) || new Set();
            if (open.has(mechIndex))
                open.delete(mechIndex);
            else
                open.add(mechIndex);
            state.openMechs.set(state.focus, open);
            $(this).closest(".cc-mech").toggleClass("cc-open", open.has(mechIndex));
        });

        $detail.on("change", ".mech-checkbox", function()
        {
            const index = state.focus;
            const mechIndex = Number($(this).data("mech"));
            const entry = entries.find(item => item.index === index);
            if (!entry)
                return;
            const picked = new Set(_mechSet(index));
            if ($(this).prop("checked"))
            {
                picked.add(mechIndex);
                if (!_canSplit(entry))
                    state.pilots.add(index);
            }
            else
                picked.delete(mechIndex);
            state.mechs.set(index, picked);
            render();
        });

        $root.find(".cc-link[data-action='select-shown']").on("click", () =>
        {
            entries.filter(_shown).forEach(entry => setPilot(entry.index, true));
            render();
        });
        $root.find(".cc-link[data-action='clear']").on("click", () =>
        {
            entries.forEach(entry => setPilot(entry.index, false));
            render();
        });
        $root.find("#pilot-update-existing").on("change", function()
        {
            state.update = $(this).prop("checked");
            if (!state.update)
            {
                for (const entry of entries.filter(_picked))
                {
                    state.pilots.add(entry.index);
                    const picked = new Set(_mechSet(entry.index));
                    _existingMechs(entry).forEach(mechIndex => picked.delete(mechIndex));
                    state.mechs.set(entry.index, picked);
                }
            }
            render();
        });

        render();
    }

    function getSelected()
    {
        return entries.filter(_picked).map(entry =>
        {
            const mechIds = new Set();
            for (const mechIndex of _mechSet(entry.index))
            {
                const id = entry.pilot.mechs?.[mechIndex]?.id;
                if (id)
                    mechIds.add(id);
            }
            return {
                pilot: entry.pilot,
                actor: entry.actor,
                mechIds,
                allMechs: mechIds.size === (entry.pilot.mechs || []).length,
                includePilot: state.pilots.has(entry.index)
            };
        });
    }

    function getOptions()
    {
        return { updateExisting: state.update };
    }

    const panel = { html, activate, getSelected, getOptions, summary, size, setMode: () => {}, setRunState: () => {}, refresh: () => {} };
    return panel;
}

export {
    _portrait as portraitHtml,
    _chip as chipHtml,
    _missingMark as missingMark,
    _diffChips as diffChips,
    _changesTable as changesTable,
    _plural as plural,
    _counts as countLids,
    _consume as consumeLid,
    _icon as iconHtml,
    _glyph as glyphHtml,
    _weaponTypeIcon as weaponTypeIconHtml,
    _pan as panHtml,
    _bindPan as bindPan,
    _mirror as mirrorChange,
    _filterChips as filterChipsHtml,
    WORDS as SYNC_WORDS,
    ICON,
    SYS_ICONS
};

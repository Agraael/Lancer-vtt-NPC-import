import { getV3Data } from "./v3-data.js";
import { MODULE_ID, escapeHtml } from "./utils.js";
import { V3DataEditor, deleteValue } from "./v3-editor.js";

const ROW_CLASS = "npci-v3-row";
const HOOK_KEYS = ["on_attack", "on_hit", "on_crit", "on_miss"];
const BOX_LABELS = {
    on_hit: ["ON HIT", "LA.effect.hit.label"],
    on_crit: ["ON CRIT", "ON CRITICAL", "LA.effect.crit.label"],
    on_attack: ["ON ATTACK", "LA.effect.attack.label"],
    effect: ["EFFECT", "LA.mech.system.effect.label"]
};
const NATIVE_HOOKS = { npc_feature: ["on_hit"], mech_weapon: ["on_attack", "on_hit", "on_crit"] };
const RANGE_TYPES = ["range", "threat", "line", "cone", "blast", "burst", "thrown"];
const RANGE_TIPS = {
    range: value => value ? `The target must be within ${value} spaces.` : "The target must be within range.",
    threat: value => value ? `Reaches targets within ${value} spaces.` : "Reaches targets within threat.",
    thrown: value => value ? `Can be thrown at a target within ${value} spaces.` : "Can be thrown.",
    line: value => value ? `Covers a straight line ${value} spaces long.` : "Covers a straight line.",
    cone: value => value ? `Covers a cone ${value} spaces long.` : "Covers a cone.",
    blast: value => value ? `Covers every space within ${value} spaces of a point in range.` : "Covers a blast area.",
    burst: value => value ? `Covers every space within ${value} spaces of its origin.` : "Covers a burst area."
};
const DAMAGE_TYPES = ["kinetic", "energy", "explosive", "heat", "burn", "variable"];
const DEFAULT_TARGET = { status: "target", special: "self", resist: "self", other: "self" };

function capitalize(value)
{
    const text = String(value ?? "").replaceAll("_", " ").trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase() : "";
}

function damageTypeLabel(type)
{
    return String(type ?? "").toLowerCase() === "aoe" ? "AoE" : capitalize(type);
}

function hasValue(value)
{
    return value !== undefined && value !== null && value !== "";
}

function valueText(value)
{
    return Array.isArray(value) ? value.join("/") : value;
}

function statusEffect(id)
{
    return CONFIG.statusEffects?.find(effect => effect.id === id) ?? null;
}

function statusLabel(id)
{
    const effect = statusEffect(id);
    return effect?.name ? game.i18n.localize(effect.name) : capitalize(id);
}

function durationText(duration)
{
    if (!duration)
        return null;
    if (duration.encounter)
        return "until the end of the encounter";
    if (duration.indefinite)
        return "indefinite";
    if (duration.at && Number.isFinite(duration.round))
    {
        const when = duration.round === 0 ? "this round" : duration.round === 1 ? "the next round" : `${duration.round} rounds from now`;
        return `until the ${duration.at} of ${when}`;
    }
    if (duration.at)
    {
        const whose = duration.of === "self" ? "your" : `the ${duration.of}'s`;
        return `until ${duration.at} of ${whose} ${duration.next ? "next " : ""}turn`;
    }
    return duration.raw;
}

function targetText(target, kind)
{
    return target && target !== DEFAULT_TARGET[kind] ? target : null;
}

function withDetails(text, ...details)
{
    const extra = details.filter(Boolean);
    return extra.length ? `${text}, ${extra.join(", ")}` : text;
}

function sentences(...parts)
{
    return parts.filter(Boolean).join(" ");
}

function detailTip(target, duration)
{
    return sentences(target ? `Affects: ${escapeHtml(target)}.` : null, duration ? `Lasts ${escapeHtml(duration)}.` : null);
}

function areaText(aoe)
{
    if (!aoe)
        return null;
    return typeof aoe === "string" ? aoe : "area";
}

function commonDetails(common, kind)
{
    const target = targetText(common.target, kind);
    const duration = durationText(common.duration);
    const area = areaText(common.aoe);
    const attack = common.attack ? `${common.attack} attack` : null;
    return {
        details: [target, duration, area, attack],
        tip: sentences(
            detailTip(target, duration),
            area ? `Affects every character in the ${escapeHtml(area)}.` : null,
            attack ? `Applied with a ${escapeHtml(attack)}.` : null
        )
    };
}

function saveChip(save, against = "this effect", half = false)
{
    if (!save?.stat)
        return null;
    const stat = save.stat.toUpperCase();
    const dc = hasValue(save.dc) ? ` ${save.dc}` : "";
    const onDamage = against === "this damage";
    return {
        icon: "cci cci-save",
        title: `${stat} save`,
        text: `${stat} save${dc}${onDamage ? (half ? " for half" : " on damage") : ""}`,
        tip: sentences(
            `The target makes a ${stat} save${escapeHtml(dc)} against ${escapeHtml(against)}.`,
            half ? "On a success it takes half damage." : null,
            areaText(save.aoe) ? `Every character in the ${escapeHtml(areaText(save.aoe))} saves.` : null
        )
    };
}

function frequencyChip(frequency, item)
{
    if (!frequency)
        return null;
    const nativeTag = frequency.count && ["round", "turn"].includes(frequency.per)
        && item.system?.tags?.some(tag => (tag?.lid ?? tag?.id) === `tg_${frequency.per}`);
    if (nativeTag)
        return null;
    if (!frequency.count)
        return { icon: "mdi mdi-update", text: frequency.raw, tip: `Usage limit: ${escapeHtml(frequency.raw)}.` };
    const per = frequency.per === "scene" ? "encounter" : frequency.per;
    return {
        icon: "mdi mdi-update",
        text: `${frequency.count}/${capitalize(per)}`,
        tip: `Can be used ${frequency.count} time${frequency.count > 1 ? "s" : ""} per ${escapeHtml(per)}.`
    };
}

function rangeChip(range)
{
    const extras = [hasValue(range.min) ? `min ${range.min}` : null, hasValue(range.bonus) ? `+${range.bonus}` : null, range.override ? "override" : null].filter(Boolean);
    const extraTip = sentences(
        hasValue(range.min) ? `Minimum range ${escapeHtml(range.min)}.` : null,
        hasValue(range.bonus) ? `Adds ${escapeHtml(range.bonus)} to this range.` : null,
        range.override ? "Replaces the base range." : null
    );
    if (!range.type)
        return extras.length ? { icon: "cci cci-range", text: `Range ${extras.join(", ")}`, tip: extraTip } : null;
    const type = String(range.type).toLowerCase();
    const value = hasValue(range.val) ? valueText(range.val) : null;
    const base = value ? `${capitalize(type)} ${value}` : capitalize(type);
    return {
        icon: `cci cci-${RANGE_TYPES.includes(type) ? type : "range"}`,
        text: extras.length ? `${base}, ${extras.join(", ")}` : base,
        tip: sentences(escapeHtml(RANGE_TIPS[type]?.(value) ?? `${base}.`), extraTip)
    };
}

function damageChips(damage)
{
    const core = [valueText(damage.val), damage.type].filter(hasValue).join(" ");
    const modifiers = [
        damage.ap ? "AP" : null,
        damage.aoe ? "AoE" : null,
        damage.irreducible ? "Irreducible" : null,
        damage.overkill ? "Overkill" : null,
        hasValue(damage.reliable) ? `Reliable ${valueText(damage.reliable)}` : null,
        hasValue(damage.bonus) ? `+${damage.bonus}` : null,
        damage.override ? "Override" : null
    ].filter(Boolean);
    let text = core ? [core, ...modifiers].join(" ") : (modifiers.length ? `${modifiers.join(" ")} damage` : "");
    if (damage.target === "self")
        text = text ? `${text}, self` : "Damage to self";
    if (damage.attack && text)
        text = `${text}, ${damage.attack} attack`;
    const type = String(damage.type ?? "").toLowerCase();
    const tip = sentences(
        core ? `Deals ${escapeHtml(core)} damage.` : null,
        damage.ap ? "AP: ignores Armor." : null,
        damage.aoe ? "Hits every character in the area." : null,
        damage.irreducible ? "Irreducible: cannot be reduced." : null,
        damage.overkill ? "Overkill: damage dice that roll 1 deal 1 Heat to the attacker and are rerolled." : null,
        hasValue(damage.reliable) ? `Reliable: deals ${escapeHtml(valueText(damage.reliable))} damage even on a miss.` : null,
        hasValue(damage.bonus) ? `Adds ${escapeHtml(damage.bonus)} damage.` : null,
        damage.override ? "Replaces the base damage." : null,
        damage.target === "self" ? "The user takes this damage." : null,
        damage.attack ? `Dealt with a ${escapeHtml(damage.attack)} attack.` : null
    );
    return [
        text ? { icon: `cci cci-${DAMAGE_TYPES.includes(type) ? type : "variable"}`, text, tip } : null,
        saveChip(damage.save, "this damage", damage.saveHalf)
    ];
}

const OTHER_LABELS = { overshield: "Overshield", cover: "Cover", hp: "HP", repairs: "Repairs", corepower: "Core Power", heat: "Heat", speed: "Speed" };

function otherChip(other)
{
    const label = OTHER_LABELS[other.type] ?? capitalize(other.type);
    const value = hasValue(other.val) ? valueText(other.val) : null;
    const text = other.type === "cover" && value ? `${capitalize(value)} cover` : (value ? `${label} ${value}` : label);
    const tips = {
        overshield: `Grants ${escapeHtml(value)} Overshield.`,
        cover: `Grants ${escapeHtml(value ?? "")} cover.`,
        hp: `Restores ${escapeHtml(value)} HP, up to the maximum.`,
        repairs: `Grants ${escapeHtml(value)} Repairs, up to the Repair Cap.`
    };
    const common = commonDetails(other, "other");
    return { icon: "mdi mdi-plus-box", title: text, text: withDetails(text, ...common.details), tip: sentences(tips[other.type] ?? `${escapeHtml(label)}: ${escapeHtml(value ?? "")}.`, common.tip) };
}

function typeList(source)
{
    return Object.entries(source ?? {}).filter(([key, value]) => key.endsWith("_types") && Array.isArray(value)).flatMap(([, value]) => value);
}

function typesText(source)
{
    const types = typeList(source);
    return types.length ? ` (${types.join(", ")})` : "";
}

function rawIndex(list, name)
{
    const items = Array.isArray(list) ? list : (list ? [list] : []);
    return items.findIndex(value => (typeof value === "string" ? value : value?.attribute) === name);
}

function chipsFor(entry, item)
{
    const chips = [];
    const ref = (kind, extra = {}) => ({ path: entry.path, kind, ...extra });
    const push = (chip, chipRef) =>
    {
        if (chip?.text)
            chips.push({ ...chip, ref: chipRef });
    };
    const pushSave = (save, against, chipRef, half = false) => push(saveChip(save, against, half), { ...chipRef, part: "save" });
    push(frequencyChip(entry.frequency, item), ref("frequency", { key: "frequency" }));
    entry.range.forEach(range => push(rangeChip(range), entry.kind === "range" ? ref("range", { self: true }) : ref("range", { index: range.index })));
    for (const damage of entry.damage)
    {
        const damageRef = entry.kind === "damage" ? ref("damage", { self: true }) : ref("damage", { index: damage.index });
        const [main, save] = damageChips(damage);
        push(main, damageRef);
        if (save)
            push(save, { ...damageRef, part: "save" });
    }
    if (entry.attack && entry.attack !== "tech")
        push({ icon: "mdi mdi-bullseye-arrow", text: `${capitalize(entry.attack)} attack`, tip: `Makes a ${escapeHtml(entry.attack.toLowerCase())} attack.` }, ref("attack", { key: "attack" }));
    if (entry.targetDefense)
    {
        const defense = entry.targetDefense === "edef" ? "E-Defense" : capitalize(entry.targetDefense);
        push({ icon: "cci cci-edef", text: `vs ${defense}`, tip: `The attack targets ${escapeHtml(defense)}.` }, ref("attack", { key: "target_defense" }));
    }
    if (entry.canCrit)
        push({ icon: "mdi mdi-flash", text: "Can crit", tip: "This attack can deal critical damage." }, ref("attack", { key: "can_crit" }));
    push(saveChip(entry.save), ref("save", { key: "save" }));
    for (const status of entry.statuses)
    {
        const effect = statusEffect(status.id);
        const name = statusLabel(status.id);
        const common = commonDetails(status, "status");
        const statusRef = ref("status", { index: status.index });
        push({
            img: effect?.img ?? effect?.icon ?? null,
            icon: "mdi mdi-alert-circle-outline",
            title: name,
            text: withDetails(name, ...common.details),
            tip: sentences(effect?.description || `Applies the ${escapeHtml(name)} status.`, common.tip)
        }, statusRef);
        pushSave(status.save, name, statusRef);
    }
    for (const special of entry.specials)
    {
        const common = commonDetails(special, "special");
        const specialRef = ref("special", { index: special.index });
        push({
            icon: "mdi mdi-star-four-points",
            title: special.name,
            text: withDetails(special.name, ...common.details),
            tip: sentences(special.detail ? escapeHtml(special.detail) : "A special state set by this effect.", common.tip)
        }, specialRef);
        pushSave(special.save, special.name, specialRef);
    }
    entry.removeSpecials.forEach(name => push({ icon: "mdi mdi-star-off", text: `Ends ${name}`, tip: `Ends the ${escapeHtml(name)} state.` }, ref("remove_special", { index: rawIndex(entry.raw.remove_special, name) })));
    for (const resist of entry.resist)
    {
        const common = commonDetails(resist, "resist");
        const label = `Resist ${damageTypeLabel(resist.type)}`;
        const resistRef = ref("resist", { index: resist.index });
        push({ icon: "mdi mdi-shield-half-full", title: label, text: withDetails(label, ...common.details), tip: sentences(`Takes half damage from ${escapeHtml(damageTypeLabel(resist.type))}.`, common.tip) }, resistRef);
        pushSave(resist.save, label, resistRef);
    }
    for (const vulnerable of entry.vulnerability)
    {
        const common = commonDetails(vulnerable, "vulnerable");
        const label = `Vulnerable to ${damageTypeLabel(vulnerable.type)}`;
        const vulnerableRef = ref("resist", { index: vulnerable.index });
        push({ icon: "mdi mdi-shield-off", title: label, text: withDetails(label, ...common.details), tip: sentences(`Takes double damage from ${escapeHtml(damageTypeLabel(vulnerable.type))}.`, common.tip) }, vulnerableRef);
        pushSave(vulnerable.save, label, vulnerableRef);
    }
    for (const immunity of entry.immunity)
    {
        const subject = immunity.status ? statusLabel(immunity.status) : damageTypeLabel(immunity.damage);
        const common = commonDetails(immunity, "resist");
        const label = `Immune to ${subject}`;
        const immunityRef = ref(immunity.field === "add_status" ? "status" : "resist", { index: immunity.index });
        push({ icon: "mdi mdi-shield", title: label, text: withDetails(label, ...common.details), tip: sentences(`Ignores ${escapeHtml(subject)}.`, common.tip) }, immunityRef);
        pushSave(immunity.save, label, immunityRef);
    }
    for (const other of entry.other)
    {
        const otherRef = ref("other", { index: other.index });
        push(otherChip(other), otherRef);
        pushSave(other.save, OTHER_LABELS[other.type] ?? capitalize(other.type), otherRef);
    }
    for (const bonus of entry.bonusDamage)
    {
        const types = [...bonus.weaponSizes, ...bonus.weaponTypes];
        const when = bonus.hitType && bonus.hitType !== "hit" ? ` on ${bonus.hitType}` : "";
        push({
            icon: "cci cci-variable",
            text: `+${valueText(bonus.val)} bonus damage${when}${types.length ? ` (${types.join(", ")})` : ""}`,
            tip: sentences(
                bonus.detail ? escapeHtml(bonus.detail) : `Adds ${escapeHtml(valueText(bonus.val))} bonus damage${when ? escapeHtml(when) : " on hit"}.`,
                types.length ? `Only for ${escapeHtml(types.join(", "))} weapons.` : null
            )
        }, ref("bonus_damage", { index: bonus.index }));
    }
    if (typeof entry.accuracy === "number" && entry.accuracy !== 0)
    {
        push(entry.accuracy > 0
            ? { icon: "cci cci-accuracy", text: `+${entry.accuracy} Accuracy`, tip: `Adds ${entry.accuracy} Accuracy.` }
            : { icon: "cci cci-difficulty", text: `+${-entry.accuracy} Difficulty`, tip: `Adds ${-entry.accuracy} Difficulty.` }, ref("attack", { key: "accuracy" }));
    }
    if (typeof entry.techAccuracy === "number" && entry.techAccuracy !== 0)
    {
        push(entry.techAccuracy > 0
            ? { icon: "cci cci-accuracy", text: `+${entry.techAccuracy} tech Accuracy`, tip: `Adds ${entry.techAccuracy} Accuracy to the tech attack.` }
            : { icon: "cci cci-difficulty", text: `+${-entry.techAccuracy} tech Difficulty`, tip: `Adds ${-entry.techAccuracy} Difficulty to the tech attack.` }, ref("attack", { key: "tech_accuracy" }));
    }
    if (typeof entry.attackBonus === "number" && entry.attackBonus !== 0)
        push({ icon: "mdi mdi-bullseye-arrow", text: `${entry.attackBonus > 0 ? "+" : ""}${entry.attackBonus} Attack`, tip: `Adds ${entry.attackBonus} to the attack roll.` }, ref("attack", { key: "attack_bonus" }));
    if (typeof entry.techAttackBonus === "number" && entry.techAttackBonus !== 0)
        push({ icon: "mdi mdi-bullseye-arrow", text: `${entry.techAttackBonus > 0 ? "+" : ""}${entry.techAttackBonus} tech Attack`, tip: `Adds ${entry.techAttackBonus} to the tech attack roll.` }, ref("attack", { key: "tech_attack_bonus" }));
    entry.bonuses.forEach((bonus, index) =>
    {
        if (!bonus?.id || !hasValue(bonus.val))
            return;
        const label = `${Number(bonus.val) >= 0 ? "+" : ""}${valueText(bonus.val)} ${capitalize(bonus.id).toLowerCase()}${typesText(bonus)}`;
        push({ icon: "mdi mdi-plus-box", text: label, tip: `${escapeHtml(label)} while this effect is active.` }, ref("bonus", { index }));
    });
    const duration = durationText(entry.duration);
    if (duration)
        push({ icon: "mdi mdi-timer-sand", text: duration, tip: `The effect lasts ${escapeHtml(duration)}.` }, ref("duration", { key: "duration" }));
    if (entry.target)
        push({ icon: "mdi mdi-target-account", text: `Target: ${entry.target}`, tip: `The effect applies to: ${escapeHtml(entry.target)}.` }, ref("target", { key: "target" }));
    return chips;
}

function placementOf(entry, item)
{
    const [first, second, third, fourth] = entry.path.split(".");
    if (first === "deployables")
        return null;
    if (HOOK_KEYS.includes(first))
        return { type: "box", key: first };
    if (first === "profiles" && HOOK_KEYS.includes(third))
        return { type: "box", key: third };
    if (first === "actions")
        return item.type === "npc_feature" ? { type: "box", key: "effect" } : { type: "action", path: `system.actions.${second}` };
    if (first === "ranks")
        return third === "actions" ? { type: "action", path: `system.ranks.${second}.actions.${fourth}` } : { type: "rank", index: Number(second) };
    if (first === "traits")
        return { type: "trait", index: Number(second) };
    if (first === "core_system")
        return { type: "core", passive: entry.passive };
    return { type: "box", key: "effect" };
}

function at(element, after = false)
{
    return element ? { element, after } : null;
}

function firstOf(cards, find)
{
    for (const card of cards)
    {
        const found = find(card);
        if (found)
            return found;
    }
    return null;
}

function labelSet(key)
{
    return new Set((BOX_LABELS[key] ?? []).map(label => (label.startsWith("LA.") ? game.i18n.localize(label) : label).trim().toUpperCase()));
}

function ownBoxes(ctx, boxSelector)
{
    return ctx.cards.flatMap(card => [...card.querySelectorAll(boxSelector)]).filter(box => box.closest("[data-uuid]")?.dataset.uuid === ctx.item.uuid);
}

function findBox(ctx, key, boxSelector, labelSelector)
{
    const labels = labelSet(key);
    return ownBoxes(ctx, boxSelector).find(box => labels.has(box.querySelector(labelSelector)?.textContent.trim().toUpperCase())) ?? null;
}

function boxTitle(key, alt)
{
    const labels = BOX_LABELS[key] ?? [key.replaceAll("_", " ").toUpperCase()];
    const i18nKey = labels.find(label => label.startsWith("LA."));
    if (alt && i18nKey && game.i18n.has(i18nKey))
        return game.i18n.localize(i18nKey);
    return labels[0];
}

function createBox(key, alt)
{
    const box = document.createElement("div");
    box.className = alt ? "la-effectbox -widthfull -fontsizemediumer la-bckg-card -bordersround-ltb" : "effect-box";
    const title = document.createElement("span");
    title.className = alt ? "la-effectbox__span clipped-bot la-bckg-primary la-text-header -fontface-stylized -fontsizesmall" : "effect-title clipped-bot";
    title.textContent = boxTitle(key, alt);
    box.append(title);
    return box;
}

function addBox(ctx, surface, key)
{
    const box = createBox(key, surface.alt);
    const last = ownBoxes(ctx, surface.boxSelector).at(-1);
    if (last)
    {
        last.after(box);
        return at(box);
    }
    const target = surface.fallback(ctx);
    if (!target)
        return null;
    insertRow(target, box);
    return at(box);
}

function namedGroup(root, name)
{
    if (!name)
        return null;
    const group = [...root.querySelectorAll(".la-collapsegroup")].find(element => element.querySelector(".la-summary .la-terminaltext")?.textContent.trim() === name);
    return group ? (group.querySelector(".la-effectbox") ?? group) : null;
}

const NATIVE_ACTOR = {
    alt: false,
    boxSelector: ".effect-box",
    box: (ctx, placement) => at(findBox(ctx, placement.key, ".effect-box", ".effect-title")),
    action: (ctx, placement) => at(firstOf(ctx.cards, card => card.querySelector(`[data-path="${placement.path}"]`)?.closest(".action-wrapper"))),
    rank: (ctx, placement) => at(firstOf(ctx.cards, card => card.querySelector(`[data-rank="${placement.index}"]`)?.closest("li"))),
    trait: (ctx, placement) =>
    {
        const name = ctx.item.system?.traits?.[placement.index]?.name;
        const trait = [...ctx.root.querySelectorAll(".frame-trait")].find(element => element.querySelector(".frame-trait-header")?.textContent.trim() === name);
        return at(trait?.querySelector(".lancer-body") ?? trait);
    },
    core: ctx => at(ctx.item.type === "frame" ? ctx.root.querySelector(".frame-coresys") : null),
    fallback: ctx => firstOf(ctx.cards, card =>
    {
        let row = [...card.querySelectorAll(".compact-tag-row")].find(element => element.closest("[data-uuid]")?.dataset.uuid === ctx.item.uuid && !element.classList.contains(ROW_CLASS));
        if (!row)
            return at(card.querySelector(".lancer-body") ?? card);
        while (row.parentElement && row.parentElement !== card && row.parentElement.classList.contains("flexrow"))
            row = row.parentElement;
        return { element: row, before: true };
    })
};

const ALT_ACTOR = {
    alt: true,
    boxSelector: ".la-effectbox",
    box: (ctx, placement) => at(findBox(ctx, placement.key, ".la-effectbox", ".la-effectbox__span")),
    action: (ctx, placement) => at(firstOf(ctx.cards, card =>
    {
        const action = card.querySelector(`div[data-path="${placement.path}"]`);
        return action ? (action.querySelector(".la-effectbox") ?? action) : null;
    })),
    rank: (ctx, placement) => at(firstOf(ctx.cards, card =>
    {
        const group = card.querySelector(`[data-rank="${placement.index}"]`)?.closest(".la-collapsegroup");
        return group ? (group.querySelector(".la-effectbox:not([data-path])") ?? group) : null;
    })),
    trait: (ctx, placement) => at(namedGroup(ctx.root, ctx.item.system?.traits?.[placement.index]?.name)),
    core: ctx => at(ctx.item.type === "frame" ? namedGroup(ctx.root, ctx.item.system?.core_system?.name) : null),
    fallback: ctx => at(firstOf(ctx.cards, card => card.querySelector(".la-collapsecontent") ?? card))
};

const ITEM_SHEET = {
    alt: false,
    box: (ctx, placement) => at(ctx.root.querySelector(`[data-path="system.${placement.key}"], [data-path^="system.profiles."][data-path$=".${placement.key}"]`)?.closest(".card")),
    action: (ctx, placement) => at(ctx.root.querySelector(`[data-path="${placement.path}"]`)?.closest(".action-wrapper")),
    rank: (ctx, placement) => at(ctx.root.querySelector(`[data-path="system.ranks.${placement.index}.description"]`)?.closest(".talent-level")?.querySelector(":scope > .desc-text"), true),
    trait: (ctx, placement) => descAnchor(ctx.root.querySelector(`[name="system.traits.${placement.index}.name"]`)?.closest(".card")),
    core: (ctx, placement) => descAnchor(ctx.root.querySelector(`[name="system.core_system.${placement.passive ? "passive" : "active"}_name"]`)?.closest(".card")),
    fallback: ctx => at(ctx.root.querySelector(`[data-path="system.effect"]`)?.closest(".card"))
};

function descAnchor(card)
{
    const desc = card?.querySelector(":scope > .desc-text");
    return desc ? at(desc, true) : at(card);
}

function locate(surface, ctx, placement)
{
    let target = surface[placement.type]?.(ctx, placement);
    if (!target && placement.type === "box" && surface.boxSelector && NATIVE_HOOKS[ctx.item.type]?.includes(placement.key))
        target = addBox(ctx, surface, placement.key);
    if (!target && placement.type === "box" && placement.key !== "effect")
        target = surface.box(ctx, { key: "effect" });
    return target ?? surface.fallback(ctx);
}

function control(className, handler)
{
    const element = document.createElement("a");
    element.className = className;
    element.addEventListener("click", event =>
    {
        event.preventDefault();
        event.stopPropagation();
        handler();
    });
    return element;
}

function buildRow(chips, alt, tooltipClass = null, editing = null)
{
    const row = document.createElement("div");
    row.className = alt ? `la-flexrow -wrapwrap -widthfull ${ROW_CLASS}` : `compact-tag-row ${ROW_CLASS}`;
    if (editing)
        row.classList.add("npci-v3-editable");
    for (const chip of chips)
    {
        const tag = document.createElement("div");
        tag.className = alt ? "la-flexrow la-bckg-primary la-text-header -bordersround -small -bordersoff -padding0-l -padding1-r -aligncenter -gap0" : "compact-tag flexrow";
        if (chip.tip && alt)
        {
            tag.dataset.tooltip = `<div class="la-bckg-primary -fontface-stylized -fontsize4 -upper -padding0">${escapeHtml(chip.title ?? chip.text)}</div><div class="la-tooltip__content -fontface-neutral">${chip.tip}</div>`;
            tag.dataset.tooltipClass = tooltipClass ?? "clipped-bot la-tooltip";
            tag.dataset.tooltipDirection = "DOWN";
        }
        else if (chip.tip)
        {
            tag.dataset.tooltip = chip.tip;
        }
        let icon;
        if (chip.img)
        {
            icon = document.createElement("img");
            icon.src = chip.img;
            icon.className = "npci-v3-icon";
        }
        else
        {
            icon = document.createElement("i");
            icon.className = alt ? `${chip.icon} -fontsize2` : `${chip.icon} i--2 i--light`;
        }
        const label = document.createElement("span");
        label.textContent = chip.text;
        if (alt)
            label.className = "-fontsizesmall";
        else
            label.style.margin = "3px";
        tag.append(icon, " ", label);
        if (editing && chip.ref)
            tag.append(control("fas fa-edit npci-v3-ctl", () => editing.edit(chip.ref)), control("fas fa-trash npci-v3-ctl", () => editing.remove(chip.ref)));
        row.append(tag);
    }
    if (editing)
    {
        const add = control("compact-tag flexrow npci-v3-add", () => editing.add());
        add.innerHTML = '<i class="fas fa-plus i--light"></i>';
        row.append(add);
    }
    return row;
}

function insertRow(target, row)
{
    if (target.before)
        target.element.before(row);
    else if (target.after)
        target.element.after(row);
    else
        target.element.append(row);
}

function cardsFor(root, uuid)
{
    const matches = [...root.querySelectorAll(`[data-uuid="${uuid}"]`)].filter(element => !["A", "BUTTON"].includes(element.tagName));
    return matches.filter(element => !matches.some(other => other !== element && other.contains(element)));
}

function chipGroups(item)
{
    const groups = new Map();
    const entries = getV3Data(item);
    const withDamage = new Set(entries.filter(entry => entry.kind !== "damage" && entry.damage.length).map(entry => entry.path));
    for (const entry of entries)
    {
        if (entry.kind === "damage" && withDamage.has(entry.path.replace(/\.damage\.\d+$/, "")))
            continue;
        const placement = placementOf(entry, item);
        const chips = placement ? chipsFor(entry, item) : [];
        if (!chips.length)
            continue;
        const key = JSON.stringify(placement);
        if (!groups.has(key))
            groups.set(key, { placement, chips: [] });
        groups.get(key).chips.push(...chips);
    }
    return [...groups.values()];
}

const BOX_NAMES = { effect: "Effect", on_hit: "On hit", on_crit: "On crit", on_attack: "On attack", on_miss: "On miss" };

function placementLabel(item, placement)
{
    if (placement.type === "box")
        return BOX_NAMES[placement.key] ?? placement.key;
    if (placement.type === "action")
        return foundry.utils.getProperty(item, placement.path)?.name ?? "Action";
    if (placement.type === "rank")
        return `Rank ${placement.index + 1}: ${item.system?.ranks?.[placement.index]?.name ?? ""}`.trim();
    if (placement.type === "trait")
        return item.system?.traits?.[placement.index]?.name ?? "Trait";
    const core = item.system?.core_system;
    return (placement.passive ? core?.passive_name : core?.active_name) || core?.name || "Core system";
}

export function getV3ChipRows(item)
{
    return chipGroups(item).map(({ placement, chips }) => ({ placement, label: placementLabel(item, placement), html: buildRow(chips, false).outerHTML }));
}

function newPathFor(item, placement)
{
    const key = JSON.stringify(placement);
    const entries = getV3Data(item).filter(entry => entry.kind !== "damage" && entry.kind !== "range");
    const existing = entries.find(entry => JSON.stringify(placementOf(entry, item)) === key);
    if (existing)
        return existing.path;
    if (placement.type === "box" && placement.key === "effect")
    {
        const used = entries.map(entry => /^active_effects\.(\d+)/.exec(entry.path)?.[1]).filter(Boolean).map(Number);
        return `active_effects.${used.length ? Math.max(...used) + 1 : 0}`;
    }
    if (placement.type === "box")
        return placement.key;
    if (placement.type === "action")
        return placement.path.replace(/^system\./, "");
    if (placement.type === "rank")
        return `ranks.${placement.index}.active_effects.0`;
    if (placement.type === "trait")
        return `traits.${placement.index}.active_effects.0`;
    return `core_system.${placement.passive ? "passive" : "active"}_effects.0`;
}

function itemPlacements(root)
{
    const placements = [];
    if (root.querySelector('[data-path="system.effect"]'))
        placements.push({ type: "box", key: "effect" });
    for (const key of HOOK_KEYS)
    {
        if (root.querySelector(`[data-path="system.${key}"], [data-path^="system.profiles."][data-path$=".${key}"]`))
            placements.push({ type: "box", key });
    }
    for (const wrapper of root.querySelectorAll(".action-wrapper"))
    {
        const path = wrapper.querySelector('[data-path^="system.actions."], [data-path^="system.ranks."]')?.dataset.path ?? "";
        const match = /^system\.(actions\.\d+|ranks\.\d+\.actions\.\d+)/.exec(path);
        if (match)
            placements.push({ type: "action", path: `system.${match[1]}` });
    }
    for (const element of root.querySelectorAll('[data-path^="system.ranks."][data-path$=".description"]'))
    {
        const match = /^system\.ranks\.(\d+)\.description$/.exec(element.dataset.path);
        if (match)
            placements.push({ type: "rank", index: Number(match[1]) });
    }
    for (const element of root.querySelectorAll('[name^="system.traits."][name$=".name"]'))
    {
        const match = /^system\.traits\.(\d+)\.name$/.exec(element.getAttribute("name"));
        if (match)
            placements.push({ type: "trait", index: Number(match[1]) });
    }
    if (root.querySelector('[name="system.core_system.passive_name"]'))
        placements.push({ type: "core", passive: true });
    if (root.querySelector('[name="system.core_system.active_name"]'))
        placements.push({ type: "core", passive: false });
    return placements;
}

function editingFor(item, placement)
{
    const label = placementLabel(item, placement);
    return {
        edit: ref => new V3DataEditor(item, { ...ref, label }).render(true),
        remove: ref => deleteValue(item, ref),
        add: () => new V3DataEditor(item, { path: newPathFor(item, placement), kind: "status", isNew: true, label }).render(true)
    };
}

function decorate(root, items, surface, editable = false)
{
    root.querySelectorAll(`.${ROW_CLASS}`).forEach(row => row.remove());
    const tooltipClass = surface.alt ? root.querySelector("[data-tooltip-class*='la-tooltip']")?.dataset.tooltipClass ?? null : null;
    for (const item of items)
    {
        const groups = chipGroups(item);
        const ctx = { root, item, cards: surface === ITEM_SHEET ? [root] : cardsFor(root, item.uuid) };
        const rendered = new Set();
        for (const { placement, chips } of groups)
        {
            const target = locate(surface, ctx, placement);
            if (!target)
                continue;
            rendered.add(JSON.stringify(placement));
            insertRow(target, buildRow(chips, surface.alt, tooltipClass, editable ? editingFor(item, placement) : null));
        }
        if (!editable)
            continue;
        for (const placement of itemPlacements(root))
        {
            if (rendered.has(JSON.stringify(placement)))
                continue;
            const target = surface[placement.type]?.(ctx, placement);
            if (target)
                insertRow(target, buildRow([], surface.alt, tooltipClass, editingFor(item, placement)));
        }
    }
}

function actionPathOf(item, data)
{
    if (data.action_path)
        return data.action_path;
    if (!data.action)
        return null;
    const index = item.system?.actions?.indexOf(data.action) ?? -1;
    if (index >= 0)
        return `system.actions.${index}`;
    for (const [rank, entry] of (item.system?.ranks ?? []).entries())
    {
        const rankIndex = entry?.actions?.indexOf(data.action) ?? -1;
        if (rankIndex >= 0)
            return `system.ranks.${rank}.actions.${rankIndex}`;
    }
    return null;
}

function includesText(text, source)
{
    return typeof text === "string" && typeof source === "string" && !!source && text.includes(source);
}

function chatField(kind, item, data, placement)
{
    const actionPath = actionPathOf(item, data);
    const isAction = placement.type === "action" && placement.path === actionPath;
    const isActiveCore = placement.type === "core" && !placement.passive && item.type === "frame";
    if (kind === "attack")
    {
        if (placement.type === "box" && placement.key !== "effect" && placement.key !== "on_miss")
            return placement.key;
        return (placement.type === "box" || isAction || isActiveCore) && typeof data.effect !== "object" ? "effect" : null;
    }
    if (kind === "tech")
        return (placement.type === "box" || isAction || isActiveCore) && typeof data.effect !== "object" ? "effect" : null;
    if (kind === "activation")
        return isAction || (isActiveCore && String(actionPath ?? "").startsWith("system.core_system")) ? "detail" : null;
    if (kind === "system")
        return placement.type === "box" ? "effect" : null;
    if (kind === "talent")
        return placement.type === "rank" && placement.index === Number(data.lvl) ? "rank" : null;
    if (kind === "text")
    {
        if (placement.type === "box" && placement.key === "effect")
            return includesText(data.description, item.system?.effect) || includesText(data.description, item.system?.description) ? "description" : null;
        if (placement.type === "trait")
            return includesText(data.description, item.system?.traits?.[placement.index]?.description) ? "description" : null;
        if (placement.type === "core" && placement.passive)
            return includesText(data.description, item.system?.core_system?.passive_effect) ? "description" : null;
    }
    return null;
}

function appendChatChips(state, kind)
{
    const item = state?.item;
    const data = state?.data;
    if (!item || !data)
        return true;
    if (kind === "html")
    {
        if (data.html)
        {
            const holder = document.createElement("div");
            holder.innerHTML = data.html;
            decorate(holder, [item], NATIVE_ACTOR);
            data.html = holder.innerHTML;
        }
        return true;
    }
    for (const { placement, chips } of chipGroups(item))
    {
        const field = chatField(kind, item, data, placement);
        if (!field)
            continue;
        const html = buildRow(chips, false).outerHTML;
        if (field === "rank")
            data.rank = { ...data.rank, description: `${data.rank?.description ?? ""}${html}` };
        else
            data[field] = `${data[field] ?? ""}${html}`;
    }
    return true;
}

const CHAT_STEPS = [
    ["WeaponAttackFlow", "printAttackCard", "attack"],
    ["BasicAttackFlow", "printAttackCard", "attack"],
    ["TechAttackFlow", "printTechAttackCard", "tech"],
    ["ActivationFlow", "printActionUseCard", "activation"],
    ["CoreActiveFlow", "printActionUseCard", "activation"],
    ["SystemFlow", "printSystemCard", "system"],
    ["SimpleTextFlow", "printGenericCard", "text"],
    ["TalentFlow", "printTalentCard", "talent"],
    ["SimpleHTMLFlow", "printGenericHTML", "html"]
];

export function registerV3ChatSteps(flowSteps, flows)
{
    for (const [name, anchor, kind] of CHAT_STEPS)
    {
        const step = `lancer-npc-import:v3Chips:${kind}`;
        if (!flowSteps.has(step))
            flowSteps.set(step, state => appendChatChips(state, kind));
        const flow = flows.get(name);
        if (flow?.steps?.includes(anchor) && !flow.steps.includes(step))
            flow.insertStepBefore(anchor, step);
    }
}

function rootOf(html)
{
    const root = html?.[0] ?? html;
    return root?.querySelectorAll ? root : null;
}

export function registerV3Display()
{
    const mod = game.modules.get(MODULE_ID);
    if (mod)
    {
        mod.api = mod.api || {};
        mod.api.getV3ChipRows = getV3ChipRows;
    }
    Hooks.on("renderActorSheet", (app, html) =>
    {
        const root = rootOf(html);
        const actor = app.actor ?? app.document;
        if (!root || !actor?.items)
            return;
        const alt = !!(root.closest(".la-common") ?? (app.element?.[0] ?? app.element)?.classList?.contains("la-common"));
        decorate(root, [...actor.items], alt ? ALT_ACTOR : NATIVE_ACTOR);
    });
    Hooks.on("renderItemSheet", (app, html) =>
    {
        const root = rootOf(html);
        const item = app.item ?? app.document;
        if (root && item)
            decorate(root, [item], ITEM_SHEET, !!(app.isEditable ?? app.options?.editable));
    });
}

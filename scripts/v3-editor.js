import { MODULE_ID, escapeHtml } from "./utils.js";

const FormApplicationBase = foundry.appv1?.api?.FormApplication ?? globalThis.FormApplication;

const STATS = { hull: "HULL", agi: "AGILITY", sys: "SYSTEMS", eng: "ENGINEERING" };
const TARGETS = { enemy: "ENEMY", self: "SELF", ally: "ALLY", any: "ANY" };
const DURATIONS = {
    "": "NONE",
    start_turn_self: "START OF YOUR TURN",
    end_turn_self: "END OF YOUR TURN",
    next_turn_start_self: "START OF YOUR NEXT TURN",
    next_turn_end_self: "END OF YOUR NEXT TURN",
    start_turn_target: "START OF TARGET'S TURN",
    end_turn_target: "END OF TARGET'S TURN",
    next_turn_start_target: "START OF TARGET'S NEXT TURN",
    next_turn_end_target: "END OF TARGET'S NEXT TURN",
    round_end_0: "END OF THIS ROUND",
    round_start_1: "START OF NEXT ROUND",
    round_end_1: "END OF NEXT ROUND"
};
const ATTACKS = { "": "NONE", melee: "MELEE", ranged: "RANGED", tech: "TECH" };
const DAMAGE_TYPES = { Kinetic: "KINETIC", Energy: "ENERGY", Explosive: "EXPLOSIVE", Heat: "HEAT", Burn: "BURN", Variable: "VARIABLE" };
const RANGE_TYPES = { Range: "RANGE", Threat: "THREAT", Line: "LINE", Cone: "CONE", Blast: "BLAST", Burst: "BURST", Thrown: "THROWN" };
const RESIST_MODES = { resistance: "RESISTANCE", vulnerability: "VULNERABILITY", immunity: "IMMUNITY" };
const DAMAGE_SUBJECTS = { kinetic: "KINETIC", energy: "ENERGY", explosive: "EXPLOSIVE", heat: "HEAT", burn: "BURN", aoe: "AREA DAMAGE", all: "ALL DAMAGE" };
const OTHER_TYPES = { overshield: "OVERSHIELD", cover: "COVER", hp: "HP", repairs: "REPAIRS", corepower: "CORE POWER", heat: "HEAT", speed: "SPEED" };
const PERIODS = { unlimited: "UNLIMITED", turn: "TURN", round: "ROUND", scene: "SCENE", encounter: "ENCOUNTER", mission: "MISSION" };
const HIT_TYPES = { hit: "ON HIT", crit: "ON CRIT", miss: "ON MISS", attack: "ON ATTACK" };
const DEFENSES = { "": "DEFAULT", edef: "E-DEFENSE", evasion: "EVASION" };
const DAMAGE_TARGETS = { "": "TARGET", self: "SELF" };
const RESIST_KEYS = ["resist", "resistance", "vulnerable", "vulnerability", "immunity"];

function hasValue(value)
{
    return value !== undefined && value !== null && value !== "";
}

function setOrDelete(target, key, value)
{
    if (value === undefined || value === null || value === "" || value === false)
        delete target[key];
    else
        target[key] = value;
}

function capitalizeType(value, fallback)
{
    const text = String(value ?? fallback);
    return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function statKey(value)
{
    const raw = typeof value === "object" && value ? value.stat : value;
    const key = String(raw ?? "").trim().toLowerCase().slice(0, 3);
    if (key === "hul")
        return "hull";
    return ["agi", "sys", "eng"].includes(key) ? key : "";
}

function tierText(value)
{
    return Array.isArray(value) ? value.join("/") : (value ?? "");
}

function parseValue(text)
{
    const raw = String(text ?? "").trim();
    if (!raw)
        return null;
    const parts = raw.split("/").map(part => part.trim());
    const values = parts.map(part => (/^-?\d+(\.\d+)?$/.test(part) ? Number(part) : part));
    if (values.length === 3)
        return values;
    return parts.length === 1 ? values[0] : raw;
}

function aoeText(value)
{
    if (value === true)
        return "yes";
    return typeof value === "string" ? value : "";
}

function parseAoe(text)
{
    const raw = String(text ?? "").trim();
    if (!raw)
        return null;
    return ["yes", "true"].includes(raw.toLowerCase()) ? true : raw;
}

function listText(value)
{
    return (Array.isArray(value) ? value : (hasValue(value) ? [value] : [])).join(", ");
}

function parseList(text)
{
    const values = String(text ?? "").split(",").map(part => part.trim()).filter(Boolean);
    return values.length ? values : null;
}

function statusOptions()
{
    const options = {};
    for (const effect of CONFIG.statusEffects ?? [])
        options[effect.id] = game.i18n.localize(effect.name ?? effect.id).toUpperCase();
    return options;
}

const select = (label, options, read, write) => ({ label, input: "select", options, read, write });
const text = (label, read, write, placeholder = "") => ({ label, input: "text", read, write, placeholder });
const check = (label, key) => ({ label, input: "checkbox", read: source => !!source[key], write: (target, value) => setOrDelete(target, key, !!value) });
const tiered = (label, key, placeholder = "") => text(label, source => tierText(source[key]), (target, value) => setOrDelete(target, key, parseValue(value)), placeholder);
const plain = (label, key, placeholder = "") => text(label, source => source[key] ?? "", (target, value) => setOrDelete(target, key, String(value ?? "").trim()), placeholder);
const list = (label, key, placeholder = "") => text(label, source => listText(source[key]), (target, value) => setOrDelete(target, key, parseList(value)), placeholder);
const targetSelect = (fallback) => select("TARGET", () => TARGETS, source => source.target ?? fallback, (target, value) => setOrDelete(target, "target", value === fallback ? "" : value));

const FIELDS = {
    status_id: select("STATUS", statusOptions, source => source.id ?? "", (target, value) => setOrDelete(target, "id", value)),
    status_val: plain("VALUE", "val", "cover: soft or hard"),
    save: select("SAVE", () => ({ "": "NO SAVE", ...STATS }), source => statKey(source.save), (target, value) => setOrDelete(target, "save", value)),
    target_enemy: targetSelect("enemy"),
    target_any: targetSelect("any"),
    target_ally: targetSelect("ally"),
    duration: select("DURATION", () => DURATIONS, source => source.duration ?? "", (target, value) => setOrDelete(target, "duration", value)),
    aoe: text("AREA", source => aoeText(source.aoe), (target, value) => setOrDelete(target, "aoe", parseAoe(value)), "blank, yes, or e.g. burst 2"),
    attack: select("ATTACK", () => ATTACKS, source => source.attack ?? "", (target, value) => setOrDelete(target, "attack", value)),
    save_stat: select("SAVE", () => STATS, source => statKey(source.save) || "hull", (target, value, values) =>
    {
        const aoe = parseAoe(values.save_aoe);
        target.save = aoe ? { stat: value, aoe } : value;
    }),
    save_aoe: text("AREA", source => aoeText(typeof source.save === "object" ? source.save?.aoe : null), () => {}, "blank, yes, or e.g. burst 2"),
    damage_type: { ...select("TYPE", () => DAMAGE_TYPES, source => capitalizeType(source.type, "Kinetic"), (target, value) => setOrDelete(target, "type", value)), noSelf: true },
    damage_val: { ...tiered("VALUE", "val", "e.g. 2, 1d6 or 3/4/5"), noSelf: true },
    ap: check("AP", "ap"),
    irreducible: check("IRREDUCIBLE", "irreducible"),
    overkill: check("OVERKILL", "overkill"),
    override: check("OVERRIDE", "override"),
    save_half: check("HALF ON SAVE", "save_half"),
    reliable: tiered("RELIABLE", "reliable"),
    damage_bonus: tiered("BONUS", "bonus"),
    damage_target: select("TAKEN BY", () => DAMAGE_TARGETS, source => (source.target === "self" ? "self" : ""), (target, value) => setOrDelete(target, "target", value)),
    range_type: { ...select("TYPE", () => RANGE_TYPES, source => capitalizeType(source.type, "Range"), (target, value) => setOrDelete(target, "type", value)), noSelf: true },
    range_val: { ...text("VALUE", source => tierText(source.val ?? source.value), (target, value) =>
    {
        delete target.value;
        setOrDelete(target, "val", parseValue(value));
    }), noSelf: true },
    range_min: tiered("MIN", "min"),
    range_bonus: tiered("BONUS", "bonus"),
    freq_count: text("USES", source => parseInt(String(source.frequency ?? "").split("/")[0]) || 1, (target, value, values) =>
    {
        const period = values.freq_period;
        if (!period || period === "unlimited")
            delete target.frequency;
        else
            target.frequency = `${Math.max(1, parseInt(value) || 1)}/${period}`;
    }),
    freq_period: select("PER", () => PERIODS, source =>
    {
        const period = String(source.frequency ?? "").split("/")[1]?.trim().toLowerCase();
        if (period && PERIODS[period])
            return period;
        return source.frequency ? "unlimited" : "round";
    }, () => {}),
    attribute: plain("NAME", "attribute"),
    detail: plain("DETAIL", "detail"),
    resist_mode: select("KIND", () => RESIST_MODES, source =>
    {
        if (source.immunity)
            return "immunity";
        return source.vulnerable || source.vulnerability ? "vulnerability" : "resistance";
    }, (target, value, values) =>
    {
        RESIST_KEYS.forEach(key => delete target[key]);
        target[value] = values.resist_subject;
    }),
    resist_subject: select("AGAINST", values => (values?.resist_mode === "immunity" ? { ...DAMAGE_SUBJECTS, ...statusOptions() } : DAMAGE_SUBJECTS), source =>
        String(source.immunity ?? source.resist ?? source.resistance ?? source.vulnerable ?? source.vulnerability ?? "kinetic").toLowerCase(), () => {}),
    other_type: select("TYPE", () => OTHER_TYPES, source => String(source.type ?? source.id ?? "overshield").toLowerCase(), (target, value) =>
    {
        delete target.id;
        target.type = value;
    }),
    other_val: tiered("VALUE", "val", "e.g. 4, {grit} + 4, soft or hard"),
    bonus_val: tiered("VALUE", "val", "e.g. 1d6 or 2"),
    weapon_types: list("WEAPON TYPES", "weapon_types", "e.g. Melee, Rifle"),
    weapon_sizes: list("WEAPON SIZES", "weapon_sizes", "e.g. Main, Heavy"),
    damage_types: list("DAMAGE TYPES", "damage_types", "e.g. Kinetic, Energy"),
    range_types: list("RANGE TYPES", "range_types", "e.g. Range, Threat"),
    hit_type: select("WHEN", () => HIT_TYPES, source => source.hit_type ?? "hit", (target, value) => setOrDelete(target, "hit_type", value === "hit" ? null : value)),
    target_defense: select("DEFENSE", () => DEFENSES, source => source.target_defense ?? "", (target, value) => setOrDelete(target, "target_defense", value)),
    can_crit: check("CAN CRIT", "can_crit"),
    accuracy: tiered("ACCURACY", "accuracy", "negative = Difficulty"),
    attack_bonus: tiered("ATTACK BONUS", "attack_bonus"),
    tech_accuracy: tiered("TECH ACCURACY", "tech_accuracy"),
    tech_attack_bonus: tiered("TECH ATTACK BONUS", "tech_attack_bonus"),
    bonus_id: plain("ID", "id", "e.g. range, damage, threat"),
    bonus_value: tiered("VALUE", "val"),
    condition: plain("CONDITION", "condition"),
    entry_target: plain("TARGET", "target")
};

const wide = field => ({ field, wide: true });
const pills = (fields, isWide = true) => ({ pills: fields, wide: isWide });
const targeting = targetField => [targetField, "attack", wide("duration"), wide("aoe")];

export const KINDS = {
    status: { label: "STATUS", icon: "mdi mdi-alert-circle-outline", list: "add_status", groups: [["STATUS", ["status_id", "status_val"]], ["SAVE", ["save"]], ["TARGETING", targeting("target_enemy")]] },
    save: { label: "SAVE", icon: "cci cci-save", keys: ["save"], groups: [["SAVE", ["save_stat", "save_aoe"]]] },
    damage: { label: "DAMAGE", icon: "cci cci-explosive", list: "damage", groups: [["DAMAGE", ["damage_type", "damage_val"]], ["MODIFIERS", [pills(["ap", "irreducible", "overkill", "override"]), "reliable", "damage_bonus"]], ["SAVE", ["save", pills(["save_half"], false)]], ["TARGETING", ["damage_target", "attack", wide("aoe")]]] },
    range: { label: "RANGE", icon: "cci cci-range", list: "range", groups: [["RANGE", ["range_type", "range_val"]], ["MODIFIERS", ["range_min", "range_bonus", pills(["override"])]]] },
    frequency: { label: "FREQUENCY", icon: "mdi mdi-update", keys: ["frequency"], groups: [["FREQUENCY", ["freq_count", "freq_period"]]] },
    duration: { label: "DURATION", icon: "mdi mdi-timer-sand", keys: ["duration"], groups: [["DURATION", [wide("duration")]]] },
    special: { label: "SPECIAL STATE", icon: "mdi mdi-star-four-points", list: "add_special", stringKey: "attribute", groups: [["SPECIAL STATE", [wide("attribute"), wide("detail")]], ["SAVE", ["save"]], ["TARGETING", targeting("target_enemy")]] },
    remove_special: { label: "END SPECIAL STATE", icon: "mdi mdi-star-off", list: "remove_special", asString: "attribute", groups: [["END SPECIAL STATE", [wide("attribute")]]] },
    resist: { label: "RESISTANCE", icon: "mdi mdi-shield-half-full", list: "add_resist", groups: [["RESISTANCE", ["resist_mode", "resist_subject"]], ["SAVE", ["save"]], ["TARGETING", targeting("target_any")]] },
    other: { label: "OTHER EFFECT", icon: "mdi mdi-plus-box", list: "add_other", groups: [["EFFECT", ["other_type", "other_val"]], ["TARGETING", targeting("target_ally")], ["SAVE", ["save"]]] },
    bonus_damage: { label: "BONUS DAMAGE", icon: "cci cci-variable", list: "bonus_damage", stringKey: "val", single: true, groups: [["BONUS DAMAGE", ["bonus_val", "hit_type", wide("detail")]], ["WEAPONS", ["weapon_types", "weapon_sizes"]]] },
    attack: { label: "ATTACK", icon: "mdi mdi-bullseye-arrow", keys: ["attack", "target_defense", "can_crit", "accuracy", "attack_bonus", "tech_accuracy", "tech_attack_bonus"], groups: [["ATTACK", ["attack", "target_defense", pills(["can_crit"])]], ["ACCURACY", ["accuracy", "attack_bonus", "tech_accuracy", "tech_attack_bonus"]]] },
    bonus: { label: "BONUS", icon: "mdi mdi-plus-box-multiple", list: "bonuses", groups: [["BONUS", ["bonus_id", "bonus_value", wide("condition")]], ["APPLIES TO", ["damage_types", "range_types", "weapon_types", "weapon_sizes"]]] },
    target: { label: "TARGET", icon: "mdi mdi-target-account", keys: ["target"], groups: [["TARGET", [wide("entry_target")]]] }
};

for (const kind of Object.values(KINDS))
    kind.fields = kind.groups.flatMap(([, cells]) => cells.flatMap(cell => (typeof cell === "string" ? [cell] : (cell.pills ?? [cell.field]))));

function flagEntries(item)
{
    return foundry.utils.deepClone(item.flags?.[MODULE_ID]?.v3?.entries ?? []);
}

function rawList(data, key)
{
    const value = data?.[key];
    if (value === undefined || value === null)
        return [];
    return Array.isArray(value) ? [...value] : [value];
}

function storeList(data, kind, values)
{
    if (!values.length)
        delete data[kind.list];
    else if (kind.single && values.length === 1)
        data[kind.list] = values[0];
    else
        data[kind.list] = values;
}

function sourceOf(kind, raw)
{
    if (kind.asString)
        return { [kind.asString]: typeof raw === "string" ? raw : (raw?.[kind.asString] ?? "") };
    if (raw && typeof raw === "object")
        return raw;
    return hasValue(raw) ? { [kind.stringKey ?? "id"]: raw } : {};
}

function hasIndex(ref)
{
    return Number.isInteger(ref.index) && ref.index >= 0;
}

function activeFields(kind, ref)
{
    return kind.fields.filter(field => !(ref.self && FIELDS[field].noSelf));
}

export function readValues(item, ref, kindName)
{
    const kind = KINDS[kindName];
    const data = flagEntries(item).find(entry => entry.path === ref.path)?.data ?? {};
    let source = data;
    if (kind.list && !ref.self)
        source = sourceOf(kind, hasIndex(ref) && !ref.isNew ? rawList(data, kind.list)[ref.index] : null);
    return Object.fromEntries(activeFields(kind, ref).map(field => [field, FIELDS[field].read(source)]));
}

async function saveEntries(item, entries)
{
    const kept = entries.filter(entry => entry.data && Object.keys(entry.data).some(key => key !== "name"));
    const pack = item.flags?.[MODULE_ID]?.v3?.pack ?? "";
    await item.update({ [`flags.${MODULE_ID}.==v3`]: { pack, entries: kept } });
}

export async function writeValues(item, ref, kindName, values)
{
    const kind = KINDS[kindName];
    const entries = flagEntries(item);
    let entry = entries.find(candidate => candidate.path === ref.path);
    if (!entry)
    {
        entry = { path: ref.path, data: {} };
        entries.push(entry);
    }
    entry.data ??= {};
    const fields = activeFields(kind, ref);
    if (!kind.list || ref.self)
    {
        fields.forEach(field => FIELDS[field].write(entry.data, values[field], values));
    }
    else
    {
        const items = rawList(entry.data, kind.list);
        const editing = hasIndex(ref) && !ref.isNew && ref.index < items.length;
        const target = foundry.utils.deepClone(sourceOf(kind, editing ? items[ref.index] : null));
        fields.forEach(field => FIELDS[field].write(target, values[field], values));
        const result = kind.asString ? (target[kind.asString] ?? "") : target;
        if (kind.asString && !result)
            return;
        if (editing)
            items[ref.index] = result;
        else
            items.push(result);
        storeList(entry.data, kind, items);
    }
    await saveEntries(item, entries);
}

export async function deleteValue(item, ref)
{
    const kind = KINDS[ref.kind];
    const entries = flagEntries(item);
    const entry = entries.find(candidate => candidate.path === ref.path);
    if (!entry?.data || (kind.list && !ref.self && !hasIndex(ref)))
        return;
    if (ref.part === "save")
    {
        if (!kind.list || ref.self)
        {
            delete entry.data.save;
            delete entry.data.save_half;
        }
        else
        {
            const items = rawList(entry.data, kind.list);
            if (items[ref.index] && typeof items[ref.index] === "object")
            {
                items[ref.index] = { ...items[ref.index] };
                delete items[ref.index].save;
                delete items[ref.index].save_half;
                storeList(entry.data, kind, items);
            }
        }
    }
    else if (ref.self)
    {
        entries.splice(entries.indexOf(entry), 1);
    }
    else if (!kind.list)
    {
        (ref.key ? [ref.key] : kind.keys).forEach(key => delete entry.data[key]);
    }
    else
    {
        const items = rawList(entry.data, kind.list);
        items.splice(ref.index, 1);
        storeList(entry.data, kind, items);
    }
    await saveEntries(item, entries);
}

function optionsHtml(options, value)
{
    const entries = Object.entries(options);
    if (hasValue(value) && !(value in options))
        entries.push([value, String(value).toUpperCase()]);
    return entries.map(([key, label]) => `<option value="${escapeHtml(key)}"${key === String(value ?? "") ? " selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function controlHtml(name, value, values)
{
    const field = FIELDS[name];
    if (field.input === "select")
        return `<select name="${name}" data-type="String">${optionsHtml(field.options(values), value)}</select>`;
    return `<input name="${name}" value="${escapeHtml(value)}" type="text" data-dtype="String" placeholder="${escapeHtml(field.placeholder ?? "")}"/>`;
}

function pillHtml(name, value)
{
    return `<label class="npci-toggle"><input name="${name}" type="checkbox"${value ? " checked" : ""}/><span>${FIELDS[name].label}</span></label>`;
}

function cellHtml(cell, values, ref)
{
    if (typeof cell !== "string" && cell.pills)
    {
        const shown = cell.pills.filter(name => !(ref.self && FIELDS[name].noSelf));
        if (!shown.length)
            return "";
        return `<div class="npci-field${cell.wide ? " wide" : ""}"><div class="npci-control">${shown.map(name => pillHtml(name, values[name])).join("")}</div></div>`;
    }
    const name = typeof cell === "string" ? cell : cell.field;
    if (ref.self && FIELDS[name].noSelf)
        return "";
    return `<label class="npci-field${cell.wide ? " wide" : ""}"><span class="npci-label">${FIELDS[name].label}</span><div class="npci-control">${controlHtml(name, values[name], values)}</div></label>`;
}

function groupsHtml(kind, values, ref)
{
    return kind.groups.map(([name, cells]) =>
    {
        const inner = cells.map(cell => cellHtml(cell, values, ref)).join("");
        return inner ? `<div class="npci-group"><div class="lancer-header lancer-primary npci-section">${name}</div><div class="npci-grid">${inner}</div></div>` : "";
    }).join("");
}

export class V3DataEditor extends FormApplicationBase
{
    constructor(item, ref, options = {})
    {
        super({}, options);
        this.item = item;
        this.ref = ref;
        this.kindName = ref.kind ?? "status";
    }

    static get defaultOptions()
    {
        return foundry.utils.mergeObject(super.defaultOptions, {
            classes: ["lancer", "targeted-form-editor", "npci-v3-editor"],
            width: 460,
            height: "auto",
            submitOnChange: false,
            submitOnClose: false,
            closeOnSubmit: true
        });
    }

    get title()
    {
        return `${this.ref.isNew ? "Add" : "Edit"} v3 data: ${this.item.name}`;
    }

    async _renderInner()
    {
        const kind = KINDS[this.kindName];
        const values = readValues(this.item, this.ref, this.kindName);
        const source = [this.item.name, this.ref.label].filter(Boolean).map(escapeHtml).join(" · ");
        const header = `<div class="lancer-header lancer-primary npci-head"><i class="${kind.icon} i--3 i--light"></i><span class="major">${kind.label}</span><span class="npci-source">${source}</span></div>`;
        const tiles = this.ref.isNew
            ? `<div class="npci-kinds">${Object.entries(KINDS).map(([key, value]) => `<button type="button" class="npci-kind${key === this.kindName ? " active" : ""}" data-kind="${key}"><i class="${value.icon}"></i><span>${value.label}</span></button>`).join("")}</div>`
            : "";
        const buttons = `<div class="npci-buttons"><button type="submit" data-button="confirm"><i class="fas fa-save"></i> Save</button><button type="button" data-button="cancel"><i class="fas fa-times"></i> Cancel</button></div>`;
        const html = $(`<form class="lancer" autocomplete="off" onsubmit="event.preventDefault()">${header}${tiles}<div class="npci-body">${groupsHtml(kind, values, this.ref)}</div>${buttons}</form>`);
        this.form = html[0];
        return html;
    }

    activateListeners(html)
    {
        super.activateListeners(html);
        html.find("button.npci-kind").on("click", event =>
        {
            event.preventDefault();
            this.kindName = event.currentTarget.dataset.kind;
            this.render();
        });
        html.find('button[data-button="cancel"]').on("click", event =>
        {
            event.preventDefault();
            this.close();
        });
        html.find('select[name="resist_mode"]').on("change", event =>
        {
            const subject = html.find('select[name="resist_subject"]');
            const options = FIELDS.resist_subject.options({ resist_mode: event.currentTarget.value });
            const current = String(subject.val() ?? "");
            subject.html(optionsHtml(options, current in options ? current : "kinetic"));
        });
    }

    async _updateObject(_event, formData)
    {
        await writeValues(this.item, this.ref, this.kindName, formData);
    }
}

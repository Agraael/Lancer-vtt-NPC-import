import { entityKeys, stampField } from "./compcon-push.js";
import { findExistingMechByLid, isMechLinkedTo, actorBond } from "../pilot-import-core.js";
import { isOrgReserve, orgFromItem, matchOrgs } from "../pilot-reserves-patch.js";
import { trimText, sameJson, clampRank, frameLicenseId, reserveKey } from "../utils.js";

const SIZE_RANK = { Auxiliary: 0, Main: 1, Heavy: 2, Superheavy: 3 };
const FOUNDRY_SIZE = { aux: "Auxiliary", auxiliary: "Auxiliary", main: "Main", heavy: "Heavy", superheavy: "Superheavy" };
const BONUS_MOUNTS = ["improved_armament", "integratedWeapon", "superheavy_mounting"];

function _uuid()
{
    return crypto.randomUUID();
}

function _number(value)
{
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function _plain(html)
{
    const text = new DOMParser().parseFromString(String(html ?? ""), "text/html").body?.textContent;
    return trimText(text);
}

function _isEntityArray(value)
{
    return Array.isArray(value) && value.some(entry => typeof entry?.id === "string" && entry.id);
}

function _stampTree(json, value, path, now)
{
    if (_isEntityArray(value))
    {
        const keys = entityKeys(value);
        value.forEach((entry, index) =>
        {
            if (keys[index])
                _stampTree(json, entry, `${path}.${keys[index]}`, now);
        });
        return;
    }
    if (value && typeof value === "object" && !Array.isArray(value))
    {
        for (const [key, child] of Object.entries(value))
            _stampTree(json, child, `${path}.${key}`, now);
        return;
    }
    stampField(json, path, now);
}

function _context(json, now)
{
    const ctx = { json, now, changed: 0, notes: [] };
    ctx.set = (target, key, value, path) =>
    {
        if (!target || sameJson(target[key], value))
            return false;
        target[key] = value;
        stampField(json, path, now);
        ctx.changed++;
        return true;
    };
    ctx.setText = (target, key, value, path) =>
    {
        const norm = text => (Array.isArray(text) ? text.map(trimText) : trimText(text));
        if (!target || sameJson(norm(target[key]), norm(value)))
            return false;
        return ctx.set(target, key, value, path);
    };
    ctx.setTree = (target, key, value, path) =>
    {
        if (!target || sameJson(target[key], value))
            return false;
        target[key] = value;
        _stampTree(json, value, path, now);
        ctx.changed++;
        return true;
    };
    ctx.stamp = path =>
    {
        stampField(json, path, now);
        ctx.changed++;
    };
    ctx.stampTree = (value, path) =>
    {
        _stampTree(json, value, path, now);
        ctx.changed++;
    };
    return ctx;
}

function _syncEntities(ctx, list, basePath, worldEntries, { update, create, keyOf = item => item?.id, keep })
{
    const oldKeys = entityKeys(list);
    const matched = new Map();
    const added = [];
    for (const entry of worldEntries)
    {
        const index = list.findIndex((item, i) => !matched.has(i) && oldKeys[i] && keyOf(item) === entry.id);
        if (index < 0)
            added.push(entry);
        else
            matched.set(index, entry);
    }
    const survivors = list
        .map((item, index) => ({ item, index }))
        .filter(({ item, index }) => matched.has(index) || !oldKeys[index] || keep?.(item));
    list.splice(0, list.length, ...survivors.map(survivor => survivor.item));
    const newKeys = entityKeys(list);
    survivors.forEach(({ index }, position) =>
    {
        const key = newKeys[position];
        if (!key)
            return;
        if (key !== oldKeys[index])
            ctx.stampTree(list[position], `${basePath}.${key}`);
        const entry = matched.get(index);
        if (entry)
            update?.(list[position], `${basePath}.${key}`, entry);
    });
    for (const entry of added)
    {
        const item = create(entry);
        if (!item)
            continue;
        list.push(item);
        const key = entityKeys(list)[list.length - 1];
        if (key)
            ctx.stampTree(item, `${basePath}.${key}`);
    }
    const liveKeys = new Set(entityKeys(list).filter(Boolean));
    for (const key of oldKeys)
    {
        if (key && !liveKeys.has(key))
            ctx.stamp(`${basePath}.${key}`);
    }
}

function _talentData(item)
{
    const ranks = (item.system?.ranks || []).map(rank => ({ name: String(rank?.name || item.name), description: String(rank?.description || "") }));
    return {
        id: item.system.lid,
        name: item.name,
        terse: String(item.system?.terse || ""),
        description: "",
        ranks: ranks.length ? ranks : [{ name: item.name, description: "" }]
    };
}

function _syncTalents(ctx, json, actor)
{
    if (!Array.isArray(json.talents))
        return;
    const world = actor.items
        .filter(item => item.type === "talent" && item.system?.lid)
        .map(item => ({ id: item.system.lid, rank: clampRank(item.system.curr_rank), item }));
    _syncEntities(ctx, json.talents, "talents", world, {
        update: (entry, path, source) => _setRank(ctx, entry, path, source.rank),
        create: source => ({ id: source.id, rank: source.rank, data: _talentData(source.item) })
    });
}

function _setRank(ctx, entry, path, rank)
{
    if (clampRank(entry.rank) !== rank)
        ctx.set(entry, "rank", rank, `${path}.rank`);
}

function _skillKey(entry)
{
    if (typeof entry?.id !== "string" || !entry.id)
        return undefined;
    return entry.custom ? `custom:${trimText(entry.id)}` : entry.id;
}

function _syncSkills(ctx, json, actor)
{
    if (!Array.isArray(json.skills))
        return;
    const customNames = new Set(json.skills.filter(skill => skill?.custom).map(skill => trimText(skill.id)));
    const coreIds = new Set(json.skills.filter(skill => skill && !skill.custom && typeof skill.id === "string").map(skill => skill.id));
    const world = [];
    for (const item of actor.items.filter(entry => entry.type === "skill"))
    {
        const name = trimText(item.name);
        const lid = item.system?.lid;
        const custom = !(lid && coreIds.has(lid)) && (customNames.has(name) || !lid);
        if (custom && !customNames.has(name) && (!name || /[.,]|#\d+$/.test(name)))
        {
            ctx.notes.push(`${item.name}: skill name not supported by Comp/Con, not exported`);
            continue;
        }
        world.push({ id: custom ? `custom:${name}` : item.system.lid, custom, name, rank: clampRank(item.system?.curr_rank), item });
    }
    _syncEntities(ctx, json.skills, "skills", world, {
        keyOf: _skillKey,
        update: (entry, path, source) => _setRank(ctx, entry, path, source.rank),
        create: source =>
        {
            const system = source.item.system || {};
            if (source.custom)
                return { id: source.name, rank: source.rank, custom: true, custom_desc: _plain(system.description), custom_detail: String(system.detail || "") };
            return { id: source.id, rank: source.rank, data: { id: source.id, name: source.item.name, description: _plain(system.description), detail: String(system.detail || "") } };
        }
    });
}

function _syncLicenses(ctx, json, actor)
{
    if (!Array.isArray(json.licenses))
        return;
    const world = actor.items
        .filter(item => item.type === "license" && frameLicenseId(item.system?.lid || item.system?.key))
        .map(item => ({ id: frameLicenseId(item.system?.lid || item.system?.key), rank: clampRank(item.system?.curr_rank), item }));
    _syncEntities(ctx, json.licenses, "licenses", world, {
        keyOf: entry => (typeof entry?.id === "string" && entry.id ? frameLicenseId(entry.id) : undefined),
        update: (entry, path, source) => _setRank(ctx, entry, path, source.rank),
        create: source => ({
            id: source.id,
            rank: source.rank,
            stub: {
                id: source.id,
                name: source.item.name,
                source: String(source.item.system?.manufacturer || ""),
                frameName: String(source.item.name || "").toLowerCase()
            }
        })
    });
}

function _syncCoreBonuses(ctx, json, actor)
{
    if (!Array.isArray(json.core_bonuses))
        return;
    const world = actor.items
        .filter(item => item.type === "core_bonus" && item.system?.lid)
        .map(item => ({ id: item.system.lid, item }));
    _syncEntities(ctx, json.core_bonuses, "core_bonuses", world, {
        create: source =>
        {
            const system = source.item.system || {};
            const data = {
                id: source.id,
                name: source.item.name,
                source: String(system.manufacturer || ""),
                effect: String(system.effect || ""),
                description: String(system.description || "")
            };
            if (system.mounted_effect)
                data.mounted_effect = String(system.mounted_effect);
            return data;
        }
    });
}

function _reserveKey(entry)
{
    if (typeof entry?.id !== "string" || !entry.id)
        return undefined;
    return reserveKey(entry.id, entry.name || entry.label);
}

function _syncReserves(ctx, json, actor)
{
    if (!Array.isArray(json.reserves))
        return;
    const world = actor.items
        .filter(item => item.type === "reserve" && item.system?.lid && !isOrgReserve(item))
        .map(item => ({ id: _reserveKey({ id: item.system.lid, name: item.name }), item }));
    _syncEntities(ctx, json.reserves, "reserves", world, {
        keyOf: _reserveKey,
        update: (entry, path, source) =>
        {
            const used = !!source.item.system?.used;
            if (!!entry.used !== used)
                ctx.set(entry, "used", used, `${path}.used`);
        },
        create: source =>
        {
            const system = source.item.system || {};
            return {
                id: system.lid,
                type: String(system.type || "Resources"),
                name: source.item.name,
                label: String(system.label || source.item.name),
                description: String(system.description || ""),
                resource_name: "",
                resource_note: "",
                resource_cost: "",
                used: !!system.used,
                consumable: !!system.consumable
            };
        }
    });
}

function _syncOrgs(ctx, json, actor)
{
    const world = actor.items.filter(isOrgReserve);
    if (!Array.isArray(json.orgs))
    {
        if (world.length)
            ctx.notes.push("Comp/Con file has no organization list, organizations not exported");
        return;
    }
    if (json.orgs.some(org => !org || typeof org !== "object" || Array.isArray(org) || typeof org.id === "string"))
    {
        ctx.notes.push("Comp/Con organizations have an unexpected shape, not exported");
        return;
    }
    const { pairs, worldOnly } = matchOrgs(world, json.orgs);
    const paired = new Map(pairs.map(pair => [pair.org, pair.item]));
    const next = json.orgs
        .filter(org => paired.has(org) || !trimText(org.name))
        .map(org => (paired.has(org) ? orgFromItem(paired.get(org), org) : org));
    for (const item of worldOnly)
        next.push(orgFromItem(item));
    ctx.set(json, "orgs", next, "orgs");
}

const GEAR_TYPES = [
    ["armor", "pilot_armor", "PilotArmor", "Armor", 1],
    ["weapons", "pilot_weapon", "PilotWeapon", "Weapon", 2],
    ["gear", "pilot_gear", "PilotGear", "Gear", 3]
];

function _numericVal(value)
{
    const number = Number(value);
    return value !== "" && value !== null && Number.isFinite(number) ? number : value;
}

function _tagList(tags)
{
    return (Array.isArray(tags) ? tags : [])
        .filter(tag => tag?.lid || tag?.id)
        .map(tag =>
        {
            const entry = { id: String(tag.lid || tag.id) };
            if (tag.val !== undefined && tag.val !== null && tag.val !== "")
                entry.val = _numericVal(tag.val);
            return entry;
        });
}

function _gearData(item, dataType)
{
    const system = item.system || {};
    const data = { id: system.lid, name: item.name, type: dataType, description: String(system.description || ""), tags: _tagList(system.tags) };
    if (system.effect)
        data.effect = String(system.effect);
    if (dataType === "Weapon")
    {
        data.range = _rangeList(system.range);
        data.damage = _profileList(system.damage);
    }
    return data;
}

function _gearEntry(item, className, dataType)
{
    const data = _gearData(item, dataType);
    const limited = data.tags.find(tag => tag.id === "tg_limited");
    return {
        id: data.id,
        instanceId: _uuid(),
        type: className,
        note: "",
        data,
        flavorName: "",
        flavorDescription: "",
        maxUses: typeof limited?.val === "number" ? limited.val : 0,
        currentUses: 0,
        destroyed: false,
        isUsed: false
    };
}

function _syncPilotGear(ctx, json, actor)
{
    const loadouts = json.loadouts;
    if (!Array.isArray(loadouts) || !loadouts.length)
        return;
    const loadout = loadouts[json.active_index] || loadouts[0];
    if (!loadout || typeof loadout !== "object")
        return;
    const before = JSON.stringify(loadout);
    for (const [key, itemType, className, dataType, cap] of GEAR_TYPES)
    {
        if (!Array.isArray(loadout[key]))
            continue;
        const pending = actor.items.filter(item => item.type === itemType && item.system?.lid);
        const kept = [];
        for (const entry of loadout[key])
        {
            const id = entry?.id || entry?.data?.id;
            const match = id ? pending.findIndex(item => item.system.lid === id) : -1;
            if (match < 0)
                continue;
            pending.splice(match, 1);
            kept.push(entry);
        }
        for (const item of pending)
            kept.push(_gearEntry(item, className, dataType));
        if (kept.length > cap)
            ctx.notes.push(`Pilot ${key}: ${kept.length} items, Comp/Con shows ${cap} by default`);
        loadout[key] = kept;
    }
    if (JSON.stringify(loadout) !== before)
        ctx.stamp("loadouts");
}

function _sanitizedLid(id)
{
    const text = String(id ?? "").replace(/[^a-zA-Z0-9_]/g, "_");
    return /^[a-zA-Z]/.test(text) ? text : `b_${text}`;
}

function _clockIds(worldClocks, cloudClocks)
{
    const free = cloudClocks.filter(clock => typeof clock?.id === "string" && clock.id);
    const ids = worldClocks.map(() => null);
    const tests = [
        (world, cloud) => trimText(world.lid) && cloud.id === trimText(world.lid),
        (world, cloud) => trimText(world.lid) && _sanitizedLid(cloud.id) === trimText(world.lid),
        (world, cloud) => trimText(world.name) && trimText(cloud.title) === trimText(world.name)
    ];
    for (const test of tests)
    {
        worldClocks.forEach((world, index) =>
        {
            if (ids[index])
                return;
            const match = free.findIndex(cloud => test(world, cloud));
            if (match >= 0)
                ids[index] = free.splice(match, 1)[0].id;
        });
    }
    return ids.map((id, index) => id || trimText(worldClocks[index].lid) || _uuid());
}

function _segments(clock)
{
    const max = _number(clock.max);
    return max >= 1 ? max : 6;
}

function _clockEntry(clock, id)
{
    const segments = _segments(clock);
    return {
        id,
        title: String(clock.name || "Clock"),
        description: "",
        resolution: "",
        segments,
        progress: Math.min(segments, Math.max(0, _number(clock.value))),
        linear: false,
        gm_only: false
    };
}

function _syncClocks(ctx, bond, key, worldClocks)
{
    if (!Array.isArray(bond[key]))
        return;
    const clocks = (Array.isArray(worldClocks) ? worldClocks : []).filter(Boolean);
    const ids = _clockIds(clocks, bond[key]);
    const world = clocks.map((clock, index) => ({ id: ids[index], clock }));
    _syncEntities(ctx, bond[key], `bond.${key}`, world, {
        update: (entry, path, source) =>
        {
            const segments = _segments(source.clock);
            ctx.set(entry, "segments", segments, `${path}.segments`);
            ctx.set(entry, "progress", Math.min(segments, Math.max(0, _number(source.clock.value))), `${path}.progress`);
            if (trimText(source.clock.name))
                ctx.setText(entry, "title", String(source.clock.name), `${path}.title`);
        },
        create: source => _clockEntry(source.clock, source.id)
    });
}

function _powerEntry(power, origin)
{
    const entry = { name: trimText(power.name), description: String(power.description || "") };
    if (power.frequency)
        entry.frequency = String(power.frequency);
    entry.veteran = !!power.veteran;
    entry.master = !!power.master;
    if (power.prerequisite)
        entry.prerequisite = String(power.prerequisite);
    if (origin)
        entry.origin = origin;
    return entry;
}

function _bondData(bondItem)
{
    const system = bondItem.system || {};
    const lid = String(system.lid || "");
    return {
        id: lid,
        name: bondItem.name,
        major_ideals: (system.major_ideals || []).map(String),
        minor_ideals: (system.minor_ideals || []).map(String),
        questions: (system.questions || []).map(question => ({ question: String(question?.question || ""), options: (question?.options || []).map(String) })),
        powers: (system.powers || []).filter(power => trimText(power?.name)).map(power => _powerEntry(power, lid))
    };
}

function _syncBondPowers(ctx, bond, bondItem)
{
    const unlocked = (bondItem.system?.powers || []).filter(power => power?.unlocked && trimText(power.name));
    if (!Array.isArray(bond.bondPowers) && !unlocked.length)
        return;
    const current = Array.isArray(bond.bondPowers) ? bond.bondPowers : [];
    if (_isEntityArray(current))
    {
        ctx.notes.push("Bond powers carry ids in Comp/Con, not exported");
        return;
    }
    const names = new Set(unlocked.map(power => trimText(power.name)));
    const next = current.filter(power => names.has(trimText(power?.name)));
    const have = new Set(next.map(power => trimText(power.name)));
    for (const power of unlocked)
    {
        if (have.has(trimText(power.name)))
            continue;
        next.push(_powerEntry(power, String(bondItem.system?.lid || "")));
        have.add(trimText(power.name));
    }
    ctx.set(bond, "bondPowers", next, "bond.bondPowers");
}

function _syncBond(ctx, json, actor)
{
    const bond = json.bond;
    const bondItem = actorBond(actor);
    if (!bond || typeof bond !== "object" || !bondItem)
        return;
    const lid = trimText(bondItem.system?.lid);
    if (lid && lid !== trimText(bond.bondId))
    {
        ctx.set(bond, "bondId", lid, "bond.bondId");
        ctx.setTree(bond, "data", _bondData(bondItem), "bond.data");
    }
    const state = actor.system?.bond_state || {};
    ctx.set(bond, "xp", _number(state.xp?.value), "bond.xp");
    ctx.set(bond, "stress", _number(state.stress?.value), "bond.stress");
    ctx.setText(bond, "minorIdeal", String(state.minor_ideal ?? ""), "bond.minorIdeal");
    if (Array.isArray(state.answers))
        ctx.setText(bond, "bondAnswers", state.answers.map(answer => String(answer ?? "")), "bond.bondAnswers");
    _syncBondPowers(ctx, bond, bondItem);
    _syncClocks(ctx, bond, "burdens", state.burdens);
    _syncClocks(ctx, bond, "clocks", state.clocks);
}

function _syncPilotCore(ctx, json, actor)
{
    const system = actor.system || {};
    ctx.setText(json, "name", String(actor.name || ""), "name");
    ctx.setText(json, "callsign", String(system.callsign || ""), "callsign");
    ctx.set(json, "level", _number(system.level), "level");
    if (Array.isArray(json.mechSkills))
        ctx.set(json, "mechSkills", [_number(system.hull), _number(system.agi), _number(system.sys), _number(system.eng)], "mechSkills");
}

function _limitedBonus(mechActor)
{
    return _number(mechActor.system?.loadout?.limited_bonus);
}

function _uses(item, bonus)
{
    const uses = item?.system?.uses;
    const max = Math.max(0, _number(uses?.max) - bonus);
    return { maxUses: max, currentUses: Math.max(0, max - _number(uses?.value)) };
}

function _systemData(item, maxUses)
{
    const data = {
        id: item.system.lid,
        name: item.name,
        description: String(item.system?.description || ""),
        effect: String(item.system?.effect || ""),
        source: "",
        license: "",
        license_level: 0,
        sp: _number(item.system?.sp),
        type: "System"
    };
    if (maxUses > 0)
        data.tags = [{ id: "tg_limited", val: maxUses }];
    return data;
}

function _foundrySystems(mechActor, integratedIds)
{
    return (mechActor.system?.loadout?.systems || [])
        .map(link => link?.value)
        .filter(item => item?.system?.lid && !integratedIds.has(item.system.lid))
        .map(item => ({ id: item.system.lid, item }));
}

function _syncSystems(ctx, loadout, path, mechActor)
{
    if (!Array.isArray(loadout.systems))
        return;
    const bonus = _limitedBonus(mechActor);
    const integratedIds = new Set((loadout.integratedSystems || []).map(entry => entry?.id).filter(Boolean));
    _syncEntities(ctx, loadout.systems, `${path}.systems`, _foundrySystems(mechActor, integratedIds), {
        update: (entry, entryPath, source) =>
        {
            const uses = _uses(source.item, bonus);
            ctx.set(entry, "currentUses", uses.currentUses, `${entryPath}.currentUses`);
            ctx.set(entry, "destroyed", !!source.item.system?.destroyed, `${entryPath}.destroyed`);
        },
        create: source =>
        {
            const uses = _uses(source.item, bonus);
            return {
                id: source.id,
                instanceId: _uuid(),
                data: _systemData(source.item, uses.maxUses),
                flavorName: "",
                flavorDescription: "",
                maxUses: uses.maxUses,
                currentUses: uses.currentUses,
                destroyed: !!source.item.system?.destroyed,
                isUsed: false
            };
        }
    });
}

function _weaponSize(item)
{
    return FOUNDRY_SIZE[String(item?.system?.size || "").toLowerCase()] || "Main";
}

function _profileList(list)
{
    return (Array.isArray(list) ? list : [])
        .filter(entry => entry && typeof entry === "object" && entry.type)
        .map(entry => ({ type: String(entry.type), val: entry.val }));
}

function _rangeList(list)
{
    return _profileList(list).map(entry => ({ ...entry, val: _numericVal(entry.val) }));
}

function _weaponData(item, size)
{
    const system = item.system || {};
    const profile = system.profiles?.[system.selected_profile_index ?? 0] || system.profiles?.[0] || {};
    return {
        id: system.lid,
        name: item.name,
        mount: size,
        type: String(profile.type || "Rifle"),
        sp: _number(system.sp),
        tags: [],
        damage: _profileList(profile.damage),
        range: _rangeList(profile.range),
        effect: String(profile.effect || ""),
        description: String(system.description || ""),
        source: "",
        license: "",
        license_level: 0
    };
}

function _modEntry(modItem, existing)
{
    if (!modItem?.system?.lid)
        return null;
    if (existing?.id === modItem.system.lid)
        return existing;
    return {
        id: modItem.system.lid,
        instanceId: _uuid(),
        note: "",
        data: {
            id: modItem.system.lid,
            name: modItem.name,
            sp: _number(modItem.system?.sp),
            effect: String(modItem.system?.effect || ""),
            description: String(modItem.system?.description || "")
        }
    };
}

function _weaponEntry(source, bonus, existing)
{
    const uses = _uses(source.item, bonus);
    const base = existing?.id === source.id
        ? { ...existing }
        : { id: source.id, instanceId: _uuid(), note: "", data: _weaponData(source.item, source.size) };
    const entry = {
        ...base,
        selectedProfile: _number(source.item.system?.selected_profile_index),
        maxUses: uses.maxUses,
        currentUses: uses.currentUses,
        destroyed: !!source.item.system?.destroyed,
        isUsed: !!base.isUsed
    };
    const mod = _modEntry(source.mod, existing?.mod);
    if (mod)
        entry.mod = mod;
    else
        delete entry.mod;
    return entry;
}

function _foundryMounts(mechActor, integratedIds)
{
    return (mechActor.system?.loadout?.weapon_mounts || [])
        .filter(mount => mount?.type !== "Integrated")
        .map(mount => ({
            type: String(mount?.type || ""),
            sources: (mount?.slots || []).map(slot =>
            {
                const item = slot?.weapon?.value;
                const id = item?.system?.lid;
                return id && !integratedIds.has(id) ? { id, item, mod: slot?.mod?.value || null, size: _weaponSize(item) } : null;
            }).filter(Boolean)
        }))
        .filter(mount => mount.sources.length);
}

function _bySize(sources)
{
    return [...sources].sort((sourceA, sourceB) => (SIZE_RANK[sourceB.size] ?? 0) - (SIZE_RANK[sourceA.size] ?? 0));
}

function _capacity(ref)
{
    if (ref.field === "extra")
        return 0;
    const size = String(ref.slot.size || "");
    return size === "Flex" ? SIZE_RANK.Main : (SIZE_RANK[size] ?? 0);
}

function _bestFit(refs, size)
{
    return refs
        .filter(ref => !ref.slot.weapon && _fits(ref, size))
        .sort((refA, refB) => _capacity(refA) - _capacity(refB))[0] || null;
}

function _slotRefs(loadout, json)
{
    const refs = [];
    const add = mount =>
    {
        for (const field of ["slots", "extra"])
        {
            (mount?.[field] || []).forEach(slot =>
            {
                if (slot && typeof slot === "object")
                    refs.push({ mount, field, slot });
            });
        }
    };
    (loadout.mounts || []).forEach(mount => add(mount));
    const bonuses = new Set((Array.isArray(json?.core_bonuses) ? json.core_bonuses : []).map(entry => entry?.id));
    const few = (loadout.mounts || []).length < 3;
    const active = {
        integratedWeapon: bonuses.has("cb_integrated_weapon"),
        improved_armament: bonuses.has("cb_improved_armament") && few,
        superheavy_mounting: bonuses.has("cb_superheavy_mounting") && few
    };
    for (const owner of BONUS_MOUNTS)
    {
        if (!active[owner])
            continue;
        add(loadout[owner]);
    }
    return refs;
}

function _fits(ref, size)
{
    if (ref.mount?.lock)
        return false;
    const slotSize = String(ref.slot.size || "");
    if (ref.field === "extra")
    {
        const first = ref.mount.slots?.[0]?.weapon;
        return size === "Auxiliary" && (!first || first.data?.mount === "Auxiliary");
    }
    if (slotSize === "Flex")
        return size === "Main" || size === "Auxiliary";
    if (size === "Superheavy")
        return slotSize === "Superheavy";
    return (SIZE_RANK[slotSize] ?? -1) >= (SIZE_RANK[size] ?? 99);
}

function _syncMounts(ctx, loadout, path, mechActor)
{
    if (!Array.isArray(loadout.mounts))
        return;
    const snapshot = () => JSON.stringify([loadout.mounts, ...BONUS_MOUNTS.map(owner => loadout[owner])]);
    const before = snapshot();
    const bonus = _limitedBonus(mechActor);
    const integratedIds = new Set((loadout.integratedMounts || []).map(mount => mount?.weapon?.id).filter(Boolean));
    const refs = _slotRefs(loadout, ctx.json);
    const previous = new Map(refs.map(ref => [ref, ref.slot.weapon]));
    const spare = refs.map(ref => ref.slot.weapon).filter(Boolean);
    const homes = [...new Set(refs.map(ref => ref.mount))];
    const groups = _foundryMounts(mechActor, integratedIds);
    const target = new Map();
    const claim = (group, test) =>
    {
        const taken = new Set(target.values());
        const home = homes.find(mount => !taken.has(mount) && String(mount?.mount_type || "") === group.type && test(mount));
        if (home)
            target.set(group, home);
    };
    for (const group of groups)
        claim(group, mount => group.sources.some(source => refs.some(ref => ref.mount === mount && previous.get(ref)?.id === source.id)));
    for (const group of groups.filter(entry => !target.has(entry)))
        claim(group, () => true);

    const assign = (ref, source) =>
    {
        const own = previous.get(ref);
        const existing = own?.id === source.id && spare.includes(own) ? own : (spare.find(entry => entry.id === source.id) || null);
        if (existing)
            spare.splice(spare.indexOf(existing), 1);
        ref.slot.weapon = _weaponEntry(source, bonus, existing);
    };
    for (const ref of refs)
    {
        if (ref.slot.weapon)
            ref.slot.weapon = null;
    }
    const leftover = [];
    for (const group of groups)
    {
        const home = refs.filter(ref => ref.mount === target.get(group));
        for (const source of _bySize(group.sources))
        {
            const ref = home.find(candidate => !candidate.slot.weapon && _fits(candidate, source.size));
            if (ref)
                assign(ref, source);
            else
                leftover.push(source);
        }
    }
    const claimed = new Set(target.values());
    for (const source of _bySize(leftover))
    {
        const ref = _bestFit(refs.filter(candidate => !claimed.has(candidate.mount)), source.size) || _bestFit(refs, source.size);
        if (!ref)
        {
            ctx.notes.push(`${source.item.name}: no free ${source.size} slot in Comp/Con, not exported`);
            continue;
        }
        assign(ref, source);
    }
    if (snapshot() === before)
        return;
    const [beforeMounts, ...beforeOwners] = JSON.parse(before);
    if (!sameJson(beforeMounts, loadout.mounts))
        ctx.stamp(`${path}.mounts`);
    for (const [index, owner] of BONUS_MOUNTS.entries())
    {
        if (!loadout[owner])
            continue;
        for (const field of ["slots", "extra"])
        {
            if (Array.isArray(loadout[owner][field]) && !sameJson(beforeOwners[index]?.[field], loadout[owner][field]))
                ctx.stamp(`${path}.${owner}.${field}`);
        }
    }
}

function _syncMech(ctx, mech, mechActor)
{
    const system = mechActor.system || {};
    const base = `mechs.${mech.id}`;
    ctx.setText(mech, "name", String(mechActor.name || ""), `${base}.name`);
    const stats = mech.stats;
    if (stats?.current && system.overcharge !== undefined)
        ctx.set(stats.current, "overcharge", Math.min(3, Math.max(0, Math.trunc(_number(system.overcharge?.value ?? system.overcharge)))), `${base}.stats.current.overcharge`);
    if (mech.coreActive && system.core_active === false)
        ctx.set(mech, "coreActive", false, `${base}.coreActive`);
    const corePower = _number(system.core_energy) > 0;
    if (system.core_energy !== undefined && (mech.corePower ?? true) !== corePower)
        ctx.set(mech, "corePower", corePower, `${base}.corePower`);
    const loadout = mech.loadouts?.[mech.active_loadout_index || 0];
    if (!loadout?.id)
        return;
    const path = `${base}.loadouts.${loadout.id}`;
    _syncSystems(ctx, loadout, path, mechActor);
    _syncMounts(ctx, loadout, path, mechActor);
}

export { _context as patchContext, _syncEntities as syncEntities };

export function findMechActor(mechId, pilotActor)
{
    const candidates = findExistingMechByLid(mechId);
    return candidates.find(mech => isMechLinkedTo(mech, pilotActor)) || candidates[0] || null;
}

export function buildPilotPatch(json, actor, now, { includePilot = true, mechIds = null } = {})
{
    const ctx = _context(json, now);
    if (includePilot)
    {
        _syncPilotCore(ctx, json, actor);
        _syncBond(ctx, json, actor);
        _syncTalents(ctx, json, actor);
        _syncSkills(ctx, json, actor);
        _syncLicenses(ctx, json, actor);
        _syncCoreBonuses(ctx, json, actor);
        _syncReserves(ctx, json, actor);
        _syncOrgs(ctx, json, actor);
        _syncPilotGear(ctx, json, actor);
    }
    for (const mech of (Array.isArray(json.mechs) ? json.mechs : []))
    {
        if (!mech?.id || (mechIds && !mechIds.has(mech.id)))
            continue;
        const mechActor = findMechActor(mech.id, actor);
        if (mechActor)
            _syncMech(ctx, mech, mechActor);
    }
    return { changed: ctx.changed > 0, count: ctx.changed, notes: ctx.notes };
}

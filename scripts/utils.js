export const MODULE_ID = "lancer-npc-import";

export function getModuleSetting(key, fallback = undefined)
{
    try
    {
        return game.settings.get(MODULE_ID, key) ?? fallback;
    }
    catch
    {
        return fallback;
    }
}

export function setModuleSetting(key, value)
{
    return game.settings.set(MODULE_ID, key, value);
}

export function trimText(value)
{
    return String(value ?? "").trim();
}

export function sameJson(a, b)
{
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function escapeHtml(value)
{
    return foundry.utils.escapeHTML(String(value ?? ""));
}

export function clampRank(value)
{
    return Math.min(3, Math.max(1, Number(value) || 1));
}

export function frameLicenseId(id)
{
    return String(id ?? "").replace(/^(?:lic_)+/, "");
}

export function reserveKey(id, name)
{
    return id === "reserve_custom" || id === "reserve_project" ? `${id}:${trimText(name)}` : id;
}

export function cloudSortKey(item)
{
    return item?.sortkey || item?.SortKey || item?.sk || "";
}

export const LOCKS = {
    owner: "Not yours",
    create: "Needs Create Actors"
};

export const LOCK_TIPS = {
    [LOCKS.owner]: "You don't own this actor in Foundry. Ask your GM for ownership.",
    [LOCKS.create]: "This creates a new actor, which needs the Create Actors permission. Ask your GM for it, or to import it."
};

export function canEditActor(actor)
{
    return !!actor?.isOwner;
}

export function canCreateActors()
{
    return !!game.user?.can("ACTOR_CREATE");
}

export function actorLock(actor)
{
    if (actor)
        return canEditActor(actor) ? "" : LOCKS.owner;
    return canCreateActors() ? "" : LOCKS.create;
}

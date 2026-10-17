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

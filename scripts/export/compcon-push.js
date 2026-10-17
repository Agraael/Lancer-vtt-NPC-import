import { CORS_PROXIES, WORKER_PROXY_NAME, getV3ApiBase, cdnFetch, liveCloudItems, v3AuthHeaders } from "../v3-api.js";
import { getUserSub } from "../auth/cognito-auth.js";
import { cloudSortKey } from "../utils.js";

const BACKUP_ROOT = "comp-con-backups";

function _worker()
{
    const proxy = CORS_PROXIES.find(entry => entry.name === WORKER_PROXY_NAME);
    if (!proxy)
        throw new Error("The Comp/Con proxy is not configured");
    return proxy;
}

async function _api(method, query, body)
{
    const { headers, userId } = await v3AuthHeaders();
    const url = `${getV3ApiBase()}/user?user_id=${encodeURIComponent(userId)}&${query}`;
    const response = await fetch(_worker().wrap(url), {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    if (!response.ok)
        throw new Error(`Comp/Con ${method} ${query.split("&")[0]} failed (${response.status})`);
    return text ? JSON.parse(text) : {};
}

export function cloudItemId(item)
{
    return cloudSortKey(item).split("_").slice(2).join("_");
}

export async function listCloudItems(prefix)
{
    const data = await _api("GET", "scope=all");
    const items = Array.isArray(data) ? data : (data.items || data.Items || []);
    return liveCloudItems(items, prefix);
}

export async function downloadCloudFile(item)
{
    const response = await cdnFetch(item.uri);
    if (!response.ok)
        throw new Error(`Comp/Con download failed (${response.status})`);
    const json = await response.json();
    if (!json || typeof json !== "object" || Array.isArray(json) || (json.data && !json.name))
        throw new Error("Unexpected Comp/Con file shape");
    return json;
}

async function _upload(target, body)
{
    const init = { method: "PUT", body, headers: { "Content-Type": "application/json" } };
    let response;
    try
    {
        response = await fetch(target, init);
    }
    catch
    {
        response = await fetch(_worker().wrap(target), init);
    }
    if (!response.ok)
        throw new Error(`Comp/Con upload failed (${response.status})`);
}

export async function pushCloudFile(item, json, stamp)
{
    const body = JSON.stringify(json);
    const { presigns } = await _api("POST", "scope=presign", { uris: [item.uri] });
    const target = presigns?.[item.uri];
    if (!target)
        throw new Error("Comp/Con returned no upload link");
    await _upload(target, body);
    const result = await _api("POST", "scope=item", {
        user_id: item.user_id ?? getUserSub(),
        sortkey: cloudSortKey(item),
        name: item.name,
        author: item.author ?? "",
        item_modified: stamp,
        uri: item.uri,
        size: body.length,
        created: item.created,
        updated: item.updated,
        deleted: item.deleted,
        version: item.version,
        code: item.code,
        ttl: item.ttl
    });
    if (result?.error)
        throw new Error(`Comp/Con did not register the upload: ${result.error}`);
    return result;
}

export function entityKeys(list)
{
    const seen = new Map();
    return (Array.isArray(list) ? list : []).map(entry =>
    {
        const id = entry?.id;
        if (typeof id !== "string" || !id)
            return null;
        const count = seen.get(id) ?? 0;
        seen.set(id, count + 1);
        return count === 0 ? id : `${id}#${count}`;
    });
}

export function stampField(json, key, now)
{
    json._ts ??= {};
    let stamp = Math.max(now, (Number(json._ts[key]) || 0) + 1);
    for (const [path, value] of Object.entries(json._ts))
    {
        if (path.startsWith(`${key}.`))
            stamp = Math.max(stamp, (Number(value) || 0) + 1);
    }
    json._ts[key] = stamp;
    return stamp;
}

function _picker()
{
    return foundry.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
}

async function _accountFolder()
{
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(getUserSub() || "anonymous"));
    return [...new Uint8Array(bytes)].slice(0, 8).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function _ensureFolder(path)
{
    const picker = _picker();
    let current = "";
    for (const part of path.split("/"))
    {
        current = current ? `${current}/${part}` : part;
        try
        {
            await picker.createDirectory("data", current, { notify: false });
        }
        catch
        {
            continue;
        }
    }
}

export async function saveBackup(item, json)
{
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const text = JSON.stringify(json, null, 2);
    if (game.user.can("FILES_UPLOAD"))
    {
        const folder = `${BACKUP_ROOT}/${await _accountFolder()}/${cloudSortKey(item)}`;
        await _ensureFolder(folder);
        const file = new File([text], name, { type: "application/json" });
        const result = await _picker().upload("data", folder, file, {}, { notify: false });
        if (result?.status !== "success" && !result?.path)
            throw new Error("The backup could not be saved");
        return { where: "server", path: result.path || `${folder}/${name}` };
    }
    const save = foundry.utils.saveDataToFile ?? globalThis.saveDataToFile;
    save(text, "application/json", `${cloudSortKey(item)}-${name}`);
    return { where: "download", path: name };
}

export async function patchCloudFile(item, patch)
{
    const original = await downloadCloudFile(item);
    const json = foundry.utils.deepClone(original);
    const now = Date.now();
    const result = await patch(json, now);
    if (!result?.changed)
        return { changed: false, result, json };
    await saveBackup(item, original);
    await pushCloudFile(item, json, now);
    return { changed: true, result, json };
}

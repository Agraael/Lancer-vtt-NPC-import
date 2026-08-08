const ITEM_ARRAYS = [
    "coreBonuses", "frames", "mods", "npcClasses", "npcFeatures", "npcTemplates",
    "pilotGear", "reserves", "skills", "statuses", "systems", "tags", "talents",
    "bonds", "weapons"
];

function collectIds(data, out)
{
    if (Array.isArray(data))
    {
        for (const item of data)
        {
            if (item && typeof item.id === "string" && item.id.length)
                out.add(item.id);
        }
        return;
    }
    const root = data?.data || data;
    if (!root || typeof root !== "object")
        return;
    for (const key of ITEM_ARRAYS)
    {
        const arr = root[key];
        if (!Array.isArray(arr))
            continue;
        for (const item of arr)
        {
            if (item && typeof item.id === "string" && item.id.length)
                out.add(item.id);
        }
    }
}

async function parseFromZip(buffer)
{
    if (typeof JSZip === "undefined")
    {
        throw new Error("JSZip is not available - upload the extracted .json instead.");
    }
    const zip = await JSZip.loadAsync(buffer);
    const lids = new Set();
    let manifest = null;
    for (const name of Object.keys(zip.files))
    {
        if (!name.endsWith(".json"))
            continue;
        try
        {
            const text = await zip.files[name].async("text");
            const data = JSON.parse(text);
            if (name === "lcp_manifest.json")
                manifest = data;
            else
                collectIds(data, lids);
        }
        catch (err)
        {
            console.warn(`refresh: skip ${name}`, err);
        }
    }
    return { lids, manifest };
}

async function parseFromJson(buffer)
{
    const text = new TextDecoder().decode(buffer);
    const data = JSON.parse(text);
    const lids = new Set();
    collectIds(data, lids);
    const manifest = data?.lcp_manifest || data?.manifest || null;
    return { lids, manifest };
}

export async function loadLcpFile(file)
{
    const buf = await file.arrayBuffer();
    const isZip = /\.lcp$/i.test(file.name) || /\.zip$/i.test(file.name);
    const { lids, manifest } = isZip ? await parseFromZip(buf) : await parseFromJson(buf);
    return {
        lids,
        name: manifest?.name || file.name,
        version: manifest?.version || null,
        count: lids.size
    };
}

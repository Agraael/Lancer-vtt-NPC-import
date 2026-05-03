import { translateV3LcpBlob, getLancerApi } from "./v3-lcp-shim.js";

async function parsePackOnly(file) {
    let blob = file;
    const translated = await translateV3LcpBlob(file);
    if (!translated.summary?.alreadyV2 && translated.blob)
        blob = translated.blob;
    const arrayBuf = await blob.arrayBuffer();
    const { parseContentPack } = await getLancerApi();
    const pack = await parseContentPack(arrayBuf);
    return { manifest: pack.manifest, packId: pack.id, buckets: pack.data };
}

async function simulateImport(file) {
    let blob = file;
    const translated = await translateV3LcpBlob(file);
    if (!translated.summary?.alreadyV2 && translated.blob)
        blob = translated.blob;
    const arrayBuf = await blob.arrayBuffer();
    const { parseContentPack, importCP } = await getLancerApi();
    const pack = await parseContentPack(arrayBuf);

    const captured = {};
    const captureInto = (arr) => {
        for (const d of arr) {
            const t = d.type ?? "unknown";
            (captured[t] ??= []).push(d);
        }
    };

    const ItemCls = CONFIG.Item.documentClass;
    const ActorCls = CONFIG.Actor.documentClass;
    const orig = {
        itemCreate: ItemCls.createDocuments,
        itemUpdate: ItemCls.updateDocuments,
        actorCreate: ActorCls.createDocuments,
        actorUpdate: ActorCls.updateDocuments,
        folderCreate: Folder.create,
        settingsSet: game.settings.set.bind(game.settings)
    };

    ItemCls.createDocuments = async function (data) {
        captureInto(data ?? []);
        return (data ?? []).map(d => ({ id: d._id ?? foundry.utils.randomID(), ...d }));
    };
    ItemCls.updateDocuments = async function (data) {
        captureInto(data ?? []);
        return data ?? [];
    };
    const stubActor = (d) => {
        const id = d._id ?? foundry.utils.randomID();
        return {
            id,
            ...d,
            items: [],
            npcClassSwapPromises: [],
            removeClassFeatures: async () => {},
            deleteEmbeddedDocuments: async () => [],
            quickOwn: async () => null
        };
    };
    ActorCls.createDocuments = async function (data) {
        captureInto(data ?? []);
        return (data ?? []).map(stubActor);
    };
    ActorCls.updateDocuments = async function (data) {
        captureInto(data ?? []);
        return (data ?? []).map(stubActor);
    };
    Folder.create = async function (data) {
        return { id: foundry.utils.randomID(), getFlag: () => null, ...data };
    };
    game.settings.set = async function (scope, key, value) {
        if (scope === game.system.id && typeof key === "string" && key.includes("tag_config"))
            return value;
        return orig.settingsSet(scope, key, value);
    };

    try {
        await importCP(pack);
    } finally {
        ItemCls.createDocuments = orig.itemCreate;
        ItemCls.updateDocuments = orig.itemUpdate;
        ActorCls.createDocuments = orig.actorCreate;
        ActorCls.updateDocuments = orig.actorUpdate;
        Folder.create = orig.folderCreate;
        game.settings.set = orig.settingsSet;
    }

    return { manifest: pack.manifest, packId: pack.id, buckets: captured };
}

async function loadLcpAsBuckets(file, mode) {
    return mode === "simulated" ? simulateImport(file) : parsePackOnly(file);
}

function indexBucket(arr) {
    const map = new Map();
    let unkeyed = 0;
    for (const item of arr) {
        const key = item?.id ?? item?.lid ?? null;
        if (key == null) {
            map.set(`__unkeyed_${unkeyed++}__`, item);
            continue;
        }
        if (map.has(key))
            map.set(`${key}#dup_${unkeyed++}`, item);
        else
            map.set(key, item);
    }
    return map;
}

function stableStringify(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(stableStringify).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",")}}`;
}

function _isPlainObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

function fieldDiff(a, b, path = "", out = []) {
    if (stableStringify(a) === stableStringify(b))
        return out;
    // Both sides plain objects: recurse so each leaf diff lands on its own line.
    if (_isPlainObj(a) && _isPlainObj(b)) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const k of keys) {
            const subPath = path ? `${path}.${k}` : k;
            fieldDiff(a[k], b[k], subPath, out);
        }
        return out;
    }
    // Both sides arrays of equal length: recurse per index. Different lengths or
    // mixed types fall through to leaf-level (whole array shown).
    if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
        for (let i = 0; i < a.length; i++)
            fieldDiff(a[i], b[i], `${path}[${i}]`, out);
        return out;
    }
    out.push({ key: path, a, b });
    return out;
}

function diffBuckets(a, b) {
    const allBuckets = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    const out = {};
    for (const bucket of allBuckets) {
        const ma = indexBucket(a?.[bucket] ?? []);
        const mb = indexBucket(b?.[bucket] ?? []);
        const added = [];
        const removed = [];
        const changed = [];
        const unchanged = [];
        for (const [k, v] of mb)
            if (!ma.has(k))
                added.push({ key: k, item: v });
        for (const [k, v] of ma)
            if (!mb.has(k))
                removed.push({ key: k, item: v });
        for (const [k, va] of ma) {
            if (!mb.has(k))
                continue;
            const vb = mb.get(k);
            if (stableStringify(va) === stableStringify(vb)) {
                unchanged.push({ key: k, item: va });
                continue;
            }
            changed.push({ key: k, a: va, b: vb, fields: fieldDiff(va, vb) });
        }
        if (added.length || removed.length || changed.length || unchanged.length || ma.size || mb.size) {
            out[bucket] = {
                countA: ma.size,
                countB: mb.size,
                added,
                removed,
                changed,
                unchanged
            };
        }
    }
    return out;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
    }[c]));
}

function previewValue(v) {
    if (v === undefined)
        return "<em>undefined</em>";
    let s;
    try {
        s = JSON.stringify(v);
    } catch {
        s = String(v);
    }
    if (s == null)
        s = String(v);
    if (s.length > 200)
        s = s.slice(0, 200) + "…";
    return escapeHtml(s);
}

function renderDiffHtml(manifestA, manifestB, diff, mode = "parsed") {
    const sections = [];
    const totals = { added: 0, removed: 0, changed: 0, countA: 0, countB: 0 };
    for (const info of Object.values(diff)) {
        totals.added += info.added.length;
        totals.removed += info.removed.length;
        totals.changed += info.changed.length;
        totals.countA += info.countA;
        totals.countB += info.countB;
    }

    const head = `
        <div class="lcp-diff-head">
            <div style="font-size:11px;color:#555;margin-bottom:4px;">${mode === "simulated" ? "Diff of <strong>simulated import</strong> output (what would land in compendia, no write performed)." : "Diff of <code>parseContentPack</code> output (translator + parser only, before <code>importCP</code>)."}</div>
            <div><strong>A:</strong> ${escapeHtml(manifestA?.name ?? "(no manifest)")}
                 <span class="lcp-diff-ver">${escapeHtml(manifestA?.version ?? "")}</span></div>
            <div><strong>B:</strong> ${escapeHtml(manifestB?.name ?? "(no manifest)")}
                 <span class="lcp-diff-ver">${escapeHtml(manifestB?.version ?? "")}</span></div>
            <div class="lcp-diff-totals">
                <span class="lcp-diff-pill lcp-diff-a">${totals.countA} in A</span>
                <span class="lcp-diff-pill lcp-diff-b">${totals.countB} in B</span>
                <span class="lcp-diff-pill lcp-diff-add">+${totals.added}</span>
                <span class="lcp-diff-pill lcp-diff-rem">-${totals.removed}</span>
                <span class="lcp-diff-pill lcp-diff-chg">~${totals.changed}</span>
            </div>
        </div>
    `;

    for (const [bucket, info] of Object.entries(diff)) {
        const hasChanges = info.added.length || info.removed.length || info.changed.length;
        const unchangedCount = info.unchanged?.length ?? 0;
        const summary = `${bucket} (${info.countA} → ${info.countB}` +
            (hasChanges ? `, +${info.added.length} -${info.removed.length} ~${info.changed.length} =${unchangedCount}` : `, identical (=${unchangedCount})`) +
            `)`;

        const rows = [];
        const fullJson = (item) => escapeHtml(JSON.stringify(item, null, 2));
        for (const e of info.added)
            rows.push(`
                <li class="lcp-diff-row lcp-diff-row-add">
                    <details>
                        <summary><span class="lcp-diff-tag">ADDED</span><code>${escapeHtml(e.key)}</code> <span class="lcp-diff-name">${escapeHtml(e.item?.name ?? "")}</span></summary>
                        <pre class="lcp-diff-full">${fullJson(e.item)}</pre>
                    </details>
                </li>
            `);
        for (const e of info.removed)
            rows.push(`
                <li class="lcp-diff-row lcp-diff-row-rem">
                    <details>
                        <summary><span class="lcp-diff-tag">REMOVED</span><code>${escapeHtml(e.key)}</code> <span class="lcp-diff-name">${escapeHtml(e.item?.name ?? "")}</span></summary>
                        <pre class="lcp-diff-full">${fullJson(e.item)}</pre>
                    </details>
                </li>
            `);
        for (const e of info.changed) {
            const fields = e.fields.slice(0, 12).map(f => `
                <li class="lcp-diff-field">
                    <code>${escapeHtml(f.key)}</code>
                    <span class="lcp-diff-from">A: ${previewValue(f.a)}</span>
                    <span class="lcp-diff-to">B: ${previewValue(f.b)}</span>
                </li>
            `).join("");
            const more = e.fields.length > 12 ? `<li class="lcp-diff-field-more">+${e.fields.length - 12} more</li>` : "";
            rows.push(`
                <li class="lcp-diff-row lcp-diff-row-chg">
                    <details open>
                        <summary><span class="lcp-diff-tag">CHANGED</span><code>${escapeHtml(e.key)}</code> <span class="lcp-diff-name">${escapeHtml(e.b?.name ?? e.a?.name ?? "")}</span> <span class="lcp-diff-field-count">(${e.fields.length} field${e.fields.length === 1 ? "" : "s"})</span></summary>
                        <ul class="lcp-diff-fields">${fields}${more}</ul>
                        <details>
                            <summary class="lcp-diff-full-toggle">Show full A &amp; B</summary>
                            <div class="lcp-diff-full-pair">
                                <div><div class="lcp-diff-full-label">A (full)</div><pre class="lcp-diff-full">${fullJson(e.a)}</pre></div>
                                <div><div class="lcp-diff-full-label">B (full)</div><pre class="lcp-diff-full">${fullJson(e.b)}</pre></div>
                            </div>
                        </details>
                    </details>
                </li>
            `);
        }
        for (const e of info.unchanged ?? [])
            rows.push(`
                <li class="lcp-diff-row lcp-diff-row-unc">
                    <details>
                        <summary><span class="lcp-diff-tag">UNCHANGED</span><code>${escapeHtml(e.key)}</code> <span class="lcp-diff-name">${escapeHtml(e.item?.name ?? "")}</span></summary>
                        <pre class="lcp-diff-full">${fullJson(e.item)}</pre>
                    </details>
                </li>
            `);

        sections.push(`
            <details class="lcp-diff-bucket" ${hasChanges ? "open" : ""}>
                <summary>${escapeHtml(summary)}</summary>
                <ul class="lcp-diff-rows">${rows.join("") || "<li class=\"lcp-diff-empty\">no differences</li>"}</ul>
            </details>
        `);
    }

    return `<div class="lcp-diff-root">${head}${sections.join("")}</div>`;
}

function inlineStyles() {
    return `
        <style>
            #lcp-debug-diff, #lcp-debug-diff * {
                -webkit-user-select: text;
                -moz-user-select: text;
                user-select: text;
            }
            #lcp-debug-diff .lcp-diff-actions button {
                width: auto !important;
                height: auto !important;
                min-height: 0 !important;
                padding: 3px 10px !important;
                line-height: 22px !important;
                font-size: 13px !important;
                flex: 0 0 auto !important;
            }
            .lcp-diff-root { font-size: 12px; color: #1c1c1c; }
            .lcp-diff-head { padding: 6px 8px; border: 1px solid #888; border-radius: 4px; margin-bottom: 8px; background: rgba(0,0,0,0.05); }
            .lcp-diff-ver { color: #555; margin-left: 4px; }
            .lcp-diff-totals { margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; }
            .lcp-diff-pill { padding: 1px 6px; border-radius: 8px; font-weight: bold; color: #fff; }
            .lcp-diff-a { background: #2c3e50; }
            .lcp-diff-b { background: #34495e; }
            .lcp-diff-add { background: #1e6f3a; }
            .lcp-diff-rem { background: #7a2424; }
            .lcp-diff-chg { background: #7a5c1c; }
            .lcp-diff-bucket { margin: 4px 0; border: 1px solid #888; border-radius: 4px; background: rgba(0,0,0,0.02); }
            .lcp-diff-bucket > summary { padding: 4px 8px; cursor: pointer; background: rgba(0,0,0,0.06); font-weight: bold; color: #1c1c1c; }
            .lcp-diff-rows { list-style: none; margin: 0; padding: 4px 8px; max-height: 320px; overflow: auto; }
            .lcp-diff-row { padding: 2px 0; border-bottom: 1px dotted #aaa; }
            .lcp-diff-tag {
                display: inline-block; min-width: 64px; padding: 1px 4px;
                font-weight: bold; font-size: 10px; border-radius: 3px; margin-right: 6px; color: #fff;
            }
            .lcp-diff-row-add .lcp-diff-tag { background: #1e6f3a; }
            .lcp-diff-row-rem .lcp-diff-tag { background: #7a2424; }
            .lcp-diff-row-chg .lcp-diff-tag { background: #7a5c1c; }
            .lcp-diff-row-unc .lcp-diff-tag { background: #555; }
            .lcp-diff-row-unc { opacity: 0.75; }
            .lcp-diff-name { color: #444; margin-left: 6px; font-style: italic; }
            .lcp-diff-row > code { background: rgba(0,0,0,0.08); padding: 1px 4px; border-radius: 2px; color: #1c1c1c; }
            .lcp-diff-fields { margin: 4px 0 6px 16px; padding: 0; list-style: none; }
            .lcp-diff-field { padding: 2px 0; border-left: 2px solid #ccc; padding-left: 6px; margin-bottom: 4px; }
            .lcp-diff-field > code {
                display: inline-block; background: #2c3e50; color: #fff;
                padding: 1px 6px; border-radius: 2px; font-weight: bold; font-size: 11px;
            }
            .lcp-diff-from { display: block; color: #8a1d1d; padding-left: 12px; word-break: break-all; }
            .lcp-diff-to { display: block; color: #1e6f3a; padding-left: 12px; word-break: break-all; }
            .lcp-diff-field-more { color: #555; font-style: italic; padding: 2px 0 0 6px; }
            .lcp-diff-empty { color: #555; font-style: italic; }
            .lcp-diff-row > details > summary { cursor: pointer; list-style: revert; }
            .lcp-diff-full {
                margin: 4px 0 6px 16px; padding: 6px 8px;
                background: #1c1c1c; color: #ddd;
                border-radius: 3px; font-size: 11px;
                max-height: 300px; overflow: auto;
                white-space: pre-wrap; word-break: break-word;
            }
            .lcp-diff-full-toggle { cursor: pointer; color: #555; font-size: 11px; padding: 2px 0 2px 16px; font-style: italic; }
            .lcp-diff-full-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-left: 16px; }
            .lcp-diff-full-pair .lcp-diff-full { margin-left: 0; }
            .lcp-diff-full-label { font-weight: bold; font-size: 11px; color: #444; padding: 2px 0; }
            .lcp-diff-pickers { display: flex; gap: 12px; margin-bottom: 8px; }
            .lcp-diff-pickers > label { flex: 1; }
            .lcp-diff-pickers input[type=file] { width: 100%; }
        </style>
    `;
}

class LcpDebugDiffApp extends Application {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "lcp-debug-diff",
            title: "LCP Debug // Diff Two Imports",
            template: null,
            width: 820,
            height: 640,
            resizable: true,
            classes: ["lcp-debug-diff-app"]
        });
    }

    constructor(...args) {
        super(...args);
        this._pickedA = null;
        this._pickedB = null;
        this._lastA = null;
        this._lastB = null;
        this._lastDiff = null;
    }

    async _renderInner() {
        return $(`
            ${inlineStyles()}
            <div class="lcp-diff-pickers flex0">
                <label>LCP A<input type="file" class="lcp-diff-a" accept=".lcp,application/zip"></label>
                <label>LCP B<input type="file" class="lcp-diff-b" accept=".lcp,application/zip"></label>
            </div>
            <div class="lcp-diff-actions flex0" style="display:flex;gap:6px;margin:6px 0 10px;flex-wrap:wrap;align-items:flex-start;">
                <button type="button" class="lcp-diff-run" style="width:auto !important;height:auto !important;min-height:0 !important;max-height:32px !important;padding:3px 10px !important;line-height:22px !important;font-size:13px !important;flex:0 0 auto !important;" title="Diff parsed content pack (translator output)"><i class="fas fa-not-equal"></i> Compare (Parsed)</button>
                <button type="button" class="lcp-diff-run-sim" style="width:auto !important;height:auto !important;min-height:0 !important;max-height:32px !important;padding:3px 10px !important;line-height:22px !important;font-size:13px !important;flex:0 0 auto !important;" title="Run a real importCP through patched globals — diff what would land in compendia. No write."><i class="fas fa-vial"></i> Compare (Import Sim)</button>
                <button type="button" class="lcp-diff-run-single" style="width:auto !important;height:auto !important;min-height:0 !important;max-height:32px !important;padding:3px 10px !important;line-height:22px !important;font-size:13px !important;flex:0 0 auto !important;" title="Single LCP (slot A only): diff parseContentPack output vs simulated import output. Reveals what importCP transforms or drops."><i class="fas fa-search"></i> Single (Parsed vs Sim)</button>
                <button type="button" class="lcp-diff-log" style="width:auto !important;height:auto !important;min-height:0 !important;max-height:32px !important;padding:3px 10px !important;line-height:22px !important;font-size:13px !important;flex:0 0 auto !important;"><i class="fas fa-terminal"></i> Log to Console</button>
                <button type="button" class="lcp-diff-export" style="width:auto !important;height:auto !important;min-height:0 !important;max-height:32px !important;padding:3px 10px !important;line-height:22px !important;font-size:13px !important;flex:0 0 auto !important;"><i class="fas fa-file-export"></i> Export Both (JSON)</button>
            </div>
            <div class="lcp-diff-output" style="min-height:60px;overflow:auto;flex:1 1 auto;">
                <em>Pick two LCP files, then click Compare.</em>
            </div>
        `);
    }

    async _render(force, options) {
        await super._render(force, options);
        const root = this.element[0];
        if (!root || root.dataset.lcpDiffWired === "1")
            return;
        root.dataset.lcpDiffWired = "1";

        root.addEventListener("change", (e) => {
            const t = e.target;
            if (!(t instanceof HTMLInputElement) || t.type !== "file")
                return;
            if (t.classList.contains("lcp-diff-a"))
                this._pickedA = t.files?.[0] ?? null;
            else if (t.classList.contains("lcp-diff-b"))
                this._pickedB = t.files?.[0] ?? null;
        });

        root.addEventListener("click", async (e) => {
            const btn = e.target.closest("button");
            if (!btn || !root.contains(btn))
                return;
            e.preventDefault();
            e.stopPropagation();
            if (btn.classList.contains("lcp-diff-run-single"))
                await this._runCompareSingle();
            else if (btn.classList.contains("lcp-diff-run-sim"))
                await this._runCompare("simulated");
            else if (btn.classList.contains("lcp-diff-run"))
                await this._runCompare("parsed");
            else if (btn.classList.contains("lcp-diff-log"))
                this._logToConsole();
            else if (btn.classList.contains("lcp-diff-export"))
                this._exportBoth();
        });
    }

    _outEl() {
        return this.element[0]?.querySelector(".lcp-diff-output");
    }

    async _runCompare(mode = "parsed") {
        const out = this._outEl();
        if (!out)
            return;
        if (!this._pickedA || !this._pickedB) {
            out.innerHTML = '<span style="color:#d56565">Pick both files first.</span>';
            return;
        }
        const label = mode === "simulated" ? "Simulating import (no compendium write)…" : "Translating + parsing…";
        out.innerHTML = `<em>${label}</em>`;
        try {
            const a = await loadLcpAsBuckets(this._pickedA, mode);
            const b = await loadLcpAsBuckets(this._pickedB, mode);
            this._lastA = a;
            this._lastB = b;
            this._lastMode = mode;
            this._lastDiff = diffBuckets(a.buckets, b.buckets);
            out.innerHTML = renderDiffHtml(a.manifest, b.manifest, this._lastDiff, mode);
            console.log(`[lcp-debug-diff] result (${mode})`, { a, b, diff: this._lastDiff });
        } catch (e) {
            console.error("[lcp-debug-diff]", e);
            out.innerHTML = `<span style="color:#d56565">Error: ${escapeHtml(e.message)}</span>`;
        }
    }

    async _runCompareSingle() {
        const out = this._outEl();
        if (!out)
            return;
        const file = this._pickedA ?? this._pickedB;
        if (!file) {
            out.innerHTML = '<span style="color:#d56565">Pick at least one LCP (slot A) first.</span>';
            return;
        }
        out.innerHTML = `<em>Parsing then simulating import on ${escapeHtml(file.name)}…</em>`;
        try {
            const parsed = await parsePackOnly(file);
            const simulated = await simulateImport(file);
            this._lastA = parsed;
            this._lastB = simulated;
            this._lastMode = "single";
            this._lastDiff = diffBuckets(parsed.buckets, simulated.buckets);
            out.innerHTML = renderDiffHtml(parsed.manifest, simulated.manifest, this._lastDiff, "simulated");
            console.log("[lcp-debug-diff] single-file (parsed vs sim)", {
                file: file.name,
                parsed,
                simulated,
                diff: this._lastDiff
            });
        } catch (e) {
            console.error("[lcp-debug-diff]", e);
            out.innerHTML = `<span style="color:#d56565">Error: ${escapeHtml(e.message)}</span>`;
        }
    }

    _exportBoth() {
        if (!this._lastA || !this._lastB) {
            ui.notifications.warn("Run Compare first.");
            return;
        }
        const payload = {
            generatedAt: new Date().toISOString(),
            a: {
                fileName: this._pickedA?.name ?? null,
                manifest: this._lastA.manifest,
                buckets: this._lastA.buckets
            },
            b: {
                fileName: this._pickedB?.name ?? null,
                manifest: this._lastB.manifest,
                buckets: this._lastB.buckets
            },
            diff: this._lastDiff
        };
        const json = JSON.stringify(payload, null, 2);
        const baseA = (this._pickedA?.name ?? "a").replace(/\.lcp$/i, "");
        const baseB = (this._pickedB?.name ?? "b").replace(/\.lcp$/i, "");
        const filename = `lcp-diff_${baseA}__VS__${baseB}.json`;
        const save = globalThis.saveDataToFile ?? foundry.utils?.saveDataToFile;
        if (typeof save === "function") {
            save(json, "application/json", filename);
            ui.notifications.info(`Exported ${filename}`);
            return;
        }
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        ui.notifications.info(`Exported ${filename}`);
    }

    _logToConsole() {
        if (!this._lastDiff) {
            ui.notifications.warn("Run Compare first.");
            return;
        }
        console.log("[lcp-debug-diff] A", this._lastA);
        console.log("[lcp-debug-diff] B", this._lastB);
        console.log("[lcp-debug-diff] diff", this._lastDiff);
        ui.notifications.info("LCP diff dumped to console.");
    }
}

export async function openLcpDebugDiff() {
    new LcpDebugDiffApp().render(true);
}

export class LcpDebugDiffMenu extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "lcp-debug-diff-menu",
            template: "templates/sidebar/dialog.html",
            title: "LCP Debug Diff",
            popOut: false
        });
    }
    render(_force, _options) {
        openLcpDebugDiff();
        return this;
    }
    async close(_options) { return; }
    async _updateObject() {}
}

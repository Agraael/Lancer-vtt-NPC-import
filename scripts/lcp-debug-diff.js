const MODULE_ID = "lancer-npc-import";
const JSZIP_CDN = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm";

let _jszipPromise = null;
async function getJSZip() {
    if (globalThis.JSZip)
        return globalThis.JSZip;
    if (!_jszipPromise)
        _jszipPromise = import(JSZIP_CDN).then(m => m.default || m.JSZip || m);
    return _jszipPromise;
}

const BUCKETS = [
    "npc_classes", "npc_templates", "npc_features",
    "frames", "weapons", "systems", "mods",
    "pilot_gear", "skills", "talents", "bonds", "reserves",
    "tags", "statuses", "core_bonuses"
];

async function readZipBuckets(blob) {
    const JSZip = await getJSZip();
    const zip = await JSZip.loadAsync(blob);
    const manifest = await readJsonIfExists(zip, "lcp_manifest.json");
    const buckets = {};
    for (const name of BUCKETS) {
        const arr = await readJsonIfExists(zip, `${name}.json`);
        if (Array.isArray(arr))
            buckets[name] = arr;
    }
    return { manifest, buckets };
}

async function readJsonIfExists(zip, name) {
    const f = zip.file(name);
    if (!f)
        return null;
    try {
        return JSON.parse(await f.async("string"));
    } catch {
        return null;
    }
}

async function loadLcpAsBuckets(file) {
    const api = game.modules.get(MODULE_ID)?.api;
    const translate = api?.translateV3LcpBlob;
    if (typeof translate === "function") {
        const result = await translate(file);
        if (!result.summary?.alreadyV2 && result.blob)
            return readZipBuckets(result.blob);
    }
    return readZipBuckets(file);
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

function fieldDiff(a, b) {
    const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
    const diffs = [];
    for (const k of keys) {
        const sa = stableStringify(a?.[k]);
        const sb = stableStringify(b?.[k]);
        if (sa !== sb)
            diffs.push({ key: k, a: a?.[k], b: b?.[k] });
    }
    return diffs;
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
            if (stableStringify(va) === stableStringify(vb))
                continue;
            changed.push({ key: k, a: va, b: vb, fields: fieldDiff(va, vb) });
        }
        if (added.length || removed.length || changed.length || ma.size || mb.size) {
            out[bucket] = {
                countA: ma.size,
                countB: mb.size,
                added,
                removed,
                changed
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

function renderDiffHtml(manifestA, manifestB, diff) {
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
        const summary = `${bucket} (${info.countA} → ${info.countB}` +
            (hasChanges ? `, +${info.added.length} -${info.removed.length} ~${info.changed.length}` : ", identical") +
            `)`;

        const rows = [];
        for (const e of info.added)
            rows.push(`<li class="lcp-diff-row lcp-diff-row-add"><span class="lcp-diff-tag">ADDED</span><code>${escapeHtml(e.key)}</code> <span class="lcp-diff-name">${escapeHtml(e.item?.name ?? "")}</span></li>`);
        for (const e of info.removed)
            rows.push(`<li class="lcp-diff-row lcp-diff-row-rem"><span class="lcp-diff-tag">REMOVED</span><code>${escapeHtml(e.key)}</code> <span class="lcp-diff-name">${escapeHtml(e.item?.name ?? "")}</span></li>`);
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
                    <span class="lcp-diff-tag">CHANGED</span><code>${escapeHtml(e.key)}</code>
                    <span class="lcp-diff-name">${escapeHtml(e.b?.name ?? e.a?.name ?? "")}</span>
                    <ul class="lcp-diff-fields">${fields}${more}</ul>
                </li>
            `);
        }

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
                <button type="button" class="lcp-diff-run" style="width:auto !important;height:auto !important;min-height:0 !important;max-height:32px !important;padding:3px 10px !important;line-height:22px !important;font-size:13px !important;flex:0 0 auto !important;"><i class="fas fa-not-equal"></i> Compare</button>
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
            if (btn.classList.contains("lcp-diff-run"))
                await this._runCompare();
            else if (btn.classList.contains("lcp-diff-log"))
                this._logToConsole();
            else if (btn.classList.contains("lcp-diff-export"))
                this._exportBoth();
        });
    }

    _outEl() {
        return this.element[0]?.querySelector(".lcp-diff-output");
    }

    async _runCompare() {
        const out = this._outEl();
        if (!out)
            return;
        if (!this._pickedA || !this._pickedB) {
            out.innerHTML = '<span style="color:#d56565">Pick both files first.</span>';
            return;
        }
        out.innerHTML = "<em>Translating + parsing…</em>";
        try {
            const [a, b] = await Promise.all([
                loadLcpAsBuckets(this._pickedA),
                loadLcpAsBuckets(this._pickedB)
            ]);
            this._lastA = a;
            this._lastB = b;
            this._lastDiff = diffBuckets(a.buckets, b.buckets);
            out.innerHTML = renderDiffHtml(a.manifest, b.manifest, this._lastDiff);
            console.log("[lcp-debug-diff] result", { a, b, diff: this._lastDiff });
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

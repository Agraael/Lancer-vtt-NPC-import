import {
    CORS_PROXIES,
    getV3ApiBase,
    getV3ApiKey,
    getV3Cdn
} from "./v3-api.js";

async function testOne(proxy, v3Url, headers)
{
    const wrapped = proxy.wrap(v3Url);
    const out = { proxy: proxy.name, ok: false, status: null, body: "", parsed: null, error: null };
    try
    {
        const resp = await fetch(wrapped, { method: "GET", headers });
        out.status = resp.status;
        const text = await resp.text();
        out.body = text;
        try
        {
            out.parsed = JSON.parse(text);
            out.ok = resp.ok;
        }
        catch (e)
        {
            out.error = `non-JSON body: ${e.message}`;
        }
    }
    catch (e)
    {
        out.error = e.message;
    }
    return out;
}

async function fetchCdnFromEntry(entry)
{
    const uri = entry?.uri;
    if (!uri)
        return null;
    const url = `${getV3Cdn()}/${uri}?cb=${Date.now()}`;
    try
    {
        const resp = await fetch(url, { cache: "no-store" });
        const text = await resp.text();
        try
        {
            return { ok: resp.ok, status: resp.status, parsed: JSON.parse(text) };
        }
        catch (e)
        {
            return { ok: false, status: resp.status, error: `non-JSON: ${e.message}`, body: text.slice(0, 300) };
        }
    }
    catch (e)
    {
        return { ok: false, error: e.message };
    }
}

function escapeHtml(value)
{
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function copyBtn(label = "Copy JSON")
{
    return `<button type="button" class="sct-copy"><i class="fas fa-copy"></i> ${label}</button>`;
}

function renderProxyBlock(result)
{
    const cls = result.ok ? "ok" : "fail";
    const status = result.status === null ? "(no response)" : result.status;
    const jsonStr = result.parsed ? JSON.stringify(result.parsed, null, 2) : "";
    const detail = result.parsed
        ? `<pre class="sct-json" data-copy="${escapeHtml(jsonStr)}">${escapeHtml(jsonStr)}</pre>`
        : `<div class="sct-error">${escapeHtml(result.error || "")}</div>
           <details><summary>Raw body (first 500 chars)</summary><pre class="sct-raw">${escapeHtml(result.body.slice(0, 500))}</pre></details>`;
    return `
        <div class="sct-proxy sct-${cls}">
            <div class="sct-proxy-head">
                <strong>${escapeHtml(result.proxy)}</strong>
                <span class="sct-status">HTTP ${status}</span>
                <span class="sct-verdict">${result.ok ? "✓ JSON" : "✗"}</span>
                ${result.parsed ? copyBtn() : ""}
            </div>
            ${detail}
        </div>
    `;
}

function renderCdnBlock(cdn)
{
    if (!cdn)
        return "";
    if (cdn.parsed)
    {
        const jsonStr = JSON.stringify(cdn.parsed, null, 2);
        return `
            <div class="sct-cdn sct-ok">
                <div class="sct-proxy-head">
                    <strong>CDN payload</strong>
                    <span class="sct-status">HTTP ${cdn.status}</span>
                    ${copyBtn("Copy CDN JSON")}
                </div>
                <pre class="sct-json" data-copy="${escapeHtml(jsonStr)}">${escapeHtml(jsonStr)}</pre>
            </div>
        `;
    }
    return `
        <div class="sct-cdn sct-fail">
            <div class="sct-proxy-head"><strong>CDN payload</strong><span class="sct-status">HTTP ${cdn.status ?? "?"}</span></div>
            <div class="sct-error">${escapeHtml(cdn.error || "")}</div>
            ${cdn.body ? `<pre class="sct-raw">${escapeHtml(cdn.body)}</pre>` : ""}
        </div>
    `;
}

function wireCopyButtons(rootEl)
{
    rootEl.querySelectorAll(".sct-copy").forEach(btn =>
    {
        btn.addEventListener("click", async (ev) =>
        {
            ev.preventDefault();
            const head = btn.closest(".sct-proxy-head");
            const pre = head?.parentElement?.querySelector("pre.sct-json[data-copy]");
            const text = pre?.getAttribute("data-copy") || pre?.textContent || "";
            if (!text)
                return;
            try
            {
                await navigator.clipboard.writeText(text);
                const orig = btn.innerHTML;
                btn.innerHTML = '<i class="fas fa-check"></i> Copied';
                setTimeout(() => { btn.innerHTML = orig; }, 1200);
            }
            catch (e)
            {
                console.warn("[share-code-test] clipboard write failed:", e);
                ui.notifications?.warn("Copy failed - select the JSON manually");
            }
        });
    });
}

async function testDirect(url, headers)
{
    const out = { proxy: "direct (no proxy)", ok: false, status: null, body: "", parsed: null, error: null };
    try
    {
        const resp = await fetch(url, { method: "GET", headers, cache: "no-store" });
        out.status = resp.status;
        const text = await resp.text();
        out.body = text;
        try { out.parsed = JSON.parse(text); out.ok = resp.ok; }
        catch (e) { out.error = `non-JSON body: ${e.message}`; }
    }
    catch (e)
    {
        out.error = e.message;
    }
    return out;
}

async function runTest(html, code)
{
    const out = html.querySelector(".sct-output");
    out.innerHTML = `<div class="sct-info">Testing share code "${escapeHtml(code)}" (direct + ${CORS_PROXIES.length} proxies)...</div>`;

    const v3Url = `${getV3ApiBase()}/code?scope=item&codes=${encodeURIComponent(JSON.stringify([code]))}&_=${Date.now()}`;
    const headers = { "Content-Type": "application/json", "x-api-key": getV3ApiKey() };

    const directResult = await testDirect(v3Url, headers);

    const results = [directResult];
    for (const proxy of CORS_PROXIES)
        results.push(await testOne(proxy, v3Url, headers));

    const successful = results.find(result => result.ok && result.parsed);
    let cdnBlock = "";
    if (successful)
    {
        const entry = Array.isArray(successful.parsed) ? successful.parsed[0] : successful.parsed;
        if (entry?.uri)
        {
            const cdn = await fetchCdnFromEntry(entry);
            cdnBlock = renderCdnBlock(cdn);
        }
    }

    out.innerHTML = `
        <div class="sct-summary">
            ${successful ? `<span class="sct-ok-pill">✓ ${escapeHtml(successful.proxy)} returned valid JSON</span>` : `<span class="sct-fail-pill">✗ Nothing returned valid JSON</span>`}
        </div>
        ${results.map(renderProxyBlock).join("")}
        ${cdnBlock}
    `;
    wireCopyButtons(out);
}

export function openShareCodeTest()
{
    const content = `
        <div class="sct-root">
            <p class="sct-hint">Tests a share code against each CORS proxy. Shows raw responses and identifies which (if any) returns valid JSON.</p>
            <div class="sct-input-row">
                <input type="text" class="sct-code" placeholder="Share code (e.g. G36W4ET5XGAV)" maxlength="32">
                <button type="button" class="sct-go">Test</button>
            </div>
            <div class="sct-output"></div>
        </div>
    `;
    const dlg = new Dialog({
        title: "Share Code Test",
        content,
        buttons: {
            close: { icon: '<i class="fas fa-times"></i>', label: "Close" }
        },
        default: "close",
        render: html =>
        {
            const root = html instanceof HTMLElement ? html : html[0];
            const input = root.querySelector(".sct-code");
            const go = root.querySelector(".sct-go");
            const fire = () =>
            {
                const code = (input.value || "").trim().toUpperCase();
                if (!code)
                    return;
                runTest(root, code);
            };
            go.addEventListener("click", ev => { ev.preventDefault(); fire(); });
            input.addEventListener("keydown", ev => { if (ev.key === "Enter") { ev.preventDefault(); fire(); } });
            input.focus();
        }
    }, {
        width: 720,
        height: 600,
        resizable: true,
        classes: ["lancer-share-code-test", "lancer-dialog-base", "lancer-no-title"]
    });
    dlg.render(true);
}

export class ShareCodeTestMenu extends FormApplication
{
    static get defaultOptions()
    {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "share-code-test-menu",
            template: "templates/sidebar/dialog.html",
            title: "Share Code Test",
            popOut: false
        });
    }
    render(_force, _options)
    {
        openShareCodeTest();
        return this;
    }
    async close(_options) { return; }
    async _updateObject() {}
}

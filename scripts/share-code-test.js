import {
    CORS_PROXIES,
    getV3ApiBase,
    getV3ApiKey,
    getV3Cdn,
    getJwtTokenFromV5Auth
} from "./v3-api.js";

async function testOne(proxy, v3Url, headers) {
    const wrapped = proxy.wrap(v3Url);
    const out = { proxy: proxy.name, ok: false, status: null, body: "", parsed: null, error: null };
    try {
        const resp = await fetch(wrapped, { method: "GET", headers });
        out.status = resp.status;
        const text = await resp.text();
        out.body = text;
        try {
            out.parsed = JSON.parse(text);
            out.ok = resp.ok;
        } catch (e) {
            out.error = `non-JSON body: ${e.message}`;
        }
    } catch (e) {
        out.error = e.message;
    }
    return out;
}

async function fetchCdnFromEntry(entry) {
    const uri = entry?.uri;
    if (!uri) return null;
    const url = `${getV3Cdn()}/${uri}`;
    try {
        const resp = await fetch(url);
        const text = await resp.text();
        try {
            return { ok: resp.ok, status: resp.status, parsed: JSON.parse(text) };
        } catch (e) {
            return { ok: false, status: resp.status, error: `non-JSON: ${e.message}`, body: text.slice(0, 300) };
        }
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function escapeHtml(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function renderProxyBlock(result) {
    const cls = result.ok ? "ok" : "fail";
    const status = result.status === null ? "(no response)" : result.status;
    const detail = result.parsed
        ? `<pre class="sct-json">${escapeHtml(JSON.stringify(result.parsed, null, 2))}</pre>`
        : `<div class="sct-error">${escapeHtml(result.error || "")}</div>
           <details><summary>Raw body (first 500 chars)</summary><pre class="sct-raw">${escapeHtml(result.body.slice(0, 500))}</pre></details>`;
    return `
        <div class="sct-proxy sct-${cls}">
            <div class="sct-proxy-head">
                <strong>${escapeHtml(result.proxy)}</strong>
                <span class="sct-status">HTTP ${status}</span>
                <span class="sct-verdict">${result.ok ? "✓ JSON" : "✗"}</span>
            </div>
            ${detail}
        </div>
    `;
}

function renderCdnBlock(cdn) {
    if (!cdn) return "";
    if (cdn.parsed) {
        return `
            <div class="sct-cdn sct-ok">
                <div class="sct-proxy-head"><strong>CDN payload</strong><span class="sct-status">HTTP ${cdn.status}</span></div>
                <pre class="sct-json">${escapeHtml(JSON.stringify(cdn.parsed, null, 2))}</pre>
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

async function runTest(html, code) {
    const out = html.querySelector(".sct-output");
    out.innerHTML = `<div class="sct-info">Querying ${CORS_PROXIES.length} proxies for share code "${escapeHtml(code)}"...</div>`;

    const v3Url = `${getV3ApiBase()}/code?scope=item&codes=${encodeURIComponent(JSON.stringify([code]))}`;
    const headers = { "Content-Type": "application/json", "x-api-key": getV3ApiKey() };
    try {
        const jwt = await getJwtTokenFromV5Auth();
        if (jwt) headers["Authorization"] = jwt;
    } catch { /* not signed in */ }

    const results = [];
    for (const p of CORS_PROXIES) {
        results.push(await testOne(p, v3Url, headers));
    }

    const successful = results.find(r => r.ok && r.parsed);
    let cdnBlock = "";
    if (successful) {
        const entry = Array.isArray(successful.parsed) ? successful.parsed[0] : successful.parsed;
        if (entry?.uri) {
            const cdn = await fetchCdnFromEntry(entry);
            cdnBlock = renderCdnBlock(cdn);
        }
    }

    out.innerHTML = `
        <div class="sct-summary">
            ${successful ? `<span class="sct-ok-pill">✓ ${escapeHtml(successful.proxy)} returned valid JSON</span>` : `<span class="sct-fail-pill">✗ No proxy returned valid JSON</span>`}
        </div>
        ${results.map(renderProxyBlock).join("")}
        ${cdnBlock}
    `;
}

export function openShareCodeTest() {
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
        render: html => {
            const root = html instanceof HTMLElement ? html : html[0];
            const input = root.querySelector(".sct-code");
            const go = root.querySelector(".sct-go");
            const fire = () => {
                const code = (input.value || "").trim().toUpperCase();
                if (!code) return;
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

export class ShareCodeTestMenu extends FormApplication {
    static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
            id: "share-code-test-menu",
            template: "templates/sidebar/dialog.html",
            title: "Share Code Test",
            popOut: false
        });
    }
    render(_force, _options) {
        openShareCodeTest();
        return this;
    }
    async close(_options) { return; }
    async _updateObject() {}
}

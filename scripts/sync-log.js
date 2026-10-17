import { escapeHtml } from "./utils.js";

const DRAWER_WIDTH = 300;
const MARKS = {
    queued: "fa-clock",
    running: "fa-rotate fa-spin",
    ok: "fa-check",
    same: "fa-minus",
    warn: "fa-circle-exclamation",
    fail: "fa-xmark"
};
const MARK_LABELS = { queued: "Queued", running: "Running", ok: "Done", same: "No changes", warn: "Done with warnings", fail: "Failed" };

function _clock()
{
    const now = new Date();
    return [now.getHours(), now.getMinutes(), now.getSeconds()].map(part => String(part).padStart(2, "0")).join(":");
}

function _finished(entry)
{
    return entry.status !== "queued" && entry.status !== "running";
}

function _runMarkHtml(status)
{
    return MARKS[status] ? `<i class="cc-run fas ${MARKS[status]}" title="${MARK_LABELS[status]}"></i>` : "";
}

export function setRunMark($rows, status)
{
    $rows.attr("data-run", status || null).find(".cc-run").remove();
    $rows.find(".cc-dot").after(_runMarkHtml(status));
}

export class SyncLog
{
    constructor(title, subtitle = "")
    {
        this.title = title;
        this.subtitle = subtitle;
        this.entries = [];
        this.current = -1;
        this.summary = "";
        this.listeners = new Set();
    }

    subscribe(listener)
    {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    _emit(index = -1)
    {
        for (const listener of this.listeners)
            listener(this, index);
    }

    get progress()
    {
        const total = this.entries.length;
        const done = this.entries.filter(_finished).length;
        return { done, total, percent: total ? Math.round((done / total) * 100) : 0 };
    }

    start(items)
    {
        this.entries = items.map(item => ({ name: item.name, meta: item.meta || "", status: "queued", result: "Queued", time: "", lines: [] }));
        this.current = -1;
        this.summary = "";
        this._emit();
    }

    begin(index, result)
    {
        const entry = this.entries[index];
        if (!entry)
            return;
        this.current = index;
        Object.assign(entry, { status: "running", result, time: _clock() });
        this._emit(index);
    }

    addLog(message, type = "info")
    {
        const entry = this.entries[this.current];
        if (!entry)
            return;
        entry.lines.push({ text: String(message), warn: type === "warning" || type === "error" });
        this._emit(this.current);
    }

    finish(index, status, result)
    {
        const entry = this.entries[index];
        if (!entry)
            return;
        entry.status = status === "ok" && entry.lines.some(line => line.warn) ? "warn" : status;
        entry.result = result;
        this._emit(index);
    }

    complete(counts)
    {
        const parts = Object.entries(counts).filter(([, count]) => count > 0).map(([label, count]) => `${count} ${label}`);
        this.summary = ["Done", ...parts].join(" · ");
        this.current = -1;
        this._emit();
    }

    html({ closable = false } = {})
    {
        const { done, total, percent } = this.progress;
        const counts = { ok: 0, warn: 0, fail: 0 };
        for (const entry of this.entries)
        {
            if (entry.status === "ok" || entry.status === "same")
                counts.ok++;
            else if (entry.status === "warn" || entry.status === "fail")
                counts[entry.status]++;
        }
        const rows = this.entries.map(entry => `
            <div class="cc-log-entry" data-status="${entry.status}">
                <i class="cc-log-mark fas ${MARKS[entry.status]}"></i>
                <div class="cc-log-body">
                    <div class="cc-log-top"><span class="cc-log-name">${escapeHtml(entry.name)}</span><span class="cc-log-time">${entry.time}</span></div>
                    ${entry.meta ? `<div class="cc-log-meta">${escapeHtml(entry.meta)}</div>` : ""}
                    <div class="cc-log-result">${escapeHtml(entry.result)}</div>
                    ${entry.lines.map(line => `<div class="cc-log-line${line.warn ? " cc-log-warn" : ""}">${line.warn ? `<i class="fas fa-circle-exclamation"></i>` : ""}<span>${escapeHtml(line.text)}</span></div>`).join("")}
                </div>
            </div>`).join("");
        return `
            <div class="cc-log">
                ${_headHtml(this.title, this.subtitle, closable)}
                <div class="cc-log-bar${done < total ? " cc-busy" : ""}"><span style="width: ${percent}%"></span></div>
                <div class="cc-log-counts">
                    <span class="cc-log-n">${done} / ${total}</span>
                    <span class="cc-log-count" data-status="ok"><i class="fas fa-check"></i> ${counts.ok}</span>
                    ${counts.warn ? `<span class="cc-log-count" data-status="warn"><i class="fas fa-circle-exclamation"></i> ${counts.warn}</span>` : ""}
                    ${counts.fail ? `<span class="cc-log-count" data-status="fail"><i class="fas fa-xmark"></i> ${counts.fail}</span>` : ""}
                </div>
                <div class="cc-log-list">${rows}</div>
                ${this.summary ? `<div class="cc-log-foot">${escapeHtml(this.summary)}</div>` : ""}
            </div>`;
    }
}

function _headHtml(title, subtitle, closable)
{
    return `
        <div class="cc-log-head">
            <span class="cc-log-title">${escapeHtml(title)}</span>
            <span class="cc-log-sub">${escapeHtml(subtitle)}</span>
            ${closable ? `<a class="cc-log-close" data-action="close-log" title="Close"><i class="fas fa-xmark"></i></a>` : ""}
        </div>`;
}

function _paint(host, log, options)
{
    const previous = host.querySelector(".cc-log-list")?.scrollTop ?? 0;
    host.innerHTML = log
        ? log.html(options)
        : `<div class="cc-log">${_headHtml("Log", "", options.closable)}<div class="cc-log-list"><div class="cc-log-empty">No import or export yet.</div></div></div>`;
    const list = host.querySelector(".cc-log-list");
    if (!list)
        return;
    list.scrollTop = previous;
    const active = list.querySelector(".cc-log-entry[data-status='running']");
    if (!active)
        return;
    const bottom = active.offsetTop + active.offsetHeight;
    if (active.offsetTop < list.scrollTop || bottom > list.scrollTop + list.clientHeight)
        list.scrollTop = bottom - list.clientHeight + 4;
}

export function windowLog(title, subtitle)
{
    const log = new SyncLog(title, subtitle);
    const paintInto = root =>
    {
        const host = root?.find(".cc-log-host")[0];
        if (host)
            _paint(host, log, {});
    };
    let unsubscribe = null;
    const dialog = new Dialog({
        title,
        content: `<div class="cc-log-host"></div>`,
        buttons: {
            close: { icon: '<i class="fas fa-check"></i>', label: "Close" }
        },
        default: "close",
        render: paintInto,
        close: () => unsubscribe?.()
    }, {
        width: 340,
        height: 560,
        resizable: true,
        classes: ["cc-log-window", "lancer-dialog-base", "lancer-no-title"]
    });
    unsubscribe = log.subscribe(() => paintInto(dialog.element));
    dialog.render(true);
    return log;
}

export class LogDrawer
{
    constructor(app)
    {
        this.app = app;
        this.log = null;
        this.element = null;
        this.observer = null;
        this.isOpen = false;
        this.unsubscribe = null;
        this.onResize = () => this.place();
    }

    _ensure()
    {
        if (this.element)
            return this.element;
        const element = document.createElement("div");
        element.className = "cc-log-drawer lancer-dialog-base";
        element.addEventListener("pointerdown", event =>
        {
            if (event.button === 0 && event.target.closest("[data-action='close-log']"))
            {
                this.hide();
                return;
            }
            this.app.bringToTop?.();
        });
        const appElement = this.app.element?.[0];
        if (appElement)
            appElement.before(element);
        else
            document.body.append(element);
        this.element = element;
        this.render();
        return element;
    }

    attach(log)
    {
        this.unsubscribe?.();
        this.log = log;
        this.unsubscribe = log.subscribe(() => this.render());
        this.render();
    }

    render()
    {
        if (this.element)
            _paint(this.element, this.log, { closable: true });
    }

    place()
    {
        const element = this.element;
        const appElement = this.app.element?.[0];
        if (!element || !appElement)
            return;
        const rect = appElement.getBoundingClientRect();
        const openLeft = rect.right + DRAWER_WIDTH + 12 > window.innerWidth && rect.left - DRAWER_WIDTH - 12 >= 0;
        const appZ = Number.parseInt(getComputedStyle(appElement).zIndex, 10);
        const flip = element.classList.contains("cc-left") !== openLeft && !element.classList.contains("cc-open");
        if (flip)
            element.style.transition = "none";
        element.classList.toggle("cc-left", openLeft);
        if (flip)
        {
            element.getBoundingClientRect();
            element.style.transition = "";
        }
        element.classList.toggle("cc-hidden", this.app._minimized !== false || !appElement.isConnected);
        Object.assign(element.style, {
            top: `${rect.top + 14}px`,
            left: `${openLeft ? rect.left - DRAWER_WIDTH + 6 : rect.right - 6}px`,
            width: `${DRAWER_WIDTH}px`,
            height: `${Math.max(0, rect.height - 28)}px`,
            zIndex: String(Number.isFinite(appZ) ? appZ : 99)
        });
    }

    show()
    {
        const element = this._ensure();
        if (this.isOpen)
            return;
        this.isOpen = true;
        this.app.bringToTop?.();
        this.place();
        element.getBoundingClientRect();
        element.classList.add("cc-open");
        this.app.element?.find(".cc-log-toggle").addClass("cc-on");
        const appElement = this.app.element?.[0];
        if (appElement)
        {
            this.observer = new MutationObserver(() => this.place());
            this.observer.observe(appElement, { attributes: true, attributeFilter: ["style", "class"] });
        }
        window.addEventListener("resize", this.onResize);
    }

    hide()
    {
        this.isOpen = false;
        this.element?.classList.remove("cc-open");
        this.app.element?.find(".cc-log-toggle").removeClass("cc-on");
        this.observer?.disconnect();
        this.observer = null;
        window.removeEventListener("resize", this.onResize);
    }

    toggle()
    {
        if (this.isOpen)
            this.hide();
        else
            this.show();
    }

    destroy()
    {
        this.hide();
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.element?.remove();
        this.element = null;
    }
}

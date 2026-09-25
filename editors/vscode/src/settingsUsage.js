// The existing chat usage ledger renderer, now hosted in editor settings.
export function createUsage(root, vscode) {
    const $ = id => root.querySelector("#" + id);
    const USAGE_RANGES = ["today", "7d", "30d", "month", "all"];
    const USAGE_TIMEOUT_MS = 15000;
    let usageRequestId = "", usageSequence = 0, usageTimer = 0, usageHasData = false;
    let usageBuckets = [], usageDay = -1;
    const usageSection = () => root;
    const usageCount = (value) => {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
    };
    const usageExact = (value) => usageCount(value).toLocaleString();
    function usageCompact(value) {
        const n = usageCount(value);
        const scaled = (unit, suffix) => {
            const v = n / unit;
            return (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, "")) + suffix;
        };
        if (n >= 1e9)
            return scaled(1e9, "B");
        if (n >= 1e6)
            return scaled(1e6, "M");
        if (n >= 1e4)
            return scaled(1e3, "K");
        return n.toLocaleString();
    }
    function usageNode(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls)
            node.className = cls;
        if (text !== undefined)
            node.textContent = text;
        return node;
    }
    function usageDate(iso, withYear) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
        if (!match)
            return String(iso || "");
        const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
        return date.toLocaleDateString(undefined, withYear
            ? { year: "numeric", month: "short", day: "numeric" } : { month: "short", day: "numeric" });
    }
    function setUsageStatus(text, busy) {
        $("usage-status").textContent = text;
        const section = usageSection();
        if (busy)
            section.setAttribute("aria-busy", "true");
        else
            section.removeAttribute("aria-busy");
    }
    function requestUsage() {
        const select = $("usage-range");
        const range = USAGE_RANGES.includes(select.value) ? select.value : "7d";
        usageRequestId = `usage-${Date.now().toString(36)}-${++usageSequence}`;
        const requestId = usageRequestId;
        setUsageStatus(usageHasData ? "Refreshing\u2026" : "Counting\u2026", true);
        clearTimeout(usageTimer);
        usageTimer = setTimeout(() => {
            if (requestId !== usageRequestId)
                return;
            setUsageStatus("No answer from the DGC backend yet. Try Refresh.", false);
        }, USAGE_TIMEOUT_MS);
        vscode.postMessage({ type: "getUsage", range, requestId });
    }
    function usageUnavailable(msg) {
        if (msg.requestId && msg.requestId !== usageRequestId)
            return;
        clearTimeout(usageTimer);
        usageHasData = false;
        $("usage-content").hidden = true;
        $("usage-empty").hidden = true;
        setUsageStatus(String(msg.message || "Token usage is unavailable."), false);
    }
    // A long id keeps the part that tells variants apart: the ":tag"/quantisation or "-suffix" of
    // a model, the ":port" of a host. The head truncates with an ellipsis; the tail always shows.
    function usageSplit(text, kind) {
        const value = String(text || "");
        let cut = -1;
        if (kind === "host") {
            const port = /:\d{1,5}$/.exec(value);
            if (port)
                cut = port.index;
        }
        else if (kind === "model" && value.length > 14) {
            const colon = value.lastIndexOf(":");
            const dash = value.lastIndexOf("-");
            if (colon > 0 && value.length - colon <= 14)
                cut = colon;
            else if (dash > 0 && value.length - dash <= 10)
                cut = dash;
            else
                cut = value.length - 8;
        }
        const line = usageNode("span", kind === "model" ? "usage-clip usage-name" : "usage-clip usage-where");
        if (cut <= 0) {
            line.appendChild(usageNode("span", "usage-head", value));
        }
        else {
            line.appendChild(usageNode("span", "usage-head", value.slice(0, cut)));
            line.appendChild(usageNode("span", "usage-tail", value.slice(cut)));
        }
        return line;
    }
    // A box that scrolls sideways says so: its hidden edge fades while there is more to see.
    function usageEdges(node) {
        if (!node)
            return;
        const more = node.scrollWidth - node.clientWidth;
        node.classList.toggle("more-right", more > 1 && node.scrollLeft < more - 1);
        node.classList.toggle("more-left", more > 1 && node.scrollLeft > 1);
    }
    function renderUsage(ev) {
        if (!ev || ev.request_id !== usageRequestId)
            return; // a late answer to an older request
        clearTimeout(usageTimer);
        const totals = ev.totals && typeof ev.totals === "object" ? ev.totals : {};
        const models = (Array.isArray(ev.by_model) ? ev.by_model : [])
            .filter((row) => row && typeof row === "object").slice(0, 100);
        const days = (Array.isArray(ev.by_day) ? ev.by_day : [])
            .filter((row) => row && typeof row === "object" && /^\d{4}-\d{2}-\d{2}$/.test(String(row.date)))
            .slice(-401);
        const zone = String(ev.timezone || "").slice(0, 64);
        $("usage-timezone").textContent = `Days follow this computer’s local time${zone ? ` (${zone})` : ""}.`;
        const stamp = new Date(String(ev.generated_at || ""));
        const updated = Number.isNaN(stamp.getTime()) ? "Updated just now"
            : `Updated ${stamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
        if (ev.error) {
            usageHasData = false;
            $("usage-content").hidden = true;
            $("usage-empty").hidden = true;
            setUsageStatus(`The usage ledger could not be read: ${String(ev.error).slice(0, 300)}`, false);
            return;
        }
        const requests = usageCount(totals.requests);
        usageHasData = requests > 0;
        $("usage-empty").hidden = usageHasData;
        $("usage-empty-all").hidden = usageHasData || $("usage-range").value === "all";
        $("usage-content").hidden = !usageHasData;
        setUsageStatus(updated, false);
        if (!usageHasData) {
            usageBuckets = [];
            $("usage-strip-in").replaceChildren();
            $("usage-strip-out").replaceChildren();
            return;
        }
        const figures = $("usage-figures");
        figures.replaceChildren();
        for (const [label, key, unit] of [["Input", "input_tokens", "tokens"],
            ["Output", "output_tokens", "tokens"], ["Cached input", "cached_input_tokens", "tokens"],
            ["Requests", "requests", "requests"]]) {
            const figure = usageNode("div", "usage-figure");
            const exact = usageExact(totals[key]);
            const compact = usageCompact(totals[key]);
            figure.setAttribute("role", "group");
            figure.setAttribute("aria-label", `${label}: ${exact} ${unit}`);
            figure.appendChild(usageNode("span", "usage-figure-label", label));
            figure.appendChild(usageNode("span", "usage-figure-value", compact));
            // The exact count earns its line only when the big figure is abbreviated.
            if (compact !== exact)
                figure.appendChild(usageNode("span", "usage-figure-exact", `${exact} ${unit}`));
            figures.appendChild(figure);
        }
        const unmetered = usageCount(totals.unmetered_requests);
        const unmeteredNote = $("usage-unmetered");
        unmeteredNote.hidden = unmetered === 0;
        unmeteredNote.textContent = unmetered === 0 ? ""
            : unmetered === 1
                ? "1 unmetered request ended without a usage report (cancelled, interrupted, or the "
                    + "provider sent none), so its tokens are not in these totals."
                : `${unmetered.toLocaleString()} unmetered requests ended without a usage report `
                    + "(cancelled, interrupted, or the provider sent none), so their tokens are not in these totals.";
        const body = $("usage-models");
        body.replaceChildren();
        const tokensOf = (row) => usageCount(row.input_tokens) + usageCount(row.output_tokens);
        const tokenSum = models.reduce((sum, row) => sum + tokensOf(row), 0);
        const requestSum = models.reduce((sum, row) => sum + usageCount(row.requests), 0);
        for (const row of models) {
            const tr = document.createElement("tr");
            const model = String(row.model || "unknown").slice(0, 256);
            const provider = String(row.provider || "").slice(0, 64);
            const host = String(row.host || "").slice(0, 255);
            const where = [provider, host].filter(Boolean).join(" · ");
            const modelCell = usageNode("th", "usage-model");
            modelCell.setAttribute("scope", "row");
            modelCell.title = where ? `${model}\n${where}` : model;
            modelCell.appendChild(usageSplit(model, "model"));
            modelCell.appendChild(usageSplit(where || "—", host ? "host" : "where"));
            tr.appendChild(modelCell);
            for (const key of ["input_tokens", "output_tokens", "cached_input_tokens", "requests"]) {
                tr.appendChild(usageNode("td", "num", usageExact(row[key])));
            }
            const share = tokenSum > 0 ? tokensOf(row) / tokenSum
                : (requestSum > 0 ? usageCount(row.requests) / requestSum : 0);
            const percent = share * 100;
            const shareText = percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
            const shareCell = usageNode("td", "usage-share-cell");
            const wrap = usageNode("span", "usage-share");
            wrap.setAttribute("role", "img");
            wrap.setAttribute("aria-label", `${shareText} of ${tokenSum > 0 ? "tokens" : "requests"}`);
            const track = usageNode("span", "usage-share-track");
            const fill = usageNode("span", "usage-share-fill" + (percent > 0 ? " nonzero" : ""));
            fill.style.width = `${Math.min(100, percent)}%`;
            track.appendChild(fill);
            wrap.appendChild(track);
            wrap.appendChild(usageNode("span", "usage-share-text", shareText));
            shareCell.appendChild(wrap);
            tr.appendChild(shareCell);
            body.appendChild(tr);
        }
        usageEdges(root.querySelector(".usage-table-wrap"));
        // One column per local day (weeks past 62 days), drawn as two strips on their own scales:
        // a coding agent reads far more than it writes, so output on the input scale would be a
        // sliver whatever its size. Each strip names its own peak.
        const weekly = days.length > 62;
        usageBuckets = [];
        for (let i = 0; i < days.length; i += weekly ? 7 : 1) {
            const slice = days.slice(i, i + (weekly ? 7 : 1));
            usageBuckets.push({
                first: slice[0].date, last: slice[slice.length - 1].date,
                input: slice.reduce((sum, day) => sum + usageCount(day.input_tokens), 0),
                output: slice.reduce((sum, day) => sum + usageCount(day.output_tokens), 0),
                requests: slice.reduce((sum, day) => sum + usageCount(day.requests), 0),
            });
        }
        const crossesYear = days.length > 0 && days[0].date.slice(0, 4) !== days[days.length - 1].date.slice(0, 4);
        const label = (bucket) => weekly
            ? `Week of ${usageDate(bucket.first, crossesYear)}` : usageDate(bucket.first, crossesYear);
        usageBuckets.forEach((bucket) => { bucket.label = label(bucket); });
        // A single day has nothing to compare: the figures above already are that day.
        const single = usageBuckets.length <= 1;
        $("usage-days").hidden = single;
        const strips = [["usage-strip-in", "input", "usage-in", "usage-peak-in"],
            ["usage-strip-out", "output", "usage-out", "usage-peak-out"]];
        for (const [id, key, cls, peakId] of strips) {
            const strip = $(id);
            strip.replaceChildren();
            strip.classList.toggle("dense", usageBuckets.length > 40);
            const peak = Math.max(0, ...usageBuckets.map((bucket) => bucket[key]));
            $(peakId).textContent = peak > 0 ? `peak ${usageCompact(peak)}` : "none";
            usageBuckets.forEach((bucket, index) => {
                const column = usageNode("div", "usage-day");
                column.dataset.index = String(index);
                if (bucket[key] > 0) {
                    const bar = usageNode("span", `usage-bar ${cls}`);
                    bar.style.height = `${(bucket[key] / peak) * 100}%`;
                    column.appendChild(bar);
                }
                else if (key === "input" && bucket.requests) {
                    column.appendChild(usageNode("span", "usage-bar usage-unmetered-day"));
                }
                column.addEventListener("mouseenter", () => selectUsageDay(index));
                strip.appendChild(column);
            });
        }
        $("usage-days-first").textContent = usageBuckets.length ? label(usageBuckets[0]) : "";
        $("usage-days-last").textContent = usageBuckets.length > 1 ? label(usageBuckets[usageBuckets.length - 1]) : "";
        $("usage-days").setAttribute("aria-label", `Input and output tokens per ${weekly ? "week" : "day"}, `
            + `${usageBuckets.length} ${weekly ? "weeks" : "days"}. Use the arrow keys to read each one.`);
        let busiest = usageBuckets.length - 1;
        usageBuckets.forEach((bucket, index) => {
            if (bucket.input + bucket.output > usageBuckets[busiest].input + usageBuckets[busiest].output)
                busiest = index;
        });
        selectUsageDay(busiest, true);
    }
    function selectUsageDay(index, initial) {
        if (!usageBuckets.length)
            return;
        usageDay = Math.max(0, Math.min(usageBuckets.length - 1, index));
        const bucket = usageBuckets[usageDay];
        $("usage-days").querySelectorAll(".usage-day").forEach((column) => {
            column.classList.toggle("sel", Number(column.dataset.index) === usageDay);
        });
        const text = `${bucket.label}: ${bucket.input.toLocaleString()} input · `
            + `${bucket.output.toLocaleString()} output tokens · ${bucket.requests.toLocaleString()} `
            + `request${bucket.requests === 1 ? "" : "s"}`;
        $("usage-day-readout").textContent = (initial && usageBuckets.length > 1 ? "Busiest — " : "") + text;
    }
    $("usage-days").addEventListener("keydown", (e) => {
        if (!usageBuckets.length)
            return;
        const moves = { ArrowLeft: usageDay - 1, ArrowRight: usageDay + 1, Home: 0, End: usageBuckets.length - 1 };
        if (!(e.key in moves))
            return;
        e.preventDefault();
        selectUsageDay(moves[e.key]);
    });
    $("usage-range").onchange = requestUsage;
    $("usage-refresh").onclick = requestUsage;
    $("usage-show-all").onclick = () => { $("usage-range").value = "all"; requestUsage(); };
    root.querySelector(".usage-table-wrap").addEventListener("scroll", (e) => usageEdges(e.currentTarget), { passive: true });
    const settingsNav = root.querySelector(".settings-nav");
    if (settingsNav)
        settingsNav.addEventListener("scroll", () => usageEdges(settingsNav), { passive: true });
    const resized = () => {
        usageEdges(settingsNav);
        usageEdges(root.querySelector(".usage-table-wrap"));
    };
    window.addEventListener("resize", resized);
    return { request: requestUsage, receive: renderUsage, unavailable: usageUnavailable, dispose() { clearTimeout(usageTimer); window.removeEventListener("resize", resized); } };
}

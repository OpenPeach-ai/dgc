// The settings pages DGC saves with one Save (General, Models, Agents, Web search, ChatDGC, Security), drawn with the
// page grammar settings.css gives every page: a title and one line, groups of rows, one-line hints with detail
// behind "?", detail one click away (Advanced, Another host), and one Save at the foot that covers every page.
/** The keep-loaded choices, with a value set elsewhere (the CLI, config.json) kept as it is. */
function keepAliveChoices(current) {
    const value = String(current ?? "30m");
    return KEEP_ALIVE_CHOICES.some(([v]) => v === value) ? KEEP_ALIVE_CHOICES : KEEP_ALIVE_CHOICES.concat([[value, value]]);
}
/** What "Run at once" does, which is not the same number in both profiles: Ultra widens only a width still equal to
 *  the shipped default; any number you set is honoured exactly, including 1. One line, and what more costs behind
 *  "?" (each sub-agent is its own copy of the project, cloud APIs rate-limit, a local Ollama queues the rest). */
export function parallelHint(c) {
    const pinned = Number(c.max_parallel_tasks ?? 4) !== 4;
    if (c.ultra_mode !== true) return "Up to 32. Ultra runs 8 unless you set one.";
    return pinned ? "Pinned here; Ultra would run 8." : "Ultra is on, so 8 run.";
}
export function parallelMore(c) {
    const pinned = Number(c.max_parallel_tasks ?? 4) !== 4;
    const ultra = c.ultra_mode !== true ? "1 runs them one at a time."
        : pinned ? "Set 4 to let Ultra choose." : "Set any other number, up to 32, to pin it.";
    return `${ultra} More costs more: each one is its own copy of the project, cloud APIs rate-limit, and a local `
        + "Ollama runs only its OLLAMA_NUM_PARALLEL at once while the rest wait.";
}
// Remembered across redraws: which "Advanced" and "Another host" disclosures are open.
const OPEN = new Set();
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

// Ollama's keep_alive values Settings offers, in plain words. "" sends none (Ollama's own default, 5 minutes).
export const KEEP_ALIVE_CHOICES = [["5m", "5 minutes"], ["15m", "15 minutes"], ["30m", "30 minutes"], ["1h", "1 hour"],
    ["4h", "4 hours"], ["24h", "24 hours"], ["-1", "Until Ollama stops"], ["", "Ollama's default (5 minutes)"]];
/** A host that is Ollama on this computer or this network: where keeping the model loaded is DGC's to choose.
 *  An Ollama cloud model (…:cloud) is never loaded here, so it has nothing to keep. */
export function localOllama(c) {
    const url = String(c.base_url || "").trim();
    let host = "", port = "";
    try { const parsed = new URL(url); host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""); port = parsed.port; }
    catch { return false; }
    const ollama = c.api_mode === "ollama" || port === "11434" || /ollama/i.test(url);
    const near = host === "localhost" || host === "::1" || host === "0.0.0.0" || host.endsWith(".local")
        || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host);
    return ollama && near;
}

// How to change a server's window: where it starts, with the option that sizes it (the meter says the same).
const SERVER_WINDOW_OPTIONS = { vllm: ["vLLM", "--max-model-len"], sglang: ["SGLang", "--context-length"], llamacpp: ["llama-server", "-c"] };
function tokensShort(n) {
    const tokens = Math.max(0, Math.floor(Number(n) || 0));
    if (tokens >= 1048576 && tokens % 1048576 === 0) return `${tokens / 1048576}M`;
    return tokens >= 1024 ? `${Math.round(tokens / 1024)}K` : String(tokens);
}
/** Context window's hint, one line. A vLLM, SGLang or llama.cpp server sized the window when it started
 *  (server_window): the hint says so, and its "?" how to change it there; a number here can only be smaller, and then
 *  decides when DGC compacts. */
export function contextSizeHint(c) {
    const served = c && c.server_window && Number(c.server_window.window) > 0 ? c.server_window : null;
    return served ? `Set by the server: ${tokensShort(served.window)}.` : "Tokens DGC keeps before it compacts.";
}
export function contextSizeMore(c) {
    const served = c && c.server_window && Number(c.server_window.window) > 0 ? c.server_window : null;
    if (!served) return "The model's own maximum still applies.";
    const [name, option] = SERVER_WINDOW_OPTIONS[String(served.server || "").toLowerCase()] || [];
    const how = name ? `Restart ${name} with ${option} to change it.` : "Restart the server with a larger context to change it.";
    return `${how} A smaller number here makes DGC compact sooner.`;
}

// The sub-agents' context window (subagent_context_size, dgc/config.py): 0 is the main model's, else 2,048 to
// 16,777,216 tokens. The box shows 0 as blank, under "Same as the main model".
export const SUBAGENT_WINDOW_MIN = 2048, SUBAGENT_WINDOW_MAX = 16777216;
export function subagentWindowShown(c) {
    const tokens = Number(c?.subagent_context_size) || 0;
    return tokens > 0 ? String(tokens) : "";
}
/** Why a typed sub-agent window can't be saved, or "" when it can (blank and 0 both mean the main model's). */
export function subagentWindowProblem(text) {
    const raw = String(text ?? "").trim();
    if (!raw || Number(raw) === 0) return "";
    const tokens = Number(raw);
    return Number.isInteger(tokens) && tokens >= SUBAGENT_WINDOW_MIN && tokens <= SUBAGENT_WINDOW_MAX ? ""
        : "Leave it blank for the main model's window, or enter 2,048 to 16,777,216 tokens.";
}

/** The number Context size shows: the window in use, so never more than a server's own window (above it can't apply). */
export function contextSizeShown(c) {
    const served = c && c.server_window && Number(c.server_window.window) > 0 ? Number(c.server_window.window) : 0;
    const chosen = Number(c?.context_size) || 0;
    return served && chosen > served ? served : (c?.context_size ?? "");
}

// Settings -> Models -> Advanced: how long DGC waits for a model (model_first_token_timeout_s, model_idle_timeout_s).
export const FIRST_WORD_CHOICES = [["auto", "Auto"], ["minutes", "Minutes"], ["never", "Never"]];
const FIRST_WORD_MORE = "Auto: as long as a model on this computer or your network is working on your request (DGC asks "
    + "its server every 30 seconds), and 5 minutes for a cloud model, which is then asked again. Minutes: one limit for "
    + "every model, though a local model that is still working is never cut off. Never: no limit. Stop always ends the turn.";
const BETWEEN_WORDS_MORE = "If a model goes quiet this long once it has started answering, DGC asks again and goes on from "
    + "what it wrote. A local model that is still working is waited for. 0 is no limit.";

const ENGINE_NAMES = { claude: "Claude Code", codex: "Codex", qwen: "Qwen", kimi: "Kimi", copilot: "Copilot" };
/** What "Same as DGC" is right now: DGC's subscription CLI when it runs on one, else its model. */
function followed(c) {
    const engine = String(c.subscription_engine || "");
    return engine ? (ENGINE_NAMES[engine] || engine) : String(c.model || "");
}

export function renderFields(section, main, config, providers, ui) {
    const { field, sel, inp, bool, model, area } = ui;
    const TRANSPORTS = [["auto", "Auto"], ["ollama", "Ollama"], ["anthropic", "Anthropic"], ["chat_completions", "Chat completions"], ["responses", "Responses"]];
    const old = "Update the DGC CLI to set this here.";
    // A page: its title, one line, and the rest of what it means behind "?".
    const head = (title, sub, more = "") => `<h2>${title}</h2>${ui.intro(section, sub, more)}`;
    const group = (title, body, note = "") => `<section class="group"><h3>${title}</h3>${note ? `<p class="group-note">${note}</p>` : ""}<div class="rows">${body}</div></section>`;
    // A disclosure that remembers being open across redraws; open by itself when what it holds is set.
    const more = (key, summary, body, set) => `<details class="more" data-more="${key}"${OPEN.has(key) || set ? " open" : ""}><summary>${summary}</summary>${body}</details>`;
    const advanced = (key, body) => `<section class="group group-more"><div class="rows">${more(key, "Advanced", body, false)}</div></section>`;
    // A host with its presets beside it: picking one fills the host (settingsClient lists its models again).
    const hostRow = (id, presetId, value) => `<div class="field host-field"><span class="words"><span class="name-line"><label class="name" for="${id}">Host</label></span></span>`
        + `<span class="host-control">${inp(id, value)}${presetId ? sel(presetId, [["", "Presets"]].concat(providers.map((p) => [p.id, p.label])), "") : ""}</span></div>`;
    const saveBar = ui.saveBar();
    const hostName = (url) => { try { return new URL(url).host; } catch { return String(url || ""); } };
    function wire(main) {
        main.querySelectorAll("details.more[data-more]").forEach((d) => d.addEventListener("toggle", () => { if (d.open) OPEN.add(d.dataset.more); else OPEN.delete(d.dataset.more); }));
        // A preset's select is only a way to fill the host: it never shows a stale choice.
        main.querySelectorAll(".host-control select").forEach((el) => { el.setAttribute("aria-label", "Fill the host from a preset"); el.title = "Fill the host from a preset"; });
    }
    function renderGeneral(main) {
        const c = config;
        const think = c.subscription_engine ? (c.subscription_effort || "off") : (c.think || "off");
        const shown = c.show_reasoning === false ? "hidden" : c.thinking_inline === false ? "collapsed" : "inline";
        main.innerHTML = head("General", "How DGC works on this computer.")
            + group("Turns", field("Permission mode", "What DGC may do without asking.", sel("mode", [["default", "Default"], ["acceptEdits", "Accept edits"], ["plan", "Plan"], ["auto", "Auto"]], c.mode || "default"),
                    "Default asks before it changes anything. Accept edits applies file edits without asking. Plan reads and proposes only. Auto acts without asking. Security's sandbox applies in every mode.")
                + field("Thinking", "How hard the model thinks first.", sel("think", [["off", "Off"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]], think),
                    "Applies from the next model round.")
                + field("DGC Ultra", "Splits big turns across sub-agents.", bool("ultra_mode", c.ultra_mode === true),
                    "Extra guidance and sub-agents for larger turns, at the deepest thinking. Permissions stay as set. How many run at once is under Agents.")
                + field("Token cap per turn", c.budget_settable ? "0 means no cap." : old, inp("turn_token_budget", c.turn_token_budget ?? 0, "number"),
                    c.budget_settable ? "Tokens one turn may spend, sub-agents included. When it is reached, no new sub-agent starts and the turn wraps up, keeping its work." : "")
                + field("Context window", contextSizeHint(c), inp("context_size", contextSizeShown(c), "number"), contextSizeMore(c)))
            + group("What you see", field("Show thinking", "Inline, collapsed or hidden.", sel("show_reasoning", [["inline", "Inline"], ["collapsed", "Collapsed"], ["hidden", "Hidden"]], shown))
                + field("Prompt suggestions", "Suggests what to ask next.", bool("suggest", c.suggest !== false),
                    "A grey suggestion in the message box after a reply; Tab or → takes it.")
                + field("Wake on monitors", "A monitor's output starts a short turn.", bool("monitor_wake", c.monitor_wake !== false),
                    "When a background monitor prints something, DGC starts a short turn to look at it."))
            + advanced("general-advanced", field("Tool profile", "Which tools each turn is offered.", sel("tool_profile", [["standard", "Standard"], ["adaptive", "Adaptive"], ["full", "Full catalog"]], c.tool_profile || "standard"),
                "Standard offers every DGC tool on every turn and lets the model choose. Adaptive offers the core coding tools and adds the rest only when you ask for them, which keeps a small local window clear. Full catalog offers every tool the permission mode allows."))
            + saveBar;
        const cap = main.querySelector("#turn_token_budget");
        if (cap) { cap.min = "0"; cap.step = "1000"; if (!c.budget_settable) cap.disabled = true; }
        wire(main);
    }
    function renderModels(main) {
        const c = config;
        const engine = String(c.subscription_engine || "");
        const anthropic = /(^|\.)anthropic\.com/i.test(hostName(c.base_url)) || c.api_mode === "anthropic";
        const cacheLife = field("Cache lifetime", c.cache_settable ? "How long Anthropic keeps it." : old,
            sel("prompt_cache_ttl", [["5m", "5 minutes"], ["1h", "1 hour"]], c.prompt_cache_ttl === "1h" ? "1h" : "5m"),
            c.cache_settable ? "Anthropic only. 5 minutes suits replies that follow each other; 1 hour keeps the cache between replies further apart, and each write costs more." : "");
        main.innerHTML = head("Models", "The model that answers your turns, and its host.")
            + group("Connection", hostRow("base_url", "provider", c.base_url || "")
                + field("API key", "Blank keeps the saved key.", inp("api_key", c.api_key || "", "password"),
                    "Saved for this host only. A key is never sent to any other host.")
                + model("model", "Model", "", c.model || ""))
            + group("Subscription", field("Run turns on", "Your own Claude Code, Codex and others.",
                    sel("subscription_engine", [["", "Off: the model above"], ["claude", "Claude Code"], ["codex", "Codex"], ["qwen", "Qwen Code"], ["kimi", "Kimi Code"], ["copilot", "Copilot"]], engine),
                    "Turns run through that CLI, on your own plan. ChatDGC, sub-agents and Pips keep the connection above unless set otherwise.")
                + `<div data-when-engine${engine ? "" : " hidden"}>`
                + field("Model", "Blank uses the CLI's own.", inp("subscription_model", c.subscription_model || ""))
                + field("Effort", "", sel("subscription_effort", [["", "Default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]], c.subscription_effort || ""))
                + "</div>")
            + group("Cache", field("Prompt cache", "Reuses what the model already read.", bool("prompt_cache", c.prompt_cache !== false))
                + (anthropic ? cacheLife : "")
                + (localOllama(c) ? field("Keep the model loaded", c.cache_settable ? "After the last reply, so the next is quick." : old,
                    sel("ollama_keep_alive", keepAliveChoices(c.ollama_keep_alive), String(c.ollama_keep_alive ?? "30m")),
                    c.cache_settable ? "For this long after the last reply, so the next one starts at once and reuses what is already read. A loaded model keeps its memory in use." : "") : ""))
            + advanced("models-advanced", field("Transport", "How DGC talks to the host.", sel("api_mode", TRANSPORTS, c.api_mode || "auto"),
                    "Auto suits almost every host: Ollama's own API for Ollama, Anthropic's for Anthropic, and Chat completions or Responses elsewhere.")
                + field("Responses state", "OpenAI's Responses API only.", sel("provider_state", [["stateless", "Stateless"], ["server", "Server stored"]], c.provider_state || "stateless"),
                    "Stateless sends the conversation each turn. Server stored lets OpenAI keep it between turns.")
                + (anthropic ? "" : cacheLife)
                + field("Recheck refused features", "Seconds before it asks again.", inp("capability_cache_ttl_s", c.capability_cache_ttl_s ?? "", "number"),
                    "When the host turns down a feature (images, tools, thinking), DGC stops asking for this long.")
                + field("Wait for the first word", c.wait_settable ? "Auto: as long as a local model works." : old,
                    `<span class="wait-control">${sel("wait_first_word", FIRST_WORD_CHOICES, c.wait_first_word || "auto")}`
                    + `${inp("wait_first_word_minutes", c.wait_first_word_minutes ?? "", "number")}</span>`,
                    c.wait_settable ? FIRST_WORD_MORE : "")
                + field("Wait between words", c.wait_settable ? "Minutes of quiet once it answers." : old,
                    inp("wait_between_words", c.wait_between_words ?? "5", "number"), c.wait_settable ? BETWEEN_WORDS_MORE : ""))
            + saveBar;
        if (!c.cache_settable) for (const id of ["prompt_cache_ttl", "ollama_keep_alive"]) { const el = main.querySelector("#" + id); if (el) el.disabled = true; }
        const waitPick = main.querySelector("#wait_first_word"), waitMinutes = main.querySelector("#wait_first_word_minutes");
        if (waitPick && waitMinutes) {
            Object.assign(waitMinutes, { min: "0.1", max: "1440", step: "any", placeholder: "minutes" });
            waitMinutes.setAttribute("aria-label", "Minutes to wait for the first word");
            const show = () => {
                waitMinutes.hidden = waitPick.value !== "minutes";
                // Picking Minutes with nothing typed starts from 15, the wait a local model used to get.
                if (!waitMinutes.hidden && !waitMinutes.value.trim()) { waitMinutes.value = "15"; waitMinutes.dispatchEvent(new Event("input", { bubbles: true })); }
            };
            waitPick.addEventListener("change", show);
            show();
        }
        const between = main.querySelector("#wait_between_words");
        if (between) Object.assign(between, { min: "0", max: "1440", step: "any" });
        if (!c.wait_settable) for (const el of [waitPick, waitMinutes, between]) if (el) el.disabled = true;
        const pick = main.querySelector("#subscription_engine"), rows = main.querySelector("[data-when-engine]");
        if (pick && rows) pick.addEventListener("change", () => { rows.hidden = !pick.value; });
        const box = main.querySelector("#subscription_model");
        if (box) box.placeholder = "The CLI's default";
        wire(main);
    }
    function renderAgents(main) {
        const c = config;
        const subHost = String(c.subagent_base_url || ""), fallbackHost = String(c.fallback_base_url || "");
        const routeRows = (prefix, presetId) => hostRow(`${prefix}_base_url`, presetId, c[`${prefix}_base_url`] || "")
            + field("Transport", "Inherit uses the main one.", sel(`${prefix}_api_mode`, [["", "Inherit"]].concat(TRANSPORTS), c[`${prefix}_api_mode`] || ""),
                "Inherit uses the main transport on the main host, and Auto on any other.")
            + field("API key", "Blank keeps the saved key.", inp(`${prefix}_api_key`, c[`${prefix}_api_key`] || "", "password"),
                "Saved for this host only. With none here, the main key goes only to the main host.");
        main.innerHTML = head("Agents", "Helpers for parts of a turn, a fallback, and Pips.")
            + group("Sub-agents", model("subagent_model", "Model", "", c.subagent_model || "")
                + field("Run at once", parallelHint(c), inp("max_parallel_tasks", c.max_parallel_tasks ?? 4, "number"), parallelMore(c))
                + field("Context window", c.subagent_window_settable ? "Tokens each keeps before it compacts." : old,
                    inp("subagent_context_size", subagentWindowShown(c), "number"))
                + more("subagent-host", subHost ? `Another host · ${escapeHtml(hostName(subHost))}` : "Another host", routeRows("subagent", "subagent_provider"), !!subHost))
            + group("Fallback", model("fallback_model", "Model", "Tried when the main model fails.", c.fallback_model || "")
                + more("fallback-host", fallbackHost ? `Another host · ${escapeHtml(hostName(fallbackHost))}` : "Another host", routeRows("fallback", ""), !!fallbackHost))
            + group("Pips", model("pips_model", "Model for Pips", c.pips_settable ? "Every Pip set to Default uses it." : old, c.pips_model || ""))
            + saveBar;
        const placeholders = { subagent_model: "Same as the main model", fallback_model: "None", subagent_base_url: "Same as the main host", fallback_base_url: "Same as the main host" };
        for (const [id, text] of Object.entries(placeholders)) { const el = main.querySelector("#" + id); if (el) el.placeholder = text; }
        const fallbackHint = main.querySelector("#fallback_model")?.closest(".field")?.querySelector(".hint");
        if (fallbackHint) fallbackHint.title = "If the main model fails or stalls, DGC tries this one.";
        const pipsBox = main.querySelector("#pips_model");
        if (pipsBox) {
            pipsBox.placeholder = "Same as DGC" + (followed(c) ? ` (${followed(c)})` : "");
            if (!c.pips_settable) pipsBox.disabled = true;
        }
        const window = main.querySelector("#subagent_context_size");
        if (window) {
            // As the main window: whole kilotokens from 2,048 up; 0 (blank) is the main model's own.
            Object.assign(window, { placeholder: "Same as the main model", min: "0", max: String(SUBAGENT_WINDOW_MAX), step: "1024" });
            const check = () => window.setCustomValidity(subagentWindowProblem(window.value));
            window.addEventListener("input", check);
            check();
            if (!c.subagent_window_settable) window.disabled = true;
        }
        wire(main);
    }
    function renderSecurity(main) {
        const c = config;
        main.innerHTML = head("Security", "What commands and previews may do.", "These are separate from the permission mode: they hold in every mode, Auto included.")
            + group("Sandbox", field("Run commands in a sandbox", "Shell commands run confined.", bool("sandbox", c.sandbox === true),
                    "DGC confines each shell command with what this computer offers. Where nothing can confine it, it stays off and says so.")
                + field("Network in the sandbox", c.sandbox === true ? "Lets sandboxed commands go online." : "Only with the sandbox on.", bool("sandbox_network", c.sandbox_network === true)))
            + group("Previews", field("Show plans as a page", "A proposed plan opens as a page.", bool("plan_artifact", c.plan_artifact !== false),
                    "Served on this computer only (loopback).")
                + field("Serve pages as they're made", "And bring them back after a restart.", bool("artifact_autostart", c.artifact_autostart !== false))
                + field("Pages in plan mode", "Plan mode may serve pages too.", bool("artifact_in_plan", c.artifact_in_plan === true),
                    "Off keeps plan mode to reading and proposing: it can't start a preview."))
            + saveBar;
        // The network switch means nothing while the sandbox is off.
        const sandbox = main.querySelector("#sandbox"), network = main.querySelector("#sandbox_network");
        const gate = () => { const on = sandbox.getAttribute("aria-checked") === "true"; network.disabled = !on; network.closest(".field").classList.toggle("is-off", !on); };
        if (sandbox && network) { gate(); sandbox.addEventListener("click", () => queueMicrotask(gate)); }
        wire(main);
    }
    function renderWeb(main) {
        const c = config;
        const provider = c.search_provider || "duckduckgo";
        // Ollama only from a CLI that takes it (ready.capabilities.search_providers): an older one refuses the whole save.
        const ollama = (c.search_providers || []).includes("ollama") || provider === "ollama";
        // A CLI that keeps one key per provider says which of them have one (c.search_keys): the field shows the
        // chosen provider's own, and Remove clears it. An older CLI keeps one key for all of them, shown as before.
        const own = c.search_keys && typeof c.search_keys === "object" ? c.search_keys : null;
        const keySaved = (p) => own ? own[p] === true : c.search_api_key_set === true;
        const names = { brave: "Brave", tavily: "Tavily" };
        // One line, and the rest behind "?".
        const keyHint = (p) => p === "ollama"
            ? (keySaved(p) ? (own ? "An ollama.com key is saved for Ollama." : "A key is saved. Leave blank to keep it.") : "Optional when Ollama here is signed in.")
            : !own ? (c.search_api_key_set ? "A key is saved. Leave blank to keep it." : "Brave and Tavily need one.")
            : keySaved(p) ? `A ${names[p] || ""} key is saved. Leave blank to keep it.` : `${names[p] || "It"} needs a key of its own.`;
        const keyMore = (p) => p === "ollama"
            ? (keySaved(p) ? "It is used when Ollama on this computer isn't signed in. Leave blank to keep it."
                : "Signed in to Ollama on this computer? Nothing to add. Otherwise a key from ollama.com → Settings → API keys.")
            : "Each provider keeps its own key; one is never sent to another.";
        const removing = own && c.search_key_removing;
        const keyRow = '<div class="field search-key"><span class="words"><span class="name-line"><label class="name" for="search_api_key">API key</label>'
            + ui.infoButton("search_api_key", "API key") + `</span><span class="hint">${keyHint(provider)}</span>${ui.detail("search_api_key", keyMore(provider))}</span>`
            + (own ? '<span class="search-key-control">' + inp("search_api_key", "", "password")
                + '<button type="button" class="secondary" id="search-key-remove" title="Remove the key saved for this provider"' + (removing ? " disabled" : "") + ">" + (removing ? "Removing…" : "Remove") + "</button></span>"
                : inp("search_api_key", "", "password")) + "</div>";
        const providers = [["duckduckgo", "DuckDuckGo (no key)"], ["brave", "Brave Search"], ["tavily", "Tavily"], ["searxng", "SearXNG (your server)"]].concat(ollama ? [["ollama", "Ollama (sign-in or key)"]] : []);
        main.innerHTML = head("Web search", "One search for Work, ChatDGC and your Pips.",
                "DuckDuckGo needs nothing; " + (ollama ? "Ollama uses your Ollama sign-in or a key; " : "") + "Brave and Tavily need a key; SearXNG is a server you run. Whether ChatDGC searches is on the ChatDGC page.")
            + (c.search_settable ? "" : '<p class="note" role="status">Update the DGC CLI to choose the web search here.</p>')
            + group("Search", field("Provider", "", sel("search_provider", providers, provider))
                + '<div data-search-for="brave tavily ollama">' + keyRow + "</div>"
                + '<div data-search-for="searxng">' + field("Server address", "Your SearXNG server.", inp("search_url", c.search_url || "", "url")) + "</div>")
            + saveBar;
        const urlBox = main.querySelector("#search_url");
        if (urlBox) urlBox.placeholder = "http://127.0.0.1:8888";
        const pick = main.querySelector("#search_provider");
        const key = main.querySelector("#search_api_key"), remove = main.querySelector("#search-key-remove");
        const show = () => {
            main.querySelectorAll("[data-search-for]").forEach((row) => { row.hidden = !row.dataset.searchFor.split(" ").includes(pick.value); });
            const row = main.querySelector('[data-search-for~="ollama"]');
            if (row) { row.querySelector(".hint").textContent = keyHint(pick.value); row.querySelector(".detail").textContent = keyMore(pick.value); }
            // The chosen provider's own key: "Saved" or empty, never the key; Remove only when there is one.
            if (own && key) key.placeholder = keySaved(pick.value) ? "Saved" : "";
            if (remove) remove.hidden = !keySaved(pick.value);
        };
        let shownFor = pick ? pick.value : "";
        if (pick) {
            pick.addEventListener("change", () => {
                // A key typed for one provider is never saved as another's.
                if (own && key && pick.value !== shownFor) key.value = "";
                shownFor = pick.value;
                show();
            });
            show();
        }
        if (!c.search_settable) main.querySelectorAll(".rows input, .rows select, .rows button:not(.info)").forEach((el) => { el.disabled = true; });
        wire(main);
    }
    function renderChatDGC(main) {
        const c = config;
        main.innerHTML = head("ChatDGC", "How ChatDGC answers you, from its next reply.", "In every chat. Work and your Pips are not affected.")
            + (c.chatdgc_settable ? "" : '<p class="note" role="status">Update the DGC CLI to set these here.</p>')
            + group("Replies", field("Personality", "Its manner; your words below come first.", sel("chatdgc_personality", [["default", "Default"], ["concise", "Concise: brief and direct"], ["warm", "Warm: encouraging and kind"], ["candid", "Candid: says when you're wrong"], ["nerdy", "Nerdy: curious, explains how things work"]], c.chatdgc_personality || "default"))
                + field("Suggest follow-ups", "A few next questions under a reply.", bool("chatdgc_followups", c.chatdgc_followups !== false), "Click one to send it.")
                + field("Search the web", c.search_settable ? "Looks things up and cites them." : "Update the DGC CLI to set this here.", bool("chatdgc_web", c.chatdgc_web !== false),
                    "Whenever an answer depends on facts it could get wrong. Off: ChatDGC never goes online. Which search it uses is under Web search.")
                + field("Context window", "How much a chat holds before it summarizes.", sel("chatdgc_window", [["8k", "8K: small models"], ["16k", "16K"], ["32k", "32K: standard"], ["64k", "64K"], ["128k", "128K: relaxed"], ["256k", "256K"], ["512k", "512K"], ["1m", "1M"], ["max", "The model's maximum"]], c.chatdgc_window || "32k"),
                    "Larger windows need more memory on your computer; the model's own limit always applies."))
            + group("Custom instructions", field("What should ChatDGC know about you?", "Up to 1,500 characters.", area("chatdgc_about", c.chatdgc_about || "", "For example: I run a small bakery in Pune and prefer metric units."))
                + field("How should ChatDGC respond?", "Up to 1,500 characters.", area("chatdgc_style", c.chatdgc_style || "", "For example: Lead with the answer, then the numbers. Use bullet points.")))
            + saveBar;
        if (!c.chatdgc_settable) main.querySelectorAll(".rows textarea, .rows select, .rows [role=switch]").forEach((el) => { if (el.id !== "chatdgc_web") el.disabled = true; });
        if (!c.search_settable) { const web = main.querySelector("#chatdgc_web"); if (web) web.disabled = true; }
        wire(main);
    }
    ({ general: renderGeneral, models: renderModels, agents: renderAgents, web: renderWeb, chatdgc: renderChatDGC, security: renderSecurity })[section](main);
}

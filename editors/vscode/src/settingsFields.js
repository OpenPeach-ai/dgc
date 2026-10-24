// Existing settings fields, shared by the editor settings client.
/** What "Parallel sub-agents" actually does, which is not the same number in both profiles.
 *
 *  Ultra runs the whole range when you have not chosen a width, so a box reading 4 beside an Ultra
 *  toggle that is on was telling the user something untrue. Ultra widens only a width still equal
 *  to the shipped default -- any number you set is honoured exactly, including 1, because the
 *  rate-limit advice tells you to lower this. The hint says which of the two you are looking at. */
/** The keep-loaded choices, with a value set elsewhere (the CLI, config.json) kept as it is. */
function keepAliveChoices(current) {
    const value = String(current ?? "30m");
    return KEEP_ALIVE_CHOICES.some(([v]) => v === value) ? KEEP_ALIVE_CHOICES : KEEP_ALIVE_CHOICES.concat([[value, value]]);
}
function parallelHint(c) {
    const pinned = Number(c.max_parallel_tasks ?? 4) !== 4;
    if (c.ultra_mode !== true) { return "How many sub-agents may run at once. Ultra raises this to 8 unless you set a number here."; }
    return pinned
        ? "Ultra would run 8; this pins it narrower. Clear it back to 4 to let Ultra widen again."
        : "Ultra is on, so this runs 8. Set any other number to pin it — 1 disables parallel sub-agents.";
}

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
/** Context size's hint. A vLLM, SGLang or llama.cpp server sized the window when it started (server_window): say so
 *  and how to change it there; a number here can only be smaller, and then decides when DGC compacts. */
export function contextSizeHint(c) {
    const served = c && c.server_window && Number(c.server_window.window) > 0 ? c.server_window : null;
    if (!served) return "Tokens before DGC compacts. The model's own maximum still applies.";
    const [name, option] = SERVER_WINDOW_OPTIONS[String(served.server || "").toLowerCase()] || [];
    const how = name ? `restart ${name} with ${option} to change it` : "restart the server with a larger context to change it";
    return `Set by the server: ${tokensShort(served.window)} (${how}). A smaller number here makes DGC compact sooner.`;
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

const ENGINE_NAMES = { claude: "Claude Code", codex: "Codex", qwen: "Qwen", kimi: "Kimi", copilot: "Copilot" };
/** What "Same as DGC" is right now: DGC's subscription CLI when it runs on one, else its model. */
function followed(c) {
    const engine = String(c.subscription_engine || "");
    return engine ? (ENGINE_NAMES[engine] || engine) : String(c.model || "");
}

export function renderFields(section, main, config, providers, ui) {
    const { field, sel, inp, bool, card, model } = ui;
    function renderGeneral(main) {
        const c = config;
        const think = c.subscription_engine ? (c.subscription_effort || "off") : (c.think || "off");
        const shown = c.show_reasoning === false ? "hidden" : c.thinking_inline === false ? "collapsed" : "inline";
        main.innerHTML = '<h2>General</h2><p class="sub">How DGC behaves on this machine.</p>'
            + card("Behavior", field("Permission mode", "What DGC may do without asking again.", sel("mode", [["default", "Default"], ["acceptEdits", "Accept edits"], ["plan", "Plan"], ["auto", "Auto"]], c.mode || "default"))
                + field("Thinking", "Applies to the next model round.", sel("think", [["off", "Off"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]], think))
                + field("DGC Ultra", "Extra guidance and bounded sub-agents. Permissions stay as set.", bool("ultra_mode", c.ultra_mode === true))
                + field("Parallel sub-agents", parallelHint(c), inp("max_parallel_tasks", c.max_parallel_tasks ?? 4, "number"))
                + field("Token cap per turn", c.budget_settable ? "Tokens one turn may spend, sub-agents included. When it is reached, no new sub-agent starts and the turn wraps up, keeping its work. 0 means no cap." : "Update the DGC CLI to set this here.", inp("turn_token_budget", c.turn_token_budget ?? 0, "number"))
                + field("Context size", contextSizeHint(c), inp("context_size", contextSizeShown(c), "number"))
                + field("Show thinking", "Inline, collapsed, or hidden.", sel("show_reasoning", [["inline", "Inline"], ["collapsed", "Collapsed"], ["hidden", "Hidden"]], shown))
                + field("Prompt suggestions", "", bool("suggest", c.suggest !== false))
                + field("Wake on monitors", "Start a short turn when a background monitor prints.", bool("monitor_wake", c.monitor_wake !== false))
                + field("Tool profile", "Standard offers every product tool on each turn.", sel("tool_profile", [["standard", "Standard"], ["adaptive", "Adaptive"], ["full", "Full catalog"]], c.tool_profile || "standard")))
            + '<button type="button" class="save" id="save" title="Save these settings for every workspace on this computer">Save</button>';
        const cap = main.querySelector("#turn_token_budget");
        if (cap) { cap.min = "0"; cap.step = "1000"; if (!c.budget_settable) cap.disabled = true; }
    }
    function renderModels(main) {
        const c = config;
        const presets = providers.map((p) => [p.id, p.label]);
        main.innerHTML = '<h2>Models</h2><p class="sub">Where a turn is sent.</p>'
            + card("Connection", field("Provider preset", "Fills the host below.", sel("provider", [["", "Choose a preset"]].concat(presets), ""))
                + field("Host URL", "", inp("base_url", c.base_url || ""))
                + field("API key", "Leave blank to keep the saved key.", inp("api_key", c.api_key || "", "password"))
                + model("model", "Model", "", c.model || ""))
            + card("Subscription", field("Engine", "Run turns through a subscription CLI.", sel("subscription_engine", [["", "Off"], ["claude", "Claude"], ["codex", "Codex"], ["qwen", "Qwen"], ["kimi", "Kimi"], ["copilot", "Copilot"]], c.subscription_engine || ""))
                + field("Subscription model", "Optional. Blank uses that CLI's default.", inp("subscription_model", c.subscription_model || ""))
                + field("Reasoning effort", "", sel("subscription_effort", [["", "Default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]], c.subscription_effort || "")))
            + card("Runtime", field("API transport", "", sel("api_mode", [["auto", "Auto"], ["ollama", "Ollama"], ["anthropic", "Anthropic"], ["chat_completions", "Chat completions"], ["responses", "Responses"]], c.api_mode || "auto"))
                + field("Responses state", "", sel("provider_state", [["stateless", "Stateless"], ["server", "Server stored"]], c.provider_state || "stateless"))
                + field("Prompt cache", "", bool("prompt_cache", c.prompt_cache !== false))
                + field("Cache lifetime", c.cache_settable ? "Anthropic only. 5 minutes suits replies that follow each other; 1 hour keeps the cache between replies further apart, and each write costs more." : "Update the DGC CLI to set this here.", sel("prompt_cache_ttl", [["5m", "5 minutes"], ["1h", "1 hour"]], c.prompt_cache_ttl === "1h" ? "1h" : "5m"))
                + (localOllama(c) ? field("Keep the model loaded", c.cache_settable ? "For this long after the last reply, so the next one starts at once and reuses what is already read. A loaded model keeps its memory in use." : "Update the DGC CLI to set this here.", sel("ollama_keep_alive", keepAliveChoices(c.ollama_keep_alive), String(c.ollama_keep_alive ?? "30m"))) : "")
                + field("Capability retry TTL", "Seconds.", inp("capability_cache_ttl_s", c.capability_cache_ttl_s ?? "", "number")))
            + '<button type="button" class="save" id="save" title="Save these settings for every workspace on this computer">Save</button>';
        if (!c.cache_settable) for (const id of ["prompt_cache_ttl", "ollama_keep_alive"]) { const el = main.querySelector("#" + id); if (el) el.disabled = true; }
        const preset = document.getElementById("provider");
        if (preset)
            preset.onchange = () => {
                const found = providers.find((p) => p.id === preset.value);
                if (found && found.url)
                    document.getElementById("base_url").value = found.url;
            };
    }
    function renderAgents(main) {
        const c = config;
        main.innerHTML = '<h2>Agents</h2><p class="sub">Sub-agents and the fallback route. Blank fields inherit the main model.</p>'
            + card("Sub-agents", field("Provider preset", "Fills the sub-agent host below.", sel("subagent_provider", [["", "Choose a preset"]].concat(providers.map(p => [p.id, p.label])), ""))
                + model("subagent_model", "Model", "", c.subagent_model || "")
                + field("Host URL", "", inp("subagent_base_url", c.subagent_base_url || ""))
                + field("Transport", "", sel("subagent_api_mode", [["", "Inherit"], ["auto", "Auto"], ["ollama", "Ollama"], ["anthropic", "Anthropic"], ["chat_completions", "Chat completions"], ["responses", "Responses"]], c.subagent_api_mode || ""))
                + field("API key", "Leave blank to keep the saved key.", inp("subagent_api_key", c.subagent_api_key || "", "password"))
                + field("Context size", c.subagent_window_settable ? "Tokens each sub-agent holds before it compacts." : "Update the DGC CLI to set this here.",
                    inp("subagent_context_size", subagentWindowShown(c), "number")))
            + card("Fallback", model("fallback_model", "Model", "", c.fallback_model || "")
                + field("Host URL", "", inp("fallback_base_url", c.fallback_base_url || ""))
                + field("Transport", "", sel("fallback_api_mode", [["", "Inherit"], ["auto", "Auto"], ["ollama", "Ollama"], ["anthropic", "Anthropic"], ["chat_completions", "Chat completions"], ["responses", "Responses"]], c.fallback_api_mode || ""))
                + field("API key", "", inp("fallback_api_key", c.fallback_api_key || "", "password")))
            + card("Pips", model("pips_model", "Model for Pips", c.pips_settable ? "Every Pip set to Default uses it, on the connection under Models. Blank uses DGC's own."
                : "Update the DGC CLI to set this here.", c.pips_model || ""))
            + '<button type="button" class="save" id="save" title="Save these settings for every workspace on this computer">Save</button>';
        const pipsBox = main.querySelector("#pips_model");
        if (pipsBox) {
            pipsBox.placeholder = "Same as DGC" + (followed(c) ? ` (${followed(c)})` : "");
            if (!c.pips_settable) pipsBox.disabled = true;
        }
        const window = main.querySelector("#subagent_context_size");
        if (window) {
            // As the main Context size: whole kilotokens from 2,048 up; 0 (blank) is the main model's own.
            Object.assign(window, { placeholder: "Same as the main model", min: "0", max: String(SUBAGENT_WINDOW_MAX), step: "1024" });
            const check = () => window.setCustomValidity(subagentWindowProblem(window.value));
            window.addEventListener("input", check);
            check();
            if (!c.subagent_window_settable) window.disabled = true;
        }
    }
    function renderSecurity(main) {
        const c = config;
        main.innerHTML = '<h2>Security</h2><p class="sub">Sandbox and plan limits. They are separate from the permission mode.</p>'
            + card("Sandbox and plan", field("OS sandbox", "", bool("sandbox", c.sandbox === true))
                + field("Sandbox network", "", bool("sandbox_network", c.sandbox_network === true))
                + field("Plan preview", "Loopback only.", bool("plan_artifact", c.plan_artifact !== false))
                + field("Restore previews", "", bool("artifact_autostart", c.artifact_autostart !== false))
                + field("Artifacts in plan mode", "Broadens the read-only plan surface.", bool("artifact_in_plan", c.artifact_in_plan === true)))
            + '<button type="button" class="save" id="save" title="Save these settings for every workspace on this computer">Save</button>';
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
        const keyHint = (p) => p === "ollama"
            ? (keySaved(p) ? (own ? "An ollama.com key is saved for Ollama, used when Ollama on this computer isn't signed in. Leave blank to keep it."
                : "A key is saved, used when Ollama on this computer isn't signed in. Leave blank to keep it.")
                : "Optional. Signed in to Ollama on this computer? Nothing to add. Otherwise a key from ollama.com → Settings → API keys.")
            : !own ? (c.search_api_key_set ? "A key is saved. Leave blank to keep it." : "Brave and Tavily need one.")
            : keySaved(p) ? `A ${names[p] || ""} key is saved. Leave blank to keep it.` : `${names[p] || "It"} needs a key of its own.`;
        const removing = own && c.search_key_removing;
        const keyRow = own
            ? '<div class="field search-key"><span><label class="name" for="search_api_key">API key</label><span class="hint">' + keyHint(provider) + '</span></span>'
                + '<span class="search-key-control">' + inp("search_api_key", "", "password")
                + '<button type="button" class="secondary" id="search-key-remove" title="Remove the key saved for this provider"' + (removing ? ' disabled' : '') + '>' + (removing ? 'Removing…' : 'Remove') + '</button></span></div>'
            : field("API key", keyHint(provider), inp("search_api_key", "", "password"));
        const providers = [["duckduckgo", "DuckDuckGo (no key)"], ["brave", "Brave Search"], ["tavily", "Tavily"], ["searxng", "SearXNG (your server)"]].concat(ollama ? [["ollama", "Ollama (sign-in or key)"]] : []);
        main.innerHTML = '<h2>Web search</h2><p class="sub">One search for Work, ChatDGC and your Pips. DuckDuckGo needs nothing; ' + (ollama ? 'Ollama uses your Ollama sign-in or a key; ' : '') + 'Brave and Tavily need a key; SearXNG is a server you run.</p>'
            + (c.search_settable ? '' : '<p class="note" role="status">Update the DGC CLI to choose the web search here.</p>')
            + card("ChatDGC", field("Search in ChatDGC", "It looks things up whenever an answer depends on facts it could get wrong, and cites what it found. Off: ChatDGC never goes online.", bool("chatdgc_web", c.chatdgc_web !== false)))
            + card("Search", field("Provider", "", sel("search_provider", providers, provider))
                + '<div data-search-for="brave tavily ollama">' + keyRow + '</div>'
                + '<div data-search-for="searxng">' + field("Server address", "For example http://127.0.0.1:8888", inp("search_url", c.search_url || "", "url")) + '</div>')
            + '<button type="button" class="save" id="save" title="Save the web search for every workspace on this computer"' + (c.search_settable ? '' : ' disabled') + '>Save</button>';
        const pick = document.getElementById("search_provider");
        const key = document.getElementById("search_api_key"), remove = document.getElementById("search-key-remove");
        const show = () => {
            main.querySelectorAll("[data-search-for]").forEach((row) => { row.hidden = !row.dataset.searchFor.split(" ").includes(pick.value); });
            const hint = main.querySelector('[data-search-for~="ollama"] .hint');
            if (hint) hint.textContent = keyHint(pick.value);
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
        if (!c.search_settable) main.querySelectorAll(".card input, .card select").forEach((el) => { el.disabled = true; });
    }
    function renderChatDGC(main) {
        const c = config;
        const area = ui.area;
        main.innerHTML = '<h2>ChatDGC</h2><p class="sub">How ChatDGC answers you, in every chat from its next reply. Work and your Pips are not affected.</p>'
            + (c.chatdgc_settable ? '' : '<p class="note" role="status">Update the DGC CLI to set these here.</p>')
            + card("How it sounds", field("Personality", "Its manner. Your own words below still come first.", sel("chatdgc_personality", [["default", "Default"], ["concise", "Concise: brief and direct"], ["warm", "Warm: encouraging and kind"], ["candid", "Candid: says when you're wrong"], ["nerdy", "Nerdy: curious, explains how things work"]], c.chatdgc_personality || "default")))
            + card("Follow-ups", field("Suggest follow-ups", "A few next questions under a reply, as ChatGPT shows them. Click one to send it.", bool("chatdgc_followups", c.chatdgc_followups !== false)))
            + card("Context window", field("Window", "How much a chat holds before older messages are summarized. Larger windows need more memory on your computer; the model's own limit always applies.", sel("chatdgc_window", [["8k", "8K: small models"], ["16k", "16K"], ["32k", "32K: standard"], ["64k", "64K"], ["128k", "128K: relaxed"], ["256k", "256K"], ["512k", "512K"], ["1m", "1M"], ["max", "The model's maximum"]], c.chatdgc_window || "32k")))
            + card("Custom instructions", field("What should ChatDGC know about you?", "Up to 1,500 characters.", area("chatdgc_about", c.chatdgc_about || "", "For example: I run a small bakery in Pune and prefer metric units."))
                + field("How should ChatDGC respond?", "Up to 1,500 characters.", area("chatdgc_style", c.chatdgc_style || "", "For example: Lead with the answer, then the numbers. Use bullet points.")))
            + '<button type="button" class="save" id="save" title="Save for every workspace on this computer"' + (c.chatdgc_settable ? '' : ' disabled') + '>Save</button>';
        if (!c.chatdgc_settable) main.querySelectorAll(".card textarea, .card select, .card input, .card [role=switch]").forEach((el) => { el.disabled = true; });
    }
    ({ general: renderGeneral, models: renderModels, agents: renderAgents, web: renderWeb, chatdgc: renderChatDGC, security: renderSecurity })[section](main);
}

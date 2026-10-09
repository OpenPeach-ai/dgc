// Existing settings fields, shared by the editor settings client.
/** What "Parallel sub-agents" actually does, which is not the same number in both profiles.
 *
 *  Ultra runs the whole range when you have not chosen a width, so a box reading 4 beside an Ultra
 *  toggle that is on was telling the user something untrue. Ultra widens only a width still equal
 *  to the shipped default -- any number you set is honoured exactly, including 1, because the
 *  rate-limit advice tells you to lower this. The hint says which of the two you are looking at. */
function parallelHint(c) {
    const pinned = Number(c.max_parallel_tasks ?? 4) !== 4;
    if (c.ultra_mode !== true) { return "How many sub-agents may run at once. Ultra raises this to 8 unless you set a number here."; }
    return pinned
        ? "Ultra would run 8; this pins it narrower. Clear it back to 4 to let Ultra widen again."
        : "Ultra is on, so this runs 8. Set any other number to pin it — 1 disables parallel sub-agents.";
}

export function renderFields(section, main, config, providers, ui) {
    const { field, sel, inp, bool, card } = ui;
    function renderGeneral(main) {
        const c = config;
        const think = c.subscription_engine ? (c.subscription_effort || "off") : (c.think || "off");
        const shown = c.show_reasoning === false ? "hidden" : c.thinking_inline === false ? "collapsed" : "inline";
        main.innerHTML = '<h2>General</h2><p class="sub">How DGC behaves on this machine.</p>'
            + card("Behavior", field("Permission mode", "What DGC may do without asking again.", sel("mode", [["default", "Default"], ["acceptEdits", "Accept edits"], ["plan", "Plan"], ["auto", "Auto"]], c.mode || "default"))
                + field("Thinking", "Applies to the next model round.", sel("think", [["off", "Off"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]], think))
                + field("DGC Ultra", "Extra guidance and bounded sub-agents. Permissions stay as set.", bool("ultra_mode", c.ultra_mode === true))
                + field("Parallel sub-agents", parallelHint(c), inp("max_parallel_tasks", c.max_parallel_tasks ?? 4, "number"))
                + field("Context size", "Tokens before DGC compacts. The model's own maximum still applies.", inp("context_size", c.context_size ?? "", "number"))
                + field("Show thinking", "Inline, collapsed, or hidden.", sel("show_reasoning", [["inline", "Inline"], ["collapsed", "Collapsed"], ["hidden", "Hidden"]], shown))
                + field("Prompt suggestions", "", bool("suggest", c.suggest !== false))
                + field("Wake on monitors", "Start a short turn when a background monitor prints.", bool("monitor_wake", c.monitor_wake !== false))
                + field("Tool profile", "Standard offers every product tool on each turn.", sel("tool_profile", [["standard", "Standard"], ["adaptive", "Adaptive"], ["full", "Full catalog"]], c.tool_profile || "standard")))
            + '<button type="button" class="save" id="save" title="Save these settings for every workspace on this computer">Save</button>';
    }
    function renderModels(main) {
        const c = config;
        const presets = providers.map((p) => [p.id, p.label]);
        main.innerHTML = '<h2>Models</h2><p class="sub">Where a turn is sent.</p>'
            + card("Connection", field("Provider preset", "Fills the host below.", sel("provider", [["", "Choose a preset"]].concat(presets), ""))
                + field("Host URL", "", inp("base_url", c.base_url || ""))
                + field("API key", "Leave blank to keep the saved key.", inp("api_key", c.api_key || "", "password"))
                + field("Model", "", inp("model", c.model || "")))
            + card("Subscription", field("Engine", "Run turns through a subscription CLI.", sel("subscription_engine", [["", "Off"], ["claude", "Claude"], ["codex", "Codex"], ["qwen", "Qwen"], ["kimi", "Kimi"], ["copilot", "Copilot"]], c.subscription_engine || ""))
                + field("Subscription model", "Optional. Blank uses that CLI's default.", inp("subscription_model", c.subscription_model || ""))
                + field("Reasoning effort", "", sel("subscription_effort", [["", "Default"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]], c.subscription_effort || "")))
            + card("Runtime", field("API transport", "", sel("api_mode", [["auto", "Auto"], ["ollama", "Ollama"], ["anthropic", "Anthropic"], ["chat_completions", "Chat completions"], ["responses", "Responses"]], c.api_mode || "auto"))
                + field("Responses state", "", sel("provider_state", [["stateless", "Stateless"], ["server", "Server stored"]], c.provider_state || "stateless"))
                + field("Prompt cache", "", bool("prompt_cache", c.prompt_cache !== false))
                + field("Capability retry TTL", "Seconds.", inp("capability_cache_ttl_s", c.capability_cache_ttl_s ?? "", "number")))
            + '<button type="button" class="save" id="save" title="Save these settings for every workspace on this computer">Save</button>';
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
                + field("Model", "", inp("subagent_model", c.subagent_model || ""))
                + field("Host URL", "", inp("subagent_base_url", c.subagent_base_url || ""))
                + field("Transport", "", sel("subagent_api_mode", [["", "Inherit"], ["auto", "Auto"], ["ollama", "Ollama"], ["anthropic", "Anthropic"], ["chat_completions", "Chat completions"], ["responses", "Responses"]], c.subagent_api_mode || ""))
                + field("API key", "Leave blank to keep the saved key.", inp("subagent_api_key", c.subagent_api_key || "", "password")))
            + card("Fallback", field("Model", "", inp("fallback_model", c.fallback_model || ""))
                + field("Host URL", "", inp("fallback_base_url", c.fallback_base_url || ""))
                + field("Transport", "", sel("fallback_api_mode", [["", "Inherit"], ["auto", "Auto"], ["ollama", "Ollama"], ["anthropic", "Anthropic"], ["chat_completions", "Chat completions"], ["responses", "Responses"]], c.fallback_api_mode || ""))
                + field("API key", "", inp("fallback_api_key", c.fallback_api_key || "", "password")))
            + '<button type="button" class="save" id="save" title="Save these settings for every workspace on this computer">Save</button>';
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
        const keyHint = c.search_api_key_set ? "A key is saved. Leave blank to keep it." : "Brave and Tavily need one.";
        main.innerHTML = '<h2>Web search</h2><p class="sub">One search for Work, ChatDGC and your Pips. DuckDuckGo needs nothing; Brave and Tavily need a key; SearXNG is a server you run.</p>'
            + (c.search_settable ? '' : '<p class="note" role="status">Update the DGC CLI to choose the web search here.</p>')
            + card("Search", field("Provider", "", sel("search_provider", [["duckduckgo", "DuckDuckGo (no key)"], ["brave", "Brave Search"], ["tavily", "Tavily"], ["searxng", "SearXNG (your server)"]], provider))
                + '<div data-search-for="brave tavily">' + field("API key", keyHint, inp("search_api_key", "", "password")) + '</div>'
                + '<div data-search-for="searxng">' + field("Server address", "For example http://127.0.0.1:8888", inp("search_url", c.search_url || "", "url")) + '</div>')
            + '<button type="button" class="save" id="save" title="Save the web search for every workspace on this computer"' + (c.search_settable ? '' : ' disabled') + '>Save</button>';
        const pick = document.getElementById("search_provider");
        const show = () => main.querySelectorAll("[data-search-for]").forEach((row) => { row.hidden = !row.dataset.searchFor.split(" ").includes(pick.value); });
        if (pick) { pick.addEventListener("change", show); show(); }
        if (!c.search_settable) main.querySelectorAll(".card input, .card select").forEach((el) => { el.disabled = true; });
    }
    function renderChatDGC(main) {
        const c = config;
        const area = ui.area;
        main.innerHTML = '<h2>ChatDGC</h2><p class="sub">How ChatDGC answers you, in every chat from its next reply. Work and your Pips are not affected.</p>'
            + (c.chatdgc_settable ? '' : '<p class="note" role="status">Update the DGC CLI to set these here.</p>')
            + card("Personality", field("Personality", "Its manner. Your own words below still come first.", sel("chatdgc_personality", [["default", "Default"], ["concise", "Concise: brief and direct"], ["warm", "Warm: encouraging and kind"], ["candid", "Candid: says when you're wrong"], ["nerdy", "Nerdy: curious, explains how things work"]], c.chatdgc_personality || "default")))
            + card("Custom instructions", field("What should ChatDGC know about you?", "Up to 1,500 characters.", area("chatdgc_about", c.chatdgc_about || "", "For example: I run a small bakery in Pune and prefer metric units."))
                + field("How should ChatDGC respond?", "Up to 1,500 characters.", area("chatdgc_style", c.chatdgc_style || "", "For example: Lead with the answer, then the numbers. Use bullet points.")))
            + '<button type="button" class="save" id="save" title="Save for every workspace on this computer"' + (c.chatdgc_settable ? '' : ' disabled') + '>Save</button>';
        if (!c.chatdgc_settable) main.querySelectorAll(".card textarea, .card select").forEach((el) => { el.disabled = true; });
    }
    ({ general: renderGeneral, models: renderModels, agents: renderAgents, web: renderWeb, chatdgc: renderChatDGC, security: renderSecurity })[section](main);
}

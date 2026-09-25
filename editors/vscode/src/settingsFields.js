// Existing settings fields, shared by the editor settings client.
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
                + field("Context size", "Tokens before DGC compacts. The model's own maximum still applies.", inp("context_size", c.context_size ?? "", "number"))
                + field("Show thinking", "Inline, collapsed, or hidden.", sel("show_reasoning", [["inline", "Inline"], ["collapsed", "Collapsed"], ["hidden", "Hidden"]], shown))
                + field("Prompt suggestions", "", bool("suggest", c.suggest !== false))
                + field("Wake on monitors", "Start a short turn when a background monitor prints.", bool("monitor_wake", c.monitor_wake !== false))
                + field("Tool profile", "Standard offers every product tool on each turn.", sel("tool_profile", [["standard", "Standard"], ["adaptive", "Adaptive"], ["full", "Full catalog"]], c.tool_profile || "standard"))
                + field("Parallel tasks", "How many sub-agents may run at once.", inp("max_parallel_tasks", c.max_parallel_tasks || 4, "number")))
            + '<button type="button" class="save" id="save">Save</button>';
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
            + '<button type="button" class="save" id="save">Save</button>';
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
            + '<button type="button" class="save" id="save">Save</button>';
    }
    function renderSecurity(main) {
        const c = config;
        main.innerHTML = '<h2>Security</h2><p class="sub">Sandbox and plan limits. They are separate from the permission mode.</p>'
            + card("Sandbox and plan", field("OS sandbox", "", bool("sandbox", c.sandbox === true))
                + field("Sandbox network", "", bool("sandbox_network", c.sandbox_network === true))
                + field("Plan preview", "Loopback only.", bool("plan_artifact", c.plan_artifact !== false))
                + field("Restore previews", "", bool("artifact_autostart", c.artifact_autostart !== false))
                + field("Artifacts in plan mode", "Broadens the read-only plan surface.", bool("artifact_in_plan", c.artifact_in_plan === true)))
            + '<button type="button" class="save" id="save">Save</button>';
    }
    ({ general: renderGeneral, models: renderModels, agents: renderAgents, security: renderSecurity })[section](main);
}

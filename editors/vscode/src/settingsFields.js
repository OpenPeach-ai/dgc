import { contextComboHTML, parseContext } from "./contextCombo.js";
import { pipChoices } from "./settingsRouter.js";
// The settings pages DGC saves with one Save (General, Models, Web search, ChatDGC, Security), drawn with the
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
    // (Plain words, user test 2, S4: "Up to 32. Ultra runs 8 unless you set one." told a new user nothing to act on.)
    if (c.ultra_mode !== true) return "How many sub-agents work at once, up to 32.";
    return pinned ? "Your number is used, not Ultra’s 8." : "Ultra is on: 8 work at once.";
}
export function parallelMore(c) {
    const pinned = Number(c.max_parallel_tasks ?? 4) !== 4;
    const ultra = c.ultra_mode !== true ? "1 runs them one at a time. With Ultra it is 8, unless you set a number here."
        : pinned ? "Set 4 to let Ultra choose." : "Set any other number, up to 32, to keep it.";
    return `${ultra} More costs more: each helper works in its own copy of the project, a cloud service may slow you `
        + "down when many ask at once, and a model on this computer answers only a few at a time while the rest wait.";
}
// Remembered across redraws: which "Advanced" and "Another host" disclosures are open.
const OPEN = new Set();
// Sub-agents' provider choice is on "Another host…" (its host may still be blank), until a provider is chosen.
let agentsAnotherHost = false;
// Whether Another host was last drawn open because its host is no provider's: when that stops being so (the providers
// arrived, a provider was chosen) it closes again, rather than staying open as if it had been opened by hand.
let agentsHostShown = false;
const AGENTS_CLI_REASON = "Claude Code and Codex run their own tools, so they can’t run DGC’s agents.";
const sameAddress = (a, b) => String(a || "").trim().replace(/\/+$/, "").toLowerCase() === String(b || "").trim().replace(/\/+$/, "").toLowerCase();
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
/** Settings -> Models -> Sub-agents -> Thinking: "" is the main chat's level. */
export const SUBAGENT_THINKING_CHOICES = [["", "Same as the main session"], ["off", "Off"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"]];
export function subagentWindowShown(c) {
    const tokens = Number(c?.subagent_context_size) || 0;
    return tokens > 0 ? String(tokens) : "";
}
/** Why a typed sub-agent window can't be saved, or "" when it can (blank and 0 both mean the main model's). It reads
 *  a size as the box does: 24576, 24,576, 24K or 24k. */
export function subagentWindowProblem(text) {
    const raw = String(text ?? "").trim();
    if (!raw || Number(raw) === 0) return "";
    const tokens = parseContext(raw);
    return typeof tokens === "number" && tokens >= SUBAGENT_WINDOW_MIN && tokens <= SUBAGENT_WINDOW_MAX ? ""
        : "Leave it blank for the main model's window, or enter 2K to 16,384K (2,048 to 16,777,216 tokens), like 24K.";
}
/** Settings -> Models -> Sub-agents -> Context window: the same box as DGC Router's Context each (src/contextCombo.js),
 *  its first choice "Same as the main session" (blank: subagent_context_size 0). */
function subagentWindowBox(c) {
    const tokens = parseContext(c?.subagent_context_size);
    return contextComboHTML({ id: "subagent_context_size", value: typeof tokens === "number" && tokens > 0 ? tokens : "",
        blank: "Same as the main session", label: "Context window", disabled: !c?.subagent_window_settable });
}

/** The number Context size shows: the window in use, so never more than a server's own window (above it can't apply). */
export function contextSizeShown(c) {
    const served = c && c.server_window && Number(c.server_window.window) > 0 ? Number(c.server_window.window) : 0;
    const chosen = Number(c?.context_size) || 0;
    return served && chosen > served ? served : (c?.context_size ?? "");
}

/** A saved provider's name as its row shows it. Ollama's app on this computer is saved as "Ollama (local)"; with a model
 *  that runs in Ollama's cloud (":cloud", "-cloud") the row doesn't call it local. The saved name itself is unchanged. */
export function shownProviderName(row) {
    const name = String(row?.name || "");
    return /^Ollama \(local\)$/i.test(name) && /[:-]cloud$/i.test(String(row?.model || "")) ? "Ollama" : name;
}
// Settings → Dev Mode: the user's own switch for DGC's Dev Mode tools (config key dev_mode_tools), and its one quiet line.
export const DEV_TOOLS_NAME = "Let DGC change Dev Mode settings";
export const DEV_TOOLS_LINE = "When you ask, DGC can change these limits itself (it says what it changed, with Undo). It can never turn on Dev Mode.";
// Settings → Dev Mode: "Work on a subscription uses DGC's tools" (config key dev_subscription_tools), its line, and the
// warning that shows once, the first time it is turned on.
export const DEV_SUB_NAME = "Work on a subscription uses DGC's tools";
export const DEV_SUB_LINE = "Claude Code or Codex is Work's model only: its own tools stay off, and DGC's tools, permissions and helpers do the work.";
export const DEV_SUB_WARNING_TITLE = "Claude Code or Codex as Work's model, with DGC's tools";
export const DEV_SUB_WARNING_WORDS = "The provider's terms may not allow running its CLI as the model behind another tool's loop: you decide whether to use it. "
    + "DGC never reads, copies or refreshes the CLI's login, and never calls the provider with it: the CLI signs in for itself. "
    + "Every tool call is DGC's, by your permission mode. Off, Work hands each turn to the CLI as before. Kimi Code, Qwen Code and Copilot CLI always run as before.";
// Settings → Dev Mode → Limits: a limit's box, by DGC's own name for it.
export const devLimitId = (name) => `dev_limit_${name}`;
/** DGC's rows of limits as the page may draw them: a name, a label, today's default and a cost line. */
export function devLimitRows(rows) {
    return (Array.isArray(rows) ? rows : []).filter((row) => row && typeof row === "object" && /^[a-z][a-z0-9_]{0,63}$/.test(String(row.name || "")) && Number.isFinite(Number(row.default)))
        .map((row) => ({ name: String(row.name), label: String(row.label || row.name), default: Number(row.default), cost: String(row.cost || "") }));
}
/** What DGC refused, by the limit it is about. It says "pip_computers: a whole number, 1 or more": the name is DGC's
 *  own, so the words after it go beside that box ("A whole number, 1 or more."). A refusal about nothing on the page
 *  gives none, and stays on the Save line. */
export function devLimitProblems(message, rows) {
    const out = {}, text = String(message || "");
    for (const { name } of devLimitRows(rows)) {
        const at = text.match(new RegExp(`(?:^|[^a-z0-9_])${name}: ([^\n]+)`));
        if (!at) continue;
        const words = at[1].trim().replace(/[.\s]+$/, "");
        if (words) out[name] = words[0].toUpperCase() + words.slice(1) + ".";
    }
    return out;
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
    const group = (title, body, note = "", id = "") => `<section class="group"${id ? ` id="${id}"` : ""}><h3>${title}</h3>${note ? `<p class="group-note">${note}</p>` : ""}<div class="rows">${body}</div></section>`;
    // A disclosure that remembers being open across redraws; open by itself when what it holds is set.
    const more = (key, summary, body, set) => `<details class="more" data-more="${key}"${OPEN.has(key) || set ? " open" : ""}><summary>${summary}</summary>${body}</details>`;
    const advanced = (key, body) => `<section class="group group-more"><div class="rows">${more(key, "Advanced", body, false)}</div></section>`;
    // A host with its presets beside it: picking one fills the host (settingsClient lists its models again).
    const hostRow = (id, presetId, value) => `<div class="field host-field"><span class="words"><span class="name-line"><label class="name" for="${id}">Host</label></span></span>`
        + `<span class="host-control">${inp(id, value)}${presetId ? sel(presetId, [["", "Presets"], ...providers.map((p) => [p.id, p.label])], "") : ""}</span></div>`;
    const saveBar = ui.saveBar();
    const hostName = (url) => { try { return new URL(url).host; } catch { return String(url || ""); } };
    function wire(main) {
        main.querySelectorAll("details.more[data-more]").forEach((d) => d.addEventListener("toggle", () => { if (d.open) OPEN.add(d.dataset.more); else OPEN.delete(d.dataset.more); }));
        // A preset's select is only a way to fill the host: it never shows a stale choice.
        main.querySelectorAll(".host-control select").forEach((el) => { const label = "Fill the host from a preset"; el.setAttribute("aria-label", label); el.title = label; });
    }
    function renderGeneral(main) {
        const c = config;
        const think = c.subscription_engine ? (c.subscription_effort || "off") : (c.think || "off");
        const shown = c.show_reasoning === false ? "hidden" : c.thinking_inline === false ? "collapsed" : "inline";
        main.innerHTML = head("General", "How DGC works on this computer.")
            + group("Turns", field("Permission mode", "What DGC may do in this Work session.", sel("mode", [["default", "Default"], ["acceptEdits", "Accept edits"], ["plan", "Plan"], ["auto", "Auto"]], c.mode || "default"),
                    "Default asks before it changes anything. Accept edits applies file edits without asking. Plan reads and proposes only. Auto acts without asking, so it is chosen for one Work session at a time, here or in the mode menu. A new session starts in Default, or in the mode you saved with dgc in a terminal unless that is Auto. A session you reopen, or this one after a reload, comes back in the mode it had, Auto included, in a folder that is still trusted. Security's sandbox applies in every mode.")
                + field("Thinking", "How hard the model thinks first.", sel("think", [["off", "Off"], ["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"], ["max", "Max"]], think),
                    "Applies from the next model round.")
                + field("DGC Ultra", "Splits big turns across sub-agents.", bool("ultra_mode", c.ultra_mode === true),
                    "Extra guidance and sub-agents for larger turns, at the deepest thinking. Permissions stay as set. How many run at once is under Agents.")
                + field("Token cap per turn", c.budget_settable ? "0 means no cap." : old, inp("turn_token_budget", c.turn_token_budget ?? 0, "number"),
                    c.budget_settable ? "Tokens one turn may spend, sub-agents included. When it is reached, no new sub-agent starts and the turn wraps up, keeping its work." : "")
                + field("Context window", contextSizeHint(c), inp("context_size", contextSizeShown(c), "number"), contextSizeMore(c)))
            + group("What you see", field("Show thinking", "Inline, collapsed or hidden.", sel("show_reasoning", [["inline", "Inline"], ["collapsed", "Collapsed"], ["hidden", "Hidden"]], shown))
                + field("Pictures in replies", "Shown, or folded to one line.", sel("pictures_in_replies", [["shown", "Shown"], ["folded", "Folded"]], c.pictures_in_replies === "folded" ? "folded" : "shown"),
                    "Pictures and videos in a reply, in Work, ChatDGC and a Pip's chat. Folded, each block is one line you click to open. Folding or opening one reply's pictures yourself holds for that reply. Saved at once, for this editor.")
                + field("Prompt suggestions", "Suggests what to ask next.", bool("suggest", c.suggest !== false),
                    "A grey suggestion in the message box after a reply; Tab or → takes it.")
                + field("Wake on output", "DGC looks when a watched command prints.", bool("monitor_wake", c.monitor_wake !== false),
                    "DGC can keep a command running in the background and watch what it prints: a log, a build, a test run. On: each time it prints, DGC starts a short turn to read it and tell you if it matters. Off: it only reads it when you ask."))
            // The dock at the foot of DGC's side bar: the editor's own settings (dgc.dock.*), saved at once.
            + group("Dock", field("Show the dock", "On every screen of the side bar.", sel("dock_show", [["always", "Always"], ["hover", "When I point at the bottom"], ["never", "Never"]], ["hover", "never"].includes(c.dock_show) ? c.dock_show : "always"),
                    "Always: the dock has its own room at the foot of the side bar. When I point at the bottom: it rises over the page when the pointer reaches the bottom edge, and drops away about a second after it leaves. Never: no dock; what you pinned is kept. Saved at once, for this editor.")
                + field("Most items", "8 fit a 300 px side bar. Up to 16.", inp("dock_most", c.dock_most ?? 8, "number"),
                    "Past this, pinning one more asks which item to take off. Icons shrink as items are added, down to 24 px; if they still can't fit, the dock steps aside until the side bar is wider. Nothing is unpinned.")
                + field("Icon size", "The largest the icons get, in px.", inp("dock_size", c.dock_size ?? 34, "number"),
                    "From 24 to 48. The icons take this size while there is room, and grow a little under the pointer."),
                "Pinned Pips, sessions and files at the foot of DGC's side bar.", "settings-dock")
            + advanced("general-advanced", field("Tool profile", "Which tools each turn is offered.", sel("tool_profile", [["standard", "Standard"], ["adaptive", "Adaptive"], ["full", "Full catalog"]], c.tool_profile || "standard"),
                "Standard offers every DGC tool on every turn and lets the model choose. Adaptive offers the core coding tools and adds the rest only when you ask for them, which keeps a small local window clear. Full catalog offers every tool the permission mode allows."))
            + saveBar;
        const cap = main.querySelector("#turn_token_budget");
        if (cap) { cap.min = "0"; cap.step = "1000"; if (!c.budget_settable) cap.disabled = true; }
        const most = main.querySelector("#dock_most"), size = main.querySelector("#dock_size");
        if (most) { most.min = "1"; most.max = "16"; most.step = "1"; }
        if (size) { size.min = "24"; size.max = "48"; size.step = "1"; }
        wire(main);
    }
    function renderModels(main) {
        const c = config;
        const savedProviders = Array.isArray(ui.providerProfiles) ? ui.providerProfiles : [];
        const providerDraft = ui.providerDraft || {};
        // A subscription's own state, as the backend sees it: a CLI that has gone or signed out says so here, and how to fix it.
        const subscriptionState = (row) => {
            const info = (Array.isArray(c.subscription_engines) ? c.subscription_engines : []).find(item => item && item.key === row.engine);
            if (info?.installed === false) return { problem: true, text: `Its CLI isn't installed on this computer. Install it first.` };
            // Sign in runs the app's own sign-in in a terminal here (signInApp); it opens the browser itself.
            if (info?.auth_state === "signed_out") return { problem: true, signIn: true, text: `Not signed in on this computer.` };
            return { problem: false, text: "Signed-in CLI" };
        };
        // Provider sign-ins (17 Nov): OpenRouter's key, checked by the host (providerStates); Ollama here and its ollama.com
        // account (ollamaAccount); a Connect that waits on the browser (providerConnecting), with Cancel.
        const hostOf = (url) => { try { return new URL(String(url || "")).host.toLowerCase(); } catch { return ""; } };
        const isOpenRouter = (row) => row.kind !== "subscription" && hostOf(row.base_url).replace(/^www\./, "") === "openrouter.ai";
        const isLocalOllama = (row) => row.kind !== "subscription" && /^(localhost|127\.0\.0\.1|\[::1\]):11434$/.test(hostOf(row.base_url));
        const connecting = ui.providerConnecting && ui.providerConnecting.waiting ? ui.providerConnecting : null;
        const cancelButton = `<button type="button" class="secondary" data-provider-connect-cancel>Cancel</button>`;
        const money = (n) => `$${Number(n).toFixed(2)}`;
        const signInButton = (app, name) => `<button type="button" class="secondary" data-app-signin="${escapeHtml(app)}" aria-label="Sign in to ${escapeHtml(name)}">Sign in</button>`;
        // What a row adds after its usual words, and the buttons it adds before Remove.
        const rowExtras = (row, state) => {
            if (state?.signIn) return { words: "", buttons: signInButton(row.engine, row.name) };
            // ChatGPT · your plan (its state from the host, which alone can tell a plan row by its key's marker).
            const planState = (ui.providerStates || {})[row.id];
            if (planState?.state === "plan") {
                const waiting = connecting && connecting.id === row.id;
                // "Connected", as OpenAI's sign-in asks; "Using ChatGPT plan" is said beside each chat's model picker.
                if (planState.plan === "connected") return { words: `Connected${planState.name ? ` as ${String(planState.name)}` : ""}`,
                    buttons: `<button type="button" class="secondary" data-plan-usage>Manage usage</button><button type="button" class="secondary" data-plan-signout>Sign out</button>` };
                return { problem: String(planState.error || "Signed out of ChatGPT"),
                    buttons: `<button type="button" class="secondary" data-provider-reconnect="${escapeHtml(row.id)}"${waiting ? " disabled" : ""}>${waiting ? "Waiting…" : "Connect again"}</button>${waiting ? cancelButton : ""}` };
            }
            if (isOpenRouter(row)) {
                const key = (ui.providerStates || {})[row.id];
                const waiting = connecting && connecting.id === row.id;
                if (key?.state === "signed_out") return { problem: String(key.error || "Signed out of OpenRouter"),
                    buttons: `<button type="button" class="secondary" data-provider-reconnect="${escapeHtml(row.id)}"${waiting ? " disabled" : ""}>${waiting ? "Waiting…" : "Connect again"}</button>${waiting ? cancelButton : ""}` };
                if (key?.state === "no_credit") return { problem: "Out of OpenRouter credits",
                    buttons: `<button type="button" class="secondary" data-provider-topup="${escapeHtml(row.id)}">Top up</button>` };
                if (key?.state === "ok" && key.limit != null && typeof key.limit_remaining === "number") return { words: `${money(key.limit_remaining)} left`, buttons: "" };
            }
            if (isLocalOllama(row) && ui.ollamaAccount) {
                if (ui.ollamaAccount.signed_in) return { words: `Signed in to ollama.com${ui.ollamaAccount.name ? ` as ${String(ui.ollamaAccount.name)}` : ""}`, buttons: "" };
                return { words: "Not signed in to ollama.com (its cloud models need it)", buttons: signInButton("ollama", "ollama.com") };
            }
            return { words: "", buttons: "" };
        };
        // The default's model, chosen on its row: an All models provider needs one to be the default at all; a subscription's
        // first choice is its CLI's own. The row keeps saying what the provider is; the dropdown says what new chats start on.
        const defaultModelPicker = (row, current) => {
            const list = (ui.providerModels || {})[row.id] || {};
            const subscribed = row.kind === "subscription";
            const label = `Default model for ${escapeHtml(row.name)}`;
            if (ui.typingDefaultModel === row.id) return `<input class="provider-default-model" type="text" data-provider-default-typed="${escapeHtml(row.id)}" value="${escapeHtml(current)}" placeholder="Model name" aria-label="${label}" autocomplete="off" spellcheck="false">`;
            const named = [...new Set([...(current ? [current] : []), ...(Array.isArray(list.ids) ? list.ids.filter(Boolean) : [])])];
            const first = subscribed ? [["", "CLI default"]] : current ? [] : [["", list.loading ? "Listing its models…" : list.error ? "Couldn't list its models" : named.length ? "Choose a model" : "It lists no models"]];
            const options = [...first, ...named.map(id => [id, id]), ["--other--", "Enter another model…"]];
            return `<select class="provider-default-model" data-provider-default-model="${escapeHtml(row.id)}" aria-label="${label}" title="The model new sessions, chats and Pips on Default start on">${options.map(([value, words]) => `<option value="${escapeHtml(value)}"${value === current ? " selected" : ""}>${escapeHtml(words)}</option>`).join("")}</select>`;
        };
        const savedRows = savedProviders.map(row => {
            const state = row.kind === "subscription" ? subscriptionState(row) : null;
            const allModels = row.kind !== "subscription" && !row.model;
            // One provider is the default. With several, a checkbox on each says which.
            const only = savedProviders.length === 1 && !ui.directProvider;
            const choosing = ui.choosingDefaultId === row.id || (only && allModels && ui.defaultProviderId !== row.id);
            const isDefault = ui.choosingDefaultId ? ui.choosingDefaultId === row.id : ui.defaultProviderId === row.id || only;
            const current = !isDefault ? "" : allModels ? (ui.defaultProviderId === row.id ? String(ui.defaultProviderModel || "") : "") : String(row.model || "");
            // The default row's dropdown names its model, so its words don't say it twice. All models always says so.
            const said = allModels ? "All models" : isDefault ? "" : row.model || "CLI default";
            const extra = rowExtras(row, state);
            const detail = extra.problem ? `<span class="provider-problem">${escapeHtml(extra.problem)}</span>`
                : state ? `<span class="${state.problem ? "provider-problem" : ""}">${escapeHtml(state.text)}</span>`
                : escapeHtml(row.base_url) + (extra.words ? ` · ${escapeHtml(extra.words)}` : "");
            const hint = `${said ? escapeHtml(said) + " · " : ""}${detail}`;
            const choice = only
                ? `<span class="provider-default-only">Default</span>`
                : `<label class="provider-default-check"><input type="checkbox" data-provider-default="${escapeHtml(row.id)}" aria-label="Make ${escapeHtml(row.name)} the default"${isDefault ? " checked" : ""}>Default</label>`;
            const picker = isDefault || choosing ? defaultModelPicker(row, current) : "";
            return `<div class="field provider-row${picker ? " with-default-model" : ""}"><span class="words"><span class="name-line"><span class="name">${escapeHtml(shownProviderName(row))}</span></span><span class="hint">${hint}</span></span><span class="host-control">${choice}${picker}${extra.buttons}<button type="button" class="secondary" data-provider-remove="${escapeHtml(row.id)}" aria-label="Remove ${escapeHtml(row.name)}">Remove</button></span></div>`;
        }).join("");
        // The default from before saved providers: its key is only DGC's, so it isn't one of them, and it is still the default.
        const direct = ui.directProvider;
        // Ollama here as the default from before saved providers says its ollama.com sign-in too (an upgrade's usual case).
        const directExtra = direct && isLocalOllama({ base_url: direct.base_url }) ? rowExtras({ base_url: direct.base_url }, null) : { words: "", buttons: "" };
        const directRow = direct ? `<div class="field provider-direct"><span class="words"><span class="name-line"><span class="name">${escapeHtml(direct.name)}</span></span><span class="hint">${escapeHtml(direct.model)} · ${escapeHtml(direct.base_url)}${directExtra.words ? ` · ${escapeHtml(directExtra.words)}` : ""}</span></span><span class="host-control">${directExtra.buttons}<span class="provider-default-only">Default</span></span></div>` : "";
        const configuredUrls = new Set(savedProviders.map(row => String(row.base_url || '').replace(/\/+$/, '').toLowerCase()));
        // OpenAI's API and ChatGPT · your plan share an address: each is taken only by a saved row that is itself (the plan
        // is saved under its own name), never by the other.
        const planLabel = (providers.find(row => row.plan) || {}).label || "";
        const urlOf = (url) => String(url || '').replace(/\/+$/, '').toLowerCase();
        const availableHosts = providers.filter(row => !savedProviders.some(saved => urlOf(saved.base_url) === urlOf(row.url)
            && (row.plan ? saved.name === row.label : saved.name !== planLabel || !planLabel)));
        const savedEngines = new Set(savedProviders.filter(row => row.kind === "subscription").map(row => row.engine));
        const addChoices = [["", "Choose a provider"], ...availableHosts.map(row => [row.id, row.label]),
            ...[["claude", "Claude Code"], ["codex", "Codex"]].filter(([id]) => !savedEngines.has(id)),
            ["custom", "Custom model host"]];
        const addingSubscription = providerDraft.kind === "subscription";
        const addingPlan = !!providers.find(row => row.id === providerDraft.preset && row.plan);
        const keysPreset = providers.find(row => row.id === providerDraft.preset && row.keys && row.url);
        // A preset that signs in (OpenRouter): Connect opens its page and its key comes back here; pasting one still works.
        const connectPreset = providers.find(row => row.id === providerDraft.preset && row.connect && row.url);
        const addWaiting = !!(connecting && !connecting.id);
        const keysHost = (row) => escapeHtml(row.keysHost || new URL(row.url).hostname);
        const keyField = connectPreset && connectPreset.plan
            ? field("Account", "Connect opens chatgpt.com: sign in and allow DGC to use your plan (ChatGPT Plus or Pro). No key needed.",
                `<span class="host-control"><button type="button" class="secondary" data-provider-connect="${escapeHtml(connectPreset.id)}"${addWaiting ? " disabled" : ""}>Connect</button></span>`)
            : connectPreset
            ? field("Account", `Connect opens ${keysHost(connectPreset)}: sign in and approve DGC, and its key comes back here. Or paste a key.`,
                // The box says what it is for (it sits empty beside Connect); Connect on the right, where Get a key sits.
                `<span class="host-control">${inp("saved_provider_key", providerDraft.api_key || "", "password").replace("<input ", '<input placeholder="Or paste a key" aria-label="Or paste an OpenRouter key" ')}`
                + `<button type="button" class="secondary" data-provider-connect="${escapeHtml(connectPreset.id)}"${addWaiting ? " disabled" : ""}>Connect</button></span>`)
            : keysPreset
                // A preset with a keys page of its own: Get a key opens it; you create one there and paste it.
                ? field("API key", `Get a key opens ${keysHost(keysPreset)}: create one there and paste it here. Saved in VS Code.`,
                    `<span class="host-control">${inp("saved_provider_key", providerDraft.api_key || "", "password")}`
                    + `<button type="button" class="secondary" data-provider-keys="${escapeHtml(keysPreset.id)}">Get a key</button></span>`)
                : field("API key", "Saved in VS Code, never shown again.", inp("saved_provider_key", providerDraft.api_key || "", "password"));
        const waitingWords = addWaiting ? `Waiting for ${escapeHtml((providers.find(row => row.id === connecting.preset) || {}).label || "the provider")} in your browser…` : "";
        const addSaved = `<details class="more" data-more="saved-providers"><summary>+ Add provider</summary><div class="rows">`
            + field("Provider", "Choose the connection to add.", sel("saved_provider_preset", addChoices, providerDraft.preset || ""))
            + (addingSubscription ? field("Model", "Blank uses the signed-in CLI's default.", inp("saved_provider_model", providerDraft.model || ""))
                : addingPlan ? model("saved_provider_model", "Model", "Each session or chat can choose, or name one.", providerDraft.model || "All models") + keyField
                : field("Name", "Shown in the model menu.", inp("saved_provider_name", providerDraft.name || ""))
                + field("Host", "Reachable from this computer.", inp("saved_provider_url", providerDraft.base_url || ""))
                + model("saved_provider_model", "Model", "Each session or chat can choose, or name one.", providerDraft.model || "All models")
                + field("Transport", "Auto works for most hosts.", sel("saved_provider_mode", TRANSPORTS, providerDraft.api_mode || "auto"))
                + keyField)
            + `<div class="field"><span class="words"><span class="hint" id="saved-provider-status" role="status">${waitingWords}</span></span><span class="host-control">${addWaiting ? cancelButton : ""}${addingPlan ? "" : `<button type="button" class="secondary" id="saved-provider-add">Save provider</button>`}</span></div></div></details>`;
        const engine = String(c.subscription_engine || "");
        const subscription = (Array.isArray(c.subscription_engines) ? c.subscription_engines : [])
            .find(row => row && row.key === engine);
        const models = Array.isArray(subscription?.model_hints) ? subscription.model_hints : [];
        const cliDefault = String(subscription?.cli_default_model || "");
        const defaultHint = engine === "codex" && cliDefault
            ? `CLI default: ${escapeHtml(cliDefault)}${subscription?.cli_default_listed === false ? " · not in this account's model list" : ""}.`
            : "Blank uses the CLI's own.";
        const subscriptionModelInput = inp("subscription_model", c.subscription_model || "")
            .replace('id="subscription_model"', 'id="subscription_model" list="subscription-models"')
            + `<datalist id="subscription-models">${models.map(id => `<option value="${escapeHtml(id)}"></option>`).join("")}</datalist>`;
        const anthropic = /(^|\.)anthropic\.com/i.test(hostName(c.base_url)) || c.api_mode === "anthropic";
        const cacheLife = field("Cache lifetime", c.cache_settable ? "How long Anthropic keeps it." : old,
            sel("prompt_cache_ttl", [["5m", "5 minutes"], ["1h", "1 hour"]], c.prompt_cache_ttl === "1h" ? "1h" : "5m"),
            c.cache_settable ? "Anthropic only. 5 minutes suits replies that follow each other; 1 hour keeps the cache between replies further apart, and each write costs more." : "");
        main.innerHTML = head("Models", "Choose the providers DGC can use in Work, ChatDGC and Pips.")
            + group("Providers", directRow + savedRows + addSaved,
                "With no model yet, the first provider becomes the default. With several, choose the default for new sessions, chats and Pips here; each can switch providers in its model menu.")
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
            + helperBlocks()
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
        if (pick && rows) pick.addEventListener("change", () => {
            rows.hidden = !pick.value;
            const native = main.querySelector("[data-when-native]");
            if (native) native.hidden = !!pick.value;
            pick.dispatchEvent(new Event("input", { bubbles: true }));
        });
        const box = main.querySelector("#subscription_model");
        if (box) box.placeholder = "The CLI's default";
        wireHelpers(main);
        wire(main);
    }
    // Settings -> Models, after the main model: Fallback, Sub-agents, Pips, Images and DGC Router (the plan's blocks).
    // Images and DGC Router save as they change (settingsImages.js, settingsRouter.js), apart from Save all.
    // With DGC Router on, Sub-agents says the Router chooses (the usual model one click away, for when it is off or
    // every worker is busy) and Pips can run on any Pip system, or one system and model.
    function helperBlocks() {
        const c = config, router = ui.router;
        const routed = !!(router && router.capable() && router.on());
        const subHost = String(c.subagent_base_url || ""), fallbackHost = String(c.fallback_base_url || "");
        const routeRows = (prefix, presetId) => hostRow(`${prefix}_base_url`, presetId, c[`${prefix}_base_url`] || "")
            + field("Transport", "Inherit uses the main one.", sel(`${prefix}_api_mode`, [["", "Inherit"]].concat(TRANSPORTS), c[`${prefix}_api_mode`] || ""),
                "Inherit uses the main transport on the main host, and Auto on any other.")
            + field("API key", "Blank keeps the saved key.", inp(`${prefix}_api_key`, c[`${prefix}_api_key`] || "", "password"),
                "Saved for this host only. With none here, the main key goes only to the main host.");
        // Sub-agents' Model (0.52): a provider and one of its models. A saved provider fills its address and API here
        // (its key goes with the Save, in the extension), so nobody types a host; Claude Code and Codex are shown,
        // greyed, with why; an address no provider lists is Another host, one click away.
        const saved = Array.isArray(ui.providerProfiles) ? ui.providerProfiles.filter((row) => row && row.id) : [];
        const fromProvider = subHost ? saved.find((row) => row.kind !== "subscription" && sameAddress(row.base_url, subHost)) : null;
        const from = fromProvider && !agentsAnotherHost ? fromProvider.id : subHost || agentsAnotherHost ? "custom" : "";
        if (agentsHostShown && from !== "custom") OPEN.delete("subagent-host");
        agentsHostShown = from === "custom";
        const fromChoices = [["", "Same as the main session", false],
            ...saved.map((row) => (row.kind === "subscription" ? [row.id, `${row.name} (can’t run DGC’s agents)`, true] : [row.id, row.name, false])),
            ["custom", "Another host…", false]];
        const fromSelect = `<select id="subagent_from" aria-label="Provider for sub-agents" title="Whose models sub-agents use">`
            + fromChoices.map(([value, words, off]) => `<option value="${escapeHtml(value)}"${value === from ? " selected" : ""}${off ? " disabled" : ""}>${escapeHtml(words)}</option>`).join("") + `</select>`;
        const agentsModel = () => model("subagent_model", "Model", "A provider, and one of its models.", c.subagent_model || "",
            { before: fromSelect, more: `Same as the main session uses the main session's provider; with no model named, its model too. A model from another provider brings its address, API and key with it. ${AGENTS_CLI_REASON} Each Work session can choose its own in its model menu, for that session only.` });
        const anotherHost = () => more("subagent-host", from === "custom" && subHost ? `Another host · ${escapeHtml(hostName(subHost))}` : "Another host", routeRows("subagent", "subagent_provider"), from === "custom");
        const usual = agentsModel()
            + field("Context window", c.subagent_window_settable ? "Tokens each keeps before it compacts." : old,
                subagentWindowBox(c))
            + anotherHost();
        const runAtOnce = field("Run at once", parallelHint(c), inp("max_parallel_tasks", c.max_parallel_tasks ?? 4, "number"), parallelMore(c));
        // How hard each helper thinks (subagent_thinking), from a CLI that answers it. Which level wins: a DGC Router
        // model's own choice, then the agent file's effort:, then this, then the main chat's.
        const thinking = c.subagent_thinking_settable ? field("Thinking", "How hard each helper thinks.",
            sel("subagent_thinking", SUBAGENT_THINKING_CHOICES, SUBAGENT_THINKING_CHOICES.some(([v]) => v === c.subagent_thinking) ? c.subagent_thinking : ""),
            "Same as the main session follows the session's own level. An agent file's effort: wins over this, and on DGC Router a model's own Thinking wins over both; a model that can't think ignores it.") : "";
        const subagents = routed
            ? group("Sub-agents", `<div class="row-line router-chosen"><span class="words"><span class="name" id="router-subagents-line">${escapeHtml(router.summary())}</span>`
                    + `<span class="hint">DGC picks a free worker for each. <button type="button" class="link" data-router-goto>See systems</button></span></span></div>`
                + runAtOnce + thinking
                + more("subagent-usual", "The usual sub-agent model", usual, false), "", "models-subagents")
            : group("Sub-agents", agentsModel() + runAtOnce + thinking
                + field("Context window", c.subagent_window_settable ? "Tokens each keeps before it compacts." : old,
                    subagentWindowBox(c))
                + anotherHost(), "", "models-subagents");
        const following = "Same as DGC" + (followed(c) ? ` (${followed(c)})` : "");
        const pipsValue = String(c.pips_model || "");
        const pipsOnRouter = routed && router.pipsDefault() && c.pips_settable;
        const pips = pipsOnRouter
            ? group("Pips", field("Pips run on", "A Pip can still choose its own.",
                sel("pips_model", pipsRouterOptions(router, pipsValue, following), pipsValue),
                "Every Pip set to Default runs there: on any computer with the Pips job, or on one system and model. Off the Router, they use DGC's own connection."), "", "models-pips")
            : group("Pips", model("pips_model", "Model for Pips", c.pips_settable ? "Every Pip set to Default uses it." : old, /^router(:|$)/.test(pipsValue) ? "" : pipsValue), "", "models-pips");
        // Images (settingsImages.js): only from a CLI that makes them (ready.capabilities.images); an older one has none.
        const images = ui.images && ui.images.capable() ? ui.images.block() : "";
        // A model that can see (settingsSeeing.js): for a chat whose own model can't see a picture.
        const seeing = ui.seeing && ui.seeing.capable() ? ui.seeing.block() : "";
        return group("Fallback", model("fallback_model", "Model", "Tried when the main model fails.", c.fallback_model || "")
                + more("fallback-host", fallbackHost ? `Another host · ${escapeHtml(hostName(fallbackHost))}` : "Another host", routeRows("fallback", ""), !!fallbackHost), "", "models-fallback")
            + subagents + seeing + pips + images + (router ? router.routerBlock() : "");
    }
    function pipsRouterOptions(router, value, following) {
        const choices = pipChoices(router.status());
        const known = new Set(choices.map(([v]) => v));
        const rest = [["", `Not the Router: ${following}`]];
        if (value && !known.has(value) && !/^router(:|$)/.test(value)) rest.push([value, `Not the Router: ${value}`]);
        if (/^router:/.test(value) && !known.has(value)) choices.push([value, `${value.slice(7).replace("/", " · ")} (not offered now)`]);
        return choices.concat(rest);
    }
    function wireHelpers(main) {
        const c = config;
        const placeholders = { subagent_model: "Same as the main model", fallback_model: "None", subagent_base_url: "Same as the main host", fallback_base_url: "Same as the main host" };
        for (const [id, text] of Object.entries(placeholders)) { const el = main.querySelector("#" + id); if (el) el.placeholder = text; }
        // Sub-agents' provider: choosing one fills the address, API and its own model; the page is drawn again so the
        // Model box lists that host and Another host says what it is.
        const from = main.querySelector("#subagent_from");
        if (from) from.addEventListener("input", (event) => {
            event.stopPropagation();
            const set = (id, value) => { const el = main.querySelector("#" + id); if (el) el.value = value; };
            const row = (Array.isArray(ui.providerProfiles) ? ui.providerProfiles : []).find((item) => item && item.id === from.value && item.kind !== "subscription");
            agentsAnotherHost = from.value === "custom";
            if (agentsAnotherHost) OPEN.add("subagent-host"); else OPEN.delete("subagent-host");
            if (row) { set("subagent_base_url", row.base_url || ""); set("subagent_api_mode", row.api_mode || ""); set("subagent_model", row.model || ""); set("subagent_api_key", ""); }
            else if (!from.value) { set("subagent_base_url", ""); set("subagent_api_mode", ""); set("subagent_model", ""); set("subagent_api_key", ""); }
            ui.redraw();
            const next = document.getElementById(agentsAnotherHost ? "subagent_base_url" : "subagent_from");
            next?.focus?.();
        });
        const fallbackHint = main.querySelector("#fallback_model")?.closest(".field")?.querySelector(".hint");
        if (fallbackHint) fallbackHint.title = "If the main model fails or stalls, DGC tries this one.";
        const pipsBox = main.querySelector("#pips_model");
        if (pipsBox && pipsBox.tagName !== "SELECT") {
            pipsBox.placeholder = "Same as DGC" + (followed(c) ? ` (${followed(c)})` : "");
            if (!c.pips_settable) pipsBox.disabled = true;
        }
        const window = main.querySelector("#subagent_context_size");
        if (window) {
            // 2K and up, typed or picked; blank is the main chat's own (the box's first choice).
            const check = () => window.setCustomValidity(subagentWindowProblem(window.value));
            window.addEventListener("input", check);
            window.addEventListener("change", check);
            check();
            if (!c.subagent_window_settable) window.disabled = true;
        }
        if (pipsBox?.tagName === "SELECT" && !c.pips_settable) pipsBox.disabled = true;
        // The Router is off but the Pips default is set to it: the box shows DGC's own, and the choice is kept unless
        // something else is typed (it applies again when the Router is back on).
        if (pipsBox && pipsBox.tagName !== "SELECT" && /^router(:|$)/.test(String(c.pips_model || ""))) {
            pipsBox.dataset.keepRouter = "1";
            pipsBox.placeholder = "Same as DGC (DGC Router when it's on)";
        }
        main.querySelector("[data-router-goto]")?.addEventListener("click", () => {
            main.querySelector("#models-router")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
            main.querySelector("#router-on")?.focus({ preventScroll: true });
        });
        const routerBlock = main.querySelector("#models-router");
        if (routerBlock && ui.router) ui.router.bind(routerBlock);
        const imagesBlock = main.querySelector("#models-images");
        if (imagesBlock && ui.images) { ui.images.bind(imagesBlock); ui.images.shown(); }
        const seeingBlock = main.querySelector("#models-seeing");
        if (seeingBlock && ui.seeing) { ui.seeing.bind(seeingBlock); ui.seeing.shown(); }
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
                    "Off keeps plan mode to reading and proposing: it can't start a preview.")
                // Where pages open from (the CLI's /artifact had it; the extension didn't: 21 Nov).
                + ("artifact_bind" in c ? field("Open pages from", c.artifact_bind === "lan" ? "Other devices can open them too." : "Only this computer opens them.",
                    sel("artifact_bind", [["localhost", "This computer only"], ["lan", "Your network and Tailscale"]], c.artifact_bind || "localhost"),
                    "Your network and Tailscale: your phone or another computer on the same network or tailnet opens a page DGC serves. Anyone there with its link can see it.")
                  + field("Address for links", "Optional: a name your devices use.", inp("artifact_hostname", c.artifact_hostname || ""),
                    "A Tailscale name (gpu-box.tail1234.ts.net) or a host:port. Empty: links use this computer's own address.") : ""))
            // A link's preview card (src/linkPreview.ts): the editor's own setting, so it applies at once, apart from Save.
            + group("Links", field("Show a preview when you point at a link", "Reads public pages only.", ui.editorBool("link_previews", c.link_previews !== false, "Show a preview when you point at a link"),
                    "Rest the pointer on a link in a chat and a card shows the site's name, picture, title and description. DGC reads only the top of a public page, with no sign-in and no cookies: never a private, local or tailnet address, a one-time link, or an address that holds a secret. Off: nothing is read.")
                    // What previews read today: the count, and each site one click away (src/linkPreview.ts sentToday).
                    + more("link-previews-sent", `<span>Sites read for previews today: <span id="link-previews-sent-count">0</span></span>`,
                           `<ul id="link-previews-sent-list" class="sent-list"><li class="sent-none">None yet today.</li></ul>`, false), "", "settings-links")
            // What an Always allow on a card made, in words, each with Remove (user test W8). Removed at once: not
            // part of Save.
            + group("Always allowed", ui.rules == null ? '<div class="row-line rule-line"><span class="words"><span class="hint" role="status">Reading the rules from DGC…</span></span></div>'
                : !ui.rules.length ? '<div class="row-line rule-line"><span class="words"><span class="hint">Nothing yet. Always allow on a card adds a rule here.</span></span></div>'
                : ui.rules.map((row, i) => `<div class="row-line rule-line"><span class="words"><span class="name">${escapeHtml(row.words)}</span>${/* (Words only: a rule's own line, "Write(/home/…/totals.py)", is not shown under them. User test 2, S7. A project's folder is.) */
                    row.detail && row.detail !== row.words && !(row.rules || []).includes(row.detail) ? `<span class="hint rule-detail">${escapeHtml(row.detail)}</span>` : ""}</span>`
                    + `<button type="button" class="secondary" data-rule-remove="${i}" title="Remove this rule: DGC asks again" aria-label="Remove: ${escapeHtml(row.words)}">Remove</button></div>`).join(""),
                "What DGC does without asking, because you chose Always allow on a card. Remove one and it asks again.", "security-rules")
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
                + field("Context window", "What a chat holds before it summarizes.", sel("chatdgc_window", [["8k", "8K: small models"], ["16k", "16K"], ["32k", "32K: standard"], ["64k", "64K"], ["128k", "128K: relaxed"], ["256k", "256K"], ["512k", "512K"], ["1m", "1M"], ["max", "The model's maximum"]], c.chatdgc_window || "32k"),
                    "Larger windows need more memory on your computer; the model's own limit always applies."))
            + group("Custom instructions", field("What should ChatDGC know about you?", "Up to 1,500 characters.", area("chatdgc_about", c.chatdgc_about || "", "For example: I run a small bakery in Pune and prefer metric units."))
                + field("How should ChatDGC respond?", "Up to 1,500 characters.", area("chatdgc_style", c.chatdgc_style || "", "For example: Lead with the answer, then the numbers. Use bullet points.")))
            + saveBar;
        if (!c.chatdgc_settable) main.querySelectorAll(".rows textarea, .rows select, .rows [role=switch]").forEach((el) => { if (el.id !== "chatdgc_web") el.disabled = true; });
        if (!c.search_settable) { const web = main.querySelector("#chatdgc_web"); if (web) web.disabled = true; }
        wire(main);
    }
    // Settings → Dev Mode: off by default, for people experimenting on a big machine. On, each capacity limit in
    // DGC's own table (ready.capabilities.dev_limits, which the extension hands the page as dev_limits_table) is a
    // number you may set: 1 or more, no ceiling. An empty box is that limit's default, and is left out of dev_limits.
    function renderDev(main) {
        const c = config;
        const table = Array.isArray(c.dev_limits_table) ? c.dev_limits_table : [];
        const on = c.dev_mode === true;
        const mine = c.dev_limits && typeof c.dev_limits === "object" ? c.dev_limits : {};
        const refused = c.dev_limit_errors && typeof c.dev_limit_errors === "object" ? c.dev_limit_errors : {};
        // One limit: its name (the box's label), what raising it costs in one line, today's default and the box.
        const line = (limit) => {
            const id = devLimitId(limit.name), said = refused[limit.name] || "";
            return `<div class="field dev-limit"><span class="words"><span class="name-line"><label class="name" for="${id}">${escapeHtml(limit.label)}</label></span>`
                + `<span class="hint" id="${id}-cost">${escapeHtml(limit.cost)}</span>`
                + `<span class="dev-error" id="${id}-error" role="alert">${escapeHtml(said)}</span></span>`
                + `<span class="dev-control"><span class="dev-today" id="${id}-today">Today: ${escapeHtml(limit.default)}</span>`
                + `<input id="${id}" type="number" inputmode="numeric" min="1" step="1" data-dev-limit="${escapeHtml(limit.name)}" value="${escapeHtml(mine[limit.name] ?? "")}" placeholder="Default"`
                + ` aria-describedby="${id}-today ${id}-cost ${id}-error"${said ? ' aria-invalid="true"' : ""} autocomplete="off"></span></div>`;
        };
        // "Let DGC change Dev Mode settings" (dev_mode_tools): the user's own switch for DGC's Dev Mode tools. Only with
        // a DGC that takes the key, and only while Dev Mode is on. The first time, the warning carries it as a tick box;
        // once that has been read the switch under Dev Mode is the one control for it.
        const toolsOffered = c.dev_tools_capable === true;
        const warned = c.dev_mode_warned === true;
        const toolsRow = on && toolsOffered && warned ? field(DEV_TOOLS_NAME, DEV_TOOLS_LINE, bool("dev_mode_tools", c.dev_mode_tools === true)) : "";
        // "Work on a subscription uses DGC's tools" (dev_subscription_tools): only with a DGC that takes the key, only
        // while Dev Mode is on. The first time it is turned on, its warning shows under it, once (Got it).
        const subOffered = c.dev_sub_capable === true;
        const subOn = c.dev_subscription_tools === true;
        const subRow = on && subOffered ? field(DEV_SUB_NAME, DEV_SUB_LINE, bool("dev_subscription_tools", subOn)) : "";
        const subWarning = on && subOffered && subOn && c.dev_sub_warned !== true
            ? '<section class="dev-warning" id="dev-sub-warning" role="alert"><svg viewBox="0 0 21 21" aria-hidden="true"><path d="M10.5 3.5 18.5 17h-16z M10.5 8.5v4 M10.5 14.6v.2"/></svg>'
                + `<div class="dev-warning-body"><strong class="dev-warning-title">${escapeHtml(DEV_SUB_WARNING_TITLE)}</strong>`
                + `<span class="dev-warning-words">${escapeHtml(DEV_SUB_WARNING_WORDS)}</span></div>`
                + '<button type="button" class="secondary" id="dev-sub-warning-ok">Got it</button></section>'
            : "";
        const warning = '<section class="dev-warning" id="dev-warning" role="alert"><svg viewBox="0 0 21 21" aria-hidden="true"><path d="M10.5 3.5 18.5 17h-16z M10.5 8.5v4 M10.5 14.6v.2"/></svg>'
            + '<div class="dev-warning-body"><strong class="dev-warning-title">Dev Mode lifts DGC\'s capacity limits</strong>'
            + '<span class="dev-warning-words">It is for a big machine: more at once, and more kept. Each limit you raise costs memory, disk or model load, and its line says which. '
            + 'Safety limits never move: the sandbox, redaction, approvals and what a Pip may do stay as they are. Nothing changes until you save.</span>'
            // The same choice as the switch below, while the warning is up (decided 14 Nov): off unless ticked.
            + (toolsOffered ? `<label class="dev-warning-tools"><input type="checkbox" id="dev-warning-tools"${c.dev_mode_tools === true ? " checked" : ""}> <span>${DEV_TOOLS_NAME} when you ask</span></label>` : "")
            + '</div>'
            + '<button type="button" class="secondary" id="dev-warning-ok">Got it</button></section>';
        main.innerHTML = head("Dev Mode", "For experimenting on a big machine: it lifts DGC's capacity limits.",
                "A capacity limit is how many things run at once, or how many are kept. Each one you raise costs memory, disk or model load. Safety limits never move: the sandbox, redaction, approvals and what a Pip may do.")
            + `<section class="group"><div class="rows">${field("Dev Mode", on ? "On: each limit below is yours to set." : "Off: every limit is today's default.", bool("dev_mode", on))}${toolsRow}${subRow}</div></section>`
            + (on && !warned ? warning : "")
            + subWarning
            + (on ? group("Limits", table.map(line).join("")
                    + `<div class="field dev-reset"><span class="words"><span class="hint">Empties every box, so each limit is today's default again.</span></span>`
                    + `<button type="button" class="secondary" id="dev-limits-reset"${table.some((l) => mine[l.name] !== undefined && mine[l.name] !== "") ? "" : " disabled"}>Reset to defaults</button></div>`,
                "Any whole number, 1 or more. Leave a box empty to keep today's default.", "settings-dev-limits") : "")
            + saveBar;
        main.querySelector("#dev_mode")?.setAttribute("aria-label", "Dev Mode");
        main.querySelector("#dev_mode_tools")?.setAttribute("aria-label", DEV_TOOLS_NAME);
        main.querySelector("#dev_subscription_tools")?.setAttribute("aria-label", DEV_SUB_NAME);
        wire(main);
    }
    const renderers = { general: renderGeneral, models: renderModels,
        web: renderWeb, chatdgc: renderChatDGC, security: renderSecurity, dev: renderDev };
    if (!Object.hasOwn(renderers, section)) return;
    renderers[section](main);
}

// A plugin's action card in plain words, the same in ChatDGC, a Pip's chat and Work. Composio's multi-execute tool
// (COMPOSIO_MULTI_EXECUTE_TOOL) carries the app calls it makes as {tool_slug, arguments}: each is shown as app ·
// action · its main inputs, "Gmail · Fetch emails · 5 from Inbox", with Composio's own plumbing (session_id, thought,
// sync_response_to_workbench, current_step…) left out. Nothing here changes what is sent: editing a card still edits
// its real inputs. A line is a summary: every app call the Allow covers has one. A call that sends or changes
// something (anything but a read: fetch, get, list, search…) also shows every input it sends under its line, in full
// and with no click (fields): an email's recipient, subject and body are in sight before Send it now. Everything the
// card sends is also one click away on every card, without Edit (sent: "Inputs as sent").
//
// DgcPluginCalls.describe(tool, args) -> [{app, action, inputs, line, read, fields}] for Composio's multi-execute,
// else null; fields is [[name, text], ...], empty for a read.
// DgcPluginCalls.tool(tool, args) -> {read, fields} for a plugin's own tool (find_notes, save_note), by the same rule:
// a read by its verb, and a call that sends or changes something shows every input it sends, in full.
// DgcPluginCalls.sent(tool, args) -> the inputs as sent, as JSON text, with Composio's plumbing left out.
(function (root) {
  "use strict";

  const EXECUTE = "COMPOSIO_MULTI_EXECUTE_TOOL";
  const PLUMBING = new Set(["session_id", "sync_response_to_workbench", "thought", "current_step", "current_step_metric",
                            "memory"]);
  // Composio's app ids (the first part of a tool slug) as each app names itself.
  const APPS = {
    GMAIL: "Gmail", GOOGLECALENDAR: "Google Calendar", GOOGLEDRIVE: "Google Drive", GOOGLEDOCS: "Google Docs",
    GOOGLESHEETS: "Google Sheets", GOOGLESLIDES: "Google Slides", GOOGLECONTACTS: "Google Contacts",
    GOOGLEMEET: "Google Meet", GOOGLETASKS: "Google Tasks", YOUTUBE: "YouTube", NOTION: "Notion", SLACK: "Slack",
    GITHUB: "GitHub", GITLAB: "GitLab", OUTLOOK: "Outlook", ONEDRIVE: "OneDrive", MICROSOFT_TEAMS: "Microsoft Teams",
    LINEAR: "Linear", JIRA: "Jira", TRELLO: "Trello", ASANA: "Asana", DISCORD: "Discord", HUBSPOT: "HubSpot",
    AIRTABLE: "Airtable", DROPBOX: "Dropbox", TWITTER: "X", LINKEDIN: "LinkedIn", FIGMA: "Figma", CALENDLY: "Calendly",
    ZOOM: "Zoom", SALESFORCE: "Salesforce", SHOPIFY: "Shopify", STRIPE: "Stripe", CLICKUP: "ClickUp",
    TODOIST: "Todoist", WHATSAPP: "WhatsApp", TELEGRAM: "Telegram", REDDIT: "Reddit", SUPABASE: "Supabase",
    CONFLUENCE: "Confluence", ZENDESK: "Zendesk", INTERCOM: "Intercom", MAILCHIMP: "Mailchimp",
  };
  const COUNT = ["max_results", "maxResults", "page_size", "pageSize", "limit", "count", "top", "n"];
  const LABELS = ["label_ids", "labelIds", "labels", "folder", "calendar_id"];
  const QUERY = ["query", "q", "search", "search_query", "keyword", "filter"];
  const TO = ["recipient_email", "to", "recipient", "recipients", "email", "channel", "user_id"];
  const TITLE = ["subject", "title", "summary", "name"];

  const short = (value, limit = 48) => {
    const text = String(value).replace(/\s+/g, " ").trim();
    return text.length > limit ? text.slice(0, limit - 1).trimEnd() + "…" : text;
  };
  const words = (token) => token.toLowerCase().replace(/_/g, " ").trim();
  // An app action that only reads. Any other verb sends or changes something, so its card shows what it sends.
  const READS = /^(?:FETCH|GET|LIST|SEARCH|FIND|READ|QUERY|LOOKUP|RETRIEVE|COUNT)(?:_|$)/;
  const plumbing = (key) => PLUMBING.has(key) || /^current_step/.test(key);
  const capital = (text) => text ? text[0].toUpperCase() + text.slice(1) : text;

  /** "GMAIL_FETCH_EMAILS" -> {id: "GMAIL", rest: "FETCH_EMAILS"}. */
  function slugParts(slug) {
    const text = String(slug || "").trim();
    const known = Object.keys(APPS).sort((a, b) => b.length - a.length).find((id) => text.startsWith(id + "_"));
    const id = known || text.split("_")[0];
    return { id, rest: text.slice(id.length + 1) };
  }
  /** "GMAIL_FETCH_EMAILS" -> {app: "Gmail", action: "Fetch emails"}. */
  function slugWords(slug) {
    const { id, rest } = slugParts(slug);
    const app = APPS[id] || capital(words(id));
    // "NOTION_SEARCH_NOTION_PAGE" says Notion twice: once is enough.
    const action = rest.split("_").filter((part, i, all) => !(part === id && all.length > 1)).join("_");
    return { app, action: capital(words(action)) || "Run" };
  }
  const first = (args, keys) => { for (const key of keys) if (args[key] !== undefined && args[key] !== null && args[key] !== "") return [key, args[key]]; return null; };
  const label = (value) => (Array.isArray(value) ? value : [value]).filter((v) => typeof v === "string" && v)
    .slice(0, 3).map((v) => capital(v.toLowerCase().replace(/^category_/, "").replace(/_/g, " "))).join(", ");

  /** The main inputs of one app call, in a few words: "5 from Inbox", "to ana@example.com · “Lunch”". */
  function inputWords(args) {
    if (!args || typeof args !== "object" || Array.isArray(args)) return "";
    const parts = [];
    const count = first(args, COUNT), labels = first(args, LABELS);
    const where = labels ? label(labels[1]) : "";
    if (count && Number.isFinite(Number(count[1]))) parts.push(where ? `${Number(count[1])} from ${where}` : `up to ${Number(count[1])}`);
    else if (where) parts.push(`in ${where}`);
    const to = first(args, TO);
    if (to) parts.push(`to ${short(Array.isArray(to[1]) ? to[1].join(", ") : to[1], 60)}`);
    const title = first(args, TITLE);
    if (title && typeof title[1] === "string") parts.push(`“${short(title[1])}”`);
    const query = first(args, QUERY);
    if (query && typeof query[1] === "string") parts.push(`“${short(query[1])}”`);
    if (!parts.length) {
      // Nothing it knows: the first two plain inputs, as they are.
      for (const [key, value] of Object.entries(args)) {
        if (parts.length >= 2) break;
        if (["string", "number", "boolean"].includes(typeof value) && String(value).length) parts.push(`${words(key)} ${short(value, 32)}`);
      }
    }
    return parts.slice(0, 3).join(" · ");
  }

  /** What a card shows of one call's inputs: for a call that sends or changes something, every input it sends, in full
   *  ([[name, text], ...]); for a read, none (they stay one click away, in Inputs as sent). */
  function callFields(args, read, skip = () => false) {
    const given = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    return read ? [] : Object.entries(given).filter(([key]) => !skip(key))
      .map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]);
  }

  /** Each app call a Composio multi-execute makes, in plain words; null for any other tool. `plugin` (the plugin DGC
   *  calls, "Composio") ends each line: "Gmail · Fetch emails · 5 from Inbox · through Composio". */
  function describe(tool, args, plugin = "Composio") {
    const name = String(tool || "").replace(/^mcp__[a-z0-9_-]+__/, "");
    if (name !== EXECUTE || !args || typeof args !== "object") return null;
    const calls = Array.isArray(args.tools) ? args.tools.filter((c) => c && typeof c === "object" && typeof c.tool_slug === "string") : [];
    if (!calls.length) return null;
    return calls.map((call) => {                     // every one: the Allow covers them all
      const { app, action } = slugWords(call.tool_slug);
      const inputs = inputWords(call.arguments);
      const read = READS.test(slugParts(call.tool_slug).rest.toUpperCase());
      const fields = callFields(call.arguments, read, plumbing);
      return { app, action, inputs, read, fields,
               line: [app, action, inputs, plugin ? `through ${plugin}` : ""].filter(Boolean).join(" · ") };
    });
  }

  /** A plugin's own tool (anything but Composio's multi-execute), as an app call is read: a read by its verb
   *  (find_notes, get-time, list_files), and a call that sends or changes something shows every input in full. */
  function tool(name, args) {
    const bare = String(name || "").replace(/^mcp__[a-z0-9_-]+__/, "");
    const read = READS.test(bare.toUpperCase().replace(/[^A-Z0-9]+/g, "_"));
    return { read, fields: callFields(shownInputs(name, args), read) };
  }

  /** Whether every app call of a Composio multi-execute only reads: then its inputs can stay one click away. */
  function reads(tool, args) {
    const calls = describe(tool, args, "");
    return !!calls && calls.every((call) => call.read);
  }

  /** The card's inputs without Composio's plumbing, for a card that lists them. */
  function shownInputs(tool, args) {
    const name = String(tool || "").replace(/^mcp__[a-z0-9_-]+__/, "");
    if (!name.startsWith("COMPOSIO_") || !args || typeof args !== "object") return args;
    return Object.fromEntries(Object.entries(args).filter(([key]) => !plumbing(key)));
  }

  /** What a card sends, in full and as JSON text, for its "Inputs as sent" (Composio's plumbing left out). */
  function sent(tool, args) {
    const shown = shownInputs(tool, args);
    return JSON.stringify(shown && typeof shown === "object" ? shown : {}, null, 2);
  }

  /** A plugin logo's own colours pick its backdrop: a logo drawn light (Composio's is white strokes, for dark
   *  backgrounds) sits on a dark tile, any other on a light one, so it shows in both themes. `mark` gets
   *  logo-on-dark or logo-on-light once the image has loaded. */
  function backdrop(img, mark) {
    if (!img || !mark) return;
    const apply = () => {
      let light = false;
      try {
        const size = 24, canvas = root.document.createElement("canvas");
        canvas.width = canvas.height = size;
        const g = canvas.getContext("2d");
        if (g) {
          g.drawImage(img, 0, 0, size, size);
          const px = g.getImageData(0, 0, size, size).data;
          let sum = 0, n = 0;
          for (let i = 0; i < px.length; i += 4) {
            if (px[i + 3] < 77) continue;                 // the logo's own pixels, not its transparent ground
            sum += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255; n++;
          }
          light = n > 0 && sum / n > 0.75;
        }
      } catch { light = false; }
      mark.classList.toggle("logo-on-dark", light);
      mark.classList.toggle("logo-on-light", !light);
    };
    if (img.complete && img.naturalWidth) apply(); else img.addEventListener("load", apply, { once: true });
  }

  root.DgcPluginCalls = { describe, tool, reads, shownInputs, sent, slugWords, inputWords, backdrop, EXECUTE, PLUMBING };
})(typeof window !== "undefined" ? window : globalThis);

// A permission rule in a person's words (window.DgcRuleWords), the same on the Allow card's receipt, the line a new rule
// leaves in a session, Work's Permission rules list and Settings -> Security (user test W8, decided 15 Nov: "Always
// allow on an edit = edits in this project, said in plain words, removable in Settings").
//
// "Always allow edits in this project" is four of DGC's rules, one per edit tool, each over every file under the
// project's folder: Write(<folder>/*), Edit(<folder>/*), MultiEdit(<folder>/*), ApplyPatch(<folder>/*). DGC matches a
// path rule against the file's full path, and its * crosses folders, so together they are "any edit in this project".
// Here they are made (projectRules), recognised (projectOf) and listed as the one rule a person made (rows).
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcRuleWords) return;

  const EDIT_TOOLS = { write_file: "Write", edit_file: "Edit", multi_edit: "MultiEdit", apply_patch: "ApplyPatch" };
  const EDIT_NAMES = Object.values(EDIT_TOOLS);
  // DGC's patterns are Python's fnmatch: * ? and [ are special, and each is itself inside brackets.
  const literal = (text) => String(text).replace(/[[\]*?]/g, (c) => `[${c}]`);
  const plain = (pattern) => String(pattern).replace(/\[([[\]*?])\]/g, "$1");
  const trimmed = (folder) => String(folder || "").replace(/[\\/]+$/, "");
  const separator = (folder) => (folder.includes("\\") && !folder.includes("/") ? "\\" : "/");
  const baseName = (path) => String(path).split(/[\\/]+/).filter(Boolean).pop() || String(path);

  /** Whether an Allow card's tool is one of the four that edit a file. */
  function isEdit(tool) { return Object.prototype.hasOwnProperty.call(EDIT_TOOLS, String(tool)); }
  /** The four rules that are "edits in this project", for the project at `folder` (DGC's own path for it); none
   *  without a folder, or for one too long for a rule. `first`: the tool the card asked about, whose rule leads. */
  function projectRules(folder, first) {
    const base = trimmed(folder);
    if (!base || base.length > 900 || /[\r\n]/.test(base)) return [];
    const pattern = `${literal(base)}${separator(base)}*`;
    const lead = EDIT_TOOLS[String(first)] || EDIT_NAMES[0];
    return [lead, ...EDIT_NAMES.filter((name) => name !== lead)].map((name) => `${name}(${pattern})`);
  }
  /** The project a rule allows edits in ({tool, folder}), when it is one of those four; else null. */
  function projectOf(rule) {
    const m = /^(Write|Edit|MultiEdit|ApplyPatch)\((.+)[\\/]\*\)$/i.exec(String(rule || "").trim());
    if (!m || /[*?]/.test(m[2].replace(/\[[[\]*?]\]/g, ""))) return null;
    return { tool: m[1], folder: plain(m[2]) };
  }
  /** Whether `path` (a file an edit names, as DGC was given it) is inside the project at `folder`. A path that isn't
   *  absolute is the project's own. */
  function inProject(path, folder) {
    const base = trimmed(folder), file = String(path || "");
    if (!base || !file) return false;
    if (!/^([\\/]|[A-Za-z]:[\\/]|~)/.test(file)) return !/(^|[\\/])\.\.([\\/]|$)/.test(file);
    return file.startsWith(base + "/") || file.startsWith(base + "\\");
  }

  const LEAD = { allow: "Always allow", ask: "Always ask about", deny: "Never allow" };
  const short = (text, most = 160) => { const flat = String(text).replace(/\s+/g, " ").trim(); return flat.length > most ? `${flat.slice(0, most - 1)}…` : flat; };
  const host = (address) => { try { return new URL(address).host || address; } catch { return address; } };
  /** What a rule is about, as the end of a sentence: "edits in this project", "the command npm test". `here`: the open
   *  project's folder, so its own rule reads "this project". */
  function about(rule, here) {
    const text = String(rule || "").trim(), project = projectOf(text);
    if (project) return trimmed(here) && project.folder === trimmed(here) ? "edits in this project" : `edits in ${baseName(project.folder)}`;
    const m = /^([A-Za-z_*]+)\s*(?:\((.*)\))?$/.exec(text);
    if (!m) return short(text);
    // (DGC reads a rule's tool whatever its case: "bash(npm test)" is Bash's.)
    const KNOWN = ["Bash", "Monitor", "Python", "Write", "Edit", "MultiEdit", "ApplyPatch", "Read", "ViewImage", "ShowFile", "WebFetch", "WebSearch", "Browser", "MCPCall", "Task", "ExternalDirectory"];
    const tool = KNOWN.find((name) => name.toLowerCase() === m[1].toLowerCase()) || m[1], what = m[2] === undefined ? null : m[2];
    const each = { Bash: "every command", Monitor: "every watched command", Python: "every Python snippet", Write: "every new or rewritten file", Edit: "every edit", MultiEdit: "every edit",
      ApplyPatch: "every patch", Read: "reading any file", WebFetch: "fetching any page", WebSearch: "every web search", Browser: "every page in the browser", MCPCall: "every plugin tool",
      Task: "every sub-agent", ExternalDirectory: "every folder outside the project", "*": "everything" };
    if (what === null || what === "" || what === "*") return each[tool] || `${tool}, whatever it is given`;
    if (tool === "Bash" || tool === "Monitor") return what.endsWith(":*") ? `commands that start with ${short(what.slice(0, -2))}` : /[*?[]/.test(what) ? `commands like ${short(what)}` : `the command ${short(what)}`;
    if (EDIT_NAMES.includes(tool)) return /[*?[]/.test(what) ? `edits to files like ${short(what)}` : `edits to ${baseName(what)}`;
    if (tool === "Read" || tool === "ViewImage" || tool === "ShowFile") return /[*?[]/.test(what) ? `reading files like ${short(what)}` : `reading ${baseName(what)}`;
    if (tool === "WebFetch") return `fetching ${short(what)}`;
    if (tool === "WebSearch") return `web searches for ${short(what)}`;
    if (tool === "Browser") return what.startsWith("signed-in:") ? `your signed-in Chrome on ${host(what.slice(10))}` : `the browser on ${short(what)}`;
    if (tool === "MCPCall") return `the plugin tool ${short(what)}`;
    if (tool === "ExternalDirectory") return `the folder ${short(what)}`;
    return `${tool}: ${short(what)}`;
  }
  /** A rule as one sentence: "Always allow edits in this project". */
  function sentence(action, rule, here) { return `${LEAD[action] || LEAD.allow} ${about(rule, here)}`; }

  /** A list of rules ([{action, rule, invalid?}], as DGC lists them) as the rows a person reads: the four of a project's
   *  edits are one row; every row carries the rules a Remove takes away. */
  function rows(items, here) {
    const out = [], projects = new Map();
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item.rule !== "string") continue;
      const action = String(item.action || "allow"), project = action === "allow" && !item.invalid ? projectOf(item.rule) : null;
      if (project) {
        let row = projects.get(project.folder);
        if (!row) { row = { action, words: sentence(action, item.rule, here), detail: project.folder, rules: [], project: project.folder, invalid: false }; projects.set(project.folder, row); out.push(row); }
        row.rules.push(item.rule);
        continue;
      }
      out.push({ action, words: item.invalid ? short(item.rule) : sentence(action, item.rule, here), detail: item.rule, rules: [item.rule], project: "", invalid: item.invalid === true });
    }
    return out;
  }

  root.DgcRuleWords = { EDIT_TOOLS, isEdit, projectRules, projectOf, inProject, about, sentence, rows };
})();

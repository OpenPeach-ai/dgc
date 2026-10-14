// Hidden WSL: the paths in protocol frames, translated where they cross (src/wslHost.ts runs DGC in its distro).
//
// Only fields known to hold an absolute path of the computer are translated, each named below with what it holds;
// a relative path, a bare file name, a permission rule, a path inside a Pip's computer, a URL and every free text are
// left exactly as they are. Commands go Windows -> Linux, events Linux -> Windows, with one pair of functions, so a
// path the backend sent and the extension sends back (a project root, a library file) arrives as it left.
import { PathMap } from "./wslPaths";

type Frame = Record<string, any>;
type Fix = (frame: Frame, to: (path: string) => string) => void;

const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/u;
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const field = (frame: Frame | undefined, key: string, to: (path: string) => string): void => {
  if (frame && string(frame[key])) { frame[key] = to(frame[key]); }
};
const each = (list: unknown, apply: (item: Frame) => void): void => {
  if (Array.isArray(list)) { for (const item of list) { if (item && typeof item === "object") { apply(item); } } }
};
const strings = (list: unknown, to: (path: string) => string): unknown =>
  Array.isArray(list) ? list.map((item) => (string(item) ? to(item) : item)) : list;

/** prompt.context / start_goal.context: an editor file's path, its file: URI, and its path relative to the
 *  workspace, which is absolute for a file outside it. An MCP context's uri is the server's own name for it. */
function context(list: unknown, to: (path: string) => string): void {
  each(list, (item) => {
    field(item, "path", to);
    if (string(item.relative_path) && WINDOWS_ABSOLUTE.test(item.relative_path)) { item.relative_path = to(item.relative_path); }
    if (item.type !== "mcp_context" && string(item.uri) && item.uri.startsWith("file:")) {
      try {
        const windows = decodeURIComponent(new URL(item.uri).pathname).replace(/^\/(?=[A-Za-z]:)/u, "").replace(/\//g, "\\");
        item.uri = "file://" + encodeURI(to(windows));
      } catch { /* not a URI this side can read: as it was */ }
    }
  });
}

/** Commands: fields that hold a Windows path the backend reads, writes or compares. */
const TO_BACKEND: Record<string, Fix> = {
  open_chat: (c, to) => field(c, "cwd", to),
  set_workspace_roots: (c, to) => { c.roots = strings(c.roots, to); },
  get_workspace_change: (c, to) => field(c, "root", to),      // .path is relative to it
  get_chat_change: (c, to) => field(c, "root", to),
  prompt: (c, to) => context(c.context, to),
  start_goal: (c, to) => context(c.context, to),
  install_skill: (c, to) => { if (string(c.source) && WINDOWS_ABSOLUTE.test(c.source)) { c.source = to(c.source); } },
  add_plugin_marketplace: (c, to) => { if (string(c.source) && WINDOWS_ABSOLUTE.test(c.source)) { c.source = to(c.source); } },
  memory_project: (c, to) => field(c, "folder", to),
  chatdgc_send: (c, to) => each(c.attachments, (a) => { if (a.kind === "file") { field(a, "path", to); } }),
  chatdgc_project: (c, to) => each(c.attachments, (a) => field(a, "path", to)),
  chatdgc_export: (c, to) => field(c, "path", to),
  chatdgc_canvas: (c, to) => { if (c.op === "export") { field(c, "path", to); } },
  chatdgc_library_file: (c, to) => field(c, "path", to),
};

/** Events: fields that hold a path in the distro the extension opens, writes, shows or sends back. */
const TO_EDITOR: Record<string, Fix> = {
  ready: (e, to) => { field(e, "project_root", to); field(e.capabilities, "image_spool_dir", to); },
  chat_opened: (e, to) => field(e, "project_root", to),
  config: (e, to) => field(e, "project_root", to),
  workspace_roots: (e, to) => { e.roots = strings(e.roots, to); },
  workspace_changes: (e, to) => each(e.roots, (r) => field(r, "root", to)),
  chat_changes: (e, to) => each(e.roots, (r) => field(r, "root", to)),
  workspace_change: (e, to) => field(e, "root", to),
  chat_change: (e, to) => field(e, "root", to),
  image: (e, to) => field(e, "path", to),
  plugin_operation: (e, to) => field(e, "path", to),
  skill_package: (e, to) => field(e, "path", to),
  plugin_catalog: (e, to) => each(e.items, (i) => field(i, "logo_file", to)),
  plugin_preview: (e, to) => field(e.item, "logo_file", to),
  chatdgc_canvas: (e, to) => { field(e.canvas, "path", to); each(e.canvas?.versions, (v) => field(v, "path", to)); },
  chatdgc_exported: (e, to) => field(e, "path", to),
  chatdgc_library_file: (e, to) => field(e, "path", to),
  memory_state: (e, to) => each(e.projects, (p) => field(p, "folder", to)),
  troupe_started: (e, to) => field(e, "journal", to),
  troupe_progress: (e, to) => field(e, "journal", to),
  troupe_finished: (e, to) => field(e, "journal", to),
  troupes: (e, to) => each(e.runs, (r) => field(r, "journal", to)),
  retained_tasks: (e, to) => each(e.items, (i) => field(i, "worktree", to)),
  history: (e, to) => each(e.items, (item) => TO_EDITOR[item.type]?.(item, to)),
  recall: (e, to) => each(e.items, (item) => TO_EDITOR[item.type]?.(item, to)),
};

export type Bridge = { toBackend(command: Frame): Frame; toEditor(event: Frame): Frame };

/** Translate in place (each frame is the bridge's own copy: commands are serialized right after, events were just
 *  parsed). A frame type with no path field passes untouched. */
export function bridge(map: PathMap): Bridge {
  return {
    toBackend(command: Frame): Frame {
      TO_BACKEND[command?.type]?.(command, map.toLinux);
      return command;
    },
    toEditor(event: Frame): Frame {
      TO_EDITOR[event?.type]?.(event, map.toWindows);
      return event;
    },
  };
}

export const translatedCommands = Object.keys(TO_BACKEND);
export const translatedEvents = Object.keys(TO_EDITOR);

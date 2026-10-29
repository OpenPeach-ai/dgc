/**
 * Write a DGC mod in TypeScript or JavaScript: `@vibedgc/sdk/mods`. The same API as Python's `dgc_mod`.
 *
 *     import { Mod, ask, Text } from "@vibedgc/sdk/mods";
 *
 *     const mod = new Mod();
 *     mod.on("tool.call", (event) => {
 *       if (String(event.args?.command ?? "").includes("rm -rf")) return ask("This deletes files.");
 *     });
 *     mod.command("hello", () => Text("Hello from my mod"));
 *     mod.run();
 *
 * A mod only hears the events its dgc-mod.json declares, draws only where it declared, and can never approve: on a
 * step it may watch, ask you first (`ask`) or stop it (`deny`). console.log goes to the mod's log, never to DGC.
 */
import { createInterface } from "node:readline";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Tree = { type: string; [key: string]: unknown };
export type Decision = { decision: "ask" | "deny"; reason: string };
type Handler = (event: Record<string, any>) => unknown | Promise<unknown>;

export class ModError extends Error {}

/** On tool.call: ask the user first, even where DGC would have gone ahead. */
export const ask = (reason: string): Decision => ({ decision: "ask", reason: String(reason).slice(0, 300) });
/** On tool.call: stop the step; DGC tells the model why. */
export const deny = (reason: string): Decision => ({ decision: "deny", reason: String(reason).slice(0, 300) });
/** On prompt.submit (with rewrites_prompt): send this instead; it's marked as changed by this mod. */
export const rewrite = (text: string, note = "") => ({ rewrite: String(text), note: String(note).slice(0, 200) });

const el = (type: string, fields: Record<string, unknown>): Tree =>
  ({ type, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) });
export const Box = (children: Tree[], title?: string, tone?: string) => el("Box", { children, title, tone });
export const Row = (...children: Tree[]) => el("Row", { children });
export const Column = (...children: Tree[]) => el("Column", { children });
export const Text = (text: string, tone?: string) => el("Text", { text: String(text), tone });
export const Markdown = (text: string) => el("Markdown", { text: String(text) });
export const Button = (id: string, label: string) => el("Button", { id, label });
export const Input = (id: string, placeholder?: string, value?: string) => el("Input", { id, placeholder, value });
export const Select = (id: string, options: Array<string | { value: string; label: string }>, value?: string) =>
  el("Select", { id, options: options.map((o) => (typeof o === "string" ? { value: o, label: o } : o)), value });
export const Bar = (segments: Array<{ label: string; value: number; tone?: string }>, total?: number) =>
  el("Bar", { segments, total });
export const Table = (columns: string[], rows: unknown[][]) => el("Table", { columns, rows });
export const Sparkline = (values: number[], label?: string) => el("Sparkline", { values, label });

export class Mod {
  private events = new Map<string, Handler[]>();
  private commands = new Map<string, (args: string) => unknown>();
  private renders = new Map<string, () => unknown>();
  private actions: Array<(change: { id: string; value: unknown }) => unknown> = [];
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private next = 0;
  private queue: Promise<void> = Promise.resolve();
  info: Record<string, unknown> = {};
  private out: (line: string) => void;

  constructor() {
    const write = process.stdout.write.bind(process.stdout);
    this.out = (line) => { write(line); };
    // A console.log goes to the log, never into the pipe.
    console.log = (...args: unknown[]) => process.stderr.write(args.map(String).join(" ") + "\n");
  }

  on(event: string, fn: Handler): this {
    this.events.set(event, [...(this.events.get(event) ?? []), fn]);
    return this;
  }
  command(name: string, fn: (args: string) => unknown): this { this.commands.set(name, fn); return this; }
  /** What to draw in a slot when DGC asks (a new window, a reload). */
  render(slot: string, fn: () => unknown): this { this.renders.set(slot, fn); return this; }
  /** A Button pressed, an Input or Select changed. */
  action(fn: (change: { id: string; value: unknown }) => unknown): this { this.actions.push(fn); return this; }

  /** Ask DGC for something (ui.set, http.fetch, files.read, ...). */
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ModError(`DGC didn't answer ${method}.`)); },
        timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  setUi(slot: "pane" | "band" | "status", tree: Tree | null) { return this.call("ui.set", { slot, tree }); }
  toast(text: string, tone?: string) { return this.call("ui.toast", { text, ...(tone ? { tone } : {}) }); }
  fetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
    return this.call("http.fetch", { url, method: init.method ?? "GET", headers: init.headers ?? {},
                                     ...(init.body !== undefined ? { body: init.body } : {}) });
  }
  async readFile(path: string): Promise<string> { return (await this.call("files.read", { path })).text; }
  git() { return this.call("git.status"); }
  usage() { return this.call("usage.get"); }
  async transcript(limit = 20) { return (await this.call("transcript.get", { limit })).messages; }
  async askModel(prompt: string, maxTokens = 400): Promise<string> {
    return (await this.call("model.complete", { prompt, max_tokens: maxTokens }, 120_000)).text;
  }
  async storeGet<T = Json>(key: string, fallback?: T): Promise<T> {
    const got = await this.call("store.get", { key });
    return (got?.value ?? fallback) as T;
  }
  storeSet(key: string, value: Json) { return this.call("store.set", { key, value }); }
  async stateGet<T = Json>(key: string, fallback?: T): Promise<T> {
    const got = await this.call("state.get", { key });
    return (got?.value ?? fallback) as T;
  }
  stateSet(key: string, value: Json) { return this.call("state.set", { key, value }); }

  private send(message: Record<string, unknown>): void { this.out(JSON.stringify(message) + "\n"); }

  private async handle(method: string, params: Record<string, any>): Promise<unknown> {
    if (method === "initialize") {
      this.info = params;
      return { hooks: [...this.events.keys()].sort(), commands: [...this.commands.keys()].sort(),
               renders: [...this.renders.keys()].sort() };
    }
    if (method === "event") {
      let answer: unknown = undefined;
      for (const fn of this.events.get(params.name) ?? []) {
        const got = await fn(params.data ?? {});
        if (got !== undefined && got !== null && answer === undefined) answer = got;
      }
      return answer ?? {};
    }
    if (method === "command") {
      const fn = this.commands.get(params.name);
      if (!fn) throw new ModError(`no command ${params.name}`);
      const got = await fn(params.args ?? "");
      return typeof got === "string" ? { text: got } : got && typeof got === "object" ? { tree: got } : {};
    }
    if (method === "ui.render") {
      const fn = this.renders.get(params.slot);
      return { tree: fn ? await fn() : null };
    }
    if (method === "ui.action") {
      for (const fn of this.actions) await fn({ id: params.id, value: params.value });
      return {};
    }
    if (method === "shutdown") process.exit(0);
    throw new ModError(`unknown method ${method}`);
  }

  run(): void {
    const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
    lines.on("line", (line) => {
      let message: any;
      try { message = JSON.parse(line); } catch { return; }
      if (!message || typeof message !== "object") return;
      if ("method" in message) {
        // One request at a time, in order, as DGC sent them (the Python library does the same).
        this.queue = this.queue.then(async () => {
          try {
            const result = await this.handle(message.method, message.params ?? {});
            if (message.id !== undefined) this.send({ jsonrpc: "2.0", id: message.id, result });
          } catch (error) {
            process.stderr.write(String((error as Error)?.stack ?? error) + "\n");
            if (message.id !== undefined) {
              this.send({ jsonrpc: "2.0", id: message.id,
                          error: { code: -32000, message: String((error as Error)?.message ?? error).slice(0, 500) } });
            }
          }
        });
        return;
      }
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new ModError(String(message.error?.message ?? message.error)));
      else waiting.resolve(message.result);
    });
    lines.on("close", () => process.exit(0));
  }
}

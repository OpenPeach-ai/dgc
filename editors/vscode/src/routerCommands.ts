/** DGC Router (0.51): the router_* commands Settings may send, checked before they reach DGC. Only the fields the
 *  protocol declares for each command (dgc/editor_protocol.py COMMAND_FIELDS), each of its own type and size; anything
 *  else is dropped, and a command that isn't one of these is refused. `key` goes only with router_update set_key and
 *  `token` only with router_hardware, as the protocol says. */
export type RouterCommand = { type: string; action?: string } & Record<string, unknown>;

const ACTIONS = new Set(["turn_on", "turn_off", "add_system", "edit_system", "remove_system", "enable_system",
  "disable_system", "set_model", "set_jobs", "set_when_busy", "set_key", "apply_suggestion"]);
const JOBS = new Set(["subagents", "pips"]);
const CHECKS = new Set(["models", "speed", "parallel", "tools"]);

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
const whole = (value: unknown, low: number, high: number): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= low && value <= high ? value : undefined;

export function routerCommand(raw: any): RouterCommand | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const type = String(raw.type || "");
  const system = text(raw.system, 64);
  if (type === "router_status") return { type, ...(raw.refresh === true ? { refresh: true } : {}) };
  if (type === "router_find") return { type };
  if (type === "router_probe") {
    if (!system) return undefined;
    const checks = Array.isArray(raw.checks) ? raw.checks.filter((c: unknown) => typeof c === "string" && CHECKS.has(c)) : undefined;
    const model = text(raw.model, 256);
    return { type, system, ...(model ? { model } : {}), ...(checks && checks.length ? { checks } : {}) };
  }
  if (type === "router_suggest") {
    if (!system) return undefined;
    const context = whole(raw.context, 2048, 16777216);
    return { type, system, ...(context ? { context } : {}) };
  }
  if (type === "router_hardware") {
    if (!system) return undefined;
    const url = text(raw.url, 2048), token = text(raw.token, 512);
    return { type, system, ...(url !== undefined ? { url } : {}), ...(token !== undefined ? { token } : {}) };
  }
  if (type === "router_thinking") {
    // How hard a helper on one model of one system thinks: "" (the helper's own level), off, low, medium or high.
    const model = text(raw.model, 256), thinking = typeof raw.thinking === "string" ? raw.thinking : "";
    if (!system || !model || !["", "off", "low", "medium", "high"].includes(thinking)) return undefined;
    return { type, system, model, thinking };
  }
  if (type !== "router_update") return undefined;
  const action = String(raw.action || "");
  if (!ACTIONS.has(action)) return undefined;
  const cmd: RouterCommand = { type, action };
  if (system) cmd.system = system;
  const name = text(raw.name, 64), base = text(raw.base_url, 2048), model = text(raw.model, 256), note = text(raw.note, 200);
  if (name !== undefined) cmd.name = name;
  if (base !== undefined) cmd.base_url = base;
  if (model !== undefined) cmd.model = model;
  if (note !== undefined) cmd.note = note;
  if (Array.isArray(raw.jobs)) cmd.jobs = raw.jobs.filter((j: unknown) => typeof j === "string" && JOBS.has(j));
  if (Array.isArray(raw.models)) cmd.models = raw.models.filter((m: unknown) => text(m, 256)).slice(0, 64);
  const workers = whole(raw.workers, 1, 64), context = whole(raw.context, 2048, 16777216);
  if (workers !== undefined) cmd.workers = workers;
  if (context !== undefined) cmd.context = context;
  if (typeof raw.one_model_at_a_time === "boolean") cmd.one_model_at_a_time = raw.one_model_at_a_time;
  if (typeof raw.use === "boolean") cmd.use = raw.use;
  if (typeof raw.memory_gb === "number" && raw.memory_gb > 0 && raw.memory_gb <= 4096) cmd.memory_gb = raw.memory_gb;
  if (raw.when_busy === "wait" || raw.when_busy === "default") cmd.when_busy = raw.when_busy;
  if (action === "set_key") {
    const key = text(raw.key, 16384);
    if (key === undefined || !system) return undefined;
    cmd.key = key;
  }
  const needsSystem = !["turn_on", "turn_off", "add_system", "set_when_busy"].includes(action);
  if (needsSystem && !system) return undefined;
  if (action === "add_system" && !base) return undefined;
  return cmd;
}

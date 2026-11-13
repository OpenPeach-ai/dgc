// Home as cards (media/shared/homecards.js): what the extension keeps for it, and the two things it reads for it.
//
// Kept on this computer, in the extension's global state as the dock's pins are (src/dock.ts), so a reload and every
// window find Home as it was left: which cards are on Home and in what order (the side bar's width picks each card's
// size, so no size is kept), and the everyday cards' own settings: the Clock's second time zone, the Weather's
// city and unit, the Note's words.
//
// Read for it: the token report, shaped for the Token usage card (the days as DGC counted them, the models by tokens;
// never a prompt or a reply), and the weather. The Weather card's request is the only one Home makes outside this
// computer, and the host makes it, never the page: to Open-Meteo (no account, no key), for the city the user typed when
// adding the card, and only then. It sends the city's name to find the place, then the place's latitude and longitude
// for the forecast; nothing else. An answer is kept for half an hour.
import type * as vscode from "vscode";

const KEY = "dgc.homeCards.v1";
/** Every card there is, in the library's order. */
export const HOME_CARD_TYPES = ["needs", "running", "recent", "work", "chats", "pips", "token", "quick", "folders", "clock", "weather", "note"] as const;
export type HomeCardType = typeof HOME_CARD_TYPES[number];
/** Home for someone new. */
export const HOME_DEFAULT: HomeCardType[] = ["needs", "recent", "running", "token", "quick"];
const WEATHER_KEEP_MS = 30 * 60000, NOTE_MOST = 4000;

export type HomeSettings = { clock?: { zone?: string }; weather?: { city?: string; unit?: "c" | "f" }; note?: { text?: string } };
export type HomeCardsState = { type: "homeCards"; order: HomeCardType[]; settings: HomeSettings };
export type HomeWeather = { type: "homeWeather"; ok: true; place: string; at: number; now: { temp: number; code: number; day: boolean }; high: number; low: number; hours: { time: string; temp: number; code: number }[] }
  | { type: "homeWeather"; ok: false; reason: "nocity" | "offline" | "refused" | "notfound" };
type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
type Kept = { order?: unknown; settings?: unknown; place?: unknown };
type Place = { city: string; name: string; lat: number; lon: number };

const isType = (value: unknown): value is HomeCardType => typeof value === "string" && (HOME_CARD_TYPES as readonly string[]).includes(value);
function order(value: unknown): HomeCardType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: HomeCardType[] = [];
  for (const entry of value.slice(0, 64)) if (isType(entry) && !out.includes(entry)) out.push(entry);
  return out;
}
function zone(value: unknown): string | undefined {
  if (value === "") return "";
  if (typeof value !== "string" || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(value)) return undefined;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return value; } catch { return undefined; }
}
const city = (value: unknown) => (typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) : undefined);
/** The settings as kept: only what each everyday card has. */
function settings(value: unknown): HomeSettings {
  const from = value && typeof value === "object" ? value as Record<string, any> : {}, out: HomeSettings = {};
  const z = zone(from.clock?.zone);
  if (z) out.clock = { zone: z };
  const c = city(from.weather?.city), unit = from.weather?.unit === "f" ? "f" : from.weather?.unit === "c" ? "c" : undefined;
  if (c || unit) out.weather = { ...(c ? { city: c } : {}), ...(unit ? { unit } : {}) };
  if (typeof from.note?.text === "string" && from.note.text) out.note = { text: from.note.text.slice(0, NOTE_MOST) };
  return out;
}

/** The token report (get_usage) as the card takes it. `period`: the thirty days' own report, for its models. */
export function usageForHome(report: any, period: any): { type: "homeUsage"; days: { date: string; input_tokens: number; output_tokens: number; cached_input_tokens: number; requests: number }[]; models: { name: string; tokens: number }[]; error: string } {
  const n = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
  const days = (Array.isArray(report?.by_day) ? report.by_day : []).filter((d: any) => typeof d?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date)).slice(-120)
    .map((d: any) => ({ date: d.date as string, input_tokens: n(d.input_tokens), output_tokens: n(d.output_tokens), cached_input_tokens: n(d.cached_input_tokens), requests: n(d.requests) }));
  const models = (Array.isArray(period?.by_model) ? period.by_model : []).slice(0, 40).map((row: any) => {
    const model = String(row?.model || "").slice(0, 80), where = String(row?.system_name || "").slice(0, 60);
    return { name: where && where !== model ? `${model} (${where})` : model, tokens: n(row?.input_tokens) + n(row?.output_tokens) };
  }).filter((row: { name: string; tokens: number }) => row.name && row.tokens > 0).sort((a: { tokens: number }, b: { tokens: number }) => b.tokens - a.tokens).slice(0, 6);
  return { type: "homeUsage", days, models, error: typeof report?.error === "string" ? report.error.slice(0, 300) : "" };
}

export class HomeCards {
  private readonly listeners = new Set<() => void>();
  private readonly fetcher?: Fetcher;
  private readonly now: () => number;
  private held?: { city: string; at: number; said: HomeWeather };
  constructor(private readonly context: Pick<vscode.ExtensionContext, "globalState">, options: { fetcher?: Fetcher; now?: () => number } = {}) {
    this.fetcher = options.fetcher ?? (typeof (globalThis as any).fetch === "function" ? ((url, init) => (globalThis as any).fetch(url, init)) : undefined);
    this.now = options.now ?? Date.now;
  }

  private kept(): Kept {
    let saved: unknown;
    try { saved = this.context?.globalState?.get?.<unknown>(KEY); } catch { saved = undefined; }
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Kept : {};
  }
  private async keep(change: Kept): Promise<void> {
    try { await this.context.globalState.update(KEY, { ...this.kept(), ...change }); } catch { /* kept for this window still */ }
    for (const listener of [...this.listeners]) { try { listener(); } catch { /* one page's trouble is its own */ } }
  }
  state(): HomeCardsState {
    const kept = this.kept();
    return { type: "homeCards", order: order(kept.order) ?? [...HOME_DEFAULT], settings: settings(kept.settings) };
  }
  onChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }
  async setOrder(value: unknown): Promise<void> { const next = order(value); if (next) await this.keep({ order: next }); }
  async reset(): Promise<void> { await this.keep({ order: [...HOME_DEFAULT] }); }
  /** One everyday card's setting. Anything that is not one changes nothing. */
  async setting(card: unknown, change: unknown): Promise<void> {
    if (card !== "clock" && card !== "weather" && card !== "note") return;
    const now = settings(this.kept().settings), from = change && typeof change === "object" ? change as Record<string, unknown> : {};
    if (card === "clock") { const z = zone(from.zone); if (z === undefined) return; if (z) now.clock = { zone: z }; else delete now.clock; }
    else if (card === "note") { if (typeof from.text !== "string") return; if (from.text) now.note = { text: from.text.slice(0, NOTE_MOST) }; else delete now.note; }
    else {
      const c = from.city === undefined ? now.weather?.city : city(from.city), unit = from.unit === "f" || from.unit === "c" ? from.unit : now.weather?.unit;
      now.weather = { ...(c ? { city: c } : {}), ...(unit ? { unit } : {}) };
      if (c !== this.held?.city) this.held = undefined;
    }
    await this.keep({ settings: now });
  }

  /** The weather for the city kept, from Open-Meteo: asked at most once in half an hour. Never throws. */
  async weather(): Promise<HomeWeather> {
    const where = settings(this.kept().settings).weather?.city || "";
    if (!where) return { type: "homeWeather", ok: false, reason: "nocity" };
    if (this.held && this.held.city === where && this.now() - this.held.at < WEATHER_KEEP_MS) return this.held.said;
    const said = await this.readWeather(where);
    if (said.ok) this.held = { city: where, at: this.now(), said };
    return said;
  }
  private async ask(url: string): Promise<any> {
    if (!this.fetcher) throw new Error("offline");
    const stop = typeof AbortController === "function" ? new AbortController() : undefined, timer = stop ? setTimeout(() => stop.abort(), 12000) : undefined;
    try {
      const answer = await this.fetcher(url, stop ? { signal: stop.signal } : undefined);
      if (!answer.ok) throw Object.assign(new Error("refused"), { refused: true });
      return await answer.json();
    } finally { if (timer) clearTimeout(timer); }
  }
  private async readWeather(where: string): Promise<HomeWeather> {
    try {
      const saved = this.kept().place as Place | undefined;
      let place = saved && saved.city === where && Number.isFinite(saved.lat) && Number.isFinite(saved.lon) ? saved : undefined;
      if (!place) {
        const found = (await this.ask(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(where)}&count=1&language=en&format=json`))?.results?.[0];
        if (!found || !Number.isFinite(found.latitude) || !Number.isFinite(found.longitude)) return { type: "homeWeather", ok: false, reason: "notfound" };
        place = { city: where, name: [found.name, found.country].filter((part) => typeof part === "string" && part).join(", ").slice(0, 80) || where, lat: found.latitude, lon: found.longitude };
        try { await this.context.globalState.update(KEY, { ...this.kept(), place }); } catch { /* found again next time */ }
      }
      const f = await this.ask(`https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&current=temperature_2m,weather_code,is_day&hourly=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&forecast_days=2&timezone=auto`);
      const temp = Number(f?.current?.temperature_2m);
      if (!Number.isFinite(temp)) return { type: "homeWeather", ok: false, reason: "refused" };
      const times: string[] = Array.isArray(f?.hourly?.time) ? f.hourly.time : [], current = String(f.current.time || "");
      const from = Math.max(0, times.findIndex((time) => String(time) > current)), hours = [];
      for (let i = from; i < times.length && hours.length < 5; i++) {
        const t = Number(f.hourly.temperature_2m?.[i]);
        if (Number.isFinite(t)) hours.push({ time: String(times[i]).slice(11, 16), temp: t, code: Number(f.hourly.weather_code?.[i]) || 0 });
      }
      return { type: "homeWeather", ok: true, place: place.name, at: this.now(), now: { temp, code: Number(f.current.weather_code) || 0, day: f.current.is_day !== 0 },
        high: Number(f?.daily?.temperature_2m_max?.[0]), low: Number(f?.daily?.temperature_2m_min?.[0]), hours };
    } catch (error) {
      return { type: "homeWeather", ok: false, reason: (error as any)?.refused ? "refused" : "offline" };
    }
  }

  /** A page's Home-cards message. False when it isn't one. `reply` gets what the page asked for. */
  handle(message: any, reply?: (said: HomeCardsState | HomeWeather) => void): boolean {
    switch (message?.type) {
      case "homeCardsReady": reply?.(this.state()); return true;
      case "homeCardsSet": void this.setOrder(message.order).then(() => reply?.(this.state())); return true;
      case "homeCardsReset": void this.reset().then(() => reply?.(this.state())); return true;
      case "homeCardSetting":
        void this.setting(message.card, message.settings).then(async () => {
          reply?.(this.state());
          if (message.card === "weather" && message.settings && typeof message.settings === "object" && "city" in message.settings) reply?.(await this.weather());
        });
        return true;
      case "homeWeatherGet": void this.weather().then((said) => reply?.(said)); return true;
      default: return false;
    }
  }
}

const homes = new WeakMap<object, HomeCards>();
/** The one Home of this extension (every window's side bar shares it). */
export function homeCardsOf(context: vscode.ExtensionContext): HomeCards {
  let home = homes.get(context);
  if (!home) { home = new HomeCards(context); homes.set(context, home); }
  return home;
}

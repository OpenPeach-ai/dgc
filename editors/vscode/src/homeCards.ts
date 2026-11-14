// Home as cards (media/shared/homecards.js): what the extension keeps for it, and the things it reads for it.
//
// Kept on this computer, in the extension's global state as the dock's pins are (src/dock.ts), so a reload and every
// window find Home as it was left: which cards are on Home and in what order (the side bar's width picks each card's
// size, so no size is kept), the everyday cards' own settings (the Clock's added time zones, the Weather's place and
// unit, which widget and which artifact their cards last showed). The Notes card's notes are not here: they are files in
// DGC's own storage folder (src/notes.ts), and a Notes message a page sends is handed to that store.
//
// Read for it: the token report, shaped for the Token usage card (the days as DGC counted them, the models by tokens
// with their provider and share; never a prompt or a reply), and the weather. The Weather card's requests are the only
// ones Home makes outside this computer, and the host makes them, never the page: to Open-Meteo (no account, no key).
// While a city is typed, the letters typed are sent to its place search and the places it finds are offered; the place
// the user chooses is kept whole (name, region, country, latitude, longitude, time zone) and the forecast is asked by
// its coordinates. Nothing else is sent. A forecast is kept for half an hour.
import type * as vscode from "vscode";
import { Notes, notesOf } from "./notes";

const KEY = "dgc.homeCards.v1";
/** Every card there is, in the library's order. */
export const HOME_CARD_TYPES = ["needs", "running", "recent", "work", "chats", "pips", "widgets", "artifacts", "token", "quick", "folders", "clock", "weather", "note"] as const;
export type HomeCardType = typeof HOME_CARD_TYPES[number];
/** Home for someone new. */
export const HOME_DEFAULT: HomeCardType[] = ["needs", "recent", "running", "token", "quick"];
const WEATHER_KEEP_MS = 30 * 60000;
/** The Clock shows Here and at most this many added time zones (four in all). */
export const CLOCK_ZONES_MOST = 3;

/** A place as Open-Meteo's search named it, kept whole: the forecast is asked by its coordinates. */
export type HomePlace = { name: string; admin1: string; country: string; code: string; lat: number; lon: number; tz: string };
/** `clock.zones`: the time zones added beside Here, in the order they were added. `weather.city`: a city typed before
 *  places were chosen from a list (found once more, then kept as a place). */
export type HomeSettings = { clock?: { zones: string[] }; weather?: { place?: HomePlace; city?: string; unit?: "c" | "f" }; widgets?: { shown?: string }; artifacts?: { shown?: string } };
export type HomeCardsState = { type: "homeCards"; order: HomeCardType[]; settings: HomeSettings };
export type HomeWeather = { type: "homeWeather"; ok: true; place: string; at: number; now: { temp: number; code: number; day: boolean }; high: number; low: number; hours: { time: string; temp: number; code: number }[] }
  | { type: "homeWeather"; ok: false; reason: "nocity" | "offline" | "refused" | "notfound" };
/** The places found for the letters typed (`q`, as the page sent them; `seq` is the page's own count of its asks). */
export type HomePlaces = { type: "homeWeatherPlaces"; q: string; seq: number; ok: true; places: HomePlace[] } | { type: "homeWeatherPlaces"; q: string; seq: number; ok: false; reason: "offline" | "refused" };
type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
type Kept = { order?: unknown; settings?: unknown };

const isType = (value: unknown): value is HomeCardType => typeof value === "string" && (HOME_CARD_TYPES as readonly string[]).includes(value);
function order(value: unknown): HomeCardType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: HomeCardType[] = [];
  for (const entry of value.slice(0, 64)) if (isType(entry) && !out.includes(entry)) out.push(entry);
  return out;
}
function zone(value: unknown): string | undefined {
  if (value === "") return "";
  if (typeof value !== "string" || !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){1,2})$/.test(value)) return undefined;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return value; } catch { return undefined; }
}
/** The Clock's added zones, checked: each a real time zone, each once, three at most. undefined: not a list of them. */
function zones(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value.slice(0, 32)) { const z = zone(entry); if (!z) return undefined; if (!out.includes(z)) out.push(z); }
  return out.slice(0, CLOCK_ZONES_MOST);
}
/** The zones kept: the list, or (kept before 14 Nov, when the Clock had one second city) that one zone as the first. */
const zonesKept = (clock: any): string[] => zones(clock?.zones) ?? ((z) => (z ? [z] : []))(zone(clock?.zone));
const city = (value: unknown) => (typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) : undefined);
/** A place, checked: a name, coordinates that are on the Earth, and only short plain words beside them. Takes a place
 *  as kept ({ lat, lon, code, tz }) or as Open-Meteo's search names one ({ latitude, longitude, country_code,
 *  timezone }). undefined: not one. */
export function homePlace(value: any): HomePlace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const name = city(value.name), lat = value.lat ?? value.latitude, lon = value.lon ?? value.longitude;
  if (!name || typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  const code = String(value.code ?? value.country_code ?? "").toUpperCase();
  return { name, admin1: city(value.admin1) || "", country: city(value.country) || "", code: /^[A-Z]{2}$/.test(code) ? code : "", lat, lon, tz: zone(value.tz ?? value.timezone) || "" };
}
const SHOWN_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
/** The settings as kept: only what each card has. */
function settings(value: unknown): HomeSettings {
  const from = value && typeof value === "object" ? value as Record<string, any> : {}, out: HomeSettings = {};
  const zs = zonesKept(from.clock);
  if (zs.length) out.clock = { zones: zs };
  const place = homePlace(from.weather?.place), c = place ? undefined : city(from.weather?.city), unit = from.weather?.unit === "f" ? "f" : from.weather?.unit === "c" ? "c" : undefined;
  if (place || c || unit) out.weather = { ...(place ? { place } : {}), ...(c ? { city: c } : {}), ...(unit ? { unit } : {}) };
  for (const card of ["widgets", "artifacts"] as const) if (typeof from[card]?.shown === "string" && SHOWN_ID.test(from[card].shown)) out[card] = { shown: from[card].shown };
  return out;
}
export type HomeUsageModel = { name: string; model: string; provider: string; where: string; tokens: number; share: number };
export type HomeUsageDay = { date: string; input_tokens: number; output_tokens: number; cached_input_tokens: number; requests: number; models?: HomeUsageModel[] };
/** A provider as people call it ("ollama" is Ollama); one this list doesn't know keeps its own name, capitalised. */
const PROVIDERS: Record<string, string> = { ollama: "Ollama", openai: "OpenAI", anthropic: "Anthropic", deepseek: "DeepSeek", google: "Google", gemini: "Gemini", openrouter: "OpenRouter", groq: "Groq", mistral: "Mistral",
  xai: "xAI", moonshot: "Moonshot", kimi: "Kimi", qwen: "Qwen", lmstudio: "LM Studio", "llama.cpp": "llama.cpp", llamacpp: "llama.cpp", vllm: "vLLM", codex: "Codex", "claude-code": "Claude Code", claude_code: "Claude Code", dgc: "DGC" };
const providerName = (value: unknown) => { const id = String(value ?? "").trim().slice(0, 60); return !id || id === "unknown" ? "" : PROVIDERS[id.toLowerCase()] || id.charAt(0).toUpperCase() + id.slice(1); };
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
/** get_usage's by-model rows as the card takes them: the same model on the same provider and system is one row; most
 *  tokens first; each with its share of all the rows' tokens (whole per cent). `most`: how many are kept. */
function usageModels(rows: unknown, most: number): { models: HomeUsageModel[]; all: number } {
  const merged = new Map<string, HomeUsageModel>();
  for (const row of Array.isArray(rows) ? rows.slice(0, 100) : []) {
    const model = String((row as any)?.model || "").slice(0, 80), where = String((row as any)?.system || (row as any)?.system_name || "").slice(0, 60);
    const provider = providerName((row as any)?.provider) || where, tokens = count((row as any)?.input_tokens) + count((row as any)?.output_tokens);
    if (!model || !tokens) continue;
    const key = `${model}\n${provider}\n${where}`, had = merged.get(key);
    if (had) had.tokens += tokens; else merged.set(key, { name: where && where !== model ? `${model} (${where})` : model, model, provider, where, tokens, share: 0 });
  }
  const all = [...merged.values()].sort((a, b) => b.tokens - a.tokens), total = all.reduce((sum, row) => sum + row.tokens, 0);
  for (const row of all) row.share = total ? Math.round((row.tokens / total) * 100) : 0;
  return { models: all.slice(0, most), all: all.length };
}
/** The token report (get_usage) as the card takes it. `period`: the thirty days' own report, for its models. `today`:
 *  today's own report, whose models are today's column's. A day that names its own models (`by_day[].models`, should
 *  the ledger send them) keeps its top three. `modelCount`: how many models the thirty days had in all. */
export function usageForHome(report: any, period: any, today?: any): { type: "homeUsage"; days: HomeUsageDay[]; models: HomeUsageModel[]; modelCount: number; error: string } {
  const days: HomeUsageDay[] = (Array.isArray(report?.by_day) ? report.by_day : []).filter((d: any) => typeof d?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date)).slice(-120)
    .map((d: any) => { const own = Array.isArray(d.models) ? usageModels(d.models, 3).models : [];
      return { date: d.date as string, input_tokens: count(d.input_tokens), output_tokens: count(d.output_tokens), cached_input_tokens: count(d.cached_input_tokens), requests: count(d.requests), ...(own.length ? { models: own } : {}) }; });
  // Today's models, from today's own report: its one day is a day of the other reports too.
  const now = Array.isArray(today?.by_day) && today.by_day.length === 1 && typeof today.by_day[0]?.date === "string" ? days.find((d) => d.date === today.by_day[0].date) : undefined;
  if (now && !now.models) { const own = usageModels(today.by_model, 3).models; if (own.length) now.models = own; }
  const { models, all } = usageModels(period?.by_model, 8);
  return { type: "homeUsage", days, models, modelCount: all, error: typeof report?.error === "string" ? report.error.slice(0, 300) : "" };
}

export class HomeCards {
  private readonly listeners = new Set<() => void>();
  private readonly fetcher?: Fetcher;
  private readonly now: () => number;
  private held?: { where: string; at: number; said: HomeWeather };
  /** The places found for the last few things typed, so the same letters are not asked twice. */
  private readonly found = new Map<string, HomePlace[]>();
  /** The Notes card's own store (src/notes.ts): files in DGC's storage folder. None where there is no such folder. */
  readonly notes?: Notes;
  constructor(private readonly context: Pick<vscode.ExtensionContext, "globalState"> & Partial<Pick<vscode.ExtensionContext, "globalStorageUri" | "secrets">>, options: { fetcher?: Fetcher; now?: () => number; notes?: Notes } = {}) {
    this.notes = options.notes ?? (context.globalStorageUri && context.secrets ? new Notes(context as any, { now: options.now }) : undefined);
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
  /** One card's setting. Anything that is not one changes nothing. A Weather place is kept only whole, as the place
   *  search named it: a page cannot save a city by its name alone. */
  async setting(card: unknown, change: unknown): Promise<void> {
    if (card !== "clock" && card !== "weather" && card !== "widgets" && card !== "artifacts") return;
    const now = settings(this.kept().settings), from = change && typeof change === "object" ? change as Record<string, unknown> : {};
    if (card === "clock") {
      // The zones whole, as the page has them now; or (a page from before 14 Nov) the one zone: it is the first added
      // zone, and "" takes the first away.
      const had = now.clock?.zones ?? [];
      let next: string[] | undefined;
      if (from.zones !== undefined) next = zones(from.zones);
      else { const z = zone(from.zone); next = z === undefined ? undefined : z ? [z, ...had.slice(1).filter((x) => x !== z)] : had.slice(1); }
      if (!next) return;
      if (next.length) now.clock = { zones: next }; else delete now.clock;
    }
    else if (card === "widgets" || card === "artifacts") { if (typeof from.shown !== "string" || (from.shown && !SHOWN_ID.test(from.shown))) return; if (from.shown) now[card] = { shown: from.shown }; else delete now[card]; }
    else {
      const place = from.place === undefined ? now.weather?.place : homePlace(from.place), unit = from.unit === "f" || from.unit === "c" ? from.unit : now.weather?.unit;
      if (from.place !== undefined && !place) return;
      const legacy = place ? undefined : now.weather?.city;
      now.weather = { ...(place ? { place } : {}), ...(legacy ? { city: legacy } : {}), ...(unit ? { unit } : {}) };
      if (!now.weather.place && !now.weather.city && !now.weather.unit) delete now.weather;
    }
    await this.keep({ settings: now });
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
  /** The places Open-Meteo's search finds for the letters typed (two or more), at most eight. Never throws. */
  async places(typed: unknown, seq: unknown): Promise<HomePlaces> {
    const q = typeof typed === "string" ? typed.slice(0, 200) : "", n = Number.isFinite(Number(seq)) ? Number(seq) : 0, name = city(q) || "", key = name.toLowerCase();
    if (name.length < 2) return { type: "homeWeatherPlaces", q, seq: n, ok: true, places: [] };
    const had = this.found.get(key);
    if (had) return { type: "homeWeatherPlaces", q, seq: n, ok: true, places: had };
    try {
      const answer = await this.ask(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=8&language=en&format=json`);
      const places = (Array.isArray(answer?.results) ? answer.results.slice(0, 8) : []).map(homePlace).filter(Boolean) as HomePlace[];
      this.found.set(key, places);
      while (this.found.size > 40) this.found.delete(this.found.keys().next().value as string);
      return { type: "homeWeatherPlaces", q, seq: n, ok: true, places };
    } catch (error) {
      return { type: "homeWeatherPlaces", q, seq: n, ok: false, reason: (error as any)?.refused ? "refused" : "offline" };
    }
  }
  /** What the weather kept is the weather of: the place's coordinates, or a city typed before places were chosen. */
  private where(): { key: string; place?: HomePlace; city: string } {
    const w = settings(this.kept().settings).weather;
    return { key: w?.place ? `${w.place.lat},${w.place.lon}` : w?.city ? `city:${w.city}` : "", place: w?.place, city: w?.city || "" };
  }
  /** The weather for the place kept, from Open-Meteo: asked at most once in half an hour. Never throws. */
  async weather(): Promise<HomeWeather> {
    const at = this.where();
    if (!at.key) return { type: "homeWeather", ok: false, reason: "nocity" };
    if (this.held && this.held.where === at.key && this.now() - this.held.at < WEATHER_KEEP_MS) return this.held.said;
    const said = await this.readWeather(at.place, at.city);
    if (said.ok) this.held = { where: this.where().key, at: this.now(), said };      // (a typed city is a place by now)
    return said;
  }
  private async readWeather(known: HomePlace | undefined, typed: string): Promise<HomeWeather> {
    try {
      let place = known;
      if (!place) {
        // A city typed before places were chosen from a list: found once more, and kept as the place it is.
        place = homePlace((await this.ask(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(typed)}&count=1&language=en&format=json`))?.results?.[0]);
        if (!place) return { type: "homeWeather", ok: false, reason: "notfound" };
        const now = settings(this.kept().settings);
        if (now.weather?.city === typed && !now.weather.place) { now.weather = { place, ...(now.weather.unit ? { unit: now.weather.unit } : {}) }; await this.keep({ settings: { ...(this.kept().settings as object || {}), weather: now.weather } }); }
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
      return { type: "homeWeather", ok: true, place: [place.name, place.country].filter(Boolean).join(", ").slice(0, 120), at: this.now(), now: { temp, code: Number(f.current.weather_code) || 0, day: f.current.is_day !== 0 },
        high: Number(f?.daily?.temperature_2m_max?.[0]), low: Number(f?.daily?.temperature_2m_min?.[0]), hours };
    } catch (error) {
      return { type: "homeWeather", ok: false, reason: (error as any)?.refused ? "refused" : "offline" };
    }
  }

  /** A page's Home-cards message. False when it isn't one. `reply` gets what the page asked for. */
  handle(message: any, reply?: (said: any) => void): boolean {
    if (this.notes?.handle(message, reply)) return true;
    switch (message?.type) {
      // (Home is ready: its cards, and for the Notes card the list of notes, never a note's words.)
      case "homeCardsReady": reply?.(this.state()); this.notes?.handle({ type: "homeNotesDo", op: "get" }, reply); return true;
      case "homeCardsSet": void this.setOrder(message.order).then(() => reply?.(this.state())); return true;
      case "homeCardsReset": void this.reset().then(() => reply?.(this.state())); return true;
      case "homeCardSetting":
        void this.setting(message.card, message.settings).then(async () => {
          reply?.(this.state());
          if (message.card === "weather" && message.settings && typeof message.settings === "object" && "place" in message.settings) reply?.(await this.weather());
        });
        return true;
      case "homeWeatherSuggest": void this.places(message.q, message.seq).then((said) => reply?.(said)); return true;
      case "homeWeatherGet": void this.weather().then((said) => reply?.(said)); return true;
      default: return false;
    }
  }
}

const homes = new WeakMap<object, HomeCards>();
/** The one Home of this extension (every window's side bar shares it). */
export function homeCardsOf(context: vscode.ExtensionContext): HomeCards {
  let home = homes.get(context);
  if (!home) { home = new HomeCards(context, { notes: notesOf(context) }); homes.set(context, home); }
  return home;
}

/** Bounded presentation data in Work, ChatDGC and Pip replies. The host owns rendering. */
export type GenerativeUiBlock = Record<string, unknown> & { type: "metrics" | "steps" | "bars" | "table" | "choices" };
export type GenerativeUiCard = { version: "1"; title: string; subtitle?: string; blocks: GenerativeUiBlock[] };

const limits: Record<GenerativeUiBlock["type"], number> = { metrics: 8, steps: 8, bars: 12, table: 8, choices: 4 };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
/** A text field: a string, or a finite number or true/false read as its text (as the editor draws it). Models
 *  write {"value": 42} and [["a.py", 120]] as often as strings. */
const text = (value: unknown): string | null => typeof value === "string" ? value
  : typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) ? String(value) : null;
// Lengths in characters (code points), as the Python SDK's extract_generative_ui counts them: the two read a reply the
// same way (tests/fixtures/sdk_generative_ui.json).
const chars = (value: string): number => { let n = 0; for (const _ of value) n++; return n; };
const word = (value: unknown, limit: number): boolean => {
  const t = text(value);
  return t !== null && !!t.trim() && chars(t) <= limit;
};
const states = ["done", "running", "attention", "waiting"];
const asText = (value: unknown): unknown => text(value) ?? value;
// The text fields of each block's items; a bar's value stays a number.
const textFields: Record<string, string[]> = { metrics: ["label", "value", "detail"], steps: ["label", "detail"],
  bars: ["label"], choices: ["label", "description", "reply"] };

/** The card with every number or true/false in a text field given as its text. */
function cardText(card: Record<string, unknown>): GenerativeUiCard {
  const blocks = (card.blocks as Record<string, unknown>[]).map((raw) => {
    const block: Record<string, unknown> = { ...raw, ...("label" in raw ? { label: asText(raw.label) } : {}) };
    if (block.type === "table") {
      block.columns = (block.columns as unknown[]).map(asText);
      block.rows = (block.rows as unknown[][]).map((row) => row.map(asText));
    } else {
      const fields = textFields[block.type as string];
      block.items = (block.items as Record<string, unknown>[]).map((item) => Object.fromEntries(
        Object.entries(item).map(([key, value]) => [key, fields.includes(key) ? asText(value) : value])));
    }
    return block;
  });
  return { ...card, title: asText(card.title), ...("subtitle" in card ? { subtitle: asText(card.subtitle) } : {}),
    blocks } as GenerativeUiCard;
}

function validBlock(value: unknown): value is GenerativeUiBlock {
  if (!object(value) || typeof value.type !== "string"
      || !Object.prototype.hasOwnProperty.call(limits, value.type)) return false;
  const kind = value.type as GenerativeUiBlock["type"];
  if (kind === "table") {
    const columns = value.columns, rows = value.rows;
    return Array.isArray(columns) && columns.length >= 1 && columns.length <= 5
      && columns.every((column: unknown) => word(column, 70))
      && Array.isArray(rows) && rows.length >= 1 && rows.length <= 8
      && rows.every((row: unknown) => Array.isArray(row) && row.length === columns.length
        && row.every((cell: unknown) => text(cell) !== null && chars(text(cell)!) <= 150));
  }
  const items = value.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > limits[kind]) return false;
  return items.every((item: unknown) => {
    if (!object(item)) return false;
    if (kind === "metrics") return word(item.label, 60) && word(item.value, 40);
    if (kind === "steps") {
      const state = Object.prototype.hasOwnProperty.call(item, "state") ? item.state : "waiting";
      return word(item.label, 110) && typeof state === "string" && states.includes(state);
    }
    if (kind === "bars") return word(item.label, 45) && typeof item.value === "number"
      && Number.isFinite(item.value) && item.value >= 0 && item.value <= 1_000_000;
    const reply = text(item.reply);
    return word(item.label, 70) && reply !== null && word(reply, 500) && !reply.trimStart().startsWith("/")
      && !/\s\/(?:goal|plan|review|init)$/i.test(reply.trim());
  });
}

/** Parse inert v1 cards. A choice's reply is text, never a tool call or approval. */
export function extractGenerativeUi(reply: string): GenerativeUiCard[] {
  if (typeof reply !== "string") throw new TypeError("reply must be a string");
  const cards: GenerativeUiCard[] = [];
  for (const match of reply.matchAll(/^```dgc-ui[ \t]*\n(.*?)\n```[ \t]*$/gms)) {
    if (chars(match[1]) > 16_384) continue;
    let value: unknown;
    try { value = JSON.parse(match[1]); } catch { continue; }
    if (object(value) && value.version === "1" && word(value.title, 120)
        && Array.isArray(value.blocks) && value.blocks.length >= 1 && value.blocks.length <= 6
        && value.blocks.every(validBlock)) cards.push(cardText(value));
  }
  return cards;
}

/** Bounded presentation data in Work, ChatDGC and Pip replies. The host owns rendering. */
export type GenerativeUiBlock = Record<string, unknown> & { type: "metrics" | "steps" | "bars" | "table" | "choices" };
export type GenerativeUiCard = { version: "1"; title: string; subtitle?: string; blocks: GenerativeUiBlock[] };

const limits: Record<GenerativeUiBlock["type"], number> = { metrics: 8, steps: 8, bars: 12, table: 8, choices: 4 };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const word = (value: unknown, limit: number): value is string => typeof value === "string" && !!value.trim() && value.length <= limit;

function validBlock(value: unknown): value is GenerativeUiBlock {
  if (!object(value) || typeof value.type !== "string" || !(value.type in limits)) return false;
  const kind = value.type as GenerativeUiBlock["type"];
  if (kind === "table") {
    const columns = value.columns, rows = value.rows;
    return Array.isArray(columns) && columns.length >= 1 && columns.length <= 5
      && columns.every((column: unknown) => word(column, 70))
      && Array.isArray(rows) && rows.length >= 1 && rows.length <= 8
      && rows.every((row: unknown) => Array.isArray(row) && row.length === columns.length
        && row.every((cell: unknown) => typeof cell === "string" && cell.length <= 150));
  }
  const items = value.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > limits[kind]) return false;
  return items.every((item: unknown) => {
    if (!object(item)) return false;
    if (kind === "metrics") return word(item.label, 60) && word(item.value, 40);
    if (kind === "steps") return word(item.label, 110)
      && ["done", "running", "attention", "waiting"].includes(String(item.state ?? "waiting"));
    if (kind === "bars") return word(item.label, 45) && typeof item.value === "number"
      && Number.isFinite(item.value) && item.value >= 0 && item.value <= 1_000_000;
    const reply = item.reply;
    return word(item.label, 70) && word(reply, 500) && !reply.trimStart().startsWith("/")
      && !/\s\/(?:goal|plan|review|init)$/i.test(reply);
  });
}

/** Parse inert v1 cards. A choice's reply is text, never a tool call or approval. */
export function extractGenerativeUi(reply: string): GenerativeUiCard[] {
  if (typeof reply !== "string") throw new TypeError("reply must be a string");
  const cards: GenerativeUiCard[] = [];
  for (const match of reply.matchAll(/^```dgc-ui[ \t]*\n(.*?)\n```[ \t]*$/gms)) {
    if (match[1].length > 16_384) continue;
    let value: unknown;
    try { value = JSON.parse(match[1]); } catch { continue; }
    if (object(value) && value.version === "1" && word(value.title, 120)
        && Array.isArray(value.blocks) && value.blocks.length >= 1 && value.blocks.length <= 6
        && value.blocks.every(validBlock)) cards.push(value as GenerativeUiCard);
  }
  return cards;
}

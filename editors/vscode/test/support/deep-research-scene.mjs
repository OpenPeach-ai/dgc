// A Work turn that is in the middle of deep_research (live round 1, finding 43): the tool call, its progress lines as
// dgc/deep_research.py sends them through tool_progress, the backend's own activity label and its generic time
// estimate. Shared by deep-research-row-browser.test.mjs and the pictures. Not a *.test.mjs file.
import { openThinkingPage } from "../render-thinking.mjs";

export const QUESTION = "Which UK energy suppliers offer a heat pump electricity tariff in 2026, and what are the unit rates and conditions?";
export const PROGRESS = ["Plan: UK heat pump electricity tariffs in 2026", "Round 9 of 16: choosing what to search", "ScottishPower Heat Pump Saver available new customers 2026",
  "Writing the report from 127 sources", "Checking the citations…"];
/** The frames of the turn up to `step` progress lines (all of them by default). depth: quick | standard | thorough | "" (none said). */
export function researchTurn({ id = "t1", depth = "quick", step = 3, eta = "~1–3 min left", done = false } = {}) {
  const frames = [
    { type: "turn_start", turn_id: id, prompt: `Do a deep research for me: ${QUESTION}`, kind: "prompt" },
    { type: "text_delta", text: "I'll research UK heat pump electricity tariffs for 2026." },
    { type: "stream_end", message_id: `${id}:1`, phase: "commentary" },
    { type: "tool_call", call_id: "r1", name: "deep_research", args: { question: QUESTION, ...(depth ? { depth } : {}) }, summary: "" },
    { type: "turn_activity", turn_id: id, state: "tool", label: "Running deep_research", detail: "" },
    ...(eta ? [{ type: "turn_eta", turn_id: id, label: eta }] : []),
    ...PROGRESS.slice(0, step).map((message) => ({ type: "tool_progress", call_id: "r1", name: "deep_research", message })),
  ];
  if (done) frames.push({ type: "tool_result", call_id: "r1", name: "deep_research", output: "# UK heat pump tariffs\n\nOctopus Cosy …", is_error: false },
    { type: "text_delta", text: "Here is the report." }, { type: "stream_end", message_id: `${id}:2`, phase: "answer" },
    { type: "turn_end", turn_id: id, reason: "completed", token_estimate: 10, final_message_id: `${id}:2` });
  return frames;
}
export const send = (page, events) => page.evaluate((list) => { for (const event of list) window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event } })); }, events);
/** Opens a Work chat and plays the turn. */
export async function openResearch(browser, { width = 700, height = 520, theme = "dark-modern", ...turn } = {}) {
  const page = await openThinkingPage(browser, { theme, width, height, config: { model: "deepseek-v4.1-flash:cloud" } });
  await send(page, researchTurn(turn));
  await page.evaluate(() => new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(d, 350)))));
  return page;
}
/** The row as drawn: the group's sentence, the live row's words and fonts, the turn's own line, and the step's card. */
export const rowNow = (page) => page.evaluate(() => {
  const turn = [...document.querySelectorAll("#log .msg.dgc")].at(-1), q = (s) => turn.querySelector(s);
  const font = (n) => (n ? getComputedStyle(n).fontFamily : ""), body = getComputedStyle(document.querySelector("#log .msg.dgc .text") || document.body).fontFamily;
  const live = q(".tg-live"), arg = q(".tg-live-arg"), card = q('.tool[data-tool-name="deep_research"]');
  const mono = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim();
  return { sentence: q(".tool-group-label .tg-label-text")?.textContent || "", liveVerb: q(".tg-live-verb")?.textContent || "", liveArg: arg?.textContent || "", liveArgFont: font(arg), bodyFont: body, mono,
    liveShown: !!live?.checkVisibility(), liveLines: arg ? arg.getClientRects().length : 0, liveCut: arg ? arg.scrollWidth > arg.clientWidth + 1 : false,
    turnVerb: q(".thinking .verb")?.textContent || "", turnMeta: q(".thinking .meta")?.textContent || "",
    cardVerb: card?.querySelector(".verb")?.textContent || "", cardArg: card?.querySelector(".arg")?.textContent || "", cardTitle: card?.querySelector(".tool-toggle")?.title || "",
    all: turn.innerText.replace(/\s+/g, " "), sideways: document.documentElement.scrollWidth > innerWidth };
});

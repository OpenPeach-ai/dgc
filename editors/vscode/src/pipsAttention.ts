// What the editor says when a Pip needs you and the panel may not be on screen: a new finding at a
// Pip's alert level, or more reviews waiting than last time. The extension host reads the digest
// once a minute and shows one notification with "Open Pips". What was said is remembered in the
// host's global state, so a reload or another window does not say it again.
export interface PipsAttentionState { alerts: string[]; reviews: number }
export interface PipsAttention { text: string | null; state: PipsAttentionState }

const MAX_REMEMBERED = 200;

/** The number in words: what Needs attention lists, and a project's reviews named apart. "" when nothing waits. dgc/pip_attention.py
 *  waiting_words says the same for the desktop notice. */
export function waitingWords(total: number, inProjects: number, place = ''): string {
  const reviews = `${inProjects} review${inProjects === 1 ? '' : 's'}`;
  if (!total) return inProjects ? `${reviews} waiting for you in a project.` : '';
  const things = `${total} ${total === 1 ? 'thing is' : 'things are'} waiting for you${place}`;
  return inProjects ? `${things}, and ${reviews} in a project.` : `${things}.`;
}

/** `waiting`: Needs attention's total (list_pip_attention, API 44), the one number the Pips home and its rows say, so the
 *  notice says it too. `elsewhere`: the reviews waiting in project folders, which that list doesn't show: named apart, in
 *  their own words, never added in. The digest's counts differ (it counts all folders' reviews and only some cards), so
 *  they're only for a DGC without the list: taking the larger said "2 things" beside a home that said 1. */
export function pipsAttention(digest: any, previous: PipsAttentionState | undefined, waiting?: number, elsewhere = 0): PipsAttention | null {
  if (!digest || typeof digest !== 'object' || !Array.isArray(digest.pips)) return null;
  const before: PipsAttentionState = {
    alerts: Array.isArray(previous?.alerts) ? previous!.alerts.filter((id) => typeof id === 'string') : [],
    reviews: Number.isSafeInteger(previous?.reviews) ? previous!.reviews : 0,
  };
  const alerts: string[] = [];
  if (digest.reason === 'alert') {
    for (const pip of digest.pips) {
      if (pip?.alert !== true || !Array.isArray(pip.new_findings)) continue;
      for (const finding of pip.new_findings) {
        if (typeof finding?.run_id === 'string' && Number.isSafeInteger(finding.finding_index)) alerts.push(`${finding.run_id}:${finding.finding_index}`);
      }
    }
  }
  const counted = (Number.isSafeInteger(digest.pending_reviews) ? digest.pending_reviews : 0)
    + (Number.isSafeInteger(digest.pending_setups) ? digest.pending_setups : 0)
    + (Number.isSafeInteger(digest.pending_actions) ? digest.pending_actions : 0);
  const listed = Number.isSafeInteger(waiting) && waiting! >= 0;
  const inProjects = listed && Number.isSafeInteger(elsewhere) && elsewhere > 0 ? elsewhere : 0;
  const reviews = listed ? waiting! + inProjects : counted;
  const fresh = alerts.filter((id) => !before.alerts.includes(id));
  const state: PipsAttentionState = { alerts: [...before.alerts, ...fresh].slice(-MAX_REMEMBERED), reviews };
  const headline = typeof digest.headline === 'string' ? digest.headline.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  let text: string | null = null;
  if (fresh.length && headline) text = `DGC Pips: ${headline}`;
  else if (reviews > before.reviews) {
    text = !listed ? `DGC Pips: ${reviews} review${reviews === 1 ? '' : 's'} waiting for you.` : `DGC Pips: ${waitingWords(waiting!, inProjects)}`;
  }
  if (!text && state.reviews === before.reviews && !fresh.length) return null;
  return { text, state };
}

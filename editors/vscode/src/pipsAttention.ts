// What the editor says when a Pip needs you and the panel may not be on screen: a new finding at a
// Pip's alert level, or more reviews waiting than last time. The extension host reads the digest
// once a minute and shows one notification with "Open Pips". What was said is remembered in the
// host's global state, so a reload or another window does not say it again.
export interface PipsAttentionState { alerts: string[]; reviews: number }
export interface PipsAttention { text: string | null; state: PipsAttentionState }

const MAX_REMEMBERED = 200;

export function pipsAttention(digest: any, previous: PipsAttentionState | undefined): PipsAttention | null {
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
  const reviews = (Number.isSafeInteger(digest.pending_reviews) ? digest.pending_reviews : 0)
    + (Number.isSafeInteger(digest.pending_setups) ? digest.pending_setups : 0)
    + (Number.isSafeInteger(digest.pending_actions) ? digest.pending_actions : 0);
  const fresh = alerts.filter((id) => !before.alerts.includes(id));
  const state: PipsAttentionState = { alerts: [...before.alerts, ...fresh].slice(-MAX_REMEMBERED), reviews };
  const headline = typeof digest.headline === 'string' ? digest.headline.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
  let text: string | null = null;
  if (fresh.length && headline) text = `DGC Pips: ${headline}`;
  else if (reviews > before.reviews) text = `DGC Pips: ${reviews} review${reviews === 1 ? '' : 's'} waiting for you.`;
  if (!text && state.reviews === before.reviews && !fresh.length) return null;
  return { text, state };
}

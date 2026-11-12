// How long ago, in a few characters ("now", "5m", "2h", "1d", "3w", "4mo", "2y"): the Work list's own words for when a
// session is from (0.52, 12 Nov night). One helper, so every place that says a Work session's age says it the same way:
// the Work list and Home (media/main.js), the dialog that moves a session's Project Pips, and a Project Pip's "Reports
// to" picker (src/pipOwner.js). A classic script: Work's page loads it before its own script and the Pips bundle imports
// it, so both share DgcAge.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcAge) return;
  /** `when` is the host's "YYYY-MM-DD HH:MM" (local time); anything else is shown as it is. */
  function sessionAge(when, now = Date.now()) {
    const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)/.exec(String(when || ""));
    if (!m) return String(when || "").slice(0, 12);
    const minutes = Math.floor((now - new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime()) / 60000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
    const days = Math.floor(minutes / 1440);
    if (days < 7) return `${days}d`;
    if (days < 30) return `${Math.floor(days / 7)}w`;
    if (days <= 365) return `${Math.floor(days / 30)}mo`;
    return `${Math.floor(days / 365)}y`;
  }
  root.DgcAge = { sessionAge };
})();

// When a message was sent or written, the same in DGC's chat, ChatDGC and Pips: the time alone today, "Yesterday"
// and then the weekday for the week before, and the date after that, with the year once it isn't this year. The
// tooltip is the whole date and time. A page draws it with DgcTime.node(at, className) or, in markup, DgcTime.markup.
//
// `at` is milliseconds since 1970 (Date.now(), Date.parse(iso)); anything else draws nothing.
(function (root) {
  "use strict";

  const DAY = 86_400_000;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const valid = (at) => typeof at === "number" && Number.isFinite(at) && at > 0;

  function label(at, now = Date.now()) {
    if (!valid(at)) return "";
    const when = new Date(at), today = new Date(now);
    const clock = when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const days = Math.round((startOfDay(today) - startOfDay(when)) / DAY);
    if (days === 0) return clock;
    if (days === 1) return `Yesterday ${clock}`;
    if (days > 1 && days < 7) return `${when.toLocaleDateString(undefined, { weekday: "short" })} ${clock}`;
    const date = when.toLocaleDateString(undefined, when.getFullYear() === today.getFullYear()
      ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
    return `${date}, ${clock}`;
  }

  function title(at) {
    return valid(at) ? new Date(at).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" }) : "";
  }

  // A <time> element, or null when there is no time to show.
  function node(at, className = "msg-time", doc = root.document) {
    if (!valid(at) || !doc) return null;
    const time = doc.createElement("time");
    time.className = className;
    time.dateTime = new Date(at).toISOString();
    time.title = title(at);
    time.textContent = label(at);
    return time;
  }

  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function markup(at, className = "msg-time") {
    if (!valid(at)) return "";
    return `<time class="${escape(className)}" datetime="${new Date(at).toISOString()}" title="${escape(title(at))}">${escape(label(at))}</time>`;
  }

  root.DgcTime = { label, title, node, markup };
})(typeof window !== "undefined" ? window : globalThis);

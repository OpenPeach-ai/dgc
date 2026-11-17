// The model picker as a test reads it (media/shared/modelpicker.js), on any document: jsdom's or a page's own.
// `pickerDom(doc)` for a jsdom document; PICKER_READ is the same reader as a string, for page.evaluate. Not a test file.
export function pickerDom(doc) {
  const all = (selector) => [...doc.querySelectorAll(selector)];
  const api = {
    box: () => doc.querySelector(".dgc-mp"),
    open: () => !!doc.querySelector(".dgc-mp-layer"),
    tab: (id) => doc.querySelector(`.dgc-mp-tab[data-tab="${id}"]`),
    tabs: () => all(".dgc-mp-tab").map((t) => [t.textContent, t.getAttribute("aria-selected")]),
    rail: () => all(".dgc-mp-conn"),
    conn: (id) => all(".dgc-mp-conn").find((b) => b.dataset.rail === id) || null,
    connNames: () => all(".dgc-mp-conn").map((b) => b.title),
    shown: () => doc.querySelector(".dgc-mp-conn-name")?.textContent || "",
    list: () => doc.querySelector(".dgc-mp-list"),
    rows: () => all(".dgc-mp-list .dgc-mp-row"),
    names: () => api.rows().map((r) => r.querySelector(".dgc-mp-name").textContent),
    row: (name) => api.rows().find((r) => r.querySelector(".dgc-mp-name").textContent === name) || null,
    desc: (name) => api.row(name)?.querySelector(".dgc-mp-desc")?.textContent || "",
    chosen: () => api.rows().filter((r) => r.getAttribute("aria-selected") === "true").map((r) => r.querySelector(".dgc-mp-name").textContent),
    pills: () => api.rows().filter((r) => r.querySelector(".dgc-menu-pill")).map((r) => [r.querySelector(".dgc-mp-name").textContent, r.querySelector(".dgc-menu-pill").textContent]),
    more: (name) => api.row(name)?.closest(".dgc-mp-item")?.querySelector(".dgc-mp-more") || null,
    choices: () => all(".dgc-mp-choices button"),
    sections: () => all(".dgc-mp-sec").map((s) => s.textContent),
    foot: (id) => all(".dgc-mp-action").find((b) => b.dataset.foot === id) || null,
    levels: () => all(".dgc-mp-level").map((b) => b.dataset.level),
    level: (value) => all(".dgc-mp-level").find((b) => b.dataset.level === value) || null,
    levelNow: () => all(".dgc-mp-level").find((b) => b.getAttribute("aria-checked") === "true")?.dataset.level || "",
    thinkName: () => doc.querySelector(".dgc-mp-think-name")?.textContent || "",
    note: () => doc.querySelector(".dgc-mp-think-note")?.textContent || "",
    setting: (id) => all(".dgc-mp-select").find((s) => s.dataset.setting === id) || null,
    search: () => doc.querySelector(".dgc-mp-q"),
  };
  return api;
}

// A spreadsheet's editor, in the artifact panel (media/artifact.js): a grid to edit cells in (a formula as its text),
// rows and columns to add, remove and sort, a tab a sheet. Saving sends the whole workbook as the user's version.
// What a formula shows comes from DGC's own page of the saved version (dgc/artifact_sheet.py lays it out and works it
// out); until a change is saved, a formula shows its text, never a number that's no longer true. Inserting, deleting
// and sorting move every formula's references the way the backend does (media/sheetRefs.js).
(() => {
  "use strict";
  const A = (window.DgcArtifact = window.DgcArtifact || { editors: {} });
  const TYPES = [["text", "Text"], ["number", "Number"], ["currency", "Currency"], ["percent", "Percent"], ["date", "Date"], ["bool", "Yes / no"]];
  const MAX_COLUMNS = 200, PAGE_ROWS = 400, MAX_SHEETS = 20;
  const clone = (v) => JSON.parse(JSON.stringify(v));

  /** What a cell holds from what was typed in it, by its column's type (the backend checks it again). */
  function typed(text, col) {
    const raw = String(text ?? "");
    if (!raw.trim()) return null;
    if (raw.startsWith("=")) return raw.length > 1 ? raw : null;
    const kind = col?.type || "text";
    if (kind === "number" || kind === "currency" || kind === "percent") {
      const plain = raw.replace(/[,\s]/g, "").replace(/^[^\d\-.]{1,4}/, "");
      if (kind === "percent" && /^-?\d+(\.\d+)?%$/.test(plain)) return Number(plain.slice(0, -1)) / 100;
      if (/^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(plain)) return Number(plain);
      return raw;
    }
    if (kind === "bool") {
      const t = raw.trim().toLowerCase();
      if (["true", "yes", "y", "1", "✓"].includes(t)) return true;
      if (["false", "no", "n", "0"].includes(t)) return false;
      return raw;
    }
    return raw;
  }
  /** A cell's value as the box to edit it shows it. */
  function editText(v, col) {
    if (v === null || v === undefined) return "";
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    if (typeof v === "number" && col?.type === "percent") return `${+(v * 100).toPrecision(12)}%`;
    return String(v);
  }
  /** What each cell of DGC's page of the workbook shows: [sheet][row][col] -> {text, v, error, why}. */
  function readPage(html) {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    const out = [];
    doc.querySelectorAll("section.pane").forEach((pane) => {
      const rows = [];
      pane.querySelectorAll("tbody > tr").forEach((tr) => {
        rows.push([...tr.querySelectorAll(":scope > td")].map((td) => {
          const check = td.querySelector(".ck");
          const text = check ? (check.classList.contains("y") ? "Yes" : "No") : td.textContent;
          return { text, v: td.dataset.v ?? null, error: td.classList.contains("e"), why: td.getAttribute("title") || "" };
        }));
      });
      out.push(rows);
    });
    return out;
  }

  A.editors.sheet = () => {
    const u = A.util;
    let context;
    const R = window.DgcSheetRefs;
    const { el, icon } = u;
    let book = { sheets: [] }, savedJson = "", base = 0, si = 0, locked = false;
    let cur = { r: 0, c: 0 }, editing = null, shownRows = PAGE_ROWS;
    let anchor = null, visibleRows = [], filterText = "", paintDirty = null;
    let computed = null, computedFor = -1;            // DGC's page of version `computedFor`, read
    let root, tabs, grid, gridBox, fxAddr, fxInput, saveBtn, status, more, filterInput, filterStatus;

    const sheet = () => book.sheets[si];
    const dirty = () => JSON.stringify(book) !== savedJson;
    /** Computed values are shown only for the version they were worked out for, and only while nothing changed. */
    const current = () => !!computed && computedFor === base && !(paintDirty ?? dirty());
    function load(content, version) {
      const raw = content && typeof content === "object" ? clone(content) : { sheets: [] };
      book = { sheets: (Array.isArray(raw.sheets) ? raw.sheets : []).map((s) => ({
        name: String(s.name || "Sheet1"), columns: (s.columns || []).map((c) => ({ ...c })),
        rows: (s.rows || []).map((r) => (s.columns || []).map((_, c) => (r[c] === undefined ? null : r[c]))), frozen: s.frozen ?? 1,
      })) };
      if (!book.sheets.length) book.sheets.push({ name: "Sheet1", columns: [{ name: "Column A", type: "text" }], rows: [[null]], frozen: 1 });
      savedJson = JSON.stringify(book);
      base = version;
      si = Math.min(si, book.sheets.length - 1);
      clampCursor();
    }
    function clampCursor() {
      const s = sheet();
      cur.r = Math.max(-1, Math.min(cur.r, s.rows.length - 1));
      cur.c = Math.max(0, Math.min(cur.c, s.columns.length - 1));
    }
    function touch() {
      const d = dirty();
      saveBtn.disabled = locked || !d;
      status.textContent = d ? "Unsaved changes · formulas are worked out when you save" : current() ? `Version ${base}` : `Version ${base} · working out the formulas…`;
      status.dataset.dirty = String(d);
      root.dataset.dirty = String(d);
    }

    // ---- what a cell shows
    function shown(r, c) {
      const v = sheet().rows[r]?.[c];
      const formula = R.isFormula(v);
      const col = sheet().columns[c];
      if (current()) {
        const got = computed?.[si]?.[r]?.[c];
        if (got) return { text: got.text, error: got.error, why: got.why, formula, v: got.v };
      }
      if (formula) return { text: v, pending: true, formula };
      if (typeof v === "boolean") return { text: v ? "Yes" : "No" };
      return { text: plain(v, col) };
    }
    /** A value typed here, in its column's format (as DGC's page shows it): it is the value, so never out of date. */
    function plain(v, col) {
      if (v === null || v === undefined) return "";
      if (typeof v !== "number" || !Number.isFinite(v)) return String(v);
      const grouped = (n) => Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: col?.decimals ?? 10, minimumFractionDigits: col?.decimals ?? 0 });
      const sign = v < 0 ? "\u2212" : "";
      if (col?.type === "currency") { const symbol = col.currency || "$"; return sign + (symbol.length === 1 ? symbol : `${symbol} `) + grouped(v); }
      if (col?.type === "percent") return `${sign}${grouped(+(v * 100).toPrecision(12))}%`;
      if (col?.type === "number") return sign + grouped(v);
      return String(v);
    }
    const numeric = (c) => ["number", "currency", "percent", "date"].includes(sheet().columns[c]?.type);

    // ---- the grid
    function paintTabs() {
      tabs.replaceChildren();
      book.sheets.forEach((s, i) => {
        const tab = el("button", "sh-tab", s.name);
        tab.type = "button"; tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(i === si));
        tab.tabIndex = i === si ? 0 : -1;
        tab.title = "Double-click to rename";
        tab.addEventListener("click", () => { if (si !== i) { si = i; cur = { r: 0, c: 0 }; shownRows = PAGE_ROWS; paint(); } });
        tab.addEventListener("dblclick", () => renameSheet(i, tab));
        tab.addEventListener("keydown", (e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            const next = (i + (e.key === "ArrowRight" ? 1 : -1) + book.sheets.length) % book.sheets.length;
            si = next; cur = { r: 0, c: 0 }; paint(); tabs.children[next]?.focus();
          } else if (e.key === "F2") { e.preventDefault(); renameSheet(i, tab); }
        });
        tabs.append(tab);
      });
      const addTab = el("button", "art-icon sh-add-sheet"); addTab.type = "button";
      addTab.title = "Add a sheet"; addTab.setAttribute("aria-label", "Add a sheet");
      addTab.append(icon("add")); addTab.disabled = locked || book.sheets.length >= MAX_SHEETS;
      addTab.addEventListener("click", addSheet);
      tabs.append(addTab);
    }
    function paint() {
      paintDirty = dirty();
      anchor = null;
      paintTabs();
      const s = sheet();
      grid.replaceChildren();
      grid.setAttribute("aria-rowcount", String(s.rows.length + 1));
      grid.setAttribute("aria-colcount", String(s.columns.length));
      const head = el("thead");
      const letters = el("tr", "sh-letters");
      letters.append(el("th", "sh-corner"));
      s.columns.forEach((col, c) => {
        const th = el("th", "sh-letter");
        const b = el("button", "sh-col-menu"); b.type = "button";
        b.setAttribute("aria-haspopup", "menu"); b.setAttribute("aria-expanded", "false");
        b.setAttribute("aria-label", `Column ${R.letters(c)}: insert, delete, sort, type`);
        b.append(el("span", "", R.letters(c)), icon("chevron-down", "art-caret"));
        b.disabled = locked;
        const menu = el("div", "art-menu sh-menu"); menu.setAttribute("role", "menu"); menu.hidden = true;
        b.addEventListener("click", (e) => { e.stopPropagation(); u.showMenu(b, menu, columnMenu(c)); });
        th.append(b, menu);
        letters.append(th);
      });
      const names = el("tr", "sh-names");
      const one = el("th", "sh-rn", "1"); one.setAttribute("scope", "row");
      names.append(one);
      s.columns.forEach((col, c) => {
        const th = el("th", "sh-name");
        th.setAttribute("role", "columnheader");
        th.dataset.r = "-1"; th.dataset.c = String(c);
        th.append(el("span", "sh-text", col.name), el("span", "sh-type", (TYPES.find(([t]) => t === col.type) || [0, col.type])[1]));
        if (numeric(c)) th.classList.add("sh-num");
        names.append(th);
      });
      head.append(letters, names);
      const body = el("tbody");
      const matches = s.rows.map((_, r) => r).filter(r => !filterText
        || s.columns.some((_, c) => String(shown(r, c).text || "").toLocaleLowerCase().includes(filterText)));
      visibleRows = matches.slice(0, shownRows);
      for (const r of visibleRows) {
        const tr = el("tr");
        const rn = el("th", "sh-rn");
        rn.setAttribute("scope", "row");
        const b = el("button", "sh-row-menu", String(r + 2)); b.type = "button";
        b.setAttribute("aria-haspopup", "menu"); b.setAttribute("aria-expanded", "false");
        b.setAttribute("aria-label", `Row ${r + 2}: insert or delete`);
        b.disabled = locked;
        const menu = el("div", "art-menu sh-menu"); menu.setAttribute("role", "menu"); menu.hidden = true;
        b.addEventListener("click", (e) => { e.stopPropagation(); u.showMenu(b, menu, rowMenu(r)); });
        rn.append(b, menu);
        tr.append(rn);
        s.columns.forEach((_, c) => tr.append(cell(r, c)));
        body.append(tr);
      }
      grid.append(head, body);
      more.hidden = matches.length <= shownRows;
      more.textContent = `Show more rows (${matches.length - shownRows} more)`;
      filterStatus.textContent = filterText ? `${matches.length} of ${s.rows.length} rows · view only` : "Filter matches displayed values";
      select(cur.r, cur.c, false);
      touch();
      paintDirty = null;
    }
    function cell(r, c) {
      const td = el("td", "sh-cell");
      td.setAttribute("role", "gridcell");
      td.dataset.r = String(r); td.dataset.c = String(c);
      fill(td, r, c);
      return td;
    }
    function fill(td, r, c) {
      const got = shown(r, c);
      td.replaceChildren(el("span", "sh-text", got.text));
      td.classList.toggle("sh-num", numeric(c) && !got.pending);
      td.classList.toggle("sh-formula", !!got.formula);
      td.classList.toggle("sh-pending", !!got.pending);
      td.classList.toggle("sh-error", !!got.error);
      td.title = got.pending ? "A formula: what it shows is worked out when you save" : got.error && got.why ? got.why : "";
    }
    function at(r, c) { return grid.querySelector(`[data-r="${r}"][data-c="${c}"]`); }
    function select(r, c, focus = true, extend = false) {
      const s = sheet();
      r = Math.max(-1, Math.min(r, s.rows.length - 1));
      if (r >= 0 && !visibleRows.includes(r)) r = visibleRows[0] ?? -1;
      c = Math.max(0, Math.min(c, s.columns.length - 1));
      anchor = extend ? (anchor || { ...cur }) : null;
      for (const n of grid.querySelectorAll(".sh-range")) n.classList.remove("sh-range");
      for (const n of grid.querySelectorAll(".sh-sel")) { n.classList.remove("sh-sel"); n.setAttribute("aria-selected", "false"); }
      cur = { r, c };
      if (anchor) for (const n of grid.querySelectorAll("[data-r]")) {
        const nr = Number(n.dataset.r), nc = Number(n.dataset.c);
        if (nr >= Math.min(anchor.r, r) && nr <= Math.max(anchor.r, r)
          && nc >= Math.min(anchor.c, c) && nc <= Math.max(anchor.c, c)) n.classList.add("sh-range");
      }
      const node = at(r, c);
      if (node) { node.classList.add("sh-sel"); node.setAttribute("aria-selected", "true"); node.id = "sh-active"; grid.setAttribute("aria-activedescendant", "sh-active"); }
      for (const n of grid.querySelectorAll("[id='sh-active']")) if (n !== node) n.removeAttribute("id");
      fxAddr.textContent = r < 0 ? `${R.letters(c)}1` : `${R.letters(c)}${r + 2}`;
      fxInput.value = r < 0 ? s.columns[c]?.name || "" : editText(s.rows[r]?.[c], s.columns[c]);
      fxInput.setAttribute("aria-label", `${fxAddr.textContent}: ${r < 0 ? "column name" : "value or formula"}`);
      if (focus) { gridBox.focus({ preventScroll: true }); node?.scrollIntoView({ block: "nearest", inline: "nearest" }); }
    }
    function setCell(r, c, text) {
      const s = sheet();
      if (r < 0) {
        const name = String(text || "").trim();
        if (!name || name === s.columns[c].name) return;
        s.columns[c].name = name.slice(0, 80);
        paint();
        return;
      }
      const next = typed(text, s.columns[c]);
      if (JSON.stringify(next) === JSON.stringify(s.rows[r][c])) return;
      s.rows[r][c] = next;
      // Every formula now shows its text until it's worked out again: repaint them all, not just this cell.
      for (const td of grid.querySelectorAll("td.sh-cell")) fill(td, Number(td.dataset.r), Number(td.dataset.c));
      touch();
    }
    function startEdit(seed) {
      if (locked || editing) return;
      const { r, c } = cur;
      const node = at(r, c);
      if (!node) return;
      const box = el("input", "sh-edit");
      box.type = "text";
      const s = sheet();
      box.value = seed !== undefined ? seed : r < 0 ? s.columns[c].name : editText(s.rows[r][c], s.columns[c]);
      box.setAttribute("aria-label", `Edit ${fxAddr.textContent}`);
      node.replaceChildren(box);
      editing = { r, c, box };
      box.focus();
      if (seed === undefined) box.select(); else box.setSelectionRange(box.value.length, box.value.length);
      box.addEventListener("keydown", (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
          e.preventDefault(); save();
        }
        else if (e.key === "Enter") { e.preventDefault(); commit(); select(cur.r + (e.shiftKey ? -1 : 1), cur.c); }
        else if (e.key === "Tab") { e.preventDefault(); commit(); select(cur.r, cur.c + (e.shiftKey ? -1 : 1)); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
        e.stopPropagation();
      });
      box.addEventListener("blur", () => { if (editing?.box === box) commit(); });
    }
    function commit() {
      if (!editing) return;
      const { r, c, box } = editing;
      editing = null;
      setCell(r, c, box.value);
      const node = at(r, c);
      if (node) { if (r < 0) paint(); else fill(node, r, c); }
      select(r, c, false);
    }
    function cancel() {
      if (!editing) return;
      const { r, c } = editing;
      editing = null;
      const node = at(r, c);
      if (node && r >= 0) fill(node, r, c); else if (node) paint();
      select(r, c);
    }

    // ---- rows, columns, sheets: the backend's arithmetic for every formula (sheetRefs.js)
    function insertRow(r) { if (locked) return; R.insertRows(book.sheets, si, r + 2, 1); cur.r = r; paint(); u.announce(`Row ${r + 2} inserted.`); }
    function deleteRow(r) {
      if (locked) return;
      R.deleteRows(book.sheets, si, r + 2, 1);
      if (!sheet().rows.length) sheet().rows.push(sheet().columns.map(() => null));
      cur.r = Math.min(r, sheet().rows.length - 1); paint(); u.announce(`Row ${r + 2} deleted.`);
    }
    function freeName(base) {
      const used = new Set(sheet().columns.map((c) => c.name.toLowerCase()));
      for (let n = 1; ; n++) { const name = n === 1 ? base : `${base} ${n}`; if (!used.has(name.toLowerCase())) return name; }
    }
    function insertColumn(c) {
      if (locked || sheet().columns.length >= MAX_COLUMNS) return;
      R.insertColumns(book.sheets, si, c, [{ name: freeName(`Column ${R.letters(c)}`), type: "text" }]);
      cur.c = c; paint(); u.announce(`Column ${R.letters(c)} inserted.`);
    }
    function deleteColumn(c) {
      if (locked || sheet().columns.length <= 1) return;
      R.deleteColumns(book.sheets, si, c, 1);
      cur.c = Math.min(c, sheet().columns.length - 1); paint(); u.announce(`Column ${R.letters(c)} deleted.`);
    }
    function sortBy(c, descending) {
      if (locked) return;
      const s = sheet();
      const formulas = s.rows.some((row) => R.isFormula(row[c]));
      if (formulas && !current()) {
        u.banner("info", `Column ${R.letters(c)} has formulas, and what they show is worked out when you save. Save first, then sort by it.`);
        return;
      }
      const valueOf = (row, k, r) => {
        const v = row[k];
        if (!R.isFormula(v)) return v;
        const got = computed?.[si]?.[r - 2]?.[k];
        if (!got) return null;
        if (got.error) return { error: true };
        if (got.v !== null && got.v !== "" && Number.isFinite(Number(got.v))) return Number(got.v);
        return got.text;
      };
      try {
        const [first, last] = R.sortRows(book.sheets, si, c, descending, valueOf);
        paint();
        const all = last === s.rows.length + 1;
        u.announce(all ? `Sorted by ${s.columns[c].name}.` : `Sorted rows ${first} to ${last} by ${s.columns[c].name}; the total below stays where it is.`);
        if (!all) u.banner("info", `Sorted rows ${first} to ${last}. Row ${last + 1} reads the rows above it (a total), so it stays where it is.`);
      } catch (err) {
        u.banner("info", String(err.message || err));
      }
    }
    function setType(c, type) {
      const col = sheet().columns[c];
      if (col.type === type) return;
      col.type = type;
      if (type !== "currency") delete col.currency;
      if (!["number", "currency", "percent"].includes(type)) delete col.decimals;
      paint();
    }
    function columnMenu(c) {
      const s = sheet();
      const items = [
        ["Insert a column to the left", () => insertColumn(c)],
        ["Insert a column to the right", () => insertColumn(c + 1)],
        ["Sort A to Z (smallest first)", () => sortBy(c, false)],
        ["Sort Z to A (largest first)", () => sortBy(c, true)],
        ...TYPES.filter(([t]) => t !== s.columns[c].type).map(([t, label]) => [`Make it a ${label.toLowerCase()} column`, () => setType(c, t)]),
      ];
      if (s.columns.length > 1) items.push([`Delete column ${R.letters(c)}`, () => deleteColumn(c)]);
      return items;
    }
    function rowMenu(r) {
      const items = [["Insert a row above", () => insertRow(r)], ["Insert a row below", () => insertRow(r + 1)]];
      items.push([`Delete row ${r + 2}`, () => deleteRow(r)]);
      return items;
    }
    function addSheet() {
      if (locked || book.sheets.length >= MAX_SHEETS) return;
      const used = new Set(book.sheets.map((s) => s.name.toLowerCase()));
      let n = book.sheets.length + 1;
      while (used.has(`sheet${n}`)) n++;
      book.sheets.push({ name: `Sheet${n}`, columns: [{ name: "Column A", type: "text" }, { name: "Column B", type: "text" }],
                         rows: [[null, null], [null, null], [null, null]], frozen: 1 });
      si = book.sheets.length - 1; cur = { r: 0, c: 0 }; paint();
      u.announce(`Sheet${n} added.`);
    }
    function renameSheet(i, tab) {
      if (locked) return;
      const box = el("input", "sh-tab-edit"); box.type = "text"; box.value = book.sheets[i].name; box.maxLength = 31;
      box.setAttribute("aria-label", "Sheet name");
      tab.replaceWith(box); box.focus(); box.select();
      let done = false;
      const finish = (keep) => {
        if (done) return; done = true;
        const name = box.value.trim().replace(/[[\]:*?/\\]/g, "");
        const taken = book.sheets.some((s, j) => j !== i && s.name.toLowerCase() === name.toLowerCase());
        if (keep && name && name !== book.sheets[i].name && !taken) R.renameSheet(book.sheets, i, name);
        else if (keep && taken) u.banner("info", `There's already a sheet named “${name}”.`);
        paint();
        tabs.children[i]?.focus();
      };
      box.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") { e.preventDefault(); finish(false); } e.stopPropagation(); });
      box.addEventListener("blur", () => finish(true));
    }
    function deleteSheet() {
      if (locked || book.sheets.length <= 1) return;
      const name = sheet().name;
      u.banner("warn", `Delete the sheet “${name}”? A formula on another sheet that reads it shows #REF! afterwards. Nothing is lost until you save.`,
        [["Delete sheet", () => { u.hideBanner(); R.deleteSheet(book.sheets, si); si = Math.max(0, si - 1); cur = { r: 0, c: 0 }; paint(); }, true], ["Cancel", u.hideBanner]]);
    }

    function chartSelection() {
      if (editing) commit();
      const start = anchor || cur;
      const first = Math.max(0, Math.min(start.r, cur.r)), last = Math.max(start.r, cur.r);
      const c1 = Math.min(start.c, cur.c), c2 = Math.max(start.c, cur.c);
      const rows = visibleRows.filter(r => r >= first && r <= last);
      const columns = Array.from({ length: c2 - c1 + 1 }, (_, i) => c1 + i);
      const numericColumns = columns.filter(c => ["number", "currency", "percent"].includes(sheet().columns[c].type));
      if (!rows.length || !numericColumns.length) {
        u.banner("info", "Select numeric cells to chart. Shift-click or Shift+arrows selects a range; include a text column for labels.");
        return;
      }
      if (rows.length * numericColumns.length > 80) {
        u.banner("info", "Select at most 80 numeric cells for a readable chart. Filter rows or choose a smaller range.");
        return;
      }
      const formulas = rows.some(r => numericColumns.some(c => R.isFormula(sheet().rows[r][c])));
      if (formulas && !current()) {
        u.banner("info", "Save first to chart the calculated values of these formulas.");
        return;
      }
      const labelColumn = columns.find(c => !numericColumns.includes(c));
      const values = [];
      for (const r of rows) for (const c of numericColumns) {
        const raw = sheet().rows[r][c], displayed = shown(r, c);
        const value = R.isFormula(raw) ? (displayed.v !== null && displayed.v !== "" ? Number(displayed.v) : NaN) : raw;
        if (displayed.error || typeof value !== "number" || !Number.isFinite(value)) {
          u.banner("info", `Cell ${R.letters(c)}${r + 2} isn't a numeric value. Choose a range without empty cells or formula errors.`);
          return;
        }
        values.push({ value, column: c, label: labelColumn === undefined ? `Row ${r + 2}` : shown(r, labelColumn).text,
                      text: displayed.text, address: `${R.letters(c)}${r + 2}` });
      }
      document.getElementById("sh-chart")?.remove();
      const dialog = el("dialog", "art-compare sh-chart"); dialog.id = "sh-chart";
      dialog.setAttribute("aria-labelledby", "sh-chart-title");
      const title = el("h2", "", `${sheet().name} · ${R.letters(c1)}${first + 2}:${R.letters(c2)}${last + 2}`);
      title.id = "sh-chart-title";
      dialog.append(title, el("p", "", "Chart of the selected visible cells. This view doesn't change the workbook."));
      const legend = el("div", "sh-chart-legend");
      numericColumns.forEach((c, i) => {
        const key = el("span", "", sheet().columns[c].name); key.style.setProperty("--series", String(i % 3));
        key.dataset.series = String(i % 3); legend.append(key);
      });
      dialog.append(legend);
      const magnitude = Math.max(1, ...values.map(v => Math.abs(v.value)));
      const low = Math.min(0, ...values.map(v => v.value / magnitude)), high = Math.max(0, ...values.map(v => v.value / magnitude));
      const span = high - low || 1, zero = (0 - low) / span * 100;
      const plot = el("div", "sh-chart-plot"); plot.setAttribute("role", "img");
      plot.setAttribute("aria-label", `Bar chart with ${values.length} values. Exact values follow in the table.`);
      for (const item of values) {
        const row = el("div", "sh-chart-row"), label = el("span", "sh-chart-label", String(item.label));
        label.title = String(item.label);
        const track = el("div", "sh-chart-track"), axis = el("span", "sh-chart-zero"), bar = el("span", "sh-chart-bar");
        axis.style.left = `${zero}%`;
        bar.style.left = `${Math.min(zero, (item.value / magnitude - low) / span * 100)}%`;
        bar.style.width = `${Math.abs(item.value / magnitude) / span * 100}%`;
        bar.dataset.series = String(numericColumns.indexOf(item.column) % 3);
        bar.title = `${item.label} · ${sheet().columns[item.column].name}: ${item.text}`;
        track.append(axis, bar); row.append(label, track, el("span", "sh-chart-value", item.text)); plot.append(row);
      }
      const table = el("table", "sh-chart-values"), head = el("tr");
      for (const text of ["Cell", "Label", "Column", "Value"]) head.append(el("th", "", text));
      table.append(head);
      for (const item of values) {
        const row = el("tr");
        for (const text of [item.address, String(item.label), sheet().columns[item.column].name, item.text]) row.append(el("td", "", text));
        table.append(row);
      }
      const details = el("details"), summary = el("summary", "", "Exact values"); details.append(summary, table);
      const close = el("button", "art-btn", "Close chart"); close.type = "button";
      close.addEventListener("click", () => dialog.close());
      dialog.addEventListener("close", () => { dialog.remove(); gridBox.focus(); });
      dialog.append(plot, details, close); document.body.append(dialog); dialog.showModal(); close.focus();
    }

    function save() {
      if (locked) return;
      if (editing) commit();
      if (document.activeElement === fxInput) setCell(cur.r, cur.c, fxInput.value);
      if (!dirty()) return;
      saveBtn.disabled = true; status.textContent = "Saving…";
      u.post({ type: "save", content: { sheets: book.sheets }, base_version: base, note: "Your edits" });
    }

    function keys(e) {
      if (editing || e.target !== gridBox) return;
      const { r, c } = cur;
      const moveTo = (dr, dc) => {
        e.preventDefault();
        const pos = r < 0 ? -1 : visibleRows.indexOf(r);
        const next = dr ? (pos + dr < 0 ? -1 : visibleRows[Math.min(visibleRows.length - 1, pos + dr)] ?? -1) : r;
        select(next, c + dc, true, e.shiftKey);
      };
      if (e.key === "ArrowUp") moveTo(-1, 0);
      else if (e.key === "ArrowDown") moveTo(1, 0);
      else if (e.key === "ArrowLeft") moveTo(0, -1);
      else if (e.key === "ArrowRight") moveTo(0, 1);
      else if (e.key === "Home") { e.preventDefault(); select(r, 0); }
      else if (e.key === "End") { e.preventDefault(); select(r, sheet().columns.length - 1); }
      else if (e.key === "Enter" || e.key === "F2") { e.preventDefault(); startEdit(); }
      else if ((e.key === "Delete" || e.key === "Backspace") && r >= 0 && !locked) { e.preventDefault(); setCell(r, c, ""); fill(at(r, c), r, c); select(r, c); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !locked) { e.preventDefault(); startEdit(e.key); }
    }

    return {
      mount(main, ctx) {
        context = ctx;
        load(ctx.state.content, ctx.state.view.version);
        root = el("div", "sh");
        const bar = el("div", "art-toolbar sh-bar");
        const tool = (name, label, run, title) => {
          const b = el("button", "art-btn art-btn-quiet"); b.type = "button"; b.title = title || label;
          b.append(icon(name), el("span", "art-btn-label", label)); b.addEventListener("click", run); return b;
        };
        const addRow = tool("add", "Row", () => insertRow(sheet().rows.length), "Add a row at the end");
        const addCol = tool("add", "Column", () => insertColumn(sheet().columns.length), "Add a column at the end");
        const sortWrap = el("div", "art-menu-wrap");
        const sortBtn = tool("list-ordered", "Sort", () => {}, "Sort the rows by the chosen cell's column");
        sortBtn.setAttribute("aria-haspopup", "menu"); sortBtn.setAttribute("aria-expanded", "false");
        sortBtn.append(icon("chevron-down", "art-caret"));
        const sortMenu = el("div", "art-menu"); sortMenu.setAttribute("role", "menu"); sortMenu.hidden = true;
        sortBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const name = sheet().columns[cur.c]?.name || R.letters(cur.c);
          const type = sheet().columns[cur.c]?.type;
          const numeric = ["number", "currency", "percent"].includes(type);
          const order = numeric ? ["smallest first", "largest first"] : type === "date"
            ? ["oldest first", "newest first"] : ["A to Z", "Z to A"];
          u.showMenu(sortBtn, sortMenu, [[`By ${name}, ${order[0]}`, () => sortBy(cur.c, false)], [`By ${name}, ${order[1]}`, () => sortBy(cur.c, true)]]);
        });
        sortWrap.append(sortBtn, sortMenu);
        const delSheet = tool("trash", "Sheet", deleteSheet, "Delete this sheet");
        const chart = tool("graph", "Chart selection", chartSelection, "Chart selected cells; Shift-click or Shift+arrows extends a selection");
        status = el("span", "art-toolbar-note sh-status");
        saveBtn = el("button", "art-btn art-btn-primary"); saveBtn.type = "button";
        saveBtn.append(icon("save"), el("span", "art-btn-label", "Save"));
        saveBtn.title = "Save as your own version (Ctrl+S)";
        saveBtn.addEventListener("click", save);
        bar.append(addRow, addCol, sortWrap, delSheet, chart, el("span", "art-spacer"), status, saveBtn);
        const filter = el("div", "sh-filter");
        filterInput = el("input", "sh-filter-input"); filterInput.type = "search";
        filterInput.placeholder = "Filter rows…"; filterInput.setAttribute("aria-label", "Filter rows");
        filterInput.addEventListener("input", () => { filterText = filterInput.value.trim().toLocaleLowerCase(); shownRows = PAGE_ROWS; paint(); });
        filterStatus = el("span", "art-toolbar-note"); filterStatus.setAttribute("role", "status");
        filter.append(filterInput, filterStatus);
        tabs = el("div", "sh-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Sheets");
        const fx = el("div", "sh-fx");
        fxAddr = el("span", "sh-fx-addr");
        fxInput = el("input", "sh-fx-input"); fxInput.type = "text"; fxInput.spellcheck = false;
        fxInput.addEventListener("keydown", (e) => {
          if (e.key === "Enter") { e.preventDefault(); setCell(cur.r, cur.c, fxInput.value); if (cur.r < 0) paint(); else fill(at(cur.r, cur.c), cur.r, cur.c); select(cur.r + 1, cur.c); }
          else if (e.key === "Escape") { e.preventDefault(); select(cur.r, cur.c); }
        });
        fxInput.addEventListener("change", () => { setCell(cur.r, cur.c, fxInput.value); if (cur.r >= 0) fill(at(cur.r, cur.c), cur.r, cur.c); });
        fx.append(fxAddr, el("span", "sh-fx-mark", "fx"), fxInput);
        gridBox = el("div", "sh-scroll"); gridBox.tabIndex = 0;
        gridBox.setAttribute("aria-label", "Cells: arrow keys move, Shift extends selection, Enter or typing edits, Delete clears");
        grid = el("table", "sh-grid"); grid.setAttribute("role", "grid");
        gridBox.append(grid);
        gridBox.addEventListener("keydown", keys);
        gridBox.addEventListener("click", (e) => {
          const node = e.target.closest("[data-r]");
          if (!node || editing) return;
          select(Number(node.dataset.r), Number(node.dataset.c), true, e.shiftKey);
        });
        gridBox.addEventListener("dblclick", (e) => { if (e.target.closest("[data-r]")) startEdit(); });
        more = el("button", "art-btn art-btn-quiet sh-more"); more.type = "button";
        more.addEventListener("click", () => { shownRows += PAGE_ROWS; paint(); });
        root.append(tabs, filter, fx, gridBox, more);
        main.append(bar, root);
        paint();
      },
      update() {
        load(context.state.content, context.state.view.version);
        computed = null; computedFor = -1;
        paint();
      },
      dirty,
      save,
      saved(view) {
        base = view.version;
        savedJson = JSON.stringify(book);
        paint();
      },
      render(msg) {
        if (msg.error) { status.textContent = msg.error; return; }
        try { computed = readPage(msg.html); computedFor = msg.version; } catch { computed = null; }
        paint();
      },
      rejected() { touch(); },
      lock(on) {
        locked = !!on;
        paint();
        for (const n of root.parentElement.querySelectorAll(".sh-bar button")) n.disabled = locked;
        fxInput.readOnly = locked;
      },
    };
  };
  A.sheet = { typed, editText, readPage };
})();

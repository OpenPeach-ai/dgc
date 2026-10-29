// A sheet's formulas as the grid editor changes the sheet around them: the references in every formula move the way
// dgc/artifact_sheet.py moves them (insert and delete rows and columns, sort), so a total stays the total when the
// editor saves the whole workbook. The editor sends whole content (artifact_update), never the backend's edit ops, so
// this is the same arithmetic on this side: _tokens, _parse_ref, _ref_text, _insert_lines, _delete_lines, _fill and
// the sort's "a formula reading other rows being sorted" refusal. test/artifact-sheet-refs.test.mjs checks it against
// the Python, case by case. Nothing here evaluates a formula.
(function (root, make) {
  if (typeof module === "object" && module.exports) module.exports = make();
  else root.DgcSheetRefs = make();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const MAX_ROW = 1048576, MAX_COL = 16384;
  // The backend's _TOKENS, alternative for alternative. Python's [^\W\d][\w.]* is Unicode-aware; so is this.
  const NAME = "[\\p{L}\\p{M}_][\\p{L}\\p{M}\\p{N}_.]*";
  const TOKENS = new RegExp(
    "(?<ws>\\s+)"
    + "|(?<str>\"(?:[^\"]|\"\")*\")"
    + "|(?<err>#(?:REF!|DIV\\/0!|NAME\\?|VALUE!|N\\/A|NUM!|NULL!|CYCLE|CALC!))"
    + `|(?<ref>(?:'(?:[^']|'')+'!|${NAME}!)?(?:\\$?[A-Za-z]{1,3}\\$?\\d+(?::\\$?[A-Za-z]{1,3}\\$?\\d+)?|\\$?[A-Za-z]{1,3}:\\$?[A-Za-z]{1,3})(?![\\p{L}\\p{M}\\p{N}_.(!:]))`
    + "|(?<num>(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)"
    + `|(?<name>${NAME})`
    + "|(?<op><=|>=|<>|[-+*/^&=<>%(),])", "uy");
  const REF_PARTS = new RegExp(`^(?:(?<sheet>'(?:[^']|'')+'|${NAME})!)?(?<a>[^:]+)(?::(?<b>.+))?$`, "u");
  const POINT = /^(\$?)([A-Za-z]{1,3})(?:(\$?)(\d+))?$/;
  const PLAIN_SHEET = new RegExp(`^${NAME}$`, "u");

  /** Column A for 0, B for 1 … AA for 26. */
  function letters(index) {
    let n = index + 1, out = "";
    while (n > 0) { const r = (n - 1) % 26; out = String.fromCharCode(65 + r) + out; n = Math.floor((n - 1) / 26); }
    return out;
  }
  function columnIndex(text) {
    let n = 0;
    for (const ch of String(text).toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
    return n - 1;
  }
  function point(text) {
    const m = POINT.exec(text);
    if (!m) return null;
    const col = columnIndex(m[2]);
    const row = m[4] ? Number(m[4]) : null;
    if (col >= MAX_COL || (row !== null && !(row >= 1 && row <= MAX_ROW))) return null;
    return [col, row, !!m[1], !!m[3]];
  }
  function parseRef(text) {
    const m = REF_PARTS.exec(text);
    if (!m) return null;
    let sheet = m.groups.sheet ?? null;
    if (sheet && sheet.startsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
    const a = point(m.groups.a);
    if (!a) return null;
    if (m.groups.b === undefined) {
      if (a[1] === null) return null;
      return { sheet, c1: a[0], r1: a[1], c2: a[0], r2: a[1], ac1: a[2], ar1: a[3], ac2: a[2], ar2: a[3], single: true };
    }
    const b = point(m.groups.b);
    if (!b || (a[1] === null) !== (b[1] === null)) return null;
    const [c1, c2] = a[0] <= b[0] ? [a[0], b[0]] : [b[0], a[0]];
    const [ac1, ac2] = a[0] <= b[0] ? [a[2], b[2]] : [b[2], a[2]];
    if (a[1] === null) return { sheet, c1, r1: null, c2, r2: null, ac1, ar1: false, ac2, ar2: false, single: false };
    const [r1, r2] = a[1] <= b[1] ? [a[1], b[1]] : [b[1], a[1]];
    const [ar1, ar2] = a[1] <= b[1] ? [a[3], b[3]] : [b[3], a[3]];
    return { sheet, c1, r1, c2, r2, ac1, ar1, ac2, ar2, single: false };
  }
  const whole = (ref) => ref.r1 === null;
  function quoteSheet(name) {
    if (PLAIN_SHEET.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) && !["TRUE", "FALSE"].includes(name.toUpperCase())) return name;
    return "'" + name.replace(/'/g, "''") + "'";
  }
  function refText(ref) {
    const p = (c, r, ac, ar) => (ac ? "$" : "") + letters(c) + (r === null ? "" : (ar ? "$" : "") + String(r));
    let text = p(ref.c1, ref.r1, ref.ac1, ref.ar1);
    if (!ref.single) text += ":" + p(ref.c2, ref.r2, ref.ac2, ref.ar2);
    return ref.sheet !== null ? quoteSheet(ref.sheet) + "!" + text : text;
  }
  /** A formula's tokens (its text after "="), or null when it can't be read: such a formula is left as it is. */
  function tokens(formula) {
    const out = [];
    let i = 0;
    while (i < formula.length) {
      TOKENS.lastIndex = i;
      const m = TOKENS.exec(formula);
      if (!m || m[0].length === 0) return null;
      i = TOKENS.lastIndex;
      const kind = Object.keys(m.groups).find((k) => m.groups[k] !== undefined);
      let text = m[0];
      if (kind === "ref") {
        const ref = parseRef(text);
        if (ref) { out.push({ kind: "ref", text: refText(ref), ref }); continue; }
        out.push({ kind: "name", text: text.toUpperCase() });
        continue;
      }
      if (kind === "name") text = text.toUpperCase();
      out.push({ kind, text });
    }
    return out;
  }
  const isFormula = (v) => typeof v === "string" && v.length > 1 && v[0] === "=";
  /** The formula (text after "=") with each reference through change(ref): a new ref, or null for #REF!. */
  function rewrite(formula, change) {
    const toks = tokens(formula);
    if (!toks) return null;
    return toks.map((t) => {
      if (t.kind !== "ref") return t.text;
      const next = change(t.ref);
      return next === null ? "#REF!" : refText(next);
    }).join("");
  }
  function refs(formula) {
    const toks = tokens(formula);
    return toks ? toks.filter((t) => t.kind === "ref").map((t) => t.ref) : [];
  }
  const aimedAt = (ref, own, target) => String(ref.sheet !== null ? ref.sheet : own).toLowerCase() === String(target).toLowerCase();
  /** Every formula in the workbook through fn(text after "=", sheet index, row, col). */
  function eachFormula(sheets, fn) {
    sheets.forEach((s, si) => {
      s.rows.forEach((row, ri) => {
        row.forEach((v, c) => {
          if (!isFormula(v)) return;
          const next = fn(v.slice(1), si, ri + 2, c);
          if (next !== null) row[c] = "=" + next;
        });
      });
    });
  }
  /** n rows (or columns) inserted at `at` (a row number from 2, or a column index from 0) on sheet si: every reference
   *  to that sheet moves, and a range that ends right above them, read by a formula below them, takes them in. */
  function insertLines(sheets, si, at, n, rows) {
    const target = sheets[si].name;
    eachFormula(sheets, (formula, fsi, fr, fc) => {
      const own = sheets[fsi].name;
      const below = fsi === si && (rows ? fr >= at : fc >= at);
      return rewrite(formula, (ref) => {
        if (!aimedAt(ref, own, target)) return ref;
        if (rows) {
          if (whole(ref)) return ref;
          const r1 = ref.r1 >= at ? ref.r1 + n : ref.r1;
          let r2 = ref.r2 >= at ? ref.r2 + n : ref.r2;
          if (below && !ref.single && ref.r2 === at - 1 && (ref.r2 > ref.r1 || ref.c1 === ref.c2)) r2 = ref.r2 + n;
          return { ...ref, r1, r2: ref.single ? r1 : r2 };
        }
        const c1 = ref.c1 >= at ? ref.c1 + n : ref.c1;
        let c2 = ref.c2 >= at ? ref.c2 + n : ref.c2;
        if (below && !ref.single && ref.c2 === at - 1 && !whole(ref) && ref.r1 === ref.r2 && ref.c2 > ref.c1) c2 = ref.c2 + n;
        return { ...ref, c1, c2: ref.single ? c1 : c2 };
      });
    });
  }
  /** n rows (or columns) deleted from `at`: a reference to a deleted cell is #REF!, a range loses what went. */
  function deleteLines(sheets, si, at, n, rows) {
    const target = sheets[si].name, end = at + n - 1;
    const keep = (lo, hi) => {
      if (at <= lo && hi <= end) return null;
      const newLo = lo < at ? lo : (lo <= end ? end + 1 : lo);
      const newHi = hi > end ? hi : (hi >= at ? at - 1 : hi);
      return [newLo, newHi].map((v) => (v > end ? v - n : v));
    };
    eachFormula(sheets, (formula, fsi) => {
      const own = sheets[fsi].name;
      return rewrite(formula, (ref) => {
        if (!aimedAt(ref, own, target)) return ref;
        if (rows) {
          if (whole(ref)) return ref;
          const span = keep(ref.r1, ref.r2);
          return span === null ? null : { ...ref, r1: span[0], r2: span[1] };
        }
        const span = keep(ref.c1, ref.c2);
        return span === null ? null : { ...ref, c1: span[0], c2: span[1] };
      });
    });
  }
  /** A reference copied dr rows and dc columns away: its relative parts move, its $ parts stay. */
  function shift(ref, dr, dc) {
    const c1 = ref.ac1 ? ref.c1 : ref.c1 + dc, c2 = ref.ac2 ? ref.c2 : ref.c2 + dc;
    const r1 = whole(ref) || ref.ar1 ? ref.r1 : ref.r1 + dr, r2 = whole(ref) || ref.ar2 ? ref.r2 : ref.r2 + dr;
    if (Math.min(c1, c2) < 0 || Math.max(c1, c2) >= MAX_COL) return null;
    if (!whole(ref) && (Math.min(r1, r2) < 1 || Math.max(r1, r2) > MAX_ROW)) return null;
    if (ref.single) return { ...ref, c1, c2: c1, r1, r2: r1 };
    const [lc, hc] = c1 <= c2 ? [c1, c2] : [c2, c1];
    if (whole(ref)) return { ...ref, c1: lc, c2: hc };
    const [lr, hr] = r1 <= r2 ? [r1, r2] : [r2, r1];
    return { ...ref, c1: lc, c2: hc, r1: lr, r2: hr };
  }
  function fill(value, dr, dc) {
    const next = rewrite(value.slice(1), (ref) => shift(ref, dr, dc));
    return next === null ? value : "=" + next;
  }
  /** A formula in rows first..last of sheet si that reads other rows of that block (a total): sorting the block would
   *  scramble it. {cell, formula, top} (top: the last row above the first such total), or null when it can be sorted. */
  function sortProblem(sheets, si, first, last) {
    const s = sheets[si];
    let tangled = null;
    const pinned = new Set();
    for (let r = first; r <= last; r++) {
      s.rows[r - 2].forEach((v, k) => {
        if (!isFormula(v)) return;
        for (const ref of refs(v.slice(1))) {
          if (!aimedAt(ref, s.name, s.name) || whole(ref)) continue;
          if (ref.r1 <= last && ref.r2 >= first && !(ref.r1 === ref.r2 && ref.r2 === r)) {
            tangled = tangled || { cell: letters(k) + r, formula: v };
            pinned.add(ref.r1 === ref.r2 ? ref.r1 : r);
          }
        }
      });
    }
    if (!tangled) return null;
    return { ...tangled, top: pinned.size ? [...pinned].reduce((smallest, row) => Math.min(smallest, row), Infinity) - 1 : first };
  }
  /** The order of a sort key, as the backend's _sort_value: numbers, then text, then yes/no, then errors; empty last. */
  function sortKey(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "object" && v.error) return [3, ""];
    if (typeof v === "boolean") return [2, v ? 1 : 0];
    if (typeof v === "number") return [0, v];
    return [1, String(v).toLowerCase()];
  }
  function compareKeys(a, b) {
    if (a[0] !== b[0]) return a[0] - b[0];
    return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
  }
  /** Sheet si's data rows sorted by column c's values (`valueOf(row, c, r)` gives a row's sort value), each formula
   *  moving with its row. A total among them (a formula reading the other rows) stays put: the rows above it are
   *  sorted, as the backend's hint says. Returns the rows sorted [first, last]; throws Error when none can be. */
  function sortRows(sheets, si, c, descending, valueOf) {
    const s = sheets[si];
    let first = 2, last = s.rows.length + 1;
    let problem = last > first ? sortProblem(sheets, si, first, last) : null;
    if (problem) {
      last = problem.top;
      problem = last > first ? sortProblem(sheets, si, first, last) : problem;
      if (problem || last <= first) {
        throw new Error(`${problem ? problem.cell : "A total"}'s formula ${(problem ? problem.formula : "").slice(0, 60)} reads the rows `
          + "being sorted, so sorting would scramble it. Move it below the rows to sort, then sort again.");
      }
    }
    if (last <= first) return [first, last];
    const order = [];
    for (let r = first; r <= last; r++) order.push(r);
    const keyed = order.map((r) => ({ r, key: sortKey(valueOf(s.rows[r - 2], c, r)) }));
    const filled = keyed.filter((x) => x.key !== null);
    const empty = keyed.filter((x) => x.key === null);
    filled.sort((x, y) => (descending ? compareKeys(y.key, x.key) : compareKeys(x.key, y.key)));
    const next = [...filled, ...empty].map((x) => x.r);
    const moved = order.map((newR, i) => {
      const oldR = next[i];
      const row = s.rows[oldR - 2].slice();
      return newR === oldR ? row : row.map((v) => (isFormula(v) ? fill(v, newR - oldR, 0) : v));
    });
    s.rows.splice(first - 2, moved.length);
    for (let offset = 0; offset < moved.length; offset += 1000) {
      s.rows.splice(first - 2 + offset, 0, ...moved.slice(offset, offset + 1000));
    }
    return [first, last];
  }
  /** The grid's own operations, each the backend's: references first, then the rows or columns themselves. `sheets` is
   *  [{name, columns, rows}] with rows as long as the columns. Row numbers count from 2 (row 1 is the names). */
  function insertRows(sheets, si, at, n = 1) {
    insertLines(sheets, si, at, n, true);
    const width = sheets[si].columns.length;
    sheets[si].rows.splice(at - 2, 0, ...Array.from({ length: n }, () => Array(width).fill(null)));
  }
  function deleteRows(sheets, si, at, n = 1) {
    deleteLines(sheets, si, at, n, true);
    sheets[si].rows.splice(at - 2, n);
  }
  function insertColumns(sheets, si, at, columns) {
    insertLines(sheets, si, at, columns.length, false);
    sheets[si].columns.splice(at, 0, ...columns);
    for (const row of sheets[si].rows) row.splice(at, 0, ...columns.map(() => null));
  }
  function deleteColumns(sheets, si, at, n = 1) {
    deleteLines(sheets, si, at, n, false);
    sheets[si].columns.splice(at, n);
    for (const row of sheets[si].rows) row.splice(at, n);
  }
  function renameSheet(sheets, si, name) {
    const old = sheets[si].name.toLowerCase();
    eachFormula(sheets, (formula) => rewrite(formula, (ref) => (ref.sheet !== null && ref.sheet.toLowerCase() === old ? { ...ref, sheet: name } : ref)));
    sheets[si].name = name;
  }
  function deleteSheet(sheets, si) {
    const gone = sheets[si].name.toLowerCase();
    sheets.splice(si, 1);
    eachFormula(sheets, (formula) => rewrite(formula, (ref) => (ref.sheet !== null && ref.sheet.toLowerCase() === gone ? null : ref)));
  }
  return { letters, columnIndex, tokens, refs, isFormula, insertLines, deleteLines, fill, sortRows, sortProblem, parseRef, refText,
           insertRows, deleteRows, insertColumns, deleteColumns, renameSheet, deleteSheet };
}));

// A deck's editor, in the artifact panel (media/artifact.js): the slides down the left, to pick, drag or move with the
// keyboard; the chosen slide's layout and every field it shows; the theme; Present; and DGC's own page of the deck as
// the preview, the saved version's. Saving sends the whole deck as the user's version (artifact_update, base_version),
// with only the fields each layout shows, the way dgc/artifact_slides.py's normalize takes them.
(() => {
  "use strict";
  const A = (window.DgcArtifact = window.DgcArtifact || { editors: {} });
  const LAYOUTS = [["title", "Title"], ["section", "Section"], ["bullets", "Bullets"], ["two_columns", "Two columns"], ["image", "Picture"],
                   ["chart", "Chart"], ["quote", "Quote"], ["table", "Table"], ["closing", "Closing"]];
  const LAYOUT_NAME = Object.fromEntries(LAYOUTS);
  // What each layout shows, as normalize's _CONTENT; a field a layout doesn't show is kept here, not saved.
  const CONTENT = { title: [], section: [], closing: [], bullets: ["bullets"], two_columns: ["left", "right"], image: ["image", "bullets"],
                    chart: ["chart", "bullets"], quote: ["quote"], table: ["table"] };
  const THEMES = [["paper", "Paper"], ["dusk", "Dusk"], ["bold", "Bold"], ["plain", "Plain"]];
  const MAX_SLIDES = 60, MAX_TABLE_COLUMNS = 8, MAX_TABLE_ROWS = 15;
  const empty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);
  const clone = (v) => JSON.parse(JSON.stringify(v));

  /** Bullets as the box shows them: one a line, a sub-point indented under its bullet. */
  function bulletsText(list) {
    return (Array.isArray(list) ? list : []).map((b) => (typeof b === "string" ? b : [String(b.text || ""), ...(b.sub || []).map((s) => `    ${s}`)].join("\n"))).join("\n");
  }
  function parseBullets(text) {
    const out = [];
    for (const raw of String(text || "").split("\n")) {
      if (!raw.trim()) continue;
      if (/^\s/.test(raw) && out.length) {
        const last = out[out.length - 1];
        const point = typeof last === "string" ? { text: last, sub: [] } : last;
        point.sub.push(raw.trim());
        out[out.length - 1] = point;
      } else out.push(raw.trim());
    }
    return out;
  }
  /** The deck as it is saved: each slide with its layout and only the fields that layout shows, none empty. */
  function cleanDeck(deck) {
    return {
      size: deck.size || "16:9", theme: deck.theme || "paper",
      slides: deck.slides.map((s) => {
        const out = { layout: s.layout };
        for (const key of ["title", "subtitle"]) if (typeof s[key] === "string" && s[key].trim()) out[key] = s[key].trim();
        for (const key of CONTENT[s.layout] || []) {
          let v = s[key];
          if (key === "left" || key === "right") {
            v = v && typeof v === "object" ? { ...(v.heading && v.heading.trim() ? { heading: v.heading.trim() } : {}), ...(v.bullets?.length ? { bullets: v.bullets } : {}) } : null;
          } else if (key === "quote") {
            v = v && typeof v === "object" && String(v.text || "").trim() ? { text: String(v.text).trim(), ...(String(v.by || "").trim() ? { by: String(v.by).trim() } : {}) } : null;
          } else if (key === "image") {
            v = v && typeof v === "object" && v.src ? { src: v.src, ...(String(v.alt || "").trim() ? { alt: v.alt.trim() } : {}), ...(String(v.caption || "").trim() ? { caption: v.caption.trim() } : {}) } : null;
          }
          if (!empty(v)) out[key] = v;
        }
        if (typeof s.notes === "string" && s.notes.trim()) out.notes = s.notes.trim();
        return out;
      }),
    };
  }

  A.editors.slides = () => {
    const u = A.util;
    let context;
    const { el, icon } = u;
    let deck = { size: "16:9", theme: "paper", slides: [] }, savedJson = "", base = 0, sel = 0, locked = false;
    let root, list, fields, frame, caption, saveBtn, status, themePick, sizePick, presentBtn, addBtn;
    let presentAfterSave = false, renderedFor = 0;
    const stash = new WeakMap();          // a slide -> the fields its layout doesn't show, kept while you switch back

    const dirty = () => JSON.stringify(cleanDeck(deck)) !== savedJson;
    function load(content, version) {
      const raw = content && typeof content === "object" ? clone(content) : { slides: [] };
      deck = { size: raw.size || "16:9", theme: raw.theme || "paper", slides: Array.isArray(raw.slides) ? raw.slides : [] };
      if (!deck.slides.length) deck.slides.push({ layout: "title", title: context?.state.view?.title || "Untitled" });
      savedJson = JSON.stringify(cleanDeck(deck));
      base = version;
      sel = Math.min(sel, deck.slides.length - 1);
    }
    function touch() {
      const d = dirty();
      saveBtn.disabled = locked || !d;
      status.textContent = d ? "Unsaved changes" : `Version ${base}`;
      status.dataset.dirty = String(d);
      root.dataset.dirty = String(d);
      paintCaption();
    }
    function paintCaption() {
      caption.textContent = dirty() ? `Preview of version ${base}, as saved. Save to see your changes here.` : `Preview of version ${base}`;
    }

    // ---- the slide list
    function rowTitle(s, i) {
      return s.title || s.subtitle || s.quote?.text || (s.left?.heading ? `${s.left.heading} / ${s.right?.heading || ""}` : "") || `Slide ${i + 1}`;
    }
    function paintList() {
      list.replaceChildren(...deck.slides.map((s, i) => {
        const item = el("li", "sl-item");
        item.id = `sl-item-${i}`;
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(i === sel));
        item.tabIndex = i === sel ? 0 : -1;
        item.draggable = !locked;
        item.dataset.index = String(i);
        item.append(el("span", "sl-num", String(i + 1)));
        const words = el("span", "sl-words");
        words.append(el("span", "sl-title", rowTitle(s, i)), el("span", "sl-layout", LAYOUT_NAME[s.layout] || s.layout));
        item.append(words, icon("gripper", "sl-grip"));
        item.addEventListener("click", () => choose(i, true));
        item.addEventListener("dragstart", (e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); item.classList.add("dragging"); });
        item.addEventListener("dragend", () => { item.classList.remove("dragging"); for (const n of list.children) n.classList.remove("drop-before", "drop-after"); });
        item.addEventListener("dragover", (e) => {
          e.preventDefault();
          const after = e.offsetY > item.offsetHeight / 2;
          for (const n of list.children) n.classList.remove("drop-before", "drop-after");
          item.classList.add(after ? "drop-after" : "drop-before");
        });
        item.addEventListener("drop", (e) => {
          e.preventDefault();
          const from = Number(e.dataTransfer.getData("text/plain"));
          if (!Number.isInteger(from)) return;
          let to = i + (e.offsetY > item.offsetHeight / 2 ? 1 : 0);
          if (from < to) to -= 1;
          move(from, to);
        });
        return item;
      }));
      list.setAttribute("aria-activedescendant", `sl-item-${sel}`);
    }
    function choose(i, focus) {
      sel = Math.max(0, Math.min(deck.slides.length - 1, i));
      paintList(); paintFields();
      if (focus) list.children[sel]?.focus();
    }
    function move(from, to) {
      if (locked || from === to || to < 0 || to >= deck.slides.length) return;
      const [slide] = deck.slides.splice(from, 1);
      deck.slides.splice(to, 0, slide);
      sel = to;
      paintList(); paintFields(); touch();
      list.children[sel]?.focus();
      u.announce(`Slide moved to position ${to + 1} of ${deck.slides.length}.`);
    }
    function add() {
      if (locked || deck.slides.length >= MAX_SLIDES) return;
      deck.slides.splice(sel + 1, 0, { layout: "bullets", title: "New slide", bullets: ["First point"] });
      choose(sel + 1, false); touch();
      fields.querySelector("input,textarea")?.focus();
    }
    function duplicate() {
      if (locked || deck.slides.length >= MAX_SLIDES) return;
      const copy = clone(deck.slides[sel]);
      if (stash.has(deck.slides[sel])) stash.set(copy, clone(stash.get(deck.slides[sel])));
      deck.slides.splice(sel + 1, 0, copy);
      choose(sel + 1, true); touch();
    }
    function remove() {
      if (locked || deck.slides.length <= 1) return;
      deck.slides.splice(sel, 1);
      const was = sel + 1;
      choose(Math.min(sel, deck.slides.length - 1), true); touch();
      u.announce(`Slide ${was} deleted. Reload to get it back before you save.`);
    }

    // ---- the chosen slide's fields
    function field(label, control, hint) {
      const box = el("label", "sl-field");
      box.append(el("span", "sl-label", label), control);
      if (hint) box.append(el("span", "sl-hint", hint));
      return box;
    }
    function input(value, onInput, attrs = {}) {
      const n = el("input", "sl-input");
      n.type = "text"; n.value = value || ""; n.disabled = locked;
      Object.assign(n, attrs);
      n.addEventListener("input", () => { onInput(n.value); touch(); refreshRow(); });
      return n;
    }
    function area(value, onInput, rows = 4, attrs = {}) {
      const n = el("textarea", "sl-input sl-area");
      n.rows = rows; n.value = value || ""; n.disabled = locked;
      Object.assign(n, attrs);
      n.addEventListener("input", () => { onInput(n.value); touch(); refreshRow(); });
      return n;
    }
    function refreshRow() {
      const row = list.children[sel];
      if (row) row.querySelector(".sl-title").textContent = rowTitle(deck.slides[sel], sel);
    }
    const BULLET_HINT = "One point a line. Start a line with spaces to make it a sub-point of the one above.";
    function setLayout(slide, next) {
      const kept = stash.get(slide) || {};
      for (const key of ["bullets", "left", "right", "image", "chart", "quote", "table"]) {
        if (!(CONTENT[next] || []).includes(key) && !empty(slide[key])) { kept[key] = slide[key]; delete slide[key]; }
      }
      for (const key of CONTENT[next] || []) {
        if (empty(slide[key]) && !empty(kept[key])) { slide[key] = kept[key]; delete kept[key]; }
      }
      // What a new layout needs to be a slide at all, so a switch never leaves one the deck refuses.
      if (next === "bullets" && empty(slide.bullets)) slide.bullets = ["First point"];
      if (next === "two_columns") {
        slide.left = slide.left || { heading: "", bullets: ["First point"] };
        slide.right = slide.right || { heading: "", bullets: ["First point"] };
      }
      if (next === "quote" && empty(slide.quote)) slide.quote = { text: slide.title || "A line worth quoting", by: "" };
      if (next === "table" && empty(slide.table)) slide.table = { columns: ["Column 1", "Column 2"], rows: [["", ""]] };
      if ((next === "title" || next === "section") && !String(slide.title || "").trim()) slide.title = "Title";
      if (next === "closing" && !String(slide.title || "").trim() && !String(slide.subtitle || "").trim()) slide.title = "Questions?";
      stash.set(slide, kept);
      slide.layout = next;
    }
    function paintFields() {
      const slide = deck.slides[sel];
      fields.replaceChildren();
      if (!slide) return;
      const head = el("div", "sl-fields-head");
      head.append(el("h2", "sl-fields-title", `Slide ${sel + 1} of ${deck.slides.length}`));
      const tools = el("div", "sl-slide-tools");
      const tool = (name, label, run, disabled) => {
        const b = el("button", "art-icon"); b.type = "button"; b.title = label; b.setAttribute("aria-label", label);
        b.append(icon(name)); b.disabled = locked || disabled; b.addEventListener("click", run); return b;
      };
      tools.append(tool("arrow-up", "Move up (Alt+Up)", () => move(sel, sel - 1), sel === 0),
                   tool("arrow-down", "Move down (Alt+Down)", () => move(sel, sel + 1), sel === deck.slides.length - 1),
                   tool("copy", "Duplicate slide", duplicate, deck.slides.length >= MAX_SLIDES),
                   tool("trash", "Delete slide", remove, deck.slides.length <= 1));
      head.append(tools);
      fields.append(head);
      const layout = el("select", "sl-input sl-select");
      layout.disabled = locked;
      const kept = stash.get(slide) || {};
      for (const [value, label] of LAYOUTS) {
        const option = el("option", "", label); option.value = value;
        // A picture or a chart comes from the agent: a slide without one can't become one here.
        if ((value === "image" || value === "chart") && empty(slide[value]) && empty(kept[value])) { option.disabled = true; option.textContent = `${label} (ask the agent)`; }
        option.selected = value === slide.layout;
        layout.append(option);
      }
      layout.addEventListener("change", () => { setLayout(slide, layout.value); paintFields(); paintList(); touch(); fields.querySelector(".sl-select")?.focus(); });
      fields.append(field("Layout", layout));
      fields.append(field("Title", input(slide.title, (v) => { slide.title = v; }, { maxLength: 160 })));
      fields.append(field("Subtitle", input(slide.subtitle, (v) => { slide.subtitle = v; }, { maxLength: 240 })));
      const shows = CONTENT[slide.layout] || [];
      if (shows.includes("bullets")) {
        fields.append(field(slide.layout === "bullets" ? "Bullets" : `Points beside the ${slide.layout === "image" ? "picture" : "chart"}`,
          area(bulletsText(slide.bullets), (v) => { slide.bullets = parseBullets(v); }, 6), BULLET_HINT));
      }
      if (shows.includes("left")) {
        const cols = el("div", "sl-columns");
        for (const [side, name] of [["left", "Left column"], ["right", "Right column"]]) {
          const col = el("fieldset", "sl-column");
          col.append(el("legend", "sl-label", name));
          const c = slide[side] || (slide[side] = { heading: "", bullets: [] });
          col.append(field("Heading", input(c.heading, (v) => { c.heading = v; }, { maxLength: 80 })));
          col.append(field("Points", area(bulletsText(c.bullets), (v) => { c.bullets = parseBullets(v); }, 5)));
          cols.append(col);
        }
        fields.append(cols);
        fields.append(el("p", "sl-hint", BULLET_HINT));
      }
      if (shows.includes("quote")) {
        const q = slide.quote || (slide.quote = { text: "", by: "" });
        fields.append(field("Quote", area(q.text, (v) => { q.text = v; }, 3, { maxLength: 500 })));
        fields.append(field("Said by", input(q.by, (v) => { q.by = v; }, { maxLength: 120 })));
      }
      if (shows.includes("table")) fields.append(tableEditor(slide));
      if (shows.includes("image") && slide.image) {
        const img = slide.image;
        const box = el("div", "sl-picture");
        if (/^data:image\//.test(String(img.src || ""))) { const pic = el("img"); pic.src = img.src; pic.alt = img.alt || ""; box.append(pic); }
        box.append(el("span", "sl-hint", "The picture itself comes from the agent: ask it for another one."));
        fields.append(box);
        fields.append(field("What it shows (for screen readers)", input(img.alt, (v) => { img.alt = v; }, { maxLength: 300 })));
        fields.append(field("Caption", input(img.caption, (v) => { img.caption = v; }, { maxLength: 200 })));
      }
      if (shows.includes("chart") && slide.chart) {
        const c = slide.chart;
        const series = Array.isArray(c.series) ? c.series : [];
        const points = Array.isArray(c.x) ? c.x.length : (series[0]?.values?.length || 0);
        const kind = String(c.type || "bar");
        fields.append(el("p", "sl-chart", `${kind[0].toUpperCase()}${kind.slice(1)} chart · ${points} point${points === 1 ? "" : "s"} · ${series.length} series${series.length ? ` (${series.map((s) => s.name).filter(Boolean).join(", ")})` : ""}. Ask the agent to change its numbers.`));
      }
      fields.append(field("Speaker notes", area(slide.notes, (v) => { slide.notes = v; }, 5, { maxLength: 6000 }), "Shown under the slide when you present, and on PowerPoint's notes pages."));
    }
    function tableEditor(slide) {
      const t = slide.table || (slide.table = { columns: ["Column 1"], rows: [[""]] });
      const box = el("div", "sl-table-box");
      box.append(el("span", "sl-label", "Table"));
      const table = el("table", "sl-table");
      const head = el("tr");
      t.columns.forEach((name, c) => {
        const th = el("th");
        const n = input(String(name ?? ""), (v) => { t.columns[c] = v; }, { maxLength: 60 });
        n.setAttribute("aria-label", `Column ${c + 1} heading`);
        th.append(n);
        if (t.columns.length > 1) {
          const x = el("button", "art-icon sl-x"); x.type = "button"; x.title = `Remove column ${c + 1}`; x.setAttribute("aria-label", `Remove column ${c + 1}`);
          x.append(icon("close")); x.disabled = locked;
          x.addEventListener("click", () => { t.columns.splice(c, 1); for (const r of t.rows) r.splice(c, 1); paintFields(); touch(); });
          th.append(x);
        }
        head.append(th);
      });
      head.append(el("th", "sl-pad"));
      const thead = el("thead"); thead.append(head);
      const body = el("tbody");
      t.rows.forEach((row, r) => {
        const tr = el("tr");
        t.columns.forEach((_, c) => {
          const td = el("td");
          const n = input(row[c] === undefined || row[c] === null ? "" : String(row[c]), (v) => { row[c] = v; }, { maxLength: 120 });
          n.setAttribute("aria-label", `Row ${r + 1}, ${t.columns[c] || `column ${c + 1}`}`);
          td.append(n); tr.append(td);
        });
        const x = el("button", "art-icon sl-x"); x.type = "button"; x.title = `Remove row ${r + 1}`; x.setAttribute("aria-label", `Remove row ${r + 1}`);
        x.append(icon("close")); x.disabled = locked || t.rows.length <= 1;
        x.addEventListener("click", () => { t.rows.splice(r, 1); paintFields(); touch(); });
        const td = el("td", "sl-pad"); td.append(x); tr.append(td);
        body.append(tr);
      });
      table.append(thead, body);
      const scroll = el("div", "sl-table-scroll"); scroll.append(table);
      const actions = el("div", "sl-table-actions");
      const addRow = el("button", "art-btn art-btn-quiet"); addRow.type = "button"; addRow.append(icon("add"), el("span", "", "Row"));
      addRow.disabled = locked || t.rows.length >= MAX_TABLE_ROWS;
      addRow.title = t.rows.length >= MAX_TABLE_ROWS ? `A slide's table holds ${MAX_TABLE_ROWS} rows` : "Add a row";
      addRow.addEventListener("click", () => { t.rows.push(t.columns.map(() => "")); paintFields(); touch(); });
      const addCol = el("button", "art-btn art-btn-quiet"); addCol.type = "button"; addCol.append(icon("add"), el("span", "", "Column"));
      addCol.disabled = locked || t.columns.length >= MAX_TABLE_COLUMNS;
      addCol.title = t.columns.length >= MAX_TABLE_COLUMNS ? `A slide's table holds ${MAX_TABLE_COLUMNS} columns` : "Add a column";
      addCol.addEventListener("click", () => { t.columns.push(`Column ${t.columns.length + 1}`); for (const r of t.rows) r.push(""); paintFields(); touch(); });
      actions.append(addRow, addCol);
      box.append(scroll, actions);
      return box;
    }

    function save() {
      if (locked || !dirty()) return;
      saveBtn.disabled = true; status.textContent = "Saving…";
      u.post({ type: "save", content: cleanDeck(deck), base_version: base, note: "Your edits" });
    }
    function present() {
      if (dirty()) {
        u.banner("info", "Present shows the deck as saved. Save your changes first?",
          [["Save and present", () => { u.hideBanner(); presentAfterSave = true; save(); }, true],
           ["Present as saved", () => { u.hideBanner(); u.post({ type: "present" }); }]]);
        return;
      }
      u.post({ type: "present" });
    }

    return {
      mount(main, ctx) {
        context = ctx;
        load(ctx.state.content, ctx.state.view.version);
        root = el("div", "sl");
        const bar = el("div", "art-toolbar sl-bar");
        themePick = el("select", "sl-input sl-select sl-theme");
        themePick.setAttribute("aria-label", "Theme");
        themePick.title = "The deck's theme: its colours and type";
        const custom = deck.theme && typeof deck.theme === "object";
        for (const [value, label] of [...THEMES, ...(custom ? [["custom", "Its own colours"]] : [])]) {
          const o = el("option", "", label); o.value = value; o.selected = custom ? value === "custom" : value === deck.theme; themePick.append(o);
        }
        let customTheme = custom ? deck.theme : null;
        themePick.addEventListener("change", () => { deck.theme = themePick.value === "custom" ? customTheme : themePick.value; touch(); });
        sizePick = el("select", "sl-input sl-select sl-size");
        sizePick.setAttribute("aria-label", "Slide shape");
        for (const [value, label] of [["16:9", "Wide 16:9"], ["4:3", "Standard 4:3"]]) {
          const o = el("option", "", label); o.value = value; o.selected = value === deck.size; sizePick.append(o);
        }
        sizePick.addEventListener("change", () => { deck.size = sizePick.value; touch(); });
        presentBtn = el("button", "art-btn"); presentBtn.type = "button";
        presentBtn.append(icon("play"), el("span", "art-btn-label", "Present"));
        presentBtn.title = "Present the deck a slide at a time (F for full screen, Esc to leave)";
        presentBtn.addEventListener("click", present);
        status = el("span", "art-toolbar-note sl-status");
        saveBtn = el("button", "art-btn art-btn-primary"); saveBtn.type = "button";
        saveBtn.append(icon("save"), el("span", "art-btn-label", "Save"));
        saveBtn.title = "Save as your own version (Ctrl+S)";
        saveBtn.addEventListener("click", save);
        const themeBox = el("label", "sl-inline"); themeBox.append(el("span", "sl-inline-label", "Theme"), themePick);
        bar.append(themeBox, sizePick, el("span", "art-spacer"), status, presentBtn, saveBtn);

        const side = el("nav", "sl-side"); side.setAttribute("aria-label", "Slides");
        list = el("ol", "sl-list"); list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Slides: arrow keys to choose, Alt+arrow keys to move");
        list.addEventListener("keydown", (e) => {
          if (e.target.closest(".sl-item") === null) return;
          if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); move(sel, sel + (e.key === "ArrowUp" ? -1 : 1)); return; }
          if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); choose(sel + (e.key === "ArrowUp" ? -1 : 1), true); }
          else if (e.key === "Home") { e.preventDefault(); choose(0, true); }
          else if (e.key === "End") { e.preventDefault(); choose(deck.slides.length - 1, true); }
          else if (e.key === "Enter") { e.preventDefault(); fields.querySelector("select,input,textarea")?.focus(); }
        });
        addBtn = el("button", "art-btn art-btn-quiet sl-add"); addBtn.type = "button";
        addBtn.append(icon("add"), el("span", "", "Add slide"));
        addBtn.addEventListener("click", add);
        side.append(list, addBtn);
        fields = el("section", "sl-fields"); fields.setAttribute("aria-label", "The chosen slide");
        const preview = el("section", "sl-preview"); preview.setAttribute("aria-label", "Preview");
        caption = el("p", "sl-caption");
        frame = u.viewFrame(`${ctx.state.view.title}: preview`);
        frame.classList.add("sl-frame");
        preview.append(caption, frame);
        root.append(side, fields, preview);
        main.append(bar, root);
        paintList(); paintFields(); touch();
      },
      update() {
        load(context.state.content, context.state.view.version);
        themePick.value = deck.theme && typeof deck.theme === "object" ? "custom" : deck.theme;
        sizePick.value = deck.size;
        paintList(); paintFields(); touch();
      },
      dirty,
      save,
      saved(view) {
        base = view.version;
        savedJson = JSON.stringify(cleanDeck(deck));
        touch();
        if (presentAfterSave) { presentAfterSave = false; u.post({ type: "present" }); }
      },
      render(msg) {
        if (msg.error) { caption.textContent = msg.error; return; }
        renderedFor = msg.version;
        u.frameHtml(frame, msg.html);
        paintCaption();
      },
      rejected(msg) {
        presentAfterSave = false;
        touch();
        const at = /Slide (\d+)/.exec(String(msg.message || ""));
        if (msg.what === "save" && at && Number(at[1]) <= deck.slides.length) choose(Number(at[1]) - 1, false);
      },
      lock(on) {
        locked = !!on;
        themePick.disabled = locked;
        sizePick.disabled = locked;
        presentBtn.disabled = locked;
        addBtn.disabled = locked || deck.slides.length >= MAX_SLIDES;
        paintList(); paintFields(); touch();
      },
      get renderedFor() { return renderedFor; },
    };
  };
  A.slides = { bulletsText, parseBullets, cleanDeck };
})();

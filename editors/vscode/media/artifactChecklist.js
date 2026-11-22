// A checklist, in the artifact panel (media/artifact.js): how far along it is, then each item with its tick box, its
// status as a chip, what done means, its note and its proof (lines of text, and pictures). You tick or reopen an item,
// choose its status, change what done means or its note, add or remove an item, and pin or unpin it from the project.
// Each of those is saved at once as one version by you, so the history shows it and DGC sees it at its next look. When
// DGC changed the list meanwhile, your one change is made again on the newer list, never the older list put back.
// Everything a model or a person wrote goes in as text, never as markup.
(() => {
  "use strict";
  const A = (window.DgcArtifact = window.DgcArtifact || { editors: {} });
  const STATUSES = ["Not started", "Building", "Testing", "Checked live", "Needs you", "Done"];
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const PICTURE = /^proof\/[a-f0-9]{16,64}\.(?:png|jpg|gif|webp)$/;

  /** How far along a list is: {done, total, share}. */
  function progress(data) {
    const items = Array.isArray(data?.items) ? data.items : [];
    const done = items.filter((i) => i.status === "Done").length;
    return { done, total: items.length, share: items.length ? Math.round((100 * done) / items.length) : 0 };
  }

  A.editors.checklist = () => {
    let ctx, root, sumWords, sumBar, pinBtn, list, addForm, locked = false;
    let data = { items: [] }, base = 0;
    let saving = null;          // the change being saved: {apply, said}
    let retried = false;        // it was already made again once on a newer list
    const waiting = [];         // changes made while one is being saved
    let editing = null;         // an open box: {item, field}
    const U = () => ctx.util;

    function read() {
      const content = ctx.state.content;
      data = content && typeof content === "object" && Array.isArray(content.items) ? clone(content) : { items: [] };
      base = ctx.state.view.version;
    }
    const find = (d, id) => (Array.isArray(d.items) ? d.items.find((i) => i.id === id) : undefined);

    /** One change by you: made on the list as it is now, shown at once, saved as its own version. */
    function change(apply, said) {
      if (locked) return;
      if (saving) { waiting.push({ apply, said }); const next = clone(data); if (apply(next) !== false) { data = next; paint(); } return; }
      const next = clone(data);
      if (apply(next) === false) return;
      data = next; saving = { apply, said }; retried = false;
      paint();
      U().post({ type: "save", content: data, base_version: base });
    }
    function settle() {
      saving = null;
      const queued = waiting.shift();
      if (queued) {
        // (Shown already; saved now, from the version just made.)
        saving = queued; retried = false;
        U().post({ type: "save", content: data, base_version: base });
      }
    }

    // ---- drawing
    function chip(item) {
      const wrap = U().el("span", "art-menu-wrap ck-chip-wrap");
      const b = U().el("button", "ck-chip"); b.type = "button";
      b.dataset.status = item.status;
      b.append(U().el("span", "", item.status), U().icon("chevron-down", "art-caret"));
      b.setAttribute("aria-haspopup", "menu"); b.setAttribute("aria-expanded", "false");
      b.setAttribute("aria-label", `${item.title}: ${item.status}. Change its status`);
      b.disabled = locked;
      const menu = U().el("div", "art-menu dgc-popover"); menu.setAttribute("role", "menu"); menu.hidden = true;
      menu.setAttribute("aria-label", `Status of ${item.title}`);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        U().showMenu(b, menu, STATUSES.map((s) => [s === item.status ? `${s} (now)` : s, () => {
          if (s !== item.status) setStatus(item.id, s);
        }]));
      });
      wrap.append(b, menu);
      return wrap;
    }
    function setStatus(id, status) {
      const title = find(data, id)?.title || "the item";
      change((d) => { const it = find(d, id); if (!it || it.status === status) return false; it.status = status; }, `${title}: ${status}`);
    }
    /** A line you can change in place (what done means, the note): its words, and a pencil that opens a box. */
    function line(item, field, label, empty) {
      const row = U().el("div", `ck-line ck-${field}`);
      row.append(U().el("span", "ck-label", label));
      if (editing && editing.item === item.id && editing.field === field) {
        const box = U().el("textarea", "ck-box"); box.value = item[field] || ""; box.rows = 2;
        box.maxLength = field === "note" ? 4000 : 1000;
        box.setAttribute("aria-label", `${label} for ${item.title}`);
        const save = U().el("button", "art-btn art-btn-primary", "Save"); save.type = "button";
        const cancel = U().el("button", "art-btn", "Cancel"); cancel.type = "button";
        const done = (keep) => {
          const text = box.value.trim();
          editing = null;
          if (keep && text !== (item[field] || "")) {
            change((d) => { const it = find(d, item.id); if (!it) return false; it[field] = text; }, `${label} changed`);
          } else paint();
        };
        save.addEventListener("click", () => done(true));
        cancel.addEventListener("click", () => done(false));
        box.addEventListener("keydown", (e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(false); }
          else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(true); }
        });
        const acts = U().el("span", "ck-box-acts"); acts.append(save, cancel);
        const wrap = U().el("div", "ck-box-wrap"); wrap.append(box, acts);
        row.append(wrap);
        setTimeout(() => { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }, 0);
        return row;
      }
      row.append(U().el("span", `ck-words${item[field] ? "" : " ck-empty"}`, item[field] || empty));
      const edit = U().el("button", "art-icon ck-edit"); edit.type = "button";
      edit.append(U().icon("edit"));
      edit.title = `Change ${label.toLowerCase()}`; edit.setAttribute("aria-label", `Change ${label.toLowerCase()} for ${item.title}`);
      edit.disabled = locked;
      edit.addEventListener("click", () => { editing = { item: item.id, field }; paint(); });
      row.append(edit);
      return row;
    }
    function proof(item) {
      const pictures = ctx.state.dstate?.pictures && typeof ctx.state.dstate.pictures === "object" ? ctx.state.dstate.pictures : {};
      const given = Array.isArray(item.proof) ? item.proof : [];
      if (!given.length) return null;
      const box = U().el("div", "ck-proof"); box.setAttribute("aria-label", `Proof for ${item.title}`);
      box.append(U().el("span", "ck-label", "Proof"));
      const body = U().el("div", "ck-proof-body");
      for (const p of given) if (p && p.kind !== "image" && typeof p.text === "string") body.append(U().el("pre", "ck-proof-text", p.text));
      const shots = given.filter((p) => p && p.kind === "image" && PICTURE.test(String(p.file || "")) && /^data:image\/(?:png|jpeg|gif|webp);base64,/.test(String(pictures[p.file] || "")));
      if (shots.length) {
        const row = U().el("div", "ck-pics");
        for (const p of shots) {
          const b = U().el("button", "ck-pic"); b.type = "button";
          const img = document.createElement("img"); img.src = pictures[p.file]; img.alt = p.caption || `Proof for ${item.title}`; img.loading = "lazy";
          b.append(img);
          if (p.caption) b.append(U().el("span", "ck-pic-cap", p.caption));
          b.setAttribute("aria-label", `Open the picture: ${p.caption || `proof for ${item.title}`}`);
          b.addEventListener("click", () => openPicture(pictures[p.file], p.caption || `Proof for ${item.title}`, b));
          row.append(b);
        }
        body.append(row);
      }
      if (!body.childNodes.length) return null;
      box.append(body);
      return box;
    }
    function openPicture(src, caption, from) {
      document.getElementById("ck-picture")?.remove();
      const dialog = U().el("dialog", "ck-picture dgc-dialog"); dialog.id = "ck-picture";
      dialog.setAttribute("aria-label", caption);
      const img = document.createElement("img"); img.src = src; img.alt = caption;
      const close = U().el("button", "art-btn", "Close"); close.type = "button";
      close.addEventListener("click", () => dialog.close());
      dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
      dialog.addEventListener("close", () => { dialog.remove(); from?.focus?.(); });
      dialog.append(img, U().el("p", "ck-picture-cap", caption), close);
      document.body.append(dialog); dialog.showModal(); close.focus();
    }
    function row(item) {
      const li = U().el("li", "ck-item"); li.dataset.item = item.id; li.dataset.status = item.status;
      const top = U().el("div", "ck-top");
      const done = item.status === "Done";
      const box = U().el("button", "ck-tick"); box.type = "button";
      box.setAttribute("role", "checkbox"); box.setAttribute("aria-checked", String(done));
      box.setAttribute("aria-label", done ? `Reopen ${item.title}` : `Tick ${item.title} as done`);
      box.title = done ? "Reopen it (back to Not started)" : "Tick it as done";
      box.disabled = locked;
      if (done) box.append(U().icon("check"));
      box.addEventListener("click", () => setStatus(item.id, done ? "Not started" : "Done"));
      const title = U().el("span", "ck-title", item.title);
      const remove = U().el("button", "art-icon ck-remove"); remove.type = "button";
      remove.append(U().icon("trash"));
      remove.title = "Remove this item"; remove.setAttribute("aria-label", `Remove ${item.title}`);
      remove.disabled = locked || data.items.length < 2;
      remove.addEventListener("click", () => {
        U().banner("warn", `Remove “${item.title}” from the checklist? Earlier versions keep it.`, [
          ["Remove", () => { U().hideBanner(); change((d) => { const at = d.items.findIndex((i) => i.id === item.id); if (at < 0 || d.items.length < 2) return false; d.items.splice(at, 1); }, `Removed ${item.title}`); }, true],
          ["Cancel", () => U().hideBanner()]]);
      });
      top.append(box, title, chip(item), remove);
      li.append(top, line(item, "done_when", "Done when", "Not said yet"));
      if (item.note || (editing && editing.item === item.id && editing.field === "note") || item.status !== "Not started") li.append(line(item, "note", "Note", "No note"));
      const shown = proof(item);
      if (shown) li.append(shown);
      if (item.by && item.status !== "Not started") {
        const who = String(item.by).toLowerCase() === "you" ? "you" : String(item.by);
        li.append(U().el("div", "ck-who", `${item.status} by ${who}${item.at ? ` · ${U().when(item.at)}` : ""}`));
      }
      return li;
    }
    function paint() {
      if (!root) return;
      const p = progress(data);
      sumWords.textContent = `${p.done} of ${p.total} done`;
      sumBar.firstChild.style.width = `${p.share}%`;
      sumBar.setAttribute("aria-label", `${p.share}% done`);
      const pinned = data.pinned === true;
      pinBtn.replaceChildren(U().icon(pinned ? "pinned" : "pin"), U().el("span", "art-btn-label", pinned ? "Pinned" : "Pin"));
      pinBtn.setAttribute("aria-pressed", String(pinned));
      pinBtn.title = pinned ? "Pinned to its project: every new chat there reads it and carries on. Click to unpin."
        : "Pin it to its project, so every new chat there reads it and carries on";
      pinBtn.disabled = locked;
      const focused = document.activeElement?.closest?.(".ck-item")?.dataset.item, cls = document.activeElement?.className || "";
      list.replaceChildren(...data.items.map(row));
      if (focused && !editing) {
        const again = [...list.children].find((li) => li.dataset.item === focused);
        (again?.querySelector(`.${String(cls).split(" ").filter(Boolean).pop() || "ck-tick"}`) || again?.querySelector(".ck-tick"))?.focus?.();
      }
      for (const n of addForm.querySelectorAll("input,button")) n.disabled = locked;
    }

    return {
      mount(main, context) {
        ctx = context;
        read();
        root = ctx.util.el("div", "ck");
        const bar = ctx.util.el("div", "art-toolbar ck-bar");
        sumWords = ctx.util.el("span", "ck-sum");
        sumBar = ctx.util.el("span", "ck-progress"); sumBar.setAttribute("role", "img"); sumBar.append(ctx.util.el("i"));
        pinBtn = ctx.util.el("button", "art-btn ck-pin"); pinBtn.type = "button";
        pinBtn.addEventListener("click", () => {
          const to = data.pinned !== true;
          change((d) => { d.pinned = to; }, to ? "Pinned to the project" : "Unpinned from the project");
        });
        bar.append(sumWords, sumBar, pinBtn);
        const about = typeof data.about === "string" && data.about ? ctx.util.el("p", "ck-about", data.about) : null;
        list = ctx.util.el("ol", "ck-list"); list.setAttribute("aria-label", "Items");
        addForm = ctx.util.el("form", "ck-add");
        const title = ctx.util.el("input", "ck-add-title"); title.type = "text"; title.maxLength = 200;
        title.placeholder = "Add an item"; title.setAttribute("aria-label", "A new item's title");
        const when = ctx.util.el("input", "ck-add-when"); when.type = "text"; when.maxLength = 1000;
        when.placeholder = "Done when…"; when.setAttribute("aria-label", "What done means for the new item");
        const add = ctx.util.el("button", "art-btn"); add.type = "submit";
        add.append(ctx.util.icon("add"), ctx.util.el("span", "art-btn-label", "Add"));
        addForm.append(title, when, add);
        addForm.addEventListener("submit", (e) => {
          e.preventDefault();
          const name = title.value.trim(), means = when.value.trim();
          if (!name) { title.focus(); return; }
          change((d) => {
            const last = Math.max(Number(d.last) || 0, ...d.items.map((i) => Number(String(i.id).slice(1)) || 0)) + 1;
            d.last = last;
            d.items.push({ id: `c${last}`, title: name, done_when: means, status: "Not started", note: "", proof: [] });
          }, `Added ${name}`);
          title.value = ""; when.value = ""; title.focus();
        });
        root.append(bar, ...(about ? [about] : []), list, addForm);
        main.append(root);
        paint();
      },
      /** The list as the process has it now (after a save of yours, or a change by DGC or another window). */
      update() {
        if (saving && retried === "again") {
          // Your one change, made again on the newer list.
          const again = saving;
          read();
          const next = clone(data);
          if (again.apply(next) === false) { saving = null; waiting.length = 0; paint(); return; }
          data = next; retried = true;
          paint();
          U().post({ type: "save", content: data, base_version: base });
          return;
        }
        if (saving) return;                 // its own answer brings the list
        read();
        if (!editing) paint();              // a box you are typing in stays; its change is made on this newer list
      },
      dirty: () => false,
      saved(view) {
        base = view.version;
        ctx.state.content = clone(data);
        const said = saving?.said;
        settle();
        if (!saving) { U().post({ type: "reload" }); if (said) U().announce(`${said}. Saved as version ${view.version}.`); }
      },
      /** A save that found a newer list: read it and make the change again there, once, with no question asked. */
      retries(msg) {
        if (!saving || msg.what !== "save" || msg.reason !== "conflict" || retried) return false;
        retried = "again"; waiting.length = 0;
        U().post({ type: "reload" });
        return true;
      },
      rejected(msg) {
        if (msg.what !== "save") return;
        saving = null; waiting.length = 0; retried = false;
        U().post({ type: "reload" });       // back to what is kept
      },
      render() {},                          // drawn here from the data; DGC's page of it is for the browser
      lock(on) { locked = !!on; editing = null; paint(); },
    };
  };
  A.checklist = { progress, STATUSES };
})();

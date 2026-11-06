/* The messages waiting above a prompt box, the same row in Work, ChatDGC and a Pip's chat. It draws the rows and
   reports what the person did; each surface owns its queue and decides what a move or a removal means. Words are text
   nodes only. */
(() => {
  "use strict";
  const line = (body) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  const dots = (cells) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false">${cells.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1"/>`).join("")}</svg>`;
  const ICONS = {
    queue: line('<path d="M2.5 4h11"/><path d="M2.5 8h6"/><path d="M2.5 12h4"/><path d="M12 7v6"/><path d="m10 11 2 2 2-2"/>'),
    grip: dots([[5, 4], [11, 4], [5, 8], [11, 8], [5, 12], [11, 12]]),
    steer: line('<path d="M9.5 3.5 14 8l-4.5 4.5"/><path d="M14 8H6a3.5 3.5 0 0 0-3.5 3.5v1"/>'),
    edit: line('<path d="M10.5 3.2 12.8 5.5 5.6 12.7l-3 .7.7-3z"/>'),
    remove: line('<path d="M2.8 4.3h10.4"/><path d="M6 4.3V3a.8.8 0 0 1 .8-.8h2.4A.8.8 0 0 1 10 3v1.3"/><path d="m4.2 4.3.6 8.3a1.2 1.2 0 0 0 1.2 1.2h4a1.2 1.2 0 0 0 1.2-1.2l.6-8.3"/>'),
    more: dots([[3.5, 8], [8, 8], [12.5, 8]]),
  };
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  // The artwork above is fixed here and holds nothing a person typed.
  const iconButton = (className, label, icon, title = label) => {
    const button = make("button", className);
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = title;
    button.innerHTML = ICONS[icon];
    return button;
  };
  const orderOf = (list) => [...list.children].map((row) => row.dataset.queueId).filter(Boolean);
  function closeMenus(root) {
    root.querySelectorAll?.(".dgc-queue-menu").forEach((menu) => menu.remove());
    root.querySelectorAll?.(".dgc-queue-more[aria-expanded='true']").forEach((button) => button.setAttribute("aria-expanded", "false"));
  }
  function moreMenu(button, row, item, index, on) {
    const root = row.getRootNode();
    const open = button.getAttribute("aria-expanded") === "true";
    closeMenus(root);
    if (open) return;
    const menu = make("div", "dgc-queue-menu");
    menu.setAttribute("role", "menu");
    const entry = (label, act, disabled = false) => {
      const choice = make("button", "dgc-queue-choice", label);
      choice.type = "button"; choice.setAttribute("role", "menuitem"); choice.disabled = disabled;
      choice.addEventListener("click", () => { closeMenus(root); button.focus(); act(); });
      menu.appendChild(choice);
    };
    entry("Copy message", () => on.copy?.(item.id, item.text));
    if (on.reorder) entry("Move to top", () => {
      const order = orderOf(row.parentElement).filter((id) => id !== item.id);
      on.reorder([item.id, ...order]);
    }, index === 0);
    // Fixed, so the queue's own scrolling does not clip it. It opens upward: the box is at the bottom of the window.
    const at = button.getBoundingClientRect();
    menu.style.right = `${Math.max(4, document.documentElement.clientWidth - at.right)}px`;
    menu.style.bottom = `${Math.max(4, document.documentElement.clientHeight - at.top + 4)}px`;
    row.appendChild(menu);
    button.setAttribute("aria-expanded", "true");
    menu.querySelector("button:not(:disabled)")?.focus();
    const away = (event) => {
      if (event.type === "keydown" && event.key !== "Escape") return;
      if (event.type === "pointerdown" && event.composedPath().includes(menu)) return;
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", away, true);
      if (!menu.isConnected) return;
      closeMenus(root);
      if (event.type === "keydown") { event.preventDefault(); event.stopPropagation(); button.focus(); }
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", away, true);
  }
  function handleFor(list, row, item, index, count, on) {
    const handle = iconButton("dgc-queue-handle", `Reorder message: ${item.text}`, "queue", "Drag to reorder, or use the Up and Down arrow keys");
    handle.insertAdjacentHTML("beforeend", ICONS.grip);
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      const target = index + (event.key === "ArrowUp" ? -1 : 1);
      if (target < 0 || target >= count) return;
      const order = orderOf(list);
      [order[index], order[target]] = [order[target], order[index]];
      on.reorder(order);
    });
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const before = orderOf(list).join("\n");
      row.classList.add("dragging"); list.dataset.dragging = "1";
      try { handle.setPointerCapture(event.pointerId); } catch {}
      const move = (moved) => {
        const next = [...list.children].filter((other) => other !== row).find((other) => {
          const box = other.getBoundingClientRect();
          return moved.clientY < box.top + box.height / 2;
        });
        if (next) { if (next !== row.nextElementSibling) list.insertBefore(row, next); }
        else if (list.lastElementChild !== row) list.appendChild(row);
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", end);
        handle.removeEventListener("pointercancel", end);
        row.classList.remove("dragging"); delete list.dataset.dragging;
        const order = orderOf(list);
        if (order.join("\n") !== before) on.reorder(order);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end);
      handle.addEventListener("pointercancel", end);
    });
    return handle;
  }
  /** items: {id, text, files, steering, title, fixed}. A fixed row is one the surface can't change: it shows and copies.
      on: reorder(ids), steer(id), edit(id), remove(id), copy(id, text). */
  function render(list, items, on = {}) {
    if (list.dataset.dragging) return;        // the row under the pointer stays put; the next change redraws it
    const root = list.getRootNode();
    const had = root.activeElement && list.contains(root.activeElement) ? root.activeElement : null;
    const refocus = had ? { id: had.closest("[data-queue-id]")?.dataset.queueId, role: had.dataset.queueRole } : null;
    list.replaceChildren(...items.map((item, index) => {
      const row = make("li", `dgc-queue-row${on.rowClass ? ` ${on.rowClass}` : ""}`);
      row.dataset.queueId = item.id;
      if (on.reorder && items.length > 1 && !item.fixed) {
        const handle = handleFor(list, row, item, index, items.length, on);
        handle.dataset.queueRole = "handle";
        row.appendChild(handle);
      } else {
        const mark = make("span", "dgc-queue-mark");
        mark.innerHTML = ICONS.queue;
        row.appendChild(mark);
      }
      const words = make("p", `dgc-queue-text${on.textClass ? ` ${on.textClass}` : ""}`, item.text || item.empty || "Attached context");
      words.title = item.title ?? item.text ?? "";
      row.appendChild(words);
      if (item.files) {
        const files = make("span", "dgc-queue-files", `${item.files} ${item.files === 1 ? "file" : "files"}`);
        if (item.fileNames) files.title = item.fileNames;
        row.appendChild(files);
      }
      if (on.steer && !item.fixed) {
        const steer = make("button", "dgc-queue-steer");
        steer.type = "button"; steer.disabled = !!item.steering; steer.dataset.queueRole = "steer";
        steer.title = "Send this message to the running turn now";
        steer.innerHTML = ICONS.steer;
        steer.appendChild(document.createTextNode(item.steering ? "Steering…" : "Steer"));
        steer.addEventListener("click", () => on.steer(item.id));
        row.appendChild(steer);
      }
      if (on.edit && !item.fixed) {
        const edit = iconButton(`dgc-queue-icon${on.editClass ? ` ${on.editClass}` : ""}`, `Edit queued message: ${item.text}`, "edit", "Edit: back to the box");
        edit.dataset.queueRole = "edit";
        edit.addEventListener("click", () => on.edit(item.id));
        row.appendChild(edit);
      }
      if (on.remove && !item.fixed) {
        const remove = iconButton(`dgc-queue-icon${on.removeClass ? ` ${on.removeClass}` : ""}`, `Remove queued message: ${item.text}`, "remove", "Remove");
        remove.dataset.queueRole = "remove";
        remove.addEventListener("click", () => on.remove(item.id));
        row.appendChild(remove);
      }
      const more = iconButton("dgc-queue-icon dgc-queue-more", `More actions for: ${item.text}`, "more", "More");
      more.dataset.queueRole = "more";
      more.setAttribute("aria-haspopup", "menu"); more.setAttribute("aria-expanded", "false");
      more.addEventListener("click", () => moreMenu(more, row, item, index, on));
      row.appendChild(more);
      return row;
    }));
    if (refocus?.id && refocus.role) {
      const again = [...list.children].find((row) => row.dataset.queueId === refocus.id)
        ?.querySelector(`[data-queue-role="${refocus.role}"]`);
      again?.focus();
    }
  }
  window.DgcMessageQueue = { render };
})();

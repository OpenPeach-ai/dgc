(() => {
  "use strict";
  const vscode = acquireVsCodeApi();
  const list = document.getElementById("apps-list");
  const status = document.getElementById("apps-status");
  const apps = new Map();
  const node = (tag, className, value) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = String(value);
    return element;
  };
  const button = (label, kind, id, primary = false) => {
    const element = node("button", primary ? "primary" : "secondary", label);
    element.type = "button";
    element.addEventListener("click", () => vscode.postMessage({ type: kind, id }));
    return element;
  };

  function draw() {
    list.replaceChildren();
    const rows = [...apps.values()];
    status.textContent = rows.length ? `${rows.length} ${rows.length === 1 ? "app" : "apps"} in this DGC profile` :
      "No apps saved yet. Add an existing project to keep it close to your Work sessions.";
    for (const app of rows) {
      const card = node("article", "app-card");
      const top = node("div", "app-top");
      const glyph = node("div", "app-glyph", "▦");
      glyph.setAttribute("aria-hidden", "true");
      top.appendChild(glyph);
      const head = node("div", "app-name");
      head.appendChild(node("h2", "", app.name));
      head.appendChild(node("p", "", app.projectRoot));
      top.appendChild(head);
      const health = app.health;
      const pill = node("span", `app-state ${health?.state || "checking"}`,
        health ? ({ ready: "Ready", reachable: "Reachable", attention: "Needs attention", offline: "Offline" }[health.state] || "Unknown") : "Checking");
      top.appendChild(pill);
      card.appendChild(top);
      const summary = node("div", "app-summary");
      const healthBox = node("section", "app-info");
      healthBox.appendChild(node("h3", "", "Health"));
      healthBox.appendChild(node("strong", "", health?.detail || "Checking the app…"));
      if (health?.ms !== undefined) healthBox.appendChild(node("small", "", `${health.ms} ms`));
      if (health?.checks?.length) {
        const checks = node("ul", "app-checks");
        for (const check of health.checks) checks.appendChild(node("li", check.ok ? "ok" : "bad", `${check.ok ? "●" : "!"} ${check.name}`));
        healthBox.appendChild(checks);
      }
      summary.appendChild(healthBox);
      const pipsBox = node("section", "app-info");
      pipsBox.appendChild(node("h3", "", "Pips in this project"));
      if (app.pips === null) pipsBox.appendChild(node("strong", "", "Checking Pips…"));
      else if (!app.pips?.length) pipsBox.appendChild(node("strong", "", "No Pips found"));
      else {
        pipsBox.appendChild(node("strong", "", `${app.pips.length} ${app.pips.length === 1 ? "Pip" : "Pips"}`));
        const pips = node("ul", "app-pips");
        for (const pip of app.pips) {
          const row = node("li", "");
          row.appendChild(node("span", "pip-light"));
          const info = node("span", "");
          info.appendChild(node("b", "", pip.name));
          info.appendChild(node("small", "", `${pip.type} · ${pip.status}${pip.pending ? ` · ${pip.pending} awaiting review` : ""}`));
          row.appendChild(info);
          pips.appendChild(row);
        }
        pipsBox.appendChild(pips);
      }
      summary.appendChild(pipsBox);
      card.appendChild(summary);
      const foot = node("div", "app-foot");
      foot.appendChild(node("span", "app-url", app.url));
      const actions = node("div", "app-buttons");
      actions.appendChild(button("Open app", "open", app.id, true));
      actions.appendChild(button("Pips", "pips", app.id));
      actions.appendChild(button("Remove", "remove", app.id));
      foot.appendChild(actions);
      card.appendChild(foot);
      list.appendChild(card);
    }
  }

  window.addEventListener("message", event => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "apps" && Array.isArray(message.apps)) {
      apps.clear();
      for (const app of message.apps) if (app && typeof app.id === "string") apps.set(app.id, app);
      draw();
    } else if (message.type === "appStatus" && apps.has(message.id)) {
      const app = apps.get(message.id);
      apps.set(message.id, { ...app, health: message.health, pips: message.pips });
      draw();
    } else if (message.type === "error") {
      status.textContent = String(message.text || "Could not load Apps.");
    }
  });
  document.getElementById("apps-refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  document.getElementById("apps-add").addEventListener("click", () => vscode.postMessage({ type: "add" }));
  vscode.postMessage({ type: "ready" });
})();

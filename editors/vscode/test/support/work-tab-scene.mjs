// A Work session tab's page (media/main.js as panel.ts serves it, data-chat-place="tab") in Chromium, opened in a folder
// as Continue in Work opens one: for work-brief-composer.test.mjs and render-folder-and-reports.mjs. Not a *.test.mjs file.
import { panelHtml, THEMES } from "./options-scene.mjs";

export const BRIEF = "Continuing from the chat “Uploads”, about this folder. What we worked out there:\n\n"
  + "The upload limit (20 a minute) is set in src/upload.py, line 2. Move it into settings so each plan can have its own, "
  + "and keep 20 as the default.\n\nCarry on from here.";

/** A session tab's page (data-chat-place="tab"), opened in `cwd`, as panel.ts serves one. */
export async function openWorkTab(browserIn, { width = 900, height = 760, theme = "dark-modern", cwd = "/home/me/projects/uploads-service" } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browserIn.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate(([mjs, mdjs, light, folder]) => {
    document.body.classList.add(light ? "vscode-light" : "vscode-dark");
    const root = document.documentElement.dataset;
    Object.assign(root, { chatPlace: "tab", tabKey: "0123456789abcdef", tabSession: "", draftScope: "a".repeat(64), ...(folder ? { tabCwd: folder } : {}) });
    window.__posted = []; window.__state = undefined;
    window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posted.push(m); }, getState: () => window.__state, setState(s) { window.__state = s; } });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs, theme.startsWith("light"), cwd]);
  await page.waitForFunction(() => document.getElementById("input"));
  const send = (data) => page.evaluate((d) => window.postMessage(d, "*"), data).then(() => page.waitForTimeout(30));
  return { page, errors, send, posted: (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type),
           value: () => page.evaluate(() => document.getElementById("input").value) };
}

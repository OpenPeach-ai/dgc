import { JSDOM } from "jsdom";

// The source is a template literal, not a rendered webview. Parse it as HTML and remove
// external assets; tag filtering with a regex can miss valid HTML spellings.
export function chatdgcFixtureHtml(source) {
  const document = new JSDOM(source).window.document;
  document.querySelectorAll("link, script, meta[http-equiv='Content-Security-Policy']").forEach((node) => node.remove());
  for (const node of document.querySelectorAll("*")) {
    for (const attribute of [...node.attributes]) {
      if (attribute.value.includes("${")) node.setAttribute(attribute.name, "");
    }
  }
  return `<!doctype html>${document.documentElement.outerHTML}`;
}

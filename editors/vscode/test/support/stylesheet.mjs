// A stylesheet as the webview gets it: every local @import written in place, so a page a test builds from a string has
// the tokens (media/shared/tokens.css) that main.css imports. A <style> tag on about:blank cannot fetch a relative
// @import, so without this a test page would silently lose every colour, space and corner token.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IMPORT = /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?\s*;/g;

export function readStylesheet(file) {
  const seen = new Set();
  const inline = (path) => {
    if (seen.has(path)) return "";
    seen.add(path);
    return readFileSync(path, "utf8").replace(IMPORT, (whole, href) =>
      /^[a-z][a-z0-9+.-]*:/i.test(href) ? whole : inline(resolve(dirname(path), href)));
  };
  return inline(file instanceof URL ? fileURLToPath(file) : resolve(file));
}

const here = dirname(fileURLToPath(import.meta.url));
export const TOKENS_CSS = resolve(here, "../../media/shared/tokens.css");

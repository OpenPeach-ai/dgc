// Every browser test draws its words in the same font on every machine: Chromium on Linux finds fonts through
// fontconfig, and this points it at test/fonts (fonts.conf: Noto Sans; DGC_TEST_FONTS=wide: wide.conf, DejaVu Sans).
// Loaded by `npm test` (node --import) before any test file, so each test's Chromium inherits it. A FONTCONFIG_FILE
// already set wins. (macOS and Windows Chromium don't read fontconfig; the pinned run is Linux's, as CI's is.)
import { fileURLToPath } from "node:url";

const wide = process.env.DGC_TEST_FONTS === "wide";
process.env.FONTCONFIG_FILE ||= fileURLToPath(new URL(`../fonts/${wide ? "wide" : "fonts"}.conf`, import.meta.url));

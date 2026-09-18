#!/usr/bin/env node
/** Compile src/*.ts to dist/ (ESM + .d.ts) and copy the stdio MCP relay beside it. */
import { copyFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
rmSync(join(root, "dist"), { recursive: true, force: true });
execFileSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], { stdio: "inherit" });
copyFileSync(join(root, "src", "mcp-bridge.mjs"), join(root, "dist", "mcp-bridge.mjs"));

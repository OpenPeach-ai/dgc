// "@" never offers a secret or a cache file (user test W16/C8), in Work, ChatDGC and Pips alike: the three lists are one
// function, workspaceFiles() of src/mentionsHost.ts, and its filter is mentionOffered(). Tested on a real folder through
// the real module (test/support/mention-files-host.mjs): the files a project really has beside its source (.env, keys,
// __pycache__, a virtual environment, build output), a user's own files.exclude (VS Code drops it once a caller names an
// exclude, so the list must keep it itself), a project whose junk outnumbers its source, and the order: source first.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mentionsHost, project } from "./support/mention-files-host.mjs";

const made = [];
after(() => { for (const p of made) p.remove(); });
const SOURCE = ["README.md", "app/main.py", "app/billing/eway.py", "web/index.ts", "web/key.ts", "docs/build.md", "tests/test_eway.py", "config/environment.py"];
const FINE = [".env.example", ".env.sample", "app/.env.example", ".github/workflows/ci.yml", "package-lock.json", "web/app.min.js"];
const NEVER = [".env", ".env.local", ".env.production", "app/.env", "app/.env.staging", "certs/server.pem", "certs/server.key", "id_rsa", "id_rsa.pub", "deploy/id_rsa_deploy", "deploy/id_ed25519",
  "app/__pycache__/main.cpython-312.pyc", "app/billing/__pycache__/eway.cpython-312.pyc", "app/stale.pyc", "app/stale.pyo", "venv/lib/site.py", ".venv/bin/activate", "build/lib/app/main.py",
  "target/debug/app", ".mypy_cache/3.12/app.data.json", ".pytest_cache/v/cache/lastfailed", ".tox/py312/log.txt", "coverage/index.html", ".DS_Store", "web/.DS_Store",
  "node_modules/left-pad/index.js", "web/node_modules/x/index.js", ".git/config", ".git/HEAD"];

test("the @ list never offers a secret or a cache file, and keeps .env.example and .env.sample", async () => {
  const p = project([...SOURCE, ...FINE, ...NEVER]); made.push(p);
  const { module } = await mentionsHost(p.root);
  const labels = (await module.workspaceFiles()).map((f) => f.label);
  for (const path of NEVER) assert.ok(!labels.includes(path), `${path} is never offered`);
  for (const path of [...SOURCE, ...FINE]) assert.ok(labels.includes(path), `${path} is offered`);
  assert.equal(labels.length, SOURCE.length + FINE.length, "and nothing else");
});

test("the filter itself: one rule for every list", async () => {
  const p = project(["a.txt"]); made.push(p);
  const { module } = await mentionsHost(p.root);
  for (const path of NEVER) assert.equal(module.mentionOffered(path), false, path);
  for (const path of [...SOURCE, ...FINE]) assert.equal(module.mentionOffered(path), true, path);
  // Names that only look like one: a folder or a file whose name merely contains the word stays.
  for (const path of ["src/build.gradle", "docs/target-audience.md", "app/coverage_report.py", "keys/README.md", "app/environment.env.md", "rebuild/x.py", "my.keynote", "venv.md"]) assert.equal(module.mentionOffered(path), true, path);
  // Windows separators and capitals are the same file.
  for (const path of ["app\\__pycache__\\x.pyc", "App\\.ENV", "Certs\\Server.PEM", "NODE_MODULES\\x\\index.js"]) assert.equal(module.mentionOffered(path), false, path);
});

test("the user's own files.exclude is kept, though VS Code drops it when a caller names an exclude", async () => {
  const p = project([...SOURCE, "notes/todo.log", "app/debug.log", "drafts/idea.md", "drafts/old/plan.md", "app/keep.md", "vendor/lib/a.js", "app/vendor/b.js", "shown/x.md"]); made.push(p);
  const { module, asked } = await mentionsHost(p.root, { "**/*.log": true, "drafts": true, "**/vendor": true, "shown": false, "**/*.md": { when: "$(basename).txt" } });
  const labels = (await module.workspaceFiles()).map((f) => f.label);
  for (const path of ["notes/todo.log", "app/debug.log", "drafts/idea.md", "drafts/old/plan.md", "vendor/lib/a.js", "app/vendor/b.js"]) assert.ok(!labels.includes(path), `${path}: the user hides it, so "@" does not offer it`);
  for (const path of ["app/keep.md", "shown/x.md", "README.md", ...SOURCE]) assert.ok(labels.includes(path), `${path} stays (a pattern set to false, or one with a condition, hides nothing)`);
  assert.equal(typeof asked.at(-1).exclude, "string", "an exclude is named (so node_modules and the caches never count against the list's size)");
});

test("junk never crowds the source out: a project with far more cache files than source still lists all its source", async () => {
  const junk = [];
  for (let i = 0; i < 900; i++) junk.push(`aaa/__pycache__/m${i}.cpython-312.pyc`, `aab/node_modules/p${i}/index.js`);
  const p = project([...junk, ...SOURCE]); made.push(p);
  const { module, asked } = await mentionsHost(p.root);
  const labels = (await module.workspaceFiles()).map((f) => f.label);
  assert.deepEqual([...labels].sort(), [...SOURCE].sort());
  assert.ok(asked.at(-1).most <= 1000, "and the list stays a bounded size");
});

test("real source comes first: hidden folders, lock files and built bundles after it; each group by name", async () => {
  const p = project([".github/workflows/ci.yml", ".env.example", ".vscode/settings.json", "package-lock.json", "poetry.lock", "web/app.min.js", "web/app.js.map", "app/main.py", "README.md", "web/index.ts"]); made.push(p);
  const { module } = await mentionsHost(p.root);
  const labels = (await module.workspaceFiles()).map((f) => f.label);
  assert.deepEqual(labels.slice(0, 3), ["app/main.py", "README.md", "web/index.ts"], "the source, by name");
  assert.deepEqual(labels.slice(3).sort(), [".env.example", ".github/workflows/ci.yml", ".vscode/settings.json", "package-lock.json", "poetry.lock", "web/app.js.map", "web/app.min.js"].sort());
});

test("Work, ChatDGC and Pips all list through the one function", () => {
  const read = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
  for (const name of ["panel.ts", "chatdgc.ts", "pipsView.ts"]) {
    assert.match(read(name), /workspaceFiles\(\)/, `${name} lists through workspaceFiles()`);
    assert.doesNotMatch(read(name), /findFiles\(/, `${name} walks no files of its own`);
  }
});

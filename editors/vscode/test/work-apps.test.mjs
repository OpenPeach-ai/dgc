import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
function source(name) {
  const code = buildSync({ entryPoints: [here + '../src/' + name], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, createRequire(import.meta.url));
  return module.exports;
}
const registry = source('workAppsRegistry.ts');
const probe = source('workAppsProbe.ts');

test('an imported app stays in an owner-local index without modifying its project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dgc-apps-test-'));
  const project = join(root, 'erp');
  const file = join(root, 'index', 'v1.json');
  await mkdir(project);
  const app = await registry.addWorkApp({ name: 'ERP', projectRoot: project,
    url: 'https://app.example.test/', healthUrl: 'https://app.example.test/health/ready' }, file);
  assert.match(app.id, /^app_[a-f0-9]{16}$/);
  assert.equal((await registry.listWorkApps(file))[0].projectRoot, project);
  assert.equal((await readFile(file, 'utf8')).includes('password'), false);
  await assert.rejects(registry.addWorkApp({ name: 'ERP', projectRoot: project, url: app.url }, file), /already in Apps/);
  assert.equal(await registry.removeWorkApp(app.id, file), true);
  assert.deepEqual(await registry.listWorkApps(file), []);
  assert.equal((await stat(project)).isDirectory(), true);
});

test('app imports require a bounded same-origin health address', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dgc-apps-test-'));
  const file = join(root, 'index.json');
  await assert.rejects(registry.addWorkApp({ name: 'ERP', projectRoot: root,
    url: 'https://app.example.test/', healthUrl: 'https://other.example.test/health' }, file), /same origin|origin/);
  await assert.rejects(registry.addWorkApp({ name: 'ERP', projectRoot: root,
    url: 'https://user:password@app.example.test/' }, file), /without credentials/);
});

test('frame protection is respected before opening an app inside an editor tab', () => {
  assert.equal(probe.frameDecision({ 'x-frame-options': 'SAMEORIGIN' }).embedded, false);
  assert.equal(probe.frameDecision({ 'content-security-policy': "default-src 'self'; frame-ancestors 'self'" }).embedded, false);
  assert.equal(probe.frameDecision({}).embedded, true);
});

test('Apps follows the same DGC_HOME profile as the CLI', async () => {
  const previous = process.env.DGC_HOME;
  const root = await mkdtemp(join(tmpdir(), 'dgc-apps-home-'));
  try {
    process.env.DGC_HOME = root;
    assert.equal(registry.workAppsFile(), join(root, '.dgc', 'work_apps', 'v1.json'));
  } finally {
    if (previous === undefined) delete process.env.DGC_HOME;
    else process.env.DGC_HOME = previous;
  }
});

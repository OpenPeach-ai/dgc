// A reply's "Used [logo] Aave" line (ChatDGC and Pips): the host reads a plugin's logo by its id, as a data: URI any
// webview can show, and never a file outside the logos DGC ships or the plugin's own package asset.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url), here = new URL('..', import.meta.url).pathname;
const bundle = async (file) => (await build({entryPoints: [path.join(here, 'src', file)], bundle: true, write: false, platform: 'node',
  format: 'cjs', external: ['vscode'], loader: {'.css': 'empty'}})).outputFiles[0].text;
const vscode = {Uri: {joinPath: (uri, ...parts) => ({fsPath: path.join(uri.fsPath, ...parts)})}};
const load = (code) => { const m = {exports: {}}; new Function('module', 'exports', 'require', code)(m, m.exports, (n) => n === 'vscode' ? vscode : require(n)); return m.exports; };
const {pluginLogoData} = load(await bundle('pluginLogos.ts'));
const extension = {fsPath: here};

test('a plugin DGC ships a logo for: its logo as a data: URI, by id', () => {
  const aave = pluginLogoData(extension, {name: 'aave'});
  assert.equal(aave, `data:image/png;base64,${readFileSync(path.join(here, 'media/plugin-logos/aave.png')).toString('base64')}`);
  assert.match(pluginLogoData(extension, {name: 'composio'}), /^data:image\/svg\+xml;base64,/, 'an SVG mark');
  assert.match(pluginLogoData(extension, {name: 'zapier'}), /^data:image\/x-icon;base64,/);
  assert.match(pluginLogoData(extension, {name: 'dgc-notes', icon: 'dgc'}), /^data:image\/svg\+xml;base64,/, "DGC's own plugins: DGC's mark");
});

test('no logo, or a name that is a path, is nothing (the line shows a plug)', () => {
  for (const name of ['no-such-plugin', '../package', '..', 'a/b', '', undefined, 'constructor', 'toString', '__proto__']) {
    assert.equal(pluginLogoData(extension, {name}), '', String(name));
  }
});

test("a package's own logo is read only from DGC's logos folder, only a real PNG", () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dgc-logos-'));
  const logos = path.join(home, '.dgc', 'plugins', 'logos');
  mkdirSync(logos, {recursive: true});
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('mine')]);
  writeFileSync(path.join(logos, 'mine.png'), png);
  writeFileSync(path.join(logos, 'fake.png'), 'not a png');
  writeFileSync(path.join(home, 'elsewhere.png'), png);
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.equal(pluginLogoData(extension, {name: 'mine', logo_file: path.join(logos, 'mine.png')}), `data:image/png;base64,${png.toString('base64')}`);
    assert.equal(pluginLogoData(extension, {name: 'aave', logo_file: path.join(logos, 'fake.png')}).startsWith('data:image/png;base64,iVBOR'), true,
                 'not a PNG: the shipped logo instead');
    assert.equal(pluginLogoData(extension, {name: 'mine', logo_file: path.join(home, 'elsewhere.png')}), '', 'outside the folder: nothing');
  } finally { process.env.HOME = saved; }
});

test('the Pips view answers a logo request with the logos the host found, for valid ids only', async () => {
  const {PipsEditor} = load(await bundle('pipsView.ts'));
  const posted = [], asked = [];
  const bridge = new PipsEditor({}, () => true, () => {});
  bridge.attach((m) => posted.push(m));
  bridge.usePluginLogos((id) => { asked.push(id); return id === 'aave' ? 'data:image/png;base64,AAAA' : ''; });
  bridge.receive({type: 'pipsPluginLogos', plugins: ['aave', 'context7', '../x', 7, 'Aave']});
  assert.deepEqual(asked, ['aave', 'context7']);
  assert.deepEqual(posted, [{type: 'pipsPluginLogos', logos: {aave: 'data:image/png;base64,AAAA', context7: ''}}]);
  bridge.receive({type: 'pipsPluginLogos', plugins: ['../x']});
  assert.equal(posted.length, 1, 'nothing valid: no reply');
});

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
const {pluginLogoData, appLogoData} = load(await bundle('pluginLogos.ts'));
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

test('every plugin the catalog lists has a logo DGC ships (Higgsfield, Runway and Cardboard showed a plug)', () => {
  const catalog = JSON.parse(readFileSync(path.join(here, '..', '..', 'dgc', 'plugin_catalog.json'), 'utf8'));
  const items = Array.isArray(catalog) ? catalog : (catalog.plugins || catalog.items || []);
  const missing = items.filter((p) => !p.unlisted && !p.name?.startsWith('dgc-'))
    .filter((p) => !pluginLogoData(extension, {name: p.name, developer: p.developer, icon: p.icon}))
    .map((p) => p.name);
  assert.deepEqual(missing, []);
  for (const name of ['higgsfield', 'runway', 'cardboard'])
    assert.match(pluginLogoData(extension, {name}), /^data:image\/png;base64,/, name);
});

// A logo beside each app in a Pip's "Apps it can use" (asked 12 Nov). An app a Pip reaches through Composio is named by
// its toolkit (dgc/pip_app_links.py); the host picks the logo DGC ships for it from a small fixed list, and the page
// only ever names the app.
test('an app through Composio: the logo DGC ships for its toolkit, from a fixed list, as a data: URI', () => {
  const shipped = (file) => `data:image/png;base64,${readFileSync(path.join(here, 'media/plugin-logos', file)).toString('base64')}`;
  for (const [toolkit, file] of [['gmail', 'gmail.png'], ['googlecalendar', 'calendar.png'], ['googledrive', 'drive.png'], ['googlecontacts', 'contacts.png'],
    ['notion', 'notion.png'], ['outlook', 'outlook.png'], ['onedrive', 'onedrive.png']])
    assert.equal(appLogoData(extension, toolkit), shipped(file), toolkit);
  // Others DGC ships a logo for, by the names dgc/pip_app_links.py gives its toolkits.
  for (const [toolkit, file] of [['googledocs', 'docs.png'], ['googleslides', 'slides.png'], ['github', 'github.png'], ['linear', 'linear.png'], ['dropbox', 'dropbox.png'], ['zoom', 'zoom.png']])
    assert.equal(appLogoData(extension, toolkit), shipped(file), toolkit);
  // Every toolkit the list names is one DGC knows, so a renamed toolkit is noticed here.
  const names = readFileSync(path.join(here, '..', '..', 'dgc', 'pip_app_links.py'), 'utf8').match(/^NAMES = \{[^}]+\}/m)[0];
  for (const toolkit of ['gmail', 'googlecalendar', 'googledrive', 'googlecontacts', 'googledocs', 'googleslides', 'notion', 'outlook', 'onedrive', 'github', 'linear', 'dropbox', 'zoom'])
    assert.ok(names.includes(`"${toolkit}":`), `${toolkit} is a toolkit DGC names`);
});

test('an app DGC ships no logo for, or a name that is not a toolkit, is nothing: never a file made from the name', () => {
  // (aave.png and calendar.png are files in the folder: a plugin's logo, and the picture Google Calendar uses. Neither is a toolkit's name.)
  for (const toolkit of ['todoist', 'slack', 'googlesheets', 'aave', 'calendar', 'SOURCES', 'gmail.png', '../gmail', 'gmail/../aave', '..', '', 'Gmail', 'g', 'constructor', 'toString', '__proto__', 'hasOwnProperty', undefined, null, 7, {}, ['gmail']])
    assert.equal(appLogoData(extension, toolkit), '', String(toolkit));
  // The folder is the extension's own: another root has no such file, and that is nothing too, not an error.
  assert.equal(appLogoData({fsPath: path.join(tmpdir(), 'no-such-extension')}, 'gmail'), '');
});

test('the Pips view answers an app logo request for valid toolkit ids only, from the logos DGC ships', async () => {
  const {PipsEditor} = load(await bundle('pipsView.ts'));
  const posted = [];
  const bridge = new PipsEditor(extension, () => true, () => {});
  bridge.attach((m) => posted.push(m));
  bridge.receive({type: 'pipsAppLogos', apps: ['gmail', 'todoist', '../x', 7, 'Gmail', 'googlecalendar']});
  assert.deepEqual(posted.map((m) => [m.type, Object.keys(m.logos)]), [['pipsAppLogos', ['gmail', 'todoist', 'googlecalendar']]]);
  assert.equal(posted[0].logos.gmail, appLogoData(extension, 'gmail'));
  assert.match(posted[0].logos.gmail, /^data:image\/png;base64,iVBOR/);
  assert.equal(posted[0].logos.todoist, '', 'none shipped: the page keeps its letter');
  assert.equal(posted[0].logos.googlecalendar, appLogoData(extension, 'googlecalendar'));
  bridge.receive({type: 'pipsAppLogos', apps: ['../x']});
  bridge.receive({type: 'pipsAppLogos', apps: 'gmail'});
  assert.equal(posted.length, 1, 'nothing valid: no reply');
  // At most sixteen an ask, as for plugins.
  bridge.receive({type: 'pipsAppLogos', apps: Array.from({length: 40}, (_, i) => `app${i}`)});
  assert.equal(Object.keys(posted[1].logos).length, 16);
});

test('the side bar passes the app logo request to the Pips view and its answer back to the page', () => {
  assert.match(readFileSync(path.join(here, 'src/panel.ts'), 'utf8'), /case "pipsPluginLogos":\s+case "pipsAppLogos":/);
  assert.match(readFileSync(path.join(here, 'media/main.js'), 'utf8'), /\["pipsPluginLogos", "pipsAppLogos", /);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {readFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
// Chromium the way the other layout tests start it: a machine without it skips (GitHub's release job installs
// none, and a launch here failed the 0.48.2 release), and DGC_REQUIRE_CHROMIUM=1 makes that a failure.
async function launchOrSkip(t){try{return await chromium.launch({args:['--headless=new','--no-sandbox']});}catch(error){if(process.env.DGC_REQUIRE_CHROMIUM==='1')throw error;t.skip('Chromium could not start: '+String(error?.message||error).split('\n')[0]);return null;}}
const code=(await build({entryPoints:[fileURLToPath(new URL('../src/pipsConnectorForm.js',import.meta.url))],bundle:true,write:false,format:'iife',globalName:'ConnectorForm'})).outputFiles[0].text;
const css=readFileSync(new URL('../src/pips.css',import.meta.url),'utf8').replace(/^@import[^;]+;/gm,'');
const schema={type:'object',required:['title','destination','labels'],properties:{title:{title:'Note title',type:'string',minLength:1,description:'The title to save.'},destination:{title:'Destination',type:'object',required:['folder'],properties:{folder:{title:'Folder',type:'string'}}},labels:{title:'Labels',type:'array',items:{type:'string',minLength:1},minItems:1,maxItems:5},publish:{title:'Publish immediately',type:'boolean',description:'Leave omitted to use the connector’s default. Check that default before approving.'}}};
test('connector form keyboard inputs and review remain legible at narrow and wide sizes',async(t)=>{
 const browser=await launchOrSkip(t);if(!browser)return;
 try{for(const width of [300,600]){
  const page=await browser.newPage({viewport:{width,height:900}});
  await page.route('**/*',route=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html; charset=utf-8',body:'<div class="overlay"><section class="dialog" role="dialog" aria-label="Prepare connected tool"><small>Local UI test fixture · no service connected</small><h2>Prepare a saved note</h2><p>Saving prepares a review. It does not run the tool.</p><div id="fields"></div><div class="actions"><button id="cancel">Cancel</button><button id="save">Save for review</button></div><p id="error" role="alert"></p><pre id="result"></pre></section></div>'}):route.abort());
  await page.goto('https://connector-form.invalid/');await page.addStyleTag({content:css+' :root{--vscode-editor-background:#1f1f1f;--vscode-foreground:#dedede;--vscode-input-background:#313131;--vscode-descriptionForeground:#a3a3a3;--vscode-button-background:#6747df;--vscode-button-foreground:#fff;--vscode-focusBorder:#9b81ff;--line:#3b3b3b}body{font:13px/1.5 system-ui} .dialog{max-width:520px}pre{white-space:pre-wrap;overflow-wrap:anywhere}'});await page.addScriptTag({content:code});
  await page.evaluate(schema=>{window.formState=ConnectorForm.createConnectorInputs(schema);ConnectorForm.mountConnectorInputs(document.querySelector('#fields'),formState);document.querySelector('#save').onclick=()=>{try{document.querySelector('#result').textContent=JSON.stringify(ConnectorForm.readConnectorInputs(formState),null,2);}catch(e){document.querySelector('#error').textContent=e.message;}};},schema);
  await page.getByLabel('Note title',{exact:true}).fill('Weekend plan');await page.getByLabel('Note title',{exact:true}).press('Tab');assert.equal(await page.getByLabel('Folder',{exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.getByLabel('Folder',{exact:true}).fill('Personal');await page.getByRole('button',{name:'Add item'}).click();await page.getByLabel('labels item 1',{exact:true}).fill('home');
  await page.getByLabel('publish: include value').selectOption('value');await page.getByLabel('Publish immediately (optional)',{exact:true}).selectOption('false');
  await page.getByRole('button',{name:'Save for review'}).click();assert.deepEqual(JSON.parse(await page.locator('#result').innerText()),{title:'Weekend plan',destination:{folder:'Personal'},labels:['home'],publish:false});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.locator('.dialog').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true);
  if(width===600&&process.env.DGC_FORM_SCREENSHOT){const path=fileURLToPath(new URL('../../../output/playwright/personal-pips-20261003/',import.meta.url));mkdirSync(path,{recursive:true});await page.locator('.dialog').evaluate(e=>e.scrollTop=0);await page.screenshot({path:path+'connector-form-browser-fixture.png'});}
  await page.close();
 }}finally{await browser.close();}
});

// Settings › Models, provider sign-ins (17 Nov, 0.52): OpenRouter's Connect (and Connect again / Top up on its saved
// row), Sign in for a subscription app that isn't signed in, Ollama's ollama.com sign-in, Get a key for key-only hosts.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
const src=fileURLToPath(new URL('../src/',import.meta.url));
const result=await build({entryPoints:[src+'settingsClient.js'],bundle:true,write:false,loader:{'.css':'empty','.ico':'dataurl','.png':'dataurl','.svg':'dataurl'},format:'iife'});
const code=result.outputFiles[0].text;
const view=await build({entryPoints:[src+'settingsView.ts'],bundle:true,write:false,platform:'node',format:'cjs'});
const module={exports:{}};new Function('module','exports',view.outputFiles[0].text)(module,module.exports);
const windows=[];after(()=>windows.forEach(w=>w.close()));
function setup(){
 const dom=new JSDOM(module.exports.settingsDocument(),{runScripts:'outside-only'});const {window:w}=dom;windows.push(w);
 const sent=[];w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(JSON.parse(JSON.stringify(m)))});w.eval(code);
 const message=m=>w.dispatchEvent(new w.MessageEvent('message',{data:m}));
 const config={type:'config',base_url:'https://model.example/v1',model:'original',mode:'default',think:'high',subscription_engine:''};
 message({type:'event',event:config});
 return {w,d:w.document,sent,message,config,click:s=>w.document.querySelector(s).click(),
  pick:id=>{const p=w.document.querySelector('#saved_provider_preset');p.value=id;p.dispatchEvent(new w.Event('change',{bubbles:true}));}};
}
const PRESETS=[{id:'ollama',label:'Ollama (local)',url:'http://localhost:11434/v1'},
 {id:'openrouter',label:'OpenRouter',url:'https://openrouter.ai/api/v1',needsKey:true,keys:true,connect:true},
 {id:'groq',label:'Groq',url:'https://api.groq.com/openai/v1',needsKey:true,keys:true}];
const OR='provider_'+'b'.repeat(32), OLL='provider_'+'a'.repeat(32);
const rowOf=(x,name)=>[...x.d.querySelectorAll('.provider-row')].find(r=>r.querySelector('.name')?.textContent===name);

test('OpenRouter in Add provider: Connect signs in, a pasted key still works, and waiting can be cancelled',()=>{
 const x=setup();x.message({type:'providers',providers:PRESETS});
 x.click('[data-nav=models]');x.click('details[data-more=saved-providers] summary');x.pick('openrouter');
 const connect=x.d.querySelector('[data-provider-connect="openrouter"]');
 assert.equal(connect?.textContent,'Connect');
 assert.match(connect.closest('.field').textContent,/opens openrouter\.ai/i);
 assert.ok(x.d.querySelector('#saved_provider_key'),'pasting a key is still there');
 assert.equal(x.d.querySelector('[data-provider-keys]'),null,'Connect takes the place of Get a key');
 connect.click();
 assert.deepEqual(x.sent.at(-1),{type:'connectProvider',preset:'openrouter',model:''});
 x.message({type:'providerConnecting',preset:'openrouter',id:'',waiting:true});
 assert.match(x.d.querySelector('#saved-provider-status').textContent,/Waiting for OpenRouter in your browser/);
 assert.equal(x.d.querySelector('[data-provider-connect="openrouter"]').disabled,true);
 x.click('[data-provider-connect-cancel]');
 assert.deepEqual(x.sent.at(-1),{type:'cancelProviderConnect'});
 x.message({type:'providerConnecting',preset:'openrouter',id:'',waiting:false});
 assert.equal(x.d.querySelector('[data-provider-connect="openrouter"]').disabled,false);
 assert.equal(x.d.querySelector('[data-provider-connect-cancel]'),null);
});

test('a key-only host keeps Get a key beside its key box',()=>{
 const x=setup();x.message({type:'providers',providers:PRESETS});
 x.click('[data-nav=models]');x.click('details[data-more=saved-providers] summary');x.pick('groq');
 assert.equal(x.d.querySelector('[data-provider-keys]')?.textContent,'Get a key');
 assert.equal(x.d.querySelector('[data-provider-connect]'),null);
});

test("a saved OpenRouter that stopped taking its key says so, with Connect again; out of credit offers Top up",()=>{
 const x=setup();x.message({type:'providers',providers:PRESETS});
 x.message({type:'providerProfiles',defaultId:OR,profiles:[{id:OR,kind:'native',name:'OpenRouter',base_url:'https://openrouter.ai/api/v1',model:'some/model',api_mode:'auto'}]});
 x.click('[data-nav=models]');
 assert.equal(rowOf(x,'OpenRouter').querySelector('[data-provider-reconnect]'),null,'nothing before its state is known');
 x.message({type:'providerStates',states:{[OR]:{state:'signed_out'}}});
 let row=rowOf(x,'OpenRouter');
 assert.match(row.querySelector('.provider-problem')?.textContent||'',/Signed out of OpenRouter/);
 row.querySelector(`[data-provider-reconnect="${OR}"]`).click();
 assert.deepEqual(x.sent.at(-1),{type:'reconnectProvider',id:OR});
 x.message({type:'providerConnecting',preset:'openrouter',id:OR,waiting:true});
 row=rowOf(x,'OpenRouter');
 assert.equal(row.querySelector(`[data-provider-reconnect="${OR}"]`).disabled,true);
 assert.ok(row.querySelector('[data-provider-connect-cancel]'),'Cancel while it waits');
 x.message({type:'providerConnecting',preset:'openrouter',id:OR,waiting:false});
 x.message({type:'providerStates',states:{[OR]:{state:'no_credit',limit:10,limit_remaining:0}}});
 row=rowOf(x,'OpenRouter');
 assert.match(row.querySelector('.provider-problem')?.textContent||'',/Out of OpenRouter credits/);
 row.querySelector('[data-provider-topup]').click();
 assert.deepEqual(x.sent.at(-1),{type:'openProviderKeys',id:'openrouter',page:'credits'});
 x.message({type:'providerStates',states:{[OR]:{state:'ok',limit:10,limit_remaining:8.5}}});
 row=rowOf(x,'OpenRouter');
 assert.equal(row.querySelector('.provider-problem'),null);
 assert.match(row.querySelector('.hint').textContent,/\$8\.50 left/);
});

test('a subscription app that is not signed in has Sign in, which runs its own sign-in',()=>{
 const x=setup();
 x.message({type:'providerProfiles',defaultId:'',profiles:[{id:'subscription_codex',kind:'subscription',engine:'codex',name:'Codex',model:''}]});
 x.message({type:'event',event:{...x.config,subscription_engines:[{key:'codex',installed:true,auth_state:'signed_out',login_cmd:'codex login'}]}});
 x.click('[data-nav=models]');
 const row=rowOf(x,'Codex');
 assert.match(row.textContent,/Not signed in on this computer/);
 row.querySelector('[data-app-signin="codex"]').click();
 assert.deepEqual(x.sent.at(-1),{type:'signInApp',app:'codex'});
 x.message({type:'event',event:{...x.config,subscription_engines:[{key:'codex',installed:true,auth_state:'signed_in'}]}});
 assert.equal(rowOf(x,'Codex').querySelector('[data-app-signin]'),null,'signed in: no button');
});

test("Ollama on this computer says whether it's signed in to ollama.com, with Sign in when it isn't",()=>{
 const x=setup();
 x.message({type:'providerProfiles',defaultId:OLL,profiles:[{id:OLL,kind:'native',name:'Ollama (local)',base_url:'http://localhost:11434/v1',model:'qwen',api_mode:'auto'}]});
 x.click('[data-nav=models]');
 assert.equal(rowOf(x,'Ollama (local)').querySelector('[data-app-signin]'),null,'nothing before it is known');
 x.message({type:'ollamaAccount',signed_in:false});
 let row=rowOf(x,'Ollama (local)');
 assert.match(row.textContent,/Not signed in to ollama\.com/);
 row.querySelector('[data-app-signin="ollama"]').click();
 assert.deepEqual(x.sent.at(-1),{type:'signInApp',app:'ollama'});
 x.message({type:'ollamaAccount',signed_in:true,name:'tilemaker'});
 row=rowOf(x,'Ollama (local)');
 assert.match(row.textContent,/Signed in to ollama\.com as tilemaker/);
 assert.equal(row.querySelector('[data-app-signin]'),null);
});

test("Ollama as the default from before saved providers says its ollama.com sign-in too", () => {
 const x = setup();
 x.message({type:'providerProfiles',defaultId:'',profiles:[],direct:{name:'Ollama (local)',model:'qwen',base_url:'http://127.0.0.1:11434'}});
 x.click('[data-nav=models]');
 x.message({type:'ollamaAccount',signed_in:false});
 const row=x.d.querySelector('.provider-direct');
 assert.match(row.textContent,/Not signed in to ollama\.com/);
 row.querySelector('[data-app-signin="ollama"]').click();
 assert.deepEqual(x.sent.at(-1),{type:'signInApp',app:'ollama'});
});

test("OpenRouter's key box says it is for pasting a key", () => {
 const x=setup();x.message({type:'providers',providers:PRESETS});
 x.click('[data-nav=models]');x.click('details[data-more=saved-providers] summary');x.pick('openrouter');
 const box=x.d.querySelector('#saved_provider_key');
 assert.equal(box.getAttribute('placeholder'),'Or paste a key');
 assert.equal(box.nextElementSibling?.dataset.providerConnect,'openrouter','Connect sits on the right of the box');
});

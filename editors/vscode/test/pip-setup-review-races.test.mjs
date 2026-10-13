import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const src=new URL('../src/',import.meta.url);
const bundle=buildSync({entryPoints:[new URL('pipSetupCards.js',src).pathname],bundle:true,write:false,format:'iife',globalName:'Cards'}).outputFiles[0].text;
const bridge=buildSync({entryPoints:[new URL('pipsView.ts',src).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']}).outputFiles[0].text;
const setup=()=>({id:'setup_'+'3'.repeat(32),digest:'a'.repeat(64),workspace_id:'ws_'+'1'.repeat(32),project_root:'/review/project',pip_id:null,name:'Daily review',goal:'Review committed source.',pip_type:'rook',work_kind:'source_review',source_ref:'HEAD',schedule:null,run_now:false,next_run_at:null,status:'pending',created_at:'2099-10-02T04:00:00Z',expires_at:'2099-10-03T06:00:00Z',receipt:null,reason:'Recurring code checks.',expected_version:null,expected_lifecycle_revision:null,permissions:'read_only',source_policy:'committed_only',runner_notice:'The runner must be online.',scope_notice:'Read source only.',run_now_policy:null,model_choice:{mode:'default'}});
const accepted=s=>({...s,status:'accepted',receipt:{setup_id:s.id,pip_id:'pip_'+'2'.repeat(32),job_version:1,run_id:null,next_run_at:null,accepted:true,actor:'editor-user',resolved_at:'2099-10-02T04:01:00Z'}});
async function flush(){for(let i=0;i<24;i++)await Promise.resolve();}
function fixture(t){
 const dom=new JSDOM('<section id="turn"><div class="tool"><button class="tool-toggle"><span class="verb"></span></button><span class="badge"></span><div class="body"></div></div></section>',{runScripts:'outside-only'});
 const w=dom.window;w.TextEncoder=TextEncoder;w.eval(bundle+';window.Cards=Cards;');const sent=[],continued=[];
 const cards=w.Cards.mountSetupCards({document:w.document,postMessage:m=>sent.push(m),onContinue:p=>{continued.push(p);return true;}});
 t.after(()=>{cards.dispose();dom.window.close();});
 const connection=(generation=1,connected=true)=>cards.receive({type:'pipsConnection',generation,connected,enabled:true,backgroundSetup:true,apiVersion:25});connection();
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const reply=(r,result)=>cards.receive({type:'pipsReply',id:r.id,ok:true,result});
 const button=label=>[...w.document.querySelectorAll('button')].find(b=>b.textContent===label);
 async function load(s){cards.toolResult(w.document.querySelector('.tool'),{name:'pips_setup',output:JSON.stringify({setup:s})});reply(requests('get_pip_setup').at(-1),{setup:s});await flush();}
 async function approve(s){button('Create Pip').click();reply(requests('get_pip_setup').at(-1),{setup:s});await flush();return requests('accept_pip_setup').at(-1);}
 return {w,cards,sent,continued,connection,requests,reply,button,load,approve};
}
test('host gates larger context on API25 while 32K continues on API24',()=>{
 const mod={exports:{}};new Function('module','exports','require',bridge)(mod,mod.exports,name=>name==='vscode'?{}:require(name));
 for(const api of [24,25]){
  const sent=[],posted=[],editor=new mod.exports.PipsEditor({},m=>{sent.push(m);return true;},()=>{});
  editor.attach(m=>posted.push(m));editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
  for(const size of [32768,65536,1048576])editor.receive({type:'pipsRequest',id:'ctx-'+size,request:{type:'send_pip_message',pip_id:'p',text:'Explain',idempotency_key:'test',chat_options:{context_size:size,thinking:'off'}}});
  assert.equal(sent.length,api===24?1:3);
  if(api===24)assert.match(posted.at(-1).error.message,/context window above 32K/);
 }
});
test('same-generation connection publication cannot refresh over an approval in flight',async t=>{
 const x=fixture(t),s=setup();await x.load(s);const approval=await x.approve(s),before=x.requests('get_pip_setup').length;
 x.connection();assert.equal(x.requests('get_pip_setup').length,before);
 x.reply(approval,{setup:accepted(s)});await flush();assert.equal(x.requests('notify_pip_setup').length,1);assert.match(x.w.document.querySelector('.pip-setup-line strong').textContent,/Daily review is on/);
});
test('generation switch during approval preflight cannot send acceptance to the next chat',async t=>{
 const x=fixture(t),s=setup();await x.load(s);x.button('Create Pip').click();const preflight=x.requests('get_pip_setup').at(-1);
 x.connection(2,false);x.reply(preflight,{setup:s});await flush();assert.equal(x.requests('accept_pip_setup').length,0);assert.equal(x.continued.length,0);
});
test('one final card prevents duplicate decisions and sends one background notification',async t=>{
 const x=fixture(t),s=setup();await x.load(s);x.cards.finish(x.w.document.querySelector('#turn'));
 const buttons=[...x.w.document.querySelectorAll('button')].filter(b=>b.textContent==='Create Pip');assert.equal(buttons.length,1);
 buttons[0].click();buttons[0].click();assert.equal(x.requests('get_pip_setup').length,2);
 x.reply(x.requests('get_pip_setup').at(-1),{setup:s});await flush();const req=x.requests('accept_pip_setup').at(-1);x.reply(req,{setup:accepted(s)});x.reply(req,{setup:accepted(s)});await flush();assert.equal(x.requests('accept_pip_setup').length,1);assert.equal(x.requests('notify_pip_setup').length,1);
});

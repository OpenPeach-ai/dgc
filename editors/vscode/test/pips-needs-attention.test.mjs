// One "Needs attention" list across your Personal Pips (#8, list_pip_attention): on the Pips home, above
// Your Pips, newest first; each row opens its Pip at the card (its chat, its computer, or the setup), and a
// Pip's row on the home counts what waits for you there.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),base=new URL('../src/',import.meta.url);
const bundle=async file=>(await build({entryPoints:[new URL(file,base).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode'],loader:{'.css':'empty'}})).outputFiles[0].text;
const load=(code,req=require)=>{const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,req);return m.exports;};
const viewModule=load(await bundle('pipsView.ts'),name=>name==='vscode'?{}:require(name));
const attention=load(await bundle('pipAttention.js'));
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const hex=c=>c.repeat(32);
const PW='ws_'+hex('e'),PIP='pip_'+hex('a'),MAX='pip_'+hex('b'),LINK='applink_'+hex('1'),DRAFT='maildraft_'+hex('2'),ACTION='appaction_'+hex('3'),HELD='compact_'+hex('4'),SETUP='setup_'+hex('5');
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const pip=(id,name,extra={})=>({id,workspace_id:PW,pip_type:'scout',name,goal:'Help with what I ask in this chat.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',trigger:'manual',schedule:null,proposals:[],pending_review_count:0,...extra});
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const ago=m=>new Date(Date.now()-m*60000).toISOString();
const item=(kind,card,pipId,title,extra={})=>({id:`${kind}:${card}`,kind,card,pip_id:pipId,pip_name:pipId===PIP?'Ava':pipId===MAX?'Max':'',pip_type:pipId?'scout':'',workspace_id:PW,created_at:ago(5),expires_at:null,title,detail:'',...extra});
const page=(items,extra={})=>({as_of:new Date().toISOString(),total:items.length,counts:{},by_pip:items.reduce((a,i)=>(i.pip_id&&(a[i.pip_id]=(a[i.pip_id]||0)+1),a),{}),items,truncated:false,...extra});
const link={id:LINK,pip_id:PIP,workspace_id:PW,toolkit:'gmail',app:'Gmail',reason:'To read your new mail.',status:'requested',label:null,error:null,created_at:ago(9),updated_at:new Date().toISOString()};
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

function setup({found=page([]),apiVersion=44,links=[link],embedded=false}={}){
 // embedded: the side bar's Pips view (main.js mounts it in a shadow root and navigates it from the Sessions home).
 const dom=new JSDOM(embedded?'<!doctype html><html><body><div id="pips-host"></div></body></html>':viewModule.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set();
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.CSS={escape:s=>s};
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(client);
 let app=null,shadow=null;
 if(embedded){
  const listeners=new Set();shadow=w.document.getElementById('pips-host').attachShadow({mode:'open'});
  app=w.DgcPips.mount({root:shadow,postMessage:m=>sent.push(m),onMessage:l=>{listeners.add(l);return()=>listeners.delete(l);},getState:()=>undefined,setState(){}});
  w.addEventListener('message',e=>listeners.forEach(l=>l(e.data)));
 }
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const pips=[pip(PIP,'Ava'),pip(MAX,'Max')];
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:[]}),
  list_pips:()=>({pips,total:pips.length,next_offset:null}),get_pip:()=>({pip:pips.find(p=>p.id===r.pip_id)}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:r.pip_id,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:{pip_id:r.pip_id,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  list_pip_app_links:()=>({pip_id:r.pip_id,links:r.pip_id===PIP?links:[],composio:true}),list_pip_plugins:()=>({pip_id:r.pip_id,plugins:[],installed:[]}),
  list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),
  list_pip_routines:()=>({pip_id:r.pip_id,routines:[]}),list_pip_action_grants:()=>({pip_id:r.pip_id,grants:[]}),get_pip_digest:()=>undefined,get_pips_limit:()=>({max_pips:100,default:100,maximum:100000,count:2}),
  list_pip_attention:()=>found}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion,generation:1,connected:true,supported:true,enabled:true});
 const d=shadow||w.document;
 const click=s=>{const el=d.querySelector(s);assert.ok(el,'Missing '+s);el.click();};
 return {w,d,app,sent,answer,requests,drain,click};
}

// The Sessions home's "34 more need you · Show all" (reported 2026-10-18): from a Pip's chat or a search,
// the Pips home at Needs attention, open in full, with your Pips under it.
test('Show all from the Sessions home opens the Pips home at Needs attention, all of it',async()=>{
 const many=Array.from({length:9},(_,i)=>item('email','maildraft_'+String(i).repeat(32).slice(0,32).replace(/[^a-f0-9]/g,'0'),PIP,`Email ${i+1}`,{created_at:ago(i+1)}));
 const x=setup({found:page(many),embedded:true});await x.drain();
 x.click(`[data-job="${PIP}"]`);await x.drain();
 assert.equal(x.d.querySelector('.attention'),null,'a Pip\'s chat is open');
 const navigating=x.app.navigate({attention:true,all:true,workspace:PW});await x.drain();await navigating;
 assert.ok(x.d.querySelector('.simple-home'),'the Pips home, your Pips listed');
 assert.equal(x.d.querySelectorAll('.attention [data-attention]').length,9,'Needs attention open in full, not the first six');
 assert.ok(x.d.querySelector('[data-attention-more="0"]'),'Show fewer is there to fold it');
});

test('the home lists what every Pip waits on, newest first, above Your Pips; each Pip row counts its own',async()=>{
 const found=page([item('app_link',LINK,PIP,'Connect Gmail?',{detail:'To read your new mail.',created_at:ago(1)}),item('email',DRAFT,MAX,'Send this email to sam@example.test?',{detail:'Lunch moved',created_at:ago(30)}),
  item('computer_action',HELD,PIP,'Send this on shop.example?',{created_at:ago(90)})]);
 const x=setup({found});await x.drain();
 const section=x.d.querySelector('.attention');assert.ok(section,'Needs attention is on the home');
 assert.ok(section.compareDocumentPosition(x.d.querySelector('.simple-home'))&x.w.Node.DOCUMENT_POSITION_FOLLOWING,'above Your Pips');
 assert.match(section.querySelector('h2').textContent,/Needs attention\s*3/);
 const rows=[...section.querySelectorAll('[data-attention]')].map(b=>b.textContent);
 assert.match(rows[0],/Connect Gmail\?To read your new mail\.Ava · App · 1 min ago/);
 assert.match(rows[1],/Send this email to sam@example\.test\?Lunch movedMax · Email · 30 min ago/);
 assert.match(rows[2],/Send this on shop\.example\?Ava · Its computer · 1 h ago/);
 assert.match(x.d.querySelector(`[data-job="${PIP}"]`).textContent,/2 waiting for you/);
 assert.match(x.d.querySelector(`[data-job="${MAX}"]`).textContent,/1 waiting for you/);
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('list_pip_attention')[0].request)),{type:'list_pip_attention',limit:100});
});

test('a row opens its Pip at the card: the chat scrolls to the Connect card; a held submit opens its computer',async()=>{
 const found=page([item('app_link',LINK,PIP,'Connect Gmail?'),item('computer_action',HELD,PIP,'Send this on shop.example?')]);
 const x=setup({found});await x.drain();
 x.click(`[data-attention="app_link:${LINK}"]`);await x.drain();
 const card=x.d.querySelector(`[data-app-link="${LINK}"]`);assert.ok(card,'Ava’s chat is open with the card');
 assert.ok(card.classList.contains('attention-flash'),'the card is shown to you');
 assert.equal(x.d.activeElement?.textContent,'Connect Gmail','its first button takes focus');
 x.click('#simple-back');await x.drain();
 x.click(`[data-attention="computer_action:${HELD}"]`);await x.drain();
 assert.ok(x.sent.some(m=>m.type==='pipsOpenComputer'&&m.pip.id===PIP),'its computer opens, where the held submit waits');
});

test('a long list shows six until you ask for all',async()=>{
 const many=Array.from({length:9},(_,i)=>item('email','maildraft_'+String(i).repeat(32).slice(0,32).replace(/[^a-f0-9]/g,'0'),PIP,`Email ${i+1}`,{created_at:ago(i+1)}));
 const x=setup({found:page(many)});await x.drain();
 assert.equal(x.d.querySelectorAll('[data-attention]').length,6);
 x.click('[data-attention-more="1"]');assert.equal(x.d.querySelectorAll('[data-attention]').length,9);
 x.click('[data-attention-more="0"]');assert.equal(x.d.querySelectorAll('[data-attention]').length,6);
});

test('nothing waiting: no list; an older CLI is never asked',async()=>{
 const x=setup();await x.drain();
 assert.equal(x.d.querySelector('.attention'),null);
 const old=setup({apiVersion:43});await old.drain();
 assert.equal(old.requests('list_pip_attention').length,0);
});

test('a malformed list is refused whole, never half-shown',()=>{
 assert.throws(()=>attention.attentionPage(page([item('email','maildraft_nothex',PIP,'x')])));
 assert.throws(()=>attention.attentionPage({...page([]),total:-1}));
 assert.throws(()=>attention.attentionPage(page([item('email',DRAFT,'pip_x','x')])));
 // The CLI cuts text to 200 characters; an emoji is one of them, not two (one emoji refused the whole list).
 assert.equal(attention.attentionPage(page([item('email',DRAFT,PIP,'Send?',{detail:'🎉'+'x'.repeat(199)})])).items.length,1);
 const ok=attention.attentionPage(page([item('setup',SETUP,null,'Create the Pip “Max”?')]));
 assert.deepEqual(attention.attentionNavigation(ok.items[0]),{setup:SETUP,workspace:PW});
 assert.deepEqual(attention.attentionNavigation(attention.attentionPage(page([item('app_action',ACTION,PIP,'Send?')])).items[0]),
  {pip:PIP,workspace:PW,attention:true,section:'chat',reviewKind:'app_action',review:ACTION});
});

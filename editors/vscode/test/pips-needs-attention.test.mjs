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

function setup({found=page([]),apiVersion=44,links=[link],embedded=false,profiles={},proposal=null,saved=undefined}={}){
 let lastState=saved;
 // embedded: the side bar's Pips view (main.js mounts it in a shadow root and navigates it from the Sessions home).
 const dom=new JSDOM(embedded?'<!doctype html><html><body><div id="pips-host"></div></body></html>':viewModule.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;windows.push(w);
 const sent=[],answered=new Set();
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.CSS={escape:s=>s};
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>saved,setState:v=>{lastState=v;}});
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
 const pips=[pip(PIP,'Ava',{profile:profiles[PIP]}),pip(MAX,'Max',{profile:profiles[MAX]})];
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:proposal?.status==='pending'?[proposal]:[]}),get_pip_setup:()=>({setup:proposal}),reject_pip_setup:()=>{proposal.status='rejected';found.items=found.items.filter(i=>i.card!==proposal.id);found.total=found.items.length;found.by_pip={};return {setup:proposal};},
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
 return {w,d,app,sent,answer,requests,drain,click,state:()=>lastState};
}

// The Sessions home's "34 more need you · Show all" (reported 2026-10-18): from a Pip's chat or a search,
// the Pips home at Needs attention, open, with your Pips under it. One card in view there (asked 11 Nov: the list
// "gets too long"), and every one of them a dot or an arrow away.
test('Show all from the Sessions home opens the Pips home at Needs attention, open, one card in view',async()=>{
 const many=Array.from({length:9},(_,i)=>item('email','maildraft_'+String(i).repeat(32).slice(0,32).replace(/[^a-f0-9]/g,'0'),PIP,`Email ${i+1}`,{created_at:ago(i+1)}));
 const x=setup({found:page(many),embedded:true});await x.drain();
 x.click(`[data-job="${PIP}"]`);await x.drain();
 assert.equal(x.d.querySelector('.attention'),null,'a Pip\'s chat is open');
 const navigating=x.app.navigate({attention:true,all:true,workspace:PW});await x.drain();await navigating;
 assert.ok(x.d.querySelector('.simple-home'),'the Pips home, your Pips listed');
 assert.equal(x.d.querySelector('.attention-toggle').getAttribute('aria-expanded'),'true','Needs attention is open');
 assert.equal(x.d.querySelectorAll('.attention [data-attention]').length,1,'one card in view');
 assert.equal(x.d.querySelector('.attention-place').textContent,'1 of 9','and all nine are there to go to');
 assert.equal(x.d.querySelector('.attention-count').textContent,'9');
 assert.ok(x.d.querySelector('[data-attention-more="0"]'),'the section can be folded');
});

test('the home lists what every Pip waits on, newest first, above Your Pips; each Pip row counts its own',async()=>{
 const found=page([item('app_link',LINK,PIP,'Connect Gmail?',{detail:'To read your new mail.',created_at:ago(1)}),item('email',DRAFT,MAX,'Send this email to sam@example.test?',{detail:'Lunch moved',created_at:ago(30)}),
  item('computer_action',HELD,PIP,'Send this on shop.example?',{created_at:ago(90)})]);
 const x=setup({found});await x.drain();
 const section=x.d.querySelector('.attention');assert.ok(section,'Needs attention is on the home');
 assert.ok(section.compareDocumentPosition(x.d.querySelector('.simple-home'))&x.w.Node.DOCUMENT_POSITION_FOLLOWING,'above Your Pips');
 assert.match(section.querySelector('.attention-toggle').textContent,/Needs attention\s*3/);
 // Open when something is in it (his call, 11 Nov; it started folded).
 assert.equal(section.querySelector('.attention-toggle').getAttribute('aria-expanded'),'true','the list starts open');
 // One card in view; Next shows the one after it, newest first.
 const rows=[];for(let i=0;i<3;i++){const shown=x.d.querySelectorAll('.attention [data-attention]');assert.equal(shown.length,1,'one card in view');rows.push(shown[0].textContent);if(i<2)x.click('#attention-next');}
 assert.equal(x.d.querySelector('#attention-next').disabled,true,'the last of three');
 assert.match(rows[0],/Connect Gmail\?To read your new mail\.Ava · App · 1 min ago/);
 assert.match(rows[1],/Send this email to sam@example\.test\?Lunch movedMax · Email · 30 min ago/);
 assert.match(rows[2],/Send this on shop\.example\?Ava · Its computer · 1 h ago/);
 assert.match(x.d.querySelector(`[data-job="${PIP}"]`).textContent,/2 waiting for you/);
 assert.match(x.d.querySelector(`[data-job="${MAX}"]`).textContent,/1 waiting for you/);
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('list_pip_attention')[0].request)),{type:'list_pip_attention',limit:100});
});

test('Needs attention uses the current saved face without recolouring its accessories',async()=>{
 const found=page([item('app_link',LINK,PIP,'Connect Gmail?')]);
 const x=setup({found,profiles:{[PIP]:{title:'',body:'quill',color:'lens',notify:true}}});await x.drain();
 const face=x.d.querySelector(`[data-attention="app_link:${LINK}"] .avatar`);
 assert.equal(face?.dataset.character,'quill');
 assert.equal(face?.dataset.tint,undefined,'legacy colour data does not recolour the face or accessories');
});

test('dismissing a proposed Pip checks its fresh digest, rejects it, then removes its attention row',async()=>{
 const proposal={id:SETUP,digest:'a'.repeat(64),workspace_id:PW,project_root:'/private/pips',pip_id:null,name:'Blog writer',goal:'Draft a post for review.',pip_type:'scout',work_kind:'personal_task',source_ref:'HEAD',schedule:null,run_now:false,next_run_at:null,status:'pending',created_at:'2099-10-02T04:00:00Z',expires_at:'2099-10-02T06:00:00Z',receipt:null,reason:'Draft posts.',expected_version:null,expected_lifecycle_revision:null,permissions:'read_only',source_policy:'personal',runner_notice:'Runs only while Pips are on.',scope_notice:'Reads only what you share.',run_now_policy:null};
 const found=page([item('setup',SETUP,null,'Create the Pip “Blog writer”?')]);
 const x=setup({found,proposal});await x.drain();
 assert.equal(x.d.querySelector('.attention-toggle').getAttribute('aria-expanded'),'true');
 assert.equal(x.requests('reject_pip_setup').length,0);
 // Reject is held a moment so it can be undone (his call, 11 Nov): the card goes at once, the reject is sent after.
 const held=[],later=x.w.setTimeout.bind(x.w);x.w.setTimeout=(fn,ms,...a)=>ms===6000?(held.push(fn),900000+held.length):later(fn,ms,...a);
 x.click(`[data-attention-dismiss="setup:${SETUP}"]`);await x.drain();
 assert.equal(x.requests('reject_pip_setup').length,0,'not sent yet');
 assert.equal(x.d.querySelector(`[data-setup-card="${SETUP}"]`),null,'the card is gone at once');
 assert.match(x.d.querySelector('.undo-reject')?.textContent||'',/Rejected\. No Pip was created\. Undo/);
 held.splice(0).forEach(fn=>fn());await x.drain();
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('reject_pip_setup')[0].request)),{type:'reject_pip_setup',setup_id:SETUP,expected_digest:proposal.digest});
 assert.equal(x.d.querySelector('.attention'),null,'the rejected proposal no longer needs attention');
 assert.equal(x.requests('accept_pip_setup').length,0);
});

// A new Pip waiting for you (asked 11 Nov): the Pips page showed it twice, in a section above the list ("1 new Pip waiting
// for you") and as a row in Needs attention. It shows once now, as a card in Needs attention, and every way there
// (the Sessions home's link, another surface's "a new Pip is waiting") lands on that card, the list opened to show it.
test('a new Pip waiting shows once, as a card in Needs attention, and a link to it from elsewhere lands on that card',async()=>{
 const proposal={id:SETUP,digest:'a'.repeat(64),workspace_id:PW,project_root:'/private/pips',pip_id:null,name:'Blog writer',goal:'Draft a post for review.',pip_type:'scout',work_kind:'personal_task',source_ref:'HEAD',schedule:null,run_now:false,next_run_at:null,status:'pending',created_at:'2099-10-02T04:00:00Z',expires_at:'2099-10-02T06:00:00Z',receipt:null,reason:'Draft posts.',expected_version:null,expected_lifecycle_revision:null,permissions:'read_only',source_policy:'personal',runner_notice:'Runs only while Pips are on.',scope_notice:'Reads only what you share.',run_now_policy:null};
 const many=Array.from({length:7},(_,i)=>item('email','maildraft_'+String(i).repeat(32).slice(0,32).replace(/[^a-f0-9]/g,'0'),PIP,`Email ${i+1}`,{created_at:ago(i+1)}));
 const found=page([...many,item('setup',SETUP,null,'Create the Pip “Blog writer”?',{created_at:ago(30),detail:'Draft a post for review.'})]);
 const x=setup({found,proposal,embedded:true});await x.drain();
 assert.equal(x.d.querySelector('.setup-inbox,.setup-card,.setup-inbox-toggle'),null,'no section above the list');
 assert.doesNotMatch(x.d.querySelector('.pip-app-root').textContent,/new Pips? waiting for you/);
 assert.equal(x.d.querySelector('.attention-count').textContent,'8','counted once, with what else waits');
 x.click(`[data-job="${PIP}"]`);await x.drain();
 const navigating=x.app.navigate({setup:SETUP,workspace:PW});await x.drain();await navigating;
 const card=x.d.querySelector(`.attention [data-setup-card="${SETUP}"]`);
 assert.ok(card,'the list opened to its card, though it is the oldest of eight');
 assert.equal(x.d.querySelectorAll('[data-setup-card]').length,1,'once');
 assert.equal(card.querySelector('.dgc-card-title').textContent,'Create the Pip “Blog writer”?');
 assert.equal(card.querySelector('.dgc-card-sub').textContent,'Draft a post for review.');
 assert.deepEqual([...card.querySelectorAll('.dgc-chip:not(.dgc-chip-more)')].map(c=>c.textContent),['Scout','Personal','Only when you ask']);
 assert.deepEqual([...card.querySelectorAll('.dgc-card-actions > button')].map(b=>b.textContent),['Review','Reject']);
 assert.equal(x.d.activeElement,card.querySelector('[data-setup]'),'the keyboard is on Review');
 assert.equal(x.d.querySelector(`.attention-row[data-attention="setup:${SETUP}"]`),null,'not a second row beside its card');
 x.click(`[data-setup="${SETUP}"]`);await x.drain();
 assert.match(x.d.querySelector('[role=dialog]').textContent,/Create Blog writer\?/,'Review opens its full details, as before');
});

test('a row opens its Pip at the card: the chat scrolls to the Connect card; a held submit opens its computer',async()=>{
 const found=page([item('app_link',LINK,PIP,'Connect Gmail?'),item('computer_action',HELD,PIP,'Send this on shop.example?')]);
 const x=setup({found});await x.drain();
 x.click(`[data-attention="app_link:${LINK}"]`);await x.drain();
 const card=x.d.querySelector(`[data-app-link="${LINK}"]`);assert.ok(card,'Ava’s chat is open with the card');
 assert.ok(card.classList.contains('attention-flash'),'the card is shown to you');
 assert.equal(x.d.activeElement?.textContent,'Link Gmail','its first button takes focus');
 x.click('#simple-back');await x.drain();
 x.click('#attention-next');
 x.click(`[data-attention="computer_action:${HELD}"]`);await x.drain();
 assert.ok(x.sent.some(m=>m.type==='pipsOpenComputer'&&m.pip.id===PIP),'its computer opens, where the held submit waits');
});

// Asked 11 Nov: "the need attention gets too long ... just one card, with dots below and arrows on left and right, so
// user can switch them and go next or back, but it always remains 1 card in the view". It showed six, then "Show all 9".
test('a long list is one card in view: arrows and dots go to the others, and there is no Show all',async()=>{
 const many=Array.from({length:9},(_,i)=>item('email','maildraft_'+String(i).repeat(32).slice(0,32).replace(/[^a-f0-9]/g,'0'),PIP,`Email ${i+1}`,{created_at:ago(i+1)}));
 const x=setup({found:page(many)});await x.drain();
 const shown=()=>[...x.d.querySelectorAll('[data-attention]')].map(b=>b.querySelector('strong').textContent),place=()=>x.d.querySelector('.attention-place').textContent;
 assert.deepEqual(shown(),['Email 1'],'open, one card');assert.equal(place(),'1 of 9');
 assert.equal(x.d.querySelector('.attention-more,[data-attention-more="2"]'),null,'no Show all');
 assert.equal(x.d.querySelector('.attention-count').textContent,'9','the header still counts them all');
 assert.equal(x.d.querySelector('#attention-prev').disabled,true,'nothing before the first');
 assert.equal(x.d.querySelector('#attention-next').getAttribute('aria-label'),'Next: Email 2');
 x.click('#attention-next');assert.deepEqual(shown(),['Email 2']);assert.equal(place(),'2 of 9');
 assert.equal(x.d.querySelector('#attention-prev').getAttribute('aria-label'),'Previous: Email 1');
 assert.equal(x.d.querySelectorAll('.attention-dot').length,7,'nine cards: a window of seven dots');
 assert.equal(x.d.querySelector('.attention-dot[aria-current]').getAttribute('aria-label'),'Card 2 of 9: Email 2');
 x.click('#attention-dot-5');assert.deepEqual(shown(),['Email 6']);assert.equal(place(),'6 of 9');
 x.click('#attention-prev');assert.deepEqual(shown(),['Email 5']);
 const key=k=>x.d.querySelector('#attention-next').dispatchEvent(new x.w.KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));
 key('End');assert.deepEqual(shown(),['Email 9']);assert.equal(x.d.querySelector('#attention-next').disabled,true,'nothing after the last');
 key('ArrowRight');assert.deepEqual(shown(),['Email 9'],'never round to the first');
 x.d.querySelector('.attention-dot[aria-current]').dispatchEvent(new x.w.KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));assert.deepEqual(shown(),['Email 1']);
 x.click('[data-attention-more="0"]');assert.equal(x.d.querySelectorAll('[data-attention]').length,0,'folded: no card');
 assert.equal(x.d.querySelector('.attention-place,.attention-dot,.attention-nav'),null,'and no arrows or dots');
});

test('the card you are on stays as cards come and go: a new one moves nothing, an answered one gives its place to the next',async()=>{
 const card=(n,min)=>item('email','maildraft_'+n.repeat(32),PIP,`Email ${n}`,{created_at:ago(min)});
 const found=page([card('a',1),card('b',2),card('c',3)]);
 const x=setup({found});await x.drain();
 const shown=()=>[...x.d.querySelectorAll('[data-attention]')].map(b=>b.querySelector('strong').textContent),place=()=>x.d.querySelector('.attention-place')?.textContent;
 const read=async items=>{found.items=items;found.total=items.length;x.w.dispatchEvent(new x.w.MessageEvent('message',{data:{type:'pipSetupChanged'}}));await x.drain();};
 x.click('#attention-next');assert.deepEqual(shown(),['Email b']);
 await read([card('d',0),card('a',1),card('b',2),card('c',3)]);
 assert.deepEqual(shown(),['Email b'],'a new card came in: still on the card you were on');assert.equal(place(),'3 of 4');
 assert.equal(x.d.querySelector('.attention-count').textContent,'4');
 await read([card('d',0),card('a',1),card('c',3)]);
 assert.deepEqual(shown(),['Email c'],'it was answered: the next card, in its place');assert.equal(place(),'3 of 3');
 await read([card('d',0),card('a',1)]);
 assert.deepEqual(shown(),['Email a'],'the last was answered: the one before it');assert.equal(place(),'2 of 2');
 await read([card('d',0)]);
 assert.deepEqual(shown(),['Email d']);assert.equal(place(),undefined,'one card: no arrows, dots or count');
 assert.equal(x.d.querySelector('.attention-nav,.attention-dot'),null);
 await read([]);assert.equal(x.d.querySelector('.attention'),null,'nothing waiting: no section');
});

test('the dots: one each up to seven, then a window of seven around the current one, smaller at an end with more beyond',()=>{
 const dots=(n,at)=>attention.attentionDots(n,at).map(d=>`${d.index}${d.current?'*':''}${d.size?':'+d.size:''}`).join(' ');
 assert.equal(dots(1,0),'0*');assert.equal(dots(3,1),'0 1* 2');assert.equal(dots(7,6),'0 1 2 3 4 5 6*');
 assert.equal(dots(12,0),'0* 1 2 3 4 5:near 6:far');
 assert.equal(dots(12,3),'0 1 2 3* 4 5:near 6:far');
 assert.equal(dots(12,5),'2:far 3:near 4 5* 6 7:near 8:far');
 assert.equal(dots(12,11),'5:far 6:near 7 8 9 10 11*');
 assert.equal(dots(100,99).split(' ').length,7,'never more than seven');
 // Which card shows: the one you were on; gone, the one in its place; past the end, the last.
 assert.equal(attention.attentionSpot(['a','b','c'],'b',0),1);assert.equal(attention.attentionSpot(['a','c'],'b',1),1);
 assert.equal(attention.attentionSpot(['a'],'b',1),0);assert.equal(attention.attentionSpot(['a','b'],'',0),0);
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

test('a Personal Pip’s waiting reviews come beside the cards: newest first, each with where it opens',()=>{
 const HANDOFF='handoff_'+'a'.repeat(32),PROPOSAL='proposal_1',newer='2026-11-07T10:00:00Z',older='2026-11-07T09:00:00Z';
 const value=page([item('email',DRAFT,PIP,'Send?',{created_at:older})]);
 const listed=attention.attentionPage({...value,total:3,reviews:[item('handoff',HANDOFF,PIP,'Hand this to Max?',{created_at:newer}),item('approval',PROPOSAL,PIP,'Change Max?',{created_at:older,review:'schedule_update'})]});
 assert.equal(listed.total,3);assert.equal(listed.listsReviews,true);
 assert.deepEqual(listed.items.map(i=>i.kind),['handoff','email','approval']);
 assert.deepEqual(attention.attentionNavigation(listed.items[0]),{pip:PIP,workspace:PW,attention:true,section:'handoffs',reviewKind:'handoff',review:HANDOFF});
 assert.deepEqual(attention.attentionNavigation(listed.items[2]),{pip:PIP,workspace:PW,attention:true,section:'revisions',reviewKind:'schedule_update',review:PROPOSAL});
 assert.equal(attention.attentionPage(value).listsReviews,false,'a DGC from before lists none');
 assert.throws(()=>attention.attentionPage(page([item('handoff',HANDOFF,PIP,'Hand this?')])),'a card kind stays one of the kinds');
 assert.throws(()=>attention.attentionPage({...value,total:2,reviews:[item('handoff','nope',PIP,'x')]}));
});

// Needs attention opens when something is in it; folded by you, it stays folded until something new arrives, and an
// Undo takes a held Reject back (his calls, 11 Nov).
test('folded by you, Needs attention stays folded until something new comes in',async()=>{
 const one=item('app_link',LINK,PIP,'Connect Gmail?',{created_at:ago(5)}),two=item('email',DRAFT,MAX,'Send this email?',{created_at:ago(1)});
 const x=setup({found:page([one])});await x.drain();
 assert.equal(x.d.querySelector('.attention-toggle').getAttribute('aria-expanded'),'true','open when something is in it');
 x.click('[data-attention-more="0"]');
 assert.equal(x.d.querySelector('.attention-toggle').getAttribute('aria-expanded'),'false','you folded it');
 assert.deepEqual(JSON.parse(JSON.stringify(x.state().attention_folded)),[`app_link:${LINK}`],'what was in it is kept with the view');
 // Back later, the same things waiting: still folded.
 const same=setup({found:page([one]),saved:x.state()});await same.drain();
 assert.equal(same.d.querySelector('.attention-toggle').getAttribute('aria-expanded'),'false','the same things: still folded');
 // Something new came in meanwhile: it opens again.
 const more=setup({found:page([two,one]),saved:x.state()});await more.drain();
 assert.equal(more.d.querySelector('.attention-toggle').getAttribute('aria-expanded'),'true','something new: open again');
 assert.deepEqual(JSON.parse(JSON.stringify(more.state()?.attention_folded||[])),[],'and the fold is forgotten');
});

test('Undo on a held Reject keeps the new Pip and sends nothing',async()=>{
 const proposal={id:SETUP,digest:'a'.repeat(64),workspace_id:PW,project_root:'/private/pips',pip_id:null,name:'Blog writer',goal:'Draft a post for review.',pip_type:'scout',work_kind:'personal_task',source_ref:'HEAD',schedule:null,status:'pending'};
 const x=setup({found:page([item('setup',SETUP,null,'Create the Pip “Blog writer”?')]),proposal});await x.drain();
 const held=[],later=x.w.setTimeout.bind(x.w),cleared=[];x.w.setTimeout=(fn,ms,...a)=>ms===6000?(held.push(fn),900000+held.length):later(fn,ms,...a);
 const clear=x.w.clearTimeout.bind(x.w);x.w.clearTimeout=id=>{cleared.push(id);clear(id);};
 x.click(`[data-attention-dismiss="setup:${SETUP}"]`);await x.drain();
 x.click('[data-undo-reject]');await x.drain();
 assert.ok(cleared.includes(900001),'the held reject is called off');
 assert.ok(x.d.querySelector(`[data-setup-card="${SETUP}"]`),'its card is back');
 assert.equal(x.requests('reject_pip_setup').length,0,'nothing was sent');
});

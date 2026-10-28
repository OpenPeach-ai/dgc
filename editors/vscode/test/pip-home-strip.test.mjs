import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {JSDOM} from 'jsdom';

// The Sessions home's Pips strip (pipHomeStrip.js): reported 2026-10-18, "my 3 Pips ran and failed ...
// there should be a dismiss option there too", and "what if there were 100 Pips". The 3 most urgent rows,
// then "N more need you · Show all"; news rows (failed runs, new findings) dismiss for good (Pips API 48).
const bundle=buildSync({entryPoints:[new URL('../src/pipHomeStrip.js',import.meta.url).pathname],bundle:true,write:false,format:'iife',globalName:'Strip',loader:{'.css':'empty'}}).outputFiles[0].text;
const P='ws_'+'1'.repeat(32), Q='ws_'+'2'.repeat(32);
const id=n=>'pip_'+n.toString(16).padStart(32,'0');
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const pip=(n,name,extra={})=>({id:id(n),name,pip_type:n===0?'core':'scout',workspace_id:P,status:'active',pending_review_count:0,version:1,...extra});
const news=(n,name,extra={})=>({pip_id:id(n),workspace_id:P,name,pip_type:n===0?'core':'scout',scope:'personal',status:'active',min_severity:'low',alert_severity:'high',
 runs:{succeeded:0,failed:0,cancelled:0},skipped_unchanged:0,new_total:0,below_threshold:0,new_findings:[],gone_after_change:0,alert:false,latest_run_id:null,...extra});
const failed=(n,name,k=1)=>news(n,name,{runs:{succeeded:0,failed:k,cancelled:0}});
const found=(n,name,k=2,extra={})=>news(n,name,{new_total:k,...extra});
const digest=(pips,extra={})=>({schema_version:1,since:'2026-10-18T00:00:00.000Z',until:'2026-10-18T09:00:00.000Z',first:false,due:false,reason:null,
 headline:'Your Pips',pips,omitted_pips:0,failed_runs:0,pending_reviews:0,pending_setups:0,truncated:false,...extra});

// A home with `list` Pips and a backend that answers from `state` (changed between polls by the test).
function harness(t,state,{api=48}={}){
 const dom=new JSDOM('<main><section id="sessions-pips" class="home-pips" hidden></section><button id="after">after</button></main>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
 w.eval(bundle+';window.Strip=Strip;');
 const sent=[],opened=[],timers=[],held=[];
 const answers={list_workspaces:()=>({workspaces:[{id:P,name:'Your Pips',kind:'personal'},{id:Q,name:'demo',kind:'project'}],current_workspace_id:Q}),
  list_pips:r=>({pips:r.workspace_id===P?state.list:[],total:r.workspace_id===P?state.list.length:0,next_offset:null}),
  get_pip_digest:()=>({digest:state.digest}),
  list_pip_attention:()=>state.attention||{total:0,items:[],truncated:false,counts:{},by_pip:{}}};
 let strip;
 const reply=(m,ok,result)=>strip.receive({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});
 strip=w.Strip.mountHomePips({document:w.document,root:w.document.getElementById('sessions-pips'),
  postMessage:m=>{sent.push(m);if(m.type!=='pipsRequest')return;
   if(m.request.type==='mark_pip_news_seen'){if(state.hold)held.push(m);else queueMicrotask(()=>reply(m,state.refuse!==true,state.refuse?'Refused':{seen:m.request.pip_ids.map(pip_id=>({pip_id,seen_until:m.request.until}))}));return;}
   const make=answers[m.request.type];if(make)queueMicrotask(()=>reply(m,true,make(m.request)));},
  onOpen:v=>opened.push(v),setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval:()=>{}});
 t.after(()=>{strip.dispose();w.close();});
 const d=w.document;
 const rows=()=>[...d.querySelectorAll('.home-pip-item')].map(li=>[li.querySelector('strong').textContent,li.querySelector('small').textContent,!!li.querySelector('.home-pip-dismiss')]);
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const connect=async()=>{strip.receive({type:'pipsConnection',generation:1,connected:true,supported:true,enabled:true,apiVersion:api});await flush();};
 const poll=async()=>{timers[0]();await flush();};
 return {w,d,strip,sent,opened,held,rows,requests,connect,poll,reply,more:()=>d.querySelector('.home-pips-more')?.textContent??null};
}

test('a dismiss is on news rows only, says what it dismisses, and needs Pips API 48',async t=>{
 const state={list:[pip(1,'ERP daily audit',{pending_review_count:2}),pip(2,'GST watchdog'),pip(3,'Morning review')],
  digest:digest([failed(2,'GST watchdog'),found(3,'Morning review',2)])};
 const x=harness(t,state);await x.connect();
 assert.deepEqual(x.rows(),[['ERP daily audit','2 waiting for you',false],['GST watchdog','1 run failed',true],['Morning review','2 new findings',true]],
  'waiting for you needs an answer: no dismiss');
 const dismiss=[...x.d.querySelectorAll('.home-pip-dismiss')];
 assert.deepEqual(dismiss.map(b=>b.getAttribute('aria-label')),['Dismiss: GST watchdog — 1 run failed','Dismiss: Morning review — 2 new findings']);
 assert.ok(dismiss.every(b=>b.tagName==='BUTTON'&&b.type==='button'&&b.tabIndex===0&&!b.closest('.home-pip-row')),'its own button, in the tab order, never inside the row button');
 const old=harness(t,state,{api:47});await old.connect();
 assert.deepEqual(old.rows().map(r=>r[2]),[false,false,false],'an older DGC has nothing to keep it: no dismiss');
 assert.equal(old.d.querySelector('.home-pips-dismiss-all'),null);
});

test('dismissing sends the digest\'s time, removes the row at once, stays gone on the next poll, and a new failure brings it back',async t=>{
 const state={list:[pip(1,'ERP daily audit'),pip(2,'GST watchdog')],digest:digest([failed(1,'ERP daily audit'),failed(2,'GST watchdog')])};
 const x=harness(t,state);await x.connect();
 state.hold=true;
 x.d.querySelector('.home-pip-dismiss').click();
 assert.deepEqual(x.rows(),[['GST watchdog','1 run failed',true]],'gone before DGC answers');
 const [mark]=x.requests('mark_pip_news_seen');
 assert.deepEqual(JSON.parse(JSON.stringify(mark.request)),{type:'mark_pip_news_seen',pip_ids:[id(1)],until:'2026-10-18T09:00:00.000Z'});
 await x.poll();                                    // a digest asked before DGC kept it still names the Pip
 assert.deepEqual(x.rows().map(r=>r[0]),['GST watchdog'],'no flicker back from a digest asked before the dismiss was kept');
 x.reply(mark,true,{seen:[{pip_id:id(1),seen_until:mark.request.until}]});await flush();
 state.digest=digest([failed(2,'GST watchdog')],{until:'2026-10-18T09:01:00.000Z'});
 await x.poll();
 assert.deepEqual(x.rows().map(r=>r[0]),['GST watchdog'],'the next poll does not bring it back');
 state.digest=digest([failed(1,'ERP daily audit'),failed(2,'GST watchdog')],{until:'2026-10-18T10:00:00.000Z'});
 await x.poll();
 assert.deepEqual(x.rows(),[['ERP daily audit','1 run failed',true],['GST watchdog','1 run failed',true]],'something new comes back');
});

test('a dismiss DGC refuses puts the row back and says so',async t=>{
 const state={list:[pip(1,'ERP daily audit')],digest:digest([failed(1,'ERP daily audit')]),refuse:true};
 const x=harness(t,state);await x.connect();
 x.d.querySelector('.home-pip-dismiss').click();await flush();
 assert.deepEqual(x.rows().map(r=>r[0]),['ERP daily audit']);
 assert.equal(x.d.querySelector('.home-pips-error').textContent,'That didn’t dismiss. Try again.');
 assert.equal(x.d.querySelector('.home-pips-error').getAttribute('role'),'status');
});

test('Dismiss all dismisses every news row, also past the top 3, and leaves what waits for you',async t=>{
 const list=[pip(1,'Approvals',{pending_review_count:1}),...[2,3,4,5,6].map(n=>pip(n,`Audit ${n}`))];
 const state={list,digest:digest([2,3,4,5,6].map(n=>failed(n,`Audit ${n}`)))};
 const x=harness(t,state);await x.connect();
 assert.equal(x.rows().length,3);
 assert.equal(x.more(),'3 more need you · Show all');
 const all=x.d.querySelector('.home-pips-dismiss-all');
 assert.equal(all.textContent,'Dismiss all');
 all.click();await flush();
 const [mark]=x.requests('mark_pip_news_seen');
 assert.deepEqual([...mark.request.pip_ids],[2,3,4,5,6].map(id),'one request for all five, the two hidden past the top 3 too');
 assert.deepEqual(x.rows(),[['Approvals','1 waiting for you',false]]);
 assert.equal(x.more(),null,'nothing more needs you: the line goes');
 assert.equal(x.d.querySelector('.home-pips-dismiss-all'),null,'one row left that waits: no Dismiss all');
 const one=harness(t,{list:[pip(2,'Audit 2')],digest:digest([failed(2,'Audit 2')])});await one.connect();
 assert.equal(one.d.querySelector('.home-pips-dismiss-all'),null,'one news row: its own ✕ is enough');
});

test('the last row dismissed leaves the quiet row of faces',async t=>{
 const state={list:[pip(0,'Core'),pip(1,'ERP daily audit')],digest:digest([failed(1,'ERP daily audit')])};
 const x=harness(t,state);await x.connect();
 x.d.querySelector('.home-pip-dismiss').click();await flush();
 assert.equal(x.d.querySelectorAll('.home-pip-item').length,0);
 assert.equal(x.d.querySelector('.home-pips-quiet-text').textContent,'All quiet. Nothing is waiting for you.');
 assert.deepEqual([...x.d.querySelectorAll('.home-pip-face-button')].map(b=>b.getAttribute('aria-label')),['Open Core','Open ERP daily audit']);
});

test('keyboard: the dismissed row\'s place goes to the next row, and focus to its dismiss',async t=>{
 const state={list:[1,2,3,4].map(n=>pip(n,`Audit ${n}`)),digest:digest([1,2,3,4].map(n=>failed(n,`Audit ${n}`)))};
 const x=harness(t,state);await x.connect();
 const second=x.d.querySelectorAll('.home-pip-dismiss')[1];second.focus();
 assert.equal(x.d.activeElement,second);
 second.click();                                    // Enter or Space on a button is its click
 assert.deepEqual(x.rows().map(r=>r[0]),['Audit 1','Audit 3','Audit 4'],'the fourth pulled up into the top 3');
 assert.equal(x.d.activeElement,x.d.querySelectorAll('.home-pip-dismiss')[1],'focus stays at the same place, on Audit 3\'s dismiss');
 assert.equal(x.more(),null);
 for(let i=0;i<3;i++)x.d.querySelector('.home-pip-dismiss').click();
 await flush();
 assert.equal(x.d.activeElement,x.d.querySelector('.home-pips-open'),'with no row left, focus is on Open Pips, never lost');
});

test('the 3 most urgent: waiting for you, then alerts, then failed runs, then new findings; then N more · Show all',async t=>{
 // Listed in the Pips view's order, Core first, the most urgent last.
 const list=[pip(0,'Core'),pip(1,'Finds'),pip(2,'Fails'),pip(3,'Alerts'),pip(4,'Waits',{pending_review_count:3}),pip(5,'Fails too'),pip(6,'Quiet')];
 const state={list,digest:digest([found(3,'Alerts',1,{alert:true}),failed(2,'Fails'),failed(5,'Fails too',2),found(1,'Finds',4),found(0,'Core',1),
  news(6,'Quiet',{runs:{succeeded:3,failed:0,cancelled:0}})])};
 const x=harness(t,state);await x.connect();
 assert.deepEqual(x.rows(),[['Waits','3 waiting for you',false],['Alerts','1 new, worth a look now',true],['Fails','1 run failed',true]]);
 assert.equal(x.more(),'3 more need you · Show all','Fails too, Core and Finds; Quiet only ran, so it does not need you');
 const more=x.d.querySelector('.home-pips-more');
 assert.equal(more.tagName,'BUTTON');assert.equal(more.title,'Open Needs attention in the Pips view');
 more.click();
 assert.deepEqual(JSON.parse(JSON.stringify(x.opened.at(-1))),{attention:true,all:true,workspace:P},'Show all opens the Pips view at Needs attention, in your Personal Pips');
 x.d.querySelectorAll('.home-pip-dismiss')[1].click();await flush();
 assert.deepEqual(x.rows().map(r=>r[0]),['Waits','Alerts','Fails too'],'dismissing one of the top 3 pulls the next one up');
 assert.equal(x.more(),'2 more need you · Show all','and the count follows');
 for(const label of ['Fails too','Core'])[...x.d.querySelectorAll('.home-pip-item')].find(li=>li.querySelector('strong').textContent===label).querySelector('.home-pip-dismiss').click();
 await flush();
 assert.deepEqual(x.rows().map(r=>r[0]),['Waits','Alerts','Finds']);
 assert.equal(x.more(),null,'nothing more needs you: no line');
});

test('one Pip with failed runs and new findings says both, as a failure',async t=>{
 const x=harness(t,{list:[pip(1,'Finds'),pip(2,'Both')],digest:digest([found(1,'Finds',1),news(2,'Both',{runs:{succeeded:1,failed:1,cancelled:0},new_total:2})])});await x.connect();
 assert.deepEqual(x.rows(),[['Both','1 run failed · 2 new findings',true],['Finds','1 new finding',true]]);
 assert.equal(x.d.querySelector('.home-pip-dismiss').getAttribute('aria-label'),'Dismiss: Both — 1 run failed · 2 new findings','the label says everything it dismisses');
});

test('100 Pips: past the digest\'s 20 the count says it may be more, and a Pip past the first page of 100 still gets its row',async t=>{
 const list=Array.from({length:100},(_,n)=>pip(n+1,`Pip ${n+1}`));
 const twenty=Array.from({length:20},(_,n)=>failed(n+1,`Pip ${n+1}`));
 const x=harness(t,{list,digest:digest(twenty,{omitted_pips:17})});await x.connect();
 assert.equal(x.rows().length,3);
 assert.equal(x.more(),'17+ more need you · Show all','the digest left out 17 Pips after 20 with news: more may need you');
 const beyond=harness(t,{list:list.slice(0,2),digest:digest([failed(150,'Past the first page')])});await beyond.connect();
 assert.deepEqual(beyond.rows(),[['Past the first page','1 run failed',true]],'named from the digest itself');
});

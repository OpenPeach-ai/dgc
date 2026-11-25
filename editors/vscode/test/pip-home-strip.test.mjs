import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {JSDOM} from 'jsdom';

// Your Pips on the side bar's Home (pipHomeStrip.js): which of them need you and which have news, as cards the hub draws
// (media/shared/hub.js; side-tabs-home.test.mjs holds the drawing). This file holds what is true and what an answer
// does: one card for each Pip, the most urgent first (reported 2026-10-18, "my 3 Pips ran and failed ... there should be
// a dismiss option there too"); news (failed runs, new findings) dismisses for good (Pips API 48); Mark read clears a
// Pip's messages and its finished-run news together; Clear does all of it; a new Pip that waits is a card of its own.
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
 const dom=new JSDOM('<main></main>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
 w.eval(bundle+';window.Strip=Strip;');
 const sent=[],opened=[],timers=[],held=[],models=[];
 const answers={list_workspaces:()=>({workspaces:[{id:P,name:'Your Pips',kind:'personal'},{id:Q,name:'demo',kind:'project'}],current_workspace_id:Q}),
  list_pips:r=>({pips:r.workspace_id===P?state.list:(state.projectList||[]),total:r.workspace_id===P?state.list.length:(state.projectList||[]).length,next_offset:null}),
  get_pip_digest:()=>({digest:state.digest}),
  list_pip_unread:r=>({workspace_id:r.workspace_id,pips:r.workspace_id===P?(state.unread||[]):(state.projectUnread||[]),total:(r.workspace_id===P?(state.unread||[]):(state.projectUnread||[])).reduce((n,p)=>n+p.count,0)}),
  list_pip_attention:()=>state.attention||{total:0,items:[],truncated:false,counts:{},by_pip:{}}};
 let strip;
 const reply=(m,ok,result)=>strip.receive({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});
 strip=w.Strip.mountHomePips({document:w.document,
  postMessage:m=>{sent.push(m);if(m.type!=='pipsRequest')return;
   if(m.request.type==='mark_pip_news_seen'){
    if(state.hold)held.push(m);
    else queueMicrotask(()=>{
     if(!state.refuse) state.digest={...state.digest,pips:state.digest.pips.filter(row=>!m.request.pip_ids.includes(row.pip_id))};
     reply(m,state.refuse!==true,state.refuse?'Refused':{seen:m.request.pip_ids.map(pip_id=>({pip_id,seen_until:m.request.until}))});
    });
    return;
   }
   if(m.request.type==='mark_pip_read'){
    if(!state.refuseRead){state.unread=(state.unread||[]).filter(row=>row.pip_id!==m.request.pip_id);state.projectUnread=(state.projectUnread||[]).filter(row=>row.pip_id!==m.request.pip_id);}
    queueMicrotask(()=>reply(m,!state.refuseRead,state.refuseRead?'Read refused':{pip_id:m.request.pip_id}));return;
   }
   if(m.request.type==='list_pip_unread'&&state.unreadFail){queueMicrotask(()=>reply(m,false,'Unread updates unavailable.'));return;}
   if(m.request.type==='list_workspaces'&&state.workspacesFail){queueMicrotask(()=>reply(m,false,'The personal workspace binding changed.'));return;}
   if(m.request.type==='list_pip_attention'&&state.attentionFail){queueMicrotask(()=>reply(m,false,'No reply from DGC.'));return;}
   if(m.request.type==='get_pip_digest'&&state.digestFail){queueMicrotask(()=>reply(m,false,'No reply from DGC.'));return;}
   const make=answers[m.request.type];if(make)queueMicrotask(()=>reply(m,true,make(m.request)));},
  onOpen:v=>opened.push(JSON.parse(JSON.stringify(v))),onModel:m=>models.push(JSON.parse(JSON.stringify(m))),setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval:()=>{}});
 t.after(()=>{strip.dispose();w.close();});
 const model=()=>models.at(-1)||null;
 const cards=()=>model()?.cards||[];
 // Each card as a row said it: the Pip's name, its few words, and whether it can be dismissed.
 const rows=()=>cards().map(c=>[c.name,c.line,c.canDismiss]);
 const card=name=>cards().find(c=>c.name===name);
 const key=n=>`pip:${id(n)}`;
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const connect=async()=>{strip.receive({type:'pipsConnection',generation:1,connected:true,supported:true,enabled:true,apiVersion:api});await flush();};
 const poll=async()=>{timers[0]();await flush();};
 return {w,strip,sent,opened,held,models,model,cards,rows,card,key,requests,connect,poll,reply};
}

test('it draws nothing itself: what it knows is a model, and before DGC answers the model says it is not ready',async t=>{
 const state={list:[pip(1,'Daily check')],digest:digest([])};
 const x=harness(t,state);
 assert.equal(x.model(),null,'nothing said before a connection');
 x.strip.receive({type:'pipsConnection',generation:1,connected:false,supported:true,enabled:true,apiVersion:48});
 assert.deepEqual([x.model().ready,x.model().cards],[false,[]]);
 await x.connect();
 assert.deepEqual([x.model().ready,x.model().cards,x.model().need,x.model().fresh],[true,[],0,0],'a quiet Pip is no card');
 assert.deepEqual(x.model().pips.map(p=>p.name),['Daily check'],'your Pips are still named, for the dock');
 assert.equal(x.w.document.querySelector('main').childElementCount,0,'nothing is drawn by this file');
});
test('latest unread routine results are cards, newest first, even with no findings',async t=>{
 const state={list:[pip(1,'Daily check'),pip(2,'Mail watch')],digest:digest([]),unread:[
  {pip_id:id(2),workspace_id:P,name:'Mail watch',pip_type:'scout',count:2,latest:'No new mail since the last check.',latest_at:'2026-11-01T10:00:00Z'},
  {pip_id:id(1),workspace_id:P,name:'Daily check',pip_type:'scout',count:1,latest:'Everything passed.',latest_at:'2026-11-01T09:00:00Z'}]};
 const x=harness(t,state,{api:69});await x.connect();
 assert.deepEqual([x.model().need,x.model().fresh],[0,3],'something to read is new, not a number that needs you');
 assert.deepEqual(x.rows().map(r=>r.slice(0,2)),[['Mail watch','No new mail since the last check.'],['Daily check','Everything passed.']]);
 assert.deepEqual(x.cards().map(c=>[c.group,c.kind,c.scope,c.title,c.chips,c.canRead]),[['new','unread','personal','No new mail since the last check.',['2 new'],true],['new','unread','personal','Everything passed.',['1 new'],true]]);
 assert.equal(x.card('Mail watch').at,'2026-11-01T10:00:00Z','a card says when');
 x.strip.open(x.key(2));
 assert.deepEqual(x.opened.at(-1),{pip:id(2)},'news to read opens the Pip\'s chat');
});
test('a Pip with attention and unread is one card; its count grows in the same card and its profile is current',async t=>{
 const state={list:[pip(1,'Site traffic',{pending_review_count:2,profile:{body:'lens',color:'lens'}})],
  digest:digest([]),unread:[{pip_id:id(1),workspace_id:P,name:'Site traffic',pip_type:'scout',count:8,
   latest:'Traffic report finished.',latest_at:'2026-11-05T00:00:00Z',latest_message_id:'m1'}]};
 const x=harness(t,state,{api:69});await x.connect();
 assert.deepEqual(x.rows(),[['Site traffic','2 waiting for you',false]]);
 const c=x.cards()[0];
 assert.deepEqual([c.group,c.kind,c.waiting,c.unread,c.latest,c.body,c.title],['needs','waiting',2,8,'Traffic report finished.','lens','2 things are waiting for you']);
 assert.deepEqual(c.chips,['8 new'],'what is new is said on the card that needs you');
 assert.equal(c.canRead,true,'and can be marked read from it');
 state.unread[0]={...state.unread[0],count:9,latest:'Another report.',latest_message_id:'m2'};
 state.list[0]={...state.list[0],profile:{body:'quill',color:'quill'}};
 await x.poll();
 assert.equal(x.cards().length,1);
 assert.deepEqual([x.cards()[0].unread,x.cards()[0].body],[9,'quill']);
});
test('Mark read removes the unread Pip and its old digest news while leaving a pending approval alone',async t=>{
 const state={list:[pip(1,'Company inbox')],digest:digest([failed(1,'Company inbox')]),
  unread:[{pip_id:id(1),workspace_id:P,name:'Company inbox',pip_type:'scout',count:1,messages:1,posts:0,
   latest:'The inbox check finished.',latest_message_id:'m1',latest_at:'2026-11-05T00:00:00Z'}]};
 const x=harness(t,state,{api:69});await x.connect();
 assert.equal(x.cards().length,1);
 assert.deepEqual([x.cards()[0].canRead,x.cards()[0].canDismiss],[true,false],'Mark read is the only quiet answer while this Pip has unread messages');
 x.strip.read(x.key(1));await flush();
 assert.equal(x.requests('mark_pip_read').length,1);
 assert.equal(x.requests('mark_pip_news_seen').length,1);
 assert.deepEqual(x.cards(),[]);
 state.list[0]={...state.list[0],pending_review_count:1};
 await x.poll();
 assert.deepEqual(x.rows(),[['Company inbox','1 waiting for you',false]]);
});
test('a Project Pip’s Mark read clears its unread count and findings together',async t=>{
 const state={list:[],projectList:[{...pip(2,'GST watchdog'),workspace_id:Q}],
  digest:digest([found(2,'GST watchdog',2,{workspace_id:Q,scope:'project'})]),
  projectUnread:[{pip_id:id(2),workspace_id:Q,name:'GST watchdog',pip_type:'scout',count:1,messages:0,posts:1,
   latest:'The GST check finished.',latest_post_id:'post-1',latest_at:'2026-11-05T00:00:00Z'}]};
 const x=harness(t,state,{api:69});await x.connect();
 assert.deepEqual(x.rows(),[['GST watchdog','2 new findings',false]]);
 assert.deepEqual([x.cards()[0].scope,x.cards()[0].group,x.cards()[0].canRead],['project','new',true],'a project\'s Pip says so; one Mark read instead of a second dismiss');
 x.strip.read(x.key(2));
 assert.deepEqual(x.cards(),[],'Mark read clears the project card immediately');
 await flush();
 assert.equal(x.requests('mark_pip_read').length,1);
 assert.equal(x.requests('mark_pip_news_seen')[0].request.pip_ids[0],id(2));
 assert.deepEqual(x.cards(),[],'the project Pip card goes away');
});
test('a refused Project Pip read restores its card instead of losing the news',async t=>{
 const state={list:[],projectList:[{...pip(2,'GST watchdog'),workspace_id:Q}],
  digest:digest([failed(2,'GST watchdog')]),refuseRead:true,
  projectUnread:[{pip_id:id(2),workspace_id:Q,name:'GST watchdog',pip_type:'scout',count:1,messages:0,posts:1,
   latest:'The GST check failed.',latest_post_id:'post-1',latest_at:'2026-11-05T00:00:00Z'}]};
 const x=harness(t,state,{api:69});await x.connect();
 x.strip.read(x.key(2));
 assert.deepEqual(x.cards(),[]);
 await flush();
 assert.deepEqual(x.rows(),[['GST watchdog','1 run failed',false]]);
 assert.match(x.model().failure,/didn’t mark it read/);
 assert.equal(x.requests('mark_pip_news_seen').length,0);
});
test('one thing waiting is the card\'s own sentence, with its kind and detail; it opens at that card even with news beside it',async t=>{
 const item={id:`computer_action:compact_${'a'.repeat(32)}`,kind:'computer_action',card:`compact_${'a'.repeat(32)}`,
  pip_id:id(1),pip_name:'Site traffic',pip_type:'scout',workspace_id:P,title:'Send a form',detail:'Cloudflare verification',
  created_at:'2026-11-05T00:00:00Z',expires_at:null};
 const state={list:[pip(1,'Site traffic')],digest:digest([]),attention:{total:1,items:[item],truncated:false,counts:{},by_pip:{[id(1)]:1}},
  unread:[{pip_id:id(1),workspace_id:P,name:'Site traffic',pip_type:'scout',count:2,latest:'Traffic report finished.',
   latest_at:'2026-11-05T00:00:00Z',latest_message_id:'m1'}]};
 const x=harness(t,state,{api:69});await x.connect();
 assert.equal(x.cards().length,1);
 const c=x.cards()[0];
 assert.deepEqual([c.title,c.line,c.waiting,c.unread,c.at],['Send a form','1 waiting for you',1,2,'2026-11-05T00:00:00Z']);
 assert.deepEqual(c.chips,['Its computer','Cloudflare verification','2 new']);
 x.strip.open(x.key(1));
 assert.deepEqual(x.opened.at(-1),{pip:id(1),workspace:P,attention:true,computer:true});
});
test('a new Pip that waits for you is a card of its own, and opens its review',async t=>{
 const card='setup_'+'c'.repeat(32);
 const item={id:`setup:${card}`,kind:'setup',card,pip_id:null,pip_name:'Receipts',pip_type:'rook',workspace_id:Q,title:'Create the Pip Receipts?',detail:'Gmail · Mondays 9:00',
  created_at:'2026-11-06T00:00:00Z',expires_at:null};
 const state={list:[pip(1,'Daily check')],digest:digest([]),attention:{total:1,items:[item],truncated:false,counts:{setup:1},by_pip:{}}};
 const x=harness(t,state,{api:69});await x.connect();
 assert.deepEqual(x.cards().map(c=>[c.key,c.pip,c.name,c.kind,c.group,c.scope,c.title,c.chips,c.body,c.canDismiss,c.canRead]),
  [[`setup:${card}`,null,'Receipts','setup','needs','project','Create the Pip Receipts?',['Gmail · Mondays 9:00'],'rook',false,false]]);
 assert.deepEqual([x.model().need,x.model().more],[1,0],'it is the one thing that needs you, and the card shows it');
 x.strip.open(`setup:${card}`);
 assert.deepEqual(x.opened.at(-1),{setup:card,workspace:Q});
});
test('what waits beyond the cards is counted, and Open in Pips leads to Needs attention',async t=>{
 // DGC counts 5 waiting on your Personal Pips but names none of them here (a list cut short): no card can show them.
 const state={list:[pip(1,'Approvals',{pending_review_count:1})],digest:digest([]),attention:{total:5,items:[],reviews:[],truncated:true,counts:{},by_pip:{[id(1)]:1}}};
 const x=harness(t,state,{api:69});await x.connect();
 assert.deepEqual([x.rows(),x.model().need,x.model().more],[[['Approvals','1 waiting for you',false]],5,4]);
 x.strip.openAll();
 assert.deepEqual(x.opened.at(-1),{attention:true,all:true,workspace:P},'the Pips view at Needs attention, in your Personal Pips');
});
test('an unread request failure never claims all is quiet, and Retry recovers the count',async t=>{
 const state={list:[pip(1,'Mail watch')],digest:digest([]),unreadFail:true,unread:[
  {pip_id:id(1),workspace_id:P,name:'Mail watch',pip_type:'scout',count:1,latest:'New mail arrived.',latest_at:'2026-11-02T07:40:00Z'}]};
 const x=harness(t,state,{api:69});await x.connect();
 assert.deepEqual([x.model().ready,x.model().unreadFailure,x.cards()],[true,true,[]]);
 state.unreadFail=false;x.strip.retry();await flush();
 assert.deepEqual([x.model().unreadFailure,x.model().fresh,x.rows().length],[false,1,1]);
});

test('a dismiss is on news cards only, and needs Pips API 48',async t=>{
 const state={list:[pip(1,'ERP daily audit',{pending_review_count:2}),pip(2,'GST watchdog'),pip(3,'Morning review')],
  digest:digest([failed(2,'GST watchdog'),found(3,'Morning review',2)])};
 const x=harness(t,state);await x.connect();
 assert.deepEqual(x.rows(),[['ERP daily audit','2 waiting for you',false],['GST watchdog','1 run failed',true],['Morning review','2 new findings',true]],
  'waiting for you needs an answer: no dismiss');
 assert.deepEqual(x.cards().map(c=>c.group),['needs','new','new']);
 assert.equal(x.model().canClear,true);
 x.strip.dismiss(x.key(1));await flush();
 assert.equal(x.requests('mark_pip_news_seen').length,0,'a card that waits cannot be dismissed, whoever asks');
 const old=harness(t,state,{api:47});await old.connect();
 assert.deepEqual(old.rows().map(r=>r[2]),[false,false,false],'an older DGC has nothing to keep it: no dismiss');
 assert.equal(old.model().canClear,false);
});

test('dismissing sends the digest\'s time, removes the card at once, stays gone on the next poll, and a new failure brings it back',async t=>{
 const state={list:[pip(1,'ERP daily audit'),pip(2,'GST watchdog')],digest:digest([failed(1,'ERP daily audit'),failed(2,'GST watchdog')])};
 const x=harness(t,state);await x.connect();
 state.hold=true;
 x.strip.dismiss(x.key(1));
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

test('a dismiss DGC refuses puts the card back and says so',async t=>{
 const state={list:[pip(1,'ERP daily audit')],digest:digest([failed(1,'ERP daily audit')]),refuse:true};
 const x=harness(t,state);await x.connect();
 x.strip.dismiss(x.key(1));await flush();
 assert.deepEqual(x.rows().map(r=>r[0]),['ERP daily audit']);
 assert.equal(x.model().failure,'That didn’t dismiss. Try again.');
});

test('Clear dismisses every news card in one request and leaves what waits for you',async t=>{
 const list=[pip(1,'Approvals',{pending_review_count:1}),...[2,3,4,5,6].map(n=>pip(n,`Audit ${n}`))];
 const state={list,digest:digest([2,3,4,5,6].map(n=>failed(n,`Audit ${n}`)))};
 const x=harness(t,state);await x.connect();
 assert.equal(x.rows().length,6,'every Pip with news has its card: Home is where they are read');
 assert.equal(x.model().canClear,true);
 x.strip.clear();await flush();
 const [mark]=x.requests('mark_pip_news_seen');
 assert.deepEqual([...mark.request.pip_ids],[2,3,4,5,6].map(id),'one request for all five');
 assert.deepEqual(x.rows(),[['Approvals','1 waiting for you',false]]);
 assert.equal(x.model().canClear,false,'one card left that waits: nothing to clear');
});

test('Clear marks every new message read too, on the Pips that need you as well',async t=>{
 const state={list:[pip(1,'Approvals',{pending_review_count:1}),pip(2,'Mail watch')],digest:digest([]),unread:[
  {pip_id:id(1),workspace_id:P,name:'Approvals',pip_type:'scout',count:2,messages:2,posts:0,latest:'Two to look at.',latest_at:'2026-11-02T07:40:00Z',latest_message_id:'m1',latest_post_id:null},
  {pip_id:id(2),workspace_id:P,name:'Mail watch',pip_type:'scout',count:1,messages:1,posts:0,latest:'New mail arrived.',latest_at:'2026-11-02T07:30:00Z',latest_message_id:'m2',latest_post_id:null}]};
 const x=harness(t,state,{api:69});await x.connect();
 assert.deepEqual([x.model().fresh,x.model().canClear],[3,true]);
 x.strip.clear();
 assert.deepEqual(x.rows(),[['Approvals','1 waiting for you',false]],'gone at once; what waits stays');
 assert.deepEqual(x.cards()[0].chips,[],'and its new messages are read');
 await flush();
 assert.deepEqual(x.requests('mark_pip_read').map(m=>m.request.pip_id).sort(),[id(1),id(2)].sort());
 assert.equal(x.model().fresh,0);
});

test('the last card dismissed leaves no card, and your Pips are still named',async t=>{
 const state={list:[pip(0,'Core'),pip(1,'ERP daily audit')],digest:digest([failed(1,'ERP daily audit')])};
 const x=harness(t,state);await x.connect();
 x.strip.dismiss(x.key(1));await flush();
 assert.deepEqual(x.cards(),[]);
 assert.deepEqual([x.model().ready,x.model().need,x.model().fresh,x.model().failure],[true,0,0,'']);
 assert.deepEqual(x.model().pips.map(p=>p.name),['Core','ERP daily audit']);
});

test('the most urgent first: waiting for you, then alerts, then failed runs, then new findings; every one has its card',async t=>{
 // Listed in the Pips view's order, Core first, the most urgent last.
 const list=[pip(0,'Core'),pip(1,'Finds'),pip(2,'Fails'),pip(3,'Alerts'),pip(4,'Waits',{pending_review_count:3}),pip(5,'Fails too'),pip(6,'Quiet')];
 const state={list,digest:digest([found(3,'Alerts',1,{alert:true}),failed(2,'Fails'),failed(5,'Fails too',2),found(1,'Finds',4),found(0,'Core',1),
  news(6,'Quiet',{runs:{succeeded:3,failed:0,cancelled:0}})])};
 const x=harness(t,state);await x.connect();
 assert.deepEqual(x.rows(),[['Waits','3 waiting for you',false],['Alerts','1 new, worth a look now',true],['Fails','1 run failed',true],['Fails too','2 runs failed',true],
  ['Core','1 new finding',true],['Finds','4 new findings',true]],'Quiet only ran, so it has no card');
 assert.deepEqual(x.cards().map(c=>c.group),['needs','new','new','new','new','new']);
 x.strip.dismiss(x.key(3));await flush();
 assert.deepEqual(x.rows().map(r=>r[0]),['Waits','Fails','Fails too','Core','Finds'],'dismissing one takes only it away');
 x.strip.open(x.key(4));
 assert.deepEqual(x.opened.at(-1),{pip:id(4)},'a Pip with reviews waiting opens at the Pip');
});

test('one Pip with failed runs and new findings says both, as a failure',async t=>{
 const x=harness(t,{list:[pip(1,'Finds'),pip(2,'Both')],digest:digest([found(1,'Finds',1),news(2,'Both',{runs:{succeeded:1,failed:1,cancelled:0},new_total:2})])});await x.connect();
 assert.deepEqual(x.rows(),[['Both','1 run failed · 2 new findings',true],['Finds','1 new finding',true]]);
 assert.equal(x.card('Both').title,'1 run failed · 2 new findings','the card says everything a dismiss dismisses');
});

test('100 Pips: past the digest\'s 20 the model says there may be more, and a Pip past the first page of 100 still gets its card',async t=>{
 const list=Array.from({length:100},(_,n)=>pip(n+1,`Pip ${n+1}`));
 const twenty=Array.from({length:20},(_,n)=>failed(n+1,`Pip ${n+1}`));
 const x=harness(t,{list,digest:digest(twenty,{omitted_pips:17})});await x.connect();
 assert.equal(x.rows().length,20,'the twenty the digest names');
 assert.equal(x.model().partial,true,'the digest left out 17 Pips after 20 with news: there may be more');
 const beyond=harness(t,{list:list.slice(0,2),digest:digest([failed(150,'Past the first page')])});await beyond.connect();
 assert.deepEqual(beyond.rows(),[['Past the first page','1 run failed',true]],'named from the digest itself');
});

test('a review the list has already counted is one thing waiting, not two',async t=>{
 const with_review=pip(1,'Approvals',{pending_review_count:1});
 const listed=harness(t,{list:[with_review],digest:digest([]),attention:{total:1,items:[],reviews:[],truncated:false,counts:{},by_pip:{[id(1)]:1}}},{api:69});await listed.connect();
 assert.deepEqual(listed.rows(),[['Approvals','1 waiting for you',false]]);
 const before=harness(t,{list:[with_review],digest:digest([]),attention:{total:1,items:[],truncated:false,counts:{},by_pip:{[id(1)]:1}}},{api:69});await before.connect();
 assert.deepEqual(before.rows(),[['Approvals','2 waiting for you',false]],'a DGC from before: its review and a card');
});

// Routines recover and tell you (Pips package 2): a Pip whose routines can't run has its card here too, in the words its
// row in the Pips view says, and it isn't news to dismiss: it goes when the Pip can run again.
test('a Pip whose routines can\'t run gets its card, in the words its Pips row says',async t=>{
 const blocked={last:null,next_at:'2026-11-09T02:30:00.000Z',blocked:{cause:'signed_out',text:'Claude Code signed out',fix:{kind:'sign_in',engine:'claude'}}};
 const state={list:[pip(1,'Daily check'),pip(2,'Morning',{routine_health:blocked})],digest:digest([])};
 const x=harness(t,state,{api:69});await x.connect();
 assert.deepEqual(x.rows(),[['Morning',"Can't run: Claude Code signed out",false]]);
 assert.deepEqual([x.cards()[0].group,x.cards()[0].kind,x.cards()[0].title],['needs','blocked',"Can't run: Claude Code signed out"]);
 state.attention={total:1,items:[{id:`computer_action:compact_${'b'.repeat(32)}`,kind:'computer_action',card:`compact_${'b'.repeat(32)}`,pip_id:id(2),pip_name:'Morning',pip_type:'scout',workspace_id:P,title:'Send a form',detail:'',created_at:'2026-11-07T09:00:00Z',expires_at:null}],truncated:false,counts:{},by_pip:{[id(2)]:1}};await x.poll();
 assert.deepEqual(x.rows(),[['Morning',"Can't run: Claude Code signed out · 1 waiting for you",false]],'it can\'t run: said first, with what waits');
 assert.ok(x.cards()[0].chips.includes('1 waiting for you'));
 state.attention=undefined;
 state.list=[pip(1,'Daily check'),pip(2,'Morning',{routine_health:{...blocked,blocked:null}})];await x.poll();
 assert.deepEqual(x.rows(),[],'signed in again: the card goes');
});

// User test H3 (15 Nov): a notification said "DGC Pips: 2 things are waiting for you" while Home said "Needs you 0 ·
// Nothing needs you". DGC couldn't list the Pips for the side bar (their workspace had moved), and Home took "couldn't
// say" for "nothing". The model now says when it is unknown, and Home's Needs you card says so.
test('H3: when DGC cannot list the Pips the model says so (unknown), and stops saying it once it can',async t=>{
 const state={list:[pip(1,'Daily check')],digest:digest([]),workspacesFail:true};
 const h=harness(t,state);
 assert.equal(h.model()?.unknown??false,false,'before DGC is asked, nothing is unknown: it is only not ready');
 await h.connect();
 assert.equal(h.model().ready,false);
 assert.equal(h.model().unknown,true,'asked, and DGC could not say');
 assert.deepEqual(h.model().cards,[]);
 state.workspacesFail=false;
 await h.poll();
 assert.equal(h.model().ready,true);
 assert.equal(h.model().unknown??false,false);
});

// Home said "0 · Nothing needs you" for the first seconds after a start, while things waited (24 Nov RC check): until the
// Pips are read, the model says it is still checking (DGC starting, reconnecting, the first read under way); Pips turned
// off or a CLI too old for this list are not "checking".
test('before the Pips are read the model says it is checking; Pips that are off are not',async t=>{
 const state={list:[pip(1,'Daily check',{pending_review_count:1})],digest:digest([])};
 const x=harness(t,state);
 x.strip.receive({type:'pipsConnection',generation:1,connected:false,supported:true,enabled:true,apiVersion:48});
 assert.deepEqual([x.model().ready,x.model().checking],[false,true],'DGC starting: checking');
 await x.connect();
 assert.equal(x.model().ready,true);
 assert.notEqual(x.model().checking,true,'read: no longer checking');
 x.strip.receive({type:'pipsConnection',generation:2,connected:false,supported:true,enabled:true,apiVersion:48});
 assert.equal(x.model().checking,true,'the connection went: checking again, never "nothing needs you"');
 x.strip.receive({type:'pipsConnection',generation:3,connected:true,supported:true,enabled:false,apiVersion:48});
 assert.notEqual(x.model().checking,true,'Pips off: nothing to check');
 x.strip.receive({type:'pipsConnection',generation:4,connected:true,supported:true,enabled:true,apiVersion:30});
 assert.notEqual(x.model().checking,true,'a CLI before this list: nothing to check');
});

// 25 Nov (seen in an RC run): Home's "Needs you" read 2, then 0, then 2 again while a Work turn ran. A read of what waits
// (or of the news) that fails or times out under load was taken as "nothing": the cards went and the number with them,
// until the next poll. A failed read keeps what Home last knew; the next read that answers says what is true now.
test('a read that fails between polls keeps what Home last knew; the next one that answers says what is true now',async t=>{
 const state={list:[pip(1,'Approvals')],digest:digest([failed(2,'Nightly build')]),projectList:[],
  attention:{total:2,items:[],reviews:[],truncated:false,counts:{},by_pip:{[id(1)]:2}}};
 state.list.push(pip(2,'Nightly build'));
 const x=harness(t,state,{api:69});await x.connect();
 const said=()=>[x.model().need,x.rows()];
 const before=[2,[['Approvals','2 waiting for you',false],['Nightly build','1 run failed',true]]];
 assert.deepEqual(said(),before);
 state.attentionFail=true;state.digestFail=true;await x.poll();
 assert.deepEqual(said(),before,'a failed read is not "nothing waits"');
 assert.ok(!x.models.some(m=>m.ready&&m.need===0),'never a moment of 0');
 state.attentionFail=false;state.digestFail=false;
 state.attention={total:0,items:[],reviews:[],truncated:false,counts:{},by_pip:{}};state.digest=digest([]);
 await x.poll();
 assert.deepEqual(said(),[0,[]],'answered again: what is true now');
});

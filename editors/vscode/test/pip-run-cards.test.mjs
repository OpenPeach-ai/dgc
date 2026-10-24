import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSync} from 'esbuild';
import {JSDOM} from 'jsdom';
const bundle=buildSync({entryPoints:[new URL('../src/pipRunCards.js',import.meta.url).pathname],bundle:true,write:false,format:'iife',globalName:'Runs'}).outputFiles[0].text;
const pip='pip_'+'a'.repeat(32),run='run_'+'b'.repeat(32),workspace='ws_'+'c'.repeat(32);
const saved=status=>({id:run,pip_id:pip,workspace_id:workspace,status,manifest:{run_kind:'audit'}});
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function harness(t,options={}){
 const dom=new JSDOM('<main><div class="tool"><span class="verb"></span><span class="badge"></span><button class="tool-toggle"></button><div class="body"></div></div></main>',{runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window;w.eval(bundle+';window.Runs=Runs;');w.HTMLCanvasElement.prototype.getContext=()=>null;
 const pending=[],opened=[],timers=new Map();let seq=0;
 const cards=w.Runs.mountRunCards({document:w.document,request:(type,args)=>new Promise((resolve,reject)=>pending.push({type,args,resolve,reject})),onOpen:v=>opened.push(v),setInterval:fn=>{timers.set(++seq,fn);return seq;},clearInterval:id=>timers.delete(id),...options});
 t.after(()=>{cards.dispose();w.close();});cards.connection(true);
 const send=(extra={})=>cards.toolResult(w.document.querySelector('.tool'),{name:'run_pip_now',output:JSON.stringify({run_id:run,pip_id:pip,status:'succeeded',name:'Forged title'}),...extra});
 const reply=async(status='running',online=true)=>{
  pending.find(p=>p.type==='get_pip_run').resolve({run:saved(status)});await flush();
  pending.find(p=>p.type==='get_pip').resolve({pip:{id:pip,workspace_id:workspace,pip_type:'rook',name:'Review changes'}});
  pending.find(p=>p.type==='get_pip_runner').resolve({runner:{online}});await flush();pending.length=0;
 };
 return {cards,d:w.document,pending,opened,timers,send,reply};
}
test('run receipt supplies identity only; state and character come from the backend',async t=>{
 const x=harness(t);x.send();assert.doesNotMatch(x.d.body.textContent,/Forged|Report ready/);await x.reply('queued');
 assert.match(x.d.body.textContent,/Review changes/);assert.equal(x.d.querySelector('.pip-run-state').textContent,'Waiting to start');assert.equal(x.d.querySelector('.dgc-plush').dataset.character,'rook');
 assert.ok(x.pending.every(p=>['get_pip_run','get_pip','get_pip_runner'].includes(p.type)));
});
test('polling tracks a running job after the tool returns, then stops requesting terminal jobs',async t=>{
 const x=harness(t);x.send();await x.reply();assert.equal(x.d.querySelector('.dgc-plush').dataset.state,'working');
 x.cards.tick();await x.reply('succeeded');assert.equal(x.d.querySelector('.pip-run-state').textContent,'Report ready');
 x.cards.tick();assert.equal(x.pending.length,0);
 x.d.querySelector('.pip-run-open').click();assert.equal(x.opened[0].run,run);assert.equal(x.opened[0].pip,pip);
});
test('runner offline and backend disconnected never animate as live work',async t=>{
 const x=harness(t);x.send();await x.reply('running',false);assert.equal(x.d.querySelector('.pip-run-state').textContent,'Pips not running');assert.equal(x.d.querySelector('.dgc-plush').dataset.state,'offline');
 x.cards.connection(false);assert.equal(x.d.querySelector('.pip-run-state').textContent,'Disconnected');x.cards.tick();assert.equal(x.pending.length,0);
});
test('mismatched runs are refused and no secondary reads occur',async t=>{
 const x=harness(t);x.send();x.pending[0].resolve({run:{...saved('running'),pip_id:'pip_'+'d'.repeat(32)}});await flush();
 assert.match(x.d.body.textContent,/This didn’t load/);assert.equal(x.pending.length,1);assert.equal(x.d.querySelector('.pip-run-open').disabled,true);
});
test('old replies cannot repopulate a different conversation',async t=>{
 const x=harness(t);x.send();const old=x.pending[0];x.cards.reset();old.resolve({run:saved('running')});await flush();assert.equal(x.d.querySelector('.pip-run-line'),null);assert.equal(x.timers.size,0);
});
test('hidden views pause polling and resume by reading saved state',async t=>{
 const x=harness(t);x.send();await x.reply();x.cards.setVisible(false);x.cards.tick();assert.equal(x.pending.length,0);x.cards.setVisible(true);assert.equal(x.pending[0].type,'get_pip_run');
});
test('failed tools and invalid IDs stay ordinary tool output',t=>{
 const x=harness(t);x.send({is_error:true});x.send({output:JSON.stringify({run_id:'../../other',pip_id:pip})});assert.equal(x.d.querySelector('.pip-run-line'),null);assert.equal(x.pending.length,0);
});

test('run is a single inline tool line and stays at its call position after the answer',async t=>{
 const x=harness(t),tool=x.d.querySelector('.tool');x.send();await x.reply();
 const row=x.d.querySelector('.pip-run-line');assert.equal(tool.nextElementSibling,row);
 assert.ok(tool.classList.contains('pip-run-owned'));assert.equal(row.querySelectorAll('button:not([hidden])').length,1);
 const answer=x.d.createElement('p');answer.textContent='Final answer';x.d.querySelector('main').append(answer);
 x.cards.finish(x.d.querySelector('main'));assert.equal(row.nextElementSibling,answer);
 x.send();assert.equal(x.d.querySelectorAll('.pip-run-line').length,1);
 assert.equal(row.nextElementSibling,answer);assert.equal(x.d.querySelector('.pip-run-results'),null);
 x.d.querySelector('.pip-run-open').click();assert.deepEqual(JSON.parse(JSON.stringify(x.opened[0])),{pip,section:'runs',run});
});
test('the agent map reads the runs this chat started, in the words their lines use, and is told when they change',async t=>{
 let changes=0;const x=harness(t,{onChange:()=>{changes+=1;}});
 x.send();
 assert.deepEqual(JSON.parse(JSON.stringify(x.cards.list())),[{id:run,pipId:pip,name:'Pip',status:'',label:'Checking…',detail:'Loading…',active:true,activity:'',startedAt:null,stoppable:false}],'started, not yet loaded: listed as at work');
 const before=changes;await x.reply('running');
 assert.ok(changes>before,'a repaint tells the map');
 assert.deepEqual(JSON.parse(JSON.stringify(x.cards.list())),[{id:run,pipId:pip,name:'Review changes',status:'running',label:'Working',detail:'Working on its own. You can keep chatting.',active:true,activity:'',startedAt:null,stoppable:true}]);
 x.cards.open(run);assert.deepEqual(JSON.parse(JSON.stringify(x.opened)),[{pip,section:'runs',run}]);
 x.cards.tick();await x.reply('succeeded');
 assert.equal(x.cards.list()[0].active,false,'a finished run is no longer at work');
});
test('grouped tool receipt places the run outside the disclosure',async t=>{
 const x=harness(t),tool=x.d.querySelector('.tool'),group=x.d.createElement('details');group.className='tool-group';tool.before(group);group.append(tool);
 x.send();await x.reply('failed');assert.equal(group.nextElementSibling,x.d.querySelector('.pip-run-line'));
 assert.equal(x.d.querySelector('.pip-run-state').textContent,'Failed');assert.equal(x.d.querySelector('.pip-run-open').disabled,false);
});

// The agent map's row for a run this chat started stays live while the Pip works (the founder, 24 Oct): what it is doing
// now, from the run's own activity; since when; and Stop, which cancels the run as History's Cancel run does.
const STARTED='2026-10-24T09:00:00.000Z';
const activity=(events,next)=>({run_id:run,pip_id:pip,workspace_id:workspace,events,next_cursor:next,has_more:false,history_may_be_truncated:false,retention_limit:1000,retention_scope:'workspace'});
const step=(seq,payload,type='pip_run_progress')=>({seq,run_id:run,pip_id:pip,workspace_id:workspace,event_type:type,payload,created_at:STARTED});
async function replyLive(x,status,events,next){
 x.pending.find(p=>p.type==='get_pip_run').resolve({run:{...saved(status),started_at:STARTED}});await flush();
 x.pending.find(p=>p.type==='get_pip').resolve({pip:{id:pip,workspace_id:workspace,pip_type:'rook',name:'Review changes'}});
 x.pending.find(p=>p.type==='get_pip_runner').resolve({runner:{online:true}});await flush();
 const read=x.pending.find(p=>p.type==='list_pip_run_activity');
 if(read){read.resolve(activity(events,next));await flush();}
 const asked=read?.args;x.pending.length=0;return asked;
}
test('the map row says what the Pip is doing now, from the run’s own activity, and reads on from where it stopped',async t=>{
 const x=harness(t);x.send();
 const first=await replyLive(x,'running',[step(1,{},'pip_run_started'),step(2,{kind:'tool_call',tool:'read_file',path:'app/billing.py'}),step(3,{kind:'tool_result',tool:'read_file',status:'completed'})],3);
 assert.deepEqual(JSON.parse(JSON.stringify(first)),{run_id:run,after:0});
 const [row]=x.cards.list();
 assert.equal(row.activity,'Reading billing.py');
 assert.equal(row.startedAt,Date.parse(STARTED),'since when: the run’s own start, so a reload says the same');
 assert.equal(row.stoppable,true);
 x.cards.tick();
 const second=await replyLive(x,'running',[step(4,{kind:'progress',state:'waiting',message:'Waiting for the model'})],4);
 assert.equal(second.after,3,'only what is new');
 assert.equal(x.cards.list()[0].activity,'Waiting for the model');
 x.cards.tick();await replyLive(x,'succeeded',[],4);
 assert.deepEqual([x.cards.list()[0].active,x.cards.list()[0].activity,x.cards.list()[0].stoppable],[false,'',false],'ended: nothing live left');
});
test('Stop from the map cancels the run and reads it again',async t=>{
 const x=harness(t);x.send();await replyLive(x,'running',[],0);
 const stopping=x.cards.stop(run);
 const cancel=x.pending.find(p=>p.type==='cancel_pip_run');
 assert.deepEqual(JSON.parse(JSON.stringify(cancel.args)),{run_id:run});
 cancel.resolve({run:saved('cancelling')});
 assert.equal(await stopping,true);
 assert.equal(x.cards.list()[0].stoppable,false,'one Stop is enough');
 assert.ok(x.pending.some(p=>p.type==='get_pip_run'),'and its state is read again');
 x.pending.length=0;
 assert.equal(await x.cards.stop('run_'+'e'.repeat(32)),false,'a run it does not show is not stopped');
});

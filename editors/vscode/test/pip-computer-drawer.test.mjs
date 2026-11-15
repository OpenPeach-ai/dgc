// A Pip computer's notification drawer (0.52, asked 12 Nov): "the approval cards come on top of the computer screen,
// kind of as notification drawer? which user can open and collapse, on the right corner maybe? like how it does on an
// actual desktop OS?" and "kind of an overlay on the computer screen, obviously Pip using the computer can't see it,
// but user can."
//
// What waits for you is a bell in the slim bar with a count (it replaces the "waiting" chip), and over the screen, at
// its top right, a stack of notification cards that fans out into a drawer. A card that still waits can't be cleared:
// it only collapses into the bell. An answered one says so for a moment, then leaves. A card that arrives while the
// drawer is collapsed shows alone for 6 seconds, then goes back into the bell. And nothing done on the drawer ever
// reaches the computer: it is DGC's own page, over the picture of the screen.
//
// Here: the real client in jsdom, with the page's own clock in the test's hands (the moments are 1.8 s, 340 ms and 6 s).
// Sizes, the stack's geometry and the motion are in pip-computer-drawer-browser.test.mjs (real Chromium).
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const code=(await build({entryPoints:[src+'pipComputerClient.js'],bundle:true,write:false,loader:{'.css':'empty'},format:'iife',
 alias:{'@novnc/novnc':fileURLToPath(new URL('./support/novnc-stub.mjs',import.meta.url))}})).outputFiles[0].text;
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const viewModule=(()=>{const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?{}:require(name));return out.exports;})();
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PIP={id:'pip_'+'s'.repeat(32),name:'Shopper',pip_type:'scout'};
const JPEG='data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
const NOW=Date.parse('2026-11-12T09:10:00.000Z');
// A held submit as DGC says it (the shape pipComputerAction takes). DGC lists what waits newest first.
const action=(letter,summary={},created='2026-11-12T09:10:00.000Z')=>({id:'compact_'+letter.repeat(32),pip_id:PIP.id,workspace_id:'ws',run_id:'run_'+'b'.repeat(32),
 summary:{method:'POST',host:'shop.example',path:'/order',page:'https://shop.example/cart',fields:[],more_fields:0,body_bytes:14,...summary},
 digest:letter.repeat(64),frame:null,status:'pending',created_at:created,expires_at:'2026-11-13T09:00:00.000Z',resolved_at:null,resolved_by:null,continuation_run_id:null});
const FORM=action('c',{},'2026-11-12T09:06:00.000Z');
const PAY=action('d',{host:'pay.example',payment:true,fields:[{name:'amount',value:'53.50'},{name:'card_number',value:'•••'}]},'2026-11-12T09:09:40.000Z');
const SITE=action('e',{kind:'site',site:'news.example',shown:'news.example',method:'GET',host:'news.example',path:'/',page:'https://news.example/',body_bytes:0},'2026-11-12T07:10:00.000Z');
const TEXT=action('f',{kind:'text',host:'forum.example',text:'Dear team,\nthe figures are attached.'},'2026-11-12T09:08:00.000Z');
const LOGIN=action('a',{kind:'login',site:'bank.example',shown:'bank.example',method:'GET',host:'bank.example',path:'/login',page:'https://bank.example/login',body_bytes:0},'2026-11-10T09:10:00.000Z');
const computer=(actions=[])=>({pip_id:PIP.id,granted:true,available:true,reason:'',pending:actions.length,actions});
async function flush(){for(let i=0;i<14;i++)await Promise.resolve();}

/** The tab, with what waits. `screen`: its live screen (a stand-in viewer) or, without, the desktop with its three apps. */
function setup({actions=[],screen=false}={}){
 const dom=new JSDOM(viewModule.computerDocument(),{runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;windows.push(w);
 const sent=[],answered=new Set(),polls=[],timers=[];let state=computer(actions),now=NOW;
 // The page's clock: nothing waits for real time. Date.now() is the test's too, so a card's age is known.
 w.Date.now=()=>now;
 w.setInterval=fn=>{polls.push({fn,live:true});return polls.length;};w.clearInterval=id=>{if(polls[id-1])polls[id-1].live=false;};
 w.setTimeout=(fn,ms=0)=>{timers.push({fn,at:now+ms,live:true});return timers.length;};w.clearTimeout=id=>{if(timers[id-1])timers[id-1].live=false;};
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 const viewer={keys:[],made:0};
 if(screen)w.__dgcTestRFB=class{constructor(target){viewer.made++;target.appendChild(w.document.createElement('canvas'));this.listeners={};viewer.it=this;}
  addEventListener(name,fn){this.listeners[name]=fn;}sendKey(sym,code,down){viewer.keys.push([sym,down]);}};
 w.eval(code);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type).map(m=>JSON.parse(JSON.stringify(m.request)));
 const defaults=r=>({get_pip_computer:()=>({computer:state}),open_pip_computer:()=>({view:{pip_id:PIP.id,ready:true}}),
  use_pip_computer_view:()=>({view:{ok:true,watching:false,url:'https://shop.example/',width:1280,height:800,image:JPEG}}),
  decide_pip_computer_action:()=>{const a=state.actions.find(x=>x.id===r.action_id);state=computer(state.actions.filter(x=>x!==a));return {action:{...a,status:r.approve?'approved':'rejected'}};},
  always_allow_pip_computer_action:()=>{const a=state.actions.find(x=>x.id===r.action_id);state=computer(state.actions.filter(x=>x!==a));return {action:{...a,status:'approved'},grant:{id:'grant_'+'1'.repeat(32)}};},
  get_pip_computer_desktop:()=>({desktop:{pip_id:PIP.id,available:true,reason:'',install:'',using:false,browser:'Google Chrome',chrome_install:''}})}[r.type]?.());
 async function drain(){for(let round=0;round<12;round++){await flush();let count=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);answered.add(m.id);
  message(result!==undefined?{type:'pipsReply',id:m.id,ok:true,result}:{type:'pipsReply',id:m.id,ok:false,error:'Not in this scene.'});count++;}if(!count)break;}await flush();}
 // Time passes: every timer due by then runs, in order, and what they ask for is answered.
 async function wait(ms){const end=now+ms;for(;;){const due=timers.filter(t=>t.live&&t.at<=end).sort((a,b)=>a.at-b.at)[0];if(!due)break;due.live=false;now=Math.max(now,due.at);due.fn();await drain();}now=end;await drain();}
 message({type:'pipComputerInit',pip:PIP,desktop:screen});
 message({type:'pipsConnection',generation:7,apiVersion:86,connected:true,supported:true,enabled:true});
 const d=w.document,$=s=>d.querySelector(s),all=s=>[...d.querySelectorAll(s)];
 const fire=(el,event)=>{assert.ok(el,'Missing the element');el.dispatchEvent(event);};
 return {w,d,$,all,sent,requests,drain,wait,viewer,
  // DGC says no to the one request of this kind that waits for its answer.
  refuse:(type,error)=>{const m=sent.find(m=>m.type==='pipsRequest'&&m.request.type===type&&!answered.has(m.id));answered.add(m.id);message({type:'pipsReply',id:m.id,ok:false,error});},
  arrive:async list=>{state=computer(list);for(const t of polls.filter(t=>t.live))t.fn();await drain();},
  poll:async()=>{for(const t of polls.filter(t=>t.live))t.fn();await drain();},
  // A press with the mouse (detail 1) or from the keyboard (Enter or Space on a button: detail 0).
  click:(s,detail=1)=>fire(typeof s==='string'?$(s):s,new w.MouseEvent('click',{bubbles:true,cancelable:true,detail})),
  key:(s,key)=>{const event=new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});fire(typeof s==='string'?$(s):s,event);return event;},
  wheel:(s,deltaY)=>{const event=new w.WheelEvent('wheel',{deltaY,bubbles:true,cancelable:true});fire($(s),event);return event;},
  pointer:(el,type,x)=>fire(el,new w.MouseEvent(type,{bubbles:true,cancelable:true,clientX:x,clientY:10,button:0,buttons:type==='pointerup'?0:1})),
  // What is on show in the drawer, top to bottom.
  cards:()=>all('#pc-drawer .pc-card').map(c=>({id:c.dataset.card,state:c.dataset.state,kind:c.dataset.kind,source:c.querySelector('.pc-card-source')?.textContent,age:c.querySelector('.pc-card-age')?.textContent,
   title:c.querySelector('.pc-card-open')?.textContent,line:c.querySelector('.pc-card-line')?.textContent,buttons:[...c.querySelectorAll('.pc-card-actions button')].map(b=>b.textContent),
   solid:[...c.querySelectorAll('.pc-card-actions button')].map(b=>b.classList.contains('solid')),done:c.querySelector('.pc-card-done')?.textContent??null,clear:!!c.querySelector('[data-card-clear]')})),
  shown:()=>{const e=$('#pc-drawer');return !!e&&!e.hidden;},
  bell:()=>{const b=$('#pc-bell');return b?{count:b.querySelector('.pc-bell-count').textContent,expanded:b.getAttribute('aria-expanded'),label:b.getAttribute('aria-label'),controls:b.getAttribute('aria-controls')}:null;}};
}
// What the page asked the computer to do by itself: a click, a key, typing or a scroll in its browser.
const drove=x=>x.requests('use_pip_computer_view').filter(r=>['click','key','type','scroll'].includes(r.op)).map(r=>r.op);

test('the bell says how many wait, and is not there at none; it stands where the "waiting" chip was',async()=>{
 const x=setup();await x.drain();
 assert.equal(x.bell(),null,'nothing waits: no bell');
 assert.equal(x.$('#pc-drawer'),null,'and no drawer');
 await x.arrive([PAY,FORM]);
 assert.deepEqual(x.bell(),{count:'2',expanded:'true',label:'2 waiting for you: Pay on pay.example',controls:'pc-drawer'});
 assert.equal(x.$('#pc-bell').tagName,'BUTTON');
 assert.equal(x.$('#pc-chip'),null,'the chip is gone');
 assert.equal(x.$('#pc-wait-float'),null,'and its floating panel');
 assert.equal(x.$('.pc-status').textContent,'2 waiting for you','the state still says it, for a screen reader');
 assert.equal(x.$('.pc-drawer-head h2').textContent,'Waiting for you');
 assert.equal(x.$('.pc-drawer-count').textContent,'2');
 // One is answered: the count goes down at once (the answered card is no longer waiting).
 x.click(`[data-reject="${FORM.id}"]`);await x.drain();
 assert.equal(x.bell().count,'1');assert.equal(x.bell().label,'1 waiting for you: Pay on pay.example');
 assert.equal(x.$('.pc-drawer-count').textContent,'1');
 x.click(`[data-review="${PAY.id}"]`);x.click('#pc-review-send');await x.drain();   // (a payment: Review… first, as its chat card; 15 Nov)
 assert.equal(x.bell(),null,'the bell goes with the last one');
 // With its live screen the bell is in the same bar, before Full screen.
 const live=setup({actions:[FORM],screen:true});await live.drain();
 assert.equal(live.bell().count,'1');
 const order=live.all('#pc-bar button').map(b=>b.id);
 assert.ok(order.indexOf('pc-bell')>=0&&order.indexOf('pc-bell')===order.indexOf('pc-full')-1,`the bell is right before Full screen: ${order.join()}`);
});

test('every approval is a notification card, newest first: a tile for its kind, the site and its age, what it wants, one line, and its own buttons with the first one solid',async()=>{
 const x=setup({actions:[PAY,TEXT,FORM,SITE,LOGIN]});await x.drain();
 assert.deepEqual(x.cards().map(c=>[c.kind,c.source,c.age,c.title]),[
  ['payment','pay.example','now','Pay on pay.example'],
  ['text','forum.example','2m','Let Shopper put this on forum.example?'],
  ['form','shop.example','4m','Send a form to shop.example'],
  ['site','news.example','2h','Let Shopper visit news.example?'],
  ['signin','bank.example','2d','Save a login for bank.example so Shopper can sign in itself?']]);
 assert.deepEqual(x.cards().map(c=>c.buttons),[['Review…','Always allow','Reject'],['Allow once','Always allow','Not now'],['Send once','Always allow','Reject'],['Allow this site','Not now'],['Save login…','Not now']],'its chat card\'s answers, word for word (15 Nov): Always allow on every card that DGC can grant, a payment and app data too, a new site and a login never; a payment is reviewed first; a login is saved from here');
 assert.deepEqual(x.cards().map(c=>c.solid),[[true,false,false],[true,false,false],[true,false,false],[true,false],[true,false]],'the answer that lets it through is the solid one');
 assert.ok(x.cards().every(c=>c.state==='waiting'&&c.done===null));
 for(const card of x.all('#pc-drawer .pc-card')){assert.ok(card.querySelector('.pc-card-tile svg'),'each has its kind\'s icon');assert.equal(card.getAttribute('role'),'listitem');}
 assert.equal(x.$('#pc-drawer .pc-waiting').getAttribute('role'),'list');
 // The one line: what a payment sends (never a hidden card field), else what it is.
 assert.equal(x.cards()[0].line,'amount 53.50');
 assert.match(x.cards()[2].line,/Nothing has been sent\./);
 assert.match(x.cards()[3].line,/^It hasn’t opened news\.example for you before\./);
 assert.doesNotMatch(x.$('#pc-drawer').textContent,/card_number/);
 assert.doesNotMatch(x.$('#app').textContent,/\bAI\b/);
});

test('what a card showed before is one press away: the card opens its detail, and closes it again',async()=>{
 const x=setup({actions:[TEXT,FORM]});await x.drain();
 const open=x.$(`[data-card-open="${TEXT.id}"]`);
 assert.equal(open.tagName,'BUTTON');assert.equal(open.getAttribute('aria-expanded'),'false');
 const detail=()=>x.d.getElementById(x.$(`[data-card-open="${TEXT.id}"]`).getAttribute('aria-controls'));
 assert.ok(detail().hidden,'shut until asked for');
 x.click(open);
 assert.equal(x.$(`[data-card-open="${TEXT.id}"]`).getAttribute('aria-expanded'),'true');
 assert.equal(detail().hidden,false);
 assert.equal(detail().querySelector('.pc-held-text').textContent,'Dear team,\nthe figures are attached.','the whole text it would put on the page');
 assert.match(detail().textContent,/It read this from your apps \(careful mode\)\. Nothing has been typed or sent yet; Allow lets it do this once\./);
 assert.equal(x.requests('decide_pip_computer_action').length,0,'opening a card answers nothing');
 // A form's: what Always allow covers.
 x.click(`[data-card-open="${FORM.id}"]`);
 assert.match(x.d.getElementById(x.$(`[data-card-open="${FORM.id}"]`).getAttribute('aria-controls')).textContent,/Nothing has been sent\. Always allow covers POST \/order\./);
 x.click(`[data-card-open="${TEXT.id}"]`);
 assert.ok(detail().hidden);assert.equal(x.$(`[data-card-open="${TEXT.id}"]`).getAttribute('aria-expanded'),'false');
 // A look at what waits (every 5 s) keeps it as you left it.
 await x.poll();
 assert.equal(x.$(`[data-card-open="${FORM.id}"]`).getAttribute('aria-expanded'),'true');
});

test('the bell opens and closes the drawer, and so does Collapse; a waiting card is never cleared, it only goes into the bell',async()=>{
 const x=setup({actions:[PAY,FORM]});await x.drain();
 assert.ok(x.shown(),'a card that arrives opens the drawer');
 assert.ok(x.$('#pc-drawer').classList.contains('pc-fan'),'fanned out, not the folded stack');
 assert.equal(x.bell().expanded,'true');
 x.click('#pc-bell');
 assert.equal(x.shown(),false,'the bell puts it away');
 assert.equal(x.bell().expanded,'false');assert.equal(x.bell().count,'2','and still counts them');
 x.click('#pc-bell');
 assert.ok(x.shown());assert.equal(x.bell().expanded,'true');assert.equal(x.cards().length,2,'both are back, unanswered');
 const collapse=x.$('#pc-drawer-collapse');
 assert.equal(collapse.tagName,'BUTTON');assert.equal(collapse.textContent,'Collapse');
 x.click(collapse);
 assert.equal(x.shown(),false);assert.equal(x.bell().expanded,'false');
 // Collapsed stays collapsed through the next looks at what waits.
 await x.poll();await x.poll();
 assert.equal(x.shown(),false);assert.equal(x.bell().count,'2');
 x.click('#pc-bell');
 assert.deepEqual(x.cards().map(c=>c.id),[PAY.id,FORM.id]);
 assert.equal(x.requests('decide_pip_computer_action').length+x.requests('always_allow_pip_computer_action').length,0,'opening and closing answers nothing');
});

test('a waiting card can\'t be cleared, swiped away or deleted; an answered one can',async()=>{
 const x=setup({actions:[PAY,FORM]});await x.drain();
 assert.ok(x.cards().every(c=>!c.clear),'no clear button on a card that waits');
 assert.equal(x.$('#pc-drawer [data-clear-all]'),null,'and no Clear all');
 // Delete or Backspace on it (the reference's dismiss key), and a long drag to the side (its swipe).
 x.key(`[data-card-open="${PAY.id}"]`,'Delete');x.key(`[data-card-open="${PAY.id}"]`,'Backspace');
 const card=x.$(`.pc-card[data-card="${PAY.id}"]`);
 x.pointer(card,'pointerdown',20);x.pointer(card,'pointermove',180);x.pointer(card,'pointermove',320);x.pointer(card,'pointerup',320);
 await x.wait(1000);
 assert.deepEqual(x.cards().map(c=>[c.id,c.state]),[[PAY.id,'waiting'],[FORM.id,'waiting']],'both still wait');
 assert.equal(x.$(`.pc-card[data-card="${PAY.id}"]`).style.transform,'','and it did not move');
 assert.equal(x.bell().count,'2');
 assert.equal(x.requests('decide_pip_computer_action').length,0);
 // Answered, it can go at once: its clear button, the swipe, or Delete.
 x.click(`[data-reject="${FORM.id}"]`);await x.drain();
 assert.deepEqual(x.cards().map(c=>[c.id,c.state,c.clear]),[[PAY.id,'waiting',false],[FORM.id,'answered',true]]);
 assert.equal(x.$(`[data-card-clear="${FORM.id}"]`).getAttribute('aria-label'),'Clear');
 x.click(`[data-card-clear="${FORM.id}"]`);
 assert.deepEqual(x.cards().map(c=>c.id),[PAY.id],'cleared at once');
 x.click(`[data-review="${PAY.id}"]`);x.click('#pc-review-send');await x.drain();   // (a payment: Review… first, as its chat card; 15 Nov)
 const paid=x.$(`.pc-card[data-card="${PAY.id}"]`);
 x.pointer(paid,'pointerdown',20);x.pointer(paid,'pointermove',60);
 assert.match(paid.style.transform,/translateX\(40px\)/,'an answered card follows the drag');
 x.pointer(paid,'pointermove',140);x.pointer(paid,'pointerup',140);
 assert.deepEqual(x.cards(),[],'swiped past 90 px, it is gone');
 // Delete on an answered card clears it too.
 const y=setup({actions:[FORM]});await y.drain();
 y.click(`[data-send="${FORM.id}"]`);await y.drain();
 assert.equal(y.cards()[0].state,'answered');
 y.key(`[data-card-open="${FORM.id}"]`,'Delete');
 assert.deepEqual(y.cards(),[]);
});

test('an answered card says so for a moment in place of its buttons, then leaves: Sent once, Always allowed, Rejected, Allowed, Not now',async()=>{
 const x=setup({actions:[PAY,TEXT,FORM,SITE]});await x.drain();
 x.click(`[data-review="${PAY.id}"]`);x.click('#pc-review-send');await x.drain();   // (a payment: Review… first, as its chat card; 15 Nov)
 assert.deepEqual(x.requests('decide_pip_computer_action'),[{type:'decide_pip_computer_action',action_id:PAY.id,expected_digest:PAY.digest,approve:true}]);
 let paid=x.cards()[0];
 assert.deepEqual([paid.id,paid.state,paid.done,paid.buttons],[PAY.id,'answered','Sent once',[]],'the buttons give way to the quiet word, in its place in the list');
 assert.equal(x.cards().length,4);assert.equal(x.bell().count,'3');
 assert.match(x.$('.pc-notice').textContent,/Approved\. It is sent within a few seconds, exactly as shown\./,'the tab still says what happens next');
 await x.wait(1000);
 assert.equal(x.cards()[0].done,'Sent once','still there a second later');
 await x.poll();
 assert.equal(x.cards()[0].done,'Sent once','a look at what waits does not take it early');
 await x.wait(1400);
 assert.deepEqual(x.cards().map(c=>c.id),[TEXT.id,FORM.id,SITE.id],'then it leaves');
 // The other answers, each in its own words.
 x.click(`[data-always="${FORM.id}"]`);await x.drain();
 assert.deepEqual(x.requests('always_allow_pip_computer_action'),[{type:'always_allow_pip_computer_action',action_id:FORM.id,expected_digest:FORM.digest}]);
 assert.equal(x.cards().find(c=>c.id===FORM.id).done,'Always allowed');
 x.click(`[data-reject="${TEXT.id}"]`);await x.drain();
 assert.equal(x.cards().find(c=>c.id===TEXT.id).done,'Not now');
 x.click(`[data-send="${SITE.id}"]`);await x.drain();
 assert.equal(x.cards().find(c=>c.id===SITE.id).done,'Allowed');
 assert.equal(x.bell(),null,'nothing waits any more');
 assert.ok(x.shown(),'the answered cards have their moment');
 await x.wait(2400);
 assert.equal(x.$('#pc-drawer'),null,'with nothing waiting the drawer closes on its own');
 const z=setup({actions:[FORM]});await z.drain();
 z.click(`[data-reject="${FORM.id}"]`);await z.drain();
 assert.equal(z.cards()[0].done,'Rejected');
});

test('an answer DGC refuses leaves the card waiting, with its buttons',async()=>{
 const x=setup({actions:[FORM]});await x.drain();
 x.click(`[data-always="${FORM.id}"]`);
 x.refuse('always_allow_pip_computer_action',{code:'limit',message:'Remove an old allowed action before adding another.'});
 await x.drain();
 assert.match(x.$('.pc-error').textContent,/Remove an old allowed action/);
 assert.deepEqual(x.cards().map(c=>[c.state,c.buttons]),[['waiting',['Send once','Always allow','Reject']]]);
 assert.equal(x.bell().count,'1');
});

test('Escape closes the drawer and gives the bell the focus; opened from the keyboard, focus goes to its first card',async()=>{
 const x=setup({actions:[PAY,FORM]});await x.drain();
 x.$(`[data-send="${FORM.id}"]`).focus();
 const escape=x.key(`[data-send="${FORM.id}"]`,'Escape');
 assert.ok(escape.defaultPrevented);
 assert.equal(x.shown(),false);assert.equal(x.bell().expanded,'false');
 assert.equal(x.d.activeElement.id,'pc-bell','focus is back on the bell');
 assert.equal(x.requests('decide_pip_computer_action').length,0,'Escape answers nothing');
 // Enter on the bell: a press from the keyboard.
 x.click('#pc-bell',0);
 assert.ok(x.shown());
 assert.equal(x.d.activeElement,x.$(`[data-card-open="${PAY.id}"]`),'its first card has the focus');
 // With the mouse, focus stays where it was.
 x.click('#pc-bell');x.$('#pc-bell').focus();x.click('#pc-bell');
 assert.ok(x.shown());assert.equal(x.d.activeElement.id,'pc-bell');
 // Escape somewhere else, with only the folded stack on show, is not the drawer's.
 x.click('.pc-dock [data-app=files]');await x.drain();
 assert.equal(x.$('#pc-drawer').classList.contains('pc-fan'),false,'a press elsewhere folds it back to the stack');
 assert.ok(x.shown(),'the stack stays over the screen');
 const other=x.key('.pc-dock [data-app=files]','Escape');
 assert.equal(other.defaultPrevented,false);assert.ok(x.shown());
});

test('a card that arrives opens the drawer; collapsed, it shows alone for 6 seconds under the bell, then goes back into it',async()=>{
 const x=setup();await x.drain();
 await x.arrive([FORM]);
 assert.ok(x.shown()&&x.$('#pc-drawer').classList.contains('pc-fan'),'the first one opens the drawer');
 assert.equal(x.$('#pc-drawer').classList.contains('pc-drawer-banner'),false);
 x.click('#pc-drawer-collapse');
 assert.equal(x.shown(),false);
 // Another arrives while it is collapsed.
 await x.arrive([PAY,FORM]);
 assert.equal(x.bell().count,'2','the count goes up');assert.equal(x.bell().expanded,'false','the drawer stays collapsed');
 assert.ok(x.shown());assert.ok(x.$('#pc-drawer').classList.contains('pc-drawer-banner'),'a banner');
 assert.deepEqual(x.cards().map(c=>[c.id,c.buttons]),[[PAY.id,['Review…','Always allow','Reject']]],'the new one alone, with its buttons');
 assert.equal(x.$('#pc-drawer .pc-drawer-head'),null,'no header on a banner');
 await x.wait(5500);await x.poll();
 assert.ok(x.shown(),'still there at 5.5 s');
 await x.wait(1000);
 assert.equal(x.shown(),false,'back in the bell after 6 s');
 assert.equal(x.bell().count,'2');assert.equal(x.bell().expanded,'false');
 await x.poll();
 assert.equal(x.shown(),false,'the same one seen again is not an arrival');
 // It can be answered from the banner.
 await x.arrive([TEXT,PAY,FORM]);
 assert.deepEqual(x.cards().map(c=>c.id),[TEXT.id]);
 x.click(`[data-send="${TEXT.id}"]`);await x.drain();
 assert.deepEqual(x.cards().map(c=>[c.id,c.done]),[[TEXT.id,'Allowed']]);
 assert.equal(x.bell().count,'2');
 await x.wait(2400);
 assert.equal(x.shown(),false);
 // The bell brings them all back, and from then a new one opens the drawer again.
 x.click('#pc-bell');
 assert.deepEqual(x.cards().map(c=>c.id),[PAY.id,FORM.id]);assert.equal(x.$('#pc-drawer').classList.contains('pc-drawer-banner'),false);
 await x.arrive([SITE,PAY,FORM]);
 assert.deepEqual(x.cards().map(c=>c.id),[SITE.id,PAY.id,FORM.id]);assert.ok(x.$('#pc-drawer').classList.contains('pc-fan'));
});

test('with nothing waiting the drawer closes on its own, and the next card opens it again',async()=>{
 const x=setup({actions:[FORM]});await x.drain();
 assert.ok(x.shown());
 // DGC stops asking (it expired, or was answered in its chat).
 await x.arrive([]);
 assert.equal(x.$('#pc-drawer'),null);assert.equal(x.bell(),null);
 assert.equal(x.$('.pc-status').textContent,'Idle');
 await x.arrive([PAY]);
 assert.ok(x.shown());assert.deepEqual(x.cards().map(c=>c.id),[PAY.id]);
});

test('the drawer is DGC\'s own page: a press, a key or a scroll on it never reaches the Pip\'s browser, and it is no part of the screen\'s picture',async()=>{
 const x=setup({actions:[TEXT,FORM]});await x.drain();
 x.click('.pc-dock [data-app=browser]');await x.drain();
 assert.ok(x.$('#pc-screen'),'the picture of its browser is on show');
 x.click('#pc-bell');x.click('#pc-bell');
 const drawer=x.$('#pc-drawer');
 assert.equal(drawer.closest('.pc-screen, .pc-window, #pc-vnc'),null,'the drawer is outside the screen and its window');
 assert.equal(x.$('.pc-screen').querySelector('.pc-card, #pc-bell'),null,'and nothing of it is inside the screen');
 assert.deepEqual(drove(x),[]);
 // On the drawer: its ground, a card, a card's words, its header.
 for(const part of ['#pc-drawer','.pc-card','.pc-card-line','.pc-drawer-head h2','.pc-card-tile'])x.click(part);
 x.click(`[data-card-open="${TEXT.id}"]`);
 for(const key of ['a','Enter','Backspace','ArrowDown','Tab'])assert.equal(x.key(`[data-card-open="${FORM.id}"]`,key).defaultPrevented,false,`${key} on a card is left alone`);
 assert.equal(x.wheel('.pc-waiting',240).defaultPrevented,false,'a scroll on the list scrolls the list');
 await x.wait(600);
 assert.deepEqual(drove(x),[],'nothing done on the drawer reached the computer');
 // The same on the screen itself does drive it (so the check above could have failed).
 x.click('#pc-screen');x.key('.pc-screen','Enter');x.key('.pc-screen','a');x.wheel('.pc-screen',240);
 await x.wait(600);
 assert.deepEqual(drove(x).sort(),['click','key','scroll','type']);
 // With its live screen: the drawer is beside the viewer, never in it, and the viewer hears no key from it.
 const live=setup({actions:[FORM],screen:true});await live.drain();
 assert.equal(live.viewer.made,1);
 assert.equal(live.$('#pc-drawer').closest('#pc-vnc'),null);assert.equal(live.$('#pc-vnc').querySelector('.pc-card'),null);
 assert.equal(live.$('#pc-drawer').parentElement.closest('#pc-live')?.id,'pc-live','it floats in the screen\'s own room');
 live.key(`[data-card-open="${FORM.id}"]`,'a');live.click('.pc-card-line');
 assert.deepEqual(live.viewer.keys,[]);
 // Nothing the page sends says a word of the drawer: no frame, no message carries it.
 const said=JSON.stringify(live.sent)+JSON.stringify(x.sent);
 assert.doesNotMatch(said,/Waiting for you|Send a form to|Let Shopper/);
});

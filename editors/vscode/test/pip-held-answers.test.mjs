// A held request offers the same answers wherever it is shown (decided 15 Nov, from a live test: "Save a login for
// cloudflare.com so Test can sign in itself?" offered "Save login…" and "Not now" in the Pip's chat, and only "Not now"
// in its computer's notifications): "the cards clickable options needs to come same as on the notification bar on the
// personal computer." One list (src/pipCareful.js heldRequestAnswers) is what the chat's card and the computer's notification
// both draw: the same answers, the same order, the same words. A login's card saves the login from the notification
// itself; a payment's shows Review… there too (a payment is never sent in one tap).
// Here: the real computer page in jsdom. The two real pages side by side, in Chromium: pip-held-answers-browser.test.mjs.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const code=(await build({entryPoints:[src+'pipComputerClient.js'],bundle:true,write:false,loader:{'.css':'empty'},format:'iife',
 alias:{'@novnc/novnc':fileURLToPath(new URL('./support/novnc-stub.mjs',import.meta.url))}})).outputFiles[0].text;
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const viewModule=(()=>{const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?{}:require(name));return out.exports;})();
const careful=await import('../src/pipCareful.js');
const windows=[];after(()=>windows.forEach(w=>w.close()));
const PIP={id:'pip_'+'5'.repeat(32),name:'Test',pip_type:'scout'};
const PASSWORD='correct horse battery staple';
const action=(letter,summary={})=>({id:'compact_'+letter.repeat(32),pip_id:PIP.id,workspace_id:'ws',run_id:'run_'+'b'.repeat(32),
 summary:{method:'POST',host:'shop.example',path:'/order',page:'https://shop.example/cart',fields:[],more_fields:0,body_bytes:14,...summary},
 digest:letter.repeat(64),frame:null,status:'pending',created_at:'2026-11-15T09:10:00.000Z',expires_at:'2026-11-16T09:00:00.000Z',resolved_at:null,resolved_by:null,continuation_run_id:null});
const FORM=action('c');
const PAY=action('d',{host:'pay.example',payment:true,fields:[{name:'amount',value:'53.50'},{name:'card_number',value:'•••'}]});
const SITE=action('e',{kind:'site',site:'news.example',shown:'news.example',method:'GET',host:'news.example',path:'/',page:'https://news.example/',body_bytes:0});
const TEXT=action('f',{kind:'text',host:'forum.example',text:'Dear team,\nthe figures are attached.'});
const FLOOR=action('9',{kind:'floor',host:'terminal',floor:'could delete everything in its Files',fields:[{name:'command',value:'rm -rf ~/Files'}]});
const LOGIN=action('a',{kind:'login',site:'cloudflare.com',shown:'dash.cloudflare.com',method:'GET',host:'dash.cloudflare.com',path:'/login',page:'https://dash.cloudflare.com/login',body_bytes:0});
const computer=(actions=[])=>({pip_id:PIP.id,granted:true,available:true,reason:'',pending:actions.length,actions});
async function flush(){for(let i=0;i<14;i++)await Promise.resolve();}

function setup(actions,{api=86}={}){
 const dom=new JSDOM(viewModule.computerDocument(),{runScripts:'outside-only',pretendToBeVisual:true});const w=dom.window;windows.push(w);
 const sent=[],answered=new Set();let state=computer(actions),refuse=null;
 w.setInterval=()=>1;w.clearInterval=()=>{};const timers=[];w.setTimeout=(fn)=>{timers.push(fn);return timers.length;};w.clearTimeout=()=>{};
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(code);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const gone=r=>{const a=state.actions.find(x=>x.id===r.action_id);state=computer(state.actions.filter(x=>x!==a));return a;};
 const answers=r=>({get_pip_computer:()=>({computer:state}),open_pip_computer:()=>({view:{pip_id:PIP.id,ready:true}}),
  use_pip_computer_view:()=>({view:{ok:true,watching:false,url:'https://shop.example/',width:1280,height:800,image:'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=='}}),
  decide_pip_computer_action:()=>{const a=gone(r);return {action:{...a,status:r.approve?'approved':'rejected'}};},
  always_allow_pip_computer_action:()=>{const a=gone(r);return {action:{...a,status:'approved'},grant:{id:'grant_'+'1'.repeat(32)}};},
  save_pip_login:()=>{const a=gone(r);return {login:{id:'login_'+'1'.repeat(32),site:'cloudflare.com',hosts:['dash.cloudflare.com'],username:r.username,has_code:!!r.totp,pips:r.pips==='all'?'all':[PIP.id],source:'card',
   created_at:'2026-11-15T09:11:00.000Z',last_used_at:null},action:{...a,status:'approved'}};},
  get_pip_computer_desktop:()=>({desktop:{pip_id:PIP.id,available:true,reason:'',install:'',using:false,browser:'Google Chrome',chrome_install:''}})}[r.type]?.());
 async function drain(){for(let round=0;round<12;round++){await flush();let count=0;for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){answered.add(m.id);
  const no=refuse&&refuse.type===m.request.type?refuse.error:'';const result=no?undefined:answers(m.request);if(no)refuse=null;
  message(result!==undefined?{type:'pipsReply',id:m.id,ok:true,result}:{type:'pipsReply',id:m.id,ok:false,error:no||'Not in this scene.'});count++;}if(!count)break;}await flush();}
 message({type:'pipComputerInit',pip:PIP,desktop:false});
 message({type:'pipsConnection',generation:7,apiVersion:api,connected:true,supported:true,enabled:true});
 const d=w.document,$=s=>d.querySelector(s),all=s=>[...d.querySelectorAll(s)];
 const click=s=>{const el=typeof s==='string'?$(s):s;assert.ok(el,`Missing ${s}`);el.dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true,detail:1}));};
 return {w,d,$,all,drain,click,
  requests:type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type).map(m=>JSON.parse(JSON.stringify(m.request))),
  refuseNext:(type,error)=>{refuse={type,error};},
  type:(id,value)=>{const box=d.getElementById(id);assert.ok(box,`Missing #${id}`);box.value=value;box.dispatchEvent(new w.Event('input',{bubbles:true}));},
  submit:id=>{d.getElementById(id).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));},
  key:(el,key)=>{const event=new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});el.dispatchEvent(event);return event;},
  card:id=>{const c=$(`#pc-drawer .pc-card[data-card="${id}"]`);return c?{buttons:[...c.querySelectorAll('.pc-card-actions button')].map(b=>b.textContent),solid:[...c.querySelectorAll('.pc-card-actions button')].map(b=>b.classList.contains('solid')),
   line:c.querySelector('.pc-card-detail')?.textContent||'',done:c.querySelector('.pc-card-done')?.textContent??null}:null;},
  dialog:()=>{const g=$('#pc-dialog-root [role=dialog]');return g?{title:g.querySelector('h2')?.textContent,modal:g.getAttribute('aria-modal'),labelled:g.getAttribute('aria-labelledby')===g.querySelector('h2')?.id,
   buttons:[...g.querySelectorAll('button')].map(b=>b.textContent),text:g.textContent,error:g.querySelector('[role=alert]:not([hidden])')?.textContent||''}:null;}};
}

const KINDS=[['a login',LOGIN,['Save login…','Not now']],['a new site',SITE,['Allow this site','Not now']],['app data for a page',TEXT,['Allow once','Always allow','Not now']],
 ['a Terminal command',FLOOR,['Allow once','Always allow','Not now']],['a form',FORM,['Send once','Always allow','Reject']],['a payment',PAY,['Review…','Always allow','Reject']]];

test('one list of answers for a held request: what its card says in the chat, in the card\'s order',()=>{
 assert.equal(typeof careful.heldRequestAnswers,'function','src/pipCareful.js has the one list');
 for(const [what,a,labels] of KINDS)assert.deepEqual(careful.heldRequestAnswers(a.summary,'Test').map(b=>b.label),labels,what);
 assert.deepEqual(careful.heldRequestAnswers(LOGIN.summary,'Test').map(b=>b.how),['login','reject']);
 assert.deepEqual(careful.heldRequestAnswers(PAY.summary,'Test').map(b=>b.how),['review','always','reject']);
 assert.deepEqual(careful.heldRequestAnswers(FORM.summary,'Test').map(b=>b.how),['send','always','reject']);
 // Neither place keeps a list of its own: the chat's two cards and the notification's card are all drawn from it.
 const chat=readFileSync(src+'pipsClient.js','utf8'),drawer=readFileSync(src+'pipComputerDrawer.js','utf8');
 const body=(text,name)=>{const at=text.indexOf(`function ${name}(`);assert.ok(at>=0,name);return text.slice(at,text.indexOf('\nfunction ',at+10)>0?text.indexOf('\n}',at):undefined);};
 for(const name of ['waitingCard','computerSubmitCard']){const fn=body(chat,name);assert.match(fn,/heldButtons\(/,`${name} draws the one list`);assert.doesNotMatch(fn,/>(Not now|Reject|Send once|Always allow|Review…)</,`${name} writes no answer of its own`);}
 assert.match(body(chat,'heldButtons'),/heldRequestAnswers\(/);
 const words=body(drawer,'cardWords');assert.match(words,/heldRequestAnswers\(/);assert.doesNotMatch(words,/label:'/,'the notification writes no answer of its own');
});

test('each notification in the computer view offers its chat card\'s answers: the same words in the same order, the first one solid',async()=>{
 // (DGC lists five held requests at the most.)
 const x=setup(KINDS.slice(0,3).map(k=>k[1])),y=setup(KINDS.slice(3).map(k=>k[1]));await x.drain();await y.drain();
 for(const [what,a,labels] of KINDS){const card=(KINDS.findIndex(k=>k[1]===a)<3?x:y).card(a.id);assert.ok(card,`${what}: its notification`);
  assert.deepEqual(card.buttons,labels,what);assert.deepEqual(card.solid,labels.map((_,i)=>i===0),`${what}: the answer that lets it through is the solid one`);}
 assert.doesNotMatch(x.card(LOGIN.id).line,/card in its chat/,'a login is saved here: nothing sends you to the chat');
 assert.match(x.$(`.pc-card[data-card="${LOGIN.id}"] .pc-card-open`).textContent,/^Save a login for cloudflare\.com so Test can sign in itself\?$/);
});

test('Save login… on the notification opens the login\'s form over the page; Save seals it with DGC and answers the card; nothing typed stays in the page',async()=>{
 const x=setup([LOGIN,FORM]);await x.drain();
 x.click(`[data-login="${LOGIN.id}"]`);await x.drain();
 const g=x.dialog();
 assert.ok(g,'a dialog opens');assert.equal(g.modal,'true');assert.equal(g.labelled,true);
 assert.equal(g.title,'Save a login for cloudflare.com');
 assert.match(g.text,/So Test can sign in to cloudflare\.com by itself\./);
 assert.match(g.text,/DGC keeps it sealed on this computer and types it in for Test; Test never sees it/);
 assert.deepEqual(g.buttons,['Cancel','Save login']);
 assert.equal(x.$('#loginSite'),null,'the site is the card\'s: there is no box to type another');
 assert.equal(x.requests('save_pip_login').length,0,'nothing is sent by opening it');
 // No password: it says so, and sends nothing.
 x.type('loginUser','arjun@mail.example');x.submit('login-form');await x.drain();
 assert.equal(x.dialog().error,'Type the password.');assert.equal(x.requests('save_pip_login').length,0);
 // DGC refuses once: the form stays, with what DGC said, and the card still waits.
 x.type('loginPassword',PASSWORD);x.refuseNext('save_pip_login','That card was already answered (approved).');x.submit('login-form');await x.drain();
 assert.equal(x.dialog().error,'That card was already answered (approved).');
 x.type('loginPassword',PASSWORD);x.submit('login-form');await x.drain();
 const sent=x.requests('save_pip_login');assert.equal(sent.length,2);
 assert.deepEqual(sent[1],{type:'save_pip_login',pip_id:PIP.id,username:'arjun@mail.example',password:PASSWORD,pips:'only',action_id:LOGIN.id,expected_digest:LOGIN.digest},'the card\'s own id and digest: DGC knows the site; the page sends none');
 assert.equal(x.dialog(),null,'saved: the dialog closes');
 assert.equal(x.card(LOGIN.id).done,'Saved','and its card says so in place of its buttons');
 assert.deepEqual(x.card(FORM.id).buttons,['Send once','Always allow','Reject'],'the other card still waits');
 assert.ok(!x.d.documentElement.innerHTML.includes(PASSWORD),'the password is nowhere in the page');
 assert.equal(x.requests('decide_pip_computer_action').length,0,'saving is the answer: no second decision is sent');
});

test('Cancel and Escape close the login\'s form and leave the card waiting; Not now answers it as before',async()=>{
 const x=setup([LOGIN]);await x.drain();
 x.click(`[data-login="${LOGIN.id}"]`);x.type('loginPassword',PASSWORD);x.click('#review-cancel');await x.drain();
 assert.equal(x.dialog(),null);assert.ok(!x.d.documentElement.innerHTML.includes(PASSWORD));
 assert.deepEqual(x.card(LOGIN.id).buttons,['Save login…','Not now']);
 x.click(`[data-login="${LOGIN.id}"]`);
 const escape=x.key(x.$('#loginUser'),'Escape');await x.drain();
 assert.equal(x.dialog(),null,'Escape closes it');assert.equal(escape.defaultPrevented,true);
 assert.ok(x.$('#pc-drawer')&&!x.$('#pc-drawer').hidden,'and only it: the notifications stay open');
 assert.equal(x.requests('save_pip_login').length,0);
 x.click(`[data-reject="${LOGIN.id}"]`);await x.drain();
 assert.deepEqual(x.requests('decide_pip_computer_action').map(r=>[r.action_id,r.approve]),[[LOGIN.id,false]]);
 assert.equal(x.card(LOGIN.id).done,'Not now');
});

test('Review… on a payment\'s notification shows what it sends first, with the card\'s other answers; Send once there sends it',async()=>{
 const x=setup([PAY]);await x.drain();
 assert.equal(x.$(`[data-send="${PAY.id}"]`),null,'a payment is never sent in one tap');
 x.click(`[data-review="${PAY.id}"]`);await x.drain();
 const g=x.dialog();assert.ok(g);
 assert.equal(g.title,'Send this once?');
 assert.match(g.text,/Test wants to send a form to pay\.example\. Nothing has been sent\./);
 assert.match(g.text,/amount\s*53\.50/);assert.match(g.text,/This sends payment card details\./);
 assert.match(g.text,/Always allow pays only inside its daily limit\./);
 assert.deepEqual(g.buttons,['Reject','Cancel','Always allow','Send once'],'the chat\'s review, button for button');
 assert.equal(x.requests('decide_pip_computer_action').length,0);
 x.click('#pc-review-send');await x.drain();
 assert.deepEqual(x.requests('decide_pip_computer_action').map(r=>[r.action_id,r.expected_digest,r.approve]),[[PAY.id,PAY.digest,true]]);
 assert.equal(x.dialog(),null);assert.equal(x.card(PAY.id).done,'Sent once');
 // Reject and Always allow from the review.
 const y=setup([PAY]);await y.drain();y.click(`[data-review="${PAY.id}"]`);y.click('#pc-review-reject');await y.drain();
 assert.deepEqual(y.requests('decide_pip_computer_action').map(r=>r.approve),[false]);assert.equal(y.dialog(),null);assert.equal(y.card(PAY.id).done,'Rejected');
 const z=setup([PAY]);await z.drain();z.click(`[data-review="${PAY.id}"]`);z.click('#pc-review-always');await z.drain();
 assert.equal(z.requests('always_allow_pip_computer_action').length,1);assert.equal(z.dialog(),null);assert.equal(z.card(PAY.id).done,'Always allowed');
});

test('the computer tab may save a login only as its own Pip\'s card\'s answer',()=>{
 const text=readFileSync(src+'pipsView.ts','utf8');
 assert.equal(typeof viewModule.computerTabRefusal,'function');
 const mine={type:'save_pip_login',pip_id:PIP.id,username:'a',password:'p',pips:'only',action_id:LOGIN.id,expected_digest:LOGIN.digest};
 assert.equal(viewModule.computerTabRefusal(mine,PIP.id),'');
 assert.equal(viewModule.computerTabRefusal({...mine,pip_id:'pip_'+'6'.repeat(32)},PIP.id),'This tab only uses this Pip\'s computer.');
 const {action_id,expected_digest,...loose}=mine;
 assert.equal(viewModule.computerTabRefusal({...loose,site:'evil.example'},PIP.id),'This tab only uses this Pip\'s computer.','never a login for a site the page names');
 assert.equal(viewModule.computerTabRefusal({...mine,site:'evil.example'},PIP.id),'This tab only uses this Pip\'s computer.');
 for(const type of ['remove_pip_login','grant_pip_login','list_pip_logins','send_pip_message'])assert.equal(viewModule.computerTabRefusal({type,pip_id:PIP.id},PIP.id),'This tab only uses this Pip\'s computer.',type);
 assert.equal(viewModule.computerTabRefusal({type:'decide_pip_computer_action',action_id:LOGIN.id,expected_digest:LOGIN.digest,approve:false},PIP.id),'');
 assert.match(text,/computerTabRefusal\(message\.request, ?computer\.pip\.id\)/,'the host asks it of every request from a computer tab');
});

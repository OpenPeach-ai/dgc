// What only you can do, when its check is not in the chat, is a pill on the bar over the prompt box (26 Nov).
// Seen in a narrow side bar: such cards stood at the chat's very end, a new reply landed above them, and the chat,
// following its end, scrolled the reply out of sight. They are out of the chat now: the bar (media/shared/tray.js, the
// same bar as the queue's pill) has a "needs you" pill with their count, and the pill opens the same cards with the same
// answers. A card whose check IS in the chat stays under that check and is not counted. The Pips view in jsdom, in a
// shadow root as the side bar mounts it, on the stand-in DGC of test/support/one-pips-scene.mjs.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setup as open} from './support/one-pips-node.mjs';
import {GST,CHECK,WAIT,WAIT2,WAIT3} from './support/one-pips-scene.mjs';

const tray=readFileSync(new URL('../media/shared/tray.js',import.meta.url),'utf8');
const windows=[];after(()=>windows.forEach(w=>w.close()));
const chat=async(scene,{row=false}={})=>{const x=open({api:96,scene,pre:[tray]});windows.push(x.w);await x.drain();if(!row)await x.openPip(GST);return x;};
const pill=x=>x.$('#chat-tray .rail-chip[data-kind="needs"]');
// (Decided 26 Nov, option A of three drawn: "Needs you" and the purple count badge Home's tab and the Pips list use.)
const said=x=>{const p=pill(x);return p?[p.querySelector('.chip-word')?.textContent||'',p.querySelector('.chip-num')?.textContent||''].join(' '):'';};
const pop=x=>x.$('#chat-tray .rail-pop');
const inLog=(x,s)=>[...x.d.querySelectorAll(`.conversation-log ${s}`)];
const press=async(x,id,answer)=>{[...pop(x).querySelectorAll('[data-flow-waiting-answer]')].find(b=>b.dataset.flowWaitingId===id&&b.dataset.flowWaitingAnswer===answer).click();await x.drain();};

test('one whose check is not in the chat is not in the chat: the bar has a "needs you" pill with its count',async()=>{
 const x=await chat({fix:'none'});
 assert.deepEqual(inLog(x,'[data-flow-waiting]'),[],'nothing of it in the conversation');
 assert.equal(x.$('.pip-found-waiting'),null,'and its card is drawn nowhere while the pill is closed');
 const p=pill(x);
 assert.ok(p,'the pill');
 assert.equal(said(x),'Needs you 1');
 assert.equal(p.dataset.need,undefined,'no amber warning: it says Needs you, with the purple count');
 assert.equal(p.querySelector('.codicon:not(.chip-caret)'),null,'no icon of its own');
 assert.equal(p.querySelector('.chip-detail'),null,'no card title squeezed in beside it');
 assert.equal(p.getAttribute('aria-label'),'1 thing only you can do');
 assert.equal(p.title,'1 thing only you can do');
 assert.ok(p.querySelector('svg path, svg circle'),'with its icon');
 assert.equal(pop(x).hidden,true,'closed until asked');
});

test('a card under its own check stays in the chat and is not counted; two more are "Needs you 2"',async()=>{
 const x=await chat({fix:'ask',more:2});
 const under=inLog(x,'.pip-found-waiting');
 assert.deepEqual(under.map(c=>c.dataset.flowWaiting),[WAIT],'the one whose check is drawn, and only it');
 const post=x.$(`[data-run-post="${CHECK}"]`);
 assert.ok(post&&(post.contains(under[0])||post.compareDocumentPosition(under[0])&4),'after its check, as before');
 assert.equal(said(x),'Needs you 2');
 assert.equal(pill(x).getAttribute('aria-label'),'2 things only you can do');
});

test('nothing waits, or everything that waits is under its check: no pill',async()=>{
 const none=await chat({fix:'none',waiting:false});
 assert.equal(pill(none),null);
 const placed=await chat({fix:'ask'});
 assert.equal(pill(placed),null,'its card is in the chat');
 assert.equal(inLog(placed,'.pip-found-waiting').length,1);
});

test('the pill opens the same cards; an answer sends what the chat\'s card sent, the count drops, and the last one takes the pill away',async()=>{
 const x=await chat({fix:'none',more:1});
 assert.equal(said(x),'Needs you 2');
 pill(x).click();await x.drain();
 assert.equal(pop(x).hidden,false,'its popover');
 assert.equal(x.$('#chat-tray .rail-pop-title').textContent,'Only you can do these');
 const cards=[...pop(x).querySelectorAll('.pip-found-waiting')];
 assert.deepEqual(cards.map(c=>c.dataset.flowWaiting),[WAIT,WAIT2]);
 assert.deepEqual(cards.map(c=>c.querySelector('.dgc-card-title').textContent),['GSP wallet is empty','Portal password expired']);
 assert.match(cards[1].querySelector('.dgc-card-sub').textContent,/^Only you can do this · uploads are blocked · since /);
 for(const card of cards)assert.deepEqual([...card.querySelectorAll('.pip-found-actions button')].map(b=>b.textContent.trim()),['I’ve done it','Remind me later','Not a problem']);
 assert.deepEqual(inLog(x,'[data-flow-waiting]'),[],'still none in the chat');
 await press(x,WAIT2,'done');
 assert.deepEqual(x.requests('answer_pip_waiting').at(-1),{type:'answer_pip_waiting',pip_id:GST,waiting_id:WAIT2,answer:'done'});
 assert.equal(said(x),'Needs you 1','the count drops');
 assert.equal(pop(x).hidden,false,'and the rest is still open');
 assert.deepEqual([...pop(x).querySelectorAll('.pip-found-waiting')].map(c=>c.dataset.flowWaiting),[WAIT]);
 await press(x,WAIT,'later');
 assert.deepEqual(x.requests('answer_pip_waiting').at(-1),{type:'answer_pip_waiting',pip_id:GST,waiting_id:WAIT,answer:'later'});
 assert.equal(pill(x),null,'nothing waits: no pill');
 assert.equal(pop(x).hidden,true,'and its popover closed');
 assert.deepEqual(inLog(x,'[data-flow-waiting]'),[],'no answered line lands in the chat either');
});

test('while an answer is on its way its card says so and every answer waits',async()=>{
 const x=await chat({fix:'none',more:1,answers:{answer_pip_waiting:undefined}});
 pill(x).click();await x.drain();
 await press(x,WAIT,'done');
 const buttons=[...pop(x).querySelectorAll('[data-flow-waiting-answer]')];
 assert.equal(buttons.find(b=>b.dataset.flowWaitingId===WAIT&&b.dataset.flowWaitingAnswer==='done').textContent,'Saving…');
 assert.ok(buttons.length===6&&buttons.every(b=>b.disabled),'none can be pressed twice');
 assert.equal(said(x),'Needs you 2','still counted until DGC answers');
});

test('"Not a problem" keeps its Undo in the pill while another waits, and Undo puts its card back',async()=>{
 const x=await chat({fix:'none',more:1});
 pill(x).click();await x.drain();
 await press(x,WAIT2,'not_a_problem');
 assert.equal(said(x),'Needs you 1');
 const line=pop(x).querySelector(`.pip-found-line[data-flow-waiting="${WAIT2}"]`);
 assert.ok(line,'its line, in the popover');assert.match(x.squash(line.textContent),/Not a problem: Portal password expired\. It won’t come up again\. Undo/);
 await press(x,WAIT2,'undo');
 assert.equal(x.requests('answer_pip_waiting').at(-1).answer,'undo');
 assert.equal(said(x),'Needs you 2');
 assert.ok(pop(x).querySelector(`.pip-found-waiting[data-flow-waiting="${WAIT2}"]`),'its card again');
});

// Every one answered "I've done it", as on a project Pip with nine (26 Nov): DGC keeps each answer undoable for ten
// minutes, and the pill said Undo, stayed on the bar after it was closed, and opened on the nine "You said it's done"
// lines, none with an Undo. Nothing is left waiting, so nothing is on the bar.
test('every one answered "I’ve done it": the pill goes with the last, and its popover with it',async()=>{
 const x=await chat({fix:'none',more:1});
 assert.equal(said(x),'Needs you 2');
 pill(x).click();await x.drain();
 await press(x,WAIT2,'done');
 assert.equal(said(x),'Needs you 1');
 const last=[...pop(x).querySelectorAll('[data-flow-waiting-answer]')].find(b=>b.dataset.flowWaitingId===WAIT&&b.dataset.flowWaitingAnswer==='done');
 last.focus();last.click();await x.drain();
 assert.ok(x.state.more.every(w=>w.state==='done')&&x.state.waiting==='done','DGC has both as done (each still undoable there)');
 assert.equal(pill(x),null,'no pill: not one saying Undo either');
 assert.equal(pop(x).hidden,true,'its popover closed');
 assert.equal(x.d.activeElement?.id,'chatText','the keyboard goes to the prompt box');
 assert.equal(x.$('#chat-tray .rail-chips').hidden,true,'nothing else on the bar: no bar');
 assert.deepEqual(inLog(x,'[data-flow-waiting]'),[],'and no answered line lands in the chat');
});

// The last one called "Not a problem": its line keeps its Undo while the pill is open, the pill saying All done, so a
// wrong answer can be put back right there. Closed, the pill is gone, Undo with it.
test('"Not a problem" on the last one: open, the pill says All done over its Undo line; closed, it is gone',async()=>{
 const x=await chat({fix:'none'});
 assert.equal(said(x),'Needs you 1');
 pill(x).click();await x.drain();
 await press(x,WAIT,'not_a_problem');
 assert.equal(pop(x).hidden,false,'still open');
 assert.equal(said(x),'All done ');
 assert.equal(pill(x).dataset.need,undefined,'no longer marked as needing you');
 const line=pop(x).querySelector(`.pip-found-line[data-flow-waiting="${WAIT}"]`);
 assert.ok(line,'its line, with Undo');
 await press(x,WAIT,'undo');
 assert.equal(x.requests('answer_pip_waiting').at(-1).answer,'undo');
 assert.equal(said(x),'Needs you 1','its card is back');
 await press(x,WAIT,'not_a_problem');
 assert.equal(said(x),'All done ');
 x.$('#chat-tray-pop-close').click();await x.drain();
 assert.equal(pill(x),null,'closed: the pill is gone');
 assert.equal(x.$('#chat-tray .rail-chips').hidden,true,'and the bar with it');
 assert.equal(x.state.waiting,'dismissed','(DGC still has it as Not a problem)');
});

test('a Needs attention row for one of them opens its Pip\'s chat with the pill open at its card',async()=>{
 const x=await chat({fix:'ask',more:2},{row:true});
 x.$('#attention-view-all').click();await x.drain();
 const rows=[...x.d.querySelectorAll('.attention-all-list > li')];
 rows.find(r=>r.querySelector('.attention-copy strong')?.textContent==='Bank asks for a new mandate').querySelector('[data-attention]').click();
 for(let i=0;i<8&&pop(x)?.hidden!==false;i++){await x.drain();await x.wait(60);}
 await x.drain();
 assert.ok(x.$('#chat-form'),'its chat');
 assert.equal(pop(x).hidden,false,'the pill is open');
 assert.equal(pop(x).dataset.kind,'needs');
 const card=pop(x).querySelector(`.pip-found-waiting[data-flow-waiting="${WAIT3}"]`);
 assert.ok(card,'at its card');
 assert.equal(x.d.activeElement?.dataset.flowWaitingId,WAIT3,'with the keyboard on its first answer');
});

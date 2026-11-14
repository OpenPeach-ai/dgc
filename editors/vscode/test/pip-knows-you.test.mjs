// "Knows about you" (0.52, pips-flow-design Q8; Pips API 96, dgc/pip_knows_you.py): a switch on every Pip's page beside
// "What it remembers", on by default: what DGC remembers about you reaches this Pip. get_pip says `knows_you`;
// set_pip_knows_you {pip_id, on}. One quiet line under it: "Settings › Memory turns this off for every Pip."
// And what was only a Personal Pip's is every Pip's now: "What it remembers", routines and a goal, for a Pip with a
// folder too.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setup as open} from './support/one-pips-node.mjs';
import {MORNINGS,GST} from './support/one-pips-scene.mjs';

const windows=[];after(()=>windows.forEach(w=>w.close()));
const setup=options=>{const x=open({api:96,...options});windows.push(x.w);return x;};
async function page(x,id){await x.drain();await x.openPip(id);await x.menu('job');await x.drain();}
/** Back to the list of Pips, however deep the page is. */
async function home(x){for(let i=0;i<4&&!x.$('.pips-one-list');i++){(x.$('#simple-back')||x.$('#simple-to-chat')).click();await x.drain();}}
const flip=async(x,on)=>{const s=x.$('#pipKnowsYou');s.checked=on;s.dispatchEvent(new x.w.Event('change',{bubbles:true,composed:true}));await x.drain();};
const NOTE={id:'pipnote_'+'a'.repeat(32),text:'Likes small diffs.',source:'chat',run_id:null,created_at:'2026-11-10T09:00:00Z'};

for(const [who,id] of [['a Personal Pip',MORNINGS],['a Pip with a folder',GST]]){
 test(`${who}'s page has the switch beside "What it remembers", on by default, with its quiet line`,async()=>{
  const x=setup();await page(x,id);
  const section=x.$('.pip-page [aria-label="What it remembers"]');
  assert.ok(section,'What it remembers, on its page');
  const row=section.querySelector('.pip-knows-you');
  assert.ok(row,'the switch is in that section');
  assert.equal(row.querySelector('strong').firstChild.textContent,'Knows about you');
  assert.equal(x.squash(row.querySelector('small').textContent),'Settings › Memory turns this off for every Pip.','one quiet line under it');
  assert.equal(x.squash(x.$('#pipKnowsYouSays').textContent),`What DGC remembers about you (you, the people in your life, how you like things done) reaches ${id===GST?'GST watchdog':'Mornings'}.`,'what it means, behind its "i"');
  assert.equal(x.$('#pipKnowsYou').getAttribute('aria-describedby'),'pipKnowsYouSays');
  const s=x.$('#pipKnowsYou');
  assert.equal(s.getAttribute('role'),'switch');assert.equal(s.checked,true,'on by default');
  assert.equal(s.getAttribute('aria-label'),'Knows about you');
  assert.equal(x.requests('set_pip_knows_you').length,0);
  assert.ok(row.compareDocumentPosition(section.querySelector('#note-add-form'))&x.w.Node.DOCUMENT_POSITION_FOLLOWING,'above what it keeps itself');
 });
}

test('switching it off is one change, said once; DGC\'s answer is what the switch shows, and it stays off when the page is opened again',async()=>{
 const x=setup();await page(x,GST);
 await flip(x,false);
 assert.deepEqual(x.requests('set_pip_knows_you').at(-1),{type:'set_pip_knows_you',pip_id:GST,on:false});
 assert.equal(x.$('#pipKnowsYou').checked,false);
 assert.match(x.text(),/GST watchdog no longer gets what DGC remembers about you\. It keeps what you told it here\./);
 await home(x);await page(x,GST);
 assert.equal(x.$('#pipKnowsYou').checked,false,'as get_pip says');
 await flip(x,true);
 assert.deepEqual(x.requests('set_pip_knows_you').at(-1),{type:'set_pip_knows_you',pip_id:GST,on:true});
 assert.match(x.text(),/GST watchdog knows what DGC remembers about you again\./);
});

test('a change DGC refuses leaves the switch as it was, with DGC\'s words',async()=>{
 const x=setup();await page(x,MORNINGS);
 const answer=x.backend.answer;x.backend.answer=r=>r.type==='set_pip_knows_you'?{error:{code:'local_only',message:'Only you choose what a Pip knows about you, on this computer.'}}:answer(r);
 await flip(x,false);
 assert.equal(x.$('#pipKnowsYou').checked,true,'still on');
 assert.match(x.$('.pip-page [aria-label="What it remembers"] [role="alert"]').textContent,/Only you choose what a Pip knows about you, on this computer\./);
});

test('a Pip with a folder keeps what a Personal Pip keeps: what it remembers, routines and a goal',async()=>{
 const x=setup({scene:{notes:[NOTE]}});await x.drain();await x.openPip(GST);
 assert.ok(x.$('#chat-routines'),'Routines in its prompt box');
 await x.menu('job');await x.drain();
 assert.ok(x.requests('list_pip_notes').some(r=>r.pip_id===GST),'its notes are read');
 assert.match(x.text('.pip-page [aria-label="What it remembers"]'),/Likes small diffs\./);
 assert.ok(x.$('.pip-page [aria-label="What it remembers"] #note-add-form'),'and you can add to them');
 const routines=x.$('.pip-page [aria-label="Routines"]');
 assert.ok(routines,'a Routines section, as a Personal Pip\'s page has');
 assert.ok(x.requests('list_pip_routines').some(r=>r.pip_id===GST));
 assert.ok(routines.querySelector('[data-routine-add],#routine-add,button'),'with a way to add one');
 assert.ok(x.requests('get_pip_goal').some(r=>r.pip_id===GST),'its chat has a goal to read');
 assert.ok(x.requests('get_pip_working_notes').some(r=>r.pip_id===GST),'and its own working notes');
 assert.ok(x.$('.pip-folder-parts'),'what only a Pip with a folder has is still there');
});

test('an older DGC: a Pip with a folder has none of it, and no Pip has the switch',async()=>{
 const old=open({api:95});windows.push(old.w);await page(old,GST);
 assert.equal(old.$('.pip-page [aria-label="What it remembers"]'),null);
 assert.equal(old.$('.pip-page [aria-label="Routines"]'),null);
 assert.equal(old.requests('list_pip_notes').filter(r=>r.pip_id===GST).length,0);
 assert.equal(old.requests('get_pip_goal').filter(r=>r.pip_id===GST).length,0);
 const personal=open({api:95});windows.push(personal.w);await page(personal,MORNINGS);
 assert.ok(personal.$('.pip-page [aria-label="What it remembers"]'),'a Personal Pip keeps its notes');
 assert.equal(personal.$('#pipKnowsYou'),null,'no switch below Pips API 96');
});

test('the editor asks an older DGC for neither command',()=>{
 const view=readFileSync(new URL('../src/pipsView.ts',import.meta.url),'utf8');
 for(const command of ['set_pip_knows_you','list_pip_sent'])assert.match(view,new RegExp(`'${command}'`),command+': the page may send it');
 assert.match(view,/\[[^\]]*'set_pip_knows_you'[^\]]*\]\.includes\(request\.type\) && this\.apiVersion < 96/);
});

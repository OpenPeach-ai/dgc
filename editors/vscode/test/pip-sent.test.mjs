// "Sent to the web" (0.52, leak guard 4; Pips API 96, dgc/leak_guard.py): a row on a Pip's page that opens a small
// list of each site its computer reached, newest first: "3 times · sent 12 KB · got 340 KB · last 10:42", a blocked one
// marked "blocked: it carried a secret", and under the list the note list_pip_sent returns (an HTTPS connection is a
// sealed tunnel: site and size only). "Nothing sent yet." when empty. Auto but inspectable: no badge, one click.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {setup as open} from './support/one-pips-node.mjs';
import {MORNINGS,GST} from './support/one-pips-scene.mjs';

const windows=[];after(()=>windows.forEach(w=>w.close()));
const setup=options=>{const x=open({api:96,...options});windows.push(x.w);return x;};
async function page(x,id=GST){await x.drain();await x.openPip(id);await x.menu('job');await x.drain();}
const today=(h,m)=>{const d=new Date();d.setHours(h,m,0,0);return d.toISOString();};
const NOTE='A secure (HTTPS) connection from a Pip\'s computer is a sealed tunnel: DGC sees which site it goes to and how much goes out, never what is inside.';
const SITES=[
 {host:'api.shop.example',times:3,sent_bytes:12288,received_bytes:348160,blocked:0,first_at:today(9,5),last_at:today(10,42)},
 {host:'paste.example',times:0,sent_bytes:0,received_bytes:0,blocked:1,first_at:today(10,30),last_at:today(10,30)},
 {host:'docs.example',times:1,sent_bytes:300,received_bytes:2600000,blocked:2,first_at:'2026-11-02T08:00:00Z',last_at:'2026-11-02T08:15:00Z'}];

test('a row on its page, closed and with no badge; nothing is read until it is opened',async()=>{
 const x=setup({scene:{sent:SITES}});await page(x);
 const row=x.$('#pip-sent-toggle');
 assert.ok(row,'the row');
 assert.equal(row.tagName,'BUTTON');assert.equal(row.getAttribute('aria-expanded'),'false');
 assert.equal(row.querySelector('strong').textContent,'Sent to the web');
 assert.equal(x.squash(row.textContent),'Sent to the web','no count, no badge');
 assert.equal(x.$('#pip-sent-list'),null);
 assert.equal(x.requests('list_pip_sent').length,0);
});

test('one click opens the list: each site newest first, how many times, how much, when last; a blocked one says why; DGC\'s note under it',async()=>{
 const x=setup({scene:{sent:SITES}});await page(x);
 x.$('#pip-sent-toggle').click();await x.drain();
 assert.deepEqual(x.requests('list_pip_sent').at(-1),{type:'list_pip_sent',pip_id:GST});
 assert.equal(x.$('#pip-sent-toggle').getAttribute('aria-expanded'),'true');
 assert.equal(x.$('#pip-sent-toggle').getAttribute('aria-controls'),'pip-sent-list');
 const rows=[...x.$$('#pip-sent-list li')].map(li=>[li.querySelector('.sent-host').textContent,x.squash(li.querySelector('small').textContent)]);
 assert.equal(rows.length,3);
 assert.equal(rows[0][0],'api.shop.example');
 assert.match(rows[0][1],/^3 times · sent 12 KB · got 340 KB · last \d{1,2}[:.]42( ?[AP]M)?$/i);
 assert.equal(rows[1][0],'paste.example');
 assert.match(rows[1][1],/^blocked: it carried a secret · last \d{1,2}[:.]30( ?[AP]M)?$/i,'nothing went: only that it was stopped');
 assert.match(rows[2][1],/^1 time · sent 1 KB · got 2\.5 MB · last .*2.* · 2 blocked: they carried a secret$/,'an older one says its day');
 assert.ok(x.$$('#pip-sent-list li')[1].querySelector('.sent-blocked'),'the blocked words are marked');
 assert.equal(x.$('.pip-sent-note').textContent,NOTE);
 x.$('#pip-sent-toggle').click();await x.drain();
 assert.equal(x.$('#pip-sent-list'),null,'and it closes');
 x.$('#pip-sent-toggle').click();await x.drain();
 assert.equal(x.requests('list_pip_sent').length,2,'read again each time it is opened');
});

test('nothing sent: "Nothing sent yet." and no list; a Personal Pip has the row too',async()=>{
 const x=setup();await page(x,MORNINGS);
 x.$('#pip-sent-toggle').click();await x.drain();
 assert.equal(x.$('#pip-sent-list'),null);
 assert.equal(x.$('.pip-sent-empty').textContent,'Nothing sent yet.');
 assert.equal(x.$('.pip-sent-note'),null,'nothing to explain yet');
});

test('a list that doesn\'t load says so in DGC\'s words; an older DGC has no row',async()=>{
 const x=setup();await page(x);
 const answer=x.backend.answer;x.backend.answer=r=>r.type==='list_pip_sent'?{error:{code:'local_only',message:'See what a Pip sent on this computer.'}}:answer(r);
 x.$('#pip-sent-toggle').click();await x.drain();
 assert.match(x.$('.pip-sent [role="alert"]').textContent,/See what a Pip sent on this computer\./);
 const old=open({api:95});windows.push(old.w);await page(old);
 assert.equal(old.$('#pip-sent-toggle'),null);
});

test('what DGC answers is checked, and sizes read plainly',async()=>{
 const sent=await import('../src/pipSent.js');
 const P='pip_'+'c'.repeat(32);
 assert.deepEqual(sent.sentPage({pip_id:P,sites:[],note:NOTE},P),{sites:[],note:NOTE});
 assert.equal(sent.sentPage({pip_id:P,sites:[{...SITES[0],blocked:true}],note:NOTE},P).sites[0].blocked,1,'a yes is one');
 for(const bad of [{pip_id:'pip_'+'d'.repeat(32),sites:[],note:''},{pip_id:P,sites:'no',note:''},{pip_id:P,sites:[{host:'',times:1,sent_bytes:0,received_bytes:0,blocked:0,last_at:''}],note:''},
  {pip_id:P,sites:[{host:'a.example',times:-1,sent_bytes:0,received_bytes:0,blocked:0,last_at:''}],note:''},{pip_id:P,sites:[{host:'a.example',times:1,sent_bytes:'x',received_bytes:0,blocked:0,last_at:''}],note:''}])
  assert.throws(()=>sent.sentPage(bad,P),/didn’t load/,JSON.stringify(bad));
 assert.deepEqual([0,1,1023,1024,1536,348160,1048576,2600000,5e9].map(sent.size),['0 KB','1 KB','1 KB','1 KB','2 KB','340 KB','1 MB','2.5 MB','4.7 GB']);
 assert.equal(sent.sentPage({pip_id:P,sites:Array.from({length:300},(_,i)=>({host:`h${i}.example`,times:1,sent_bytes:1,received_bytes:1,blocked:0,first_at:'',last_at:''})),note:''},P).sites.length,200,'two hundred sites at most');
});

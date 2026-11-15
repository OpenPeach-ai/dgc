// The Pip's model menu has Ultra on its thinking slider (live round 1, finding 16): Ultra is up to 4 sub-agents at once
// for that Pip (set_pip_agents slots 4, Pips API 97); any other level puts it back to one. The stand-in DGC is
// test/support/one-pips-scene.mjs with `sub: true`.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {setup as open} from './support/one-pips-node.mjs';
import {GST} from './support/one-pips-scene.mjs';

const windows=[];after(()=>windows.forEach(w=>w.close()));
const chat=async(api=97,scene={})=>{const x=open({api,scene:{sub:true,waiting:false,fix:'none',...scene}});windows.push(x.w);await x.drain();await x.openPip(GST);await x.drain();x.$('#chat-model').click();await x.drain();return x;};
const slide=async(x,step)=>{const s=x.$('#chat-thinking');s.value=String(step);s.dispatchEvent(new x.w.Event('input',{bubbles:true,composed:true}));s.dispatchEvent(new x.w.Event('change',{bubbles:true,composed:true}));await x.drain();};

test('the slider ends in Ultra; choosing it gives the Pip 4 sub-agents at once, and the menu says Ultra',async()=>{
 const x=await chat();
 const s=x.$('#chat-thinking');
 assert.ok(s,'the thinking slider is in the Pip\'s model menu');
 assert.equal(s.max,'5','five levels and Ultra');
 assert.deepEqual([...x.$$('.composer-effort-labels > span')].map(n=>n.textContent),['Off','Ultra']);
 await slide(x,5);
 assert.deepEqual(x.requests('set_pip_agents').map(r=>[r.pip_id,r.slots]),[[GST,4]]);
 assert.equal(x.$('.composer-effort-labels output').textContent,'Ultra');
 assert.equal(x.$('#chat-thinking').value,'5');
 assert.match(x.$('#chat-model-summary').textContent,/Ultra/);
 assert.match(x.$('#chat-thinking').getAttribute('aria-valuetext'),/^Ultra/);
 // Back to an ordinary level: one sub-agent at a time again, and that level is its thinking.
 await slide(x,2);
 assert.deepEqual(x.requests('set_pip_agents').map(r=>r.slots),[4,1]);
 assert.equal(x.$('.composer-effort-labels output').textContent,'Medium');
});

test('a Pip DGC already runs at 4 sub-agents opens on Ultra; an older DGC has no Ultra on the slider',async()=>{
 const x=await chat(97,{slots:4});
 assert.equal(x.$('#chat-thinking').value,'5');assert.equal(x.$('.composer-effort-labels output').textContent,'Ultra');
 const old=await chat(96);
 assert.equal(old.$('#chat-thinking').max,'4');
 assert.deepEqual([...old.$$('.composer-effort-labels > span')].map(n=>n.textContent),['Off','Extra high']);
});

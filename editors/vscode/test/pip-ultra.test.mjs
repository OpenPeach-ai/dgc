// A Pip's model picker has Ultra at the end of its thinking levels (live round 1, finding 16; a segmented control in the
// one model picker since 17 Nov): Ultra is up to 4 sub-agents at once for that Pip (set_pip_agents slots 4, Pips API
// 97); any other level puts it back to one. The stand-in DGC is test/support/one-pips-scene.mjs with `sub: true`.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {setup as open} from './support/one-pips-node.mjs';
import {GST} from './support/one-pips-scene.mjs';
import {pickerDom} from './support/picker-dom.mjs';

const windows=[];after(()=>windows.forEach(w=>w.close()));
const chat=async(api=97,scene={})=>{const x=open({api,scene:{sub:true,waiting:false,fix:'none',...scene}});windows.push(x.w);await x.drain();await x.openPip(GST);await x.drain();x.$('#chat-model').click();await x.drain();return{...x,p:pickerDom(x.d)};};
const pick=async(x,level)=>{x.p.level(level).click();await x.drain();};
const now=x=>x.d.querySelector('.dgc-mp-think-now').textContent;

test('the levels end in Ultra; choosing it gives the Pip 4 sub-agents at once, and the picker and the chip say Ultra',async()=>{
 const x=await chat();
 assert.deepEqual(x.p.levels(),['off','low','medium','high','xhigh','ultra'],'five levels and Ultra, in the Pip\'s model picker');
 assert.equal(x.d.querySelector('.dgc-mp-seg').getAttribute('role'),'radiogroup');
 assert.equal(x.$('.effort-slider, #chat-thinking'),null,'the slider is gone: one segmented control');
 await pick(x,'ultra');
 assert.deepEqual(x.requests('set_pip_agents').map(r=>[r.pip_id,r.slots]),[[GST,4]]);
 assert.equal(now(x),'Ultra');
 assert.equal(x.p.levelNow(),'ultra');
 assert.ok(x.d.querySelector('.dgc-mp-think.is-ultra'));
 assert.equal(x.p.open(),true,'choosing a level keeps the picker open');
 assert.match(x.$('#chat-model').textContent,/Ultra/,'the chip says it');
 // Back to an ordinary level: one sub-agent at a time again, and that level is its thinking.
 await pick(x,'medium');
 assert.deepEqual(x.requests('set_pip_agents').map(r=>r.slots),[4,1]);
 assert.equal(now(x),'Medium');
 assert.equal(x.p.levelNow(),'medium');
});

test('a Pip DGC already runs at 4 sub-agents opens on Ultra; an older DGC has no Ultra',async()=>{
 const x=await chat(97,{slots:4});
 assert.equal(x.p.levelNow(),'ultra');assert.equal(now(x),'Ultra');
 const old=await chat(96);
 assert.deepEqual(old.p.levels(),['off','low','medium','high','xhigh']);
});

test('this Pip\'s face is beside its thinking level',async()=>{
 const x=await chat();
 const face=x.d.querySelector('.dgc-mp-think-head .dgc-mp-think-face .avatar');
 assert.ok(face,'the Pip\'s own face, where the slider\'s dot wore it');
 assert.equal(face.dataset.avatarKey,`effort-${GST}`);
});

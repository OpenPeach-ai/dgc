import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {JSDOM} from 'jsdom';
const source=readFileSync(new URL('../media/pips/plush.js',import.meta.url),'utf8');
const phases=['idle','listening','thinking','working','waiting_approval','success','failure','offline'];
function setup(t){const dom=new JSDOM('<main></main>',{runScripts:'outside-only',pretendToBeVisual:true});t.after(()=>dom.window.close());dom.window.eval(source);return {w:dom.window,d:dom.window.document,api:dom.window.PipConcepts.plush};}
test('eight plush characters expose all eight states without shaders, external images or unsafe names',t=>{
 const {d,api}=setup(t);
 for(let i=0;i<8;i++)for(const state of phases){const node=d.createElement('div');node.innerHTML=api.markup({index:i,name:'<img src=x onerror=alert(1)>'},state,`plush-${i}-${state}`,{includeStyles:false});d.body.append(node);assert.equal(node.querySelector('.dgc-plush').dataset.state,state);assert.equal(node.querySelectorAll('[data-face]').length,2);assert.equal(node.querySelector('canvas,script,img,[data-face=mouth]'),null);assert.equal(node.querySelector('image').getAttribute('href'),'../media/pips/plush-bodies.webp');assert.equal(node.querySelectorAll('style').length,0);assert.equal(node.querySelector('.dgc-plush').dataset.name,'<img src=x onerror=alert(1)>');}
 const ids=[...d.querySelectorAll('[id]')].map(e=>e.id);assert.equal(new Set(ids).size,ids.length);
 assert.equal(d.querySelectorAll('[data-character=lens] clipPath').length,8);
 for(const args of [[{index:8},'idle','safe'],[{index:0},'bad','safe'],[{index:0},'idle','bad id']])assert.throws(()=>api.markup(...args));
 assert.match(api.styles,/prefers-reduced-motion/);assert.match(api.styles,/motion-offscreen/);assert.match(api.styles,/data-paused/);
});
test('visibility subscriptions are shared and released; no timers or graphics contexts',t=>{
 const {w,d,api}=setup(t);const a=d.createElement('div'),b=d.createElement('div');d.body.append(a,b);a.innerHTML=api.markup({index:0},'working','one');b.innerHTML=api.markup({index:1},'thinking','two');
 let adds=0,removes=0,hidden=false;const add=d.addEventListener.bind(d),remove=d.removeEventListener.bind(d);
 d.addEventListener=(type,...args)=>{if(type==='visibilitychange')adds++;return add(type,...args);};d.removeEventListener=(type,...args)=>{if(type==='visibilitychange')removes++;return remove(type,...args);};
 Object.defineProperty(d,'hidden',{get:()=>hidden,configurable:true});
 w.setTimeout=w.requestAnimationFrame=()=>{throw Error('No renderer timers');};
 const cleanA=api.mount(a),cleanB=api.mount(b);assert.equal(adds,1);hidden=true;d.dispatchEvent(new w.Event('visibilitychange'));assert.equal(a.firstElementChild.nextElementSibling.dataset.hidden,'true');
 cleanA();cleanA();assert.equal(removes,0);hidden=false;d.dispatchEvent(new w.Event('visibilitychange'));assert.equal(b.querySelector('.dgc-plush').dataset.hidden,'false');cleanB();assert.equal(removes,1);
});
test('packaged artwork is a bounded WebP atlas with alpha and the declared dimensions',()=>{
 const data=readFileSync(new URL('../media/pips/plush-bodies.webp',import.meta.url));
 assert.equal(data.subarray(0,4).toString(),'RIFF');assert.equal(data.subarray(8,12).toString(),'WEBP');assert.equal(data.subarray(12,16).toString(),'VP8X');
 assert.ok(data[20]&0x10,'the atlas carries an alpha channel');
 assert.equal(1+data.readUIntLE(24,3),1660);assert.equal(1+data.readUIntLE(27,3),948);assert.ok(data.length<300000);
});

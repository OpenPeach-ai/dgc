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
 // No clip anywhere: WebKit (every iPhone browser) drew Lens's clipped eyes square-ended, as rectangles.
 assert.equal(d.querySelectorAll('clipPath,[clip-path]').length,0,'no Pip is clipped');
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
test('every state has its own motion: eyes look around in a group under the lenses, the body leans with them',t=>{
 const {d,api}=setup(t);const node=d.createElement('div');d.body.append(node);
 node.innerHTML=api.markup({index:2},'idle','lens-look',{includeStyles:false});
 assert.equal(node.querySelectorAll('.dgc-plush-look > .dgc-plush-track > .dgc-plush-eye').length,2,'Lens looks around');
 for(const [state,motion] of [['idle','dgc-lens-look'],['thinking','dgc-lens-ponder'],['working','dgc-lens-scan']])
  assert.match(api.styles,new RegExp(`\\[data-character=lens\\]\\[data-state=${state}\\] \\.dgc-plush-look\\{animation-name:${motion}\\}`),`Lens ${state}`);
 node.innerHTML=api.markup({index:0},'working','core-look',{includeStyles:false});
 assert.equal(node.querySelectorAll('.dgc-plush-look > .dgc-plush-track > .dgc-plush-eye').length,2);
 for(const [state,motion] of [['thinking','dgc-plush-ponder'],['working','dgc-plush-scan']])
  assert.match(api.styles,new RegExp(`\\.dgc-plush\\[data-state=${state}\\] \\.dgc-plush-look\\{animation:${motion} `),state);
 for(const [state,motion] of [['waiting_approval','dgc-plush-hop'],['success','dgc-plush-success'],['failure','dgc-plush-droop']])
  assert.match(api.styles,new RegExp(`\\[data-state=${state}\\] \\.dgc-plush-rig\\{animation-name:${motion};`),state);
 assert.match(api.styles,/\.dgc-plush\{[^}]*animation:dgc-plush-lean 9\.7s[^}]*\}/);assert.match(api.styles,/\.dgc-plush-look\{animation:dgc-plush-look 9\.7s/,'the lean keeps time with the look');
 assert.match(api.styles,/\.dgc-plush:not\(\[data-state=idle\]\),\.dgc-plush:not\(\[data-state=idle\]\) \.dgc-plush-look\{animation:none\}/,'only an idle Pip looks around');
 assert.match(api.styles,/prefers-reduced-motion:reduce\)\{\.dgc-plush,\.dgc-plush \*\{animation:none!important/);
});
function pointer(t,{reduce=false}={}){
 const x=setup(t);let now=1000;const frames=[];
 Object.defineProperty(x.w.performance,'now',{value:()=>now,configurable:true});
 x.w.requestAnimationFrame=cb=>{frames.push(cb);return frames.length;};x.w.cancelAnimationFrame=()=>{frames.length=0;};
 if(reduce)x.w.matchMedia=()=>({matches:true});
 const run=ms=>{for(let i=0;i<ms/16&&frames.length;i++){now+=16;frames.shift()(now);}};
 const move=(clientX,clientY)=>x.d.dispatchEvent(new x.w.MouseEvent('pointermove',{clientX,clientY}));
 const pip=(state,uid,left=100)=>{const a=x.d.createElement('div');x.d.body.append(a);a.innerHTML=x.api.markup({index:0},state,uid);const n=a.querySelector('.dgc-plush');n.getBoundingClientRect=()=>({left,top:100,width:40,height:40});return n;};
 return {...x,frames,run,move,pip};
}
test('the eyes follow the pointer on a spring, settle back once it rests, and then stop asking for frames',t=>{
 const {d,api,frames,run,move,pip}=pointer(t);const node=pip('idle','follow'),off=pip('offline','asleep',300);
 const clean=api.mount(d.body);assert.equal(frames.length,0,'no frames before the pointer moves');
 move(0,120);run(400);
 assert.equal(node.dataset.tracking,'true');
 assert.ok(parseFloat(node.style.getPropertyValue('--plush-gx'))<-3,'it looks left, toward the pointer');
 assert.ok(parseFloat(node.style.getPropertyValue('--plush-lean'))<-2,'and leans that way');
 assert.equal(off.style.getPropertyValue('--plush-gx'),'','an offline Pip does not look');
 move(600,120);run(400);assert.ok(parseFloat(node.style.getPropertyValue('--plush-gx'))>3,'it turns to follow');
 run(3000);
 assert.equal(node.style.getPropertyValue('--plush-gx'),'');assert.equal(node.dataset.tracking,undefined,'back to looking around');
 assert.equal(frames.length,0,'the loop stops');
 clean();move(0,120);assert.equal(frames.length,0,'released: no listener left');
});
test('with reduced motion the eyes do not follow the pointer',t=>{
 const {d,api,frames,move,pip}=pointer(t,{reduce:true});const node=pip('idle','still');
 api.mount(d.body);move(0,120);assert.equal(frames.length,0);assert.equal(node.dataset.tracking,undefined);
});
test("Lens's eyes stay inside its glasses at every extreme of every look, with no clip",t=>{
 // The lenses are the glasses drawn in the artwork: circles of radius 9 round each eye's x at y 52.5 (the old clip).
 // Each eye is a stroke 6.4 wide with round ends, so a capsule; it must stay whole inside with room to spare.
 const {d,api}=setup(t);
 const moves=name=>[...api.styles.match(new RegExp(`@keyframes ${name}\\{(.*?)\\}\\}`))[1].matchAll(/translate\((-?[\d.]+)px,(-?[\d.]+)px\)/g)].map(m=>[+m[1],+m[2]]);
 const track=+api.styles.match(/\[data-character=lens\] \.dgc-plush-track\{transform:translate\(calc\(var\(--plush-gx,0px\) \* ([\d.]+)\)/)[1];
 const reach=+api.styles.match(/\[data-character=lens\]\{--plush-reach:([\d.]+)px\}/)[1];
 const pointer=[[0,0],[reach,0],[-reach,0],[0,reach*.6],[0,-reach*.6],[reach,reach*.6],[-reach,-reach*.6],[reach,-reach*.6],[-reach,reach*.6]];
 const looks={idle:[[0,0],...moves('dgc-lens-look')],thinking:[[0,0],...moves('dgc-lens-ponder')],working:moves('dgc-lens-scan'),failure:[[0,1.2]],listening:[[0,0]],waiting_approval:[[0,0]]};
 let worst=0;
 for(const [state,offsets] of Object.entries(looks)){
  const node=d.createElement('div');node.innerHTML=api.markup({index:2},state,`lens-${state}`,{includeStyles:false});
  for(const eye of node.querySelectorAll('.dgc-plush-eye')){
   const [,x,y1,y2]=eye.getAttribute('d').match(/M ([\d.]+) ([\d.]+) L [\d.]+ ([\d.]+)/).map(Number);const r=+eye.getAttribute('stroke-width')/2;
   for(const [lx,ly] of offsets)for(const [gx,gy] of pointer)for(const y of [y1,y2]){
    const far=Math.hypot(lx+gx*track,y+ly+gy*track-52.5)+r;worst=Math.max(worst,far);
   }
  }
 }
 assert.ok(worst<=8.6,`an eye reaches ${worst.toFixed(2)} of the lens's 9`);
});


/* DGC plush renderer: the eight Pips from one transparent WebP atlas.
 * All eight states use one local atlas and SVG eye overlays. Motion is CSS: the body sways,
 * squashes and hops, and the eyes look around between blinks, the body leaning the way they
 * look. mount() adds one pointer listener per document so the eyes follow the pointer on a
 * critically damped spring; its frame loop runs only while they move. No graphics contexts,
 * remote asset requests, per-avatar timers or network capabilities.
 */
(() => {
'use strict';
const ids=['core','scout','lens','patch','rook','pulse','lock','quill'];
const states=new Set(['idle','listening','thinking','working','waiting_approval','success','failure','offline']);
const anchors=[[46.17,67.63,52.5],[43.52,64.86,53.65],[34.4,62.4,52.2],[34.72,56.3,52.5],[45.45,67.03,39.6],[42.19,63.53,39.7],[37.49,58.59,40],[34.72,56.9,40.25]];
// Each viewBox includes the complete accessory and normalizes optical scale.
const crops=[[65,88,352,350],[468,74,342,356],[866,74,322,356],[1256,94,362,340],
 [48,462,374,392],[461,495,348,355],[856,482,356,370],[1244,502,390,350]];
const escape=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Where this file was loaded from, so the sprite resolves beside the extension's own files. A
// module script has no currentScript (the computer tab is one, for noVNC), and the sprite then
// resolved against the page and drew Chromium's broken-image picture: find DGC's bundle instead.
const script=globalThis.document?.currentScript?.src
 ||[...(globalThis.document?.scripts||[])].map(s=>s.src).find(src=>/\/dist\/[A-Za-z]+\.js(?:[?#]|$)/.test(src));
const asset=script?new URL('../media/pips/plush-bodies.webp',script).href:'../media/pips/plush-bodies.webp';
const styles=`
.dgc-plush{display:inline-block;position:relative;width:100%;height:100%;vertical-align:middle;isolation:isolate;--plush-reach:4.5px;transform-origin:50% 90%;rotate:var(--plush-lean,0deg);animation:dgc-plush-lean 9.7s ease-in-out var(--plush-delay) infinite}
.dgc-plush[data-character=lens]{--plush-reach:3px}
.dgc-plush-rig{display:block;width:100%;height:100%;overflow:hidden;transform-origin:50% 88%;animation:dgc-plush-breathe 6.7s ease-in-out var(--plush-delay) infinite}
.dgc-plush-look{animation:dgc-plush-look 9.7s ease-in-out var(--plush-delay) infinite}
.dgc-plush-track{transform:translate(var(--plush-gx,0px),var(--plush-gy,0px))}
.dgc-plush-eye{transform-box:fill-box;transform-origin:center;animation:dgc-plush-blink 10.6s ease-in-out var(--plush-delay) infinite}
.dgc-plush:not([data-state=idle]),.dgc-plush:not([data-state=idle]) .dgc-plush-look{animation:none}
.dgc-plush[data-state=listening] .dgc-plush-rig{animation-name:dgc-plush-listen;animation-duration:4.7s}
.dgc-plush[data-state=thinking] .dgc-plush-rig{animation-name:dgc-plush-think;animation-duration:5.2s}
.dgc-plush[data-state=thinking] .dgc-plush-look{animation:dgc-plush-ponder 5.2s ease-in-out var(--plush-delay) infinite}
.dgc-plush[data-state=working] .dgc-plush-rig{animation-name:dgc-plush-work;animation-duration:1.5s}
.dgc-plush[data-state=working] .dgc-plush-look{animation:dgc-plush-scan 2.4s ease-in-out var(--plush-delay) infinite}
.dgc-plush[data-state=waiting_approval] .dgc-plush-rig{animation-name:dgc-plush-hop;animation-duration:3.4s}
.dgc-plush[data-state=success] .dgc-plush-rig{animation-name:dgc-plush-success;animation-duration:3.7s}
.dgc-plush[data-state=failure] .dgc-plush-rig{animation-name:dgc-plush-droop;animation-duration:7s}
.dgc-plush[data-state=failure] .dgc-plush-look{transform:translate(0,2px)}
.dgc-plush[data-state=offline] .dgc-plush-rig{animation:none;opacity:.72}
.dgc-plush[data-state=offline] .dgc-plush-eye,.dgc-plush[data-state=success] .dgc-plush-eye{animation:none}
@keyframes dgc-plush-breathe{0%,100%{transform:translateY(0) rotate(-1deg) scale(1,1)}25%{transform:translateY(-1%) scale(.99,1.015)}50%{transform:translateY(-2%) rotate(1deg) scale(1,1)}75%{transform:translateY(-.5%) scale(1.01,.99)}}
@keyframes dgc-plush-lean{0%,15%,64%,77%,92%,100%{transform:none}18%,33%{transform:translateX(-2.5%) rotate(-3.5deg)}37%,60%{transform:translateX(2.5%) rotate(3.5deg)}80%,89%{transform:rotate(1deg)}}
@keyframes dgc-plush-look{0%,15%,64%,77%,92%,100%{transform:translate(0,0)}18%,33%{transform:translate(calc(var(--plush-reach) * -1),.4px)}37%,60%{transform:translate(var(--plush-reach),-.6px)}80%,89%{transform:translate(1.5px,1.8px)}}
@keyframes dgc-plush-ponder{0%,8%,100%{transform:translate(0,0)}12%,42%{transform:translate(calc(var(--plush-reach) * -.75),-2.4px)}48%,80%{transform:translate(calc(var(--plush-reach) * .75),-2.4px)}86%,96%{transform:translate(0,-1px)}}
@keyframes dgc-plush-scan{0%,14%,80%,100%{transform:translate(calc(var(--plush-reach) * -.85),1.2px)}18%,32%{transform:translate(calc(var(--plush-reach) * -.3),1.2px)}36%,50%{transform:translate(calc(var(--plush-reach) * .3),1.2px)}54%,74%{transform:translate(calc(var(--plush-reach) * .85),1.2px)}}
@keyframes dgc-plush-listen{0%,100%{transform:rotate(-4deg)}50%{transform:translateY(-2%) rotate(3deg)}}
@keyframes dgc-plush-think{0%,100%{transform:rotate(-2deg)}45%,60%{transform:translateY(-1%) rotate(3deg)}}
@keyframes dgc-plush-work{0%,100%{transform:translateY(0) scale(1.03,.97)}35%{transform:translateY(-4%) rotate(-1.5deg) scale(.97,1.03)}65%{transform:translateY(-1%) rotate(1.5deg) scale(1,1)}}
@keyframes dgc-plush-hop{0%,58%,100%{transform:translateY(0) scale(1,1)}64%{transform:translateY(0) scale(1.06,.93)}72%{transform:translateY(-7%) scale(.95,1.05)}80%{transform:translateY(0) scale(1.05,.95)}86%{transform:translateY(-2%) scale(1,1)}92%{transform:translateY(0) scale(1.01,.99)}}
@keyframes dgc-plush-success{0%,62%,100%{transform:translateY(0) scale(1,1)}8%{transform:translateY(0) scale(1.06,.94)}18%{transform:translateY(-7%) rotate(3deg) scale(.95,1.05)}28%{transform:translateY(0) scale(1.05,.95)}36%{transform:translateY(-4%) rotate(-2deg) scale(.98,1.02)}46%{transform:translateY(0) scale(1.02,.98)}}
@keyframes dgc-plush-droop{0%,100%{transform:translateY(1.5%) rotate(-3deg)}50%{transform:translateY(2.5%) rotate(-2deg) scale(1.01,.99)}}
@keyframes dgc-plush-blink{0%,44%,49%,88%,91.5%,93%,96.5%,100%{transform:scaleY(1)}46%,47%,89.5%,90%,94.5%,95%{transform:scaleY(.08)}}
.dgc-plush[data-tracking=true],.dgc-plush[data-tracking=true] .dgc-plush-look{animation-play-state:paused}
.dgc-plush[data-paused=true],.dgc-plush[data-paused=true] *,.dgc-plush[data-hidden=true],.dgc-plush[data-hidden=true] *,[data-pip-motion=paused] .dgc-plush,[data-pip-motion=paused] .dgc-plush *,.motion-paused .dgc-plush,.motion-paused .dgc-plush *,.motion-offscreen .dgc-plush,.motion-offscreen .dgc-plush *{animation-play-state:paused!important}
@media(prefers-reduced-motion:reduce){.dgc-plush,.dgc-plush *{animation:none!important;transition:none!important;rotate:none!important}.dgc-plush-track{transform:none!important}}
`;
function markup(pip,state='idle',uid='plush',options={}){
 if(!pip||!Number.isInteger(pip.index)||pip.index<0||pip.index>=8)throw new TypeError('Plush character index must be an integer from 0 to 7.');
 if(typeof uid!=='string'||! /^[A-Za-z][A-Za-z0-9_-]{0,120}$/.test(uid))throw new TypeError('Plush SVG identifier must be a unique ASCII letter-prefixed token.');
 if(!states.has(state))throw new TypeError('Unknown plush state.');
 const i=pip.index,[left,right,y]=anchors[i],lens=i===2;
 let h=lens?7:i<4?12:10,hl=h,hr=h,dy=0;
 if(state==='listening'){hl+=lens?0:2;hr+=lens?0:2;}
 if(state==='thinking'){hl=3;hr=h;}
 if(state==='working'){hl=hr=6;}
 if(state==='waiting_approval')dy=lens?0:-2;
 if(state==='failure'){hl=3;hr=6;}
 const eyes=[left,right].map((x,j)=>{
  const cy=y+dy,hh=j?hr:hl;
  const d=state==='success'?`M ${x-3.7} ${cy+1} Q ${x} ${cy-7} ${x+3.7} ${cy+1}`:
   state==='offline'?`M ${x-3.7} ${cy+1} Q ${x} ${cy+4} ${x+3.7} ${cy+1}`:`M ${x} ${cy-hh/2} L ${x} ${cy+hh/2}`;
  return `<path class="dgc-plush-eye" data-face="${j?'right':'left'}" d="${d}" stroke-width="${state==='success'||state==='offline'?3.5:6.4}"/>`;
 }).join('');
 const clip=lens?`<defs><clipPath id="${uid}-lenses"><ellipse cx="${left}" cy="52.5" rx="9" ry="9"/><ellipse cx="${right}" cy="52.5" rx="9" ry="9"/></clipPath></defs>`:'';
 return `${options.includeStyles===false?'':`<style>${styles}</style>`}<span class="dgc-plush" data-state="${state}" data-character="${ids[i]}" data-name="${escape(pip.name||ids[i])}" data-paused="${options.paused===true}" aria-hidden="true" style="--plush-delay:${-i*.59}s"><svg class="dgc-plush-rig" viewBox="${crops[i].join(' ')}" aria-hidden="true"><image href="${escape(asset)}" width="1660" height="948"/><g transform="translate(${i%4*415} ${i<4?0:474}) scale(4.15 4.74)">${clip}<g fill="none" stroke="#fff" stroke-linecap="round"${lens?` clip-path="url(#${uid}-lenses)"`:''}><g class="dgc-plush-look"><g class="dgc-plush-track">${eyes}</g></g></g></g></svg></span>`;
}
// One visibility subscription and one pointer listener per document; releasing a caller
// releases only its own rigs. markup() creates no listeners or animation loops, and mount()
// starts a frame loop only after the pointer moves, stopping it once the eyes settle.
const documents=new WeakMap(),springs=new WeakMap();
const OMEGA=14,STEP=1/120,REST_MS=2400;
function follow(doc,state){
 const win=doc.defaultView;if(!win?.requestAnimationFrame)return;
 const still=win.matchMedia?.('(prefers-reduced-motion: reduce)');
 state.onPointer=event=>{if(still?.matches||doc.hidden)return;state.pointer={x:event.clientX,y:event.clientY,at:win.performance.now()};if(!state.frame){state.last=0;state.frame=win.requestAnimationFrame(state.step);}};
 state.step=now=>{
  state.frame=0;const p=state.pointer,near=!!p&&now-p.at<REST_MS,dt=state.last?Math.min(.05,(now-state.last)/1000):STEP;state.last=now;let moving=false;
  for(const root of state.roots.keys())for(const node of root.querySelectorAll('.dgc-plush')){
   if(node.dataset.state==='offline'||node.dataset.paused==='true'||doc.hidden)continue;
   const box=node.getBoundingClientRect();if(!box.width)continue;
   let tx=0,ty=0;
   if(near){const dx=p.x-(box.left+box.width/2),dy=p.y-(box.top+box.height*.45),d=Math.hypot(dx,dy)||1,reach=Math.min(1,d/(box.width*2+60));tx=dx/d*reach;ty=dy/d*reach;}
   const s=springs.get(node)||{x:0,vx:0,y:0,vy:0};springs.set(node,s);
   // Critically damped: v += (-2ζω·v - ω²(x - target))·dt with ζ = 1, in fixed 1/120 s steps.
   for(let t=0;t<dt;t+=STEP){const h=Math.min(STEP,dt-t);s.vx+=(-2*OMEGA*s.vx-OMEGA*OMEGA*(s.x-tx))*h;s.x+=s.vx*h;s.vy+=(-2*OMEGA*s.vy-OMEGA*OMEGA*(s.y-ty))*h;s.y+=s.vy*h;}
   if(!near&&Math.abs(s.x)+Math.abs(s.y)<.003&&Math.abs(s.vx)+Math.abs(s.vy)<.02){springs.delete(node);for(const k of ['--plush-gx','--plush-gy','--plush-lean'])node.style.removeProperty(k);delete node.dataset.tracking;continue;}
   moving=true;node.dataset.tracking='true';const reach=node.dataset.character==='lens'?3:4.5;
   node.style.setProperty('--plush-gx',`${(s.x*reach).toFixed(2)}px`);node.style.setProperty('--plush-gy',`${(s.y*reach*.6).toFixed(2)}px`);node.style.setProperty('--plush-lean',`${(s.x*4).toFixed(2)}deg`);
  }
  if(moving||near)state.frame=win.requestAnimationFrame(state.step);
 };
 doc.addEventListener('pointermove',state.onPointer,{passive:true});
}
function mount(root){
 const doc=root.ownerDocument||globalThis.document;if(!doc)return ()=>{};
 let state=documents.get(doc);
 if(!state){state={roots:new Map(),onChange:null,frame:0};state.onChange=()=>{for(const r of state.roots.keys())for(const node of r.querySelectorAll('.dgc-plush'))node.dataset.hidden=String(doc.hidden);};documents.set(doc,state);doc.addEventListener('visibilitychange',state.onChange);follow(doc,state);}
 state.roots.set(root,(state.roots.get(root)||0)+1);state.onChange();let done=false;
 return ()=>{if(done)return;done=true;const n=state.roots.get(root)||0;if(n<=1)state.roots.delete(root);else state.roots.set(root,n-1);if(!state.roots.size){doc.removeEventListener('visibilitychange',state.onChange);if(state.onPointer)doc.removeEventListener('pointermove',state.onPointer);if(state.frame)doc.defaultView?.cancelAnimationFrame?.(state.frame);documents.delete(doc);}};
}
globalThis.PipConcepts=globalThis.PipConcepts||{};
globalThis.PipConcepts.plush=Object.freeze({version:1,styles,markup,mount});
})();

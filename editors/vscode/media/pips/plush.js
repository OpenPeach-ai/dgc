/* DGC plush renderer: the eight Pips from one transparent WebP atlas.
 * All eight states use one local atlas and SVG eye overlays. No graphics contexts,
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
const script=globalThis.document?.currentScript?.src;
const asset=script?new URL('../media/pips/plush-bodies.webp',script).href:'../media/pips/plush-bodies.webp';
const styles=`
.dgc-plush{display:inline-block;position:relative;width:100%;height:100%;vertical-align:middle;isolation:isolate}
.dgc-plush-rig{display:block;width:100%;height:100%;overflow:hidden;transform-origin:50% 80%;animation:dgc-plush-breathe 6.7s ease-in-out var(--plush-delay) infinite}
.dgc-plush-eye{transform-box:fill-box;transform-origin:center;animation:dgc-plush-blink 5.3s ease-in-out var(--plush-delay) infinite}
.dgc-plush[data-state=listening] .dgc-plush-rig{animation-name:dgc-plush-listen;animation-duration:4.7s}
.dgc-plush[data-state=thinking] .dgc-plush-rig{animation-name:dgc-plush-think;animation-duration:5.2s}
.dgc-plush[data-state=working] .dgc-plush-rig{animation-name:dgc-plush-work;animation-duration:2.7s}
.dgc-plush[data-state=waiting_approval] .dgc-plush-rig{animation-name:dgc-plush-listen;animation-duration:5.7s}
.dgc-plush[data-state=success] .dgc-plush-rig{animation-name:dgc-plush-success;animation-duration:3.7s}
.dgc-plush[data-state=failure] .dgc-plush-rig{animation-name:dgc-plush-think;animation-duration:7s}
.dgc-plush[data-state=offline] .dgc-plush-rig{animation:none;opacity:.72}
.dgc-plush[data-state=offline] .dgc-plush-eye,.dgc-plush[data-state=success] .dgc-plush-eye{animation:none}
@keyframes dgc-plush-breathe{0%,100%{transform:translateY(0) rotate(-1deg)}50%{transform:translateY(-2%) rotate(1deg)}}
@keyframes dgc-plush-listen{0%,100%{transform:rotate(-4deg)}50%{transform:translateY(-2%) rotate(3deg)}}
@keyframes dgc-plush-think{0%,100%{transform:rotate(-2deg)}45%,60%{transform:rotate(3deg)}}
@keyframes dgc-plush-work{0%,100%{transform:translateY(0) rotate(-1deg)}50%{transform:translateY(-3%) rotate(1deg)}}
@keyframes dgc-plush-success{0%,65%,100%{transform:translateY(0)}20%{transform:translateY(-5%) rotate(2deg)}35%{transform:translateY(0) rotate(-1deg)}}
@keyframes dgc-plush-blink{0%,89%,97%,100%{transform:scaleY(1)}92%,94%{transform:scaleY(.08)}}
.dgc-plush[data-paused=true] *,.dgc-plush[data-hidden=true] *,[data-pip-motion=paused] .dgc-plush *,.motion-paused .dgc-plush *,.motion-offscreen .dgc-plush *{animation-play-state:paused!important}
@media(prefers-reduced-motion:reduce){.dgc-plush *{animation:none!important;transition:none!important}}
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
 return `${options.includeStyles===false?'':`<style>${styles}</style>`}<span class="dgc-plush" data-state="${state}" data-character="${ids[i]}" data-name="${escape(pip.name||ids[i])}" data-paused="${options.paused===true}" aria-hidden="true" style="--plush-delay:${-i*.59}s"><svg class="dgc-plush-rig" viewBox="${crops[i].join(' ')}" aria-hidden="true"><image href="${escape(asset)}" width="1660" height="948"/><g transform="translate(${i%4*415} ${i<4?0:474}) scale(4.15 4.74)">${clip}<g fill="none" stroke="#fff" stroke-linecap="round"${lens?` clip-path="url(#${uid}-lenses)"`:''}>${eyes}</g></g></svg></span>`;
}
// A shared visibility subscription per document; releasing a caller releases only
// its own rigs. No listeners or animation loops are created by markup().
const documents=new WeakMap();
function mount(root){
 const doc=root.ownerDocument||globalThis.document;if(!doc)return ()=>{};
 let state=documents.get(doc);
 if(!state){state={roots:new Map(),onChange:null};state.onChange=()=>{for(const r of state.roots.keys())for(const node of r.querySelectorAll('.dgc-plush'))node.dataset.hidden=String(doc.hidden);};documents.set(doc,state);doc.addEventListener('visibilitychange',state.onChange);}
 state.roots.set(root,(state.roots.get(root)||0)+1);state.onChange();let done=false;
 return ()=>{if(done)return;done=true;const n=state.roots.get(root)||0;if(n<=1)state.roots.delete(root);else state.roots.set(root,n-1);if(!state.roots.size){doc.removeEventListener('visibilitychange',state.onChange);documents.delete(doc);}};
}
globalThis.PipConcepts=globalThis.PipConcepts||{};
globalThis.PipConcepts.plush=Object.freeze({version:1,styles,markup,mount});
})();

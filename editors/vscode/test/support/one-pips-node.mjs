// The Pips view in jsdom, as the side bar's main.js mounts it (in a shadow root), on the stand-in DGC of
// test/support/one-pips-scene.mjs. Shared by the One Pips node tests. Not a *.test.mjs file: the caller closes `w`.
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
import {makeBackend,HERE} from './one-pips-scene.mjs';

const src=fileURLToPath(new URL('../../src/',import.meta.url));
const client=(await build({entryPoints:[src+'pipsClient.js'],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

/** `api`: the Pips API the DGC says; `saved`: the view's saved state; `scene`: makeBackend's options;
 *  `host`: extra mount options (onAskDgc and the like). */
export function setup({api=94,saved,scene={},host={},pre=[]}={}){
 const dom=new JSDOM('<!doctype html><html><body><div id="pips-host"></div></body></html>',{runScripts:'outside-only',pretendToBeVisual:true}),w=dom.window;
 const sent=[],answered=new Set(),listeners=new Set(),states=[],backend=makeBackend(scene);
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.CSS={escape:s=>s};
 for(const script of pre)w.eval(script);   // (scripts the page loads before the Pips view: the voice bar, read aloud, voice mode)
 w.eval(client);
 const shadow=w.document.getElementById('pips-host').attachShadow({mode:'open'});
 const app=w.DgcPips.mount({root:shadow,postMessage:m=>sent.push(m),onMessage:l=>{listeners.add(l);return()=>listeners.delete(l);},getState:()=>saved,setState(s){states.push(s);},...host});
 const message=data=>listeners.forEach(l=>l(data));
 async function drain(){
  for(let n=0;n<25;n++){
   await flush();
   for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){
    answered.add(m.id);const result=backend.answer(m.request);if(result===undefined)continue;   // (one it has no answer for is left waiting, asked once)
    message(result?.error?{type:'pipsReply',id:m.id,ok:false,error:result.error}:{type:'pipsReply',id:m.id,ok:true,result});
   }
  }
  await flush();
 }
 message({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:true,enabled:true,folder:true,projectFolder:'',home:'/home/me',windowFolder:{folder:HERE,name:'shop'}});
 const $=s=>shadow.querySelector(s),$$=s=>[...shadow.querySelectorAll(s)];
 const squash=value=>String(value||'').split(/\s+/).join(' ');
 const text=(s='.pip-app-root')=>squash(shadow.querySelector(s)?.textContent);
 // (The dialog is drawn in the view's own root.)
 const dialog=()=>shadow.querySelector('#review-root .dialog');
 const requests=type=>backend.state.requests.filter(r=>!type||r.type===type);
 const rows=()=>$$('.pips-one-list [data-job]').map(r=>r.dataset.job);
 const over=(el,type,related=null)=>el.dispatchEvent(new w.MouseEvent(type,{bubbles:true,composed:true,relatedTarget:related}));
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const choose=async value=>{$('#pips-filter').click();await drain();[...shadow.querySelectorAll('.dgc-folder-menu [role="menuitemradio"]')].find(r=>r.dataset.folder===value).click();await drain();};
 /** A Pip's chat, opened from its row in the one list. */
 const openPip=async id=>{$(`.pips-one-list [data-job="${id}"]`).click();await drain();};
 /** One of its pages, from its header's menu. */
 const menu=async tab=>{[...shadow.querySelectorAll('.pip-topbar .pip-menu [data-tab]')].find(b=>b.dataset.tab===tab).click();await drain();};
 const type=(el,value)=>{el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true,composed:true}));};
 return {w,d:shadow,$,$$,app,sent,drain,text,squash,states,backend,state:backend.state,requests,rows,over,wait,message,choose,openPip,menu,type,dialog,posted:kind=>JSON.parse(JSON.stringify(sent.filter(m=>m.type===kind)))};
}

// Named model routes belong to the editor. Metadata may be shown in a webview;
// credentials stay in VS Code SecretStorage and are bound to an immutable URL.
import {randomBytes} from 'node:crypto';

const STATE_KEY='dgc.modelProviders.v1', DEFAULT_KEY='dgc.defaultModelProvider.v1', MAX=12;
const ID=/^provider_[a-f0-9]{32}$/;
const SUBSCRIPTION_ID=/^subscription_(claude|codex)$/;
const MODES=new Set(['auto','ollama','anthropic','chat_completions','responses']);
const secretKey=id=>`dgc.modelProvider.${id}.apiKey`;

export function validRoute(raw){
 if(!raw||typeof raw!=='object')throw Error('Choose a provider.');
 if(raw.kind==='subscription'){
  const engine=String(raw.engine||'');
  if(!['claude','codex'].includes(engine))throw Error('Choose Claude Code or Codex.');
  const model=String(raw.model||'').trim();
  if(model.length>128||/[^A-Za-z0-9._:-]/.test(model))throw Error('Choose a valid subscription model.');
  return {kind:'subscription',engine,name:engine==='claude'?'Claude Code':'Codex',model};
 }
 const name=String(raw.name||'').trim(),model=String(raw.model||'').trim();
 if(!name||name.length>64||/[\x00-\x1f\x7f]/.test(name))throw Error('Use a provider name of up to 64 characters.');
 if(!model||model.length>256||/[\x00-\x1f\x7f]/.test(model))throw Error('Choose one model for this provider.');
 let url;
 try{url=new URL(String(raw.base_url||''));}catch{throw Error('Enter a valid model host URL.');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash
    ||url.toString().length>2048)throw Error('Use a plain HTTP or HTTPS model host URL without credentials or query text.');
 const api_mode=String(raw.api_mode||'auto');
 if(!MODES.has(api_mode))throw Error('Choose a supported model API.');
 return {name,base_url:url.toString().replace(/\/$/,''),model,api_mode};
}

export function listProfiles(context){
 const rows=context.globalState.get(STATE_KEY,[]);
 if(!Array.isArray(rows))return [];
 const valid=[];
 for(const row of rows){
  if(!row||!(ID.test(row.id)||SUBSCRIPTION_ID.test(row.id)))continue;
  try{const clean=validRoute(row);if(Object.keys(clean).every(key=>clean[key]===row[key]))valid.push({id:row.id,...clean});}catch{}
 }
 return valid.slice(0,MAX);
}

export function defaultProfileId(context){
 const id=context.globalState.get(DEFAULT_KEY,'');
 return listProfiles(context).some(row=>row.id===id)?id:'';
}

export async function markDefaultProfile(context,id){
 if(!listProfiles(context).some(row=>row.id===id))throw Error('Provider not found.');
 await context.globalState.update(DEFAULT_KEY,id);
}

export async function clearDefaultProfile(context){
 await context.globalState.update(DEFAULT_KEY,'');
}

export async function addProfile(context,raw){
 const route=validRoute(raw),key=String(raw.api_key||'');
 if(route.kind==='subscription'&&key)throw Error('A subscription uses its own signed-in CLI, not an API key.');
 if(key.length>16384||/[\x00-\x1f\x7f]/.test(key))throw Error('The API key must be a single line of at most 16 KiB.');
 const current=listProfiles(context);
 if(current.length>=MAX)throw Error('Remove a saved provider before adding another.');
 if(route.kind==='subscription'&&current.some(row=>row.engine===route.engine))throw Error('This subscription is already added.');
 const row={id:route.kind==='subscription'?`subscription_${route.engine}`:`provider_${randomBytes(16).toString('hex')}`,...route};
 if(key)await context.secrets.store(secretKey(row.id),key);
 try{await context.globalState.update(STATE_KEY,[...current,row]);}
 catch(error){if(key)await context.secrets.delete(secretKey(row.id));throw error;}
 return row;
}

/**
 * An upgrade: this computer already runs on a model set before saved providers existed (`dgc setup`, or an older
 * editor). The first provider added must not take that over: it moved the default and hid the working model from every
 * menu, and a Pip on that model then had no connection. A host that needs no key becomes a saved provider, as it is,
 * and stays the default. A key lives in DGC's own store, which the editor can't read, so that route isn't adopted; it
 * stays the default all the same (firstTakesDefault). `ready`: the backend's ready event. `presets`: the host presets.
 */
export async function adoptWorkingRoute(context,ready,presets){
 const saved=ready?.capabilities?.saved_route;
 if(ready?.capabilities?.model_chosen!==true||!saved||saved.builtin===true||listProfiles(context).length||String(saved.subscription_engine||''))return null;
 const base=String(saved.base_url||'').replace(/\/$/,''),model=String(saved.model||'');
 const preset=Object.values(presets||{}).find(row=>row?.url===base);
 if(!model||!preset||preset.needsKey)return null;
 const added=await addProfile(context,{name:preset.label,base_url:base,model,api_mode:String(saved.api_mode||'auto')});
 await markDefaultProfile(context,added.id);
 return added;
}

/** Whether the provider being added becomes the default: only when nothing chose a model yet. An older CLI doesn't say. */
export function firstTakesDefault(context,ready){
 return !defaultProfileId(context)&&(ready?.capabilities?.model_chosen!==true||ready?.capabilities?.saved_route?.builtin===true);
}

export async function removeProfile(context,id){
 if(!(ID.test(String(id||''))||SUBSCRIPTION_ID.test(String(id||''))))throw Error('Unknown provider.');
 if(defaultProfileId(context)===id)throw Error('Choose another default before removing this provider.');
 const rows=listProfiles(context);
 if(!rows.some(row=>row.id===id))throw Error('Provider not found.');
 await context.globalState.update(STATE_KEY,rows.filter(row=>row.id!==id));
 if(ID.test(id))await context.secrets.delete(secretKey(id));
}

export async function profileCredential(context,id){
 const row=listProfiles(context).find(row=>row.id===id);
 if(!row)throw Error('Provider not found. Open Settings and add it again.');
 return {route:row,api_key:row.kind==='subscription'?'':await context.secrets.get(secretKey(id))||''};
}

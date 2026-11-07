// Named model routes belong to the editor. Metadata may be shown in a webview;
// credentials stay in VS Code SecretStorage and are bound to an immutable URL.
import {randomBytes} from 'node:crypto';

const STATE_KEY='dgc.modelProviders.v1', DEFAULT_KEY='dgc.defaultModelProvider.v1', DEFAULT_MODEL_KEY='dgc.defaultModelProvider.model.v1', MAX=12;
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
 // No model: "All models". Each chat, or a Pip, chooses from what the host lists; the default names its own (defaultModel).
 if(model.length>256||/[\x00-\x1f\x7f]/.test(model))throw Error('Use a model name of up to 256 characters.');
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

const needsModel=row=>row.kind!=='subscription'&&!row.model;

export function defaultProfileId(context){
 const id=context.globalState.get(DEFAULT_KEY,'');
 const row=listProfiles(context).find(row=>row.id===id);
 // An All models provider is the default only with its model: nothing ever runs on no model.
 return row&&(!needsModel(row)||context.globalState.get(DEFAULT_MODEL_KEY,''))?id:'';
}

/** The model a chat starts on when it follows this provider: its own, or for an All models default the one chosen for it. */
export function startingModel(context,row){
 if(!row||row.model||row.kind==='subscription')return row?.model||'';
 return defaultProfileId(context)===row.id?String(context.globalState.get(DEFAULT_MODEL_KEY,'')):'';
}

/** The default, and its model. An All models provider keeps saying All models, with the default's model beside it. A
 *  provider with a model of its own, or a subscription (blank: the CLI's default), takes this as that model. */
export async function markDefaultProfile(context,id,model){
 const rows=listProfiles(context),row=rows.find(row=>row.id===id);
 if(!row)throw Error('Provider not found.');
 const chosen=model===undefined?row.model:String(model).trim();
 if(needsModel(row)&&!chosen)throw Error('Choose a model for this provider.');
 if(!needsModel(row)&&chosen!==row.model){
  const changed={...row,model:chosen};validRoute(changed);
  await context.globalState.update(STATE_KEY,rows.map(other=>other.id===id?changed:other));
 }
 await context.globalState.update(DEFAULT_MODEL_KEY,needsModel(row)?chosen:'');
 await context.globalState.update(DEFAULT_KEY,id);
}

export async function clearDefaultProfile(context){
 await context.globalState.update(DEFAULT_KEY,'');
 await context.globalState.update(DEFAULT_MODEL_KEY,'');
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

/** Before another provider becomes the default: the route DGC runs on now, when no saved provider is it, is saved as one
 *  (not the default), so choosing another default never makes it vanish from the list with no word (final check, 2026-11-07:
 *  ticking a saved provider dropped the working Ollama row). A host whose key only DGC holds can't be saved here, as with
 *  adoptWorkingRoute. The saved provider, or null. */
export async function keepWorkingRoute(context,ready,presets){
 const saved=ready?.capabilities?.saved_route;
 if(defaultProfileId(context)||ready?.capabilities?.model_chosen!==true||!saved||saved.builtin===true||String(saved.subscription_engine||''))return null;
 const base=String(saved.base_url||'').replace(/\/$/,''),model=String(saved.model||'');
 const preset=Object.values(presets||{}).find(row=>row?.url===base);
 if(!model||!preset||preset.needsKey)return null;
 if(listProfiles(context).some(row=>String(row.base_url||'').replace(/\/$/,'')===base&&(!row.model||row.model===model)))return null;
 return addProfile(context,{name:preset.label,base_url:base,model,api_mode:String(saved.api_mode||'auto')});
}

/** Whether anything saved can run as it is: a subscription, a provider with a model, or an All models provider that was
 *  given its default model. One saved with no model and no default yet is not a provider to run on. */
export function hasRunnableProfile(context){
 return !!defaultProfileId(context)||listProfiles(context).some(row=>!needsModel(row));
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

// Named model routes belong to the editor. Metadata may be shown in a webview;
// credentials stay in VS Code SecretStorage and are bound to an immutable URL.
import {randomBytes} from 'node:crypto';

const STATE_KEY='dgc.modelProviders.v1', DEFAULT_KEY='dgc.defaultModelProvider.v1', MAX=12;
const ID=/^provider_[a-f0-9]{32}$/;
const MODES=new Set(['auto','ollama','anthropic','chat_completions','responses']);
const secretKey=id=>`dgc.modelProvider.${id}.apiKey`;

export function validRoute(raw){
 if(!raw||typeof raw!=='object')throw Error('Choose a provider.');
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
  if(!row||!ID.test(row.id))continue;
  try{const clean=validRoute(row);if(Object.keys(clean).every(key=>clean[key]===row[key]))valid.push(row);}catch{}
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
 if(key.length>16384||/[\x00-\x1f\x7f]/.test(key))throw Error('The API key must be a single line of at most 16 KiB.');
 const current=listProfiles(context);
 if(current.length>=MAX)throw Error('Remove a saved provider before adding another.');
 const row={id:`provider_${randomBytes(16).toString('hex')}`,...route};
 if(key)await context.secrets.store(secretKey(row.id),key);
 try{await context.globalState.update(STATE_KEY,[...current,row]);}
 catch(error){if(key)await context.secrets.delete(secretKey(row.id));throw error;}
 return row;
}

export async function removeProfile(context,id){
 if(!ID.test(String(id||'')))throw Error('Unknown provider.');
 if(defaultProfileId(context)===id)throw Error('Choose another default before removing this provider.');
 const rows=listProfiles(context);
 if(!rows.some(row=>row.id===id))throw Error('Provider not found.');
 await context.globalState.update(STATE_KEY,rows.filter(row=>row.id!==id));
 await context.secrets.delete(secretKey(id));
}

export async function profileCredential(context,id){
 const row=listProfiles(context).find(row=>row.id===id);
 if(!row)throw Error('Provider not found. Open Settings and add it again.');
 return {route:row,api_key:await context.secrets.get(secretKey(id))||''};
}

// Connect a model provider by signing in, instead of pasting a key (17 Nov, 0.52): OpenRouter.
//
// The same sign-in as dgc/provider_connect.py, for Settings in the editor (the terminal uses that one; both are tested
// with RFC 7636's example pair). DGC opens OpenRouter's sign-in page in the browser with a PKCE challenge (S256); the
// person signs in and approves; OpenRouter sends the browser back to a one-time address on this computer with a code,
// and DGC trades the code, with the secret half of the challenge, for a key of the person's own, labelled "DGC". The key
// goes to VS Code's secret storage like a pasted one (providerProfiles.js). A code caught on its way back is useless
// without the secret half, which never leaves this process and never appears in an address.
//
// Over Remote-SSH or in a container, the editor runs here but the browser runs on the person's own computer: the host
// passes the one-time address through vscode.env.asExternalUri, which forwards it (`external` below).
import {createHash,randomBytes} from 'node:crypto';
import {createServer} from 'node:http';

export const OPENROUTER={
 auth:'https://openrouter.ai/auth',
 exchange:'https://openrouter.ai/api/v1/auth/keys',
 keyInfo:'https://openrouter.ai/api/v1/key',
 keysPage:'https://openrouter.ai/settings/keys',
 creditsPage:'https://openrouter.ai/settings/credits',
};
export const CODE_LIFE_MS=600000;     // OpenRouter's codes expire ten minutes after they are issued
const TIMEOUT_MS=15000, LABEL='DGC';

/** Why connecting didn't finish, in a sentence for the person. */
export class ConnectError extends Error {}

const b64url=bytes=>Buffer.from(bytes).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
/** The S256 challenge for a verifier. */
export function challengeOf(verifier){return b64url(createHash('sha256').update(String(verifier),'ascii').digest());}
/** A fresh {verifier, challenge}: 43 characters of unreserved text from 32 random bytes. */
export function pkcePair(){const verifier=b64url(randomBytes(32));return {verifier,challenge:challengeOf(verifier)};}

/** The sign-in page. With no callbackUrl, OpenRouter shows the code to type in (and sends no state back). */
export function authUrl(challenge,{callbackUrl='',state='',label=LABEL,site=OPENROUTER.auth}={}){
 const params=new URLSearchParams();
 if(callbackUrl)params.set('callback_url',callbackUrl);
 params.set('code_challenge',challenge);params.set('code_challenge_method','S256');params.set('key_label',label);
 if(callbackUrl&&state)params.set('state',state);
 return `${site}?${params}`;
}

const escapeHtml=text=>String(text).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const page=(title,text)=>`<!doctype html><meta charset=utf-8><title>DGC</title><body style="font:15px/1.5 system-ui,sans-serif;margin:15vh auto;max-width:28em;padding:0 16px"><h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body>`;

/**
 * The address the browser comes back to: http://localhost:<port>/callback, on the loopback addresses only. It answers
 * one request with the right state and a code (or OpenRouter's refusal), then stops listening. A request that names
 * another host (a page elsewhere pointing a name of its own at this computer) gets 421 and nothing else.
 */
export function oneTimeCallback(state){
 let port=0,done=false,code='',error='',resolve,servers=[];
 const finished=new Promise(r=>{resolve=r;});
 const handle=(req,res)=>{
  const host=String(req.headers.host||'').toLowerCase();
  if(![`localhost:${port}`,`127.0.0.1:${port}`,`[::1]:${port}`].includes(host)){res.writeHead(421,{'Content-Length':'0'});res.end();return;}
  const url=new URL(req.url||'/',`http://localhost:${port}`);
  const send=(status,title,text)=>{const body=page(title,text);res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end(body);};
  if(req.method!=='GET'||url.pathname!=='/callback'){send(404,'Not here','This address only finishes connecting DGC.');return;}
  if(done||url.searchParams.get('state')!==state){send(400,"This link doesn't match",'Start again from DGC: choose Connect there, and use the page it opens.');return;}
  const got=String(url.searchParams.get('code')||'').trim();
  if(!got){error="OpenRouter didn't connect DGC: the sign-in was cancelled or refused there.";send(200,'Not connected',"DGC wasn't connected. You can close this tab and try again from DGC.");}
  else{code=got;send(200,'DGC is connected to OpenRouter','You can close this tab and go back to DGC.');}
  done=true;resolve();
 };
 const close=()=>{for(const server of servers.splice(0)){try{server.close();server.closeAllConnections?.();}catch{}}};
 const listen=(host,at)=>new Promise((ok,fail)=>{const server=createServer(handle);server.once('error',fail);server.listen(at,host,()=>{servers.push(server);ok(server.address().port);});});
 return {
  get url(){return `http://localhost:${port}/callback`;},
  get port(){return port;},
  async start(){port=await listen('127.0.0.1',0);try{await listen('::1',port);}catch{/* no IPv6 loopback: the browser falls back to 127.0.0.1 */}return port;},
  /** The code once the browser is back; ConnectError when OpenRouter refused, nothing came in time, or `signal` aborted. */
  async wait(ms,signal){
   let timer;
   const timeout=new Promise((_,fail)=>{timer=setTimeout(()=>fail(new ConnectError("OpenRouter didn't send DGC back in time. Choose Connect again when you're ready.")),ms);});
   const aborted=new Promise((_,fail)=>{if(signal){if(signal.aborted)fail(new ConnectError('Connecting was cancelled.'));signal.addEventListener('abort',()=>fail(new ConnectError('Connecting was cancelled.')),{once:true});}});
   try{await Promise.race([finished,timeout,aborted]);}
   finally{clearTimeout(timer);close();}
   if(error)throw new ConnectError(error);
   return code;
  },
  close,
 };
}

async function readMessage(response){try{const body=await response.json();const e=body?.error;return String((e&&typeof e==='object'?e.message:e)||'').slice(0,200);}catch{return '';}}
const withTimeout=(fetchImpl,url,init)=>fetchImpl(url,{...init,redirect:'manual',signal:AbortSignal.timeout(TIMEOUT_MS)});

/** Trade the code and the verifier for the person's key. */
export async function exchange(code,verifier,{url=OPENROUTER.exchange,fetchImpl=fetch}={}){
 let response;
 try{response=await withTimeout(fetchImpl,url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,code_verifier:verifier,code_challenge_method:'S256'})});}
 catch{throw new ConnectError("DGC couldn't reach OpenRouter to finish connecting. Check the connection and Connect again.");}
 if(response.status===403){
  if(/expired/i.test(await readMessage(response)))throw new ConnectError('That sign-in took longer than OpenRouter allows (ten minutes). Connect again.');
  throw new ConnectError("OpenRouter didn't accept that sign-in. Connect again.");
 }
 if(response.status!==200)throw new ConnectError(`OpenRouter didn't hand DGC a key (HTTP ${response.status}). Connect again, or paste a key instead.`);
 let key;try{key=(await response.json())?.key;}catch{}
 if(typeof key!=='string'||!key.trim()||key.length>16384||/[\x00-\x1f\x7f]/.test(key.trim()))throw new ConnectError('OpenRouter answered without a key. Connect again, or paste a key instead.');
 return key.trim();
}

/** Whether a key works: {state: ok|signed_out|no_credit|unreachable, and when OpenRouter says: label, usage, limit,
 *  limit_remaining, limit_reset (daily, weekly, monthly or null: the usage meter's reset)}. Settings shows signed_out as "Connect again" and no_credit as "Top up". */
export async function keyState(key,{url=OPENROUTER.keyInfo,fetchImpl=fetch}={}){
 let response;
 try{response=await withTimeout(fetchImpl,url,{headers:{Authorization:`Bearer ${key}`}});}catch{return {state:'unreachable'};}
 if(response.status===401||response.status===403)return {state:'signed_out'};
 if(response.status===402)return {state:'no_credit'};
 if(response.status!==200)return {state:'unreachable'};
 let data={};try{data=(await response.json())?.data||{};}catch{}
 const out={state:'ok'};
 for(const name of ['label','usage','limit','limit_remaining','limit_reset'])if(name in data)out[name]=data[name];
 if(data.limit!=null&&typeof data.limit_remaining==='number'&&data.limit_remaining<=0)out.state='no_credit';
 return out;
}

/**
 * Sign in to OpenRouter and return the person's key. `external(localUrl)`: the address the person's browser can reach
 * (vscode.env.asExternalUri; the same address on a local window). `open(url)`: opens the browser (vscode.env.openExternal).
 */
export async function connectOpenRouter({external=async url=>url,open,signal,timeoutMs=CODE_LIFE_MS,site=OPENROUTER.auth,exchangeUrl=OPENROUTER.exchange,fetchImpl=fetch}={}){
 const {verifier,challenge}=pkcePair(),state=b64url(randomBytes(24));
 const callback=oneTimeCallback(state);
 await callback.start();
 try{
  const back=String(await external(callback.url));
  if(!/^https?:\/\//i.test(back))throw new ConnectError("DGC couldn't make an address for OpenRouter to come back to. Paste an OpenRouter key instead.");
  const address=authUrl(challenge,{callbackUrl:back,state,site});
  let opened=false;
  try{opened=!!(await open(address));}catch{}
  if(!opened)throw new ConnectError("DGC couldn't open your browser. Paste an OpenRouter key instead.");
  const code=await callback.wait(timeoutMs,signal);
  return await exchange(code,verifier,{url:exchangeUrl,fetchImpl});
 }finally{callback.close();}
}

// Connect OpenRouter by signing in, the editor's half (src/providerConnect.js, 17 Nov): the same values and behaviour
// as dgc/provider_connect.py's tests. A stand-in OpenRouter runs on this computer: nothing here reaches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {ConnectError,authUrl,challengeOf,connectOpenRouter,exchange,keyState,oneTimeCallback,pkcePair} from '../src/providerConnect.js';
import {addProfile,listProfiles,profileCredential,replaceKey} from '../src/providerProfiles.js';

// RFC 7636, appendix B. The Python tests use the same pair.
const RFC_VERIFIER='dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', RFC_CHALLENGE='E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

function get(port,path,host){
 return new Promise((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port,path,headers:{Host:host||`localhost:${port}`}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>resolve({status:res.statusCode,body}));});
  req.on('error',reject);req.end();
 });
}

async function standIn(){
 const s={exchange:[200,{key:'sk-or-v1-made-for-dgc'}],keyInfo:[200,{data:{label:'DGC',usage:1.5,limit:10,limit_remaining:8.5}}],seen:[]};
 const server=createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{
  s.seen.push({method:req.method,path:req.url,body:body?JSON.parse(body):null,auth:req.headers.authorization});
  const [status,answer]=req.method==='POST'?s.exchange:s.keyInfo;const text=JSON.stringify(answer);
  res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(text)});res.end(text);});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 s.base=`http://127.0.0.1:${server.address().port}`;s.close=()=>new Promise(r=>server.close(r));
 return s;
}

test('the RFC pair, and a fresh pair is unreserved text that matches',()=>{
 assert.equal(challengeOf(RFC_VERIFIER),RFC_CHALLENGE);
 const {verifier,challenge}=pkcePair();
 assert.match(verifier,/^[A-Za-z0-9._~-]{43,128}$/);
 assert.equal(challenge,challengeOf(verifier));
 assert.notEqual(pkcePair().verifier,verifier);
});

test('the sign-in page: with a callback it carries the state; without one OpenRouter shows the code',()=>{
 const url=new URL(authUrl(RFC_CHALLENGE,{callbackUrl:'http://localhost:51423/callback',state:'s1'}));
 assert.equal(url.origin+url.pathname,'https://openrouter.ai/auth');
 assert.equal(url.searchParams.get('callback_url'),'http://localhost:51423/callback');
 assert.equal(url.searchParams.get('code_challenge'),RFC_CHALLENGE);
 assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 assert.equal(url.searchParams.get('key_label'),'DGC');
 assert.equal(url.searchParams.get('state'),'s1');
 const bare=new URL(authUrl(RFC_CHALLENGE));
 assert.equal(bare.searchParams.has('callback_url'),false);
 assert.equal(bare.searchParams.has('state'),false);
});

test('the one-time address takes the right state, refuses the rest, and closes after one code',async()=>{
 const back=oneTimeCallback('right-state');
 const port=await back.start();
 assert.equal(back.url,`http://localhost:${port}/callback`);
 assert.equal((await get(port,'/callback?code=evil&state=other')).status,400);
 assert.equal((await get(port,'/callback?code=abc&state=right-state','evil.example')).status,421);
 assert.equal((await get(port,'/other?code=abc&state=right-state')).status,404);
 const ok=await get(port,'/callback?code=good&state=right-state');
 assert.equal(ok.status,200);
 assert.match(ok.body,/connected/i);
 assert.equal(await back.wait(5000),'good');
 await assert.rejects(get(port,'/callback?code=two&state=right-state'));
});

test('a refusal on OpenRouter, no answer in time, and Cancel each end the wait with words',async()=>{
 const refused=oneTimeCallback('s');const port=await refused.start();
 await get(port,'/callback?error=access_denied&state=s');
 await assert.rejects(refused.wait(5000),e=>e instanceof ConnectError&&/didn't/.test(e.message));
 const slow=oneTimeCallback('s');await slow.start();
 await assert.rejects(slow.wait(150),/in time/);
 const cancelled=oneTimeCallback('s');await cancelled.start();const stop=new AbortController();
 setTimeout(()=>stop.abort(),50);
 await assert.rejects(cancelled.wait(5000,stop.signal),/cancelled/);
});

test('a code and its verifier become the key; a refused code says why without the verifier',async()=>{
 const s=await standIn();
 try{
  assert.equal(await exchange('abc123',RFC_VERIFIER,{url:s.base+'/api/v1/auth/keys'}),'sk-or-v1-made-for-dgc');
  assert.deepEqual(s.seen.at(-1).body,{code:'abc123',code_verifier:RFC_VERIFIER,code_challenge_method:'S256'});
  s.exchange=[403,{error:{message:'Invalid code or code_verifier'}}];
  await assert.rejects(exchange('bad',RFC_VERIFIER,{url:s.base+'/api/v1/auth/keys'}),e=>/Connect again/.test(e.message)&&!e.message.includes(RFC_VERIFIER));
  s.exchange=[403,{error:{message:'Authorization code expired'}}];
  await assert.rejects(exchange('old',RFC_VERIFIER,{url:s.base+'/api/v1/auth/keys'}),/ten minutes/);
  s.exchange=[200,{nothing:true}];
  await assert.rejects(exchange('abc',RFC_VERIFIER,{url:s.base+'/api/v1/auth/keys'}),/without a key/);
 }finally{await s.close();}
});

test("a key's state: working, signed out, out of credit, no limit, unreachable",async()=>{
 const s=await standIn();const url=s.base+'/api/v1/key';
 try{
  const ok=await keyState('sk-or-v1-x',{url});
  assert.equal(ok.state,'ok');assert.equal(ok.limit_remaining,8.5);assert.equal(s.seen.at(-1).auth,'Bearer sk-or-v1-x');
  s.keyInfo=[401,{error:{message:'No auth credentials found'}}];assert.equal((await keyState('k',{url})).state,'signed_out');
  s.keyInfo=[402,{error:{message:'Insufficient credits'}}];assert.equal((await keyState('k',{url})).state,'no_credit');
  s.keyInfo=[200,{data:{usage:10,limit:10,limit_remaining:0}}];assert.equal((await keyState('k',{url})).state,'no_credit');
  s.keyInfo=[200,{data:{usage:12.4,limit:null,limit_remaining:null}}];assert.equal((await keyState('k',{url})).state,'ok');
 }finally{await s.close();}
 assert.equal((await keyState('k',{url:'http://127.0.0.1:9/api/v1/key'})).state,'unreachable');
});

test('Connect: the browser opens the page, comes back through the forwarded address, and the key arrives',async()=>{
 const s=await standIn();
 try{
  const forwarded=[],opened=[];
  const key=await connectOpenRouter({
   external:async url=>{forwarded.push(url);return url;},
   open:async url=>{opened.push(url);const u=new URL(url),back=new URL(u.searchParams.get('callback_url'));
    setTimeout(()=>get(+back.port,`${back.pathname}?code=c1&state=${u.searchParams.get('state')}`),20);return true;},
   exchangeUrl:s.base+'/api/v1/auth/keys',timeoutMs:5000});
  assert.equal(key,'sk-or-v1-made-for-dgc');
  assert.equal(forwarded.length,1);assert.match(forwarded[0],/^http:\/\/localhost:\d+\/callback$/);
  assert.equal(opened.length,1);assert.equal(s.seen.at(-1).body.code,'c1');
 }finally{await s.close();}
});

test("Connect when the browser won't open, or the address can't be made, says to paste a key",async()=>{
 await assert.rejects(connectOpenRouter({open:async()=>false,timeoutMs:500}),/Paste an OpenRouter key/);
 await assert.rejects(connectOpenRouter({external:async()=>'vscode://nope',open:async()=>true,timeoutMs:500}),/Paste an OpenRouter key/);
});

function store(){
 const state=new Map(),secrets=new Map();
 return {secrets,ctx:{globalState:{get:(k,f)=>state.get(k)??f,update:async(k,v)=>{state.set(k,v);}},
  secrets:{get:async k=>secrets.get(k),store:async(k,v)=>{secrets.set(k,v);},delete:async k=>{secrets.delete(k);}}}};
}

test('Connect again replaces the saved key in place: same provider, same id',async()=>{
 const {ctx}=store();
 const row=await addProfile(ctx,{name:'OpenRouter',base_url:'https://openrouter.ai/api/v1',model:'',api_key:'sk-or-old'});
 await replaceKey(ctx,row.id,'sk-or-new');
 assert.equal((await profileCredential(ctx,row.id)).api_key,'sk-or-new');
 assert.deepEqual(listProfiles(ctx).map(r=>r.id),[row.id]);
 await assert.rejects(replaceKey(ctx,'provider_'+'0'.repeat(32),'k'),/not found/i);
 await assert.rejects(replaceKey(ctx,row.id,''),/key/i);
 const sub=await addProfile(ctx,{kind:'subscription',engine:'codex',model:''});
 await assert.rejects(replaceKey(ctx,sub.id,'k'),/subscription/i);
});

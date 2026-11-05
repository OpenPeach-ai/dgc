import test from 'node:test';
import assert from 'node:assert/strict';
import {addProfile,defaultProfileId,listProfiles,markDefaultProfile,profileCredential,removeProfile,validRoute} from '../src/providerProfiles.js';

function store(){
 const state=new Map(),secrets=new Map();
 return {state,secrets,globalState:{get:(key,fallback)=>state.get(key)??fallback,
   update:async(key,value)=>{state.set(key,value);}},
   secretsApi:{get:async key=>secrets.get(key),store:async(key,value)=>{secrets.set(key,value);},
   delete:async key=>{secrets.delete(key);}}};
}

test('saved providers list metadata without exposing their key',async()=>{
 const s=store(),ctx={globalState:s.globalState,secrets:s.secretsApi};
 const profile=await addProfile(ctx,{name:'My vLLM',base_url:'http://192.168.1.5:8000/v1',
   model:'qwen3:8b',api_mode:'chat_completions',api_key:'private-token'});
 assert.equal(listProfiles(ctx).length,1);
 assert.doesNotMatch(JSON.stringify(listProfiles(ctx)),/private-token/);
 assert.equal((await profileCredential(ctx,profile.id)).api_key,'private-token');
 await removeProfile(ctx,profile.id);
 assert.deepEqual(listProfiles(ctx),[]);
 assert.equal(s.secrets.size,0);
});

test('a provider URL cannot carry a secret or redirecting query',()=>{
 for(const base_url of ['https://user:pass@host.test/v1','https://host.test/v1?key=secret',
                         'https://host.test/v1#fragment','file:///private/model']){
  assert.throws(()=>validRoute({name:'Host',base_url,model:'one'}));
 }
});

test('a signed-in CLI is a provider with no host or API key',async()=>{
 const s=store(),ctx={globalState:s.globalState,secrets:s.secretsApi};
 const row=await addProfile(ctx,{kind:'subscription',engine:'claude',model:''});
 assert.equal(row.id,'subscription_claude');
 assert.deepEqual(await profileCredential(ctx,row.id),{route:row,api_key:''});
 await assert.rejects(addProfile(ctx,{kind:'subscription',engine:'claude'}),/already added/);
 await assert.rejects(addProfile(ctx,{kind:'subscription',engine:'codex',api_key:'secret'}),/not an API key/);
 assert.equal(s.secrets.size,0);
 await removeProfile(ctx,row.id);
 assert.deepEqual(listProfiles(ctx),[]);
});

test('the chosen default cannot be removed while future chats use it',async()=>{
 const s=store(),ctx={globalState:s.globalState,secrets:s.secretsApi};
 const first=await addProfile(ctx,{name:'Ollama',base_url:'http://localhost:11434/v1',model:'one'});
 const second=await addProfile(ctx,{name:'vLLM',base_url:'http://localhost:8000/v1',model:'two'});
 await markDefaultProfile(ctx,first.id);
 assert.equal(defaultProfileId(ctx),first.id);
 await assert.rejects(removeProfile(ctx,first.id),/another default/);
 await markDefaultProfile(ctx,second.id);
 await removeProfile(ctx,first.id);
 assert.equal(defaultProfileId(ctx),second.id);
});

test('corrupted saved metadata cannot reach the model picker or secret lookup',async()=>{
 const s=store(),ctx={globalState:s.globalState,secrets:s.secretsApi};
 s.state.set('dgc.modelProviders.v1',[{id:'provider_'+'a'.repeat(32),name:'bad',
  base_url:'https://user:secret@example.test/v1',model:'one',api_mode:'auto'}]);
 assert.deepEqual(listProfiles(ctx),[]);
 await assert.rejects(profileCredential(ctx,'provider_'+'a'.repeat(32)),/not found/);
});

test('saved provider metadata is projected to reviewed fields before reaching the webview',async()=>{
 const s=store(),ctx={globalState:s.globalState,secrets:s.secretsApi};
 const row=await addProfile(ctx,{name:'Ollama',base_url:'http://localhost:11434/v1',model:'one'});
 const expected={...row};
 s.state.get('dgc.modelProviders.v1')[0].api_key='unexpected-secret';
 assert.deepEqual(listProfiles(ctx),[expected]);
 assert.doesNotMatch(JSON.stringify(listProfiles(ctx)),/unexpected-secret/);
});

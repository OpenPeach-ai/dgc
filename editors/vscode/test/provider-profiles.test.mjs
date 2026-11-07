import test from 'node:test';
import assert from 'node:assert/strict';
import {addProfile,adoptWorkingRoute,defaultProfileId,firstTakesDefault,keepWorkingRoute,hasRunnableProfile,listProfiles,markDefaultProfile,profileCredential,removeProfile,startingModel,validRoute} from '../src/providerProfiles.js';

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

const PRESETS={ollama:{url:'http://localhost:11434/v1',needsKey:false,label:'Ollama (local)'},openai:{url:'https://api.openai.com/v1',needsKey:true,label:'OpenAI'}};
const fresh=()=>{const s=store();return {globalState:s.globalState,secrets:s.secretsApi};};
const ready=(saved={},caps={})=>({capabilities:{model_chosen:true,saved_route:{model:'deepseek-v4.1-flash:cloud',base_url:'http://localhost:11434/v1',api_mode:'auto',subscription_engine:'',...saved},...caps}});

test('an upgrade keeps its working model: it becomes a saved provider and stays the default',async()=>{
 const ctx=fresh();
 const adopted=await adoptWorkingRoute(ctx,ready(),PRESETS);
 assert.equal(adopted.name,'Ollama (local)');
 assert.deepEqual(listProfiles(ctx).map(row=>[row.name,row.base_url,row.model]),[['Ollama (local)','http://localhost:11434/v1','deepseek-v4.1-flash:cloud']]);
 assert.equal(defaultProfileId(ctx),adopted.id);
 assert.equal(firstTakesDefault(ctx,ready()),false,'the next provider added does not take over');
 assert.equal(await adoptWorkingRoute(ctx,ready(),PRESETS),null,'only once');
 assert.equal(listProfiles(ctx).length,1);
 assert.equal((await profileCredential(ctx,adopted.id)).api_key,'');
});

test('choosing another default keeps the working route in the list: it is saved, not lost (final check, 2026-11-07)',async()=>{
 const ctx=fresh();
 const other=await addProfile(ctx,{name:'Stand-in host',base_url:'http://127.0.0.1:18910/v1',model:'',api_mode:'auto'});
 assert.equal(await adoptWorkingRoute(ctx,ready(),PRESETS),null,'not at first look: a provider was already saved');
 const kept=await keepWorkingRoute(ctx,ready(),PRESETS);
 assert.equal(kept.name,'Ollama (local)');
 assert.deepEqual(listProfiles(ctx).map(row=>[row.name,row.model]),[['Stand-in host',''],['Ollama (local)','deepseek-v4.1-flash:cloud']]);
 assert.ok(!defaultProfileId(ctx),"it is kept; which is the default is still the user's choice");
 assert.equal(await keepWorkingRoute(ctx,ready(),PRESETS),null,'once');
 await markDefaultProfile(ctx,other.id,'beta-2');
 assert.equal(await keepWorkingRoute(ctx,ready({model:'other'}),PRESETS),null,'a saved provider is the default: nothing to keep');
 const loopback=fresh();
 const kept127=await keepWorkingRoute(loopback,ready({base_url:'http://127.0.0.1:11434/v1'}),PRESETS);
 assert.equal(kept127?.name,'Ollama (local)','127.0.0.1 is the same Ollama as localhost');
 const own=fresh();
 const keptOwn=await keepWorkingRoute(own,ready({base_url:'http://127.0.0.1:18911/v1',model:'my-model'}),PRESETS);
 assert.equal(keptOwn?.name,'This computer','a server of your own on this computer is kept too');
 assert.equal(await keepWorkingRoute(fresh(),ready({base_url:'http://192.168.1.9:8000/v1'}),PRESETS),null,'a host elsewhere may need a key');
 const keyedCtx=fresh();
 assert.equal(await keepWorkingRoute(keyedCtx,ready({base_url:'https://api.openai.com/v1',model:'some-model'}),PRESETS),null,'a key only DGC holds');
 const source=(await import('node:fs')).readFileSync(new URL('../src/panel.ts',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('private async setDefaultProvider('));
 assert.ok(body.indexOf('keepWorkingRoute(')>0&&body.indexOf('keepWorkingRoute(')<body.indexOf('set_model_defaults'),'kept before the default moves');
});

test('a route with a key is not adopted, because the editor cannot read it, and still stays the default',async()=>{
 const ctx=fresh();
 const keyed=ready({base_url:'https://api.openai.com/v1',model:'some-model'});
 assert.equal(await adoptWorkingRoute(ctx,keyed,PRESETS),null);
 assert.deepEqual(listProfiles(ctx),[]);
 assert.equal(firstTakesDefault(ctx,keyed),false,'the first provider added does not move it');
 const unknown=ready({base_url:'http://192.168.1.9:8000/v1'});
 assert.equal(await adoptWorkingRoute(ctx,unknown,PRESETS),null,'an unknown host may need a key');
 assert.equal(firstTakesDefault(ctx,unknown),false);
});

test('nothing chose a model: nothing is adopted, and the first provider becomes the default',async()=>{
 for(const r of [ready({},{model_chosen:false}),{capabilities:{}},undefined]){
  const ctx=fresh();
  assert.equal(await adoptWorkingRoute(ctx,r,PRESETS),null);
  assert.deepEqual(listProfiles(ctx),[]);
  assert.equal(firstTakesDefault(ctx,r),true);
 }
});

test('DGC\'s built-in model written down by an older save is no choice: the first provider still becomes the default',async()=>{
 const ctx=fresh(),r=ready({model:'qwen3:8b',builtin:true});
 assert.equal(await adoptWorkingRoute(ctx,r,PRESETS),null);
 assert.deepEqual(listProfiles(ctx),[]);
 assert.equal(firstTakesDefault(ctx,r),true);
});

test('a subscription default or a saved provider is left as it is',async()=>{
 const sub=fresh();
 assert.equal(await adoptWorkingRoute(sub,ready({subscription_engine:'claude'}),PRESETS),null);
 const saved=fresh();
 const row=await addProfile(saved,{name:'Mine',base_url:'https://host.test/v1',model:'one'});
 await markDefaultProfile(saved,row.id);
 assert.equal(await adoptWorkingRoute(saved,ready(),PRESETS),null);
 assert.equal(listProfiles(saved).length,1);
 assert.equal(firstTakesDefault(saved,ready({},{model_chosen:false})),false,'a default is already there');
});

test('a provider can be saved with All models; as the default it names one, and it never runs on none',async()=>{
 const s=store(),ctx={globalState:s.globalState,secrets:s.secretsApi};
 const all=await addProfile(ctx,{name:'OpenAI',base_url:'https://api.example.test/v1',model:'',api_key:'k'});
 assert.equal(listProfiles(ctx)[0].model,'','it lists with no model');
 assert.equal(hasRunnableProfile(ctx),false,'and is nothing to run on yet');
 await assert.rejects(markDefaultProfile(ctx,all.id),/Choose a model/);
 await assert.rejects(markDefaultProfile(ctx,all.id,'  '),/Choose a model/);
 assert.equal(defaultProfileId(ctx),'');
 await markDefaultProfile(ctx,all.id,'gpt-a');
 assert.equal(defaultProfileId(ctx),all.id);
 assert.equal(listProfiles(ctx)[0].model,'','it keeps saying All models');
 assert.equal(startingModel(ctx,listProfiles(ctx)[0]),'gpt-a');
 assert.equal(hasRunnableProfile(ctx),true);
 const other=await addProfile(ctx,{name:'Named',base_url:'https://two.example.test/v1',model:'one'});
 await markDefaultProfile(ctx,other.id);
 assert.equal(startingModel(ctx,listProfiles(ctx)[0]),'','not the default now: it asks again');
 // A default with a model of its own takes the one chosen on its row. So does a subscription, whose blank is its CLI's own.
 await markDefaultProfile(ctx,other.id,'two');
 assert.equal(listProfiles(ctx)[1].model,'two');
 const claude=await addProfile(ctx,{kind:'subscription',engine:'claude'});
 await markDefaultProfile(ctx,claude.id,'opus');
 assert.equal(listProfiles(ctx)[2].model,'opus');
 await markDefaultProfile(ctx,claude.id,'');
 assert.equal(listProfiles(ctx)[2].model,'');
 assert.equal(defaultProfileId(ctx),claude.id,'a blank there is the CLI default, a real choice');
});

/** Pips API 72: bounded Personal workflow controls over the SDK wire. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Session,DGCConfigError,DGCUnsupportedError} from '../sdk/typescript/src/index.ts';
import {COMMAND_FIELDS} from '../sdk/typescript/src/pips.ts';

const ids=['a','b','c'].map(x=>'pip_'+x.repeat(32));
function fixture(version){
 const calls=[];
 const wire={request:async(payload,response,opts)=>{calls.push(payload);return {type:'pips_result',request_id:opts.requestId,command:payload.request.type,ok:true,result:{request:payload.request}};}};
 const init={options:{},unhandled:'deny',instructions:'',toolHub:null,cwd:null,policy:null,department:'',usageLog:null,auditLog:null,model:'',permissionMode:'default',isolated:false,verifyCommand:'',stateLock:null,excludePaths:[],requestTimeoutMs:1000,sandbox:{requirement:'off',active:false,backend:'',reason:''}};
 return {calls,session:new Session(wire,{capabilities:{pips_supported:true,pips_enabled:true,pips_api_version:version}},init)};
}

test('Pips API 72 exposes exact fields and refuses older runtimes',async()=>{
 assert.deepEqual(COMMAND_FIELDS.create_pip_flow,['name','pip_ids','tasks','mode']);
 const old=fixture(71);
 await assert.rejects(old.session.pips.read('list_pip_flows',{workspace_id:'ws_'+'a'.repeat(32)}),DGCUnsupportedError);
 await assert.rejects(old.session.pips.mutate('create_pip_flow',{name:'Daily',pip_ids:ids,tasks:['Write','Image'],mode:'reviewed'},{approved:true}),DGCUnsupportedError);
 assert.equal(old.calls.length,0);
 const current=fixture(72),good={name:'Daily',pip_ids:ids,tasks:['Write','Image'],mode:'unattended'};
 for(const bad of [{...good,pip_ids:[ids[0],ids[0]]},{...good,tasks:['Write']},{...good,mode:'auto'},{...good,secret:'x'}])
   await assert.rejects(current.session.pips.mutate('create_pip_flow',bad,{approved:true}),DGCConfigError);
 assert.equal(current.calls.length,0);
 assert.equal((await current.session.pips.mutate('create_pip_flow',good,{approved:true})).request.mode,'unattended');
 assert.equal((await current.session.pips.mutate('set_pip_flow',{flow_id:'flow_x',expected_revision:0,status:'paused'},{approved:true})).request.status,'paused');
});

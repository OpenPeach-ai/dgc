/** Real NDJSON transport, deterministic paused result. No network or sleeps. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Session} from '../sdk/typescript/src/session.ts';
import {Transport} from '../sdk/typescript/src/transport.ts';
const init={options:{},unhandled:'deny',instructions:'',toolHub:null,cwd:null,policy:null,
 department:'',usageLog:null,auditLog:null,model:'fixture',permissionMode:'default',isolated:false,
 verifyCommand:'',stateLock:null,excludePaths:[],requestTimeoutMs:1000,
 sandbox:{requirement:'off',active:false,backend:'',reason:''}};
test('paused goal settles as paused without error, completion, or schema-repair turn',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'dgc-sdk-pause-'));
 const script=join(dir,'fixture.mjs');
 writeFileSync(script,`
 import readline from 'node:readline';
 let seq=0,count=0;
 const emit=(type,fields={})=>process.stdout.write(JSON.stringify({type,seq:seq++,...fields})+'\\n');
 emit('ready',{version:'fixture',protocol_version:14,session_id:'test-session',capabilities:{},model:'fixture',mode:'default',think:'off',base_url:'http://localhost.invalid',workspace_trusted:false,commands:[],custom_commands:[],goal:{text:'',status:'none'},context_size:32768});
 readline.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line);
 if(c.type==='shutdown')process.exit(0);
 if(c.type!=='prompt'||++count>1)throw Error('Unexpected command or repair');
 emit('prompt_accepted',{request_id:c.request_id,state:'started'});
 emit('turn_start',{turn_id:'t1',request_id:c.request_id,prompt:c.text,kind:'prompt'});
 emit('text_delta',{text:'Partial planning work'});
 emit('turn_end',{turn_id:'t1',reason:'paused',token_estimate:100,final_message_id:null});
 });`);
 const transport=new Transport([process.execPath,script],dir,process.env);
 try {
  const ready=await transport.start(10000);const session=new Session(transport,ready,init);
  session.sessionPath=join(dir,'test-session.json');
  const result=await session.run('Continue the goal',{outputSchema:{type:'object',properties:{done:{type:'boolean'}},required:['done']}});
  assert.equal(result.status,'paused');assert.equal(result.reason,'paused');
  assert.equal(result.error,undefined);assert.equal(result.output,undefined);
  assert.equal(result.finalText,'Partial planning work');
 } finally {await transport.close();rmSync(dir,{recursive:true,force:true});}
});

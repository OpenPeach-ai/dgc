import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const code=(await build({entryPoints:[fileURLToPath(new URL('../src/pipsMessageReviews.js',import.meta.url))],bundle:true,write:false,platform:'node',format:'cjs'})).outputFiles[0].text;
const mod={exports:{}};new Function('module','exports',code)(mod,mod.exports);
const {messageReview}=mod.exports;
// Produce the receipt with the production Python parser, then validate that same
// value in the actual editor module. A duplicate hand-written JS receipt fixture
// previously hid a provider-casing mismatch.
function backend(kind){
 return JSON.parse(execFileSync(process.env.DGC_SDK_TEST_PYTHON||'python3',['-c',`
import json,sys
from dgc import pip_app_actions as actions,pip_app_sends as sends,pip_calendar_actions as cal,pip_app_access as apps,pip_connector_actions as connector
kind=sys.argv[1];is_cal=kind=='calendar_create';is_conn=kind=='connector_call'
source={'run_id':'run_'+'1'*32,'pip_id':'pip_'+'2'*32,'workspace_id':'ws_'+'3'*32,'job_version':1,'lifecycle_revision':0,'result_digest':'a'*64}
event={'summary':'Read','description':'One chapter','start_datetime':'2026-12-01T11:00:00Z','end_datetime':'2026-12-01T11:30:00Z','timezone':'UTC'}
message={'recipient_email':'review@example.invalid','subject':'Read','body':'One chapter'}
payload=actions.validate({'schema_version':3 if is_conn else 2 if is_cal else 1,'kind':kind,'source':source,'server':'make' if is_conn else 'composio','connection_digest':'b'*64,'account':'connection_managed' if is_conn else 'ca_test','schema_digest':'c'*64,('call' if is_conn else 'event' if is_cal else 'message'):{'tool':'run_workflow','arguments':{'id':'123'}} if is_conn else event if is_cal else message})
data={'id':'abc123','status':'confirmed','summary':'Read','start':{'dateTime':event['start_datetime']},'end':{'dateTime':event['end_datetime']}} if is_cal else {'id':'mail_123'}
raw=json.dumps({'successful':True,'error':None,'data':{'success':True,'results':[{'tool_slug':cal.TOOL if is_cal else sends.TOOL,'response':{'successful':True,'error':None,'data':data}}]}})
receipt=connector.result('{"status":"running"}',None,'make','run_workflow') if is_conn else cal.result(raw,event) if is_cal else sends.result(raw)
print(json.dumps({'id':'appaction_'+'4'*32,'pip_id':source['pip_id'],'workspace_id':source['workspace_id'],'source_run_id':source['run_id'],'payload':payload,'digest':apps.digest(payload),'status':'succeeded','expires_at':'2026-12-01T12:00:00Z','receipt':receipt}))
`,kind],{cwd:root,encoding:'utf8'}));
}
for(const kind of ['gmail_send','calendar_create','connector_call'])test('editor accepts actual Python '+kind+' receipt and refuses mutated receipts',()=>{
 const value=backend(kind);assert.equal(messageReview(value,value.pip_id,value.workspace_id),value);
 for(const receipt of [{...value.receipt,provider:value.receipt.provider.toLowerCase()},{...value.receipt,meaning:'Delivered'},{...value.receipt,extra:'hidden'}]){
  assert.throws(()=>messageReview({...value,receipt},value.pip_id,value.workspace_id),/receipt/);
 }
});

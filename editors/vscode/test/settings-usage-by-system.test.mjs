// Settings → Token usage by system (0.51, DGC Router): the System picker beside the range, the By system list, and
// a model row that names its system with the address one hover away. Built from the report's by_model rows; a range
// with one system (or an older CLI whose rows name none) reads exactly as before.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {fileURLToPath} from 'node:url';
const src=fileURLToPath(new URL('../src/',import.meta.url));
const code=(await build({entryPoints:[src+'settingsClient.js'],bundle:true,write:false,loader:{'.css':'empty','.ico':'dataurl','.png':'dataurl','.svg':'dataurl'},format:'iife'})).outputFiles[0].text;
const view=await build({entryPoints:[src+'settingsView.ts'],bundle:true,write:false,platform:'node',format:'cjs'});
const module={exports:{}};new Function('module','exports',view.outputFiles[0].text)(module,module.exports);
const windows=[];after(()=>windows.forEach(w=>w.close()));
function setup(){
  const dom=new JSDOM(module.exports.settingsDocument(),{runScripts:'outside-only'}),w=dom.window;windows.push(w);const sent=[];
  w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m)});w.eval(code);
  const message=m=>w.dispatchEvent(new w.MessageEvent('message',{data:m}));
  message({type:'event',event:{type:'config',base_url:'https://model.example/v1',model:'m',mode:'default',think:'high',context_size:65536}});
  const $=s=>w.document.querySelector(s);
  return {w,d:w.document,$,sent,message,click:s=>$(s).click(),
    choose:(id,value)=>{const el=w.document.getElementById(id);el.value=value;el.dispatchEvent(new w.Event('change',{bubbles:true}));}};
}
const row=(model,system,system_id,system_kind,host,input,output,requests=1,unmetered=0,provider='ollama')=>
  ({model,provider,host,requests,unmetered_requests:unmetered,input_tokens:input,output_tokens:output,cached_input_tokens:0,system,system_id,system_kind});
const SEVERAL=[row('glm-5.3:cloud','Ollama Cloud','service:ollama-cloud','service','127.0.0.1:11434',60000,6000,4),
  row('qwen3.5:9b','NAS','nas','system','nas.local:11434',20000,2000,3,1),
  row('qwen2.5:7b','Mini PC','mini','system','mini.local:11434',10000,1000,2),
  row('claude-x','Anthropic','service:anthropic','service','api.anthropic.com',5000,500,1,0,'anthropic'),
  row('small','This computer','computer:this','computer','127.0.0.1:8080',100,10,1,0,'llamacpp')];
const usage=(request,by_model,extra={})=>({type:'usage_report',request_id:request.requestId,range:request.range,generated_at:'2026-11-02T10:00:00Z',timezone:'IST, UTC+05:30',
  totals:{input_tokens:by_model.reduce((s,r)=>s+r.input_tokens,0),output_tokens:by_model.reduce((s,r)=>s+r.output_tokens,0),cached_input_tokens:0,
    requests:by_model.reduce((s,r)=>s+r.requests,0),unmetered_requests:by_model.reduce((s,r)=>s+r.unmetered_requests,0)},
  by_model,by_day:[{date:'2026-11-01',input_tokens:1,output_tokens:1,requests:1},{date:'2026-11-02',input_tokens:1,output_tokens:1,requests:1}],...extra});

test('one system: no picker and no By system list, and the rows read as before',()=>{
  const x=setup();x.click('[data-nav=usage]');
  const asked=x.sent.at(-1);
  assert.deepEqual([asked.type,asked.system],['getUsage',undefined],'no system is asked for until one is chosen');
  x.message({type:'event',event:usage(asked,[row('qwen2.5:7b','This computer','computer:this','computer','127.0.0.1:11434',900,90)])});
  assert.equal(x.$('.usage-system-pick').hidden,true);
  assert.equal(x.$('#usage-systems').hidden,true);
  assert.match(x.$('#usage-models').textContent,/ollama · 127\.0\.0\.1:11434/);
  assert.match(x.$('#usage-th-where').textContent,/provider · host/);
  // An older CLI's rows name no system at all: the same page.
  x.click('#usage-refresh');
  x.message({type:'event',event:usage(x.sent.at(-1),[{model:'m',provider:'ollama',host:'localhost:11434',requests:1,input_tokens:5,output_tokens:1}])});
  assert.equal(x.$('.usage-system-pick').hidden,true);
  assert.match(x.$('#usage-models').textContent,/ollama · localhost:11434/);
});

test('several systems: the picker lists computers then cloud services, and By system shows each one',()=>{
  const x=setup();x.click('[data-nav=usage]');
  x.message({type:'event',event:usage(x.sent.at(-1),SEVERAL)});
  assert.equal(x.$('.usage-system-pick').hidden,false);
  const select=x.$('#usage-system');
  assert.equal(select.value,'');
  assert.deepEqual([...select.options].map(o=>o.textContent),['All systems','Mini PC','NAS','This computer','Anthropic','Ollama Cloud']);
  assert.deepEqual([...select.querySelectorAll('optgroup')].map(g=>g.label),['Computers','Cloud services']);
  assert.equal(x.$('#usage-systems').hidden,false);
  const rows=[...x.d.querySelectorAll('#usage-systems-table tbody tr')];
  assert.deepEqual(rows.map(r=>r.dataset.system),['service:ollama-cloud','nas','mini','service:anthropic','computer:this']);
  assert.match(rows[0].textContent,/Ollama Cloud.*cloud service.*60,000.*6,000.*4.*63%/s);
  assert.match(rows[1].textContent,/NAS.*DGC Router · 1 unmetered/s,'unmetered requests are marked');
  assert.match(rows[4].textContent,/This computer.*this computer/s);
  // A model row names its system; the address is one hover away.
  const nas=[...x.d.querySelectorAll('#usage-models tr')].find(r=>/qwen3\.5:9b/.test(r.textContent));
  assert.match(nas.querySelector('.usage-system-where').textContent,/^NAS · ollama/);
  assert.equal(nas.querySelector('.usage-host-info').title,'nas.local:11434');
  assert.equal(nas.querySelector('.usage-host-info').getAttribute('aria-label'),'Address: nas.local:11434');
  assert.doesNotMatch(nas.querySelector('.usage-system-where').textContent,/nas\.local/);
  // One click shows it under the row; another hides it again.
  const address=nas.querySelector('.usage-host');
  assert.equal(address.hidden,true);
  nas.querySelector('.usage-host-info').click();
  assert.equal(address.hidden,false);
  assert.equal(address.textContent,'nas.local:11434');
  assert.equal(nas.querySelector('.usage-host-info').getAttribute('aria-expanded'),'true');
  nas.querySelector('.usage-host-info').click();
  assert.equal(address.hidden,true);
  assert.match(x.$('#usage-th-where').textContent,/system · provider/);
  // The filter box finds a system by its name.
  const find=x.$('#usage-find');find.value='mini pc';find.dispatchEvent(new x.w.Event('input'));
  assert.deepEqual([...x.d.querySelectorAll('#usage-models tr')].map(r=>r.querySelector('.usage-name').textContent),['qwen2.5:7b']);
});

test('choosing a system asks for it alone: totals, days and models are its own; By system steps aside',()=>{
  const x=setup();x.click('[data-nav=usage]');
  x.message({type:'event',event:usage(x.sent.at(-1),SEVERAL)});
  x.choose('usage-system','nas');
  const asked=x.sent.at(-1);
  assert.deepEqual([asked.type,asked.range,asked.system],['getUsage','7d','nas']);
  x.message({type:'event',event:usage(asked,[SEVERAL[1]])});
  assert.equal(x.$('#usage-system').value,'nas');
  assert.equal(x.$('.usage-system-pick').hidden,false,'the picker stays, to go back to All systems');
  assert.equal(x.$('#usage-systems').hidden,true);
  assert.match(x.$('#usage-figures').textContent,/20,000/);
  assert.deepEqual([...x.d.querySelectorAll('#usage-models tr')].length,1);
  assert.match(x.$('#usage-models').textContent,/NAS · ollama/);
  // A system with nothing in it says so by name.
  x.click('#usage-refresh');
  assert.equal(x.sent.at(-1).system,undefined,'Refresh asks for the whole range first, for the picker');
  x.message({type:'event',event:usage(x.sent.at(-1),SEVERAL)});
  assert.equal(x.sent.at(-1).system,'nas','then the chosen system alone');
  x.message({type:'event',event:usage(x.sent.at(-1),[],{totals:{input_tokens:0,output_tokens:0,cached_input_tokens:0,requests:0,unmetered_requests:0}})});
  assert.equal(x.$('.usage-empty-title').textContent,'No model requests on NAS in this range');
  // Back to everything.
  x.choose('usage-system','');
  assert.equal(x.sent.at(-1).system,undefined);
  x.message({type:'event',event:usage(x.sent.at(-1),SEVERAL)});
  assert.equal(x.$('#usage-systems').hidden,false);
});

test('a new range keeps the chosen system while it has usage there, else shows All systems',()=>{
  const x=setup();x.click('[data-nav=usage]');
  x.message({type:'event',event:usage(x.sent.at(-1),SEVERAL)});
  x.choose('usage-system','mini');
  x.message({type:'event',event:usage(x.sent.at(-1),[SEVERAL[2]])});
  x.choose('usage-range','30d');
  const whole=x.sent.at(-1);
  assert.deepEqual([whole.range,whole.system],['30d',undefined]);
  x.message({type:'event',event:usage(whole,SEVERAL)});
  assert.deepEqual([x.sent.at(-1).range,x.sent.at(-1).system],['30d','mini']);
  x.message({type:'event',event:usage(x.sent.at(-1),[SEVERAL[2]])});
  x.choose('usage-range','today');
  const today=x.sent.at(-1);
  x.message({type:'event',event:usage(today,[SEVERAL[0],SEVERAL[1]])});
  assert.equal(x.sent.at(-1),today,'Mini PC did nothing today: nothing more is asked');
  assert.equal(x.$('#usage-system').value,'');
  assert.equal(x.$('#usage-systems').hidden,false);
});

test('choosing a row in By system shows that system alone',()=>{
  const x=setup();x.click('[data-nav=usage]');
  x.message({type:'event',event:usage(x.sent.at(-1),SEVERAL)});
  x.d.querySelector('#usage-systems-table tr[data-system="service:anthropic"] .usage-system-name').click();
  assert.equal(x.sent.at(-1).system,'service:anthropic');
  assert.equal(x.$('#usage-system').value,'service:anthropic');
});

const pips=(request,by_model,extra={})=>({type:'pip_usage_report',request_id:request.requestId,range:request.range,generated_at:'2026-11-02T10:00:00Z',timezone:'IST, UTC+05:30',
  all_tokens:100000,totals:{input_tokens:30000,output_tokens:3000,runs:4},omitted:0,
  by_pip:[{pip_id:'pip_'+'1'.repeat(32),name:'Inbox',pip_type:'lens',scope:'personal',project:'',status:'active',input_tokens:30000,output_tokens:3000,runs:4,daily_cap:null,models:[]}],
  by_model,...extra});

test('the Pips view has the same picker, shares the chosen system, and filters what the Pips ran there',()=>{
  const x=setup();x.click('[data-nav=usage]');
  x.message({type:'event',event:usage(x.sent.at(-1),SEVERAL)});
  x.choose('usage-system','nas');
  x.message({type:'event',event:usage(x.sent.at(-1),[SEVERAL[1]])});
  x.click('[data-usage-view=pips]');
  const whole=x.sent.at(-1);
  assert.deepEqual([whole.type,whole.system],['getPipUsage',undefined],'the Pips\' own systems first');
  x.message({type:'event',event:pips(whole,[SEVERAL[1],SEVERAL[0]])});
  const alone=x.sent.at(-1);
  assert.deepEqual([alone.type,alone.system],['getPipUsage','nas'],'the system chosen in Everything is kept');
  x.message({type:'event',event:pips(alone,[SEVERAL[1]],{all_tokens:22000,totals:{input_tokens:20000,output_tokens:2000,runs:3}})});
  assert.equal(x.$('#usage-system').value,'nas');
  assert.match(x.$('#pip-usage-part').textContent,/Pips used 100% of the 22,000 tokens counted on NAS in this range/);
  assert.equal(x.$('#pip-usage-systems').hidden,true);
  assert.match(x.$('#pip-usage-models').textContent,/NAS · ollama/);
  x.choose('usage-system','');
  x.message({type:'event',event:pips(x.sent.at(-1),[SEVERAL[1],SEVERAL[0]])});
  assert.equal(x.$('#pip-usage-systems').hidden,false);
  assert.deepEqual([...x.d.querySelectorAll('#pip-usage-systems-table tbody tr')].map(r=>r.dataset.system),['service:ollama-cloud','nas'],'most tokens first');
  // One system among the Pips' requests: no picker there.
  x.click('#pip-usage-refresh');
  x.message({type:'event',event:pips(x.sent.at(-1),[SEVERAL[1]])});
  assert.equal(x.$('.usage-system-pick').hidden,true);
  assert.equal(x.$('#pip-usage-systems').hidden,true);
  assert.match(x.$('#pip-usage-models').textContent,/ollama · nas\.local:11434/);
});

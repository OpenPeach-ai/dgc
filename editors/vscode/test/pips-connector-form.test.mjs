import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const code=(await build({entryPoints:[fileURLToPath(new URL('../src/pipsConnectorForm.js',import.meta.url))],bundle:true,write:false,platform:'node',format:'cjs'})).outputFiles[0].text;
const mod={exports:{}};new Function('module','exports',code)(mod,mod.exports);
const {formSchema,createConnectorInputs,mountConnectorInputs,readConnectorInputs,mountConnectorSummary}=mod.exports;
function fixture(schema){
 const dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector('main'),state=createConnectorInputs(schema);
 const mount=()=>mountConnectorInputs(root,state);mount();
 const control=label=>[...root.querySelectorAll('label')].find(l=>l.textContent===label)?.control;
 const value=(label,v)=>{const e=control(label);assert.ok(e,label);e.value=v;e.dispatchEvent(new dom.window.Event('input'));e.dispatchEvent(new dom.window.Event('change'));};
 const mode=(label,v)=>{const e=root.querySelector(`[aria-label="${label}: include value"]`);assert.ok(e,label);e.value=v;e.dispatchEvent(new dom.window.Event('change'));};
 const click=t=>{const e=[...root.querySelectorAll('button')].find(b=>b.textContent===t);assert.ok(e,t);e.click();};
 return {root,state,mount,control,value,mode,click,read:()=>readConnectorInputs(state),dom};
}
test('normal forms preserve exact values, omitted options, explicit false, zero, empty and null',()=>{
 const x=fixture({type:'object',required:['subject','priority','notify'],properties:{subject:{type:'string',minLength:1},priority:{type:'integer',minimum:0,maximum:5},notify:{type:'boolean'},note:{type:['string','null']},empty:{type:'string',default:'not silently chosen'}}});
 assert.equal(x.root.querySelector('#connector-inputs'),null);assert.throws(x.read,/subject/);
 x.value('subject','  Keep spaces  ');x.value('priority','0');assert.throws(x.read,/Yes or No/);x.value('notify','false');
 assert.deepEqual(x.read(),{subject:'  Keep spaces  ',priority:0,notify:false});
 x.mode('note','null');x.mode('empty','value');assert.deepEqual(x.read(),{subject:'  Keep spaces  ',priority:0,notify:false,note:null,empty:''});
 x.mode('note','omit');assert.equal(Object.hasOwn(x.read(),'note'),false);
 x.value('priority','9007199254740993');assert.throws(x.read,/whole number/);x.value('priority','6');assert.throws(x.read,/range/);
 x.value('priority','0x10');assert.throws(x.read,/number/);
});
test('nested objects and lists stay editable through rerenders without calling any external action',()=>{
 const x=fixture({type:'object',required:['destination','tags'],properties:{destination:{type:'object',required:['folder'],properties:{folder:{type:'string'}}},tags:{type:'array',minItems:1,maxItems:2,items:{type:'string',minLength:1}}}});
 x.value('folder','Saved plans');assert.throws(x.read,/number of items/);x.click('Add item');x.value('tags item 1','home');x.click('Add item');x.value('tags item 2','weekend');
 assert.deepEqual(x.read(),{destination:{folder:'Saved plans'},tags:['home','weekend']});
 assert.equal([...x.root.querySelectorAll('button')].find(b=>b.textContent==='Add item').disabled,true);
 x.mount();assert.equal(x.control('folder').value,'Saved plans');x.click('Remove');assert.deepEqual(x.read().tags,['weekend']);
});
test('enum and constant values retain their declared types, no inferred default',()=>{
 const x=fixture({type:'object',required:['choice','fixed'],properties:{choice:{type:['string','null'],enum:['plain',null]},fixed:{type:'integer',const:3}}});
 assert.throws(x.read,/choose/);x.value('choice','0');assert.deepEqual(x.read(),{choice:'plain',fixed:3});x.mode('choice','null');assert.equal(x.read().choice,null);
});
test('unsupported or excessive schema uses explicit JSON without fetching refs or stripping inputs',()=>{
 const unsupported=[{$ref:'https://example.invalid/schema'},{oneOf:[{type:'string'}]},{pattern:'(a+)+$'},{format:'email'},{additionalProperties:{type:'string'}},{required:['missing']},{properties:{x:{type:'array',items:{type:'object'}}}},{properties:Object.fromEntries(Array.from({length:65},(_,i)=>[String(i),{type:'string'}]))}];
 for(const extra of unsupported){const s={type:'object',...extra};assert.equal(formSchema(s),false);const x=fixture(s);assert.match(x.root.textContent,/complex schema/);x.value('Exact inputs (JSON)','{"undeclared":{"unchanged":true}}');assert.deepEqual(x.read(),{undeclared:{unchanged:true}});}
});
test('schema strings cannot inject DOM or corrupt prototypes',()=>{
 const s=JSON.parse('{"type":"object","required":["__proto__","<img src=x onerror=alert(1)>"],"properties":{"__proto__":{"type":"string"},"<img src=x onerror=alert(1)>":{"type":"string","description":"<script>alert(1)</script>"}}}');
 const x=fixture(s);x.value('__proto__','exact-key');x.value('<img src=x onerror=alert(1)>','exact-value');assert.equal(x.root.querySelector('script,img'),null);
 assert.equal(Object.hasOwn(x.read(),'__proto__'),true);assert.equal(x.read().__proto__,'exact-key');assert.equal({}.polluted,undefined);
});
test('advanced input escape keeps field values, rejects nonobjects and caps UTF-8 bytes',()=>{
 const x=fixture({type:'object',required:['body'],properties:{body:{type:'string'}}});x.value('body','hello');x.click('Advanced JSON');assert.deepEqual(x.read(),{body:'hello'});
 x.value('Exact inputs (JSON)','[]');assert.throws(x.read,/object/);x.value('Exact inputs (JSON)','{');assert.throws(x.read,/valid JSON/);
 x.value('Exact inputs (JSON)',JSON.stringify({body:'界'.repeat(3400)}));assert.throws(x.read,/10,000/);
});
test('pending save disables field editing and forms retain input on remount',()=>{
 const x=fixture({type:'object',required:['title'],properties:{title:{type:'string'}}});x.value('title','Keep this');mountConnectorInputs(x.root,x.state,true);assert.equal(x.root.querySelector('fieldset').disabled,true);assert.equal(x.control('title').value,'Keep this');
 x.mount();assert.equal(x.root.querySelector('fieldset').disabled,false);assert.equal(x.read().title,'Keep this');
});

test('invalid descriptor types fall back and advanced JSON refuses nonfinite or unsafe integers',()=>{
 for(const child of [{type:'string',enum:[true]},{type:'integer',const:'three'},{type:'array',minItems:41,items:{type:'string'}}])assert.equal(formSchema({type:'object',properties:{x:child}}),false);
 const x=fixture({type:'object',$ref:'https://example.invalid'});
 for(const value of ['{"n":1e999}','{"n":9007199254740993}','{"nested":[{"n":-1e999}]}']){x.value('Exact inputs (JSON)',value);assert.throws(x.read,/exact number range/);}
});

test('readable saved review keeps false, null, empty and nested values without rendering provider markup',()=>{
 const x=fixture({type:'object'}),value={title:'<img src=x>',published:false,empty:'',nullable:null,tags:['home','weekend'],options:{count:0}};
 const before=JSON.stringify(value);mountConnectorSummary(x.root,value);assert.equal(JSON.stringify(value),before);assert.equal(x.root.querySelector('img'),null);
 for(const text of ['<img src=x>','No','(empty text)','null','home','weekend','0'])assert.ok(x.root.textContent.includes(text));
});

test('model drafts prefill exact ordinary fields and preserve unrepresentable values through JSON',()=>{
 const schema={type:'object',required:['title','enabled','count','tags'],properties:{title:{type:'string'},enabled:{type:'boolean'},count:{type:'integer'},tags:{type:'array',items:{type:'string'}},note:{type:['string','null']}}};
 const initial={title:'Keep\nnewlines',enabled:false,count:0,tags:['one','two'],note:null},state=createConnectorInputs(schema,initial);assert.equal(state.advanced,false);assert.deepEqual(readConnectorInputs(state),initial);
 for(const value of [{...initial,extra:'keep-extra'},{...initial,count:'not-a-number'}]){const state=createConnectorInputs(schema,value);assert.equal(state.advanced,true);assert.deepEqual(readConnectorInputs(state),value);}
});

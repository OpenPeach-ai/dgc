// Data-only inputs from a connector's declared schema. No remote references,
// templates, regular expressions, defaults or markup are executed.
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const own=(v,k)=>Object.hasOwn(v,k);
const annotations=new Set(['title','description','default','examples','$schema','$id','deprecated','readOnly','writeOnly']);
const supported=new Set(['type','properties','required','additionalProperties','items','enum','const','minLength','maxLength','minimum','maximum','exclusiveMinimum','exclusiveMaximum','minItems','maxItems',...annotations]);
const primitive=v=>v===null||['string','boolean'].includes(typeof v)||typeof v==='number'&&Number.isFinite(v);
function typeOf(schema){
 const types=Array.isArray(schema.type)?schema.type:[schema.type];
 if(types.length>2||new Set(types).size!==types.length)return null;
 const type=types.find(t=>t!=='null')||'null';
 return types.every(t=>t===type||t==='null')&&['object','array','string','integer','number','boolean','null'].includes(type)?{type,nullable:types.includes('null')}:null;
}
export function formSchema(schema){
 let count=0;
 function visit(s,depth){
  if(!object(s)||++count>64||depth>5||Object.keys(s).some(k=>!supported.has(k)))return false;
  const type=typeOf(s);if(!type)return false;
  for(const key of ['title','description'])if(own(s,key)&&typeof s[key]!=='string')return false;
  for(const key of ['minimum','maximum','exclusiveMinimum','exclusiveMaximum'])if(own(s,key)&&!Number.isFinite(s[key]))return false;
  for(const key of ['minLength','maxLength','minItems','maxItems'])if(own(s,key)&&(!Number.isSafeInteger(s[key])||s[key]<0))return false;
  if(own(s,'enum')&&(!Array.isArray(s.enum)||!s.enum.length||s.enum.length>64||!s.enum.every(primitive)))return false;
  if(own(s,'const')&&!primitive(s.const))return false;
  const matches=v=>v===null?type.nullable:type.type==='integer'?Number.isSafeInteger(v):type.type==='number'?typeof v==='number':typeof v===type.type;
  if(s.enum&&!s.enum.every(matches)||own(s,'const')&&!matches(s.const))return false;
  if(type.type==='array'&&(s.minItems||0)>40)return false;
  if(type.type==='object'){
   if(own(s,'additionalProperties')&&typeof s.additionalProperties!=='boolean')return false;
   if(own(s,'properties')&&!object(s.properties))return false;
   const props=s.properties||{};
   if(own(s,'required')&&(!Array.isArray(s.required)||!s.required.every(k=>typeof k==='string'&&own(props,k))))return false;
   return Object.values(props).every(child=>visit(child,depth+1));
  }
  if(type.type==='array')return object(s.items)&&!['object','array'].includes(typeOf(s.items)?.type)&&visit(s.items,depth+1);
  return true;
 }
 return object(schema)&&schema.type==='object'&&visit(schema,0);
}
const empty=s=>({mode:'value',raw:'',children:Object.create(null),items:[]});
function validate(s,value,label){
 const fail=message=>{throw Error(`${label}: ${message}`);};
 if(own(s,'const')&&JSON.stringify(value)!==JSON.stringify(s.const))fail('use the declared value.');
 if(s.enum&&!s.enum.some(v=>JSON.stringify(v)===JSON.stringify(value)))fail('choose one of the listed values.');
 if(value===null)return;
 if(typeof value==='string'){
  const len=[...value].length;if(len<(s.minLength||0)||len>(s.maxLength??10000))fail('check the permitted text length.');
 }
 if(typeof value==='number'){
  if(!Number.isFinite(value)||typeOf(s).type==='integer'&&!Number.isSafeInteger(value))fail('enter a valid '+(typeOf(s).type==='integer'?'whole number.':'number.'));
  if(value<(s.minimum??-Infinity)||value>(s.maximum??Infinity)||value<=(s.exclusiveMinimum??-Infinity)||value>=(s.exclusiveMaximum??Infinity))fail('check the permitted number range.');
 }
 if(Array.isArray(value)&&(value.length<(s.minItems||0)||value.length>(s.maxItems??40)))fail('check the permitted number of items.');
}
function readNode(s,node,label,required=true){
 if(!required&&node.mode==='omit')return undefined;
 if(node.mode==='null'||typeOf(s).type==='null'){validate(s,null,label);return null;}
 const type=typeOf(s).type;let value;
 if(own(s,'const'))value=s.const;
 else if(s.enum){if(node.raw==='')throw Error(`${label}: choose a value.`);value=s.enum[Number(node.raw)];if(value===undefined)throw Error(`${label}: choose a listed value.`);}
 else if(type==='object')value=Object.fromEntries(Object.entries(s.properties||{}).flatMap(([key,child])=>{const n=node.children[key]||{...empty(child),mode:(s.required||[]).includes(key)?'value':'omit'};const v=readNode(child,n,`${label} / ${key}`,(s.required||[]).includes(key));return v===undefined?[]:[[key,v]];}));
 else if(type==='array')value=node.items.map((item,i)=>readNode(s.items,item,`${label} / item ${i+1}`));
 else if(type==='boolean'){if(!['true','false'].includes(node.raw))throw Error(`${label}: choose Yes or No.`);value=node.raw==='true';}
 else if(type==='number'||type==='integer'){if(!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(node.raw))throw Error(`${label}: enter a number.`);value=Number(node.raw);}
 else value=node.raw;
 validate(s,value,label);return value;
}
export function readConnectorInputs(state){
 let result;
 if(state.advanced){if(state.json.length>10000||new TextEncoder().encode(state.json).length>10000)throw Error('Inputs must fit within 10,000 bytes.');try{result=JSON.parse(state.json);}catch{throw Error('Enter valid JSON for the exact inputs.');}}
 else result=readNode(state.schema,state.tree,'Inputs');
 const pending=[result];while(pending.length){const value=pending.pop();if(typeof value==='number'&&(!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value)))throw Error('A numeric input exceeds the editor’s exact number range. Use a string only if the connector schema permits it.');if(value!==null&&typeof value==='object')pending.push(...Object.values(value));}
 if(!object(result)||new TextEncoder().encode(JSON.stringify(result)).length>10000)throw Error('Inputs must be an object, up to 10,000 bytes.');
 return result;
}
export function createConnectorInputs(schema,initial){
 const state={schema,tree:empty(schema),advanced:!formSchema(schema),json:initial===undefined?'{}':JSON.stringify(initial,null,2)};
 if(initial===undefined||state.advanced)return state;
 const seed=(s,v)=>{
  const n=empty(s),type=typeOf(s);if(v===null){if(!type.nullable)throw Error('type');n.mode='null';return n;}
  if(s.enum){const i=s.enum.findIndex(x=>JSON.stringify(x)===JSON.stringify(v));if(i<0)throw Error('enum');n.raw=String(i);}
  else if(type.type==='object'){
   if(!object(v)||Object.keys(v).some(k=>!own(s.properties||{},k)))throw Error('object');
   for(const [key,child] of Object.entries(s.properties||{}))n.children[key]=own(v,key)?seed(child,v[key]):{...empty(child),mode:'omit'};
  }else if(type.type==='array'){if(!Array.isArray(v)||v.length>40)throw Error('array');n.items=v.map(item=>seed(s.items,item));}
  else{if(typeof v!==(type.type==='integer'?'number':type.type))throw Error('type');n.raw=String(v);}
  return n;
 };
 try{state.tree=seed(schema,initial);const canonical=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(canonical):Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;if(JSON.stringify(canonical(readConnectorInputs(state)))!==JSON.stringify(canonical(initial)))throw Error('changed');}
 catch{state.advanced=true;}return state;
}
export function mountConnectorInputs(root,state,disabled=false){
 const doc=root.ownerDocument;let next=1;
 const el=(tag,text,attrs={})=>{const e=doc.createElement(tag);if(text!==null)e.textContent=text;for(const [k,v] of Object.entries(attrs))e.setAttribute(k,String(v));return e;};
 root.replaceChildren();const fieldset=el('fieldset',null,{class:'connector-fields'});fieldset.disabled=disabled;root.append(fieldset);
 const err=el('p','',{role:'alert',class:'error'});
 function node(s,n,label,required,parent){
  const type=typeOf(s),id=`connector-field-${next++}`,wrap=el('div',null,{class:'connector-field'});parent.append(wrap);
  const heading=el('label',`${s.title||label}${required?'':' (optional)'}`,{for:id});wrap.append(heading);
  const desc=el('small',s.description||'',{id:id+'-hint',class:'muted'});if(s.description)wrap.append(desc);
  const content=el('div',null,{class:'connector-field-value'});wrap.append(content);
  if(!required||type.nullable&&type.type!=='null'){
   const mode=el('select',null,{id:id+'-mode','aria-label':`${label}: include value`});
   for(const [v,t] of [...(!required?[['omit','Not supplied']]:[]),['value','Set value'],...(type.nullable?[['null','Use null']]:[])]){const opt=el('option',t,{value:v});opt.selected=n.mode===v;mode.append(opt);}
   wrap.insertBefore(mode,content);mode.addEventListener('change',()=>{n.mode=mode.value;content.hidden=n.mode!=='value';});content.hidden=n.mode!=='value';
  }
  if(own(s,'const')||type.type==='null'){content.append(el('p',JSON.stringify(own(s,'const')?s.const:null),{id}));return;}
  if(type.type==='object'){
   heading.removeAttribute('for');content.setAttribute('role','group');content.setAttribute('aria-label',label);
   for(const [key,child] of Object.entries(s.properties||{})){const req=(s.required||[]).includes(key);n.children[key]??={...empty(child),mode:req?'value':'omit'};node(child,n.children[key],key,req,content);}
   if(!Object.keys(s.properties||{}).length)content.append(el('p','No named inputs. Use Advanced JSON to supply additional inputs if the connector accepts them.',{class:'muted'}));return;
  }
  if(type.type==='array'){
   heading.removeAttribute('for');const list=el('div',null,{role:'group','aria-label':label});content.append(list);
   const add=el('button','Add item',{type:'button'});content.append(add);
   const redraw=()=>{list.replaceChildren();n.items.forEach((item,i)=>{const row=el('div',null,{class:'connector-array-item'});list.append(row);node(s.items,item,`${label} item ${i+1}`,true,row);const remove=el('button','Remove',{type:'button','aria-label':`Remove ${label} item ${i+1}`});row.append(remove);remove.onclick=()=>{n.items.splice(i,1);redraw();add.focus();};});add.disabled=n.items.length>=Math.min(s.maxItems??40,40);};
   add.onclick=()=>{if(n.items.length>=Math.min(s.maxItems??40,40))return;n.items.push(empty(s.items));redraw();list.lastElementChild?.querySelector('input,select,textarea')?.focus();};redraw();return;
  }
  let input;
  if(s.enum||type.type==='boolean'){
   input=el('select',null,{id});input.append(el('option','Choose…',{value:''}));
   const choices=s.enum?s.enum.map((v,i)=>[String(i),typeof v==='string'?v:JSON.stringify(v)]):[['true','Yes'],['false','No']];
   for(const [v,t] of choices)input.append(el('option',t,{value:v}));
  }else{
   input=el(type.type==='string'?'textarea':'input',null,{id});
   if(type.type==='string'){input.rows=Math.min(5,Math.max(1,n.raw.split('\n').length));input.maxLength=10000;}
   else{input.type='text';input.inputMode='decimal';}
  }
  input.value=n.raw;input.setAttribute('aria-describedby',id+'-hint');input.setAttribute('aria-required',String(required));content.append(input);
  input.addEventListener('input',()=>{n.raw=input.value;if(input.tagName==='TEXTAREA')input.rows=Math.min(5,Math.max(1,n.raw.split('\n').length));});input.addEventListener('change',()=>{n.raw=input.value;});
 }
 if(state.advanced){
  fieldset.append(el('p',formSchema(state.schema)?'Advanced JSON. Every supplied field is kept exactly.':'This tool uses a complex schema. Enter its exact inputs as JSON; DGC does not simplify or fetch schema references.',{class:'muted'}));
  const label=el('label','Exact inputs (JSON)',{for:'connector-inputs'}),input=el('textarea',null,{id:'connector-inputs',rows:7,maxlength:10000});input.value=state.json;input.oninput=()=>{state.json=input.value;};fieldset.append(label,input);
 }else{
  const heading=el('p','Optional inputs are omitted until you choose to supply them. Connector defaults are not filled in by DGC.',{class:'muted'});fieldset.append(heading);
  for(const [key,child] of Object.entries(state.schema.properties||{})){const required=(state.schema.required||[]).includes(key);state.tree.children[key]??={...empty(child),mode:required?'value':'omit'};node(child,state.tree.children[key],key,required,fieldset);}
  if(!Object.keys(state.schema.properties||{}).length)fieldset.append(el('p','No named inputs. Use Advanced JSON for additional inputs accepted by the connector.',{class:'muted'}));
  const advanced=el('button','Advanced JSON',{type:'button'});fieldset.append(advanced);
  advanced.onclick=()=>{try{state.json=JSON.stringify(readConnectorInputs(state),null,2);state.advanced=true;mountConnectorInputs(root,state,disabled);root.querySelector('textarea')?.focus();}catch(error){err.textContent=error.message;}};
 }
 fieldset.append(err);
}

// A readable review of the same saved inputs. The full JSON remains available
// alongside it; this presentation never edits the approval payload.
export function mountConnectorSummary(root,value){
 const doc=root.ownerDocument;let count=0;
 function render(v,depth){
  if(v!==null&&typeof v==='object'&&Object.keys(v).length&&depth<4&&count<80){
   const dl=doc.createElement('dl');dl.className='connector-summary';
   for(const [key,child] of Object.entries(v)){count++;const dt=doc.createElement('dt');dt.textContent=Array.isArray(v)?`Item ${Number(key)+1}`:key;const dd=doc.createElement('dd');dd.append(render(child,depth+1));dl.append(dt,dd);}return dl;
  }
  const text=doc.createElement('span');text.className='connector-summary-value';
  text.textContent=typeof v==='string'?(v===''?'(empty text)':v):v===true?'Yes':v===false?'No':JSON.stringify(v,null,2);return text;
 }
 root.replaceChildren(render(value,0));
}

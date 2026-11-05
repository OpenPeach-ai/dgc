import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeDom} from './support/webview-dom.mjs';
const WS='ws_'+'a'.repeat(32), ID='pip_'+'b'.repeat(32);
const row={pip_id:ID,name:'Rook review',pip_type:'rook',status:'paused',job_version:2,lifecycle_revision:4};
const ready=cap=>({type:'event',event:{type:'ready',capabilities:{pip_references:cap,display_mentions:cap?1:0},model:'m',mode:'default',think:'off',base_url:'http://localhost:1/v1',workspace_trusted:true,commands:[],custom_commands:[],goal:{text:'',status:'none'},context_size:1}});
function panel(){const p=makeDom({clock:true});p.send(ready(1));p.send({type:'session_ready',sessionId:'chat-a'});return p;}
function type(p,text){const input=p.doc.getElementById('input');input.value=text;input.selectionStart=input.selectionEnd=text.length;input.dispatchEvent(new p.dom.window.Event('input',{bubbles:true}));return input;}
function key(p,key){p.doc.getElementById('input').dispatchEvent(new p.dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));}
function open(p,text='Explain @'){type(p,text);key(p,'Enter');p.advance(120);return p.posted.filter(m=>m.type==='list_prompt_pips').at(-1);}
function answer(p,request,rows=[row],cursor=null){p.send({type:'event',event:{type:'prompt_pips',request_id:request.request_id,workspace_id:WS,pips:rows,next_cursor:cursor}});}
function select(p){answer(p,open(p));key(p,'Enter');}
test('Pip picker uses keyboard, sends only exact reference pins, and never attaches a session',()=>{
 const p=panel();select(p);assert.equal(p.doc.getElementById('input').value,'Explain ');
 assert.match(p.doc.querySelector('#input .pill-pip')?.textContent||'',/Rook review/);
 assert.equal(p.doc.querySelectorAll('#attachments .pip-reference-chip').length,0,'the selected Pip is inline');key(p,'Enter');
 const sent=p.posted.filter(m=>m.type==='prompt').at(-1);assert.deepEqual(JSON.parse(JSON.stringify(sent.pip_references)),[{pip_id:ID,expected_version:2,expected_lifecycle_revision:4}]);
 assert.equal(sent.context,undefined);assert.equal(p.posted.some(m=>m.type==='attach_pip_to_session'||m.type==='pipsRequest'),false);
 assert.match(p.doc.querySelector('#log .prompt-text .sent-mention.pill-pip')?.textContent||'',/Rook review/);
 assert.equal(p.doc.querySelector('#log .pip-reference-chip'),null,'the sent Pip stays inline');
});
test('copying an inline Pip reference copies its name without plush style rules',()=>{
 const p=panel();select(p);
 const input=p.doc.getElementById('input'),selection=p.dom.window.getSelection(),range=p.doc.createRange();
 range.selectNodeContents(input);selection.removeAllRanges();selection.addRange(range);
 let copied='';const event=new p.dom.window.Event('copy',{bubbles:true,cancelable:true});
 Object.defineProperty(event,'clipboardData',{value:{setData:(kind,value)=>{if(kind==='text/plain')copied=value;}}});
 input.dispatchEvent(event);
 assert.equal(copied,'Explain @Rook review');
 assert.equal(event.defaultPrevented,true);
});
test('file mention named pip remains independently selectable beside Pip category',()=>{
 const p=panel();p.send({type:'files',files:[{label:'pips.txt',path:'/ws/pips.txt',uri:'file:///ws/pips.txt',relative_path:'pips.txt',workspace:'ws'}]});type(p,'Read @pips.txt');key(p,'Enter');key(p,'Enter');
 const sent=p.posted.filter(m=>m.type==='prompt').at(-1);assert.equal(sent.pip_references,undefined);assert.equal(sent.context[0].type,'file_mention');assert.equal(sent.context[0].path,'/ws/pips.txt');
});
test('a selected file stays inline and muted in the sent Work prompt',()=>{
 const p=makeDom({clock:true});const event=ready(1);event.event.capabilities.display_mentions=2;
 p.send(event);p.send({type:'session_ready',sessionId:'chat-a'});
 p.send({type:'files',files:[{label:'pips.txt',path:'/ws/pips.txt',uri:'file:///ws/pips.txt',relative_path:'pips.txt',workspace:'ws'}]});
 type(p,'Read @pips.txt');key(p,'Enter');key(p,'Enter');
 const sent=p.posted.filter(m=>m.type==='prompt').at(-1);
 assert.deepEqual(JSON.parse(JSON.stringify(sent.display_mentions?.map(m=>[m.kind,m.label]))),[['file','pips.txt']]);
 assert.equal(p.doc.querySelectorAll('#log .prompt-text .sent-mention.pill-file').length,1);
 assert.equal(p.doc.querySelector('#log .prompt-atts'),null,'the file appears in its sentence, not a second chip above it');
 p.doc.querySelector('#log .sent-attachment').click();
 assert.ok(p.posted.some(m=>m.type==='openFile'&&m.path==='/ws/pips.txt'));
});
test('late query and session replies never populate the active picker',()=>{
 const p=panel();const first=open(p);type(p,'Explain @Lens');p.advance(120);const second=p.posted.filter(m=>m.type==='list_prompt_pips').at(-1);answer(p,first);assert.doesNotMatch(p.doc.getElementById('pop').textContent,/Rook review/);
 p.send({type:'session_ready',sessionId:'new-chat'});answer(p,second);assert.equal(p.doc.getElementById('pop').style.display,'none');
});
test('rejected prompt restores exact reference chip and text and capability loss preserves draft',()=>{
 const p=panel();select(p);key(p,'Enter');const sent=p.posted.filter(m=>m.type==='prompt').at(-1);
 p.send({type:'event',event:{type:'command_rejected',command:'prompt',request_id:sent.requestId,message:'The Pip changed. Select it again.'}});
 assert.equal(p.doc.getElementById('input').value,'Explain');assert.match(p.doc.getElementById('attachments').textContent,/Rook review/);
 p.send(ready(0));key(p,'Enter');assert.equal(p.posted.filter(m=>m.type==='prompt').length,1);assert.equal(p.doc.getElementById('input').value,'Explain');assert.match(p.doc.getElementById('log').textContent,/draft is saved/);
});
test('Escape cancels picker; duplicate IDs, malformed metadata and cross-workspace pages are refused',()=>{
 const p=panel();const r=open(p);answer(p,r,[row,{...row,name:'duplicate'}]);assert.match(p.doc.getElementById('pop').textContent,/invalid Pip references/);key(p,'Escape');answer(p,r);assert.equal(p.doc.getElementById('pop').style.display,'none');
 const q=open(p);answer(p,q,[{...row,pip_id:ID+'\n'}]);assert.match(p.doc.getElementById('pop').textContent,/invalid Pip references/);
});
test('pagination is explicit and a selected Pip cannot be selected twice',()=>{
 const p=panel();const r=open(p);answer(p,r,[row],'cursor-one');key(p,'ArrowDown');key(p,'Tab');p.advance(120);const more=p.posted.filter(m=>m.type==='list_prompt_pips').at(-1);assert.equal(more.after,'cursor-one');answer(p,more,[{...row,pip_id:'pip_'+'c'.repeat(32),name:'Second'}]);key(p,'Enter');
 const next=open(p);answer(p,next);key(p,'Enter');assert.equal(p.doc.querySelectorAll('#attachments .pip-reference-chip').length,1);assert.match(p.doc.getElementById('log').textContent,/already referenced/);
});
test('standing goal refuses reference chips without discarding draft',()=>{
 const p=panel();select(p);type(p,'/goal explain this');key(p,'Enter');assert.equal(p.posted.some(m=>m.type==='startGoal'),false);assert.equal(p.doc.getElementById('input').value,'/goal explain this');assert.match(p.doc.getElementById('attachments').textContent,/Rook/);
});
test('an unregistered workspace is an honest empty state and multiline names stay inert',()=>{
 const p=panel(),r=open(p);p.send({type:'event',event:{type:'prompt_pips',request_id:r.request_id,workspace_id:'',pips:[],next_cursor:null}});assert.match(p.doc.getElementById('pop').textContent,/No Pips are registered/);key(p,'Escape');const next=open(p);answer(p,next,[{...row,name:'Rook\n\t<script>bad</script>'}]);assert.equal(p.doc.querySelector('#pop script'),null);key(p,'Enter');assert.match(p.doc.querySelector('#input .pill-pip')?.textContent||'',/Rook <script>bad<\/script>/);
});
test('typing @pip opens the Pip list directly and the face stays with the inline reference',()=>{
 const p=panel();type(p,'Ask @pip');p.advance(120);const r=p.posted.filter(m=>m.type==='list_prompt_pips').at(-1);
 assert.ok(r,'the picker requests the Pip list without a category click');answer(p,r);key(p,'Enter');
 const pill=p.doc.querySelector('#input .pill-pip');assert.equal(pill?.dataset.pipId,ID);
 assert.ok(pill.querySelector('.composer-pip-face'),'the face slot is inline');
});
test('Pip picker labels Personal and Project Pips without changing their reference identities',()=>{
 const p=panel(), request=open(p), personal={...row,pip_id:'pip_'+'c'.repeat(32),workspace_id:'ws_'+'d'.repeat(32),name:'Core',pip_type:'core',scope:'personal'};
 answer(p,request,[{...row,workspace_id:WS,scope:'project'},personal]);
 const labels=[...p.doc.querySelectorAll('#pop .pi')].map(e=>e.textContent);
 assert.ok(labels.some(s=>s.includes('Project · v2')));
 assert.ok(labels.some(s=>s.includes('Personal · v2')));
});
test('connected plugin mention waits for catalog, keeps its logo, and sends plain words',()=>{
 const p=panel(),input=type(p,'Ask @composio');
 assert.ok(p.posted.some(m=>m.type==='requestPlugins'));
 p.send({type:'event',event:{type:'plugin_catalog',items:[
   {name:'composio',display_name:'Composio',connected:true,logo:'data:image/png;base64,AAAA'},
   {name:'notion',display_name:'Notion',connected:false,logo:'data:image/png;base64,AAAA'}]}});
 assert.match(p.doc.getElementById('pop').textContent,/Composio/);
 assert.doesNotMatch(p.doc.getElementById('pop').textContent,/Notion/);
 key(p,'Enter');
 const pill=input.querySelector('.pill-plugin');
 assert.equal(pill?.dataset.pluginId,'composio');
 assert.ok(pill.querySelector('.composer-plugin-mark img'));
 assert.equal(pill?.dataset.pill,'Composio');
 key(p,'Enter');
 const sent=p.posted.filter(m=>m.type==='prompt').at(-1);
 assert.equal(sent.text,'Ask Composio');
 assert.equal(sent.context,undefined);
});
test('Artifact mentions use their distinct picker icons and send without the sigil',()=>{
 const p=makeDom({clock:true});p.send(ready(0));p.send({type:'event',event:{type:'ready',capabilities:{artifacts:{version:1,outputs:['slides','dashboard','page']}},model:'m',mode:'default',think:'off',base_url:'http://localhost:1/v1',workspace_trusted:true,commands:[],custom_commands:[],goal:{text:'',status:'none'},context_size:1}});p.send({type:'session_ready',sessionId:'chat-a'});
 const input=type(p,'Make @dashboard');
 const row=[...p.doc.querySelectorAll('#pop .pi')].find(n=>n.textContent.includes('Dashboard'));
 assert.ok(row?.querySelector('.codicon-dashboard'));
 key(p,'Enter');
 const pill=input.querySelector('.pill-artifact');
 assert.equal(pill?.dataset.artifactKind,'dashboard');
 assert.ok(pill.querySelector('.codicon-dashboard'));
 key(p,'Enter');
 assert.equal(p.posted.filter(m=>m.type==='prompt').at(-1).text,'Make Dashboard');
});
test('mixed inline Pip, plugin and Artifact mentions survive a webview reload as inline mentions',()=>{
 const p=panel(), input=type(p,'Ask @pip');p.advance(120);
 answer(p,p.posted.filter(m=>m.type==='list_prompt_pips').at(-1));key(p,'Enter');
 const append=s=>{const node=p.doc.createTextNode(s);input.append(node);const range=p.doc.createRange();range.setStart(node,s.length);range.collapse(true);const selection=p.dom.window.getSelection();selection.removeAllRanges();selection.addRange(range);input.dispatchEvent(new p.dom.window.Event('input',{bubbles:true}));};
 append(' with @composio');
 p.send({type:'event',event:{type:'plugin_catalog',items:[{name:'composio',display_name:'Composio',connected:true,logo:'data:image/png;base64,AAAA'}]}});
 key(p,'Enter');
 p.send({type:'event',event:{type:'ready',capabilities:{pip_references:1,artifacts:{version:1,outputs:['page']}},model:'m',mode:'default',think:'off',base_url:'http://localhost:1/v1',workspace_trusted:true,commands:[],custom_commands:[],goal:{text:'',status:'none'},context_size:1}});
 append(' and @page');key(p,'Enter');
 assert.ok(input.querySelector('.pill-artifact'));
 p.advance(250);const state=p.savedState();assert.ok(state?.entries?.length);
 const q=makeDom({clock:true,state});q.send(ready(1));q.send({type:'session_ready',sessionId:'chat-a'});
 assert.equal(q.doc.querySelectorAll('#input .composer-pill').length,3);
 assert.equal(q.doc.querySelectorAll('#attachments .pip-reference-chip').length,0);
 assert.match(q.doc.querySelector('#input .pill-pip')?.textContent||'',/Rook review/);
 assert.match(q.doc.querySelector('#input .pill-plugin')?.textContent||'',/Composio/);
 assert.match(q.doc.querySelector('#input .pill-artifact')?.textContent||'',/Page/);
 key(q,'Enter');
 const sent=q.posted.filter(m=>m.type==='prompt').at(-1);
 assert.deepEqual(JSON.parse(JSON.stringify(sent.display_mentions?.map(m=>[m.kind,m.label]))),
   [['pip','Rook review'],['plugin','Composio'],['artifact','Page']]);
 assert.equal(q.doc.querySelectorAll('#log .prompt-text .sent-mention').length,3,
   'the sent message keeps every selected mark in place');
 assert.ok(q.doc.querySelector('#log .sent-mention.pill-artifact .composer-artifact-mark'),
   'the sent Artifact keeps its type icon');
 assert.ok(q.doc.querySelector('#log .sent-mention.pill-pip .composer-pip-face'),
   'the sent Pip keeps its face');
 q.send({type:'event',event:{type:'plugin_catalog',items:[
   {name:'composio',display_name:'Composio',connected:true,logo:'data:image/png;base64,AAAA'}]}});
 assert.ok(q.doc.querySelector('#log .sent-mention.pill-plugin .composer-plugin-mark img'),
   'the sent plugin gets its logo when the catalog arrives after a reload');
});
test('a restored sent plugin mention requests its logo with an empty composer',()=>{
 const p=panel();
 assert.equal(p.doc.querySelectorAll('#input .composer-pill').length,0);
 const before=p.posted.filter(m=>m.type==='requestPlugins').length;
 p.send({type:'event',event:{type:'turn_start',turn_id:'t-logo',kind:'prompt',prompt:'Use Composio',
   display_mentions:[{start:4,kind:'plugin',label:'Composio',identity:'composio'}]}});
 assert.equal(p.posted.filter(m=>m.type==='requestPlugins').length,before+1);
 p.send({type:'event',event:{type:'plugin_catalog',items:[
   {name:'composio',display_name:'Composio',connected:true,logo:'data:image/png;base64,AAAA'}]}});
 assert.ok(p.doc.querySelector('#log .sent-mention.pill-plugin .composer-plugin-mark img'));
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeDom} from './support/webview-dom.mjs';
const WS='ws_'+'a'.repeat(32), ID='pip_'+'b'.repeat(32);
const row={pip_id:ID,name:'Rook review',pip_type:'rook',status:'paused',job_version:2,lifecycle_revision:4};
const ready=cap=>({type:'event',event:{type:'ready',capabilities:{pip_references:cap},model:'m',mode:'default',think:'off',base_url:'http://localhost:1/v1',workspace_trusted:true,commands:[],custom_commands:[],goal:{text:'',status:'none'},context_size:1}});
function panel(){const p=makeDom({clock:true});p.send(ready(1));p.send({type:'session_ready',sessionId:'chat-a'});return p;}
function type(p,text){const input=p.doc.getElementById('input');input.value=text;input.selectionStart=input.selectionEnd=text.length;input.dispatchEvent(new p.dom.window.Event('input',{bubbles:true}));return input;}
function key(p,key){p.doc.getElementById('input').dispatchEvent(new p.dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));}
function open(p,text='Explain @'){type(p,text);key(p,'Enter');p.advance(120);return p.posted.filter(m=>m.type==='list_prompt_pips').at(-1);}
function answer(p,request,rows=[row],cursor=null){p.send({type:'event',event:{type:'prompt_pips',request_id:request.request_id,workspace_id:WS,pips:rows,next_cursor:cursor}});}
function select(p){answer(p,open(p));key(p,'Enter');}
test('Pip picker uses keyboard, sends only exact reference pins, and never attaches a session',()=>{
 const p=panel();select(p);assert.equal(p.doc.getElementById('input').value,'Explain ');
 assert.match(p.doc.getElementById('attachments').textContent,/@Rook review · Pip v2/);key(p,'Enter');
 const sent=p.posted.filter(m=>m.type==='prompt').at(-1);assert.deepEqual(JSON.parse(JSON.stringify(sent.pip_references)),[{pip_id:ID,expected_version:2,expected_lifecycle_revision:4}]);
 assert.equal(sent.context,undefined);assert.equal(p.posted.some(m=>m.type==='attach_pip_to_session'||m.type==='pipsRequest'),false);
});
test('file mention named pip remains independently selectable beside Pip category',()=>{
 const p=panel();p.send({type:'files',files:[{label:'pips.txt',path:'/ws/pips.txt',uri:'file:///ws/pips.txt',relative_path:'pips.txt',workspace:'ws'}]});type(p,'Read @pip');key(p,'ArrowDown');key(p,'Enter');key(p,'Enter');
 const sent=p.posted.filter(m=>m.type==='prompt').at(-1);assert.equal(sent.pip_references,undefined);assert.equal(sent.context[0].type,'file_mention');assert.equal(sent.context[0].path,'/ws/pips.txt');
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
 const p=panel(),r=open(p);p.send({type:'event',event:{type:'prompt_pips',request_id:r.request_id,workspace_id:'',pips:[],next_cursor:null}});assert.match(p.doc.getElementById('pop').textContent,/No Pips are registered/);key(p,'Escape');const next=open(p);answer(p,next,[{...row,name:'Rook\n\t<script>bad</script>'}]);assert.equal(p.doc.querySelector('#pop script'),null);key(p,'Enter');assert.match(p.doc.getElementById('attachments').textContent,/Rook <script>bad<\/script>/);
});

// pips-18, the editor half (Pips API 88): import a bot from a GitHub link, or from a Grok bot. The module's checks
// (src/pipImports.js), the host's allow-list and refusals (src/pipsView.ts pipImportsRefusal), and the flow in the
// real Pips client under jsdom: the Teams menu's two more rows, each dialog, what DGC is asked, and what shows after.
// DGC's answers here are the shapes dgc/headless.py `_pip_source_import` gives. The layout is in pip-imports-browser.test.mjs.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),base=new URL('../src/',import.meta.url);
const bundle=async file=>(await build({entryPoints:[new URL(file,base).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode'],loader:{'.css':'empty'}})).outputFiles[0].text;
const load=(code,req=require)=>{const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,req);return m.exports;};
const viewCode=await bundle('pipsView.ts'),viewModule=load(viewCode,name=>name==='vscode'?{}:require(name));
const imports=load(await bundle('pipImports.js'));
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dom=html=>new JSDOM(`<body>${html}</body>`).window.document;
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}
const PW='ws_'+'e'.repeat(32),pid=c=>'pip_'+c.repeat(32),PIP=pid('a');
const GOOD='https://github.com/acme/pips/blob/main/launch-crew.dgc-team.json';
const REPLY='Here is my description:\n```json\n{"dgc_import": 1, "name": "Deal Finder", "job": "Find deals.", "kind": "scout", "skills": ["compare prices"], "routines": []}\n```';
// DGC's own prompt, read from the backend so the page is shown the real one.
const PROMPT=(()=>{const py=readFileSync(new URL('../../../dgc/pip_import_sources.py',import.meta.url),'utf8'),block=py.slice(py.indexOf('GROK_PROMPT = (')+15,py.indexOf('\n)\n',py.indexOf('GROK_PROMPT = (')));
 return [...block.matchAll(/^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*$/gm)].map(m=>(m[1]??m[2]).replace(/\\n/g,'\n').replace(/\\(["'])/g,'$1')).join('');})();
const setupCard=(c,name,workspace=PW)=>({id:'setup_'+c.repeat(32),digest:'a'.repeat(64),workspace_id:workspace,project_root:'/home/me',pip_id:null,name,goal:'Do the '+name+' job.',pip_type:'lens',work_kind:'personal_task',source_ref:'HEAD',schedule:null,run_now:false,next_run_at:null,
 status:'pending',created_at:new Date().toISOString(),expires_at:'2099-10-02T06:00:00Z',receipt:null,reason:'Imported from a shared Pip file.',expected_version:null,expected_lifecycle_revision:null,permissions:'read_only',source_policy:'personal',
 runner_notice:'A schedule runs only while Pips are running.',scope_notice:'It works across your projects.',run_now_policy:null});

test('DGC’s prompt is read whole from the backend for these tests',()=>{
 assert.match(PROMPT,/^I'm moving you to another app called DGC\./);assert.match(PROMPT,/```json\n\{"dgc_import": 1, "name": "your name"/);assert.match(PROMPT,/anything private\.$/);
});

test('a GitHub link is checked as the host checks it: https, one of GitHub’s three hosts, 2,048 characters at most',()=>{
 for(const ok of [GOOD,'https://raw.githubusercontent.com/acme/pips/main/a.json','https://gist.githubusercontent.com/u/abc/raw/a.json','https://GitHub.com/a/b/blob/main/x.json'])assert.equal(imports.githubLink(`  ${ok}\n`),ok);
 assert.throws(()=>imports.githubLink(''),/^Error: Paste a GitHub link to a team file or a Pip file\.$/);assert.throws(()=>imports.githubLink('   '),/Paste a GitHub link/);
 for(const bad of ['http://github.com/a/b/blob/main/x.json','https://evil.example/a.json','https://github.com.evil.example/a/b/blob/m/x','https://user:pw@raw.githubusercontent.com/a/b/c','https://github.com:8443/a/b/blob/m/x','file:///etc/passwd',
  'github.com/a/b/blob/main/x.json','https://gist.github.com/u/abc','https://github.com/a/b/blob/main/two words.json','https://github.com/a/'+'x'.repeat(2048)])
  assert.throws(()=>imports.githubLink(bad),/^Error: Paste an https link to a file on GitHub/,bad.slice(0,60));
 assert.deepEqual(imports.GITHUB_HOSTS,['github.com','raw.githubusercontent.com','gist.githubusercontent.com']);
});

test('a Grok reply is something, 64 KiB at most; the prompt and DGC’s answer are read strictly',()=>{
 assert.equal(imports.grokReply(REPLY),REPLY,'as pasted, untouched');
 for(const empty of ['','  \n ',null,undefined,7])assert.throws(()=>imports.grokReply(empty),/^Error: Paste what your Grok bot wrote\.$/);
 assert.equal(imports.grokReply('x'.repeat(65536)).length,65536);assert.throws(()=>imports.grokReply('x'.repeat(65537)),/longer than a Grok bot’s description/);
 assert.throws(()=>imports.grokReply('é'.repeat(32769)),/longer/,'counted as it travels, in bytes');
 assert.equal(imports.importPrompt({prompt:PROMPT}),PROMPT);
 for(const bad of [null,{},{prompt:''},{prompt:'  '},{prompt:7},{prompt:'x'.repeat(8001)}])assert.throws(()=>imports.importPrompt(bad),/didn’t give the prompt as expected/);
 const cards=[setupCard('1','Researcher'),setupCard('2','Writer')];
 assert.deepEqual(imports.sourceImported({setups:cards,name:' Launch  crew ',left_out:['A note.',7,'']}),{name:'Launch crew',setups:cards,left:['A note.']});
 assert.equal(imports.sourceImported({setups:cards,name:''}).name,'A new Pip');
 for(const bad of [null,{},{setups:[],name:'x'},{setups:cards},{setups:cards,name:'x'.repeat(81)},{setups:[cards[0],cards[0]],name:'x'},{setups:[{...cards[0],status:'accepted'}],name:'x'},{setups:[{...cards[0],id:'setup_1'}],name:'x'},
  {setups:[{...cards[0],workspace_id:null}],name:'x'},{setups:Array.from({length:21},(_,i)=>setupCard(i.toString(16).padStart(1,'0').slice(-1),'P'+i)),name:'x'},{cancelled:true}])
  assert.throws(()=>imports.sourceImported(bad),/didn’t come back as expected/);
});

test('the line over the cards: what came from GitHub and what was left out; a Grok bot’s card and DGC’s notes on it',()=>{
 const three={name:'Launch crew',setups:[1,2,3],left:['Reads from connected apps: they name your accounts.']};
 assert.equal(imports.sourceImportedNotice(three,3,'github'),'Imported “Launch crew” from GitHub: 3 new Pips to review. Nothing is created until you approve each one. Not included: Reads from connected apps: they name your accounts.');
 assert.equal(imports.sourceImportedNotice({...three,left:[]},2,'github'),'Imported “Launch crew” from GitHub: 3 new Pips to review. Nothing is created until you approve each one. One is for this project: look under Project.');
 assert.equal(imports.sourceImportedNotice({name:'Bills',setups:[1],left:[]},0,'github'),'Imported “Bills” from GitHub: one new Pip to review. Nothing is created until you approve it. It is for this project: look under Project.');
 assert.equal(imports.sourceImportedNotice({name:'Deal Finder',setups:[1],left:['Its skills in Grok: compare prices. Add the ones you want on its page.','Imported from a Grok bot: it arrives with no keys and no app access.']},1,'grok'),
  'Imported “Deal Finder” from your Grok bot: one new Pip to review. Nothing is created until you approve it. Its skills in Grok: compare prices. Add the ones you want on its page. Imported from a Grok bot: it arrives with no keys and no app access.');
});

test('the dialogs’ bodies: a labelled link with its line; a read-only prompt with Copy, then a labelled box for the reply',()=>{
 let d=dom(imports.githubImportMarkup({esc,url:'https://github.com/a/b/blob/m/"x".json'}));
 const link=d.querySelector('#importLink');assert.equal(link.value,'https://github.com/a/b/blob/m/"x".json');assert.equal(link.maxLength,2048);assert.equal(link.dataset.draft,'importLink');
 assert.equal(d.querySelector('label[for=importLink]').firstChild.textContent,'Link to the file');assert.equal(link.getAttribute('aria-describedby'),'import-link-says');
 for(const host of imports.GITHUB_HOSTS)assert.ok(d.querySelector('#import-link-says').textContent.includes(host),host);
 assert.ok(dom(imports.githubImportMarkup({esc,busy:true})).querySelector('#importLink').disabled);
 d=dom(imports.grokImportMarkup({esc,prompt:PROMPT,reply:'<b>hi</b>'}));
 const prompt=d.querySelector('#importPrompt');assert.equal(prompt.value,PROMPT,'the whole prompt, as DGC wrote it');assert.ok(prompt.readOnly);assert.equal(prompt.dataset.draft,undefined,'never taken back from the page');
 assert.equal(d.getElementById(prompt.getAttribute('aria-labelledby')).textContent,'1Paste this prompt into your Grok bot, then paste its reply below.');
 assert.equal(d.querySelector('#import-prompt-copy').textContent,'Copy');assert.equal(d.querySelector('#import-copied').textContent,'');
 const reply=d.querySelector('#importReply');assert.equal(reply.value,'<b>hi</b>');assert.equal(d.querySelector('b'),null,'what was pasted is text');assert.equal(d.querySelector('label[for=importReply]').textContent.slice(0,10),'2Its reply');
 d=dom(imports.grokImportMarkup({esc,prompt:PROMPT,copied:true,busy:true}));
 assert.equal(d.querySelector('#import-prompt-copy').textContent,'Copied');assert.ok(d.querySelector('#importReply').disabled);
 d=dom(imports.grokImportMarkup({esc}));assert.equal(d.querySelector('#importPrompt'),null);assert.equal(d.querySelector('#import-prompt-wait').textContent,'Getting the prompt…');
 for(const html of [imports.githubImportMarkup({esc}),imports.grokImportMarkup({esc,prompt:PROMPT})])assert.doesNotMatch(dom(html).body.textContent.replace(PROMPT,''),/\bAI\b/);
});

function host(api=88){
 const panels=[];
 const vscode={ViewColumn:{Active:-1,Beside:-2},Uri:{joinPath:(...p)=>({path:p.map(x=>x.path||x).join('/')}),file:p=>({path:p})},workspace:{workspaceFolders:[],fs:{}},
  window:{createWebviewPanel:(id,title)=>{const p={id,title,posted:[],receive:null,webview:{cspSource:'csp',asWebviewUri:u=>u,postMessage:m=>{p.posted.push(m);return Promise.resolve(true);},onDidReceiveMessage:f=>{p.receive=f;}},
   reveal(){},onDidDispose(){},onDidChangeViewState(){}};panels.push(p);return p;}}};
 const {PipsEditor}=load(viewCode,name=>name==='vscode'?vscode:require(name));const main=[],sent=[];
 const editor=new PipsEditor({path:'ext'},m=>{sent.push(m);return true;},()=>{},true);editor.attach(m=>main.push(m));
 editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
 const generation=()=>main.filter(m=>m.type==='pipsConnection').at(-1).generation;let serial=0;
 const reply=(id,from=null)=>(from?from.posted:main).filter(m=>m.type==='pipsReply'&&m.id===id).at(-1);
 const ask=(request,from=null)=>{const id='q'+(++serial),before=sent.length;(from?from.receive:m=>editor.receive(m))({type:'pipsRequest',id,generation:generation(),request});
  return {id,call:sent.slice(before).find(m=>m.type==='pips_control')?.request,reply:reply(id,from)};};
 return {editor,panels,ask,reply,sent,main};
}
const bare=({request_id,...rest})=>{assert.match(request_id,/^[A-Za-z0-9_-]{8,128}$/);return rest;};

test('the allow-list at API 88: the prompt alone; a GitHub link at GitHub’s hosts; a Grok reply up to 64 KiB; nothing else rides along',()=>{
 const h=host();
 assert.deepEqual(bare(h.ask({type:'get_pip_import_prompt'}).call),{type:'get_pip_import_prompt'});
 for(const url of [GOOD,'https://raw.githubusercontent.com/acme/pips/main/a.json','https://gist.githubusercontent.com/u/abc/raw/a.json','https://github.com/a/b/blob/main/'+'x'.repeat(2048-34)])
  assert.deepEqual(bare(h.ask({type:'import_pip_source',source:'github',url}).call),{type:'import_pip_source',source:'github',url},url.slice(0,50));
 assert.deepEqual(bare(h.ask({type:'import_pip_source',source:'grok',text:REPLY}).call),{type:'import_pip_source',source:'grok',text:REPLY});
 // A full-size reply, every line end escaped on the way, still goes: the 16 KiB budget of other requests is not its limit.
 const big=('{"a": 1}\n'.repeat(8000)).slice(0,65536);assert.equal(Buffer.byteLength(big),65536);
 assert.equal(h.ask({type:'import_pip_source',source:'grok',text:big}).call.text,big,'64 KiB goes whole');
 const refused=(request,says)=>{const r=h.ask(request);assert.equal(r.call,undefined,JSON.stringify(request).slice(0,90));assert.equal(r.reply.ok,false);assert.match(r.reply.error.message,says);};
 for(const url of ['http://github.com/a/b/blob/main/x.json','https://evil.example/a.json','https://github.com.evil.example/a/b/blob/m/x','https://user:pw@raw.githubusercontent.com/a/b/c','https://github.com:8443/a/b/blob/m/x','file:///etc/passwd',
  'https://gist.github.com/u/abc','https://api.github.com/repos/a/b','HTTPS://github.com/a/b/blob/m/x\n','https://github.com/a/b/blob/m/two words','https:github.com/a/b/blob/m/x','https://github.com/a/'+'x'.repeat(2048),'',7,null,undefined,['https://github.com/a/b/blob/m/x']])
  refused({type:'import_pip_source',source:'github',url},/^Paste an https link to a file on GitHub\.$/);
 for(const text of ['','  \n',7,null,undefined,[REPLY]])refused({type:'import_pip_source',source:'grok',text},/^Paste what your Grok bot wrote\.$/);
 refused({type:'import_pip_source',source:'grok',text:'x'.repeat(65537)},/^What a Grok bot wrote is 64 KiB at most\.$/);
 refused({type:'import_pip_source',source:'grok',text:'é'.repeat(32769)},/64 KiB at most/);
 for(const source of ['ftp','file','team','GitHub',' grok','',7,null,undefined])refused({type:'import_pip_source',source,url:GOOD,text:REPLY},/^Import from a GitHub link or from a Grok bot\.$/);
 // No other key: a link with a text, a reply with a link, a path, a document, a Pip.
 refused({type:'import_pip_source',source:'github',url:GOOD,text:REPLY},/Paste an https link/);refused({type:'import_pip_source',source:'grok',text:REPLY,url:GOOD},/Paste what your Grok bot wrote/);
 for(const extra of [{path:'/etc/passwd'},{document:'{}'},{pip_id:PIP},{headers:{}},{request_id:'x'}]){refused({type:'import_pip_source',source:'github',url:GOOD,...extra},/Paste an https link/);refused({type:'import_pip_source',source:'grok',text:REPLY,...extra},/Paste what your Grok bot wrote/);}
 refused({type:'get_pip_import_prompt',source:'grok'},/^Ask for the Grok prompt alone\.$/);
 assert.equal(viewModule.pipImportsRefusal({type:'list_pips'},88),'','every other request is none of its business');
 assert.equal(viewModule.pipImportsRefusal({type:'import_pip_source',source:'github',url:GOOD},88),'');
});

test('an older DGC is never sent an import, and a Pip’s computer tab asks for none',()=>{
 const old=host(87);
 for(const request of [{type:'get_pip_import_prompt'},{type:'import_pip_source',source:'github',url:GOOD},{type:'import_pip_source',source:'grok',text:REPLY}]){
  const r=old.ask(request);assert.equal(r.call,undefined,request.type);assert.equal(r.reply.error.message,'Update DGC to import a bot from GitHub or Grok.');}
 const h=host();h.editor.receive({type:'pipsOpenComputer',pip:{id:PIP,name:'Mornings',pip_type:'lens'}});
 const tab=h.panels.at(-1);assert.ok(tab,'its computer tab opened');
 for(const request of [{type:'get_pip_import_prompt'},{type:'import_pip_source',source:'github',url:GOOD},{type:'import_pip_source',source:'grok',text:REPLY}]){
  const r=h.ask(request,tab);assert.equal(r.call,undefined,request.type);assert.equal(r.reply.ok,false);assert.match(r.reply.error.message,/only uses this Pip's computer/);}
});

test('DGC’s answer and DGC’s refusal reach the page that asked, as they are',()=>{
 const h=host(),cards=[setupCard('1','Researcher')];
 const a=h.ask({type:'import_pip_source',source:'github',url:GOOD});
 h.editor.event({type:'pips_result',request_id:a.call.request_id,command:'import_pip_source',ok:true,result:{setups:cards,name:'Launch crew',left_out:[]}});
 assert.deepEqual(h.reply(a.id).result,{setups:cards,name:'Launch crew',left_out:[]});
 const b=h.ask({type:'import_pip_source',source:'grok',text:'no json here'});
 h.editor.event({type:'pips_result',request_id:b.call.request_id,command:'import_pip_source',ok:false,error:{code:'invalid_import',message:'There is no JSON block in what you pasted. Ask your Grok bot again with the prompt DGC gave you.'}});
 assert.equal(h.reply(b.id).ok,false);assert.match(JSON.stringify(h.reply(b.id).error),/There is no JSON block in what you pasted/);
});

const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const job=(c,name,extra={})=>({id:pid(c),workspace_id:PW,pip_type:'scout',name,goal:'Help with '+name+'.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',
 profile:{title:'',body:null,color:null,notify:true,group:''},...extra});
function page({api=88}={}){
 const w=new JSDOM(viewModule.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}).window;windows.push(w);
 const sent=[],answered=new Set(),state={list:[job('1','Core',{pip_type:'core'}),job('a','Mornings',{pip_type:'lens'})],setups:[],promptAnswers:true};
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;w.Element.prototype.scrollIntoView=()=>{};
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(client);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:state.setups}),
  list_pips:()=>({pips:state.list}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),get_pip_digest:()=>undefined,
  get_pip_import_prompt:()=>state.promptAnswers?{prompt:PROMPT}:undefined}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:true,enabled:true});
 const d=w.document,click=s=>{const el=typeof s==='string'?d.querySelector(s):s;assert.ok(el,'Missing '+s);el.click();};
 const type=(s,value)=>{const el=d.querySelector(s);assert.ok(el,'Missing '+s);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));};
 const key=(s,k)=>d.querySelector(s).dispatchEvent(new w.KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));
 const dialog=()=>d.querySelector('[role=dialog]'),alert=()=>dialog()?.querySelector('[role=alert]')?.textContent||'';
 const plain=m=>JSON.parse(JSON.stringify(m.request));
 return {w,d,sent,answer,requests,drain,click,type,key,state,dialog,alert,plain};
}

test('the Teams menu: Export team…, Import team…, Import from GitHub…, Bring a Grok bot…; an older DGC shows neither new row',async()=>{
 const x=page();await x.drain();
 assert.deepEqual([...x.d.querySelectorAll('.team-menu .tabs-menu button')].map(b=>[b.id,b.textContent,b.disabled]),
  [['team-export','Export team…',false],['team-import','Import team…',false],['team-import-github','Import from GitHub…',false],['team-import-grok','Bring a Grok bot…',false]]);
 assert.doesNotMatch(x.d.querySelector('.team-menu').textContent+x.d.querySelector('.team-menu summary').title,/\bAI\b/);
 const old=page({api:87});await old.drain();
 assert.equal(old.d.querySelector('#team-import-github, #team-import-grok'),null);
});

test('Import from GitHub…: a link is checked before DGC is asked; DGC’s refusal stays in the dialog; a good link brings the cards and a line naming them',async()=>{
 const x=page();await x.drain();
 x.click('#team-import-github');
 assert.equal(x.dialog().querySelector('h2').textContent,'Import from GitHub');assert.ok(x.dialog().classList.contains('is-pinned'),'its buttons are pinned');
 assert.equal(x.d.activeElement.id,'importLink','the keyboard starts in the link');assert.equal(x.d.querySelector('#review-confirm').textContent,'Import');
 assert.equal(x.d.querySelector('.team-menu').open,false,'the menu closed');
 x.click('#review-confirm');assert.equal(x.alert(),'Paste a GitHub link to a team file or a Pip file.');
 x.type('#importLink','https://example.com/team.json');assert.equal(x.alert(),'','typing takes the last refusal away');
 x.key('#importLink','Enter');assert.match(x.alert(),/^Paste an https link to a file on GitHub/);assert.equal(x.d.querySelector('#importLink').value,'https://example.com/team.json');
 assert.equal(x.requests('import_pip_source').length,0,'DGC is not asked for a link that can’t be GitHub’s');
 x.type('#importLink',`  ${GOOD} `);x.key('#importLink','Enter');
 assert.deepEqual(x.plain(x.requests('import_pip_source')[0]),{type:'import_pip_source',source:'github',url:GOOD},'the source and the link, tidied, and nothing else');
 assert.ok(x.d.querySelector('#importLink').disabled&&x.d.querySelector('#review-confirm').disabled&&x.d.querySelector('#review-cancel').disabled,'the dialog waits');
 assert.equal(x.d.querySelector('#review-confirm').textContent,'Importing…');
 x.click('#review-confirm');x.key('#importLink','Enter');assert.equal(x.requests('import_pip_source').length,1,'one request while it waits');
 x.answer(x.requests('import_pip_source')[0],'DGC couldn’t read that file from GitHub (HTTPError).',false);await x.drain();
 assert.equal(x.alert(),'DGC couldn’t read that file from GitHub (HTTPError).');assert.equal(x.d.querySelector('#importLink').value,GOOD,'the link is still there');
 assert.equal(x.d.querySelector('#review-confirm').disabled,false);assert.equal(x.d.querySelector('.notice:not(.error)'),null,'nothing is said on the page behind');
 // An answer that isn't DGC's shape is said so, and nothing is shown as imported.
 x.click('#review-confirm');x.answer(x.requests('import_pip_source')[1],{setups:[{id:'x'}],name:'Launch crew'});await x.drain();
 assert.match(x.alert(),/didn’t come back as expected/);
 const cards=[setupCard('1','Researcher'),setupCard('2','Writer'),setupCard('3','Tests','ws_'+'f'.repeat(32))];x.state.setups=cards.slice(0,2);
 x.click('#review-confirm');x.answer(x.requests('import_pip_source')[2],{setups:cards,name:'Launch crew',left_out:['Reads from connected apps: they name your accounts.']});await x.drain();
 assert.equal(x.dialog(),null,'the dialog closed');
 assert.equal(x.d.querySelector('.notice').textContent,'Imported “Launch crew” from GitHub: 3 new Pips to review. Nothing is created until you approve each one. One is for this project: look under Project. Not included: Reads from connected apps: they name your accounts.');
 const waiting=x.d.querySelector('[aria-label="Needs you"]');assert.ok(waiting,'the cards show where new Pips wait');assert.match(waiting.textContent,/Create the Pip “Researcher”\?/);assert.match(waiting.textContent,/1 of 2/);
 assert.equal(x.requests('accept_pip_setup').length,0,'nothing is approved by importing');
 // Opened again, it starts empty; Escape closes it and asks nothing.
 x.click('#team-import-github');assert.equal(x.d.querySelector('#importLink').value,'');assert.equal(x.alert(),'');
 x.key('#importLink','Escape');assert.equal(x.dialog(),null);assert.equal(x.requests('import_pip_source').length,3);
});

test('Bring a Grok bot…: DGC’s prompt to copy, then what the bot wrote goes to DGC; its refusal stays in the dialog; its card comes with DGC’s notes',async()=>{
 const x=page();x.state.promptAnswers=false;await x.drain();
 x.click('#team-import-grok');
 assert.equal(x.dialog().querySelector('h2').textContent,'Bring a Grok bot');assert.ok(x.dialog().classList.contains('is-pinned'));
 assert.equal(x.dialog().querySelector('#import-prompt-wait').textContent,'Getting the prompt…');assert.ok(x.d.querySelector('#review-confirm').disabled,'nothing to import until the prompt is here');
 assert.deepEqual(x.plain(x.requests('get_pip_import_prompt')[0]),{type:'get_pip_import_prompt'});
 x.answer(x.requests('get_pip_import_prompt')[0],{prompt:PROMPT});await x.drain();
 const prompt=x.d.querySelector('#importPrompt');assert.equal(prompt.value,PROMPT);assert.ok(prompt.readOnly);assert.equal(x.d.querySelector('#review-confirm').disabled,false);
 assert.equal(x.d.activeElement.id,'import-prompt-copy','the keyboard is on Copy');
 // Copy hands the host the prompt and says so in place.
 const copy=x.d.querySelector('#import-prompt-copy');x.click(copy);
 assert.deepEqual(JSON.parse(JSON.stringify(x.sent.filter(m=>m.type==='copy'))),[{type:'copy',text:PROMPT}]);assert.ok(PROMPT.length<=2048,'the prompt fits the host’s copy');
 assert.equal(x.d.querySelector('#import-prompt-copy'),copy,'the same button: nothing was drawn again');assert.equal(copy.textContent,'Copied');assert.equal(x.d.querySelector('#import-copied').textContent,'Now paste it into your Grok bot.');
 x.click('#review-confirm');assert.equal(x.alert(),'Paste what your Grok bot wrote.');assert.equal(x.requests('import_pip_source').length,0);
 assert.equal(x.d.querySelector('#import-prompt-copy').textContent,'Copied','drawn again, it still says Copied');
 x.type('#importReply','Sure! I am a helpful bot.');assert.equal(x.alert(),'');
 x.key('#importReply','Enter');assert.equal(x.requests('import_pip_source').length,0,'Enter in the reply is a new line, not Import');
 x.click('#review-confirm');
 assert.deepEqual(x.plain(x.requests('import_pip_source')[0]),{type:'import_pip_source',source:'grok',text:'Sure! I am a helpful bot.'});
 x.answer(x.requests('import_pip_source')[0],'There is no JSON block in what you pasted. Ask your Grok bot again with the prompt DGC gave you.',false);await x.drain();
 assert.equal(x.alert(),'There is no JSON block in what you pasted. Ask your Grok bot again with the prompt DGC gave you.');
 assert.equal(x.d.querySelector('#importReply').value,'Sure! I am a helpful bot.','what was pasted is still there');assert.equal(x.d.querySelector('#importPrompt').value,PROMPT);
 x.type('#importReply',REPLY);x.click('#review-confirm');
 assert.deepEqual(x.plain(x.requests('import_pip_source')[1]),{type:'import_pip_source',source:'grok',text:REPLY},'as pasted, untouched');
 const card=setupCard('9','Deal Finder');x.state.setups=[card];
 const notes=['Its skills in Grok: compare prices. Add the ones you want on its page.','Imported from a Grok bot: it arrives with no keys and no app access.'];
 x.answer(x.requests('import_pip_source')[1],{setups:[card],name:'Deal Finder',left_out:notes});await x.drain();
 assert.equal(x.dialog(),null);
 assert.equal(x.d.querySelector('.notice').textContent,'Imported “Deal Finder” from your Grok bot: one new Pip to review. Nothing is created until you approve it. '+notes.join(' '));
 assert.match(x.d.querySelector('[aria-label="Needs you"]').textContent,/Create the Pip “Deal Finder”\?/);assert.equal(x.requests('accept_pip_setup').length,0);
 // Opened again: a new prompt is asked for, the reply's box is empty, and a prompt DGC can't give is said in the dialog.
 x.click('#team-import-grok');assert.equal(x.d.querySelector('#importReply').value,'');assert.equal(x.requests('get_pip_import_prompt').length,2);
 x.answer(x.requests('get_pip_import_prompt')[1],'Pips are switched off on this computer.',false);await x.drain();
 assert.equal(x.alert(),'Pips are switched off on this computer.');assert.ok(x.d.querySelector('#review-confirm').disabled);assert.equal(x.d.querySelector('#importPrompt'),null);
 x.click('#review-cancel');assert.equal(x.dialog(),null);
 // A prompt that arrives after the dialog was closed opens nothing.
 x.click('#team-import-grok');const late=x.requests('get_pip_import_prompt')[2];x.click('#review-cancel');x.answer(late,{prompt:PROMPT});await x.drain();assert.equal(x.dialog(),null);
});

test('Export team’s dialog pins its buttons too; other dialogs are as they were',async()=>{
 const x=page();await x.drain();
 x.click('#team-export');assert.ok(x.dialog().classList.contains('is-pinned'));assert.equal(x.d.querySelector('#review-confirm').textContent,'Export…');
 x.click('#review-confirm');assert.equal(x.d.querySelector('#review-confirm').textContent,'Applying…','its waiting word is unchanged');
 const css=readFileSync(new URL('pips.css',base),'utf8');
 assert.match(css,/\.dialog\.is-pinned>\.actions\{position:sticky;bottom:0;/);assert.doesNotMatch(css,/\.dialog \.actions\{[^}]*sticky/,'only a pinned dialog');
});

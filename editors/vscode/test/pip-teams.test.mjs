// pips-12, the editor half (Pips API 88): Library, departments and team files.
// - "Skills" on a Pip's page: get_pip_skills is read strictly, one row a skill with its one line and a switch that
//   tells DGC (set_pip_skill); a refusal puts the switch back.
// - Folders in the Personal list: a Pip's folder is profile.group; Pips without one come first under no heading, each
//   folder under its heading with its count, which folds; the folder is set on the Pip's page from a small menu.
// - Team files: Export team… ticks Pips and names the team, and the host saves the file; Import team… has the host
//   read the file, and the cards show with a line naming the team and what was left out. The page never has a path.
// The host's allow-list takes these only at API 88, each named as DGC names it. The look, in real Chromium:
// pip-teams-browser.test.mjs.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),base=new URL('../src/',import.meta.url);
const bundle=async file=>(await build({entryPoints:[new URL(file,base).pathname],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode'],loader:{'.css':'empty'}})).outputFiles[0].text;
const load=(code,req=require)=>{const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,req);return m.exports;};
const viewCode=await bundle('pipsView.ts'),viewModule=load(viewCode,name=>name==='vscode'?{}:require(name));
const skills=load(await bundle('pipSkills.js')),teams=load(await bundle('pipTeams.js'));
const client=(await build({entryPoints:[new URL('pipsClient.js',base).pathname],bundle:true,write:false,format:'iife',loader:{'.css':'empty'}})).outputFiles[0].text;
const windows=[];after(()=>windows.forEach(w=>w.close()));
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dom=html=>new JSDOM(`<body>${html}</body>`).window.document;
async function flush(){for(let i=0;i<15;i++)await Promise.resolve();}

const PW='ws_'+'e'.repeat(32),pid=c=>'pip_'+c.repeat(32),PIP=pid('a');
// As dgc/pip_skill_switches.py's listing answers (tests/test_pip_skill_switches.py).
const SKILLS=[{name:'budget',description:'Plans a monthly budget from what you spend.',source:'user',on:true},
 {name:'deep-research',description:'Researches a question across many sources and cites them.',source:'builtin',on:false},
 {name:'stripe.refunds',description:'',source:'plugin',on:true}];

test('get_pip_skills is read strictly: each skill’s name, one line, where it is from and its switch',()=>{
 const list=skills.pipSkillsPage({pip_id:PIP,skills:SKILLS},PIP);
 assert.deepEqual(list.map(s=>[s.name,s.source,s.on]),[['budget','user',true],['deep-research','builtin',false],['stripe.refunds','plugin',true]]);
 assert.deepEqual(skills.pipSkillsPage({pip_id:PIP,skills:[]},PIP),[]);
 for(const bad of [null,{pip_id:pid('b'),skills:[]},{pip_id:PIP},{pip_id:PIP,skills:[{...SKILLS[0],name:'Bad Skill!'}]},{pip_id:PIP,skills:[{...SKILLS[0],name:''}]},{pip_id:PIP,skills:[{...SKILLS[0],on:'yes'}]},
  {pip_id:PIP,skills:[{...SKILLS[0],description:7}]},{pip_id:PIP,skills:[{...SKILLS[0],description:'x'.repeat(301)}]},{pip_id:PIP,skills:[{...SKILLS[0],source:null}]},{pip_id:PIP,skills:[SKILLS[0],SKILLS[0]]},
  {pip_id:PIP,skills:Array.from({length:201},(_,i)=>({...SKILLS[0],name:'s'+i}))}])
  assert.throws(()=>skills.pipSkillsPage(bad,PIP),/didn’t load/,JSON.stringify(bad)?.slice(0,80));
 assert.equal(skills.pipSkillSwitched({skill:'budget',on:false},'budget',false),false);
 assert.throws(()=>skills.pipSkillSwitched({skill:'other',on:false},'budget',false),/another skill/);
 assert.throws(()=>skills.pipSkillSwitched({skill:'budget',on:true},'budget',false),/another skill/);
});

test('the Skills section: one row a skill with its one line and the page’s switch; off reads muted and says so',()=>{
 const d=dom(skills.pipSkillsMarkup(skills.pipSkillsPage({pip_id:PIP,skills:SKILLS},PIP),{esc,pipName:'Mornings'}));
 const section=d.querySelector('section.pip-page-group.pip-skills');assert.equal(section.getAttribute('aria-label'),'Skills');
 assert.match(section.querySelector('.pip-page-label').textContent,/^Skills/);
 const rows=[...d.querySelectorAll('[data-pip-skill]')];
 assert.deepEqual(rows.map(r=>[r.dataset.pipSkill,r.querySelector('strong').textContent,r.querySelector('.pip-skill-line')?.textContent||'',r.querySelector('.pip-skill-says').textContent,r.classList.contains('is-off')]),[
  ['budget','budget','Plans a monthly budget from what you spend.','Yours',false],
  ['deep-research','deep-research','Researches a question across many sources and cites them.','Comes with DGC · Off for Mornings',true],
  ['stripe.refunds','stripe.refunds','','From a plugin',false]]);
 for(const r of rows){const box=r.querySelector('input[role=switch]');assert.equal(box.dataset.pipSkillSwitch,r.dataset.pipSkill);assert.equal(box.checked,r.dataset.on==='true');
  assert.equal(box.getAttribute('aria-label'),`${r.dataset.pipSkill} for Mornings`);assert.ok(box.closest('label.switch'),'the switch the page already uses');
  assert.ok(d.getElementById(box.getAttribute('aria-describedby')),'its switch names the line that says what it is');}
 assert.equal(new Set(rows.map(r=>r.querySelector('input').getAttribute('aria-describedby'))).size,3,'each row’s line has its own id');
 assert.match(dom(skills.pipSkillsMarkup([],{esc,pipName:'Mornings'})).body.textContent,/None yet\./);
 assert.match(dom(skills.pipSkillsMarkup(null,{esc})).querySelector('[role=status]').textContent,/Loading/);
 assert.equal(dom(skills.pipSkillsMarkup(null,{esc,error:'Only you can choose a Pip’s skills.'})).querySelector('[role=alert]').textContent,'Only you can choose a Pip’s skills.');
 assert.ok([...dom(skills.pipSkillsMarkup(skills.pipSkillsPage({pip_id:PIP,skills:SKILLS},PIP),{esc,busy:true})).querySelectorAll('input')].every(i=>i.disabled));
 assert.doesNotMatch(d.body.textContent,/\bAI\b/);
});

const job=(c,name,extra={})=>({id:pid(c),workspace_id:PW,pip_type:'scout',name,goal:'Help with '+name+'.',source_policy:{mode:'personal'},source_ref:'HEAD',status:'active',current_version:1,lifecycle_revision:0,policy:'read_only',
 trigger:'manual',schedule:null,proposals:[],pending_review_count:0,profile:{title:'',body:null,color:null,notify:true,group:''},...extra});
const inFolder=(c,name,group,extra={})=>job(c,name,{profile:{title:'',body:null,color:null,notify:true,group},...extra});

test('folders: a Pip’s folder is its profile’s group; the list is the Pips with none, then each folder by name',()=>{
 assert.equal(teams.pipFolder({group:'Launch'}),'Launch');assert.equal(teams.pipFolder({group:''}),'');assert.equal(teams.pipFolder({title:''}),'','a DGC from before folders');
 for(const bad of [null,undefined,'Launch',{group:7},{group:'x'.repeat(41)},{group:'two\nlines'}])assert.equal(teams.pipFolder(bad),'',JSON.stringify(bad));
 const list=[job('1','Core',{pip_type:'core'}),inFolder('2','Writer','Launch'),job('3','Mornings'),inFolder('4','Bills','Home'),inFolder('5','Researcher','Launch'),inFolder('6','Old','archive 10')];
 assert.deepEqual(teams.foldersInUse(list),['archive 10','Home','Launch']);
 const held=teams.pipsByFolder(list);
 assert.deepEqual(held.loose.map(p=>p.name),['Core','Mornings'],'no folder: first, in the list’s own order');
 assert.deepEqual(held.folders.map(f=>[f.name,f.pips.map(p=>p.name)]),[['archive 10',['Old']],['Home',['Bills']],['Launch',['Writer','Researcher']]]);
 assert.deepEqual(teams.pipsByFolder([]),{loose:[],folders:[]});
 // A new folder's name, as typed.
 assert.equal(teams.folderName('  Launch   week '),'Launch week');assert.equal(teams.folderName('x'.repeat(40)).length,40);
 assert.throws(()=>teams.folderName('   '),/Give the folder a name/);assert.throws(()=>teams.folderName('x'.repeat(41)),/up to 40 characters/);
 // Its heading: a button that folds it, with how many it holds.
 const open=dom(teams.folderMarkup(held.folders[2],2,{esc,open:true,rows:'<i id="rows"></i>'})),head=open.querySelector('.pip-folder-head > button.pip-folder-toggle');
 assert.equal(open.querySelector('section.pip-folder').getAttribute('aria-label'),'Launch, 2 Pips');
 assert.equal(head.getAttribute('aria-expanded'),'true');assert.equal(head.dataset.pipFolderToggle,'Launch');
 assert.equal(head.querySelector('.pip-folder-name').textContent,'Launch');assert.equal(head.querySelector('.pip-folder-count').textContent,'2');
 assert.ok(open.getElementById(head.getAttribute('aria-controls')).querySelector('#rows'),'its rows are what the button controls');
 const shut=dom(teams.folderMarkup(held.folders[1],1,{esc,open:false,rows:'<i id="rows"></i>'}));
 assert.equal(shut.querySelector('button').getAttribute('aria-expanded'),'false');assert.equal(shut.querySelector('#rows'),null,'folded: its rows are not drawn');
 assert.equal(shut.querySelector('section').getAttribute('aria-label'),'Home, 1 Pip');
});

test('Folder on a Pip’s page: a button that says where it is; its menu is No folder, the folders in use and New folder…',()=>{
 const shut=dom(teams.pipFolderMarkup({esc,folder:'Launch',folders:['Home','Launch'],pipName:'Mornings'}));
 assert.equal(shut.querySelector('section.pip-page-group').getAttribute('aria-label'),'Folder');
 const btn=shut.querySelector('button[data-pip-folder-open]');assert.equal(btn.textContent,'Launch');assert.equal(btn.getAttribute('aria-expanded'),'false');assert.equal(btn.getAttribute('aria-haspopup'),'menu');
 assert.equal(shut.querySelector('.pip-folder-menu'),null);
 assert.equal(dom(teams.pipFolderMarkup({esc,folder:'',folders:[]})).querySelector('[data-pip-folder-open]').textContent,'No folder');
 const open=dom(teams.pipFolderMarkup({esc,folder:'Launch',folders:['Home','Launch'],open:true,pipName:'Mornings'})),menu=open.querySelector('.dgc-menu.pip-folder-menu[role=menu]');
 assert.equal(menu.getAttribute('aria-label'),'Folder for Mornings');
 assert.deepEqual([...menu.querySelectorAll('.dgc-menu-row')].map(r=>[r.textContent,r.getAttribute('role'),r.getAttribute('aria-checked'),r.dataset.pipFolderPick]),
  [['No folder','menuitemradio','false',''],['Home','menuitemradio','false','Home'],['Launch','menuitemradio','true','Launch'],['New folder…','menuitem',null,undefined]]);
 assert.ok(menu.querySelector('[data-pip-folder-new]'));
 const adding=dom(teams.pipFolderMarkup({esc,folder:'',folders:[],adding:true,draft:'Lau',error:'Give the folder a name.'})),box=adding.querySelector('#pip-folder-form input#pipFolderName');
 assert.equal(box.value,'Lau');assert.equal(box.maxLength,40);assert.ok(adding.querySelector(`label[for="${box.id}"]`),'the box has a name');
 assert.deepEqual([...adding.querySelectorAll('#pip-folder-form button')].map(b=>[b.textContent,b.type]),[['Add','submit'],['Cancel','button']]);
 assert.equal(adding.querySelector('[role=alert]').textContent,'Give the folder a name.');
});

test('team files: the Pips a file can hold, the request the dialog makes, and what comes back, each checked',()=>{
 const list=[job('1','Core',{pip_type:'core'}),inFolder('2','Writer','Launch',{pip_type:'quill'}),job('3','Mornings',{pip_type:'lens'}),job('4','Fixer',{pip_type:'patch'}),job('5','Gone',{status:'archived'})];
 const pips=teams.teamPips(list);assert.deepEqual(pips.map(p=>p.name),['Writer','Mornings'],'not your Primary Pip, a Patch Pip or an archived one');
 const all=new Set(pips.map(p=>p.id)),d=dom(teams.teamExportMarkup({esc,pips,ticked:all,name:'',left:2}));
 assert.equal(d.querySelector('#teamName').maxLength,80);assert.equal(d.querySelector('#teamName').placeholder,'My team');
 assert.deepEqual([...d.querySelectorAll('input[data-team-pip]')].map(b=>[b.dataset.teamPip,b.checked,b.closest('label').querySelector('strong').textContent,b.closest('label').querySelector('small')?.textContent||'']),
  [[pid('2'),true,'Writer','Launch'],[pid('3'),true,'Mornings','']]);
 assert.equal(d.querySelector('#team-count').textContent,'2 Pips in this team.');
 assert.match(d.body.textContent,/Your accounts, memory, chats and results stay here\. 2 Pips aren’t listed: your Primary Pip and Patch Pips can’t be shared\./);
 assert.deepEqual(teams.teamExportRequest(pips,all,'  Launch   crew '),{pip_ids:[pid('2'),pid('3')],name:'Launch crew'});
 assert.deepEqual(teams.teamExportRequest(pips,new Set([pid('3')]),''),{pip_ids:[pid('3')],name:''},'no name: DGC calls it My team');
 assert.throws(()=>teams.teamExportRequest(pips,new Set(),'x'),/Tick at least one Pip/);
 assert.deepEqual(teams.teamCount(21),{ok:false,says:'21 ticked. A team file holds up to 20: untick 1.'});assert.deepEqual(teams.teamCount(1),{ok:true,says:'1 Pip in this team.'});
 // The host's answer once the file is saved.
 const saved=teams.teamExported({saved:true,file:'launch.dgc-team.json',name:'Launch',count:2,left_out:['Memory, history, findings and results stay with the original Pip.']});
 assert.equal(teams.teamExportedNotice(saved),'Saved the team “Launch” (2 Pips) as launch.dgc-team.json. Not included: Memory, history, findings and results stay with the original Pip.');
 assert.equal(teams.teamExported({cancelled:true}),null);
 for(const bad of [null,{},{saved:true,file:'/home/me/launch.dgc-team.json',name:'Launch',count:2},{saved:true,file:'a.json',name:'Launch',count:0},{saved:true,file:'a.json',name:7,count:1},{saved:false,file:'a.json',name:'x',count:1}])
  assert.throws(()=>teams.teamExported(bad),/didn’t save as expected/,JSON.stringify(bad));
 // import_pip_team's answer (dgc/headless.py _pip_team_import): {setups, name, left_out}.
 const card=(c,workspace=PW)=>({id:'setup_'+c.repeat(32),workspace_id:workspace,status:'pending',name:'Imported '+c});
 const done=teams.teamImported({setups:[card('1'),card('2'),card('3','ws_'+'f'.repeat(32))],name:'Launch',left_out:['Reads from connected apps: they name your accounts.']});
 assert.equal(teams.teamImportedNotice(done,2),'Imported the team “Launch”: 3 new Pips to review. Nothing is created until you approve each one. One is for this project: look under Project. Not included: Reads from connected apps: they name your accounts.');
 assert.equal(teams.teamImportedNotice(teams.teamImported({setups:[card('1')],name:'',left_out:[]}),1),'Imported the team “My team”: one new Pip to review. Nothing is created until you approve each one.');
 assert.equal(teams.teamImported({cancelled:true}),null);
 for(const bad of [null,{setups:[],name:'x',left_out:[]},{setups:[card('1'),card('1')],name:'x'},{setups:[{...card('1'),status:'accepted'}],name:'x'},{setups:[{...card('1'),id:'setup_1'}],name:'x'},{setups:[card('1')],name:7},
  {setups:Array.from({length:21},(_,i)=>card(i.toString(16).padStart(2,'0').slice(-1))),name:'x'}])
  assert.throws(()=>teams.teamImported(bad),/didn’t import as expected/,JSON.stringify(bad)?.slice(0,80));
});

// The host: what the Pips page may ask DGC (src/pipsView.ts), and the two file flows.
function host(api=88,vs={}){
 const panels=[];
 const vscode={ViewColumn:{Active:-1,Beside:-2},Uri:{joinPath:(...p)=>({path:p.map(x=>x.path||x).join('/')}),file:p=>({path:p})},workspace:{workspaceFolders:[],fs:{},...vs.workspace},
  window:{createWebviewPanel:(id,title)=>{const p={id,title,posted:[],receive:null,webview:{cspSource:'csp',asWebviewUri:u=>u,postMessage:m=>{p.posted.push(m);return Promise.resolve(true);},onDidReceiveMessage:f=>{p.receive=f;}},
   reveal(){},onDidDispose(){},onDidChangeViewState(){}};panels.push(p);return p;},...vs.window}};
 const {PipsEditor}=load(viewCode,name=>name==='vscode'?vscode:require(name));const main=[],sent=[];
 const editor=new PipsEditor({path:'ext'},m=>{sent.push(m);return true;},()=>{},true);editor.attach(m=>main.push(m));
 editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
 const generation=()=>main.filter(m=>m.type==='pipsConnection').at(-1).generation;let serial=0;
 const reply=(id,from=null)=>(from?from.posted:main).filter(m=>m.type==='pipsReply'&&m.id===id).at(-1);
 const ask=(request,from=null)=>{const id='q'+(++serial),before=sent.length;(from?from.receive:m=>editor.receive(m))({type:'pipsRequest',id,generation:generation(),request});
  return {id,call:sent.slice(before).find(m=>m.type==='pips_control')?.request,reply:reply(id,from)};};
 return {editor,panels,ask,reply,sent,main};
}
test('the allow-list: skills and a folder go from the Pips page at API 88, each named as DGC names it, and never to an older DGC',()=>{
 const h=host();
 const list=h.ask({type:'get_pip_skills',pip_id:PIP}).call;assert.deepEqual({type:list.type,pip_id:list.pip_id},{type:'get_pip_skills',pip_id:PIP});
 const off=h.ask({type:'set_pip_skill',pip_id:PIP,skill:'deep-research',on:false}).call;assert.deepEqual({type:off.type,pip_id:off.pip_id,skill:off.skill,on:off.on},{type:'set_pip_skill',pip_id:PIP,skill:'deep-research',on:false});
 assert.equal(h.ask({type:'set_pip_skill',pip_id:PIP,skill:'stripe.refunds_2',on:true}).call.skill,'stripe.refunds_2');
 for(const skill of ['','Bad Skill!','x'.repeat(65),'-lead',7,null,undefined,'../budget']){const r=h.ask({type:'set_pip_skill',pip_id:PIP,skill,on:true});assert.equal(r.call,undefined,String(skill));assert.match(r.reply.error.message,/Choose one of the skills/);}
 for(const on of ['no',1,null,undefined]){const r=h.ask({type:'set_pip_skill',pip_id:PIP,skill:'budget',on});assert.equal(r.call,undefined,String(on));assert.match(r.reply.error.message,/on or off/);}
 const folder=h.ask({type:'set_pip_profile',pip_id:PIP,changes:{group:'Launch'}}).call;assert.deepEqual(folder.changes,{group:'Launch'});
 assert.deepEqual(h.ask({type:'set_pip_profile',pip_id:PIP,changes:{group:''}}).call.changes,{group:''},'no folder');
 assert.deepEqual(h.ask({type:'set_pip_profile',pip_id:PIP,changes:{title:'Chief of staff'}}).call.changes,{title:'Chief of staff'},'the page’s other changes go as before');
 for(const group of ['x'.repeat(41),'two\nlines',7,null]){const r=h.ask({type:'set_pip_profile',pip_id:PIP,changes:{group}});assert.equal(r.call,undefined,String(group));assert.match(r.reply.error.message,/one line of up to 40 characters/);}
 const old=host(87);
 for(const [request,says] of [[{type:'get_pip_skills',pip_id:PIP},/^Update DGC to choose the skills a Pip can use\./],[{type:'set_pip_skill',pip_id:PIP,skill:'budget',on:false},/^Update DGC to choose the skills/],
  [{type:'set_pip_profile',pip_id:PIP,changes:{group:'Launch'}},/^Update DGC to put Pips in folders\./],[{type:'export_pip_team_file',pip_ids:[PIP],name:'Launch'},/^Update DGC to share a team of Pips\./],[{type:'import_pip_team_file'},/^Update DGC to share a team of Pips\./]]){
  const r=old.ask(request);assert.equal(r.call,undefined,request.type);assert.match(r.reply.error.message,says);}
 assert.equal(old.ask({type:'set_pip_profile',pip_id:PIP,changes:{title:'Chief of staff'}}).call.type,'set_pip_profile','an older DGC still takes a title');
 // The page never sends DGC's own team commands (a file's text, or a document): only the host does, from a file it read.
 for(const request of [{type:'export_pip_team',pip_ids:[PIP],name:'x'},{type:'import_pip_team',document:'{}'}]){const r=h.ask(request);assert.equal(r.call,undefined,request.type);assert.equal(r.reply.ok,false);}
 // A Pip's computer tab asks for none of them.
 h.editor.receive({type:'pipsOpenComputer',pip:{id:PIP,name:'Mornings',pip_type:'lens'}});
 const tab=h.panels.at(-1);assert.ok(tab,'its computer tab opened');
 for(const request of [{type:'get_pip_skills',pip_id:PIP},{type:'set_pip_skill',pip_id:PIP,skill:'budget',on:false},{type:'export_pip_team_file',pip_ids:[PIP],name:'x'},{type:'import_pip_team_file'}]){
  const r=h.ask(request,tab);assert.equal(r.call,undefined,request.type);assert.equal(r.reply.ok,false);}
});

const TEAM={format:'dgc-team',version:1,name:'Launch crew',pips:[{format:'dgc-pip',version:1,pip:{name:'Researcher'},left_out:['Memory, history, findings and results stay with the original Pip.']},
 {format:'dgc-pip',version:1,pip:{name:'Writer'},left_out:['Memory, history, findings and results stay with the original Pip.','Reads from connected apps: they name your accounts.']}]};
// His rule (18 Nov): the save dialog stays only where the place is the project. A team file is a copy for the person: the
// page that asked downloads it on their own computer (media/shared/download.js, src/download.ts).
test('Export team: the host asks DGC for the file and hands it to the page as a download under the team’s name; no save dialog, nothing written here',async()=>{
 const calls=[];
 const h=host(88,{window:{showSaveDialog:async o=>{calls.push(['dialog',o]);return {path:'/home/u/x.json'};}},workspace:{fs:{writeFile:async(uri,bytes)=>{calls.push(['write',uri.path,Buffer.from(bytes).toString('utf8')]);}}}});
 const a=h.ask({type:'export_pip_team_file',pip_ids:[pid('1'),pid('2')],name:'Launch crew'});
 assert.deepEqual({type:a.call.type,pip_ids:a.call.pip_ids,name:a.call.name},{type:'export_pip_team',pip_ids:[pid('1'),pid('2')],name:'Launch crew'});
 assert.equal(a.reply,undefined,'nothing is answered until the file is saved');
 const text=JSON.stringify(TEAM,null,2)+'\n';
 h.editor.event({type:'pips_result',request_id:a.call.request_id,command:'export_pip_team',ok:true,result:{document:TEAM,text}});await flush();await flush();
 const handed=h.main.filter(m=>m.type==='dgcDownload');
 assert.deepEqual(handed.map(m=>[m.name,m.mime,Buffer.from(m.data).toString('utf8')]),[['launch-crew.dgc-team.json','application/json',text]],'what DGC exported is what the page saves');
 assert.deepEqual(calls,[],'no save dialog, nothing written on the machine DGC runs on');
 const reply=JSON.parse(JSON.stringify(h.reply(a.id)));
 assert.deepEqual(reply,{type:'pipsReply',id:a.id,ok:true,result:{saved:true,file:'launch-crew.dgc-team.json',name:'Launch crew',count:2,
  left_out:['Memory, history, findings and results stay with the original Pip.','Reads from connected apps: they name your accounts.']}});
 assert.doesNotMatch(JSON.stringify(reply),/\/home\/u/,'the page never hears where the file is');
 // A refusal from DGC reaches the page as its words.
 const c=h.ask({type:'export_pip_team_file',pip_ids:[pid('1')],name:'x'});
 h.editor.event({type:'pips_result',request_id:c.call.request_id,command:'export_pip_team',ok:false,error:{message:'Patch Pips cannot be shared yet: their reviewed edits belong to one project.'}});await flush();
 assert.match(h.reply(c.id).error.message,/Patch Pips cannot be shared yet/);
 // What is not a team file is never handed over; more than 256 KiB neither.
 for(const result of [{document:{...TEAM,format:'dgc-pip'},text},{document:TEAM,text:''},{document:{...TEAM,pips:[]},text},{document:TEAM,text:'x'.repeat(256*1024+1)}]){
  const d=h.ask({type:'export_pip_team_file',pip_ids:[pid('1')],name:'x'});
  h.editor.event({type:'pips_result',request_id:d.call.request_id,command:'export_pip_team',ok:true,result});await flush();await flush();
  assert.match(h.reply(d.id).error.message,/The team file is invalid/);}
 assert.equal(h.main.filter(m=>m.type==='dgcDownload').length,1);assert.deepEqual(calls,[]);
 // The request itself: 1 to 20 different Pips, a name of one line, nothing else (never a path).
 for(const bad of [{pip_ids:[]},{pip_ids:[pid('1'),pid('1')]},{pip_ids:Array.from({length:21},(_,i)=>'pip_'+i)},{pip_ids:['../x']},{pip_ids:pid('1')},{pip_ids:[pid('1')],path:'/tmp/x.json'}]){
  const r=h.ask({type:'export_pip_team_file',name:'x',...bad});assert.equal(r.call,undefined,JSON.stringify(bad).slice(0,60));assert.match(r.reply.error.message,/Choose 1 to 20 Pips/);}
 for(const name of ['x'.repeat(81),'two\nlines',7,undefined]){const r=h.ask({type:'export_pip_team_file',pip_ids:[pid('1')],name});assert.equal(r.call,undefined);assert.match(r.reply.error.message,/one line of up to 80 characters/);}
 assert.equal(viewModule.teamFileName('Launch crew'),'launch-crew.dgc-team.json');assert.equal(viewModule.teamFileName('../../etc/passwd'),'etc-passwd.dgc-team.json');
 assert.equal(viewModule.teamFileName(''),'my-team.dgc-team.json');assert.equal(viewModule.teamFileName('日本'),'my-team.dgc-team.json');
});

test('Import team: the host reads the picked file (256 KiB at most) and sends its text; the page gets DGC’s cards',async()=>{
 const text=JSON.stringify(TEAM);let picked=[{path:'/home/u/launch.dgc-team.json'}],bytes=new TextEncoder().encode(text);const dialogs=[];
 const h=host(88,{window:{showOpenDialog:async o=>{dialogs.push(o);return picked;}},workspace:{fs:{readFile:async()=>bytes}}});
 const before=h.sent.length,a=h.ask({type:'import_pip_team_file'});await flush();await flush();
 assert.deepEqual([dialogs[0].canSelectMany,dialogs[0].openLabel,dialogs[0].filters],[false,'Import team',{'DGC team':['json']}]);
 const call=h.sent.slice(before).find(m=>m.type==='pips_control').request;
 assert.deepEqual({type:call.type,document:call.document},{type:'import_pip_team',document:text});
 const result={setups:[{id:'setup_'+'1'.repeat(32)},{id:'setup_'+'2'.repeat(32)}],name:'Launch crew',left_out:[]};
 h.editor.event({type:'pips_result',request_id:call.request_id,command:'import_pip_team',ok:true,result});
 assert.deepEqual(JSON.parse(JSON.stringify(h.reply(a.id))),{type:'pipsReply',id:a.id,ok:true,result});
 picked=undefined;const b=h.ask({type:'import_pip_team_file'});await flush();await flush();
 assert.deepEqual(JSON.parse(JSON.stringify(h.reply(b.id).result)),{cancelled:true},'closing the dialog sends nothing');
 picked=[{path:'/big.json'}];bytes=new Uint8Array(256*1024+1);const sentBefore=h.sent.length,c=h.ask({type:'import_pip_team_file'});await flush();await flush();
 assert.equal(h.sent.length,sentBefore);assert.match(h.reply(c.id).error.message,/at most 256 KiB/);
 const d=h.ask({type:'import_pip_team_file',path:'/home/u/launch.dgc-team.json'});assert.equal(d.call,undefined);assert.match(d.reply.error.message,/Choose a team file to import/,'the page names no file');
});

// The page itself (jsdom): the list in folders, the folder menu, the Skills switches and the two team flows.
const types=['core','scout','lens','patch','rook','pulse','lock','quill'].map((id,character_index)=>({id,character_index,name:id[0].toUpperCase()+id.slice(1),role:id,description:'Reads and reports',available:id!=='core',unavailable_reason:id==='core'?'Core is the main chat.':null,default_name:id,default_goal:'Review',engine:id==='core'?null:id==='patch'?'patch':id==='pulse'?'test':id==='quill'?'documentation_draft':'source_audit'}));
const controls={version:1,mode:'read_only',options:{context_size:8192,thinking:'off'},options_source:'last_message',inherited_context_size:1048576,effective_context_size:8192,context_min:2048,context_max:32768,thinking_levels:['off','low','medium','high','xhigh'],reasoning_control:'provider_dependent',reasoning_note:'n',context_note:'n'};
const setupCard=(c,name)=>({id:'setup_'+c.repeat(32),digest:'a'.repeat(64),workspace_id:PW,project_root:'/home/me',pip_id:null,name,goal:'Do the '+name+' job.',pip_type:'lens',work_kind:'personal_task',source_ref:'HEAD',schedule:null,run_now:false,next_run_at:null,
 status:'pending',created_at:new Date().toISOString(),expires_at:'2099-10-02T06:00:00Z',receipt:null,reason:'Imported from a shared Pip file.',expected_version:null,expected_lifecycle_revision:null,permissions:'read_only',source_policy:'personal',
 runner_notice:'A schedule runs only while Pips are running.',scope_notice:'It works across your projects.',run_now_policy:null});
function page({api=88,list,skillsList=SKILLS}={}){
 const w=new JSDOM(viewModule.pipsDocument(),{runScripts:'outside-only',pretendToBeVisual:true}).window;windows.push(w);
 const sent=[],answered=new Set(),state={list:list||[job('1','Core',{pip_type:'core'}),inFolder('2','Writer','Launch',{pip_type:'quill'}),job('a','Mornings',{pip_type:'lens'}),inFolder('4','Bills','Home'),inFolder('5','Researcher','Launch',{pip_type:'lens'})],
  skills:skillsList.map(s=>({...s})),setups:[],refuse:''};
 w.HTMLCanvasElement.prototype.getContext=()=>null;w.TextEncoder=TextEncoder;
 w.acquireVsCodeApi=()=>({postMessage:m=>sent.push(m),getState:()=>undefined,setState:()=>{}});
 w.eval(client);
 const message=data=>w.dispatchEvent(new w.MessageEvent('message',{data}));
 const answer=(m,result,ok=true)=>{answered.add(m.id);message({type:'pipsReply',id:m.id,ok,...(ok?{result}:{error:{message:result}})});};
 const requests=type=>sent.filter(m=>m.type==='pipsRequest'&&m.request.type===type);
 const runner={runner_id:'runner',status:'running',online:true,paused:false,counts:{queued:0,running:0,cancelling:0}};
 const row=r=>state.list.find(p=>p.id===r.pip_id);
 const defaults=r=>({list_workspaces:()=>({workspaces:[{id:PW,name:'Personal',kind:'personal'}],current_workspace_id:PW}),list_pip_types:()=>({types}),list_pip_setups:()=>({setups:state.setups}),
  list_pips:()=>({pips:state.list}),get_pip:()=>({pip:row(r)}),list_pip_runs:()=>({runs:[]}),list_pip_starters:()=>({starters:[]}),get_pip_runner:()=>({runner}),
  get_workspace_context:()=>({context:{workspace_id:PW,revision:0,entries:[]}}),list_pip_models:()=>({default_model:'m',models:[],connection:'configured'}),
  list_pip_messages:()=>({pip_id:r.pip_id,workspace_id:PW,messages:[],next_before_id:null,active_run:null,history_context_omitted_count:0,chat_controls:controls}),
  get_pip_computer:()=>({computer:{pip_id:r.pip_id,granted:false,available:true,reason:'',pending:0,actions:[]}}),
  list_pip_app_links:()=>({pip_id:r.pip_id,links:[],composio:true}),list_pip_message_drafts:()=>({drafts:[],next_cursor:null}),list_pip_calendar_drafts:()=>({drafts:[],next_cursor:null}),list_pip_connector_drafts:()=>({drafts:[],next_cursor:null}),get_pip_digest:()=>undefined,
  list_pip_routines:()=>({pip_id:r.pip_id,workspace_id:PW,routines:[]}),get_pip_apps:()=>({pip_id:r.pip_id,apps:[]}),
  get_pip_skills:()=>({pip_id:r.pip_id,skills:state.skills})}[r.type]?.());
 async function drain(){for(let n=0;n<15;n++){await flush();for(const m of sent.filter(m=>m.type==='pipsRequest'&&!answered.has(m.id))){const result=defaults(m.request);if(result!==undefined)answer(m,result);}}}
 message({type:'pipsConnection',apiVersion:api,generation:1,connected:true,supported:true,enabled:true});
 const d=w.document,click=s=>{const el=typeof s==='string'?d.querySelector(s):s;assert.ok(el,'Missing '+s);el.click();};
 const type=(s,value)=>{const el=d.querySelector(s);assert.ok(el,'Missing '+s);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));el.dispatchEvent(new w.Event('change',{bubbles:true}));};
 const tick=(s,on)=>{const el=d.querySelector(s);assert.ok(el,'Missing '+s);el.checked=on;el.dispatchEvent(new w.Event('change',{bubbles:true}));};
 const submit=s=>d.querySelector(s).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
 const shown=()=>({loose:[...d.querySelectorAll('.simple-home > .pip-rows .pip-row-name')].map(n=>n.textContent),
  folders:[...d.querySelectorAll('.pip-folder')].map(f=>[f.querySelector('.pip-folder-name').textContent,f.querySelector('.pip-folder-count').textContent,f.querySelector('button').getAttribute('aria-expanded'),[...f.querySelectorAll('.pip-row-name')].map(n=>n.textContent)])});
 return {w,d,sent,answer,requests,drain,click,type,tick,submit,state,shown};
}
async function openPage(x,id=pid('a')){await x.drain();x.click(`[data-job="${id}"]`);await x.drain();x.click('[data-tab="job"]');await x.drain();}

test('the Personal list: Pips with no folder first under no heading, then each folder with its count; a heading folds its folder',async()=>{
 const x=page();await x.drain();
 assert.deepEqual(x.shown(),{loose:['Core','Mornings'],folders:[['Home','1','true',['Bills']],['Launch','2','true',['Writer','Researcher']]]});
 assert.equal(x.d.querySelectorAll('[data-job]').length,5,'every Pip is there once');
 x.click('[data-pip-folder-toggle="Launch"]');
 assert.deepEqual(x.shown().folders,[['Home','1','true',['Bills']],['Launch','2','false',[]]],'folded: its count stays, its Pips are put away');
 assert.equal(x.d.activeElement?.dataset.pipFolderToggle,'Launch','the heading keeps the keyboard');
 x.click('[data-pip-folder-toggle="Launch"]');assert.deepEqual(x.shown().folders[1],['Launch','2','true',['Writer','Researcher']]);
 // With no folders in use the list is the one list it was.
 const plain=page({list:[job('1','Core',{pip_type:'core'}),job('a','Mornings')]});await plain.drain();
 assert.deepEqual(plain.shown(),{loose:['Core','Mornings'],folders:[]});assert.equal(plain.d.querySelector('.pip-folders'),null);
 // An older DGC lists no folders and has no Teams menu, whatever a profile says.
 const old=page({api:87});await old.drain();
 assert.deepEqual(old.shown(),{loose:['Core','Writer','Mornings','Bills','Researcher'],folders:[]});assert.equal(old.d.querySelector('.team-menu'),null);
});

test('a Pip’s page sets its folder: pick one in use, No folder, or New folder… with a name; DGC is told and the list follows',async()=>{
 const x=page();await openPage(x);
 const btn=()=>x.d.querySelector('[data-pip-folder-open]');assert.equal(btn().textContent,'No folder');
 x.click(btn());
 assert.deepEqual([...x.d.querySelectorAll('.pip-folder-menu .dgc-menu-row')].map(r=>[r.textContent,r.getAttribute('aria-checked')]),[['No folder','true'],['Home','false'],['Launch','false'],['New folder…',null]]);
 x.click('[data-pip-folder-pick="Launch"]');
 const first=x.requests('set_pip_profile')[0];assert.deepEqual(JSON.parse(JSON.stringify(first.request)),{type:'set_pip_profile',pip_id:pid('a'),changes:{group:'Launch'}});
 x.state.list[2].profile={...x.state.list[2].profile,group:'Launch'};x.answer(first,{pip_id:pid('a'),profile:x.state.list[2].profile});await x.drain();
 assert.equal(btn().textContent,'Launch');assert.equal(x.d.querySelector('.pip-folder-menu'),null,'the menu closed');
 assert.match(x.d.body.textContent,/Mornings is in the folder “Launch”\./);
 // New folder…: a box for its name; an empty name is refused here, a good one is sent tidied.
 x.click(btn());x.click('[data-pip-folder-new]');assert.equal(x.d.querySelector('.pip-folder-menu'),null);assert.ok(x.d.querySelector('#pipFolderName'));
 x.submit('#pip-folder-form');assert.equal(x.d.querySelector('.pip-folder-set [role=alert]').textContent,'Give the folder a name.');assert.equal(x.requests('set_pip_profile').length,1);
 x.type('#pipFolderName','  Money   matters ');x.submit('#pip-folder-form');
 const second=x.requests('set_pip_profile')[1];assert.deepEqual({...second.request.changes},{group:'Money matters'});
 // DGC refuses: its words show on the row, and the box stays with what was typed.
 x.answer(second,'Only you can change a Pip’s page, on this computer.',false);await x.drain();
 assert.equal(x.d.querySelector('.pip-folder-set [role=alert]').textContent,'Only you can change a Pip’s page, on this computer.');assert.equal(x.d.querySelector('#pipFolderName').value,'  Money   matters ');assert.equal(btn().textContent,'Launch');
 x.click('[data-pip-folder-cancel]');assert.equal(x.d.querySelector('#pipFolderName'),null);
 // No folder puts it back.
 x.click(btn());x.click('[data-pip-folder-pick=""]');
 const third=x.requests('set_pip_profile')[2];assert.deepEqual({...third.request.changes},{group:''});
 x.state.list[2].profile={...x.state.list[2].profile,group:''};x.answer(third,{pip_id:pid('a'),profile:x.state.list[2].profile});await x.drain();
 assert.equal(btn().textContent,'No folder');assert.match(x.d.body.textContent,/Mornings is in no folder\./);
 // Picking where it already is asks DGC nothing.
 x.click(btn());x.click('[data-pip-folder-pick=""]');assert.equal(x.requests('set_pip_profile').length,3);
 // Below API 88 the page has no Folder row and no Skills.
 const old=page({api:87});await openPage(old);
 assert.equal(old.d.querySelector('.pip-folder-set'),null);assert.equal(old.d.querySelector('.pip-skills'),null);assert.equal(old.requests('get_pip_skills').length,0);
});

test('Skills on a Pip’s page: a switch tells DGC about that skill on that Pip; a refusal puts it back and says why',async()=>{
 const x=page();await openPage(x);
 assert.deepEqual(JSON.parse(JSON.stringify(x.requests('get_pip_skills').at(-1).request)),{type:'get_pip_skills',pip_id:pid('a')});
 const rows=()=>[...x.d.querySelectorAll('.pip-skills [data-pip-skill]')].map(r=>[r.dataset.pipSkill,r.querySelector('input').checked,r.classList.contains('is-off')]);
 assert.deepEqual(rows(),[['budget',true,false],['deep-research',false,true],['stripe.refunds',true,false]]);
 const groups=[...x.d.querySelectorAll('.pip-page-body > section')].map(s=>s.getAttribute('aria-label'));
 assert.ok(groups.indexOf('Skills')===groups.indexOf('Apps it can use')+1,'Skills sits under Apps it can use: '+groups.join(', '));
 x.tick('[data-pip-skill-switch="budget"]',false);
 const off=x.requests('set_pip_skill')[0];assert.deepEqual(JSON.parse(JSON.stringify(off.request)),{type:'set_pip_skill',pip_id:pid('a'),skill:'budget',on:false});
 assert.deepEqual(rows()[0],['budget',false,true],'it reads off at once');assert.ok(x.d.querySelector('[data-pip-skill-switch="deep-research"]').disabled,'one change at a time');
 x.answer(off,{skill:'budget',on:false});await x.drain();
 assert.deepEqual(rows()[0],['budget',false,true]);assert.match(x.d.body.textContent,/budget is off for Mornings\. Other Pips keep it\./);
 x.tick('[data-pip-skill-switch="deep-research"]',true);
 const on=x.requests('set_pip_skill')[1];assert.deepEqual([on.request.skill,on.request.on],['deep-research',true]);
 x.answer(on,'Only you can choose a Pip’s skills, on this computer.',false);await x.drain();
 assert.deepEqual(rows()[1],['deep-research',false,true],'refused: the switch goes back');
 assert.equal(x.d.querySelector('.pip-skills [role=alert]').textContent,'Only you can choose a Pip’s skills, on this computer.');
 // An answer about another skill is not taken as done.
 x.tick('[data-pip-skill-switch="stripe.refunds"]',false);x.answer(x.requests('set_pip_skill')[2],{skill:'budget',on:false});await x.drain();
 assert.deepEqual(rows()[2],['stripe.refunds',true,false]);assert.match(x.d.querySelector('.pip-skills [role=alert]').textContent,/another skill/);
});

test('Export team…: every Pip that can be shared is ticked, you name the team, and the host is asked with the Pips and the name alone',async()=>{
 const x=page({list:[job('1','Core',{pip_type:'core'}),inFolder('2','Writer','Launch',{pip_type:'quill'}),job('a','Mornings',{pip_type:'lens'}),job('4','Fixer',{pip_type:'patch'}),inFolder('5','Researcher','Launch',{pip_type:'lens'})]});await x.drain();
 assert.deepEqual([...x.d.querySelectorAll('.team-menu .tabs-menu button')].map(b=>b.textContent).slice(0,2),['Export team…','Import team…']);   // (pips-18 adds two rows after them: pip-imports.test.mjs)
 assert.equal(x.d.querySelector('.team-menu summary').getAttribute('aria-label'),'Teams');
 x.click('#team-export');
 const dialog=()=>x.d.querySelector('[role=dialog]');assert.equal(dialog().querySelector('h2').textContent,'Export team');
 const ticks=()=>[...dialog().querySelectorAll('input[data-team-pip]')].map(b=>[b.closest('label').querySelector('strong').textContent,b.checked]);
 assert.deepEqual(ticks(),[['Writer',true],['Mornings',true],['Researcher',true]],'all ticked; your Primary Pip and a Patch Pip are not offered');
 assert.equal(dialog().querySelector('#team-count').textContent,'3 Pips in this team.');assert.equal(x.d.querySelector('#review-confirm').textContent,'Export…');
 // Unticking them all stops the export, in words, without redrawing the dialog under the keyboard.
 const box=dialog().querySelector(`[data-team-pip="${pid('2')}"]`);
 for(const c of ['2','a','5'])x.tick(`[data-team-pip="${pid(c)}"]`,false);
 assert.equal(dialog().querySelector('#team-count').textContent,'Tick at least one Pip.');assert.ok(x.d.querySelector('#review-confirm').disabled);
 assert.equal(dialog().querySelector(`[data-team-pip="${pid('2')}"]`),box,'the same tick box: nothing was drawn again');
 x.tick(`[data-team-pip="${pid('5')}"]`,true);x.tick(`[data-team-pip="${pid('2')}"]`,true);
 assert.equal(dialog().querySelector('#team-count').textContent,'2 Pips in this team.');assert.equal(x.d.querySelector('#review-confirm').disabled,false);
 x.type('#teamName','Launch crew');x.click('#review-confirm');
 const request=x.requests('export_pip_team_file')[0];
 assert.deepEqual(JSON.parse(JSON.stringify(request.request)),{type:'export_pip_team_file',pip_ids:[pid('2'),pid('5')],name:'Launch crew'},'the ticked Pips in the list’s order, and the name; no path');
 assert.ok(dialog(),'the dialog waits for the file');assert.equal(dialog().querySelector('#teamName').value,'Launch crew');assert.deepEqual(ticks(),[['Writer',true],['Mornings',false],['Researcher',true]]);
 // Closing the save dialog keeps the choices; saving closes it and says what was saved and what stayed behind.
 x.answer(request,{cancelled:true});await x.drain();
 assert.ok(dialog());assert.equal(x.d.querySelector('#review-confirm').disabled,false);
 x.click('#review-confirm');
 x.answer(x.requests('export_pip_team_file')[1],{saved:true,file:'launch-crew.dgc-team.json',name:'Launch crew',count:2,left_out:['Memory, history, findings and results stay with the original Pip.']});await x.drain();
 assert.equal(dialog(),null);
 assert.match(x.d.body.textContent,/Saved the team “Launch crew” \(2 Pips\) as launch-crew\.dgc-team\.json\. Not included: Memory, history, findings and results stay with the original Pip\./);
 // DGC's refusal shows in the dialog.
 x.click('#team-export');x.click('#review-confirm');
 x.answer(x.requests('export_pip_team_file')[2],'One of these Pips’ jobs contains one of your configured credentials.',false);await x.drain();
 assert.match(dialog().querySelector('[role=alert], .error').textContent,/configured credentials/);
 assert.equal(JSON.parse(JSON.stringify(x.requests('export_pip_team_file')[2].request)).name,'','a new export starts with no name');
});

test('Import team…: the host picks and reads the file; the cards wait with the other new Pips under a line naming the team and what was left out',async()=>{
 const x=page();await x.drain();
 x.click('#team-import');
 const request=x.requests('import_pip_team_file')[0];assert.deepEqual(JSON.parse(JSON.stringify(request.request)),{type:'import_pip_team_file'},'the page names no file');
 const cards=[setupCard('1','Researcher'),setupCard('2','Writer')];x.state.setups=cards;
 x.answer(request,{setups:cards,name:'Launch crew',left_out:['Reads from connected apps: they name your accounts.']});await x.drain();
 assert.match(x.d.body.textContent,/Imported the team “Launch crew”: 2 new Pips to review\. Nothing is created until you approve each one\. Not included: Reads from connected apps: they name your accounts\./);
 const waiting=x.d.querySelector('[aria-label="Needs attention"]');assert.ok(waiting,'the cards show where new Pips wait');
 assert.match(waiting.textContent,/Create the Pip “Researcher”\?/);assert.match(waiting.textContent,/1 of 2/,'both of the team’s cards wait, one shown at a time');
 assert.equal(x.requests('accept_pip_setup').length,0,'nothing is approved by importing');
 // Closing the open dialog changes nothing; a file DGC can't read says so in DGC's words.
 const before=x.d.querySelector('.notice')?.textContent;x.click('#team-import');x.answer(x.requests('import_pip_team_file')[1],{cancelled:true});await x.drain();
 assert.equal(x.d.querySelector('.notice')?.textContent,before);
 x.click('#team-import');x.answer(x.requests('import_pip_team_file')[2],'This is not a team file DGC can read (format dgc-team, version 1).',false);await x.drain();
 assert.match(x.d.body.textContent,/This is not a team file DGC can read/);
 assert.equal(x.d.querySelector('#team-import').disabled,false,'and you can try another file');
});

// pips-09, the editor half: "Apps it can use" on a Pip's page (Pips API 88). What DGC answers is read strictly
// (get_pip_apps, set_pip_app), the section's rows say what each app is and whether it is on, an address has Disconnect
// (it asks first) and a linked app that is on offers "Add another address". The host's allow-list takes the three
// commands from the Pips page only, at API 88, with an app named as DGC names it. The page itself, in real Chromium:
// pip-apps-use-browser.test.mjs. The Allow card with several addresses: pip-app-links.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const load=async(file,options={})=>{const code=(await build({entryPoints:[src+file],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode'],loader:{'.css':'empty'},...options})).outputFiles[0].text;
 return stub=>{const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,name=>name==='vscode'?stub||{}:require(name));return m.exports;};};
const {pipAppsPage,pipAppSwitched,pipAppsMarkup}=(await load('pipApps.js'))();
const {allowCardMarkup,calendarCardMarkup,appLinkMarkup,appLinksPage}=(await load('pipAppLinks.js'))();
const viewModule=await load('pipsView.ts');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const {JSDOM}=require('jsdom');
const dom=html=>new JSDOM(`<body>${html}</body>`).window.document;

const PIP='pip_'+'a'.repeat(32),W='ws_'+'e'.repeat(32);
// As dgc/pip_app_switches.py's listing answers (tests/test_pip_app_switches.py).
const APPS=[{id:'airtable',name:'Airtable',kind:'plugin',on:true},{id:'stripe',name:'Stripe',kind:'plugin',on:false},
 {id:'gmail',name:'Gmail',kind:'app',on:true,accounts:['pitch@example.com','dev@example.com']},{id:'slack',name:'Slack',kind:'app',on:false}];
const link=(c,toolkit,label,account,extra={})=>({id:'applink_'+c.repeat(32),pip_id:PIP,workspace_id:W,toolkit,app:toolkit==='gmail'?'Gmail':'Google Calendar',reason:'To read your mail.',status:'connected',label,error:null,
 created_at:'2026-11-01T09:00:00Z',updated_at:'2026-11-01T09:00:00Z',server:'composio',account,...extra});
const LINKS=[link('1','gmail','pitch@example.com','ca_pitch'),link('2','gmail','dev@example.com','ca_dev')];

test('get_pip_apps is read strictly: each app’s id, name, kind and switch, and its addresses',()=>{
 const apps=pipAppsPage({pip_id:PIP,apps:APPS},PIP);
 assert.deepEqual(apps.map(a=>[a.id,a.kind,a.on,a.accounts]),[['airtable','plugin',true,[]],['stripe','plugin',false,[]],['gmail','app',true,['pitch@example.com','dev@example.com']],['slack','app',false,[]]]);
 assert.deepEqual(pipAppsPage({pip_id:PIP,apps:[]},PIP),[]);
 for(const bad of [null,{pip_id:'pip_'+'b'.repeat(32),apps:[]},{pip_id:PIP},{pip_id:PIP,apps:[{...APPS[0],id:'Air Table'}]},{pip_id:PIP,apps:[{...APPS[0],name:''}]},{pip_id:PIP,apps:[{...APPS[0],kind:'server'}]},
  {pip_id:PIP,apps:[{...APPS[0],on:'yes'}]},{pip_id:PIP,apps:[{...APPS[2],accounts:['x'.repeat(161)]}]},{pip_id:PIP,apps:[{...APPS[2],accounts:'pitch@example.com'}]},{pip_id:PIP,apps:[APPS[0],APPS[0]]},
  {pip_id:PIP,apps:Array.from({length:201},(_,i)=>({...APPS[0],id:'app'+i}))}])
  assert.throws(()=>pipAppsPage(bad,PIP),/didn’t load/,JSON.stringify(bad)?.slice(0,80));
 assert.equal(pipAppSwitched({app:'gmail',on:false},'gmail',false),false);
 assert.throws(()=>pipAppSwitched({app:'slack',on:false},'gmail',false),/another app/);
 assert.throws(()=>pipAppSwitched({app:'gmail',on:true},'gmail',false),/another app/);
 // A Pip's cards: as many as DGC lists (every account of each app, and its open cards).
 const many=Array.from({length:24},(_,i)=>link(i.toString(16).padStart(2,'0').slice(-1)+'',i%2?'gmail':'googlecalendar','a'+i+'@example.com','ca_acct'+i,{id:'applink_'+i.toString(16).padStart(32,'0')}));
 assert.equal(appLinksPage({pip_id:PIP,links:many,composio:true},PIP).links.length,24);
});

test('the section: one row an app with what it is and a switch; off reads muted; addresses with Disconnect; Add another address on a linked app that is on',()=>{
 const d=dom(pipAppsMarkup(pipAppsPage({pip_id:PIP,apps:APPS},PIP),{esc,links:LINKS,pipName:'Mornings'}));
 const section=d.querySelector('section.pip-apps');assert.equal(section.getAttribute('aria-label'),'Apps it can use');
 assert.match(section.querySelector('.pip-page-label').textContent,/^Apps it can use/);
 const rows=[...d.querySelectorAll('[data-pip-app]')];
 assert.deepEqual(rows.map(r=>[r.dataset.pipApp,r.querySelector('strong').textContent,r.querySelector('small').textContent,r.classList.contains('is-off')]),[
  ['airtable','Airtable','A plugin from Settings',false],['stripe','Stripe','A plugin from Settings · Off for Mornings',true],
  ['gmail','Gmail','An app through Composio · 2 addresses',false],['slack','Slack','An app through Composio · Off for Mornings',true]]);
 for(const r of rows){const box=r.querySelector('input[role=switch]');assert.equal(box.dataset.pipAppSwitch,r.dataset.pipApp);assert.equal(box.checked,r.dataset.on==='true');
  assert.equal(box.getAttribute('aria-label'),`${r.querySelector('strong').textContent} for Mornings`);assert.ok(box.closest('label.switch'),'the switch the page already uses');}
 const gmail=rows[2],addresses=[...gmail.querySelectorAll('.pip-app-address')];
 assert.deepEqual(addresses.map(a=>[a.querySelector('.row-words').textContent,a.querySelector('button').textContent,a.querySelector('button').dataset.pipAppAskDisconnect]),
  [['pitch@example.com','Disconnect',LINKS[0].id],['dev@example.com','Disconnect',LINKS[1].id]]);
 assert.equal(gmail.querySelector('[data-pip-app-disconnect]'),null,'Disconnect asks first: nothing disconnects in one click');
 assert.equal(gmail.querySelector('[data-pip-app-add="gmail"]').textContent,'Add another address');
 assert.deepEqual([...d.querySelectorAll('[data-pip-app-add]')].map(b=>b.dataset.pipAppAdd),['gmail'],'only an app it is linked to');
 assert.doesNotMatch(section.textContent,/\bAI\b/);
});

test('Disconnect asks on its own row, a switched-off app keeps its addresses and offers no new one, and a waiting card is said',()=>{
 const apps=pipAppsPage({pip_id:PIP,apps:[{...APPS[2],on:false}]},PIP);
 const asking=dom(pipAppsMarkup(apps,{esc,links:LINKS,pipName:'Mornings',confirm:LINKS[1].id}));
 const rows=[...asking.querySelectorAll('.pip-app-address')];
 assert.equal(rows[0].querySelector('[data-pip-app-disconnect]'),null);
 assert.deepEqual([...rows[1].querySelectorAll('button')].map(b=>[b.textContent,Object.keys(b.dataset)[0]]),[['Disconnect','pipAppDisconnect'],['Keep it','pipAppKeep']]);
 assert.equal(rows[1].querySelector('[data-pip-app-disconnect]').dataset.pipAppDisconnect,LINKS[1].id);
 assert.match(rows[1].textContent,/Mornings stops using it.*stays signed in under Settings → Plugins/);
 assert.equal(asking.querySelector('[data-pip-app-add]'),null,'off: no new address (DGC refuses one for an app that is off)');
 assert.equal(asking.querySelectorAll('.pip-app.is-off .pip-app-address').length,2,'its link stays when off');
 const on=pipAppsPage({pip_id:PIP,apps:[APPS[2]]},PIP);
 const waiting=dom(pipAppsMarkup(on,{esc,links:LINKS,pipName:'Mornings',waiting:['gmail']}));
 assert.match(waiting.querySelector('.pip-app-more').textContent,/A card for one more Gmail address is waiting in its chat\.Show the card/);
 // Before its links are read, its addresses are named and nothing can be disconnected by a name alone.
 const bare=dom(pipAppsMarkup(on,{esc,links:[],pipName:'Mornings'}));
 assert.deepEqual([...bare.querySelectorAll('.pip-app-address')].map(a=>a.textContent),['pitch@example.com','dev@example.com']);
 assert.equal(bare.querySelector('.pip-app-address button'),null);
 // Loading, none, an error, and everything waits while something saves.
 assert.match(dom(pipAppsMarkup(null,{esc})).querySelector('[role=status]').textContent,/Loading/);
 assert.match(dom(pipAppsMarkup([],{esc,pipName:'Mornings'})).querySelector('.pip-page-empty').textContent,/None yet\. Turn a plugin on in Settings → Plugins, or ask Mornings in its chat to connect an app/);
 assert.match(dom(pipAppsMarkup(on,{esc,links:LINKS,error:'Only you can choose a Pip’s apps.'})).querySelector('[role=alert]').textContent,/Only you/);
 const busy=dom(pipAppsMarkup(on,{esc,links:LINKS,busy:true}));
 assert.ok([...busy.querySelectorAll('button:not(.pip-tip-btn),input')].every(c=>c.disabled));
 // An address is text, whatever it holds.
 const odd=dom(pipAppsMarkup(on,{esc,links:[link('1','gmail','<img src=x onerror=alert(1)>','ca_pitch')]}));
 assert.equal(odd.querySelector('img'),null);assert.match(odd.querySelector('.pip-app-address').textContent,/<img/);
});

test('the Allow cards’ markup: one address reads as before; two or more ask, with nothing picked and Send waiting',()=>{
 const source={run_id:'run_'+'5'.repeat(32),pip_id:PIP,workspace_id:W,job_version:1,lifecycle_revision:0,result_digest:'e'.repeat(64)};
 const mail={id:'maildraft_'+'3'.repeat(32),payload:{schema_version:1,source,message:{recipient_email:'friend@example.test',subject:'A short note',body:'Lunch?'}}};
 const event={id:'caldraft_'+'4'.repeat(32),payload:{schema_version:1,source,event:{summary:'Coffee',description:'',start_datetime:'2026-12-01T11:00:00+05:30',end_datetime:'2026-12-01T11:30:00+05:30',timezone:'Asia/Kolkata'}}};
 const one=dom(allowCardMarkup(mail,{esc,link:LINKS[0],links:[LINKS[0]],pipName:'Mornings'}));
 assert.match(one.body.textContent,/From pitch@example\.com/);assert.equal(one.querySelector('[data-allow-from]'),null);assert.equal(one.querySelector('[data-allow-send]').disabled,false);
 const asks=dom(allowCardMarkup(mail,{esc,link:null,links:LINKS,pipName:'Mornings'}));
 assert.match(asks.body.textContent,/Mornings has 2 Gmail addresses\. Choose which one sends this\./);
 assert.equal(asks.querySelector('.allow-from-label').textContent,'From');assert.equal(asks.querySelector('[data-allow-from]').textContent,'Choose an address');
 assert.ok(asks.querySelector('[data-allow-send]').disabled&&asks.querySelector('[data-allow-always]').disabled);
 assert.match(asks.querySelector('[data-allow-send]').title,/Choose which address/);
 assert.equal(asks.querySelector('[data-card-edit-start]').disabled,false);assert.equal(asks.querySelector('[data-allow-dismiss]').disabled,false);
 const open=dom(allowCardMarkup(mail,{esc,link:LINKS[1],links:LINKS,fromOpen:true,pipName:'Mornings'}));
 const menu=open.querySelector('.dgc-menu.allow-from-menu[role=menu]');assert.equal(menu.getAttribute('aria-label'),'Send from');
 assert.deepEqual([...menu.querySelectorAll('.dgc-menu-row')].map(r=>[r.dataset.allowFromPick,r.dataset.allowFromFor,r.getAttribute('aria-checked'),r.textContent]),
  [['ca_pitch',mail.id,'false','pitch@example.com'],['ca_dev',mail.id,'true','dev@example.com']]);
 assert.equal(open.querySelector('[data-allow-from]').textContent,'dev@example.com');assert.equal(open.querySelector('[data-allow-send]').disabled,false);
 const cal=dom(calendarCardMarkup(event,{esc,link:null,links:LINKS.map(l=>({...l,toolkit:'googlecalendar'})),pipName:'Mornings'}));
 assert.equal(cal.querySelector('.allow-from-label').textContent,'To');assert.equal(cal.querySelector('[data-allow-from]').textContent,'Choose a calendar');
 assert.ok(cal.querySelector('[data-allow-create]').disabled&&cal.querySelector('[data-allow-create-always]').disabled);
 // A card for one more address says so.
 const more=dom(appLinkMarkup({...link('9','gmail',null,undefined,{status:'requested',reason:'One more Gmail address for this Pip.'}),another:true},{esc,pipName:'Mornings'}));
 assert.match(more.body.textContent,/Add another Gmail address to Mornings.*One more Gmail address for this Pip\./);
 assert.deepEqual([...more.querySelectorAll('button')].map(b=>b.textContent),['Choose one','Not now']);
});

// The host: what the Pips page may ask DGC (src/pipsView.ts).
function host(api=88){
 const panels=[];
 const vscode={ViewColumn:{Active:-1,Beside:-2},Uri:{joinPath:(...p)=>({path:p.map(x=>x.path||x).join('/')}),file:p=>({path:p})},workspace:{workspaceFolders:[],fs:{}},
  window:{createWebviewPanel:(id,title)=>{const p={id,title,posted:[],receive:null,webview:{cspSource:'csp',asWebviewUri:u=>u,postMessage:m=>{p.posted.push(m);return Promise.resolve(true);},onDidReceiveMessage:f=>{p.receive=f;}},
   reveal(){},onDidDispose(){},onDidChangeViewState(){}};panels.push(p);return p;}}};
 const {PipsEditor}=viewModule(vscode);const main=[],sent=[];
 const editor=new PipsEditor({path:'ext'},m=>{sent.push(m);return true;},()=>{},true);editor.attach(m=>main.push(m));
 editor.ready({pips_supported:true,pips_enabled:true,pips_api_version:api},{});
 const generation=()=>main.filter(m=>m.type==='pipsConnection').at(-1).generation;let serial=0;
 const ask=(request,from=null)=>{const id='q'+(++serial),before=sent.length;(from?from.receive:m=>editor.receive(m))({type:'pipsRequest',id,generation:generation(),request});
  return {call:sent.slice(before).find(m=>m.type==='pips_control')?.request,reply:(from?from.posted:main).filter(m=>m.type==='pipsReply'&&m.id===id).at(-1)};};
 return {editor,panels,ask};
}
test('the allow-list: the three commands go from the Pips page at API 88, an app named as DGC names it, and never to an older DGC',()=>{
 const h=host();
 const list=h.ask({type:'get_pip_apps',pip_id:PIP}).call;assert.deepEqual({type:list.type,pip_id:list.pip_id},{type:'get_pip_apps',pip_id:PIP});
 const off=h.ask({type:'set_pip_app',pip_id:PIP,app:'gmail',on:false}).call;assert.deepEqual({type:off.type,pip_id:off.pip_id,app:off.app,on:off.on},{type:'set_pip_app',pip_id:PIP,app:'gmail',on:false});
 const add=h.ask({type:'add_pip_app_account',pip_id:PIP,app:'google-calendar_2'}).call;assert.equal(add.app,'google-calendar_2');
 for(const app of ['','Gmail!','x'.repeat(41),'g',7,null,undefined,'../gmail'])for(const type of ['set_pip_app','add_pip_app_account']){
  const r=h.ask({type,pip_id:PIP,app,on:true});assert.equal(r.call,undefined,`${type} ${String(app)}`);assert.match(r.reply.error.message,/Choose one of the apps/);}
 for(const on of ['no',1,null,undefined]){const r=h.ask({type:'set_pip_app',pip_id:PIP,app:'gmail',on});assert.equal(r.call,undefined,String(on));assert.match(r.reply.error.message,/on or off/);}
 const old=host(87);
 for(const request of [{type:'get_pip_apps',pip_id:PIP},{type:'set_pip_app',pip_id:PIP,app:'gmail',on:false},{type:'add_pip_app_account',pip_id:PIP,app:'gmail'}]){
  const r=old.ask(request);assert.equal(r.call,undefined,request.type);assert.match(r.reply.error.message,/^Update DGC to choose the apps a Pip can use\./);}
 // A Pip's computer tab asks for none of them.
 h.editor.receive({type:'pipsOpenComputer',pip:{id:PIP,name:'Mornings',pip_type:'lens'}});
 const tab=h.panels.at(-1);assert.ok(tab,'its computer tab opened');
 for(const request of [{type:'get_pip_apps',pip_id:PIP},{type:'set_pip_app',pip_id:PIP,app:'gmail',on:false}]){const r=h.ask(request,tab);assert.equal(r.call,undefined);assert.equal(r.reply.ok,false);}
});

// The code card (0.52, Pips API 98; agreed design: pips-sandbox-design §4): "A site asking for a code: the Pip shows a
// code card in its chat; the user types it; DGC fills it into the page (the Pip is told only that it was filled)."
// DGC holds a computer action of kind "code"; `fill_pip_code {pip_id, action_id, expected_digest, code}` types the
// user's code into that page; Not now is decide_pip_computer_action with approve false.
// Here, without a browser: the card's one list of words and answers (src/pipCareful.js), what the host lets a page send
// (src/pipsView.ts: the allow-list, the gate on 98, a computer tab's own rule), and its row in Needs attention.
// The real pages in Chromium (the card, the notification, the typed code kept nowhere): pip-code-card-browser.test.mjs.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url),src=fileURLToPath(new URL('../src/',import.meta.url));
const view=(await build({entryPoints:[src+'pipsView.ts'],bundle:true,write:false,platform:'node',format:'cjs',external:['vscode']})).outputFiles[0].text;
const host=(()=>{const out={exports:{}};new Function('module','exports','require',view)(out,out.exports,name=>name==='vscode'?{}:require(name));return out.exports;})();
const careful=await import('../src/pipCareful.js');
const attention=await import('../src/pipAttention.js');
const answers=await import('../src/pipCardAnswers.js');
const drawer=await import('../src/pipComputerDrawer.js');
const text=name=>readFileSync(src+name,'utf8');

const PIP='pip_'+'5'.repeat(32),OTHER='pip_'+'6'.repeat(32),CARD='compact_'+'a'.repeat(32),DIGEST='a'.repeat(64),CODE='482913';
const SUMMARY={method:'CODE',host:'login.northwind-bank.example',path:'/verify',page:'https://login.northwind-bank.example/verify',fields:[],more_fields:0,body_bytes:0,
 kind:'code',site:'northwind-bank.example',shown:'login.northwind-bank.example',login:'login_'+'1'.repeat(32),filled:['username','password']};
const action=(status='pending',by=null)=>({id:CARD,pip_id:PIP,workspace_id:'ws_'+'e'.repeat(32),run_id:'run_'+'b'.repeat(32),summary:SUMMARY,digest:DIGEST,frame:null,status,
 created_at:'2026-11-15T09:10:00.000Z',expires_at:'2026-11-15T09:20:00.000Z',resolved_at:status==='pending'?null:'2026-11-15T09:11:00.000Z',resolved_by:by,continuation_run_id:null});

test('the card\'s words: one line that names the site, a second that says who fills it in and that the Pip never sees it',()=>{
 assert.equal(typeof careful.codeWords,'function','src/pipCareful.js has the code card\'s words');
 const w=careful.codeWords(SUMMARY,'Banker');
 assert.equal(w.title,'login.northwind-bank.example sent you a one-time code');
 assert.equal(w.line,'Type it here and DGC fills it in for Banker; the Pip never sees it.');
 assert.equal(w.attention,'Type the code for login.northwind-bank.example');
 assert.match(w.lost,/page moved on.*Banker will ask again/);
 assert.equal(careful.isCode(SUMMARY),true);assert.equal(careful.isCode({kind:'login'}),false);
});

test('its answers are the one list both pages draw: Send (the code goes with it), then Not now; never an Allow, never Always allow',()=>{
 assert.deepEqual(careful.heldRequestAnswers(SUMMARY,'Banker'),[{how:'code',label:'Send',done:'Sent'},{how:'reject',label:'Not now',done:'Not now'}]);
 assert.equal(careful.offersAlways(SUMMARY),false);
 const w=drawer.cardWords(action(),'Banker');
 assert.deepEqual([w.kind,w.title,w.line],['code','login.northwind-bank.example sent you a one-time code','Type it here and DGC fills it in for Banker; the Pip never sees it.']);
 assert.deepEqual(w.answers.map(b=>b.label),['Send','Not now'],'the notification offers the same');
});

test('the field: text, the number keys first, the browser\'s one-time-code filling, twelve characters; letters stay allowed',()=>{
 const esc=v=>String(v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
 const html=careful.codeFieldMarkup(SUMMARY,{esc,id:'f',action:CARD,pipName:'Banker'});
 for(const want of ['type="text"','inputmode="numeric"','autocomplete="one-time-code"','maxlength="12"',`data-code-field="${CARD}"`,'spellcheck="false"'])assert.ok(html.includes(want),`${want} in ${html}`);
 assert.doesNotMatch(html,/pattern=|type="(number|tel|password)"/,'nothing stops a letter being typed');
 assert.doesNotMatch(html,/\bname=|\bvalue=|data-draft/,'no name to be saved under, no value in the markup, no draft');
 assert.ok(careful.codeFieldMarkup({...SUMMARY,letters:true},{esc,id:'f',action:CARD}).includes('inputmode="text"'),'a site whose codes have letters gets the full keyboard');
 const sending=careful.codeFieldMarkup(SUMMARY,{esc,id:'f',action:CARD,sending:true});
 assert.match(sending,/ readonly /,'read-only while it is sent');assert.doesNotMatch(sending,/\bvalue=/);
});

test('what is typed: spaces are ignored, and only what a site\'s code can be is sent',()=>{
 assert.equal(careful.cleanCode(' 482 913\t'),'482913');
 assert.equal(careful.codeProblem('482 913'),'');assert.equal(careful.codeProblem('AB-12cd'),'');assert.equal(careful.codeProblem('123456789012'),'');
 assert.equal(careful.codeProblem('   '),'Type the code first.');
 for(const bad of ['12;34','1234567890123','code!','<b>'])assert.equal(careful.codeProblem(bad),'Type the code as the site shows it: letters and numbers, up to 12.',bad);
});

test('once it is settled it leaves one quiet line: sent, put off, never typed, or its page had moved on',()=>{
 const what='One-time code for login.northwind-bank.example';
 assert.deepEqual(careful.settledWords(action('sent','editor-user')),['Sent',what]);
 assert.deepEqual(careful.settledWords(action('rejected','editor-user')),['Not now',what]);
 assert.deepEqual(careful.settledWords(action('expired','expired')),['Not answered',what]);
 assert.deepEqual(careful.settledWords(action('lost','page-moved')),['The page moved on',what]);
 assert.equal(careful.settledWords(action()),null,'nothing while it waits');
 for(const status of ['sent','rejected','expired','lost'])assert.doesNotMatch(careful.settledWords(action(status)).join(' '),/form|Allowed|Rejected/,`${status}: never a form's words`);
});

test('the host lets the Pips page send fill_pip_code, from Pips API 98 only, and only as the card, its digest and the code',()=>{
 assert.equal(typeof host.fillCodeRefusal,'function');
 const ask={type:'fill_pip_code',pip_id:PIP,action_id:CARD,expected_digest:DIGEST,code:CODE};
 assert.equal(host.fillCodeRefusal(ask,98),'');assert.equal(host.fillCodeRefusal(ask,120),'');
 assert.equal(host.fillCodeRefusal(ask,97),'Update DGC to type a site’s code for a Pip.','an older DGC has no code card');
 assert.equal(host.fillCodeRefusal({...ask,site:'evil.example'},98),'That card is not a code to type.','never a site the page names');
 assert.equal(host.fillCodeRefusal({...ask,action_id:'login_'+'1'.repeat(32)},98),'That card is not a code to type.');
 assert.equal(host.fillCodeRefusal({...ask,code:7},98),'That card is not a code to type.');
 assert.equal(host.fillCodeRefusal({type:'get_pip'},90),'','every other command is its own rule\'s');
 const source=text('pipsView.ts');
 const commands=source.split('\n').find(line=>line.startsWith('const commands = new Set('));
 assert.ok(commands.includes("'fill_pip_code'"),'it is in the Pips webview\'s allow-list');
 assert.match(source,/fillCodeRefusal\(request, ?this\.apiVersion\)/,'the host asks it of every request');
 assert.doesNotMatch(source,/console\.(log|info|debug|warn|error)\([^)]*request\b/,'no request is logged');
});

test('a computer tab may send fill_pip_code only for its own Pip, with that card\'s id and digest, and nothing else',()=>{
 const mine={type:'fill_pip_code',pip_id:PIP,action_id:CARD,expected_digest:DIGEST,code:CODE},refused='This tab only uses this Pip\'s computer.';
 assert.equal(host.computerTabRefusal(mine,PIP),'');
 assert.equal(host.computerTabRefusal({...mine,pip_id:OTHER},PIP),refused,'never another Pip\'s');
 { const {pip_id:_p,...loose}=mine;assert.equal(host.computerTabRefusal(loose,PIP),refused,'it names its Pip'); }
 { const {action_id:_a,...loose}=mine;assert.equal(host.computerTabRefusal(loose,PIP),refused,'it names the card'); }
 { const {expected_digest:_d,...loose}=mine;assert.equal(host.computerTabRefusal(loose,PIP),refused,'and the card as it was shown'); }
 assert.equal(host.computerTabRefusal({...mine,expected_digest:'short'},PIP),refused);
 assert.equal(host.computerTabRefusal({...mine,action_id:'compact_zz'},PIP),refused);
 assert.equal(host.computerTabRefusal({...mine,site:'evil.example'},PIP),refused,'never a site the page names');
 assert.equal(host.computerTabRefusal({...mine,page:'https://evil.example/'},PIP),refused);
 assert.equal(host.computerTabRefusal({...mine,number:2},PIP),refused,'nor another computer');
 for(const type of ['list_pip_logins','remove_pip_login','send_pip_message'])assert.equal(host.computerTabRefusal({type,pip_id:PIP},PIP),refused,type);
 assert.equal(host.computerTabRefusal({type:'decide_pip_computer_action',action_id:CARD,expected_digest:DIGEST,approve:false},PIP),'','Not now is the answer every card has');
});

test('Needs attention: a code card\'s row says "Type the code for <site>" and opens the Pip\'s chat at the card',async()=>{
 const item={id:`computer_action:${CARD}`,kind:'computer_action',card:CARD,pip_id:PIP,pip_name:'Banker',pip_type:'lens',workspace_id:'ws_'+'e'.repeat(32),
  title:'Send this on login.northwind-bank.example?',detail:'https://login.northwind-bank.example/verify',created_at:'2026-11-15T09:10:00.000Z',expires_at:null};
 const computer={pip_id:PIP,granted:true,available:true,reason:'',pending:1,actions:[action()]};
 const held=await answers.readVisits(async()=>({computer}),[PIP]);
 assert.deepEqual(held.get(CARD),{code:true,shown:'login.northwind-bank.example'},'read from the Pip\'s computer: DGC\'s list does not say which step is a code');
 assert.equal(typeof attention.codeRow,'function');
 const row=attention.codeRow(item,held);
 assert.equal(row.title,'Type the code for login.northwind-bank.example');
 assert.equal(row.detail,'');
 assert.deepEqual(attention.attentionNavigation(row),{pip:PIP,workspace:item.workspace_id,attention:true,section:'chat',card:CARD,cardKind:'code'},'its chat, at the card: never the computer\'s own screen');
 assert.equal(attention.cardSelector('code',CARD),`[data-code-card="${CARD}"]`);
 assert.equal(answers.answerFor(item,{id:PIP,name:'Banker',version:1},{visits:held}),null,'a code is typed, never answered from a row');
 const other={...item,card:'compact_'+'b'.repeat(32),id:'computer_action:compact_'+'b'.repeat(32)};
 assert.equal(attention.codeRow(other,held),other,'any other row is as DGC said it');
 assert.deepEqual(attention.attentionNavigation(other),{pip:PIP,workspace:item.workspace_id,attention:true,computer:true});
});

test('the typed code has nowhere to be kept: no draft, no saved view, no storage, no log names it',()=>{
 for(const name of ['pipsClient.js','pipComputerClient.js','pipComputerDrawer.js','pipCareful.js']){
  const source=text(name);
  assert.doesNotMatch(source,/draft\.code|draft\[['"]code|codeDraft|data-draft="code/,`${name}: no draft of it`);
  assert.doesNotMatch(source,/(localStorage|sessionStorage)[^\n]*code/i,`${name}: no storage of it`);
  assert.doesNotMatch(source,/console\.[a-z]+\([^\n]*\bcode\b/,`${name}: no log of it`);
 }
 const chat=text('pipsClient.js');
 const saved=chat.split('\n').find(line=>line.startsWith('function rememberView()'));
 assert.ok(saved,'the view\'s saved state is one function');assert.doesNotMatch(saved,/code/i,'and it has nothing of a code in it');
 for(const [name,source] of [['pipsClient.js',chat],['pipComputerClient.js',text('pipComputerClient.js')]]){
  const send=source.slice(source.indexOf('async function sendCode('));
  const body=send.slice(0,send.indexOf('\n}\n')+2);
  assert.ok(body.includes('takeCode('),`${name}: what was typed is taken out of its field for good`);
  assert.match(body,/broker\.request\(request,CODE_WAIT\);request\.code='';/,`${name}: the request kept while DGC answers has no code in it`);
  assert.equal((body.match(/fill_pip_code/g)||[]).length,1,`${name}: one request carries it`);
 }
});

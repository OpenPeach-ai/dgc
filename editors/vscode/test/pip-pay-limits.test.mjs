// Paying by itself, in dollars (0.52, agreed 13 Nov; pips-sandbox-design §5; Pips API 96, dgc/pip_payments.py). The old
// "Payments a day: 3" count across all Pips is retired. On a Pip's page, only while it is at Do it all and its rule is
// "Let it pay": "Allow payments up to $___ a day" (required before it pays by itself; "No limit" is a choice, never the
// default), and optionally "At most ___ payments a day" and "Only on these sites". set_pip_pay_limits answers
// {limits, spent_today}: "$12.50 used today". Pips settings has "All Pips together: up to $___ a day" (optional, empty
// by default). One quiet honest line says DGC reads each payment's amount itself.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setup as open} from './support/one-pips-node.mjs';
import {MORNINGS,GST} from './support/one-pips-scene.mjs';

const windows=[];after(()=>windows.forEach(w=>w.close()));
const setup=options=>{const x=open({api:96,...options});windows.push(x.w);return x;};
const READS='DGC reads each payment’s amount itself; one it can’t read for certain asks you.';
/** A Pip's page, opened from its chat's menu. */
async function page(x,id=MORNINGS){await x.drain();await x.openPip(id);await x.menu('job');await x.drain();}
const change=(x,el,value)=>{if(typeof value==='boolean')el.checked=value;else el.value=value;el.dispatchEvent(new x.w.Event('input',{bubbles:true,composed:true}));el.dispatchEvent(new x.w.Event('change',{bubbles:true,composed:true}));};
const submit=async(x,form='#pip-pay-form')=>{x.$(form).dispatchEvent(new x.w.Event('submit',{bubbles:true,cancelable:true,composed:true}));await x.drain();};
const last=(x,type)=>x.requests(type).at(-1);

test('at Do it all, with Let it pay: "Allow payments up to $ a day", empty until you set it, and the line that says so',async()=>{
 const x=setup({scene:{level:'full',paying:'allow'}});await page(x);
 const form=x.$('#pip-pay-form');
 assert.ok(form,'under its rule for payments');
 assert.ok(form.closest('[aria-label="How much it asks"]'),'in the section its level is in');
 assert.equal(x.squash(form.querySelector('.pay-daily').textContent).trim(),'Allow payments up to $ a day No limit');
 assert.equal(x.$('#payUsd').value,'','no limit until you set one');
 assert.equal(x.$('#payNoLimit').checked,false,'"No limit" is a choice, never the default');
 assert.equal(x.$('#pipPayStatus').textContent,'Set a daily limit to let it pay by itself');
 assert.equal(x.squash(form.querySelector('.pay-count').textContent).trim(),'At most payments a day');
 assert.equal(x.$('#payCount').value,'','no count unless you want one');
 assert.equal(x.squash(form.querySelector('.pay-sites').textContent).trim(),'Only on these sites');
 assert.equal(x.$('#paySites').value,'');assert.equal(x.$('#paySites').placeholder,'Any site');
 assert.equal(x.$('#pipPayReads').textContent,READS,'one honest quiet line');
 assert.equal(x.requests('set_pip_pay_limits').length,0,'nothing is set by looking');
 assert.doesNotMatch(x.text('.pip-page'),/times a day across your Pips|\bAI\b/,'the old count is gone');
});

test('Save sets the daily total in dollars; DGC\'s answer is what shows, with what it used today',async()=>{
 const x=setup({scene:{level:'full',paying:'allow',spent:12.5}});await page(x);
 change(x,x.$('#payUsd'),'50');await submit(x);
 assert.deepEqual(last(x,'set_pip_pay_limits'),{type:'set_pip_pay_limits',pip_id:MORNINGS,usd_per_day:50,max_count:null,sites:null});
 assert.equal(x.$('#payUsd').value,'50');
 assert.equal(x.$('#pipPayStatus').textContent,'$12.50 used today');
 assert.match(x.text(),/Mornings pays by itself up to \$50 a day\./,'said once as the notice');
 change(x,x.$('#payUsd'),'49.99');change(x,x.$('#payCount'),'50');change(x,x.$('#paySites'),'Shop.Example, https://books.example/cart  shop.example');await submit(x);
 assert.deepEqual(last(x,'set_pip_pay_limits'),{type:'set_pip_pay_limits',pip_id:MORNINGS,usd_per_day:49.99,max_count:50,sites:['shop.example','books.example']},
  'any count, and the sites by name: a pasted address is its site, and one named twice is one');
 assert.equal(x.$('#payCount').value,'50');
 assert.equal(x.$('#paySites').value,'books.example, shop.example','as DGC keeps them');
 change(x,x.$('#payCount'),'');change(x,x.$('#paySites'),'');await submit(x);
 assert.deepEqual(last(x,'set_pip_pay_limits'),{type:'set_pip_pay_limits',pip_id:MORNINGS,usd_per_day:49.99,max_count:null,sites:null},'emptied: no count, any site');
});

test('"No limit" is chosen by hand: the amount is put away, and it is said plainly',async()=>{
 const x=setup({scene:{level:'full',paying:'allow'}});await page(x);
 change(x,x.$('#payNoLimit'),true);
 assert.equal(x.$('#payUsd').disabled,true,'no amount beside No limit');
 await submit(x);
 assert.equal(last(x,'set_pip_pay_limits').usd_per_day,'no_limit');
 assert.equal(x.$('#payNoLimit').checked,true);assert.equal(x.$('#payUsd').value,'');
 assert.equal(x.$('#pipPayStatus').textContent,'No daily limit · $0.00 used today');
 assert.match(x.text(),/Mornings pays by itself with no daily limit\./);
 change(x,x.$('#payNoLimit'),false);change(x,x.$('#payUsd'),'20');await submit(x);
 assert.equal(last(x,'set_pip_pay_limits').usd_per_day,20,'and taken back with an amount');
});

test('an amount DGC would refuse is not sent, and the reason is said beside the box',async()=>{
 const x=setup({scene:{level:'full',paying:'allow'}});await page(x);
 for(const [usd,count,sites,why] of [['','','',/Set a daily limit in dollars, such as 50/],['0','','',/above \$0/],['-5','','',/above \$0/],['abc','','',/such as 50/],
  ['1000001','','',/up to \$1,000,000/],['10.999','','',/cents/],['20','0','',/whole number from 1/],['20','2.5','',/whole number from 1/],['20','','not a site!',/such as shop\.example/]]){
  change(x,x.$('#payUsd'),usd);change(x,x.$('#payCount'),count);change(x,x.$('#paySites'),sites);await submit(x);
  assert.equal(x.requests('set_pip_pay_limits').length,0,`${usd}/${count}/${sites}: not sent`);
  assert.match(x.$('#pip-pay-form [role="alert"]').textContent,why,`${usd}/${count}/${sites}`);
 }
 change(x,x.$('#payUsd'),'$1,250.50');change(x,x.$('#payCount'),'');change(x,x.$('#paySites'),'');await submit(x);
 assert.equal(last(x,'set_pip_pay_limits').usd_per_day,1250.5,'a typed $ and commas are read as the number');
 assert.equal(x.$('#pip-pay-form [role="alert"]'),null);
});

test('what DGC refuses is said in its own words, and the page keeps what was true',async()=>{
 const x=setup({scene:{level:'full',paying:'allow',limits:{usd_per_day:30}}});await page(x);
 assert.equal(x.$('#payUsd').value,'30','a limit set earlier shows, as get_pip_level says it');
 assert.equal(x.$('#pipPayStatus').textContent,'$0.00 used today');
 const answer=x.backend.answer;x.backend.answer=r=>r.type==='set_pip_pay_limits'?(x.state.requests.push(r),{error:{code:'local_only',message:'Only you set how much a Pip may pay, on this computer.'}}):answer(r);
 change(x,x.$('#payUsd'),'80');await submit(x);
 assert.match(x.$('#pip-pay-form [role="alert"]').textContent,/Only you set how much a Pip may pay, on this computer\./);
 assert.equal(x.$('#pipPayStatus').textContent,'$0.00 used today','still the $30 limit');
});

test('the limits show only while it may pay by itself: not at "Ask me each time", not below Do it all, not for a Pip DGC gives no rule',async()=>{
 const ask=setup({scene:{level:'full',paying:'ask'}});await page(ask);
 assert.ok(ask.$('#pipPaying'),'its rule');assert.equal(ask.$('#pipPaying').value,'ask');
 assert.equal(ask.$('#pip-pay-form'),null,'every payment asks: nothing to limit');
 assert.equal(ask.$('#pipPayingSays').textContent,'Every payment waits for you on a card.');
 const select=ask.$('#pipPaying');select.value='allow';select.dispatchEvent(new ask.w.Event('change',{bubbles:true,composed:true}));await ask.drain();
 assert.deepEqual(last(ask,'set_pip_paying'),{type:'set_pip_paying',pip_id:MORNINGS,rule:'allow'});
 assert.ok(ask.$('#pip-pay-form'),'Let it pay: its limits open');
 assert.equal(ask.$('#pipPayingSays').textContent,'It pays by itself within the daily limit you set here. It never types a card number.');
 assert.match(ask.text(),/Mornings pays by itself once you set a daily limit\./,'and the notice says what is still needed');
 const low=setup({scene:{level:'approve',paying:'allow'}});await page(low);
 assert.equal(low.$('#pipPaying'),null);assert.equal(low.$('#pip-pay-form'),null);
 const folder=setup({scene:{level:'full',paying:'allow'}});await page(folder,GST);
 assert.ok(folder.$('#pipLevel'),'its level');
 assert.equal(folder.$('#pip-pay-form'),null,'DGC sends a Pip with a folder no rule for payments yet');
});

test('a DGC that doesn\'t say a Pip\'s limits: the page says it can\'t show one set earlier, and shows what Save answers',async()=>{
 const x=setup({scene:{level:'full',paying:'allow',limits:false}});await page(x);
 assert.equal(x.$('#payUsd').value,'');
 assert.equal(x.$('#pipPayStatus').textContent,'A limit set earlier can’t be shown yet. Setting one here replaces it.','never "none set" when it can\'t know');
 change(x,x.$('#payUsd'),'15');await submit(x);
 assert.equal(x.$('#payUsd').value,'15');assert.equal(x.$('#pipPayStatus').textContent,'$0.00 used today');
});

test('Pips settings: "All Pips together: up to $ a day", optional and empty by default; the old count is gone from Controls',async()=>{
 const x=setup({scene:{total:{spent_today:7}}});await x.drain();
 assert.equal(x.$('#pips-pay-limit'),null,'no "Payments a day" count');
 assert.doesNotMatch(x.text(),/Payments a day/);
 x.$('#pips-settings-open').click();await x.drain();
 [...x.$$('[data-pips-settings]')].find(b=>b.dataset.pipsSettings==='apps').click();await x.drain();
 const form=x.$('#pips-pay-total-form');
 assert.ok(form,'in Pips settings');
 assert.equal(x.squash(form.querySelector('.row-words strong').textContent),'All Pips together');
 assert.equal(x.squash(form.querySelector('.pay-line').textContent).trim(),'up to $ a day','read as one line: All Pips together, up to $ a day');
 assert.equal(x.$('#payTotal').value,'','empty by default');
 assert.match(x.squash(form.querySelector('.row-words small').textContent),/^Optional\. \$7\.00 used today\. Each Pip’s own limit is on its page\.$/);
 assert.equal(x.requests('get_pips_payments').length,1);
 change(x,x.$('#payTotal'),'0');await submit(x,'#pips-pay-total-form');
 assert.equal(x.requests('set_pips_payments').length,0,'not an amount');
 change(x,x.$('#payTotal'),'200');await submit(x,'#pips-pay-total-form');
 assert.deepEqual(last(x,'set_pips_payments'),{type:'set_pips_payments',usd_per_day:200});
 assert.equal(x.$('#payTotal').value,'200');
 assert.match(x.text(),/All your Pips together pay by themselves up to \$200 a day\./);
 change(x,x.$('#payTotal'),'');await submit(x,'#pips-pay-total-form');
 assert.deepEqual(last(x,'set_pips_payments'),{type:'set_pips_payments',usd_per_day:null},'emptied: none');
 assert.match(x.text(),/No limit for all Pips together now\. Each Pip keeps its own\./);
 const old=open({api:95});windows.push(old.w);await old.drain();
 old.$('#pips-settings-open').click();await old.drain();[...old.$$('[data-pips-settings]')].find(b=>b.dataset.pipsSettings==='apps').click();await old.drain();
 assert.equal(old.$('#pips-pay-total-form'),null,'an older DGC has no dollar limits');
 assert.equal(old.requests('get_pips_payments').length,0);
});

test('what DGC answers is checked: dollars, a count, sites by name',async()=>{
 const pay=await import('../src/pipPay.js'),model=await import('../src/pipsModel.js');
 assert.deepEqual(model.pipsPayments({usd_per_day:null,spent_today:0}),{usd_per_day:null,spent_today:0});
 assert.deepEqual(model.pipsPayments({usd_per_day:75,spent_today:12.5}),{usd_per_day:75,spent_today:12.5});
 for(const bad of [{limit:3,default:3,most:20,paid:0},{usd_per_day:-1,spent_today:0},{usd_per_day:'no_limit',spent_today:0},{usd_per_day:5},{usd_per_day:5,spent_today:-2},null])
  assert.throws(()=>model.pipsPayments(bad),/didn’t load/,JSON.stringify(bad));
 const P='pip_'+'b'.repeat(32);
 assert.deepEqual(pay.payLimits({pip_id:P,limits:{usd_per_day:40,max_count:null,sites:['shop.example']},spent_today:3},P),{usd_per_day:40,max_count:null,sites:['shop.example'],spent_today:3});
 assert.deepEqual(pay.payLimits({pip_id:P,limits:{usd_per_day:'no_limit',max_count:5,sites:null},spent_today:0},P),{usd_per_day:'no_limit',max_count:5,sites:[],spent_today:0});
 for(const bad of [{pip_id:'pip_'+'c'.repeat(32),limits:{usd_per_day:1,max_count:null,sites:null},spent_today:0},{pip_id:P,limits:{usd_per_day:0,max_count:null,sites:null},spent_today:0},
  {pip_id:P,limits:{usd_per_day:1,max_count:1.5,sites:null},spent_today:0},{pip_id:P,limits:{usd_per_day:1,max_count:null,sites:['<b>']},spent_today:0},{pip_id:P,limits:{usd_per_day:1,max_count:null,sites:null}},{pip_id:P}])
  assert.throws(()=>pay.payLimits(bad,P),/didn’t load/,JSON.stringify(bad));
 assert.equal(pay.dollars(12.5),'$12.50');assert.equal(pay.dollars(50),'$50');assert.equal(pay.dollars(1250.5),'$1,250.50');assert.equal(pay.dollars(0,true),'$0.00');
 assert.deepEqual(pay.readSites('Shop.Example, https://books.example/cart  shop.example'),['shop.example','books.example']);
 assert.equal(pay.readSites('not a site!'),null);
});

test('the editor asks an older DGC for none of it',()=>{
 const view=readFileSync(new URL('../src/pipsView.ts',import.meta.url),'utf8');
 assert.match(view,/'set_pip_pay_limits'/,'the page may send it');
 assert.match(view,/\['set_pip_pay_limits'[^\]]*\]\.includes\(request\.type\) && this\.apiVersion < 96/,'never below Pips API 96');
 const client=readFileSync(new URL('../src/pipsClient.js',import.meta.url),'utf8');
 assert.doesNotMatch(client,/pips-pay-limit\b|Payments a day|times a day across your Pips/,'the count is retired in the page');
});

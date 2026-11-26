// One Pips: every Pip in the one page and chat. "The chat layout and how Pip responds in personal pip is much better,
// so we would want one single type of view and chat for Pips" (13 Nov). A Pip with a folder opens in the page a
// Personal Pip has (header, menu, chat, settings page); what only it has is in that page: Run now in its header's menu,
// where it works, what it reads, when it runs, its reports and its version history and approvals in its settings.
// No "Reports to" and no owner session (the flow design of 14 Nov: a Pip's chat is its home). Its own changes show as
// own-change lines with Undo. Its computer and its change cards show for any Pip DGC says has one (get_pip_computer
// granted, Pips API 95), not by kind; the level picker is in every Pip's chat box, and choosing Do it all says what it
// means first.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {setup as open} from './support/one-pips-node.mjs';
import {GST,ERP,MORNINGS,LIME_DIR,CHANGE} from './support/one-pips-scene.mjs';

const windows=[];after(()=>windows.forEach(w=>w.close()));
const setup=options=>{const x=open(options);windows.push(x.w);return x;};
const WARNING='A Pip on Do it all acts without asking. It can send anything it sees, including your code, to the web. It applies its fixes to your folder, and it can start a sub-agent with full Work tools on your real files, including ones Git ignores such as .env. Payments follow the limit you set.';

test('a Pip with a folder has the Personal Pip\'s header: back, its name, its folder, one menu; Run now is in the menu',async()=>{
 const x=setup({api:95});await x.drain();await x.openPip(GST);
 const bar=x.$('.pip-topbar');
 assert.ok(bar.querySelector('#simple-back'),'back to the list');
 assert.equal(bar.querySelector('.pip-where').textContent,'lime_tiles');assert.equal(bar.querySelector('.pip-where').title,LIME_DIR);
 assert.equal(bar.querySelector('.topbar-actions > #pip-run-now'),null,'no Run now button in the bar');
 const rows=[...bar.querySelectorAll('.pip-menu .tabs-menu > button')].map(b=>b.textContent.trim());
 assert.equal(rows[0],'Run now','Run now is the menu\'s first row');
 // One Pip menu (decided 25 Nov: a Project Pip kept every page its old page had): Reports, Settings and
 // Notifications, as a Personal Pip's; its schedule, version history and the rest are on its Settings page.
 const pages=rows.filter(r=>!['Run now','Open in editor','Remove its folder…','Give it a folder…'].includes(r));
 assert.deepEqual(pages,['Reports','Settings','Notifications'],`one menu for every Pip (${rows})`);
 assert.ok(!rows.includes('History')&&!rows.includes('Runs'),'its runs are its Reports');
 bar.querySelector('.pip-menu').setAttribute('open','');
 x.$('.pip-topbar .pip-menu #pip-run-now').click();await x.drain();
 assert.equal(x.requests('run_pip').length,1,'and it runs');
 // 25 Nov (seen live): the menu stayed open over the chat after Run now; it closes, as its other rows do.
 assert.equal(x.$('.pip-topbar .pip-menu').hasAttribute('open'),false,'the menu closes');
});

test('its settings page is the Personal Pip\'s page, with what only it has: where it works, what it reads, when it runs, reports, version history',async()=>{
 const x=setup({api:95});await x.drain();await x.openPip(GST);await x.menu('job');
 const page=x.$('.pip-page');
 assert.ok(page,'the one page (pipPageMarkup)');
 assert.ok(page.querySelector('[data-pip-page="instructions"]'),'its instructions, as a Personal Pip\'s');
 const parts=page.querySelector('.pip-folder-parts');
 assert.ok(parts,'its folder\'s rows');
 const rows=[...parts.querySelectorAll('.pip-page-row')].map(r=>x.squash(r.querySelector('strong').textContent));
 assert.deepEqual(rows,['Works in','What it reads','When it runs','Reports','Version history and approvals']);
 assert.equal(parts.querySelector('.pip-folder-where').title,LIME_DIR);
 assert.match(x.squash(parts.textContent),/Your files as they are, in its own copy\. Not what Git ignores, such as \.env\./,'what it reads, said here');
 // (Changed on purpose, 25 Nov: a Pip that reads your current files runs only when you ask: DGC refuses a schedule for
 // it, so its row says so and has no Change. A Pip that reads committed code shows its schedule: the test below.)
 assert.match(x.squash(parts.textContent),/When it runs\s*Only when you ask\. It reads your files as they are\./,'when it runs, said truly');
 assert.equal(parts.querySelector('.pip-when button'),null,'nothing to change there');
 assert.doesNotMatch(x.text(),/Reports to|owner|Owner session/,'no owner session');
 assert.equal(x.requests('get_pip_owner').length,0,'and none is asked for');
 assert.equal(page.querySelector('[aria-label="Routines"]'),null,'no empty Routines section');
 // What left its menu is one click from here: Handoffs, Memory, Context.
 const more=[...parts.querySelectorAll('.pip-folder-more [data-tab]')].map(b=>b.dataset.tab);
 assert.deepEqual(more,['handoffs','memory','context'],'the rest of what it had, under More');
 parts.querySelector('[data-tab="revisions"]').click();await x.drain();
 assert.equal(x.$('.simple-content').dataset.view,'revisions','version history and approvals open from there');
});

// 25 Nov (decided: nothing of the old Project Pip page left): "When it runs" changed it on the old reviewed-schedule page
// (Review schedule…, Reset, Waiting changes). It is changed in place now, with the editor a Pip's routines use, saved at
// once; and the schedule is said once on the page, not again under Routines.
test('When it runs is changed in place, saved at once; never the old schedule page; said once on its page',async()=>{
 // A Pip that reads committed code: the only kind DGC lets run on a schedule.
 const x=setup({api:95,scene:{committed:true}});await x.drain();await x.openPip(GST);await x.menu('job');
 const parts=x.$('.pip-folder-parts');
 assert.match(x.squash(parts.querySelector('.pip-when').textContent),/When it runs.*(8:00 PM|20:00)/,'its schedule');
 assert.equal(parts.querySelector('[data-tab="schedule"]'),null,'no way to the old schedule page');
 const change=parts.querySelector('.pip-when [data-when-change]');
 assert.ok(change,'Change, on its row');
 assert.equal(x.$('.pip-page .routine-row.legacy'),null,'not said again under Routines');
 change.click();await x.drain();
 const form=x.$('.pip-folder-parts #quick-schedule-form');
 assert.ok(form,'the editor, in place');
 assert.equal(x.$('.simple-content').dataset.view,'job','still its Settings page');
 x.$('#quickKind').value='manual';x.$('#quickKind').dispatchEvent(new x.w.Event('change',{bubbles:true}));await x.drain();
 x.$('#quick-schedule-form button[type=submit]').click();await x.drain();
 const saved=x.requests('propose_pip_update').at(-1);
 assert.ok(saved,'saved at once (its own change: proposed and taken in one step), no Review schedule…');
 assert.ok('schedule' in (saved.changes||saved.request?.changes||{}),'its schedule');
});

// r149 review (25 Nov): a Pulse's plan (tests or live-data commands, saved as a reviewed change) shares one page with its
// schedule. With the Schedule row gone from its menu, its "When it runs" Change opened an in-place editor that only had
// a second "Change…" in it; its row says what and when it runs, and its Change opens that page at once.
test('a Pulse\'s row says what and when it runs, and its Change opens its plan and schedule page at once',async()=>{
 const x=setup({api:95,scene:{pulse:true}});await x.drain();await x.openPip(GST);await x.menu('job');
 const row=x.$('.pip-folder-parts .pip-when');
 assert.ok(row,'its row');
 assert.equal(x.squash(row.querySelector('strong').textContent),'What and when it runs');
 assert.equal(row.querySelector('[data-when-change]'),null,'no in-place editor for it');
 const change=row.querySelector('[data-tab="schedule"]');
 assert.ok(change,'its Change');assert.equal(x.squash(change.textContent),'Change');
 change.click();await x.drain();
 assert.equal(x.$('.simple-content').dataset.view,'schedule','its plan and schedule page, in one click');
 assert.ok(x.$('#schedule-form'),'with the form that saves them as a reviewed change');
});

test('a Pip pinned to a branch says so on its page; one without a box says it only reads',async()=>{
 const pinned=setup({api:95,scene:{branch:'release-x'}});await pinned.drain();await pinned.openPip(GST);await pinned.menu('job');
 assert.match(pinned.text('.pip-folder-parts'),/Reads branch release-x: its committed files\. What it changes always waits for your Apply\./);
 const plain=setup({api:95,scene:{box:false}});await plain.drain();await plain.openPip(GST);await plain.menu('job');
 assert.match(plain.text('.pip-folder-parts'),/Your current files\. It only reads them\./);
});

test('a Pip in a folder that isn\'t a Git project says it reads the files as they are, and what DGC never copies',async()=>{
 // A Pip works in any folder (list_project_folders' git false): DGC's own list leaves out .env, keys and node_modules.
 const x=setup({api:95,scene:{plain:true}});await x.drain();await x.openPip(GST);await x.menu('job');
 assert.match(x.text('.pip-folder-parts'),/What it reads\s*Your files as they are, in its own copy\. DGC skips \.env, keys and node_modules\./);
 assert.doesNotMatch(x.text('.pip-folder-parts'),/Git ignores/);
 const bare=setup({api:95,scene:{plain:true,box:false}});await bare.drain();await bare.openPip(GST);await bare.menu('job');
 assert.match(bare.text('.pip-folder-parts'),/Your files as they are\. It only reads them\. DGC skips \.env, keys and node_modules\./);
 // A Git project (git true, or an older DGC that doesn't say): as before.
 const git=setup({api:95});await git.drain();await git.openPip(GST);await git.menu('job');
 assert.match(git.text('.pip-folder-parts'),/Not what Git ignores, such as \.env\./);
});

test('the hint under the box no longer says "Your current files · reads only" on every turn',async()=>{
 const x=setup({api:95});await x.drain();await x.openPip(GST);
 assert.doesNotMatch(x.text('.composer-hint'),/reads only|Your current files|Committed code/);
 const old=setup({api:93});await old.drain();
 old.$('#pips-tab-project')?.click();await old.drain();
 const row=[...old.d.querySelectorAll('[data-project-pip],[data-job]')].find(r=>(r.dataset.projectPip||r.dataset.job)===GST);
 row.click();await old.drain();
 assert.match(old.text('.composer-hint'),/reads only/,'an older DGC keeps the line');
});

test('what a folder Pip changed about itself shows as an own-change line, with Undo',async()=>{
 const x=setup({api:95,scene:{own:true}});await x.drain();await x.openPip(GST);
 const line=x.$('.own-change');
 assert.ok(line,'the own-change line');
 assert.match(x.squash(line.textContent),/GST watchdog updated its job: .*Undo/);
 assert.ok(line.querySelector('[data-own-undo]'),'Undo');
});

test('a folder Pip with a box shows its computer: in its header, and on its page',async()=>{
 const x=setup({api:95});await x.drain();await x.openPip(GST);
 assert.ok(x.requests('get_pip_computer').some(r=>r.pip_id===GST),'DGC is asked whether it has one');
 assert.ok(x.$('.pip-topbar #pip-computer-open'),'its computer, one click from its chat');
 await x.menu('job');
 const section=x.$('.pip-page [aria-label="Computer"]');
 assert.ok(section,'a Computer section on its page');
 assert.match(x.squash(section.textContent),/Its own computer/);
 assert.equal(section.querySelector('#remove-computer'),null,'the computer DGC gave it is not removed here');
 section.querySelector('[data-flow-watch]').click();await x.drain();
 assert.equal(x.posted('pipsOpenComputer').at(-1)?.pip.id,GST,'Open opens it');
});

test('one on a machine without boxes shows neither its computer nor a change card',async()=>{
 const x=setup({api:95,scene:{box:false,fix:'ready'}});await x.drain();await x.openPip(GST);
 assert.equal(x.$('.pip-topbar #pip-computer-open'),null);
 assert.equal(x.$('[data-project-change]'),null,'no change card');
 assert.equal(x.requests('list_pip_project_changes').length,0,'and none is read');
 await x.menu('job');
 assert.equal(x.$('.pip-page [aria-label="Computer"]'),null);
});

test('a folder Pip with a box shows what it changed in its copy as the change card: Apply, Review, Discard',async()=>{
 const x=setup({api:95,scene:{fix:'ready'}});await x.drain();await x.openPip(GST);
 const card=x.$(`[data-project-change="${CHANGE}"]`);
 assert.ok(card,'the change card');
 assert.equal(card.querySelector('.dgc-card-title').textContent,'Changes for lime_tiles');
 assert.equal(card.querySelector('.dgc-card-sub').textContent,'2 files · +17 −4 · tests passed in its copy · not in your folder yet');
 assert.deepEqual([...card.querySelectorAll('.dgc-card-actions button')].map(b=>b.textContent.trim()),['Apply','Review','Discard']);
 assert.equal(card.querySelector('[data-project-work]'),null,'no way into a Work session from a Pip\'s card');
});

for(const [name,id] of [['a Pip with a folder',GST],['a Personal Pip',MORNINGS]]){
 test(`the level picker is in ${name}'s chat box, and choosing Do it all warns first`,async()=>{
  const x=setup({api:95});await x.drain();await x.openPip(id);
  const chip=x.$('#chat-level');
  assert.ok(chip,'the chip in its prompt box');
  chip.click();await x.drain();
  const picks=[...x.d.querySelectorAll('.composer-level-menu [data-pip-level-pick]')];
  assert.deepEqual(picks.map(p=>p.dataset.pipLevelPick),['ask','approve','full']);
  picks[2].click();await x.drain();
  const d=x.dialog();
  assert.ok(d,'a warning before anything is set');
  assert.equal(x.squash(d.querySelector('#review-description')?.textContent||d.textContent).includes(WARNING),true,'in the design\'s words');
  assert.equal(d.querySelector('#review-confirm').textContent.trim(),'Continue');assert.equal(d.querySelector('#review-cancel').textContent.trim(),'Cancel');
  assert.equal(x.requests('set_pip_level').length,0,'nothing sent yet');
  d.querySelector('#review-cancel').click();await x.drain();
  assert.equal(x.requests('set_pip_level').length,0,'Cancel leaves it as it was');
  x.$('#chat-level').click();await x.drain();
  [...x.d.querySelectorAll('.composer-level-menu [data-pip-level-pick]')][2].click();await x.drain();
  x.dialog().querySelector('#review-confirm').click();await x.drain();
  assert.deepEqual(x.requests('set_pip_level').at(-1),{type:'set_pip_level',pip_id:id,level:'full'},'Continue sets it');
  assert.equal(x.dialog(),null);
 });
}

test('the other levels are set at once, with no warning',async()=>{
 const x=setup({api:95});await x.drain();await x.openPip(GST);
 x.$('#chat-level').click();await x.drain();
 [...x.d.querySelectorAll('.composer-level-menu [data-pip-level-pick]')][1].click();await x.drain();
 assert.equal(x.dialog(),null);
 assert.deepEqual(x.requests('set_pip_level').at(-1),{type:'set_pip_level',pip_id:GST,level:'approve'});
});

test('the page\'s own level picker warns the same way, and keeps the level shown until Continue',async()=>{
 const x=setup({api:95});await x.drain();await x.openPip(GST);await x.menu('job');
 const pick=x.$('#pipLevel');
 assert.ok(pick,'the level on its page');
 pick.value='full';pick.dispatchEvent(new x.w.Event('change',{bubbles:true,composed:true}));await x.drain();
 assert.ok(x.dialog(),'the warning');assert.equal(x.$('#pipLevel').value,'ask','the picker still says what is true');
 assert.equal(x.requests('set_pip_level').length,0);
 x.dialog().querySelector('#review-confirm').click();await x.drain();
 assert.equal(x.requests('set_pip_level').at(-1).level,'full');
});

test('a change it applied by itself says so on its card, with Undo',async()=>{
 const x=setup({api:95,scene:{fix:'applied',level:'full'}});await x.drain();await x.openPip(GST);
 const card=x.$(`[data-project-change="${CHANGE}"]`);
 assert.ok(card);
 assert.match(x.squash(card.textContent),/Applied by itself at Do it all/);
 assert.ok(card.querySelector('[data-project-undo]'),'Undo');
});

test('an older DGC keeps a Project Pip\'s old header, with its Run button in the bar',async()=>{
 const x=setup({api:93});await x.drain();
 x.$('#pips-tab-project')?.click();await x.drain();
 [...x.d.querySelectorAll('[data-project-pip],[data-job]')].find(r=>(r.dataset.projectPip||r.dataset.job)===GST).click();await x.drain();
 assert.ok(x.$('.pip-topbar .topbar-actions > #pip-run-now'),'Run now in the bar, as before');
 assert.equal(x.$('.pip-topbar .pip-where'),null);
});

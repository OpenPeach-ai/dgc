// A Pip computer's notification drawer (0.52): what waits for you, as notification cards over the picture of the
// computer's screen, the way a desktop shows them. This file is the words and the markup; pipComputerClient.js keeps
// the state (which cards, open or collapsed, the banner) and pipComputer.css the look and the motion.
//
// The drawer is DGC's own page. It is never drawn into the computer's desktop or a frame the Pip reads, and nothing
// done on it is sent to the computer.
import {carefulWords,heldRequestAnswers,sendsWords,isPayment,limitWords,asksWords,coversWords,isCode,codeWords,codeFieldMarkup} from './pipCareful.js';
import {esc} from './pipsModel.js';

/** How long things take, in ms: a card springing in, a card leaving, an answered card's moment, a banner's stay, the bell's wiggle. */
export const DRAWER={enter:460,leave:340,stay:1800,banner:6000,ring:720,swipe:90,
 spring:'cubic-bezier(0.2, 0.9, 0.25, 1.12)',exit:'cubic-bezier(0.4, 0, 0.2, 1)'};

const svg=d=>`<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
export const BELL='M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 1.5h-15Z M10 20.5a2.2 2.2 0 0 0 4 0';
const CHECK='M5 12.5l4.2 4.2L19 7';
const CLOSE='M7 7l10 10M17 7 7 17';
// A tile's icon says the kind of thing that waits: a form, a payment, a site to visit, a sign-in, text for a page, a
// Terminal command, a download.
const KIND={
 form:'M7 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7.5 3.5Z M14 3.5v4h4 M9 12h6 M9 15.5h4',
 payment:'M3.5 8a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z M3.5 10h17 M7 14.5h4',
 site:'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z M3.5 12h17 M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5S9.6 5.8 12 3.5Z',
 signin:'M12 3.5 19 6v5.5c0 4.2-2.9 7.7-7 9-4.1-1.3-7-4.8-7-9V6Z M9.5 11.5h5v4h-5Z M10.5 11.5V10a1.5 1.5 0 0 1 3 0v1.5',
 text:'M5.5 19v-3.4A7 7 0 0 1 4 11.2C4 7.2 7.6 4 12 4s8 3.2 8 7.2-3.6 7.2-8 7.2a9 9 0 0 1-2.7-.4Z M8.5 10h7 M8.5 13h4.5',
 terminal:'M4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11A1.5 1.5 0 0 1 4.5 5Z M7 10l3 2.5L7 15 M12.5 15H16',
 download:'M12 4v10.5 M7.5 10.5 12 15l4.5-4.5 M5 19.5h14',
 // A one-time code: a message with its digits.
 code:'M4.5 6h15A1.5 1.5 0 0 1 21 7.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5v-9A1.5 1.5 0 0 1 4.5 6Z M7.5 12h.01 M10.5 12h.01 M13.5 12h.01 M16.5 12h.01'};

/** A card's age, as a notification says it: "now", "4m", "2h", "3d". */
export function ageWords(created,now=Date.now()){
 const then=Date.parse(created);if(Number.isNaN(then))return '';
 const s=Math.max(0,Math.round((now-then)/1000));
 return s<60?'now':s<3600?`${Math.floor(s/60)}m`:s<86400?`${Math.floor(s/3600)}h`:`${Math.floor(s/86400)}d`;
}

/** What a waiting approval says on its card: the kind (its tile), where it is from, what it wants in bold, one line of
 *  detail, the rest of what its card always showed (the detail, one press away), and its answers: the ones its card in
 *  the Pip's chat offers, in the same order and words (one list, pipCareful.js heldRequestAnswers; decided 15 Nov). Each
 *  answer: how it is given (login, review, send, always, reject), its label, and the quiet word that takes the buttons'
 *  place once it is given. */
export function cardWords(a,pipName='The Pip'){
 const s=a.summary||{},words=carefulWords(s,pipName),site=s.site||s.host||'a site';
 const answers=heldRequestAnswers(s,pipName);
 // A code to type (the code card, Pips API 98): its field is on the notification itself, as on its card in the chat.
 if(isCode(s)){const say=codeWords(s,pipName);return {kind:'code',source:s.site||say.shown,title:say.title,line:say.line,sends:'',text:'',answers};}
 if(words&&s.kind==='login')return {kind:'signin',source:site,title:words[0],line:words[1],sends:'',text:'',answers};
 if(words)return {kind:s.kind==='floor'?'terminal':s.kind,source:s.kind==='floor'?'Terminal':site,title:words[0],line:words[1],sends:'',text:s.kind==='text'&&typeof s.text==='string'?s.text:'',answers};
 const asks=asksWords(s),sends=sendsWords(s);
 const limit=limitWords(s);
 const line=`${s.payment===true?'Sends payment card details. ':''}${asks}${asks?' ':''}Nothing has been sent. ${coversWords(s)}.`;
 return {kind:s.kind==='download'?'download':isPayment(s)?'payment':'form',source:s.host,title:`${isPayment(s)?'Pay on':'Send a form to'} ${s.host}`,line,sends,text:'',limit,answers};
}

/** The card's title alone, for the bell's own words. */
export const cardTitle=(a,pipName)=>cardWords(a,pipName).title;

/** One card. `card`: {a, done} (done: the quiet word of an answered one, else it still waits); `open`: its detail is on show. */
function cardMarkup(card,{pipName,now,open,code=null}){
 const a=card.a,w=cardWords(a,pipName),id=esc(a.id),answered=card.done!=null;
 // A code card's answers are a form: its field, Send (Enter sends too) and Not now, and what DGC said about the last
 // try under them. `code`: {sending, error} for this card (never what was typed, which only its field holds).
 const codeForm=()=>{const sending=!!code?.sending,error=code?.error||'';
  return `<form class="pc-card-actions pc-actions pc-code-form" id="pc-code-form-${id}" data-code-form="${id}" autocomplete="off" novalidate>`
   +codeFieldMarkup(a.summary,{esc,id:`pc-code-field-${a.id}`,action:a.id,pipName,sending,describedBy:error?`pc-code-error-${a.id}`:''})
   +w.answers.map(b=>b.how==='code'?`<button type="submit" id="pc-code-${id}" class="pc-pill solid" data-code="${id}"${sending?' disabled':''}>${sending?'Sending…':esc(b.label)}</button>`
    :`<button type="button" id="pc-${b.how}-${id}" class="pc-pill" data-${b.how}="${id}"${sending?' disabled':''}>${esc(b.label)}</button>`).join('')
   +'</form>'+(error?`<p class="pc-card-error" id="pc-code-error-${id}" role="alert">${esc(error)}</p>`:'');};
 // The one line is what a form sends when it says (a bill's number, an amount), else what the card is; the detail has both.
 const detail=`${w.sends?`<span class="pc-sends">${esc(w.sends)}</span>`:''}<span>${esc(w.line)}</span>${w.text?`<pre class="pc-held-text">${esc(w.text)}</pre>`:''}`;
 // (An answered card says its quiet word; one that ended some other way, a code's page moving on, says so in a line.)
 const answers=answered
  ?(card.note?`<p class="pc-card-note" role="status">${esc(card.note)}</p>`:`<span class="pc-card-done" role="status">${svg(CHECK)}<span>${esc(card.done)}</span></span>`)
  :w.kind==='code'?codeForm()
  :`<div class="pc-card-actions pc-actions">${w.answers.map((b,i)=>`<button type="button" id="pc-${b.how}-${id}" class="pc-pill${i===0&&b.how!=='reject'?' solid':''}" data-${b.how}="${id}">${esc(b.label)}</button>`).join('')}</div>`;
 return `<div class="pc-card pc-hold" role="listitem" data-card="${id}" data-state="${answered?'answered':'waiting'}" data-kind="${w.kind}" aria-label="${esc(`${w.source}: ${w.title}`)}">`
  +`<span class="pc-card-tile" aria-hidden="true">${svg(KIND[w.kind]||KIND.form)}</span>`
  +`<div class="pc-card-body"><p class="pc-card-top"><span class="pc-card-source">${esc(w.source)}</span><span aria-hidden="true">·</span><span class="pc-card-age">${esc(ageWords(a.created_at,now))}</span></p>`
  +`<button type="button" class="pc-card-open" id="pc-open-${id}" data-card-open="${id}" aria-expanded="${open}" aria-controls="pc-detail-${id}">${esc(w.title)}</button>`
  // (A code card that has ended no longer asks for anything: its line about typing it is gone with its field.)
  +(answered&&w.kind==='code'?`<div class="pc-card-detail" id="pc-detail-${id}" hidden></div>`:`<p class="pc-card-line"${open?' hidden':''}>${esc(w.sends||w.line)}</p><div class="pc-card-detail" id="pc-detail-${id}"${open?'':' hidden'}>${detail}</div>`)
  +`${w.limit&&!answered?`<p class="pc-card-limit">${esc(w.limit)}</p>`:''}${answers}</div>`
  +(answered?`<button type="button" class="pc-card-clear" id="pc-clear-${id}" data-card-clear="${id}" aria-label="Clear" title="Clear">${svg(CLOSE)}</button>`:'<span class="pc-card-live" aria-hidden="true"></span>')
  +'</div>';
}

/** The drawer: its header (the bell, "Waiting for you", how many, Collapse) and its cards, newest first. A banner is one
 *  card alone, with no header. Folded or fanned out is the page's to say (a class), so the same cards can move. */
export function drawerMarkup({cards,waiting,banner=false,pipName,now=Date.now(),open=new Set(),codes=null}){
 if(!cards.length)return '';
 const head=banner?'':`<header class="pc-drawer-head"><span class="pc-drawer-bell" aria-hidden="true">${svg(BELL)}</span><h2>Waiting for you</h2>`
  +`<span class="pc-drawer-count" aria-label="${waiting} waiting">${waiting}</span><button type="button" id="pc-drawer-collapse" class="pc-drawer-quiet">Collapse</button></header>`;
 return `<section class="pc-drawer${banner?' pc-drawer-banner':''}" id="pc-drawer" aria-label="Waiting for you" data-count="${cards.length}">${head}`
  +`<div class="pc-drawer-list pc-waiting" role="list" aria-label="Waiting for you">${cards.map(card=>cardMarkup(card,{pipName,now,open:open.has(card.a.id),code:codes?.get(card.a.id)||null})).join('')}</div></section>`;
}

/** The bell in the slim bar: how many wait, and whether the drawer is on show. Nothing at none. */
export function bellMarkup({waiting,first='',expanded}){
 if(!waiting)return '';
 const all=`${waiting} waiting for you${first?`: ${first}`:''}`;
 return `<button type="button" id="pc-bell" class="dgc-btn small pc-tool pc-bell" aria-expanded="${expanded}" aria-controls="pc-drawer" aria-label="${esc(all)}" title="${esc(all)}">`
  +`<span class="pc-bell-mark" aria-hidden="true">${svg(BELL)}</span><span class="pc-bell-count" aria-hidden="true">${waiting}</span></button>`;
}

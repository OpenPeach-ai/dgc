// A Pip's chat moves as Work's chat does. Sending brings your message into view, the reply is followed unless you
// scrolled away, a Latest pill brings you back, and your message stays pinned at the top while you read its answer.
//
// The rules, numbers and words are Work's (media/main.js: "Is the view still tracking the end of the run?", "reading back
// without losing the end", "0.47 pinned prompt"). They are repeated here because main.js is a plain script that draws the
// whole panel and this one is bundled into a page of its own; pips-chat-follow.test.mjs reads both and fails if they part.
// Only the first rule below is a Pip's own: its first message is the one thing nobody has read yet.
export const AT_BOTTOM_PX=60,AT_END_PX=2,GESTURE_MS=700;
export const PIN_GROUND_PX=28,PIN_FADE_PX=12,PIN_SHARE=0.3,PIN_LOG_SHARE=0.4,PIN_JUMP_DELAY_MS=300;
const SCROLL_KEYS=new Set(['PageUp','PageDown','Home','End','ArrowUp','ArrowDown',' ']);

/** How tall a prompt may be and still pin: 30% of the window, and at most 40% of the transcript (Work's pinRoom). */
export function pinRoom(log,win=globalThis){
 const byWindow=win.innerHeight*PIN_SHARE,shown=log?.clientHeight||0;
 return shown>0?Math.min(byWindow,shown*PIN_LOG_SHARE):byWindow;
}

/**
 * `opening()`: the chat has nothing from you yet. It opens on the start of the Pip's own message, however long, and stays
 * there while it arrives: at the end you would meet the last lines of a message whose start is out of sight.
 * `focusBox()`: where the keyboard goes after Latest.
 */
export function createChatFollow({opening=()=>false,focusBox=()=>{},win=globalThis}={}){
 let log=null,pill=null,label=null,following=true,unread=false,userScrolledAt=0,lastTop=0,holding=false;
 let contentSizes=null,logSize=null,pinFit=null,shownHeight=-1,pinJump=0,pinDown=null,unbind=null,watched=new WeakSet();
 const Observer=typeof win.ResizeObserver==='function'?win.ResizeObserver:null;
 const atBottom=()=>!!log&&log.scrollHeight-log.scrollTop-log.clientHeight<AT_BOTTOM_PX;
 const atEnd=()=>!!log&&log.scrollHeight-log.scrollTop-log.clientHeight<AT_END_PX;
 function paint(){
  if(!pill)return;
  const away=!atBottom();
  if(!away)unread=false;
  if(atEnd()&&!holding)following=true;
  pill.hidden=!away;
  pill.classList.toggle('unread',away&&unread);
  if(label)label.textContent=away&&unread?'New':'Latest';
  const title=away&&unread?'The Pip has written more since you scrolled up. Jump to it':'Jump to the newest message';
  pill.title=title;pill.setAttribute('aria-label',title);
 }
 function toEnd(){if(!log)return;log.scrollTop=log.scrollHeight;lastTop=log.scrollTop;following=true;holding=false;paint();}
 // The start of what the Pip last wrote, or the end when that fits: the browser stops at the end by itself.
 function toOpening(){
  if(!log)return;
  const items=log.querySelectorAll('.pip-message,[data-run-post]'),last=items[items.length-1];
  if(!last){log.scrollTop=log.scrollHeight;lastTop=log.scrollTop;return;}
  const pad=parseFloat(win.getComputedStyle?.(log)?.paddingTop)||0;
  log.scrollTop=last.getBoundingClientRect().top-log.getBoundingClientRect().top+log.scrollTop-pad;
  lastTop=log.scrollTop;
 }
 // Where the view belongs right now, if nobody moved it: nothing happens for someone reading back.
 function settle(){
  if(!log)return;
  if(holding&&opening()){toOpening();paint();return;}
  holding=false;
  if(following)toEnd();else paint();
 }
 function fitPin(head,room){if(head._pinH>0)head.classList.toggle('pin-off',head._pinH+PIN_GROUND_PX>room);}
 function refitPins(){
  if(!log)return;
  const room=pinRoom(log,win);
  for(const head of log.querySelectorAll('.pip-turn > .pip-message.user'))fitPin(head,room);
 }
 const readingBack=()=>{userScrolledAt=Date.now();};
 // Where a prompt was laid out, pinned or not (Work's laidOutTop for a head that isn't its box's first child).
 function laidOutTop(head){const before=head.style.position;head.style.position='relative';const top=head.getBoundingClientRect().top;head.style.position=before;return top;}
 const restLine=()=>log.getBoundingClientRect().top+(parseFloat(win.getComputedStyle(log).paddingTop)||0);
 function goToPrompt(head){
  const delta=laidOutTop(head)-restLine();
  if(Math.abs(delta)<2)return false;
  readingBack();following=false;holding=false;
  log.scrollTop+=delta;lastTop=log.scrollTop;paint();
  return true;
 }
 function isPinned(head){
  if(!head?.isConnected)return false;
  const drawn=head.getBoundingClientRect();
  return drawn.top-laidOutTop(head)>1&&drawn.bottom>log.getBoundingClientRect().top;
 }
 // Focus is never left under a pinned prompt (WCAG 2.2, 2.4.11), as in Work.
 function clearOfPin(target){
  if(!target?.closest||target.closest('.pip-turn > .pip-message.user'))return;
  const box=target.closest('.pip-turn'),head=box?.querySelector(':scope > .pip-message.user');
  if(!head||!isPinned(head))return;
  const at=target.getBoundingClientRect();
  if(at.bottom<=log.getBoundingClientRect().top)return;
  const covered=head.getBoundingClientRect().bottom+PIN_FADE_PX-at.top;
  if(covered>0)log.scrollTop-=covered;
 }
 function bind(next){
  const on=(type,fn,options)=>{next.addEventListener(type,fn,options);return ()=>next.removeEventListener(type,fn,options);};
  const off=[
   on('wheel',readingBack,{passive:true}),on('touchmove',readingBack,{passive:true}),
   on('pointerdown',event=>{if(event.offsetX>next.clientWidth)readingBack();},{passive:true}),
   on('keydown',event=>{if(SCROLL_KEYS.has(event.key)&&!event.target.closest?.('input,textarea,select,[contenteditable]'))readingBack();},{passive:true}),
   on('scroll',()=>{
    // A person's own scroll up always wins, however small; following comes back only at the very end.
    const up=next.scrollTop<lastTop-0.5;
    lastTop=next.scrollTop;
    if(Date.now()-userScrolledAt<GESTURE_MS){holding=false;following=up?false:atEnd()||(following&&atBottom());}
    paint();
   },{passive:true}),
   // A click on a prompt goes back to where it was sent, after Work's 300ms: never on a link or button, with a modifier,
   // on a double click, or once something is selected.
   on('pointerdown',()=>{const selection=win.getSelection?.();pinDown={selected:!!selection&&!selection.isCollapsed,focused:win.document?.hasFocus?.()!==false};},{capture:true,passive:true}),
   on('click',event=>{
    win.clearTimeout(pinJump);
    const down=pinDown;pinDown=null;
    if(event.button!==0||event.detail!==1||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
    if(down&&(down.selected||!down.focused))return;
    const bubble=event.target.closest?.('.pip-turn > .pip-message.user .bubble');
    if(!bubble||event.target.closest('button,a,input,textarea,select,summary,[role=button],[tabindex]'))return;
    const head=bubble.closest('.pip-message');
    pinJump=win.setTimeout(()=>{const selection=win.getSelection?.();if((selection&&!selection.isCollapsed)||!head.isConnected)return;goToPrompt(head);},PIN_JUMP_DELAY_MS);
   }),
   // Opened, it is being read: what arrives below must not take the reader away from it (Work: togglePromptFold). In a
   // frame's first step, before the height it adds reaches the observers.
   on('click',event=>{if(event.target.closest?.('summary,[aria-expanded],[data-post-more]'))win.requestAnimationFrame?.(()=>{if(log&&!atBottom()){following=false;holding=false;paint();}});}),
   on('focusin',event=>{let keyboard=true;try{keyboard=event.target.matches(':focus-visible');}catch{}if(keyboard)clearOfPin(event.target);}),
  ];
  return ()=>{for(const remove of off)remove();};
 }
 function observe(){
  if(!Observer||!log)return;
  // What changes height with no redraw: a picture or a card's frame loading, the box growing above the composer.
  contentSizes||=new Observer(()=>{if(following||holding)settle();else paint();});
  logSize||=new Observer(()=>{
   const height=log?.clientHeight||0;
   if(height<=0||height===shownHeight)return;
   shownHeight=height;refitPins();settle();
  });
  pinFit||=new Observer(entries=>{
   const room=pinRoom(log,win);
   for(const entry of entries){
    const height=entry.borderBoxSize?.[0]?.blockSize??entry.contentRect?.height??0;
    if(height>0)entry.target._pinH=height;
    fitPin(entry.target,room);
   }
  });
 }
 function watch(){
  if(!Observer||!log)return;
  for(const child of log.children)if(!watched.has(child)){watched.add(child);contentSizes.observe(child);}
  for(const head of log.querySelectorAll('.pip-turn > .pip-message.user'))if(!watched.has(head)){watched.add(head);pinFit.observe(head);}
 }
 function resize(){refitPins();}
 win.addEventListener?.('resize',resize);
 return {
  get following(){return following;},
  atBottom,atEnd,refitPins,
  /** After every draw. `opened`: this chat has just come on screen, so it starts over. */
  drawn(nextLog,nextPill,{opened=false,grew=0,olderAbove=false,scroll=null}={}){
   if(nextLog!==log){
    unbind?.();contentSizes?.disconnect();logSize?.disconnect();pinFit?.disconnect();watched=new WeakSet();shownHeight=-1;
    log=nextLog;unbind=log?bind(log):null;lastTop=log?.scrollTop||0;
    if(log){observe();logSize?.observe(log);}
   }
   pill=nextPill;label=pill?.querySelector('[data-latest-label]')||null;
   if(!log)return;
   if(opened){following=true;unread=false;holding=true;}
   watch();refitPins();
   if(opened||following||holding){settle();return;}
   // Someone reading back stays on what they read: older messages drawn above move it by exactly their height.
   if(scroll!==null){log.scrollTop=olderAbove?scroll+grew:scroll;lastTop=log.scrollTop;}
   if(grew>0&&!olderAbove)unread=true;
   paint();
  },
  /** Your message is on its way: into view, and the reply is followed. */
  sending(){following=true;holding=false;unread=false;},
  /** The page took you to something (a card you opened): the next line of a reply must not take you away from it. */
  reading(){if(!log)return;lastTop=log.scrollTop;if(!atBottom()){following=false;holding=false;}paint();},
  /** The Latest pill. */
  latest(){holding=false;toEnd();unread=false;paint();focusBox();},
  dispose(){unbind?.();contentSizes?.disconnect();logSize?.disconnect();pinFit?.disconnect();win.removeEventListener?.('resize',resize);win.clearTimeout(pinJump);log=null;pill=null;},
 };
}

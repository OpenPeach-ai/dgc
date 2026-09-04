(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const header = document.querySelector('[data-site-header]');
  const onScroll = () => header?.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, {passive:true}); requestAnimationFrame(onScroll);

  const alignContainedTarget = () => {
    if (!location.hash) return;
    let target;
    try { target = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch { return; }
    if (!target?.closest('main>.section')) return;
    requestAnimationFrame(() => requestAnimationFrame(() => target.scrollIntoView({block:'start', behavior:'instant'})));
  };
  alignContainedTarget(); addEventListener('hashchange', alignContainedTarget);

  const announcement = document.querySelector('[data-announcement]');
  if (announcement) {
    const key = `dgc-announcement-${announcement.dataset.announcement}`;
    try {
      if (localStorage.getItem(key) === 'dismissed') announcement.hidden = true;
    } catch {}
    announcement.querySelector('[data-dismiss-announcement]')?.addEventListener('click', () => {
      announcement.hidden = true;
      try { localStorage.setItem(key, 'dismissed'); } catch {}
    });
  }

  const bindDialog = (dialog, openers, closers) => {
    if (!dialog) return;
    let returnFocus = null;
    openers.forEach(opener => opener?.addEventListener('click', event => {
      event.preventDefault(); returnFocus = opener; dialog.showModal();
      document.body.classList.add('menu-open'); opener.setAttribute('aria-expanded', 'true');
      dialog.querySelector('a,button,input')?.focus();
    }));
    const close = () => {
      if (!dialog.open) return; dialog.close(); document.body.classList.remove('menu-open');
      openers.forEach(opener => opener?.setAttribute('aria-expanded', 'false')); returnFocus?.focus();
    };
    closers.forEach(closer => closer?.addEventListener('click', close));
    dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
    dialog.addEventListener('close', () => {
      document.body.classList.remove('menu-open'); openers.forEach(opener => opener?.setAttribute('aria-expanded', 'false'));
    });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled])')];
      if (!items.length) return;
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
  };
  const mobileNav = document.getElementById('mobile-nav');
  bindDialog(mobileNav, [...document.querySelectorAll('.nav-toggle')], [...document.querySelectorAll('[data-close-menu]')]);
  mobileNav?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => mobileNav.close()));
  const docsMenu = document.getElementById('docs-menu');
  bindDialog(docsMenu, [...document.querySelectorAll('.docs-menu-button')], [...document.querySelectorAll('[data-close-docs]')]);
  docsMenu?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => docsMenu.close()));

  const reveals = [...document.querySelectorAll('.reveal')];
  if (reduce || !('IntersectionObserver' in window)) reveals.forEach(el => el.classList.add('in'));
  else {
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('in'); observer.unobserve(entry.target); }
    }), {rootMargin:'0px 0px -9%', threshold:.08});
    reveals.forEach(el => observer.observe(el));
  }

  const formatCount = (value, decimals) => Number(value).toFixed(decimals);
  document.querySelectorAll('[data-count]').forEach(el => {
    const target = Number(el.dataset.count); const decimals = Number(el.dataset.decimals || 0);
    const suffix = el.dataset.suffix || ''; const prefix = el.dataset.prefix || '';
    const finish = () => { el.textContent = `${prefix}${formatCount(target, decimals)}${suffix}`; };
    if (reduce || matchMedia('(max-width:760px)').matches || !('IntersectionObserver' in window)) { finish(); return; }
    const io = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      const start = performance.now(); const duration = 820;
      const frame = now => {
        const p = Math.min(1, (now - start) / duration); const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = `${prefix}${formatCount(target * eased, decimals)}${suffix}`;
        if (p < 1) requestAnimationFrame(frame); else finish();
      };
      requestAnimationFrame(frame); io.disconnect();
    }, {threshold:.4}); io.observe(el);
  });

  document.querySelectorAll('[data-install-tabs]').forEach(group => {
    const command = group.querySelector('[data-install-command]');
    const panel = command?.closest('[role=tabpanel]');
    const tabs = [...group.querySelectorAll('[role=tab]')];
    const values = {macos:'curl -fsSL https://vibedgc.com/install.sh | bash',linux:'curl -fsSL https://vibedgc.com/install.sh | bash',windows:'curl -fsSL https://vibedgc.com/install.sh | bash'};
    const platform = /Win/.test(navigator.platform) ? 'windows' : /Mac/.test(navigator.platform) ? 'macos' : 'linux';
    const select = button => {
      tabs.forEach(tab => {
        const selected = tab === button;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      });
      if (panel && button.id) panel.setAttribute('aria-labelledby', button.id);
      command.textContent = values[button.dataset.os]; command.dataset.copy = values[button.dataset.os];
    };
    tabs.forEach((button, index) => {
      button.addEventListener('click', () => select(button));
      button.addEventListener('keydown', event => {
        const keys = {ArrowLeft:index - 1, ArrowRight:index + 1, Home:0, End:tabs.length - 1};
        if (!(event.key in keys)) return;
        event.preventDefault();
        const next = tabs[(keys[event.key] + tabs.length) % tabs.length];
        select(next); next.focus();
      });
    });
    const initial = group.querySelector(`[data-os="${platform}"]`) || tabs[0];
    if (initial && command) select(initial);
  });

  const emit = name => {
    if (!name || navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true) return;
    const body = JSON.stringify({event:name,path:location.pathname});
    if (navigator.sendBeacon) navigator.sendBeacon('/api/event', new Blob([body], {type:'application/json'}));
    else fetch('/api/event', {method:'POST',headers:{'content-type':'application/json'},body,keepalive:true}).catch(() => {});
  };
  document.querySelectorAll('[data-event]:not([data-copy])').forEach(el => el.addEventListener('click', () => emit(el.dataset.event)));
  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const selector = button.dataset.copyTarget; const source = selector ? document.querySelector(selector) : button.closest('[data-copy-scope]')?.querySelector('code');
    const value = source?.dataset.copy || source?.textContent || '';
    try { await navigator.clipboard.writeText(value.trim()); button.textContent = 'copied'; setTimeout(() => button.textContent = 'copy', 1500); emit(button.dataset.event); }
    catch { button.textContent = 'select'; }
  }));
  document.querySelectorAll('[data-event-play]').forEach(media => media.addEventListener('play', () => emit(media.dataset.eventPlay), {once:true}));

  document.querySelectorAll('.spotlight').forEach(card => card.addEventListener('pointermove', event => {
    const rect = card.getBoundingClientRect(); card.style.setProperty('--mx', `${event.clientX - rect.left}px`); card.style.setProperty('--my', `${event.clientY - rect.top}px`);
  }));

  const heroVideo = document.querySelector('video[data-hero-video]');
  if (heroVideo && !reduce) {
    let hydrated = false;
    const hydrateHero = () => {
      if (hydrated) return; hydrated = true;
      heroVideo.querySelectorAll('source[data-src]').forEach(source => { source.src = source.dataset.src; source.removeAttribute('data-src'); });
      heroVideo.load(); heroVideo.play().catch(() => {});
    };
    addEventListener('pointermove', hydrateHero, {once:true, passive:true});
    addEventListener('pointerdown', hydrateHero, {once:true, passive:true});
    addEventListener('scroll', hydrateHero, {once:true, passive:true});
    addEventListener('keydown', hydrateHero, {once:true});
  }

  const videos = [...document.querySelectorAll('video[data-lazy-video]')];
  const hydrateVideo = video => {
    if (video.dataset.poster) { video.poster = video.dataset.poster; delete video.dataset.poster; }
    video.querySelectorAll('source[data-src]').forEach(source => { source.src = source.dataset.src; source.removeAttribute('data-src'); });
    video.load(); if (!reduce) video.play().catch(() => {});
  };
  if ('IntersectionObserver' in window) {
    const vio = new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return; const video = entry.target;
      hydrateVideo(video); vio.unobserve(video);
    }), {rootMargin:'200px 0px'}); videos.forEach(video => vio.observe(video));
  } else videos.forEach(hydrateVideo);

  document.querySelectorAll('[data-artifact-tabs]').forEach(browser => {
    const tabs = [...browser.querySelectorAll('[role=tab]')]; const panes = [...browser.querySelectorAll('[role=tabpanel]')];
    const show = index => { tabs.forEach((tab,i) => tab.setAttribute('aria-selected', String(i === index))); panes.forEach((pane,i) => pane.hidden = i !== index); };
    tabs.forEach((tab,index) => tab.addEventListener('click', () => show(index)));
    if (!reduce && tabs.length > 1) { let index=0; setInterval(() => { if (!browser.matches(':hover')) show(index = (index+1)%tabs.length); }, 5200); }
  });

  document.querySelectorAll('[data-pipeline]').forEach(panel => {
    const stages = [...panel.querySelectorAll('.stage')]; if (reduce || !stages.length) { stages.at(-1)?.classList.add('active'); return; }
    let timer = null, index = 0;
    const stop = () => { clearInterval(timer); timer = null; stages.forEach(s => s.classList.remove('active')); };
    const start = () => { if (timer) return; stages[index].classList.add('active'); timer=setInterval(() => { stages[index].classList.remove('active'); index=(index+1)%stages.length; stages[index].classList.add('active'); }, 900); };
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(entries => entries.forEach(e => e.isIntersecting ? start() : stop()), {threshold:.3}).observe(panel);
    } else start();
  });

  const actionPanel = document.querySelector('[data-subscription-panel]');
  if (actionPanel) {
    const title = actionPanel.querySelector('[data-subscription-title]');
    const label = actionPanel.querySelector('[data-subscription-label]');
    const copy = actionPanel.querySelector('[data-subscription-copy]');
    const form = actionPanel.querySelector('[data-subscription-action]');
    const tokenInput = form?.querySelector('[name=token]');
    const submit = form?.querySelector('[data-subscription-submit]');
    const status = new URLSearchParams(location.search).get('status');
    const outcomes = {
      confirmed: ['Confirmed', 'Release notes are on.', 'Your address is confirmed. Every release email must carry an unsubscribe link.'],
      removed: ['Removed', 'You are unsubscribed.', 'This address is no longer on the DGC release-notes list.'],
      complete: ['Complete', 'The request is complete.', 'No further action is needed.'],
    };
    if (outcomes[status]) {
      [label.textContent, title.textContent, copy.textContent] = outcomes[status];
    } else {
      const raw = location.hash.slice(1);
      const match = raw.match(/^(confirm|unsubscribe)=([A-Za-z0-9_-]{40,64})$/);
      if (match && form && tokenInput && submit) {
        const confirming = match[1] === 'confirm';
        label.textContent = confirming ? 'Confirm subscription' : 'Unsubscribe';
        title.textContent = confirming ? 'Receive DGC release notes?' : 'Stop DGC release notes?';
        copy.textContent = confirming
          ? 'Confirm only if you requested occasional DGC release email at this address.'
          : 'This removes the address associated with the private link. It does not affect DGC itself.';
        form.action = confirming ? '/api/subscribe/confirm' : '/api/unsubscribe';
        tokenInput.value = match[2];
        submit.textContent = confirming ? 'Confirm subscription' : 'Unsubscribe';
        submit.disabled = false;
        form.hidden = false;
        history.replaceState(null, '', location.pathname + location.search);
      } else {
        label.textContent = 'Invalid link';
        title.textContent = 'This link is invalid or expired.';
        copy.textContent = 'No subscription state changed. Request a new confirmation link from the release-notes form.';
      }
    }
    title.focus({preventScroll:true});
  }

  document.querySelectorAll('form[data-async-form]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault(); const status = form.querySelector('.form-status'); const button = form.querySelector('[type=submit]');
    status.textContent = 'Sending…'; button.disabled = true;
    try {
      const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(form.action, {method:'POST',body:new FormData(form),headers:{accept:'application/json'},signal:controller.signal});
      clearTimeout(timeout);
      const result = await response.json().catch(() => ({})); if (!response.ok) throw new Error(result.error || 'Could not send');
      status.textContent = result.message || 'Received. Thank you.'; form.reset();
      if (form.hasAttribute('data-subscription-action')) {
        button.dataset.complete = 'true';
        const title = form.closest('[data-subscription-panel]')?.querySelector('[data-subscription-title]');
        if (title) title.textContent = result.message || 'Request complete.';
      }
    } catch (error) { status.textContent = `${error.name === 'AbortError' ? 'Request timed out' : error.message}. Please try again.`; }
    finally { button.disabled = button.dataset.complete === 'true'; }
  }));

  const capture = document.getElementById('product-capture');
  bindDialog(capture, [...document.querySelectorAll('[data-open-capture]')], [...document.querySelectorAll('[data-close-capture]')]);
  document.querySelectorAll('[data-open-capture]').forEach(opener => opener.addEventListener('click', () => {
    const video = capture?.querySelector('video');
    if (video?.dataset.poster) { video.poster = video.dataset.poster; delete video.dataset.poster; }
    video?.play().catch(() => {});
  }));
  capture?.addEventListener('close', () => capture.querySelector('video')?.pause());

  const subscription = new URLSearchParams(location.search).get('subscription');
  const releaseStatus = document.querySelector('#release-notes .form-status');
  if (releaseStatus && subscription) {
    releaseStatus.textContent = ({pending:'Check your inbox to confirm.',confirmed:'Subscription confirmed.',removed:'You have been unsubscribed.',invalid:'That subscription link is invalid or expired.'})[subscription] || '';
  }
})();

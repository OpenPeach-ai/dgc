(() => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const heroVideo = document.querySelector('video[data-hero-video]');
  if (heroVideo) {
    if (reduce) heroVideo.pause();
    else {
      const showHeroVideo = () => heroVideo.parentElement?.classList.add('video-ready');
      heroVideo.addEventListener('playing', showHeroVideo, {once:true});
      if (heroVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !heroVideo.paused) requestAnimationFrame(showHeroVideo);
    }
  }

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

  const initialize = () => {
  const header = document.querySelector('[data-site-header]');
  const onScroll = () => header?.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, {passive:true}); requestAnimationFrame(onScroll);

  const alignContainedTarget = () => {
    if (!location.hash) return;
    let target;
    try { target = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch { return; }
    if (!target?.closest('main,footer')) return;
    const align = () => requestAnimationFrame(() => requestAnimationFrame(() => target.scrollIntoView({block:'start', behavior:'instant'})));
    const root = document.documentElement;
    if (root.dataset.stylesReady === 'true') align();
    else {
      addEventListener('dgc:styles-ready', align, {once:true});
      if (root.dataset.stylesFailOpen === 'true') align();
      else addEventListener('dgc:styles-fail-open', align, {once:true});
    }
  };
  alignContainedTarget(); addEventListener('hashchange', alignContainedTarget);

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
    const finalText = `${prefix}${formatCount(target, decimals)}${suffix}`;
    // Keep the measured value stable for assistive technology while only the visual text counts up.
    // Otherwise an off-screen statistic reads as zero until a sighted user happens to scroll to it.
    el.setAttribute('aria-label', finalText);
    const finish = () => { el.textContent = finalText; };
    if (reduce || matchMedia('(max-width:760px)').matches || !('IntersectionObserver' in window)) { finish(); return; }
    const rect = el.getBoundingClientRect();
    if (rect.top < innerHeight && rect.bottom > 0) { finish(); return; }
    el.textContent = `${prefix}${formatCount(0, decimals)}${suffix}`;
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

  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const selector = button.dataset.copyTarget; const source = selector ? document.querySelector(selector) : button.closest('[data-copy-scope]')?.querySelector('code');
    const value = source?.dataset.copy || source?.textContent || '';
    try { await navigator.clipboard.writeText(value.trim()); button.textContent = 'copied'; setTimeout(() => button.textContent = 'copy', 1500); }
    catch { button.textContent = 'select'; }
  }));

  document.querySelectorAll('.spotlight').forEach(card => card.addEventListener('pointermove', event => {
    const rect = card.getBoundingClientRect(); card.style.setProperty('--mx', `${event.clientX - rect.left}px`); card.style.setProperty('--my', `${event.clientY - rect.top}px`);
  }));

  const videos = [...document.querySelectorAll('video[data-lazy-video]')];
  const hydrateVideo = video => {
    const captureStatus = video.closest('.capture-card')?.querySelector('[data-capture-status]');
    const setCaptureStatus = playing => {
      if (!captureStatus) return;
      captureStatus.textContent = playing ? captureStatus.dataset.playing : captureStatus.dataset.paused;
      captureStatus.parentElement?.classList.toggle('is-paused', !playing);
    };
    const mobilePoster = matchMedia('(max-width:1040px)').matches ? video.dataset.posterMobile : '';
    if (mobilePoster || video.dataset.poster) video.poster = mobilePoster || video.dataset.poster;
    delete video.dataset.poster; delete video.dataset.posterMobile;
    video.querySelectorAll('source[data-src]').forEach(source => { source.src = source.dataset.src; source.removeAttribute('data-src'); });
    video.dataset.hydrated = 'true';
    if (reduce) { video.autoplay = false; video.removeAttribute('autoplay'); }
    video.load();
    if (reduce) { video.pause(); setCaptureStatus(false); }
    else video.play().then(() => setCaptureStatus(true)).catch(() => setCaptureStatus(false));
  };
  if ('IntersectionObserver' in window) {
    const vio = new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return; const video = entry.target;
      hydrateVideo(video); vio.unobserve(video);
    // Keep below-fold capture decoding off the critical rendering path. The preview still
    // hydrates and autoplays as soon as it actually enters the viewport.
    }), {rootMargin:'0px'}); videos.forEach(video => vio.observe(video));
  } else videos.forEach(hydrateVideo);

  const images = [...document.querySelectorAll('img[data-lazy-image]')];
  const hydrateImage = image => {
    if (image.dataset.sizes) { image.sizes = image.dataset.sizes; delete image.dataset.sizes; }
    if (image.dataset.srcset) { image.srcset = image.dataset.srcset; delete image.dataset.srcset; }
    if (image.dataset.src) { image.src = image.dataset.src; delete image.dataset.src; }
    image.removeAttribute('data-lazy-image');
  };
  if ('IntersectionObserver' in window) {
    const iio = new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return; const image = entry.target;
      hydrateImage(image); iio.unobserve(image);
    }), {rootMargin:'0px'}); images.forEach(image => iio.observe(image));
  } else images.forEach(hydrateImage);

  document.querySelectorAll('[data-artifact-tabs]').forEach(browser => {
    const tabs = [...browser.querySelectorAll('[role=tab]')]; const panes = [...browser.querySelectorAll('[role=tabpanel]')];
    const address = browser.querySelector('[data-artifact-address]'); const cycle = browser.querySelector('[data-artifact-cycle]');
    let index = 0, paused = false;
    const setPaused = value => {
      paused = value;
      if (!cycle) return;
      cycle.setAttribute('aria-pressed', String(paused)); cycle.textContent = paused ? '▶' : 'Ⅱ';
      cycle.setAttribute('aria-label', paused ? 'Resume automatic artifact views' : 'Pause automatic artifact views');
    };
    const show = next => {
      index = next;
      tabs.forEach((tab,i) => { const selected = i === index; tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1; });
      panes.forEach((pane,i) => pane.hidden = i !== index);
      if (address && tabs[index]?.dataset.address) address.textContent = tabs[index].dataset.address;
    };
    tabs.forEach((tab,tabIndex) => {
      tab.addEventListener('click', () => { setPaused(true); show(tabIndex); });
      tab.addEventListener('keydown', event => {
        const target = event.key === 'ArrowLeft' ? index - 1 : event.key === 'ArrowRight' ? index + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
        if (target === null) return;
        event.preventDefault(); setPaused(true); show((target + tabs.length) % tabs.length); tabs[index].focus();
      });
    });
    cycle?.addEventListener('click', () => setPaused(!paused));
    show(0); setPaused(false);
    if (reduce && cycle) cycle.hidden = true;
    if (!reduce && tabs.length > 1) setInterval(() => {
      if (!paused && !document.hidden && !browser.matches(':hover') && !browser.contains(document.activeElement)) show((index + 1) % tabs.length);
    }, 5200);
  });

  document.querySelectorAll('[data-command-demo]').forEach(card => {
    const output = card.querySelector('[data-command-text]');
    if (!output) return;
    const command = output.dataset.command || output.textContent || '';
    if (reduce) { output.textContent = command; return; }
    output.textContent = ''; card.classList.add('command-ready');
    const type = () => {
      if (card.classList.contains('command-complete') || card.classList.contains('command-typing')) return;
      let cursor = 0; card.classList.add('command-typing');
      const delay = Math.max(22, Math.min(36, Math.floor(840 / Math.max(command.length, 1))));
      const timer = setInterval(() => {
        cursor += 1; output.textContent = command.slice(0, cursor);
        if (cursor >= command.length) { clearInterval(timer); card.classList.remove('command-typing'); card.classList.add('command-complete'); }
      }, delay);
    };
    card.addEventListener('pointerenter', type, {once:true});
    card.addEventListener('focus', type, {once:true});
  });

  document.querySelectorAll('[data-pipeline]').forEach(panel => {
    const stages = [...panel.querySelectorAll('.stage')].sort((left, right) => Number(left.dataset.step) - Number(right.dataset.step));
    const feedback = panel.querySelector('.return-path');
    const state = panel.querySelector('[data-pipeline-state]');
    const byStep = new Map(stages.map(stage => [stage.dataset.step, stage]));
    const sequence = ['01','02','03','04','05','feedback','02','03','04','05','06'];
    panel.dataset.pipelineSequence = sequence.join(',');
    const reset = () => {
      stages.forEach(stage => stage.classList.remove('active'));
      feedback?.classList.remove('active');
    };
    const activate = entry => {
      reset();
      panel.dataset.activeStep = entry;
      if (entry === 'feedback') {
        feedback?.classList.add('active');
        if (state) state.textContent = 'feedback · retry';
        return;
      }
      const stage = byStep.get(entry);
      stage?.classList.add('active');
      if (state) state.textContent = `step ${entry} · ${(stage?.querySelector('b')?.textContent || '').toLowerCase()}`;
    };
    if (reduce || stages.length !== 6) {
      reset(); panel.dataset.activeStep = 'static';
      if (state) state.textContent = 'static overview';
      return;
    }
    let timer = null, index = 0;
    const stop = () => {
      clearInterval(timer); timer = null; index = 0; reset();
      panel.dataset.activeStep = 'idle';
      if (state) state.textContent = 'native route · 6 stages';
    };
    const start = () => {
      if (timer) return;
      activate(sequence[index]);
      timer=setInterval(() => { index=(index+1)%sequence.length; activate(sequence[index]); }, 900);
    };
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(entries => entries.forEach(e => e.isIntersecting ? start() : stop()), {threshold:.3}).observe(panel);
    } else start();
  });

  document.querySelectorAll('dialog[data-capture-dialog]').forEach(capture => {
    const openers = [...document.querySelectorAll(`[data-open-capture="${capture.id}"]`)];
    bindDialog(capture, openers, [...capture.querySelectorAll('[data-close-capture]')]);
    openers.forEach(opener => opener.addEventListener('click', () => {
      const video = capture.querySelector('video[data-capture-video]');
      if (video?.dataset.poster) { video.poster = video.dataset.poster; delete video.dataset.poster; }
      if (video && !video.dataset.hydrated) {
        video.querySelectorAll('source[data-src]').forEach(source => { source.src = source.dataset.src; source.removeAttribute('data-src'); });
        video.dataset.hydrated = 'true'; video.load();
      }
      video?.play().catch(() => {});
    }));
    capture.addEventListener('close', () => capture.querySelector('video[data-capture-video]')?.pause());
  });

  };

  if (document.body.classList.contains('page-home') && !location.hash) {
    const events = ['wheel','touchstart','pointerdown','keydown','dgc:load-styles'];
    let started = false;
    const start = event => {
      if (started) return;
      started = true;
      clearTimeout(timer);
      events.forEach(name => removeEventListener(name, start));
      removeEventListener('click', start, true);
      if (event) initialize();
      else requestAnimationFrame(() => requestAnimationFrame(initialize));
    };
    events.forEach(name => addEventListener(name, start, {once:true,passive:true}));
    addEventListener('click', start, {once:true,passive:true,capture:true});
    const timer = setTimeout(start, 3600);
  } else {
    // Full styles are eager off the landing page. Bind enhancements in the
    // parser-complete task so their first style pass is not deferred past FCP.
    initialize();
  }
})();

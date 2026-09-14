(function(){
  'use strict';
  // ----- copy buttons -----
  Array.prototype.forEach.call(document.querySelectorAll('.copy-btn'), function(btn){
    btn.addEventListener('click', function(){
      var pre = btn.parentElement.querySelector('code');
      var text = pre ? pre.textContent : '';
      var done = function(){ btn.textContent='Copied'; btn.classList.add('done');
        setTimeout(function(){ btn.textContent='Copy'; btn.classList.remove('done'); }, 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
      } else { fallback(); }
      function fallback(){
        try { var ta=document.createElement('textarea'); ta.value=text;
          ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta);
          ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done();
        } catch(e){}
      }
    });
  });

  // ----- sidebar search / filter -----
  // One filter, two fields: the desktop sidebar is hidden on mobile, so the mobile field
  // lives inside the Browse docs dialog beside the list it actually filters.
  var inputs = Array.prototype.slice.call(document.querySelectorAll('[data-docsearch]'));
  var input = document.getElementById('docsearch');
  var links = Array.prototype.slice.call(document.querySelectorAll('.docs-sidebar a[data-title], .docs-menu a[data-title]'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('.docs-sidebar .grp, .docs-menu .grp'));
  function filter(query){
    var q = (query || '').trim().toLowerCase();
    inputs.forEach(function(el){ if (el.value !== query) el.value = query; });
    links.forEach(function(a){
      var hay = (a.getAttribute('data-title') + ' ' + (a.getAttribute('data-desc')||'')).toLowerCase();
      a.style.display = (!q || hay.indexOf(q) !== -1) ? '' : 'none';
    });
    groups.forEach(function(g){
      // recompute: is any visible child present?
      var vis = Array.prototype.some.call(g.querySelectorAll('a[data-title]'), function(a){
        return a.style.display !== 'none';
      });
      g.style.display = vis ? '' : 'none';
    });
  }
  function firstVisible(){
    for (var i=0;i<links.length;i++){ if (links[i].style.display !== 'none') return links[i]; }
    return null;
  }
  inputs.forEach(function(el){
    el.addEventListener('input', function(){ filter(el.value); });
    el.addEventListener('keydown', function(e){
      if (e.key === 'Enter'){ var t = firstVisible(); if (t){ window.location.href = t.getAttribute('href'); } }
      else if (e.key === 'Escape'){ filter(''); el.blur(); }
    });
  });
  // Keep the page you are on visible in a sidebar that scrolls independently.
  // This runs deferred, while the page is still hidden behind the style loader, so every box
  // measures zero until the stylesheet lands. Wait for it, then measure.
  function revealCurrent(){
    var here = document.querySelector('.docs-sidebar a[aria-current=page]');
    if (!here) return;
    var sb = here.closest('.docs-sidebar');
    if (!sb || here.offsetTop + here.offsetHeight <= sb.clientHeight) return;
    // scrollTop, not scrollIntoView(): the latter would scroll the window too.
    sb.scrollTop = here.offsetTop - (sb.clientHeight / 2) + (here.offsetHeight / 2);
  }
  var root = document.documentElement;
  if (root.dataset.stylesReady === 'true' || root.dataset.stylesFailOpen === 'true') revealCurrent();
  else {
    window.addEventListener('dgc:styles-ready', revealCurrent, {once:true});
    window.addEventListener('dgc:styles-fail-open', revealCurrent, {once:true});
  }

  // '/' focuses search (like the DGC composer)
  document.addEventListener('keydown', function(e){
    if (e.key === '/' && input && document.activeElement !== input &&
        !/^(INPUT|TEXTAREA)$/.test((document.activeElement||{}).tagName||'')){
      e.preventDefault(); input.focus();
    }
  });

  // ----- scroll-spy for the on-this-page toc -----
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.docs-toc a[data-id]'));
  if (tocLinks.length){
    var map = {};
    tocLinks.forEach(function(a){ map[a.getAttribute('data-id')] = a; });
    var headings = tocLinks.map(function(a){ return document.getElementById(a.getAttribute('data-id')); })
                           .filter(Boolean);
    var current = null;
    function setActive(id){
      if (current === id) return; current = id;
      tocLinks.forEach(function(a){ a.classList.toggle('active', a.getAttribute('data-id') === id); });
    }
    if ('IntersectionObserver' in window){
      var visible = {};
      var obs = new IntersectionObserver(function(entries){
        entries.forEach(function(en){
          if (en.isIntersecting) visible[en.target.id] = en.boundingClientRect.top;
          else delete visible[en.target.id];
        });
        var ids = Object.keys(visible);
        if (ids.length){
          ids.sort(function(a,b){ return visible[a]-visible[b]; });
          setActive(ids[0]);
        } else {
          // none intersecting: pick the last heading above the viewport top
          var above = headings.filter(function(h){ return h.getBoundingClientRect().top < 120; });
          if (above.length) setActive(above[above.length-1].id);
        }
      }, { rootMargin: '-'+ (60) +'px 0px -70% 0px', threshold: [0,1] });
      // Like revealCurrent(): while the style loader hides the page every heading measures top 0,
      // and the "none intersecting" branch would mark the last heading active. Observe once styled.
      var observe = function(){ headings.forEach(function(h){ obs.observe(h); }); };
      if (root.dataset.stylesReady === 'true' || root.dataset.stylesFailOpen === 'true') observe();
      else {
        window.addEventListener('dgc:styles-ready', observe, {once:true});
        window.addEventListener('dgc:styles-fail-open', observe, {once:true});
      }
    }
  }
})();

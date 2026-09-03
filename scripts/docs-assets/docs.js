(function(){
  'use strict';
  var body = document.body;

  // ----- mobile nav drawer -----
  var menuBtn = document.querySelector('.menu-btn');
  var scrim = document.querySelector('.scrim');
  function closeNav(){ body.classList.remove('nav-open'); }
  if (menuBtn) menuBtn.addEventListener('click', function(){ body.classList.toggle('nav-open'); });
  if (scrim) scrim.addEventListener('click', closeNav);
  Array.prototype.forEach.call(document.querySelectorAll('.sidebar a'), function(a){
    a.addEventListener('click', closeNav);
  });

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
  var input = document.getElementById('docsearch');
  var links = Array.prototype.slice.call(document.querySelectorAll('.sidebar a[data-title]'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('.sidebar .grp'));
  function filter(){
    var q = (input.value || '').trim().toLowerCase();
    links.forEach(function(a){
      var hay = (a.getAttribute('data-title') + ' ' + (a.getAttribute('data-desc')||'')).toLowerCase();
      a.style.display = (!q || hay.indexOf(q) !== -1) ? '' : 'none';
    });
    groups.forEach(function(g){
      var any = g.querySelector('.sidebar a:not([style*="display: none"])');
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
  if (input){
    input.addEventListener('input', filter);
    input.addEventListener('keydown', function(e){
      if (e.key === 'Enter'){ var t = firstVisible(); if (t){ window.location.href = t.getAttribute('href'); } }
      else if (e.key === 'Escape'){ input.value=''; filter(); input.blur(); }
    });
  }
  // '/' focuses search (like the DGC composer)
  document.addEventListener('keydown', function(e){
    if (e.key === '/' && input && document.activeElement !== input &&
        !/^(INPUT|TEXTAREA)$/.test((document.activeElement||{}).tagName||'')){
      e.preventDefault(); input.focus();
    }
  });

  // ----- scroll-spy for the on-this-page toc -----
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a[data-id]'));
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
      headings.forEach(function(h){ obs.observe(h); });
    }
  }
})();

/* =========================================================================
   Xpress — correzione "Sito desktop" su smartphone/pieghevoli (es. Galaxy Fold)

   Problema: quando Chrome Android è in modalità "Sito desktop" (attiva di
   default su molti tablet e pieghevoli, e ereditata anche dalla PWA
   installata) il <meta name="viewport"> viene IGNORATO e la pagina viene
   impaginata su 980px, poi rimpicciolita per stare nello schermo:
   tutto diventa minuscolo e le media query mobile (max-width: 720px) non
   scattano mai.

   Soluzione: se la larghezza di impaginazione è molto più grande dello
   schermo reale (e il dispositivo è touch), si:
     1) ingrandisce la pagina con `zoom` così che 1px CSS ≈ 1px reale;
     2) riscrivono le media query sulla larghezza (min/max-width) in base
        alla larghezza REALE dello schermo, così la vista a schede torna.
   Su PC e su telefoni in modalità normale non cambia nulla.
   ========================================================================= */
(function () {
  'use strict';

  var root = document.documentElement;
  var original = new WeakMap();   // CSSMediaRule -> mediaText originale
  var applied = 0;                // zoom attualmente applicato (0 = nessuno)
  var printing = false;           // durante la stampa la correzione è sospesa

  // Rete di sicurezza: in stampa lo zoom non deve MAI essere applicato
  // (altrimenti foto e testo escono ingranditi e tagliati sul foglio A4).
  try {
    var st = document.createElement('style');
    st.textContent = '@media print{html{zoom:1 !important}}';
    (document.head || root).appendChild(st);
  } catch (_) {}

  function realScreenWidth() {
    var w = (window.screen && screen.width) || 0;
    var h = (window.screen && screen.height) || 0;
    // alcuni Android non ruotano screen.width: usa l'orientamento attuale
    var landscape = window.matchMedia && matchMedia('(orientation: landscape)').matches;
    if (w && h) w = landscape ? Math.max(w, h) : Math.min(w, h);
    var ow = window.outerWidth || 0;
    // in split-screen la finestra può essere più stretta dello schermo
    if (ow > 0 && ow < w) w = ow;
    return w;
  }

  function layoutWidth() {
    // misura senza lo zoom eventualmente già applicato
    var prev = root.style.zoom;
    if (prev) root.style.zoom = '';
    var lw = root.clientWidth || window.innerWidth || 0;
    if (prev) root.style.zoom = prev;
    return lw;
  }

  function isTouch() {
    return (window.matchMedia && matchMedia('(pointer: coarse)').matches) ||
           (navigator.maxTouchPoints || 0) > 0;
  }

  // Riscrive (min-width: Npx) / (max-width: Npx) come condizioni vere/false
  // calcolate sulla larghezza effettiva `eff`. Con eff = 0 ripristina l'originale.
  var FEATURE = /\(\s*(min|max)-width\s*:\s*([\d.]+)px\s*\)/gi;
  var TRUE_Q = '(min-width: 0px)';
  var FALSE_Q = '(max-width: 0px)';

  function rewriteRules(rules, eff) {
    if (!rules) return;
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.type === 4 /* CSSRule.MEDIA_RULE */ && r.media) {
        if (!original.has(r)) original.set(r, r.media.mediaText);
        var src = original.get(r);
        if (FEATURE.test(src)) {
          FEATURE.lastIndex = 0;
          var txt = eff
            ? src.replace(FEATURE, function (_, kind, n) {
                n = parseFloat(n);
                var ok = kind.toLowerCase() === 'max' ? eff <= n : eff >= n;
                return ok ? TRUE_Q : FALSE_Q;
              })
            : src;
          if (r.media.mediaText !== txt) r.media.mediaText = txt;
        }
        FEATURE.lastIndex = 0;
      }
      if (r.cssRules) rewriteRules(r.cssRules, eff);
    }
  }

  function rewriteAll(eff) {
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      var rules = null;
      try { rules = sheets[i].cssRules; } catch (_) { continue; }
      rewriteRules(rules, eff);
    }
  }

  function update() {
    if (printing) return;
    var sw = realScreenWidth();
    var lw = layoutWidth();
    var forced = isTouch() && sw > 0 && lw >= 900 && sw < lw * 0.85;

    if (forced) {
      var z = Math.round((lw / sw) * 1000) / 1000;
      if (z !== applied) {
        root.style.zoom = String(z);
        root.classList.add('xp-forced-desktop');
        applied = z;
      }
      rewriteAll(sw);
    } else if (applied) {
      root.style.zoom = '';
      root.classList.remove('xp-forced-desktop');
      applied = 0;
      rewriteAll(0);
    }
  }

  // Stampa: toglie zoom e media query riscritte, le rimette al termine
  function beforePrint() {
    printing = true;
    root.style.zoom = '';
    root.classList.remove('xp-forced-desktop');
    applied = 0;
    rewriteAll(0);
  }
  function afterPrint() {
    if (!printing) return;
    printing = false;
    update();
  }
  window.addEventListener('beforeprint', beforePrint);
  window.addEventListener('afterprint', afterPrint);
  if (window.matchMedia) {
    var mqp = matchMedia('print');
    var onMq = function (e) { if (e.matches) beforePrint(); else afterPrint(); };
    if (mqp.addEventListener) mqp.addEventListener('change', onMq);
    else if (mqp.addListener) mqp.addListener(onMq);
  }

  var t = 0;
  function schedule() { clearTimeout(t); t = setTimeout(update, 120); }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', update);
  } else {
    update();
  }
  window.addEventListener('load', update);
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);

  // utile per test/diagnosi
  window.__xpDesktopFix = { update: update, beforePrint: beforePrint, afterPrint: afterPrint, state: function () {
    return { zoom: applied, screen: realScreenWidth(), layout: layoutWidth() };
  } };
})();

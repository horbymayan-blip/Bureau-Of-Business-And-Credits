/* Bureau Portal — global helpers: auto theme class + bulletproof poster fallback. */
(function () {
  'use strict';
  var FALLBACK = '/assets/movie-poster-fallback.svg';
  function markBody() {
    try {
      // Keep each page's original palette: only add the cinematic top-bar edge.
      var header = document.querySelector('header, .topbar, .top, .bm-nav');
      if (header && !header.classList.contains('bm-cine-bar')) header.classList.add('bm-cine-bar');
    } catch (e) {}
  }
  try {
    if (document.body) markBody();
    document.addEventListener('DOMContentLoaded', markBody);
    // Capture-phase: any broken poster/image anywhere falls back to the BureauMovies card — never a dark hole.
    document.addEventListener('error', function (event) {
      var target = event && event.target;
      if (target && target.tagName === 'IMG' && !target.dataset.bmfb) {
        target.dataset.bmfb = '1';
        try { target.src = FALLBACK; } catch (e) {}
      }
    }, true);
  } catch (e) {}
})();

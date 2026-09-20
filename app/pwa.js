/* pwa.js — shared by both front doors (index.html the simulator, field.html
   the pilot app, D-A877 step 1): the version stamp in the header and the
   service worker registration. The worker runs on the hosted build only —
   never on localhost (a cached shell would hide edits) nor from file://. */
(function () {
  'use strict';
  fetch('version.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (v) {
    var el = document.getElementById('ver');
    if (v && el) el.textContent = 'v' + v.version + (v.build ? ' · ' + v.build.split('+')[1] : '');
  }).catch(function () {});
  if (!('serviceWorker' in navigator) || location.protocol === 'file:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return;
  navigator.serviceWorker.register('sw.js').catch(function () {});
  navigator.serviceWorker.addEventListener('message', function (ev) {
    if (!ev.data || ev.data.type !== 'asi-updated') return;
    var n = document.getElementById('update-note');
    if (!n) return;
    n.textContent = 'UPDATED · build ' + ev.data.build + ' · reopen to use it';
    n.hidden = false;
    setTimeout(function () { n.hidden = true; }, 12000);
  });
})();

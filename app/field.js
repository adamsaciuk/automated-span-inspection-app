/* field.js — the pilot app (S-0042). Steps 1, 3 and 4: the tab shell,
   IMPORT of bundles into FIELDDB, the CIRCUITS list (tick to show,
   progress, REMOVE), the one SEARCH box across circuit names, tower names
   and span numbers (SEARCH), the SPANS list with each span's mission state,
   and the MISSIONS of a span from the database. Completion (step 6) fills
   app.progress; until then every span reads not flown. Nothing here
   touches the simulator. */
(function (root) {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var app = { tab: 'circuits', prefs: {}, circuits: [], shown: {}, index: null, progress: {}, q: '', hits: [] };
  try { app.prefs = JSON.parse(localStorage.getItem('asi.field.v1') || '{}'); } catch (e) { app.prefs = {}; }
  function savePrefs() { try { localStorage.setItem('asi.field.v1', JSON.stringify(app.prefs)); } catch (e) {} }
  app.shown = app.prefs.shown || {};
  function fmtN(n) { return (n || 0).toLocaleString(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var ROW_CAP = 600;   /* rows on a screen at once; search narrows the rest */

  /* ---- tabs ---- */
  var TABS = ['circuits', 'spans', 'missions', 'preview', 'admin'];
  function showTab(name) {
    if (TABS.indexOf(name) < 0) name = 'circuits';
    app.tab = name; app.prefs.tab = name; savePrefs();
    var searching = !!app.q;
    TABS.forEach(function (t) { $('tab-' + t).classList.toggle('on', t === name); $('screen-' + t).hidden = searching || t !== name; });
    $('screen-search').hidden = !searching;
    if (name === 'spans') renderSpans();
    if (name === 'missions') renderMissions();
  }
  TABS.forEach(function (t) { $('tab-' + t).onclick = function () { clearSearch(); showTab(t); }; });

  /* ---- progress (step 6 fills app.progress[circuitId] = { done, bySpan: { i: [codes done] } }) ---- */
  function progressOf(c) { var p = app.progress[c.id]; return { done: p ? p.done || 0 : 0, total: c.missionCount }; }
  function doneCodes(c, i) { var p = app.progress[c.id]; return p && p.bySpan && p.bySpan[i] ? p.bySpan[i] : []; }
  function codeMarks(c, i) {
    var done = doneCodes(c, i);
    return (c.bySpan[i] || []).map(function (k) { return '<i class="cd' + (done.indexOf(k) >= 0 ? ' done' : '') + '">' + esc(k) + '</i>'; }).join(' ');
  }
  function spanState(c, i) {
    var codes = c.bySpan[i] || [], d = doneCodes(c, i).length;
    if (!codes.length) return { cls: 'none', text: 'no missions' };
    if (d >= codes.length) return { cls: 'done', text: 'COMPLETE' };
    if (d > 0) return { cls: 'part', text: d + ' of ' + codes.length };
    return { cls: 'todo', text: 'not flown' };
  }

  /* ---- circuits ---- */
  function shownCircuits() { return app.circuits.filter(function (c) { return app.shown[c.id]; }); }
  function circuitById(id) { return app.circuits.filter(function (x) { return x.id === id; })[0]; }
  function counts() {
    var sh = shownCircuits();
    $('n-circuits').textContent = fmtN(app.circuits.length);
    $('n-spans').textContent = fmtN(sh.reduce(function (s, c) { return s + c.spansWithMissions; }, 0));
    $('n-missions').textContent = fmtN(sh.reduce(function (s, c) { return s + c.missionCount; }, 0));
  }
  async function loadCircuits() {
    var t0 = performance.now();
    app.circuits = await FIELDDB.listCircuits();
    /* a circuit just imported is shown unless the pilot has un-ticked it */
    app.circuits.forEach(function (c) { if (app.shown[c.id] == null) app.shown[c.id] = true; });
    app.index = SEARCH.index(app.circuits);
    app.indexMs = performance.now() - t0;
    renderCircuits(); counts();
    if (app.q) renderSearch();
  }
  function renderCircuits() {
    var host = $('circuit-list');
    if (!app.circuits.length) { host.innerHTML = '<div class="empty"><b>NO CIRCUITS INSTALLED</b>Import a bundle (a <i>.asi.json</i> file from the converter) to begin. Tick a circuit to show it; several can be shown at once.</div>'; return; }
    host.innerHTML = app.circuits.map(function (c) {
      var p = progressOf(c), pct = p.total ? Math.round(p.done / p.total * 100) : 0;
      return '<div class="crow" data-id="' + esc(c.id) + '">' +
        '<label class="tick"><input type="checkbox"' + (app.shown[c.id] ? ' checked' : '') + '></label>' +
        '<div class="body"><div class="name">' + esc(c.name) + '</div>' +
        '<div class="d">' + fmtN(c.towers.length) + ' towers · ' + fmtN(c.towers.length - 1) + ' spans · ' + fmtN(c.spansWithMissions) + ' with missions · ' + fmtN(c.missionCount) + ' missions · ' + c.lengthKm + ' km' +
        (c.codes.length ? ' · passes ' + c.codes.join(' ') : '') + (c.unplaced.length ? ' · <span class="warn">' + c.unplaced.length + ' unplaced</span>' : '') + '</div>' +
        '<div class="d mute">imported ' + esc(c.importedAt.slice(0, 16).replace('T', ' ')) + (c.builtAt ? ' · built ' + esc(c.builtAt.slice(0, 16).replace('T', ' ')) : '') + (c.generator ? ' · ' + esc(c.generator) : '') + '</div></div>' +
        '<div class="prog"><div class="pct">' + pct + '%</div><div class="bar"><i style="width:' + pct + '%"></i></div><div class="d mute">' + fmtN(p.done) + ' of ' + fmtN(p.total) + '</div></div>' +
        '<button class="rm" title="remove this circuit and its missions from the tablet">REMOVE</button></div>';
    }).join('');
    host.querySelectorAll('.crow').forEach(function (row) {
      var id = row.dataset.id;
      row.querySelector('input').onchange = function () { app.shown[id] = this.checked; app.prefs.shown = app.shown; savePrefs(); counts(); };
      row.querySelector('.rm').onclick = async function () {
        var c = circuitById(id);
        if (!window.confirm('Remove ' + c.name + ' and its ' + fmtN(c.missionCount) + ' missions from this tablet? Completions are kept.')) return;
        await FIELDDB.removeCircuit(id); delete app.shown[id]; app.prefs.shown = app.shown; savePrefs();
        await loadCircuits(); note('removed ' + c.name);
      };
    });
  }
  function note(msg, err) { var n = $('import-note'); n.textContent = msg; n.classList.toggle('err', !!err); n.hidden = false; }

  /* ---- import ---- */
  $('btn-import').onclick = function () { $('file-bundle').click(); };
  $('file-bundle').onchange = async function () {
    var files = Array.from(this.files || []); this.value = '';
    for (var i = 0; i < files.length; i++) {
      var f = files[i], t0 = performance.now();
      try {
        note('reading ' + f.name + ' (' + Math.round(f.size / 1024) + ' KB)…');
        var text = await f.text();
        var bundle = JSON.parse(text); text = null;
        var rec = await FIELDDB.importBundle(bundle, function (done, total) { note('importing ' + f.name + ': ' + fmtN(done) + ' of ' + fmtN(total) + ' missions'); });
        bundle = null;
        app.shown[rec.id] = true; app.prefs.shown = app.shown; savePrefs();
        note('imported ' + rec.name + ': ' + fmtN(rec.missionCount) + ' missions on ' + fmtN(rec.spansWithMissions) + ' spans in ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s' + (rec.warnings.length ? ' · ' + rec.warnings.join('; ') : ''));
      } catch (e) { note(f.name + ': ' + e.message, true); }
    }
    await loadCircuits();
  };

  /* ---- search: one box, every circuit, whether ticked or not ---- */
  function spanRow(c, i, extra) {
    var a = c.towers[i], b = c.towers[i + 1], st = spanState(c, i);
    return '<div class="srow ' + st.cls + '" data-c="' + esc(c.id) + '" data-i="' + i + '"><span class="no">' + (i + 1) + '</span>' +
      '<span class="tw">' + esc(a.name) + ' → ' + esc(b.name) + (extra ? '<span class="d mute"> · ' + esc(extra) + '</span>' : '') + '</span>' +
      '<span class="codes">' + codeMarks(c, i) + '</span><span class="state">' + st.text + '</span></div>';
  }
  function bindSpanRows(host) {
    host.querySelectorAll('.srow').forEach(function (row) { row.onclick = function () { openSpan(row.dataset.c, Number(row.dataset.i)); }; });
  }
  function openSpan(circuitId, i) {
    var c = circuitById(circuitId); if (!c) return;
    if (!app.shown[c.id]) { app.shown[c.id] = true; app.prefs.shown = app.shown; savePrefs(); renderCircuits(); counts(); }
    app.sel = { circuit: c.id, span: i };
    clearSearch();
    showTab('missions');
  }
  function openHit(h) {
    if (!h) return;
    if (h.kind === 'span') { openSpan(h.c.id, h.span); return; }
    if (!app.shown[h.c.id]) { app.shown[h.c.id] = true; app.prefs.shown = app.shown; savePrefs(); renderCircuits(); counts(); }
    app.spansOnly = h.c.id;
    clearSearch();
    showTab('spans');
  }
  function renderSearch() {
    var host = $('search-list'), t0 = performance.now();
    var hits = SEARCH.find(app.index, app.q, 60, app.shown);
    app.hits = hits; app.searchMs = performance.now() - t0;
    if (!hits.length) { host.innerHTML = '<div class="empty"><b>NOTHING MATCHES ' + esc(app.q.toUpperCase()) + '</b>Circuit names, tower names and span numbers are searched, across every installed circuit.</div>'; return; }
    var html = '', last = null;
    hits.forEach(function (h) {
      if (h.kind === 'circuit') { html += '<div class="srow circ" data-circ="' + esc(h.c.id) + '"><span class="no">⌁</span><span class="tw">' + esc(h.c.name) + '</span><span class="codes">' + fmtN(h.c.towers.length - 1) + ' spans</span><span class="state">' + fmtN(h.c.missionCount) + ' missions</span></div>'; return; }
      if (h.c !== last) { html += '<div class="grp">' + esc(h.c.name) + (app.shown[h.c.id] ? '' : ' <span class="mute">· not shown</span>') + '</div>'; last = h.c; }
      html += spanRow(h.c, h.span, h.why);
    });
    html += '<div class="d mute" style="padding:8px">' + hits.length + ' hit' + (hits.length > 1 ? 's' : '') + ' in ' + app.searchMs.toFixed(1) + ' ms · ENTER opens the first</div>';
    host.innerHTML = html;
    host.querySelectorAll('.srow.circ').forEach(function (row) { row.onclick = function () { openHit({ kind: 'circuit', c: circuitById(row.dataset.circ) }); }; });
    bindSpanRows(host);
  }
  function setQuery(q) {
    app.q = String(q || '').trim();
    $('q-clear').hidden = !app.q;
    showTab(app.tab);
    if (app.q) renderSearch();
  }
  function clearSearch() { $('q').value = ''; app.q = ''; $('q-clear').hidden = true; }
  $('q').oninput = function () { setQuery(this.value); };
  $('q').onkeydown = function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); if (app.q && app.hits.length) openHit(app.hits[0]); }
    if (ev.key === 'Escape') { clearSearch(); showTab(app.tab); }
  };
  $('q-clear').onclick = function () { clearSearch(); showTab(app.tab); $('q').focus(); };

  /* ---- spans: the shown circuits' spans that carry missions (ALL SPANS shows every one) ---- */
  function renderSpans() {
    var host = $('span-list'), sh = shownCircuits();
    if (app.spansOnly) { var only = circuitById(app.spansOnly); sh = only ? [only] : sh; }
    $('btn-allspans').classList.toggle('on', !!app.prefs.allSpans);
    $('btn-onecirc').hidden = !app.spansOnly;
    if (app.spansOnly) $('btn-onecirc').textContent = 'ALL SHOWN CIRCUITS';
    if (!sh.length) { host.innerHTML = '<div class="empty"><b>NO CIRCUIT SHOWN</b>Tick a circuit on the CIRCUITS screen, or search.</div>'; return; }
    var html = '', rows = 0, left = 0;
    sh.forEach(function (c) {
      var spans = app.prefs.allSpans ? c.towers.slice(0, -1).map(function (_, i) { return i; }) : Object.keys(c.bySpan).map(Number).sort(function (a, b) { return a - b; });
      html += '<div class="grp">' + esc(c.name) + ' · ' + fmtN(spans.length) + (app.prefs.allSpans ? ' spans' : ' spans with missions') + '</div>';
      var room = Math.max(0, ROW_CAP - rows), take = spans.slice(0, room);
      html += take.map(function (i) { return spanRow(c, i); }).join('');
      rows += take.length; left += spans.length - take.length;
    });
    if (left) html += '<div class="d mute" style="padding:8px">' + fmtN(left) + ' more · search a tower name or span number to reach them</div>';
    host.innerHTML = html;
    bindSpanRows(host);
  }
  $('btn-allspans').onclick = function () { app.prefs.allSpans = !app.prefs.allSpans; savePrefs(); renderSpans(); };
  $('btn-onecirc').onclick = function () { app.spansOnly = null; renderSpans(); };

  /* ---- missions of the chosen span ---- */
  async function renderMissions() {
    var host = $('mission-list'); if (!app.sel) { host.innerHTML = '<div class="empty"><b>NO SPAN CHOSEN</b>Pick a span on the SPANS screen, or search a tower name.</div>'; return; }
    var c = circuitById(app.sel.circuit); if (!c) return;
    var ms = await FIELDDB.missionsForSpan(c.id, app.sel.span);
    var a = c.towers[app.sel.span], b = c.towers[app.sel.span + 1], st = spanState(c, app.sel.span);
    host.innerHTML = '<div class="grp">' + esc(c.name) + ' · span ' + (app.sel.span + 1) + ' · ' + esc(a.name) + ' → ' + esc(b.name) + ' · <span class="st ' + st.cls + '">' + st.text + '</span></div>' +
      ms.map(function (m) {
        return '<div class="mrow2"><span class="code ' + m.dir + '">' + esc(m.code) + '</span><span class="body"><span class="file">' + esc(m.id) + '</span><br><span class="d">' + esc(m.a) + ' → ' + esc(m.b) + ' · ' + m.wps.length + ' wp · ' + m.photos + ' photos · ' + (m.aircraft || '') + (m.camera ? ' · ' + m.camera : '') + '</span></span><span class="acts"><button class="sm" disabled>PREVIEW</button><button class="sm" disabled>DONE</button></span></div>';
      }).join('') + '<div class="d mute" style="margin-top:8px">PREVIEW and DONE come in steps 5 and 6.</div>';
  }

  root.FIELD = app;
  app.showTab = showTab; app.reload = loadCircuits; app.renderMissions = renderMissions; app.setQuery = setQuery; app.openSpan = openSpan; app.renderSpans = renderSpans;
  showTab(app.prefs.tab || 'circuits');
  loadCircuits().catch(function (e) { note('database: ' + e.message, true); });
})(window);

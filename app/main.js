/* main.js — application wiring: the panel, the stage, the clock and the
   transport. One state object; everything on screen derives from it. */
(function (root) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var app = {
    circuit: null, group: null, focus: -1, sel: [], launch: null, plan: null,
    playing: false, rate: 4, lastFrame: 0, pose: null,
    prefs: { rate: 4, fpv: true, scale: 3, over: 30, vt: 5, vc: 3,
      cam: { body: 'gs120', pitchUm: 3.45, focal: 80, fnum: 18, focusM: 19.5, cocPx: 1, gsdMm: 1.0, sensorW: 44.05, sensorH: 32.9 } },
    focusReport: null
  };
  root.ASI = app;

  /* ---- prefs -------------------------------------------------------------- */
  try {
    var saved = JSON.parse(localStorage.getItem('asi.prefs.v1') || '{}');
    var savedCam = Object.assign({}, app.prefs.cam, saved.cam || {});
    Object.assign(app.prefs, saved);
    app.prefs.cam = savedCam;
  } catch (e) {}
  function savePrefs() { if (app.wiped) return; try { localStorage.setItem('asi.prefs.v1', JSON.stringify(app.prefs)); } catch (e) {} }

  /* ---- stage -------------------------------------------------------------- */
  var canvas = $('gl');
  STAGE.init(canvas);
  function fit() {
    var r = canvas.parentElement.getBoundingClientRect();
    STAGE.setSize(Math.max(200, r.width), Math.max(200, r.height));
    STAGE.render();
  }
  window.addEventListener('resize', fit);
  fit();

  function status(s) { $('status').textContent = s; }
  function fmt(n, d) { return n == null || isNaN(n) ? '–' : Number(n).toFixed(d == null ? 1 : d); }
  function mmss(s) { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); }
  var DRONES = { 60: 'M300 RTK', 67: 'M30', 77: 'M3E', 89: 'M350 RTK', 91: 'M3T', 99: 'M3D', 100: 'M4E', 103: 'M400' };

  /* ---- loading ------------------------------------------------------------ */
  async function readFile(input) {
    var f = input.files && input.files[0];
    if (!f) return null;
    var buf = await f.arrayBuffer();
    input.value = '';
    return { buf: buf, name: f.name };
  }
  /* ---- keeping your place ----------------------------------------------------
     The working span is the anchor: everything loaded is remembered against
     it, and a refresh comes back to it. */
  function spanKey(i) { return app.circuit ? app.circuit.towers[i].name + ' > ' + app.circuit.towers[i + 1].name : null; }
  function work() { app.prefs.work = app.prefs.work || {}; return app.prefs.work; }
  function rememberPlace() {
    if (app.focus < 0) return;
    var w = work();
    w.span = spanKey(app.focus);
    w.bySpan = w.bySpan || {};
    w.bySpan[w.span] = { sel: app.sel.slice(), launch: app.launch, annos: app.annos || [] };
    savePrefs();
  }
  function recallPlace(i) {
    var w = work(), k = spanKey(i);
    var saved = w.bySpan && w.bySpan[k];
    app.sel = saved && saved.sel ? saved.sel.slice() : [];
    app.launch = saved && saved.launch ? saved.launch : null;
    app.annos = saved && saved.annos ? saved.annos.slice() : [];
  }
  function spanIndexOfKey(k) {
    if (!app.circuit || !k) return -1;
    for (var i = 0; i < app.circuit.towers.length - 1; i++) if (spanKey(i) === k) return i;
    return -1;
  }

  /* ---- circuits (D-A894): every loaded circuit is kept in this browser and
     listed; one is SELECTED — shown in the scene, the map flown to it, its
     spans listed with the loaded missions that land on them. The missions
     are one pool: selecting a circuit places them on its spans afresh. */
  app.circuits = [];   /* [{ name, file, c }] in load order */
  function circuitKey(name) { return 'circuit:' + name; }
  function escH(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }
  async function parseCircuit(buf, name) {
    var c = await KMZ.loadCircuit(buf, name);
    if (!c.towers.length) throw new Error('No tower placemarks found.');
    /* conductor geometry keyed by consecutive tower pair, when the source has it */
    GEO.project(c);
    c.phasesByKey = {};
    c.spans.forEach(function (s) { c.phasesByKey[s.a + ' > ' + s.b] = s.phases; });
    c.km = 0;
    for (var i = 1; i < c.towers.length; i++) c.km += GEO.dist2(c.towers[i - 1], c.towers[i]);
    return c;
  }
  async function addCircuit(buf, name, opts) {
    opts = opts || {};
    status('READING CIRCUIT…');
    $('circuit-err').hidden = true;
    try {
      var c = await parseCircuit(buf, name);
      var key = circuitKey(c.name);
      if (!opts.restoring) STORE.put(key, name || c.name, buf.slice(0));
      else if (opts.key && opts.key !== key) { STORE.put(key, name || c.name, buf.slice(0)); STORE.del(opts.key); }
      var at = -1;
      app.circuits.forEach(function (e, i) { if (e.name === c.name) at = i; });
      var entry = { name: c.name, file: name || '', c: c };
      if (at >= 0) app.circuits[at] = entry; else app.circuits.push(entry);
      renderCircuits();
      if (opts.select !== false) selectCircuit(c.name);
      return entry;
    } catch (e) {
      $('circuit-err').textContent = (name ? name + ': ' : '') + e.message; $('circuit-err').hidden = false;
      status('CIRCUIT FAILED');
      return null;
    }
  }
  function selectCircuit(name) {
    var entry = null;
    app.circuits.forEach(function (e) { if (e.name === name) entry = e; });
    if (!entry) return;
    var c = entry.c;
    if (app.circuit === c) { if (MAP.ready()) MAP.setCircuit(c); renderCircuits(); return; }
    stopPlay();
    app.prefs.circuit = name; savePrefs();
    app.circuit = c;
    app.focus = -1; app.launch = null; app.plan = null;
    STAGE.setCircuit(c);
    STAGE.setLaunch(null);
    if (MAP.ready()) MAP.setCircuit(c);       /* the map flies to the circuit */
    if (app.group) { GEO.projectGroup(app.group, c.frame); placeByPosition(app.group); STAGE.setGroup(app.group); }
    renderCircuits();
    renderSpans();
    /* back to the working span if this circuit has it, else the first
       span that has missions, else the first span */
    var back = spanIndexOfKey(work().span);
    var first = back >= 0 ? back : firstMissionSpan();
    focusSpan(first >= 0 ? first : 0);
    status(c.name.toUpperCase() + (app.group ? ' · ' + app.group.name.toUpperCase() : ''));
  }
  function renderCircuits() {
    var host = $('circuit-list');
    host.innerHTML = '';
    $('circuit-n').textContent = app.circuits.length ? app.circuits.length + (app.circuits.length > 1 ? ' CIRCUITS' : ' CIRCUIT') : '';
    app.circuits.forEach(function (e) {
      var c = e.c, it = document.createElement('div');
      it.className = 'it' + (app.circuit === c ? ' on' : '');
      it.innerHTML = '<span class="k">' + (c.towers.length - 1) + '</span><span class="t">' + escH(c.name) + '</span><span class="s">' + (c.km / 1000).toFixed(1) + ' km</span><button class="x" title="remove this circuit from the tool">×</button>';
      it.onclick = function () { selectCircuit(e.name); };
      it.querySelector('.x').onclick = function (ev) { ev.stopPropagation(); removeCircuit(e.name); };
      host.appendChild(it);
    });
  }
  function removeCircuit(name) {
    if (!window.confirm('Remove ' + name + ' from the tool? Its datasets in this browser are kept.')) return;
    app.circuits = app.circuits.filter(function (e) { return e.name !== name; });
    STORE.del(circuitKey(name));
    if (app.circuit && app.circuit.name === name) {
      stopPlay();
      app.circuit = null; app.focus = -1; app.launch = null; app.plan = null;
      STAGE.setCircuit(null); if (MAP.ready()) MAP.setCircuit(null);
      renderSpans(); renderMissions(); renderLaunch(); STAGE.render();
      if (app.circuits.length) selectCircuit(app.circuits[app.circuits.length - 1].name); else status('LOAD A CIRCUIT');
    }
    renderCircuits();
  }
  async function loadCircuit(buf, name, opts) { return addCircuit(buf, name, opts); }
  /* every load ADDS to the missions already in (D-A857, the files arrive mixed
     up and it takes a few picks to get them all): a file name loaded again
     replaces its earlier copy; the sources are cached as a list so a refresh
     restores every one; CLEAR forgets them all */
  app.sources = [];
  async function loadGroup(buf, name, opts) {
    status('READING MISSIONS…');
    try {
      var g = buf && buf.files ? await KMZ.loadMissionFiles(buf.files, name) : await KMZ.loadMissionGroup(buf, name);
      if (!g.missions.length) throw new Error('No DJI waylines (wpmz/waylines.wpml) found.');
      if (!(opts && opts.restoring)) {
        app.sources.push({ name: name || 'group', payload: buf && buf.files ? buf : buf.slice(0) });
        STORE.put('group', 'sources', { sources: app.sources });
      }
      var old = app.group;
      if (old) {
        var fresh = {};
        g.missions.forEach(function (m) { fresh[m.file] = 1; });
        var kept = old.missions.concat(old.removed || []).filter(function (m) { return !fresh[m.file]; });
        g.missions = kept.concat(g.missions);
        g.skipped = (old.skipped || []).concat(g.skipped);
        g.name = app.sources.length > 1 ? app.sources.length + ' loads' : g.name;
      }
      /* gimbal test missions are ignored (D-A866): only A1 A2 B1 B2 are proved */
      g.checksIgnored = g.missions.filter(function (m) { return m.kind === 'check'; }).length;
      /* the same pass (span + code) from several files: kept, counted, shown ×n */
      var seenPass = {}; g.dups = 0;
      g.missions.forEach(function (m) { if (m.kind !== 'span') return; var k = normName(m.a) + '>' + normName(m.b) + ':' + m.code; if (seenPass[k]) g.dups++; seenPass[k] = 1; });
      g.missions = g.missions.filter(function (m) { return m.kind !== 'check'; });
      if (!g.missions.length) throw new Error('Only gimbal test missions in there — nothing to prove.');
      /* missions Adam deleted (D-A854) stay out, by name, until restored */
      var gone = app.prefs.deletedMissions || [];
      g.removed = g.missions.filter(function (m) { return gone.indexOf(m.name) >= 0; });
      g.missions = g.missions.filter(function (m) { return gone.indexOf(m.name) < 0; });
      if (!g.missions.length && g.removed.length) { g.missions = g.removed; g.removed = []; app.prefs.deletedMissions = []; savePrefs(); }
      app.group = g;
      if (app.circuit) { GEO.projectGroup(g, app.circuit.frame); placeByPosition(g); }
      STAGE.setGroup(g);
      var drone = g.missions[0].cfg.droneEnum;
      var spansN = {};
      g.missions.forEach(function (m) { if (m.kind === 'span') spansN[m.a + '>' + m.b] = 1; });
      $('group-n').textContent = g.missions.length + ' MISSIONS';
      g.metaN = g.missions.length;
      var bodyKey = null;
      g.missions.forEach(function (m) { bodyKey = bodyKey || CAMERA.bodyFromName(m.file + ' ' + (m.folder || '') + ' ' + (name || '')); });
      var bodyNote = '';
      if (bodyKey && bodyKey !== app.prefs.cam.body) { setCameraBody(bodyKey, true); bodyNote = '<br>camera set to ' + CAMERA.BODIES[bodyKey].name + ' from the file names'; }
      else if (bodyKey) bodyNote = '<br>planned for the ' + CAMERA.BODIES[bodyKey].name;
      void bodyNote;
      $('group-meta').innerHTML = g.missions.length + ' missions · ' + Object.keys(spansN).length + ' span legs' +
        (drone != null ? ' · ' + (DRONES[drone] || 'enum ' + drone) : '') + (bodyKey ? ' · ' + CAMERA.BODIES[bodyKey].name : '') +
        (g.dups ? '<br><span class="warn">' + g.dups + ' pass' + (g.dups > 1 ? 'es' : '') + ' loaded from more than one file (×n in the span list, every file on the span\'s rows)</span>' : '') +
        (g.unplaced ? '<br><span class="err">' + g.unplaced + ' not near any span of this circuit</span>' : '') +
        (g.skipped.length ? '<br><span class="err">skipped ' + g.skipped.length + '</span>' : '');
      app.plan = null;
      renderSpans();
      syncMap(false);
      if (app.circuit) {
        /* stay on the working span when it has missions from this group */
        var stay = app.focus >= 0 && missionsForPair(app.focus).length;
        var first = stay ? app.focus : firstMissionSpan();
        if (first >= 0) focusSpan(first); else renderMissions();
      }
      status((app.circuit ? app.circuit.name.toUpperCase() + ' · ' : '') + g.name.toUpperCase());
    } catch (e) {
      $('group-meta').innerHTML = '<span class="err">' + e.message + '</span>';
      status('MISSIONS FAILED');
    }
  }

  $('btn-circuit').onclick = function () { $('file-circuit').click(); };
  $('file-circuit').onchange = async function () { var f = await readFile(this); if (f) loadCircuit(f.buf, f.name); };
  $('btn-group').onclick = function () { $('file-group').click(); };
  $('btn-folder').onclick = function () { $('file-folder').click(); };
  $('btn-group-clear').onclick = function () {
    if (!app.group) return;
    if (!window.confirm('Forget every loaded mission? The circuit stays.')) return;
    stopPlay();
    app.group = null; app.sources = []; app.sel = []; app.plan = null; FLY.load(null);
    STORE.put('group', 'sources', { sources: [] });
    STAGE.setGroup(null);
    $('group-n').textContent = '';
    $('group-meta').textContent = '';
    $('mission-deleted').hidden = true;
    renderSpans(); renderMissions(); rememberPlace(); renderPlan(); STAGE.render();
    status(app.circuit ? app.circuit.name.toUpperCase() : 'LOAD A CIRCUIT');
  };
  $('file-folder').onchange = async function () {
    var list = Array.from(this.files || []).filter(function (f) { return /\.(kmz|zip|wpml|kml)$/i.test(f.name); });
    var files = [];
    for (var i = 0; i < list.length; i++) files.push({ path: list[i].webkitRelativePath || list[i].name, buf: await list[i].arrayBuffer() });
    var root = ((list[0] && list[0].webkitRelativePath) || '').split('/')[0] || 'mission folder';
    this.value = '';
    if (!files.length) { $('group-meta').innerHTML = '<span class="err">No mission files (.kmz) in that folder.</span>'; return; }
    loadGroup({ files: files }, root);
  };
  $('file-group').onchange = async function () { var f = await readFile(this); if (f) loadGroup(f.buf, f.name); };

  /* ---- spans ---------------------------------------------------------------- */
  function towerIndexNorm(name) {
    if (!app.circuit) return -1;
    var n = normName(name);
    for (var i = 0; i < app.circuit.towers.length; i++) if (normName(app.circuit.towers[i].name) === n) return i;
    return -1;
  }
  function towerIndex(name) {
    if (!app.circuit) return -1;
    for (var i = 0; i < app.circuit.towers.length; i++) if (app.circuit.towers[i].name === name) return i;
    return -1;
  }
  function normName(n) { return String(n || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  /* missions of the group that belong to pair i (either direction) */
  function missionsForPair(i) {
    if (!app.group || !app.circuit) return [];
    var a = app.circuit.towers[i].name, b = app.circuit.towers[i + 1].name;
    var ta = app.circuit.towers[i], tb = app.circuit.towers[i + 1];
    var cx = (ta.x + tb.x) / 2, cy = (ta.y + tb.y) / 2;
    var na = normName(a), nb = normName(b);
    return app.group.missions.filter(function (m) {
      if (m.kind === 'span') { var ma = normName(m.a), mb = normName(m.b); return (ma === na && mb === nb) || (ma === nb && mb === na); }
      /* a check (gimbal test) belongs to the span it sits over */
      var w = m.wps[0];
      return w && w.x != null && Math.hypot(w.x - cx, w.y - cy) < Math.hypot(tb.x - ta.x, tb.y - ta.y) * 0.75;
    });
  }
  /* AUTO-ASSIGN (D-A855): a mission whose file name does not name two towers
     of THIS circuit is placed by position — the tower pair whose span its
     waypoints lie along; direction from which tower the first waypoint is
     nearer (A runs with the line, B against it); level by pairing: of two
     same-direction passes on a span the higher is H (A1/B1), the lower L */
  function placeByPosition(g) {
    var c = app.circuit; if (!c) return;
    var T = c.towers, placed = 0, unplaced = 0, bySpan = {};
    function segD(p, a, b) {
      var dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
      var t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
      return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    }
    g.missions.forEach(function (m) {
      if (m.kind === 'check') return;
      if (m.kind === 'span' && towerIndexNorm(m.a) >= 0 && towerIndexNorm(m.b) >= 0) { m.a = app.circuit.towers[towerIndexNorm(m.a)].name; m.b = app.circuit.towers[towerIndexNorm(m.b)].name; return; }
      var pts = m.wps.filter(function (w) { return w.x != null; });
      if (pts.length < 2) { m.unplaced = true; unplaced++; return; }
      var cx = 0, cy = 0; pts.forEach(function (w) { cx += w.x / pts.length; cy += w.y / pts.length; });
      var best = -1, bd = Infinity;
      for (var i = 0; i + 1 < T.length; i++) { var d = segD({ x: cx, y: cy }, T[i], T[i + 1]); if (d < bd) { bd = d; best = i; } }
      if (best < 0 || bd > 150) { m.unplaced = true; unplaced++; return; }
      var ta = T[best], tb = T[best + 1], w0 = pts[0], w1 = pts[pts.length - 1];
      var fwd = GEO.dist2(w0, ta) + GEO.dist2(w1, tb) <= GEO.dist2(w0, tb) + GEO.dist2(w1, ta);
      m.kind = 'span'; m.placed = 'position'; m.unplaced = false;
      m.a = fwd ? ta.name : tb.name; m.b = fwd ? tb.name : ta.name; m.dir = fwd ? 'A' : 'B';
      m.meanAlt = pts.reduce(function (s, w) { return s + w.alt; }, 0) / pts.length;
      var k = m.a + '>' + m.b; (bySpan[k] = bySpan[k] || []).push(m);
      placed++;
    });
    Object.keys(bySpan).forEach(function (k) {
      var ms = bySpan[k].sort(function (p, q) { return q.meanAlt - p.meanAlt; });
      ms.forEach(function (m, i) { m.level = i === 0 ? 'H' : 'L'; m.code = m.dir + (i === 0 ? '1' : '2'); });
    });
    g.placed = placed; g.unplaced = unplaced;
  }
  function seqForPair(i) {
    var ms = missionsForPair(i).filter(function (m) { return m.seq; });
    return ms.length ? ms[0].seq : '';
  }
  function firstMissionSpan() {
    if (!app.circuit) return -1;
    for (var i = 0; i < app.circuit.towers.length - 1; i++) if (missionsForPair(i).length) return i;
    return -1;
  }
  /* one mark per pass code; the same pass from several files (two plans of
     the span, D-A898) shows once with ×n, never as a repeated letter */
  function codeMarks(ms, legs) {
    var order = [], n = {};
    ms.forEach(function (m) { if (!n[m.code]) { n[m.code] = 0; order.push(m.code); } n[m.code]++; });
    return order.map(function (k) {
      return '<i class="cd' + (legs[k] ? ' done' : '') + (n[k] > 1 ? ' dup' : '') + '" title="' + k + (n[k] > 1 ? ': ' + n[k] + ' files carry this pass' : '') + (legs[k] ? ' · flown, photos on the ground' : '') + '">' + k + (n[k] > 1 ? '<small>×' + n[k] + '</small>' : '') + '</i>';
    }).join(' ');
  }
  function renderSpans() {
    var host = $('span-list');
    host.innerHTML = '';
    if (!app.circuit) { $('spans-n').textContent = ''; return; }
    var q = ($('span-filter').value || '').trim().toLowerCase();
    var show = app.prefs.spanShow || 'all';
    var n = 0, shown = 0, doneN = 0;
    for (var i = 0; i < app.circuit.towers.length - 1; i++) {
      var a = app.circuit.towers[i].name, b = app.circuit.towers[i + 1].name;
      var ms = missionsForPair(i);
      var seq = seqForPair(i);
      var label = a + ' > ' + b;
      /* DONE = a dataset exists for the span (photos taken here, D-A895) */
      var done = !!app.inspected[spanKey(i)], legs = app.doneLegs[spanKey(i)] || {};
      if (ms.length) n++;
      if (done) doneN++;
      if (q && (label + ' ' + seq).toLowerCase().indexOf(q) < 0) continue;
      if (show === 'done' && !done) continue;
      if (show === 'todo' && done) continue;
      var it = document.createElement('div');
      it.className = 'it' + (i === app.focus ? ' on' : '') + (done ? ' done' : '');
      it.innerHTML = '<span class="k">' + (seq || (i + 1)) + '</span><span class="t">' + label + '</span>' +
        '<span class="s">' + codeMarks(ms, legs) + '</span>' +
        '<span class="d" title="' + (done ? 'done: photos taken on this span' : '') + '">' + (done ? '\u2713' : '') + '</span>';
      it.onclick = (function (k) { return function () { focusSpan(k); }; })(i);
      host.appendChild(it);
      shown++;
    }
    $('spans-n').textContent = (app.circuit.towers.length - 1) + ' SPANS · ' + doneN + ' DONE' + (app.group ? ' · ' + n + ' WITH MISSIONS' : '');
    ['all', 'done', 'todo'].forEach(function (k) { $('span-show-' + k).classList.toggle('on', show === k); });
    void shown;
  }
  $('span-filter').oninput = renderSpans;
  ['all', 'done', 'todo'].forEach(function (k) { $('span-show-' + k).onclick = function () { app.prefs.spanShow = k; savePrefs(); renderSpans(); }; });

  /* ---- datasets per span: what a flight produced stays with its span -----
     The span's dataset has two layers (D-A869): the COMMITTED base — every
     earlier flight's photos, trail and captures, merged — and the LIVE
     flight on top, which is a function of the clock. Building or starting
     a new flight commits the live one first, so A1+A2 then B1+B2 add up.
     Only CLEAR DATA (or a per-span clear) forgets the base. */
  app.datasets = {};
  function emptyBase() { return { cov: COVERAGE.create(), covShots: 0, shotCaps: {}, rolls: 0, shots: 0 }; }
  function cloneCov(cov) { return JSON.parse(JSON.stringify(cov)); }
  app.base = emptyBase();
  function commitFlight() {
    if (!app.plan || !app.pose) return;
    saveDatasetSoon();
    syncCoverage(app.pose.t); syncRolls(app.pose.t);
    app.base = { cov: cloneCov(app.cov), covShots: app.covShots, shotCaps: Object.assign({}, app.shotCaps),
      rolls: STAGE.rollsCount(), shots: app.base.shots + (app.plan.shots || 0) };
  }
  /* shot numbers stay unique across the span's flights: the new plan's shots
     follow on from the committed ones */
  function adoptPlan(plan) {
    if (!plan || !plan.ok) return plan;
    var off = app.base.shots || 0;
    if (off) plan.legs.forEach(function (l) { if (l.shot) l.shot.n += off; });
    return plan;
  }
  /* SAVE the span's whole dataset to the browser (D-A869): everything on the
     ground right now — committed and live — as a committed base, so a
     refresh brings it back and the next flight adds to it. Findings live in
     prefs already. */
  /* every span inspected, by key → its coverage; drawn in slight grey (D-A870).
     The focused span shows its yellow trail instead, except in FINDINGS ONLY. */
  app.inspected = {};
  /* the legs flown per span (D-A896): the codes of the photos in its dataset */
  app.doneLegs = {};
  function legsOfFrames(frames) { var s = {}; (frames || []).forEach(function (f) { if (f.code) s[f.code] = true; }); return s; }
  function refreshInspected() {
    if (!app.circuit) { STAGE.drawInspected(null); return; }
    var list = [], fk = app.focus >= 0 ? spanKey(app.focus) : null;
    if (fk && app.cov && app.covShots) app.inspected[fk] = app.cov;
    Object.keys(app.datasets).forEach(function (k) { var d = app.datasets[k]; if (d && d.cov && d.covShots) app.inspected[k] = d.cov; });
    Object.keys(app.inspected).forEach(function (k) {
      if (k === fk && !app.prefs.findingsOnly) return;
      var p = spanIndexOfKey(k); if (p < 0) return;
      list.push({ pair: p, cov: app.inspected[k] });
    });
    STAGE.drawInspected(list);
    if (MAP.ready()) MAP.setInspected(list.map(function (e) { return e.pair; }).concat(fk && app.inspected[fk] ? [app.focus] : []));
    renderSpans();
  }
  async function loadInspected() {
    var keys = await STORE.keys('ds:');
    for (var i = 0; i < keys.length; i++) {
      var rec = await STORE.get(keys[i]);
      if (rec && rec.buf && rec.buf.cov && rec.buf.covShots) { app.inspected[keys[i].slice(3)] = rec.buf.cov; app.doneLegs[keys[i].slice(3)] = legsOfFrames(rec.buf.rolls && rec.buf.rolls.frames); }
    }
    refreshInspected(); STAGE.render();
  }
  var saveTimer = null;
  function saveDatasetSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveDataset, 800); }
  async function saveDataset() {
    if (app.focus < 0 || !app.circuit) return;
    var key = spanKey(app.focus);
    if (app.plan && app.pose) { syncCoverage(app.pose.t); syncRolls(app.pose.t); }
    var rolls = await STAGE.rollsExport(0.85);
    if (!rolls.frames.length && !app.covShots) { STORE.put('ds:' + key, key, null); return; }
    var shots = (app.base ? app.base.shots : 0) + (app.plan ? FLY.shotsAt(app.pose ? app.pose.t : 0) : 0);
    STORE.put('ds:' + key, key, { rolls: rolls, cov: cloneCov(app.cov), covShots: app.covShots, shotCaps: app.shotCaps || {}, shots: shots, savedAt: Date.now() });
    app.inspected[key] = cloneCov(app.cov);
    app.doneLegs[key] = legsOfFrames(rolls.frames);
    refreshInspected(); STAGE.render();
  }
  var restoring = {};
  async function restoreDataset(i) {
    var key = spanKey(i);
    if (restoring[key] || app.datasets[key]) return false;
    restoring[key] = true;
    var rec = await STORE.get('ds:' + key);
    if (!rec || !rec.buf || app.focus !== i || app.datasets[key]) { delete restoring[key]; return false; }
    var d = rec.buf;
    var n = 0;
    try { n = await STAGE.rollsImport(d.rolls); } finally { delete restoring[key]; }
    var base = { cov: d.cov, covShots: d.covShots, shotCaps: d.shotCaps || {}, rolls: STAGE.rollsCountOf(key), shots: d.shots || n };
    if (app.focus !== i) {
      /* the user moved on while the photos loaded: park it for when they return */
      app.datasets[key] = { plan: null, t: 0, cov: cloneCov(d.cov), covSummary: d.covShots ? COVERAGE.summary(d.cov) : null, covShots: d.covShots,
        shotCaps: Object.assign({}, d.shotCaps || {}), rollShots: base.rolls, rollsFrom: 0, seq: [], homeChosen: false, base: base };
      return true;
    }
    app.base = base;
    app.cov = cloneCov(d.cov); app.covShots = d.covShots; app.shotCaps = Object.assign({}, d.shotCaps || {});
    app.covSummary = d.covShots ? COVERAGE.summary(app.cov) : null;
    app.rollShots = app.base.rolls;
    STAGE.drawCoverage(d.covShots ? app.cov : null);
    STAGE.drawRollAnnotations(app.annos);
    parkDataset();
    renderHud(); STAGE.render();
    void n;
    return true;
  }
  function parkDataset() {
    if (app.focus < 0) return;
    if (!app.plan && !app.base.rolls && !app.base.covShots) return;
    app.datasets[spanKey(app.focus)] = { plan: app.plan, t: app.pose ? app.pose.t : 0, cov: app.cov, covSummary: app.covSummary,
      covShots: app.covShots, shotCaps: app.shotCaps, rollShots: app.rollShots, rollsFrom: app.rollsFrom,
      seq: app.seq.slice(), homeChosen: app.homeChosen, base: app.base };
  }
  function allAnnos() {
    var out = [], by = work().bySpan || {};
    Object.keys(by).forEach(function (k) { (by[k].annos || []).forEach(function (a) { out.push(a); }); });
    return out;
  }
  function focusSpan(i) {
    if (!app.circuit) return;
    parkDataset();
    stopPlay();
    app.focus = i;
    STAGE.rollsUse(spanKey(i));
    app.focusReport = null; app.selShots = []; app.selShotInfo = null;
    recallPlace(i);
    /* a remembered selection only counts if its missions are still here —
       judged once a group is loaded; before that it is kept as remembered */
    if (app.group) {
      var here = {};
      missionsForPair(i).forEach(function (m) { here[m.name] = true; });
      app.sel = app.sel.filter(function (n) { return here[n]; });
    }
    STAGE.setLaunch(app.launch);
    STAGE.droneVisible(false);
    STAGE.setSelection(app.sel);
    STAGE.focusSpan(i, true);
    feedFocusPhases();
    seedDefects(i);
    var ds = app.datasets[spanKey(i)];
    app.base = ds && ds.base ? ds.base : emptyBase();
    if (ds && !ds.plan) {
      /* a committed dataset with no live flight: the base is the picture */
      app.plan = null; FLY.load(null); app.pose = null;
      app.seq = ds.seq || []; app.homeChosen = !!ds.homeChosen;
      app.cov = ds.cov; app.covSummary = ds.covSummary; app.covShots = ds.covShots; app.shotCaps = ds.shotCaps;
      app.rollShots = ds.rollShots; app.rollsFrom = 0;
      STAGE.clearTrail(); STAGE.droneVisible(false); STAGE.drawCoverage(app.cov);
    } else if (ds) {
      /* back to a dataset flown earlier: its flight, trail, photos, findings */
      app.plan = ds.plan; FLY.load(ds.plan);
      app.cov = ds.cov; app.covSummary = ds.covSummary; app.covShots = ds.covShots; app.shotCaps = ds.shotCaps;
      app.rollShots = ds.rollShots; app.rollsFrom = ds.rollsFrom;
      app.seq = ds.seq || []; app.homeChosen = !!ds.homeChosen;
      STAGE.clearTrail();
      FLY.seek(ds.t); app.pose = FLY.tick(0);
      STAGE.droneVisible(true); STAGE.setDronePose(app.pose);
      app.focusReport = STAGE.updateFocus();
      STAGE.drawCoverage(app.cov);
    } else {
      app.plan = null; FLY.load(null); app.pose = null;
      app.seq = []; app.homeChosen = false;
      if (!restoring[spanKey(i)]) { resetCoverage(); resetRolls(); }
      STAGE.droneVisible(false);
      if (!app.booting && !STAGE.rollsCount()) restoreDataset(i);
    }
    STAGE.drawAnnotations(allAnnos());
    refreshInspected();
    syncMap(false);
    renderSpans();
    renderMissions();
    renderLaunch();
    renderPlan();
    renderHud();
    rememberPlace();
    var it = $('span-list').querySelector('.it.on');
    if (it && it.scrollIntoView) it.scrollIntoView({ block: 'nearest' });
  }
  $('btn-refocus').onclick = function () { if (app.focus >= 0) STAGE.frameSpan(app.focus); };

  /* ---- missions ------------------------------------------------------------- */
  function renderMissions() {
    var host = $('mission-rows');
    host.innerHTML = '';
    var ms = app.focus >= 0 ? missionsForPair(app.focus) : [];
    var ORD = { GIMBAL: -1, A1: 0, B1: 1, A2: 2, B2: 3 };
    ms.sort(function (p, q) { return (ORD[p.code] != null ? ORD[p.code] : 9) - (ORD[q.code] != null ? ORD[q.code] : 9); });
    $('missions-n').textContent = ms.length ? ms.length + ' AVAILABLE' : (app.group ? 'NONE ON THIS SPAN' : 'LOAD A GROUP');
    ms.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'mrow';
      var w0 = m.wps[0] || {};
      var g0 = (w0.actions || []).filter(function (a) { return a.type === 'gimbal'; })[0];
      var order = app.sel.indexOf(m.name);
      var kindCls = m.kind === 'check' ? 'G' : m.dir;
      var fileTag = '<span class="file" title="the wayline file the pilot selects in the controller">' + m.file + '</span>';
      var detail = m.kind === 'check'
        ? fileTag + ' · ' + m.photos + ' photos at one point · ' + fmt(w0.alt, 1) + ' m'
        : fileTag + ' · ' + m.wps.length + ' wp · ' + m.photos + ' photos · ' + fmt(w0.speed, 1) + ' m/s' +
          '<br>hdg ' + (w0.hdg != null ? fmt(w0.hdg, 1) + '°' : 'follow') + ' · gimbal ' + (g0 && g0.pitch != null ? fmt(g0.pitch, 0) + '°' : '–') +
          ' · ' + fmt(w0.alt, 1) + ' → ' + fmt((m.wps[m.wps.length - 1] || {}).alt, 1) + ' m' +
          (m.placed ? ' · <i>placed by position</i>' : '');
      row.innerHTML = '<input type="checkbox"' + (order >= 0 ? ' checked' : '') + '>' +
        '<span class="code ' + kindCls + '">' + m.code + (m.level ? ' ' + m.level : '') + '</span>' +
        '<span class="d">' + detail + '</span>' +
        '<span class="ord">' + (order >= 0 ? '#' + (order + 1) : '') + '</span>' +
        '<button class="del" title="delete this mission from the group">×</button>';
      row.querySelector('.del').onclick = function () { deleteMission(m); };
      row.querySelector('input').onchange = function () {
        var k = app.sel.indexOf(m.name);
        if (this.checked && k < 0) app.sel.push(m.name);
        if (!this.checked && k >= 0) app.sel.splice(k, 1);
        selectionChanged();
      };
      host.appendChild(row);
    });
    renderDeleted();
    selectionChanged(true);
  }
  /* DELETE a mission after ingest (D-A854): out of the group, the scene and the
     selection, remembered by name; RESTORE puts it back */
  function deleteMission(m) {
    var g = app.group; if (!g) return;
    g.missions = g.missions.filter(function (q) { return q !== m; });
    g.removed = (g.removed || []).concat([m]);
    app.prefs.deletedMissions = (app.prefs.deletedMissions || []).filter(function (n) { return n !== m.name; }).concat([m.name]);
    var k = app.sel.indexOf(m.name); if (k >= 0) app.sel.splice(k, 1);
    afterGroupChange();
  }
  function restoreDeleted() {
    var g = app.group; if (!g || !g.removed || !g.removed.length) return;
    if (app.circuit) GEO.projectGroup({ missions: g.removed }, app.circuit.frame);
    g.missions = g.missions.concat(g.removed); g.removed = [];
    app.prefs.deletedMissions = [];
    afterGroupChange();
  }
  function afterGroupChange() {
    var g = app.group;
    savePrefs();
    stopPlay(); app.plan = null; FLY.load(null);
    STAGE.setGroup(g);
    $('group-n').textContent = g.missions.length + ' MISSIONS';
    renderSpans(); renderMissions(); rememberPlace(); renderPlan(); STAGE.render();
  }
  function renderDeleted() {
    var el = $('mission-deleted'), g = app.group;
    var n = g && g.removed ? g.removed.length : 0;
    el.hidden = !n;
    if (!n) return;
    el.innerHTML = n + ' mission' + (n > 1 ? 's' : '') + ' deleted from this group · <a>RESTORE ' + (n > 1 ? 'THEM' : 'IT') + '</a>';
    el.querySelector('a').onclick = restoreDeleted;
  }
  /* FOCUS CHECK (D-A864): before anything flies, where each wire of this span
     sits against the bracket, from the pass's own photo positions — position,
     nose heading, gimbal pitch and yaw as the file gives them, the camera model
     as set. Per wire: depth range along the optical axis over every photo,
     share of the wire in frame and sharp, and the margin to the bracket edge.
     A wire the pass does not target (H = lines 1–2, L = lines 2–3) is shown
     muted. This is the same geometry the trail uses, stated as numbers. */
  function focusCheck(m) {
    var cam = app.cam; if (!cam || !m || m.kind !== 'span') return null;
    var wires = STAGE.focusPhaseList().filter(function (ph) { return ph.span; });
    if (!wires.length) return null;
    var tanH = Math.tan(cam.hfov / 2 * Math.PI / 180), tanV = Math.tan(cam.vfov / 2 * Math.PI / 180);
    var res = wires.map(function (ph) { return { name: ph.name, n: ph.pts.length, inFrame: new Uint8Array(ph.pts.length), sharp: new Uint8Array(ph.pts.length), minD: Infinity, maxD: -Infinity, photos: 0 }; });
    var pitch = null, yawAbs = null;
    m.wps.forEach(function (wp) {
      var shot = false;
      (wp.actions || []).forEach(function (a) {
        if (a.type === 'gimbal') { if (a.pitch != null) pitch = a.pitch; if (a.yaw != null) yawAbs = a.yaw; }
        if (a.type === 'photo') shot = true;
      });
      if (!shot || wp.x == null) return;
      var yaw = (yawAbs != null ? yawAbs : (wp.hdg != null ? wp.hdg : 0)) * Math.PI / 180;
      var p = (pitch != null ? pitch : -73) * Math.PI / 180;
      var hx = Math.sin(yaw), hy = Math.cos(yaw);
      var fx = hx * Math.cos(p), fy = hy * Math.cos(p), fz = Math.sin(p);
      var rx = Math.cos(yaw), ry = -Math.sin(yaw);
      var ux = -hx * Math.sin(p), uy = -hy * Math.sin(p), uz = Math.cos(p);
      wires.forEach(function (ph, wi) {
        var r = res[wi]; r.photos++;
        for (var i = 0; i < ph.pts.length; i++) {
          var q = ph.pts[i], dx = q.x - wp.x, dy = q.y - wp.y, dz = q.z - wp.z;
          var d = dx * fx + dy * fy + dz * fz; if (d <= 0) continue;
          var lat = dx * rx + dy * ry, ver = dx * ux + dy * uy + dz * uz;
          if (Math.abs(lat) > d * tanH || Math.abs(ver) > d * tanV) continue;
          r.inFrame[i] = 1; if (d < r.minD) r.minD = d; if (d > r.maxD) r.maxD = d;
          if (d >= cam.nearM && d <= cam.farM) r.sharp[i] = 1;
        }
      });
    });
    return res.map(function (r, k) {
      var inF = 0, sh = 0; for (var i = 0; i < r.n; i++) { inF += r.inFrame[i]; sh += r.sharp[i]; }
      var line = k + 1, target = m.level === 'L' ? line >= 2 : m.level === 'H' ? line <= Math.max(1, wires.length - 1) : true;
      return { name: r.name, line: line, target: target, inFrame: inF / r.n, sharp: sh / r.n, minD: r.minD, maxD: r.maxD,
        toNear: isFinite(r.minD) ? r.minD - cam.nearM : null, toFar: isFinite(r.maxD) ? cam.farM - r.maxD : null };
    });
  }
  function renderFocusCheck() {
    var el = $('focus-check'); if (!el) return;
    var ms = missionsByName(app.sel).filter(function (m) { return m.kind === 'span'; });
    if (!ms.length || !app.cam) { el.hidden = true; return; }
    var cam = app.cam, c = app.prefs.cam;
    var html = '<div class="h">FOCUS CHECK · ' + (CAMERA.BODIES[c.body] ? CAMERA.BODIES[c.body].name.replace('Phase One ', '') : 'custom') + ' · f/' + c.fnum + ' · box ' + fmt(cam.nearM, 1) + '–' + fmt(cam.farM, 1) + ' m (sharp to ' + fmt(cam.farFocusM, 1) + ', ' + fmt(cam.gsdMm, 1) + ' mm GSD to ' + fmt(cam.gsdLimitM, 1) + ')</div>';
    ms.forEach(function (m) {
      var rows = focusCheck(m); if (!rows) return;
      html += '<div class="m"><b>' + m.code + '</b> · ' + m.file + '<br>';
      html += rows.map(function (r) {
        if (!isFinite(r.minD)) return '<span class="' + (r.target ? 'soft' : 'mute') + '">line ' + r.line + ' · never in frame</span>';
        var where = r.sharp >= 0.995 ? 'compliant ' + fmt(r.sharp * 100, 0) + '%' : r.sharp > 0 ? 'compliant ' + fmt(r.sharp * 100, 0) + '%, the rest ' + (r.toFar < r.toNear ? 'beyond the far edge' : 'inside the near edge') : (r.maxD < cam.nearM ? 'too close' : r.minD > cam.farM ? 'beyond the box' : 'not compliant');
        var margin = Math.min(r.toNear, r.toFar);
        var cls = !r.target ? 'mute' : r.sharp >= 0.995 ? (margin < 0.5 ? 'part' : 'ok') : r.sharp > 0 ? 'part' : 'soft';
        var mtxt = r.target && r.sharp >= 0.995 ? (margin < 0 ? ' · AT the ' + (r.toFar < r.toNear ? 'far' : 'near') + ' edge, ' + fmt(-margin, 1) + ' m past it in some photos' : ' · ' + fmt(margin, 1) + ' m to the ' + (r.toFar < r.toNear ? 'far' : 'near') + ' edge') : '';
        var gsd = ' · GSD ' + fmt(cam.gsdAt(r.minD), 2) + '–' + fmt(cam.gsdAt(r.maxD), 2) + ' mm';
        var why = r.target && r.sharp < 0.995 && r.maxD > cam.farM ? (cam.gsdLimitM <= cam.farFocusM ? ' · over ' + fmt(cam.gsdMm, 1) + ' mm GSD past ' + fmt(cam.gsdLimitM, 1) + ' m' : ' · soft past ' + fmt(cam.farFocusM, 1) + ' m') : '';
        return '<span class="' + cls + '">line ' + r.line + ' · ' + fmt(r.minD, 1) + '–' + fmt(r.maxD, 1) + ' m' + gsd + ' · ' + where + mtxt + why + (r.target ? '' : ' · not this pass') + '</span>';
      }).join('<br>');
      html += '</div>';
    });
    el.innerHTML = html; el.hidden = false;
  }
  function selectionChanged(quiet) {
    STAGE.setSelection(app.sel);
    renderFocusCheck();
    $('btn-fly').disabled = !(($('cfg-one').checked || app.sel.length) && app.launch);
    if (!quiet) { renderMissions(); rememberPlace(); }
  }
  $('btn-all').onclick = function () {
    var ms = missionsForPair(app.focus).filter(function (m) { return m.kind === 'span'; });
    var ORDER = { A1: 0, B1: 1, A2: 2, B2: 3 };
    ms.sort(function (p, q) { return (ORDER[p.code] != null ? ORDER[p.code] : 9) - (ORDER[q.code] != null ? ORDER[q.code] : 9); });
    app.sel = ms.map(function (m) { return m.name; });
    selectionChanged();
  };
  $('btn-none').onclick = function () { app.sel = []; selectionChanged(); };

  /* ---- launch --------------------------------------------------------------- */
  /* the clipboard, with the old textarea route when the API is not there */
  function copyText(s) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s).then(function () { return true; }, function () { return copyOld(s); });
    return Promise.resolve(copyOld(s));
  }
  function copyOld(s) {
    try { var ta = document.createElement('textarea'); ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); var ok = document.execCommand('copy'); document.body.removeChild(ta); return !!ok; } catch (e) { return false; }
  }
  /* the launch spot as the field team's coordinates (D-A893): decimal
     degrees to six places, the form a phone's maps app takes as pasted */
  function launchLL() { return app.launch && app.circuit ? app.circuit.frame.toLL(app.launch.x, app.launch.y) : null; }
  function renderLaunch() {
    var L = app.launch, q = launchLL();
    if (MAP.ready()) MAP.setLaunch(L);
    $('launch-meta').innerHTML = L
      ? '<b>LZ</b> at x ' + fmt(L.x, 0) + ' m, y ' + fmt(L.y, 0) + ' m, ground ' + fmt(L.z, 1) + ' m' +
        (app.circuit ? ' · ' + fmt(GEO.dist2(L, app.circuit.towers[app.focus]), 0) + ' m from ' + app.circuit.towers[app.focus].name : '') +
        (q ? '<br><span class="coord" id="launch-coord" title="latitude, longitude for the field team">' + MAP.fmtLL(q.lat, q.lon) + '</span> <button class="sm" id="btn-copy-launch" title="copy the launch spot coordinates">COPY</button>' : '')
      : '';
    $('btn-pick').textContent = L ? 'CHANGE LZ' : 'SELECT LZ';
    $('btn-fly').disabled = !(($('cfg-one').checked || app.sel.length) && app.launch);
    renderPlan();
  }
  $('launch-meta').onclick = function (ev) {
    if (!ev.target || ev.target.id !== 'btn-copy-launch') return;
    var q = launchLL(); if (!q) return;
    var s = MAP.fmtLL(q.lat, q.lon), b = ev.target;
    copyText(s).then(function (ok) { b.textContent = ok ? 'COPIED' : 'COPY FAILED'; setTimeout(function () { b.textContent = 'COPY'; }, 1600); });
  };
  $('btn-pick').onclick = function () {
    STAGE.pick(true); $('hint').hidden = false; $('btn-pick').classList.add('on');
  };
  STAGE.onGroundPick = function (p) {
    app.launch = p;
    STAGE.pick(false); $('hint').hidden = true; $('btn-pick').classList.remove('on');
    STAGE.setLaunch(p);
    app.plan = null; renderPlan();
    renderLaunch();
    rememberPlace();
  };
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') { STAGE.pick(false); $('hint').hidden = true; $('btn-pick').classList.remove('on'); }
    if (ev.key === ' ' && app.plan && document.activeElement.tagName !== 'INPUT') { ev.preventDefault(); togglePlay(); }
  });
  $('btn-auto').onclick = function () {
    if (app.focus < 0) return;
    var ta = app.circuit.towers[app.focus], tb = app.circuit.towers[app.focus + 1];
    var dx = tb.x - ta.x, dy = tb.y - ta.y, L = Math.hypot(dx, dy) || 1;
    /* 40 m off the start tower, on the side away from the conductors */
    var side = -1;
    var ph = STAGE.pairPhases(app.focus);
    if (ph.length) { var p0 = ph[0][0]; side = ((p0.x - ta.x) * (-dy / L) + (p0.y - ta.y) * (dx / L)) > 0 ? -1 : 1; }
    var ax = ta.x + (-dy / L) * 40 * side - dx / L * 15, ay = ta.y + (dx / L) * 40 * side - dy / L * 15;
    STAGE.onGroundPick({ x: ax, y: ay, z: STAGE.groundAt(ax, ay) });
  };
  ['cfg-over', 'cfg-vt', 'cfg-vc'].forEach(function (id) {
    var key = id.replace('cfg-', '');
    $(id).value = app.prefs[key];
    $(id).onchange = function () { app.prefs[key] = Number(this.value); savePrefs(); app.plan = null; renderPlan(); };
  });

  /* ---- the overview map (D-A848) ------------------------------------------------ */
  function applyMap() {
    var mode = app.prefs.map || 'off';
    var panel = $('map-panel');
    panel.hidden = mode === 'off';
    panel.classList.toggle('large', mode === 'L');
    $('btn-map').classList.toggle('on', mode !== 'off');
    $('btn-map').textContent = mode === 'off' ? 'MAP' : 'MAP · ' + mode;
    if (mode !== 'off') {
      if (!MAP.ready()) {
        MAP.init($('map'), {
          onSpan: function (i) { if (app.circuit && i !== app.focus) focusSpan(i); },
          onHold: function (ll) { var s = MAP.fmtLL(ll.lat, ll.lng); copyText(s).then(function (ok) { MAP.flash(ll, (ok ? 'copied ' : '') + s); }); }
        });
        if (app.circuit) { MAP.setCircuit(app.circuit); syncMap(true); }
      }
      MAP.invalidate();
    }
  }
  function syncMap(pan) {
    if (!MAP.ready() || !app.circuit) return;
    var ms = {};
    if (app.group) app.group.missions.forEach(function (m) { if (m.kind !== 'span') return; var ia = towerIndex(m.a), ib = towerIndex(m.b); if (ia >= 0 && ib >= 0) ms[Math.min(ia, ib)] = true; });
    MAP.setMissionSpans(Object.keys(ms).map(Number));
    MAP.setInspected(Object.keys(app.inspected || {}).map(spanIndexOfKey).filter(function (i) { return i >= 0; }));
    if (app.focus >= 0) MAP.setFocus(app.focus, pan);
    MAP.setLaunch(app.launch);
  }
  /* GROUND (D-A874): the map as the floor of the 3D world, off / map / satellite */
  function applyGround() {
    var mode = app.prefs.ground || 'off';
    STAGE.setGroundTiles(mode);
    $('btn-ground').classList.toggle('on', mode !== 'off');
    $('btn-ground').textContent = mode === 'off' ? 'GROUND' : mode === 'map' ? 'GROUND · MAP' : 'GROUND · SAT';
    var credit = $('tile-credit');
    credit.hidden = mode === 'off';
    credit.textContent = (mode === 'map' ? '© OpenStreetMap contributors' : mode === 'sat' ? 'Imagery © Esri, Maxar, Earthstar Geographics' : '') + (mode !== 'off' && app.prefs.relief ? ' · Terrain: Mapzen / AWS Terrain Tiles' : '');
  }
  $('btn-ground').onclick = function () {
    var order = ['off', 'map', 'sat'], k = order.indexOf(app.prefs.ground || 'off');
    app.prefs.ground = order[(k + 1) % order.length]; savePrefs(); applyGround(); STAGE.render();
  };
  /* RELIEF (D-A891): the tiles draped over the terrain; needs a ground layer */
  function applyRelief() {
    var on = !!app.prefs.relief;
    STAGE.setRelief(on);
    $('btn-relief').classList.toggle('on', on);
  }
  $('btn-relief').onclick = function () {
    app.prefs.relief = !app.prefs.relief;
    if (app.prefs.relief && (app.prefs.ground || 'off') === 'off') app.prefs.ground = 'sat';
    savePrefs(); applyRelief(); applyGround(); STAGE.render();
  };
  applyRelief();
  applyGround();
  $('btn-map').onclick = function () {
    var order = ['off', 'S', 'L'], k = order.indexOf(app.prefs.map || 'off');
    app.prefs.map = order[(k + 1) % order.length]; savePrefs(); applyMap();
  };
  applyMap();

  /* ---- payload optics ---------------------------------------------------------- */
  function applyCamera() {
    var c = app.prefs.cam;
    var pitch = (c.pitchUm || 3.45) / 1000;    /* the body's pixel, mm */
    var model = CAMERA.model({ focal: c.focal, fnum: c.fnum, focusM: c.focusM, cocPx: c.cocPx,
      sensorW: c.sensorW, sensorH: c.sensorH, pixW: Math.round(c.sensorW / pitch), pixH: Math.round(c.sensorH / pitch) });
    /* the COMPLIANT box (D-A867): sharp between near and far, AND the pixel on
       the wire no coarser than the GSD target. GSD grows with depth, so the
       target sets a far limit of its own: D = gsd × f / pitch. The box is the
       bracket cut there; the classifier, the trail, the coverage and the
       focus check all use the box. */
    var gsdMm = app.prefs.cam.gsdMm > 0 ? app.prefs.cam.gsdMm : 1.0;
    model.farFocusM = model.farM;
    model.gsdLimitM = gsdMm * c.focal / pitch / 1000;
    model.gsdMm = gsdMm;
    model.farM = Math.min(model.farFocusM, model.gsdLimitM);
    app.cam = model;
    STAGE.setCamera(model);
    $('cam-n').textContent = fmt(model.hfov, 1) + '° × ' + fmt(model.vfov, 1) + '°';
    var depth = isFinite(model.farM) ? fmt(model.farM - model.nearM, 1) + ' m deep' : 'to infinity';
    var bodyName = CAMERA.BODIES[c.body] ? CAMERA.BODIES[c.body].name : 'custom sensor';
    /* designed into the mission, not settings (D-A859): the lens and focus
       distance come with the plan, the sensor comes with the camera */
    $('cam-fixed').innerHTML = 'Designed into the mission: ' + bodyName + ', ' + c.focal + ' mm lens, focus ' + fmt(c.focusM, 1) + ' m, sensor ' +
      fmt(c.sensorW, 2) + ' × ' + fmt(c.sensorH, 1) + ' mm at ' + fmt(c.pitchUm || 3.45, 2) + ' µm.';
    $('cam-coc-mm').textContent = '= ' + fmt(model.gsdAt(c.focusM) * c.cocPx, 2) + ' mm on the wire';
    if (typeof renderFocusCheck === 'function' && app.circuit) renderFocusCheck();
    var depthF = isFinite(model.farFocusM) ? fmt(model.farFocusM - model.nearM, 1) + ' m deep' : 'to infinity';
    $('cam-meta').innerHTML =
      'sharp ' + fmt(model.nearM, 1) + ' – ' + (isFinite(model.farFocusM) ? fmt(model.farFocusM, 1) : '∞') + ' m (' + depthF + ', to ' + c.cocPx + ' px) · ' + fmt(gsdMm, 1) + ' mm GSD holds to ' + fmt(model.gsdLimitM, 1) + ' m<br>' +
      '<b>COMPLIANT BOX ' + fmt(model.nearM, 1) + ' – ' + fmt(model.farM, 1) + ' m</b> (' + fmt(model.farM - model.nearM, 1) + ' m deep' + (model.gsdLimitM < model.farFocusM ? ', cut by the GSD target' : ', cut by focus') + ')<br>' +
      'diffraction at f/' + c.fnum + ': Airy ' + fmt(model.airyUm, 1) + ' µm = <b>' + fmt(model.diffractionPx, 1) + ' px</b> blur' +
      (model.diffractionPx > 2.5 ? ' <span class="err">· softer than the bracket standard</span>' : '') + '<br>' +
      'at 20 m: footprint ' + fmt(model.widthAt(20), 1) + ' m along the line · ' + fmt(model.gsdAt(20), 2) + ' mm/px · hyperfocal ' + fmt(model.hyperfocalM, 0) + ' m';
  }
  /* the pilot's two settings: aperture and the sharpness standard */
  [['cam-fnum', 'fnum'], ['cam-coc', 'cocPx'], ['cam-gsd', 'gsdMm']].forEach(function (pair) {
    var el = $(pair[0]);
    if (app.prefs.cam[pair[1]] == null) app.prefs.cam[pair[1]] = Number(el.value);
    el.value = app.prefs.cam[pair[1]];
    el.onchange = function () { app.prefs.cam[pair[1]] = Number(this.value); savePrefs(); applyCamera(); refreshFocus(); };
  });
  /* lens and focus distance are the plan's (Phase One's assessment for this
     job: 80 mm, 19.5 m); older prefs may hold edited values — reset them */
  app.prefs.cam.focal = 80; app.prefs.cam.focusM = 19.5;
  /* CAMERA body (D-A858): sets the sensor and the pixel pitch; lens, f-number,
     focus and the sharpness standard are the pilot's and stay as set */
  function setCameraBody(key, quiet) {
    var b = CAMERA.BODIES[key] || CAMERA.BODIES.gs120; key = CAMERA.BODIES[key] ? key : 'gs120';
    app.prefs.cam.body = key;
    app.prefs.cam.sensorW = b.sensorW; app.prefs.cam.sensorH = b.sensorH; app.prefs.cam.pitchUm = b.pitchUm;
    $('cam-body').value = app.prefs.cam.body;
    savePrefs(); applyCamera();
    if (!quiet) refreshFocus();
  }
  setCameraBody(app.prefs.cam.body || 'gs120', true);
  $('cam-body').onchange = function () { setCameraBody(this.value); };

  /* the conductors the focus overlay watches: the focused span and its
     neighbours, wires numbered from the top, resampled to STEP metres so a
     15 % overlap on a 10 m footprint (1.5 m) is measured to a quarter metre */
  var STEP = 0.25;
  function feedFocusPhases() {
    var list = [];
    if (!app.circuit || app.focus < 0) { STAGE.setFocusPhases(list); return; }
    for (var p = Math.max(0, app.focus - 1); p <= Math.min(app.circuit.towers.length - 2, app.focus + 1); p++) {
      STAGE.pairPhases(p).forEach(function (pts, k) {
        var fine = [];
        for (var i = 1; i < pts.length; i++) {
          var n = Math.max(1, Math.round(GEO.dist3(pts[i - 1], pts[i]) / STEP));
          for (var j = 0; j < n; j++) {
            var f = j / n;
            fine.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * f });
          }
        }
        fine.push(pts[pts.length - 1]);
        list.push({ id: 'p' + p + '-w' + (k + 1), name: 'WIRE ' + (k + 1) + (p === app.focus ? '' : ' (next span)'), pts: fine, pair: p, span: p === app.focus, step: STEP });
      });
    }
    STAGE.setFocusPhases(list);
  }
  function refreshFocus() {
    app.focusReport = app.plan && app.pose ? STAGE.updateFocus() : null;
    resetCoverage();
    if (app.plan && app.pose) syncCoverage(app.pose.t);
    renderHud();
  }

  /* ---- the cookie trail -------------------------------------------------------
     Coverage is a function of the clock: every photo whose moment has passed
     is recorded, in order, from the shot's own pose. Going backwards rebuilds
     from nothing, so scrubbing never leaves a stale trail. */
  /* back to the committed base: the live flight's captures go, earlier flights stay */
  function resetCoverage() {
    var b = app.base || emptyBase();
    app.cov = cloneCov(b.cov); app.covShots = b.covShots; app.shotCaps = Object.assign({}, b.shotCaps);
    app.covSummary = b.covShots ? COVERAGE.summary(app.cov) : null;
    STAGE.drawCoverage(b.covShots ? app.cov : null);
  }
  function syncCoverage(t) {
    if (!app.plan) return;
    var legs = app.plan.legs, fired = [];
    for (var i = 0; i < legs.length; i++) {
      var l = legs[i];
      if (l.shot && t >= l.t0 + l.durS * 0.5) fired.push(l);
    }
    var b = app.base || emptyBase(), live = app.covShots - b.covShots;
    if (fired.length < live) { resetCoverage(); live = 0; }
    if (fired.length === live) return;
    app.shotCaps = app.shotCaps || {};
    for (var k = live; k < fired.length; k++) {
      var s = fired[k];
      var yawTotal = s.gyaw != null ? s.gyaw : (s.hdgFixed || 0) + (s.gyawRel || 0);
      var caps = STAGE.shotCaptures(s.a, s.hdgFixed || 0, s.gim != null ? s.gim : -30, yawTotal);
      app.shotCaps[s.shot.n] = caps;
      COVERAGE.record(app.cov, s.shot, caps);
    }
    app.covShots = b.covShots + fired.length;
    app.covSummary = COVERAGE.summary(app.cov);
    STAGE.drawCoverage(app.cov);
  }

  /* ---- the camera rolls: the deliverable ----------------------------------------
     Like the trail, a function of the clock: every photo whose moment has
     passed (after the last CLEAR) is rendered and laid on the ground. */
  /* the live flight's photos go, the committed ones stay on the ground */
  function resetRolls() {
    var keep = (app.base || emptyBase()).rolls;
    if (keep) STAGE.rollsTrimTo(keep); else STAGE.rollsClear();
    STAGE.drawRollAnnotations(keep ? app.annos : null);
    app.rollShots = keep; app.rollsFrom = 0; app.selShots = []; app.selShotInfo = null;
  }
  function rollLayout(shot, leg) {
    var m = missionsForPair(app.focus).filter(function (x) { return x.name === shot.mission; })[0];
    if (!m || m.kind !== 'span') return null;
    var ia = towerIndex(m.a), ib = towerIndex(m.b);
    if (ia < 0 || ib < 0) return null;
    var lo = Math.min(ia, ib), ta = app.circuit.towers[lo], tb = app.circuit.towers[lo + 1];
    var dx = tb.x - ta.x, dy = tb.y - ta.y, L = Math.hypot(dx, dy) || 1;
    var u = { x: dx / L, y: dy / L }, nx = -u.y, ny = u.x;
    /* the lane's side of the line, from the first waypoint of the mission */
    var w0 = m.wps[0], side = ((w0.x - ta.x) * nx + (w0.y - ta.y) * ny) >= 0 ? 1 : -1;
    var row = m.level === 'L' ? 1 : 0;
    var cm = app.cam, w = cm.widthAt(20), h = w / cm.aspect;
    var lateral = side * (26 + row * (h + 3));
    /* along the line: where the captured section IS — the centre of what
       this photo recorded sharp on this span's wires — else the station */
    var along = (leg.a.x - ta.x) * u.x + (leg.a.y - ta.y) * u.y;
    var caps = app.shotCaps && app.shotCaps[shot.n];
    if (caps) {
      var n = 0, sum = 0;
      caps.forEach(function (c) {
        if (c.wireId.indexOf('p' + app.focus + '-') !== 0) return;
        c.sharp.forEach(function (iv) { sum += (iv.s0 + iv.s1) / 2; n++; });
      });
      if (n) {
        /* arc length runs from the span's first tower; the wires run a → b
           of the pair, which is our ta → tb */
        along = sum / n;
      }
    }
    return { origin: { x: ta.x, y: ta.y, z: STAGE.groundZ() }, u: u, lateral: lateral, along: along, w: w, h: h,
      rollKey: m.name, label: m.code + ' · ' + m.a + ' → ' + m.b, labelAlong: m.dir === 'A' ? -12 : L + 12 };
  }
  function syncRolls(t) {
    if (!app.plan) return;
    var before = app.rollShots || 0;
    var legs = app.plan.legs, fired = [];
    for (var i = 0; i < legs.length; i++) {
      var l = legs[i];
      if (l.shot && t >= l.t0 + l.durS * 0.5 && l.t0 + l.durS * 0.5 >= app.rollsFrom) fired.push(l);
    }
    var baseRolls = (app.base || emptyBase()).rolls, total = baseRolls + fired.length;
    if (total < app.rollShots) { STAGE.rollsTrimTo(total); app.rollShots = total; app.selShots = []; app.selShotInfo = null; }
    for (var k = app.rollShots - baseRolls; k < fired.length; k++) {
      var s = fired[k];
      var lay = rollLayout(s.shot, s);
      if (lay) {
        var yawTotal = s.gyaw != null ? s.gyaw : (s.hdgFixed || 0) + (s.gyawRel || 0);
        STAGE.rollAddFrame(s.shot, s.a, s.hdgFixed || 0, s.gim != null ? s.gim : -30, yawTotal, lay);
      }
    }
    if (total !== before) STAGE.drawRollAnnotations(app.annos);
    app.rollShots = total;
  }
  /* FINDINGS ONLY: datasets and furniture step back, every span's marks stay */
  function applyFindings() {
    var on = !!app.prefs.findingsOnly;
    STAGE.findingsOnly(on);
    $('btn-findings').classList.toggle('on', on);
    $('btn-findings').textContent = on ? 'FINDINGS ONLY' : 'FINDINGS';
  }
  applyFindings();
  $('btn-findings').onclick = function () { app.prefs.findingsOnly = !app.prefs.findingsOnly; savePrefs(); applyFindings(); refreshInspected(); STAGE.render(); };
  /* CLEAR DATA (D-A853): every dataset (images) and every finding, nothing else —
     circuit, missions, launch spots and settings stay */
  $('btn-reset-all').onclick = function () {
    if (!window.confirm('Clear every image dataset and every finding? The circuit, missions, launch spots and settings stay.')) return;
    stopPlay();
    STAGE.rollsClearAll();
    app.datasets = {};
    app.base = emptyBase();
    clearTimeout(saveTimer);
    STORE.clearPrefix('ds:');
    app.inspected = {}; app.doneLegs = {};
    STAGE.drawInspected(null);
    renderSpans();
    var by = work().bySpan || {};
    Object.keys(by).forEach(function (k) { by[k].annos = []; });
    app.annos = []; app.selShots = []; app.selShotInfo = null;
    app.plan = null; FLY.load(null); app.pose = null;
    resetCoverage(); resetRolls();
    STAGE.droneVisible(false); STAGE.clearTrail();
    STAGE.drawAnnotations([]);
    savePrefs();
    renderPlan(); renderHud(); renderAnnoList(); rvBuilt.count = -1;
    if (app.review) renderReview();
    STAGE.render();
  };
  /* FULL RESET (D-A852, testing): forget everything this browser holds — the cached
     circuit and mission group, every preference, launch spot, dataset and finding —
     then reload into an empty tool */
  $('btn-full-reset').onclick = async function () {
    if (!window.confirm('FULL RESET: forget the loaded circuit and missions, every launch spot, dataset, finding and setting, and start empty?')) return;
    stopPlay();
    app.wiped = true;
    try { localStorage.removeItem('asi.prefs.v1'); } catch (e) {}
    await STORE.clear();
    location.reload();
  };
  /* the toolbar as three menus (D-A900): VIEW, PHOTOS, DATA, one open at a
     time, closed by a pick, a click elsewhere or ESC; items that need photos
     are greyed until there are some; a menu lights when any item in it is on */
  (function () {
    var menus = Array.from(document.querySelectorAll('.tools .menu'));
    function closeAll() { menus.forEach(function (m) { m.classList.remove('open'); }); }
    function refresh(m) {
      if (m.id === 'menu-photos') { var n = STAGE.rollsCount(); $('btn-select-all').disabled = !n; $('btn-rolls').disabled = !n; }
      m.querySelector('.mt').classList.toggle('lit', !!m.querySelector('.items button.on') && m.id !== 'menu-data');
    }
    menus.forEach(function (m) {
      m.querySelector('.mt').onclick = function (ev) { ev.stopPropagation(); var open = m.classList.contains('open'); closeAll(); if (!open) { m.classList.add('open'); refresh(m); } };
      m.querySelector('.items').addEventListener('click', function (ev) { if (ev.target.closest('button')) setTimeout(function () { closeAll(); menus.forEach(refresh); }, 0); });
    });
    document.addEventListener('click', closeAll);
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeAll(); });
    app.refreshMenus = function () { menus.forEach(refresh); };
    setTimeout(app.refreshMenus, 0);
  })();
  /* HIDE / SHOW the rolls in the 3D view, remembered */
  function applyRollsVis() {
    var on = app.prefs.rollsVis !== false;
    STAGE.rollsVisible(on);
    $('btn-rolls-vis').classList.toggle('on', on);
    $('btn-rolls-vis').textContent = on ? 'ROLLS' : 'ROLLS HIDDEN';
  }
  applyRollsVis();
  $('btn-rolls-vis').onclick = function () { app.prefs.rollsVis = app.prefs.rollsVis === false; savePrefs(); applyRollsVis(); STAGE.render(); };
  $('btn-rolls').onclick = function () {
    STAGE.rollsClear(); STAGE.drawRollAnnotations(null); app.rollShots = 0; app.selShots = []; app.selShotInfo = null;
    app.rollsFrom = app.pose ? app.pose.t + 0.01 : 0;
    STAGE.render();
  };
  /* click a photo on the ground: the section of line it recorded sharp.
     Ctrl / shift click adds to the selection; SELECT ALL takes every photo
     on the ground; a click on empty ground clears. */
  app.selShots = [];
  function applySelection() {
    var list = app.selShots.map(function (n) { return { n: n, caps: app.shotCaps ? app.shotCaps[n] : null }; });
    STAGE.highlightShots(list);
    app.selShotInfo = null;
    if (list.length === 1 && list[0].caps) {
      var n = list[0].n, caps = list[0].caps;
      var leg = app.plan.legs.filter(function (l) { return l.shot && l.shot.n === n; })[0];
      app.selShotInfo = { n: n, code: leg ? leg.shot.code : '', index: leg ? leg.shot.index : '', count: 1,
        wires: caps.filter(function (c) { return c.wireId.indexOf('p' + app.focus + '-') === 0 && c.sharp.length; })
          .map(function (c) { return c.wireName + ' ' + c.sharp.map(function (iv) { return fmt(iv.s0, 1) + '–' + fmt(iv.s1, 1) + ' m'; }).join(', '); }) };
    } else if (list.length > 1) {
      /* the union of what the selected photos recorded sharp, per wire */
      var by = {};
      list.forEach(function (s) {
        (s.caps || []).forEach(function (c) {
          if (c.wireId.indexOf('p' + app.focus + '-') !== 0) return;
          by[c.wireName] = (by[c.wireName] || []).concat(c.sharp);
        });
      });
      app.selShotInfo = { count: list.length, wires: Object.keys(by).sort().map(function (w) {
        var m = COVERAGE._merge(by[w].slice());
        return w + ' ' + fmt(COVERAGE._length(m), 1) + ' m in ' + m.length + ' section' + (m.length > 1 ? 's' : '');
      }) };
    }
    renderHud(); STAGE.render();
  }
  STAGE.onRollClick = function (n, multi, key) {
    if (key && key !== spanKey(app.focus)) {
      var idx = spanIndexOfKey(key);
      if (idx >= 0) focusSpan(idx); else return;
    }
    if (n == null) { app.selShots = []; }
    else if (multi) {
      var k = app.selShots.indexOf(n);
      if (k >= 0) app.selShots.splice(k, 1); else app.selShots.push(n);
    } else app.selShots = [n];
    applySelection();
    if (app.review) renderReview();
  };

  /* ---- the deliverable review view --------------------------------------------
     The rolls become the navigator: one track per pass, thumbnails placed
     and overlapped along the span exactly as the photos are; the picked
     photo fills the main area at full resolution. */
  app.review = false;
  function setReview(on) {
    app.review = on;
    $('btn-review').classList.toggle('on', on);
    $('btn-review').textContent = on ? '3D SCENE' : 'REVIEW';
    $('review').hidden = !on;
    /* the map mini window and the tile credit float above the scene, not above the review (D-A892) */
    document.body.classList.toggle('reviewing', on);
    if (on) renderReview();
    else { STAGE.drawAnnotations(allAnnos()); STAGE.render(); MAP.invalidate(); }
  }
  $('btn-review').onclick = function () { setReview(!app.review); };
  $('an-back').onclick = function () { setReview(false); };
  var rvBuilt = { count: -1, focus: -1 };
  function renderReview() {
    var items = STAGE.rollList();
    var nav = $('rv-nav');
    /* the navigator: rebuilt when the roll set changes */
    if (rvBuilt.count !== items.length || rvBuilt.focus !== app.focus) {
      nav.innerHTML = '';
      var ta = app.circuit && app.focus >= 0 ? app.circuit.towers[app.focus] : null;
      var tb = ta ? app.circuit.towers[app.focus + 1] : null;
      var L = ta && tb ? GEO.dist2(ta, tb) : 1;
      /* the live view's layout: the line in the middle, the A side dataset
         above it (A2 outer, A1 inner), the B side below (B1 inner, B2
         outer) — A1 + A2 are one inspection of the A face, B1 + B2 of the B */
      var rows = {};
      items.forEach(function (it) {
        var key = it.rollKey || it.mission;
        if (!rows[key]) rows[key] = { label: it.label || key, code: it.code, items: [] };
        rows[key].items.push(it);
      });
      var keys = Object.keys(rows);
      function rowFor(code) { return keys.filter(function (k) { return rows[k].code === code; }).map(function (k) { return rows[k]; })[0]; }
      var cov = spanCoverage();
      var wiresN = STAGE.focusPhaseList().filter(function (ph) { return ph.span; }).length || 1;
      function sidePct(lane) {
        var got = 0;
        if (app.covSummary) Object.keys(app.covSummary).forEach(function (id) {
          var w = app.covSummary[id];
          if (!w.name || w.name.indexOf('next') >= 0) return;
          [1, -1].forEach(function (sd) { if (w.sides[sd] && w.sides[sd].lane === lane) got += w.sides[sd].coveredM; });
        });
        return cov.need > 0 ? Math.min(100, got / (cov.need / 2) * 100) : 0;
      }
      function track(r, levelLabel) {
        var row = document.createElement('div'); row.className = 'rv-row';
        var lab = document.createElement('div'); lab.className = 'rl ' + (r.code[0] === 'B' ? 'B' : 'A');
        row.dataset.flip = r.items.some(function (it) { return it.flip; }) ? '1' : '';
        /* which wires this roll actually holds sharp, from the shots */
        var sharpBy = {};
        r.items.forEach(function (it) {
          (app.shotCaps && app.shotCaps[it.n] || []).forEach(function (c) {
            if (c.wireId.indexOf('p' + app.focus + '-') !== 0) return;
            sharpBy[c.wireName] = (sharpBy[c.wireName] || 0) + c.sharp.reduce(function (n, iv) { return n + (iv.s1 - iv.s0); }, 0);
          });
        });
        var wires = Object.keys(sharpBy).filter(function (w) { return sharpBy[w] > L * 0.1; }).sort()
          .map(function (w) { return w.replace('WIRE ', ''); });
        lab.innerHTML = r.code + ' · ' + levelLabel + (wires.length ? ' · wires ' + wires.join(' + ') : '') +
          '<small>' + r.items.length + ' photos' + (row.dataset.flip ? ' · shown rotated so left = ' + (ta ? ta.name : 'tower 1') : '') + '</small>';
        var tr = document.createElement('div'); tr.className = 'rv-track';
        /* the tower at each end of every roll */
        var eL = document.createElement('span'); eL.className = 'end l'; eL.textContent = '◀ ' + (ta ? ta.name : '');
        var eR = document.createElement('span'); eR.className = 'end r'; eR.textContent = (tb ? tb.name : '') + ' ▶';
        tr.appendChild(eL); tr.appendChild(eR);
        var aspect = (app.cam && app.cam.aspect) || 4 / 3;
        r.items.forEach(function (it) {
          if (!it.thumb) return;
          var img = document.createElement('img');
          img.src = it.thumb;
          img.dataset.n = it.n;
          img.title = (it.suffix || 'PHOTO ' + it.n) + ' · ' + it.code + ' · WP ' + it.index + ' · ' + fmt(it.along, 0) + ' m';
          img.style.left = ((it.along - it.frameW / 2) / L * 100) + '%';
          img.style.width = (it.frameW / L * 100) + '%';
          img.style.zIndex = 10 + (it.index || 0);
          img.onclick = function (ev) { STAGE.onRollClick(it.n, !!(ev.ctrlKey || ev.metaKey || ev.shiftKey)); };
          tr.appendChild(img);
        });
        tr.dataset.fw = r.items[0] ? r.items[0].frameW / L : 0.05;
        row.appendChild(lab); row.appendChild(tr);
        return row;
      }
      /* every track exactly as tall as its frames — measured once laid out,
         and again whenever the window changes */
      function fitTracks() {
        Array.prototype.forEach.call(nav.querySelectorAll('.rv-track'), function (tr) {
          var w = tr.clientWidth;
          if (!w) return;
          var fw = w * Number(tr.dataset.fw || 0.05);
          tr.style.height = Math.max(40, Math.round(fw / ((app.cam && app.cam.aspect) || 4 / 3)) + 10) + 'px';
        });
      }
      setTimeout(fitTracks, 30); setTimeout(fitTracks, 300); setTimeout(fitBig, 40); setTimeout(fitBig, 320);
      window.removeEventListener('resize', app._fitTracks || function () {});
      app._fitTracks = fitTracks; window.addEventListener('resize', fitTracks);
      function header(lane, passes) {
        var h = document.createElement('div'); h.className = 'rv-side ' + lane;
        var pct = sidePct(lane);
        h.innerHTML = '<span class="nm">' + lane + ' SIDE DATASET</span><span class="ps">' + passes.join(' + ') + (passes.length > 1 ? ' together' : '') + '</span>' +
          '<span class="pc' + (pct >= 99.95 ? ' ok' : '') + '">' + fmt(pct, 1) + '% of the ' + lane + ' face proven sharp</span>';
        return h;
      }
      function lineStrip() {
        var s = document.createElement('div'); s.className = 'rv-line';
        s.innerHTML = '<span class="tw l">' + (ta ? ta.name : '') + '</span><span class="tw r">' + (tb ? tb.name : '') + '</span>';
        for (var m = 0; m <= L; m += 50) {
          var tk = document.createElement('i'); tk.style.left = (m / L * 100) + '%'; s.appendChild(tk);
          var tl = document.createElement('b'); tl.style.left = (m / L * 100) + '%'; tl.textContent = m + ' m'; s.appendChild(tl);
        }
        return s;
      }
      var A1 = rowFor('A1'), A2 = rowFor('A2'), B1 = rowFor('B1'), B2 = rowFor('B2');
      if (!A1 && !A2 && !B1 && !B2) nav.innerHTML = '<div class="small">No photos on the rolls yet — build the flight and play, or seek.</div>';
      if (A1 || A2) {
        nav.appendChild(header('A', [A1 && 'A1', A2 && 'A2'].filter(Boolean)));
        if (A2) nav.appendChild(track(A2, 'LOW'));
        if (A1) nav.appendChild(track(A1, 'HIGH'));
      }
      nav.appendChild(lineStrip());
      if (B1 || B2) {
        if (B1) nav.appendChild(track(B1, 'HIGH'));
        if (B2) nav.appendChild(track(B2, 'LOW'));
        nav.appendChild(header('B', [B1 && 'B1', B2 && 'B2'].filter(Boolean)));
      }
      /* anything else on the rolls (checks) */
      keys.forEach(function (k) { var r = rows[k]; if (['A1', 'A2', 'B1', 'B2'].indexOf(r.code) < 0) nav.appendChild(track(r, r.label)); });
      rvBuilt = { count: items.length, focus: app.focus };
    }
    /* selection marks, a badge on every photo that holds an annotation, and
       the finding's box drawn on the thumbnail where it sits in that frame */
    Array.prototype.forEach.call(nav.querySelectorAll('.ab'), function (b) { b.parentNode.removeChild(b); });
    Array.prototype.forEach.call(nav.querySelectorAll('img'), function (img) {
      var n = Number(img.dataset.n);
      img.classList.toggle('sel', app.selShots.indexOf(n) >= 0);
      var here = annotationsInPhoto(n), kinds = here.map(function (a) { return a.kind; });
      img.classList.toggle('ann-splice', kinds.indexOf('splice') >= 0);
      img.classList.toggle('ann-damage', kinds.indexOf('damage') >= 0 && kinds.indexOf('splice') < 0);
      var it = items.filter(function (x) { return x.n === n; })[0];
      if (!it) return;
      here.forEach(function (a) {
        var p0 = STAGE.wireToPixel(n, STAGE.wirePointAt(a.wireId, a.s0)), p1 = STAGE.wireToPixel(n, STAGE.wirePointAt(a.wireId, a.s1));
        if (!p0 || !p1) return;
        var b = { x0: Math.min(p0.px, p1.px) / it.w, x1: Math.max(p0.px, p1.px) / it.w, y0: Math.min(p0.py, p1.py) / it.h, y1: Math.max(p0.py, p1.py) / it.h };
        if (it.flip) b = { x0: 1 - b.x1, x1: 1 - b.x0, y0: 1 - b.y1, y1: 1 - b.y0 };
        var pad = 0.05;
        var box = document.createElement('div');
        box.className = 'ab ' + a.kind;
        box.style.left = 'calc(' + img.style.left + ' + ' + ((b.x0 - pad) * 100) + '% * ' + (parseFloat(img.style.width) / 100) + ')';
        box.style.width = ((b.x1 - b.x0 + 2 * pad) * parseFloat(img.style.width)) + '%';
        box.style.top = (4 + (b.y0 - pad) * img.clientHeight) + 'px';
        box.style.height = ((b.y1 - b.y0 + 2 * pad) * img.clientHeight) + 'px';
        box.style.zIndex = 40;
        img.parentNode.appendChild(box);
      });
    });
    /* the main image: the last picked photo */
    var n = app.selShots.length ? app.selShots[app.selShots.length - 1] : null;
    var big = $('rv-big'), info = $('rv-info');
    if (n == null) { big.hidden = true; $('rv-ov').hidden = true; $('rv-empty').hidden = false; info.hidden = true; app.rvPhoto = null; renderAnnoList(); return; }
    var cv = STAGE.rollImage(n);
    if (!cv) { big.hidden = true; $('rv-ov').hidden = true; $('rv-empty').hidden = false; info.hidden = true; app.rvPhoto = null; return; }
    big.width = cv.width; big.height = cv.height;
    big.getContext('2d').drawImage(cv, 0, 0);
    big.hidden = false; $('rv-empty').hidden = true;
    var ov = $('rv-ov'); ov.width = cv.width; ov.height = cv.height; ov.hidden = false;
    app.rvPhoto = n;
    fitBig();
    drawOverlay();
    renderAnnoList();
    var it = items.filter(function (x) { return x.n === n; })[0];
    var caps = app.shotCaps && app.shotCaps[n];
    var wires = caps ? caps.filter(function (c) { return c.wireId.indexOf('p' + app.focus + '-') === 0 && c.sharp.length; })
      .map(function (c) { return c.wireName + ' ' + c.sharp.map(function (iv) { return fmt(iv.s0, 1) + '–' + fmt(iv.s1, 1) + ' m'; }).join(', '); }) : [];
    info.hidden = false;
    info.innerHTML = '<b>' + (it && it.suffix ? it.suffix : 'PHOTO ' + n) + '</b><br>' +
      (it ? it.code + ' · WP ' + it.index + ' · ' + fmt(it.along, 1) + ' m along the span · ' + it.w + ' × ' + it.h + ' px' : '') +
      (wires.length ? '<br>sharp: ' + wires.join(' · ') : '<br>no sharp wire in this frame') +
      (app.selShots.length > 1 ? '<br>' + app.selShots.length + ' selected' : '');
    var selImg = nav.querySelector('img.sel');
    if (selImg && selImg.scrollIntoView) selImg.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  /* ---- planted defects: the training set ------------------------------------------
     Deterministic per span (seeded from the span key), so a trainee and a
     trainer see the same wires: two or three splices and two damage marks
     on random wires away from the towers. Real geometry, photographed like
     everything else; TRUTH reveals them and scores the annotations. */
  function rng(seed) {
    var h = 2166136261;
    for (var i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    return function () { h += 0x6D2B79F5; var t = Math.imul(h ^ (h >>> 15), 1 | h); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function seedDefects(i) {
    app.defects = [];
    var wires = STAGE.focusPhaseList().filter(function (ph) { return ph.span; });
    if (!wires.length) { STAGE.setDefects([]); STAGE.setTruth(null); return; }
    var r = rng(spanKey(i) || 'span'), L = wires[0].length;
    var nS = 2 + Math.floor(r() * 2), nD = 2;
    for (var k = 0; k < nS + nD; k++) {
      var w = wires[Math.floor(r() * wires.length)];
      app.defects.push({ kind: k < nS ? 'splice' : 'damage', wireId: w.id, wireName: w.name, s: 15 + r() * (L - 30) });
    }
    STAGE.setDefects(app.defects);
    STAGE.setTruth(app.prefs.truth ? app.defects : null);
  }
  $('btn-truth').classList.toggle('on', !!app.prefs.truth);
  $('btn-truth').onclick = function () {
    app.prefs.truth = !app.prefs.truth; savePrefs();
    this.classList.toggle('on', app.prefs.truth);
    STAGE.setTruth(app.prefs.truth ? app.defects : null);
    renderHud(); STAGE.render();
  };
  /* the score: each planted defect found when an annotation of its kind on
     its wire sits within 2 m */
  function truthHtml() {
    if (!app.prefs.truth || !app.defects || !app.defects.length) return '';
    var found = 0, rows = app.defects.map(function (d) {
      var hit = (app.annos || []).filter(function (a) { return a.kind === d.kind && a.wireId === d.wireId && Math.abs((a.s0 + a.s1) / 2 - d.s) <= 2; })[0];
      if (hit) found++;
      return '<div class="fr ' + (hit ? 'ok' : 'soft') + '"><b>' + (d.kind === 'splice' ? 'SPLICE' : 'DAMAGE') + '</b> ' + d.wireName + ' · ' + fmt(d.s, 1) + ' m · ' + (hit ? 'FOUND (' + fmt(Math.abs((hit.s0 + hit.s1) / 2 - d.s), 2) + ' m off)' : 'not yet annotated') + '</div>';
    });
    var falseA = (app.annos || []).filter(function (a) {
      return !app.defects.some(function (d) { return a.kind === d.kind && a.wireId === d.wireId && Math.abs((a.s0 + a.s1) / 2 - d.s) <= 2; });
    }).length;
    return '<div class="focus truth"><div class="fh">TRUTH · planted defects · ' + found + ' of ' + app.defects.length + ' found' + (falseA ? ' · ' + falseA + ' annotation' + (falseA > 1 ? 's' : '') + ' match nothing' : '') + '</div>' + rows.join('') + '</div>';
  }

  /* ---- annotations: splice (black) and damage (purple) ---------------------------
     Drawn as a box on the photo; the box centre names the wire and its left
     and right edges the interval on it (STAGE.pixelToWire); the mark goes on
     the wire in 3D and reprojects into every other photo that holds it.
     Phase 2 (real images from AWS) plugs into the same two calls. */
  app.annos = app.annos || [];
  app.anMode = null;
  function setAnMode(m) {
    app.anMode = app.anMode === m ? null : m;
    $('an-splice').classList.toggle('on', app.anMode === 'splice');
    $('an-damage').classList.toggle('on', app.anMode === 'damage');
    $('rv-imgwrap').classList.toggle('draw', !!app.anMode);
    $('an-hint').textContent = app.anMode ? 'draw a box around the ' + app.anMode + ' on the photo · Esc cancels' : 'SPLICE or DAMAGE, then draw a box on the photo';
  }
  $('an-splice').onclick = function () { setAnMode('splice'); };
  $('an-damage').onclick = function () { setAnMode('damage'); };
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && app.anMode) setAnMode(null); });

  function annotationsInPhoto(n) {
    return (app.annos || []).filter(function (a) {
      if (a.photo === n) return true;
      var m = STAGE.wirePointAt(a.wireId, (a.s0 + a.s1) / 2);
      return m && STAGE.wireToPixel(n, m);
    });
  }
  function annoLabel(a) {
    var ta = app.circuit && app.focus >= 0 ? app.circuit.towers[app.focus].name : '';
    return (a.kind === 'splice' ? 'SPLICE' : 'DAMAGE') + ' · ' + a.wireName + ' · ' + fmt((a.s0 + a.s1) / 2, 1) + ' m from ' + ta +
      (Math.abs(a.s1 - a.s0) > 0.3 ? ' (' + fmt(Math.abs(a.s1 - a.s0), 1) + ' m)' : '');
  }
  /* the overlay on the big photo: this photo's own boxes solid, the others
     reprojected dashed, all labelled */
  /* photo pixels ↔ display pixels: a flipped roll is shown rotated 180° */
  function toDisplay(n, b, W, H) {
    if (!STAGE.rollFlip(n)) return b;
    return { x0: W - b.x1, x1: W - b.x0, y0: H - b.y1, y1: H - b.y0 };
  }
  function drawOverlay(preview) {
    var ov = $('rv-ov'), n = app.rvPhoto;
    if (!ov || n == null) return;
    var g = ov.getContext('2d');
    g.clearRect(0, 0, ov.width, ov.height);
    g.lineWidth = 3; g.font = '600 18px "Barlow Condensed", "Barlow", sans-serif';
    (app.annos || []).forEach(function (a) {
      var col = a.kind === 'damage' ? '#7b2cbf' : '#000000';
      var box = null;
      if (a.photo === n && a.box) box = a.box;
      else {
        var p0 = STAGE.wireToPixel(n, STAGE.wirePointAt(a.wireId, a.s0)), p1 = STAGE.wireToPixel(n, STAGE.wirePointAt(a.wireId, a.s1));
        if (p0 && p1) {
          var pad = ov.height * 0.03;
          box = { x0: Math.min(p0.px, p1.px) - pad, x1: Math.max(p0.px, p1.px) + pad, y0: Math.min(p0.py, p1.py) - pad, y1: Math.max(p0.py, p1.py) + pad };
        }
      }
      if (!box) return;
      box = toDisplay(n, box, ov.width, ov.height);
      g.strokeStyle = col; g.setLineDash(a.photo === n ? [] : [8, 6]);
      g.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      g.setLineDash([]);
      var label = annoLabel(a) + (a.photo === n ? '' : ' · from photo ' + a.photo);
      var tw = g.measureText(label).width + 12;
      g.fillStyle = col; g.fillRect(box.x0, Math.max(0, box.y0 - 24), tw, 22);
      g.fillStyle = '#fff'; g.fillText(label, box.x0 + 6, Math.max(16, box.y0 - 7));
    });
    if (preview) {
      g.strokeStyle = app.anMode === 'damage' ? '#7b2cbf' : '#000';
      g.setLineDash([6, 4]);
      g.strokeRect(preview.x0, preview.y0, preview.x1 - preview.x0, preview.y1 - preview.y0);
      g.setLineDash([]);
    }
  }
  function renderAnnoList() {
    var host = $('rv-list');
    var list = app.annos || [];
    if (!list.length) { host.innerHTML = ''; return; }
    host.innerHTML = '<div class="h">FINDINGS ON THIS SPAN · ' + list.length + '</div>';
    list.forEach(function (a) {
      var seen = STAGE.rollList().filter(function (it) { return annotationsInPhoto(it.n).indexOf(a) >= 0; }).length;
      var row = document.createElement('div'); row.className = 'a ' + a.kind;
      row.innerHTML = '<i></i><span>' + annoLabel(a) + '</span><span class="n">in ' + seen + ' photo' + (seen === 1 ? '' : 's') + '</span><span class="x" title="remove">✕</span>';
      row.onclick = function (ev) {
        if (ev.target.classList.contains('x')) { app.annos.splice(app.annos.indexOf(a), 1); annosChanged(); return; }
        STAGE.onRollClick(a.photo, false);
      };
      host.appendChild(row);
    });
  }
  function annosChanged() {
    rememberPlace();
    if (app.prefs.truth) renderHud();
    STAGE.drawAnnotations(allAnnos());
    drawOverlay();
    renderAnnoList();
    rvBuilt.count = -1;
    if (app.review) renderReview();
    STAGE.render();
  }
  /* drawing the box */
  (function () {
    var ov = $('rv-ov'), start = null;
    function pix(ev) {
      var r = ov.getBoundingClientRect();
      return { x: (ev.clientX - r.left) / r.width * ov.width, y: (ev.clientY - r.top) / r.height * ov.height };
    }
    ov.addEventListener('pointerdown', function (ev) {
      if (!app.anMode || app.rvPhoto == null) return;
      start = pix(ev); ov.setPointerCapture(ev.pointerId); ev.preventDefault();
    });
    ov.addEventListener('pointermove', function (ev) {
      if (!start) return;
      var p = pix(ev);
      drawOverlay({ x0: Math.min(start.x, p.x), y0: Math.min(start.y, p.y), x1: Math.max(start.x, p.x), y1: Math.max(start.y, p.y) });
    });
    ov.addEventListener('pointerup', function (ev) {
      if (!start) return;
      var p = pix(ev), s = start; start = null;
      var box = { x0: Math.min(s.x, p.x), y0: Math.min(s.y, p.y), x1: Math.max(s.x, p.x), y1: Math.max(s.y, p.y) };
      if (box.x1 - box.x0 < 6 || box.y1 - box.y0 < 6) { drawOverlay(); return; }
      /* the box was drawn in display pixels; annotations live in photo pixels */
      app.addAnnotation(app.anMode, app.rvPhoto, toDisplay(app.rvPhoto, box, ov.width, ov.height));
    });
  })();
  /* the transposition itself — also the seam for phase 2 */
  app.addAnnotation = function (kind, n, box) {
    var cy = (box.y0 + box.y1) / 2;
    var c = STAGE.pixelToWire(n, (box.x0 + box.x1) / 2, cy);
    if (!c || c.dist > 3) { $('an-hint').textContent = 'no wire under that box (nearest ' + (c ? fmt(c.dist, 1) + ' m' : '–') + ') — draw it on a wire'; return null; }
    var l = STAGE.pixelToWire(n, box.x0, cy), r = STAGE.pixelToWire(n, box.x1, cy);
    var s0 = l && l.wireId === c.wireId ? l.s : c.s, s1 = r && r.wireId === c.wireId ? r.s : c.s;
    var a = { id: 'a' + Date.now().toString(36), kind: kind, photo: n, wireId: c.wireId, wireName: c.wireName,
      s0: Math.min(s0, s1), s1: Math.max(s0, s1), point: c.point, box: box, at: new Date().toISOString(),
      span: spanKey(app.focus), p0: STAGE.wirePointAt(c.wireId, Math.min(s0, s1)), p1: STAGE.wirePointAt(c.wireId, Math.max(s0, s1)) };
    app.annos.push(a);
    $('an-hint').textContent = annoLabel(a) + ' · ray-to-wire miss ' + fmt(c.dist, 2) + ' m';
    annosChanged();
    return a;
  };

  /* the photo fills whatever the navigator leaves, keeping its aspect; the
     overlay canvas rides the same box */
  function fitBig() {
    var big = $('rv-big'), main = $('rv-main') || document.querySelector('.rv-main');
    if (!big || big.hidden || !main) return;
    var aw = main.clientWidth - 28, ah = main.clientHeight - 28;
    if (aw <= 0 || ah <= 0) return;
    var asp = big.width / big.height;
    var w = Math.min(aw, ah * asp), h = w / asp;
    big.style.width = Math.round(w) + 'px'; big.style.height = Math.round(h) + 'px';
    var ov = $('rv-ov'); ov.style.width = big.style.width; ov.style.height = big.style.height;
  }
  window.addEventListener('resize', function () { fitBig(); });

  /* keep the navigator current while the flight runs with the review open */
  setInterval(function () { if (app.review && STAGE.rollsCount() !== rvBuilt.count) renderReview(); }, 500);
  $('btn-select-all').onclick = function () {
    app.selShots = Object.keys(app.shotCaps || {}).map(Number).filter(function (n) {
      var leg = app.plan && app.plan.legs.filter(function (l) { return l.shot && l.shot.n === n; })[0];
      return leg && app.pose && app.pose.t >= leg.t0 + leg.durS * 0.5 && leg.t0 + leg.durS * 0.5 >= app.rollsFrom;
    }).sort(function (a, b) { return a - b; });
    applySelection();
  };

  /* ---- the flight ------------------------------------------------------------ */
  function missionsByName(names) {
    var byName = {};
    missionsForPair(app.focus).forEach(function (m) { byName[m.name] = m; });
    return names.map(function (n) { return byName[n]; }).filter(Boolean);
  }
  function flightInput(ms, extra) {
    var first = ms[0];
    var startTowerName = first.kind === 'span' ? first.a : app.circuit.towers[app.focus].name;
    var ti = towerIndex(startTowerName);
    var st = ti >= 0 ? app.circuit.towers[ti] : app.circuit.towers[app.focus];
    var ta = app.circuit.towers[app.focus], tb = app.circuit.towers[app.focus + 1];
    return {
      launch: app.launch,
      startTower: { x: st.x, y: st.y, top: st.top, name: st.name },
      safeTop: Math.max(ta.top, tb.top),
      missions: ms.map(function (m) { return { id: m.name, code: m.code, name: m.kind === 'span' ? m.a + ' → ' + m.b : 'gimbal test', wps: m.wps }; }),
      cfg: Object.assign({ overM: app.prefs.over, vTransit: app.prefs.vt, vClimb: app.prefs.vc, gimbalCheck: $('cfg-check').checked }, extra || {})
    };
  }
  function buildPlan() {
    if (!app.launch) return;
    if ($('cfg-one').checked) { startOneAtATime(); return; }
    if (!app.sel.length) return;
    var ms = missionsByName(app.sel);
    commitFlight();
    var plan = adoptPlan(FLY.build(flightInput(ms)));
    app.plan = plan.ok ? plan : null;
    FLY.reset();
    STAGE.clearTrail();
    resetCoverage();
    resetRolls();
    STAGE.droneVisible(!!app.plan);
    if (app.plan) { app.pose = FLY.tick(0); STAGE.setDronePose(app.pose); app.focusReport = STAGE.updateFocus(); }
    renderPlan();
    renderHud();
    STAGE.render();
    return plan;
  }
  $('btn-fly').onclick = function () { stopPlay(); var p = buildPlan(); if (p && !p.ok) $('plan-meta').innerHTML = '<span class="err">' + p.summary + '</span>'; };

  /* ---- one mission at a time: the operator's cadence ---------------------------
     START opens a pop-up of the span's missions. Each pick appends that
     mission to the sequence and the flight is rebuilt from the same inputs
     (identical legs up to the hover, so the trail, photos and clock carry
     on) — straight up to safe height from wherever the aircraft is, across,
     down, execute, hover — and the pop-up returns. RETURN HOME appends the
     landing. */
  $('cfg-one').checked = !!app.prefs.oneAtATime;
  $('cfg-one').onchange = function () { app.prefs.oneAtATime = this.checked; savePrefs(); $('btn-fly').textContent = this.checked ? 'LAUNCH · PICK THE FIRST MISSION' : 'LAUNCH MISSION'; renderLaunch(); };
  $('btn-fly').textContent = $('cfg-one').checked ? 'LAUNCH · PICK THE FIRST MISSION' : 'LAUNCH MISSION';
  app.seq = []; app.homeChosen = false;
  function startOneAtATime() {
    commitFlight();
    app.seq = []; app.homeChosen = false;
    app.plan = null; FLY.load(null); app.pose = null;
    resetCoverage(); resetRolls(); STAGE.clearTrail(); STAGE.droneVisible(false);
    renderPlan(); renderHud(); STAGE.render();
    showPick();
  }
  function showPick() {
    if (!app.launch) { $('launch-meta').innerHTML = '<span class="err">Select the LZ first.</span>'; return; }
    var rows = $('pick-rows'); rows.innerHTML = '';
    var ms = missionsForPair(app.focus);
    var ORDP = { GIMBAL: -1, A1: 0, B1: 1, A2: 2, B2: 3 };
    ms.sort(function (p, q) { return (ORDP[p.code] != null ? ORDP[p.code] : 9) - (ORDP[q.code] != null ? ORDP[q.code] : 9); });
    if (!ms.length) { rows.innerHTML = '<div class="small">No missions on this span.</div>'; }
    ms.forEach(function (mi) {
      var b = document.createElement('button');
      var flown = app.seq.indexOf(mi.name) >= 0;
      b.className = flown ? 'done' : '';
      b.innerHTML = '<span class="c ' + (mi.kind === 'check' ? 'G' : mi.dir) + '">' + mi.code + (mi.level ? ' ' + mi.level : '') + '</span>' +
        '<span class="d"><span class="file">' + mi.file + '</span> · ' + mi.wps.length + ' wp · ' + mi.photos + ' photos</span>' +
        '<span class="d">' + (mi.kind === 'span' ? (mi.level === 'H' ? 'HIGH' : 'LOW') : '') + '</span>';
      b.onclick = function () { pickMission(mi.name); };
      rows.appendChild(b);
    });
    var last = app.seq.length ? missionsByName([app.seq[app.seq.length - 1]])[0] : null;
    $('pick-h').textContent = app.seq.length ? 'MISSION COMPLETE · SELECT THE NEXT' : 'SELECT THE FIRST MISSION';
    $('pick-sub').textContent = last ? 'The aircraft is holding at the end of ' + last.code + '. It will climb to safe height, cross to the start of what you pick, and fly it.'
      : 'The aircraft is on the launch spot. It will climb to safe height, cross to the start of what you pick, and fly it.';
    $('pick-home').hidden = !app.seq.length;
    $('pick').hidden = false;
  }
  function rebuildSequence(resumeT) {
    var ms = missionsByName(app.seq);
    if (!ms.length) return null;
    var plan = adoptPlan(FLY.build(flightInput(ms, { oneAtATime: true, noHome: !app.homeChosen })));
    app.plan = plan.ok ? plan : null;
    if (!app.plan) return null;
    FLY.seek(resumeT || 0);
    app.pose = FLY.tick(0);
    STAGE.droneVisible(true); STAGE.setDronePose(app.pose);
    app.focusReport = STAGE.updateFocus();
    syncCoverage(app.pose.t); syncRolls(app.pose.t);
    renderPlan(); renderHud(); STAGE.render();
    return plan;
  }
  function pickMission(name) {
    $('pick').hidden = true;
    var resumeT = app.plan ? app.plan.totalS : 0;
    app.seq.push(name);
    if (rebuildSequence(resumeT)) startPlay();
  }
  $('pick-home').onclick = function () {
    $('pick').hidden = true;
    var resumeT = app.plan ? app.plan.totalS : 0;
    app.homeChosen = true;
    if (rebuildSequence(resumeT)) startPlay();
  };
  $('pick-cancel').onclick = function () { $('pick').hidden = true; };
  /* the pause at the end of a mission brings the pop-up back */
  function onFlightEnd() {
    saveDatasetSoon();
    if ($('cfg-one').checked && app.seq.length && !app.homeChosen) showPick();
  }

  function renderPlan() {
    var p = app.plan;
    var on = !!p;
    var oneReady = $('cfg-one').checked && !!app.launch;
    $('btn-play').disabled = !(on || oneReady); $('btn-reset').disabled = !on; $('scrub').disabled = !on;
    $('plan-meta').innerHTML = on ? '<b>' + p.summary + '</b><br>' + p.legs.length + ' legs · manual out and home at ' + app.prefs.vt + ' m/s, wayline speeds as written' : '';
    var host = $('chapters'); host.innerHTML = '';
    var marks = $('chaps'); marks.innerHTML = '';
    if (!on) return;
    p.chapters.forEach(function (c, i) {
      var b = document.createElement('button');
      b.textContent = c.name;
      b.className = c.kind === 'mission' ? 'mission' : '';
      b.onclick = function () { seek(c.t0 + 0.01); };
      host.appendChild(b);
      var m = document.createElement('i');
      m.style.left = (c.t0 / p.totalS * 100) + '%';
      m.title = c.name + ' · ' + mmss(c.t0);
      m.onclick = function () { seek(c.t0 + 0.01); };
      marks.appendChild(m);
    });
  }

  /* ---- transport ------------------------------------------------------------- */
  function togglePlay() { if (app.playing) stopPlay(); else startPlay(); }
  function startPlay() {
    if ($('cfg-one').checked && !app.plan) { if (app.launch) showPick(); return; }
    if ($('cfg-one').checked && app.plan && !app.homeChosen && FLY.timeS() >= app.plan.totalS - 0.01) { showPick(); return; }
    if (!app.plan) return;
    if (FLY.timeS() >= app.plan.totalS - 0.01) { FLY.reset(); STAGE.clearTrail(); }
    app.playing = true; FLY.playing = true;
    $('btn-play').textContent = 'PAUSE';
    app.lastFrame = performance.now();
  }
  function stopPlay() {
    if (app.playing) saveDatasetSoon();
    app.playing = false; FLY.playing = false;
    $('btn-play').textContent = 'PLAY';
  }
  function seek(t) {
    if (!app.plan) return;
    var p = FLY.seek(t);
    STAGE.clearTrail();
    if (p) { app.pose = FLY.tick(0); STAGE.setDronePose(app.pose); app.focusReport = STAGE.updateFocus(); syncCoverage(app.pose.t); syncRolls(app.pose.t); }
    renderHud(); STAGE.render();
    saveDatasetSoon();
  }
  app.seek = seek; app.build = buildPlan; app.play = startPlay; app.stop = stopPlay; app.saveDataset = saveDataset; app.loadCircuit = loadCircuit; app.loadGroup = loadGroup; app.focusSpan = focusSpan; app.renderSpans = renderSpans; app.refreshInspected = refreshInspected;
  $('btn-play').onclick = togglePlay;
  $('btn-reset').onclick = function () { stopPlay(); FLY.reset(); STAGE.clearTrail(); resetCoverage(); resetRolls(); app.pose = FLY.tick(0); STAGE.setDronePose(app.pose); app.focusReport = STAGE.updateFocus(); renderHud(); STAGE.render(); };
  $('scrub').oninput = function () { if (app.plan) { stopPlay(); seek(this.value / 1000 * app.plan.totalS); } };
  Array.prototype.forEach.call($('rates').querySelectorAll('button'), function (b) {
    if (Number(b.dataset.r) === app.prefs.rate) { Array.prototype.forEach.call($('rates').children, function (x) { x.classList.remove('on'); }); b.classList.add('on'); }
    b.onclick = function () {
      app.prefs.rate = Number(b.dataset.r); savePrefs();
      Array.prototype.forEach.call($('rates').children, function (x) { x.classList.remove('on'); });
      b.classList.add('on');
    };
  });
  $('btn-chase').onclick = function () { STAGE.chase = !STAGE.chase; this.classList.toggle('on', STAGE.chase); if (STAGE.chase && app.pose) { STAGE.view.dist = Math.min(STAGE.view.dist, 60); } };
  /* the payload inset: small by default, S → M → L → OFF on the button; L
     takes 60 % of the stage width when the pilot wants to study the frame */
  var FPV_SIZES = ['S', 'M', 'L', 'OFF'];
  function fpvWidth(sz) {
    var sw = canvas.clientWidth || 900;
    return sz === 'S' ? 240 : sz === 'M' ? Math.round(Math.min(480, sw * 0.35)) : sz === 'L' ? Math.round(sw * 0.6) : 0;
  }
  function applyFpv() {
    var sz = app.prefs.fpvSize || 'S';
    STAGE.fpv.on = sz !== 'OFF';
    STAGE.fpv.w = fpvWidth(sz) || 240;
    $('btn-fpv').textContent = 'PAYLOAD · ' + sz;
    $('btn-fpv').classList.toggle('on', STAGE.fpv.on);
    renderHud();
  }
  if (app.prefs.fpv === false && !app.prefs.fpvSize) app.prefs.fpvSize = 'OFF';
  applyFpv();
  window.addEventListener('resize', applyFpv);
  $('btn-fpv').onclick = function () {
    var i = FPV_SIZES.indexOf(app.prefs.fpvSize || 'S');
    app.prefs.fpvSize = FPV_SIZES[(i + 1) % FPV_SIZES.length];
    savePrefs(); applyFpv();
  };
  $('btn-details').classList.toggle('on', !!app.prefs.details);
  $('btn-details').onclick = function () { app.prefs.details = !app.prefs.details; savePrefs(); this.classList.toggle('on', app.prefs.details); renderHud(); };
  STAGE.droneScale = app.prefs.scale || 3;
  $('btn-scale').textContent = 'DRONE ×' + STAGE.droneScale;
  $('btn-scale').onclick = function () {
    STAGE.droneScale = STAGE.droneScale >= 6 ? 1 : STAGE.droneScale * 2;
    if (STAGE.droneScale === 2) STAGE.droneScale = 3;
    app.prefs.scale = STAGE.droneScale; savePrefs();
    this.textContent = 'DRONE ×' + STAGE.droneScale;
  };

  /* ---- the KPIs: span coverage and the image data set --------------------------- */
  function spanCoverage() {
    var need = 0, got = 0, sides = { 1: 0, '-1': 0 }, faces = 0, facesDone = 0;
    STAGE.focusPhaseList().forEach(function (ph) { if (ph.span) { need += ph.length * 2; faces += 2; } });
    if (app.covSummary) Object.keys(app.covSummary).forEach(function (id) {
      var w = app.covSummary[id];
      if (!w.name || w.name.indexOf('next') >= 0) return;
      [1, -1].forEach(function (sd) { if (w.sides[sd]) { got += w.sides[sd].coveredM; sides[sd] += w.sides[sd].coveredM; if (w.sides[sd].pct >= 0.995) facesDone++; } });
    });
    /* compliance is judged per SIDE (D-A862): the A passes together must prove
       every wire's A face, the B passes the B face. The headline is the side(s)
       being flown; both sides together are the whole span. */
    var needSide = need / 2;
    var pctA = needSide > 0 ? Math.min(100, sides[1] / needSide * 100) : 0;
    var pctB = needSide > 0 ? Math.min(100, sides['-1'] / needSide * 100) : 0;
    /* each pass is judged against the lines it TARGETS (D-A863): the high pass
       (A1/B1) lines 1 and 2, the low pass (A2/B2) lines 2 and 3 — on its own
       side. The headline is the targeted wire faces of the passes flown; the
       four together target every face. */
    var wires = STAGE.focusPhaseList().filter(function (ph) { return ph.span; }).length;
    var target = {}, flown = { A: false, B: false }, tnames = [];
    /* one-at-a-time: the passes actually flown (the sequence), not the ticks */
    var flownMs = missionsByName($('cfg-one').checked ? (app.seq || []) : app.sel);
    flownMs.forEach(function (m) {
      if (m.kind !== 'span') return;
      var sd = m.dir === 'B' ? '-1' : '1'; flown[m.dir === 'B' ? 'B' : 'A'] = true;
      /* H targets lines 1–2, L lines 2–3, a single pass (no level) every line */
      var lo = m.level === 'L' ? 2 : 1, hi = m.level === 'L' ? wires : m.level === 'H' ? Math.max(1, wires - 1) : wires;
      for (var n = lo; n <= hi; n++) target[n + ':' + sd] = true;
      tnames.push(m.code + ' lines ' + lo + (hi > lo ? '\u2013' + hi : ''));
    });
    /* the denominator is every TARGETED wire face of the span, recorded or not
       (a wire never proven has no entry in the summary — it still counts) */
    var tNeed = 0, tGot = 0, spanWires = STAGE.focusPhaseList().filter(function (ph) { return ph.span; });
    spanWires.forEach(function (ph, k) {
      var n = k + 1, w = app.covSummary ? app.covSummary[ph.id] : null;
      ['1', '-1'].forEach(function (sd) { if (target[n + ':' + sd]) { tNeed += ph.length; tGot += w && w.sides[sd] ? w.sides[sd].coveredM : 0; } });
    });
    var headline = tNeed > 0 ? Math.min(100, tGot / tNeed * 100) : (flown.A && flown.B ? (pctA + pctB) / 2 : flown.B ? pctB : pctA);
    return { need: need, got: got, pct: headline, pctA: pctA, pctB: pctB, flown: flown, sides: sides, faces: faces, facesDone: facesDone, targets: tnames, tNeed: tNeed, tGot: tGot };
  }
  function renderKpis(shots, total) {
    var k = $('kpis');
    if (!app.plan) { k.hidden = true; return; }
    k.hidden = false;
    var c = spanCoverage();
    $('kpi-cov-v').textContent = fmt(c.pct, 1) + '%';
    /* faces complete first, so one pass reads as 2 of 6 faces done, not as a low score (D-A861) */
    $('kpi-cov-s').textContent = (c.targets.length ? c.targets.join(' + ') + ' · ' : '') + 'A face ' + fmt(c.pctA, 0) + '% · B face ' + fmt(c.pctB, 0) + '% · ' + c.facesDone + ' of ' + c.faces + ' faces';
    $('kpi-cov-b').style.width = c.pct + '%';
    $('kpi-cov').classList.toggle('ok', c.pct >= 99.95);
    var missions = app.plan.chapters.filter(function (ch) { return ch.kind === 'mission'; }).length;
    $('kpi-img-v').textContent = shots + ' / ' + total;
    $('kpi-img-s').textContent = 'images · ' + missions + ' mission' + (missions === 1 ? '' : 's') + ' · ' + (app.rollShots || 0) + ' on the rolls';
    $('kpi-img-b').style.width = (total ? shots / total * 100 : 0) + '%';
    $('kpi-img').classList.toggle('ok', total > 0 && shots >= total);
  }

  /* ---- HUD ---------------------------------------------------------------------- */
  function renderHud() {
    var p = app.pose, plan = app.plan;
    var hud = $('hud');
    if (!plan || !p) {
      hud.innerHTML = app.circuit ? '<div class="strip"><span class="chap">' + (app.focus >= 0 ? app.circuit.towers[app.focus].name + ' → ' + app.circuit.towers[app.focus + 1].name : '') + '</span>' +
        '<span class="sub">' + (app.sel.length ? app.sel.length + ' mission(s) selected' : 'select missions, select the LZ, launch') + '</span></div>' : '';
      $('fpvlabel').hidden = true;
      $('kpis').hidden = true;
      return;
    }
    var chap = null;
    for (var i = 0; i < plan.chapters.length; i++) if (plan.chapters[i].t0 <= p.t + 1e-6) chap = plan.chapters[i];
    var shots = FLY.shotsAt(p.t);
    var ground = STAGE.groundAt(p.x, p.y);
    var actLabel = { gimbal: 'GIMBAL ROTATE', hover: 'HOVER', photo: 'TAKE PHOTO', yaw: 'ROTATE YAW' }[p.act] || '';
    var modeLabel = { ground: 'ON THE GROUND', lift: 'CLIMB', descend: 'DESCEND', transit: 'TRANSIT', mission: 'WAYLINE', select: 'PILOT SELECTS MISSION',
      complete: 'MISSION COMPLETE · HOVER', check: 'GIMBAL CHECK', hold: 'HOLD' }[p.mode] || p.mode;
    /* one strip across the top — the 3D scene is the point — and the
       detail blocks in a drawer the DETAILS button opens */
    var pctChip = '';
    renderKpis(shots + (app.base ? app.base.shots : 0), plan.shots + (app.base ? app.base.shots : 0));
    hud.classList.toggle('open', !!app.prefs.details);
    hud.innerHTML =
      '<div class="strip">' +
      '<span class="chap">' + (chap ? chap.name : '') + '</span>' +
      '<span class="sub">' + modeLabel + (actLabel ? ' · ' + actLabel : '') + (p.wp != null ? ' · WP ' + (p.wp + 1) + (p.nav ? ' · NAVIGATION, NO PHOTO' : '') : '') + '</span>' +
      '<span class="flag' + (p.manual ? '' : ' auto') + '">' + (p.manual ? 'PILOT' : 'AIRCRAFT') + '</span>' +
      (p.shotFired ? '<span class="flag photo">PHOTO ' + (p.shot ? p.shot.n : '') + '</span>' : '') +
      '<span class="kv"><span>ALT</span>' + fmt(p.z, 1) + ' m · ' + fmt(p.z - ground, 0) + ' AGL</span>' +
      '<span class="kv"><span>HDG</span>' + fmt(((p.hdgDeg % 360) + 360) % 360, 0) + '°</span>' +
      '<span class="kv"><span>GIMBAL</span>' + fmt(p.gimbalDeg, 0) + '° / ' + fmt(p.gimbalYawDeg, 0) + '°</span>' +
      '<span class="kv"><span>SPD</span>' + fmt(p.speed, 1) + ' m/s</span>' +
      '<span class="kv"><span>PHOTOS</span>' + shots + '/' + plan.shots + '</span>' +
      '<span class="kv"><span>T</span>' + mmss(p.t) + ' / ' + mmss(plan.totalS) + '</span>' +
      pctChip +
      '</div>' +
      '<div class="details">' + focusHtml() + coverageHtml() + selShotHtml() + truthHtml() + '</div>';
    function selShotHtml() {
      var s = app.selShotInfo;
      if (!s) return '';
      var head = s.count === 1 ? 'PHOTO ' + s.n + ' · ' + s.code + ' · WP ' + s.index : s.count + ' PHOTOS SELECTED';
      return '<div class="focus sel"><div class="fh">' + (s.count === 1 ? 'SELECTED PHOTO' : 'SELECTED PHOTOS · what the data set captured sharp') + '</div><div class="fr"><b>' + head + '</b> ' +
        (s.wires.length ? s.wires.join(' · ') : 'no sharp wire in this frame') + '</div></div>';
    }
    function focusHtml() {
      var r = app.focusReport, cm = app.cam;
      if (!r || !cm || p.manual) return '';
      var rows = r.filter(function (w) { return w.inFrameM > 0.5 && w.name.indexOf('next') < 0; });
      var html = '<div class="focus"><div class="fh">IN THE FRAME · bracket ' + fmt(cm.nearM, 1) + '–' + (isFinite(cm.farM) ? fmt(cm.farM, 1) : '∞') + ' m</div>';
      if (!rows.length) html += '<div class="fr none">no wire in the frame</div>';
      rows.forEach(function (w) {
        var sharp = w.sharpM / w.inFrameM;
        var cls = sharp > 0.98 ? 'ok' : sharp > 0.5 ? 'part' : 'soft';
        html += '<div class="fr ' + cls + '"><b>' + w.name + '</b> ' + fmt(w.inFrameM, 1) + ' m in frame · ' +
          (sharp > 0.98 ? 'SHARP' : sharp > 0.02 ? fmt(sharp * 100, 0) + '% sharp' : 'SOFT') +
          ' · depth ' + fmt(w.minDepth, 1) + '–' + fmt(w.maxDepth, 1) + ' m</div>';
      });
      return html + '</div>';
    }
    function coverageHtml() {
      var s = app.covSummary;
      if (!s) return '';
      var ids = Object.keys(s).filter(function (id) { return s[id].name && s[id].name.indexOf('next') < 0; }).sort();
      if (!ids.length) return '';
      /* the span number: every wire of this span, both faces, is 100 % —
         however many passes it takes to get there */
      var need = 0, got = 0;
      /* the denominator is EVERY wire of the span, seen or not yet */
      STAGE.focusPhaseList().forEach(function (ph) { if (ph.span) need += ph.length * 2; });
      ids.forEach(function (id) {
        var w = s[id];
        [1, -1].forEach(function (sd) { if (w.sides[sd]) got += w.sides[sd].coveredM; });
      });
      var sc = spanCoverage(), pct = sc.pct;
      var html = '<div class="focus cov"><div class="big' + (pct >= 99.95 ? ' ok' : '') + '">SPAN COVERAGE ' + fmt(Math.min(100, pct), 1) + '%' +
        (sc.targets.length ? ' · ' + sc.targets.join(' + ').toUpperCase() : '') + '</div>' +
        '<div class="fh">PROVEN SHARP · ' + app.covShots + ' photos · A face ' + fmt(sc.pctA, 0) + ' % · B face ' + fmt(sc.pctB, 0) + ' % · ' + fmt(got, 0) + ' of ' + fmt(need, 0) + ' wire-face metres</div>';
      ids.forEach(function (id) {
        var w = s[id], parts = [];
        [1, -1].forEach(function (sd) {
          var x = w.sides[sd];
          if (!x) return;
          var ov = x.overlapMin != null ? ' · overlap min ' + fmt(x.overlapMin * 100, 0) + '% mean ' + fmt(x.overlapMean * 100, 0) + '%' : '';
          parts.push('<span class="' + (x.pct > 0.995 ? 'ok' : x.pct > 0 ? 'part' : 'soft') + '">' + x.lane + ' side ' + fmt(x.pct * 100, 0) + '%' + (x.gaps.length ? ' · ' + x.gaps.length + ' gap' + (x.gaps.length > 1 ? 's' : '') : '') + ov + '</span>');
        });
        html += '<div class="fr"><b>' + w.name + '</b> ' + parts.join(' &nbsp; ') + '</div>';
      });
      return html + '</div>';
    }
    var fl = $('fpvlabel');
    fl.hidden = !STAGE.fpv.on;
    fl.style.width = STAGE.fpv.w + 'px';
    fl.style.height = Math.round(STAGE.fpv.w / ((app.cam && app.cam.aspect) || 4 / 3)) + 'px';
    $('fpv-cam').textContent = 'PAYLOAD · ' + (p.camLabel || 'WIDE');
    $('fpv-osd').textContent = 'P ' + fmt(p.gimbalDeg, 0) + '° · ' + (p.shotFired ? 'REC ●' : '');
    $('clock').textContent = mmss(p.t) + ' / ' + mmss(plan.totalS) + ' · ' + app.prefs.rate + '×';
    if (!$('scrub').matches(':active')) $('scrub').value = Math.round(p.t / plan.totalS * 1000);
    Array.prototype.forEach.call($('chapters').children, function (b, k) { b.classList.toggle('now', plan.chapters[k] === chap); });
  }

  /* ---- the loop ------------------------------------------------------------------ */
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.1, (now - (app.lastFrame || now)) / 1000);
    app.lastFrame = now;
    if (app.playing && app.plan) {
      app.pose = FLY.tick(dt * app.prefs.rate);
      if (app.pose) { STAGE.setDronePose(app.pose); app.focusReport = STAGE.updateFocus(); syncCoverage(app.pose.t); syncRolls(app.pose.t); if (MAP.ready()) MAP.setDrone(app.pose); }
      if (app.pose && app.pose.done) { stopPlay(); onFlightEnd(); }
      renderHud();
      STAGE.render();
    } else if (STAGE.animating() || (app.plan && app.pose)) {
      if (app.plan && app.pose && !app.playing) { STAGE.setDronePose(app.pose); if (!app.focusReport) { app.focusReport = STAGE.updateFocus(); renderHud(); } }
      STAGE.render();
    } else {
      STAGE.render();
    }
  }
  requestAnimationFrame(frame);

  renderHud();
  status('LOAD A CIRCUIT');

  /* ---- back to where you were ---------------------------------------------------- */
  app.booting = true;
  (async function restore() {
    var keys = await STORE.keys('circuit:');
    var legacy = await STORE.get('circuit');
    if (legacy && legacy.buf) { await STORE.put(circuitKey(legacy.name), legacy.name, legacy.buf); await STORE.del('circuit'); keys.push(circuitKey(legacy.name)); }
    if (!keys.length) { app.booting = false; return; }
    for (var ci = 0; ci < keys.length; ci++) {
      var rec = await STORE.get(keys[ci]);
      if (rec && rec.buf) await addCircuit(rec.buf, rec.name, { restoring: true, select: false, key: keys[ci] });
    }
    if (!app.circuits.length) { app.booting = false; return; }
    var want = app.prefs.circuit, have = app.circuits.some(function (e) { return e.name === want; });
    selectCircuit(have ? want : app.circuits[app.circuits.length - 1].name);
    var g = await STORE.get('group');
    if (g && g.buf && g.buf.sources) {
      app.sources = g.buf.sources;
      for (var s = 0; s < app.sources.length; s++) await loadGroup(app.sources[s].payload, app.sources[s].name, { restoring: true });
    } else if (g && g.buf) { app.sources = [{ name: g.name, payload: g.buf }]; await loadGroup(g.buf, g.name, { restoring: true }); }
    var k = work().span;
    var i = spanIndexOfKey(k);
    if (i >= 0 && i !== app.focus) focusSpan(i);
    app.booting = false;
    if (app.focus >= 0 && !STAGE.rollsCount()) restoreDataset(app.focus);
    loadInspected();
  })();
})(window);

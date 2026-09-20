/* fielddb.js — the field app's database (S-0042 step 3). IndexedDB
   "asi-field": circuits (one record each: towers, conductor spans, a per-span
   mission summary, counts — the light part, kept in memory for the lists)
   and missions (one record each, keyed by circuit id + mission id, indexed
   by circuit and by circuit+span — the heavy part, read only when a span
   is opened). Bundles are validated before anything is written; a circuit
   re-imported under the same id replaces its old missions. Nothing here
   ever loads every mission of every circuit at once. */
(function (root) {
  'use strict';
  var DB = 'asi-field', VER = 1, db = null;
  function open() {
    if (db) return Promise.resolve(db);
    return new Promise(function (res, rej) {
      if (!root.indexedDB) return rej(new Error('no IndexedDB'));
      var r = indexedDB.open(DB, VER);
      r.onupgradeneeded = function () {
        var d = r.result;
        d.createObjectStore('circuits', { keyPath: 'id' });
        var ms = d.createObjectStore('missions', { keyPath: 'key' });
        ms.createIndex('byCircuit', 'circuitId');
        ms.createIndex('bySpan', ['circuitId', 'span']);
        d.createObjectStore('meta', { keyPath: 'key' });
      };
      r.onsuccess = function () { db = r.result; db.onversionchange = function () { db.close(); db = null; }; res(db); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function tx(stores, mode, fn) {
    return open().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(stores, mode), out;
        try { out = fn(t); } catch (e) { rej(e); return; }
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error || new Error('aborted')); };
      });
    });
  }
  function req(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }

  var FIELDDB = {};
  /* the light record of a bundle: everything the lists need, no waypoints */
  function circuitRecord(b) {
    var c = b.circuit, bySpan = {}, codes = {};
    b.missions.forEach(function (m) { (bySpan[m.span] = bySpan[m.span] || []).push(m.code || m.dir); codes[m.code || m.dir] = 1; });
    var lons = c.towers.map(function (t) { return t.lon; }), lats = c.towers.map(function (t) { return t.lat; });
    var km = 0;
    for (var i = 1; i < c.towers.length; i++) {
      var a = c.towers[i - 1], t = c.towers[i];
      km += Math.hypot((t.lon - a.lon) * 111320 * Math.cos(t.lat * Math.PI / 180), (t.lat - a.lat) * 110540) / 1000;
    }
    return { id: c.id, name: c.name, source: c.source || '', towers: c.towers, spans: c.spans || [], bySpan: bySpan, codes: Object.keys(codes).sort(),
      missionCount: b.missions.length, spansWithMissions: Object.keys(bySpan).length, unplaced: b.unplaced || [], stats: b.stats || null,
      lengthKm: Math.round(km * 10) / 10, bbox: [Math.min.apply(null, lons), Math.min.apply(null, lats), Math.max.apply(null, lons), Math.max.apply(null, lats)],
      generator: b.generator || '', builtAt: b.builtAt || '', importedAt: new Date().toISOString() };
  }
  /* IMPORT: validate, then replace the circuit and write its missions in batches.
     onProgress(done, total) is called per batch. Resolves the circuit record. */
  FIELDDB.importBundle = async function (bundle, onProgress) {
    var v = root.VALIDATE.bundle(bundle);
    if (v.errors.length) { var e = new Error('bundle rejected: ' + v.errors.slice(0, 3).join('; ') + (v.errors.length > 3 ? ' (+' + (v.errors.length - 3) + ' more)' : '')); e.errors = v.errors; throw e; }
    var rec = circuitRecord(bundle), cid = rec.id;
    await FIELDDB.removeCircuit(cid);
    await tx(['circuits'], 'readwrite', function (t) { t.objectStore('circuits').put(rec); });
    var M = bundle.missions, BATCH = 500;
    for (var i = 0; i < M.length; i += BATCH) {
      var slice = M.slice(i, i + BATCH);
      await tx(['missions'], 'readwrite', function (t) {
        var st = t.objectStore('missions');
        slice.forEach(function (m) { st.put(Object.assign({ key: cid + '|' + m.id, circuitId: cid }, m)); });
      });
      if (onProgress) onProgress(Math.min(M.length, i + BATCH), M.length);
    }
    rec.warnings = v.warnings;
    return rec;
  };
  FIELDDB.listCircuits = function () {
    return tx(['circuits'], 'readonly', function (t) { var out = []; t.objectStore('circuits').openCursor().onsuccess = function (ev) { var c = ev.target.result; if (!c) return; out.push(c.value); c.continue(); }; return out; })
      .then(function (out) { return out.sort(function (a, b) { return a.name.localeCompare(b.name); }); });
  };
  FIELDDB.getCircuit = function (id) { return open().then(function (d) { return req(d.transaction('circuits').objectStore('circuits').get(id)); }); };
  FIELDDB.removeCircuit = function (id) {
    return tx(['circuits', 'missions'], 'readwrite', function (t) {
      t.objectStore('circuits').delete(id);
      var idx = t.objectStore('missions').index('byCircuit');
      idx.openKeyCursor(IDBKeyRange.only(id)).onsuccess = function (ev) { var c = ev.target.result; if (!c) return; t.objectStore('missions').delete(c.primaryKey); c.continue(); };
    });
  };
  /* the missions of one span, full records, in flight order (A1 B1 A2 B2, A B) */
  FIELDDB.missionsForSpan = function (circuitId, span) {
    return open().then(function (d) { return req(d.transaction('missions').objectStore('missions').index('bySpan').getAll(IDBKeyRange.only([circuitId, span]))); })
      .then(function (ms) { var ORD = { A1: 0, B1: 1, A2: 2, B2: 3, A: 0, B: 1 }; return ms.sort(function (p, q) { return (ORD[p.code] != null ? ORD[p.code] : 9) - (ORD[q.code] != null ? ORD[q.code] : 9); }); });
  };
  FIELDDB.getMission = function (circuitId, id) { return open().then(function (d) { return req(d.transaction('missions').objectStore('missions').get(circuitId + '|' + id)); }); };
  FIELDDB.countMissions = function () { return open().then(function (d) { return req(d.transaction('missions').objectStore('missions').count()); }); };
  /* PURGE: every circuit and mission (completions live elsewhere, step 6) */
  FIELDDB.purge = function () { return tx(['circuits', 'missions', 'meta'], 'readwrite', function (t) { t.objectStore('circuits').clear(); t.objectStore('missions').clear(); t.objectStore('meta').clear(); }); };
  FIELDDB.estimate = function () { return navigator.storage && navigator.storage.estimate ? navigator.storage.estimate() : Promise.resolve(null); };
  root.FIELDDB = FIELDDB;
})(window);

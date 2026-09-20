/* validate.js — the ASI bundle contract (DOCS/ASI BUNDLE FORMAT v1.md) as a
   pure function, shared by the app's IMPORT (browser) and by
   tools/validate-bundle.mjs (Node). Returns { errors, warnings, summary }:
   errors mean the file will not import; warnings mean something is missing. */
(function (root) {
  'use strict';
  var CODES = { A: { H: 'A1', L: 'A2' }, B: { H: 'B1', L: 'B2' } };
  var ACTIONS = { gimbal: 1, photo: 1, hover: 1, zoom: 1, yaw: 1, other: 1 };
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function validateBundle(b) {
    var errors = [], warnings = [];
    function err(m) { errors.push(m); }
    function warn(m) { warnings.push(m); }
    if (!b || typeof b !== 'object') return { errors: ['not a JSON object'], warnings: warnings };
    if (b.format !== 'asi-bundle') err('format must be "asi-bundle"');
    if (b.version !== 1) err('version must be 1');
    var c = b.circuit;
    if (!c || typeof c !== 'object') { err('circuit missing'); return { errors: errors, warnings: warnings }; }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id || '')) err('circuit.id must be a slug of lowercase letters, digits and hyphens');
    if (!c.name) err('circuit.name missing');
    var T = Array.isArray(c.towers) ? c.towers : [];
    if (T.length < 2) err('circuit.towers needs at least 2 towers');
    var names = {};
    T.forEach(function (t, i) {
      if (!t || typeof t.name !== 'string' || !t.name) err('towers[' + i + '].name missing');
      else if (names[t.name] != null) err('towers[' + i + '].name "' + t.name + '" duplicates towers[' + names[t.name] + ']'); else names[t.name] = i;
      if (!isNum(t.lon) || t.lon < -180 || t.lon > 180) err('towers[' + i + '].lon invalid');
      if (!isNum(t.lat) || t.lat < -90 || t.lat > 90) err('towers[' + i + '].lat invalid');
      if (!isNum(t.base) || !isNum(t.top)) err('towers[' + i + '] base/top must be numbers');
      else if (t.top < t.base) err('towers[' + i + '] top below base');
    });
    var S = Array.isArray(c.spans) ? c.spans : [], withCond = 0;
    S.forEach(function (s, k) {
      if (!(Number.isInteger(s.i)) || s.i < 0 || s.i + 1 >= T.length) { err('spans[' + k + '].i out of range'); return; }
      if (s.a !== T[s.i].name || s.b !== T[s.i + 1].name) err('spans[' + k + '] a/b must be towers[' + s.i + ']/towers[' + (s.i + 1) + '] (' + T[s.i].name + '/' + T[s.i + 1].name + ')');
      if (Array.isArray(s.conductors) && s.conductors.length) {
        withCond++;
        s.conductors.forEach(function (w, j) {
          if (!Array.isArray(w.pts) || w.pts.length < 2) err('spans[' + k + '].conductors[' + j + '] needs at least 2 points');
          else w.pts.forEach(function (p, n) { if (!Array.isArray(p) || p.length < 3 || !p.slice(0, 3).every(isNum)) err('spans[' + k + '].conductors[' + j + '].pts[' + n + '] must be [lon, lat, alt]'); });
        });
      }
    });
    if (!S.length || !withCond) warn('no span carries conductor geometry: the app will hang notional wires');
    var M = Array.isArray(b.missions) ? b.missions : [];
    if (!Array.isArray(b.missions)) err('missions must be an array');
    var ids = {}, noEll = 0, photosTotal = 0;
    M.forEach(function (m, k) {
      var at = 'missions[' + k + ']';
      if (!m.id) err(at + '.id missing'); else if (ids[m.id]) err(at + '.id "' + m.id + '" duplicated'); else ids[m.id] = 1;
      if (!Number.isInteger(m.span) || m.span < 0 || m.span + 1 >= T.length) { err(at + '.span out of range'); return; }
      var ta = T[m.span].name, tb = T[m.span + 1].name;
      if (m.dir !== 'A' && m.dir !== 'B') err(at + '.dir must be A or B');
      else if (m.dir === 'A' ? (m.a !== ta || m.b !== tb) : (m.a !== tb || m.b !== ta)) err(at + ' a/b (' + m.a + ' → ' + m.b + ') do not match span ' + m.span + ' in direction ' + m.dir);
      if (m.level === null || m.level === undefined) { if (m.code !== m.dir) err(at + '.code "' + m.code + '" must equal dir ' + m.dir + ' when level is null (one pass per direction)'); }
      else if (m.level !== 'H' && m.level !== 'L') err(at + '.level must be H, L or null');
      else if (CODES[m.dir] && m.code !== CODES[m.dir][m.level]) err(at + '.code "' + m.code + '" does not match dir ' + m.dir + ' level ' + m.level + ' (' + CODES[m.dir][m.level] + ')');
      if (m.placedBy !== 'name' && m.placedBy !== 'position') err(at + '.placedBy must be name or position');
      var W = Array.isArray(m.wps) ? m.wps : [];
      if (!W.length) err(at + '.wps empty');
      var photos = 0;
      W.forEach(function (w, n) {
        var wat = at + '.wps[' + n + ']';
        if (w.index !== n) err(wat + '.index must be ' + n);
        if (!isNum(w.lon) || !isNum(w.lat) || !isNum(w.alt)) err(wat + ' lon/lat/alt must be numbers');
        if (w.ellipsoid == null) noEll++;
        if (w.speed != null && !isNum(w.speed)) err(wat + '.speed must be a number or null');
        if (w.hdg != null && !isNum(w.hdg)) err(wat + '.hdg must be a number or null');
        var A = Array.isArray(w.actions) ? w.actions : null;
        if (!A) err(wat + '.actions must be an array (may be empty)');
        else A.forEach(function (a, q) { if (!ACTIONS[a.type]) err(wat + '.actions[' + q + '].type "' + a.type + '" unknown'); if (a.type === 'photo') photos++; if (a.type === 'gimbal' && a.pitch != null && !isNum(a.pitch)) err(wat + '.actions[' + q + '].pitch must be a number'); });
      });
      if (m.photos !== photos) err(at + '.photos is ' + m.photos + ', but ' + photos + ' photo actions were found');
      photosTotal += photos;
    });
    if (noEll) warn(noEll + ' waypoint(s) without ellipsoid heights');
    if (!Array.isArray(b.unplaced)) err('unplaced must be an array (may be empty)');
    else b.unplaced.forEach(function (u, k) { if (!u.file || !u.reason) err('unplaced[' + k + '] needs file and reason'); });
    if (b.stats) {
      if (b.stats.towers != null && b.stats.towers !== T.length) err('stats.towers ' + b.stats.towers + ' but ' + T.length + ' towers');
      if (b.stats.missions != null && b.stats.missions !== M.length) err('stats.missions ' + b.stats.missions + ' but ' + M.length + ' missions');
    } else warn('no stats block');
    return { errors: errors, warnings: warnings, summary: { towers: T.length, spans: Math.max(0, T.length - 1), spansWithConductors: withCond, missions: M.length, photos: photosTotal } };
  }
  root.VALIDATE = { bundle: validateBundle };
})(typeof window !== 'undefined' ? window : globalThis);

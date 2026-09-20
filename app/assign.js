/* assign.js — missions onto spans and circuits, as pure arithmetic (S-0042 /
   D-A878). One rule set for the installer (Node) and the app (browser):

   1. BY NAME: the file name names two towers ("467AH_200-1485to200-1486");
      a circuit that has both towers as consecutive towers owns the span.
   2. BY POSITION: otherwise, the circuit whose bounding box holds the first
      waypoint is tried; the span whose centreline is nearest the waypoints'
      centroid (within REACH metres) owns it; direction from which end the
      first waypoint is nearer (with the line = A); level by pairing (of two
      same-direction passes on a span, the higher is H = 1, the lower L = 2;
      a lone placed pass is called H).
   3. Gimbal tests (kind 'check') are ignored; anything else that places
      nowhere is returned in `unplaced` with the reason.

   Circuits must be projected (GEO.project) before calling. Missions carry
   raw lon/lat/alt waypoints; they are projected here into the candidate
   circuit's frame as needed. */
(function (root) {
  'use strict';
  var ASSIGN = {};
  var REACH = 150;      /* metres from the span centreline the waypoints must lie within */

  /* "000/001A", "000001A", "000-001A" and "SAN_LUIS_OBISPO_SUB" / "SANLUISOBISPOSUB" are the same tower */
  function norm(n) { return String(n || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  ASSIGN.norm = norm;
  function towerMap(c) {
    if (c._tmap) return c._tmap;
    var m = {}; c.towers.forEach(function (t, i) { m[t.name] = i; m[norm(t.name)] = i; });
    c._tmap = m; return m;
  }
  function bbox(c) {
    if (c._bbox) return c._bbox;
    var b = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
    c.towers.forEach(function (t) { b.minLon = Math.min(b.minLon, t.lon); b.maxLon = Math.max(b.maxLon, t.lon); b.minLat = Math.min(b.minLat, t.lat); b.maxLat = Math.max(b.maxLat, t.lat); });
    c._bbox = b; return b;
  }
  function segD(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    var t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }
  function d2(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

  /* by name: the circuit index and the span index (first tower of the pair) */
  ASSIGN.byName = function (circuits, m) {
    if (m.kind !== 'span' || !m.a || !m.b) return null;
    for (var ci = 0; ci < circuits.length; ci++) {
      var tm = towerMap(circuits[ci]), ia = tm[m.a] != null ? tm[m.a] : tm[norm(m.a)], ib = tm[m.b] != null ? tm[m.b] : tm[norm(m.b)];
      if (ia == null || ib == null) continue;
      if (Math.abs(ia - ib) !== 1) continue;
      /* the oblique scheme names the towers in LINE order for both passes and
         says the direction with its suffix; the span scheme names them in
         flight order. The decoded direction wins when the name carries one. */
      var dir = m.dir === 'A' || m.dir === 'B' ? m.dir : (ia < ib ? 'A' : 'B');
      return { circuit: ci, span: Math.min(ia, ib), placedBy: 'name', dir: dir };
    }
    return null;
  };
  /* by position: within the circuits whose box holds the first waypoint */
  ASSIGN.byPosition = function (circuits, m) {
    var w0 = m.wps && m.wps[0]; if (!w0 || m.wps.length < 2) return null;
    var margin = 0.02;  /* ~2 km of longitude / latitude */
    var best = null;
    for (var ci = 0; ci < circuits.length; ci++) {
      var c = circuits[ci], b = bbox(c);
      if (w0.lon < b.minLon - margin || w0.lon > b.maxLon + margin || w0.lat < b.minLat - margin || w0.lat > b.maxLat + margin) continue;
      var f = c.frame, pts = m.wps.map(function (w) { return f.toXY({ lon: w.lon, lat: w.lat, alt: w.alt || 0 }); });
      var cx = 0, cy = 0; pts.forEach(function (p) { cx += p.x / pts.length; cy += p.y / pts.length; });
      var T = c.towers, bi = -1, bd = Infinity;
      for (var i = 0; i + 1 < T.length; i++) { var d = segD({ x: cx, y: cy }, T[i], T[i + 1]); if (d < bd) { bd = d; bi = i; } }
      if (bi < 0 || bd > REACH || (best && bd >= best.d)) continue;
      var ta = T[bi], tb = T[bi + 1], p0 = pts[0], pn = pts[pts.length - 1];
      var fwd = d2(p0, ta) + d2(pn, tb) <= d2(p0, tb) + d2(pn, ta);
      best = { circuit: ci, span: bi, placedBy: 'position', dir: fwd ? 'A' : 'B', d: bd, meanAlt: m.wps.reduce(function (s, w) { return s + (w.alt || 0); }, 0) / m.wps.length };
    }
    return best;
  };
  /* the whole set: returns { placed: [{ mission, circuit, span, placedBy, code, dir, level, a, b }], unplaced: [{ mission, reason }], ignored: n } */
  ASSIGN.place = function (circuits, missions) {
    var placed = [], unplaced = [], ignored = 0, pending = {};
    missions.forEach(function (m) {
      if (m.kind === 'check') { ignored++; return; }
      var hit = ASSIGN.byName(circuits, m) || ASSIGN.byPosition(circuits, m);
      if (!hit) { unplaced.push({ mission: m, reason: m.kind === 'span' ? 'towers ' + m.a + ' / ' + m.b + ' are not consecutive towers of any loaded circuit, and the waypoints lie near no span' : 'file name carries no span code and the waypoints lie near no span' }); return; }
      var c = circuits[hit.circuit], ta = c.towers[hit.span], tb = c.towers[hit.span + 1];
      var rec = { mission: m, circuit: hit.circuit, span: hit.span, placedBy: hit.placedBy, dir: hit.dir,
        a: hit.dir === 'A' ? ta.name : tb.name, b: hit.dir === 'A' ? tb.name : ta.name,
        level: hit.placedBy === 'name' ? (m.level || null) : null, code: hit.placedBy === 'name' ? m.code : null, meanAlt: hit.meanAlt };
      /* a named single-pass scheme keeps level null and code = direction; only
         position-placed passes get H/L by pairing */
      if (hit.placedBy === 'position') { var k = hit.circuit + ':' + hit.span + ':' + hit.dir; (pending[k] = pending[k] || []).push(rec); }
      placed.push(rec);
    });
    /* level by pairing for the position-placed */
    Object.keys(pending).forEach(function (k) {
      var ms = pending[k].sort(function (p, q) { return q.meanAlt - p.meanAlt; });
      ms.forEach(function (r, i) { r.level = i === 0 ? 'H' : 'L'; r.code = r.dir + (i === 0 ? '1' : '2'); });
    });
    placed.forEach(function (r) { delete r.meanAlt; });
    return { placed: placed, unplaced: unplaced, ignored: ignored };
  };
  root.ASSIGN = ASSIGN;
})(typeof window !== 'undefined' ? window : globalThis);

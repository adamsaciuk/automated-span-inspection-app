/* coverage.js — the cookie trail as arithmetic: what each shot captured
   sharp, per wire and per SIDE of the wire, merged into the intervals that
   have been proven so far, with the shot-to-shot overlap along the way.

   Positions are arc length s (metres from the start tower) along a wire.
   A side is +1 or −1: which face of the wire the camera was on (the sign
   of the camera's horizontal offset from the wire, across the line). The
   A lane and the B lane are on opposite sides, so a wire is done when both
   sides are covered.

   Pure: no DOM, no Three.js — the stage hands in intervals, this keeps the
   books. Rebuilt from scratch on a seek, so the trail is always a function
   of the sim clock, never of the path the user scrubbed. */
(function (root) {
  'use strict';
  var COV = {};

  function merge(list) {
    list.sort(function (a, b) { return a.s0 - b.s0; });
    var out = [];
    list.forEach(function (iv) {
      var last = out[out.length - 1];
      if (last && iv.s0 <= last.s1 + 0.05) last.s1 = Math.max(last.s1, iv.s1);
      else out.push({ s0: iv.s0, s1: iv.s1 });
    });
    return out;
  }
  function length(list) { return list.reduce(function (n, iv) { return n + (iv.s1 - iv.s0); }, 0); }
  function intersect(a, b) {
    var n = 0;
    a.forEach(function (p) { b.forEach(function (q) { n += Math.max(0, Math.min(p.s1, q.s1) - Math.max(p.s0, q.s0)); }); });
    return n;
  }

  COV.create = function () {
    return { wires: {}, shots: [], lastByMission: {} };
  };
  function wireRec(cov, wireId, side) {
    var w = cov.wires[wireId] = cov.wires[wireId] || { sides: {}, length: 0 };
    return w.sides[side] = w.sides[side] || { covered: [], overlaps: [] };
  };

  /* shot: { n, mission, code, index }; captures: [{ wireId, wireLength,
     side, sharp: [{s0,s1}], inFrame: [{s0,s1}] }] */
  COV.record = function (cov, shot, captures) {
    var rec = { n: shot.n, mission: shot.mission, code: shot.code, index: shot.index, wires: {} };
    captures.forEach(function (c) {
      var sharp = merge(c.sharp.slice());
      if (!sharp.length) return;
      var side = wireRec(cov, c.wireId, c.side);
      cov.wires[c.wireId].length = c.wireLength;
      cov.wires[c.wireId].name = c.wireName;
      if (!side.lane) side.lane = shot.code ? shot.code[0] : '?';
      /* overlap with the previous shot of the same mission on this wire+side */
      var prev = cov.lastByMission[shot.mission] && cov.lastByMission[shot.mission].wires[c.wireId + '|' + c.side];
      var ov = null;
      if (prev) {
        var inter = intersect(prev, sharp);
        var shorter = Math.min(length(prev), length(sharp));
        ov = shorter > 0 ? inter / shorter : 0;
        side.overlaps.push({ n: shot.n, pct: ov });
      }
      side.covered = merge(side.covered.concat(sharp));
      rec.wires[c.wireId + '|' + c.side] = sharp;
      rec.overlap = rec.overlap == null || (ov != null && ov < rec.overlap) ? ov : rec.overlap;
    });
    cov.shots.push(rec);
    cov.lastByMission[shot.mission] = rec;
    return rec;
  };

  /* per wire per side: covered metres, %, gap list, overlap min/mean */
  COV.summary = function (cov) {
    var out = {};
    Object.keys(cov.wires).forEach(function (wid) {
      var w = cov.wires[wid], sides = {};
      Object.keys(w.sides).forEach(function (sd) {
        var s = w.sides[sd];
        var cov1 = length(s.covered);
        var gaps = [];
        var cursor = 0;
        s.covered.forEach(function (iv) { if (iv.s0 - cursor > 0.3) gaps.push({ s0: cursor, s1: iv.s0 }); cursor = Math.max(cursor, iv.s1); });
        if (w.length - cursor > 0.3) gaps.push({ s0: cursor, s1: w.length });
        var ovs = s.overlaps.map(function (o) { return o.pct; });
        sides[sd] = {
          lane: s.lane, coveredM: cov1, pct: w.length > 0 ? cov1 / w.length : 0, gaps: gaps,
          overlapMin: ovs.length ? Math.min.apply(null, ovs) : null,
          overlapMean: ovs.length ? ovs.reduce(function (a, b) { return a + b; }, 0) / ovs.length : null,
          shots: s.overlaps.length + 1
        };
      });
      out[wid] = { name: w.name, length: w.length, sides: sides };
    });
    return out;
  };

  COV._merge = merge; COV._intersect = intersect; COV._length = length;
  root.COVERAGE = COV;
})(typeof window !== 'undefined' ? window : globalThis);

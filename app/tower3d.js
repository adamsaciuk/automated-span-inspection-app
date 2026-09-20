/* tower3d.js — lattice transmission towers as line segments, in metres.

   The tower is data-driven: its base and peak come from the circuit, its
   arms hang where the circuit's conductors attach. Nothing here knows
   about Three.js; it returns flat segment lists {a:[x,y,z], b:[x,y,z], w}
   in the local frame (x east, y north, z absolute) and the stage draws
   them as fat lines. Two levels of detail: LATTICE for the spans in
   focus, STICK for the hundreds of towers along the rest of the circuit.

   Body proportions are the ones the D-A806 drawing used, scaled to each
   tower's own height; arms are drawn on BOTH sides of the body (the
   self-supporting double-circuit form) while conductors hang only where
   the circuit strings them — an assumption to revisit once a circuit
   says otherwise. */
(function (root) {
  'use strict';
  var T3 = {};

  function lerp(a, b, t) { return a + (b - a) * t; }

  /* attach = [{dx, dy, dz}] — conductor attach points relative to the
     tower base, in the local frame; along = unit vector of the line
     direction at this tower (so arms go abeam of the line). */
  T3.lattice = function (tower, attach, along) {
    var S = [];
    var seg = function (a, b, w) { S.push({ a: a, b: b, w: w || 1 }); };
    var ox = tower.x, oy = tower.y, oz = tower.z;
    var H = Math.max(12, tower.top - tower.z);
    /* abeam unit vector (left of travel, then mirrored) */
    var ax = -along.y, ay = along.x;
    var lx = along.x, ly = along.y;
    /* local (u along, v abeam, h up) → world */
    function W(u, v, h) { return [ox + lx * u + ax * v, oy + ly * u + ay * v, oz + h]; }

    var INS = 2.2;                       /* insulator string length */
    var arms = attach.map(function (p) {
      var v = p.dx * ax + p.dy * ay;     /* abeam offset of the attach point */
      var u = p.dx * lx + p.dy * ly;
      return { v: v, u: u, h: p.dz + INS, attachH: p.dz };
    }).sort(function (p, q) { return q.h - p.h; });
    var lowestArm = arms.length ? arms[arms.length - 1].h : H * 0.6;
    var bodyTop = Math.max(6, lowestArm - 3);
    var BASE = Math.max(2.5, H * 0.115), WAIST = Math.max(0.9, H * 0.035);

    /* body: tapered square frustum, N panels, X braces on every face */
    var N = Math.max(4, Math.round(bodyTop / 5));
    var lv = [];
    for (var i = 0; i <= N; i++) {
      var f = i / N, hw = lerp(BASE, WAIST, f), z = lerp(0, bodyTop, f);
      lv.push([W(-hw, -hw, z), W(hw, -hw, z), W(hw, hw, z), W(-hw, hw, z)]);
    }
    for (i = 0; i < N; i++) {
      var lo = lv[i], hi = lv[i + 1];
      for (var c = 0; c < 4; c++) {
        var d = (c + 1) % 4;
        seg(lo[c], hi[c], 1.6);
        seg(lo[c], lo[d], 0.8);
        seg(lo[c], hi[d], 0.45); seg(lo[d], hi[c], 0.45);
      }
    }
    /* head: a straight column from the body top to the peak */
    var peakZ = H;
    var head = [W(-WAIST, -WAIST, bodyTop), W(WAIST, -WAIST, bodyTop), W(WAIST, WAIST, bodyTop), W(-WAIST, WAIST, bodyTop)];
    var crown = [W(-WAIST * 0.5, -WAIST * 0.5, peakZ - 1.5), W(WAIST * 0.5, -WAIST * 0.5, peakZ - 1.5), W(WAIST * 0.5, WAIST * 0.5, peakZ - 1.5), W(-WAIST * 0.5, WAIST * 0.5, peakZ - 1.5)];
    for (c = 0; c < 4; c++) {
      seg(head[c], crown[c], 1.4);
      seg(crown[c], crown[(c + 1) % 4], 0.8);
    }
    /* the peak: a pyramid to the shield-wire tip */
    var tip = W(0, 0, peakZ);
    for (c = 0; c < 4; c++) seg(crown[c], tip, 0.9);
    /* girts at each arm height, X-braced between arms */
    var levels = arms.map(function (a) { return a.h; }).concat([bodyTop]);
    levels.forEach(function (z2) {
      if (z2 <= bodyTop + 0.1 || z2 >= peakZ - 1.5) return;
      var ring = [W(-WAIST, -WAIST, z2), W(WAIST, -WAIST, z2), W(WAIST, WAIST, z2), W(-WAIST, WAIST, z2)];
      for (var k = 0; k < 4; k++) seg(ring[k], ring[(k + 1) % 4], 0.8);
    });
    /* arms: a box truss abeam, both sides, then the insulator and the
       attach point on the strung side */
    arms.forEach(function (a) {
      var reach = Math.abs(a.v) + 0.6;
      [-1, 1].forEach(function (sgn) {
        var vEnd = sgn * reach;
        var top = a.h + 1.1, bot = a.h;
        seg(W(-WAIST, sgn * WAIST, bot), W(-WAIST * 0.6, vEnd, bot), 1.2);
        seg(W(WAIST, sgn * WAIST, bot), W(WAIST * 0.6, vEnd, bot), 1.2);
        seg(W(-WAIST, sgn * WAIST, top), W(-WAIST * 0.6, vEnd, top), 0.9);
        seg(W(WAIST, sgn * WAIST, top), W(WAIST * 0.6, vEnd, top), 0.9);
        seg(W(-WAIST * 0.6, vEnd, bot), W(WAIST * 0.6, vEnd, bot), 0.9);
        seg(W(-WAIST * 0.6, vEnd, top), W(WAIST * 0.6, vEnd, top), 0.6);
        seg(W(-WAIST * 0.6, vEnd, bot), W(-WAIST * 0.6, vEnd, top), 0.6);
        seg(W(WAIST * 0.6, vEnd, bot), W(WAIST * 0.6, vEnd, top), 0.6);
        var midV = sgn * (reach + WAIST) / 2;
        seg(W(-WAIST * 0.8, midV, bot), W(-WAIST * 0.8, sgn * reach * 0.98, top), 0.4);
        seg(W(WAIST * 0.8, midV, bot), W(WAIST * 0.8, sgn * reach * 0.98, top), 0.4);
      });
      /* insulator string down to the conductor on the strung side */
      seg(W(a.u, a.v, a.h), W(a.u, a.v, a.attachH), 0.8);
    });
    return S;
  };

  /* far towers: one upright and a short peak cross, cheap by the hundred */
  T3.stick = function (tower) {
    var H = Math.max(12, tower.top - tower.z);
    return [
      { a: [tower.x, tower.y, tower.z], b: [tower.x, tower.y, tower.z + H], w: 1.2 },
      { a: [tower.x - 2.5, tower.y, tower.z + H * 0.75], b: [tower.x + 2.5, tower.y, tower.z + H * 0.75], w: 0.8 }
    ];
  };

  root.TOWER3D = T3;
})(typeof window !== 'undefined' ? window : globalThis);

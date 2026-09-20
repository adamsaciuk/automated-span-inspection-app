/* geo.js — WGS84 → local metres. One equirectangular frame anchored at
   the circuit's centroid: x east, y north, z = the source's absolute
   altitude. Good to well under a metre across a line of this length; the
   picture is what matters, and every figure the HUD shows comes from the
   source altitudes and the true span geometry, not from the projection. */
(function (root) {
  'use strict';
  var R = 6371000, D2R = Math.PI / 180;
  var GEO = {};

  GEO.frame = function (lon0, lat0) {
    var kx = D2R * R * Math.cos(lat0 * D2R), ky = D2R * R;
    return {
      lon0: lon0, lat0: lat0,
      toXY: function (p) { return { x: (p.lon - lon0) * kx, y: (p.lat - lat0) * ky, z: p.alt || 0 }; },
      toLL: function (x, y) { return { lon: lon0 + x / kx, lat: lat0 + y / ky }; }
    };
  };

  /* project every point of a circuit in place (adds x, y, z) */
  GEO.project = function (circuit) {
    var n = circuit.towers.length || 1, sl = 0, sa = 0;
    circuit.towers.forEach(function (t) { sl += t.lon; sa += t.lat; });
    var f = GEO.frame(sl / n, sa / n);
    circuit.frame = f;
    circuit.towers.forEach(function (t) {
      var q = f.toXY({ lon: t.lon, lat: t.lat, alt: t.base });
      t.x = q.x; t.y = q.y; t.z = t.base;
    });
    circuit.spans.forEach(function (s) {
      s.phases.forEach(function (ph) { ph.xyz = ph.pts.map(f.toXY); });
      s.missions.forEach(function (m) {
        m.pathXYZ = m.path.map(f.toXY);
        m.wpXYZ = m.wps.map(f.toXY);
        m.phases.forEach(function (ph) { ph.xyz = ph.pts.map(f.toXY); });
      });
    });
    return circuit;
  };

  /* project a WPML mission group into an existing circuit's frame */
  GEO.projectGroup = function (group, frame) {
    group.missions.forEach(function (m) {
      m.wps.forEach(function (w) {
        var q = frame.toXY({ lon: w.lon, lat: w.lat, alt: w.alt });
        w.x = q.x; w.y = q.y; w.z = q.z;
      });
    });
    return group;
  };

  GEO.dist2 = function (a, b) { return Math.hypot(b.x - a.x, b.y - a.y); };
  GEO.dist3 = function (a, b) { return Math.hypot(b.x - a.x, b.y - a.y, (b.z || 0) - (a.z || 0)); };
  /* compass bearing a → b, degrees clockwise from north */
  GEO.bearing = function (a, b) {
    return ((Math.atan2(b.x - a.x, b.y - a.y) / D2R) + 360) % 360;
  };

  root.GEO = GEO;
})(typeof window !== 'undefined' ? window : globalThis);

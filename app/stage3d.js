/* stage3d.js — the wireframe stage: a whole circuit as sticks and a
   route line, the spans in focus as full lattice towers with their
   conductors, the instructed missions, the launch pad, the drone with
   its payload view. Hidden-line style throughout: ink on the page, fat
   lines that keep their width at any zoom.

   Frame: local metres, x east, y north, z up (absolute). Three.js is
   Y-up, so a point (x, y, z) is placed at (x, z, -y).

   A span here is a consecutive tower pair of the circuit (index i joins
   towers[i] and towers[i+1]). Where the circuit carries conductor
   geometry for a pair it is drawn as given; elsewhere three notional
   phases hang from the arms so a full circuit still reads as a line. */
(function (root) {
  'use strict';

  var ST = {};
  var C = { bg: '#f2f2f3', ink: '#1d1f20', soft: '#b7b7ba', faint: '#d7d7da',
    acc: '#f47b47', a: '#2f6fed', b: '#d64545', pad: '#f47b47' };

  var renderer, scene, camera, canvas, lineRes;
  var view = { az: 0.9, el: 0.38, dist: 320, tx: 0, ty: 40, tz: 0 };
  var viewAnim = null;
  var layers = { route: null, sticks: null, focus: null, missions: null, launch: null, ground: null };
  var circuit = null, group = null, focusIdx = -1, selection = {};
  var groundMesh = null, groundZ = 0;
  var pickMode = false;
  ST.onGroundPick = null;
  ST.chase = false;
  ST.droneScale = 3;

  /* ---- fat line helpers -------------------------------------------------- */
  function fatMat(color, widthPx, opacity, dashed) {
    var m = new THREE.LineMaterial({ linewidth: widthPx, transparent: true, opacity: opacity,
      dashed: !!dashed, dashSize: 1.2, gapSize: 1.6 });
    m.color = new THREE.Color(color);
    m.uniforms.resolution.value = lineRes;
    return m;
  }
  function fatSegments(pts, mat) {
    var flat = new Float32Array(pts.length * 3);
    for (var i = 0; i < pts.length; i++) {
      flat[i * 3] = pts[i].x; flat[i * 3 + 1] = pts[i].y; flat[i * 3 + 2] = pts[i].z;
    }
    var seg = new THREE.LineSegments2(new THREE.LineSegmentsGeometry().setPositions(flat), mat);
    if (mat.dashed) seg.computeLineDistances();
    return seg;
  }
  function fatEdges(geom, threshold, mat) {
    var eg = new THREE.EdgesGeometry(geom, threshold == null ? 20 : threshold);
    var lg = new THREE.LineSegmentsGeometry().fromEdgesGeometry(eg);
    eg.dispose();
    return new THREE.LineSegments2(lg, mat);
  }
  function V(x, y, z) { return new THREE.Vector3(x, z, -y); }
  function polylineSegs(pts) {
    var out = [];
    for (var i = 1; i < pts.length; i++) { out.push(V(pts[i - 1].x, pts[i - 1].y, pts[i - 1].z), V(pts[i].x, pts[i].y, pts[i].z)); }
    return out;
  }
  function disposeGroup(g) {
    if (!g) return;
    g.traverse(function (o) { if (o.geometry) o.geometry.dispose(); });
    scene.remove(g);
  }

  /* ---- init & camera ------------------------------------------------------ */
  ST.init = function (canvasEl) {
    canvas = canvasEl;
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(new THREE.Color(C.bg), 1);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, 1, 0.5, 300000);
    lineRes = new THREE.Vector2(1, 1);
    ST.setSize(canvas.clientWidth || 900, canvas.clientHeight || 600);

    var drag = null;
    canvas.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    canvas.addEventListener('pointerdown', function (ev) {
      drag = { x: ev.clientX, y: ev.clientY, b: ev.button, shift: ev.shiftKey, moved: false,
        az: view.az, el: view.el, tx: view.tx, ty: view.ty, tz: view.tz };
      canvas.setPointerCapture(ev.pointerId);
    });
    canvas.addEventListener('pointermove', function (ev) {
      if (!drag) return;
      var dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      viewAnim = null; ST.chase = false;
      if (drag.b === 2 || drag.shift) {
        /* pan on the ground plane: screen right = camera right, screen up = away */
        var s = view.dist * 0.0016;
        var rx = Math.cos(view.az), rz = -Math.sin(view.az);       /* camera right, world xz */
        var fx = -Math.sin(view.az), fz = -Math.cos(view.az);      /* camera forward, world xz */
        view.tx = drag.tx - dx * s * rx + dy * s * fx;
        view.tz = drag.tz - dx * s * rz + dy * s * fz;
      } else {
        view.az = drag.az - dx * 0.006;
        view.el = Math.max(0.03, Math.min(1.5, drag.el + dy * 0.006));
      }
      ST.render();
    });
    canvas.addEventListener('pointerup', function (ev) {
      if (!drag) return;
      var wasClick = !drag.moved && drag.b === 0;
      drag = null;
      if (!wasClick) return;
      if (pickMode && groundMesh) {
        var hit = groundHit(ev);
        if (hit && ST.onGroundPick) ST.onGroundPick(hit);
        return;
      }
      /* a photo on the ground: select it */
      if (rollGroup && rollGroup.visible && ST.onRollClick) {
        var r = canvas.getBoundingClientRect();
        var nx = ((ev.clientX - r.left) / r.width) * 2 - 1, ny = -((ev.clientY - r.top) / r.height) * 2 + 1;
        var rc = new THREE.Raycaster();
        rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
        var meshes = allRollItems().map(function (it) { return it.mesh; });
        var hits = rc.intersectObjects(meshes, false);
        ST.onRollClick(hits.length ? hits[0].object.userData.n : null, !!(ev.ctrlKey || ev.metaKey || ev.shiftKey),
          hits.length ? hits[0].object.userData.key : null);
      }
    });
    /* double-click: fly to what was hit — a finding, a planted defect
       (TRUTH on), a photo on the ground, or a spot on the ground */
    canvas.addEventListener('dblclick', function (ev) {
      ev.preventDefault();
      var r = canvas.getBoundingClientRect();
      var nx = ((ev.clientX - r.left) / r.width) * 2 - 1, ny = -((ev.clientY - r.top) / r.height) * 2 + 1;
      var rc = new THREE.Raycaster();
      rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
      var targets = [];
      if (annoPicks) targets = targets.concat(annoPicks.children);
      if (truthPicks && truthObj) targets = targets.concat(truthPicks.children);
      if (rollsShown && !findingsOnly) targets = targets.concat(allRollItems().map(function (it) { return it.mesh; }));
      var hits = rc.intersectObjects(targets, false);
      if (hits.length) {
        var h = hits[0], o = h.object;
        var p = o.userData.pick ? o.position : h.point;
        var dist = o.userData.pick ? 12 : 30;
        ST.chase = false;
        ST.goTo({ x: p.x, y: -p.z, z: p.y }, dist, view.az, Math.max(0.25, view.el), 700);
        return;
      }
      if (groundMesh) {
        var g = rc.intersectObjects(groundTargets(), false);
        if (g.length) { ST.chase = false; ST.goTo({ x: g[0].point.x, y: -g[0].point.z, z: g[0].point.y }, Math.min(view.dist, 80), view.az, view.el, 700); }
      }
    });
    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      viewAnim = null;
      view.dist = Math.max(8, Math.min(120000, view.dist * (ev.deltaY > 0 ? 1.12 : 0.89)));
      ST.render();
    }, { passive: false });
  };

  function groundHit(ev) {
    var r = canvas.getBoundingClientRect();
    var nx = ((ev.clientX - r.left) / r.width) * 2 - 1, ny = -((ev.clientY - r.top) / r.height) * 2 + 1;
    var rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(nx, ny), camera);
    var hits = rc.intersectObjects(groundTargets(), false);
    if (!hits.length) return null;
    var p = hits[0].point;
    return { x: p.x, y: -p.z, z: hits[0].object === groundMesh ? groundZ : p.y - TILE_DROP_FINE };
  }

  ST.setSize = function (w, h) {
    if (!renderer) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    lineRes.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
  };
  ST.pick = function (on) { pickMode = !!on; canvas.style.cursor = on ? 'crosshair' : ''; };
  ST.view = view;

  /* ease the view onto a target (local frame) at a distance */
  ST.goTo = function (tgt, dist, az, el, ms) {
    var from = { tx: view.tx, ty: view.ty, tz: view.tz, dist: view.dist, az: view.az, el: view.el };
    var to = { tx: tgt.x, ty: tgt.z, tz: -tgt.y, dist: dist || view.dist,
      az: az != null ? az : view.az, el: el != null ? el : view.el };
    /* shortest way round for the azimuth */
    var d = to.az - from.az; d = Math.atan2(Math.sin(d), Math.cos(d)); to.az = from.az + d;
    viewAnim = { from: from, to: to, t0: performance.now(), ms: ms || 900 };
  };
  function stepAnim() {
    if (!viewAnim) return false;
    var f = Math.min(1, (performance.now() - viewAnim.t0) / viewAnim.ms);
    var e = f * f * (3 - 2 * f);
    ['tx', 'ty', 'tz', 'dist', 'az', 'el'].forEach(function (k) {
      view[k] = viewAnim.from[k] + (viewAnim.to[k] - viewAnim.from[k]) * e;
    });
    if (f >= 1) viewAnim = null;
    return true;
  }
  ST.animating = function () { return !!viewAnim; };

  /* ---- the circuit ------------------------------------------------------- */
  ST.setCircuit = function (c) {
    circuit = c; focusIdx = -1;
    Object.keys(layers).forEach(function (k) { disposeGroup(layers[k]); layers[k] = null; });
    if (tilesGroup) { scene.remove(tilesGroup); tilesGroup = null; tilesCoarse = null; tilesFine = null; tilesCoarseFor = null; }
    if (!c) return;
    var sticks = [];
    var tw = c.towers;
    for (var i = 0; i < tw.length; i++) {
      TOWER3D.stick(tw[i]).forEach(function (s) { sticks.push(V(s.a[0], s.a[1], s.a[2]), V(s.b[0], s.b[1], s.b[2])); });
    }
    layers.sticks = new THREE.Group();
    layers.sticks.add(fatSegments(sticks, fatMat(C.soft, 1.2, 0.9)));
    scene.add(layers.sticks);
    drawRoute(-1, -1);
  };
  /* the whole-circuit route, tower top to tower top, so the line reads from
     a distance — left out between skipLo and skipHi, where the real wires
     are drawn (D-A872: Adam asked for the straight line to go) */
  function drawRoute(skipLo, skipHi) {
    disposeGroup(layers.route); layers.route = null;
    if (!circuit) return;
    var tw = circuit.towers, route = [];
    for (var i = 1; i < tw.length; i++) {
      if (i - 1 >= skipLo && i - 1 < skipHi) continue;
      route.push(V(tw[i - 1].x, tw[i - 1].y, tw[i - 1].top), V(tw[i].x, tw[i].y, tw[i].top));
    }
    if (!route.length) return;
    layers.route = new THREE.Group();
    layers.route.userData.segs = route.length / 2;
    layers.route.add(fatSegments(route, fatMat(C.soft, 1.0, 0.55)));
    scene.add(layers.route);
  }

  function pairKey(i) { return circuit.towers[i].name + ' > ' + circuit.towers[i + 1].name; }
  /* conductor polylines for pair i: the circuit's own, else notional */
  function pairPhases(i) {
    var A = circuit.towers[i], B = circuit.towers[i + 1];
    var own = circuit.phasesByKey && circuit.phasesByKey[pairKey(i)];
    if (own && own.length) return own.map(function (ph) { return ph.xyz; });
    var dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
    var ax = -dy / L, ay = dx / L;              /* abeam (left of travel) */
    var out = [];
    [4, 8.6, 13.2].forEach(function (drop) {
      var za = A.top - drop, zb = B.top - drop, pts = [];
      var sag = Math.min(12, L * 0.04);
      for (var k = 0; k <= 8; k++) {
        var f = k / 8;
        pts.push({ x: A.x + dx * f + ax * 4.4, y: A.y + dy * f + ay * 4.4,
          z: za + (zb - za) * f - sag * 4 * f * (1 - f) });
      }
      out.push(pts);
    });
    return out;
  }
  ST.pairPhases = function (i) { return circuit ? pairPhases(i) : []; };

  /* the spans in the window around the focus: full lattice + conductors */
  ST.focusSpan = function (idx, animate) {
    if (!circuit || idx < 0 || idx >= circuit.towers.length - 1) return;
    focusIdx = idx;
    disposeGroup(layers.focus); disposeGroup(layers.ground);
    var ta = circuit.towers[idx], tb = circuit.towers[idx + 1];
    var lo = Math.max(0, idx - 1), hi = Math.min(circuit.towers.length - 1, idx + 2);
    drawRoute(lo, hi);
    var heavy = [], light = [], wires = [];
    var attachByTower = {};
    for (var p = lo; p < hi; p++) {
      var A = circuit.towers[p], B = circuit.towers[p + 1];
      pairPhases(p).forEach(function (pts) {
        var p0 = pts[0], p1 = pts[pts.length - 1];
        wires = wires.concat(polylineSegs(pts));
        (attachByTower[A.name] = attachByTower[A.name] || []).push({ dx: p0.x - A.x, dy: p0.y - A.y, dz: p0.z - A.z });
        (attachByTower[B.name] = attachByTower[B.name] || []).push({ dx: p1.x - B.x, dy: p1.y - B.y, dz: p1.z - B.z });
      });
    }
    for (var i = lo; i <= hi; i++) {
      var t = circuit.towers[i];
      var prev = circuit.towers[i - 1] || t, next = circuit.towers[i + 1] || t;
      var along = { x: next.x - prev.x, y: next.y - prev.y };
      var L = Math.hypot(along.x, along.y) || 1; along.x /= L; along.y /= L;
      var att = (attachByTower[t.name] || []).filter(function (q, k, arr) {
        return arr.findIndex(function (r) { return Math.abs(r.dz - q.dz) < 0.3 && Math.abs(r.dx - q.dx) < 0.3 && Math.abs(r.dy - q.dy) < 0.3; }) === k;
      });
      TOWER3D.lattice(t, att, along).forEach(function (s) {
        (s.w >= 1.2 ? heavy : light).push(V(s.a[0], s.a[1], s.a[2]), V(s.b[0], s.b[1], s.b[2]));
      });
    }
    layers.focus = new THREE.Group();
    layers.focus.add(fatSegments(heavy, fatMat(C.ink, 1.6, 0.95)));
    layers.focus.add(fatSegments(light, fatMat(C.ink, 0.9, 0.55)));
    if (wires.length) layers.focus.add(fatSegments(wires, fatMat(C.ink, 1.8, 0.9)));
    scene.add(layers.focus);

    /* ground: a quiet 10 m grid and an invisible pick plane at the towers' mean base */
    groundZ = (ta.z + tb.z) / 2;
    var cx = (ta.x + tb.x) / 2, cy = (ta.y + tb.y) / 2;
    var R = 260, g = [];
    for (var k = -R; k <= R; k += 10) {
      g.push(V(cx + k, cy - R, groundZ), V(cx + k, cy + R, groundZ));
      g.push(V(cx - R, cy + k, groundZ), V(cx + R, cy + k, groundZ));
    }
    layers.ground = new THREE.Group();
    layers.ground.add(fatSegments(g, fatMat(C.faint, 0.8, 0.9)));
    groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.MeshBasicMaterial({ visible: false }));
    groundMesh.rotation.x = -Math.PI / 2;
    groundMesh.position.set(cx, groundZ, -cy);
    layers.ground.add(groundMesh);
    scene.add(layers.ground);
    rebuildTiles();

    ST.drawGroup();
    if (animate !== false) ST.frameSpan(idx);
  };
  ST.frameSpan = function (idx) {
    var ta = circuit.towers[idx], tb = circuit.towers[idx + 1];
    var cx = (ta.x + tb.x) / 2, cy = (ta.y + tb.y) / 2;
    var mid = { x: cx, y: cy, z: (ta.z + tb.z) / 2 + 30 };
    var lineAz = Math.atan2(tb.x - ta.x, tb.y - ta.y);
    ST.chase = false;
    ST.goTo(mid, Math.hypot(tb.x - ta.x, tb.y - ta.y) * 1.25 + 60, lineAz + Math.PI / 2 + 0.45, 0.42, 1100);
  };
  ST.focusIndex = function () { return focusIdx; };
  ST.groundZ = function () { return groundZ; };

  /* ---- ground map tiles (D-A873 / D-A874): the map as the floor of the 3D
     world. Web Mercator tiles fetched from the same services the pop-up map
     uses, each laid as a quad at its real corners in the local frame, on a
     level plane at the span's ground. Two layers: FINE (z17, ±1.5 km around
     the focus, rebuilt on every focus) and COARSE (z12, the whole circuit,
     built once). Selectable off / map / satellite so it can be switched off
     on a weak machine; textures cached by url and capped. Online only. */
  var tilesMode = 'off', tilesGroup = null, tilesCoarse = null, tilesFine = null, tileCache = {}, tileCacheN = 0, tileLoader = null, tilesCoarseFor = null;
  var TILE_DROP_FINE = -0.4, TILE_DROP_COARSE = -1.5;
  var TILE_URL = {
    map: function (z, x, y) { return 'https://tile.openstreetmap.org/' + z + '/' + x + '/' + y + '.png'; },
    sat: function (z, x, y) { return 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + y + '/' + x; }
  };
  function tileXY(lon, lat, z) {
    var n = Math.pow(2, z), r = lat * Math.PI / 180;
    return { x: Math.floor((lon + 180) / 360 * n), y: Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n) };
  }
  function tileBounds(x, y, z) {
    var n = Math.pow(2, z);
    var lat = function (yy) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * yy / n))) * 180 / Math.PI; };
    return { lon0: x / n * 360 - 180, lon1: (x + 1) / n * 360 - 180, lat0: lat(y + 1), lat1: lat(y) };
  }
  function tileTexture(mode, z, x, y) {
    var key = mode + ':' + z + '/' + x + '/' + y, tex = tileCache[key];
    if (tex) return tex;
    if (!tileLoader) { tileLoader = new THREE.TextureLoader(); tileLoader.crossOrigin = 'anonymous'; }
    if (tileCacheN > 900) { Object.keys(tileCache).forEach(function (k) { tileCache[k].dispose(); }); tileCache = {}; tileCacheN = 0; }
    tex = tileLoader.load(TILE_URL[mode](z, x, y));
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1);
    tileCache[key] = tex; tileCacheN++;
    return tex;
  }
  /* one tile as a seg×seg grid at its real corners (seg 1 = the flat quad).
     With RELIEF on, drapeTile lifts every vertex to the elevation tile at
     demZ (a z17 tile lies inside one z15 elevation tile; a z12 tile is its
     own). The grid's lon/lat per vertex is kept for the drape. */
  function tileMesh(mode, z, x, y, level, seg, demZ, fine) {
    var b = tileBounds(x, y, z), f = circuit.frame, n = Math.pow(2, z), N = seg + 1;
    var latOf = function (yy) { return Math.atan(Math.sinh(Math.PI * (1 - 2 * yy / n))) * 180 / Math.PI; };
    var pos = new Float32Array(N * N * 3), uv = new Float32Array(N * N * 2), ll = new Float64Array(N * N * 2), idx = [];
    for (var j = 0; j <= seg; j++) {
      var lat = latOf(y + 1 - j / seg);
      for (var i = 0; i <= seg; i++) {
        var lon = b.lon0 + (b.lon1 - b.lon0) * i / seg, k = j * N + i, p = f.toXY({ lon: lon, lat: lat });
        pos[k * 3] = p.x; pos[k * 3 + 1] = level; pos[k * 3 + 2] = -p.y;
        uv[k * 2] = i / seg; uv[k * 2 + 1] = j / seg;
        ll[k * 2] = lon; ll[k * 2 + 1] = lat;
        if (i < seg && j < seg) idx.push(k, k + 1, k + N + 1, k, k + N + 1, k + N);
      }
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    var mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tileTexture(mode, z, x, y), color: 0xffffff, depthWrite: !!fine }));
    mesh.userData.tile = { z: z, x: x, y: y, seg: seg, demZ: demZ, fine: !!fine, drop: level - groundZ, ll: ll, draped: false };
    if (relief && seg > 1) drapeTile(mesh);
    return mesh;
  }
  function tileRange(lonA, lonB, latA, latB, z, margin) {
    var a = tileXY(Math.min(lonA, lonB), Math.max(latA, latB), z), b = tileXY(Math.max(lonA, lonB), Math.min(latA, latB), z);
    return { x0: a.x - margin, x1: b.x + margin, y0: a.y - margin, y1: b.y + margin };
  }
  function buildTiles(group, mode, z, range, level, seg, demZ, fine) {
    for (var x = range.x0; x <= range.x1; x++) for (var y = range.y0; y <= range.y1; y++) group.add(tileMesh(mode, z, x, y, level, seg, demZ, fine));
  }
  function rebuildTiles() {
    if (tilesFine) { tilesGroup.remove(tilesFine); tilesFine.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); tilesFine = null; }
    if (tilesMode === 'off' || !circuit || focusIdx < 0) return;
    if (!tilesGroup) { tilesGroup = new THREE.Group(); tilesGroup.renderOrder = -10; scene.add(tilesGroup); }
    var coarseKey = tilesMode + ':' + circuit.name;
    if (tilesCoarseFor !== coarseKey) {
      if (tilesCoarse) { tilesGroup.remove(tilesCoarse); tilesCoarse.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
      tilesCoarse = new THREE.Group();
      var lo = { lon: Infinity, lat: Infinity }, hi = { lon: -Infinity, lat: -Infinity };
      circuit.towers.forEach(function (t) { lo.lon = Math.min(lo.lon, t.lon); hi.lon = Math.max(hi.lon, t.lon); lo.lat = Math.min(lo.lat, t.lat); hi.lat = Math.max(hi.lat, t.lat); });
      /* the coarse floor never writes depth: where the fine tiles cover it
         they simply paint over, and its 300 m samples never cut through them */
      buildTiles(tilesCoarse, tilesMode, 12, tileRange(lo.lon, hi.lon, lo.lat, hi.lat, 12, 1), groundZ + TILE_DROP_COARSE, relief ? 32 : 1, 12, false);
      tilesCoarse.renderOrder = -20;
      tilesGroup.add(tilesCoarse); tilesCoarseFor = coarseKey;
    }
    var ta = circuit.towers[focusIdx], tb = circuit.towers[focusIdx + 1];
    var mid = circuit.frame.toLL((ta.x + tb.x) / 2, (ta.y + tb.y) / 2);
    var dLat = 1500 / 110540, dLon = 1500 / (111320 * Math.cos(mid.lat * Math.PI / 180));
    tilesFine = new THREE.Group();
    fineTowersFor = null;
    buildTiles(tilesFine, tilesMode, 17, tileRange(mid.lon - dLon, mid.lon + dLon, mid.lat - dLat, mid.lat + dLat, 17, 0), groundZ + TILE_DROP_FINE, relief ? 16 : 1, 15, true);
    tilesFine.renderOrder = -10;
    tilesGroup.add(tilesFine);
    if (layers.ground && layers.ground.children[0]) layers.ground.children[0].visible = false;
  }
  ST.setGroundTiles = function (mode) {
    tilesMode = TILE_URL[mode] ? mode : 'off';
    if (tilesMode === 'off') {
      if (tilesGroup) { scene.remove(tilesGroup); tilesGroup.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); tilesGroup = null; tilesCoarse = null; tilesFine = null; tilesCoarseFor = null; }
      if (layers.ground && layers.ground.children[0]) layers.ground.children[0].visible = true;
      return;
    }
    if (tilesGroup && tilesCoarseFor && tilesCoarseFor.indexOf(tilesMode + ':') !== 0) { scene.remove(tilesGroup); tilesGroup = null; tilesCoarse = null; tilesFine = null; tilesCoarseFor = null; }
    rebuildTiles();
  };
  /* ---- terrain relief (D-A891): the tiles draped over the free AWS
     Terrarium elevation tiles (Mapzen's SRTM/NED blend, no key, CORS on).
     The elevation datum and the plan's altitudes differ by a few metres, so
     the terrain is fitted to the tower footings: the fine window blends each
     tower's residual (base altitude minus the terrain there) by inverse
     distance, the coarse floor takes the circuit's median. Off by default;
     with it off the tiles are the flat quads of D-A874. Tiles that never
     arrive stay flat, never an error. */
  var relief = false, dem = {}, demWait = {}, demFail = {}, demN = 0, coarseOff = null, coarseOffFor = null, reliefStats = null, fineTowers = null, fineTowersFor = null;
  var DEM_URL = function (z, x, y) { return 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/' + z + '/' + x + '/' + y + '.png'; };
  function demTile(z, x, y, cb) {
    var key = z + '/' + x + '/' + y;
    if (dem[key]) return dem[key];
    if (demFail[key]) return null;
    if (demWait[key]) { if (cb && demWait[key].indexOf(cb) < 0) demWait[key].push(cb); return null; }
    demWait[key] = cb ? [cb] : [];
    var img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = function () {
      var cv = document.createElement('canvas'); cv.width = cv.height = 256;
      var g = cv.getContext('2d'); g.drawImage(img, 0, 0);
      var d, h = new Float32Array(65536);
      try { d = g.getImageData(0, 0, 256, 256).data; } catch (e) { demFail[key] = true; delete demWait[key]; return; }
      for (var i = 0; i < 65536; i++) h[i] = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
      if (demN > 300) { dem = {}; demN = 0; }
      dem[key] = h; demN++;
      var cbs = demWait[key] || []; delete demWait[key];
      cbs.forEach(function (f) { f(h); });
    };
    img.onerror = function () { demFail[key] = true; delete demWait[key]; };
    img.src = DEM_URL(z, x, y);
    return null;
  }
  /* bilinear height inside elevation tile (tx, ty) at zoom z */
  function demSample(h, z, tx, ty, lon, lat) {
    var n = Math.pow(2, z) * 256, r = lat * Math.PI / 180;
    var px = (lon + 180) / 360 * n - tx * 256 - 0.5, py = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n - ty * 256 - 0.5;
    px = Math.max(0, Math.min(255, px)); py = Math.max(0, Math.min(255, py));
    var x0 = Math.floor(px), y0 = Math.floor(py), x1 = Math.min(255, x0 + 1), y1 = Math.min(255, y0 + 1), fx = px - x0, fy = py - y0;
    return (h[y0 * 256 + x0] * (1 - fx) + h[y0 * 256 + x1] * fx) * (1 - fy) + (h[y1 * 256 + x0] * (1 - fx) + h[y1 * 256 + x1] * fx) * fy;
  }
  function redrape() { drapeGroup(tilesFine); drapeGroup(tilesCoarse); ST.render(); }
  function towerResidual(t, z) {
    var q = tileXY(t.lon, t.lat, z), h = demTile(z, q.x, q.y, redrape);
    return h ? t.z - demSample(h, z, q.x, q.y, t.lon, t.lat) : null;
  }
  /* the towers of the fine window with their z15 residuals, or null while any is loading */
  function fineResiduals() {
    if (fineTowersFor === focusIdx && fineTowers) return fineTowers;
    var ta = circuit.towers[focusIdx], tb = circuit.towers[focusIdx + 1], cx = (ta.x + tb.x) / 2, cy = (ta.y + tb.y) / 2, out = [];
    for (var i = 0; i < circuit.towers.length; i++) {
      var t = circuit.towers[i];
      if (Math.hypot(t.x - cx, t.y - cy) > 2200) continue;
      var r = towerResidual(t, 15);
      if (r == null) return null;
      out.push({ x: t.x, y: t.y, r: r });
    }
    if (!out.length) out.push({ x: cx, y: cy, r: 0 });
    fineTowers = out; fineTowersFor = focusIdx;
    return out;
  }
  function fineOffsetAt(rs, x, y) {
    var sw = 0, sr = 0;
    for (var i = 0; i < rs.length; i++) { var d2 = (rs[i].x - x) * (rs[i].x - x) + (rs[i].y - y) * (rs[i].y - y); if (d2 < 1) return rs[i].r; var w = 1 / d2; sw += w; sr += w * rs[i].r; }
    return sr / sw;
  }
  function coarseOffset() {
    if (coarseOffFor === circuit.name && coarseOff != null) return coarseOff;
    var rs = [];
    for (var i = 0; i < circuit.towers.length; i++) { var r = towerResidual(circuit.towers[i], 12); if (r == null) return null; rs.push(r); }
    rs.sort(function (a, b) { return a - b; });
    coarseOff = rs[rs.length >> 1]; coarseOffFor = circuit.name;
    reliefStats = { towers: rs.length, median: coarseOff, low: rs[0], high: rs[rs.length - 1] };
    return coarseOff;
  }
  function drapeTile(mesh) {
    var u = mesh.userData.tile; if (!u || !relief || u.seg < 2 || !circuit) return;
    var rs = null, off = null;
    if (u.fine) { rs = fineResiduals(); if (!rs) return; } else { off = coarseOffset(); if (off == null) return; }
    var d = u.z - u.demZ, tx = u.x >> d, ty = u.y >> d;
    var h = demTile(u.demZ, tx, ty, function () { drapeTile(mesh); ST.render(); });
    if (!h) return;
    var pos = mesh.geometry.attributes.position, ll = u.ll;
    for (var k = 0; k < pos.count; k++) {
      var e = demSample(h, u.demZ, tx, ty, ll[k * 2], ll[k * 2 + 1]);
      pos.setY(k, e + (u.fine ? fineOffsetAt(rs, pos.getX(k), -pos.getZ(k)) : off) + u.drop);
    }
    pos.needsUpdate = true; mesh.geometry.computeBoundingSphere(); mesh.geometry.computeBoundingBox();
    u.draped = true;
  }
  function drapeGroup(group) { if (group) group.children.forEach(drapeTile); }
  function groundTargets() { var t = []; if (relief && tilesFine) t = t.concat(tilesFine.children); if (groundMesh) t.push(groundMesh); return t; }
  ST.setRelief = function (on) {
    on = !!on; if (on === relief) return;
    relief = on; fineTowers = null; fineTowersFor = null;
    if (tilesGroup) { scene.remove(tilesGroup); tilesGroup.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); tilesGroup = null; tilesCoarse = null; tilesFine = null; tilesCoarseFor = null; }
    rebuildTiles();
  };
  ST.relief = function () { return relief; };
  ST.reliefInfo = function () {
    var n = 0, d = 0;
    if (tilesFine) tilesFine.children.forEach(function (m) { n++; if (m.userData.tile && m.userData.tile.draped) d++; });
    return { on: relief, fineTiles: n, draped: d, fit: reliefStats, fineTowers: fineTowers ? fineTowers.map(function (t) { return Math.round(t.r * 10) / 10; }) : null };
  };
  /* the ground's height at (x, y): the draped tiles when RELIEF is on, else the span's level */
  ST.groundAt = function (x, y) {
    if (relief && tilesFine) {
      var rc = new THREE.Raycaster(new THREE.Vector3(x, groundZ + 9000, -y), new THREE.Vector3(0, -1, 0));
      var hits = rc.intersectObjects(tilesFine.children, false);
      if (hits.length) return hits[0].point.y - TILE_DROP_FINE;
    }
    return groundZ;
  };
  ST.groundTilesCount = function (loadedOnly) { var n = 0; if (tilesGroup) tilesGroup.traverse(function (o) { if (o.isMesh && (!loadedOnly || (o.material.map && o.material.map.image && o.material.map.image.width > 0))) n++; }); return n; };

  /* ---- the instructed missions (WPML) ------------------------------------- */
  ST.setGroup = function (g) { group = g; ST.drawGroup(); };
  ST.setSelection = function (ids) {
    selection = {};
    (ids || []).forEach(function (id) { selection[id] = true; });
    ST.drawGroup();
  };
  ST.drawGroup = function () {
    disposeGroup(layers.missions); layers.missions = null;
    if (!group || !circuit || focusIdx < 0) return;
    var ta = circuit.towers[focusIdx], tb = circuit.towers[focusIdx + 1];
    var cx = (ta.x + tb.x) / 2, cy = (ta.y + tb.y) / 2;
    var selA = [], selB = [], dimA = [], dimB = [], beads = [], selO = [], dimO = [];
    group.missions.forEach(function (m) {
      if (!m.wps.length || m.wps[0].x == null) return;
      var w0 = m.wps[0];
      if (Math.hypot(w0.x - cx, w0.y - cy) > 900) return;   /* draw what is near the focus */
      var segs = polylineSegs(m.wps);
      var sel = !!selection[m.name];
      var bucket = m.dir === 'A' ? (sel ? selA : dimA) : m.dir === 'B' ? (sel ? selB : dimB) : (sel ? selO : dimO);
      bucket.push.apply(bucket, segs);
      if (m.wps.length === 1) {
        /* a single-point mission (the gimbal test): a small diamond */
        var w = m.wps[0], r = 1.2;
        bucket.push(V(w.x - r, w.y, w.z), V(w.x, w.y, w.z + r), V(w.x, w.y, w.z + r), V(w.x + r, w.y, w.z),
          V(w.x + r, w.y, w.z), V(w.x, w.y, w.z - r), V(w.x, w.y, w.z - r), V(w.x - r, w.y, w.z));
      }
      if (sel) m.wps.forEach(function (w) { beads.push(V(w.x, w.y, w.z - 0.6), V(w.x, w.y, w.z + 0.6)); });
    });
    layers.missions = new THREE.Group();
    if (dimA.length) layers.missions.add(fatSegments(dimA, fatMat(C.a, 1.4, 0.28)));
    if (dimB.length) layers.missions.add(fatSegments(dimB, fatMat(C.b, 1.4, 0.28)));
    if (dimO.length) layers.missions.add(fatSegments(dimO, fatMat(C.acc, 1.4, 0.35)));
    if (selA.length) layers.missions.add(fatSegments(selA, fatMat(C.a, 2.4, 0.95)));
    if (selB.length) layers.missions.add(fatSegments(selB, fatMat(C.b, 2.4, 0.95)));
    if (selO.length) layers.missions.add(fatSegments(selO, fatMat(C.acc, 2.4, 0.95)));
    if (beads.length) layers.missions.add(fatSegments(beads, fatMat(C.ink, 1.6, 0.8)));
    scene.add(layers.missions);
  };

  /* ---- the launch pad ------------------------------------------------------ */
  ST.setLaunch = function (p) {
    disposeGroup(layers.launch); layers.launch = null;
    if (!p) return;
    var s = [], N = 24, r = 2.2;
    for (var i = 0; i < N; i++) {
      var a0 = i / N * Math.PI * 2, a1 = (i + 1) / N * Math.PI * 2;
      s.push(V(p.x + Math.cos(a0) * r, p.y + Math.sin(a0) * r, p.z + 0.05), V(p.x + Math.cos(a1) * r, p.y + Math.sin(a1) * r, p.z + 0.05));
    }
    s.push(V(p.x - 0.8, p.y - 1, p.z + 0.05), V(p.x - 0.8, p.y + 1, p.z + 0.05));
    s.push(V(p.x + 0.8, p.y - 1, p.z + 0.05), V(p.x + 0.8, p.y + 1, p.z + 0.05));
    s.push(V(p.x - 0.8, p.y, p.z + 0.05), V(p.x + 0.8, p.y, p.z + 0.05));
    layers.launch = new THREE.Group();
    layers.launch.add(fatSegments(s, fatMat(C.pad, 2.0, 0.95)));
    scene.add(layers.launch);
  };

  /* ---- the drone ------------------------------------------------------------ */
  var droneGroup = null, droneRotors = [], camRig = null, frustumObj = null;
  var fpvCam = null, dronePos3 = new THREE.Vector3();
  var trail = [], trailObj = null;
  function ensureDrone() {
    if (droneGroup) return;
    var fMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(C.bg), polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    var eMat = fatMat(C.ink, 2.0, 0.95), eSoft = fatMat(C.ink, 1.4, 0.6);
    function pD(geom, soft) {
      var h = new THREE.Group();
      h.add(new THREE.Mesh(geom, fMat));
      h.add(fatEdges(geom, 20, soft ? eSoft : eMat));
      return h;
    }
    droneGroup = new THREE.Group();
    droneGroup.add(pD(new THREE.BoxGeometry(0.55, 0.18, 0.75)));
    [-1, 1].forEach(function (sgn) {
      var arm = pD(new THREE.BoxGeometry(1.9, 0.06, 0.1), true);
      arm.rotation.y = sgn * Math.PI / 4;
      droneGroup.add(arm);
    });
    [[-0.67, -0.67], [0.67, -0.67], [-0.67, 0.67], [0.67, 0.67]].forEach(function (q) {
      var hub = new THREE.Group();
      hub.add(pD(new THREE.CylinderGeometry(0.34, 0.34, 0.03, 12), true));
      hub.add(pD(new THREE.BoxGeometry(0.62, 0.04, 0.09), true));
      hub.position.set(q[0], 0.14, q[1]);
      droneRotors.push(hub);
      droneGroup.add(hub);
    });
    camRig = new THREE.Group();
    camRig.rotation.order = 'YXZ';
    camRig.add(pD(new THREE.BoxGeometry(0.16, 0.16, 0.2), true));
    optics = new THREE.Group();
    camRig.add(optics);
    buildOptics();
    camRig.position.set(0, -0.08, -0.42);
    droneGroup.add(camRig);
    droneGroup.visible = false;
    scene.add(droneGroup);
    fpvCam = new THREE.PerspectiveCamera(camModel.vfov, camModel.aspect, 0.3, 30000);
    fpvCam.rotation.order = 'YXZ';
  }

  /* ---- the optics: true frustum + the focus bracket ------------------------
     Built in the gimbal's frame (−z is the optical axis) at TRUE metres, so
     the drawn cone matches the payload frame edge for edge and the slab sits
     exactly where the depth of field says. The drone group's scale would
     stretch it, so the optics counter-scale in setDronePose. */
  var camModel = CAMERA.model(), optics = null;
  function rect(d, halfW, halfH) {
    return [new THREE.Vector3(-halfW, halfH, -d), new THREE.Vector3(halfW, halfH, -d),
      new THREE.Vector3(halfW, -halfH, -d), new THREE.Vector3(-halfW, -halfH, -d)];
  }
  function ring(pts, out) { for (var i = 0; i < 4; i++) out.push(pts[i], pts[(i + 1) % 4]); }
  function buildOptics() {
    if (!optics) return;
    while (optics.children.length) { var o = optics.children.pop(); if (o.geometry) o.geometry.dispose(); }
    var th = Math.tan(camModel.hfov / 2 * Math.PI / 180), tv = Math.tan(camModel.vfov / 2 * Math.PI / 180);
    var far = isFinite(camModel.farM) ? camModel.farM : camModel.focusM * 2.5;
    var reach = Math.max(far * 1.15, camModel.focusM * 1.3);
    /* the frustum to just past the far plane */
    var fr = [], tip = rect(reach, reach * th, reach * tv);
    tip.forEach(function (c) { fr.push(new THREE.Vector3(0, 0, 0), c); });
    ring(tip, fr);
    optics.add(fatSegments(fr, fatMat(C.acc, 1.2, 0.5)));
    /* the bracket: near and far planes joined, the focus plane dashed */
    var near = rect(camModel.nearM, camModel.nearM * th, camModel.nearM * tv);
    var fpl = rect(far, far * th, far * tv);
    var slab = [];
    ring(near, slab); ring(fpl, slab);
    for (var i = 0; i < 4; i++) slab.push(near[i], fpl[i]);
    optics.add(fatSegments(slab, fatMat('#1f9d55', 2.0, 0.9)));
    var foc = rect(camModel.focusM, camModel.focusM * th, camModel.focusM * tv), fl = [];
    ring(foc, fl);
    optics.add(fatSegments(fl, fatMat('#1f9d55', 1.2, 0.7, true)));
    frustumObj = optics;
  }
  ST.setCamera = function (model) {
    camModel = model || CAMERA.model();
    if (optics) buildOptics();
    if (fpvCam) { fpvCam.fov = camModel.vfov; fpvCam.aspect = camModel.aspect; fpvCam.updateProjectionMatrix(); }
  };
  ST.camera = function () { return camModel; };

  /* ---- focus overlay: which wire is in the frame, and sharp -----------------
     Every conductor point of the focused window is put into the payload's
     camera space: depth along the axis, offset within the frame. In the
     frame and inside the bracket → green; in the frame but soft → amber.
     Returns the per-phase figures for the HUD. */
  var focusObj = null, focusPhases = [];
  /* each phase: { id, name, pts: [{x,y,z,s}], length } — s is arc length */
  ST.setFocusPhases = function (list) {
    focusPhases = (list || []).map(function (ph) {
      var s = 0;
      ph.pts.forEach(function (p, i) { if (i) s += Math.hypot(p.x - ph.pts[i - 1].x, p.y - ph.pts[i - 1].y, p.z - ph.pts[i - 1].z); p.s = s; });
      ph.length = s;
      return ph;
    });
  };
  /* classify every point of every watched wire against a camera matrix:
     0 out of frame, 1 in frame but soft, 2 in frame and sharp */
  function classify(inv) {
    var th = Math.tan(camModel.hfov / 2 * Math.PI / 180), tv = Math.tan(camModel.vfov / 2 * Math.PI / 180);
    return focusPhases.map(function (ph) {
      var cls = new Array(ph.pts.length), minD = Infinity, maxD = -Infinity;
      for (var i = 0; i < ph.pts.length; i++) {
        var p = ph.pts[i];
        var v = new THREE.Vector3(p.x, p.z, -p.y).applyMatrix4(inv);
        var d = -v.z, c = 0;
        if (d > 0.3 && Math.abs(v.x) <= d * th && Math.abs(v.y) <= d * tv) {
          c = d >= camModel.nearM && d <= camModel.farM ? 2 : 1;
          if (d < minD) minD = d; if (d > maxD) maxD = d;
        }
        cls[i] = c;
      }
      return { ph: ph, cls: cls, minD: minD, maxD: maxD };
    });
  }
  /* which face of the wire the camera is on: the sign of its horizontal
     offset across the local line direction */
  function sideOf(ph, i, camPos) {
    var a = ph.pts[Math.max(0, i - 1)], b = ph.pts[Math.min(ph.pts.length - 1, i + 1)];
    var dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    var cx = camPos.x - ph.pts[i].x, cy = camPos.y - ph.pts[i].y;
    return (dx / L) * cy - (dy / L) * cx >= 0 ? 1 : -1;
  }
  ST.updateFocus = function () {
    if (focusObj) { scene.remove(focusObj); focusObj.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); focusObj = null; }
    if (!fpvCam || !droneGroup || !droneGroup.visible || !focusPhases.length) return null;
    fpvCam.updateMatrixWorld(true);
    var inv = new THREE.Matrix4().copy(fpvCam.matrixWorld).invert();
    var sharp = [], soft = [], report = [];
    classify(inv).forEach(function (r) {
      var pts = r.ph.pts, inLen = 0, sharpLen = 0;
      for (var i = 1; i < pts.length; i++) {
        var c = r.cls[i];
        if (c && r.cls[i - 1] === c) {
          var a = V(pts[i - 1].x, pts[i - 1].y, pts[i - 1].z), b = V(pts[i].x, pts[i].y, pts[i].z);
          (c === 2 ? sharp : soft).push(a, b);
          var L = a.distanceTo(b); inLen += L; if (c === 2) sharpLen += L;
        }
      }
      report.push({ name: r.ph.name, inFrameM: inLen, sharpM: sharpLen, minDepth: r.minD, maxDepth: r.maxD });
    });
    focusObj = new THREE.Group();
    if (sharp.length) focusObj.add(fatSegments(sharp, fatMat('#1f9d55', 3.2, 0.95)));
    if (soft.length) focusObj.add(fatSegments(soft, fatMat('#e0a300', 3.2, 0.95)));
    scene.add(focusObj);
    return report;
  };

  /* what one SHOT captured: a camera built from the shot's own pose (the
     leg's targets, so it is deterministic under seek), returned as sharp
     and in-frame intervals in arc length per wire, with the side */
  var shotCam = null;
  ST.shotCaptures = function (pos, hdgDeg, gimPitchDeg, gimYawTotalDeg) {
    if (!focusPhases.length) return [];
    if (!shotCam) { shotCam = new THREE.Object3D(); shotCam.rotation.order = 'YXZ'; scene.add(shotCam); }
    shotCam.position.set(pos.x, pos.z, -pos.y);
    shotCam.rotation.set(gimPitchDeg * Math.PI / 180, -gimYawTotalDeg * Math.PI / 180, 0);
    shotCam.updateMatrixWorld(true);
    var inv = new THREE.Matrix4().copy(shotCam.matrixWorld).invert();
    var out = [];
    classify(inv).forEach(function (r) {
      var pts = r.ph.pts, sharp = [], inFrame = [], run = null, runIn = null, firstIn = -1;
      /* each sample stands for half a step either side of itself */
      var h = (r.ph.step || 1) / 2, Lw = r.ph.length;
      function lo(i) { return Math.max(0, pts[i].s - h); }
      function hi(i) { return Math.min(Lw, pts[i].s + h); }
      for (var i = 0; i < pts.length; i++) {
        var c = r.cls[i];
        if (c === 2) { if (!run) run = { s0: lo(i), s1: hi(i) }; else run.s1 = hi(i); }
        else if (run) { sharp.push(run); run = null; }
        if (c) { if (firstIn < 0) firstIn = i; if (!runIn) runIn = { s0: lo(i), s1: hi(i) }; else runIn.s1 = hi(i); }
        else if (runIn) { inFrame.push(runIn); runIn = null; }
      }
      if (run) sharp.push(run);
      if (runIn) inFrame.push(runIn);
      if (!inFrame.length) return;
      out.push({ wireId: r.ph.id, wireName: r.ph.name, wireLength: r.ph.length,
        side: sideOf(r.ph, firstIn, pos), sharp: sharp, inFrame: inFrame });
    });
    return out;
  };

  /* the cookie trail: proven-sharp intervals drawn along each wire, offset
     to the face the camera was on, in yellow */
  var trailCov = null;
  ST.drawCoverage = function (cov) {
    if (trailCov) { scene.remove(trailCov); trailCov.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); trailCov = null; }
    if (!cov) return;
    var segs = [];
    focusPhases.forEach(function (ph) {
      var w = cov.wires[ph.id];
      if (!w) return;
      Object.keys(w.sides).forEach(function (sd) {
        var sign = Number(sd);
        w.sides[sd].covered.forEach(function (iv) {
          var prev = null;
          for (var i = 0; i < ph.pts.length; i++) {
            var p = ph.pts[i];
            if (p.s < iv.s0 - 0.01 || p.s > iv.s1 + 0.01) { prev = null; continue; }
            var a = ph.pts[Math.max(0, i - 1)], b = ph.pts[Math.min(ph.pts.length - 1, i + 1)];
            var dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
            /* the face: perpendicular across the line, on the camera's side */
            var q = { x: p.x - (dy / L) * 0.7 * sign, y: p.y + (dx / L) * 0.7 * sign, z: p.z };
            if (prev) segs.push(V(prev.x, prev.y, prev.z), V(q.x, q.y, q.z));
            prev = q;
          }
        });
      });
    });
    if (!segs.length) return;
    trailCov = new THREE.Group();
    trailCov.add(fatSegments(segs, fatMat('#f2c200', 3.6, 0.95)));
    scene.add(trailCov);
  };
  ST.focusPhaseList = function () { return focusPhases; };
  /* INSPECTED spans in very slight grey (D-A870): the proven intervals of every
     span with a dataset, drawn from its coverage, whether or not the span is
     in the focus window. Never invisible — in FINDINGS ONLY this is what says
     where the line has been flown. list = [{ pair, cov }] */
  var inspectedObj = null;
  function sampledPhases(p) {
    var out = [];
    pairPhases(p).forEach(function (pts, k) {
      var fine = [], s = 0;
      for (var i = 1; i < pts.length; i++) {
        var d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
        var n = Math.max(1, Math.round(d / 1.0));
        for (var j = 0; j < n; j++) { var f = j / n; fine.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * f, s: s + d * f }); }
        s += d;
      }
      var last = pts[pts.length - 1]; fine.push({ x: last.x, y: last.y, z: last.z, s: s });
      out.push({ id: 'p' + p + '-w' + (k + 1), pts: fine });
    });
    return out;
  }
  ST.drawInspected = function (list) {
    if (inspectedObj) { scene.remove(inspectedObj); inspectedObj.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); inspectedObj = null; }
    if (!circuit || !list || !list.length) return;
    var segs = [];
    list.forEach(function (e) {
      if (!e.cov || !e.cov.wires) return;
      sampledPhases(e.pair).forEach(function (ph) {
        var w = e.cov.wires[ph.id]; if (!w) return;
        Object.keys(w.sides).forEach(function (sd) {
          var sign = Number(sd);
          w.sides[sd].covered.forEach(function (iv) {
            var prev = null;
            for (var i = 0; i < ph.pts.length; i++) {
              var p = ph.pts[i];
              if (p.s < iv.s0 - 0.01 || p.s > iv.s1 + 0.01) { prev = null; continue; }
              var a = ph.pts[Math.max(0, i - 1)], b = ph.pts[Math.min(ph.pts.length - 1, i + 1)];
              var dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
              var q = { x: p.x - (dy / L) * 0.7 * sign, y: p.y + (dx / L) * 0.7 * sign, z: p.z };
              if (prev) segs.push(V(prev.x, prev.y, prev.z), V(q.x, q.y, q.z));
              prev = q;
            }
          });
        });
      });
    });
    if (!segs.length) return;
    inspectedObj = new THREE.Group();
    inspectedObj.userData.segs = segs.length / 2;
    inspectedObj.add(fatSegments(segs, fatMat('#c9ccd0', 2.4, 0.85)));
    scene.add(inspectedObj);
  };
  ST.routeSegs = function () { return layers.route ? layers.route.userData.segs || 0 : 0; };
  ST.inspectedSegs = function () { return inspectedObj ? inspectedObj.userData.segs || 0 : 0; };

  /* ---- a selected photo: the section of line it recorded sharp ------------- */
  var hiObj = null, hiFrame = null;
  /* selection: [{ n, caps }] — one photo, several (ctrl-click), or all */
  ST.highlightShots = function (list) {
    if (hiObj) { scene.remove(hiObj); hiObj.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); hiObj = null; }
    if (hiFrame) { rollGroup && rollGroup.remove(hiFrame); hiFrame.traverse(function (o) { if (o.geometry && !o.userData.shared) o.geometry.dispose(); }); hiFrame = null; }
    if (!list || !list.length) return;
    var segs = [], ringed = {};
    list.forEach(function (sel) {
      (sel.caps || []).forEach(function (c) {
        var ph = null;
        for (var k = 0; k < focusPhases.length; k++) if (focusPhases[k].id === c.wireId) { ph = focusPhases[k]; break; }
        if (!ph) return;
        c.sharp.forEach(function (iv) {
          var prev = null;
          for (var i = 0; i < ph.pts.length; i++) {
            var p = ph.pts[i];
            if (p.s < iv.s0 - 0.01 || p.s > iv.s1 + 0.01) { prev = null; continue; }
            if (prev) segs.push(V(prev.x, prev.y, prev.z), V(p.x, p.y, p.z));
            prev = p;
          }
        });
      });
      ringed[sel.n] = true;
    });
    hiObj = new THREE.Group();
    if (segs.length) hiObj.add(fatSegments(segs, fatMat('#e0007a', 6.0, 0.95)));
    scene.add(hiObj);
    /* and the photos themselves, ringed */
    if (rollGroup) {
      hiFrame = new THREE.Group();
      var mat = fatMat('#e0007a', 4.0, 1);
      rollItems.forEach(function (it) {
        if (!ringed[it.n] || !it.edge) return;
        var ring = new THREE.LineSegments2(it.edge.geometry, mat);
        ring.userData.shared = true;
        hiFrame.add(ring);
      });
      rollGroup.add(hiFrame);
    }
  };
  ST.highlightShot = function (n, caps) { ST.highlightShots(n == null ? null : [{ n: n, caps: caps }]); };
  ST.onRollClick = null;

  /* ---- the camera rolls: the deliverable, laid flat on the ground ----------
     Every photo is rendered from the payload at the moment it fires — the
     same camera model, the same world minus the planning furniture — into a
     small texture, and laid on the ground beside the span at its station:
     one row per pass (high, then low further out), A rolls on the A lane's
     side of the line, B rolls on the other. Overlap on the ground is the
     overlap of the photos along the line. */
  /* one roll set per span: the ACTIVE set is aliased by rollGroup /
     rollItems / rollLabels; parked sets stay in the scene as the circuit's
     accumulating deliverable */
  var rollSets = {}, rollKey = null;
  var rollGroup = null, rollItems = [], rollLabels = {};
  ST.rollsUse = function (key) {
    if (rollKey === key) return;
    if (rollKey != null) rollSets[rollKey] = { group: rollGroup, items: rollItems, labels: rollLabels };
    rollKey = key;
    var s = rollSets[key];
    if (s) { rollGroup = s.group; rollItems = s.items; rollLabels = s.labels; }
    else { rollGroup = null; rollItems = []; rollLabels = {}; }
    if (hiObj || hiFrame) ST.highlightShots(null);
  };
  ST.rollsKey = function () { return rollKey; };
  function allRollItems() {
    var out = rollItems.slice();
    Object.keys(rollSets).forEach(function (k) { if (k !== rollKey) out = out.concat(rollSets[k].items); });
    return out;
  }
  ST.rollsClearAll = function () {
    ST.rollsClear();
    Object.keys(rollSets).forEach(function (k) {
      var s = rollSets[k];
      s.items.forEach(function (it) { if (it.rt) it.rt.dispose(); if (it.tex) it.tex.dispose(); it.mesh.geometry.dispose(); it.mesh.material.dispose(); if (it.edge) it.edge.geometry.dispose(); });
      Object.keys(s.labels).forEach(function (l) { var m = s.labels[l]; m.geometry.dispose(); m.material.map.dispose(); m.material.dispose(); });
      if (s.group) scene.remove(s.group);
    });
    rollSets = {};
  };
  var rollCam = null, ROLL_W = 800, ROLL_H = 600;
  function ensureRolls() {
    if (!rollGroup) { rollGroup = new THREE.Group(); rollGroup.visible = rollsShown; scene.add(rollGroup); }
    if (!rollCam) { rollCam = new THREE.PerspectiveCamera(camModel.vfov, camModel.aspect, 0.3, 30000); rollCam.rotation.order = 'YXZ'; }
  }
  ST.rollsClear = function () {
    ST.highlightShot(null);
    rollItems.forEach(function (it) { if (it.rt) it.rt.dispose(); if (it.tex) it.tex.dispose(); it.mesh.geometry.dispose(); it.mesh.material.dispose(); if (it.edge) it.edge.geometry.dispose(); });
    rollItems = [];
    Object.keys(rollLabels).forEach(function (k) { var l = rollLabels[k]; l.geometry.dispose(); l.material.map.dispose(); l.material.dispose(); });
    rollLabels = {};
    if (rollGroup) { scene.remove(rollGroup); rollGroup = null; }
    if (rollKey != null) delete rollSets[rollKey];
  };
  ST.rollsCount = function () { return rollItems.length; };
  /* hide / show the rolls (and their finding boxes) in the 3D view */
  var rollsShown = true;
  ST.rollsVisible = function (v) {
    rollsShown = !!v;
    if (rollGroup) rollGroup.visible = rollsShown;
    Object.keys(rollSets).forEach(function (k) { if (rollSets[k].group) rollSets[k].group.visible = rollsShown; });
    if (annoRollObj) annoRollObj.visible = rollsShown;
  };
  /* FINDINGS ONLY: the datasets and the planning furniture step back, the
     towers, wires and finding marks of the whole line stay */
  var findingsOnly = false;
  ST.findingsOnly = function (on) { findingsOnly = !!on; };
  function applyFindingsOnly() {
    var showData = !findingsOnly && rollsShown;
    if (rollGroup) rollGroup.visible = showData;
    Object.keys(rollSets).forEach(function (k) { if (rollSets[k].group) rollSets[k].group.visible = showData; });
    if (annoRollObj) annoRollObj.visible = showData;
    /* datasets only: the pad and the mission paths stay, they are the plan */
    [trailCov, trailObj, focusObj, hiObj].forEach(function (o) { if (o) o.visible = !findingsOnly; });
    if (layers.launch) layers.launch.visible = true;
    if (layers.missions) layers.missions.visible = true;
  }
  ST.rollsTrimTo = function (n) {
    ST.highlightShot(null);
    while (rollItems.length > n) {
      var it = rollItems.pop();
      rollGroup.remove(it.mesh); if (it.edge) rollGroup.remove(it.edge);
      if (it.rt) it.rt.dispose(); if (it.tex) it.tex.dispose(); it.mesh.geometry.dispose(); it.mesh.material.dispose();
    }
  };
  /* the roll's ground plate: the text is measured and the font shrunk until it
     fits the plate with a margin (D-A868: "label doesn't fit") */
  function makeLabel(text) {
    var W = 1024, H = 256, PAD = 40;
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var g = cv.getContext('2d');
    g.fillStyle = 'rgba(29,31,32,0.92)'; g.fillRect(0, 0, W, H);
    var px = 128;
    g.font = '600 ' + px + 'px "Barlow Condensed", "Barlow", sans-serif';
    var tw = g.measureText(text).width;
    if (tw > W - 2 * PAD) { px = Math.floor(px * (W - 2 * PAD) / tw); g.font = '600 ' + px + 'px "Barlow Condensed", "Barlow", sans-serif'; }
    g.fillStyle = '#ffffff'; g.textBaseline = 'middle';
    g.fillText(text, PAD, H / 2);
    var tex = new THREE.CanvasTexture(cv);
    var m = new THREE.Mesh(new THREE.PlaneGeometry(16, 4), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    return m;
  }
  /* a render target's pixels as a canvas (the GPU hands them back bottom-up) */
  function readRT(rt, w, h) {
    var buf = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    var src = document.createElement('canvas'); src.width = w; src.height = h;
    var img = new ImageData(new Uint8ClampedArray(buf.buffer), w, h);
    src.getContext('2d', { willReadFrequently: true }).putImageData(img, 0, 0);
    var out = document.createElement('canvas'); out.width = w; out.height = h;
    var g = out.getContext('2d', { willReadFrequently: true });
    g.translate(0, h); g.scale(1, -1); g.drawImage(src, 0, 0);
    return out;
  }
  /* the full photo, for the review view, in review orientation (rotated
     180° when the roll runs against the line — see flip) */
  ST.rollImage = function (n) {
    var it = rollItem(n);
    if (!it) return null;
    var cv = it.rt ? readRT(it.rt, it.w, it.h) : imageCanvas(it);
    if (!it.flip) return cv;
    var out = document.createElement('canvas'); out.width = it.w; out.height = it.h;
    var g = out.getContext('2d'); g.translate(it.w, it.h); g.rotate(Math.PI); g.drawImage(cv, 0, 0);
    return out;
  };
  ST.rollFlip = function (n) { var it = rollItem(n); return !!(it && it.flip); };
  ST.rollList = function () { return rollItems.slice(); };
  function rollItem(n) { for (var i = 0; i < rollItems.length; i++) if (rollItems[i].n === n) return rollItems[i]; return null; }

  /* ---- annotations: a pixel on a photo → a point on a wire, and back ---------
     A pixel is a ray from the photo's camera; the wires are known curves, so
     the ray's closest approach to them names the wire and the point on it.
     The point reprojects into any other photo whose frame holds it. This is
     the phase-2 machinery too: a real image with its pose plugs in here. */
  var poseCam = new THREE.Object3D();
  poseCam.rotation.order = 'YXZ';
  function camFromPose(p) {
    poseCam.position.set(p.x, p.z, -p.y);
    poseCam.rotation.set(p.pitch * Math.PI / 180, -p.yaw * Math.PI / 180, 0);
    poseCam.updateMatrixWorld(true);
    return poseCam;
  }
  /* closest approach of a ray (P, d) to a segment (A, B) */
  function raySeg(P, d, A, B) {
    var u = new THREE.Vector3().subVectors(B, A);
    var w = new THREE.Vector3().subVectors(P, A);
    var a = d.dot(d), b = d.dot(u), c = u.dot(u), dd = d.dot(w), e = u.dot(w);
    var den = a * c - b * b;
    var t, s;
    if (den < 1e-9) { s = 0; t = -dd / a; }
    else { s = (a * e - b * dd) / den; s = Math.max(0, Math.min(1, s)); t = (b * s - dd) / a; }
    if (t < 0) t = 0;
    var pr = new THREE.Vector3().copy(P).addScaledVector(d, t);
    var ps = new THREE.Vector3().copy(A).addScaledVector(u, s);
    return { dist: pr.distanceTo(ps), s: s, t: t, point: ps };
  }
  /* photo n, pixel (px, py) in that photo's pixels → the nearest wire point */
  ST.pixelToWire = function (n, px, py) {
    var it = rollItem(n);
    if (!it || !focusPhases.length) return null;
    var cam = camFromPose(it.pose);
    var th = Math.tan(camModel.hfov / 2 * Math.PI / 180), tv = Math.tan(camModel.vfov / 2 * Math.PI / 180);
    var dirLocal = new THREE.Vector3((px / it.w - 0.5) * 2 * th, -(py / it.h - 0.5) * 2 * tv, -1).normalize();
    var d = dirLocal.applyQuaternion(cam.quaternion).normalize();
    var P = cam.position.clone();
    var best = null;
    focusPhases.forEach(function (ph) {
      if (!ph.span) return;
      for (var i = 1; i < ph.pts.length; i++) {
        var A = V(ph.pts[i - 1].x, ph.pts[i - 1].y, ph.pts[i - 1].z), B = V(ph.pts[i].x, ph.pts[i].y, ph.pts[i].z);
        var r = raySeg(P, d, A, B);
        if (!best || r.dist < best.dist) {
          best = { dist: r.dist, wireId: ph.id, wireName: ph.name, s: ph.pts[i - 1].s + (ph.pts[i].s - ph.pts[i - 1].s) * r.s,
            point: { x: r.point.x, y: -r.point.z, z: r.point.y }, range: r.t };
        }
      }
    });
    return best;
  };
  /* a world point → pixel in photo n, or null when outside its frame */
  ST.wireToPixel = function (n, pt) {
    var it = rollItem(n);
    if (!it) return null;
    return pixelFor(it, pt);
  };
  function pixelFor(it, pt) {
    if (!pt) return null;
    var cam = camFromPose(it.pose);
    var inv = new THREE.Matrix4().copy(cam.matrixWorld).invert();
    var v = new THREE.Vector3(pt.x, pt.z, -pt.y).applyMatrix4(inv);
    var depth = -v.z;
    if (depth <= 0.3) return null;
    var th = Math.tan(camModel.hfov / 2 * Math.PI / 180), tv = Math.tan(camModel.vfov / 2 * Math.PI / 180);
    var nx = v.x / (depth * th), ny = v.y / (depth * tv);
    if (Math.abs(nx) > 1 || Math.abs(ny) > 1) return null;
    return { px: (nx / 2 + 0.5) * it.w, py: (0.5 - ny / 2) * it.h, depth: depth };
  }
  /* the point on a wire at arc length s */
  ST.wirePointAt = function (wireId, s) {
    for (var k = 0; k < focusPhases.length; k++) {
      var ph = focusPhases[k];
      if (ph.id !== wireId) continue;
      for (var i = 1; i < ph.pts.length; i++) {
        if (ph.pts[i].s >= s) {
          var a = ph.pts[i - 1], b = ph.pts[i], f = (b.s - a.s) > 0 ? (s - a.s) / (b.s - a.s) : 0;
          return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
        }
      }
      return ph.pts[ph.pts.length - 1];
    }
    return null;
  };
  /* ---- planted defects: real geometry on the wires, part of the world -------
     A splice is a sleeve — a short thick section with a band at each end;
     damage is an X across the wire. They are NOT furniture: the payload
     photographs them the way it photographs the towers, and nothing marks
     them unless the TRUTH toggle is on. */
  var defectObj = null, truthObj = null, truthPicks = null, annoPicks = null;
  /* invisible spheres over points, for double-click picking */
  function pickGroup(points) {
    var g = new THREE.Group();
    var mat = new THREE.MeshBasicMaterial({ visible: false });
    points.forEach(function (p) {
      var m = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 6), mat);
      m.position.set(p.x, p.z, -p.y);
      m.userData.pick = true;
      g.add(m);
    });
    return g;
  }
  function wireFrame(wireId, s) {
    var p = ST.wirePointAt(wireId, s), q = ST.wirePointAt(wireId, s + 0.5);
    if (!p || !q) return null;
    var d = { x: q.x - p.x, y: q.y - p.y, z: q.z - p.z };
    var L = Math.hypot(d.x, d.y, d.z) || 1; d.x /= L; d.y /= L; d.z /= L;
    var side = { x: -d.y, y: d.x, z: 0 };                 /* across the line, level */
    var up = { x: 0, y: 0, z: 1 };
    return { p: p, d: d, side: side, up: up };
  }
  function at(p, a, ka, b, kb) { return V(p.x + a.x * ka + (b ? b.x * kb : 0), p.y + a.y * ka + (b ? b.y * kb : 0), p.z + a.z * ka + (b ? b.z * kb : 0)); }
  ST.setDefects = function (list) {
    if (defectObj) { scene.remove(defectObj); defectObj.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); defectObj = null; }
    if (!list || !list.length) return;
    var sleeve = [], bands = [], xs = [];
    list.forEach(function (df) {
      var f = wireFrame(df.wireId, df.s);
      if (!f) return;
      if (df.kind === 'splice') {
        /* a 0.7 m sleeve, thicker than the wire, with a band each end */
        var s0 = ST.wirePointAt(df.wireId, df.s - 0.35), s1 = ST.wirePointAt(df.wireId, df.s + 0.35);
        sleeve.push(V(s0.x, s0.y, s0.z), V(s1.x, s1.y, s1.z));
        [s0, s1].forEach(function (e) {
          bands.push(at(e, f.side, -0.12, f.up, -0.12), at(e, f.side, 0.12, f.up, 0.12));
          bands.push(at(e, f.side, -0.12, f.up, 0.12), at(e, f.side, 0.12, f.up, -0.12));
        });
      } else {
        /* an X across the wire: two 0.7 m arms crossing at the spot */
        xs.push(at(f.p, f.d, -0.35, f.up, -0.3), at(f.p, f.d, 0.35, f.up, 0.3));
        xs.push(at(f.p, f.d, -0.35, f.up, 0.3), at(f.p, f.d, 0.35, f.up, -0.3));
        xs.push(at(f.p, f.d, -0.35, f.side, -0.3), at(f.p, f.d, 0.35, f.side, 0.3));
        xs.push(at(f.p, f.d, -0.35, f.side, 0.3), at(f.p, f.d, 0.35, f.side, -0.3));
      }
    });
    defectObj = new THREE.Group();
    if (sleeve.length) defectObj.add(fatSegments(sleeve, fatMat(C.ink, 6.0, 1)));
    if (bands.length) defectObj.add(fatSegments(bands, fatMat(C.ink, 2.0, 1)));
    if (xs.length) defectObj.add(fatSegments(xs, fatMat(C.ink, 2.6, 1)));
    scene.add(defectObj);
  };
  /* the truth markers: grey flags, planning furniture, off by default */
  ST.setTruth = function (list) {
    if (truthObj) { scene.remove(truthObj); truthObj.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); truthObj = null; }
    if (truthPicks) { scene.remove(truthPicks); truthPicks.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); truthPicks = null; }
    if (!list || !list.length) return;
    var segs = [], pts = [];
    list.forEach(function (df) {
      var p = ST.wirePointAt(df.wireId, df.s);
      if (!p) return;
      pts.push(p);
      segs.push(V(p.x, p.y, p.z - 0.4), V(p.x, p.y, p.z - 3.4));
      segs.push(V(p.x, p.y, p.z - 3.4), V(p.x - 1.2, p.y, p.z - 2.8));
      segs.push(V(p.x - 1.2, p.y, p.z - 2.8), V(p.x, p.y, p.z - 2.2));
    });
    truthObj = new THREE.Group();
    truthObj.add(fatSegments(segs, fatMat('#7a7a7d', 1.6, 0.9, true)));
    scene.add(truthObj);
    truthPicks = pickGroup(pts);
    scene.add(truthPicks);
  };

  /* the same findings drawn on the photos lying on the ground: a box on
     every frame whose camera saw the spot, in the frame's own plane */
  var annoRollObj = null;
  ST.drawRollAnnotations = function (list) {
    if (annoRollObj) { scene.remove(annoRollObj); annoRollObj.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); annoRollObj = null; }
    var items = allRollItems();
    if (!list || !list.length || !items.length) return;
    var black = [], purple = [];
    items.forEach(function (it) {
      var geo = it.mesh.geometry.parameters, w = geo.width, h = geo.height;
      it.mesh.updateMatrixWorld(true);
      list.forEach(function (a) {
        var e = annoEnds(a);
        var p0 = pixelFor(it, e[0]), p1 = pixelFor(it, e[1]);
        if (!p0 || !p1) return;
        var pad = 0.04;
        var x0 = Math.min(p0.px, p1.px) / it.w - pad, x1 = Math.max(p0.px, p1.px) / it.w + pad;
        var y0 = Math.min(p0.py, p1.py) / it.h - pad, y1 = Math.max(p0.py, p1.py) / it.h + pad;
        /* pixel fractions → the plane's local metres (PlaneGeometry: x right, y up) */
        function L(fx, fy) { return it.mesh.localToWorld(new THREE.Vector3((fx - 0.5) * w, (0.5 - fy) * h, 0.03)); }
        var c = [L(x0, y0), L(x1, y0), L(x1, y1), L(x0, y1)];
        var segs = a.kind === 'damage' ? purple : black;
        for (var i = 0; i < 4; i++) segs.push(c[i], c[(i + 1) % 4]);
      });
    });
    annoRollObj = new THREE.Group();
    annoRollObj.visible = rollsShown;
    if (black.length) annoRollObj.add(fatSegments(black, fatMat('#000000', 2.4, 1)));
    if (purple.length) annoRollObj.add(fatSegments(purple, fatMat('#7b2cbf', 2.4, 1)));
    scene.add(annoRollObj);
  };

  /* an annotation's ends in the world: the stored points (any span), else
     the wire samples when its span is in focus */
  function annoEnds(a) {
    if (a.p0 && a.p1) return [a.p0, a.p1];
    var q0 = ST.wirePointAt(a.wireId, a.s0), q1 = ST.wirePointAt(a.wireId, a.s1);
    if (q0 && q1) return [q0, q1];
    return [a.point, a.point];
  }
  /* the markers on the wires: black for a splice, purple for damage — for
     every span's findings, from their stored world points */
  var annoObj = null;
  ST.drawAnnotations = function (list) {
    if (annoObj) { scene.remove(annoObj); annoObj.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); annoObj = null; }
    if (annoPicks) { scene.remove(annoPicks); annoPicks.traverse(function (o) { if (o.geometry) o.geometry.dispose(); }); annoPicks = null; }
    ST.drawRollAnnotations(list);
    if (!list || !list.length) return;
    var black = [], purple = [], flags = [], pts = [];
    list.forEach(function (a) {
      var e = annoEnds(a);
      if (!e[0] || !e[1]) return;
      var segs = a.kind === 'damage' ? purple : black;
      /* the mark, stretched 0.15 m past each end so a point finding still reads */
      var dx = e[1].x - e[0].x, dy = e[1].y - e[0].y, dz = e[1].z - e[0].z, L = Math.hypot(dx, dy, dz);
      var ux = L > 0.01 ? dx / L : 1, uy = L > 0.01 ? dy / L : 0, uz = L > 0.01 ? dz / L : 0;
      segs.push(V(e[0].x - ux * 0.15, e[0].y - uy * 0.15, e[0].z - uz * 0.15 + 0.05), V(e[1].x + ux * 0.15, e[1].y + uy * 0.15, e[1].z + uz * 0.15 + 0.05));
      var m = { x: (e[0].x + e[1].x) / 2, y: (e[0].y + e[1].y) / 2, z: (e[0].z + e[1].z) / 2 };
      if (m) {
        pts.push(m);
        /* a flag above the spot so it reads from a distance */
        flags.push(V(m.x, m.y, m.z), V(m.x, m.y, m.z + 3));
        flags.push(V(m.x, m.y, m.z + 3), V(m.x + 1.2, m.y, m.z + 2.4));
        flags.push(V(m.x + 1.2, m.y, m.z + 2.4), V(m.x, m.y, m.z + 1.8));
      }
    });
    annoObj = new THREE.Group();
    if (black.length) annoObj.add(fatSegments(black, fatMat('#000000', 7.0, 1)));
    if (purple.length) annoObj.add(fatSegments(purple, fatMat('#7b2cbf', 7.0, 1)));
    if (flags.length) annoObj.add(fatSegments(flags, fatMat('#1d1f20', 1.6, 0.9)));
    scene.add(annoObj);
    annoPicks = pickGroup(pts);
    scene.add(annoPicks);
  };
  /* fly the view to a finding by index (the DETAILS list uses this) */
  ST.flyTo = function (p, dist) {
    ST.chase = false;
    ST.goTo(p, dist || 12, view.az, Math.max(0.25, view.el), 700);
  };

  /* layout: { origin {x,y,z}, u {x,y} unit along the line, lateral (signed
     metres across the line for this roll), along (metres from origin),
     w, h (frame metres), rollKey, label } — pose as in shotCaptures */
  ST.rollAddFrame = function (shot, pos, hdgDeg, gimPitchDeg, gimYawTotalDeg, layout) {
    ensureRolls();
    /* the photo */
    rollCam.fov = camModel.vfov; rollCam.aspect = camModel.aspect; rollCam.updateProjectionMatrix();
    rollCam.position.set(pos.x, pos.z, -pos.y);
    rollCam.rotation.set(gimPitchDeg * Math.PI / 180, -gimYawTotalDeg * Math.PI / 180, 0);
    /* the actual photo: the payload's frame at a real resolution, the
       fat-line widths computed for THIS frame (not the main canvas),
       multisampled — and hidden while it renders so it never photographs
       the other photos */
    var RW = ROLL_W, RH = Math.round(ROLL_W / camModel.aspect);
    var rt = new THREE.WebGLRenderTarget(RW, RH, { samples: 4 });
    rt.texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1);
    var furniture = [layers.ground, layers.missions, layers.launch, layers.route, layers.sticks, trailObj, droneGroup, focusObj, trailCov, rollGroup, hiObj, annoRollObj, annoObj, truthObj, tilesGroup];
    var was = furniture.map(function (o) { return o ? o.visible : null; });
    furniture.forEach(function (o) { if (o) o.visible = false; });
    var resW = lineRes.x, resH = lineRes.y;
    lineRes.set(RW, RH);
    renderer.setRenderTarget(rt);
    renderer.setClearColor(new THREE.Color('#ffffff'), 1);
    renderer.render(scene, rollCam);
    renderer.setClearColor(new THREE.Color(C.bg), 1);
    renderer.setRenderTarget(null);
    lineRes.set(resW, resH);
    furniture.forEach(function (o, i) { if (o) o.visible = was[i]; });
    /* on the ground: x along the line, image-up toward the line */
    var nx = -layout.u.y, ny = layout.u.x;          /* left normal */
    var cx = layout.origin.x + layout.u.x * layout.along + nx * layout.lateral;
    var cy = layout.origin.y + layout.u.y * layout.along + ny * layout.lateral;
    var cz = ST.groundAt(cx, cy) + 0.15 + rollItems.length * 0.0005;
    var mesh = new THREE.Mesh(new THREE.PlaneGeometry(layout.w, layout.h),
      new THREE.MeshBasicMaterial({ map: rt.texture, side: THREE.DoubleSide }));
    var ang = Math.atan2(layout.u.x, layout.u.y);     /* line bearing */
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = -ang + Math.PI / 2 + (layout.lateral > 0 ? Math.PI : 0);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(cx, cz, -cy);
    mesh.userData.n = shot.n;
    mesh.userData.key = rollKey;
    rollGroup.add(mesh);
    /* the frame edge */
    var hw = layout.w / 2, hh = layout.h / 2, e = [];
    var corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    var ca = Math.cos(-ang + Math.PI / 2), sa = Math.sin(-ang + Math.PI / 2);
    var cw = corners.map(function (c) { return V(cx + c[0] * layout.u.x + c[1] * nx, cy + c[0] * layout.u.y + c[1] * ny, cz + 0.02); });
    for (var i = 0; i < 4; i++) e.push(cw[i], cw[(i + 1) % 4]);
    var edge = fatSegments(e, fatMat(shot.code && shot.code[0] === 'B' ? C.b : C.a, 1.2, 0.8));
    rollGroup.add(edge);
    /* does this photo's image-right run WITH the line (tower a → b)? When
       the camera faces the wires from the other side it runs against it,
       and the review shows that roll rotated 180° so left is always tower a */
    var yawR = (gimYawTotalDeg + 90) * Math.PI / 180;
    var flip = (Math.sin(yawR) * layout.u.x + Math.cos(yawR) * layout.u.y) < 0;
    /* a thumbnail for the review navigator, read back once at capture, in
       review orientation */
    var thumb = null;
    try {
      var big = readRT(rt, RW, RH);
      var tc = document.createElement('canvas'); tc.width = 200; tc.height = Math.round(200 * RH / RW);
      var tg = tc.getContext('2d');
      if (flip) { tg.translate(tc.width, tc.height); tg.rotate(Math.PI); }
      tg.drawImage(big, 0, 0, tc.width, tc.height);
      thumb = tc.toDataURL('image/jpeg', 0.82);
    } catch (e) { thumb = null; }
    rollItems.push({ n: shot.n, rt: rt, mesh: mesh, edge: edge, w: RW, h: RH, thumb: thumb, flip: flip,
      place: { x: cx, y: cy, z: cz, rotY: mesh.rotation.y, pw: layout.w, ph: layout.h, corners: cw.map(function (v) { return [v.x, v.y, v.z]; }) },
      pose: { x: pos.x, y: pos.y, z: pos.z, hdg: hdgDeg, pitch: gimPitchDeg, yaw: gimYawTotalDeg },
      code: shot.code, mission: shot.mission, index: shot.index, suffix: shot.suffix || '',
      along: layout.along, frameW: layout.w, rollKey: layout.rollKey, label: layout.label });
    /* the roll's label, once, at its start */
    if (layout.rollKey && !rollLabels[layout.rollKey]) {
      var lab = makeLabel(layout.label || layout.rollKey);
      var lx = layout.origin.x + layout.u.x * (layout.labelAlong != null ? layout.labelAlong : -10) + nx * layout.lateral;
      var ly = layout.origin.y + layout.u.y * (layout.labelAlong != null ? layout.labelAlong : -10) + ny * layout.lateral;
      lab.rotation.order = 'YXZ';
      lab.rotation.y = -ang + Math.PI / 2 + (layout.lateral > 0 ? Math.PI : 0);
      lab.rotation.x = -Math.PI / 2;
      var lz = ST.groundAt(lx, ly) + 0.2;
      lab.position.set(lx, lz, -ly);
      rollGroup.add(lab);
      lab.userData.place = { text: layout.label || layout.rollKey, x: lx, y: ly, z: lz, rotY: lab.rotation.y };
      rollLabels[layout.rollKey] = lab;
    }
    void ca; void sa;
  };
  /* an imported frame's pixels as a canvas (the review view reads it) */
  function imageCanvas(it) {
    var cv = document.createElement('canvas'); cv.width = it.w; cv.height = it.h;
    cv.getContext('2d').drawImage(it.tex.image, 0, 0, it.w, it.h);
    return cv;
  }
  /* EXPORT the current span's rolls (D-A869): every frame as a JPEG blob with
     its placement, pose and review data, plus the label plates */
  ST.rollsExport = async function (quality) {
    var frames = [];
    for (var i = 0; i < rollItems.length; i++) {
      var it = rollItems[i];
      var cv = it.rt ? readRT(it.rt, it.w, it.h) : imageCanvas(it);
      var blob = await new Promise(function (res) { cv.toBlob(res, 'image/jpeg', quality || 0.85); });
      frames.push({ n: it.n, w: it.w, h: it.h, thumb: it.thumb, flip: it.flip, pose: it.pose, code: it.code, mission: it.mission, index: it.index,
        suffix: it.suffix, along: it.along, frameW: it.frameW, rollKey: it.rollKey, label: it.label, place: it.place, blob: blob });
    }
    var labels = Object.keys(rollLabels).map(function (k) { return Object.assign({ key: k }, rollLabels[k].userData.place || {}); });
    return { frames: frames, labels: labels };
  };
  /* IMPORT a stored set into the current span's rolls (after the live ones) */
  ST.rollsImport = async function (data) {
    if (!data || !data.frames) return 0;
    var key = rollKey;
    function containers() {
      if (rollKey === key) { ensureRolls(); return { group: rollGroup, items: rollItems, labels: rollLabels }; }
      var s = rollSets[key];
      if (!s) { s = rollSets[key] = { group: new THREE.Group(), items: [], labels: {} }; s.group.visible = rollsShown; scene.add(s.group); }
      return s;
    }
    var group, items, labels, cc;
    for (var i = 0; i < data.frames.length; i++) {
      var f = data.frames[i];
      var bmp;
      try { bmp = await createImageBitmap(f.blob); } catch (e) { continue; }
      cc = containers(); group = cc.group; items = cc.items; labels = cc.labels;
      var tex = new THREE.CanvasTexture(bmp);
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy ? renderer.capabilities.getMaxAnisotropy() : 1);
      var mesh = new THREE.Mesh(new THREE.PlaneGeometry(f.place.pw, f.place.ph), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
      mesh.rotation.order = 'YXZ'; mesh.rotation.y = f.place.rotY; mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(f.place.x, f.place.z, -f.place.y);
      mesh.userData.n = f.n; mesh.userData.key = key;
      group.add(mesh);
      var e = [], cw = f.place.corners.map(function (c) { return new THREE.Vector3(c[0], c[1], c[2]); });
      for (var k = 0; k < 4; k++) e.push(cw[k], cw[(k + 1) % 4]);
      var edge = fatSegments(e, fatMat(f.code && f.code[0] === 'B' ? C.b : C.a, 1.2, 0.8));
      group.add(edge);
      items.push({ n: f.n, rt: null, tex: tex, mesh: mesh, edge: edge, w: f.w, h: f.h, thumb: f.thumb, flip: f.flip, place: f.place,
        pose: f.pose, code: f.code, mission: f.mission, index: f.index, suffix: f.suffix || '', along: f.along, frameW: f.frameW, rollKey: f.rollKey, label: f.label });
    }
    cc = containers(); group = cc.group; items = cc.items; labels = cc.labels;
    (data.labels || []).forEach(function (l) {
      if (labels[l.key]) return;
      var lab = makeLabel(l.text || l.key);
      lab.rotation.order = 'YXZ'; lab.rotation.y = l.rotY; lab.rotation.x = -Math.PI / 2;
      lab.position.set(l.x, l.z, -l.y);
      lab.userData.place = l;
      group.add(lab);
      labels[l.key] = lab;
    });
    return items.length;
  };
  /* how many frames a parked set holds */
  ST.rollsCountOf = function (key) { return key === rollKey ? rollItems.length : (rollSets[key] ? rollSets[key].items.length : 0); };
  ST.droneVisible = function (v) { ensureDrone(); droneGroup.visible = !!v; if (!v) ST.clearTrail(); };
  ST.clearTrail = function () { trail = []; if (trailObj) { scene.remove(trailObj); trailObj.geometry.dispose(); trailObj = null; } };
  ST.setDronePose = function (p) {
    ensureDrone();
    droneGroup.visible = true;
    var s = ST.droneScale || 1;
    droneGroup.scale.set(s, s, s);
    droneGroup.position.set(p.x, p.z, -p.y);
    droneGroup.rotation.y = -(p.hdgDeg || 0) * Math.PI / 180;
    camRig.rotation.y = -(p.gimbalYawDeg || 0) * Math.PI / 180;
    camRig.rotation.x = (p.gimbalDeg || 0) * Math.PI / 180;
    var spin = p.rotor != null ? p.rotor : 1;
    droneRotors.forEach(function (r, i) { r.rotation.y += (0.9 + i * 0.07) * spin; });
    fpvCam.position.set(p.x, p.z - 0.08 * s, -p.y);
    fpvCam.rotation.y = -((p.hdgDeg || 0) + (p.gimbalYawDeg || 0)) * Math.PI / 180;
    fpvCam.rotation.x = (p.gimbalDeg || 0) * Math.PI / 180;
    /* the optics are true metres: undo the airframe's display scale */
    if (optics) { optics.scale.set(1 / s, 1 / s, 1 / s); optics.visible = p.mode !== 'ground'; }
    dronePos3.set(p.x, p.z, -p.y);
    /* the flown trail: a bead every ~2 m */
    var last = trail[trail.length - 1];
    if (!last || last.distanceTo(dronePos3) > 2) {
      trail.push(dronePos3.clone());
      if (trail.length > 1) {
        if (trailObj) { scene.remove(trailObj); trailObj.geometry.dispose(); }
        var pts = [];
        for (var i = 1; i < trail.length; i++) pts.push(trail[i - 1], trail[i]);
        trailObj = fatSegments(pts, fatMat(C.acc, 1.2, 0.5));
        scene.add(trailObj);
      }
    }
    if (ST.chase) { viewAnim = null; view.tx = p.x; view.ty = p.z; view.tz = -p.y; }
  };

  /* ---- render --------------------------------------------------------------- */
  ST.fpv = { on: true, w: 360 };
  ST.render = function () {
    if (!renderer) return;
    stepAnim();
    applyFindingsOnly();
    var cw = canvas.clientWidth || 900, ch = canvas.clientHeight || 600;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, cw, ch);
    var t = new THREE.Vector3(view.tx, view.ty, view.tz);
    camera.position.set(
      t.x + Math.sin(view.az) * Math.cos(view.el) * view.dist,
      t.y + Math.sin(view.el) * view.dist,
      t.z + Math.cos(view.az) * Math.cos(view.el) * view.dist);
    camera.lookAt(t);
    renderer.render(scene, camera);
    if (ST.fpv.on && fpvCam && droneGroup && droneGroup.visible) {
      var TW = ST.fpv.w, TH = Math.round(TW / (camModel.aspect || 4 / 3)), x0 = cw - TW - 16, y0 = 16;
      renderer.setScissorTest(true);
      renderer.setViewport(x0, y0, TW, TH);
      renderer.setScissor(x0, y0, TW, TH);
      /* the payload sees the world, not the plan: towers and conductors
         only — no grid, no mission paths, no pad, no route, no trail, and
         never the airframe it hangs from */
      var furniture = [layers.ground, layers.missions, layers.launch, layers.route, layers.sticks, trailObj, droneGroup, focusObj, trailCov, rollGroup, annoRollObj, hiObj, truthObj, annoObj, tilesGroup];
      var was = furniture.map(function (o) { return o ? o.visible : null; });
      furniture.forEach(function (o) { if (o) o.visible = false; });
      renderer.render(scene, fpvCam);
      furniture.forEach(function (o, i) { if (o) o.visible = was[i]; });
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, cw, ch);
    }
  };
  ST.debug = function () { return { scene: scene, renderer: renderer, camera: camera, layers: layers, circuit: circuit, group: group }; };

  root.STAGE = ST;
})(window);

/* map.js — the Leaflet overview map (D-A848): where the circuit is, drawn
   from the same towers the 3D world uses. The line as a polyline, the spans
   with missions in blue, the inspected spans in yellow, the focused span in
   orange, the aircraft and the launch spot while a flight runs. Click the
   map near the line to jump the 3D view to that span.

   Tiles come from OpenStreetMap when the browser is online; the packed
   offline file shows the circuit on a blank background. Leaflet 1.9.4 is
   vendored in vendor/leaflet (BSD-2, © Vladimir Agafonkin). */
(function (root) {
  'use strict';
  var MAP = {};
  var map = null, circuit = null, layers = {}, onSpan = null, onHold = null, holdAt = 0, focusIdx = -1, ready = false;
  var C = { ink: '#1d1f20', a: '#2f6fed', done: '#f2c200', focus: '#f47b47', pad: '#f47b47', grey: '#9aa0a6' };

  MAP.init = function (el, opts) {
    if (map || typeof L === 'undefined') return map;
    onSpan = opts && opts.onSpan;
    onHold = opts && opts.onHold;
    map = L.map(el, { zoomControl: true, attributionControl: true, preferCanvas: true });
    /* bases and the hillshade overlay (D-A891): Leaflet is flat, relief here is
       a shaded tile on top; the layers control at top right, the choice kept */
    var base = {
      'Map': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }),
      'Topo': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 19, maxNativeZoom: 17, attribution: '&copy; OpenStreetMap, SRTM | style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' }),
      'Satellite': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' })
    };
    var over = { 'Hillshade': L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 16, opacity: 0.45, attribution: 'Hillshade &copy; Esri' }) };
    var mp = {}; try { mp = JSON.parse(localStorage.getItem('asi.map.v1') || '{}'); } catch (e) { mp = {}; }
    var saveMp = function () { try { localStorage.setItem('asi.map.v1', JSON.stringify(mp)); } catch (e) {} };
    (base[mp.base] || base.Map).addTo(map);
    if (mp.hillshade) over.Hillshade.addTo(map);
    L.control.layers(base, over, { position: 'topright', collapsed: true }).addTo(map);
    map.on('baselayerchange', function (e) { mp.base = e.name; saveMp(); });
    map.on('overlayadd', function (e) { if (e.name === 'Hillshade') { mp.hillshade = true; saveMp(); } });
    map.on('overlayremove', function (e) { if (e.name === 'Hillshade') { mp.hillshade = false; saveMp(); } });
    layers.route = L.layerGroup().addTo(map);
    layers.missions = L.layerGroup().addTo(map);
    layers.inspected = L.layerGroup().addTo(map);
    layers.focus = L.layerGroup().addTo(map);
    layers.flight = L.layerGroup().addTo(map);
    /* press and hold (or right click) anywhere: the point's coordinates go
       to onHold (D-A893). The click Leaflet raises when the finger lifts
       after a hold is swallowed so the focus does not jump. */
    var hold = null, hc = map.getContainer();
    var cancelHold = function () { if (hold) { clearTimeout(hold.t); hold = null; } };
    var fireHold = function (x, y) { holdAt = Date.now(); if (onHold) onHold(map.mouseEventToLatLng({ clientX: x, clientY: y })); };
    hc.addEventListener('pointerdown', function (ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      cancelHold();
      hold = { x: ev.clientX, y: ev.clientY, t: setTimeout(function () { hold = null; fireHold(ev.clientX, ev.clientY); }, 650) };
    });
    hc.addEventListener('pointermove', function (ev) { if (hold && Math.hypot(ev.clientX - hold.x, ev.clientY - hold.y) > 8) cancelHold(); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (n) { hc.addEventListener(n, cancelHold); });
    hc.addEventListener('contextmenu', function (ev) { ev.preventDefault(); cancelHold(); if (Date.now() - holdAt > 1000) fireHold(ev.clientX, ev.clientY); });
    map.on('click', function (ev) {
      if (Date.now() - holdAt < 800) return;
      if (!circuit || !onSpan) return;
      var i = nearestSpan(ev.latlng);
      if (i >= 0) onSpan(i);
    });
    ready = true;
    return map;
  };
  MAP.ready = function () { return ready; };
  /* a short-lived note on the map at a point (the copied coordinates) */
  MAP.flash = function (latlng, text) {
    if (!map) return;
    var p = L.popup({ closeButton: false, autoClose: true, closeOnClick: true, className: 'flash', offset: [0, -4] }).setLatLng(latlng).setContent(text).openOn(map);
    setTimeout(function () { if (p.isOpen()) map.closePopup(p); }, 2200);
  };
  MAP.fmtLL = function (lat, lon) { return lat.toFixed(6) + ', ' + lon.toFixed(6); };
  MAP.invalidate = function () { if (map) setTimeout(function () { map.invalidateSize(); }, 50); };

  function ll(t) { return [t.lat, t.lon]; }
  function nearestSpan(latlng) {
    var f = circuit.frame, q = f.toXY({ lon: latlng.lng, lat: latlng.lat, alt: 0 });
    var best = -1, bd = Infinity, T = circuit.towers;
    for (var i = 0; i + 1 < T.length; i++) {
      var a = T[i], b = T[i + 1], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
      var t = L2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / L2)) : 0;
      var d = Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy));
      if (d < bd) { bd = d; best = i; }
    }
    /* within a sensible reach of the line at this zoom: 2 km at the coarse
       zooms, tighter as you zoom in */
    var reach = Math.max(60, 2000 / Math.pow(2, Math.max(0, map.getZoom() - 11)));
    return bd <= reach ? best : -1;
  }

  MAP.setCircuit = function (c) {
    circuit = c; focusIdx = -1;
    if (!map) return;
    ['route', 'missions', 'inspected', 'focus', 'flight'].forEach(function (k) { layers[k].clearLayers(); });
    if (!c || !c.towers.length) return;
    L.polyline(c.towers.map(ll), { color: C.ink, weight: 2, opacity: 0.85 }).addTo(layers.route);
    /* the two ends named */
    [c.towers[0], c.towers[c.towers.length - 1]].forEach(function (t) {
      L.circleMarker(ll(t), { radius: 4, color: C.ink, fillColor: '#fff', fillOpacity: 1, weight: 1.5 }).bindTooltip(t.name, { permanent: false }).addTo(layers.route);
    });
    map.fitBounds(L.latLngBounds(c.towers.map(ll)), { padding: [16, 16] });
  };
  /* spans that carry missions: indexes of the first tower of each */
  MAP.setMissionSpans = function (idxs) {
    if (!map || !circuit) return;
    layers.missions.clearLayers();
    (idxs || []).forEach(function (i) {
      var a = circuit.towers[i], b = circuit.towers[i + 1]; if (!a || !b) return;
      L.polyline([ll(a), ll(b)], { color: C.a, weight: 5, opacity: 0.9 }).bindTooltip(a.name + ' → ' + b.name).addTo(layers.missions);
    });
  };
  /* spans with a dataset on the ground */
  MAP.setInspected = function (idxs) {
    if (!map || !circuit) return;
    layers.inspected.clearLayers();
    (idxs || []).forEach(function (i) {
      var a = circuit.towers[i], b = circuit.towers[i + 1]; if (!a || !b) return;
      L.polyline([ll(a), ll(b)], { color: C.done, weight: 7, opacity: 0.85 }).addTo(layers.inspected);
    });
  };
  MAP.setFocus = function (i, pan) {
    if (!map || !circuit) return;
    layers.focus.clearLayers();
    focusIdx = i;
    var a = circuit.towers[i], b = circuit.towers[i + 1]; if (!a || !b) return;
    L.polyline([ll(a), ll(b)], { color: C.focus, weight: 9, opacity: 0.95 }).addTo(layers.focus);
    [a, b].forEach(function (t) {
      L.circleMarker(ll(t), { radius: 5, color: C.focus, fillColor: '#fff', fillOpacity: 1, weight: 2 }).bindTooltip(t.name).addTo(layers.focus);
    });
    var mid = L.latLng((a.lat + b.lat) / 2, (a.lon + b.lon) / 2);
    if (pan || !map.getBounds().contains(mid)) map.setView(mid, Math.max(map.getZoom(), 15));
  };
  /* the flight: aircraft and launch spot, in the circuit's frame (x, y east/north metres) */
  var droneMk = null, padMk = null;
  MAP.setLaunch = function (p) {
    if (!map || !circuit) return;
    if (padMk) { layers.flight.removeLayer(padMk); padMk = null; }
    if (!p) return;
    var q = circuit.frame.toLL(p.x, p.y);
    padMk = L.circleMarker([q.lat, q.lon], { radius: 5, color: C.pad, fillColor: C.pad, fillOpacity: 0.3, weight: 2 }).bindTooltip('launch spot · ' + MAP.fmtLL(q.lat, q.lon)).addTo(layers.flight);
  };
  MAP.setDrone = function (p) {
    if (!map || !circuit) return;
    if (!p) { if (droneMk) { layers.flight.removeLayer(droneMk); droneMk = null; } return; }
    var q = circuit.frame.toLL(p.x, p.y), at = [q.lat, q.lon];
    if (!droneMk) droneMk = L.circleMarker(at, { radius: 6, color: '#fff', fillColor: C.focus, fillOpacity: 1, weight: 2 }).addTo(layers.flight);
    else droneMk.setLatLng(at);
  };
  root.MAP = MAP;
})(window);

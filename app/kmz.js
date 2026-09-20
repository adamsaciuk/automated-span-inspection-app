/* kmz.js — the readers: a circuit KMZ (towers, conductors, planned
   missions) and a DJI WPML mission group (a zip of .kmz waylines, or one
   .kmz) in; plain objects out.

   Zero dependencies. The zip is walked by hand (central directory →
   local headers) and entries inflate with the platform's
   DecompressionStream('deflate-raw'), which browsers and Node 18+ both
   ship. XML is read with small tokenizers rather than a DOM so the very
   same code verifies under Node.

   Circuit shape (coordinates WGS84 + EGM96-ish absolute metres, exactly
   as the source carries them; the projection is geo.js's job):
     { name, towers: [{name, lon, lat, base, top}],
       spans:  [{ id, a, b, phases: [{name, pts}], missions: [...] }] }
   A planned mission: { id, code ('A1'|'A2'|'B1'|'B2'), dir, level,
     name, path: [pt], wps: [pt], phases: [{name, pts}] } — pt = {lon,lat,alt}.

   WPML mission shape:
     { name, file, kind ('span'|'check'), code, dir, level, a, b,
       cfg { takeOffSecurityHeight, transitionalSpeed, autoFlightSpeed,
             finishAction, rthHeight, droneEnum, payloadEnum, heightMode },
       wps: [{ index, lon, lat, alt (EGM96 when the template carries it),
               ellipsoid, speed, hdg (deg, null = follow the wayline),
               hdgMode, turnMode, gimbalPitch,
               actions: [{type:'gimbal', pitch, yaw, yawBase} |
                         {type:'hover', s} | {type:'photo', suffix, lens} |
                         {type:'zoom', factor} | {type:'other', func}] }] } */
(function (root) {
  'use strict';

  var KMZ = {};

  /* ---- zip ------------------------------------------------------------- */

  async function inflateRaw(bytes) {
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  KMZ.unzip = async function (buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var eocd = -1;
    for (var i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a zip archive (no central directory).');
    var count = dv.getUint16(eocd + 10, true);
    var cdOff = dv.getUint32(eocd + 16, true);
    var out = {};
    var p = cdOff;
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt central directory.');
      var method = dv.getUint16(p + 10, true);
      var csize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
      var lNameLen = dv.getUint16(localOff + 26, true);
      var lExtraLen = dv.getUint16(localOff + 28, true);
      var dataStart = localOff + 30 + lNameLen + lExtraLen;
      var raw = u8.subarray(dataStart, dataStart + csize);
      if (method === 0) out[name] = raw;
      else if (method === 8) out[name] = await inflateRaw(raw);
      else throw new Error('Unsupported zip method ' + method + ' for ' + name);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  };

  KMZ.isZip = function (u8) { return u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4b; };

  /* ---- helpers ---------------------------------------------------------- */

  function text(re, s) { var m = s.match(re); return m ? m[1] : null; }
  function num(re, s, dflt) { var v = text(re, s); return v == null || v === '' ? dflt : Number(v); }
  function coords(s) {
    return s.trim().split(/\s+/).map(function (t) {
      var c = t.split(',').map(Number);
      return { lon: c[0], lat: c[1], alt: c[2] || 0 };
    });
  }
  function baseName(path) { return path.replace(/^.*[\\\/]/, '').replace(/\.[^.]+$/, ''); }

  /* "467AH_200-1485to200-1486" → span towers + code; "GIMBALTEST_…" → check */
  KMZ.decodeMissionName = function (name) {
    var m = name.match(/(?:^|[^A-Za-z0-9])(\d+)?([AB])([HL])_([\w\-\/]+?)to([\w\-\/]+)$/i);
    if (m) {
      var dir = m[2].toUpperCase(), lvl = m[3].toUpperCase();
      return { kind: 'span', seq: m[1] || '', dir: dir, level: lvl,
        code: dir + (lvl === 'H' ? '1' : '2'),
        a: m[4].replace('-', '/'), b: m[5].replace('-', '/') };
    }
    /* the span-plan scheme: <seq>-<plan>-<towerA>-<towerB>-<A|B>, one pass per
       direction, tower codes with the punctuation dropped (000/001A → 000001A,
       SAN_LUIS_OBISPO_SUB → SANLUISOBISPOSUB); no H/L level, code = direction */
    var s2 = name.match(/(?:^|[^A-Za-z0-9])(\d+)-([A-Za-z0-9]+)-([A-Za-z0-9]+)-([A-Za-z0-9]+)-([AB])$/i);
    if (s2) {
      var d2 = s2[5].toUpperCase();
      return { kind: 'span', seq: s2[1], plan: s2[2], dir: d2, level: null, code: d2, a: s2[3], b: s2[4], codes: true };
    }
    if (/gimbal/i.test(name)) return { kind: 'check', code: 'GIMBAL', dir: '', level: '' };
    return { kind: 'other', code: name.slice(0, 6).toUpperCase(), dir: '', level: '' };
  };

  /* ---- the circuit KML -------------------------------------------------- */

  function readTower(pm) {
    var name = text(/<name>([^<]*)<\/name>/, pm);
    var cs = text(/<coordinates>([\s\S]*?)<\/coordinates>/, pm);
    if (!name || !cs) return null;
    var c = coords(cs);
    return { name: name, lon: c[0].lon, lat: c[0].lat, base: c[0].alt,
      top: c[c.length - 1] ? c[c.length - 1].alt : c[0].alt };
  }

  KMZ.parseCircuit = function (kml) {
    /* the circuit only (D-A812, D-A847, D-A865): towers in line order and the
       conductor geometry per span. The KML's demonstrated missions (mission
       paths, waypoints) are NOT read — the missions come from the WPML group.
       Conductors are recognised by their placemark name, "2001485-2001486 A H
       phase 1", or by sitting in a "Conductors" folder under a span folder
       named "2001485-2001486 …" (the summary export said "… A1 H", the Google
       Earth preview says "… A H" — both read). */
    var circuit = { name: text(/<Document>\s*<name>([^<]*)<\/name>/, kml) || 'circuit',
      towers: [], spans: [] };
    var byCode = {};
    var tokens = kml.split(/(?=<Folder>|<\/Folder>|<Placemark[ >]|<\/Placemark>)/);
    var stack = [], spanMap = {};

    function towerOf(code) {
      if (byCode[code]) return byCode[code].name;
      return code.length > 3 ? code.slice(0, 3) + '/' + code.slice(3) : code;
    }
    function spanFor(codeA, codeB) {
      var a = towerOf(codeA), b = towerOf(codeB);
      var id = a + ' > ' + b;
      if (!spanMap[id]) {
        spanMap[id] = { id: id, a: a, b: b, phases: [], missions: [] };
        circuit.spans.push(spanMap[id]);
      }
      return spanMap[id];
    }
    function phaseKey(pts) {
      return pts.map(function (q) { return q.alt.toFixed(1); }).sort().join('/');
    }
    function spanCodesIn(name) {
      var mm = (name || '').match(/^(\w+)-(\w+)\b/);
      return mm ? [mm[1], mm[2]] : null;
    }
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (t.indexOf('<Folder>') === 0) {
        stack.push(text(/<name>([^<]*)<\/name>/, t) || '?');
      } else if (t.indexOf('</Folder>') === 0) {
        stack.pop();
      } else if (t.indexOf('<Placemark') === 0) {
        var top = stack[stack.length - 1] || '';
        var pname = text(/<name>([^<]*)<\/name>/, t) || '';
        if (top === 'Towers') {
          var tw = readTower(t);
          if (tw) { circuit.towers.push(tw); byCode[tw.name.replace('/', '')] = tw; }
          continue;
        }
        var isPhase = /\bphase\s*\d+/i.test(pname) || top === 'Conductors';
        if (!isPhase || /mission path/i.test(pname)) continue;
        var codes = spanCodesIn(pname);
        for (var d = stack.length - 1; !codes && d >= 0; d--) codes = spanCodesIn(stack[d]);
        if (!codes) continue;
        var pcs = text(/<coordinates>([\s\S]*?)<\/coordinates>/, t);
        if (!pcs) continue;
        var ppts = coords(pcs), key = phaseKey(ppts), span = spanFor(codes[0], codes[1]);
        if (span.phases.some(function (q) { return q.key === key; })) continue;
        span.phases.push({ name: pname.replace(/\s+[AB]\s*[12]?\s+[HL]\s+phase/i, ' phase'), pts: ppts, key: key });
      }
    }
    circuit.spans.forEach(function (s) {
      s.phases.sort(function (p, q) { return q.pts[0].alt - p.pts[0].alt; });
    });
    var idx = {};
    circuit.towers.forEach(function (tw, k) { idx[tw.name] = k; });
    circuit.spans.sort(function (p, q) { return (idx[p.a] || 0) - (idx[q.a] || 0); });
    return circuit;
  };

  /* ---- DJI WPML --------------------------------------------------------- */

  function readActions(pm) {
    var acts = [];
    var groups = pm.match(/<wpml:actionGroup>[\s\S]*?<\/wpml:actionGroup>/g) || [];
    groups.forEach(function (g) {
      var trig = text(/<wpml:actionTriggerType>([^<]*)</, g) || 'reachPoint';
      (g.match(/<wpml:action>[\s\S]*?<\/wpml:action>/g) || []).forEach(function (a) {
        var func = text(/<wpml:actionActuatorFunc>([^<]*)</, a) || '';
        var act = { func: func, trigger: trig };
        if (func === 'gimbalRotate') {
          act.type = 'gimbal';
          act.mode = text(/<wpml:gimbalRotateMode>([^<]*)</, a) || 'absoluteAngle';
          act.yawBase = text(/<wpml:gimbalHeadingYawBase>([^<]*)</, a) || 'north';
          act.pitch = num(/<wpml:gimbalPitchRotateEnable>1<\/wpml:gimbalPitchRotateEnable>\s*<wpml:gimbalPitchRotateAngle>([^<]*)</, a, null);
          act.yaw = num(/<wpml:gimbalYawRotateEnable>1<\/wpml:gimbalYawRotateEnable>\s*<wpml:gimbalYawRotateAngle>([^<]*)</, a, null);
          act.timeS = num(/<wpml:gimbalRotateTimeEnable>1<\/wpml:gimbalRotateTimeEnable>\s*<wpml:gimbalRotateTime>([^<]*)</, a, null);
        } else if (func === 'hover') {
          act.type = 'hover'; act.s = num(/<wpml:hoverTime>([^<]*)</, a, 1);
        } else if (func === 'takePhoto' || func === 'startRecord' || func === 'stopRecord') {
          act.type = func === 'takePhoto' ? 'photo' : 'other';
          act.suffix = text(/<wpml:fileSuffix>([^<]*)</, a) || '';
          act.lens = text(/<wpml:payloadLensIndex>([^<]*)</, a) || '';
        } else if (func === 'zoom') {
          act.type = 'zoom'; act.factor = num(/<wpml:focalLength>([^<]*)</, a, null);
        } else if (func === 'rotateYaw') {
          act.type = 'yaw'; act.hdg = num(/<wpml:aircraftHeading>([^<]*)</, a, null);
        } else {
          act.type = 'other';
        }
        acts.push(act);
      });
    });
    return acts;
  }

  /* waylines.wpml is what the aircraft executes; template.kml carries the
     EGM96 heights the planner wrote. We fly the wayline and take its
     heights from the template when the two line up by index. */
  KMZ.parseWpml = function (wpml, template, name) {
    var m = { name: name, file: name, wps: [], cfg: {} };
    Object.assign(m, KMZ.decodeMissionName(name));
    var cfgSrc = wpml;
    m.cfg = {
      takeOffSecurityHeight: num(/<wpml:takeOffSecurityHeight>([^<]*)</, cfgSrc, null),
      transitionalSpeed: num(/<wpml:globalTransitionalSpeed>([^<]*)</, cfgSrc, null),
      autoFlightSpeed: num(/<wpml:autoFlightSpeed>([^<]*)</, cfgSrc, null),
      finishAction: text(/<wpml:finishAction>([^<]*)</, cfgSrc),
      rthHeight: num(/<wpml:globalRTHHeight>([^<]*)</, cfgSrc, null),
      flyToWaylineMode: text(/<wpml:flyToWaylineMode>([^<]*)</, cfgSrc),
      droneEnum: num(/<wpml:droneEnumValue>([^<]*)</, cfgSrc, null),
      payloadEnum: num(/<wpml:payloadEnumValue>([^<]*)</, cfgSrc, null),
      executeHeightMode: text(/<wpml:executeHeightMode>([^<]*)</, wpml),
      heightMode: template ? text(/<wpml:heightMode>([^<]*)</, template) : null,
      author: template ? text(/<wpml:author>([^<]*)</, template) : null
    };
    var tplHeights = {};
    if (template) {
      (template.match(/<Placemark>[\s\S]*?<\/Placemark>/g) || []).forEach(function (pm) {
        var idx = num(/<wpml:index>([^<]*)</, pm, null);
        if (idx == null) return;
        tplHeights[idx] = { h: num(/<wpml:height>([^<]*)</, pm, null),
          ell: num(/<wpml:ellipsoidHeight>([^<]*)</, pm, null) };
      });
    }
    var globalHdg = text(/<wpml:globalWaypointHeadingParam>[\s\S]*?<wpml:waypointHeadingMode>([^<]*)</, template || '') || 'followWayline';
    (wpml.match(/<Placemark>[\s\S]*?<\/Placemark>/g) || []).forEach(function (pm) {
      var cs = text(/<coordinates>([^<]*)</, pm);
      if (!cs) return;
      var c = cs.trim().split(',').map(Number);
      var idx = num(/<wpml:index>([^<]*)</, pm, m.wps.length);
      var ell = num(/<wpml:executeHeight>([^<]*)</, pm, null);
      var tp = tplHeights[idx];
      var alt = tp && tp.h != null ? tp.h : ell;
      var hp = text(/<wpml:waypointHeadingParam>([\s\S]*?)<\/wpml:waypointHeadingParam>/, pm) || '';
      var hdgMode = text(/<wpml:waypointHeadingMode>([^<]*)</, hp) || globalHdg;
      var hdgEnable = num(/<wpml:waypointHeadingAngleEnable>([^<]*)</, hp, 0);
      var hdgAngle = num(/<wpml:waypointHeadingAngle>([^<]*)</, hp, null);
      var hdg = (hdgMode === 'smoothTransition' || hdgMode === 'fixed' || hdgMode === 'lockCourse') && hdgEnable ? hdgAngle
        : (hdgMode === 'smoothTransition' && hdgAngle != null ? hdgAngle : null);
      m.wps.push({
        index: idx, lon: c[0], lat: c[1], alt: alt, ellipsoid: ell,
        geoidOffset: tp && tp.h != null && ell != null ? tp.h - ell : null,
        speed: num(/<wpml:waypointSpeed>([^<]*)</, pm, m.cfg.autoFlightSpeed || 2),
        hdg: hdg, hdgMode: hdgMode,
        turnMode: text(/<wpml:waypointTurnMode>([^<]*)</, pm),
        gimbalPitch: num(/<wpml:gimbalPitchAngle>([^<]*)</, pm, null),
        actions: readActions(pm)
      });
    });
    m.wps.sort(function (p, q) { return p.index - q.index; });
    m.photos = m.wps.reduce(function (n, w) { return n + w.actions.filter(function (a) { return a.type === 'photo'; }).length; }, 0);
    return m;
  };

  /* one .kmz (wpmz/waylines.wpml + wpmz/template.kml) → a mission */
  KMZ.loadWpmlKmz = async function (u8, name) {
    var files = await KMZ.unzip(u8);
    var wKey = Object.keys(files).filter(function (k) { return /waylines\.wpml$/i.test(k); })[0];
    var tKey = Object.keys(files).filter(function (k) { return /template\.kml$/i.test(k); })[0];
    if (!wKey) return null;
    var td = new TextDecoder();
    return KMZ.parseWpml(td.decode(files[wKey]), tKey ? td.decode(files[tKey]) : null, name);
  };

  /* a mission group: a zip of .kmz files (any folder depth), or one .kmz */
  KMZ.loadMissionGroup = async function (buf, hintName) {
    var u8 = new Uint8Array(buf);
    if (!KMZ.isZip(u8)) throw new Error('A mission group is a .zip of DJI .kmz files, or one .kmz.');
    var files = await KMZ.unzip(u8);
    var names = Object.keys(files);
    var group = { name: baseName(hintName || 'mission group'), missions: [], skipped: [] };
    if (names.some(function (k) { return /waylines\.wpml$/i.test(k); })) {
      var one = await KMZ.loadWpmlKmz(u8, baseName(hintName || 'mission'));
      if (one) group.missions.push(one);
      return group;
    }
    for (var i = 0; i < names.length; i++) {
      var k = names[i];
      if (!/\.kmz$/i.test(k)) continue;
      try {
        var mis = await KMZ.loadWpmlKmz(files[k], baseName(k));
        if (mis) { mis.folder = k.replace(/[^\\\/]*$/, ''); group.missions.push(mis); }
        else group.skipped.push(k);
      } catch (e) { group.skipped.push(k + ' (' + e.message + ')'); }
    }
    return finishGroup(group);
  };
  function finishGroup(group) {
    var ORDER = { A1: 0, B1: 1, A2: 2, B2: 3, GIMBAL: -1 };
    group.missions.sort(function (p, q) {
      var s = (p.a || '').localeCompare(q.a || '');
      return s !== 0 ? s : (ORDER[p.code] != null ? ORDER[p.code] : 9) - (ORDER[q.code] != null ? ORDER[q.code] : 9);
    });
    return group;
  }
  function dirOf(path) { return path.replace(/[^\\\/]*$/, ''); }

  /* a mission group from a FOLDER pick (D-A855): files = [{path, buf}] — every
     DJI .kmz at any depth, any .zip of them, and loose wpmz folders (a
     waylines.wpml beside its template.kml) */
  KMZ.loadMissionFiles = async function (files, hintName) {
    var group = { name: baseName(hintName || 'mission folder'), missions: [], skipped: [], source: 'folder' };
    var td = new TextDecoder(), loose = {};
    for (var i = 0; i < files.length; i++) {
      var p = files[i].path || files[i].name || ('file ' + i), u8 = new Uint8Array(files[i].buf);
      try {
        if (/\.kmz$/i.test(p)) {
          var mis = await KMZ.loadWpmlKmz(u8, baseName(p));
          if (mis) { mis.folder = dirOf(p); group.missions.push(mis); } else group.skipped.push(p);
        } else if (/\.zip$/i.test(p)) {
          var sub = await KMZ.loadMissionGroup(files[i].buf, p);
          sub.missions.forEach(function (m) { m.folder = dirOf(p) + (m.folder || ''); group.missions.push(m); });
          group.skipped = group.skipped.concat(sub.skipped);
        } else if (/waylines\.wpml$/i.test(p) || /template\.kml$/i.test(p)) {
          var d = dirOf(p);
          loose[d] = loose[d] || {};
          loose[d][/wpml$/i.test(p) ? 'w' : 't'] = td.decode(u8);
        }
      } catch (e) { group.skipped.push(p + ' (' + e.message + ')'); }
    }
    Object.keys(loose).forEach(function (d) {
      if (!loose[d].w) return;
      var owner = d.replace(/wpmz[\\\/]?$/i, '').replace(/[\\\/]$/, '');
      var m = KMZ.parseWpml(loose[d].w, loose[d].t || null, baseName(owner || d || 'mission'));
      m.folder = d; group.missions.push(m);
    });
    return finishGroup(group);
  };

  /* a File / ArrayBuffer in (kmz or kml), a circuit out */
  KMZ.loadCircuit = async function (buf, hintName) {
    var u8 = new Uint8Array(buf);
    var kml;
    if (KMZ.isZip(u8)) {
      var files = await KMZ.unzip(u8);
      var keys = Object.keys(files).filter(function (k) { return /\.kml$/i.test(k); })
        .sort(function (a, b) { return (a === 'doc.kml' ? -1 : 0) - (b === 'doc.kml' ? -1 : 0); });
      if (!keys.length) throw new Error('No .kml inside the archive.');
      /* several KMLs: the parts of one circuit (same towers, a slice of the
         conductors each — the Google Earth preview export) are merged */
      var merged = null, td = new TextDecoder();
      for (var i = 0; i < keys.length; i++) {
        var c = KMZ.parseCircuit(td.decode(files[keys[i]]));
        if (c.towers.length < 2) continue;
        c.name = c.name.replace(/\s*\(part\s+\d+\s+of\s+\d+\)\s*$/i, '').trim();
        if (!merged) { merged = c; continue; }
        if (merged.name !== c.name || merged.towers.length !== c.towers.length) continue;
        c.spans.forEach(function (s) { if (!merged.spans.some(function (q) { return q.a === s.a && q.b === s.b; })) merged.spans.push(s); });
        merged.parts = (merged.parts || 1) + 1;
      }
      if (!merged) throw new Error('No circuit (a Towers folder) inside the archive.');
      merged.file = hintName || '';
      return merged;
    }
    kml = new TextDecoder().decode(u8);
    var circuit = KMZ.parseCircuit(kml);
    circuit.file = hintName || '';
    return circuit;
  };

  root.KMZ = KMZ;
})(typeof window !== 'undefined' ? window : globalThis);

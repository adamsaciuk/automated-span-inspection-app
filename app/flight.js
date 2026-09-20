/* flight.js — the drone layer: a selection of missions flown as one
   timeline, pure of the DOM. Same motion character as the orbits and
   shot-sheet engines: real metres per second, smoothstep-eased legs,
   rate-limited yaw and gimbal so the airframe swings like a machine.

   The profile Adam specified (D-A814):
     spin up on the launch spot → climb straight up to OVER metres above
     the first waypoint's height → fly directly above the first waypoint
     → descend onto it → execute the mission → the next mission (a short
     hop, or climb-cruise-descend when it starts far away) → … → climb
     OVER above the last waypoint → fly directly above the launch spot →
     descend → touch down → spin down.

   A mission is executed the way the aircraft executes a DJI wayline:
   fly to the waypoint at its speed while the nose turns to the
   waypoint's heading (or follows the wayline when none is set), then run
   the waypoint's actions in order — gimbalRotate settles the gimbal,
   hover holds, takePhoto fires — then move on.

   FLY.build(input) derives the legs; FLY.poseAt(t) is the raw pose;
   FLY.tick(dt) advances play time and smooths the rig. */
(function (root) {
  'use strict';

  var FLY = {};
  FLY.CAMS = {
    wide: { label: 'WIDE', vfov: 45.7 },
    zoom: { label: 'ZOOM', vfov: 16.5 },
    ir: { label: 'IR', vfov: 40.0 }
  };

  var plan = null, t = 0;
  var rig = { hdg: 0, gim: -30, gyaw: 0 };
  FLY.playing = false;
  FLY.rate = 4;

  function bearing(a, b) { return Math.atan2(b.x - a.x, b.y - a.y) * 180 / Math.PI; }
  function d3(a, b) { return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z); }
  function smoothstep(f) { return f * f * (3 - 2 * f); }

  /* input: { launch {x,y,z}, missions [{id, code, name, wps [{x,y,z,
       speed?, hdg?, actions?}]}], cfg {vTransit, vClimb, vMission, holdS,
       overM, clearM, gimbalCheck} }
     A waypoint without actions gets the default: settle the gimbal on the
     mission's `look` and take one photo. */
  FLY.build = function (input) {
    var cfg = input.cfg || {};
    var V_T = cfg.vTransit || 8, V_C = cfg.vClimb || 3, V_M = cfg.vMission || 2;
    var HOLD = cfg.holdS != null ? cfg.holdS : 1.0;
    var OVER = cfg.overM != null ? cfg.overM : 30;
    var GIM_S = 0.9;        /* a gimbal move settles in under a second */
    var legs = [], chapters = [], shots = 0;

    function hold(pt, dur, o) {
      legs.push(Object.assign({ a: pt, b: pt, durS: dur, mode: 'hold', cam: 'wide' }, o || {}));
    }
    function move(a, b, speed, o) {
      legs.push(Object.assign({ a: a, b: b, durS: Math.max(0.15, d3(a, b) / speed),
        mode: 'transit', cam: 'wide' }, o || {}));
    }
    function chapter(name, kind, m) { chapters.push({ name: name, kind: kind, leg: legs.length, mission: m ? m.id : null }); }

    var L = input.launch;
    var ms = (input.missions || []).filter(function (m) { return m.wps && m.wps.length; });
    if (!L) return (plan = FLY.plan = { ok: false, summary: 'Pick a launch spot first.', legs: [], chapters: [], totalS: 0 });
    if (!ms.length) return (plan = FLY.plan = { ok: false, summary: 'Select at least one mission.', legs: [], chapters: [], totalS: 0 });

    var ground = { x: L.x, y: L.y, z: L.z };
    chapter('LAUNCH', 'launch');
    hold(ground, 2.5, { mode: 'ground', spin: 'up', gim: -30, manual: true });

    var w0 = ms[0].wps[0];
    var tower = input.startTower || { x: w0.x, y: w0.y, top: w0.z };
    /* the safe height for the whole span: over the taller tower and every waypoint */
    var topAll = Math.max(tower.top || 0, input.safeTop || 0);
    ms.forEach(function (m) { m.wps.forEach(function (w) { if (w.z > topAll) topAll = w.z; }); });
    var safeZ = (cfg.oneAtATime ? topAll : Math.max(tower.top || w0.z, w0.z)) + OVER;
    var firstHdg = w0.hdg != null ? w0.hdg : (ms[0].wps.length > 1 ? bearing(ms[0].wps[0], ms[0].wps[1]) : bearing(L, w0));
    var upTop = { x: L.x, y: L.y, z: safeZ };
    if (cfg.oneAtATime) {
      /* the operator's cadence: straight up to safe space, across to the
         chosen mission's first waypoint, down onto it */
      chapter('PILOT SELECTS ' + ms[0].code, 'select', ms[0]);
      hold(ground, 1.0, { mode: 'select', gim: -30, manual: true, mission: ms[0].id });
      chapter('UP TO SAFE HEIGHT', 'manual');
      move(ground, upTop, V_C, { mode: 'lift', gim: -30, manual: true });
      chapter('FLY TO WAYLINE', 'towayline', ms[0]);
      move(upTop, { x: w0.x, y: w0.y, z: safeZ }, V_T, { mode: 'transit', gim: -30, mission: ms[0].id });
      move({ x: w0.x, y: w0.y, z: safeZ }, w0, V_C, { mode: 'descend', gim: -30, hdgFixed: firstHdg, mission: ms[0].id });
    } else {
      /* the start profile: the pilot flies manually and safely to the top of
         the starting tower, pauses, selects the mission; the aircraft then
         flies to the wayline the way DJI 'safely' does */
      move(ground, upTop, V_C, { mode: 'lift', gim: -30, manual: true });
      var aboveTower = { x: tower.x, y: tower.y, z: safeZ };
      chapter('MANUAL TO TOWER', 'manual');
      move(upTop, aboveTower, V_T, { mode: 'transit', gim: -30, manual: true });
      if (cfg.gimbalCheck) {
        chapter('GIMBAL CHECK', 'check');
        var seqs = [[0, 0], [-90, 0], [0, 0], [-30, -90], [-30, 90], [-30, 0]];
        seqs.forEach(function (s) { hold(aboveTower, 2.0, { mode: 'check', gim: s[0], gyawRel: s[1], hdgFixed: bearing(L, w0), manual: true }); });
      }
      chapter('PILOT SELECTS ' + ms[0].code, 'select', ms[0]);
      hold(aboveTower, 3.0, { mode: 'select', gim: -60, hdgFixed: bearing(tower, w0), manual: true, mission: ms[0].id });
      var above0 = { x: w0.x, y: w0.y, z: Math.max(safeZ, w0.z) };
      chapter('FLY TO WAYLINE', 'towayline', ms[0]);
      move(aboveTower, above0, V_T, { mode: 'transit', gim: -30, mission: ms[0].id });
      move(above0, w0, V_C, { mode: 'descend', gim: -30, hdgFixed: firstHdg, mission: ms[0].id });
    }

    var pos = w0;
    ms.forEach(function (m, mi) {
      var look = m.look || { pitch: -70, yaw: null };
      if (mi > 0) {
        var n0 = m.wps[0];
        var nHdg = n0.hdg != null ? n0.hdg : (m.wps.length > 1 ? bearing(m.wps[0], m.wps[1]) : null);
        chapter('PILOT SELECTS ' + m.code, 'select', m);
        hold(pos, cfg.oneAtATime ? 1.0 : 3.0, { mode: 'select', gim: -60, hdgFixed: bearing(pos, n0), mission: m.id });
        chapter('FLY TO WAYLINE', 'towayline', m);
        if (cfg.oneAtATime) {
          /* no matter where it is: straight up to safe space, across, down */
          move(pos, { x: pos.x, y: pos.y, z: safeZ }, V_C, { mode: 'lift', gim: -30, mission: m.id });
          move({ x: pos.x, y: pos.y, z: safeZ }, { x: n0.x, y: n0.y, z: safeZ }, V_T, { mode: 'transit', gim: -30, mission: m.id });
          move({ x: n0.x, y: n0.y, z: safeZ }, n0, V_C, { mode: 'descend', gim: -30, hdgFixed: nHdg, mission: m.id });
        } else {
          /* finishAction noAction: the aircraft hovers where the last
             mission ended; the pilot selects the next one from there and the
             fly-to-wayline runs again — climb if the first waypoint is
             higher, cruise level, descend onto it */
          var hz = Math.max(pos.z, n0.z);
          if (hz - pos.z > 0.3) move(pos, { x: pos.x, y: pos.y, z: hz }, V_C, { mode: 'lift', gim: -30, mission: m.id });
          move({ x: pos.x, y: pos.y, z: hz }, { x: n0.x, y: n0.y, z: hz }, V_T, { mode: 'transit', gim: -30, mission: m.id });
          if (hz - n0.z > 0.3) move({ x: n0.x, y: n0.y, z: hz }, n0, V_C, { mode: 'descend', gim: -30, hdgFixed: nHdg, mission: m.id });
        }
        pos = n0;
      }
      chapter(m.code + (m.name ? ' · ' + m.name : ''), 'mission', m);
      var gim = look.pitch != null ? look.pitch : -70;
      var gyaw = null;            /* absolute gimbal yaw (north base) */
      var gyawRel = look.yaw;     /* relative to the nose, when no absolute */
      var hdg = firstHdg;
      for (var k = 0; k < m.wps.length; k++) {
        var wp = m.wps[k];
        var speed = wp.speed || V_M;
        if (k > 0) {
          hdg = wp.hdg != null ? wp.hdg : bearing(m.wps[k - 1], wp);
          move(m.wps[k - 1], wp, speed, { mode: 'mission', gim: gim, gyaw: gyaw, gyawRel: gyawRel,
            hdgFixed: hdg, mission: m.id, wp: k });
        } else if (wp.hdg != null) {
          hdg = wp.hdg;
        }
        /* a waypoint with no actions in a wayline that HAS actions is a
           navigation waypoint: the aircraft passes through, no photo. The
           default gimbal + photo applies only to planned paths with no
           actions at all. */
        var hasAny = m.wps.some(function (q) { return q.actions && q.actions.length; });
        var acts = wp.actions && wp.actions.length ? wp.actions
          : (hasAny ? [] : [{ type: 'gimbal', pitch: gim, yaw: null }, { type: 'photo' }]);
        if (!acts.length && legs.length) legs[legs.length - 1].nav = true;
        var fired = false;
        acts.forEach(function (a) {
          if (a.type === 'gimbal') {
            if (a.pitch != null) gim = a.pitch;
            if (a.yaw != null) { gyaw = a.yaw; gyawRel = null; }
            hold(wp, a.timeS || GIM_S, { mode: 'mission', gim: gim, gyaw: gyaw, gyawRel: gyawRel, hdgFixed: hdg, mission: m.id, wp: k, act: 'gimbal' });
          } else if (a.type === 'hover') {
            hold(wp, a.s || 1, { mode: 'mission', gim: gim, gyaw: gyaw, gyawRel: gyawRel, hdgFixed: hdg, mission: m.id, wp: k, act: 'hover' });
          } else if (a.type === 'photo') {
            shots++; fired = true;
            hold(wp, HOLD, { mode: 'mission', gim: gim, gyaw: gyaw, gyawRel: gyawRel, hdgFixed: hdg, mission: m.id, wp: k, act: 'photo',
              shot: { mission: m.id, code: m.code, index: k + 1, of: m.wps.length, n: shots, suffix: a.suffix || '' } });
          } else if (a.type === 'yaw' && a.hdg != null) {
            hdg = a.hdg;
            hold(wp, 1.0, { mode: 'mission', gim: gim, gyaw: gyaw, gyawRel: gyawRel, hdgFixed: hdg, mission: m.id, wp: k, act: 'yaw' });
          } else {
            hold(wp, 0.5, { mode: 'mission', gim: gim, gyaw: gyaw, gyawRel: gyawRel, hdgFixed: hdg, mission: m.id, wp: k, act: a.type || 'other' });
          }
        });
        /* navigation waypoints get no hold: the aircraft rounds them and carries on */
        pos = wp;
      }
    });

    /* finishAction noAction: hover at the last waypoint, then the pilot
       flies home manually — the mirror of the way out. In one-at-a-time
       mode the plan ENDS on the hover until the operator chooses home. */
    chapter('MISSION COMPLETE · HOVER', 'complete');
    hold(pos, cfg.noHome ? 1.0 : 3.0, { mode: 'complete', gim: -30, manual: true });
    if (!cfg.noHome) {
      chapter('MANUAL HOME', 'return');
      var overZ2 = cfg.oneAtATime ? safeZ : Math.max(pos.z, tower.top || 0) + OVER;
      move(pos, { x: pos.x, y: pos.y, z: overZ2 }, V_C, { mode: 'lift', gim: -30, manual: true });
      move({ x: pos.x, y: pos.y, z: overZ2 }, { x: L.x, y: L.y, z: overZ2 }, V_T, { mode: 'transit', gim: -30, manual: true });
      move({ x: L.x, y: L.y, z: overZ2 }, ground, V_C, { mode: 'descend', gim: -30, manual: true });
      chapter('LAND', 'land');
      hold(ground, 2.5, { mode: 'ground', spin: 'down', gim: -30, manual: true });
    }

    var total = 0, dist = 0;
    legs.forEach(function (l) { l.t0 = total; total += l.durS; dist += d3(l.a, l.b); });
    chapters.forEach(function (c) { c.t0 = legs[Math.min(c.leg, legs.length - 1)].t0; });
    plan = { ok: true, legs: legs, chapters: chapters, totalS: total, distM: dist, shots: shots,
      summary: ms.map(function (m) { return m.code; }).join(' → ') + ' · ' + Math.round(dist) +
        ' M · ' + (total / 60).toFixed(1) + ' MIN REAL · ' + shots + ' PHOTOS' };
    FLY.plan = plan;
    return plan;
  };

  FLY.poseAt = function (tS) {
    if (!plan || !plan.legs.length) return null;
    var rem = tS, leg = null, f = 0, li = 0;
    for (var i = 0; i < plan.legs.length; i++) {
      if (rem <= plan.legs[i].durS) { leg = plan.legs[i]; f = rem / leg.durS; li = i; break; }
      rem -= plan.legs[i].durS;
    }
    var done = false;
    if (!leg) { leg = plan.legs[plan.legs.length - 1]; f = 1; li = plan.legs.length - 1; done = true; }
    var e = smoothstep(Math.max(0, Math.min(1, f)));
    var x = leg.a.x + (leg.b.x - leg.a.x) * e;
    var y = leg.a.y + (leg.b.y - leg.a.y) * e;
    var z = leg.a.z + (leg.b.z - leg.a.z) * e;
    var hdgT = null;
    if (leg.hdgFixed != null) hdgT = leg.hdgFixed;
    else if (leg.mode === 'transit') {
      var dx = leg.b.x - leg.a.x, dy = leg.b.y - leg.a.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.3) hdgT = Math.atan2(dx, dy) * 180 / Math.PI;
    }
    var rotor = 1;
    if (leg.spin === 'up') rotor = f;
    else if (leg.spin === 'down') rotor = 1 - f;
    var speed = leg.durS > 0 ? d3(leg.a, leg.b) / leg.durS * 6 * e * (1 - e) : 0;
    return { x: x, y: y, z: z, hdgT: hdgT, gimT: leg.gim != null ? leg.gim : -30,
      gyawAbs: leg.gyaw != null ? leg.gyaw : null, gyawRel: leg.gyawRel != null ? leg.gyawRel : 0,
      rotor: rotor, mode: leg.mode, act: leg.act || null, cam: leg.cam || 'wide', manual: !!leg.manual,
      shot: leg.shot || null, shotFired: !!(leg.shot && f >= 0.5), mission: leg.mission || null,
      wp: leg.wp != null ? leg.wp : null, nav: !!leg.nav, speed: speed, legIndex: li, done: done, f: f };
  };

  /* photos fired so far: every shot hold whose midpoint has passed */
  FLY.shotsAt = function (tS) {
    if (!plan) return 0;
    var n = 0;
    for (var i = 0; i < plan.legs.length; i++) {
      var l = plan.legs[i];
      if (l.shot && tS >= l.t0 + l.durS * 0.5) n++;
    }
    return n;
  };

  FLY.seek = function (tS) {
    t = Math.max(0, Math.min(plan ? plan.totalS : 0, tS));
    var p = FLY.poseAt(t);
    if (p) {
      if (p.hdgT != null) rig.hdg = p.hdgT;
      rig.gim = p.gimT;
      rig.gyaw = p.gyawAbs != null ? p.gyawAbs - rig.hdg : p.gyawRel;
    }
    return p;
  };
  FLY.reset = function () {
    t = 0;
    rig.gim = -30; rig.gyaw = 0;
    if (plan && plan.legs.length) {
      for (var i = 0; i < plan.legs.length; i++) {
        var l = plan.legs[i];
        if (l.mode === 'transit') { rig.hdg = bearing(l.a, l.b); break; }
      }
    }
    return FLY.poseAt(0);
  };
  function wrap(d) { return ((((d) % 360) + 540) % 360) - 180; }
  FLY.tick = function (dtS) {
    t += dtS;
    if (plan && t > plan.totalS) t = plan.totalS;
    var p = FLY.poseAt(t);
    if (!p) return null;
    var k = Math.min(1, dtS * 3.2);
    if (p.hdgT != null) rig.hdg += wrap(p.hdgT - rig.hdg) * k;
    rig.hdg = ((rig.hdg % 360) + 360) % 360;
    rig.gim += (p.gimT - rig.gim) * Math.min(1, dtS * 2.6);
    /* the gimbal yaw target: absolute (north base) minus the nose, or relative */
    var gyT = p.gyawAbs != null ? wrap(p.gyawAbs - rig.hdg) : p.gyawRel;
    rig.gyaw += wrap(gyT - rig.gyaw) * Math.min(1, dtS * 2.6);
    p.hdgDeg = rig.hdg; p.gimbalDeg = rig.gim; p.gimbalYawDeg = rig.gyaw;
    /* the clock is clamped at the end, so 'done' must be said here, not
       inferred from running past the last leg */
    if (plan && t >= plan.totalS - 1e-6) p.done = true;
    p.fovV = FLY.CAMS[p.cam] ? FLY.CAMS[p.cam].vfov : 45.7;
    p.camLabel = FLY.CAMS[p.cam] ? FLY.CAMS[p.cam].label : '';
    p.t = t;
    return p;
  };
  FLY.timeS = function () { return t; };
  /* take a plan built earlier back as the live one (datasets per span) */
  FLY.load = function (p) { plan = p; FLY.plan = p; };
  FLY._rig = rig;

  root.FLY = FLY;
})(typeof window !== 'undefined' ? window : globalThis);

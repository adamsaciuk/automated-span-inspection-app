/* camera.js — the payload as optics: sensor, lens, aperture, focus
   distance → field of view and the focus bracket (depth of field).

   The bracket is the slab between two planes perpendicular to the optical
   axis: anything with an axis depth between NEAR and FAR is sharp to the
   chosen circle of confusion. Thin-lens depth of field:
     H    = f² / (N · c) + f            hyperfocal
     near = s (H − f) / (H + s − 2f)
     far  = s (H − f) / (H − s)         (∞ when s ≥ H)
   f focal length, N f-number, c circle of confusion, s focus distance, all
   in millimetres. c is given in PIXELS of the sensor (1 px = the strict
   inspection standard, 2 px = the conventional one). */
(function (root) {
  'use strict';
  var CAM = {};

  /* Phase One iXM-GS120 + 80 mm, per Phase One's assessment for this job
     (Nathan Michael, 2026-09): 3.45 µm pixels, acceptable blur 1 pixel,
     subject 20 m. Their table: f/16 focused at 20 m → 17.08–24.14 m, and
     diffraction 6.2 px at f/16 — the trade this model makes visible. */
  CAM.DEFAULTS = {
    name: 'Phase One iXM-GS120 · 80 mm',
    sensorW: 44.05, sensorH: 32.9,         /* mm (12768 × 9536 px at 3.45 µm) */
    pixW: 12768, pixH: 9536,
    focal: 80,                             /* mm */
    fnum: 18,
    focusM: 19.5,                          /* m */
    cocPx: 1,
    landscape: true                        /* long axis along the line */
  };
  /* the two Phase One bodies this job flies (D-A858). Phase One's published
     sensors: iXM-GS120 12768 × 9536 at 3.45 µm (44.05 × 32.9 mm, global
     shutter); iXM-100 11664 × 8750 at 3.76 µm (43.9 × 32.9 mm). Same RSM
     lenses, near-identical field of view; the pixel pitch is what differs,
     so the 1 px sharpness standard, the diffraction in pixels and the
     mm-per-pixel all move. */
  CAM.BODIES = {
    gs120:  { name: 'Phase One iXM-GS120', sensorW: 44.05, sensorH: 32.9, pixW: 12768, pixH: 9536, pitchUm: 3.45 },
    ixm100: { name: 'Phase One iXM-100',   sensorW: 43.9,  sensorH: 32.9, pixW: 11664, pixH: 8750, pitchUm: 3.76 }
  };
  /* which body a mission file name says it was planned for, else null */
  CAM.bodyFromName = function (name) {
    if (/ixm.?100/i.test(name)) return 'ixm100';
    if (/gs.?120|ixm.?120/i.test(name)) return 'gs120';
    return null;
  };
  CAM.LAMBDA_UM = 0.55;                    /* green light, for the Airy disk */

  CAM.model = function (s) {
    s = Object.assign({}, CAM.DEFAULTS, s || {});
    var w = s.landscape ? s.sensorW : s.sensorH, h = s.landscape ? s.sensorH : s.sensorW;
    var pw = s.landscape ? s.pixW : s.pixH;
    var pitchMm = s.sensorW / s.pixW;
    var c = s.cocPx * pitchMm;
    var f = s.focal, N = s.fnum, S = s.focusM * 1000;
    var H = f * f / (N * c) + f;
    var near = S * (H - f) / (H + S - 2 * f);
    var far = S < H ? S * (H - f) / (H - S) : Infinity;
    /* diffraction: Airy disk diameter 2.44 λ N, in pixels */
    var airyUm = 2.44 * CAM.LAMBDA_UM * N;
    return {
      airyUm: airyUm,
      diffractionPx: airyUm / (pitchMm * 1000),
      settings: s,
      hfov: 2 * Math.atan(w / 2 / f) * 180 / Math.PI,
      vfov: 2 * Math.atan(h / 2 / f) * 180 / Math.PI,
      aspect: w / h,
      pixelPitchMm: pitchMm,
      hyperfocalM: H / 1000,
      nearM: near / 1000,
      farM: far === Infinity ? Infinity : far / 1000,
      focusM: s.focusM,
      /* ground-sample distance at a range, mm per pixel */
      gsdAt: function (rangeM) { return rangeM * 1000 * pitchMm / f; },
      /* footprint width along the line at a range, metres */
      widthAt: function (rangeM) { return 2 * rangeM * Math.tan(this.hfov / 2 * Math.PI / 180); },
      label: f + ' MM · f/' + N + ' · FOCUS ' + s.focusM + ' M'
    };
  };

  root.CAMERA = CAM;
})(typeof window !== 'undefined' ? window : globalThis);

/* search.js — the one search box of the field tracker (S-0042 step 4).
   Pure: an index built from the light circuit records (no missions), and
   a find that ranks hits so a tower name typed from the controller lands
   on its span first. Names are matched the way assign.js matches them:
   upper case, punctuation dropped, so "012/053", "012-053" and "012053"
   are the same tower. Runs identically under Node for the harness. */
(function (root) {
  'use strict';
  var SEARCH = {};
  SEARCH.norm = function (s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); };

  /* the index: every tower of every circuit, and the circuit names */
  SEARCH.index = function (circuits) {
    var towers = [], byName = {}, names = [];
    circuits.forEach(function (c) {
      names.push({ c: c, n: SEARCH.norm(c.name), raw: c.name });
      c.towers.forEach(function (t, i) {
        var n = SEARCH.norm(t.name), e = { c: c, i: i, n: n, raw: t.name };
        towers.push(e);
        (byName[n] = byName[n] || []).push(e);
      });
    });
    return { towers: towers, byName: byName, names: names, circuits: circuits };
  };

  /* hits: [{ kind: 'span', c, span, why, rank }, { kind: 'circuit', c, why, rank }]
     rank 0 exact tower or a tower pair, 1 span number, 2 tower name starts
     with it, 3 tower name contains it, 4 circuit name contains it */
  SEARCH.find = function (idx, q, limit, prefer) {
    var out = [], seen = {}, raw = String(q || '').trim(), nq = SEARCH.norm(raw);
    limit = limit || 50; prefer = prefer || {};
    if (!nq || !idx) return out;
    function addSpan(c, i, why, rank) {
      if (i < 0 || i >= c.towers.length - 1) return;
      var k = c.id + '|' + i; if (seen[k]) return; seen[k] = 1;
      out.push({ kind: 'span', c: c, span: i, why: why, rank: rank });
    }
    /* a tower sits on two spans: the one starting at it first, unless only
       the one ending at it carries missions */
    function spansOfTower(e, rank) {
      var c = e.c, i = e.i, why = 'tower ' + e.raw;
      var a = i < c.towers.length - 1 ? i : -1, b = i > 0 ? i - 1 : -1;
      if (a >= 0 && b >= 0 && !c.bySpan[a] && c.bySpan[b]) { addSpan(c, b, why, rank); addSpan(c, a, why, rank); return; }
      if (a >= 0) addSpan(c, a, why, rank);
      if (b >= 0) addSpan(c, b, why, rank);
    }
    /* a tower pair anywhere in the text (a mission file name from the
       controller carries both towers): the span between them */
    var toks = raw.split(/[\s\-_,>→]+/).map(SEARCH.norm).filter(Boolean);
    if (toks.length > 1) {
      for (var t = 0; t < toks.length; t++) {
        var A = idx.byName[toks[t]]; if (!A) continue;
        for (var u = t + 1; u < toks.length; u++) {
          var B = idx.byName[toks[u]]; if (!B) continue;
          A.forEach(function (ea) { B.forEach(function (eb) {
            if (ea.c !== eb.c) return;
            if (eb.i === ea.i + 1) addSpan(ea.c, ea.i, 'towers ' + ea.raw + ' → ' + eb.raw, 0);
            else if (ea.i === eb.i + 1) addSpan(ea.c, eb.i, 'towers ' + eb.raw + ' → ' + ea.raw, 0);
          }); });
        }
      }
    }
    (idx.byName[nq] || []).forEach(function (e) { spansOfTower(e, 0); });
    if (/^\d+$/.test(raw)) {
      var n = parseInt(raw, 10);
      idx.circuits.forEach(function (c) { if (n >= 1 && n <= c.towers.length - 1) addSpan(c, n - 1, 'span ' + n, 1); });
    }
    var T = idx.towers, i;
    for (i = 0; i < T.length && out.length < limit * 2; i++) if (T[i].n !== nq && T[i].n.indexOf(nq) === 0) spansOfTower(T[i], 2);
    if (nq.length >= 3) for (i = 0; i < T.length && out.length < limit * 2; i++) if (T[i].n.indexOf(nq) > 0) spansOfTower(T[i], 3);
    idx.names.forEach(function (e) { if (e.n.indexOf(nq) >= 0) out.push({ kind: 'circuit', c: e.c, why: 'circuit', rank: e.n === nq ? 0 : 4 }); });
    /* same rank: the circuits the pilot has ticked (prefer) come first;
       the same tower name can exist on several circuits */
    out.forEach(function (h, k) { h.pref = prefer[h.c.id] ? 0 : 1; h.ord = k; });
    out.sort(function (p, q2) { return (p.rank - q2.rank) || (p.pref - q2.pref) || (p.ord - q2.ord); });
    return out.slice(0, limit);
  };

  root.SEARCH = SEARCH;
})(typeof window !== 'undefined' ? window : globalThis);

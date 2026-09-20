/* store.js — the browser keeps what was loaded, so a refresh lands you
   back where you were: the circuit and mission group bytes in IndexedDB
   (a customer's circuit can run to megabytes, beyond localStorage), the
   working span, its ticked missions and its launch spot in prefs. */
(function (root) {
  'use strict';
  var STORE = {};
  var DB = 'asi', VER = 1, OS = 'files';

  function open() {
    return new Promise(function (res, rej) {
      if (!root.indexedDB) return rej(new Error('no IndexedDB'));
      var r = indexedDB.open(DB, VER);
      r.onupgradeneeded = function () { r.result.createObjectStore(OS); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  STORE.put = async function (key, name, buf) {
    try {
      var db = await open();
      await new Promise(function (res, rej) {
        var tx = db.transaction(OS, 'readwrite');
        tx.objectStore(OS).put({ name: name, buf: buf, at: Date.now() }, key);
        tx.oncomplete = res; tx.onerror = function () { rej(tx.error); };
      });
      db.close();
    } catch (e) { /* storage is a convenience, never a failure */ }
  };
  STORE.get = async function (key) {
    try {
      var db = await open();
      var v = await new Promise(function (res, rej) {
        var r = db.transaction(OS, 'readonly').objectStore(OS).get(key);
        r.onsuccess = function () { res(r.result || null); };
        r.onerror = function () { rej(r.error); };
      });
      db.close();
      return v;
    } catch (e) { return null; }
  };
  STORE.del = async function (key) {
    try {
      var db = await open();
      await new Promise(function (res, rej) {
        var tx = db.transaction(OS, 'readwrite');
        tx.objectStore(OS).delete(key);
        tx.oncomplete = res; tx.onerror = function () { rej(tx.error); };
      });
      db.close();
    } catch (e) {}
  };
  /* every stored key with a prefix */
  STORE.keys = async function (prefix) {
    try {
      var db = await open();
      var keys = await new Promise(function (res, rej) {
        var r = db.transaction(OS, 'readonly').objectStore(OS).getAllKeys();
        r.onsuccess = function () { res((r.result || []).map(String).filter(function (k) { return k.indexOf(prefix) === 0; })); };
        r.onerror = function () { rej(r.error); };
      });
      db.close();
      return keys;
    } catch (e) { return []; }
  };
  /* remove every key with a prefix (CLEAR DATA drops the span datasets) */
  STORE.clearPrefix = async function (prefix) {
    try {
      var db = await open();
      await new Promise(function (res, rej) {
        var tx = db.transaction(OS, 'readwrite'), st = tx.objectStore(OS);
        var r = st.openCursor();
        r.onsuccess = function () { var c = r.result; if (!c) return; if (String(c.key).indexOf(prefix) === 0) c.delete(); c.continue(); };
        tx.oncomplete = res; tx.onerror = function () { rej(tx.error); };
      });
      db.close();
    } catch (e) {}
  };
  /* resolves once the database is actually deleted (FULL RESET reloads right after) */
  STORE.clear = async function () {
    try { var db = await open(); db.close(); } catch (e) {}
    return new Promise(function (res) {
      if (!root.indexedDB) return res();
      var r = indexedDB.deleteDatabase(DB);
      r.onsuccess = r.onerror = r.onblocked = function () { res(); };
    });
  };
  root.STORE = STORE;
})(window);

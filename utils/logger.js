/* ============================================================================
 * utils/logger.js — Auto Prompt v14
 * ----------------------------------------------------------------------------
 * Persisted, levelled, timestamped logging shared by the service worker and the
 * side panel. Writes are serialised through a promise chain so two contexts
 * logging at the same moment cannot clobber each other's entries.
 *
 * Exposes: globalThis.APLog
 * ==========================================================================*/

var APLog = (function () {
  'use strict';

  const CFG = (typeof AP_CONFIG !== 'undefined') ? AP_CONFIG : (globalThis.AP_CONFIG || {});
  const KEY = (CFG.storageKeys && CFG.storageKeys.logs) || 'logs';
  const MAX = (CFG.queue && CFG.queue.maxLogItems) || 800;

  const LEVELS = { debug: 0, info: 1, success: 1, warn: 2, error: 3 };

  let chain = Promise.resolve();
  let debugEnabled = false;

  function setDebug(on) { debugEnabled = !!on; }
  function isDebug() { return debugEnabled; }

  function stamp(d) {
    const p = function (n, w) { return String(n).padStart(w || 2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /**
   * Append one log entry.
   * `level` is one of debug | info | success | warn | error.
   * Debug entries are dropped entirely unless debug mode is on, so the log
   * stays readable during normal runs.
   */
  function add(level, msg, meta) {
    level = LEVELS[level] === undefined ? 'info' : level;
    if (level === 'debug' && !debugEnabled) return Promise.resolve();

    const now = new Date();
    const entry = {
      t: now.getTime(),
      time: stamp(now),
      level: level,
      msg: String(msg === undefined || msg === null ? '' : msg),
      meta: meta === undefined ? null : safeMeta(meta)
    };

    try {
      const tag = '[AutoPrompt][' + level.toUpperCase() + ']';
      if (level === 'error') console.error(tag, entry.msg, meta === undefined ? '' : meta);
      else if (level === 'warn') console.warn(tag, entry.msg, meta === undefined ? '' : meta);
      else console.log(tag, entry.msg, meta === undefined ? '' : meta);
    } catch (e) { /* console unavailable */ }

    // Live-broadcast so an open side panel can render immediately.
    try { chrome.runtime.sendMessage({ action: 'LOG', entry: entry }, function () { void chrome.runtime.lastError; }); } catch (e) {}

    chain = chain.then(function () {
      return new Promise(function (resolve) {
        chrome.storage.local.get([KEY], function (data) {
          const list = (data && data[KEY]) || [];
          list.unshift(entry);
          const trimmed = list.slice(0, MAX);
          chrome.storage.local.set({ [KEY]: trimmed }, function () { void chrome.runtime.lastError; resolve(); });
        });
      });
    }).catch(function () { /* never let logging break the run */ });

    return chain;
  }

  function safeMeta(meta) {
    try {
      if (typeof meta === 'string') return meta.slice(0, 2000);
      return JSON.parse(JSON.stringify(meta, function (k, v) {
        if (typeof v === 'string' && v.length > 1000) return v.slice(0, 1000) + '…';
        return v;
      }));
    } catch (e) {
      return String(meta).slice(0, 500);
    }
  }

  const debug   = function (m, x) { return add('debug', m, x); };
  const info    = function (m, x) { return add('info', m, x); };
  const success = function (m, x) { return add('success', m, x); };
  const warn    = function (m, x) { return add('warn', m, x); };
  const error   = function (m, x) { return add('error', m, x); };

  function read() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([KEY], function (data) { resolve((data && data[KEY]) || []); });
    });
  }

  function clear() {
    return new Promise(function (resolve) {
      chrome.storage.local.set({ [KEY]: [] }, function () { void chrome.runtime.lastError; resolve(); });
    });
  }

  /** Plain-text export, oldest first, suitable for pasting into a bug report. */
  function toText(list) {
    return (list || []).slice().reverse().map(function (l) {
      const lvl = String(l.level || 'info').toUpperCase().padEnd(7, ' ');
      let line = l.time + '  ' + lvl + '  ' + l.msg;
      if (l.meta) {
        try { line += '\n' + ' '.repeat(19) + JSON.stringify(l.meta); } catch (e) {}
      }
      return line;
    }).join('\n');
  }

  return {
    LEVELS: LEVELS,
    setDebug: setDebug,
    isDebug: isDebug,
    add: add,
    debug: debug,
    info: info,
    success: success,
    warn: warn,
    error: error,
    read: read,
    clear: clear,
    toText: toText
  };
})();

if (typeof globalThis !== 'undefined') globalThis.APLog = APLog;

/* ============================================================================
 * services/storage.js — Auto Prompt v14
 * ----------------------------------------------------------------------------
 * All chrome.storage.local access lives here: settings, queue state, the image
 * counter, run history, and the duplicate-upload guard. Mutations that read then
 * write (the counter, the dedupe set) are serialised so two concurrent callers
 * can never produce the same file number or a lost dedupe key.
 *
 * Exposes: globalThis.APStore
 * ==========================================================================*/

var APStore = (function () {
  'use strict';

  const CFG = (typeof AP_CONFIG !== 'undefined') ? AP_CONFIG : (globalThis.AP_CONFIG || {});
  const K = CFG.storageKeys || {};
  const Q = CFG.queue || {};

  const DEFAULT_SETTINGS = {
    mode: 'text',                                   // 'text' | 'image'
    model: CFG.defaultModel || 'nano-banana-2',
    aspectRatio: CFG.defaultAspectRatio || '16:9',
    outputsPerPrompt: Q.defaultOutputsPerPrompt || 1,
    maxRetries: Q.defaultMaxRetries === undefined ? 0 : Q.defaultMaxRetries,  // 0 = unlimited
    startNumber: 1,
    counterBehaviour: 'continuous',                 // 'continuous' | 'reset'
    autoStart: false,
    pauseOnError: true,
    preserveQueue: true,
    debug: false,
    enforceImageMode: true,
    applyAspectRatio: true,
    /* If the chosen model is not in Flow's dropdown, keep whatever model Flow
     * already has instead of stopping the whole run. Never silent: it logs a
     * WARN, prints the real option labels, and marks the queue row. */
    continueIfModelUnconfirmed: true,
    slackEnabled: false,
    slackWebhookUrl: ''
  };

  /* ---------------------------------------------------------------- */
  /*  RAW HELPERS                                                     */
  /* ---------------------------------------------------------------- */
  function get(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (data) {
        void chrome.runtime.lastError;
        resolve(data || {});
      });
    });
  }

  function set(obj) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set(obj, function () {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message)); else resolve();
      });
    });
  }

  function remove(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.remove(keys, function () { void chrome.runtime.lastError; resolve(); });
    });
  }

  /* ---------------------------------------------------------------- */
  /*  SETTINGS                                                        */
  /* ---------------------------------------------------------------- */
  async function getSettings() {
    const data = await get([K.settings || 'settings']);
    return Object.assign({}, DEFAULT_SETTINGS, data[K.settings || 'settings'] || {});
  }

  async function saveSettings(patch) {
    const current = await getSettings();
    const merged = Object.assign({}, current, patch || {});
    await set({ [K.settings || 'settings']: merged });
    return merged;
  }

  /* ---------------------------------------------------------------- */
  /*  IMAGE COUNTER                                                   */
  /* ---------------------------------------------------------------- */
  /* nextCounter() returns the value to USE, then stores value+1, so the very
   * first file is 001 with no off-by-one. Serialised via `mutex`.        */
  let mutex = Promise.resolve();

  function serialise(fn) {
    const run = mutex.then(fn, fn);
    // Keep the chain alive even if fn rejects.
    mutex = run.then(function () {}, function () {});
    return run;
  }

  async function getCounter() {
    const data = await get([K.counter || 'downloadCounter']);
    const v = parseInt(data[K.counter || 'downloadCounter'], 10);
    return (isNaN(v) || v < 1) ? 1 : v;
  }

  function setCounter(value) {
    const v = Math.max(1, parseInt(value, 10) || 1);
    return serialise(async function () {
      await set({ [K.counter || 'downloadCounter']: v });
      return v;
    });
  }

  function nextCounter() {
    return serialise(async function () {
      const current = await getCounter();
      await set({ [K.counter || 'downloadCounter']: current + 1 });
      return current;
    });
  }

  function pad(n) {
    const width = (CFG.drive && CFG.drive.counterPad) || 3;
    return String(n).padStart(width, '0');
  }

  function buildFilename(counter, ext) {
    const tpl = (CFG.drive && CFG.drive.filenameTemplate) || '{counter}.{ext}';
    return tpl.replace('{counter}', pad(counter)).replace('{ext}', ext || CFG.defaultExt || 'jpg');
  }

  /* ---------------------------------------------------------------- */
  /*  QUEUE STATE                                                     */
  /* ---------------------------------------------------------------- */
  const EMPTY_QUEUE = {
    state: 'IDLE',
    items: [],            // [{ n, prompt, status, attempts, filename, driveFileId, driveLink, error, at }]
    currentIndex: 0,
    total: 0,
    mode: 'text',
    model: null,
    aspectRatio: null,
    startedAt: null,
    finishedAt: null,
    tabId: null,
    lastError: null
  };

  async function getQueue() {
    const data = await get([K.queue || 'queueState']);
    return Object.assign({}, EMPTY_QUEUE, data[K.queue || 'queueState'] || {});
  }

  async function saveQueue(patch) {
    const current = await getQueue();
    const merged = Object.assign({}, current, patch || {});
    await set({ [K.queue || 'queueState']: merged });
    return merged;
  }

  function clearQueue() {
    return set({ [K.queue || 'queueState']: Object.assign({}, EMPTY_QUEUE) });
  }

  /** Update one queue item in place without rewriting the caller's copy. */
  async function updateItem(index, patch) {
    const q = await getQueue();
    if (!q.items[index]) return q;
    q.items[index] = Object.assign({}, q.items[index], patch);
    await set({ [K.queue || 'queueState']: q });
    return q;
  }

  /* ---------------------------------------------------------------- */
  /*  HISTORY                                                         */
  /* ---------------------------------------------------------------- */
  function addHistory(entry) {
    return serialise(async function () {
      const key = K.history || 'history';
      const data = await get([key]);
      const list = data[key] || [];
      list.unshift(Object.assign({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 8) }, entry));
      await set({ [key]: list.slice(0, Q.maxHistoryItems || 500) });
      return list.length;
    });
  }

  async function getHistory() {
    const data = await get([K.history || 'history']);
    return data[K.history || 'history'] || [];
  }

  function clearHistory() {
    return set({ [K.history || 'history']: [] });
  }

  /* ---------------------------------------------------------------- */
  /*  DUPLICATE-UPLOAD GUARD                                          */
  /* ---------------------------------------------------------------- */
  /* Keys can be a source URL or a SHA-256 of the image bytes. Persisted so a
   * page refresh mid-run cannot cause the same image to be uploaded twice. */
  async function isDuplicate(keys) {
    const store = await get([K.dedupe || 'dedupeKeys']);
    const map = store[K.dedupe || 'dedupeKeys'] || {};
    for (const k of [].concat(keys)) {
      if (k && map[k]) return map[k];      // returns the recorded upload info
    }
    return null;
  }

  function rememberUpload(keys, info) {
    return serialise(async function () {
      const key = K.dedupe || 'dedupeKeys';
      const store = await get([key]);
      const map = store[key] || {};
      for (const k of [].concat(keys)) {
        if (k) map[k] = info;
      }
      // Bound the map: drop the oldest entries once it grows too large.
      const entries = Object.keys(map);
      const max = Q.maxDedupeKeys || 2000;
      if (entries.length > max) {
        entries
          .map(function (k) { return { k: k, at: (map[k] && map[k].at) || 0 }; })
          .sort(function (a, b) { return a.at - b.at; })
          .slice(0, entries.length - max)
          .forEach(function (e) { delete map[e.k]; });
      }
      await set({ [key]: map });
    });
  }

  function clearDedupe() {
    return set({ [K.dedupe || 'dedupeKeys']: {} });
  }

  /* ---------------------------------------------------------------- */
  /*  REFERENCE IMAGE (image-to-image)                                */
  /* ---------------------------------------------------------------- */
  function saveRefImage(ref) {
    return set({ [K.refImage || 'refImage']: ref || null });
  }
  async function getRefImage() {
    const data = await get([K.refImage || 'refImage']);
    return data[K.refImage || 'refImage'] || null;
  }

  /* ---------------------------------------------------------------- */
  return {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    EMPTY_QUEUE: EMPTY_QUEUE,

    get: get, set: set, remove: remove,

    getSettings: getSettings, saveSettings: saveSettings,

    getCounter: getCounter, setCounter: setCounter, nextCounter: nextCounter,
    pad: pad, buildFilename: buildFilename,

    getQueue: getQueue, saveQueue: saveQueue, clearQueue: clearQueue, updateItem: updateItem,

    addHistory: addHistory, getHistory: getHistory, clearHistory: clearHistory,

    isDuplicate: isDuplicate, rememberUpload: rememberUpload, clearDedupe: clearDedupe,

    saveRefImage: saveRefImage, getRefImage: getRefImage
  };
})();

if (typeof globalThis !== 'undefined') globalThis.APStore = APStore;

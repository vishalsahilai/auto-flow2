/* ============================================================================
 * sidepanel.js — Auto Prompt v14
 * ----------------------------------------------------------------------------
 * All UI and user state. This file NEVER touches the Google Flow DOM and never
 * calls the Drive API directly — it talks to background.js, which owns both.
 * ==========================================================================*/

(function () {
  'use strict';

  const CFG = window.AP_CONFIG || {};
  const $ = function (id) { return document.getElementById(id); };

  const UI = {
    prompts: [],
    settings: null,
    env: null,
    logs: [],
    logFilter: 'all',
    queue: null,
    refImage: null
  };

  /* ==================================================================== */
  /*  MESSAGING                                                           */
  /* ==================================================================== */
  function bg(action, extra) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage(Object.assign({ action: action }, extra || {}), function (res) {
        const err = chrome.runtime.lastError;
        if (err) { resolve({ ok: false, error: err.message }); return; }
        resolve(res || { ok: false, error: 'No response from the extension background service.' });
      });
    });
  }

  /** Call the background and surface any error in the banner. */
  async function call(action, extra, successMsg) {
    const res = await bg(action, extra);
    if (!res.ok) { banner(res.error, 'error'); return null; }
    if (successMsg) banner(successMsg, 'success');
    return res;
  }

  let bannerTimer = null;
  function banner(text, kind) {
    const el = $('banner');
    el.textContent = text;
    el.dataset.kind = kind || 'info';
    el.classList.remove('hidden');
    if (bannerTimer) clearTimeout(bannerTimer);
    if (kind === 'success' || kind === 'info') {
      bannerTimer = setTimeout(function () { el.classList.add('hidden'); }, 6000);
    }
  }
  function hideBanner() { $('banner').classList.add('hidden'); }

  /* ==================================================================== */
  /*  TABS                                                                */
  /* ==================================================================== */
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('is-active'); });
      document.querySelectorAll('.panel').forEach(function (x) { x.classList.remove('is-active'); });
      t.classList.add('is-active');
      const panel = $('tab-' + t.dataset.tab);
      if (panel) panel.classList.add('is-active');
      if (t.dataset.tab === 'history') loadHistory();
      if (t.dataset.tab === 'logs') loadLogs();
    });
  });

  /* ==================================================================== */
  /*  RENDER: MODEL & RATIO PILLS                                          */
  /* ==================================================================== */
  function renderModels() {
    const wrap = $('modelPills');
    wrap.innerHTML = '';
    (CFG.models || []).forEach(function (m) {
      const b = document.createElement('button');
      b.className = 'pill' + (UI.settings.model === m.id ? ' is-on' : '');
      b.dataset.model = m.id;
      b.innerHTML = '';
      b.appendChild(document.createTextNode(m.label));
      const sub = document.createElement('span');
      sub.className = 'pill-sub';
      sub.textContent = m.sublabel || '';
      b.appendChild(sub);
      b.addEventListener('click', function () { saveSettings({ model: m.id }); });
      wrap.appendChild(b);
    });
  }

  function renderRatios() {
    const wrap = $('ratioPills');
    wrap.innerHTML = '';
    (CFG.aspectRatios || []).forEach(function (r) {
      const b = document.createElement('button');
      b.className = 'pill' + (UI.settings.aspectRatio === r.id ? ' is-on' : '');
      b.textContent = r.label;
      b.addEventListener('click', function () { saveSettings({ aspectRatio: r.id }); });
      wrap.appendChild(b);
    });
  }

  function renderMode() {
    document.querySelectorAll('#modeSeg .seg-btn').forEach(function (b) {
      b.classList.toggle('is-on', b.dataset.mode === UI.settings.mode);
    });
    $('refBlock').classList.toggle('hidden', UI.settings.mode !== 'image');
  }

  document.querySelectorAll('#modeSeg .seg-btn').forEach(function (b) {
    b.addEventListener('click', function () { saveSettings({ mode: b.dataset.mode }); });
  });

  /* ==================================================================== */
  /*  SETTINGS                                                            */
  /* ==================================================================== */
  async function saveSettings(patch) {
    const res = await bg('SAVE_SETTINGS', { patch: patch });
    if (!res.ok) { banner(res.error, 'error'); return; }
    UI.settings = res.settings;
    applySettingsToUI();
  }

  function applySettingsToUI() {
    const s = UI.settings;
    renderModels(); renderRatios(); renderMode();

    $('startNumber').value = s.startNumber || 1;
    $('counterBehaviour').value = s.counterBehaviour || 'continuous';
    $('outputsPerPrompt').value = s.outputsPerPrompt || 1;
    $('enforceImageMode').checked = s.enforceImageMode !== false;
    $('applyAspectRatio').checked = s.applyAspectRatio !== false;
    $('continueIfModelUnconfirmed').checked = s.continueIfModelUnconfirmed !== false;
    $('autoStart').checked = !!s.autoStart;
    $('pauseOnError').checked = s.pauseOnError !== false;
    $('preserveQueue').checked = s.preserveQueue !== false;
    $('debugMode').checked = !!s.debug;

    const sel = $('maxRetries');
    if (!sel.options.length) {
      (CFG.queue.retryOptions || [1, 2, 3, 5, 10, 0]).forEach(function (n) {
        const o = document.createElement('option');
        o.value = String(n);
        o.textContent = n === 0 ? 'Unlimited (never skip)' : String(n);
        sel.appendChild(o);
      });
    }
    sel.value = String(s.maxRetries === undefined ? 0 : s.maxRetries);
  }

  [['startNumber', 'startNumber', 'int'],
   ['counterBehaviour', 'counterBehaviour', 'str'],
   ['outputsPerPrompt', 'outputsPerPrompt', 'int'],
   ['maxRetries', 'maxRetries', 'int'],
   ['enforceImageMode', 'enforceImageMode', 'bool'],
   ['applyAspectRatio', 'applyAspectRatio', 'bool'],
   ['continueIfModelUnconfirmed', 'continueIfModelUnconfirmed', 'bool'],
   ['autoStart', 'autoStart', 'bool'],
   ['pauseOnError', 'pauseOnError', 'bool'],
   ['preserveQueue', 'preserveQueue', 'bool'],
   ['debugMode', 'debug', 'bool']
  ].forEach(function (def) {
    const el = $(def[0]);
    if (!el) return;
    el.addEventListener('change', function () {
      let v;
      if (def[2] === 'bool') v = el.checked;
      else if (def[2] === 'int') v = parseInt(el.value, 10) || 0;
      else v = el.value;
      const patch = {}; patch[def[1]] = v;
      saveSettings(patch);
    });
  });

  /* ==================================================================== */
  /*  PROMPTS                                                             */
  /* ==================================================================== */
  function parseBox() {
    UI.prompts = APParser.parsePrompts($('promptsBox').value);
    renderPrompts();
    return UI.prompts;
  }

  function renderPrompts() {
    const n = UI.prompts.length;
    $('promptCount').textContent = n + (n === 1 ? ' prompt' : ' prompts');

    const pv = $('promptPreview');
    pv.innerHTML = '';
    if (!n) { pv.classList.add('hidden'); return; }

    const start = parseInt($('startNumber').value, 10) || 1;
    UI.prompts.forEach(function (p, i) {
      const row = document.createElement('div');
      row.className = 'preview-row';
      const num = document.createElement('span');
      num.className = 'n';
      num.textContent = String(start + i).padStart(3, '0');
      const txt = document.createElement('span');
      txt.className = 'p';
      txt.textContent = p.length > 220 ? p.slice(0, 220) + '…' : p;
      row.appendChild(num); row.appendChild(txt);
      pv.appendChild(row);
    });
    pv.classList.remove('hidden');
  }

  $('promptsBox').addEventListener('input', function () {
    clearTimeout($('promptsBox')._t);
    $('promptsBox')._t = setTimeout(parseBox, 350);
  });
  $('parseBtn').addEventListener('click', function () {
    const list = parseBox();
    banner(list.length ? 'Parsed ' + list.length + ' prompt(s).' : 'No prompts found — separate them with two blank lines.',
           list.length ? 'success' : 'warn');
  });
  $('clearPromptsBtn').addEventListener('click', function () {
    $('promptsBox').value = '';
    UI.prompts = [];
    renderPrompts();
    chrome.storage.local.set({ promptsDraft: '' });
  });

  async function importFile(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    banner('Reading ' + file.name + '…', 'info');
    try {
      const res = await APParser.importFile(file);
      $('promptsBox').value = APParser.joinPrompts(res.prompts);
      parseBox();
      chrome.storage.local.set({ promptsDraft: $('promptsBox').value });
      banner('Imported ' + res.prompts.length + ' prompt(s) from ' + file.name + '.', 'success');
      bg('CS_LOG', { level: 'success', msg: 'Imported ' + res.prompts.length + ' prompt(s) from ' + file.name });
    } catch (e) {
      banner(e.message, 'error');
      bg('CS_LOG', { level: 'error', msg: 'Import failed: ' + e.message });
    }
  }
  $('txtInput').addEventListener('change', function () { importFile(this); });
  $('pdfInput').addEventListener('change', function () { importFile(this); });

  /* ==================================================================== */
  /*  REFERENCE IMAGE                                                     */
  /* ==================================================================== */
  $('refInput').addEventListener('change', function () {
    const file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { banner('Please choose an image file.', 'error'); return; }
    const fr = new FileReader();
    fr.onload = async function () {
      const ref = { name: file.name, mime: file.type, base64: String(fr.result || ''), size: file.size };
      const res = await bg('SAVE_REF_IMAGE', { ref: ref });
      if (!res.ok) { banner(res.error, 'error'); return; }
      UI.refImage = ref;
      showRef();
      banner('Reference image set: ' + file.name, 'success');
    };
    fr.onerror = function () { banner('Could not read that image file.', 'error'); };
    fr.readAsDataURL(file);
  });

  $('refRemoveBtn').addEventListener('click', async function () {
    await bg('SAVE_REF_IMAGE', { ref: null });
    UI.refImage = null;
    showRef();
  });

  function showRef() {
    const has = !!(UI.refImage && UI.refImage.base64);
    $('refPreviewWrap').classList.toggle('hidden', !has);
    $('refRemoveBtn').disabled = !has;
    if (has) {
      $('refPreview').src = UI.refImage.base64;
      $('refName').textContent = UI.refImage.name || 'reference image';
    }
  }

  /* ==================================================================== */
  /*  DRIVE                                                              */
  /* ==================================================================== */
  function showDrive(auth, folder, folderLink) {
    const on = !!(auth && auth.connected);
    const chip = $('driveChip');
    chip.dataset.on = String(on);
    chip.textContent = on ? 'Google Drive Connected ✓' : (auth && !auth.configured ? 'Not configured' : 'Not connected');
    $('driveConnectBtn').textContent = on ? 'Reconnect Google Drive' : 'Connect Google Drive';
    $('driveDisconnectBtn').disabled = !on;

    const name = (folder && folder.name) || (CFG.drive && CFG.drive.defaultFolderName) || 'Auto Prompt';
    const cur = $('currentFolder');
    cur.textContent = 'Current folder: ' + name;
    if (folderLink) {
      cur.textContent = '';
      cur.appendChild(document.createTextNode('Current folder: '));
      const a = document.createElement('a');
      a.href = folderLink; a.target = '_blank'; a.rel = 'noreferrer'; a.textContent = name;
      cur.appendChild(a);
    }
  }

  $('driveConnectBtn').addEventListener('click', async function () {
    banner('Opening the Google sign-in window…', 'info');
    const res = await call('DRIVE_CONNECT', {}, 'Google Drive Connected ✓');
    if (res) { showDrive(res.auth, res.folder, res.folderLink); refreshFolders(); }
  });

  $('driveDisconnectBtn').addEventListener('click', async function () {
    const res = await call('DRIVE_DISCONNECT', {}, 'Google Drive disconnected.');
    if (res) showDrive(res.auth, null, null);
  });

  async function refreshFolders() {
    const res = await bg('DRIVE_LIST_FOLDERS', {});
    const sel = $('folderSelect');
    const current = UI.env && UI.env.folder ? UI.env.folder.id : '';
    sel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = (CFG.drive && CFG.drive.defaultFolderName) || 'Auto Prompt';
    sel.appendChild(def);
    if (res.ok) {
      (res.folders || []).forEach(function (f) {
        const o = document.createElement('option');
        o.value = f.id; o.textContent = f.name;
        if (f.id === current) o.selected = true;
        sel.appendChild(o);
      });
    }
  }

  $('folderRefreshBtn').addEventListener('click', function () {
    refreshFolders();
    banner('Folder list refreshed. Note: with the least-privilege drive.file scope only folders Auto Prompt created are visible.', 'info');
  });

  $('folderSelect').addEventListener('change', async function () {
    const id = this.value;
    const name = this.options[this.selectedIndex].textContent;
    const res = await call('DRIVE_SELECT_FOLDER',
      id ? { folder: { id: id, name: name } } : { name: name });
    if (res) { UI.env.folder = res.folder; showDrive(UI.env.auth, res.folder, res.folderLink); }
  });

  $('folderCreateBtn').addEventListener('click', async function () {
    const name = $('newFolderName').value.trim();
    if (!name) { banner('Type a name for the new folder first.', 'warn'); return; }
    const res = await call('DRIVE_CREATE_FOLDER', { name: name }, 'Created "' + name + '".');
    if (res) {
      $('newFolderName').value = '';
      UI.env.folder = res.folder;
      showDrive(UI.env.auth, res.folder, res.folderLink);
      refreshFolders();
    }
  });

  /* ==================================================================== */
  /*  COUNTER                                                             */
  /* ==================================================================== */
  function showCounter(n) {
    const label = 'Next file: ' + String(n).padStart((CFG.drive && CFG.drive.counterPad) || 3, '0') +
                  '.' + (CFG.defaultExt || 'jpg');
    $('nextFileLabel').textContent = label;
    $('counterInfo').textContent = label;
  }

  $('applyStartBtn').addEventListener('click', async function () {
    const v = parseInt($('startNumber').value, 10) || 1;
    await saveSettings({ startNumber: v });
    const res = await call('SET_COUNTER', { value: v }, 'Counter set — the next file will be ' +
      String(v).padStart(3, '0') + '.' + (CFG.defaultExt || 'jpg') + '.');
    if (res) { showCounter(res.counter); renderPrompts(); }
  });

  $('resetCounterBtn').addEventListener('click', async function () {
    const res = await call('RESET_COUNTER', {}, 'Counter reset.');
    if (res) showCounter(res.counter);
  });

  /* ==================================================================== */
  /*  RUN CONTROL                                                         */
  /* ==================================================================== */
  $('startBtn').addEventListener('click', async function () {
    hideBanner();
    const prompts = parseBox();
    if (!prompts.length) {
      banner('Add at least one prompt first. Separate prompts with two blank lines.', 'warn');
      return;
    }
    if (UI.settings.mode === 'image' && !UI.refImage) {
      banner('Reference image is missing. Choose one, or switch back to Text → Image.', 'error');
      return;
    }
    chrome.storage.local.set({ promptsDraft: $('promptsBox').value });

    $('startBtn').disabled = true;
    const res = await bg('START', { prompts: prompts });
    $('startBtn').disabled = false;

    if (!res.ok) { banner(res.error, 'error'); return; }
    banner('Started ' + res.total + ' prompt(s). Images will be saved to Google Drive / ' +
           (res.folder ? res.folder.name : 'Auto Prompt') + '.', 'success');
    document.querySelector('.tab[data-tab="queue"]').click();
    refreshQueue();
  });

  function control(command, msg) {
    return call('CONTROL', { command: command }, msg);
  }
  $('pauseBtn').addEventListener('click', function () { control('PAUSE', 'Paused. Nothing is lost — press Resume to continue.'); });
  $('resumeBtn').addEventListener('click', function () { control('RESUME', 'Resumed.'); });
  $('stopBtn').addEventListener('click', function () { control('STOP', 'Stopped.'); });
  $('retryBtn').addEventListener('click', function () { control('RETRY_CURRENT', 'Retrying the current prompt.'); });
  $('skipBtn').addEventListener('click', function () { control('SKIP_CURRENT', 'Skipping the current prompt.'); });

  $('diagnoseBtn').addEventListener('click', async function () {
    const res = await call('DIAGNOSE', {});
    if (!res) return;
    const r = res.report;
    banner('Diagnostics: editor ' + (r.editor ? 'found' : 'NOT found') +
           ', generate button ' + (r.generateButton ? 'found' : 'NOT found') +
           ', model control ' + (r.modelSelector ? 'found' : 'NOT found') +
           ', output type ' + (r.outputType ? r.outputType.current : 'unknown') +
           ', image candidates ' + r.imageCandidates + '. Full detail is in the Logs tab.',
           r.editor && r.generateButton ? 'success' : 'warn');
    document.querySelector('.tab[data-tab="logs"]').click();
    loadLogs();
  });

  $('openFlowBtn').addEventListener('click', function () {
    chrome.tabs.create({ url: 'https://labs.google/fx/tools/flow' });
  });

  /* ==================================================================== */
  /*  QUEUE VIEW                                                          */
  /* ==================================================================== */
  const RUNNING = { SUBMITTING: 1, GENERATING: 1, UPLOADING: 1, RETRYING: 1, SUCCESS: 1 };

  function renderQueue(st) {
    UI.queue = st;
    const chip = $('stateChip');
    const state = (st && st.state) || 'IDLE';
    chip.dataset.state = state;
    chip.textContent = prettyState(state, st);

    const total = st ? st.total : 0;
    const pos = st ? Math.min(st.index + 1, Math.max(total, 1)) : 0;
    $('queuePosition').textContent = 'Prompt ' + String(total ? pos : 0).padStart(3, '0') +
                                    ' / ' + String(total).padStart(3, '0');

    const done = st && st.counters ? st.counters.uploaded : 0;
    $('queueBar').style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
    $('statTotal').textContent = total;
    $('statDone').textContent = done;
    $('statFailed').textContent = st && st.counters ? st.counters.failed : 0;
    $('statRetries').textContent = st && st.counters ? st.counters.retries : 0;
    $('statSkipped').textContent = st && st.counters ? st.counters.skipped : 0;

    $('currentPromptText').textContent = st && st.current
      ? 'Prompt ' + String(st.current.n).padStart(3, '0') + ' — ' + st.current.prompt
      : 'Nothing running.';

    const list = $('queueList');
    list.innerHTML = '';
    if (!st || !st.items || !st.items.length) {
      list.innerHTML = '<div class="empty">The queue is empty.</div>';
    } else {
      st.items.forEach(function (it, i) {
        const row = document.createElement('div');
        row.className = 'item' + (i === st.index ? ' is-current' : '');
        const head = document.createElement('div');
        head.className = 'item-head';

        const n = document.createElement('span');
        n.className = 'item-n';
        n.textContent = String(it.n).padStart(3, '0');

        const txt = document.createElement('span');
        txt.className = 'item-text';
        txt.textContent = it.prompt;
        txt.title = it.prompt;

        const b = document.createElement('span');
        b.className = 'badge';
        b.dataset.s = it.status;
        b.textContent = it.status + (it.attempts > 1 ? ' ×' + it.attempts : '');

        head.appendChild(n); head.appendChild(txt); head.appendChild(b);
        row.appendChild(head);

        if (it.filename) {
          const m = document.createElement('div');
          m.className = 'item-meta';
          m.textContent = 'Saved as ' + it.filename;
          row.appendChild(m);
        }
        if (it.error) {
          const e = document.createElement('div');
          e.className = 'item-err';
          e.textContent = it.error;
          row.appendChild(e);
        }
        list.appendChild(row);
      });
    }

    const running = !!(st && st.running);
    const paused = !!(st && st.paused);
    const waiting = !!(st && st.awaitingDecision);

    $('startBtn').disabled = running;
    $('pauseBtn').disabled = !running || paused;
    $('resumeBtn').disabled = !(paused || (st && st.state === 'PAUSED'));
    $('stopBtn').disabled = !running && !paused;
    $('retryBtn').disabled = !waiting;
    $('skipBtn').disabled = !waiting;

    if (st && st.lastError && waiting) {
      banner('Queue paused: ' + st.lastError + '\nChoose Retry, Skip or Stop.', 'error');
    }
  }

  function prettyState(s, st) {
    if (s === 'PAUSED' && st && st.awaitingDecision) return 'Needs you';
    const map = {
      IDLE: 'Idle', SUBMITTING: 'Submitting', GENERATING: 'Generating', SUCCESS: 'Success',
      FAILED: 'Failed', RETRYING: 'Retrying', UPLOADING: 'Uploading',
      UPLOAD_FAILED: 'Upload failed', PAUSED: 'Paused', STOPPED: 'Stopped', COMPLETED: 'Completed'
    };
    return map[s] || s;
  }

  async function refreshQueue() {
    const res = await bg('GET_QUEUE', {});
    if (!res.ok) return;
    if (res.state) renderQueue(res.state);
    else if (res.saved && res.saved.items && res.saved.items.length) {
      renderQueue({
        state: res.saved.state, running: false, paused: res.saved.state === 'PAUSED',
        index: res.saved.currentIndex || 0, total: res.saved.total || res.saved.items.length,
        current: res.saved.items[res.saved.currentIndex] || null,
        items: res.saved.items, counters: res.saved.counters || {}, lastError: res.saved.lastError
      });
    } else {
      renderQueue(null);
    }
  }

  $('clearQueueBtn').addEventListener('click', async function () {
    await call('CLEAR_QUEUE', {}, 'Queue cleared.');
    refreshQueue();
  });
  $('clearDedupeBtn').addEventListener('click', function () {
    call('CLEAR_DEDUPE', {}, 'Duplicate-protection memory cleared.');
  });

  /* ==================================================================== */
  /*  HISTORY                                                             */
  /* ==================================================================== */
  async function loadHistory() {
    const res = await bg('GET_HISTORY', {});
    const list = $('historyList');
    list.innerHTML = '';
    const items = (res.ok && res.history) || [];
    if (!items.length) { list.innerHTML = '<div class="empty">Nothing has been generated yet.</div>'; return; }

    items.forEach(function (h) {
      const row = document.createElement('div');
      row.className = 'item';

      const head = document.createElement('div');
      head.className = 'item-head';
      const n = document.createElement('span');
      n.className = 'item-n';
      n.textContent = String(h.promptIndex || 0).padStart(3, '0');
      const txt = document.createElement('span');
      txt.className = 'item-text';
      txt.textContent = h.promptText || '';
      txt.title = h.promptText || '';
      const b = document.createElement('span');
      b.className = 'badge';
      b.dataset.s = h.status || 'uploaded';
      b.textContent = h.status || 'uploaded';
      head.appendChild(n); head.appendChild(txt); head.appendChild(b);
      row.appendChild(head);

      const meta = document.createElement('div');
      meta.className = 'item-meta';
      const bits = [];
      if (h.filename) bits.push(h.filename);
      if (h.model) bits.push(h.model);
      if (h.mode) bits.push(h.mode === 'image' ? 'image→image' : 'text→image');
      if (h.aspectRatio) bits.push(h.aspectRatio);
      if (h.driveFolderName) bits.push('Drive / ' + h.driveFolderName);
      if (h.time) bits.push(new Date(h.time).toLocaleString());
      meta.textContent = bits.join(' · ');
      row.appendChild(meta);

      if (h.driveFileId) {
        const id = document.createElement('div');
        id.className = 'item-meta mono';
        id.textContent = 'Drive file ID: ' + h.driveFileId;
        row.appendChild(id);

        if (h.driveLink) {
          const link = document.createElement('div');
          link.className = 'item-meta';
          const a = document.createElement('a');
          a.href = h.driveLink; a.target = '_blank'; a.rel = 'noreferrer';
          a.textContent = 'Open in Google Drive';
          link.appendChild(a);
          row.appendChild(link);
        }
      }
      list.appendChild(row);
    });
  }

  $('clearHistoryBtn').addEventListener('click', async function () {
    await call('CLEAR_HISTORY', {}, 'History cleared.');
    loadHistory();
  });

  /* ==================================================================== */
  /*  LOGS                                                               */
  /* ==================================================================== */
  async function loadLogs() {
    const res = await bg('GET_LOGS', {});
    UI.logs = (res.ok && res.logs) || [];
    renderLogs();
  }

  function renderLogs() {
    const list = $('logList');
    const rows = UI.logFilter === 'all'
      ? UI.logs
      : UI.logs.filter(function (l) { return l.level === UI.logFilter; });

    list.innerHTML = '';
    if (!rows.length) { list.innerHTML = '<div class="empty">No log entries yet.</div>'; return; }

    rows.slice(0, 400).forEach(function (l) {
      const row = document.createElement('div');
      row.className = 'log-row';
      row.dataset.lv = l.level;

      const t = document.createElement('span'); t.className = 'log-time'; t.textContent = l.time;
      const lv = document.createElement('span'); lv.className = 'log-lv';
      lv.textContent = String(l.level || '').toUpperCase().slice(0, 5);
      const m = document.createElement('span'); m.className = 'log-msg'; m.textContent = l.msg;

      if (l.meta) {
        const meta = document.createElement('span');
        meta.className = 'log-meta';
        try { meta.textContent = '  ' + JSON.stringify(l.meta); } catch (e) {}
        m.appendChild(meta);
      }
      row.appendChild(t); row.appendChild(lv); row.appendChild(m);
      list.appendChild(row);
    });
  }

  document.querySelectorAll('#logFilters .pill').forEach(function (p) {
    p.addEventListener('click', function () {
      document.querySelectorAll('#logFilters .pill').forEach(function (x) { x.classList.remove('is-on'); });
      p.classList.add('is-on');
      UI.logFilter = p.dataset.level;
      renderLogs();
    });
  });

  function logsToText() {
    return UI.logs.slice().reverse().map(function (l) {
      let s = l.time + '  ' + String(l.level).toUpperCase().padEnd(7, ' ') + '  ' + l.msg;
      if (l.meta) { try { s += '\n                     ' + JSON.stringify(l.meta); } catch (e) {} }
      return s;
    }).join('\n');
  }

  $('copyLogsBtn').addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText(logsToText());
      banner('Log copied to the clipboard.', 'success');
    } catch (e) { banner('Could not access the clipboard. Use Export instead.', 'error'); }
  });

  $('exportLogsBtn').addEventListener('click', function () {
    const blob = new Blob([logsToText()], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'auto-prompt-log-' + new Date().toISOString().replace(/[:.]/g, '-') + '.txt';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  });

  $('clearLogsBtn').addEventListener('click', async function () {
    await bg('CLEAR_LOGS', {});
    UI.logs = [];
    renderLogs();
  });

  /* ==================================================================== */
  /*  LIVE UPDATES                                                        */
  /* ==================================================================== */
  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || !msg.action) return;
    if (msg.action === 'QUEUE_STATE') { renderQueue(msg.state); return; }
    if (msg.action === 'RUN_FINISHED') { renderQueue(msg.state); loadHistory(); refreshEnv(); return; }
    if (msg.action === 'LOG') {
      UI.logs.unshift(msg.entry);
      if (UI.logs.length > 800) UI.logs.pop();
      if ($('tab-logs').classList.contains('is-active')) renderLogs();
      return;
    }
    if (msg.action === 'UPLOAD_DONE') { refreshEnv(); return; }
  });

  /* ==================================================================== */
  /*  BOOT                                                                */
  /* ==================================================================== */
  async function refreshEnv() {
    const res = await bg('GET_ENV', {});
    if (!res.ok) { banner(res.error, 'error'); return; }
    UI.env = res;
    UI.settings = res.settings;
    applySettingsToUI();
    showCounter(res.counter);
    showDrive(res.auth, res.folder, res.folderLink);

    $('versionLabel').textContent = 'v' + res.version + ' · Flow → Drive';
    $('flowTabInfo').textContent = res.flowTab
      ? 'Connected: ' + (res.flowTab.title || res.flowTab.url).slice(0, 60)
      : 'No Google Flow tab is open.';

    const setup = $('setupInfo');
    setup.textContent = '';
    [['Extension ID', res.extensionId],
     ['OAuth redirect URI', res.redirectUri],
     ['OAuth client ID', res.auth.configured ? 'configured' : 'NOT SET — see README'],
     ['Drive scope', 'drive.file (least privilege)']
    ].forEach(function (p) {
      const d = document.createElement('div');
      d.textContent = p[0] + ': ' + p[1];
      setup.appendChild(d);
    });

    if (!res.auth.configured) {
      banner('Google Drive is not set up yet. Paste your OAuth client ID into config.js, then reload the extension. ' +
             'The redirect URI to register is ' + res.redirectUri, 'warn');
    }
  }

  async function boot() {
    await refreshEnv();

    const ref = await bg('GET_REF_IMAGE', {});
    if (ref.ok && ref.ref) { UI.refImage = ref.ref; showRef(); }

    chrome.storage.local.get(['promptsDraft'], function (data) {
      if (data && data.promptsDraft) {
        $('promptsBox').value = data.promptsDraft;
        parseBox();
      }
    });

    $('promptsBox').addEventListener('blur', function () {
      chrome.storage.local.set({ promptsDraft: $('promptsBox').value });
    });

    await refreshQueue();
    await loadLogs();
    if (UI.env && UI.env.auth && UI.env.auth.connected) refreshFolders();

    setInterval(refreshQueue, 4000);
  }

  boot();
})();

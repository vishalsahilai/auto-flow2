/* ============================================================================
 * background.js — Auto Prompt v14  (classic MV3 service worker)
 * ----------------------------------------------------------------------------
 * The coordinator. It owns:
 *   - opening the side panel
 *   - Google OAuth + all Google Drive traffic (content.js never touches Drive)
 *   - the file counter, history, logs and dedupe store
 *   - message routing between the side panel and the Flow content script
 *
 * Classic (non-module) worker on purpose: importScripts gives the worker the
 * exact same globals (AP_CONFIG, APLog, APStore, APAuth, APDrive) that the
 * content script and side panel use, with zero duplicated code.
 * ==========================================================================*/

importScripts(
  'config.js',
  'utils/logger.js',
  'utils/retry.js',
  'services/storage.js',
  'services/auth.js',
  'services/drive.js',
  'services/slack.js'
);

'use strict';

const CFG = globalThis.AP_CONFIG;

/* ====================================================================== */
/*  SIDE PANEL                                                            */
/* ====================================================================== */
chrome.runtime.onInstalled.addListener(function (details) {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) { /* older Chrome: the action listener below still opens it */ }

  APStore.getSettings().then(function (s) {
    APLog.setDebug(!!s.debug);
    APLog.info('Auto Prompt v14 ' + (details.reason === 'update' ? 'updated' : 'installed') +
               '. Extension ID: ' + chrome.runtime.id);
    APLog.info('OAuth redirect URI to register in Google Cloud: ' + APAuth.redirectUri());
  });
});

chrome.runtime.onStartup.addListener(function () {
  APStore.getSettings().then(function (s) { APLog.setDebug(!!s.debug); });
});

chrome.action.onClicked.addListener(function (tab) {
  try {
    chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true });
  }
});

/* Keep the panel available everywhere, so it can still be opened off-Flow to
 * connect Drive or read history. */
chrome.tabs.onActivated.addListener(function (info) {
  chrome.sidePanel.setOptions({ tabId: info.tabId, path: 'sidepanel.html', enabled: true });
});

/* ====================================================================== */
/*  FLOW TAB DISCOVERY                                                    */
/* ====================================================================== */
function isFlowUrl(url) {
  if (!url) return false;
  for (const p of (CFG.flowUrlPatterns || [])) if (url.indexOf(p) !== -1) return true;
  return false;
}

function queryTabs(q) {
  return new Promise(function (resolve) {
    chrome.tabs.query(q, function (tabs) { void chrome.runtime.lastError; resolve(tabs || []); });
  });
}

/** The active Flow tab if there is one, else any Flow tab. */
async function findFlowTab() {
  const active = await queryTabs({ active: true, currentWindow: true });
  if (active.length && isFlowUrl(active[0].url)) return active[0];

  const all = await queryTabs({});
  const flow = all.filter(function (t) { return isFlowUrl(t.url); });
  if (!flow.length) return null;

  // Prefer a project page — that is where generation actually happens.
  const project = flow.filter(function (t) { return t.url.indexOf('/project/') !== -1; });
  return (project[0] || flow[0]);
}

function sendToTab(tabId, msg) {
  return new Promise(function (resolve) {
    try {
      chrome.tabs.sendMessage(tabId, msg, function (res) {
        void chrome.runtime.lastError;
        resolve(res);
      });
    } catch (e) { resolve(null); }
  });
}

/**
 * The exact file list the manifest declares for content scripts.
 *
 * v14.2: this is READ FROM THE MANIFEST rather than written out again here.
 * In 14.1 it was a second hard-coded list that had drifted — it still said
 * ['config.js', 'content.js'] after utils/composer.js was added, so whenever the
 * Flow tab was already open (the normal case: manifest injection only happens on
 * navigation) the send-arrow scorer was silently missing and content.js fell back
 * to clicking the wrong button. One list, one source of truth, no drift.
 */
function contentScriptFiles() {
  try {
    const m = chrome.runtime.getManifest();
    const entry = (m.content_scripts || [])[0];
    const files = entry && entry.js ? [].concat(entry.js) : [];
    if (files.length) return files;
  } catch (e) {
    APLog.warn('Could not read the content-script list from the manifest: ' + e.message);
  }
  return ['config.js', 'utils/composer.js', 'content.js'];
}

/** Make sure the content script is live in that tab, injecting it if needed. */
async function ensureContentScript(tabId) {
  const ping = await sendToTab(tabId, { action: 'PING' });
  if (ping && ping.ok) return true;

  const files = contentScriptFiles();
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: files
    });
    APLog.debug('Injected the automation scripts: ' + files.join(', '));
  } catch (e) {
    APLog.error('Could not inject the automation script into the Flow tab: ' + e.message);
    return false;
  }
  await new Promise(function (r) { setTimeout(r, 400); });
  const again = await sendToTab(tabId, { action: 'PING' });
  return !!(again && again.ok);
}

/** Resolve a live Flow tab and guarantee content.js is running in it. */
async function requireFlowTab() {
  const tab = await findFlowTab();
  if (!tab) {
    throw new Error('Google Flow page not detected. Open ' +
      'https://labs.google/fx/tools/flow in a tab, then try again.');
  }
  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    throw new Error('Could not reach the Google Flow page. Reload the Flow tab and try again.');
  }
  return tab;
}

/* ====================================================================== */
/*  PANEL BROADCAST                                                       */
/* ====================================================================== */
function toPanel(msg) {
  try { chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; }); } catch (e) {}
}

/* ====================================================================== */
/*  HANDLERS                                                              */
/* ====================================================================== */
const handlers = {

  /* ---------- diagnostics / status ---------- */

  async GET_ENV() {
    const [settings, counter, folder, auth] = await Promise.all([
      APStore.getSettings(), APStore.getCounter(), APDrive.readFolder(), APAuth.status()
    ]);
    const tab = await findFlowTab();
    return {
      settings: settings,
      counter: counter,
      folder: folder,
      folderLink: folder && folder.id ? APDrive.folderLink(folder.id) : null,
      auth: auth,
      models: CFG.models,
      aspectRatios: CFG.aspectRatios,
      retryOptions: CFG.queue.retryOptions,
      flowTab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null,
      extensionId: chrome.runtime.id,
      redirectUri: APAuth.redirectUri(),
      version: chrome.runtime.getManifest().version
    };
  },

  async DIAGNOSE() {
    const tab = await requireFlowTab();
    const res = await sendToTab(tab.id, { action: 'DIAGNOSE' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'The Flow page did not respond to the diagnostic request.');
    return { report: res.report };
  },

  /* ---------- settings ---------- */

  async SAVE_SETTINGS(msg) {
    const merged = await APStore.saveSettings(msg.patch || {});
    APLog.setDebug(!!merged.debug);
    const tab = await findFlowTab();
    if (tab) sendToTab(tab.id, { action: 'SET_DEBUG', debug: !!merged.debug });
    return { settings: merged };
  },

  async GET_SETTINGS() {
    return { settings: await APStore.getSettings() };
  },

  /* ---------- counter ---------- */

  async SET_COUNTER(msg) {
    const v = await APStore.setCounter(msg.value);
    APLog.info('Next image will be saved as ' + APStore.buildFilename(v, CFG.defaultExt) + '.');
    return { counter: v };
  },

  async GET_COUNTER() {
    return { counter: await APStore.getCounter() };
  },

  async RESET_COUNTER() {
    const s = await APStore.getSettings();
    const v = await APStore.setCounter(s.startNumber || 1);
    APLog.info('Counter reset — the next image will be ' + APStore.buildFilename(v, CFG.defaultExt) + '.');
    return { counter: v };
  },

  /* ---------- Google Drive ---------- */

  async DRIVE_CONNECT() {
    if (!APAuth.isConfigured()) {
      throw new Error('Google Drive is not configured yet. Paste your OAuth client ID into config.js ' +
        '(AP_CONFIG.oauth.clientId) and register this redirect URI in Google Cloud: ' + APAuth.redirectUri());
    }
    await APAuth.connect();
    const folder = await APDrive.ensureFolder({});
    APLog.success('Google Drive connected. Images will be saved to "' + folder.name + '".');
    return {
      auth: await APAuth.status(),
      folder: folder,
      folderLink: APDrive.folderLink(folder.id)
    };
  },

  async DRIVE_DISCONNECT() {
    await APAuth.signOut();
    APLog.info('Google Drive disconnected. No token is stored any more.');
    return { auth: await APAuth.status() };
  },

  async DRIVE_STATUS() {
    const [auth, folder] = await Promise.all([APAuth.status(), APDrive.readFolder()]);
    return { auth: auth, folder: folder, folderLink: folder && folder.id ? APDrive.folderLink(folder.id) : null };
  },

  async DRIVE_LIST_FOLDERS() {
    return {
      folders: await APDrive.listFolders({})
    };
  },

  async DRIVE_CREATE_FOLDER(msg) {
    const name = String(msg.name || '').trim();
    if (!name) throw new Error('Please type a folder name.');
      const created = await APDrive.createFolder(
        name,
        msg.parentId || null,
        {}
      );

      created.path =
        (msg.parentPath ? msg.parentPath + ' / ' : '') +
        created.name;

      await APDrive.selectFolder(created);
    APLog.success('Created the Google Drive folder "' + created.name + '" and selected it.');
    return { folder: created, folderLink: APDrive.folderLink(created.id) };
  },

  async DRIVE_SELECT_FOLDER(msg) {
    const folder = msg.folder && msg.folder.id
      ? await APDrive.selectFolder(msg.folder)
      : await APDrive.setFolderName(msg.name);
    APLog.info('Destination folder set to "' + folder.name + '".');
    return { folder: folder, folderLink: folder.id ? APDrive.folderLink(folder.id) : null };
  },

  /* The content script asks for this. It must resolve with a real Drive file id
   * or reject — content.js will not advance its queue on a rejection. */
  async UPLOAD_IMAGE(msg) {
    const info = await APDrive.uploadGeneratedImage(msg.job, {});
    toPanel({ action: 'UPLOAD_DONE', info: info });
    return { info: info };
  },

  /* ---------- run control (proxied to the Flow tab) ---------- */

  async START(msg) {
    const settings = await APStore.getSettings();

    await APSlack.resetRun();

    if (!APAuth.isConfigured()) {
      throw new Error('Google Drive is not configured yet. Paste your OAuth client ID into config.js, ' +
        'reload the extension, then click "Connect Google Drive".');
    }

    // Fail fast, before a single prompt is submitted: Drive must be usable, and
    // the destination folder must exist. Local downloading is not a fallback.
    let ready;
    try {
      ready = await APDrive.ensureReady({});
    } catch (e) {
      throw new Error('Google Drive is not connected. ' + e.message);
    }

    const tab = await requireFlowTab();

    if (settings.counterBehaviour === 'reset') {
      await APStore.setCounter(settings.startNumber || 1);
    }

    const refImage = settings.mode === 'image' ? await APStore.getRefImage() : null;
    if (settings.mode === 'image' && !refImage) throw new Error('Reference image is missing.');

    const res = await sendToTab(tab.id, {
      action: 'START',
      prompts: msg.prompts || [],
      settings: settings,
      refImage: refImage,
      startNumber: 1
    });
    if (!res) throw new Error('The Google Flow page did not respond. Reload it and try again.');
    if (!res.ok) throw new Error(res.error || 'The run could not be started.');

    APLog.info('Run started with ' + res.total + ' prompt(s). Destination: Google Drive / ' +
               ready.folder.name + '.');
    return { total: res.total, folder: ready.folder, tabId: tab.id };
  },

  async CONTROL(msg) {
    const tab = await findFlowTab();
    if (!tab) throw new Error('Google Flow page not detected.');
    const res = await sendToTab(tab.id, { action: msg.command });
    if (!res) throw new Error('The Google Flow page did not respond.');
    if (!res.ok) throw new Error(res.error || 'That action could not be completed.');
    return res;
  },

  async GET_QUEUE() {
    const tab = await findFlowTab();
    if (tab) {
      const res = await sendToTab(tab.id, { action: 'GET_STATE' });
      if (res && res.ok) return { state: res.state, live: true };
    }
    const saved = await APStore.getQueue();
    return { state: null, saved: saved, live: false };
  },

  async CLEAR_QUEUE() {
    const tab = await findFlowTab();
    if (tab) await sendToTab(tab.id, { action: 'STOP' });
    await APStore.clearQueue();
    APLog.info('Queue cleared.');
    return { ok: true };
  },

  /* ---------- reference image ---------- */

  async SAVE_REF_IMAGE(msg) {
    await APStore.saveRefImage(msg.ref || null);
    if (msg.ref) APLog.info('Reference image stored: ' + (msg.ref.name || 'image') + '.');
    else APLog.info('Reference image removed.');
    return { ok: true };
  },

  async GET_REF_IMAGE() {
    return { ref: await APStore.getRefImage() };
  },

  /* ---------- history / logs ---------- */

  async GET_HISTORY() { return { history: await APStore.getHistory() }; },
  async CLEAR_HISTORY() { await APStore.clearHistory(); APLog.info('History cleared.'); return { ok: true }; },
  async GET_LOGS() { return { logs: await APLog.read() }; },
  async CLEAR_LOGS() { await APLog.clear(); return { ok: true }; },
  async CLEAR_DEDUPE() {
    await APStore.clearDedupe();
    APLog.warn('Duplicate-protection memory cleared. Previously uploaded images can be uploaded again.');
    return { ok: true };
  },

  /* ---------- messages coming FROM the content script ---------- */

  async CS_LOG(msg) {
    APLog.add(msg.level || 'info', msg.msg, msg.meta);
    return { ok: true };
  },

  async QUEUE_STATE(msg) {
    toPanel({
      action: 'QUEUE_STATE',
      state: msg.state
    });

    try {
      await APSlack.handleQueueState(msg.state);
    } catch (error) {
      APLog.warn(
        'Slack alert could not be sent: ' +
        error.message
      );
    }

    return { ok: true };
  },

  async RUN_FINISHED(msg, sender) {
    toPanel({
      action: 'RUN_FINISHED',
      state: msg.state
    });

    try {
      const folder = await APDrive.readFolder();

      await APSlack.handleRunFinished(
        msg.state,
        folder
      );
    } catch (error) {
      APLog.warn(
        'Slack completion notification could not be sent: ' +
        error.message
      );
    }

    if (sender && sender.tab) {
      await apDetach({
        tabId: sender.tab.id
      });
    }

    return { ok: true };
  },

  async SLACK_TEST() {
    await APSlack.test();
    return { sent: true };
  },

  async HEARTBEAT() { return { ok: true, t: Date.now() }; },

  /* TRUSTED CLICK.
   * Content-script events are always isTrusted:false and carry no user activation,
   * and Flow's Create button asks reCAPTCHA Enterprise for a token — which is only
   * issued on a real gesture. So every synthetic click was ignored silently, with
   * no network call at all. chrome.debugger's Input.dispatchMouseEvent is real
   * browser-level input, so the page cannot tell it from a mouse. A content script
   * cannot call chrome.debugger, which is why this lives in the worker.
   *
   * Chrome shows a "started debugging this browser" banner — that is expected. The
   * debugger now stays attached for the whole run instead of being re-attached per
   * click, because each attach/detach makes the banner appear and disappear, which
   * reflows the page and can move the button out from under the pointer. */
  async TRUSTED_CLICK(msg, sender) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!tabId) throw new Error('No tab to click in.');

    const x = Math.round(msg.x);
    const y = Math.round(msg.y);
    const target = { tabId: tabId };

    await apFocusTab(tabId);
    const fresh = await apAttach(target, 'trusted click');
    /* Only a FIRST attach raises the banner and reflows the page. */
    if (fresh) await apWait(600);

    /* clickCount must be 1 on press AND release, or Chrome delivers trusted
     * mousedown/mouseup and never synthesises a click, so React's onClick never
     * runs — indistinguishable from a dead button. buttons is the pressed-button
     * bitmask that pointer-event handlers read. */
    const base = { x: x, y: y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' };

    /* A human approaches a button; they do not teleport onto it. reCAPTCHA
     * Enterprise scores behaviour, and one lone mouseMoved from nowhere followed
     * instantly by a press is the single most robot-shaped input there is. So the
     * pointer is walked in along a short curved path and then dwells on the target
     * before pressing. This costs ~450 ms per prompt and nothing else. */
    const steps = 12;
    const fromX = x - 90;
    const fromY = y - 60;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = 1 - Math.pow(1 - t, 3);          // fast at first, settling at the end
      const jitter = Math.sin(t * Math.PI) * 6;      // a slight arc, not a ruler-straight line
      await apCmd(target, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(fromX + (x - fromX) * ease),
        y: Math.round(fromY + (y - fromY) * ease + jitter),
        buttons: 0, pointerType: 'mouse'
      });
      await apWait(16);
    }
    await apCmd(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: x, y: y, buttons: 0, pointerType: 'mouse' });
    await apWait(260);                               // hover dwell, as a hand does

    await apCmd(target, 'Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base));
    await apWait(70);                                // a real press and release are separated in time
    await apCmd(target, 'Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base, { buttons: 0 }));
    await apWait(150);

    APLog.info('Dispatched a trusted click at ' + x + ',' + y + ' after a ' + steps + '-step pointer approach.');
    return { clicked: true, x: x, y: y };
  },

  /* TRUSTED KEYBOARD.
   * Enter inserts a newline in Flow's composer, but Cmd/Ctrl+Enter has only ever
   * been tried as a synthetic KeyboardEvent — which Flow ignores for exactly the
   * same reCAPTCHA reason as a synthetic click. Real key input needs no
   * coordinates, so page zoom and layout shifts cannot spoil it. */
  async TRUSTED_KEY(msg, sender) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!tabId) throw new Error('No tab to type in.');

    const target = { tabId: tabId };
    const mod = !!msg.modifier;
    /* CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. Send both Ctrl and
     * Meta so the same call works on macOS and Windows. */
    const modifiers = mod ? (2 | 4) : 0;

    await apFocusTab(tabId);
    const fresh = await apAttach(target, 'trusted key press');
    if (fresh) await apWait(600);

    const key = {
      key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      text: '\r', unmodifiedText: '\r', modifiers: modifiers
    };

    await apCmd(target, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, key));
    await apWait(60);
    await apCmd(target, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, key));
    await apWait(120);

    APLog.info('Dispatched a trusted ' + (mod ? 'Cmd/Ctrl+Enter' : 'Enter') + '.');
    return { pressed: true, modifier: mod };
  },
  /* GESTURE CLICK.
   * Runtime.evaluate with userGesture:true runs JS in the page's own world carrying
   * a real transient user-activation token, so el.click() gets native activation
   * behaviour AND satisfies gesture checks. This reaches handlers that plain mouse
   * dispatch may miss, e.g. if Flow's handler is not bound to mouseup. */
  async GESTURE_CLICK(msg, sender) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!tabId) throw new Error('No tab to click in.');

    const x = Math.round(msg.x);
    const y = Math.round(msg.y);
    const target = { tabId: tabId };

    await apFocusTab(tabId);
    const fresh = await apAttach(target, 'gesture click');
    if (fresh) await apWait(600);

    const expression =
      '(function(){' +
      'var el=document.elementFromPoint(' + x + ',' + y + ');' +
      'if(!el)return "no element at those coordinates";' +
      'var b=el.closest("button,[role=\\"button\\"]")||el;' +
      'b.click();' +
      'return "clicked "+b.tagName+" "+String(b.innerText||b.textContent||"").trim().slice(0,40);' +
      '})()';

    const res = await apCmd(target, 'Runtime.evaluate',
      { expression: expression, userGesture: true, returnByValue: true });
    const detail = res && res.result ? res.result.value : '(no result)';
    APLog.info('Gesture click: ' + detail);
    return { clicked: true, detail: detail };
  },

  /* Attach without clicking, so the content script can let the "started debugging"
   * banner push the page down BEFORE it measures the send arrow. Without this the
   * first click of every run was aimed 75 px too low and hit the page background. */
  async ATTACH_DEBUGGER(msg, sender) {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (!tabId) throw new Error('No tab to attach to.');
    await apFocusTab(tabId);
    const fresh = await apAttach({ tabId: tabId }, 'trusted click');
    return { attached: true, fresh: fresh };
  },

  /* Let go of the tab when a run ends, so the "started debugging" banner does not
   * sit there forever. Called on STOP and when a run finishes. */
  async DETACH_DEBUGGER(msg, sender) {
    const tabId = (msg && msg.tabId) || (sender && sender.tab ? sender.tab.id : null);
    if (!tabId) return { detached: false };
    await apDetach({ tabId: tabId });
    return { detached: true };
  }
};

/* ====================================================================== */
/*  chrome.debugger PLUMBING                                              */
/* ====================================================================== */
/* Shared by TRUSTED_CLICK, TRUSTED_KEY and GESTURE_CLICK. Kept out of the
 * handlers object so there is exactly ONE copy of the attach logic — three
 * hand-merged copies is how this file picked up duplicate-identifier syntax
 * errors before. Function declarations hoist, so order does not matter. */

const AP_ATTACHED = new Set();

function apWait(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/* Input is delivered to the focused window. A real mouse click focuses the window
 * as a side effect; CDP input does not, so the page can still judge the gesture
 * ungenuine while DevTools or the side panel holds focus. */
async function apFocusTab(tabId) {
  try {
    await chrome.tabs.update(tabId, { active: true });
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) {}
}

/** Attach if needed. Resolves true when THIS call did the attaching. */
function apAttach(target, what) {
  if (AP_ATTACHED.has(target.tabId)) return Promise.resolve(false);
  return new Promise(function (resolve, reject) {
    chrome.debugger.attach(target, '1.3', function () {
      const e = chrome.runtime.lastError;
      if (e && /already attached/i.test(e.message)) {
        AP_ATTACHED.add(target.tabId);
        return resolve(false);
      }
      if (e) {
        return reject(new Error(
          /devtools/i.test(e.message)
            ? 'Chrome will not allow a ' + what + ' while DevTools is open on the Flow tab. ' +
              'Close DevTools (the Console panel) on that tab and press Retry.'
            : 'Could not attach the debugger: ' + e.message));
      }
      AP_ATTACHED.add(target.tabId);
      resolve(true);
    });
  });
}

function apDetach(target) {
  AP_ATTACHED.delete(target.tabId);
  return new Promise(function (resolve) {
    try {
      chrome.debugger.detach(target, function () { void chrome.runtime.lastError; resolve(); });
    } catch (e) { resolve(); }
  });
}

function apCmd(target, method, params) {
  return new Promise(function (resolve, reject) {
    chrome.debugger.sendCommand(target, method, params, function (res) {
      const e = chrome.runtime.lastError;
      if (e) {
        /* The user closed the tab, or opened DevTools mid-run and Chrome took the
         * session away. Forget it so the next attempt re-attaches cleanly. */
        AP_ATTACHED.delete(target.tabId);
        return reject(new Error(method + ' failed: ' + e.message));
      }
      resolve(res);
    });
  });
}

/* Chrome detaches us if the user opens DevTools or the tab goes away. Keep the
 * bookkeeping honest so a later click does not silently no-op. */
try {
  chrome.debugger.onDetach.addListener(function (source) {
    if (source && source.tabId != null) AP_ATTACHED.delete(source.tabId);
  });
} catch (e) {}
try {
  chrome.tabs.onRemoved.addListener(function (tabId) { AP_ATTACHED.delete(tabId); });
} catch (e) {}

/* ====================================================================== */
/*  MESSAGE ROUTER                                                        */
/* ====================================================================== */
chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
  if (!msg || !msg.action) return;

  // Panel-bound broadcasts that the worker itself emits — ignore the echo.
  if (msg.action === 'LOG' || msg.action === 'UPLOAD_DONE') return;

  const handler = handlers[msg.action];
  if (!handler) return;   // not ours (e.g. a content-script-only action)

  Promise.resolve()
    .then(function () { return handler(msg, sender); })
    .then(function (result) { respond(Object.assign({ ok: true }, result || {})); })
    .catch(function (err) {
      const message = err && err.message ? err.message : String(err);
      if (msg.action !== 'CS_LOG') APLog.error(message);
      respond({ ok: false, error: message });
    });

  return true;   // keep the message channel open for the async reply
});

/* ====================================================================== */
/*  KEEPALIVE                                                             */
/* ====================================================================== */
/* An alarm plus the content script's heartbeat keeps the worker from being
 * evicted mid-run, which would otherwise abandon an in-flight upload. */
chrome.alarms.create('ap-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'ap-keepalive') { /* waking up is the whole point */ }
});

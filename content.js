/* ============================================================================
 * content.js — Auto Prompt v14
 * ----------------------------------------------------------------------------
 * Runs inside the Google Flow page. Its ONLY job is Flow automation:
 *   find controls -> set model/mode/ratio -> attach reference -> type prompt ->
 *   submit -> detect the NEW generated image -> hand the bytes to the service
 *   worker for Google Drive upload -> advance ONLY after a confirmed upload.
 *
 * This file never talks to the Drive API and never renders UI.
 *
 * Proven behaviours preserved from v13:
 *   - submit with an Enter KeyboardEvent on the editor (NOT a button click)
 *   - per-character synthetic typing as the fallback path
 *   - trigger-based waiting: never a fixed delay as the advance condition
 * Removed from v13 (known page-crasher):
 *   - document.execCommand(...) — crashed Slate with
 *     "Cannot resolve a Slate node from DOM node".
 * ==========================================================================*/

(function () {
  'use strict';

  /* Guard: a re-injection must not create two competing runners. */
  /* Flow has subframes, and each frame has its own globalThis, so the flag alone
   * is not enough — only the top frame should ever automate. */
  if (window.top !== window) return;
  if (globalThis.__AUTO_PROMPT_V14__) return;
  globalThis.__AUTO_PROMPT_V14__ = true;

  const CFG = globalThis.AP_CONFIG || {};
  const S   = CFG.selectors || {};
  const T   = CFG.timeouts || {};
  const GI  = CFG.generatedImage || {};

  const STATES = {
    IDLE: 'IDLE', SUBMITTING: 'SUBMITTING', GENERATING: 'GENERATING',
    SUCCESS: 'SUCCESS', FAILED: 'FAILED', RETRYING: 'RETRYING',
    UPLOADING: 'UPLOADING', UPLOAD_FAILED: 'UPLOAD_FAILED',
    PAUSED: 'PAUSED', STOPPED: 'STOPPED', COMPLETED: 'COMPLETED'
  };

  /* ====================================================================== */
  /*  RUNTIME STATE                                                         */
  /* ====================================================================== */
  const R = {
    state: STATES.IDLE,
    running: false,
    paused: false,
    stopRequested: false,
    settings: null,
    items: [],            // [{ n, prompt, status, attempts, ... }]
    index: 0,
    refImage: null,       // { name, mime, base64 }
    refAttached: false,
    decision: null,       // resolver used by the Retry / Skip / Stop pause
    pending: {},          // index -> [captured images] kept across upload retries
    heartbeat: null,
    debug: false,
    lastError: null,
    counters: { uploaded: 0, failed: 0, retries: 0, skipped: 0 }
  };

  /* ====================================================================== */
  /*  SMALL UTILITIES                                                       */
  /* ====================================================================== */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function send(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          void chrome.runtime.lastError;
          resolve(res);
        });
      } catch (e) { resolve(null); }
    });
  }

  function log(level, msg, meta) {
    if (level === 'debug' && !R.debug) return;
    try {
      const tag = '[AutoPrompt/flow][' + level.toUpperCase() + ']';
      if (level === 'error') console.error(tag, msg, meta || '');
      else if (level === 'warn') console.warn(tag, msg, meta || '');
      else console.log(tag, msg, meta || '');
    } catch (e) {}
    send({ action: 'CS_LOG', level: level, msg: String(msg), meta: meta === undefined ? null : meta });
  }
  const L = {
    debug: function (m, x) { log('debug', m, x); },
    info: function (m, x) { log('info', m, x); },
    ok: function (m, x) { log('success', m, x); },
    warn: function (m, x) { log('warn', m, x); },
    err: function (m, x) { log('error', m, x); }
  };

  function norm(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return false;
    return true;
  }

  function isEnabled(el) {
    if (!el) return false;
    if (el.disabled) return false;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  /** Accessible name: aria-label, then title, then visible text. */
  function accName(el) {
    if (!el) return '';
    const aria = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
    if (aria) return norm(aria);
    const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy.split(/\s+/).map(function (id) {
        const n = document.getElementById(id);
        return n ? n.textContent : '';
      });
      const t = norm(parts.join(' '));
      if (t) return t;
    }
    return norm(el.innerText || el.textContent);
  }

  function queryAllVisible(list) {
    const out = [];
    for (const sel of [].concat(list || [])) {
      let nodes = [];
      try { nodes = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { continue; }
      for (const n of nodes) if (isVisible(n) && out.indexOf(n) === -1) out.push(n);
    }
    return out;
  }

  function firstVisible(list) {
    const all = queryAllVisible(list);
    return all.length ? all[0] : null;
  }

  /* Radix/MUI popovers set `pointer-events:none` on <body> and mark the app root
   * inert / aria-hidden while they are open. If one unmounts badly the leftovers
   * stay behind and EVERY click and key press on the page is dead — which looks
   * exactly like "Flow ignored the submit". */
  function clearUiBlockers(where) {
    const fixed = [];
    const b = document.body;

    if (b && b.style && b.style.pointerEvents === 'none') {
      b.style.pointerEvents = '';
      fixed.push('body{pointer-events:none}');
    }
    if (b && b.hasAttribute('data-scroll-locked')) {
      b.removeAttribute('data-scroll-locked');
      fixed.push('body[data-scroll-locked]');
    }

    // Anything between the composer and <body> that was left inert / hidden.
    const editor = findPromptEditor();
    let node = editor ? editor.parentElement : (b ? b.firstElementChild : null);
    let guard = 0;
    while (node && node !== document.documentElement && guard++ < 40) {
      if (node.hasAttribute('inert')) { node.removeAttribute('inert'); fixed.push('[inert]'); }
      if (node.getAttribute('aria-hidden') === 'true') { node.removeAttribute('aria-hidden'); fixed.push('[aria-hidden]'); }
      if (node.style && node.style.pointerEvents === 'none') { node.style.pointerEvents = ''; fixed.push('ancestor{pointer-events:none}'); }
      node = node.parentElement;
    }

    // Orphaned popper shells are reported, never removed — deleting React's own
    // nodes would break the page.
    const shells = document.querySelectorAll('[data-radix-popper-content-wrapper]');
    if (shells.length) fixed.push(shells.length + ' orphaned popper wrapper(s)');

    if (fixed.length) {
      L.warn('Cleared leftover Google Flow dialog blockers before ' + (where || 'clicking') +
             ': ' + fixed.join(', ') + '. These make the whole page ignore clicks and keys.');
    }
    return fixed.length;
  }

  /** How deep in the document a node sits — used to click innermost nodes first. */
  function depthOf(n) {
    let d = 0;
    while (n && n.parentElement) { d++; n = n.parentElement; }
    return d;
  }

  /**
   * Every node in and immediately around a control that could carry the real
   * click handler. Flow's accessible name belongs to a WRAPPER; the handler can
   * sit on the inner icon span, on a nested <button>, or on the wrapper above.
   * Deepest first, because React only bubbles UPWARD — an event dispatched on
   * an ancestor never reaches a descendant's handler.
   */
  function innerClickTargets(el) {
    if (!el) return [];
    let nodes = [];
    try { nodes = Array.prototype.slice.call(el.querySelectorAll('*')); } catch (e) {}
    const out = nodes.filter(function (n) {
      const r = n.getBoundingClientRect();
      return r.width >= 4 && r.height >= 4;
    });
    out.sort(function (a, b) { return depthOf(b) - depthOf(a); });
    if (el.parentElement) out.push(el.parentElement);
    return out.slice(0, 8);
  }

  /**
   * Full pointer + mouse event sequence. React / MUI controls frequently ignore
   * a bare .click(), so every control interaction goes through this.
   *
   * v14.3: the event is aimed at the DEEPEST element under the control's centre
   * point, not at the control itself. React's synthetic system dispatches from
   * the event target upwards, so a handler attached to the inner icon node never
   * fires when the event is dispatched on the labelled wrapper — the click lands,
   * bubbles to the root, and matches nothing. That is silent, and it is exactly
   * what "Flow did not react to any submit method" looked like.
   * Pass { exact: true } to dispatch on the given node and nothing else.
   */
  function realClick(el, opts) {
    if (!el) return false;
    const exact = !!(opts && opts.exact);
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;

    let target = el;
    if (!exact) {
      const hit = document.elementFromPoint(x, y);
      if (hit && (el.contains(hit) || hit.contains(el))) {
        target = hit;
      } else if (hit) {
        L.warn('Something is sitting on top of the button being clicked: ' +
               JSON.stringify(describe(hit)) + ' — clearing blockers first.');
        clearUiBlockers('realClick');
        const again = document.elementFromPoint(x, y);
        if (again && (el.contains(again) || again.contains(el))) target = again;
      }
      if (target !== el) {
        L.debug('Clicking the inner node of the control', { outer: describe(el), inner: describe(target) });
      }
    }

    const base = { bubbles: true, cancelable: true, composed: true, view: window,
                   clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 1, detail: 1 };
    const pBase = Object.assign({}, base, { pointerId: 1, pointerType: 'mouse', isPrimary: true,
                                            width: 1, height: 1, pressure: 0.5 });

    try {
      target.dispatchEvent(new PointerEvent('pointerover', pBase));
      target.dispatchEvent(new PointerEvent('pointerenter', Object.assign({}, pBase, { bubbles: false })));
      target.dispatchEvent(new MouseEvent('mouseover', base));
      target.dispatchEvent(new MouseEvent('mousemove', Object.assign({}, base, { detail: 0 })));
      target.dispatchEvent(new PointerEvent('pointerdown', pBase));
      target.dispatchEvent(new MouseEvent('mousedown', base));
      if (target.focus) target.focus();
      else if (el.focus) el.focus();
      target.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, pBase, { buttons: 0, pressure: 0 })));
      target.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, base, { buttons: 0 })));
      target.dispatchEvent(new MouseEvent('click', Object.assign({}, base, { buttons: 0 })));
    } catch (e) {
      try { el.click(); } catch (e2) { return false; }
    }
    return true;
  }

  /* ====================================================================== */
  /*  REQUIRED FINDERS                                                      */
  /*  Each: primary strategy -> fallback -> diagnostic logging.             */
  /* ====================================================================== */

  /** The Slate/contenteditable prompt box. */
  function findPromptEditor() {
    // Primary: Slate's own marker attribute.
    const slate = queryAllVisible(['[data-slate-editor="true"]']);
    if (slate.length) { L.debug('Editor found via data-slate-editor', { count: slate.length }); return slate[0]; }

    // Secondary: an editable textbox that is big enough to be the prompt box.
    const editable = queryAllVisible(['div[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]'])
      .filter(function (el) { return el.getBoundingClientRect().width > 80; });
    if (editable.length) {
      // Prefer one whose placeholder text looks like a prompt box.
      const scored = editable.slice().sort(function (a, b) {
        return placeholderScore(b) - placeholderScore(a);
      });
      L.debug('Editor found via contenteditable', { count: editable.length });
      return scored[0];
    }

    // Tertiary: a real <textarea>.
    const ta = queryAllVisible(['textarea']);
    if (ta.length) { L.debug('Editor found via textarea'); return ta[0]; }

    L.debug('No prompt editor candidates found');
    return null;
  }

  function placeholderScore(el) {
    const hay = norm((el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || '')) + ' ' + (el.innerText || ''));
    let score = 0;
    for (const p of (S.editorPlaceholders || [])) if (hay.indexOf(p) !== -1) score += 10;
    return score;
  }

  /** The submit/generate control (Enter is tried first; this is the fallback). */
  function findGenerateButton() {
    /* Flow's "+" button is named `add_2 create`, and `create` is one of the
     * words we look for below. Clicking it produced an unrelated image that an
     * earlier build detected and uploaded as 001.jpg. Hard rejection must
     * therefore happen BEFORE any positive scoring. */
    const denied = function (el) {
      return NEVER_CLICK_RE.test(String(accName(el) || '').toLowerCase());
    };

    const byAria = queryAllVisible(S.submitButton || []).filter(function (b) {
      return isEnabled(b) && !denied(b);
    });
    if (byAria.length) { L.debug('Generate button via selector', { name: accName(byAria[0]) }); return byAria[0]; }

    // Fallback: a short-labelled button near the editor whose text says generate.
    const words = S.submitButtonText || [];
    const buttons = queryAllVisible(['button', '[role="button"]']).filter(function (b) {
      return isEnabled(b) && !denied(b);
    });
    for (const b of buttons) {
      const n = accName(b);
      if (!n || n.length > 24) continue;
      for (const w of words) {
        if (n === w || n.indexOf(w) !== -1) { L.debug('Generate button via text', { name: n }); return b; }
      }
    }

    // Last resort: score the composer's own buttons (same logic the submit path
    // uses, minus the disabled->enabled evidence, which needs an empty editor).
    const editor = findPromptEditor();
    if (editor) {
      const ranked = submitCandidates(editor, null);
      if (ranked.length) {
        L.debug('Generate button via composer scoring', { name: ranked[0].name || '(icon-only)', score: ranked[0].score });
        return ranked[0].ref;
      }
    }
    L.debug('No generate button found');
    return null;
  }

  /** The "add media" / ingredient / reference-image control. */
  function findAddMediaButton() {
    const byAria = queryAllVisible(S.addMediaButton || []).filter(isEnabled);
    if (byAria.length) { L.debug('Add-media via selector', { name: accName(byAria[0]) }); return byAria[0]; }

    const words = S.addMediaButtonText || [];
    const cands = queryAllVisible(['button', '[role="button"]', 'label']).filter(isEnabled);
    for (const c of cands) {
      const n = accName(c);
      if (!n || n.length > 40) continue;
      for (const w of words) if (n.indexOf(w) !== -1) { L.debug('Add-media via text', { name: n }); return c; }
    }
    L.debug('No add-media button found');
    return null;
  }

  /**
   * The model dropdown trigger. Primary strategy is semantic: the control whose
   * visible label already contains one of our known model names. That survives
   * class-name churn in a way selectors never do.
   */
  function findModelSelector() {
    const known = (CFG.models || []).reduce(function (acc, m) {
      return acc.concat(m.aliases || [], [norm(m.label)]);
    }, []);

    const cands = queryAllVisible(['button', '[role="button"]', '[role="combobox"]', '[aria-haspopup]'])
      .filter(isEnabled);

    for (const c of cands) {
      const n = accName(c);
      if (!n || n.length > 60) continue;
      for (const k of known) {
        if (k && n.indexOf(k) !== -1) { L.debug('Model selector via displayed model name', { name: n }); return c; }
      }
    }
    for (const c of cands) {
      const n = accName(c);
      if (n && n.indexOf('model') !== -1 && n.length < 60) { L.debug('Model selector via "model" label', { name: n }); return c; }
    }
    const bySel = queryAllVisible(S.modelSelector || []).filter(isEnabled);
    if (bySel.length) { L.debug('Model selector via fallback selector', { name: accName(bySel[0]) }); return bySel[0]; }

    L.debug('No model selector found');
    return null;
  }

  /** The control that chooses Image vs Video output. */
  function findImageGenerationMode() {
    const imgWords = S.imageModeText || [];
    const vidWords = S.videoModeText || [];
    const cands = queryAllVisible(['button', '[role="button"]', '[role="combobox"]', '[role="tab"]', '[aria-haspopup]'])
      .filter(isEnabled);

    // Already showing an image mode -> nothing to change.
    for (const c of cands) {
      const n = accName(c);
      if (!n || n.length > 48) continue;
      for (const w of imgWords) {
        if (n.indexOf(w) !== -1 && n.indexOf('video') === -1) {
          return { el: c, current: 'image', label: n };
        }
      }
    }
    // Showing a video mode -> this is the control we must change.
    for (const c of cands) {
      const n = accName(c);
      if (!n || n.length > 48) continue;
      for (const w of vidWords) {
        if (n.indexOf(w) !== -1) return { el: c, current: 'video', label: n };
      }
    }
    L.debug('No output-type (image/video) control found');
    return null;
  }

  /** Every image on the page that could plausibly be generated output. */
  function findGeneratedImages() {
    const imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
    const patterns = GI.urlPatterns || [];
    const excludes = GI.excludeUrlPatterns || [];
    const minW = GI.fallbackMinNaturalWidth || 320;

    const strong = [];
    const weak = [];

    for (const img of imgs) {
      const src = img.currentSrc || img.src || '';
      if (!src) continue;
      if (src.indexOf('blob:') === 0 && !img.naturalWidth) continue;

      let excluded = false;
      for (const x of excludes) if (src.indexOf(x) !== -1) { excluded = true; break; }
      if (excluded) continue;

      // The reference image must never be mistaken for output.
      if (R.refImage && img.getAttribute('data-autoprompt-ref') === '1') continue;

      let hit = false;
      for (const p of patterns) if (src.indexOf(p) !== -1) { hit = true; break; }

      if (hit) strong.push(img);
      else if (img.naturalWidth >= minW && img.naturalHeight >= minW * 0.4 && isVisible(img)) weak.push(img);
    }
    // Strong (media-endpoint) matches win; the size heuristic is only a fallback.
    return strong.length ? strong : weak;
  }

  /** Coarse page state, used for diagnostics and to confirm work has begun. */
  function detectGenerationState() {
    const busy = queryAllVisible(S.progressIndicator || []).length > 0;
    const fail = findFailureElements().length > 0;
    if (fail) return 'FAILED';
    if (busy) return 'GENERATING';
    return 'IDLE';
  }

  /* ====================================================================== */
  /*  FAILURE DETECTION                                                     */
  /* ====================================================================== */
  /* A stale banner from an earlier prompt must not fail the current one, so
   * every element that already matched before submit is remembered. */
  /* Element identity alone is not enough: React re-creates these nodes on every
   * render, so a WeakSet keyed by element saw each re-render of an OLD banner as
   * a brand-new failure and killed the run ~5 s after every submit. The text is
   * remembered too. */
  const knownFailures = new WeakSet();
  const knownFailureTexts = new Set();

  function findFailureElements() {
    const out = [];
    const seen = new Set();

    const phrases = (
      CFG.failureTexts || []
    ).map(norm).filter(Boolean);

    const maxLen =
      CFG.failureTextMaxLength || 200;

    function matchedPhrase(text) {
      const normalized = norm(text);

      if (!normalized) return null;

      for (const phrase of phrases) {
        if (
          normalized.indexOf(phrase) !== -1
        ) {
          return phrase;
        }
      }

      return null;
    }

    function addFailure(element, sourceText) {
      if (
        !element ||
        !isVisible(element)
      ) {
        return;
      }

      const phrase = matchedPhrase(sourceText);

      if (!phrase) return;

      let target = element;
      let text = norm(sourceText);

      for (
        let i = 0;
        i < 3 && target.parentElement;
        i++
      ) {
        const parent = target.parentElement;

        const parentText = norm(
          parent.innerText ||
          parent.textContent
        );

        if (
          !parentText ||
          parentText.length > maxLen * 3
        ) {
          break;
        }

        target = parent;
        text = parentText;
      }

      if (seen.has(target)) return;

      seen.add(target);

      out.push({
        el: target,
        text: text.slice(0, maxLen * 3),
        phrase: phrase,
        where: JSON.stringify(
          describe(target)
        )
      });
    }

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    );

    let node;

    while (
      (node = walker.nextNode())
    ) {
      const raw = node.nodeValue;

      if (
        !raw ||
        !matchedPhrase(raw)
      ) {
        continue;
      }

      addFailure(
        node.parentElement,
        raw
      );
    }

    const semantic =
      document.querySelectorAll(
        '[role="alert"],' +
        '[aria-live],' +
        '[aria-label],' +
        '[title],' +
        '[data-state="error"],' +
        '[data-status="error"]'
      );

    for (const element of semantic) {
      if (!isVisible(element)) continue;

      const text = [
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
        element.innerText ||
        element.textContent ||
        ''
      ].join(' ');

      if (matchedPhrase(text)) {
        addFailure(element, text);
      }
    }

    return out;
  }

  function baselineFailures() {
    knownFailureTexts.clear();
    const hits = findFailureElements();
    for (const h of hits) { knownFailures.add(h.el); knownFailureTexts.add(h.text); }
    L.debug('Failure baseline captured', {
      existing: hits.length,
      texts: hits.map(function (h) { return h.text; })
    });
  }

  function newFailure() {
    const hits = findFailureElements();
    for (const h of hits) {
      if (knownFailures.has(h.el)) continue;
      knownFailures.add(h.el);
      if (knownFailureTexts.has(h.text)) continue;   // a re-render of an old banner
      knownFailureTexts.add(h.text);
      L.warn('New failure text on the page: "' + h.text + '" (matched "' +
             h.phrase + '") at ' + h.where);
      return h.text;
    }
    return null;
  }

  /* ====================================================================== */
  /*  DROPDOWN OPTION PICKING (document-wide portal search)                  */
  /* ====================================================================== */
  function collectOptions() {
    const maxLen = (S.optionMaxTextLength) || 120;
    const nodes = queryAllVisible(S.optionItem || []);
    const out = [];
    for (const n of nodes) {
      const t = accName(n);
      if (!t || t.length > maxLen) continue;
      out.push({ el: n, text: t });
    }
    return out;
  }

  /**
   * Pick an option by alias. Aliases are tried LONGEST FIRST so that
   * "Nano Banana 2" can never swallow "Nano Banana 2 Lite".
   */
  function pickOption(aliases, exclude) {
    const sorted = [].concat(aliases || []).map(norm).filter(Boolean)
      .sort(function (a, b) { return b.length - a.length; });
    const options = collectOptions();

    // Pass 1: exact text match on the longest alias first.
    for (const a of sorted) {
      for (const o of options) {
        if (o.text === a && !isExcluded(o.text, exclude)) return o;
      }
    }
    // Pass 2: containment, still longest alias first, shortest option first so
    // we prefer the tightest label.
    const byLen = options.slice().sort(function (x, y) { return x.text.length - y.text.length; });
    for (const a of sorted) {
      for (const o of byLen) {
        if (o.text.indexOf(a) !== -1 && !isExcluded(o.text, exclude)) return o;
      }
    }
    return null;
  }

  function isExcluded(text, exclude) {
    for (const x of [].concat(exclude || [])) {
      const n = norm(x);
      if (n && text.indexOf(n) !== -1) return true;
    }
    return false;
  }

  /* Selectors for the floating panels Flow uses for model / ratio / output
   * count. While one of these is open it swallows the Enter key, which is
   * exactly why a prompt can be typed and never submitted. */
  const POPOVER_SEL = '[role="dialog"],[role="menu"],[role="listbox"],' +
                      '[data-radix-popper-content-wrapper],[data-state="open"][role],' +
                      '[aria-modal="true"]';

  function openPopovers() {
    let nodes = [];
    try { nodes = Array.prototype.slice.call(document.querySelectorAll(POPOVER_SEL)); } catch (e) { return []; }
    return nodes.filter(isVisible);
  }

  function escapeOn(target) {
    const ev = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    try { target.dispatchEvent(new KeyboardEvent('keydown', ev)); } catch (e) {}
    try { target.dispatchEvent(new KeyboardEvent('keyup', Object.assign({}, ev, { cancelable: false }))); } catch (e) {}
  }

  /**
   * Close any floating panel. Escape on document.body alone is not enough:
   * Radix/MUI popovers listen on their own content node or on the focused
   * element, so we hit all three, then confirm they actually went away.
   */
  async function closeMenus() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const open = openPopovers();
      if (!open.length) { clearUiBlockers('closing menus'); return true; }

      escapeOn(document.body);
      if (document.activeElement) escapeOn(document.activeElement);
      for (const p of open) escapeOn(p);

      await sleep(T.clickSettleMs || 350);
    }

    const left = openPopovers();
    if (left.length) {
      L.warn('A Google Flow settings panel is still open and may block submission. ' +
             'Close it in the page if the run stalls.', { open: left.length });
      return false;
    }
    return true;
  }

  /* ====================================================================== */
  /*  MODEL SELECTION                                                       */
  /* ====================================================================== */
  function modelById(id) {
    return (CFG.models || []).filter(function (m) { return m.id === id; })[0] || null;
  }

  /** Aliases of the OTHER models — used to stop cross-matching. */
  function competingAliases(id) {
    const out = [];
    for (const m of (CFG.models || [])) {
      if (m.id === id) continue;
      // Only exclude aliases that are NOT a substring of the wanted label,
      // otherwise "nano banana 2" would exclude "nano banana 2 lite".
      for (const a of (m.aliases || [])) out.push(a);
    }
    return out;
  }

  function modelLooksSelected(model) {
    const trigger = findModelSelector();
    if (!trigger) return false;
    const shown = accName(trigger);
    if (!shown) return false;

    // Longest-alias-wins: find which known model this label represents.
    let best = null;
    for (const m of (CFG.models || [])) {
      for (const a of (m.aliases || []).concat([norm(m.label)])) {
        const an = norm(a);
        if (an && shown.indexOf(an) !== -1) {
          if (!best || an.length > best.len) best = { id: m.id, len: an.length };
        }
      }
    }
    return !!best && best.id === model.id;
  }

  /**
   * Select the requested model. Returns { ok, reason }.
   * If the model cannot be CONFIRMED we do not carry on silently — the caller
   * pauses and asks the user to pick it by hand.
   */
  async function ensureModel(modelId) {
    const model = modelById(modelId);
    if (!model) return { ok: false, reason: 'Unknown model id "' + modelId + '".' };

    if (modelLooksSelected(model)) {
      L.debug('Model already selected: ' + model.label);
      return { ok: true, already: true };
    }

    const trigger = findModelSelector();
    if (!trigger) {
      return unconfirmedModel(model, 'The model selector could not be found on this page.');
    }

    L.info('Selecting model: ' + model.label);
    realClick(trigger);
    await sleep(T.menuOpenMs || 700);

    // Exclude the other models' aliases so "Nano Banana 2" cannot match
    // the "Nano Banana 2 Lite" row (and vice-versa).
    const others = competingAliases(model.id).filter(function (a) {
      return norm(model.label).indexOf(norm(a)) === -1;
    });

    let opt = pickOption((model.aliases || []).concat([model.label]), others);

    if (!opt) {
      /* Flow nests this control: the composer chip opens a settings popover,
       * and the MODEL DROPDOWN INSIDE that popover must be clicked before any
       * model row exists. That inner dropdown is labelled with the CURRENTLY
       * selected model (e.g. "Nano Banana Pro") — not the word "model" — which
       * is why only looking for "model" here used to fail. */
      const allKnown = (CFG.models || []).reduce(function (acc, m) {
        return acc.concat(m.aliases || [], [norm(m.label)]);
      }, []).concat(['model']);

      for (let round = 0; round < 2 && !opt; round++) {
        const scopes = openPopovers();
        let inner = null;

        for (const scope of scopes) {
          const kids = Array.prototype.slice.call(scope.querySelectorAll(
            'button,[role="button"],[role="combobox"],[aria-haspopup]'
          )).filter(function (el) { return isVisible(el) && isEnabled(el) && el !== trigger; });

          for (const el of kids) {
            const n = accName(el);
            if (!n || n.length > 60) continue;
            for (const k of allKnown) {
              if (k && n.indexOf(k) !== -1) { inner = el; break; }
            }
            if (inner) break;
          }
          if (inner) break;
        }

        if (!inner) break;
        L.debug('Opening the nested model dropdown', { name: accName(inner) });
        realClick(inner);
        await sleep(T.menuOpenMs || 700);
        opt = pickOption((model.aliases || []).concat([model.label]), others);
      }
    }

    if (!opt) {
      logModelOptions();
      return unconfirmedModel(model, 'It is not in the list Flow is showing.');
    }

    realClick(opt.el);
    await sleep(T.menuOpenMs || 700);
    await closeMenus();

    if (modelLooksSelected(model)) {
      L.ok('Model confirmed: ' + model.label);
      return { ok: true };
    }

    // Clicked something, but the UI does not show it.
    return unconfirmedModel(model, 'Flow did not show it as selected afterwards.');
  }

  /** Print the model labels Flow is ACTUALLY offering, so the list can be fixed. */
  function logModelOptions() {
    const labels = collectOptions()
      .map(function (o) { return o.text; })
      .filter(function (t) { return t && t.length <= 60; })
      .filter(function (t, i, a) { return a.indexOf(t) === i; })
      .slice(0, 40);
    L.info('Model options Flow is showing right now: ' +
           (labels.length ? labels.join(' | ') : '(no option rows were visible)'));
  }

  /**
   * The model could not be confirmed. Historically this dead-ended the whole
   * run. Flow does not offer the same models on every account/project and
   * renames them without notice, so by default we now carry on with whatever
   * model Flow already has selected — loudly, never silently: a WARN in the log,
   * the real option labels printed above, and the queue row marked so History
   * shows the model was not the requested one. Untick the setting to go back to
   * hard-stopping instead.
   */
  function unconfirmedModel(model, why) {
    const current = currentModelLabel();
    if (R.settings.continueIfModelUnconfirmed === false) {
      return {
        ok: false,
        reason: 'Could not confirm ' + model.label + '. ' + why +
                ' Please select the model manually in Google Flow, or tick ' +
                '"keep the model Flow already has" in Settings.'
      };
    }
    L.warn('Could not confirm ' + model.label + '. ' + why +
           ' Continuing with the model Flow currently has selected' +
           (current ? ' ("' + current + '")' : '') +
           '. Untick "keep the model Flow already has" in Settings to stop instead.');
    return { ok: true, unconfirmed: true, actualModel: current || 'Flow default' };
  }

  /** Whatever the composer chip currently displays, if we can read it. */
  function currentModelLabel() {
    const trigger = findModelSelector();
    if (!trigger) return '';
    const n = accName(trigger);
    return (n && n.length <= 60) ? n : '';
  }

  /* ====================================================================== */
  /*  COMPOSER SETTINGS POPOVER                                             */
  /* ====================================================================== */
  /* Flow keeps the Image/Video toggle, the aspect-ratio buttons, the output
   * count and the model dropdown inside a settings popover that is CLOSED
   * until the model chip beside the send arrow is clicked. Probing for those
   * controls while it is closed is exactly why they "could not be found". */
  async function openComposerSettings() {
    if (openPopovers().length) return true;

    const known = (CFG.models || []).reduce(function (acc, m) {
      return acc.concat(m.aliases || [], [norm(m.label)]);
    }, []);

    const cands = queryAllVisible(['button', '[role="button"]', '[aria-haspopup]', '[role="combobox"]'])
      .filter(isEnabled);

    let chip = null;
    for (const c of cands) {
      const n = accName(c);
      if (!n || n.length > 60) continue;
      for (const k of known) {
        if (k && n.indexOf(k) !== -1) { chip = c; break; }
      }
      if (chip) break;
    }

    // Secondary: the "x1 / x2" output-count chip lives in the same control.
    if (!chip) {
      chip = cands.filter(function (c) { return /^x[1-9]$/.test(accName(c).trim()); })[0] || null;
    }

    if (!chip) { L.debug('No composer settings chip found'); return false; }

    L.debug('Opening the composer settings popover', { name: accName(chip) });
    realClick(chip);
    await sleep(T.menuOpenMs || 700);

    const opened = openPopovers().length > 0;
    if (!opened) L.debug('Clicking the composer chip did not open a popover');
    return opened;
  }

  /* ====================================================================== */
  /*  OUTPUT TYPE (must be IMAGE, never video)                              */
  /* ====================================================================== */
  async function ensureImageMode() {
    const found = findImageGenerationMode();
    if (!found) {
      L.warn('Could not find the Image/Video control — continuing, but verify Flow is set to Image.');
      return { ok: true, unverified: true };
    }
    if (found.current === 'image') {
      L.debug('Output type already Image ("' + found.label + '")');
      return { ok: true, already: true };
    }

    L.info('Output type is set to video ("' + found.label + '") — switching to Image.');
    realClick(found.el);
    await sleep(T.menuOpenMs || 700);

    const opt = pickOption(S.imageModeText || ['image'], S.videoModeText || ['video']);
    if (!opt) {
      await closeMenus();
      return { ok: false, reason: 'Flow is set to video output and the Image option could not be found. Please switch it to Image manually.' };
    }
    realClick(opt.el);
    await sleep(T.menuOpenMs || 700);
    await closeMenus();

    const after = findImageGenerationMode();
    if (after && after.current === 'video') {
      return { ok: false, reason: 'Flow is still set to video output. Please switch it to Image manually.' };
    }
    L.ok('Output type set to Image.');
    return { ok: true };
  }

  /* ====================================================================== */
  /*  ASPECT RATIO (best-effort — never blocks a run)                        */
  /* ====================================================================== */
  async function ensureAspectRatio(ratioId) {
    const ratio = (CFG.aspectRatios || []).filter(function (a) { return a.id === ratioId; })[0];
    if (!ratio) return { ok: true, skipped: true };

    const cands = queryAllVisible(['button', '[role="button"]', '[role="combobox"]', '[aria-haspopup]']).filter(isEnabled);

    /* The ratio buttons are often already visible inside the open composer
     * popover, in which case there is nothing to "open" — just click 16:9. */
    const wanted = (ratio.aliases || [ratio.id]).map(norm).filter(Boolean);
    const direct = queryAllVisible(['button', '[role="button"]', '[role="radio"]',
                                    '[role="option"]', '[role="menuitemradio"]', '[role="tab"]'])
      .filter(isEnabled)
      .filter(function (el) {
        const n = norm(accName(el));
        return n && n.length <= 24 && wanted.indexOf(n) !== -1;
      })[0];
    if (direct) {
      L.debug('Aspect ratio button found directly', { name: accName(direct) });
      realClick(direct);
      await sleep(T.clickSettleMs || 350);
      L.info('Aspect ratio set to ' + ratio.label);
      return { ok: true };
    }

    /* Never mistake the model chip for the ratio control — the generic
     * aria-haspopup fallbacks below match it too. */
    const modelWords = (CFG.models || []).reduce(function (acc, m) {
      return acc.concat(m.aliases || [], [norm(m.label)]);
    }, []).filter(Boolean);
    const looksLikeModel = function (n) {
      for (const w of modelWords) { if (n.indexOf(w) !== -1) return true; }
      return false;
    };

    let trigger = null;
    for (const c of cands) {
      const n = accName(c);
      if (!n || n.length > 40 || looksLikeModel(n)) continue;
      if (/\d\s*:\s*\d/.test(n) || n.indexOf('aspect') !== -1 || n.indexOf('ratio') !== -1) { trigger = c; break; }
    }
    if (!trigger) {
      trigger = queryAllVisible(S.aspectSelector || []).filter(isEnabled)
        .filter(function (c) { return !looksLikeModel(accName(c)); })[0] || null;
    }
    if (!trigger) { L.debug('No aspect-ratio control found — leaving Flow default.'); return { ok: true, skipped: true }; }

    if (accName(trigger).indexOf(norm(ratio.id)) !== -1) {
      L.debug('Aspect ratio already ' + ratio.label);
      return { ok: true, already: true };
    }

    realClick(trigger);
    await sleep(T.menuOpenMs || 700);
    const opt = pickOption(ratio.aliases || [ratio.id]);
    if (opt) {
      realClick(opt.el);
      await sleep(T.clickSettleMs || 350);
      L.info('Aspect ratio set to ' + ratio.label);
    } else {
      L.warn('Could not set aspect ratio ' + ratio.label + ' — leaving Flow default.');
    }
    await closeMenus();
    return { ok: true };
  }

  /* ====================================================================== */
  /*  REFERENCE IMAGE (image-to-image) — attached ONCE per run               */
  /* ====================================================================== */
  function base64ToFile(ref) {
    const b64 = ref.base64.indexOf(',') !== -1 ? ref.base64.slice(ref.base64.indexOf(',') + 1) : ref.base64;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], ref.name || 'reference.png', { type: ref.mime || 'image/png' });
  }

  function setFileOnInput(input, file) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      L.debug('DataTransfer assignment failed: ' + e.message);
      return false;
    }
  }

  /**
   * Flow's asset picker does NOT attach on upload. It uploads the file, shows
   * the asset library with the new asset selected, and then WAITS for an
   * explicit confirm click ("Add to Prompt"). Skipping that click leaves the
   * modal open — and an open modal swallows the Enter key, which is exactly why
   * the prompt was typed but "Flow did not appear to start generating".
   */
  function pickerConfirmButton() {
    const words = (S.attachConfirmText && S.attachConfirmText.length)
      ? S.attachConfirmText
      : ['add to prompt', 'add selected', 'insert', 'done', 'use', 'add'];
    let best = null, bestScore = -1, bestDisabled = null;
    for (const d of openPopovers()) {
      const btns = Array.prototype.slice.call(d.querySelectorAll('button,[role="button"]'))
        .filter(isVisible);
      for (const el of btns) {
        const n = norm(accName(el));
        if (!n || n.length > 40) continue;
        for (let w = 0; w < words.length; w++) {
          const want = norm(words[w]);
          if (!want) continue;
          const exact = n === want;
          if (!exact && n.indexOf(want) === -1) continue;
          const score = (words.length - w) * 10 + want.length + (exact ? 100 : 0);
          if (!isEnabled(el)) { if (!bestDisabled) bestDisabled = el; continue; }
          if (score > bestScore) { bestScore = score; best = el; }
        }
      }
    }
    return { el: best, disabled: bestDisabled };
  }

  /** Click the first asset thumbnail in the picker (needed if nothing is selected). */
  function selectFirstPickerAsset() {
    for (const d of openPopovers()) {
      const imgs = Array.prototype.slice.call(d.querySelectorAll('img')).filter(isVisible);
      for (const img of imgs) {
        const row = img.closest('button,[role="button"],[role="option"],li,[tabindex]');
        if (row && isVisible(row)) { realClick(row); return true; }
      }
    }
    return false;
  }

  async function confirmAssetPicker() {
    const deadline = Date.now() + (T.attachConfirmMs || 60000);
    let clickedAsset = false;
    while (Date.now() < deadline) {
      if (R.stopRequested) return false;
      if (!openPopovers().length) return true;              // already attached
      const found = pickerConfirmButton();
      if (found.el) {
        L.debug('Confirming the asset picker', { button: accName(found.el) });
        realClick(found.el);
        await sleep(T.clickSettleMs || 350);
        if (!openPopovers().length) return true;
      } else if (found.disabled && !clickedAsset) {
        // The confirm button is disabled because no asset is selected yet.
        clickedAsset = selectFirstPickerAsset();
        if (clickedAsset) L.debug('Selected the uploaded asset in the picker.');
      }
      await sleep(700);   // the upload itself can take 15-20 s
    }
    return openPopovers().length === 0;
  }

  /**
   * Attach the single reference image. Called once; `R.refAttached` then keeps
   * it out of the per-prompt path so it is never re-uploaded.
   */
  async function attachReferenceImage() {
    if (!R.refImage) return { ok: false, reason: 'Reference image is missing.' };
    if (R.refAttached) return { ok: true, already: true };

    const file = base64ToFile(R.refImage);

    // Preferred path: an existing file input (Flow keeps hidden ones mounted).
    let inputs = [];
    for (const sel of (S.fileInput || [])) {
      try { inputs = inputs.concat(Array.prototype.slice.call(document.querySelectorAll(sel))); } catch (e) {}
    }
    inputs = inputs.filter(function (v, i, a) { return a.indexOf(v) === i; });

    // If nothing is mounted yet, open the add-media UI to mount one.
    if (!inputs.length) {
      const btn = findAddMediaButton();
      if (!btn) {
        return { ok: false, reason: 'Could not find the "Add media" control in Google Flow, so the reference image could not be attached.' };
      }
      L.info('Opening the add-media control to attach the reference image.');
      realClick(btn);
      await sleep(T.menuOpenMs || 700);

      // The picker itself may be behind a menu entry (e.g. "Upload").
      const upload = collectOptions().filter(function (o) {
        return /upload|from computer|choose file|browse|my device/.test(o.text);
      })[0];
      if (upload) { realClick(upload.el); await sleep(T.clickSettleMs || 350); }

      inputs = [];
      for (const sel of (S.fileInput || [])) {
        try { inputs = inputs.concat(Array.prototype.slice.call(document.querySelectorAll(sel))); } catch (e) {}
      }
      inputs = inputs.filter(function (v, i, a) { return a.indexOf(v) === i; });
    }

    if (!inputs.length) {
      return { ok: false, reason: 'Google Flow did not expose a file input, so the reference image could not be attached. Please add it manually, then press Resume.' };
    }

    // Prefer an input that explicitly accepts images.
    inputs.sort(function (a, b) {
      const sa = /image/i.test(a.accept || '') ? 1 : 0;
      const sb = /image/i.test(b.accept || '') ? 1 : 0;
      return sb - sa;
    });

    let placed = false;
    for (const input of inputs) {
      if (setFileOnInput(input, file)) { placed = true; break; }
    }
    if (!placed) {
      return { ok: false, reason: 'The reference image could not be handed to Google Flow. Please add it manually, then press Resume.' };
    }

    await sleep(T.attachSettleMs || 1800);

    /* Flow uploaded the bytes but has NOT attached them yet — confirm the
     * picker, and mark the previews before it closes so the reference can never
     * be mistaken for generated output later. */
    markReferencePreviews();
    const confirmed = await confirmAssetPicker();
    markReferencePreviews();
    if (!confirmed) {
      return { ok: false, reason: 'Google Flow\'s asset picker stayed open after the reference image was uploaded. Click "Add to Prompt" in Flow, then press Resume.' };
    }

    R.refAttached = true;
    L.ok('Reference image attached once for the whole run: ' + (R.refImage.name || 'reference'));
    return { ok: true };
  }

  function markReferencePreviews() {
    const imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
    for (const img of imgs) {
      const src = img.currentSrc || img.src || '';
      if (src.indexOf('blob:') === 0 || src.indexOf('data:image') === 0) {
        img.setAttribute('data-autoprompt-ref', '1');
      }
    }
  }

  /* ====================================================================== */
  /*  SLATE-SAFE EDITOR CONTROL                                             */
  /* ====================================================================== */
  /* NOTE: document.execCommand is never used anywhere in this file. It is what
   * crashed Slate in earlier versions ("Cannot resolve a Slate node from DOM
   * node"). Everything below works through real text nodes + beforeinput. */

  function firstTextNode(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    return w.nextNode();
  }

  function lastTextNode(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let last = null, n;
    while ((n = w.nextNode())) last = n;
    return last;
  }

  /** Put a collapsed caret at the end of the editor, inside a real text node. */
  function placeCaretAtEnd(editor) {
    editor.focus();
    const sel = window.getSelection();
    if (!sel) return false;
    const range = document.createRange();
    const tn = lastTextNode(editor);
    if (tn) {
      range.setStart(tn, tn.nodeValue.length);
      range.collapse(true);
    } else {
      range.selectNodeContents(editor);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    return true;
  }

  function editorText(editor) {
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') return editor.value || '';
    return editor.innerText || editor.textContent || '';
  }

  /** True when the editor holds only its placeholder / nothing at all. */
  function editorIsEmpty(editor) {
    const t = norm(editorText(editor));
    if (!t) return true;
    for (const p of (S.editorPlaceholders || [])) if (t === p || t.indexOf(p) === 0) return true;
    return false;
  }

  function fireInput(el, inputType, data) {
    const ok = el.dispatchEvent(new InputEvent('beforeinput', {
      inputType: inputType, data: data === undefined ? null : data,
      bubbles: true, cancelable: true, composed: true
    }));
    if (!ok) return false;
    el.dispatchEvent(new InputEvent('input', {
      inputType: inputType, data: data === undefined ? null : data,
      bubbles: true, composed: true
    }));
    return true;
  }

  /** Clear the editor without execCommand. */
  async function clearEditor(editor) {
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      editor.focus();
      editor.value = '';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }

    for (let round = 0; round < 3; round++) {
      if (editorIsEmpty(editor)) return true;

      editor.focus();
      const sel = window.getSelection();
      const start = firstTextNode(editor);
      const end = lastTextNode(editor);
      if (sel && start && end) {
        const r = document.createRange();
        r.setStart(start, 0);
        r.setEnd(end, end.nodeValue.length);
        sel.removeAllRanges();
        sel.addRange(r);
        fireInput(editor, 'deleteContentBackward');
        await sleep(T.afterClearMs || 400);
        if (editorIsEmpty(editor)) return true;
      }

      // Fall back to repeated single-character backspaces.
      placeCaretAtEnd(editor);
      const budget = Math.min(4000, editorText(editor).length + 16);
      for (let i = 0; i < budget; i++) {
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8, bubbles: true, cancelable: true
        }));
        fireInput(editor, 'deleteContentBackward');
        if (i % 40 === 0) await sleep(0);
        if (editorIsEmpty(editor)) break;
      }
      await sleep(T.afterClearMs || 400);
    }
    return editorIsEmpty(editor);
  }

  /**
   * Put text into the editor with a REAL paste event.
   *
   * Slate handles `paste` by reading clipboardData and running a model-level
   * Transforms.insertText, so the text lands in Slate's INTERNAL value. A
   * synthetic beforeinput/insertText can update the visible DOM while leaving
   * that model empty — which is why a perfectly visible prompt could be
   * "sent" and Flow's handler silently found nothing to do.
   */
  function pasteText(editor, text) {
    let dt;
    try {
      dt = new DataTransfer();
      dt.setData('text/plain', String(text));
    } catch (e) { L.debug('DataTransfer unavailable: ' + e.message); return false; }

    editor.focus();
    placeCaretAtEnd(editor);

    let delivered = false;
    try {
      editor.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true, composed: true
      }));
      delivered = true;
    } catch (e) { L.debug('ClipboardEvent paste failed: ' + e.message); }

    // Slate 0.90+ reads the DataTransfer off beforeinput instead of the
    // clipboard event, so send both.
    try {
      editor.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertFromPaste', dataTransfer: dt,
        bubbles: true, cancelable: true, composed: true
      }));
      editor.dispatchEvent(new InputEvent('input', {
        inputType: 'insertFromPaste', bubbles: true, composed: true
      }));
      delivered = true;
    } catch (e) {}

    return delivered;
  }

  /* Read Flow's OWN state instead of the DOM. slate-react passes the editor
   * instance as a prop to <Slate>, so it is reachable by walking the React fiber
   * up from the editable node. Flow's Create handler reads that model (via its
   * zustand store) — never the DOM — so an empty model with visible text explains
   * a click that does nothing and sends no request. */
  function reactFiber(node) {
    for (const k in node) {
      if (k.indexOf('__reactFiber$') === 0 || k.indexOf('__reactInternalInstance$') === 0) return node[k];
    }
    return null;
  }

  function findSlateEditor(editorEl) {
    let f = reactFiber(editorEl), guard = 0;
    while (f && guard++ < 60) {
      const p = f.memoizedProps;
      if (p && p.editor && Array.isArray(p.editor.children) && typeof p.editor.onChange === 'function') return p.editor;
      f = f.return;
    }
    return null;
  }

  function slateModelText(editorEl) {
    const ed = findSlateEditor(editorEl);
    if (!ed) return null;
    const walk = function (nodes) {
      let out = '';
      for (const n of nodes || []) {
        if (typeof n.text === 'string') out += n.text;
        else if (n.children) out += walk(n.children) + '\n';
      }
      return out;
    };
    return walk(ed.children);
  }

  /** Write the prompt into Slate's model and fire its onChange, so Flow's store updates. */
  function insertViaSlate(editorEl, text) {
    const ed = findSlateEditor(editorEl);
    if (!ed) { L.warn('Slate editor instance is not reachable via the React fiber.'); return false; }
    try {
      const blockType = (ed.children[0] && ed.children[0].type) || 'paragraph';
      const paras = String(text).split('\n').map(function (line) {
        return { type: blockType, children: [{ text: line }] };
      });
      const last = paras.length - 1;
      const end = paras[last].children[0].text.length;
      ed.children = paras;
      ed.selection = { anchor: { path: [last, 0], offset: end }, focus: { path: [last, 0], offset: end } };
      ed.onChange();
      L.info('Prompt written directly into Slate\'s model (' + paras.length + ' block(s)).');
      return true;
    } catch (e) { L.warn('Direct Slate insert failed: ' + e.message); return false; }
  }

  /**
   * Type the prompt EXACTLY as given.
   * Lines are inserted with insertText and separated with insertLineBreak, so a
   * multi-line prompt never submits itself half-way through.
   */
  async function typePrompt(editor, text) {
    if (editor.tagName === 'TEXTAREA' || editor.tagName === 'INPUT') {
      editor.focus();
      editor.value = text;
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(T.afterTypeMs || 400);
      return editorText(editor).indexOf(text.slice(0, 40)) !== -1;
    }

    editor.focus();
    await sleep(T.focusMs || 300);
    placeCaretAtEnd(editor);

    /* Preferred path: a real paste, because it is the only method that reliably
     * reaches Slate's internal model rather than just the visible DOM. */
    if (pasteText(editor, text)) {
      await sleep(T.afterTypeMs || 400);
      const model = slateModelText(editor);
      if (model !== null) {
        L.debug('Slate model holds ' + model.length + ' chars; the DOM shows ' +
                editorText(editor).length + '.');
      }
      if (textMatches(editor, text) && (model === null || norm(model).indexOf(norm(text).slice(0, 40)) !== -1)) {
        L.info('Prompt inserted with a paste event and confirmed in Slate\'s model.');
        return true;
      }
      L.warn('The prompt is visible but NOT in Slate\'s model — that is why Create does nothing. ' +
             'Writing it into the model directly.');
      if (insertViaSlate(editor, text)) {
        await sleep(T.afterTypeMs || 400);
        return true;
      }
      L.debug('Paste did not take — falling back to synthetic typing.');
      await clearEditor(editor);
      placeCaretAtEnd(editor);
    }

    const lines = String(text).split('\n');
    let blockAccepted = true;

    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          shiftKey: true, bubbles: true, cancelable: true
        }));
        if (!fireInput(editor, 'insertLineBreak')) blockAccepted = false;
      }
      if (lines[i].length) {
        if (!fireInput(editor, 'insertText', lines[i])) blockAccepted = false;
      }
      await sleep(20);
    }

    await sleep(T.afterTypeMs || 400);

    if (blockAccepted && textMatches(editor, text)) return true;

    // Fallback: v13's proven per-character path.
    L.debug('Block insert did not take — falling back to per-character typing.');
    await clearEditor(editor);
    placeCaretAtEnd(editor);
    await typePerChar(editor, text);
    await sleep(T.afterTypeMs || 400);
    return textMatches(editor, text);
  }

  async function typePerChar(editor, text) {
    for (const ch of String(text)) {
      if (ch === '\n') {
        editor.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
          shiftKey: true, bubbles: true, cancelable: true
        }));
        fireInput(editor, 'insertLineBreak');
      } else {
        editor.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
        fireInput(editor, 'insertText', ch);
        editor.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      }
      await sleep(T.typeCharMs || 12);
    }
  }

  /**
   * VERIFY the editor really contains the prompt before we submit.
   * Whitespace is collapsed for the comparison only; the text that was inserted
   * is byte-for-byte what the user supplied.
   */
  function textMatches(editor, expected) {
    const got = norm(editorText(editor));
    const want = norm(expected);
    if (!want) return false;
    if (got === want) return true;
    if (got.indexOf(want) !== -1) return true;
    // Long prompts can be visually truncated by the editor; compare the ends.
    if (want.length > 120) {
      return got.indexOf(want.slice(0, 60)) !== -1 && got.indexOf(want.slice(-40)) !== -1;
    }
    return false;
  }

  /* ====================================================================== */
  /*  SUBMIT                                                                */
  /* ====================================================================== */
  /* v14.1 — THE IMPORTANT CHANGE.
   *
   * In Flow's current composer the Enter key inserts a NEWLINE; it does not
   * submit. That is why every earlier build typed the prompt perfectly and then
   * reported "Google Flow did not appear to start generating" forever. The real
   * control is the round arrow at the bottom-right of the composer. It is
   * icon-only, so it cannot be found by label.
   *
   * It CAN be found by behaviour: while the editor is empty the arrow is
   * disabled, and it becomes enabled the moment prompt text lands. Nothing else
   * in the composer does that. So we snapshot every composer button's
   * enabled/disabled state BEFORE typing, compare AFTER typing, and score the
   * candidates in utils/composer.js (which is unit tested).
   *
   * Submission is then attempted in order — arrow, Cmd/Ctrl+Enter, Enter,
   * runner-up arrow, legacy generate button — and each attempt is verified
   * before the next is tried, so nothing is ever submitted twice.            */

  /** The composer: the nearest ancestor of the editor that holds its toolbar. */
  function composerRoot(editor) {
    let el = editor;
    for (let i = 0; i < 10 && el && el.parentElement; i++) {
      el = el.parentElement;
      let n = 0;
      try { n = el.querySelectorAll('button,[role="button"]').length; } catch (e) { n = 0; }
      if (n >= 2) return el;
    }
    return (editor && editor.parentElement) || document.body;
  }

  function composerButtons(editor) {
    const root = composerRoot(editor);
    let nodes = [];
    try { nodes = Array.prototype.slice.call(root.querySelectorAll('button,[role="button"]')); } catch (e) {}
    return nodes.filter(isVisible);
  }

  /** Enabled/disabled state of every composer button, keyed by element. */
  function snapshotComposerButtons(editor) {
    const map = new Map();
    for (const b of composerButtons(editor)) map.set(b, isEnabled(b));
    L.debug('Composer button states snapshotted with an empty editor', { buttons: map.size });
    return map;
  }

  function buttonDescriptors(editor, before) {
    const btns = composerButtons(editor);
    return btns.map(function (b, i) {
      const r = b.getBoundingClientRect();
      return {
        ref: b,
        index: i,
        name: accName(b),
        enabledNow: isEnabled(b),
        enabledBefore: (before && before.has(b)) ? before.get(b) : null,
        right: r.right, bottom: r.bottom, width: r.width, height: r.height
      };
    });
  }

  /** Ranked submit candidates, best first. */
  /* Look in every place the UMD module publishes itself. In 14.1 this only
   * checked self.APComposer, and background.js was injecting the wrong file
   * list, so the module was genuinely absent and the fallback below ran. */
  function getScorer() {
    if (typeof self !== 'undefined' && self.APComposer) return self.APComposer;
    if (typeof globalThis !== 'undefined' && globalThis.APComposer) return globalThis.APComposer;
    if (typeof APComposer !== 'undefined' && APComposer) return APComposer;
    return null;
  }

  /* Names that must NEVER be clicked in the hope that they submit. Flow's
   * "close clear prompt" is the X that empties the composer: clicking it looks
   * exactly like a successful submit, which is how 14.1 reported
   * "Prompt 001 submitted" while generating nothing. This list is the last line
   * of defence for the case where utils/composer.js is missing entirely. */
  const NEVER_CLICK_RE = /(^|\b|_)(add|add_2|plus|close|clear|dismiss|cancel|delete|delete_forever|remove|trash|back|arrow_back|more|more_vert|help|search|filter|filter_list|sort|agent|nano|banana|crop|undo|redo|reuse)(\b|_|$)/;

  function submitCandidates(editor, before) {
    const scorer = getScorer();
    const descriptors = buttonDescriptors(editor, before);
    if (!scorer) {
      /* Safe degraded mode: prefer a button that flipped from disabled to
       * enabled and whose name is not on the deny list. Never "the last
       * button", which is what used to hit the clear-prompt X. */
      L.warn('utils/composer.js did not load, so submit detection is running in a reduced, ' +
             'name-filtered mode. Reload the Flow tab; if this persists the extension package is incomplete.');
      const safe = descriptors.filter(function (d) {
        return d.enabledNow && !NEVER_CLICK_RE.test(String(d.name || '').toLowerCase());
      });
      const flipped = safe.filter(function (d) { return d.enabledBefore === false; });
      const pick = flipped.length ? flipped[flipped.length - 1] : (safe.length ? safe[safe.length - 1] : null);
      if (!pick) {
        L.warn('No safe submit candidate remained — keyboard methods only.');
        return [];
      }
      return [{ ref: pick.ref, name: pick.name, score: 0 }];
    }
    const ranked = scorer.rankSubmitCandidates(descriptors);
    L.debug('Submit candidates ranked', {
      total: descriptors.length,
      top: ranked.slice(0, 3).map(function (c) { return (c.name || '(icon)') + ':' + c.score; }).join(', ')
    });
    return ranked;
  }

  function pressEnter(editor, withModifier) {
    /* Slate ignores a key event when the selection is not inside the editor, and
     * clicking any control moves the selection out of it. Restore the caret
     * before every keyboard attempt. */
    editor.focus();
    placeCaretAtEnd(editor);
    const ev = {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true, composed: true,
      metaKey: !!withModifier, ctrlKey: !!withModifier
    };
    editor.dispatchEvent(new KeyboardEvent('keydown', ev));
    editor.dispatchEvent(new KeyboardEvent('keypress', ev));
    editor.dispatchEvent(new KeyboardEvent('keyup', Object.assign({}, ev, { cancelable: false })));
  }

  function countImages() {
    try { return document.querySelectorAll('img').length; } catch (e) { return 0; }
  }

  /* Does the click reach Flow's code at all? A content script shares the page's
   * performance timeline, so every fetch/XHR Flow makes is visible here. This is
   * the one signal that separates "our click never reached the handler" from
   * "Flow was asked to generate and refused".
   * Only real generation endpoints count: `trpc` alone matched
   * general.fetchUserAcknowledgements and reported a submit that never happened. */
  const GEN_URL_RE = /(:generate|generateimage|generatevideo|generatemedia|media\.(generate|create)|project\.(create|add)media|imagen|\bveo\b|text2image)/i;
  const HOUSEKEEPING_URL_RE = /(auth\/session|acknowledg|credits|feature|flag|config|experiment|telemetry|metric|\blog\b|user\.get|\bsession\b)/i;

  function flowRequestsSince(mark) {
    let out = [];
    try {
      out = performance.getEntriesByType('resource').filter(function (e) {
        return e.startTime >= mark &&
               (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest');
      });
    } catch (e) {}
    return out.map(function (e) {
      /* responseStatus turns "Flow called something" into "Flow called it and got
       * a 403", which is the difference between out-of-credits and anti-bot. */
      const status = (typeof e.responseStatus === 'number' && e.responseStatus) ? e.responseStatus : '?';
      return String(e.name).split('?')[0] + ' [' + status + ']';
    });
  }

  /**
   * STRONG evidence that Flow really accepted the prompt. Any one of these is
   * enough on its own, because none of them can be produced by simply clearing
   * the composer.
   */
  function strongStartSignal(ctx) {
    if (queryAllVisible(S.progressIndicator || []).length) return 'progress indicator';
    if (ctx && typeof ctx.imgCount === 'number' && countImages() > ctx.imgCount) return 'new image tile';
    if (ctx && ctx.sendEl && !isEnabled(ctx.sendEl)) return 'send control disabled again';

    /* Flow calling its own backend is proof the click landed on a live handler.
     * Reported even when it is not a generation call, because "Flow made 4 calls
     * and none of them was a generation" is a completely different diagnosis
     * from "Flow made no calls at all". */
    if (ctx && typeof ctx.netMark === 'number') {
      const calls = flowRequestsSince(ctx.netMark);
      if (calls.length && !ctx.netReported) {
        ctx.netReported = true;
        L.info('Flow made ' + calls.length + ' network call(s) after this attempt: ' +
               calls.map(function (u) { return u.slice(-70); }).join(' , '));
      }
      for (const u of calls) {
        if (HOUSEKEEPING_URL_RE.test(u)) continue;
        if (GEN_URL_RE.test(u)) return 'Flow sent a generation request (' + u.slice(-70) + ')';
      }
    }
    return null;
  }

  /**
   * WEAK evidence: the editor going empty. Flow does clear the composer when it
   * accepts a prompt — but so does Flow's own "close clear prompt" X, and in
   * 14.1 that made a mis-click look like a successful submit and reported
   * "Prompt 001 submitted" while nothing generated. So an empty editor is only
   * believed once a strong signal corroborates it.
   */
  function weakStartSignal(editor, promptText) {
    if (editorIsEmpty(editor)) return 'editor cleared';
    if (!textMatches(editor, promptText)) return 'editor text changed';
    return null;
  }

  /**
   * Wait for evidence that a generation began. Returns the reason string, or
   * null if nothing convincing happened. A weak signal alone extends the wait
   * (up to `corroborateMs`) looking for corroboration rather than returning.
   */
  async function waitForStart(editor, promptText, ctx, ms) {
    const deadline = Date.now() + (ms || 6000);
    let weakSeenAt = 0;
    let weakWhy = null;
    const corroborate = T.corroborateStartMs || 12000;

    while (true) {
      if (R.stopRequested) return 'stopped';

      const strong = strongStartSignal(ctx);
      if (strong) {
        return weakWhy ? (strong + ' (after the ' + weakWhy + ')') : strong;
      }

      if (!weakSeenAt) {
        const weak = weakStartSignal(editor, promptText);
        if (weak) {
          weakWhy = weak;
          weakSeenAt = Date.now();
          L.debug('Weak start signal (' + weak + ') — waiting for corroboration before believing it.');
        }
      }

      const limit = weakSeenAt ? Math.max(deadline, weakSeenAt + corroborate) : deadline;
      if (Date.now() >= limit) break;
      await sleep(300);
    }

    if (weakWhy) {
      L.warn('The composer ' + weakWhy + ' but nothing started generating. That is what clicking ' +
             'Flow\'s clear-prompt X looks like, so this is NOT being counted as a submit.');
    }
    return null;
  }

  /* Flow calls general.fetchUserAcknowledgements when Create is pressed and, if
   * something is unacknowledged, opens a notice instead of generating. Our
   * Escape/blocker cleanup was closing that notice, so the click was consumed and
   * nothing ever generated. Accept it instead of dismissing it. */
  const CONSENT_WORDS = ['i understand', 'got it', 'i agree', 'agree', 'accept', 'acknowledge',
                         'continue', 'confirm', 'ok', 'okay', 'start'];

  function acknowledgeDialogs() {
    const dialogs = openPopovers();
    if (!dialogs.length) return null;

    for (const d of dialogs) {
      const btns = Array.prototype.slice.call(d.querySelectorAll('button,[role="button"]'))
        .filter(function (b) { return isVisible(b) && isEnabled(b); });

      let best = null, bestScore = -1;
      for (const b of btns) {
        const n = accName(b);
        if (!n || n.length > 40 || NEVER_CLICK_RE.test(n)) continue;
        for (let i = 0; i < CONSENT_WORDS.length; i++) {
          const w = CONSENT_WORDS[i];
          if (n === w || n.indexOf(w) !== -1) {
            const score = (CONSENT_WORDS.length - i) * 10 + (n === w ? 50 : 0);
            if (score > bestScore) { bestScore = score; best = b; }
          }
        }
      }

      if (best) {
        L.info('Google Flow asked for a confirmation before generating — accepting "' +
               accName(best) + '".');
        realClick(best);
        return accName(best);
      }
      L.warn('Google Flow opened a dialog after the submit that I do not recognise, so it was ' +
             'left alone. Its buttons are: ' + btns.map(accName).join(' | ') +
             '. Accept it once by hand and the run will continue.');
    }
    return null;
  }

  /* Flow may answer a click with a notice (out of credits, an acknowledgement, an
   * upgrade prompt) rather than a generation. Earlier builds pressed Escape and
   * cleared it away, so the message was never seen. Read it verbatim. */
  function reportNewDialogs(where) {
    const dialogs = openPopovers();
    if (!dialogs.length) return null;
    for (const d of dialogs) {
      const text = norm(d.innerText || d.textContent).slice(0, 400);
      if (!text) continue;
      const btns = Array.prototype.slice.call(d.querySelectorAll('button,[role="button"]'))
        .filter(isVisible).map(accName).filter(Boolean);
      L.warn('Google Flow opened a dialog after ' + where + '. It says: "' + text +
             '" — buttons: ' + (btns.join(' | ') || '(none)') + '.');
      return text;
    }
    return null;
  }

  /* Where did the debugger click actually land, and which events arrived? CDP works
   * in top-frame CSS pixels and ignores page zoom, so the pointer can miss while
   * still producing real events — and mousedown alone is NOT a click. Only a
   * trusted listener can tell us either way. */
  function watchTrustedClick(expected, opts) {
    const seen = [];
    const mouse = !(opts && opts.keyboard);
    const types = mouse ? ['mousedown', 'mouseup', 'click', 'pointerdown'] : ['keydown', 'keyup'];
    function onAny(e) {
      if (!e.isTrusted) return;
      let where = '(nothing)';
      try {
        const t = e.target;
        where = t ? (t.tagName + (accName(t) ? ' "' + accName(t).slice(0, 60) + '"' : '')) : '(nothing)';
        if (mouse) {
          where += (expected && t && (t === expected || expected.contains(t)))
            ? ' — THIS IS THE SEND ARROW'
            : ' — NOT the send arrow';
        }
      } catch (err) {}
      const at = mouse ? (' at ' + Math.round(e.clientX) + ',' + Math.round(e.clientY)) : (' ' + e.key);
      seen.push(e.type + at + ' hit ' + where);
    }
    types.forEach(function (t) { document.addEventListener(t, onAny, true); });
    return function stop() {
      types.forEach(function (t) { document.removeEventListener(t, onAny, true); });
      if (!seen.length) {
        L.warn('No trusted ' + (mouse ? 'mouse input' : 'key press') +
               ' ever arrived — the debugger event never reached the page at all.');
      } else {
        L.info('Trusted events: ' + seen.join(' ; '));
      }
    };
  }

  /** Centre of a control in top-frame CSS pixels, or null if it is not clickable. */
  function centreOf(el, what) {
    try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) {}
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) {
      L.warn('The send arrow has no size — skipping the ' + what + '.');
      return null;
    }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  async function submitPrompt(editor, promptText, beforeStates) {
    setState(STATES.SUBMITTING);

    /* Any dialog or popover still on screen steals both the click and the key
     * events, so clear it first. */
    clearUiBlockers('submit');
    if (openPopovers().length) {
      L.warn('A Google Flow dialog was still open at submit time — closing it first.');
      const found = pickerConfirmButton();
      if (found.el) { realClick(found.el); await sleep(T.clickSettleMs || 350); }
      await closeMenus();
      editor.focus();
    }

    const cands = submitCandidates(editor, beforeStates);
    const imgCount = countImages();
    const attempts = [];
    const quick = T.submitRetryVerifyMs || 10000;

    if (cands[0]) {
      const arrow = cands[0].ref;
      const label = cands[0].name || 'icon-only';

      /* 0. THE REAL FIX. Flow's Create button requires a reCAPTCHA token, which is
       * only issued for a genuine user gesture — so every isTrusted:false event was
       * ignored without so much as a network call. This routes the click through
       * chrome.debugger in the service worker, which is real browser-level input.
       * Needs DevTools closed on this tab.
       *
       * The worker now moves the pointer along a short human-shaped path and dwells
       * on the button before pressing, because reCAPTCHA Enterprise scores
       * behaviour and a single teleporting mouseMoved scores like a robot. */
      attempts.push({
        how: 'trusted click via chrome.debugger',
        sendEl: arrow,
        verifyMs: T.submitVerifyMs || 25000,
        run: async function () {
          /* Attach the debugger BEFORE measuring the button. Chrome's "started
           * debugging this browser" banner appears on attach and pushes the whole
           * page down — on the very first prompt of a run that moved the composer
           * 75 px between our measurement and the click, so the click landed on the
           * page background instead of the arrow. Attaching first means the banner
           * is already up when the rect is read. */
          const at = await send({ action: 'ATTACH_DEBUGGER' });
          if (at && at.ok && at.fresh) {
            L.debug('Debugger just attached — letting the banner settle before aiming.');
            await sleep(900);
          }
          await sleep(150);
          const c = centreOf(arrow, 'trusted click');
          if (!c) return;
          L.info('Asking for a trusted click at ' + Math.round(c.x) + ',' + Math.round(c.y) + '.');
          const stopWatch = watchTrustedClick(arrow);
          const res = await send({ action: 'TRUSTED_CLICK', x: c.x, y: c.y });
          await sleep(600);
          stopWatch();
          if (!res || !res.ok) L.warn('Trusted click unavailable: ' + ((res && res.error) || 'no reply from the background service.'));
        }
      });

      /* 1. Trusted KEYBOARD input. Enter inserts a newline in Flow's composer, but
       * Cmd/Ctrl+Enter has never been tried as REAL browser input — only as a
       * synthetic KeyboardEvent, which Flow ignores for the same reCAPTCHA reason.
       * Cheap to try and it needs no coordinates, so page zoom cannot spoil it. */
      attempts.push({
        how: 'trusted Cmd/Ctrl+Enter via chrome.debugger',
        sendEl: arrow,
        verifyMs: quick,
        run: async function () {
          editor.focus();
          placeCaretAtEnd(editor);
          const stopWatch = watchTrustedClick(arrow, { keyboard: true });
          const res = await send({ action: 'TRUSTED_KEY', key: 'Enter', modifier: true });
          await sleep(600);
          stopWatch();
          if (!res || !res.ok) L.warn('Trusted key unavailable: ' + ((res && res.error) || 'no reply from the background service.'));
        }
      });

      /* 2. Native activation carrying a real user-activation token. Runtime.evaluate
       * with userGesture:true runs el.click() in the page's own world, so it
       * reaches handlers that plain mouse dispatch may miss. */
      attempts.push({
        how: 'gesture click via chrome.debugger',
        sendEl: arrow,
        verifyMs: quick,
        run: async function () {
          await sleep(150);
          const c = centreOf(arrow, 'gesture click');
          if (!c) return;
          const res = await send({ action: 'GESTURE_CLICK', x: c.x, y: c.y });
          await sleep(400);
          if (!res || !res.ok) L.warn('Gesture click unavailable: ' + ((res && res.error) || 'no reply from the background service.'));
          else L.info('Gesture click reported: ' + (res.detail || 'done'));
        }
      });

      // 3. The scored send control, aimed at whatever node is actually on top.
      attempts.push({
        how: 'send arrow (' + label + ')',
        sendEl: arrow,
        verifyMs: T.submitVerifyMs || 25000,
        run: function () { realClick(arrow); }
      });

      /* 2. Every node inside (and just above) the arrow, innermost first.
       * If Flow's handler is bound to the icon <span>, a nested <button> or the
       * wrapper above, only a direct dispatch on THAT node fires it — React
       * bubbles upward, never downward. This is the attempt that catches a
       * handler sitting anywhere in the control's own subtree. */
      attempts.push({
        how: 'every node inside the send arrow',
        sendEl: arrow,
        verifyMs: quick,
        run: function () {
          const targets = innerClickTargets(arrow);
          L.debug('Sweeping ' + targets.length + ' node(s) in and around the send control.', {
            nodes: targets.map(function (t) { return t.tagName + '.' + String(t.className || '').slice(0, 40); })
          });
          for (const t of targets) realClick(t, { exact: true });
        }
      });

      /* 3. Native activation. el.click() runs the browser's own activation
       * behaviour instead of a synthetic sequence, so it reaches handlers that
       * ignore dispatched pointer events (and submits a <button type=submit>). */
      attempts.push({
        how: 'native click on the send arrow',
        sendEl: arrow,
        verifyMs: quick,
        run: function () {
          try { arrow.click(); } catch (e) { L.warn('Native click threw: ' + e.message); }
          const inner = arrow.querySelector('button,[role="button"],a');
          if (inner) { try { inner.click(); } catch (e) {} }
        }
      });
    }

    attempts.push({ how: 'Cmd/Ctrl+Enter', verifyMs: quick, run: function () { pressEnter(editor, true); } });
    attempts.push({ how: 'Enter', verifyMs: quick, run: function () { pressEnter(editor, false); } });

    /* 4. If the composer lives in a real <form>, ask the form to submit. */
    const form = (editor.closest && editor.closest('form')) || null;
    if (form) {
      attempts.push({
        how: 'submitting the composer form',
        verifyMs: quick,
        run: function () {
          try {
            if (form.requestSubmit) form.requestSubmit();
            else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          } catch (e) { L.warn('Form submit threw: ' + e.message); }
        }
      });
    }

    if (cands[1]) {
      attempts.push({
        how: 'second send candidate (' + (cands[1].name || 'icon-only') + ')',
        sendEl: cands[1].ref,
        verifyMs: quick,
        run: function () { realClick(cands[1].ref); }
      });
    }
    const legacy = findGenerateButton();
    if (legacy && (!cands[0] || legacy !== cands[0].ref)) {
      attempts.push({ how: 'labelled generate button', sendEl: legacy, verifyMs: quick,
                      run: function () { realClick(legacy); } });
    }

    /* Let the composer settle before the first attempt. A human never clicks Create
     * within a millisecond of the last keystroke, and Flow debounces the prompt into
     * its own store — clicking too early can find that store still empty, which
     * looks exactly like a dead button. */
    await sleep(T.preSubmitSettleMs || 1200);

    for (const step of attempts) {
      if (R.stopRequested) return { ok: false, reason: 'stopped' };

      /* A previous attempt may have emptied the editor without submitting (a
       * mis-clicked clear button). Put the prompt back before trying again,
       * otherwise every later method submits nothing. */
      if (editorIsEmpty(editor)) {
        L.debug('The composer was emptied by the previous attempt — retyping the prompt.');
        const again = await typePrompt(editor, promptText);
        if (!again) {
          return { ok: false, reason: 'The prompt could not be retyped after the composer was cleared.' };
        }
      }

      L.info('Submitting via ' + step.how + '.');
      const netMark = performance.now();
      await step.run();
      await sleep(1200);
      acknowledgeDialogs();   // accept a consent notice; never dismiss it
      reportNewDialogs(step.how);
      const why = await waitForStart(editor, promptText,
                                    { imgCount: imgCount, sendEl: step.sendEl, netMark: netMark },
                                    step.verifyMs || T.submitVerifyMs || 25000);
      if (why === 'stopped') return { ok: false, reason: 'stopped' };
      if (why) {
        L.info('Generation started (' + why + ') after ' + step.how + '.');
        return { ok: true, via: step.how };
      }
      L.warn('Nothing started via ' + step.how + ' — trying the next submit method.');
    }

    /* Every method failed. Dump the page state automatically — waiting for the user
     * to remember to switch Debug on and press Diagnose is how whole runs went by
     * without the one piece of evidence that matters. */
    try { diagnose(); } catch (e) { L.warn('Auto-diagnose failed: ' + e.message); }

    return { ok: false, reason: 'Google Flow did not react to any of the ' + attempts.length +
      ' submit methods that were tried (' + attempts.map(function (a) { return a.how; }).join(', ') +
      '). Nothing was submitted twice — this attempt will be retried. A full page ' +
      'diagnosis was just written to the log; export it and send it.' };
  }

  /* ====================================================================== */
  /*  NEW-IMAGE DETECTION                                                   */
  /* ====================================================================== */
  function imageKey(img) {
    return img.currentSrc || img.src || '';
  }

  /** Snapshot taken AFTER the reference is attached and BEFORE submit. */
  function snapshotImages() {
    const set = new Set();
    const imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
    for (const img of imgs) {
      const k = imageKey(img);
      if (k) set.add(k);
    }
    L.debug('Image snapshot taken', { existing: set.size });
    return set;
  }

  function findNewGeneratedImages(before) {
    return findGeneratedImages().filter(function (img) {
      const k = imageKey(img);
      return k && !before.has(k);
    });
  }

  function imageIsReady(img) {
    return !!(img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
  }

  function fingerprint(img) {
    return imageKey(img) + '|' + img.naturalWidth + 'x' + img.naturalHeight;
  }

  /**
   * Wait for `expected` NEW, fully-decoded, stable images.
   * Polling is only the DETECTION mechanism — the advance condition remains
   * "detected AND uploaded", enforced by the caller.
   */
  async function waitForGeneration(before, expected, promptNo) {
    setState(STATES.GENERATING);
    const grace = T.postSubmitGraceMs || 5000;
    const limit = T.generationTimeoutMs || 300000;
    const poll = GI.pollIntervalMs || T.pollIntervalMs || 2000;
    const needStable = GI.stableChecks || 2;

    // An image can never legitimately appear instantly — this grace window
    // stops us grabbing a leftover from the previous prompt.
    await sleep(grace);

    const started = Date.now();
    let lastPrints = '';
    let stable = 0;
    let lastLog = 0;

    while (Date.now() - started < limit) {
      if (R.stopRequested) return { ok: false, reason: 'stopped' };
      if (R.paused) { await waitWhilePaused(); }

      const fail = newFailure();

      if (fail) {
        const normalizedFailure = norm(fail);

        const unusualActivity =
          normalizedFailure.indexOf(
            'unusual activity'
          ) !== -1 ||
          normalizedFailure.indexOf(
            'help center'
          ) !== -1;

        return {
          ok: false,
          hard: unusualActivity,
          reason:
            'Generation failed in Google Flow: "' +
            fail +
            '"'
        };
      }

      const found = findNewGeneratedImages(before).filter(imageIsReady);
      const prints = found.map(fingerprint).sort().join(',');

      if (found.length) {
        if (prints === lastPrints) stable++;
        else { stable = 0; lastPrints = prints; }

        // Accept once the set has stopped changing, and either we have every
        // expected output or we have waited long enough for the rest.
        if (stable >= needStable && (found.length >= expected || stable >= needStable + 2)) {
          L.ok('Detected ' + found.length + ' new image' + (found.length === 1 ? '' : 's') + ' for Prompt ' + promptNo);
          return { ok: true, images: found };
        }
      } else {
        stable = 0;
        lastPrints = '';
      }

      if (Date.now() - lastLog > 20000) {
        lastLog = Date.now();
        L.debug('Still generating Prompt ' + promptNo, {
          elapsedSec: Math.round((Date.now() - started) / 1000),
          candidates: found.length,
          pageState: detectGenerationState()
        });
      }
      await sleep(poll);
    }

    return { ok: false, reason: 'Google Flow did not produce an image within ' + Math.round(limit / 1000) + 's.' };
  }

  /* ====================================================================== */
  /*  CAPTURE IMAGE BYTES                                                   */
  /* ====================================================================== */
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('Could not read the generated image data.')); };
      fr.readAsDataURL(blob);
    });
  }

  /**
   * Fetch the image bytes.
   *
   * Flow's finished images live on `flow-content.google` behind a SIGNED CDN URL
   * (`Expires=` + `Signature=`), so they need no cookies at all — and that CDN
   * answers with `Access-Control-Allow-Origin: *`, which the browser refuses to
   * accept for a `credentials: 'include'` request. That is the red CORS error in
   * the console: every image was failing the fast path and quietly falling back to
   * a canvas re-encode. Sending no credentials to a signed URL fixes both the
   * error and the slow path. Only Flow's own origin still gets cookies.
   */
  function fetchWithTimeout(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(function () { ctrl.abort(); }, ms);
    const signed = /[?&](Signature|Expires|KeyName)=/i.test(url) || /flow-content\.google/i.test(url);
    const creds = signed ? 'omit' : 'include';
    return fetch(url, { credentials: creds, signal: ctrl.signal })
      .finally(function () { clearTimeout(timer); });
  }

  /** Same-origin canvas re-encode, used only if fetch is blocked. */
  function canvasCapture(img) {
    try {
      const w = img.naturalWidth, h = img.naturalHeight;
      const min = CFG.generatedImage && CFG.generatedImage.minSize ? CFG.generatedImage.minSize : 128;
      if (!w || !h || w < min || h < min) {
        L.debug('Canvas capture refused: the image has not painted yet (' + w + 'x' + h + ').');
        return null;
      }
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').drawImage(img, 0, 0);
      const dataUrl = c.toDataURL('image/png');
      // A blank/unpainted canvas re-encodes to a tiny PNG. Reject it rather than
      // let it become a "successful" empty upload.
      const bytes = Math.floor((dataUrl.length - (dataUrl.indexOf(',') + 1)) * 3 / 4);
      if (bytes < (T.minImageBytes || 8192)) {
        L.debug('Canvas capture refused: only ' + bytes + ' bytes, the image is blank.');
        return null;
      }
      return { base64: dataUrl, mime: 'image/png', bytes: bytes };
    } catch (e) {
      return null;
    }
  }

  async function captureImage(img) {
    const url = imageKey(img);
    if (!url) throw new Error('The generated image had no source URL.');

    const floor = T.minImageBytes || 8192;

    try {
      const res = await fetchWithTimeout(url, T.fetchImageMs || 120000);
      if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching the generated image.');
      const blob = await res.blob();
      if (!blob.size) throw new Error('The generated image downloaded as 0 bytes.');
      /* v14.1: a real Flow output is never a few hundred bytes. An earlier build
       * fetched a blob: placeholder at 0.0 kB and happily uploaded it as 001.jpg.
       * Treat anything implausibly small as a failure so the prompt is retried
       * instead of "succeeding" with an empty file. */
      if (blob.size < floor) {
        throw new Error('The generated image was only ' + (blob.size / 1024).toFixed(1) +
          ' kB, which is too small to be a real output — Flow was probably still rendering.');
      }
      const base64 = await blobToBase64(blob);
      let mime = blob.type || '';
      if (!mime || mime === 'application/octet-stream') mime = guessMime(url);
      return { base64: base64, mime: mime, sourceUrl: url, bytes: blob.size };
    } catch (e) {
      /* A blob: URL is a local placeholder, not the finished asset. Re-encoding
       * it from the canvas would produce a plausible-looking but wrong file, so
       * that path is deliberately not taken. */
      if (/^blob:/i.test(url)) {
        throw new Error('Only a temporary blob: preview was available, not the finished image (' +
          e.message + '). This attempt will be retried.');
      }
      L.debug('Direct fetch of the image failed (' + e.message + ') — trying a canvas capture.');
      const c = canvasCapture(img);
      if (c) return { base64: c.base64, mime: c.mime, sourceUrl: url, bytes: c.bytes };
      throw new Error('Could not read the generated image bytes: ' + e.message);
    }
  }

  function guessMime(url) {
    const u = String(url).toLowerCase();
    if (u.indexOf('.png') !== -1) return 'image/png';
    if (u.indexOf('.webp') !== -1) return 'image/webp';
    if (u.indexOf('.gif') !== -1) return 'image/gif';
    return CFG.defaultMime || 'image/jpeg';
  }

  /* ====================================================================== */
  /*  UPLOAD (delegated to the service worker)                              */
  /* ====================================================================== */
  async function uploadCaptured(captured, item) {
    setState(STATES.UPLOADING);
    const res = await send({
      action: 'UPLOAD_IMAGE',
      job: {
        base64: captured.base64,
        mime: captured.mime,
        sourceUrl: captured.sourceUrl,
        promptIndex: item.n,
        promptText: item.prompt,
        model: R.settings.model,
        mode: R.settings.mode,
        aspectRatio: R.settings.aspectRatio
      }
    });

    if (!res) return { ok: false, error: 'The extension background service did not respond. Reload the extension and press Retry.' };
    if (!res.ok) return { ok: false, error: res.error || 'Google Drive upload failed.' };
    return { ok: true, info: res.info };
  }

  /* ====================================================================== */
  /*  STATE / BROADCAST                                                     */
  /* ====================================================================== */
  function setState(s) {
    R.state = s;
    broadcast();
  }

  function snapshotForPanel() {
    return {
      state: R.state,
      running: R.running,
      paused: R.paused,
      index: R.index,
      total: R.items.length,
      current: R.items[R.index] || null,
      items: R.items.map(function (it) {
        return { n: it.n, status: it.status, attempts: it.attempts || 0,
                 filename: it.filename || null, driveFileId: it.driveFileId || null,
                 error: it.error || null, prompt: it.prompt };
      }),
      counters: R.counters,
      lastError: R.lastError,
      awaitingDecision: !!R.decision
    };
  }

  let broadcastTimer = null;
  function broadcast() {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(function () {
      broadcastTimer = null;
      send({ action: 'QUEUE_STATE', state: snapshotForPanel() });
      persist();
    }, 150);
  }

  function persist() {
    const key = (CFG.storageKeys && CFG.storageKeys.queue) || 'queueState';
    try {
      chrome.storage.local.set({
        [key]: {
          state: R.state,
          items: R.items,
          currentIndex: R.index,
          total: R.items.length,
          mode: R.settings ? R.settings.mode : null,
          model: R.settings ? R.settings.model : null,
          aspectRatio: R.settings ? R.settings.aspectRatio : null,
          counters: R.counters,
          lastError: R.lastError,
          savedAt: Date.now()
        }
      }, function () { void chrome.runtime.lastError; });
    } catch (e) {}
  }

  function setItem(i, patch) {
    if (!R.items[i]) return;
    R.items[i] = Object.assign({}, R.items[i], patch);
    broadcast();
  }

  /* ====================================================================== */
  /*  PAUSE / DECISION PLUMBING                                             */
  /* ====================================================================== */
  async function waitWhilePaused() {
    while (R.paused && !R.stopRequested) {
      await sleep(400);
    }
  }

  /** Pause and wait for the user to choose Retry / Skip / Stop. */
  function awaitUserDecision(reason) {
    R.paused = true;
    R.lastError = reason;
    setState(STATES.PAUSED);
    L.warn('Queue paused: ' + reason);
    return new Promise(function (resolve) {
      R.decision = function (choice) {
        R.decision = null;
        R.lastError = null;
        resolve(choice);
      };
      broadcast();
    });
  }

  function resolveDecision(choice) {
    if (R.decision) {
      R.paused = false;
      R.decision(choice);
      return true;
    }
    return false;
  }

  /* ====================================================================== */
  /*  ONE ATTEMPT AT ONE PROMPT                                             */
  /* ====================================================================== */
  async function runOnce(i) {
    const item = R.items[i];
    const promptNo = String(item.n).padStart(3, '0');

    /* If a previous attempt already produced images but the upload failed, do
     * NOT regenerate — reuse the captured bytes so the image is never lost. */
    if (R.pending[i] && R.pending[i].length) {
      L.info('Prompt ' + promptNo + ': re-uploading the image that was already generated.');
      return await uploadAll(i, R.pending[i]);
    }

    const editor = findPromptEditor();
    if (!editor) return { ok: false, hard: true, error: 'Could not find the Flow prompt editor.' };

    // --- prepare the page -------------------------------------------------
    /* Open Flow's settings popover FIRST. The Image/Video toggle, the model
     * dropdown and the aspect-ratio buttons all live inside it, so probing for
     * them while it is closed is what made them undiscoverable. */
    await openComposerSettings();

    if (R.settings.enforceImageMode) {
      const m = await ensureImageMode();
      if (!m.ok) { await closeMenus(); return { ok: false, hard: true, error: m.reason }; }
    }

    await openComposerSettings();
    const mod = await ensureModel(R.settings.model);
    if (!mod.ok) { await closeMenus(); return { ok: false, hard: true, error: mod.reason }; }

    if (R.settings.applyAspectRatio) {
      await openComposerSettings();
      await ensureAspectRatio(R.settings.aspectRatio);
    }

    /* Everything is configured — the popover MUST be shut now, or it swallows
     * the Enter key and the prompt is typed but never submitted. */
    await closeMenus();

    if (R.settings.mode === 'image') {
      const a = await attachReferenceImage();
      if (!a.ok) return { ok: false, hard: true, error: a.reason };
    }

    // --- type the prompt --------------------------------------------------
    await clearEditor(editor);

    /* Snapshot the composer's buttons WHILE THE EDITOR IS EMPTY. The send arrow
     * is the one that is disabled now and enabled after typing — that is how it
     * is identified, because it carries no label. */
    const buttonStates = snapshotComposerButtons(editor);

    const typed = await typePrompt(editor, item.prompt);
    if (!typed) {
      return { ok: false, error: 'The prompt text did not land in the Flow editor, so nothing was submitted.' };
    }
    L.debug('Prompt ' + promptNo + ' verified in the editor before submit.', { chars: item.prompt.length });

    // --- baselines, taken immediately before submit -----------------------
    baselineFailures();
    const before = snapshotImages();

    // --- submit -----------------------------------------------------------
    const sub = await submitPrompt(editor, item.prompt, buttonStates);
    if (!sub.ok) {
      if (sub.reason === 'stopped') return { ok: false, stopped: true };
      return { ok: false, error: sub.reason };
    }
    L.info('Prompt ' + promptNo + ' submitted (' + sub.via + ').');

    // --- wait for the result ---------------------------------------------
    const expected = Math.max(1, parseInt(R.settings.outputsPerPrompt, 10) || 1);
    const gen = await waitForGeneration(before, expected, promptNo);
    if (!gen.ok) {
      if (gen.reason === 'stopped') {
        return {
          ok: false,
          stopped: true
        };
      }

      return {
        ok: false,
        hard: !!gen.hard,
        error: gen.reason
      };
    }

    // --- capture bytes ----------------------------------------------------
    const captured = [];
    for (const img of gen.images.slice(0, expected)) {
      try {
        captured.push(await captureImage(img));
      } catch (e) {
        L.warn('Could not capture one image: ' + e.message);
      }
    }
    if (!captured.length) {
      return { ok: false, error: 'Could not detect the newly generated image well enough to read it.' };
    }

    // Hold on to the bytes so an upload failure never loses the image.
    R.pending[i] = captured;

    return await uploadAll(i, captured);
  }

  /** Upload every captured output for one prompt. All must confirm. */
  async function uploadAll(i, captured) {
    const item = R.items[i];
    const promptNo = String(item.n).padStart(3, '0');
    const done = [];

    for (const cap of captured) {
      if (R.stopRequested) return { ok: false, stopped: true };
      const up = await uploadCaptured(cap, item);
      if (!up.ok) {
        setState(STATES.UPLOAD_FAILED);
        return { ok: false, upload: true, error: up.error };
      }
      if (up.info.duplicate) {
        /* A byte-identical image means Flow produced nothing new — an earlier
         * build reported this as a successful upload and advanced the counter. */
        L.warn('Prompt ' + promptNo + ' produced an image that was ALREADY uploaded as ' +
               up.info.filename + '. No new image was generated, so this counts as a ' +
               'failure and the prompt will be retried.');
        return { ok: false, error: 'The "new" image was byte-identical to ' + up.info.filename +
          ' — Google Flow did not actually generate anything new.' };
      }
      done.push(up.info);
      L.ok('Prompt ' + promptNo + ' -> ' + up.info.filename + ' saved to Google Drive.');
    }

    delete R.pending[i];
    R.counters.uploaded += done.length;

    setItem(i, {
      status: 'uploaded',
      filename: done.map(function (d) { return d.filename; }).join(', '),
      driveFileId: done[0].fileId,
      driveLink: done[0].link,
      error: null,
      at: Date.now()
    });
    setState(STATES.SUCCESS);
    return { ok: true, uploads: done };
  }

  /* ====================================================================== */
  /*  THE QUEUE LOOP                                                        */
  /* ====================================================================== */
  /* ADVANCE CONDITION, and nothing else:
   *   current generation successfully detected AND image confirmed in Drive. */
  async function runQueue() {
    R.running = true;
    R.stopRequested = false;
    startHeartbeat();

    L.info('Run started: ' + R.items.length + ' prompt' + (R.items.length === 1 ? '' : 's') +
           ', model ' + R.settings.model + ', mode ' + R.settings.mode + '.');

    while (R.index < R.items.length) {
      if (R.stopRequested) break;
      await waitWhilePaused();
      if (R.stopRequested) break;

      const i = R.index;
      const item = R.items[i];
      const promptNo = String(item.n).padStart(3, '0');

      if (item.status === 'uploaded' || item.status === 'skipped') { R.index++; broadcast(); continue; }

      let attempt = item.attempts || 0;
      let advanced = false;

      while (!advanced) {
        if (R.stopRequested) break;
        await waitWhilePaused();
        if (R.stopRequested) break;

        attempt++;
        setItem(i, { status: attempt > 1 ? 'retrying' : 'generating', attempts: attempt, error: null });
        if (attempt > 1) {
          R.counters.retries++;
          L.warn('Generation failed. Retrying Prompt ' + promptNo + ' (attempt ' + attempt + ').');
          setState(STATES.RETRYING);
        }

        let res;
        try {
          res = await runOnce(i);
        } catch (e) {
          res = { ok: false, error: 'Unexpected error: ' + (e && e.message ? e.message : String(e)) };
        }

        if (res.ok) { advanced = true; break; }
        if (res.stopped || R.stopRequested) break;

        R.counters.failed++;
        setItem(i, { status: 'failed', error: res.error });
        R.lastError = res.error;
        setState(res.upload ? STATES.UPLOAD_FAILED : STATES.FAILED);
        L.err((res.upload ? 'Google Drive upload failed' : 'Prompt ' + promptNo + ' failed') + ': ' + res.error);

        const max = parseInt(R.settings.maxRetries, 10);
        const unlimited = !max || max <= 0;
        const exhausted = !unlimited && attempt >= max;

        // A missing control or unconfirmable model is not worth hammering —
        // pause immediately and let the user fix the page.
        if (res.hard || exhausted || (res.upload && R.settings.pauseOnError && exhausted)) {
          const choice = await awaitUserDecision(res.error);
          if (choice === 'stop') { R.stopRequested = true; break; }
          if (choice === 'skip') {
            R.counters.skipped++;
            delete R.pending[i];
            setItem(i, { status: 'skipped' });
            L.warn('Prompt ' + promptNo + ' skipped at your request.');
            break;
          }
          // 'retry' falls through and tries the same prompt again.
          attempt = res.hard ? attempt : 0;
          continue;
        }

        await sleep(T.retryDelayMs || 2000);
      }

      if (R.stopRequested) break;

      // The number only moves on once the image is confirmed in Drive
      // (or the user explicitly chose to skip).
      R.index++;
      broadcast();
      if (R.index < R.items.length) await sleep(T.betweenPromptsMs || 1500);
    }

    stopHeartbeat();
    R.running = false;

    if (R.stopRequested) {
      setState(STATES.STOPPED);
      L.warn('Run stopped. ' + R.counters.uploaded + ' image(s) were saved to Google Drive.');
    } else {
      setState(STATES.COMPLETED);
      L.ok('Run complete. ' + R.counters.uploaded + ' image(s) saved to Google Drive, ' +
           R.counters.skipped + ' skipped.');
    }
    send({ action: 'RUN_FINISHED', state: snapshotForPanel() });
  }

  /* ====================================================================== */
  /*  SERVICE-WORKER KEEPALIVE                                              */
  /* ====================================================================== */
  function startHeartbeat() {
    stopHeartbeat();
    R.heartbeat = setInterval(function () {
      send({ action: 'HEARTBEAT' });
    }, T.heartbeatMs || 20000);
  }
  function stopHeartbeat() {
    if (R.heartbeat) { clearInterval(R.heartbeat); R.heartbeat = null; }
  }

  /* ====================================================================== */
  /*  DIAGNOSTICS                                                           */
  /* ====================================================================== */
  function describe(el) {
    if (!el) return null;
    return {
      tag: el.tagName,
      name: accName(el).slice(0, 80),
      ariaLabel: el.getAttribute ? el.getAttribute('aria-label') : null,
      role: el.getAttribute ? el.getAttribute('role') : null,
      disabled: !isEnabled(el),
      classes: String(el.className || '').slice(0, 120)
    };
  }

  function diagnose() {
    const editor = findPromptEditor();
    const mode = findImageGenerationMode();
    const imgs = findGeneratedImages();

    /* Every button in the composer, with its accessible name, enabled state and
     * position. This is the ground truth needed to identify the send arrow when
     * the automatic scoring gets it wrong. */
    let composer = [];
    if (editor) {
      composer = buttonDescriptors(editor, null).map(function (d) {
        return {
          i: d.index,
          name: d.name || '(no label)',
          enabled: d.enabledNow,
          box: Math.round(d.width) + 'x' + Math.round(d.height),
          right: Math.round(d.right),
          bottom: Math.round(d.bottom)
        };
      });
    }

    /* THE DECISIVE DUMP. Everything else is a guess until we can see what the
     * send control is actually made of: which tag carries the handler, whether
     * there is a nested button, and whether it is inside a form. */
    let sendControlHtml = null;
    if (editor) {
      const ranked = submitCandidates(editor, null);
      sendControlHtml = ranked.slice(0, 2).map(function (c) {
        const el = c.ref;
        let inner = [];
        try {
          inner = Array.prototype.slice.call(el.querySelectorAll('*')).slice(0, 8).map(function (n) {
            return n.tagName.toLowerCase() +
                   (n.className ? '.' + String(n.className).trim().split(/\s+/).slice(0, 2).join('.') : '') +
                   (n.textContent && n.textContent.length < 24 ? ' "' + n.textContent.trim() + '"' : '');
          });
        } catch (e) {}
        return {
          name: c.name || '(icon-only)',
          score: c.score,
          tag: el.tagName,
          type: el.getAttribute ? el.getAttribute('type') : null,
          inForm: !!(el.closest && el.closest('form')),
          nestedButtons: el.querySelectorAll('button,[role="button"]').length,
          innerNodes: inner,
          html: String(el.outerHTML || '').slice(0, 700)
        };
      });
    }

    const report = {
      url: location.href,
      onFlow: isFlowPage(),
      version: '14.5',
      editor: describe(editor),
      editorText: editor ? editorText(editor).slice(0, 120) : null,
      composerButtons: composer,
      submitRanking: editor ? submitCandidates(editor, null).slice(0, 4).map(function (c) {
        return (c.name || '(icon-only)') + ' score=' + c.score;
      }) : [],
      generateButton: describe(findGenerateButton()),
      addMediaButton: describe(findAddMediaButton()),
      modelSelector: describe(findModelSelector()),
      currentModelLabel: currentModelLabel(),
      openPopovers: openPopovers().length,
      outputType: mode ? { current: mode.current, label: mode.label, el: describe(mode.el) } : null,
      generationState: detectGenerationState(),
      failureBanners: findFailureElements().map(function (h) { return h.text; }),
      bodyPointerEvents: (document.body && document.body.style.pointerEvents) || '(unset)',
      scrollLocked: !!(document.body && document.body.hasAttribute('data-scroll-locked')),
      inComposerForm: !!(editor && editor.closest && editor.closest('form')),
      sendControlHtml: sendControlHtml,
      imageCandidates: imgs.length,
      imageSamples: imgs.slice(0, 5).map(function (i) {
        return { src: imageKey(i).slice(0, 140), w: i.naturalWidth, h: i.naturalHeight, ready: imageIsReady(i) };
      }),
      fileInputs: document.querySelectorAll('input[type="file"]').length,
      refAttached: R.refAttached,
      runtime: snapshotForPanel()
    };
    L.info('Diagnostics collected.', report);
    if (sendControlHtml && sendControlHtml.length) {
      L.info('Send control markup (this is what I need to see): ' +
             JSON.stringify(sendControlHtml, null, 1));
    }
    if (composer.length) {
      L.info('Composer buttons (DOM order): ' + composer.map(function (c) {
        return '#' + c.i + ' "' + c.name + '" ' + (c.enabled ? 'enabled' : 'DISABLED') + ' ' + c.box;
      }).join('  |  '));
    }
    return report;
  }

  function isFlowPage() {
    const href = location.href;
    for (const p of (CFG.flowUrlPatterns || [])) if (href.indexOf(p) !== -1) return true;
    return false;
  }

  /* ====================================================================== */
  /*  MESSAGE API                                                           */
  /* ====================================================================== */
  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (!msg || !msg.action) return;

    switch (msg.action) {

      case 'PING':
        respond({ ok: true, onFlow: isFlowPage(), state: snapshotForPanel() });
        return true;

      case 'GET_STATE':
        respond({ ok: true, state: snapshotForPanel() });
        return true;

      case 'DIAGNOSE':
        try { respond({ ok: true, report: diagnose() }); }
        catch (e) { respond({ ok: false, error: e.message }); }
        return true;

      case 'START': {
        if (R.running) { respond({ ok: false, error: 'A run is already in progress.' }); return true; }
        if (!isFlowPage()) { respond({ ok: false, error: 'Google Flow page not detected.' }); return true; }

        const prompts = [].concat(msg.prompts || []);
        if (!prompts.length) { respond({ ok: false, error: 'There are no prompts to run.' }); return true; }

        R.settings = Object.assign({
          mode: 'text', model: CFG.defaultModel, aspectRatio: CFG.defaultAspectRatio,
          outputsPerPrompt: 1, maxRetries: 0, pauseOnError: true,
          enforceImageMode: true, applyAspectRatio: true, continueIfModelUnconfirmed: true, debug: false
        }, msg.settings || {});
        R.debug = !!R.settings.debug;
        R.refImage = msg.refImage || null;
        R.refAttached = false;

        if (R.settings.mode === 'image' && !R.refImage) {
          respond({ ok: false, error: 'Reference image is missing.' });
          return true;
        }

        const startAt = parseInt(msg.startNumber, 10);
        const base = (isNaN(startAt) || startAt < 1) ? 1 : startAt;

        R.items = prompts.map(function (p, idx) {
          return { n: base + idx, prompt: p, status: 'waiting', attempts: 0 };
        });
        R.index = 0;
        R.pending = {};
        R.paused = false;
        R.stopRequested = false;
        R.lastError = null;
        R.counters = { uploaded: 0, failed: 0, retries: 0, skipped: 0 };

        respond({ ok: true, total: R.items.length });
        runQueue();
        return true;
      }

      case 'PAUSE':
        if (!R.running) { respond({ ok: false, error: 'Nothing is running.' }); return true; }
        R.paused = true;
        setState(STATES.PAUSED);
        L.info('Paused. The current prompt, queue, model, reference image and counter are all preserved.');
        respond({ ok: true });
        return true;

      case 'RESUME':
        if (R.decision) { resolveDecision('retry'); respond({ ok: true, resumed: 'retry' }); return true; }
        R.paused = false;
        L.info('Resumed.');
        if (!R.running && R.items.length && R.index < R.items.length) {
          setState(STATES.GENERATING);
          runQueue();
        } else {
          broadcast();
        }
        respond({ ok: true });
        return true;

      case 'STOP':
        R.stopRequested = true;
        R.paused = false;
        if (R.decision) resolveDecision('stop');
        stopHeartbeat();
        setState(STATES.STOPPED);
        L.warn('Stop requested — no further prompts will be started.');
        respond({ ok: true });
        return true;

      case 'RETRY_CURRENT':
        if (resolveDecision('retry')) { respond({ ok: true }); return true; }
        respond({ ok: false, error: 'There is nothing waiting to be retried.' });
        return true;

      case 'SKIP_CURRENT':
        if (resolveDecision('skip')) { respond({ ok: true }); return true; }
        respond({ ok: false, error: 'There is nothing waiting to be skipped.' });
        return true;

      case 'SET_DEBUG':
        R.debug = !!msg.debug;
        if (R.settings) R.settings.debug = R.debug;
        respond({ ok: true, debug: R.debug });
        return true;

      default:
        return;
    }
  });

  /* ====================================================================== */
  /*  BOOT / RECOVERY AFTER A PAGE REFRESH                                  */
  /* ====================================================================== */
  /* A refresh must never silently restart at Prompt 001. The saved index is
   * restored and the run is left PAUSED unless auto-start is on. */
  (function boot() {
    const qKey = (CFG.storageKeys && CFG.storageKeys.queue) || 'queueState';
    const sKey = (CFG.storageKeys && CFG.storageKeys.settings) || 'settings';
    const rKey = (CFG.storageKeys && CFG.storageKeys.refImage) || 'refImage';

    chrome.storage.local.get([qKey, sKey, rKey], function (data) {
      void chrome.runtime.lastError;
      const settings = (data && data[sKey]) || {};
      R.debug = !!settings.debug;

      L.info('Auto Prompt v14.5 (EDIT-CHECK-12) is watching this Google Flow page.');

      const saved = data && data[qKey];
      if (!saved || !saved.items || !saved.items.length) { broadcast(); return; }
      if (saved.state === 'COMPLETED' || saved.state === 'STOPPED' || saved.state === 'IDLE') {
        R.items = saved.items;
        R.index = Math.min(saved.currentIndex || 0, saved.items.length);
        R.state = saved.state;
        broadcast();
        return;
      }
      if (settings.preserveQueue === false) { broadcast(); return; }

      R.items = saved.items;
      R.index = Math.min(saved.currentIndex || 0, saved.items.length);
      R.counters = saved.counters || R.counters;
      R.settings = Object.assign({
        mode: 'text', model: CFG.defaultModel, aspectRatio: CFG.defaultAspectRatio,
        outputsPerPrompt: 1, maxRetries: 0, pauseOnError: true,
        enforceImageMode: true, applyAspectRatio: true, continueIfModelUnconfirmed: true
      }, settings, {
        mode: saved.mode || settings.mode,
        model: saved.model || settings.model,
        aspectRatio: saved.aspectRatio || settings.aspectRatio
      });
      R.refImage = (data && data[rKey]) || null;
      R.refAttached = false;

      const at = String((R.items[R.index] || R.items[R.items.length - 1]).n).padStart(3, '0');
      L.warn('The page reloaded during a run. Recovered at Prompt ' + at +
             ' of ' + R.items.length + ' — press Resume to continue.');

      if (settings.autoStart) {
        R.paused = false;
        setState(STATES.GENERATING);
        runQueue();
      } else {
        R.paused = true;
        setState(STATES.PAUSED);
      }
    });
  })();

  /* Expose a tiny debug handle for manual console inspection. */
  globalThis.AutoPromptDebug = {
    diagnose: diagnose,
    finders: {
      findPromptEditor: findPromptEditor,
      findGenerateButton: findGenerateButton,
      findAddMediaButton: findAddMediaButton,
      findModelSelector: findModelSelector,
      findImageGenerationMode: findImageGenerationMode,
      findGeneratedImages: findGeneratedImages,
      detectGenerationState: detectGenerationState
    },
    state: function () { return snapshotForPanel(); }
  };
})();

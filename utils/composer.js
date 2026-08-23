/* ============================================================================
 * utils/composer.js — pure scoring for "which button submits the prompt?"
 * ----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * In Flow's current composer, pressing Enter inserts a NEWLINE. It does not
 * submit. The only reliable submit control is the round arrow button at the
 * bottom-right of the composer, and that button is icon-only: no text, and in
 * some builds no aria-label either. Matching it by name alone therefore fails,
 * and "click the last button in the form" clicks the wrong thing.
 *
 * The trick that does work is behavioural rather than cosmetic: while the
 * editor is EMPTY the send arrow is disabled, and the moment prompt text lands
 * it becomes enabled. No other control in the composer behaves that way. So we
 * snapshot the enabled/disabled state of every composer button before typing,
 * compare after typing, and the button that flipped is the send button.
 *
 * The scoring is kept here, as plain data in / number out, so it can be unit
 * tested in Node without a browser. content.js only builds the descriptors.
 * ==========================================================================*/

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.APComposer = api;
  if (typeof globalThis !== 'undefined') globalThis.APComposer = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  /* ------------------------------------------------------------------------
   * OBSERVED GROUND TRUTH (Flow project page, 2026-08-22)
   *
   * Accessible names in the composer are a Material Symbols icon ligature glued
   * to the visible label, so they read like this. This is the real, logged list:
   *
   *   arrow_back go back | more_vert more options | add add media |
   *   help product help | more_vert more | plus | search search |
   *   filter_list sort & filter | add_2 create | agent |
   *   nano banana pro crop_16_9 x1 | arrow_forward create
   *
   * Three consequences the scoring has to handle:
   *   1. The send button is "arrow_forward create" — it is NOT unlabelled.
   *   2. "add_2 create" and "plus" also contain submit-ish words, so a naive
   *      keyword match picks the wrong control. Anything add/plus-flavoured is
   *      rejected outright, even when it says "create".
   *   3. "close clear prompt" is the X that empties the composer. Clicking it
   *      looks exactly like a successful submit, because the editor does go
   *      empty. That is the false positive that broke 14.1, so it must never
   *      be a candidate at all.
   * --------------------------------------------------------------------- */

  /* Names that positively suggest "this submits". */
  const SUBMIT_RE = /\b(send|submit|generate|create|run|go|start|arrow_forward|arrow_upward|arrow)\b/;

  /* The strongest positives, straight from Flow's icon ligatures. */
  const STRONG_SUBMIT_RE = /\b(arrow_forward|arrow_upward|send|submit|generate)\b/;

  /* Rejected even when the name ALSO contains a submit word, because clicking
   * one of these is actively destructive or plainly wrong. */
  const HARD_REJECT_RE = /(^|\b|_)(add|add_2|plus|close|clear|dismiss|cancel|delete|remove|trash)(\b|_|$)/;

  /* Names that suggest "this is NOT the submit button". Checked after
   * SUBMIT_RE, so a button labelled "Generate" still wins. */
  const NOT_SUBMIT_RE = new RegExp([
    'add', 'upload', 'media', 'attach', 'ingredient', 'reference', 'agent',
    'close', 'clear', 'dismiss', 'cancel', 'remove', 'delete', 'edit',
    'model', 'nano', 'banana', 'veo', 'imagen', 'gemini',
    'aspect', 'ratio', 'crop', 'setting', 'option', 'help', 'menu', 'more',
    'copy', 'download', 'share', 'favourite', 'favorite', 'like',
    'zoom', 'expand', 'collapse', 'search', 'filter', 'sort',
    'arrow_back', 'back', 'profile', 'account', 'sign', 'notification'
  ].join('|'));

  /** Normalise the way content.js does, so tests and runtime agree. */
  function norm(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  /**
   * Score one candidate.
   *
   * d  = { name, enabledNow, enabledBefore, right, bottom, width, height, index }
   *      `enabledBefore` may be null when the button did not exist before typing
   *      (React sometimes replaces the node) — that is treated as "unknown",
   *      not as evidence either way.
   * ctx= { maxRight, maxBottom, total }
   *
   * Returns a number, or -1 meaning "reject outright".
   */
  function scoreSubmitCandidate(d, ctx) {
    if (!d || d.enabledNow === false) return -1;
    const name = norm(d.name);

    /* Hard rejections come FIRST and beat every positive signal. Flow's
     * "close clear prompt" and "add_2 create" both slipped through in 14.1. */
    if (name && HARD_REJECT_RE.test(name)) return -1;

    const strong = !!name && STRONG_SUBMIT_RE.test(name);
    const looksSubmit = !!name && SUBMIT_RE.test(name);
    if (name && !looksSubmit && NOT_SUBMIT_RE.test(name)) return -1;
    // A long label is a container or a chip, never the arrow.
    if (name.length > 40) return -1;
    // "x1" / "x4" is the output-count chip.
    if (/^x[0-9]+$/.test(name)) return -1;

    const c = ctx || {};
    let score = 0;

    // Strongest signal: disabled while the editor was empty, enabled once the
    // prompt landed. Only the send control does this.
    if (d.enabledBefore === false) score += 100;
    // Mild negative: it was already clickable with an empty editor, so it is
    // probably a chip or a toolbar button rather than the send control.
    else if (d.enabledBefore === true) score -= 10;

    if (strong) score += 90;                   // "arrow_forward create", "send"
    else if (looksSubmit) score += 60;
    else if (!name) score += 25;               // icon-only arrow, no label at all

    if (typeof c.maxRight === 'number' && Math.abs(d.right - c.maxRight) <= 2) score += 30;
    if (typeof c.maxBottom === 'number' && Math.abs(d.bottom - c.maxBottom) <= 24) score += 10;
    if (typeof c.total === 'number' && d.index === c.total - 1) score += 15;

    // Round icon buttons are square-ish and small.
    if (d.width > 0 && d.height > 0 && Math.abs(d.width - d.height) <= 6 && d.width <= 72) score += 15;

    return score;
  }

  /**
   * Rank a whole composer. `descriptors` is an array in DOM order.
   * Returns the surviving candidates, best first.
   */
  function rankSubmitCandidates(descriptors) {
    const list = [].concat(descriptors || []);
    if (!list.length) return [];

    let maxRight = -Infinity, maxBottom = -Infinity;
    for (const d of list) {
      if (typeof d.right === 'number' && d.right > maxRight) maxRight = d.right;
      if (typeof d.bottom === 'number' && d.bottom > maxBottom) maxBottom = d.bottom;
    }
    const ctx = { maxRight: maxRight, maxBottom: maxBottom, total: list.length };

    const out = [];
    for (let i = 0; i < list.length; i++) {
      const d = Object.assign({}, list[i], { index: typeof list[i].index === 'number' ? list[i].index : i });
      const s = scoreSubmitCandidate(d, ctx);
      if (s < 0) continue;
      out.push({ index: d.index, name: norm(d.name), score: s, ref: list[i].ref });
    }
    // Highest score first; ties broken by later DOM position (the arrow is last).
    out.sort(function (a, b) { return b.score - a.score || b.index - a.index; });
    return out;
  }

  return {
    norm: norm,
    SUBMIT_RE: SUBMIT_RE,
    STRONG_SUBMIT_RE: STRONG_SUBMIT_RE,
    HARD_REJECT_RE: HARD_REJECT_RE,
    NOT_SUBMIT_RE: NOT_SUBMIT_RE,
    scoreSubmitCandidate: scoreSubmitCandidate,
    rankSubmitCandidates: rankSubmitCandidates
  };
});

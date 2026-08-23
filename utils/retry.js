/* ============================================================================
 * utils/retry.js — Auto Prompt v14
 * ----------------------------------------------------------------------------
 * Bounded retry with explicit backoff, plus an abortable sleep and a wall-clock
 * fetch wrapper. Used by the Drive service so a flaky network can never turn
 * into an infinite loop or a silently skipped upload.
 *
 * Exposes: globalThis.APRetry
 * ==========================================================================*/

var APRetry = (function () {
  'use strict';

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.aborted) return reject(abortError());
      const id = setTimeout(function () {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(id);
        reject(abortError());
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function abortError() {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    return e;
  }

  function isAbort(err) {
    return !!err && (err.name === 'AbortError' || /aborted/i.test(err.message || ''));
  }

  /**
   * Run `fn(attemptNumber)` until it resolves.
   *
   * opts:
   *   attempts     max attempts (default 3). 0 or Infinity = unlimited.
   *   backoffMs    array of delays between attempts; last value repeats.
   *   shouldRetry  fn(err, attempt) -> bool. Default: retry unless aborted.
   *   onRetry      fn(err, attempt, delayMs) notification hook.
   *   signal       AbortSignal — aborts immediately, never retried.
   *   label        string used in the final error message.
   */
  async function withRetry(fn, opts) {
    opts = opts || {};
    const maxAttempts = (!opts.attempts || opts.attempts <= 0) ? Infinity : opts.attempts;
    const backoff = opts.backoffMs && opts.backoffMs.length ? opts.backoffMs : [1000, 3000, 7000];
    const shouldRetry = opts.shouldRetry || function (err) { return !isAbort(err); };
    const label = opts.label || 'operation';

    let attempt = 0;
    let lastErr = null;

    while (attempt < maxAttempts) {
      attempt++;
      if (opts.signal && opts.signal.aborted) throw abortError();
      try {
        return await fn(attempt);
      } catch (err) {
        lastErr = err;
        if (isAbort(err)) throw err;
        if (attempt >= maxAttempts || !shouldRetry(err, attempt)) break;
        const delay = backoff[Math.min(attempt - 1, backoff.length - 1)];
        if (opts.onRetry) {
          try { opts.onRetry(err, attempt, delay); } catch (e) {}
        }
        await sleep(delay, opts.signal);
      }
    }

    const msg = lastErr && lastErr.message ? lastErr.message : 'unknown error';
    const wrapped = new Error(label + ' failed after ' + attempt +
      (attempt === 1 ? ' attempt' : ' attempts') + ': ' + msg);
    wrapped.cause = lastErr;
    wrapped.attempts = attempt;
    throw wrapped;
  }

  /**
   * fetch() with a hard wall-clock timeout. Without this a hung socket can
   * stall the whole queue forever, because fetch has no default timeout.
   */
  async function fetchWithTimeout(url, init, timeoutMs, outerSignal) {
    const ctrl = new AbortController();
    const onOuterAbort = function () { ctrl.abort(); };
    if (outerSignal) {
      if (outerSignal.aborted) throw abortError();
      outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
    const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 60000);
    try {
      return await fetch(url, Object.assign({}, init || {}, { signal: ctrl.signal }));
    } catch (err) {
      if (isAbort(err) && !(outerSignal && outerSignal.aborted)) {
        const t = new Error('Request timed out after ' + Math.round((timeoutMs || 60000) / 1000) + 's');
        t.name = 'TimeoutError';
        throw t;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
    }
  }

  /** HTTP statuses that are worth retrying (transient server / rate limits). */
  function isRetryableStatus(status) {
    return status === 408 || status === 429 || status === 500 ||
           status === 502 || status === 503 || status === 504;
  }

  return {
    sleep: sleep,
    withRetry: withRetry,
    fetchWithTimeout: fetchWithTimeout,
    isRetryableStatus: isRetryableStatus,
    isAbort: isAbort,
    abortError: abortError
  };
})();

if (typeof globalThis !== 'undefined') globalThis.APRetry = APRetry;
if (typeof module !== 'undefined' && module.exports) module.exports = APRetry;

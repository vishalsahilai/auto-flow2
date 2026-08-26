var APSlack = (function () {
  'use strict';

  const CFG = typeof AP_CONFIG !== 'undefined'
    ? AP_CONFIG
    : globalThis.AP_CONFIG || {};

  const S = CFG.slack || {};
  const ALERTS_KEY = 'slackAlertKeys';
  const inflight = new Set();

  function getLocal(keys) {
    return new Promise(function (resolve) {
      chrome.storage.local.get(keys, function (data) {
        void chrome.runtime.lastError;
        resolve(data || {});
      });
    });
  }

  function setLocal(data) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set(data, function () {
        const error = chrome.runtime.lastError;

        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  }

  function validWebhook(url) {
    return /^https:\/\/hooks\.slack\.com\/services\//i.test(
      String(url || '').trim()
    );
  }

  async function sendText(text, overrideUrl) {
    const settings = await APStore.getSettings();
    const url = String(
      overrideUrl || settings.slackWebhookUrl || ''
    ).trim();

    if (!overrideUrl && !settings.slackEnabled) {
      return { skipped: true };
    }

    if (!validWebhook(url)) {
      throw new Error('Enter a valid Slack Incoming Webhook URL first.');
    }

    const controller = new AbortController();

    const timer = setTimeout(function () {
      controller.abort();
    }, S.timeoutMs || 10000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: String(text)
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const detail = await response.text();

        throw new Error(
          'Slack notification failed (HTTP ' +
          response.status +
          '): ' +
          detail.slice(0, 200)
        );
      }

      return { sent: true };
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error('Slack notification timed out.');
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendOnce(key, text) {
    if (inflight.has(key)) {
      return { skipped: true };
    }

    const data = await getLocal([ALERTS_KEY]);
    const sent = data[ALERTS_KEY] || {};

    if (sent[key]) {
      return { skipped: true };
    }

    inflight.add(key);

    try {
      const result = await sendText(text);

      if (result.sent) {
        sent[key] = Date.now();
        await setLocal({
          [ALERTS_KEY]: sent
        });
      }

      return result;
    } finally {
      inflight.delete(key);
    }
  }

  function resetRun() {
    return setLocal({
      [ALERTS_KEY]: {}
    });
  }

  async function handleQueueState(state) {
    if (!state || !state.current) {
      return { skipped: true };
    }

    const settings = await APStore.getSettings();

    if (!settings.slackEnabled) {
      return { skipped: true };
    }

    const item = state.current;
    const attempts = parseInt(item.attempts, 10) || 0;
    const threshold = S.alertAfterAttempts || 5;

    const promptNumber = String(
      item.n || state.index + 1
    ).padStart(3, '0');

    const error = item.error || state.lastError || '';

    if (state.state === 'UPLOAD_FAILED' && error) {
      return sendOnce(
        'upload:' + state.index,
        ':rotating_light: *Google Drive upload needs attention*\n' +
        '*Prompt:* ' + promptNumber + '\n' +
        '*Drive attempts:* 5\n' +
        '*Error:* ' + error + '\n' +
        'The generated image is preserved and Auto Prompt will keep retrying the upload.'
      );
    }

    if (
      attempts >= threshold &&
      error &&
      (
        state.state === 'FAILED' ||
        state.state === 'PAUSED'
      )
    ) {
      return sendOnce(
        'generation:' + state.index,
        ':warning: *Google Flow image generation needs attention*\n' +
        '*Prompt:* ' + promptNumber + '\n' +
        '*Attempts:* ' + attempts + '\n' +
        '*Error:* ' + error + '\n' +
        'Auto Prompt will keep retrying unless the queue is manually stopped.'
      );
    }

    return { skipped: true };
  }

  async function handleRunFinished(state, folder) {
    if (!state || state.state !== 'COMPLETED') {
      return { skipped: true };
    }

    const counters = state.counters || {};

    return sendOnce(
      'completed',
      ':white_check_mark: *Auto Prompt run completed*\n' +
      '*Uploaded:* ' + (counters.uploaded || 0) + '\n' +
      '*Retries:* ' + (counters.retries || 0) + '\n' +
      '*Skipped:* ' + (counters.skipped || 0) + '\n' +
      '*Google Drive folder:* ' +
      (
        folder && (folder.path || folder.name)
          ? folder.path || folder.name
          : 'Auto Prompt'
      )
    );
  }

  async function test() {
    const settings = await APStore.getSettings();

    return sendText(
      ':white_check_mark: *Auto Prompt Slack connection is working.*',
      settings.slackWebhookUrl
    );
  }

  return {
    resetRun: resetRun,
    handleQueueState: handleQueueState,
    handleRunFinished: handleRunFinished,
    test: test
  };
})();

if (typeof globalThis !== 'undefined') {
  globalThis.APSlack = APSlack;
}
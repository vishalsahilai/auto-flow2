var APAuth = (function () {
  'use strict';

  const CFG = typeof AP_CONFIG !== 'undefined'
    ? AP_CONFIG
    : globalThis.AP_CONFIG || {};
  const O = CFG.oauth || {};
  const KEY = CFG.storageKeys && CFG.storageKeys.driveToken
    ? CFG.storageKeys.driveToken
    : 'driveToken';

  let inflight = null;

  function redirectUri() {
    return chrome.identity.getRedirectURL();
  }

  function clientId() {
    return String(O.clientId || '').trim();
  }

  function isConfigured() {
    return clientId().length > 0;
  }

  function configError() {
    return new Error(
      'Google Drive is not configured. Add your OAuth client ID to AP_CONFIG.oauth.clientId in config.js, reload the extension, and register this redirect URI in Google Cloud: ' +
      redirectUri()
    );
  }

  function storageGet() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([KEY], function (data) {
        void chrome.runtime.lastError;
        resolve(data && data[KEY] ? data[KEY] : null);
      });
    });
  }

  function storageSet(token) {
    return new Promise(function (resolve, reject) {
      chrome.storage.local.set({ [KEY]: token }, function () {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve();
      });
    });
  }

  function storageClear() {
    return new Promise(function (resolve) {
      chrome.storage.local.remove([KEY], function () {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }

  function requiredScopes() {
    return (O.scopes || [])
      .map(function (scope) {
        return String(scope).trim();
      })
      .filter(Boolean);
  }

  function hasRequiredScopes(token) {
    if (!token || !token.scope) return false;

    const granted = new Set(
      String(token.scope)
        .split(/\s+/)
        .map(function (scope) {
          return scope.trim();
        })
        .filter(Boolean)
    );

    const required = requiredScopes();
    return required.length > 0 && required.every(function (scope) {
      return granted.has(scope);
    });
  }

  function isFresh(token) {
    if (
      !token ||
      !token.accessToken ||
      !token.expiresAt ||
      !hasRequiredScopes(token)
    ) {
      return false;
    }

    const skew = O.refreshSkewMs === undefined
      ? 300000
      : Number(O.refreshSkewMs);

    return Date.now() < token.expiresAt - (Number.isFinite(skew) ? skew : 300000);
  }

  function randomState() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  function buildAuthUrl(state, promptMode, loginHint) {
    const params = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: requiredScopes().join(' '),
      state: state,
      include_granted_scopes: 'true',
      enable_granular_consent: 'true'
    });

    if (promptMode) params.set('prompt', promptMode);
    if (loginHint) params.set('login_hint', loginHint);

    return (
      O.authEndpoint ||
      'https://accounts.google.com/o/oauth2/v2/auth'
    ) + '?' + params.toString();
  }

  function launch(url, interactive) {
    return new Promise(function (resolve, reject) {
      chrome.identity.launchWebAuthFlow(
        { url: url, interactive: Boolean(interactive) },
        function (responseUrl) {
          const error = chrome.runtime.lastError;

          if (error || !responseUrl) {
            reject(new Error(
              error && error.message
                ? error.message
                : 'The authorization window was closed.'
            ));
            return;
          }

          resolve(responseUrl);
        }
      );
    });
  }

  function describeOauthError(code, description) {
    const detail = description
      ? decodeURIComponent(String(description).replace(/\+/g, ' '))
      : '';

    switch (code) {
      case 'access_denied':
        return 'You declined the Google Drive permission request. Auto Prompt needs full Drive access to list folders and save images.';
      case 'redirect_uri_mismatch':
        return 'Google rejected the redirect URI. Add this exact URI to your OAuth client in Google Cloud: ' + redirectUri();
      case 'invalid_client':
        return 'Google rejected the OAuth client ID. AP_CONFIG.oauth.clientId must contain a valid Web application client ID.';
      case 'invalid_scope':
        return 'Google rejected the Drive scope. Enable the Google Drive API for your Google Cloud project.';
      case 'interaction_required':
      case 'login_required':
      case 'consent_required':
        return 'Google needs you to sign in and approve Drive access again.';
      default:
        return 'Google sign-in failed' +
          (code ? ' (' + code + ')' : '') +
          (detail ? ': ' + detail : '.');
    }
  }

  function parseRedirect(responseUrl, expectedState) {
    const url = new URL(responseUrl);
    const values = url.hash
      ? new URLSearchParams(url.hash.slice(1))
      : url.searchParams;
    const error = values.get('error');

    if (error) {
      throw new Error(
        describeOauthError(error, values.get('error_description'))
      );
    }

    if (!url.hash) {
      throw new Error('Google did not return an access token.');
    }

    if (expectedState && values.get('state') !== expectedState) {
      throw new Error(
        'Authorization failed the security state check. Connect Google Drive again.'
      );
    }

    const accessToken = values.get('access_token');
    if (!accessToken) {
      throw new Error('Google did not return an access token.');
    }

    const expiresIn = Number.parseInt(values.get('expires_in'), 10);

    return {
      accessToken: accessToken,
      tokenType: values.get('token_type') || 'Bearer',
      expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
      scope: values.get('scope') || requiredScopes().join(' '),
      obtainedAt: Date.now()
    };
  }

  async function validateAndStore(token) {
    if (!hasRequiredScopes(token)) {
      await storageClear();
      throw new Error(
        'The full Google Drive permission was not granted. Disconnect Google Drive, reconnect it, and approve the requested Drive access.'
      );
    }

    await storageSet(token);
    return token.accessToken;
  }

  async function requestToken(interactive, promptMode) {
    const state = randomState();
    const responseUrl = await launch(
      buildAuthUrl(state, promptMode),
      interactive
    );
    const token = parseRedirect(responseUrl, state);
    return validateAndStore(token);
  }

  async function getToken(options) {
    const opts = options || {};

    if (!isConfigured()) throw configError();

    if (!opts.forceInteractive) {
      const cached = await storageGet();
      if (isFresh(cached)) return cached.accessToken;
    }

    if (inflight) return inflight;

    inflight = (async function () {
      if (!opts.forceInteractive) {
        try {
          return await requestToken(false, 'none');
        } catch (error) {
          if (!opts.interactive) {
            await storageClear();
            const connectionError = new Error(
              'Google Drive is not connected. Open Auto Prompt and click Connect Google Drive.'
            );
            connectionError.needsInteractive = true;
            throw connectionError;
          }
        }
      }

      return requestToken(true, 'select_account consent');
    })();

    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  function connect() {
    return getToken({
      interactive: true,
      forceInteractive: true
    });
  }

  async function invalidate() {
    await storageClear();
  }

  async function signOut() {
    const cached = await storageGet();
    await storageClear();

    if (!cached || !cached.accessToken) return;

    try {
      await fetch(
        (O.revokeEndpoint || 'https://oauth2.googleapis.com/revoke') +
          '?token=' + encodeURIComponent(cached.accessToken),
        { method: 'POST' }
      );
    } catch (error) {
      void error;
    }
  }

  async function status() {
    const cached = await storageGet();
    const configured = isConfigured();
    const validScope = hasRequiredScopes(cached);

    return {
      configured: configured,
      connected: Boolean(
        configured &&
        cached &&
        cached.accessToken &&
        validScope
      ),
      fresh: isFresh(cached),
      expiresAt: cached ? cached.expiresAt : null,
      scope: cached ? cached.scope : null,
      redirectUri: redirectUri(),
      extensionId: chrome.runtime.id
    };
  }

  return {
    isConfigured: isConfigured,
    redirectUri: redirectUri,
    getToken: getToken,
    connect: connect,
    invalidate: invalidate,
    signOut: signOut,
    status: status
  };
})();

if (typeof globalThis !== 'undefined') {
  globalThis.APAuth = APAuth;
}

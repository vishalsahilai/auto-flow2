/* ============================================================================
 * services/auth.js — Auto Prompt v14
 * ----------------------------------------------------------------------------
 * Google OAuth for the extension, using chrome.identity.launchWebAuthFlow with
 * the implicit (token) flow. No client secret is embedded, no password is ever
 * requested or stored, and the token is never shown in the UI.
 *
 * Works with whichever Google account the user picks at consent time, so the
 * extension is portable across Chrome profiles — nothing is hard-coded.
 *
 * Exposes: globalThis.APAuth
 * ==========================================================================*/

var APAuth = (function () {
  'use strict';

  const CFG = (typeof AP_CONFIG !== 'undefined') ? AP_CONFIG : (globalThis.AP_CONFIG || {});
  const O = CFG.oauth || {};
  const KEY = (CFG.storageKeys && CFG.storageKeys.driveToken) || 'driveToken';

  /* Serialise token acquisition: several uploads finishing at once must not each
   * launch their own consent window. */
  let inflight = null;

  function redirectUri() {
    // Deterministic because manifest.json pins the extension `key`.
    return chrome.identity.getRedirectURL();
  }

  function clientId() {
    return (O.clientId || '').trim();
  }

  function isConfigured() {
    return clientId().length > 0;
  }

  function configError() {
    return new Error(
      'Google Drive is not configured yet. Open config.js and paste your OAuth ' +
      'client ID into AP_CONFIG.oauth.clientId, then reload the extension. ' +
      'The redirect URI to register in Google Cloud is: ' + redirectUri()
    );
  }

  /* ---------------------------------------------------------------- */
  /*  TOKEN CACHE                                                     */
  /* ---------------------------------------------------------------- */
  function readCached() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([KEY], function (data) {
        void chrome.runtime.lastError;
        resolve((data && data[KEY]) || null);
      });
    });
  }

  function writeCached(tok) {
    return new Promise(function (resolve) {
      chrome.storage.local.set({ [KEY]: tok }, function () { void chrome.runtime.lastError; resolve(); });
    });
  }

  function clearCached() {
    return new Promise(function (resolve) {
      chrome.storage.local.remove([KEY], function () { void chrome.runtime.lastError; resolve(); });
    });
  }

  function isFresh(tok) {
    if (!tok || !tok.accessToken || !tok.expiresAt) return false;
    const skew = O.refreshSkewMs === undefined ? 300000 : O.refreshSkewMs;
    return Date.now() < (tok.expiresAt - skew);
  }

  /* ---------------------------------------------------------------- */
  /*  AUTH URL                                                        */
  /* ---------------------------------------------------------------- */
  function randomState() {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    return Array.from(buf).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function buildAuthUrl(state, promptMode, loginHint) {
    const params = new URLSearchParams({
      client_id: clientId(),
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: (O.scopes || []).join(' '),
      state: state,
      include_granted_scopes: 'true',
      enable_granular_consent: 'true'
    });
    if (promptMode) params.set('prompt', promptMode);
    if (loginHint) params.set('login_hint', loginHint);
    return (O.authEndpoint || 'https://accounts.google.com/o/oauth2/v2/auth') + '?' + params.toString();
  }

  function launch(url, interactive) {
    return new Promise(function (resolve, reject) {
      chrome.identity.launchWebAuthFlow({ url: url, interactive: !!interactive }, function (responseUrl) {
        const err = chrome.runtime.lastError;
        if (err || !responseUrl) {
          reject(new Error(err && err.message ? err.message : 'Authorisation window was closed.'));
          return;
        }
        resolve(responseUrl);
      });
    });
  }

  /** Parse the #fragment Google appends to the redirect URI. */
  function parseRedirect(responseUrl, expectedState) {
    const hashIndex = responseUrl.indexOf('#');
    const queryIndex = responseUrl.indexOf('?');

    // Errors come back on the query string, tokens on the fragment.
    if (hashIndex === -1 && queryIndex !== -1) {
      const q = new URLSearchParams(responseUrl.slice(queryIndex + 1));
      throw new Error(describeOauthError(q.get('error'), q.get('error_description')));
    }
    if (hashIndex === -1) throw new Error('Google did not return an access token.');

    const frag = new URLSearchParams(responseUrl.slice(hashIndex + 1));
    const error = frag.get('error');
    if (error) throw new Error(describeOauthError(error, frag.get('error_description')));

    const returnedState = frag.get('state');
    if (expectedState && returnedState !== expectedState) {
      throw new Error('Authorisation failed a security check (state mismatch). Please try connecting again.');
    }

    const accessToken = frag.get('access_token');
    if (!accessToken) throw new Error('Google did not return an access token.');

    const expiresIn = parseInt(frag.get('expires_in'), 10);
    const grantedScope = frag.get('scope') || (O.scopes || []).join(' ');

    return {
      accessToken: accessToken,
      tokenType: frag.get('token_type') || 'Bearer',
      expiresAt: Date.now() + ((isNaN(expiresIn) ? 3600 : expiresIn) * 1000),
      scope: grantedScope,
      obtainedAt: Date.now()
    };
  }

  function describeOauthError(code, description) {
    switch (code) {
      case 'access_denied':
        return 'You declined the Google Drive permission request. Auto Prompt needs it to save your images.';
      case 'redirect_uri_mismatch':
        return 'Google rejected the redirect URI. Add exactly this URI to your OAuth client in Google Cloud: ' + redirectUri();
      case 'invalid_client':
        return 'That OAuth client ID was not accepted by Google. Check AP_CONFIG.oauth.clientId in config.js — it must be a "Web application" client.';
      case 'invalid_scope':
        return 'The requested Drive scope was rejected. Make sure the Google Drive API is enabled for your Cloud project.';
      case 'interaction_required':
      case 'login_required':
      case 'consent_required':
        return 'Google needs you to sign in again.';
      default:
        return 'Google sign-in failed' + (code ? ' (' + code + ')' : '') +
               (description ? ': ' + decodeURIComponent(description.replace(/\+/g, ' ')) : '.');
    }
  }

  /* ---------------------------------------------------------------- */
  /*  PUBLIC API                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Return a usable access token.
   *   getToken()                  -> cached, else silent, else throws
   *   getToken({interactive:true})-> cached, else silent, else shows consent UI
   *   getToken({forceInteractive:true}) -> always shows the account chooser
   */
  async function getToken(opts) {
    opts = opts || {};
    if (!isConfigured()) throw configError();

    if (!opts.forceInteractive) {
      const cached = await readCached();
      if (isFresh(cached)) return cached.accessToken;
    }

    if (inflight) return inflight;

    inflight = (async function () {
      // 1) Silent attempt — works whenever the user already has a Google session
      //    and has previously granted the scope.
      if (!opts.forceInteractive) {
        try {
          const state = randomState();
          const url = buildAuthUrl(state, 'none');
          const res = await launch(url, false);
          const tok = parseRedirect(res, state);
          await writeCached(tok);
          return tok.accessToken;
        } catch (e) {
          if (!opts.interactive) {
            await clearCached();
            const err = new Error('Google Drive is not connected. Open the Auto Prompt panel and click "Connect Google Drive".');
            err.needsInteractive = true;
            throw err;
          }
        }
      }

      // 2) Interactive attempt — account chooser so multi-account profiles work.
      const state = randomState();
      const url = buildAuthUrl(state, 'select_account consent');
      const res = await launch(url, true);
      const tok = parseRedirect(res, state);

      // Verify the scope we actually need was granted (granular consent can drop it).
      const needed = (O.scopes || [])[0];
      if (needed && tok.scope && tok.scope.indexOf(needed) === -1) {
        await clearCached();
        throw new Error('The Google Drive permission was not granted. Please tick the Drive checkbox on the consent screen and try again.');
      }

      await writeCached(tok);
      return tok.accessToken;
    })();

    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  /** Force the consent/account-chooser flow. Used by the Connect button. */
  function connect() {
    return getToken({ interactive: true, forceInteractive: true });
  }

  /** Invalidate a token Google has rejected, so the next call re-authorises. */
  async function invalidate() {
    await clearCached();
  }

  /** Revoke at Google, then forget locally. */
  async function signOut() {
    const cached = await readCached();
    await clearCached();
    if (cached && cached.accessToken) {
      try {
        await fetch((O.revokeEndpoint || 'https://oauth2.googleapis.com/revoke') +
                    '?token=' + encodeURIComponent(cached.accessToken), { method: 'POST' });
      } catch (e) { /* best effort — local state is already cleared */ }
    }
  }

  async function status() {
    const cached = await readCached();
    return {
      configured: isConfigured(),
      connected: !!(cached && cached.accessToken),
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

if (typeof globalThis !== 'undefined') globalThis.APAuth = APAuth;

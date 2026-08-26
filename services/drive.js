/* ============================================================================
 * services/drive.js — Auto Prompt v14
 * ----------------------------------------------------------------------------
 * Everything Google Drive: token-aware fetch, folder discovery/creation,
 * multipart and resumable uploads, upload confirmation, bounded retry, and
 * content-hash duplicate protection.
 *
 * This module never touches the Google Flow DOM, and content.js never touches
 * the Drive API — that separation is deliberate.
 *
 * Exposes: globalThis.APDrive
 * ==========================================================================*/

var APDrive = (function () {
  'use strict';

  const CFG = (typeof AP_CONFIG !== 'undefined') ? AP_CONFIG : (globalThis.AP_CONFIG || {});
  const D = CFG.drive || {};
  const T = CFG.timeouts || {};
  const FOLDER_KEY = (CFG.storageKeys && CFG.storageKeys.driveFolder) || 'driveFolder';

  /* ================================================================== */
  /*  AUTHORISED FETCH                                                  */
  /* ================================================================== */
  /**
   * Every Drive request goes through here so that:
   *   - a token is always attached,
   *   - a 401 transparently re-authorises exactly once,
   *   - there is always a wall-clock timeout (fetch has none by default).
   */
  async function authorizedFetch(url, init, opts) {
    opts = opts || {};
    const timeout = opts.timeoutMs || T.uploadMs || 120000;

    let token = await APAuth.getToken({ interactive: false });
    let res = await APRetry.fetchWithTimeout(url, withAuth(init, token), timeout, opts.signal);

    if (res.status === 401) {
      await APAuth.invalidate();
      token = await APAuth.getToken({ interactive: false });
      res = await APRetry.fetchWithTimeout(url, withAuth(init, token), timeout, opts.signal);
    }
    return res;
  }

  function withAuth(init, token) {
    const headers = new Headers((init && init.headers) || {});
    headers.set('Authorization', 'Bearer ' + token);
    return Object.assign({}, init || {}, { headers: headers });
  }

  async function asError(res, what) {
    let detail = '';
    try {
      const body = await res.text();
      try {
        const j = JSON.parse(body);
        detail = (j.error && (j.error.message || j.error.status)) || body.slice(0, 300);
      } catch (e) { detail = body.slice(0, 300); }
    } catch (e) { /* body already consumed or unreadable */ }

    let msg = what + ' failed (HTTP ' + res.status + ')';
    if (detail) msg += ': ' + detail;

    if (res.status === 403 && /insufficientPermissions|insufficient/i.test(detail)) {
      msg += ' — reconnect Google Drive and make sure you accept the Drive permission.';
    } else if (res.status === 403 && /storageQuotaExceeded|quota/i.test(detail)) {
      msg = 'Your Google Drive is out of storage space. Free some space, then click Retry.';
    } else if (res.status === 404) {
      msg += ' — the destination folder may have been deleted or moved to Trash.';
    }

    const err = new Error(msg);
    err.status = res.status;
    err.retryable = APRetry.isRetryableStatus(res.status);
    return err;
  }

  /* ================================================================== */
  /*  FOLDERS                                                           */
  /* ================================================================== */
  /* NOTE ON SCOPE: with drive.file the extension can only see files and folders
   * that it created itself. That is intentional (least privilege) and is why the
   * folder picker lists Auto Prompt's own folders rather than your whole Drive. */

  function readFolder() {
    return new Promise(function (resolve) {
      chrome.storage.local.get([FOLDER_KEY], function (data) {
        void chrome.runtime.lastError;
        resolve((data && data[FOLDER_KEY]) || null);
      });
    });
  }

  function writeFolder(folder) {
    return new Promise(function (resolve) {
      chrome.storage.local.set({ [FOLDER_KEY]: folder }, function () { void chrome.runtime.lastError; resolve(); });
    });
  }

  async function folderExists(id, opts) {
    if (!id) return false;
    const url = D.apiBase + '/files/' + encodeURIComponent(id) +
                '?fields=id,name,mimeType,trashed&supportsAllDrives=true';
    const res = await authorizedFetch(url, { method: 'GET' }, opts);
    if (res.status === 404) return false;
    if (!res.ok) throw await asError(res, 'Checking the Drive folder');
    const j = await res.json();
    return !j.trashed && j.mimeType === D.folderMime;
  }

  async function findFolderByName(name, opts) {
    const q = "mimeType='" + D.folderMime + "' and name='" +
              String(name).replace(/'/g, "\\'") + "' and trashed=false";
    const url = D.apiBase + '/files?q=' + encodeURIComponent(q) +
                '&fields=files(id,name)&pageSize=10&orderBy=createdTime';
    const res = await authorizedFetch(url, { method: 'GET' }, opts);
    if (!res.ok) throw await asError(res, 'Searching for the Drive folder');
    const j = await res.json();
    return (j.files && j.files[0]) || null;
  }

  async function createFolder(name, parentId, opts) {
    const body = { name: String(name), mimeType: D.folderMime };
    if (parentId) body.parents = [parentId];

    const res = await authorizedFetch(D.apiBase + '/files?fields=id,name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, opts);

    if (!res.ok) throw await asError(res, 'Creating the Drive folder "' + name + '"');
    const j = await res.json();
    return { id: j.id, name: j.name };
  }

  /** Folders this extension has created — the choices offered in the panel. */
  async function listFolders(parentId, opts) {
    const parent = String(
      parentId || 'root'
    ).replace(/'/g, "\\'");

    const q =
      "mimeType='" +
      D.folderMime +
      "' and '" +
      parent +
      "' in parents and trashed=false";

    const url =
      D.apiBase +
      '/files?q=' +
      encodeURIComponent(q) +
      '&fields=files(id,name,parents,createdTime)' +
      '&pageSize=1000' +
      '&orderBy=name' +
      '&spaces=drive' +
      '&corpora=user' +
      '&supportsAllDrives=true' +
      '&includeItemsFromAllDrives=true';

    const response = await authorizedFetch(
      url,
      { method: 'GET' },
      opts
    );

    if (!response.ok) {
      throw await asError(
        response,
        'Listing your Drive folders'
      );
    }

    const data = await response.json();

    return data.files || [];
  }

  /**
   * Resolve the destination folder, creating it on first use.
   * Reuses the stored id when it still exists, so repeated runs never create
   * duplicate "Auto Prompt" folders.
   */
  async function ensureFolder(opts) {
    const stored = await readFolder();

    if (stored && stored.id) {
      let ok = false;
      try { ok = await folderExists(stored.id, opts); } catch (e) { throw e; }
      if (ok) return stored;
    }

    const name = (stored && stored.name) || D.defaultFolderName || 'Auto Prompt';

    let found = null;
    try { found = await findFolderByName(name, opts); } catch (e) { /* fall through to create */ }
    if (found) {
      const folder = { id: found.id, name: found.name };
      await writeFolder(folder);
      return folder;
    }

    const created = await createFolder(name, null, opts);
    await writeFolder(created);
    return created;
  }

  async function selectFolder(folder) {
    if (!folder || !folder.id) {
      throw new Error('No folder was selected.');
    }

    const selected = {
      id: folder.id,
      name: folder.name,
      path: folder.path || folder.name
    };

    await writeFolder(selected);

    return selected;
  }

  /** Change only the folder NAME to use next; the id is resolved on next upload. */
  async function setFolderName(name) {
    const clean = String(name || '').trim() || D.defaultFolderName || 'Auto Prompt';
    await writeFolder({ id: null, name: clean });
    return { id: null, name: clean };
  }

  function folderLink(id) {
    return id ? 'https://drive.google.com/drive/folders/' + id : null;
  }
  function fileLink(id) {
    return id ? 'https://drive.google.com/file/d/' + id + '/view' : null;
  }

  /* ================================================================== */
  /*  UPLOAD                                                            */
  /* ================================================================== */

  function base64ToBytes(base64) {
    const comma = base64.indexOf(',');
    const raw = comma === -1 ? base64 : base64.slice(comma + 1);
    const bin = atob(raw);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function sha256Hex(bytes) {
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(buf))
      .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function extFor(mime) {
    return (CFG.mimeToExt && CFG.mimeToExt[mime]) || CFG.defaultExt || 'jpg';
  }

  /** Small files: one request, metadata + bytes in a multipart body. */
  async function multipartUpload(bytes, mime, filename, folderId, opts) {
    const boundary = '----AutoPromptBoundary' + Math.random().toString(36).slice(2);
    const metadata = { name: filename, mimeType: mime };
    if (folderId) metadata.parents = [folderId];

    const head =
      '--' + boundary + '\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(metadata) + '\r\n' +
      '--' + boundary + '\r\n' +
      'Content-Type: ' + mime + '\r\n\r\n';
    const tail = '\r\n--' + boundary + '--';

    const body = new Blob([head, bytes, tail], { type: 'multipart/related; boundary=' + boundary });

    const url = D.uploadBase + '/files?uploadType=multipart&fields=id,name,size,webViewLink,parents';
    const res = await authorizedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
      body: body
    }, opts);

    if (!res.ok) throw await asError(res, 'Uploading ' + filename + ' to Google Drive');
    return res.json();
  }

  /** Large files: initiate a session, then send the bytes to the session URL. */
  async function resumableUpload(bytes, mime, filename, folderId, opts) {
    const metadata = { name: filename, mimeType: mime };
    if (folderId) metadata.parents = [folderId];

    const initRes = await authorizedFetch(
      D.uploadBase + '/files?uploadType=resumable&fields=id,name,size,webViewLink,parents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mime,
          'X-Upload-Content-Length': String(bytes.length)
        },
        body: JSON.stringify(metadata)
      }, opts);

    if (!initRes.ok) throw await asError(initRes, 'Starting the Drive upload for ' + filename);

    const sessionUrl = initRes.headers.get('Location');
    if (!sessionUrl) throw new Error('Google Drive did not return an upload session URL for ' + filename + '.');

    const putRes = await APRetry.fetchWithTimeout(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': mime,
        'Content-Range': 'bytes 0-' + (bytes.length - 1) + '/' + bytes.length
      },
      body: bytes
    }, opts.timeoutMs || T.uploadMs || 120000, opts.signal);

    if (putRes.status === 308) {
      throw new Error('Google Drive did not accept the whole file for ' + filename + ' — will retry.');
    }
    if (!putRes.ok) throw await asError(putRes, 'Uploading ' + filename + ' to Google Drive');
    return putRes.json();
  }

  /**
   * Upload one generated image and CONFIRM it landed.
   *
   * job: {
   *   base64      data URL or bare base64 of the image bytes
   *   mime        source MIME type (preserved on Drive)
   *   sourceUrl   Flow media URL, used as a duplicate key
   *   promptIndex 1-based prompt number
   *   promptText  the prompt that produced it
   *   model, mode
   * }
   *
   * Returns { fileId, filename, link, size, counter, duplicate }
   * Throws with a human-readable message on failure — the caller must NOT
   * advance its queue unless this resolves.
   */
  async function uploadGeneratedImage(job, opts) {
    opts = opts || {};
    if (!job || !job.base64) throw new Error('There was no image data to upload.');

    const bytes = base64ToBytes(job.base64);
    if (!bytes.length) throw new Error('The generated image came back empty — nothing to upload.');

    const mime = job.mime || CFG.defaultMime || 'image/jpeg';
    const hash = await sha256Hex(bytes);

    /* ---- duplicate protection (URL identity AND content identity) ---- */
    const dupKeys = [];
    if (job.sourceUrl) dupKeys.push('url:' + job.sourceUrl);
    dupKeys.push('sha:' + hash);

    const existing = await APStore.isDuplicate(dupKeys);
    if (existing) {
      APLog.warn('Skipped a duplicate image — it was already uploaded as ' + existing.filename, {
        fileId: existing.fileId, promptIndex: job.promptIndex
      });
      return {
        fileId: existing.fileId,
        filename: existing.filename,
        link: existing.link || fileLink(existing.fileId),
        size: existing.size || bytes.length,
        counter: existing.counter,
        duplicate: true
      };
    }

    const folder = await ensureFolder(opts);

    /* Reserve the number only once we are actually about to upload, so failed
     * attempts never burn a file number. */
    const counter = await APStore.nextCounter();
    const filename = APStore.buildFilename(counter, extFor(mime));

    APLog.info('Uploading ' + filename + ' to Google Drive folder "' + folder.name + '"', {
      bytes: bytes.length, mime: mime, promptIndex: job.promptIndex
    });

    let file;
    try {
      file = await APRetry.withRetry(function (attempt) {
        if (attempt > 1) APLog.warn('Drive upload failed — retrying ' + filename + ' (attempt ' + attempt + ')');
        return (bytes.length > (D.resumableThresholdBytes || 4194304))
          ? resumableUpload(bytes, mime, filename, folder.id, opts)
          : multipartUpload(bytes, mime, filename, folder.id, opts);
      }, {
        attempts: D.uploadMaxAttempts || 5,
        backoffMs: D.uploadBackoffMs || [1000, 3000, 7000, 15000, 30000],
        signal: opts.signal,
        label: 'Google Drive upload of ' + filename,
        shouldRetry: function (err) {
          if (APRetry.isAbort(err)) return false;
          if (err && err.status && !err.retryable && err.status !== 401) return false;
          return true;
        }
      });
    } catch (err) {
      // Hand the number back so the next attempt reuses it — no gaps in 001,002…
      try { await APStore.setCounter(counter); } catch (e) {}
      throw err;
    }

    /* ---- CONFIRM: the API must have given us a real file id ---- */
    if (!file || !file.id) {
      try { await APStore.setCounter(counter); } catch (e) {}
      throw new Error('Google Drive accepted ' + filename + ' but returned no file ID, so the upload could not be confirmed.');
    }

    const info = {
      fileId: file.id,
      filename: file.name || filename,
      link: file.webViewLink || fileLink(file.id),
      size: parseInt(file.size, 10) || bytes.length,
      counter: counter,
      folderId: folder.id,
      folderName: folder.name,
      at: Date.now()
    };

    await APStore.rememberUpload(dupKeys, info);

    APLog.success('Uploaded ' + info.filename + ' to Google Drive', {
      fileId: info.fileId, folder: folder.name, size: info.size
    });

    await APStore.addHistory({
      promptIndex: job.promptIndex,
      promptText: job.promptText || '',
      model: job.model || null,
      mode: job.mode || null,
      aspectRatio: job.aspectRatio || null,
      filename: info.filename,
      driveFileId: info.fileId,
      driveLink: info.link,
      driveFolderId: folder.id,
      driveFolderName: folder.name,
      status: 'uploaded',
      bytes: info.size,
      mime: mime,
      sourceUrl: job.sourceUrl || null,
      time: new Date().toISOString()
    });

    return Object.assign({}, info, { duplicate: false });
  }

  /** Quick end-to-end readiness probe used before a run starts. */
  async function ensureReady(opts) {
    if (!APAuth.isConfigured()) {
      throw new Error(
        'Google Drive is not set up yet. Paste your OAuth client ID into config.js ' +
        '(AP_CONFIG.oauth.clientId). Redirect URI to register: ' + APAuth.redirectUri()
      );
    }
    await APAuth.getToken({ interactive: false });
    const folder = await ensureFolder(opts);
    return { folder: folder, folderLink: folderLink(folder.id) };
  }

  return {
    ensureReady: ensureReady,
    ensureFolder: ensureFolder,
    listFolders: listFolders,
    createFolder: createFolder,
    selectFolder: selectFolder,
    setFolderName: setFolderName,
    readFolder: readFolder,
    folderLink: folderLink,
    fileLink: fileLink,
    uploadGeneratedImage: uploadGeneratedImage,
    _sha256Hex: sha256Hex,
    _base64ToBytes: base64ToBytes
  };
})();

if (typeof globalThis !== 'undefined') globalThis.APDrive = APDrive;

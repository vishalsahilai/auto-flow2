/* ============================================================================
 * config.js — Auto Prompt v14
 * ----------------------------------------------------------------------------
 * SINGLE SOURCE OF TRUTH. Everything brittle lives here so that when Google
 * changes the Flow UI you only edit THIS file — never content.js.
 *
 * Loaded as a plain (non-module) script by:
 *   - the content script  (manifest content_scripts js: ["config.js","content.js"])
 *   - the service worker  (background.js -> importScripts('config.js'))
 *   - the side panel      (<script src="config.js">)
 * ==========================================================================*/

var AP_CONFIG = {

  /* ------------------------------------------------------------------ */
  /*  OAUTH — ONE-TIME USER CONFIGURATION                                */
  /* ------------------------------------------------------------------ */
  oauth: {
    // >>> PASTE YOUR GOOGLE CLOUD OAUTH 2.0 *WEB APPLICATION* CLIENT ID HERE <<<
    // See README section "One-time Google Cloud setup".
    // Authorised redirect URI to register:
    //   https://cpmepjhamnhjgojlkcmnopphmpcogbin.chromiumapp.org/
    clientId: 'write your google drive client id',

    // Least-privilege Drive scope: the extension can only see and touch files
    // that the extension itself created. It can never read your other files.
    scopes: ['https://www.googleapis.com/auth/drive'],
    

    authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    revokeEndpoint: 'https://oauth2.googleapis.com/revoke',

    // Refresh the implicit token this many ms before it actually expires.
    refreshSkewMs: 5 * 60 * 1000
  },

  /* ------------------------------------------------------------------ */
  /*  GOOGLE DRIVE                                                       */
  /* ------------------------------------------------------------------ */
  drive: {
    apiBase: 'https://www.googleapis.com/drive/v3',
    uploadBase: 'https://www.googleapis.com/upload/drive/v3',
    defaultFolderName: 'Auto Prompt',
    folderMime: 'application/vnd.google-apps.folder',
    filenameTemplate: '{counter}.{ext}',
    counterPad: 3,
    resumableThresholdBytes: 4 * 1024 * 1024,
    uploadMaxAttempts: 5,
    uploadBackoffMs: [1000, 3000, 7000, 15000, 30000]
  },

  slack: {
    alertAfterAttempts: 5,
    timeoutMs: 10000
  },


  /* ------------------------------------------------------------------ */
  /*  MODELS                                                             */
  /* ------------------------------------------------------------------ */
  /* `aliases` are matched LONGEST-FIRST so "Nano Banana 2" can never be
   * mistaken for "Nano Banana 2 Lite". Add/rename here only.
   *
   * IMPORTANT: Flow does not offer the same models on every project, plan or
   * account, and Google renames them without notice. If a model you pick is not
   * in Flow's dropdown the run no longer dead-ends: Settings has
   * "If the model isn't in Flow's list, keep the model Flow already has"
   * (on by default), and the log prints the EXACT labels Flow is showing —
   * look for "Model options Flow is showing right now:". Paste any new label
   * into `aliases` below and it will be selected from then on.               */
  models: [
    {
      id: 'nano-banana-2-lite',
      label: 'Nano Banana 2 Lite',
      sublabel: 'Fast mode',
      aliases: ['nano banana 2 lite', 'nanobanana 2 lite', 'nano banana2 lite',
                'banana 2 lite']
    },
    {
      id: 'nano-banana-2',
      label: 'Nano Banana 2',
      sublabel: 'Standard mode',
      aliases: ['nano banana 2', 'nanobanana 2', 'nano banana2', 'banana 2']
    },
    {
      id: 'nano-banana-pro',
      label: 'Nano Banana Pro',
      sublabel: 'Advanced mode',
      aliases: ['nano banana pro', 'nanobanana pro', 'banana pro']
    }
  ],
  /* Flow only offers one image model on this project ("Nano Banana Pro"), so
   * asking for nano-banana-2 warned on every single attempt. Default to what is
   * actually available; the side panel still lets all three be chosen. */
  defaultModel: 'nano-banana-pro',

  /* ------------------------------------------------------------------ */
  /*  ASPECT RATIOS — add more here, no code change needed               */
  /* ------------------------------------------------------------------ */
  aspectRatios: [
    { id: '16:9', label: '16:9', aliases: ['16:9', '16 : 9', 'landscape'] },
    { id: '9:16', label: '9:16', aliases: ['9:16', '9 : 16', 'portrait'] },
    { id: '1:1',  label: '1:1',  aliases: ['1:1', '1 : 1', 'square'] }
  ],
  defaultAspectRatio: '16:9',

  /* ------------------------------------------------------------------ */
  /*  FLOW DOM SELECTORS — ordered by preference, first hit wins          */
  /* ------------------------------------------------------------------ */
  selectors: {

    // The prompt editor. Flow uses a Slate.js contenteditable.
    promptEditor: [
      '[data-slate-editor="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea[placeholder*="you want" i]',
      'textarea'
    ],

    // Placeholder strings that must NOT be mistaken for real prompt text.
    editorPlaceholders: [
      'what do you want to create',
      'describe your image',
      'enter a prompt',
      'start creating',
      'type a prompt',
      'drop media'
    ],

    // Submit / generate control.
    //
    // NOTE ON HOW FLOW ACTUALLY SUBMITS (v14.1): in the current composer the
    // Enter key inserts a NEWLINE — it does not submit. The real control is the
    // round arrow at the bottom-right, which is icon-only and sometimes has no
    // aria-label at all. It is therefore found behaviourally (it is the button
    // that is disabled while the editor is empty and enabled once the prompt is
    // typed) by utils/composer.js. These selectors are only the first guess.
    submitButton: [
      'button[aria-label*="generate" i]',
      'button[aria-label*="create" i]',
      'button[aria-label*="send" i]',
      'button[aria-label*="submit" i]',
      'button[aria-label*="arrow" i]',
      'button[type="submit"]',
      'button[data-testid*="generate" i]',
      'button[data-testid*="submit" i]',
      'button[data-testid*="send" i]'
    ],
    submitButtonText: ['generate', 'create', 'send', 'run', 'submit'],

    // "Add media" / ingredient / reference-image control.
    addMediaButton: [
      'button[aria-label*="add media" i]',
      'button[aria-label*="add image" i]',
      'button[aria-label*="upload" i]',
      'button[aria-label*="ingredient" i]',
      'button[aria-label*="reference" i]',
      'button[aria-label*="attach" i]'
    ],
    addMediaButtonText: [
      'add media', 'add image', 'upload image', 'upload',
      'ingredient', 'ingredients', 'reference', 'add reference', 'frames to video'
    ],
    fileInput: [
      'input[type="file"][accept*="image" i]',
      'input[type="file"]'
    ],

    /* Flow does NOT attach an uploaded asset automatically. It uploads the
     * file, opens its asset picker with the new asset selected, and then waits
     * for an explicit confirm click. Ordered most-specific first. */
    attachConfirmText: [
      'add to prompt', 'add to scene', 'add selected', 'add media',
      'add image', 'insert', 'confirm', 'done', 'select', 'use', 'add'
    ],

    // Model dropdown trigger. Detected primarily by "it currently displays a
    // known model name", which is far more stable than any class name.
    modelSelector: [
      'button[aria-label*="model" i]',
      '[role="combobox"][aria-label*="model" i]',
      'button[aria-haspopup="listbox"]',
      'button[aria-haspopup="menu"]',
      'button[aria-haspopup="true"]',
      '[role="combobox"]',
      '[role="button"][aria-haspopup]'
    ],

    // Generation-type (Image vs Video) control.
    outputTypeSelector: [
      'button[aria-label*="output" i]',
      'button[aria-label*="type" i]',
      'button[aria-haspopup="listbox"]',
      'button[aria-haspopup="menu"]',
      '[role="combobox"]'
    ],
    imageModeText: ['image', 'text to image', 'image generation', 'frames'],
    videoModeText: ['video', 'text to video', 'image to video'],

    // Aspect-ratio control.
    aspectSelector: [
      'button[aria-label*="aspect" i]',
      'button[aria-label*="ratio" i]',
      'button[aria-haspopup="listbox"]',
      '[role="combobox"]'
    ],

    // Outputs-per-prompt control.
    outputCountSelector: [
      'button[aria-label*="output" i]',
      'button[aria-label*="number" i]',
      'select[aria-label*="output" i]'
    ],

    // Where dropdown options live. Flow renders menus into a document-level
    // portal, so these are searched DOCUMENT-WIDE, not inside the trigger.
    optionItem: [
      '[role="option"]',
      '[role="menuitem"]',
      '[role="menuitemradio"]',
      '[role="radio"]',
      'li[tabindex]',
      'li',
      'button',
      '[data-value]'
    ],
    // Any option label longer than this is a page wrapper, not a real option.
    optionMaxTextLength: 120,

    // Busy / in-progress indicators.
    progressIndicator: [
      '[role="progressbar"]',
      '[aria-busy="true"]',
      '[class*="spinner" i]',
      '[class*="loading" i]',
      '[class*="progress" i]'
    ]
  },

  /* ------------------------------------------------------------------ */
  /*  GENERATED-IMAGE IDENTIFICATION                                     */
  /* ------------------------------------------------------------------ */
  generatedImage: {
    // Strategy 1 (strongest): the media-serving endpoint. Verified in v13.
    // If Google changes this path, add the new one here.
    urlPatterns: [
      'labs.google/fx/api/trpc/media',
      '/fx/api/trpc/media',
      'labs.google/fx/api/media',
      'aisandbox-pa.googleapis.com'
    ],

    // Strategy 2 (fallback): any large image that isn't obviously chrome/UI.
    fallbackMinNaturalWidth: 320,

    // Never treat these as generated output.
    excludeUrlPatterns: [
      'googleusercontent.com/a/',   // account avatars
      'googleusercontent.com/a-',
      'gstatic.com',
      '/static/',
      'data:image/svg',
      'favicon'
    ],

    // Poll cadence while watching for a finished image.
    pollIntervalMs: 2000,

    // An image must be seen unchanged & fully decoded this many polls in a row
    // before we accept it as "finished" (guards against half-rendered previews).
    stableChecks: 2
  },

  /* ------------------------------------------------------------------ */
  /*  FAILURE DETECTION                                                  */
  /* ------------------------------------------------------------------ */
  /* Matched case-insensitively against visible element text. Only NEW
   * occurrences (not present before submit) count, so stale banners from an
   * earlier prompt can't cause a false failure.                          */
  failureTexts: [
    'oops, something went wrong',
    'something went wrong',
    'generation failed',
    'generation error',
    'failed to generate image',
    'failed to generate',
    'failed to create image',
    'failed to create',
    "couldn't generate",
    'could not generate',
    "couldn't create",
    'couldn’t create',
    'could not create',
    'unable to create',
    "image wasn't generated",
    'image wasn’t generated',
    'image was not generated',
    "image couldn't be generated",
    'image couldn’t be generated',
    'image could not be generated',
    'no image was generated',
    "image wasn't created",
    'image wasn’t created',
    'image was not created',
    'we could not generate',
    'we couldn’t generate',
    'unable to generate',
    "that didn't work",
    'that didn’t work',
    "couldn't complete your request",
    'couldn’t complete your request',
    'could not complete your request',
    'an error occurred',
    'internal error',
    'please try again',
    'try your prompt again',
    'rate limit',
    'quota exceeded',
    'out of credits',
    'no credits',
    'blocked by our',
    'violates our',
    'content policy',
    'not supported',
    'failed',
    'we noticed some unusual activity',
    'unusual activity',
    'please visit the help center',
    'help center for more information'
  ],
  // Failure strings must appear in an element whose own text is short —
  // otherwise a whole-page wrapper containing the word would always match.
  failureTextMaxLength: 200,

  /* ------------------------------------------------------------------ */
  /*  TIMING                                                             */
  /* ------------------------------------------------------------------ */
  timeouts: {
    // Minimum settle time after submit before we start looking for a result.
    // An image can never appear instantly; this prevents grabbing a stale one.
    postSubmitGraceMs: 5000,

    // Hard ceiling on one generation attempt. Exceeding it counts as a
    // failure for that ATTEMPT and triggers a retry of the SAME prompt —
    // it never advances the queue.
    generationTimeoutMs: 300000,

    // Waits around UI interactions.
    clickSettleMs: 350,
    menuOpenMs: 700,
    focusMs: 300,
    typeCharMs: 12,
    afterTypeMs: 400,
    afterClearMs: 400,
    betweenPromptsMs: 1500,
    retryDelayMs: 2000,
    attachSettleMs: 1800,

    // How long to keep clicking/waiting for Flow's asset picker to confirm the
    // reference image. The upload itself has been measured at 15-20 s.
    attachConfirmMs: 60000,

    /* How long to wait for evidence that the FIRST submit method worked.
     * Flow does NOT clear the composer when it accepts a prompt, so the only
     * evidence is a spinner or a new tile, and on a cold project that can take
     * well over 6 s. Too short a window made a working submit look dead. */
    preSubmitSettleMs: 1200,
    submitVerifyMs: 25000,

    // Every later method in the ladder gets a shorter window, so a prompt that
    // genuinely cannot be submitted fails in a reasonable time.
    submitRetryVerifyMs: 10000,

    /* An empty composer is only WEAK evidence of a submit — Flow's own
     * clear-prompt X empties it too. After a weak signal, wait this long for a
     * strong one (spinner, new tile, send control disabling) before deciding
     * nothing actually started. */
    corroborateStartMs: 12000,

    // Network wall-clock limits.
    fetchImageMs: 120000,
    uploadMs: 120000,

    /* Smallest plausible real Flow output, in bytes. Anything under this is
     * treated as "Flow was still rendering" and the prompt is retried, so a
     * blank/placeholder image can never be uploaded as a finished file. */
    minImageBytes: 8192,

    // Service-worker keepalive ping cadence while a queue is running.
    heartbeatMs: 20000
  },

  /* ------------------------------------------------------------------ */
  /*  QUEUE DEFAULTS                                                     */
  /* ------------------------------------------------------------------ */
  queue: {
    // 0 = unlimited retries of the same prompt (v13 "FastRetry" behaviour).
    defaultMaxRetries: 0,
    retryOptions: [1, 2, 3, 5, 10, 0],
    defaultOutputsPerPrompt: 1,
    maxHistoryItems: 500,
    maxLogItems: 800,
    maxDedupeKeys: 2000
  },

  /* ------------------------------------------------------------------ */
  /*  MISC                                                               */
  /* ------------------------------------------------------------------ */
  flowUrlPatterns: ['labs.google/fx/tools/flow', 'flow.google.com'],

  mimeToExt: {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif'
  },
  defaultExt: 'jpg',
  defaultMime: 'image/jpeg',

  // Prompt separator: TWO blank lines. Kept identical to v13 (proven).
  promptSeparator: /\n[ \t]*\n[ \t]*\n/,

  storageKeys: {
    settings: 'settings',
    prompts: 'prompts',
    queue: 'queueState',
    counter: 'downloadCounter',
    history: 'history',
    logs: 'logs',
    driveToken: 'driveToken',
    driveFolder: 'driveFolder',
    dedupe: 'dedupeKeys',
    refImage: 'refImage'
  }
};

/* Expose on globalThis so the service worker sees it after importScripts. */
if (typeof globalThis !== 'undefined') globalThis.AP_CONFIG = AP_CONFIG;

# Changelog

## v14.2 — the real root cause of "nothing generates" (2026-08-22)

A live 14.1 run logged these three lines together:

```
utils/composer.js did not load - falling back to the last composer button
Prompt 001 submitted (send arrow (close clear prompt))
```

That is one bug causing a second, worse bug.

### 1. `utils/composer.js` was never injected (ROOT CAUSE)

A content script reaches the Flow page by **two independent paths**, and they had
drifted apart:

- `manifest.json` -> `content_scripts.js` — used when you *navigate* to Flow.
- `background.js` -> `chrome.scripting.executeScript` — used when the Flow tab is
  **already open** when you press Start.

The manifest listed `config.js`, `utils/composer.js`, `content.js`. The worker
injected only `['config.js', 'content.js']`. So on an already-open tab — which is
how everybody actually uses it — the send-arrow scorer genuinely was not there.

`ensureContentScript()` now derives its file list from
`chrome.runtime.getManifest()`, so the two paths cannot diverge again, and a test
asserts they match.

### 2. The degraded fallback clicked Flow's clear-prompt X

With the scorer missing, the old fallback clicked "the last enabled button near
the editor". On this project that button is `close clear prompt` — the X that
**erases the prompt**. Removed. The no-module path now filters through a
`NEVER_CLICK_RE` deny list (`add`, `add_2`, `plus`, `close`, `clear`, `cancel`,
`remove`, `back`, `more`, `help`, `search`, `filter`, `agent`, `crop`, …) and, if
nothing safe remains, it does not click anything at all.

### 3. "The editor went empty" was being reported as a successful submit

Clicking the X empties the composer, and 14.1's `generationLooksStarted()`
accepted `editor cleared` as proof of submission — hence
`Prompt 001 submitted`, followed by a 5-minute wait for an image that was never
coming.

Start evidence is now split by strength:

- **strong** — a progress indicator appeared, a new image tile appeared, or the
  send control went disabled again.
- **weak** — the editor emptied or its text changed. On its own this is *not* a
  submit; it is exactly what the clear-prompt X looks like.

A weak signal opens a corroboration window (`timeouts.corroborateStartMs`,
12 s). If no strong signal arrives inside it, the attempt is failed with a plain
explanation instead of being called a success.

### 4. The prompt is retyped between attempts

If an attempt emptied the composer, the next attempt used to click into an empty
editor. The prompt is now retyped first, and the attempt is failed if it cannot
be.

### 5. Send-arrow scoring hardened with real ground truth

The live log gave the actual accessible names, which are **Material Symbols
ligature + visible label**:

```
arrow_back go back | more_vert more options | add add media | help product help |
more_vert more | plus | search search | filter_list sort & filter | add_2 create |
agent | nano banana pro crop_16_9 x1 | close clear prompt | arrow_forward create
```

`utils/composer.js` was rewritten against that list. Hard rejections now run
*before* any positive scoring, so `close clear prompt` and `add_2 create` can
never win no matter how good their behavioural signature looks, and
`arrow_forward` / `arrow_upward` / `send` score +90. Eight regression tests are
built directly from the names above (80 tests total, up from 72).

### Note on models

The same log shows this project's chip reads `nano banana pro crop_16_9 x1`, and
Flow offered no other model. Model, aspect ratio and output count all live in
that one chip. If you pick a model Flow does not have, 14.1's
"keep the model Flow already has" setting keeps the run alive and warns — but
**select Nano Banana Pro in the panel** to match what Flow is actually using.

---

## v14.1 — submission fix (2026-08-22)

Three live failures were reported against 14.0. All three are addressed here.
The headline one corrects an assumption inherited from v13.

### 1. The prompt was typed, then cleared, and nothing generated

**Root cause: in Flow's current composer the Enter key inserts a NEWLINE. It does
not submit.** v13 relied on Enter, and 14.0 kept that as the primary submit path
(see the v14.0 note below, which is now wrong). The old fallback then clicked
"the last enabled button near the editor", which was a settings chip, so nothing
happened either — the run looked like it typed the prompt and gave up.

The only reliable control is the icon-only round send arrow at the bottom-right
of the composer. It has no text label, so it cannot be found by name. It is now
identified **behaviourally**: it is the only composer control that is *disabled
while the editor is empty* and *enabled once prompt text lands*. `runOnce()`
snapshots every composer button's enabled state while the editor is still empty,
then scores the candidates after typing.

- New file **`utils/composer.js`** holds the scoring as a pure function, so it is
  genuinely unit-tested in Node (10 new tests) rather than merely inspected. It is
  a UMD module: a content script in Chrome, a CommonJS module in the test runner.
- Submission now walks a ladder and **verifies** each rung before moving on:
  send arrow → Cmd/Ctrl+Enter → Enter → second-best candidate → any labelled
  generate button. Evidence of a real start is the editor clearing, a progress
  indicator appearing, a new image tile, or the send control going disabled again.
- Nothing is ever submitted twice: a rung only advances when no start was detected.

### 2. "Could not confirm Nano Banana 2 Lite" ended the run

Flow's model list varies by account and project type, and on the reporting account
those labels are not in the dropdown at all. A missing label is no longer fatal:

- The log now prints the **exact labels Flow is showing** —
  `Model options Flow is showing right now: …`. Paste any new label into
  `config.js` → `models[].aliases` and it is selected from then on.
- New setting (on by default): **"If the model isn't in Flow's list, keep the
  model Flow already has"**. It is never silent — it logs a WARN naming the model
  actually in use. Untick it to stop the run instead.
- Still exactly three configured models, unchanged ids. No invented model names.

### 3. Reference image uploaded but never attached (image → image)

Flow's asset picker uploads the file and then waits for an explicit
**"Add to Prompt"** click; while that modal is open it swallows clicks and keys.
`confirmAssetPicker()` now selects the uploaded asset if needed, clicks the
confirm control, and waits for the modal to close before typing anything.
*Confirmed working on the reporting account.*

### Also in 14.1

- **Empty-file guard.** An earlier build fetched a `blob:` placeholder at 0.0 kB
  and uploaded it as `001.jpg`. Captures below `timeouts.minImageBytes` (8 KB) now
  fail and retry, `blob:` URLs no longer fall through to a canvas re-encode, and a
  blank canvas is rejected. **Delete that empty `001.jpg` from Drive**; you may
  also want Settings → Clear duplicate memory so the number can be reused.
- **`Diagnose page`** now dumps the full composer button row in one log line
  (index, accessible name, enabled/disabled, position) plus the submit ranking,
  the current model label and any open popovers. If submission ever stalls again,
  that single line is the ground truth needed to fix it.
- The OAuth **client ID is pre-filled** in `config.js`. Register the redirect URI
  `https://cpmepjhamnhjgojlkcmnopphmpcogbin.chromiumapp.org/` on that client
  (type: Web application). A client ID is public by design; no secret is shipped.
- Aspect-ratio selection no longer mistakes the model chip for the ratio control.
  Failure to set the ratio stays a warning and never blocks a run.

### Honest status

72 automated tests pass. The end-to-end path — real Chrome, real Flow page, real
Drive upload — **was not run here and remains `MANUAL TEST REQUIRED`**; see
`TEST-REPORT.md`. Flow's live model list could not be researched (web search was
unavailable in the build environment), which is exactly why 14.1 discovers and
logs the real labels at runtime instead of hard-coding a guess.

## v14.0 — "Flow → Drive" (2026-08-22)

> **Superseded by 14.1:** the "Enter-key submission" claim below was wrong for
> Flow's current composer. Enter inserts a newline. See 14.1.

v14 is a rebuild on top of v13's proven behaviour. Everything in v13 that worked
was kept deliberately; everything that was brittle, fake or missing was replaced.

### Kept from v13 (verified, not reinvented)

- The **side panel** UI (it was *not* converted back to a popup).
- **Enter-key submission** on the Slate editor as the primary submit path. This is
  the thing that actually triggers generation in Flow; a button click alone does
  not reliably work. v14 keeps it and adds a pointer-event click as fallback.
- The **two-blank-line prompt separator** — one blank line stays inside a prompt.
- The **numbered output** convention (`001`, `002`, …).
- **Trigger-based** progression: the queue advances on detected events, never on a
  timer.
- **Unlimited retries** by default (v13 "FastRetry" behaviour).
- Duplicate-image protection, failure detection, and the general
  submit → wait → detect → advance shape of the loop.

### Added

- **Direct Google Drive upload** as the destination for every image
  (`services/drive.js`): folder discovery and creation, multipart uploads under
  4 MB, resumable uploads above it, correct MIME type and filename, and a
  confirmed Drive file ID captured for every upload.
- **Proper OAuth** (`services/auth.js`) via `chrome.identity.launchWebAuthFlow`
  with a pinned extension ID, a stable redirect URI, CSRF `state` validation,
  silent token refresh, granted-scope verification, and no client secret anywhere.
- **A real state machine** with IDLE, SUBMITTING, GENERATING, SUCCESS, FAILED,
  RETRYING, UPLOADING, UPLOAD_FAILED, PAUSED, STOPPED, COMPLETED.
- **Upload-confirmed advancement.** The queue now only moves on when the current
  generation was detected **and** its image is confirmed in Drive.
- **Five tabs**: Control, Queue, History, Settings, Logs — with real Drive file
  IDs and working "Open in Google Drive" links in History.
- **Real PDF text extraction** (`utils/parser.js`): stream scanning, native
  `DecompressionStream` inflation, a content-stream tokeniser, and a
  median-vertical-gap heuristic that rebuilds the two-blank-line structure.
- **Debug mode** with exportable/copyable logs and a **Diagnose page** probe.
- **Refresh recovery** — after a Flow reload the run resumes at the right prompt.
- **Modular architecture**: Drive logic in its own service, Flow automation
  confined to the content script, UI in the side panel, coordination in the
  worker. The side panel never touches the Flow DOM; the content script never
  touches Drive.
- **A test suite** (`tests/run-tests.js`, 61 assertions) that runs the shipped
  source in Node against a `chrome.*` stub.

### Fixed

- **Submission silently doing nothing (the v4.1 blocker).** Root cause: the click
  path was being used instead of v13's Enter-key dispatch on the editor. v14 uses
  Enter first, click as fallback, and verifies the editor content before submitting.
- **Slate crash "Cannot resolve a Slate node from DOM node."** Caused by
  `document.execCommand`. It is now gone from the codebase; clearing the editor
  uses text-node range endpoints plus `beforeinput deleteContentBackward`.
- **Fake PDF import.** v13 ran `readAsText` on PDF bytes, which produced binary
  garbage that was then submitted as prompts. v14 extracts real text, or refuses
  with an actionable message (encrypted / scanned / undecodable fonts).
- **Model cross-matching.** "Nano Banana 2 Lite" could resolve to "Nano Banana 2".
  Now longest-alias-wins with explicit competing-alias exclusion, and dropdown
  options are searched document-wide because Flow renders menus in portals.
- **Unverified model selection.** An unconfirmed model used to continue anyway;
  it now stops with "Could not confirm … Please select the model manually in
  Google Flow."
- **Brittle positional selectors** such as `buttons[10]` and `buttons[8]` — all
  removed. Controls are found by accessible name, ARIA, role, text and DOM
  relationships, with coordinates only as a last resort. A control that cannot be
  found pauses the run instead of triggering a blind click.
- **"First image on the page" detection.** Replaced with DOM-delta snapshotting
  that excludes avatars, icons, previous generations and the reference image, plus
  load/stability checks so a partially rendered image is never uploaded.
- **Stale error banners causing false failures.** Errors already on the page are
  baselined in a `WeakSet` before each submit.
- **Counter gaps and double uploads.** Numbers are reserved late and handed back on
  failure; dedupe now keys on both source URL and a SHA-256 of the image bytes;
  reservations are serialised through a storage mutex.
- **Losing the queue on refresh / restarting at Prompt 001.** State is persisted
  and recovered.
- **Reference image re-uploading.** In Image → Image mode the reference is attached
  once per run and reused.

### Removed

- **All local-download code and the `downloads` permission.** Drive is the only
  destination; there is no silent fallback to the Downloads folder.
- **Obsolete and invented model names**, including the non-existent
  "Nano Banana Lite". Exactly three models remain.
- Blind trust in the `labs.google/fx/api/trpc/media` URL shape — it is now one
  detection strategy among several rather than the only one.
- `document.execCommand`, positional button indexes, and every placeholder or
  "TODO: implement" stub.

### Configuration change

v14 requires a one-time Google Cloud OAuth client ID pasted into
`config.js → oauth.clientId`, and the redirect URI
`https://cpmepjhamnhjgojlkcmnopphmpcogbin.chromiumapp.org/` registered against it.
See README section 4.

---

## v13 — "FastRetry" (previous release)

Side-panel bulk prompt runner for Google Flow with numbered local downloads,
Slate.js prompt injection, two-blank-line prompt separation, failure detection and
unlimited fast retries. No Google Drive integration; images landed in the browser's
Downloads folder. PDF import existed in the UI but did not actually extract PDF
text.

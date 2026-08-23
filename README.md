# Auto Prompt v14.2 — Google Flow → Google Drive

A Chrome side-panel extension that runs a queue of prompts through
**Google Flow** and uploads every generated image straight to **Google Drive**,
numbered `001.jpg`, `002.jpg`, `003.jpg` …

It never advances to the next prompt until the current one has *both* generated
successfully *and* been confirmed as an uploaded file in Drive.

---

## Contents

1. [What it does](#1-what-it-does)
2. [Requirements](#2-requirements)
3. [Install the extension](#3-install-the-extension)
4. [One-time Google Cloud setup (required)](#4-one-time-google-cloud-setup-required)
5. [Connect Google Drive](#5-connect-google-drive)
6. [Prompt format — two blank lines](#6-prompt-format--two-blank-lines)
7. [Loading prompts (typing, TXT, PDF)](#7-loading-prompts-typing-txt-pdf)
8. [Text→Image and Image→Image modes](#8-textimage-and-imageimage-modes)
9. [Models and aspect ratio](#9-models-and-aspect-ratio)
10. [Running a queue](#10-running-a-queue)
11. [File numbering and filenames](#11-file-numbering-and-filenames)
12. [Duplicate protection](#12-duplicate-protection)
13. [The generation state machine](#13-the-generation-state-machine)
14. [Retries, pausing and failures](#14-retries-pausing-and-failures)
15. [The five tabs](#15-the-five-tabs)
16. [Settings reference](#16-settings-reference)
17. [Debug mode and logs](#17-debug-mode-and-logs)
18. [Troubleshooting](#18-troubleshooting)
19. [Security and privacy](#19-security-and-privacy)
20. [Architecture](#20-architecture)
21. [Known limitations](#21-known-limitations)

---

## 1. What it does

You paste a list of prompts into the side panel. For each prompt, in order, the
extension:

1. confirms the Flow page, the prompt editor, the model and the Image output type,
2. types the prompt into Flow's editor **exactly as you wrote it** and verifies the
   editor really contains it,
3. submits it and waits for a genuinely new, fully loaded image to appear,
4. downloads those bytes inside the extension and uploads them to your chosen
   Google Drive folder,
5. confirms Drive returned a real file ID,
6. only then moves to the next prompt.

If any step fails, the **same** prompt is retried — its number is never burned and
never skipped silently.

The final destination is Google Drive. There is no local-download code path at
all; the extension does not request the `downloads` permission.

---

## 2. Requirements

- Google Chrome (or Edge / Brave / any Chromium) **116 or newer** — the side panel
  API is required.
- A Google account with access to **Google Flow** (`labs.google/fx/tools/flow`).
- A Google Cloud project where you can create one OAuth client ID (free — see
  section 4). This is the only setup step that cannot be shipped inside the ZIP,
  because an OAuth client belongs to *you*, not to the extension.

---

## 3. Install the extension

1. Unzip `AutoPrompt-v14-Flow-Drive.zip`.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped `auto-prompt-v14` folder.
5. Confirm the extension ID is:

   ```
   cpmepjhamnhjgojlkcmnopphmpcogbin
   ```

   The ID is pinned by the `key` field in `manifest.json`, so it is the same on
   every machine and every Chrome profile. That is what makes the OAuth redirect
   URI below stable.
6. Pin the toolbar icon, then click it to open the side panel. Clicking the icon
   opens the panel on any page, so you can connect Drive before you open Flow.

---

## 4. One-time Google Cloud setup

**This build already has your client ID in `config.js`:**

```
858882040824-gltnfkdej1ll81gr5b32hfdjqh9appe2.apps.googleusercontent.com
```

So you only need **one** thing from the steps below: confirm that this exact
redirect URI is registered on that OAuth client, and that the client is of type
**Web application**.

```
https://cpmepjhamnhjgojlkcmnopphmpcogbin.chromiumapp.org/
```

Include the trailing slash. If Drive connection fails with `redirect_uri_mismatch`,
that URI is missing — add it at **APIs & Services → Credentials →** *your client*
**→ Authorised redirect URIs**. The side panel's **Settings → Setup details** prints
the exact URI your install is using, so you can copy it from there.

A client ID is a public identifier, not a secret; no client secret is shipped or
needed. The full walkthrough below is only needed if you ever want to use a
different Google Cloud project.

<details>
<summary>Creating an OAuth client from scratch</summary>

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **APIs & Services → OAuth consent screen**
   - User type: **External** is fine.
   - Fill in the app name and your email.
   - Under **Scopes**, add `https://www.googleapis.com/auth/drive.file`.
   - Under **Test users**, add the Google account(s) you will use. (While the
     consent screen is in *Testing*, only listed test users can sign in.)
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
     *(Web application — not "Chrome extension". This extension uses
     `chrome.identity.launchWebAuthFlow`, which redirects to a `chromiumapp.org`
     URL, so Google needs a web client with that redirect registered.)*
   - Name: anything, e.g. `Auto Prompt v14`.
   - Under **Authorised redirect URIs**, click **Add URI** and paste exactly:

     ```
     https://cpmepjhamnhjgojlkcmnopphmpcogbin.chromiumapp.org/
     ```

     Include the trailing slash. If Chrome reported a different extension ID in
     step 3, open the side panel → **Settings → Setup details**, which prints the
     exact redirect URI for your install; use that instead.
   - Click **Create** and copy the **Client ID** (it looks like
     `1234567890-abcdefg.apps.googleusercontent.com`). You do **not** need the
     client secret — leave it unused.
5. Open `config.js` in the unzipped folder and paste the client ID:

   ```js
   oauth: {
     clientId: '1234567890-abcdefg.apps.googleusercontent.com',   // <-- here
     scopes: ['https://www.googleapis.com/auth/drive.file'],
     ...
   }
   ```

6. Back on `chrome://extensions`, press **Reload** on the Auto Prompt card.

</details>

That is the whole configuration. Nothing else in `config.js` needs editing.

---

## 5. Connect Google Drive

In the side panel, **Control** tab → **Google Drive**:

- **Connect Google Drive** opens Google's normal sign-in/consent window. Pick the
  account you want the images saved to. The chip changes to
  **Google Drive Connected ✓**.
- **Destination folder** — **Choose folder** lists the folders this extension can
  see; **Create** makes a new one and selects it. If you never choose anything, a
  folder named **Auto Prompt** is created at the root of your Drive.
- **Disconnect** revokes and forgets the token immediately.

Because the scope is `drive.file`, the extension can only see and touch files and
folders **it created itself**. It cannot read the rest of your Drive. That is also
why the folder list may look shorter than your real Drive — pre-existing folders
that the extension has never written to are invisible to it, so create the
destination folder from the panel the first time.

The token is refreshed silently in the background while a queue runs. It is stored
in `chrome.storage.local` and is never displayed in the UI or written to the logs.

---

## 6. Prompt format — two blank lines

**Two blank lines start a new prompt. One blank line stays inside the current
prompt.**

```
A cinematic wide shot of a red fox crossing fresh snow at dawn,
85mm, shallow depth of field

Same scene, but the fox is looking directly at the camera.


A macro photograph of a dew-covered spider web at sunrise
```

That is **two** prompts. The first one keeps its internal blank line, exactly as
typed. The blank lines may contain spaces or tabs and still count as blank, and
`\r\n` line endings are normalised before splitting, so files written on Windows
behave identically.

Prompts are submitted **verbatim**. Nothing is summarised, rewritten, translated,
re-punctuated, trimmed of words, or "improved". The only change is technical
whitespace normalisation needed to type into Flow's editor.

Press **Parse** to see the numbered list (`Prompt 001`, `Prompt 002`, …) before
you start. The numbers shown honour your **Start number** setting.

---

## 7. Loading prompts (typing, TXT, PDF)

- **Type or paste** directly into the box.
- **Import TXT** reads the file as text (UTF-8, with a Latin-1 fallback).
- **Import PDF** extracts the text with a dependency-free extractor built into
  `utils/parser.js`: it walks the PDF's content streams, inflates
  `FlateDecode` streams with the browser's native `DecompressionStream`, tokenises
  the text operators, then rebuilds paragraph structure from the vertical gaps
  between lines. A gap noticeably larger than the document's normal line spacing
  becomes a prompt break.

  PDF layout is a heuristic — **always glance at the parsed list before starting.**
  If the PDF is encrypted, is a scan with no text layer, or uses fonts whose text
  cannot be decoded, the import stops with a message telling you what happened
  (for example "This PDF is encrypted…", or "…most likely a scan (images only).
  Run OCR on it, or paste the prompts in as text"). It will never quietly hand you
  half a prompt list or a page of mojibake.

---

## 8. Text→Image and Image→Image modes

**Text → Image** is the default: prompt in, image out.

**Image → Image** uses one reference image for the whole run.

- Click **Choose image** and pick it once. It is stored in
  `chrome.storage.local`, attached to Flow **once** at the start of the run, and
  reused for every prompt. It is not re-uploaded per prompt.
- The attached reference preview is tagged in the DOM
  (`data-autoprompt-ref="1"`) so the new-image detector can never mistake your
  reference image for a generated result.
- If the mode is Image → Image and no reference image is set, the run refuses to
  start with **"Reference image is missing."**

Flow's "add media" control is found semantically — by accessible name, ARIA label,
role, visible text and DOM relationships — not by pixel coordinates or a button
index. If it genuinely cannot be found, the run **pauses and tells you** rather
than clicking something at random.

---

## 9. Models and aspect ratio

Exactly three models are supported, matching what Flow offers:

| Panel label | Flow mode | Internal id |
|---|---|---|
| Nano Banana 2 Lite | Fast | `nano-banana-2-lite` |
| Nano Banana 2 | Standard | `nano-banana-2` |
| Nano Banana Pro | Advanced | `nano-banana-pro` |

Model matching uses **longest-alias-wins** with explicit exclusion of competing
aliases, so "Nano Banana 2 Lite" can never be mistaken for "Nano Banana 2".
Dropdown options are searched across the whole document, because Flow renders
menus in portals outside the trigger's subtree.

### If the model isn't in Flow's list (changed in 14.1)

Flow's model line-up differs by account and project type, so a configured label
may simply not be present. That is no longer fatal. The log prints the exact
labels Flow is showing:

> Model options Flow is showing right now: Nano Banana Pro | Veo 3 | …

Copy any label you want into `config.js → models[].aliases` and it will be
selected from then on. Meanwhile the setting **"If the model isn't in Flow's list,
keep the model Flow already has"** (Settings, on by default) lets the run continue
with Flow's current model. It is **never silent** — it logs a warning naming the
model actually in use and marks the queue row. Untick it and the run stops with
"Could not confirm …" instead, so you can fix it in Flow and press
**Retry current**.

Aspect ratio offers **16:9**, **9:16** and **1:1**, and the list in
`config.js → aspectRatios` is a plain array you can extend. If Flow's ratio
control isn't found, the extension logs a warning and continues with Flow's
current ratio rather than aborting — you can turn that off with **Apply the
aspect ratio in Flow**.

**Outputs per prompt** defaults to 1. If Flow produces several images for one
prompt, each one is detected, numbered and uploaded independently.

The extension also explicitly confirms Flow is set to **Image** output before each
submission (**Force Flow to Image output (never video)**, on by default), so a run
can't accidentally queue up video generations.

---

## 10. Running a queue

1. Open a Flow **project** page (`…/tools/flow/project/…`).
2. Open the side panel. The Google Flow card should show the detected tab.
3. Choose the mode, model, aspect ratio; paste the prompts; press **Parse**.
4. Connect Drive and pick a folder.
5. Press **Start**.

`Start` refuses to begin — before a single prompt is submitted — if Drive is not
configured, not connected, or the destination folder can't be reached. There is
deliberately no "carry on and save locally instead" path.

**Pause** stops after the step in flight and preserves the current prompt, the
whole queue, the model, the reference image, the Drive destination and the
counter. **Resume** picks up from exactly there. **Stop** ends the run and starts
nothing further.

If the Flow tab is reloaded mid-run, the extension recovers its position from
storage and logs, for example:

> The page reloaded during a run. Recovered at Prompt 014 of 050 — press Resume to
> continue.

It does not restart at Prompt 001. (Turn on **Auto-resume a run after the page
reloads** if you'd rather it continue without asking.)

---

## 11. File numbering and filenames

Files are named by a zero-padded counter: `001.jpg`, `002.jpg`, `003.jpg`, …
PNG results are saved as `.png` with the correct `image/png` MIME type; the
extension preserves whatever type Flow actually produced rather than relabelling
it.

- **Start number** — set `47` and the next files are `047.jpg`, `048.jpg`,
  `049.jpg`. Press **Set counter** to apply it now.
- **Numbering behaviour** — *Continue from the last number* (default) keeps
  counting across runs; *Reset to the start number on every run* restarts each
  time you press Start.
- The counter lives in `chrome.storage.local`, so it survives reloads, browser
  restarts and Chrome updates.
- A number is **reserved late** — only just before the upload — and is **handed
  back** if the upload fails. A failed upload therefore leaves no gap in the
  sequence, and a retry reuses the same number.
- Concurrent reservations are serialised through a mutex, so two images can never
  claim `007.jpg`.

---

## 12. Duplicate protection

The same image is never uploaded twice, using two independent keys:

- the **source media URL** Flow served the image from, and
- a **SHA-256 hash of the actual image bytes**, so a changed URL for identical
  content is still caught.

Those keys are persisted (and bounded so they can't grow forever), and are checked
before every upload. On top of that, new-image detection works by **DOM delta** —
it snapshots the images present before submitting and only considers images that
appeared afterwards, excluding avatars, icons, UI chrome, earlier generations and
the reference image. It never just "takes the first image on the page". A candidate
is only accepted once it is fully loaded (`complete`, non-zero `naturalWidth`) and
its fingerprint has been identical across consecutive checks, so a half-rendered
progressive image is never uploaded.

**Settings → Clear duplicate memory** resets this if you deliberately want to
re-upload something.

---

## 13. The generation state machine

The run is driven by state transitions, never by a timer.

```
IDLE → SUBMITTING → GENERATING →   SUCCESS → UPLOADING → (next prompt)
                          │            │          │
                          ↓            │          ↓
                       FAILED ─────────┘    UPLOAD_FAILED
                          │                       │
                          ↓                       ↓
                      RETRYING ←──────────── (retry same prompt)
                          │
        PAUSED · STOPPED · COMPLETED
```

The condition for advancing is exactly this, and nothing else:

> **the current generation was successfully detected AND its image was
> successfully uploaded to Google Drive.**

Polling is only ever a detection mechanism. A fixed delay is never the reason to
move on.

Failure detection does not depend on one exact English sentence — around
seventeen failure phrasings are matched (see `config.js → failureTexts`), plus
Flow's error UI, and a baseline of already-present error banners is recorded
before each submit (via a `WeakSet`), so a stale error left on the page from an
earlier attempt cannot be mistaken for a fresh failure.

---

## 14. Retries, pausing and failures

**Maximum retries per prompt** defaults to **unlimited** (the v13 FastRetry
behaviour) and can be set to 1, 2, 3, 5 or 10 instead.

- A generation failure retries the **same** prompt, keeping its number.
- A Drive failure shows **"Drive upload failed — retrying…"** and retries with
  backoff. The generated image reference is kept the entire time, so a retry
  uploads the image you already have instead of regenerating it.
- If retries are capped and run out, the queue **pauses** and offers **Retry
  current**, **Skip current** and **Stop**. Nothing is ever skipped without you
  choosing to.
- If Drive keeps failing, the queue pauses with **"Queue paused because Google
  Drive upload failed."**

Messages are written for humans, not stack traces — for example "Google Flow page
not detected.", "Could not find the Flow prompt editor.", "Could not confirm the
selected model.", "Generation failed. Retrying Prompt 007.", "Google Drive is not
connected.", "Reference image is missing.", "Could not detect the newly generated
image."

---

## 15. The five tabs

**Control** — Flow tab status, mode, reference image, model, aspect ratio, the
prompt box with import buttons and the numbered preview, the Drive panel, and
Start / Pause / Resume / Stop / Retry current / Skip current / Diagnose page.

**Queue** — `Prompt 007 / 050`, a progress bar, counts for Total / Uploaded /
Failed / Retries / Skipped, the current prompt text, and every item with its
status: Waiting, Generating, Success, Uploading, Uploaded, Failed, Retrying,
Skipped, Error.

**History** — every uploaded image with its prompt number, prompt text, model,
mode, filename, Drive status, timestamp, real Drive file ID and an **Open in
Google Drive** link. Links are built from the file ID Drive actually returned —
there are no placeholder or fabricated links.

**Settings** — numbering, retries, outputs per prompt, the behaviour toggles,
maintenance actions, and **Setup details** (your extension ID and the exact OAuth
redirect URI to register).

**Logs** — a live, timestamped log with INFO / SUCCESS / WARN / ERROR / DEBUG
filters, plus **Copy** and **Export**.

---

## 16. Settings reference

| Setting | Default | What it does |
|---|---|---|
| Start number | 1 | First file number, zero-padded to 3 digits |
| Numbering behaviour | Continue | Continue across runs, or reset each run |
| Maximum retries per prompt | Unlimited | Cap before the queue pauses for a decision |
| Outputs per prompt | 1 | Each output is detected and uploaded separately |
| Force Flow to Image output | On | Confirms Image, never video, before submitting |
| Apply the aspect ratio in Flow | On | Off = leave Flow's current ratio alone |
| If the model isn't in Flow's list, keep the model Flow already has | On | Off = stop the run instead. Either way the real option labels are logged |
| Auto-resume after the page reloads | Off | On = continue without waiting for Resume |
| Pause the queue on repeated errors | On | Off = keep retrying without pausing |
| Keep the queue across reloads | On | Persist the queue in `chrome.storage.local` |
| Debug logging | Off | Verbose diagnostics (see below) |

---

## 17. Debug mode and logs

Turn on **Settings → Debug logging** to record, for every step: which prompt
editor was detected and how, which buttons were matched, the model label read back
from Flow, each generation-state transition, every image candidate considered and
why it was accepted or rejected, the chosen image, and the full Drive upload
lifecycle including the returned file ID.

**Logs → Copy** puts the whole log on your clipboard; **Export** saves it as a
text file. **Diagnose page** on the Control tab runs a one-shot probe of the live
Flow page and reports which controls it can and cannot find — that report is the
single most useful thing to capture if Flow's UI changes.

---

## 18. Troubleshooting

**The prompt gets typed, then cleared, and nothing generates.** — This was the
14.0 bug fixed in 14.1: Flow's composer treats Enter as a newline, so Enter-based
submission silently did nothing. Make sure you are on 14.1 (the side-panel header
shows the version) and that you pressed **Reload** on the extension card *and*
reloaded the Flow tab. If it still happens, turn on **Debug logging**, press
**Diagnose page**, and send the line beginning *"Composer buttons (DOM order):"* —
that line names every button Flow is showing and which one was chosen.

**"Google Flow did not react to any submit method."** — All of send arrow,
Cmd/Ctrl+Enter and Enter were tried and none started a generation. Nothing was
submitted twice; the prompt is retried. Usually the composer is blocked by an open
dialog — close any Flow modal and press **Resume**.

**"Google Flow's asset picker stayed open…"** (image → image) — Flow needs an
explicit **Add to Prompt** click. Click it in Flow, then press **Resume**. If
Flow's button wording changed, add it to `config.js → attachConfirmText`.

**"Google Flow page not detected."** — Open `labs.google/fx/tools/flow` and
navigate into a project, then press Start again.

**"Could not find the Flow prompt editor."** — Flow's DOM changed, or the page
hadn't finished loading. Reload the tab, then run **Diagnose page**.

**"Could not confirm the selected model."** — Look for the log line *"Model options
Flow is showing right now:"* and either pick one of those models in the panel, add
its label to `config.js → models[].aliases`, or leave **"keep the model Flow
already has"** ticked so the run continues.

**"…too small to be a real output."** — Flow handed over a placeholder rather than
the finished image. The prompt is retried automatically; no empty file is uploaded.

**Drive connect fails with `redirect_uri_mismatch`** — The redirect URI in Google
Cloud doesn't match. Copy the exact string from **Settings → Setup details** and
paste it into your OAuth client's **Authorised redirect URIs**, trailing slash
included.

**Drive connect fails with `access_denied`** — Your Google account isn't listed as
a test user on the OAuth consent screen, or consent was dismissed.

**Uploads fail with 403 `insufficientPermissions`** — Consent was granted without
the Drive scope (Google's granular consent lets you untick it). **Disconnect**,
then **Connect Google Drive** again and leave the Drive permission ticked.

**Uploads fail with `storageQuotaExceeded`** — The Drive account is full.

**The chosen folder isn't in the list** — Expected: `drive.file` only shows
folders this extension created. Use **Create** to make one.

**Nothing happens after Start** — Check the Logs tab. If the extension was just
reloaded, also reload the Flow tab so the content script is re-injected.

---

## 19. Security and privacy

- Your Google **password is never requested, seen, or stored**. Sign-in happens
  entirely in Google's own OAuth window.
- **No client secret** exists anywhere in this project. Authorisation uses
  `chrome.identity.launchWebAuthFlow` with an implicit token response, which is
  the flow Chrome supports for extensions and which requires no secret. The
  redirect is validated with a CSRF `state` parameter.
- **Access tokens are never shown in the UI and never written to the logs.** They
  live in `chrome.storage.local` and are dropped on **Disconnect**.
- The scope is the minimum practical one: **`drive.file`**, which grants access
  only to files and folders this extension itself creates.
- **No API keys or secrets are hard-coded.** The only credential is an OAuth
  client ID, which is a public identifier by design.
- **Nothing is sent to any unrelated server.** Network traffic goes only to
  `labs.google` / `flow.google.com` (the page you're already using),
  `googleusercontent.com` (fetching the generated image bytes) and
  `googleapis.com` (your Drive). There is no analytics, no telemetry, no
  third-party endpoint.
- **Your images are uploaded nowhere except your own selected Google Drive
  folder.** Prompts, images and logs are processed locally inside the extension.
- The extension requests no `downloads` permission and no all-hosts access.

---

## 20. Architecture

```
manifest.json          MV3, pinned key, minimal permissions
config.js              single source of truth: OAuth, models, selectors,
                       failure phrases, timeouts, filename template
background.js          classic service worker; importScripts() shares the
                       modules below verbatim with no duplication.
                       Owns OAuth, ALL Drive traffic, the counter, history,
                       logs and dedupe; routes messages.
content.js             Flow automation ONLY. Finds controls, types prompts,
                       submits, detects results, runs the state machine.
                       Never talks to Drive directly.
sidepanel.html/.js     UI and state display. Never touches the Flow DOM.
styles.css             side-panel styling
services/auth.js       launchWebAuthFlow, silent refresh, scope verification
services/drive.js      folders, multipart + resumable upload, dedupe, history
services/storage.js    chrome.storage.local with a serialised read-modify-write
                       mutex; counter, settings, queue, dedupe, ref image
utils/parser.js        two-blank-line prompt parsing, TXT + PDF import
utils/composer.js      send-arrow scoring — pure, unit-tested, no DOM
utils/retry.js         bounded/unlimited retry, timeouts, abort handling
utils/logger.js        levelled persisted logger, live-broadcast to the panel
```

Files under 4 MB go up as a single multipart request; larger ones use a resumable
session with `Content-Range` PUTs. Every network call has a wall-clock timeout via
`AbortController`.

### How the prompt is actually submitted (changed in 14.1)

**Enter does not submit in Flow's current composer — it inserts a newline.** The
send control is the icon-only round arrow at the bottom-right, which has no text
label. It is identified behaviourally: `runOnce()` snapshots every composer
button's enabled state *while the editor is still empty*, and after typing the
only control that flipped from disabled to enabled is the send arrow. Chips like
*Add media*, the model name and the aspect ratio are enabled the whole time, and
are additionally rejected by name.

That scoring lives in `utils/composer.js` as a pure function of button
descriptors, so it is tested for real in `tests/run-tests.js` rather than only
inspected. Submission then walks a verified ladder — send arrow →
Cmd/Ctrl+Enter → Enter → next-best candidate → any labelled generate button —
and only moves to the next rung when no start was detected, so a prompt is never
submitted twice. A start counts as detected when the editor clears, a progress
indicator appears, a new image tile shows up, or the send control goes disabled
again.

If it ever stalls, press **Diagnose page** with Debug logging on. It prints the
whole composer button row — index, accessible name, enabled/disabled, position —
plus the submit ranking, in one line.

Key helpers in `content.js`, each with a primary strategy, a fallback and
diagnostic logging: `findPromptEditor()`, `findGenerateButton()`,
`findAddMediaButton()`, `findModelSelector()`, `findImageGenerationMode()`,
`findGeneratedImages()`, `detectGenerationState()`.

Flow's prompt box is a Slate.js `contenteditable`. The extension places a real
collapsed caret inside a Slate text node and dispatches synthetic `beforeinput`
`insertText` / `insertLineBreak` events. It never assigns `element.value`, and it
never calls `document.execCommand` — that call is what used to crash Slate with
*"Cannot resolve a Slate node from DOM node"*. Before submitting, it reads the
editor back and verifies it contains the expected text. Submission is an `Enter`
key event on the editor (the path proven to work in v13), with a full pointer-event
`realClick` on the generate button as the fallback.

---

## 21. Known limitations

- Flow is not a public API and its DOM can change without notice. The selectors
  are semantic and layered, and the extension pauses with an explanation rather
  than clicking blindly — but a large Flow redesign may still need new entries in
  `config.js → selectors`. Run **Diagnose page** first.
- PDF paragraph detection is a geometric heuristic. Review the parsed list before
  starting. Scanned PDFs need OCR first.
- `drive.file` deliberately cannot see folders the extension didn't create.
- The OAuth client ID in section 4 is unavoidably a manual, one-time step.

See `CHANGELOG.md` for what changed from v13, and `TEST-REPORT.md` for exactly
what was tested automatically and what still needs a browser.
# sahusddghv

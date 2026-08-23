# Auto Prompt v14.2 — Test Report

Date: 2026-08-22 · Build: `14.2 Flow + Drive` · Extension ID:
`cpmepjhamnhjgojlkcmnopphmpcogbin`

> **14.2 note.** A live 14.1 run failed, and the cause was found: `background.js`
> injected only `['config.js','content.js']` into an already-open Flow tab, so
> `utils/composer.js` was absent, the degraded fallback clicked Flow's
> `close clear prompt` X, and the resulting empty composer was misreported as a
> successful submit. Four fixes and **8 new AUTOMATED regression tests** (80
> total) are covered in section 1. The tests are built from the button names the
> real page logged, so they exercise the actual DOM shape rather than a guess.
> The live click itself remains `MANUAL TEST REQUIRED` (#11) — no browser was
> available here.
>
> **14.1 note.** Three live failures were reported against 14.0 and fixed here.
> The important one is that **Flow's composer treats Enter as a newline, so it
> never submits** — the send arrow has to be clicked. That new logic was
> deliberately extracted into `utils/composer.js` as a pure function *so that it
> could be genuinely unit-tested here* (11 AUTOMATED tests) rather than only
> read. The click itself, on a real page, is still `MANUAL TEST REQUIRED` (#11).

Three categories are used, and nothing is claimed beyond what was actually run:

- **AUTOMATED** — a test executed here, with the result shown.
- **STATIC** — verified by parsing/inspecting the shipped files, not by running them.
- **MANUAL TEST REQUIRED** — needs a real Chrome profile, a real Google account and
  the live Flow page. **This was not executed.** No browser, no Google session and
  no Flow page were available in the build environment, so any claim of a passing
  live run would be invented.

---

## 1. AUTOMATED — unit tests

Command:

```
cd tests && node run-tests.js
```

Node v22.23.2. The tests load the **shipped** source files (`utils/parser.js`,
`utils/retry.js`, `utils/composer.js`, `services/storage.js`, `services/drive.js`,
`config.js`) — not
copies — inside a VM context with a minimal `chrome.*` stub.

**Result: 80 passed, 0 failed.**

### utils/parser.js — prompt separation (10/10)

| Test | Result |
|---|---|
| two blank lines start a new prompt | PASS |
| ONE blank line stays inside the same prompt | PASS |
| CRLF is normalised before splitting | PASS |
| separator tolerates spaces/tabs on the blank lines | PASS |
| prompt text is preserved exactly (punctuation, case, inner spacing) | PASS |
| four or more blank lines still yield exactly two prompts | PASS |
| empty and whitespace-only input yields no prompts | PASS |
| joinPrompts round-trips through parsePrompts | PASS |
| 50 prompts parse as 50 | PASS |
| looksBinary rejects binary, accepts text | PASS |

### utils/parser.js — PDF extraction (9/9)

A real minimal PDF was constructed in the test (lines at y=700 and y=686, a 14pt
gap, then y=630, a 56pt gap) and fed through the extractor end to end.

| Test | Result |
|---|---|
| uncompressed PDF: text extracted | PASS |
| uncompressed PDF: a big vertical gap becomes a new prompt (2 prompts, first with 2 lines) | PASS |
| FlateDecode PDF: inflated via DecompressionStream and extracted | PASS |
| non-PDF bytes raise an actionable error | PASS |
| encrypted PDF is refused rather than silently mangled | PASS |
| image-only (scanned) PDF is refused with an OCR hint | PASS |
| gibberish CID text is rejected by the readability check | PASS |
| TJ arrays with large negative kerns become spaces | PASS |
| escaped parentheses and octal codes decode correctly | PASS |

### utils/retry.js (7/7)

| Test | Result |
|---|---|
| succeeds on the first attempt without delay | PASS |
| retries until success | PASS |
| stops at the attempt cap and reports the count | PASS |
| shouldRetry=false stops immediately (non-retryable HTTP) | PASS |
| an abort signal is never retried | PASS |
| attempts:0 means unlimited (v13 FastRetry behaviour) | PASS |
| retryable HTTP statuses classified correctly (408/429/5xx retry; 4xx do not) | PASS |

### services/storage.js — counter, queue, dedupe (13/13)

| Test | Result |
|---|---|
| the very first file is 001 (no off-by-one) | PASS |
| the counter advances one file at a time | PASS |
| a custom start number is honoured (047 → 047, 048, 049) | PASS |
| 6 concurrent reservations produce 6 distinct numbers | PASS |
| handing a number back on failure leaves no gap | PASS |
| filenames respect the configured padding and extension | PASS |
| the counter survives a reload (it lives in storage) | PASS |
| settings merge over the defaults and persist | PASS |
| duplicate protection matches on source URL | PASS |
| duplicate protection also matches on content hash alone | PASS |
| an unseen image is not treated as a duplicate | PASS |
| queue items update in place without losing siblings | PASS |
| history is newest-first, bounded, and every entry gets an id | PASS |

### services/drive.js — hashing helpers (3/3)

| Test | Result |
|---|---|
| base64 decoding handles bare base64 and data URLs identically | PASS |
| SHA-256 is stable, content-sensitive, 64 hex chars, and matches Node's crypto | PASS |
| folder/file links are well-formed, and a missing id returns `null` rather than a fake link | PASS |

### config.js — model alias matching (5/5)

The matching algorithm content.js uses (longest alias wins) was run against the
shipped `AP_CONFIG.models`.

| Test | Result |
|---|---|
| "Nano Banana 2 Lite" → `nano-banana-2-lite`, **not** `nano-banana-2` | PASS |
| "Model: Nano Banana 2 Lite (Fast)" → `nano-banana-2-lite` | PASS |
| "Nano Banana 2" → `nano-banana-2` | PASS |
| "Nano Banana Pro" / "nanobanana pro" → `nano-banana-pro` | PASS |
| an unrelated label matches nothing (so the run pauses instead of guessing) | PASS |
| exactly three models, with the required ids and labels | PASS |

---

### utils/composer.js — send-arrow scoring (11/11) — NEW IN 14.1

`utils/composer.js` is a UMD module: a content script in Chrome, a CommonJS module
in the test runner. The tests therefore exercise **the shipped file itself**, with
button descriptors mirroring the row observed on a live Flow project page —
`Add media`, the model chip, `16:9`, `Settings`, then an unlabelled 40x40 control
at the bottom-right that was disabled while the editor was empty.

| Test | Result |
|---|---|
| the icon-only arrow that flipped disabled → enabled wins over every labelled chip | PASS |
| "Add media" and the model chip are rejected outright, not merely outranked | PASS |
| a disabled control is never a submit candidate (no clicking greyed-out buttons) | PASS |
| a labelled "Generate" button still scores as a submit control | PASS |
| Flow's `x1`/`x4` output-count chips are rejected | PASS |
| a long prose label (placeholder text) is rejected | PASS |
| between two icon-only buttons, the rightmost square one at the bottom edge wins | PASS |
| with no before-snapshot (mid-run recovery) an unlabelled arrow is still found | PASS |
| normalisation collapses nbsp and case so aria-labels match reliably | PASS |
| the module really is dual-mode, and the manifest injects it before `content.js` | PASS |
| `content.js` calls the scorer, snapshots the empty editor, and verifies the start | PASS |

One further check confirms the empty-file guard: `timeouts.minImageBytes` is set,
`content.js` enforces it, and a `blob:` URL never falls through to a canvas
re-encode. | PASS

### 14.2 regressions — built from the real logged button names (8/8) — NEW IN 14.2

These eight tests are not synthetic. The helper `realFlowComposer()` transcribes
the exact accessible names a live Flow project page printed to the log, including
the Material Symbols ligature prefixes:

```
arrow_back go back | more_vert more options | add add media | help product help |
more_vert more | plus | search search | filter_list sort & filter | add_2 create |
agent | nano banana pro crop_16_9 x1 | close clear prompt | arrow_forward create
```

| Test | Result |
|---|---|
| on the real composer, `arrow_forward create` is the chosen submit control | PASS |
| `close clear prompt` can never be a candidate — even given a perfect behavioural signature (the 14.1 bug) | PASS |
| `add_2 create`, `plus` and `add add media` are rejected despite containing "create" | PASS |
| `arrow_forward create` outscores a plain unlabelled button | PASS |
| `content.js` has a `NEVER_CLICK_RE` deny list for the degraded no-module path, and no longer contains "falling back to the last composer button" | PASS |
| an empty composer alone is not treated as a successful submit — "editor cleared" appears in `weakStartSignal`, never in `strongStartSignal` | PASS |
| the prompt is retyped if a previous attempt emptied the composer | PASS |
| `background.js` injects exactly what the manifest declares (the root-cause fix) | PASS |

The last one is the important one: it reads `manifest.json`'s `content_scripts[0].js`
and asserts `background.js` derives its `executeScript` file list from
`chrome.runtime.getManifest()`, and that any hard-coded fallback list still matches
the manifest exactly. The 14.1 failure was precisely these two lists disagreeing.

---

## 2. AUTOMATED — build, manifest and policy checks

| Check | Result |
|---|---|
| `node --check` on all 10 JS files | PASS — no syntax errors |
| `manifest.json` parses, is `manifest_version: 3` | PASS |
| side panel path, classic (non-module) service worker | PASS |
| every content-script file listed in the manifest exists | PASS |
| every local `src`/`href` in `sidepanel.html` exists on disk | PASS |
| every file in `background.js`'s `importScripts()` exists | PASS |
| required permissions present (storage, tabs, scripting, sidePanel, identity) | PASS |
| the **`downloads` permission is absent** (Drive-only, no local fallback) | PASS |
| no all-hosts (`https://*/*`) host permission | PASS |
| `config.js` prompt separator is identical to the parser's | PASS |
| OAuth scope is exactly `drive.file` (least privilege) | PASS |
| **no `client_secret` reference and no `GOCSPX-` literal in any file** | PASS |
| **no live `execCommand(` call in `content.js`** (only comments explaining why) | PASS |
| no `el.value =` assignment on the Slate editor | PASS |
| no "TODO: implement" or "not implemented" anywhere | PASS |
| ≥10 failure phrases configured (not one English string) | PASS — 17 |
| the v13 `labs.google/fx/api/trpc/media` pattern is present **plus fallbacks** | PASS |
| **no positional selector** such as `buttons[10]` in any file | PASS |
| no obsolete/invented model names (`imagen 4`, `nano banana lite`, video models) | PASS |

Additional static audits run during the build:

| Check | Result |
|---|---|
| every `$('id')` in `sidepanel.js` exists in `sidepanel.html` | PASS — 0 missing |
| message wiring audited in all three directions (panel ↔ worker ↔ content script) | PASS — 0 orphaned actions, 0 unhandled sends |
| ZIP integrity (`unzip -t`) | PASS |

---

## 3. STATIC — reviewed by reading the code, not executed

These are design guarantees confirmed by inspection. They exercise browser APIs
(DOM, Slate, `chrome.identity`, live Drive) that cannot run in Node.

- The **only** place `R.index` is incremented is after `uploadAll()` resolves,
  which itself only resolves once every captured image has a confirmed Drive file
  ID. No timer, poll tick or fixed delay can advance the queue.
- A failure path never increments the prompt number; `R.pending[i]` is reused so an
  upload retry cannot trigger a regeneration.
- `typePrompt()` returns `textMatches(editor, text)` and the caller refuses to
  submit on `false`.
- `background.js → START` calls `APDrive.ensureReady()` and throws before any
  prompt is submitted; there is no code path from an upload failure to a local
  save.
- `uploadGeneratedImage()` reserves the counter after the dedupe check and calls
  `APStore.setCounter(counter)` on every failure branch.
- Access tokens are read only inside `services/auth.js` / `services/drive.js` and
  are never passed to a log call or the panel.
- Every `fetch` is wrapped by `APRetry.fetchWithTimeout` with an `AbortController`.
- Each `find*()` helper has a primary strategy, a fallback, diagnostic logging, and
  returns `null` (→ pause) rather than a guess.

---

## 4. MANUAL TEST REQUIRED — not executed

Nothing below was run. Each needs Chrome, a Google account and the live Flow page.

**Install & OAuth**

1. `MANUAL TEST REQUIRED` — Load unpacked; confirm the ID is
   `cpmepjhamnhjgojlkcmnopphmpcogbin` and that the worker starts with no errors.
2. `MANUAL TEST REQUIRED` — Create the OAuth client, register the redirect URI,
   paste the client ID, reload, click **Connect Google Drive**; expect
   **Google Drive Connected ✓**.
3. `MANUAL TEST REQUIRED` — Wrong redirect URI → expect the `redirect_uri_mismatch`
   message naming the exact URI to register.
4. `MANUAL TEST REQUIRED` — Untick the Drive permission at the consent screen →
   expect the granular-consent error, not a silent failure.
5. `MANUAL TEST REQUIRED` — **Disconnect** → the chip returns to *Not connected*
   and no token remains in `chrome.storage.local`.

**Drive folders & uploads**

6. `MANUAL TEST REQUIRED` — Default folder **Auto Prompt** is created at the Drive
   root on first connect.
7. `MANUAL TEST REQUIRED` — **Create** a folder, then **Choose folder**; uploads
   land in the selected folder.
8. `MANUAL TEST REQUIRED` — A >4 MB image takes the resumable path and completes.
9. `MANUAL TEST REQUIRED` — Kill the network mid-upload → expect
   *"Drive upload failed — retrying…"*, then either success or
   *"Queue paused because Google Drive upload failed."* with Retry/Resume/Stop.

**Flow automation**

10. `MANUAL TEST REQUIRED` — The prompt editor is found on a live Flow project page
    and receives the prompt **verbatim**, including a prompt containing a single
    internal blank line.
11. `MANUAL TEST REQUIRED` — **The single most important manual test.** Clicking the
    detected send arrow actually starts a generation, and Slate does **not** throw
    *"Cannot resolve a Slate node from DOM node."* With Debug on, the log should show
    `Submit candidates ranked` naming an `(icon)` candidate with the highest score,
    then `Generation started (…) after send arrow`. If instead it falls through to
    `Cmd/Ctrl+Enter` or `Enter`, the scoring picked the wrong control — run
    **Diagnose page** and read the `Composer buttons (DOM order):` line.
12. `MANUAL TEST REQUIRED` — Each of the three models is selected and read back
    correctly; "Nano Banana 2 Lite" is not confused with "Nano Banana 2".
13. `MANUAL TEST REQUIRED` — With the model absent from Flow's menu, the log prints
    *"Model options Flow is showing right now: …"* with Flow's real labels, and with
    **"keep the model Flow already has"** ticked the run continues while WARNing which
    model is actually in use. Untick it and the run must stop instead.
14. `MANUAL TEST REQUIRED` — Image output is enforced; no video job is ever queued.
15. `MANUAL TEST REQUIRED` — 16:9, 9:16 and 1:1 are applied.
16. `MANUAL TEST REQUIRED` — Image → Image: the reference attaches **once** and is
    reused for all prompts; it is never uploaded to Drive as a result.
17. `MANUAL TEST REQUIRED` — New-image detection ignores avatars, icons, earlier
    generations and the reference image.
18. `MANUAL TEST REQUIRED` — Outputs-per-prompt > 1: each output gets its own
    number and its own Drive file.

**Queue behaviour**

19. `MANUAL TEST REQUIRED` — A 50-prompt run produces exactly 50 Drive files
    numbered `001.jpg`–`050.jpg`, with no gaps and no duplicates.
20. `MANUAL TEST REQUIRED` — Start number `47` produces `047.jpg` onward.
21. `MANUAL TEST REQUIRED` — Force a Flow failure → the **same** prompt retries and
    keeps its number; nothing is skipped.
22. `MANUAL TEST REQUIRED` — Cap retries at 2 and exhaust them → the queue pauses
    and offers Retry / Skip / Stop.
23. `MANUAL TEST REQUIRED` — Pause mid-run, then Resume: prompt, queue, model,
    reference image, folder and counter are all preserved.
24. `MANUAL TEST REQUIRED` — Stop starts nothing further.
25. `MANUAL TEST REQUIRED` — Reload the Flow tab mid-run → *"The page reloaded
    during a run. Recovered at Prompt NNN of X — press Resume to continue."* and it
    does **not** restart at 001.
26. `MANUAL TEST REQUIRED` — Re-run an already-uploaded prompt set → duplicate
    protection prevents a second upload of the same image.

**UI**

27. `MANUAL TEST REQUIRED` — All five tabs render and update live in a narrow panel.
28. `MANUAL TEST REQUIRED` — History shows real Drive file IDs and the
    **Open in Google Drive** links resolve.
29. `MANUAL TEST REQUIRED` — Debug mode logs editor/buttons/model/state/candidates/
    upload status; Copy and Export both work.
30. `MANUAL TEST REQUIRED` — **Diagnose page** reports found/missing controls.
31. `MANUAL TEST REQUIRED` — Import a real multi-page PDF of prompts and confirm the
    parsed list against the source before running.

---

## 5. Summary

| Category | Count | Status |
|---|---|---|
| Unit tests (shipped source, Node) | 80 | 80 pass, 0 fail |
| Build / manifest / policy checks | 22 | all pass |
| Static design guarantees reviewed | 8 | consistent with the requirements |
| Live browser scenarios | 33 | **MANUAL TEST REQUIRED — not executed** |

The package loads and its logic is verified as far as it can be without a browser.
The end-to-end path — real Flow DOM, real OAuth consent, real Drive uploads —
genuinely has not been exercised, and the first live run should be a 2–3 prompt
smoke test with Debug logging on before a 50-prompt batch.

### What could not be verified, and why

- **No live run.** No browser, Google session or Flow page existed in the build
  environment. Scenario #11 (the send-arrow click) is the fix's load-bearing step
  and it is unverified on a real page. The scoring it depends on *is* tested; the
  DOM it will meet is not.
- **Flow's current model line-up was not researched.** Web search was unavailable
  in the build environment (`web_search` is not supported for this model), so
  rather than guess at labels, 14.1 discovers them at runtime and logs them. The
  three configured models and their ids are unchanged.
- **Existing Drive artefact.** An earlier 14.0 run uploaded a 0 kB `001.jpg` from a
  `blob:` placeholder. The guard added in 14.1 prevents a repeat, but that file is
  still in Drive and should be deleted by hand; Settings → **Clear duplicate
  memory** lets the number be reused.

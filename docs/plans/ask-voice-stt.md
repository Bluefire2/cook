# Ask voice input (speech-to-text)

Let the recipe Ask assistant accept spoken questions through the phone
microphone. Replies stay text. This is dictation into the existing composer,
not a spoken conversation.

Parent surfaces: `src/components/ChatPanel.tsx` (the only Ask UI) mounted from
`src/screens/RecipeView.tsx`. There is no separate cooking-mode chat; RecipeView
always passes `cookingState` and already holds a screen wake lock.

## Open questions

### BLOCKING 1 — Where does speech become text?

Recommended default: **browser Web Speech API**
(`SpeechRecognition` / `webkitSpeechRecognition`) in the client. No new npm
dependency, no new `/api` route, no audio upload through Sous, no extra Google
OAuth scope, no Cloud Speech-to-Text product.

Why: AGENTS.md forbids extra Google APIs and extra OAuth scopes; chat framing
(`0x1E`) must not change; screens must not grow a second fetch style. The
request is “enter input text using the phone mic”, which the browser can do.

Cost of that default (must be disclosed, not hidden):

- **Chrome / Android Chrome** send microphone audio to Google’s speech service
  (the browser’s, not a Sous endpoint). Today `public/privacy.html` says
  Gemini + URL import + Google Cloud hosting and then “Nothing else.” That
  sentence would be false once Chromium dictation ships.
- **Safari / iOS** can do on-device recognition after a permission grant
  (language pack). Support is **partial**: iOS 14.5+, including standalone
  PWA, but sessions stop on their own, first-tap can miss, and `continuous`
  is unreliable. Firefox has the API behind a flag — treat as unsupported.
- Chromium still prefixes the constructor as `webkitSpeechRecognition`.

Fallback slice (only if this question is answered “Sous must transcribe”):
`MediaRecorder` → session-authenticated `POST /api/stt` using the already
configured Gemini API, then fill `draft`. That is a new route under `server/`,
a legal rewrite (Sous would handle audio), and a later plan. Do not mix it
into this slice.

**Need from you:** accept the Web Speech API default (plus a privacy-page
sentence about the *browser* speech service), or reject it in favour of a
Sous-side Gemini STT slice. The expanded comparison and pause notes below
are the rest of this question — they do not add a third option.

### BLOCKING 2 — Does a finished utterance send, or only fill the box?

The request says “enter input text”. That is **fill `draft`, user taps Send**
(they can fix kitchen-noise mistakes; photos already attached stay attached).

The cooking-with-messy-hands reading is **auto-send on `isFinal`** so a second
tap is unnecessary.

Recommended default: **fill, do not auto-send.** Interim results appear live
in the textarea; the final result replaces that interim span; Send stays
explicit. A follow-up can add auto-send once dictation quality is trusted.

**Need from you:** fill-then-Send (recommended) or auto-send on final.

### Non-blocking

- **Language.** Plan uses `document.documentElement.lang` (`en` in
  `index.html`) with `en-US` if the recognizer rejects a short tag. A later
  Settings locale is out of scope.
- **Hold-to-talk vs tap.** Plan uses **tap to start, tap to stop** (also
  stops on the browser’s `onend`). Hold requires a clean finger on the
  control the whole time.
- **Dedicated “voice mode” screen.** Plan is a mic control in the existing
  composer, not a full-screen overlay. Say so if you wanted a mode you enter.

## How the two STT paths differ

Same product either way: mic on the Ask composer, transcript becomes
`draft` / `ChatMessage.content`, assistant output stays text. The split is
**who transcribes, and what we control**.

### A — Browser Web Speech API (recommended default)

The page constructs `SpeechRecognition` / `webkitSpeechRecognition`, calls
`start()` from the mic tap, and writes `onresult` transcripts into the
textarea. Sous never sees the recording.

| | |
| --- | --- |
| **Who hears the audio** | The browser’s speech engine. Chrome / Android Chrome send it to Google’s *browser* speech service (not `/api/chat`, not Gemini). Safari / iOS can do on-device recognition after a permission / language-pack grant. |
| **What Sous stores** | The resulting text, as a normal chat message. |
| **Live text while speaking** | Yes (`interimResults`). Words appear as you talk. |
| **Latency** | Low. Partials stream in; no extra Sous round-trip. |
| **New backend** | None. No `/api/stt`, no audio MIME handling, no size cap on our server. |
| **Dependencies / GCP** | None. Does not add Cloud Speech-to-Text, extra OAuth scopes, or a second Gemini call. |
| **Legal** | One privacy sentence: on some browsers the *browser* sends mic audio to its speech service. Sous does not upload the recording. |
| **iOS PWA** | Partial and flaky (sessions die, first tap can miss, `continuous` is unreliable). Same class of risk as iOS standalone OAuth. |
| **Firefox** | Treat as unsupported; hide the mic. |
| **Cost to us** | $0. (Chrome’s speech service is on Google’s side, not billed on `GEMINI_API_KEY`.) |
| **Code size** | Small: helper + ChatPanel mic. Fits this slice. |

Kitchen noise can still produce a bad transcript; the user edits the box
(if BLOCKING 2 stays fill-then-Send).

### B — Sous-side STT (`MediaRecorder` → `POST /api/stt` → Gemini)

The page records a clip with `getUserMedia` + `MediaRecorder`. On stop it
POSTs the blob to a new session-authenticated route under `server/` (client
helper next to `chatApi.ts`, not a screen `fetch`). The handler sends the
audio to the **already configured** Gemini API as `inlineData` (same
pattern as chat photos) and returns text. That fills `draft`.

This is **not** Cloud Speech-to-Text and adds **no OAuth scopes**. It *does*
send a new kind of payload (audio) through Sous to Gemini. AGENTS.md’s
“no extra Google APIs” is about identity / new GCP products; Gemini audio
would still be a product + legal change.

| | |
| --- | --- |
| **Who hears the audio** | Sous (briefly, in the request) then Gemini. We would retain or discard the blob in the handler — default: transcribe and drop, never write audio to Firestore/GCS. |
| **What Sous stores** | Text only, same as A, unless we later choose to keep clips (out of scope). |
| **Live text while speaking** | No in v1. The box stays empty (or shows “Transcribing…”) until the clip is done *and* Gemini answers. Streaming STT is a later complication. |
| **Latency** | Higher. Speak → stop → upload → Gemini → text. A 8s question plus model time, not word-by-word. |
| **New backend** | Yes: `server/` route, auth, allowlist, body size limit, MIME (`audio/webm` vs iOS `audio/mp4`), errors. Duplicate the session check if a Vercel `api/` copy is required — chat already has that pain. |
| **Legal** | Rewrite Third parties: Sous *does* receive microphone audio and passes it to Gemini. Stronger than A. `terms.html` may need a line too. |
| **iOS PWA** | Recording via `getUserMedia` is the well-trodden path (we already attach photos from the camera). Reliability is better than Web Speech on iPhone; it is not free (autoplay / audio-session quirks, but we are not playing TTS). |
| **Firefox** | Works (MediaRecorder is there). Mic would show. |
| **Cost to us** | Gemini audio tokens per utterance, on top of the later chat turn. |
| **Code size** | A second slice: server + client recorder + silence gate + privacy. Do not mix into the Web Speech steps. |

Chat photos already go device → Sous → Gemini as `inlineData`. Path B is
that pattern for sound. Path A never puts the sound on our server.

### What does *not* change between A and B

- Ask still lives only in `ChatPanel`.
- Replies stay text. No TTS.
- `ChatMessage` schema unchanged.
- `/api/chat` framing (`0x1E`) unchanged.
- Fill-vs-auto-send (BLOCKING 2) is independent: either path can fill the
  box or call `send()` once we have a final string.

Pick A unless you need (1) a pause length we own, (2) iPhone reliability
as a day-one requirement, (3) Firefox, or (4) audio that only Gemini (via
Sous) may see — not Chrome’s separate speech service.

## End-of-utterance pause — can we tune it?

Two different “done”s:

1. **This spoken span is over** (stop listening / mark the transcript
   final). That is the pause question.
2. **Send the chat message.** That is BLOCKING 2 and is a tap (or
   auto-send) *after* (1). Tuning the pause never sends by itself unless
   we also choose auto-send.

### Path A (Web Speech API): not really

The spec exposes `lang`, `continuous`, `interimResults`, `maxAlternatives`.
There is **no** `silenceTimeout` / `pauseMs` / endpointing attribute.
`speechend` is a notification that the engine already decided speech
stopped; it is not a knob.

What the engine does:

- `continuous: false` (this plan’s default): after a short, **browser-
  defined** quiet period it finalizes one result and ends the session.
  Chrome’s gap is often ~1s; iOS is jumpy and can cut mid-thought. We
  cannot set 400ms vs 2s.
- `continuous: true`: it keeps listening until `stop()` / `abort()` or
  the engine dies. Pause length still is not ours.

Workaround we *could* add later, still on path A: `continuous: true`,
reset a timer on every `onresult`, and `stop()` after **N ms with no new
transcript**. That N is ours (e.g. 1500ms). Limits:

- It measures **no new words**, not true silence. A thinking pause with
  no interim is “done”; extractor-hood noise that the engine turns into
  junk words **resets** the timer.
- iOS `continuous` is the flaky mode. A pause timer that depends on it
  is a poor cooking-phone bet.
- The engine may still `speechend` / `onend` on *its* schedule before N.

So: **no first-class tunable pause on path A.** Tap-to-stop is the
reliable “I’m done” (already in the plan). A software gap-timer is a
best-effort extra, not a setting we should advertise.

If BLOCKING 2 stays fill-then-Send, a too-short engine pause is annoying
but recoverable: listening drops, text stays in the box, tap mic to
continue, tap Send when ready. If BLOCKING 2 is auto-send, a too-short
pause **sends an unfinished question** — much worse, and we cannot
lengthen the engine’s VAD.

### Path B (Sous recorder): yes

We own the clip. After `getUserMedia`, an `AnalyserNode` (or a time
since last loud RMS) can treat “level below threshold for **P ms**” as
end-of-utterance, then stop `MediaRecorder` and POST. **P is our
constant** (and could become a setting later). Tap-to-stop still wins
if they finish sooner.

Typical cooking default: P ≈ 1200–2000ms so “wait — is it 350 or 375?”
does not cut the sentence. Threshold needs a floor so a fridge hum does
not look like speech.

Trade: no live captions while that pause is elapsing; transcription
starts only after we decide the clip ended.

### Plan implication

v1 on path A: **do not promise a pause control.** Done = tap mic again
(or the engine’s own `onend`). If a tunable pause is a requirement for
shipping, that is a vote for path B, not a Web Speech tweak.

## Goal

On a phone (Chrome Android and iOS Safari / installed PWA), open a recipe,
open Ask, tap the mic, speak, see text in “Ask the assistant…”, tap Send.
The assistant still streams a text reply (and optional recipe proposal) as
today. Typed input, photo attach, and keyboard dictation keep working.

## Decisions (not blocking once Open questions are answered)

- **Surface:** ChatPanel composer only. No Library / Import / Settings mic.
- **Output:** no `speechSynthesis`, no auto-read of replies. The iOS bug
  where SpeechRecognition hangs after `<audio>` playback is therefore
  irrelevant — we never play assistant audio.
- **Transcript storage:** the spoken string is `ChatMessage.content`, same as
  typing. Do not add fields to `Recipe`, `ChatMessage`, or `CookStateRow`.
- **No `getUserMedia` in v1.** `recognition.start()` from the tap is the user
  gesture. A separate `getUserMedia` prompt would be a second permission and
  is not required for Web Speech. If iOS first-utterance misses in testing,
  a later step can warm the audio session; do not add it speculatively.
- **Hide the mic when the constructor is missing** (Firefox, old Safari).
  Do not ship a dead control. When the constructor exists, always show it;
  permission / no-speech / `not-allowed` use ChatPanel’s existing error
  strip.
- **One recognizer per ChatPanel mount**, created lazily on first tap,
  `stop()`/`abort()` on unmount, Close, and when `busy` becomes true.
- **`interimResults: true`.** Live text in the textarea. Track
  `draftBase` (text before this utterance) so interim chunks replace each
  other instead of stacking.
- **`continuous: false`.** iOS is more stable this way. While the user still
  wants listening (`listening === true`), `onend` may restart once from the
  same tap session. Do not loop forever if `start()` throws.
- **`lang`:** `document.documentElement.lang` or `'en-US'`.
- **Busy / streaming:** mic is disabled and any active recognition is aborted
  so a late `onresult` cannot clobber a send in flight.
- **Empty finals:** ignore; do not clear a typed draft.
- **HTTPS:** production is `https://sous.kyrylo.lol`. Local Vite on
  `http://localhost:5173` is a secure context. No Permissions-Policy header
  is required (microphone defaults to self).
- **Legal:** one sentence in `public/privacy.html` Third parties: on some
  browsers, using the mic sends audio to that browser’s speech service
  (Chrome: Google). Sous does not receive the audio. `public/terms.html`
  does not name processors; leave it unless BLOCKING 1 chooses Sous-side
  STT.
- **UI tokens:** new mic uses the attach-button size (`h-10 w-10 rounded-full`)
  and `ui-polish` hover/active twins. Listening fill is amber
  (`bg-amber-500` / `hover:bg-amber-600 active:bg-amber-600`) to match the
  Ask FAB and cook chrome. Idle fill matches attach
  (`bg-surface-muted` / `hover:bg-line-strong active:bg-line-strong`).
- **a11y:** `aria-label="Dictate"` idle, `aria-label="Stop dictation"` while
  listening, `aria-pressed` bound to listening. Not emoji-only.
- **No new React Context, no `<Button>` component, no enums**
  (`erasableSyntaxOnly`).
- **Tests:** pure helper only. No DOM testing library, no Playwright.

## Out of scope

- Text-to-speech / spoken replies / wake word / always-on listening
- A new cook-mode screen (RecipeView already *is* cook mode + `useWakeLock`)
- Changing `/api/chat`, Gemini request shape, `0x1E` framing, `maxDuration`
- New Dexie tables, ChatMessage fields, WebSockets, polling
- Extra Google OAuth scopes, Cloud Speech-to-Text, Auth.js
- Firefox (API disabled); desktop is a nice-to-have for implementer testing
- Auto-punctuation product work beyond whatever the recognizer returns
- iOS keyboard dictation (already works if the textarea is focused; we do
  not disable it)

## Starting state (verified by reading the code)

- `ChatPanel` composer (end of `src/components/ChatPanel.tsx`): hidden file
  input, 📷 attach (`h-10 w-10 rounded-full`), `<textarea value={draft}>`,
  Send. `send()` no-ops when `draft` is empty and there are no pending
  photos, or when `busy` (`streamingText !== null`).
- Close / unmount already `abort()`s the in-flight chat `AbortController`.
  Recognition needs the same lifecycle; it does not exist today.
- `cookingState` is always passed from RecipeView (`servings`, 1-based
  `currentStep`, checked ingredient names). Irrelevant to STT.
- `index.html` is `lang="en"`, `apple-mobile-web-app-capable`, viewport-fit
  cover. PWA `display: standalone` in `vite.config.ts`.
- `src/lib/uiClasses.ts` has `iconBtn` (rounded-lg, not the circular attach
  treatment). Attach’s classes are local to ChatPanel — **copy that local
  pattern** for the mic, do not force `iconBtn`.
- No `SpeechRecognition` usage anywhere in `src/`. TypeScript `lib` is
  `DOM` — the unprefixed interface exists in current DOM libs; the
  `webkit` alias does not. The helper must read
  `(window as Window & { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition`.
- Unit tests in this repo are Vitest over pure modules (`chatApi.test.ts`
  stubs `fetch`). Speech result-folding belongs in a testable helper.

## Files to change

- `src/lib/speechRecognition.ts` — **new**. Constructor lookup, error
  mapping, `foldSpeechResults` (interim vs final).
- `src/lib/speechRecognition.test.ts` — **new**.
- `src/components/ChatPanel.tsx` — mic button, listening state, wire helper.
- `public/privacy.html` — Third parties sentence (date bump if the page
  has a last-updated line).
- `docs/plans/ask-voice-stt.md` — this file (already).
- `AGENTS.md` Plans table — add this row as unfinished until implemented.

Do not change `src/lib/chatApi.ts`, `api/chat.ts`, server chat handlers,
`src/lib/chatStore.ts`, Recipe/ChatMessage types, `vite.config.ts`,
`index.html`, or `src/lib/uiClasses.ts` unless a class string is clearly
shared (it is not; attach is local).

## Steps

### 1. [core] Speech helper and tests

Files: `src/lib/speechRecognition.ts`, `src/lib/speechRecognition.test.ts`

Export (names may vary; behaviour must not):

```
getSpeechRecognitionCtor(): (new () => SpeechRecognition) | null
  window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null

mapSpeechError(code: string): string
  'not-allowed' | 'service-not-allowed'
    → 'Microphone access was blocked — allow it for this site and try again.'
  'no-speech'
    → 'No speech heard — tap the mic and try again.'
  'audio-capture'
    → 'No microphone was found.'
  'network'
    → 'Dictation needs a network connection on this browser.'
  default
    → 'Dictation failed — try again.'

foldSpeechResults(
  draftBase: string,
  results: ReadonlyArray<{ isFinal: boolean; transcript: string }>,
): { nextDraft: string; nextBase: string }
```

`foldSpeechResults` rules (lock in tests):

- Concatenate **final** transcripts (trimmed, single spaces between) onto
  `draftBase`. If `draftBase` is non-empty and does not already end in
  whitespace, insert one space before the first final.
- Append the latest **interim** transcript the same way, but do not advance
  `nextBase` until finals land. A later interim replaces the previous
  interim, it does not append to it.
- Empty transcripts are no-ops.

Do not wrap `start()` in this module — ChatPanel owns the instance and
events so unmount can `abort()` without a hidden singleton leaking across
recipes.

No enums. Error codes stay string literals.

### 2. [core] Privacy sentence

File: `public/privacy.html`

In **Third parties**, replace the closing “Nothing else.” so the paragraph
still lists Gemini (chat text + photos), URL import, and hosting, and **adds**
that tapping Dictate on some browsers sends microphone audio to that
browser’s own speech service (Chrome uses Google). Sous does not upload the
recording; the transcript is then a normal chat message.

Bump “Last updated” if present. Do not mention Cloud Speech-to-Text or a
Sous `/api/stt`. Do not edit `terms.html` in this slice.

Skip this step only if BLOCKING 1 is answered “no disclosure / don’t ship
Chromium dictation.”

### 3. [ui] Mic control in ChatPanel

File: `src/components/ChatPanel.tsx`

State (local, not store):

- `listening: boolean`
- `draftBaseRef` — string the current utterance started from
- `recognitionRef` — the `SpeechRecognition` instance or null

Constructor: call `getSpeechRecognitionCtor()` once per mount (or once per
render is fine if it is cheap). If null, render no mic.

Layout, composer row, between attach and textarea:

```
[ 📷 attach ] [ mic ] [ textarea ] [ Send ]
```

Idle mic: same geometry as attach (`flex h-10 w-10 shrink-0 items-center
justify-center rounded-full bg-surface-muted … hover:bg-line-strong
active:bg-line-strong`). Glyph: a simple mic character or inline SVG; must
have `aria-label`.

Listening: `bg-amber-500 text-white hover:bg-amber-600 active:bg-amber-600`,
`aria-pressed={true}`. Optional `animate-pulse` is allowed; do not add a
new token.

Disabled when `busy`. Clicking while `busy` is a no-op.

**Tap handler:**

1. If `listening`, `recognition.stop()` (not `abort()` — let a pending
   final flush), set `listening` false. Return.
2. If ctor is null, return (control should be hidden).
3. Lazily `new ctor()`, set `interimResults = true`, `continuous = false`,
   `lang` as in Decisions. Bind:
   - `onresult` → `foldSpeechResults(draftBaseRef, mapped results)` →
     `setDraft` / update base ref
   - `onerror` → `setError(mapSpeechError(event.error))`, `listening` false
   - `onend` → if `listening` still true, try `start()` once inside
     try/catch; on throw, `listening` false and map a generic error
4. Set `draftBaseRef` to current `draft` (trimEnd only if you need a
   separator; prefer letting `foldSpeechResults` insert the space).
5. `setError(null)`, `listening` true, `start()` inside the click stack
   (user gesture). If `start()` throws, reset listening and show the mapped
   error.

**Abort recognition** (use `abort()`, drop listening) when:

- ChatPanel unmounts (extend the existing cleanup effect that already
  aborts `inFlight`)
- Close is pressed (`onClose`)
- `busy` becomes true (effect on `busy`, or first line of `send`)
- Escape already closes the sheet — unmount covers it

Do not call `send()` from recognition events unless BLOCKING 2 is answered
auto-send. If it is, auto-send only when `foldSpeechResults` produced a
non-empty `nextBase` change, `!busy`, and listening was turned off by
`onend` with the user still in “one tap” mode — **do not** auto-send every
interim.

Placeholder can stay “Ask the assistant…”. While listening, do not steal
focus into the textarea (that would pop the keyboard on iPhone and defeat
the point).

Photo + voice: unchanged `pendingPhotos`; `send()` already concatenates
`draft` + photos.

Typed text during listening: allowed (onChange updates `draft`). Do not try
to keep `draftBaseRef` in sync with mid-utterance typing; a mixed edit is
best-effort. Stopping then starting a new tap resets the base.

### 4. [core] Plans table

File: `AGENTS.md`

Add a row:

`docs/plans/ask-voice-stt.md` | Planned. Ask composer speech-to-text (Web
Speech API); output remains text.

Do not retitle other rows. Do not start photos/deploy/end-state work here.

## Deferred

- **Sous-side STT (`/api/stt` + Gemini)** if Web Speech is too flaky on
  the user’s iPhone, privacy forbids Chromium’s speech service, or we
  need a pause length we own (see “End-of-utterance pause”). Needs a new
  plan, legal rewrite, and a client helper next to `chatApi.ts`.
- **iOS `getUserMedia` warmup** if the first tap after opening Ask never
  fires `onresult`.
- **Auto-send** if BLOCKING 2 stays “fill”.
- **Continuous listening / barge-in** while the assistant streams. Out of
  scope; `busy` disables the mic.
- **Per-recipe language** (imported recipes in French, etc.).
- **Firefox** (`media.webspeech.recognition.enable`).

Residual risk: iOS standalone PWA dictation will be worse than Android
Chrome. That is accepted for v1 if BLOCKING 1 stays Web Speech. If the
first iPhone check is “start() hangs with no events”, stop and write the
STT-endpoint plan instead of piling WebKit workarounds (same rule as OAuth:
do not invent extra workarounds).

## Verification

No DOM test runner. After implementation:

1. `npm test` — helper cases: finals append with a space; interims replace;
   empty ignored; `getSpeechRecognitionCtor` null without the globals;
   every `mapSpeechError` branch.
2. `npm run build` — type gate, including the `webkit` constructor cast.
3. Browser (Vite + `dev:api`, signed in, `http://localhost:5173`):
   - Desktop Chromium with mic: RecipeView → Ask → Dictate → speak → text
     in the box → Send → **text** reply streams as today. Mic idle after
     send.
   - Deny microphone: error strip, draft untouched, typed send still works.
   - Hide-mic: Firefox or a Chromium session with the API stubbed off —
     composer is attach + textarea + Send only.
   - Attach a photo, dictate, Send: user bubble has photo + transcript.
   - Start dictation, tap Close: no leftover listening indicator, no
     permission indicator stuck on (recognition aborted).
   - Start dictation, tap Send with existing draft: recognition aborts,
     send proceeds, no second send from a late `onresult`.
4. Phone (required for the feature, not optional polish):
   - Chrome Android, installed PWA if available.
   - iOS Safari **and** Add-to-Home-Screen standalone. If standalone fails
     where Safari-tab works, record it in the PR; do not invent a second
     STT stack in the same slice.
5. Confirm Settings / Library / Import have no mic. Confirm replies are
   never spoken.

Cloud Agent VMs usually have no phone and may lack a mic. Desktop Chromium
plus the unit tests are the implementer’s bar; the iOS/Android pass is the
author’s device (same as the existing iOS PWA sign-in check).

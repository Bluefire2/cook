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
Sous-side Gemini STT slice.

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

- **Sous-side STT (`/api/stt` + Gemini / Whisper)** if Web Speech is too
  flaky on the user’s iPhone or privacy forbids Chromium’s speech service.
  Needs a new plan, legal rewrite, and a client helper next to `chatApi.ts`.
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

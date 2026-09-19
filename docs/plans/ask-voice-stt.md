# Ask voice input (speech-to-text)

Let the recipe Ask assistant accept spoken questions through the phone
microphone. Replies stay text. This is dictation into the existing composer,
not a spoken conversation.

**Settled: path B.** The page records a clip (`getUserMedia` + `MediaRecorder`),
`POST /api/stt` transcribes it with the existing Gemini API, and the transcript
lands in `draft`. The user taps Send. Web Speech API (path A) is rejected —
see “Rejected: path A” at the bottom.

Checked against `main` at `0e2ff7a` (invitation flow + membership gate).
That commit **does** change this plan: `sessionFrom` is gone; protected
routes use `requireMember`. ChatPanel itself is unchanged. The recipe-edit
header Save button (`4737164`) does not affect Ask.

Parent surfaces: `src/components/ChatPanel.tsx` (the only Ask UI) mounted from
`src/screens/RecipeView.tsx`. There is no separate cooking-mode chat; RecipeView
always passes `cookingState` and already holds a screen wake lock.

## Open questions

None blocking. Path B and fill-then-Send are settled below. Remaining knobs
(pause length, max clip) are named constants, not Settings UI.

## Decisions

- **Transcribe on Sous, via Gemini.** Same `GEMINI_API_KEY` / `CHAT_MODEL`
  (`gemini-3.7-flash` default, `||` not `??`) as chat and import. No Cloud
  Speech-to-Text, no extra OAuth scopes, no Auth.js, no Web Speech API.
- **Fill, do not auto-send.** Path B has no live captions, so auto-send would
  POST a string the user has not seen. Transcript appends to `draft`; they
  tap Send (photos already attached stay attached).
- **Tap to start, tap to stop.** Hold-to-talk is hostile with messy hands.
  Auto-stop after `SILENCE_PAUSE_MS` of quiet **once speech has been heard**,
  or at `MAX_RECORD_MS`, whichever first. Opening silence does not stop the
  clip (otherwise the first 1.5s before they speak would submit empty audio).
- **Pause knob:** `SILENCE_PAUSE_MS = 1500` in `src/lib/voiceRecorder.ts`.
  That is the product control. Do not add a Settings slider in this slice.
  RMS threshold is a sibling constant (`SILENCE_RMS`); tune on a phone if
  kitchen hum false-triggers, do not expose it in UI.
- **Hard cap:** `MAX_RECORD_MS = 30_000`. At the cap, stop and transcribe
  (same as a tap-stop). Do not keep recording into a huge blob.
- **No audio persistence.** The handler reads the body, calls Gemini, returns
  `{ text }`, drops the bytes. No Firestore, no GCS, no Dexie, no chat
  attachment of the clip.
- **Transcript storage:** spoken string is `ChatMessage.content`, same as
  typing. Do not add fields to `Recipe`, `ChatMessage`, or `CookStateRow`.
- **Route:** `POST /api/stt` in `server/stt.ts`, mounted from
  `scripts/server.ts` on the exact-path list (like `/api/chat`). **Do not**
  add `api/stt.ts`. New HTTP routes go in `server/`. Vercel’s leftover
  `api/chat.ts` / `api/import.ts` exist only because those two still have
  Vercel copies; STT is Cloud Run only. `https://cook-seven-mu.vercel.app`
  404 on `/api/stt` is fine.
- **Auth:** `requireMember(req)` from `server/membership.ts`, same pattern
  as `photosPost` / sync — **not** `sessionFrom` (that helper no longer
  exists; `server/membership.test.ts` forbids the identifier in production
  sources). Denied (no cookie, bad cookie, signed-in non-member) → reuse
  `membershipUnauthorized()` (401 JSON `{ error: 'Unauthorized' }`).
  Firestore membership read throw → `membershipUnavailable()` (503 JSON).
  A 503 must **not** look like a 401: the client must not wipe the session
  on a membership blip. Do **not** wrap STT in `withMembership` — that
  adapter exists for Vercel `api/chat.ts` / `api/import.ts` and the
  `authorizedSub` count test is locked to those three files. STT is
  Cloud Run only; call `requireMember` inside `sttPost`.
  `POST /api/access-request` stays un-gated by membership; STT must not.
- **Body:** raw bytes, `Content-Type` is the recording MIME (no multipart).
  Mirror photos: allowlist the type, cap length, 413 if too large.
- **Allowed MIME** (strip `;codecs=` before compare): `audio/webm`,
  `audio/mp4`, `audio/aac`, `audio/mpeg`, `audio/ogg`, `audio/wav`. Gemini
  accepts these. Client picks the first `MediaRecorder.isTypeSupported` from
  `audio/webm;codecs=opus`, `audio/webm`, `audio/mp4`, `audio/aac`.
- **Size cap:** `MAX_STT_BYTES = 1_048_576` (1 MiB). 30s of opus/webm is
  far under; iOS mp4 is larger but still small. Stream-count the body like
  photos so a lying `Content-Length` cannot blow memory.
- **Gemini call:** non-streaming `generateContent`, **no tools**, not the
  chat `0x1E` framer. Do not change `api/chat.ts`. Contents: one user turn
  with `inlineData` (audio) + a short text prompt. Optional bias: recipe
  **title only** (ChatPanel has it; do not send the full recipe or
  cookingState — that is `/api/chat`’s job).
- **Prompt:** transcribe speech to text; return only the transcript; empty
  string if no speech; no quotes or commentary. Language follows
  `document.documentElement.lang` (`en` → ask for English).
- **Client fetch:** `src/lib/sttApi.ts` (next to `chatApi.ts`). Screens must
  not `fetch`. Credentials `same-origin`. **401** → `invalidateSession()`
  and throw `'Please sign in again — your session expired.'` (same sentence
  as `chatApi.ts`). **503** (membership blip or missing `GEMINI_API_KEY`) →
  throw the JSON `error` string, **do not** invalidate. Other non-OK → throw
  `error` if present, else `'Dictation failed — try again.'`
- **Unsupported:** hide the mic when `getUserMedia` or `MediaRecorder` is
  missing. When they exist, always show it; permission / capture errors use
  ChatPanel’s error strip.
- **Busy:** abort recording (do not transcribe a partial if we abort for
  Close/unmount). Disable mic while `streamingText !== null` or while
  `transcribing`. Disable Send while `transcribing` so they cannot send a
  draft that is about to gain the new sentence.
- **UI:** mic between attach and textarea, attach-button geometry
  (`h-10 w-10 rounded-full`). Idle matches attach fill; listening is amber
  (`bg-amber-500` / `hover:bg-amber-600 active:bg-amber-600`). Transcribing:
  keep the amber chrome, `aria-busy`, `aria-label="Transcribing"`. Hover
  always has an `active:` twin. No `<Button>` component, no new
  `uiClasses` unless a string is truly shared (attach’s classes are local —
  copy that pattern).
- **a11y:** `aria-label="Dictate"` / `"Stop dictation"` / `"Transcribing"`,
  `aria-pressed` while recording. Do not focus the textarea on start (that
  pops the iOS keyboard).
- **Legal:** Sous *does* receive the clip and passes it to Gemini at request
  time, then discards it. Edit `public/privacy.html` **Third parties** (the
  paragraph that currently lists Gemini for recipe text / chat / photos,
  URL import, Resend for access-request mail, hosting, then “Nothing
  else.”). Add dictation; keep Resend; drop “Nothing else.”
  `public/terms.html` Accuracy currently names “the assistant and the
  recipe importer” — include dictation as AI transcription that can be
  wrong. Bump last-updated dates if the calendar day changed.
- **README:** one line under the chat/API bullets that Ask dictation POSTs
  audio to `/api/stt` and Gemini returns text. Change “both Gemini
  handlers” / “both Gemini endpoints” (`GEMINI_API_KEY`, `CHAT_MODEL`) to
  include STT. “Your data” already says chat and import send text/photos;
  add that Dictate sends a short audio clip that is not stored. Do not
  describe Web Speech.
- **Tests:** pure predicates only (MIME allowlist, size, silence gate,
  transcript trim). No DOM testing library, no Gemini mock server, no
  fake MediaRecorder in CI. Do not fold a live STT eval into `npm test`.
- **`erasableSyntaxOnly`:** no enums, no constructor parameter properties.
- **Do not touch:** `/api/chat` framing, `maxDuration = 60` on chat, Dexie,
  Dockerfile, `vercel.json`, OAuth scopes, `package.json` `"name"`.

## Goal

On a phone, open a recipe, open Ask, tap the mic, speak (including a short
thinking pause), tap stop or wait ~1.5s after the last word, see text in
the box, tap Send, get a **text** reply as today. Typed input and photo
attach keep working. Close / navigation does not leak a live MediaStream.

## Assumptions

- Production is Cloud Run (`scripts/server.ts`). Vite already proxies `/api`
  to :3001, including a new path.
- `GEMINI_API_KEY` is already required for chat. STT fails closed with a
  clear 503 if it is missing — same as a broken chat key, not a new env var.
- Gemini inline audio limit (20 MB) is far above `MAX_STT_BYTES`.
- Chrome Android: `audio/webm;codecs=opus`. iOS Safari / standalone PWA:
  `audio/mp4`. Both are on the Gemini MIME list.
- `requireMember` is the gate (owners via `ALLOWED_EMAILS`, members via
  Firestore `members/{sub}`). No uid in the STT body.
- Implementer can click through Vite + `dev:api` signed in. Phone mic is
  the author’s device (Cloud Agent VMs often have none).

## Starting state (verified by reading the code)

- ChatPanel composer: 📷 attach, textarea `draft`, Send. `send()` no-ops
  when draft is empty and there are no pending photos, or when `busy`.
- Close / unmount already `abort()`s the in-flight **chat** controller.
  Recording needs the same cleanup for `MediaStream` tracks.
- `POST /api/chat` lives in `api/chat.ts` and is mounted as
  `withMembership(chatPost)` on the exact-path list in `scripts/server.ts`
  (alongside `/api/access-request` and `/api/admin/*`). Photos are a
  prefix matcher and call `requireMember` inside the handler. STT is an
  exact `POST /api/stt` — add `{ method: 'POST', path: '/api/stt',
  handler: sttPost }` to `apiRoutes` (bare `sttPost`, not
  `withMembership(sttPost)`), do not overload the photos prefix.
- Photos POST is the binary-body + membership precedent: `requireMember`,
  Content-Type allowlist, Content-Length + streamed byte cap, 413. Copy
  that shape; do not write GCS.
- Chat Gemini: `new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })`,
  `CHAT_MODEL || 'gemini-3.7-flash'`, images as
  `{ inlineData: { mimeType, data: base64 } }`. STT is the audio analogue
  of that part, **without** tools or streaming.
- `src/lib/chatApi.ts` is the existing non-library `fetch` helper. STT
  gets a sibling, not a method on `remote.ts` (remote is pull/push/photos).
- Privacy Third parties today: Gemini for recipe text / chat / photos;
  URL import; Resend for access-request notification mail; hosting; then
  “Nothing else.” Dictation makes that last sentence false. Keep the
  Resend sentence.
- `readSession` is cryptographic only. `sessionFrom` is deleted.
  `server/membership.test.ts` asserts `sessionFrom` appears in no
  production source — STT code must not reintroduce it.
- No `SpeechRecognition` / `MediaRecorder` usage in `src/` today.
  ChatPanel composer is unchanged by the invitation-flow merge.
- `index.html` `lang="en"`. PWA `display: standalone`.

## Files to change

- `server/stt.ts` — **new**. `sttPost`, exported MIME/size predicates.
- `server/stt.test.ts` — **new**.
- `scripts/server.ts` — mount `POST /api/stt`.
- `src/lib/sttApi.ts` — **new**. `transcribeAudio({ blob, title })`.
- `src/lib/sttApi.test.ts` — **new** if the JSON/401 mapping is worth
  locking; otherwise keep tests in the recorder helper.
- `src/lib/voiceRecorder.ts` — **new**. MIME pick, silence gate, start/stop.
- `src/lib/voiceRecorder.test.ts` — **new**.
- `src/components/ChatPanel.tsx` — mic, recording/transcribing states.
- `public/privacy.html`, `public/terms.html` — dictation disclosure.
- `README.md` — `/api/stt` bullet.
- `AGENTS.md` — this plan’s table row (wording: path B).
- `docs/plans/ask-voice-stt.md` — this file.

Do not change `api/chat.ts`, `api/import.ts`, `src/lib/chatApi.ts` framing,
`src/lib/chatStore.ts`, Recipe/ChatMessage types, `vite.config.ts`,
`index.html`, `src/lib/uiClasses.ts`, Dockerfile, deploy.sh.

## Steps

### 1. [core] Silence gate, MIME pick, transcript trim (pure)

Files: `src/lib/voiceRecorder.ts`, `src/lib/voiceRecorder.test.ts`

Export constants (numbers, not enums):

```
SILENCE_PAUSE_MS = 1500
SILENCE_RMS = 0.04
MAX_RECORD_MS = 30_000
```

`pickRecorderMime(): string | null` — first of
`['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac']`
where `MediaRecorder.isTypeSupported` is true; `null` if none. Tests stub
`MediaRecorder` as a global with `isTypeSupported`.

`silenceDecision(input): 'keep-listening' | 'stop'`

```
input = {
  now: number,
  startedAt: number,
  lastLoudAt: number | null,  // null until RMS >= SILENCE_RMS once
  rms: number,
}
```

- If `now - startedAt >= MAX_RECORD_MS` → `'stop'`.
- If `lastLoudAt === null` → `'keep-listening'` (still waiting for speech).
- If `rms >= SILENCE_RMS` → `'keep-listening'` (caller updates lastLoudAt).
- If `now - lastLoudAt >= SILENCE_PAUSE_MS` → `'stop'`.
- Else `'keep-listening'`.

Lock those branches in tests. Do not put `getUserMedia` in this module’s
pure functions.

`stripTranscript(raw: string): string` — trim; if the whole string is
wrapped in matching `"` or `“”`, unwrap once; collapse internal
newlines to spaces. Empty in → empty out. Tests for quotes and
whitespace.

`canRecord(): boolean` — `typeof navigator !== 'undefined'` and
`navigator.mediaDevices?.getUserMedia` and `typeof MediaRecorder === 'function'`.
Tests: stub globals.

A small `startRecording()` / `stopRecording()` wrapper may live in the
same file for ChatPanel to call, but it will not be unit-tested against a
real mic. It must:

- `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })`
- `new MediaRecorder(stream, mime ? { mimeType } : undefined)`
- `AudioContext` + `AnalyserNode` on the same stream; `requestAnimationFrame`
  or a 100ms `setInterval` reading RMS from `getByteTimeDomainData` or
  float data, mapped to 0..1, feeding `silenceDecision`
- Collect `dataavailable` blobs; on stop, `stop()` all tracks, close the
  AudioContext, resolve one `Blob` with `type` set to the chosen MIME
  **without** a codecs suffix if the browser left it empty
- `abortRecording()` stops tracks without resolving a blob (Close / unmount)

### 2. [core] `POST /api/stt`

Files: `server/stt.ts`, `server/stt.test.ts`, `scripts/server.ts`

**`sttPost(req: Request): Promise<Response>`**

1. `const access = await requireMember(req)`.
   `denied` → `membershipUnauthorized()` (401 JSON).
   `unknown` → `membershipUnavailable()` (503 JSON). Do not invent a third
   unauthorized shape. All later STT errors stay JSON `{ error }` with
   `Cache-Control: no-store`.
2. `GEMINI_API_KEY` missing/blank ⇒ 503 `{ error: 'Assistant is unavailable.' }`
   (do not mention the env var name). Distinct from membership 503 copy
   (`Membership unavailable`) so the client can show it as-is.
3. Method is already gated by the router (POST only).
4. `Content-Type` → `normalizeSttContentType` (strip params, lower-case,
   allowlist). Null ⇒ 400 `{ error: 'Bad request' }`.
5. If `Content-Length` parses and is `> MAX_STT_BYTES` ⇒ 413
   `{ error: 'Recording too long — try a shorter question.' }`.
6. Read `req.body` with a byte cap (copy the photos stream limiter or a
   smaller local helper). Over cap ⇒ 413 same copy. Empty body ⇒ 400.
7. Optional `x-recipe-title` header: if present, take the first 200
   Unicode scalar values, strip C0 controls, use in the prompt; if absent
   or empty, omit. **Do not** require it.
8. `generateContent` with `CHAT_MODEL || 'gemini-3.7-flash'`:

```
contents: [{
  role: 'user',
  parts: [
    { inlineData: { mimeType, data: base64 } },
    { text: prompt },
  ],
}]
config: { maxOutputTokens: 512, temperature: 0 }
```

No tools. No systemInstruction that restates the whole recipe. Prompt
shape (exact words may vary, meaning must not):

> Transcribe the speech in this audio to plain text.
> Return only the transcript. If there is no speech, return an empty string.
> Do not add quotation marks, labels, or commentary.
> Language: English.

If a title header was sent, append `The cook is making: {title}.` so
ingredient names bias slightly.

9. On Gemini throw / empty model: 502 `{ error: 'Dictation failed — try again.' }`.
   Do not leak provider error bodies to the client.
10. `stripTranscript` on `response.text`. 200
    `{ text: string }` with `Cache-Control: no-store`.
11. Drop the Buffer. No log of the transcript in production (a debug log
    of byte length + mime is fine).

Export from `server/stt.ts` for tests: `normalizeSttContentType`,
`isSttByteCountTooLarge`, `MAX_STT_BYTES`, `clipRecipeTitle`.

`scripts/server.ts`: add
`{ method: 'POST', path: '/api/stt', handler: sttPost }` to `apiRoutes`.
GET `/api/stt` must 405 (the existing pathMatched branch).

Tests: MIME allow / reject (`audio/webm;codecs=opus` → `audio/webm`);
size predicate; title clipping to 200; no network.

### 3. [core] Client `transcribeAudio`

File: `src/lib/sttApi.ts`

```
transcribeAudio(params: {
  blob: Blob,
  title?: string,
  signal?: AbortSignal,
}): Promise<string>
```

- `fetch('/api/stt', { method: 'POST', credentials: 'same-origin',
  headers: { 'Content-Type': blob.type.split(';')[0] || 'application/octet-stream',
  optional 'x-recipe-title': title }, body: blob, signal })`
- 401 → `invalidateSession()` and throw `'Please sign in again — your session expired.'`
  (same sentence as `chatApi.ts`)
- 503 → throw the JSON `error` (`Membership unavailable` or
  `Assistant is unavailable.`) — **do not** `invalidateSession`
- Other non-OK → throw the JSON `error` string if present, else
  `'Dictation failed — try again.'`
- 200 → `stripTranscript` of `body.text`; allow empty (caller decides)

ChatPanel is the only caller. Do not import `sttApi` from screens other
than via ChatPanel.

### 4. [ui] Mic in ChatPanel

File: `src/components/ChatPanel.tsx`

State: `listening`, `transcribing` (boolean). Refs for the active recorder
abort.

If `canRecord()` is false, render no mic (typed Ask unchanged).

Composer row:

```
[ 📷 attach ] [ mic ] [ textarea ] [ Send ]
```

Send `disabled={busy || transcribing}`. Mic `disabled={busy || transcribing}`
while transcribing; while listening the mic is the stop control.

**Tap:**

1. If `listening`: stop recorder, set listening false, `transcribing` true,
   `transcribeAudio`, append `stripTranscript` to `draft` with a leading
   space if draft is non-empty and the transcript is non-empty, clear
   transcribing. Empty transcript: no draft change, no error (they may
   have tapped immediately). Gemini/network throw: error strip, draft
   unchanged.
2. If not listening and not transcribing and not busy: `setError(null)`,
   `listening` true, `startRecording()`. `getUserMedia` reject
   (`NotAllowedError`) → listening false, `'Microphone access was blocked — allow it for this site and try again.'`
   `NotFoundError` → `'No microphone was found.'`
3. Silence/max-duration stop from the recorder takes the same path as (1)
   (stop → transcribe → fill).

**Abort without transcribe** (drop the blob): unmount, Close, `busy`
becoming true. Stop tracks. Do not POST.

Do not call `send()` from the transcribe path.

Placeholder stays “Ask the assistant…”. Optional: while listening, the
textarea placeholder can stay; do not swap the whole composer for a
full-screen overlay.

Photo + voice: unchanged `pendingPhotos`; user taps Send after the
transcript is in `draft`.

### 5. [ui] Privacy, terms, README, plans table

Files: `public/privacy.html`, `public/terms.html`, `README.md`, `AGENTS.md`

Privacy Third parties: keep Gemini for recipe text, chat messages, and
photos; keep the Resend access-request mail sentence; **add** that using
Dictate uploads a short microphone recording to Sous, which sends it to
Gemini to turn into text and does not store the audio. Hosting remains
Google Cloud. Remove the closing “Nothing else.” Bump last updated if
needed.

Terms Accuracy: extend “The assistant and the recipe importer are AI”
so dictation/transcription is named too. Do not add a new ToS section.

README: `POST /api/stt` — session cookie, raw audio body, JSON `{ text }`.
List it next to chat/import. Change “both Gemini handlers/endpoints” to
cover STT. “Your data” paragraph: Dictate sends a short clip to Gemini
at request time and it is not stored. Vite’s `/api` proxy must be up or
dictation fails the same way chat does.

AGENTS.md plans row: `docs/plans/ask-voice-stt.md` | Planned. Ask
composer dictation via `POST /api/stt` (Gemini); output remains text.

## Deferred

- **Auto-send** after a successful transcript. Worse on path B than A
  because the user has not watched live words. Revisit only after the
  fill path feels right on a phone.
- **Settings slider for `SILENCE_PAUSE_MS`.** Changing the constant is
  enough until someone hates 1500ms.
- **Live captions** (Web Speech in parallel, or Gemini streaming). Out of
  scope; do not mix path A back in “for interims”.
- **TTS / spoken replies / wake word / always-on.**
- **Vercel `api/stt.ts` copy.** Production is Cloud Run.
- **Biasing with full recipe / cookingState** on the STT prompt. Title
  only in v1.
- **Keeping audio** in GCS. Explicitly not wanted.
- **Firefox-only quirks** beyond MediaRecorder + getUserMedia, which it
  has.

Residual risk: iOS audio-session + PWA. If `getUserMedia` works for the
phone (it should; the camera file input already exists) but
`MediaRecorder` produces an empty blob or a MIME Gemini rejects, stop and
narrow the MIME list / add a conversion — do not bolt on Web Speech as a
silent fallback in the same slice.

## Verification

1. `npm test` — silenceDecision matrix (no speech / speech then pause /
   max duration / loud resets pause); MIME picker; stripTranscript;
   stt content-type and size predicates.
2. `npm run build` — type gate on `server/stt.ts`.
3. `GET http://localhost:3001/api/stt` → 405; `POST` no cookie → 401 JSON
   `{ error: 'Unauthorized' }`; signed-in **non-member** cookie → same 401
   (do not treat as 403); `POST` member cookie + `Content-Type: text/plain`
   → 400; oversized Content-Length → 413. (Use a real `sous_session`
   cookie; do not print it.) Confirm `server/membership.test.ts` still
   passes (no `sessionFrom` in `server/stt.ts`; `withMembership(chatPost)`
   still the only chat wrapper).
4. Browser, Vite + `dev:api`, signed in, `http://localhost:5173`:
   - RecipeView → Ask → Dictate → speak → stop → text in the box → Send
     → **text** reply. Network: `POST /api/stt` then `POST /api/chat`.
     No audio on the chat request.
   - Deny mic: error strip; typed Send still works.
   - Hide-mic: stub `canRecord` false in a desktop without
     MediaRecorder if needed; composer is attach + textarea + Send.
   - Attach photo, dictate, Send: user bubble has photo + transcript.
   - Start dictation, Close: tab’s mic indicator clears; no `/api/stt`.
   - Start dictation, wait through `SILENCE_PAUSE_MS` after speech:
     transcribe without a second tap.
   - Opening the mic and waiting `SILENCE_PAUSE_MS` **without** speaking:
     still listening (until 30s or tap).
   - Library / Import / Settings / Admin: no mic.
5. Phone: Chrome Android and iOS Safari + standalone PWA. Confirm
   `Content-Type` is one of the allowlisted types. If standalone fails
   where Safari-tab works, record it; do not add Web Speech in this PR.

## Rejected: path A (Web Speech API)

Browser `SpeechRecognition` / `webkitSpeechRecognition`. Live interims,
no Sous audio upload, Chrome sends mic audio to Google’s *browser* speech
service, no tunable pause (`speechend` is engine-defined), iOS standalone
is flaky. Rejected in favour of path B so we own the pause length and the
iPhone recording path. Do not implement a hidden Web Speech fallback in
this slice.

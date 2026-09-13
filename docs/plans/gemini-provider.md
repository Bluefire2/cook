# Gemini provider

Replace Anthropic with Gemini for `/api/chat` and `/api/import`. The browser
protocol, auth, and schema-duplication rule stay. No new product features.

Match-cal (`@google/genai` + `GEMINI_API_KEY` Developer API) is the TypeScript
template. Amazon-delivery-tracker confirms the same Developer API contract
(`generativelanguage.googleapis.com`, `x-goog-api-key`, JSON
`responseSchema`) but is Go/raw-HTTP — cook will not copy that HTTP client.

## Goal

- Both handlers call Gemini via `@google/genai` and `new GoogleGenAI({ apiKey })`.
- Import uses forced JSON (`responseMimeType` + `responseSchema`), the same
  pattern as match-cal `extractJson` and amazon-delivery-tracker.
- Chat streams plain text then `\x1E${proposal}\x1E`, with optional
  `update_recipe` function calling and `inlineData` images.
- `ANTHROPIC_API_KEY` is gone. `GEMINI_API_KEY` is the required secret.
- `CHAT_MODEL` still exists and defaults to `gemini-3.7-flash`.
- The client (`chatApi`, `importApi`, ChatPanel) does not change.

## Assumptions

- `@google/genai` 1.x (same family as match-cal `^1.0.0`) is available on npm.
- Gemini Developer API function calls appear on streamed chunks as
  `functionCalls` / `candidates[].content.parts[].functionCall`; implementers
  must read the installed SDK types and use whatever that version actually
  exposes — do not invent a second protocol.
- `response.text` on a non-streaming `generateContent` is the JSON string when
  `responseMimeType` is `application/json` (match-cal `extractJson`).
- No live Gemini key is required for `npm test` / `npm run build`. Manual
  chat/import checks need `.env.local`.
- Historical workstream docs (`docs/workstreams/*`, `AUDIT.md`) are snapshots
  and are not updated.

## Decisions (not blocking)

- **SDK, not raw HTTP.** Cook is TypeScript on Vercel like match-cal. Use
  `@google/genai`. Do not add Vertex / ADC / `GOOGLE_CLOUD_PROJECT`.
- **Keep `CHAT_MODEL`.** Renaming to `GEMINI_MODEL` would churn README and
  `.env.local` for no client benefit. Default becomes `gemini-3.7-flash`
  (match-cal). Use `||` so a bare `CHAT_MODEL=` does not defeat the default.
- **Import = structured JSON, not a forced function call.** Gemini's equivalent
  of Anthropic `tool_choice: save_recipe` is `responseMimeType` +
  `responseSchema` (both reference projects). Parse `response.text`; keep
  `NOT_A_RECIPE` → 422 and missing/unparseable JSON → 502.
- **Chat = optional function calling.** Questions must not force a proposal.
  Declare `update_recipe` as a `functionDeclarations` tool. Do not set
  `functionCallingConfig.mode` to `ANY`. After the stream ends, take the first
  `update_recipe` function-call `args` object (already a JS object in the SDK)
  and `JSON.stringify` it into the existing terminator payload.
- **Roles:** map client `assistant` → Gemini `model`. Images become
  `{ inlineData: { mimeType, data } }` parts on the user turn, plus a text
  part when content is non-empty.
- **System prompt** moves to `config.systemInstruction` unchanged in wording.
- **`maxOutputTokens: 4096`** replaces `max_tokens: 4096`.
- **Pass `apiKey` explicitly** from `process.env.GEMINI_API_KEY` so the env
  name is visible in both handlers (the old Anthropic client hid
  `ANTHROPIC_API_KEY`). A missing/blank key should fail the request the SDK's
  way — do not invent a custom 500 body unless the SDK throws before the
  stream starts; then let that become a stream `error` / import 500 as today.
- **Do not touch the client.** `src/lib/chatApi.ts`, `importApi.ts`, and
  ChatPanel stay. Tests that mock `fetch` stay green.
- **Workstream / AUDIT markdown is out of scope.** Only README and
  `.env.example` plus the two handlers and `package.json`.

## Files to change

- `package.json` / `package-lock.json` — add `@google/genai`, remove
  `@anthropic-ai/sdk`
- `api/chat.ts` — Gemini stream + optional `update_recipe`
- `api/import.ts` — Gemini structured extract
- `.env.example` — `GEMINI_API_KEY`, commented `CHAT_MODEL=gemini-3.7-flash`
- `README.md` — stack, setup, env table, Claude wording

Do not change: `src/**` (except if `tsc` proves a type leaked, which it
should not), `vercel.json`, `vitest.config.ts`, `AUDIT.md`,
`docs/workstreams/**`, `docs/plans/audit-fixes.md`.

## Steps

### 1. [core] Swap the dependency

Files: `package.json`, `package-lock.json`

- `npm uninstall @anthropic-ai/sdk`
- `npm install @google/genai@^1.0.0` (resolve to current 1.x, same range as
  match-cal)

**Verify:** `package.json` has `@google/genai` and no `@anthropic-ai/sdk`.
`npm ls @google/genai` succeeds.

### 2. [core] Shared Gemini recipe schema (duplicated)

Files: `api/chat.ts`, `api/import.ts`

Replace `RECIPE_SCHEMA` (Anthropic `Tool.InputSchema`) with a Gemini
`responseSchema` / function-parameters object using `Type` from `@google/genai`.
Both copies must stay byte-identical. Shape:

- `type: Type.OBJECT`
- properties: `title`, `description`, `servings`, `prepMinutes`, `cookMinutes`,
  `ingredientSections`, `steps`, `tags`, `notes` — same descriptions as today
- `ingredientSections` items: `name` plus `items` array of
  `{ quantity, unit, item, note }` with `item` required
- `steps` items: `{ text }` required
- required: `title`, `servings`, `ingredientSections`, `steps`, `tags`

Keep the file-level comment that the schema is duplicated because Vercel
transpiles each `api/` entrypoint in isolation.

`MODEL` becomes `process.env.CHAT_MODEL || 'gemini-3.7-flash'` in both files,
with the existing one-line comment about `||` vs `??`.

**Verify:** `npm run build` will fail until steps 3–4 remove Anthropic usage;
the two schema literals must `diff` equal.

### 3. [core] Import handler uses structured generateContent

File: `api/import.ts`

Keep auth, URL scheme guard, `extractRecipeSource`, empty-source 400, and
`maxDuration = 60`.

Replace the Anthropic block with:

```
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const result = await ai.models.generateContent({
  model: MODEL,
  contents: /* same user extract prompt as today */,
  config: {
    maxOutputTokens: 4096,
    responseMimeType: 'application/json',
    responseSchema: RECIPE_SCHEMA,
  },
});
```

Then `JSON.parse(result.text ?? '')`. Unparseable or missing text → existing
502 (`Extraction failed — no structured result.`). `title === 'NOT_A_RECIPE'`
→ existing 422. Success → `{ recipe: { ...recipe, sourceUrl: body.url } }`.

Do not use function calling on this path.

**Verify:** `npm test` (extractRecipeSource suite unchanged). `npm run build`
after step 4. Manual: `npm run dev:api` + import a known recipe URL.

### 4. [core] Chat handler streams Gemini + optional update_recipe

File: `api/chat.ts`

Keep auth, `maxDuration = 60`, `text/plain` + `Cache-Control: no-store`, and
the `\x1E${proposal}\x1E` terminator (empty proposal when no function call).
A thrown stream still closes without the terminator.

- `toGeminiContents(messages)`:
  - `assistant` → `role: 'model'`, `user` → `role: 'user'`
  - text-only turns: `{ role, parts: [{ text }] }`
  - user + images: parts are `inlineData: { mimeType: img.mediaType, data: img.base64 }`
    then optional `{ text }` if `content` is non-empty
- `systemInstruction: systemPrompt(...)` — same strings as today (still tell
  the model to call `update_recipe` with the complete recipe)
- `config.tools`: one function declaration `update_recipe` whose `parameters`
  are `RECIPE_SCHEMA`. No forced `functionCallingConfig`.
- `const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })`
- `const stream = await ai.models.generateContentStream({ model: MODEL, contents, config })`
- In the `ReadableStream` `start`:
  - `for await (const chunk of stream)` enqueue `chunk.text` when it is a
    non-empty string (SDK incremental text)
  - collect function-call args from each chunk using the SDK field (typically
    `chunk.functionCalls` or a `functionCall` part). Keep the last
    `update_recipe` args object seen
  - after the loop, enqueue `\x1E${proposal}\x1E` where `proposal` is
    `JSON.stringify(args)` or `''`, then `controller.close()`
  - `catch` → `controller.error(err)` (no terminator)
- `cancel()`: abort via `AbortController` passed as `config.abortSignal` if
  the SDK accepts it; otherwise leave cancel as a no-op that stops enqueueing.
  Do not leave a hung Gemini request if an abort signal is supported.

Remove all `@anthropic-ai/sdk` imports and `toAnthropicMessages`.

**Verify:** `npm run build`. `src/lib/chatApi.test.ts` still passes (client
unchanged). Manual: one question turn ends `1e 1e`; a “make it vegetarian”
turn ends with JSON between separators.

### 5. [core] Env example and README

Files: `.env.example`, `README.md`

`.env.example`:

```
# Required. Passed to new GoogleGenAI({ apiKey }) in api/chat.ts and api/import.ts.
GEMINI_API_KEY=

# Required. … APP_PASSWORD unchanged …

# Optional. Defaults to gemini-3.7-flash when unset.
# CHAT_MODEL=gemini-3.7-flash
```

Leave `GEMINI_API_KEY=` blank. Do not touch `APP_PASSWORD=change-me`.

README: Claude / Anthropic / `ANTHROPIC_API_KEY` / `claude-sonnet-4-5` become
Gemini / `GEMINI_API_KEY` / `gemini-3.7-flash`. Setup line: “add your Gemini
key”. Stack bullet: `@google/genai`. Env table notes `||` empty-string trap
still. “Never add a `VITE_` prefix” now names the Gemini key. Layout tree
`api/chat.ts` / `api/import.ts` lines say Gemini. “Your data” says photos pass
through to Gemini at request time.

Do not restructure the README.

**Verify:** `npm run build`. Every remaining `ANTHROPIC` / `claude-sonnet` /
`@anthropic-ai` hit in `api/`, `.env.example`, `README.md`, and `package.json`
is gone.

## Out of scope

- Vertex / ADC / `GOOGLE_CLOUD_PROJECT` / `GEMINI_LOCATION`
- Client protocol or UI copy
- Live Gemini tests, Playwright
- Re-encoding historical workstream docs or `AUDIT.md`
- Changing `APP_PASSWORD` behavior

## Risks

- **Stream function-call field names differ by SDK minor.** Read the installed
  `@google/genai` types in `node_modules` before writing the collector. Prefer
  `chunk.functionCalls` if present, else walk `chunk.candidates`.
- **`chunk.text` may replay the full prefix** on some SDK versions. If a
  manual turn doubles words, switch to enqueueing only the incremental
  `parts[].text` delta. Confirm against one streamed reply.
- **Structured import JSON may omit optional keys.** That is fine — the client
  already defaults `tags` / `ingredientSections` / `steps`.
- **Model id churn.** `gemini-3.7-flash` is what match-cal uses today; override
  with `CHAT_MODEL` if Google renames it.

## Open Questions

None blocking.

## Status

- [x] 1. [core] Swap the dependency
- [x] 2. [core] Shared Gemini recipe schema (duplicated)
- [x] 3. [core] Import handler uses structured generateContent
- [x] 4. [core] Chat handler streams Gemini + optional update_recipe
- [x] 5. [core] Env example and README

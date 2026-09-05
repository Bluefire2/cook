# cook

A personal, single-user recipe book that runs as an installed PWA on a phone.
It holds a readable recipe view, a cooking assistant attached to that recipe,
and one-tap import of recipes from a URL or pasted text.

Live at <https://cook-seven-mu.vercel.app>.

Everything is local-first: recipes, chat history, and photos live in IndexedDB
on the device that created them. There is no account, no server database, and
no sync. The only thing the server does is talk to Claude on the app's behalf.

## Installing it on a phone

1. Open <https://cook-seven-mu.vercel.app> in Safari.
2. Share → **Add to Home Screen**.
3. Open the installed app, go to **Settings**, and enter the app password —
   the same value as `APP_PASSWORD` on the server. It is saved on the device
   and sent with every assistant/import request.

Until that password is set, the library, recipe view, and search all work, but
chat and import return "Wrong or missing app password".

Installing matters for more than convenience: iOS may evict storage for a site
that is only bookmarked, and the home-screen app is what keeps the library
around. Export a backup from Settings occasionally regardless — see
[Your data](#your-data).

## Stack

- Vite 6 + React 19 + TypeScript 5.8, React Router 7
- Tailwind CSS v4 through `@tailwindcss/vite` — there is no `tailwind.config.js`
- Dexie 4 (IndexedDB) plus `dexie-react-hooks` for all persistence
- Two Vercel serverless functions in `api/` calling the Anthropic SDK
- `vite-plugin-pwa` for the service worker and web manifest

## Running it locally

**Prerequisites**

- Node **22.18 or newer**. `npm run dev:api` imports the TypeScript handlers in
  `api/` directly and relies on Node's native type stripping, which lands in
  22.18. (Nothing in the repo enforces this yet — no `engines` field and no
  `.nvmrc`.)
- An Anthropic API key, for the assistant and import features.

**Setup**

```bash
npm install
cp .env.example .env.local   # add your Anthropic key, pick an app password
```

`.env.local` is gitignored and is read only by the local API server. See
[Environment variables](#environment-variables).

**Then start both servers**, in two terminals:

```bash
npm run dev      # Vite on http://localhost:5173
npm run dev:api  # the api/ handlers on http://localhost:3001
```

> **`npm run dev` on its own is not enough.** It serves the whole UI, so it
> looks like everything is fine — but chat and import will fail. Vite proxies
> `/api` to `localhost:3001` (see [`vite.config.ts`](vite.config.ts)), and with
> nothing listening there the proxy answers 500, which the app surfaces as
> "Assistant request failed (500)." and "Import failed (500).". The Vite log
> shows `http proxy error: /api/chat` with `ECONNREFUSED`. If AI features break
> and nothing else does, this is why.

[`scripts/dev-api-server.ts`](scripts/dev-api-server.ts) is a small stand-in
for the Vercel runtime: it serves `POST /api/chat` and `POST /api/import` from
the same handler functions Vercel deploys, so you do not need the Vercel CLI.
It loads env vars via `node --env-file=.env.local`, which means **`.env.local`
must exist** — without it the process exits immediately with
`node: .env.local: not found`.

Both servers hot-reload their own side of things; the API server does not watch
`api/`, so restart it after editing a handler.

A first launch in an empty browser profile seeds one sample recipe
([`src/lib/seed.ts`](src/lib/seed.ts)), so you can check the UI before you have
a key.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server on 5173, proxying `/api` to 3001 |
| `npm run dev:api` | The `api/` handlers on 3001; needs `.env.local` and Node ≥ 22.18 |
| `npm run build` | `tsc -b` over the app/node/api tsconfigs, then `vite build` into `dist/` |
| `npm run preview` | Serves the built `dist/` on 4173, for checking the PWA build |
| `npm test` | Vitest once over `src/` |
| `npm run test:watch` | Vitest in watch mode |

`npm run build` type-checks everything, including `api/`, which the dev servers
do not — run it before deploying.

## Environment variables

All three are **server-side only**. They belong in `.env.local` for local dev
and in the Vercel project's environment settings for production.

| Variable | Required | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | Read implicitly by `new Anthropic()` in both handlers, so it is never named in the calling code. |
| `APP_PASSWORD` | yes | Shared secret compared against the `x-app-password` header on both endpoints. Must match what you saved in the app's Settings screen. Unset **or blank** on the server makes every request 401. |
| `CHAT_MODEL` | no | Model id for both endpoints. Defaults to `claude-sonnet-4-5`. Must be a real model id, or comment the line out — a bare `CHAT_MODEL=` is read as `''` by `--env-file`, which defeats the default. |

No `VITE_`-prefixed variable exists anywhere in the app, and none should. Vite
inlines `VITE_*` values into the client bundle, so prefixing the Anthropic key
would publish it to every browser that loads the app.

## Deployment

Vercel, with the auto-detected Vite preset: `npm run build` produces `dist/`
and that is what gets served. The two files in `api/` are picked up as
serverless functions automatically — they use the web-standard
`export async function POST(req: Request)` convention rather than Vercel's
Node adapter.

[`vercel.json`](vercel.json) holds a single SPA rewrite,
`/((?!api/).*)` → `/index.html`. The negative lookahead is the whole point: it
sends deep links like `/recipe/abc` to the client router while leaving
`/api/*` to the functions.

Set `ANTHROPIC_API_KEY` and `APP_PASSWORD` in the Vercel project settings, or
production 401s on every assistant call.

## How it's put together

```
api/chat.ts               streaming Claude proxy + the update_recipe tool
api/import.ts             URL fetch, JSON-LD extraction, Claude extraction
scripts/dev-api-server.ts local stand-in for the Vercel functions
src/App.tsx               flat routes, no layout wrapper
src/screens/              Library, RecipeView, ImportScreen, Settings
src/components/           ChatPanel.tsx, ErrorBoundary.tsx, and subcomponents
src/lib/                  types, db, the three stores, small helpers
```

The one rule to keep: **UI code goes through the stores in `src/lib/`
(`recipeStore`, `chatStore`, `photoStore`) and never touches `db` directly.**
[`src/lib/db.ts`](src/lib/db.ts) explains why at the export. Screens read
through `useLiveQuery`-backed hooks and write through store methods; the live
queries re-fire on their own, so there is no cache invalidation anywhere and
no global store.

Two details that are easy to trip over:

- The recipe JSON schema Claude fills in is duplicated verbatim between
  [`api/chat.ts`](api/chat.ts) and [`api/import.ts`](api/import.ts), because
  Vercel transpiles each `api/` entrypoint in isolation and cannot import a
  sibling helper. The two copies must stay in sync, and neither has a
  compile-time relationship to the `RecipeDraft` type.
- `/api/chat` streams **plain text**, then a Record Separator (`0x1E`), then
  any proposal JSON (or empty), then a final `0x1E` that marks a clean end.
  That is why there is no SSE framing: the client splits on `\x1E`, renders the
  text part as it arrives, parses the proposal when present, and treats a
  missing final separator as a cut-off reply.

## Your data

Recipes, chat messages, and photos are stored in IndexedDB under the database
name `cook`, on one device only. Nothing is uploaded; recipe text and any
photos you send the assistant are passed through to Anthropic at request time
but never stored server-side. Unreferenced photo blobs are swept at startup;
chat photos are downscaled when you attach them and are written to IndexedDB
only when the message is sent.

Settings has **Export library** / **Import backup**, which write and read a
single JSON file containing every recipe, message, and photo (photos as base64).
That file is the only backup mechanism there is. Importing merges into the
existing library, overwriting entries that share an id.

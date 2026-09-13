# Sous

A personal, single-user recipe book that runs as an installed PWA on a phone.
It holds a readable recipe view, a cooking assistant attached to that recipe,
and one-tap import of recipes from a URL or pasted text.

Live at <https://sous.kyrylo.lol>.

The app is called Sous; the repo, database, and directories are still `cook`.

Everything is local-first: recipes, chat history, and photos live in IndexedDB
on the device that created them. There is no account, no server database, and
no sync. The only thing the server does is talk to Gemini on the app's behalf.

## Installing it on a phone

1. Open <https://sous.kyrylo.lol> in Safari.
2. Share → **Add to Home Screen**.
3. Open the installed app, go to **Settings**, and enter the app password —
   the same value as `APP_PASSWORD` on the server. It is saved on the device
   and sent with every assistant/import request.

Until that password is set, the library, recipe view, and search all work, but
chat and import return "Wrong or missing app password".

IndexedDB is per-origin, so a home-screen install from the old Vercel origin
keeps its own separate library. **Export library** on the old origin, then
**Import backup** on this one.

Installing matters for more than convenience: iOS may evict storage for a site
that is only bookmarked, and the home-screen app is what keeps the library
around. Export a backup from Settings occasionally regardless — see
[Your data](#your-data).

## Stack

- Vite 6 + React 19 + TypeScript 5.8, React Router 7
- Tailwind CSS v4 through `@tailwindcss/vite` — there is no `tailwind.config.js`
- Dexie 4 (IndexedDB) plus `dexie-react-hooks` for all persistence
- Two web-standard `POST(req: Request)` handlers in `api/` calling Gemini via
  `@google/genai`. `scripts/server.ts` runs them in the Cloud Run container;
  Vercel still runs them as serverless functions.
- `vite-plugin-pwa` for the service worker and web manifest

## Running it locally

**Prerequisites**

- Node **22.18 or newer**. `npm run dev:api` and `scripts/server.ts` import the
  TypeScript handlers in `api/` directly and rely on Node's native type
  stripping, which lands in 22.18. `package.json` records this as
  `"engines": { "node": ">=22.18" }`; the container pins
  `node:22.20-bookworm-slim`.
- A Gemini API key, for the assistant and import features.

**Setup**

```bash
npm install
cp .env.example .env.local   # add your Gemini key, pick an app password
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

[`scripts/dev-api-server.ts`](scripts/dev-api-server.ts) is a thin wrapper
around [`scripts/server.ts`](scripts/server.ts) with `staticRoot: null`: it
serves `POST /api/chat` and `POST /api/import` from the same handler functions
the container (and Vercel) run, so you do not need the Vercel CLI.
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

`node scripts/server.ts` after `npm run build` serves the built app plus the
API on `PORT` (8080 by default). That is what the container runs.

`npm run build` type-checks everything, including `api/` and `scripts/`, which
the running servers do not — run it before deploying.

## Environment variables

All three are **server-side only**. They belong in `.env.local` for local dev
and on the Cloud Run service (and still in Vercel while that deployment exists)
for production.

| Variable | Required | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | yes | Passed to `new GoogleGenAI({ apiKey })` in both handlers. |
| `APP_PASSWORD` | yes | Shared secret compared against the `x-app-password` header on both endpoints. Must match what you saved in the app's Settings screen. Unset **or blank** on the server makes every request 401. |
| `CHAT_MODEL` | no | Model id for both endpoints. Defaults to `gemini-3.7-flash`. Must be a real model id, or comment the line out — a bare `CHAT_MODEL=` is read as `''` by `--env-file`, which defeats the default. |

No `VITE_`-prefixed variable exists anywhere in the app, and none should. Vite
inlines `VITE_*` values into the client bundle, so prefixing the Gemini key
would publish it to every browser that loads the app.

## Deployment

Cloud Run in `europe-west1` (not `europe-west2` — that region has no Cloud Run
domain mappings), GCP project `cooking-assistant-508423`, Artifact Registry
repo `sous`. The multi-stage [`Dockerfile`](Dockerfile) pins
`node:22.20-bookworm-slim`, builds `dist/`, and `CMD`s
`["node", "scripts/server.ts"]`. No secrets in any layer: `.dockerignore` and
`.gcloudignore` exclude `.env*`.

Build and push the image, then deploy the service:

```bash
gcloud builds submit --tag europe-west1-docker.pkg.dev/cooking-assistant-508423/sous/sous:v1 --project=cooking-assistant-508423
gcloud run deploy sous --image=europe-west1-docker.pkg.dev/cooking-assistant-508423/sous/sous:v1 --region=europe-west1 --project=cooking-assistant-508423 --allow-unauthenticated --port=8080
```

Set `GEMINI_API_KEY` and `APP_PASSWORD` on the service with
`gcloud run services update --update-env-vars` — never baked into the image,
and never `--set-env-vars`, which replaces the whole map. Then map the domain:

```bash
gcloud beta run domain-mappings create --service=sous --domain=sous.kyrylo.lol --region=europe-west1 --project=cooking-assistant-508423
```

In Cloudflare, a grey-cloud (DNS only) CNAME `sous` → whatever that command
printed (so far always `ghs.googlehosted.com`). Proxied (orange) blocks
certificate issuance. HTTPS looks broken until `CertificateProvisioned` is
`True`; do not edit the record while waiting.

[`scripts/server.ts`](scripts/server.ts) serves `dist/` and the two `api/`
handlers in one process. It mirrors [`vercel.json`](vercel.json)'s SPA rewrite
more strictly: `index.html` only for GET/HEAD paths that do not start with
`/api/` and whose last segment has no `.`. A missing file-like path 404s
instead of returning HTML.

The Vercel deployment at <https://cook-seven-mu.vercel.app> still exists and
is untouched. It keeps its own copy of the env vars and its own IndexedDB.

## How it's put together

```
api/chat.ts               streaming Gemini proxy + the update_recipe tool
api/import.ts             URL fetch, JSON-LD extraction, Gemini extraction
scripts/server.ts         production server: API + static dist/ + SPA fallback
scripts/dev-api-server.ts same listener, static serving off, port 3001
Dockerfile                multi-stage image; CMD node scripts/server.ts
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

- The recipe JSON schema Gemini fills in is duplicated verbatim between
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
photos you send the assistant are passed through to Gemini at request time
but never stored server-side. Unreferenced photo blobs are swept at startup;
chat photos are downscaled when you attach them and are written to IndexedDB
only when the message is sent.

Settings has **Export library** / **Import backup**, which write and read a
single JSON file containing every recipe, message, and photo (photos as base64).
That file is the only backup mechanism there is. Importing merges into the
existing library, overwriting entries that share an id.

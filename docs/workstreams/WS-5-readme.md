# WS-5 — README

**Branch** `ws-5-readme` · **Wave** 1 · **Depends on** nothing · **Size** S

Read `CONTEXT.md` first.

## Why this exists

`README.md` is one line: `# cook`.

Everything needed to run this project — the two required env vars, the fact that
local dev needs two servers, the Node version floor, how the password works —
exists only inside a Cursor chat transcript from July. There is no `.env.example`,
no `engines` field, and no `.nvmrc`. Someone cloning this repo (including the
owner, six months from now, on a new laptop) runs `npm run dev`, gets a working
app, and then watches every AI feature fail with a proxy error and no explanation.

## What to build

A real `README.md`. Write it for the owner returning to the project after a long
gap — someone who knows React but has forgotten every decision made here.

Cover:

**What the app is and where it runs.** A personal single-user recipe PWA,
installed to an iPhone home screen. Live at <https://cook-seven-mu.vercel.app>.
Mention that installing is Share → Add to Home Screen in Safari, and that the app
password has to be entered once in Settings afterwards.

**The stack**, briefly. Vite + React 19 + TypeScript, Tailwind v4, React Router,
Dexie/IndexedDB for storage, two Vercel serverless functions calling Claude.

**Getting started.** `npm install`, then the thing that actually matters: local
dev needs **both** `npm run dev` (Vite) and `npm run dev:api` (the `api/`
handlers on port 3001, proxied via `/api` — see the proxy config in
`vite.config.ts`). Say plainly that running only `npm run dev` leaves chat and
import broken, because that is the trap.

Note that `npm run dev:api` needs Node ≥ 22.18, because it relies on native
TypeScript type stripping to import the handlers directly. `scripts/dev-api-server.ts`
documents this in its own header — do not contradict it.

**Environment variables.** All three are server-side only:

- `ANTHROPIC_API_KEY` — required. Read implicitly by `new Anthropic()` inside the
  `api/` handlers; it is never named in the source.
- `APP_PASSWORD` — required. A shared secret checked against the `x-app-password`
  header on both endpoints. It must match what the user saves in the app's
  Settings screen. If it is unset on the server, every request 401s.
- `CHAT_MODEL` — optional, defaults to `claude-sonnet-4-5`.

They go in `.env.local` for local dev and in the Vercel project settings for
production. Say explicitly that no `VITE_`-prefixed variable is used, and that the
Anthropic key must never become one, because that would ship it to the browser.

Add a `.env.example` with the variable names and empty or placeholder values.
**Do not put real secrets in it**, and do not copy any value out of the existing
`.env.local` — read the variable *names* from `api/chat.ts` and `api/import.ts`
if you need to confirm them, and leave the values blank.

**Deployment.** Vercel, auto-detected Vite preset, so `npm run build` produces
`dist/`. `vercel.json` holds one SPA rewrite with a negative lookahead so `/api/*`
still routes to functions. The two files in `api/` are picked up automatically and
use the web-standard `export async function POST(req: Request)` convention.

**Architecture notes worth writing down.** Keep this short — a paragraph, not a
document. The one rule that matters to a future contributor is that UI code goes
through the stores in `src/lib/` and never touches `db` directly, which is what
keeps a possible future move to server storage contained. `src/lib/db.ts` already
explains why; point at it rather than restating it.

Also worth one line each: the recipe JSON schema is duplicated between
`api/chat.ts` and `api/import.ts` and the two copies must stay in sync; and
`api/chat.ts` streams plain text with any tool-call JSON appended after an ASCII
Record Separator (`0x1E`), which is why there is no SSE framing.

**Data and backup.** All recipes, chat history, and photos live in IndexedDB on
one device. There is no sync. Settings has a JSON export/import for the whole
library, and it is the only backup — worth stating, because on iOS an
*uninstalled* PWA's storage is subject to eviction, so "installed to the home
screen" is load-bearing.

## Files you own

- `README.md`
- `.env.example` *(new)*

Nothing else. In particular, do not add an `engines` field or an `.nvmrc` — that
means editing `package.json`, which WS-3 owns, and a conflict there is not worth
it. Document the Node requirement in prose instead and note in your PR that
enforcing it is a follow-up.

## Acceptance criteria

1. Someone could clone the repo, read only the README, and get a fully working
   local environment including AI features, assuming they have an Anthropic key.
2. Every command in it actually runs. Try them.
3. Every fact in it is verified against the source, not against this brief. If
   something here contradicts the code, the code is right — say so in your PR.
4. No secrets, no API keys, and no real password anywhere in the README or
   `.env.example`. If you happen to see a real credential while working, do not
   copy it and mention in your PR that it exists.
5. Markdown links resolve; no placeholder `TODO`s left behind.

## Out of scope

No CONTRIBUTING, no CHANGELOG, no architecture decision records, no badges. No
screenshots — they would need to be generated and committed as binaries. No
documentation of the workstreams in `docs/` (they are scaffolding and will be
deleted once the work lands). Do not document the security items; a separate pass
is planned and describing the current weaknesses in a public repo is exactly
backwards.

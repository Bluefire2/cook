# Server-backed library (no IndexedDB cache)

Parent identity/sync remains Firestore + GCS. This slice drops the Dexie
`cook` cache, outbox, ownership/AccountGate, and offline library. The phone
does not need a local copy; the account is the library.

## Goal

Signed-in clients pull the account into **memory**, write through
`POST /api/sync/push` and `POST /api/photos/:id`, and display photos via
`GET /api/photos/:id` (session cookie). Sign-out clears memory. Theme and the
`cook.session` profile cache stay in localStorage. IndexedDB database `cook`
is deleted once on boot so leftover caches cannot confuse the UI.

## Out of scope

- New REST list/get/save routes (reuse pull/push)
- GIS `id_token` fallback
- Conflict-merge UI (LWW on `updatedAt` still)
- Changing Dexie backup marker `app: 'cook'` / `cook-backup-` filenames
- Vercel origin

## Steps

1. [core] In-memory library + pull/push/photo HTTP helpers
2. [core] Rewrite recipe/chat/photo/cook stores; backup import/export via API
3. [core] Slim `syncEngine` (pull on sign-in / visibility / refresh). No outbox.
4. [ui] Remove AccountGate; Settings/Library copy; no seed
5. [core] Delete Dexie modules and dependency; update tests, AGENTS, README, legal

Status: implemented on `cursor/server-backed-library-60d5`.

# Deploy, consent Production, end-state (parent steps 20–22)

Parent: `docs/plans/sous-oauth-db.md`. Companion: `docs/plans/photos-and-deploy-docs.md`
(steps 18–19). This file is the executable workback for the **operational**
cutover. It deploys straight to production. There is no staging.

Do **not** start this plan until 18–19 are ticked: photo bucket + IAM, photo
upload/fetch, `deploy.sh` env map without `APP_PASSWORD`, `.env.example`,
README, and `/privacy` `/terms` rewritten for Firestore + GCS. Those pages
must already be in `dist/` locally (`npm run build`) before Branding URLs
point at them.

## Goal

A revision of Sous is live on `https://sous.kyrylo.lol` with Google sign-in,
Firestore sync, and GCS photos. The consent screen is **In production** (not
Testing). Two devices share one library. The installed iOS PWA can sign in. Chat
still streams. The old Vercel origin is left alone and 401s chat/import.

## Starting state

- Identity + recipe/chat/cook sync already work **locally**. Photos and deploy
  docs are the 18–19 slice; this plan assumes they have landed in git.
- Live host `https://sous.kyrylo.lol` currently runs the **pre-Phase-2** (or
  identity-only) Cloud Run revision: app password or identity without
  production sync/photos, env map still likely includes `APP_PASSWORD`.
- Domain mapping and managed certificate already exist. Do not recreate them.
- GCP project `cooking-assistant-508423`, region `europe-west1`, service `sous`.
- `ALLOWED_EMAILS` stays **one** address: `chernyshov.k@gmail.com`. A second
  allowlisted identity is out of scope. The "published but private" check uses
  an account that is **not** on the list.
- GIS `id_token` fallback is **unbuilt** and stays unbuilt unless step 6
  (iOS PWA sign-in) proves the redirect flow is broken.
- Do not touch `vercel.json`, Vercel env, or `https://cook-seven-mu.vercel.app`
  configuration.

## Workback

Read bottom-to-top. Each line is blocked by everything under it.

```
22. End-state: two devices, iOS PWA, stream, offline, Vercel 401
    └─ 21. Branding URLs + publish In production
        └─ 20c. Live probes + streaming oracle + signed-in smoke
            └─ 20b. bash scripts/deploy.sh
                └─ 20a. Record current revision (rollback target)
```

All steps are **[core] operational** except the GIS fallback, which is a
**stop-and-new-plan** branch, not work in this file.

## Assumptions

- `SESSION_SECRET` used in production **must be the value generated in parent
  step 3** and stored in the password manager. After the first successful
  Phase 2 deploy, `deploy.sh` reads it back off the service and it is never
  typed again. Generating a new one signs every device out.
- `PUBLIC_ORIGIN` on the service must be `https://sous.kyrylo.lol` with no
  trailing slash. Redirect URI in the Google console is
  `https://sous.kyrylo.lol/api/auth/callback/google` (already registered).
- `--env-vars-file` **replaces the whole env map**. The script from step 19
  must list every key the container needs. A partial map is an outage.
- Never print secret **values** into a terminal, scrollback, or chat
  transcript. Env probes use `--format="value(...env[].name)"` (names only).
- Do not add a second allowlisted email in this cutover.
- Do not rotate `SESSION_SECRET`, change region, or remap the domain.
- `erasableSyntaxOnly` and Dexie name `cook` are already shipped; this plan
  does not edit them.

## Files to change

None in the happy path. This is `gcloud`, a browser, a phone, and the parent
**Deploy record** / **Status** checkboxes.

If and only if iOS standalone sign-in fails as specified in step 6: **stop**,
fill `iOS standalone redirect sign-in: needed GIS fallback` in the Deploy
record, and write a **new** plan for `/api/auth/google/id-token` plus
Authorized JavaScript origins. Do not invent other workarounds in this file.

## Steps

### 1. [core] Record the rollback target *(operational)*

Run as `chernyshov.k@gmail.com`.

```powershell
$gcloud = "C:\Users\chern\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$P = 'cooking-assistant-508423'

& $gcloud config get account
& $gcloud run services describe sous --region=europe-west1 --project=$P --format="value(status.latestReadyRevisionName)"
```

Write that revision name into the parent Deploy record:
**Revision before the Phase 2 deploy (rollback target)**. Do not proceed
without it. Rollback is:

```powershell
& $gcloud run services update-traffic sous --region=europe-west1 --project=$P --to-revisions=<PREVIOUS_REVISION>=100
```

**Verify:** the Deploy record cell is non-empty and matches `describe`.

### 2. [core] Deploy with `scripts/deploy.sh` *(operational)*

Git Bash, repo root, on a commit that includes 18–19:

```bash
bash scripts/deploy.sh
```

It prompts once for anything it cannot read off the running service. Paste
from the password manager. **`SESSION_SECRET` must be the step-3 value.**
`AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` / `ALLOWED_EMAILS` /
`GEMINI_API_KEY` likewise. After this first Phase 2 deploy they stick on the
service.

If describe cannot be read, the script must **die** rather than mint a new
`SESSION_SECRET`. If it generates one anyway, treat that as a failed deploy:
roll back (step 1 command), fix the script, do not continue.

**If the new revision does not become Ready, roll back immediately**, then
debug:

```powershell
& $gcloud run services update-traffic sous --region=europe-west1 --project=$P --to-revisions=<PREVIOUS_REVISION>=100
& $gcloud run services logs read sous --region=europe-west1 --project=$P --limit=100
```

Failure handling, by symptom:

- **Container fails to start** → missing production dependency (Firestore /
  Storage / `google-auth-library` must be in `dependencies`), a non-erasable
  TypeScript construct, or `server/` missing from the image. Symptom of a
  missing `COPY server ./server`: `Cannot find module` on every new route
  while local runs work.
- **Every request 401s** → `SESSION_SECRET` absent. Check **names only**:
  `--format="value(spec.template.spec.containers[0].env[].name)"`.
- **`redirect_uri_mismatch`** → `PUBLIC_ORIGIN` is not
  `https://sous.kyrylo.lol`, or the console redirect URI has a trailing slash.
- **403 on sign-in** → `ALLOWED_EMAILS` missing from the env map.
- **`PERMISSION_DENIED` from Firestore or GCS** → IAM bound to the wrong SA;
  re-read `spec.template.spec.serviceAccountName` and compare to step 18a.
- **`APP_PASSWORD` still on the service** → YAML key list still contains it,
  or someone used `--update-env-vars`. The next `--env-vars-file` deploy is
  what deletes it; do not "fix" with a second `--update-env-vars` that keeps
  it around.

Write **Revision after** into the Deploy record once Ready.

**Verify (names and pages only — next step is the full probe list):**

```powershell
& $gcloud run services describe sous --region=europe-west1 --project=$P --format="value(status.latestReadyRevisionName)"
& $gcloud run services describe sous --region=europe-west1 --project=$P --format="value(status.conditions)"
```

Expect a **new** revision name and `Ready True`.

### 3. [core] Live probes, streaming oracle, signed-in smoke *(operational)*

Env **names** (never values):

```powershell
& $gcloud run services describe sous --region=europe-west1 --project=$P --format="value(spec.template.spec.containers[0].env[].name)"
```

Must include: `SESSION_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`,
`ALLOWED_EMAILS`, `PUBLIC_ORIGIN`, `GOOGLE_CLOUD_PROJECT`, `PHOTO_BUCKET`,
`GEMINI_API_KEY`. Must **not** include `APP_PASSWORD`.

Unauthenticated HTTP:

```powershell
node -e "for (const p of ['/','/privacy','/terms']) fetch('https://sous.kyrylo.lol'+p).then(r=>console.log(p,r.status,r.headers.get('content-type')))"
node -e "fetch('https://sous.kyrylo.lol/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>console.log('no-cookie chat',r.status))"
node -e "fetch('https://sous.kyrylo.lol/api/sync/pull').then(r=>console.log('no-cookie pull',r.status))"
node -e "fetch('https://sous.kyrylo.lol/api/photos/11111111-1111-4111-8111-111111111111').then(r=>console.log('no-cookie photo',r.status))"
```

Expect `/`, `/privacy`, `/terms` → **200** `text/html`; all three API calls →
**401**. Privacy/terms must be the **rewritten** copy (Firestore + GCS,
`europe-west1`), not "library lives only on this device".

Sign in at `https://sous.kyrylo.lol` in a desktop browser. Then re-run the
**streaming oracle** from `docs/plans/sous-subdomain.md` step 2 against
`https://sous.kyrylo.lol`, replacing `'x-app-password': …` with
`cookie: 'sous_session='+process.env.PROBE_COOKIE`. Set `$env:PROBE_COOKIE` to
the cookie value (do not paste it into chat). Cloud Run's front end can buffer
independently of local, so this must pass **here**, not only on localhost:

- `FRAMING PASS` and `STREAMING PASS`
- `gapMs` ≥ 500
- `content-encoding` and `content-length` both **null** on the chat response
- `INCONCLUSIVE` → retry with a longer prompt, do not proceed

`Remove-Item Env:PROBE_COOKIE` when done.

Signed-in smoke on desktop (same session):

- Settings shows the email; no password field.
- Attach a photo to a recipe; it appears after sync (toast may say Synced).
- One short chat turn streams in the UI; one import from a URL works.
- Sign out: library still opens from cache; a chat send shows
  `Please sign in again — your session expired.`

**Verify:** every command above plus the smoke bullets. Do not publish the
consent screen if `/privacy` or `/terms` is still the identity-only text.

### 4. [core] Branding URLs and publish to Production *(operational)*

Only after step 3 shows `/`, `/privacy`, `/terms` 200 over HTTPS on the real
hostname.

1. **Google Auth Platform → Branding**, exactly, no logo:

   ```
   Homepage:  https://sous.kyrylo.lol
   Privacy:   https://sous.kyrylo.lol/privacy
   Terms:     https://sous.kyrylo.lol/terms
   ```

2. **Audience → Publish app → In production.** The dialog must **not** ask for
   a verification submission. Identity scopes only (`openid`,
   `userinfo.email`, `userinfo.profile`). If it asks for verification, a
   sensitive scope is on Data Access — remove it; do not submit a review.

**Do not leave the app in Testing.** Testing grants expire after about a week
and only listed test users can sign in; that looks like a session bug later.
Publishing is safe because `ALLOWED_EMAILS` — not the Testing list — is what
restricts who may use the app.

Failure handling:

- **"Your app must be verified"** → extra scope on Data Access. Remove it.
- **A URL is rejected** → it must be on authorized domain `kyrylo.lol`, 200
  over HTTPS, no redirect:
  `node -e "fetch('https://sous.kyrylo.lol/privacy').then(r=>console.log(r.status, r.redirected))"`
- **Audience still says Testing** after publish → wait a few minutes; re-check
  before changing anything else.

**Verify:** Audience reads **In production**; Branding shows all three URLs.
Incognito sign-in: consent titled **Sous**, only name / email / profile.
An account **not** in `ALLOWED_EMAILS` completes Google's consent and lands on
the invitation-only **403** — that is "published but private", check it on
purpose. Write **Consent screen published to Production on** (today's date)
into the Deploy record.

### 5. [core] Desktop + second-device sync *(operational)*

Same Google account (`chernyshov.k@gmail.com`) on two browsers or a phone and
a laptop.

- `https://sous.kyrylo.lol` loads with a valid certificate. Library header
  reads **Sous**. DevTools → IndexedDB database name is still **`cook`**.
- Settings → **Sign in with Google** → consent **Sous**, identity scopes only
  → back to Settings, email shown.
- Sign in on the second device: same recipes, same chat threads, same cook
  progress; photos load one at a time (`GET /api/photos/:id`, one per id).
- Edit a title on the phone (or tab A), wait for sync / tap Sync now; reload
  the desktop: the edit is there.
- Delete that recipe on the desktop; reload the phone: it is gone and **stays
  gone** after another reload.
- Airplane mode on the phone: library, a recipe, and its chat all open. Edit
  offline; reconnect; the edit appears on the desktop.
- Sign out on one device: library still opens from cache; chat says
  `Please sign in again — your session expired.`

**Verify:** every bullet. Photos missing on the second device with a 404 →
step 18 drain/ensureLocal, not a deploy-script bug; still a **FAIL** for this
end-state until they load.

### 6. [core] Installed iOS PWA sign-in *(operational)*

Safari → Share → **Add to Home Screen**. Open the installed app. Sign in
**from inside it**, not from Safari.

**Expected:** Google opens in the in-app view and returns to the app **signed
in** (Settings shows the email).

**Failure (known):** the flow jumps out to Safari and the installed app stays
signed out. That is the iOS standalone cookie-jar case.

- **Stop.** Do not try random workarounds (custom URL schemes, `window.open`,
  changing `SameSite`, adding the `run.app` redirect, etc.).
- Record in the Deploy record:
  `iOS standalone redirect sign-in: needed GIS fallback`.
- Spawn a **new** plan for the GIS fallback from parent Decisions: GIS popup
  → `id_token` → `POST /api/auth/google/id-token` using the same
  `OAuth2Client.verifyIdToken` + nonce, same `sous_session` cookie; add
  `https://sous.kyrylo.lol` to **Authorized JavaScript origins** on client
  `sous-web`. Out of scope for **this** file until that failure is observed.

If sign-in **works**, record `iOS standalone redirect sign-in: works`.

Also from the installed app: `/privacy` and `/terms` load; one chat turn
streams; the library is the account library (or the migration gate if this
device had a pre-Phase-2 IndexedDB with no `cook.ownerUid` — that is step 7).

### 7. [core] Migration gate, Vercel leftover, Deploy record *(operational)*

**Migration**, on a device that still has a pre-Phase-2 library (ownerUid
absent, rows present). If no such device exists, reproduce locally against
production: sign out, `localStorage.removeItem('cook.ownerUid')`, create a
recipe while signed out, sign in on `https://sous.kyrylo.lol`.

- Gate appears. Export downloads a file. Continue is disabled until export.
- Continue replaces the cache with the account library. **No toast over the
  sheet.**
- Import backup adds those recipes to the account; they appear on the other
  device.
- The sample recipe ("Spaghetti al Pomodoro") does **not** reappear.

**Vercel** (do not reconfigure it):

- `https://cook-seven-mu.vercel.app` still serves its SPA and its **own**
  IndexedDB library.
- Chat and import there return **401**. That is intended.

Fill every remaining Deploy record cell that this slice owns:

| What | When |
| --- | --- |
| Revision before / after | steps 1–2 |
| Consent published to Production on | step 4 |
| iOS standalone redirect sign-in | step 6 |
| `ALLOWED_EMAILS` value | `chernyshov.k@gmail.com` (already known; record it) |
| OAuth client id last 6 chars | from the console, **not** the full id in git |

Tick parent Status **20, 21, 22** only after every bullet in steps 3–7 has
been done once by hand.

## Verify

There is no `npm test` gate on this file. The gates are:

1. Rollback target recorded before deploy.
2. New revision Ready; env **names** complete; no `APP_PASSWORD`.
3. `/` `/privacy` `/terms` 200 HTML; unauthenticated chat/sync/photos 401.
4. Streaming oracle PASS against the live host.
5. Audience **In production**; non-allowlisted account gets 403 after consent.
6. Two devices, one library, including photos; delete stays deleted.
7. iOS PWA sign-in recorded as works **or** GIS fallback queued.
8. Migration export-first path; Vercel 401; Deploy record complete.

## Failure handling

Covered per step. Additional:

- **First load after deploy still looks like the old app.** The installed
  service worker serves the old shell until `autoUpdate` replaces it. Hard
  refresh or wait; do not "fix" by turning off the PWA.
- **Publishing makes the consent screen world-reachable.** `ALLOWED_EMAILS`
  fail-closed is the only gate in front of `GEMINI_API_KEY`. Do not "helpfully"
  treat a blank list as allow-all in any hotfix.
- **Rotating `SESSION_SECRET` on this deploy** signs everyone out, including a
  phone with unsynced outbox rows (they drain after the next sign-in, but it
  looks like data loss). If the script minted a new secret, roll back.

## Risks

Copied from the parent where they bite **this** slice:

- iOS standalone OAuth is the most likely step-22 failure.
- Ownership wipe vs `needsMigration` is still the data-loss footgun; the gate
  is the guard.
- Buffered streaming through Cloud Run — oracle is mandatory on the live host.
- `--env-vars-file` replacing the map can drop `SESSION_SECRET` or
  `ALLOWED_EMAILS` and look like a code regression.
- Vercel becomes a half-working app with no in-app explanation; README already
  covers Export→Import. Do not "fix" Vercel in this phase.

## Status

- [x] 1. [core] Record the rollback target
- [x] 2. [core] Deploy with `scripts/deploy.sh`
- [x] 3. [core] Live probes, streaming oracle, signed-in smoke
- [x] 4. [core] Branding URLs and publish to Production
- [ ] 5. [core] Desktop + second-device sync
- [ ] 6. [core] Installed iOS PWA sign-in
- [ ] 7. [core] Migration gate, Vercel leftover, Deploy record

## Open questions

None blocking. GIS fallback is designed in the parent and **must not** be
built unless step 6 observes the cookie-jar failure.

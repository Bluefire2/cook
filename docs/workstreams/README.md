# Workstreams

Seven independent briefs covering the agreed backlog for `cook`. Each is written
to be handed to a **separate agent** that has never seen this repo. An agent
should read `CONTEXT.md` plus its own brief and nothing else.

## Dependency graph

```
Wave 1 — start all five at once, no shared files
  WS-1  Cook state: crash fix + persistence
  WS-2  Chat proposal integrity
  WS-3  Test harness + CI
  WS-4  Recipe editor, create-from-scratch, delete
  WS-5  README

Wave 2 — start once its dependencies are merged
  WS-6  Editable import preview          needs WS-4
  WS-7  Recipe photos + RecipeView edit  needs WS-1, WS-2, WS-4
```

Wave 1 has **zero file overlap**, verified against the current tree.

Wave 2 is a *logical* dependency, not a file-conflict one, and that distinction
matters: WS-6 and WS-7 both `import` the `RecipeForm` component that WS-4
creates. An agent cannot compile or test against a file that does not exist yet,
so no amount of workspace isolation lets them start early. Pre-committing a stub
would let them compile, but they would be building against something they cannot
exercise, and all three would then be editing the most intricate new component in
the batch. Waiting is cheaper.

## The briefs

| # | Brief | Scope | Size |
|---|---|---|---|
| WS-1 | [Cook state](WS-1-cook-state.md) | Stop the mid-cook white screen; persist servings, checked ingredients, current step | M |
| WS-2 | [Chat integrity](WS-2-chat-integrity.md) | Stop losing `sourceUrl` on Apply, stop losing replies when the sheet closes, stale proposal cards | M |
| WS-3 | [Tests + CI](WS-3-tests-ci.md) | Vitest, tests for `quantity.ts` and the JSON-LD extractor, GitHub Actions | M |
| WS-4 | [Recipe editor](WS-4-recipe-editor.md) | `RecipeForm`, edit route, create-from-scratch, delete | L |
| WS-5 | [README](WS-5-readme.md) | Document env vars and the two-server dev workflow | S |
| WS-6 | [Import preview](WS-6-import-preview.md) | Make the extraction preview editable before saving | S |
| WS-7 | [Recipe photos](WS-7-recipe-photos.md) | Attach and display recipe photos; Edit entry point in `RecipeView` | M |

## File ownership

Exclusive. If a file is not listed against your workstream, you do not edit it,
even for a one-line drive-by fix. Reading anything is fine.

**This rule is load-bearing, not cosmetic.** Do not assume you have an isolated
working directory. In the wave 1 run, all five agents were dispatched as
`best-of-n-runner` subagents on the documented promise of "an isolated git
worktree" each, and **none was created** — `git worktree list` showed a single
tree and all five agents edited the same checkout of `main` concurrently. Nothing
was lost, and the only reason is that the ownership sets are disjoint, so no agent
ever wrote a file another agent was holding.

Verify your situation before you start: run `git worktree list` and `git status`.
If you see other agents' modifications in your working tree, you are sharing it.
In that case:

- Stage **by explicit path** when you commit. Never `git add -A`, `git add .`, or
  `git commit -a` — you would sweep half-finished work from other agents into
  your commit.
- Never run `git checkout -- .`, `git stash`, `git reset --hard`, or `git clean`.
  Those destroy other agents' uncommitted work irrecoverably. This is the one
  mistake here that cannot be undone.
- Avoid `npm ci` once others are working; it deletes and reinstalls the shared
  `node_modules` underneath whoever is mid-build. Prefer `npm install` if you
  genuinely need a dependency.

| File | Wave 1 owner | Wave 2 owner |
|---|---|---|
| `src/screens/RecipeView.tsx` | WS-1 | WS-7 |
| `src/lib/db.ts` | WS-1 | — |
| `src/lib/useCookState.ts` *(new)* | WS-1 | — |
| `src/components/ChatPanel.tsx` | WS-2 | — |
| `src/lib/chatApi.ts` | WS-2 | — |
| `src/lib/recipeStore.ts` | WS-2 | WS-7 |
| `package.json` | WS-3 | — |
| `vitest.config.ts` *(new)* | WS-3 | — |
| `tsconfig.app.json`, `tsconfig.api.json` | WS-3 | — |
| `api/import.ts` | WS-3 | — |
| `**/*.test.ts` *(new)* | WS-3 | anyone, additive |
| `.github/workflows/ci.yml` *(new)* | WS-3 | — |
| `src/components/RecipeForm.tsx` *(new)* | WS-4 | WS-7 |
| `src/screens/RecipeEdit.tsx` *(new)* | WS-4 | — |
| `src/lib/recipeDraft.ts` *(new)* | WS-4 | — |
| `src/App.tsx` | WS-4 | — |
| `src/screens/Library.tsx` | WS-4 | WS-7 |
| `README.md` | WS-5 | — |
| `src/screens/ImportScreen.tsx` | — | WS-6 |
| `src/lib/photoStore.ts` | — | WS-7 |

Frozen in wave 1 — nobody edits these: `src/lib/types.ts`, `src/lib/chatStore.ts`,
`src/lib/settings.ts`, `src/lib/backup.ts`, `src/lib/image.ts`,
`src/lib/quantity.ts`, `src/lib/seed.ts`, `src/screens/Settings.tsx`,
`src/screens/ImportScreen.tsx`, `src/lib/photoStore.ts`, `api/chat.ts`,
`vite.config.ts`, `index.html`, `src/index.css`, `src/main.tsx`.

`src/lib/types.ts` is frozen on purpose: several briefs would each like to add a
field, and letting them would guarantee a conflict. WS-1 and WS-4 put their new
types in their own new files instead. If WS-7 genuinely needs a change there it
is the last one in, so it can take it.

## Running these in parallel

**Do not trust a subagent type's claim to isolate you.** The `best-of-n-runner`
type advertises "an isolated git worktree" per agent; when wave 1 was dispatched
that way, no worktree was created and all five agents shared one checkout of
`main`. Provision worktrees **yourself**, confirm with `git worktree list`, and
retarget each agent into its own directory — or use cloud agents, which get
genuinely separate VMs. Either way, verify rather than assume:

```bash
git worktree add ../cook-ws1 -b ws-1-cook-state
git worktree add ../cook-ws2 -b ws-2-chat-integrity
git worktree add ../cook-ws3 -b ws-3-tests-ci
git worktree add ../cook-ws4 -b ws-4-recipe-editor
git worktree add ../cook-ws5 -b ws-5-readme
```

Measured on this repo: `npm ci` takes about 12 seconds per worktree and
`npm run build` about 8, so an agent is productive within 20 seconds of setup.
Each worktree carries its own 127 MB `node_modules`, so five cost roughly 640 MB.

Branch names are `ws-<n>-<slug>`, one PR each into `main`.

### Practical gotchas

- **`.env.local` is gitignored**, so it does not follow a worktree. Copy it in by
  hand for any stream that needs live AI calls — WS-2 for its failure paths, and
  WS-6 and WS-7 for real imports. WS-1, WS-3, WS-4 and WS-5 do not need it.
- **Ports 5173 and 3001 are single-occupancy.** Only one agent at a time can run
  `npm run dev` plus `npm run dev:api`. `npm run build` and `npm test` are safe
  concurrently, so lean on those; the acceptance criteria that need a browser
  will serialize, and that is fine.
- **Worktrees share one `.git`.** Concurrent work on distinct branches is safe.
  Do not run `git gc` while agents are active.
- **Removing a worktree on Windows can fail with "Permission denied"** while
  anything still holds a handle inside `node_modules`. Wait for the agent's
  processes to exit and retry; the branch deletes fine either way.

## Merge order

Wave 1 branches are independent, so merge them in whatever order they finish.
Then rebase the wave 2 branches on `main` before opening their PRs.

Only two files are touched in both waves — `RecipeView.tsx` (WS-1 then WS-7) and
`recipeStore.ts` / `Library.tsx` (WS-2, WS-4, then WS-7). WS-7 is last in every
case, so WS-7 absorbs any conflict. Its brief says so.

## Not covered here

A security pass covering credential rotation and endpoint hardening was reviewed
and deliberately left out of this batch. It needs the owner's hands on the
Anthropic and Vercel consoles, so it is not agent work, and its specifics are
tracked outside this public repo.

One orphan is folded into WS-3 because it is a one-liner in a file WS-3 already
owns: `api/import.ts` has no `maxDuration`, so it can hit Vercel's 10-second
Hobby timeout on slow pages.

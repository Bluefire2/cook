# WS-2 — Chat proposal integrity

**Branch** `ws-2-chat-integrity` · **Wave** 1 · **Depends on** nothing · **Size** M

Read `CONTEXT.md` first.

## Why this exists

Recipe modification through chat is the app's most distinctive feature, and it is
also where every remaining data-loss bug lives. Four separate problems, all in
the chat round-trip.

### Problem 1 — Apply silently destroys `sourceUrl`

```56:64:src/components/ChatPanel.tsx
  const apply = async () => {
    await recipeStore.save({
      ...proposal,
      id: recipe.id,
      createdAt: recipe.createdAt,
      updatedAt: recipe.updatedAt,
    });
    setApplied('Applied to this recipe ✓');
  };
```

`proposal` is a `RecipeDraft` built from the `update_recipe` tool input, and the
tool schema has no `sourceUrl` or `photoId` property — see `api/chat.ts:6-55`.
`recipeStore.save` does a `db.recipes.put`, which replaces the whole record. So
the spread drops both fields, and every AI modification permanently severs the
recipe's link back to the site it came from.

`sourceUrl` is written once, at `api/import.ts:183`, and is not displayed
anywhere yet — so today this destroys data the user cannot see, which is exactly
why it went unnoticed. WS-7 will start displaying it.

Also note line 61: `updatedAt: recipe.updatedAt` is pointless, because
`recipeStore.save` overwrites `updatedAt` with `Date.now()` on the way through.

### Problem 2 — closing the sheet mid-reply throws the reply away

`send` awaits `streamChatReply` and then persists the assistant message
(`src/components/ChatPanel.tsx:234-241`). `RecipeView` unmounts `ChatPanel` the
moment the sheet closes (`src/screens/RecipeView.tsx:196`), so if the user closes
it while the assistant is still typing, the `chatStore.append` never runs. The
user's message stays in the thread with no answer, and the partial reply is gone.
The Anthropic request also keeps running to completion, billing tokens nobody
will read.

There is already a `signal?: AbortSignal` parameter plumbed through to `fetch` in
`src/lib/chatApi.ts:33` and `:46`. No caller has ever passed one.

### Problem 3 — a stream error discards everything streamed so far

`api/chat.ts` calls `controller.error(err)` on failure, which makes the client's
`reader.read()` throw. The `catch` at `src/components/ChatPanel.tsx:242` shows an
error and drops the accumulated text. The user's message is already persisted at
that point, so the thread is left with a question and no answer.

The same shape of bug exists one step earlier: the user message is written at
line 213 but `encodeImageForChat` is not called until line 222, so an unsupported
image format also leaves an orphaned user message.

### Problem 4 — the proposal card goes stale after Apply

After **Apply**, the card stays on screen showing a diff against a recipe that no
longer exists in that form. The `applied` flag hides the buttons but the red/green
diff above them is now nonsense. `saveAsVariant` already handles its own case by
calling `onNavigateAway()` (line 69) to close the sheet.

## What to build

### Preserve fields the tool schema cannot express

Fix `apply` so applying a proposal keeps every `Recipe` field the AI was never
asked about. Prefer an explicit merge over a spread, so that adding a field to
`Recipe` later does not silently reintroduce this bug — the reader should be able
to see which fields survive.

Drop the redundant `updatedAt` line.

Consider whether `recipeStore.save` is the right primitive at all. It takes a
whole `Recipe` and `put`s it, which makes every caller responsible for
remembering the full record. A narrower store method that merges a `RecipeDraft`
into an existing recipe by id would make this class of bug structurally hard to
write, and `recipeStore.ts` is yours. Your call — but if you leave `save` as is,
make the merge at the call site unmistakable.

### Survive the sheet closing

Two things need to happen when `ChatPanel` unmounts mid-stream:

1. Abort the in-flight request, so it stops costing money. Create an
   `AbortController` in `send`, pass `signal` to `streamChatReply`, and abort it
   from an effect cleanup.
2. Persist what was received. A reply the user half-read is worth more than an
   empty thread, and the user's question is already saved.

An aborted reply should be saved with whatever text arrived. Do not save an empty
assistant message if nothing arrived at all — that just adds a blank bubble.

Note that an `AbortError` will surface through the `catch` at line 242; a
deliberate abort is not an error and must not render as one.

### Survive a stream error

Persist the partial text on failure too, then show the error. Same reasoning:
never leave a user message with no reply in the thread.

Move the `encodeImageForChat` call so image encoding failures happen **before**
the user message is written, or handle them so the thread is not left orphaned.

### Retire the stale card

Once a proposal has been applied, stop rendering the diff. Showing a confirmation
in its place is enough. Do not try to re-diff against the new recipe.

## Files you own

- `src/components/ChatPanel.tsx`
- `src/lib/chatApi.ts`
- `src/lib/recipeStore.ts`

Nothing else. `src/screens/RecipeView.tsx` belongs to WS-1 — the `ChatPanel`
props (`recipe`, `cookingState`, `onClose`) do not change, and the
`CookingState` interface in `chatApi.ts` does not change either, so you and WS-1
will not collide. `api/chat.ts` is frozen; the fix is entirely client-side.
`src/lib/chatStore.ts` is frozen — `append` is already what you need.

## Acceptance criteria

1. Import a recipe from a URL, confirm `sourceUrl` is set (check the record in
   DevTools → Application → IndexedDB), ask the assistant to modify it, tap
   **Apply** — `sourceUrl` is still there afterwards.
2. Send a message, and close the sheet while the assistant is mid-sentence.
   Reopen it: the partial reply is in the thread. Confirm in the Network panel
   that the request was actually cancelled, not just ignored.
3. Same as above but navigate away to the library instead of closing the sheet.
4. Force a failure — stop `npm run dev:api` mid-stream, or set a wrong password
   in Settings — and confirm the thread never ends on an unanswered user message.
5. Attach a non-image file renamed to `.jpg` and send; no orphaned user message.
6. Tap **Apply**, then look at the card: no stale diff.
7. `npm run build` exits 0.

## Out of scope

No "Stop generating" button in the UI — abort on unmount only. No sending
previous turns' photos back to the model on follow-ups (a real gap, since
`ChatPanel.tsx:229` maps history to `{role, content}` and drops images, but it is
a behaviour change rather than a correctness fix and it costs tokens). No retry
button. No deduplicating the schema between the two `api/` files. No auto-growing
textarea.

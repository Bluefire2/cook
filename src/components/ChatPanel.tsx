import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { chatStore, useChatMessages } from '../lib/chatStore';
import { photoStore, usePhotoUrl } from '../lib/photoStore';
import { recipeStore } from '../lib/recipeStore';
import { streamChatReply, type CookingState } from '../lib/chatApi';
import { encodeImageForChat, type EncodedImage } from '../lib/image';
import { formatQuantity } from '../lib/quantity';
import type { ChatMessage, Ingredient, Recipe, RecipeDraft } from '../lib/types';

function ingredientLine(ing: Ingredient): string {
  const parts = [
    ing.quantity !== undefined ? formatQuantity(ing.quantity) : null,
    ing.unit ?? null,
    ing.item,
  ].filter(Boolean);
  const base = parts.join(' ');
  return ing.note ? `${base} (${ing.note})` : base;
}

function recipeLines(r: Recipe | RecipeDraft): {
  ingredients: string[];
  steps: string[];
} {
  return {
    ingredients: r.ingredientSections.flatMap((s) =>
      s.items.map(ingredientLine),
    ),
    steps: r.steps.map((s) => s.text),
  };
}

function ProposalCard({
  recipe,
  proposal,
  onNavigateAway,
}: {
  recipe: Recipe;
  proposal: RecipeDraft;
  onNavigateAway: () => void;
}) {
  const navigate = useNavigate();
  const [applied, setApplied] = useState<string | null>(null);

  const apply = async () => {
    await recipeStore.applyDraft(recipe.id, proposal);
    setApplied('Applied to this recipe ✓');
  };

  const saveAsVariant = async () => {
    const created = await recipeStore.create(proposal);
    setApplied('Saved as a new recipe ✓');
    onNavigateAway();
    navigate(`/recipe/${created.id}`);
  };

  // The diff is against a recipe that no longer exists in that form.
  if (applied) {
    return (
      <div className="mt-2 rounded-xl border border-line bg-surface p-3">
        <p className="text-sm font-medium text-success">{applied}</p>
      </div>
    );
  }

  const before = recipeLines(recipe);
  const after = recipeLines(proposal);
  const removedIngredients = before.ingredients.filter(
    (l) => !after.ingredients.includes(l),
  );
  const addedIngredients = after.ingredients.filter(
    (l) => !before.ingredients.includes(l),
  );
  const removedSteps = before.steps.filter((l) => !after.steps.includes(l));
  const addedSteps = after.steps.filter((l) => !before.steps.includes(l));

  return (
    <div className="mt-2 rounded-xl border border-line bg-surface p-3">
      <p className="text-sm font-semibold">
        Proposed change{proposal.title !== recipe.title && `: ${proposal.title}`}
      </p>
      {proposal.servings !== recipe.servings && (
        <p className="mt-1 text-sm text-ink-muted">
          Serves {recipe.servings} → {proposal.servings}
        </p>
      )}
      <div className="mt-1.5 flex flex-col gap-0.5 text-sm">
        {removedIngredients.map((l) => (
          <p key={`ri-${l}`} className="text-danger line-through">{l}</p>
        ))}
        {addedIngredients.map((l) => (
          <p key={`ai-${l}`} className="text-success">+ {l}</p>
        ))}
        {removedSteps.map((l) => (
          <p key={`rs-${l}`} className="text-danger line-through">{l}</p>
        ))}
        {addedSteps.map((l) => (
          <p key={`as-${l}`} className="text-success">+ {l}</p>
        ))}
        {removedIngredients.length + addedIngredients.length + removedSteps.length + addedSteps.length === 0 && (
          <p className="text-ink-muted">Metadata-only change.</p>
        )}
      </div>
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          onClick={() => void apply()}
          className="flex-1 rounded-full bg-ink py-2 text-sm font-medium text-page"
        >
          Apply
        </button>
        <button
          type="button"
          onClick={() => void saveAsVariant()}
          className="flex-1 rounded-full border border-line-strong py-2 text-sm font-medium text-ink-muted"
        >
          Save as variant
        </button>
      </div>
    </div>
  );
}

function PhotoThumb({ photoId }: { photoId: string }) {
  const url = usePhotoUrl(photoId);
  return (
    <div className="h-20 w-20 overflow-hidden rounded-lg bg-surface-muted">
      {url && (
        <img
          src={url}
          alt="Attached photo"
          className="h-full w-full object-cover"
        />
      )}
    </div>
  );
}

function MessageBubble({
  message,
  recipe,
  onNavigateAway,
}: {
  message: ChatMessage;
  recipe: Recipe;
  onNavigateAway: () => void;
}) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-3.5 py-2 whitespace-pre-wrap ${
          isUser ? 'bg-accent-soft' : 'bg-surface-muted'
        }`}
      >
        {message.photoIds && message.photoIds.length > 0 && (
          <div className="mb-1.5 flex gap-1.5">
            {message.photoIds.map((pid) => (
              <PhotoThumb key={pid} photoId={pid} />
            ))}
          </div>
        )}
        {message.content}
        {message.proposedRecipe && (
          <ProposalCard
            recipe={recipe}
            proposal={message.proposedRecipe}
            onNavigateAway={onNavigateAway}
          />
        )}
      </div>
    </div>
  );
}

export default function ChatPanel({
  recipe,
  cookingState,
  onClose,
}: {
  recipe: Recipe;
  cookingState: CookingState;
  onClose: () => void;
}) {
  const messages = useChatMessages(recipe.id);
  const [draft, setDraft] = useState('');
  const [pendingPhotos, setPendingPhotos] = useState<
    { photoId: string; blob: Blob }[]
  >([]);
  // Mirrored in a ref so the unmount cleanup, which closes over the first
  // render, still knows what was left pending.
  const pendingRef = useRef(pendingPhotos);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef<AbortController | null>(null);

  const busy = streamingText !== null;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages?.length, streamingText]);

  // The sheet unmounts on close and on navigation; a reply nobody can read is
  // still billed until the request is cancelled.
  useEffect(() => () => inFlight.current?.abort(), []);

  // A blob is written on attach, but only a sent message references it. What is
  // still pending when the sheet goes away is unreachable from then on.
  useEffect(
    () => () => {
      for (const photo of pendingRef.current) {
        void photoStore.remove(photo.photoId);
      }
    },
    [],
  );

  const setPending = (photos: { photoId: string; blob: Blob }[]) => {
    pendingRef.current = photos;
    setPendingPhotos(photos);
  };

  const attachPhoto = async (file: File) => {
    const photoId = await photoStore.add(file);
    setPending([...pendingRef.current, { photoId, blob: file }]);
  };

  const discardPending = async () => {
    const photos = pendingRef.current;
    setPending([]);
    await Promise.all(photos.map((p) => photoStore.remove(p.photoId)));
  };

  const removePending = async (photoId: string) => {
    setPending(pendingRef.current.filter((p) => p.photoId !== photoId));
    await photoStore.remove(photoId);
  };

  const send = async () => {
    const content = draft.trim();
    if ((content === '' && pendingPhotos.length === 0) || busy) return;

    setError(null);
    setStreamingText('');
    const photos = pendingPhotos;

    // Encode before writing the user message, so a photo we cannot read leaves
    // the thread untouched instead of orphaning a question.
    let images: EncodedImage[];
    try {
      images = await Promise.all(
        photos.map((p) => encodeImageForChat(p.blob)),
      );
    } catch {
      setStreamingText(null);
      setError("That photo couldn't be read — it may not be a real image.");
      await discardPending();
      return;
    }

    setDraft('');
    // Handed to the message below, so these stop being pending rather than
    // getting discarded.
    setPending([]);

    const history = messages ?? [];
    await chatStore.append({
      recipeId: recipe.id,
      role: 'user',
      content,
      photoIds: photos.map((p) => p.photoId),
    });

    const controller = new AbortController();
    inFlight.current = controller;
    let streamed = '';
    try {
      const reply = await streamChatReply({
        recipe,
        cookingState,
        messages: [
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user' as const, content, images },
        ],
        onDelta: (textSoFar) => {
          streamed = textSoFar;
          setStreamingText(textSoFar);
        },
        signal: controller.signal,
      });
      await chatStore.append({
        recipeId: recipe.id,
        role: 'assistant',
        content:
          reply.text.trim() ||
          (reply.proposedRecipe ? 'Here is my proposed change:' : ''),
        proposedRecipe: reply.proposedRecipe,
      });
    } catch (e) {
      // Half an answer beats a question left hanging in the thread. An abort is
      // the user's own doing, so it needs no bubble of its own and no error.
      const partial = streamed.trim();
      if (controller.signal.aborted) {
        if (partial !== '') {
          await chatStore.append({
            recipeId: recipe.id,
            role: 'assistant',
            content: partial,
          });
        }
      } else {
        const message =
          e instanceof Error ? e.message : 'Something went wrong.';
        await chatStore.append({
          recipeId: recipe.id,
          role: 'assistant',
          content: partial ? `${partial}\n\n⚠️ ${message}` : `⚠️ ${message}`,
        });
        setError(message);
      }
    } finally {
      inFlight.current = null;
      setStreamingText(null);
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close chat"
        onClick={onClose}
        className="flex-1 bg-black/20"
      />
      <div className="flex h-[75dvh] flex-col rounded-t-3xl bg-surface shadow-2xl md:mx-auto md:w-full md:max-w-xl">
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-semibold">Assistant</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-3 py-1 text-sm text-ink-muted"
          >
            Close
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
          <div className="flex flex-col gap-2.5">
            {(messages ?? []).map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                recipe={recipe}
                onNavigateAway={onClose}
              />
            ))}
            {streamingText !== null && (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl bg-surface-muted px-3.5 py-2 whitespace-pre-wrap">
                  {streamingText === '' ? '…' : streamingText}
                </div>
              </div>
            )}
            {error && (
              <p className="rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            {(messages ?? []).length === 0 && streamingText === null && (
              <p className="py-8 text-center text-sm text-ink-subtle">
                Ask anything about this recipe — substitutions, technique,
                timing — or send a photo of how it's going.
              </p>
            )}
          </div>
        </div>

        {pendingPhotos.length > 0 && (
          <div className="flex gap-2 px-4 pb-1">
            {pendingPhotos.map((p) => (
              <div key={p.photoId} className="relative">
                <PhotoThumb photoId={p.photoId} />
                <button
                  type="button"
                  aria-label="Remove photo"
                  onClick={() => void removePending(p.photoId)}
                  className="absolute -top-1.5 -right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-ink text-xs text-page"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 border-t border-line px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void attachPhoto(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            aria-label="Attach photo"
            onClick={() => fileInputRef.current?.click()}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-lg"
          >
            📷
          </button>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder="Ask the assistant…"
            className="max-h-32 flex-1 resize-none rounded-2xl border border-line bg-page px-3.5 py-2 outline-none focus:border-ink-subtle"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy}
            className="h-10 shrink-0 rounded-full bg-ink px-4 font-medium text-page disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

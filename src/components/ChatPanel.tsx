import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { chatStore, useChatMessages } from '../lib/chatStore';
import { photoStore, usePhotoUrl } from '../lib/photoStore';
import { recipeStore } from '../lib/recipeStore';
import { streamChatReply, type CookingState } from '../lib/chatApi';
import { encodeImageForChat } from '../lib/image';
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

  const apply = async () => {
    await recipeStore.save({
      ...proposal,
      id: recipe.id,
      createdAt: recipe.createdAt,
      updatedAt: recipe.updatedAt,
    });
    setApplied('Applied to this recipe ✓');
  };

  const saveAsVariant = async () => {
    const created = await recipeStore.create(proposal);
    setApplied('Saved as a new recipe ✓');
    onNavigateAway();
    navigate(`/recipe/${created.id}`);
  };

  return (
    <div className="mt-2 rounded-xl border border-amber-200 bg-white p-3">
      <p className="text-sm font-semibold">
        Proposed change{proposal.title !== recipe.title && `: ${proposal.title}`}
      </p>
      {proposal.servings !== recipe.servings && (
        <p className="mt-1 text-sm text-stone-600">
          Serves {recipe.servings} → {proposal.servings}
        </p>
      )}
      <div className="mt-1.5 flex flex-col gap-0.5 text-sm">
        {removedIngredients.map((l) => (
          <p key={`ri-${l}`} className="text-red-500 line-through">{l}</p>
        ))}
        {addedIngredients.map((l) => (
          <p key={`ai-${l}`} className="text-green-700">+ {l}</p>
        ))}
        {removedSteps.map((l) => (
          <p key={`rs-${l}`} className="text-red-500 line-through">{l}</p>
        ))}
        {addedSteps.map((l) => (
          <p key={`as-${l}`} className="text-green-700">+ {l}</p>
        ))}
        {removedIngredients.length + addedIngredients.length + removedSteps.length + addedSteps.length === 0 && (
          <p className="text-stone-500">Metadata-only change.</p>
        )}
      </div>
      {applied ? (
        <p className="mt-2 text-sm font-medium text-green-700">{applied}</p>
      ) : (
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            onClick={() => void apply()}
            className="flex-1 rounded-full bg-stone-800 py-2 text-sm font-medium text-white"
          >
            Apply
          </button>
          <button
            type="button"
            onClick={() => void saveAsVariant()}
            className="flex-1 rounded-full border border-stone-300 py-2 text-sm font-medium text-stone-600"
          >
            Save as variant
          </button>
        </div>
      )}
    </div>
  );
}

function PhotoThumb({ photoId }: { photoId: string }) {
  const url = usePhotoUrl(photoId);
  if (!url) return null;
  return (
    <img
      src={url}
      alt="Attached photo"
      className="h-20 w-20 rounded-lg object-cover"
    />
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
          isUser ? 'bg-amber-100' : 'bg-stone-100'
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
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const busy = streamingText !== null;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages?.length, streamingText]);

  const attachPhoto = async (file: File) => {
    const photoId = await photoStore.add(file);
    setPendingPhotos((prev) => [...prev, { photoId, blob: file }]);
  };

  const send = async () => {
    const content = draft.trim();
    if ((content === '' && pendingPhotos.length === 0) || busy) return;

    setError(null);
    setDraft('');
    const photos = pendingPhotos;
    setPendingPhotos([]);

    const history = messages ?? [];
    await chatStore.append({
      recipeId: recipe.id,
      role: 'user',
      content,
      photoIds: photos.map((p) => p.photoId),
    });

    setStreamingText('');
    try {
      const images = await Promise.all(
        photos.map((p) => encodeImageForChat(p.blob)),
      );
      const reply = await streamChatReply({
        recipe,
        cookingState,
        messages: [
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user' as const, content, images },
        ],
        onDelta: setStreamingText,
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
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
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
      <div className="flex h-[75dvh] flex-col rounded-t-3xl bg-white shadow-2xl md:mx-auto md:w-full md:max-w-xl">
        <header className="flex items-center justify-between border-b border-stone-100 px-4 py-3">
          <h2 className="font-semibold">Assistant</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-3 py-1 text-sm text-stone-500"
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
                <div className="max-w-[85%] rounded-2xl bg-stone-100 px-3.5 py-2 whitespace-pre-wrap">
                  {streamingText === '' ? '…' : streamingText}
                </div>
              </div>
            )}
            {error && (
              <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-600">
                {error}
              </p>
            )}
            {(messages ?? []).length === 0 && streamingText === null && (
              <p className="py-8 text-center text-sm text-stone-400">
                Ask anything about this recipe — substitutions, technique,
                timing — or send a photo of how it's going.
              </p>
            )}
          </div>
        </div>

        {pendingPhotos.length > 0 && (
          <div className="flex gap-2 px-4 pb-1">
            {pendingPhotos.map((p) => (
              <PhotoThumb key={p.photoId} photoId={p.photoId} />
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 border-t border-stone-100 px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
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
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-stone-100 text-lg"
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
            className="max-h-32 flex-1 resize-none rounded-2xl border border-stone-200 px-3.5 py-2 outline-none focus:border-stone-400"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy}
            className="h-10 shrink-0 rounded-full bg-stone-800 px-4 font-medium text-white disabled:opacity-40"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

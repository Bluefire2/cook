import { useEffect, useRef, useState } from 'react';
import { chatStore, useChatMessages } from '../lib/chatStore';
import { photoStore, usePhotoUrl } from '../lib/photoStore';
import { streamChatReply, type CookingState } from '../lib/chatApi';
import { encodeImageForChat } from '../lib/image';
import type { ChatMessage, Recipe } from '../lib/types';

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

function MessageBubble({ message }: { message: ChatMessage }) {
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
        content: reply,
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
              <MessageBubble key={m.id} message={m} />
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

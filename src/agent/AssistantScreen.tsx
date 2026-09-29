import {
  useCallback,
  useRef,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../lib/session';
import {
  backLink,
  ghostBtn,
  inputClass,
  primaryBtn,
  secondaryBtn,
} from '../lib/uiClasses';
import { postAgent } from './api';
import { renderAgentCard } from './cards/registry';
import { fitReplay, MAX_USER_CONTENT } from './replay';
import {
  clearAgentThread,
  dispatch,
  getAgentSnapshot,
  messagesForReplay,
  subscribe,
  type AgentMessage,
} from './store';

const STARTERS = [
  'What can I make tonight in about 30 minutes?',
  'Help me cook two recipes together and make a shopping list.',
] as const;

function toolChipLabel(name: string): string {
  switch (name) {
    case 'search_recipes':
      return 'Searching recipes…';
    case 'get_recipes':
      return 'Reading recipes…';
    case 'combine_ingredients':
      return 'Combining ingredients…';
    case 'show_shopping_list':
      return 'Making a shopping list…';
    default:
      return 'Working…';
  }
}

function MessageRow({
  message,
  checked,
  onToggle,
}: {
  message: AgentMessage;
  checked: Record<string, Record<string, true>>;
  onToggle: (cardId: string, itemKey: string) => void;
}) {
  const isUser = message.role === 'user';
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-accent-soft px-3.5 py-2 whitespace-pre-wrap text-sm">
          {message.content}
        </div>
      </div>
    );
  }

  const muted = message.interim === true;
  return (
    <div className="flex justify-start">
      <div
        className={`max-w-[85%] whitespace-pre-wrap text-sm ${
          muted ? 'text-ink-muted' : ''
        }`}
      >
        {message.content !== '' && (
          <div className={`rounded-2xl px-3.5 py-2 ${muted ? '' : 'bg-surface-muted'}`}>
            {message.content}
          </div>
        )}
        {message.cards?.map((card) => (
          <div key={card.id}>{renderAgentCard(card, checked, onToggle)}</div>
        ))}
      </div>
    </div>
  );
}

export default function AssistantScreen() {
  const { status: sessionStatus } = useSession();
  const state = useSyncExternalStore(subscribe, getAgentSnapshot);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const onToggle = useCallback((cardId: string, itemKey: string) => {
    dispatch({ type: 'toggle', cardId, itemKey });
  }, []);

  const runTurn = useCallback(async (userText: string) => {
    if (sessionStatus === 'signedOut' || getAgentSnapshot().streaming) {
      return;
    }
    const trimmed = userText.trim().slice(0, MAX_USER_CONTENT);
    if (trimmed === '') {
      return;
    }

    dispatch({ type: 'begin', userText: trimmed });
    const controller = new AbortController();
    abortRef.current = controller;
    const stillThisTurn = () => abortRef.current === controller;

    try {
      const result = await postAgent({
        messages: fitReplay(messagesForReplay(getAgentSnapshot())),
        clientNow: new Date().toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        signal: controller.signal,
        onEvent: (event) => {
          if (!stillThisTurn()) {
            return;
          }
          dispatch({ type: 'event', event });
        },
      });
      if (!stillThisTurn()) {
        return;
      }
      if (result.aborted) {
        dispatch({ type: 'stopped' });
      } else if (result.truncated) {
        dispatch({
          type: 'event',
          event: { t: 'error', message: "The assistant's reply was cut off." },
        });
      }
    } catch (err) {
      if (!stillThisTurn()) {
        return;
      }
      const message =
        err instanceof Error ? err.message : 'Something went wrong.';
      dispatch({ type: 'event', event: { t: 'error', message } });
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }, [sessionStatus]);

  const onSend = () => {
    const el = draftRef.current;
    const text = el?.value ?? '';
    if (el) {
      el.value = '';
    }
    void runTurn(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  const onStop = () => {
    abortRef.current?.abort();
  };

  const onClear = () => {
    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();
    clearAgentThread();
  };

  if (sessionStatus === 'signedOut') {
    return (
      <div className="mx-auto max-w-xl px-4 pb-24">
        <header className="flex items-center justify-between py-4">
          <Link to="/" className={backLink}>
            ← Library
          </Link>
        </header>
        <p className="text-sm text-ink-muted">
          Sign in from{' '}
          <Link to="/settings" className="text-ink hover:underline">
            Settings
          </Link>{' '}
          to ask about your recipes.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-xl flex-col px-4 pb-24">
      <header className="flex items-center justify-between py-4">
        <Link to="/" className={backLink}>
          ← Library
        </Link>
        <button type="button" onClick={onClear} className={ghostBtn}>
          Clear
        </button>
      </header>

      <div className="flex min-h-[50dvh] flex-1 flex-col gap-2.5 pb-4">
        {state.messages.length === 0 && !state.streaming && (
          <div className="flex flex-col gap-2 py-4">
            {STARTERS.map((text) => (
              <button
                key={text}
                type="button"
                onClick={() => void runTurn(text)}
                className={`text-left text-sm ${secondaryBtn} px-4 py-3`}
              >
                {text}
              </button>
            ))}
          </div>
        )}

        {state.messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            checked={state.checked}
            onToggle={onToggle}
          />
        ))}

        {state.streaming && state.toolLabel && (
          <p className="text-sm text-ink-muted">{toolChipLabel(state.toolLabel)}</p>
        )}

        {state.error && (
          <p className="rounded-xl bg-danger-bg px-3 py-2 text-sm text-danger">{state.error}</p>
        )}
      </div>

      <div className="sticky bottom-0 border-t border-line bg-page pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex items-end gap-2">
          <textarea
            ref={draftRef}
            rows={2}
            disabled={state.streaming}
            onKeyDown={onKeyDown}
            maxLength={MAX_USER_CONTENT}
            placeholder="Ask about your recipes…"
            className={`${inputClass} min-h-[2.75rem] resize-none text-sm`}
          />
          {state.streaming ? (
            <button type="button" onClick={onStop} className={`shrink-0 px-4 py-2.5 text-sm ${secondaryBtn}`}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              className={`shrink-0 px-4 py-2.5 text-sm ${primaryBtn}`}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

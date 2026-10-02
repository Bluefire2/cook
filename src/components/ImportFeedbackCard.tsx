import { useState } from 'react';
import { MAX_FEEDBACK_COMMENT_CHARS } from '../../server/importFeedbackShape.ts';
import { useT } from '../i18n';
import { SpinnerIcon } from '../lib/icons';
import { buildImportFeedback, includedSummary, type FeedbackCardInput } from '../lib/importFeedback';
import { sendImportFeedback } from '../lib/importFeedbackApi';
import { ghostBtn, inputClass, secondaryBtn } from '../lib/uiClasses';

export default function ImportFeedbackCard({
  input,
  compact = false,
}: {
  input: FeedbackCardInput;
  compact?: boolean;
}) {
  const t = useT();
  // Fixed for the card's life: a retry resends the same id and the server dedupes it.
  const [id] = useState(() => crypto.randomUUID());
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');

  async function send() {
    setStatus('sending');
    setErrorText(null);
    try {
      await sendImportFeedback(buildImportFeedback({ ...input, id, comment: note }));
      setStatus('sent');
    } catch (e) {
      setStatus('error');
      setErrorText(e instanceof Error ? e.message : t('importFeedback.sendFailed'));
    }
  }

  if (status === 'sent') {
    return (
      <p role="status" className="mt-3 text-sm text-ink-subtle">
        {t('importFeedback.sent')}
      </p>
    );
  }

  const sending = status === 'sending';
  const summary = includedSummary(input.source);

  return (
    <section
      aria-label={t('importFeedback.heading')}
      className="mt-3 rounded-2xl border border-line bg-surface px-4 py-3 text-sm text-ink"
    >
      <p className="font-medium">{t('importFeedback.heading')}</p>
      {!compact && <p className="mt-0.5 text-ink-subtle">{t('importFeedback.body')}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending}
          aria-busy={sending}
          className={`${secondaryBtn} inline-flex items-center gap-2 px-4 py-1.5 disabled:opacity-40`}
        >
          {sending ? (
            <>
              <SpinnerIcon className="h-4 w-4 animate-spin" />
              {t('importFeedback.sending')}
            </>
          ) : (
            t('importFeedback.send')
          )}
        </button>
        {!noteOpen && (
          <button
            type="button"
            className={ghostBtn}
            aria-expanded={false}
            onClick={() => setNoteOpen(true)}
          >
            {t('importFeedback.addNote')}
          </button>
        )}
      </div>
      {noteOpen && (
        <label className="mt-2 block">
          <span className="text-ink-muted">{t('importFeedback.noteLabel')}</span>
          <textarea
            rows={3}
            maxLength={MAX_FEEDBACK_COMMENT_CHARS}
            placeholder={t('importFeedback.notePlaceholder')}
            className={`mt-1 ${inputClass}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={sending}
          />
        </label>
      )}
      <details className="mt-2">
        <summary className="cursor-pointer text-ink-muted">{t('importFeedback.included')}</summary>
        <ul className="mt-1 list-disc pl-5 text-ink-subtle">
          {summary.kind === 'url' && (
            <li className="break-all">{t('importFeedback.includedLink', { url: summary.url })}</li>
          )}
          {summary.kind === 'paste' && (
            <li>
              {t('importFeedback.includedPaste', { count: summary.chars, preview: summary.preview })}
            </li>
          )}
          {summary.kind === 'photos' && <li>{t('importFeedback.includedPhotos')}</li>}
          <li>{t('importFeedback.includedDetails')}</li>
        </ul>
      </details>
      {status === 'error' && (
        <p role="alert" className="mt-2 text-danger">
          {errorText}
        </p>
      )}
    </section>
  );
}

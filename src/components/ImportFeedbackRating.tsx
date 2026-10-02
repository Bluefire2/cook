import { useState } from 'react';
import { useT } from '../i18n';
import { ThumbDownIcon, ThumbUpIcon } from '../lib/icons';
import { ratingUp, type FeedbackCardInput } from '../lib/importFeedback';
import { sendImportFeedback } from '../lib/importFeedbackApi';
import { ghostIconBtn } from '../lib/uiClasses';
import ImportFeedbackCard from './ImportFeedbackCard';

export default function ImportFeedbackRating({
  input,
}: {
  input: Omit<FeedbackCardInput, 'trigger'>;
}) {
  const t = useT();
  const [choice, setChoice] = useState<'ask' | 'up' | 'down'>('ask');

  if (choice === 'up') {
    return (
      <p role="status" className="mt-6 text-sm text-ink-subtle">
        {t('importFeedback.ratingThanks')}
      </p>
    );
  }
  if (choice === 'down') {
    return <ImportFeedbackCard input={{ ...input, trigger: 'down' }} />;
  }
  return (
    <div className="mt-6 flex items-center gap-2 text-sm text-ink-subtle">
      <span>{t('importFeedback.ratingPrompt')}</span>
      <button
        type="button"
        className={ghostIconBtn}
        aria-label={t('importFeedback.ratingUp')}
        onClick={() => {
          setChoice('up');
          // Best effort: a lost thumbs-up costs nothing, so the person sees no error.
          void sendImportFeedback(ratingUp(input.source)).catch(() => {});
        }}
      >
        <ThumbUpIcon className="h-5 w-5" />
      </button>
      <button
        type="button"
        className={ghostIconBtn}
        aria-label={t('importFeedback.ratingDown')}
        onClick={() => setChoice('down')}
      >
        <ThumbDownIcon className="h-5 w-5" />
      </button>
    </div>
  );
}

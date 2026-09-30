import { useEffect, type ReactNode } from 'react';
import { useT } from '../i18n';

export default function Sheet({
  onClose,
  children,
  dismissible = true,
}: {
  onClose: () => void;
  children: ReactNode;
  dismissible?: boolean;
}) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (dismissible) onClose();
      }
    };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, [dismissible, onClose]);
  const t = useT();
  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end">
      <button
        type="button"
        aria-label={t('sheet.dismiss')}
        tabIndex={-1}
        disabled={!dismissible}
        onClick={onClose}
        className="flex-1 bg-black/40"
      />
      <div className="max-h-[90dvh] overflow-y-auto overscroll-contain rounded-t-3xl bg-surface px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl md:mx-auto md:w-full md:max-w-xl">
        {children}
      </div>
    </div>
  );
}

import type { ReactNode } from 'react';

export default function Sheet({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Dismiss"
        tabIndex={-1}
        onClick={onClose}
        className="flex-1 bg-black/40"
      />
      <div className="rounded-t-3xl bg-surface px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl md:mx-auto md:w-full md:max-w-xl">
        {children}
      </div>
    </div>
  );
}

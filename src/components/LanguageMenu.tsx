import { useEffect, useId, useRef, useState, type FocusEvent } from 'react';
import { SUPPORTED_LOCALES, localeDisplayName, useLocale, useT, type Locale } from '../i18n';
import { ChevronDownIcon } from '../lib/icons';
import { settings } from '../lib/settings';
import { menuItem } from '../lib/uiClasses';

/**
 * UI language switcher for the Library header: the current language's short
 * label and a chevron, opening a list of every UI language by its own name.
 * Writes the same `cook.locale` setting as the select in Settings.
 */
export default function LanguageMenu() {
  const t = useT();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const currentItemRef = useRef<HTMLButtonElement>(null);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    currentItemRef.current?.focus({ preventScroll: true });
    // Capture phase, and stopped, so Library's own Escape handling (closing a
    // recipe menu, leaving Select) does not also run. Only while focus is in
    // the menu: an Escape meant for something else (a sheet opened from
    // Select's bar) closes the menu and passes through.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (!wrapperRef.current?.contains(document.activeElement)) {
        setOpen(false);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  // Focus leaving the menu (Tab, or a tap on something above the backdrop,
  // such as Select's bar) closes it, so it can't stay open under a sheet.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (open && !event.currentTarget.contains(event.relatedTarget)) {
      setOpen(false);
    }
  };

  const choose = (code: Locale) => {
    settings.setLocale(code);
    close();
  };

  const label = t('library.languageMenu');

  return (
    <div ref={wrapperRef} className="relative" onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center rounded-full py-2 pr-1.5 pl-2 text-sm font-medium text-ink-muted hover:bg-surface-muted hover:text-ink active:bg-surface-muted"
      >
        <span lang={locale}>{t('library.languageShort')}</span>
        <ChevronDownIcon
          className={`block h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <>
          <button
            type="button"
            aria-label={t('library.closeMenu')}
            tabIndex={-1}
            onClick={close}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            id={panelId}
            role="group"
            aria-label={label}
            className="absolute top-full right-0 z-20 mt-1 w-44 overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
          >
            {SUPPORTED_LOCALES.map((code, index) => {
              const current = code === locale;
              return (
                <button
                  key={code}
                  ref={current ? currentItemRef : undefined}
                  type="button"
                  lang={code}
                  aria-current={current ? 'true' : undefined}
                  onClick={() => choose(code)}
                  className={`${menuItem} flex items-center justify-between gap-2 ${
                    index > 0 ? 'border-t border-line' : ''
                  } ${current ? 'font-semibold' : ''}`}
                >
                  <span>{localeDisplayName(code)}</span>
                  {current && <span aria-hidden="true">✓</span>}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

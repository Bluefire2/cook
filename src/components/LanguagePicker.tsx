import type { ReactElement } from 'react';
import { useLocale, useT } from '../i18n';
import { buildLanguagePickerOptions } from '../i18n/languageOptions';
import { inputClass } from '../lib/uiClasses';

/**
 * Native language select shared by the import preview and the recipe form.
 * An empty option is "Unknown" and means no `lang`. A value the lists do not
 * contain stays as its own option, so opening the form cannot change it.
 */
export default function LanguagePicker({
  id,
  value,
  onChange,
  disabled,
  className,
}: {
  id?: string;
  /** `undefined` selects Unknown. */
  value: string | undefined;
  onChange: (lang: string | undefined) => void;
  disabled?: boolean;
  /** Replaces the default top margin. The import preview uses that default. */
  className?: string;
}): ReactElement {
  const t = useT();
  const locale = useLocale();
  const options = buildLanguagePickerOptions(locale, value);

  return (
    <select
      id={id}
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => {
        const next = event.target.value;
        onChange(next === '' ? undefined : next);
      }}
      className={`${inputClass} disabled:opacity-40 ${className ?? 'mt-2'}`}
    >
      <option value="">{t('langPicker.unknown')}</option>
      {options.current && (
        <option value={options.current.value}>{options.current.label}</option>
      )}
      {options.app.length > 0 && (
        <optgroup label={t('langPicker.appLanguages')}>
          {options.app.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </optgroup>
      )}
      {options.all.length > 0 && (
        <optgroup label={t('langPicker.allLanguages')}>
          {options.all.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}

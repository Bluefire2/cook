import type { ReactElement } from 'react';
import { useLocale, useT } from '../i18n';
import { buildLanguagePickerOptions } from '../i18n/languageOptions';
import { inputClass } from '../lib/uiClasses';

/**
 * Native language select shared by the import preview and, later, the
 * recipe form. An empty option is "Unknown" and means no `lang`.
 */
export default function LanguagePicker({
  id,
  value,
  onChange,
  disabled,
}: {
  id?: string;
  /** `undefined` selects Unknown. */
  value: string | undefined;
  onChange: (lang: string | undefined) => void;
  disabled?: boolean;
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
      className={`${inputClass} mt-2 disabled:opacity-40`}
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

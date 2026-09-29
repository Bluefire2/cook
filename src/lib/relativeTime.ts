import { formatDistance, type Locale as DateFnsLocale } from 'date-fns';
import { enUS, ru, uk, zhCN } from 'date-fns/locale';
import { translate } from '../i18n';
import type { Locale } from '../i18n/lang';
import { settings } from './settings';

const DATE_FNS_LOCALES: Readonly<Record<Locale, DateFnsLocale>> = {
  en: enUS,
  uk,
  ru,
  'zh-Hans': zhCN,
};

/** date-fns locale for a UI language; every supported language has one. */
export function dateFnsLocale(locale: Locale): DateFnsLocale {
  return DATE_FNS_LOCALES[locale];
}

/**
 * Past relative time for the invitations menu. date-fns picks the unit
 * (minutes, hours, days, and beyond) from the delta. A future or unusable
 * timestamp stays "just now", so a row never reads as upcoming and a bad
 * value cannot throw through the admin list.
 */
export function relativeAgoLabel(
  at: number,
  now: number = Date.now(),
  locale: Locale = settings.getLocale(),
): string {
  if (!Number.isFinite(at) || !Number.isFinite(now) || at > now) {
    return translate(locale, 'time.justNow');
  }
  return formatDistance(at, now, { addSuffix: true, locale: dateFnsLocale(locale) });
}

/** Future timestamp for an unused invite link ("expires in 7 days"). */
export function relativeExpiryLabel(
  at: number,
  now: number = Date.now(),
  locale: Locale = settings.getLocale(),
): string {
  const base = Number.isFinite(now) ? now : Date.now();
  // date-fns reads an equal instant as past; a 1 ms lead keeps the future wording.
  const target = Number.isFinite(at) && at > base ? at : base + 1;
  const distance = formatDistance(target, base, {
    addSuffix: true,
    locale: dateFnsLocale(locale),
  });
  return translate(locale, 'time.expiresIn', { in: distance });
}

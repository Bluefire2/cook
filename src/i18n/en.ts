/**
 * English catalog. This file defines the key set: every other catalog is
 * typed `Messages`, so a missing or extra key fails `tsc`. Plural keys hold a
 * `PluralForms` object selected with `Intl.PluralRules`; `{count}` and other
 * `{name}` placeholders are filled by `t()`.
 */

export interface PluralForms {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
}

export const en = {
  justNow: 'just now',
  expiresIn: 'expires {in}',
  loadedAgo: 'Loaded {time}',
  language: 'Language',
  servingsCount: {
    one: '{count} serving',
    other: '{count} servings',
  },
  recipesCount: {
    one: '{count} recipe',
    other: '{count} recipes',
  },
} as const satisfies Record<string, string | PluralForms>;

type EnMessages = typeof en;

export type Messages = {
  readonly [K in keyof EnMessages]: EnMessages[K] extends string ? string : PluralForms;
};

export type MessageKey = keyof Messages;

export type PluralKey = {
  [K in MessageKey]: EnMessages[K] extends string ? never : K;
}[MessageKey];

export type TextKey = Exclude<MessageKey, PluralKey>;

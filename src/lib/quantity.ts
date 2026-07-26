const UNICODE_FRACTIONS: [number, string][] = [
  [1 / 8, '⅛'],
  [1 / 4, '¼'],
  [1 / 3, '⅓'],
  [3 / 8, '⅜'],
  [1 / 2, '½'],
  [5 / 8, '⅝'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
  [7 / 8, '⅞'],
];

/**
 * Formats a (possibly scaled) quantity for display: whole numbers as-is,
 * common fractions as unicode glyphs ("1½"), everything else rounded to
 * two decimals.
 */
export function formatQuantity(quantity: number): string {
  const whole = Math.floor(quantity);
  const frac = quantity - whole;

  if (frac < 0.01) return String(whole);

  for (const [value, glyph] of UNICODE_FRACTIONS) {
    if (Math.abs(frac - value) < 0.02) {
      return whole > 0 ? `${whole}${glyph}` : glyph;
    }
  }

  return String(Math.round(quantity * 100) / 100);
}

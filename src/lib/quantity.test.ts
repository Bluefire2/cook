import { describe, expect, it } from 'vitest';
import { formatQuantity } from './quantity';

const GLYPHS: [number, string][] = [
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

describe('formatQuantity', () => {
  it('renders whole numbers, including zero, without a fraction', () => {
    expect(formatQuantity(0)).toBe('0');
    expect(formatQuantity(1)).toBe('1');
    expect(formatQuantity(12)).toBe('12');
  });

  it.each(GLYPHS)('renders %d exactly as %s', (value, glyph) => {
    expect(formatQuantity(value)).toBe(glyph);
  });

  it('prefixes the whole part when there is one', () => {
    expect(formatQuantity(1.5)).toBe('1½');
    expect(formatQuantity(2.25)).toBe('2¼');
    expect(formatQuantity(3 + 7 / 8)).toBe('3⅞');
  });

  it('drops a fractional part under 0.01', () => {
    expect(formatQuantity(2.005)).toBe('2');
    expect(formatQuantity(1.009)).toBe('1');
  });

  it('keeps a fractional part at or above 0.01', () => {
    expect(formatQuantity(0.02)).toBe('0.02');
    expect(formatQuantity(2.03)).toBe('2.03');
    expect(formatQuantity(1.05)).toBe('1.05');
  });

  it('treats a whole-number-plus-epsilon as the whole number, so a quantity under 0.01 renders as "0"', () => {
    expect(formatQuantity(0.005)).toBe('0');
  });

  it('accepts a fraction within 0.02 on either side', () => {
    expect(formatQuantity(0.481)).toBe('½');
    expect(formatQuantity(0.519)).toBe('½');
    expect(formatQuantity(1.481)).toBe('1½');
  });

  it('rejects a fraction at exactly 0.02 away, since the tolerance is exclusive', () => {
    expect(formatQuantity(0.48)).toBe('0.48');
    expect(formatQuantity(0.52)).toBe('0.52');
  });

  it('leaves a dead zone between ⅓ and ⅜ that no glyph covers (current behaviour)', () => {
    expect(formatQuantity(0.353)).toBe('⅓');
    expect(formatQuantity(0.3534)).toBe('0.35');
    expect(formatQuantity(0.3549)).toBe('0.35');
    expect(formatQuantity(0.356)).toBe('⅜');
  });

  it('never returns a glyph other than the nearest one, because no two tolerance windows overlap', () => {
    for (let frac = 0.01; frac < 1; frac += 0.001) {
      const rounded = Math.round(frac * 1000) / 1000;
      const distances = GLYPHS.map(([value]) => Math.abs(rounded - value));
      const nearest = Math.min(...distances);
      const result = formatQuantity(rounded);
      if (/[⅛¼⅓⅜½⅝⅔¾⅞]/.test(result)) {
        expect(result).toBe(GLYPHS[distances.indexOf(nearest)][1]);
      } else {
        expect(nearest).toBeGreaterThanOrEqual(0.02);
      }
    }
  });

  it('falls back to two decimals when nothing matches', () => {
    expect(formatQuantity(0.4)).toBe('0.4');
    expect(formatQuantity(2.4)).toBe('2.4');
    expect(formatQuantity(0.105)).toBe('0.11');
    expect(formatQuantity(1.425)).toBe('1.43');
  });

  it('renders values just under a whole number as decimals rather than rounding up (current behaviour)', () => {
    expect(formatQuantity(0.99)).toBe('0.99');
    expect(formatQuantity(1.96)).toBe('1.96');
    expect(formatQuantity(0.999)).toBe('1');
  });
});

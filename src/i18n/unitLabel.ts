import type { MessageKey } from './en';
import { COMMON_UNITS, type CommonUnit } from '../lib/units';

/** Display labels for stored English unit tokens. A custom unit is recipe text and stays as typed. */
const UNIT_KEYS: Record<CommonUnit, MessageKey> = {
  piece: 'unit.piece',
  tsp: 'unit.tsp',
  tbsp: 'unit.tbsp',
  cup: 'unit.cup',
  ml: 'unit.ml',
  l: 'unit.l',
  g: 'unit.g',
  kg: 'unit.kg',
  oz: 'unit.oz',
  lb: 'unit.lb',
};

export function unitLabel(token: string, translate: (key: MessageKey) => string): string {
  if ((COMMON_UNITS as readonly string[]).includes(token)) {
    return translate(UNIT_KEYS[token as CommonUnit]);
  }
  return token;
}

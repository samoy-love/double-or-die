/**
 * Контраст палитры как гейт.
 *
 * Тот же расчёт, что и в `npm run check:contrast`, но внутри общего прогона:
 * цвета правят чаще, чем вспоминают про отдельную команду, а проваленный
 * контраст — это не «некрасиво», а невидимый снаряд или враг, принятый за
 * себя (GDD §21).
 */

import { describe, expect, it } from 'vitest';
import {
  CONTRAST_PAIRS,
  DELTA_E_MIN,
  contrastFailures,
  deltaE,
  toLab,
} from '../packages/client/src/contrast';
import { PALETTE } from '../packages/client/src/palette';

describe('контраст палитры', () => {
  it('все обязательные пары различимы', () => {
    const failures = contrastFailures().map(
      (f) => `${f.a} / ${f.b}: ΔE ${f.deltaE.toFixed(1)} — ${f.why}`,
    );
    expect(failures).toEqual([]);
  });

  it('пары описаны и не выродились в пустой список', () => {
    expect(CONTRAST_PAIRS.length).toBeGreaterThan(50);
    for (const p of CONTRAST_PAIRS) expect(p.why.length).toBeGreaterThan(0);
  });

  /*
   * Проверка самой меры, а не палитры.
   *
   * Гейт, у которого сломан расчёт, зелен всегда и потому бесполезен. Опорные
   * значения — из определения CIEDE2000: ноль на совпадении и заметная
   * разница на белом против чёрного.
   */
  it('ΔE считается, а не возвращает ноль', () => {
    expect(deltaE(PALETTE.chip, PALETTE.chip)).toBeCloseTo(0, 6);
    expect(deltaE({ r: 1, g: 1, b: 1 }, { r: 0, g: 0, b: 0 })).toBeGreaterThan(DELTA_E_MIN);
  });

  it('белый и чёрный переводятся в Lab по определению', () => {
    expect(toLab({ r: 1, g: 1, b: 1 }).L).toBeCloseTo(100, 3);
    expect(toLab({ r: 0, g: 0, b: 0 }).L).toBeCloseTo(0, 6);
  });
});

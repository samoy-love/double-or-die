/**
 * Гейт типографики: ни одной надписи мельче порога UX §4.
 *
 * Правило «минимальный размер текста — 24 px при 1080p» невозможно удержать
 * вниманием на ревью: арена — ровно 1920×1080 единиц, кегль вписывается
 * числом в место вызова, и «13» рядом с «14» выглядит там совершенно
 * безобидно. Один раз так уже разъехалось: подсказки дверей набирались
 * двенадцатью пикселями, имя пари на расчёте — тринадцатью, то есть вдвое
 * ниже собственного порога, а гейт контраста этого не видит — он про ΔE пар
 * арены, а не про текст.
 *
 * Проверяется исходник, а не кадр: кегль — это литерал в вызове, и поймать
 * его дешевле там, где он написан.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEXT } from '../packages/client/src/typography';

const SRC = join(import.meta.dirname, '..', 'packages', 'client', 'src');

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')
        ? [join(dir, e.name)]
        : [],
  );

/**
 * Кегль — аргумент перед `Face.…` в вызове `text.push`.
 *
 * Разбирается регуляркой, а не парсером: вызов один и тот же во всём клиенте,
 * а тащить в тесты разбор TypeScript ради четвёртого аргумента дороже, чем
 * читать его глазами при следующей правке сигнатуры.
 */
const SIZES = /\.push\(([\s\S]*?)Face\./g;

describe('типографика', () => {
  it('все кегли шкалы не ниже порога UX §4', () => {
    for (const [name, value] of Object.entries(TEXT)) {
      expect(value, `ступень ${name}`).toBeGreaterThanOrEqual(TEXT.MIN);
    }
  });

  it('ни одна надпись в клиенте не набрана мельче порога', () => {
    const small: string[] = [];
    for (const file of sources(SRC)) {
      const code = readFileSync(file, 'utf8');
      for (const m of code.matchAll(SIZES)) {
        const args = m[1]
          .split(',')
          .map((a) => a.trim())
          .filter((a) => a !== '');
        const size = args[args.length - 1];
        // Кегль из шкалы или из переменной — уже проверен первым тестом либо
        // зажат `Math.max(TEXT.MIN, …)` в самом помощнике.
        if (!/^\d+(\.\d+)?$/.test(size)) continue;
        if (Number(size) < TEXT.MIN) small.push(`${file}: кегль ${size}`);
      }
    }
    expect(small).toEqual([]);
  });
});

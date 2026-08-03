/**
 * Golden-реплеи как гейт.
 *
 * Прогоняются в обычном `npm test`, а значит — на всех трёх ОС матрицы CI.
 * Отдельная задача для этого не нужна: реплей проверяет ядро, а ядро на
 * каждой ОС и так собирается и тестируется.
 *
 * Что именно ловит этот тест, чего не ловят соседи: изменение поведения между
 * версиями кода. «Один сид — один хеш» ловит недетерминизм внутри прогона,
 * сверка платформ — расхождение между машинами, и обе остаются зелёными,
 * когда правка тихо меняет физику одинаково везде.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKPOINT_EVERY, type Golden, verifyGolden } from '../packages/tools/src/golden';

const DIR = join(__dirname, 'golden');

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

const load = (f: string): Golden => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as Golden;

describe('golden-реплеи', () => {
  // Пустой каталог — это молча пропущенный гейт, а не «всё прошло».
  // Ровно так проверка и умирает: файлы не доехали, тест зелёный.
  it('эталоны на месте', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it.each(files)('%s сходится тик в тик', (f) => {
    const result = verifyGolden(load(f));
    // Сообщение содержит номер тика: на 3600 тиках знать, ЧТО разошлось,
    // мало — нужно знать, где, иначе следующий шаг это бисекция вручную.
    expect(result.failures).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('хеши сняты не только в конце', () => {
    for (const f of files) {
      const g = load(f);
      expect(g.checkpoints.length).toBeGreaterThan(1);
      for (const c of g.checkpoints.slice(0, -1)) {
        expect(c.tick % CHECKPOINT_EVERY).toBe(0);
      }
    }
  });

  it('покрыты все составы от одного до четырёх игроков', () => {
    const players = new Set(files.map((f) => f.match(/-p(\d)\./)?.[1]));
    expect([...players].sort()).toEqual(['1', '2', '3', '4']);
  });

  // Тест обязан уметь падать. Эталон с испорченным хешем должен быть
  // отвергнут — иначе всё вышеперечисленное подтверждает что угодно.
  it('ловит расхождение', () => {
    const g = load(files[0]);
    const broken: Golden = {
      ...g,
      checkpoints: g.checkpoints.map((c, i) => (i === 0 ? { ...c, hash: '0xdeadbeef' } : c)),
    };
    const result = verifyGolden(broken);
    expect(result.ok).toBe(false);
    expect(result.failures[0].tick).toBe(g.checkpoints[0].tick);
  });

  // Реплей, записанный при других константах, обязан быть отвергнут явно, а
  // не проявиться расхождением хеша: причина «поменяли баланс» и причина
  // «сломали детерминизм» требуют разных действий.
  it('отвергает эталон от другой версии конфига', () => {
    const g = load(files[0]);
    const replay = JSON.parse(g.replay) as { configVersion: string };
    replay.configVersion = '0.0.1-иная';
    expect(() => verifyGolden({ ...g, replay: JSON.stringify(replay) })).toThrow(/ре-бейзлайн/);
  });
});

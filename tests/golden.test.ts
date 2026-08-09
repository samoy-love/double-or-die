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
import { EnemyType, RunPhase } from '@dod/sim';
import { CHECKPOINT_EVERY, type Golden, scanCoverage, verifyGolden } from '@dod/tools/golden';

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

  it('хеши сняты не только в конце — там, где есть что бисектить', () => {
    for (const f of files) {
      const g = load(f);
      // Требование «больше одной точки» осмысленно только на записи длиннее
      // интервала: короткая запись с подготовленного состояния (см. `setup`)
      // может быть короче CHECKPOINT_EVERY целиком, и на ней бисектить
      // нечего — расхождение в 150 тиках ищут глазами, а не точками.
      const last = g.checkpoints.at(-1)?.tick ?? 0;
      if (last >= CHECKPOINT_EVERY) expect(g.checkpoints.length).toBeGreaterThan(1);
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

  /**
   * Покрытие, а не только сходимость хешей.
   *
   * «Хеш сошёлся» и «эталон видел этаж» — разные вопросы: изначальный корпус
   * (двадцать записей ботом `random`, 3600 тиков) сходился сам с собой на
   * каждой правке, включая ту, что видел только Клин в первой комнате, — ни
   * дверь, ни лавка, ни плата, ни босс в нём не появлялись НИКОГДА. Правка HP
   * Фитиля прошла все двадцать эталонов молча зелёными именно поэтому.
   *
   * Проверка суммирует покрытие по ВСЕМУ корпусу, а не по одному файлу: цена
   * дыры была в том, что её ловил только осознанный ре-бейзлайн руками, а не
   * тест. Корпус обязан свалиться сам, если снова скатится к первой комнате.
   */
  describe('покрытие корпуса', () => {
    const coverage = files.map((f) => scanCoverage(load(f)));
    const seenTypes = coverage.reduce((acc, c) => acc | c.seenTypes, 0);
    const phases = new Set<number>();
    const bossPhases = new Set<number>();
    for (const c of coverage) {
      for (const p of c.phases) phases.add(p);
      for (const p of c.bossPhases) bossPhases.add(p);
    }

    it('видел все три типа врагов версии', () => {
      expect(seenTypes & (1 << EnemyType.Wedge)).not.toBe(0);
      expect(seenTypes & (1 << EnemyType.Brick)).not.toBe(0);
      expect(seenTypes & (1 << EnemyType.Fuse)).not.toBe(0);
    });

    it('видел дверь, лавку и плату заведению', () => {
      expect(phases.has(RunPhase.Door)).toBe(true);
      expect(phases.has(RunPhase.Reward)).toBe(true);
      expect(phases.has(RunPhase.HouseCut)).toBe(true);
    });

    // Не «хотя бы одна смена», а все три фазы подряд: пороги 70% и 35%
    // (`stepPhases` в `boss.ts`) пересчитываются заново каждый тик, и удар,
    // снёсший обе полосы разом, помечает фазы 2 и 3 в один и тот же тик —
    // тест на «больше одной» такое пропустил бы, а на самом деле фаза 2 в
    // записи не была ни разу видна отдельно от 3.
    it('видел бой с боссом и все три его фазы подряд', () => {
      expect(phases.has(RunPhase.Boss)).toBe(true);
      expect([...bossPhases].sort()).toEqual([1, 2, 3]);
    });
  });
});

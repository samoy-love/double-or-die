/**
 * Ноль аллокаций в горячем пути.
 *
 * Правило ядра, которое невозможно соблюсти «по памяти»: один забытый литерал
 * объекта или массива внутри тика — и сборщик мусора приходит посреди боя. На
 * глаз это случайные микрофризы раз в несколько секунд, и ищут их долго,
 * потому что проявляются они не там, где написаны.
 *
 * Как именно меряем — важнее, чем кажется, и двух очевидных способов не
 * хватает:
 *
 *   — heapUsed ПОСЛЕ принудительной сборки ловит только удержанный рост,
 *     то есть утечку. Мусор, который сборщик уже забрал, пройдёт мимо — а он
 *     и есть источник фризов.
 *   — счёт событий сборки не различает вовсе: невыходящие за область
 *     объекты V8 устраняет оптимизатором, и сборок не происходит ни в том,
 *     ни в другом случае.
 *
 * Поэтому нижняя граница снимается после принудительной сборки, а верхняя —
 * БЕЗ неё: мусор десяти тысяч тиков успевает накопиться в молодом поколении
 * и виден как рост. Замер различает уверенно: чистый цикл даёт единицы
 * килобайт, объект на тик — сотни.
 *
 * Требует `--expose-gc` (включён в vitest.config.ts).
 */

import { describe, expect, it } from 'vitest';
import {
  checkInvariants,
  createSnapshot,
  createState,
  hashState,
  saveSnapshot,
  spawnPlayers,
  step,
} from '../packages/sim/src/index';
import { makeBot } from '../packages/tools/src/bots';

const TICKS = 10_000;
/** Порог с запасом: ловим систематическую аллокацию, а не шум замера. */
const MAX_GROWTH_BYTES = 256 * 1024;

const gc = globalThis.gc;

/** Отправная точка: куча без мусора, оставшегося от прогрева. */
function settledHeap(): number {
  // Дважды: первый проход освобождает, второй добирает то, что стало
  // недостижимым в первом.
  gc?.();
  gc?.();
  return process.memoryUsage().heapUsed;
}

describe.skipIf(!gc)('аллокации', () => {
  it(`${TICKS} тиков не растят кучу`, () => {
    const s = createState(1, 4);
    spawnPlayers(s);
    const bot = makeBot('random', 1, 4);

    // Прогрев: первые тики законно аллоцируют — прогреваются и структуры
    // движка, и скрытые классы V8.
    for (let t = 0; t < 2000; t++) step(s, bot.inputs(s));

    const before = settledHeap();
    for (let t = 0; t < TICKS; t++) step(s, bot.inputs(s));
    const growth = process.memoryUsage().heapUsed - before;

    expect(growth).toBeLessThan(MAX_GROWTH_BYTES);
  });

  it('хеш и снимок не аллоцируют', () => {
    const s = createState(1, 4);
    spawnPlayers(s);
    const snap = createSnapshot(s);

    for (let i = 0; i < 2000; i++) {
      hashState(s);
      saveSnapshot(s, snap);
    }

    const before = settledHeap();
    for (let i = 0; i < TICKS; i++) {
      hashState(s);
      saveSnapshot(s, snap);
    }
    const growth = process.memoryUsage().heapUsed - before;

    expect(growth).toBeLessThan(MAX_GROWTH_BYTES);
  });

  // Инварианты идут в dev-сборке по тику: замыкание внутри них стоило бы
  // столько же, сколько сама проверка.
  it('проверка инвариантов не аллоцирует', () => {
    const s = createState(1, 4);
    spawnPlayers(s);

    for (let i = 0; i < 2000; i++) checkInvariants(s);

    const before = settledHeap();
    for (let i = 0; i < TICKS; i++) checkInvariants(s);
    const growth = process.memoryUsage().heapUsed - before;

    expect(growth).toBeLessThan(MAX_GROWTH_BYTES);
  });

  // Замер обязан уметь видеть аллокацию — иначе оба теста выше зелёные
  // просто потому, что ничего не меряют.
  it('замер видит аллокацию, если она есть', () => {
    const sink: { last: unknown } = { last: null };
    for (let i = 0; i < 2000; i++) sink.last = { x: i, y: i };

    const before = settledHeap();
    for (let i = 0; i < TICKS; i++) sink.last = { x: i, y: i };
    const growth = process.memoryUsage().heapUsed - before;

    expect(growth).toBeGreaterThan(MAX_GROWTH_BYTES);
  });
});

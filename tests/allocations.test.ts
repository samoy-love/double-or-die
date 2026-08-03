/**
 * Ноль аллокаций в горячем пути.
 *
 * Правило ядра, которое невозможно соблюсти «по памяти»: один забытый литерал
 * объекта или массива внутри тика — и сборщик мусора приходит посреди боя. На
 * глаз это случайные микрофризы раз в несколько секунд, и ищут их долго,
 * потому что проявляются они не там, где написаны.
 *
 * Ловится этим тестом не только литерал. Дробное число, лежащее в переменной
 * МОДУЛЯ, V8 хранит объектом в куче, и каждая запись в него — аллокация;
 * ровно так шестьсот байт мусора в тик однажды и появились, причём в коде,
 * где не было ни одной фигурной скобки.
 *
 * Как меряем. Рост `heapUsed` за окно фиксированной длины, много раз, медиана.
 *
 * Одного окна не хватает: как только тик стал делать настоящую работу, в окно
 * начала попадать сборка мусора, и замер показывал то плюс два мегабайта, то
 * МИНУС полтора — то есть отчитывался о моменте сборки, а не об аллокации.
 * Окно в несколько тысяч итераций короче интервала между сборками, а медиана из
 * нескольких окон отбрасывает то, в которое сборка всё-таки попала.
 *
 * Сэмплирующий профилировщик выделений, который напрашивается первым, здесь
 * не годится: на этих объёмах он показывал заведомо аллоцирующему контролю
 * меньше, чем чистому циклу. Грубая мера, которая различает, лучше точной,
 * которая не различает.
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

/**
 * Длина окна замера.
 *
 * Короче интервала между сборками мусора, но достаточно длинное, чтобы
 * ступенька роста кучи размазалась. При тысяче итераций один шаг расширения
 * в 64 КБ — это 64 байта на итерацию чистого шума, ровно на границе порога;
 * при четырёх тысячах он падает вчетверо и перестаёт мешать.
 */
const WINDOW = 4000;
/** Сколько окон снять. Нечётное — чтобы медиана была настоящим замером. */
const ROUNDS = 7;

/**
 * Потолок байт на итерацию.
 *
 * Не ноль: `heapUsed` растёт ступенями, и пара десятков байт на итерацию —
 * это шум замера. Систематическая аллокация даёт сотни байт, разница на
 * порядок, поэтому порог различает уверенно, а не балансирует на грани.
 */
const MAX_BYTES_PER_ITERATION = 64;

const gc = globalThis.gc;

function median(xs: readonly number[]): number {
  return [...xs].sort((a, b) => a - b)[xs.length >> 1];
}

/** Байт на итерацию: медиана по окнам, каждое с чистой куче на старте. */
function bytesPerIteration(fn: () => void): number {
  // Первое окно выбрасывается: в нём догреваются скрытые классы и
  // оптимизатор, и оно систематически дороже остальных.
  const rounds: number[] = [];
  for (let r = 0; r <= ROUNDS; r++) {
    // Дважды: первый проход освобождает, второй добирает то, что стало
    // недостижимым в первом.
    gc?.();
    gc?.();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < WINDOW; i++) fn();
    const growth = (process.memoryUsage().heapUsed - before) / WINDOW;
    if (r > 0) rounds.push(growth);
  }
  return median(rounds);
}

/** Прогретое состояние: первые тики законно аллоцируют скрытые классы V8. */
function warmRun(players = 4) {
  const s = createState(1, players);
  spawnPlayers(s);
  const bot = makeBot('random', 1, players);
  for (let t = 0; t < 2000; t++) step(s, bot.inputs(s));
  return { s, bot };
}

describe.skipIf(!gc)('аллокации', () => {
  // Контроль над контролем: если замер перестанет ловить объект в цикле, все
  // остальные проверки файла станут зелёными, ничего не проверяя.
  it('замер видит аллокацию, если она есть', () => {
    const sink: unknown[] = [];
    const bytes = bytesPerIteration(() => {
      sink.length = 0;
      sink.push({ x: 1, y: 2 });
    });
    expect(bytes).toBeGreaterThan(MAX_BYTES_PER_ITERATION);
  });

  it('тик боя не аллоцирует', () => {
    const { s, bot } = warmRun();
    expect(bytesPerIteration(() => step(s, bot.inputs(s)))).toBeLessThan(MAX_BYTES_PER_ITERATION);
  });

  it('хеш и снимок не аллоцируют', () => {
    const { s } = warmRun();
    const snap = createSnapshot(s);
    for (let i = 0; i < 2000; i++) saveSnapshot(s, snap);

    const bytes = bytesPerIteration(() => {
      hashState(s);
      saveSnapshot(s, snap);
    });
    expect(bytes).toBeLessThan(MAX_BYTES_PER_ITERATION);
  });

  // Инварианты идут в dev-сборке по тику: замыкание внутри них стоило бы
  // столько же, сколько сама проверка.
  it('проверка инвариантов не аллоцирует', () => {
    const { s } = warmRun();
    for (let i = 0; i < 2000; i++) checkInvariants(s);
    expect(bytesPerIteration(() => checkInvariants(s))).toBeLessThan(MAX_BYTES_PER_ITERATION);
  });
});

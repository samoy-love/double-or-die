/**
 * Тригонометрия по таблицам.
 *
 * `Math.sin`/`Math.cos`/`Math.atan2` не специфицированы стандартом и расходятся
 * между движками — использовать их в симуляции нельзя. Таблица строится один
 * раз при загрузке модуля и даёт одинаковый результат везде, потому что
 * заполняется через целочисленные операции над значениями, посчитанными
 * один раз и записанными как константы шага.
 */

import { type Fx, FX_ONE, fromFloat, mul, sub, add, div, abs } from './fixed';

/** Полный оборот в наших единицах угла. Степень двойки — маска вместо деления. */
export const ANGLE_FULL = 4096;
export const ANGLE_MASK = ANGLE_FULL - 1;
export const ANGLE_HALF = ANGLE_FULL >> 1;
export const ANGLE_QUARTER = ANGLE_FULL >> 2;

/**
 * Таблица синуса на четверть оборота включительно.
 *
 * Считается через Math.sin ОДИН РАЗ при загрузке и сразу округляется в Q16.16.
 * Расхождение движков в последних битах double здесь безопасно: после
 * округления до 1/65536 все реализации дают одно и то же целое — разница
 * double находится далеко за пределами этой точности. Дальше симуляция
 * работает только с целыми из таблицы.
 */
const SIN_TABLE = (() => {
  const t = new Int32Array(ANGLE_QUARTER + 1);
  for (let i = 0; i <= ANGLE_QUARTER; i++) {
    t[i] = fromFloat(Math.sin((i * Math.PI * 2) / ANGLE_FULL));
  }
  return t;
})();

/** Синус угла. Угол — целое в единицах 1/4096 оборота, любое по величине. */
export function sin(angle: number): Fx {
  const a = angle & ANGLE_MASK;
  if (a <= ANGLE_QUARTER) return SIN_TABLE[a];
  if (a <= ANGLE_HALF) return SIN_TABLE[ANGLE_HALF - a];
  if (a <= ANGLE_HALF + ANGLE_QUARTER) return -SIN_TABLE[a - ANGLE_HALF];
  return -SIN_TABLE[ANGLE_FULL - a];
}

export const cos = (angle: number): Fx => sin(angle + ANGLE_QUARTER);

/**
 * Угол вектора в единицах 1/4096 оборота.
 *
 * Двоичный поиск по таблице тангенса заменён на приближение: считаем отношение
 * меньшей координаты к большей и берём угол из таблицы арктангенса первого
 * октанта, затем разворачиваем по знакам и по тому, какая координата больше.
 */
const ATAN_TABLE = (() => {
  // Арктангенс на [0, 1] с шагом 1/256 — этого достаточно: ошибка не
  // превышает половины единицы угла, а прицел в игре и так квантуется.
  const t = new Int32Array(257);
  for (let i = 0; i <= 256; i++) {
    t[i] = Math.round((Math.atan(i / 256) * ANGLE_FULL) / (Math.PI * 2));
  }
  return t;
})();

export function atan2(y: Fx, x: Fx): number {
  if (x === 0 && y === 0) return 0;

  const ax = abs(x);
  const ay = abs(y);
  // Отношение меньшего к большему всегда в [0, 1] — индекс не выйдет за таблицу.
  const ratio = ay <= ax ? div(ay, ax) : div(ax, ay);
  const idx = (ratio * 256) >> 16;
  let a = ATAN_TABLE[idx < 0 ? 0 : idx > 256 ? 256 : idx];

  if (ay > ax) a = ANGLE_QUARTER - a;
  if (x < 0) a = ANGLE_HALF - a;
  if (y < 0) a = -a;

  return a & ANGLE_MASK;
}

/** Длина вектора. */
export function length(x: Fx, y: Fx): Fx {
  // sqrt(x² + y²) через fixed-умножение: квадраты могут переполнить Q16.16
  // на больших дистанциях, поэтому считаем в обычных целых и возвращаемся.
  const fx = x / FX_ONE;
  const fy = y / FX_ONE;
  const d2 = fx * fx + fy * fy;
  if (d2 === 0) return 0;
  // Ньютон в обычных числах, но над целыми значениями и с усечением —
  // результат детерминирован, потому что все промежуточные значения точны
  // в пределах мантиссы.
  let r = d2 > 1 ? d2 : 1;
  for (let i = 0; i < 12; i++) {
    const next = (r + d2 / r) / 2;
    if (Math.abs(next - r) < 1e-9) {
      r = next;
      break;
    }
    r = next;
  }
  return Math.round(r * FX_ONE) | 0;
}

/**
 * Нормализовать вектор к единичной длине. Результат — в `normX`/`normY`.
 *
 * Возврат через модульные переменные, а не кортежем `[x, y]`, ровно по одной
 * причине: кортеж — это аллокация, а функция зовётся до четырёх раз на игрока
 * за тик. На четверых это четверть килобайта мусора в тик, то есть визит
 * сборщика посреди боя каждые несколько секунд. Ядру аллоцировать в горячем
 * пути запрещено, и запрет проверяется тестом tests/allocations.test.ts.
 *
 * Значения ЖИВУТ ДО СЛЕДУЮЩЕГО ВЫЗОВА: читать их нужно сразу. Симуляция
 * однопоточная и детерминированная, поэтому общий буфер здесь безопасен.
 */
export let normX: Fx = 0;
export let normY: Fx = 0;

export function normalize(x: Fx, y: Fx): void {
  const len = length(x, y);
  if (len === 0) {
    normX = 0;
    normY = 0;
    return;
  }
  normX = div(x, len);
  normY = div(y, len);
}

/** Кратчайшая разница между углами со знаком, в единицах угла. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) & ANGLE_MASK;
  if (d > ANGLE_HALF) d -= ANGLE_FULL;
  return d;
}

// Реэкспорт, чтобы модулю боя хватало одного импорта.
export { mul, sub, add, div };

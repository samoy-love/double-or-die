/**
 * Арифметика с фиксированной точкой Q16.16.
 *
 * Почему не обычные числа. IEEE-754 гарантирует одинаковый результат для
 * `+ - * /` и `sqrt` на любой платформе, но `Math.sin`, `Math.cos` и `atan2`
 * стандартом НЕ специфицированы: V8, JavaScriptCore и SpiderMonkey дают разные
 * последние биты. Одного расхождения хватает, чтобы через полминуты у двух
 * игроков разошлись миры, а golden-реплей перестал сходиться.
 *
 * Всё, что попадает в состояние симуляции, живёт здесь.
 */

/** Число в формате Q16.16: старшие 16 бит — целая часть, младшие — дробная. */
export type Fx = number;

export const FX_BITS = 16;
export const FX_ONE = 1 << FX_BITS; // 65536
export const FX_HALF = FX_ONE >> 1;

/** Максимум и минимум, представимые в Q16.16 внутри 32-битного знакового. */
export const FX_MAX = 0x7fffffff;
export const FX_MIN = -0x80000000;

export const fromInt = (n: number): Fx => (n << FX_BITS) | 0;
export const toInt = (a: Fx): number => a >> FX_BITS;

/**
 * Из обычного числа. Только для констант и ввода — в горячем пути симуляции
 * плавающей точки быть не должно.
 */
export const fromFloat = (n: number): Fx => Math.round(n * FX_ONE) | 0;

/** В обычное число. Только для рендера и отладки, не для логики. */
export const toFloat = (a: Fx): number => a / FX_ONE;

export const add = (a: Fx, b: Fx): Fx => (a + b) | 0;
export const sub = (a: Fx, b: Fx): Fx => (a - b) | 0;
export const neg = (a: Fx): Fx => -a | 0;
export const abs = (a: Fx): Fx => (a < 0 ? -a : a) | 0;

/**
 * Умножение через разбиение на старшую и младшую половины.
 *
 * Прямое `a * b / FX_ONE` неверно: произведение двух Q16.16 занимает до 64 бит,
 * а мантисса float64 хранит только 53 — старшие биты молча теряются, и
 * результат зависит от величины операндов. `Math.imul` тоже не спасает: он
 * возвращает младшие 32 бита, а нам нужны биты 16..47.
 *
 * Раскладываем `a = ah·2^16 + al` и считаем произведение по частям, каждая из
 * которых помещается в 32 бита точно.
 */
export function mul(a: Fx, b: Fx): Fx {
  const ah = a >> FX_BITS;
  const al = a & 0xffff;
  const bh = b >> FX_BITS;
  const bl = b & 0xffff;

  // ah·bh уходит в биты 32+ — при нормальных величинах это переполнение,
  // и оно должно быть видно, а не отброшено молча (см. mulChecked).
  const hi = Math.imul(ah, bh) << FX_BITS;
  const mid = Math.imul(ah, bl) + Math.imul(al, bh);
  const lo = (Math.imul(al, bl) >>> FX_BITS) | 0;

  return (hi + mid + lo) | 0;
}

/**
 * Деление. Приводим делимое к 48 битам через две ступени, чтобы не потерять
 * точность на больших значениях и не выйти за мантиссу.
 */
export function div(a: Fx, b: Fx): Fx {
  if (b === 0) return a < 0 ? FX_MIN : FX_MAX;
  // a·2^16 может не влезть в 32 бита, но влезает в 53 бита мантиссы,
  // поэтому здесь плавающая точка безопасна: деление целых в пределах 2^53
  // даёт точный результат, а Math.trunc убирает дробную часть детерминированно.
  return Math.trunc((a * FX_ONE) / b) | 0;
}

/** Целочисленный квадратный корень методом Ньютона: без Math.sqrt и без float. */
export function sqrt(a: Fx): Fx {
  if (a <= 0) return 0;

  // Работаем с a·2^16, чтобы корень сразу оказался в Q16.16.
  // Значение может превысить 2^31, поэтому держим его в обычном числе:
  // все операции ниже целочисленные и в пределах 2^53.
  const n = a * FX_ONE;

  // Стартовое приближение — степень двойки не ниже корня.
  let x = FX_ONE;
  while (x * x < n) x *= 2;

  // От такого старта Ньютон удваивает число верных знаков за шаг: восьми
  // итераций хватает на весь 32-битный диапазон, а сошедшийся выходит раньше.
  for (let i = 0; i < 8; i++) {
    const next = Math.trunc((x + Math.trunc(n / x)) / 2);
    if (next === x) break;
    x = next;
  }
  return x | 0;
}

export const min = (a: Fx, b: Fx): Fx => (a < b ? a : b);
export const max = (a: Fx, b: Fx): Fx => (a > b ? a : b);
export const clamp = (v: Fx, lo: Fx, hi: Fx): Fx => (v < lo ? lo : v > hi ? hi : v);

/** Знак: −1, 0 или +1 в обычных числах (для ветвлений, не для арифметики). */
export const sign = (a: Fx): number => (a > 0 ? 1 : a < 0 ? -1 : 0);

/**
 * Арифметика с фиксированной точкой — фундамент детерминизма.
 * Ошибка здесь не проявляется сразу: она копится и всплывает расхождением
 * реплея на тридцатой секунде, когда причину уже не найти.
 */

import { describe, expect, it } from 'vitest';
import {
  FX_ONE,
  abs,
  add,
  div,
  fromFloat,
  fromInt,
  mul,
  sqrt,
  sub,
  toFloat,
  toInt,
} from '../packages/sim/src/fixed';

describe('преобразования', () => {
  it('целое туда и обратно', () => {
    for (const n of [0, 1, -1, 42, -42, 1000, -1000, 32767, -32768]) {
      expect(toInt(fromInt(n))).toBe(n);
    }
  });

  it('дробное с точностью до 1/65536', () => {
    for (const n of [0.5, -0.5, 0.25, 3.14159, -2.71828]) {
      expect(toFloat(fromFloat(n))).toBeCloseTo(n, 4);
    }
  });
});

describe('сложение и вычитание', () => {
  it('точны на целых', () => {
    expect(add(fromInt(2), fromInt(3))).toBe(fromInt(5));
    expect(sub(fromInt(2), fromInt(3))).toBe(fromInt(-1));
  });

  it('точны на половинах', () => {
    const half = FX_ONE >> 1;
    expect(add(half, half)).toBe(FX_ONE);
  });
});

describe('умножение', () => {
  it('точно на целых', () => {
    expect(toInt(mul(fromInt(6), fromInt(7)))).toBe(42);
    expect(toInt(mul(fromInt(-6), fromInt(7)))).toBe(-42);
  });

  it('умножение на единицу ничего не меняет', () => {
    for (const n of [1, 100, -100, 12345, -12345]) {
      expect(mul(fromInt(n), FX_ONE)).toBe(fromInt(n));
    }
  });

  it('половина от числа — это его половина', () => {
    const half = FX_ONE >> 1;
    expect(toInt(mul(fromInt(100), half))).toBe(50);
  });

  /**
   * Главная проверка: прямое `a*b/FX_ONE` теряет старшие биты на больших
   * значениях, потому что произведение не влезает в мантиссу float64.
   * Здесь величины уровня координат арены — ровно то, на чём наивная
   * реализация начинает врать.
   */
  it('не теряет точность на величинах масштаба арены', () => {
    const a = fromInt(1900);
    const b = fromFloat(1.5);
    expect(toInt(mul(a, b))).toBe(2850);
  });

  it('коммутативно', () => {
    const pairs: [number, number][] = [
      [fromInt(7), fromFloat(3.25)],
      [fromInt(-13), fromFloat(0.125)],
      [fromInt(1000), fromFloat(-2.5)],
    ];
    for (const [a, b] of pairs) expect(mul(a, b)).toBe(mul(b, a));
  });
});

describe('деление', () => {
  it('точно на целых', () => {
    expect(toInt(div(fromInt(42), fromInt(7)))).toBe(6);
    expect(toInt(div(fromInt(-42), fromInt(7)))).toBe(-6);
  });

  it('обратно умножению', () => {
    const a = fromInt(360);
    const b = fromInt(8);
    expect(toInt(mul(div(a, b), b))).toBe(360);
  });

  it('деление на ноль не роняет симуляцию', () => {
    // Бросить исключение посреди тика — значит уронить всё лобби.
    // Насыщение — единственное поведение, которое остаётся детерминированным.
    expect(div(fromInt(1), 0)).toBeGreaterThan(0);
    expect(div(fromInt(-1), 0)).toBeLessThan(0);
  });
});

describe('квадратный корень', () => {
  it('точен на полных квадратах', () => {
    for (const n of [1, 4, 9, 16, 100, 144, 10000]) {
      expect(toInt(sqrt(fromInt(n)))).toBe(Math.sqrt(n));
    }
  });

  it('не отрицателен и не бросает на нуле и минусе', () => {
    expect(sqrt(0)).toBe(0);
    expect(sqrt(fromInt(-5))).toBe(0);
  });

  it('приближает неполные квадраты', () => {
    expect(toFloat(sqrt(fromInt(2)))).toBeCloseTo(Math.SQRT2, 2);
  });
});

describe('вспомогательные', () => {
  it('модуль', () => {
    expect(abs(fromInt(-7))).toBe(fromInt(7));
    expect(abs(fromInt(7))).toBe(fromInt(7));
  });
});

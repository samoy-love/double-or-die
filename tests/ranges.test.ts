/**
 * Диапазоны величин: где Q16.16 хватает, а где он молча врёт.
 *
 * Формат Q16.16 держит ±32767 в целой части. Этого с запасом хватает на
 * позиции и скорости, но НЕ хватает на квадраты позиций: диагональ арены в
 * квадрате — это миллионы, то есть переполнение. Переполнение в fixed-point
 * не бросает исключение: число просто заворачивается, и вместо дальнего врага
 * получается близкий. Ломается это на большой арене и только там, где
 * дистанция велика, — то есть далеко от того места, где написано.
 *
 * Поэтому анализ зафиксирован тестом, а не абзацем в документе: абзац не
 * заметит, что кто-то посчитал `mul(dx, dx)` в новом коде.
 *
 * Вывод анализа: отдельный формат Q24.8 не нужен нигде. Нужен запрет на
 * квадраты позиций в fixed-point — их считает `length()`, который для этого и
 * уходит в обычные числа.
 */

import { describe, expect, it } from 'vitest';
import { ARENA_H, ARENA_W, fromInt, FX_ONE, length, mul, PLAYER, toFloat } from '@dod/sim';

/** Потолок целой части Q16.16. */
const FX_MAX_INT = 32767;

describe('диапазоны величин', () => {
  it('позиции помещаются с запасом', () => {
    const maxPos = Math.max(toFloat(ARENA_W), toFloat(ARENA_H));
    expect(maxPos).toBe(1920);
    // Запас больше чем в пятнадцать раз: арену можно вырасти, не меняя формат.
    expect(FX_MAX_INT / maxPos).toBeGreaterThan(15);
  });

  it('скорости за тик помещаются с огромным запасом', () => {
    const dashPerTick = toFloat(PLAYER.dashDistance) / PLAYER.dashTicks;
    const walkPerTick = toFloat(PLAYER.speed);
    // Рывок — самая быстрая величина в игре.
    expect(dashPerTick).toBeGreaterThan(walkPerTick);
    expect(FX_MAX_INT / dashPerTick).toBeGreaterThan(1000);
  });

  it('квадрат скорости считается в fixed-point безопасно', () => {
    // Ограничение скорости в applyMovement сравнивает именно квадраты, и это
    // законно: квадрат самой быстрой величины на три порядка ниже потолка.
    const v = PLAYER.speed;
    const v2 = toFloat(mul(v, v));
    expect(v2).toBeGreaterThan(0);
    expect(FX_MAX_INT / v2).toBeGreaterThan(100);
  });

  it('квадрат позиции в fixed-point НЕ помещается — и это причина не считать его так', () => {
    const diag = Math.hypot(toFloat(ARENA_W), toFloat(ARENA_H));
    expect(diag * diag).toBeGreaterThan(FX_MAX_INT);

    // Наглядно: наивный mul() на таких величинах даёт не тот ответ.
    // Тест закрепляет запрет, а не поведение: если однажды mul научится
    // расширенному диапазону, упадёт именно эта строка — и решение будет
    // принято осознанно.
    const wrong = toFloat(mul(ARENA_W, ARENA_H));
    expect(wrong).not.toBeCloseTo(1920 * 1080, 0);
  });

  it('length считает диагональ арены точно', () => {
    // Ради этого он и уходит из fixed-point в обычные числа.
    const d = toFloat(length(ARENA_W, ARENA_H));
    expect(d).toBeCloseTo(Math.hypot(1920, 1080), 2);
  });

  it('length точен на всём диапазоне позиций', () => {
    // Втрое больше нынешней арены: формат обязан выдерживать рост мира без
    // перехода на другой Q-формат.
    for (const [x, y] of [
      [1, 0],
      [3, 4],
      [1920, 1080],
      [5000, 5000],
      [20000, 20000],
    ]) {
      const d = toFloat(length(fromInt(x), fromInt(y)));
      expect(d).toBeCloseTo(Math.hypot(x, y), 2);
    }
  });

  // За пределом формата честного ответа нет, но упереться в потолок и
  // развернуться в обратную сторону — очень разные виды неправоты.
  it('за пределом формата упирается в потолок, а не уходит в минус', () => {
    const huge = fromInt(30000);
    expect(length(huge, huge)).toBeGreaterThan(0);
  });

  it('единица формата — та, из которой считаются все запасы', () => {
    expect(FX_ONE).toBe(65536);
    expect(toFloat(fromInt(1))).toBe(1);
  });
});

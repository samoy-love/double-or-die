/**
 * Инварианты состояния — самый дешёвый уровень тестирования.
 *
 * Включены в dev-сборке и проверяются каждый тик. Ловят целый класс багов в
 * момент возникновения, а не через десять минут игры, когда причина уже
 * потеряна. В продакшене вырезаются целиком.
 */

import { ARENA_H, ARENA_W, MAX_ENEMIES, MAX_BULLETS, type SimState } from './state';

export class InvariantError extends Error {
  constructor(
    message: string,
    readonly tick: number,
  ) {
    super(`[tick ${tick}] ${message}`);
    this.name = 'InvariantError';
  }
}

/**
 * Проверить состояние. Бросает при нарушении — это дефект симуляции,
 * а не ситуация, которую нужно обрабатывать.
 */
/**
 * Вынесено из checkInvariants намеренно: замыкание внутри функции создаётся
 * при каждом вызове, а проверка идёт по тику. Ядру аллоцировать в горячем
 * пути запрещено, и запрет проверяется тестом.
 */
function fail(m: string, tick: number): never {
  throw new InvariantError(m, tick);
}

export function checkInvariants(s: SimState): void {
  if (s.tick < 0) fail('номер тика отрицательный', s.tick);
  if (s.playerCount < 1 || s.playerCount > 4) {
    fail(`игроков ${s.playerCount}, ожидалось 1..4`, s.tick);
  }

  for (let i = 0; i < s.playerCount; i++) {
    if (s.pHearts[i] < 0) fail(`у игрока ${i} отрицательное здоровье`, s.tick);
    if (s.pChips[i] < 0) fail(`у игрока ${i} отрицательный кошелёк`, s.tick);
    // Границы с запасом: выход за них означает сломанную физику,
    // а не законное движение по краю.
    if (s.pX[i] < -ARENA_W || s.pX[i] > ARENA_W * 2) fail(`игрок ${i} вне арены по X`, s.tick);
    if (s.pY[i] < -ARENA_H || s.pY[i] > ARENA_H * 2) fail(`игрок ${i} вне арены по Y`, s.tick);
  }

  let enemies = 0;
  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (!s.eActive[i]) continue;
    enemies++;
    if (s.eHP[i] <= 0) fail(`враг ${i} активен с нулевым здоровьем`, s.tick);
  }
  if (enemies > MAX_ENEMIES) fail(`врагов ${enemies}, потолок ${MAX_ENEMIES}`, s.tick);

  let bullets = 0;
  for (let i = 0; i < MAX_BULLETS; i++) {
    if (!s.bActive[i]) continue;
    bullets++;
    if (s.bDeadline[i] <= s.tick) fail(`снаряд ${i} активен после истечения срока`, s.tick);
  }
  if (bullets > MAX_BULLETS) fail(`снарядов ${bullets}, потолок ${MAX_BULLETS}`, s.tick);
}

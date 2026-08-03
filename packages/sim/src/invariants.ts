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
export function checkInvariants(s: SimState): void {
  const fail = (m: string): never => {
    throw new InvariantError(m, s.tick);
  };

  if (s.tick < 0) fail('номер тика отрицательный');
  if (s.playerCount < 1 || s.playerCount > 4) fail(`игроков ${s.playerCount}, ожидалось 1..4`);

  for (let i = 0; i < s.playerCount; i++) {
    if (s.pHearts[i] < 0) fail(`у игрока ${i} отрицательное здоровье`);
    if (s.pChips[i] < 0) fail(`у игрока ${i} отрицательный кошелёк`);
    // Границы с запасом: выход за них означает сломанную физику,
    // а не законное движение по краю.
    if (s.pX[i] < -ARENA_W || s.pX[i] > ARENA_W * 2) fail(`игрок ${i} вне арены по X`);
    if (s.pY[i] < -ARENA_H || s.pY[i] > ARENA_H * 2) fail(`игрок ${i} вне арены по Y`);
  }

  let enemies = 0;
  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (!s.eActive[i]) continue;
    enemies++;
    if (s.eHP[i] <= 0) fail(`враг ${i} активен с нулевым здоровьем`);
  }
  if (enemies > MAX_ENEMIES) fail(`врагов ${enemies}, потолок ${MAX_ENEMIES}`);

  let bullets = 0;
  for (let i = 0; i < MAX_BULLETS; i++) {
    if (!s.bActive[i]) continue;
    bullets++;
    if (s.bDeadline[i] <= s.tick) fail(`снаряд ${i} активен после истечения срока`);
  }
  if (bullets > MAX_BULLETS) fail(`снарядов ${bullets}, потолок ${MAX_BULLETS}`);
}

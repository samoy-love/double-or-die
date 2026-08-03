/**
 * Инварианты состояния — самый дешёвый уровень тестирования.
 *
 * Включены в dev-сборке и проверяются каждый тик. Ловят целый класс багов в
 * момент возникновения, а не через десять минут игры, когда причина уже
 * потеряна. В продакшене вырезаются целиком.
 *
 * Правила честности из DIFFICULTY §7 проверяются здесь же, а не только
 * сценариями: непроходимая комбинация врагов обязана становиться падающим
 * тестом, а не жалобой в отзывах.
 */

import { onScreenCap } from './enemies';
import {
  ARENA_H,
  ARENA_W,
  EntityFlag,
  MAX_CHIPS,
  MAX_ENEMIES,
  MAX_BULLETS,
  Meta,
  type SimState,
} from './state';

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
 * Вынесено из checkInvariants намеренно: замыкание внутри функции создаётся
 * при каждом вызове, а проверка идёт по тику. Ядру аллоцировать в горячем
 * пути запрещено, и запрет проверяется тестом.
 */
function fail(m: string, tick: number): never {
  throw new InvariantError(m, tick);
}

/*
 * Потолка телеграфов здесь нет намеренно.
 *
 * Правило «не больше трёх объявленных атак на игрока» — это ограничение на
 * МОМЕНТ ОБЪЯВЛЕНИЯ, и держится оно в enemies.ts. Инвариантом по состоянию
 * его не выразить: коридор тарана задан при объявлении и дальше не меняется, а
 * игрок волен вбежать в него сам — и тогда «четвёртая угроза на игроке»
 * означает его собственное решение, а не дефект симуляции. Проверка,
 * падающая от действий игрока, перестаёт быть инвариантом и начинает быть
 * шумом.
 *
 * Само правило проверяется тестом на объявление (tests/enemies.test.ts), а его
 * следствие — тем, что безопасная точка достижима всегда (D4, --safety).
 */

/**
 * Проверить состояние. Бросает при нарушении — это дефект симуляции,
 * а не ситуация, которую нужно обрабатывать.
 */
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
    // Живой с нулём сердец — это состояние, которого не бывает: смерть
    // наступает в тот же тик, что и последнее попадание.
    if (s.pHearts[i] === 0 && (s.pFlags[i] & EntityFlag.Alive) !== 0) {
      fail(`игрок ${i} жив без сердец`, s.tick);
    }
  }

  let enemies = 0;
  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (!s.eActive[i]) continue;
    enemies++;
    if (s.eHP[i] <= 0) fail(`враг ${i} активен с нулевым здоровьем`, s.tick);
  }

  const cap = onScreenCap(s.playerCount);
  if (enemies > cap) fail(`врагов на арене ${enemies}, потолок ${cap} (D9)`, s.tick);

  let bullets = 0;
  for (let i = 0; i < MAX_BULLETS; i++) {
    if (!s.bActive[i]) continue;
    bullets++;
    // Строго меньше: снаряд со сроком, равным текущему тику, гасится в
    // начале СЛЕДУЮЩЕГО шага снарядов и до тех пор законно жив. Инвариант
    // ловит переживших свой срок, а не тех, чей срок наступил только что.
    if (s.bDeadline[i] < s.tick) fail(`снаряд ${i} активен после истечения срока`, s.tick);
  }
  if (bullets > MAX_BULLETS) fail(`снарядов ${bullets}, потолок ${MAX_BULLETS}`, s.tick);

  for (let i = 0; i < MAX_CHIPS; i++) {
    if (!s.cActive[i]) continue;
    if (s.cValue[i] <= 0) fail(`фишка ${i} с неположительным номиналом`, s.tick);
  }

  if (s.meta[Meta.Room] < 1) fail(`номер комнаты ${s.meta[Meta.Room]}`, s.tick);
  if (s.meta[Meta.WaveBudget] < 0) fail('бюджет волны ушёл в минус', s.tick);
}

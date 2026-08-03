/**
 * Арена: границы и колонны.
 *
 * Колонны — не украшение. Они дают укрытие от Кирпича, ломают прямую линию
 * рывка Клина и создают места, куда лезть страшно, — то есть ровно тот
 * пространственный выбор, на который потом лягут карты пари (GDD §9.1).
 *
 * Разрешение столкновений — выталкивание по кратчайшей оси. Скорость при этом
 * не гасится: гасить её значило бы прилипать к колонне, а игрок должен вдоль
 * неё скользить.
 *
 * Все функции принимают состояние, а не читают модульные границы: размер арены
 * зависит от состава, а состояний в одном процессе бывает много — CI гоняет
 * тысячи забегов подряд, и общая «текущая арена» на модуле разошлась бы с тем,
 * что считает симуляция, ровно в тот момент, когда это труднее всего заметить.
 */

import { ARENA_PAD, COLUMNS, type Column, arenaScale } from './config';
import { abs, add, clamp, type Fx, sub } from './fixed';
import { type SimState } from './state';

export { COLUMNS, type Column };

export const maxX = (s: SimState): Fx => sub(s.arenaW, ARENA_PAD);
export const maxY = (s: SimState): Fx => sub(s.arenaH, ARENA_PAD);

/** Держит точку внутри игровой зоны с учётом радиуса тела. */
export const clampX = (s: SimState, x: Fx, r: Fx): Fx =>
  clamp(x, add(ARENA_PAD, r), sub(maxX(s), r));
export const clampY = (s: SimState, y: Fx, r: Fx): Fx =>
  clamp(y, add(ARENA_PAD, r), sub(maxY(s), r));

/**
 * Колонна с поправкой на размер арены.
 *
 * Позиции разъезжаются вместе с ареной, размеры остаются: укрытие обязано
 * прикрывать одинаково при любом составе, иначе выученная дистанция «за
 * колонной меня не достанут» врёт вчетвером.
 */
function columnX(c: Column, s: SimState): Fx {
  return Math.trunc((c.x * arenaScale(s.playerCount)) / 100) | 0;
}
function columnY(c: Column, s: SimState): Fx {
  return Math.trunc((c.y * arenaScale(s.playerCount)) / 100) | 0;
}

/** Пересекает ли круг колонну. */
export function hitsColumn(s: SimState, x: Fx, y: Fx, r: Fx): boolean {
  for (let i = 0; i < COLUMNS.length; i++) {
    const c = COLUMNS[i];
    if (
      abs(sub(x, columnX(c, s))) < add(c.halfW, r) &&
      abs(sub(y, columnY(c, s))) < add(c.halfH, r)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Результат выталкивания. Возвращается через модульные переменные, а не
 * объектом: функция зовётся для каждого тела каждый тик, а ядру запрещено
 * аллоцировать в горячем пути (проверяется tests/allocations.test.ts).
 */
export let pushedX: Fx = 0;
export let pushedY: Fx = 0;

/**
 * Вытолкнуть круг из колонн наружу.
 *
 * Ось выбирается по меньшему перекрытию — так тело выходит туда, откуда
 * пришло, а не проскакивает сквозь колонну на другую сторону.
 */
export function pushOutOfColumns(s: SimState, x: Fx, y: Fx, r: Fx): void {
  pushedX = x;
  pushedY = y;

  for (let i = 0; i < COLUMNS.length; i++) {
    const c = COLUMNS[i];
    const dx = sub(pushedX, columnX(c, s));
    const dy = sub(pushedY, columnY(c, s));
    const overlapX = sub(add(c.halfW, r), abs(dx));
    const overlapY = sub(add(c.halfH, r), abs(dy));
    if (overlapX <= 0 || overlapY <= 0) continue;

    if (overlapX < overlapY) {
      pushedX = add(pushedX, dx < 0 ? -overlapX : overlapX);
    } else {
      pushedY = add(pushedY, dy < 0 ? -overlapY : overlapY);
    }
  }

  pushedX = clampX(s, pushedX, r);
  pushedY = clampY(s, pushedY, r);
}

/**
 * Свободна ли точка под спавн или под отход: внутри арены и вне колонн.
 *
 * Используется и спавнером, и проверкой достижимости безопасной точки (D4):
 * «безопасно» обязано означать одно и то же для того, кто ставит врагов, и
 * для того, кто доказывает, что игроку есть куда уйти.
 */
export function isFreeSpot(s: SimState, x: Fx, y: Fx, r: Fx): boolean {
  if (x < add(ARENA_PAD, r) || x > sub(maxX(s), r)) return false;
  if (y < add(ARENA_PAD, r) || y > sub(maxY(s), r)) return false;
  return !hitsColumn(s, x, y, r);
}

/** Вышла ли точка за пределы игровой зоны — для гашения снарядов. */
export const outOfArena = (s: SimState, x: Fx, y: Fx): boolean =>
  x < ARENA_PAD || y < ARENA_PAD || x > maxX(s) || y > maxY(s);

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

import {
  ARENA_PAD,
  ARENA_TEMPLATES,
  type ArenaTemplate,
  type Column,
  FLIP_COUNT,
  Flip,
  RED_ZONE_RADIUS,
  arenaScale,
} from './config';
import { abs, add, clamp, type Fx, sub } from './fixed';
import { ARENA_H, ARENA_W, Meta, RunPhase, type SimState } from './state';

export { type Column };

/**
 * Шаблон текущей комнаты.
 *
 * Номер живёт в состоянии, а не в модуле, по той же причине, что и размеры
 * арены: состояний в одном процессе бывает много — CI гоняет тысячи забегов
 * подряд, — и общий «текущий шаблон» на модуле разошёлся бы с тем, что
 * считает симуляция, ровно в тот момент, когда это труднее всего заметить.
 */
export const templateOf = (s: SimState): ArenaTemplate =>
  ARENA_TEMPLATES[s.meta[Meta.Template] % ARENA_TEMPLATES.length];

/**
 * Закрепить раскладку арены. Только для тестов и сценариев.
 *
 * В игре шаблон выбирается на входе в комнату из потока `layout`, и трогать
 * его руками нельзя. Но тест, проверяющий поведение НА геометрии — «таран не
 * объявляется сквозь колонну», — обязан знать, где эта колонна стоит: иначе
 * он проверяет не правило, а удачу броска. Раньше знать было неоткуда, потому
 * что раскладка была одна на всю игру.
 */
export function setArena(s: SimState, template: number, flip = 0): void {
  s.meta[Meta.Template] = template % ARENA_TEMPLATES.length;
  s.meta[Meta.Flip] = flip % FLIP_COUNT;
}

/**
 * Отражение по горизонтали и вертикали.
 *
 * Считается в БАЗОВЫХ координатах 1920×1080, до поправки на состав. Обратный
 * порядок — отразить уже растянутое — дал бы разъезжающуюся с составом
 * раскладку: зеркало относительно выросшей арены переносит колонну не туда,
 * где она была бы у соло, и «тот же шаблон» вчетвером стал бы другим.
 */
const mirrorX = (s: SimState, x: Fx): Fx =>
  (s.meta[Meta.Flip] & Flip.X) !== 0 ? sub(ARENA_W, x) : x;
const mirrorY = (s: SimState, y: Fx): Fx =>
  (s.meta[Meta.Flip] & Flip.Y) !== 0 ? sub(ARENA_H, y) : y;

/** Центр красной зоны текущей раскладки, с отражением и поправкой на состав. */
export const redZoneX = (s: SimState): Fx =>
  Math.trunc((mirrorX(s, templateOf(s).redX) * arenaScale(s.playerCount)) / 100) | 0;
export const redZoneY = (s: SimState): Fx =>
  Math.trunc((mirrorY(s, templateOf(s).redY) * arenaScale(s.playerCount)) / 100) | 0;
export { RED_ZONE_RADIUS };

/**
 * Сколько колонн стоит на этой арене.
 *
 * Боссовая арена — тринадцатый шаблон, не входящий в раскладку обычных комнат:
 * колонн на колесе нет, их роль играют секторы (GDD §8.1). Признак берётся из
 * фазы забега, а не из отдельного поля: «идёт бой с боссом» уже описано, и
 * второй признак того же разошёлся бы с первым.
 *
 * Раскладку остальных двенадцати шаблонов подключит отдельное изменение —
 * здесь ему хватит той же функции.
 */
export const columnCount = (s: SimState): number =>
  s.meta[Meta.Phase] === RunPhase.Boss ? 0 : templateOf(s).columns.length;

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
export function columnX(c: Column, s: SimState): Fx {
  return Math.trunc((mirrorX(s, c.x) * arenaScale(s.playerCount)) / 100) | 0;
}
export function columnY(c: Column, s: SimState): Fx {
  return Math.trunc((mirrorY(s, c.y) * arenaScale(s.playerCount)) / 100) | 0;
}

/** Пересекает ли круг колонну. */
export function hitsColumn(s: SimState, x: Fx, y: Fx, r: Fx): boolean {
  const cols = templateOf(s).columns;
  const n = columnCount(s);
  for (let i = 0; i < n; i++) {
    const c = cols[i];
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

  const cols = templateOf(s).columns;
  const n = columnCount(s);
  for (let i = 0; i < n; i++) {
    const c = cols[i];
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

/**
 * Перекрыт ли прямой путь колонной.
 *
 * Нужно тому, кто собирается лететь по прямой: таран, объявленный сквозь
 * колонну, гарантированно кончается ударом в неё, а игрок при этом видит
 * телеграф, обещающий атаку, которой не будет. Хуже того, Клин после такого
 * упирается и объявляет её снова — со стороны это враг, который бесконечно
 * бодает стену.
 *
 * Шагаем по отрезку с шагом в радиус тела: точное пересечение с
 * прямоугольником здесь не нужно, а считается это не в горячем пути, а один
 * раз на объявление атаки.
 */
export function pathBlocked(s: SimState, x0: Fx, y0: Fx, x1: Fx, y1: Fx, r: Fx): boolean {
  const dx = sub(x1, x0);
  const dy = sub(y1, y0);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = add(x0, Math.trunc((dx * i) / steps) | 0);
    const y = add(y0, Math.trunc((dy * i) / steps) | 0);
    if (hitsColumn(s, x, y, r)) return true;
  }
  return false;
}

/** Вышла ли точка за пределы игровой зоны — для гашения снарядов. */
export const outOfArena = (s: SimState, x: Fx, y: Fx): boolean =>
  x < ARENA_PAD || y < ARENA_PAD || x > maxX(s) || y > maxY(s);

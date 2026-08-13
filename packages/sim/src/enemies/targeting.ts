/**
 * Прицеливание и телеграфы: кто на кого нацелен, что объявлено и что накрывает.
 *
 * Каждая атака проходит через состояние `Telegraph`: сначала объявлена, потом
 * случилась. Длительность телеграфа — главный рычаг честности, и удлинить его
 * можно, не тронув ни одного другого числа.
 */

import { pathBlocked } from '../arena';
import {
  AGRO_CAP_PCT,
  AI_TARGET_MEMORY_TICKS,
  ENEMIES,
  ENEMY_BULLET,
  EnemyPhase,
  EnemyType,
  FAIRNESS,
  FUSE,
  PLAYER,
  WEDGE,
} from '../config';
import { damagePlayer, statsOf } from '../combat';
import { add, type Fx, sub } from '../fixed';
import { length, normalize, normX, normY, within } from '../trig';
import { EntityFlag, MAX_ENEMIES, MAX_PLAYERS, type SimState } from '../state';

/**
 * Сколько телеграфов сейчас нацелено на каждого игрока.
 *
 * Модульный буфер, а не массив на вызов: считается каждый тик, а ядру
 * запрещено аллоцировать в горячем пути.
 */
const telegraphs = new Int32Array(MAX_PLAYERS);

/** Сколько врагов сейчас нацелено на каждого игрока — для потолка агро. */
const targeting = new Int32Array(MAX_PLAYERS);

/*
 * Опасная область объявленной атаки — в обычных числах, единицы арены.
 *
 * Считать её в Q16.16 нельзя: квадрат длины коридора это миллионы, формат
 * держит ±32767. Обычные числа тут детерминированы — деление на степень
 * двойки, умножение и сложение IEEE 754 заданы стандартом однозначно, в
 * отличие от Math.sin и Math.hypot, которых здесь и нет.
 */
/*
 * Держим область в Float64Array, а не в пяти модульных `let`.
 *
 * Дробное число в переменной модуля V8 хранит объектом в куче: каждая запись
 * — это новый HeapNumber. Пять записей на каждую объявленную атаку каждый тик
 * давали шестьсот байт мусора в тик, то есть визит сборщика раз в несколько
 * секунд боя — ровно тот класс микрофризов, ради которого в ядре запрещены
 * аллокации. В типизированном массиве дробные лежат сырыми, и записи бесплатны.
 */
const dg = new Float64Array(5);
const DG_X0 = 0;
const DG_Y0 = 1;
const DG_X1 = 2;
const DG_Y1 = 3;
const DG_R = 4;

const units = (v: Fx): number => v / 65536;

/**
 * Область, которую накрывает атака врага `i`, если он ударит в направлении
 * (dirX, dirY). Для Фитиля направление не важно — он взрывается на месте.
 */
function computeDanger(s: SimState, i: number, dirX: Fx, dirY: Fx, remaining: number): void {
  const stats = statsOf(s.eType[i]);
  const x = units(s.eX[i]);
  const y = units(s.eY[i]);
  const pr = units(PLAYER.radius) + FAIRNESS.dangerSlackUnits;

  dg[DG_X0] = x;
  dg[DG_Y0] = y;

  if (s.eType[i] === EnemyType.Fuse) {
    dg[DG_X1] = x;
    dg[DG_Y1] = y;
    dg[DG_R] = units(FUSE.blastRadius) + pr;
    return;
  }

  const wedge = s.eType[i] === EnemyType.Wedge;
  const len = units(wedge ? WEDGE.dashSpeed : ENEMY_BULLET.speed) * remaining;
  dg[DG_X1] = x + units(dirX) * len;
  dg[DG_Y1] = y + units(dirY) * len;
  dg[DG_R] = units(wedge ? stats.radius : ENEMY_BULLET.radius) + pr;
}

/** Квадрат расстояния от точки до текущей опасной области. */
function distSqToDanger(px: number, py: number): number {
  const x0 = dg[DG_X0];
  const y0 = dg[DG_Y0];
  const dx = dg[DG_X1] - x0;
  const dy = dg[DG_Y1] - y0;
  const len2 = dx * dx + dy * dy;
  let cx = x0;
  let cy = y0;
  if (len2 > 0) {
    let u = ((px - x0) * dx + (py - y0) * dy) / len2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    cx = x0 + dx * u;
    cy = y0 + dy * u;
  }
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

/** Сколько тиков ещё продлится ударная часть атаки. */
export function attackRemaining(s: SimState, i: number): number {
  const stats = statsOf(s.eType[i]);
  // Для Кирпича берём не весь полёт снаряда, а окно реакции: дальше по линии
  // игрок успевает отойти, и считать опасной всю арену незачем.
  if (s.eType[i] === EnemyType.Brick) return stats.telegraphTicks + FAIRNESS.reactionTicks;
  return s.ePhase[i] === EnemyPhase.Attack
    ? Math.max(0, s.ePhaseUntil[i] - s.tick)
    : stats.attackTicks;
}

/**
 * Сколько объявленных атак накрывает каждого игрока.
 *
 * Считается ГЕОМЕТРИЧЕСКИ, а не по полю «цель». Правило DIFFICULTY §7 говорит
 * «не больше трёх телеграфов одновременно на одного игрока», и игрок видит
 * коридоры, которые проходят через него, а не те, что записаны на его имя.
 * Вчетвером разница решающая: три атаки на каждого — это двенадцать коридоров
 * на одной арене, и стоящий с краю оказывается накрыт всеми сразу. Именно на
 * этом проверка достижимости безопасной точки (D4) и падала в коопе.
 *
 * Место в очереди занимает вся атака целиком — и телеграф, и то, что после
 * него: летящий таран никуда не делся.
 */
export function countTelegraphs(s: SimState): void {
  telegraphs.fill(0);
  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (!s.eActive[i]) continue;
    if (s.ePhase[i] !== EnemyPhase.Telegraph && s.ePhase[i] !== EnemyPhase.Attack) continue;
    computeDanger(s, i, s.eDirX[i], s.eDirY[i], attackRemaining(s, i));
    for (let p = 0; p < s.playerCount; p++) {
      if (!isAlive(s, p)) continue;
      if (distSqToDanger(units(s.pX[p]), units(s.pY[p])) <= dg[DG_R] * dg[DG_R]) telegraphs[p]++;
    }
  }
}

/** Длительность телеграфа с поправкой на новичка: первое появление ×1.5. */
export function telegraphTicks(s: SimState, i: number): number {
  const base = statsOf(s.eType[i]).telegraphTicks;
  if ((s.eFlags[i] & EntityFlag.Novice) === 0) return base;
  return Math.trunc((base * FAIRNESS.noviceTelegraphPct) / 100);
}

export function countTargeting(s: SimState): number {
  targeting.fill(0);
  let active = 0;
  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (!s.eActive[i]) continue;
    active++;
    const t = s.eTarget[i];
    if (t >= 0 && t < MAX_PLAYERS) targeting[t]++;
  }
  return active;
}

/**
 * Выбрать цель: ближайший живой игрок, но не больше 40% врагов на одного.
 *
 * Без потолка все враги сходятся на одном игроке, он мгновенно умирает, и
 * вечер испорчен (DIFFICULTY §7). Потолок сформулирован в долях активных
 * врагов, а не в штуках, потому что толпа растёт с составом.
 *
 * Память о цели — 2 с: враг не мечется между игроками каждый кадр.
 * Взвешивание по недавно нанесённому урону приезжает в 0.5.0 вместе с
 * телеметрией коопа, на которой его только и можно настроить.
 */
export function retarget(s: SimState, i: number, activeEnemies: number): void {
  if (s.tick < s.eTargetUntil[i] && isAlive(s, s.eTarget[i])) return;

  // Потолок имеет смысл только когда игроков больше одного: в соло он
  // означал бы, что часть врагов не преследует никого.
  const cap =
    s.playerCount > 1 ? Math.max(1, Math.ceil((activeEnemies * AGRO_CAP_PCT) / 100)) : Infinity;

  let best = -1;
  let bestDist = 0;
  for (let pass = 0; pass < 2 && best < 0; pass++) {
    for (let p = 0; p < s.playerCount; p++) {
      if (!isAlive(s, p)) continue;
      // Первый проход уважает потолок, второй — нет: если все игроки уже
      // перегружены, враг обязан кого-то выбрать, а не встать столбом.
      if (pass === 0 && p !== s.eTarget[i] && targeting[p] >= cap) continue;
      const d = length(sub(s.pX[p], s.eX[i]), sub(s.pY[p], s.eY[i]));
      if (best < 0 || d < bestDist) {
        best = p;
        bestDist = d;
      }
    }
  }
  if (best < 0) return;

  targeting[s.eTarget[i]]--;
  targeting[best]++;
  s.eTarget[i] = best;
  s.eTargetUntil[i] = s.tick + AI_TARGET_MEMORY_TICKS;
}

export const isAlive = (s: SimState, p: number): boolean =>
  p >= 0 && p < s.playerCount && (s.pFlags[p] & EntityFlag.Alive) !== 0;

/**
 * Можно ли объявлять атаку: потолок в три штуки на игрока (DIFFICULTY §7).
 *
 * Проверяется каждый, кого атака накроет, а не только тот, на кого она
 * нацелена. Иначе враги обходят потолок через соседа: формально целятся в
 * одного, физически перекрывают другого.
 */
export function telegraphAllowed(s: SimState, i: number, target: number): boolean {
  normalize(sub(s.pX[target], s.eX[i]), sub(s.pY[target], s.eY[i]));
  if (normX === 0 && normY === 0) return false;

  /*
   * Сквозь колонну не атакуют.
   *
   * Клин летит строго по прямой, поэтому таран, объявленный через укрытие,
   * кончается ударом в это укрытие — и объявляется снова, и снова. Со стороны
   * это враг, который бодает стену вместо того, чтобы её обойти; игрок при
   * этом видит телеграф, обещающий атаку, которой не будет.
   *
   * Отказ здесь отправляет врага в обход: в ожидании он кружит, а сторона
   * обхода переворачивается, когда он упирается. Кирпич проверяется тем же
   * правилом по той же причине — его снаряд гасится колонной.
   */
  if (pathBlocked(s, s.eX[i], s.eY[i], s.pX[target], s.pY[target], statsOf(s.eType[i]).radius)) {
    return false;
  }

  computeDanger(s, i, normX, normY, attackRemaining(s, i));

  for (let p = 0; p < s.playerCount; p++) {
    if (!isAlive(s, p)) continue;
    if (distSqToDanger(units(s.pX[p]), units(s.pY[p])) > dg[DG_R] * dg[DG_R]) continue;
    if (telegraphs[p] >= FAIRNESS.maxTelegraphsPerPlayer) return false;
  }
  return true;
}

/**
 * Объявить атаку. Направление берётся из последней проверки `telegraphAllowed`
 * — считать его дважды значило бы разрешить одну атаку, а объявить другую.
 */
export function enterTelegraph(s: SimState, i: number): void {
  s.eDirX[i] = normX;
  s.eDirY[i] = normY;
  s.ePhase[i] = EnemyPhase.Telegraph;
  s.ePhaseUntil[i] = s.tick + telegraphTicks(s, i);

  computeDanger(s, i, normX, normY, attackRemaining(s, i));
  for (let p = 0; p < s.playerCount; p++) {
    if (!isAlive(s, p)) continue;
    if (distSqToDanger(units(s.pX[p]), units(s.pY[p])) <= dg[DG_R] * dg[DG_R]) telegraphs[p]++;
  }
}

/**
 * Контактный урон: только таран Клина.
 *
 * Фитиль опасен взрывом, а не касанием, — иначе он отнимал бы сердце дважды
 * за одну смерть, и «увернулся от волны» перестало бы что-либо значить.
 * Кирпич не контактный по определению: он держит дистанцию.
 */
export function contactDamage(s: SimState, i: number): void {
  if (s.eType[i] !== EnemyType.Wedge || s.ePhase[i] !== EnemyPhase.Attack) return;

  const r = add(statsOf(s.eType[i]).radius, PLAYER.radius);
  for (let p = 0; p < s.playerCount; p++) {
    if (!isAlive(s, p)) continue;
    if (!within(sub(s.pX[p], s.eX[i]), sub(s.pY[p], s.eY[i]), r)) continue;
    if (!damagePlayer(s, p)) continue;
    // Таран, достигший цели, сразу переходит в откат: продолжать лететь
    // сквозь игрока значило бы отнимать сердце дважды за один рывок.
    s.ePhase[i] = EnemyPhase.Recover;
    s.ePhaseUntil[i] = s.tick + ENEMIES[EnemyType.Wedge].recoverTicks;
    s.eVX[i] = 0;
    s.eVY[i] = 0;
    return;
  }
}

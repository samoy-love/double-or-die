/**
 * Движение врагов: приближение, удержание дистанции, орбита, расталкивание.
 *
 * Чистые функции над скоростью врага (`eVX`/`eVY`) — решение, куда лететь,
 * без знания о фазах атаки и телеграфах (то живёт в `targeting.ts`).
 */

import { add, type Fx, FX_ONE, fromInt, mul, sub } from '../fixed';
import { length, normalize, normX, normY, within } from '../trig';
import {
  AI_SEPARATION_REACH,
  AI_SEPARATION_SPEED,
  BRICK,
  CURSE,
  ENEMIES,
  EnemyType,
  FAIRNESS,
  WEDGE,
} from '../config';
import { flowTo, flowX, flowY } from '../nav';
import { statsOf } from '../combat';
import { Curse, EntityFlag, MAX_ENEMIES, Meta, type SimState } from '../state';
import { isAlive } from './targeting';

const units = (v: Fx): number => v / 65536;

/**
 * Множитель скорости от проклятия «Суета» (GDD §11): +20% всей комнате.
 *
 * Единая точка, которой домножается любая базовая скорость врага — и
 * `approach`, и `keepDistance` читают именно её, а не проверяют проклятие
 * каждый по-своему: правка порога или добавление нового источника скорости
 * не должны требовать помнить обо всех местах разом.
 */
export function curseSpeedMul(s: SimState): Fx {
  return s.meta[Meta.Curse] === Curse.Hustle && (s.meta[Meta.CurseRoom] & 1) === 1
    ? CURSE.hustleSpeedMul
    : FX_ONE;
}

export const brake = (s: SimState, i: number): void => {
  s.eVX[i] = 0;
  s.eVY[i] = 0;
};

/**
 * Идти к цели, обходя препятствия.
 *
 * Направление берётся из поля потока, а не из вектора «на игрока»: прямая
 * упирается в колонну и держит там врага сколько угодно долго. Поле уже знает
 * обход, и знает его для всей арены сразу — цена не растёт с числом врагов.
 *
 * Отрицательная скорость означает бегство: тот же поток, развёрнутый на сто
 * восемьдесят градусов. Так отходит Клин с дистанции разгона, а с 0.7.0 так
 * же будет убегать Вьюн, украв фишку.
 */
export function approach(s: SimState, i: number, target: number, speed: Fx): void {
  if (!isAlive(s, target)) {
    brake(s, i);
    return;
  }

  let dirX: Fx;
  let dirY: Fx;
  if (flowTo(s, target, s.eX[i], s.eY[i])) {
    dirX = flowX;
    dirY = flowY;
  } else {
    // Поле не дало направления: враг в закутке, куда волна не дошла. Прямая
    // хуже обхода, но лучше остановки.
    normalize(sub(s.pX[target], s.eX[i]), sub(s.pY[target], s.eY[i]));
    dirX = normX;
    dirY = normY;
  }

  const spd = mul(speed, curseSpeedMul(s));
  s.eVX[i] = mul(dirX, spd);
  s.eVY[i] = mul(dirY, spd);
}

/** Кирпич держит 420 u и стрейфится перпендикулярно — по этому он и читается. */
export function keepDistance(s: SimState, i: number, target: number): void {
  const dx = sub(s.pX[target], s.eX[i]);
  const dy = sub(s.pY[target], s.eY[i]);
  const d = length(dx, dy);
  normalize(dx, dy);
  const nx = normX;
  const ny = normY;
  const speed = mul(ENEMIES[EnemyType.Brick].speed, curseSpeedMul(s));

  if (d < BRICK.retreatDistance) {
    s.eVX[i] = mul(nx, -speed);
    s.eVY[i] = mul(ny, -speed);
    return;
  }
  if (d > BRICK.keepDistance) {
    s.eVX[i] = mul(nx, speed);
    s.eVY[i] = mul(ny, speed);
    return;
  }
  // Сторона стрейфа берётся из индекса врага, а не из RNG: у соседних
  // Кирпичей она разная, а один и тот же Кирпич не дёргается туда-сюда.
  const dir = (i & 1) === 0 ? 1 : -1;
  const strafe = mul(BRICK.strafeSpeed, curseSpeedMul(s));
  s.eVX[i] = mul(-ny * dir, strafe);
  s.eVY[i] = mul(nx * dir, strafe);
}

/**
 * Ожидание Клина: обход цели по своей орбите.
 *
 * Раньше здесь было «идти прямо на игрока, а с двухсот единиц пятиться». При
 * очереди из трёх телеграфов это значило, что десяток Клинов ходит туда-сюда
 * по одной и той же окружности в едином ритме: стая двигалась как один
 * организм и выкашивалась одной очередью. Разные радиусы и разные стороны
 * обхода превращают её обратно в набор отдельных врагов, не добавляя ни грамма
 * непредсказуемости — каждый по-прежнему ходит по своему простому правилу.
 */
export function orbit(s: SimState, i: number, dx: Fx, dy: Fx): void {
  const distance = length(dx, dy);

  // Радиальная составляющая идёт по потоку — иначе враг, обходящий цель по
  // кругу, упирается в колонну ровно так же, как шедший напролом.
  let towardX: Fx;
  let towardY: Fx;
  if (flowTo(s, s.eTarget[i], s.eX[i], s.eY[i])) {
    towardX = flowX;
    towardY = flowY;
  } else {
    normalize(dx, dy);
    towardX = normX;
    towardY = normY;
  }

  // Своя полоса и своя сторона обхода у каждого — из индекса, а не из RNG:
  // случайность здесь ничего не добавляет, а поток сдвигает.
  const band = (i * 7) % WEDGE.orbitBands;
  const preferred = add(WEDGE.orbitMin, band * WEDGE.orbitStep);
  // Сторона обхода: из индекса, но переворачивается, когда враг упёрся.
  const flipped = (s.eFlags[i] & EntityFlag.OrbitFlip) !== 0;
  const side = ((i & 1) === 0) !== flipped ? 1 : -1;

  /*
   * Радиальная составляющая держит свою полосу, тангенциальная ведёт по кругу.
   *
   * Зона нечувствительности вокруг `preferred` (`WEDGE.orbitDeadband`) —
   * без неё враг, зависший ровно на границе, каждый тик дёргался между
   * сближением и отходом (playtest 0.3.1: «вибрируют, быстро меняют
   * направление»). Внутри полосы враг только обходит по кругу, не подходит
   * и не отступает.
   */
  const delta = sub(distance, preferred);
  const closing =
    delta > WEDGE.orbitDeadband
      ? ENEMIES[EnemyType.Wedge].speed
      : delta < -WEDGE.orbitDeadband
        ? -WEDGE.orbitSpeed
        : 0;
  // Суета домножает и радиальную, и тангенциальную составляющую — иначе
  // Клин под проклятием сближается быстрее обычного, но обходит по кругу
  // прежним темпом, и «+20% всем» (GDD §11) оказывается верным лишь наполовину.
  const spd = curseSpeedMul(s);
  const orbitSpeed = mul(WEDGE.orbitSpeed, spd);
  s.eVX[i] = add(mul(towardX, mul(closing, spd)), mul(-towardY * side, orbitSpeed));
  s.eVY[i] = add(mul(towardY, mul(closing, spd)), mul(towardX * side, orbitSpeed));
}

/**
 * Мягкое расталкивание: враги не должны слипаться в одну точку.
 *
 * Слипшаяся толпа читается как один враг, простреливается одной пулей и
 * ломает единственное, ради чего враги вообще нужны, — понятную картину боя.
 */
export function separate(s: SimState, i: number): void {
  const r = statsOf(s.eType[i]).radius;
  for (let j = 0; j < MAX_ENEMIES; j++) {
    if (j === i || !s.eActive[j]) continue;
    const dx = sub(s.eX[i], s.eX[j]);
    const dy = sub(s.eY[i], s.eY[j]);
    const reach = mul(add(r, statsOf(s.eType[j]).radius), fromInt(AI_SEPARATION_REACH));
    if (!within(dx, dy, reach)) continue;

    // Сила падает с расстоянием: вплотную расталкивает сильно, на краю
    // радиуса почти не трогает. Квадраты — в обычных числах, как везде, где
    // счёт идёт на тысячи: в Q16.16 они не помещаются.
    const fx = units(dx);
    const fy = units(dy);
    const fr = units(reach);
    const strength = 1 - (fx * fx + fy * fy) / (fr * fr);

    normalize(dx, dy);
    if (normX === 0 && normY === 0) continue;
    const push = Math.trunc(AI_SEPARATION_SPEED * strength) | 0;
    s.eVX[i] = add(s.eVX[i], mul(normX, push));
    s.eVY[i] = add(s.eVY[i], mul(normY, push));
  }
}

/** Сдвинулось ли тело заметно меньше, чем намеревалось. */
export function blocked(fromX: Fx, fromY: Fx, toX: Fx, toY: Fx, vx: Fx, vy: Fx): boolean {
  const wantX = units(vx);
  const wantY = units(vy);
  const want = wantX * wantX + wantY * wantY;
  if (want === 0) return false;
  const gotX = units(sub(toX, fromX));
  const gotY = units(sub(toY, fromY));
  const fraction = FAIRNESS.blockedFraction;
  return gotX * gotX + gotY * gotY < want * fraction * fraction;
}

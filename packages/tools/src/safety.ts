/**
 * Достижимость безопасной точки — ограничитель D4.
 *
 * Самая ценная из проверок честности. Учитывая скорость игрока и рывок, в
 * каждый момент должна существовать позиция, куда он успевает уйти от всех
 * объявленных угроз. Headless-прогон проверяет это на каждом тике тысяч
 * забегов, и **непроходимая комбинация врагов становится падающим тестом, а
 * не жалобой в отзывах** (DIFFICULTY §7).
 *
 * Живёт в инструментах, а не в ядре: это анализ поверх состояния, а не часть
 * симуляции. Считать его в тике значило бы платить за него в каждом кадре
 * игры ради проверки, которая нужна в CI.
 *
 * Ключ ко всей проверке — время. Угроза не «есть» и «нет»: у каждой есть
 * момент, когда она доберётся до конкретной точки. Таран летит свои 490 единиц
 * почти секунду, и игрок в дальнем конце коридора имеет вдвое больше времени,
 * чем стоящий у Клина под носом. Первая версия считала весь коридор одинаково
 * срочным и объявляла непроходимым то, из чего игрок выходит шагом.
 */

import {
  ENEMIES,
  ENEMY_BULLET,
  EnemyPhase,
  EnemyType,
  FUSE,
  MAX_BULLETS,
  MAX_ENEMIES,
  PLAYER,
  WEDGE,
  EntityFlag,
  isFreeSpot,
  fromFloat,
  toFloat,
  type SimState,
} from '@dod/sim';

/** Шаг сетки поиска в единицах арены. Мельче — дороже, крупнее — врёт. */
const GRID = 40;
/** Запас к радиусу опасной зоны: лучше ложная тревога, чем пропуск. */
const MARGIN = 6;

interface Threat {
  /** Отрезок опасности: для круговой зоны начало и конец совпадают. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  radius: number;
  /**
   * Предупреждение, которое игрок получил, — вся длительность телеграфа, а не
   * остаток от неё.
   *
   * Весь расчёт ведётся по часам МОМЕНТА ОБЪЯВЛЕНИЯ: вопрос D4 звучит как
   * «когда атаку объявили, было ли куда уйти», а не «успеет ли он теперь, за
   * два оставшихся тика». Остаток в роли предупреждения превращал проверку в
   * требование телепортироваться из-под уже летящего тарана.
   */
  warmup: number;
  /** Скорость фронта вдоль отрезка, единиц за тик. Ноль — накрывает разом. */
  frontSpeed: number;
}

export interface SafetyReport {
  ok: boolean;
  tick: number;
  player: number;
  threats: number;
  /** Запас времени, который был у игрока, в тиках. */
  horizon: number;
  /** Найденная безопасная точка — в единицах арены. */
  x: number;
  y: number;
}

/** Буфер переиспользуется между вызовами: проверка идёт по каждому тику. */
const threats: Threat[] = [];

/** Собрать объявленные угрозы. Неозвученных угроз в игре нет по определению. */
function collectThreats(s: SimState): void {
  threats.length = 0;
  const pr = toFloat(PLAYER.radius) + MARGIN;

  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (!s.eActive[i]) continue;
    const x = toFloat(s.eX[i]);
    const y = toFloat(s.eY[i]);
    const stats = ENEMIES[s.eType[i]];
    const phase = s.ePhase[i];
    const left = Math.max(0, s.ePhaseUntil[i] - s.tick);
    const dx = toFloat(s.eDirX[i]);
    const dy = toFloat(s.eDirY[i]);

    if (s.eType[i] === EnemyType.Wedge) {
      if (phase !== EnemyPhase.Telegraph && phase !== EnemyPhase.Attack) continue;
      const speed = toFloat(WEDGE.dashSpeed);
      const len = speed * (phase === EnemyPhase.Telegraph ? stats.attackTicks : left);
      threats.push({
        x0: x,
        y0: y,
        x1: x + dx * len,
        y1: y + dy * len,
        radius: toFloat(stats.radius) + pr,
        warmup: stats.telegraphTicks,
        frontSpeed: speed,
      });
      continue;
    }

    if (s.eType[i] === EnemyType.Fuse) {
      if (phase !== EnemyPhase.Telegraph) continue;
      /*
       * Зона взрыва берётся вокруг ТЕКУЩЕГО места Фитиля и не растягивается
       * на путь, который он ещё пробежит.
       *
       * Растянуть её — значит посчитать движение дважды: Фитиль бежит за
       * игроком, но и игрок бежит, причём быстрее (320 против 260 u/с). За
       * 0.8 с горения он отыгрывает у Фитиля сорок восемь единиц — ровно тот
       * запас, на котором построен этот враг: убегать надо было раньше, но
       * убежать всё-таки можно.
       */
      threats.push({
        x0: x,
        y0: y,
        x1: x,
        y1: y,
        radius: toFloat(FUSE.blastRadius) + pr,
        warmup: stats.telegraphTicks,
        frontSpeed: 0,
      });
      continue;
    }

    if (phase !== EnemyPhase.Telegraph) continue;
    const speed = toFloat(ENEMY_BULLET.speed);
    threats.push({
      x0: x,
      y0: y,
      x1: x + dx * speed * ENEMY_BULLET.lifeTicks,
      y1: y + dy * speed * ENEMY_BULLET.lifeTicks,
      radius: toFloat(ENEMY_BULLET.radius) + pr,
      warmup: stats.telegraphTicks,
      frontSpeed: speed,
    });
  }

  for (let i = 0; i < MAX_BULLETS; i++) {
    if (!s.bActive[i] || s.bOwner[i] >= 0) continue;
    const left = Math.max(0, s.bDeadline[i] - s.tick);
    const x = toFloat(s.bX[i]);
    const y = toFloat(s.bY[i]);
    const vx = toFloat(s.bVX[i]);
    const vy = toFloat(s.bVY[i]);
    threats.push({
      x0: x,
      y0: y,
      x1: x + vx * left,
      y1: y + vy * left,
      radius: toFloat(ENEMY_BULLET.radius) + pr,
      // Предупреждением о снаряде был телеграф выстрелившего Кирпича.
      warmup: ENEMIES[EnemyType.Brick].telegraphTicks,
      frontSpeed: Math.sqrt(vx * vx + vy * vy),
    });
  }
}

/** Доля пути вдоль отрезка до ближайшей к точке позиции, 0..1. */
let projU = 0;

/** Расстояние от точки до отрезка. Круговая зона — вырожденный случай. */
function distToSegment(px: number, py: number, t: Threat): number {
  const dx = t.x1 - t.x0;
  const dy = t.y1 - t.y0;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    projU = 0;
    return Math.sqrt((px - t.x0) ** 2 + (py - t.y0) ** 2);
  }
  let u = ((px - t.x0) * dx + (py - t.y0) * dy) / len2;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  projU = u;
  const ex = px - (t.x0 + dx * u);
  const ey = py - (t.y0 + dy * u);
  return Math.sqrt(ex * ex + ey * ey);
}

/**
 * Через сколько тиков угроза доберётся до точки. Бесконечность — не доберётся.
 *
 * Именно здесь живёт вся честность проверки: точка в дальнем конце коридора
 * опасна, но не срочно.
 */
function ticksToReach(px: number, py: number, t: Threat): number {
  if (distToSegment(px, py, t) >= t.radius) return Infinity;
  if (t.frontSpeed === 0) return t.warmup;
  const along = Math.sqrt((t.x1 - t.x0) ** 2 + (t.y1 - t.y0) ** 2) * projU;
  return t.warmup + along / t.frontSpeed;
}

/**
 * Найти точку, куда игрок успевает уйти от всех объявленных угроз.
 *
 * Рывок в дальность входит — ровно так правило и сформулировано в
 * DIFFICULTY §7 («учитывая скорость игрока и рывок»). Считается он доступным
 * только когда действительно перезарядился: комбинация, из которой выход есть
 * лишь на готовом рывке, честна не всегда, а раз в 1.2 секунды.
 */
export function findSafePoint(s: SimState, player: number): SafetyReport {
  const px = toFloat(s.pX[player]);
  const py = toFloat(s.pY[player]);
  const report: SafetyReport = {
    ok: true,
    tick: s.tick,
    player,
    threats: 0,
    horizon: Infinity,
    x: px,
    y: py,
  };
  if ((s.pFlags[player] & EntityFlag.Alive) === 0) return report;

  collectThreats(s);
  report.threats = threats.length;
  if (threats.length === 0) return report;

  // Сколько времени у игрока есть — по самой скорой из накрывающих его угроз.
  let horizon = Infinity;
  for (const t of threats) {
    const dt = ticksToReach(px, py, t);
    if (dt < horizon) horizon = dt;
  }
  // Игрок вне всех опасных зон уже стоит в безопасной точке.
  if (horizon === Infinity) return report;
  report.horizon = horizon;

  const speed = toFloat(PLAYER.speed);
  const dash = s.tick >= s.pDashReady[player] ? toFloat(PLAYER.dashDistance) : 0;
  const reach = speed * horizon + dash;

  // Сетка идёт по фактической арене: она растёт вместе с составом.
  const w = toFloat(s.arenaW);
  const h = toFloat(s.arenaH);
  for (let gy = GRID; gy < h; gy += GRID) {
    for (let gx = GRID; gx < w; gx += GRID) {
      const dist = Math.sqrt((gx - px) ** 2 + (gy - py) ** 2);
      if (dist > reach) continue;
      if (!isFreeSpot(s, fromFloat(gx), fromFloat(gy), PLAYER.radius)) continue;

      // Точка годится, если игрок оказывается там раньше, чем туда доберётся
      // любая угроза. Вечной безопасности не требуется: бой на то и бой.
      const travel = Math.max(0, dist - dash) / speed;
      let ok = true;
      for (const t of threats) {
        if (ticksToReach(gx, gy, t) <= travel) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      report.x = gx;
      report.y = gy;
      return report;
    }
  }

  report.ok = false;
  return report;
}

/** Проверить всех живых игроков. Возвращает первый провал или null. */
export function checkSafety(s: SimState): SafetyReport | null {
  for (let p = 0; p < s.playerCount; p++) {
    const r = findSafePoint(s, p);
    if (!r.ok) return r;
  }
  return null;
}

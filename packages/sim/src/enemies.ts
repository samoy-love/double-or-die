/**
 * Враги: автоматы состояний, волны и правила честности.
 *
 * Никаких «умных» решений. Поведение обязано быть предсказуемым, потому что
 * игрок должен учиться, а не угадывать (DIFFICULTY §7) — вся сложность игры
 * покупается ставками, а не непознаваемым ИИ.
 *
 * Каждая атака проходит через состояние `Telegraph`: сначала объявлена, потом
 * случилась. Длительность телеграфа — главный рычаг честности, и удлинить его
 * можно, не тронув ни одного другого числа.
 *
 * Модуль разделён на подсистемы (ТЗ-16, `docs/reviews/iter-3.md` §3.5):
 * `enemies/spawn.ts` — волны и бюджет угрозы, `enemies/progression.ts` —
 * продвижение по этажу, `enemies/movement.ts` — движение врагов,
 * `enemies/targeting.ts` — прицеливание и телеграфы. Здесь остаются только
 * автоматы состояний конкретных типов врагов и общий тик — они вяжут все
 * четыре подсистемы вместе, и растащить их дальше значило бы разорвать
 * переходы фаз одного и того же врага по разным файлам.
 */

import { pushOutOfColumns, pushedX, pushedY } from './arena';
import { AI_DECISION_PERIOD, ENEMIES, EnemyPhase, EnemyType, FUSE, WEDGE } from './config';
import { explode, fireEnemy, killEnemy, statsOf } from './combat';
import { add, mul, sub } from './fixed';
import { updateNav } from './nav';
import { EntityFlag, MAX_ENEMIES, type SimState } from './state';
import { within } from './trig';
import {
  approach,
  blocked,
  brake,
  curseSpeedMul,
  keepDistance,
  orbit,
  separate,
} from './enemies/movement';
import {
  contactDamage,
  countTargeting,
  countTelegraphs,
  enterTelegraph,
  isAlive,
  retarget,
  telegraphAllowed,
} from './enemies/targeting';
import { stepWaves } from './enemies/spawn';
import { advanceRoom } from './enemies/progression';

export * from './enemies/spawn';
export * from './enemies/progression';
export * from './enemies/movement';
export * from './enemies/targeting';

function stepWedge(s: SimState, i: number): void {
  const t = s.eTarget[i];
  switch (s.ePhase[i]) {
    case EnemyPhase.Idle: {
      if (!isAlive(s, t)) {
        brake(s, i);
        return;
      }
      const dx = sub(s.pX[t], s.eX[i]);
      const dy = sub(s.pY[t], s.eY[i]);

      // Сначала пробуем объявить таран: очередь ограничена тремя, и место в
      // ней достаётся тому, кто уже в коридоре дистанций.
      if (!within(dx, dy, WEDGE.minAimRange) && within(dx, dy, WEDGE.aimRange)) {
        // Проверка идёт перед самим объявлением: она же вычисляет направление
        // удара, которым воспользуется enterTelegraph.
        if (telegraphAllowed(s, i, t)) {
          enterTelegraph(s, i);
          return;
        }
      }

      orbit(s, i, dx, dy);
      return;
    }
    case EnemyPhase.Telegraph: {
      // Стоит и целится: направление уже зафиксировано и больше не меняется.
      // Именно из-за этого уклонение ощущается навыком, а не лотереей.
      brake(s, i);
      if (s.tick < s.ePhaseUntil[i]) return;
      s.ePhase[i] = EnemyPhase.Attack;
      s.ePhaseUntil[i] = s.tick + ENEMIES[EnemyType.Wedge].attackTicks;
      const dash = mul(WEDGE.dashSpeed, curseSpeedMul(s));
      s.eVX[i] = mul(s.eDirX[i], dash);
      s.eVY[i] = mul(s.eDirY[i], dash);
      return;
    }
    case EnemyPhase.Attack: {
      if (s.tick < s.ePhaseUntil[i]) return;
      s.ePhase[i] = EnemyPhase.Recover;
      s.ePhaseUntil[i] = s.tick + ENEMIES[EnemyType.Wedge].recoverTicks;
      // Новичком враг остаётся только до первой своей атаки: растянутый
      // телеграф — это урок, а не постоянная скидка.
      s.eFlags[i] &= ~EntityFlag.Novice;
      return;
    }
    default: {
      brake(s, i);
      if (s.tick >= s.ePhaseUntil[i]) s.ePhase[i] = EnemyPhase.Idle;
    }
  }
}

function stepBrick(s: SimState, i: number): void {
  const t = s.eTarget[i];
  const stats = ENEMIES[EnemyType.Brick];

  if (isAlive(s, t) && s.ePhase[i] !== EnemyPhase.Telegraph) keepDistance(s, i, t);
  else brake(s, i);

  switch (s.ePhase[i]) {
    case EnemyPhase.Telegraph: {
      if (s.tick < s.ePhaseUntil[i]) return;
      fireEnemy(s, i);
      s.ePhase[i] = EnemyPhase.Attack;
      s.ePhaseUntil[i] = s.tick + stats.attackTicks;
      s.eFlags[i] &= ~EntityFlag.Novice;
      return;
    }
    case EnemyPhase.Attack: {
      if (s.tick < s.ePhaseUntil[i]) return;
      s.ePhase[i] = EnemyPhase.Recover;
      s.ePhaseUntil[i] = s.tick + stats.recoverTicks;
      return;
    }
    default: {
      if (s.tick < s.ePhaseUntil[i]) return;
      if (!isAlive(s, t) || !telegraphAllowed(s, i, t)) {
        // Потолок телеграфов занят — Кирпич ждёт, а не стреляет «в обход».
        s.ePhaseUntil[i] = s.tick + AI_DECISION_PERIOD;
        return;
      }
      enterTelegraph(s, i);
    }
  }
}

function stepFuse(s: SimState, i: number): void {
  const t = s.eTarget[i];
  approach(s, i, t, ENEMIES[EnemyType.Fuse].speed);

  if (s.ePhase[i] === EnemyPhase.Telegraph) {
    if (s.tick < s.ePhaseUntil[i]) return;
    // Точка невозврата пройдена ещё при поджоге: убегать поздно, и в этом
    // весь Фитиль.
    explode(s, s.eX[i], s.eY[i], i);
    killEnemy(s, i);
    return;
  }

  if (!isAlive(s, t)) return;
  if (!within(sub(s.pX[t], s.eX[i]), sub(s.pY[t], s.eY[i]), FUSE.igniteRange)) return;
  if (!telegraphAllowed(s, i, t)) return;
  enterTelegraph(s, i);
}

/** Один тик всех врагов и всей системы волн. */
export function stepEnemies(s: SimState): void {
  // Навигация готовится один раз на тик и обслуживает всех: поле потока
  // считается от цели, а не от врага, поэтому его стоимость не зависит от
  // того, сколько врагов на арене.
  updateNav(s);
  countTelegraphs(s);
  const activeEnemies = countTargeting(s);

  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (!s.eActive[i]) continue;

    // Решения принимаются 6 Гц, фазы разнесены по врагам: иначе вся арена
    // думает в один тик и дёргается синхронно, как одно существо.
    //
    // Объявленная атака цель не меняет. Смена цели посреди телеграфа не
    // только противоречит «направление фиксируется», но и обходит потолок
    // телеграфов: враг занимал бы место в очереди к одному игроку, а числился
    // за другим — и на игрока приходилось бы четыре объявленных атаки вместо
    // трёх, причём тем чаще, чем больше народу на арене.
    const busy = s.ePhase[i] === EnemyPhase.Telegraph || s.ePhase[i] === EnemyPhase.Attack;
    const decides = (s.tick + i) % AI_DECISION_PERIOD === 0;
    if (!busy && decides) retarget(s, i, activeEnemies);

    switch (s.eType[i]) {
      case EnemyType.Wedge:
        stepWedge(s, i);
        break;
      case EnemyType.Brick:
        stepBrick(s, i);
        break;
      default:
        stepFuse(s, i);
    }
    if (!s.eActive[i]) continue;

    separate(s, i);

    const stats = statsOf(s.eType[i]);
    const fromX = s.eX[i];
    const fromY = s.eY[i];
    pushOutOfColumns(s, add(fromX, s.eVX[i]), add(fromY, s.eVY[i]), stats.radius);
    s.eX[i] = pushedX;
    s.eY[i] = pushedY;

    /*
     * Клин, упёршийся в колонну или стену, теряет рывок: укрытие обязано
     * быть укрытием.
     *
     * Упёрся — значит почти не сдвинулся, а не «задел границу». Прежняя
     * проверка сравнивала намеченную точку с обрезанной по любой из осей, и
     * таран, идущий вдоль стены по диагонали, отменялся на первом же тике:
     * со стороны это выглядело как враг, который начал разгон и тут же встал.
     * Скольжение вдоль препятствия — нормальный ход тарана, остановка — нет.
     */
    /*
     * Упёрся ли враг — вопрос дорогой, и задаётся он не всем и не всегда.
     *
     * Атакующему Клину он нужен каждый тик: таран, потерявший ход, обязан
     * закончиться в тот же кадр, иначе колонна перестаёт быть укрытием.
     * Всем остальным хватает частоты принятия решений: разворот стороны
     * обхода на десятую долю секунды позже незаметен, а считать дробную
     * геометрию для сорока врагов каждый кадр — это заметная доля тика.
     */
    const ramming = s.ePhase[i] === EnemyPhase.Attack && s.eType[i] === EnemyType.Wedge;
    if (ramming || decides) {
      if (blocked(fromX, fromY, s.eX[i], s.eY[i], s.eVX[i], s.eVY[i])) {
        if (ramming) {
          s.ePhase[i] = EnemyPhase.Recover;
          s.ePhaseUntil[i] = s.tick + stats.recoverTicks;
          brake(s, i);
        } else {
          // Разворот стороны обхода — не способ найти дорогу, её находит
          // поле потока (nav.ts). Это страховка на тот случай, когда враг
          // упёрся, а поле говорит идти дальше: в толкучке его прижимают
          // соседи, у самой грани клетки направление ещё старое, и застрявший
          // навсегда враг ломает темп боя вернее, чем неоптимальный обход.
          s.eFlags[i] ^= EntityFlag.OrbitFlip;
        }
      }
    }

    contactDamage(s, i);
  }

  if (stepWaves(s)) advanceRoom(s);
}

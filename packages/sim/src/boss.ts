/**
 * Рулетка: колесо, шары, проваливающиеся секторы и встречная ставка.
 *
 * Отдельный модуль, и он НИЧЕГО не импортирует из `enemies.ts`. Это не
 * стилистика, а условие: волны зовут `advanceRoom`, а боссовая комната кончается
 * смертью босса, — встречный импорт замкнул бы модули в цикл, и обращения к
 * `Meta` в горячем пути перестали бы инлайниться (история `navEpoch` в
 * `state.ts`). Поэтому шов ровно один: `advanceRoom` смотрит на фазу забега и
 * на запас прочности, а всё остальное про босса живёт здесь.
 *
 * ГЛАВНОЕ ПРАВИЛО БОЯ: **вращается разметка, а не геометрия** (GDD §8.1).
 * Колесо крутится как рисунок и как принадлежность точки сектору; проходимость
 * арены неподвижна, и тела на полу вращение не переносит. Поле потока считается
 * по статической сетке, и вращающаяся коллизионная геометрия означала бы
 * пересчёт сетки каждый тик и смерть от геометрии в игре, где умирать положено
 * от своих решений. Единственное исключение — провалившийся сектор третьей
 * фазы: он и есть настоящая дыра в полу.
 *
 * Новых слотов состояния босс не завёл ни одного: всё живёт в заранее
 * отведённых `Meta.Boss*`, `Meta.CounterBet*` и буферах шаров и секторов.
 * Два слота при этом несут по два смысла, и оба записаны здесь:
 *
 *   — `BossPhaseUntil` — тик ВХОДА в текущую фазу. Фазы переключаются порогами
 *     запаса, а не часами, поэтому «до» здесь нечему означать; зато от входа в
 *     третью фазу считается разгон колеса.
 *   — `CounterBetUntil` — пока ставка идёт, это тик её разрешения; после срыва
 *     игроком — тик конца оглушения. Что именно, читается по
 *     `CounterBetBroken`, и путаницы не бывает: ставка объявляется один раз.
 */

import { ARENA_PAD, BALL, BOSS, PISTOL, PLAYER, WAVE } from './config';
import { damagePlayer } from './combat';
import { add, type Fx, FX_ONE, mul, sub } from './fixed';
import { Stream, nextInt } from './rng';
import {
  EntityFlag,
  MAX_BALLS,
  MAX_BULLETS,
  Meta,
  RunPhase,
  SECTOR_COUNT,
  type SimState,
} from './state';
import {
  ANGLE_FULL,
  ANGLE_MASK,
  angleDelta,
  atan2,
  cos,
  length,
  normalize,
  normX,
  normY,
  sin,
  within,
} from './trig';

/** Идёт ли бой с боссом: запас прочности выдан и ещё не исчерпан. */
export const bossInPlay = (s: SimState): boolean => s.meta[Meta.BossMaxHP] > 0;

/** Центр колеса — центр арены. Босс стоит на оси, вокруг него всё и вертится. */
export const wheelX = (s: SimState): Fx => (s.arenaW >> 1) | 0;
export const wheelY = (s: SimState): Fx => (s.arenaH >> 1) | 0;

/**
 * Радиус колеса: оно вписано в арену по высоте.
 *
 * Производная от арены, а не отдельное число: арена растёт с составом, и
 * колесо обязано расти вместе с ней, иначе вчетвером бой идёт на краю пола.
 */
export const wheelRadius = (s: SimState): Fx => sub(s.arenaH >> 1, ARENA_PAD);

/**
 * Текущий поворот разметки.
 *
 * Чистая функция от тика и от момента входа в третью фазу — ни одного
 * накопителя в состоянии. Накопитель здесь был бы лишним словом в хеше и
 * лишним источником рассинхронизации: скоростей всего две, и вторая включается
 * ровно один раз за бой.
 */
export function wheelAngle(s: SimState): number {
  let spun = BOSS.spinEarly * s.tick;
  if (s.meta[Meta.BossPhase] >= 3) {
    spun += (BOSS.spinLate - BOSS.spinEarly) * (s.tick - s.meta[Meta.BossPhaseUntil]);
  }
  return Math.trunc(spun / FX_ONE) & ANGLE_MASK;
}

/** Направление на середину сектора с учётом поворота разметки. */
export function sectorAngle(s: SimState, sector: number): number {
  const mid = Math.trunc((sector * ANGLE_FULL + ANGLE_FULL / 2) / SECTOR_COUNT);
  return (wheelAngle(s) + mid) & ANGLE_MASK;
}

/** Сектор, в котором лежит точка. Считается по разметке, а не по геометрии. */
export function sectorAt(s: SimState, x: Fx, y: Fx): number {
  const a = (atan2(sub(y, wheelY(s)), sub(x, wheelX(s))) - wheelAngle(s)) & ANGLE_MASK;
  return Math.trunc((a * SECTOR_COUNT) / ANGLE_FULL);
}

/** Провалившийся прямо сейчас сектор или −1. Провал всегда один (GDD §8.1). */
export function fallenSector(s: SimState): number {
  for (let i = 0; i < SECTOR_COUNT; i++) {
    if (s.sectorFallAt[i] === 0) continue;
    if (s.tick >= s.sectorFallAt[i] && s.tick < s.sectorRestoreAt[i]) return i;
  }
  return -1;
}

/** Идёт ли встречная ставка: объявлена, не сорвана и часы ещё не вышли. */
export const counterBetRunning = (s: SimState): boolean =>
  s.meta[Meta.CounterBetBroken] === 0 &&
  s.meta[Meta.CounterBetUntil] !== 0 &&
  s.tick < s.meta[Meta.CounterBetUntil];

/** Оглушён ли босс: плата за сорванную им ставку и окно свободного урона. */
export const bossStunned = (s: SimState): boolean =>
  s.meta[Meta.CounterBetBroken] === 1 && s.tick < s.meta[Meta.CounterBetUntil];

/**
 * Один тик боя с боссом. Зовётся из `step` рядом с шагом врагов.
 *
 * Ничего не делает вне боссовой комнаты — ровно поэтому вызов и стоит
 * безусловно: фаза забега уже описывает, что происходит, и второй признак
 * «идёт ли бой» на стороне вызывающего разошёлся бы с этим первым.
 */
export function stepBoss(s: SimState): void {
  if (s.meta[Meta.Phase] !== RunPhase.Boss) return;

  if (s.meta[Meta.BossPhase] === 0) {
    // Босс выходит после экрана расчёта восьмой комнаты. Признак того, что
    // пауза кончилась, — назначенная первая волна: расписание волн ведёт её
    // само, и отдельные часы здесь были бы вторыми часами на то же событие.
    if (s.meta[Meta.Wave] >= 1) startBoss(s);
    return;
  }

  stepHits(s);
  stepCounterBet(s);
  stepPhases(s);
  stepBalls(s);
  stepSectors(s);

  if (s.meta[Meta.BossHP] <= 0) defeatBoss(s);
}

/**
 * Выпустить босса. Публично: этим пользуются сценарии и отладка.
 *
 * Волны боссовой комнаты идут наравне с ним, и бюджет им назначен при входе в
 * комнату — половина бюджета восьмой (DIFFICULTY §8). Без него четыре из шести
 * стартовых пари в боссовой комнате не двигаются вовсе, а Крупье не приходит с
 * картой ни разу: и прогресс удержаний, и порог подброса считаются от угрозы.
 *
 * Номер волны держится на последней: расписание волн иначе назначило бы
 * боссовой комнате ещё три обычных, каждую с полным бюджетом восьмой.
 */
export function startBoss(s: SimState): void {
  const floor = s.meta[Meta.Floor];
  const base = BOSS.hpByFloor[Math.min(floor, BOSS.hpByFloor.length) - 1];
  const hp = Math.trunc((base * (100 + BOSS.hpPlayerGrowthPct * (s.playerCount - 1))) / 100);

  s.meta[Meta.BossMaxHP] = hp;
  s.meta[Meta.BossHP] = hp;
  s.meta[Meta.BossPhase] = 1;
  s.meta[Meta.BossPhaseUntil] = s.tick;
  s.meta[Meta.CounterBetUntil] = 0;
  s.meta[Meta.CounterBetBroken] = 0;

  s.meta[Meta.Wave] = WAVE.wavesPerRoom;
  s.meta[Meta.NextWaveAt] = 0;
  s.meta[Meta.WaveBudget] = s.meta[Meta.RoomThreat];
  s.meta[Meta.ThreatCleared] = 0;

  s.ballActive.fill(0);
  s.sectorFallAt.fill(0);
  s.sectorRestoreAt.fill(0);

  const start = nextInt(s.rng, Stream.Combat, SECTOR_COUNT);
  placeBall(s, 0, start);
  aimBall(s, 0, nextSector(s, start), s.tick + BALL.jumpTicks);
}

/**
 * Босс побеждён: награда, счёт и конец комнаты.
 *
 * Свита уходит вместе с ним. Не жадность до тиков, а правило: комната
 * кончается, когда кончился босс, и оставленный на арене Клин отложил бы конец
 * этажа на столько, сколько его будут добивать.
 *
 * Этаж двигает `advanceRoom` — он видит пустую арену и погашенный запас
 * прочности. Ключи за босса считает `keysEarned` по `BossesBeaten`.
 */
function defeatBoss(s: SimState): void {
  const reward = BOSS.rewardPerFloor * s.meta[Meta.Floor];
  for (let p = 0; p < s.playerCount; p++) {
    if ((s.pFlags[p] & EntityFlag.Alive) === 0) continue;
    s.pChips[p] += reward;
  }
  s.meta[Meta.BossesBeaten]++;

  s.meta[Meta.BossHP] = 0;
  s.meta[Meta.BossMaxHP] = 0;
  s.meta[Meta.BossPhase] = 0;
  s.meta[Meta.BossPhaseUntil] = 0;
  s.meta[Meta.CounterBetUntil] = 0;
  s.meta[Meta.CounterBetBroken] = 0;

  s.ballActive.fill(0);
  s.sectorFallAt.fill(0);
  s.sectorRestoreAt.fill(0);
  s.eActive.fill(0);
  s.spActive.fill(0);
  s.bActive.fill(0);

  s.meta[Meta.WaveBudget] = 0;
  s.meta[Meta.Wave] = WAVE.wavesPerRoom;
  s.meta[Meta.NextWaveAt] = 0;
}

/**
 * Урон по боссу. Публично: этим пользуются сценарии и отладка.
 *
 * Любое попадание срывает встречную ставку — в коопе тоже: ставка идёт против
 * всей команды, и попадание любого её срывает (GDD §8.1).
 */
export function damageBoss(s: SimState, damage: number): void {
  if (!bossInPlay(s)) return;
  const hp = s.meta[Meta.BossHP] - damage;
  s.meta[Meta.BossHP] = hp < 0 ? 0 : hp;
  if (counterBetRunning(s)) {
    s.meta[Meta.CounterBetBroken] = 1;
    s.meta[Meta.CounterBetUntil] = s.tick + BOSS.stunTicks;
  }
}

/**
 * Попадания по боссу и кольцо встречной ставки.
 *
 * Босс не лежит в пуле врагов, поэтому пули проверяются здесь. Проверка идёт
 * по положению снаряда на КОНЕЦ прошлого тика: шаг снарядов в `step` следует за
 * шагом босса, и иначе выстрел успевал бы попасть в том же тике, в котором
 * сделан, — ровно то, что запрещает порядок обработки.
 */
function stepHits(s: SimState): void {
  const cx = wheelX(s);
  const cy = wheelY(s);
  const reach = add(BOSS.radius, PISTOL.bulletRadius);
  const ring = counterBetRunning(s);

  for (let i = 0; i < MAX_BULLETS; i++) {
    if (!s.bActive[i] || s.bOwner[i] < 0) continue;

    if (ring && blockedByRing(s, i)) {
      s.bActive[i] = 0;
      continue;
    }
    if (!within(sub(s.bX[i], cx), sub(s.bY[i], cy), reach)) continue;

    s.bActive[i] = 0;
    damageBoss(s, PISTOL.damage);
  }
}

/**
 * Гасит ли кольцо шаров эту пулю.
 *
 * Кольцо перекрывает не всё: между шарами остаётся просвет, и попасть по боссу
 * можно только сквозь него — то есть встав так, чтобы просвет смотрел на тебя,
 * либо шагнув внутрь кольца. Выбор от этого получается настоящий и считается в
 * уме: отдать 15% запаса, отступив на десять секунд, или подойти под шары ради
 * четырёх секунд свободного урона (GDD §8.1).
 *
 * Гасится только пуля, ВЛЕТАЮЩАЯ снаружи: выпущенная изнутри кольца проходит,
 * иначе «подойти» перестало бы работать вовсе.
 */
function blockedByRing(s: SimState, bullet: number): boolean {
  const cx = wheelX(s);
  const cy = wheelY(s);
  const r = BOSS.ringRadius;

  const px = sub(s.bX[bullet], s.bVX[bullet]);
  const py = sub(s.bY[bullet], s.bVY[bullet]);
  if (within(sub(px, cx), sub(py, cy), r)) return false;
  if (!within(sub(s.bX[bullet], cx), sub(s.bY[bullet], cy), r)) return false;

  const a = atan2(sub(s.bY[bullet], cy), sub(s.bX[bullet], cx));
  const half = Math.trunc(ANGLE_FULL / (2 * MAX_BALLS)) - BOSS.ringGap;
  for (let k = 0; k < MAX_BALLS; k++) {
    const ba = ringAngle(s, k);
    if (Math.abs(angleDelta(ba, a)) <= half) return true;
  }
  return false;
}

/** Место шара в кольце: шары разнесены поровну и едут вместе с разметкой. */
const ringAngle = (s: SimState, k: number): number =>
  (wheelAngle(s) + Math.trunc((k * ANGLE_FULL) / MAX_BALLS)) & ANGLE_MASK;

/**
 * Встречная ставка: разрешение по часам.
 *
 * Срыв ловится в `damageBoss`, здесь — только исход «босс выиграл». Лечение
 * упирается в потолок запаса: без верхней границы выигранная ставка тихо
 * поднимала бы полосу выше начала боя, то есть делала бой длиннее задуманного
 * ровно там, где игрок отступил. Потолок проверяет и инвариант.
 */
function stepCounterBet(s: SimState): void {
  if (s.meta[Meta.CounterBetBroken] !== 0) return;
  if (s.meta[Meta.CounterBetUntil] === 0) return;
  if (s.tick < s.meta[Meta.CounterBetUntil]) return;

  const max = s.meta[Meta.BossMaxHP];
  const healed = s.meta[Meta.BossHP] + Math.trunc((max * BOSS.counterBetHealPct) / 100);
  s.meta[Meta.BossHP] = healed > max ? max : healed;
  s.meta[Meta.CounterBetUntil] = 0;
  s.meta[Meta.CounterBetBroken] = 2;
}

/**
 * Фазы по порогам 70% и 35% запаса.
 *
 * Только вперёд. Лечение по выигранной боссом ставке поднимает полосу обратно
 * над порогом, и без этого правила бой откатывался бы во вторую фазу, а
 * встречная ставка объявлялась бы повторно — при том, что GDD обещает её ОДИН
 * раз за бой.
 */
function stepPhases(s: SimState): void {
  const hp = s.meta[Meta.BossHP] * 100;
  const max = s.meta[Meta.BossMaxHP];
  const want = hp <= max * BOSS.phaseThreePct ? 3 : hp <= max * BOSS.phaseTwoPct ? 2 : 1;

  // По одной фазе за шаг: удар, снявший половину полосы разом, обязан
  // объявить встречную ставку, а не проскочить её.
  for (let p = s.meta[Meta.BossPhase] + 1; p <= want; p++) enterPhase(s, p);
}

function enterPhase(s: SimState, phase: number): void {
  s.meta[Meta.BossPhase] = phase;
  s.meta[Meta.BossPhaseUntil] = s.tick;

  if (phase === 2) {
    s.meta[Meta.CounterBetUntil] = s.tick + BOSS.counterBetTicks;
    s.meta[Meta.CounterBetBroken] = 0;
    return;
  }
  if (phase !== 3) return;

  // Третья фаза: шаров три, разнесены по ободу на 120° и прыгают со сдвигом в
  // треть периода — три волны подряд, а не залп из трёх.
  for (let i = 1; i < MAX_BALLS; i++) {
    const target = (s.ballSector[0] + Math.trunc((SECTOR_COUNT * i) / MAX_BALLS)) % SECTOR_COUNT;
    placeBall(s, i, (target + SECTOR_COUNT / 2) % SECTOR_COUNT);
    aimBall(s, i, target, s.tick + BALL.jumpTicks - BALL.staggerTicks * i);
  }
}

/** Поставить шар на обод в названный сектор. Разметка едет, тело — нет. */
function placeBall(s: SimState, i: number, sector: number): void {
  const a = sectorAngle(s, sector);
  const r = sub(wheelRadius(s), BALL.radius);
  s.ballX[i] = add(wheelX(s), mul(cos(a), r));
  s.ballY[i] = add(wheelY(s), mul(sin(a), r));
  s.ballActive[i] = 1;
}

/** Объявить приземление: сектор и тик. Метка на секторе — это и есть телеграф. */
function aimBall(s: SimState, i: number, sector: number, landAt: number): void {
  s.ballSector[i] = sector;
  s.ballLandAt[i] = landAt;
}

/** Следующий сектор шара: любой, кроме того, в котором он сидит. */
const nextSector = (s: SimState, from: number): number =>
  (from + 1 + nextInt(s.rng, Stream.Combat, SECTOR_COUNT - 1)) % SECTOR_COUNT;

/**
 * Шары: прыжок, приземление, ударная волна.
 *
 * Оглушённый босс шарами не бьёт — «не атакует и не защищается» (GDD §8.1), —
 * поэтому срок приземления едет вместе с оглушением, а не догоняет его залпом
 * из четырёх пропущенных прыжков.
 *
 * На время встречной ставки шары смыкаются в кольцо вокруг босса и стоят в
 * нём: прыгающий шар не может быть стеной, а стена — прыгать.
 */
function stepBalls(s: SimState): void {
  const frozen = bossStunned(s);
  const ring = counterBetRunning(s);

  for (let i = 0; i < MAX_BALLS; i++) {
    if (!s.ballActive[i]) continue;

    if (ring) {
      const a = ringAngle(s, i);
      s.ballX[i] = add(wheelX(s), mul(cos(a), BOSS.ringRadius));
      s.ballY[i] = add(wheelY(s), mul(sin(a), BOSS.ringRadius));
      s.ballLandAt[i]++;
      continue;
    }
    if (frozen) {
      s.ballLandAt[i]++;
      continue;
    }
    if (s.tick < s.ballLandAt[i]) continue;

    placeBall(s, i, s.ballSector[i]);
    shockwave(s, s.ballX[i], s.ballY[i]);

    // Ведущий шар выбирает сектор сам, остальные держатся от него на 120°:
    // разнос по ободу — свойство тройки, а не удача трёх независимых бросков.
    const target =
      i === 0
        ? nextSector(s, s.ballSector[0])
        : (s.ballSector[0] + Math.trunc((SECTOR_COUNT * i) / MAX_BALLS)) % SECTOR_COUNT;
    aimBall(s, i, target, s.tick + BALL.jumpTicks);
  }
}

/**
 * Ударная волна шара: отброс с кувырком и ни капли урона.
 *
 * Прямое следствие правила GDD §6: удары боссов унижают, а не убивают. Волна —
 * самая частая атака боя, и урон по ней превратил бы Рулетку в счётчик сердец,
 * отнятых механикой, которую игрок не выбирал. Отбрасывает и неуязвимого:
 * кувырок — не урон, и «увернулся, но всё равно снесло» читается честно.
 */
function shockwave(s: SimState, x: Fx, y: Fx): void {
  for (let p = 0; p < s.playerCount; p++) {
    if ((s.pFlags[p] & EntityFlag.Alive) === 0) continue;
    const dx = sub(s.pX[p], x);
    const dy = sub(s.pY[p], y);
    if (!within(dx, dy, add(BALL.blastRadius, PLAYER.radius))) continue;
    tumble(s, p, dx, dy);
  }
}

/** Кувырок в заданную сторону. Совпадение с эпицентром толкает вправо, а не в NaN. */
function tumble(s: SimState, p: number, dx: Fx, dy: Fx): void {
  normalize(dx, dy);
  const nx = normX === 0 && normY === 0 ? FX_ONE : normX;
  const ny = normX === 0 && normY === 0 ? 0 : normY;
  s.pVX[p] = mul(nx, PLAYER.knockbackSpeed);
  s.pVY[p] = mul(ny, PLAYER.knockbackSpeed);
  s.pRagdollUntil[p] = s.tick + PLAYER.ragdollTicks;
  s.pFlags[p] |= EntityFlag.Ragdoll;
}

/**
 * Проваливающиеся секторы третьей фазы.
 *
 * По одному за раз: два одновременных вырезают из колеса четверть. Расписание
 * держится в самих буферах сектора — тик провала и тик возврата, — и следующий
 * назначается ровно тогда, когда возвращается предыдущий. Отдельных часов на
 * период не заведено намеренно: они были бы третьим числом там, где двух уже
 * хватает, и разъезжались бы с ними при первой же паузе.
 */
function stepSectors(s: SimState): void {
  if (s.meta[Meta.BossPhase] < 3) return;

  // Оглушённый босс пола из-под ног не убирает: провал — такая же объявленная
  // атака, как прыжок шара.
  if (bossStunned(s)) {
    for (let i = 0; i < SECTOR_COUNT; i++) {
      if (s.sectorFallAt[i] === 0) continue;
      s.sectorFallAt[i]++;
      s.sectorRestoreAt[i]++;
    }
    return;
  }

  let last = -1;
  for (let i = 0; i < SECTOR_COUNT; i++) {
    if (s.sectorFallAt[i] === 0) continue;
    if (last < 0 || s.sectorFallAt[i] > s.sectorFallAt[last]) last = i;
  }

  if (last < 0 || s.tick >= s.sectorRestoreAt[last]) {
    s.sectorFallAt.fill(0);
    s.sectorRestoreAt.fill(0);
    const pick = nextInt(s.rng, Stream.Combat, SECTOR_COUNT);
    const fallAt = s.tick + BOSS.sectorTelegraphTicks;
    s.sectorFallAt[pick] = fallAt;
    s.sectorRestoreAt[pick] = fallAt + BOSS.sectorHoldTicks;
    return;
  }

  // Телеграф ничего не отнимает: сектор ещё пол, а не дыра.
  if (s.tick >= s.sectorFallAt[last]) swallowPlayers(s, last);
}

/**
 * Игрок над провалившимся сектором: минус сердце и выталкивание к центру.
 *
 * Не смерть. Мгновенная гибель от геометрии отнимает у игрока решение, а игра
 * целиком про решения (GDD §8.1). Отсюда же берётся тот самый урон, который
 * DIFFICULTY §6 закладывает в модель живучести: бьёт не удар босса, а пол.
 *
 * Неуязвимого сектор не трогает вовсе — ни сердца, ни толчка: секунда
 * неуязвимости после первого провала это его окно, чтобы уйти, а не повод
 * возить его по арене.
 */
function swallowPlayers(s: SimState, sector: number): void {
  const cx = wheelX(s);
  const cy = wheelY(s);
  const rim = wheelRadius(s);

  for (let p = 0; p < s.playerCount; p++) {
    if ((s.pFlags[p] & EntityFlag.Alive) === 0) continue;
    const dx = sub(s.pX[p], cx);
    const dy = sub(s.pY[p], cy);
    if (length(dx, dy) > rim) continue;
    if (sectorAt(s, s.pX[p], s.pY[p]) !== sector) continue;
    if (!damagePlayer(s, p)) continue;
    tumble(s, p, -dx | 0, -dy | 0);
  }
}

/**
 * Сколько объявленных атак босса накрывает точку.
 *
 * Правила честности распространяются на босса целиком: прыжок шара и
 * проваливающийся сектор занимают слоты объявленных атак наравне с тараном
 * (DIFFICULTY §8). Считается по объявленной ОБЛАСТИ, а не по телу.
 *
 * Живёт здесь, а не в проверке достижимости безопасной точки, по той же
 * причине, по которой геометрия колеса живёт в ядре: инструменты считают
 * поверх состояния, а что именно объявлено — знает только бой.
 */
export function bossThreatsAt(s: SimState, x: Fx, y: Fx): number {
  if (!bossInPlay(s)) return 0;
  let n = 0;

  for (let i = 0; i < MAX_BALLS; i++) {
    if (!s.ballActive[i]) continue;
    if (s.tick < s.ballLandAt[i] - BALL.telegraphTicks) continue;
    const a = sectorAngle(s, s.ballSector[i]);
    const r = sub(wheelRadius(s), BALL.radius);
    const bx = add(wheelX(s), mul(cos(a), r));
    const by = add(wheelY(s), mul(sin(a), r));
    if (within(sub(x, bx), sub(y, by), add(BALL.blastRadius, PLAYER.radius))) n++;
  }

  for (let i = 0; i < SECTOR_COUNT; i++) {
    if (s.sectorFallAt[i] === 0 || s.tick >= s.sectorRestoreAt[i]) continue;
    if (length(sub(x, wheelX(s)), sub(y, wheelY(s))) > wheelRadius(s)) continue;
    if (sectorAt(s, x, y) === i) n++;
  }
  return n;
}

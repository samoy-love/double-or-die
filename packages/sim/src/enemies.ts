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
 */

import {
  clampX,
  clampY,
  isFreeSpot,
  maxX,
  maxY,
  pushOutOfColumns,
  pushedX,
  pushedY,
} from './arena';
import {
  AI_DECISION_PERIOD,
  AI_SEPARATION_SPEED,
  ARENA_PAD,
  AGRO_CAP_PCT,
  AI_TARGET_MEMORY_TICKS,
  BRICK,
  ENEMIES,
  ENEMY_BULLET,
  ENEMY_TYPE_COUNT,
  EnemyPhase,
  EnemyType,
  FAIRNESS,
  FUSE,
  PLAYER,
  WAVE,
  WEDGE,
} from './config';
import { damagePlayer, explode, fireEnemy, killEnemy, statsOf } from './combat';
import { add, type Fx, mul, sub } from './fixed';
import { Stream, nextInt } from './rng';
import { EntityFlag, MAX_ENEMIES, MAX_PLAYERS, MAX_SPAWNS, Meta, type SimState } from './state';
import { length, normalize, normX, normY, within } from './trig';

/** Флаг «новичок» едет в типе отложенного спавна: отдельный массив ради бита избыточен. */
const NOVICE_BIT = 1 << 8;

/**
 * Сколько телеграфов сейчас нацелено на каждого игрока.
 *
 * Модульный буфер, а не массив на вызов: считается каждый тик, а ядру
 * запрещено аллоцировать в горячем пути.
 */
const telegraphs = new Int32Array(MAX_PLAYERS);

/** Сколько врагов сейчас нацелено на каждого игрока — для потолка агро. */
const targeting = new Int32Array(MAX_PLAYERS);

/** Одновременно в воздухе не больше этого числа отложенных спавнов. */
const MAX_PENDING = 8;
/** Метки ставятся не в один тик: вспышка из восьми точек нечитаема. */
const SPAWN_STAGGER = 4;

// ---------------------------------------------------------------------------
// Волны
// ---------------------------------------------------------------------------

/**
 * Бюджет угрозы комнаты: `300 × (1 + 0.08(R−1)) × 2^(F−1) × (1 + 0.8(N−1))`.
 *
 * Этаж в версии 0.2.0 всегда первый — этажи приезжают в 0.4.0, — поэтому
 * множитель `2^(F−1)` равен единице и в формулу не входит. Когда появятся
 * этажи, он добавится здесь, а не в трёх местах.
 */
export function roomBudget(room: number, players: number): number {
  const roomFactor = 100 + WAVE.roomGrowthPct * (room - 1);
  const playerFactor = 100 + WAVE.playerGrowthPct * (players - 1);
  return Math.trunc((WAVE.baseBudget * roomFactor * playerFactor) / 10000);
}

/** Потолок одновременных врагов на экране: ограничитель D9. */
export const onScreenCap = (players: number): number =>
  WAVE.onScreenBase + WAVE.onScreenPerPlayer * (players - 1);

/** Начать комнату с первой волны. */
export function startRoom(s: SimState, room: number): void {
  s.meta[Meta.Room] = room;
  s.meta[Meta.Wave] = 0;
  s.meta[Meta.WaveBudget] = 0;
  s.meta[Meta.RoomStartTick] = s.tick;
  s.meta[Meta.NextWaveAt] = s.tick + WAVE.roomGapTicks;
}

function startWave(s: SimState, wave: number): void {
  const budget = roomBudget(s.meta[Meta.Room], s.playerCount);
  s.meta[Meta.Wave] = wave;
  s.meta[Meta.WaveBudget] = Math.trunc(budget / WAVE.wavesPerRoom);
  s.meta[Meta.NextWaveAt] = 0;
}

const countActive = (flags: Uint8Array): number => {
  let n = 0;
  for (let i = 0; i < flags.length; i++) if (flags[i]) n++;
  return n;
};

/** Есть ли на арене или в очереди враг, которого игрок видит впервые. */
function noviceInPlay(s: SimState): boolean {
  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (s.eActive[i] && (s.eFlags[i] & EntityFlag.Novice) !== 0) return true;
  }
  for (let i = 0; i < MAX_SPAWNS; i++) {
    if (s.spActive[i] && (s.spType[i] & NOVICE_BIT) !== 0) return true;
  }
  return false;
}

/**
 * Выбрать тип для следующего врага.
 *
 * Не больше одного нового типа за две комнаты, и первое появление — всегда в
 * одиночку с растянутым телеграфом. Это и есть весь туториал по врагам:
 * игрок один раз видит Фитиль в упор и понимает, что круг с фитилём взрывается
 * (DIFFICULTY §7).
 */
function pickType(s: SimState, budget: number): number {
  const room = s.meta[Meta.Room];
  let unseen = -1;
  let affordable = 0;

  for (let t = 0; t < ENEMY_TYPE_COUNT; t++) {
    if (ENEMIES[t].unlockRoom > room) continue;
    if ((s.meta[Meta.SeenTypes] & (1 << t)) === 0) {
      if (unseen < 0) unseen = t;
      continue;
    }
    if (ENEMIES[t].threat <= budget) affordable++;
  }

  if (unseen >= 0) return unseen | NOVICE_BIT;
  if (affordable === 0) return -1;

  // Равновероятный выбор среди тех, кто по карману: перекос в сторону
  // дешёвых врагов сделал бы поздние комнаты толпой Фитилей.
  let n = nextInt(s.rng, Stream.Waves, affordable);
  for (let t = 0; t < ENEMY_TYPE_COUNT; t++) {
    if (ENEMIES[t].unlockRoom > room) continue;
    if ((s.meta[Meta.SeenTypes] & (1 << t)) === 0) continue;
    if (ENEMIES[t].threat > budget) continue;
    if (n === 0) return t;
    n--;
  }
  return -1;
}

/**
 * Найти точку спавна не ближе 250 u от каждого игрока и вне колонн.
 *
 * Правило честности из DIFFICULTY §7 и инвариант одновременно: враг,
 * появившийся в упор, отнимает сердце без единого решения игрока, а это ровно
 * та несправедливость, из-за которой игру закрывают.
 */
function findSpawn(s: SimState, radius: Fx): boolean {
  for (let attempt = 0; attempt < 24; attempt++) {
    const x = add(ARENA_PAD, nextInt(s.rng, Stream.Waves, (maxX(s) - ARENA_PAD) >> 16) << 16);
    const y = add(ARENA_PAD, nextInt(s.rng, Stream.Waves, (maxY(s) - ARENA_PAD) >> 16) << 16);
    if (!isFreeSpot(s, x, y, radius)) continue;

    if (tooCloseToPlayers(s, x, y)) continue;

    spawnSpotX = x;
    spawnSpotY = y;
    return true;
  }
  return false;
}

export let spawnSpotX: Fx = 0;
export let spawnSpotY: Fx = 0;

/** Поставить метку будущего спавна. Метка живёт 0.5 с — это её весь смысл. */
function scheduleSpawn(s: SimState, type: number, delay: number): boolean {
  const stats = ENEMIES[type & ~NOVICE_BIT];
  if (!findSpawn(s, stats.radius)) return false;

  for (let i = 0; i < MAX_SPAWNS; i++) {
    if (s.spActive[i]) continue;
    s.spX[i] = spawnSpotX;
    s.spY[i] = spawnSpotY;
    s.spType[i] = type;
    s.spAt[i] = s.tick + FAIRNESS.spawnMarkTicks + delay;
    s.spActive[i] = 1;
    return true;
  }
  return false;
}

/** Поставить врага на арену. Публично: этим пользуются сценарии и отладка. */
export function spawnEnemy(s: SimState, type: EnemyType, x: Fx, y: Fx, novice = false): number {
  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (s.eActive[i]) continue;
    const stats = ENEMIES[type];
    s.eX[i] = x;
    s.eY[i] = y;
    s.eVX[i] = 0;
    s.eVY[i] = 0;
    s.eHP[i] = stats.hp;
    s.eType[i] = type;
    // Кирпич начинает с отката: иначе вся волна Кирпичей стреляет залпом
    // в один тик, и уклоняться не от чего — либо всё, либо ничего.
    const brick = type === EnemyType.Brick;
    s.ePhase[i] = brick ? EnemyPhase.Recover : EnemyPhase.Idle;
    s.ePhaseUntil[i] = brick ? s.tick + stats.recoverTicks : 0;
    s.eTarget[i] = 0;
    s.eTargetUntil[i] = 0;
    s.eDirX[i] = 0;
    s.eDirY[i] = 0;
    s.eFlags[i] = EntityFlag.Alive | (novice ? EntityFlag.Novice : 0);
    s.eActive[i] = 1;
    return i;
  }
  return -1;
}

/** Стоит ли игрок слишком близко к точке: правило 250 u (DIFFICULTY §7). */
function tooCloseToPlayers(s: SimState, x: Fx, y: Fx): boolean {
  for (let p = 0; p < s.playerCount; p++) {
    if ((s.pFlags[p] & EntityFlag.Alive) === 0) continue;
    if (within(sub(x, s.pX[p]), sub(y, s.pY[p]), FAIRNESS.minSpawnDistance)) return true;
  }
  return false;
}

/**
 * Выпустить врагов, чьи метки досидели свой срок.
 *
 * Дистанция проверяется ЗДЕСЬ, а не только при постановке метки. За полсекунды
 * ожидания игрок успевает подойти, и правило «не ближе 250 u» относится к
 * моменту появления, а не к моменту, когда об этом подумал спавнер: враг,
 * возникший в упор, отнимает сердце без единого решения игрока.
 *
 * Подошедшему игроку метка не достаётся: она переезжает на новое честное
 * место и получает полный срок предупреждения заново. Просто ждать нельзя —
 * тогда игрок, встав на метку, бесплатно вычёркивал бы врага из волны.
 */
function releaseSpawns(s: SimState): void {
  for (let i = 0; i < MAX_SPAWNS; i++) {
    if (!s.spActive[i] || s.tick < s.spAt[i]) continue;

    const type = s.spType[i] & ~NOVICE_BIT;
    if (tooCloseToPlayers(s, s.spX[i], s.spY[i])) {
      if (findSpawn(s, ENEMIES[type].radius)) {
        s.spX[i] = spawnSpotX;
        s.spY[i] = spawnSpotY;
        s.spAt[i] = s.tick + FAIRNESS.spawnMarkTicks;
      }
      continue;
    }

    const novice = (s.spType[i] & NOVICE_BIT) !== 0;
    spawnEnemy(s, type as EnemyType, s.spX[i], s.spY[i], novice);
    if (novice) s.meta[Meta.SeenTypes] |= 1 << type;
    s.spActive[i] = 0;
  }
}

/**
 * Ход волн: выпускать врагов струйкой, а не залпом.
 *
 * Залп из семидесяти шести врагов (столько даёт бюджет комнаты вчетвером)
 * нечитаем и упирается в потолок пула, а струйка держит одинаковое давление
 * при любом составе — и именно поэтому длительность комнаты не зависит от
 * числа игроков (DIFFICULTY §5).
 */
function stepWaves(s: SimState): void {
  releaseSpawns(s);
  if (s.meta[Meta.SpawnOff] !== 0) return;

  const alive = countActive(s.eActive);
  const pending = countActive(s.spActive);

  // Пауза между волнами и комнатами.
  if (s.meta[Meta.NextWaveAt] !== 0) {
    if (s.tick < s.meta[Meta.NextWaveAt]) return;
    startWave(s, s.meta[Meta.Wave] + 1);
    return;
  }

  if (s.meta[Meta.WaveBudget] > 0) {
    if (noviceInPlay(s)) return;
    const cap = onScreenCap(s.playerCount);
    for (let n = pending; n < MAX_PENDING && alive + n < cap; n++) {
      const type = pickType(s, s.meta[Meta.WaveBudget]);
      if (type < 0) {
        // Бюджета не хватает даже на самого дешёвого — волна выпущена.
        s.meta[Meta.WaveBudget] = 0;
        break;
      }
      if (!scheduleSpawn(s, type, (n - pending) * SPAWN_STAGGER)) break;
      s.meta[Meta.WaveBudget] -= ENEMIES[type & ~NOVICE_BIT].threat;
      // Врага-новичка выпускаем в одиночку и ждём, пока с ним разберутся.
      if ((type & NOVICE_BIT) !== 0) break;
    }
    return;
  }

  // Волна кончается, только когда арена пуста: «пережил» — это результат,
  // который игрок видит глазами, а не по счётчику.
  if (alive > 0 || pending > 0) return;

  if (s.meta[Meta.Wave] >= WAVE.wavesPerRoom) {
    startRoom(s, s.meta[Meta.Room] + 1);
  } else {
    s.meta[Meta.NextWaveAt] = s.tick + WAVE.waveGapTicks;
  }
}

// ---------------------------------------------------------------------------
// Автоматы
// ---------------------------------------------------------------------------

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

/**
 * Запас, с которым коридор атаки считается накрывающим игрока.
 *
 * Шире хитбокса, и это не осторожность, а суть правила. Потолок в три
 * телеграфа существует, чтобы игроку было куда уйти; коридор, прошедший в
 * двух десятках единиц, урона не наносит, но забирает ровно то место, куда
 * уходить. Считая только прямые попадания, потолок пропускал лишний таран на
 * загнанного в угол игрока — формально мимо, фактически некуда.
 *
 * На урон это число не влияет никак: computeDanger живёт только внутри правил
 * честности, попадания считает contactDamage по настоящим радиусам.
 */
const DANGER_SLACK = 24;

const units = (v: Fx): number => v / 65536;

/**
 * Область, которую накрывает атака врага `i`, если он ударит в направлении
 * (dirX, dirY). Для Фитиля направление не важно — он взрывается на месте.
 */
function computeDanger(s: SimState, i: number, dirX: Fx, dirY: Fx, remaining: number): void {
  const stats = statsOf(s.eType[i]);
  const x = units(s.eX[i]);
  const y = units(s.eY[i]);
  const pr = units(PLAYER.radius) + DANGER_SLACK;

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
function attackRemaining(s: SimState, i: number): number {
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
function countTelegraphs(s: SimState): void {
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
function telegraphTicks(s: SimState, i: number): number {
  const base = statsOf(s.eType[i]).telegraphTicks;
  if ((s.eFlags[i] & EntityFlag.Novice) === 0) return base;
  return Math.trunc((base * FAIRNESS.noviceTelegraphPct) / 100);
}

function countTargeting(s: SimState): number {
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
function retarget(s: SimState, i: number, activeEnemies: number): void {
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

const isAlive = (s: SimState, p: number): boolean =>
  p >= 0 && p < s.playerCount && (s.pFlags[p] & EntityFlag.Alive) !== 0;

/**
 * Можно ли объявлять атаку: потолок в три штуки на игрока (DIFFICULTY §7).
 *
 * Проверяется каждый, кого атака накроет, а не только тот, на кого она
 * нацелена. Иначе враги обходят потолок через соседа: формально целятся в
 * одного, физически перекрывают другого.
 */
function telegraphAllowed(s: SimState, i: number, target: number): boolean {
  normalize(sub(s.pX[target], s.eX[i]), sub(s.pY[target], s.eY[i]));
  if (normX === 0 && normY === 0) return false;
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
function enterTelegraph(s: SimState, i: number): void {
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
      const speed = ENEMIES[EnemyType.Wedge].speed;
      // Подошёл слишком близко — отходит для разгона.
      if (within(dx, dy, WEDGE.minAimRange)) {
        approach(s, i, t, -speed);
        return;
      }
      approach(s, i, t, speed);
      if (!within(dx, dy, WEDGE.aimRange)) return;
      // Проверка идёт последней: она же вычисляет направление удара,
      // которым воспользуется enterTelegraph.
      if (!telegraphAllowed(s, i, t)) return;
      enterTelegraph(s, i);
      return;
    }
    case EnemyPhase.Telegraph: {
      // Стоит и целится: направление уже зафиксировано и больше не меняется.
      // Именно из-за этого уклонение ощущается навыком, а не лотереей.
      brake(s, i);
      if (s.tick < s.ePhaseUntil[i]) return;
      s.ePhase[i] = EnemyPhase.Attack;
      s.ePhaseUntil[i] = s.tick + ENEMIES[EnemyType.Wedge].attackTicks;
      s.eVX[i] = mul(s.eDirX[i], WEDGE.dashSpeed);
      s.eVY[i] = mul(s.eDirY[i], WEDGE.dashSpeed);
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

function approach(s: SimState, i: number, target: number, speed: Fx): void {
  if (!isAlive(s, target)) {
    brake(s, i);
    return;
  }
  normalize(sub(s.pX[target], s.eX[i]), sub(s.pY[target], s.eY[i]));
  s.eVX[i] = mul(normX, speed);
  s.eVY[i] = mul(normY, speed);
}

/** Кирпич держит 420 u и стрейфится перпендикулярно — по этому он и читается. */
function keepDistance(s: SimState, i: number, target: number): void {
  const dx = sub(s.pX[target], s.eX[i]);
  const dy = sub(s.pY[target], s.eY[i]);
  const d = length(dx, dy);
  normalize(dx, dy);
  const nx = normX;
  const ny = normY;

  if (d < BRICK.retreatDistance) {
    s.eVX[i] = mul(nx, -ENEMIES[EnemyType.Brick].speed);
    s.eVY[i] = mul(ny, -ENEMIES[EnemyType.Brick].speed);
    return;
  }
  if (d > BRICK.keepDistance) {
    s.eVX[i] = mul(nx, ENEMIES[EnemyType.Brick].speed);
    s.eVY[i] = mul(ny, ENEMIES[EnemyType.Brick].speed);
    return;
  }
  // Сторона стрейфа берётся из индекса врага, а не из RNG: у соседних
  // Кирпичей она разная, а один и тот же Кирпич не дёргается туда-сюда.
  const dir = (i & 1) === 0 ? 1 : -1;
  s.eVX[i] = mul(-ny * dir, BRICK.strafeSpeed);
  s.eVY[i] = mul(nx * dir, BRICK.strafeSpeed);
}

const brake = (s: SimState, i: number): void => {
  s.eVX[i] = 0;
  s.eVY[i] = 0;
};

/**
 * Мягкое расталкивание: враги не должны слипаться в одну точку.
 *
 * Слипшаяся толпа читается как один враг, простреливается одной пулей и
 * ломает единственное, ради чего враги вообще нужны, — понятную картину боя.
 */
function separate(s: SimState, i: number): void {
  const r = statsOf(s.eType[i]).radius;
  for (let j = 0; j < MAX_ENEMIES; j++) {
    if (j === i || !s.eActive[j]) continue;
    const dx = sub(s.eX[i], s.eX[j]);
    const dy = sub(s.eY[i], s.eY[j]);
    const minDist = add(r, statsOf(s.eType[j]).radius);
    if (!within(dx, dy, minDist)) continue;
    normalize(dx, dy);
    if (normX === 0 && normY === 0) continue;
    s.eVX[i] = add(s.eVX[i], mul(normX, AI_SEPARATION_SPEED));
    s.eVY[i] = add(s.eVY[i], mul(normY, AI_SEPARATION_SPEED));
  }
}

/**
 * Контактный урон: только таран Клина.
 *
 * Фитиль опасен взрывом, а не касанием, — иначе он отнимал бы сердце дважды
 * за одну смерть, и «увернулся от волны» перестало бы что-либо значить.
 * Кирпич не контактный по определению: он держит дистанцию.
 */
function contactDamage(s: SimState, i: number): void {
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
    brake(s, i);
    return;
  }
}

/** Один тик всех врагов и всей системы волн. */
export function stepEnemies(s: SimState): void {
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
    if (!busy && (s.tick + i) % AI_DECISION_PERIOD === 0) retarget(s, i, activeEnemies);

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
    const nx = add(s.eX[i], s.eVX[i]);
    const ny = add(s.eY[i], s.eVY[i]);
    // Клин, влетевший в колонну, теряет рывок: колонна обязана быть укрытием.
    if (s.ePhase[i] === EnemyPhase.Attack && s.eType[i] === EnemyType.Wedge) {
      if (nx !== clampX(s, nx, stats.radius) || ny !== clampY(s, ny, stats.radius)) {
        s.ePhase[i] = EnemyPhase.Recover;
        s.ePhaseUntil[i] = s.tick + stats.recoverTicks;
        brake(s, i);
      }
    }
    pushOutOfColumns(s, nx, ny, stats.radius);
    s.eX[i] = pushedX;
    s.eY[i] = pushedY;

    contactDamage(s, i);
  }

  stepWaves(s);
}

/**
 * Включить или выключить пополнение арены волнами.
 *
 * Выключение не трогает тех, кто уже на арене: «перестать присылать» и
 * «убрать всех» — разные намерения, и путать их в одном вызове значит однажды
 * молча стереть расстановку, ради которой сценарий и писался.
 */
export function setSpawning(s: SimState, on: boolean): void {
  s.meta[Meta.SpawnOff] = on ? 0 : 1;
}

/** Убрать с арены всё, кроме игроков: перезапуск забега и старт комнаты. */
export function clearArena(s: SimState): void {
  s.eActive.fill(0);
  s.bActive.fill(0);
  s.cActive.fill(0);
  s.spActive.fill(0);
}

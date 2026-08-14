/**
 * Спавн и бюджет угрозы: волны, выбор типа врага, честные точки появления.
 *
 * Никаких «умных» решений. Поведение обязано быть предсказуемым, потому что
 * игрок должен учиться, а не угадывать (DIFFICULTY §7) — вся сложность игры
 * покупается ставками, а не непознаваемым ИИ.
 */

import { isFreeSpot, maxX, maxY } from '../arena';
import { clearSettled } from '../bets';
import {
  ARENA_PAD,
  ENEMIES,
  ENEMY_TYPE_COUNT,
  EnemyPhase,
  EnemyType,
  FAIRNESS,
  ROOMS_PER_FLOOR,
  WAVE,
} from '../config';
import { add, type Fx, mul, sub } from '../fixed';
import { Stream, nextInt } from '../rng';
import { Curse, EntityFlag, MAX_ENEMIES, MAX_SPAWNS, Meta, type SimState } from '../state';
import { ANGLE_FULL, cos, sin, within } from '../trig';
import { isAlive } from './targeting';

/**
 * Флаг «новичок» едет в типе отложенного спавна: отдельный массив ради бита
 * избыточен. Число не балансное, а упаковочное, потому и живёт здесь, а не в
 * симуляционном конфиге.
 */
const NOVICE_BIT = 1 << 8;

/**
 * Бюджет угрозы комнаты: `300 × (1 + 0.08(R−1)) × 2^(F−1) × (1 + 0.8(N−1))`
 * (DIFFICULTY §4).
 *
 * Множитель этажа — удвоение, и оно намеренно круглое: его легко держать в
 * голове и легко объяснить, почему третий этаж вчетверо страшнее первого.
 * Комната `R` считается ВНУТРИ этажа, с единицы до восьми: сквозная нумерация
 * по забегу дала бы на первой комнате второго этажа множитель девятой
 * комнаты, то есть двойной рост в одном шаге вместо двух раздельных.
 *
 * Порядок множителей важен для целых чисел: этаж применяется последним и
 * сдвигом, поэтому деление на 10000 не съедает младшие разряды дважды.
 */
/**
 * Множитель роста по комнате — излом, не прямая: пологий участок до
 * `WAVE.roomGrowthKink`, крутой после. Раздельная функция, а не строчка
 * внутри `roomBudget`, потому что излом использует и планировщик здоровья
 * (`startRoom` лечит на первой комнате крутого участка) — считать точку
 * излома в двух местах по-разному значило бы разъехаться молча.
 */
function roomGrowthFactor(room: number): number {
  const kink = WAVE.roomGrowthKink;
  if (room <= kink) return 100 + WAVE.roomGrowthEarlyPct * (room - 1);
  const atKink = 100 + WAVE.roomGrowthEarlyPct * (kink - 1);
  return atKink + WAVE.roomGrowthLatePct * (room - kink);
}

export function roomBudget(room: number, players: number, floor = 1): number {
  const roomFactor = roomGrowthFactor(room);
  const playerFactor = 100 + WAVE.playerGrowthPct * (players - 1);
  const base = Math.trunc((WAVE.baseBudget * roomFactor * playerFactor) / 10000);
  const full = base << (floor - 1);
  /*
   * Самая первая комната забега — не «комната 1 с плоским ростом», а первая
   * секунда знакомства с игрой вообще. Даже на пологом участке кривой она
   * держит семь Клинов на волну (бюджет ~100 ÷ угроза 14), и все семь
   * успевают выйти на арену одним заходом — playtest: «куча врагов,
   * двигающихся одинаково, толпой давят». Тесная орбита (`WEDGE.orbitBands`)
   * и растянутый выход (`WAVE.spawnStaggerTicks`) чинят ЧТЕНИЕ этой семёрки,
   * но не сам факт, что игрок ни разу не встречал Клина и уже дерётся с
   * семью. Скидка — только здесь: у второй комнаты знакомство уже состоялось,
   * а дальше кривая работает как и была задумана.
   */
  return floor === 1 && room === 1 ? Math.trunc((full * WAVE.firstRoomPct) / 100) : full;
}

/**
 * Бюджет боссовой комнаты — половина бюджета восьмой комнаты этажа.
 *
 * Рядовые враги в бою с боссом есть, и запас прочности самого босса в бюджет
 * не входит (DIFFICULTY §8). Причина ставочная, а не боевая: прогресс четырёх
 * из шести стартовых пари считается долей зачищенной угрозы, и нулевой бюджет
 * означал бы, что в боссовой комнате они не двигаются вовсе, а Крупье не
 * приходит с картой ни разу — порог подброса считается оттуда же.
 */
export const bossRoomBudget = (floor: number, players: number): number =>
  Math.trunc(roomBudget(ROOMS_PER_FLOOR, players, floor) / 2);

/** Потолок одновременных врагов на экране: ограничитель D9. */
export const onScreenCap = (players: number): number =>
  WAVE.onScreenBase + WAVE.onScreenPerPlayer * (players - 1);

function startWave(s: SimState, wave: number): void {
  // Первая волна комнаты — конец расчёта: итоги прошлых пари уступают место
  // новым. Между комнатами они жили ровно затем, чтобы их прочитали. Пари,
  // взятое во время расчёта, при этом остаётся: карты новой комнаты лежат
  // уже там, и взятое на них — живое.
  if (wave === 1) clearSettled(s);

  const budget = roomBudget(s.meta[Meta.Room], s.playerCount, s.meta[Meta.Floor]);
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
/**
 * Открыт ли тип врага на этом этаже и в этой комнате.
 *
 * Пара «этаж и комната», а не сквозной номер: комната считается ВНУТРИ этажа,
 * и сравнение по одному числу выпускало бы врага второго этажа ещё на первом.
 * Расписание — DIFFICULTY §7, и правило «не чаще одного нового типа за две
 * комнаты» проверяется тестом по нему, а не по коду.
 */
function unlocked(t: number, floor: number, room: number): boolean {
  const e = ENEMIES[t];
  return floor > e.unlockFloor || (floor === e.unlockFloor && room >= e.unlockRoom);
}

function pickType(s: SimState, budget: number): number {
  const room = s.meta[Meta.Room];
  const floor = s.meta[Meta.Floor];
  let unseen = -1;
  let affordable = 0;

  for (let t = 0; t < ENEMY_TYPE_COUNT; t++) {
    if (!unlocked(t, floor, room)) continue;
    if ((s.meta[Meta.SeenTypes] & (1 << t)) === 0) {
      // Бюджет проверяется и для нового типа. Вызывающий вычитает угрозу
      // безусловно, и знакомство, выданное в кредит, уводило остаток волны в
      // минус — то есть роняло инвариант «бюджет волны ушёл в минус» тем
      // вернее, чем дороже новый враг. Не по карману — подождёт следующей
      // волны: показать его в одиночку всё равно требуется целиком.
      if (unseen < 0 && ENEMIES[t].threat <= budget) unseen = t;
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
    if (!unlocked(t, floor, room)) continue;
    if ((s.meta[Meta.SeenTypes] & (1 << t)) === 0) continue;
    if (ENEMIES[t].threat > budget) continue;
    if (n === 0) return t;
    n--;
  }
  return -1;
}

/** Случайный живой игрок: враги приходят ко всем, а не всегда к первому. */
function randomLivePlayer(s: SimState): number {
  let alive = 0;
  for (let p = 0; p < s.playerCount; p++) if (isAlive(s, p)) alive++;
  if (alive === 0) return -1;

  let n = nextInt(s.rng, Stream.Waves, alive);
  for (let p = 0; p < s.playerCount; p++) {
    if (!isAlive(s, p)) continue;
    if (n === 0) return p;
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
  const anchor = randomLivePlayer(s);

  for (let attempt = 0; attempt < 24; attempt++) {
    let x: Fx;
    let y: Fx;

    if (anchor < 0) {
      // Живых нет — привязываться не к кому, берём точку по всей арене.
      x = add(ARENA_PAD, nextInt(s.rng, Stream.Waves, (maxX(s) - ARENA_PAD) >> 16) << 16);
      y = add(ARENA_PAD, nextInt(s.rng, Stream.Waves, (maxY(s) - ARENA_PAD) >> 16) << 16);
    } else {
      /*
       * Точка берётся ПРЯМО В КОЛЬЦЕ вокруг игрока, а не бросается по всей
       * арене с последующей отбраковкой.
       *
       * Отбраковка работала, пока у правила была только нижняя граница. С
       * верхней годное кольцо занимает малую долю площади, и двадцати четырёх
       * попыток перестало хватать: волна молча не пополнялась, а игрок стоял
       * в пустой комнате — в замере до минуты подряд. Тихий отказ спавнера
       * читается игроком как «игра сломалась», и никакой честностью это не
       * оправдано.
       */
      const angle = nextInt(s.rng, Stream.Waves, ANGLE_FULL);
      const span = (FAIRNESS.maxSpawnDistance - FAIRNESS.minSpawnDistance) >> 16;
      const r = add(FAIRNESS.minSpawnDistance, nextInt(s.rng, Stream.Waves, span) << 16);
      x = add(s.pX[anchor], mul(cos(angle), r));
      y = add(s.pY[anchor], mul(sin(angle), r));
    }

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
    /*
     * Заморозка (GDD §11): помечается ровно один враг за проклятую комнату —
     * тот, что выходит первым на пустую арену первой волны.
     *
     * «Арена ещё пуста» — недостаточное условие само по себе: спавны первой
     * волны разнесены по РАЗНЫМ тикам (`WAVE.spawnStaggerTicks`,
     * `scheduleSpawn`), и если первый помеченный враг гибнет раньше, чем
     * подошёл срок следующего спавна той же волны, `countActive() === 0`
     * снова истинно — и следующий враг тоже получает метку (iter-3 §0-А,
     * подтверждено тестом ниже). Флаг «метка уже выдана в этой комнате»
     * живёт в бите 1 `Meta.CurseRoom` — новый слот `Meta` не заводим
     * (свободных не осталось), а старший бит того же поля свободен: до сих
     * пор оно хранило только 0/1 («не в проклятой комнате» / «в ней»), все
     * читатели уже переведены на проверку младшего бита отдельно.
     */
    const FROZEN_MARK_GIVEN = 2;
    const mark =
      s.meta[Meta.Curse] === Curse.Frozen &&
      (s.meta[Meta.CurseRoom] & 1) === 1 &&
      (s.meta[Meta.CurseRoom] & FROZEN_MARK_GIVEN) === 0 &&
      s.meta[Meta.Wave] === 1 &&
      countActive(s.eActive) === 0;
    if (mark) s.meta[Meta.CurseRoom] |= FROZEN_MARK_GIVEN;
    s.eFlags[i] =
      EntityFlag.Alive | (novice ? EntityFlag.Novice : 0) | (mark ? EntityFlag.Marked : 0);
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
 *
 * Возвращает `true`, когда комната зачищена и пора звать `advanceRoom` — эта
 * функция сама его не вызывает, чтобы не импортировать `progression.ts`:
 * `progression.ts` уже импортирует `roomBudget`/`bossRoomBudget` отсюда, и
 * обратный импорт замкнул бы модули `enemies/*` в цикл (iter-4 ТЗ-19).
 * Вызывающая сторона — `enemies.ts`, которая и так дирижирует полным тиком
 * врагов.
 */
export function stepWaves(s: SimState): boolean {
  releaseSpawns(s);
  if (s.meta[Meta.SpawnOff] !== 0) return false;

  const alive = countActive(s.eActive);
  const pending = countActive(s.spActive);

  // Пауза между волнами и комнатами.
  if (s.meta[Meta.NextWaveAt] !== 0) {
    if (s.tick < s.meta[Meta.NextWaveAt]) return false;
    startWave(s, s.meta[Meta.Wave] + 1);
    return false;
  }

  if (s.meta[Meta.WaveBudget] > 0) {
    if (noviceInPlay(s)) return false;
    const cap = onScreenCap(s.playerCount);
    for (let n = pending; n < WAVE.maxPendingSpawns && alive + n < cap; n++) {
      const type = pickType(s, s.meta[Meta.WaveBudget]);
      if (type < 0) {
        // Бюджета не хватает даже на самого дешёвого — волна выпущена.
        s.meta[Meta.WaveBudget] = 0;
        break;
      }
      if (!scheduleSpawn(s, type, (n - pending) * WAVE.spawnStaggerTicks)) break;
      s.meta[Meta.WaveBudget] -= ENEMIES[type & ~NOVICE_BIT].threat;
      // Врага-новичка выпускаем в одиночку и ждём, пока с ним разберутся.
      if ((type & NOVICE_BIT) !== 0) break;
    }
    return false;
  }

  // Волна кончается, только когда арена пуста: «пережил» — это результат,
  // который игрок видит глазами, а не по счётчику.
  if (alive > 0 || pending > 0) return false;

  if (s.meta[Meta.Wave] >= WAVE.wavesPerRoom) {
    return true;
  }
  s.meta[Meta.NextWaveAt] = s.tick + WAVE.waveGapTicks;
  return false;
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

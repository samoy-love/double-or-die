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

import { isFreeSpot, maxX, maxY, pathBlocked, pushOutOfColumns, pushedX, pushedY } from './arena';
import {
  AI_DECISION_PERIOD,
  AI_SEPARATION_REACH,
  AI_SEPARATION_SPEED,
  ARENA_PAD,
  ARENA_TEMPLATES,
  AGRO_CAP_PCT,
  AI_TARGET_MEMORY_TICKS,
  APPETITE_DEFAULT,
  BRICK,
  ENEMIES,
  ENEMY_BULLET,
  ENEMY_TYPE_COUNT,
  EnemyPhase,
  FLIP_COUNT,
  FLOORS_PER_RUN,
  EnemyType,
  FAIRNESS,
  FUSE,
  PLAYER,
  ROOMS_PER_FLOOR,
  WAVE,
  WEDGE,
  roomGapTicksFor,
} from './config';
import { aceAtSettlement, clearSettled, dealCards, resetAce, settleBets } from './bets';
import { flowTo, flowX, flowY, updateNav } from './nav';
import { offerDoors } from './doors';
import { endRun } from './run';
import { damagePlayer, explode, fireEnemy, killEnemy, statsOf } from './combat';
import { add, type Fx, fromInt, mul, sub } from './fixed';
import { Stream, nextInt } from './rng';
import {
  EntityFlag,
  MAX_ENEMIES,
  MAX_PLAYERS,
  MAX_SPAWNS,
  Meta,
  RunPhase,
  DoorType,
  type SimState,
} from './state';
import { ANGLE_FULL, cos, length, normalize, normX, normY, sin, within } from './trig';

/**
 * Флаг «новичок» едет в типе отложенного спавна: отдельный массив ради бита
 * избыточен. Число не балансное, а упаковочное, потому и живёт здесь, а не в
 * симуляционном конфиге.
 */
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

// ---------------------------------------------------------------------------
// Волны
// ---------------------------------------------------------------------------

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
export function roomBudget(room: number, players: number, floor = 1): number {
  const roomFactor = 100 + WAVE.roomGrowthPct * (room - 1);
  const playerFactor = 100 + WAVE.playerGrowthPct * (players - 1);
  const base = Math.trunc((WAVE.baseBudget * roomFactor * playerFactor) / 10000);
  return base << (floor - 1);
}

/**
 * Бюджет боссовой комнаты — половина бюджета восьмой комнаты этажа.
 *
 * Рядовые враги в бою с боссом есть, и запас прочности самого босса в бюджет
 * не входит (DIFFICULTY §8). Причина ставочная, а не боевая: прогресс четырёх
 * из шести стартовых пари считается долей зачищенной угрозы, и нулевой бюджет
 * означал бы, что в боссовой комнате они не двигаются вовсе, а Туз не
 * приходит с картой ни разу — порог подброса считается оттуда же.
 */
export const bossRoomBudget = (floor: number, players: number): number =>
  Math.trunc(roomBudget(ROOMS_PER_FLOOR, players, floor) / 2);

/** Потолок одновременных врагов на экране: ограничитель D9. */
export const onScreenCap = (players: number): number =>
  WAVE.onScreenBase + WAVE.onScreenPerPlayer * (players - 1);

/**
 * Начать комнату с первой волны.
 *
 * Здесь же — расчёт предыдущей и новая раскладка карт: пари живут внутри боя
 * и начинаются вместе с ним, отдельного экрана ставок нет (GDD §9.1).
 */
export function startRoom(s: SimState, room: number): void {
  /*
   * Порядок здесь несущий: Туз, расчёт, раздача.
   *
   * Сначала сбрасывается Туз — новая комната начинается с чистого бюджета
   * выходов и без чужого жеста. Потом он выходит принимать расчёт, и только
   * потом идёт сам расчёт: жесты, которые тот породит, попадают в уже стоящее
   * тело. Обратный порядок стоил дефекта — раздача, шедшая последней, стирала
   * присутствие и оставляла жест, а это запрещённое инвариантом состояние.
   */
  resetAce(s);
  aceAtSettlement(s);

  // Расчёт прошлой комнаты, но БЕЗ очистки слотов: пока идёт пауза, игрок
  // смотрит на результаты — выигранное золотится, проигранное показывает,
  // насколько не хватило. Слоты освобождаются, когда начинается бой.
  settleBets(s);

  // Дошёл до новой комнаты — серия смертей прервана, и Тузу снова можно
  // шутить: правило дозировки защищает от добивания, а не запрещает юмор.
  if (room > 1) s.meta[Meta.DeathStreak] = 0;

  /*
   * Аппетит сбрасывается только в первой комнате этажа.
   *
   * Раньше сброс стоял здесь безусловно, и это было верно: экрана двери не
   * существовало, защёлка в бою его заменяла, и «новая комната — новое
   * решение» означало «сбросить на старте комнаты». С приходом двери выбор
   * делается ДО комнаты, и тот же сброс стирал его в тот же тик — игрок
   * выбирал «По-крупному» и входил в бой со «Скромно».
   *
   * Теперь сброс живёт там, где открывается экран (`offerDoors`), а сюда
   * попадает только случай, у которого двери нет вовсе: первая комната этажа.
   */
  if (room === 1) s.pAppetite.fill(APPETITE_DEFAULT);

  /*
   * Новая комната — новая арена.
   *
   * Шаблон и его отражение берутся из потока `layout`, объявленного ещё в
   * 0.1.0 и до сих пор не работавшего: расстановка колонн была единственной
   * константой на всю игру. Отдельный поток обязателен — правка любой другой
   * системы иначе сдвинула бы раскладку арен, и дейли перестали бы
   * воспроизводиться между версиями (TECH §2.3).
   *
   * Два обращения, а не одно: шаблон и отражение — независимые решения, и
   * упаковка их в одно число `t * 4 + f` связала бы соседние шаблоны с
   * соседними отражениями на любом сдвиге потока.
   */
  s.meta[Meta.Template] = nextInt(s.rng, Stream.Layout, ARENA_TEMPLATES.length);
  s.meta[Meta.Flip] = nextInt(s.rng, Stream.Layout, FLIP_COUNT);

  /*
   * Тип комнаты приходит с выбранной двери.
   *
   * До первой двери (комната 1 каждого этажа) выбора не было — игрок только
   * что вошёл на этаж, — и комната обычная. Гарантия «Лавка не позже пятой»
   * считается по этому же полю, поэтому запоминать её надо здесь, а не на
   * экране двери: подтверждение и начало комнаты разнесены по тикам.
   */
  const pick = s.meta[Meta.DoorPick];
  s.meta[Meta.RoomType] = room > 1 && pick >= 0 ? s.doorType[pick] : DoorType.Fight;
  s.meta[Meta.DoorPick] = -1;
  if (s.meta[Meta.RoomType] === DoorType.Shop) s.meta[Meta.LastShopRoom] = room;
  if (room === 1) s.meta[Meta.LastShopRoom] = 0;

  s.meta[Meta.Room] = room;
  s.meta[Meta.Wave] = 0;
  s.meta[Meta.WaveBudget] = 0;
  s.meta[Meta.RoomStartTick] = s.tick;
  // Перед первой комнатой расчёта не было, и пять секунд экрана итогов
  // выродились бы в пять секунд пустоты. Развилка живёт в конфиге: её знает
  // ещё и пропуск расчёта.
  s.meta[Meta.NextWaveAt] = s.tick + roomGapTicksFor(room);

  // Бюджет комнаты целиком — знаменатель прогресса удержаний. Считается один
  // раз при входе: волны берут из него, а пари меряют по нему пройденный путь.
  s.meta[Meta.RoomThreat] = roomBudget(room, s.playerCount, s.meta[Meta.Floor]);
  s.meta[Meta.ThreatCleared] = 0;
  dealCards(s);
}

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
    return;
  }

  // Волна кончается, только когда арена пуста: «пережил» — это результат,
  // который игрок видит глазами, а не по счётчику.
  if (alive > 0 || pending > 0) return;

  if (s.meta[Meta.Wave] >= WAVE.wavesPerRoom) {
    advanceRoom(s);
  } else {
    s.meta[Meta.NextWaveAt] = s.tick + WAVE.waveGapTicks;
  }
}

/**
 * Комната зачищена: дальше следующая, босс, следующий этаж или конец забега.
 *
 * До 0.4.0 здесь стоял безусловный `startRoom(room + 1)`, и забег был
 * бесконечным счётчиком комнат: ни этажа, ни конца, ни победы. Ворота версии
 * требуют забега на 12–18 минут — то есть чего-то, что кончается.
 *
 * Босс стоит между восьмой комнатой и концом этажа (GDD §8.1), и шов с ним
 * здесь ровно один — признак «бой с боссом идёт». Сам бой живёт в `boss.ts`,
 * и импорта оттуда тут нет намеренно: волны зовут эту функцию, а босс зовёт
 * волны, — встречный импорт замкнул бы модули в цикл.
 */
function advanceRoom(s: SimState): void {
  if (s.meta[Meta.Phase] === RunPhase.Summary) return;
  // Пока босс жив, комнату не кончает даже пустая арена: волны в боссовой
  // комнате идут наравне с ним, а конец ей ставит его смерть.
  if (s.meta[Meta.Phase] === RunPhase.Boss && s.meta[Meta.BossMaxHP] !== 0) return;

  if (s.meta[Meta.Room] < ROOMS_PER_FLOOR) {
    /*
     * Между комнатами встаёт экран двери, а не следующая комната сразу.
     *
     * Он ждёт игрока, а не часов, поэтому здесь только предложение: сама
     * комната начнётся, когда выбор подтвердят (`stepDoors` → `enterDoor`).
     */
    offerDoors(s);
    return;
  }
  if (s.meta[Meta.Phase] !== RunPhase.Boss) {
    // Восьмая комната кончилась — выходит босс. Комната остаётся восьмой: у
    // боссовой свой бюджет угрозы, половина восьмой (DIFFICULTY §8).
    s.meta[Meta.Phase] = RunPhase.Boss;
    startRoom(s, ROOMS_PER_FLOOR);
    s.meta[Meta.RoomThreat] = bossRoomBudget(s.meta[Meta.Floor], s.playerCount);
    return;
  }

  s.meta[Meta.Phase] = RunPhase.Fight;
  if (s.meta[Meta.Floor] < FLOORS_PER_RUN) {
    s.meta[Meta.Floor]++;
    startRoom(s, 1);
    return;
  }
  endRun(s, true);
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
function orbit(s: SimState, i: number, dx: Fx, dy: Fx): void {
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

  // Радиальная составляющая держит свою полосу, тангенциальная ведёт по кругу.
  const closing = distance > preferred ? ENEMIES[EnemyType.Wedge].speed : -WEDGE.orbitSpeed;
  s.eVX[i] = add(mul(towardX, closing), mul(-towardY * side, WEDGE.orbitSpeed));
  s.eVY[i] = add(mul(towardY, closing), mul(towardX * side, WEDGE.orbitSpeed));
}

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
function approach(s: SimState, i: number, target: number, speed: Fx): void {
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

  s.eVX[i] = mul(dirX, speed);
  s.eVY[i] = mul(dirY, speed);
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

/** Сдвинулось ли тело заметно меньше, чем намеревалось. */
function blocked(fromX: Fx, fromY: Fx, toX: Fx, toY: Fx, vx: Fx, vy: Fx): boolean {
  const wantX = units(vx);
  const wantY = units(vy);
  const want = wantX * wantX + wantY * wantY;
  if (want === 0) return false;
  const gotX = units(sub(toX, fromX));
  const gotY = units(sub(toY, fromY));
  const fraction = FAIRNESS.blockedFraction;
  return gotX * gotX + gotY * gotY < want * fraction * fraction;
}

/** Убрать с арены всё, кроме игроков: перезапуск забега и старт комнаты. */
export function clearArena(s: SimState): void {
  s.eActive.fill(0);
  s.bActive.fill(0);
  s.cActive.fill(0);
  s.spActive.fill(0);
  // Карты — тоже арена. Сценарий про подбор кладёт свою карту в известную
  // точку, и раскладка начала забега, оставшаяся лежать, превращает счёт
  // карт в счёт чужих карт.
  s.kActive.fill(0);
  // Шары и провалы колеса — тоже арена, и уезжают вместе с ней. Сектор,
  // оставшийся проваленным после боссовой комнаты, вырезал бы дыру в обычной,
  // где никакого колеса нет вовсе.
  s.ballActive.fill(0);
  s.sectorFallAt.fill(0);
  s.sectorRestoreAt.fill(0);
}

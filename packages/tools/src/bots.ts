/**
 * Боты — не искусственный интеллект, а явно заданные стратегии для проверки
 * систем. `idle` доказывает, что игра не зависает сама по себе; `random` ищет
 * состояния, до которых человек не додумается.
 *
 * Боты живут в инструментах, а не в ядре: они порождают ввод, а не логику.
 *
 * Главное решение файла — **две независимые оси** (SIMULATION §3). Навык
 * отвечает за руки: точность прицела, долю времени со стрельбой, качество
 * уклонения и рывок. Стратегия отвечает за деньги: сколько карт брать, каким
 * тиром и когда соскакивать. Оси разведены потому, что половина порогов
 * ограничителей задана через профили игрока (ECONOMY §6), а профили эти
 * отличаются друг от друга ОБЕИМИ величинами сразу: наглый и мастер играют
 * одну и ту же стратегию с разным навыком, и разница между ними — это и есть
 * разница между «+160 за этаж» и «+330». Бот, который целится точно и жмёт
 * огонь постоянно, меряет сверхмастера при любой стратегии, то есть не меряет
 * ни один из четырёх профилей.
 */

import {
  type InputFrame,
  type SimState,
  ANGLE_FULL,
  BetState,
  Btn,
  EnemyPhase,
  EnemyType,
  PLAYER,
  Stream,
  aceCardAt,
  add,
  cos,
  createStreams,
  fromFloat,
  fromInt,
  makeFrame,
  mul,
  nextInt,
  normX,
  normY,
  normalize,
  sin,
  sub,
  withAppetite,
  MAX_ACTIVE_BETS,
  MAX_CARDS,
  Meta,
  RunPhase,
  MAX_CHIPS,
  MAX_ENEMIES,
  SHARED,
  toFloat,
  type RngState,
} from '@dod/sim';

/**
 * Тир аппетита «По-крупному».
 *
 * Через `withAppetite`, а не битом `Btn.AppetiteHi`: два бита кодируют тир СО
 * СДВИГОМ на единицу, потому что четвёртое значение обязано означать «игрок
 * сейчас молчит» (`appetiteOf` в `input.ts`). Старший бит в одиночку читается
 * как тир 1, то есть «Нормально», — и жадный бот, объявлявший себя наглым
 * профилем, ставил половину заявленного кона. Замер тем и ловится: кон 25 там,
 * где ECONOMY §6 считает 50.
 */
const TIER_GO_BIG = 2;

/**
 * Ось навыка (SIMULATION §3). Опорный профиль — `median`: из его 0.75 и 0.5
 * посчитан реальный урон 25 HP/с, от которого выведена вся сложность
 * (DIFFICULTY §1).
 */
export const SKILL_NAMES = ['novice', 'median', 'veteran', 'master'] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

interface Skill {
  /** Доля выстрелов, идущих точно в цель, в процентах. */
  readonly aimPct: number;
  /** Доля времени с зажатым курком, в процентах. */
  readonly firePct: number;
  /**
   * Качество уклонения, в процентах. Им же задана и доля использования рывка.
   *
   * Отдельного числа под рывок в документах нет, и выдумывать второе
   * независимое значение незачем: уклонение и рывок — одно умение, а рывок
   * ещё и главный инструмент выживания (ECONOMY §5). Появится замер по живым
   * игрокам (0.11.0) — разъедутся два числа, а не одно превратится в два.
   */
  readonly dodgePct: number;
}

const SKILLS: Record<SkillName, Skill> = {
  novice: { aimPct: 60, firePct: 35, dodgePct: 30 },
  median: { aimPct: 75, firePct: 50, dodgePct: 50 },
  veteran: { aimPct: 85, firePct: 60, dodgePct: 70 },
  master: { aimPct: 93, firePct: 70, dodgePct: 85 },
};

/**
 * Ось стратегии ставок. Соответствие профилям игрока из ECONOMY §6:
 * `none` — осторожный (ноль ставок), `single` — умеренный (одно пари за
 * комнату, кон 25), `stack` — наглый (стак, кон 50, не обналичивает),
 * `chips` — тот же стак плюс погоня за фишками на полу.
 *
 * Четвёртая стратегия заведена не для симметрии. ECONOMY §4 держит разрыв
 * между «одна фишка за комнату у того, кто за ними не ходит» и целевыми
 * четырьмя — это цена жадности, и калибруется она ботом, который за фишками
 * ходит. Без него дроп настраивается вслепую.
 */
export const STRATEGY_NAMES = ['none', 'single', 'stack', 'chips'] as const;
export type StrategyName = (typeof STRATEGY_NAMES)[number];

interface Strategy {
  /** Сколько пари бот держит одновременно. Ноль — не берёт карт вовсе. */
  readonly maxBets: number;
  /** Тир аппетита: 0 «Скромно», 1 «Нормально», 2 «По-крупному». */
  readonly tier: number;
  /** Обналичивать ли, потеряв сердце. */
  readonly cashOutOnHurt: boolean;
  /** Ходить ли за фишками, лежащими на полу. */
  readonly chaseChips: boolean;
}

const STRATEGIES: Record<StrategyName, Strategy> = {
  none: { maxBets: 0, tier: 0, cashOutOnHurt: false, chaseChips: false },
  single: { maxBets: 1, tier: 1, cashOutOnHurt: true, chaseChips: false },
  stack: { maxBets: MAX_ACTIVE_BETS, tier: TIER_GO_BIG, cashOutOnHurt: false, chaseChips: false },
  chips: { maxBets: MAX_ACTIVE_BETS, tier: TIER_GO_BIG, cashOutOnHurt: false, chaseChips: true },
};

/**
 * Прежние имена, названные в DEVLOOP §3. Остаются как есть: на них записан
 * корпус golden-эталонов и ссылаются проверки версий 0.1.0–0.3.0.
 */
export const LEGACY_BOT_NAMES = ['idle', 'random', 'greedy', 'cautious'] as const;
export type LegacyBotName = (typeof LEGACY_BOT_NAMES)[number];

/** Профиль — пара «навык:стратегия», например `master:stack`. */
export type ProfileName = `${SkillName}:${StrategyName}`;

/**
 * Известные профили. Список экспортируется, а не живёт только в типе: разбор
 * аргументов обязан назвать варианты в сообщении об ошибке, а тип во время
 * выполнения не существует. Опечатка в `--bot`, молча упавшая в `idle`, —
 * это прогон, который ничего не проверил и об этом не сказал.
 */
export const PROFILE_NAMES: readonly ProfileName[] = SKILL_NAMES.flatMap((sk) =>
  STRATEGY_NAMES.map((st): ProfileName => `${sk}:${st}`),
);

export const BOT_NAMES = [...LEGACY_BOT_NAMES, 'mixed', ...PROFILE_NAMES] as const;

export type BotName = LegacyBotName | 'mixed' | ProfileName;

export const isBotName = (s: string): s is BotName => (BOT_NAMES as readonly string[]).includes(s);

export interface Bot {
  /**
   * Чем этот бот оказался на самом деле: `median:single`, `greedy`, …
   *
   * Не то же самое, что имя в `--bot`: у смеси имя одно на прогон, а профиль
   * свой на каждый забег, и отчёт обязан называть второе. Ограничители
   * ECONOMY §13 считаются ПО ПРОФИЛЯМ (G3 про играющего на ставках, G5 про
   * наглого, G4 про опытных), и прогон, не сказавший, кем он сыгран, для них
   * бесполезен.
   */
  readonly profile: string;
  inputs(s: SimState): readonly InputFrame[];
}

class IdleBot implements Bot {
  readonly profile = 'idle';
  private readonly frames: InputFrame[];
  constructor(players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
  }
  inputs(): readonly InputFrame[] {
    return this.frames;
  }
}

class RandomBot implements Bot {
  readonly profile = 'random';
  private readonly frames: InputFrame[];
  private readonly rng: RngState;

  constructor(seed: number, players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
    // Отдельный от симуляции генератор: ввод бота — это внешний источник,
    // и он не должен сдвигать потоки самой игры.
    this.rng = createStreams(seed ^ 0x5eed);
  }

  inputs(s: SimState): readonly InputFrame[] {
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      // Меняем направление не каждый тик: иначе бот дрожит на месте и
      // не доходит до краёв арены, где и живут интересные баги.
      if (s.tick % 20 === 0) {
        f.moveX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.moveY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.aimX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.aimY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
      }
      // Кнопки тоже держатся, а не дёргаются каждый тик. Причин две.
      // Живой игрок удерживает огонь, и лог, где кнопка меняется 60 раз в
      // секунду, не похож ни на один настоящий забег. А ещё именно на нём
      // ломается RLE-сжатие реплея: повторов не остаётся вовсе, и эталон
      // раздувается с десятков килобайт до сотен.
      if (s.tick % 10 === 0) {
        f.buttons = 0;
        if (nextInt(this.rng, Stream.Waves, 100) < 40) f.buttons |= Btn.Fire;
        if (nextInt(this.rng, Stream.Waves, 100) < 3) f.buttons |= Btn.Dash;
      }
    }
    return this.frames;
  }
}

// ---------------------------------------------------------------------------
// Поиск целей: общий для всех ботов, которые куда-то идут
// ---------------------------------------------------------------------------

/**
 * Результат поиска отдаётся модульными переменными, а не объектом.
 *
 * Так же, как `normalize` в ядре, и по той же причине: поиск зовётся по
 * несколько раз за тик на каждого игрока, а возвращать пару чисел объектом —
 * значит класть в кучу по объекту на каждый вызов. Ядру аллокации запрещены
 * вовсе, инструментам — нет, но тысяча забегов по 54 000 тиков это тот
 * масштаб, на котором привычка видна в секундомере.
 */
let foundDX = 0;
let foundDY = 0;
let foundDist = Infinity;

/** Ближайшая доступная игроку карта: своя персональная или общая. */
function findCard(s: SimState, player: number, px: number, py: number): void {
  foundDist = Infinity;
  for (let c = 0; c < MAX_CARDS; c++) {
    if (!s.kActive[c]) continue;
    if (s.kOwner[c] !== SHARED && s.kOwner[c] !== player) continue;
    const dx = toFloat(s.kX[c]) - px;
    const dy = toFloat(s.kY[c]) - py;
    const d = Math.hypot(dx, dy);
    if (d < foundDist) {
      foundDist = d;
      foundDX = dx;
      foundDY = dy;
    }
  }
}

/** Ближайший живой враг. Целится в него любой бот, который вообще стреляет. */
function findEnemy(s: SimState, px: number, py: number): void {
  foundDist = Infinity;
  for (let e = 0; e < MAX_ENEMIES; e++) {
    if (!s.eActive[e]) continue;
    const dx = toFloat(s.eX[e]) - px;
    const dy = toFloat(s.eY[e]) - py;
    const d = Math.hypot(dx, dy);
    if (d < foundDist) {
      foundDist = d;
      foundDX = dx;
      foundDY = dy;
    }
  }
}

/** Ближайшая фишка на полу. Её ищет только жадный до денег профиль. */
function findChip(s: SimState, px: number, py: number): void {
  foundDist = Infinity;
  for (let c = 0; c < MAX_CHIPS; c++) {
    if (!s.cActive[c]) continue;
    const dx = toFloat(s.cX[c]) - px;
    const dy = toFloat(s.cY[c]) - py;
    const d = Math.hypot(dx, dy);
    if (d < foundDist) {
      foundDist = d;
      foundDX = dx;
      foundDY = dy;
    }
  }
}

/**
 * Ближайшая ОБЪЯВЛЕННАЯ угроза, от которой имеет смысл уходить.
 *
 * Именно объявленная, а не любой враг рядом: неозвученных угроз в игре нет по
 * определению (DIFFICULTY §7), и уклонение от того, что ещё не объявлено, —
 * это не навык, а суета. Считается по тем же трём источникам урона, которые
 * существуют в 0.4.0: таран Клина, поджёгший фитиль Фитиль и летящий снаряд
 * Кирпича (последний ловится через сам Кирпич — снаряд летит вдвое медленнее
 * игрокового именно затем, чтобы от него уходили).
 */
function findThreat(s: SimState, px: number, py: number): void {
  foundDist = Infinity;
  for (let e = 0; e < MAX_ENEMIES; e++) {
    if (!s.eActive[e]) continue;
    const phase = s.ePhase[e];
    const type = s.eType[e];
    const announced =
      (type === EnemyType.Wedge &&
        (phase === EnemyPhase.Telegraph || phase === EnemyPhase.Attack)) ||
      (type === EnemyType.Fuse && phase === EnemyPhase.Telegraph) ||
      (type === EnemyType.Brick && phase === EnemyPhase.Telegraph);
    if (!announced) continue;
    const dx = toFloat(s.eX[e]) - px;
    const dy = toFloat(s.eY[e]) - py;
    const d = Math.hypot(dx, dy);
    if (d < foundDist) {
      foundDist = d;
      foundDX = dx;
      foundDY = dy;
    }
  }
}

/**
 * Жадный (`наглый` из SIMULATION §3): собирает все карты, играет «По-крупному»,
 * не обналичивает никогда.
 *
 * Это не «умный игрок», а явно заданная стратегия — верхняя граница ставочного
 * поведения. Ею проверяется, что экономика не разваливается от максимального
 * стака: кон списывается за каждую карту, и упереться в пустой кошелёк такой
 * бот обязан сам, без запретов в коде.
 *
 * Руки у него по-прежнему идеальные — целится точно и жмёт огонь постоянно.
 * Это не профиль игрока, а верхняя граница, и для неё так и надо; мерить
 * профили ECONOMY §6 нужно парами «навык:стратегия», где навык задан явно.
 */
class GreedyBot implements Bot {
  readonly profile = 'greedy';
  private readonly frames: InputFrame[];
  private readonly rng: RngState;

  constructor(seed: number, players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
    this.rng = createStreams(seed ^ 0x9eed);
  }

  inputs(s: SimState): readonly InputFrame[] {
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      const px = toFloat(s.pX[i]);
      const py = toFloat(s.pY[i]);

      // Идём к ближайшей доступной карте: карта — это место, и весь смысл
      // жадности в том, чтобы за ней бежать.
      findCard(s, i, px, py);
      const best = foundDist;
      const cx = foundDX;
      const cy = foundDY;

      // Аппетит выставляется каждый тик, а не однажды на старте. Ядро
      // применяет его защёлкой — по ненулевым битам, и держит до следующего
      // явного нажатия, — но полагаться на то, что защёлка переживёт смену
      // комнаты или барьер старта, бот не имеет права: он объявляет свой тир
      // сам и постоянно.
      f.buttons = withAppetite(Btn.Fire, TIER_GO_BIG);
      if (best < Infinity) {
        const len = best || 1;
        f.moveX = fromFloat(cx / len);
        f.moveY = fromFloat(cy / len);
        // Кнопку жмём по фронту: подбор дискретен, и держать её бессмысленно.
        if (best < 60 && s.tick % 4 === 0) f.buttons |= Btn.Take;
      } else if (s.tick % 30 === 0) {
        f.moveX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.moveY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
      }

      // Целимся в ближайшего врага: жадный не пацифист.
      findEnemy(s, px, py);
      const near = foundDist;
      const ex = near === Infinity ? 1 : foundDX;
      const ey = near === Infinity ? 0 : foundDY;
      const elen = near === Infinity ? 1 : near || 1;
      f.aimX = fromFloat(ex / elen);
      f.aimY = fromFloat(ey / elen);
    }
    return this.frames;
  }
}

/**
 * Осторожный (`осторожный` из SIMULATION §3): одна ближняя карта, тир
 * «Скромно», обналичивает рано.
 *
 * Заведён ради ограничителя G14 — доля пари, закрытых через «Забрать», обязана
 * лежать в коридоре 15–35% (ECONOMY §13). Проверить его было нечем: `idle` и
 * `random` карт не берут осмысленно, а `greedy` не обналичивает никогда, и
 * доля выходила ровно нулевой при любом балансе. Ограничитель, который
 * невозможно нарушить, не ограничивает ничего.
 *
 * Тир «Скромно» — нулевой, то есть пустые биты аппетита. Это не «бот забыл
 * нажать»: нулевой тир в маске неотличим от «не нажимал», и такова маска
 * (TECH §6). Ядро трактует пустые биты как «оставить как есть», а исходное
 * состояние и есть «Скромно», — профиль сходится. Появись когда-нибудь
 * ненулевой тир по умолчанию, здесь понадобится явное нажатие, и маске
 * придётся научиться отличать одно от другого.
 */
class CautiousBot implements Bot {
  readonly profile = 'cautious';
  private readonly frames: InputFrame[];
  private readonly rng: RngState;

  /** Тик, после которого пари считается «подержанным достаточно». */
  private static readonly HOLD_TICKS = 150;

  constructor(seed: number, players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
    this.rng = createStreams(seed ^ 0xcafe);
  }

  /** Сколько пари сейчас держит игрок и когда взято самое старое. */
  private static bets(s: SimState, player: number): { count: number; oldest: number } {
    let count = 0;
    let oldest = Infinity;
    for (let n = 0; n < MAX_ACTIVE_BETS; n++) {
      const k = player * MAX_ACTIVE_BETS + n;
      if (s.aState[k] !== BetState.Active) continue;
      count++;
      if (s.aTakenAt[k] < oldest) oldest = s.aTakenAt[k];
    }
    return { count, oldest };
  }

  inputs(s: SimState): readonly InputFrame[] {
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      const px = toFloat(s.pX[i]);
      const py = toFloat(s.pY[i]);
      const { count, oldest } = CautiousBot.bets(s, i);

      f.buttons = Btn.Fire;

      // Одна карта за раз: держать стак осторожный не станет. За второй он
      // не идёт вовсе, поэтому и путь в опасную зону не выбирает.
      let cx = 0;
      let cy = 0;
      let best = Infinity;
      if (count === 0) {
        findCard(s, i, px, py);
        best = foundDist;
        cx = foundDX;
        cy = foundDY;
      }

      if (best < Infinity) {
        const len = best || 1;
        f.moveX = fromFloat(cx / len);
        f.moveY = fromFloat(cy / len);
        if (best < 60 && s.tick % 4 === 0) f.buttons |= Btn.Take;
      } else if (s.tick % 30 === 0) {
        f.moveX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.moveY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
      }

      // «Рано» — это до того, как прогресс успел вырасти: осторожный берёт
      // синицу. Кнопка дискретна, поэтому жмём по фронту, а не удержанием.
      if (count > 0 && s.tick - oldest >= CautiousBot.HOLD_TICKS && s.tick % 6 === 0) {
        f.buttons |= Btn.CashOut;
      }

      // Целимся в ближайшего врага: осторожный — не пацифист, он просто не
      // жадный.
      findEnemy(s, px, py);
      const near = foundDist;
      const ex = near === Infinity ? 1 : foundDX;
      const ey = near === Infinity ? 0 : foundDY;
      const elen = near === Infinity ? 1 : near || 1;
      f.aimX = fromFloat(ex / elen);
      f.aimY = fromFloat(ey / elen);
    }
    return this.frames;
  }
}

// ---------------------------------------------------------------------------
// Профильный бот: навык × стратегия
// ---------------------------------------------------------------------------

/**
 * Как часто бот принимает решения: раз в 10 тиков, то есть 6 Гц.
 *
 * Та же частота, что у врагов (DIFFICULTY §7), и выбрана она не за компанию.
 * Решение, пересматриваемое каждый тик, даёт ввод, меняющийся 60 раз в
 * секунду: он не похож ни на один живой забег и ломает RLE-сжатие реплея —
 * повторов не остаётся вовсе, и эталон раздувается с десятков килобайт до
 * сотен. Заодно частота задаёт зернистость доли стрельбы: 0.5 — это
 * полсекунды с зажатым курком и полсекунды без, а не мерцание.
 */
const DECIDE_EVERY = 10;

/**
 * Разброс промаха: ±10°.
 *
 * Числа в документах нет, и оно выводится, а не назначается. Враг радиусом 20
 * плюс радиус пули 6 на типичной дистанции боя в 400 единиц занимает около
 * трёх градусов; промах обязан быть промахом, а не «почти попал», поэтому
 * конус втрое шире — на 400 единицах пуля уходит мимо на 70. Обратная сторона
 * названа прямо: в упор (ближе ~150 единиц) промахнуться этим механизмом
 * нельзя, и доля попаданий у бота растёт вблизи так же, как у человека.
 */
const MISS_CONE = Math.round((10 * ANGLE_FULL) / 360);

/**
 * С какого расстояния бот вообще думает уходить от объявленной угрозы.
 *
 * Выведено из Фитиля: он поджигает фитиль на 120 и взрывается радиусом 140
 * (DIFFICULTY §7), то есть на 260 единицах угроза ещё достаёт того, кто стоит
 * на месте. Всё, что дальше, — не уклонение, а бегство от арены.
 */
const DODGE_RANGE = 260;

class ProfileBot implements Bot {
  readonly profile: string;
  private readonly frames: InputFrame[];
  private readonly rng: RngState;
  private readonly skill: Skill;
  private readonly strategy: Strategy;

  /** Решения, принятые на текущее окно: держатся все DECIDE_EVERY тиков. */
  private readonly firing: Uint8Array;
  private readonly evading: Uint8Array;
  private readonly dashing: Uint8Array;
  private readonly aimError: Int32Array;

  /** Сердец в прошлом тике: по их убыли `single` решает соскочить. */
  private readonly hearts: Int32Array;
  private readonly bailing: Uint8Array;

  constructor(skill: SkillName, strategy: StrategyName, seed: number, players: number) {
    this.profile = `${skill}:${strategy}`;
    this.skill = SKILLS[skill];
    this.strategy = STRATEGIES[strategy];
    this.frames = Array.from({ length: players }, makeFrame);
    // Свой генератор, и он же разный у разных профилей: два профиля на одном
    // сиде обязаны отличаться поведением, а не только числами в таблице.
    const salt = (SKILL_NAMES.indexOf(skill) << 8) ^ (STRATEGY_NAMES.indexOf(strategy) << 12);
    this.rng = createStreams(seed ^ 0xb07 ^ salt);
    this.firing = new Uint8Array(players);
    this.evading = new Uint8Array(players);
    this.dashing = new Uint8Array(players);
    this.aimError = new Int32Array(players);
    this.hearts = new Int32Array(players);
    this.bailing = new Uint8Array(players);
    this.hearts.fill(PLAYER.startHearts);
  }

  /** Бросок на сотню: `pct` процентов за «да». */
  private roll(pct: number): boolean {
    return nextInt(this.rng, Stream.Waves, 100) < pct;
  }

  /** Сколько пари сейчас держит игрок. */
  private static activeBets(s: SimState, player: number): number {
    let count = 0;
    for (let n = 0; n < MAX_ACTIVE_BETS; n++) {
      if (s.aState[player * MAX_ACTIVE_BETS + n] === BetState.Active) count++;
    }
    return count;
  }

  private decide(player: number): void {
    this.firing[player] = this.roll(this.skill.firePct) ? 1 : 0;
    this.evading[player] = this.roll(this.skill.dodgePct) ? 1 : 0;
    this.dashing[player] = this.roll(this.skill.dodgePct) ? 1 : 0;
    // Точность — это доля выстрелов, идущих точно: остальные уходят в конус.
    // Ошибка держится всё окно, а не пересчитывается каждый тик, иначе она
    // усредняется в ноль и точность перестаёт значить что-либо.
    this.aimError[player] = this.roll(this.skill.aimPct)
      ? 0
      : nextInt(this.rng, Stream.Waves, MISS_CONE * 2 + 1) - MISS_CONE;
  }

  inputs(s: SimState): readonly InputFrame[] {
    for (let i = 0; i < this.frames.length; i++) {
      if (s.tick % DECIDE_EVERY === 0) this.decide(i);

      const f = this.frames[i];
      const px = toFloat(s.pX[i]);
      const py = toFloat(s.pY[i]);
      const held = ProfileBot.activeBets(s, i);

      // Аппетит объявляется каждый тик: защёлка ядра держит его до следующего
      // явного нажатия, но переживёт ли она смену комнаты — не дело бота.
      f.buttons = withAppetite(this.firing[i] ? Btn.Fire : 0, this.strategy.tier);

      // Потерянное сердце — повод соскочить у умеренного профиля: «обналичивает
      // при потере сердца» (SIMULATION §3). Флаг, а не мгновенное нажатие,
      // потому что кнопка дискретна и жать её надо по фронту.
      if (s.pHearts[i] < this.hearts[i] && this.strategy.cashOutOnHurt) this.bailing[i] = 1;
      this.hearts[i] = s.pHearts[i];
      if (held === 0) this.bailing[i] = 0;
      if (this.bailing[i] && s.tick % 6 === 0) f.buttons |= Btn.CashOut;

      /*
       * Ставка Туза: решение принимает СТРАТЕГИЯ, а не случай.
       *
       * Без этого ограничитель G12 нечем считать: механика есть, а согласиться
       * на неё в Monte-Carlo некому, и отчёт показывал бы ноль ставок Туза за
       * тысячу забегов — то есть «ожидание в коридоре» по пустой выборке.
       *
       * Играющий на ставках принимает: ожидание для него положительное
       * (ECONOMY §10А), и отказ был бы игрой хуже собственного профиля. Тот,
       * кто карт не берёт вовсе (`none`), отказывается — иначе «осторожный»
       * оказался бы игроком, который не рискует, но ставку у Туза берёт.
       */
      if (held < MAX_ACTIVE_BETS && aceCardAt(s) >= 0 && s.tick % 4 === 0) {
        f.buttons |= this.strategy.maxBets > 0 ? Btn.Confirm : Btn.Cancel;
      }

      this.move(s, i, f, px, py, held);
      this.aim(s, i, f, px, py);
    }
    return this.frames;
  }

  /**
   * Куда идти. Приоритет один и тот же у всех профилей, меняются только
   * пороги: сначала спасать шкуру, потом брать деньги, потом собирать сдачу.
   */
  private move(s: SimState, i: number, f: InputFrame, px: number, py: number, held: number): void {
    if (this.evading[i]) {
      findThreat(s, px, py);
      if (foundDist < DODGE_RANGE) {
        const len = foundDist || 1;
        // Уходим ОТ угрозы: знак минус — это и есть всё уклонение.
        f.moveX = fromFloat(-foundDX / len);
        f.moveY = fromFloat(-foundDY / len);
        // Рывок — часть уклонения, а не отдельная кнопка: он и неуязвимость
        // даёт, и дистанцию рвёт. Кулдаун проверяем сами, чтобы не жать
        // впустую и не срывать «Без рывка» лишний раз.
        if (this.dashing[i] && s.tick >= s.pDashReady[i]) f.buttons |= Btn.Dash;
        return;
      }
    }

    if (held < this.strategy.maxBets) {
      findCard(s, i, px, py);
      if (foundDist < Infinity) {
        const len = foundDist || 1;
        f.moveX = fromFloat(foundDX / len);
        f.moveY = fromFloat(foundDY / len);
        if (foundDist < 60 && s.tick % 4 === 0) f.buttons |= Btn.Take;
        return;
      }
    }

    if (this.strategy.chaseChips) {
      findChip(s, px, py);
      if (foundDist < Infinity) {
        const len = foundDist || 1;
        f.moveX = fromFloat(foundDX / len);
        f.moveY = fromFloat(foundDY / len);
        return;
      }
    }

    // Идти некуда — бродим. Не стоим: неподвижная мишень не проверяет ни
    // навигацию врагов, ни спавн, ни достижимость безопасной точки.
    if (s.tick % 30 === 0) {
      f.moveX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
      f.moveY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
    }
  }

  /**
   * Куда целиться. Ближайший враг плюс ошибка навыка, повёрнутая в
   * фиксированной точке: тригонометрия берётся из таблиц ядра, а не из
   * `Math`, — IEEE-синус не обязан совпадать между движками, а ввод бота
   * уезжает в golden-эталоны.
   */
  private aim(s: SimState, i: number, f: InputFrame, px: number, py: number): void {
    findEnemy(s, px, py);
    if (foundDist === Infinity) {
      f.aimX = fromInt(1);
      f.aimY = 0;
      return;
    }

    normalize(fromFloat(foundDX), fromFloat(foundDY));
    let dx = normX;
    let dy = normY;

    const err = this.aimError[i];
    if (err !== 0) {
      const c = cos(err & (ANGLE_FULL - 1));
      const sn = sin(err & (ANGLE_FULL - 1));
      const rx = sub(mul(dx, c), mul(dy, sn));
      const ry = add(mul(dx, sn), mul(dy, c));
      dx = rx;
      dy = ry;
    }

    f.aimX = dx;
    f.aimY = dy;
  }
}

// ---------------------------------------------------------------------------
// Смесь профилей
// ---------------------------------------------------------------------------

/**
 * Доли профилей в смеси, в процентах. Сумма каждой оси — ровно сто.
 *
 * Чисел этих в документах не было: ECONOMY §6 описывает четыре профиля, но не
 * говорит, сколько кого за столом. Они записаны здесь и продублированы в
 * SIMULATION §3 как гипотеза о плейтест-аудитории — та самая, которую
 * телеметрия 0.11.0 заменит фактом (SIMULATION §7). Смысл долей:
 *
 *   — навык центрирован на медианном, потому что от него посчитана вся
 *     сложность; мастер редок — это верхушка таблиц, а не средний игрок;
 *   — стратегия `none` в смесь НЕ входит вовсе, и это не забывчивость. G6
 *     требует, чтобы забегов с нулём взятых пари было меньше 5%, а `none`
 *     не берёт их никогда: любая заметная доля такого профиля валила бы
 *     ограничитель составом смеси, а не балансом игры. Трус прогоняется
 *     отдельным `--bot novice:none`, ради G6 он и заведён.
 */
const SKILL_MIX: readonly (readonly [SkillName, number])[] = [
  ['novice', 25],
  ['median', 40],
  ['veteran', 25],
  ['master', 10],
];

const STRATEGY_MIX: readonly (readonly [StrategyName, number])[] = [
  ['single', 45],
  ['stack', 35],
  ['chips', 20],
];

function pick<T>(mix: readonly (readonly [T, number])[], roll: number): T {
  let acc = 0;
  for (const [name, weight] of mix) {
    acc += weight;
    if (roll < acc) return name;
  }
  return mix[mix.length - 1][0];
}

/**
 * Профиль смеси для сида. Чистая функция: один сид — один профиль, всегда.
 *
 * Смесь разыгрывается НА ЗАБЕГ, а не на тик и не на игрока: `--runs 1000
 * --bot mixed` — это тысяча разных людей за одним столом по очереди, и
 * ограничители считаются по тому, кем сыгран каждый забег. Розыгрыш на каждом
 * тике дал бы одного шизофреника вместо тысячи игроков.
 */
export function mixedProfile(seed: number): ProfileName {
  const rng = createStreams(seed ^ 0xb1e5);
  const skill = pick(SKILL_MIX, nextInt(rng, Stream.Waves, 100));
  const strategy = pick(STRATEGY_MIX, nextInt(rng, Stream.Waves, 100));
  return `${skill}:${strategy}`;
}

export function makeBot(name: BotName, seed: number, players: number): Bot {
  const bot = makeRawBot(name, seed, players);
  // Экран двери проходится одинаково всеми, поэтому обёрнут здесь один раз, а
  // не продублирован в шести реализациях `inputs`. Профиль пробрасывается как
  // есть: обёртка не меняет того, кем сыгран забег, а отчёт спрашивает именно
  // это.
  return { profile: bot.profile, inputs: (s) => passDoors(s, bot.inputs(s)) };
}

function makeRawBot(name: BotName, seed: number, players: number): Bot {
  switch (name) {
    case 'greedy':
      return new GreedyBot(seed, players);
    case 'cautious':
      return new CautiousBot(seed, players);
    case 'random':
      return new RandomBot(seed, players);
    case 'idle':
      return new IdleBot(players);
    case 'mixed': {
      const [skill, strategy] = mixedProfile(seed).split(':') as [SkillName, StrategyName];
      return new ProfileBot(skill, strategy, seed, players);
    }
    default: {
      const [skill, strategy] = name.split(':') as [SkillName, StrategyName];
      return new ProfileBot(skill, strategy, seed, players);
    }
  }
}

/**
 * Экран двери: бот обязан его пройти, иначе headless-прогон встаёт навсегда.
 *
 * Дверь ждёт игрока, а не часов — это несущее правило экрана (UX §3), и
 * менять его ради ботов нельзя: дверь, закрывающаяся сама, превращает выбор
 * в реакцию. Значит проходить её должен тот, кто изображает игрока.
 *
 * Обёртка общая на всех ботов, а не метод в каждом: экран одинаков для всех,
 * а забыть его в одном из шести означало бы зависший прогон ровно на том
 * профиле, которым реже пользуются. Первый же `npm run safety` после дверей
 * висел бы пять тысяч тиков молча.
 *
 * Выбор двери — предмет СТРАТЕГИИ, и здесь он намеренно простейший: фокус
 * ставится на первую дверь и подтверждается. Осмысленный выбор («жадный идёт
 * в Лавку, осторожный в обычный бой») приедет вместе с абстрактной моделью,
 * которой он и нужен; до неё любая эвристика была бы выдумкой, влияющей на
 * все балансные замеры.
 */
export function passDoors(s: SimState, frames: readonly InputFrame[]): readonly InputFrame[] {
  if (s.meta[Meta.Phase] !== RunPhase.Door) return frames;

  const out = frames.map((f) => ({ ...f }));
  // Фокус ставится нажатием вправо, подтверждение — следующим кадром: оба
  // действия читаются по фронту, и слить их в один кадр нельзя.
  out[0].buttons |= s.meta[Meta.DoorPick] < 0 ? Btn.NavRight : Btn.Confirm;
  return out;
}

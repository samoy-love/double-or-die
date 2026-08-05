/**
 * Сценарии — записанные проверки поведения, которые читаются человеком.
 *
 * Сценарий отвечает на вопрос «что игра делает», а golden-реплей — на вопрос
 * «делает ли она это ровно так же, как вчера». Первое ловит неверное
 * поведение, второе — изменившееся; ни одно не заменяет другое.
 *
 * Формат намеренно скучный JSON без выражений и условий: сценарий обязан
 * читаться как протокол, а не исполняться как программа. Всё, чего нельзя
 * выразить парой «подать ввод — прошагать — проверить», пишется юнит-тестом.
 *
 * Структура сценария проверяется СТРОГО, до запуска (см. «Схема» ниже).
 * Опечатка в имени поля ожидания — худший дефект тестовой оснастки из
 * возможных: `"heart"` вместо `"hearts"` не проверяет ничего и при этом
 * зеленеет, то есть выдаёт отсутствие проверки за пройденную. Поэтому
 * неизвестный ключ шага, неизвестное поле ожидания, неизвестное имя врага или
 * пари и неверный тип значения — это отказ разбора с указанием файла, номера
 * шага, самого имени и ближайшего известного.
 */

import {
  ACE,
  BETS,
  BetState,
  Btn,
  CARD,
  aceCardAt,
  aceStakeFor,
  FX_ONE,
  MAX_ACTIVE_BETS,
  MAX_CARDS,
  MAX_PLAYERS,
  SHARED,
  cashOut,
  cashOutValue,
  createState,
  dealCards,
  dropChip,
  explode,
  nearMissOf,
  putCard,
  progressOf,
  settleBets,
  takeBet,
  EnemyPhase,
  EnemyType,
  EntityFlag,
  MAX_CHIPS,
  MAX_ENEMIES,
  MAX_BULLETS,
  MAX_BALLS,
  Meta,
  ROOMS_PER_FLOOR,
  RunPhase,
  SECTOR_COUNT,
  SHOP_SLOTS,
  UPGRADES,
  FLOORS_PER_RUN,
  grantUpgrade,
  hasUpgrade,
  openShop,
  upgradeCount,
  bossRoomBudget,
  bossStunned,
  clearArena,
  counterBetRunning,
  damageBoss,
  fromFloat,
  hashHex,
  type InputFrame,
  layAceCard,
  makeFrame,
  setSpawning,
  startBoss,
  type SimState,
  spawnEnemy,
  spawnPlayers,
  step,
  toFloat,
  redZoneX,
  redZoneY,
} from '@dod/sim';

/** Враги по именам: номер типа в сценарии читается не лучше маски кнопок. */
const ENEMY_TYPES: Record<string, EnemyType> = {
  wedge: EnemyType.Wedge,
  brick: EnemyType.Brick,
  fuse: EnemyType.Fuse,
  клин: EnemyType.Wedge,
  кирпич: EnemyType.Brick,
  фитиль: EnemyType.Fuse,
};

/** Фазы автомата по именам — сценарий читается как протокол, а не как код. */
const PHASES: Record<string, EnemyPhase> = {
  idle: EnemyPhase.Idle,
  telegraph: EnemyPhase.Telegraph,
  attack: EnemyPhase.Attack,
  recover: EnemyPhase.Recover,
};

/** Кнопки по именам: маска в сценарии нечитаема и потому запрещена. */
const BUTTONS: Record<string, Btn> = {
  fire: Btn.Fire,
  dash: Btn.Dash,
  take: Btn.Take,
  cashout: Btn.CashOut,
  inspect: Btn.Inspect,
  accept: Btn.Accept,
  decline: Btn.Decline,
  revive: Btn.Revive,
  ping: Btn.Ping,
  /** Экранные: ими водят фокус, принимают и отказываются на двери и в лавке. */
  navleft: Btn.NavLeft,
  navright: Btn.NavRight,
  confirm: Btn.Confirm,
  cancel: Btn.Cancel,
};

/** Состояния пари по именам: число в протоколе не читается. */
const BET_STATES: Record<string, BetState> = {
  none: BetState.None,
  active: BetState.Active,
  won: BetState.Won,
  lost: BetState.Lost,
  cashed: BetState.Cashed,
};

/**
 * Тиры аппетита по именам (ECONOMY §7).
 *
 * «2» в протоколе не значит ничего, а «по-крупному» значит ровно то, что
 * написано, — и меняется вместе с таблицей конов, не требуя правки сценария.
 */
const APPETITE_TIERS: Record<string, number> = {
  скромно: 0,
  нормально: 1,
  'по-крупному': 2,
  modest: 0,
  normal: 1,
  big: 2,
};

/** Владелец карты: общая, именная или его собственная. */
const CARD_OWNERS: Record<string, number> = {
  shared: SHARED,
  общая: SHARED,
  ace: ACE,
  туз: ACE,
  player0: 0,
  player1: 1,
  player2: 2,
  player3: 3,
};

/** Границы величины. Обе стороны необязательны: часто важна только одна. */
export interface Range {
  min?: number;
  max?: number;
}

/** Состояние конкретного врага по порядковому номеру среди живых. */
export interface EnemyExpectation {
  index?: number;
  hp?: Range;
  x?: Range;
  y?: Range;
  /** Имя фазы автомата: idle / telegraph / attack / recover. */
  phase?: string;
}

/**
 * Карты, лежащие на арене.
 *
 * Раскладка — несущее правило (GDD §9.1), и проверять её надо именно так:
 * сколько всего, сколько общих и сколько именных приходится КАЖДОМУ. Проверка
 * «карт три» пропустила бы стол, где все три достались одному.
 */
export interface CardsExpectation {
  /** Сколько карт лежит на арене всего. */
  total?: Range;
  /** Сколько из них общих. */
  shared?: Range;
  /** Сколько персональных у каждого игрока: проверяется по всем сразу. */
  perPlayer?: Range;
  /** Идентификатор пари, о карте которого идёт речь. */
  id?: string;
  /** Владелец названной карты: «shared» или «player0»…«player3». */
  owner?: string;
}

/**
 * Пари: сколько активных, что с конкретным и как далеко зашёл прогресс.
 *
 * Прогресс в процентах, а не в Q16.16: сценарий читается человеком, и
 * «65536» в нём не значит ничего.
 */
export interface BetsExpectation {
  active?: Range;
  cardsOnArena?: Range;
  /** Идентификатор пари из content/bets.json: «no_damage» и прочие. */
  id?: string;
  /** Состояние названного пари: none / active / won / lost / cashed. */
  state?: string;
  progressPct?: Range;
  /** Насколько не хватило сорванному, в процентах. */
  nearMissPct?: Range;
  /** Счётчик счётчикового пари: сколько уже сделано. */
  counter?: Range;
  /** Сколько заплатит «Забрать» прямо сейчас — не нажимая кнопки. */
  cashOut?: Range;
  /** Счётчики забега: взято, выиграно, проиграно, обналичено. */
  taken?: Range;
  won?: Range;
  lost?: Range;
  cashed?: Range;
}

/**
 * Босс: полоса прочности, фаза, колесо и встречная ставка.
 *
 * Проценты, а не очки: запас прочности растёт с составом и с этажом, и
 * сценарий, записанный в очках, проверял бы соло-число, а не переход фазы.
 */
export interface BossExpectation {
  /** Запас прочности в процентах от потолка. */
  hpPct?: Range;
  /** Номер фазы, 1..3. Ноль — боя нет. */
  phase?: Range;
  /** Шаров на арене. */
  balls?: Range;
  /** Провалившихся секторов: их бывает не больше одного. */
  fallenSectors?: Range;
  /** Идёт ли встречная ставка прямо сейчас. */
  counterBet?: boolean;
  /** Оглушён ли босс. */
  stunned?: boolean;
  /** Побеждённых боссов за забег. */
  beaten?: Range;
}

/**
 * Ставка Туза: висит ли предложение, на сколько и сколько ему уже отдано.
 *
 * Кон проверяется числом, а не формулой: формула живёт в одном месте
 * (`aceStakeFor`), и сценарий, повторяющий её, зеленел бы вместе с ошибкой в
 * ней. Здесь записан ОТВЕТ — «на первом этаже при кошельке в сто это 25», — и
 * правка формулы обязана этот ответ уронить.
 */
export interface AceExpectation {
  /** Лежит ли его карта: предложение висит и ждёт решения. */
  offer?: boolean;
  /** Его кон: по принятой ставке, а пока она не принята — по предложению. */
  stake?: Range;
  /** Отдано Тузу за забег. */
  paid?: Range;
}

/**
 * Лавка: что лежит на прилавке, почём и что из этого куплено.
 *
 * Цена проверяется числом, а не формулой: формула живёт в одном месте
 * (`priceOf`), и сценарий, повторяющий её, зеленел бы вместе с ошибкой в ней.
 * Здесь записан ОТВЕТ — «на третьем этаже ценник от 67 до 135», — и правка
 * формулы обязана этот ответ уронить.
 */
export interface ShopExpectation {
  /** Сколько товаров лежит на прилавке. */
  offers?: Range;
  /** Сколько апгрейдов уже у игрока. */
  owned?: Range;
  /** Идентификатор апгрейда, о котором идёт речь. */
  id?: string;
  /** Лежит ли названный на прилавке. */
  onSale?: boolean;
  /** Есть ли названный у игрока. */
  bought?: boolean;
  /** Цена: названного, а без `id` — каждого выложенного. */
  price?: Range;
}

export interface Expectation {
  player?: number;
  /** Сколько врагов на арене. */
  enemies?: Range;
  /** Сколько снарядов в воздухе. */
  bullets?: Range;
  /** Сколько фишек лежит на полу. */
  chipsOnFloor?: Range;
  /** Убито врагов за забег. */
  kills?: Range;
  enemy?: EnemyExpectation;
  cards?: CardsExpectation;
  x?: Range;
  y?: Range;
  /** Пройденное расстояние от точки появления. */
  travelled?: Range;
  hearts?: Range;
  chips?: Range;
  alive?: boolean;
  invulnerable?: boolean;
  /** Хеш состояния целиком: точная привязка к моменту. */
  hash?: string;
  bets?: BetsExpectation;
  boss?: BossExpectation;
  ace?: AceExpectation;
  shop?: ShopExpectation;
}

export type Step =
  | {
      input: {
        player?: number;
        move?: [number, number];
        aim?: [number, number];
        buttons?: string[];
      };
    }
  | { clearInput: { player?: number } }
  | { tick: number }
  /** Поставить игрока в точку — чтобы не описывать дорогу до неё вводом. */
  | { place: { player?: number; x?: number; y?: number; redZone?: boolean } }
  /** Поставить врага. Имя типа, а не номер: номер в протоколе нечитаем. */
  | { spawn: { type: string; x: number; y: number; count?: number } }
  /** Положить карту пари на арену. Владелец по умолчанию — общая. */
  | { card: { id: string; x: number; y: number; player?: number } }
  /**
   * Взять пари напрямую, минуя карту.
   *
   * Не дубль подбора, а другой предмет проверки: подбор — это про кнопку и
   * дистанцию, а условия пари надо проверять, не тратя половину сценария на
   * дорогу до карты.
   */
  | { bet: { id: string; player?: number; stake?: number } }
  /** Выдать фишек: без кона пари не взять, а зарабатывать его — не предмет. */
  | { chips: { player?: number; amount: number } }
  /** Аппетит именем тира: он задаёт кон при подборе карты. */
  | { appetite: { player?: number; tier: string } }
  /** Уронить фишку в точке: «Собери все фишки» проверяется именно фишкой. */
  | { dropChip: { x: number; y: number } }
  /** Взорвать в точке — ударная волна Фитиля для «Подрывника». */
  | { explode: { x: number; y: number } }
  /** Забрать пари сейчас: «Забрать» проверяется формулой, а не кнопкой. */
  | { cashOut: { id: string; player?: number } }
  /** Разложить карты так же, как это делает начало комнаты. */
  | { deal: true }
  /**
   * Открыть лавку: то же, что делает конец боя за дверью «Лавка».
   *
   * Не обход правил забега, а другой предмет проверки: то, что лавка стоит
   * именно за своей дверью, проверяется тестом на раскладку комнат, а торговля
   * — этим шагом, без похода через восемь комнат до неё.
   */
  | { shop: true }
  /**
   * Выдать апгрейд напрямую, не беря денег.
   *
   * Эффект в бою и покупка — разные предметы: проверять первый через второй
   * значит писать сценарий про кошелёк там, где спрашивают про радиус подбора.
   */
  | { upgrade: { id: string; player?: number } }
  /** Перевести забег на названный этаж: цены и плата считаются от него. */
  | { floor: number }
  /**
   * Туз выкладывает свою карту.
   *
   * Названным пари, а не тем, что выпадет: расписание выходов проверяется
   * своим тестом, а сценарий про выплату обязан знать, какое условие он
   * играет, иначе проверяет удачу броска.
   */
  | { aceBet: { id: string } }
  /** Провести расчёт комнаты: выигранное платит, оставшееся проваливается. */
  | { settle: true }
  /** Убрать с арены всё, кроме игроков. */
  | { clear: true }
  /**
   * Вывести босса: восьмая комната кончилась.
   *
   * Не дубль обычного хода забега, а способ начать проверку с боя, а не с
   * двадцати четырёх комнат до него.
   */
  | { boss: true }
  /**
   * Снять с босса прочности напрямую.
   *
   * Пороги фаз — это проценты запаса, и добираться до них стрельбой значило бы
   * писать сценарий про меткость, а не про фазы.
   */
  | { damageBoss: { amount: number } }
  | { expect: Expectation };

export interface Scenario {
  name: string;
  seed?: number;
  players?: number;
  /**
   * Пополнять ли арену волнами. По умолчанию НЕТ.
   *
   * Сценарий проверяет одно названное поведение, и набежавшая волна делает его
   * проверкой чего-то другого: «рывок покрывает втрое больше ходьбы» перестаёт
   * быть про рывок, стоит на пути оказаться Клину. Кому нужны волны — тот
   * просит их явно.
   */
  waves?: boolean;
  steps: Step[];
}

export interface ScenarioResult {
  name: string;
  ok: boolean;
  ticks: number;
  hash: string;
  failures: string[];
}

// ---------------------------------------------------------------------------
// Схема: структура сценария проверяется до запуска
// ---------------------------------------------------------------------------

/**
 * Узел схемы.
 *
 * Схема нарочно маленькая и без зависимостей: она описывает JSON, который сама
 * же и разбирает, и вся её ценность в том, что список полей ОДИН. Ниже она
 * прибита к типам `Step` и `Expectation` аннотациями `Record<keyof …>` — новое
 * поле в типе без записи в схеме не соберётся, лишнее в схеме тоже.
 */
type Node =
  | { t: 'number' }
  | { t: 'int'; min?: number | undefined; max?: number | undefined }
  | { t: 'string' }
  | { t: 'bool' }
  | { t: 'true' }
  | { t: 'vec2' }
  | { t: 'enum'; values: readonly string[] }
  | { t: 'enumList'; values: readonly string[] }
  | { t: 'obj'; fields: Record<string, Node>; need?: readonly string[] | undefined };

const num = (): Node => ({ t: 'number' });
const int = (min?: number, max?: number): Node => ({ t: 'int', min, max });
const str = (): Node => ({ t: 'string' });
const bool = (): Node => ({ t: 'bool' });
const TRUE: Node = { t: 'true' };
const vec2 = (): Node => ({ t: 'vec2' });
const oneOf = (values: Record<string, unknown>): Node => ({
  t: 'enum',
  values: Object.keys(values),
});
const listOf = (values: Record<string, unknown>): Node => ({
  t: 'enumList',
  values: Object.keys(values),
});
const obj = (fields: Record<string, Node>, need?: readonly string[]): Node => ({
  t: 'obj',
  fields,
  need,
});

/** Границы величины: те же две стороны, что и в `Range`. */
const RANGE: Node = obj({ min: num(), max: num() });

/** Номер игрока: состав больше четырёх не бывает, и опечатка в нём — ошибка. */
const PLAYER_IDX = (): Node => int(0, MAX_PLAYERS - 1);

/** Пари называются идентификаторами из каталога: опечатка обязана валить разбор. */
const BET_IDS: readonly string[] = BETS.map((b) => b.id);
const BET_ID: Node = { t: 'enum', values: BET_IDS };

const ENEMY_FIELDS: Record<keyof EnemyExpectation, Node> = {
  index: int(0, MAX_ENEMIES - 1),
  hp: RANGE,
  x: RANGE,
  y: RANGE,
  phase: oneOf(PHASES),
};

const CARDS_FIELDS: Record<keyof CardsExpectation, Node> = {
  total: RANGE,
  shared: RANGE,
  perPlayer: RANGE,
  id: BET_ID,
  owner: oneOf(CARD_OWNERS),
};

const BETS_FIELDS: Record<keyof BetsExpectation, Node> = {
  active: RANGE,
  cardsOnArena: RANGE,
  id: BET_ID,
  state: oneOf(BET_STATES),
  progressPct: RANGE,
  nearMissPct: RANGE,
  counter: RANGE,
  cashOut: RANGE,
  taken: RANGE,
  won: RANGE,
  lost: RANGE,
  cashed: RANGE,
};

const BOSS_FIELDS: Record<keyof BossExpectation, Node> = {
  hpPct: RANGE,
  phase: RANGE,
  balls: RANGE,
  fallenSectors: RANGE,
  counterBet: bool(),
  stunned: bool(),
  beaten: RANGE,
};

const ACE_FIELDS: Record<keyof AceExpectation, Node> = {
  offer: bool(),
  stake: RANGE,
  paid: RANGE,
};

/** Апгрейды называются идентификаторами каталога: опечатка обязана валить разбор. */
const UPGRADE_IDS: readonly string[] = UPGRADES.map((u) => u.id);
const UPGRADE_ID: Node = { t: 'enum', values: UPGRADE_IDS };

const SHOP_FIELDS: Record<keyof ShopExpectation, Node> = {
  offers: RANGE,
  owned: RANGE,
  id: UPGRADE_ID,
  onSale: bool(),
  bought: bool(),
  price: RANGE,
};

const EXPECT_FIELDS: Record<keyof Expectation, Node> = {
  player: PLAYER_IDX(),
  enemies: RANGE,
  bullets: RANGE,
  chipsOnFloor: RANGE,
  kills: RANGE,
  enemy: obj(ENEMY_FIELDS),
  cards: obj(CARDS_FIELDS),
  x: RANGE,
  y: RANGE,
  travelled: RANGE,
  hearts: RANGE,
  chips: RANGE,
  alive: bool(),
  invulnerable: bool(),
  hash: str(),
  bets: obj(BETS_FIELDS),
  boss: obj(BOSS_FIELDS),
  ace: obj(ACE_FIELDS),
  shop: obj(SHOP_FIELDS),
};

/** Ключи всех вариантов шага: по одному на вариант объединения. */
type KeysOf<T> = T extends unknown ? keyof T : never;
type StepKey = KeysOf<Step>;

const STEP_SCHEMA: Record<StepKey, Node> = {
  input: obj({
    player: PLAYER_IDX(),
    move: vec2(),
    aim: vec2(),
    buttons: listOf(BUTTONS),
  }),
  clearInput: obj({ player: PLAYER_IDX() }),
  tick: int(0, 1_000_000),
  place: obj({ player: PLAYER_IDX(), x: num(), y: num(), redZone: bool() }, []),
  spawn: obj({ type: oneOf(ENEMY_TYPES), x: num(), y: num(), count: int(1, MAX_ENEMIES) }, [
    'type',
    'x',
    'y',
  ]),
  card: obj({ id: BET_ID, x: num(), y: num(), player: PLAYER_IDX() }, ['id', 'x', 'y']),
  bet: obj({ id: BET_ID, player: PLAYER_IDX(), stake: int(0) }, ['id']),
  chips: obj({ player: PLAYER_IDX(), amount: int(0) }, ['amount']),
  appetite: obj({ player: PLAYER_IDX(), tier: oneOf(APPETITE_TIERS) }, ['tier']),
  dropChip: obj({ x: num(), y: num() }, ['x', 'y']),
  explode: obj({ x: num(), y: num() }, ['x', 'y']),
  cashOut: obj({ id: BET_ID, player: PLAYER_IDX() }, ['id']),
  deal: TRUE,
  shop: TRUE,
  upgrade: obj({ id: UPGRADE_ID, player: PLAYER_IDX() }, ['id']),
  floor: int(1, FLOORS_PER_RUN),
  aceBet: obj({ id: BET_ID }, ['id']),
  settle: TRUE,
  clear: TRUE,
  boss: TRUE,
  damageBoss: obj({ amount: int(0) }, ['amount']),
  expect: obj(EXPECT_FIELDS),
};

const SCENARIO_FIELDS: Record<keyof Scenario, Node> = {
  name: str(),
  seed: int(0, 2 ** 31 - 1),
  players: int(1, MAX_PLAYERS),
  waves: bool(),
  // Шаги разбираются отдельно: в сообщении обязан стоять их номер, а общий
  // обход про номера ничего не знает.
  steps: obj({}),
};

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'список';
  if (typeof v === 'number') return 'число';
  if (typeof v === 'string') return 'строка';
  if (typeof v === 'boolean') return 'логическое';
  return typeof v;
}

/** Расстояние Левенштейна: словарь маленький, простого алгоритма достаточно. */
function distance(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/**
 * Подсказка по ближайшему известному имени.
 *
 * Ради неё строгая проверка и затевалась: «неизвестное поле heart» экономит
 * минуту, «возможно, hearts» — экономит поход в исходники.
 */
function hint(word: string, known: readonly string[]): string {
  let best = '';
  let bestD = 3;
  for (const k of known) {
    const d = distance(word.toLowerCase(), k.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  if (best) return ` — возможно, «${best}»`;
  return known.length <= 12 ? ` (известны: ${known.join(', ')})` : '';
}

function fail(where: string, msg: string): never {
  throw new Error(`${where}: ${msg}`);
}

function checkNode(v: unknown, n: Node, path: string, where: string): void {
  switch (n.t) {
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        fail(where, `${path}: нужно число, а не ${typeName(v)}`);
      }
      return;
    case 'int':
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        fail(where, `${path}: нужно целое, а не ${typeName(v)}`);
      }
      if (n.min !== undefined && v < n.min) fail(where, `${path}: ${v} меньше ${n.min}`);
      if (n.max !== undefined && v > n.max) fail(where, `${path}: ${v} больше ${n.max}`);
      return;
    case 'string':
      if (typeof v !== 'string' || v === '') {
        fail(where, `${path}: нужна непустая строка, а не ${typeName(v)}`);
      }
      return;
    case 'bool':
      if (typeof v !== 'boolean') fail(where, `${path}: нужно true или false, а не ${typeName(v)}`);
      return;
    case 'true':
      if (v !== true) fail(where, `${path}: значение обязано быть true`);
      return;
    case 'vec2':
      if (
        !Array.isArray(v) ||
        v.length !== 2 ||
        v.some((c) => typeof c !== 'number' || !Number.isFinite(c))
      ) {
        fail(where, `${path}: нужна пара чисел [x, y]`);
      }
      return;
    case 'enum':
      if (typeof v !== 'string') fail(where, `${path}: нужно имя, а не ${typeName(v)}`);
      if (!n.values.includes(v.toLowerCase())) {
        fail(where, `${path}: неизвестное имя «${v}»${hint(v, n.values)}`);
      }
      return;
    case 'enumList':
      if (!Array.isArray(v)) fail(where, `${path}: нужен список имён, а не ${typeName(v)}`);
      v.forEach((c, i) => checkNode(c, { t: 'enum', values: n.values }, `${path}[${i}]`, where));
      return;
    default: {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        fail(where, `${path}: нужен объект, а не ${typeName(v)}`);
      }
      const o = v as Record<string, unknown>;
      const known = Object.keys(n.fields);
      for (const k of Object.keys(o)) {
        const f = n.fields[k];
        if (f === undefined) fail(where, `${path}: неизвестное поле «${k}»${hint(k, known)}`);
        checkNode(o[k], f, `${path}.${k}`, where);
      }
      for (const k of n.need ?? []) {
        if (o[k] === undefined) fail(where, `${path}: нет обязательного поля «${k}»`);
      }
    }
  }
}

/** Шаг обязан быть объектом ровно с одним известным ключом. */
function checkStep(st: unknown, n: number, source: string): void {
  const where = `${source}: шаг ${n + 1}`;
  if (typeof st !== 'object' || st === null || Array.isArray(st)) {
    fail(where, `шаг обязан быть объектом, а не ${typeName(st)}`);
  }
  const keys = Object.keys(st as Record<string, unknown>);
  const known = Object.keys(STEP_SCHEMA);
  if (keys.length === 0) fail(where, `пустой шаг: нужен ровно один ключ из ${known.join(', ')}`);
  for (const k of keys) {
    if (!(k in STEP_SCHEMA)) fail(where, `неизвестный ключ шага «${k}»${hint(k, known)}`);
  }
  if (keys.length > 1) {
    // Два действия в одном шаге неоднозначны по порядку, а протокол обязан
    // читаться сверху вниз ровно так, как исполняется.
    fail(where, `сразу несколько действий (${keys.join(', ')}): нужен ровно один ключ`);
  }
  const key = keys[0] as StepKey;
  checkNode((st as Record<string, unknown>)[key], STEP_SCHEMA[key], key, where);
}

function buttonMask(names: readonly string[]): number {
  let mask = 0;
  for (const n of names) {
    const b = BUTTONS[n.toLowerCase()];
    if (b === undefined) throw new Error(`неизвестная кнопка «${n}»`);
    mask |= b;
  }
  return mask;
}

/** Проверка попадания в границы. Возвращает описание провала или null. */
function checkRange(label: string, value: number, r: Range): string | null {
  if (r.min !== undefined && value < r.min)
    return `${label} = ${round(value)}, ожидалось ≥ ${r.min}`;
  if (r.max !== undefined && value > r.max)
    return `${label} = ${round(value)}, ожидалось ≤ ${r.max}`;
  return null;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

const countActive = (flags: Uint8Array, limit: number): number => {
  let n = 0;
  for (let i = 0; i < limit; i++) if (flags[i]) n++;
  return n;
};

/** Индекс n-го живого врага: сценарий считает врагов, а не ячейки пула. */
function nthEnemy(s: SimState, n: number): number {
  let seen = 0;
  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (!s.eActive[i]) continue;
    if (seen === n) return i;
    seen++;
  }
  return -1;
}

function checkEnemy(s: SimState, e: EnemyExpectation): string[] {
  const out: string[] = [];
  const n = e.index ?? 0;
  const i = nthEnemy(s, n);
  if (i < 0) return [`врага ${n} нет: на арене ${countActive(s.eActive, MAX_ENEMIES)}`];

  if (e.hp) push(out, checkRange(`здоровье врага ${n}`, s.eHP[i], e.hp));
  if (e.x) push(out, checkRange(`x врага ${n}`, toFloat(s.eX[i]), e.x));
  if (e.y) push(out, checkRange(`y врага ${n}`, toFloat(s.eY[i]), e.y));
  if (e.phase !== undefined) {
    const want = PHASES[e.phase.toLowerCase()];
    if (want === undefined) throw new Error(`неизвестная фаза «${e.phase}»`);
    if (s.ePhase[i] !== want) {
      const actual = Object.keys(PHASES).find((k) => PHASES[k] === s.ePhase[i]) ?? s.ePhase[i];
      out.push(`фаза врага ${n} = ${String(actual)}, ожидалась ${e.phase}`);
    }
  }
  return out;
}

/** Номер пари по идентификатору: сценарий называет пари, а не индекс слота. */
function betIndex(id: string): number {
  const n = BETS.findIndex((b) => b.id === id);
  if (n < 0) throw new Error(`неизвестное пари «${id}»`);
  return n;
}

/** Слот, в котором у игрока лежит названное пари, или −1. */
function betSlot(s: SimState, player: number, id: string): number {
  const want = betIndex(id);
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    const k = player * MAX_ACTIVE_BETS + i;
    if (s.aState[k] !== BetState.None && s.aBet[k] === want) return i;
  }
  return -1;
}

/**
 * Раскладка на арене.
 *
 * «Каждому хватает хотя бы на одну» проверяется по МИНИМУМУ и МАКСИМУМУ среди
 * игроков: средняя персональная карта на игрока — это ровно то число, которое
 * остаётся верным на столе, где всё досталось одному.
 */
function checkCards(s: SimState, e: CardsExpectation): string[] {
  const out: string[] = [];

  if (e.total) push(out, checkRange('карт на арене', countActive(s.kActive, MAX_CARDS), e.total));
  if (e.shared) {
    let n = 0;
    for (let i = 0; i < MAX_CARDS; i++) if (s.kActive[i] && s.kOwner[i] === SHARED) n++;
    push(out, checkRange('общих карт', n, e.shared));
  }
  if (e.perPlayer) {
    for (let p = 0; p < s.playerCount; p++) {
      let n = 0;
      for (let i = 0; i < MAX_CARDS; i++) if (s.kActive[i] && s.kOwner[i] === p) n++;
      push(out, checkRange(`персональных карт игрока ${p}`, n, e.perPlayer));
    }
  }
  if (e.owner !== undefined) {
    if (e.id === undefined)
      return [...out, 'владелец задан без «id»: непонятно, о какой карте речь'];
    const bet = betIndex(e.id);
    const want = CARD_OWNERS[e.owner.toLowerCase()];
    /*
     * «Карты нет» — отдельный флаг, а не значение владельца.
     *
     * Раньше здесь стояло −2 как заведомо невозможный владелец. Значение
     * перестало быть невозможным ровно в тот день, когда карту начал класть
     * Туз (`ACE`), — и сценарий, ждавший его карту, сообщал бы, что её нет,
     * держа её в руках. Сентинел, который однажды становится законным
     * значением, — это ошибка, ждущая своего коммита.
     */
    let found = -1;
    let on = false;
    for (let i = 0; i < MAX_CARDS; i++) {
      if (s.kActive[i] && s.kBet[i] === bet) {
        found = s.kOwner[i];
        on = true;
        break;
      }
    }
    if (!on) out.push(`карты «${e.id}» на арене нет`);
    else if (found !== want) {
      const actual = Object.keys(CARD_OWNERS).find((k) => CARD_OWNERS[k] === found) ?? found;
      out.push(`владелец карты «${e.id}» = ${String(actual)}, ожидался ${e.owner}`);
    }
  } else if (e.id !== undefined) {
    const bet = betIndex(e.id);
    let on = false;
    for (let i = 0; i < MAX_CARDS; i++) if (s.kActive[i] && s.kBet[i] === bet) on = true;
    if (!on) out.push(`карты «${e.id}» на арене нет`);
  }
  return out;
}

function checkBets(s: SimState, e: BetsExpectation, player: number): string[] {
  const out: string[] = [];

  if (e.active) {
    let n = 0;
    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      if (s.aState[player * MAX_ACTIVE_BETS + i] === BetState.Active) n++;
    }
    push(out, checkRange(`активных пари у игрока ${player}`, n, e.active));
  }
  if (e.cardsOnArena) {
    push(out, checkRange('карт на арене', countActive(s.kActive, MAX_CARDS), e.cardsOnArena));
  }
  // Счётчики забега — не про конкретное пари, поэтому проверяются до поиска
  // слота: «взято три, выиграно одно» осмысленно и тогда, когда слоты пусты.
  if (e.taken) push(out, checkRange('пари взято', s.meta[Meta.BetsTaken], e.taken));
  if (e.won) push(out, checkRange('пари выиграно', s.meta[Meta.BetsWon], e.won));
  if (e.lost) push(out, checkRange('пари проиграно', s.meta[Meta.BetsLost], e.lost));
  if (e.cashed) push(out, checkRange('пари обналичено', s.meta[Meta.BetsCashed], e.cashed));

  if (e.id === undefined) return out;

  const n = betSlot(s, player, e.id);
  if (n < 0) {
    // Слота нет — это провал только там, где сценарий ждал состояния. Ждать
    // «none» от несуществующего пари законно: его и правда нет.
    const wantNone = e.state !== undefined && BET_STATES[e.state.toLowerCase()] === BetState.None;
    if (!wantNone) out.push(`пари «${e.id}» у игрока ${player} нет`);
    return out;
  }
  const k = player * MAX_ACTIVE_BETS + n;

  if (e.state !== undefined) {
    const want = BET_STATES[e.state.toLowerCase()];
    if (want === undefined) throw new Error(`неизвестное состояние пари «${e.state}»`);
    if (s.aState[k] !== want) {
      const actual = Object.keys(BET_STATES).find((key) => BET_STATES[key] === s.aState[k]);
      out.push(`пари «${e.id}»: ${String(actual)}, ожидалось ${e.state}`);
    }
  }
  if (e.progressPct) {
    const q = (progressOf(s, player, n) * 100) / FX_ONE;
    push(out, checkRange(`прогресс пари «${e.id}», %`, q, e.progressPct));
  }
  if (e.nearMissPct) {
    const q = (nearMissOf(s, player, n) * 100) / FX_ONE;
    push(out, checkRange(`near-miss пари «${e.id}», %`, q, e.nearMissPct));
  }
  if (e.counter) push(out, checkRange(`счётчик пари «${e.id}»`, s.aCounter[k], e.counter));
  if (e.cashOut) {
    push(out, checkRange(`выплата за «Забрать» «${e.id}»`, cashOutValue(s, player, n), e.cashOut));
  }
  return out;
}

/**
 * Вывести босса, минуя двадцать четыре комнаты до него.
 *
 * Не обход правил забега, а другой предмет проверки: комнаты и двери
 * проверяются своими сценариями, а бой с боссом — этим.
 */
function startBossRoom(s: SimState): void {
  s.meta[Meta.Phase] = RunPhase.Boss;
  s.meta[Meta.Room] = ROOMS_PER_FLOOR;
  s.meta[Meta.RoomThreat] = bossRoomBudget(s.meta[Meta.Floor], s.playerCount);
  s.meta[Meta.ThreatCleared] = 0;
  startBoss(s);
}

function checkBoss(s: SimState, e: BossExpectation): string[] {
  const out: string[] = [];
  const max = s.meta[Meta.BossMaxHP];

  if (e.hpPct) {
    if (max === 0) out.push('прочность босса спрошена, а босса на арене нет');
    else push(out, checkRange('прочность босса, %', (s.meta[Meta.BossHP] * 100) / max, e.hpPct));
  }
  if (e.phase) push(out, checkRange('фаза босса', s.meta[Meta.BossPhase], e.phase));
  if (e.balls) {
    push(out, checkRange('шаров на арене', countActive(s.ballActive, MAX_BALLS), e.balls));
  }
  if (e.fallenSectors) {
    let n = 0;
    for (let i = 0; i < SECTOR_COUNT; i++) {
      if (s.sectorFallAt[i] !== 0 && s.tick >= s.sectorFallAt[i] && s.tick < s.sectorRestoreAt[i]) {
        n++;
      }
    }
    push(out, checkRange('провалившихся секторов', n, e.fallenSectors));
  }
  if (e.counterBet !== undefined) {
    const on = counterBetRunning(s);
    if (on !== e.counterBet) out.push(`встречная ставка идёт = ${on}, ожидалось ${e.counterBet}`);
  }
  if (e.stunned !== undefined) {
    const on = bossStunned(s);
    if (on !== e.stunned) out.push(`босс оглушён = ${on}, ожидалось ${e.stunned}`);
  }
  if (e.beaten) push(out, checkRange('побеждено боссов', s.meta[Meta.BossesBeaten], e.beaten));
  return out;
}

/**
 * Ставка Туза.
 *
 * Кон ищется сперва среди принятых, и только потом среди предложенных: после
 * принятия он ЗАФИКСИРОВАН, а кошелёк за бой меняется — и проверка по
 * предложению показывала бы не ту сумму, о которой договорились.
 */
function checkAce(s: SimState, e: AceExpectation, player: number): string[] {
  const out: string[] = [];
  const card = aceCardAt(s);

  if (e.offer !== undefined) {
    const on = card >= 0;
    if (on !== e.offer) out.push(`карта Туза на столе = ${on}, ожидалось ${e.offer}`);
  }
  if (e.stake) {
    let stake = -1;
    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      const k = player * MAX_ACTIVE_BETS + i;
      if (s.aState[k] !== BetState.None && s.aStake[k] < 0) stake = -s.aStake[k];
    }
    if (stake < 0) stake = card >= 0 ? aceStakeFor(s, player) : 0;
    push(out, checkRange(`кон Туза против игрока ${player}`, stake, e.stake));
  }
  if (e.paid) push(out, checkRange('отдано Тузу', s.meta[Meta.PaidToAce], e.paid));
  return out;
}

/** Номер апгрейда по идентификатору: сценарий называет товар, а не индекс слота. */
function upgradeIndex(id: string): number {
  const n = UPGRADES.findIndex((u) => u.id === id);
  if (n < 0) throw new Error(`неизвестный апгрейд «${id}»`);
  return n;
}

/**
 * Лавка.
 *
 * Цена без `id` проверяется у КАЖДОГО выложенного товара, а не у первого:
 * ассортимент случаен, и проверка одного слота зеленела бы ровно в той мере, в
 * какой повезло с броском.
 */
function checkShop(s: SimState, e: ShopExpectation, player: number): string[] {
  const out: string[] = [];

  if (e.offers) {
    let n = 0;
    for (let i = 0; i < SHOP_SLOTS; i++) if (s.shopItem[i] !== 0) n++;
    push(out, checkRange('товаров на прилавке', n, e.offers));
  }
  if (e.owned)
    push(out, checkRange(`апгрейдов у игрока ${player}`, upgradeCount(s, player), e.owned));

  if (e.id === undefined) {
    if (e.price) {
      for (let i = 0; i < SHOP_SLOTS; i++) {
        if (s.shopItem[i] === 0) continue;
        const name = UPGRADES[s.shopItem[i] - 1].id;
        push(out, checkRange(`цена «${name}»`, s.shopPrice[i], e.price));
      }
    }
    if (e.onSale !== undefined || e.bought !== undefined) {
      out.push('спрошено про товар без «id»: непонятно, о каком речь');
    }
    return out;
  }

  const upgrade = upgradeIndex(e.id);
  let at = -1;
  for (let i = 0; i < SHOP_SLOTS; i++) if (s.shopItem[i] === upgrade + 1) at = i;

  if (e.onSale !== undefined && at >= 0 !== e.onSale) {
    out.push(`«${e.id}» на прилавке = ${at >= 0}, ожидалось ${e.onSale}`);
  }
  if (e.bought !== undefined) {
    const owned = hasUpgrade(s, player, upgrade);
    if (owned !== e.bought) {
      out.push(`«${e.id}» у игрока ${player} = ${owned}, ожидалось ${e.bought}`);
    }
  }
  if (e.price) {
    if (at < 0) out.push(`цена «${e.id}» спрошена, а его на прилавке нет`);
    else push(out, checkRange(`цена «${e.id}»`, s.shopPrice[at], e.price));
  }
  return out;
}

function checkExpectation(
  s: SimState,
  e: Expectation,
  spawn: readonly { x: number; y: number }[],
): string[] {
  const out: string[] = [];

  if (e.enemies)
    push(out, checkRange('врагов на арене', countActive(s.eActive, MAX_ENEMIES), e.enemies));
  if (e.bullets) push(out, checkRange('снарядов', countActive(s.bActive, MAX_BULLETS), e.bullets));
  if (e.chipsOnFloor) {
    push(out, checkRange('фишек на полу', countActive(s.cActive, MAX_CHIPS), e.chipsOnFloor));
  }
  if (e.kills) push(out, checkRange('убито врагов', s.meta[Meta.Kills], e.kills));
  if (e.enemy) out.push(...checkEnemy(s, e.enemy));
  if (e.cards) out.push(...checkCards(s, e.cards));
  if (e.bets) out.push(...checkBets(s, e.bets, e.player ?? 0));
  if (e.boss) out.push(...checkBoss(s, e.boss));
  if (e.ace) out.push(...checkAce(s, e.ace, e.player ?? 0));
  if (e.shop) out.push(...checkShop(s, e.shop, e.player ?? 0));

  const i = e.player ?? 0;
  if (i >= s.playerCount) return [`игрока ${i} нет: в забеге ${s.playerCount}`];

  const x = toFloat(s.pX[i]);
  const y = toFloat(s.pY[i]);

  if (e.x) push(out, checkRange(`x игрока ${i}`, x, e.x));
  if (e.y) push(out, checkRange(`y игрока ${i}`, y, e.y));
  if (e.travelled) {
    const dx = x - spawn[i].x;
    const dy = y - spawn[i].y;
    push(out, checkRange(`путь игрока ${i}`, Math.sqrt(dx * dx + dy * dy), e.travelled));
  }
  if (e.hearts) push(out, checkRange(`сердца игрока ${i}`, s.pHearts[i], e.hearts));
  if (e.chips) push(out, checkRange(`фишки игрока ${i}`, s.pChips[i], e.chips));

  if (e.alive !== undefined) {
    const alive = (s.pFlags[i] & EntityFlag.Alive) !== 0;
    if (alive !== e.alive) out.push(`игрок ${i}: жив = ${alive}, ожидалось ${e.alive}`);
  }
  if (e.invulnerable !== undefined) {
    const inv = (s.pFlags[i] & EntityFlag.Invulnerable) !== 0;
    if (inv !== e.invulnerable)
      out.push(`игрок ${i}: неуязвим = ${inv}, ожидалось ${e.invulnerable}`);
  }
  if (e.hash !== undefined) {
    const h = hashHex(s);
    if (h !== e.hash) out.push(`хеш ${h}, ожидался ${e.hash}`);
  }
  return out;
}

const push = (out: string[], msg: string | null): void => {
  if (msg !== null) out.push(msg);
};

/**
 * Прогнать сценарий.
 *
 * Провалы собираются все до единого, а не бросаются первым: увидеть сразу
 * весь список расхождений дешевле, чем чинить их по одному и перезапускать.
 */
export function runScenario(sc: Scenario): ScenarioResult {
  const s = createState(sc.seed ?? 1, sc.players ?? 1);
  spawnPlayers(s);
  setSpawning(s, sc.waves === true);

  const spawn = Array.from({ length: s.playerCount }, (_, i) => ({
    x: toFloat(s.pX[i]),
    y: toFloat(s.pY[i]),
  }));

  const frames: InputFrame[] = Array.from({ length: s.playerCount }, makeFrame);
  const failures: string[] = [];

  for (const [n, st] of sc.steps.entries()) {
    const where = `шаг ${n + 1}`;
    try {
      if ('input' in st) {
        const f = frames[st.input.player ?? 0];
        if (st.input.move) {
          f.moveX = fromFloat(st.input.move[0]);
          f.moveY = fromFloat(st.input.move[1]);
        }
        if (st.input.aim) {
          f.aimX = fromFloat(st.input.aim[0]);
          f.aimY = fromFloat(st.input.aim[1]);
        }
        if (st.input.buttons) f.buttons = buttonMask(st.input.buttons);
      } else if ('clearInput' in st) {
        const f = frames[st.clearInput.player ?? 0];
        f.moveX = f.moveY = f.aimX = f.aimY = f.buttons = 0;
      } else if ('tick' in st) {
        for (let t = 0; t < st.tick; t++) step(s, frames);
      } else if ('place' in st) {
        const i = st.place.player ?? 0;
        /*
         * Точку можно назвать координатами, а можно — смыслом.
         *
         * `redZone` ставит игрока в центр красной зоны ТЕКУЩЕЙ раскладки, и
         * это не удобство: с двенадцатью шаблонами зона переезжает каждую
         * комнату, а сценарий, прибитый к паре чисел, начинает проверять не
         * то, что назван проверять. Первым же таким сценарием и был этот —
         * он ставил игрока в точку прошлой единственной арены и после
         * прихода шаблонов сообщал, что пари не срывается.
         */
        if (st.place.redZone === true) {
          s.pX[i] = redZoneX(s);
          s.pY[i] = redZoneY(s);
        } else {
          if (st.place.x !== undefined) s.pX[i] = fromFloat(st.place.x);
          if (st.place.y !== undefined) s.pY[i] = fromFloat(st.place.y);
        }
        s.pVX[i] = 0;
        s.pVY[i] = 0;
      } else if ('spawn' in st) {
        const type = ENEMY_TYPES[st.spawn.type.toLowerCase()];
        if (type === undefined) throw new Error(`неизвестный враг «${st.spawn.type}»`);
        for (let n = 0; n < (st.spawn.count ?? 1); n++) {
          spawnEnemy(s, type, fromFloat(st.spawn.x), fromFloat(st.spawn.y));
        }
      } else if ('card' in st) {
        putCard(
          s,
          betIndex(st.card.id),
          st.card.player ?? SHARED,
          s.tick + CARD.lifeTicks,
          fromFloat(st.card.x),
          fromFloat(st.card.y),
        );
      } else if ('bet' in st) {
        const p = st.bet.player ?? 0;
        const stake = st.bet.stake ?? 10;
        // Кон никогда не превышает кошелёк — Туз в кредит не принимает
        // (GDD §11). Сценарий, ставящий больше, чем есть, проверял бы
        // экономику, которой не бывает, поэтому это ошибка сценария.
        if (stake > s.pChips[p]) {
          throw new Error(`кон ${stake} больше кошелька игрока ${p} (${s.pChips[p]})`);
        }
        if (!takeBet(s, p, betIndex(st.bet.id), stake)) {
          throw new Error(`пари «${st.bet.id}» не взялось: лимит активных пари`);
        }
        // Кон списывается и здесь: в игре его снимает подбор карты, и
        // сценарий, обошедший карту, не должен получать пари даром — иначе
        // он проверяет экономику, которой не бывает.
        s.pChips[p] -= stake;
      } else if ('chips' in st) {
        s.pChips[st.chips.player ?? 0] = st.chips.amount;
      } else if ('appetite' in st) {
        s.pAppetite[st.appetite.player ?? 0] = APPETITE_TIERS[st.appetite.tier.toLowerCase()];
      } else if ('dropChip' in st) {
        dropChip(s, fromFloat(st.dropChip.x), fromFloat(st.dropChip.y));
      } else if ('explode' in st) {
        explode(s, fromFloat(st.explode.x), fromFloat(st.explode.y), -1);
      } else if ('cashOut' in st) {
        const p = st.cashOut.player ?? 0;
        const n = betSlot(s, p, st.cashOut.id);
        if (n < 0) throw new Error(`пари «${st.cashOut.id}» у игрока ${p} нет`);
        cashOut(s, p, n);
      } else if ('deal' in st) {
        dealCards(s);
      } else if ('shop' in st) {
        openShop(s);
      } else if ('upgrade' in st) {
        const p = st.upgrade.player ?? 0;
        if (!grantUpgrade(s, p, upgradeIndex(st.upgrade.id))) {
          throw new Error(`апгрейд «${st.upgrade.id}» не выдался: уже есть или слоты кончились`);
        }
      } else if ('floor' in st) {
        s.meta[Meta.Floor] = st.floor;
      } else if ('aceBet' in st) {
        // Срок тот же, что у обычной карты: в игре предложение живёт до первой
        // волны, а сценарий волн по умолчанию не пускает — и часы паузы,
        // которых он не заводил, съедали бы предложение на первом же тике.
        layAceCard(s, betIndex(st.aceBet.id), s.tick + CARD.lifeTicks);
      } else if ('settle' in st) {
        settleBets(s);
      } else if ('clear' in st) {
        clearArena(s);
      } else if ('boss' in st) {
        startBossRoom(s);
      } else if ('damageBoss' in st) {
        damageBoss(s, st.damageBoss.amount);
      } else {
        for (const msg of checkExpectation(s, st.expect, spawn)) {
          failures.push(`${where} (тик ${s.tick}): ${msg}`);
        }
      }
    } catch (err) {
      failures.push(`${where}: ${String(err)}`);
      break;
    }
  }

  return { name: sc.name, ok: failures.length === 0, ticks: s.tick, hash: hashHex(s), failures };
}

/**
 * Разбор со строгой проверкой структуры.
 *
 * Сценарии правят руками, и опечатки неизбежны — но опечатка обязана валить
 * разбор, а не пропускаться молча. Молча пропущенное поле ожидания превращает
 * сценарий в зелёный прогон, не проверяющий ничего: это хуже отсутствия
 * сценария, потому что выглядит покрытием (DEVLOOP §5, §6А).
 */
export function parseScenario(json: string, source: string): Scenario {
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch (e) {
    // Исходная ошибка едет причиной, а не только строкой в сообщении: в ней
    // позиция сбоя, а без неё опечатку в сценарии на сотню строк искать
    // глазами.
    throw new Error(`${source}: не разбирается как JSON — ${String(e)}`, { cause: e });
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) {
    fail(source, `сценарий обязан быть объектом, а не ${typeName(o)}`);
  }

  const raw = o as Record<string, unknown>;
  const known = Object.keys(SCENARIO_FIELDS);
  for (const k of Object.keys(raw)) {
    if (!(k in SCENARIO_FIELDS)) fail(source, `неизвестное поле сценария «${k}»${hint(k, known)}`);
  }
  if (typeof raw.name !== 'string' || !raw.name) throw new Error(`${source}: нет поля name`);
  if (!Array.isArray(raw.steps)) throw new Error(`${source}: нет массива steps`);
  for (const k of ['seed', 'players', 'waves'] as const) {
    if (raw[k] !== undefined) checkNode(raw[k], SCENARIO_FIELDS[k], k, source);
  }
  raw.steps.forEach((st, i) => checkStep(st, i, source));

  return raw as unknown as Scenario;
}

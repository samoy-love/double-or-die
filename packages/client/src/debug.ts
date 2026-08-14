/**
 * Отладочный интерфейс для агента.
 *
 * Даёт полный контроль над симуляцией: прошагать ровно n тиков, прочитать
 * состояние, подать ввод, прыгнуть куда угодно. Именно поэтому его НЕТ в
 * продакшене — вырезается на этапе сборки константой `__DEV_BUILD__`, а не
 * проверкой в рантайме: иначе его достанут из бандла.
 *
 * Проверяется в CI функциональным тестом: прод-бандл грузится headless и
 * утверждается `window.__DOD__ === undefined`.
 */

import {
  ARENA_PAD,
  AceGesture,
  BETS,
  BOSS,
  BRICK,
  BetProgress,
  BetState,
  CARD,
  Curse,
  DoorType,
  ENEMIES,
  EnemyPhase,
  EnemyType,
  EntityFlag,
  FAIRNESS,
  FUSE,
  FX_ONE,
  InputScheme,
  MAX_ACTIVE_BETS,
  MAX_BULLETS,
  MAX_CARDS,
  MAX_CHIPS,
  MAX_DOORS,
  MAX_ENEMIES,
  MAX_SPAWNS,
  Meta,
  ROOMS_PER_FLOOR,
  RunPhase,
  SCHEME_SHIFT,
  SHARED,
  SHOP_SLOTS,
  TICK_HZ,
  UPGRADE,
  WEDGE,
  aceEnter,
  advanceBetId,
  bossInPlay,
  bossStunned,
  buyUpgrade,
  cashOut,
  cashOutValue,
  clearArena,
  counterBetRunning,
  damageBoss as hitBoss,
  enterHouseCut,
  failBetId,
  fallenSector,
  fromFloat,
  giftOpen,
  isFreeSpot,
  leaveReward,
  maxX,
  maxY,
  nearMissOf,
  aceCardAt,
  offerAceBet,
  playAceGesture,
  resetAce,
  settleBets,
  startAceToss,
  startRoom,
  UPGRADES,
  grantUpgrade,
  damagePlayer,
  endRun,
  PLAYER,
  WAVE,
  offerDoors,
  openGift,
  openShop,
  startBoss,
  progressOf,
  putCard,
  setSpawning,
  spawnEnemy,
  toFloat,
  tryTakeCard,
  type BetId,
  type SimState,
} from '@dod/sim';
import { serialize } from '@dod/sim/replay';
import type { SimEvent } from './events';
import type { GameLoop } from './loop';
import { PALETTE, type Rgb } from './palette';
import { log } from './protocol';
import { BUILD, VERSION, GIT_SHA } from './version';

/** Имена врагов для отладки: номер типа в консоли не читается. */
const ENEMY_TYPES: Record<string, EnemyType> = {
  wedge: EnemyType.Wedge,
  brick: EnemyType.Brick,
  fuse: EnemyType.Fuse,
};

export type EnemyName = keyof typeof ENEMY_TYPES;

/** Жесты Крупье именами: `aceGesture(5)` в сценарии съёмки не читается. */
const ACE_GESTURES: Record<string, AceGesture> = {
  yawn: AceGesture.Yawn,
  applaud: AceGesture.Applaud,
  ovation: AceGesture.Ovation,
  thumbs_down: AceGesture.ThumbsDown,
  fidget: AceGesture.Fidget,
  turn_away: AceGesture.TurnAway,
};

export type AceGestureName = keyof typeof ACE_GESTURES;

/** Схемы ввода именами: от них зависят и глифы, и раскладка карт. */
const SCHEMES: Record<string, InputScheme> = {
  gamepad: InputScheme.Gamepad,
  keyboard: InputScheme.Keyboard,
  touch: InputScheme.Touch,
};

export type SchemeName = keyof typeof SCHEMES;

/** Типы дверей именами: пиктограмма заказывается словом, а не номером. */
const DOOR_TYPES: Record<string, DoorType> = {
  fight: DoorType.Fight,
  fat: DoorType.Fat,
  shop: DoorType.Shop,
  gift: DoorType.Gift,
  event: DoorType.Event,
  debt_pit: DoorType.DebtPit,
};

export type DoorName = keyof typeof DOOR_TYPES;

/**
 * Цвета экранной вспышки по поводу.
 *
 * Не произвольный цвет аргументом: вспышка обязана совпадать с событием, ради
 * которого её снимают, а свободный цвет дал бы кадр, которого игра не рисует.
 */
const FLASH_COLOURS: Record<string, Rgb> = {
  danger: PALETTE.danger,
  accent: PALETTE.accent,
  loss: PALETTE.loss,
};

export type FlashName = keyof typeof FLASH_COLOURS;

/**
 * Пари по строковому идентификатору из каталога.
 *
 * Ровно та же причина, что у имён врагов: `spawnCard(3, …)` в консоли не
 * читается, а `spawnCard('no_red_zone', …)` читается, и опечатка в нём —
 * внятная ошибка, а не молчаливый промах в соседнее пари. Таблица строится из
 * самого каталога, поэтому новое пари в `content/bets.json` приезжает сюда
 * само и разойтись они не могут.
 */
const BET_IDS = new Map<string, number>(BETS.map((spec, i) => [String(spec.id), i]));

function betIndex(id: string): number {
  const i = BET_IDS.get(id);
  if (i === undefined) {
    throw new Error(`неизвестное пари «${id}»; есть: ${[...BET_IDS.keys()].join(', ')}`);
  }
  return i;
}

/**
 * Проверить номер игрока и вернуть его же.
 *
 * Одна проверка на все ручки, берущие игрока: раньше её знала только `give`, а
 * `take` не знала — и вызов с чужим номером молча писал мимо типизированного
 * массива, то есть ручка делала не то, о чём её просили, и об этом молчала.
 */
function playerOf(s: SimState, player: number): number {
  if (!Number.isInteger(player) || player < 0 || player >= s.playerCount) {
    throw new Error(`нет игрока ${player}: в забеге их ${s.playerCount}, номера с 0`);
  }
  return player;
}

/** Слот пари: проверка одна на `failBet`, `winBet` и всё, что берёт слот. */
function betSlotOf(slot: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_ACTIVE_BETS) {
    throw new Error(`нет слота пари ${slot}: их ${MAX_ACTIVE_BETS}, номера с 0`);
  }
  return slot;
}

/** Состояние пари словом: `2` в JSON не читается, `won` читается. */
const BET_STATES = ['none', 'active', 'won', 'lost', 'cashed'] as const;

/** Доля в Q16.16 в проценты: `q` наружу отдаётся человеческим числом. */
const percent = (fx: number): number => Math.round((fx / FX_ONE) * 100);

/** Карта, лежащая на арене. */
export interface DebugCard {
  /** Индекс ячейки в пуле: им же карта берётся через `take`. */
  i: number;
  /** Строковый идентификатор пари и его человеческое имя. */
  bet: string;
  name: string;
  category: number;
  x: number;
  y: number;
  /** Номер игрока-владельца или −1 у общей. */
  owner: number;
  /** Сколько тиков карте осталось лежать. */
  ticksLeft: number;
}

/**
 * Активное пари игрока.
 *
 * Всё, что видно на экране, обязано быть доступно как JSON (DEVLOOP §7), а на
 * плашке пари видно ровно это: категория, кон, состояние, счётчик, растущая
 * потенциальная выплата и — у сорванного — насколько близко было.
 */
export interface DebugBet {
  /** Номер слота у игрока: им пари обналичивается через `cashout`. */
  slot: number;
  /** Индекс в каталоге и его строковый идентификатор. */
  bet: number;
  id: string;
  name: string;
  category: number;
  /** Множитель обычным числом, не в Q16.16. */
  multiplier: number;
  stake: number;
  state: (typeof BET_STATES)[number];
  counter: number;
  /** Цель счётчикового пари. Ноль — не счётчиковое. */
  target: number;
  /** Прогресс `q` в процентах (ECONOMY §9А). */
  q: number;
  /** Сколько дадут прямо сейчас за «Забрать». */
  cashOut: number;
  /** Сколько дадут, если дожать. */
  payout: number;
  /** Насколько близко было, в процентах. */
  nearMiss: number;
}

export interface DebugState {
  tick: number;
  seed: number;
  hash: string;
  playerCount: number;
  /** Ход забега: комната, волна, счёт убийств. */
  /** Номер этажа, с единицы. Комната нумеруется ВНУТРИ него. */
  floor: number;
  room: number;
  wave: number;
  /** Фаза забега: дверь, бой, расчёт, награда, босс, плата, итоги. */
  phase: number;
  /** Раскладка арены: номер шаблона и его отражение (0..3). */
  template: number;
  flip: number;
  kills: number;
  enemies: { i: number; type: number; hp: number; x: number; y: number; phase: number }[];
  bullets: number;
  chipsOnFloor: number;
  players: {
    i: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    aimX: number;
    aimY: number;
    hearts: number;
    chips: number;
    alive: boolean;
    invulnerable: boolean;
    /** Тир кона, выбранный до входа в комнату. */
    appetite: number;
    /**
     * Схема ввода этого игрока: 0 геймпад, 1 клавиатура, 2 тач.
     *
     * Наружу отдаётся потому, что от неё зависит раскладка карт (матрица
     * «пари × схема», GDD §9.5), а проверить её иначе нечем: схема приезжает
     * кадром ввода и в живой игре меняется молча.
     */
    scheme: number;
    /** Активные и уже разрешённые пари этого игрока. */
    bets: DebugBet[];
  }[];
  /** Карты, лежащие на арене прямо сейчас. */
  cards: DebugCard[];
  /**
   * Чем занят Крупье: жест и реплика под ним.
   *
   * В кадре реплики пока нет — текст приезжает со шрифтом в стадии F2, — а
   * проверять правило дозировки надо уже сейчас: «чем сильнее игрок
   * пострадал, тем мягче» ловится только на живом забеге, не в юните.
   *
   * Присутствие и точка стояния отдаются вместе с жестом, и это не полнота
   * ради полноты. Отладочному интерфейсу нечем было ответить на вопрос «Крупье
   * сейчас на арене?» — а именно он и оказался нужен, когда владелец сказал,
   * что Крупье не видно: без этого признака нельзя ни отличить «его нет» от «он
   * есть, но неразличим», ни поставить проверку на видимость.
   */
  ace: { gesture: number; bark: string; onArena: boolean; x: number; y: number };
}

export interface DebugApi {
  readonly ready: Promise<void>;
  readonly build: string;
  readonly version: string;
  readonly sha: string;
  newRun(o?: { seed?: number; players?: number }): void;
  tick(n?: number): void;
  /**
   * Подать ввод за игрока. Значения направлений — обычные числа −1..1,
   * `buttons` — маска Btn. `null` снимает подмену.
   */
  input(
    player: number,
    frame: { move?: [number, number]; aim?: [number, number]; buttons?: number } | null,
  ): void;
  play(): void;
  pause(): void;
  isPaused(): boolean;
  state(): DebugState;
  hash(): string;
  perf(): { fps: number; particles: number; shapes: number; dropped: number };
  /** Поставить врагов вокруг игрока. Без волн — ровно тех, кого попросили. */
  spawn(type: EnemyName, count?: number): void;
  /** Убрать с арены всё, кроме игроков. */
  clear(): void;
  /** Включить или выключить пополнение арены волнами. */
  waves(on?: boolean): void;
  /**
   * Выдать ресурсы: отладка экономики без десяти минут игры.
   *
   * Номер игрока необязателен и по умолчанию нулевой — но обязан быть: в
   * коопе «выдать фишки» без адресата проверяет ровно один сценарий из
   * четырёх, а кооп-экономика (общая доля заведения, ставки на напарника)
   * начинается там, где кошельки разные.
   */
  give(o: { chips?: number; hearts?: number }, player?: number): void;
  /**
   * Положить в кошелёк ровно столько фишек.
   *
   * Иначе не снять ни «Ноль фишек», ни «Лавка: не хватает»: прибавкой
   * `give(-30)` они набираются угадыванием от стартовых тридцати, а любая
   * подобранная на арене фишка это угадывание ломает молча.
   */
  setChips(player: number, n: number): void;
  /**
   * Задать ровное число сердец.
   *
   * Иначе состояния «Кровью», «−1 сердце» и подсказка коуча про низкое
   * здоровье набираются повторными `give({hearts:-1})` без гарантии итога.
   * Вниз ручка идёт уроном ядра со всеми его последствиями, вверх — прямой
   * записью с потолком лавки; мёртвому сердца не возвращаются, воскрешения в
   * 0.4.0 нет.
   */
  setHearts(player: number, n: number): void;
  /**
   * Купить товар из названного слота прилавка.
   *
   * Состояние «Лавка: слот продан» — пустая рамка со штриховкой — иначе не
   * снимается ничем: продажа наступает только подтверждением на нужном фокусе
   * при достаточном кошельке. В Даре кадр синтетический: живая покупка там
   * закрывает экран сразу, а ручка его оставляет.
   */
  buy(slot: number, player?: number): boolean;

  // --- Пари: версия называется «Ставка», и отладка обязана её доставать ---

  /** Что сейчас лежит на арене: пари, место, владелец, оставшиеся тики. */
  cards(): DebugCard[];
  /**
   * Положить карту в названную точку. Без владельца — общая.
   *
   * Пари задаётся строкой из каталога (`no_damage`, `under_45s`, …).
   */
  spawnCard(bet: string, x: number, y: number, owner?: number): DebugCard | null;
  /**
   * Подобрать карту от лица игрока.
   *
   * Без номера карты — та, на которой игрок стоит, ровно как в бою. С
   * номером игрок сначала переставляется на карту: подбор всё равно идёт
   * через ядро, поэтому и лимит пари, и чужая персональная карта, и списание
   * кона работают как в настоящей игре.
   */
  take(player: number, cardId?: number): boolean;
  /** Обналичить пари. Без номера слота — самое выгодное. */
  cashout(player: number, betSlot?: number): { slot: number; q: number; payout: number } | null;
  /** Задать аппетит: 0 скромно, 1 нормально, 2 по-крупному. */
  setAppetite(player: number, tier: number): void;
  /** Выключить звук: он мешает, когда агент гоняет сотню прогонов. */
  mute(on?: boolean): void;
  /**
   * Открыть плату за этаж — тем же входом, каким её открывает забег.
   *
   * Нужна проверке отрисовки: своим ходом экран платы стоит ЗА боссом, а бот
   * до босса не доходит. Подменять фазу руками нельзя — проверялся бы кадр,
   * которого в игре не бывает, — поэтому зовётся `enterHouseCut` ядра: она
   * ставит и фазу, и сумму по формуле этажа, как в настоящем забеге.
   */
  houseCut(): void;
  /**
   * Открыть лавку — входом ядра, а не подменой фазы.
   *
   * Нужна той же проверке отрисовки: лавка стоит за дверью «Лавка» и за
   * зачищенной комнатой, а бот до неё доходит не всякий раз и не быстро.
   * `openShop` раскладывает витрину из потока `shop` и назначает цены по
   * этажу — то же самое, что увидит игрок.
   */
  shop(): void;
  /**
   * Открыть выбор двери — тем же входом ядра, что и конец комнаты.
   *
   * Той же причины, что лавка и плата: дверь стоит за зачищенной комнатой,
   * а бот доходит до неё не всякий раз. Проверять экран, который человек
   * видит по двадцать раз за забег, вручную дороже, чем завести ручку.
   */
  door(): void;
  /**
   * Открыть Дар — тот же прилавок, но бесплатно.
   *
   * Отдельно от `shop()`: экран у них общий, а состояние разное (титул,
   * подсказка, отсутствие ценников), и снимать надо оба.
   */
  gift(): void;
  /**
   * Выложить Ставку Крупье — карту, которую он ставит против игрока.
   *
   * Экран поверх боя, и дождаться его боем нельзя: карта выпадает по своим
   * условиям раз в комнату. Съёмке и ревью нужен вход по команде.
   */
  aceBet(): void;
  /**
   * Вывести Крупье на арену: покачивание, взгляд на ближайшего.
   *
   * Сам он выходит по бюджету комнаты и порогу зачищенной угрозы, а стоит
   * 3.5 секунды — снять его случаем нельзя. Точку стояния (центр масс живых)
   * считает ядро: руками её честно не воспроизвести.
   */
  aceOut(on?: boolean): void;
  /**
   * Сыграть названный жест Крупье.
   *
   * Четыре жеста из шести случаются по редким условиям (третья комната
   * вхолостую, 90% прогресса, нелепая смерть), а строка реестра требует всех
   * шести. Жест держится две секунды — кадр снимается в этом окне.
   */
  aceGesture(name: AceGestureName): void;
  /**
   * Начать замах подброса: растущее кольцо телеграфа.
   *
   * Живёт полсекунды и наступает по порогу зачищенной угрозы — случаем не
   * ловится.
   */
  aceToss(): void;
  /**
   * Показать названную реплику Крупье.
   *
   * Реплика ставится только в момент смены жеста и берётся из словаря:
   * длинную фразу у самой кромки арены — а проверять надо именно её зажатие в
   * границы — случай не выдаст никогда.
   */
  bark(text: string): void;
  /**
   * Начать бой с боссом. Ровно то же, что `bossPhase(1)`.
   *
   * Прежняя реализация звала `startBoss` при фазе забега `Fight`, а `stepBoss`
   * вне боссовой комнаты не делает ничего — кадр показывал неподвижного босса,
   * какого в игре не бывает.
   */
  boss(): void;
  /**
   * Довести бой с боссом до названной фазы.
   *
   * Вторая фаза со встречной ставкой, третья с тремя шарами, объявленный и
   * провалившийся сектор иначе достижимы только настоящим боем на минуты и
   * удачей. Фазу ручка не пишет: переключает её ядро, а ручка снимает запас
   * прочности до порога и даёт шаг.
   */
  bossPhase(n: number): void;
  /**
   * Ударить босса на названную величину.
   *
   * Оглушение после сорванной встречной ставки живёт четыре секунды и
   * наступает только от попадания внутри десятисекундного окна — вручную в
   * него не попасть.
   */
  damageBoss(amount: number): void;
  /**
   * Навесить проклятие и долг: оба меняют HUD и не воспроизводятся по команде.
   *
   * Номер вне каталога — ошибка, а не тихая запись: HUD рисует проклятие по
   * имени из таблицы, и `curse(9)` давал кадр с пустой строкой статуса,
   * который агент читал как сломанный рендер.
   */
  curse(id: number, debt?: number): void;
  /** Вернуться в меню — тем же путём, что отказ на экране итогов. */
  toMenu(): void;
  /** Объявить обучение пройденным: снимать бой надо без висящего урока. */
  learned(): void;
  /** Забыть обучение: съёмка первого забега начинается с чистого листа. */
  forget(): void;
  /** Пометить один урок пройденным — так снимается следующий по очереди. */
  teach(id: string): void;
  /**
   * Выдать апгрейд: витрина и торг без него показывают пустоту.
   *
   * Неизвестный идентификатор — ошибка со списком существующих, а не `false`:
   * опечатка в сценарии съёмки иначе выглядит как «апгрейд уже есть» и кадр
   * молча выходит не тем, что обещан. `false` остаётся ответом ядра — апгрейд
   * уже выдан или слоты кончились.
   */
  giveUpgrade(id: string): boolean;
  /** Выложить карту пари под игроком и сразу подобрать её. */
  takeBet(id: string, player?: number): boolean;
  /**
   * Сорвать активное пари.
   *
   * Плашка «сорвано» в бою и обе формы near-miss на расчёте иначе снимаются
   * только настоящим проигрышем в нужную секунду. Точность у ручки меньше, чем
   * обещает подпись: ядро срывает все слоты игрока с ТЕМ ЖЕ пари, а не один
   * названный, — дублей у одного игрока штатно не бывает.
   */
  failBet(
    player?: number,
    betSlot?: number,
  ): { slot: number; bet: string; q: number; form: 'seconds' | 'percent' } | null;
  /**
   * Выиграть активное пари.
   *
   * Плашка «выиграно» и шестиугольник с ядром на расчёте. Входа «разрешить
   * один слот» в ядре нет: расчёт закрывает все слоты всех игроков — ровно как
   * конец комнаты, — поэтому соседние уедут в исход вместе с целевым.
   */
  winBet(player?: number, betSlot?: number): { slot: number; bet: string; payout: number } | null;
  /**
   * Оставить карте названные секунды жизни.
   *
   * Последние секунды карты — оседающий луч и мигание 2 Гц — рендер включает по
   * порогу в три секунды до срока. Ждать их боем ради кадра нельзя, а порог
   * зашит в рендер, не в отладку.
   */
  expireCard(cardId: number, secondsLeft?: number): DebugCard | null;
  /** Убить игрока: экран гибели иначе снимается только удачей. */
  kill(player?: number): void;
  /** Закончить забег победой: у итогов два разных титула. */
  win(): void;
  /** Открыть паузу расчёта между волнами. */
  settle(): void;
  /** Нарисовать кадр немедленно: в невидимой вкладке кадров не бывает. */
  render(): void;
  /** Нагрузить сцену для замера бюджета кадра: враги и частицы разом. */
  stress(o?: { enemies?: number; particles?: number }): void;
  /**
   * Кадр сеткой средних цветов — снимок картинки для визуальной регрессии.
   *
   * Отдаёт клиент, а не тест: контекст без `preserveDrawingBuffer`, и
   * снаружи его буфер читается через раз (см. `Renderer.frameGrid`).
   */
  frameGrid(cols?: number, rows?: number): number[][];
  /**
   * Кадр картинкой в data-URL.
   *
   * Сетка средних цветов о типографике не говорит ничего, а снаружи канвас
   * читается пустым: без снимка изнутри вёрстку экранов проверять нечем,
   * кроме как глазами на живой машине.
   *
   * `focus` — вырезать и увеличить прямоугольник кадра вокруг мировой точки
   * (те же единицы, что у `state().ace.x/y`) вместо кадра целиком: мелкие
   * фигуры (жест Крупье, ~60×90px на игровом разрешении) на обычном снимке
   * не читаются.
   */
  framePng(focus?: { x: number; y: number; halfW: number; halfH: number; scale?: number }): string;
  /** События с указанного тика включительно. Без аргумента — все. */
  events(sinceTick?: number): SimEvent[];
  replay(): string;
  stable(on?: boolean): void;

  // --- Клиент, ввод и арена: то, что рисуется, но по команде не наступает ---

  /**
   * Объявить схему ввода игрока.
   *
   * Ни «Меню, подсказки геймпада», ни глифы пада в бою иначе не снять: пад
   * может лежать подключённым, а схема меняется только живым нажатием,
   * которого у агента нет. У первого игрока держится до первого живого ввода,
   * у остальных ставится постоянной подменой кадра — снимается `input(p, null)`.
   */
  scheme(player: number, name: SchemeName): void;
  /**
   * Задать масштаб интерфейса в процентах.
   *
   * Кадр «Интерфейс при 150%» иначе набирается только нажатиями в фокусе
   * второго пункта настроек. Профиль об этом не узнает: кадр не должен пачкать
   * сейв.
   */
  uiScale(percent: number): void;
  /**
   * Включить поштучный забор.
   *
   * Состояние «Поштучный забор включён» — подпись в настройках и второй контур
   * у плашки в бою — иначе снимается только проходом по экрану настроек;
   * профиль по умолчанию держит его выключенным.
   */
  cashoutFocus(on?: boolean): void;
  /**
   * Открыть справку поверх меню.
   *
   * Кадр «Меню первого забега» существует только при нулевом счётчике забегов,
   * а у снимаемого профиля они уже посчитаны — своим ходом справка не появится.
   */
  openTutorial(): void;
  /**
   * Зажечь экранную вспышку названного повода.
   *
   * Вспышка рисуется один кадр по событию и гаснет за четверть секунды —
   * поймать её съёмкой нельзя. Обычный путь вдобавок молчит в режиме
   * стабильного кадра, а съёмка идёт именно в нём.
   */
  flash(kind?: FlashName, alpha?: number): void;
  /**
   * Начать названную комнату этажа.
   *
   * Восьмой урок коуча требует комнаты не ниже второй, а дойти до неё съёмка
   * может только полноценным боем. Ручка предполагает бой и закрывает пари
   * прошлой комнаты вместе с Крупье — в сценарии зовётся первой.
   */
  setRoom(n: number): void;
  /**
   * Разложить двери названных типов.
   *
   * Шесть пиктограмм иначе не собрать: «Событие» весит ноль и не выпадает
   * никогда, Долговая яма требует долга, а повтор типа в наборе запрещён.
   */
  doorTypes(list: readonly DoorName[]): void;
  /**
   * Довести врага названного типа до телеграфа атаки и встать на паузу.
   *
   * Коридор со штриховкой живёт полсекунды, кольцо Фитиля — восемь десятых:
   * случаем они в кадр не попадают. Возвращает номер врага либо −1, если ядро
   * телеграф не разрешило, — молчаливого «как будто получилось» здесь нет.
   */
  telegraph(kind: EnemyName, maxTicks?: number): number;
  /**
   * Поставить метку спавна в названную точку.
   *
   * Сжимающееся кольцо живёт полсекунды и ставится спавнером волны в случайной
   * точке — вместе с ним не проверяется и само правило честности, которое
   * игроку доступно только через этот рисунок. Кадр снимается в этом окне и на
   * паузе.
   */
  spawnMark(x: number, y: number, kind?: EnemyName): number;
}

function cardsOf(s: SimState): DebugCard[] {
  const out: DebugCard[] = [];
  for (let i = 0; i < MAX_CARDS; i++) {
    if (!s.kActive[i]) continue;
    const spec = BETS[s.kBet[i]];
    out.push({
      i,
      bet: String(spec.id),
      name: spec.name,
      category: spec.category,
      x: toFloat(s.kX[i]),
      y: toFloat(s.kY[i]),
      owner: s.kOwner[i],
      ticksLeft: Math.max(0, s.kDeadline[i] - s.tick),
    });
  }
  return out;
}

/**
 * Пари игрока со всеми числами, которые видно на плашке.
 *
 * Считается ядром, а не здесь: `progressOf`, `cashOutValue` и `nearMissOf` —
 * это те же функции, по которым живут выплаты. Пересчёт «примерно так же» в
 * отладке означал бы, что агент проверяет не игру, а вторую её реализацию.
 */
function betsOf(s: SimState, player: number): DebugBet[] {
  const out: DebugBet[] = [];
  for (let n = 0; n < MAX_ACTIVE_BETS; n++) {
    const k = player * MAX_ACTIVE_BETS + n;
    const state = s.aState[k] as BetState;
    if (state === BetState.None) continue;
    const spec = BETS[s.aBet[k]];
    out.push({
      slot: n,
      bet: s.aBet[k],
      id: String(spec.id),
      name: spec.name,
      category: spec.category,
      multiplier: spec.multiplier / FX_ONE,
      stake: s.aStake[k],
      state: BET_STATES[state],
      counter: s.aCounter[k],
      target: spec.target,
      q: percent(progressOf(s, player, n)),
      cashOut: state === BetState.Active ? cashOutValue(s, player, n) : 0,
      payout: Math.trunc((s.aStake[k] * spec.multiplier) / FX_ONE),
      nearMiss: percent(nearMissOf(s, player, n)),
    });
  }
  return out;
}

function snapshot(s: SimState, hash: string, bark: string): DebugState {
  const enemies = [];
  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (!s.eActive[i]) continue;
    enemies.push({
      i,
      type: s.eType[i],
      hp: s.eHP[i],
      x: toFloat(s.eX[i]),
      y: toFloat(s.eY[i]),
      phase: s.ePhase[i],
    });
  }
  let bullets = 0;
  for (let i = 0; i < MAX_BULLETS; i++) if (s.bActive[i]) bullets++;
  let chipsOnFloor = 0;
  for (let i = 0; i < MAX_CHIPS; i++) if (s.cActive[i]) chipsOnFloor++;

  const players = [];
  for (let i = 0; i < s.playerCount; i++) {
    players.push({
      i,
      x: toFloat(s.pX[i]),
      y: toFloat(s.pY[i]),
      vx: toFloat(s.pVX[i]),
      vy: toFloat(s.pVY[i]),
      aimX: toFloat(s.pAimX[i]),
      aimY: toFloat(s.pAimY[i]),
      hearts: s.pHearts[i],
      chips: s.pChips[i],
      alive: (s.pFlags[i] & EntityFlag.Alive) !== 0,
      invulnerable: (s.pFlags[i] & EntityFlag.Invulnerable) !== 0,
      appetite: s.pAppetite[i],
      scheme: s.pScheme[i],
      bets: betsOf(s, i),
    });
  }
  return {
    cards: cardsOf(s),
    tick: s.tick,
    seed: s.seed,
    hash,
    playerCount: s.playerCount,
    floor: s.meta[Meta.Floor],
    room: s.meta[Meta.Room],
    wave: s.meta[Meta.Wave],
    phase: s.meta[Meta.Phase],
    template: s.meta[Meta.Template],
    flip: s.meta[Meta.Flip],
    kills: s.meta[Meta.Kills],
    enemies,
    bullets,
    chipsOnFloor,
    players,
    ace: {
      gesture: s.meta[Meta.AceGesture],
      bark,
      onArena: s.meta[Meta.AceX] !== 0,
      x: toFloat(s.meta[Meta.AceX]),
      y: toFloat(s.meta[Meta.AceY]),
    },
  };
}

export function installDebugApi(loop: GameLoop): void {
  const api: DebugApi = {
    ready: Promise.resolve(),
    build: BUILD,
    version: VERSION,
    sha: GIT_SHA,

    newRun(o) {
      loop.restart(o?.seed ?? loop.state.seed, o?.players ?? loop.state.playerCount);
      log('new_run', { seed: loop.state.seed, players: loop.state.playerCount });
    },

    tick(n = 1) {
      loop.advance(n);
    },

    input(player, frame) {
      if (frame === null) {
        loop.setInput(player, null);
        return;
      }
      const [mx, my] = frame.move ?? [0, 0];
      const [ax, ay] = frame.aim ?? [0, 0];
      loop.setInput(player, {
        moveX: fromFloat(mx),
        moveY: fromFloat(my),
        aimX: fromFloat(ax),
        aimY: fromFloat(ay),
        buttons: frame.buttons ?? 0,
      });
    },

    play: () => loop.play(),
    pause: () => loop.pause(),
    isPaused: () => loop.isPaused,
    state: () => snapshot(loop.state, loop.hash(), loop.feedback.bark),
    hash: () => loop.hash(),
    perf: () => ({
      fps: loop.fps,
      particles: loop.particles.count,
      shapes: loop.shapeCount,
      // Ненулевое значение означает, что кадр обрезан и картинка неполна:
      // без него бенч и визуальная регрессия сравнивали бы урезанный кадр,
      // не зная об этом.
      dropped: loop.droppedShapes,
    }),

    spawn(type, count = 1) {
      const t = ENEMY_TYPES[type];
      if (t === undefined) throw new Error(`неизвестный враг «${String(type)}»`);
      const s = loop.state;
      // По кругу вокруг игрока, но не ближе честной дистанции спавна:
      // отладка не должна создавать ситуаций, невозможных в игре.
      for (let n = 0; n < count; n++) {
        const a = (n / count) * Math.PI * 2;
        spawnEnemy(
          s,
          t,
          fromFloat(toFloat(s.pX[0]) + Math.cos(a) * 300),
          fromFloat(toFloat(s.pY[0]) + Math.sin(a) * 300),
        );
      }
      log('spawn', { type, count });
    },

    clear() {
      clearArena(loop.state);
      log('clear', {});
    },

    waves(on = true) {
      setSpawning(loop.state, on);
      log('waves', { on });
    },

    give(o, player = 0) {
      const s = loop.state;
      playerOf(s, player);
      if (o.chips !== undefined) s.pChips[player] += o.chips;
      if (o.hearts !== undefined) s.pHearts[player] += o.hearts;
      log('give', { player, chips: o.chips ?? 0, hearts: o.hearts ?? 0 });
    },

    setChips(player, n) {
      const s = loop.state;
      playerOf(s, player);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`фишек ${n}: нужно целое не меньше нуля`);
      }
      // Прямая запись поля, и обойти её нечем: «положить в кошелёк ровно N»
      // ядро не экспортирует вовсе — кошелёк меняют только подбор фишки,
      // списание кона, выплата и доля заведения, и каждый из них прибавляет
      // или отнимает по своей причине, таща за собой побочные действия.
      // Единственный контракт кошелька — неотрицательность, и её проверка
      // выше держит.
      s.pChips[player] = n;
      log('set_chips', { player, chips: n });
    },

    setHearts(player, n) {
      const s = loop.state;
      playerOf(s, player);
      if (!Number.isInteger(n) || n < 0 || n > UPGRADE.maxHearts) {
        throw new Error(`сердец ${n}: допустимо от 0 до ${UPGRADE.maxHearts}`);
      }
      // ВНИЗ — только уроном ядра: `damagePlayer` снимает по сердцу и тянет за
      // собой всё, что на уроне висит (срыв «Без урона», жест Крупье, расчёт
      // пари при гибели). Прямая запись меньшего числа дала бы состояние,
      // которого в игре не бывает: ноль сердец у живого игрока — остановка по
      // инварианту.
      while (s.pHearts[player] > n && (s.pFlags[player] & EntityFlag.Alive) !== 0) {
        s.pInvulUntil[player] = 0;
        s.pFlags[player] &= ~EntityFlag.Invulnerable;
        damagePlayer(s, player);
      }
      // ВВЕРХ — прямой записью с тем же потолком, что у передышки на изломе и
      // у сердца из лавки: входа «вылечить» ядро не экспортирует, лечение живёт
      // двумя инлайн-клампами внутри своих модулей.
      if (s.pHearts[player] < n && (s.pFlags[player] & EntityFlag.Alive) !== 0) {
        s.pHearts[player] = n;
      }
      log('set_hearts', {
        player,
        hearts: s.pHearts[player],
        alive: (s.pFlags[player] & EntityFlag.Alive) !== 0,
      });
    },

    buy(slot, player = 0) {
      const s = loop.state;
      playerOf(s, player);
      if (!Number.isInteger(slot) || slot < 0 || slot >= SHOP_SLOTS) {
        throw new Error(`слот ${slot}: на прилавке их ${SHOP_SLOTS}, номера с 0`);
      }
      if (s.meta[Meta.Phase] !== RunPhase.Reward) {
        throw new Error('прилавка нет: сначала shop() или gift()');
      }
      if (s.shopItem[slot] === 0) throw new Error(`слот ${slot} уже пуст`);
      // Покупка идёт ровно тем же входом, что подтверждение на экране награды:
      // цена, потолок слотов и очистка пары «товар — цена» — правила ядра, а не
      // отладки. Их вторая реализация здесь оставила бы «цену без товара», на
      // которой забег встаёт по инварианту.
      const ok = buyUpgrade(s, player, slot);
      log('buy', {
        player,
        slot,
        ok,
        gift: giftOpen(s),
        items: [...s.shopItem],
        prices: [...s.shopPrice],
      });
      return ok;
    },

    cards: () => cardsOf(loop.state),

    spawnCard(bet, x, y, owner = SHARED) {
      const s = loop.state;
      const i = putCard(
        s,
        betIndex(bet),
        owner,
        s.tick + CARD.lifeTicks,
        fromFloat(x),
        fromFloat(y),
      );
      if (i < 0) {
        log('spawn_card_failed', { bet, x, y, owner });
        return null;
      }
      log('spawn_card', { bet, x, y, owner });
      return cardsOf(s).find((c) => c.i === i) ?? null;
    },

    take(player, cardId) {
      const s = loop.state;
      playerOf(s, player);
      if (cardId !== undefined) {
        if (!Number.isInteger(cardId) || cardId < 0 || cardId >= MAX_CARDS) {
          throw new Error(`нет ячейки карты ${cardId}: их ${MAX_CARDS}, номера с 0`);
        }
        if (!s.kActive[cardId]) throw new Error(`карты ${cardId} на арене нет`);
        // Переставляем игрока на карту и дальше идём общим путём. Свой
        // «упрощённый подбор» здесь был бы второй реализацией правил — той,
        // что не знает ни про лимит пари, ни про чужую персональную карту.
        s.pX[player] = s.kX[cardId];
        s.pY[player] = s.kY[cardId];
      }
      const ok = tryTakeCard(s, player);
      log('take', { player, card: cardId ?? -1, ok });
      return ok;
    },

    cashout(player, betSlot) {
      const s = loop.state;
      let slot = betSlot ?? -1;
      if (slot < 0) {
        // «Забрать» одной кнопкой берёт самое выгодное — повторяем выбор,
        // чтобы вернуть агенту НОМЕР слота: без него он не поймёт, что ушло.
        let bestValue = 0;
        for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
          if (s.aState[player * MAX_ACTIVE_BETS + i] !== BetState.Active) continue;
          const v = cashOutValue(s, player, i);
          if (slot < 0 || v > bestValue) {
            slot = i;
            bestValue = v;
          }
        }
      }
      if (slot < 0 || s.aState[player * MAX_ACTIVE_BETS + slot] !== BetState.Active) return null;

      // Прогресс снимается ДО обналичивания: после него состояние уже другое.
      const q = percent(progressOf(s, player, slot));
      const payout = cashOut(s, player, slot);
      log('cashout', { player, slot, q, payout });
      return { slot, q, payout };
    },

    setAppetite(player, tier) {
      if (tier < 0 || tier > 2) throw new Error(`аппетит ${tier}: есть 0, 1 и 2`);
      loop.setAppetite(player, tier);
      // Немедленно, а не со следующего тика: агент вызывает setAppetite и
      // тут же take(), и кон обязан списаться уже новый.
      loop.state.pAppetite[player] = tier;
      log('set_appetite', { player, tier });
    },

    mute(on = true) {
      loop.audio.setMuted(on);
    },

    houseCut() {
      enterHouseCut(loop.state);
      log('house_cut', { floor: loop.state.meta[Meta.Floor], cut: loop.state.meta[Meta.HouseCut] });
    },

    door() {
      offerDoors(loop.state);
      log('door', { types: [...loop.state.doorType] });
    },

    gift() {
      openGift(loop.state);
      log('gift', { items: [...loop.state.shopItem] });
    },

    aceBet() {
      offerAceBet(loop.state);
      log('ace_bet', { card: aceCardAt(loop.state) });
    },

    boss() {
      // Ровно `bossPhase(1)`, и второй реализации у неё нет: прежняя звала
      // `startBoss` при фазе забега `Fight`, а вне боссовой комнаты шаг босса
      // не делает ничего — снятый кадр показывал неподвижного босса.
      api.bossPhase(1);
    },

    bossPhase(n) {
      if (!Number.isInteger(n) || n < 1 || n > BOSS.phases) {
        throw new Error(`фаза босса ${n}: нужно целое от 1 до ${BOSS.phases}`);
      }
      const s = loop.state;

      // Босса выпускает ядро тем же путём, что и забег: восьмая комната
      // кончилась — выходит босс. Номер комнаты перед этим ставится вручную, и
      // это единственная подмена здесь: вход в боссову комнату существует
      // только веткой приватного перехода по номеру комнаты, а играть ради
      // кадра восемь настоящих комнат нельзя.
      if (!bossInPlay(s)) {
        s.meta[Meta.Room] = ROOMS_PER_FLOOR;
        leaveReward(s);
        startBoss(s);
      }

      // Фазы переключает только шаг босса: вход «объявить фазу» наружу не
      // выдан намеренно. Законный способ ровно один — снять запас прочности до
      // порога и дать ядру шаг.
      const drop = (pct: number): void => {
        const want = Math.trunc((s.meta[Meta.BossMaxHP] * pct) / 100);
        const hit = s.meta[Meta.BossHP] - want;
        if (hit > 0) hitBoss(s, hit);
        loop.advance(1);
      };

      if (n >= 2 && s.meta[Meta.BossPhase] < 2) drop(BOSS.phaseTwoPct);
      if (n >= 3) {
        // Встречная ставка объявляется раз за бой и обязана разрешиться сама:
        // урон по ней дал бы оглушение, а не третью фазу. Порог третьей фазы
        // поэтому считается уже после её выплаты — запас прочности читается
        // заново, и менять порядок нельзя.
        while (counterBetRunning(s)) loop.advance(1);
        if (s.meta[Meta.BossPhase] < 3) drop(BOSS.phaseThreePct);
      }

      log('boss_phase', {
        want: n,
        phase: s.meta[Meta.BossPhase],
        hp: s.meta[Meta.BossHP],
        max: s.meta[Meta.BossMaxHP],
        counterBet: counterBetRunning(s),
        broken: s.meta[Meta.CounterBetBroken],
        stunned: bossStunned(s),
        sector: fallenSector(s),
      });
    },

    damageBoss(amount) {
      const s = loop.state;
      if (!Number.isInteger(amount) || amount < 1) {
        throw new Error(`урон боссу ${amount}: нужно целое не меньше 1`);
      }
      if (!bossInPlay(s)) {
        throw new Error('босса нет на арене: сначала bossPhase(1)');
      }
      // Срыв встречной ставки и оглушение ставит само ядро: здесь только удар.
      hitBoss(s, amount);
      log('damage_boss', {
        amount,
        hp: s.meta[Meta.BossHP],
        max: s.meta[Meta.BossMaxHP],
        phase: s.meta[Meta.BossPhase],
        broken: s.meta[Meta.CounterBetBroken],
        stunned: bossStunned(s),
        stunUntil: s.meta[Meta.CounterBetUntil],
      });
    },

    aceOut(on = true) {
      if (typeof on !== 'boolean') {
        throw new Error(`aceOut: ожидалось true или false, пришло «${String(on)}»`);
      }
      const s = loop.state;
      // Сброс ДО выхода не уборка: выход отказывает при исчерпанном бюджете
      // комнаты и в паузе после прошлого ухода — без сброса третий вызов
      // подряд молча не делает ничего.
      resetAce(s);
      if (on && !aceEnter(s)) {
        throw new Error('Крупье не вышел: на арене нет ни одного живого игрока');
      }
      log('ace_out', {
        on,
        onArena: s.meta[Meta.AceX] !== 0,
        x: toFloat(s.meta[Meta.AceX]),
        y: toFloat(s.meta[Meta.AceY]),
        leaveAt: s.meta[Meta.AceLeaveAt],
      });
    },

    aceGesture(name) {
      const g = ACE_GESTURES[name];
      if (g === undefined) {
        throw new Error(
          `неизвестный жест «${String(name)}»; есть: ${Object.keys(ACE_GESTURES).join(', ')}`,
        );
      }
      const s = loop.state;
      // Тела нет — жеста быть не может: инвариант «жест на пустой арене» валит
      // dev-сборку, и выглядит это как сломанная съёмка.
      if (s.meta[Meta.AceX] === 0) api.aceOut(true);
      // Серия смертей глушит издевательские жесты — милосердие ядра: без
      // сброса палец вниз и овация молча не покажутся.
      s.meta[Meta.DeathStreak] = 0;
      // Жест не перебивает жест — тем же приёмом, что и жест на смерть игрока.
      s.meta[Meta.AceGestureUntil] = 0;
      playAceGesture(s, g);
      log('ace_gesture', {
        name,
        gesture: s.meta[Meta.AceGesture],
        until: s.meta[Meta.AceGestureUntil],
        holdTicks: CARD.gestureTicks,
      });
    },

    aceToss() {
      const s = loop.state;
      // Подброс один за комнату и упирается в тот же бюджет выходов: сброс
      // делает ручку повторяемой.
      resetAce(s);
      if (!startAceToss(s)) {
        throw new Error('подброс невозможен: на арене нет ни одного живого игрока');
      }
      log('ace_toss', {
        tossAt: s.meta[Meta.TossAt],
        telegraphTicks: CARD.aceTelegraphTicks,
        x: toFloat(s.meta[Meta.AceX]),
        y: toFloat(s.meta[Meta.AceY]),
      });
    },

    bark(text) {
      if (typeof text !== 'string' || text.trim() === '') {
        throw new Error('bark ждёт непустую строку — реплику Крупье');
      }
      const s = loop.state;
      // Реплика рисуется только внутри блока Крупье: без тела строка не
      // появится вовсе, и агент решит, что ручка сломана.
      if (s.meta[Meta.AceX] === 0) api.aceOut(true);
      // Правится поле клиента, а не ядра: в симуляции реплики не существует —
      // жест сущность ядра, а слова приезжают словарём поверх него.
      loop.feedback.bark = text;
      log('bark', { text, onArena: s.meta[Meta.AceX] !== 0 });
    },

    toMenu() {
      loop.backToMenu();
      log('to_menu', {});
    },

    learned() {
      loop.coach.teachAll();
    },

    forget() {
      loop.coach.forget();
    },

    teach(id: string) {
      loop.coach.teach(id);
    },

    giveUpgrade(id: string) {
      const index = UPGRADES.findIndex((u) => String(u.id) === id);
      if (index < 0) {
        throw new Error(
          `неизвестный апгрейд «${id}»; есть: ${UPGRADES.map((u) => String(u.id)).join(', ')}`,
        );
      }
      // Индекс отдаётся как есть: `grantUpgrade` нумерует апгрейды с нуля и
      // сама сдвигает номер на единицу при записи в слот. Прежний `index + 1`
      // выдавал СОСЕДНИЙ апгрейд, а последний в каталоге не выдавался вовсе —
      // и торг снимался с товаром, о котором его не просили.
      const ok = grantUpgrade(loop.state, 0, index);
      log('give_upgrade', { id, ok });
      return ok;
    },

    takeBet(id: string, player = 0) {
      const s = loop.state;
      const card = api.spawnCard(id, toFloat(s.pX[player]), toFloat(s.pY[player]), player);
      if (!card) return false;
      return api.take(player, card.i);
    },

    failBet(player = 0, betSlot = 0) {
      const s = loop.state;
      playerOf(s, player);
      betSlotOf(betSlot);
      const k = player * MAX_ACTIVE_BETS + betSlot;
      if (s.aState[k] !== BetState.Active) {
        throw new Error(
          `слот ${betSlot} игрока ${player} не активен (${BET_STATES[s.aState[k]]}): сначала takeBet('under_45s')`,
        );
      }
      const bet = s.aBet[k] as BetId;
      const spec = BETS[s.aBet[k]];
      // Прогресс снимается ДО срыва: после него ядро подменило его снимком.
      const q = percent(progressOf(s, player, betSlot));
      // Через ядро: сам `loseBet` приватен, и только этот вход считает
      // near-miss, растит счётчик проигранных и платит Крупье за Ставку.
      failBetId(s, player, bet);
      const form = spec.progress === BetProgress.Time ? 'seconds' : 'percent';
      log('fail_bet', { player, slot: betSlot, bet: String(spec.id), q, form });
      return { slot: betSlot, bet: String(spec.id), q, form };
    },

    winBet(player = 0, betSlot = 0) {
      const s = loop.state;
      playerOf(s, player);
      betSlotOf(betSlot);
      const k = player * MAX_ACTIVE_BETS + betSlot;
      if (s.aState[k] !== BetState.Active) {
        throw new Error(
          `слот ${betSlot} игрока ${player} не активен (${BET_STATES[s.aState[k]]}): сначала takeBet('no_damage')`,
        );
      }
      if ((s.pFlags[player] & EntityFlag.Alive) === 0) {
        throw new Error(`игрок ${player} мёртв, а мёртвый не выигрывает ничего: сначала newRun()`);
      }
      const bet = s.aBet[k] as BetId;
      const spec = BETS[s.aBet[k]];
      // Счётчиковое доводится тем же входом, что и бой: расчёт проверяет
      // счётчик, и «выиграть» здесь значит выполнить условие, а не объявить
      // исход.
      if (spec.progress === BetProgress.Counter && s.aCounter[k] < spec.target) {
        advanceBetId(s, player, bet, spec.target - s.aCounter[k]);
      }
      const before = s.pChips[player];
      // Расчёт комнаты — единственный вход, ставящий «выиграно». Он разрешает
      // ВСЕ слоты всех игроков: другого «выиграть одно пари» в ядре нет, а своя
      // запись состояния обошла бы и выплату, и счётчик, и звук.
      settleBets(s);
      const payout = s.pChips[player] - before;
      log('win_bet', {
        player,
        slot: betSlot,
        bet: String(spec.id),
        state: BET_STATES[s.aState[k]],
        payout,
      });
      return { slot: betSlot, bet: String(spec.id), payout };
    },

    expireCard(cardId, secondsLeft = 1.5) {
      const s = loop.state;
      if (!Number.isInteger(cardId) || cardId < 0 || cardId >= MAX_CARDS) {
        throw new Error(`нет ячейки карты ${cardId}: их ${MAX_CARDS}, номера с 0`);
      }
      if (!s.kActive[cardId]) throw new Error(`карты ${cardId} на арене нет`);
      const fadeSeconds = CARD.fadeTicks / TICK_HZ;
      if (!Number.isFinite(secondsLeft) || secondsLeft < 0 || secondsLeft > fadeSeconds) {
        throw new Error(
          `осталось ${secondsLeft} с: луч оседает последние ${fadeSeconds} с, задавайте от 0 до ${fadeSeconds}`,
        );
      }
      const bet = s.kBet[cardId];
      const owner = s.kOwner[cardId];
      const x = s.kX[cardId];
      const y = s.kY[cardId];
      // Срок карте задаёт `putCard` и только он: своей записи в поле срока
      // здесь нет, иначе отладка стала бы вторым местом, знающим, из чего
      // состоит карта. Ячейка перед этим гасится вручную — «убрать ОДНУ карту»
      // ядро не экспортирует (есть только сброс всех восьми), а без неё
      // положилась бы девятая карта рядом с прежней.
      s.kActive[cardId] = 0;
      const i = putCard(s, bet, owner, s.tick + Math.round(secondsLeft * TICK_HZ), x, y);
      if (i < 0) throw new Error('свободной ячейки не нашлось: карта потеряна');
      log('expire_card', { card: i, bet: String(BETS[bet].id), secondsLeft });
      return cardsOf(s).find((c) => c.i === i) ?? null;
    },

    kill(player = 0) {
      const s = loop.state;
      playerOf(s, player);
      // Бьём столько раз, сколько сердец: `damagePlayer` снимает по одному и
      // уважает неуязвимость, поэтому «убить» — это не одно попадание.
      //
      // Снимать надо И срок неуязвимости, И её флаг. Прежняя версия гасила
      // только срок, а флаг ставит сам `damagePlayer` — поэтому за весь вызов
      // уходило ровно одно сердце, игрок оставался жив, и «убитый» кадр
      // показывал живого. Молчаливо: ручка ничего не возвращала.
      for (
        let i = 0;
        i < PLAYER.startHearts + 4 && (s.pFlags[player] & EntityFlag.Alive) !== 0;
        i++
      ) {
        s.pInvulUntil[player] = 0;
        s.pFlags[player] &= ~EntityFlag.Invulnerable;
        damagePlayer(s, player);
      }
      const alive = (s.pFlags[player] & EntityFlag.Alive) !== 0;
      log('kill', { player, alive, hearts: s.pHearts[player] });
      if (alive) throw new Error(`игрок ${player} пережил kill(): сердец ${s.pHearts[player]}`);
    },

    win() {
      endRun(loop.state, true);
      log('win', {});
    },

    settle() {
      // Пауза между волнами — это `NextWaveAt` в будущем: расчёт показывается
      // ровно тогда, когда следующая волна ещё не пришла.
      const s = loop.state;
      s.meta[Meta.NextWaveAt] = s.tick + WAVE.roomGapTicks;
      log('settle', { until: s.meta[Meta.NextWaveAt] });
    },

    curse(id: number, debt = 0) {
      // Номер вне каталога раньше проходил молча, и строка статуса выходила
      // пустой: у HUD нет имени для седьмого проклятия, а у ядра — правила.
      // Ноль оставлен допустимым намеренно — это «проклятия нет», и им же
      // снимается кадр чистой строки статуса.
      if (!Number.isInteger(id) || id < Curse.None || id > Curse.Commission) {
        throw new Error(
          `нет проклятия ${id}: их ${Curse.Commission}, номера с 1 (0 — «проклятия нет»)`,
        );
      }
      if (!Number.isInteger(debt) || debt < 0) {
        throw new Error(`долг ${debt}: нужно целое не меньше нуля`);
      }
      loop.state.meta[Meta.Curse] = id;
      // Шесть проклятий (GDD §11) читают не только Meta.Curse, но и
      // Meta.CurseRoom === 1 — «эта комната проклята прямо сейчас», а не
      // «проклятие где-то на заходе». Без него ручка ставила только имя в
      // HUD: ни урон, ни скорость врагов, ни блок рывка/подбора, ни срез
      // выплаты, ни виньетка не срабатывали — кадры каталога снимали
      // название угрозы без самой угрозы. id === Curse.None (снять
      // проклятие) оставляет CurseRoom нулём — это не начало комнаты, а её
      // конец.
      loop.state.meta[Meta.CurseRoom] = id === Curse.None ? 0 : 1;
      loop.state.meta[Meta.Debt] = debt;
      log('curse', { curse: id, curseRoom: loop.state.meta[Meta.CurseRoom], debt });
    },

    shop() {
      openShop(loop.state);
      log('shop', { items: [...loop.state.shopItem], prices: [...loop.state.shopPrice] });
    },

    render: () => loop.renderOnce(),

    stress(o) {
      loop.stress(o?.enemies ?? 200, o?.particles ?? 2000);
      log('stress', { enemies: o?.enemies ?? 200, particles: o?.particles ?? 2000 });
    },
    events: (sinceTick) => loop.events.since(sinceTick),

    replay() {
      /*
       * Лог инпутов — это и есть баг-репорт: по нему забег воспроизводится
       * тик в тик.
       *
       * Возвращать надо весь лог, а не заголовок от него. Прежняя версия
       * отдавала сид, число тиков и версию сборки — то есть ровно ту часть,
       * по которой ничего воспроизвести нельзя, — и обещание в этом
       * комментарии было ложным.
       *
       * Сериализует ядро: там же лежит RLE по неизменным кадрам (стик подолгу
       * держит направление, и повторов в живом забеге большинство), и там же
       * `deserialize`, который этот текст читает. Результат принимается
       * раннером как есть: `npm run sim -- --replay <файл>`.
       */
      return serialize(loop.snapshotReplay());
    },

    frameGrid(cols = 16, rows = 9) {
      return loop.frameGrid(cols, rows);
    },

    framePng(focus) {
      return loop.framePng(focus);
    },

    stable(on = true) {
      // Режим стабильного кадра: тряска, вспышки и хитстоп выключаются,
      // чтобы скриншоты сравнивались между версиями. Частицы при этом
      // остаются — они и есть предмет сравнения, — но камера стоит.
      loop.feel.stable = on;
      document.documentElement.dataset.stable = on ? '1' : '';
    },

    scheme(player, name) {
      const s = loop.state;
      playerOf(s, player);
      const v = SCHEMES[name];
      if (v === undefined) {
        throw new Error(
          `неизвестная схема ввода «${String(name)}»; есть: ${Object.keys(SCHEMES).join(', ')}`,
        );
      }
      // У первого игрока — через живой ввод клиента: подсказки меню, паузы и
      // HUD рисуются по нему, а не по битам кадра, и одной подмены бит для
      // кадра с глифами пада не хватает. Схема по определению свойство
      // клиента, ядро её только зеркалит.
      //
      // У остальных живого ввода нет вовсе, и остаётся вход ядра — биты кадра.
      // Прямая запись схемы в состояние затёрлась бы следующим же тиком.
      if (player === 0) loop.setScheme(v);
      else api.input(player, { buttons: v << SCHEME_SHIFT });
      log('scheme', { player, name, scheme: v });
    },

    uiScale(percent) {
      // Своя проверка нужна потому, что клиент зажимает диапазон молча: 200 в
      // сценарии съёмки обязано быть ошибкой, а не тихими 150 в кадре.
      if (!Number.isFinite(percent) || percent < 100 || percent > 150) {
        throw new Error(`масштаб интерфейса ${percent}%: допустимо от 100 до 150`);
      }
      loop.setUiScale(percent);
      log('ui_scale', { percent: Math.round(percent) });
    },

    cashoutFocus(on = true) {
      if (typeof on !== 'boolean') {
        throw new Error(`поштучный забор: ожидалось true или false, пришло «${String(on)}»`);
      }
      // Тот же вызов, которым настройку применяет загрузка профиля: ядро о ней
      // узнаёт кадром, где цель забора кодируется только при включённом флаге.
      loop.setCashOutFocusedOnly(on);
      log('cashout_focus', { on, target: loop.menuState.cashOutTarget });
    },

    openTutorial() {
      // Ровно тот путь, которым справку открывает первый забег.
      loop.openTutorial();
      log('open_tutorial', {});
    },

    flash(kind = 'danger', alpha = 0.3) {
      const colour = FLASH_COLOURS[kind];
      if (colour === undefined) {
        throw new Error(
          `неизвестная вспышка «${String(kind)}»; есть: ${Object.keys(FLASH_COLOURS).join(', ')}`,
        );
      }
      if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
        throw new Error(`непрозрачность вспышки ${alpha}: допустимо больше 0 и не больше 1`);
      }
      // Правится состояние обратной связи клиента, и входа ядра здесь нет по
      // правилу «ядро ничего не знает о рендере».
      loop.feel.debugFlash(colour, alpha);
      log('flash', { kind, alpha });
    },

    setRoom(n) {
      const s = loop.state;
      if (!Number.isInteger(n) || n < 1 || n > ROOMS_PER_FLOOR) {
        throw new Error(`номер комнаты ${n}: на этаже их ${ROOMS_PER_FLOOR}, считая с 1`);
      }
      if (s.meta[Meta.Phase] !== RunPhase.Fight) {
        throw new Error('комната ставится только в бою: фаза сейчас другая');
      }
      // Вход ядра: начало комнаты делает ВСЁ, что делает настоящий переход, —
      // расчёт прошлой комнаты, новая арена, бюджет угрозы, раздача карт.
      // Прямая запись номера оставила бы бюджет, шаблон и раздачу от прошлой
      // комнаты, то есть кадр состояния, которого в игре не бывает.
      startRoom(s, n);
      log('set_room', {
        room: s.meta[Meta.Room],
        type: s.meta[Meta.RoomType],
        threat: s.meta[Meta.RoomThreat],
        nextWaveAt: s.meta[Meta.NextWaveAt],
      });
    },

    doorTypes(list) {
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error(
          `doorTypes ждёт непустой список типов; есть: ${Object.keys(DOOR_TYPES).join(', ')}`,
        );
      }
      if (list.length > MAX_DOORS) {
        throw new Error(
          `дверей на экране ${MAX_DOORS}, а типов передано ${list.length}: шесть пиктограмм снимаются двумя кадрами`,
        );
      }
      const types = list.map((name) => {
        const t = DOOR_TYPES[name as string];
        if (t === undefined) {
          throw new Error(
            `неизвестный тип двери «${String(name)}»; есть: ${Object.keys(DOOR_TYPES).join(', ')}`,
          );
        }
        return t;
      });
      const s = loop.state;
      // Экран открывается входом ядра целиком — фаза, часы, сброс выбора и
      // аппетита. Типы после этого подменяются, и обойти это нечем: они
      // приходят из потока раскладки по весам, «Событие» весит ноль, повтор
      // типа запрещён, а заказ конкретного набора — правило раскладки, а не
      // отладочный вход, и заводить его в ядре ради снимка нельзя.
      //
      // Порядок именно такой: при живом долге ядро само перебивает последнюю
      // дверь на Долговую яму, и обратный порядок молча вернул бы случайный
      // набор.
      offerDoors(s);
      for (let i = 0; i < types.length; i++) s.doorType[i] = types[i];
      log('door_types', { types: [...list], doorType: [...s.doorType] });
    },

    telegraph(kind, maxTicks = 240) {
      const t = ENEMY_TYPES[kind];
      if (t === undefined) {
        throw new Error(
          `неизвестный враг «${String(kind)}»; есть: ${Object.keys(ENEMY_TYPES).join(', ')}`,
        );
      }
      if (!Number.isInteger(maxTicks) || maxTicks < 1 || maxTicks > 600) {
        throw new Error(`ожидание телеграфа ${maxTicks}: нужно целое от 1 до 600 тиков`);
      }
      const s = loop.state;
      setSpawning(s, false);
      clearArena(s);

      // Дистанция берётся из правил самого врага, а не подобрана на глаз: Клин
      // целится в своём коридоре, Фитиль поджигается ближе своего радиуса,
      // Кирпич стреляет со своей рабочей дистанции.
      const dist =
        t === EnemyType.Wedge
          ? toFloat(WEDGE.minAimRange) + (toFloat(WEDGE.aimRange) - toFloat(WEDGE.minAimRange)) / 2
          : t === EnemyType.Fuse
            ? toFloat(FUSE.igniteRange) - 20
            : toFloat(BRICK.keepDistance);

      // Место должно быть свободным: телеграф сквозь колонну ядро запрещает, и
      // враг просто уйдёт в обход, а кадр окажется не тем.
      let i = -1;
      for (let k = 0; k < 16 && i < 0; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = fromFloat(toFloat(s.pX[0]) + Math.cos(a) * dist);
        const y = fromFloat(toFloat(s.pY[0]) + Math.sin(a) * dist);
        if (!isFreeSpot(s, x, y, ENEMIES[t].radius)) continue;
        i = spawnEnemy(s, t, x, y);
      }
      if (i < 0)
        throw new Error('некуда поставить врага: свободного места на нужной дистанции нет');

      // Дальше — только шаги ядра: оно само решит, разрешён телеграф или нет.
      // Ни одно поле врага руками не пишется — нарисованный коридор обязан
      // совпадать с той геометрией, по которой ядро считает урон.
      let waited = 0;
      while (waited < maxTicks && s.eActive[i] && s.ePhase[i] !== EnemyPhase.Telegraph) {
        loop.advance(1);
        waited++;
      }
      const ok = s.eActive[i] === 1 && s.ePhase[i] === EnemyPhase.Telegraph;
      loop.pause();
      log('telegraph', {
        kind,
        enemy: i,
        ok,
        waited,
        ticksLeft: ok ? Math.max(0, s.ePhaseUntil[i] - s.tick) : 0,
      });
      return ok ? i : -1;
    },

    spawnMark(x, y, kind = 'wedge') {
      const t = ENEMY_TYPES[kind];
      if (t === undefined) {
        throw new Error(
          `неизвестный враг «${String(kind)}»; есть: ${Object.keys(ENEMY_TYPES).join(', ')}`,
        );
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`координаты метки должны быть числами, а не (${x}, ${y})`);
      }
      const s = loop.state;
      const lo = toFloat(ARENA_PAD);
      const hiX = toFloat(maxX(s));
      const hiY = toFloat(maxY(s));
      if (x < lo || x > hiX || y < lo || y > hiY) {
        throw new Error(`метка (${x}, ${y}) вне арены: допустимо x ${lo}..${hiX}, y ${lo}..${hiY}`);
      }
      const fx = fromFloat(x);
      const fy = fromFloat(y);
      if (!isFreeSpot(s, fx, fy, ENEMIES[t].radius)) {
        throw new Error(`точка (${x}, ${y}) занята колонной или краем арены`);
      }
      let slot = -1;
      for (let i = 0; i < MAX_SPAWNS && slot < 0; i++) if (!s.spActive[i]) slot = i;
      if (slot < 0) throw new Error(`все ${MAX_SPAWNS} слотов меток заняты: сначала clear()`);

      // ПОДМЕНА пула меток, и заменить её нечем: постановщик метки приватен и
      // вдобавок сам выбирает точку случайным кольцом вокруг игрока — то есть
      // даже наружу выданный он не принял бы заказанные координаты, а
      // единственный экспортированный путь к меткам (волна) даёт случайное
      // место в случайный момент, ради снятия которого ручка и заводится.
      // Запись повторяет постановщика ровно, и дальше метка живёт по правилам
      // ядра: выпустит врага через свой срок либо переставится, если игрок
      // подошёл ближе честной дистанции — заказанную точку у самых ног ядро
      // именно так и перебьёт.
      s.spX[slot] = fx;
      s.spY[slot] = fy;
      s.spType[slot] = t;
      s.spAt[slot] = s.tick + FAIRNESS.spawnMarkTicks;
      s.spActive[slot] = 1;
      log('spawn_mark', { slot, kind, x, y, ticks: FAIRNESS.spawnMarkTicks, at: s.spAt[slot] });
      return slot;
    },
  };

  (window as unknown as Record<string, unknown>).__DOD__ = api;
  log('debug_api_ready', { build: BUILD });
}

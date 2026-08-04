/**
 * СГЕНЕРИРОВАННЫЙ ФАЙЛ. Правьте content/bets.json и запускайте npm run content.
 *
 * Пари живут данными (TECH §11), а ядро симуляции не читает файлов и не имеет
 * зависимостей — поэтому каталог приезжает сюда генератором. Расхождение
 * источника и этого файла ловит CI.
 */

/** Категория пари. Цвет и иконка на карте берутся отсюда. */
export const enum BetCategory {
  Style = 0,
  Tempo = 1,
  Space = 2,
  Greed = 3,
  Tricks = 4,
  Silly = 5,
}

/** Как считается доля пройденного под риском пути (ECONOMY §9А). */
export const enum BetProgress {
  /** Доля прошедшего времени от лимита. */
  Time = 0,
  /** Выполнено / требуется. */
  Counter = 1,
  /** Доля зачищенного бюджета угрозы комнаты. */
  Threat = 2,
}

/**
 * Схема ввода игрока — вторая ось матрицы «пари × схема ввода» (GDD §9.5).
 *
 * Номер значения — это номер бита в `schemeMask`, поэтому новая схема
 * дописывается только в конец.
 */
export const enum InputScheme {
  Gamepad = 0,
  Keyboard = 1,
  Touch = 2,
}

/**
 * Номер пари в каталоге.
 *
 * Хуки детекции сравнивают ЭТИ числа, а не строковые идентификаторы: хук
 * вроде «игрок в красной зоне» проверяется каждый тик на каждом игроке, и
 * сравнение строк там стоит дороже самой проверки. Строковый `id` остаётся
 * для данных, отладки и сценариев (TECH §4).
 */
export const enum BetId {
  NoDamage = 0,
  NoDash = 1,
  Under45s = 2,
  NoRedZone = 3,
  AllChips = 4,
  Demolitionist = 5,
}

export interface BetSpec {
  readonly id: string;
  readonly name: string;
  readonly category: BetCategory;
  /** Множитель в Q16.16. */
  readonly multiplier: number;
  readonly progress: BetProgress;
  /** Лимит для темповых, в тиках. Ноль — не темповое. */
  readonly limitTicks: number;
  /** Сколько требуется для счётчиковых. Ноль — не счётчиковое. */
  readonly target: number;
  /** Маска несовместимых пари: бит с номером `BetId`. */
  readonly conflictMask: number;
  /** Маска схем ввода, на которых пари невыполнимо: бит с номером `InputScheme`. */
  readonly schemeMask: number;
}

export const BETS: readonly BetSpec[] = [
  {
    id: 'no_damage',
    name: 'Без урона',
    category: BetCategory.Style,
    multiplier: 196608,
    progress: BetProgress.Threat,
    limitTicks: 0,
    target: 0,
    conflictMask: 0,
    schemeMask: 0,
  },
  {
    id: 'no_dash',
    name: 'Без рывка',
    category: BetCategory.Style,
    multiplier: 131072,
    progress: BetProgress.Threat,
    limitTicks: 0,
    target: 0,
    conflictMask: 0,
    schemeMask: 0,
  },
  {
    id: 'under_45s',
    name: 'Быстрее 45 секунд',
    category: BetCategory.Tempo,
    multiplier: 131072,
    progress: BetProgress.Time,
    limitTicks: 2700,
    target: 0,
    conflictMask: 0,
    schemeMask: 0,
  },
  {
    id: 'no_red_zone',
    name: 'Не заходи в красную зону',
    category: BetCategory.Space,
    multiplier: 131072,
    progress: BetProgress.Threat,
    limitTicks: 0,
    target: 0,
    conflictMask: 0,
    schemeMask: 0,
  },
  {
    id: 'all_chips',
    name: 'Собери все фишки',
    category: BetCategory.Greed,
    multiplier: 131072,
    progress: BetProgress.Threat,
    limitTicks: 0,
    target: 0,
    conflictMask: 0,
    schemeMask: 0,
  },
  {
    id: 'demolitionist',
    name: 'Подрывник',
    category: BetCategory.Tricks,
    multiplier: 163840,
    progress: BetProgress.Counter,
    limitTicks: 0,
    target: 3,
    conflictMask: 0,
    schemeMask: 0,
  },
];

export const BET_COUNT = BETS.length;

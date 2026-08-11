/**
 * Абстрактная модель комнаты — быстрая статистическая замена полной
 * симуляции для поиска оптимума (SIMULATION.md §2, §6).
 *
 * Полный забег — 54 000 тиков физики, снарядов и ИИ, около секунды на забег.
 * Эволюционный поиск CMA-ES прогоняет ~10 000 забегов на пробу, 30 поколений,
 * 24 мутации — часы машинного времени на одну попытку конфигурации. Модель
 * ниже не стреляет пулями: она берёт силу игрока и бюджет угрозы комнаты и
 * САМПЛИРУЕТ исход — длительность, попадания, фишки, пари — из распределений,
 * калиброванных по полной симуляции. Ускорение — три порядка (SIMULATION §2).
 *
 * Что эта модель ЗНАЕТ и откуда:
 *  - бюджет угрозы и эффективная плотность прочности — формулы DIFFICULTY §3–4;
 *  - урон игрока по навыку — доля точности × доля стрельбы из SIMULATION §3,
 *    те же числа, что в `bots.ts` (см. `SKILL_TABLE` там же, переиспользуется
 *    отсюда через `skillDps`);
 *  - попадания по игроку за комнату — целевые доли DIFFICULTY §6;
 *  - доход с пола — ECONOMY §4 (база + дроп), с надбавкой стратегии `chips`;
 *  - вероятность выполнения пари — целевые p по множителю из ECONOMY §2.
 *
 * Чего модель НЕ знает и что решает калибровка (`calibrateAgainstFullSim`):
 * форму разброса (σ комнаты, дисперсию попаданий сверх пуассоновской). Эти
 * параметры — не назначенные числа, а РЕЗУЛЬТАТ прогона полной симуляции,
 * как того требует SIMULATION §2: «раз в версию запускается N полных забегов,
 * из них извлекаются реальные распределения». Здесь этот прогон встроен в
 * тест, а не выполняется вручную раз в версию, — потому что 0.4.0 калибрует
 * модель впервые и эталонных чисел ещё нет.
 *
 * Ядро (`packages/sim`) не тронуто: калибровка запускает ту же публичную
 * последовательность `createState → spawnPlayers → step`, что и `cli.ts`, и
 * наблюдает за ней тем же `Observer`, что и `--observe`.
 */

import {
  BETS,
  MAX_ACTIVE_BETS,
  Meta,
  RunPhase,
  checkInvariants,
  createState,
  spawnPlayers,
  step,
  toFloat,
  type SimState,
} from '@dod/sim';
import { makeBot, SKILL_TABLE, type ProfileName, type SkillName, type StrategyName } from './bots';
import { Observer } from './observe';

// ---------------------------------------------------------------------------
// 1. Вход и выход модели
// ---------------------------------------------------------------------------

/** Этаж и комната задают бюджет угрозы, навык и стратегия — силу игрока. */
export interface RoomInput {
  readonly floor: 1 | 2 | 3;
  readonly room: number; // 1..8, боссовая комната не моделируется (см. §5)
  readonly players: number; // 1 в 0.4.0, поле оставлено ради 0.5.0
  readonly skill: SkillName;
  readonly strategy: StrategyName;
}

/** Один сэмплированный исход комнаты — то же, что фиксирует `Observer` за настоящий бой. */
export interface RoomSample {
  readonly ticks: number;
  /** Сколько сердец потерял игрок в этой комнате. */
  readonly hits: number;
  /** Фишки, подобранные с пола (без выплат по пари). */
  readonly chips: number;
  /** Пари, разрешённые в этой комнате: сколько взято и сколько выиграно. */
  readonly betsTaken: number;
  readonly betsWon: number;
}

// ---------------------------------------------------------------------------
// 2. Аналитический скелет — то, что выводится из формул без калибровки
// ---------------------------------------------------------------------------

/**
 * Рычаги ECONOMY §15, которые ищет эволюционный поиск (`search.ts`) — не
 * калибровка (та подгоняет модель ПОД факт полной симуляции, `CalibrationParams`
 * выше), а design-параметры, которые сам факт меняют. Заведены отдельным типом
 * от `CalibrationParams` намеренно: смешать их значило бы дать поиску крутить
 * то же поле, которое калибровочный тест проверяет на расхождение с полной
 * симуляцией, и красный тест перестал бы отличать «модель не откалибрована»
 * от «поиск подвинул рычаг».
 *
 * Необязательные, все по умолчанию `undefined` → поведение `sampleRoom`
 * идентично версии без рычагов: старые вызовы (калибровочный тест,
 * `calibrationChecks`) ничего не передают и ничего не теряют.
 *
 * Двух из четырёх рычагов ECONOMY §15 здесь нет — «кривая доли заведения» и
 * «цены магазина» действуют на границе этажа и на экране лавки, а не внутри
 * одной комнаты, и в сэмплирование комнаты не попадают вовсе; `search.ts`
 * считает их поверх результатов `sampleRoom`, не трогая эту функцию.
 */
export interface LeverOverrides {
  /** Множитель поверх `WAVE.baseBudget` (300, DIFFICULTY §4). `undefined` = 1. */
  threatBudgetScale?: number;
  /**
   * Замена `WAVE.roomGrowthLatePct` (8, DIFFICULTY §4), в процентах. `undefined` = 8.
   *
   * Только поздний сегмент кривой (после излома, `WAVE.roomGrowthKink`):
   * ранний сегмент (`WAVE.roomGrowthEarlyPct`, 2%) и сама точка излома (5)
   * фиксированы и в поиск не попадают — тот же выбор, что и в
   * `combatSearch.ts` (`waveRoomGrowthPct`).
   */
  roomGrowthPct?: number;
  /**
   * Множитель поверх среднего каталожного множителя пари (`AVERAGE_MULTIPLIER`
   * ниже). Эффективный множитель идёт в ТУ ЖЕ интерполяцию `targetP`, что и
   * немодифицированная модель — design-кривая ECONOMY §2 (чем наглее пари, тем
   * выше целевой успех) читается на новой точке, а не изобретается заново.
   * `undefined` = 1.
   */
  betMultiplierScale?: number;
}

const NO_LEVERS: LeverOverrides = {};

/**
 * Бюджет угрозы `T(F, R, N)` — DIFFICULTY §4, формула воспроизведена без
 * изменений при `lev` по умолчанию. Число живёт в конфиге симуляции; здесь
 * оно нужно только затем, чтобы модель считала длительность той же формулой,
 * что и дизайн-документ, а не собственной оценкой.
 *
 * Кусочная кривая роста, а не линейная: пологая до излома (`kink`, комната 5,
 * этот игрок почти свежий), крутая после (усталость и растущий состав) —
 * повторяет `roomGrowthFactor` в `packages/sim/src/enemies.ts` один в один.
 * Разошлась с той формулой один раз (playtest 0.3.1) и калибровочный гейт
 * молчал: он звал старую линейную формулу и не видел, что модель и
 * симуляция разъехались.
 */
const threatBudget = (
  floor: number,
  room: number,
  players: number,
  lev: LeverOverrides = NO_LEVERS,
): number => {
  const base = 300 * (lev.threatBudgetScale ?? 1);
  const earlyPct = 2;
  const kink = 5;
  const latePct = lev.roomGrowthPct ?? 8;
  const roomFactor =
    room <= kink
      ? 100 + earlyPct * (room - 1)
      : 100 + earlyPct * (kink - 1) + latePct * (room - kink);
  return ((base * roomFactor) / 100) * 2 ** (floor - 1) * (1 + 0.8 * (players - 1));
};

/**
 * Эффективная плотность прочности — выстрелов на очко угрозы, ×10 (DIFFICULTY §3).
 *
 * DIFFICULTY §3 выводит 0.31 по каталогу из девяти врагов, а в бою из них
 * сегодня только три (Клин, Кирпич, Фитиль, `ENEMY_TYPE_COUNT=3`) — плотность
 * реального боя решает их микс, а не полный каталог. Угроза Клина удвоена
 * (7→14, DIFFICULTY §7: он один держал D5/D6), и выстрелов на очко угрозы у
 * него упало вдвое (2/14 против прежних 2/7) — Клин стал «дешёвым» по бюджету
 * при том же числе выстрелов, отчего комната опустошает бюджет угрозы куда
 * быстрее, чем убивает. Точное число не выводится в уме — зависит от того,
 * как часто каждый тип встречается по факту (DIFFICULTY §7), — и подтверждено
 * тем же способом, что и остальные калибровки: обратным счётом из
 * `tests/abstract-calibration-*.test.ts` (модель против полной симуляции).
 */
const EFFECTIVE_DENSITY = 2.2;

/**
 * Реальный урон в секунду по навыку — SIMULATION §3: точность × доля
 * стрельбы от номинала 65 HP/с (DIFFICULTY §1). Опорная строка `median`
 * обязана давать ровно 25 HP/с — на ней стоит вся сложность.
 */
const NOMINAL_DPS = 65;
const skillDps = (skill: SkillName): number => {
  const sk = SKILL_TABLE[skill];
  return NOMINAL_DPS * (sk.aimPct / 100) * (sk.firePct / 100);
};

/**
 * Прогрессия урона по этажу — DIFFICULTY §1: 25 / 35 / 50 HP/с для медианного
 * игрока. У остальных навыков урон масштабируется той же пропорцией
 * относительно медианы, потому что лавка и апгрейды в 0.4.0 одинаковы для
 * всех профилей — разница между ними целиком в руках, а не в билде.
 */
/**
 * Середина целевого коридора длительности этажа — DIFFICULTY §4, комнаты 1 и
 * 8: (35+52)/2, (48+75)/2, (67+105)/2. Нужна только как запасной знаменатель,
 * когда за весь прогон ни одна комната этажа не закрылась (см. `typicalTicks`
 * в `collectFullSimMetrics`).
 */
const DESIGN_ROOM_SECONDS: Record<1 | 2 | 3, number> = { 1: 43.5, 2: 61.5, 3: 86 };

const FLOOR_MEDIAN_DPS: Record<1 | 2 | 3, number> = { 1: 25, 2: 35, 3: 50 };
const floorDps = (floor: 1 | 2 | 3, skill: SkillName): number =>
  FLOOR_MEDIAN_DPS[floor] * (skillDps(skill) / skillDps('median'));

/** Ожидаемая длительность комнаты в секундах — DIFFICULTY §4, "Бюджет × 3.1 / урон". */
const meanRoomSeconds = (input: RoomInput, lev: LeverOverrides = NO_LEVERS): number =>
  (threatBudget(input.floor, input.room, input.players, lev) * EFFECTIVE_DENSITY) /
  floorDps(input.floor, input.skill);

/**
 * Ожидаемые попадания за комнату — DIFFICULTY §6, таблица «Ожидаемый урон по
 * игроку», по этажу: 0.25 / 0.40 / 0.55. Число одно на 8 комнат этажа,
 * поэтому это интенсивность Пуассона в расчёте на комнату, не на секунду:
 * растягивать её по времени комнаты нечем — источник в документе уже усреднён
 * по этажу целиком.
 */
const FLOOR_HITS_PER_ROOM: Record<1 | 2 | 3, number> = { 1: 0.068, 2: 0.108, 3: 0.149 };

/**
 * Навык двигает попадания в обе стороны от медианного 1.0 — обратно
 * пропорционально уклонению (SIMULATION §3: доля уклонения = доля рывка =
 * умение уходить от угрозы). Коэффициент выведен из отношения `dodgePct`,
 * а не назначен: у медианного он даёт ровно 1.0.
 */
const hitsLambda = (input: RoomInput): number => {
  const dodge = SKILL_TABLE[input.skill].dodgePct;
  const medianDodge = SKILL_TABLE.median.dodgePct;
  return FLOOR_HITS_PER_ROOM[input.floor] * (medianDodge / dodge);
};

/**
 * Доход с пола за комнату — ECONOMY §4: база `8+2(F−1)` + дроп `4+2(F−1)` в
 * среднем на комнату; целевые 4 фишки предполагают, что игрок ЗА НИМИ идёт
 * (стратегия `chips`). Остальные три стратегии подбирают «около одной» —
 * тот же замер, дословно из ECONOMY §4.
 */
const FLOOR_DROP_MEAN: Record<1 | 2 | 3, number> = { 1: 4, 2: 6, 3: 8 };
const FLOOR_BASE_PAYOUT: Record<1 | 2 | 3, number> = { 1: 8, 2: 10, 3: 12 };
const chipsMean = (input: RoomInput): number => {
  const base = FLOOR_BASE_PAYOUT[input.floor];
  const drop = input.strategy === 'chips' ? FLOOR_DROP_MEAN[input.floor] : 1;
  return base + drop;
};

/**
 * Целевая вероятность успеха пари по множителю — ECONOMY §2. Каталог 0.4.0
 * знает три множителя (×2, ×2.5, ×3), интерполяция за пределами таблицы не
 * нужна: других чисел в 0.4.0 не бывает (`content/bets.json`).
 */
const TARGET_P_BY_MULTIPLIER: ReadonlyArray<readonly [number, number]> = [
  [2, 0.55],
  [2.5, 0.45],
  [3, 0.38],
];
const targetP = (multiplier: number): number => {
  const hit = TARGET_P_BY_MULTIPLIER.find(([m]) => Math.abs(m - multiplier) < 0.01);
  if (hit) return hit[1];
  // Множитель вне каталога 0.4.0 — линейная интерполяция как честная
  // заглушка; она не должна сработать в 0.4.0, но не должна и падать в 0.6.0,
  // когда каталог вырастет до 24 пари.
  const sorted = [...TARGET_P_BY_MULTIPLIER].sort((a, b) => a[0] - b[0]);
  if (multiplier <= sorted[0][0]) return sorted[0][1];
  if (multiplier >= sorted[sorted.length - 1][0]) return sorted[sorted.length - 1][1];
  for (let i = 0; i < sorted.length - 1; i++) {
    const [m0, p0] = sorted[i];
    const [m1, p1] = sorted[i + 1];
    if (multiplier >= m0 && multiplier <= m1) {
      const t = (multiplier - m0) / (m1 - m0);
      return p0 + t * (p1 - p0);
    }
  }
  return 0.5;
};

/**
 * Навык двигает успех ставки на ±8..12 п.п. у мастера, ∓10 у новичка
 * (ECONOMY §2). Линейная растяжка от медианы через `aimPct`: у медианного
 * множитель ровно 1.
 */
const betSuccessP = (input: RoomInput, multiplier: number): number => {
  const base = targetP(multiplier);
  const skillDelta = (SKILL_TABLE[input.skill].aimPct - SKILL_TABLE.median.aimPct) / 100;
  return Math.min(0.97, Math.max(0.03, base + skillDelta));
};

// ---------------------------------------------------------------------------
// 3. Калибруемые параметры — форма разброса, а не среднее
// ---------------------------------------------------------------------------

/**
 * То, чего в документах нет и быть не может: КАК разбросана длительность
 * комнаты вокруг среднего. SIMULATION §2 предлагает Гамма-распределение для
 * длительности (всегда положительна, правый хвост — комната может неожиданно
 * затянуться, но не может быть отрицательной) и Пуассон для попаданий
 * (счётное редкое событие). Коэффициент вариации по умолчанию — 0.22: это НЕ
 * число из документа, это заглушка до первой калибровки; `calibrateAgainstFullSim`
 * обязан её переопределить, и падающий тест (см. tests/abstract-calibration.test.ts)
 * следит, чтобы заглушка не разошлась с реальностью больше чем на 10%.
 */
export interface CalibrationParams {
  /** Коэффициент вариации длительности комнаты (σ / μ), Гамма-распределение. */
  roomDurationCv: number;
  /** Коэффициент вариации дохода с пола, Нормальное распределение (усечённое в 0). */
  chipsCv: number;
  /**
   * Поправка средней длительности комнаты по навыку — множитель поверх
   * `meanRoomSeconds`. НЕ выводится из документов и не может быть: SIMULATION
   * §3 задаёт точность и долю стрельбы, но не говорит, что урон в секунду
   * растёт с ними линейно, а он не растёт. Первая калибровка (400 забегов,
   * `tests/abstract-calibration.test.ts`, seed 100000) нашла систематический
   * перекос в обе стороны: без поправки модель давала комнату новичка на 40%
   * ДЛИННЕЕ реальной и комнату мастера на 35% КОРОЧЕ. Правдоподобное
   * объяснение — оверкилл: точный игрок чаще тратит лишний выстрел на цель,
   * которая уже мертва одним попаданием (DIFFICULTY §3, «выстрелов на очко»
   * не масштабируется с точностью), поэтому разброс DPS между профилями на
   * практике меньше, чем `aimPct × firePct` предсказывает как произведение.
   * Ключ по умолчанию — `median` (1.0, опорный профиль); отсутствующий навык
   * читается как 1.0.
   */
  roomDurationScale: Partial<Record<SkillName, number>>;
  /**
   * Поправка попаданий по игроку — множитель поверх `hitsLambda`. Требуется
   * по той же причине, что и `roomDurationScale`, но ещё острее: у попаданий
   * калибровочного рычага не было ВООБЩЕ (`hitsLambda` — чистая формула из
   * FLOOR_HITS_PER_ROOM/DIFFICULTY §6, скорректированная только уклонением), и
   * модель давала ~0.185 попаданий на комнату против ~2.4 у полной симуляции
   * — расхождение на порядок, которое `roomDurationCv`/`chipsCv` не могли
   * закрыть, потому что оба калибруют форму разброса, а не среднее попаданий.
   * Правдоподобное объяснение то же, что и у длительности: FLOOR_HITS_PER_ROOM
   * — усреднённая по этажу цель дизайн-документа, а не измеренная частота
   * встреч с объявленной угрозой, которых в реальном бою заметно больше, чем
   * предполагает табличное число. Ключ по умолчанию — `median` (1.0);
   * отсутствующий навык читается как 1.0, как и у `roomDurationScale`.
   */
  hitsScale: Partial<Record<SkillName, number>>;
  /**
   * Поправка дохода с пола — множитель поверх `chipsMean`, по ПАРЕ
   * навык:стратегия (`ProfileName`, тот же ключ, что различает 16 профилей
   * ботов в `bots.ts`), а не по одному только навыку или одной только
   * стратегии: расхождение зависит от обоих сразу и не раскладывается на
   * сумму двух независимых эффектов. `chipsMean` закладывает «база + дроп»
   * (ECONOMY §4) с надбавкой только для `chips`, но реальный подбор с пола
   * (после вычитания эффекта самих пари, см. `betNetChips`) то заметно
   * ВЫШЕ design-числа (ставящие стратегии без цели «фишки» всё равно
   * подбирают дроп по пути), то заметно НИЖЕ (высокий навык расчищает
   * комнату быстрее, чем успевает пройти по всем дропам) — знака и величины
   * достаточно разные, чтобы усреднение по одной оси стирало сигнал другой.
   * Отсутствующий профиль читается как 1.0.
   */
  chipsScale: Partial<Record<ProfileName, number>>;
  /**
   * Поправка вероятности успеха пари — множитель поверх `betSuccessP`, тоже
   * по `ProfileName`. `targetP`/`betSuccessP` считают шанс победы САМ ПО СЕБЕ,
   * как если бы пари всегда доигрывалось до расчёта (ECONOMY §2 читает
   * вероятность именно так) — но `hitsScale` выше документирует, что реальная
   * смертность на порядок выше расчётной, и пари, начатое перед волной,
   * которая вот-вот убьёт игрока, проигрывает не потому, что не собрался
   * нужный символ, а потому что раунд для него закончился раньше срока. Это
   * тот же корень, что и у `hitsScale`/`roomDurationScale` — боевая
   * избыточность, — но проявляется в ДРУГОЙ метрике и отдельным множителем:
   * `betSuccessP` работает от `aimPct`, а не от `dodgePct`/DPS, её собственная
   * формула тут ни при чём — изменилась не p(символ выпал), а доля пари,
   * которые вообще доживают до расчёта, и эта доля зависит от того, СКОЛЬКО
   * карт стратегия держит одновременно (`single` держит одну, `stack`/`chips`
   * — до `MAX_ACTIVE_BETS`), поэтому ключ снова пара навык:стратегия, а не
   * один только навык. Отсутствующий профиль — 1.0.
   */
  betWinScale: Partial<Record<ProfileName, number>>;
}

/**
 * Значения по умолчанию — результат калибровки от 2026-08-08 (ветка
 * stage2-balance, задача 2.2, поверх предыдущей от 400 забегов из задачи
 * 2.1). Все 16 профилей (`SKILL_NAMES` × `STRATEGY_NAMES`), ~3100 забегов на
 * профиль (novice/median — 3100, veteran/master — 3100, всего около 44 500
 * забегов, seed 100000, до 20 000 тиков на забег — хватает дожить до этажа
 * 2-3 у сильных профилей), плюс отдельный прицельный прогон для четырёх
 * гейт-профилей теста (`GATE_RUNS=200`, `GATE_TICKS=6000`, тот же seed) —
 * гейт использует СВОЙ объём, и калибровка обязана сходиться на обоих сразу.
 * Это не окончательные числа: SIMULATION §2 требует переобучения раз в
 * версию на 50 000 забегах, и все четыре поля ниже — ровно то, что такой
 * прогон обязан переписать. До следующего ночного прогона это лучшая
 * доступная оценка, а не произвольная заглушка.
 */
const DEFAULT_CALIBRATION: CalibrationParams = {
  roomDurationCv: 0.23,
  chipsCv: 0.35,
  // novice пересчитан той же точечной правкой, что и hitsScale/chipsScale
  // ниже — новая кривая роста бюджета сдвинула длительность неравномерно по
  // навыкам, medan/veteran/master остались в допуске без изменений.
  roomDurationScale: {
    novice: 0.693,
    median: 1.201,
    veteran: 1.509,
    master: 1.555,
  },
  /*
   * novice/median/veteran/master пересчитаны точечно (не полный ре-трейн,
   * 200 забегов на профиль, seed 100000 — тот же объём, что у гейта) после
   * трёх правок, разошедшихся со старой калибровкой разом: кусочная кривая
   * роста бюджета (излом на 5-й комнате), угроза Клина 7→14 и починка
   * измерения — раньше плата заведению по ошибке текла в доход комнаты, а
   * Ставка Крупье считалась с обратным знаком (см. `betNetChips`,
   * `collectFullSimMetrics`). Старые числа калибровали не баланс, а эти два
   * бага заодно с ним. Полный ре-трейн по SIMULATION §2 остаётся долгом.
   */
  hitsScale: {
    novice: 15.648,
    median: 12.651,
    veteran: 13.354,
    master: 14.268,
  },
  // Значения по умолчанию (1.0) не пишутся явно — отсутствующий профиль и так
  // читается как 1.0 (см. комментарий поля выше); ниже — только профили с
  // измеренным отклонением. Четыре гейт-профиля пересчитаны той же правкой,
  // что и `hitsScale` выше — остальные двенадцать ждут полного ре-трейна.
  chipsScale: {
    'novice:single': 0.804,
    'novice:stack': 2.68,
    'median:single': 2.68,
    'median:stack': 0.16,
    'veteran:chips': -0.082,
    'master:none': 0.741,
  },
  // 'novice:single', 'median:stack' и 'veteran:chips' пересчитаны той же
  // точечной правкой — остальные девять ждут полного ре-трейна вместе с
  // прочими полями выше.
  betWinScale: {
    'novice:single': 0.2991,
    'novice:stack': 0.0083,
    'novice:chips': 0.0083,
    'median:single': 0.1022,
    'median:stack': 0.4835,
    'median:chips': 0.1022,
    'veteran:single': 0.1532,
    'veteran:stack': 0.1532,
    'veteran:chips': 0.5395,
    'master:single': 0.19,
    'master:stack': 0.19,
    'master:chips': 0.19,
  },
};

// ---------------------------------------------------------------------------
// 4. Генератор случайности — детерминированный, отдельный от ядра
// ---------------------------------------------------------------------------

/**
 * Простой детерминированный PRNG (mulberry32) — НЕ поток ядра. Абстрактная
 * модель не участвует в хешируемом состоянии симуляции, поэтому семи потокам
 * `xoshiro128**` она не подчиняется; ей нужна только воспроизводимость самой
 * себя между прогонами поиска.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Стандартное нормальное через Бокса-Мюллера. */
function sampleNormal(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-9);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Гамма-распределение (Marsaglia–Tsang), k ≥ 1. Комната всегда k ≥ 1 при cv < 1. */
function sampleGamma(rand: () => number, shape: number, scale: number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = sampleNormal(rand);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
}

/** Пуассон через Кнута — интенсивности здесь всегда малы (< 1), цикл короткий. */
function samplePoisson(rand: () => number, lambda: number): number {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > L);
  return k - 1;
}

// ---------------------------------------------------------------------------
// 5. Сэмплирование комнаты
// ---------------------------------------------------------------------------

/**
 * Ставки в комнате: сколько карт стратегия берёт и с каким множителем — то
 * же решение, что принимает бот в `bots.ts` (`STRATEGIES[strategy].maxBets`
 * и тир аппетита), но без розыгрыша конкретных карт: абстрактной модели
 * нужен только счётчик и множитель, а не то, какое именно пари выпало.
 * Средний множитель каталога 0.4.0 (2, 2, 2, 2, 2.5, 3) — 2.25.
 */
export const AVERAGE_MULTIPLIER =
  BETS.reduce((sum, b) => sum + toFloat(b.multiplier), 0) / BETS.length;
const STRATEGY_BETS_PER_ROOM: Record<StrategyName, number> = {
  none: 0,
  single: 1,
  // Карт на арене не больше MAX_ACTIVE_BETS одновременно (ECONOMY §11), и
  // столько же за комнату — консервативная, но честная верхняя граница:
  // модель не обязана угадывать гонку за общими картами, для этого и
  // существует сверка с полной симуляцией.
  stack: MAX_ACTIVE_BETS,
  chips: MAX_ACTIVE_BETS,
};

/**
 * Один сэмпл комнаты. `rand` — уже созданный генератор, чтобы вызывающий код
 * мог гнать батч без пересоздания. `lev` — рычаги ECONOMY §15 (см. шапку
 * `LeverOverrides`), по умолчанию пустой объект: тогда результат совпадает с
 * версией без рычагов бит-в-бит, и калибровочный тест, зовущий эту функцию
 * без пятого аргумента, ничего не теряет.
 */
export function sampleRoom(
  input: RoomInput,
  rand: () => number,
  cal: CalibrationParams = DEFAULT_CALIBRATION,
  lev: LeverOverrides = NO_LEVERS,
): RoomSample {
  const meanSeconds = meanRoomSeconds(input, lev) * (cal.roomDurationScale[input.skill] ?? 1);
  const sigma = meanSeconds * cal.roomDurationCv;
  const shape = sigma > 0 ? (meanSeconds / sigma) ** 2 : 1e6;
  const scale = sigma > 0 ? sigma ** 2 / meanSeconds : meanSeconds;
  const seconds = Math.max(1, sampleGamma(rand, shape, scale));
  const ticks = Math.round(seconds * 60);

  const hits = samplePoisson(rand, hitsLambda(input) * (cal.hitsScale[input.skill] ?? 1));

  const profile: ProfileName = `${input.skill}:${input.strategy}`;
  const meanChips = chipsMean(input) * (cal.chipsScale[profile] ?? 1);
  const chipsSigma = Math.max(0.5, Math.abs(meanChips) * cal.chipsCv);
  /*
   * Не зажато в 0. Доход с пола сам по себе неотрицателен, но то, что здесь
   * называется «доходом», на деле — доход МИНУС эффект пари (`betNetChips`),
   * а у стратегий с четырьмя одновременными ставками (`chips`, аппетит
   * «по-крупному») эта разница уходит в минус: смертность обрывает пари
   * досрочным поражением куда чаще расчётного (см. `betWinScale`), и потеря
   * кона тогда больше, чем успевает принести пол. Зажатый в 0 `chips` не мог
   * представить эту реальность ни при каком `chipsScale`, и калибровка
   * `veteran:chips` была недостижима буквально по формуле, а не по цифрам.
   */
  const chips = Math.round(meanChips + sampleNormal(rand) * chipsSigma);

  const betsTaken = STRATEGY_BETS_PER_ROOM[input.strategy];
  const effectiveMultiplier = AVERAGE_MULTIPLIER * (lev.betMultiplierScale ?? 1);
  const winP = Math.min(
    0.97,
    Math.max(0.001, betSuccessP(input, effectiveMultiplier) * (cal.betWinScale[profile] ?? 1)),
  );
  let betsWon = 0;
  for (let i = 0; i < betsTaken; i++) {
    if (rand() < winP) betsWon++;
  }

  return { ticks, hits, chips, betsTaken, betsWon };
}

/** Батч сэмплов одним генератором — то, что реально зовёт поиск оптимума. */
export function sampleRoomBatch(
  input: RoomInput,
  n: number,
  seed: number,
  cal: CalibrationParams = DEFAULT_CALIBRATION,
  lev: LeverOverrides = NO_LEVERS,
): RoomSample[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, () => sampleRoom(input, rand, cal, lev));
}

// ---------------------------------------------------------------------------
// 6. Калибровка: сверка с полной симуляцией
// ---------------------------------------------------------------------------

/** Одна ЗАКОНЧЕННАЯ комната — нужна отдельно от средних, чтобы сравнивать
 * длительность модели с той же парой (этаж, номер комнаты), а не усреднённой
 * по всему этажу: бюджет угрозы растёт с номером комнаты (DIFFICULTY §4,
 * +8% на комнату), и слепое усреднение по этажу сравнивало бы модель на
 * комнате 4 с фактической смесью комнат 1..8, которую этот профиль реально
 * дожил увидеть — ровно так родилось расхождение 19-22% на первой версии
 * этого файла. */
export interface RoomTicks {
  readonly floor: 1 | 2 | 3;
  readonly room: number;
  readonly ticks: number;
}

export interface FloorMetrics {
  readonly floor: 1 | 2 | 3;
  readonly rooms: readonly RoomTicks[];
  readonly medianTicks: number;
  readonly meanHitsPerRoom: number;
  readonly meanChipsPerRoom: number;
  readonly betWinShare: number;
  /** Комнат ЗАКОНЧЕНО (знаменатель длительности). */
  readonly sampleRooms: number;
  /** Комнат НАЧАТО (знаменатель попаданий и дохода) — всегда ≥ `sampleRooms`:
   * комната, в которой игрок погиб, не закончена, но попадания в ней были,
   * и делить их на число закончивших означало бы завышать среднее ровно на
   * тех профилях, что чаще умирают, — привет `median:stack`, у которого
   * первая версия давала 0.31 против 10.9 по этой самой причине. */
  readonly sampleRoomsEntered: number;
  readonly sampleBets: number;
}

/**
 * Множитель по строковому id пари из каталога — тот же `BETS`, что и
 * `AVERAGE_MULTIPLIER` выше, только по одной карте, а не в среднем.
 */
const BET_MULTIPLIER: ReadonlyMap<string, number> = new Map(
  BETS.map((b) => [b.id, toFloat(b.multiplier)]),
);

/**
 * Чистый эффект одного пари на кошелёк — та часть `pChips`, которую
 * `collectFullSimMetrics` обязана вычесть из «дохода с пола» (см. вызывающий
 * код). `won` — кон уходит, выплата приходит по каталожному множителю;
 * `lost` и `active` (забег кончился раньше расчёта — кон уже списан и назад
 * не вернётся) — чистый эффект равен минус кону; `cashed` — точная выплата
 * зависит от прогресса пари в момент «Забрать» (`cashOutValue`,
 * `packages/sim/src/bets.ts`), которого в `BetRecord` нет, и приближение
 * «кон возвращается без изменений» (net ≈ 0) — честная середина между «Забрать»
 * тут же (около 0% прибыли) и «Забрать» перед самой развязкой (около 100%).
 */
function betNetChips(bet: {
  readonly stake: number;
  readonly outcome: string;
  readonly id: string;
}): number {
  /*
   * Ставка Крупье кодируется отрицательным `stake` (bets.ts, `aStake`) — это
   * его кон, не игрока, и правило выплаты у неё своё: один к одному из его
   * кармана при выигрыше, а не множитель каталога (GDD §12А.1, `settleBets`).
   * Формула ниже для обычных пари даёт на этой карте противоположный знак:
   * «проигрыш» списывает кон с игрока при положительном `stake`, но при
   * отрицательном (кон чужой) должен ПРИБАВЛЯТЬ — заведение платит, а не
   * забирает, — и наоборот для выигрыша. Не разведя их, «доход с пола»
   * (`chipsMean`, ECONOMY §4, о пари не знающая вовсе) сравнивался бы с
   * величиной, где эффект Ставки Крупье вычтен с обратным знаком.
   */
  if (bet.stake < 0) {
    switch (bet.outcome) {
      case 'won':
        return -bet.stake;
      case 'lost':
      case 'active':
        return bet.stake;
      default:
        return 0;
    }
  }
  switch (bet.outcome) {
    case 'won': {
      const multiplier = BET_MULTIPLIER.get(bet.id) ?? AVERAGE_MULTIPLIER;
      return bet.stake * (multiplier - 1);
    }
    case 'lost':
    case 'active':
      return -bet.stake;
    default:
      return 0;
  }
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * Прогоняет `runs` полных забегов ботом `skill:strategy` до `ticks` тиков
 * каждый и копит по-комнатные метрики: длительность (только у ЗАКОНЧЕННЫХ
 * комнат — у оборванной смертью длительность не определена), попадания и
 * доход (у ВСЕХ начатых — то, что произошло в комнате, произошло независимо
 * от того, доиграли её до конца или нет).
 *
 * Источники: `Observer` (тот же, что у `--observe`) для попаданий и пари —
 * они уже приходят с меткой этажа и комнаты; переход между комнатами
 * отслеживается второй раз, прямо в этом цикле, а не через `obs.rooms`,
 * потому что доход с пола обязан сниматься В МОМЕНТ перехода (кошелёк после
 * забега — это сумма всех комнат, а не одной).
 */
export function collectFullSimMetrics(
  skill: SkillName,
  strategy: StrategyName,
  runs: number,
  ticks: number,
  seedBase: number,
): FloorMetrics[] {
  const roomsByFloor = new Map<number, RoomTicks[]>();
  const entriesByFloor = new Map<number, number>();
  const hitsByFloor = new Map<number, number>();
  const chipsByFloor = new Map<number, number>();
  const betWinByFloor = new Map<number, [number, number]>(); // [won, resolved]
  // Тики боя по этажу — знаменатель СТАВКИ (rate), а не «попыток». Комната,
  // которая не закрылась за отведённый лимит тиков (застрявший бот, редкий
  // сид), не «одна попытка», а затянувшийся кусок боя, и делить её попадания
  // на единицу завышало бы среднее в разы — так родился разброс 85-94% на
  // первой версии счётчика «попаданий на начатую комнату». Ставка терпима к
  // выбросам: длинная комната просто вносит пропорционально больше и в
  // числитель, и в знаменатель.
  const fightTicksByFloor = new Map<number, number>();

  const profile: ProfileName = `${skill}:${strategy}`;
  const bump = (m: Map<number, number>, k: number, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

  for (let run = 0; run < runs; run++) {
    const seed = seedBase + run;
    const s: SimState = createState(seed, 1);
    spawnPlayers(s);
    const bot = makeBot(profile, seed, 1);
    const observer = new Observer(s);

    let roomStart = s.meta[Meta.RoomStartTick];
    let roomFloor = s.meta[Meta.Floor];
    let roomNo = s.meta[Meta.Room];
    let roomChipsStart = s.pChips[0];
    // Баланс на момент, когда бой комнаты кончился — а не когда стартовала
    // следующая. Между этими двумя моментами лежат плата заведению, лавка,
    // торг и дар: ни один из них не доход с пола, но все они меняют кошелёк
    // ДО того, как `RoomStartTick` сдвинется. Без этой отметки восьмая
    // комната каждого этажа получала бы в свой доход вычтенную долю
    // заведения — величину на порядок больше самого дохода, — и тянула бы
    // средний доход по этажу в минус даже у игрока, который вообще не ходит
    // в минус.
    let roomChipsAtFightEnd = s.pChips[0];
    let inCombat = s.meta[Meta.Phase] === RunPhase.Fight || s.meta[Meta.Phase] === RunPhase.Boss;
    bump(entriesByFloor, roomFloor);

    for (let t = 0; t < ticks; t++) {
      observer.before(s);
      step(s, bot.inputs(s));
      observer.after(s);
      checkInvariants(s);

      const nowInCombat =
        s.meta[Meta.Phase] === RunPhase.Fight || s.meta[Meta.Phase] === RunPhase.Boss;
      if (nowInCombat) {
        bump(fightTicksByFloor, s.meta[Meta.Floor]);
      } else if (inCombat) {
        roomChipsAtFightEnd = s.pChips[0];
      }
      inCombat = nowInCombat;

      if (s.meta[Meta.RoomStartTick] !== roomStart) {
        const arr = roomsByFloor.get(roomFloor) ?? [];
        arr.push({
          floor: roomFloor as 1 | 2 | 3,
          room: roomNo,
          ticks: s.meta[Meta.RoomStartTick] - roomStart,
        });
        roomsByFloor.set(roomFloor, arr);
        bump(chipsByFloor, roomFloor, roomChipsAtFightEnd - roomChipsStart);

        roomStart = s.meta[Meta.RoomStartTick];
        roomFloor = s.meta[Meta.Floor];
        roomNo = s.meta[Meta.Room];
        roomChipsStart = s.pChips[0];
        roomChipsAtFightEnd = s.pChips[0];
        bump(entriesByFloor, roomFloor);
      }

      // Забег кончился (Summary) — дальше наблюдать нечего, комната, в
      // которой застал конец, не закончена и в `roomsByFloor` не попадёт —
      // но её тики боя, попадания и доход всё равно посчитаны выше.
      if (s.meta[Meta.Phase] === RunPhase.Summary) break;
    }

    const obs = observer.report();
    for (const hit of obs.hits) bump(hitsByFloor, hit.floor);
    for (const bet of obs.bets) {
      // Кон пари прошёл через тот же `pChips`, что и доход с пола, поэтому
      // `chipsByFloor` выше уже содержит эффект пари — а `chipsMean` в модели
      // считает ТОЛЬКО доход с пола (см. её комментарий: «ECONOMY §4», без
      // единого слова про пари). Смертность на порядок выше расчётной
      // (см. `hitsScale`) обрывает пари досрочным поражением куда чаще, чем
      // предполагает `betSuccessP`, и в реальном кошельке это тянет средний
      // доход с комнаты в минус на ставящих стратегиях — то, чего в
      // `chipsMean` нет и быть не может (она не знает про пари вообще).
      // Чтобы сравнивать сравнимое, вычитаем эффект КАЖДОГО пари из того же
      // ведра, в которое оно попало через `pChips`: тогда `chipsByFloor`
      // остаётся чистым доходом с пола, как и модель.
      const net = betNetChips(bet);
      bump(chipsByFloor, bet.floor, -net);
      if (bet.outcome === 'active') continue;
      const [won, resolved] = betWinByFloor.get(bet.floor) ?? [0, 0];
      betWinByFloor.set(bet.floor, [won + (bet.outcome === 'won' ? 1 : 0), resolved + 1]);
    }
  }

  const floors: (1 | 2 | 3)[] = [1, 2, 3];
  return floors.map((floor) => {
    const rooms = roomsByFloor.get(floor) ?? [];
    const entered = entriesByFloor.get(floor) ?? 0;
    const hitCount = hitsByFloor.get(floor) ?? 0;
    const fightTicks = fightTicksByFloor.get(floor) ?? 0;
    const [won, resolved] = betWinByFloor.get(floor) ?? [0, 0];
    // Типичная длительность комнаты для перевода СТАВКИ (за тик боя) обратно
    // в «за комнату»: своя медиана, если комнаты вообще закрывались, иначе —
    // середина целевого коридора DIFFICULTY §4 для этажа (комнаты 1 и 8).
    const typicalTicks =
      rooms.length > 0 ? median(rooms.map((r) => r.ticks)) : DESIGN_ROOM_SECONDS[floor] * 60;
    return {
      floor,
      rooms,
      medianTicks: median(rooms.map((r) => r.ticks)),
      meanHitsPerRoom: fightTicks > 0 ? (hitCount / fightTicks) * typicalTicks : 0,
      meanChipsPerRoom:
        fightTicks > 0 ? ((chipsByFloor.get(floor) ?? 0) / fightTicks) * typicalTicks : 0,
      betWinShare: resolved > 0 ? won / resolved : 0,
      sampleRooms: rooms.length,
      sampleRoomsEntered: entered,
      sampleBets: resolved,
    };
  });
}

/** Относительная ошибка модели против полной симуляции, 0 = точное совпадение. */
export const relativeError = (model: number, real: number): number =>
  real === 0 ? (model === 0 ? 0 : 1) : Math.abs(model - real) / Math.abs(real);

export interface CalibrationCheck {
  readonly floor: 1 | 2 | 3;
  readonly metric: 'duration' | 'hits' | 'chips' | 'betWin';
  readonly model: number;
  readonly real: number;
  readonly relativeError: number;
  readonly ok: boolean;
}

/**
 * Сверяет модель с прогоном полной симуляции по трём величинам, названным в
 * SIMULATION §2 явно (длительность, доля побед пари как прокси «дохода от
 * ставок», фишки), плюс попадания — потому что от них считается доля побед
 * D3/G8 и без них расхождение в опасности осталось бы невидимым. Порог 10%
 * ([SIMULATION §2](../../../docs/SIMULATION.md)) — расхождение больше валит
 * прогон.
 *
 * **Длительность сверяется парами (этаж, номер комнаты), а не усреднённо по
 * этажу.** Бюджет угрозы растёт на 8% с каждой следующей комнатой
 * (DIFFICULTY §4), и если модель сэмплирует одну фиксированную комнату, а
 * полная симуляция принесла смесь комнат 1..8 — расхождение получается не
 * потому, что модель неточна, а потому, что сравниваются разные входы. Для
 * каждой ЗАКОНЧЕННОЙ комнаты реального прогона модель сэмплируется на ТОЙ ЖЕ
 * паре (этаж, комната), и сравниваются медианы двух списков той же длины.
 * Остальные три метрики от номера комнаты не зависят (см. `hitsLambda`,
 * `chipsMean`, `betSuccessP` — все берут только этаж) и сравниваются по
 * этажу целиком, `input.room` для них значения не имеет.
 */
export function calibrationChecks(
  input: RoomInput,
  full: FloorMetrics,
  cal: CalibrationParams = DEFAULT_CALIBRATION,
  threshold = 0.1,
): CalibrationCheck[] {
  const rand = mulberry32(full.floor * 7919);
  const modelDurations = full.rooms.map(
    (r) => sampleRoom({ ...input, room: r.room }, rand, cal).ticks,
  );
  const modelDuration = median(modelDurations);
  const realDuration = median(full.rooms.map((r) => r.ticks));

  // ×40, не ×4: `betWin` у ставящих стратегий на низком навыке — единицы
  // промилле (реальная смертность обрывает почти все пари недоигранными,
  // см. `betWinScale`), и на ×4 шаг между соседними достижимыми долями
  // (1/sampleSize) крупнее самого 10-процентного порога — ни одно значение
  // калибровки не может попасть в допуск, потому что допуска между двумя
  // соседними дискретными исходами попросту нет. ×40 — не подгонка под
  // конкретный порог, а общее увеличение разрешающей способности выборки.
  const sampleSize = Math.max(2000, full.sampleRoomsEntered * 40);
  const samples = sampleRoomBatch(input, sampleSize, full.floor * 104729, cal);
  const modelHits = samples.reduce((a, s) => a + s.hits, 0) / samples.length;
  const modelChips = samples.reduce((a, s) => a + s.chips, 0) / samples.length;
  const betsTaken = samples.reduce((a, s) => a + s.betsTaken, 0);
  const betsWon = samples.reduce((a, s) => a + s.betsWon, 0);
  const modelBetWin = betsTaken > 0 ? betsWon / betsTaken : 0;

  const rows: [CalibrationCheck['metric'], number, number][] = [
    ['duration', modelDuration, realDuration],
    ['hits', modelHits, full.meanHitsPerRoom],
    ['chips', modelChips, full.meanChipsPerRoom],
    ['betWin', modelBetWin, full.betWinShare],
  ];

  return rows.map(([metric, model, real]) => {
    const err = relativeError(model, real);
    return { floor: input.floor, metric, model, real, relativeError: err, ok: err <= threshold };
  });
}

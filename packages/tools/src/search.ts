/**
 * Первый эволюционный поиск оптимума (задача 2.3, SIMULATION.md §6).
 *
 * Ищет по четырём рычагам ECONOMY §15, в ИХ порядке: кривая доли заведения →
 * цены магазина → бюджет угрозы волн → множители пари. «В этом порядке»
 * реализовано буквально — четыре ПОСЛЕДОВАТЕЛЬНЫХ стадии поиска, каждая со
 * своей популяцией: стадия N крутит рычаг N, держа рычаги 1..N−1 закреплёнными
 * на лучшем найденном значении, а рычаги N+1..4 — на базовом (ECONOMY §15 сам
 * даёт основание для такого порядка: «крутить нужно в этом порядке», не «сразу
 * все», — потому что рычаг 1 «почти всегда достаточный», и трогать следующий
 * есть смысл, только когда предыдущего не хватило).
 *
 * Алгоритм каждой стадии — (μ,λ)-эволюционная стратегия из SIMULATION §6
 * буквально по шагам 1–5 того параграфа (взять центр → 24 мутации в границах →
 * оценить → отобрать лучшие 6, сузить разброс → повторять). Это НЕ полный
 * CMA-ES с адаптацией ковариационной матрицы — у параграфа §6 нет ни одного
 * шага, использующего ковариацию: узкий шаг 4 «сместить центр, сузить разброс»
 * — это изотропная (μ,λ)-ES, и она реализована здесь без упрощений процедуры,
 * только без корреляций между параметрами. Совпадение с «CMA-ES» из вводного
 * абзаца §6 — по названию семейства, а не по строгой процедуре; расхождение
 * названо в отчёте, а не спрятано.
 *
 * ГЛАВНОЕ ОТЛИЧИЕ ОТ §6 — ОБЪЁМ. §6 считает 640 забегов × 16 профилей × 30
 * поколений × 24 мутации ≈ 7.2 млн абстрактных забегов, «четверть часа на
 * восьми ядрах». Здесь, в один процесс Node без пула воркеров: 150 забегов ×
 * 16 профилей × 10 поколений × 24 мутации × 4 стадии ≈ 2.3 млн — сокращение
 * подобрано ПОД «разумное время» задачи 2.3 (см. отчёт агента), а не подгонкой
 * задним числом под секундомер. Это ПЕРВЫЙ поиск, а не финальный: у него нет
 * задачи найти окончательный оптимум, есть задача доказать, что механизм
 * работает и найти направление. Объём — параметр `SearchOptions`, ночной
 * прогон с полными числами §6 можно запустить тем же кодом при необходимости.
 *
 * ЧТО СЧИТАЕТ ЭТА МОДЕЛЬ, А ЧТО НЕТ — читай раздел 1 ниже. Она использует
 * `sampleRoom` из `abstract.ts` (единственный источник калиброванной модели
 * комнаты — числа те же, что и в `npm run balance` через абстракцию, никакого
 * второго источника истины по DPS/попаданиям не заводится), но добавляет
 * СВОЙ уровень агрегации поверх — по этажу и по забегу целиком: кошелёк,
 * доля заведения, покупки в лавке. Этого уровня в `abstract.ts` нет: та
 * модель осознанно ограничена одной комнатой (SIMULATION §2, «Комната(…) →»).
 */

import {
  AVERAGE_MULTIPLIER,
  sampleRoom,
  type LeverOverrides,
  type RoomInput,
  type RoomSample,
} from './abstract';
import { SKILL_NAMES, STRATEGY_NAMES, type SkillName, type StrategyName } from './bots';

// ---------------------------------------------------------------------------
// 1. Рычаги ECONOMY §15 — пространство поиска
// ---------------------------------------------------------------------------

/**
 * Шесть скаляров вместо ~50 отдельных чисел ECONOMY/DIFFICULTY. Не потому что
 * остальные не существуют, а потому что ECONOMY §15 называет ЧЕТЫРЕ РЫЧАГА, а
 * не сорок параметров: «кривая доли заведения», «цены магазина», «бюджет
 * угрозы волн», «множители пари» — каждый в документе уже описан как ОДНА
 * ручка, а не список независимых чисел (доля заведения — явно «рычаг из двух
 * параметров», ECONOMY §5; цены магазина — «средняя база 45», то есть один
 * уровень цен, а не шесть). Шкалирование ВСЕХ шести цен апгрейдов и ВСЕХ
 * шести множителей пари ОДНИМ общим коэффициентом — это и есть рычаг «цены
 * магазина» / «множители пари» в том виде, в каком его называет §15, а не
 * упрощение: подвинуть каждую цену по отдельности — уже следующий, более
 * тонкий шаг («точечно», как §15 требует для множителей), вне области первого
 * поиска.
 *
 * `houseCutPower` и `waveRoomGrowthPct` двигаются в СВОЁМ рычаге (форма кривой),
 * не масштабом: ECONOMY §5 отдельно называет коэффициент («высота, двигает
 * сложность целиком») и показатель («крутизна ножниц») РАЗНЫМИ ручками одного
 * рычага, и границы показателя объявлены прямо в тексте (1 — стена перестаёт
 * давить, 3 — становится стеной) — отсюда узкий коридор ниже.
 *
 * `wavePlayerGrowthPct` (рост бюджета угрозы на кооп, `1+0.8(N−1)`) в поиск НЕ
 * входит: 0.4.0 — только N=1 (ECONOMY §13), и на одном игроке этот параметр
 * не имеет никакого эффекта — двигать его значило бы искать вслепую то, что
 * измерить нечем раньше 0.5.0.
 */
export interface EconomyLevers {
  /** ECONOMY §5: `20 × (F+1)²`, коэффициент. Базовое значение 20. */
  houseCutBase: number;
  /** ECONOMY §5: показатель степени. Базовое значение 2. */
  houseCutPower: number;
  /** Множитель поверх ВСЕХ шести цен `content/upgrades.json` разом. 1 = без изменений. */
  shopPriceScale: number;
  /** Множитель поверх `WAVE.baseBudget` (300, DIFFICULTY §4). 1 = без изменений. */
  waveBudgetScale: number;
  /** Замена `WAVE.roomGrowthPct` (8%, DIFFICULTY §4), в процентах. */
  waveRoomGrowthPct: number;
  /** Множитель поверх среднего каталожного множителя пари. 1 = без изменений. */
  betMultiplierScale: number;
}

/** Текущая конфигурация — центр первого поколения (SIMULATION §6, шаг 1). */
export const BASELINE_LEVERS: EconomyLevers = {
  houseCutBase: 20,
  houseCutPower: 2,
  shopPriceScale: 1,
  waveBudgetScale: 1,
  waveRoomGrowthPct: 8,
  betMultiplierScale: 1,
};

/**
 * Границы рычагов — SIMULATION §6: «без них оптимизатор находит вырожденные
 * решения». Числа не назначены наугад:
 *
 *   — `houseCutBase` 10..40: половина и двойная высота относительно 20;
 *   — `houseCutPower` 1.5..2.5: §5 называет 1 и 3 именно как вырожденные края
 *     («перестаёт давить» / «становится стеной») — граница ýже, отступ от
 *     обоих концов;
 *   — `shopPriceScale`/`betMultiplierScale` 0.6..1.6 и 0.75..1.4: разумный
 *     коридор вокруг единицы, не выведенный из документа (в нём нет чисел
 *     «на сколько можно двигать цену») — это ГРАНИЦА ПОИСКА, а не число
 *     баланса, и статус её в коде и в отчёте прямой: designer-корридор
 *     агента, подлежит пересмотру владельцем;
 *   — `waveBudgetScale` 0.6..1.6: тот же принцип для бюджета угрозы;
 *   — `waveRoomGrowthPct` 0..20: от «без роста внутри этажа» до «вдвое
 *     круче текущих 8%».
 */
export const LEVER_BOUNDS: Record<keyof EconomyLevers, readonly [number, number]> = {
  houseCutBase: [10, 40],
  houseCutPower: [1.5, 2.5],
  shopPriceScale: [0.6, 1.6],
  waveBudgetScale: [0.6, 1.6],
  waveRoomGrowthPct: [0, 20],
  betMultiplierScale: [0.75, 1.4],
};

/** Порядок стадий — ДОСЛОВНО порядок ECONOMY §15. */
export const LEVER_STAGES: readonly (readonly (keyof EconomyLevers)[])[] = [
  ['houseCutBase', 'houseCutPower'],
  ['shopPriceScale'],
  ['waveBudgetScale', 'waveRoomGrowthPct'],
  ['betMultiplierScale'],
];

const clamp = (x: number, [lo, hi]: readonly [number, number]): number =>
  Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------------------
// 2. Абстрактная модель ЗАБЕГА — этаж и кошелёк поверх модели комнаты
// ---------------------------------------------------------------------------

/**
 * `houseCut`, воспроизведённая как ЧИСТАЯ функция параметров поиска — та же
 * формула, что `packages/sim/src/floor.ts` (`HOUSE.base * (floor+1)**power`,
 * усечение вниз), при N=1 (кооп-множитель `1 + 0.6(N−1)` = 1, ECONOMY §11).
 * Дублирование НЕОБХОДИМО: `floor.ts` берёт `HOUSE` из симуляционного
 * конфига, зафиксированного в момент импорта, а поиску нужны рычаги,
 * меняющиеся на каждой мутации — читать их из ядра значило бы либо мутировать
 * загруженный модуль (риск для всего, что его импортирует), либо гонять
 * полную симуляцию на каждой мутации, что и есть та тысячекратная разница в
 * скорости, ради которой существует абстрактная модель (SIMULATION §2).
 */
function houseCutAbstract(floor: number, lev: EconomyLevers): number {
  return Math.trunc(lev.houseCutBase * (floor + 1) ** lev.houseCutPower);
}

/**
 * Цена апгрейда на этаже — та же формула, что `upgrades.ts` (`priceOf`):
 * `база × 1.5^(F−1)`, усечённая вниз. `avgBase` — средняя база каталога, 45
 * (ECONOMY §5, «таблица расходов считает бюджет игрока по среднему ценнику»):
 * поиск двигает цены ОДНИМ рычагом (см. шапку `EconomyLevers`), поэтому и
 * читает каталог одним числом, а не шестью.
 */
const AVERAGE_UPGRADE_BASE = 45;
function upgradePriceAbstract(floor: number, lev: EconomyLevers): number {
  return Math.trunc(AVERAGE_UPGRADE_BASE * lev.shopPriceScale * 1.5 ** (floor - 1));
}

/**
 * Кон по тиру стратегии — `APPETITE` из `packages/sim/src/config.ts`
 * (10 / 25 / 50, ECONOMY §7), сведённый к тиру, который держит каждая
 * стратегия постоянно (`bots.ts`, `STRATEGIES[...].tier`): `none` не ставит,
 * `single` держит «Нормально», `stack`/`chips` — «По-крупному».
 */
const APPETITE_TIER: Record<StrategyName, number> = { none: 0, single: 25, stack: 50, chips: 50 };

/**
 * СКОЛЬКО АПГРЕЙДОВ ПОКУПАЕТСЯ ЗА ЭТАЖ — единственный узел модели, у которого
 * нет опоры в ECONOMY/DIFFICULTY (числа оттуда взяты ВСЕ, кроме порога
 * резерва и доли «сердечных» покупок ниже) и который поэтому размечен как
 * ДОГАДКА АГЕНТА, а не число баланса — по тому же принципу, что
 * `roomDurationScale` в `abstract.ts` (задача 2.1): не выдумывать факт, но
 * явно объявить, где решение инженерное, а не документное.
 *
 *   — «не больше двух покупок за этаж» — не догадка: `DOORS.shopBy` (=5,
 *     `config.ts`) гарантирует лавку не позже комнаты 5 И не позже комнаты 8
 *     (ECONOMY §5, «Лавка обязана появиться... и в первой половине этажа, и
 *     во второй»), то есть ровно два гарантированных визита за этаж — это
 *     потолок покупок, выведенный из документа буквально.
 *   — РЕЗЕРВ (сколько фишек не тратить, чтобы было чем платить долю) —
 *     ДОГАДКА: документ не задаёт правило «сколько откладывать». Взят
 *     буквальный резерв в размере СЛЕДУЮЩЕЙ платы: реалистичный игрок видит
 *     будущий счёт и не тратит последнее на апгрейд накануне него. Другое
 *     правило (тратить всё, копить половину) дало бы другие числа — это и
 *     есть догадка, а не факт.
 *   — ДОЛЯ ПОКУПОК-СЕРДЕЦ (`1/6`) — ДОГАДКА: каталог даёт шесть равных по
 *     наличию позиций (ECONOMY §5, «предлагается три из шести»), и без
 *     данных о РЕАЛЬНОМ выборе бота внутри абстрактной модели (её здесь нет —
 *     `bots.ts` выбирает конкретный товар только в полной симуляции)
 *     равномерная доля — самое честное предположение, а не подгонка под
 *     желаемый результат.
 */
const MAX_UPGRADES_PER_FLOOR = 2;
const HEART_SHARE_OF_UPGRADES = 1 / 6;

interface FloorEconomy {
  wallet: number;
  upgradesBought: number;
  heartsGained: number;
  debtThisFloor: boolean;
}

function spendAtFloorEnd(
  wallet: number,
  floor: number,
  nextFloor: number | null,
  lev: EconomyLevers,
): FloorEconomy {
  const price = upgradePriceAbstract(floor, lev);
  const reserve = nextFloor === null ? 0 : houseCutAbstract(nextFloor, lev);
  let spendable = Math.max(0, wallet - reserve);
  let bought = 0;
  while (bought < MAX_UPGRADES_PER_FLOOR && spendable >= price && price > 0) {
    spendable -= price;
    bought++;
  }
  const spent = bought * price;
  const cut = houseCutAbstract(floor, lev);
  const afterCut = wallet - spent - cut;
  return {
    wallet: afterCut,
    upgradesBought: bought,
    heartsGained: Math.round(bought * HEART_SHARE_OF_UPGRADES),
    debtThisFloor: afterCut < 0,
  };
}

/**
 * Дополнительные попадания за бой с боссом — DIFFICULTY §6, «~0.8 за бой»,
 * дословно из таблицы «Ожидаемый урон по игроку». Сэмплируется отдельным
 * Пуассоном той же природы, что и `hitsLambda` в `abstract.ts` — по одному на
 * пройденный этаж, потому что боссовый бой в 0.4.0 один на этаж, в конце.
 */
const BOSS_HITS_MEAN = 0.8;

/** Итог одного абстрактного забега — то, из чего строятся HARD-проверки и оценка. */
export interface AbstractRunOutcome {
  readonly skill: SkillName;
  readonly strategy: StrategyName;
  readonly finalFloor: 1 | 2 | 3;
  readonly survivedAllFloors: boolean;
  readonly debtSeen: boolean;
  readonly upgradesBought: number;
  readonly netBetEarnings: number;
  readonly finalWallet: number;
}

/**
 * Один забег целиком: 3 этажа × 8 комнат `sampleRoom` (`abstract.ts`, тот же
 * калиброванный источник, что и остальные инструменты) + этажная экономика
 * этого файла. Смерть определяется ПОПАДАНИЯМИ против сердец (DIFFICULTY §6,
 * «Пуассоновское ожидание попаданий... вероятность уложиться в доступные —
 * и есть коридор побед»), а не кошельком: долг «забирает темп, а не деньги»
 * (ECONOMY §10) и сам по себе забег не останавливает — это тот же принцип,
 * что различает `debtSeen` и `outcome` в `constraints.ts`.
 *
 * УПРОЩЕНИЕ, НАЗВАННОЕ ЧЕСТНО: апгрейды «Урон» не ускоряют комнаты в этой
 * модели (`sampleRoom` не знает о покупках) — учитывается только апгрейд
 * «Сердце» (через `heartsGained`). Урон, откат рывка, магнит и дроп меняют
 * ощущение боя, но не выживаемость по документированной DIFFICULTY §1
 * прогрессии (0.4.0: потолок 12 урона вместо заявленных 35 HP/с — «прогрессия
 * это обещание 0.7.0», см. DIFFICULTY §1), и этот пробел — общий с полной
 * симуляцией, а не изобретённый здесь.
 */
export function simulateAbstractRun(
  skill: SkillName,
  strategy: StrategyName,
  lev: EconomyLevers,
  rand: () => number,
): AbstractRunOutcome {
  const START_CHIPS = 30; // ECONOMY §4 — «стартовые 30 фишек».
  const stake = APPETITE_TIER[strategy];
  const roomLev: LeverOverrides = {
    threatBudgetScale: lev.waveBudgetScale,
    roomGrowthPct: lev.waveRoomGrowthPct,
    betMultiplierScale: lev.betMultiplierScale,
  };

  let wallet = START_CHIPS;
  let hearts = 3; // PLAYER.startHearts, DIFFICULTY §6.
  let totalHits = 0;
  let netBetEarnings = 0;
  let upgradesBought = 0;
  let debtSeen = false;
  let finalFloor: 1 | 2 | 3 = 1;
  let survivedAllFloors = false;

  floors: for (let floor = 1 as 1 | 2 | 3; floor <= 3; floor = (floor + 1) as 1 | 2 | 3) {
    finalFloor = floor;
    for (let room = 1; room <= 8; room++) {
      const input: RoomInput = { floor, room, players: 1, skill, strategy };
      const sample: RoomSample = sampleRoom(input, rand, undefined, roomLev);
      wallet += sample.chips;
      totalHits += sample.hits;

      if (sample.betsTaken > 0) {
        const won = sample.betsWon;
        const lost = sample.betsTaken - won;
        const effectiveMultiplier = AVERAGE_MULTIPLIER * lev.betMultiplierScale;
        const delta = won * stake * (effectiveMultiplier - 1) - lost * stake;
        wallet += delta;
        netBetEarnings += delta;
      }

      if (totalHits > hearts) {
        // Сердца кончились раньше конца этажа — забег останавливается здесь,
        // как и D2/G8 в `constraints.ts`: этаж, на котором забег кончился.
        break floors;
      }
    }

    wallet += 40 * floor; // Награда за босса — ECONOMY §4.
    totalHits += samplePoissonLite(rand, BOSS_HITS_MEAN);
    if (totalHits > hearts) break;

    const nextFloor = floor < 3 ? ((floor + 1) as 1 | 2 | 3) : null;
    const spend = spendAtFloorEnd(wallet, floor, nextFloor, lev);
    wallet = spend.wallet;
    upgradesBought += spend.upgradesBought;
    hearts = Math.min(5, hearts + spend.heartsGained); // UPGRADE.maxHearts = 5.
    if (spend.debtThisFloor) debtSeen = true;

    if (floor === 3) survivedAllFloors = true;
  }

  return {
    skill,
    strategy,
    finalFloor,
    survivedAllFloors,
    debtSeen,
    upgradesBought,
    netBetEarnings,
    finalWallet: wallet,
  };
}

/** Пуассон-сэмпл для добавочных попаданий боя с боссом — тот же метод Кнута, что в `abstract.ts` (не экспортирован оттуда). */
function samplePoissonLite(rand: () => number, lambda: number): number {
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
// 3. Оценка кандидата: жёсткие ограничители + мягкая оценка (SIMULATION §4)
// ---------------------------------------------------------------------------

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

const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2;
};

export interface CandidateReport {
  readonly levers: EconomyLevers;
  /** `false` — кандидат отсеян жёстким ограничителем (SIMULATION §4). */
  readonly hardOk: boolean;
  readonly hardFailures: readonly string[];
  readonly softScore: number;
  readonly byProfile: ReadonlyMap<string, readonly AbstractRunOutcome[]>;
}

/**
 * Жёсткие ограничители, измеримые ЭТОЙ моделью — не все 27 из ECONOMY §13 /
 * DIFFICULTY §10, а подмножество, для которого абстрактный забег даёт
 * содержательный ответ: G1 (осторожный доходит до этажа 2), G7 (доля забегов
 * с долгом), G8 (доля побед у `median`). Пороги — те же числа, что в
 * `constraints.ts` (ECONOMY §13 дословно), продублированные здесь, потому что
 * `computeConstraints` принимает `Sample` с полями полной симуляции
 * (`observed`, `bossFights`, `safetyBroken`…), которых у абстрактного забега
 * нет и не может быть — это разные модели, и смешивать их вызовом чужой
 * функции значило бы либо подделывать поля, либо разошедшийся с полной
 * симуляцией список порогов. Остальные G/D (G3–G6, G10, G12, G14, D5–D9…)
 * этой моделью не измеряются вовсе: у нехватки id-разбивки пари, источника
 * урона по врагам и присутствия Туза в абстрактной модели нет и не будет —
 * это подтверждает и должно подтверждать только `npm run balance`.
 */
function hardGate(byProfile: ReadonlyMap<string, readonly AbstractRunOutcome[]>): string[] {
  const failures: string[] = [];

  const none = [...byProfile.entries()]
    .filter(([p]) => p.endsWith(':none'))
    .flatMap(([, rs]) => rs);
  if (none.length > 0) {
    const share = none.filter((r) => r.finalFloor >= 2 || r.survivedAllFloors).length / none.length;
    if (share < 0.9)
      failures.push(
        `G1: осторожный доходит до этажа 2 в ${(share * 100).toFixed(0)}% (нужно ≥90%)`,
      );
  }

  const all = [...byProfile.values()].flat();
  if (all.length > 0) {
    const debtShare = all.filter((r) => r.debtSeen).length / all.length;
    if (debtShare < 0.15 || debtShare > 0.35) {
      failures.push(`G7: доля забегов с долгом ${(debtShare * 100).toFixed(0)}% (нужно 15–35%)`);
    }
  }

  const medianRuns = [...byProfile.entries()]
    .filter(([p]) => p.startsWith('median:'))
    .flatMap(([, rs]) => rs);
  if (medianRuns.length > 0) {
    const winShare = medianRuns.filter((r) => r.survivedAllFloors).length / medianRuns.length;
    if (winShare < 0.25 || winShare > 0.4) {
      failures.push(`G8: победа у median ${(winShare * 100).toFixed(0)}% (нужно 25–40%)`);
    }
  }

  return failures;
}

/**
 * Мягкая оценка — ПОДМНОЖЕСТВО формулы SIMULATION §4, а не все семь
 * слагаемых. Считаются три, для которых у абстрактной модели есть входные
 * данные:
 *
 *   — 25 × попадание доли побед в коридор 25–40% (по `median`, тот же профиль,
 *     что у G8);
 *   — 20 × недоминирование СТРАТЕГИЙ (§4: «прогоняем все стратегии и смотрим
 *     на разброс» — здесь разброс медианного итогового кошелька по четырём
 *     стратегиям);
 *   — 10 × разброс исходов (σ итогового кошелька у `stack`, тот же профиль,
 *     что у G5 в `constraints.ts`).
 *
 * Четыре не считаются вовсе, и это не забывчивость, а честный пробел модели:
 * энтропия ВЫБОРА ТИРА не считается — тир у профильного бота фиксирован
 * стратегией (`bots.ts`, `STRATEGIES[...].tier`), у него нет распределения,
 * которое можно измерить энтропией; охват ВЗЯТЫХ ПАРИ не считается — модель
 * не знает id конкретных пари, только счётчик (`abstract.ts`,
 * `STRATEGY_BETS_PER_ROOM`); частота почти-побед не считается — «почти» здесь
 * означает конкретное пари, сорванное впритык, а не факт модели; достижимость
 * потолка (G9) не считается тем же порядком, что и в `constraints.ts` — самой
 * механики нет до 0.6.0.
 */
function softScore(byProfile: ReadonlyMap<string, readonly AbstractRunOutcome[]>): number {
  const medianRuns = [...byProfile.entries()]
    .filter(([p]) => p.startsWith('median:'))
    .flatMap(([, rs]) => rs);
  const winShare =
    medianRuns.length > 0
      ? medianRuns.filter((r) => r.survivedAllFloors).length / medianRuns.length
      : 0;
  const corridorScore =
    winShare >= 0.25 && winShare <= 0.4 ? 1 : 1 - Math.min(1, Math.abs(winShare - 0.325) / 0.325);

  const strategyMedianWallets = STRATEGY_NAMES.map((strat) => {
    const rs = [...byProfile.entries()]
      .filter(([p]) => p.endsWith(`:${strat}`))
      .flatMap(([, r]) => r);
    return median(rs.map((r) => r.finalWallet));
  });
  const bestWallet = Math.max(...strategyMedianWallets);
  const medianWallet = median(strategyMedianWallets);
  const nonDomination =
    medianWallet !== 0
      ? Math.max(0, 1 - Math.abs(bestWallet - medianWallet) / Math.abs(medianWallet))
      : 0;

  const stackRuns = [...byProfile.entries()]
    .filter(([p]) => p.endsWith(':stack'))
    .flatMap(([, r]) => r);
  const stackWallets = stackRuns.map((r) => r.finalWallet);
  const spreadRaw =
    stackWallets.length > 0 ? stddev(stackWallets) / (Math.abs(mean(stackWallets)) || 1) : 0;
  const spreadScore = Math.min(1, spreadRaw / 1.5); // нормировка к «σ ≥ 1.5×ожидания» — тот же порог, что у G5.

  return 25 * corridorScore + 20 * nonDomination + 10 * spreadScore;
}

function stddev(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/** Оценить одну конфигурацию рычагов: 16 профилей × `runsPerProfile` забегов. */
export function evaluateCandidate(
  lev: EconomyLevers,
  runsPerProfile: number,
  seed: number,
): CandidateReport {
  const byProfile = new Map<string, AbstractRunOutcome[]>();
  let s = seed;
  for (const skill of SKILL_NAMES) {
    for (const strategy of STRATEGY_NAMES) {
      const rand = mulberry32(s++);
      const runs: AbstractRunOutcome[] = [];
      for (let i = 0; i < runsPerProfile; i++)
        runs.push(simulateAbstractRun(skill, strategy, lev, rand));
      byProfile.set(`${skill}:${strategy}`, runs);
    }
  }
  const hardFailures = hardGate(byProfile);
  return {
    levers: lev,
    hardOk: hardFailures.length === 0,
    hardFailures,
    softScore: softScore(byProfile),
    byProfile,
  };
}

// ---------------------------------------------------------------------------
// 4. (μ,λ)-эволюционная стратегия — SIMULATION §6, шаги 1–5, по стадиям §15
// ---------------------------------------------------------------------------

export interface SearchOptions {
  readonly runsPerProfile: number;
  readonly mutationsPerGeneration: number;
  readonly survivorsPerGeneration: number;
  readonly generationsPerStage: number;
  readonly seed: number;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  runsPerProfile: 150,
  mutationsPerGeneration: 24,
  survivorsPerGeneration: 6,
  generationsPerStage: 10,
  seed: 1,
};

export interface StageResult {
  readonly name: string;
  readonly params: readonly (keyof EconomyLevers)[];
  readonly startLevers: EconomyLevers;
  readonly bestLevers: EconomyLevers;
  readonly startScore: number;
  readonly bestScore: number;
  readonly generations: readonly { readonly best: number; readonly spread: number }[];
}

export interface SearchResult {
  readonly baseline: EconomyLevers;
  readonly stages: readonly StageResult[];
  readonly finalLevers: EconomyLevers;
  readonly finalReport: CandidateReport;
  readonly baselineReport: CandidateReport;
}

/**
 * Сравнение кандидатов: годные (без срыва жёсткого ограничителя) всегда
 * лучше негодных (SIMULATION §4, «нарушение любого обнуляет конфигурацию»);
 * среди годных — по мягкой оценке; среди негодных — по числу нарушений (даже
 * заведомо плохой кандидат должен куда-то сместить популяцию, пока стадия не
 * найдёт первый годный).
 */
function better(a: CandidateReport, b: CandidateReport): boolean {
  if (a.hardOk !== b.hardOk) return a.hardOk;
  if (!a.hardOk) return a.hardFailures.length < b.hardFailures.length;
  return a.softScore > b.softScore;
}

function mutate(
  center: EconomyLevers,
  spreadFrac: number,
  params: readonly (keyof EconomyLevers)[],
  rand: () => number,
): EconomyLevers {
  const out: EconomyLevers = { ...center };
  for (const key of params) {
    const [lo, hi] = LEVER_BOUNDS[key];
    const span = (hi - lo) * spreadFrac;
    const delta = (rand() * 2 - 1) * span;
    out[key] = clamp(center[key] + delta, [lo, hi]);
  }
  return out;
}

/** Одна стадия: крутит `params`, держит всё остальное на входном `center`. */
function runStage(
  name: string,
  params: readonly (keyof EconomyLevers)[],
  center: EconomyLevers,
  opts: SearchOptions,
): StageResult {
  const rand = mulberry32(opts.seed ^ hashName(name));
  let currentCenter = center;
  let spreadFrac = 0.5; // половина коридора параметра — стартовый разброс.
  let best = evaluateCandidate(currentCenter, opts.runsPerProfile, opts.seed);
  const startScore = best.softScore;
  const generations: { best: number; spread: number }[] = [];

  for (let gen = 0; gen < opts.generationsPerStage; gen++) {
    const candidates: CandidateReport[] = [best];
    for (let m = 0; m < opts.mutationsPerGeneration; m++) {
      const lev = mutate(currentCenter, spreadFrac, params, rand);
      candidates.push(evaluateCandidate(lev, opts.runsPerProfile, opts.seed + gen * 1000 + m));
    }
    candidates.sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
    const survivors = candidates.slice(0, opts.survivorsPerGeneration);

    // Новый центр — среднее выживших ПО ДВИГАЕМЫМ параметрам (SIMULATION §6,
    // шаг 4: «отобрать лучшие 6, сместить центр»); разброс сужается вдвое
    // за три поколения — геометрическое сужение, а не линейное, чтобы поиск
    // успевал сойтись за отведённые `generationsPerStage`.
    const nextCenter: EconomyLevers = { ...currentCenter };
    for (const key of params) {
      nextCenter[key] = clamp(mean(survivors.map((c) => c.levers[key])), LEVER_BOUNDS[key]);
    }
    currentCenter = nextCenter;
    spreadFrac *= 0.85;
    best = survivors[0];
    generations.push({ best: best.softScore, spread: spreadFrac });
  }

  return {
    name,
    params,
    startLevers: center,
    bestLevers: currentCenter,
    startScore,
    bestScore: best.softScore,
    generations,
  };
}

function hashName(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

const STAGE_NAMES = ['доля заведения', 'цены магазина', 'бюджет угрозы волн', 'множители пари'];

/**
 * Полный поиск: четыре стадии, по порядку ECONOMY §15, каждая берёт центром
 * лучший результат предыдущей (SIMULATION §6, шаг 6 читается по стадиям, а не
 * по всему пространству разом — см. шапку файла).
 */
export function runSearch(opts: SearchOptions = DEFAULT_SEARCH_OPTIONS): SearchResult {
  const baselineReport = evaluateCandidate(BASELINE_LEVERS, opts.runsPerProfile, opts.seed);
  let center = BASELINE_LEVERS;
  const stages: StageResult[] = [];
  for (let i = 0; i < LEVER_STAGES.length; i++) {
    const stage = runStage(STAGE_NAMES[i], LEVER_STAGES[i], center, opts);
    stages.push(stage);
    center = stage.bestLevers;
  }
  const finalReport = evaluateCandidate(center, opts.runsPerProfile, opts.seed);
  return { baseline: BASELINE_LEVERS, stages, finalLevers: center, finalReport, baselineReport };
}

// ---------------------------------------------------------------------------
// 5. Отчёт человеку
// ---------------------------------------------------------------------------

const fmtLev = (l: EconomyLevers): string =>
  `база платы=${l.houseCutBase.toFixed(1)} · степень=${l.houseCutPower.toFixed(2)} · ` +
  `цены×${l.shopPriceScale.toFixed(2)} · бюджет угрозы×${l.waveBudgetScale.toFixed(2)} ` +
  `(рост/комнату ${l.waveRoomGrowthPct.toFixed(1)}%) · множители пари×${l.betMultiplierScale.toFixed(2)}`;

export function formatSearchReport(res: SearchResult, opts: SearchOptions): string {
  const lines: string[] = [];
  lines.push(
    'ПЕРВЫЙ ЭВОЛЮЦИОННЫЙ ПОИСК ОПТИМУМА — ECONOMY §15, абстрактная модель (SIMULATION §6)',
  );
  lines.push(
    `объём: ${opts.mutationsPerGeneration} мутаций × ${opts.generationsPerStage} поколений × ` +
      `${LEVER_STAGES.length} стадий × ${opts.runsPerProfile} забегов × 16 профилей`,
  );
  lines.push('');
  lines.push(`БАЗОВАЯ КОНФИГУРАЦИЯ: ${fmtLev(res.baseline)}`);
  lines.push(
    `  оценка ${res.baselineReport.softScore.toFixed(1)}` +
      (res.baselineReport.hardOk
        ? ' · жёсткие ограничители (доступные модели) в норме'
        : ` · СРЫВ: ${res.baselineReport.hardFailures.join('; ')}`),
  );
  lines.push('');

  for (const stage of res.stages) {
    lines.push(`СТАДИЯ «${stage.name}» (рычаги: ${stage.params.join(', ')})`);
    lines.push(`  было:  ${fmtLev(stage.startLevers)}  (оценка ${stage.startScore.toFixed(1)})`);
    lines.push(`  стало: ${fmtLev(stage.bestLevers)}  (оценка ${stage.bestScore.toFixed(1)})`);
    const delta = stage.bestScore - stage.startScore;
    lines.push(`  сдвиг оценки: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`);
    lines.push('');
  }

  lines.push(`ИТОГ: ${fmtLev(res.finalLevers)}`);
  lines.push(
    `  оценка ${res.finalReport.softScore.toFixed(1)} (было ${res.baselineReport.softScore.toFixed(1)})` +
      (res.finalReport.hardOk
        ? ' · жёсткие ограничители (доступные модели) в норме'
        : ` · СРЫВ: ${res.finalReport.hardFailures.join('; ')}`),
  );
  lines.push('');
  lines.push(
    'Это направление, не приказ (SIMULATION §8): числа рычагов — рекомендация ' +
      'поиска на упрощённой модели забега, подтверждение — полной симуляцией ' +
      '(`npm run balance`) и решением владельца (этап 3).',
  );

  return lines.join('\n');
}

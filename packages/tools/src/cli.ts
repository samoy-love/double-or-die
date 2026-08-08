/**
 * Headless-раннер симуляции — главный инструмент проверки.
 *
 * Всё, что можно проверить без графики, проверяется здесь: быстро,
 * воспроизводимо и одинаково удобно человеку, CI и агенту. JSON в stdout,
 * ноль интерактивных промптов — иначе ломается и то, и другое.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  BetState,
  checkInvariants,
  createState,
  deserialize,
  EntityFlag,
  hashHex,
  MAX_ACTIVE_BETS,
  MAX_CARDS,
  MAX_PLAYERS,
  Meta,
  ReplayPlayer,
  RunPhase,
  TICK_HZ,
  type SimState,
  spawnPlayers,
  step,
} from '@dod/sim';
import {
  BOT_NAMES,
  LEGACY_BOT_NAMES,
  PROFILE_NAMES,
  isBotName,
  makeBot,
  type BotName,
  type ProfileName,
  SKILL_NAMES,
  STRATEGY_NAMES,
} from './bots';
import {
  CONFIG_VERSION,
  type Golden,
  type GoldenResult,
  recordGolden,
  verifyGolden,
} from './golden';
import { parseScenario, runScenario, type ScenarioResult } from './scenario';
import { Observer } from './observe';
import { checkSafety } from './safety';
import { diagnoseCorpus } from './goldenCorpus';
import { runBalance } from './balance';
import { runSearch, formatSearchReport, DEFAULT_SEARCH_OPTIONS } from './search';

interface Args {
  seed: number;
  runs: number;
  ticks: number;
  players: number;
  bot: BotName;
  json: boolean;
  determinismCheck: boolean;
  seeds: number;
  out: string | null;
  scenario: string | null;
  golden: string | null;
  replay: string | null;
  assertHash: string | null;
  recordGolden: string | null;
  rebaseline: boolean;
  safety: boolean;
  observe: boolean;
  timing: boolean;
  balance: boolean;
  search: boolean;
}

/**
 * Отказ разбора аргументов.
 *
 * Код 2 отделён от 1 намеренно: единица — «проверка не прошла», двойка —
 * «команду не поняли». Для CI это разные события, и путать их нельзя: первое
 * означает найденный дефект, второе — что не проверено вообще ничего.
 *
 * DEVLOOP §2: команда либо печатает JSON и выходит нулём, либо падает с
 * внятным сообщением. Молча подставить умолчание — худший из трёх исходов:
 * прогон выглядит успешным и не проверяет того, что просили.
 */
function die(msg: string): never {
  console.error(`✗ ${msg}`);
  console.error('  --help покажет все аргументы.');
  process.exit(2);
}

/**
 * Целое в границах.
 *
 * `Number('abc')` даёт NaN, и без этой проверки NaN уезжает в `createState` и
 * дальше в типизированные массивы, где превращается в нули: забег проходит,
 * отчёт зелёный, сид в нём — не тот, который просили.
 */
function int(flag: string, raw: string | undefined, min: number, max: number): number {
  if (raw === undefined || raw.startsWith('--')) die(`${flag}: нужно число, а значения нет`);
  const v = Number(raw);
  if (!Number.isFinite(v)) die(`${flag}: «${raw}» — не число`);
  if (!Number.isInteger(v)) die(`${flag}: «${raw}» — нужно целое, дробное тик не делится`);
  if (v < min || v > max) die(`${flag}: ${v} вне границ ${min}..${max}`);
  return v;
}

/** Строковое значение флага: пустое и похожее на следующий флаг — ошибка. */
function str(flag: string, raw: string | undefined): string {
  if (raw === undefined || raw.startsWith('--')) die(`${flag}: нужно значение, а его нет`);
  return raw;
}

/** Путь, который обязан существовать: файл или каталог. */
function existingPath(flag: string, raw: string | undefined): string {
  const p = str(flag, raw);
  if (!existsSync(p)) die(`${flag}: пути «${p}» нет`);
  return p;
}

/** Каталог, который обязан существовать и быть каталогом. */
function existingDir(flag: string, raw: string | undefined): string {
  const p = existingPath(flag, raw);
  if (!statSync(p).isDirectory()) die(`${flag}: «${p}» — не каталог`);
  return p;
}

/**
 * Путь для записи: сам файл может не существовать, а вот каталог обязан.
 *
 * Иначе прогон честно считает минуты, а падает на последней строке при записи
 * отчёта — и считать приходится заново.
 */
function writablePath(flag: string, raw: string | undefined): string {
  const p = str(flag, raw);
  const dir = dirname(p) || '.';
  if (!existsSync(dir)) die(`${flag}: каталога «${dir}» нет, записывать некуда`);
  return p;
}

/** Хеш состояния печатается как `0x8f3a21bc` — в этом же виде и принимается. */
function hashArg(flag: string, raw: string | undefined): string {
  const v = str(flag, raw);
  if (!/^0x[0-9a-f]{8}$/.test(v)) die(`${flag}: «${v}» не похоже на хеш вида 0x8f3a21bc`);
  return v;
}

/*
 * Границы взяты не с потолка.
 *
 * Полный забег — 54 000 тиков (15 минут). Потолок в миллион оставляет запас на
 * длинные прогоны и при этом ловит опечатку в порядке величины: `--ticks
 * 18000000` вместо `1800000` это не «долго», это зависший CI без объяснения.
 * Верх у `--runs` и `--seeds` из той же логики: ночной прогон — 10 000 забегов
 * (TECH §13), и всё, что на порядок больше, набрано ошибочно.
 */
const LIMITS = {
  seed: [0, 2 ** 31 - 1],
  runs: [1, 1_000_000],
  ticks: [1, 1_000_000],
  players: [1, MAX_PLAYERS],
  seeds: [1, 1_000_000],
} as const;

function parseArgs(argv: string[]): Args {
  const a: Args = {
    seed: 1,
    runs: 1,
    ticks: 3600,
    players: 1,
    bot: 'idle',
    json: false,
    determinismCheck: false,
    seeds: 10,
    out: null,
    scenario: null,
    golden: null,
    replay: null,
    assertHash: null,
    recordGolden: null,
    rebaseline: false,
    safety: false,
    observe: false,
    timing: false,
    balance: false,
    search: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--seed':
        a.seed = int(k, v, ...LIMITS.seed);
        i++;
        break;
      case '--runs':
        a.runs = int(k, v, ...LIMITS.runs);
        i++;
        break;
      case '--ticks':
        a.ticks = int(k, v, ...LIMITS.ticks);
        i++;
        break;
      case '--players':
        a.players = int(k, v, ...LIMITS.players);
        i++;
        break;
      case '--bot': {
        const name = str(k, v);
        if (!isBotName(name)) die(`--bot: «${name}» не из списка ${BOT_NAMES.join(' | ')}`);
        a.bot = name;
        i++;
        break;
      }
      case '--seeds':
        a.seeds = int(k, v, ...LIMITS.seeds);
        i++;
        break;
      case '--out':
        a.out = writablePath(k, v);
        i++;
        break;
      case '--scenario':
        a.scenario = existingPath(k, v);
        i++;
        break;
      case '--golden':
        a.golden = existingPath(k, v);
        i++;
        break;
      case '--replay':
        a.replay = existingPath(k, v);
        i++;
        break;
      case '--assert-hash':
        a.assertHash = hashArg(k, v);
        i++;
        break;
      // Каталог эталонов проверяется здесь, а не в момент записи: перезапись
      // идёт забегом за забегом, и упасть на седьмом из двадцати значит
      // оставить эталоны наполовину старыми, наполовину новыми.
      case '--record-golden':
        a.recordGolden = existingDir(k, v);
        i++;
        break;
      case '--rebaseline':
        a.rebaseline = true;
        break;
      case '--safety':
        a.safety = true;
        break;
      case '--observe':
        a.observe = true;
        break;
      case '--timing':
        a.timing = true;
        break;
      case '--balance':
        a.balance = true;
        break;
      case '--search':
        a.search = true;
        break;
      case '--json':
        a.json = true;
        break;
      case '--determinism-check':
        a.determinismCheck = true;
        break;
      case '--help':
        printHelp();
        process.exit(0);
        break;
      default:
        // Неизвестный флаг обязан валить запуск. Молча пропущенный, он даёт
        // прогон с умолчаниями вместо запрошенного: `--bots greedy` вместо
        // `--bot greedy` — это пятьсот забегов бездельника и зелёный отчёт.
        die(`неизвестный аргумент: ${k}`);
    }
  }
  return a;
}

function printHelp(): void {
  console.log(`
Headless-раннер Double or Die

  --seed <n>            сид забега (умолчание 1)
  --runs <n>            сколько забегов прогнать
  --ticks <n>           длина забега в тиках (умолчание 3600 = минута)
  --players <n>         игроков 1..${MAX_PLAYERS}
  --bot <имя>           ${LEGACY_BOT_NAMES.join(' | ')} | mixed
                        либо профиль «навык:стратегия»
                        навык:     ${SKILL_NAMES.join(' | ')}
                        стратегия: ${STRATEGY_NAMES.join(' | ')}
  --json                машинный вывод
  --out <файл>          записать отчёт в файл вместо stdout
  --determinism-check   один сид дважды, сверка хешей
  --seeds <n>           сколько сидов проверять в --determinism-check
  --safety              проверять достижимость безопасной точки (D4) каждый тик
  --observe             добавить к каждому забегу разбор: пари по id, тир,
                        исходы, длительности комнат, кто отнял сердце
  --timing              хронометраж ПОЛНОГО забега (до итогов): медиана,
                        квартили, доля дошедших до конца, ворота 12–18 мин
                        (ROADMAP §0.4.0). --bot задаёт профиль skill:strategy
                        или остаётся пустым — тогда мерят все 16 профилей.
                        --runs — забегов НА ПРОФИЛЬ, обязателен и больше 1.
  --balance             ГЕЙТ: ограничители G1–G17/D1–D10 (ECONOMY §13,
                        DIFFICULTY §10) полной симуляцией, состав N=1.
                        --runs — прогонов бота mixed (умолчание 1000, ~30 с);
                        к ним добавляется фиксированный прогон novice:none
                        для G1/G2. Красный ограничитель — код выхода 1.
  --search              первый эволюционный поиск оптимума по рычагам
                        ECONOMY §15 на абстрактной модели (SIMULATION §6):
                        4 стадии по порядку рычагов, не гейт, не падает.
                        Печатает рекомендацию, ничего не правит.

  --scenario <путь>     прогнать сценарий: файл или каталог
  --golden <путь>       сверить эталонные реплеи: файл или каталог
  --replay <файл>       переиграть лог ввода
  --assert-hash <хеш>   потребовать итоговый хеш

  --record-golden <кат> ПЕРЕЗАПИСАТЬ эталоны; требует --rebaseline
`);
}

/**
 * Чем закончился забег.
 *
 * Списка «death / victory / floor N» из будущего здесь намеренно нет: до
 * 0.4.0 забег не кончается вовсе — ни этажей, ни босса, ни экрана итогов не
 * существует, а гибель всех игроков разворачивается перезапуском той же
 * симуляции (`stepRunEnd`). Придумать исход, которого не бывает, значит
 * получить отчёт, который врёт одинаково во всех тысяче забегов.
 */
type Outcome = 'alive' | 'dead' | 'broken';

/** Есть ли у кого-нибудь за столом хоть одно неразрешённое пари. */
function anyBetActive(s: SimState): boolean {
  for (let i = 0; i < s.playerCount * MAX_ACTIVE_BETS; i++) {
    if (s.aState[i] === BetState.Active) return true;
  }
  return false;
}

/** Медиана: половина комнат короче, половина длиннее. Пусто — ноль. */
function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m] : Math.trunc((v[m - 1] + v[m]) / 2);
}

/** Доля с тремя знаками: в JSON от 0.4383333333333333 никому не легче. */
const share = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.round((part / whole) * 1000) / 1000;

/**
 * Перцентиль по отсортированному правилу «ближайший ранг».
 *
 * Не линейная интерполяция (как в Excel) — забег либо длился столько тиков,
 * сколько длился, либо нет: дробного забега между двумя соседними не бывает,
 * и интерполированное значение соответствовало бы прогону, которого не было.
 */
function percentile(xsSorted: readonly number[], p: number): number {
  if (xsSorted.length === 0) return 0;
  const idx = Math.min(xsSorted.length - 1, Math.ceil(p * xsSorted.length) - 1);
  return xsSorted[Math.max(0, idx)];
}

/** Тики в `мм:сс` — секунды в отчёте о ворота никто в тиках не читает. */
function mmss(ticks: number): string {
  const totalSec = Math.round(ticks / TICK_HZ);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Один забег.
 *
 * Отдаёт не только хеш: счётчики забега снимаются здесь, потому что снять их
 * больше негде. Ядру запрещено аллоцировать в горячем пути, поэтому лога
 * событий оно не ведёт (см. шапку `packages/shared/src/events.ts`) — всё, что
 * известно о забеге, живёт в `Meta` и в буферах состояния, и наблюдать за
 * ними можно только снаружи, тик за тиком.
 *
 * Числа собираются сейчас, хотя балансировщик приезжает в 0.4.0: ограничители
 * G6 (доля забегов с нулём взятых пари), G14 (доля закрытых через «Забрать»)
 * и D1 (длительность комнаты не зависит от состава) считаются ровно из них, а
 * дописывать наблюдение в раннер задним числом дороже, чем вести с самого
 * начала — к тому времени рядом будет тысяча золотых прогонов, которые
 * придётся переснимать.
 */
function runOnce(
  seed: number,
  players: number,
  ticks: number,
  bot: BotName,
  safety = false,
  observe = false,
) {
  const s = createState(seed, players);
  spawnPlayers(s);
  const b = makeBot(bot, seed, players);
  const errors: string[] = [];
  // Наблюдатель заводится только по просьбе: он копирует пулы врагов и
  // снарядов перед каждым тиком, и платить за это в прогонах, которым нужен
  // один хеш, незачем.
  const observer = observe ? new Observer(s) : null;

  // Карты считаются переходом слота 0→1, а не суммой розданных за комнату:
  // так в «предложено» попадает и то, что Туз подбрасывает посреди боя.
  // Знаменатель G10 («каждое пари берут не реже 3% и не чаще 25%») — это он.
  const cardWas = new Uint8Array(MAX_CARDS);
  let offered = 0;

  // Убийства накапливаются, а не читаются в конце: `spawnPlayers` обнуляет
  // `Meta.Kills` при перезапуске после гибели, и итоговое число иначе
  // относилось бы к последней жизни, а не к забегу.
  let killsTotal = 0;
  let killsPrev = 0;

  // Комнаты считаются по `RoomStartTick`, а не по номеру комнаты: перезапуск
  // после гибели начинает первую комнату заново, номер при этом не меняется
  // (был 1, стал 1), и по номеру такая комната потерялась бы вместе со своей
  // длительностью — а это как раз самые интересные комнаты.
  let roomStart = s.meta[Meta.RoomStartTick];
  let roomsEntered = 1;
  const roomTicks: number[] = [];

  let betTicks = 0;

  for (let t = 0; t < ticks; t++) {
    observer?.before(s);
    step(s, b.inputs(s));
    observer?.after(s);

    for (let i = 0; i < MAX_CARDS; i++) {
      const on = s.kActive[i];
      if (on !== 0 && cardWas[i] === 0) offered++;
      cardWas[i] = on;
    }

    const kills = s.meta[Meta.Kills];
    if (kills >= killsPrev) killsTotal += kills - killsPrev;
    killsPrev = kills;

    if (s.meta[Meta.RoomStartTick] !== roomStart) {
      roomTicks.push(s.meta[Meta.RoomStartTick] - roomStart);
      roomStart = s.meta[Meta.RoomStartTick];
      roomsEntered++;
    }

    if (anyBetActive(s)) betTicks++;

    /*
     * Инварианты — КАЖДЫЙ тик, как и в клиенте (DEVLOOP §6).
     *
     * Раньше здесь стояло `t % 60`, и раз в секунду выглядело достаточным:
     * нарушение, мол, никуда не денется. Оно девается. Жест Туза без тела жил
     * 150 тиков и пропускался тем чаще, чем короче оказывалось окно; поймать
     * его удалось только сотней забегов подряд, и то не с первой попытки —
     * при восьми прогонах дефект не показывался вовсе. Проверка, которая
     * ловит через раз, хуже отсутствующей: она даёт зелёный отчёт, которому
     * верят.
     *
     * Цена замерена, а не предположена: линейный проход по пулам стоит
     * 0.0096 мс против 0.17 мс самого тика — те же 2.4% бюджета, за которые
     * клиент проверяет каждый кадр. Тысяча забегов по 12 000 тиков от этого
     * прибавляет секунды, а не минуты.
     */
    try {
      checkInvariants(s);
    } catch (e) {
      errors.push(String(e));
      break;
    }
    // Достижимость безопасной точки проверяется КАЖДЫЙ тик, а не раз в
    // секунду: непроходимой комбинация бывает ровно один кадр, и именно в
    // этот кадр игрок теряет сердце.
    if (safety) {
      const fail = checkSafety(s);
      if (fail) {
        errors.push(`безопасной точки нет: игрок ${fail.player}, угроз ${fail.threats} (D4)`);
        break;
      }
    }
  }

  const alive = [...s.pFlags.slice(0, s.playerCount)].some((f) => (f & EntityFlag.Alive) !== 0);
  const outcome: Outcome = errors.length > 0 ? 'broken' : alive ? 'alive' : 'dead';

  return {
    hash: hashHex(s),
    ticks: s.tick,
    // Кем сыгран забег. У `mixed` имя бота одно на прогон, а профиль свой на
    // каждый забег, и ограничители считаются по второму: G3 спрашивает про
    // играющего на ставках, G5 — про наглого, G4 — про опытных.
    profile: b.profile,
    // Кошелёк и сердца — списком по игрокам, а не суммой: G16 («пари за забег
    // у самого пассивного не меньше половины от самого активного») сравнивает
    // игроков между собой, и сумма стирает ровно то, что он ищет.
    result: {
      outcome,
      room: s.meta[Meta.Room],
      wave: s.meta[Meta.Wave],
      kills: killsTotal,
      deaths: s.meta[Meta.Deaths],
      hearts: [...s.pHearts.slice(0, s.playerCount)],
      chips: [...s.pChips.slice(0, s.playerCount)],
    },
    bets: {
      offered,
      taken: s.meta[Meta.BetsTaken],
      won: s.meta[Meta.BetsWon],
      lost: s.meta[Meta.BetsLost],
      cashed: s.meta[Meta.BetsCashed],
      // Доля времени под пари: чем она ниже, тем ближе забег к обычному
      // шутеру, ради которого игру не делали.
      activeTicks: betTicks,
      activeShare: share(betTicks, s.tick),
    },
    rooms: {
      entered: roomsEntered,
      // Только завершённые: комната, оборванная концом прогона, — это не
      // «быстрая комната», а отсутствие замера, и в медиане ей не место.
      completed: roomTicks.length,
      medianTicks: median(roomTicks),
      ticks: roomTicks,
    },
    // Блок появляется только при --observe: его отсутствие обязано быть
    // видно. Пустой блок в каждом отчёте читался бы как «наблюдали и ничего
    // не нашли», а это ровно то враньё, от которого отчёт и защищают.
    ...(observer ? { observed: observer.report() } : {}),
    errors,
  };
}

/**
 * Потолок хронометража: 30 минут.
 *
 * Ворота — 12–18 минут, но ждать конца забега можно и дольше среднего:
 * потолок вдвое выше верхней границы коридора, чтобы медленный, но живой
 * забег не обрывался раньше своих итогов и не путался с зависшим.
 * `--ticks` в замере полного забега не участвует намеренно (см. `doTiming`):
 * пользователь может забыть его поднять, а тихо обрезанный на минуте забег
 * выглядел бы как «не дошёл до конца» вместо «не успели измерить».
 */
const TIMING_TICK_CAP = 30 * 60 * TICK_HZ;

interface TimingRun {
  readonly profile: string;
  readonly seed: number;
  /** Забег дошёл до экрана итогов (`RunPhase.Summary`) в пределах потолка. */
  readonly finished: boolean;
  readonly victory: boolean;
  readonly broken: boolean;
  readonly ticks: number;
  readonly error?: string;
}

/**
 * Один полный забег: от `spawnPlayers` до `RunPhase.Summary` или до потолка.
 *
 * В отличие от `runOnce` (тест поведения за фиксированное окно), здесь важен
 * сам момент, когда стол доходит до итогов — смертью или победой на третьем
 * этаже (`endRun`, `packages/sim/src/run.ts`). Другого признака конца забега
 * в ядре нет и заводить его здесь незачем: `Meta.Phase` уже несёт этот факт.
 */
function runToSummary(seed: number, players: number, bot: BotName): TimingRun {
  const s = createState(seed, players);
  spawnPlayers(s);
  const b = makeBot(bot, seed, players);

  for (let t = 0; t < TIMING_TICK_CAP; t++) {
    step(s, b.inputs(s));
    try {
      checkInvariants(s);
    } catch (e) {
      return {
        profile: b.profile,
        seed,
        finished: false,
        victory: false,
        broken: true,
        ticks: s.tick,
        error: String(e),
      };
    }
    if (s.meta[Meta.Phase] === RunPhase.Summary) {
      return {
        profile: b.profile,
        seed,
        finished: true,
        victory: s.meta[Meta.Victory] === 1,
        broken: false,
        ticks: s.tick,
      };
    }
  }
  return {
    profile: b.profile,
    seed,
    finished: false,
    victory: false,
    broken: false,
    ticks: s.tick,
  };
}

/** Профиль ли это «навык:стратегия», а не легаси-бот или `mixed`. */
function isProfileName(name: BotName): name is ProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(name);
}

/**
 * Хронометраж полного забега — измеритель ворот 0.4.0 («12–18 минут»,
 * ROADMAP §0.4.0).
 *
 * Мерить обязаны профили «навык:стратегия» (DEVLOOP §3), а не `RunnerBot`:
 * тот служебный, стреляет в колонну без проверки линии огня и застревает —
 * он не описывает, как проходит этаж играющий человек, и любая цифра из
 * него врала бы ограничителю, для которого её посчитали. `mixed` из той же
 * причины отклоняется: у него профиль свой на каждый забег, а нужен разбор
 * по каждому в отдельности, а не смесь с непрозрачными весами.
 */
function doTiming(a: Args): never {
  if (a.runs <= 1) {
    die(
      '--timing: один забег ничего не измеряет о распределении, укажите ' +
        '--runs (например 20) — забегов НА ПРОФИЛЬ',
    );
  }
  if (a.bot !== 'idle' && !isProfileName(a.bot)) {
    die(
      `--timing: измеряется профилями «навык:стратегия» (DEVLOOP §3), а «${a.bot}» — ` +
        'не профиль игрока. Укажите --bot вида master:stack или уберите --bot ' +
        'вовсе, чтобы измерить все 16 профилей.',
    );
  }
  const profiles: readonly BotName[] = a.bot === 'idle' ? PROFILE_NAMES : [a.bot];

  const runs: TimingRun[] = [];
  for (const profile of profiles) {
    for (let i = 0; i < a.runs; i++) runs.push(runToSummary(a.seed + i, a.players, profile));
  }

  const finished = runs.filter((r) => r.finished);
  const broken = runs.filter((r) => r.broken);
  const finishedTicks = finished.map((r) => r.ticks).sort((x, y) => x - y);

  const q1 = percentile(finishedTicks, 0.25);
  const med = percentile(finishedTicks, 0.5);
  const q3 = percentile(finishedTicks, 0.75);
  const finishedShare = share(finished.length, runs.length);
  const wonShare = share(finished.filter((r) => r.victory).length, Math.max(1, finished.length));

  const GATE_MIN_TICKS = 12 * 60 * TICK_HZ;
  const GATE_MAX_TICKS = 18 * 60 * TICK_HZ;
  const inGate = finished.length > 0 && med >= GATE_MIN_TICKS && med <= GATE_MAX_TICKS;
  const gateVerdict =
    finished.length === 0
      ? 'НЕ ПРОВЕРЕНО — ни один забег не дошёл до итогов'
      : inGate
        ? `ПРОХОДИТ — медиана ${mmss(med)} внутри коридора 12:00–18:00`
        : `НЕ ПРОХОДИТ — медиана ${mmss(med)} вне коридора 12:00–18:00`;

  // Разбивка по профилю — чтобы неровный медианный результат по всем не
  // прятал профиль, который проходит забег втрое быстрее или вовсе не
  // доходит. Печатается только при нескольких профилях: с одним она была бы
  // повтором общей строки.
  const perProfile = profiles.map((profile) => {
    const rs = runs.filter((r) => r.profile === profile);
    const fin = rs
      .filter((r) => r.finished)
      .map((r) => r.ticks)
      .sort((x, y) => x - y);
    return {
      profile,
      runs: rs.length,
      finishedShare: share(fin.length, rs.length),
      medianTicks: percentile(fin, 0.5),
    };
  });

  console.log(`Хронометраж полного забега — ворота 0.4.0 (ROADMAP §0.4.0)`);
  console.log(`Профилей: ${profiles.length}, забегов на профиль: ${a.runs}, всего: ${runs.length}`);
  console.log('');
  console.log(`Медиана:        ${mmss(med)}  (${med} тиков)`);
  console.log(`Квартили:       ${mmss(q1)} … ${mmss(q3)}`);
  console.log(
    `Дошли до конца: ${(finishedShare * 100).toFixed(1)}%  (${finished.length} из ${runs.length})`,
  );
  console.log(`Победили:       ${(wonShare * 100).toFixed(1)}% от дошедших`);
  if (broken.length > 0) {
    console.log(`Сломались:      ${broken.length} — нарушение инварианта, см. поле errors`);
  }
  console.log('');
  console.log(`Ворота «12–18 минут»: ${gateVerdict}`);

  if (profiles.length > 1) {
    console.log('');
    console.log('По профилям (медиана среди дошедших):');
    for (const p of perProfile) {
      const label = p.finishedShare > 0 ? mmss(p.medianTicks) : '—';
      console.log(
        `  ${p.profile.padEnd(14)} дошли ${(p.finishedShare * 100).toFixed(0).padStart(3)}%   медиана ${label}`,
      );
    }
  }

  const out = {
    ok: inGate,
    gate: { min: '12:00', max: '18:00', verdict: gateVerdict },
    profiles: profiles.length,
    runsPerProfile: a.runs,
    totalRuns: runs.length,
    finishedShare,
    wonShare,
    brokenCount: broken.length,
    medianTicks: med,
    q1Ticks: q1,
    q3Ticks: q3,
    medianTime: mmss(med),
    q1Time: mmss(q1),
    q3Time: mmss(q3),
    perProfile,
    ...(a.out || a.json ? { runs } : {}),
  };
  if (a.json || a.out) emit(a, out);
  process.exit(0);
}

/**
 * Гейт баланса (задача 2.3): `runBalance` уже собрал выборку и посчитал
 * ограничители — здесь только печать и код выхода, тем же путём, что у
 * остальных команд раннера.
 */
function doBalance(a: Args): never {
  // Умолчание CLI (1) для --balance бессмысленно мало. 1000 замерено на этой
  // машине: ~30 с (DEVLOOP §2, «разумное время» — задача 2.3) — достаточно и
  // для редких срезов (G12 — Ставка Туза, G5 — median+stack), и для того,
  // чтобы не превращать гейт в привычку, которую жалко запускать лишний раз.
  const runs = a.runs === 1 ? 1000 : a.runs;
  const outcome = runBalance({ runs, seed: a.seed });
  console.log(outcome.text);
  if (a.json || a.out) {
    emit(a, {
      ok: outcome.ok,
      samples: outcome.samples,
      mixedRuns: outcome.mixedRuns,
      noneRuns: outcome.noneRuns,
      report: outcome.report,
    });
  }
  process.exit(outcome.ok ? 0 : 1);
}

/**
 * Первый эволюционный поиск оптимума (задача 2.3, SIMULATION §6). Не гейт:
 * печатает рекомендацию по рычагам ECONOMY §15 и всегда выходит нулём —
 * правка чисел решением поиска не становится автоматически (SIMULATION §8,
 * «рекомендации — это направление, а не приказ»).
 */
function doSearch(a: Args): never {
  const opts = { ...DEFAULT_SEARCH_OPTIONS, seed: a.seed };
  const res = runSearch(opts);
  console.log(formatSearchReport(res, opts));
  if (a.json || a.out) {
    emit(a, {
      baseline: res.baseline,
      finalLevers: res.finalLevers,
      baselineScore: res.baselineReport.softScore,
      finalScore: res.finalReport.softScore,
      baselineHardOk: res.baselineReport.hardOk,
      finalHardOk: res.finalReport.hardOk,
      stages: res.stages.map((s) => ({
        name: s.name,
        params: s.params,
        startLevers: s.startLevers,
        bestLevers: s.bestLevers,
        startScore: s.startScore,
        bestScore: s.bestScore,
      })),
    });
  }
  process.exit(0);
}

/**
 * Отдать отчёт: в файл, если попросили, иначе в stdout.
 *
 * Файл пишем сами, а не через `> out.json` в оболочке: перенаправление
 * захватывает и баннер npm («> double-or-die@0.1.0 sim»), и любые его
 * предупреждения — на выходе получается не JSON. Ловится это только там, где
 * файл потом читают, то есть далеко от причины.
 */
function emit(a: Args, data: unknown): void {
  const text = JSON.stringify(data, null, a.json || a.out ? 0 : 2);
  if (a.out) {
    writeFileSync(a.out, text + '\n');
    console.log(`отчёт записан: ${a.out}`);
  } else {
    console.log(text);
  }
}

/**
 * Файлы .json по пути: принимаем и один файл, и каталог с подкаталогами.
 *
 * Обход рекурсивный, потому что сценарии разложены по темам («bets», дальше
 * «arena», «coop»): плоский список молча пропустил бы целую папку, а гейт,
 * который чего-то не видит, хуже отсутствующего — он ещё и успокаивает.
 */
function jsonFiles(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  const out: string[] = [];
  for (const e of readdirSync(path).sort()) {
    const full = join(path, e);
    if (statSync(full).isDirectory()) out.push(...jsonFiles(full));
    else if (e.endsWith('.json')) out.push(full);
  }
  return out;
}

function doScenarios(a: Args, path: string): never {
  const results: ScenarioResult[] = [];
  for (const f of jsonFiles(path)) {
    results.push(runScenario(parseScenario(readFileSync(f, 'utf8'), f)));
  }
  const failed = results.filter((r) => !r.ok);
  emit(a, { ok: failed.length === 0, total: results.length, failed: failed.length, results });
  process.exit(failed.length === 0 ? 0 : 1);
}

function doGolden(a: Args, path: string): never {
  const results: GoldenResult[] = [];
  for (const f of jsonFiles(path)) {
    results.push(verifyGolden(JSON.parse(readFileSync(f, 'utf8')) as Golden));
  }
  const failed = results.filter((r) => !r.ok);
  emit(a, {
    ok: failed.length === 0,
    configVersion: CONFIG_VERSION,
    total: results.length,
    failed: failed.length,
    results,
  });
  process.exit(failed.length === 0 ? 0 : 1);
}

function doReplay(a: Args, file: string): never {
  const text = readFileSync(file, 'utf8');
  const raw = JSON.parse(text) as Partial<Golden>;
  // Принимаем и эталон, и голый лог: у эталона реплей лежит внутри строкой.
  const replay = deserialize(typeof raw.replay === 'string' ? raw.replay : text);

  const s = createState(replay.seed, replay.playerCount);
  spawnPlayers(s);
  const p = new ReplayPlayer(replay);
  while (!p.done) step(s, p.next());

  const hash = hashHex(s);
  const ok = a.assertHash === null || hash === a.assertHash;
  emit(a, { ok, seed: replay.seed, ticks: s.tick, hash, expected: a.assertHash });
  process.exit(ok ? 0 : 1);
}

/**
 * Перезапись эталонов.
 *
 * Отдельный флаг и громкое предупреждение — не формальность: тест, эталон
 * которого обновляют заодно с правкой, перестаёт что-либо проверять и
 * начинает подтверждать любое поведение, какое случилось.
 */
function doRecordGolden(a: Args, dir: string): never {
  if (!a.rebaseline) {
    console.error(
      'отказ: перезапись эталонов требует --rebaseline.\n' +
        'Ре-бейзлайн делается осознанно и попадает в заметки версии (CLAUDE.md).',
    );
    process.exit(2);
  }
  /*
   * Пересъёмка обязана накрыть весь корпус, а не часть его.
   *
   * Флаги `--runs`, `--bot` и `--ticks` имеют умолчания (1, `idle`, 3600), и
   * забытый `--runs 20 --bot random` переписывает ОДИН эталон холостым ботом
   * вместо двадцати боевых. Девятнадцать оставшихся ловит сверка версии
   * конфига — они падают с внятным текстом, — а вот подменённый двадцатый не
   * ловит никто: файл на месте, версия верная, тест зелёный, и вместо забега
   * в нём стоящий на месте игрок. Ровно то, от чего защищает `--rebaseline`,
   * только заходящее с другой стороны.
   *
   * Поэтому лежащий рядом корпус — это описание того, что снимать: имена
   * задают набор, а `bot` первого эталона задаёт бота. Пересъёмка меньшего
   * набора или другим ботом — отдельное решение, и принимается оно удалением
   * старых эталонов руками, а не забытым флагом.
   */
  const existing = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (existing.length > 0) {
    const problem = diagnoseCorpus(existing, dir, a.runs, a.seed, a.bot);
    if (problem !== null) {
      console.error(`отказ: ${problem}`);
      process.exit(2);
    }
  }

  const written: string[] = [];
  for (let i = 0; i < a.runs; i++) {
    const seed = a.seed + i;
    // Состав перебирается по кругу: 1–4 игрока, потому что масштабирование
    // на состав — отдельный источник расхождений, и покрыт он должен быть
    // эталонами, а не только юнит-тестом.
    const players = (i % 4) + 1;
    const name = `seed-${seed}-p${players}`;
    const g = recordGolden(name, seed, players, a.bot, a.ticks);
    const file = join(dir, `${name}.json`);
    // Компактно, без отступов: с ними каждое число лога ввода уезжает на
    // свою строку и двадцать эталонов весят 3.4 МБ вместо 300 КБ. Читать
    // руками там нечего — это машинный артефакт, а не документ.
    writeFileSync(file, JSON.stringify(g) + '\n');
    written.push(file);
  }
  console.error(`ЭТАЛОНЫ ПЕРЕЗАПИСАНЫ (${written.length}) при конфиге ${CONFIG_VERSION}`);
  emit(a, { ok: true, rebaselined: written.length, configVersion: CONFIG_VERSION, written });
  process.exit(0);
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));

  if (a.recordGolden) doRecordGolden(a, a.recordGolden);
  if (a.scenario) doScenarios(a, a.scenario);
  if (a.golden) doGolden(a, a.golden);
  if (a.replay) doReplay(a, a.replay);
  if (a.timing) doTiming(a);
  if (a.balance) doBalance(a);
  if (a.search) doSearch(a);

  if (a.determinismCheck) {
    const mismatches: { seed: number; a: string; b: string }[] = [];
    for (let i = 0; i < a.seeds; i++) {
      const seed = a.seed + i;
      const r1 = runOnce(seed, a.players, a.ticks, a.bot);
      const r2 = runOnce(seed, a.players, a.ticks, a.bot);
      if (r1.hash !== r2.hash) mismatches.push({ seed, a: r1.hash, b: r2.hash });
    }
    const ok = mismatches.length === 0;
    emit(a, { ok, checked: a.seeds, mismatches, ticks: a.ticks });
    process.exit(ok ? 0 : 1);
  }

  const results = [];
  let failures = 0;
  for (let i = 0; i < a.runs; i++) {
    const r = runOnce(a.seed + i, a.players, a.ticks, a.bot, a.safety, a.observe);
    if (r.errors.length > 0) failures++;
    results.push({ seed: a.seed + i, ...r });
  }

  // --assert-hash на обычном забеге: точная привязка сида к состоянию,
  // которой удобно прижать баг-репорт, не таская с собой файл реплея.
  if (a.assertHash !== null && results[0].hash !== a.assertHash) failures++;

  const out = {
    ok: failures === 0,
    runs: a.runs,
    failures,
    bot: a.bot,
    players: a.players,
    ticks: a.ticks,
    ...(a.assertHash !== null ? { expected: a.assertHash } : {}),
    // При записи в файл отдаём все забеги: файл читает сверка платформ,
    // и ей нужны хеши каждого сида, а не только упавших.
    results: a.out || a.runs <= 20 ? results : results.filter((r) => r.errors.length > 0),
  };
  emit(a, out);
  process.exit(out.ok ? 0 : 1);
}

main();

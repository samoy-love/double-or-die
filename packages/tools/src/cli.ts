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
  type SimState,
  spawnPlayers,
  step,
} from '@dod/sim';
import { BOT_NAMES, isBotName, makeBot, type BotName } from './bots';
import {
  CONFIG_VERSION,
  type Golden,
  type GoldenResult,
  recordGolden,
  verifyGolden,
} from './golden';
import { parseScenario, runScenario, type ScenarioResult } from './scenario';
import { checkSafety } from './safety';

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
  --bot <имя>           ${BOT_NAMES.join(' | ')}
  --json                машинный вывод
  --out <файл>          записать отчёт в файл вместо stdout
  --determinism-check   один сид дважды, сверка хешей
  --seeds <n>           сколько сидов проверять в --determinism-check
  --safety              проверять достижимость безопасной точки (D4) каждый тик

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
function runOnce(seed: number, players: number, ticks: number, bot: BotName, safety = false) {
  const s = createState(seed, players);
  spawnPlayers(s);
  const b = makeBot(bot, seed, players);
  const errors: string[] = [];

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
    step(s, b.inputs(s));

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
    errors,
  };
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
    const names = new Set<string>();
    for (let i = 0; i < a.runs; i++) names.add(`seed-${a.seed + i}-p${(i % 4) + 1}`);
    const orphans = existing.map((f) => f.slice(0, -5)).filter((n) => !names.has(n));
    if (orphans.length > 0) {
      console.error(
        `отказ: пересъёмка накрывает ${names.size} эталонов, а в ${dir} их ${existing.length}.\n` +
          `Осталось бы нетронутыми: ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ` и ещё ${orphans.length - 5}` : ''}.\n` +
          `Нужен весь корпус — добавьте --runs ${existing.length} --seed 1; нужен другой — удалите старый руками.`,
      );
      process.exit(2);
    }

    const sample = JSON.parse(readFileSync(join(dir, existing[0]), 'utf8')) as { bot?: string };
    if (sample.bot !== undefined && sample.bot !== a.bot) {
      console.error(
        `отказ: корпус записан ботом «${sample.bot}», а снимается ботом «${a.bot}».\n` +
          `Эталон, переснятый другим ботом, проверяет уже другой забег, продолжая называться тем же именем.`,
      );
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
    const r = runOnce(a.seed + i, a.players, a.ticks, a.bot, a.safety);
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

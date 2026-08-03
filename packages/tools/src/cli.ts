/**
 * Headless-раннер симуляции — главный инструмент проверки.
 *
 * Всё, что можно проверить без графики, проверяется здесь: быстро,
 * воспроизводимо и одинаково удобно человеку, CI и агенту. JSON в stdout,
 * ноль интерактивных промптов — иначе ломается и то, и другое.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkInvariants,
  createState,
  deserialize,
  hashHex,
  ReplayPlayer,
  spawnPlayers,
  step,
} from '../../sim/src/index';
import { makeBot, type BotName } from './bots';
import {
  CONFIG_VERSION,
  type Golden,
  type GoldenResult,
  recordGolden,
  verifyGolden,
} from './golden';
import { parseScenario, runScenario, type ScenarioResult } from './scenario';

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
}

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
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--seed':
        a.seed = Number(v);
        i++;
        break;
      case '--runs':
        a.runs = Number(v);
        i++;
        break;
      case '--ticks':
        a.ticks = Number(v);
        i++;
        break;
      case '--players':
        a.players = Number(v);
        i++;
        break;
      case '--bot':
        a.bot = v as BotName;
        i++;
        break;
      case '--seeds':
        a.seeds = Number(v);
        i++;
        break;
      case '--out':
        a.out = v;
        i++;
        break;
      case '--scenario':
        a.scenario = v;
        i++;
        break;
      case '--golden':
        a.golden = v;
        i++;
        break;
      case '--replay':
        a.replay = v;
        i++;
        break;
      case '--assert-hash':
        a.assertHash = v;
        i++;
        break;
      case '--record-golden':
        a.recordGolden = v;
        i++;
        break;
      case '--rebaseline':
        a.rebaseline = true;
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
  --players <n>         игроков 1..4
  --bot <имя>           idle | random
  --json                машинный вывод
  --out <файл>          записать отчёт в файл вместо stdout
  --determinism-check   один сид дважды, сверка хешей
  --seeds <n>           сколько сидов проверять в --determinism-check

  --scenario <путь>     прогнать сценарий: файл или каталог
  --golden <путь>       сверить эталонные реплеи: файл или каталог
  --replay <файл>       переиграть лог ввода
  --assert-hash <хеш>   потребовать итоговый хеш

  --record-golden <кат> ПЕРЕЗАПИСАТЬ эталоны; требует --rebaseline
`);
}

/** Один забег. Возвращает итоговый хеш и признак успеха. */
function runOnce(seed: number, players: number, ticks: number, bot: BotName) {
  const s = createState(seed, players);
  spawnPlayers(s);
  const b = makeBot(bot, seed, players);
  const errors: string[] = [];

  for (let t = 0; t < ticks; t++) {
    step(s, b.inputs(s));
    // Инварианты — самый дешёвый способ поймать дефект в момент появления,
    // а не через десять минут, когда причина потеряна.
    if (t % 60 === 0) {
      try {
        checkInvariants(s);
      } catch (e) {
        errors.push(String(e));
        break;
      }
    }
  }

  return { hash: hashHex(s), ticks: s.tick, errors };
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

/** Файлы .json по пути: принимаем и один файл, и каталог. */
function jsonFiles(path: string): string[] {
  return statSync(path).isDirectory()
    ? readdirSync(path)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => join(path, f))
    : [path];
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
    const r = runOnce(a.seed + i, a.players, a.ticks, a.bot);
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

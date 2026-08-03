/**
 * Headless-раннер симуляции — главный инструмент проверки.
 *
 * Всё, что можно проверить без графики, проверяется здесь: быстро,
 * воспроизводимо и одинаково удобно человеку, CI и агенту. JSON в stdout,
 * ноль интерактивных промптов — иначе ломается и то, и другое.
 */

import { writeFileSync } from 'node:fs';
import { createState, hashHex, spawnPlayers, step, checkInvariants } from '../../sim/src/index';
import { makeBot, type BotName } from './bots';

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

function main(): void {
  const a = parseArgs(process.argv.slice(2));

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

  const out = {
    ok: failures === 0,
    runs: a.runs,
    failures,
    bot: a.bot,
    players: a.players,
    ticks: a.ticks,
    // При записи в файл отдаём все забеги: файл читает сверка платформ,
    // и ей нужны хеши каждого сида, а не только упавших.
    results: a.out || a.runs <= 20 ? results : results.filter((r) => r.errors.length > 0),
  };
  emit(a, out);
  process.exit(out.ok ? 0 : 1);
}

main();

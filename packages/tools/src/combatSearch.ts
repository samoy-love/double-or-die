/**
 * Поиск по параметрам боя на ПОЛНОЙ симуляции, многопоточно.
 *
 * `--search` (`search.ts`) крутит абстрактную модель (SIMULATION §6) — она не
 * знает ни про телеграф Клина, ни про окно рывка, потому и не находит то, что
 * ловится только боем: playtest 0.3.1 нашёл гейт красным (G1/G3/G7/G8/G12/D2
 * сорваны), а `--search` на абстракции ничего не сдвинул — оценка не
 * менялась при любом рычаге экономики, потому что причина не в деньгах.
 *
 * Здесь то же поколенческое устройство (мутация → отбор → сдвиг центра), что
 * и в `search.ts`, но кандидат оценивается ПОЛНЫМ `--balance` — тем же гейтом,
 * которым CI валит сборку. Каждый кандидат — отдельный процесс `tsx
 * packages/tools/src/cli.ts --balance --json` с флагами рычагов
 * (`--wedge-threat` и т.д., см. `cli.ts: applyCombatLevers`), а не воркер
 * этого же файла: `worker_threads`/`fork()` под `tsx` не дотягиваются до
 * алиаса `@dod/sim` из tsconfig paths и до полусотни внутренних импортов
 * sim-пакета без расширений — а полноценный дочерний `tsx`-процесс проходит
 * тот же bootstrap, что и `npm run balance`, и просто работает.
 *
 * Рекомендация, не приказ — как и `--search`: печатает лучший найденный набор
 * рычагов и его гейт-отчёт, ничего не пишет в `config.ts`. Подтверждение —
 * решением владельца и `npm run balance` на реальном конфиге.
 */

import { cpus } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const CLI_PATH = fileURLToPath(new URL('./cli.ts', import.meta.url));
/**
 * Точка входа `tsx` как JS-файл, а не `.cmd`-обёртка: путь к проекту содержит
 * пробел, и `shell: true` квотирует аргументы, но НЕ саму команду — `cmd.exe`
 * рвёт её на первом пробеле (проверено при проектировании). Прямой запуск
 * `node.exe <cli.mjs> <script> <args>` без shell — то же самое, что делает
 * `tsx.cmd` внутри, но проходит мимо парсера cmd.exe целиком: Windows
 * маршалит argv через `CreateProcess`, а не через строку.
 *
 * `require.resolve('tsx/dist/cli.mjs')` не годится: подпуть не объявлен в
 * `exports` `package.json` пакета tsx, и резолвер падает — `bin` его туда не
 * добавляет, тот путь только для прямого запуска ОС, не для `require`.
 * Поэтому путь физический: от каталога `package.json` пакета (который
 * `exports` резолвить обязан) до `dist/cli.mjs` на диске.
 */
const TSX_CLI = join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');

export interface CombatLevers {
  readonly wedgeThreat: number;
  readonly wedgeHp: number;
  readonly waveBaseBudget: number;
  /** Крутой участок излома (`WAVE.roomGrowthLatePct`); пологий не крутится, см. `cli.ts`. */
  readonly waveRoomGrowthPct: number;
  readonly brickUnlockRoom: number;
  readonly fuseUnlockRoom: number;
  /**
   * Рычаги игрока — добавлены вторым заходом (playtest 0.3.1): у Клина и
   * бюджета волны на шести врагах-рычагах поиск уткнулся в потолок с
   * поколения 2 из 40, а G1/G7/G8/D2/D3/G12/G5 остались красными не потому,
   * что бой перетюнен, а потому что забег обрывается раньше, чем должен —
   * это про выживаемость игрока, не про силу врага (ту же причину подтвердил
   * ручной разбор G12 и G5: смерть забирает несорванные пари в ноль).
   */
  readonly playerStartHearts: number;
  readonly playerDashCooldownTicks: number;
  readonly playerHurtInvulTicks: number;
}

export const LEVER_BOUNDS: Record<keyof CombatLevers, readonly [number, number]> = {
  wedgeThreat: [7, 26],
  wedgeHp: [12, 32],
  waveBaseBudget: [200, 320],
  // Крутой участок излома (`WAVE.roomGrowthLatePct`); пологий фиксирован
  // ре-бейзлайном playtest 0.3.1 и поиском не крутится (`cli.ts: --wave-growth`).
  waveRoomGrowthPct: [6, 24],
  brickUnlockRoom: [2, 6],
  fuseUnlockRoom: [1, 5],
  playerStartHearts: [2, 6],
  playerDashCooldownTicks: [20, 90],
  playerHurtInvulTicks: [30, 120],
};

/** Текущий конфиг на момент проектирования инструмента — стартовая точка поиска. */
export const BASELINE_LEVERS: CombatLevers = {
  wedgeThreat: 14,
  wedgeHp: 20,
  waveBaseBudget: 300,
  waveRoomGrowthPct: 8,
  brickUnlockRoom: 5,
  fuseUnlockRoom: 3,
  playerStartHearts: 3,
  playerDashCooldownTicks: 72, // 1.2 с × 60
  playerHurtInvulTicks: 60, // 1.0 с × 60
};

export interface CombatSearchOptions {
  readonly workers: number;
  /** Прогонов `mixed` на кандидата в поиске — облегчённая выборка, не финальный гейт. */
  readonly searchRuns: number;
  /** Прогонов `mixed` на финальную проверку топ-кандидатов — полный гейт. */
  readonly validateRuns: number;
  readonly topCandidatesToValidate: number;
  readonly mutationsPerGeneration: number;
  readonly survivorsPerGeneration: number;
  readonly generations: number;
  readonly seed: number;
}

export const DEFAULT_COMBAT_SEARCH_OPTIONS: CombatSearchOptions = {
  workers: Math.max(1, cpus().length - 1),
  searchRuns: 150,
  validateRuns: 1000,
  topCandidatesToValidate: 3,
  // 30 (не 24): девять рычагов вместо шести после добавления выживаемости
  // игрока — population 31 (30 мутаций + центр) заодно ровно насыщает пул
  // из 31 воркера, ни один процесс не простаивает в ожидании следующей волны.
  mutationsPerGeneration: 30,
  survivorsPerGeneration: 8,
  generations: 12,
  seed: 1,
};

export interface WorkerResult {
  readonly redCount: number;
  readonly greenCount: number;
  readonly redIds: readonly string[];
  readonly text: string;
}

const clamp = (v: number, [lo, hi]: readonly [number, number]): number =>
  Math.min(hi, Math.max(lo, v));

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEVER_FLAGS: Record<keyof CombatLevers, string> = {
  wedgeThreat: '--wedge-threat',
  wedgeHp: '--wedge-hp',
  waveBaseBudget: '--wave-budget',
  waveRoomGrowthPct: '--wave-growth',
  brickUnlockRoom: '--brick-room',
  fuseUnlockRoom: '--fuse-room',
  playerStartHearts: '--player-hearts',
  playerDashCooldownTicks: '--player-dash-cooldown',
  playerHurtInvulTicks: '--player-hurt-invul',
};

/**
 * Один кандидат — один дочерний процесс `cli.ts --balance --json`.
 *
 * Очередь ограничивает число одновременных процессов пулом ядер: без лимита
 * популяция в 25 кандидатов запустила бы 25 процессов разом, и на 32 ядрах
 * это не страшно, но на менее мощной машине честное ограничение важнее.
 */
class ProcessPool {
  private running = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly size: number) {}

  private async runOne(levers: CombatLevers, runs: number, seed: number): Promise<WorkerResult> {
    const args = ['--balance', '--json', '--runs', String(runs), '--seed', String(seed)];
    for (const key of Object.keys(LEVER_BOUNDS) as (keyof CombatLevers)[]) {
      args.push(LEVER_FLAGS[key], String(Math.round(levers[key])));
    }

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [TSX_CLI, CLI_PATH, ...args], { shell: false });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', () => {
        // Гейт валит процесс ненулевым кодом при красном ограничителе (задача
        // 2.3) — это здесь НЕ ошибка поиска, а обычный (скорее частый)
        // результат кандидата; падать имеет смысл только если вообще нет
        // JSON на выходе.
        const lines = stdout.trim().split('\n');
        const last = lines[lines.length - 1] ?? '';
        try {
          const data = JSON.parse(last) as {
            ok: boolean;
            report: readonly { id: string; verdict: string }[];
          };
          const red = data.report.filter((r) => r.verdict === 'red');
          const green = data.report.filter((r) => r.verdict === 'green');
          resolve({
            redCount: red.length,
            greenCount: green.length,
            redIds: red.map((r) => r.id),
            text: lines.slice(0, -1).join('\n'),
          });
        } catch {
          reject(new Error(`кандидат не дал JSON (stderr: ${stderr.slice(0, 500)})`));
        }
      });
      child.on('error', reject);
    });
  }

  evaluate(levers: CombatLevers, runs: number, seed: number): Promise<WorkerResult> {
    return new Promise((resolve, reject) => {
      const task = () => {
        this.running++;
        this.runOne(levers, runs, seed)
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.pump();
          });
      };
      this.queue.push(task);
      this.pump();
    });
  }

  private pump(): void {
    while (this.running < this.size && this.queue.length > 0) {
      const task = this.queue.shift();
      task?.();
    }
  }
}

function mutate(center: CombatLevers, spreadFrac: number, rand: () => number): CombatLevers {
  const out = { ...center };
  for (const key of Object.keys(LEVER_BOUNDS) as (keyof CombatLevers)[]) {
    const bounds = LEVER_BOUNDS[key];
    const span = (bounds[1] - bounds[0]) * spreadFrac;
    out[key] = clamp(center[key] + (rand() * 2 - 1) * span, bounds);
  }
  return out;
}

interface Scored {
  readonly levers: CombatLevers;
  readonly result: WorkerResult;
}

/** Меньше красных — лучше; при равенстве — не важно, дальше решает мутация. */
function better(a: Scored, b: Scored): boolean {
  return a.result.redCount < b.result.redCount;
}

export interface CombatSearchProgress {
  readonly generation: number;
  readonly totalGenerations: number;
  readonly bestRed: number;
}

export interface CombatSearchResult {
  readonly baseline: WorkerResult;
  readonly best: Scored;
  readonly validated: readonly Scored[];
  readonly generationLog: readonly { readonly gen: number; readonly bestRed: number }[];
}

export async function runCombatSearch(
  opts: CombatSearchOptions = DEFAULT_COMBAT_SEARCH_OPTIONS,
  onProgress?: (p: CombatSearchProgress) => void,
): Promise<CombatSearchResult> {
  const pool = new ProcessPool(opts.workers);
  const rand = mulberry32(opts.seed ^ 0x5eed);
  const generationLog: { gen: number; bestRed: number }[] = [];

  const baseline = await pool.evaluate(BASELINE_LEVERS, opts.searchRuns, opts.seed);
  let center = BASELINE_LEVERS;
  let best: Scored = { levers: center, result: baseline };
  let spreadFrac = 0.5;

  for (let gen = 0; gen < opts.generations; gen++) {
    const candidateLevers = [center];
    for (let m = 0; m < opts.mutationsPerGeneration; m++) {
      candidateLevers.push(mutate(center, spreadFrac, rand));
    }

    const results = await Promise.all(
      candidateLevers.map((lev, i) =>
        pool
          .evaluate(lev, opts.searchRuns, opts.seed + gen * 10_000 + i)
          .then((result): Scored => ({ levers: lev, result })),
      ),
    );

    results.sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
    const survivors = results.slice(0, opts.survivorsPerGeneration);

    const nextCenter = { ...center };
    for (const key of Object.keys(LEVER_BOUNDS) as (keyof CombatLevers)[]) {
      nextCenter[key] = clamp(
        survivors.reduce((sum, s) => sum + s.levers[key], 0) / survivors.length,
        LEVER_BOUNDS[key],
      );
    }
    center = nextCenter;
    spreadFrac *= 0.85;
    if (better(survivors[0], best)) best = survivors[0];

    generationLog.push({ gen, bestRed: best.result.redCount });
    onProgress?.({
      generation: gen,
      totalGenerations: opts.generations,
      bestRed: best.result.redCount,
    });
  }

  // Финал: топ-кандидаты перепроверяются полным гейтом — то, что выиграло на
  // облегчённой выборке, обязано выигрывать и на ней тоже, иначе рекомендация
  // — шум малой выборки, а не находка (SIMULATION §8).
  const finalists = [best, { levers: BASELINE_LEVERS, result: baseline }]
    .filter((v, i, arr) => arr.findIndex((x) => x.levers === v.levers) === i)
    .slice(0, opts.topCandidatesToValidate);
  const validated = await Promise.all(
    finalists.map((f) =>
      pool
        .evaluate(f.levers, opts.validateRuns, opts.seed + 999_000)
        .then((result): Scored => ({ levers: f.levers, result })),
    ),
  );
  validated.sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));

  return { baseline, best: validated[0], validated, generationLog };
}

const fmtLev = (l: CombatLevers): string =>
  `Клин threat=${l.wedgeThreat.toFixed(0)} hp=${l.wedgeHp.toFixed(0)} · ` +
  `бюджет волны=${l.waveBaseBudget.toFixed(0)} (рост/комнату ${l.waveRoomGrowthPct.toFixed(1)}%) · ` +
  `Кирпич с комнаты ${l.brickUnlockRoom.toFixed(0)} · Фитиль с комнаты ${l.fuseUnlockRoom.toFixed(0)} · ` +
  `сердца=${l.playerStartHearts.toFixed(0)} · откат рывка=${l.playerDashCooldownTicks.toFixed(0)}т · ` +
  `неуязвимость=${l.playerHurtInvulTicks.toFixed(0)}т`;

export function formatCombatSearchReport(
  res: CombatSearchResult,
  opts: CombatSearchOptions,
): string {
  const lines: string[] = [];
  lines.push('ПОИСК ПО БОЮ — полная симуляция, пул процессов');
  lines.push(
    `процессов одновременно: ${opts.workers} · поиск: ${opts.searchRuns} прогонов/кандидата × ` +
      `${opts.mutationsPerGeneration + 1} кандидатов × ${opts.generations} поколений · ` +
      `финал: ${opts.validateRuns} прогонов на топ-${opts.topCandidatesToValidate}`,
  );
  lines.push('');
  lines.push(`БАЗА: ${fmtLev(BASELINE_LEVERS)}`);
  lines.push(`  красных гейтов: ${res.baseline.redCount} (${res.baseline.redIds.join(', ')})`);
  lines.push('');
  lines.push('Ход поиска по поколениям (лучшее красных на облегчённой выборке):');
  for (const g of res.generationLog) lines.push(`  поколение ${g.gen + 1}: ${g.bestRed}`);
  lines.push('');
  lines.push('ФИНАЛЬНАЯ ПРОВЕРКА (полный гейт, топ-кандидаты):');
  for (const v of res.validated) {
    lines.push(`  ${fmtLev(v.levers)}`);
    lines.push(`    красных: ${v.result.redCount} · зелёных: ${v.result.greenCount}`);
  }
  lines.push('');
  lines.push(`РЕКОМЕНДАЦИЯ: ${fmtLev(res.best.levers)}`);
  lines.push('');
  lines.push(res.best.result.text);
  lines.push('');
  lines.push(
    'Это направление, не приказ: числа — рекомендация поиска, подтверждение — решением ' +
      'владельца и `npm run balance` на реально применённом config.ts.',
  );
  return lines.join('\n');
}

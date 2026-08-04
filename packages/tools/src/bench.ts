/**
 * Бенч ядра симуляции.
 *
 * Меряет то, что обязано укладываться в бюджет кадра ВСЕГДА, независимо от
 * видеокарты и браузера: сам тик, снятие хеша, снимок и восстановление
 * состояния. Эти операции лежат на пути сети, отката и golden-тестов, и их
 * стоимость должна быть известна числом, а не ощущением.
 *
 * Бюджет — 16.67 мс на кадр при 60 Гц. Симуляции из него достаётся малая
 * доля: остальное принадлежит рендеру, звуку и вводу. Поэтому мерилом взят
 * ЗАПАС — во сколько раз тик дешевле целого кадра.
 *
 * Порог осознанно мягкий. Бенч ловит обвал на порядок (аллокация в горячем
 * пути, случайно квадратичный проход), а не проценты: на общем раннере CI
 * разброс между прогонами и так десятки процентов, и строгий порог давал бы
 * красный цвет на ровном месте — а такой тест перестают читать.
 *
 * Часть нагрузки рендера меряется здесь же — система частиц. Она чистая
 * арифметика над типизированными массивами и от WebGL не зависит вовсе,
 * поэтому её регрессия ловится в Node, а не только глазами в браузере.
 * Собственно отрисовка (2000 частиц и 200 болванок в одном батче) меряется
 * там, где она живёт, — в браузере через `__DOD__.stress()` и `render()`,
 * см. DEVLOOP §4.
 */

import {
  createSnapshot,
  createState,
  hashState,
  loadSnapshot,
  saveSnapshot,
  type SimState,
  spawnPlayers,
  step,
} from '@dod/sim';
import { makeBot } from './bots';
import { Particles, ParticleShape } from '@dod/client/particles';

const FRAME_BUDGET_MS = 1000 / 60;
/** Тик обязан быть дешевле кадра хотя бы во столько раз. */
const MIN_HEADROOM = 20;

interface Measure {
  name: string;
  msPerOp: number;
  opsPerSec: number;
  /** Во сколько раз операция дешевле кадра. */
  headroom: number;
  ok: boolean;
}

/**
 * Замер с прогревом.
 *
 * Без прогрева меряется работа интерпретатора до оптимизации, а это не то
 * число, которое кого-либо интересует: в игре горячий путь исполняется
 * миллионы раз.
 */
function measure(name: string, iterations: number, fn: (i: number) => void): Measure {
  const warmup = Math.max(1, Math.floor(iterations / 10));
  for (let i = 0; i < warmup; i++) fn(i);

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn(i);
  const t1 = process.hrtime.bigint();

  const totalMs = Number(t1 - t0) / 1e6;
  const msPerOp = totalMs / iterations;
  const headroom = FRAME_BUDGET_MS / msPerOp;

  return {
    name,
    msPerOp: round(msPerOp, 6),
    opsPerSec: Math.round(1000 / msPerOp),
    headroom: round(headroom, 1),
    ok: headroom >= MIN_HEADROOM,
  };
}

const round = (n: number, digits: number): number => {
  const k = 10 ** digits;
  return Math.round(n * k) / k;
};

function benchTick(players: number): Measure {
  const s = createState(1, players);
  spawnPlayers(s);
  const bot = makeBot('random', 1, players);
  return measure(`тик, игроков ${players}`, 200_000, () => step(s, bot.inputs(s)));
}

/**
 * Система частиц под полной нагрузкой из плана версии: 2000 штук.
 *
 * Меряется шаг, а не отрисовка: именно он идёт по всем частицам каждый кадр
 * и именно он молча становится квадратичным, если однажды добавить в него
 * взаимодействие между частицами.
 */
function benchParticles(): Measure {
  const particles = new Particles();
  const colour = { r: 1, g: 0.8, b: 0.2 };
  for (let i = 0; i < 2000; i++) {
    const a = (i / 2000) * Math.PI * 2 * 13;
    particles.spawn(
      (i % 3) as ParticleShape,
      Math.cos(a) * 800,
      Math.sin(a) * 400,
      Math.cos(a) * 60,
      Math.sin(a) * 60,
      8,
      // Живут дольше замера: гаснущие частицы мерили бы пустой цикл.
      3600,
      colour,
    );
  }
  return measure('2000 частиц', 20_000, () => particles.update(1 / 60));
}

function benchHash(): Measure {
  const s = freshState(4);
  return measure('хеш состояния', 50_000, () => void hashState(s));
}

function benchSnapshot(): Measure {
  const s = freshState(4);
  const snap = createSnapshot(s);
  return measure('снимок состояния', 50_000, () => saveSnapshot(s, snap));
}

function benchRestore(): Measure {
  const s = freshState(4);
  const snap = createSnapshot(s);
  saveSnapshot(s, snap);
  return measure('восстановление', 50_000, () => loadSnapshot(s, snap));
}

function freshState(players: number): SimState {
  const s = createState(1, players);
  spawnPlayers(s);
  return s;
}

function main(): void {
  const results = [
    benchTick(1),
    benchTick(4),
    benchParticles(),
    benchHash(),
    benchSnapshot(),
    benchRestore(),
  ];

  const failed = results.filter((r) => !r.ok);
  const json = process.argv.includes('--json');

  if (json) {
    console.log(JSON.stringify({ ok: failed.length === 0, budgetMs: FRAME_BUDGET_MS, results }));
  } else {
    console.log(`бюджет кадра ${round(FRAME_BUDGET_MS, 2)} мс, порог запаса ×${MIN_HEADROOM}\n`);
    for (const r of results) {
      const mark = r.ok ? '✓' : '✗';
      console.log(
        `${mark} ${r.name.padEnd(20)} ${String(r.msPerOp).padStart(10)} мс` +
          `   запас ×${r.headroom}`,
      );
    }
    console.log(
      failed.length === 0
        ? '\nвсё в бюджете'
        : `\nне уложились: ${failed.map((f) => f.name).join(', ')}`,
    );
  }

  process.exit(failed.length === 0 ? 0 : 1);
}

main();

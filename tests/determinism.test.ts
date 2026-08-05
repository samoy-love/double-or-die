/**
 * Детерминизм — единственное решение проекта, которое невозможно принять
 * позже. Из него следуют реплеи, дейли, античит, Monte-Carlo балансировка
 * и онлайн. Эти тесты — гейт, а не украшение.
 */

import { describe, expect, it } from 'vitest';
import {
  Stream,
  createSnapshot,
  createState,
  createStreams,
  hashState,
  loadSnapshot,
  makeFrame,
  nextInt,
  saveSnapshot,
  spawnPlayers,
  step,
  type InputFrame,
} from '@dod/sim';
import { ReplayPlayer, ReplayRecorder, deserialize, serialize } from '@dod/sim/replay';
import { makeBot } from '@dod/tools/bots';

function runToHash(seed: number, ticks: number, players = 1, bot = 'random' as const): number {
  const s = createState(seed, players);
  spawnPlayers(s);
  const b = makeBot(bot, seed, players);
  for (let t = 0; t < ticks; t++) step(s, b.inputs(s));
  return hashState(s);
}

describe('генератор случайных чисел', () => {
  it('воспроизводим при одном сиде', () => {
    const a = createStreams(12345);
    const b = createStreams(12345);
    for (let i = 0; i < 1000; i++) {
      expect(nextInt(a, Stream.Waves, 1000)).toBe(nextInt(b, Stream.Waves, 1000));
    }
  });

  it('разные сиды дают разные последовательности', () => {
    const a = createStreams(1);
    const b = createStreams(2);
    let same = 0;
    for (let i = 0; i < 100; i++) {
      if (nextInt(a, Stream.Waves, 1000) === nextInt(b, Stream.Waves, 1000)) same++;
    }
    expect(same).toBeLessThan(10);
  });

  /**
   * Смысл разделения потоков: обращение к одному не должно сдвигать
   * остальные. Без этого правка любой системы ломает сиды всех прочих,
   * и дейли перестают воспроизводиться между версиями.
   */
  it('потоки независимы', () => {
    const a = createStreams(777);
    const b = createStreams(777);

    // В одном экземпляре активно дёргаем поток волн...
    for (let i = 0; i < 500; i++) nextInt(a, Stream.Waves, 100);

    // ...а поток карт обязан остаться там же, где и был.
    const fromA = nextInt(a, Stream.Cards, 10000);
    const fromB = nextInt(b, Stream.Cards, 10000);
    expect(fromA).toBe(fromB);
  });
});

describe('симуляция', () => {
  it('один сид даёт один хеш', () => {
    for (const seed of [1, 42, 1337, 99999]) {
      expect(runToHash(seed, 600)).toBe(runToHash(seed, 600));
    }
  });

  it('разные сиды расходятся', () => {
    expect(runToHash(1, 600)).not.toBe(runToHash(2, 600));
  });

  it('состав игроков влияет на состояние', () => {
    expect(runToHash(7, 600, 1)).not.toBe(runToHash(7, 600, 4));
  });

  it('пустой ввод не двигает игрока', () => {
    const s = createState(1, 1);
    spawnPlayers(s);
    const x0 = s.pX[0];
    const y0 = s.pY[0];
    const idle: InputFrame[] = [makeFrame()];
    for (let t = 0; t < 300; t++) step(s, idle);
    expect(s.pX[0]).toBe(x0);
    expect(s.pY[0]).toBe(y0);
  });
});

describe('снимки состояния', () => {
  it('восстановление возвращает точно то же состояние', () => {
    const s = createState(555, 2);
    spawnPlayers(s);
    const bot = makeBot('random', 555, 2);

    for (let t = 0; t < 200; t++) step(s, bot.inputs(s));

    const snap = createSnapshot(s);
    saveSnapshot(s, snap);
    const hashAtSave = hashState(s);

    for (let t = 0; t < 200; t++) step(s, bot.inputs(s));
    expect(hashState(s)).not.toBe(hashAtSave);

    loadSnapshot(s, snap);
    expect(hashState(s)).toBe(hashAtSave);
  });
});

describe('реплеи', () => {
  it('переигрывание даёт тот же хеш', () => {
    const seed = 4242;
    const ticks = 900;

    const rec = new ReplayRecorder({
      seed,
      playerCount: 1,
      configVersion: 'test',
      build: 'test',
    });
    const live = createState(seed, 1);
    spawnPlayers(live);
    const bot = makeBot('random', seed, 1);

    for (let t = 0; t < ticks; t++) {
      const inputs = bot.inputs(live);
      rec.record(inputs);
      step(live, inputs);
    }
    const expected = hashState(live);

    const replay = rec.finish();
    const back = createState(replay.seed, replay.playerCount);
    spawnPlayers(back);
    const player = new ReplayPlayer(replay);
    while (!player.done) step(back, player.next());

    expect(hashState(back)).toBe(expected);
  });

  it('сериализация не теряет кадры', () => {
    const rec = new ReplayRecorder({
      seed: 9,
      playerCount: 2,
      configVersion: 'test',
      build: 'test',
    });
    const s = createState(9, 2);
    spawnPlayers(s);
    const bot = makeBot('random', 9, 2);
    for (let t = 0; t < 300; t++) {
      const inputs = bot.inputs(s);
      rec.record(inputs);
      step(s, inputs);
    }

    const original = rec.finish();
    const restored = deserialize(serialize(original));

    expect(restored.ticks).toBe(original.ticks);
    expect(restored.seed).toBe(original.seed);
    expect(Array.from(restored.frames)).toEqual(Array.from(original.frames));
  });
});

describe('полнота списка буферов', () => {
  /*
   * Буфер, забытый в `collectBuffers`, — это десинк, который невозможно найти
   * по симптому.
   *
   * Он не входит ни в снимок, ни в хеш: состояние восстанавливается частично,
   * сверка пиров молчит, а расхождение проявляется через полчаса игры и ни на
   * что не похоже. Проверка обходится в один проход по полям и ловит ошибку в
   * тот же коммит, в котором её сделали.
   */
  it('в views попадает каждый типизированный массив состояния', () => {
    const s = createState(1);
    const listed = new Set<object>(s.views);

    const missing: string[] = [];
    for (const [name, value] of Object.entries(s)) {
      if (name === 'views') continue;
      if (!ArrayBuffer.isView(value)) continue;
      if (!listed.has(value)) missing.push(name);
    }

    expect(missing).toEqual([]);
  });

  it('в views не попадает ничего лишнего', () => {
    const s = createState(1);
    const own = new Set<object>(
      Object.entries(s)
        .filter(([name, v]) => name !== 'views' && ArrayBuffer.isView(v))
        .map(([, v]) => v as object),
    );

    // Дубль в списке удвоил бы вклад буфера в хеш и удвоил бы работу снимка,
    // не сломав при этом ни одного теста — кроме этого.
    expect(s.views.length).toBe(own.size);
    for (const buf of s.views) expect(own.has(buf)).toBe(true);
  });
});

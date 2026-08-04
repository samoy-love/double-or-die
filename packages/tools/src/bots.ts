/**
 * Боты — не искусственный интеллект, а явно заданные стратегии для проверки
 * систем. `idle` доказывает, что игра не зависает сама по себе; `random` ищет
 * состояния, до которых человек не додумается.
 *
 * Боты живут в инструментах, а не в ядре: они порождают ввод, а не логику.
 */

import {
  type InputFrame,
  type SimState,
  Btn,
  Stream,
  createStreams,
  fromFloat,
  fromInt,
  makeFrame,
  nextInt,
  MAX_CARDS,
  MAX_ENEMIES,
  SHARED,
  toFloat,
  type RngState,
} from '../../sim/src/index';

export type BotName = 'idle' | 'random' | 'greedy';

export interface Bot {
  inputs(s: SimState): readonly InputFrame[];
}

class IdleBot implements Bot {
  private readonly frames: InputFrame[];
  constructor(players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
  }
  inputs(): readonly InputFrame[] {
    return this.frames;
  }
}

class RandomBot implements Bot {
  private readonly frames: InputFrame[];
  private readonly rng: RngState;

  constructor(seed: number, players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
    // Отдельный от симуляции генератор: ввод бота — это внешний источник,
    // и он не должен сдвигать потоки самой игры.
    this.rng = createStreams(seed ^ 0x5eed);
  }

  inputs(s: SimState): readonly InputFrame[] {
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      // Меняем направление не каждый тик: иначе бот дрожит на месте и
      // не доходит до краёв арены, где и живут интересные баги.
      if (s.tick % 20 === 0) {
        f.moveX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.moveY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.aimX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.aimY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
      }
      // Кнопки тоже держатся, а не дёргаются каждый тик. Причин две.
      // Живой игрок удерживает огонь, и лог, где кнопка меняется 60 раз в
      // секунду, не похож ни на один настоящий забег. А ещё именно на нём
      // ломается RLE-сжатие реплея: повторов не остаётся вовсе, и эталон
      // раздувается с десятков килобайт до сотен.
      if (s.tick % 10 === 0) {
        f.buttons = 0;
        if (nextInt(this.rng, Stream.Waves, 100) < 40) f.buttons |= Btn.Fire;
        if (nextInt(this.rng, Stream.Waves, 100) < 3) f.buttons |= Btn.Dash;
      }
    }
    return this.frames;
  }
}

/**
 * Жадный: берёт всё, что лежит, и не обналичивает никогда.
 *
 * Это не «умный игрок», а явно заданная стратегия из SIMULATION §3 — верхняя
 * граница ставочного поведения. Ею проверяется, что экономика не разваливается
 * от максимального стака: кон списывается за каждую карту, и упереться в
 * пустой кошелёк такой бот обязан сам, без запретов в коде.
 */
class GreedyBot implements Bot {
  private readonly frames: InputFrame[];
  private readonly rng: RngState;

  constructor(seed: number, players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
    this.rng = createStreams(seed ^ 0x9eed);
  }

  inputs(s: SimState): readonly InputFrame[] {
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      const px = toFloat(s.pX[i]);
      const py = toFloat(s.pY[i]);

      // Идём к ближайшей доступной карте: карта — это место, и весь смысл
      // жадности в том, чтобы за ней бежать.
      let cx = 0;
      let cy = 0;
      let best = Infinity;
      for (let c = 0; c < MAX_CARDS; c++) {
        if (!s.kActive[c]) continue;
        if (s.kOwner[c] !== SHARED && s.kOwner[c] !== i) continue;
        const dx = toFloat(s.kX[c]) - px;
        const dy = toFloat(s.kY[c]) - py;
        const d = Math.hypot(dx, dy);
        if (d < best) {
          best = d;
          cx = dx;
          cy = dy;
        }
      }

      f.buttons = Btn.Fire;
      if (best < Infinity) {
        const len = best || 1;
        f.moveX = fromFloat(cx / len);
        f.moveY = fromFloat(cy / len);
        // Кнопку жмём по фронту: подбор дискретен, и держать её бессмысленно.
        if (best < 60 && s.tick % 4 === 0) f.buttons |= Btn.Take;
      } else if (s.tick % 30 === 0) {
        f.moveX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.moveY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
      }

      // Целимся в ближайшего врага: жадный не пацифист.
      let ex = 1;
      let ey = 0;
      let near = Infinity;
      for (let e = 0; e < MAX_ENEMIES; e++) {
        if (!s.eActive[e]) continue;
        const dx = toFloat(s.eX[e]) - px;
        const dy = toFloat(s.eY[e]) - py;
        const d = Math.hypot(dx, dy);
        if (d < near) {
          near = d;
          ex = dx;
          ey = dy;
        }
      }
      const elen = near === Infinity ? 1 : near || 1;
      f.aimX = fromFloat(ex / elen);
      f.aimY = fromFloat(ey / elen);
    }
    return this.frames;
  }
}

export function makeBot(name: BotName, seed: number, players: number): Bot {
  switch (name) {
    case 'greedy':
      return new GreedyBot(seed, players);
    case 'random':
      return new RandomBot(seed, players);
    case 'idle':
    default:
      return new IdleBot(players);
  }
}

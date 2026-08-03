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
  fromInt,
  makeFrame,
  nextInt,
  type RngState,
} from '../../sim/src/index';

export type BotName = 'idle' | 'random';

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
      f.buttons = 0;
      if (nextInt(this.rng, Stream.Waves, 100) < 40) f.buttons |= Btn.Fire;
      if (nextInt(this.rng, Stream.Waves, 100) < 3) f.buttons |= Btn.Dash;
    }
    return this.frames;
  }
}

export function makeBot(name: BotName, seed: number, players: number): Bot {
  switch (name) {
    case 'random':
      return new RandomBot(seed, players);
    case 'idle':
    default:
      return new IdleBot(players);
  }
}

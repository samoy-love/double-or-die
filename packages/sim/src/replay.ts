/**
 * Запись и воспроизведение логов ввода.
 *
 * Лог — это весь забег: сид плюс кадры ввода. Из него бесплатно получаются
 * реплеи, дейли с античитом, golden-тесты, точное воспроизведение багов и
 * Monte-Carlo балансировка. Ради этого ядро и делалось детерминированным.
 */

import { type InputFrame, WORDS_PER_FRAME, makeFrame, readFrame, writeFrame } from './input';

export const REPLAY_FORMAT = 1;

export interface ReplayMeta {
  format: number;
  seed: number;
  playerCount: number;
  /** Версия симуляционного конфига: с другой лог не сойдётся. */
  configVersion: string;
  /** Версия сборки, записавшей лог. */
  build: string;
  ticks: number;
}

export interface Replay extends ReplayMeta {
  /** Плоский буфер: playerCount × WORDS_PER_FRAME слов на тик. */
  frames: Int32Array;
}

export class ReplayRecorder {
  private buf: Int32Array;
  private ticks = 0;

  constructor(
    private readonly meta: Omit<ReplayMeta, 'format' | 'ticks'>,
    capacityTicks = 60 * 60 * 25,
  ) {
    this.buf = new Int32Array(capacityTicks * meta.playerCount * WORDS_PER_FRAME);
  }

  record(inputs: readonly InputFrame[]): void {
    const stride = this.meta.playerCount * WORDS_PER_FRAME;
    const need = (this.ticks + 1) * stride;
    if (need > this.buf.length) {
      const grown = new Int32Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    const base = this.ticks * stride;
    for (let i = 0; i < this.meta.playerCount; i++) {
      writeFrame(this.buf, base + i * WORDS_PER_FRAME, inputs[i]);
    }
    this.ticks++;
  }

  finish(): Replay {
    return {
      format: REPLAY_FORMAT,
      ...this.meta,
      ticks: this.ticks,
      frames: this.buf.slice(0, this.ticks * this.meta.playerCount * WORDS_PER_FRAME),
    };
  }
}

export class ReplayPlayer {
  private readonly scratch: InputFrame[];
  private cursor = 0;

  constructor(private readonly replay: Replay) {
    this.scratch = Array.from({ length: replay.playerCount }, makeFrame);
  }

  get done(): boolean {
    return this.cursor >= this.replay.ticks;
  }

  /** Кадры очередного тика. Массив переиспользуется — копируйте, если храните. */
  next(): readonly InputFrame[] {
    const stride = this.replay.playerCount * WORDS_PER_FRAME;
    const base = this.cursor * stride;
    for (let i = 0; i < this.replay.playerCount; i++) {
      readFrame(this.replay.frames, base + i * WORDS_PER_FRAME, this.scratch[i]);
    }
    this.cursor++;
    return this.scratch;
  }
}

/**
 * Сериализация с RLE по неизменным кадрам.
 *
 * Стик подолгу держит одно направление, поэтому повторов в реальном забеге
 * большинство: сырой лог на 15 минут — около 320 КБ, сжатый — 50–120 КБ.
 */
export function serialize(r: Replay): string {
  const stride = r.playerCount * WORDS_PER_FRAME;
  const runs: number[] = [];

  let t = 0;
  while (t < r.ticks) {
    const base = t * stride;
    let run = 1;
    while (t + run < r.ticks && sameFrame(r.frames, base, (t + run) * stride, stride)) run++;
    runs.push(run);
    for (let w = 0; w < stride; w++) runs.push(r.frames[base + w]);
    t += run;
  }

  return JSON.stringify({
    format: r.format,
    seed: r.seed,
    playerCount: r.playerCount,
    configVersion: r.configVersion,
    build: r.build,
    ticks: r.ticks,
    runs,
  });
}

export function deserialize(json: string): Replay {
  const o = JSON.parse(json) as ReplayMeta & { runs: number[] };
  if (o.format !== REPLAY_FORMAT) {
    throw new Error(`формат реплея ${o.format}, ожидался ${REPLAY_FORMAT}`);
  }

  const stride = o.playerCount * WORDS_PER_FRAME;
  const frames = new Int32Array(o.ticks * stride);

  let src = 0;
  let t = 0;
  while (src < o.runs.length) {
    const run = o.runs[src++];
    const words = o.runs.slice(src, src + stride);
    src += stride;
    for (let k = 0; k < run; k++) {
      frames.set(words, (t + k) * stride);
    }
    t += run;
  }

  return { ...o, frames };
}

function sameFrame(buf: Int32Array, a: number, b: number, stride: number): boolean {
  for (let w = 0; w < stride; w++) if (buf[a + w] !== buf[b + w]) return false;
  return true;
}

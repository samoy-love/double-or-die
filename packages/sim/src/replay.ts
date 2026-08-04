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

/**
 * Потолок длины лога: 25 минут при 60 Гц.
 *
 * Забег идёт 12–18 минут, и запас взят с четвертью. Потолок нужен не ради
 * аккуратности: `ticks` из чужого файла — это длина массива, который мы
 * собираемся выделить, и число вроде 2^31 роняет процесс раньше, чем доходит
 * до проверки содержимого.
 */
const MAX_REPLAY_TICKS = 60 * 60 * 25;

/**
 * Разобрать лог. Бросает при любом расхождении с форматом.
 *
 * Строгость здесь не педантизм. Тот же разбор станет серверной проверкой
 * рекордов переигрыванием (SECURITY §3.2, версия 0.11.0), а значит на вход
 * ему придёт файл, который писал не наш рекордер, а тот, кто хочет попасть в
 * таблицу. Крафтовый лог обязан отвергаться с внятной причиной — не вешать
 * разбор бесконечным циклом, не выделять гигабайт по одному числу и не
 * оставлять после себя массив, наполовину заполненный мусором.
 */
export function deserialize(json: string): Replay {
  const o = JSON.parse(json) as ReplayMeta & { runs: number[] };
  if (o.format !== REPLAY_FORMAT) {
    throw new Error(`формат реплея ${o.format}, ожидался ${REPLAY_FORMAT}`);
  }
  // Сид уходит в RNG: дробное или нечисло даёт состояние, из которого забег
  // не воспроизводится, а расходится молча.
  if (!Number.isInteger(o.seed)) throw new Error(`сид реплея ${o.seed}, ожидалось целое`);
  if (!Number.isInteger(o.playerCount) || o.playerCount < 1 || o.playerCount > 4) {
    throw new Error(`игроков в реплее ${o.playerCount}, ожидалось 1..4`);
  }
  if (!Number.isInteger(o.ticks) || o.ticks < 0 || o.ticks > MAX_REPLAY_TICKS) {
    throw new Error(`тиков в реплее ${o.ticks}, ожидалось 0..${MAX_REPLAY_TICKS}`);
  }
  if (!Array.isArray(o.runs)) throw new Error('в реплее нет прогонов');

  const stride = o.playerCount * WORDS_PER_FRAME;
  // Каждый прогон — это длина плюс кадр целиком. Длина, не кратная шагу,
  // означает обрезанный или подделанный лог, а не «последний прогон короче».
  if (o.runs.length % (stride + 1) !== 0) {
    throw new Error(`прогонов ${o.runs.length} слов, не кратно ${stride + 1}`);
  }
  for (let i = 0; i < o.runs.length; i++) {
    if (!Number.isInteger(o.runs[i])) throw new Error(`прогон ${i}: слово не целое`);
  }

  const frames = new Int32Array(o.ticks * stride);

  let src = 0;
  let t = 0;
  while (src < o.runs.length) {
    const run = o.runs[src++];
    // Неположительный прогон — это вечный цикл: курсор по тикам не двигается,
    // а слова кончаются, только если повезёт.
    if (run <= 0) throw new Error(`длина прогона ${run}, ожидалось положительное`);
    if (t + run > o.ticks) throw new Error(`прогоны длиннее заявленных ${o.ticks} тиков`);
    for (let k = 0; k < run; k++) {
      for (let w = 0; w < stride; w++) frames[(t + k) * stride + w] = o.runs[src + w];
    }
    src += stride;
    t += run;
  }
  if (t !== o.ticks) throw new Error(`прогоны дают ${t} тиков, заявлено ${o.ticks}`);

  return { ...o, frames };
}

function sameFrame(buf: Int32Array, a: number, b: number, stride: number): boolean {
  for (let w = 0; w < stride; w++) if (buf[a + w] !== buf[b + w]) return false;
  return true;
}

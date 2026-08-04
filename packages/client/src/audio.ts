/**
 * Звук: процедурный синтез в Web Audio, ноль ассетов.
 *
 * Стадия A0 из PRODUCTION §5. Настройка — правкой числа, а не поиском сэмпла;
 * для аркадной обратной связи этого достаточно, а «неправильный сэмпл» хуже
 * честного синтезированного щелчка.
 *
 * Звук здесь несёт информацию, а не украшает: по нему игрок понимает, что
 * попал, что убил и что сейчас рванёт, не глядя на HUD (GDD §22). Отсюда три
 * решения, из-за которых этот файл сложнее одного осциллятора на событие:
 *
 *   — **Голос собирается из слоёв.** Удар это щелчок плюс тело плюс шум, и
 *     одним осциллятором он звучит как свисток. Слои дают характер, не требуя
 *     ни одного килобайта ассетов.
 *   — **Высота гуляет от раза к разу.** Двадцать одинаковых выстрелов подряд
 *     ухо слышит как дефект, а не как стрельбу. Разброс в четверть тона стоит
 *     одного умножения и убирает механичность целиком.
 *   — **Вариант звука несёт данные.** Смерть Клина, Кирпича и Фитиля звучат
 *     на разной высоте: игрок различает, кого убил, не глядя.
 *
 * Контекст создаётся лениво и по первому вводу: браузеры не дают запустить
 * звук до жеста пользователя, и попытка сделать это на загрузке даёт навсегда
 * молчащую вкладку.
 */

export type SoundName =
  | 'shot'
  | 'hit'
  | 'kill'
  | 'hurt'
  | 'pickup'
  | 'explosion'
  | 'telegraph'
  | 'spawn'
  | 'wave'
  | 'death'
  | 'cardTake'
  | 'cardToss'
  | 'cardFade'
  | 'cardExpire'
  | 'cashOut'
  | 'betWon'
  | 'betLost'
  | 'aceAppear'
  | 'aceGesture';

/** Один слой голоса: тон или шум со своей огибающей. */
interface Layer {
  /** `noise` — полоса шума, остальное — форма волны осциллятора. */
  wave: OscillatorType | 'noise';
  /** Частота в начале и в конце: падение или подъём. */
  from: number;
  to: number;
  duration: number;
  gain: number;
  /** Задержка от начала звука: из неё собираются короткие мелодии. */
  delay?: number;
  /** Добротность полосового фильтра для шума. Выше — уже полоса. */
  q?: number;
}

interface Voice {
  layers: readonly Layer[];
  /** Разброс высоты в полутонах, ±. Ноль — звук всегда одинаковый. */
  jitter: number;
}

/**
 * Голоса. Числа подобраны на слух, и это единственный честный способ:
 * ощущение удара — работа человека, а не расчёта (PRODUCTION §6).
 */
const VOICES: Record<SoundName, Voice> = {
  // Щелчок бойка, короткое тело и выхлоп. Разброс большой: стреляют часто.
  shot: {
    jitter: 1.5,
    layers: [
      { wave: 'square', from: 940, to: 260, duration: 0.05, gain: 0.09 },
      { wave: 'noise', from: 2600, to: 700, duration: 0.05, gain: 0.05, q: 0.8 },
      { wave: 'triangle', from: 190, to: 120, duration: 0.07, gain: 0.05 },
    ],
  },
  // Попадание: сухой цок повыше. Должен читаться сквозь стрельбу.
  hit: {
    jitter: 2,
    layers: [
      { wave: 'triangle', from: 1500, to: 800, duration: 0.04, gain: 0.07 },
      { wave: 'noise', from: 3600, to: 1600, duration: 0.035, gain: 0.05, q: 1.5 },
    ],
  },
  // Убийство: удар в грудь плюс хруст. Тело низкое — его слышно в каше.
  kill: {
    jitter: 1,
    layers: [
      { wave: 'sine', from: 240, to: 48, duration: 0.24, gain: 0.16 },
      { wave: 'sawtooth', from: 420, to: 90, duration: 0.12, gain: 0.08 },
      { wave: 'noise', from: 1400, to: 220, duration: 0.2, gain: 0.1, q: 0.5 },
    ],
  },
  // Урон игроку: намеренно неприятный — две расстроенные пилы вместе.
  hurt: {
    jitter: 0.5,
    layers: [
      { wave: 'sawtooth', from: 300, to: 70, duration: 0.4, gain: 0.2 },
      { wave: 'sawtooth', from: 214, to: 52, duration: 0.4, gain: 0.12 },
      { wave: 'noise', from: 900, to: 120, duration: 0.3, gain: 0.12, q: 0.4 },
    ],
  },
  // Фишка: два коротких блика вверх. Явно не «монетка» и явно не удар.
  pickup: {
    jitter: 1,
    layers: [
      { wave: 'triangle', from: 1050, to: 1050, duration: 0.05, gain: 0.09 },
      { wave: 'triangle', from: 1570, to: 1570, duration: 0.07, gain: 0.08, delay: 0.045 },
    ],
  },
  // Взрыв: длинный низ и широкая полоса шума.
  explosion: {
    jitter: 0.8,
    layers: [
      { wave: 'noise', from: 1100, to: 60, duration: 0.5, gain: 0.24, q: 0.3 },
      { wave: 'sine', from: 130, to: 34, duration: 0.45, gain: 0.22 },
      { wave: 'sawtooth', from: 320, to: 60, duration: 0.18, gain: 0.1 },
    ],
  },
  // Телеграф: короткий вопросительный подъём. Тихий — он предупреждает,
  // а не пугает, и звучит по нескольку раз в секунду.
  telegraph: {
    jitter: 1.5,
    layers: [{ wave: 'square', from: 420, to: 640, duration: 0.1, gain: 0.045 }],
  },
  // Метка спавна: глухой подъём из-под пола.
  spawn: {
    jitter: 2,
    layers: [
      { wave: 'sine', from: 90, to: 300, duration: 0.18, gain: 0.09 },
      { wave: 'noise', from: 400, to: 900, duration: 0.14, gain: 0.04, q: 1 },
    ],
  },
  // Волна: три ноты вверх. Единственное место, где звук почти музыка.
  wave: {
    jitter: 0,
    layers: [
      { wave: 'square', from: 392, to: 392, duration: 0.1, gain: 0.07 },
      { wave: 'square', from: 523, to: 523, duration: 0.1, gain: 0.07, delay: 0.09 },
      { wave: 'square', from: 659, to: 659, duration: 0.2, gain: 0.08, delay: 0.18 },
    ],
  },
  /*
   * Ставочные звуки. Часть из них игрок обязан считывать, НЕ ГЛЯДЯ на HUD
   * (GDD §22), поэтому каждый звучит непохоже на соседей.
   */

  // Подбор карты: шелест колоды и щелчок. Явно не «монетка» — иначе путается
  // с фишкой, а это разные классы решений.
  cardTake: {
    jitter: 0.7,
    layers: [
      { wave: 'noise', from: 5200, to: 2600, duration: 0.08, gain: 0.09, q: 0.7 },
      { wave: 'square', from: 300, to: 220, duration: 0.05, gain: 0.05, delay: 0.05 },
    ],
  },
  // Подброс Тузом: свист и шлепок о пол. Работает телеграфом — по нему видно,
  // что сейчас на арене станет одной картой больше.
  cardToss: {
    jitter: 0.5,
    layers: [
      { wave: 'sine', from: 700, to: 1500, duration: 0.22, gain: 0.06 },
      { wave: 'noise', from: 1800, to: 500, duration: 0.09, gain: 0.08, q: 0.6, delay: 0.24 },
    ],
  },
  /*
   * Истечение карты — это ДВА разных события, и звучать одинаково они не
   * имеют права.
   *
   * Первое — предупреждение за три секунды: «беги, если хочешь успеть».
   * Второе — сама карта истлела: «уже нет». Одним звуком на оба игрок учится
   * не различать шанс и его потерю, а весь смысл таймера карты в том, что
   * шанс кончается заметно.
   */

  // Предупреждение: угасающий звон, высокий и открытый (GDD §22).
  cardFade: {
    jitter: 0,
    layers: [
      { wave: 'triangle', from: 1400, to: 900, duration: 0.4, gain: 0.05 },
      { wave: 'triangle', from: 2100, to: 1350, duration: 0.4, gain: 0.03, delay: 0.02 },
    ],
  },
  // Истекла: глухой стук осевшей колоды. Ниже, короче и без звона — то же
  // событие в отрицательном смысле, а не его повтор.
  cardExpire: {
    jitter: 0.3,
    layers: [
      { wave: 'sine', from: 300, to: 120, duration: 0.18, gain: 0.07 },
      { wave: 'noise', from: 700, to: 240, duration: 0.12, gain: 0.05, q: 0.6 },
    ],
  },
  // «Забрать»: короткий кассовый аккорд и обрыв тика прогресса.
  cashOut: {
    jitter: 0,
    layers: [
      { wave: 'square', from: 880, to: 880, duration: 0.07, gain: 0.09 },
      { wave: 'square', from: 1320, to: 1320, duration: 0.1, gain: 0.08, delay: 0.06 },
      { wave: 'noise', from: 3000, to: 1200, duration: 0.06, gain: 0.05, q: 1.2 },
    ],
  },
  // Выигранное пари: каскад фишек вверх.
  betWon: {
    jitter: 0,
    layers: [
      { wave: 'triangle', from: 880, to: 880, duration: 0.08, gain: 0.09 },
      { wave: 'triangle', from: 1175, to: 1175, duration: 0.08, gain: 0.09, delay: 0.07 },
      { wave: 'triangle', from: 1568, to: 1568, duration: 0.16, gain: 0.1, delay: 0.14 },
    ],
  },
  // Провал: звон разбитого стекла и падающая нота. Ни с чем не спутать —
  // и не должно: это главный крючок «ещё разок».
  betLost: {
    jitter: 0.3,
    layers: [
      { wave: 'noise', from: 5000, to: 1800, duration: 0.25, gain: 0.12, q: 2 },
      { wave: 'sawtooth', from: 520, to: 90, duration: 0.5, gain: 0.14 },
    ],
  },
  // Появление Туза: шорох и смешок. Пространственный сигнал «сейчас будет
  // карта», а не украшение.
  aceAppear: {
    jitter: 0.4,
    layers: [
      { wave: 'noise', from: 900, to: 2200, duration: 0.2, gain: 0.05, q: 0.8 },
      { wave: 'triangle', from: 420, to: 620, duration: 0.09, gain: 0.05, delay: 0.16 },
      { wave: 'triangle', from: 380, to: 540, duration: 0.09, gain: 0.04, delay: 0.27 },
    ],
  },
  // Жест Туза: короткий росчерк, чтобы кривляние на краю арены заметили и
  // не глядя. Тише всего остального намеренно — он комментирует бой, а не
  // участвует в нём, и перебивать телеграф ему нечем.
  aceGesture: {
    jitter: 0.5,
    layers: [
      { wave: 'triangle', from: 300, to: 480, duration: 0.12, gain: 0.045 },
      { wave: 'noise', from: 1600, to: 700, duration: 0.14, gain: 0.03, q: 1.2 },
    ],
  },

  // Смерть: всё падает и гаснет.
  death: {
    jitter: 0,
    layers: [
      { wave: 'sawtooth', from: 440, to: 40, duration: 0.9, gain: 0.22 },
      { wave: 'sine', from: 220, to: 28, duration: 1.1, gain: 0.18 },
      { wave: 'noise', from: 1200, to: 80, duration: 0.7, gain: 0.12, q: 0.4 },
    ],
  },
};

/**
 * Сколько секунд ждать между одинаковыми звуками.
 *
 * Двадцать Клинов умирают в один тик — без ограничения это двадцать
 * наложенных голосов, то есть треск и мгновенная потеря информативности.
 */
const RATE_LIMIT: Partial<Record<SoundName, number>> = {
  aceGesture: 0.6,
  cardFade: 0.5,
  cardExpire: 0.25,
  betWon: 0.12,
  betLost: 0.12,
  hit: 0.035,
  kill: 0.05,
  shot: 0.045,
  pickup: 0.04,
  telegraph: 0.1,
  spawn: 0.09,
  explosion: 0.06,
};

/** Потолок одновременно звучащих голосов: дальше начинается каша и клиппинг. */
const MAX_VOICES = 24;

const semitones = (n: number): number => Math.pow(2, n / 12);

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private readonly lastPlayed = new Map<SoundName, number>();
  private live = 0;
  private muted = false;

  /** Громкость 0..1. Раздельные ползунки приезжают в 0.12.0. */
  volume = 0.7;

  /** Вызывается по первому вводу: до жеста браузер звук не разрешает. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor =
      window.AudioContext ??
      (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    const ctx = new Ctor();
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : this.volume;
    // Мягкое ограничение вместо жёсткого клиппинга: в пиковой волне голосов
    // много, и без компрессора они складываются в хрип.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    master.connect(limiter).connect(ctx.destination);

    // Шум генерируется один раз: создавать буфер на каждый выстрел значит
    // аллоцировать сотню килобайт в кадре.
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 0x2545f491;
    for (let i = 0; i < data.length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[i] = (seed >>> 0) / 0x80000000 - 1;
    }

    this.ctx = ctx;
    this.master = master;
    this.noiseBuffer = buffer;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.volume;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /**
   * Сыграть звук. `pitch` — множитель высоты: им звук несёт данные, а не
   * просто звучит (смерть Клина и смерть Кирпича различаются на слух).
   */
  play(name: SoundName, pitch = 1): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted) return;
    if (this.live >= MAX_VOICES) return;

    const now = ctx.currentTime;
    const limit = RATE_LIMIT[name];
    if (limit !== undefined) {
      const last = this.lastPlayed.get(name) ?? -1;
      if (now - last < limit) return;
      this.lastPlayed.set(name, now);
    }

    const voice = VOICES[name];
    const shift = voice.jitter === 0 ? 1 : semitones((Math.random() * 2 - 1) * voice.jitter);
    const k = pitch * shift;

    for (const layer of voice.layers) this.playLayer(ctx, master, layer, now, k);
  }

  private playLayer(
    ctx: AudioContext,
    master: GainNode,
    layer: Layer,
    now: number,
    pitch: number,
  ): void {
    const start = now + (layer.delay ?? 0);
    const end = start + layer.duration;
    const from = Math.max(20, layer.from * pitch);
    const to = Math.max(20, layer.to * pitch);

    const gain = ctx.createGain();
    // Мгновенная атака щёлкает; две миллисекунды подъёма её убирают, не
    // размазывая удар. Спад экспоненциальный: линейный слышен как обрыв.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(layer.gain, start + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    gain.connect(master);

    this.live++;
    const done = (): void => {
      this.live--;
      gain.disconnect();
    };

    if (layer.wave === 'noise') {
      if (!this.noiseBuffer) {
        done();
        return;
      }
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      noise.loop = true;
      // Старт со случайного места буфера: иначе каждый выстрел шумит одним и
      // тем же куском, и повтор слышен даже сквозь разброс высоты.
      const offset = Math.random() * (this.noiseBuffer.duration - layer.duration - 0.01);
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(from, start);
      filter.frequency.exponentialRampToValueAtTime(to, end);
      filter.Q.value = layer.q ?? 1;
      noise.connect(filter).connect(gain);
      noise.onended = done;
      noise.start(start, Math.max(0, offset), layer.duration);
      noise.stop(end);
      return;
    }

    const osc = ctx.createOscillator();
    osc.type = layer.wave;
    osc.frequency.setValueAtTime(from, start);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, end);
    osc.connect(gain);
    osc.onended = done;
    osc.start(start);
    osc.stop(end);
  }
}

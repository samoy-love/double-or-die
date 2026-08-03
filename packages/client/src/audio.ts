/**
 * Звук: процедурный синтез в Web Audio, ноль ассетов.
 *
 * Стадия A0 из PRODUCTION §5. Настройка — правкой числа, а не поиском сэмпла;
 * для аркадной обратной связи этого достаточно, а «неправильный сэмпл» хуже
 * честного синтезированного щелчка.
 *
 * Звук здесь несёт информацию, а не украшает: по нему игрок понимает, что
 * попал, что убил и что сейчас рванёт, не глядя на HUD (GDD §22).
 *
 * Контекст создаётся лениво и по первому вводу: браузеры не дают запустить
 * звук до жеста пользователя, и попытка сделать это на загрузке даёт
 * навсегда молчащую вкладку.
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
  | 'death';

interface Voice {
  /** Частота в начале и в конце — падение или подъём тона. */
  from: number;
  to: number;
  type: OscillatorType;
  duration: number;
  gain: number;
  /** Доля шума в смеси: удары и взрывы без него звучат как свисток. */
  noise: number;
}

/**
 * Голоса. Числа подобраны на слух, и это единственный честный способ:
 * ощущение удара — работа человека, а не расчёта (PRODUCTION §6).
 */
const VOICES: Record<SoundName, Voice> = {
  shot: { from: 620, to: 180, type: 'square', duration: 0.07, gain: 0.16, noise: 0.25 },
  hit: { from: 900, to: 420, type: 'triangle', duration: 0.05, gain: 0.13, noise: 0.5 },
  kill: { from: 320, to: 70, type: 'sawtooth', duration: 0.22, gain: 0.22, noise: 0.55 },
  hurt: { from: 220, to: 60, type: 'sawtooth', duration: 0.35, gain: 0.3, noise: 0.35 },
  pickup: { from: 880, to: 1500, type: 'triangle', duration: 0.09, gain: 0.14, noise: 0 },
  explosion: { from: 180, to: 40, type: 'sawtooth', duration: 0.45, gain: 0.32, noise: 0.8 },
  telegraph: { from: 260, to: 340, type: 'square', duration: 0.12, gain: 0.09, noise: 0.1 },
  spawn: { from: 140, to: 300, type: 'sine', duration: 0.16, gain: 0.1, noise: 0.15 },
  wave: { from: 300, to: 620, type: 'square', duration: 0.3, gain: 0.14, noise: 0 },
  death: { from: 400, to: 40, type: 'sawtooth', duration: 0.9, gain: 0.3, noise: 0.3 },
};

/**
 * Сколько одинаковых звуков в секунду пропускаем.
 *
 * Двадцать Клинов умирают в один тик — без ограничения это двадцать
 * наложенных сэмплов, то есть треск и мгновенная потеря информативности.
 */
const RATE_LIMIT: Partial<Record<SoundName, number>> = {
  hit: 0.03,
  kill: 0.05,
  shot: 0.05,
  pickup: 0.04,
  telegraph: 0.08,
  spawn: 0.08,
};

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private readonly lastPlayed = new Map<SoundName, number>();
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
    master.gain.value = this.volume;
    master.connect(ctx.destination);

    // Шум генерируется один раз: создавать буфер на каждый выстрел значит
    // аллоцировать сотню килобайт в кадре.
    const seconds = 1;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
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

  play(name: SoundName): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted) return;

    const now = ctx.currentTime;
    const limit = RATE_LIMIT[name];
    if (limit !== undefined) {
      const last = this.lastPlayed.get(name) ?? -1;
      if (now - last < limit) return;
      this.lastPlayed.set(name, now);
    }

    const v = VOICES[name];
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(v.gain, now);
    // Экспоненциальный спад: линейный слышен как щелчок в конце.
    gain.gain.exponentialRampToValueAtTime(0.0001, now + v.duration);
    gain.connect(master);

    const osc = ctx.createOscillator();
    osc.type = v.type;
    osc.frequency.setValueAtTime(v.from, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, v.to), now + v.duration);
    const toneGain = ctx.createGain();
    toneGain.gain.value = 1 - v.noise;
    osc.connect(toneGain).connect(gain);
    osc.start(now);
    osc.stop(now + v.duration);

    if (v.noise > 0 && this.noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;
      noise.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(v.from, now);
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, v.to), now + v.duration);
      filter.Q.value = 1.2;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = v.noise;
      noise.connect(filter).connect(noiseGain).connect(gain);
      noise.start(now);
      noise.stop(now + v.duration);
    }
  }
}

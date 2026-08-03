/**
 * Частицы: пул фиксированного размера, ноль аллокаций в кадре.
 *
 * Живут в клиенте, а не в симуляции, и это принципиально. Частица ни на что не
 * влияет, значит в состоянии ей не место: она раздула бы снимок, попала бы в
 * хеш и превратила бы косметическую правку в слом детерминизма. Цена — частицы
 * не переигрываются в реплее, и это ровно та цена, которую надо платить.
 *
 * Время здесь настоящее, в секундах, а не в тиках: частицы обязаны идти
 * плавно на 144 Гц и замирать вместе с хитстопом.
 */

import type { Rgb } from './palette';

/** Потолок из ROADMAP: нагрузочный бенч требует держать 2000 частиц. */
export const MAX_PARTICLES = 2400;

export const enum ParticleShape {
  Dot = 0,
  Ring = 1,
  Shard = 2,
}

export class Particles {
  private readonly x = new Float32Array(MAX_PARTICLES);
  private readonly y = new Float32Array(MAX_PARTICLES);
  private readonly vx = new Float32Array(MAX_PARTICLES);
  private readonly vy = new Float32Array(MAX_PARTICLES);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private readonly size = new Float32Array(MAX_PARTICLES);
  private readonly growth = new Float32Array(MAX_PARTICLES);
  private readonly spin = new Float32Array(MAX_PARTICLES);
  private readonly angle = new Float32Array(MAX_PARTICLES);
  private readonly drag = new Float32Array(MAX_PARTICLES);
  private readonly r = new Float32Array(MAX_PARTICLES);
  private readonly g = new Float32Array(MAX_PARTICLES);
  private readonly b = new Float32Array(MAX_PARTICLES);
  private readonly shape = new Uint8Array(MAX_PARTICLES);
  /** Курсор кольцевого распределения: старую частицу вытесняет новая. */
  private cursor = 0;
  private live = 0;

  get count(): number {
    return this.live;
  }

  clear(): void {
    this.life.fill(0);
    this.live = 0;
  }

  /**
   * Выпустить частицу. При переполнении вытесняется самая старая по кругу:
   * пропустить новую вспышку заметнее, чем потерять одну догорающую.
   */
  spawn(
    shape: ParticleShape,
    x: number,
    y: number,
    vx: number,
    vy: number,
    size: number,
    lifeSeconds: number,
    colour: Rgb,
    growth = 0,
    drag = 4,
    spin = 0,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX_PARTICLES;
    if (this.life[i] <= 0) this.live++;

    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.life[i] = lifeSeconds;
    this.maxLife[i] = lifeSeconds;
    this.size[i] = size;
    this.growth[i] = growth;
    this.drag[i] = drag;
    this.spin[i] = spin;
    this.angle[i] = 0;
    this.r[i] = colour.r;
    this.g[i] = colour.g;
    this.b[i] = colour.b;
    this.shape[i] = shape;
  }

  /** Шаг по реальному времени. В хитстопе не вызывается — картинка замирает. */
  update(dt: number): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.live--;
        continue;
      }
      const damp = 1 - Math.min(1, this.drag[i] * dt);
      this.vx[i] *= damp;
      this.vy[i] *= damp;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      this.size[i] += this.growth[i] * dt;
      this.angle[i] += this.spin[i] * dt;
    }
  }

  /**
   * Обойти живые частицы. Колбэк вместо массива объектов: две тысячи частиц —
   * это две тысячи объектов на кадр, то есть сборщик посреди боя.
   */
  each(
    fn: (
      shape: number,
      x: number,
      y: number,
      size: number,
      angle: number,
      r: number,
      g: number,
      b: number,
      alpha: number,
    ) => void,
  ): void {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const life = this.life[i];
      if (life <= 0) continue;
      // Гаснут по квадрату: линейное угасание читается как «мигнуло и
      // пропало», квадратичное — как «догорело».
      const t = life / this.maxLife[i];
      fn(
        this.shape[i],
        this.x[i],
        this.y[i],
        Math.max(0.5, this.size[i]),
        this.angle[i],
        this.r[i],
        this.g[i],
        this.b[i],
        t * t,
      );
    }
  }
}

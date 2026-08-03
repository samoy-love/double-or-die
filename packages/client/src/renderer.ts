/**
 * Рендер.
 *
 * В 0.1.0 — Canvas 2D: задача версии доказать детерминизм и дать агенту
 * управление, а не тянуть тысячи частиц. WebGL2 с батчингом приезжает в
 * 0.2.0 вместе с сочностью, ради которой он и нужен. Интерфейс здесь уже
 * такой, чтобы подмена бэкенда не задела вызывающий код.
 *
 * Рендер интерполирует между тиками: симуляция идёт ровно 60 Гц, а экран
 * может быть 120 или 144 — плавность достаётся бесплатно.
 */

import { ARENA_H, ARENA_W, EntityFlag, type SimState, toFloat } from '../../sim/src/index';
import { PALETTE, css, type Rgb } from './palette';

const W = toFloat(ARENA_W);
const H = toFloat(ARENA_H);

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private prevX = new Float64Array(4);
  private prevY = new Float64Array(4);

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D недоступен');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
  }

  /** Запомнить позиции прошлого тика — между ними и идёт интерполяция. */
  capture(s: SimState): void {
    for (let i = 0; i < s.playerCount; i++) {
      this.prevX[i] = toFloat(s.pX[i]);
      this.prevY[i] = toFloat(s.pY[i]);
    }
  }

  /** `alpha` — доля пройденного тика, 0..1. */
  draw(s: SimState, alpha: number): void {
    const { ctx, canvas } = this;
    const scale = Math.min(canvas.width / W, canvas.height / H);
    const offX = (canvas.width - W * scale) / 2;
    const offY = (canvas.height - H * scale) / 2;

    ctx.fillStyle = css(PALETTE.background);
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(offX, offY);
    ctx.scale(scale, scale);

    this.drawFloor();
    this.drawPlayers(s, alpha);

    ctx.restore();
  }

  private drawFloor(): void {
    const { ctx } = this;
    ctx.fillStyle = css(PALETTE.floor);
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = css(PALETTE.grid);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= W; x += 120) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
    }
    for (let y = 0; y <= H; y += 120) {
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
    }
    ctx.stroke();
  }

  private drawPlayers(s: SimState, alpha: number): void {
    const { ctx } = this;

    for (let i = 0; i < s.playerCount; i++) {
      if ((s.pFlags[i] & EntityFlag.Alive) === 0) continue;

      const x = lerp(this.prevX[i], toFloat(s.pX[i]), alpha);
      const y = lerp(this.prevY[i], toFloat(s.pY[i]), alpha);
      const colour = PALETTE.player[i] as Rgb;
      const invul = (s.pFlags[i] & EntityFlag.Invulnerable) !== 0;

      // Нимб: игрок обязан быть различим в толпе всегда.
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = css(colour);
      circle(ctx, x, y, 34);
      ctx.globalAlpha = 1;

      // Мигание при неуязвимости — по номеру тика, а не по времени:
      // так картинка совпадает с состоянием, а не живёт своей жизнью.
      if (invul && (s.tick >> 2) % 2 === 0) ctx.globalAlpha = 0.45;

      ctx.fillStyle = css(colour);
      circle(ctx, x, y, 22);
      ctx.globalAlpha = 1;

      ctx.strokeStyle = css(PALETTE.hudText);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 22, 0, Math.PI * 2);
      ctx.stroke();

      // Направление прицела: в 0.1.0 это единственный способ увидеть,
      // что ввод доехал до симуляции.
      const ax = toFloat(s.pAimX[i]);
      const ay = toFloat(s.pAimY[i]);
      ctx.strokeStyle = css(PALETTE.bullet);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x + ax * 26, y + ay * 26);
      ctx.lineTo(x + ax * 46, y + ay * 46);
      ctx.stroke();
    }
  }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Рендер на WebGL2.
 *
 * Весь кадр — один вызов отрисовки: фигуры собираются в инстансы и уходят
 * батчем (`gl/batch.ts`). Canvas 2D остался в 0.1.0 вместе с четырьмя
 * квадратами; две тысячи частиц с обводками он не тянет, и именно поэтому
 * WebGL2 стоит в воротах этой версии.
 *
 * Порядок вызовов задаёт иерархию читаемости GDD §21, снизу вверх:
 * фон → пол → колонны → метки спавна → телеграфы → фишки → враги → игроки →
 * снаряды → частицы → HUD. Снаряды выше всего боевого намеренно: «снаряды
 * всегда светлее и ярче остального» — правило, а не пожелание.
 *
 * Рендер интерполирует между тиками: симуляция идёт ровно 60 Гц, а экран
 * может быть 120 или 144 — плавность достаётся бесплатно.
 */

import {
  ENEMIES,
  EnemyPhase,
  EnemyType,
  EntityFlag,
  COLUMNS,
  FUSE,
  MAX_BULLETS,
  MAX_CHIPS,
  MAX_ENEMIES,
  MAX_PLAYERS,
  MAX_SPAWNS,
  Meta,
  PLAYER,
  WEDGE,
  arenaScale,
  type SimState,
  toFloat,
} from '../../sim/src/index';
import type { Feedback } from './feedback';
import type { Feel } from './feel';
import { Shape, ShapeBatch } from './gl/batch';
import { PALETTE, type Rgb } from './palette';
import { ParticleShape, type Particles } from './particles';

/** Толщина обводки из арт-дирекшна: 4 u на всём (GDD §21). */
const STROKE = 4;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly batch: ShapeBatch;
  private readonly prevX = new Float64Array(MAX_PLAYERS);
  private readonly prevY = new Float64Array(MAX_PLAYERS);
  private readonly prevEX = new Float64Array(MAX_ENEMIES);
  private readonly prevEY = new Float64Array(MAX_ENEMIES);
  private readonly prevBX = new Float64Array(MAX_BULLETS);
  private readonly prevBY = new Float64Array(MAX_BULLETS);
  /** Фигур в последнем кадре: по нему видно, во что упирается рендер. */
  lastShapeCount = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      // Сглаживание считается в шейдере по расстоянию, MSAA не нужен;
      // отказ от него экономит заметную долю кадра на встроенной графике.
      powerPreference: 'high-performance',
      desynchronized: true,
    });
    if (!gl) {
      throw new Error(
        'WebGL2 недоступен: без него игра не рисуется. Обновите браузер или включите аппаратное ускорение.',
      );
    }
    this.gl = gl;
    this.batch = new ShapeBatch(gl);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Запомнить позиции прошлого тика — между ними и идёт интерполяция. */
  capture(s: SimState): void {
    for (let i = 0; i < s.playerCount; i++) {
      this.prevX[i] = toFloat(s.pX[i]);
      this.prevY[i] = toFloat(s.pY[i]);
    }
    for (let i = 0; i < MAX_ENEMIES; i++) {
      if (!s.eActive[i]) continue;
      this.prevEX[i] = toFloat(s.eX[i]);
      this.prevEY[i] = toFloat(s.eY[i]);
    }
    for (let i = 0; i < MAX_BULLETS; i++) {
      if (!s.bActive[i]) continue;
      this.prevBX[i] = toFloat(s.bX[i]);
      this.prevBY[i] = toFloat(s.bY[i]);
    }
  }

  /** `alpha` — доля пройденного тика, 0..1. */
  draw(s: SimState, alpha: number, feel: Feel, particles: Particles, fb: Feedback): void {
    const { gl, canvas, batch } = this;
    const arenaW = toFloat(s.arenaW);
    const arenaH = toFloat(s.arenaH);

    const bg = PALETTE.background;
    gl.clearColor(bg.r, bg.g, bg.b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    batch.begin();
    this.drawFloor(arenaW, arenaH, s);
    this.drawSpawnMarks(s);
    this.drawTelegraphs(s, alpha);
    this.drawChips(s);
    this.drawEnemies(s, alpha, fb);
    this.drawPlayers(s, alpha, fb);
    this.drawBullets(s, alpha);
    this.drawParticles(particles);
    this.drawHud(s, arenaW, arenaH);
    this.drawScreenEffects(feel, arenaW, arenaH);

    const scale = Math.min(canvas.width / arenaW, canvas.height / arenaH);
    const padX = (canvas.width - arenaW * scale) / 2;
    const padY = (canvas.height - arenaH * scale) / 2;
    const sx = (2 * scale) / canvas.width;
    const sy = (-2 * scale) / canvas.height;
    this.lastShapeCount = batch.size;
    batch.flush(
      sx,
      sy,
      (2 * padX) / canvas.width - 1 + feel.offsetX * sx,
      1 - (2 * padY) / canvas.height + feel.offsetY * sy,
    );
  }

  // -------------------------------------------------------------------------
  // Арена
  // -------------------------------------------------------------------------

  private drawFloor(w: number, h: number, s: SimState): void {
    const b = this.batch;
    b.push(Shape.Box, w / 2, h / 2, w / 2, h / 2, 0, ...channels(PALETTE.floor), 1, 0, 0, 0, 0, 0);

    // Сетка: по ней читается масштаб и скорость собственного движения.
    const step = 120;
    const g = PALETTE.grid;
    for (let x = step; x < w; x += step) {
      b.push(Shape.Box, x, h / 2, 1, h / 2, 0, g.r, g.g, g.b, 1, 0, 0, 0, 0, 0);
    }
    for (let y = step; y < h; y += step) {
      b.push(Shape.Box, w / 2, y, w / 2, 1, 0, g.r, g.g, g.b, 1, 0, 0, 0, 0, 0);
    }

    const k = arenaScale(s.playerCount) / 100;
    for (const c of COLUMNS) {
      b.push(
        Shape.Box,
        toFloat(c.x) * k,
        toFloat(c.y) * k,
        toFloat(c.halfW),
        toFloat(c.halfH),
        0,
        ...channels(PALETTE.background),
        1,
        STROKE,
        ...channels(PALETTE.grid),
        1,
      );
    }
  }

  /**
   * Метки будущего спавна.
   *
   * Правило честности «спавн вне поля зрения — с меткой за 0.5 с»
   * (DIFFICULTY §7) существует в симуляции, но игроку оно доступно только
   * здесь: невидимая метка не предупреждает ни о чём.
   */
  private drawSpawnMarks(s: SimState): void {
    for (let i = 0; i < MAX_SPAWNS; i++) {
      if (!s.spActive[i]) continue;
      const left = Math.max(0, s.spAt[i] - s.tick);
      const t = 1 - left / 30;
      const c = PALETTE.spawnMark;
      this.batch.push(
        Shape.Ring,
        toFloat(s.spX[i]),
        toFloat(s.spY[i]),
        14 + 26 * (1 - t),
        14 + 26 * (1 - t),
        0,
        0,
        0,
        0,
        0,
        STROKE,
        c.r,
        c.g,
        c.b,
        0.35 + 0.5 * t,
      );
    }
  }

  /**
   * Телеграфы: объявленная атака обязана быть видна.
   *
   * Геометрия повторяет ту, по которой считается урон, — коридор тарана,
   * радиус взрыва, линия выстрела. Расходиться им нельзя: телеграф, не
   * совпадающий с ударом, хуже отсутствующего, потому что учит неправде.
   */
  private drawTelegraphs(s: SimState, alpha: number): void {
    const b = this.batch;
    const d = PALETTE.danger;

    for (let i = 0; i < MAX_ENEMIES; i++) {
      if (!s.eActive[i] || s.ePhase[i] !== EnemyPhase.Telegraph) continue;
      const x = lerp(this.prevEX[i], toFloat(s.eX[i]), alpha);
      const y = lerp(this.prevEY[i], toFloat(s.eY[i]), alpha);
      const stats = ENEMIES[s.eType[i]];
      const left = Math.max(0, s.ePhaseUntil[i] - s.tick);
      // Пульсация — не украшение: по ней читается, сколько осталось.
      const urgency = 1 - left / Math.max(1, stats.telegraphTicks);
      const dx = toFloat(s.eDirX[i]);
      const dy = toFloat(s.eDirY[i]);

      if (s.eType[i] === EnemyType.Fuse) {
        const r = toFloat(FUSE.blastRadius);
        b.push(
          Shape.Ring,
          x,
          y,
          r,
          r,
          0,
          0,
          0,
          0,
          0,
          STROKE + 2,
          d.r,
          d.g,
          d.b,
          0.3 + 0.6 * urgency,
        );
        continue;
      }

      const len =
        s.eType[i] === EnemyType.Wedge
          ? toFloat(WEDGE.dashSpeed) * stats.attackTicks
          : toFloat(s.arenaW);
      const width = s.eType[i] === EnemyType.Wedge ? toFloat(stats.radius) : 7;
      const angle = Math.atan2(dy, dx);
      b.push(
        Shape.Capsule,
        x + (dx * len) / 2,
        y + (dy * len) / 2,
        len / 2 + width,
        width,
        angle,
        d.r,
        d.g,
        d.b,
        0.1 + 0.16 * urgency,
        2,
        d.r,
        d.g,
        d.b,
        0.35 + 0.45 * urgency,
      );
    }
  }

  private drawChips(s: SimState): void {
    const c = PALETTE.chip;
    for (let i = 0; i < MAX_CHIPS; i++) {
      if (!s.cActive[i]) continue;
      const x = toFloat(s.cX[i]);
      const y = toFloat(s.cY[i]);
      // Мигание за полсекунды до исчезновения: предупреждение без интерфейса.
      const left = s.cDeadline[i] - s.tick;
      if (left < 30 && (s.tick >> 2) % 2 === 0) continue;
      this.batch.push(
        Shape.Circle,
        x,
        y,
        11,
        11,
        0,
        c.r,
        c.g,
        c.b,
        1,
        3,
        ...channels(PALETTE.eye),
        0.8,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Сущности
  // -------------------------------------------------------------------------

  private drawEnemies(s: SimState, alpha: number, fb: Feedback): void {
    const b = this.batch;

    for (let i = 0; i < MAX_ENEMIES; i++) {
      if (!s.eActive[i]) continue;
      const x = lerp(this.prevEX[i], toFloat(s.eX[i]), alpha);
      const y = lerp(this.prevEY[i], toFloat(s.eY[i]), alpha);
      const type = s.eType[i] as EnemyType;
      const stats = ENEMIES[type];
      const r = toFloat(stats.radius);

      const flash = fb.enemyFlash[i] > 0;
      const colour = flash ? PALETTE.bullet : enemyColour(type);
      const squash = fb.enemySquash[i];

      // Фитиль пульсирует всегда, а с подожжённым фитилём — вдвое чаще:
      // «сейчас рванёт» должно читаться и без телеграфа под ним.
      const lit = type === EnemyType.Fuse && s.ePhase[i] === EnemyPhase.Telegraph;
      const pulse = type === EnemyType.Fuse ? 1 + 0.12 * Math.sin(s.tick * (lit ? 0.6 : 0.2)) : 1;

      const vx = toFloat(s.eVX[i]);
      const vy = toFloat(s.eVY[i]);
      const facing =
        s.ePhase[i] === EnemyPhase.Telegraph || s.ePhase[i] === EnemyPhase.Attack
          ? Math.atan2(toFloat(s.eDirY[i]), toFloat(s.eDirX[i]))
          : Math.atan2(vy, vx);

      const shape =
        type === EnemyType.Wedge
          ? Shape.Triangle
          : type === EnemyType.Brick
            ? Shape.Box
            : Shape.Circle;
      const rot = type === EnemyType.Brick ? 0 : facing;

      b.push(
        shape,
        x,
        y,
        r * pulse * (1 + squash),
        r * pulse * (1 - squash * 0.6),
        rot,
        colour.r,
        colour.g,
        colour.b,
        1,
        STROKE,
        ...channels(PALETTE.background),
        1,
      );

      this.drawEyes(x, y, r * 0.45, Math.cos(facing), Math.sin(facing), r * 0.26, lit);
    }
  }

  /** Глаза следят за целью: без них фигуры — это фигуры, а не существа. */
  private drawEyes(
    x: number,
    y: number,
    offset: number,
    dirX: number,
    dirY: number,
    size: number,
    squint: boolean,
  ): void {
    const b = this.batch;
    // Пара глаз ставится перпендикулярно взгляду, зрачок смещён по взгляду.
    const px = -dirY;
    const py = dirX;
    for (const side of [-1, 1]) {
      const ex = x + dirX * offset * 0.6 + px * offset * side;
      const ey = y + dirY * offset * 0.6 + py * offset * side;
      b.push(
        Shape.Circle,
        ex,
        ey,
        size,
        size * (squint ? 0.45 : 1),
        0,
        ...channels(PALETTE.eye),
        1,
        0,
        0,
        0,
        0,
        0,
      );
      b.push(
        Shape.Circle,
        ex + dirX * size * 0.4,
        ey + dirY * size * 0.4,
        size * 0.5,
        size * 0.5 * (squint ? 0.45 : 1),
        0,
        ...channels(PALETTE.pupil),
        1,
        0,
        0,
        0,
        0,
        0,
      );
    }
  }

  private drawPlayers(s: SimState, alpha: number, fb: Feedback): void {
    const b = this.batch;

    for (let i = 0; i < s.playerCount; i++) {
      if ((s.pFlags[i] & EntityFlag.Alive) === 0) continue;

      const x = lerp(this.prevX[i], toFloat(s.pX[i]), alpha);
      const y = lerp(this.prevY[i], toFloat(s.pY[i]), alpha);
      const colour = PALETTE.player[i] as Rgb;
      const invul = (s.pFlags[i] & EntityFlag.Invulnerable) !== 0;
      const r = toFloat(PLAYER.visualRadius);

      // Нимб: игрок обязан быть различим в толпе всегда (GDD §21).
      b.push(
        Shape.Circle,
        x,
        y,
        r * 1.6,
        r * 1.6,
        0,
        colour.r,
        colour.g,
        colour.b,
        0.16,
        0,
        0,
        0,
        0,
        0,
      );

      // Растяжение по направлению движения плюс сжатие от удара — squash and
      // stretch, из-за которого капля читается как живая, а не как круг.
      const vx = toFloat(s.pVX[i]);
      const vy = toFloat(s.pVY[i]);
      const speed = Math.hypot(vx, vy);
      const stretch = Math.min(0.28, speed * 0.05) - fb.playerSquash[i];
      const angle = speed > 0.01 ? Math.atan2(vy, vx) : 0;

      // Мигание при неуязвимости — по номеру тика, а не по времени: так
      // картинка совпадает с состоянием, а не живёт своей жизнью.
      const alphaBody = invul && (s.tick >> 2) % 2 === 0 ? 0.45 : 1;

      b.push(
        Shape.Circle,
        x,
        y,
        r * (1 + stretch),
        r * (1 - stretch * 0.7),
        angle,
        colour.r,
        colour.g,
        colour.b,
        alphaBody,
        STROKE,
        ...channels(PALETTE.eye),
        alphaBody,
      );

      const ax = toFloat(s.pAimX[i]);
      const ay = toFloat(s.pAimY[i]);
      this.drawEyes(x, y, r * 0.42, ax, ay, r * 0.3, invul);
    }
  }

  private drawBullets(s: SimState, alpha: number): void {
    const c = PALETTE.bullet;
    const e = PALETTE.danger;
    for (let i = 0; i < MAX_BULLETS; i++) {
      if (!s.bActive[i]) continue;
      const x = lerp(this.prevBX[i], toFloat(s.bX[i]), alpha);
      const y = lerp(this.prevBY[i], toFloat(s.bY[i]), alpha);
      const vx = toFloat(s.bVX[i]);
      const vy = toFloat(s.bVY[i]);
      const enemy = s.bOwner[i] < 0;
      const colour = enemy ? e : c;
      // Снаряд вытянут по своей скорости: так видно, куда он летит, ещё до
      // того, как игрок успел проследить траекторию.
      const len = enemy ? 14 : 22;
      this.batch.push(
        Shape.Capsule,
        x,
        y,
        len,
        enemy ? 9 : 6,
        Math.atan2(vy, vx),
        colour.r,
        colour.g,
        colour.b,
        1,
        0,
        0,
        0,
        0,
        0,
      );
    }
  }

  private drawParticles(particles: Particles): void {
    const b = this.batch;
    particles.each((shape, x, y, size, angle, r, g, bl, a) => {
      if (shape === ParticleShape.Ring) {
        b.push(Shape.Ring, x, y, size, size, 0, 0, 0, 0, 0, STROKE, r, g, bl, a);
        return;
      }
      const s = shape === ParticleShape.Shard ? Shape.Box : Shape.Circle;
      b.push(
        s,
        x,
        y,
        size,
        size * (shape === ParticleShape.Shard ? 0.45 : 1),
        angle,
        r,
        g,
        bl,
        a,
        0,
        0,
        0,
        0,
        0,
      );
    });
  }

  // -------------------------------------------------------------------------
  // HUD и экранные эффекты
  // -------------------------------------------------------------------------

  /**
   * HUD версии 0.2.0 — только формы и цифры.
   *
   * Ни одной надписи, и это не экономия: типографика и локализация — стадия
   * F2 (PRODUCTION §4), а текст, вписанный до неё, придётся переделывать
   * вместе со шрифтом и словарём. Сердца, счёт и номер волны читаются формой.
   */
  private drawHud(s: SimState, w: number, h: number): void {
    const b = this.batch;
    const top = 34;

    for (let i = 0; i < s.playerCount; i++) {
      const colour = PALETTE.player[i] as Rgb;
      const baseX = 40 + i * 240;
      for (let n = 0; n < PLAYER.startHearts; n++) {
        const full = n < s.pHearts[i];
        b.push(
          Shape.Hexagon,
          baseX + n * 34,
          top,
          13,
          13,
          0,
          colour.r,
          colour.g,
          colour.b,
          full ? 1 : 0.12,
          3,
          colour.r,
          colour.g,
          colour.b,
          full ? 1 : 0.5,
        );
      }
      // Кошелёк рядом со своими сердцами: чьи фишки — видно без подписи.
      drawNumber(b, s.pChips[i], baseX + 120, top, 11, PALETTE.chip);
    }

    // Волна — пипсами справа: сколько всего и сколько прошло.
    const waves = 3;
    for (let n = 0; n < waves; n++) {
      const done = n < s.meta[Meta.Wave];
      const c = PALETTE.hudText;
      b.push(
        Shape.Circle,
        w - 40 - (waves - 1 - n) * 26,
        top,
        8,
        8,
        0,
        c.r,
        c.g,
        c.b,
        done ? 1 : 0.15,
        2,
        c.r,
        c.g,
        c.b,
        0.6,
      );
    }
    drawNumber(b, s.meta[Meta.Room], w - 40 - waves * 26 - 40, top, 11, PALETTE.hudDim);

    // Ожидание перезапуска после гибели: игрок должен видеть, что игра жива.
    if (s.meta[Meta.RestartAt] !== 0) {
      const left = Math.max(0, s.meta[Meta.RestartAt] - s.tick);
      const c = PALETTE.danger;
      b.push(Shape.Ring, w / 2, h / 2, 60, 60, 0, 0, 0, 0, 0, 6, c.r, c.g, c.b, 0.9);
      drawNumber(b, Math.ceil(left / 60), w / 2 - 12, h / 2, 22, PALETTE.hudText);
    }
  }

  private drawScreenEffects(feel: Feel, w: number, h: number): void {
    const b = this.batch;
    const flash = feel.screenFlash;
    if (flash) {
      const c = flash.colour;
      b.push(Shape.Box, w / 2, h / 2, w, h, 0, c.r, c.g, c.b, flash.alpha, 0, 0, 0, 0, 0);
    }
    /*
     * Виньетки здесь нет намеренно.
     *
     * Одной фигурой она получается не мягким затемнением, а тёмной полосой с
     * резким внутренним краем: поле расстояния даёт ровно ту границу, которую
     * ему задали. Настоящая виньетка — это шейдерный проход поверх кадра, и он
     * стоит в стадии F4 вместе с зерном и свечением (PRODUCTION §4). Полоса
     * вместо неё не украшает, а мешает читаемости, объявленной столпом дизайна.
     */
  }
}

const enemyColour = (type: EnemyType): Rgb =>
  type === EnemyType.Wedge
    ? PALETTE.enemyWedge
    : type === EnemyType.Brick
      ? PALETTE.enemyBrick
      : PALETTE.enemyFuse;

/** Развёртка цвета в три аргумента push(): читается лучше, чем три поля подряд. */
const channels = (c: Rgb): [number, number, number] => [c.r, c.g, c.b];

/**
 * Число семисегментными палочками.
 *
 * Шрифта в игре пока нет и до стадии F2 не будет, а счёт показывать надо.
 * Семь отрезков — это семь инстансов на цифру, то есть тот же батч, никакого
 * атласа и никакой возни с кириллицей.
 */
const SEGMENTS: readonly number[] = [
  0b1110111, 0b0100100, 0b1011101, 0b1101101, 0b0101110, 0b1101011, 0b1111011, 0b0100101, 0b1111111,
  0b1101111,
];

function drawNumber(
  b: ShapeBatch,
  value: number,
  x: number,
  y: number,
  size: number,
  c: Rgb,
): void {
  const text = String(Math.max(0, Math.trunc(value)));
  const w = size * 0.6;
  const t = Math.max(1.5, size * 0.16);
  for (let i = 0; i < text.length; i++) {
    const mask = SEGMENTS[text.charCodeAt(i) - 48] ?? 0;
    const cx = x + i * (w * 2 + size * 0.5);
    // Порядок битов: верх, левый верх, правый верх, середина, левый низ,
    // правый низ, низ.
    if (mask & 0b0000001) hbar(b, cx, y - size, w, t, c);
    if (mask & 0b0000010) vbar(b, cx - w, y - size / 2, size / 2, t, c);
    if (mask & 0b0000100) vbar(b, cx + w, y - size / 2, size / 2, t, c);
    if (mask & 0b0001000) hbar(b, cx, y, w, t, c);
    if (mask & 0b0010000) vbar(b, cx - w, y + size / 2, size / 2, t, c);
    if (mask & 0b0100000) vbar(b, cx + w, y + size / 2, size / 2, t, c);
    if (mask & 0b1000000) hbar(b, cx, y + size, w, t, c);
  }
}

const hbar = (b: ShapeBatch, x: number, y: number, w: number, t: number, c: Rgb): void => {
  b.push(Shape.Box, x, y, w, t, 0, c.r, c.g, c.b, 1, 0, 0, 0, 0, 0);
};

const vbar = (b: ShapeBatch, x: number, y: number, h: number, t: number, c: Rgb): void => {
  b.push(Shape.Box, x, y, t, h, 0, c.r, c.g, c.b, 1, 0, 0, 0, 0, 0);
};

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
  AceGesture,
  BETS,
  BetCategory,
  BetProgress,
  BetState,
  MAX_ACTIVE_BETS,
  FX_ONE,
  cashOutValue,
  nearMissOf,
  CARD,
  MAX_CARDS,
  RED_ZONE,
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

/**
 * Полувысота цифры в HUD.
 *
 * Правило UX §4 — минимум 24 px при 1080p, «читается с дивана в двух
 * метрах». Первая версия рисовала цифры вдвое мельче, и на деле их не было
 * видно вовсе: палочка толщиной в полторы условные единицы на реальном экране
 * тоньше пикселя и просто не попадает в растр.
 */
const HUD_DIGIT = 13;

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
  /**
   * Кто существовал на прошлом снимке.
   *
   * Без этого сущность в первом своём кадре интерполируется от мусора —
   * от нуля или от того, кто занимал ячейку пула до неё. Выглядит это как
   * телепортация: игрок в первом кадре забега выезжал из левого верхнего
   * угла, а каждая пуля вылетала откуда-то сбоку и прыгала на место.
   * Новая сущность рисуется там, где она есть, и интерполируется со
   * следующего кадра.
   */
  private readonly seenEnemy = new Uint8Array(MAX_ENEMIES);
  private readonly seenBullet = new Uint8Array(MAX_BULLETS);
  private seenPlayers = false;

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

  /**
   * Средние цвета кадра по сетке — снимок картинки для проверки регрессии.
   *
   * Читается СВОИМ контекстом, изнутри клиента, и это главное в этой функции.
   * Канвас низколатентный: его буфер уходит композитору, и сторонний
   * `getContext` снаружи получает контекст, который считает себя потерянным,
   * а размер буфера — нулевым. Тест, читающий кадр снаружи, ловил бы не
   * регрессию, а гонку с композитором.
   *
   * Сетка, а не пиксели: эталон обязан пережить смену растеризатора —
   * SwiftShader на раннере против настоящей видеокарты на машине, — а средние
   * по клетке переживают разницу сглаживания и не переживают пропавший слой,
   * уехавшую камеру или сбитую палитру.
   */
  frameGrid(draw: () => void, cols: number, rows: number): number[][] {
    const gl = this.gl;
    /*
     * Размер берётся у канваса, а не у буфера отрисовки.
     *
     * `drawingBufferWidth` у низколатентного канваса до первого показанного
     * кадра равен нулю — а снимок как раз и снимают на паузе, когда кадров
     * ещё не было. Нулевой размер давал буфер, который драйвер объявляет
     * неподдерживаемым, и снимок падал на ровном месте. Отрисовка и так идёт
     * в область `canvas.width × canvas.height`: тот же размер, что у окна
     * просмотра в `resize`.
     */
    const w = this.canvas.width;
    const h = this.canvas.height;
    // Потерянный контекст — состояние браузера, а не игры: под программным
    // растеризатором он изредка отваливается на старте страницы. Говорим об
    // этом отдельными словами, чтобы вызывающий отличил «браузер уронил
    // контекст» от «картинка разошлась с эталоном».
    if (gl.isContextLost()) throw new Error('снимок кадра: контекст потерян');
    if (w === 0 || h === 0) throw new Error('снимок кадра: у канваса нулевой размер');

    /*
     * Кадр рисуется в СВОЙ буфер, а не в экранный.
     *
     * Экранный после показа принадлежит композитору: канвас низколатентный и
     * без `preserveDrawingBuffer`, поэтому его содержимое сразу после кадра
     * не определено — прочитанный оттуда снимок выходил то верным, то пустым.
     * Включать сохранение буфера ради снимка нельзя: оно стоит кадра в
     * обычной игре, а снимок нужен раз в прогон теста.
     */
    // Прогревочный кадр в экран: первая отрисовка собирает шейдеры и
    // заливает буферы, и без неё снимок в свой буфер выходит чёрным — на
    // паузе настоящих кадров цикл не делает вовсе.
    draw();

    const fb = gl.createFramebuffer();
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    // Вложением служит буфер рендера с РАЗМЕРНЫМ форматом: текстура RGBA без
    // размерности даёт «буфер не поддерживается» на программном
    // растеризаторе, а размерный RGBA8 обязателен по спецификации WebGL2.
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);

    const px = new Uint8Array(w * h * 4);
    try {
      // Буфер проверяется до отрисовки, и это не формальность: пока его
      // полноту не спросили, драйвер вправе не разложить вложения, и рисунок
      // уходит в никуда — снимок возвращается чёрным, а ошибки нет.
      const статус = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (статус !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`снимок кадра: буфер неполон (0x${статус.toString(16)})`);
      }
      draw();
      // Дожидаемся, пока команды действительно выполнятся. Под программным
      // растеризатором отрисовка остаётся в очереди, и чтение без ожидания
      // возвращает чистый буфер — кадр выходит чёрным, а тест винит игру.
      gl.finish();
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      gl.deleteFramebuffer(fb);
      gl.deleteRenderbuffer(rb);
    }

    const out: number[][] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x0 = Math.floor((col * w) / cols);
        const x1 = Math.floor(((col + 1) * w) / cols);
        const y0 = Math.floor((row * h) / rows);
        const y1 = Math.floor(((row + 1) * h) / rows);
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let y = y0; y < y1; y += 2) {
          for (let x = x0; x < x1; x += 2) {
            const i = (y * w + x) * 4;
            r += px[i];
            g += px[i + 1];
            b += px[i + 2];
            n++;
          }
        }
        out.push(n === 0 ? [0, 0, 0] : [r / n / 255, g / n / 255, b / n / 255]);
      }
    }
    return out;
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
    this.seenPlayers = true;

    for (let i = 0; i < MAX_ENEMIES; i++) {
      this.seenEnemy[i] = s.eActive[i];
      if (!s.eActive[i]) continue;
      this.prevEX[i] = toFloat(s.eX[i]);
      this.prevEY[i] = toFloat(s.eY[i]);
    }
    for (let i = 0; i < MAX_BULLETS; i++) {
      this.seenBullet[i] = s.bActive[i];
      if (!s.bActive[i]) continue;
      this.prevBX[i] = toFloat(s.bX[i]);
      this.prevBY[i] = toFloat(s.bY[i]);
    }
  }

  /** Забыть прошлый кадр: новый забег начинается без хвостов старого. */
  forget(): void {
    this.seenEnemy.fill(0);
    this.seenBullet.fill(0);
    this.seenPlayers = false;
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
    this.drawCards(s);
    this.drawAce(s);
    this.drawSpawnMarks(s);
    this.drawTelegraphs(s, alpha);
    this.drawChips(s);
    this.drawEnemies(s, alpha, fb);
    this.drawPlayers(s, alpha, fb);
    this.drawBullets(s, alpha);
    this.drawParticles(particles);
    this.drawHud(s, arenaW, arenaH, fb);
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
    const k = arenaScale(s.playerCount) / 100;
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

    // Красная зона: урона не наносит, но пари предлагает от неё отказаться.
    // Штриховка тут была бы правильнее сплошной заливки (двойное кодирование
    // UX §4), но она приезжает вместе с шейдерным проходом в 0.12.0.
    const rz = PALETTE.redZone;
    b.push(
      Shape.Circle,
      toFloat(RED_ZONE.x) * k,
      toFloat(RED_ZONE.y) * k,
      toFloat(RED_ZONE.radius),
      toFloat(RED_ZONE.radius),
      0,
      rz.r,
      rz.g,
      rz.b,
      0.28,
      3,
      rz.r,
      rz.g,
      rz.b,
      0.7,
    );

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
   * Карты пари: подложка, иконка категории и вертикальный луч.
   *
   * Луч — не украшение. Карта и фишка обе подбираются с пола, и путать их
   * нельзя (GDD §21): фишки мелкие, золотые, россыпью; карта крупная, с
   * лучом, который виден сквозь толпу даже вчетвером на полной арене. За три
   * секунды до истечения луч гаснет — предупреждение без единой надписи.
   */
  private drawCards(s: SimState): void {
    const b = this.batch;

    for (let i = 0; i < MAX_CARDS; i++) {
      if (!s.kActive[i]) continue;
      const x = toFloat(s.kX[i]);
      const y = toFloat(s.kY[i]);
      const spec = BETS[s.kBet[i]];
      const colour = categoryColour(spec.category);
      const left = s.kDeadline[i] - s.tick;
      const fading = left < toFloat(CARD.fadeTicks) * 0 + 180;

      // Луч: узкая колонна света вверх от карты. Гаснет вместе со сроком.
      if (!fading) {
        b.push(Shape.Box, x, y - 150, 7, 150, 0, colour.r, colour.g, colour.b, 0.22, 0, 0, 0, 0, 0);
      }

      const r = toFloat(CARD.radius);
      // Подложка едина и кремова у всех категорий: цвет несут рамка и иконка.
      b.push(
        Shape.Box,
        x,
        y,
        r * 0.72,
        r,
        0,
        ...channels(PALETTE.card),
        1,
        STROKE,
        colour.r,
        colour.g,
        colour.b,
        1,
      );
      // Иконка категории — форма, а не цвет: двойное кодирование обязательно.
      b.push(
        categoryShape(spec.category),
        x,
        y,
        r * 0.34,
        r * 0.34,
        0,
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
      // Персональная карта помечена цветом своего игрока: чужую не взять.
      if (s.kOwner[i] >= 0) {
        const own = PALETTE.player[s.kOwner[i]] as Rgb;
        b.push(Shape.Ring, x, y, r * 1.25, r * 1.25, 0, 0, 0, 0, 0, 3, own.r, own.g, own.b, 0.9);
      }
    }
  }

  /**
   * Туз на арене.
   *
   * Рисуется НИЖЕ боевых сущностей и полупрозрачным: он второй игрок за
   * столом, а не препятствие, и перекрывать снаряды ему нельзя — читаемость
   * объявлена столпом дизайна (GDD §12А.1). Своя цветовая ниша, кремовая с
   * угольным, выводит его из спектров и врагов, и игроков.
   *
   * Пока он замахивается, над ним растёт кольцо: подброс телеграфируется за
   * полсекунды, чтобы карта не падала сюрпризом.
   */
  private drawAce(s: SimState): void {
    if (s.meta[Meta.AceX] === 0) return;
    const b = this.batch;
    let x = toFloat(s.meta[Meta.AceX]);
    const y = toFloat(s.meta[Meta.AceY]);
    const g = s.meta[Meta.AceGesture] as AceGesture;
    // Покачивание: он живой и ему скучно, пока игрок воюет. Жест этот покой
    // и ломает — тем и читается.
    let bob = Math.sin(s.tick * 0.05) * 6;
    let tilt = 0;
    let jitter = 0;
    if (g === AceGesture.Yawn) bob = Math.sin(s.tick * 0.02) * 10 - 4;
    if (g === AceGesture.Applaud || g === AceGesture.Ovation) {
      // Подпрыгивает: модуль синуса — прыжок, а не качание.
      bob = Math.abs(Math.sin(s.tick * 0.28)) * (g === AceGesture.Ovation ? 26 : 16);
    }
    if (g === AceGesture.TurnAway) tilt = 0.25;
    if (g === AceGesture.Fidget) {
      jitter = Math.sin(s.tick * 0.9) * 3;
      tilt = Math.sin(s.tick * 0.45) * 0.12;
    }
    x += jitter;

    // Тулья и поля цилиндра.
    b.push(
      Shape.Box,
      x,
      y + bob,
      22,
      26,
      tilt,
      ...channels(PALETTE.aceShadow),
      0.85,
      3,
      ...channels(PALETTE.ace),
      0.85,
    );
    b.push(Shape.Box, x, y + bob + 28, 34, 5, tilt, ...channels(PALETTE.ace), 0.85, 0, 0, 0, 0, 0);

    /*
     * Глаза: обычно смотрит на игрока — за ним и пришёл.
     *
     * Отвернуться — единственный жест, который меняет именно взгляд, и это
     * его суть: игрок в шаге от крупного выигрыша, а заведение делает вид,
     * что занято другим. Зевок закрывает глаза совсем.
     */
    const dx = toFloat(s.pX[0]) - x;
    const dy = toFloat(s.pY[0]) - y;
    const len = Math.hypot(dx, dy) || 1;
    const look = g === AceGesture.TurnAway ? -1 : 1;
    if (g !== AceGesture.Yawn) {
      this.drawEyes(x, y + bob + 4, 9, (look * dx) / len, (look * dy) / len, 6, false);
    } else {
      // Зевает: щёлки вместо глаз и открытый рот.
      const e = PALETTE.pupil;
      for (const sx of [-5, 5]) {
        b.push(Shape.Box, x + sx, y + bob + 4, 5, 1.5, 0, e.r, e.g, e.b, 0.9, 0, 0, 0, 0, 0);
      }
      const m = 3 + Math.abs(Math.sin(s.tick * 0.02)) * 4;
      b.push(Shape.Circle, x, y + bob - 6, m, m, 0, e.r, e.g, e.b, 0.9, 0, 0, 0, 0, 0);
    }

    // Перчатки: хлопают в ладоши на провале и на овации, показывают палец
    // вниз, когда игрок соскочил в шаге от куша.
    if (g === AceGesture.Applaud || g === AceGesture.Ovation) {
      const spread = 10 + Math.abs(Math.cos(s.tick * 0.28)) * 10;
      for (const sx of [-spread, spread]) {
        b.push(
          Shape.Circle,
          x + sx,
          y + bob - 14,
          6,
          6,
          0,
          ...channels(PALETTE.ace),
          0.95,
          0,
          0,
          0,
          0,
          0,
        );
      }
    }
    if (g === AceGesture.ThumbsDown) {
      const c = PALETTE.danger;
      b.push(
        Shape.Triangle,
        x + 22,
        y + bob - 10,
        9,
        9,
        Math.PI,
        c.r,
        c.g,
        c.b,
        0.95,
        0,
        0,
        0,
        0,
        0,
      );
    }

    if (s.meta[Meta.TossAt] !== 0) {
      const left = Math.max(0, s.meta[Meta.TossAt] - s.tick);
      const t = 1 - left / 30;
      const c = PALETTE.card;
      b.push(
        Shape.Ring,
        x,
        y + bob - 40,
        10 + 22 * t,
        10 + 22 * t,
        0,
        0,
        0,
        0,
        0,
        3,
        c.r,
        c.g,
        c.b,
        0.8 - 0.5 * t,
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
      const a = this.seenEnemy[i] ? alpha : 1;
      const x = lerp(this.prevEX[i], toFloat(s.eX[i]), a);
      const y = lerp(this.prevEY[i], toFloat(s.eY[i]), a);
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
      const a = this.seenEnemy[i] ? alpha : 1;
      const x = lerp(this.prevEX[i], toFloat(s.eX[i]), a);
      const y = lerp(this.prevEY[i], toFloat(s.eY[i]), a);
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

      const a = this.seenPlayers ? alpha : 1;
      const x = lerp(this.prevX[i], toFloat(s.pX[i]), a);
      const y = lerp(this.prevY[i], toFloat(s.pY[i]), a);
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

      /*
       * Кувырок: два оборота за отведённые 0.6 с.
       *
       * Отброс ударной волной не наносит урона сверх одного сердца — он
       * унижает, а не наказывает (GDD §6). Унижение это читается ровно
       * кувырком: без него отброшенный игрок выглядит просто скользящим, и
       * механика Fall Guys, ради которой всё затевалось, не считывается.
       */
      const ragdollLeft = Math.max(0, s.pRagdollUntil[i] - s.tick);
      const tumbling = ragdollLeft > 0;
      const tumble = tumbling ? (1 - ragdollLeft / PLAYER.ragdollTicks) * Math.PI * 4 : 0;

      const angle = tumbling ? tumble : speed > 0.01 ? Math.atan2(vy, vx) : 0;

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

      // В кувырке глаза едут вместе с телом и жмурятся: смотреть на прицел
      // в этот момент нечем, управления всё равно нет.
      const ax = tumbling ? Math.cos(tumble) : toFloat(s.pAimX[i]);
      const ay = tumbling ? Math.sin(tumble) : toFloat(s.pAimY[i]);
      this.drawEyes(x, y, r * 0.42, ax, ay, r * 0.3, invul || tumbling);
    }
  }

  private drawBullets(s: SimState, alpha: number): void {
    const c = PALETTE.bullet;
    const e = PALETTE.danger;
    for (let i = 0; i < MAX_BULLETS; i++) {
      if (!s.bActive[i]) continue;
      const a = this.seenBullet[i] ? alpha : 1;
      const x = lerp(this.prevBX[i], toFloat(s.bX[i]), a);
      const y = lerp(this.prevBY[i], toFloat(s.bY[i]), a);
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
  private drawHud(s: SimState, w: number, h: number, fb: Feedback): void {
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
      drawNumber(b, s.pChips[i], baseX + 150, top, HUD_DIGIT, PALETTE.chip);
      this.drawBets(s, i, baseX, top + 46);
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
    drawNumber(b, s.meta[Meta.Room], w - 40 - waves * 26 - 50, top, HUD_DIGIT, PALETTE.hudDim);

    this.drawSettlement(s, w, h, fb);

    // Ожидание перезапуска после гибели: игрок должен видеть, что игра жива.
    if (s.meta[Meta.RestartAt] !== 0) {
      const left = Math.max(0, s.meta[Meta.RestartAt] - s.tick);
      const c = PALETTE.danger;
      b.push(Shape.Ring, w / 2, h / 2, 60, 60, 0, 0, 0, 0, 0, 6, c.r, c.g, c.b, 0.9);
      drawNumber(b, Math.ceil(left / 60), w / 2, h / 2, 42, PALETTE.hudText);
    }
  }

  /**
   * Свои пари — плашками под сердцами, с растущим кушем.
   *
   * Игрок обязан видеть три вещи, не отрывая глаз от боя: какие пари на нём,
   * сколько он получит, если дожмёт, и сколько — если заберёт прямо сейчас
   * (UX §4). Последнее и есть весь смысл кнопки: «Забрать» и «дожать» — два
   * конца одной шкалы, и шкала должна быть видна.
   *
   * Плашка дышит: близкое к провалу пари дрожит, выигранное золотится.
   * Текста здесь нет — типографика приезжает в F2, а до неё категория читается
   * формой иконки и цветом рамки, ровно как на самой карте.
   */
  private drawBets(s: SimState, player: number, x: number, y: number): void {
    const b = this.batch;
    let n = 0;

    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      const k = player * MAX_ACTIVE_BETS + i;
      const state = s.aState[k] as BetState;
      if (state === BetState.None) continue;

      const spec = BETS[s.aBet[k]];
      const colour = categoryColour(spec.category);
      const cx = x + n * 96;
      n++;

      const won = state === BetState.Won || state === BetState.Cashed;
      const lost = state === BetState.Lost;
      // Дрожь достаётся только тому, что ещё можно потерять: проигранное
      // трясти незачем, оно уже проиграно.
      const shiver = state === BetState.Active && (s.tick >> 1) % 2 === 0 ? 1.5 : 0;
      const alpha = lost ? 0.25 : 1;

      b.push(
        Shape.Box,
        cx + shiver,
        y,
        40,
        17,
        0,
        ...channels(won ? PALETTE.chip : PALETTE.card),
        alpha * 0.9,
        3,
        colour.r,
        colour.g,
        colour.b,
        alpha,
      );
      b.push(
        categoryShape(spec.category),
        cx - 22 + shiver,
        y,
        9,
        9,
        0,
        colour.r,
        colour.g,
        colour.b,
        alpha,
        0,
        0,
        0,
        0,
        0,
      );

      /*
       * На плашке живут два разных числа, и путать их нельзя.
       *
       * Пока пари цело — потенциальная выплата: сколько дадут, если забрать
       * прямо сейчас. Она растёт по мере выполнения и есть видимая шкала
       * риска, тот самый второй конец «дожать или соскочить».
       *
       * Когда сорвано — near-miss в процентах: насколько близко было. Именно
       * почти-выигрыш заставляет нажать «ещё разок» (GDD §9.3), и показать
       * его надо там, где игрок и так смотрит.
       */
      const число = lost
        ? Math.round((nearMissOf(s, player, i) / FX_ONE) * 100)
        : state === BetState.Active
          ? cashOutValue(s, player, i)
          : Math.trunc((s.aStake[k] * spec.multiplier) / FX_ONE);
      drawNumber(b, число, cx + 8 + shiver, y, 10, lost ? PALETTE.danger : PALETTE.pupil);
    }

    // Глиф «Забрать» рядом с кушем: кнопка одна, и она про эти числа.
    if (n > 0) {
      const c = PALETTE.hudText;
      b.push(Shape.Ring, x + n * 96 - 30, y, 11, 11, 0, 0, 0, 0, 0, 3, c.r, c.g, c.b, 0.75);
    }
  }

  /**
   * Экран расчёта — пауза между комнатами (UX §6).
   *
   * Пять секунд, за которые игрок обязан прочитать, чем кончились его пари.
   * Главное здесь не выигранное, а сорванное: near-miss в процентах — «не
   * хватило чуть-чуть» — и есть то, что заставляет пойти в следующую комнату
   * (GDD §9.3). Показывать его мельком в углу боевого HUD бессмысленно: в бою
   * туда никто не смотрит.
   *
   * Экран не модальный и ничего не ждёт: пауза кончается сама. Пропуск живёт
   * в симуляции и открывается через секунду — зажатый огонь иначе пролистал бы
   * расчёт раньше, чем игрок успел его увидеть.
   */
  private drawSettlement(s: SimState, w: number, h: number, fb: Feedback): void {
    if (s.meta[Meta.Wave] !== 0 || s.meta[Meta.NextWaveAt] === 0) return;

    // Считаем, есть ли что показывать: первая комната приходит с пустыми
    // слотами, и затемнять кадр ради пустоты — только мешать.
    let rows = 0;
    for (let p = 0; p < s.playerCount; p++) {
      for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
        if (s.aState[p * MAX_ACTIVE_BETS + i] !== BetState.None) rows++;
      }
    }
    if (rows === 0) return;

    const b = this.batch;
    const c = PALETTE.background;
    b.push(Shape.Box, w / 2, h / 2, w, h, 0, c.r, c.g, c.b, 0.72, 0, 0, 0, 0, 0);

    // Плашки те же, что в бою, только крупнее и по центру: игрок узнаёт их
    // мгновенно, потому что весь бой смотрел ровно на эти формы.
    let line = 0;
    for (let p = 0; p < s.playerCount; p++) {
      const colour = PALETTE.player[p] as Rgb;
      for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
        const k = p * MAX_ACTIVE_BETS + i;
        const state = s.aState[k] as BetState;
        if (state === BetState.None) continue;

        const spec = BETS[s.aBet[k]];
        const cat = categoryColour(spec.category);
        const y = h / 2 - (rows - 1) * 34 + line * 68;
        line++;
        const lost = state === BetState.Lost;
        const won = state === BetState.Won || state === BetState.Cashed;

        // Метка игрока слева: в кооперативе строк вчетверо больше, и чьё это
        // пари должно читаться без счёта строк.
        b.push(
          Shape.Hexagon,
          w / 2 - 190,
          y,
          10,
          10,
          0,
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
        b.push(
          Shape.Box,
          w / 2,
          y,
          190,
          26,
          0,
          ...channels(won ? PALETTE.chip : PALETTE.card),
          lost ? 0.3 : 0.95,
          3,
          cat.r,
          cat.g,
          cat.b,
          1,
        );
        b.push(
          categoryShape(spec.category),
          w / 2 - 160,
          y,
          14,
          14,
          0,
          cat.r,
          cat.g,
          cat.b,
          1,
          0,
          0,
          0,
          0,
          0,
        );

        /*
         * Строка расчёта читается слева направо как расписка: кон, множитель,
         * исход, выплата — и у сорванного отдельно, насколько не хватило.
         *
         * Шрифта нет до стадии F2, поэтому «выиграно / провалено / обналичено»
         * несёт форма исхода, а не слово: заполненный шестиугольник — взял
         * куш, кольцо — соскочил сам, перечёркнутое — сорвал. Ровно те же три
         * формы, что игрок видел на плашке весь бой.
         */
        drawNumber(b, s.aStake[k], w / 2 - 120, y, 11, PALETTE.pupil);
        drawMultiplier(b, spec.multiplier / FX_ONE, w / 2 - 82, y, 11, PALETTE.pupil);
        this.drawOutcome(state, w / 2 - 8, y);
        // Выплата: у обналиченного и выигранного она разная, и берётся та,
        // что игроку действительно заплатили (снята в момент перехода).
        drawNumber(b, fb.betPayout[k], w / 2 + 110, y, 18, lost ? PALETTE.hudDim : PALETTE.pupil);

        if (!lost) continue;

        /*
         * Near-miss — главное, ради чего экран существует (GDD §9.3).
         *
         * У темповых пари он показывается В СЕКУНДАХ, а не в процентах, и это
         * не украшение: их `q` — доля прошедшего времени, и в момент, когда
         * время вышло, она равна единице. «Сто процентов» под перечёркнутым
         * исходом — вранье; «не хватило четырёх секунд» — правда, и считается
         * она разницей между срывом и концом комнаты.
         *
         * Ноль секунд означает, что темповое пари сорвалось не по времени, а
         * вместе с игроком на самом расчёте, — там честнее проценты: время у
         * него ещё оставалось.
         */
        const seconds = Math.max(
          0,
          Math.round((s.meta[Meta.RoomStartTick] - fb.betLostTick[k]) / 60),
        );
        const time = spec.progress === BetProgress.Time && seconds > 0;
        drawNumber(
          b,
          time ? seconds : Math.round((nearMissOf(s, p, i) / FX_ONE) * 100),
          w / 2 + 235,
          y,
          15,
          PALETTE.danger,
        );
        // Метка единицы измерения: кольцо — секунды (циферблат), две точки
        // столбиком — проценты. Без неё «4» и «40» читаются одинаково.
        const d = PALETTE.danger;
        if (time) {
          b.push(Shape.Ring, w / 2 + 285, y, 9, 9, 0, 0, 0, 0, 0, 3, d.r, d.g, d.b, 0.9);
        } else {
          for (const dy of [-7, 7]) {
            b.push(
              Shape.Circle,
              w / 2 + 285,
              y + dy,
              3.5,
              3.5,
              0,
              d.r,
              d.g,
              d.b,
              0.9,
              0,
              0,
              0,
              0,
              0,
            );
          }
        }
      }
    }

    // Кольцо обратного отсчёта: пауза видимо кончается, а не висит.
    const left = Math.max(0, s.meta[Meta.NextWaveAt] - s.tick);
    const t = PALETTE.hudText;
    b.push(Shape.Ring, w / 2, h / 2 + rows * 34 + 46, 16, 16, 0, 0, 0, 0, 0, 3, t.r, t.g, t.b, 0.7);
    drawNumber(b, Math.ceil(left / 60), w / 2, h / 2 + rows * 34 + 46, 14, PALETTE.hudText);
  }

  /**
   * Исход пари формой: выиграно, обналичено, провалено.
   *
   * Формой, а не словом, и не только из-за отсутствия шрифта: три исхода
   * различаются мгновенно и на любом языке, а пять секунд расчёта — это не то
   * время, за которое читают.
   */
  private drawOutcome(state: BetState, x: number, y: number): void {
    const b = this.batch;
    if (state === BetState.Won) {
      const c = PALETTE.chip;
      b.push(Shape.Hexagon, x, y, 11, 11, 0, c.r, c.g, c.b, 1, 2, ...channels(PALETTE.pupil), 0.6);
      return;
    }
    if (state === BetState.Cashed) {
      // Соскочил сам: кольцо, а не полная фигура — куш взят не весь.
      const c = PALETTE.chip;
      b.push(Shape.Ring, x, y, 11, 11, 0, 0, 0, 0, 0, 4, c.r, c.g, c.b, 1);
      return;
    }
    const d = PALETTE.danger;
    for (const angle of [Math.PI / 4, -Math.PI / 4]) {
      b.push(Shape.Box, x, y, 12, 2.5, angle, d.r, d.g, d.b, 1, 0, 0, 0, 0, 0);
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

/** Цвет категории пари: живёт в рамке, иконке и луче, но не в подложке. */
const categoryColour = (c: BetCategory): Rgb =>
  c === BetCategory.Style
    ? PALETTE.betStyle
    : c === BetCategory.Tempo
      ? PALETTE.betTempo
      : c === BetCategory.Space
        ? PALETTE.betSpace
        : c === BetCategory.Greed
          ? PALETTE.betGreed
          : c === BetCategory.Tricks
            ? PALETTE.betTricks
            : PALETTE.betSilly;

/** Форма иконки: категория обязана читаться и без цвета (GDD §21). */
const categoryShape = (c: BetCategory): Shape =>
  c === BetCategory.Style
    ? Shape.Hexagon
    : c === BetCategory.Tempo
      ? Shape.Triangle
      : c === BetCategory.Space
        ? Shape.Box
        : c === BetCategory.Greed
          ? Shape.Circle
          : c === BetCategory.Tricks
            ? Shape.Capsule
            : Shape.Ring;

const enemyColour = (type: EnemyType): Rgb =>
  type === EnemyType.Wedge
    ? PALETTE.enemyWedge
    : type === EnemyType.Brick
      ? PALETTE.enemyBrick
      : PALETTE.enemyFuse;

/** Развёртка цвета в три аргумента push(): читается лучше, чем три поля подряд. */
const channels = (c: Rgb): [number, number, number] => [c.r, c.g, c.b];

/**
 * Число семисегментными палочками, по центру относительно `x`.
 *
 * Шрифта в игре пока нет и до стадии F2 не будет, а счёт показывать надо.
 * Семь отрезков — это семь инстансов на цифру, то есть тот же батч, никакого
 * атласа и никакой возни с кириллицей.
 *
 * Центрируется всё число целиком, а не первая его цифра: раньше `x` был левым
 * краем, и таймер в кольце приходилось двигать поправкой на глаз — она
 * подходила однозначным числам и мазала на всех остальных.
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
  // Толщина палочки: не тоньше двух единиц, иначе цифра пропадает в растре.
  const t = Math.max(2, size * 0.2);
  const advance = w * 2 + size * 0.5;
  const left = x - (advance * (text.length - 1)) / 2;

  for (let i = 0; i < text.length; i++) {
    const digit = text.charCodeAt(i) - 48;
    const mask = SEGMENTS[digit] ?? 0;
    // Единица горит только правой парой отрезков и потому висит в своей
    // клетке справа. Сдвигаем её к середине — иначе «1» в кольце таймера
    // стоит не там, где все остальные цифры.
    const cx = left + i * advance - (digit === 1 ? w : 0);
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

/**
 * Множитель: «×» и число с одной десятой.
 *
 * Десятая обязательна: в каталоге живут ×2.5 и ×3.5 (GDD §9.5), и округление
 * до целого врёт про выплату ровно в тех пари, которые игрок берёт ради
 * жирного куша. Целая часть однозначна по построению — множитель одного пари
 * не доходит до десяти даже на боссах.
 */
function drawMultiplier(
  b: ShapeBatch,
  m: number,
  x: number,
  y: number,
  size: number,
  c: Rgb,
): void {
  const step = size * 1.8;
  // Крестик «×»: два отрезка, а не буква — шрифта нет до стадии F2.
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    b.push(
      Shape.Box,
      x,
      y,
      size * 0.55,
      Math.max(2, size * 0.16),
      angle,
      c.r,
      c.g,
      c.b,
      1,
      0,
      0,
      0,
      0,
      0,
    );
  }

  const whole = Math.trunc(m);
  const tenth = Math.round((m - whole) * 10);
  drawNumber(b, whole, x + step, y, size, c);
  if (tenth === 0) return;

  const t = Math.max(2, size * 0.2);
  b.push(Shape.Box, x + step * 1.6, y + size, t, t, 0, c.r, c.g, c.b, 1, 0, 0, 0, 0, 0);
  drawNumber(b, tenth, x + step * 2.3, y, size, c);
}

const hbar = (b: ShapeBatch, x: number, y: number, w: number, t: number, c: Rgb): void => {
  b.push(Shape.Box, x, y, w, t, 0, c.r, c.g, c.b, 1, 0, 0, 0, 0, 0);
};

const vbar = (b: ShapeBatch, x: number, y: number, h: number, t: number, c: Rgb): void => {
  b.push(Shape.Box, x, y, t, h, 0, c.r, c.g, c.b, 1, 0, 0, 0, 0, 0);
};

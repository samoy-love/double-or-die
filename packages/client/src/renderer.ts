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
  BetId,
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
  FAIRNESS,
  InputScheme,
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
  stakeFor,
  type SimState,
  toFloat,
} from '@dod/sim';
import { DEAL_LIFE, type Feedback } from './feedback';
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

/** Тиров кона три: Скромно / Нормально / По-крупному (GDD §9.3). */
const APPETITE_TIERS = 3;

/**
 * Плашка активного пари: полуширина подробной и сжатой, полувысота, зазор.
 *
 * Подробная плашка показывает сделку целиком — пари, множитель, кон и растущий
 * куш, — но вчетвером их четыре штуки в колонке шириной 240 единиц, и подробных
 * туда влезает одна. Остальные сжимаются до иконки с множителем: ровно то, что
 * UX §4 и предписывает («не больше восьми видимых элементов, детали — по
 * удержанию»). В соло и вдвоём места хватает всем, и сжимать нечего.
 */
const PLAQUE_WIDE = 44;
const PLAQUE_TIGHT = 20;
const PLAQUE_HALF_H = 25;
const PLAQUE_GAP = 6;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Сколько строк покажет экран расчёта. Ноль — экрана нет.
 *
 * Одна функция на два места намеренно: по этому же признаку решается, рисовать
 * Туза в общем слое или поверх затемнения. Две копии условия разъехались бы на
 * первой же правке, и он оказался бы либо нарисован дважды, либо не нарисован
 * вовсе — причём заметить это можно только глазами.
 */
function settlementRows(s: SimState): number {
  if (s.meta[Meta.Wave] !== 0 || s.meta[Meta.NextWaveAt] === 0) return 0;
  // Первая комната приходит с пустыми слотами, и затемнять кадр ради пустоты —
  // только мешать.
  let rows = 0;
  for (let p = 0; p < s.playerCount; p++) {
    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      if (s.aState[p * MAX_ACTIVE_BETS + i] !== BetState.None) rows++;
    }
  }
  return rows;
}

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
  /**
   * Сколько фигур не поместилось в батч в последнем кадре.
   *
   * Батчер считал их с первого дня, но НАРУЖУ не отдавал — то есть счётчик,
   * заведённый со словами «молчаливая потеря хуже честного счётчика», сам был
   * молчаливым. Кадр за потолком в 8192 фигуры терял их без единого следа: ни
   * в отладочном интерфейсе, ни в оверлее, ни в бенче. Обрезка, о которой
   * никто не узнаёт, читается как «всё поместилось».
   */
  lastDropped = 0;

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
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`снимок кадра: буфер неполон (0x${status.toString(16)})`);
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
    // На расчёте Туз рисуется не здесь, а поверх затемнения (`drawSettlement`):
    // под ним от него остаётся четверть непрозрачности и ничего больше.
    if (settlementRows(s) === 0) this.drawAce(s);
    this.drawSpawnMarks(s);
    this.drawTelegraphs(s, alpha);
    this.drawChips(s);
    this.drawEnemies(s, alpha, fb);
    this.drawPlayers(s, alpha, fb);
    this.drawDeals(s, fb);
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
    this.lastDropped = batch.dropped;
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

    this.drawRedZone(s);

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
   * Красная зона — разметка пари, а не опасность, и рисуется только по делу.
   *
   * Два дефекта было сразу, и оба владелец увидел на первом же плейтесте.
   *
   * Первый: круг висел на полу ВСЕГДА, даже когда ни у кого не было пари «Не
   * заходи в красную зону», — то есть игра размечала запрет, которого нет.
   * Отсюда и вопрос «зачем он?»: правильный ответ на него — не подпись, а
   * отсутствие круга. Зона выводится из состояния: она нужна, пока пари лежит
   * картой на арене (решение принимают ДО нажатия X, значит и границу надо
   * видеть до него) или уже активно у кого-то из игроков.
   *
   * Второй: заливка шла алым по яркости телеграфа, а алый в этой игре занят
   * объявленной атакой (`PALETTE.danger`). Зона урона не наносит — она стоит
   * фишек, а не сердец, — и читаться как угроза не имеет права: столп №5,
   * читаемость превыше красоты. Поэтому глухой винный `PALETTE.redZone`,
   * заливка вполсилы прежней и ровный контур без пульсации: пульсация здесь —
   * язык «сейчас ударит», и занимать его нечем.
   *
   * Координаты НЕ масштабируются составом, в отличие от колонн: `inRedZone`
   * в ядре сравнивает позицию с абсолютными `RED_ZONE.x/y`, и нарисованный со
   * множителем круг вчетвером лежал бы не там, где срывается пари.
   */
  private drawRedZone(s: SimState): void {
    if (!redZoneInPlay(s)) return;
    const c = PALETTE.redZone;
    const x = toFloat(RED_ZONE.x);
    const y = toFloat(RED_ZONE.y);
    const r = toFloat(RED_ZONE.radius);
    this.batch.push(Shape.Circle, x, y, r, r, 0, c.r, c.g, c.b, 0.14, 3, c.r, c.g, c.b, 0.55);
  }

  /**
   * Карты пари: подложка, иконка категории, вертикальный луч и подсветка.
   *
   * Луч — не украшение. Карта и фишка обе подбираются с пола, и путать их
   * нельзя (GDD §21): фишки мелкие, золотые, россыпью; карта крупная, с
   * лучом, который виден сквозь толпу даже вчетвером на полной арене.
   *
   * Подсветка — не украшение тем более. Карта не подбирается наездом: наезд
   * подсвечивает, берут кнопкой (UX §2, правило ввода №2). Пока подсветки не
   * было, второй половины этого правила не существовало вовсе — карта
   * выглядела одинаково издали и под ногами, и на живом плейтесте её приняли
   * за декорацию, «через которую можно пройти, и она ничего не делает».
   * Текста в интерфейсе до стадии F2 нет намеренно, поэтому вся нагрузка
   * ложится на форму и движение: масштаб, дыхание, кольцо и глиф кнопки.
   */
  private drawCards(s: SimState): void {
    const b = this.batch;
    const pickup = toFloat(CARD.pickupRadius);

    for (let i = 0; i < MAX_CARDS; i++) {
      if (!s.kActive[i]) continue;
      const x = toFloat(s.kX[i]);
      const y = toFloat(s.kY[i]);
      const spec = BETS[s.kBet[i]];
      const colour = categoryColour(spec.category);
      const left = s.kDeadline[i] - s.tick;

      /*
       * Последние три секунды карты читаются двумя признаками сразу.
       *
       * Луч и раньше «гас» — но исчезал разом, целиком, без предупреждения о
       * предупреждении: только что стоял столб света, и вот его нет. Владелец
       * на плейтесте не понял ни что это было, ни что оно значило. Теперь луч
       * ОСЕДАЕТ: высота падает вместе с остатком срока, то есть сам столб и
       * есть шкала времени, — и вдобавок мигает вместе с рамкой карты.
       * Двойное кодирование здесь обязательно ровно потому, что надписи
       * запрещены (UX §4).
       *
       * Мигание — 2 Гц, вдвое ниже потолка фотосенситивной безопасности в
       * 3 Гц (UX §5), и это не полноэкранная вспышка, а предмет на полу.
       */
      const dying = left <= CARD.fadeTicks;
      const share = dying ? Math.max(0, left / CARD.fadeTicks) : 1;
      const blink = dying && (s.tick % 30) - 15 < 0;
      const beamH = 150 * share;
      if (beamH > 1) {
        const beamA = dying ? (blink ? 0.5 : 0.1) : 0.22;
        b.push(
          Shape.Box,
          x,
          y - beamH,
          7,
          beamH,
          0,
          colour.r,
          colour.g,
          colour.b,
          beamA,
          0,
          0,
          0,
          0,
          0,
        );
      }

      /*
       * Взять карту может не всякий, кто на ней стоит: персональная карта
       * чужому не даётся (`kOwner`). Подсвечивать её тому, кто её не получит,
       * значит врать кнопкой — а обещание кнопки и есть единственный текст,
       * который в этой версии игроку показан.
       */
      let taker = -1;
      for (let p = 0; p < s.playerCount; p++) {
        if ((s.pFlags[p] & EntityFlag.Alive) === 0) continue;
        if (s.kOwner[i] >= 0 && s.kOwner[i] !== p) continue;
        const dx = toFloat(s.pX[p]) - x;
        const dy = toFloat(s.pY[p]) - y;
        if (dx * dx + dy * dy <= pickup * pickup) {
          taker = p;
          break;
        }
      }

      // Дыхание подсвеченной карты: живое движение читается боковым зрением
      // там, где не читается ни цвет, ни размер.
      const breath = taker >= 0 ? 1.12 + Math.sin(s.tick * 0.14) * 0.05 : 1;
      const r = toFloat(CARD.radius) * breath;
      const edgeA = dying && !blink ? 0.4 : 1;
      // Лицо карты чуть шире прежнего: на нём теперь стоит множитель, а
      // множитель — обещание карты, и печатать его мельче цифр в HUD значит
      // печатать его нечитаемым.
      const fw = r * 0.86;
      const fh = r * 1.04;

      // Подложка едина и кремова у всех категорий: цвет несут рамка и иконка.
      b.push(
        Shape.Box,
        x,
        y,
        fw,
        fh,
        0,
        ...channels(PALETTE.card),
        edgeA,
        STROKE,
        colour.r,
        colour.g,
        colour.b,
        edgeA,
      );
      // Пиктограмма ПАРИ, а не категории: «Без урона» и «Без рывка» обе из
      // Стиля и с иконкой категории были неразличимы (см. `drawBetIcon`).
      drawBetIcon(b, s.kBet[i], x, y - fh * 0.34, fh * 0.34, colour, PALETTE.card, edgeA);

      /*
       * Сделка сообщается ДО подбора, и на карте живёт ровно два числа.
       *
       * «Карта — это место на арене» (GDD §9.1): решение бежать за ней или нет
       * и есть центральное решение игры, а принималось оно вслепую — на карте
       * не было ни кона, ни множителя. Показываем то, без чего сделку не
       * оценить: МНОЖИТЕЛЬ на лице карты (это её обещание, и место ему там же,
       * где значение на игральной карте) и ЦЕНУ под картой, на полу, золотом —
       * цена про кошелёк игрока, а не про карту, и путать эти две вещи нельзя.
       *
       * Больше не помещается ничего, и это не теснота, а иерархия яркости
       * (GDD §21): карты стоят НИЖЕ снарядов и телеграфов, и третье число на
       * полу начало бы спорить с боем за внимание. Возможная выплата
       * сознательно не показана — она равна кону, умноженному на множитель, то
       * есть уже сказана этими двумя числами.
       */
      drawMultiplier(
        b,
        spec.multiplier / FX_ONE,
        x - fw * 0.66,
        y + fh * 0.5,
        fh * 0.26,
        PALETTE.pupil,
        edgeA,
      );

      /*
       * Цена — та, что спишется у того, кому карта достанется.
       *
       * `stakeFor` зависит от кошелька и аппетита, то есть у четверых она
       * четыре разных числа. Персональная карта отвечает на вопрос сама,
       * общая — только когда ответ однозначен: игрок на ней стоит или он за
       * столом один. Иначе цены нет вовсе: «стоит 10» для чужого кошелька
       * было бы ровно тем враньём, из-за которого игрок и не понимает сделку.
       */
      const payer =
        s.kOwner[i] >= 0 ? s.kOwner[i] : taker >= 0 ? taker : s.playerCount === 1 ? 0 : -1;
      if (payer >= 0) {
        const ps = fh * 0.28;
        const py = y + fh + ps * 1.9;
        const ch = PALETTE.chip;
        b.push(
          Shape.Circle,
          x - ps * 2.2,
          py,
          ps * 0.6,
          ps * 0.6,
          0,
          ch.r,
          ch.g,
          ch.b,
          edgeA * 0.9,
          0,
          0,
          0,
          0,
          0,
        );
        drawNumber(b, stakeFor(s, payer), x + ps * 0.5, py, ps, ch, edgeA * 0.9);
      }
      // Персональная карта помечена цветом своего игрока: чужую не взять.
      if (s.kOwner[i] >= 0) {
        const own = PALETTE.player[s.kOwner[i]] as Rgb;
        b.push(Shape.Ring, x, y, r * 1.25, r * 1.25, 0, 0, 0, 0, 0, 3, own.r, own.g, own.b, 0.9);
      }

      if (taker >= 0) {
        // Кольцо-ореол цветом взявшего: в коопе видно не только ЧТО можно
        // взять, но и КОМУ. Остаётся ниже игроков и снарядов по яркости
        // (GDD §21) — подсветка не имеет права спорить с боем.
        const own = PALETTE.player[taker] as Rgb;
        const halo = r * 1.55 + Math.sin(s.tick * 0.14) * 3;
        b.push(Shape.Ring, x, y, halo, halo, 0, 0, 0, 0, 0, 3, own.r, own.g, own.b, 0.55);
        this.drawTakeGlyph(x, y - r * 2.2, s.pScheme[taker]);
      }
    }
  }

  /**
   * Глиф «чем берут»: буква X в оправе устройства.
   *
   * Оправа и есть весь язык: круг — кнопка геймпада, квадрат — клавиша, голое
   * кольцо — тап по таче, где буквы нет вовсе. Схема берётся из состояния
   * (`pScheme`), а туда её кладёт кадр ввода, — поэтому игрок, взявшийся за
   * геймпад посреди боя, видит смену глифа сразу, а не после перезапуска.
   */
  private drawTakeGlyph(x: number, y: number, scheme: number): void {
    const b = this.batch;
    const c = PALETTE.hudText;
    const frame = scheme === InputScheme.Gamepad ? Shape.Circle : Shape.Box;
    b.push(frame, x, y, 15, 15, 0, 0, 0, 0, 0, 3, c.r, c.g, c.b, 0.95);
    if (scheme === InputScheme.Touch) return;
    // Буква X двумя перекрещенными планками: шрифта в игре нет до стадии F2,
    // а знать, чем берут, надо уже сейчас.
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      b.push(Shape.Box, x, y, 8, 1.6, a, c.r, c.g, c.b, 0.95, 0, 0, 0, 0, 0);
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

    /*
     * Тулья и поля цилиндра.
     *
     * Контур той же толщины, что у всего остального в игре (STROKE, 4 u из
     * арт-дирекшна GDD §21), а не тоньше. Тулья тёмная, и на тёмном полу
     * силуэт несёт именно контур: на трёх единицах он выходил в два пикселя
     * реального экрана, и Туза не было видно вовсе.
     */
    b.push(
      Shape.Box,
      x,
      y + bob,
      22,
      26,
      tilt,
      ...channels(PALETTE.aceShadow),
      0.85,
      STROKE,
      ...channels(PALETTE.ace),
      0.85,
    );
    b.push(Shape.Box, x, y + bob + 28, 34, 5, tilt, ...channels(PALETTE.ace), 0.85, 0, 0, 0, 0, 0);

    /*
     * Глаза: обычно смотрит на игрока — за ним и пришёл.
     *
     * На БЛИЖАЙШЕГО живого, а не на первого по номеру. Взгляд — половина
     * характера Туза (GDD §17А), и вчетвером «всегда на P1» читается не как
     * внимание, а как поломка: заведение пялится в одну точку, пока рядом
     * умирает кто-то другой. Мёртвые из счёта выбывают: смотреть на тело —
     * это уже другой жест, и он не заказан.
     */
    let dx = 0;
    let dy = 0;
    let near = -1;
    for (let p = 0; p < s.playerCount; p++) {
      if ((s.pFlags[p] & EntityFlag.Alive) === 0) continue;
      const px = toFloat(s.pX[p]) - x;
      const py = toFloat(s.pY[p]) - y;
      const d = px * px + py * py;
      if (near < 0 || d < near) {
        near = d;
        dx = px;
        dy = py;
      }
    }
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
      // Длительность берётся у того, кто её назначил. Зашитая тридцатка
      // совпадала с ней случайно, и правка телеграфа в конфиге молча
      // разъехалась бы с кольцом, которое этот телеграф и показывает.
      const t = clamp01(1 - left / CARD.aceTelegraphTicks);
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
      /*
       * Доля дожидания — от настоящей длительности предупреждения, и зажатая
       * в 0..1.
       *
       * Метки ставятся не в один тик (`WAVE.spawnStaggerTicks`): последняя в
       * пачке ждёт своего срока на четверть секунды дольше первой. Зашитая
       * тридцатка знала только про `spawnMarkTicks`, поэтому у отложенных
       * меток доля уходила в минус, и кольцо раздувалось вдвое против
       * задуманного — предупреждение врало о том, сколько осталось.
       */
      const t = clamp01(1 - left / FAIRNESS.spawnMarkTicks);
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
      /*
       * Пульсация — не украшение: по ней читается, сколько осталось.
       *
       * Знаменатель — НАСТОЯЩАЯ длительность этого телеграфа, а не базовая из
       * каталога. У новичка она в полтора раза длиннее (`noviceTelegraphPct`),
       * и на базовой доля уходила в минус: первую половину своего телеграфа
       * новичок светился с нулевой прозрачностью, то есть был невидим.
       *
       * Ирония в том, что растянутый телеграф — это и есть весь туториал по
       * врагам (DIFFICULTY §7): игрок один раз видит Фитиль в упор и понимает,
       * что круг с фитилём взрывается. Единственное появление, ради которого
       * правило заведено, показывалось хуже всех остальных.
       */
      const novice = (s.eFlags[i] & EntityFlag.Novice) !== 0;
      const full = novice
        ? Math.trunc((stats.telegraphTicks * FAIRNESS.noviceTelegraphPct) / 100)
        : stats.telegraphTicks;
      const urgency = clamp01(1 - left / Math.max(1, full));
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

  /**
   * Заключённая сделка: всплывает над головой того, кто взял карту.
   *
   * Подбор был молчаливым: кон списывался без единого признака, и игрок не
   * видел ни того, что потерял, ни того, что ему обещали. Здесь показаны обе
   * стороны разом — «минус кон» и «плюс куш, если дожмёшь», — и показаны той же
   * плашкой, что стоит в HUD: игрок обязан узнать взятое пари, а не разгадывать
   * его заново.
   *
   * Рисуется НИЖЕ снарядов и выше игроков: это сообщение о решении, а не
   * участник боя, и перекрывать снаряды ему нельзя (GDD §21).
   */
  private drawDeals(s: SimState, fb: Feedback): void {
    const b = this.batch;

    for (let p = 0; p < s.playerCount; p++) {
      const life = fb.dealLife[p];
      if (life <= 0) continue;
      // Плашка всплывает и в конце гаснет: движение вверх читается как «ушло в
      // HUD», где пари и живёт весь остальной бой.
      const t = clamp01(1 - life / DEAL_LIFE);
      const a = Math.min(1, life / 0.3) * 0.95;
      const x = toFloat(s.pX[p]);
      const y = toFloat(s.pY[p]) - 62 - 26 * t;
      const bet = fb.dealBet[p];
      const colour = categoryColour(BETS[bet].category);

      b.push(
        Shape.Box,
        x,
        y,
        52,
        24,
        0,
        ...channels(PALETTE.card),
        a,
        3,
        colour.r,
        colour.g,
        colour.b,
        a,
      );
      drawBetIcon(b, bet, x - 36, y - 11, 9, colour, PALETTE.card, a);
      drawMultiplier(b, BETS[bet].multiplier / FX_ONE, x - 22, y - 11, 7, PALETTE.pupil, a);

      // Кон ушёл — треугольник вниз мутным; куш придёт — треугольник вверх
      // золотом. Знака «минус» в игре без шрифта нет, а направление есть.
      const dim = PALETTE.hudDim;
      b.push(
        Shape.Triangle,
        x - 44,
        y + 11,
        4.5,
        4.5,
        Math.PI / 2,
        dim.r,
        dim.g,
        dim.b,
        a,
        0,
        0,
        0,
        0,
        0,
      );
      drawNumber(b, fb.dealStake[p], x - 28, y + 11, 8, PALETTE.pupil, a);
      const ch = PALETTE.chip;
      b.push(Shape.Triangle, x - 2, y + 11, 5, 5, -Math.PI / 2, ch.r, ch.g, ch.b, a, 0, 0, 0, 0, 0);
      drawNumber(b, fb.dealPayout[p], x + 26, y + 11, 9, PALETTE.pupil, a);
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

      /*
       * Аппетит — тремя пипсами рядом с кошельком.
       *
       * Кон объявлен настоящим решением (ECONOMY §7), а решение, которого не
       * видно, решением не является: игрок нажимал крестовину и не мог
       * убедиться, что попал. Пипсы стоят вплотную к кошельку намеренно —
       * тир и есть то, что из кошелька уйдёт за следующую карту.
       */
      for (let t = 0; t < APPETITE_TIERS; t++) {
        const on = t <= s.pAppetite[i];
        const c = PALETTE.chip;
        b.push(
          Shape.Box,
          baseX + 196 + t * 13,
          top + 4,
          4,
          4 + t * 3,
          0,
          c.r,
          c.g,
          c.b,
          on ? 1 : 0.15,
          2,
          c.r,
          c.g,
          c.b,
          on ? 1 : 0.45,
        );
      }
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
   * Свои пари — плашками под сердцами: вся сделка целиком.
   *
   * Плашка обязана отвечать на четыре вопроса сразу, не отрывая игрока от боя:
   * ЧТО он взял (пиктограмма пари), под КАКОЙ коэффициент (`×M`), СКОЛЬКО
   * поставил (кон) и сколько дадут ПРЯМО СЕЙЧАС за «Забрать» (растущий куш).
   * Раньше из четырёх было видно одно — растущий куш, — то есть «сколько
   * получу» показывалось, а «сколько поставил» и «во сколько раз» нет, и
   * оценить сделку было нечем.
   *
   * Пятого числа здесь нет намеренно. Полная выплата за дожатое пари — это кон,
   * умноженный на множитель, то есть она уже сказана двумя показанными числами;
   * а вот шкала «дожать или соскочить» словами не говорится, и её несёт полоса
   * прогресса по нижней кромке плашки. Убран отсюда и одинокий глиф «Забрать»,
   * который стоял ПОСЛЕ последней плашки и не относился ни к одному числу:
   * кольцо переехало к тому кушу, про который кнопка и говорит.
   *
   * Плашка дышит: близкое к провалу пари дрожит, выигранное золотится.
   * Текста здесь нет — типографика приезжает в F2, а до неё пари читается
   * пиктограммой и цветом рамки, ровно как на самой карте.
   */
  private drawBets(s: SimState, player: number, x: number, y: number): void {
    const b = this.batch;
    let cursor = x;
    let n = 0;

    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      const k = player * MAX_ACTIVE_BETS + i;
      const state = s.aState[k] as BetState;
      if (state === BetState.None) continue;

      const spec = BETS[s.aBet[k]];
      const colour = categoryColour(spec.category);
      // Вчетвером колонка игрока — 240 единиц, а стак — до четырёх пари:
      // подробных плашек туда влезает ОДНА. Остальные сжимаются до иконки с
      // множителем (UX §4: «чужие — сжатыми иконками», детали по удержанию).
      const compact = s.playerCount > 2 && n > 0;
      const hw = compact ? PLAQUE_TIGHT : PLAQUE_WIDE;
      const cx = cursor + hw;
      cursor += hw * 2 + PLAQUE_GAP;
      n++;

      const won = state === BetState.Won || state === BetState.Cashed;
      const lost = state === BetState.Lost;
      // Дрожь достаётся только тому, что ещё можно потерять: проигранное
      // трясти незачем, оно уже проиграно.
      const shiver = state === BetState.Active && (s.tick >> 1) % 2 === 0 ? 1.5 : 0;
      const alpha = lost ? 0.25 : 1;
      const cxs = cx + shiver;
      const back = won ? PALETTE.chip : PALETTE.card;

      b.push(
        Shape.Box,
        cxs,
        y,
        hw,
        PLAQUE_HALF_H,
        0,
        ...channels(back),
        alpha * 0.9,
        3,
        colour.r,
        colour.g,
        colour.b,
        alpha,
      );

      // Полоса прогресса по нижней кромке: та же `q`, по которой считается
      // выплата за «Забрать» (ECONOMY §9А). Она и есть шкала «сначала терпи,
      // потом решай» — без неё растущее число не с чем сравнить.
      const q = clamp01(nearMissOf(s, player, i) / FX_ONE);
      const barW = hw - 6;
      const barY = y + PLAQUE_HALF_H - 5;
      b.push(
        Shape.Box,
        cxs,
        barY,
        barW,
        2.5,
        0,
        colour.r,
        colour.g,
        colour.b,
        alpha * 0.2,
        0,
        0,
        0,
        0,
        0,
      );
      if (q > 0.01) {
        b.push(
          Shape.Box,
          cxs - barW + barW * q,
          barY,
          barW * q,
          2.5,
          0,
          colour.r,
          colour.g,
          colour.b,
          alpha * 0.9,
          0,
          0,
          0,
          0,
          0,
        );
      }

      if (compact) {
        // Сжатая: что взято и под какой коэффициент. Числа сделки уезжают в
        // подробную плашку — врать теснотой хуже, чем недоговорить.
        drawBetIcon(b, s.aBet[k], cxs, y - 9, 9, colour, back, alpha);
        drawMultiplier(b, spec.multiplier / FX_ONE, cxs - 14, y + 11, 6, PALETTE.pupil, alpha);
        continue;
      }

      // Верхняя строка: пари, его коэффициент и кон. Всё, что уже решено.
      drawBetIcon(b, s.aBet[k], cxs - 32, y - 11, 9, colour, back, alpha);
      drawMultiplier(b, spec.multiplier / FX_ONE, cxs - 17, y - 11, 7.5, PALETTE.pupil, alpha);
      drawNumber(b, s.aStake[k], cxs + 32, y - 11, 7, PALETTE.pupil, alpha * 0.85);

      /*
       * На нижней строке живут два разных числа, и путать их нельзя.
       *
       * Пока пари цело — потенциальная выплата: сколько дадут, если забрать
       * прямо сейчас. Она растёт по мере выполнения и есть видимая шкала
       * риска, тот самый второй конец «дожать или соскочить»; кольцо слева от
       * неё — глиф «Забрать», и стоит он именно у этого числа.
       *
       * Когда сорвано — near-miss в процентах: насколько близко было. Именно
       * почти-выигрыш заставляет нажать «ещё разок» (GDD §9.3), и показать
       * его надо там, где игрок и так смотрит.
       */
      if (state === BetState.Active) {
        // Кольцо ЦВЕТОМ ЧЕРНИЛ, а не `hudText`: кремовый текст HUD отличается
        // от кремовой подложки плашки на считанные единицы ΔE, и глиф на ней
        // пропадал начисто. Пока он стоял снаружи, на тёмном полу, это сходило
        // с рук — но снаружи он и не показывал, к какому числу относится.
        const c = PALETTE.pupil;
        b.push(Shape.Ring, cxs - 32, y + 11, 7, 7, 0, 0, 0, 0, 0, 3, c.r, c.g, c.b, alpha * 0.8);
      }
      const value = lost
        ? Math.round((nearMissOf(s, player, i) / FX_ONE) * 100)
        : state === BetState.Active
          ? cashOutValue(s, player, i)
          : Math.trunc((s.aStake[k] * spec.multiplier) / FX_ONE);
      drawNumber(b, value, cxs + 2, y + 11, 10, lost ? PALETTE.danger : PALETTE.pupil, alpha);

      /*
       * Счётчиковое пари показывает счёт ЧИСЛАМИ: «сколько из трёх».
       *
       * Требование UX §4 — «прогресс пари виден численно там, где это
       * счётчик». Полоса прогресса у «Подрывника» и есть тот же счёт, но два
       * взрыва из трёх на глаз от одного не отличить, а решение «дожимать или
       * забрать» на этой разнице и стоит.
       */
      if (spec.progress === BetProgress.Counter) {
        const dim = PALETTE.hudDim;
        drawNumber(b, s.aCounter[k], cxs + 26, y + 11, 6, dim, alpha);
        b.push(
          Shape.Box,
          cxs + 33,
          y + 11,
          5,
          1.4,
          -Math.PI / 3,
          dim.r,
          dim.g,
          dim.b,
          alpha,
          0,
          0,
          0,
          0,
          0,
        );
        drawNumber(b, spec.target, cxs + 40, y + 11, 6, dim, alpha);
      }
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
    const rows = settlementRows(s);
    if (rows === 0) return;

    const b = this.batch;
    const c = PALETTE.background;
    b.push(Shape.Box, w / 2, h / 2, w, h, 0, c.r, c.g, c.b, 0.72, 0, 0, 0, 0, 0);

    /*
     * Туз — ПОВЕРХ затемнения, а не под ним.
     *
     * Он выходит принимать расчёт (`aceAtSettlement` в ядре), то есть в этот
     * момент он и есть событие на экране. Затемнение в 0.72 съедало бы его
     * почти целиком: 0.85 собственной непрозрачности превращаются под ним в
     * четверть, и заведение, пришедшее похлопать провалу, снова стало бы
     * невидимым — ровно тем, из-за чего эта фигура и переделывалась.
     *
     * Дешевле, чем кажется: несколько фигур на пять секунд паузы, и только
     * когда расчёту есть что показать.
     */
    this.drawAce(s);

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
        // Та же пиктограмма, что на карте и на плашке: игрок узнаёт своё пари,
        // а не разгадывает его в третий раз.
        drawBetIcon(b, s.aBet[k], w / 2 - 160, y, 14, cat, won ? PALETTE.chip : PALETTE.card, 1);

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

/**
 * Индекс пари «Не заходи в красную зону» в каталоге.
 *
 * По строковому идентификатору, а не числом: порядок в `content/bets.json`
 * меняется от правки каталога, и зашитый номер молча начал бы показывать
 * разметку от чужого пари. Ищется один раз на загрузку модуля.
 */
const RED_ZONE_BET = BETS.findIndex((spec) => String(spec.id) === 'no_red_zone');

/** Есть ли красная зона в этой комнате: карта на полу или активное пари. */
function redZoneInPlay(s: SimState): boolean {
  if (RED_ZONE_BET < 0) return false;
  for (let i = 0; i < MAX_CARDS; i++) {
    if (s.kActive[i] && s.kBet[i] === RED_ZONE_BET) return true;
  }
  for (let p = 0; p < s.playerCount; p++) {
    for (let n = 0; n < MAX_ACTIVE_BETS; n++) {
      const k = p * MAX_ACTIVE_BETS + n;
      if (s.aState[k] === BetState.Active && s.aBet[k] === RED_ZONE_BET) return true;
    }
  }
  return false;
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

/**
 * Пиктограмма ПАРИ, а не категории (PRODUCTION §3, «Иконки пари — пиктограммы
 * из примитивов»).
 *
 * Категорий шесть и пари шесть, но один к одному они не ложатся: «Без урона» и
 * «Без рывка» обе относятся к Стилю, то есть с иконкой категории выглядели на
 * карте ОДИНАКОВО. Игрок физически не мог отличить «пройду без урона» от
 * «пройду без рывка» — два разных обязательства с разной ценой, — и владелец
 * сформулировал итог прямо: «не понятно, на что я беру ставку с этой картой».
 *
 * Смысл иконки должен угадываться, а не заучиваться (столп №5, читаемость за
 * 0.2 секунды): сердце, стрелка, часы, зона, монета, взрыв. Цвет категории при
 * этом остаётся вторым признаком — двойное кодирование формой И цветом
 * обязательно (GDD §21).
 *
 * `back` — цвет подложки, на которой рисуют: им прорезается перечёркивание,
 * иначе запретительная черта тонет в самом глифе.
 *
 * Пари вне каталога 0.3.0 честно откатывается к форме категории: новое пари в
 * `content/bets.json` не должно оставлять карту без иконки вовсе.
 */
function drawBetIcon(
  b: ShapeBatch,
  bet: number,
  x: number,
  y: number,
  s: number,
  c: Rgb,
  back: Rgb,
  a: number,
): void {
  const thin = Math.max(1.4, s * 0.11);

  switch (bet) {
    case BetId.NoDamage: {
      // Сердце: две дольки сверху и клин книзу. Перечёркнуто — урона не будет.
      for (const side of [-1, 1]) {
        b.push(
          Shape.Circle,
          x + side * s * 0.4,
          y - s * 0.3,
          s * 0.48,
          s * 0.48,
          0,
          c.r,
          c.g,
          c.b,
          a,
          0,
          0,
          0,
          0,
          0,
        );
      }
      // Вершиной вниз: поворот на +π/2, потому что ось Y экрана смотрит вниз.
      b.push(
        Shape.Triangle,
        x,
        y + s * 0.28,
        s * 0.7,
        s * 0.7,
        Math.PI / 2,
        c.r,
        c.g,
        c.b,
        a,
        0,
        0,
        0,
        0,
        0,
      );
      drawSlash(b, x, y, s, c, back, a);
      return;
    }

    case BetId.NoDash: {
      // Рывок: стрелка со следами скорости позади. Без следов она читается как
      // просто «направление», а запрещён здесь именно рывок.
      b.push(Shape.Capsule, x - s * 0.15, y, s * 0.62, thin, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
      b.push(
        Shape.Triangle,
        x + s * 0.68,
        y,
        s * 0.42,
        s * 0.42,
        0,
        c.r,
        c.g,
        c.b,
        a,
        0,
        0,
        0,
        0,
        0,
      );
      for (const side of [-1, 1]) {
        b.push(
          Shape.Capsule,
          x - s * 0.82,
          y + side * s * 0.44,
          s * 0.3,
          thin * 0.8,
          0,
          c.r,
          c.g,
          c.b,
          a,
          0,
          0,
          0,
          0,
          0,
        );
      }
      drawSlash(b, x, y, s, c, back, a);
      return;
    }

    case BetId.Under45s: {
      // Часы: циферблат и две стрелки. Единственная пустая внутри иконка —
      // отсюда и берётся отличие от зоны, которая залита.
      b.push(
        Shape.Ring,
        x,
        y,
        s * 0.92,
        s * 0.92,
        0,
        0,
        0,
        0,
        0,
        Math.max(2, s * 0.24),
        c.r,
        c.g,
        c.b,
        a,
      );
      b.push(Shape.Box, x, y - s * 0.28, thin, s * 0.4, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
      b.push(Shape.Box, x + s * 0.24, y, s * 0.34, thin, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
      return;
    }

    case BetId.NoRedZone: {
      // Зона: заливка вполсилы и ровный контур — тот же язык, которым красная
      // зона нарисована на полу (GDD §21). Перечёркнута: туда нельзя.
      b.push(
        Shape.Circle,
        x,
        y,
        s * 0.88,
        s * 0.88,
        0,
        c.r,
        c.g,
        c.b,
        a * 0.42,
        Math.max(2, s * 0.2),
        c.r,
        c.g,
        c.b,
        a,
      );
      drawSlash(b, x, y, s, c, back, a);
      return;
    }

    case BetId.AllChips: {
      // Монета и три стрелки, сходящиеся к ней: собрать ВСЁ, а не просто фишку.
      b.push(Shape.Circle, x, y, s * 0.42, s * 0.42, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
      const arrows: readonly [number, number, number][] = [
        [-s * 0.86, 0, 0],
        [s * 0.86, 0, Math.PI],
        [0, -s * 0.86, Math.PI / 2],
      ];
      for (const [dx, dy, angle] of arrows) {
        b.push(
          Shape.Triangle,
          x + dx,
          y + dy,
          s * 0.32,
          s * 0.32,
          angle,
          c.r,
          c.g,
          c.b,
          a,
          0,
          0,
          0,
          0,
          0,
        );
      }
      return;
    }

    case BetId.Demolitionist: {
      // Круг Фитиля с разлетающимися лучами. Лучи идут насквозь, а тело сверху
      // залито цветом подложки: без этого звёздочка читается как звёздочка, а
      // подрывать надо именно Фитилём.
      for (const angle of [0, Math.PI / 4, Math.PI / 2, -Math.PI / 4]) {
        b.push(Shape.Capsule, x, y, s * 0.98, thin * 0.9, angle, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
      }
      b.push(
        Shape.Circle,
        x,
        y,
        s * 0.4,
        s * 0.4,
        0,
        back.r,
        back.g,
        back.b,
        a,
        Math.max(2, s * 0.2),
        c.r,
        c.g,
        c.b,
        a,
      );
      return;
    }

    default:
      b.push(categoryShape(BETS[bet].category), x, y, s, s, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
  }
}

/**
 * Перечёркивание: две полосы, широкая цветом подложки и тонкая цветом поверх.
 *
 * Одной полосой не выходит: цветом категории она тонет в залитом глифе, цветом
 * подложки — исчезает за пределами глифа. Пара даёт линию, которая видна и на
 * сердце, и на кремовом поле рядом с ним.
 */
function drawSlash(
  b: ShapeBatch,
  x: number,
  y: number,
  s: number,
  c: Rgb,
  back: Rgb,
  a: number,
): void {
  const angle = -Math.PI / 4;
  b.push(
    Shape.Capsule,
    x,
    y,
    s * 1.12,
    Math.max(2.4, s * 0.2),
    angle,
    back.r,
    back.g,
    back.b,
    a,
    0,
    0,
    0,
    0,
    0,
  );
  b.push(
    Shape.Capsule,
    x,
    y,
    s * 1.04,
    Math.max(1.2, s * 0.09),
    angle,
    c.r,
    c.g,
    c.b,
    a,
    0,
    0,
    0,
    0,
    0,
  );
}

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
  a = 1,
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
    if (mask & 0b0000001) hbar(b, cx, y - size, w, t, c, a);
    if (mask & 0b0000010) vbar(b, cx - w, y - size / 2, size / 2, t, c, a);
    if (mask & 0b0000100) vbar(b, cx + w, y - size / 2, size / 2, t, c, a);
    if (mask & 0b0001000) hbar(b, cx, y, w, t, c, a);
    if (mask & 0b0010000) vbar(b, cx - w, y + size / 2, size / 2, t, c, a);
    if (mask & 0b0100000) vbar(b, cx + w, y + size / 2, size / 2, t, c, a);
    if (mask & 0b1000000) hbar(b, cx, y + size, w, t, c, a);
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
  a = 1,
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
      a,
      0,
      0,
      0,
      0,
      0,
    );
  }

  const whole = Math.trunc(m);
  const tenth = Math.round((m - whole) * 10);
  drawNumber(b, whole, x + step, y, size, c, a);
  if (tenth === 0) return;

  const t = Math.max(2, size * 0.2);
  b.push(Shape.Box, x + step * 1.6, y + size, t, t, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
  drawNumber(b, tenth, x + step * 2.3, y, size, c, a);
}

const hbar = (
  b: ShapeBatch,
  x: number,
  y: number,
  w: number,
  t: number,
  c: Rgb,
  a: number,
): void => {
  b.push(Shape.Box, x, y, w, t, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
};

const vbar = (
  b: ShapeBatch,
  x: number,
  y: number,
  h: number,
  t: number,
  c: Rgb,
  a: number,
): void => {
  b.push(Shape.Box, x, y, t, h, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
};

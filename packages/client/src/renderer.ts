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
 *
 * ## Визуальный язык: тёмная заливка и несущая обводка
 *
 * Сущность арены рисуется общей тёмной заливкой (`ENTITY_FILL`) и обводкой
 * цветом своей роли толщиной `STROKE` — см. `entity()` ниже. Роль опознаётся
 * ОБВОДКОЙ: заливка у всех одна и от пола отличается на ΔE 2.3, то есть
 * фигуру целиком держат четыре единицы контура. Отсюда и пара «обводка против
 * заливки» в гейте контраста: обводка, сблизившаяся с заливкой, стирает
 * сущность молча, не задев ни одной другой проверки.
 *
 * Исключений три, и они объявлены здесь, а не по месту:
 *
 *   — **снаряды**. Пуля рисуется капсулой с полутолщиной 6: обводка в 4
 *     единицы съела бы её почти целиком, и самое яркое на экране (GDD §21)
 *     превратилось бы в тёмную точку с каймой. Снаряд остаётся сплошным, и
 *     это не поблажка: сплошная заливка — сама по себе верхняя ступень
 *     иерархии яркости, а роль у него ровно одна, различать её не с чем.
 *   — **штрихи внутри силуэта**: глаза и зрачки, поля цилиндра Крупье,
 *     пиктограммы пари, палочки семисегментных цифр. Обводить штрих нечем —
 *     он сам и есть обводка, и вторая вокруг него дала бы кашу на пятнадцати
 *     единицах.
 *   — **полосы**: прочность босса, прогресс пари. Полоса сообщает ДЛИНУ, а не
 *     силуэт: длину показывает залитая часть, и обводка тут отняла бы
 *     единственный несущий признак. Дорожка полосы при этом живёт по общему
 *     правилу — тёмная заливка и контур.
 */

import {
  ACE,
  AceGesture,
  aceCardAt,
  aceStakeFor,
  ANGLE_FULL,
  APPETITE,
  BALL,
  BETS,
  DoorType,
  MAX_DOORS,
  BOSS,
  BetCategory,
  BetId,
  BetProgress,
  BetState,
  HOUSE,
  MAX_ACTIVE_BETS,
  MAX_UPGRADE_SLOTS,
  SHOP_SLOTS,
  UPGRADES,
  priceOf,
  FX_ONE,
  cashOutValue,
  nearMissOf,
  CARD,
  MAX_CARDS,
  RED_ZONE_RADIUS,
  ENEMIES,
  EnemyPhase,
  EnemyType,
  EntityFlag,
  FAIRNESS,
  InputScheme,
  KEYS,
  Obligation,
  TICK_HZ,
  columnX,
  columnY,
  redZoneX,
  redZoneY,
  templateOf,
  FUSE,
  MAX_BULLETS,
  MAX_CHIPS,
  MAX_ENEMIES,
  MAX_PLAYERS,
  MAX_SPAWNS,
  MAX_BALLS,
  Meta,
  PLAYER,
  RunPhase,
  SECTOR_COUNT,
  WEDGE,
  bossStunned,
  counterBetRunning,
  sectorAngle,
  wheelAngle,
  wheelRadius,
  wheelX,
  wheelY,
  stakeFor,
  type SimState,
  toFloat,
} from '@dod/sim';
import { DEAL_LIFE, type Feedback } from './feedback';
import { MENU_PLAY_BUTTON, MENU_SETTINGS_BUTTON } from './menuLayout';
import type { Feel } from './feel';
import { Shape, ShapeBatch } from './gl/batch';
import { Face, TextAtlas } from './gl/text';
import { charset, t, type StringKey } from './i18n';
import { ENTITY_FILL, PALETTE, type Rgb } from './palette';
import { ParticleShape, type Particles } from './particles';

/** Толщина обводки из арт-дирекшна: 4 u на всём (GDD §21). */
const STROKE = 4;

/**
 * Что показывать поверх меню: туториал, настройки, что в фокусе.
 *
 * Отдельный тип, а не растущий список позиционных булевых параметров
 * `draw()` — их и так три (menu/tutorial/settings были бы четвёртым), а
 * читать вызов из пяти подряд `true`/`false` невозможно, не подглядывая в
 * сигнатуру.
 */
export interface MenuOverlay {
  tutorial: boolean;
  settingsOpen: boolean;
  /** Какой пункт меню в фокусе: 0 — «Играть», 1 — «Настройки». */
  focus: 0 | 1;
  cashOutFocusedOnly: boolean;
}

const DEFAULT_MENU_OVERLAY: MenuOverlay = {
  tutorial: false,
  settingsOpen: false,
  focus: 0,
  cashOutFocusedOnly: false,
};

/**
 * Сущность арены: тёмная заливка плюс несущая обводка цветом роли.
 *
 * Отдельная функция, а не пятнадцать одинаковых `push()` подряд: правило
 * «заливка одна на всех» должно нарушаться в одном месте, а не разъезжаться по
 * файлу — именно так до редизайна и накопилось семнадцать разных заливок.
 * Заодно вызов перестаёт быть стеной из пятнадцати чисел, в которой не видно,
 * какой цвет несущий.
 *
 * `stroke` меньше общей толщины задаётся там, где фигура мельче обводки
 * (метки, кольца в строке расчёта): четыре единицы на радиусе семь — это уже
 * не обводка, а заливка.
 */
function entity(
  b: ShapeBatch,
  shape: Shape,
  x: number,
  y: number,
  halfW: number,
  halfH: number,
  rotation: number,
  role: Rgb,
  alpha = 1,
  stroke = STROKE,
): void {
  b.push(
    shape,
    x,
    y,
    halfW,
    halfH,
    rotation,
    ENTITY_FILL.r,
    ENTITY_FILL.g,
    ENTITY_FILL.b,
    alpha,
    stroke,
    role.r,
    role.g,
    role.b,
    alpha,
  );
}

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
 * Крупье в общем слое или поверх затемнения. Две копии условия разъехались бы на
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
  /** Буквы кадра. Пустой до того, как приедет шрифт, — и это рабочее состояние. */
  private readonly text: TextAtlas;
  private readonly prevX = new Float64Array(MAX_PLAYERS);
  private readonly prevY = new Float64Array(MAX_PLAYERS);
  private readonly prevEX = new Float64Array(MAX_ENEMIES);
  private readonly prevEY = new Float64Array(MAX_ENEMIES);
  /**
   * Последний осмысленный угол поворота врага (playtest: «вибрируют, быстро
   * крутятся, стоя на месте»). `atan2` от скорости честен, но скорость около
   * нуля — это в основном шум фиксированной точки, а не направление: враг,
   * который почти не движется, каждый тик получал новый случайный угол.
   * Обновляем угол, только когда скорость выше шума, а на медленных кадрах
   * держим прежний — крутится тело, только когда реально куда-то едет.
   */
  private readonly enemyFacing = new Float64Array(MAX_ENEMIES);
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

  /**
   * Схема ввода прямо сейчас: подписи экранов называют физическую кнопку.
   *
   * Ставится клиентом каждый кадр. Не из состояния: `pScheme` заполняется
   * кадром ввода, то есть до первого тика его нет вовсе, — а меню стоит именно
   * до первого тика и обязано назвать кнопку верно.
   */
  scheme: InputScheme = InputScheme.Keyboard;

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
    if (!gl) throw new Error(t('error.webgl2'));
    this.gl = gl;
    this.batch = new ShapeBatch(gl);
    /*
     * Атлас глифов собирается в фоне и в кадр не вмешивается.
     *
     * Ждать шрифта нельзя: игра начинается раньше, чем браузер разберёт woff2,
     * а первый кадр — это первая проверка того, что всё живо. До готовности
     * атласа подписей просто нет, формы и числа на месте — ровно тот кадр,
     * которым игра жила до F2.
     */
    this.text = new TextAtlas(gl, this.batch);
    void this.text.load(charset());
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

  /**
   * `alpha` — доля пройденного тика, 0..1.
   *
   * `menu` — забег ещё не начат: поверх кадра стоит главное меню. Признак
   * приходит параметром, а не из состояния, потому что в состоянии его нет:
   * фазы `Menu` в ядре не заведено, и меню целиком живёт в клиенте
   * (`loop.ts`).
   */
  draw(
    s: SimState,
    alpha: number,
    feel: Feel,
    particles: Particles,
    fb: Feedback,
    menu = false,
    menuOverlay: MenuOverlay = DEFAULT_MENU_OVERLAY,
    cashOutTarget = 0,
  ): void {
    const { gl, canvas, batch } = this;
    const arenaW = toFloat(s.arenaW);
    const arenaH = toFloat(s.arenaH);

    const bg = PALETTE.background;
    gl.clearColor(bg.r, bg.g, bg.b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    batch.begin();
    this.drawFloor(arenaW, arenaH, s);
    this.drawWheel(s);
    this.drawCards(s);
    // На расчёте и на своём предложении пари Крупье рисуется не здесь, а поверх
    // затемнения (`drawSettlement`, `drawAceBetScreen`): под ним от него
    // остаётся четверть непрозрачности и ничего больше.
    if (settlementRows(s) === 0 && aceCardAt(s) < 0) this.drawAce(s, fb);
    this.drawSpawnMarks(s);
    this.drawTelegraphs(s, alpha);
    this.drawChips(s);
    this.drawEnemies(s, alpha, fb);
    this.drawBoss(s);
    this.drawPlayers(s, alpha, fb);
    this.drawDeals(s, fb);
    this.drawBullets(s, alpha);
    this.drawParticles(particles);
    this.drawHud(s, arenaW, arenaH, fb, menuOverlay.cashOutFocusedOnly ? cashOutTarget : -1);
    // Меню — поверх всего, включая экраны забега: пока оно на экране, забег
    // не идёт вовсе, и любая надпись из-под него говорила бы об обратном.
    if (menu) this.drawMenuScreen(arenaW, arenaH, menuOverlay);
    if (menu && menuOverlay.tutorial) this.drawTutorialScreen(arenaW, arenaH);
    if (menu && menuOverlay.settingsOpen) this.drawSettingsScreen(arenaW, arenaH, menuOverlay);
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
    b.push(Shape.Box, w / 2, h / 2, w / 2, h / 2, 0, ...channels(PALETTE.floor), 1, 0, 0, 0, 0, 0);

    /*
     * Виньетка пола — приближение фигурами, не проход поверх кадра.
     *
     * PRODUCTION §4 держит настоящую виньетку в F4/0.12.0 намеренно: она там
     * шейдерный проход, а «виньетка, нарисованная фигурой, — это тёмная
     * полоса с резким краем» (см. предупреждение в шапке файла). Это
     * предупреждение здесь и проверяется — приближение сделано МНОГИМИ
     * тонкими нарастающими кольцами, а не одним толстым, ровно чтобы не
     * получить ту самую полосу. Когда дойдёт очередь до настоящего
     * шейдерного прохода, эти кольца снимаются одной правкой — они не часть
     * сцены, а костыль под её текущий инструмент.
     */
    {
      const vg = PALETTE.vignette;
      const cx = w / 2;
      const cy = h * 0.46;
      const rings = 6;
      for (let i = 0; i < rings; i++) {
        const t = i / (rings - 1);
        const half = lerp(w * 0.34, w * 0.72, t);
        b.push(Shape.Box, cx, cy, half, half * (h / w), 0, vg.r, vg.g, vg.b, 0, 0.05 + t * 0.1, vg.r, vg.g, vg.b, 0.05 + t * 0.09);
      }
    }

    /*
     * Сетка: по ней читается масштаб и скорость собственного движения — но
     * читается боковым зрением, а не разглядыванием. Раньше линии стояли на
     * полной непрозрачности того же тона, что и заливка колонн, — на полу это
     * читалось не сеткой ориентиров, а решёткой поверх арены. Макет
     * («Дизайн игры «Забег»», 1a) держит её на 3.5% белого: едва заметный
     * штрих, который замечаешь, только повернув голову. Роль колонн у
     * `PALETTE.grid` не трогаем — там он остаётся полноценной заливкой.
     */
    const step = 120;
    const g = PALETTE.grid;
    const gridAlpha = 0.16;
    for (let x = step; x < w; x += step) {
      b.push(Shape.Box, x, h / 2, 1, h / 2, 0, g.r, g.g, g.b, gridAlpha, 0, 0, 0, 0, 0);
    }
    for (let y = step; y < h; y += step) {
      b.push(Shape.Box, w / 2, y, w / 2, 1, 0, g.r, g.g, g.b, gridAlpha, 0, 0, 0, 0, 0);
    }

    /*
     * Рамка арены — тот же приём, что в макете (stroke `#2f3542` вокруг всего
     * поля): без неё край арены обозначен только обрывом сетки, и на широком
     * экране игровая зона сливается с летрбоксом. Заливки нет — только
     * контур: рамка обозначает границу, а не рисует вторую панель поверх пола.
     */
    const border = PALETTE.chrome;
    b.push(Shape.Box, w / 2, h / 2, w / 2 - 4, h / 2 - 4, 0, 0, 0, 0, 0, 6, border.r, border.g, border.b, 1);

    this.drawRedZone(s);

    // Колонны берутся из шаблона текущей комнаты и уже с отражением: рисовать
    // их по базовым координатам значило бы показать не ту арену, на которой
    // идёт бой.
    for (const c of templateOf(s).columns) {
      entity(
        b,
        Shape.Box,
        toFloat(columnX(c, s)),
        toFloat(columnY(c, s)),
        toFloat(c.halfW),
        toFloat(c.halfH),
        0,
        PALETTE.grid,
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
   * читаемость превыше красоты. Поэтому глухой винный `PALETTE.redZone` и
   * ровный контур без пульсации: пульсация здесь — язык «сейчас ударит», и
   * занимать его нечем.
   *
   * Заливка с 0.4.0 общая тёмная, а не винная вполсилы: цветная плёнка поверх
   * пола читалась как второй пол, а границу — то единственное, что игроку тут
   * надо знать, — несёт контур. Затемнение против общего фона говорит «сюда
   * нельзя», не занимая под это ни одного цвета.
   *
   * Координаты НЕ масштабируются составом, в отличие от колонн: `inRedZone`
   * в ядре сравнивает позицию с абсолютными `RED_ZONE.x/y`, и нарисованный со
   * множителем круг вчетвером лежал бы не там, где срывается пари.
   */
  private drawRedZone(s: SimState): void {
    if (!redZoneInPlay(s)) return;
    const c = PALETTE.redZone;
    const x = toFloat(redZoneX(s));
    const y = toFloat(redZoneY(s));
    const r = toFloat(RED_ZONE_RADIUS);
    entity(this.batch, Shape.Circle, x, y, r, r, 0, c, 0.55);
  }

  /**
   * Колесо: обод, разметка секторов и провалившийся сектор.
   *
   * Отрисовка нарочно скупая — колесо обязано ЧИТАТЬСЯ, а не выглядеть.
   * Вращается разметка (GDD §8.1), поэтому спицы едут, а обод стоит: если
   * когда-нибудь поедет обод, значит вращать начали геометрию, и это будет
   * видно глазом раньше, чем упадёт тест.
   *
   * Визуал доводится отдельным изменением: здесь ровно столько, чтобы бой
   * можно было играть.
   */
  private drawWheel(s: SimState): void {
    if (s.meta[Meta.Phase] !== RunPhase.Boss) return;
    const b = this.batch;
    const cx = toFloat(wheelX(s));
    const cy = toFloat(wheelY(s));
    const r = toFloat(wheelRadius(s));
    const g = PALETTE.grid;

    b.push(Shape.Ring, cx, cy, r, r, 0, 0, 0, 0, 0, STROKE, g.r, g.g, g.b, 1);

    const turn = (Math.PI * 2) / SECTOR_COUNT;
    const base = (wheelAngle(s) * Math.PI * 2) / ANGLE_FULL;
    for (let i = 0; i < SECTOR_COUNT; i++) {
      const a = base + turn * i;
      b.push(
        Shape.Capsule,
        cx + (Math.cos(a) * r) / 2,
        cy + (Math.sin(a) * r) / 2,
        r / 2,
        1.5,
        a,
        g.r,
        g.g,
        g.b,
        0.8,
        0,
        0,
        0,
        0,
        0,
      );
    }

    for (let i = 0; i < SECTOR_COUNT; i++) {
      if (s.sectorFallAt[i] === 0 || s.tick >= s.sectorRestoreAt[i]) continue;
      const a = base + turn * i + turn / 2;
      // Телеграф алый и пульсирующий — это язык «сейчас ударит» (GDD §21).
      // Провалившийся сектор уже не угроза, а дыра: он рисуется фоном.
      const falling = s.tick < s.sectorFallAt[i];
      // Провалившийся сектор — дыра, и в новом языке её несёт контур цветом
      // хрома: раньше дыра заливалась фоном, а фон отличается от пола на ΔE 1,
      // то есть края у неё не было вовсе. Хром, а не цвет разметки: спицы и
      // обод уже разметка, и дыра обязана отличаться от них, а не сливаться.
      const c = falling ? PALETTE.danger : PALETTE.chrome;
      const alpha = falling ? 0.5 + 0.25 * Math.sin(s.tick / 4) : 1;
      const half = r * Math.sin(Math.PI / SECTOR_COUNT);
      entity(
        b,
        Shape.Capsule,
        cx + (Math.cos(a) * r) / 2,
        cy + (Math.sin(a) * r) / 2,
        r / 2,
        half,
        a,
        c,
        alpha,
      );
    }
  }

  /**
   * Босс, шары и полоса прочности.
   *
   * Метка приземления рисуется кругом ударной волны, а не точкой: игрок обязан
   * видеть ОБЛАСТЬ, из которой надо уйти, — ровно ту, по которой считается
   * достижимость безопасной точки (DIFFICULTY §8).
   */
  private drawBoss(s: SimState): void {
    if (s.meta[Meta.BossMaxHP] === 0) return;
    const b = this.batch;
    const cx = toFloat(wheelX(s));
    const cy = toFloat(wheelY(s));
    const body = PALETTE.enemyAlt;
    const stunned = bossStunned(s);

    // Оглушённый босс гаснет обводкой, а не заливкой: заливка у всех одна, и
    // приглушать в нём нечего, кроме несущего цвета.
    entity(
      b,
      Shape.Circle,
      cx,
      cy,
      toFloat(BOSS.radius),
      toFloat(BOSS.radius),
      0,
      body,
      stunned ? 0.4 : 1,
    );

    for (let i = 0; i < MAX_BALLS; i++) {
      if (!s.ballActive[i]) continue;
      const left = s.ballLandAt[i] - s.tick;
      if (left <= BALL.telegraphTicks && !stunned) {
        const a = (sectorAngle(s, s.ballSector[i]) * Math.PI * 2) / ANGLE_FULL;
        const rim = toFloat(wheelRadius(s)) - toFloat(BALL.radius);
        const blast = toFloat(BALL.blastRadius);
        const d = PALETTE.danger;
        const urgency = clamp01(1 - left / BALL.telegraphTicks);
        b.push(
          Shape.Circle,
          cx + Math.cos(a) * rim,
          cy + Math.sin(a) * rim,
          blast,
          blast,
          0,
          d.r,
          d.g,
          d.b,
          0.08 + 0.14 * urgency,
          2,
          d.r,
          d.g,
          d.b,
          0.3 + 0.5 * urgency,
        );
      }
      // Шар — не снаряд по языку отрисовки, хотя и ведёт себя как снаряд:
      // радиус 16 держит обводку без потери формы, и поблажка, выданная пуле
      // радиусом 6, ему не нужна.
      entity(
        b,
        Shape.Circle,
        toFloat(s.ballX[i]),
        toFloat(s.ballY[i]),
        toFloat(BALL.radius),
        toFloat(BALL.radius),
        0,
        PALETTE.bullet,
      );
    }

    // Полоса прочности: одна на всех, потому что босс один на всех. Дорожка
    // живёт по общему правилу, сама полоса остаётся сплошной — она сообщает
    // длину, и обводка отняла бы у неё единственный признак.
    const width = 600;
    const share = s.meta[Meta.BossHP] / s.meta[Meta.BossMaxHP];
    const x = toFloat(s.arenaW) / 2;
    entity(b, Shape.Box, x, 46, width / 2, 9, 0, PALETTE.hudDim, 1, 2);
    b.push(
      Shape.Box,
      x - (width / 2) * (1 - share),
      46,
      (width / 2) * share,
      9,
      0,
      ...channels(counterBetRunning(s) ? PALETTE.hudDim : PALETTE.enemy),
      1,
      0,
      0,
      0,
      0,
      0,
    );

    // Фаза 2 (70% запаса): встречная ставка объявляется на 10 секунд, шары
    // смыкаются в кольцо (GDD §8.1). Полоса прочности выше уже гаснет до
    // hudDim на это время — баннер объясняет, что это значит и чем кончится,
    // раз выбор здесь не кнопкой, а позицией игрока (UX §2, принцип 2).
    if (counterBetRunning(s)) {
      const seconds = Math.ceil((s.meta[Meta.CounterBetUntil] - s.tick) / TICK_HZ);
      this.screenLine(t('boss.counter_bet.label', { seconds }), x * 2, 66, PALETTE.hudText, 15);
      this.screenLine(t('boss.counter_bet.hint'), x * 2, 86, PALETTE.hudDim, 13);
    }
  }

  /**
   * Карты пари: лицо с контуром, иконка пари, вертикальный луч и подсветка.
   *
   * Луч — не украшение. Карта и фишка обе подбираются с пола, и путать их
   * нельзя (GDD §21): фишки мелкие, золотым кольцом, россыпью; карта крупная, с
   * лучом, который виден сквозь толпу даже вчетвером на полной арене.
   *
   * Подсветка — не украшение тем более. Карта не подбирается наездом: наезд
   * подсвечивает, берут кнопкой (UX §2, правило ввода №2). Пока подсветки не
   * было, второй половины этого правила не существовало вовсе — карта
   * выглядела одинаково издали и под ногами, и на живом плейтесте её приняли
   * за декорацию, «через которую можно пройти, и она ничего не делает».
   * Надписи на карте нет и со шрифтом: в бою читают форму и движение, а не
   * буквы (UX §1, столп 3). Вся нагрузка на масштаб, дыхание, кольцо и глиф
   * кнопки — имя пари игрок увидит на расчёте, где на чтение есть время.
   */
  private drawCards(s: SimState): void {
    const b = this.batch;
    const pickup = toFloat(CARD.pickupRadius);

    for (let i = 0; i < MAX_CARDS; i++) {
      if (!s.kActive[i]) continue;
      /*
       * Карта Крупье на полу не рисуется: её показывает свой экран.
       *
       * Она лежит в том же массиве и по тем же правилам живёт по сроку, но
       * подобрать её нельзя (`tryTakeCard`), и нарисованная на арене она
       * обещала бы кнопку, которой нет, — то есть врала бы ровно тем
       * способом, который запрещает подсветка подбора ниже.
       */
      if (s.kOwner[i] === ACE) continue;
      const x = toFloat(s.kX[i]);
      const y = toFloat(s.kY[i]);
      const spec = BETS[s.kBet[i]];
      const colour = categoryColour(spec.category);
      const left = s.kDeadline[i] - s.tick;

      /*
       * Часть C: тонкое кольцо «цены места» — насколько карта физически
       * близка к опасной зоне арены (красная зона, GDD §9.5). Это НЕ вторая
       * категория: категория уже кодируется формой иконки внутри карты
       * (`drawBetIcon`), а кольцо кодирует только пространственный риск места,
       * на котором лежит карта, — те же две вещи, что кон и множитель выше,
       * нельзя путать по смыслу.
       *
       * Интенсивность растёт по мере приближения к центру красной зоны и
       * гаснет за её пределами. Радиус нормировки взят вдвое шире физического
       * радиуса зоны, чтобы подсветка начиналась чуть раньше границы, а не
       * обрывалась ровно на ней (резкий порог читался бы как баг).
       */
      const rzX = toFloat(redZoneX(s));
      const rzY = toFloat(redZoneY(s));
      const rzR = toFloat(RED_ZONE_RADIUS);
      const dxRz = x - rzX;
      const dyRz = y - rzY;
      const distRz = Math.hypot(dxRz, dyRz);
      const dangerT = clamp01(1 - distRz / (rzR * 2));
      const calm = PALETTE.card;
      const hot = PALETTE.danger;
      const ringColour: Rgb = {
        r: calm.r + (hot.r - calm.r) * dangerT,
        g: calm.g + (hot.g - calm.g) * dangerT,
        b: calm.b + (hot.b - calm.b) * dangerT,
      };
      // Кольцо еле заметно у спокойных карт и заметно у карт в опасности —
      // интенсивность несёт и цвет, и альфа, чтобы дальтоник тоже читал риск.
      const ringA = 0.15 + 0.55 * dangerT;

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

      /*
       * Карта в языке 0.4.0: тёмное лицо и кремовый несущий контур.
       *
       * Кремовый переехал с заливки на обводку, и это не перестановка ради
       * единообразия. Подложка перестала быть цветом вовсе — она общая у всех
       * сущностей арены, — а «карта против фишки», пару которых гейт держит по
       * жёсткому порогу, теперь разводится именно контуром. Категорию несёт
       * рамка на ступень внутрь, иконка и луч: ровно те три места, что и
       * раньше (GDD §21), просто рамка стала внутренней — снаружи стоит
       * кремовый силуэт, по которому карта опознаётся как карта.
       */
      entity(b, Shape.Box, x, y, fw, fh, 0, PALETTE.card, edgeA);

      // Кольцо «цены места» (часть C): снаружи лица карты, чтобы не спорить
      // с формой иконки категории внутри неё ни по смыслу, ни по месту.
      b.push(
        Shape.Ring,
        x,
        y,
        r * 1.12,
        r * 1.12,
        0,
        0,
        0,
        0,
        0,
        1.5,
        ringColour.r,
        ringColour.g,
        ringColour.b,
        ringA * edgeA,
      );

      b.push(
        Shape.Box,
        x,
        y,
        fw - STROKE,
        fh - STROKE,
        0,
        0,
        0,
        0,
        0,
        2.5,
        colour.r,
        colour.g,
        colour.b,
        edgeA,
      );
      // Пиктограмма ПАРИ, а не категории: «Без урона» и «Без рывка» обе из
      // Стиля и с иконкой категории были неразличимы (см. `drawBetIcon`).
      drawBetIcon(b, s.kBet[i], x, y - fh * 0.34, fh * 0.34, colour, ENTITY_FILL, edgeA);

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
      // Множитель кремовым, а не чернилами: лицо карты стало тёмным, и
      // чернильные цифры на нём пропадали бы ровно так же, как раньше
      // пропадали кремовые на кремовом.
      drawMultiplier(
        b,
        spec.multiplier / FX_ONE,
        x - fw * 0.66,
        y + fh * 0.5,
        fh * 0.26,
        PALETTE.card,
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

        /*
         * Имя пари — как только есть кому его взять (playtest: «поднимая
         * карты пари непонятно, что я поднимаю»).
         *
         * Раньше имя показывалось только по удержанию «рассмотреть»
         * (`Btn.Inspect`), и тот же плейтест повторил жалобу уже после этого
         * фикса: скрытая по умолчанию подсказка не помогает игроку, который
         * не знает, что её нужно вызывать. Правило «в бою букв нет» (UX §1,
         * столп 3) получает то же единственное исключение, что и раньше, —
         * оно просто больше не спрятано за отдельной кнопкой. Момент, когда
         * имя нужно, — ровно тот, когда карту вообще можно взять: глиф
         * «Забрать» уже стоит над ней, а решение бежать сюда или мимо
         * принимается ДО нажатия кнопки, а не после.
         */
        const c = PALETTE.hudText;
        this.text.push(betName(spec.id), x, y - r * 2.2 - 24, 14, Face.Ui, c.r, c.g, c.b, 0.95, 'center');
      }
    }
  }

  /**
   * Глиф «чем берут»: буква X в квадрате клавиши, треугольник-триггер в круге
   * геймпада.
   *
   * Оправа и есть весь язык: круг — кнопка геймпада, квадрат — клавиша, голое
   * кольцо — тап по таче, где буквы нет вовсе. Схема берётся из состояния
   * (`pScheme`), а туда её кладёт кадр ввода, — поэтому игрок, взявшийся за
   * геймпад посреди боя, видит смену глифа сразу, а не после перезапуска.
   * Подбор на паде живёт на LT, а не на лицевой X (см. комментарий у
   * `PAD_CONFIRM_BTN` в input.ts) — буква X там означала бы кнопку, а не
   * триггер, поэтому геймпадный глиф рисуется отдельной фигурой.
   */
  private drawTakeGlyph(x: number, y: number, scheme: number): void {
    const b = this.batch;
    const c = PALETTE.hudText;
    // Оправа по схеме: круг — геймпад, квадрат — клавиша, и у тача СВОЯ форма
    // — голое кольцо без штриха внутри, а не квадрат клавиши без буквы: тач
    // не жмёт кнопку, он касается самой карты (GDD §21).
    const frame =
      scheme === InputScheme.Gamepad ? Shape.Circle : scheme === InputScheme.Touch ? Shape.Ring : Shape.Box;
    b.push(frame, x, y, 15, 15, 0, 0, 0, 0, 0, 3, c.r, c.g, c.b, 0.95);
    if (scheme === InputScheme.Touch) return;
    if (scheme === InputScheme.Gamepad) {
      b.push(Shape.Triangle, x, y, 8, 8, -Math.PI / 2, c.r, c.g, c.b, 0.95, 0, 0, 0, 0, 0);
      return;
    }
    // Буква X двумя перекрещенными планками, а не глифом из атласа: это
    // обозначение КЛАВИШИ, и она обязана выглядеть одинаково в любом языке и
    // при любой гарнитуре — включая шрифт для дислексии (UX §5).
    for (const a of [Math.PI / 4, -Math.PI / 4]) {
      b.push(Shape.Box, x, y, 8, 1.6, a, c.r, c.g, c.b, 0.95, 0, 0, 0, 0, 0);
    }
  }

  /**
   * Крупье на арене.
   *
   * Рисуется НИЖЕ боевых сущностей и полупрозрачным: он второй игрок за
   * столом, а не препятствие, и перекрывать снаряды ему нельзя — читаемость
   * объявлена столпом дизайна (GDD §12А.1). Своя цветовая ниша, кремовая с
   * угольным, выводит его из спектров и врагов, и игроков.
   *
   * Пока он замахивается, над ним растёт кольцо: подброс телеграфируется за
   * полсекунды, чтобы карта не падала сюрпризом.
   */
  private drawAce(s: SimState, fb: Feedback): void {
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
     * Тулья и поля цилиндра — над лицом, а не вместо него.
     *
     * До этой правки Крупье был одним боксом с глазами прямо на нём: с шага
     * назад он читался как плывущий прямоугольник, а не персонаж. Цилиндр
     * остаётся его отличительным силуэтом (GDD §17А), но теперь сидит на
     * круглом лице, как и положено головному убору — форма читается сразу,
     * без подписи.
     *
     * Тулья короче прежней (20 вместо 26): освободившееся место уходит лицу.
     * Кремовый несущий контур в 4 единицы — тот же, что и раньше; на трёх он
     * выходил в два пикселя реального экрана, и Крупье не было видно вовсе.
     */
    entity(b, Shape.Box, x, y + bob - 6, 20, 20, tilt, PALETTE.ace, 0.85);
    b.push(Shape.Box, x, y + bob + 12, 30, 5, tilt, ...channels(PALETTE.ace), 0.85, 0, 0, 0, 0, 0);
    entity(b, Shape.Circle, x, y + bob + 32, 17, 17, 0, PALETTE.ace, 0.85);

    /*
     * Глаза: обычно смотрит на игрока — за ним и пришёл.
     *
     * На БЛИЖАЙШЕГО живого, а не на первого по номеру. Взгляд — половина
     * характера Крупье (GDD §17А), и вчетвером «всегда на P1» читается не как
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

    /*
     * Реплика — подписью под Крупье, и только пока он на арене.
     *
     * Своего таймера у неё нет намеренно. Крупье уходит через три секунды после
     * выхода (PRODUCTION §3), и реплика уходит вместе с ним: второй счётчик
     * жил бы своей жизнью и однажды оставил бы фразу висеть над пустым полом.
     *
     * Реплика — приправа к жесту, а не его замена (GDD §17А), поэтому она
     * мельче HUD и приглушена: тело Крупье остаётся главным, а строка читается
     * тем, кто успел на неё посмотреть. Субтитры для тех, кто не слышит, —
     * отдельная настройка со своим кеглем и фоном (UX §5).
     */
    if (fb.bark !== '') {
      const c = PALETTE.hudText;
      this.text.push(fb.bark, x, y + bob + 52, 16, Face.Ui, c.r, c.g, c.b, 0.85, 'center');
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
      // Золото ушло с заливки на обводку: россыпь фишек была самым ярким
      // пятном на полу и спорила по яркости со снарядами, хотя стоит в
      // иерархии ниже игроков и карт (GDD §21). Кольцо той же ширины, что у
      // всех, оставляет фишку узнаваемой и возвращает её на своё место.
      entity(this.batch, Shape.Circle, x, y, 11, 11, 0, c);
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
      const colour = enemyColour(type);
      const squash = fb.enemySquash[i];

      // Фитиль пульсирует всегда, а с подожжённым фитилём — вдвое чаще:
      // «сейчас рванёт» должно читаться и без телеграфа под ним.
      const lit = type === EnemyType.Fuse && s.ePhase[i] === EnemyPhase.Telegraph;
      const pulse = type === EnemyType.Fuse ? 1 + 0.12 * Math.sin(s.tick * (lit ? 0.6 : 0.2)) : 1;

      const vx = toFloat(s.eVX[i]);
      const vy = toFloat(s.eVY[i]);
      if (s.ePhase[i] === EnemyPhase.Telegraph || s.ePhase[i] === EnemyPhase.Attack) {
        // Направление удара зафиксировано на весь телеграф — доворот сюда
        // мгновенный и есть сам телеграф, сглаживать нечего.
        this.enemyFacing[i] = Math.atan2(toFloat(s.eDirY[i]), toFloat(s.eDirX[i]));
      } else if (vx * vx + vy * vy > 0.01) {
        /*
         * Поле потока (`nav.ts`) отдаёт одно из восьми направлений к ячейке с
         * наименьшей стоимостью — и на плато, где у соседних ячеек стоимость
         * почти равна, счёт может качнуться в другую сторону от тика к тику.
         * Скорость при этом не падает (враг всё так же идёт на полной
         * скорости), поэтому проверка «скорость мала — не поворачивать»
         * (выше) эту дрожь не ловит: она не про модуль скорости, а про её
         * направление. Сглаживаем сам угол — короткой дугой, не через ноль, —
         * так гонка тик-в-тик усредняется, а настоящий поворот всё ещё
         * дочитывается за несколько кадров, не за один.
         */
        const target = Math.atan2(vy, vx);
        const prev = this.enemyFacing[i];
        let diff = target - prev;
        diff = ((diff + Math.PI) % (Math.PI * 2)) - Math.PI;
        if (diff < -Math.PI) diff += Math.PI * 2;
        this.enemyFacing[i] = prev + diff * 0.25;
      }
      const facing = this.enemyFacing[i];

      const shape =
        type === EnemyType.Wedge
          ? Shape.Triangle
          : type === EnemyType.Brick
            ? Shape.Box
            : Shape.Circle;
      const rot = type === EnemyType.Brick ? 0 : facing;

      /*
       * Тип врага несёт форма, цвет — второй признак, и с 0.4.0 он живёт в
       * обводке (GDD §21). Двойное кодирование от этого не пострадало:
       * треугольник, квадрат и круг различаются силуэтом, а силуэт как раз и
       * стал тем, что рисуется.
       *
       * Вспышка попадания — единственное место, где заливка врага не общая:
       * «попал» читается телом, а не каймой, и белая вспышка на четверть
       * секунды для того и заведена. Обводка при этом остаётся своей — иначе в
       * момент попадания пропадал бы тип того, в кого попали.
       */
      b.push(
        shape,
        x,
        y,
        r * pulse * (1 + squash),
        r * pulse * (1 - squash * 0.6),
        rot,
        ...channels(flash ? PALETTE.bullet : ENTITY_FILL),
        1,
        STROKE,
        colour.r,
        colour.g,
        colour.b,
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

      // Свой цвет переехал с тела на обводку, и правило «игрок всегда различим
      // в толпе» (GDD §21) держится теперь ею и нимбом: белая обводка,
      // одинаковая у всех четверых, различала игроков между собой хуже, чем их
      // собственные цвета, ради которых она и стояла.
      entity(
        b,
        Shape.Circle,
        x,
        y,
        r * (1 + stretch),
        r * (1 - stretch * 0.7),
        angle,
        colour,
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

      // Та же плашка, что в HUD и на расчёте, и в том же языке: тёмное поле с
      // несущей рамкой цветом категории.
      entity(b, Shape.Box, x, y, 52, 24, 0, colour, a, 3);
      drawBetIcon(b, bet, x - 36, y - 11, 9, colour, ENTITY_FILL, a);
      drawMultiplier(b, BETS[bet].multiplier / FX_ONE, x - 22, y - 11, 7, PALETTE.hudText, a);

      // Кон ушёл — треугольник вниз мутным; куш придёт — треугольник вверх
      // золотом. Направление читается быстрее знака и не требует перевода.
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
      // Число красится в цвет своей стрелки: на тёмном поле чернила не видны
      // вовсе, а раскрасить оба числа одним кремовым значило бы потерять
      // разницу между «ушло» и «придёт», которую стрелки как раз и несут.
      drawNumber(b, fb.dealStake[p], x - 28, y + 11, 8, dim, a);
      const ch = PALETTE.chip;
      b.push(Shape.Triangle, x - 2, y + 11, 5, 5, -Math.PI / 2, ch.r, ch.g, ch.b, a, 0, 0, 0, 0, 0);
      drawNumber(b, fb.dealPayout[p], x + 26, y + 11, 9, ch, a);
    }
  }

  /**
   * Снаряды — объявленное исключение из «тёмной заливки и несущей обводки».
   *
   * Пуля игрока рисуется капсулой с полутолщиной 6 единиц. Обводка в 4 съела
   * бы её почти целиком: от снаряда осталась бы тёмная сердцевина в пару
   * единиц с каймой, то есть точка. Между «единообразием языка» и правилом
   * «снаряды всегда светлее и ярче всего остального» (GDD §21) выбрано
   * правило: оно про то, выживет игрок или нет, а язык — про то, как это
   * выглядит.
   *
   * Ничего не теряется и по существу. Тёмная заливка нужна там, где цветов
   * много и роль надо опознать; у снаряда роль ровно одна — «в меня сейчас
   * прилетит», — и различать её надо не с другой ролью, а с полом, что
   * сплошная заливка и делает лучше всего.
   */
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
   * Боевой HUD — формы и цифры, без единой надписи.
   *
   * Шрифт в игре есть (F2, PRODUCTION §4), а подписей здесь по-прежнему нет,
   * и это решение, а не отставание. В бою на HUD не читают, а узнают: сердца —
   * шестиугольники, волна — пипсы, кошелёк — семисегментные цифры. Слово
   * требует перевода в буквы и обратно, и в перестрелке этот перевод стоит
   * дороже всего, что оно способно уточнить. Текст живёт там, где на него
   * смотрят: на расчёте и в репликах Крупье.
   */
  private drawHud(
    s: SimState,
    w: number,
    h: number,
    fb: Feedback,
    cashOutTarget = -1,
  ): void {
    const b = this.batch;
    const top = 34;

    for (let i = 0; i < s.playerCount; i++) {
      const colour = PALETTE.player[i] as Rgb;
      const baseX = 40 + i * 240;
      for (let n = 0; n < PLAYER.startHearts; n++) {
        const full = n < s.pHearts[i];
        /*
         * Сердце в новом языке: тёмное поле с обводкой своего цвета, а полное
         * от пустого отличается ЯДРОМ внутри.
         *
         * Раньше разницу нёс цвет заливки, и с общей тёмной заливкой она
         * исчезла бы вовсе: сердце — тот показатель, ради которого игрок косит
         * глазом в бою, и различать его по яркости одной обводки значит не
         * различать никак. Ядро — второй признак к яркости контура, то же
         * двойное кодирование, что и везде.
         */
        const hx = baseX + n * 34;
        entity(b, Shape.Hexagon, hx, top, 13, 13, 0, colour, full ? 1 : 0.45, 3);
        if (full) {
          b.push(Shape.Hexagon, hx, top, 6, 6, 0, colour.r, colour.g, colour.b, 1, 0, 0, 0, 0, 0);
        }
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
        const px = baseX + 196 + t * 13;
        const ph = 4 + t * 3;
        // Тот же приём, что у сердец: выбранный тир отличается ядром, а не
        // одной лишь яркостью контура. Пипс шириной 4 единицы обводится
        // двойкой, а не четвёркой, — четвёрка на такой ширине и есть заливка.
        entity(b, Shape.Box, px, top + 4, 4, ph, 0, c, on ? 1 : 0.45, 2);
        if (on) b.push(Shape.Box, px, top + 4, 1.6, ph - 3, 0, c.r, c.g, c.b, 1, 0, 0, 0, 0, 0);
      }
      this.drawBets(s, i, baseX, top + 46, i === 0 ? cashOutTarget : -1);
    }

    // Волна — пипсами справа: сколько всего и сколько прошло.
    const waves = 3;
    for (let n = 0; n < waves; n++) {
      const done = n < s.meta[Meta.Wave];
      const c = PALETTE.hudText;
      const wx = w - 40 - (waves - 1 - n) * 26;
      entity(b, Shape.Circle, wx, top, 8, 8, 0, c, done ? 0.9 : 0.5, 2);
      // Пройденная волна — с ядром: те же два признака, что у сердец и пипсов.
      if (done) b.push(Shape.Circle, wx, top, 3.5, 3.5, 0, c.r, c.g, c.b, 1, 0, 0, 0, 0, 0);
    }
    drawNumber(b, s.meta[Meta.Room], w - 40 - waves * 26 - 50, top, HUD_DIGIT, PALETTE.hudDim);

    this.drawCashOutSummary(s, w, h);
    this.drawSettlement(s, w, h, fb);
    this.drawAceBetScreen(s, w, h, fb);

    /*
     * Отсчёт после гибели: сколько осталось до итогов.
     *
     * Раньше это поле означало «сейчас перезапустимся», и кольцо честно
     * отсчитывало перезапуск. В 0.4.0 перезапуск заменён концом забега, поле
     * осталось — и кольцо начало отсчитывать до нуля, замирать на нём и
     * ничего не объяснять: игрок видел красный ноль и застывший бой. Теперь
     * оно рисуется ТОЛЬКО пока идёт отсчёт, а на нуле его сменяет экран
     * итогов.
     */
    if (s.meta[Meta.RestartAt] !== 0 && s.meta[Meta.Phase] !== RunPhase.Summary) {
      const left = Math.max(0, s.meta[Meta.RestartAt] - s.tick);
      const c = PALETTE.danger;
      b.push(Shape.Ring, w / 2, h / 2, 60, 60, 0, 0, 0, 0, 0, 6, c.r, c.g, c.b, 0.9);
      drawNumber(b, Math.ceil(left / 60), w / 2, h / 2, 42, PALETTE.hudText);
    }

    this.drawRunScreens(s, w, h);
  }

  /**
   * Общая сумма «Забрать/дожать» — баннер по центру нижней кромки.
   *
   * До сих пор эта сумма нигде не складывалась: каждая плашка сама по себе
   * называла свою выплату (`drawBets`), а решение «жать сейчас или ещё
   * потерпеть» игрок собирал в уме по нескольким числам сразу. Макет
   * («Дизайн игры «Забег»», 1a/1d-A) держит на этот случай отдельный баннер:
   * одна сумма сейчас, одна — если дожать все пари до конца.
   *
   * Только для локального игрока (индекс 0): решение «жать Забрать»
   * принимает тот, чья рука на кнопке, и сумма чужого кошелька здесь не при
   * чём.
   *
   * Букв нет — тот же столп, что у всего боевого HUD: только глиф кнопки и
   * два числа, большее золотом (то, что дадут сейчас), меньшее тусклым (то,
   * что дадут, если дожать всё).
   */
  private drawCashOutSummary(s: SimState, w: number, h: number): void {
    const player = 0;
    let now = 0;
    let full = 0;
    let count = 0;
    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      const k = player * MAX_ACTIVE_BETS + i;
      if (s.aState[k] !== BetState.Active) continue;
      // Ставку Крупье не обналичить — тот же фильтр, что у `cashOutBest`
      // (кон отрицательный: он чужой, «Забрать» не платит по нему ничего).
      // Без него баннер посчитал бы чужую ставку в общую сумму «дожать».
      if (s.aStake[k] < 0) continue;
      now += cashOutValue(s, player, i);
      full += Math.trunc((s.aStake[k] * BETS[s.aBet[k]].multiplier) / FX_ONE);
      count++;
    }
    if (count === 0) return;

    const b = this.batch;
    const cx = w / 2;
    const cy = h - 58;
    const halfW = 150;
    const halfH = 30;
    const gold = PALETTE.accent;
    b.push(Shape.Box, cx, cy, halfW, halfH, 0, ...channels(ENTITY_FILL), 0.82, 2, gold.r, gold.g, gold.b, 0.5);

    const glyphX = cx - halfW + 24;
    const pad = this.scheme === InputScheme.Gamepad;
    if (pad) {
      b.push(Shape.Ring, glyphX, cy, 12, 12, 0, 0, 0, 0, 0, 3, gold.r, gold.g, gold.b, 0.9);
    } else {
      entity(b, Shape.Box, glyphX, cy, 12, 12, 0, gold, 0.9, 3);
    }

    drawNumber(b, now, glyphX + 56, cy, 20, PALETTE.chip);
    drawNumber(b, full, cx + halfW - 34, cy, 12, PALETTE.hudDim);
  }

  /**
   * Экраны забега: дверь, плата и итоги.
   *
   * Все три уже работали в симуляции и были покрыты тестами, но клиент о них
   * не знал вовсе: в рендере была единственная ссылка на фазу, и та на босса.
   * Играть руками было нельзя — человек упирался в замерший бой без единой
   * подсказки, что нажать. Прогоны при этом шли: боты жмут кнопку вслепую.
   *
   * Затемнение под каждым экраном обязательно. Бой под ним остаётся видимым —
   * это тот же мир, а не другое место, — но перестаёт спорить за внимание с
   * решением, ради которого экран и открыт.
   */
  private drawRunScreens(s: SimState, w: number, h: number): void {
    const phase = s.meta[Meta.Phase] as RunPhase;
    if (phase === RunPhase.Door) this.drawDoorScreen(s, w, h);
    else if (phase === RunPhase.Reward) this.drawShopScreen(s, w, h);
    else if (phase === RunPhase.HouseCut) this.drawHouseCutScreen(s, w, h);
    else if (phase === RunPhase.Summary) this.drawSummaryScreen(s, w, h);
  }

  /** Затемнение под экраном: бой виден, но не спорит за внимание. */
  private dim(w: number, h: number): void {
    const c = PALETTE.background;
    this.batch.push(Shape.Box, w / 2, h / 2, w / 2, h / 2, 0, c.r, c.g, c.b, 0.82, 0, 0, 0, 0, 0);
  }

  private screenTitle(text: string, w: number, y: number, size = 38): void {
    const c = PALETTE.hudText;
    this.text.push(text, w / 2, y, size, Face.Display, c.r, c.g, c.b, 0.95, 'center');
  }

  private screenLine(text: string, w: number, y: number, colour = PALETTE.hudDim, size = 15): void {
    this.text.push(text, w / 2, y, size, Face.Ui, colour.r, colour.g, colour.b, 0.9, 'center');
  }

  /**
   * Строка «подпись и число под ней». Возвращает `y` следующей свободной строки.
   *
   * Шаг считается, а не подбирается на глаз, и это не педантизм: `drawNumber`
   * меряет цифру ПОЛУВЫСОТОЙ, то есть число кеглем 30 занимает шестьдесят
   * единиц. Разложенные по «примерно сорока», подписи налезали на цифры на
   * трёх экранах сразу — «Доля заведения» читалась поверх самой доли.
   */
  private screenValue(
    label: string,
    value: number,
    w: number,
    y: number,
    size: number,
    colour: Rgb,
    labelColour = PALETTE.hudDim,
  ): number {
    this.screenLine(label, w, y, labelColour);
    drawNumber(this.batch, value, w / 2, y + size + 18, size, colour);
    return y + size * 2 + 46;
  }

  /**
   * Выбор двери: три карточки, выбранная — золотом.
   *
   * Золото здесь то же, что подсвечивает ближайшую карту на арене: «вот это
   * возьмётся, если нажать». Игрок уже выучил его в бою, и заводить второй
   * язык подсветки ради экрана значило бы учить заново.
   */
  private drawDoorScreen(s: SimState, w: number, h: number): void {
    this.dim(w, h);
    // Титул и подсказка стоят НАД карточками, а не на них: полувысота двери —
    // 128 единиц, и прежние −150/−110 клали подсказку прямо на лица дверей.
    this.screenTitle(t('door.title'), w, h / 2 - 230);
    this.screenLine(t('door.hint'), w, h / 2 - 186);

    const pick = s.meta[Meta.DoorPick];
    const gap = 250;
    for (let i = 0; i < MAX_DOORS; i++) {
      const x = w / 2 + (i - (MAX_DOORS - 1) / 2) * gap;
      const chosen = i === pick;
      const colour = chosen ? PALETTE.accent : PALETTE.hudDim;
      entity(this.batch, Shape.Box, x, h / 2, 96, 128, 0, colour, chosen ? 1 : 0.7);
      this.text.push(
        doorTypeName(s.doorType[i] as DoorType),
        x,
        h / 2 + 160,
        16,
        Face.Ui,
        colour.r,
        colour.g,
        colour.b,
        chosen ? 1 : 0.75,
        'center',
      );
      // Долговая яма тяжелее обычного боя и появляется не всегда — без
      // объяснения игрок примет её за обычную дверь и не поймёт, зачем она
      // вообще возникла (UX §1.2 — контекст виден всегда).
      if (s.doorType[i] === DoorType.DebtPit) {
        this.wrapped(t('door.type.pit.hint'), x, h / 2 + 184, gap - 20, 12, colour, 0.6);
      }
    }
    this.confirmHint(w, h / 2 + 220);
  }

  /**
   * Подпись «чем подтверждают» — по схеме ввода из кадра.
   *
   * Экранов в игре пять, и ни один из них не боевой: сюда смотрят, а не косят
   * глазом, и правило «в бою букв нет» (UX §4) на них не распространяется.
   * Кнопка при этом названа СЛОВОМ, а не глифом, как на арене: глиф в оправе
   * говорит «нажми вот эту», и работает он, пока кнопка одна и общеизвестна
   * (X — подбор). Подтверждение живёт на RB и на `Enter`, то есть на кнопках,
   * которых игрок не угадает, — их надо назвать.
   *
   * Схема берётся ЖИВАЯ, из слоя ввода, а не из `pScheme` состояния, — в
   * отличие от глифа на арене. Разница не формальная: `pScheme` заполняется
   * кадром ввода, то есть существует только пока идут тики, а меню стоит до
   * первого из них — и подпись обещала бы кнопку геймпада тому, кто держит
   * мышь. Глиф на арене остаётся на состоянии: там схема нужна ПО ИГРОКУ, и
   * в коопе она у всех своя.
   */
  private confirmHint(w: number, y: number): void {
    const pad = this.scheme === InputScheme.Gamepad;
    this.screenLine(pad ? t('screen.confirm.pad') : t('screen.confirm.key'), w, y, PALETTE.hudDim);
  }

  /** То же для отказа: на экранах, где отказ — это отдельный выход, а не «назад». */
  private cancelHint(w: number, y: number): void {
    const pad = this.scheme === InputScheme.Gamepad;
    this.screenLine(pad ? t('screen.cancel.pad') : t('screen.cancel.key'), w, y, PALETTE.hudDim);
  }

  /**
   * Строка, переносимая по словам в заданную ширину, по центру.
   *
   * Обрезки многоточием здесь нет намеренно: переносится ИМЯ — товара, пари,
   * варианта торга, — и обрезанное имя не опознаётся вовсе, а макет держит
   * +40% длины под немецкий (UX §4). Перенос по пробелам, без переносов внутри
   * слова: слово длиннее карточки честнее выпустить за край, чем разорвать по
   * незнакомым правилам чужого языка.
   */
  private wrapped(
    text: string,
    x: number,
    y: number,
    maxW: number,
    size: number,
    colour: Rgb,
    alpha = 0.95,
  ): void {
    const words = text.split(' ');
    const lines: string[] = [];
    let line = '';
    for (const word of words) {
      const next = line === '' ? word : `${line} ${word}`;
      // До готовности атласа ширина нулевая, и перенос не нужен: букв нет.
      if (line !== '' && this.text.width(next, size, Face.Ui) > maxW) {
        lines.push(line);
        line = word;
        continue;
      }
      line = next;
    }
    if (line !== '') lines.push(line);

    const step = size * 1.35;
    const top = y - (step * (lines.length - 1)) / 2;
    for (let i = 0; i < lines.length; i++) {
      this.text.push(
        lines[i],
        x,
        top + i * step,
        size,
        Face.Ui,
        colour.r,
        colour.g,
        colour.b,
        alpha,
        'center',
      );
    }
  }

  /**
   * Карточка экрана: та же тёмная заливка и несущая обводка, что у арены.
   *
   * Выбранная — золотом заведения: то же золото, что подсвечивает карту под
   * ногами, «вот это возьмётся, если нажать».
   *
   * Недоступная уходит в ХРОМ, а доступная-невыбранная — в приглушённый
   * лиловый, и порядок здесь именно такой. Наоборот уже было: хром тёмный,
   * лиловый светлый, и вариант «продавать нечего» светился ярче варианта,
   * который игрок мог выбрать. Недоступное обязано быть самым тусклым на
   * экране — это его единственный признак.
   */
  private screenCard(
    x: number,
    y: number,
    halfW: number,
    halfH: number,
    focused: boolean,
    available = true,
  ): Rgb {
    const colour = !available ? PALETTE.chrome : focused ? PALETTE.accent : PALETTE.hudDim;
    const alpha = !available ? 0.5 : focused ? 1 : 0.75;
    entity(this.batch, Shape.Box, x, y, halfW, halfH, 0, colour, alpha);
    return colour;
  }

  /**
   * Ценник фишками: золотой кружок и число рядом с ним.
   *
   * Тот же язык, что под картой пари на арене, где называется кон, — и одна
   * функция на все экраны намеренно. Цена лежит на прилавке и на торге, и
   * разъехавшись, они читались бы как два разных вида денег: там, где написано
   * число, игрок обязан узнавать фишки с первого взгляда, а не разбирать
   * подпись.
   */
  private priceTag(value: number, x: number, y: number, size: number, colour: Rgb): void {
    this.batch.push(
      Shape.Circle,
      x - size * 2.9,
      y,
      size * 0.56,
      size * 0.56,
      0,
      colour.r,
      colour.g,
      colour.b,
      0.9,
      0,
      0,
      0,
      0,
      0,
    );
    drawNumber(this.batch, value, x + size * 0.9, y, size, colour);
  }

  /**
   * Главное меню: одна крупная кнопка «Играть», остальное мельче (UX §6).
   *
   * Выбора персонажа и сложности здесь нет и в 0.4.0 не будет — на нулевой
   * секунде игрок жмёт одну кнопку и оказывается в бою (GDD §23). «Выбор
   * режима», обещанный той же таблицей после первого забега, не нарисован
   * намеренно: режимов до кооперативa 0.5.0 не существует, а кнопка, которая
   * ничего не делает, дороже отсутствующей (UX §2).
   *
   * Второй элемент — «Настройки» — появился вместе с поштучным забором:
   * первой настройкой, которую вообще есть где переключить. Фокус между
   * ними — горизонталь (`NavLeft`/`NavRight`, `loop.ts`), «Играть» им не
   * теряет доминирования: она крупнее и стоит первой по чтению слева направо.
   */
  private drawMenuScreen(w: number, h: number, overlay: MenuOverlay): void {
    this.dim(w, h);
    this.screenTitle(t('menu.title'), w, h / 2 - 170, 56);
    this.screenLine(t('menu.tagline'), w, h / 2 - 110);

    // Кнопка крупная не для красоты: она главная, и её размер — весь ответ
    // на вопрос «что тут делать в первую очередь». Прямоугольник общий с
    // `loop.ts` (клик, наведение) — см. `menuLayout.ts`.
    const playX = w / 2 + MENU_PLAY_BUTTON.dx;
    const c = this.screenCard(playX, h / 2, MENU_PLAY_BUTTON.halfW, MENU_PLAY_BUTTON.halfH, overlay.focus === 0);
    this.text.push(t('menu.play'), playX, h / 2, 28, Face.Ui, c.r, c.g, c.b, 1, 'center');

    const settingsX = w / 2 + MENU_SETTINGS_BUTTON.dx;
    const cs = this.screenCard(
      settingsX,
      h / 2,
      MENU_SETTINGS_BUTTON.halfW,
      MENU_SETTINGS_BUTTON.halfH,
      overlay.focus === 1,
    );
    this.text.push(t('menu.settings'), settingsX, h / 2, 18, Face.Ui, cs.r, cs.g, cs.b, 1, 'center');

    // Клик работает только на этом экране (боя тут точно нет), поэтому
    // подсказка своя, а не общий confirmHint (UX §2).
    const pad = this.scheme === InputScheme.Gamepad;
    this.screenLine(
      pad ? t('screen.confirm.pad') : t('menu.confirm.key'),
      w,
      h / 2 + 100,
      PALETTE.hudDim,
    );
    this.screenLine(
      pad ? t('menu.tutorial.pad') : t('menu.tutorial.key'),
      w,
      h / 2 + 128,
      PALETTE.hudDim,
    );
  }

  /**
   * Настройки: сегодня один пункт — поштучный забор пари (доступность).
   *
   * Экран заведён под один тумблер, а не под три вкладки из UX §6, — те три
   * (Игра / Управление / Доступность) появятся вместе со вторым и третьим
   * пунктом, которого сегодня нет ни одного. Пустая вкладка хуже отсутствующей
   * (UX §2).
   */
  private drawSettingsScreen(w: number, h: number, overlay: MenuOverlay): void {
    this.dim(w, h);
    this.screenTitle(t('settings.title'), w, h / 2 - 160, 40);

    const c = this.screenCard(w / 2, h / 2, 260, 60, true);
    this.text.push(
      t(overlay.cashOutFocusedOnly ? 'settings.cashout_focus.on' : 'settings.cashout_focus.off'),
      w / 2,
      h / 2 - 14,
      20,
      Face.Ui,
      c.r,
      c.g,
      c.b,
      1,
      'center',
    );
    this.wrapped(t('settings.cashout_focus.desc'), w / 2, h / 2 + 20, 440, 13, PALETTE.hudDim, 0.85);

    this.confirmHint(w, h / 2 + 110);
    this.cancelHint(w, h / 2 + 138);
  }

  /**
   * Туториал/глоссарий: карточка на термин, название и одна строка объяснения.
   *
   * Не заменяет обучение действием (§23 GDD) — это резервный текстовый путь
   * для тех, кому первых 10 минут не хватило (playtest 0.3.1: 20 забегов, и
   * смысл механик так и не сложился). Открывается из меню, ничего не решает,
   * закрывается тем же отказом, что и открылся (UX §7).
   */
  private drawTutorialScreen(w: number, h: number): void {
    this.dim(w, h);
    this.screenTitle(t('tutorial.title'), w, h / 2 - 300, 44);
    this.screenLine(t('tutorial.hint'), w, h / 2 - 250);

    const terms: [StringKey, StringKey][] = [
      ['tutorial.ace.name', 'tutorial.ace.desc'],
      ['tutorial.appetite.name', 'tutorial.appetite.desc'],
      ['tutorial.bet.name', 'tutorial.bet.desc'],
      ['tutorial.house_cut.name', 'tutorial.house_cut.desc'],
      ['tutorial.trampoline.name', 'tutorial.trampoline.desc'],
      ['tutorial.debt_pit.name', 'tutorial.debt_pit.desc'],
      ['tutorial.keys.name', 'tutorial.keys.desc'],
      ['tutorial.fat_fight.name', 'tutorial.fat_fight.desc'],
      ['tutorial.gift.name', 'tutorial.gift.desc'],
    ];

    const cols = 4;
    const gapX = 340;
    const gapY = 210;
    const originX = w / 2 - (gapX * (cols - 1)) / 2;
    const originY = h / 2 - 90;

    for (let i = 0; i < terms.length; i++) {
      const [nameKey, descKey] = terms[i];
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = originX + col * gapX;
      const y = originY + row * gapY;
      const c = this.screenCard(x, y, 155, 90, false);
      this.text.push(t(nameKey), x, y - 40, 22, Face.Ui, c.r, c.g, c.b, 1, 'center');
      // Тиры аппетита подставляются из конфига, а не вписаны в строку: баланс
      // правит их в одном месте, а не в двух, забывая про второе.
      const desc =
        descKey === 'tutorial.appetite.desc'
          ? t(descKey, { tier1: APPETITE[0], tier2: APPETITE[1], tier3: APPETITE[2] })
          : t(descKey);
      this.wrapped(desc, x, y + 14, 280, 14, PALETTE.hudDim, 0.85);
    }

    this.cancelHint(w, h - 80);
  }

  /**
   * Лавка: три карточки товара с ценой (UX §6, GDD §5).
   *
   * Экран читает состояние и ничего не решает: что лежит в слоте
   * (`shopItem`, индекс апгрейда плюс единица), сколько просят (`shopPrice`) и
   * что уже куплено (`pUpgrades`). Пустой слот — проданный товар, и он
   * остаётся на экране пустой рамкой: исчезнувшая карточка сдвинула бы
   * соседние под пальцем игрока.
   *
   * Имя товара — из словаря по ключу `upgrade.<id>.name` (`upgradeName`
   * ниже): `name` в `content/upgrades.json` служебный и не переводится,
   * подписывать им витрину значило бы выдумывать текст в коде мимо словаря
   * (UX §8).
   *
   * Цена красится алым, когда не хватает: решение здесь одно — «беру или
   * коплю», — и оно считается в уме из двух чисел, цены и кошелька.
   */
  private drawShopScreen(s: SimState, w: number, h: number): void {
    this.dim(w, h);
    this.screenTitle(t('shop.title'), w, h / 2 - 190);
    this.screenLine(t('shop.hint'), w, h / 2 - 150);

    const purse = walletOf(s);
    const pick = s.meta[Meta.DoorPick];
    const gap = 250;

    for (let i = 0; i < SHOP_SLOTS; i++) {
      const x = w / 2 + (i - (SHOP_SLOTS - 1) / 2) * gap;
      const item = s.shopItem[i];
      const sold = item === 0;
      const price = s.shopPrice[i];
      const afford = !sold && price <= purse;
      const c = this.screenCard(x, h / 2, 100, 120, i === pick, !sold);

      if (sold) {
        this.text.push(t('shop.sold'), x, h / 2, 15, Face.Ui, c.r, c.g, c.b, 0.8, 'center');
        continue;
      }

      // Пиктограмма товара — «плюс в кольце»: апгрейд прибавляет. Форма
      // общая на все шесть намеренно: своих пиктограмм у апгрейдов нет, а
      // выдуманная «на глаз» врала бы о том, что именно покупают, — имя под
      // ней говорит это точно.
      const ring = 34;
      this.batch.push(Shape.Ring, x, h / 2 - 46, ring, ring, 0, 0, 0, 0, 0, 4, c.r, c.g, c.b, 1);
      this.batch.push(Shape.Box, x, h / 2 - 46, 16, 3, 0, c.r, c.g, c.b, 1, 0, 0, 0, 0, 0);
      this.batch.push(Shape.Box, x, h / 2 - 46, 3, 16, 0, c.r, c.g, c.b, 1, 0, 0, 0, 0, 0);

      /*
       * Имя товара — из словаря по идентификатору каталога, как у пари.
       *
       * `name` в `content/upgrades.json` служебный: он для отчётов
       * балансировщика и сценариев и не переводится. Английская сборка,
       * взявшая его на витрину, показала бы «Кулдаун рывка −30%».
       *
       * Строка переносится по словам: «Кулдаун рывка −30%» в карточку шириной
       * 200 единиц не влезает ни в одном языке, а немецкий держит +40%
       * (UX §4). Резать многоточием нечего — товар опознаётся именно именем.
       */
      this.wrapped(upgradeName(item - 1), x, h / 2 + 10, 190, 15, c);
      // Цена алым, когда не хватает: решение здесь одно — «беру или коплю», —
      // и считается оно из двух чисел, цены и кошелька.
      this.priceTag(price, x, h / 2 + 74, 16, afford ? PALETTE.chip : PALETTE.danger);
    }

    const next = this.screenValue(t('house.purse'), purse, w, h / 2 + 190, 18, PALETTE.chip);
    this.confirmHint(w, next);
    // Уйти без покупки — законное решение, и о нём надо сказать: фишки
    // конвертируются в ключи в конце забега (ECONOMY §12), и «унести»
    // конкурирует с «потратить» на равных.
    this.screenLine(t('shop.leave'), w, next + 28);
    this.cancelHint(w, next + 52);
  }

  /**
   * Плата в конце этажа и торг, если не хватило.
   *
   * Пока хватает, решение одно и экран отвечает тремя числами: сколько просят,
   * сколько есть, что будет по нажатию. Не хватило — это уже не отказ в
   * обслуживании, а торг: Крупье выкладывает три выхода (GDD §12А.2), и экран
   * обязан показать все три, включая тот, которым игрок не воспользуется.
   *
   * Продажа апгрейда гаснет, когда продавать нечего: вариант, недоступный по
   * состоянию, обязан выглядеть недоступным — иначе игрок ищет причину в
   * кнопке, а её там нет.
   */
  private drawHouseCutScreen(s: SimState, w: number, h: number): void {
    this.dim(w, h);
    const purse = walletOf(s);
    const cut = s.meta[Meta.HouseCut];
    const enough = purse >= cut;

    this.screenTitle(enough ? t('house.title') : t('haggle.title'), w, h / 2 - 250);

    let y = this.screenValue(t('house.cut'), cut, w, h / 2 - 190, 26, PALETTE.accent);
    y = this.screenValue(t('house.purse'), purse, w, y, 18, PALETTE.chip);

    if (enough) {
      this.screenLine(t('house.pay'), w, y + 10, PALETTE.accent, 18);
      this.confirmHint(w, y + 60);
      return;
    }

    y = this.screenValue(t('house.short'), cut - purse, w, y, 18, PALETTE.danger, PALETTE.danger);

    /*
     * Три варианта торга — карточками в ряд, как двери, но БЕЗ бегающего
     * фокуса, и это не упрощение вёрстки.
     *
     * В ядре у торга своей навигации нет: вариант выбирается КНОПКОЙ, а не
     * курсором (`stepHouseCut`). Нарисованный поверх этого фокус выбирал бы
     * что-то одно, а нажатие делало бы своё — экран врал бы ровно там, где
     * игрок расстаётся с этажом. Поэтому у каждой карточки написана своя
     * кнопка, и написана она по текущей схеме ввода.
     *
     * Порядок карточек задан их кнопками, а не ценой варианта. Выкуп апгрейда
     * висит на горизонтали (на торге она свободна: фокуса здесь нет), а
     * горизонталь — это направление, и означать она имеет право только то, что
     * лежит СЛЕВА. Поэтому выкуп крайний левый, а пари — в середине, где
     * подтверждение и не спорит ни с какой стороной. Золотом при этом
     * по-прежнему пари: тот же язык, что на двери и на прилавке, «вот это
     * возьмётся, если нажать», — и это лучший из трёх выходов, потому что
     * оставляет игроку шанс рассчитаться.
     */
    const pad = this.scheme === InputScheme.Gamepad;
    /*
     * Что заведение даёт за апгрейд — половина цены текущего этажа
     * (ECONOMY §10), и ноль означает «продавать нечего».
     *
     * Число названо, а не спрятано за словом «продать»: торг — это размен, и
     * сравнить его не с чем, пока обе стороны сделки не показаны. Недостача
     * стоит строкой выше, цена выкупа — под карточкой, и решение «хватит ли»
     * считается в уме, как и на прилавке.
     */
    const sale = buybackOf(s);
    const options: readonly [string, string, boolean, boolean, number][] = [
      [
        t('haggle.sell'),
        sale > 0 ? (pad ? t('screen.sell.pad') : t('screen.sell.key')) : t('haggle.empty'),
        sale > 0,
        false,
        sale,
      ],
      [t('haggle.bet'), pad ? t('screen.confirm.pad') : t('screen.confirm.key'), true, true, 0],
      [t('house.debt'), pad ? t('screen.cancel.pad') : t('screen.cancel.key'), true, false, 0],
    ];
    const gap = 360;
    const row = y + 60;
    for (let i = 0; i < options.length; i++) {
      const [label, button, available, primary, value] = options[i];
      const x = w / 2 + (i - (options.length - 1) / 2) * gap;
      const c = this.screenCard(x, row, 165, 62, primary, available);
      this.wrapped(label, x, row - 14, 300, 15, c, available ? 1 : 0.7);
      const dim = PALETTE.hudDim;
      this.text.push(
        button,
        x,
        row + 34,
        13,
        Face.Ui,
        dim.r,
        dim.g,
        dim.b,
        available ? 0.9 : 0.5,
        'center',
      );
      // Цена выкупа — фишками, под своей карточкой: заведение платит, значит
      // число золотое, как и всё, что в кошелёк приходит.
      if (value > 0) this.priceTag(value, x, row + 76, 13, PALETTE.chip);
    }

    /*
     * Кон принудительного пари — это НЕДОСТАЧА, а не тир аппетита
     * (`takeForcedBet` в ядре), и назвать его обязан экран: игрок соглашается
     * на пари, а не на «что-нибудь». Множитель рядом — вторая половина сделки,
     * и берётся он у той же стороны, что его назначила, а не переписывается
     * сюда числом.
     */
    drawNumber(this.batch, cut - purse, w / 2 - 28, row + 76, 13, PALETTE.accent);
    drawMultiplier(this.batch, HOUSE.forcedBetMultiplier, w / 2 + 16, row + 76, 11, PALETTE.accent);
  }

  /**
   * Итоги: чем кончился забег и что игрок унёс.
   *
   * Отдельный экран, а не строка поверх боя. Забег обязан кончаться ЯВНО:
   * ворота версии меряют, сколько игроков начинают второй ДОБРОВОЛЬНО, а
   * добровольность невозможно измерить у того, кто не понял, что предыдущий
   * закончился.
   */
  private drawSummaryScreen(s: SimState, w: number, h: number): void {
    this.dim(w, h);
    const won = s.meta[Meta.Victory] !== 0;

    this.screenTitle(won ? t('summary.victory') : t('summary.death'), w, h / 2 - 240, 34);

    // Ключи — крупнее всего остального: это единственное, что игрок уносит из
    // забега (ECONOMY §12), и на скриншоте видно должно быть именно их.
    let y = this.screenValue(
      t('summary.floor'),
      s.meta[Meta.Floor],
      w,
      h / 2 - 180,
      22,
      PALETTE.hudText,
    );
    y = this.screenValue(t('summary.keys'), s.meta[Meta.Keys], w, y, 36, PALETTE.accent);

    /*
     * Разбивка источников ключей: считается той же формулой, что и ядро
     * (`keysEarned` в packages/sim/src/run.ts, ECONOMY §12), но не вызывает
     * её напрямую — экран итогов не пересчитывает забег, а читает готовые
     * поля состояния, из которых формула и складывается.
     */
    let chips = 0;
    for (let i = 0; i < s.playerCount; i++) chips += s.pChips[i];
    const fromBets = Math.trunc(s.meta[Meta.BetsWon] / KEYS.betsPerKey);
    const fromChips = Math.trunc(chips / KEYS.chipsPerKey);
    const fromBosses = KEYS.perBoss * s.meta[Meta.BossesBeaten];

    const lineY = y + 4;
    this.screenLine(
      t('summary.keys.bets', { n: s.meta[Meta.BetsWon], k: fromBets }),
      w,
      lineY,
      PALETTE.hudDim,
      14,
    );
    this.screenLine(
      t('summary.keys.chips', { n: chips, k: fromChips }),
      w,
      lineY + 20,
      PALETTE.hudDim,
      14,
    );
    this.screenLine(
      t('summary.keys.boss', { n: s.meta[Meta.BossesBeaten], k: fromBosses }),
      w,
      lineY + 40,
      PALETTE.hudDim,
      14,
    );
    // Пол в 1 ключ показан отдельной строкой, только когда он реально
    // сработал — иначе разбивка показывала бы «минимум», даже когда сумма
    // источников уже его перекрыла, и строки не сходились бы с Meta.Keys.
    let breakdownY = lineY + 60;
    if (fromBets + fromChips + fromBosses < KEYS.floor) {
      this.screenLine(t('summary.keys.floor'), w, breakdownY, PALETTE.hudDim, 14);
      breakdownY += 20;
    }
    y = breakdownY + 6;

    y = this.screenValue(t('summary.paid'), s.meta[Meta.PaidToAce], w, y, 16, PALETTE.hudDim);

    // «Ещё разок» доминирует на экране итогов — цикл «ещё разок» и есть то,
    // ради чего игра существует (UX §6).
    const c = this.screenCard(w / 2, y + 40, 190, 44, true);
    this.text.push(t('summary.again'), w / 2, y + 40, 24, Face.Ui, c.r, c.g, c.b, 1, 'center');
    this.confirmHint(w, y + 130);
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
   * Текста здесь нет по той же причине, что и на карте: пари читается
   * пиктограммой и цветом рамки, а имя ждёт расчёта.
   */
  private drawBets(
    s: SimState,
    player: number,
    x: number,
    y: number,
    highlightSlot = -1,
  ): void {
    const b = this.batch;
    let cursor = x;
    let n = 0;

    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      const k = player * MAX_ACTIVE_BETS + i;
      const state = s.aState[k] as BetState;
      if (state === BetState.None) continue;

      const spec = BETS[s.aBet[k]];
      const colour = categoryColour(spec.category);
      // Вчетвером колонка игрока — 240 единиц, а сборка — до четырёх пари:
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
      /*
       * Выигранное золотится ОБВОДКОЙ, а не заливкой.
       *
       * Заливка у плашки теперь общая и тёмная, и «золотится» переехало туда,
       * где у неё вообще остался цвет, — в несущую рамку. Категория при этом не
       * теряется: её несёт пиктограмма, которая красится своим цветом всегда, а
       * заодно это единственный способ показать исход, не тратя второй цвет.
       */
      const frame = won ? PALETTE.chip : colour;

      entity(b, Shape.Box, cxs, y, hw, PLAQUE_HALF_H, 0, frame, alpha, 3);

      // Поштучный забор (доступность): выбранная крестовиной плашка обведена
      // вторым, более крупным контуром снаружи — иначе включённая настройка
      // работала бы вслепую, и «Забрать» цепляло бы непонятно что.
      if (i === highlightSlot) {
        const hi = PALETTE.hudText;
        b.push(
          Shape.Box,
          cxs,
          y,
          hw + 5,
          PLAQUE_HALF_H + 5,
          0,
          0,
          0,
          0,
          0,
          2,
          hi.r,
          hi.g,
          hi.b,
          alpha * 0.9,
        );
      }

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
        drawBetIcon(b, s.aBet[k], cxs, y - 9, 9, colour, ENTITY_FILL, alpha);
        drawMultiplier(b, spec.multiplier / FX_ONE, cxs - 14, y + 11, 6, PALETTE.hudText, alpha);
        continue;
      }

      // Верхняя строка: пари, его коэффициент и кон. Всё, что уже решено.
      // Цифры кремовые: поле плашки стало тёмным, и чернила на нём пропадают.
      drawBetIcon(b, s.aBet[k], cxs - 32, y - 11, 9, colour, ENTITY_FILL, alpha);
      drawMultiplier(b, spec.multiplier / FX_ONE, cxs - 17, y - 11, 7.5, PALETTE.hudText, alpha);
      drawNumber(b, s.aStake[k], cxs + 32, y - 11, 7, PALETTE.hudDim, alpha * 0.85);

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
        // Кольцо снова кремовое: плашка стала тёмной, и чернильный глиф на ней
        // пропадал бы ровно так же, как кремовый пропадал на кремовой. Место
        // при этом прежнее — вплотную к тому кушу, про который кнопка говорит.
        const c = PALETTE.hudText;
        b.push(Shape.Ring, cxs - 32, y + 11, 7, 7, 0, 0, 0, 0, 0, 3, c.r, c.g, c.b, alpha * 0.8);
      }
      const value = lost
        ? Math.round((nearMissOf(s, player, i) / FX_ONE) * 100)
        : state === BetState.Active
          ? cashOutValue(s, player, i)
          : Math.trunc((s.aStake[k] * spec.multiplier) / FX_ONE);
      // Куш золотом, сорванное — алым: число на тёмной плашке само называет
      // свою природу, а не берёт цвет у подложки, которой больше нет.
      drawNumber(b, value, cxs + 2, y + 11, 10, lost ? PALETTE.danger : PALETTE.chip, alpha);

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
    /*
     * Затемнение — общее с остальными экранами, а не своё.
     *
     * Своё здесь и было: 0.72 против 0.82 у двери, платы и итогов, — то есть
     * пять экранов забега затемняли бой по-разному, и разница читалась как
     * разное состояние игры. Расчёт верстался раньше остальных, и общего
     * помощника на тот момент не существовало; теперь он есть, и держать
     * четвёртое число незачем.
     */
    this.dim(w, h);

    /*
     * Крупье — ПОВЕРХ затемнения, а не под ним.
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
    this.drawAce(s, fb);

    /*
     * Титул экрана — акцидентной гарнитурой, и это её единственная работа.
     *
     * Ар-деко говорит голосом заведения там, где текст читают не спеша: на
     * титуле, а не в строке HUD. В бою она была бы хуже интерфейсной по
     * единственному критерию, который в бою важен, — скорости опознания.
     */
    this.screenTitle(t('settlement.title'), w, h / 2 - rows * 34 - 46);

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
        // пари должно читаться без счёта строк. Тот же шестиугольник, что и в
        // боевом HUD, и в том же языке — иначе своя метка выглядела бы на
        // расчёте чужой.
        // Левее плашки, а не на её кромке: полуширина строки — ровно 190, и
        // метка стояла под собственным контуром строки.
        entity(b, Shape.Hexagon, w / 2 - 215, y, 10, 10, 0, colour, 1, 3);
        // Строка — та же плашка, что в бою: тёмное поле, рамка цветом
        // категории, у взятого куша — золотая.
        entity(b, Shape.Box, w / 2, y, 190, 26, 0, won ? PALETTE.chip : cat, lost ? 0.4 : 1, 3);
        // Та же пиктограмма, что на карте и на плашке: игрок узнаёт своё пари,
        // а не разгадывает его в третий раз.
        drawBetIcon(b, s.aBet[k], w / 2 - 160, y, 14, cat, ENTITY_FILL, 1);

        /*
         * Имя пари — своей колонкой слева от расписки, а не внутри плашки.
         *
         * Внутри места нет: плашка занята коном, множителем, исходом и
         * выплатой, и втиснутое между ними имя пришлось бы резать многоточием
         * уже в русском, не говоря о немецком с его +40% (GLOSSARY, п. 7).
         * Колонка слева даёт 230 единиц — двадцать восемь знаков кеглем 13 с
         * запасом на перевод, — и читается как графа расписки, чем и является.
         *
         * Приглушённое у сорванного: строка расчёта отвечает на вопрос
         * «сколько», а не «что», и имя не имеет права спорить с выплатой.
         */
        const name = lost ? PALETTE.hudDim : PALETTE.hudText;
        this.text.push(betName(spec.id), w / 2 - 430, y, 13, Face.Ui, name.r, name.g, name.b, 1);

        /*
         * Строка расчёта читается слева направо как расписка: кон, множитель,
         * исход, выплата — и у сорванного отдельно, насколько не хватило.
         *
         * «Выиграно / провалено / обналичено» несёт форма исхода, а не слово,
         * и со шрифтом это не изменилось: заполненный шестиугольник — взял
         * куш, кольцо — соскочил сам, перечёркнутое — сорвал. Ровно те же три
         * формы, что игрок видел на плашке весь бой.
         */
        drawNumber(b, s.aStake[k], w / 2 - 120, y, 11, PALETTE.hudDim);
        drawMultiplier(b, spec.multiplier / FX_ONE, w / 2 - 82, y, 11, PALETTE.hudText);
        this.drawOutcome(state, w / 2 - 8, y);
        // Выплата: у обналиченного и выигранного она разная, и берётся та,
        // что игроку действительно заплатили (снята в момент перехода).
        // Золотом — это фишки, и на тёмной строке им есть где светиться.
        /*
         * У неразрешённого пари выплаты ещё нет, и показывается «Забрать».
         *
         * Пауза между волнами — это тот же экран расчёта, но пари в нём живые:
         * `fb.betPayout` у них ноль, и строка сообщала «выплата 0» рядом с
         * перечёркнутым исходом, то есть объявляла проигранным то, что игрок
         * ещё держит. Число живого пари — его текущий куш, приглушённый: он
         * ещё не в кошельке.
         */
        const active = state === BetState.Active;
        drawNumber(
          b,
          active ? cashOutValue(s, p, i) : fb.betPayout[k],
          w / 2 + 110,
          y,
          18,
          lost || active ? PALETTE.hudDim : PALETTE.chip,
        );

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
    const ring = PALETTE.hudText;
    b.push(
      Shape.Ring,
      w / 2,
      h / 2 + rows * 34 + 46,
      16,
      16,
      0,
      0,
      0,
      0,
      0,
      3,
      ring.r,
      ring.g,
      ring.b,
      0.7,
    );
    drawNumber(b, Math.ceil(left / 60), w / 2, h / 2 + rows * 34 + 46, 14, PALETTE.hudText);

    /*
     * Трамплин — объясняет молчаливое правило симуляции: провал обязывает
     * следующий стол содержать лёгкое пари ×1.5 (ECONOMY §10, GDD §11).
     *
     * Только для Obligation.LegUp, а не Forced: принудительное пари торга
     * занимает тот же слот меты и сильнее трамплина (floor.ts:210-213), и у
     * него уже есть собственный экран (house/haggle) — здесь эти подписи
     * взаимоисключающие, дублировать вторую нельзя.
     *
     * Ниже кольца обратного отсчёта, а не рядом: строки пари занимают всё до
     * h/2 + rows*34, само кольцо стоит на h/2 + rows*34 + 46, и подпись под
     * ним на +46 больше не задевает ни ряды, ни число в кольце.
     */
    if ((s.meta[Meta.LegUp] as Obligation) === Obligation.LegUp) {
      this.screenLine(t('settlement.legup'), w, h / 2 + rows * 34 + 92, PALETTE.accent, 14);
    }
  }

  /**
   * Ставка Крупье: он выложил свою карту и ставит против игрока (GDD §12А.1).
   *
   * Решение принимается ЭКРАНОМ, не подбором с пола, — `bets.ts` прямо
   * исключает эту карту из `drawCards` с комментарием «её показывает свой
   * экран». Раньше этого экрана не было вовсе: `Confirm`/`Cancel` уже читались
   * ядром (`acceptAceBet`/`declineAceBet` в `sim.ts`) и бесшумно решали за
   * игрока судьбу четверти его кошелька — нажатие Enter в паузе перед первой
   * волной могло принять или отклонить пари, о существовании которого игрок
   * не подозревал.
   *
   * Кон — свой у каждого игрока (`aceStakeFor`), поэтому называется кон
   * ЛОКАЛЬНОГО игрока: это тот, кому кнопка в руках прямо сейчас, и число
   * обязано отвечать на его собственный вопрос «сколько я поставлю», а не на
   * средний по столу.
   */
  private drawAceBetScreen(s: SimState, w: number, h: number, fb: Feedback): void {
    const card = aceCardAt(s);
    if (card < 0) return;

    this.dim(w, h);
    // Крупье — поверх затемнения, тем же приёмом, что и на расчёте: под 0.82
    // затемнения его 0.85 непрозрачности превращаются в четверть и он снова
    // становится незаметен — ровно то событие, ради которого экран и открыт.
    this.drawAce(s, fb);

    this.screenTitle(t('ace_bet.title'), w, h / 2 - 150);
    this.wrapped(t('ace_bet.desc'), w / 2, h / 2 - 96, 620, 15, PALETTE.hudDim);

    const stake = aceStakeFor(s, 0);
    this.screenValue(t('ace_bet.stake'), stake, w, h / 2 - 40, 26, PALETTE.danger);
    drawMultiplier(this.batch, BETS[s.kBet[card]].multiplier / FX_ONE, w / 2 + 70, h / 2 + 10, 13, PALETTE.danger);

    this.confirmHint(w, h / 2 + 70);
    this.cancelHint(w, h / 2 + 96);
  }

  /**
   * Исход пари формой: выиграно, обналичено, провалено.
   *
   * Формой, а не словом: три исхода различаются мгновенно и на любом языке, а
   * пять секунд расчёта — это не то время, за которое читают три подписи
   * подряд. Шрифт этого не отменил, он лишь снял оправдание.
   */
  private drawOutcome(state: BetState, x: number, y: number): void {
    const b = this.batch;
    if (state === BetState.Won) {
      // Шестиугольник с ядром против пустого кольца обналиченного: исход
      // по-прежнему различается ФОРМОЙ, а не только цветом, — заливка у обоих
      // теперь общая, и разница «полный / пустой» держится на ядре.
      const c = PALETTE.chip;
      entity(b, Shape.Hexagon, x, y, 11, 11, 0, c, 1, 3);
      b.push(Shape.Hexagon, x, y, 4.5, 4.5, 0, c.r, c.g, c.b, 1, 0, 0, 0, 0, 0);
      return;
    }
    if (state === BetState.Cashed) {
      // Соскочил сам: кольцо, а не полная фигура — куш взят не весь.
      const c = PALETTE.chip;
      b.push(Shape.Ring, x, y, 11, 11, 0, 0, 0, 0, 0, 4, c.r, c.g, c.b, 1);
      return;
    }
    if (state === BetState.Active) {
      /*
       * Пари ещё в игре — пустой шестиугольник приглушённым.
       *
       * Раньше сюда проваливалось всё, кроме выигранного и обналиченного, и
       * живое пари на паузе между волнами рисовалось ПЕРЕЧЁРКНУТЫМ: экран
       * объявлял проигранным то, что игрок держит и может забрать. Форма та
       * же, что у сердца и у выигрыша, но без ядра — «решится позже».
       */
      const c = PALETTE.hudDim;
      entity(b, Shape.Hexagon, x, y, 11, 11, 0, c, 0.8, 3);
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

/**
 * Сколько фишек у стола всего.
 *
 * Плата и цены в лавке считаются от общего кошелька: доля заведения общая, а
 * кошельки раздельные (GDD §14). Одна функция на оба экрана — иначе они
 * разошлись бы в первой же правке состава.
 */
function walletOf(s: SimState): number {
  let total = 0;
  for (let i = 0; i < s.playerCount; i++) total += s.pChips[i];
  return total;
}

/**
 * Что заведение даёт за апгрейд в торге: половина цены ТЕКУЩЕГО этажа.
 *
 * Ни одного числа здесь не своего: цена считается той же `priceOf`, по которой
 * живёт прилавок, доля выкупа берётся из `HOUSE.buybackPct`, а этаж — из
 * состояния. Половина «средней цены» была бы враньём ровно в ту сторону, в
 * которую игроку больно: базы у шести апгрейдов разные именно затем, чтобы
 * одинаковых ценников не было (ECONOMY §5).
 *
 * Берётся САМЫЙ ДОРОГОЙ апгрейд стола. Причина не в щедрости: торг закрывает
 * недостачу целиком (ECONOMY §10), и выкуп, названный по самому дешёвому,
 * обещал бы игроку сделку, которой не хватает на саму сделку, — тот же дефект,
 * из-за которого кон принудительного пари равен недостаче, а не тиру аппетита.
 *
 * Ноль означает «продавать нечего», и карточка на экране гаснет.
 */
function buybackOf(s: SimState): number {
  const floor = s.meta[Meta.Floor];
  let best = 0;
  for (let p = 0; p < s.playerCount; p++) {
    for (let i = 0; i < MAX_UPGRADE_SLOTS; i++) {
      const held = s.pUpgrades[p * MAX_UPGRADE_SLOTS + i];
      if (held === 0) continue;
      const paid = Math.trunc((priceOf(UPGRADES[held - 1].base, floor) * HOUSE.buybackPct) / 100);
      if (paid > best) best = paid;
    }
  }
  return best;
}

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

/** Цвет категории пари: живёт во внутренней рамке, иконке и луче, но не в силуэте. */
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
 * `back` — цвет поля, на котором рисуют: им прорезается перечёркивание, иначе
 * запретительная черта тонет в самом глифе. С 0.4.0 это общая тёмная заливка
 * везде, где иконка живёт, — на карте, на плашке и в строке расчёта.
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

/**
 * Имя пари из словаря по идентификатору каталога.
 *
 * `name` в `content/bets.json` служебный: он живёт в отчётах балансировщика и
 * в сценариях и не переводится. На экран идёт `bet.<id>.name` из словаря —
 * иначе английская сборка показывала бы русское условие.
 *
 * Приведение ключа безопасно и проверено не здесь: генератор контента валит
 * сборку, если у пари из каталога нет строки, а у строки — пари (`npm run
 * check:content`). Держать тот же список ещё и типом значило бы дублировать
 * данные ради приведения, которого всё равно не избежать.
 */
const betName = (id: string): string => t(`bet.${id}.name` as StringKey);

/**
 * Имя апгрейда из словаря по идентификатору каталога.
 *
 * Ровно та же причина, что у `betName`: `name` в `content/upgrades.json`
 * служебный и не переводится, а на витрину идёт `upgrade.<id>.name`. Паритет
 * ключа и каталога держит генератор контента, а не это приведение.
 */
const upgradeName = (index: number): string =>
  t(`upgrade.${String(UPGRADES[index].id)}.name` as StringKey);

/**
 * Имя типа двери из словаря.
 *
 * Таблицей, а не вычисляемым ключом: типов шесть, они перечислением, и
 * `door.type.${DoorType[i]}` потребовал бы держать в сборке объект
 * перечисления ради шести строк. Заодно опечатка в ключе ловится линтером
 * словаря, а не пустой надписью на экране.
 */
const DOOR_NAME: Readonly<Record<DoorType, StringKey>> = {
  [DoorType.Fight]: 'door.type.fight',
  [DoorType.Fat]: 'door.type.fat',
  [DoorType.Shop]: 'door.type.shop',
  [DoorType.Gift]: 'door.type.gift',
  [DoorType.Event]: 'door.type.event',
  [DoorType.DebtPit]: 'door.type.pit',
};

const doorTypeName = (type: DoorType): string => t(DOOR_NAME[type]);

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
 * Цифры остались палочками и после того, как в игру приехал шрифт. Причина не
 * в экономии: семисегментное табло — это язык самого заведения, оно читается с
 * дивана на любом кегле и не зависит ни от языка, ни от гарнитуры, включая
 * шрифт для дислексии (UX §5). Семь отрезков — семь инстансов на цифру, тот же
 * батч и ни одной выборки из атласа в горячем HUD.
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
  // Крестик «×»: два отрезка, а не глиф — множитель стоит рядом с
  // семисегментными цифрами и обязан быть их роста, а не роста гарнитуры.
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

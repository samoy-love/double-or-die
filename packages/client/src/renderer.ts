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
  aceCardAt,
  InputScheme,
  MAX_BULLETS,
  MAX_ENEMIES,
  MAX_PLAYERS,
  Meta,
  RunPhase,
  type SimState,
  toFloat,
} from '@dod/sim';
import type { Feedback } from './feedback';
import type { Feel } from './feel';
import { Shape, ShapeBatch } from './gl/batch';
import { Face, TextAtlas } from './gl/text';
import { charset, t } from './i18n';
import { PALETTE, type Rgb } from './palette';
import { lineStep, SCREEN, TEXT } from './typography';
import type { Particles } from './particles';
import { entity, glow, drawNumber } from './gl/primitives';
import { settlementRows } from './screens/betHelpers';
import {
  drawMenuScreen,
  drawPauseScreen,
  drawSettingsScreen,
  drawTutorialScreen,
} from './screens/menu';
import {
  drawDoorScreen,
  drawShopScreen,
  drawHouseCutScreen,
  drawSummaryScreen,
} from './screens/run';
import {
  drawFloor,
  drawWheel,
  drawBoss,
  drawCards,
  drawSpawnMarks,
  drawTelegraphs,
  drawChips,
  drawEnemies,
  drawPlayers,
  drawDeals,
  drawBullets,
  drawParticles,
  drawScreenEffects,
} from './screens/arena';
import { drawHud, drawCoach } from './screens/hud';
import { drawAce } from './screens/ace';

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
  /** Открыта вторая страница справки — управление. */
  tutorialControls: boolean;
  /** Какой пункт настроек в фокусе. */
  settingsFocus: number;
  /** Масштаб интерфейса в процентах — показывается самим пунктом. */
  uiScale: number;
  /** Забег идёт, но часы остановлены: поверх кадра стоит экран паузы. */
  paused: boolean;
  /** Пункт паузы в фокусе: 0 — «Продолжить», 1 — «Настройки», 2 — «Как играть». */
  pauseFocus: 0 | 1 | 2;
}

const DEFAULT_MENU_OVERLAY: MenuOverlay = {
  tutorial: false,
  settingsOpen: false,
  focus: 0,
  cashOutFocusedOnly: false,
  tutorialControls: false,
  settingsFocus: 0,
  uiScale: 100,
  paused: false,
  pauseFocus: 0,
};

/**
 * Общий набор примитивов раскладки экрана, доступный вынесенным функциям
 * `drawX(kit, …)` (`screens/*.ts`) без доступа к остальному состоянию
 * `Renderer` (батчу, тексту, кадру арены).
 *
 * `uiScale` в наборе нет полем: он мутируется по ходу отрисовки экрана
 * (масштаб зажимается тем, что влезает, и возвращается назад), и открытое
 * поле дало бы вызывающему забыть restore. Единственный доступ —
 * `getUiScale()` для чтения и `withUiScale(scale, fn)` для временной подмены
 * на время `fn`.
 */
export interface RenderKit {
  dim(w: number, h: number): void;
  sx(x: number): number;
  sy(y: number): number;
  sz(v: number): number;
  fitScale(blockW: number, blockH: number): number;
  hintsTop(lines: number): number;
  beginScreen(halfW: number, top: number, bottom: number): number;
  screenBase(w: number, h: number, tint: Rgb): void;
  hudLine(text: string, cx: number, y: number, colour?: Rgb, size?: number, alpha?: number): void;
  screenTitle(text: string, w: number, y: number, size?: number): void;
  screenLine(text: string, w: number, y: number, colour?: Rgb, size?: number, alpha?: number): void;
  screenValue(
    label: string,
    value: number,
    w: number,
    y: number,
    size: number,
    colour: Rgb,
    labelColour?: Rgb,
  ): number;
  confirmHint(w: number, y: number): void;
  selectHint(w: number, y: number): void;
  menuHint(w: number, y: number): void;
  cancelHint(w: number, y: number): void;
  wrapLines(text: string, maxW: number, size: number): string[];
  wrapped(
    text: string,
    x: number,
    y: number,
    maxW: number,
    sizeIn: number,
    colour: Rgb,
    alphaIn?: number,
  ): void;
  wrappedTop(
    text: string,
    x: number,
    y: number,
    maxW: number,
    sizeIn: number,
    colour: Rgb,
    alphaIn?: number,
  ): void;
  label(
    text: string,
    x: number,
    y: number,
    size: number,
    c: Rgb,
    align?: 'left' | 'center' | 'right',
    alpha?: number,
  ): void;
  screenCard(
    x: number,
    y: number,
    halfW: number,
    halfH: number,
    focused: boolean,
    available?: boolean,
  ): Rgb;
  priceTag(value: number, x: number, y: number, size: number, colour: Rgb): void;
  getUiScale(): number;
  withUiScale<T>(scale: number, fn: () => T): T;
  /** Схема ввода прямо сейчас — экраны меню называют физическую кнопку. */
  scheme: InputScheme;
}

export class Renderer implements RenderKit {
  private readonly gl: WebGL2RenderingContext;
  /**
   * Батч фигур и атлас текста — публичные, а не через `RenderKit`.
   *
   * `RenderKit` — контракт РАСКЛАДКИ экрана (кегли, координаты, карточки), а
   * не доступ к самому рисованию: часть вынесенных экранов (`screens/run.ts`
   * и далее `screens/arena.ts`) читает `batch`/`text` напрямую — так же, как
   * до переноса читала `this.batch`/`this.text`, — и заводить ради этого
   * второй параллельный интерфейс не с руки. Такие функции принимают не
   * `RenderKit`, а сам `Renderer`.
   */
  readonly batch: ShapeBatch;
  /** Буквы кадра. Пустой до того, как приедет шрифт, — и это рабочее состояние. */
  readonly text: TextAtlas;
  /**
   * Снимки прошлого кадра и служебные состояния сглаживания — публичные, не
   * через `RenderKit`: `screens/arena.ts` читает и пишет их напрямую, как и
   * раньше читала/писала `this.…` до переноса (см. комментарий у `batch`).
   */
  readonly prevX = new Float64Array(MAX_PLAYERS);
  readonly prevY = new Float64Array(MAX_PLAYERS);
  readonly prevEX = new Float64Array(MAX_ENEMIES);
  readonly prevEY = new Float64Array(MAX_ENEMIES);
  /**
   * Последний осмысленный угол поворота врага (playtest: «вибрируют, быстро
   * крутятся, стоя на месте»). `atan2` от скорости честен, но скорость около
   * нуля — это в основном шум фиксированной точки, а не направление: враг,
   * который почти не движется, каждый тик получал новый случайный угол.
   * Обновляем угол, только когда скорость выше шума, а на медленных кадрах
   * держим прежний — крутится тело, только когда реально куда-то едет.
   */
  readonly enemyFacing = new Float64Array(MAX_ENEMIES);
  readonly prevBX = new Float64Array(MAX_BULLETS);
  readonly prevBY = new Float64Array(MAX_BULLETS);
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
  readonly seenEnemy = new Uint8Array(MAX_ENEMIES);
  readonly seenBullet = new Uint8Array(MAX_BULLETS);
  seenPlayers = false;

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
   * Без `preserveDrawingBuffer` буфер после показа принадлежит композитору, и
   * сторонний `getContext` снаружи получает контекст, который считает себя
   * потерянным, а размер буфера — нулевым. Тест, читающий кадр снаружи,
   * ловил бы не регрессию, а гонку с композитором.
   *
   * Сетка, а не пиксели: эталон обязан пережить смену растеризатора —
   * SwiftShader на раннере против настоящей видеокарты на машине, — а средние
   * по клетке переживают разницу сглаживания и не переживают пропавший слой,
   * уехавшую камеру или сбитую палитру.
   */
  frameGrid(draw: () => void, cols: number, rows: number): number[][] {
    const { px, w, h } = this.readFrame(draw);

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

  /**
   * Кадр целиком, картинкой в data-URL. Только для отладочного интерфейса.
   *
   * Сетка средних цветов ловит пропавший слой и сбитую палитру, но о
   * ТИПОГРАФИКЕ не говорит ничего: подпись кеглем 24 занимает в сетке 16×9
   * долю клетки. Проверить глазами, влезла ли строка в карточку и не налезла
   * ли подпись на число, можно только по картинке — а снаружи канвас
   * читается пустым ровно по той причине, что описана у `readFrame`.
   *
   * Кодируется канвасом 2D, а не вручную: PNG нужен один раз на прогон, и
   * своя реализация сжатия здесь была бы кодом без второго читателя.
   */
  framePng(draw: () => void): string {
    const { px, w, h } = this.readFrame(draw);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('снимок кадра: нет контекста 2D');
    const img = ctx.createImageData(w, h);
    // WebGL читает снизу вверх, картинка кладётся сверху вниз: переворот
    // построчный, а не попиксельный — строка копируется целиком.
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      img.data.set(px.subarray(src, src + w * 4), y * w * 4);
    }
    ctx.putImageData(img, 0, 0);
    return out.toDataURL('image/png');
  }

  /** Пиксели кадра из своего буфера — общее тело снимка и сетки. */
  private readFrame(draw: () => void): { px: Uint8Array; w: number; h: number } {
    const gl = this.gl;
    /*
     * Размер берётся у канваса, а не у буфера отрисовки.
     *
     * `drawingBufferWidth` до первого показанного кадра равен нулю — а
     * снимок как раз и снимают на паузе, когда кадров
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
     * Экранный после показа принадлежит композитору: контекст без
     * `preserveDrawingBuffer`, поэтому его содержимое сразу после кадра
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

    return { px, w, h };
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
    // Экранная раскладка считает центр и кромки от НАСТОЯЩЕЙ арены кадра, а
    // не от вписанных 1920×1080: вчетвером она на 24% больше.
    this.arenaW = arenaW;
    this.arenaH = arenaH;

    const bg = PALETTE.background;
    gl.clearColor(bg.r, bg.g, bg.b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    batch.begin();
    this.dimmed = false;
    drawFloor(this, arenaW, arenaH, s);
    drawWheel(this, s);
    drawCards(this, s);
    // На расчёте и на своём предложении пари Крупье рисуется не здесь, а поверх
    // затемнения (`drawSettlement`, `drawAceBetScreen`): под ним от него
    // остаётся четверть непрозрачности и ничего больше.
    if (settlementRows(s) === 0 && aceCardAt(s) < 0) drawAce(this, s, fb);
    drawSpawnMarks(this, s);
    drawTelegraphs(this, s, alpha);
    drawChips(this, s);
    drawEnemies(this, s, alpha, fb);
    drawBoss(this, s);
    drawPlayers(this, s, alpha, fb);
    /*
     * Карта под ногами — ПОВЕРХ игрока, вторым проходом.
     *
     * Желешка рисуется после карт и закрывает собой ту, на которой стоит:
     * ровно в момент решения «брать или нет» от карты оставались края
     * контура, а пиктограмма, множитель и цена пропадали. Второй проход
     * рисует только подсвеченную карту — одну на игрока, а не весь стол.
     */
    drawCards(this, s, true);
    drawDeals(this, s, fb);
    drawBullets(this, s, alpha);
    drawParticles(this, particles);
    /*
     * Боевой HUD — только в забеге.
     *
     * В меню он показывал сердца, кошелёк и номер комнаты забега, который ещё
     * не начался: «пока меню на экране, забег не идёт» (UX §6) — а угол экрана
     * утверждал обратное.
     */
    /*
     * Справка и настройки закрывают собой ВСЁ, включая экраны забега.
     *
     * Они открываются с паузы, а пауза застаёт игру на любом экране — и
     * первым же снимком это показало: справка легла поверх итогов, и два
     * набора карточек с двумя титулами оказались в одном кадре. Экран в
     * кадре ровно один, и это правило не знает исключений.
     */
    const overlayScreen = menuOverlay.tutorial || menuOverlay.settingsOpen;
    if (!menu && !overlayScreen) {
      drawHud(this, s, arenaW, arenaH, fb, menuOverlay.cashOutFocusedOnly ? cashOutTarget : -1);
      // Ставка Крупье и Расчёт — тоже экраны забега, и на них у подсказки
      // обучения нет места: решение принимается на самом экране, у него свои
      // подписи («Q — отказаться» и т.п.), а не на подсказке из угла.
      if (settlementRows(s) === 0 && aceCardAt(s) < 0) {
        drawCoach(this, this.coachText, arenaW, arenaH);
      }
    }
    // Меню — поверх всего, включая экраны забега: пока оно на экране, забег
    // не идёт вовсе, и любая надпись из-под него говорила бы об обратном.
    /*
     * Дочерний экран ЗАМЕНЯЕТ меню, а не ложится поверх него.
     *
     * Поверх — это две пары надписей в одном кадре: сквозь «Настройки»
     * читались титул меню и его подсказка «Enter/Space или клик — играть»,
     * прямо противоречащая собственной подсказке экрана. Плюс второе
     * затемнение поверх первого (0.82 × 0.82) — арена под ними уходила
     * в чёрное.
     */
    /*
     * Дочерний экран ЗАМЕНЯЕТ родительский, а не ложится поверх, и порядок
     * один и тот же в меню и на паузе: справка и настройки открываются из
     * обоих, и вести себя обязаны одинаково.
     */
    if (menuOverlay.tutorial) drawTutorialScreen(this, arenaW, arenaH, menuOverlay);
    else if (menuOverlay.settingsOpen) drawSettingsScreen(this, arenaW, arenaH, menuOverlay);
    else if (menu) drawMenuScreen(this, arenaW, arenaH, menuOverlay);
    else if (menuOverlay.paused) drawPauseScreen(this, arenaW, arenaH, menuOverlay);
    drawScreenEffects(this, feel, arenaW, arenaH);

    /*
     * contain, не cover: на Steam Deck (1280×800 = 8:5) арена 16:9 либо
     * обрезается по бокам (cover), либо оставляет чёрные поля сверху/снизу
     * (contain) — третьего не бывает, большего вертикального поля у игры нет
     * (`arenaH` — часть симуляции, не экрана). Пробовали cover: он визуально
     * «приближает» арену (масштаб растёт с 0.667 до 0.74) и обрезает игровое
     * поле по бокам — решение владельца было вернуть чёрные поля обратно.
     * `edgeSafeX` (HUD) от этого не страдает — при `contain` обрезки нет
     * вовсе, а он просто держит чуть больший отступ от кромки, чем раньше.
     */
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
  /**
   * Публичный, а не через `RenderKit`: расчёт и Ставка Крупье (`screens/run.ts`)
   * рисуют его поверх своего затемнения тем же приёмом, что и раньше, когда
   * оба были методами этого класса. `RenderKit` — контракт раскладки, а не
   * список всего, что класс умеет рисовать (см. комментарий у `batch`).
   */
  // -------------------------------------------------------------------------
  // HUD и экранные эффекты
  // -------------------------------------------------------------------------

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
  drawRunScreens(s: SimState, w: number, h: number, fb: Feedback): void {
    const phase = s.meta[Meta.Phase] as RunPhase;
    if (phase === RunPhase.Door) drawDoorScreen(this, s, w, h);
    else if (phase === RunPhase.Reward) drawShopScreen(this, s, w, h);
    else if (phase === RunPhase.HouseCut) drawHouseCutScreen(this, s, w, h);
    else if (phase === RunPhase.Summary) drawSummaryScreen(this, s, w, h, fb);
  }

  /**
   * Затемнение под экраном: бой виден, но не спорит за внимание.
   *
   * Ровно ОДНО за кадр. Экраны накладывались (расчёт под Ставкой Крупье,
   * меню под настройками), и два затемнения по 0.82 давали 0.968 — фон уходил
   * в чёрное, а оба экрана при этом специально рисуют Крупье поверх
   * затемнения, чтобы он был виден. Флаг сбрасывается в начале кадра.
   */
  private dimmed = false;

  dim(w: number, h: number): void {
    if (this.dimmed) return;
    this.dimmed = true;
    const c = PALETTE.background;
    this.batch.push(Shape.Box, w / 2, h / 2, w / 2, h / 2, 0, c.r, c.g, c.b, 0.82, 0, 0, 0, 0, 0);
  }

  /**
   * Масштаб интерфейса, 1.0–1.5 (UX §5).
   *
   * Умножает и кегли, и габариты карточек, и вертикальные отступы от центра
   * экрана: масштабировать один кегль бессмысленно — текст вылезет из
   * карточки, которая осталась прежней. Горизонталь тоже считается от
   * центра, поэтому ряд из трёх карточек расходится симметрично.
   *
   * Живёт в рендере, а не в шкале `TEXT`: шкала — это решение о том, какими
   * бывают кегли, а масштаб — настройка игрока поверх неё.
   */
  private uiScale = 1;

  /** Текущий масштаб интерфейса — только для чтения снаружи. */
  getUiScale(): number {
    return this.uiScale;
  }

  /** Настройка масштаба интерфейса из сейва (`loop.ts`): сейв — источник, рендер — потребитель. */
  setUiScale(scale: number): void {
    this.uiScale = scale;
  }

  /**
   * Временная подмена масштаба интерфейса на время `fn`: save → set → `fn()`
   * → restore, восстановление гарантировано даже если `fn` бросит исключение.
   *
   * Заменяет ручной паттерн `const saved = this.uiScale; this.uiScale = …;
   * … ; this.uiScale = saved;`, в котором забытый последний шаг протекает на
   * следующий экран того же кадра.
   */
  withUiScale<T>(scale: number, fn: () => T): T {
    const saved = this.uiScale;
    this.uiScale = scale;
    try {
      return fn();
    } finally {
      this.uiScale = saved;
    }
  }

  /** Текст текущего урока обучения; пустая строка — урока нет (`coach.ts`). */
  coachText = '';

  /**
   * Размер арены текущего кадра — база всей экранной раскладки.
   *
   * Арена соло ровно 1920×1080, но вчетвером она на 24% больше
   * (`arenaWidth`), а масштаб интерфейса разводит содержимое ОТ ЦЕНТРА. Пока
   * центр был вписан числом (`sy(y, 1080)`), экран в коопе считал свой центр
   * на сотню единиц выше настоящего — и весь ряд смещался тем сильнее, чем
   * крупнее интерфейс.
   */
  private arenaW = 1920;
  private arenaH = 1080;

  /** Кегль/габарит с учётом масштаба. */
  sz(v: number): number {
    return v * this.uiScale;
  }

  /** Координата с учётом масштаба: расходится от центра арены. */
  sy(y: number): number {
    return this.arenaH / 2 + (y - this.arenaH / 2) * this.uiScale;
  }

  sx(x: number): number {
    return this.arenaW / 2 + (x - this.arenaW / 2) * this.uiScale;
  }

  /**
   * Масштаб, при котором блок `blockW`×`blockH` помещается на арене целиком.
   *
   * Масштаб интерфейса разводит содержимое от центра, и на плотном экране это
   * значит «за край»: справка при 150% теряла крайние столбцы сетки и обе
   * нижние подсказки — текст был не мелким, а отрезанным. Отрезанный текст
   * хуже неувеличенного, поэтому увеличение зажимается тем, что влезает.
   *
   * Снизу зажато единицей: ниже 100% уезжает кегль, а порог «не мельче 24 px»
   * (UX §4) не смягчается ради вёрстки. Блок считается в единицах арены до
   * масштаба.
   */
  fitScale(blockW: number, blockH: number): number {
    const fit = Math.min(this.arenaW / blockW, this.arenaH / blockH);
    return Math.max(1, Math.min(this.uiScale, fit));
  }

  /**
   * Нижняя граница экрана: где стоит ПЕРВАЯ строка блока подсказок.
   *
   * UX §4: «блок подсказок прижат к нижней кромке с отступом 96 единиц, а
   * тело экрана считает раскладку от него, а не от центра». Раньше подсказки
   * стояли на `h / 2 + 360`, то есть тело росло вниз и выдавливало их за
   * кадр: на 1280×800 у двери и лавки пропадала строка «Enter/Tab —
   * подтвердить» — единственное указание, как выйти с экрана необратимого
   * выбора.
   */
  hintsTop(lines: number): number {
    return this.arenaH - 96 - (lines - 1) * SCREEN.hintStep;
  }

  /**
   * Взять экран в рамку: зажать масштаб тем, что влезает, и вернуть прежний.
   *
   * Одна причина на восемь дефектов раскладки. Масштаб интерфейса (100–150%,
   * UX §5) разводит содержимое от центра арены, поэтому у КАЖДОГО экрана есть
   * потолок увеличения, за которым его края уходят за кадр, — и потолок этот
   * свой, потому что содержимое разное. Справка его считала, остальные шесть
   * экранов нет, и при 150% с них уезжали то баннер встречной ставки, то
   * нижние подсказки, то крайние карточки ряда.
   *
   * Правило записано в UX §5 («экран, которому 150% не хватает по ширине или
   * высоте, увеличивается ровно настолько, насколько влезает целиком, и не
   * ниже 100%») и здесь просто применено ко всем экранам разом.
   *
   * `halfW` — полуширина самого широкого ряда, `top`/`bottom` — верх и низ
   * содержимого в единицах арены ДО масштаба. Возвращает прежний масштаб:
   * вызывающий обязан вернуть его в конце (`this.uiScale = saved`), иначе
   * зажатие протечёт на следующий экран того же кадра.
   */
  beginScreen(halfW: number, top: number, bottom: number): number {
    const saved = this.uiScale;
    const cx = this.arenaW / 2;
    const cy = this.arenaH / 2;
    const reachX = Math.max(1, halfW);
    const reachY = Math.max(1, cy - top, bottom - cy);
    this.uiScale = Math.max(1, Math.min(saved, cx / reachX, cy / reachY));
    return saved;
  }

  /**
   * Непрозрачная подложка экрана забега (UX §4).
   *
   * Затемнения мало: сквозь дверь, лавку, расчёт и итоги читались колонны,
   * карты пари и их лучи, а подписи ложились прямо на них — контраст строки
   * зависел от того, где в комнате лежала карта. Подложка глухая, и поверх
   * неё лежит мягкий радиальный градиент своего оттенка: он даёт экрану
   * собственное «место», не отнимая контраста у текста.
   *
   * Градиент собран кольцами, а не одной фигурой, по той же причине, что и
   * виньетка пола (`drawFloor`): один толстый слой даёт полосу с резким
   * краем, много тонких — плавность.
   */
  screenBase(w: number, h: number, tint: Rgb): void {
    const b = this.batch;
    const bg = PALETTE.background;
    this.dimmed = true;
    b.push(Shape.Box, w / 2, h / 2, w / 2, h / 2, 0, bg.r, bg.g, bg.b, 1, 0, 0, 0, 0, 0);
    const rings = 5;
    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1);
      b.push(
        Shape.Box,
        w / 2,
        h / 2,
        (w / 2) * (0.18 + 0.82 * t),
        (h / 2) * (0.18 + 0.82 * t),
        0,
        tint.r,
        tint.g,
        tint.b,
        0.05 * (1 - t),
        0,
        0,
        0,
        0,
        0,
      );
    }
  }

  /**
   * Строка боевого HUD по центру: координаты арены, без масштаба интерфейса.
   *
   * HUD прижат к кромкам арены, а масштаб интерфейса разводит содержимое от
   * центра — то есть уводит прижатое к краю ЗА край. Экранные строки
   * (`screenLine`) масштаб знать обязаны, боевые — нет, и путать эти две
   * системы координат нельзя: ровно так пропадал баннер встречной ставки.
   */
  hudLine(
    text: string,
    cx: number,
    y: number,
    colour = PALETTE.hudDim,
    size: number = TEXT.body,
    alpha = 0.9,
  ): void {
    this.text.push(
      text,
      cx,
      y,
      Math.max(TEXT.MIN, size),
      Face.Ui,
      colour.r,
      colour.g,
      colour.b,
      Math.max(0.85, alpha),
      'center',
    );
  }

  screenTitle(text: string, w: number, y: number, size: number = TEXT.title): void {
    const c = PALETTE.hudText;
    this.text.push(
      text,
      w / 2,
      this.sy(y),
      this.sz(size),
      Face.Display,
      c.r,
      c.g,
      c.b,
      0.95,
      'center',
    );
  }

  /**
   * Строка экрана: тело шкалы и не меньше.
   *
   * Альфа снизу зажата 0.85 намеренно. Приглушённый текст красится `hudDim`
   * (`#8a7fa8`), и умноженный на 0.6 он давал около 2.5:1 к фону — ниже
   * порога даже для крупного кегля. Приглушать роль надо цветом, а не
   * растворением: растворённая подпись не «менее важная», а нечитаемая.
   */
  screenLine(
    text: string,
    w: number,
    y: number,
    colour = PALETTE.hudDim,
    size: number = TEXT.body,
    alpha = 0.9,
  ): void {
    this.text.push(
      text,
      w / 2,
      this.sy(y),
      this.sz(Math.max(TEXT.MIN, size)),
      Face.Ui,
      colour.r,
      colour.g,
      colour.b,
      Math.max(0.85, alpha),
      'center',
    );
  }

  /**
   * Строка «подпись и число под ней». Возвращает `y` следующей свободной строки.
   *
   * Шаг считается, а не подбирается на глаз, и это не педантизм: `drawNumber`
   * меряет цифру ПОЛУВЫСОТОЙ, то есть число кеглем 30 занимает шестьдесят
   * единиц. Разложенные по «примерно сорока», подписи налезали на цифры на
   * трёх экранах сразу — «Доля заведения» читалась поверх самой доли.
   */
  screenValue(
    label: string,
    value: number,
    w: number,
    y: number,
    size: number,
    colour: Rgb,
    labelColour = PALETTE.hudDim,
  ): number {
    this.screenLine(label, w, y, labelColour);
    // Зазор от кегля подписи, а не константой: подпись выросла до тела шкалы
    // (24), и прежние 18 клали её нижние выносные на верхние сегменты числа.
    drawNumber(this.batch, value, w / 2, this.sy(y + size + TEXT.body), this.sz(size), colour);
    return y + size * 2 + TEXT.body + 32;
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
  confirmHint(w: number, y: number): void {
    const pad = this.scheme === InputScheme.Gamepad;
    this.screenLine(pad ? t('screen.confirm.pad') : t('screen.confirm.key'), w, y, PALETTE.hudDim);
  }

  /**
   * Подпись «чем выбирают» — на экранах с курсором.
   *
   * Подтверждение было названо, а сам выбор — нет, и на экране двери это
   * оставляло тупик: `DoorPick` стартует с −1, то есть «ничего не выбрано», и
   * подтверждение в этом состоянии молча не делает ничего. Игрок жмёт
   * названную кнопку, ничего не происходит, и следующий вывод — «игра
   * зависла».
   */
  selectHint(w: number, y: number): void {
    const pad = this.scheme === InputScheme.Gamepad;
    this.screenLine(pad ? t('screen.select.pad') : t('screen.select.key'), w, y, PALETTE.hudDim);
  }

  /** Выход в меню: отдельный смысл отказа, и называется он своими словами. */
  menuHint(w: number, y: number): void {
    const pad = this.scheme === InputScheme.Gamepad;
    this.screenLine(pad ? t('screen.menu.pad') : t('screen.menu.key'), w, y, PALETTE.hudDim);
  }

  /** То же для отказа: на экранах, где отказ — это отдельный выход, а не «назад». */
  cancelHint(w: number, y: number): void {
    const pad = this.scheme === InputScheme.Gamepad;
    this.screenLine(pad ? t('screen.cancel.pad') : t('screen.cancel.key'), w, y, PALETTE.hudDim);
  }

  /**
   * Разбивка текста по словам в заданную ширину — БЕЗ рисования.
   *
   * Отдельно от `wrapped` потому, что раскладка обязана знать высоту текста
   * ДО того, как он нарисован: экран справки считает высоту карточки по числу
   * строк описания, а не по числу, подобранному на глаз под русский язык.
   * Ширина глифов линейна по кеглю, поэтому мерить можно в любых единицах —
   * важно лишь, чтобы кегль и ширина были в одних и тех же.
   */
  wrapLines(text: string, maxW: number, size: number): string[] {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(' ')) {
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
    return lines;
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
  wrapped(
    text: string,
    x: number,
    y: number,
    maxW: number,
    sizeIn: number,
    colour: Rgb,
    alphaIn = 0.95,
  ): void {
    // Тот же гейт, что и у `screenLine`: кегль не ниже порога UX §4, альфа не
    // ниже читаемой. Переносится тело текста, и «помельче, чтобы влезло» —
    // это не решение вёрстки, а отказ от неё.
    const size = this.sz(Math.max(TEXT.MIN, sizeIn));
    const alpha = Math.max(0.85, alphaIn);
    x = this.sx(x);
    y = this.sy(y);
    maxW = this.sz(maxW);
    const lines = this.wrapLines(text, maxW, size);

    const step = lineStep(size);
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
   * Строка, переносимая по словам, растущая ВНИЗ от `y` — а не вокруг него.
   *
   * `wrapped` центрирует блок по вертикали, что годится для подписи товара с
   * известной высотой карточки. Подсказка под именем двери растёт от
   * фиксированной кромки: раскладка соседних дверей не знает заранее, сколько
   * строк займёт подсказка, поэтому центрировать её было бы не от чего.
   */
  wrappedTop(
    text: string,
    x: number,
    y: number,
    maxW: number,
    sizeIn: number,
    colour: Rgb,
    alphaIn = 0.95,
  ): void {
    const size = this.sz(Math.max(TEXT.MIN, sizeIn));
    const alpha = Math.max(0.85, alphaIn);
    x = this.sx(x);
    y = this.sy(y);
    maxW = this.sz(maxW);
    const lines = this.wrapLines(text, maxW, size);

    const step = lineStep(size);
    for (let i = 0; i < lines.length; i++) {
      this.text.push(
        lines[i],
        x,
        y + i * step,
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
  /**
   * Подпись на карточке экрана: тот же масштаб, что у самой карточки.
   *
   * Прямые `text.push` в экранах масштаб не знали, и при 150% имя товара
   * оставалось прежним посреди выросшей карточки.
   */
  label(
    text: string,
    x: number,
    y: number,
    size: number,
    c: Rgb,
    align: 'left' | 'center' | 'right' = 'center',
    alpha = 1,
  ): void {
    this.text.push(
      text,
      this.sx(x),
      this.sy(y),
      this.sz(size),
      Face.Ui,
      c.r,
      c.g,
      c.b,
      alpha,
      align,
    );
  }

  screenCard(
    x: number,
    y: number,
    halfW: number,
    halfH: number,
    focused: boolean,
    available = true,
  ): Rgb {
    const colour = !available ? PALETTE.chrome : focused ? PALETTE.accent : PALETTE.hudDim;
    const alpha = !available ? 0.5 : focused ? 1 : 0.75;
    x = this.sx(x);
    y = this.sy(y);
    halfW = this.sz(halfW);
    halfH = this.sz(halfH);
    // Выбранная карточка светится золотом заведения — тем же, что подсвечивает
    // карту под ногами: язык подсветки один на бой и на экраны.
    if (focused && available) {
      glow(this.batch, Shape.Box, x, y, halfW, colour, 0.26, halfH);
    }
    entity(this.batch, Shape.Box, x, y, halfW, halfH, 0, colour, alpha);
    /*
     * Недоступность кодируется ФОРМОЙ, а не только цветом.
     *
     * Хром и полупрозрачность — два признака одной природы (яркость), и оба
     * пропадают у дальтоника вместе. Штриховка — второй признак другой
     * природы, ровно как требует двойное кодирование (UX §4).
     */
    if (!available) {
      const step = halfH / 2;
      for (let i = -1; i <= 1; i++) {
        this.batch.push(
          Shape.Box,
          x + i * step * 1.6,
          y,
          halfH * 1.35,
          1.5,
          Math.PI / 4,
          colour.r,
          colour.g,
          colour.b,
          0.5,
          0,
          0,
          0,
          0,
          0,
        );
      }
    }
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
  priceTag(value: number, x: number, y: number, size: number, colour: Rgb): void {
    x = this.sx(x);
    y = this.sy(y);
    size = this.sz(size);
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
}

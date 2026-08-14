/**
 * Главный цикл: фиксированный тик симуляции плюс интерполяция рендера.
 *
 * Симуляция идёт ровно 60 Гц независимо от частоты экрана — иначе
 * детерминизм невозможен: на 144 Гц мир жил бы вдвое быстрее, и реплей,
 * записанный на одной машине, не сошёлся бы на другой.
 */

import {
  withAppetite,
  Btn,
  checkInvariants,
  clearArena,
  createState,
  type EnemyType,
  fromFloat,
  hashHex,
  InputScheme,
  type InputFrame,
  MAX_PLAYERS,
  Meta,
  RunPhase,
  setSpawning,
  type SimState,
  spawnEnemy,
  spawnPlayers,
  step,
  TICK_HZ,
  toFloat,
} from '@dod/sim';
import { ReplayRecorder } from '@dod/sim/replay';
import { CONFIG_VERSION } from '@dod/shared';
import { Audio } from './audio';
import { EventLog } from './events';
import { t } from './i18n';
import { Feedback } from './feedback';
import { Feel } from './feel';
import { Coach } from './coach';
import { InputSource } from './input';
import {
  againButtonFor,
  MENU_PLAY_BUTTON,
  MENU_SETTINGS_BUTTON,
  PAUSE_BUTTONS,
  hitButton,
} from './menuLayout';
import { logInvariant } from './protocol';
import { PALETTE } from './palette';
import { ParticleShape, Particles } from './particles';
import { type MenuOverlay, Renderer } from './renderer';
import { BUILD, IS_DEV } from './version';

const MS_PER_TICK = 1000 / TICK_HZ;
/** Потолок догоняющих тиков: после сворачивания вкладки не наверстываем час. */
const MAX_CATCHUP = 5;

export interface LoopOptions {
  seed: number;
  players: number;
  autopause: boolean;
}

export class GameLoop {
  state: SimState;
  private readonly renderer: Renderer;
  private readonly input: InputSource;
  readonly feel = new Feel();
  readonly particles = new Particles();
  readonly audio = new Audio();
  readonly feedback: Feedback;
  private recorder: ReplayRecorder;
  readonly events = new EventLog();
  /**
   * Обучение действием: подсказка в бою там, где решение и принимается.
   *
   * Живёт в клиенте и в реплей не едет: подсказка не влияет ни на один тик,
   * а её появление зависит от профиля игрока, которого в записи нет.
   */
  readonly coach = new Coach();
  private acc = 0;
  private last = 0;
  private running = false;
  private paused: boolean;
  private frameId = 0;

  /**
   * Забег ещё не начат: на экране главное меню.
   *
   * Живёт в клиенте, а не в симуляции, потому что фазы `Menu` в ядре нет:
   * `RunPhase` начинается с двери. Ядру она и не нужна — в меню ничего не
   * происходит, ни один тик не считается и реплею нечего переигрывать, — но
   * пока её нет, меню обязано ОСТАНАВЛИВАТЬ забег снаружи. Иначе первая
   * комната играется сама, пока игрок читает заголовок, и «МЕНЮ ──► ЗАБЕГ»
   * (GDD §5) превращается в надпись поверх уже идущего боя.
   */
  private menu = true;
  /** Туториал/глоссарий поверх меню — открывается и закрывается отказом (Cancel). */
  private tutorial = false;
  /**
   * Вторая страница справки — управление.
   *
   * Страницы листаются горизонталью: в справке она свободна (курсора здесь
   * нет), а разводить две страницы по двум разным кнопкам значило бы учить
   * игрока лишнему жесту ради одного экрана.
   */
  private tutorialControls = false;
  /** Какой пункт настроек в фокусе: 0 — поштучный забор, 1 — масштаб. */
  private settingsFocus = 0;
  /**
   * Масштаб интерфейса в процентах (UX §5).
   *
   * Живёт рядом с прочими настройками клиента, а не в состоянии симуляции:
   * размер букв не влияет ни на один тик и в реплей ехать не должен.
   */
  private uiScale = 100;
  /** Кадр ввода даёт уровень, не фронт: без своего фронта Cancel мигал бы туториалом, пока кнопка держится. */
  private cancelWasDown = false;
  /** Настройки поверх меню — второй пункт рядом с «Играть», открывается Confirm. */
  private settingsOpen = false;
  /** Какой пункт меню в фокусе: 0 — «Играть», 1 — «Настройки». */
  private menuFocus: 0 | 1 = 0;
  /**
   * Пункт паузы в фокусе: 0 — «Продолжить», 1 — «Настройки», 2 — «Как играть».
   *
   * Пауза — это экран, а не только остановленные часы: до него `Esc` давал
   * замерший кадр без единого объяснения, а настройки и справка, обещанные
   * UX §5 и §7 «из паузы», в забеге были недоступны вовсе.
   */
  private pauseFocus: 0 | 1 | 2 = 0;
  /** Экран паузы открыт игроком (а не часы остановлены отладочным шагом). */
  private pauseScreen = false;
  /** Те же поля фронта, что и у Cancel — NavLeft/Right в меню уровневые. */
  private navLeftWasDown = false;
  private navRightWasDown = false;
  /** Фронт `Space` в меню — «Играть»/«Настройки» тем же жестом, что и Enter. */
  private spaceWasDown = false;
  /** Фронт подтверждения: на паузе оно открывает экран, а не жмётся каждый кадр. */
  private confirmWasDown = false;
  /** Кого позвать, когда игрок начал забег из меню. */
  private runStarted: (() => void) | null = null;
  /** Кого позвать, когда игрок переключил настройку из экрана настроек. */
  private settingsChanged: ((cashOutFocusedOnly: boolean, uiScale: number) => void) | null = null;

  fps = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  /** Сцена нагружена синтетикой: инварианты боя к ней не применимы. */
  private benchMode = false;

  constructor(canvas: HTMLCanvasElement, opts: LoopOptions) {
    this.state = createState(opts.seed, opts.players);
    spawnPlayers(this.state);
    this.renderer = new Renderer(canvas);
    this.input = new InputSource();
    this.input.attach(canvas);
    this.paused = opts.autopause;
    this.recorder = this.makeRecorder();
    this.events.reset(this.state);
    this.feedback = new Feedback(this.particles, this.feel, this.audio);
    this.feedback.reset(this.state);
    // Звук включается по первому вводу: до жеста браузер его не разрешает,
    // и попытка запуститься на загрузке даёт навсегда молчащую вкладку.
    this.input.onFirstInput(() => this.audio.unlock());
    // Клик по кнопкам меню — теми же прямоугольниками, что рисует
    // `drawMenuScreen` (renderer.ts): общая константа в `menuLayout.ts`,
    // а не третья копия чисел. Разъезжались уже один раз, когда кнопка
    // сдвинулась влево ради второго пункта меню, а клик остался на старом
    // месте и молча перестал совпадать с нарисованным.
    this.input.onScreenClick((x, y) => {
      // Дочерний экран съедает клик: под ним лежат кнопки, которых сейчас не
      // видно, и попасть в них мышью значило бы нажать невидимое.
      if (this.tutorial || this.settingsOpen) return;
      if (this.menu) {
        if (hitButton(x, y, 960, 540, MENU_PLAY_BUTTON)) this.startRun();
        else if (hitButton(x, y, 960, 540, MENU_SETTINGS_BUTTON)) this.settingsOpen = true;
        return;
      }
      /*
       * Кнопки паузы и итогов тоже нажимаются мышью.
       *
       * Они нарисованы теми же карточками, что и «Играть», и не нажимались
       * вовсе: клик обрабатывался только в меню. Нарисованная кнопка, которая
       * не нажимается, — обещание, которого интерфейс не держит, а мышь в
       * этой игре есть всегда (UX §2).
       */
      if (this.pauseScreen) {
        for (let i = 0; i < PAUSE_BUTTONS.length; i++) {
          if (!hitButton(x, y, 960, 540, PAUSE_BUTTONS[i])) continue;
          this.pauseFocus = i as 0 | 1 | 2;
          this.confirmPause();
          return;
        }
        return;
      }
      if (
        this.state.meta[Meta.Phase] === RunPhase.Summary &&
        hitButton(x, y, 960, 540, againButtonFor(this.state))
      ) {
        this.again();
      }
    });
    // Пауза «везде и всегда» (UX §2). Живёт в клиенте, а не в кадре ввода:
    // она останавливает часы, а не симуляцию, и в реплей ей ехать нечем.
    /*
     * Пауза «везде и всегда» (UX §2), и выход из неё закрывает то, что она
     * открыла: настройки и справка живут поверх паузы, и оставить их висеть
     * над идущим боем значило бы читать меню под обстрелом — ровно то, что
     * принцип 3 запрещает.
     */
    this.input.onPause(() => {
      // В меню и на итогах паузе нечего останавливать: забег там либо ещё не
      // начался, либо уже кончился, и у обоих экранов свои кнопки.
      if (this.menu || this.state.meta[Meta.Phase] === RunPhase.Summary) return;
      if (this.pauseScreen) this.resume();
      else this.openPause();
    });
  }

  private makeRecorder(): ReplayRecorder {
    return new ReplayRecorder({
      seed: this.state.seed,
      playerCount: this.state.playerCount,
      // Реплей = сид + инпуты + версия симуляционного конфига (TECH §2.5).
      // Строка 'dev' стояла здесь заглушкой и превращала клиентский реплей в
      // мусор: лог из браузера — это баг-репорт игрока, и без верной версии
      // конфига он не переигрывается ни раннером, ни проверкой эталонов.
      configVersion: CONFIG_VERSION,
      build: BUILD,
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.frameId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameId);
  }

  pause(): void {
    this.paused = true;
  }

  /**
   * Пауза ИГРОКА — она же экран.
   *
   * Отдельно от `pause()`, потому что часы останавливает не только игрок:
   * `advance()` шагает симуляцию по команде агента и тоже держит `paused`, а
   * экран паузы поверх отладочного шага означал бы, что агент видит не тот
   * кадр, который снимает. Признак экрана заводится только здесь.
   */
  private openPause(): void {
    this.paused = true;
    this.pauseScreen = true;
    this.pauseFocus = 0;
  }

  /** Снять паузу и убрать всё, что она открыла поверх боя. */
  private resume(): void {
    this.pauseScreen = false;
    if (!this.menu) {
      this.tutorial = false;
      this.tutorialControls = false;
      this.settingsOpen = false;
    }
    this.play();
  }

  play(): void {
    this.paused = false;
    // Сбрасываем накопитель: иначе после паузы прилетит пачка тиков разом.
    this.last = performance.now();
    this.acc = 0;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Стоит ли игра в меню: рендер рисует его поверх кадра. */
  get atMenu(): boolean {
    return this.menu;
  }

  onRunStart(fn: () => void): void {
    this.runStarted = fn;
  }

  /** Настройка сменилась из экрана настроек — сейв обязан узнать об этом. */
  onSettingsChange(fn: (cashOutFocusedOnly: boolean, uiScale: number) => void): void {
    this.settingsChanged = fn;
  }

  /** Применить сохранённую настройку на загрузке (`main.ts`, из `Profile`). */
  setCashOutFocusedOnly(v: boolean): void {
    this.input.cashOutFocusedOnly = v;
  }

  /** То же для масштаба интерфейса: сейв — источник, рендер — потребитель. */
  setUiScale(percent: number): void {
    this.uiScale = Math.min(150, Math.max(100, Math.round(percent)));
    this.renderer.setUiScale(this.uiScale / 100);
  }

  /**
   * Объявить схему ввода первого игрока (отладка и съёмка).
   *
   * Обёртка нужна потому, что `input` приватен, а схему видит не только ядро:
   * подсказки меню, паузы и HUD рисуются по живому `input.inputScheme`, и
   * одной подмены битов кадра для кадра с глифами пада не хватает.
   */
  setScheme(scheme: InputScheme): void {
    this.input.forceScheme(scheme);
  }

  /** Текущее значение — рендеру нечем иначе нарисовать тумблер настроек. */
  get cashOutFocusedOnly(): boolean {
    return this.input.cashOutFocusedOnly;
  }

  /**
   * Открыть туториал/глоссарий поверх меню сразу, без нажатия отказа.
   *
   * Раньше он был доступен только по кнопке «как играть» (Cancel в меню) —
   * то есть первый забег игрок либо находил её сам, либо не видел глоссарий
   * вовсе. `main.ts` зовёт это ровно один раз, когда `profile.save.runs`
   * ещё нулевой: первый экран, который видит новый игрок, — не голое меню,
   * а те же девять терминов, которые он мог бы и не найти.
   */
  openTutorial(): void {
    this.tutorial = true;
  }

  /** Какой пункт меню в фокусе и открыт ли экран настроек — нужно рендеру. */
  get menuState(): { focus: 0 | 1; settingsOpen: boolean; cashOutTarget: number } {
    return {
      focus: this.menuFocus,
      settingsOpen: this.settingsOpen,
      cashOutTarget: this.input.cashOutTarget,
    };
  }

  /**
   * Что рисовать поверх кадра — одним объектом на оба вызова отрисовки.
   *
   * Копий было две (кадр цикла и `renderOnce`), и они уже начинали расходиться:
   * поле, добавленное в одну, приходилось помнить про вторую.
   */
  private overlay(): MenuOverlay {
    return {
      tutorial: this.tutorial,
      settingsOpen: this.settingsOpen,
      focus: this.menuFocus,
      cashOutFocusedOnly: this.input.cashOutFocusedOnly,
      tutorialControls: this.tutorialControls,
      settingsFocus: this.settingsFocus,
      uiScale: this.uiScale,
      paused: this.pauseScreen,
      pauseFocus: this.pauseFocus,
    };
  }

  /**
   * Начать забег из меню.
   *
   * Часы сбрасываются вместе с накопителем: между загрузкой страницы и
   * нажатием «Играть» проходит сколько угодно времени, и без сброса первый же
   * кадр забега получил бы пачку догоняющих тиков — бой начинался бы уже
   * идущим.
   */
  /**
   * Начать следующий забег с экрана итогов.
   *
   * Сид получается из текущего линейным конгруэнтным шагом, а не из часов:
   * цепочка забегов остаётся воспроизводимой целиком, и «повтори мой вечер»
   * из баг-репорта означает то же самое у всех.
   */
  private again(): void {
    this.restart((Math.imul(this.state.seed, 1664525) + 1013904223) >>> 0, this.state.playerCount);
    this.runStarted?.();
  }

  private startRun(): void {
    if (!this.menu) return;
    this.menu = false;
    this.last = performance.now();
    this.acc = 0;
    this.runStarted?.();
  }

  /**
   * Подтверждение на паузе: продолжить, настройки или справка.
   *
   * Дочерние экраны здесь те же самые, что и в меню, и закрываются тем же
   * отказом — иначе игрок учил бы две раскладки для одного и того же экрана.
   */
  /**
   * Подтверждение на экране настроек меняет ЗНАЧЕНИЕ пункта в фокусе.
   *
   * Масштаб идёт по кругу 100 → 125 → 150 → 100, и это не нарушает правило
   * «шаг упирается в край»: там оно про НАВИГАЦИЮ, где перенос врёт о числе
   * элементов, а здесь — выбор значения одной настройки, у которого края нет
   * вовсе.
   */
  private toggleSetting(): void {
    if (this.settingsFocus === 1) {
      const next = this.uiScale >= 150 ? 100 : this.uiScale + 25;
      this.setUiScale(next);
      this.settingsChanged?.(this.input.cashOutFocusedOnly, this.uiScale);
      return;
    }
    this.input.cashOutFocusedOnly = !this.input.cashOutFocusedOnly;
    this.settingsChanged?.(this.input.cashOutFocusedOnly, this.uiScale);
  }

  private confirmPause(): void {
    if (this.tutorial) {
      this.tutorial = false;
      this.tutorialControls = false;
    } else if (this.settingsOpen) this.toggleSetting();
    else if (this.pauseFocus === 1) this.settingsOpen = true;
    else if (this.pauseFocus === 2) this.tutorial = true;
    else this.resume();
  }

  /**
   * Вернуться в меню с экрана итогов.
   *
   * Забег в ядре уже кончился, и «в меню» — это не переход внутри него, а тот
   * же новый забег, только не запущенный: состояние пересоздаётся с
   * шагнувшим сидом, а меню держит его до нажатия «Играть» (UX §6).
   */
  /** Вернуться в меню — тем же путём, которым это делает отказ на итогах. */
  backToMenu(): void {
    this.toMenu();
  }

  private toMenu(): void {
    this.restart((Math.imul(this.state.seed, 1664525) + 1013904223) >>> 0, this.state.playerCount);
    this.menu = true;
    this.menuFocus = 0;
  }

  /** Подтверждение в меню: три смысла по тому, что сейчас открыто (см. вызовы). */
  private confirmMenu(): void {
    if (this.tutorial) {
      this.tutorial = false;
      this.tutorialControls = false;
    } else if (this.settingsOpen) this.toggleSetting();
    else if (this.menuFocus === 1) this.settingsOpen = true;
    else this.startRun();
  }

  /** Кого позвать, когда инвариант остановил симуляцию. */
  private halted: ((message: string, seed: number, tick: number) => void) | null = null;

  onHalt(fn: (message: string, seed: number, tick: number) => void): void {
    this.halted = fn;
  }

  /**
   * Прошагать ровно n тиков прямо сейчас, синхронно.
   *
   * Именно синхронно, а не через очередь до следующего кадра: агент
   * вызывает `tick(n)` и тут же читает состояние, и отложенное выполнение
   * заставило бы его ждать кадр после каждого шага. Заодно шаг перестаёт
   * зависеть от того, отрисовывается ли вкладка вообще.
   */
  advance(n: number): void {
    this.paused = true;
    for (let i = 0; i < n; i++) this.tickOnce();
  }

  /** Начать заново с другим сидом или составом. */
  restart(seed: number, players: number): void {
    this.benchMode = false;
    /*
     * Забег, заказанный явно, начинается с чистого экрана.
     *
     * Справка и настройки открываются поверх чего угодно — с меню и с паузы, —
     * и заказанный агентом или сценарием забег заставал их висящими: кадр
     * содержал не бой, а справку поверх боя. Сюда же приходит «Ещё разок» и
     * возврат в меню, и им это правило нужно ровно так же.
     */
    this.pauseScreen = false;
    this.tutorial = false;
    this.tutorialControls = false;
    this.settingsOpen = false;
    // Явно заказанный забег меню не ждёт: так его заказывают агент, сценарий и
    // сквозной тест, и висящее поверх меню сделало бы их кадр не тем кадром.
    this.menu = false;
    this.state = createState(seed, players);
    spawnPlayers(this.state);
    this.recorder = this.makeRecorder();
    this.events.reset(this.state);
    this.feedback.reset(this.state);
    this.coach.reset();
    this.renderer.forget();
    this.acc = 0;
    this.last = performance.now();
  }

  private readonly frame = (now: number): void => {
    if (!this.running) return;

    const dt = Math.min(now - this.last, MS_PER_TICK * MAX_CATCHUP);
    this.last = now;

    this.fpsAcc += now > 0 ? dt : 0;
    this.fpsFrames++;
    if (this.fpsAcc >= 500) {
      this.fps = Math.round((this.fpsFrames * 1000) / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }

    /*
     * Хитстоп останавливает ЧАСЫ, а не симуляцию.
     *
     * Тик остаётся ровно 1/60 секунды, их просто становится меньше — поэтому
     * удар «залипает» на экране, а детерминизм не страдает. Замедлять сам
     * тик нельзя: реплей, записанный с чужими хитстопами, не сойдётся
     * (TECH §7.1А).
     */
    const simDt = this.feel.advance(dt / 1000);

    /*
     * В меню опрашивается только подтверждение.
     *
     * Кадр ввода при этом собирается целиком и выбрасывается: опрос — единственный
     * способ узнать состояние геймпада (событий Gamepad API не даёт вовсе), и
     * ради одного бита городить второй путь опроса значило бы завести вторую
     * раскладку, которая разъедется с первой.
     */
    if (this.menu || this.pauseScreen || this.state.meta[Meta.Phase] === RunPhase.Summary) {
      const f = this.input.poll(
        toArenaFloat(this.state.pX[0]),
        toArenaFloat(this.state.pY[0]),
        this.state.pAppetite[0],
      );
      /*
       * «Ещё разок» — действие клиента, а не ядра, и это не обход правила.
       *
       * Забег в ядре кончается насовсем: на итогах симуляция намеренно
       * остановлена, и «начать заново» означает НОВЫЙ забег с новым сидом —
       * то есть новое состояние, а не переход внутри старого. Реплей от этого
       * не страдает: их становится два, по одному на забег, каждый со своим
       * сидом.
       */
      const confirmDown = (f.buttons & Btn.Confirm) !== 0;
      if (confirmDown && !this.confirmWasDown) {
        if (this.menu) this.confirmMenu();
        else if (this.pauseScreen) this.confirmPause();
        else this.again();
      }
      // Фронт, а не уровень: на паузе подтверждение открывает экран, и
      // удержанная кнопка иначе открывала бы и закрывала его шестьдесят раз
      // в секунду. В меню и на итогах поведение от этого не меняется —
      // действие там всё равно одноразовое.
      this.confirmWasDown = confirmDown;
      /*
       * `Space` — второй путь подтверждения ТОЛЬКО в меню (playtest 0.3.1:
       * «сделай играть не на Enter/Tab, а на Enter/Space»). Не льётся в общий
       * `Btn.Confirm`: `Space` в бою — рывок, и там же читается принятие
       * Ставки Крупье тем же битом — общий путь подписывал бы пари каждым
       * уворотом (`input.ts: spaceDown`).
       */
      const spaceDown = this.input.spaceDown;
      if (this.menu && spaceDown && !this.spaceWasDown) this.confirmMenu();
      this.spaceWasDown = spaceDown;
      /*
       * Отказ закрывает то, что открыто (туториал или настройки), а на голом
       * меню открывает туториал/глоссарий (UX §7) — тот же бит, три смысла по
       * состоянию экрана, ровно как у Confirm выше.
       */
      const cancelDown = (f.buttons & Btn.Cancel) !== 0;
      if (cancelDown && !this.cancelWasDown) {
        if (this.settingsOpen) this.settingsOpen = false;
        else if (this.tutorial) {
          this.tutorial = false;
          this.tutorialControls = false;
        } else if (this.menu) this.tutorial = true;
        // На паузе отказ — «продолжить»: та же кнопка, что закрывает
        // дочерний экран, закрывает и саму паузу, когда закрывать больше
        // нечего.
        else if (this.pauseScreen) this.resume();
        // На итогах отказ уводит в меню. Без него игрок, однажды нажавший
        // «Играть», не видел ни меню, ни справки, ни настроек до перезагрузки
        // страницы: подтверждение начинало новый забег, и круг замыкался.
        else this.toMenu();
      }
      this.cancelWasDown = cancelDown;

      // В настройках горизонталь выбирает пункт.
      if (this.settingsOpen) {
        const leftDown = (f.buttons & Btn.NavLeft) !== 0;
        const rightDown = (f.buttons & Btn.NavRight) !== 0;
        if (leftDown && !this.navLeftWasDown)
          this.settingsFocus = Math.max(0, this.settingsFocus - 1);
        if (rightDown && !this.navRightWasDown)
          this.settingsFocus = Math.min(1, this.settingsFocus + 1);
        this.navLeftWasDown = leftDown;
        this.navRightWasDown = rightDown;
      }

      // В справке горизонталь листает страницы: термины и управление.
      if (this.tutorial) {
        const leftDown = (f.buttons & Btn.NavLeft) !== 0;
        const rightDown = (f.buttons & Btn.NavRight) !== 0;
        if (leftDown && !this.navLeftWasDown) this.tutorialControls = false;
        if (rightDown && !this.navRightWasDown) this.tutorialControls = true;
        this.navLeftWasDown = leftDown;
        this.navRightWasDown = rightDown;
      }

      // Фокус — только на голом экране: с открытым туториалом или настройками
      // горизонталь той же кнопкой управляет другим (Cancel закрывает их).
      if (!this.tutorial && !this.settingsOpen && (this.menu || this.pauseScreen)) {
        const leftDown = (f.buttons & Btn.NavLeft) !== 0;
        const rightDown = (f.buttons & Btn.NavRight) !== 0;
        const step = (d: -1 | 1): void => {
          if (this.menu) this.menuFocus = d < 0 ? 0 : 1;
          // Шаг упирается в край, как и везде (UX §2): перенос по кругу врёт
          // о числе пунктов.
          else this.pauseFocus = Math.min(2, Math.max(0, this.pauseFocus + d)) as 0 | 1 | 2;
        };
        if (leftDown && !this.navLeftWasDown) step(-1);
        if (rightDown && !this.navRightWasDown) step(1);
        this.navLeftWasDown = leftDown;
        this.navRightWasDown = rightDown;

        // Наводка мышью — те же прямоугольники, что клик и отрисовка
        // (см. `menuLayout.ts`). Без этого мышь могла нажать кнопку, но не
        // подсвечивала её заранее — на экране, где кроме этих двух карточек
        // искать взглядом больше нечего.
        if (this.menu) {
          const [mx, my] = this.input.mousePosition;
          if (hitButton(mx, my, 960, 540, MENU_PLAY_BUTTON)) this.menuFocus = 0;
          else if (hitButton(mx, my, 960, 540, MENU_SETTINGS_BUTTON)) this.menuFocus = 1;
        }
      }
    }

    // В паузе кадр только рисует: шаги делает advance(), синхронно.
    if (!this.paused && !this.menu) {
      this.acc += simDt * 1000;
      while (this.acc >= MS_PER_TICK) {
        this.tickOnce();
        this.acc -= MS_PER_TICK;
      }
    }
    // Частицы и вспышки идут по тем же часам, что и симуляция: иначе взрыв
    // догорает, пока картинка стоит, и хитстоп теряет весь смысл.
    this.particles.update(simDt);
    this.feedback.frame(simDt);

    // Схема ввода — в рендер каждый кадр: подписи экранов называют физическую
    // кнопку, а устройство меняется прямо во время игры (UX §2).
    this.renderer.scheme = this.input.inputScheme;
    const alpha = this.paused ? 1 : this.acc / MS_PER_TICK;
    this.renderer.coachText = this.coachText();
    this.renderer.draw(
      this.state,
      alpha,
      this.feel,
      this.particles,
      this.feedback,
      this.menu,
      this.overlay(),
      this.input.cashOutTarget,
    );

    this.frameId = requestAnimationFrame(this.frame);
  };

  /**
   * Подменённый ввод для агента и сценариев.
   *
   * Без этого проверить движение в браузере можно только руками: живой
   * ввод приходит с клавиатуры и геймпада, а их у агента нет. Подмена
   * действует, пока её не сняли — так сценарий задаёт ввод один раз и
   * шагает сколько нужно.
   */
  private readonly overrides = new Map<number, InputFrame>();

  setInput(player: number, frame: Partial<InputFrame> | null): void {
    if (frame === null) {
      this.overrides.delete(player);
      return;
    }
    this.overrides.set(player, { ...EMPTY, ...frame });
  }

  /**
   * Аппетит, подмешиваемый в кадр ввода игрока. −1 — не подмешивать.
   *
   * Аппетит живёт в маске кнопок, а не в состоянии: симуляция переписывает
   * `pAppetite` из кадра КАЖДЫЙ тик (GDD §9.3 — тир держится всю комнату и
   * приходит с экрана двери). Поэтому запись прямо в состояние живёт ровно до
   * следующего тика, и отладочный «поставь по-крупному» обязан идти тем же
   * путём, что настоящий выбор игрока, — через ввод.
   */
  private readonly appetite = new Int32Array(MAX_PLAYERS).fill(-1);
  /** Кадры под подмешанный аппетит: копия чужого кадра, чтобы не портить его. */
  private readonly appetiteFrames: InputFrame[] = Array.from({ length: MAX_PLAYERS }, () => ({
    ...EMPTY,
  }));

  setAppetite(player: number, tier: number | null): void {
    this.appetite[player] = tier ?? -1;
  }

  /** Кадр игрока с учётом подмешанного аппетита. */
  private withAppetite(player: number, frame: InputFrame): InputFrame {
    const tier = this.appetite[player];
    if (tier < 0) return frame;
    const out = this.appetiteFrames[player];
    out.moveX = frame.moveX;
    out.moveY = frame.moveY;
    out.aimX = frame.aimX;
    out.aimY = frame.aimY;
    /*
     * Укладываем тир той же функцией, что и живой ввод.
     *
     * Своя арифметика по битам здесь уже стоила дефекта: кодировка сдвинута на
     * единицу (ноль в битах — «игрок молчит», иначе «Скромно» неотличимо от
     * отпущенной кнопки), а этот путь остался на прямой записи номера — и
     * отладочный `setAppetite(0, 2)` давал тир 1. Тесты этого не поймали:
     * они ходят через маску, а не через подмену. Одна функция на оба пути —
     * единственная защита от повторения.
     */
    out.buttons = withAppetite(frame.buttons, tier);
    return out;
  }

  /**
   * Кадры ввода этого тика.
   *
   * Буфер предаллоцирован и переиспользуется: свежий массив на каждый тик —
   * это шестьдесят мусорных объектов в секунду на ровном месте, а сборка мусора
   * съедает кадр целиком. Ссылки в нём чужие (кадр опроса ввода и подмены
   * агента переиспользуются своими владельцами), и это безопасно: `step` и
   * запись реплея читают их в том же тике и не хранят.
   */
  private readonly inputs: InputFrame[] = [];

  private tickOnce(): void {
    this.renderer.capture(this.state);

    const inputs = this.inputs;
    inputs.length = this.state.playerCount;
    for (let i = 0; i < this.state.playerCount; i++) {
      const override = this.overrides.get(i);
      // Живой ввод только у первого игрока: остальные нужны, чтобы
      // состав влиял на состояние и это ловилось тестами.
      const frame =
        override ??
        (i === 0
          ? this.input.poll(
              toArenaFloat(this.state.pX[0]),
              toArenaFloat(this.state.pY[0]),
              // Текущий тир кона — из состояния: защёлка живёт там, и
              // относительный выбор (крестовина, колесо, `Z`) обязан считаться
              // от значения, которое действительно в силе.
              this.state.pAppetite[0],
            )
          : EMPTY);
      inputs[i] = this.withAppetite(i, frame);
    }

    const deaths = this.state.meta[Meta.Deaths];
    this.recorder.record(inputs);
    step(this.state, inputs);
    // Обучение смотрит на состояние ПОСЛЕ шага и на кадр, который к нему
    // привёл: урок «нажмите рывок» закрывается тем самым нажатием.
    this.coach.observe(this.state, inputs[0]);
    this.events.observe(this.state);
    this.feedback.observe(this.state);

    // Перезапуск после гибели переставляет игрока в центр одним тиком.
    // Интерполировать этот скачок нельзя: получится, что мёртвый доехал до
    // точки старта, а не появился в ней.
    if (this.state.meta[Meta.Deaths] !== deaths) this.renderer.forget();

    /*
     * Инварианты — КАЖДЫЙ тик в dev-сборке (DEVLOOP §6).
     *
     * Раньше проверка шла раз в секунду и ловила дефект на пятьдесят девять
     * тиков позже, чем могла: в записи это уже не тот кадр, а в живой игре —
     * не тот бой. Смысл уровня ровно в том, чтобы поймать нарушение В МОМЕНТ
     * возникновения, а не через десять минут игры.
     *
     * Цена замерена, а не предположена: линейный проход по пулам стоит
     * 0.0096 мс против 0.17 мс самого тика — 2.4% бюджета симуляции в 0.4 мс.
     * За такие деньги проверять реже нечего.
     *
     * Нарушение останавливает цикл, но НЕ падает исключением наружу: упавший
     * rAF уносит с собой и рендер, и отладочный интерфейс, и агент видит
     * вместо причины застывшую картинку. Останавливаемся сами и говорим, на
     * каком сиде и тике, — этого хватает, чтобы воспроизвести.
     */
    if (IS_DEV && !this.benchMode) {
      try {
        checkInvariants(this.state);
      } catch (e) {
        logInvariant(String(e), this.state.seed, this.state.tick);
        this.pause();
        /*
         * И говорим об этом НА ЭКРАНЕ, а не только в консоли.
         *
         * Запись в консоли писалась для агента, а останавливается игра у
         * человека — и человек в devtools не пойдёт. Со стороны остановка
         * выглядит как замерший кадр без причины: на экране расчёта её
         * прочитали как «экран, который невозможно пропустить», и вечер ушёл
         * на поиски несуществующей кнопки. Слушатель, а не прямой вызов
         * оверлея: цикл не знает про интерфейс и знать не должен.
         */
        this.halted?.(String(e), this.state.seed, this.state.tick);
      }
    }
  }

  snapshotReplay() {
    return this.recorder.finish();
  }

  hash(): string {
    return hashHex(this.state);
  }

  /**
   * Нагрузить сцену: враги и частицы разом.
   *
   * Ровно та проверка, которую требует план версии, — «2000 частиц и 200
   * болванок в бюджете кадра». Мерить её на живом бою бессмысленно: худшая
   * волна случается редко и не по команде, а бюджет обязан держаться именно
   * в ней.
   */
  stress(enemies: number, particles: number): void {
    /*
     * Стенд перестаёт быть игрой, и инварианты об этом должны знать.
     *
     * Нагрузка из плана версии — двести болванок — намеренно выше боевого
     * потолка читаемости (D9: 40 + 15 на игрока). Это и есть смысл замера:
     * бюджет обязан держаться с запасом, а не впритык. Оставить проверку
     * включённой значило бы получать честное нарушение честного правила на
     * каждом прогоне бенча и приучиться его пролистывать.
     */
    this.benchMode = true;
    const s = this.state;
    setSpawning(s, false);
    clearArena(s);
    const w = toFloat(s.arenaW);
    const h = toFloat(s.arenaH);
    for (let i = 0; i < enemies; i++) {
      const a = (i / enemies) * Math.PI * 2 * 7;
      const r = 120 + (i / enemies) * (Math.min(w, h) / 2 - 160);
      spawnEnemy(
        s,
        (i % 3) as EnemyType,
        fromFloat(w / 2 + Math.cos(a) * r),
        fromFloat(h / 2 + Math.sin(a) * r),
      );
    }
    for (let i = 0; i < particles; i++) {
      const a = (i / particles) * Math.PI * 2 * 13;
      this.particles.spawn(
        (i % 3) as ParticleShape,
        w / 2 + Math.cos(a) * (i % 700),
        h / 2 + Math.sin(a) * (i % 400),
        Math.cos(a) * 60,
        Math.sin(a) * 60,
        8,
        // Долгая жизнь: частицы должны дожить до замера, а не погаснуть в нём.
        60,
        PALETTE.chip,
      );
    }
  }

  /**
   * Нарисовать кадр прямо сейчас, синхронно.
   *
   * Нужно и агенту, и визуальным тестам: в свёрнутой или невидимой вкладке
   * браузер не вызывает requestAnimationFrame вовсе, и кадра просто не
   * существует — а проверять надо именно картинку. Заодно это единственный
   * способ снять воспроизводимый кадр: он рисуется по команде, а не когда
   * планировщик решит.
   */
  /**
   * Текст текущего урока по живой схеме ввода.
   *
   * Схема берётся из слоя ввода, а не из состояния: подсказка называет
   * ФИЗИЧЕСКУЮ кнопку, и игрок, взявшийся за геймпад посреди боя, обязан
   * увидеть его кнопку сразу (та же причина, что у подписей экранов).
   */
  private coachText(): string {
    // Пока открыт экран, обучению нечего подсказывать: решение принимается не
    // в бою, а на экране, у которого свои подписи.
    if (this.menu || this.pauseScreen || this.tutorial || this.settingsOpen) return '';
    const key = this.coach.key(this.input.inputScheme === InputScheme.Gamepad);
    return key === null ? '' : t(key);
  }

  renderOnce(): void {
    this.renderer.coachText = this.coachText();
    this.renderer.draw(
      this.state,
      1,
      this.feel,
      this.particles,
      this.feedback,
      this.menu,
      this.overlay(),
      this.input.cashOutTarget,
    );
  }

  /** Сколько фигур ушло в последний кадр: главный показатель бюджета рендера. */
  /** Снимок кадра сеткой средних цветов: см. `Renderer.frameGrid`. */
  frameGrid(cols: number, rows: number): number[][] {
    return this.renderer.frameGrid(() => this.renderOnce(), cols, rows);
  }

  /** Кадр картинкой: глазная проверка вёрстки и типографики (`Renderer.framePng`). */
  framePng(focus?: { x: number; y: number; halfW: number; halfH: number; scale?: number }): string {
    return this.renderer.framePng(() => this.renderOnce(), focus);
  }

  /** Сколько фигур не влезло в батч: потолок кадра обязан быть виден. */
  get droppedShapes(): number {
    return this.renderer.lastDropped;
  }

  get shapeCount(): number {
    return this.renderer.lastShapeCount;
  }
}

const EMPTY: InputFrame = { moveX: 0, moveY: 0, aimX: 0, aimY: 0, buttons: 0 };

const toArenaFloat = (fx: number): number => fx / 65536;

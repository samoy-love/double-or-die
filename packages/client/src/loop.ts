/**
 * Главный цикл: фиксированный тик симуляции плюс интерполяция рендера.
 *
 * Симуляция идёт ровно 60 Гц независимо от частоты экрана — иначе
 * детерминизм невозможен: на 144 Гц мир жил бы вдвое быстрее, и реплей,
 * записанный на одной машине, не сошёлся бы на другой.
 */

import {
  APPETITE_MASK,
  APPETITE_SHIFT,
  checkInvariants,
  clearArena,
  createState,
  type EnemyType,
  fromFloat,
  hashHex,
  type InputFrame,
  MAX_PLAYERS,
  Meta,
  setSpawning,
  type SimState,
  spawnEnemy,
  spawnPlayers,
  step,
  TICK_HZ,
  toFloat,
} from '../../sim/src/index';
import { ReplayRecorder } from '../../sim/src/replay';
import { CONFIG_VERSION } from '../../shared/src/index';
import { Audio } from './audio';
import { EventLog } from './events';
import { Feedback } from './feedback';
import { Feel } from './feel';
import { InputSource } from './input';
import { logInvariant } from './protocol';
import { PALETTE } from './palette';
import { ParticleShape, Particles } from './particles';
import { Renderer } from './renderer';
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
  private acc = 0;
  private last = 0;
  private running = false;
  private paused: boolean;
  private frameId = 0;

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

  play(): void {
    this.paused = false;
    // Сбрасываем накопитель: иначе после паузы прилетит пачка тиков разом.
    this.last = performance.now();
    this.acc = 0;
  }

  get isPaused(): boolean {
    return this.paused;
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
    this.state = createState(seed, players);
    spawnPlayers(this.state);
    this.recorder = this.makeRecorder();
    this.events.reset(this.state);
    this.feedback.reset(this.state);
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

    // В паузе кадр только рисует: шаги делает advance(), синхронно.
    if (!this.paused) {
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

    const alpha = this.paused ? 1 : this.acc / MS_PER_TICK;
    this.renderer.draw(this.state, alpha, this.feel, this.particles, this.feedback);

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
    out.buttons =
      (frame.buttons & ~(APPETITE_MASK << APPETITE_SHIFT)) |
      ((tier & APPETITE_MASK) << APPETITE_SHIFT);
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
          ? this.input.poll(toArenaFloat(this.state.pX[0]), toArenaFloat(this.state.pY[0]))
          : EMPTY);
      inputs[i] = this.withAppetite(i, frame);
    }

    const deaths = this.state.meta[Meta.Deaths];
    this.recorder.record(inputs);
    step(this.state, inputs);
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
  renderOnce(): void {
    this.renderer.draw(this.state, 1, this.feel, this.particles, this.feedback);
  }

  /** Сколько фигур ушло в последний кадр: главный показатель бюджета рендера. */
  /** Снимок кадра сеткой средних цветов: см. `Renderer.frameGrid`. */
  frameGrid(cols: number, rows: number): number[][] {
    return this.renderer.frameGrid(() => this.renderOnce(), cols, rows);
  }

  get shapeCount(): number {
    return this.renderer.lastShapeCount;
  }
}

const EMPTY: InputFrame = { moveX: 0, moveY: 0, aimX: 0, aimY: 0, buttons: 0 };

const toArenaFloat = (fx: number): number => fx / 65536;

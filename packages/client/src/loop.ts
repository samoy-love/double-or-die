/**
 * Главный цикл: фиксированный тик симуляции плюс интерполяция рендера.
 *
 * Симуляция идёт ровно 60 Гц независимо от частоты экрана — иначе
 * детерминизм невозможен: на 144 Гц мир жил бы вдвое быстрее, и реплей,
 * записанный на одной машине, не сошёлся бы на другой.
 */

import {
  checkInvariants,
  clearArena,
  createState,
  type EnemyType,
  fromFloat,
  hashHex,
  type InputFrame,
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
  private readonly feedback: Feedback;
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
      configVersion: 'dev',
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

  private tickOnce(): void {
    this.renderer.capture(this.state);

    const inputs: InputFrame[] = [];
    for (let i = 0; i < this.state.playerCount; i++) {
      const override = this.overrides.get(i);
      if (override) {
        inputs.push(override);
        continue;
      }
      // Живой ввод только у первого игрока: остальные нужны, чтобы
      // состав влиял на состояние и это ловилось тестами.
      inputs.push(
        i === 0
          ? this.input.poll(toArenaFloat(this.state.pX[0]), toArenaFloat(this.state.pY[0]))
          : EMPTY,
      );
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

    // Инвариант нарушен — это дефект ядра, а не ситуация. Цикл при этом
    // останавливается, но НЕ падает исключением наружу: упавший rAF уносит с
    // собой и рендер, и отладочный интерфейс, и агент видит вместо причины
    // застывшую картинку. Останавливаемся сами и говорим, на каком сиде и
    // тике, — этого хватает, чтобы воспроизвести.
    if (IS_DEV && !this.benchMode && this.state.tick % 60 === 0) {
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
  get shapeCount(): number {
    return this.renderer.lastShapeCount;
  }
}

const EMPTY: InputFrame = { moveX: 0, moveY: 0, aimX: 0, aimY: 0, buttons: 0 };

const toArenaFloat = (fx: number): number => fx / 65536;

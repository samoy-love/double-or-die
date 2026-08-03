/**
 * Главный цикл: фиксированный тик симуляции плюс интерполяция рендера.
 *
 * Симуляция идёт ровно 60 Гц независимо от частоты экрана — иначе
 * детерминизм невозможен: на 144 Гц мир жил бы вдвое быстрее, и реплей,
 * записанный на одной машине, не сошёлся бы на другой.
 */

import {
  checkInvariants,
  createState,
  hashHex,
  type InputFrame,
  type SimState,
  spawnPlayers,
  step,
  TICK_HZ,
} from '../../sim/src/index';
import { ReplayRecorder } from '../../sim/src/replay';
import { EventLog } from './events';
import { InputSource } from './input';
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

  constructor(canvas: HTMLCanvasElement, opts: LoopOptions) {
    this.state = createState(opts.seed, opts.players);
    spawnPlayers(this.state);
    this.renderer = new Renderer(canvas);
    this.input = new InputSource();
    this.input.attach(canvas);
    this.paused = opts.autopause;
    this.recorder = this.makeRecorder();
    this.events.reset(this.state);
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
    this.state = createState(seed, players);
    spawnPlayers(this.state);
    this.recorder = this.makeRecorder();
    this.events.reset(this.state);
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

    // В паузе кадр только рисует: шаги делает advance(), синхронно.
    if (!this.paused) {
      this.acc += dt;
      while (this.acc >= MS_PER_TICK) {
        this.tickOnce();
        this.acc -= MS_PER_TICK;
      }
    }

    const alpha = this.paused ? 1 : this.acc / MS_PER_TICK;
    this.renderer.draw(this.state, alpha);

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

    this.recorder.record(inputs);
    step(this.state, inputs);
    this.events.observe(this.state);

    if (IS_DEV && this.state.tick % 60 === 0) checkInvariants(this.state);
  }

  snapshotReplay() {
    return this.recorder.finish();
  }

  hash(): string {
    return hashHex(this.state);
  }
}

const EMPTY: InputFrame = { moveX: 0, moveY: 0, aimX: 0, aimY: 0, buttons: 0 };

const toArenaFloat = (fx: number): number => fx / 65536;

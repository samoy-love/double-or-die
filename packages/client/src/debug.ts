/**
 * Отладочный интерфейс для агента.
 *
 * Даёт полный контроль над симуляцией: прошагать ровно n тиков, прочитать
 * состояние, подать ввод, прыгнуть куда угодно. Именно поэтому его НЕТ в
 * продакшене — вырезается на этапе сборки константой `__DEV_BUILD__`, а не
 * проверкой в рантайме: иначе его достанут из бандла.
 *
 * Проверяется в CI функциональным тестом: прод-бандл грузится headless и
 * утверждается `window.__DOD__ === undefined`.
 */

import {
  EnemyType,
  EntityFlag,
  MAX_BULLETS,
  MAX_CHIPS,
  MAX_ENEMIES,
  Meta,
  clearArena,
  fromFloat,
  setSpawning,
  spawnEnemy,
  toFloat,
  type SimState,
} from '../../sim/src/index';
import type { SimEvent } from './events';
import type { GameLoop } from './loop';
import { log } from './protocol';
import { BUILD, VERSION, GIT_SHA } from './version';

/** Имена врагов для отладки: номер типа в консоли не читается. */
const ENEMY_TYPES: Record<string, EnemyType> = {
  wedge: EnemyType.Wedge,
  brick: EnemyType.Brick,
  fuse: EnemyType.Fuse,
};

export type EnemyName = keyof typeof ENEMY_TYPES;

export interface DebugState {
  tick: number;
  seed: number;
  hash: string;
  playerCount: number;
  /** Ход забега: комната, волна, счёт убийств. */
  room: number;
  wave: number;
  kills: number;
  enemies: { i: number; type: number; hp: number; x: number; y: number; phase: number }[];
  bullets: number;
  chipsOnFloor: number;
  players: {
    i: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    aimX: number;
    aimY: number;
    hearts: number;
    chips: number;
    alive: boolean;
    invulnerable: boolean;
  }[];
}

export interface DebugApi {
  readonly ready: Promise<void>;
  readonly build: string;
  readonly version: string;
  readonly sha: string;
  newRun(o?: { seed?: number; players?: number }): void;
  tick(n?: number): void;
  /**
   * Подать ввод за игрока. Значения направлений — обычные числа −1..1,
   * `buttons` — маска Btn. `null` снимает подмену.
   */
  input(
    player: number,
    frame: { move?: [number, number]; aim?: [number, number]; buttons?: number } | null,
  ): void;
  play(): void;
  pause(): void;
  isPaused(): boolean;
  state(): DebugState;
  hash(): string;
  perf(): { fps: number; particles: number; shapes: number };
  /** Поставить врагов вокруг игрока. Без волн — ровно тех, кого попросили. */
  spawn(type: EnemyName, count?: number): void;
  /** Убрать с арены всё, кроме игроков. */
  clear(): void;
  /** Включить или выключить пополнение арены волнами. */
  waves(on?: boolean): void;
  /** Выдать ресурсы: отладка экономики без десяти минут игры. */
  give(o: { chips?: number; hearts?: number }): void;
  /** Выключить звук: он мешает, когда агент гоняет сотню прогонов. */
  mute(on?: boolean): void;
  /** Нарисовать кадр немедленно: в невидимой вкладке кадров не бывает. */
  render(): void;
  /** Нагрузить сцену для замера бюджета кадра: враги и частицы разом. */
  stress(o?: { enemies?: number; particles?: number }): void;
  /** События с указанного тика включительно. Без аргумента — все. */
  events(sinceTick?: number): SimEvent[];
  replay(): string;
  stable(on?: boolean): void;
}

function snapshot(s: SimState, hash: string): DebugState {
  const enemies = [];
  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (!s.eActive[i]) continue;
    enemies.push({
      i,
      type: s.eType[i],
      hp: s.eHP[i],
      x: toFloat(s.eX[i]),
      y: toFloat(s.eY[i]),
      phase: s.ePhase[i],
    });
  }
  let bullets = 0;
  for (let i = 0; i < MAX_BULLETS; i++) if (s.bActive[i]) bullets++;
  let chipsOnFloor = 0;
  for (let i = 0; i < MAX_CHIPS; i++) if (s.cActive[i]) chipsOnFloor++;

  const players = [];
  for (let i = 0; i < s.playerCount; i++) {
    players.push({
      i,
      x: toFloat(s.pX[i]),
      y: toFloat(s.pY[i]),
      vx: toFloat(s.pVX[i]),
      vy: toFloat(s.pVY[i]),
      aimX: toFloat(s.pAimX[i]),
      aimY: toFloat(s.pAimY[i]),
      hearts: s.pHearts[i],
      chips: s.pChips[i],
      alive: (s.pFlags[i] & EntityFlag.Alive) !== 0,
      invulnerable: (s.pFlags[i] & EntityFlag.Invulnerable) !== 0,
    });
  }
  return {
    tick: s.tick,
    seed: s.seed,
    hash,
    playerCount: s.playerCount,
    room: s.meta[Meta.Room],
    wave: s.meta[Meta.Wave],
    kills: s.meta[Meta.Kills],
    enemies,
    bullets,
    chipsOnFloor,
    players,
  };
}

export function installDebugApi(loop: GameLoop): void {
  const api: DebugApi = {
    ready: Promise.resolve(),
    build: BUILD,
    version: VERSION,
    sha: GIT_SHA,

    newRun(o) {
      loop.restart(o?.seed ?? loop.state.seed, o?.players ?? loop.state.playerCount);
      log('new_run', { seed: loop.state.seed, players: loop.state.playerCount });
    },

    tick(n = 1) {
      loop.advance(n);
    },

    input(player, frame) {
      if (frame === null) {
        loop.setInput(player, null);
        return;
      }
      const [mx, my] = frame.move ?? [0, 0];
      const [ax, ay] = frame.aim ?? [0, 0];
      loop.setInput(player, {
        moveX: fromFloat(mx),
        moveY: fromFloat(my),
        aimX: fromFloat(ax),
        aimY: fromFloat(ay),
        buttons: frame.buttons ?? 0,
      });
    },

    play: () => loop.play(),
    pause: () => loop.pause(),
    isPaused: () => loop.isPaused,
    state: () => snapshot(loop.state, loop.hash()),
    hash: () => loop.hash(),
    perf: () => ({
      fps: loop.fps,
      particles: loop.particles.count,
      shapes: loop.shapeCount,
    }),

    spawn(type, count = 1) {
      const t = ENEMY_TYPES[type];
      if (t === undefined) throw new Error(`неизвестный враг «${String(type)}»`);
      const s = loop.state;
      // По кругу вокруг игрока, но не ближе честной дистанции спавна:
      // отладка не должна создавать ситуаций, невозможных в игре.
      for (let n = 0; n < count; n++) {
        const a = (n / count) * Math.PI * 2;
        spawnEnemy(
          s,
          t,
          fromFloat(toFloat(s.pX[0]) + Math.cos(a) * 300),
          fromFloat(toFloat(s.pY[0]) + Math.sin(a) * 300),
        );
      }
      log('spawn', { type, count });
    },

    clear() {
      clearArena(loop.state);
      log('clear', {});
    },

    waves(on = true) {
      setSpawning(loop.state, on);
      log('waves', { on });
    },

    give(o) {
      const s = loop.state;
      if (o.chips !== undefined) s.pChips[0] += o.chips;
      if (o.hearts !== undefined) s.pHearts[0] += o.hearts;
      log('give', { chips: o.chips ?? 0, hearts: o.hearts ?? 0 });
    },

    mute(on = true) {
      loop.audio.setMuted(on);
    },

    render: () => loop.renderOnce(),

    stress(o) {
      loop.stress(o?.enemies ?? 200, o?.particles ?? 2000);
      log('stress', { enemies: o?.enemies ?? 200, particles: o?.particles ?? 2000 });
    },
    events: (sinceTick) => loop.events.since(sinceTick),

    replay() {
      // Лог инпутов — это и есть баг-репорт: по нему забег
      // воспроизводится тик в тик.
      const r = loop.snapshotReplay();
      return JSON.stringify({ seed: r.seed, ticks: r.ticks, build: r.build });
    },

    stable(on = true) {
      // Режим стабильного кадра: тряска, вспышки и хитстоп выключаются,
      // чтобы скриншоты сравнивались между версиями. Частицы при этом
      // остаются — они и есть предмет сравнения, — но камера стоит.
      loop.feel.stable = on;
      document.documentElement.dataset.stable = on ? '1' : '';
    },
  };

  (window as unknown as Record<string, unknown>).__DOD__ = api;
  log('debug_api_ready', { build: BUILD });
}

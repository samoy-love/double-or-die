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

import { EntityFlag, fromFloat, toFloat, type SimState } from '../../sim/src/index';
import type { GameLoop } from './loop';
import { BUILD, VERSION, GIT_SHA } from './version';

export interface DebugState {
  tick: number;
  seed: number;
  hash: string;
  playerCount: number;
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
  perf(): { fps: number };
  replay(): string;
  stable(on?: boolean): void;
}

function snapshot(s: SimState, hash: string): DebugState {
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
  return { tick: s.tick, seed: s.seed, hash, playerCount: s.playerCount, players };
}

/** Протокол консоли: агент фильтрует вывод по префиксу. */
export const log = (name: string, props?: Record<string, unknown>): void =>
  console.log(`[DOD] ${JSON.stringify({ name, ...props })}`);

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
    perf: () => ({ fps: loop.fps }),

    replay() {
      // Лог инпутов — это и есть баг-репорт: по нему забег
      // воспроизводится тик в тик.
      const r = loop.snapshotReplay();
      return JSON.stringify({ seed: r.seed, ticks: r.ticks, build: r.build });
    },

    stable(on = true) {
      // Режим стабильного кадра: частицы и вспышки замирают, чтобы
      // скриншоты можно было сравнивать между версиями. В 0.1.0
      // сравнивать почти нечего, но флаг заводится сразу — иначе
      // визуальные тесты придётся вкручивать задним числом.
      document.documentElement.dataset.stable = on ? '1' : '';
    },
  };

  (window as unknown as Record<string, unknown>).__DOD__ = api;
  log('debug_api_ready', { build: BUILD });
}

import { fromFloat } from '@dod/sim';
import { serialize } from '@dod/sim/replay';
import type { GameLoop } from '../loop';
import { log } from '../protocol';
import { snapshot } from './snapshot';
import type { DebugApi } from './types';

export function installRun(api: DebugApi, loop: GameLoop): void {
  Object.assign(api, {
    newRun(o?: { seed?: number; players?: number }) {
      loop.restart(o?.seed ?? loop.state.seed, o?.players ?? loop.state.playerCount);
      log('new_run', { seed: loop.state.seed, players: loop.state.playerCount });
    },

    tick(n = 1) {
      loop.advance(n);
    },

    input(
      player: number,
      frame: { move?: [number, number]; aim?: [number, number]; buttons?: number } | null,
    ) {
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
    state: () => snapshot(loop.state, loop.hash(), loop.feedback.bark),
    hash: () => loop.hash(),
    perf: () => ({
      fps: loop.fps,
      particles: loop.particles.count,
      shapes: loop.shapeCount,
      // Ненулевое значение означает, что кадр обрезан и картинка неполна:
      // без него бенч и визуальная регрессия сравнивали бы урезанный кадр,
      // не зная об этом.
      dropped: loop.droppedShapes,
    }),

    render: () => loop.renderOnce(),

    stress(o?: { enemies?: number; particles?: number }) {
      loop.stress(o?.enemies ?? 200, o?.particles ?? 2000);
      log('stress', { enemies: o?.enemies ?? 200, particles: o?.particles ?? 2000 });
    },
    events: (sinceTick?: number) => loop.events.since(sinceTick),

    replay() {
      /*
       * Лог инпутов — это и есть баг-репорт: по нему забег воспроизводится
       * тик в тик.
       *
       * Возвращать надо весь лог, а не заголовок от него. Прежняя версия
       * отдавала сид, число тиков и версию сборки — то есть ровно ту часть,
       * по которой ничего воспроизвести нельзя, — и обещание в этом
       * комментарии было ложным.
       *
       * Сериализует ядро: там же лежит RLE по неизменным кадрам (стик подолгу
       * держит направление, и повторов в живом забеге большинство), и там же
       * `deserialize`, который этот текст читает. Результат принимается
       * раннером как есть: `npm run sim -- --replay <файл>`.
       */
      return serialize(loop.snapshotReplay());
    },

    frameGrid(cols = 16, rows = 9) {
      return loop.frameGrid(cols, rows);
    },

    framePng(focus?: { x: number; y: number; halfW: number; halfH: number; scale?: number }) {
      return loop.framePng(focus);
    },

    stable(on = true) {
      // Режим стабильного кадра: тряска, вспышки и хитстоп выключаются,
      // чтобы скриншоты сравнивались между версиями. Частицы при этом
      // остаются — они и есть предмет сравнения, — но камера стоит.
      loop.feel.stable = on;
      document.documentElement.dataset.stable = on ? '1' : '';
    },
  } satisfies Partial<DebugApi>);
}

/**
 * Точка входа.
 *
 * Состояние задаётся URL-параметрами: агенту достаточно одного перехода,
 * чтобы оказаться где нужно, без кликов и ожиданий.
 *
 *   ?seed=1234&players=2&autopause=1
 */

import { GameLoop } from './loop';
import { BUILD, IS_DEV, registerServiceWorker, watchForUpdates } from './version';
import { Overlay } from './overlay';

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const seed = Number(params.get('seed') ?? 1) || 1;
  const players = Math.min(4, Math.max(1, Number(params.get('players') ?? 1) || 1));
  const autopause = params.get('autopause') === '1';

  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('нет элемента #game');

  const loop = new GameLoop(canvas, { seed, players, autopause });
  const overlay = new Overlay(loop, IS_DEV);

  /*
   * Отладочный интерфейс подключается ТОЛЬКО в dev-сборке и только
   * динамическим импортом.
   *
   * Параметром `?debug=1` его включать нельзя: `__DOD__` даёт полный
   * контроль над симуляцией, и в релизе это готовый чит, а не удобство для
   * поддержки. Динамический импорт под константой `IS_DEV` вырезается
   * сборщиком вместе со всем модулем — проверку в рантайме обошли бы,
   * отсутствующий код обойти нечем.
   */
  if (IS_DEV) {
    const { installDebugApi } = await import('./debug');
    installDebugApi(loop);
  }

  loop.start();
  overlay.start();

  void registerServiceWorker();
  watchForUpdates((build) => overlay.showUpdate(build));

  if (IS_DEV) {
    console.log(
      `[DOD] ${JSON.stringify({ name: 'boot', build: BUILD, seed, players, autopause })}`,
    );
  }
}

void main();

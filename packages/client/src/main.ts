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
import { log, logError } from './protocol';

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const seed = Number(params.get('seed') ?? 1) || 1;
  const players = Math.min(4, Math.max(1, Number(params.get('players') ?? 1) || 1));
  const autopause = params.get('autopause') === '1';
  /*
   * `debug=1` включает ОВЕРЛЕЙ, а не отладочный интерфейс.
   *
   * Разница принципиальная. Оверлей показывает кадры, номер тика, хеш и
   * версию сборки — это то, что нужно в баг-репорте от игрока, и вреда в нём
   * нет. `__DOD__` даёт полный контроль над симуляцией, и в релизе это чит;
   * он остаётся вырезанным из прод-сборки навсегда.
   */
  const debugOverlay = params.get('debug') === '1';
  /* Стабильный кадр: анимации замирают, чтобы скриншоты сравнивались. */
  const stable = params.get('stable') === '1';

  const canvas = document.getElementById('game') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('нет элемента #game');

  const loop = new GameLoop(canvas, { seed, players, autopause });
  const overlay = new Overlay(loop, IS_DEV || debugOverlay);
  if (stable) {
    loop.feel.stable = true;
    document.documentElement.dataset.stable = '1';
  }

  /*
   * Отладочный интерфейс подключается ТОЛЬКО в dev-сборке и только
   * динамическим импортом.
   *
   * Параметром `?debug=1` его включать нельзя: `__DOD__` даёт полный
   * контроль над симуляцией, и в релизе это готовый чит, а не удобство для
   * поддержки. Динамический импорт под константой вырезается сборщиком
   * вместе со всем модулем — проверку в рантайме обошли бы, отсутствующий
   * код обойти нечем.
   *
   * Условие написано на `__DEV_BUILD__`, а не на импортированном `IS_DEV`, и
   * это не стилистика. `define` подставляет литерал прямо в это место, и
   * ветка становится заведомо мёртвой до разбора; `IS_DEV` же приезжает из
   * соседнего модуля, и вырезание зависит от того, доведёт ли сборщик
   * значение константы через границу модуля. Vite 8 перестал это делать, и
   * отладочный интерфейс уехал в релизную сборку отдельным чанком — поймал
   * это гейт `check:no-debug-api`.
   */
  if (__DEV_BUILD__) {
    const { installDebugApi } = await import('./debug');
    installDebugApi(loop);
  }

  loop.start();
  overlay.start();

  void registerServiceWorker();
  watchForUpdates((build) => overlay.showUpdate(build));

  if (IS_DEV) {
    log('boot', { build: BUILD, seed, players, autopause, stable });
  }
}

/*
 * Необработанный сбой обязан попасть в консоль в нашем формате.
 *
 * Иначе он теряется среди сообщений браузера: агент фильтрует вывод по
 * префиксу и молча не увидит ровно того, ради чего смотрит. Обработчики
 * ставятся ДО main(): сбой на старте — самый частый и самый неудобный.
 */
window.addEventListener('error', (e) => {
  logError('uncaught', { message: String(e.message), source: e.filename, line: e.lineno });
});
window.addEventListener('unhandledrejection', (e) => {
  logError('unhandled_rejection', { reason: String(e.reason) });
});

void main().catch((e: unknown) => logError('boot_failed', { reason: String(e) }));

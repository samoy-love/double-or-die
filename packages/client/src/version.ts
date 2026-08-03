/**
 * Версия сборки и проверка обновлений.
 *
 * Работает с 0.1.0, а не с публичного выпуска: разработчик и агент
 * перезагружают страницу постоянно, и устаревший бандл в кеше даёт фантомные
 * баги, которые ищешь часами. Заодно версия в баг-репорте становится
 * осмысленной.
 */

declare const __VERSION__: string;
declare const __GIT_SHA__: string;
declare const __DEV_BUILD__: boolean;

export const VERSION = __VERSION__;
export const GIT_SHA = __GIT_SHA__;
export const IS_DEV = __DEV_BUILD__;
export const BUILD = `${VERSION}+${GIT_SHA}`;

/** Как часто спрашивать сервер о новой версии. */
const CHECK_INTERVAL_MS = 60_000;

export type UpdateListener = (available: string) => void;

/**
 * Следит за появлением новой сборки.
 *
 * Ничего не перезагружает сам: выдёргивать игрока из забега ради обновления
 * хуже, чем показать ему ненавязчивую отметку. Применяется при следующей
 * перезагрузке, которую делает человек.
 */
export function watchForUpdates(onAvailable: UpdateListener): () => void {
  let stopped = false;

  const check = async (): Promise<void> => {
    if (stopped) return;
    try {
      // no-store, иначе проверка читает тот же кеш, из-за которого
      // и затевалась, и молча сообщает «всё свежее».
      const res = await fetch('/version.json', { cache: 'no-store' });
      if (!res.ok) return;
      const remote = (await res.json()) as { commit?: string; sha?: string; version?: string };
      // Сверяется КОММИТ, а не строка версии.
      //
      // На проде манифест пишет deploy-kit, и его `version` — метка релиза
      // вида `release-20260803-165343-ba4f3c9`, которая не совпадает с нашей
      // никогда. Сравнение по ней объявляло бы обновление при каждой
      // проверке. Коммит же есть в обоих форматах и означает ровно то, что
      // нужно: собрано из другого исходника — значит, обновление.
      //
      // Прежний код искал поле `build`, которого в манифесте deploy-kit нет
      // вовсе. Ломалось это молча: проверка честно ходила на сервер и всегда
      // получала undefined, то есть «обновлений нет» — навсегда.
      const remoteSha = remote.commit ?? remote.sha;
      if (remoteSha && remoteSha !== GIT_SHA) onAvailable(remote.version ?? remoteSha);
    } catch {
      // Сеть недоступна — не повод шуметь: игра полностью работает офлайн.
    }
  };

  void check();
  const timer = setInterval(() => void check(), CHECK_INTERVAL_MS);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Зарегистрировать service worker. Только в продакшене: в dev он мешает HMR. */
export async function registerServiceWorker(): Promise<void> {
  if (IS_DEV || !('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch {
    // Без service worker игра работает, просто без офлайна.
  }
}

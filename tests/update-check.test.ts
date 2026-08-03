/**
 * Проверка обновлений против настоящего манифеста прода.
 *
 * Тест существует из-за дефекта, который прожил до первой выкатки: клиент
 * искал в манифесте поле `build`, а на проде файл пишет deploy-kit — и такого
 * поля там нет вовсе. Проверка честно ходила на сервер, получала undefined и
 * молча решала, что обновлений нет. Навсегда.
 *
 * Поэтому образцы ниже — не выдумка, а два формата, которые реально лежат по
 * адресу `/version.json`: наш собственный (локально и в артефакте сборки) и
 * манифест deploy-kit (на проде, поверх нашего).
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

const GIT_SHA = 'ba4f3c9';

/** Манифест deploy-kit — то, что лежит на die.samoy.love. */
const kitManifest = (commit: string) => ({
  version: `release-20260803-165343-${commit}`,
  commit,
  builtAt: '2026-08-03T16:54:09+03:00',
  changelog: '<b>Изменения</b>\n• Заложить детерминированное ядро игры\n',
});

/** Наш манифест — то, что пишет scripts/write-version.ts. */
const ownManifest = (sha: string) => ({
  version: '0.1.0',
  sha,
  commit: sha,
  build: `0.1.0+${sha}`,
  builtAt: '2026-08-03T13:30:52.177Z',
});

/**
 * Модуль читает версию из define-констант сборки, поэтому импортируется
 * заново на каждый случай — уже с подставленными значениями.
 */
async function loadWatcher(manifest: unknown, ok = true) {
  vi.stubGlobal('__VERSION__', '0.1.0');
  vi.stubGlobal('__GIT_SHA__', GIT_SHA);
  vi.stubGlobal('__DEV_BUILD__', false);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => manifest })),
  );
  vi.resetModules();
  return await import('../packages/client/src/version');
}

/** Дождаться первой проверки: она уходит немедленно, но асинхронно. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('проверка обновлений', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('видит обновление в манифесте deploy-kit', async () => {
    const { watchForUpdates } = await loadWatcher(kitManifest('0000abc'));
    const seen: string[] = [];
    const stop = watchForUpdates((v) => seen.push(v));
    await settle();
    stop();
    expect(seen).toHaveLength(1);
  });

  // Главное свойство: молчать, когда на сервере ровно то же, что у нас.
  // Ложное «доступна новая версия» на каждой проверке приучает его
  // игнорировать, и настоящее обновление тоже пройдёт мимо.
  it('молчит, когда на проде тот же коммит', async () => {
    const { watchForUpdates } = await loadWatcher(kitManifest(GIT_SHA));
    const seen: string[] = [];
    const stop = watchForUpdates((v) => seen.push(v));
    await settle();
    stop();
    expect(seen).toEqual([]);
  });

  it('понимает и наш собственный манифест', async () => {
    const { watchForUpdates } = await loadWatcher(ownManifest('0000abc'));
    const seen: string[] = [];
    const stop = watchForUpdates((v) => seen.push(v));
    await settle();
    stop();
    expect(seen).toHaveLength(1);
  });

  it('не шумит, когда манифест недоступен', async () => {
    const { watchForUpdates } = await loadWatcher({}, false);
    const seen: string[] = [];
    const stop = watchForUpdates((v) => seen.push(v));
    await settle();
    stop();
    expect(seen).toEqual([]);
  });
});

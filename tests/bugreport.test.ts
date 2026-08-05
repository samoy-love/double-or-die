/**
 * Баг-репорт: что попадает в файл и что не имеет права в него попасть.
 *
 * Телеметрии в 0.4.0 нет (ROADMAP §0.4.0, SECURITY §10), и единственный канал
 * обратной связи — файл, который тестер отправляет сам. Отсюда два предмета
 * проверки. Первый: по файлу забег обязан переигрываться — то есть лог инпутов
 * в нём настоящий, а версии рядом те, без которых он не сойдётся. Второй:
 * набор полей закрыт. Личного в отчёте нет, и проверяется это списком ключей,
 * а не обещанием в комментарии — «заодно пригодится» попадает в такие файлы
 * само.
 */

import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { ReplayRecorder, deserialize } from '@dod/sim/replay';
import { CONFIG_VERSION, PROTOCOL_VERSION } from '@dod/shared';

const VERSION = '0.4.0';
const SHA = 'ba4f3c9';

/** Модуль читает версию из define-констант сборки — импортируем со стабами. */
async function loadModule() {
  vi.stubGlobal('__VERSION__', VERSION);
  vi.stubGlobal('__GIT_SHA__', SHA);
  vi.stubGlobal('__DEV_BUILD__', true);
  vi.resetModules();
  return await import('@dod/client/bugreport');
}

/** Забег из трёх тиков: достаточно, чтобы лог был непустым и переигрывался. */
function subject(seed = 4242, tick = 3) {
  const rec = new ReplayRecorder({
    seed,
    playerCount: 2,
    configVersion: CONFIG_VERSION,
    build: `${VERSION}+${SHA}`,
  });
  const frame = { moveX: 0, moveY: 0, aimX: 0, aimY: 0, buttons: 0 };
  for (let t = 0; t < tick; t++) rec.record([frame, frame]);
  return {
    state: { seed, playerCount: 2, tick },
    snapshotReplay: () => rec.finish(),
    hash: () => '0x6d095352',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('состав отчёта', () => {
  it('забег из отчёта переигрывается', async () => {
    const { buildReport } = await loadModule();
    const r = buildReport(subject(), 'manual');
    const replay = deserialize(r.replay);
    expect(replay.seed).toBe(4242);
    expect(replay.playerCount).toBe(2);
    expect(replay.ticks).toBe(3);
  });

  it('рядом с логом лежат все версии, без которых он не сойдётся', async () => {
    const { buildReport } = await loadModule();
    const r = buildReport(subject(), 'manual');
    expect(r.configVersion).toBe(CONFIG_VERSION);
    expect(r.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(r.version).toBe(VERSION);
    expect(r.sha).toBe(SHA);
    expect(r.build).toBe(`${VERSION}+${SHA}`);
    expect(r.hash).toBe('0x6d095352');
  });

  it('набор полей закрыт — ничего личного', async () => {
    const { buildReport } = await loadModule();
    const manual = buildReport(subject(), 'manual');
    const auto = buildReport(subject(), 'invariant', 'кошелёк отрицательный');

    const allowed = [
      'kind',
      'format',
      'reason',
      'message',
      'version',
      'sha',
      'build',
      'protocolVersion',
      'configVersion',
      'seed',
      'playerCount',
      'tick',
      'hash',
      'replay',
    ];
    expect(Object.keys(manual).sort()).toEqual(allowed.filter((k) => k !== 'message').sort());
    expect(Object.keys(auto).sort()).toEqual([...allowed].sort());
    // Адрес страницы, строка браузера и содержимое сейва — самые вероятные
    // кандидаты «заодно»: у первых двух личное внутри, третий не помогает
    // воспроизвести вовсе.
    const text = JSON.stringify(auto);
    for (const banned of ['userAgent', 'href', 'location', 'localStorage', 'dod.save']) {
      expect(text).not.toContain(banned);
    }
  });

  it('имя файла держит сид, тик и коммит', async () => {
    const { buildReport, reportFileName } = await loadModule();
    expect(reportFileName(buildReport(subject(77, 5), 'manual'))).toBe(
      'dod-bug-77-t5-ba4f3c9.json',
    );
  });
});

describe('скачивание и автоотчёт', () => {
  let clicks: { download: string; href: string }[];

  beforeEach(() => {
    clicks = [];
    vi.useFakeTimers();
    // Минимальный DOM: отчёт уходит ссылкой на Blob и никуда больше — ни
    // одного сетевого вызова здесь быть не может, и подставлять нечего.
    vi.stubGlobal('document', {
      createElement: () => {
        const a = { href: '', download: '', click: () => clicks.push({ ...a }) };
        return a;
      },
    });
    // Подменяются два метода, а не весь `URL`: глобальный конструктор нужен
    // самому загрузчику модулей, и его подмена роняет импорт раньше теста.
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:отчёт');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  it('файл скачивается локально', async () => {
    const { downloadBugReport } = await loadModule();
    const r = downloadBugReport(subject(), 'manual');
    vi.runAllTimers();
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe(`dod-bug-4242-t3-${SHA}.json`);
    expect(clicks[0].href).toBe('blob:отчёт');
    expect(r.reason).toBe('manual');
  });

  it('нарушенный инвариант собирает отчёт сам — и ровно один раз', async () => {
    const { autoReport } = await loadModule();
    const state = { fired: false };
    const first = autoReport(subject(), 'кошелёк отрицательный', state);
    const second = autoReport(subject(), 'кошелёк отрицательный', state);
    vi.runAllTimers();

    expect(first?.reason).toBe('invariant');
    expect(first?.message).toBe('кошелёк отрицательный');
    // Второй файл не появляется: после снятия паузы нарушение повторяется, а
    // пачка одинаковых файлов в «Загрузках» гарантирует, что не прочитают ни
    // одного.
    expect(second).toBeNull();
    expect(clicks).toHaveLength(1);
  });
});

/**
 * Общий гейт-чек для tests/abstract-calibration-*.test.ts — вынесен сюда,
 * а не продублирован в каждом файле, потому что 4 профиля живут в 4 разных
 * файлах НАМЕРЕННО (см. шапку каждого из них): `collectFullSimMetrics` на
 * 200 забегов — синхронный CPU-bound код, `it.concurrent` внутри одного
 * файла его не распараллелит (один поток JS), а `vitest` умеет разносить
 * разные *файлы* по отдельным процессам (`pool: 'forks'`, vitest.config.ts).
 * Раздельные файлы — это и есть распараллеливание, без него ничего не стоит.
 */
import { expect } from 'vitest';
import { calibrationChecks, collectFullSimMetrics, type RoomInput } from '@dod/tools/abstract';

/**
 * Объём гейта — из окружения, умолчания те же, что были жёстко зашиты.
 *
 * 200 забегов — измеренный минимум (см. шапку
 * `abstract-calibration-novice-single.test.ts`): меньше — шум редких событий
 * валит и верную модель, урезать нельзя. Переменные окружения не снижают
 * умолчание, а поднимают его для полного ночного прогона по расписанию или
 * вручную (`CALIBRATION_RUNS=50000 CALIBRATION_TICKS=16000
 * CALIBRATION_TIMEOUT_MS=900000 npm run test:calibration`) — тем же гейтом,
 * без отдельного скрипта, который иначе разошёлся бы с проверяемым кодом.
 */
export const GATE_TICKS = Number(process.env.CALIBRATION_TICKS) || 6000;
export const GATE_RUNS = Number(process.env.CALIBRATION_RUNS) || 200;
export const THRESHOLD = 0.1;

/**
 * 240с — измеренный максимум на CI при объёме по умолчанию (102с у
 * `veteran:chips`, см. шапку `abstract-calibration-novice-single.test.ts`).
 * Поднятый объём ночного прогона обязан поднять и таймаут тем же переключателем.
 */
export const GATE_TIMEOUT_MS = Number(process.env.CALIBRATION_TIMEOUT_MS) || 240_000;

export function runCalibrationGate(
  skill: RoomInput['skill'],
  strategy: RoomInput['strategy'],
): void {
  const full = collectFullSimMetrics(skill, strategy, GATE_RUNS, GATE_TICKS, 100_000);

  // Этаж 1 — единственный, до которого доживает достаточно забегов на
  // 200 прогонах при 6000 тиках: второй и третий этажи здесь дают
  // считаные комнаты, и статистика по ним слишком шумная для 10-процентного
  // порога. Ночной прогон (больше тиков, больше забегов) обязан снять
  // это ограничение и проверить все три этажа.
  const floor1 = full.find((f) => f.floor === 1);
  expect(floor1).toBeDefined();
  if (!floor1) return;
  // Знаменатель попаданий и дохода — комнаты НАЧАТЫЕ, их всегда хватает
  // (каждый забег даёт минимум одну). Длительность требует комнат
  // ЗАКОНЧЕННЫХ, и с ними жёстче: `novice` часто гибнет на первой.
  expect(floor1.sampleRoomsEntered).toBeGreaterThan(20);

  const input: RoomInput = { floor: 1, room: 4, players: 1, skill, strategy };
  const checks = calibrationChecks(input, floor1, undefined, THRESHOLD);

  for (const check of checks) {
    expect(
      check.ok,
      `${check.metric}: модель ${check.model.toFixed(3)} vs симуляция ${check.real.toFixed(3)} ` +
        `(расхождение ${(check.relativeError * 100).toFixed(1)}%)`,
    ).toBe(true);
  }
}

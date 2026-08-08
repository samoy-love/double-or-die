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

/** Хватает, чтобы прожить весь первый этаж и заглянуть на второй у большинства профилей. */
export const GATE_TICKS = 6000;
export const GATE_RUNS = 200;
export const THRESHOLD = 0.1;

export function runCalibrationGate(skill: RoomInput['skill'], strategy: RoomInput['strategy']): void {
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

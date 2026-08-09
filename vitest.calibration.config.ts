import { defineConfig } from 'vitest/config';
import { aliases } from './vite.config.ts';

/**
 * Калибровочный гейт (`tests/abstract-calibration-*.test.ts`) живёт в своём
 * конфиге, а не просто без `exclude` основного: `npm test` (vitest.config.ts)
 * исключает эти файлы явно, чтобы каждый коммит не платил 107 из 113с их
 * веса трижды — по разу на ОС в матрице `determinism` (DEVLOOP §6А). Гейт
 * при этом остаётся тем же самым, тем же объёмом (200 забегов на профиль,
 * `tests/helpers/calibration-gate.ts`) — «нельзя урезать» касается объёма
 * выборки, а не того, каким файлом его запускают.
 *
 * Объём и длина забега читаются из окружения (`CALIBRATION_RUNS`,
 * `CALIBRATION_TICKS`, `CALIBRATION_TIMEOUT_MS`) самим гейтом — этот конфиг
 * их не знает и не обязан: полный ночной прогон по всем профилям запускает
 * тот же `npm run test:calibration`, выставив их выше умолчания.
 */
export default defineConfig({
  resolve: { alias: aliases },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/abstract-calibration-*.test.ts'],
    pool: 'forks',
    execArgv: ['--expose-gc'],
    sequence: { shuffle: false },
  },
});

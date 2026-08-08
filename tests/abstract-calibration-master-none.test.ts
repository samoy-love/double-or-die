/**
 * Калибровка абстрактной модели против полной симуляции (SIMULATION.md §2),
 * профиль `master:none` — верхняя граница навыка, ставок не берёт.
 *
 * Почему это отдельный файл, а не один из четырёх `it` в общем файле, и
 * почему 200 забегов — см. шапку `abstract-calibration-novice-single.test.ts`
 * (та же логика для всех четырёх профилей гейта, повторять незачем).
 */
import { describe, it } from 'vitest';
import { runCalibrationGate, THRESHOLD } from './helpers/calibration-gate';

describe('калибровка абстрактной модели (SIMULATION §2)', () => {
  it(
    `master:none — расхождение с полной симуляцией не больше ${THRESHOLD * 100}%`,
    () => {
      runCalibrationGate('master', 'none');
    },
    60_000,
  );
});

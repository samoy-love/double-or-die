/**
 * Калибровка абстрактной модели против полной симуляции (SIMULATION.md §2),
 * профиль `median:stack` — опорный профиль SIMULATION §3 на самой
 * требовательной по ставкам стратегии.
 *
 * Почему это отдельный файл, а не один из четырёх `it` в общем файле, и
 * почему 200 забегов — см. шапку `abstract-calibration-novice-single.test.ts`
 * (та же логика для всех четырёх профилей гейта, повторять незачем).
 */
import { describe, it } from 'vitest';
import { GATE_TIMEOUT_MS, runCalibrationGate, THRESHOLD } from './helpers/calibration-gate';

describe('калибровка абстрактной модели (SIMULATION §2)', () => {
  it(
    `median:stack — расхождение с полной симуляцией не больше ${THRESHOLD * 100}%`,
    () => {
      runCalibrationGate('median', 'stack');
    },
    GATE_TIMEOUT_MS,
  );
});

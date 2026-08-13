/**
 * Гейт каталога экранов: снимается всё, что в игре есть.
 *
 * Инструмент съёмки (`npm run shots`) видит ровно то, что перечислено в
 * `scripts/screens.ts`, а ревью видит ровно то, что снято. Значит забытый в
 * каталоге экран не проверяет никто и никогда — и обнаруживается это не
 * тестом, а через месяц, когда игрок присылает скриншот с наложенными
 * надписями.
 *
 * Поэтому каталог проверяется машиной: каждая фаза забега обязана иметь свой
 * сценарий, а каждый шаг сценария — существующую отладочную ручку. Второе
 * важнее, чем кажется: сценарий с опечаткой в имени ручки падает только в
 * момент съёмки, то есть посреди ревью и у того, кто его не писал.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunPhase } from '../packages/sim/src/state';
import { Phase, RESOLUTIONS, SCREENS } from '../scripts/screens';

/** Имена методов отладочного API — из его же объявления, а не копией. */
const debugApiMethods = (): Set<string> => {
  const src = readFileSync(
    join(import.meta.dirname, '..', 'packages', 'client', 'src', 'debug.ts'),
    'utf8',
  );
  const start = src.indexOf('export interface DebugApi {');
  expect(start, 'объявление DebugApi не найдено — тест устарел').toBeGreaterThan(0);
  const body = src.slice(start, src.indexOf('\n}', start));
  return new Set([...body.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\s*\(/gm)].map((m) => m[1]));
};

describe('каталог экранов', () => {
  it('идентификаторы уникальны', () => {
    const ids = SCREENS.map((s) => s.id);
    expect(new Set(ids).size, 'два состояния с одним id перезапишут снимок').toBe(ids.length);
  });

  it('у каждого состояния есть название и что проверять', () => {
    for (const s of SCREENS) {
      expect(s.title.length, `${s.id}: пустое название`).toBeGreaterThan(0);
      expect(s.checks.length, `${s.id}: не сказано, что проверять на кадре`).toBeGreaterThan(0);
    }
  });

  it('каждая фаза забега покрыта хотя бы одним состоянием', () => {
    const covered = new Set(SCREENS.map((s) => s.phase as number));
    const phases: [string, RunPhase][] = [
      ['Door', RunPhase.Door],
      ['Fight', RunPhase.Fight],
      ['Reward', RunPhase.Reward],
      ['Boss', RunPhase.Boss],
      ['HouseCut', RunPhase.HouseCut],
      ['Summary', RunPhase.Summary],
    ];
    for (const [name, phase] of phases) {
      expect(covered.has(phase), `фаза ${name} не снимается ни одним сценарием`).toBe(true);
    }
    // Клиентские экраны — меню, справка, настройки, пауза — живут вне фаз ядра
    // и обязаны сниматься так же.
    expect(covered.has(Phase.Client), 'клиентские экраны не снимаются').toBe(true);
  });

  it('шаги сценариев зовут существующие отладочные ручки', () => {
    const methods = debugApiMethods();
    expect(
      methods.size,
      'из объявления DebugApi не удалось прочитать ни одного метода',
    ).toBeGreaterThan(10);
    const missing: string[] = [];
    for (const screen of SCREENS) {
      for (const step of screen.steps) {
        if (!('call' in step)) continue;
        if (!methods.has(step.call)) missing.push(`${screen.id} → ${step.call}`);
      }
    }
    expect(missing, 'сценарий зовёт ручку, которой нет в отладочном API').toEqual([]);
  });

  it('разрешения покрывают настоящие экраны игрока', () => {
    const sizes = RESOLUTIONS.map((r) => `${r.w}x${r.h}`);
    // Steam Deck — обязателен: это первая целевая машина проекта, и на ней
    // интерфейс мельче всего.
    expect(sizes, 'Steam Deck не снимается').toContain('1280x800');
    expect(sizes, 'Full HD не снимается').toContain('1920x1080');
  });
});

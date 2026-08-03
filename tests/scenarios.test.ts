/**
 * Сценарии как гейт.
 *
 * Сценарий отвечает на вопрос «что игра делает» словами, которые понятны без
 * чтения кода. Ради этого он и лежит отдельным файлом: правка баланса или
 * механики обязана менять читаемый документ, а не только числа в тесте.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScenario, runScenario } from '../packages/tools/src/scenario';

const DIR = join(__dirname, 'scenarios');

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();

describe('сценарии', () => {
  it('сценарии на месте', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s', (f) => {
    const sc = parseScenario(readFileSync(join(DIR, f), 'utf8'), f);
    const r = runScenario(sc);
    // Провалы выводятся списком целиком: чинить их по одному, перезапуская
    // прогон после каждого, дороже ровно во столько раз, сколько их есть.
    expect(r.failures).toEqual([]);
  });

  it('ловит несбывшееся ожидание', () => {
    const r = runScenario({
      name: 'заведомо ложное',
      steps: [{ tick: 60 }, { expect: { player: 0, travelled: { min: 10_000 } } }],
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/путь игрока 0/);
  });

  it('отвергает неизвестную кнопку, а не игнорирует её', () => {
    const r = runScenario({
      name: 'опечатка в кнопке',
      steps: [{ input: { player: 0, buttons: ['fier'] } }],
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/неизвестная кнопка/);
  });

  it('внятно отказывается разбирать испорченный файл', () => {
    expect(() => parseScenario('{ это не json', 'x.json')).toThrow(/не разбирается как JSON/);
    expect(() => parseScenario('{"steps":[]}', 'x.json')).toThrow(/нет поля name/);
  });
});

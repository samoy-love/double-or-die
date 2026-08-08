/**
 * Отказ пересъёмки численного корпуса — текстом, а не трассировкой.
 *
 * `tests/golden` держит эталоны двух схем (см. историю golden.ts, 0.3.11):
 * численный корпус `seed-N-pP`, который пересчитывает `--record-golden`, и
 * записи с подготовленного состояния (`scenario-*`), которые пишет другой
 * код и никогда не называет по этой схеме. `diagnoseCorpus` обязана отличать
 * одно от другого и не советовать `--runs`, которое эталон другой схемы
 * всё равно никогда не «накроет».
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diagnoseCorpus } from '@dod/tools/goldenCorpus';

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const golden = (bot: string) => JSON.stringify({ format: 1, name: 'x', bot, checkpoints: [] });

describe('diagnoseCorpus', () => {
  it('пропускает чистый численный корпус, покрытый целиком', () => {
    dir = mkdtempSync(join(tmpdir(), 'golden-'));
    const names = ['seed-1-p1', 'seed-2-p2', 'seed-3-p3', 'seed-4-p4'];
    for (const n of names) writeFileSync(join(dir, `${n}.json`), golden('random'));

    expect(diagnoseCorpus(names.map((n) => `${n}.json`), dir, 4, 1, 'random')).toBeNull();
  });

  it('отказывает на эталон другой схемы и не предлагает --runs его накрыть', () => {
    dir = mkdtempSync(join(tmpdir(), 'golden-'));
    const files = ['seed-1-p1.json', 'scenario-boss-p1.json'];
    writeFileSync(join(dir, files[0]), golden('random'));
    writeFileSync(join(dir, files[1]), golden('master:chips'));

    const msg = diagnoseCorpus(files, dir, 1, 1, 'random');
    expect(msg).not.toBeNull();
    expect(msg).toContain('scenario-boss-p1');
    expect(msg).toContain('другой схемы');
    // Совет ДОБАВИТЬ --runs относится только к сиротам численного корпуса —
    // эталон другой схемы под ним не совпадёт никогда, и предлагать его как
    // способ решения означало бы врать про то, что команда умеет.
    expect(msg).not.toMatch(/добавьте --runs/);
  });

  it('отказывает на сироту численного корпуса и предлагает --runs', () => {
    dir = mkdtempSync(join(tmpdir(), 'golden-'));
    const files = ['seed-1-p1.json', 'seed-2-p2.json'];
    for (const f of files) writeFileSync(join(dir, f), golden('random'));

    const msg = diagnoseCorpus(files, dir, 1, 1, 'random');
    expect(msg).not.toBeNull();
    expect(msg).toContain('seed-2-p2');
    expect(msg).toMatch(/--runs 2/);
  });

  it('отказывает при смене бота корпуса', () => {
    dir = mkdtempSync(join(tmpdir(), 'golden-'));
    const files = ['seed-1-p1.json'];
    writeFileSync(join(dir, files[0]), golden('random'));

    const msg = diagnoseCorpus(files, dir, 1, 1, 'runner');
    expect(msg).not.toBeNull();
    expect(msg).toContain('«random»');
    expect(msg).toContain('«runner»');
  });
});

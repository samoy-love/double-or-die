/**
 * Отчёт готовности ассетов.
 *
 * Ассеты должны быть так же проверяемы, как код (PRODUCTION §8). Проверяются
 * три вещи, каждая из которых иначе всплывает уже на проде: файл на месте,
 * лицензия указана, ссылка из кода жива.
 *
 * В геймплее растровых ассетов нет вовсе — всё рисуется кодом, — поэтому
 * список короткий и таким должен остаться. Каждая новая строка здесь это
 * повод спросить, почему её нельзя нарисовать.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

type Stage = 'placeholder' | 'final';
type Source = 'procedural' | 'ai' | 'library' | 'own';

interface Asset {
  id: string;
  file: string;
  source: Source;
  license: string;
  stage: Stage;
  /** Файл, из которого на ассет ссылаются: мёртвая ссылка — дефект. */
  usedBy: string;
  note?: string;
}

interface Manifest {
  version: number;
  assets: Asset[];
}

function main(): void {
  const manifestPath = join(ROOT, 'assets', 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const problems: string[] = [];
  const rows: string[] = [];

  for (const a of manifest.assets) {
    const file = join(ROOT, a.file);
    if (!existsSync(file)) {
      problems.push(`${a.id}: файла нет — ${a.file}`);
      continue;
    }
    if (!a.license.trim()) problems.push(`${a.id}: не указана лицензия`);

    const userPath = join(ROOT, a.usedBy);
    if (!existsSync(userPath)) {
      problems.push(`${a.id}: ссылающийся файл пропал — ${a.usedBy}`);
    } else {
      // Имя файла должно встречаться там, где на него ссылаются: иначе
      // ассет живёт в репозитории, но в игру не попадает.
      const name = a.file.split('/').pop() ?? a.file;
      if (!readFileSync(userPath, 'utf8').includes(name)) {
        problems.push(`${a.id}: ${a.usedBy} больше не ссылается на ${name}`);
      }
    }

    const size = statSync(file).size;
    rows.push(
      `  ${a.stage === 'final' ? '✓' : '·'} ${a.id.padEnd(16)} ${String(size).padStart(7)} Б  ${a.source}  ${a.license}`,
    );
  }

  const placeholders = manifest.assets.filter((a) => a.stage === 'placeholder').length;

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify({
        ok: problems.length === 0,
        total: manifest.assets.length,
        placeholders,
        problems,
      }),
    );
  } else {
    console.log(`ассетов: ${manifest.assets.length}, из них плейсхолдеров: ${placeholders}\n`);
    for (const r of rows) console.log(r);
    if (problems.length > 0) {
      console.error('\nпроблемы:');
      for (const p of problems) console.error(`  ✗ ${p}`);
    } else {
      console.log('\nвсё на месте: файлы, лицензии и ссылки из кода');
    }
  }
  process.exit(problems.length === 0 ? 0 : 1);
}

main();

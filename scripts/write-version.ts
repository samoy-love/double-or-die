/**
 * Манифест версии для проверки обновлений и для сверки после выкатки.
 *
 * По нему клиент узнаёт о новой сборке, а deploy-kit проверяет, что на проде
 * лежит именно то, что собрали. «Зелёный деплой со старыми файлами» ловится
 * ровно здесь.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

const sha = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'nogit';
  }
})();

const manifest = {
  version: pkg.version,
  sha,
  build: `${pkg.version}+${sha}`,
  // Время сборки, а не время запуска: попадает в баг-репорты и помогает
  // понять, какой именно артефакт лежит на машине.
  builtAt: new Date().toISOString(),
};

mkdirSync('dist', { recursive: true });
writeFileSync(join('dist', 'version.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`version.json: ${manifest.build}`);

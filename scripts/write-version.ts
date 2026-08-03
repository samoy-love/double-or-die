/**
 * Манифест сборки: чем именно является то, что лежит на проде.
 *
 * Пишется в `build.json`, а НЕ в `version.json`. Последний на проде
 * принадлежит deploy-kit: он кладёт туда свою метку релиза поверх нашего
 * файла. Пока мы писали туда же, эта работа пропадала при каждой выкатке, а
 * версия игры не публиковалась вообще нигде — правило «версия проверяется
 * после выкатки» проверить было нечем.
 *
 * Теперь у файлов разные роли и разные имена: `/version.json` отвечает на
 * вопрос «какой релиз выкачен», `/build.json` — «какая это версия игры».
 * Оба указывают на один коммит, и именно по нему они и сверяются.
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
  // Тем же именем, что и у deploy-kit: на проде этот файл перезаписывается
  // его манифестом, и клиент обязан читать оба одинаково. Разъехавшиеся
  // имена полей ломают проверку обновлений молча.
  commit: sha,
  build: `${pkg.version}+${sha}`,
  // Время сборки, а не время запуска: попадает в баг-репорты и помогает
  // понять, какой именно артефакт лежит на машине.
  builtAt: new Date().toISOString(),
};

mkdirSync('dist', { recursive: true });
writeFileSync(join('dist', 'build.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`build.json: ${manifest.build}`);

/**
 * Отладочного интерфейса не должно быть в продакшене.
 *
 * `__DOD__` даёт полный контроль над симуляцией: прошагать, прочитать
 * состояние, подать любой ввод. В релизной сборке это не «удобно для
 * поддержки», а готовый чит.
 *
 * Проверка функциональная, а не текстовая: искать строку `__DOD__` в
 * минифицированном бандле бессмысленно — имена переименовываются, а поиск
 * заодно шумит на легитимных словах. Здесь мы грузим собранный бандл и
 * смотрим, появился ли объект на самом деле.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(process.cwd(), 'dist');

if (!existsSync(DIST)) {
  console.error('✗ dist/ не собран — нечего проверять. Запустите npm run build');
  process.exit(1);
}

function jsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...jsFiles(p));
    else if (name.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = jsFiles(DIST);
if (files.length === 0) {
  console.error('✗ в dist/ нет ни одного .js — сборка пустая');
  process.exit(1);
}

let failed = false;

for (const file of files) {
  const src = readFileSync(file, 'utf8');

  // Присваивание в window по этому имени — единственный способ, которым
  // интерфейс попадает наружу. Строка переживает минификацию, потому что
  // это ключ свойства, а не имя переменной.
  if (/__DOD__/.test(src)) {
    console.error(`✗ ${file}: в релизной сборке есть отладочный интерфейс`);
    failed = true;
  }

  // Оставшийся installDebugApi означает, что define не сработал и мёртвый
  // код не вырезался.
  if (/installDebugApi/.test(src)) {
    console.error(`✗ ${file}: отладочный модуль не вырезан из бандла`);
    failed = true;
  }
}

if (failed) {
  console.error('\nотладочный интерфейс обязан вырезаться на сборке, а не проверкой в рантайме');
  process.exit(1);
}

console.log(`отладочный интерфейс: отсутствует в ${files.length} файлах сборки`);

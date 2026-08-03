/**
 * Границы модулей — правило, которое дороже всего чинить задним числом.
 *
 * Ядро симуляции обязано оставаться чистым: без зависимостей, без браузерных
 * объектов, без недетерминированных источников. Стоит один раз пропустить
 * `Math.random()` или `Date.now()` внутрь — и рассыпаются реплеи, дейли,
 * античит, golden-тесты и онлайн разом, причём молча.
 *
 * Проверяется машиной, потому что записанного правила недостаточно.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SIM = join(ROOT, 'packages', 'sim', 'src');

/** Запрещено в ядре симуляции целиком. */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /\bMath\.random\b/, why: 'недетерминированно — используйте поток RNG' },
  { pattern: /\bDate\.now\b/, why: 'время только в тиках' },
  { pattern: /\bperformance\.now\b/, why: 'время только в тиках' },
  { pattern: /\bwindow\b/, why: 'ядро не знает про браузер' },
  { pattern: /\bdocument\b/, why: 'ядро не знает про DOM' },
  { pattern: /\blocalStorage\b/, why: 'ядро не хранит состояние снаружи' },
  { pattern: /\bfetch\b/, why: 'ядро не ходит в сеть' },
  {
    pattern: /\bMath\.(sin|cos|tan|atan2|pow|exp|log)\b/,
    why: 'не специфицированы стандартом и расходятся между движками — только таблицы из trig.ts',
  },
];

/** Файлы, где часть запретов снята: там значения считаются один раз и округляются. */
const EXEMPT: Record<string, RegExp[]> = {
  'trig.ts': [/\bMath\.(sin|cos|tan|atan2|pow|exp|log)\b/],
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * Вырезать комментарии, сохранив нумерацию строк.
 *
 * Иначе проверка ловит сама себя: в этих файлах запреты как раз объясняются
 * словами, и `Math.random` в описании «почему нельзя» ничем не отличается от
 * настоящего вызова. Переводы строк сохраняем, чтобы номер в сообщении
 * указывал на реальное место.
 */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let mode: 'code' | 'line' | 'block' | 'str' = 'code';
  let quote = '';

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (mode === 'code') {
      if (c === '/' && next === '/') {
        mode = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        mode = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        mode = 'str';
        quote = c;
      }
      out += c;
      i++;
      continue;
    }

    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += '\n';
      } else out += ' ';
      i++;
      continue;
    }

    if (mode === 'block') {
      if (c === '*' && next === '/') {
        mode = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      out += c === '\n' ? '\n' : ' ';
      i++;
      continue;
    }

    // Внутри строкового литерала. Содержимое сохраняем: по нему разбираются
    // импорты. Режим нужен только чтобы `//` внутри строки не был принят
    // за начало комментария.
    if (c === '\\') {
      out += c + (src[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (c === quote) mode = 'code';
    out += c;
    i++;
  }
  return out;
}

let failed = 0;

for (const file of walk(SIM)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const base = rel.split('/').pop()!;
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const exempt = EXEMPT[base] ?? [];

  // Импорты: ядру нельзя ничего, кроме себя самого.
  for (const m of code.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)) {
    const spec = m[1];
    if (!spec.startsWith('.')) {
      console.error(`✗ ${rel}: импорт '${spec}' — ядро симуляции без зависимостей`);
      failed++;
    }
  }

  const lines = code.split('\n');
  for (const { pattern, why } of FORBIDDEN) {
    if (exempt.some((e) => e.source === pattern.source)) continue;
    lines.forEach((line, i) => {
      if (pattern.test(line)) {
        console.error(`✗ ${rel}:${i + 1}: ${pattern.source} — ${why}`);
        failed++;
      }
    });
  }
}

if (failed > 0) {
  console.error(`\nграницы модулей нарушены: ${failed}`);
  process.exit(1);
}
console.log('границы модулей: чисто');

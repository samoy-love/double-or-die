/**
 * Границы модулей — правило, которое дороже всего чинить задним числом.
 *
 * Проверяется две вещи, и обе одинаково важны.
 *
 * 1. **Чистота ядра.** Симуляция обязана оставаться без зависимостей, без
 *    браузерных объектов, без недетерминированных источников. Стоит один раз
 *    пропустить `Math.random()` или `Date.now()` внутрь — и рассыпаются
 *    реплеи, дейли, античит, golden-тесты и онлайн разом, причём молча.
 *
 * 2. **Направление зависимостей между пакетами** (TECH §10): `sim` не
 *    импортирует ничего, `shared` не импортирует ничего, `client` импортирует
 *    `sim` и `shared`, `tools` — то же самое. Обратная стрелка не ломает
 *    сборку сразу: она ломает портируемость ядра, которой куплены реплеи,
 *    античит и порт на консоли, — и обнаруживается через год, когда `sim`
 *    уже не вынуть из клиента.
 *
 * Проверяется машиной, потому что записанного правила недостаточно.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PACKAGES = join(ROOT, 'packages');

/** Пакеты монорепозитория и то, на что каждому позволено ссылаться (TECH §10). */
const ALLOWED_DEPS: Record<string, readonly string[]> = {
  sim: [],
  shared: [],
  client: ['sim', 'shared'],
  tools: ['sim', 'shared'],
};

/**
 * Точечные исключения из направления зависимостей: файл → пакет.
 *
 * Список обязан оставаться коротким и объяснённым. Каждая строка здесь —
 * дыра в правиле, и без причины рядом она через полгода станет прецедентом
 * («там же можно»), а правило — декорацией.
 *
 * `bench.ts` меряет систему частиц в Node, а живёт она в клиенте: бюджет
 * кадра нельзя замерить по копии. Это чтение измерительным инструментом,
 * который никуда не поставляется, а не зависимость игры от клиента.
 */
const DEP_EXCEPTIONS: { file: string; to: string; why: string }[] = [
  {
    file: 'packages/tools/src/bench.ts',
    to: 'client',
    why: 'бенч меряет систему частиц там, где она живёт; инструмент не поставляется',
  },
];

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
  /*
   * `Math.hypot` — тот же класс риска, что `Math.sin`, и он не в общей строке
   * выше намеренно: у `trig.ts` снята экзепция ровно на тригонометрию, а
   * считать длину через `Math.hypot` нельзя и там. Стандарт не задаёт ни
   * точность, ни порядок промежуточных операций (реализации по-разному
   * масштабируют аргументы против переполнения), и результаты движков
   * расходятся в последних битах. Длина считается `length()` из fixed.ts.
   */
  {
    pattern: /\bMath\.hypot\b/,
    why: 'точность не задана стандартом и расходится между движками — используйте length() из fixed.ts',
  },
  /*
   * `Array.sort` без компаратора сортирует по строковому представлению и,
   * что важнее, до ES2019 не был обязан быть устойчивым. Порядок обхода —
   * источник состояния в детерминированной симуляции: перестановка двух
   * равных элементов меняет хеш. Ловим только пустые скобки — вызов с
   * компаратором законен, и ложных срабатываний у этой формы нет.
   */
  {
    pattern: /\.sort\s*\(\s*\)/,
    why: 'сортировка без полного компаратора — порядок обхода в ядре обязан быть задан явно (TECH §2.1)',
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

/**
 * Все формы, которыми один модуль дотягивается до другого.
 *
 * Одного `import … from '…'` мало, и это не теоретическая придирка:
 * `packages/sim/src/index.ts` состоит из `export * from` целиком, то есть
 * главный файл ядра проверкой не покрывался вовсе. Кавычки — все три:
 * двойные и обратные в TypeScript законны ровно так же, как одинарные.
 */
const SPEC_PATTERNS: RegExp[] = [
  // import … from '…'  /  export … from '…'  /  export * from '…'
  /\b(?:import|export)\b[^;'"`]*\bfrom\s*(['"`])([^'"`]+)\1/g,
  // import '…' — импорт ради побочного эффекта
  /\bimport\s*(['"`])([^'"`]+)\1/g,
  // import('…') — динамический
  /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
];

/** Спецификатор и номер строки, на которой он написан. */
function imports(code: string): { spec: string; line: number }[] {
  const found = new Map<string, number>();
  for (const re of SPEC_PATTERNS) {
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) {
      const line = code.slice(0, m.index).split('\n').length;
      const key = `${m[2]} ${line}`;
      if (!found.has(key)) found.set(key, line);
    }
  }
  return [...found.keys()].map((k) => ({ spec: k.split(' ')[0], line: found.get(k)! }));
}

/** В какой пакет монорепозитория попадает путь (или null, если ни в какой). */
function packageOf(absPath: string): string | null {
  const rel = relative(PACKAGES, absPath).replace(/\\/g, '/');
  if (rel.startsWith('..')) return null;
  const first = rel.split('/')[0];
  return first in ALLOWED_DEPS ? first : null;
}

/**
 * Куда ведёт спецификатор: имя пакета, `external` для внешнего или null для
 * пути внутри того же пакета.
 */
function targetOf(spec: string, fromFile: string): string | 'external' | null {
  if (spec.startsWith('.')) {
    const abs = resolve(dirname(fromFile), spec);
    const pkg = packageOf(abs);
    return pkg === packageOf(fromFile) ? null : (pkg ?? 'external');
  }
  // Именованные пакеты монорепозитория: связь та же, что относительным путём.
  const named = /^@dod\/([a-z]+)/.exec(spec);
  if (named && named[1] in ALLOWED_DEPS) {
    return named[1] === packageOf(fromFile) ? null : named[1];
  }
  return 'external';
}

let failed = 0;
const fail = (msg: string): void => {
  console.error(`✗ ${msg}`);
  failed++;
};

for (const pkg of Object.keys(ALLOWED_DEPS)) {
  const dir = join(PACKAGES, pkg, 'src');
  let files: string[];
  try {
    files = walk(dir);
  } catch {
    // Пакет объявлен структурой, но исходников ещё нет — это не нарушение.
    continue;
  }

  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const base = rel.split('/').pop()!;
    const code = stripComments(readFileSync(file, 'utf8'));

    for (const { spec, line } of imports(code)) {
      const target = targetOf(spec, file);
      if (target === null) continue;

      if (target === 'external') {
        // Ноль зависимостей у ядра — требование SECURITY §7: самая критичная
        // часть кода не имеет поверхности атаки через npm вовсе. То же и у
        // `shared`: его читает будущий сервер, и тащить туда npm незачем.
        if (ALLOWED_DEPS[pkg].length === 0) {
          fail(`${rel}:${line}: импорт '${spec}' — пакет ${pkg} без внешних зависимостей`);
        }
        continue;
      }

      if (ALLOWED_DEPS[pkg].includes(target)) continue;
      if (DEP_EXCEPTIONS.some((e) => e.file === rel && e.to === target)) continue;

      const allowed = ALLOWED_DEPS[pkg];
      fail(
        `${rel}:${line}: ${pkg} → ${target} ('${spec}') — ` +
          `${pkg} импортирует ${allowed.length ? allowed.join(' и ') : 'ничего'} (TECH §10)`,
      );
    }

    if (pkg !== 'sim') continue;

    const exempt = EXEMPT[base] ?? [];
    const lines = code.split('\n');
    for (const { pattern, why } of FORBIDDEN) {
      if (exempt.some((e) => e.source === pattern.source)) continue;
      lines.forEach((line, i) => {
        if (pattern.test(line)) fail(`${rel}:${i + 1}: ${pattern.source} — ${why}`);
      });
    }
  }
}

if (failed > 0) {
  console.error(`\nграницы модулей нарушены: ${failed}`);
  process.exit(1);
}
console.log('границы модулей: чисто (чистота ядра + направления между пакетами)');

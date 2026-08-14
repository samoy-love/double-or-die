/**
 * Видимый текст живёт только в словаре.
 *
 * Проверка не про аккуратность. Локализация на семь языков (UX §8) держится на
 * одном допущении: всё, что игрок читает, лежит в `content/strings.json`.
 * Работает оно ровно до первой строки, вписанной в код напрямую, — и эта
 * строка не переводится, не проверяется на переполнение макета и не попадает
 * к переводчику вовсе. Найдётся она в отзыве на чужом языке через полгода.
 *
 * Ловится иначе только вычиткой всего клиента глазами, на каждом релизе.
 *
 * ## Что считается видимой строкой
 *
 * Строковый литерал с кириллицей в коде клиента. Кириллица — рабочий признак,
 * а не определение: русский здесь исходный язык, и настоящая пропущенная
 * строка пишется по-русски. Латинский литерал так не поймать — `'Wave 2/3'` от
 * идентификатора события не отличить машиной, — и об этом честнее сказать
 * прямо, чем изображать полноту: тот случай закрывает ревью.
 *
 * ## Что не считается
 *
 * **Сообщения разработчику.** `throw`, `console` и протокол логов
 * (`log`/`logError`) читают двое, и платить за их перевод семью языками не за
 * что. Признак — строка стоит в такой конструкции, а не её содержание.
 *
 * **Отладочный интерфейс и отчёт по контрасту.** Оба целиком инструменты:
 * `debug.ts` вырезается из релизной сборки, а подписи `contrast.ts` уходят в
 * отчёт CI, а не на экран. Список исключений обязан оставаться коротким —
 * каждая строка в нём это файл, где непереведённый текст пройдёт молча.
 *
 * ## Ключи проверяются тоже
 *
 * Мало запретить строку — надо, чтобы ключ, которым её заменили, существовал.
 * Ключ из `t('...')`, которого нет в словаре, компилятор поймает типом, но
 * только пока модуль сгенерирован заново; проверка ловит его и до генерации.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SCAN = join(ROOT, 'packages', 'client', 'src');
const STRINGS = join(ROOT, 'content', 'strings.json');

/** Сам словарь и то, что из него сгенерировано. */
const ALLOWED = new Set(['packages/client/src/strings.generated.ts']);

/**
 * Исключено осознанно, а не забыто.
 *
 * `debug.ts` и подсистемы под `debug/` — отладочный интерфейс, вырезаемый из
 * релиза (`check:no-debug-api` стоит на страже этого отдельно). `contrast.ts`
 * — подписи пар в отчёте о контрасте: они уходят в лог CI, а не игроку.
 */
const EXCLUDED = new Set(['packages/client/src/debug.ts', 'packages/client/src/contrast.ts']);
const EXCLUDED_DIRS = ['packages/client/src/debug/'];

/** Конструкции, чей текст адресован разработчику, а не игроку. */
const DEV_CONTEXT = /\bthrow\b|\bconsole\s*\.|\blogError\s*\(|\blog\s*\(/;

const CYRILLIC = /[А-Яа-яЁё]/;

/** Литералы всех трёх видов. Многострочные шаблоны не разбираются намеренно. */
const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\\n]|\\.)*`/g;

/** Обращение к словарю: `t('ключ')`. */
const CALL = /\bt\(\s*'([^']+)'/g;

interface Finding {
  file: string;
  line: number;
  text: string;
  what: string;
}

/**
 * Убрать комментарии, сохранив нумерацию строк.
 *
 * Без этого линтер спотыкается о собственную документацию: в комментарии к
 * словарю строки упоминаются по определению.
 */
function stripComments(src: string): string {
  let out = '';
  let inBlock = false;
  let inLine = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];

    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      } else {
        out += ' ';
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        out += '  ';
        i++;
      } else {
        out += c === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      out += '  ';
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      out += '  ';
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (extname(p) === '.ts') acc.push(p);
  }
  return acc;
}

function knownKeys(): Set<string> {
  const raw = JSON.parse(readFileSync(STRINGS, 'utf8')) as {
    languages: Record<string, Record<string, string>>;
  };
  const first = Object.keys(raw.languages)[0];
  return new Set(Object.keys(raw.languages[first]));
}

function main(): void {
  const findings: Finding[] = [];
  const keys = knownKeys();
  let checked = 0;

  for (const file of walk(SCAN)) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    if (ALLOWED.has(rel) || EXCLUDED.has(rel) || EXCLUDED_DIRS.some((d) => rel.startsWith(d)))
      continue;
    checked++;

    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      const at = (what: string): void => {
        findings.push({ file: rel, line: i + 1, text: line.trim(), what });
      };

      if (!DEV_CONTEXT.test(line)) {
        for (const m of line.matchAll(LITERAL)) {
          if (CYRILLIC.test(m[0])) at('видимая строка мимо словаря');
        }
      }
      for (const m of line.matchAll(CALL)) {
        if (!keys.has(m[1])) at(`ключа ${m[1]} нет в словаре`);
      }
    });
  }

  if (findings.length === 0) {
    console.log(`i18n: ${checked} файлов клиента, весь видимый текст из словаря`);
    return;
  }

  console.error('текст мимо словаря:\n');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.what}`);
    console.error(`    ${f.text}`);
  }
  console.error(`\nвсего: ${findings.length}. Строки заводятся в content/strings.json.`);
  process.exit(1);
}

main();

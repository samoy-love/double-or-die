/**
 * Цвет живёт только в палитре.
 *
 * Проверка не про аккуратность. Перекраска под дальтонизм, смена настроения
 * биома и замер контраста по ΔE делаются в одном месте — и работают ровно до
 * первого цвета, вписанного мимо палитры. Разъехавшись, палитры ломают
 * «двойное кодирование формой и цветом», то есть доступность, а не вкус.
 *
 * Ловится это иначе только глазами и только на том мониторе, где смотрели.
 *
 * Разрешено: сам модуль палитры и таблицы стилей. Запрещено: шестнадцатеричный
 * цвет, rgb()/rgba()/hsl()/hsla() и цветовые слова CSS в коде отрисовки.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SCAN = [join(ROOT, 'packages', 'client', 'src')];

/** Единственный файл, которому цвета положены по должности. */
const ALLOWED = new Set(['packages/client/src/palette.ts']);

interface Finding {
  file: string;
  line: number;
  text: string;
  what: string;
}

const RULES: { what: string; re: RegExp }[] = [
  { what: 'шестнадцатеричный цвет', re: /#[0-9a-fA-F]{3,8}\b/ },
  { what: 'числовой литерал цвета', re: /0x[0-9a-fA-F]{6}\b/ },
  { what: 'функция цвета', re: /\b(rgba?|hsla?)\s*\(/ },
  // Цветовые слова: ловим присваивание, а не любое упоминание в тексте.
  {
    what: 'цветовое слово CSS',
    re: /(fillStyle|strokeStyle|shadowColor|color)\s*=\s*['"](?!#)[a-z]{3,}['"]/,
  },
];

/**
 * Убрать комментарии и содержимое строк-разделителей, сохранив нумерацию.
 *
 * Без этого линтер спотыкается о собственную документацию: в комментарии к
 * палитре цвета упоминаются по определению.
 */
function stripNoise(src: string): string {
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

function main(): void {
  const findings: Finding[] = [];

  for (const dir of SCAN) {
    for (const file of walk(dir)) {
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      if (ALLOWED.has(rel)) continue;

      const lines = stripNoise(readFileSync(file, 'utf8')).split('\n');
      lines.forEach((line, i) => {
        for (const rule of RULES) {
          if (rule.re.test(line)) {
            findings.push({ file: rel, line: i + 1, text: line.trim(), what: rule.what });
            break;
          }
        }
      });
    }
  }

  if (findings.length === 0) {
    console.log('палитра: цвета только в palette.ts');
    return;
  }

  console.error('цвет мимо палитры:\n');
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.what}`);
    console.error(`    ${f.text}`);
  }
  console.error(`\nвсего: ${findings.length}. Цвета заводятся в packages/client/src/palette.ts.`);
  process.exit(1);
}

main();

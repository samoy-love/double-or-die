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
 *
 * ## Разметка проверяется тоже
 *
 * Точка входа — это тоже поверхность игры: `theme-color` красит строку
 * браузера на телефоне, а фон страницы виден в первый кадр до того, как
 * канвас что-нибудь нарисует. Цвет, вписанный туда мимо палитры, не
 * перекрашивается под дальтоника и не участвует в замере ΔE — то есть ровно
 * тот же дефект, что и в коде отрисовки, только заметный ещё позже.
 *
 * Импортировать `palette.ts` из HTML нельзя, поэтому правило для разметки
 * другое по форме и то же по сути: **цвет в HTML обязан существовать в
 * палитре**. Разъехаться молча он после этого не может — правка палитры,
 * забытая в разметке, валит проверку.
 *
 * ## Почему style.css больше не исключён
 *
 * Он был исключён с обоснованием «ради трёх правил заводить генератор
 * переменных дороже, чем стоит выгода». Редизайн 0.4.0 эту цену предъявил:
 * палитра сменилась целиком, а фон страницы остался прежним, фиолетовым, и не
 * заметил никто — единственная проверка, которая могла бы заметить, этот файл
 * не читала. Правил стало шесть, впереди экраны забега, и сторона выгоды
 * перевесила. Цвета уехали в переменные `--dod-*`, которые ставит
 * `applyCssVariables` из палитры, а в самом CSS цветов не осталось вовсе.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** Код отрисовки: цвет разрешён только в палитре. */
const SCAN_CODE = [join(ROOT, 'packages', 'client', 'src')];

/** Разметка: цвет разрешён, если он есть в палитре. */
const SCAN_MARKUP = [ROOT, join(ROOT, 'public')];

/** Единственный файл, которому цвета положены по должности. */
const ALLOWED = new Set(['packages/client/src/palette.ts']);

/**
 * Исключено осознанно, а не забыто. Список обязан оставаться коротким: каждая
 * строка здесь — место, где цвет может разъехаться с палитрой незамеченным.
 */
const EXCLUDED = new Set<string>([]);

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
    else if (extname(p) === '.ts' || extname(p) === '.css') acc.push(p);
  }
  return acc;
}

/** Разметка в каталоге, без рекурсии: точка входа и то, что раздаётся как есть. */
function htmlIn(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => extname(n) === '.html')
    .map((n) => join(dir, n))
    .filter((p) => statSync(p).isFile())
    .sort();
}

const PALETTE_FILE = join(ROOT, 'packages', 'client', 'src', 'palette.ts');

/**
 * Цвета, которые в палитре действительно есть, — в нормальном виде `#rrggbb`.
 *
 * Палитра пишет их как `hex(0x1a1033)`, разметка — как `#1a1033`. Сравнивать
 * надо значения, а не написание, иначе проверка развалится от смены регистра.
 */
function paletteColors(): Set<string> {
  const src = readFileSync(PALETTE_FILE, 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/0x([0-9a-fA-F]{6})\b/g)) out.add(`#${m[1].toLowerCase()}`);
  return out;
}

/** Нормализовать `#abc` и `#AABBCC` к одному виду `#aabbcc`. */
function normalizeHex(h: string): string {
  const v = h.slice(1).toLowerCase();
  return v.length === 3 ? `#${v[0]}${v[0]}${v[1]}${v[1]}${v[2]}${v[2]}` : `#${v}`;
}

function scanCode(findings: Finding[]): void {
  for (const dir of SCAN_CODE) {
    for (const file of walk(dir)) {
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      if (ALLOWED.has(rel) || EXCLUDED.has(rel)) continue;

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
}

function scanMarkup(findings: Finding[], known: Set<string>): void {
  const seen = new Set<string>();
  for (const dir of SCAN_MARKUP) {
    for (const file of htmlIn(dir)) {
      const rel = relative(ROOT, file).replace(/\\/g, '/');
      if (seen.has(rel) || EXCLUDED.has(rel)) continue;
      seen.add(rel);

      // HTML-комментарии режем по той же причине, что и в коде: в них цвета
      // объясняются словами.
      const text = readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, (c) =>
        c.replace(/[^\n]/g, ' '),
      );
      text.split('\n').forEach((line, i) => {
        const add = (what: string): void => {
          findings.push({ file: rel, line: i + 1, text: line.trim(), what });
        };

        for (const m of line.matchAll(/#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?\b/g)) {
          if (!known.has(normalizeHex(m[0]))) add(`цвета ${m[0]} нет в палитре`);
        }
        // Функции цвета в разметке не сверить с палитрой построчно и незачем:
        // писать их там нечего вовсе.
        if (/\b(rgba?|hsla?)\s*\(/.test(line)) add('функция цвета в разметке');
      });
    }
  }
}

function main(): void {
  const findings: Finding[] = [];
  scanCode(findings);
  scanMarkup(findings, paletteColors());

  if (findings.length === 0) {
    console.log('палитра: цвета только в palette.ts, разметка с ней сходится');
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

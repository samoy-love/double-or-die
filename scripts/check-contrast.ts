/**
 * Различимость цветов по ΔE — гейт доступности.
 *
 * Палитра разнесена по ΔE вручную и в комментариях (см. `palette.ts`), но
 * записанное число не проверяет ничего: любая правка оттенка «чтобы покрасивее»
 * тихо сближает пару, которую игрок обязан различать за 0.2 секунды. Заметить
 * это глазами нельзя — сближение на единицу-две незаметно поштучно и смертельно
 * накопительно, — а последствие конкретное: игрок 4 читается как Клин, за
 * картой бегут как за фишкой, телеграф теряется на фоне.
 *
 * Сама проверка живёт в клиенте (`packages/client/src/contrast.ts`): там же
 * палитра, там же список обязательных пар и порог, и двух списков быть не
 * должно. Здесь — только гейт: посчитать, напечатать таблицу и упасть.
 *
 * Таблица печатается ВСЯ, а не только провалы. Гейт, который молчит при успехе,
 * не даёт увидеть, что запас по паре «фишка / карта» усох с 20 до 20.1 и
 * следующая правка её уронит.
 *
 *     npm run check:contrast
 *     npm run check:contrast -- --json     машинный вывод
 *     npm run check:contrast -- --min 25   отчёт по более строгому порогу
 */

import { checkContrast, DELTA_E_MIN, type ContrastResult } from '../packages/client/src/contrast';

interface Options {
  min: number;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const o: Options = { min: DELTA_E_MIN, json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--json') {
      o.json = true;
    } else if (k === '--min') {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v <= 0) {
        console.error(`--min: ожидалось положительное число, получено «${argv[i]}»`);
        process.exit(2);
      }
      o.min = v;
    } else {
      console.error(`неизвестный аргумент: ${k}`);
      process.exit(2);
    }
  }
  return o;
}

/** Ширина колонки по самой длинной строке: иначе таблица разъезжается. */
const widest = (xs: string[]): number => xs.reduce((w, x) => Math.max(w, x.length), 0);

function printTable(rows: ContrastResult[], min: number): void {
  // По возрастанию ΔE: сверху то, что ближе всего к порогу, — именно оно
  // упадёт следующим, и именно его надо видеть первым.
  const sorted = [...rows].sort((x, y) => x.deltaE - y.deltaE);
  const wa = widest(sorted.map((r) => r.a));
  const wb = widest(sorted.map((r) => r.b));

  console.log(`пары «карта / игрок / фишка / враг / телеграф», порог ΔE2000 ≥ ${min}\n`);
  for (const r of sorted) {
    const mark = r.ok ? ' ' : '✗';
    const de = r.deltaE.toFixed(1).padStart(6);
    console.log(`  ${mark} ${r.a.padEnd(wa)} / ${r.b.padEnd(wb)}  ΔE ${de}   ${r.why}`);
  }
}

function main(): void {
  const o = parseArgs(process.argv.slice(2));

  let rows: ContrastResult[];
  try {
    rows = checkContrast(o.min);
  } catch (e) {
    // Пара ссылается на цвет, которого в палитре больше нет: переименовали
    // или удалили. Это тоже провал гейта, а не техническая ошибка запуска.
    console.error(`контраст: список пар разошёлся с палитрой — ${String(e)}`);
    process.exit(1);
  }

  const failed = rows.filter((r) => !r.ok);

  if (o.json) {
    console.log(JSON.stringify({ ok: failed.length === 0, min: o.min, pairs: rows }));
    process.exit(failed.length === 0 ? 0 : 1);
  }

  printTable(rows, o.min);

  if (failed.length === 0) {
    const tightest = rows.reduce((a, b) => (a.deltaE <= b.deltaE ? a : b));
    console.log(
      `\nконтраст: ${rows.length} пар, все выше порога; ` +
        `самая тесная — ${tightest.a} / ${tightest.b} (ΔE ${tightest.deltaE.toFixed(1)})`,
    );
    return;
  }

  console.error(`\nпар ниже порога: ${failed.length} из ${rows.length}.`);
  console.error('Цвета правятся в packages/client/src/palette.ts, пары — в contrast.ts.');
  process.exit(1);
}

main();

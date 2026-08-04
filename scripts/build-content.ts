/**
 * Пари — данные, а не код (TECH §11), но ядру симуляции нельзя ни файлов, ни
 * зависимостей. Отсюда этот генератор.
 *
 * `content/bets.json` — источник правды: его правит балансировщик, его читает
 * будущий редактор в админке, он же уедет в remote config. Схема на Zod
 * проверяет его в CI. А ядро получает те же числа готовым модулем, который
 * генерируется отсюда и лежит в репозитории рядом с кодом.
 *
 * Почему не импортировать JSON прямо в ядро: `sim` не импортирует ничего, и
 * это правило дороже удобства — на нём стоят реплеи, античит и порт на
 * консоли. Сгенерированный модуль остаётся чистым TypeScript без зависимостей.
 *
 * Дрейф ловится в CI: `--check` пересобирает модуль в память и сравнивает с
 * закоммиченным. Разошлись — значит кто-то правил одно, забыв про другое.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const ROOT = join(import.meta.dirname, '..');
const SOURCE = join(ROOT, 'content', 'bets.json');
const TARGET = join(ROOT, 'packages', 'sim', 'src', 'bets.generated.ts');

/**
 * Как считается прогресс `q` — доля пути, пройденного под риском
 * (ECONOMY §9А). Строкой, а не функцией: функция в данных перестала бы быть
 * данными и не пережила бы ни валидацию, ни remote config.
 */
const Progress = z.enum([
  /** Доля прошедшего времени от лимита: темповые пари. */
  'time',
  /** Выполнено / требуется: счётчиковые. */
  'counter',
  /** Доля зачищенного бюджета угрозы комнаты: удержания и пространственные. */
  'threat',
]);

const Category = z.enum(['style', 'tempo', 'space', 'greed', 'tricks', 'silly']);

/**
 * Схемы ввода — вторая ось матрицы «пари × схема ввода» (GDD §9.5).
 *
 * Порядок значим: он же становится номером бита в маске и номером в
 * `InputScheme`, поэтому новая схема дописывается В КОНЕЦ. Перестановка тихо
 * переназначила бы исключения уже выпущенным пари.
 */
const SCHEMES = ['gamepad', 'keyboard', 'touch'] as const;
const Scheme = z.enum(SCHEMES);

const Bet = z
  .object({
    /** Совпадает с идентификатором хука детекции в коде (GDD §9.5). */
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** Русское имя из каталога. Условие на карте — не длиннее 28 знаков. */
    name: z.string().min(1).max(28),
    category: Category,
    /** Множитель на карте. Этажный с 0.4.0, пока каталожный. */
    multiplier: z.number().min(1.1).max(10),
    progress: Progress,
    /** Для темповых: лимит в тиках. Секунд в конфиге симуляции не бывает. */
    limitTicks: z.number().int().positive().optional(),
    /** Для счётчиковых: сколько требуется. */
    target: z.number().int().positive().optional(),
    /** Несовместимые пари: вместе в раскладку не попадают (GDD §9.5). */
    conflicts: z.array(z.string()),
    /**
     * Схемы ввода, на которых пари невыполнимо (GDD §9.5).
     *
     * Матрица «пари × схема ввода» существует затем, чтобы игрок не получал
     * карту, которую физически не может отыграть: пари на контроль выстрелов
     * бессмысленно на таче с автоогнём. Поле необязательное — у большинства
     * пари исключений нет, и пустой массив в каждой записи был бы шумом.
     */
    excludeSchemes: z.array(Scheme).optional(),
  })
  .refine((b) => (b.progress === 'time') === (b.limitTicks !== undefined), {
    message: 'темповому пари нужен limitTicks, остальным он не нужен',
  })
  .refine((b) => (b.progress === 'counter') === (b.target !== undefined), {
    message: 'счётчиковому пари нужен target, остальным он не нужен',
  })
  .refine((b) => new Set(b.excludeSchemes ?? []).size === (b.excludeSchemes?.length ?? 0), {
    message: 'схема ввода перечислена в исключениях дважды',
  })
  // Пари, исключённое на всех схемах разом, не выпадет никому и никогда:
  // это не настройка, а вычёркивание пари из каталога окольным путём.
  .refine((b) => (b.excludeSchemes?.length ?? 0) < SCHEMES.length, {
    message: 'пари исключено на всех схемах ввода — его не получит никто',
  });

const Catalog = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    bets: z.array(Bet).min(1),
  })
  .refine((c) => new Set(c.bets.map((b) => b.id)).size === c.bets.length, {
    message: 'идентификаторы пари повторяются',
  })
  .refine(
    (c) => {
      const ids = new Set(c.bets.map((b) => b.id));
      return c.bets.every((b) => b.conflicts.every((x) => ids.has(x)));
    },
    { message: 'конфликт ссылается на несуществующее пари' },
  )
  .refine(
    (c) => {
      // Конфликт обязан быть взаимным: односторонний означает, что пара
      // всё-таки может выпасть вместе — смотря какую вытянули первой.
      const map = new Map(c.bets.map((b) => [b.id, new Set(b.conflicts)]));
      return c.bets.every((b) => b.conflicts.every((x) => map.get(x)?.has(b.id)));
    },
    { message: 'конфликт объявлен только с одной стороны' },
  );

type Catalog = z.infer<typeof Catalog>;

/** Множитель в Q16.16: в ядре дробных чисел не бывает. */
const toFixed16 = (v: number): number => Math.round(v * 65536);

/** `no_red_zone` → `NoRedZone`: идентификатор данных в имя члена перечисления. */
const pascal = (s: string): string =>
  s
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('');

function generate(catalog: Catalog): string {
  const ids = catalog.bets.map((b, i) => `  ${pascal(b.id)} = ${i},`).join('\n');

  const lines = catalog.bets.map((b) => {
    // Конфликты и схемы уезжают в ядро БИТОВЫМИ МАСКАМИ, а не списками имён:
    // проверка совместимости идёт на каждой выдаваемой карте, а сравнение
    // строк и обход массива в горячем пути запрещены (TECH §4).
    // Конфликт взаимен по смыслу: если «без рывка» не уживается с «без
    // урона», то и обратное верно. Требовать, чтобы обе записи перечислили
    // друг друга, значит однажды получить односторонний конфликт — карты
    // легли бы вместе или порознь в зависимости от того, какая выпала
    // первой, и ловилось бы это только глазами на редком забеге.
    const conflictMask = catalog.bets.reduce(
      (m, other, i) =>
        b.conflicts.includes(other.id) || other.conflicts.includes(b.id) ? m | (1 << i) : m,
      0,
    );
    const schemeMask = (b.excludeSchemes ?? []).reduce((m, s) => m | (1 << SCHEMES.indexOf(s)), 0);
    const parts = [
      `    id: '${b.id}'`,
      `    name: '${b.name}'`,
      `    category: BetCategory.${b.category[0].toUpperCase()}${b.category.slice(1)}`,
      `    multiplier: ${toFixed16(b.multiplier)}`,
      `    progress: BetProgress.${b.progress[0].toUpperCase()}${b.progress.slice(1)}`,
      `    limitTicks: ${b.limitTicks ?? 0}`,
      `    target: ${b.target ?? 0}`,
      `    conflictMask: ${conflictMask}`,
      `    schemeMask: ${schemeMask}`,
    ];
    return `  {\n${parts.join(',\n')},\n  },`;
  });

  const schemes = SCHEMES.map((s, i) => `  ${pascal(s)} = ${i},`).join('\n');

  return `/**
 * СГЕНЕРИРОВАННЫЙ ФАЙЛ. Правьте content/bets.json и запускайте npm run content.
 *
 * Пари живут данными (TECH §11), а ядро симуляции не читает файлов и не имеет
 * зависимостей — поэтому каталог приезжает сюда генератором. Расхождение
 * источника и этого файла ловит CI.
 */

/** Категория пари. Цвет и иконка на карте берутся отсюда. */
export const enum BetCategory {
  Style = 0,
  Tempo = 1,
  Space = 2,
  Greed = 3,
  Tricks = 4,
  Silly = 5,
}

/** Как считается доля пройденного под риском пути (ECONOMY §9А). */
export const enum BetProgress {
  /** Доля прошедшего времени от лимита. */
  Time = 0,
  /** Выполнено / требуется. */
  Counter = 1,
  /** Доля зачищенного бюджета угрозы комнаты. */
  Threat = 2,
}

/**
 * Схема ввода игрока — вторая ось матрицы «пари × схема ввода» (GDD §9.5).
 *
 * Номер значения — это номер бита в \`schemeMask\`, поэтому новая схема
 * дописывается только в конец.
 */
export const enum InputScheme {
${schemes}
}

/**
 * Номер пари в каталоге.
 *
 * Хуки детекции сравнивают ЭТИ числа, а не строковые идентификаторы: хук
 * вроде «игрок в красной зоне» проверяется каждый тик на каждом игроке, и
 * сравнение строк там стоит дороже самой проверки. Строковый \`id\` остаётся
 * для данных, отладки и сценариев (TECH §4).
 */
export const enum BetId {
${ids}
}

export interface BetSpec {
  readonly id: string;
  readonly name: string;
  readonly category: BetCategory;
  /** Множитель в Q16.16. */
  readonly multiplier: number;
  readonly progress: BetProgress;
  /** Лимит для темповых, в тиках. Ноль — не темповое. */
  readonly limitTicks: number;
  /** Сколько требуется для счётчиковых. Ноль — не счётчиковое. */
  readonly target: number;
  /** Маска несовместимых пари: бит с номером \`BetId\`. */
  readonly conflictMask: number;
  /** Маска схем ввода, на которых пари невыполнимо: бит с номером \`InputScheme\`. */
  readonly schemeMask: number;
}

export const BETS: readonly BetSpec[] = [
${lines.join('\n')}
];

export const BET_COUNT = BETS.length;
`;
}

function main(): void {
  const raw = JSON.parse(readFileSync(SOURCE, 'utf8')) as unknown;
  const parsed = Catalog.safeParse(raw);
  if (!parsed.success) {
    console.error('✗ content/bets.json не проходит схему:\n');
    for (const issue of parsed.error.issues) {
      console.error(`  ${issue.path.join('.') || '(корень)'}: ${issue.message}`);
    }
    process.exit(1);
  }

  const generated = generate(parsed.data);

  if (process.argv.includes('--check')) {
    const current = readFileSync(TARGET, 'utf8');
    if (current !== generated) {
      console.error('✗ packages/sim/src/bets.generated.ts разошёлся с content/bets.json');
      console.error('  Запустите npm run content и закоммитьте результат.');
      process.exit(1);
    }
    console.log(`каталог пари: ${parsed.data.bets.length}, сгенерированное совпадает`);
    return;
  }

  writeFileSync(TARGET, generated);
  console.log(`каталог пари: ${parsed.data.bets.length} → ${TARGET}`);
}

main();

/**
 * Пари, апгрейды и строки — данные, а не код (TECH §11), но ядру симуляции
 * нельзя ни файлов, ни зависимостей. Отсюда этот генератор.
 *
 * `content/bets.json` — источник правды: его правит балансировщик, его читает
 * будущий редактор в админке, он же уедет в remote config. Схема на Zod
 * проверяет его в CI. А ядро получает те же числа готовым модулем, который
 * генерируется отсюда и лежит в репозитории рядом с кодом.
 *
 * `content/upgrades.json` живёт по тем же правилам: чем торгует Лавка и почём
 * — это баланс, а не логика, и трогать его обязано быть можно, не открывая
 * ядра.
 *
 * Почему не импортировать JSON прямо в ядро: `sim` не импортирует ничего, и
 * это правило дороже удобства — на нём стоят реплеи, античит и порт на
 * консоли. Сгенерированный модуль остаётся чистым TypeScript без зависимостей.
 *
 * `content/strings.json` живёт по тем же правилам и по своей причине: словарь
 * правит переводчик, а не программист, и файл, который открывают на семи
 * языках, не имеет права быть исходником на TypeScript. Клиент получает из него
 * модуль с ТИПИЗИРОВАННЫМИ ключами — опечатка в ключе становится ошибкой
 * компиляции, а не пустым местом на экране, замеченным на чужом языке.
 *
 * Дрейф ловится в CI: `--check` пересобирает модули в память и сравнивает с
 * закоммиченными. Разошлись — значит кто-то правил одно, забыв про другое.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const ROOT = join(import.meta.dirname, '..');
const SOURCE = join(ROOT, 'content', 'bets.json');
const TARGET = join(ROOT, 'packages', 'sim', 'src', 'bets.generated.ts');
const UPGRADES_SOURCE = join(ROOT, 'content', 'upgrades.json');
const UPGRADES_TARGET = join(ROOT, 'packages', 'sim', 'src', 'upgrades.generated.ts');
const STRINGS_SOURCE = join(ROOT, 'content', 'strings.json');
const STRINGS_TARGET = join(ROOT, 'packages', 'client', 'src', 'strings.generated.ts');

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

// ---------------------------------------------------------------------------
// Каталог апгрейдов
// ---------------------------------------------------------------------------

/**
 * Что именно меняет апгрейд.
 *
 * Порядок значим ровно так же, как у схем ввода: он становится номером в
 * `UpgradeEffect`, поэтому новый эффект дописывается В КОНЕЦ. Строкой, а не
 * числом, по той же причине, что и прогресс пари: данные обязаны читаться
 * человеком, а не сверяться с перечислением в чужом файле.
 */
const EFFECTS = ['damage', 'heart', 'dash_cooldown', 'magnet', 'drop', 'speed'] as const;
const Effect = z.enum(EFFECTS);

const Upgrade = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  /** Служебное имя: отчёты, сценарии, логи. На экран идёт строка словаря. */
  name: z.string().min(1).max(28),
  /** Базовая цена первого этажа; дальше — `база × 1.5^(F−1)` (ECONOMY §5). */
  base: z.number().int().positive(),
  effect: Effect,
  /** Величина эффекта: процент или единицы арены, смысл задаёт `effect`. */
  value: z.number().int().positive(),
});

const Upgrades = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    upgrades: z.array(Upgrade).min(1),
  })
  .refine((c) => new Set(c.upgrades.map((u) => u.id)).size === c.upgrades.length, {
    message: 'идентификаторы апгрейдов повторяются',
  })
  // Два апгрейда на одну величину складывались бы в разгон, которого в
  // экономике нет, а «без повторов уже купленного» перестало бы что-то значить.
  .refine((c) => new Set(c.upgrades.map((u) => u.effect)).size === c.upgrades.length, {
    message: 'два апгрейда меняют одно и то же',
  });

type Upgrades = z.infer<typeof Upgrades>;

/**
 * Среднее по каталогу обязано быть 45 (ECONOMY §5).
 *
 * Не украшение таблицы: из среднего ценника посчитан бюджет игрока и все
 * четыре профиля сдавливания. Каталог, съехавший со среднего, делает
 * посчитанным не ту игру — и заметить это по отдельным ценникам невозможно.
 */
const MEAN_PRICE = 45;

function checkMeanPrice(catalog: Upgrades): string[] {
  const sum = catalog.upgrades.reduce((acc, u) => acc + u.base, 0);
  if (sum === MEAN_PRICE * catalog.upgrades.length) return [];
  return [
    `среднее по каталогу ${sum / catalog.upgrades.length}, а ECONOMY §5 считает бюджет по ${MEAN_PRICE}`,
  ];
}

function generateUpgrades(catalog: Upgrades): string {
  const ids = catalog.upgrades.map((u, i) => `  ${pascal(u.id)} = ${i},`).join('\n');
  const effects = EFFECTS.map((e, i) => `  ${pascal(e)} = ${i},`).join('\n');

  const lines = catalog.upgrades.map((u) => {
    const parts = [
      `    id: '${u.id}'`,
      `    name: '${u.name}'`,
      `    base: ${u.base}`,
      `    effect: UpgradeEffect.${pascal(u.effect)}`,
      `    value: ${u.value}`,
    ];
    return `  {\n${parts.join(',\n')},\n  },`;
  });

  return `/**
 * СГЕНЕРИРОВАННЫЙ ФАЙЛ. Правьте content/upgrades.json и запускайте npm run content.
 *
 * Апгрейды живут данными (TECH §11), а ядро симуляции не читает файлов и не
 * имеет зависимостей — поэтому каталог приезжает сюда генератором. Расхождение
 * источника и этого файла ловит CI.
 */

/** Что именно меняет апгрейд. Номер значения — позиция в списке эффектов. */
export const enum UpgradeEffect {
${effects}
}

/**
 * Номер апгрейда в каталоге.
 *
 * Он же уезжает в слоты купленного (\`pUpgrades\`) со сдвигом на единицу: ноль
 * там означает пустой слот, иначе первый апгрейд каталога оказался бы у всех
 * и всегда.
 */
export const enum UpgradeId {
${ids}
}

export interface UpgradeSpec {
  readonly id: string;
  readonly name: string;
  /** Базовая цена первого этажа. Цена этажа F — \`база × 1.5^(F−1)\`. */
  readonly base: number;
  readonly effect: UpgradeEffect;
  /** Величина эффекта: процент или единицы арены, смысл задаёт \`effect\`. */
  readonly value: number;
}

export const UPGRADES: readonly UpgradeSpec[] = [
${lines.join('\n')}
];

export const UPGRADE_COUNT = UPGRADES.length;
`;
}

// ---------------------------------------------------------------------------
// Словарь строк
// ---------------------------------------------------------------------------

/**
 * Языки версии 0.4.0 (UX §8). Порядок задаёт порядок в сгенерированном модуле,
 * первый — исходник, с которого переводят остальные.
 */
const LANGS = ['ru', 'en'] as const;
type Lang = (typeof LANGS)[number];

/** Область.точное место[.номер] — `ace.bark.yawn.2`, `overlay.paused`. */
const KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/** Имя подстановки в фигурных скобках: `{count}`, `{seed}`. */
const PLACEHOLDER_RE = /\{([a-z][a-zA-Z0-9]*)\}/g;

const Text = z
  .string()
  .min(1)
  // Перенос — забота раскладки, а не словаря: строка, разбитая `\n` в данных,
  // ломается на первом же языке с другой длиной слов.
  .refine((v) => !v.includes('\n'), { message: 'в строке словаря нет переводов строки' });

const Dictionary = z.record(z.string().regex(KEY_RE), Text);

const Strings = z
  .object({
    $schema: z.string().optional(),
    version: z.literal(1),
    languages: z.object(
      Object.fromEntries(LANGS.map((l) => [l, Dictionary])) as Record<Lang, typeof Dictionary>,
    ),
  })
  // Паритет ключей — главная проверка файла. Языки лежат отдельными таблицами
  // ради переводчика, который работает с языком целиком; цена этого удобства —
  // ровно тот ключ, который забыли в одной из таблиц, и платит её проверка,
  // а не игрок, увидевший пустое место на своём языке.
  .superRefine((c, ctx) => {
    const base = Object.keys(c.languages[LANGS[0]]);
    for (const lang of LANGS.slice(1)) {
      const own = new Set(Object.keys(c.languages[lang]));
      for (const key of base) {
        if (!own.has(key)) ctx.addIssue({ code: 'custom', message: `${lang}: нет ключа ${key}` });
      }
      for (const key of own) {
        if (!base.includes(key)) {
          ctx.addIssue({ code: 'custom', message: `${lang}: лишний ключ ${key}` });
        }
      }
    }
  })
  // Перевод, потерявший `{seed}`, оставляет игрока без номера сида в
  // баг-репорте — и заметить это можно только на том языке, на котором никто
  // не играл.
  .superRefine((c, ctx) => {
    for (const key of Object.keys(c.languages[LANGS[0]])) {
      const base = placeholders(c.languages[LANGS[0]][key]);
      for (const lang of LANGS.slice(1)) {
        const value = c.languages[lang][key];
        if (value === undefined) continue;
        const own = placeholders(value);
        if (base.join(',') !== own.join(',')) {
          ctx.addIssue({
            code: 'custom',
            message: `${lang}: подстановки в ${key} разошлись с ${LANGS[0]} (${base.join(', ') || '—'} против ${own.join(', ') || '—'})`,
          });
        }
      }
    }
  });

type Strings = z.infer<typeof Strings>;

/** Имена подстановок строки, отсортированные: сравнивается набор, а не порядок. */
function placeholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_RE)].map((m) => m[1]).sort();
}

/**
 * Имена каталога — тоже строки словаря, а не поле данных.
 *
 * `name` в `content/bets.json` и `content/upgrades.json` остаётся, но он
 * служебный: по нему запись ищут в сценариях, отчётах балансировщика и логах,
 * и переводить его незачем. На экран же попадает `<область>.<id>.name` из
 * словаря — иначе английская сборка показывала бы русское условие, а каталог
 * пришлось бы держать в семи копиях.
 */
function checkNames(strings: Strings, area: string, ids: readonly string[]): string[] {
  const problems: string[] = [];
  const expected = ids.map((id) => `${area}.${id}.name`);
  const re = new RegExp(`^${area}\\..+\\.name$`);
  const have = Object.keys(strings.languages[LANGS[0]]).filter((k) => re.test(k));

  for (const key of expected) {
    if (!have.includes(key)) problems.push(`в словаре нет имени: ${key}`);
  }
  for (const key of have) {
    if (!expected.includes(key)) problems.push(`имя без записи в каталоге: ${key}`);
  }
  // Условие на карте — не длиннее 28 знаков (GLOSSARY, п. 7). Английское
  // держим в тех же 28: макет, перекроенный под первый же перевод, придётся
  // кроить и под остальные шесть. Ценник лавки живёт в той же ширине по той же
  // причине — это карточка товара, а не строка списка.
  for (const lang of LANGS) {
    for (const key of expected) {
      const value = strings.languages[lang][key];
      if (value !== undefined && value.length > 28) {
        problems.push(`${lang}: ${key} длиннее 28 знаков (${value.length})`);
      }
    }
  }
  return problems;
}

/** Строка в литерал TypeScript. Кавычки одинарные — так же форматирует prettier. */
const quote = (v: string): string => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Пара «ключ: значение» так, как её написал бы prettier.
 *
 * Сгенерированный файл лежит в репозитории и проходит `format:check` наравне с
 * рукописным. Форматировать его отдельным вызовом prettier значило бы завести
 * зависимость генератора от форматтера ради одного правила — переноса длинной
 * строки на следующий уровень отступа. Правило простое, и дешевле повторить
 * его здесь, чем объяснять, почему `npm run content` тянет за собой prettier.
 */
function row(key: string, value: string): string {
  const flat = `    ${key}: ${value},`;
  return flat.length <= 100 ? flat : `    ${key}:\n      ${value},`;
}

function generateStrings(strings: Strings): string {
  const keys = Object.keys(strings.languages[LANGS[0]]).sort();
  const union = keys.map((k) => `  | ${quote(k)}`).join('\n');
  const tables = LANGS.map((lang) => {
    const rows = keys.map((k) => row(quote(k), quote(strings.languages[lang][k]))).join('\n');
    return `  ${lang}: {\n${rows}\n  },`;
  }).join('\n');

  return `/**
 * СГЕНЕРИРОВАННЫЙ ФАЙЛ. Правьте content/strings.json и запускайте npm run content.
 *
 * Весь видимый игроку текст живёт данными (UX §8), а клиенту нужен модуль с
 * типизированными ключами: опечатка в ключе обязана падать компиляцией, а не
 * пустым местом на экране, замеченным на языке, на котором никто не играл.
 * Расхождение источника и этого файла ловит CI.
 */

/** Языки версии 0.4.0. Первый — исходник, с которого переводят остальные. */
export const LANGS = [${LANGS.map(quote).join(', ')}] as const;

export type Lang = (typeof LANGS)[number];

/** Ключ словаря. Список закрыт: строки вне его в игре не бывает. */
export type StringKey =
${union};

export const STRINGS: Record<Lang, Readonly<Record<StringKey, string>>> = {
${tables}
};
`;
}

// ---------------------------------------------------------------------------

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

  const rawUpgrades = JSON.parse(readFileSync(UPGRADES_SOURCE, 'utf8')) as unknown;
  const parsedUpgrades = Upgrades.safeParse(rawUpgrades);
  if (!parsedUpgrades.success) {
    console.error('✗ content/upgrades.json не проходит схему:\n');
    for (const issue of parsedUpgrades.error.issues) {
      console.error(`  ${issue.path.join('.') || '(корень)'}: ${issue.message}`);
    }
    process.exit(1);
  }

  const meanProblems = checkMeanPrice(parsedUpgrades.data);
  if (meanProblems.length > 0) {
    console.error('✗ каталог апгрейдов разошёлся с экономикой:\n');
    for (const p of meanProblems) console.error(`  ${p}`);
    process.exit(1);
  }

  const rawStrings = JSON.parse(readFileSync(STRINGS_SOURCE, 'utf8')) as unknown;
  const parsedStrings = Strings.safeParse(rawStrings);
  if (!parsedStrings.success) {
    console.error('✗ content/strings.json не проходит схему:\n');
    for (const issue of parsedStrings.error.issues) {
      console.error(`  ${issue.path.join('.') || '(корень)'}: ${issue.message}`);
    }
    process.exit(1);
  }

  const nameProblems = [
    ...checkNames(
      parsedStrings.data,
      'bet',
      parsed.data.bets.map((b) => b.id),
    ),
    ...checkNames(
      parsedStrings.data,
      'upgrade',
      parsedUpgrades.data.upgrades.map((u) => u.id),
    ),
  ];
  if (nameProblems.length > 0) {
    console.error('✗ словарь и каталоги разошлись:\n');
    for (const p of nameProblems) console.error(`  ${p}`);
    process.exit(1);
  }

  const generated = generate(parsed.data);
  const generatedUpgrades = generateUpgrades(parsedUpgrades.data);
  const generatedStrings = generateStrings(parsedStrings.data);
  const keyCount = Object.keys(parsedStrings.data.languages[LANGS[0]]).length;

  if (process.argv.includes('--check')) {
    const drift: string[] = [];
    if (readFileSync(TARGET, 'utf8') !== generated) {
      drift.push('packages/sim/src/bets.generated.ts ↔ content/bets.json');
    }
    if (readFileSync(UPGRADES_TARGET, 'utf8') !== generatedUpgrades) {
      drift.push('packages/sim/src/upgrades.generated.ts ↔ content/upgrades.json');
    }
    if (readFileSync(STRINGS_TARGET, 'utf8') !== generatedStrings) {
      drift.push('packages/client/src/strings.generated.ts ↔ content/strings.json');
    }
    if (drift.length > 0) {
      console.error('✗ сгенерированное разошлось с источником:\n');
      for (const d of drift) console.error(`  ${d}`);
      console.error('\n  Запустите npm run content и закоммитьте результат.');
      process.exit(1);
    }
    console.log(
      `каталог пари: ${parsed.data.bets.length}, апгрейдов: ${parsedUpgrades.data.upgrades.length}, словарь: ${keyCount} ключей × ${LANGS.length} языка, сгенерированное совпадает`,
    );
    return;
  }

  writeFileSync(TARGET, generated);
  writeFileSync(UPGRADES_TARGET, generatedUpgrades);
  writeFileSync(STRINGS_TARGET, generatedStrings);
  console.log(`каталог пари: ${parsed.data.bets.length} → ${TARGET}`);
  console.log(`каталог апгрейдов: ${parsedUpgrades.data.upgrades.length} → ${UPGRADES_TARGET}`);
  console.log(`словарь: ${keyCount} ключей × ${LANGS.length} языка → ${STRINGS_TARGET}`);
}

main();

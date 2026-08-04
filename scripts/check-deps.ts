/**
 * Цепочка поставок: уязвимости и лицензии зависимостей.
 *
 * SECURITY §7 требует `npm audit` и проверку лицензий в CI, DEVLOOP §6А ставит
 * «Лицензии зависимостей: аудит, запрет несовместимых» на 0.1.0. Обе проверки
 * ловят разное и обе ловят то, что не видно ни в одном тесте.
 *
 * ## Лицензии читаются из lockfile, а не из node_modules
 *
 * Часть пакетов ставится только под свою платформу (бинарники esbuild и
 * rollup), и на любой конкретной машине половины дерева на диске просто нет.
 * Проверка по `node_modules` дала бы «лицензия неизвестна» у полусотни пакетов
 * на Linux и у другой полусотни на Windows — то есть врала бы по-разному в
 * зависимости от того, кто её запустил. В `package-lock.json` лицензия есть у
 * каждой записи, и это ровно тот список, который поставит `npm ci`.
 *
 * ## Порог строгости аудита выбран, а не взят по умолчанию
 *
 * `npm audit` по умолчанию валится на любой находке, включая `low` в
 * транзитивной зависимости сборщика. Здесь порог — **high и critical**, и
 * причина не в снисходительности:
 *
 *   — Всё, что сейчас стоит в проекте, — `devDependencies`: сборщик, тестовый
 *     раннер, линтер. До игрока они не доезжают вовсе, и ReDoS в парсере
 *     конфигурации не угрожает никому, кроме самого раннера. Продакшен-код
 *     игры зависит от нуля пакетов, а ядро симуляции — тем более (SECURITY §7).
 *   — Красная сборка на low-находке в чужой транзитивной зависимости, которую
 *     нельзя починить своими руками и которая живёт месяцами до апстрим-фикса,
 *     обучает ровно одному: не читать этот шаг. После этого он не поймает и
 *     critical.
 *
 * `moderate` и `low` печатаются, но не валят. `high` и `critical` валят
 * всегда — их чинят подъёмом версии в тот же день.
 *
 *     npm run check:deps
 *     npm run check:deps -- --licenses-only   без сети
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/**
 * Лицензии, совместимые с закрытой коммерческой сборкой.
 *
 * Разрешительные (MIT, ISC, BSD, Apache) — без оговорок. MPL-2.0 — копилефт
 * пофайловый: делиться надо только изменёнными файлами самого пакета, а мы их
 * не меняем, поэтому линковка в сборку законна.
 */
const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'CC-BY-4.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
]);

/**
 * Заведомо несовместимые: сильный копилефт и сетевой копилефт.
 *
 * Игра распространяется закрытыми сборками через Steam и itch. GPL/AGPL/SSPL в
 * дереве зависимостей означают либо открытие исходников, либо снятие пакета —
 * и узнать об этом надо сейчас, а не на юридической проверке перед релизом.
 */
const FORBIDDEN = /\b(AGPL|SSPL|GPL-2\.0|GPL-3\.0|LGPL|CDDL|EPL|CPAL|OSL|EUPL)\b/i;

interface LockEntry {
  license?: string | string[];
  licenses?: { type?: string }[];
  dev?: boolean;
  version?: string;
  /** Симлинк на пакет самого монорепозитория: своё, а не поставка. */
  link?: boolean;
}

/** Имя пакета из ключа lockfile: `node_modules/a/node_modules/@s/b` → `@s/b`. */
function nameOf(key: string): string {
  const i = key.lastIndexOf('node_modules/');
  return i < 0 ? key : key.slice(i + 'node_modules/'.length);
}

function licenseOf(e: LockEntry): string | null {
  if (typeof e.license === 'string') return e.license;
  if (Array.isArray(e.license)) return e.license.join(' OR ');
  const legacy = e.licenses?.map((l) => l.type).filter(Boolean);
  return legacy && legacy.length > 0 ? legacy.join(' OR ') : null;
}

/**
 * Разобрать SPDX-выражение на отдельные идентификаторы.
 *
 * `(MIT OR Apache-2.0)` считается пригодным, если пригоден хотя бы один
 * вариант: выбор за нами. `A AND B` — только если пригодны оба. Разбор
 * намеренно грубый: сложнее этих двух форм в реальных пакетах не встречается,
 * а полноценный парсер SPDX — отдельная зависимость ради десятка строк.
 */
function licenseOk(expr: string): boolean {
  const clean = expr.replace(/[()]/g, ' ').trim();
  if (FORBIDDEN.test(clean)) {
    // «GPL-3.0 OR MIT» законен: берём MIT. Запрет срабатывает, только если
    // несовместимого не обойти.
    if (!/\bOR\b/i.test(clean)) return false;
  }
  const parts = clean.split(/\s+OR\s+/i).map((p) => p.trim());
  const fits = (p: string): boolean =>
    p
      .split(/\s+AND\s+/i)
      .map((x) => x.trim().replace(/\+$/, ''))
      .every((x) => ALLOWED.has(x));
  return parts.some(fits);
}

interface Finding {
  name: string;
  version: string;
  license: string;
  dev: boolean;
}

function checkLicenses(): number {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, LockEntry>;
  };

  const bad: Finding[] = [];
  const unknown: Finding[] = [];
  const seen = new Set<string>();

  for (const [key, entry] of Object.entries(lock.packages)) {
    // Пустой ключ — сам проект. Свою лицензию проверять не у кого.
    if (!key) continue;
    if (entry.link) continue;
    const name = nameOf(key);
    const version = entry.version ?? '?';
    const license = licenseOf(entry);
    const f: Finding = { name, version, license: license ?? '—', dev: entry.dev === true };

    if (license === null) unknown.push(f);
    else if (!licenseOk(license)) bad.push(f);
    else seen.add(license);
  }

  const kinds = [...seen].sort();
  console.log(
    `лицензии: ${Object.keys(lock.packages).length - 1} пакетов, виды: ${kinds.join(', ')}`,
  );

  for (const f of unknown) {
    console.error(`✗ лицензия не указана: ${f.name}@${f.version}`);
  }
  for (const f of bad) {
    console.error(`✗ несовместимая лицензия: ${f.name}@${f.version} — ${f.license}`);
  }

  const failed = unknown.length + bad.length;
  if (failed > 0) {
    console.error(
      '\nИгра распространяется закрытыми сборками: сильный копилефт в дереве значит\n' +
        'либо открытие исходников, либо снятие пакета. Лицензия «не указана» —\n' +
        'то же самое: прав на использование не выдано вовсе.',
    );
  }
  return failed;
}

interface AuditMeta {
  metadata?: { vulnerabilities?: Record<string, number> };
  vulnerabilities?: Record<string, { severity?: string; via?: unknown[] }>;
}

function checkAudit(): number {
  let raw: string;
  try {
    // `npm audit` возвращает ненулевой код при находках — это не сбой запуска,
    // и разбирать надо вывод, а не код. Сбой отличается тем, что JSON не
    // разбирается вовсе.
    raw = execFileSync('npm', ['audit', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    const err = e as { stdout?: string };
    raw = err.stdout ?? '';
  }

  let data: AuditMeta;
  try {
    data = JSON.parse(raw) as AuditMeta;
  } catch {
    // Реестр недоступен, сеть отвалилась, npm выругался текстом. Проверку,
    // которую нельзя выполнить, нельзя считать пройденной.
    console.error('✗ npm audit не отработал: ответ не разобрался как JSON.');
    console.error(raw.slice(0, 400));
    return 1;
  }

  const v = data.metadata?.vulnerabilities ?? {};
  const line = (['critical', 'high', 'moderate', 'low', 'info'] as const)
    .map((s) => `${s} ${v[s] ?? 0}`)
    .join(', ');
  console.log(`аудит: ${line}`);

  const blocking = (v.critical ?? 0) + (v.high ?? 0);
  if (blocking === 0) return 0;

  for (const [name, info] of Object.entries(data.vulnerabilities ?? {})) {
    if (info.severity === 'high' || info.severity === 'critical') {
      console.error(`✗ ${info.severity}: ${name}`);
    }
  }
  console.error(
    `\nуязвимостей high/critical: ${blocking}. Чинятся подъёмом версии — ` +
      '`npm audit fix` или обновление пакета отдельным коммитом с ревью (SECURITY §7).',
  );
  return blocking;
}

function main(): void {
  const args = process.argv.slice(2);
  const licensesOnly = args.includes('--licenses-only');
  for (const a of args) {
    if (a !== '--licenses-only') {
      console.error(`неизвестный аргумент: ${a}`);
      process.exit(2);
    }
  }

  let failed = checkLicenses();
  if (!licensesOnly) failed += checkAudit();

  if (failed > 0) process.exit(1);
  console.log('зависимости: лицензии совместимы, high/critical нет');
}

main();

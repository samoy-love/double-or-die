/**
 * Диагностика каталога эталонов перед пересъёмкой численного корпуса.
 *
 * Отдельный файл, а не часть `cli.ts`: `cli.ts` вызывает `main()` на
 * верхнем уровне модуля (как и положено входной точке), и юнит-тест,
 * импортирующий его ради одной функции, на самом деле запускал бы CLI.
 * Чистая функция без побочных эффектов живёт отдельно ровно затем, чтобы
 * её можно было проверить, не трогая процесс.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BotName } from './bots';

/** Имя файла численного корпуса: `seed-<число>-p<1..4>`. */
const NUMBERED_GOLDEN = /^seed-\d+-p[1-4]$/;

/**
 * Разобраться, что лежит в каталоге эталонов, ПЕРЕД тем, как в него писать.
 *
 * Возвращает текст отказа или `null`, если пересъёмка безопасна.
 *
 * Каталог `tests/golden` держит эталоны ДВУХ разных схем со дня, когда в нём
 * завелись `scenario-*` (см. историю golden.ts, 0.3.11): численный корпус
 * `seed-N-pP`, который считает эта команда, и записи с подготовленного
 * состояния (`Golden.setup`), которые пишет отдельный код и никогда не
 * называет по этой схеме. Файл другой схемы — это не забытый эталон
 * численного корпуса, а другая линейка вообще, и предлагать `--runs`,
 * которое якобы «накроет» его, — враньё: имя `scenario-boss-p1` ни при каком
 * `--runs`/`--seed` не совпадёт с `seed-N-pP`, и раньше отказ ровно это и
 * предлагал, вводя в заблуждение.
 */
export function diagnoseCorpus(
  existing: readonly string[],
  dir: string,
  runs: number,
  seed: number,
  bot: BotName,
): string | null {
  const stems = existing.map((f) => f.slice(0, -5));
  const otherScheme = stems.filter((n) => !NUMBERED_GOLDEN.test(n));
  const numbered = stems.filter((n) => NUMBERED_GOLDEN.test(n));

  const names = new Set<string>();
  for (let i = 0; i < runs; i++) names.add(`seed-${seed + i}-p${(i % 4) + 1}`);
  const orphans = numbered.filter((n) => !names.has(n));

  if (otherScheme.length > 0) {
    return (
      `рядом с численным корпусом лежат эталоны другой схемы (${otherScheme.length}): ` +
      `${otherScheme.slice(0, 5).join(', ')}${otherScheme.length > 5 ? ` и ещё ${otherScheme.length - 5}` : ''}.\n` +
      `Это не «seed-N-pP», а записи с подготовленного состояния (Golden.setup) — эта команда ` +
      `их не читает и не перезаписывает, и никаким --runs/--seed их не «накрыть». Снимаются они ` +
      `отдельным кодом (см. историю golden.ts, 0.3.11), а не этой командой; если нужен ЧИСТЫЙ ` +
      `численный корпус — уберите их из каталога на время пересъёмки и верните обратно.`
    );
  }

  if (orphans.length > 0) {
    return (
      `пересъёмка накрывает ${names.size} эталонов численного корпуса, а в ${dir} их ${numbered.length}.\n` +
      `Осталось бы нетронутыми: ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? ` и ещё ${orphans.length - 5}` : ''}.\n` +
      `Нужен весь корпус — добавьте --runs ${numbered.length} --seed 1; нужен другой — удалите старый руками.`
    );
  }

  if (numbered.length > 0) {
    const sample = JSON.parse(readFileSync(join(dir, `${numbered[0]}.json`), 'utf8')) as {
      bot?: string;
    };
    if (sample.bot !== undefined && sample.bot !== bot) {
      return (
        `корпус записан ботом «${sample.bot}», а снимается ботом «${bot}».\n` +
        `Эталон, переснятый другим ботом, проверяет уже другой забег, продолжая называться тем же именем.`
      );
    }
  }

  return null;
}

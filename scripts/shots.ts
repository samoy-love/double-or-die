/**
 * Съёмка всех экранов и состояний игры одной командой.
 *
 * `npm run shots` — весь каталог (`scripts/screens.ts`) на всех разрешениях
 * настоящих экранов игрока: Steam Deck 1280×800, Full HD, 2K и 4K.
 *
 * Зачем инструмент, а не скрипт на случай: ревью в этом проекте идут
 * постоянно и агентами, а агент видит ровно то, что снято. Пока съёмка была
 * одноразовым скриптом, каждый прогон покрывал три-четыре экрана, которые
 * автор скрипта вспомнил, — и находки повторялись из ревью в ревью, потому
 * что половина состояний не попадала в кадр ни разу.
 *
 * Почему не `page.screenshot`: канвас WebGL2 создаётся без
 * `preserveDrawingBuffer`, и снаружи его буфер читается то верно, то пусто
 * (та же причина подробно разобрана в `e2e/visual.spec.ts`). Кадр снимает сам
 * клиент — `__DOD__.framePng()` рисует его в свой буфер и отдаёт картинкой.
 *
 * Использование:
 *   npm run shots                       — весь каталог, все разрешения
 *   npm run shots -- --res=fhd-1920x1080
 *   npm run shots -- --only=door,shop,pause
 *   npm run shots -- --out=shots/before
 *   npm run shots -- --list             — что вообще снимается
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';
import '../e2e/debug-api';
import { RESOLUTIONS, SCREENS, type Screen, type Step } from './screens';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Порт свой у каждого чекаута — по той же причине, что у сквозных тестов:
 * рядом живут worktree агента и вторая ветка, и общий порт молча отдал бы
 * снимки ЧУЖОЙ сборки. Выглядит это как непонятная регрессия в своей.
 */
const PORT =
  5300 + (Math.abs([...ROOT].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7)) % 400);

const arg = (name: string): string | undefined =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');

const OUT = join(ROOT, arg('out') ?? 'shots');
const ONLY = arg('only')?.split(',').filter(Boolean);
const RES = arg('res')?.split(',').filter(Boolean);

if (process.argv.includes('--list')) {
  for (const s of SCREENS) console.log(`${s.id.padEnd(24)} ${s.title}`);
  console.log(`\nвсего состояний: ${SCREENS.length}, разрешений: ${RESOLUTIONS.length}`);
  process.exit(0);
}

const screens = ONLY ? SCREENS.filter((s) => ONLY.includes(s.id)) : SCREENS;
const resolutions = RES ? RESOLUTIONS.filter((r) => RES.includes(r.id)) : RESOLUTIONS;

if (screens.length === 0) {
  console.error(`[DOD:ERROR] ни одно состояние не подошло под --only=${ONLY?.join(',')}`);
  process.exit(1);
}

/** Поднять свой dev-сервер и дождаться его. Гасится в `finally`. */
async function startServer(): Promise<ChildProcess> {
  const child = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
  );
  /*
   * Жалобы vite копим и договариваем в ошибку.
   *
   * Раньше его stderr уходил в трубу и не читался никем, а наружу летело
   * «vite завершился с кодом 1» — сообщение, по которому причина не
   * восстанавливается вовсе. Настоящая причина при этом одна и та же и вполне
   * бытовая: порт занят прошлым, не погашенным сервером (`--strictPort`).
   * Без текста ошибки это выглядит поломкой съёмки, а не занятым портом, и
   * стоит получаса на каждое повторение.
   */
  let complaints = '';
  child.stderr?.on('data', (b: Buffer) => {
    complaints += b.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite не поднялся за 60 с')), 60_000);
    child.stdout?.on('data', (b: Buffer) => {
      if (b.toString().includes('ready in') || b.toString().includes('Local:')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(
        new Error(`vite завершился с кодом ${code}${complaints ? `:\n${complaints.trim()}` : ''}`),
      );
    });
  });
  return child;
}

/**
 * Погасить сервер вместе с потомками.
 *
 * `child.kill()` на Windows убивает ровно то, что запущено, — а запущена
 * обёртка `npx.cmd` под `shell: true`. Сам vite её переживает, остаётся висеть
 * на порту, и СЛЕДУЮЩИЙ прогон падает на `--strictPort` мгновенно и без
 * внятного текста. Именно эти «грабли с занятым портом» лечились вручную
 * (`Get-NetTCPConnection` → `Stop-Process`) каждый раз, хотя чинятся здесь:
 * `taskkill /T` снимает всё дерево процессов разом.
 */
function stopServer(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill();
}

/**
 * Прогон одного шага сценария.
 *
 * Клавиша ЗАЖИМАЕТСЯ на кадр: опрос ввода идёт раз в кадр, и нажатие с
 * отпусканием в одном микротаске игра не видит вовсе — ни здесь, ни у живого
 * игрока.
 */
async function runStep(page: Page, step: Step): Promise<void> {
  if ('key' in step) {
    /*
     * На паузе клавиша не значит ничего, и молчит об этом.
     *
     * Съёмка идёт по шагам (`tick`), то есть цикл стоит: живой ввод никто не
     * опрашивает, нажатие не доходит до игры вовсе, а кадр выходит без
     * обещанного — «дверь выбрана» без выбранной двери. Ловилось это только
     * глазами и только если кто-то смотрел.
     *
     * Помнить про `play` в каждом сценарии — не решение: сценарий, где о нём
     * забыли, выглядит рабочим. Поэтому цикл заводится здесь и на время
     * нажатия, а потом возвращается ровно в то состояние, в каком был.
     */
    const wasPaused = await page.evaluate(() => window.__DOD__!.isPaused());
    if (wasPaused) await page.evaluate(() => window.__DOD__!.play());
    await page.keyboard.down(step.key);
    await page.waitForTimeout(180);
    await page.keyboard.up(step.key);
    await page.waitForTimeout(140);
    if (wasPaused) await page.evaluate(() => window.__DOD__!.pause());
    return;
  }
  if ('ticks' in step) {
    await page.evaluate((n: number) => {
      window.__DOD__!.tick(n);
    }, step.ticks);
    return;
  }
  if ('waitPhase' in step) {
    const limit = step.limit ?? 600;
    for (let done = 0; done < limit; done += 20) {
      const phase = await page.evaluate(() => window.__DOD__!.state().phase);
      if (phase === step.waitPhase) return;
      await page.evaluate(() => window.__DOD__!.tick(20));
    }
    return;
  }
  await page.evaluate(
    ({ call, args }) => {
      const api = window.__DOD__ as unknown as Record<string, (...a: unknown[]) => unknown>;
      const fn = api[call];
      if (typeof fn !== 'function') throw new Error(`нет отладочной ручки ${call}`);
      fn(...((args ?? []) as unknown[]));
    },
    { call: step.call, args: step.args as unknown[] | undefined },
  );
}

async function shoot(page: Page, screen: Screen, dir: string): Promise<string[]> {
  const problems: string[] = [];
  const errors: string[] = [];
  const onError = (e: Error): void => {
    errors.push(String(e));
  };
  page.on('pageerror', onError);

  try {
    for (const step of screen.steps) await runStep(page, step);
    await page.evaluate(() => window.__DOD__!.render());
    const zoom = screen.zoom;
    const url = await page.evaluate((z) => {
      if (!z) return window.__DOD__!.framePng();
      const { x, y } = window.__DOD__!.state().ace;
      return window.__DOD__!.framePng({ x, y, halfW: z.halfW, halfH: z.halfH, scale: z.scale });
    }, zoom);
    writeFileSync(join(dir, `${screen.id}.png`), Buffer.from(url.split(',')[1], 'base64'));
  } catch (e) {
    problems.push(`${screen.id}: ${String(e)}`);
  } finally {
    page.off('pageerror', onError);
  }
  if (errors.length > 0) problems.push(`${screen.id}: ошибки страницы — ${errors.join('; ')}`);
  return problems;
}

const server = await startServer();
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});

const problems: string[] = [];
try {
  /*
   * Каталог сносится ТОЛЬКО у полной съёмки.
   *
   * Съёмка подмножества обязана дописывать: `--only=door` — это «пересними
   * дверь», а не «оставь от каталога одну дверь». Прежний безусловный снос
   * стирал все снимки, и следующее ревью шло по трём кадрам вместо полусотни,
   * не зная об этом. По той же причине индекс подмножества не переписывается:
   * он описывал бы три состояния из пятидесяти шести.
   */
  if (!ONLY && !RES) rmSync(OUT, { recursive: true, force: true });
  for (const res of resolutions) {
    const dir = join(OUT, res.id);
    mkdirSync(dir, { recursive: true });
    const page = await browser.newPage({ viewport: { width: res.w, height: res.h } });
    await page.goto(`http://localhost:${PORT}/?debug=1&seed=7`, { waitUntil: 'load' });
    await page.waitForFunction(() => '__DOD__' in window, null, { timeout: 60_000 });
    // Атлас глифов собирается на загрузке: без ожидания снимки выходят без букв.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1200);

    for (const screen of screens) {
      problems.push(...(await shoot(page, screen, dir)));
      process.stdout.write(`${res.id}/${screen.id}\n`);
    }
    await page.close();
  }

  /*
   * Индекс рядом со снимками — то, ради чего инструмент и заводился.
   *
   * Ревьюер читает его первым: он говорит, что именно на кадре и на какие
   * вопросы этот кадр обязан отвечать. Без индекса агент смотрит на
   * `haggle-empty.png` и не знает, пустой торг — это состояние или поломка.
   */
  const index = [
    '# Снимки экранов и состояний',
    '',
    `Снято: ${screens.length} состояний × ${resolutions.length} разрешений.`,
    'Каталог состояний — `scripts/screens.ts`, съёмка — `npm run shots`.',
    '',
    ...resolutions.map((r) => `- \`${r.id}\` — ${r.w}×${r.h}`),
    '',
    '| Состояние | Что показывает | Что проверять |',
    '| --- | --- | --- |',
    ...screens.map((s) => `| \`${s.id}\` | ${s.title} | ${s.checks.join(' · ')} |`),
    '',
  ].join('\n');
  if (!ONLY && !RES) writeFileSync(join(OUT, 'index.md'), index);
} finally {
  await browser.close();
  stopServer(server);
}

if (problems.length > 0) {
  console.error(`[DOD:ERROR] съёмка прошла с ошибками:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(
  `снято ${screens.length * resolutions.length} кадров в ${OUT}; индекс — ${join(OUT, 'index.md')}`,
);

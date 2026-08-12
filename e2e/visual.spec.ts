import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './debug-api';

/**
 * Визуальная регрессия: стресс-кадр в `stable()`.
 *
 * Требование плана 0.3.0. Ловит она то, чего не видит ни один тест ядра:
 * пропавший слой, уехавшую камеру, перевёрнутый порядок отрисовки, палитру,
 * съехавшую после правки одного цвета. Симуляция при всём этом остаётся
 * идеально верной — ломается ровно картинка.
 *
 * Сравниваются не пиксели, а **сетка средних цветов 16×9**. Причина не в
 * лени: эталонный скриншот привязан к растеризатору, а их у нас три —
 * SwiftShader на раннере CI, настоящая видеокарта на машине разработчика и
 * что угодно у следующего. Попиксельный эталон краснел бы от смены образа
 * раннера, и его бы просто перестали читать. Средние по клетке переживают
 * разницу сглаживания и не переживают ничего из того, что мы ловим.
 *
 * Кадр снимает САМ клиент (`__DOD__.frameGrid`) и рисует его в отдельный
 * буфер. Контекст без `preserveDrawingBuffer` содержимого после показа не
 * хранит: снаружи его буфер читается то верно, то пусто, а гейт, падающий
 * через раз, перестают читать быстрее, чем он успевает что-нибудь поймать.
 *
 * Кадр берётся в `stable()`: тряска, вспышки и хитстоп выключены, камера
 * стоит. Без этого «эталон» означал бы «эталон на этом кадре тряски».
 *
 * Частицы в кадре есть, и их положение случайно: они живут в клиенте и
 * детерминизмом ядра не связаны. Поэтому допуск на клетку щедрый — он
 * рассчитан на россыпь искр, а не на подмену слоя.
 *
 * Нагрузка здесь меньше, чем в бенче рендера, и это не оплошность: там
 * меряют время и берут худшую волну, здесь важно другое — чтобы в кадре был
 * каждый слой: пол, колонны, карты, враги, телеграфы, игрок, снаряды,
 * частицы и HUD.
 */

const BASELINE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'baselines',
  'stress-frame.json',
);
const COLS = 16;
const ROWS = 9;

/**
 * Допуск на клетку, в долях канала.
 *
 * Двенадцать процентов — это заметно больше разброса от сглаживания и
 * случайных искр и заметно меньше любой настоящей поломки: пропавший слой
 * врагов меняет клетку на десятки процентов, а съехавшая палитра — сразу все.
 */
const TOLERANCE = 0.12;

interface Frame {
  cols: number;
  rows: number;
  /** Средние RGB по клеткам, слева направо и сверху вниз, 0..1. */
  cells: number[][];
}

/*
 * Служебный воркер здесь выключен.
 *
 * Он кеширует бандл для офлайна — ровно то, чего от него ждут в игре, — и
 * при повторном прогоне отдаёт браузеру вчерашний клиент вместо сегодняшнего.
 * Проверка визуальной регрессии превращается в проверку кеша: код правишь,
 * гейт зелен, а сравнивается старый кадр.
 */
test.use({ serviceWorkers: 'block' });

test('стресс-кадр не разошёлся с эталоном', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/?debug=1&autopause=1');
  await page.waitForFunction(() => '__DOD__' in window, null, { timeout: 30_000 });

  // Ждём первый настоящий кадр цикла: до него шейдеры не собраны, а буфер
  // канваса ещё не получил размер — снимок вышел бы чёрным.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );

  /*
   * Снимок берётся с повтором.
   *
   * Программный растеризатор изредка роняет контекст на старте страницы —
   * это состояние браузера, а не игры, и отличить его от настоящего расхождения
   * с эталоном обязан тест, а не читатель отчёта. Перезагрузка стоит секунды,
   * а мигающий гейт перестают читать.
   */
  const grab = (): Promise<number[][]> =>
    page.evaluate(
      ({ cols, rows }) => {
        const d = window.__DOD__!;
        d.newRun({ seed: 3, players: 1 });
        d.mute(true);
        d.waves(false);
        d.clear();
        d.stable(true);
        d.stress({ enemies: 30, particles: 200 });
        // Пара тиков, чтобы сущности встали по местам и появились телеграфы:
        // кадр обязан содержать все слои, иначе он ничего не стережёт.
        d.tick(2);
        return d.frameGrid(cols, rows);
      },
      { cols: COLS, rows: ROWS },
    );

  let cells: number[][] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      cells = await grab();
      break;
    } catch (e) {
      const text = String(e);
      if (!text.includes('контекст потерян') || attempt === 3) throw e;
      await page.reload();
      await page.waitForFunction(() => '__DOD__' in window, null, { timeout: 30_000 });
    }
  }

  const frame: Frame = { cols: COLS, rows: ROWS, cells };

  expect(errors).toEqual([]);
  expect(cells.length).toBe(COLS * ROWS);

  // Кадр обязан быть неоднородным: равномерная заливка означает, что не
  // нарисовалось ничего, и сравнение с эталоном такой отказ пропустило бы,
  // будь эталон снят в том же состоянии.
  const brightness = cells.map(([r, g, b]) => (r + g + b) / 3);
  expect(Math.max(...brightness) - Math.min(...brightness)).toBeGreaterThan(0.02);

  if (!existsSync(BASELINE_PATH)) {
    // Первый прогон записывает эталон и честно падает: молча принять
    // сегодняшнюю картинку за образец — значит получить проверку, которая
    // подтверждает что угодно.
    writeFileSync(BASELINE_PATH, JSON.stringify(frame, null, 2) + '\n');
    throw new Error(
      `эталона не было — записан ${BASELINE_PATH}. Проверьте кадр глазами и запустите снова`,
    );
  }

  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Frame;
  expect({ cols: baseline.cols, rows: baseline.rows }).toEqual({
    cols: COLS,
    rows: ROWS,
  });

  const diffs: string[] = [];
  for (let i = 0; i < baseline.cells.length; i++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(baseline.cells[i][c] - cells[i][c]);
      if (d <= TOLERANCE) continue;
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      diffs.push(`клетка ${col},${row}: канал ${'rgb'[c]} разошёлся на ${d.toFixed(3)}`);
      break;
    }
  }
  expect(diffs).toEqual([]);
});

import { expect, test } from '@playwright/test';
import './debug-api';

/**
 * Нагрузочный бенч рендера: 2000 частиц и 200 болванок в бюджете кадра.
 *
 * Требование плана версии 0.2.0 и единственная проверка, которую нельзя
 * сделать в Node: рендер живёт в WebGL, и мерить его надо там, где он
 * работает. Нагрузка взята из плана дословно — она описывает худшую волну,
 * а бюджет обязан держаться именно в ней, а не в среднем.
 *
 * Бюджет кадра (TECH §5): рендер ≤ 6 мс из 16.6.
 *
 * Меряем ДВЕ разные вещи, и путать их нельзя:
 *
 *   — **время нашего кода на кадр** — сборка инстансов и отправка их одним
 *     вызовом отрисовки. Это то, чем мы управляем, и порог здесь строгий.
 *   — **частоту реальных кадров** под той же нагрузкой. Она упирается в
 *     видеокарту, а на раннере CI её нет вовсе: там программный SwiftShader,
 *     который медленнее любого настоящего железа в разы. Поэтому порог здесь
 *     мягкий и ловит обвал на порядок — «кадры вообще не идут», — а не
 *     проценты. Цифра при этом печатается: спайк 60 FPS на реальном железе
 *     проверяется по ней глазами, а не автоматикой.
 */

/** Из бюджета кадра TECH §5. */
const БЮДЖЕТ_РЕНДЕРА_МС = 6;
/** Обвал, а не проценты: ниже этого кадры фактически не идут. */
const МИН_FPS = 10;

test('2000 частиц и 200 болванок укладываются в бюджет кадра', async ({ page }) => {
  const ошибки: string[] = [];
  page.on('pageerror', (e) => ошибки.push(String(e)));

  await page.goto('/?debug=1&autopause=1');
  await page.waitForFunction(() => '__DOD__' in window, null, { timeout: 30_000 });

  const замер = await page.evaluate(() => {
    const d = window.__DOD__!;
    d.newRun({ seed: 1, players: 4 });
    d.mute(true);
    d.stress({ enemies: 200, particles: 2000 });
    d.tick(1);

    // Прогрев: первые кадры собирают шейдеры и прогревают JIT.
    for (let i = 0; i < 60; i++) d.render();

    const t0 = performance.now();
    const N = 120;
    for (let i = 0; i < N; i++) d.render();
    const мсНаКадр = (performance.now() - t0) / N;

    return { мсНаКадр, ...d.perf() };
  });

  console.log(
    `рендер: ${замер.мсНаКадр.toFixed(2)} мс на кадр, ` +
      `${замер.shapes} фигур, ${замер.particles} частиц`,
  );

  expect(
    замер.particles,
    'частицы не заполнились — бенч мерит пустую сцену',
  ).toBeGreaterThanOrEqual(2000);
  expect(замер.shapes, 'фигур меньше, чем сущностей — сцена собралась не вся').toBeGreaterThan(
    2000,
  );
  expect(замер.мсНаКадр).toBeLessThan(БЮДЖЕТ_РЕНДЕРА_МС);
  expect(ошибки).toEqual([]);
});

test('под полной нагрузкой кадры продолжают идти', async ({ page }) => {
  await page.goto('/?debug=1');
  await page.waitForFunction(() => '__DOD__' in window, null, { timeout: 30_000 });

  const fps = await page.evaluate(async () => {
    const d = window.__DOD__!;
    d.newRun({ seed: 1, players: 4 });
    d.mute(true);
    d.stress({ enemies: 200, particles: 2000 });
    d.play();

    // Считаем настоящие кадры цикла, а не вызовы render(): здесь важно, что
    // requestAnimationFrame успевает, а не сколько стоит одна отрисовка.
    return await new Promise<number>((resolve) => {
      let кадров = 0;
      const начало = performance.now();
      const шаг = (): void => {
        кадров++;
        if (performance.now() - начало < 2000) requestAnimationFrame(шаг);
        else resolve((кадров * 1000) / (performance.now() - начало));
      };
      requestAnimationFrame(шаг);
    });
  });

  console.log(`кадров в секунду под нагрузкой: ${fps.toFixed(1)}`);
  expect(fps).toBeGreaterThan(МИН_FPS);
});

/**
 * Сцена действительно рисуется, а не только считается.
 *
 * Проверка живёт здесь, а не в дыме по релизу: `render()` рисует кадр
 * синхронно и по команде, поэтому пиксели можно прочитать тут же, до
 * композитинга. В релизной сборке такой команды нет — и не должно быть.
 */
test('кадр содержит арену, врагов и игрока', async ({ page }) => {
  await page.goto('/?debug=1&autopause=1');
  await page.waitForFunction(() => '__DOD__' in window, null, { timeout: 30_000 });

  const кадр = await page.evaluate(() => {
    const d = window.__DOD__!;
    d.newRun({ seed: 3, players: 1 });
    d.mute(true);
    d.waves(false);
    d.clear();
    d.stress({ enemies: 30, particles: 200 });
    d.tick(2);
    d.render();

    const el = document.getElementById('game') as HTMLCanvasElement;
    const gl = el.getContext('webgl2')!;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

    const цвета = new Set<number>();
    for (let i = 0; i < w * h; i += 13) {
      цвета.add((px[i * 4] << 16) | (px[i * 4 + 1] << 8) | px[i * 4 + 2]);
    }
    return { цветов: цвета.size, ошибка: gl.getError(), фигур: d.perf().shapes };
  });

  expect(кадр.ошибка).toBe(0);
  expect(кадр.фигур, 'сцена пуста — рисовать было нечего').toBeGreaterThan(50);
  // Залитый фон дал бы единицы цветов. Пол с сеткой, колонны, враги, частицы,
  // игрок и HUD дают десятки — и именно этого не будет, если рендер молча
  // перестал отрисовывать сущности.
  expect(кадр.цветов, 'кадр почти одноцветный — сцена не отрисовалась').toBeGreaterThan(10);
});

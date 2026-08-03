import { expect, test } from '@playwright/test';

/**
 * Дым по релизной сборке: игра открывается, идёт и рисует.
 *
 * Между «симуляция считает верно» и «игра работает» лежит весь рендер, и
 * headless-раннер его не видит. WebGL2 не инициализировался, шейдер не
 * собрался, канвас нулевого размера, цикл встал — при любом из этих отказов
 * симуляция по-прежнему честно тикает в тестах, юниты зелёные, а на экране
 * пусто.
 *
 * Кадр здесь не читается пикселями, и это вынужденно: канвас создаётся
 * низколатентным (`desynchronized`), его буфер уходит композитору сразу, и
 * `readPixels` снаружи кадра возвращает потерянный контекст даже на исправной
 * игре. Пиксели проверяются там, где отрисовка синхронна и управляема, — в
 * бенче рендера по dev-сборке (`perf.spec.ts`).
 *
 * Здесь же — то, что видно снаружи: отладочный оверлей. Он печатает тик, FPS
 * и хеш состояния, а FPS считается в кадре игрового цикла. Растущий тик и
 * ненулевой FPS означают, что и симуляция, и рендер идут.
 */

/** Оверлей: `0.2.2+abc1234 · тик 123 · 60 FPS · сид 1 · игроков 1 · 0x...`. */
async function оверлей(page: import('@playwright/test').Page): Promise<string> {
  return (await page.locator('.hud, .overlay, body > div').first().textContent()) ?? '';
}

const число = (текст: string, метка: RegExp): number => Number(метка.exec(текст)?.[1] ?? NaN);

test.describe('релизная сборка', () => {
  test('открывается без ошибок и держит канвас', async ({ page }) => {
    const ошибки: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') ошибки.push(m.text());
    });
    page.on('pageerror', (e) => ошибки.push(String(e)));

    await page.goto('/');
    const canvas = page.locator('#game');
    await expect(canvas).toBeVisible();

    const состояние = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      // Тот же контекст, что уже создала игра: повторный вызов возвращает его.
      const gl = c.getContext('webgl2');
      return { w: c.width, h: c.height, webgl2: !!gl };
    });

    // Канвас нулевого размера — самый тихий из отказов: элемент на месте,
    // ошибок нет, картинки нет.
    expect(состояние.w).toBeGreaterThan(100);
    expect(состояние.h).toBeGreaterThan(100);
    expect(состояние.webgl2, 'WebGL2 недоступен — игра не рисуется вовсе').toBe(true);

    // Несобравшийся шейдер и любое исключение на старте видны здесь: точка
    // входа сама пишет их в консоль своим форматом.
    expect(ошибки).toEqual([]);
  });

  test('цикл идёт: тик растёт, кадры считаются', async ({ page }) => {
    await page.goto('/?debug=1');
    await page.waitForTimeout(900);

    const первый = await оверлей(page);
    expect(первый, 'отладочный оверлей не появился').toMatch(/тик \d+/);

    await page.waitForTimeout(900);
    const второй = await оверлей(page);

    const тик1 = число(первый, /тик (\d+)/);
    const тик2 = число(второй, /тик (\d+)/);
    const fps = число(второй, /(\d+) FPS/);

    expect(тик2, 'тик не растёт — симуляция стоит').toBeGreaterThan(тик1);
    // FPS считает игровой цикл в своём кадре: ненулевое значение означает,
    // что кадры действительно рисуются, а не только тикает симуляция.
    expect(fps, 'кадры не идут — рендер не вызывается').toBeGreaterThan(0);
  });

  test('отладочного интерфейса в релизе нет', async ({ page }) => {
    await page.goto('/?debug=1');
    await page.waitForTimeout(500);
    // Даже с ?debug=1: параметр включает оверлей, а не управление симуляцией.
    const есть = await page.evaluate(() => '__DOD__' in window);
    expect(есть, '__DOD__ доступен в релизной сборке — это чит, а не удобство').toBe(false);
  });
});

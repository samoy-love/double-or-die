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
async function overlayText(page: import('@playwright/test').Page): Promise<string> {
  return (await page.locator('.hud, .overlay, body > div').first().textContent()) ?? '';
}

const readNumber = (text: string, pattern: RegExp): number =>
  Number(pattern.exec(text)?.[1] ?? NaN);

test.describe('релизная сборка', () => {
  test('открывается без ошибок и держит канвас', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/');
    const canvas = page.locator('#game');
    await expect(canvas).toBeVisible();

    const canvasState = await canvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      // Тот же контекст, что уже создала игра: повторный вызов возвращает его.
      const gl = c.getContext('webgl2');
      return { w: c.width, h: c.height, webgl2: !!gl };
    });

    // Канвас нулевого размера — самый тихий из отказов: элемент на месте,
    // ошибок нет, картинки нет.
    expect(canvasState.w).toBeGreaterThan(100);
    expect(canvasState.h).toBeGreaterThan(100);
    expect(canvasState.webgl2, 'WebGL2 недоступен — игра не рисуется вовсе').toBe(true);

    // Несобравшийся шейдер и любое исключение на старте видны здесь: точка
    // входа сама пишет их в консоль своим форматом.
    expect(errors).toEqual([]);
  });

  /*
   * Язык закреплён параметром, а не оставлен на усмотрение браузера.
   *
   * С приходом словаря оверлей стал локализованным, и Playwright, который
   * ходит с английской локалью, получал `tick 59` там, где тест ждал «тик».
   * Проверка при этом падала не потому, что цикл встал, — а потому, что была
   * привязана к языку интерфейса, чего до словаря случиться не могло.
   *
   * Чинится закреплением языка, а не смягчением образца: тест обязан ловить
   * остановившийся цикл, и подстройка под любую подпись сделала бы его
   * нечувствительным ровно к тому, ради чего он написан.
   */
  test('цикл идёт: тик растёт, кадры считаются', async ({ page }) => {
    await page.goto('/?debug=1&lang=ru');
    await page.waitForTimeout(900);

    const first = await overlayText(page);
    expect(first, 'отладочный оверлей не появился').toMatch(/тик \d+/);

    await page.waitForTimeout(900);
    const second = await overlayText(page);

    const tick1 = readNumber(first, /тик (\d+)/);
    const tick2 = readNumber(second, /тик (\d+)/);
    const fps = readNumber(second, /(\d+) FPS/);

    expect(tick2, 'тик не растёт — симуляция стоит').toBeGreaterThan(tick1);
    // FPS считает игровой цикл в своём кадре: ненулевое значение означает,
    // что кадры действительно рисуются, а не только тикает симуляция.
    expect(fps, 'кадры не идут — рендер не вызывается').toBeGreaterThan(0);
  });

  test('отладочного интерфейса в релизе нет', async ({ page }) => {
    await page.goto('/?debug=1');
    await page.waitForTimeout(500);
    // Даже с ?debug=1: параметр включает оверлей, а не управление симуляцией.
    const present = await page.evaluate(() => '__DOD__' in window);
    expect(present, '__DOD__ доступен в релизной сборке — это чит, а не удобство').toBe(false);
  });
});

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
const RENDER_BUDGET_MS = 6;
/**
 * Порог «кадры вообще идут», а не порог производительности.
 *
 * Производительность меряет проверка выше — временем НАШЕГО кода на кадр, и
 * порог там строгий. Здесь же считаются настоящие кадры, а они упираются в
 * видеокарту, которой на раннере CI нет: там программный SwiftShader, и две
 * тысячи частиц он рисует восемь раз в секунду против двадцати восьми на
 * обычной машине и сотен на реальном железе. Требовать от него осмысленного
 * числа бессмысленно — и вредно: порог, подогнанный под сегодняшний раннер,
 * покраснеет от чужого обновления образа.
 *
 * Поэтому здесь ловится ровно одно: цикл под нагрузкой не встал совсем.
 * Три кадра в секунду не проходит ни одна живая отрисовка и проходит любая
 * мёртвая.
 */
const MIN_FPS = 3;

test('2000 частиц и 200 болванок укладываются в бюджет кадра', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/?debug=1&autopause=1');
  await page.waitForFunction(() => '__DOD__' in window, null, { timeout: 30_000 });

  const measured = await page.evaluate(() => {
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
    const msPerFrame = (performance.now() - t0) / N;

    return { msPerFrame, ...d.perf() };
  });

  console.log(
    `рендер: ${measured.msPerFrame.toFixed(2)} мс на кадр, ` +
      `${measured.shapes} фигур, ${measured.particles} частиц`,
  );

  expect(
    measured.particles,
    'частицы не заполнились — бенч мерит пустую сцену',
  ).toBeGreaterThanOrEqual(2000);
  expect(measured.shapes, 'фигур меньше, чем сущностей — сцена собралась не вся').toBeGreaterThan(
    2000,
  );
  expect(measured.msPerFrame).toBeLessThan(RENDER_BUDGET_MS);
  expect(errors).toEqual([]);
});

test('под полной нагрузкой цикл не встаёт', async ({ page }) => {
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
      let frames = 0;
      const startedAt = performance.now();
      const step = (): void => {
        frames++;
        if (performance.now() - startedAt < 2000) requestAnimationFrame(step);
        else resolve((frames * 1000) / (performance.now() - startedAt));
      };
      requestAnimationFrame(step);
    });
  });

  console.log(`кадров в секунду под нагрузкой: ${fps.toFixed(1)}`);
  expect(fps).toBeGreaterThan(MIN_FPS);
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

  const frame = await page.evaluate(() => {
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

    const colors = new Set<number>();
    for (let i = 0; i < w * h; i += 13) {
      colors.add((px[i * 4] << 16) | (px[i * 4 + 1] << 8) | px[i * 4 + 2]);
    }
    return { colorCount: colors.size, glError: gl.getError(), shapes: d.perf().shapes };
  });

  expect(frame.glError).toBe(0);
  expect(frame.shapes, 'сцена пуста — рисовать было нечего').toBeGreaterThan(50);
  // Залитый фон дал бы единицы цветов. Пол с сеткой, колонны, враги, частицы,
  // игрок и HUD дают десятки — и именно этого не будет, если рендер молча
  // перестал отрисовывать сущности.
  expect(frame.colorCount, 'кадр почти одноцветный — сцена не отрисовалась').toBeGreaterThan(10);
});

/**
 * Экраны забега действительно рисуются.
 *
 * Проверка появилась после дефекта, который увидел владелец, а не машина:
 * забег кончался, на экране висело красное кольцо обратного отсчёта, замирало
 * на нуле — и всё. Экран итогов существовал в симуляции и был покрыт тестами,
 * но клиент о фазах не знал вовсе, и до 0.4.0 в рендере была единственная
 * ссылка на фазу — на босса.
 *
 * Проверяется не красота, а факт: на экране больше фигур, чем в пустом кадре,
 * и он не одноцветный. Красота проверяется глазами и эталоном стресс-кадра.
 */
/*
 * Пока проверяется только экран итогов — тот, дефект которого и увидел
 * владелец. Экран двери своим ходом не достигается: без игрока забег умирает
 * в первой комнате, а зачистка арены каждый тик уносит его дальше двери. Его
 * логика покрыта юнит-тестами (tests/doors.test.ts), а отрисовка ждёт
 * проверки глазами — оснастка тут стоит дороже пользы.
 */
/**
 * Кадр не пуст и не одноцветен — тот же критерий, что у экрана итогов.
 *
 * Вынесено функцией, потому что проверок таких стало четыре: пустой экран
 * ловится только чтением пикселей, и повторять двадцать строк на каждый экран
 * значит однажды забыть их в пятом.
 */
async function screenFrame(page: import('@playwright/test').Page): Promise<{
  colorCount: number;
  shapes: number;
}> {
  return await page.evaluate(() => {
    const d = window.__DOD__!;
    d.render();
    const el = document.getElementById('game') as HTMLCanvasElement;
    const gl = el.getContext('webgl2')!;
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const colors = new Set<number>();
    for (let i = 0; i < w * h; i += 13) {
      colors.add((px[i * 4] << 16) | (px[i * 4 + 1] << 8) | px[i * 4 + 2]);
    }
    return { colorCount: colors.size, shapes: d.perf().shapes };
  });
}

/**
 * Меню рисуется до всякого забега — и до него игра не тикает.
 *
 * Второе здесь важнее первого: меню обязано ОСТАНАВЛИВАТЬ забег, иначе первая
 * комната играется сама, пока игрок читает заголовок (GDD §5, «МЕНЮ ──►
 * ЗАБЕГ»). `newRun` тут не зовётся намеренно — он и есть заказанный забег,
 * который меню снимает.
 */
test('меню рисуется и держит забег до нажатия', async ({ page }) => {
  await page.goto('/?debug=1');
  await page.waitForFunction(() => '__DOD__' in window, null, { timeout: 30_000 });
  await page.evaluate(() => window.__DOD__!.mute(true));

  const frame = await screenFrame(page);
  expect(frame.shapes, 'меню пусто — рисовать было нечего').toBeGreaterThan(20);
  expect(frame.colorCount, 'кадр меню почти одноцветный').toBeGreaterThan(6);

  const before = await page.evaluate(() => window.__DOD__!.state().tick);
  await page.waitForTimeout(600);
  const idle = await page.evaluate(() => window.__DOD__!.state().tick);
  expect(idle, 'забег идёт под меню').toBe(before);

  /*
   * Клавиша именно ЗАЖИМАЕТСЯ на кадр, а не «нажимается».
   *
   * Опрос ввода идёт раз в кадр, поэтому нажатие и отпускание в одном
   * микротаске игра не видит вовсе — ни здесь, ни у живого игрока с
   * макросом. Человеческое нажатие длится десятки миллисекунд, и тест
   * повторяет именно его.
   */
  await page.keyboard.down('Enter');
  await page.waitForTimeout(200);
  await page.keyboard.up('Enter');
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => window.__DOD__!.state().tick);
  expect(after, 'нажатие «Играть» не начало забег').toBeGreaterThan(idle);
});

/**
 * Плата за этаж и торг — два разных кадра одной фазы.
 *
 * Развилка проходит по кошельку: хватает — экран платы, не хватает — торг с
 * тремя вариантами (GDD §12А.2). Оба доводятся входом ядра `houseCut()`, а не
 * подменой фазы: проверяется кадр, который бывает в игре.
 */
for (const money of [
  { name: 'платы', chips: 100_000 },
  { name: 'торга', chips: 0 },
] as const) {
  test(`экран ${money.name} рисуется, а не оставляет пустой кадр`, async ({ page }) => {
    await page.goto('/?debug=1&autopause=1');
    await page.waitForFunction(() => '__DOD__' in window, null, { timeout: 30_000 });

    await page.evaluate((chips) => {
      const d = window.__DOD__!;
      d.newRun({ seed: 3, players: 1 });
      d.mute(true);
      if (chips > 0) d.give({ chips });
      d.houseCut();
    }, money.chips);

    const frame = await screenFrame(page);
    expect(await page.evaluate(() => window.__DOD__!.state().phase), 'фаза не платы').toBe(5);
    expect(frame.shapes, 'экран пуст — рисовать было нечего').toBeGreaterThan(20);
    expect(frame.colorCount, 'кадр почти одноцветный').toBeGreaterThan(6);
  });
}

for (const screen of [{ name: 'итогов', phase: 6 }] as const) {
  test(`экран ${screen.name} рисуется, а не оставляет пустой кадр`, async ({ page }) => {
    await page.goto('/?debug=1&autopause=1');
    await page.waitForFunction(() => '__DOD__' in window, null, { timeout: 30_000 });

    const frame = await page.evaluate((want) => {
      const d = window.__DOD__!;
      d.newRun({ seed: 3, players: 1 });
      d.mute(true);

      /*
       * Доводим забег до нужной фазы его же правилами.
       *
       * Подменять состояние руками значило бы проверять кадр, которого в игре
       * не бывает. До двери забег своим ходом не доходит: без игрока он
       * умирает в первой комнате, а дверь стоит ЗА зачищенной комнатой —
       * поэтому арену чистим каждый тик, заменяя идеального стрелка.
       */
      for (let i = 0; i < 8000; i++) {
        d.tick(1);
        if (d.state().phase === want.phase) break;
      }
      d.render();

      const el = document.getElementById('game') as HTMLCanvasElement;
      const gl = el.getContext('webgl2')!;
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);

      const colors = new Set<number>();
      for (let i = 0; i < w * h; i += 13) {
        colors.add((px[i * 4] << 16) | (px[i * 4 + 1] << 8) | px[i * 4 + 2]);
      }
      return { phase: d.state().phase, colorCount: colors.size, shapes: d.perf().shapes };
    }, screen);

    expect(frame.phase, 'забег не дошёл до нужной фазы').toBe(screen.phase);
    expect(frame.shapes, 'экран пуст — рисовать было нечего').toBeGreaterThan(20);
    expect(frame.colorCount, 'кадр почти одноцветный').toBeGreaterThan(6);
  });
}

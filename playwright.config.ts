import { defineConfig, devices } from '@playwright/test';

/**
 * Сквозные проверки: то, что не видно ни headless-раннеру, ни юнит-тестам.
 *
 * Ядро проверяется без графики и проверяется хорошо, но между «симуляция
 * считает верно» и «игра работает» остаётся дыра ровно в рендер: WebGL2 не
 * инициализировался, шейдер не собрался, канвас нулевого размера — во всех
 * этих случаях симуляция по-прежнему честно тикает, а на экране ничего нет.
 *
 * Два прогона по разным сборкам, и это принципиально:
 *
 *   — **дым идёт по ПРОДАКШЕН-сборке.** Проверять надо то, что уедет
 *     игрокам, а не то, что удобно проверять. Заодно здесь же доказывается,
 *     что отладочного интерфейса в релизе нет, — функционально, а не поиском
 *     строки в бандле.
 *   — **бенч рендера идёт по DEV-сборке.** Нагрузить сцену двумя тысячами
 *     частиц можно только через `__DOD__.stress()`, а его в релизе нет по
 *     той же причине, по которой он там не нужен.
 */

/** Прод-превью. Порт свой, чтобы не спорить с `npm run dev`. */
const PROD_PORT = 4331;
/** Dev-сервер для бенча. Тоже свой: 5173 и 5175 заняты соседними проектами. */
const DEV_PORT = 5176;

const PERF = /perf\.spec\.ts$/;

export default defineConfig({
  testDir: './e2e',
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Замер производительности не делят с соседями: чужой воркер на том же
  // ядре превращает бенч в замер загрузки машины.
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 90_000,
  expect: { timeout: 15_000 },

  use: {
    trace: 'retain-on-failure',
    // Софтверный WebGL на раннере без видеокарты — норма, и отключать его
    // нельзя: без него игра не запустится вовсе и дым станет бесполезным.
    launchOptions: { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] },
  },

  projects: [
    {
      name: 'релиз',
      use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${PROD_PORT}` },
      testIgnore: PERF,
    },
    {
      name: 'бенч рендера',
      use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${DEV_PORT}` },
      testMatch: PERF,
    },
  ],

  webServer: [
    {
      command: `npm run build && npm run preview -- --port ${PROD_PORT} --host 127.0.0.1 --strictPort`,
      url: `http://127.0.0.1:${PROD_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `npm run dev -- --port ${DEV_PORT} --host 127.0.0.1 --strictPort`,
      url: `http://127.0.0.1:${DEV_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});

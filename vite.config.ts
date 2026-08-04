import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Версия и коммит зашиваются в сборку.
 *
 * Без этого баг-репорт бесполезен: непонятно, в какой сборке воспроизводилось,
 * а проверка «не устарел ли кеш» не с чем сравнивать.
 */
function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'nogit';
  }
}

const version = process.env.npm_package_version ?? '0.0.0';
const sha = gitSha();
const isDev = process.env.NODE_ENV !== 'production';

/**
 * Пакеты монорепозитория доступны по имени, а не только глубоким путём.
 *
 * `packages/*` объявлены воркспейсами и имеют свои `package.json`, поэтому
 * `@dod/sim` резолвится и через `node_modules`. Псевдоним здесь — не дубль, а
 * гарантия: он не зависит от того, разложил ли npm симлинки, и одинаково
 * работает у Vite, Vitest и tsc (`paths` в tsconfig). Старые относительные
 * импорты продолжают работать без изменений — это осознанно: переезд на
 * именованные идёт файл за файлом, а не одним разрушительным коммитом.
 */
const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src`, import.meta.url));

export const aliases = [
  { find: /^@dod\/sim$/, replacement: `${pkg('sim')}/index.ts` },
  { find: /^@dod\/sim\//, replacement: `${pkg('sim')}/` },
  { find: /^@dod\/shared$/, replacement: `${pkg('shared')}/index.ts` },
  { find: /^@dod\/shared\//, replacement: `${pkg('shared')}/` },
  { find: /^@dod\/client\//, replacement: `${pkg('client')}/` },
  { find: /^@dod\/tools\//, replacement: `${pkg('tools')}/` },
];

export default defineConfig({
  resolve: { alias: aliases },
  define: {
    __VERSION__: JSON.stringify(version),
    __GIT_SHA__: JSON.stringify(sha),
    // Отладочный интерфейс вырезается из продакшена на этапе сборки,
    // а не проверкой в рантайме: иначе его достанут из бандла.
    __DEV_BUILD__: JSON.stringify(isDev),
  },
  build: {
    target: 'es2022',
    // Стабильные имена внутри Steam-сборки, контент-хеши — в вебе.
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});

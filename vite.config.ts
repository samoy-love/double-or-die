import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

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

export default defineConfig({
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

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

/**
 * Линтер разделён по назначению файлов, а не свален в одну кучу.
 *
 * Ядро симуляции, клиент и инструменты живут в разных мирах: ядру запрещено
 * знать про браузер, инструментам он не нужен вовсе, а клиент только из него и
 * состоит. Один общий набор глобальных имён означал бы, что `window` в ядре
 * линтер считает нормой, — а это ровно та ошибка, которую отдельно ловит
 * `check:boundaries`. Пусть ловят оба: линтер видит её в редакторе, проверка
 * границ — в CI и по существу.
 */
export default defineConfig([
  globalIgnores(['dist/**', 'dev-dist/**', 'stage/**', 'coverage/**', 'public/sw.js']),

  {
    files: ['**/*.{ts,js}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Ядро симуляции работает с типизированными массивами и битовыми
      // операциями: жалобы на них — шум, а не польза.
      'no-bitwise': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Пустой catch в проверке обновлений осознан: сеть недоступна — не
      // повод шуметь, игра полностью работает офлайн.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  /*
   * Ядро симуляции: ни браузера, ни Node. Только встроенные имена языка.
   *
   * `no-undef` здесь включается обратно намеренно. typescript-eslint гасит его
   * везде, и правильно: обычно необъявленное имя ловит сам компилятор. Но не
   * здесь — в tsconfig подключён `lib: DOM`, потому что клиенту он нужен, и
   * `window` в ядре компилятор считает совершенно законным. Список глобальных
   * имён без браузера и без Node возвращает эту ошибку туда, где её видно
   * сразу, — в редактор, а не в отчёт CI.
   */
  {
    files: ['packages/sim/**/*.ts'],
    languageOptions: { globals: globals.es2021 },
    rules: { 'no-undef': 'error' },
  },

  // Клиент: браузер и ничего кроме.
  {
    files: ['packages/client/**/*.ts'],
    languageOptions: { globals: globals.browser },
  },

  // Инструменты, скрипты и конфиги сборки: Node.
  {
    files: ['packages/tools/**/*.ts', 'scripts/**/*.ts', '*.config.ts', '*.config.js'],
    languageOptions: { globals: globals.node },
  },

  // Тесты видят оба мира: ядро проверяется в Node, а замеры аллокаций ходят в
  // `process` и в профилировщик.
  {
    files: ['tests/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]);

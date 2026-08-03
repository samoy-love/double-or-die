import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'stage/**', 'coverage/**', 'public/sw.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
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
);

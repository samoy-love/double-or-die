import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Детерминизм проверяется в том числе повторяемостью самих тестов:
    // случайный порядок здесь только мешает читать падения.
    sequence: { shuffle: false },
  },
});

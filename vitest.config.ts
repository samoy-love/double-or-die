import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Ядро обязано не аллоцировать в горячем пути, а проверить это без
    // принудительной сборки мусора нельзя: куча растёт и опадает сама, и
    // замер получился бы зелёным при любом коде.
    poolOptions: { forks: { execArgv: ['--expose-gc'] } },
    // Детерминизм проверяется в том числе повторяемостью самих тестов:
    // случайный порядок здесь только мешает читать падения.
    sequence: { shuffle: false },
  },
});

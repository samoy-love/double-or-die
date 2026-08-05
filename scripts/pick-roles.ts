/**
 * Подбор несущих цветов ролей из палитры дизайн-системы.
 *
 * Запускается руками при смене арт-дирекшна, в CI не участвует: это
 * инструмент принятия решения, а не проверка. Проверку делает
 * `npm run check:contrast` — он и остаётся гейтом.
 */
import { deltaE } from '../packages/client/src/contrast';
import type { Rgb } from '../packages/client/src/palette';

const hex = (v: string): Rgb => {
  const n = parseInt(v.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
};

/** Палитра экосистемы samoy.love — из токенов дизайн-системы. */
const POOL: Record<string, string> = {
  'violet-300': '#c4b5fd',
  'violet-400': '#a78bfa',
  'violet-500': '#8b5cf6',
  'pink-400': '#f472b6',
  'pink-500': '#ec4899',
  'cyan-300': '#8fdcfa',
  'cyan-400': '#5ec8f5',
  'cyan-500': '#2ea8de',
  'blue-400': '#5c9df5',
  'blue-500': '#2f7ef0',
  'green-300': '#7cf0b0',
  'green-400': '#3ddc84',
  'green-500': '#22b467',
  'amber-300': '#f7cf7d',
  'amber-400': '#f2b544',
  'amber-500': '#d99420',
  'red-400': '#f0656a',
  'red-500': '#e5484d',
  'red-600': '#c33b40',
  'gold-400': '#e8c26a',
  'paper-100': '#e8ecf4',
  'paper-300': '#c3cad8',
  'paper-500': '#9aa3b5',
};

/** Тёмная заливка всех сущностей и фон — из них силуэт обязан выделяться. */
const FILL = hex('#14161d');
const FLOOR = hex('#0f1116');

const ROLES = [
  'игрок 1',
  'игрок 2',
  'игрок 3',
  'игрок 4',
  'Клин',
  'Кирпич',
  'Фитиль',
  'фишка',
  'карта',
  'телеграф',
  'снаряд',
  'пари: стиль',
  'пари: темп',
  'пари: пространство',
  'пари: жадность',
  'пари: трюки',
  'пари: дурацкие',
];

const names = Object.keys(POOL);
const rgb = Object.fromEntries(Object.entries(POOL).map(([k, v]) => [k, hex(v)]));

// Жадный подбор: каждой роли достаётся цвет, максимизирующий минимальное
// расстояние до уже занятых. Порядок ролей — от самых важных к остальным:
// снаряд и телеграф решаются за долю секунды и берут лучшее.
const order = [
  'снаряд',
  'телеграф',
  'игрок 1',
  'Клин',
  'фишка',
  'карта',
  'игрок 2',
  'Кирпич',
  'игрок 3',
  'Фитиль',
  'игрок 4',
  'пари: стиль',
  'пари: темп',
  'пари: пространство',
  'пари: жадность',
  'пари: трюки',
  'пари: дурацкие',
];

const taken: Record<string, string> = {};
for (const role of order) {
  let best = '';
  let bestScore = -1;
  for (const n of names) {
    if (Object.values(taken).includes(n)) continue;
    // Силуэт: обводка обязана отличаться от заливки и от пола.
    const silhouette = Math.min(deltaE(rgb[n], FILL), deltaE(rgb[n], FLOOR));
    if (silhouette < 25) continue;
    let worst = silhouette;
    for (const other of Object.values(taken)) worst = Math.min(worst, deltaE(rgb[n], rgb[other]));
    if (worst > bestScore) {
      bestScore = worst;
      best = n;
    }
  }
  taken[role] = best;
}

console.log('роль → цвет (мин. ΔE до уже занятых)');
for (const role of order) {
  let worst = Infinity,
    near = '';
  for (const [r2, n2] of Object.entries(taken)) {
    if (r2 === role) continue;
    const d = deltaE(rgb[taken[role]], rgb[n2]);
    if (d < worst) {
      worst = d;
      near = r2;
    }
  }
  const sil = Math.min(deltaE(rgb[taken[role]], FILL), deltaE(rgb[taken[role]], FLOOR));
  console.log(
    role.padEnd(20),
    taken[role].padEnd(12),
    POOL[taken[role]],
    'ближайший',
    near.padEnd(18),
    worst.toFixed(1),
    '| силуэт',
    sil.toFixed(1),
  );
}
console.log(
  '\nхудшая пара:',
  Math.min(
    ...ROLES.flatMap((a) =>
      ROLES.filter((b) => b !== a).map((b) => deltaE(rgb[taken[a]], rgb[taken[b]])),
    ),
  ).toFixed(1),
);

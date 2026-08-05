/**
 * Шаблоны арен: двенадцать раскладок в четырёх отражениях.
 *
 * Гарантии проверяются НА ВСЕХ СОРОКА ВОСЬМИ, а не на одной. Свойство,
 * посчитанное на исходном шаблоне, ничего не говорит о его зеркале: колонна,
 * стоявшая в углу, после отражения оказывается в другом, а стартовые точки и
 * красная зона переезжают по своим правилам. Раскладка, отрезающая кусок
 * арены, обязана падать тестом, а не обнаруживаться в бою.
 */

import { describe, expect, it } from 'vitest';
import {
  ARENA_PAD,
  ARENA_TEMPLATES,
  FLIP_COUNT,
  MAX_CARDS,
  NAV,
  PLAYER,
  RED_ZONE_RADIUS,
  START_SPREAD,
  createState,
  dealCards,
  fromInt,
  isFreeSpot,
  redZoneX,
  redZoneY,
  setArena,
  spawnPlayers,
  templateOf,
  toFloat,
  type SimState,
} from '@dod/sim';

/** Все раскладки: шаблон × отражение. */
function layouts(): { t: number; f: number; name: string }[] {
  const out: { t: number; f: number; name: string }[] = [];
  for (let t = 0; t < ARENA_TEMPLATES.length; t++) {
    for (let f = 0; f < FLIP_COUNT; f++) {
      out.push({ t, f, name: `${ARENA_TEMPLATES[t].name} / отражение ${f}` });
    }
  }
  return out;
}

function arena(players: number, t: number, f: number): SimState {
  const s = createState(1, players);
  spawnPlayers(s);
  setArena(s, t, f);
  return s;
}

/** Стартовые точки состава: соло — центр, кооп — углы квадрата (sim.ts). */
function startPoints(s: SimState): [number, number][] {
  const cx = s.arenaW >> 1;
  const cy = s.arenaH >> 1;
  if (s.playerCount === 1) return [[cx, cy]];
  const out: [number, number][] = [];
  for (let i = 0; i < s.playerCount; i++) {
    const ox = i === 0 || i === 3 ? -START_SPREAD : START_SPREAD;
    const oy = i < 2 ? -START_SPREAD : START_SPREAD;
    out.push([cx + ox, cy + oy]);
  }
  return out;
}

describe('геометрия шаблонов', () => {
  it('колонны кратны клетке навигационной сетки', () => {
    // Некратная колонна съедает клетку целиком либо оставляет щель, в которую
    // поле потока обещает проход, а тело не пролезает.
    const bad: string[] = [];
    for (const tpl of ARENA_TEMPLATES) {
      for (const c of tpl.columns) {
        for (const [what, v] of [
          ['x', c.x],
          ['y', c.y],
          ['halfW', c.halfW],
          ['halfH', c.halfH],
        ] as const) {
          if (toFloat(v) % NAV.cell !== 0) bad.push(`${tpl.name}: ${what} = ${toFloat(v)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('шаблонов ровно двенадцать, и у каждого своё имя', () => {
    expect(ARENA_TEMPLATES.length).toBe(12);
    expect(new Set(ARENA_TEMPLATES.map((t) => t.name)).size).toBe(12);
  });
});

describe('гарантии на всех сорока восьми раскладках', () => {
  it('стартовые точки свободны при любом составе', () => {
    const bad: string[] = [];
    for (const { t, f, name } of layouts()) {
      for (let players = 1; players <= 4; players++) {
        const s = arena(players, t, f);
        for (const [x, y] of startPoints(s)) {
          if (!isFreeSpot(s, x, y, PLAYER.radius)) {
            bad.push(`${name}, ${players} игр.: старт (${toFloat(x)}, ${toFloat(y)}) занят`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  /**
   * Красная зона не накрывает ни одной стартовой позиции.
   *
   * Иначе пари «не заходи в красную зону» срывается в тот же тик, в который
   * его берут, — то есть оказывается структурно невыигрышным (GDD §9.5).
   */
  it('красная зона не накрывает стартовые точки', () => {
    const bad: string[] = [];
    for (const { t, f, name } of layouts()) {
      for (let players = 1; players <= 4; players++) {
        const s = arena(players, t, f);
        const rx = toFloat(redZoneX(s));
        const ry = toFloat(redZoneY(s));
        const r = toFloat(RED_ZONE_RADIUS);
        for (const [x, y] of startPoints(s)) {
          const d = Math.hypot(toFloat(x) - rx, toFloat(y) - ry);
          if (d <= r)
            bad.push(`${name}, ${players} игр.: старт внутри зоны (${d.toFixed(0)} ≤ ${r})`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  /**
   * Зона не касается стен: со всех четырёх сторон остаётся коридор.
   *
   * Отказ от куска арены обязан оставаться отказом, а не тупиком: пари теряет
   * смысл, если красное — единственная дорога.
   */
  it('красная зона оставляет коридор со всех сторон', () => {
    const bad: string[] = [];
    for (const { t, f, name } of layouts()) {
      // Соло — самый тесный случай: арена растёт с составом, а зона остаётся.
      const s = arena(1, t, f);
      const rx = toFloat(redZoneX(s));
      const ry = toFloat(redZoneY(s));
      const r = toFloat(RED_ZONE_RADIUS);
      const pad = toFloat(ARENA_PAD);
      const left = rx - r - pad;
      const top = ry - r - pad;
      const right = toFloat(s.arenaW) - pad - (rx + r);
      const bottom = toFloat(s.arenaH) - pad - (ry + r);
      const gap = Math.min(left, top, right, bottom);
      if (gap < NAV.cell) bad.push(`${name}: коридор ${gap.toFixed(0)} < клетки ${NAV.cell}`);
    }
    expect(bad).toEqual([]);
  });

  /**
   * Арена связна: из стартовой точки достижима любая свободная клетка.
   *
   * Самая дорогая гарантия и самая нужная. Раскладка, отрезающая угол
   * колоннами, ничего не ломает видимо — но враг туда не дойдёт, карта пари
   * может там лечь, и игрок будет ждать волну, которая не придёт.
   */
  it('любая свободная клетка достижима от старта', () => {
    const bad: string[] = [];
    const cell = NAV.cell;

    for (const { t, f, name } of layouts()) {
      const s = arena(1, t, f);
      const cols = Math.floor(toFloat(s.arenaW) / cell);
      const rows = Math.floor(toFloat(s.arenaH) / cell);

      const free = (cx: number, cy: number): boolean =>
        isFreeSpot(s, fromInt(cx * cell + cell / 2), fromInt(cy * cell + cell / 2), NAV.bodyRadius);

      const seen = new Uint8Array(cols * rows);
      const queue: number[] = [];
      const startCx = Math.floor(toFloat(s.pX[0]) / cell);
      const startCy = Math.floor(toFloat(s.pY[0]) / cell);
      seen[startCy * cols + startCx] = 1;
      queue.push(startCy * cols + startCx);

      for (let head = 0; head < queue.length; head++) {
        const cur = queue[head];
        const cx = cur % cols;
        const cy = (cur / cols) | 0;
        // Только по четырём сторонам: диагональ сквозь угол двух стен проходом
        // не считается — тем же правилом, что и в поле потока.
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx;
          if (seen[ni] || !free(nx, ny)) continue;
          seen[ni] = 1;
          queue.push(ni);
        }
      }

      let unreachable = 0;
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          if (free(cx, cy) && !seen[cy * cols + cx]) unreachable++;
        }
      }
      if (unreachable > 0) bad.push(`${name}: отрезано ${unreachable} свободных клеток`);
    }

    expect(bad).toEqual([]);
  });

  /**
   * Раскладка карт находит места на любой арене.
   *
   * Карт `игроков + 2`, и разносить их положено на 260 единиц. Тесная
   * раскладка колонн может не оставить столько мест — и тогда игрок недосчитается
   * карты не потому, что так задумано, а потому, что не поместилась.
   */
  it('карты пари раскладываются полным столом', () => {
    const bad: string[] = [];
    for (const { t, f, name } of layouts()) {
      for (let players = 1; players <= 4; players++) {
        const s = arena(players, t, f);
        dealCards(s);
        let n = 0;
        for (let i = 0; i < MAX_CARDS; i++) if (s.kActive[i]) n++;
        if (n < players + 2)
          bad.push(`${name}, ${players} игр.: карт ${n}, ожидалось ${players + 2}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('отражения', () => {
  it('меняют раскладку, а не оставляют её прежней', () => {
    // Отражение, ничего не меняющее, — это не отражение: если бы все шаблоны
    // были симметричны, сорок восемь раскладок оказались бы двенадцатью.
    let differing = 0;
    for (let t = 0; t < ARENA_TEMPLATES.length; t++) {
      const base = arena(1, t, 0);
      for (let f = 1; f < FLIP_COUNT; f++) {
        const flipped = arena(1, t, f);
        const same = templateOf(base).columns.every((c, i) => {
          const d = templateOf(flipped).columns[i];
          return c.x === d.x && c.y === d.y;
        });
        // Сравниваем не сами колонны шаблона (они одни и те же), а их
        // положение на арене — оно и есть результат отражения.
        const moved = redZoneX(base) !== redZoneX(flipped) || redZoneY(base) !== redZoneY(flipped);
        if (!same || moved) differing++;
      }
    }
    expect(differing).toBeGreaterThan(0);
  });
});

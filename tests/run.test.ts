/**
 * Структура забега: три этажа по восемь комнат, и он кончается.
 *
 * До 0.4.0 забег был бесконечным счётчиком комнат. Ворота версии требуют
 * полного прохождения за 12–18 минут — то есть чего-то, что имеет конец,
 * итоги и ключи. Здесь проверяется рамка, а не бой внутри неё.
 */

import { describe, expect, it } from 'vitest';
import {
  ENEMIES,
  ENEMY_TYPE_COUNT,
  FLOORS_PER_RUN,
  KEYS,
  Meta,
  ROOMS_PER_FLOOR,
  RunPhase,
  WAVE,
  createState,
  makeFrame,
  roomBudget,
  setSpawning,
  spawnPlayers,
  step,
  type SimState,
} from '@dod/sim';

const idle = [makeFrame()];

function fresh(players = 1): SimState {
  const s = createState(1, players);
  spawnPlayers(s);
  setSpawning(s, false);
  return s;
}

/** Поставить забег в конец комнаты: арена пуста, волны выбраны. */
function atRoomEnd(s: SimState, floor: number, room: number): void {
  setSpawning(s, true);
  s.meta[Meta.Floor] = floor;
  s.meta[Meta.Room] = room;
  s.meta[Meta.Wave] = WAVE.wavesPerRoom;
  s.meta[Meta.WaveBudget] = 0;
  s.meta[Meta.NextWaveAt] = 0;
  s.eActive.fill(0);
  s.spActive.fill(0);
}

describe('бюджет угрозы по этажам', () => {
  it('удваивается с каждым этажом', () => {
    const first = roomBudget(1, 1, 1);
    expect(roomBudget(1, 1, 2)).toBe(first * 2);
    expect(roomBudget(1, 1, 3)).toBe(first * 4);
  });

  /**
   * Числа из таблицы DIFFICULTY §4 — она выведена из целевых длительностей
   * комнат, и разъехавшись с ней, бюджет перестаёт означать «столько-то
   * секунд боя».
   */
  it('сходится с таблицей целевых длительностей', () => {
    expect(roomBudget(1, 1, 1)).toBe(300);
    expect(roomBudget(ROOMS_PER_FLOOR, 1, 1)).toBe(468);
    expect(roomBudget(1, 1, 2)).toBe(600);
    expect(roomBudget(1, 1, 3)).toBe(1200);
  });

  it('комната считается внутри этажа, а не сквозной по забегу', () => {
    // Первая комната второго этажа обязана быть ровно вдвое тяжелее первой
    // комнаты первого — а не тяжелее девятой, которой не существует.
    expect(roomBudget(1, 1, 2)).toBe(roomBudget(1, 1, 1) * 2);
  });
});

describe('расписание врагов', () => {
  /**
   * Правило «не чаще одного нового типа за две комнаты» (DIFFICULTY §7).
   *
   * Раньше оно держалось на удачно расставленных `unlockRoom` и НЕ
   * выполнялось: типы открывались в комнатах 1, 2 и 3 подряд. Теперь это
   * расписание, и его проверяет машина.
   */
  it('новый тип открывается не чаще одного раза в две комнаты', () => {
    const opens: number[] = [];
    for (let t = 0; t < ENEMY_TYPE_COUNT; t++) {
      const e = ENEMIES[t];
      // Сквозной номер комнаты по забегу — только для проверки расстояния.
      opens.push((e.unlockFloor - 1) * ROOMS_PER_FLOOR + e.unlockRoom);
    }
    opens.sort((a, b) => a - b);
    for (let i = 1; i < opens.length; i++) {
      expect(opens[i] - opens[i - 1]).toBeGreaterThanOrEqual(2);
    }
  });

  it('совпадает с таблицей DIFFICULTY §7', () => {
    // Клин 1–1, Фитиль 1–3, Кирпич 1–5.
    expect([ENEMIES[0].unlockFloor, ENEMIES[0].unlockRoom]).toEqual([1, 1]);
    expect([ENEMIES[2].unlockFloor, ENEMIES[2].unlockRoom]).toEqual([1, 3]);
    expect([ENEMIES[1].unlockFloor, ENEMIES[1].unlockRoom]).toEqual([1, 5]);
  });

  it('первый тип открыт с первой комнаты: пустых комнат не бывает', () => {
    let earliest = Number.MAX_SAFE_INTEGER;
    for (let t = 0; t < ENEMY_TYPE_COUNT; t++) {
      const e = ENEMIES[t];
      earliest = Math.min(earliest, (e.unlockFloor - 1) * ROOMS_PER_FLOOR + e.unlockRoom);
    }
    expect(earliest).toBe(1);
  });
});

describe('конец забега', () => {
  it('восьмая комната ведёт на следующий этаж, а не в девятую', () => {
    const s = fresh();
    atRoomEnd(s, 1, ROOMS_PER_FLOOR);
    step(s, idle);
    expect(s.meta[Meta.Floor]).toBe(2);
    expect(s.meta[Meta.Room]).toBe(1);
  });

  it('восьмая комната последнего этажа кончает забег победой', () => {
    const s = fresh();
    atRoomEnd(s, FLOORS_PER_RUN, ROOMS_PER_FLOOR);
    step(s, idle);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Summary);
    expect(s.meta[Meta.Victory]).toBe(1);
  });

  it('любой забег даёт хотя бы один ключ', () => {
    const s = fresh();
    // Ни одного выполненного пари и пустой кошелёк: формула даёт ноль, а
    // утешительный пол — единицу (ECONOMY §12).
    s.pChips.fill(0);
    s.meta[Meta.BetsWon] = 0;
    atRoomEnd(s, FLOORS_PER_RUN, ROOMS_PER_FLOOR);
    step(s, idle);
    expect(s.meta[Meta.Keys]).toBe(KEYS.floor);
  });

  it('непотраченные фишки конвертируются в ключи', () => {
    const s = fresh();
    s.pChips[0] = KEYS.chipsPerKey * 3;
    s.meta[Meta.BetsWon] = 0;
    atRoomEnd(s, FLOORS_PER_RUN, ROOMS_PER_FLOOR);
    step(s, idle);
    expect(s.meta[Meta.Keys]).toBe(3);
  });

  it('комната внутри этажа продолжается обычным порядком', () => {
    const s = fresh();
    atRoomEnd(s, 1, 3);
    step(s, idle);
    expect(s.meta[Meta.Floor]).toBe(1);
    expect(s.meta[Meta.Room]).toBe(4);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Fight);
  });
});

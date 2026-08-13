/**
 * Экран двери: единственное решение забега, принимаемое не под обстрелом.
 *
 * Проверяются правила, а не вкус: веса — данные и меняются балансировщиком, а
 * вот «два одинаковых типа не предлагаются» и «Лавка гарантирована» держат
 * экран решением, а не декорацией.
 */

import { describe, expect, it } from 'vitest';
import {
  Btn,
  DOORS,
  DoorType,
  MAX_DOORS,
  Meta,
  ROOMS_PER_FLOOR,
  RunPhase,
  WAVE,
  createState,
  makeFrame,
  setSpawning,
  spawnPlayers,
  step,
  type InputFrame,
  type SimState,
} from '@dod/sim';

const idle = [makeFrame()];
const press = (b: number): InputFrame[] => [{ ...makeFrame(), buttons: b }];

function fresh(): SimState {
  const s = createState(1);
  spawnPlayers(s);
  setSpawning(s, false);
  return s;
}

/** Довести комнату до конца: арена пуста, волны выбраны. */
function clearRoom(s: SimState, room: number): void {
  setSpawning(s, true);
  s.meta[Meta.Room] = room;
  s.meta[Meta.Wave] = WAVE.wavesPerRoom;
  s.meta[Meta.WaveBudget] = 0;
  s.meta[Meta.NextWaveAt] = 0;
  s.eActive.fill(0);
  s.spActive.fill(0);
  step(s, idle);
}

/** Выбрать дверь `n` и подтвердить. */
function chooseDoor(s: SimState, n: number): void {
  // Первое нажатие ставит фокус со стороны жеста: «влево» — на крайнюю левую
  // дверь. Дальше шагаем вправо до нужной.
  step(s, press(Btn.NavLeft));
  for (let i = 0; i < n; i++) {
    step(s, idle);
    step(s, press(Btn.NavRight));
  }
  step(s, idle);
  step(s, press(Btn.Confirm));
}

describe('раскладка дверей', () => {
  it('после комнаты встаёт экран двери, а не следующая комната', () => {
    const s = fresh();
    clearRoom(s, 1);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Door);
    expect(s.meta[Meta.Room]).toBe(1);
  });

  it('предлагается три двери, и все разных типов', () => {
    const s = fresh();
    clearRoom(s, 1);
    const types = Array.from({ length: MAX_DOORS }, (_, i) => s.doorType[i]);
    expect(types).toHaveLength(3);
    expect(new Set(types).size).toBe(3);
  });

  it('Событие не выпадает: содержания у него нет', () => {
    // Вес нулевой, поэтому дверь не может выпасть ни на одном сиде.
    for (let seed = 1; seed <= 40; seed++) {
      const s = createState(seed);
      spawnPlayers(s);
      setSpawning(s, false);
      clearRoom(s, 1);
      for (let i = 0; i < MAX_DOORS; i++) expect(s.doorType[i]).not.toBe(DoorType.Event);
    }
  });

  it('Лавка гарантирована не позже пятой комнаты', () => {
    const s = fresh();
    clearRoom(s, DOORS.shopBy - 1);
    let hasShop = false;
    for (let i = 0; i < MAX_DOORS; i++) if (s.doorType[i] === DoorType.Shop) hasShop = true;
    expect(hasShop, 'этаж без Лавки наказывает за чужой бросок кубика').toBe(true);
  });

  it('при долге одна из дверей замещается Долговой ямой', () => {
    const s = fresh();
    s.meta[Meta.Debt] = 40;
    clearRoom(s, 1);
    let pits = 0;
    for (let i = 0; i < MAX_DOORS; i++) if (s.doorType[i] === DoorType.DebtPit) pits++;
    // Замещается, а не добавляется: выход из долга обязан стоить выбора.
    expect(pits).toBe(1);
    expect(MAX_DOORS).toBe(3);
  });
});

describe('выбор двери', () => {
  it('экран ждёт игрока, а не часов', () => {
    const s = fresh();
    clearRoom(s, 1);
    for (let i = 0; i < 600; i++) step(s, idle);
    // Десять секунд молчания ничего не решили за игрока.
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Door);
    expect(s.meta[Meta.Room]).toBe(1);
  });

  it('подтверждение начинает комнату выбранного типа', () => {
    const s = fresh();
    clearRoom(s, 1);
    const want = s.doorType[0];
    chooseDoor(s, 0);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Fight);
    expect(s.meta[Meta.Room]).toBe(2);
    expect(s.meta[Meta.RoomType]).toBe(want);
  });

  it('фокус упирается в края, а не переносится по кругу', () => {
    const s = fresh();
    clearRoom(s, 1);
    for (let i = 0; i < 10; i++) step(s, press(i % 2 === 0 ? Btn.NavRight : 0));
    expect(s.meta[Meta.DoorPick]).toBe(MAX_DOORS - 1);
    for (let i = 0; i < 20; i++) step(s, press(i % 2 === 0 ? Btn.NavLeft : 0));
    expect(s.meta[Meta.DoorPick]).toBe(0);
  });

  it('без выбранной двери подтверждение ничего не делает', () => {
    const s = fresh();
    clearRoom(s, 1);
    step(s, press(Btn.Confirm));
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Door);
  });

  it('аппетит выбирается на двери и держится всю комнату', () => {
    const s = fresh();
    clearRoom(s, 1);
    // Тир едет со сдвигом на единицу: «Нормально» это 2 в битах.
    const tier = 1;
    step(s, press(Btn.NavLeft));
    step(s, [{ ...makeFrame(), buttons: (tier + 1) << 8 }]);
    step(s, press(Btn.Confirm));
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Fight);
    expect(s.pAppetite[0]).toBe(tier);
  });
});

describe('время на экране двери', () => {
  it('мир не шагает: враги не спавнятся, пока игрок читает', () => {
    const s = fresh();
    clearRoom(s, 1);
    const tick = s.tick;
    for (let i = 0; i < 300; i++) step(s, idle);
    // Тик идёт — на экране двери время тоже время, — а мир стоит.
    expect(s.tick).toBe(tick + 300);
    let alive = 0;
    for (let i = 0; i < s.eActive.length; i++) if (s.eActive[i]) alive++;
    expect(alive).toBe(0);
  });

  it('первая комната этажа выбора не предлагает', () => {
    const s = fresh();
    // Забег начинается сразу боем: игрок только что вошёл на этаж.
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Fight);
    expect(s.meta[Meta.Room]).toBe(1);
    expect(s.meta[Meta.RoomType]).toBe(DoorType.Fight);
  });

  it('восьмая комната упирается в босса, а не в дверь', () => {
    const s = fresh();
    clearRoom(s, ROOMS_PER_FLOOR);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Boss);
  });
});

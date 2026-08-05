/**
 * Навигация по экранам: каждый элемент достижим, тупиков фокуса нет.
 *
 * Требование чеклиста 0.4.0 (ROADMAP, «Навигация геймпадом») и проверка
 * принципа 1 из UX §1: **всё, что доступно с геймпада, доступно с клавиатуры и
 * мыши**. Раньше оно держалось вычиткой таблицы UX §2 перед выпуском — и
 * пропустило самый крупный из возможных пропусков: биты `NavLeft`,
 * `NavRight`, `Confirm` и `Cancel` существовали в ядре, экран двери их читал,
 * а класть их в кадр было НЕЧЕМУ. Единственное решение забега, принимаемое не
 * под обстрелом, руками не принималось вовсе; прогоны при этом шли, потому что
 * боты собирают маску сами.
 *
 * Поэтому проверяется не «есть ли раскладка», а два свойства подряд:
 *
 *   1. у каждого экранного действия есть путь с ОБЕИХ схем ввода — пустая
 *      клетка в таблице UX §2 роняет тест;
 *   2. этими путями фокус доходит до любого элемента и ниоткуда не застревает,
 *      причём одинаково с геймпада и с клавиатуры.
 *
 * Экран торга проверяется иначе, чем дверь и лавка, и это свойство ядра, а не
 * поблажка тесту: варианта там выбирают КНОПКОЙ, а не курсором
 * (`stepHouseCut`), поэтому «достижимость» для него означает, что у каждого
 * живого варианта есть свой путь на обеих схемах.
 */

import { describe, expect, it } from 'vitest';
import {
  Btn,
  EMPTY_INPUT,
  MAX_DOORS,
  Meta,
  RunPhase,
  SHOP_SLOTS,
  type InputFrame,
  type SimState,
  canPay,
  createState,
  debtOnBet,
  enterHouseCut,
  offerDoors,
  openShop,
  spawnPlayers,
  stepDoors,
  stepHouseCut,
  stepShop,
} from '@dod/sim';
import { SCREEN_BINDINGS } from '@dod/client/input';

/** Схемы ввода, которые обязаны уметь всё одинаково (UX §1, принцип 1). */
type Scheme = 'pad' | 'keys';

/**
 * Маска кадра, которую даст схема, когда игрок выполнил это действие.
 *
 * Ноль означает, что на этой схеме действия НЕТ, — и дальше он честно
 * проваливает проверку достижимости, а не молча делает вид, что фокус стоит на
 * месте по своей воле.
 *
 * Горизонталь считается доступной обеим схемам: на геймпаде её даёт левый
 * стик, на клавиатуре — `A`/`D`, и приходит она одним и тем же `moveX`.
 */
function bits(scheme: Scheme, bit: number): number {
  const b = SCREEN_BINDINGS.find((x) => x.bit === bit);
  if (!b) throw new Error(`нет раскладки для бита ${bit}`);
  if (b.axis !== 0) return bit;
  return (scheme === 'pad' ? b.pad.length : b.keys.length) > 0 ? bit : 0;
}

const frame = (buttons: number): InputFrame => ({ ...EMPTY_INPUT, buttons });

/**
 * Одно нажатие: кадр с кнопкой и кадр без неё.
 *
 * Фронт считает ядро (`pressed = buttons & ~pPrevButtons`), поэтому удержание
 * без отпускания двигает фокус ровно один раз — и тест обязан нажимать так же,
 * как живой ввод, иначе он проверял бы не игру.
 */
function tap(s: SimState, buttons: number, step: (s: SimState, i: InputFrame[]) => boolean): void {
  step(s, [frame(buttons)]);
  step(s, [frame(0)]);
}

function atDoors(): SimState {
  const s = createState(7, 1);
  spawnPlayers(s);
  offerDoors(s);
  return s;
}

describe('раскладка экранных действий', () => {
  it('у каждого действия есть путь и с геймпада, и с клавиатуры', () => {
    for (const b of SCREEN_BINDINGS) {
      const pad = b.pad.length > 0 || b.axis !== 0;
      const keys = b.keys.length > 0 || b.axis !== 0;
      expect(pad, `бит ${b.bit}: нет кнопки геймпада`).toBe(true);
      expect(keys, `бит ${b.bit}: нет клавиши`).toBe(true);
    }
  });

  it('все четыре экранных бита розданы', () => {
    const covered = SCREEN_BINDINGS.map((b) => b.bit).sort();
    expect(covered).toEqual([Btn.NavLeft, Btn.NavRight, Btn.Confirm, Btn.Cancel].sort());
  });

  it('одна кнопка не значит двух разных вещей', () => {
    const pad = SCREEN_BINDINGS.flatMap((b) => b.pad);
    const keys = SCREEN_BINDINGS.flatMap((b) => b.keys);
    expect(new Set(pad).size, 'кнопка геймпада занята дважды').toBe(pad.length);
    expect(new Set(keys).size, 'клавиша занята дважды').toBe(keys.length);
  });
});

describe.each(['pad', 'keys'] as const)('экран двери с «%s»', (scheme) => {
  const left = bits(scheme, Btn.NavLeft);
  const right = bits(scheme, Btn.NavRight);
  const confirm = bits(scheme, Btn.Confirm);

  it('первое нажатие поднимает фокус из «ничего не выбрано»', () => {
    const s = atDoors();
    expect(s.meta[Meta.DoorPick]).toBe(-1);
    tap(s, right, stepDoors);
    expect(s.meta[Meta.DoorPick]).toBe(0);

    const back = atDoors();
    tap(back, left, stepDoors);
    expect(back.meta[Meta.DoorPick], 'влево из пустоты — на последнюю дверь').toBe(MAX_DOORS - 1);
  });

  it('достижима каждая дверь из каждой', () => {
    for (let from = 0; from < MAX_DOORS; from++) {
      for (let to = 0; to < MAX_DOORS; to++) {
        const s = atDoors();
        // Встаём на исходную дверь теми же нажатиями, что и игрок.
        tap(s, right, stepDoors);
        for (let i = 0; i < from; i++) tap(s, right, stepDoors);
        expect(s.meta[Meta.DoorPick]).toBe(from);

        const step = to > from ? right : left;
        for (let i = 0; i < Math.abs(to - from); i++) tap(s, step, stepDoors);
        expect(s.meta[Meta.DoorPick], `${from} → ${to}`).toBe(to);
      }
    }
  });

  it('упор в край не роняет выбор', () => {
    const s = atDoors();
    tap(s, right, stepDoors);
    // Пять нажатий подряд при трёх дверях: за краем фокус обязан ОСТАТЬСЯ на
    // крайней, а не обнулиться и не перепрыгнуть по кругу — «поменьше» на
    // нижнем тире не имеет права стать «по-крупному» (UX §2).
    for (let i = 0; i < 5; i++) tap(s, left, stepDoors);
    expect(s.meta[Meta.DoorPick]).toBe(0);
    for (let i = 0; i < 5 + MAX_DOORS; i++) tap(s, right, stepDoors);
    expect(s.meta[Meta.DoorPick]).toBe(MAX_DOORS - 1);
  });

  it('подтверждение работает только по выбранной двери', () => {
    const s = atDoors();
    expect(stepDoors(s, [frame(confirm)]), 'подтвердил пустой выбор').toBe(false);
    stepDoors(s, [frame(0)]);
    tap(s, right, stepDoors);
    expect(stepDoors(s, [frame(confirm)]), 'выбранная дверь не подтверждается').toBe(true);
  });
});

describe.each(['pad', 'keys'] as const)('лавка с «%s»', (scheme) => {
  const left = bits(scheme, Btn.NavLeft);
  const right = bits(scheme, Btn.NavRight);
  const confirm = bits(scheme, Btn.Confirm);
  const cancel = bits(scheme, Btn.Cancel);

  function atShop(chips: number): SimState {
    const s = createState(7, 1);
    spawnPlayers(s);
    s.pChips[0] = chips;
    openShop(s);
    return s;
  }

  it('достижим каждый слот прилавка', () => {
    const s = atShop(1000);
    tap(s, right, stepShop);
    expect(s.meta[Meta.DoorPick]).toBe(0);
    for (let i = 1; i < SHOP_SLOTS; i++) {
      tap(s, right, stepShop);
      expect(s.meta[Meta.DoorPick]).toBe(i);
    }
    for (let i = SHOP_SLOTS - 2; i >= 0; i--) {
      tap(s, left, stepShop);
      expect(s.meta[Meta.DoorPick]).toBe(i);
    }
  });

  it('упор в край не роняет выбор', () => {
    const s = atShop(1000);
    tap(s, right, stepShop);
    for (let i = 0; i < 5; i++) tap(s, left, stepShop);
    expect(s.meta[Meta.DoorPick]).toBe(0);
    for (let i = 0; i < 5 + SHOP_SLOTS; i++) tap(s, right, stepShop);
    expect(s.meta[Meta.DoorPick]).toBe(SHOP_SLOTS - 1);
  });

  it('покупка идёт по фокусу, а выход — отказом', () => {
    const s = atShop(1000);
    tap(s, right, stepShop);
    const price = s.shopPrice[0];
    const before = s.pChips[0];
    stepShop(s, [frame(confirm)]);
    stepShop(s, [frame(0)]);
    expect(s.pChips[0], 'покупка не списала цену выбранного слота').toBe(before - price);
    expect(s.shopItem[0], 'товар остался на прилавке').toBe(0);

    // Уйти без покупки — законное решение, и оно обязано быть доступно с
    // обеих схем: экран, из которого нельзя выйти, отнимает выбор «унести».
    expect(stepShop(s, [frame(cancel)]), 'из лавки не выйти отказом').toBe(true);
  });
});

describe.each(['pad', 'keys'] as const)('экран платы с «%s»', (scheme) => {
  const confirm = bits(scheme, Btn.Confirm);
  const cancel = bits(scheme, Btn.Cancel);

  function atHouseCut(chips: number): SimState {
    const s = createState(7, 1);
    spawnPlayers(s);
    s.pChips[0] = chips;
    enterHouseCut(s);
    return s;
  }

  it('и подтверждение, и отказ закрывают экран', () => {
    for (const button of [confirm, cancel]) {
      for (const chips of [0, 100_000]) {
        const s = atHouseCut(chips);
        expect(s.meta[Meta.Phase]).toBe(RunPhase.HouseCut);
        expect(stepHouseCut(s, [frame(button)]), 'экран не отвечает на нажатие').toBe(true);
      }
    }
  });

  /*
   * Оба живых варианта торга проверяются по отдельности: экран рисует их
   * разными карточками с разными кнопками, и перепутанные местами они означали
   * бы, что игрок берёт проклятие, целясь в пари.
   */
  it('подтверждение при нехватке берёт пари, а не долг', () => {
    const s = atHouseCut(0);
    expect(canPay(s), 'кошелька хватило — проверяется не тот случай').toBe(false);
    expect(stepHouseCut(s, [frame(confirm)])).toBe(true);
    expect(s.meta[Meta.Debt], 'недостача не записана').toBeGreaterThan(0);
    expect(debtOnBet(s), 'вместо пари выдано проклятие').toBe(true);
  });

  it('отказ при нехватке уводит в долг с проклятием', () => {
    const s = atHouseCut(0);
    expect(stepHouseCut(s, [frame(cancel)])).toBe(true);
    expect(s.meta[Meta.Debt]).toBeGreaterThan(0);
    expect(debtOnBet(s), 'долг оказался пари — экран назвал бы кнопку неверно').toBe(false);
  });
});

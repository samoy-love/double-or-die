/**
 * Дар: бесплатный апгрейд на выбор из трёх (GDD §5).
 *
 * От лавки он отличается ровно одним — цена не берётся, — и проверяется здесь
 * именно это отличие: что фишки остаются на месте, что подарок ровно один, что
 * экран не открывается, когда давать нечего, и что за чужой дверью его нет
 * вовсе. Ассортимент, потолок слотов и отказ от повторов — общие с лавкой и
 * проверены в `shop.test.ts`; дублировать их здесь значило бы завести второй
 * гейт на то же правило.
 */

import { describe, expect, it } from 'vitest';
import {
  Btn,
  DoorType,
  MAX_UPGRADE_SLOTS,
  Meta,
  RunPhase,
  SHOP_SLOTS,
  UPGRADE_COUNT,
  WAVE,
  createState,
  grantUpgrade,
  makeFrame,
  openGift,
  setSpawning,
  spawnPlayers,
  step,
  upgradeCount,
  type InputFrame,
  type SimState,
} from '@dod/sim';
import { passReward } from '@dod/tools/bots';

const idle = [makeFrame()];
const press = (b: number): InputFrame[] => [{ ...makeFrame(), buttons: b }];

function fresh(chips = 0): SimState {
  const s = createState(1);
  spawnPlayers(s);
  setSpawning(s, false);
  s.pChips[0] = chips;
  return s;
}

/** Довести комнату за названной дверью до конца: арена пуста, волны выбраны. */
function clearRoom(s: SimState, type: number, room = 2): void {
  setSpawning(s, true);
  s.meta[Meta.RoomType] = type;
  s.meta[Meta.Room] = room;
  s.meta[Meta.Wave] = WAVE.wavesPerRoom;
  s.meta[Meta.WaveBudget] = 0;
  s.meta[Meta.NextWaveAt] = 0;
  s.eActive.fill(0);
  s.spActive.fill(0);
  step(s, idle);
}

/** Взять первое предложение так, как это делает игрок: фокус и подтверждение. */
function takeFirst(s: SimState): void {
  step(s, press(Btn.NavRight));
  step(s, idle);
  step(s, press(Btn.Confirm));
}

describe('прилавок Дара', () => {
  it('встаёт после боя за дверью «Дар»', () => {
    const s = fresh();
    clearRoom(s, DoorType.Gift);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Reward);
    expect(s.shopItem[0]).toBeGreaterThan(0);
  });

  it('за чужой дверью не встаёт вовсе', () => {
    for (const type of [DoorType.Fight, DoorType.Fat, DoorType.DebtPit]) {
      const s = fresh();
      clearRoom(s, type);
      expect(s.meta[Meta.Phase]).toBe(RunPhase.Door);
      expect(s.shopItem[0]).toBe(0);
    }
  });

  it('выкладывает три предложения, и все без ценника', () => {
    for (let floor = 1; floor <= 3; floor++) {
      const s = fresh();
      s.meta[Meta.Floor] = floor;
      expect(openGift(s)).toBe(true);
      const items = Array.from({ length: SHOP_SLOTS }, (_, i) => s.shopItem[i]);
      expect(new Set(items).size).toBe(SHOP_SLOTS);
      // Ноль на всех трёх этажах: цена лавки растёт с этажом, а у подарка её
      // нет вовсе, и рост ей взяться неоткуда.
      for (let i = 0; i < SHOP_SLOTS; i++) expect(s.shopPrice[i]).toBe(0);
    }
  });
});

describe('подарок', () => {
  it('не списывает ни фишки', () => {
    const s = fresh(200);
    clearRoom(s, DoorType.Gift);
    takeFirst(s);
    expect(upgradeCount(s, 0)).toBe(1);
    expect(s.pChips[0]).toBe(200);
  });

  it('достаётся и тому, у кого в кошельке пусто', () => {
    const s = fresh(0);
    clearRoom(s, DoorType.Gift);
    takeFirst(s);
    expect(upgradeCount(s, 0)).toBe(1);
  });

  it('ровно один: взятый апгрейд закрывает экран', () => {
    const s = fresh(200);
    clearRoom(s, DoorType.Gift);
    takeFirst(s);

    expect(s.meta[Meta.Phase]).toBe(RunPhase.Door);
    expect(upgradeCount(s, 0)).toBe(1);
    // Прилавок убран, а фокус погашен: иначе начало комнаты приняло бы его за
    // выбранную дверь.
    expect(s.shopItem[0]).toBe(0);
    expect(s.meta[Meta.DoorPick]).toBe(-1);

    // И сколько бы игрок ни жал дальше, второго подарка нет.
    for (let t = 0; t < 10; t++) step(s, press(Btn.Confirm));
    expect(upgradeCount(s, 0)).toBe(1);
  });

  it('дальше двенадцати слотов не выдаёт', () => {
    const s = fresh();
    clearRoom(s, DoorType.Gift);
    /*
     * Состояние синтетическое: шести апгрейдов каталога на двенадцать слотов
     * не хватает, а потолок обязан держаться и тогда, когда каталог дорастёт
     * до ставочной ветки (0.6.0). Бесплатной выдаче он нужен ровно так же, как
     * покупке: подарок, кладущийся мимо слотов, — это подарок в никуда.
     */
    for (let i = 0; i < MAX_UPGRADE_SLOTS; i++) s.pUpgrades[i] = UPGRADE_COUNT;
    takeFirst(s);
    expect(upgradeCount(s, 0)).toBe(MAX_UPGRADE_SLOTS);
    // Экран при этом остаётся открытым: закрыть его нечем, взять — нечего, и
    // выход отказом обязан работать, иначе забег встал бы навсегда.
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Reward);
    step(s, press(Btn.Cancel));
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Door);
  });

  it('когда все шесть уже у стола, экрана нет — забег идёт дальше', () => {
    const s = fresh();
    for (let u = 0; u < UPGRADE_COUNT; u++) grantUpgrade(s, 0, u);
    expect(openGift(s)).toBe(false);

    clearRoom(s, DoorType.Gift);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Door);
    expect(s.shopItem[0]).toBe(0);
    expect(upgradeCount(s, 0)).toBe(UPGRADE_COUNT);
  });

  it('Дар восьмой комнаты не отменяет босса', () => {
    const s = fresh();
    clearRoom(s, DoorType.Gift, 8);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Reward);

    takeFirst(s);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Boss);
    expect(s.meta[Meta.Room]).toBe(8);
  });

  it('мир на экране Дара стоит: волны не идут, тик идёт', () => {
    const s = fresh();
    clearRoom(s, DoorType.Gift);
    const at = s.tick;
    for (let t = 0; t < 300; t++) step(s, idle);
    expect(s.tick).toBe(at + 300);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Reward);
    expect(s.eActive.some((a) => a === 1)).toBe(false);
  });
});

describe('бот проходит Дар', () => {
  it('берёт подарок и уходит, а не зависает на экране', () => {
    const s = fresh(0);
    clearRoom(s, DoorType.Gift);

    let guard = 0;
    while (s.meta[Meta.Phase] === RunPhase.Reward && guard++ < 200) {
      step(s, passReward(s, idle));
    }
    expect(s.meta[Meta.Phase]).not.toBe(RunPhase.Reward);
    // Нищий бот в лавке уходит ни с чем, а с Дара — с апгрейдом: ограничители
    // G2 и G3 считают набранное за забег, и пропущенный подарок занижал бы оба.
    expect(upgradeCount(s, 0)).toBe(1);
  });
});

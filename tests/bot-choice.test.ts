/**
 * Выбор двери и товара в лавке — предмет стратегии, а не жадности (задача
 * 2.5). Тест не гоняет забег целиком: живой бой решает, доживёт ли профиль до
 * двери вообще, а здесь проверяется другое — что САМ ВЫБОР, если экран
 * показан, зависит от стратегии и воспроизводим от сида. Экраны открываются
 * напрямую (`offerDoors`, `openShop`), тем же способом, что и в сценариях
 * (DEVLOOP §5) — так тест не зависит от того, доживает ли конкретный профиль
 * до конкретной двери в конкретном прогоне.
 */

import { describe, expect, it } from 'vitest';
import {
  DoorType,
  Meta,
  UpgradeEffect,
  UPGRADES,
  createState,
  offerDoors,
  openShop,
  spawnPlayers,
  step,
  type SimState,
} from '@dod/sim';
import { makeBot, type BotName } from '@dod/tools/bots';

/**
 * Гонит экран двери ботом до подтверждения; отдаёт выбранный слот.
 *
 * Слот читается ДО шага, на котором подтверждение закрывает дверь: та же
 * симуляция в тот же тик открывает следующую комнату и сбрасывает фокус
 * (`offerDoors` ставит `DoorPick = -1`), и прочитанный после шага фокус уже
 * ничего не говорит о том, что было выбрано.
 */
function resolveDoor(s: SimState, bot: BotName, ticks: number): number {
  const b = makeBot(bot, 1, 1);
  for (let t = 0; t < ticks; t++) {
    const before = s.meta[Meta.Phase];
    const pick = s.meta[Meta.DoorPick];
    step(s, b.inputs(s));
    if (s.meta[Meta.Phase] !== before) return pick; // дверь закрылась — выбор сделан
  }
  return s.meta[Meta.DoorPick];
}

/**
 * Гонит экран лавки ботом до ПЕРВОЙ покупки; отдаёт слот купленного.
 *
 * Лавка, в отличие от Дара, не закрывается после покупки (GDD §5) — бот может
 * взять несколько товаров подряд, поэтому останавливаться нужно не на смене
 * фазы, а на первом же опустевшем слоте прилавка.
 */
function resolveFirstBuy(s: SimState, bot: BotName, ticks: number): number {
  const b = makeBot(bot, 1, 1);
  const before = [...s.shopItem];
  for (let t = 0; t < ticks; t++) {
    step(s, b.inputs(s));
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== 0 && s.shopItem[i] === 0) return i;
    }
  }
  return -1;
}

describe('выбор двери — предмет стратегии', () => {
  /**
   * Три двери — Дар, Жирный бой, обычный бой. `none` копит на единственный
   * апгрейд забега (ECONOMY §6) и жирного боя избегает — обязан взять Дар.
   * `stack` держит максимальный стак ставок и именно под жирный бой держит
   * его (ECONOMY §9) — обязан взять его.
   */
  it('`novice:none` берёт Дар, `master:stack` — Жирный бой, при одном и том же наборе дверей', () => {
    const sNone = createState(1, 1);
    spawnPlayers(sNone);
    offerDoors(sNone);
    sNone.doorType[0] = DoorType.Fight;
    sNone.doorType[1] = DoorType.Fat;
    sNone.doorType[2] = DoorType.Gift;

    const sStack = createState(1, 1);
    spawnPlayers(sStack);
    offerDoors(sStack);
    sStack.doorType[0] = DoorType.Fight;
    sStack.doorType[1] = DoorType.Fat;
    sStack.doorType[2] = DoorType.Gift;

    expect(resolveDoor(sNone, 'novice:none', 40)).toBe(2);
    expect(resolveDoor(sStack, 'master:stack', 40)).toBe(1);
  });

  it('выбор воспроизводим от сида для одной и той же стратегии', () => {
    const make = (): SimState => {
      const s = createState(1, 1);
      spawnPlayers(s);
      offerDoors(s);
      s.doorType[0] = DoorType.Fight;
      s.doorType[1] = DoorType.Fat;
      s.doorType[2] = DoorType.Shop;
      return s;
    };
    const a = resolveDoor(make(), 'median:single', 40);
    const b = resolveDoor(make(), 'median:single', 40);
    expect(a).toBe(b);
  });

  /** Бот без профиля (легаси) сохраняет прежнее поведение — первая дверь. */
  it('`greedy` без профиля берёт первую дверь, как и раньше', () => {
    const s = createState(1, 1);
    spawnPlayers(s);
    offerDoors(s);
    s.doorType[0] = DoorType.Fight;
    s.doorType[1] = DoorType.Fat;
    s.doorType[2] = DoorType.Gift;
    expect(resolveDoor(s, 'greedy', 40)).toBe(0);
  });
});

describe('выбор товара в лавке — предмет стратегии', () => {
  /**
   * `none` копит на единственный апгрейд забега и берёт то, что «работает
   * после ошибки» — сердце (ECONOMY §5). `chips` ходит за фишками на полу и
   * берёт то, что прямо умножает добычу — Магнит (ECONOMY §4).
   */
  it('`novice:none` берёт Сердце, `master:chips` — Магнит, при одном и том же прилавке', () => {
    const heart = UPGRADES.findIndex((u) => u.effect === UpgradeEffect.Heart);
    const magnet = UPGRADES.findIndex((u) => u.effect === UpgradeEffect.Magnet);
    const damage = UPGRADES.findIndex((u) => u.effect === UpgradeEffect.Damage);
    expect(heart).toBeGreaterThanOrEqual(0);
    expect(magnet).toBeGreaterThanOrEqual(0);

    const makeShop = (): SimState => {
      const s = createState(1, 1);
      spawnPlayers(s);
      openShop(s);
      s.shopItem[0] = damage + 1;
      s.shopItem[1] = heart + 1;
      s.shopItem[2] = magnet + 1;
      s.shopPrice[0] = 1;
      s.shopPrice[1] = 1;
      s.shopPrice[2] = 1;
      s.pChips[0] = 1000;
      return s;
    };

    expect(resolveFirstBuy(makeShop(), 'novice:none', 40)).toBe(1);
    expect(resolveFirstBuy(makeShop(), 'master:chips', 40)).toBe(2);
  });

  /** Бот без профиля (легаси) сохраняет прежнее поведение — первый доступный слева направо. */
  it('`cautious` без профиля берёт первый доступный товар слева направо', () => {
    const s = createState(1, 1);
    spawnPlayers(s);
    openShop(s);
    const heart = UPGRADES.findIndex((u) => u.effect === UpgradeEffect.Heart);
    const magnet = UPGRADES.findIndex((u) => u.effect === UpgradeEffect.Magnet);
    const damage = UPGRADES.findIndex((u) => u.effect === UpgradeEffect.Damage);
    s.shopItem[0] = damage + 1;
    s.shopItem[1] = heart + 1;
    s.shopItem[2] = magnet + 1;
    s.shopPrice[0] = 1;
    s.shopPrice[1] = 1;
    s.shopPrice[2] = 1;
    s.pChips[0] = 1000;
    expect(resolveFirstBuy(s, 'cautious', 40)).toBe(0);
  });
});

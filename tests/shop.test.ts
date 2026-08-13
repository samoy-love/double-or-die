/**
 * Лавка: торговля и то, что купленное делает в бою.
 *
 * Проверяются правила, а не вкус: цены и величины эффектов — данные и
 * меняются балансировщиком, а вот «три из шести», «без повторов купленного» и
 * «кошелёк не уходит в минус» держат лавку решением, а не выдачей силы.
 *
 * Эффекты проверяются В БОЮ, а не по возвращаемому значению: апгрейд, который
 * посчитан правильно и никуда не подключён, — это ровно то, за что игрок
 * заплатил и чего не получил.
 */

import { describe, expect, it } from 'vitest';
import {
  Btn,
  CHIP,
  DoorType,
  ENEMIES,
  EnemyType,
  FLOORS_PER_RUN,
  MAX_UPGRADE_SLOTS,
  Meta,
  PISTOL,
  PLAYER,
  RunPhase,
  SHOP_SLOTS,
  UPGRADES,
  UPGRADE_COUNT,
  UpgradeEffect,
  UpgradeId,
  WAVE,
  buyUpgrade,
  canBuy,
  createState,
  damageOf,
  dashCooldownOf,
  dropChancePctOf,
  fire,
  fromInt,
  grantUpgrade,
  hasUpgrade,
  makeFrame,
  moveSpeedOf,
  openShop,
  pickupRadiusOf,
  priceOf,
  setSpawning,
  spawnEnemy,
  spawnPlayers,
  step,
  stepBullets,
  toFloat,
  upgradeCount,
  type InputFrame,
  type SimState,
} from '@dod/sim';
import { makeBot, passReward } from '@dod/tools/bots';

const idle = [makeFrame()];
const press = (b: number): InputFrame[] => [{ ...makeFrame(), buttons: b }];

function fresh(chips = 0): SimState {
  const s = createState(1);
  spawnPlayers(s);
  setSpawning(s, false);
  s.pChips[0] = chips;
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

/** Купить первый попавшийся товар с прилавка так, как это делает игрок. */
function buyFirst(s: SimState): void {
  step(s, press(Btn.NavLeft));
  step(s, idle);
  step(s, press(Btn.Confirm));
}

describe('цены лавки', () => {
  it('среднее по каталогу — ровно 45, из него посчитан бюджет игрока', () => {
    const sum = UPGRADES.reduce((acc, u) => acc + u.base, 0);
    expect(sum / UPGRADES.length).toBe(45);
  });

  /*
   * Витрина обязана совпадать с боем.
   *
   * Проценты каталога умножаются на целую базу и усекаются вниз — и «+25%» от
   * урона 10 давало 12.5, то есть 12: апгрейд молча стоил на 4% меньше
   * обещанного, а «+50%» дропа — на 1.3%. Ловится это не глазами при правке
   * одного товара, а проверкой всего каталога сразу, потому что промахнуться
   * имеет право любой процент, а видно промах только в отчёте балансировщика.
   *
   * Порог в один процент, а не ноль: откат рывка задан в тиках (72 × 70% =
   * 50.4 → 50), и требовать от него делимости значило бы двигать длительность
   * рывка ради арифметики. Восемь миллисекунд неощутимы, четыре процента
   * урона — нет.
   */
  it('процент каталога делится нацело: обещанное на витрине выдаётся в бою', () => {
    const bases: Partial<Record<UpgradeEffect, number>> = {
      [UpgradeEffect.Damage]: PISTOL.damage,
      [UpgradeEffect.DashCooldown]: PLAYER.dashCooldownTicks,
      [UpgradeEffect.Drop]: CHIP.dropChancePct,
      [UpgradeEffect.Speed]: PLAYER.speed,
    };

    for (const u of UPGRADES) {
      const base = bases[u.effect];
      if (base === undefined) continue;
      const exact = (base * u.value) / 100;
      const applied = Math.trunc(exact);
      expect(Math.abs(exact - applied) / exact).toBeLessThan(0.01);
    }
  });

  it('шесть апгрейдов с базами из ECONOMY §5', () => {
    expect(UPGRADE_COUNT).toBe(6);
    expect(UPGRADES.map((u) => u.base)).toEqual([60, 55, 45, 40, 40, 30]);
  });

  it('цена растёт как база × 1.5^(F−1) с усечением вниз', () => {
    // Те же числа, что в таблице расходов: средний ценник 45 → 67 → 101.
    expect(priceOf(45, 1)).toBe(45);
    expect(priceOf(45, 2)).toBe(67);
    expect(priceOf(45, 3)).toBe(101);
    expect(priceOf(60, 3)).toBe(135);
    expect(priceOf(30, 2)).toBe(45);
  });

  it('на прилавке стоят цены текущего этажа', () => {
    for (let floor = 1; floor <= FLOORS_PER_RUN; floor++) {
      const s = fresh();
      s.meta[Meta.Floor] = floor;
      openShop(s);
      for (let i = 0; i < SHOP_SLOTS; i++) {
        const spec = UPGRADES[s.shopItem[i] - 1];
        expect(s.shopPrice[i]).toBe(priceOf(spec.base, floor));
      }
    }
  });
});

describe('ассортимент', () => {
  it('предлагается три товара, и все разные', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const s = createState(seed);
      spawnPlayers(s);
      openShop(s);
      const items = Array.from({ length: SHOP_SLOTS }, (_, i) => s.shopItem[i]);
      expect(items.every((i) => i > 0 && i <= UPGRADE_COUNT)).toBe(true);
      expect(new Set(items).size).toBe(SHOP_SLOTS);
    }
  });

  it('купленное не предлагается снова', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const s = createState(seed);
      spawnPlayers(s);
      grantUpgrade(s, 0, UpgradeId.Magnet);
      grantUpgrade(s, 0, UpgradeId.SpeedUp);
      openShop(s);
      for (let i = 0; i < SHOP_SLOTS; i++) {
        expect(s.shopItem[i]).not.toBe(UpgradeId.Magnet + 1);
        expect(s.shopItem[i]).not.toBe(UpgradeId.SpeedUp + 1);
      }
    }
  });

  it('когда неприобретённого меньше трёх, прилавок просто короче', () => {
    const s = fresh();
    for (let u = 0; u < UPGRADE_COUNT - 1; u++) grantUpgrade(s, 0, u);
    openShop(s);
    expect(s.shopItem[0]).toBe(UPGRADE_COUNT);
    expect(s.shopItem[1]).toBe(0);
    expect(s.shopPrice[1]).toBe(0);
  });
});

describe('покупка', () => {
  it('списывает цену и выдаёт апгрейд', () => {
    const s = fresh(200);
    openShop(s);
    const price = s.shopPrice[0];
    const upgrade = s.shopItem[0] - 1;

    expect(buyUpgrade(s, 0, 0)).toBe(true);
    expect(s.pChips[0]).toBe(200 - price);
    expect(hasUpgrade(s, 0, upgrade)).toBe(true);
    // Товар уходит с прилавка: второго экземпляра у лавки нет.
    expect(s.shopItem[0]).toBe(0);
    expect(s.shopPrice[0]).toBe(0);
  });

  it('не уходит в минус: не хватило — не продано', () => {
    const s = fresh(5);
    openShop(s);
    expect(canBuy(s, 0, 0)).toBe(false);
    expect(buyUpgrade(s, 0, 0)).toBe(false);
    expect(s.pChips[0]).toBe(5);
    expect(upgradeCount(s, 0)).toBe(0);
  });

  it('второй экземпляр не продаётся', () => {
    const s = fresh(500);
    openShop(s);
    const upgrade = s.shopItem[0] - 1;
    expect(buyUpgrade(s, 0, 0)).toBe(true);
    // Тот же товар обратно на прилавок — покупка обязана отказать.
    s.shopItem[0] = upgrade + 1;
    s.shopPrice[0] = 10;
    expect(canBuy(s, 0, 0)).toBe(false);
    expect(s.pChips[0]).toBe(500 - priceOf(UPGRADES[upgrade].base, 1));
  });

  it('дальше двенадцати слотов не продаёт', () => {
    const s = fresh(500);
    openShop(s);
    /*
     * Состояние синтетическое: шести апгрейдов каталога на двенадцать слотов
     * не хватает, а потолок обязан держаться и тогда, когда каталог дорастёт
     * до ставочной ветки (0.6.0). Проверяется именно страж покупки.
     */
    for (let i = 0; i < MAX_UPGRADE_SLOTS; i++) s.pUpgrades[i] = UPGRADE_COUNT;
    expect(upgradeCount(s, 0)).toBe(MAX_UPGRADE_SLOTS);
    s.shopItem[0] = 1;
    s.shopPrice[0] = 10;
    expect(canBuy(s, 0, 0)).toBe(false);
  });

  it('пустой слот не продаётся и денег не берёт', () => {
    const s = fresh(500);
    openShop(s);
    s.shopItem[1] = 0;
    s.shopPrice[1] = 0;
    expect(buyUpgrade(s, 0, 1)).toBe(false);
    expect(s.pChips[0]).toBe(500);
  });

  it('сердце упирается в потолок пяти', () => {
    const s = fresh();
    s.pHearts[0] = PLAYER.startHearts;
    grantUpgrade(s, 0, UpgradeId.ExtraHeart);
    expect(s.pHearts[0]).toBe(PLAYER.startHearts + 1);
    // Второй раз тот же апгрейд не выдаётся вовсе, а потолок стережёт выдачу.
    expect(grantUpgrade(s, 0, UpgradeId.ExtraHeart)).toBe(false);
    s.pHearts[0] = 5;
    s.pUpgrades.fill(0);
    grantUpgrade(s, 0, UpgradeId.ExtraHeart);
    expect(s.pHearts[0]).toBe(5);
  });
});

describe('эффекты в бою', () => {
  it('без покупок всё ровно такое, каким было', () => {
    const s = fresh();
    expect(damageOf(s, 0)).toBe(PISTOL.damage);
    expect(dashCooldownOf(s, 0)).toBe(PLAYER.dashCooldownTicks);
    expect(pickupRadiusOf(s, 0)).toBe(CHIP.pickupRadius);
    expect(moveSpeedOf(s, 0)).toBe(PLAYER.speed);
    expect(dropChancePctOf(s)).toBe(CHIP.dropChancePct);
  });

  /*
   * Урон меряется выстрелами, а не очками, и покупается именно выстрел.
   *
   * Проверка снятого за пулю необходима, но недостаточна: бой дискретен, и
   * апгрейд, снимающий на два очка больше, не даёт игроку ровно ничего, пока
   * число выстрелов на убийство то же самое. Ровно так и было — при HP 15 у
   * Фитиля два выстрела уходили и с апгрейдом, и без него, а платил игрок
   * шестьдесят фишек, самую дорогую цену каталога.
   *
   * Поэтому сторожится не арифметика, а покупка: на каком-то из врагов этажа
   * апгрейд обязан снимать выстрел. Иначе он работает только по боссу, о чём
   * витрина не сообщает.
   */
  it('«Урон +20%» снимает выстрел хотя бы с одного врага этажа', () => {
    const shots = (hp: number, dmg: number): number => Math.ceil(hp / dmg);
    const s = fresh();
    const upgraded = fresh();
    grantUpgrade(upgraded, 0, UpgradeId.DamageUp);

    const cheaper = ENEMIES.filter(
      (e) => shots(e.hp, damageOf(upgraded, 0)) < shots(e.hp, damageOf(s, 0)),
    );
    expect(cheaper.map((e) => e.type)).toContain(EnemyType.Fuse);
  });

  it('«Урон +20%» снимает с врага больше за ту же пулю', () => {
    const hit = (upgraded: boolean): number => {
      const s = fresh();
      s.pX[0] = fromInt(960);
      s.pY[0] = fromInt(540);
      s.pAimX[0] = fromInt(1);
      s.pAimY[0] = 0;
      if (upgraded) grantUpgrade(s, 0, UpgradeId.DamageUp);
      const e = spawnEnemy(s, EnemyType.Brick, fromInt(1100), fromInt(540));
      fire(s, 0);
      for (let t = 0; t < 20; t++) {
        stepBullets(s);
        s.tick++;
      }
      return s.eHP[e];
    };
    expect(hit(false)).toBe(30 - PISTOL.damage);
    expect(hit(true)).toBe(30 - 12);
  });

  it('«Кулдаун рывка −30%» возвращает рывок раньше', () => {
    const ready = (upgraded: boolean): number => {
      const s = fresh();
      if (upgraded) grantUpgrade(s, 0, UpgradeId.DashCooldown);
      const before = s.tick;
      step(s, [{ ...makeFrame(), moveX: fromInt(1), buttons: Btn.Dash }]);
      return s.pDashReady[0] - before;
    };
    expect(ready(false)).toBe(PLAYER.dashCooldownTicks);
    expect(ready(true)).toBe(Math.trunc((PLAYER.dashCooldownTicks * 70) / 100));
  });

  it('«Скорость +15%» уносит дальше за то же время', () => {
    const run = (upgraded: boolean): number => {
      const s = fresh();
      if (upgraded) grantUpgrade(s, 0, UpgradeId.SpeedUp);
      const from = toFloat(s.pX[0]);
      for (let t = 0; t < 120; t++) step(s, [{ ...makeFrame(), moveX: fromInt(1) }]);
      return toFloat(s.pX[0]) - from;
    };
    const plain = run(false);
    const fast = run(true);
    expect(fast).toBeGreaterThan(plain);
    // Пятнадцать процентов, а не «побольше»: ускорение сверх обещанного — это
    // тот же промах, что и его отсутствие.
    expect(fast / plain).toBeGreaterThan(1.1);
    expect(fast / plain).toBeLessThan(1.2);
  });

  it('«Магнит» тянет фишку с расстояния, на котором её не поднять', () => {
    const s = fresh();
    s.pX[0] = fromInt(960);
    s.pY[0] = fromInt(540);
    s.pChips[0] = 0;
    s.cX[0] = fromInt(1100);
    s.cY[0] = fromInt(540);
    s.cValue[0] = 1;
    s.cDeadline[0] = s.tick + 600;
    s.cActive[0] = 1;

    step(s, idle);
    expect(s.pChips[0]).toBe(0);

    grantUpgrade(s, 0, UpgradeId.Magnet);
    step(s, idle);
    expect(s.pChips[0]).toBe(1);
  });

  it('«Дроп +48%» поднимает шанс выпадения, не трогая размер броска', () => {
    const s = fresh();
    grantUpgrade(s, 0, UpgradeId.DropUp);
    // 25 × 148% = ровно 37: бросок идёт по сотне, дробить её нельзя, поэтому
    // целым подобран сам процент, а не округлён результат.
    expect(dropChancePctOf(s)).toBe(37);
  });
});

describe('лавка в забеге', () => {
  it('встаёт после боя за дверью «Лавка»', () => {
    const s = fresh();
    s.meta[Meta.RoomType] = DoorType.Shop;
    clearRoom(s, 2);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Reward);
    expect(s.shopItem[0]).toBeGreaterThan(0);
  });

  it('за обычной дверью не встаёт вовсе', () => {
    // Дара в списке нет намеренно: за ним встаёт тот же прилавок, только без
    // ценников, и проверяется он в `gift.test.ts`.
    for (const type of [DoorType.Fight, DoorType.Fat, DoorType.DebtPit]) {
      const s = fresh();
      s.meta[Meta.RoomType] = type;
      clearRoom(s, 2);
      expect(s.meta[Meta.Phase]).toBe(RunPhase.Door);
      expect(s.shopItem[0]).toBe(0);
    }
  });

  it('за дверью «Дар» встаёт прилавок без ценников, а не лавка', () => {
    const s = fresh(200);
    s.meta[Meta.RoomType] = DoorType.Gift;
    clearRoom(s, 2);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Reward);
    expect(s.shopItem[0]).toBeGreaterThan(0);
    expect(s.shopPrice[0]).toBe(0);
  });

  it('после ухода из лавки забег идёт дальше — к следующей двери', () => {
    const s = fresh(200);
    s.meta[Meta.RoomType] = DoorType.Shop;
    clearRoom(s, 2);
    buyFirst(s);
    expect(upgradeCount(s, 0)).toBe(1);

    step(s, press(Btn.Cancel));
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Door);
    // Фокус лавки погашен: иначе начало комнаты приняло бы его за выбор двери.
    expect(s.meta[Meta.DoorPick]).toBe(-1);
    expect(s.shopItem[0]).toBe(0);
  });

  it('лавка восьмой комнаты не отменяет босса и не открывается дважды', () => {
    const s = fresh(200);
    s.meta[Meta.RoomType] = DoorType.Shop;
    clearRoom(s, 8);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Reward);

    step(s, press(Btn.Cancel));
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Boss);
    // Комната осталась восьмой, а её тип переназначен началом боссовой: лавка
    // за ним второй раз не открывается.
    expect(s.meta[Meta.Room]).toBe(8);
    expect(s.meta[Meta.RoomType]).toBe(DoorType.Fight);
    expect(s.shopItem[0]).toBe(0);
  });

  it('мир на экране лавки стоит: волны не идут, тик идёт', () => {
    const s = fresh();
    s.meta[Meta.RoomType] = DoorType.Shop;
    clearRoom(s, 2);
    const at = s.tick;
    for (let t = 0; t < 300; t++) step(s, idle);
    expect(s.tick).toBe(at + 300);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Reward);
    expect(s.eActive.some((a) => a === 1)).toBe(false);
  });

  it('забег начинается заново без чужих апгрейдов и чужого прилавка', () => {
    const s = fresh(200);
    openShop(s);
    buyUpgrade(s, 0, 0);
    spawnPlayers(s);
    expect(upgradeCount(s, 0)).toBe(0);
    expect(s.shopItem[0]).toBe(0);
  });
});

describe('бот проходит лавку', () => {
  it('покупает по карману и уходит, а не зависает на экране', () => {
    const s = fresh(200);
    s.meta[Meta.RoomType] = DoorType.Shop;
    clearRoom(s, 2);

    const bot = makeBot('median:single', 7, 1);
    let guard = 0;
    while (s.meta[Meta.Phase] === RunPhase.Reward && guard++ < 200) step(s, bot.inputs(s));

    expect(s.meta[Meta.Phase]).not.toBe(RunPhase.Reward);
    // По двумстам фишкам на первом этаже хватает как минимум на один товар.
    expect(upgradeCount(s, 0)).toBeGreaterThan(0);
  });

  it('нищий бот уходит, ничего не купив', () => {
    const s = fresh(0);
    s.meta[Meta.RoomType] = DoorType.Shop;
    clearRoom(s, 2);

    let guard = 0;
    while (s.meta[Meta.Phase] === RunPhase.Reward && guard++ < 200) {
      step(s, passReward(s, idle));
    }
    expect(s.meta[Meta.Phase]).not.toBe(RunPhase.Reward);
    expect(upgradeCount(s, 0)).toBe(0);
  });
});

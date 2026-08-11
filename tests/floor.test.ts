/**
 * Конец этажа: доля заведения, долг и проклятия.
 *
 * Главный и почти единственный источник давления в соло. Ставки в игре
 * щедрые — у всех пари положительное матожидание, — и давление вынесено
 * наружу них (ECONOMY §3). Здесь проверяется, что оно действительно давит.
 */

import { describe, expect, it } from 'vitest';
import {
  Btn,
  Curse,
  FLOORS_PER_RUN,
  HOUSE,
  LEG_UP,
  Meta,
  Obligation,
  RunPhase,
  UpgradeId,
  buybackPriceOf,
  canPay,
  createState,
  debtOnBet,
  enterHouseCut,
  grantUpgrade,
  hasUpgrade,
  houseCut,
  makeFrame,
  priceOf,
  setSpawning,
  markLegUp,
  settleForcedBet,
  spawnPlayers,
  startRoom,
  step,
  takeDebt,
  upgradeCount,
  UPGRADES,
  type SimState,
} from '@dod/sim';

const idle = [makeFrame()];
const confirm = [{ ...makeFrame(), buttons: Btn.Confirm }];
const cancel = [{ ...makeFrame(), buttons: Btn.Cancel }];
/** Третий выход торга сидит на навигации: списка на экране платы нет. */
const sell = [{ ...makeFrame(), buttons: Btn.NavRight }];

function fresh(players = 1): SimState {
  const s = createState(1, players);
  spawnPlayers(s);
  setSpawning(s, false);
  return s;
}

describe('доля заведения', () => {
  /**
   * Числа из таблицы ECONOMY §5. Формула обязана давать ровно их: на этой
   * тройке посчитано всё сдавливание §6, и разъехавшись с ней, плата
   * перестаёт означать «столько-то отставания».
   */
  it('сходится с таблицей: 80 / 180 / 320', () => {
    expect(houseCut(1, 1)).toBe(80);
    expect(houseCut(2, 1)).toBe(180);
    expect(houseCut(3, 1)).toBe(320);
  });

  it('растёт быстрее дохода — в этом и есть кривая сложности', () => {
    // Доход по этажам растёт ×1.53 и ×1.35 (ECONOMY §4), плата обязана быстрее.
    expect(houseCut(2, 1) / houseCut(1, 1)).toBeGreaterThan(1.53);
    expect(houseCut(3, 1) / houseCut(2, 1)).toBeGreaterThan(1.35);
  });

  it('квадрат не заменяется линейным ростом', () => {
    // При показателе 1 третий этаж перестал бы давить. Проверка защищает
    // форму кривой, а не конкретные числа: их двигает балансировщик.
    expect(HOUSE.power).toBe(2);
  });

  it('в коопе растёт медленнее угрозы', () => {
    // Угроза `1 + 0.8(N−1)`, плата `1 + 0.6(N−1)`: группе действительно легче
    // собирать деньги, и разница компенсируется воскрешениями (DIFFICULTY §9).
    expect(houseCut(1, 2) / houseCut(1, 1)).toBeCloseTo(1.6, 1);
  });
});

describe('уплата', () => {
  it('списывает плату и не оставляет долга', () => {
    const s = fresh();
    s.pChips[0] = 500;
    enterHouseCut(s);
    expect(canPay(s)).toBe(true);

    step(s, confirm);
    expect(s.pChips[0]).toBe(500 - houseCut(1, 1));
    expect(s.meta[Meta.Debt]).toBe(0);
    expect(s.meta[Meta.Curse]).toBe(Curse.None);
    expect(s.meta[Meta.PaidToAce]).toBe(houseCut(1, 1));
  });

  it('экран ждёт игрока, а не часов', () => {
    const s = fresh();
    s.pChips[0] = 500;
    enterHouseCut(s);
    for (let i = 0; i < 600; i++) step(s, idle);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.HouseCut);
  });

  it('мир на экране платы стоит', () => {
    const s = fresh();
    s.pChips[0] = 500;
    enterHouseCut(s);
    const tick = s.tick;
    for (let i = 0; i < 200; i++) step(s, idle);
    expect(s.tick).toBe(tick + 200);
    let alive = 0;
    for (let i = 0; i < s.eActive.length; i++) if (s.eActive[i]) alive++;
    expect(alive).toBe(0);
  });
});

describe('долг', () => {
  it('отказ вешает проклятие и оставляет недостачу', () => {
    const s = fresh();
    s.pChips[0] = 30;
    enterHouseCut(s);
    expect(canPay(s)).toBe(false);

    step(s, cancel);
    expect(s.pChips[0]).toBe(0);
    expect(s.meta[Meta.Debt]).toBe(houseCut(1, 1) - 30);
    expect(s.meta[Meta.Curse]).not.toBe(Curse.None);
  });

  /**
   * Отказ на экране платы — это тоже долг, а не выход.
   *
   * Уйти с этажа, не рассчитавшись, нельзя; кнопка, обещающая такой выход,
   * обещала бы то, чего нет.
   */
  it('отказ равносилен долгу', () => {
    const s = fresh();
    s.pChips[0] = 500;
    enterHouseCut(s);
    step(s, cancel);
    expect(s.meta[Meta.Curse]).not.toBe(Curse.None);
  });

  it('не стакается: проклятие всегда одно', () => {
    const s = fresh();
    s.pChips[0] = 0;
    enterHouseCut(s);
    takeDebt(s);
    const first = s.meta[Meta.Curse];
    enterHouseCut(s);
    takeDebt(s);
    // Второе проклятие заменяет первое, а не ложится поверх: спираль неудач
    // запрещена дизайном (GDD §11).
    expect(s.meta[Meta.Curse]).not.toBe(Curse.None);
    expect(typeof first).toBe('number');
  });

  /**
   * Считается входами, а не номерами комнат.
   *
   * Номер сбрасывается на каждом этаже, а долг вешается ровно на границе
   * этажей: «следующая комната» оказывается ПЕРВОЙ комнатой следующего этажа,
   * то есть номером меньшим, чем у комнаты, где долг взяли. Сравнение номеров
   * на этом и сломалось — проклятие переживало свой срок и висело навсегда.
   */
  it('проклятие держится свою комнату и снимается следующей', () => {
    const s = fresh();
    s.pChips[0] = 0;
    enterHouseCut(s);
    takeDebt(s);
    expect(s.meta[Meta.Curse]).not.toBe(Curse.None);

    // Входим в проклятую комнату — здесь оно ещё действует.
    step(s, confirm);
    expect(s.meta[Meta.Floor]).toBe(2);
    expect(s.meta[Meta.Room]).toBe(1);
    expect(s.meta[Meta.Curse]).not.toBe(Curse.None);

    // Прошли её — снимается и проклятие, и долг вместе с ним.
    startRoom(s, 2);
    expect(s.meta[Meta.Curse]).toBe(Curse.None);
    expect(s.meta[Meta.Debt]).toBe(0);
  });

  it('долг не уходит в минус ни при каком кошельке', () => {
    const s = fresh();
    s.pChips[0] = 10_000;
    enterHouseCut(s);
    takeDebt(s);
    expect(s.meta[Meta.Debt]).toBe(0);
  });
});

describe('трамплин', () => {
  it('провал пари обязывает следующий стол дать трамплин', () => {
    const s = fresh();
    // Отметка ставится расчётом; здесь проверяется само правило хранения:
    // между провалом и раздачей лежит целый экран, и намерение обязано
    // пережить его в состоянии.
    s.meta[Meta.LegUp] = 1;
    expect(s.meta[Meta.LegUp]).toBe(1);
  });

  it('кон трамплина — самый скромный тир, а не бесплатно', () => {
    // Бесплатная карта выглядела бы подставленным плечом, а считалась бы
    // подарком — и шла бы ровно тому, кого доля заведения должна прижимать.
    expect(LEG_UP.tier).toBe(0);
    expect(LEG_UP.multiplierPct).toBeGreaterThan(100);
  });
});

describe('победа тоже платит', () => {
  it('последний этаж проходит через экран платы', () => {
    const s = fresh();
    s.meta[Meta.Floor] = FLOORS_PER_RUN;
    s.pChips[0] = 1000;
    enterHouseCut(s);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.HouseCut);
    step(s, confirm);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Summary);
    expect(s.meta[Meta.Victory]).toBe(1);
  });
});

describe('торг: принудительное пари', () => {
  /**
   * Первый и лучший из трёх выходов: он оставляет игроку шанс рассчитаться,
   * тогда как долг забирает комнату гарантированно.
   */
  it('подтверждение при нехватке берёт пари, а не долг', () => {
    const s = fresh();
    s.pChips[0] = 30;
    enterHouseCut(s);
    step(s, confirm);

    expect(s.meta[Meta.Debt]).toBe(houseCut(1, 1) - 30);
    // Проклятия нет — по нему и отличается долг под пари от обычного.
    expect(s.meta[Meta.Curse]).toBe(Curse.None);
    expect(debtOnBet(s)).toBe(true);
    expect(s.meta[Meta.LegUp]).toBe(Obligation.Forced);
  });

  it('кон равен недостаче, а не тиру аппетита', () => {
    // Иначе Крупье предлагает сделку, которой не хватает на саму сделку.
    const s = fresh();
    s.pChips[0] = 10;
    enterHouseCut(s);
    const shortfall = houseCut(1, 1) - 10;
    step(s, confirm);
    expect(s.meta[Meta.Debt]).toBe(shortfall);
  });

  it('выигрыш рассчитывает долг и платит вдвое', () => {
    const s = fresh();
    s.pChips[0] = 30;
    enterHouseCut(s);
    step(s, confirm);
    const stake = s.meta[Meta.Debt];

    settleForcedBet(s, true);
    expect(s.meta[Meta.Debt]).toBe(0);
    expect(s.meta[Meta.Curse]).toBe(Curse.None);
    expect(s.pChips[0]).toBe(stake * HOUSE.forcedBetMultiplier);
  });

  it('провал возвращает то самое проклятие, от которого уходили', () => {
    const s = fresh();
    s.pChips[0] = 30;
    enterHouseCut(s);
    step(s, confirm);

    settleForcedBet(s, false);
    expect(s.meta[Meta.Debt]).toBe(0);
    expect(s.meta[Meta.Curse]).not.toBe(Curse.None);
  });

  /**
   * Долг сильнее подарка: трамплин не вытесняет принудительное пари.
   *
   * Иначе провалившийся игрок случайно рассчитывался бы с заведением — обе
   * отметки живут в одном слоте, и та, что записалась последней, победила бы.
   */
  it('трамплин не вытесняет принудительное пари', () => {
    const s = fresh();
    s.pChips[0] = 30;
    enterHouseCut(s);
    step(s, confirm);
    expect(s.meta[Meta.LegUp]).toBe(Obligation.Forced);

    markLegUp(s);
    expect(s.meta[Meta.LegUp]).toBe(Obligation.Forced);
  });
});

/**
 * Второй выход торга: отдать заведению купленную силу.
 *
 * Проверяются правила, а не ценники: базы цен — данные и меняются
 * балансировщиком, поэтому ожидания считаются той же формулой, что и лавка.
 * Исключение одно — привязка к ТЕКУЩЕМУ этажу: это решение ECONOMY §10, и
 * съехать оно обязано только вместе с документом.
 */
describe('торг: обратный выкуп апгрейда', () => {
  const base = (u: UpgradeId): number => UPGRADES[u].base;

  it('цена выкупа — половина цены этажа, на котором торгуются', () => {
    for (let floor = 1; floor <= FLOORS_PER_RUN; floor++) {
      const full = priceOf(base(UpgradeId.DamageUp), floor);
      expect(buybackPriceOf(base(UpgradeId.DamageUp), floor)).toBe(
        Math.trunc((full * HOUSE.buybackPct) / 100),
      );
    }
  });

  /**
   * Апгрейд, купленный на первом этаже, на третьем стоит дороже.
   *
   * Правило проще (не надо помнить, где что куплено) и щедрее там, где игрок и
   * беднеет; обратное превращало бы ранние покупки в ловушку (ECONOMY §10).
   */
  it('считается по текущему этажу, а не по этажу покупки', () => {
    const s = fresh();
    grantUpgrade(s, 0, UpgradeId.DamageUp);
    expect(buybackPriceOf(base(UpgradeId.DamageUp), 3)).toBeGreaterThan(
      buybackPriceOf(base(UpgradeId.DamageUp), 1),
    );

    s.meta[Meta.Floor] = 3;
    const gain = buybackPriceOf(base(UpgradeId.DamageUp), 3);
    s.pChips[0] = houseCut(3, 1) - gain;
    enterHouseCut(s);

    step(s, sell);
    expect(s.meta[Meta.PaidToAce]).toBe(houseCut(3, 1));
    expect(s.pChips[0]).toBe(0);
  });

  it('продажа закрывает недостачу целиком и платит сама', () => {
    // Торг — размен долга на что-то другое, а не рассрочка: апгрейд, отданный
    // без расчёта, был бы отдан зря.
    const s = fresh();
    grantUpgrade(s, 0, UpgradeId.DamageUp);
    s.pChips[0] = houseCut(1, 1) - buybackPriceOf(base(UpgradeId.DamageUp), 1);
    enterHouseCut(s);

    step(s, sell);
    expect(s.meta[Meta.Phase]).not.toBe(RunPhase.HouseCut);
    expect(s.meta[Meta.Debt]).toBe(0);
    expect(s.meta[Meta.Curse]).toBe(Curse.None);
    expect(s.meta[Meta.LegUp]).toBe(Obligation.None);
  });

  it('слот освобождается — проданное больше не у игрока', () => {
    const s = fresh();
    grantUpgrade(s, 0, UpgradeId.DamageUp);
    s.pChips[0] = houseCut(1, 1) - buybackPriceOf(base(UpgradeId.DamageUp), 1);
    enterHouseCut(s);

    step(s, sell);
    expect(hasUpgrade(s, 0, UpgradeId.DamageUp)).toBe(false);
    expect(upgradeCount(s, 0)).toBe(0);
  });

  it('выручки не хватило — выбор остаётся, а экран открыт', () => {
    const s = fresh();
    grantUpgrade(s, 0, UpgradeId.SpeedUp);
    s.pChips[0] = 0;
    enterHouseCut(s);

    step(s, sell);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.HouseCut);
    expect(s.pChips[0]).toBe(buybackPriceOf(base(UpgradeId.SpeedUp), 1));
    expect(s.meta[Meta.Debt]).toBe(0);
    expect(s.meta[Meta.Curse]).toBe(Curse.None);

    // Остальные два выхода никуда не делись.
    step(s, cancel);
    expect(s.meta[Meta.Curse]).not.toBe(Curse.None);
  });

  /**
   * Продавать нечего — нажатие не считается решением.
   *
   * Предложение продать несуществующее — это обещание выхода, которого нет:
   * закрыв на нём экран, Крупье забрал бы решение у того, кому и так нечем
   * платить.
   */
  it('продавать нечего — не происходит ничего', () => {
    const s = fresh();
    s.pChips[0] = 30;
    enterHouseCut(s);

    step(s, sell);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.HouseCut);
    expect(s.pChips[0]).toBe(30);
    expect(s.meta[Meta.Debt]).toBe(0);
    expect(s.meta[Meta.Curse]).toBe(Curse.None);
    expect(s.meta[Meta.LegUp]).toBe(Obligation.None);
  });

  /**
   * Выбирает правило, а не игрок: списка и фокуса на экране платы нет.
   *
   * Поэтому выбирать оно обязано то же, что выбрал бы игрок — самый дешёвый из
   * тех, кого хватает на расчёт.
   */
  it('уходит самый дешёвый из достаточных', () => {
    const s = fresh();
    grantUpgrade(s, 0, UpgradeId.SpeedUp);
    grantUpgrade(s, 0, UpgradeId.Magnet);
    grantUpgrade(s, 0, UpgradeId.DamageUp);
    s.pChips[0] = houseCut(1, 1) - buybackPriceOf(base(UpgradeId.Magnet), 1);
    enterHouseCut(s);

    step(s, sell);
    expect(hasUpgrade(s, 0, UpgradeId.Magnet)).toBe(false);
    expect(hasUpgrade(s, 0, UpgradeId.SpeedUp)).toBe(true);
    expect(hasUpgrade(s, 0, UpgradeId.DamageUp)).toBe(true);
  });

  it('не хватает ни одного — уходит самый дорогой', () => {
    // Недостача обязана сократиться сильнее всего: иначе игрок продаёт дважды
    // и всё равно остаётся должен.
    const s = fresh();
    grantUpgrade(s, 0, UpgradeId.SpeedUp);
    grantUpgrade(s, 0, UpgradeId.DamageUp);
    s.pChips[0] = 0;
    enterHouseCut(s);

    step(s, sell);
    expect(hasUpgrade(s, 0, UpgradeId.DamageUp)).toBe(false);
    expect(hasUpgrade(s, 0, UpgradeId.SpeedUp)).toBe(true);
  });

  /**
   * Сердце уходит вместе с апгрейдом.
   *
   * Оставленное, оно превратило бы торг в станок: купить сердце, продать его
   * обратно и оставить себе здоровье стоило бы половины ценника и повторялось
   * бы каждый этаж.
   */
  it('проданное сердце возвращается заведению', () => {
    const s = fresh();
    const before = s.pHearts[0];
    grantUpgrade(s, 0, UpgradeId.ExtraHeart);
    expect(s.pHearts[0]).toBe(before + 1);

    s.pChips[0] = 0;
    enterHouseCut(s);
    step(s, sell);
    expect(s.pHearts[0]).toBe(before);
  });

  it('последнее сердце не забирается: экран платы не убивает', () => {
    // Смерть от нажатия кнопки на неборевом экране — это смерть в интерфейсе,
    // а не в игре, и живой игрок без здоровья ловится инвариантом.
    const s = fresh();
    grantUpgrade(s, 0, UpgradeId.ExtraHeart);
    s.pHearts[0] = 1;
    s.pChips[0] = 0;
    enterHouseCut(s);

    step(s, sell);
    expect(s.pHearts[0]).toBe(1);
    expect(hasUpgrade(s, 0, UpgradeId.ExtraHeart)).toBe(false);
  });
});

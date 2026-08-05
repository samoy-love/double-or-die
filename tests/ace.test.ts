/**
 * Ставка Туза: он ставит против игрока из своего кармана (GDD §12А.1).
 *
 * Проверяется здесь ровно то, что нельзя проверить сценарием: расписание
 * выходов на весь забег (двадцать четыре боя одним прогоном) и денежная
 * симметрия, у которой обе половины обязаны сойтись до фишки. Что игра делает
 * в комнате — принимает, отказывается, платит и не уходит в минус — записано
 * сценариями в `tests/scenarios/ace`.
 *
 * Деньги здесь считаются целыми числами и до фишки: ошибка в направлении
 * выплаты не видна ни в бою, ни в логе, а ограничитель G12 стоит на разнице
 * между «плюс процент» и «плюс десять».
 */

import { describe, expect, it } from 'vitest';
import {
  ACE_BET,
  BetState,
  Btn,
  CARD,
  FLOORS_PER_RUN,
  MAX_ACTIVE_BETS,
  Meta,
  ROOMS_PER_FLOOR,
  RunPhase,
  aceBetDue,
  aceCardAt,
  aceStakeFor,
  acceptAceBet,
  betIdOf,
  cashOutBest,
  cashOutValue,
  checkInvariants,
  createState,
  declineAceBet,
  endRun,
  layAceCard,
  failBet,
  makeFrame,
  setSpawning,
  settleBets,
  spawnPlayers,
  startRoom,
  step,
  type SimState,
} from '@dod/sim';

/** Забег без волн: предмет проверки — деньги, а не то, кто на кого набежал. */
function fresh(chips = 200): SimState {
  const s = createState(1, 1);
  spawnPlayers(s);
  setSpawning(s, false);
  s.pChips[0] = chips;
  return s;
}

/** Положить его карту и принять её. Возвращает кон, о котором договорились. */
function shake(s: SimState, id = 'no_dash'): number {
  layAceCard(s, betIdOf(id), s.tick + CARD.lifeTicks);
  const stake = aceStakeFor(s, 0);
  expect(acceptAceBet(s, 0)).toBe(true);
  return stake;
}

describe('Ставка Туза: кон', () => {
  it('считается по формуле min(40 × этаж, 25% кошелька)', () => {
    const s = fresh();

    // Богатый: упирается в этажный потолок, а не в кошелёк.
    s.pChips[0] = 1000;
    for (let floor = 1; floor <= FLOORS_PER_RUN; floor++) {
      s.meta[Meta.Floor] = floor;
      expect(aceStakeFor(s, 0)).toBe(ACE_BET.stakePerFloor * floor);
    }

    // Бедный: упирается в четверть кошелька.
    s.meta[Meta.Floor] = 1;
    s.pChips[0] = 30;
    expect(aceStakeFor(s, 0)).toBe(7);
  });

  it('никогда не превышает четверти кошелька', () => {
    const s = fresh();
    for (let floor = 1; floor <= FLOORS_PER_RUN; floor++) {
      s.meta[Meta.Floor] = floor;
      for (let chips = 0; chips <= 600; chips++) {
        s.pChips[0] = chips;
        expect(aceStakeFor(s, 0) * 4).toBeLessThanOrEqual(chips);
      }
    }
  });

  it('фиксируется при рукопожатии, а не пересчитывается по ходу боя', () => {
    const s = fresh(400);
    const stake = shake(s);
    expect(stake).toBe(ACE_BET.stakePerFloor);

    // Кошелёк вырос вчетверо — договорённость от этого не меняется.
    s.pChips[0] = 1600;
    settleBets(s);
    expect(s.pChips[0]).toBe(1600 + stake);
  });
});

describe('Ставка Туза: выплата', () => {
  it('симметрична: выигрыш и проигрыш стоят одного и того же', () => {
    const won = fresh(400);
    const start = won.pChips[0];
    const stake = shake(won);
    settleBets(won);
    const gain = won.pChips[0] - start;

    const lost = fresh(400);
    shake(lost);
    failBet(lost, 0, 'no_dash');
    const loss = start - lost.pChips[0];

    expect(gain).toBe(stake);
    expect(loss).toBe(stake);
    expect(gain).toBe(loss);
  });

  it('кон не списывается при принятии: ставит он, а не игрок', () => {
    const s = fresh(400);
    const before = s.pChips[0];
    shake(s);
    expect(s.pChips[0]).toBe(before);
  });

  it('платит один к одному, а не по множителю каталога', () => {
    const s = fresh(400);
    const start = s.pChips[0];
    // «Без урона» идёт ×3: по множителю выплата была бы втрое больше.
    const stake = shake(s, 'no_damage');
    settleBets(s);
    expect(s.pChips[0]).toBe(start + stake);
  });

  it('проигранная уходит в «отдано Тузу»', () => {
    const s = fresh(400);
    const stake = shake(s);
    failBet(s, 0, 'no_dash');
    expect(s.meta[Meta.PaidToAce]).toBe(stake);
  });

  it('обналичиванию не подлежит: кон не твой', () => {
    const s = fresh(400);
    const stake = shake(s);
    expect(cashOutValue(s, 0, 0)).toBe(0);
    expect(cashOutBest(s, 0)).toBe(0);
    expect(s.aState[0]).toBe(BetState.Active);
    expect(s.pChips[0]).toBe(400);

    // И по-прежнему платит своё, когда доигрывается честно.
    settleBets(s);
    expect(s.pChips[0]).toBe(400 + stake);
  });
});

describe('Ставка Туза: кошелёк не уходит в минус', () => {
  it('проигрыш забирает только то, что есть', () => {
    const s = fresh(400);
    const stake = shake(s);
    expect(stake).toBeGreaterThan(0);

    // Между рукопожатием и провалом игрок разорился — Туз в кредит не
    // принимает, и взять с него больше нечего.
    s.pChips[0] = 3;
    failBet(s, 0, 'no_dash');
    expect(s.pChips[0]).toBe(0);
    expect(s.meta[Meta.PaidToAce]).toBe(3);
    checkInvariants(s);
  });

  it('конец забега со ставкой на руках тоже не пробивает ноль', () => {
    const s = fresh(400);
    shake(s);
    s.pChips[0] = 5;
    endRun(s, false);
    expect(s.pChips[0]).toBe(0);
    checkInvariants(s);
  });

  it('нищему он не предлагает вовсе', () => {
    const s = fresh(3);
    s.meta[Meta.Floor] = 1;
    expect(aceBetDue(ACE_BET.firstFight)).toBe(true);
    startRoom(s, ACE_BET.firstFight);
    expect(aceCardAt(s)).toBe(-1);
  });
});

describe('Ставка Туза: отказ', () => {
  it('не штрафует ничем', () => {
    const s = fresh(400);
    layAceCard(s, betIdOf('no_dash'), s.tick + CARD.lifeTicks);
    expect(declineAceBet(s)).toBe(true);

    expect(aceCardAt(s)).toBe(-1);
    expect(s.pChips[0]).toBe(400);
    expect(s.meta[Meta.PaidToAce]).toBe(0);
    expect(s.meta[Meta.BetsTaken]).toBe(0);
    expect(s.meta[Meta.BetsLost]).toBe(0);
  });

  it('молчание до конца срока — тот же отказ и та же цена', () => {
    const s = fresh(400);
    layAceCard(s, betIdOf('no_dash'), s.tick + 30);
    const frames = [makeFrame()];
    for (let t = 0; t < 40; t++) step(s, frames);

    expect(aceCardAt(s)).toBe(-1);
    expect(s.pChips[0]).toBe(400);
    expect(s.meta[Meta.PaidToAce]).toBe(0);
  });

  it('принимается и отклоняется по ФРОНТУ нажатия', () => {
    const s = fresh(400);
    layAceCard(s, betIdOf('no_dash'), s.tick + CARD.lifeTicks);

    const frames = [makeFrame()];
    frames[0].buttons = Btn.Confirm;
    step(s, frames);
    expect(s.aState[0]).toBe(BetState.Active);
    expect(aceCardAt(s)).toBe(-1);

    // Кнопка осталась зажатой — второй ставки от этого не появляется.
    layAceCard(s, betIdOf('under_45s'), s.tick + CARD.lifeTicks);
    step(s, frames);
    expect(aceCardAt(s)).toBeGreaterThanOrEqual(0);

    frames[0].buttons = 0;
    step(s, frames);
    frames[0].buttons = Btn.Cancel;
    step(s, frames);
    expect(aceCardAt(s)).toBe(-1);
    expect(s.aState[1]).toBe(BetState.None);
  });
});

describe('Ставка Туза: частота', () => {
  it('держится в коридоре 2–3 боя весь забег', () => {
    const fights: number[] = [];
    for (let f = 1; f <= FLOORS_PER_RUN * ROOMS_PER_FLOOR; f++) {
      if (aceBetDue(f)) fights.push(f);
    }
    expect(fights.length).toBeGreaterThan(0);

    for (let i = 1; i < fights.length; i++) {
      const gap = fights[i] - fights[i - 1];
      expect(gap).toBeGreaterThanOrEqual(2);
      expect(gap).toBeLessThanOrEqual(3);
    }
    // Две карты на каждые пять боёв — то есть в среднем одна на две с
    // половиной, ровно как обещает ECONOMY §10А. Проверяется плотностью, а не
    // равенством: забег в двадцать четыре боя не делится на период нацело, и
    // последний неполный период законно недобирает карту.
    const total = FLOORS_PER_RUN * ROOMS_PER_FLOOR;
    const want = Math.floor(
      ((total - ACE_BET.firstFight + 1) * ACE_BET.offersPerPeriod) / ACE_BET.offerPeriod,
    );
    expect(fights.length).toBeGreaterThanOrEqual(want);
    expect(fights.length).toBeLessThanOrEqual(want + 1);
    // Первая карта — там, где обещано, и ни боем раньше: экран не имеет права
    // прийтись на первые секунды забега.
    expect(fights[0]).toBe(ACE_BET.firstFight);
  });

  it('карта действительно ложится в те комнаты, что назвало расписание', () => {
    const s = fresh(400);
    const seen: number[] = [];
    for (let floor = 1; floor <= FLOORS_PER_RUN; floor++) {
      s.meta[Meta.Floor] = floor;
      for (let room = 1; room <= ROOMS_PER_FLOOR; room++) {
        s.pChips[0] = 400;
        startRoom(s, room);
        if (aceCardAt(s) >= 0) seen.push((floor - 1) * ROOMS_PER_FLOOR + room);
      }
    }
    expect(seen).toEqual(
      Array.from({ length: FLOORS_PER_RUN * ROOMS_PER_FLOOR }, (_, i) => i + 1).filter(aceBetDue),
    );
  });

  it('у босса своей карты он не кладёт: там уже идёт встречная ставка', () => {
    const s = fresh(400);
    s.meta[Meta.Phase] = RunPhase.Boss;
    startRoom(s, ROOMS_PER_FLOOR);
    expect(aceCardAt(s)).toBe(-1);
  });

  it('больше одной ставки на игроке сразу не висит', () => {
    const s = fresh(400);
    shake(s);
    layAceCard(s, betIdOf('under_45s'), s.tick + CARD.lifeTicks);
    expect(acceptAceBet(s, 0)).toBe(true);
    // Обе не могут быть от него: расписание разносит их на два боя, а
    // инвариант ловит любую попытку свести их в одну комнату.
    let aces = 0;
    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      if (s.aState[i] === BetState.Active && s.aStake[i] < 0) aces++;
    }
    expect(aces).toBe(2);
    expect(() => checkInvariants(s)).toThrow(/Ставки Туза сразу/);
  });
});

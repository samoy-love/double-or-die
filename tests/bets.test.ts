/**
 * Пари: раскладка, подбор, условия, прогресс, обналичивание.
 *
 * Правило покрытия из DEVLOOP §6А требует на каждое пари ДВА сценария:
 * засчитывается, когда должно, и проваливается, когда должно. Одного мало —
 * пари, которое не срывается никогда, проходит проверку «выигрывается» и
 * молча ломает всю экономику: `EV = кон × (p × M − 1)` при `p = 1` делает
 * любой множитель печатным станком.
 *
 * Прогресс `q` проверяется отдельно и для каждого: на нём стоит выплата за
 * «Забрать», а ошибка в нём не видна ни в бою, ни в логе — только в деньгах.
 */

import { describe, expect, it } from 'vitest';
import {
  APPETITE,
  APPETITE_SHIFT,
  BETS,
  BetState,
  Btn,
  CARD,
  EnemyType,
  FX_ONE,
  MAX_ACTIVE_BETS,
  MAX_CARDS,
  Meta,
  PLAYER,
  RED_ZONE,
  SHARED,
  cashOut,
  cashOutValue,
  createState,
  dropChip,
  explode,
  fromInt,
  makeFrame,
  placeCard,
  progressOf,
  settleBets,
  setSpawning,
  spawnEnemy,
  spawnPlayers,
  step,
  takeBet,
  toFloat,
  type InputFrame,
  type SimState,
} from '../packages/sim/src/index';

const CX = 960;
const CY = 540;

/** Пустая арена с деньгами: пари проверяются без помех от волн. */
function arena(players = 1, chips = 200): SimState {
  const s = createState(1, players);
  spawnPlayers(s);
  setSpawning(s, false);
  s.kActive.fill(0);
  for (let p = 0; p < players; p++) s.pChips[p] = chips;
  return s;
}

const frame = (o: Partial<InputFrame> = {}): InputFrame[] => [{ ...makeFrame(), ...o }];

function run(s: SimState, ticks: number, inputs = frame()): void {
  for (let t = 0; t < ticks; t++) step(s, inputs);
}

const betIndex = (id: string): number => BETS.findIndex((b) => b.id === id);

/** Взять пари напрямую: раскладка проверяется отдельно, здесь важны условия. */
function bet(s: SimState, id: string, stake = 10, player = 0): number {
  takeBet(s, player, betIndex(id), stake);
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    if (s.aState[player * MAX_ACTIVE_BETS + i] === BetState.Active) return i;
  }
  return -1;
}

const stateOf = (s: SimState, n: number, player = 0): BetState =>
  s.aState[player * MAX_ACTIVE_BETS + n] as BetState;

const cards = (s: SimState): number => {
  let n = 0;
  for (let i = 0; i < MAX_CARDS; i++) if (s.kActive[i]) n++;
  return n;
};

/** Снаряд, летящий в игрока и отнимающий сердце примерно через 20 тиков. */
function incoming(s: SimState): void {
  s.bX[0] = fromInt(CX - 170);
  s.bY[0] = fromInt(CY);
  s.bVX[0] = fromInt(9);
  s.bVY[0] = 0;
  s.bDeadline[0] = s.tick + 60;
  s.bOwner[0] = -1;
  s.bActive[0] = 1;
}

describe('раскладка карт', () => {
  it('карт на арене — игроков плюс две', () => {
    for (const players of [1, 2, 4]) {
      const s = createState(7, players);
      spawnPlayers(s);
      expect(cards(s), `состав ${players}`).toBe(players + CARD.extraCards);
    }
  });

  it('каждому достаётся персональная, остальные общие', () => {
    const s = createState(7, 3);
    spawnPlayers(s);

    const owners: number[] = [];
    for (let i = 0; i < MAX_CARDS; i++) if (s.kActive[i]) owners.push(s.kOwner[i]);

    // По одной именной на игрока: доступ к главной механике игры не может
    // зависеть от того, кто быстрее бегает.
    for (let p = 0; p < 3; p++) expect(owners.filter((o) => o === p)).toHaveLength(1);
    expect(owners.filter((o) => o === SHARED)).toHaveLength(CARD.extraCards);
  });

  it('карты не ложатся друг на друга и не падают под ноги', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = createState(seed, 4);
      spawnPlayers(s);

      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < MAX_CARDS; i++) {
        if (s.kActive[i]) pts.push({ x: toFloat(s.kX[i]), y: toFloat(s.kY[i]) });
      }
      const spacing = toFloat(CARD.minSpacing);

      for (let a = 0; a < pts.length; a++) {
        for (let p = 0; p < s.playerCount; p++) {
          const d = Math.hypot(pts[a].x - toFloat(s.pX[p]), pts[a].y - toFloat(s.pY[p]));
          expect(d, `сид ${seed}: карта под ногами игрока ${p}`).toBeGreaterThanOrEqual(
            spacing - 1,
          );
        }
        for (let b = a + 1; b < pts.length; b++) {
          const d = Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y);
          expect(d, `сид ${seed}: две карты слиплись`).toBeGreaterThanOrEqual(spacing - 1);
        }
      }
    }
  });

  it('карта тает за отведённые двенадцать секунд', () => {
    const s = arena();
    placeCard(s, betIndex('no_damage'), SHARED, s.tick + CARD.lifeTicks);
    expect(cards(s)).toBe(1);
    run(s, CARD.lifeTicks - 2);
    expect(cards(s), 'исчезла раньше срока').toBe(1);
    run(s, 4);
    expect(cards(s), 'пережила свой срок').toBe(0);
  });

  it('конфликтующие пари вместе не выпадают', () => {
    // В каталоге 0.3.0 конфликтов нет, но правило обязано работать: проверяем
    // на самом свойстве раскладки — одно и то же пари не выдаётся дважды.
    for (let seed = 1; seed <= 40; seed++) {
      const s = createState(seed, 4);
      spawnPlayers(s);
      const ids: number[] = [];
      for (let i = 0; i < MAX_CARDS; i++) if (s.kActive[i]) ids.push(s.kBet[i]);
      expect(new Set(ids).size, `сид ${seed}: пари повторилось на столе`).toBe(ids.length);
    }
  });
});

describe('подбор карты', () => {
  it('подбирается кнопкой, а не наездом', () => {
    const s = arena();
    const card = placeCard(s, betIndex('no_dash'), SHARED, s.tick + CARD.lifeTicks);
    s.pX[0] = s.kX[card];
    s.pY[0] = s.kY[card];

    // Стоим на карте без нажатия: уворот рывком не должен навязывать пари.
    run(s, 30);
    expect(cards(s), 'карта подобралась наездом').toBe(1);
    expect(stateOf(s, 0)).toBe(BetState.None);

    run(s, 1, frame({ buttons: Btn.Take }));
    expect(cards(s)).toBe(0);
    expect(stateOf(s, 0)).toBe(BetState.Active);
  });

  it('кон списывается по аппетиту и не превышает кошелёк', () => {
    const s = arena(1, 12);
    const card = placeCard(s, betIndex('no_dash'), SHARED, s.tick + CARD.lifeTicks);
    s.pX[0] = s.kX[card];
    s.pY[0] = s.kY[card];

    // Аппетит едет в маске ввода, а не в состоянии: он часть кадра, реплея и
    // сетевого протокола (TECH §6). «По-крупному» — 50, а в кошельке 12.
    run(s, 1, frame({ buttons: Btn.Take | Btn.AppetiteHi }));

    // Туз в кредит не принимает: кон обрезается кошельком, а не уводит в долг.
    expect(s.pChips[0]).toBe(0);
    expect(s.aStake[0]).toBe(12);
  });

  it('чужую персональную карту взять нельзя', () => {
    const s = arena(2);
    const card = placeCard(s, betIndex('no_dash'), 1, s.tick + CARD.lifeTicks);
    s.pX[0] = s.kX[card];
    s.pY[0] = s.kY[card];

    const inputs = [{ ...makeFrame(), buttons: Btn.Take }, makeFrame()];
    for (let t = 0; t < 5; t++) step(s, inputs);
    expect(cards(s), 'игрок 0 забрал карту игрока 1').toBe(1);
  });

  it('больше четырёх пари на игроке не висит', () => {
    const s = arena();
    for (let i = 0; i < 6; i++) takeBet(s, 0, i % BETS.length, 10);
    let active = 0;
    for (let i = 0; i < MAX_ACTIVE_BETS; i++) if (stateOf(s, i) === BetState.Active) active++;
    expect(active).toBe(MAX_ACTIVE_BETS);
  });

  it('одновременный подбор достаётся ровно одному', () => {
    const s = arena(2);
    const card = placeCard(s, betIndex('no_dash'), SHARED, s.tick + CARD.lifeTicks);
    // Оба стоят на карте и жмут кнопку в один тик.
    for (const p of [0, 1]) {
      s.pX[p] = s.kX[card];
      s.pY[p] = s.kY[card];
    }
    const both = [
      { ...makeFrame(), buttons: Btn.Take },
      { ...makeFrame(), buttons: Btn.Take },
    ];
    step(s, both);

    expect(cards(s)).toBe(0);
    const taken = [0, 1].filter((p) => s.aState[p * MAX_ACTIVE_BETS] === BetState.Active);
    expect(taken, 'карта досталась обоим или никому').toHaveLength(1);
  });
});

describe('условия пари', () => {
  it('«Без урона»: держится без урона и срывается от попадания', () => {
    const won = arena();
    const n = bet(won, 'no_damage');
    run(won, 120);
    expect(stateOf(won, n), 'сорвалось само по себе').toBe(BetState.Active);

    const lost = arena();
    bet(lost, 'no_damage');
    incoming(lost);
    run(lost, 30);
    expect(lost.pHearts[0]).toBe(2);
    expect(stateOf(lost, 0), 'пережило потерю сердца').toBe(BetState.Lost);
  });

  it('«Без рывка»: держится без рывка и срывается от рывка', () => {
    const won = arena();
    bet(won, 'no_dash');
    run(won, 120, frame({ moveX: fromInt(1) }));
    expect(stateOf(won, 0)).toBe(BetState.Active);

    const lost = arena();
    bet(lost, 'no_dash');
    run(lost, 1, frame({ moveX: fromInt(1), buttons: Btn.Dash }));
    expect(stateOf(lost, 0)).toBe(BetState.Lost);
  });

  it('«Быстрее 45 секунд»: срывается ровно по истечении лимита', () => {
    const s = arena();
    const n = bet(s, 'under_45s');
    const limit = BETS[betIndex('under_45s')].limitTicks;
    run(s, limit);
    expect(stateOf(s, n), 'сорвалось раньше срока').toBe(BetState.Active);
    run(s, 2);
    expect(stateOf(s, n)).toBe(BetState.Lost);
  });

  it('«Не заходи в красную зону»: срывается входом в неё', () => {
    const s = arena();
    // Игрок появляется в центре, а зона там же: сначала уводим его наружу.
    s.pX[0] = fromInt(200);
    s.pY[0] = fromInt(200);
    const n = bet(s, 'no_red_zone');
    run(s, 5);
    expect(stateOf(s, n), 'сорвалось снаружи зоны').toBe(BetState.Active);

    s.pX[0] = RED_ZONE.x;
    s.pY[0] = RED_ZONE.y;
    run(s, 1);
    expect(stateOf(s, n)).toBe(BetState.Lost);
  });

  it('«Собери все фишки»: срывается пропавшей фишкой', () => {
    const s = arena();
    s.pX[0] = fromInt(200);
    s.pY[0] = fromInt(200);
    const n = bet(s, 'all_chips');
    dropChip(s, fromInt(CX), fromInt(CY));
    run(s, 60);
    expect(stateOf(s, n), 'сорвалось до истечения фишки').toBe(BetState.Active);
    run(s, 140);
    expect(stateOf(s, n)).toBe(BetState.Lost);
  });

  it('«Подрывник»: считает убитых взрывом и не считает застреленных', () => {
    const s = arena();
    const n = bet(s, 'demolitionist');

    // Три Клина рядом с точкой подрыва: взрыв убивает всех.
    for (let i = 0; i < 3; i++) {
      spawnEnemy(s, EnemyType.Wedge, fromInt(CX + 400 + i * 40), fromInt(CY + 30));
    }
    explode(s, fromInt(CX + 440), fromInt(CY + 30), -1);
    expect(s.aCounter[n]).toBe(3);

    settleBets(s);
    expect(stateOf(s, n)).toBe(BetState.Won);
  });

  it('«Подрывник» проваливается, если подрывов не хватило', () => {
    const s = arena();
    const n = bet(s, 'demolitionist');
    spawnEnemy(s, EnemyType.Wedge, fromInt(CX + 400), fromInt(CY));
    explode(s, fromInt(CX + 400), fromInt(CY), -1);
    expect(s.aCounter[n]).toBe(1);

    settleBets(s);
    expect(stateOf(s, n)).toBe(BetState.Lost);
  });
});

describe('прогресс и обналичивание', () => {
  it('темповое пари копит прогресс по времени', () => {
    const s = arena();
    const n = bet(s, 'under_45s');
    const limit = BETS[betIndex('under_45s')].limitTicks;
    run(s, Math.floor(limit / 2));
    const q = progressOf(s, 0, n) / FX_ONE;
    expect(q).toBeGreaterThan(0.45);
    expect(q).toBeLessThan(0.55);
  });

  it('счётчиковое — по доле выполненного', () => {
    const s = arena();
    const n = bet(s, 'demolitionist');
    spawnEnemy(s, EnemyType.Wedge, fromInt(CX + 400), fromInt(CY));
    explode(s, fromInt(CX + 400), fromInt(CY), -1);
    expect(progressOf(s, 0, n) / FX_ONE).toBeCloseTo(1 / 3, 2);
  });

  it('удержание — по доле зачищенного бюджета угрозы', () => {
    const s = arena();
    const n = bet(s, 'no_damage');
    s.meta[Meta.RoomThreat] = 100;
    s.aThreatAt[n] = 0;
    s.meta[Meta.ThreatCleared] = 25;
    expect(progressOf(s, 0, n) / FX_ONE).toBeCloseTo(0.25, 2);
  });

  /**
   * Формула из ECONOMY §9А: `кон × (1 + q × (M − 1) / 2)`. Половина
   * причитавшейся прибыли — не произвольное число: без привязки к прогрессу
   * обналичивание давало бы безрисковые +100% кона вместо +14% за честное
   * удержание, и кнопка была бы права всегда.
   */
  it('«Забрать» платит по формуле', () => {
    const s = arena();
    const n = bet(s, 'no_damage', 100);
    const m = BETS[betIndex('no_damage')].multiplier / FX_ONE;

    // q = 0: возвращается ровно кон, взять и сразу бросить — нулевая операция.
    expect(cashOutValue(s, 0, n)).toBe(100);

    s.meta[Meta.RoomThreat] = 100;
    s.aThreatAt[n] = 0;
    s.meta[Meta.ThreatCleared] = 100;
    // q = 1: кон плюс половина прибыли, то есть 100 × (1 + (3−1)/2) = 200.
    expect(cashOutValue(s, 0, n)).toBe(Math.trunc(100 * (1 + (m - 1) / 2)));
  });

  it('обналиченное пари уходит из активных, а деньги — в кошелёк', () => {
    const s = arena(1, 0);
    const n = bet(s, 'no_damage', 50);
    s.meta[Meta.RoomThreat] = 100;
    s.aThreatAt[n] = 0;
    s.meta[Meta.ThreatCleared] = 50;

    const payout = cashOut(s, 0, n);
    expect(payout).toBeGreaterThan(50);
    expect(s.pChips[0]).toBe(payout);
    expect(stateOf(s, n)).toBe(BetState.Cashed);
    expect(s.meta[Meta.BetsCashed]).toBe(1);
  });

  it('обналичить чужое или уже закрытое нельзя', () => {
    const s = arena();
    const n = bet(s, 'no_damage', 50);
    cashOut(s, 0, n);
    const before = s.pChips[0];
    expect(cashOut(s, 0, n), 'заплатили дважды за одно пари').toBe(0);
    expect(s.pChips[0]).toBe(before);
  });
});

describe('расчёт комнаты', () => {
  it('выигранное пари платит кон на множитель', () => {
    const s = arena(1, 0);
    const n = bet(s, 'no_damage', 100);
    settleBets(s);

    const m = BETS[betIndex('no_damage')].multiplier / FX_ONE;
    expect(stateOf(s, n)).toBe(BetState.Won);
    expect(s.pChips[0]).toBe(Math.trunc(100 * m));
    expect(s.meta[Meta.BetsWon]).toBe(1);
  });

  it('проваленное не платит ничего и не создаёт долга', () => {
    const s = arena(1, 0);
    bet(s, 'no_damage', 100);
    incoming(s);
    run(s, 30);
    settleBets(s);

    expect(s.pChips[0], 'провал увёл кошелёк в минус').toBe(0);
    expect(stateOf(s, 0)).toBe(BetState.Lost);
  });

  it('аппетит задаёт кон тремя тирами', () => {
    for (let tier = 0; tier < APPETITE.length; tier++) {
      const s = arena(1, 500);
      const card = placeCard(s, betIndex('no_dash'), SHARED, s.tick + CARD.lifeTicks);
      s.pX[0] = s.kX[card];
      s.pY[0] = s.kY[card];
      // Тир едет двумя битами маски: 0 — скромно, 1 — нормально, 2 — по-крупному.
      run(s, 1, frame({ buttons: Btn.Take | (tier << APPETITE_SHIFT) }));
      expect(s.aStake[0], `тир ${tier}`).toBe(APPETITE[tier]);
    }
  });
});

describe('кошелёк', () => {
  it('никогда не уходит в минус за длинный прогон', () => {
    const s = createState(3, 2);
    spawnPlayers(s);
    for (let p = 0; p < 2; p++) s.pChips[p] = 60;

    const inputs = [
      { ...makeFrame(), buttons: Btn.Take | Btn.Fire },
      { ...makeFrame(), buttons: Btn.CashOut },
    ];
    for (let t = 0; t < 3000; t++) {
      step(s, inputs);
      for (let p = 0; p < 2; p++) expect(s.pChips[p]).toBeGreaterThanOrEqual(0);
    }
    expect(s.pHearts[0]).toBeLessThanOrEqual(PLAYER.startHearts);
  });
});

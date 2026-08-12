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
import { pickBark, severityOf } from '@dod/client/barks';
import {
  AceGesture,
  APPETITE,
  withAppetite,
  BETS,
  BetProgress,
  BetState,
  Btn,
  CARD,
  EnemyType,
  EntityFlag,
  FX_ONE,
  InputScheme,
  MAX_ACTIVE_BETS,
  MAX_CARDS,
  Meta,
  PLAYER,
  redZoneX,
  redZoneY,
  RESTART_DELAY_TICKS,
  SCHEME_SHIFT,
  SHARED,
  WAVE,
  cashOut,
  cashOutValue,
  checkInvariants,
  createState,
  damagePlayer,
  dealCards,
  dropChip,
  failBet,
  explode,
  fromInt,
  makeFrame,
  nearMissOf,
  placeCard,
  progressOf,
  settleBets,
  setSpawning,
  spawnEnemy,
  spawnPlayers,
  startRoom,
  step,
  stepBets,
  takeBet,
  toFloat,
  type InputFrame,
  type SimState,
} from '@dod/sim';

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

/** Слот, в котором у игрока лежит названное пари. */
function slotOf(s: SimState, id: string, player = 0): number {
  const want = betIndex(id);
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    const k = player * MAX_ACTIVE_BETS + i;
    if (s.aState[k] !== BetState.None && s.aBet[k] === want) return i;
  }
  return -1;
}

/** Взять пари напрямую: раскладка проверяется отдельно, здесь важны условия. */
function bet(s: SimState, id: string, stake = 10, player = 0): number {
  const b = betIndex(id);
  takeBet(s, player, b, stake);
  // Слот ищется ПО ПАРИ, а не по первому активному: со вторым взятым пари
  // «первый активный» — это предыдущее, и тест молча проверяет не то, что
  // назвал.
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    const k = player * MAX_ACTIVE_BETS + i;
    if (s.aState[k] === BetState.Active && s.aBet[k] === b) return i;
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

    // Крупье в кредит не принимает: кон обрезается кошельком, а не уводит в долг.
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

    s.pX[0] = redZoneX(s);
    s.pY[0] = redZoneY(s);
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
      // Тир едет двумя битами маски СО СДВИГОМ НА ЕДИНИЦУ: ноль означает
      // «игрок молчит», иначе защёлка не отличила бы явно выбранное «Скромно»
      // от отпущенной крестовины — и самый нужный в начале забега тир стал бы
      // невыбираемым. Укладывает `withAppetite`, читает `appetiteOf`.
      run(s, 1, frame({ buttons: withAppetite(Btn.Take, tier) }));
      expect(s.aStake[0], `тир ${tier}`).toBe(APPETITE[tier]);
    }
  });

  it('«Скромно» выбирается ЯВНО, а не только молчанием', () => {
    const s = arena(1, 500);
    // Уходим на верхний тир, потом возвращаемся на нижний — именно этот путь
    // и был закрыт: запрошенный ноль ядро принимало за «ничего не нажато».
    run(s, 1, frame({ buttons: withAppetite(0, 2) }));
    expect(s.pAppetite[0]).toBe(2);
    run(s, 1, frame({ buttons: withAppetite(0, 0) }));
    expect(s.pAppetite[0], 'спуск на «Скромно» проигнорирован').toBe(0);
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

/**
 * Крупье как физический комик (GDD §17А).
 *
 * Проверяется не «сработал ли жест», а границы: юмор за счёт игрока обязан
 * выключаться, когда игроку и без того плохо. Это правило легко потерять при
 * любой правке — а вернётся оно жалобой «игра надо мной издевается», и то
 * если игрок вообще напишет, а не закроет её молча.
 */
describe('жесты Крупье', () => {
  /** Поставить Крупье на арену: без тела жестов не бывает. */
  function withAce(s: SimState): void {
    s.meta[Meta.AceX] = fromInt(100);
    s.meta[Meta.AceY] = fromInt(CY);
  }

  it('провал пари вызывает аплодисменты', () => {
    const s = arena();
    withAce(s);
    const n = bet(s, 'no_damage');
    expect(n).toBeGreaterThanOrEqual(0);
    failBet(s, 0, 'no_damage');
    expect(s.meta[Meta.AceGesture]).toBe(AceGesture.Applaud);
  });

  /**
   * Событие, достойное реакции, ПРИВОДИТ Крупье — он не комментирует из-за кадра.
   *
   * Пока `gesture()` просто выходил при пустой арене, четыре жеста из шести не
   * срабатывали ни разу: замер на пяти минутах игры двумя ботами давал Крупье на
   * арене 7% времени и ровно два вида жестов. «Комедия из правил» (GDD §17А)
   * молчала почти весь бой, притом что весь словарь барков был написан.
   */
  it('провал при пустой арене выводит Крупье, а не пропадает', () => {
    const s = arena();
    bet(s, 'no_damage');
    expect(s.meta[Meta.AceX], 'Крупье уже на арене — проверка ни о чём').toBe(0);

    failBet(s, 0, 'no_damage');
    expect(s.meta[Meta.AceX], 'событие не вывело Крупье').not.toBe(0);
    expect(s.meta[Meta.AceGesture]).toBe(AceGesture.Applaud);

    // Тело приезжает с тем же телеграфом, что у подброса: реакция с
    // опозданием на полсекунды честнее реакции из ниоткуда.
    expect(s.meta[Meta.AceGestureUntil]).toBeGreaterThan(s.tick + CARD.gestureTicks);
  });

  it('выход «на настроение» тратится один раз за комнату', () => {
    const s = arena();
    bet(s, 'no_damage');
    failBet(s, 0, 'no_damage');
    const first = s.meta[Meta.AceX];
    expect(first).not.toBe(0);

    // Дожидаемся ухода и пробуем снова: бюджет выходов исчерпан.
    run(s, CARD.aceTelegraphTicks + CARD.aceStayTicks + CARD.aceCameoGapTicks + 2);
    expect(s.meta[Meta.AceX], 'не ушёл').toBe(0);
    bet(s, 'no_dash');
    failBet(s, 0, 'no_dash');
    expect(s.meta[Meta.AceX], 'вышел второй раз за ту же комнату').toBe(0);
  });

  it('пассивные жесты не зовут Крупье: выход берегут для события', () => {
    const s = arena();
    // Скука верна всё время, пока верна: дай ей звать — и единственный выход
    // уйдёт на фон, а аплодисменты провалу не случатся уже никогда.
    s.meta[Meta.LastBetRoom] = s.meta[Meta.Room] - CARD.boredomRooms;
    run(s, 5);
    expect(s.meta[Meta.AceX]).toBe(0);
    expect(s.meta[Meta.AceGesture]).toBe(AceGesture.None);
  });

  it('после трёх смертей подряд Крупье перестаёт злорадствовать', () => {
    const s = arena();
    withAce(s);
    s.meta[Meta.DeathStreak] = CARD.mercyDeathStreak;
    bet(s, 'no_damage');
    failBet(s, 0, 'no_damage');
    expect(s.meta[Meta.AceGesture]).toBe(AceGesture.None);
  });

  it('новая комната обрывает серию смертей', () => {
    const s = arena();
    s.meta[Meta.DeathStreak] = 5;
    startRoom(s, 2);
    expect(s.meta[Meta.DeathStreak]).toBe(0);
  });

  /*
   * Расчёт комнаты не имеет права оставить жест без тела.
   *
   * `startRoom` сначала считает прошлую комнату, а потом раздаёт карты. Расчёт
   * срывает недожатые пари, каждый срыв зовёт жест, и жест выводит Крупье на
   * арену — а раздача двумя строками ниже убирает присутствие. Пока она не
   * убирала заодно и жест, состояние выходило запрещённым: тела нет, жест
   * играется. В dev-сборке инвариант останавливал цикл прямо на экране
   * расчёта, и игрок оставался с кадром, который нечем пропустить; ботом это
   * ловилось в каждом пятом забеге.
   *
   * Проверяется инвариантом, а не сравнением поля: правило записано именно
   * там, и тест обязан падать от того же, от чего падает игра.
   */
  it('Крупье выходит принимать расчёт и хлопает провалу', () => {
    const s = arena();
    // «Подрывник» считает до трёх и к расчёту провален — значит будут
    // аплодисменты, и хлопать обязано ТЕЛО: жест без тела запрещён.
    bet(s, 'demolitionist');
    startRoom(s, 2);
    expect(s.meta[Meta.AceX], 'не вышел к расчёту').not.toBe(0);
    expect(s.meta[Meta.AceGesture]).toBe(AceGesture.Applaud);
    expect(() => checkInvariants(s)).not.toThrow();

    // И уходит сам, унося жест: расчёт длиннее его выхода, поэтому уход виден.
    run(s, CARD.aceTelegraphTicks + CARD.aceStayTicks + 2);
    expect(s.meta[Meta.AceX], 'остался стоять до конца паузы').toBe(0);
    expect(s.meta[Meta.AceGesture]).toBe(AceGesture.None);
    expect(() => checkInvariants(s)).not.toThrow();
  });

  it('к пустому расчёту Крупье не выходит', () => {
    const s = arena();
    // Первая комната забега: считать нечего, панель расчёта не рисуется. Крупье,
    // пришедший к пустому столу, — та самая декорация вместо события.
    startRoom(s, 2);
    expect(s.meta[Meta.AceX]).toBe(0);
    expect(s.meta[Meta.AceGesture]).toBe(AceGesture.None);
  });

  it('расчёт не съедает выход на реакцию в бою', () => {
    const s = arena();
    bet(s, 'demolitionist');
    startRoom(s, 2);
    // Расчёт занял один выход, подброс займёт второй — на реакцию боя обязан
    // остаться третий, иначе событийные жесты снова становятся мёртвым кодом.
    run(s, CARD.aceTelegraphTicks + CARD.aceStayTicks + CARD.aceCameoGapTicks + 2);
    expect(s.meta[Meta.AceX], 'не ушёл после расчёта').toBe(0);
    bet(s, 'no_dash');
    failBet(s, 0, 'no_dash');
    expect(s.meta[Meta.AceX], 'не пришёл на событие боя').not.toBe(0);
    expect(s.meta[Meta.AceGesture]).toBe(AceGesture.Applaud);
    expect(() => checkInvariants(s)).not.toThrow();
  });

  it('на пороге крупного выигрыша отворачивается', () => {
    const s = arena();
    withAce(s);
    const n = bet(s, 'under_45s');
    const spec = BETS[s.aBet[n]];
    // Почти вышло время: прогресс по времени — это и есть «вот-вот выиграет».
    s.aTakenAt[n] = s.tick - Math.trunc((spec.limitTicks * 95) / 100);
    stepBets(s);
    expect(s.meta[Meta.AceGesture]).toBe(AceGesture.TurnAway);
  });

  it('соскок в шаге от куша встречает палец вниз', () => {
    const s = arena();
    withAce(s);
    const n = bet(s, 'under_45s');
    const spec = BETS[s.aBet[n]];
    s.aTakenAt[n] = s.tick - Math.trunc((spec.limitTicks * 95) / 100);
    cashOut(s, 0, n);
    expect(s.meta[Meta.AceGesture]).toBe(AceGesture.ThumbsDown);
  });

  it('жест не перебивает жест', () => {
    const s = arena();
    withAce(s);
    bet(s, 'no_damage');
    failBet(s, 0, 'no_damage');
    const until = s.meta[Meta.AceGestureUntil];
    bet(s, 'no_dash');
    failBet(s, 0, 'no_dash');
    expect(s.meta[Meta.AceGesture]).toBe(AceGesture.Applaud);
    expect(s.meta[Meta.AceGestureUntil]).toBe(until);
  });
});

/**
 * Реплики.
 *
 * Текста в кадре пока нет, но правило дозировки уже работает, и проверять
 * его надо здесь: в F2 оно окажется под шрифтом и словарём, где ловить его
 * втрое дороже.
 */
describe('барки', () => {
  it('чем хуже игроку, тем мягче реплика', () => {
    const soft = pickBark(AceGesture.Applaud, 0, 1);
    for (let occasion = 0; occasion < 10; occasion++) {
      expect(pickBark(AceGesture.Applaud, occasion, 1)).toBe(soft);
    }
    // Без беды в ход идут и дерзкие: иначе Крупье одинаков весь забег.
    const seen = new Set<string>();
    for (let occasion = 0; occasion < 10; occasion++) {
      seen.add(pickBark(AceGesture.Applaud, occasion, 0));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('реплики идут по кругу, а не наугад', () => {
    const first = pickBark(AceGesture.Yawn, 0);
    expect(pickBark(AceGesture.Yawn, 1)).not.toBe(first);
    expect(pickBark(AceGesture.Yawn, 3)).toBe(first);
  });

  it('у каждого жеста есть что сказать', () => {
    for (const g of [
      AceGesture.Yawn,
      AceGesture.Applaud,
      AceGesture.TurnAway,
      AceGesture.Fidget,
      AceGesture.ThumbsDown,
      AceGesture.Ovation,
    ]) {
      expect(pickBark(g, 0).length).toBeGreaterThan(0);
    }
  });

  it('серия смертей и пустой кошелёк считаются бедой', () => {
    expect(severityOf(0, 100)).toBe(0);
    expect(severityOf(3, 100)).toBe(1);
    expect(severityOf(0, 0)).toBeGreaterThan(0);
  });
});

/**
 * Матрица «пари × схема ввода» (GDD §9.5).
 *
 * Карта, которую игрок физически не может отыграть, — это не сложность, а
 * поломка: пари на дисциплину выстрелов не выиграть там, где огонь
 * автоматический. Проверяется здесь не список исключений — он в данных, — а
 * то, что раскладка его СЛУШАЕТ и что схема доезжает до симуляции кадром
 * ввода, а не настройкой клиента.
 */
describe('пари и схема ввода', () => {
  it('схема приезжает из кадра ввода и переигрывается вместе с боем', () => {
    const s = arena();
    run(s, 1, frame({ buttons: InputScheme.Touch << SCHEME_SHIFT }));
    expect(s.pScheme[0]).toBe(InputScheme.Touch);
    run(s, 1, frame({ buttons: InputScheme.Gamepad << SCHEME_SHIFT }));
    expect(s.pScheme[0]).toBe(InputScheme.Gamepad);
  });

  it('исключённое пари не попадает в раскладку', () => {
    // Исключение берётся не из каталога, а ставится здесь: каталог 0.3.0
    // исключений не содержит, а правило обязано работать до того, как первое
    // такое пари появится, — иначе его отсутствие заметят по жалобе.
    const spec = BETS[betIndex('no_dash')] as { schemeMask: number };
    const saved = spec.schemeMask;
    spec.schemeMask = 1 << InputScheme.Touch;
    try {
      for (let seed = 1; seed <= 20; seed++) {
        const s = createState(seed, 1);
        spawnPlayers(s);
        setSpawning(s, false);
        s.pScheme[0] = InputScheme.Touch;
        dealCards(s);
        for (let i = 0; i < MAX_CARDS; i++) {
          if (!s.kActive[i]) continue;
          expect(BETS[s.kBet[i]].id).not.toBe('no_dash');
        }
      }
    } finally {
      spec.schemeMask = saved;
    }
  });

  it('на своей схеме то же пари выпадает', () => {
    const spec = BETS[betIndex('no_dash')] as { schemeMask: number };
    const saved = spec.schemeMask;
    spec.schemeMask = 1 << InputScheme.Touch;
    try {
      let met = false;
      for (let seed = 1; seed <= 20 && !met; seed++) {
        const s = createState(seed, 1);
        spawnPlayers(s);
        setSpawning(s, false);
        s.pScheme[0] = InputScheme.Gamepad;
        dealCards(s);
        for (let i = 0; i < MAX_CARDS; i++) {
          if (s.kActive[i] && BETS[s.kBet[i]].id === 'no_dash') met = true;
        }
      }
      expect(met).toBe(true);
    } finally {
      spec.schemeMask = saved;
    }
  });

  it('конфликтующие пари не лежат на арене вместе', () => {
    // Обе стороны: конфликт взаимен, и генератор каталога делает маски
    // симметричными сам. Патчить одну сторону значило бы проверять не то
    // правило, которое работает в игре.
    const dashBet = BETS[betIndex('no_dash')] as { conflictMask: number };
    const damageBet = BETS[betIndex('no_damage')] as { conflictMask: number };
    const saved = [dashBet.conflictMask, damageBet.conflictMask];
    dashBet.conflictMask = 1 << betIndex('no_damage');
    damageBet.conflictMask = 1 << betIndex('no_dash');
    try {
      for (let seed = 1; seed <= 20; seed++) {
        const s = createState(seed, 2);
        spawnPlayers(s);
        setSpawning(s, false);
        dealCards(s);
        let hasDash = false;
        let hasDamage = false;
        for (let i = 0; i < MAX_CARDS; i++) {
          if (!s.kActive[i]) continue;
          if (BETS[s.kBet[i]].id === 'no_dash') hasDash = true;
          if (BETS[s.kBet[i]].id === 'no_damage') hasDamage = true;
        }
        expect(hasDash && hasDamage).toBe(false);
      }
    } finally {
      dashBet.conflictMask = saved[0];
      damageBet.conflictMask = saved[1];
    }
  });
});

/**
 * Прогресс `q` по всем трём видам (ECONOMY §9А).
 *
 * На нём стоит выплата за «Забрать», а ошибка в нём не видна ни в бою, ни в
 * логе — только в деньгах, и не сразу.
 */
describe('виды прогресса', () => {
  it('каждый вид прогресса представлен в каталоге и растёт от нуля', () => {
    const kinds = new Set(BETS.map((b) => b.progress));
    expect(kinds.has(BetProgress.Time)).toBe(true);
    expect(kinds.has(BetProgress.Counter)).toBe(true);
    expect(kinds.has(BetProgress.Threat)).toBe(true);
  });

  it('мёртвый игрок не выигрывает ничего', () => {
    const s = arena();
    const n = bet(s, 'no_damage');
    expect(n).toBeGreaterThanOrEqual(0);
    const before = s.pChips[0];
    s.pFlags[0] &= ~EntityFlag.Alive;
    settleBets(s);
    expect(stateOf(s, n)).toBe(BetState.Lost);
    expect(s.pChips[0]).toBe(before);
  });
});

describe('near-miss', () => {
  it('сорванное пари помнит, насколько не хватило', () => {
    const s = arena();
    const n = bet(s, 'under_45s');
    const spec = BETS[s.aBet[n]];
    // Три четверти отсчёта позади — и тут по игроку попадают.
    s.aTakenAt[n] = s.tick - Math.trunc((spec.limitTicks * 75) / 100);
    bet(s, 'no_damage');
    // Слот ищем по самому пари: помощник выше отдаёт первый активный, а их
    // тут уже два.
    const damageSlot = slotOf(s, 'no_damage');
    // Неуязвимость после появления снимается руками: предмет проверки —
    // near-miss, а не то, сколько кадров игрок бессмертен на старте.
    s.pInvulUntil[0] = 0;
    s.pFlags[0] &= ~EntityFlag.Invulnerable;
    damagePlayer(s, 0);

    expect(stateOf(s, damageSlot)).toBe(BetState.Lost);
    const q = (nearMissOf(s, 0, damageSlot) * 100) / FX_ONE;
    // «Без урона» меряется зачищенной угрозой, а её на пустой арене нет:
    // near-miss честно нулевой, и это тоже число, а не отсутствие числа.
    expect(q).toBeGreaterThanOrEqual(0);

    // А темповое пари, сорванное по времени, помнит три четверти пути.
    run(s, spec.limitTicks);
    expect(stateOf(s, n)).toBe(BetState.Lost);
    expect((nearMissOf(s, 0, n) * 100) / FX_ONE).toBeGreaterThan(70);
  });
});

/**
 * Мёртвый не выигрывает ничего.
 *
 * Дефект, ради которого этот блок и написан: пари погибшего рассчитывались на
 * старте следующей комнаты, а перезапуск забега успевал вернуть флаг «жив» —
 * и всё, что было активно в момент смерти, засчитывалось как выигранное.
 * Цена известна и измерена: доля успеха выходила 0.73 против целевых 38–55%
 * из ECONOMY §2, то есть ставки печатали деньги ровно в тех забегах, где
 * игрок проигрывал. Отсюда и явность проверки: она сторожит не строчку кода,
 * а порядок величин во всей экономике.
 */
describe('гибель закрывает пари', () => {
  /** Довести игрока до смерти уроном, не полагаясь на снаряды и таймеры. */
  function kill(s: SimState, player = 0): void {
    s.pHearts[player] = 1;
    s.pFlags[player] &= ~EntityFlag.Invulnerable;
    s.pInvulUntil[player] = 0;
    damagePlayer(s, player);
  }

  it('пари погибшего проиграно и переживает перезапуск забега', () => {
    const s = arena(1, 100);
    const n = bet(s, 'no_damage', 10);
    s.pChips[0] -= 10;
    // Шестьдесят процентов пути под риском: near-miss обязан остаться этим
    // числом, а не обнулиться и не досчитаться до конца комнаты.
    s.meta[Meta.RoomThreat] = 100;
    s.aThreatAt[n] = 0;
    s.meta[Meta.ThreatCleared] = 60;

    kill(s);
    expect(s.pFlags[0] & EntityFlag.Alive, 'игрок пережил смертельный урон').toBe(0);
    expect(stateOf(s, n), 'пари погибшего осталось активным').toBe(BetState.Lost);
    expect(s.pChips[0], 'смерть заплатила').toBe(90);
    expect(nearMissOf(s, 0, n) / FX_ONE, 'near-miss снят не на момент гибели').toBeCloseTo(0.6, 2);

    // Перезапуск забега: именно здесь флаг «жив» возвращался ДО расчёта.
    run(s, RESTART_DELAY_TICKS + 5);

    expect(stateOf(s, n), 'перезапуск переиграл проигрыш в выигрыш').toBe(BetState.Lost);
    expect(s.meta[Meta.BetsWon], 'мёртвый выиграл пари').toBe(0);
    expect(s.meta[Meta.BetsLost], 'проигрыш посчитан дважды').toBe(1);
    expect(nearMissOf(s, 0, n) / FX_ONE, 'перезапуск обнулил near-miss').toBeCloseTo(0.6, 2);
  });

  it('«Без урона» не засчитывается тому, кого этот урон и убил', () => {
    const s = arena(1, 100);
    const n = bet(s, 'no_damage', 10);
    kill(s);
    settleBets(s);
    expect(stateOf(s, n)).toBe(BetState.Lost);
    expect(s.meta[Meta.BetsWon]).toBe(0);
  });
});

/**
 * Счётчики исходов.
 *
 * На `BetsTaken/Won/Lost/Cashed` стоят ограничители G6, G10 и G14 и JSON-отчёт
 * раннера. Пока проигранные считал один расчёт комнаты, пари, сорванное по
 * ходу боя, не попадало никуда — и врал не счётчик, а весь балансный контур.
 */
describe('счётчики пари', () => {
  it('взято равно выиграно плюс проиграно плюс обналичено', () => {
    const s = arena(1, 200);
    bet(s, 'no_damage', 10);
    bet(s, 'no_dash', 10);
    const cashed = bet(s, 'under_45s', 10);

    failBet(s, 0, 'no_dash');
    cashOut(s, 0, cashed);
    settleBets(s);

    const m = s.meta;
    expect(m[Meta.BetsTaken]).toBe(3);
    expect(m[Meta.BetsWon]).toBe(1);
    expect(m[Meta.BetsLost]).toBe(1);
    expect(m[Meta.BetsCashed]).toBe(1);
    expect(m[Meta.BetsWon] + m[Meta.BetsLost] + m[Meta.BetsCashed]).toBe(m[Meta.BetsTaken]);
  });

  it('пари, сорванное по ходу комнаты, попадает в проигранные сразу', () => {
    const s = arena(1, 100);
    bet(s, 'no_dash', 10);
    failBet(s, 0, 'no_dash');
    expect(s.meta[Meta.BetsLost], 'срыв по ходу боя не попал в статистику').toBe(1);

    // Расчёт комнаты не имеет права посчитать его второй раз.
    settleBets(s);
    expect(s.meta[Meta.BetsLost]).toBe(1);
  });
});

/**
 * Матрица конфликтов и матрица «пари × схема ввода» (GDD §9.5).
 *
 * В каталоге 0.3.0 ни конфликтов, ни исключений по схемам нет, и покрывать
 * содержимое нечем — а вот МЕХАНИЗМ обязан работать до того, как в каталоге
 * появится первая пара: правило, включённое вместе с данными, включается уже
 * сломанным. Каталог здесь не правится: маски подменяются на время проверки и
 * возвращаются обратно.
 */
describe('матрица конфликтов пари', () => {
  interface Patch {
    index: number;
    conflictMask?: number;
    schemeMask?: number;
  }

  /** Синтетический каталог: маски подменяются ровно на время проверки. */
  function withCatalog<T>(patches: readonly Patch[], fn: () => T): T {
    const spec = BETS as unknown as { conflictMask: number; schemeMask: number }[];
    const saved = spec.map((b) => ({ c: b.conflictMask, s: b.schemeMask }));
    try {
      for (const p of patches) {
        if (p.conflictMask !== undefined) spec[p.index].conflictMask = p.conflictMask;
        if (p.schemeMask !== undefined) spec[p.index].schemeMask = p.schemeMask;
      }
      return fn();
    } finally {
      spec.forEach((b, i) => {
        b.conflictMask = saved[i].c;
        b.schemeMask = saved[i].s;
      });
    }
  }

  const A = betIndex('no_damage');
  const B = betIndex('no_dash');
  const MUTUAL: Patch[] = [
    { index: A, conflictMask: 1 << B },
    { index: B, conflictMask: 1 << A },
  ];

  /** Пари, лежащие на арене. */
  function onArena(s: SimState): number[] {
    const out: number[] = [];
    for (let i = 0; i < MAX_CARDS; i++) if (s.kActive[i]) out.push(s.kBet[i]);
    return out;
  }

  const SEEDS = 60;

  it('конфликтующее не выпадает, пока конфликтующее с ним лежит на арене', () => {
    // Сначала убеждаемся, что проверка вообще различает: без конфликта пара
    // на столе встречается, иначе тест зеленел бы сам по себе.
    let together = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const s = createState(seed, 1);
      spawnPlayers(s);
      const ids = onArena(s);
      if (ids.includes(A) && ids.includes(B)) together++;
    }
    expect(together, 'без конфликта пара и так не встречается — проверка слепа').toBeGreaterThan(0);

    withCatalog(MUTUAL, () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const s = createState(seed, 1);
        spawnPlayers(s);
        const ids = onArena(s);
        expect(
          ids.includes(A) && ids.includes(B),
          `сид ${seed}: конфликтующие пари легли на один стол`,
        ).toBe(false);
      }
    });
  });

  it('конфликтующее не выпадает, пока конфликтующее с ним активно у игрока', () => {
    withCatalog(MUTUAL, () => {
      for (let seed = 1; seed <= SEEDS; seed++) {
        const s = createState(seed, 1);
        spawnPlayers(s);
        takeBet(s, 0, A, 10);
        dealCards(s);
        expect(onArena(s), `сид ${seed}: карта конфликтует с активным пари`).not.toContain(B);
      }
    });
  });

  it('односторонний конфликт защищает только в одну сторону — взаимность обязательна', () => {
    // A объявляет конфликт с B, B про A молчит. Проверка идёт по маске
    // КАНДИДАТА, поэтому защищена ровно одна сторона: односторонняя запись в
    // каталоге означала бы пару, которая всё-таки выпадет вместе — смотря
    // какую вытянули первой. Отсюда требование взаимности в схеме каталога.
    const oneWay: Patch[] = [
      { index: A, conflictMask: 1 << B },
      { index: B, conflictMask: 0 },
    ];
    withCatalog(oneWay, () => {
      let leaked = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const s = createState(seed, 1);
        spawnPlayers(s);
        // Держим B активным: A обязан быть заблокирован своей же маской.
        takeBet(s, 0, B, 10);
        dealCards(s);
        expect(onArena(s), `сид ${seed}: защищённая сторона протекла`).not.toContain(A);

        const t = createState(seed, 1);
        spawnPlayers(t);
        // Теперь наоборот: у B маски нет, и он выпадает при активном A.
        takeBet(t, 0, A, 10);
        dealCards(t);
        if (onArena(t).includes(B)) leaked++;
      }
      expect(
        leaked,
        'односторонний конфликт оказался достаточным — а он таким не бывает',
      ).toBeGreaterThan(0);
    });
  });

  it('каталог объявляет конфликты с обеих сторон', () => {
    for (let i = 0; i < BETS.length; i++) {
      for (let j = 0; j < BETS.length; j++) {
        const ij = (BETS[i].conflictMask & (1 << j)) !== 0;
        const ji = (BETS[j].conflictMask & (1 << i)) !== 0;
        expect(ij, `конфликт «${BETS[i].id}» → «${BETS[j].id}» объявлен в одну сторону`).toBe(ji);
      }
    }
  });

  it('общая карта не выдаётся, если пари невыполнимо хоть для кого-то за столом', () => {
    const k = betIndex('no_dash');
    withCatalog([{ index: k, schemeMask: 1 << InputScheme.Touch }], () => {
      let personal = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const s = createState(seed, 2);
        spawnPlayers(s);
        s.pScheme[0] = InputScheme.Gamepad;
        s.pScheme[1] = InputScheme.Touch;
        dealCards(s);

        for (let i = 0; i < MAX_CARDS; i++) {
          if (!s.kActive[i] || s.kBet[i] !== k) continue;
          expect(s.kOwner[i], `сид ${seed}: пари досталось общей картой или игроку с тачем`).toBe(
            0,
          );
          personal++;
        }
      }
      // Отбраковка обязана быть точечной: игроку, который пари отыграть
      // может, оно по-прежнему выпадает именной картой.
      expect(personal, 'пари вычеркнуто из каталога вместо отбраковки общей карты').toBeGreaterThan(
        0,
      );
    });
  });
});

/**
 * Точка безубыточности `p = 1/M` (ECONOMY §2, DEVLOOP §6А).
 *
 * Формула выплат — единственное место, где ошибка не видна ни в бою, ни в
 * логе: пари выигрываются и проигрываются как задумано, а деньги за забег
 * расходятся с моделью на десятки процентов. Проверяется настоящим
 * `settleBets`, а не арифметикой рядом с ним.
 */
describe('формулы выплат', () => {
  it('при вероятности 1/M матожидание каждого пари равно нулю', () => {
    for (const spec of BETS) {
      const stake = 1000;
      const s = arena(1, 0);
      const n = bet(s, spec.id, stake);
      if (spec.progress === BetProgress.Counter) s.aCounter[n] = spec.target;
      settleBets(s);

      expect(stateOf(s, n), `«${spec.id}» не засчиталось`).toBe(BetState.Won);
      const payout = s.pChips[0];
      const m = spec.multiplier / FX_ONE;
      // EV = p × выплата − кон, при p = 1/M обязан быть нулём.
      expect(payout / m - stake, `«${spec.id}»: EV в точке безубыточности`).toBeCloseTo(0, 0);
    }
  });

  it('проигрыш стоит ровно кон и не создаёт долга', () => {
    for (const spec of BETS) {
      const s = arena(1, 100);
      const n = bet(s, spec.id, 40);
      s.pChips[0] -= 40;
      failBet(s, 0, spec.id);
      settleBets(s);
      expect(stateOf(s, n)).toBe(BetState.Lost);
      expect(s.pChips[0], `«${spec.id}»: провал списал больше кона`).toBe(60);
    }
  });
});

/**
 * Расчёт как экран, а не мгновение (UX §6).
 *
 * Итоги обязаны дожить до первой волны следующей комнаты: их читают. А пари,
 * взятое во время расчёта, обязано пережить её начало — карты новой комнаты
 * лежат уже там, и «взял, побежал, а его нет» игрок объяснит себе только
 * поломкой.
 */
describe('экран расчёта', () => {
  /** Арена с волнами: расчёт кончается началом боя, а бой должен начаться. */
  function waveArena(chips = 200): SimState {
    const s = arena(1, chips);
    setSpawning(s, true);
    return s;
  }

  it('итоги живут всю паузу и уходят с первой волной', () => {
    const s = waveArena();
    const n = bet(s, 'no_damage');
    expect(n).toBeGreaterThanOrEqual(0);

    startRoom(s, 2);
    expect(stateOf(s, n)).toBe(BetState.Won);
    // Пауза целиком: результат виден до последнего её тика.
    run(s, WAVE.roomGapTicks - 1);
    expect(stateOf(s, n)).toBe(BetState.Won);
    run(s, 2);
    expect(s.meta[Meta.Wave]).toBe(1);
    expect(stateOf(s, n)).toBe(BetState.None);
  });

  it('пари, взятое во время расчёта, переживает начало боя', () => {
    const s = waveArena();
    startRoom(s, 2);
    const n = bet(s, 'no_dash');
    run(s, WAVE.roomGapTicks + 2);
    expect(s.meta[Meta.Wave]).toBe(1);
    expect(stateOf(s, n)).toBe(BetState.Active);
  });

  it('расчёт пропускается кнопкой, но не раньше секунды', () => {
    const s = waveArena();
    startRoom(s, 2);
    const accept = frame({ buttons: Btn.Accept });
    // Раньше секунды кнопка молчит: зажатый ради автоогня триггер иначе
    // пролистывал бы near-miss, ради которого экран и существует.
    run(s, 2, accept);
    run(s, 2, frame());
    run(s, 2, accept);
    expect(s.meta[Meta.Wave]).toBe(0);

    run(s, WAVE.settleSkipAfterTicks, frame());
    run(s, 2, accept);
    expect(s.meta[Meta.Wave]).toBe(1);
  });
});

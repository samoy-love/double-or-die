/**
 * Автоматы врагов и правила честности.
 *
 * Каждый враг — маленький автомат, и проверять надо именно переходы: игра
 * обещает игроку, что поведение предсказуемо и что у каждой атаки есть
 * телеграф (DIFFICULTY §7). Обещание, не покрытое тестом, живёт до первой
 * правки скорости.
 *
 * Правила честности проверяются здесь же и по одной причине: непроходимая
 * комбинация врагов обязана быть падающим тестом, а не жалобой в отзывах.
 */

import { describe, expect, it } from 'vitest';
import {
  ENEMIES,
  EnemyPhase,
  EnemyType,
  FAIRNESS,
  FUSE,
  MAX_BULLETS,
  MAX_ENEMIES,
  Meta,
  RunPhase,
  WEDGE,
  createState,
  explode,
  fromInt,
  makeFrame,
  roomBudget,
  setSpawning,
  setArena,
  spawnEnemy,
  spawnPlayers,
  step,
  toFloat,
  type InputFrame,
  type SimState,
} from '@dod/sim';
import { makeBot } from '@dod/tools/bots';

/** Пустая арена: врагов ставим сами, волны не мешают. */
function arena(players = 1): SimState {
  const s = createState(1, players);
  spawnPlayers(s);
  setSpawning(s, false);
  return s;
}

const idle = (n: number): InputFrame[] => Array.from({ length: n }, makeFrame);

function run(s: SimState, ticks: number, inputs = idle(s.playerCount)): void {
  for (let t = 0; t < ticks; t++) step(s, inputs);
}

/** Позиции игрока по умолчанию: центр арены. */
const CX = 960;
const CY = 540;

describe('Клин', () => {
  const stats = ENEMIES[EnemyType.Wedge];

  it('проходит все переходы автомата', () => {
    const s = arena();
    // Ставим за радиусом прицеливания: сначала он обязан сближаться.
    const e = spawnEnemy(s, EnemyType.Wedge, fromInt(CX + 700), fromInt(CY));
    expect(s.ePhase[e]).toBe(EnemyPhase.Idle);
    run(s, 5);
    expect(s.ePhase[e]).toBe(EnemyPhase.Idle);

    // Сблизился и объявил таран, оказавшись в радиусе прицеливания.
    while (s.ePhase[e] === EnemyPhase.Idle) run(s, 1);
    expect(s.ePhase[e]).toBe(EnemyPhase.Telegraph);

    // Телеграф длится не меньше заявленного: это главный рычаг честности,
    // и укоротить его молча нельзя.
    const declaredAt = s.tick;
    while (s.ePhase[e] === EnemyPhase.Telegraph) run(s, 1);
    expect(s.tick - declaredAt).toBeGreaterThanOrEqual(stats.telegraphTicks);
    expect(s.ePhase[e]).toBe(EnemyPhase.Attack);

    while (s.ePhase[e] === EnemyPhase.Attack && s.eActive[e]) run(s, 1);
    expect(s.ePhase[e]).toBe(EnemyPhase.Recover);

    run(s, stats.recoverTicks + 1);
    expect(s.ePhase[e]).toBe(EnemyPhase.Idle);
  });

  /**
   * Наведения во время рывка нет — именно поэтому уклонение ощущается
   * навыком, а не лотереей. Проверяем движением игрока в сторону: направление
   * тарана обязано остаться прежним.
   */
  it('в рывке не наводится на цель', () => {
    const s = arena();
    const e = spawnEnemy(s, EnemyType.Wedge, fromInt(CX + 400), fromInt(CY));
    while (s.ePhase[e] !== EnemyPhase.Attack) run(s, 1);

    const dirX = s.eDirX[e];
    const dirY = s.eDirY[e];
    run(s, 10, [{ ...makeFrame(), moveY: fromInt(1) }]);
    expect(s.eDirX[e]).toBe(dirX);
    expect(s.eDirY[e]).toBe(dirY);
  });

  it('не объявляет таран в упор — сначала отходит для разгона', () => {
    const s = arena();
    const e = spawnEnemy(s, EnemyType.Wedge, fromInt(CX + 120), fromInt(CY));
    run(s, 20);
    expect(s.ePhase[e]).toBe(EnemyPhase.Idle);
    // Отошёл дальше минимальной дистанции разгона.
    expect(toFloat(s.eX[e]) - CX).toBeGreaterThan(toFloat(WEDGE.minAimRange) * 0.5);
  });

  it('таран отнимает сердце', () => {
    const s = arena();
    spawnEnemy(s, EnemyType.Wedge, fromInt(CX + 400), fromInt(CY));
    run(s, 240);
    expect(s.pHearts[0]).toBeLessThan(3);
  });
});

describe('Кирпич', () => {
  const stats = ENEMIES[EnemyType.Brick];

  it('стреляет через телеграф, а не внезапно', () => {
    const s = arena();
    const e = spawnEnemy(s, EnemyType.Brick, fromInt(CX + 420), fromInt(CY));

    while (s.ePhase[e] !== EnemyPhase.Telegraph) run(s, 1);
    expect(countBullets(s)).toBe(0);

    const declaredAt = s.tick;
    while (s.ePhase[e] === EnemyPhase.Telegraph) run(s, 1);
    expect(s.tick - declaredAt).toBeGreaterThanOrEqual(stats.telegraphTicks);
    expect(countBullets(s)).toBe(1);
  });

  it('держит дистанцию, а не идёт в упор', () => {
    const s = arena();
    const e = spawnEnemy(s, EnemyType.Brick, fromInt(CX + 900), fromInt(CY));
    run(s, 180);
    const distance = toFloat(s.eX[e]) - CX;
    expect(distance).toBeGreaterThan(200);
    expect(distance).toBeLessThan(560);
  });
});

describe('Фитиль', () => {
  it('поджигает фитиль на дистанции подрыва и взрывается', () => {
    const s = arena();
    const e = spawnEnemy(s, EnemyType.Fuse, fromInt(CX + 400), fromInt(CY));

    while (s.ePhase[e] !== EnemyPhase.Telegraph) run(s, 1);
    const distance = toFloat(s.eX[e]) - CX;
    expect(distance).toBeLessThanOrEqual(toFloat(FUSE.igniteRange) + 1);

    // Точка невозврата: после поджога взрыв случается сам.
    run(s, ENEMIES[EnemyType.Fuse].telegraphTicks + 2);
    expect(s.eActive[e]).toBe(0);
    expect(s.pHearts[0]).toBeLessThan(3);
  });

  /**
   * Дружественный урон единственный во всей игре и оставлен намеренно: на нём
   * стоит пари «Подрывник» (GDD §9.5). Взрыв обязан убивать Клина и не
   * убивать Кирпича — иначе подрыв перестаёт быть приёмом и становится
   * заменой стрельбе.
   */
  it('взрыв задевает своих: убивает Клина, но не Кирпича', () => {
    const s = arena();
    const wedge = spawnEnemy(s, EnemyType.Wedge, fromInt(CX + 400), fromInt(CY + 60));
    const brick = spawnEnemy(s, EnemyType.Brick, fromInt(CX + 400), fromInt(CY - 60));

    // Взрываем в точке напрямую, а не сводим Фитиль с ними в бою: расталкивание
    // за восемь десятых секунды горения растащит их куда угодно, и тест начнёт
    // проверять уже не урон по своим, а траектории. Правило же в другом —
    // двадцать пять очков убивают Клина (20) и не убивают Кирпича (30).
    explode(s, fromInt(CX + 400), fromInt(CY), -1);

    expect(s.eActive[wedge]).toBe(0);
    expect(s.eActive[brick]).toBe(1);
    expect(s.eHP[brick]).toBe(ENEMIES[EnemyType.Brick].hp - FUSE.blastDamage);
  });

  it('ударная волна отбрасывает игрока кувырком', () => {
    const s = arena();
    spawnEnemy(s, EnemyType.Fuse, fromInt(CX + 200), fromInt(CY));
    const x0 = s.pX[0];
    while (s.pHearts[0] === 3) run(s, 1);
    run(s, 6);
    // Отброшен и потерял управление: кувырок — унижение, а не наказание.
    expect(s.pRagdollUntil[0]).toBeGreaterThan(s.tick);
    expect(Math.abs(s.pX[0] - x0)).toBeGreaterThan(0);
  });
});

describe('навигация', () => {
  /**
   * Колонна — укрытие, а не ловушка для врага.
   *
   * До поля потока Клин шёл на игрока по прямой, упирался в колонну и стоял
   * там, объявляя таран сквозь неё раз за разом: со стороны — враг, который
   * бесконечно бодает стену. Проверяем не «дошёл», а «сократил дистанцию»:
   * дойти вплотную ему мешает своя же дистанция разгона.
   */
  it('враг обходит колонну, а не упирается в неё', () => {
    const s = arena();
    // Колонна из COLUMNS стоит в (480, 300). Ставим игрока и врага по разные
    // стороны от неё, ровно на одной линии — прямая перекрыта целиком.
    s.pX[0] = fromInt(480);
    s.pY[0] = fromInt(120);
    const e = spawnEnemy(s, EnemyType.Wedge, fromInt(480), fromInt(520));

    const before = Math.hypot(toFloat(s.eX[e]) - 480, toFloat(s.eY[e]) - 120);
    run(s, 240);
    const after = Math.hypot(
      toFloat(s.eX[e]) - toFloat(s.pX[0]),
      toFloat(s.eY[e]) - toFloat(s.pY[0]),
    );

    expect(
      after,
      `не приблизился: было ${before.toFixed(0)}, стало ${after.toFixed(0)}`,
    ).toBeLessThan(before - 100);
  });

  it('не объявляет таран сквозь колонну', () => {
    const s = arena();
    // Раскладка закреплена: тест проверяет правило НА геометрии, и колонна
    // обязана стоять там, где он её ищет. С двенадцатью шаблонами она иначе
    // переезжает вместе с комнатой, и проверка начинает мерить удачу броска.
    setArena(s, 0, 0);
    s.pX[0] = fromInt(480);
    s.pY[0] = fromInt(120);
    // Ставим врага вплотную за колонной: дистанция в коридоре прицеливания,
    // но путь перекрыт — телеграфа быть не должно.
    const e = spawnEnemy(s, EnemyType.Wedge, fromInt(480), fromInt(480));

    for (let t = 0; t < 20; t++) {
      run(s, 1);
      const inLine = Math.abs(toFloat(s.eX[e]) - 480) < 60;
      if (inLine && s.ePhase[e] === EnemyPhase.Telegraph) {
        // Разрешено только если он уже обошёл и колонны между ними нет.
        expect(toFloat(s.eY[e]), 'объявил таран сквозь колонну').toBeLessThan(240);
      }
    }
  });
});

describe('правила честности', () => {
  /**
   * Враг, появившийся в упор, отнимает сердце без единого решения игрока.
   * Проверяем каждый выпуск за длинный прогон, а не выборочно.
   */
  it('ни один враг не появляется ближе 250 u от игрока', () => {
    for (const players of [1, 4]) {
      const s = createState(11, players);
      spawnPlayers(s);
      const bot = makeBot('random', 11, players);
      const wasActive = new Uint8Array(MAX_ENEMIES);
      const minAllowed = toFloat(FAIRNESS.minSpawnDistance);

      for (let t = 0; t < 4000; t++) {
        step(s, bot.inputs(s));
        for (let i = 0; i < MAX_ENEMIES; i++) {
          if (s.eActive[i] && !wasActive[i]) {
            for (let p = 0; p < s.playerCount; p++) {
              const d = Math.hypot(
                toFloat(s.eX[i]) - toFloat(s.pX[p]),
                toFloat(s.eY[i]) - toFloat(s.pY[p]),
              );
              expect(d).toBeGreaterThanOrEqual(minAllowed - 1);
            }
          }
          wasActive[i] = s.eActive[i];
        }
      }
    }
  });

  /**
   * Потолок телеграфов проверяется в момент ОБЪЯВЛЕНИЯ: коридор задан один
   * раз и дальше не меняется, а игрок волен вбежать в него сам. Ставим
   * шестерых Клинов в упор к одной точке и смотрим, сколько объявят атаку.
   */
  it('на игрока не объявляют больше трёх атак разом', () => {
    const s = arena();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      spawnEnemy(
        s,
        EnemyType.Wedge,
        fromInt(Math.round(CX + Math.cos(a) * 300)),
        fromInt(Math.round(CY + Math.sin(a) * 300)),
      );
    }

    for (let t = 0; t < 600; t++) {
      step(s, idle(1));
      let declared = 0;
      for (let i = 0; i < MAX_ENEMIES; i++) {
        if (s.eActive[i] && s.ePhase[i] === EnemyPhase.Telegraph) declared++;
      }
      // Игрок стоит на месте, поэтому «объявлено» и «накрывает игрока»
      // здесь одно и то же: сам он ни в один коридор не вбегает.
      expect(declared).toBeLessThanOrEqual(FAIRNESS.maxTelegraphsPerPlayer);
    }
  });

  it('первый враг нового типа приходит один и с растянутым телеграфом', () => {
    const s = createState(5, 1);
    spawnPlayers(s);

    // Ждём первого выпуска: он обязан быть единственным.
    while (countEnemies(s) === 0) step(s, idle(1));
    expect(countEnemies(s)).toBe(1);

    const e = firstEnemy(s);
    while (s.ePhase[e] !== EnemyPhase.Telegraph) step(s, idle(1));
    const declaredAt = s.tick;
    while (s.ePhase[e] === EnemyPhase.Telegraph) step(s, idle(1));

    const base = ENEMIES[s.eType[e]].telegraphTicks;
    const expected = Math.trunc((base * FAIRNESS.noviceTelegraphPct) / 100);
    expect(s.tick - declaredAt).toBeGreaterThanOrEqual(expected);
  });

  it('врагов на арене не больше потолка читаемости', () => {
    for (const players of [1, 4]) {
      const s = createState(2, players);
      spawnPlayers(s);
      const bot = makeBot('random', 2, players);
      const cap = 40 + 15 * (players - 1);
      for (let t = 0; t < 3000; t++) {
        step(s, bot.inputs(s));
        expect(countEnemies(s)).toBeLessThanOrEqual(cap);
      }
    }
  });
});

describe('волны', () => {
  it('бюджет угрозы растёт по формуле из DIFFICULTY §4', () => {
    // T(F, R, N) = 300 × (1 + 0.08(R−1)) × (1 + 0.8(N−1)), этаж пока первый.
    expect(roomBudget(1, 1)).toBe(300);
    expect(roomBudget(8, 1)).toBe(468);
    expect(roomBudget(1, 4)).toBe(1020);
  });

  /**
   * Зачищенная комната доводит забег до выбора двери.
   *
   * Раньше здесь проверялось, что комната сразу сменяется следующей. С 0.4.0
   * между ними стоит экран, который ждёт игрока, — и «комната сменилась сама»
   * стало бы признаком того, что дверь решает за него.
   */
  it('зачищенная комната доводит до выбора двери', () => {
    const s = createState(9, 1);
    spawnPlayers(s);
    // Убираем всё, что выпускают волны, сразу: это заменяет идеального
    // стрелка и позволяет проверить сам ход комнат за разумное время.
    for (let t = 0; t < 4000 && s.meta[Meta.Phase] !== RunPhase.Door; t++) {
      step(s, idle(1));
      for (let i = 0; i < MAX_ENEMIES; i++) if (s.eActive[i]) s.eHP[i] = 1;
      for (let i = 0; i < MAX_ENEMIES; i++) if (s.eActive[i]) s.eActive[i] = 0;
    }
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Door);
    expect(s.meta[Meta.Room]).toBe(1);
  });
});

function countEnemies(s: SimState): number {
  let n = 0;
  for (let i = 0; i < MAX_ENEMIES; i++) if (s.eActive[i]) n++;
  return n;
}

function firstEnemy(s: SimState): number {
  for (let i = 0; i < MAX_ENEMIES; i++) if (s.eActive[i]) return i;
  return -1;
}

function countBullets(s: SimState): number {
  let n = 0;
  for (let i = 0; i < MAX_BULLETS; i++) if (s.bActive[i]) n++;
  return n;
}

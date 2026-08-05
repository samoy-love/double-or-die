/**
 * Рулетка: фазы, шары, проваливающиеся секторы и встречная ставка.
 *
 * Бой с боссом — единственное место игры, где ставку заключает не игрок, и
 * единственное, где сердце отнимает пол, а не удар. Оба правила проверяются
 * здесь, потому что оба легко потерять правкой, которая выглядит косметической.
 */

import { describe, expect, it } from 'vitest';
import {
  BALL,
  BOSS,
  FLOORS_PER_RUN,
  MAX_BALLS,
  Meta,
  PLAYER,
  ROOMS_PER_FLOOR,
  RunPhase,
  SECTOR_COUNT,
  WAVE,
  bossInPlay,
  bossRoomBudget,
  bossStunned,
  counterBetRunning,
  createState,
  hitsColumn,
  damageBoss,
  fallenSector,
  makeFrame,
  roomBudget,
  sectorAngle,
  sectorAt,
  setSpawning,
  spawnPlayers,
  startBoss,
  step,
  toFloat,
  wheelRadius,
  wheelX,
  wheelY,
  type SimState,
} from '@dod/sim';
import { checkSafety } from '@dod/tools/safety';

const idle = [makeFrame(), makeFrame(), makeFrame(), makeFrame()];

/** Забег на пороге боссовой комнаты: восьмая комната зачищена, босс выходит. */
function atBoss(players = 1, floor = 1): SimState {
  const s = createState(1, players);
  spawnPlayers(s);
  setSpawning(s, false);
  s.meta[Meta.Floor] = floor;
  s.meta[Meta.Phase] = RunPhase.Boss;
  s.meta[Meta.Room] = ROOMS_PER_FLOOR;
  s.meta[Meta.RoomThreat] = bossRoomBudget(floor, players);
  startBoss(s);
  return s;
}

const tick = (s: SimState, n = 1): void => {
  for (let i = 0; i < n; i++) step(s, idle.slice(0, s.playerCount));
};

/** Сбить прочность до доли запаса и дать бою заметить это. */
function bringTo(s: SimState, pct: number): void {
  const want = Math.trunc((s.meta[Meta.BossMaxHP] * pct) / 100);
  damageBoss(s, s.meta[Meta.BossHP] - want);
  tick(s);
}

describe('запас прочности', () => {
  it('растёт по этажу числами DIFFICULTY §8', () => {
    expect(atBoss(1, 1).meta[Meta.BossMaxHP]).toBe(1600);
    expect(atBoss(1, 2).meta[Meta.BossMaxHP]).toBe(2100);
    expect(atBoss(1, 3).meta[Meta.BossMaxHP]).toBe(3250);
  });

  it('масштабируется составом как волны: ×(1 + 0.8(N−1))', () => {
    expect(atBoss(2).meta[Meta.BossMaxHP]).toBe(Math.trunc(1600 * 1.8));
    expect(atBoss(4).meta[Meta.BossMaxHP]).toBe(Math.trunc(1600 * 3.4));
  });

  it('бюджет угрозы боссовой комнаты — половина восьмой', () => {
    expect(bossRoomBudget(1, 1)).toBe(Math.trunc(roomBudget(ROOMS_PER_FLOOR, 1, 1) / 2));
    expect(atBoss().meta[Meta.WaveBudget]).toBe(bossRoomBudget(1, 1));
  });
});

describe('фазы', () => {
  it('первая держится, пока полоса выше 70%', () => {
    const s = atBoss();
    bringTo(s, 71);
    expect(s.meta[Meta.BossPhase]).toBe(1);
  });

  it('вторая начинается на 70% и объявляет встречную ставку', () => {
    const s = atBoss();
    bringTo(s, BOSS.phaseTwoPct);
    expect(s.meta[Meta.BossPhase]).toBe(2);
    expect(counterBetRunning(s)).toBe(true);
  });

  it('третья начинается на 35% и выводит три шара', () => {
    const s = atBoss();
    bringTo(s, BOSS.phaseThreePct);
    expect(s.meta[Meta.BossPhase]).toBe(3);
    let balls = 0;
    for (let i = 0; i < MAX_BALLS; i++) if (s.ballActive[i]) balls++;
    expect(balls).toBe(MAX_BALLS);
  });

  it('удар через порог не проглатывает встречную ставку', () => {
    const s = atBoss();
    bringTo(s, 10);
    expect(s.meta[Meta.BossPhase]).toBe(3);
    // Ставка объявлена на входе во вторую фазу, даже если её проскочили в один
    // удар: обещание «один раз за бой» — это про один раз, а не про ноль.
    expect(s.meta[Meta.CounterBetUntil]).not.toBe(0);
  });

  it('фазы не откатываются лечением', () => {
    const s = atBoss();
    bringTo(s, BOSS.phaseTwoPct);
    s.meta[Meta.BossHP] = s.meta[Meta.BossMaxHP];
    tick(s);
    expect(s.meta[Meta.BossPhase]).toBe(2);
  });
});

describe('встречная ставка', () => {
  it('выиграл босс — лечится на 15% запаса', () => {
    const s = atBoss();
    bringTo(s, 50);
    const before = s.meta[Meta.BossHP];
    tick(s, BOSS.counterBetTicks + 1);
    expect(counterBetRunning(s)).toBe(false);
    expect(s.meta[Meta.BossHP]).toBe(before + Math.trunc(s.meta[Meta.BossMaxHP] * 0.15));
  });

  it('лечение не поднимает полосу выше потолка', () => {
    const s = atBoss();
    bringTo(s, 50);
    s.meta[Meta.BossHP] = s.meta[Meta.BossMaxHP];
    tick(s, BOSS.counterBetTicks + 1);
    expect(s.meta[Meta.BossHP]).toBe(s.meta[Meta.BossMaxHP]);
  });

  it('сорвал игрок — босс оглушён на четыре секунды и не лечится', () => {
    const s = atBoss();
    bringTo(s, 50);
    const after = s.meta[Meta.BossHP];
    damageBoss(s, 10);
    tick(s);
    expect(bossStunned(s)).toBe(true);
    expect(s.meta[Meta.BossHP]).toBe(after - 10);

    tick(s, BOSS.stunTicks);
    expect(bossStunned(s)).toBe(false);
    // Сорванная ставка не воскресает: она объявляется один раз за бой.
    expect(counterBetRunning(s)).toBe(false);
  });

  it('оглушённый босс не бьёт шарами', () => {
    const s = atBoss();
    bringTo(s, 50);
    damageBoss(s, 10);
    tick(s);
    const landAt = s.ballLandAt[0];
    tick(s, 10);
    expect(s.ballLandAt[0]).toBe(landAt + 10);
  });

  it('в статистику пари не идёт и слота не занимает', () => {
    const s = atBoss();
    bringTo(s, 50);
    tick(s, BOSS.counterBetTicks + 1);
    expect(s.meta[Meta.BetsTaken]).toBe(0);
    expect(s.meta[Meta.BetsWon]).toBe(0);
    expect(s.meta[Meta.BetsLost]).toBe(0);
  });
});

describe('колесо', () => {
  it('вращается разметка, а не геометрия', () => {
    const s = atBoss();
    const x = add(wheelX(s), 300 * 65536);
    const y = wheelY(s);
    const before = sectorAt(s, x, y);
    const px = s.pX[0];
    const py = s.pY[0];

    tick(s, 60);
    expect(sectorAt(s, x, y)).not.toBe(before);
    // Тело на полу вращение не переносит: игрок стоит там, где стоял.
    expect(s.pX[0]).toBe(px);
    expect(s.pY[0]).toBe(py);
  });

  it('секторов двенадцать и они покрывают круг без дыр', () => {
    const s = atBoss();
    const seen = new Set<number>();
    for (let i = 0; i < SECTOR_COUNT; i++) {
      const a = sectorAngle(s, i);
      const r = toFloat(wheelRadius(s)) / 2;
      seen.add(sectorAt(s, add(wheelX(s), rotX(a, r)), add(wheelY(s), rotY(a, r))));
    }
    expect(seen.size).toBe(SECTOR_COUNT);
  });
});

describe('шар', () => {
  it('ударная волна отбрасывает с кувырком и не отнимает сердце', () => {
    const s = atBoss();
    // Встать вплотную к месту, куда шар сядет.
    const a = sectorAngle(s, s.ballSector[0]);
    const r = toFloat(wheelRadius(s)) - toFloat(BALL.radius);
    s.pX[0] = add(wheelX(s), rotX(a, r));
    s.pY[0] = add(wheelY(s), rotY(a, r));

    tick(s, BALL.jumpTicks + 1);
    expect(s.pHearts[0]).toBe(PLAYER.startHearts);
    expect(s.pRagdollUntil[0]).toBeGreaterThan(s.tick);
  });
});

describe('проваливающийся сектор', () => {
  /** Поставить игрока в середину названного сектора, на половине радиуса. */
  function standIn(s: SimState, sector: number): void {
    const a = sectorAngle(s, sector);
    const r = toFloat(wheelRadius(s)) / 2;
    s.pX[0] = add(wheelX(s), rotX(a, r));
    s.pY[0] = add(wheelY(s), rotY(a, r));
  }

  it('появляется в третьей фазе, по одному за раз', () => {
    const s = atBoss();
    bringTo(s, BOSS.phaseThreePct);
    tick(s, BOSS.sectorTelegraphTicks + 1);
    expect(fallenSector(s)).toBeGreaterThanOrEqual(0);

    let open = 0;
    for (let i = 0; i < SECTOR_COUNT; i++) if (s.sectorFallAt[i] !== 0) open++;
    expect(open).toBe(1);
  });

  it('отнимает сердце и выталкивает, но не убивает', () => {
    const s = atBoss();
    bringTo(s, BOSS.phaseThreePct);
    tick(s, BOSS.sectorTelegraphTicks + 1);

    const sector = fallenSector(s);
    standIn(s, sector);
    tick(s);

    expect(s.pHearts[0]).toBe(PLAYER.startHearts - 1);
    expect(s.pFlags[0] & 1).toBe(1);
    expect(s.pRagdollUntil[0]).toBeGreaterThan(s.tick);
  });

  it('держится три секунды и возвращается', () => {
    const s = atBoss();
    bringTo(s, BOSS.phaseThreePct);
    tick(s, BOSS.sectorTelegraphTicks + 1);
    const sector = fallenSector(s);

    tick(s, BOSS.sectorHoldTicks);
    expect(fallenSector(s)).not.toBe(sector);
  });
});

describe('победа', () => {
  it('платит 40 × этаж фишек и считает босса', () => {
    const s = atBoss(1, 2);
    const chips = s.pChips[0];
    damageBoss(s, s.meta[Meta.BossHP]);
    tick(s);

    expect(bossInPlay(s)).toBe(false);
    expect(s.meta[Meta.BossesBeaten]).toBe(1);
    expect(s.pChips[0]).toBe(chips + BOSS.rewardPerFloor * 2);
  });

  it('после босса идёт следующий этаж', () => {
    const s = atBoss(1, 1);
    setSpawning(s, true);
    damageBoss(s, s.meta[Meta.BossHP]);
    tick(s, 3);

    expect(s.meta[Meta.Floor]).toBe(2);
    expect(s.meta[Meta.Room]).toBe(1);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Fight);
  });

  it('после босса третьего этажа забег кончается победой', () => {
    const s = atBoss(1, FLOORS_PER_RUN);
    setSpawning(s, true);
    damageBoss(s, s.meta[Meta.BossHP]);
    tick(s, 3);

    expect(s.meta[Meta.Phase]).toBe(RunPhase.Summary);
    expect(s.meta[Meta.Victory]).toBe(1);
    // Три ключа за босса считает keysEarned — здесь проверяется, что счёт
    // боссов до неё доехал.
    expect(s.meta[Meta.Keys]).toBeGreaterThanOrEqual(3);
  });
});

describe('честность', () => {
  it('на боссовой арене нет колонн', () => {
    const s = atBoss();
    // Центр колеса свободен: в обычной комнате там ничего и не стоит, а вот
    // четыре угловые колонны накрыли бы обод.
    expect(hitsAnyColumn(s)).toBe(false);
  });

  it('безопасная точка достижима во всех фазах', () => {
    const s = atBoss();
    for (let n = 0; n < 600; n++) {
      tick(s);
      expect(checkSafety(s)).toBeNull();
    }
    bringTo(s, BOSS.phaseThreePct);
    for (let n = 0; n < 600; n++) {
      tick(s);
      expect(checkSafety(s)).toBeNull();
    }
  });
});

// --- мелкая арифметика для проверок ---

const add = (a: number, b: number): number => (a + b) | 0;

/**
 * Точка на луче под углом `angle` в единицах угла ядра.
 *
 * Считается обычной тригонометрией, а не таблицей ядра: проверка стоит
 * СНАРУЖИ симуляции, и повторять её таблицу значило бы проверять таблицу
 * саму собой. Точности хватает с запасом — сектор шириной тридцать градусов.
 */
function rotX(angle: number, radius: number): number {
  return Math.round(Math.cos((angle * Math.PI * 2) / 4096) * radius * 65536) | 0;
}
function rotY(angle: number, radius: number): number {
  return Math.round(Math.sin((angle * Math.PI * 2) / 4096) * radius * 65536) | 0;
}

/** Стоит ли хоть одна колонна на колесе. */
function hitsAnyColumn(s: SimState): boolean {
  for (let a = 0; a < 4096; a += 40) {
    for (let k = 1; k <= 4; k++) {
      const r = (toFloat(wheelRadius(s)) * k) / 4;
      const x = add(wheelX(s), rotX(a, r));
      const y = add(wheelY(s), rotY(a, r));
      if (hitsColumn(s, x, y, PLAYER.radius)) return true;
    }
  }
  return false;
}

/** Число волн комнаты видно и здесь: боссовая держит его на последней. */
it('боссовая комната не назначает себе новых волн', () => {
  const s = atBoss();
  expect(s.meta[Meta.Wave]).toBe(WAVE.wavesPerRoom);
  expect(s.meta[Meta.NextWaveAt]).toBe(0);
});

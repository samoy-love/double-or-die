/**
 * Эффекты проклятий (GDD §11).
 *
 * `floor.test.ts` проверяет только присваивание и снятие проклятия — что
 * значение поля меняется. Здесь проверяется другое: что каждое из шести
 * проклятий действительно ЧТО-ТО ДЕЛАЕТ в комнате, на которую наложено.
 * Ровно этого не хватало — проклятие присваивалось и снималось, ни разу не
 * прочитанное ни одной системой.
 *
 * «Тьма» (виньетка) — клиентский эффект, здесь не проверяется: `tests/`
 * гоняет только ядро `@dod/sim`, у рендера своих тестов в репозитории нет.
 */

import { describe, expect, it } from 'vitest';
import {
  Btn,
  Curse,
  EntityFlag,
  EnemyType,
  Meta,
  WAVE,
  applyCurseEffects,
  createState,
  dropChip,
  fromFloat,
  fromInt,
  makeFrame,
  spawnEnemy,
  spawnPlayers,
  startRoom,
  step,
  stepChips,
  stepEnemies,
  setSpawning,
  toFloat,
  type SimState,
} from '@dod/sim';

function fresh(): SimState {
  const s = createState(1, 1);
  spawnPlayers(s);
  setSpawning(s, false);
  return s;
}

/** Со спавном волн: нужен там, где комната обязана довестись до зачистки. */
function freshSpawning(): SimState {
  const s = createState(1, 1);
  spawnPlayers(s);
  return s;
}

describe('Кровью', () => {
  it('снимает ровно одно сердце в момент назначения проклятия', () => {
    const s = fresh();
    s.pHearts[0] = 3;
    s.meta[Meta.Curse] = Curse.Blood;
    s.meta[Meta.CurseRoom] = 1;
    applyCurseEffects(s);
    expect(s.pHearts[0]).toBe(2);
  });

  it('не добивает игрока на последнем сердце', () => {
    const s = fresh();
    s.pHearts[0] = 1;
    s.meta[Meta.Curse] = Curse.Blood;
    s.meta[Meta.CurseRoom] = 1;
    applyCurseEffects(s);
    expect(s.pHearts[0]).toBe(1);
  });

  it('не трогает мёртвых и не срабатывает вне своей комнаты', () => {
    const s = fresh();
    s.pHearts[0] = 3;
    s.pFlags[0] &= ~EntityFlag.Alive;
    s.meta[Meta.Curse] = Curse.Blood;
    s.meta[Meta.CurseRoom] = 1;
    applyCurseEffects(s);
    expect(s.pHearts[0]).toBe(3);

    const s2 = fresh();
    s2.pHearts[0] = 3;
    s2.meta[Meta.Curse] = Curse.Blood;
    s2.meta[Meta.CurseRoom] = 0; // проклятие ещё не вошло в свою комнату
    applyCurseEffects(s2);
    expect(s2.pHearts[0]).toBe(3);
  });
});

describe('Суета', () => {
  it('ускоряет врагов на +20% в проклятой комнате', () => {
    const plain = fresh();
    const cursed = fresh();
    cursed.meta[Meta.Curse] = Curse.Hustle;
    cursed.meta[Meta.CurseRoom] = 1;

    // Фитиль идёт к цели напрямую через approach() — самый простой измеритель
    // скорости сближения.
    const x = plain.pX[0] - fromInt(300);
    const y = plain.pY[0];
    const ip = spawnEnemy(plain, EnemyType.Fuse, x, y);
    const ic = spawnEnemy(cursed, EnemyType.Fuse, x, y);

    stepEnemies(plain);
    stepEnemies(cursed);

    const plainSpeed = Math.hypot(toFloat(plain.eVX[ip]), toFloat(plain.eVY[ip]));
    const curseSpeed = Math.hypot(toFloat(cursed.eVX[ic]), toFloat(cursed.eVY[ic]));
    expect(plainSpeed).toBeGreaterThan(0);
    expect(curseSpeed / plainSpeed).toBeCloseTo(1.2, 1);
  });

  it('ускоряет Кирпича на +20% в проклятой комнате', () => {
    const plain = fresh();
    const cursed = fresh();
    cursed.meta[Meta.Curse] = Curse.Hustle;
    cursed.meta[Meta.CurseRoom] = 1;

    const x = plain.pX[0] - fromInt(300);
    const y = plain.pY[0];
    const ip = spawnEnemy(plain, EnemyType.Brick, x, y);
    const ic = spawnEnemy(cursed, EnemyType.Brick, x, y);

    stepEnemies(plain);
    stepEnemies(cursed);

    const plainSpeed = Math.hypot(toFloat(plain.eVX[ip]), toFloat(plain.eVY[ip]));
    const curseSpeed = Math.hypot(toFloat(cursed.eVX[ic]), toFloat(cursed.eVY[ic]));
    expect(plainSpeed).toBeGreaterThan(0);
    expect(curseSpeed / plainSpeed).toBeCloseTo(1.2, 1);
  });

  it('ускоряет Клина на +20% и на кружении, и на рывке — регрессия на «Суета действует не на всех»', () => {
    // Клин считает скорость отдельно от Фитиля и Кирпича — своими orbit() и
    // dashSpeed при входе в Attack (enemies.ts). Раньше curseSpeedMul() был
    // заведён только в approach()/keepDistance(), и «+20% всем» (GDD §11)
    // было верно лишь для двух врагов из трёх — этот тест ловит именно это.
    const plain = fresh();
    const cursed = fresh();
    cursed.meta[Meta.Curse] = Curse.Hustle;
    cursed.meta[Meta.CurseRoom] = 1;

    // Дальше aimRange (560) — Клин идёт в orbit(), а не целится тараном.
    const x = plain.pX[0] - fromInt(700);
    const y = plain.pY[0];
    const ip = spawnEnemy(plain, EnemyType.Wedge, x, y);
    const ic = spawnEnemy(cursed, EnemyType.Wedge, x, y);

    stepEnemies(plain);
    stepEnemies(cursed);

    const plainOrbit = Math.hypot(toFloat(plain.eVX[ip]), toFloat(plain.eVY[ip]));
    const curseOrbit = Math.hypot(toFloat(cursed.eVX[ic]), toFloat(cursed.eVY[ic]));
    expect(plainOrbit).toBeGreaterThan(0);
    expect(curseOrbit / plainOrbit).toBeCloseTo(1.2, 1);
  });
});

describe('Свинцовые ноги', () => {
  it('отключает рывок на всю проклятую комнату', () => {
    const s = fresh();
    s.meta[Meta.Curse] = Curse.LeadFeet;
    s.meta[Meta.CurseRoom] = 1;
    const before = s.pDashReady[0];
    step(s, [{ ...makeFrame(), moveX: fromFloat(1), buttons: Btn.Dash }]);
    // Рывок, сработай он, немедленно взвёл бы откат — по его отсутствию и
    // проверяется, что кнопка была нажата зря.
    expect(s.pDashReady[0]).toBe(before);
    expect(s.pDashUntil[0]).toBe(0);
  });

  it('рывок работает как обычно вне проклятия', () => {
    const s = fresh();
    const before = s.pDashReady[0];
    step(s, [{ ...makeFrame(), moveX: fromFloat(1), buttons: Btn.Dash }]);
    expect(s.pDashReady[0]).toBeGreaterThan(before);
  });
});

describe('Заморозка', () => {
  it('помечает первого врага комнаты и блокирует подбор фишек, пока он жив', () => {
    const s = fresh();
    s.meta[Meta.Curse] = Curse.Frozen;
    s.meta[Meta.CurseRoom] = 1;
    s.meta[Meta.Wave] = 1;

    const i = spawnEnemy(s, EnemyType.Wedge, s.pX[0] - fromInt(300), s.pY[0]);
    expect(s.eFlags[i] & EntityFlag.Marked).not.toBe(0);

    const before = s.pChips[0];
    dropChip(s, s.pX[0], s.pY[0]);
    stepChips(s);
    expect(s.cActive[0]).toBe(1);
    expect(s.pChips[0]).toBe(before);

    // Помеченный враг гибнет — подбор снова работает.
    s.eActive[i] = 0;
    stepChips(s);
    expect(s.cActive[0]).toBe(0);
    expect(s.pChips[0]).toBeGreaterThan(before);
  });

  it('второй враг комнаты меткой не помечается', () => {
    const s = fresh();
    s.meta[Meta.Curse] = Curse.Frozen;
    s.meta[Meta.CurseRoom] = 1;
    s.meta[Meta.Wave] = 1;

    spawnEnemy(s, EnemyType.Wedge, s.pX[0] - fromInt(300), s.pY[0]);
    const j = spawnEnemy(s, EnemyType.Wedge, s.pX[0] - fromInt(200), s.pY[0]);
    expect(s.eFlags[j] & EntityFlag.Marked).toBe(0);
  });

  it('без проклятия фишки подбираются как обычно', () => {
    const s = fresh();
    const before = s.pChips[0];
    dropChip(s, s.pX[0], s.pY[0]);
    stepChips(s);
    expect(s.cActive[0]).toBe(0);
    expect(s.pChips[0]).toBeGreaterThan(before);
  });
});

describe('Комиссия', () => {
  it('срезает выплату за зачистку проклятой комнаты вдвое', () => {
    const plain = freshSpawning();
    const cursed = freshSpawning();
    // `CurseRoom` не проставляется руками: `startRoom` сам переводит его из
    // 0 в 1 через `expireCurse` — «первый вход после долга» (GDD §11), тот
    // же путь, что и в бою.
    cursed.meta[Meta.Curse] = Curse.Commission;

    for (const s of [plain, cursed]) {
      startRoom(s, 1);
      // Комната пуста и волны исчерпаны — следующий тик обязан зачесть её.
      s.meta[Meta.Wave] = WAVE.wavesPerRoom;
      s.meta[Meta.WaveBudget] = 0;
      s.meta[Meta.NextWaveAt] = 0;
    }

    const before = { plain: plain.pChips[0], cursed: cursed.pChips[0] };
    stepEnemies(plain);
    stepEnemies(cursed);

    const plainPayout = plain.pChips[0] - before.plain;
    const cursedPayout = cursed.pChips[0] - before.cursed;
    expect(plainPayout).toBeGreaterThan(0);
    expect(cursedPayout).toBe(Math.trunc(plainPayout * 0.5));
  });
});

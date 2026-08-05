/**
 * Бой: стрельба, попадания, неуязвимость рывка, фишки.
 *
 * Главная проверка файла — «рывок действительно спасает». Рывок объявлен
 * главным инструментом выживания (GDD §6), из этого выведена цена пари «без
 * рывка», а из неё — часть экономики. Сломается неуязвимость — сломается
 * цепочка целиком, и заметить это по коду невозможно, только замером.
 */

import { describe, expect, it } from 'vitest';
import {
  Btn,
  DASH_INVUL_TICKS,
  ENEMY_OWNER,
  EnemyType,
  EntityFlag,
  MAX_BULLETS,
  MAX_CHIPS,
  Meta,
  PISTOL,
  PLAYER,
  RunPhase,
  createSnapshot,
  createState,
  dropChip,
  fromInt,
  makeFrame,
  saveSnapshot,
  setSpawning,
  spawnBullet,
  spawnEnemy,
  spawnPlayers,
  step,
  toFloat,
  type InputFrame,
  type SimState,
} from '@dod/sim';

const CX = 960;
const CY = 540;

function arena(players = 1): SimState {
  const s = createState(1, players);
  spawnPlayers(s);
  setSpawning(s, false);
  return s;
}

const frame = (o: Partial<InputFrame> = {}): InputFrame[] => [{ ...makeFrame(), ...o }];

function run(s: SimState, ticks: number, inputs = frame()): void {
  for (let t = 0; t < ticks; t++) step(s, inputs);
}

function countBullets(s: SimState): number {
  let n = 0;
  for (let i = 0; i < MAX_BULLETS; i++) if (s.bActive[i]) n++;
  return n;
}

/** Снаряд, летящий в игрока слева направо и попадающий через ~20 тиков. */
function incoming(s: SimState): void {
  spawnBullet(
    s,
    fromInt(CX - 170),
    fromInt(CY),
    fromInt(1),
    0,
    PISTOL.bulletSpeed,
    ENEMY_OWNER,
    60,
  );
}

describe('стрельба', () => {
  it('темп держится заявленных 6.5 выстрелов в секунду', () => {
    const s = arena();
    // Целимся вверх, чтобы пуля улетала в пустоту и не гасла о врага.
    const held = frame({ aimY: fromInt(-1), buttons: Btn.Fire });
    let fired = 0;
    let prev = s.pShotAcc[0];
    for (let t = 0; t < 600; t++) {
      step(s, held);
      // Выстрел виден по тому, что накопленная доля сбросилась через целую.
      if (s.pShotAcc[0] < prev) fired++;
      prev = s.pShotAcc[0];
    }
    // За десять секунд — 65 выстрелов. Допуск в один: заряд может не успеть
    // накопиться на последнем тике.
    expect(fired).toBeGreaterThanOrEqual(64);
    expect(fired).toBeLessThanOrEqual(66);
  });

  /**
   * Одиночное нажатие обязано стрелять.
   *
   * Регрессия, найденная плейтестом: заряд копился с нуля только при зажатом
   * курке, и клик в три тика не давал выстрела вообще — игрок жал кнопку
   * впустую. В твин-стике это ощущается сломанным оружием.
   */
  it('одиночное нажатие даёт выстрел в тот же тик', () => {
    const s = arena();
    run(s, 1, frame({ aimY: fromInt(-1), buttons: Btn.Fire }));
    expect(countBullets(s)).toBe(1);
  });

  it('впрок копится не больше одного выстрела', () => {
    const s = arena();
    // Минута без стрельбы не должна превращаться в залп.
    run(s, 600, frame({ aimY: fromInt(-1) }));
    run(s, 1, frame({ aimY: fromInt(-1), buttons: Btn.Fire }));
    expect(countBullets(s)).toBe(1);
    // Следующий выстрел — только на своём такте, а не тут же.
    run(s, 1, frame({ aimY: fromInt(-1), buttons: Btn.Fire }));
    expect(countBullets(s)).toBe(1);
  });

  it('пуля убивает Клина за заявленное время', () => {
    const s = arena();
    const e = spawnEnemy(s, EnemyType.Wedge, fromInt(CX + 300), fromInt(CY));
    // Клин двигается, поэтому целимся по нему каждый тик.
    for (let t = 0; t < 120 && s.eActive[e]; t++) {
      const dx = toFloat(s.eX[e]) - toFloat(s.pX[0]);
      const dy = toFloat(s.eY[e]) - toFloat(s.pY[0]);
      const len = Math.hypot(dx, dy) || 1;
      step(
        s,
        frame({
          aimX: Math.round((dx / len) * 65536),
          aimY: Math.round((dy / len) * 65536),
          buttons: Btn.Fire,
        }),
      );
    }
    expect(s.eActive[e]).toBe(0);
    expect(s.meta[Meta.Kills]).toBe(1);
  });

  it('колонна гасит снаряд: за укрытием безопасно', () => {
    const s = arena();
    // Колонна стоит в (480, 300); стреляем в неё в упор сбоку.
    s.pX[0] = fromInt(480 - 200);
    s.pY[0] = fromInt(300);
    run(s, 40, frame({ aimX: fromInt(1), buttons: Btn.Fire }));
    // Ни один снаряд не пережил колонну: все погашены на подлёте.
    for (let i = 0; i < MAX_BULLETS; i++) {
      if (s.bActive[i]) expect(toFloat(s.bX[i])).toBeLessThan(480);
    }
  });
});

describe('неуязвимость рывка', () => {
  it('рывок проносит игрока сквозь снаряд', () => {
    const s = arena();
    incoming(s);
    // Рывок вбок: игрок остаётся на линии огня по X, но неуязвим.
    run(s, 1, frame({ buttons: Btn.Dash, aimX: fromInt(1) }));
    expect(s.pFlags[0] & EntityFlag.Invulnerable).toBeTruthy();
    run(s, DASH_INVUL_TICKS - 2);
    expect(s.pHearts[0]).toBe(3);
  });

  it('без рывка тот же снаряд отнимает сердце', () => {
    const s = arena();
    incoming(s);
    run(s, 30);
    expect(s.pHearts[0]).toBe(2);
  });

  it('после урона держится секунда неуязвимости', () => {
    const s = arena();
    incoming(s);
    run(s, 30);
    expect(s.pHearts[0]).toBe(2);
    // Второй снаряд в тот же промежуток не проходит.
    incoming(s);
    run(s, 30);
    expect(s.pHearts[0]).toBe(2);
    expect(s.pInvulUntil[0] - s.tick).toBeLessThanOrEqual(PLAYER.hurtInvulTicks);
  });

  it('прощающая коллизия: хитбокс меньше видимой формы', () => {
    const s = arena();
    // Снаряд идёт мимо на 21 единице от центра — между хитбоксом (18) и
    // видимым радиусом (22). Игрок обязан считать, что увернулся.
    const gap = 21 - toFloat(PISTOL.bulletRadius);
    spawnBullet(
      s,
      fromInt(CX - 170),
      fromInt(Math.round(CY - gap - toFloat(PLAYER.radius) - 1)),
      fromInt(1),
      0,
      PISTOL.bulletSpeed,
      ENEMY_OWNER,
      60,
    );
    run(s, 30);
    expect(s.pHearts[0]).toBe(3);
  });
});

describe('фишки', () => {
  it('подбираются наездом и попадают в кошелёк', () => {
    const s = arena();
    // От стартового капитала, а не от нуля: забег начинается с кошельком
    // (ECONOMY §4), иначе коны нулевые и ставки не включаются вовсе.
    const before = s.pChips[0];
    dropChip(s, fromInt(CX + 20), fromInt(CY));
    run(s, 4);
    expect(s.pChips[0] - before).toBe(1);
  });

  it('исчезают с пола за три секунды', () => {
    const s = arena();
    // Игрок в стороне, чтобы не подобрал.
    s.pX[0] = fromInt(200);
    s.pY[0] = fromInt(200);
    dropChip(s, fromInt(CX), fromInt(CY));
    run(s, 60);
    expect(countChips(s)).toBe(1);
    run(s, 130);
    expect(countChips(s)).toBe(0);
  });
});

describe('гибель и конец забега', () => {
  /**
   * Смерть кончает забег, а не начинает его заново.
   *
   * До 0.4.0 здесь проверялось обратное — что через три секунды игрок снова
   * жив, — и для версии без структуры это было верно: играть было не во что,
   * кроме бесконечной череды комнат. Забег, начинающийся сам, не имеет ни
   * итогов, ни ключей, ни причины вернуться, а ворота версии меряют именно
   * добровольность второго забега.
   */
  it('после гибели забег кончается итогами', () => {
    const s = arena();
    for (let n = 0; n < 3; n++) {
      incoming(s);
      run(s, PLAYER.hurtInvulTicks + 30);
    }
    expect(s.pFlags[0] & EntityFlag.Alive).toBeFalsy();
    expect(s.meta[Meta.RestartAt]).toBeGreaterThan(s.tick);
    // Пауза перед итогами осталась: мгновенный переход читается как сбой.
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Fight);

    run(s, 200);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Summary);
    expect(s.meta[Meta.Victory]).toBe(0);
    expect(s.meta[Meta.Deaths]).toBe(1);
    // Любой завершённый забег даёт минимум один ключ (ECONOMY §12).
    expect(s.meta[Meta.Keys]).toBeGreaterThanOrEqual(1);
  });

  it('после итогов мир стоит, а тик идёт', () => {
    const s = arena();
    for (let n = 0; n < 3; n++) {
      incoming(s);
      run(s, PLAYER.hurtInvulTicks + 30);
    }
    run(s, 200);
    expect(s.meta[Meta.Phase]).toBe(RunPhase.Summary);

    /*
     * Мир после конца обязан быть неподвижным: враги не доигрывают бой с
     * трупом, снаряды не летят, фишки не тлеют.
     *
     * Сравниваются буферы, а не `hashState`: в хеш входит номер тика, а тик
     * идёт и на экране итогов — время там тоже время. Хеш разошёлся бы
     * заведомо, ничего не сказав о самом мире.
     */
    const snap = createSnapshot(s);
    saveSnapshot(s, snap);
    const tick = s.tick;

    run(s, 120);

    expect(s.tick).toBe(tick + 120);
    const after = createSnapshot(s);
    saveSnapshot(s, after);
    for (let i = 0; i < snap.data.length; i++) {
      expect(Array.from(after.data[i])).toEqual(Array.from(snap.data[i]));
    }
  });
});

function countChips(s: SimState): number {
  let n = 0;
  for (let i = 0; i < MAX_CHIPS; i++) if (s.cActive[i]) n++;
  return n;
}

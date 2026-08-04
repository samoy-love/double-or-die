/**
 * Движение и рывок.
 *
 * Рывок — главный инструмент выживания, поэтому пари «без рывка» такое
 * дорогое (GDD §6). Если он не работает, вся экономика этого пари ломается,
 * а бой становится нечестным — но заметить это по коду невозможно, только
 * замером.
 */

import { describe, expect, it } from 'vitest';
import {
  Btn,
  EntityFlag,
  DASH_INVUL_TICKS,
  PLAYER,
  createState,
  fromFloat,
  makeFrame,
  spawnPlayers,
  step,
  toFloat,
  type InputFrame,
} from '@dod/sim';

function newRun(players = 1) {
  const s = createState(1, players);
  spawnPlayers(s);
  return s;
}

function frame(o: Partial<InputFrame> = {}): InputFrame[] {
  return [{ ...makeFrame(), ...o }];
}

function runTicks(s: ReturnType<typeof newRun>, n: number, inputs: InputFrame[]): void {
  for (let t = 0; t < n; t++) step(s, inputs);
}

describe('движение', () => {
  it('игрок идёт в заданном направлении', () => {
    const s = newRun();
    const x0 = s.pX[0];
    runTicks(s, 60, frame({ moveX: fromFloat(1) }));
    expect(s.pX[0]).toBeGreaterThan(x0);
  });

  it('диагональ не быстрее прямой', () => {
    const straight = newRun();
    runTicks(straight, 120, frame({ moveX: fromFloat(1) }));
    const dStraight = toFloat(straight.pX[0]) - toFloat(newRun().pX[0]);

    const diag = newRun();
    runTicks(diag, 120, frame({ moveX: fromFloat(1), moveY: fromFloat(1) }));
    const base = newRun();
    const dx = toFloat(diag.pX[0]) - toFloat(base.pX[0]);
    const dy = toFloat(diag.pY[0]) - toFloat(base.pY[0]);
    const dDiag = Math.hypot(dx, dy);

    // Без нормализации диагональ была бы в 1.41 раза быстрее — классическая
    // ошибка, которую видно только замером.
    expect(dDiag).toBeCloseTo(dStraight, 0);
  });

  it('игрок не выходит за арену', () => {
    const s = newRun();
    runTicks(s, 2000, frame({ moveX: fromFloat(1), moveY: fromFloat(1) }));
    expect(toFloat(s.pX[0])).toBeLessThan(1920);
    expect(toFloat(s.pY[0])).toBeLessThan(1080);
  });

  it('трение останавливает игрока после отпускания', () => {
    const s = newRun();
    runTicks(s, 60, frame({ moveX: fromFloat(1) }));
    const moving = s.pVX[0];
    expect(moving).toBeGreaterThan(0);

    runTicks(s, 120, frame());
    expect(Math.abs(s.pVX[0])).toBeLessThan(moving / 10);
  });
});

describe('рывок', () => {
  /**
   * Регрессия. Первая реализация вызывала tryDash и applyMovement в одном
   * тике: разгон выставлялся и тут же срезался ограничением скорости, и
   * рывок молча превращался в обычный шаг. Тесты этого не видели, потому
   * что «игрок сдвинулся» было правдой.
   */
  it('покрывает заметно больше расстояния, чем ходьба', () => {
    const walking = newRun();
    runTicks(walking, PLAYER.dashTicks, frame({ moveX: fromFloat(1) }));
    const walked = toFloat(walking.pX[0]);

    const dashing = newRun();
    step(dashing, frame({ moveX: fromFloat(1), buttons: Btn.Dash }));
    runTicks(dashing, PLAYER.dashTicks - 1, frame({ moveX: fromFloat(1) }));
    const dashed = toFloat(dashing.pX[0]);

    const start = toFloat(newRun().pX[0]);
    expect(dashed - start).toBeGreaterThan((walked - start) * 3);
  });

  it('даёт неуязвимость', () => {
    const s = newRun();
    step(s, frame({ moveX: fromFloat(1), buttons: Btn.Dash }));
    expect(s.pFlags[0] & EntityFlag.Invulnerable).toBeTruthy();
  });

  it('неуязвимость кончается вместе с окном', () => {
    const s = newRun();
    step(s, frame({ moveX: fromFloat(1), buttons: Btn.Dash }));
    runTicks(s, DASH_INVUL_TICKS + 2, frame());
    expect(s.pFlags[0] & EntityFlag.Invulnerable).toBeFalsy();
  });

  // Coyote-время: рывок, нажатый впритык, обязан спасать. Проверяется именно
  // хвост — тики ПОСЛЕ того, как движение рывка уже кончилось.
  it('держит неуязвимость ещё четыре тика после конца движения', () => {
    const s = newRun();
    step(s, frame({ moveX: fromFloat(1), buttons: Btn.Dash }));

    // Срок неуязвимости назначен от начала рывка и складывается из движения
    // и хвоста — это и есть смысл coyote-времени.
    expect(s.pInvulUntil[0]).toBe(PLAYER.dashTicks + PLAYER.dashCoyoteTicks);

    // Досматриваем ровно до конца ДВИЖЕНИЯ рывка: дальше игрок уже не летит.
    runTicks(s, PLAYER.dashTicks - 1, frame());
    expect(s.tick).toBe(PLAYER.dashTicks);
    expect(s.tick).toBeGreaterThanOrEqual(s.pDashUntil[0]);
    expect(s.pFlags[0] & EntityFlag.Invulnerable).toBeTruthy();

    // Хвост держится все четыре тика.
    runTicks(s, PLAYER.dashCoyoteTicks, frame());
    expect(s.pFlags[0] & EntityFlag.Invulnerable).toBeTruthy();

    // И кончается сразу после него, а не тянется дальше.
    runTicks(s, 1, frame());
    expect(s.pFlags[0] & EntityFlag.Invulnerable).toBeFalsy();
  });

  it('не срабатывает до конца перезарядки', () => {
    const s = newRun();
    step(s, frame({ moveX: fromFloat(1), buttons: Btn.Dash }));
    const readyAt = s.pDashReady[0];

    // Жмём рывок каждый тик — второй раз он не должен начаться раньше срока.
    runTicks(s, PLAYER.dashCooldownTicks - 2, frame({ moveX: fromFloat(1), buttons: Btn.Dash }));
    expect(s.pDashReady[0]).toBe(readyAt);

    runTicks(s, 4, frame({ moveX: fromFloat(1), buttons: Btn.Dash }));
    expect(s.pDashReady[0]).toBeGreaterThan(readyAt);
  });

  it('стоящий на месте рвётся в сторону прицела', () => {
    const s = newRun();
    const y0 = s.pY[0];
    // Прицел вниз, движения нет: иначе от снаряда не уйти.
    step(s, frame({ aimY: fromFloat(1), buttons: Btn.Dash }));
    runTicks(s, PLAYER.dashTicks - 1, frame({ aimY: fromFloat(1) }));
    expect(s.pY[0]).toBeGreaterThan(y0);
  });
});

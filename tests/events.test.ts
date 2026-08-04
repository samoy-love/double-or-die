/**
 * Журнал событий — то, по чему агент и баг-репорт понимают, что произошло.
 *
 * Проверяется здесь, а не глазами в браузере, потому что события выводятся
 * из состояния: стоит изменить условие вывода — и журнал начнёт тихо врать,
 * оставаясь непустым.
 */

import { describe, expect, it } from 'vitest';
import { Btn, createState, makeFrame, spawnPlayers, step } from '@dod/sim';
import { EventLog } from '@dod/client/events';

function fresh(players = 1) {
  const s = createState(1, players);
  spawnPlayers(s);
  const log = new EventLog();
  log.reset(s);
  return { s, log };
}

const run = (s: ReturnType<typeof fresh>['s'], log: EventLog, frames: unknown[], ticks: number) => {
  for (let t = 0; t < ticks; t++) {
    step(s, frames as never);
    log.observe(s);
  }
};

describe('журнал событий', () => {
  it('забег начинается с события на каждого игрока', () => {
    const { log } = fresh(3);
    const starts = log.since().filter((e) => e.name === 'run_start');
    expect(starts.map((e) => e.player)).toEqual([0, 1, 2]);
  });

  it('рывок попадает в журнал', () => {
    const { s, log } = fresh();
    const f = makeFrame();
    f.moveX = 65536;
    f.buttons = Btn.Dash;
    run(s, log, [f], 1);

    const dashes = log.since().filter((e) => e.name === 'dash');
    expect(dashes).toHaveLength(1);
    expect(dashes[0].tick).toBe(1);
  });

  it('конец неуязвимости отмечается отдельно', () => {
    const { s, log } = fresh();
    const f = makeFrame();
    f.moveX = 65536;
    f.buttons = Btn.Dash;
    run(s, log, [f], 1);
    f.buttons = 0;
    run(s, log, [f], 60);

    expect(log.since().some((e) => e.name === 'invulnerable_end')).toBe(true);
  });

  it('повторный рывок в перезарядке событием не считается', () => {
    const { s, log } = fresh();
    const f = makeFrame();
    f.moveX = 65536;
    f.buttons = Btn.Dash;
    // Кнопка зажата всё время: рывок обязан случиться один раз за перезарядку.
    run(s, log, [f], 30);

    expect(log.since().filter((e) => e.name === 'dash')).toHaveLength(1);
  });

  it('since отдаёт только то, что после указанного тика', () => {
    const { s, log } = fresh();
    const f = makeFrame();
    f.moveX = 65536;
    f.buttons = Btn.Dash;
    run(s, log, [f], 1);
    f.buttons = 0;
    run(s, log, [f], 200);
    f.buttons = Btn.Dash;
    run(s, log, [f], 1);

    const late = log.since(150);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((e) => e.tick >= 150)).toBe(true);
    expect(late.some((e) => e.name === 'run_start')).toBe(false);
  });

  it('новый забег обнуляет журнал', () => {
    const { s, log } = fresh();
    const f = makeFrame();
    f.moveX = 65536;
    f.buttons = Btn.Dash;
    run(s, log, [f], 60);
    expect(log.since().length).toBeGreaterThan(1);

    const s2 = createState(2, 1);
    spawnPlayers(s2);
    log.reset(s2);
    expect(log.since().map((e) => e.name)).toEqual(['run_start']);
  });
});

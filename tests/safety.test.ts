/**
 * Достижимость безопасной точки (D4): не только «есть ли выход», но и
 * «какой выход находится».
 *
 * `findSafePoint` отдаёт конкретную точку — её использует `RunnerBot`, чтобы
 * реально уйти от угрозы, а не просто узнать, что уход существует. Сетка
 * перебиралась по возрастанию (x, y) от угла арены и отдавала первую
 * свободную клетку — не ближайшую к игроку. Игрок в середине арены получал
 * точку у противоположного угла вместо шага в сторону, и бот, идущий по этой
 * точке, тратил весь запас времени на дорогу туда и обратно вместо ухода.
 */

import { describe, expect, it } from 'vitest';
import {
  EnemyPhase,
  EnemyType,
  createState,
  fromInt,
  makeFrame,
  setSpawning,
  spawnEnemy,
  spawnPlayers,
  step,
  toFloat,
} from '@dod/sim';
import { findSafePoint } from '@dod/tools/safety';

describe('findSafePoint', () => {
  it('отдаёт ближайшую безопасную точку, а не первую по сетке', () => {
    const s = createState(1, 1);
    spawnPlayers(s);
    setSpawning(s, false);

    const px = toFloat(s.pX[0]);
    const py = toFloat(s.pY[0]);

    // Фитиль подходит и поджигается сам — игрок оказывается внутри его зоны
    // взрыва, не двигаясь: ровно тот момент, когда D4 обязан назвать выход.
    const e = spawnEnemy(s, EnemyType.Fuse, fromInt(px + 400), fromInt(py));
    const idle = [makeFrame()];
    while (s.ePhase[e] !== EnemyPhase.Telegraph) step(s, idle);

    const report = findSafePoint(s, 0);
    expect(report.ok).toBe(true);

    const dist = Math.hypot(report.x - px, report.y - py);
    // Игрок стоит в центре арены 1920×1080: от угла сетки до него — сотни
    // единиц. Ближайший свободный выход лежит в паре шагов, а не через всю
    // карту, поэтому близкий порог отличает «ближайшую точку» от «первой по
    // сетке» без хрупкой привязки к конкретным координатам.
    expect(dist).toBeLessThan(100);
  });
});

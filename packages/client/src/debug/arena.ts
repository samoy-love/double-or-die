import {
  ARENA_PAD,
  BRICK,
  ENEMIES,
  EnemyPhase,
  EnemyType,
  FAIRNESS,
  FUSE,
  MAX_SPAWNS,
  WEDGE,
  clearArena,
  fromFloat,
  isFreeSpot,
  maxX,
  maxY,
  setSpawning,
  spawnEnemy,
  toFloat,
} from '@dod/sim';
import type { GameLoop } from '../loop';
import { log } from '../protocol';
import { ENEMY_TYPES } from './constants';
import type { DebugApi, EnemyName } from './types';

export function installArena(api: DebugApi, loop: GameLoop): void {
  Object.assign(api, {
    spawn(type: EnemyName, count = 1) {
      const t = ENEMY_TYPES[type];
      if (t === undefined) throw new Error(`неизвестный враг «${String(type)}»`);
      const s = loop.state;
      // По кругу вокруг игрока, но не ближе честной дистанции спавна:
      // отладка не должна создавать ситуаций, невозможных в игре.
      for (let n = 0; n < count; n++) {
        const a = (n / count) * Math.PI * 2;
        spawnEnemy(
          s,
          t,
          fromFloat(toFloat(s.pX[0]) + Math.cos(a) * 300),
          fromFloat(toFloat(s.pY[0]) + Math.sin(a) * 300),
        );
      }
      log('spawn', { type, count });
    },

    clear() {
      clearArena(loop.state);
      log('clear', {});
    },

    waves(on = true) {
      setSpawning(loop.state, on);
      log('waves', { on });
    },

    telegraph(kind: EnemyName, maxTicks = 240) {
      const t = ENEMY_TYPES[kind];
      if (t === undefined) {
        throw new Error(
          `неизвестный враг «${String(kind)}»; есть: ${Object.keys(ENEMY_TYPES).join(', ')}`,
        );
      }
      if (!Number.isInteger(maxTicks) || maxTicks < 1 || maxTicks > 600) {
        throw new Error(`ожидание телеграфа ${maxTicks}: нужно целое от 1 до 600 тиков`);
      }
      const s = loop.state;
      setSpawning(s, false);
      clearArena(s);

      // Дистанция берётся из правил самого врага, а не подобрана на глаз: Клин
      // целится в своём коридоре, Фитиль поджигается ближе своего радиуса,
      // Кирпич стреляет со своей рабочей дистанции.
      const dist =
        t === EnemyType.Wedge
          ? toFloat(WEDGE.minAimRange) + (toFloat(WEDGE.aimRange) - toFloat(WEDGE.minAimRange)) / 2
          : t === EnemyType.Fuse
            ? toFloat(FUSE.igniteRange) - 20
            : toFloat(BRICK.keepDistance);

      // Место должно быть свободным: телеграф сквозь колонну ядро запрещает, и
      // враг просто уйдёт в обход, а кадр окажется не тем.
      let i = -1;
      for (let k = 0; k < 16 && i < 0; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = fromFloat(toFloat(s.pX[0]) + Math.cos(a) * dist);
        const y = fromFloat(toFloat(s.pY[0]) + Math.sin(a) * dist);
        if (!isFreeSpot(s, x, y, ENEMIES[t].radius)) continue;
        i = spawnEnemy(s, t, x, y);
      }
      if (i < 0)
        throw new Error('некуда поставить врага: свободного места на нужной дистанции нет');

      // Дальше — только шаги ядра: оно само решит, разрешён телеграф или нет.
      // Ни одно поле врага руками не пишется — нарисованный коридор обязан
      // совпадать с той геометрией, по которой ядро считает урон.
      let waited = 0;
      while (waited < maxTicks && s.eActive[i] && s.ePhase[i] !== EnemyPhase.Telegraph) {
        loop.advance(1);
        waited++;
      }
      const ok = s.eActive[i] === 1 && s.ePhase[i] === EnemyPhase.Telegraph;
      loop.pause();
      log('telegraph', {
        kind,
        enemy: i,
        ok,
        waited,
        ticksLeft: ok ? Math.max(0, s.ePhaseUntil[i] - s.tick) : 0,
      });
      return ok ? i : -1;
    },

    spawnMark(x: number, y: number, kind: EnemyName = 'wedge') {
      const t = ENEMY_TYPES[kind];
      if (t === undefined) {
        throw new Error(
          `неизвестный враг «${String(kind)}»; есть: ${Object.keys(ENEMY_TYPES).join(', ')}`,
        );
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`координаты метки должны быть числами, а не (${x}, ${y})`);
      }
      const s = loop.state;
      const lo = toFloat(ARENA_PAD);
      const hiX = toFloat(maxX(s));
      const hiY = toFloat(maxY(s));
      if (x < lo || x > hiX || y < lo || y > hiY) {
        throw new Error(`метка (${x}, ${y}) вне арены: допустимо x ${lo}..${hiX}, y ${lo}..${hiY}`);
      }
      const fx = fromFloat(x);
      const fy = fromFloat(y);
      if (!isFreeSpot(s, fx, fy, ENEMIES[t].radius)) {
        throw new Error(`точка (${x}, ${y}) занята колонной или краем арены`);
      }
      let slot = -1;
      for (let i = 0; i < MAX_SPAWNS && slot < 0; i++) if (!s.spActive[i]) slot = i;
      if (slot < 0) throw new Error(`все ${MAX_SPAWNS} слотов меток заняты: сначала clear()`);

      // ПОДМЕНА пула меток, и заменить её нечем: постановщик метки приватен и
      // вдобавок сам выбирает точку случайным кольцом вокруг игрока — то есть
      // даже наружу выданный он не принял бы заказанные координаты, а
      // единственный экспортированный путь к меткам (волна) даёт случайное
      // место в случайный момент, ради снятия которого ручка и заводится.
      // Запись повторяет постановщика ровно, и дальше метка живёт по правилам
      // ядра: выпустит врага через свой срок либо переставится, если игрок
      // подошёл ближе честной дистанции — заказанную точку у самых ног ядро
      // именно так и перебьёт.
      s.spX[slot] = fx;
      s.spY[slot] = fy;
      s.spType[slot] = t;
      s.spAt[slot] = s.tick + FAIRNESS.spawnMarkTicks;
      s.spActive[slot] = 1;
      log('spawn_mark', { slot, kind, x, y, ticks: FAIRNESS.spawnMarkTicks, at: s.spAt[slot] });
      return slot;
    },
  } satisfies Partial<DebugApi>);
}

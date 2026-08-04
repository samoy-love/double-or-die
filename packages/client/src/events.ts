/**
 * Журнал игровых событий для агента и баг-репортов.
 *
 * События ВЫВОДЯТСЯ из состояния, а не эмитятся симуляцией. Причина ровно
 * одна и она важная: ядро обязано остаться чистым и без аллокаций, а список
 * событий — это объекты и строки. Стоит завести их внутри симуляции, и правило
 * «ноль аллокаций в тике» превращается в пожелание.
 *
 * Плата за это — события описывают наблюдаемые изменения состояния, а не
 * намерения кода. Для проверок агента этого достаточно: «сердце пропало»
 * проверяемо, а «сработала ветка урона» — уже деталь реализации, к которой
 * тест лучше не привязывать.
 */

import { EntityFlag, type SimState } from '@dod/sim';

export interface SimEvent {
  tick: number;
  name: 'run_start' | 'dash' | 'hurt' | 'death' | 'invulnerable_end';
  player: number;
  /** Значение, ради которого событие и заводилось: сердца, длительность. */
  value?: number;
}

/** Потолок журнала: больше в баг-репорт всё равно не влезет. */
const CAPACITY = 512;

const MAX_TRACKED = 4;

/**
 * Слежение за изменениями состояния.
 *
 * Кольцевой буфер, а не растущий массив: забег на пятнадцать минут — это
 * 54 000 тиков, и журнал без потолка однажды съест вкладку.
 */
export class EventLog {
  private readonly buf: SimEvent[] = [];
  private start = 0;

  private readonly prevHearts = new Int32Array(MAX_TRACKED);
  private readonly prevDashUntil = new Int32Array(MAX_TRACKED);
  private readonly prevFlags = new Int32Array(MAX_TRACKED);
  private primed = false;

  /** Начать заново: новый забег — новый журнал. */
  reset(s: SimState): void {
    this.buf.length = 0;
    this.start = 0;
    this.primed = false;
    for (let i = 0; i < s.playerCount; i++)
      this.push({ tick: s.tick, name: 'run_start', player: i });
    this.remember(s);
    this.primed = true;
  }

  /** Вызывается после каждого тика. */
  observe(s: SimState): void {
    if (!this.primed) {
      this.remember(s);
      this.primed = true;
      return;
    }

    for (let i = 0; i < s.playerCount; i++) {
      // Рывок: срок его окончания сдвинулся вперёд — значит, начался новый.
      if (s.pDashUntil[i] > this.prevDashUntil[i]) {
        this.push({ tick: s.tick, name: 'dash', player: i });
      }

      const hearts = s.pHearts[i];
      if (hearts < this.prevHearts[i]) {
        this.push({ tick: s.tick, name: 'hurt', player: i, value: hearts });
      }

      const wasAlive = (this.prevFlags[i] & EntityFlag.Alive) !== 0;
      const alive = (s.pFlags[i] & EntityFlag.Alive) !== 0;
      if (wasAlive && !alive) this.push({ tick: s.tick, name: 'death', player: i });

      const wasInvul = (this.prevFlags[i] & EntityFlag.Invulnerable) !== 0;
      const invul = (s.pFlags[i] & EntityFlag.Invulnerable) !== 0;
      if (wasInvul && !invul) {
        this.push({ tick: s.tick, name: 'invulnerable_end', player: i });
      }
    }

    this.remember(s);
  }

  /** События с указанного тика включительно. Без аргумента — все. */
  since(tick = -1): SimEvent[] {
    const out: SimEvent[] = [];
    for (let k = 0; k < this.buf.length; k++) {
      const e = this.buf[(this.start + k) % this.buf.length];
      if (e.tick >= tick) out.push(e);
    }
    return out;
  }

  private push(e: SimEvent): void {
    if (this.buf.length < CAPACITY) {
      this.buf.push(e);
      return;
    }
    this.buf[this.start] = e;
    this.start = (this.start + 1) % CAPACITY;
  }

  private remember(s: SimState): void {
    for (let i = 0; i < s.playerCount; i++) {
      this.prevHearts[i] = s.pHearts[i];
      this.prevDashUntil[i] = s.pDashUntil[i];
      this.prevFlags[i] = s.pFlags[i];
    }
  }
}

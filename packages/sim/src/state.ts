/**
 * Состояние симуляции: структура массивов, а не массив структур.
 *
 * Всё предаллоцировано под потолки и живёт в типизированных массивах по трём
 * причинам сразу: ноль аллокаций в кадре (GC-пауза съедает кадр целиком),
 * снимок состояния одним `set()` за микросекунды, и побайтовое хеширование
 * для сверки детерминизма.
 */

import { fromInt } from './fixed';
import { createStreams, type RngState, STREAM_COUNT } from './rng';

export const MAX_PLAYERS = 4;
export const MAX_ENEMIES = 200;
export const MAX_BULLETS = 800;
export const MAX_CARDS = 8;
export const MAX_CHIPS = 256;

/** Виртуальное разрешение арены в условных единицах. */
export const ARENA_W = fromInt(1920);
export const ARENA_H = fromInt(1080);

export const TICK_HZ = 60;

export const enum EntityFlag {
  Alive = 1 << 0,
  /** Неуязвим: i-frames после урона или во время рывка. */
  Invulnerable = 1 << 1,
  /** Отброшен ударом, управление временно отнято. */
  Ragdoll = 1 << 2,
}

export interface SimState {
  /** Номер тика с начала забега. Основная единица времени — не секунды. */
  tick: number;
  seed: number;
  rng: RngState;

  // --- Игроки ---
  playerCount: number;
  pX: Int32Array;
  pY: Int32Array;
  pVX: Int32Array;
  pVY: Int32Array;
  pAimX: Int32Array;
  pAimY: Int32Array;
  pHearts: Int32Array;
  pFlags: Int32Array;
  /** Тик, до которого действует неуязвимость. */
  pInvulUntil: Int32Array;
  /** Тик, когда рывок снова доступен. */
  pDashReady: Int32Array;
  /** Тик окончания текущего рывка. */
  pDashUntil: Int32Array;
  /** Тик последнего выстрела — для темпа стрельбы. */
  pLastShot: Int32Array;
  pChips: Int32Array;

  // --- Снаряды ---
  bX: Int32Array;
  bY: Int32Array;
  bVX: Int32Array;
  bVY: Int32Array;
  /** Тик, на котором снаряд исчезает. */
  bDeadline: Int32Array;
  /** Индекс владельца: 0..3 игрок, −1 враг. */
  bOwner: Int32Array;
  bActive: Uint8Array;

  // --- Враги ---
  eX: Int32Array;
  eY: Int32Array;
  eVX: Int32Array;
  eVY: Int32Array;
  eHP: Int32Array;
  eType: Int32Array;
  /** Состояние автомата врага. */
  ePhase: Int32Array;
  /** Тик перехода в следующее состояние. */
  ePhaseUntil: Int32Array;
  eTarget: Int32Array;
  eActive: Uint8Array;

  /**
   * Все буферы состояния одним списком — для снимка и хеша одним проходом.
   *
   * Список строится ОДИН раз при создании состояния и живёт вместе с ним.
   * Собирать его на каждом вызове означало бы аллокацию из тридцати ссылок
   * в хеше, снимке и восстановлении — то есть ровно на пути отката и
   * сетевой сверки, где аллокаций быть не должно. Сами буферы не
   * пересоздаются никогда, поэтому список верен всё время жизни состояния.
   */
  views: readonly (Int32Array | Uint8Array)[];
}

function collectBuffers(s: SimState): (Int32Array | Uint8Array)[] {
  return [
    s.rng,
    s.pX,
    s.pY,
    s.pVX,
    s.pVY,
    s.pAimX,
    s.pAimY,
    s.pHearts,
    s.pFlags,
    s.pInvulUntil,
    s.pDashReady,
    s.pDashUntil,
    s.pLastShot,
    s.pChips,
    s.bX,
    s.bY,
    s.bVX,
    s.bVY,
    s.bDeadline,
    s.bOwner,
    s.bActive,
    s.eX,
    s.eY,
    s.eVX,
    s.eVY,
    s.eHP,
    s.eType,
    s.ePhase,
    s.ePhaseUntil,
    s.eTarget,
    s.eActive,
  ];
}

export function createState(seed: number, playerCount = 1): SimState {
  const p = () => new Int32Array(MAX_PLAYERS);
  const b = () => new Int32Array(MAX_BULLETS);
  const e = () => new Int32Array(MAX_ENEMIES);

  const s: SimState = {
    tick: 0,
    seed,
    rng: createStreams(seed),

    playerCount,
    pX: p(),
    pY: p(),
    pVX: p(),
    pVY: p(),
    pAimX: p(),
    pAimY: p(),
    pHearts: p(),
    pFlags: p(),
    pInvulUntil: p(),
    pDashReady: p(),
    pDashUntil: p(),
    pLastShot: p(),
    pChips: p(),

    bX: b(),
    bY: b(),
    bVX: b(),
    bVY: b(),
    bDeadline: b(),
    bOwner: b(),
    bActive: new Uint8Array(MAX_BULLETS),

    eX: e(),
    eY: e(),
    eVX: e(),
    eVY: e(),
    eHP: e(),
    eType: e(),
    ePhase: e(),
    ePhaseUntil: e(),
    eTarget: e(),
    eActive: new Uint8Array(MAX_ENEMIES),
    // Заполняется сразу ниже: список ссылается на те же буферы, что
    // перечислены выше, и до их создания его собрать нельзя.
    views: [],
  };
  s.views = collectBuffers(s);
  return s;
}

/** Снимок состояния. Предаллоцируется один раз и переиспользуется. */
export interface Snapshot {
  tick: number;
  seed: number;
  playerCount: number;
  data: (Int32Array | Uint8Array)[];
}

export function createSnapshot(s: SimState): Snapshot {
  return {
    tick: 0,
    seed: s.seed,
    playerCount: s.playerCount,
    data: s.views.map((buf) =>
      buf instanceof Uint8Array ? new Uint8Array(buf.length) : new Int32Array(buf.length),
    ),
  };
}

export function saveSnapshot(s: SimState, snap: Snapshot): void {
  snap.tick = s.tick;
  snap.seed = s.seed;
  snap.playerCount = s.playerCount;
  const src = s.views;
  for (let i = 0; i < src.length; i++) snap.data[i].set(src[i] as never);
}

export function loadSnapshot(s: SimState, snap: Snapshot): void {
  s.tick = snap.tick;
  s.seed = snap.seed;
  s.playerCount = snap.playerCount;
  const dst = s.views;
  for (let i = 0; i < dst.length; i++) dst[i].set(snap.data[i] as never);
}

/**
 * Хеш состояния, FNV-1a по всем буферам.
 *
 * Сверяется между пирами каждые 30 тиков и между операционными системами в CI.
 * Расхождение означает слом детерминизма — самый опасный класс багов здесь.
 */
export function hashState(s: SimState): number {
  let h = 0x811c9dc5;
  h = (Math.imul(h ^ s.tick, 0x01000193) >>> 0) >>> 0;
  h = (Math.imul(h ^ s.playerCount, 0x01000193) >>> 0) >>> 0;

  for (const buf of s.views) {
    if (buf instanceof Uint8Array) {
      for (let i = 0; i < buf.length; i++) h = Math.imul(h ^ buf[i], 0x01000193) >>> 0;
    } else {
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        h = Math.imul(h ^ (v & 0xff), 0x01000193) >>> 0;
        h = Math.imul(h ^ ((v >>> 8) & 0xff), 0x01000193) >>> 0;
        h = Math.imul(h ^ ((v >>> 16) & 0xff), 0x01000193) >>> 0;
        h = Math.imul(h ^ ((v >>> 24) & 0xff), 0x01000193) >>> 0;
      }
    }
  }
  return h >>> 0;
}

export const hashHex = (s: SimState): string => '0x' + hashState(s).toString(16).padStart(8, '0');

/** Проверка, что число потоков RNG не разъехалось с состоянием. */
export const RNG_WORDS = STREAM_COUNT * 4;

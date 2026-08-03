/**
 * Тик симуляции.
 *
 * Чистая функция от состояния и кадров ввода: одинаковый вход даёт одинаковый
 * выход на любой платформе. Ни `window`, ни `Date.now()`, ни `Math.random()`
 * здесь быть не может — это ловит линтер, а не совесть.
 *
 * В 0.1.0 из геймплея есть только движение игрока: версия существует ради
 * фундамента, а не ради боя. Бой приезжает в 0.2.0.
 */

import { add, clamp, fromFloat, fromInt, mul, sub } from './fixed';
import { normalize, normX, normY } from './trig';
import { type InputFrame, Btn, isDown } from './input';
import { ARENA_H, ARENA_W, EntityFlag, type SimState, TICK_HZ } from './state';

/** Параметры игрока из GDD §6. Держим в тиках и Q16.16, а не в секундах. */
export const PLAYER = {
  radius: fromInt(18),
  /** 320 u/с → за тик. */
  speed: fromFloat(320 / TICK_HZ),
  /** 2400 u/с² → за тик. */
  accel: fromFloat(2400 / (TICK_HZ * TICK_HZ)),
  /** Трение 12/с как доля скорости, снимаемая за тик. */
  friction: fromFloat(12 / TICK_HZ),
  dashDistance: fromInt(240),
  /** 0.16 с */
  dashTicks: Math.round(0.16 * TICK_HZ),
  /** 1.2 с */
  dashCooldownTicks: Math.round(1.2 * TICK_HZ),
  /**
   * Coyote-время рывка: неуязвимость держится столько тиков ПОСЛЕ того, как
   * движение рывка кончилось.
   *
   * Ради этого хвоста рывок и ощущается спасением: игрок жмёт кнопку в
   * последний момент, видит, что уже не успевает, — и всё равно проходит
   * сквозь снаряд. Без хвоста рывок «впритык» карает за смелость, а это
   * ровно та эмоция, которой в игре про ставки на себя быть не должно.
   *
   * Число задано здесь и складывается с длительностью рывка ниже, а не
   * записано отдельной секундой: раньше неуязвимость была независимыми
   * 0.22 с, и хвост получался побочным следствием двух чисел — три тика
   * вместо задуманных четырёх. Правка любого из них молча меняла ощущение.
   */
  dashCoyoteTicks: 4,
  startHearts: 3,
} as const;

/**
 * Сколько тиков держится неуязвимость рывка целиком: само движение плюс
 * coyote-хвост. Производная, а не третье независимое число — иначе хвост
 * снова начнёт получаться случайно.
 */
export const DASH_INVUL_TICKS = PLAYER.dashTicks + PLAYER.dashCoyoteTicks;

const ARENA_PAD = fromInt(60);
const MIN_X = ARENA_PAD;
const MIN_Y = ARENA_PAD;
const MAX_X = sub(ARENA_W, ARENA_PAD);
const MAX_Y = sub(ARENA_H, ARENA_PAD);

/** Поставить игроков в стартовые позиции. */
export function spawnPlayers(s: SimState): void {
  const cx = ARENA_W >> 1;
  const cy = ARENA_H >> 1;
  const spread = fromInt(120);

  for (let i = 0; i < s.playerCount; i++) {
    // Раскладка по кругу, детерминированная: без обращения к RNG.
    const offX = i === 0 || i === 3 ? -spread : spread;
    const offY = i < 2 ? -spread : spread;
    s.pX[i] = s.playerCount === 1 ? cx : add(cx, offX);
    s.pY[i] = s.playerCount === 1 ? cy : add(cy, offY);
    s.pVX[i] = 0;
    s.pVY[i] = 0;
    s.pAimX[i] = fromInt(1);
    s.pAimY[i] = 0;
    s.pHearts[i] = PLAYER.startHearts;
    s.pFlags[i] = EntityFlag.Alive;
    s.pInvulUntil[i] = 0;
    s.pDashReady[i] = 0;
    s.pDashUntil[i] = 0;
    s.pLastShot[i] = -9999;
    s.pChips[i] = 0;
  }
}

/**
 * Один тик. `inputs[i]` — кадр игрока i за ЭТОТ тик.
 *
 * Порядок обработки фиксирован и важен: он часть контракта детерминизма.
 * Менять его — ломать все golden-реплеи.
 */
export function step(s: SimState, inputs: readonly InputFrame[]): void {
  stepPlayers(s, inputs);
  s.tick++;
}

function stepPlayers(s: SimState, inputs: readonly InputFrame[]): void {
  for (let i = 0; i < s.playerCount; i++) {
    if ((s.pFlags[i] & EntityFlag.Alive) === 0) continue;

    const inp = inputs[i];
    const dashing = s.tick < s.pDashUntil[i];

    if (inp.aimX !== 0 || inp.aimY !== 0) {
      normalize(inp.aimX, inp.aimY);
      s.pAimX[i] = normX;
      s.pAimY[i] = normY;
    }

    if (dashing) {
      // Во время рывка направление зафиксировано — скорость уже задана.
      applyVelocity(s, i);
    } else if (tryDash(s, i, inp)) {
      // Рывок начался прямо сейчас: обычное движение в этот тик не
      // применяется. Иначе ограничение скорости в applyMovement срежет
      // разгон обратно до ходьбы, и рывка не будет вовсе.
      applyVelocity(s, i);
    } else {
      applyMovement(s, i, inp);
    }

    updateInvulnerability(s, i);
  }
}

/** Возвращает true, если рывок начался в этом тике. */
function tryDash(s: SimState, i: number, inp: InputFrame): boolean {
  if (!isDown(inp, Btn.Dash)) return false;
  if (s.tick < s.pDashReady[i]) return false;

  // Рывок идёт в направлении движения, а при его отсутствии — в направлении
  // прицела: иначе стоящий на месте игрок не может уйти от снаряда.
  let dx = inp.moveX;
  let dy = inp.moveY;
  if (dx === 0 && dy === 0) {
    dx = s.pAimX[i];
    dy = s.pAimY[i];
  }
  normalize(dx, dy);
  const nx = normX;
  const ny = normY;
  if (nx === 0 && ny === 0) return false;

  const perTick = Math.trunc(PLAYER.dashDistance / PLAYER.dashTicks);
  s.pVX[i] = mul(nx, perTick);
  s.pVY[i] = mul(ny, perTick);
  s.pDashUntil[i] = s.tick + PLAYER.dashTicks;
  s.pDashReady[i] = s.tick + PLAYER.dashCooldownTicks;
  s.pInvulUntil[i] = Math.max(s.pInvulUntil[i], s.tick + DASH_INVUL_TICKS);
  s.pFlags[i] |= EntityFlag.Invulnerable;
  return true;
}

function applyMovement(s: SimState, i: number, inp: InputFrame): void {
  normalize(inp.moveX, inp.moveY);
  const nx = normX;
  const ny = normY;

  if (nx !== 0 || ny !== 0) {
    s.pVX[i] = add(s.pVX[i], mul(nx, PLAYER.accel));
    s.pVY[i] = add(s.pVY[i], mul(ny, PLAYER.accel));

    // Ограничение по модулю: без него диагональ быстрее прямой.
    const vx = s.pVX[i];
    const vy = s.pVY[i];
    normalize(vx, vy);
    const cx = normX;
    const cy = normY;
    const speed2 = mul(vx, vx) + mul(vy, vy);
    const cap2 = mul(PLAYER.speed, PLAYER.speed);
    if (speed2 > cap2) {
      s.pVX[i] = mul(cx, PLAYER.speed);
      s.pVY[i] = mul(cy, PLAYER.speed);
    }
  } else {
    s.pVX[i] = sub(s.pVX[i], mul(s.pVX[i], PLAYER.friction));
    s.pVY[i] = sub(s.pVY[i], mul(s.pVY[i], PLAYER.friction));
  }

  applyVelocity(s, i);
}

function applyVelocity(s: SimState, i: number): void {
  s.pX[i] = clamp(add(s.pX[i], s.pVX[i]), MIN_X, MAX_X);
  s.pY[i] = clamp(add(s.pY[i], s.pVY[i]), MIN_Y, MAX_Y);
}

function updateInvulnerability(s: SimState, i: number): void {
  if (s.tick >= s.pInvulUntil[i]) s.pFlags[i] &= ~EntityFlag.Invulnerable;
}

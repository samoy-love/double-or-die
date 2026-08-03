/**
 * Тик симуляции.
 *
 * Чистая функция от состояния и кадров ввода: одинаковый вход даёт одинаковый
 * выход на любой платформе. Ни `window`, ни `Date.now()`, ни `Math.random()`
 * здесь быть не может — это ловит линтер, а не совесть.
 *
 * Версия 0.2.0 «Тир» — это бой и ничего кроме боя: игрок, три врага, волны,
 * фишки. Пари приезжают в 0.3.0 и лягут поверх, ничего здесь не переписывая:
 * карта пари — это ещё одна сущность на арене, а не другой бой.
 */

import { clampX, clampY, pushOutOfColumns, pushedX, pushedY } from './arena';
import { PISTOL, PLAYER } from './config';
import { fire, stepBullets, stepChips } from './combat';
import { clearArena, startRoom, stepEnemies } from './enemies';
import { add, FX_ONE, fromInt, mul, sub } from './fixed';
import { normalize, normX, normY, within } from './trig';
import { type InputFrame, Btn, isDown } from './input';
import { EntityFlag, Meta, type SimState } from './state';

/** Пауза перед перезапуском забега: игроку нужно увидеть, что он умер. */
const RESTART_DELAY_TICKS = 180;

/** Поставить игроков в стартовые позиции и начать первую комнату. */
export function spawnPlayers(s: SimState): void {
  const cx = s.arenaW >> 1;
  const cy = s.arenaH >> 1;
  const spread = fromInt(120);

  for (let i = 0; i < s.playerCount; i++) {
    // Раскладка по кругу, детерминированная: без обращения к RNG.
    const offX = i === 0 || i === 3 ? -spread : spread;
    const offY = i < 2 ? -spread : spread;
    s.pX[i] = s.playerCount === 1 ? cx : add(cx, offX);
    s.pY[i] = s.playerCount === 1 ? cy : add(cy, offY);
    s.pVX[i] = 0;
    s.pVY[i] = 0;
    s.pAimX[i] = FX_ONE;
    s.pAimY[i] = 0;
    s.pHearts[i] = PLAYER.startHearts;
    s.pFlags[i] = EntityFlag.Alive;
    s.pInvulUntil[i] = 0;
    s.pDashReady[i] = 0;
    s.pDashUntil[i] = 0;
    s.pRagdollUntil[i] = 0;
    // Оружие готово с первого тика: игрок появляется на арене, где уже есть
    // враги, и «первый выстрел через десять тиков» ощущается осечкой.
    s.pShotAcc[i] = PLAYER.shotReserve * FX_ONE;
    s.pChips[i] = 0;
  }

  s.meta[Meta.SeenTypes] = 0;
  s.meta[Meta.Kills] = 0;
  s.meta[Meta.RestartAt] = 0;
  clearArena(s);
  startRoom(s, 1);
}

/**
 * Один тик. `inputs[i]` — кадр игрока i за ЭТОТ тик.
 *
 * Порядок обработки фиксирован и важен: он часть контракта детерминизма.
 * Менять его — ломать все golden-реплеи.
 *
 * Сначала игроки, потом враги, потом снаряды: так выстрел, сделанный в этом
 * тике, ещё не успевает попасть, а враг, начавший рывок, летит с того места,
 * где игрок его видел. Обратный порядок дал бы попадания «до нажатия».
 */
export function step(s: SimState, inputs: readonly InputFrame[]): void {
  stepPlayers(s, inputs);
  stepEnemies(s);
  stepBullets(s);
  stepChips(s);
  stepRunEnd(s);
  s.tick++;
}

/**
 * Гибель всех игроков и перезапуск.
 *
 * Живёт в симуляции, а не в клиенте: реплей обязан переигрываться целиком,
 * включая то, что было после смерти. Последняя сделка (GDD §12А.3) заменит
 * этот перезапуск в 0.6.0 — до неё смерть означает «сначала».
 */
function stepRunEnd(s: SimState): void {
  if (s.meta[Meta.RestartAt] !== 0) {
    if (s.tick < s.meta[Meta.RestartAt]) return;
    // tick++ произойдёт после нас, поэтому старт комнаты считается от
    // следующего тика — иначе пауза перед первой волной короче на кадр.
    s.tick++;
    spawnPlayers(s);
    s.tick--;
    s.meta[Meta.Deaths]++;
    return;
  }

  for (let i = 0; i < s.playerCount; i++) {
    if ((s.pFlags[i] & EntityFlag.Alive) !== 0) return;
  }
  s.meta[Meta.RestartAt] = s.tick + RESTART_DELAY_TICKS;
}

function stepPlayers(s: SimState, inputs: readonly InputFrame[]): void {
  for (let i = 0; i < s.playerCount; i++) {
    if ((s.pFlags[i] & EntityFlag.Alive) === 0) continue;

    const inp = inputs[i];
    const dashing = s.tick < s.pDashUntil[i];
    const ragdoll = s.tick < s.pRagdollUntil[i];

    if (inp.aimX !== 0 || inp.aimY !== 0) {
      normalize(inp.aimX, inp.aimY);
      s.pAimX[i] = normX;
      s.pAimY[i] = normY;
    }

    if (ragdoll) {
      // Кувырок: управление отнято, скорость гасится своим трением.
      // Унижение вместо наказания — механика Fall Guys (GDD §6).
      s.pVX[i] = sub(s.pVX[i], mul(s.pVX[i], PLAYER.ragdollFriction));
      s.pVY[i] = sub(s.pVY[i], mul(s.pVY[i], PLAYER.ragdollFriction));
      applyVelocity(s, i);
    } else if (dashing) {
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

    if (s.tick >= s.pRagdollUntil[i]) s.pFlags[i] &= ~EntityFlag.Ragdoll;
    stepShooting(s, i, inp, ragdoll);
    updateInvulnerability(s, i);
  }

  separatePlayers(s);
}

/**
 * Стрельба: темп 6.5/с накапливается дробно, но первый выстрел мгновенный.
 *
 * Заряд копится ВСЕГДА и упирается в потолок в один выстрел. Из этого следуют
 * оба нужных свойства сразу: одиночное нажатие стреляет в тот же тик, потому
 * что полный заряд уже накоплен, а минута ходьбы не превращается в залп,
 * потому что больше одного выстрела впрок не копится.
 *
 * Первая версия обнуляла заряд при отпущенном курке и копила его с нуля при
 * зажатом. Темп при удержании выходил верный, а короткий клик не давал
 * выстрела ВООБЩЕ: за три тика до целого заряда не доходило, и игрок жал
 * кнопку впустую. В твин-стике это ощущается как сломанное оружие, и никакой
 * темп стрельбы этого не оправдывает.
 *
 * Остаток после выстрела переносится в следующий тик, и это не мелочь: 65536
 * делится на такт 7101 с остатком, и обрезка давала шестьдесят выстрелов за
 * десять секунд вместо шестидесяти пяти. Темп стрельбы — опорное число всей
 * модели сложности (DIFFICULTY §1), и потеря семи процентов тихо смещает
 * время убийства каждого врага в игре.
 */
function stepShooting(s: SimState, i: number, inp: InputFrame, ragdoll: boolean): void {
  // Кувырок отнимает и стрельбу: управление на это время отнято целиком.
  if (ragdoll) return;

  s.pShotAcc[i] += PISTOL.fireRate;

  if (!isDown(inp, Btn.Fire)) {
    // Потолок работает только при отпущенном курке — и только здесь.
    // Обрезка при зажатом съедала бы дробный остаток такта, а из него
    // складывается сам темп: 60 выстрелов за десять секунд вместо 65.
    const reserve = PLAYER.shotReserve * FX_ONE;
    if (s.pShotAcc[i] > reserve) s.pShotAcc[i] = reserve;
    return;
  }

  if (s.pShotAcc[i] < FX_ONE) return;
  s.pShotAcc[i] -= FX_ONE;
  fire(s, i);
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
  s.pInvulUntil[i] = Math.max(s.pInvulUntil[i], s.tick + PLAYER.dashTicks + PLAYER.dashCoyoteTicks);
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
  pushOutOfColumns(s, add(s.pX[i], s.pVX[i]), add(s.pY[i], s.pVY[i]), PLAYER.radius);
  s.pX[i] = pushedX;
  s.pY[i] = pushedY;
}

/**
 * Игроки толкаются, но не проходят друг сквозь друга (GDD §14).
 *
 * Толкание — не мелочь удобства: на нём стоит саботаж в коопе, и оно должно
 * работать одинаково у всех, то есть жить в симуляции.
 */
function separatePlayers(s: SimState): void {
  if (s.playerCount < 2) return;
  const minDist = add(PLAYER.radius, PLAYER.radius);

  for (let i = 0; i < s.playerCount; i++) {
    if ((s.pFlags[i] & EntityFlag.Alive) === 0) continue;
    for (let j = i + 1; j < s.playerCount; j++) {
      if ((s.pFlags[j] & EntityFlag.Alive) === 0) continue;
      const dx = sub(s.pX[i], s.pX[j]);
      const dy = sub(s.pY[i], s.pY[j]);
      if (!within(dx, dy, minDist)) continue;
      normalize(dx, dy);
      if (normX === 0 && normY === 0) continue;
      const px = mul(normX, PLAYER.pushSpeed);
      const py = mul(normY, PLAYER.pushSpeed);
      s.pX[i] = clampX(s, add(s.pX[i], px), PLAYER.radius);
      s.pY[i] = clampY(s, add(s.pY[i], py), PLAYER.radius);
      s.pX[j] = clampX(s, sub(s.pX[j], px), PLAYER.radius);
      s.pY[j] = clampY(s, sub(s.pY[j], py), PLAYER.radius);
    }
  }
}

function updateInvulnerability(s: SimState, i: number): void {
  if (s.tick >= s.pInvulUntil[i]) s.pFlags[i] &= ~EntityFlag.Invulnerable;
}

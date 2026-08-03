/**
 * Снаряды, урон, фишки и ударная волна.
 *
 * Всё, что летит и всё, что отнимает здоровье, — в одном месте: правила
 * попадания обязаны быть одинаковыми для пули игрока, пули Кирпича и взрыва
 * Фитиля, иначе «прощающая коллизия» окажется прощающей через раз.
 *
 * Урон по врагам считается в очках (у Клина 20), урон по игроку — всегда в
 * одно сердце. Это не упрощение, а решение из GDD §6: сердец три, и дробить
 * их нечем.
 */

import { hitsColumn, outOfArena, pushOutOfColumns, pushedX, pushedY } from './arena';
import {
  CHIP,
  ENEMIES,
  FUSE,
  PLAYER,
  PISTOL,
  ENEMY_BULLET,
  type EnemyStats,
  EnemyPhase,
} from './config';
import { add, type Fx, mul, sub } from './fixed';
import { Stream, nextInt } from './rng';
import { EntityFlag, MAX_BULLETS, MAX_CHIPS, MAX_ENEMIES, Meta, type SimState } from './state';
import { cos, sin, within, ANGLE_FULL, normalize, normX, normY } from './trig';

/** Владелец снаряда, когда стрелял враг. */
export const ENEMY_OWNER = -1;

export const statsOf = (type: number): EnemyStats => ENEMIES[type];

// ---------------------------------------------------------------------------
// Снаряды
// ---------------------------------------------------------------------------

/**
 * Выпустить снаряд. Возвращает false, если пул исчерпан.
 *
 * Переполнение пула — не ошибка и не повод падать: восемьсот снарядов на
 * экране это уже нечитаемая каша, и правильная реакция — не выпустить ещё
 * один. Границы массивов обрабатываются, а не роняют игру (DEVLOOP §6А).
 */
export function spawnBullet(
  s: SimState,
  x: Fx,
  y: Fx,
  dirX: Fx,
  dirY: Fx,
  speed: Fx,
  owner: number,
  lifeTicks: number,
): boolean {
  for (let i = 0; i < MAX_BULLETS; i++) {
    if (s.bActive[i]) continue;
    s.bX[i] = x;
    s.bY[i] = y;
    s.bVX[i] = mul(dirX, speed);
    s.bVY[i] = mul(dirY, speed);
    s.bDeadline[i] = s.tick + lifeTicks;
    s.bOwner[i] = owner;
    s.bActive[i] = 1;
    return true;
  }
  return false;
}

/** Выстрел игрока: направление прицела плюс разброс. */
export function fire(s: SimState, player: number): void {
  const ax = s.pAimX[player];
  const ay = s.pAimY[player];
  if (ax === 0 && ay === 0) return;

  // Разброс ±1°: конус в 2° целиком. Берём из потока боя, а не из потока
  // волн, — иначе число выстрелов начало бы менять состав следующей волны.
  const jitter = nextInt(s.rng, Stream.Combat, PISTOL.spread * 2 + 1) - PISTOL.spread;
  let dx = ax;
  let dy = ay;
  if (jitter !== 0) {
    const c = cos(jitter & (ANGLE_FULL - 1));
    const sn = sin(jitter & (ANGLE_FULL - 1));
    dx = sub(mul(ax, c), mul(ay, sn));
    dy = add(mul(ax, sn), mul(ay, c));
    normalize(dx, dy);
    dx = normX;
    dy = normY;
  }

  const x = add(s.pX[player], mul(dx, PISTOL.muzzle));
  const y = add(s.pY[player], mul(dy, PISTOL.muzzle));
  spawnBullet(s, x, y, dx, dy, PISTOL.bulletSpeed, player, PISTOL.bulletLifeTicks);
}

/** Выстрел Кирпича в зафиксированном на телеграфе направлении. */
export function fireEnemy(s: SimState, enemy: number): void {
  const dx = s.eDirX[enemy];
  const dy = s.eDirY[enemy];
  if (dx === 0 && dy === 0) return;
  const r = statsOf(s.eType[enemy]).radius;
  spawnBullet(
    s,
    add(s.eX[enemy], mul(dx, r)),
    add(s.eY[enemy], mul(dy, r)),
    dx,
    dy,
    ENEMY_BULLET.speed,
    ENEMY_OWNER,
    ENEMY_BULLET.lifeTicks,
  );
}

/**
 * Шаг снарядов: движение, срок жизни, попадания.
 *
 * Порядок «сначала все двигаются, потом все проверяются» держится намеренно:
 * иначе снаряд, обработанный раньше, видел бы врага на прошлой позиции, а
 * обработанный позже — на новой, и попадание зависело бы от индекса в пуле.
 */
export function stepBullets(s: SimState): void {
  for (let i = 0; i < MAX_BULLETS; i++) {
    if (!s.bActive[i]) continue;

    if (s.tick >= s.bDeadline[i]) {
      s.bActive[i] = 0;
      continue;
    }

    const x = add(s.bX[i], s.bVX[i]);
    const y = add(s.bY[i], s.bVY[i]);
    s.bX[i] = x;
    s.bY[i] = y;

    const radius = s.bOwner[i] === ENEMY_OWNER ? ENEMY_BULLET.radius : PISTOL.bulletRadius;

    // Стены и колонны гасят снаряд: за колонной обязано быть безопасно,
    // иначе укрытие перестаёт быть укрытием.
    if (outOfArena(s, x, y) || hitsColumn(s, x, y, radius)) {
      s.bActive[i] = 0;
      continue;
    }

    if (s.bOwner[i] === ENEMY_OWNER) {
      if (hitAnyPlayer(s, x, y, radius)) s.bActive[i] = 0;
    } else if (hitAnyEnemy(s, x, y, radius)) {
      s.bActive[i] = 0;
    }
  }
}

function hitAnyEnemy(s: SimState, x: Fx, y: Fx, radius: Fx): boolean {
  for (let e = 0; e < MAX_ENEMIES; e++) {
    if (!s.eActive[e]) continue;
    const r = add(statsOf(s.eType[e]).radius, radius);
    if (!within(sub(s.eX[e], x), sub(s.eY[e], y), r)) continue;
    damageEnemy(s, e, PISTOL.damage);
    return true;
  }
  return false;
}

function hitAnyPlayer(s: SimState, x: Fx, y: Fx, radius: Fx): boolean {
  for (let p = 0; p < s.playerCount; p++) {
    if ((s.pFlags[p] & EntityFlag.Alive) === 0) continue;
    // Хитбокс 18 u против визуальных 22: игрок обязан думать «я увернулся».
    const r = add(PLAYER.radius, radius);
    if (!within(sub(s.pX[p], x), sub(s.pY[p], y), r)) continue;
    // Неуязвимый игрок пропускает снаряд СКВОЗЬ себя, а не гасит его: иначе
    // рывок сквозь залп бесплатно прикрывал бы стоящего сзади напарника.
    if (isProtected(s, p)) continue;
    damagePlayer(s, p);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Урон
// ---------------------------------------------------------------------------

export const isProtected = (s: SimState, p: number): boolean =>
  (s.pFlags[p] & EntityFlag.Invulnerable) !== 0;

/** Урон по врагу. Смерть обрабатывается сразу: полумёртвых сущностей нет. */
export function damageEnemy(s: SimState, e: number, damage: number): void {
  s.eHP[e] -= damage;
  if (s.eHP[e] > 0) return;
  killEnemy(s, e);
}

export function killEnemy(s: SimState, e: number): void {
  const x = s.eX[e];
  const y = s.eY[e];
  s.eActive[e] = 0;
  s.eHP[e] = 0;
  s.ePhase[e] = EnemyPhase.Idle;
  s.meta[Meta.Kills]++;

  if (nextInt(s.rng, Stream.Loot, 100) < CHIP.dropChancePct) dropChip(s, x, y);
}

/**
 * Урон по игроку — всегда одно сердце.
 *
 * Неуязвимость проверяется здесь, а не у каждого источника: пропустить эту
 * проверку в одном месте из трёх значит получить игру, где рывок спасает от
 * пуль, но не от тарана, и понять это только по жалобе.
 */
export function damagePlayer(s: SimState, p: number): boolean {
  if ((s.pFlags[p] & EntityFlag.Alive) === 0) return false;
  if (isProtected(s, p)) return false;

  s.pHearts[p]--;
  s.pInvulUntil[p] = s.tick + PLAYER.hurtInvulTicks;
  s.pFlags[p] |= EntityFlag.Invulnerable;

  if (s.pHearts[p] <= 0) {
    s.pHearts[p] = 0;
    s.pFlags[p] &= ~EntityFlag.Alive;
  }
  return true;
}

/**
 * Ударная волна Фитиля: урон и отброс по всем, включая врагов.
 *
 * Дружественный урон здесь единственный во всей игре и оставлен намеренно —
 * на нём стоит пари «Подрывник» (GDD §9.5) и вся тактика подрыва толпы.
 */
export function explode(s: SimState, x: Fx, y: Fx, source: number): void {
  for (let e = 0; e < MAX_ENEMIES; e++) {
    if (!s.eActive[e] || e === source) continue;
    const dx = sub(s.eX[e], x);
    const dy = sub(s.eY[e], y);
    if (!within(dx, dy, add(FUSE.blastRadius, statsOf(s.eType[e]).radius))) continue;
    knockback(s.eVX, s.eVY, e, dx, dy, FUSE.knockback);
    damageEnemy(s, e, FUSE.blastDamage);
  }

  for (let p = 0; p < s.playerCount; p++) {
    if ((s.pFlags[p] & EntityFlag.Alive) === 0) continue;
    const dx = sub(s.pX[p], x);
    const dy = sub(s.pY[p], y);
    if (!within(dx, dy, add(FUSE.blastRadius, PLAYER.radius))) continue;
    // Отбрасывает даже неуязвимого: кувырок — унижение, а не урон, и
    // «я увернулся от волны, но меня всё равно снесло» читается честно.
    knockback(s.pVX, s.pVY, p, dx, dy, PLAYER.knockbackSpeed);
    s.pRagdollUntil[p] = s.tick + PLAYER.ragdollTicks;
    s.pFlags[p] |= EntityFlag.Ragdoll;
    damagePlayer(s, p);
  }
}

/** Толчок от точки взрыва. Совпадение с эпицентром толкает вправо, а не в NaN. */
function knockback(vx: Int32Array, vy: Int32Array, i: number, dx: Fx, dy: Fx, speed: Fx): void {
  normalize(dx, dy);
  const nx = normX === 0 && normY === 0 ? 65536 : normX;
  const ny = normX === 0 && normY === 0 ? 0 : normY;
  vx[i] = mul(nx, speed);
  vy[i] = mul(ny, speed);
}

// ---------------------------------------------------------------------------
// Фишки
// ---------------------------------------------------------------------------

export function dropChip(s: SimState, x: Fx, y: Fx): void {
  for (let i = 0; i < MAX_CHIPS; i++) {
    if (s.cActive[i]) continue;
    const angle = nextInt(s.rng, Stream.Loot, ANGLE_FULL);
    s.cX[i] = x;
    s.cY[i] = y;
    s.cVX[i] = mul(cos(angle), CHIP.ejectSpeed);
    s.cVY[i] = mul(sin(angle), CHIP.ejectSpeed);
    s.cValue[i] = CHIP.value;
    s.cDeadline[i] = s.tick + CHIP.lifeTicks;
    s.cActive[i] = 1;
    return;
  }
}

/** Фишки разлетаются, тормозят и подбираются наездом — кнопки они не требуют. */
export function stepChips(s: SimState): void {
  for (let i = 0; i < MAX_CHIPS; i++) {
    if (!s.cActive[i]) continue;

    if (s.tick >= s.cDeadline[i]) {
      s.cActive[i] = 0;
      continue;
    }

    s.cVX[i] = sub(s.cVX[i], mul(s.cVX[i], CHIP.friction));
    s.cVY[i] = sub(s.cVY[i], mul(s.cVY[i], CHIP.friction));
    pushOutOfColumns(s, add(s.cX[i], s.cVX[i]), add(s.cY[i], s.cVY[i]), CHIP.radius);
    s.cX[i] = pushedX;
    s.cY[i] = pushedY;

    for (let p = 0; p < s.playerCount; p++) {
      if ((s.pFlags[p] & EntityFlag.Alive) === 0) continue;
      if (!within(sub(s.cX[i], s.pX[p]), sub(s.cY[i], s.pY[p]), CHIP.pickupRadius)) continue;
      s.pChips[p] += s.cValue[i];
      s.cActive[i] = 0;
      break;
    }
  }
}

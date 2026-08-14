import {
  BETS,
  BetState,
  EntityFlag,
  FX_ONE,
  MAX_ACTIVE_BETS,
  MAX_BALLS,
  MAX_BULLETS,
  MAX_CARDS,
  MAX_CHIPS,
  MAX_ENEMIES,
  Meta,
  bossInPlay,
  cashOutValue,
  nearMissOf,
  progressOf,
  toFloat,
  type SimState,
} from '@dod/sim';
import { BET_STATES, percent } from './constants';
import type { DebugBet, DebugCard, DebugState } from './types';

export function cardsOf(s: SimState): DebugCard[] {
  const out: DebugCard[] = [];
  for (let i = 0; i < MAX_CARDS; i++) {
    if (!s.kActive[i]) continue;
    const spec = BETS[s.kBet[i]];
    out.push({
      i,
      bet: String(spec.id),
      name: spec.name,
      category: spec.category,
      x: toFloat(s.kX[i]),
      y: toFloat(s.kY[i]),
      owner: s.kOwner[i],
      ticksLeft: Math.max(0, s.kDeadline[i] - s.tick),
    });
  }
  return out;
}

/**
 * Пари игрока со всеми числами, которые видно на плашке.
 *
 * Считается ядром, а не здесь: `progressOf`, `cashOutValue` и `nearMissOf` —
 * это те же функции, по которым живут выплаты. Пересчёт «примерно так же» в
 * отладке означал бы, что агент проверяет не игру, а вторую её реализацию.
 */
export function betsOf(s: SimState, player: number): DebugBet[] {
  const out: DebugBet[] = [];
  for (let n = 0; n < MAX_ACTIVE_BETS; n++) {
    const k = player * MAX_ACTIVE_BETS + n;
    const state = s.aState[k] as BetState;
    if (state === BetState.None) continue;
    const spec = BETS[s.aBet[k]];
    out.push({
      slot: n,
      bet: s.aBet[k],
      id: String(spec.id),
      name: spec.name,
      category: spec.category,
      multiplier: spec.multiplier / FX_ONE,
      stake: s.aStake[k],
      state: BET_STATES[state],
      counter: s.aCounter[k],
      target: spec.target,
      q: percent(progressOf(s, player, n)),
      cashOut: state === BetState.Active ? cashOutValue(s, player, n) : 0,
      payout: Math.trunc((s.aStake[k] * spec.multiplier) / FX_ONE),
      nearMiss: percent(nearMissOf(s, player, n)),
    });
  }
  return out;
}

export function snapshot(s: SimState, hash: string, bark: string): DebugState {
  const enemies = [];
  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (!s.eActive[i]) continue;
    enemies.push({
      i,
      type: s.eType[i],
      hp: s.eHP[i],
      x: toFloat(s.eX[i]),
      y: toFloat(s.eY[i]),
      phase: s.ePhase[i],
    });
  }
  let bullets = 0;
  for (let i = 0; i < MAX_BULLETS; i++) if (s.bActive[i]) bullets++;
  let chipsOnFloor = 0;
  for (let i = 0; i < MAX_CHIPS; i++) if (s.cActive[i]) chipsOnFloor++;

  const players = [];
  for (let i = 0; i < s.playerCount; i++) {
    players.push({
      i,
      x: toFloat(s.pX[i]),
      y: toFloat(s.pY[i]),
      vx: toFloat(s.pVX[i]),
      vy: toFloat(s.pVY[i]),
      aimX: toFloat(s.pAimX[i]),
      aimY: toFloat(s.pAimY[i]),
      hearts: s.pHearts[i],
      chips: s.pChips[i],
      alive: (s.pFlags[i] & EntityFlag.Alive) !== 0,
      invulnerable: (s.pFlags[i] & EntityFlag.Invulnerable) !== 0,
      appetite: s.pAppetite[i],
      scheme: s.pScheme[i],
      bets: betsOf(s, i),
    });
  }
  return {
    cards: cardsOf(s),
    tick: s.tick,
    seed: s.seed,
    hash,
    playerCount: s.playerCount,
    floor: s.meta[Meta.Floor],
    room: s.meta[Meta.Room],
    wave: s.meta[Meta.Wave],
    phase: s.meta[Meta.Phase],
    template: s.meta[Meta.Template],
    flip: s.meta[Meta.Flip],
    kills: s.meta[Meta.Kills],
    enemies,
    bullets,
    chipsOnFloor,
    players,
    ace: {
      gesture: s.meta[Meta.AceGesture],
      bark,
      onArena: s.meta[Meta.AceX] !== 0,
      x: toFloat(s.meta[Meta.AceX]),
      y: toFloat(s.meta[Meta.AceY]),
    },
    boss: bossInPlay(s)
      ? {
          phase: s.meta[Meta.BossPhase],
          hp: s.meta[Meta.BossHP],
          maxHp: s.meta[Meta.BossMaxHP],
          balls: Array.from({ length: MAX_BALLS }, (_, i) => ({
            i,
            active: s.ballActive[i] !== 0,
            x: toFloat(s.ballX[i]),
            y: toFloat(s.ballY[i]),
            landAt: s.ballLandAt[i],
          })),
        }
      : null,
  };
}

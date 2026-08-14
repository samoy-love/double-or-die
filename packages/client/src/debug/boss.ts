import {
  BOSS,
  Meta,
  ROOMS_PER_FLOOR,
  bossInPlay,
  bossStunned,
  counterBetRunning,
  damageBoss as hitBoss,
  fallenSector,
  leaveReward,
  startBoss,
} from '@dod/sim';
import type { GameLoop } from '../loop';
import { log } from '../protocol';
import type { DebugApi } from './types';

export function installBoss(api: DebugApi, loop: GameLoop): void {
  Object.assign(api, {
    boss() {
      // Ровно `bossPhase(1)`, и второй реализации у неё нет: прежняя звала
      // `startBoss` при фазе забега `Fight`, а вне боссовой комнаты шаг босса
      // не делает ничего — снятый кадр показывал неподвижного босса.
      api.bossPhase(1);
    },

    bossPhase(n: number) {
      if (!Number.isInteger(n) || n < 1 || n > BOSS.phases) {
        throw new Error(`фаза босса ${n}: нужно целое от 1 до ${BOSS.phases}`);
      }
      const s = loop.state;

      // Босса выпускает ядро тем же путём, что и забег: восьмая комната
      // кончилась — выходит босс. Номер комнаты перед этим ставится вручную, и
      // это единственная подмена здесь: вход в боссову комнату существует
      // только веткой приватного перехода по номеру комнаты, а играть ради
      // кадра восемь настоящих комнат нельзя.
      if (!bossInPlay(s)) {
        s.meta[Meta.Room] = ROOMS_PER_FLOOR;
        leaveReward(s);
        startBoss(s);
      }

      // Фазы переключает только шаг босса: вход «объявить фазу» наружу не
      // выдан намеренно. Законный способ ровно один — снять запас прочности до
      // порога и дать ядру шаг.
      const drop = (pct: number): void => {
        const want = Math.trunc((s.meta[Meta.BossMaxHP] * pct) / 100);
        const hit = s.meta[Meta.BossHP] - want;
        if (hit > 0) hitBoss(s, hit);
        loop.advance(1);
      };

      if (n >= 2 && s.meta[Meta.BossPhase] < 2) drop(BOSS.phaseTwoPct);
      if (n >= 3) {
        // Встречная ставка объявляется раз за бой и обязана разрешиться сама:
        // урон по ней дал бы оглушение, а не третью фазу. Порог третьей фазы
        // поэтому считается уже после её выплаты — запас прочности читается
        // заново, и менять порядок нельзя.
        while (counterBetRunning(s)) loop.advance(1);
        /*
         * Ставка выигрывается не в тот тик, когда СНАРУЖИ перестаёт быть
         * true `counterBetRunning` (`s.tick < CounterBetUntil`), а на шаг
         * позже: `s.tick` растёт ПОСЛЕ `stepBoss` внутри `step()`
         * (`sim.ts`), и `stepCounterBet` разрешает ставку (лечит босса —
         * `boss.ts`, `stepCounterBet`) именно на тике, где `s.tick ===
         * CounterBetUntil`, — том самом, что цикл выше уже не проходит,
         * потому что снаружи в этот момент `counterBetRunning` уже читается
         * ложным. Не досчитав этот тик, третья фаза считала бы порог от
         * ещё не выплаченного лечения — запас прочности выше нужного на
         * `BOSS.counterBetHealPct`, и `drop(phaseThreePct)` ниже бил бы
         * мимо цели вдвое (проверено: 1120 вместо честных 1360 — ровно
         * недостающие 15%).
         */
        if (s.meta[Meta.CounterBetUntil] !== 0) loop.advance(1);
        if (s.meta[Meta.BossPhase] < 3) drop(BOSS.phaseThreePct);
      }

      log('boss_phase', {
        want: n,
        phase: s.meta[Meta.BossPhase],
        hp: s.meta[Meta.BossHP],
        max: s.meta[Meta.BossMaxHP],
        counterBet: counterBetRunning(s),
        broken: s.meta[Meta.CounterBetBroken],
        stunned: bossStunned(s),
        sector: fallenSector(s),
      });
    },

    damageBoss(amount: number) {
      const s = loop.state;
      if (!Number.isInteger(amount) || amount < 1) {
        throw new Error(`урон боссу ${amount}: нужно целое не меньше 1`);
      }
      if (!bossInPlay(s)) {
        throw new Error('босса нет на арене: сначала bossPhase(1)');
      }
      // Срыв встречной ставки и оглушение ставит само ядро: здесь только удар.
      hitBoss(s, amount);
      log('damage_boss', {
        amount,
        hp: s.meta[Meta.BossHP],
        max: s.meta[Meta.BossMaxHP],
        phase: s.meta[Meta.BossPhase],
        broken: s.meta[Meta.CounterBetBroken],
        stunned: bossStunned(s),
        stunUntil: s.meta[Meta.CounterBetUntil],
      });
    },
  } satisfies Partial<DebugApi>);
}

import {
  BETS,
  BetProgress,
  BetState,
  CARD,
  EntityFlag,
  MAX_ACTIVE_BETS,
  MAX_CARDS,
  SHARED,
  TICK_HZ,
  advanceBetId,
  cashOut,
  cashOutValue,
  failBetId,
  fromFloat,
  progressOf,
  putCard,
  settleBets,
  toFloat,
  tryTakeCard,
  type BetId,
} from '@dod/sim';
import type { GameLoop } from '../loop';
import { log } from '../protocol';
import { BET_STATES, betIndex, betSlotOf, percent, playerOf } from './constants';
import { cardsOf } from './snapshot';
import type { DebugApi } from './types';

export function installBets(api: DebugApi, loop: GameLoop): void {
  Object.assign(api, {
    cards: () => cardsOf(loop.state),

    spawnCard(bet: string, x: number, y: number, owner = SHARED) {
      const s = loop.state;
      const i = putCard(
        s,
        betIndex(bet),
        owner,
        s.tick + CARD.lifeTicks,
        fromFloat(x),
        fromFloat(y),
      );
      if (i < 0) {
        log('spawn_card_failed', { bet, x, y, owner });
        return null;
      }
      log('spawn_card', { bet, x, y, owner });
      return cardsOf(s).find((c) => c.i === i) ?? null;
    },

    take(player: number, cardId?: number) {
      const s = loop.state;
      playerOf(s, player);
      if (cardId !== undefined) {
        if (!Number.isInteger(cardId) || cardId < 0 || cardId >= MAX_CARDS) {
          throw new Error(`нет ячейки карты ${cardId}: их ${MAX_CARDS}, номера с 0`);
        }
        if (!s.kActive[cardId]) throw new Error(`карты ${cardId} на арене нет`);
        // Переставляем игрока на карту и дальше идём общим путём. Свой
        // «упрощённый подбор» здесь был бы второй реализацией правил — той,
        // что не знает ни про лимит пари, ни про чужую персональную карту.
        s.pX[player] = s.kX[cardId];
        s.pY[player] = s.kY[cardId];
      }
      const ok = tryTakeCard(s, player);
      log('take', { player, card: cardId ?? -1, ok });
      return ok;
    },

    cashout(player: number, betSlot?: number) {
      const s = loop.state;
      let slot = betSlot ?? -1;
      if (slot < 0) {
        // «Забрать» одной кнопкой берёт самое выгодное — повторяем выбор,
        // чтобы вернуть агенту НОМЕР слота: без него он не поймёт, что ушло.
        let bestValue = 0;
        for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
          if (s.aState[player * MAX_ACTIVE_BETS + i] !== BetState.Active) continue;
          const v = cashOutValue(s, player, i);
          if (slot < 0 || v > bestValue) {
            slot = i;
            bestValue = v;
          }
        }
      }
      if (slot < 0 || s.aState[player * MAX_ACTIVE_BETS + slot] !== BetState.Active) return null;

      // Прогресс снимается ДО обналичивания: после него состояние уже другое.
      const q = percent(progressOf(s, player, slot));
      const payout = cashOut(s, player, slot);
      log('cashout', { player, slot, q, payout });
      return { slot, q, payout };
    },

    takeBet(id: string, player = 0) {
      const s = loop.state;
      const card = api.spawnCard(id, toFloat(s.pX[player]), toFloat(s.pY[player]), player);
      if (!card) return false;
      return api.take(player, card.i);
    },

    failBet(player = 0, betSlot = 0) {
      const s = loop.state;
      playerOf(s, player);
      betSlotOf(betSlot);
      const k = player * MAX_ACTIVE_BETS + betSlot;
      if (s.aState[k] !== BetState.Active) {
        throw new Error(
          `слот ${betSlot} игрока ${player} не активен (${BET_STATES[s.aState[k]]}): сначала takeBet('under_45s')`,
        );
      }
      const bet = s.aBet[k] as BetId;
      const spec = BETS[s.aBet[k]];
      // Прогресс снимается ДО срыва: после него ядро подменило его снимком.
      const q = percent(progressOf(s, player, betSlot));
      // Через ядро: сам `loseBet` приватен, и только этот вход считает
      // near-miss, растит счётчик проигранных и платит Крупье за Ставку.
      failBetId(s, player, bet);
      const form = spec.progress === BetProgress.Time ? 'seconds' : 'percent';
      log('fail_bet', { player, slot: betSlot, bet: String(spec.id), q, form });
      return { slot: betSlot, bet: String(spec.id), q, form };
    },

    winBet(player = 0, betSlot = 0) {
      const s = loop.state;
      playerOf(s, player);
      betSlotOf(betSlot);
      const k = player * MAX_ACTIVE_BETS + betSlot;
      if (s.aState[k] !== BetState.Active) {
        throw new Error(
          `слот ${betSlot} игрока ${player} не активен (${BET_STATES[s.aState[k]]}): сначала takeBet('no_damage')`,
        );
      }
      if ((s.pFlags[player] & EntityFlag.Alive) === 0) {
        throw new Error(`игрок ${player} мёртв, а мёртвый не выигрывает ничего: сначала newRun()`);
      }
      const bet = s.aBet[k] as BetId;
      const spec = BETS[s.aBet[k]];
      // Счётчиковое доводится тем же входом, что и бой: расчёт проверяет
      // счётчик, и «выиграть» здесь значит выполнить условие, а не объявить
      // исход.
      if (spec.progress === BetProgress.Counter && s.aCounter[k] < spec.target) {
        advanceBetId(s, player, bet, spec.target - s.aCounter[k]);
      }
      const before = s.pChips[player];
      // Расчёт комнаты — единственный вход, ставящий «выиграно». Он разрешает
      // ВСЕ слоты всех игроков: другого «выиграть одно пари» в ядре нет, а своя
      // запись состояния обошла бы и выплату, и счётчик, и звук.
      settleBets(s);
      const payout = s.pChips[player] - before;
      log('win_bet', {
        player,
        slot: betSlot,
        bet: String(spec.id),
        state: BET_STATES[s.aState[k]],
        payout,
      });
      return { slot: betSlot, bet: String(spec.id), payout };
    },

    expireCard(cardId: number, secondsLeft = 1.5) {
      const s = loop.state;
      if (!Number.isInteger(cardId) || cardId < 0 || cardId >= MAX_CARDS) {
        throw new Error(`нет ячейки карты ${cardId}: их ${MAX_CARDS}, номера с 0`);
      }
      if (!s.kActive[cardId]) throw new Error(`карты ${cardId} на арене нет`);
      const fadeSeconds = CARD.fadeTicks / TICK_HZ;
      if (!Number.isFinite(secondsLeft) || secondsLeft < 0 || secondsLeft > fadeSeconds) {
        throw new Error(
          `осталось ${secondsLeft} с: луч оседает последние ${fadeSeconds} с, задавайте от 0 до ${fadeSeconds}`,
        );
      }
      const bet = s.kBet[cardId];
      const owner = s.kOwner[cardId];
      const x = s.kX[cardId];
      const y = s.kY[cardId];
      // Срок карте задаёт `putCard` и только он: своей записи в поле срока
      // здесь нет, иначе отладка стала бы вторым местом, знающим, из чего
      // состоит карта. Ячейка перед этим гасится вручную — «убрать ОДНУ карту»
      // ядро не экспортирует (есть только сброс всех восьми), а без неё
      // положилась бы девятая карта рядом с прежней.
      s.kActive[cardId] = 0;
      const i = putCard(s, bet, owner, s.tick + Math.round(secondsLeft * TICK_HZ), x, y);
      if (i < 0) throw new Error('свободной ячейки не нашлось: карта потеряна');
      log('expire_card', { card: i, bet: String(BETS[bet].id), secondsLeft });
      return cardsOf(s).find((c) => c.i === i) ?? null;
    },
  } satisfies Partial<DebugApi>);
}

import {
  CARD,
  Meta,
  aceCardAt,
  aceEnter,
  offerAceBet,
  playAceGesture,
  resetAce,
  startAceToss,
  toFloat,
} from '@dod/sim';
import type { GameLoop } from '../loop';
import { log } from '../protocol';
import { ACE_GESTURES } from './constants';
import type { AceGestureName, DebugApi } from './types';

export function installAce(api: DebugApi, loop: GameLoop): void {
  Object.assign(api, {
    aceBet() {
      offerAceBet(loop.state);
      log('ace_bet', { card: aceCardAt(loop.state) });
    },

    aceOut(on = true) {
      if (typeof on !== 'boolean') {
        throw new Error(`aceOut: ожидалось true или false, пришло «${String(on)}»`);
      }
      const s = loop.state;
      // Сброс ДО выхода не уборка: выход отказывает при исчерпанном бюджете
      // комнаты и в паузе после прошлого ухода — без сброса третий вызов
      // подряд молча не делает ничего.
      resetAce(s);
      if (on && !aceEnter(s)) {
        throw new Error('Крупье не вышел: на арене нет ни одного живого игрока');
      }
      log('ace_out', {
        on,
        onArena: s.meta[Meta.AceX] !== 0,
        x: toFloat(s.meta[Meta.AceX]),
        y: toFloat(s.meta[Meta.AceY]),
        leaveAt: s.meta[Meta.AceLeaveAt],
      });
    },

    aceGesture(name: AceGestureName) {
      const g = ACE_GESTURES[name];
      if (g === undefined) {
        throw new Error(
          `неизвестный жест «${String(name)}»; есть: ${Object.keys(ACE_GESTURES).join(', ')}`,
        );
      }
      const s = loop.state;
      // Тела нет — жеста быть не может: инвариант «жест на пустой арене» валит
      // dev-сборку, и выглядит это как сломанная съёмка.
      if (s.meta[Meta.AceX] === 0) api.aceOut(true);
      // Серия смертей глушит издевательские жесты — милосердие ядра: без
      // сброса палец вниз и овация молча не покажутся.
      s.meta[Meta.DeathStreak] = 0;
      // Жест не перебивает жест — тем же приёмом, что и жест на смерть игрока.
      s.meta[Meta.AceGestureUntil] = 0;
      playAceGesture(s, g);
      log('ace_gesture', {
        name,
        gesture: s.meta[Meta.AceGesture],
        until: s.meta[Meta.AceGestureUntil],
        holdTicks: CARD.gestureTicks,
      });
    },

    aceToss() {
      const s = loop.state;
      // Подброс один за комнату и упирается в тот же бюджет выходов: сброс
      // делает ручку повторяемой.
      resetAce(s);
      if (!startAceToss(s)) {
        throw new Error('подброс невозможен: на арене нет ни одного живого игрока');
      }
      log('ace_toss', {
        tossAt: s.meta[Meta.TossAt],
        telegraphTicks: CARD.aceTelegraphTicks,
        x: toFloat(s.meta[Meta.AceX]),
        y: toFloat(s.meta[Meta.AceY]),
      });
    },

    bark(text: string) {
      if (typeof text !== 'string' || text.trim() === '') {
        throw new Error('bark ждёт непустую строку — реплику Крупье');
      }
      const s = loop.state;
      // Реплика рисуется только внутри блока Крупье: без тела строка не
      // появится вовсе, и агент решит, что ручка сломана.
      if (s.meta[Meta.AceX] === 0) api.aceOut(true);
      // Правится поле клиента, а не ядра: в симуляции реплики не существует —
      // жест сущность ядра, а слова приезжают словарём поверх него.
      loop.feedback.bark = text;
      log('bark', { text, onArena: s.meta[Meta.AceX] !== 0 });
    },
  } satisfies Partial<DebugApi>);
}

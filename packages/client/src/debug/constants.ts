import {
  AceGesture,
  BETS,
  DoorType,
  EnemyType,
  FX_ONE,
  InputScheme,
  MAX_ACTIVE_BETS,
  type SimState,
} from '@dod/sim';
import { PALETTE, type Rgb } from '../palette';

/** Имена врагов для отладки: номер типа в консоли не читается. */
export const ENEMY_TYPES: Record<string, EnemyType> = {
  wedge: EnemyType.Wedge,
  brick: EnemyType.Brick,
  fuse: EnemyType.Fuse,
};

/** Жесты Крупье именами: `aceGesture(5)` в сценарии съёмки не читается. */
export const ACE_GESTURES: Record<string, AceGesture> = {
  yawn: AceGesture.Yawn,
  applaud: AceGesture.Applaud,
  ovation: AceGesture.Ovation,
  thumbs_down: AceGesture.ThumbsDown,
  fidget: AceGesture.Fidget,
  turn_away: AceGesture.TurnAway,
};

/** Схемы ввода именами: от них зависят и глифы, и раскладка карт. */
export const SCHEMES: Record<string, InputScheme> = {
  gamepad: InputScheme.Gamepad,
  keyboard: InputScheme.Keyboard,
  touch: InputScheme.Touch,
};

/** Типы дверей именами: пиктограмма заказывается словом, а не номером. */
export const DOOR_TYPES: Record<string, DoorType> = {
  fight: DoorType.Fight,
  fat: DoorType.Fat,
  shop: DoorType.Shop,
  gift: DoorType.Gift,
  event: DoorType.Event,
  debt_pit: DoorType.DebtPit,
};

/**
 * Цвета экранной вспышки по поводу.
 *
 * Не произвольный цвет аргументом: вспышка обязана совпадать с событием, ради
 * которого её снимают, а свободный цвет дал бы кадр, которого игра не рисует.
 */
export const FLASH_COLOURS: Record<string, Rgb> = {
  danger: PALETTE.danger,
  accent: PALETTE.accent,
  loss: PALETTE.loss,
};

/**
 * Пари по строковому идентификатору из каталога.
 *
 * Ровно та же причина, что у имён врагов: `spawnCard(3, …)` в консоли не
 * читается, а `spawnCard('no_red_zone', …)` читается, и опечатка в нём —
 * внятная ошибка, а не молчаливый промах в соседнее пари. Таблица строится из
 * самого каталога, поэтому новое пари в `content/bets.json` приезжает сюда
 * само и разойтись они не могут.
 */
export const BET_IDS = new Map<string, number>(BETS.map((spec, i) => [String(spec.id), i]));

export function betIndex(id: string): number {
  const i = BET_IDS.get(id);
  if (i === undefined) {
    throw new Error(`неизвестное пари «${id}»; есть: ${[...BET_IDS.keys()].join(', ')}`);
  }
  return i;
}

/**
 * Проверить номер игрока и вернуть его же.
 *
 * Одна проверка на все ручки, берущие игрока: раньше её знала только `give`, а
 * `take` не знала — и вызов с чужим номером молча писал мимо типизированного
 * массива, то есть ручка делала не то, о чём её просили, и об этом молчала.
 */
export function playerOf(s: SimState, player: number): number {
  if (!Number.isInteger(player) || player < 0 || player >= s.playerCount) {
    throw new Error(`нет игрока ${player}: в забеге их ${s.playerCount}, номера с 0`);
  }
  return player;
}

/** Слот пари: проверка одна на `failBet`, `winBet` и всё, что берёт слот. */
export function betSlotOf(slot: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_ACTIVE_BETS) {
    throw new Error(`нет слота пари ${slot}: их ${MAX_ACTIVE_BETS}, номера с 0`);
  }
  return slot;
}

/** Состояние пари словом: `2` в JSON не читается, `won` читается. */
export const BET_STATES = ['none', 'active', 'won', 'lost', 'cashed'] as const;

/** Доля в Q16.16 в проценты: `q` наружу отдаётся человеческим числом. */
export const percent = (fx: number): number => Math.round((fx / FX_ONE) * 100);

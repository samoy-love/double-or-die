/**
 * Отладочный интерфейс для агента.
 *
 * Даёт полный контроль над симуляцией: прошагать ровно n тиков, прочитать
 * состояние, подать ввод, прыгнуть куда угодно. Именно поэтому его НЕТ в
 * продакшене — вырезается на этапе сборки константой `__DEV_BUILD__`, а не
 * проверкой в рантайме: иначе его достанут из бандла.
 *
 * Проверяется в CI функциональным тестом: прод-бандл грузится headless и
 * утверждается `window.__DOD__ === undefined`.
 *
 * Реализация разбита по смыслу под `debug/`: `run` (тик, ввод, съёмка кадра),
 * `economy` (кошелёк, сердца, апгрейды), `bets` (карты и пари), `ace`
 * (Крупье), `boss`, `rooms` (дверь, лавка, Дар, плата), `arena` (враги,
 * телеграф, метки спавна) и `ui` (схема ввода, вспышки, масштаб интерфейса).
 * Ручки внутри одной группы зовут друг друга через общий объект `api` — он
 * собирается прямо здесь и передаётся каждому модулю уже с прежде
 * добавленными методами, поэтому `boss()` может звать `api.bossPhase(1)`, а
 * `takeBet()` — `api.spawnCard()` и `api.take()`.
 */

import type { GameLoop } from './loop';
import { log } from './protocol';
import { BUILD, VERSION, GIT_SHA } from './version';
import { installAce } from './debug/ace';
import { installArena } from './debug/arena';
import { installBets } from './debug/bets';
import { installBoss } from './debug/boss';
import { installEconomy } from './debug/economy';
import { installRooms } from './debug/rooms';
import { installRun } from './debug/run';
import { installUi } from './debug/ui';
import type { DebugApi } from './debug/types';

export type {
  AceGestureName,
  DebugBet,
  DebugCard,
  DebugState,
  DoorName,
  EnemyName,
  FlashName,
  SchemeName,
} from './debug/types';
export type { DebugApi };

export function installDebugApi(loop: GameLoop): void {
  const api = {
    ready: Promise.resolve(),
    build: BUILD,
    version: VERSION,
    sha: GIT_SHA,
  } as DebugApi;

  installRun(api, loop);
  installEconomy(api, loop);
  installBets(api, loop);
  installAce(api, loop);
  installBoss(api, loop);
  installRooms(api, loop);
  installArena(api, loop);
  installUi(api, loop);

  (window as unknown as Record<string, unknown>).__DOD__ = api;
  log('debug_api_ready', { build: BUILD });
}

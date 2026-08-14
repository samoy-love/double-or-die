import { SCHEME_SHIFT } from '@dod/sim';
import type { GameLoop } from '../loop';
import { log } from '../protocol';
import { FLASH_COLOURS, SCHEMES, playerOf } from './constants';
import type { DebugApi, FlashName, SchemeName } from './types';

export function installUi(api: DebugApi, loop: GameLoop): void {
  Object.assign(api, {
    mute(on = true) {
      loop.audio.setMuted(on);
    },

    scheme(player: number, name: SchemeName) {
      const s = loop.state;
      playerOf(s, player);
      const v = SCHEMES[name];
      if (v === undefined) {
        throw new Error(
          `неизвестная схема ввода «${String(name)}»; есть: ${Object.keys(SCHEMES).join(', ')}`,
        );
      }
      // У первого игрока — через живой ввод клиента: подсказки меню, паузы и
      // HUD рисуются по нему, а не по битам кадра, и одной подмены бит для
      // кадра с глифами пада не хватает. Схема по определению свойство
      // клиента, ядро её только зеркалит.
      //
      // У остальных живого ввода нет вовсе, и остаётся вход ядра — биты кадра.
      // Прямая запись схемы в состояние затёрлась бы следующим же тиком.
      if (player === 0) loop.setScheme(v);
      else api.input(player, { buttons: v << SCHEME_SHIFT });
      log('scheme', { player, name, scheme: v });
    },

    uiScale(percent: number) {
      // Своя проверка нужна потому, что клиент зажимает диапазон молча: 200 в
      // сценарии съёмки обязано быть ошибкой, а не тихими 150 в кадре.
      if (!Number.isFinite(percent) || percent < 100 || percent > 150) {
        throw new Error(`масштаб интерфейса ${percent}%: допустимо от 100 до 150`);
      }
      loop.setUiScale(percent);
      log('ui_scale', { percent: Math.round(percent) });
    },

    cashoutFocus(on = true) {
      if (typeof on !== 'boolean') {
        throw new Error(`поштучный забор: ожидалось true или false, пришло «${String(on)}»`);
      }
      // Тот же вызов, которым настройку применяет загрузка профиля: ядро о ней
      // узнаёт кадром, где цель забора кодируется только при включённом флаге.
      loop.setCashOutFocusedOnly(on);
      log('cashout_focus', { on, target: loop.menuState.cashOutTarget });
    },

    openTutorial() {
      // Ровно тот путь, которым справку открывает первый забег.
      loop.openTutorial();
      log('open_tutorial', {});
    },

    flash(kind: FlashName = 'danger', alpha = 0.3) {
      const colour = FLASH_COLOURS[kind];
      if (colour === undefined) {
        throw new Error(
          `неизвестная вспышка «${String(kind)}»; есть: ${Object.keys(FLASH_COLOURS).join(', ')}`,
        );
      }
      if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
        throw new Error(`непрозрачность вспышки ${alpha}: допустимо больше 0 и не больше 1`);
      }
      // Правится состояние обратной связи клиента, и входа ядра здесь нет по
      // правилу «ядро ничего не знает о рендере».
      loop.feel.debugFlash(colour, alpha);
      log('flash', { kind, alpha });
    },
  } satisfies Partial<DebugApi>);
}

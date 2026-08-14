import {
  MAX_DOORS,
  Meta,
  ROOMS_PER_FLOOR,
  RunPhase,
  SHOP_SLOTS,
  WAVE,
  buyUpgrade,
  enterHouseCut,
  giftOpen,
  offerDoors,
  openGift,
  openShop,
  startRoom,
} from '@dod/sim';
import type { GameLoop } from '../loop';
import { log } from '../protocol';
import { DOOR_TYPES, playerOf } from './constants';
import type { DebugApi, DoorName } from './types';

export function installRooms(api: DebugApi, loop: GameLoop): void {
  Object.assign(api, {
    buy(slot: number, player = 0) {
      const s = loop.state;
      playerOf(s, player);
      if (!Number.isInteger(slot) || slot < 0 || slot >= SHOP_SLOTS) {
        throw new Error(`слот ${slot}: на прилавке их ${SHOP_SLOTS}, номера с 0`);
      }
      if (s.meta[Meta.Phase] !== RunPhase.Reward) {
        throw new Error('прилавка нет: сначала shop() или gift()');
      }
      if (s.shopItem[slot] === 0) throw new Error(`слот ${slot} уже пуст`);
      // Покупка идёт ровно тем же входом, что подтверждение на экране награды:
      // цена, потолок слотов и очистка пары «товар — цена» — правила ядра, а не
      // отладки. Их вторая реализация здесь оставила бы «цену без товара», на
      // которой забег встаёт по инварианту.
      const ok = buyUpgrade(s, player, slot);
      log('buy', {
        player,
        slot,
        ok,
        gift: giftOpen(s),
        items: [...s.shopItem],
        prices: [...s.shopPrice],
      });
      return ok;
    },

    houseCut() {
      enterHouseCut(loop.state);
      log('house_cut', { floor: loop.state.meta[Meta.Floor], cut: loop.state.meta[Meta.HouseCut] });
    },

    door() {
      offerDoors(loop.state);
      log('door', { types: [...loop.state.doorType] });
    },

    gift() {
      openGift(loop.state);
      log('gift', { items: [...loop.state.shopItem] });
    },

    toMenu() {
      loop.backToMenu();
      log('to_menu', {});
    },

    learned() {
      loop.coach.teachAll();
    },

    forget() {
      loop.coach.forget();
    },

    teach(id: string) {
      loop.coach.teach(id);
    },

    shop() {
      openShop(loop.state);
      log('shop', { items: [...loop.state.shopItem], prices: [...loop.state.shopPrice] });
    },

    settle() {
      // Пауза между волнами — это `NextWaveAt` в будущем: расчёт показывается
      // ровно тогда, когда следующая волна ещё не пришла.
      const s = loop.state;
      s.meta[Meta.NextWaveAt] = s.tick + WAVE.roomGapTicks;
      log('settle', { until: s.meta[Meta.NextWaveAt] });
    },

    setRoom(n: number) {
      const s = loop.state;
      if (!Number.isInteger(n) || n < 1 || n > ROOMS_PER_FLOOR) {
        throw new Error(`номер комнаты ${n}: на этаже их ${ROOMS_PER_FLOOR}, считая с 1`);
      }
      if (s.meta[Meta.Phase] !== RunPhase.Fight) {
        throw new Error('комната ставится только в бою: фаза сейчас другая');
      }
      // Вход ядра: начало комнаты делает ВСЁ, что делает настоящий переход, —
      // расчёт прошлой комнаты, новая арена, бюджет угрозы, раздача карт.
      // Прямая запись номера оставила бы бюджет, шаблон и раздачу от прошлой
      // комнаты, то есть кадр состояния, которого в игре не бывает.
      startRoom(s, n);
      log('set_room', {
        room: s.meta[Meta.Room],
        type: s.meta[Meta.RoomType],
        threat: s.meta[Meta.RoomThreat],
        nextWaveAt: s.meta[Meta.NextWaveAt],
      });
    },

    doorTypes(list: readonly DoorName[]) {
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error(
          `doorTypes ждёт непустой список типов; есть: ${Object.keys(DOOR_TYPES).join(', ')}`,
        );
      }
      if (list.length > MAX_DOORS) {
        throw new Error(
          `дверей на экране ${MAX_DOORS}, а типов передано ${list.length}: шесть пиктограмм снимаются двумя кадрами`,
        );
      }
      const types = list.map((name) => {
        const t = DOOR_TYPES[name as string];
        if (t === undefined) {
          throw new Error(
            `неизвестный тип двери «${String(name)}»; есть: ${Object.keys(DOOR_TYPES).join(', ')}`,
          );
        }
        return t;
      });
      const s = loop.state;
      // Экран открывается входом ядра целиком — фаза, часы, сброс выбора и
      // аппетита. Типы после этого подменяются, и обойти это нечем: они
      // приходят из потока раскладки по весам, «Событие» весит ноль, повтор
      // типа запрещён, а заказ конкретного набора — правило раскладки, а не
      // отладочный вход, и заводить его в ядре ради снимка нельзя.
      //
      // Порядок именно такой: при живом долге ядро само перебивает последнюю
      // дверь на Долговую яму, и обратный порядок молча вернул бы случайный
      // набор.
      offerDoors(s);
      for (let i = 0; i < types.length; i++) s.doorType[i] = types[i];
      log('door_types', { types: [...list], doorType: [...s.doorType] });
    },
  } satisfies Partial<DebugApi>);
}

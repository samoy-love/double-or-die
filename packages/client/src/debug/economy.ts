import {
  Curse,
  EntityFlag,
  Meta,
  PLAYER,
  UPGRADE,
  UPGRADES,
  damagePlayer,
  endRun,
  grantUpgrade,
} from '@dod/sim';
import type { GameLoop } from '../loop';
import { log } from '../protocol';
import { playerOf } from './constants';
import type { DebugApi } from './types';

export function installEconomy(api: DebugApi, loop: GameLoop): void {
  Object.assign(api, {
    give(o: { chips?: number; hearts?: number }, player = 0) {
      const s = loop.state;
      playerOf(s, player);
      if (o.chips !== undefined) s.pChips[player] += o.chips;
      if (o.hearts !== undefined) s.pHearts[player] += o.hearts;
      log('give', { player, chips: o.chips ?? 0, hearts: o.hearts ?? 0 });
    },

    setChips(player: number, n: number) {
      const s = loop.state;
      playerOf(s, player);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error(`фишек ${n}: нужно целое не меньше нуля`);
      }
      // Прямая запись поля, и обойти её нечем: «положить в кошелёк ровно N»
      // ядро не экспортирует вовсе — кошелёк меняют только подбор фишки,
      // списание кона, выплата и доля заведения, и каждый из них прибавляет
      // или отнимает по своей причине, таща за собой побочные действия.
      // Единственный контракт кошелька — неотрицательность, и её проверка
      // выше держит.
      s.pChips[player] = n;
      log('set_chips', { player, chips: n });
    },

    setHearts(player: number, n: number) {
      const s = loop.state;
      playerOf(s, player);
      if (!Number.isInteger(n) || n < 0 || n > UPGRADE.maxHearts) {
        throw new Error(`сердец ${n}: допустимо от 0 до ${UPGRADE.maxHearts}`);
      }
      // ВНИЗ — только уроном ядра: `damagePlayer` снимает по сердцу и тянет за
      // собой всё, что на уроне висит (срыв «Без урона», жест Крупье, расчёт
      // пари при гибели). Прямая запись меньшего числа дала бы состояние,
      // которого в игре не бывает: ноль сердец у живого игрока — остановка по
      // инварианту.
      while (s.pHearts[player] > n && (s.pFlags[player] & EntityFlag.Alive) !== 0) {
        s.pInvulUntil[player] = 0;
        s.pFlags[player] &= ~EntityFlag.Invulnerable;
        damagePlayer(s, player);
      }
      // ВВЕРХ — прямой записью с тем же потолком, что у передышки на изломе и
      // у сердца из лавки: входа «вылечить» ядро не экспортирует, лечение живёт
      // двумя инлайн-клампами внутри своих модулей.
      if (s.pHearts[player] < n && (s.pFlags[player] & EntityFlag.Alive) !== 0) {
        s.pHearts[player] = n;
      }
      log('set_hearts', {
        player,
        hearts: s.pHearts[player],
        alive: (s.pFlags[player] & EntityFlag.Alive) !== 0,
      });
    },

    setAppetite(player: number, tier: number) {
      if (tier < 0 || tier > 2) throw new Error(`аппетит ${tier}: есть 0, 1 и 2`);
      loop.setAppetite(player, tier);
      // Немедленно, а не со следующего тика: агент вызывает setAppetite и
      // тут же take(), и кон обязан списаться уже новый.
      loop.state.pAppetite[player] = tier;
      log('set_appetite', { player, tier });
    },

    giveUpgrade(id: string) {
      const index = UPGRADES.findIndex((u) => String(u.id) === id);
      if (index < 0) {
        throw new Error(
          `неизвестный апгрейд «${id}»; есть: ${UPGRADES.map((u) => String(u.id)).join(', ')}`,
        );
      }
      // Индекс отдаётся как есть: `grantUpgrade` нумерует апгрейды с нуля и
      // сама сдвигает номер на единицу при записи в слот. Прежний `index + 1`
      // выдавал СОСЕДНИЙ апгрейд, а последний в каталоге не выдавался вовсе —
      // и торг снимался с товаром, о котором его не просили.
      const ok = grantUpgrade(loop.state, 0, index);
      log('give_upgrade', { id, ok });
      return ok;
    },

    curse(id: number, debt = 0) {
      // Номер вне каталога раньше проходил молча, и строка статуса выходила
      // пустой: у HUD нет имени для седьмого проклятия, а у ядра — правила.
      // Ноль оставлен допустимым намеренно — это «проклятия нет», и им же
      // снимается кадр чистой строки статуса.
      if (!Number.isInteger(id) || id < Curse.None || id > Curse.Commission) {
        throw new Error(
          `нет проклятия ${id}: их ${Curse.Commission}, номера с 1 (0 — «проклятия нет»)`,
        );
      }
      if (!Number.isInteger(debt) || debt < 0) {
        throw new Error(`долг ${debt}: нужно целое не меньше нуля`);
      }
      loop.state.meta[Meta.Curse] = id;
      // Шесть проклятий (GDD §11) читают не только Meta.Curse, но и
      // Meta.CurseRoom === 1 — «эта комната проклята прямо сейчас», а не
      // «проклятие где-то на заходе». Без него ручка ставила только имя в
      // HUD: ни урон, ни скорость врагов, ни блок рывка/подбора, ни срез
      // выплаты, ни виньетка не срабатывали — кадры каталога снимали
      // название угрозы без самой угрозы. id === Curse.None (снять
      // проклятие) оставляет CurseRoom нулём — это не начало комнаты, а её
      // конец.
      loop.state.meta[Meta.CurseRoom] = id === Curse.None ? 0 : 1;
      loop.state.meta[Meta.Debt] = debt;
      log('curse', { curse: id, curseRoom: loop.state.meta[Meta.CurseRoom], debt });
    },

    kill(player = 0) {
      const s = loop.state;
      playerOf(s, player);
      // Бьём столько раз, сколько сердец: `damagePlayer` снимает по одному и
      // уважает неуязвимость, поэтому «убить» — это не одно попадание.
      //
      // Снимать надо И срок неуязвимости, И её флаг. Прежняя версия гасила
      // только срок, а флаг ставит сам `damagePlayer` — поэтому за весь вызов
      // уходило ровно одно сердце, игрок оставался жив, и «убитый» кадр
      // показывал живого. Молчаливо: ручка ничего не возвращала.
      for (
        let i = 0;
        i < PLAYER.startHearts + 4 && (s.pFlags[player] & EntityFlag.Alive) !== 0;
        i++
      ) {
        s.pInvulUntil[player] = 0;
        s.pFlags[player] &= ~EntityFlag.Invulnerable;
        damagePlayer(s, player);
      }
      const alive = (s.pFlags[player] & EntityFlag.Alive) !== 0;
      log('kill', { player, alive, hearts: s.pHearts[player] });
      if (alive) throw new Error(`игрок ${player} пережил kill(): сердец ${s.pHearts[player]}`);
    },

    win() {
      endRun(loop.state, true);
      log('win', {});
    },
  } satisfies Partial<DebugApi>);
}

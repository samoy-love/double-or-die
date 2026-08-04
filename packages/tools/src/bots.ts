/**
 * Боты — не искусственный интеллект, а явно заданные стратегии для проверки
 * систем. `idle` доказывает, что игра не зависает сама по себе; `random` ищет
 * состояния, до которых человек не додумается.
 *
 * Боты живут в инструментах, а не в ядре: они порождают ввод, а не логику.
 */

import {
  type InputFrame,
  type SimState,
  BetState,
  Btn,
  Stream,
  createStreams,
  fromFloat,
  fromInt,
  makeFrame,
  nextInt,
  MAX_ACTIVE_BETS,
  MAX_CARDS,
  MAX_ENEMIES,
  SHARED,
  toFloat,
  type RngState,
} from '@dod/sim';

/**
 * Аппетит «По-крупному» — верхний тир, биты 8–9 маски (TECH §6).
 *
 * Тир 2 это только старший бит: `AppetiteLo | AppetiteHi` дали бы 3, а тиров
 * три, и лишний бит превратился бы в неопределённое поведение.
 */
const APPETITE_HIGH = Btn.AppetiteHi;

/**
 * Известные профили. Список экспортируется, а не живёт только в типе: разбор
 * аргументов обязан назвать варианты в сообщении об ошибке, а тип во время
 * выполнения не существует. Опечатка в `--bot`, молча упавшая в `idle`, —
 * это прогон, который ничего не проверил и об этом не сказал.
 */
export const BOT_NAMES = ['idle', 'random', 'greedy', 'cautious'] as const;

export type BotName = (typeof BOT_NAMES)[number];

export const isBotName = (s: string): s is BotName => (BOT_NAMES as readonly string[]).includes(s);

export interface Bot {
  inputs(s: SimState): readonly InputFrame[];
}

class IdleBot implements Bot {
  private readonly frames: InputFrame[];
  constructor(players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
  }
  inputs(): readonly InputFrame[] {
    return this.frames;
  }
}

class RandomBot implements Bot {
  private readonly frames: InputFrame[];
  private readonly rng: RngState;

  constructor(seed: number, players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
    // Отдельный от симуляции генератор: ввод бота — это внешний источник,
    // и он не должен сдвигать потоки самой игры.
    this.rng = createStreams(seed ^ 0x5eed);
  }

  inputs(s: SimState): readonly InputFrame[] {
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      // Меняем направление не каждый тик: иначе бот дрожит на месте и
      // не доходит до краёв арены, где и живут интересные баги.
      if (s.tick % 20 === 0) {
        f.moveX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.moveY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.aimX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.aimY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
      }
      // Кнопки тоже держатся, а не дёргаются каждый тик. Причин две.
      // Живой игрок удерживает огонь, и лог, где кнопка меняется 60 раз в
      // секунду, не похож ни на один настоящий забег. А ещё именно на нём
      // ломается RLE-сжатие реплея: повторов не остаётся вовсе, и эталон
      // раздувается с десятков килобайт до сотен.
      if (s.tick % 10 === 0) {
        f.buttons = 0;
        if (nextInt(this.rng, Stream.Waves, 100) < 40) f.buttons |= Btn.Fire;
        if (nextInt(this.rng, Stream.Waves, 100) < 3) f.buttons |= Btn.Dash;
      }
    }
    return this.frames;
  }
}

/**
 * Жадный (`наглый` из SIMULATION §3): собирает все карты, играет «По-крупному»,
 * не обналичивает никогда.
 *
 * Это не «умный игрок», а явно заданная стратегия — верхняя граница ставочного
 * поведения. Ею проверяется, что экономика не разваливается от максимального
 * стака: кон списывается за каждую карту, и упереться в пустой кошелёк такой
 * бот обязан сам, без запретов в коде.
 *
 * Верхний тир аппетита — половина профиля, а не украшение. Без него бот играл
 * бы тиром «Скромно», то есть минимальным коном, и `--runs 500 --bot greedy` из
 * плана 0.3.0 проверял бы совсем не ту границу, которую в нём читают.
 */
class GreedyBot implements Bot {
  private readonly frames: InputFrame[];
  private readonly rng: RngState;

  constructor(seed: number, players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
    this.rng = createStreams(seed ^ 0x9eed);
  }

  inputs(s: SimState): readonly InputFrame[] {
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      const px = toFloat(s.pX[i]);
      const py = toFloat(s.pY[i]);

      // Идём к ближайшей доступной карте: карта — это место, и весь смысл
      // жадности в том, чтобы за ней бежать.
      let cx = 0;
      let cy = 0;
      let best = Infinity;
      for (let c = 0; c < MAX_CARDS; c++) {
        if (!s.kActive[c]) continue;
        if (s.kOwner[c] !== SHARED && s.kOwner[c] !== i) continue;
        const dx = toFloat(s.kX[c]) - px;
        const dy = toFloat(s.kY[c]) - py;
        const d = Math.hypot(dx, dy);
        if (d < best) {
          best = d;
          cx = dx;
          cy = dy;
        }
      }

      // Аппетит выставляется каждый тик, а не однажды на старте. Ядро
      // применяет его защёлкой — по ненулевым битам, и держит до следующего
      // явного нажатия, — но полагаться на то, что защёлка переживёт смену
      // комнаты или барьер старта, бот не имеет права: он объявляет свой тир
      // сам и постоянно.
      f.buttons = Btn.Fire | APPETITE_HIGH;
      if (best < Infinity) {
        const len = best || 1;
        f.moveX = fromFloat(cx / len);
        f.moveY = fromFloat(cy / len);
        // Кнопку жмём по фронту: подбор дискретен, и держать её бессмысленно.
        if (best < 60 && s.tick % 4 === 0) f.buttons |= Btn.Take;
      } else if (s.tick % 30 === 0) {
        f.moveX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.moveY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
      }

      // Целимся в ближайшего врага: жадный не пацифист.
      let ex = 1;
      let ey = 0;
      let near = Infinity;
      for (let e = 0; e < MAX_ENEMIES; e++) {
        if (!s.eActive[e]) continue;
        const dx = toFloat(s.eX[e]) - px;
        const dy = toFloat(s.eY[e]) - py;
        const d = Math.hypot(dx, dy);
        if (d < near) {
          near = d;
          ex = dx;
          ey = dy;
        }
      }
      const elen = near === Infinity ? 1 : near || 1;
      f.aimX = fromFloat(ex / elen);
      f.aimY = fromFloat(ey / elen);
    }
    return this.frames;
  }
}

/**
 * Осторожный (`осторожный` из SIMULATION §3): одна ближняя карта, тир
 * «Скромно», обналичивает рано.
 *
 * Заведён ради ограничителя G14 — доля пари, закрытых через «Забрать», обязана
 * лежать в коридоре 15–35% (ECONOMY §13). Проверить его было нечем: `idle` и
 * `random` карт не берут осмысленно, а `greedy` не обналичивает никогда, и
 * доля выходила ровно нулевой при любом балансе. Ограничитель, который
 * невозможно нарушить, не ограничивает ничего.
 *
 * Тир «Скромно» — нулевой, то есть пустые биты аппетита. Это не «бот забыл
 * нажать»: нулевой тир в маске неотличим от «не нажимал», и такова маска
 * (TECH §6). Ядро трактует пустые биты как «оставить как есть», а исходное
 * состояние и есть «Скромно», — профиль сходится. Появись когда-нибудь
 * ненулевой тир по умолчанию, здесь понадобится явное нажатие, и маске
 * придётся научиться отличать одно от другого.
 */
class CautiousBot implements Bot {
  private readonly frames: InputFrame[];
  private readonly rng: RngState;

  /** Тик, после которого пари считается «подержанным достаточно». */
  private static readonly HOLD_TICKS = 150;

  constructor(seed: number, players: number) {
    this.frames = Array.from({ length: players }, makeFrame);
    this.rng = createStreams(seed ^ 0xcafe);
  }

  /** Сколько пари сейчас держит игрок и когда взято самое старое. */
  private static bets(s: SimState, player: number): { count: number; oldest: number } {
    let count = 0;
    let oldest = Infinity;
    for (let n = 0; n < MAX_ACTIVE_BETS; n++) {
      const k = player * MAX_ACTIVE_BETS + n;
      if (s.aState[k] !== BetState.Active) continue;
      count++;
      if (s.aTakenAt[k] < oldest) oldest = s.aTakenAt[k];
    }
    return { count, oldest };
  }

  inputs(s: SimState): readonly InputFrame[] {
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      const px = toFloat(s.pX[i]);
      const py = toFloat(s.pY[i]);
      const { count, oldest } = CautiousBot.bets(s, i);

      f.buttons = Btn.Fire;

      // Одна карта за раз: держать стак осторожный не станет. За второй он
      // не идёт вовсе, поэтому и путь в опасную зону не выбирает.
      let cx = 0;
      let cy = 0;
      let best = Infinity;
      if (count === 0) {
        for (let c = 0; c < MAX_CARDS; c++) {
          if (!s.kActive[c]) continue;
          if (s.kOwner[c] !== SHARED && s.kOwner[c] !== i) continue;
          const dx = toFloat(s.kX[c]) - px;
          const dy = toFloat(s.kY[c]) - py;
          const d = Math.hypot(dx, dy);
          if (d < best) {
            best = d;
            cx = dx;
            cy = dy;
          }
        }
      }

      if (best < Infinity) {
        const len = best || 1;
        f.moveX = fromFloat(cx / len);
        f.moveY = fromFloat(cy / len);
        if (best < 60 && s.tick % 4 === 0) f.buttons |= Btn.Take;
      } else if (s.tick % 30 === 0) {
        f.moveX = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
        f.moveY = fromInt(nextInt(this.rng, Stream.Waves, 3) - 1);
      }

      // «Рано» — это до того, как прогресс успел вырасти: осторожный берёт
      // синицу. Кнопка дискретна, поэтому жмём по фронту, а не удержанием.
      if (count > 0 && s.tick - oldest >= CautiousBot.HOLD_TICKS && s.tick % 6 === 0) {
        f.buttons |= Btn.CashOut;
      }

      // Целимся в ближайшего врага: осторожный — не пацифист, он просто не
      // жадный.
      let ex = 1;
      let ey = 0;
      let near = Infinity;
      for (let e = 0; e < MAX_ENEMIES; e++) {
        if (!s.eActive[e]) continue;
        const dx = toFloat(s.eX[e]) - px;
        const dy = toFloat(s.eY[e]) - py;
        const d = Math.hypot(dx, dy);
        if (d < near) {
          near = d;
          ex = dx;
          ey = dy;
        }
      }
      const elen = near === Infinity ? 1 : near || 1;
      f.aimX = fromFloat(ex / elen);
      f.aimY = fromFloat(ey / elen);
    }
    return this.frames;
  }
}

export function makeBot(name: BotName, seed: number, players: number): Bot {
  switch (name) {
    case 'greedy':
      return new GreedyBot(seed, players);
    case 'cautious':
      return new CautiousBot(seed, players);
    case 'random':
      return new RandomBot(seed, players);
    case 'idle':
    default:
      return new IdleBot(players);
  }
}

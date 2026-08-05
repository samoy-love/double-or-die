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
 */

import {
  BETS,
  BetState,
  CARD,
  EnemyType,
  EntityFlag,
  FX_ONE,
  MAX_ACTIVE_BETS,
  MAX_BULLETS,
  MAX_CARDS,
  MAX_CHIPS,
  MAX_ENEMIES,
  Meta,
  SHARED,
  cashOut,
  cashOutValue,
  clearArena,
  fromFloat,
  nearMissOf,
  progressOf,
  putCard,
  setSpawning,
  spawnEnemy,
  toFloat,
  tryTakeCard,
  type SimState,
} from '@dod/sim';
import { serialize } from '@dod/sim/replay';
import type { SimEvent } from './events';
import type { GameLoop } from './loop';
import { log } from './protocol';
import { BUILD, VERSION, GIT_SHA } from './version';

/** Имена врагов для отладки: номер типа в консоли не читается. */
const ENEMY_TYPES: Record<string, EnemyType> = {
  wedge: EnemyType.Wedge,
  brick: EnemyType.Brick,
  fuse: EnemyType.Fuse,
};

export type EnemyName = keyof typeof ENEMY_TYPES;

/**
 * Пари по строковому идентификатору из каталога.
 *
 * Ровно та же причина, что у имён врагов: `spawnCard(3, …)` в консоли не
 * читается, а `spawnCard('no_red_zone', …)` читается, и опечатка в нём —
 * внятная ошибка, а не молчаливый промах в соседнее пари. Таблица строится из
 * самого каталога, поэтому новое пари в `content/bets.json` приезжает сюда
 * само и разойтись они не могут.
 */
const BET_IDS = new Map<string, number>(BETS.map((spec, i) => [String(spec.id), i]));

function betIndex(id: string): number {
  const i = BET_IDS.get(id);
  if (i === undefined) {
    throw new Error(`неизвестное пари «${id}»; есть: ${[...BET_IDS.keys()].join(', ')}`);
  }
  return i;
}

/** Состояние пари словом: `2` в JSON не читается, `won` читается. */
const BET_STATES = ['none', 'active', 'won', 'lost', 'cashed'] as const;

/** Доля в Q16.16 в проценты: `q` наружу отдаётся человеческим числом. */
const percent = (fx: number): number => Math.round((fx / FX_ONE) * 100);

/** Карта, лежащая на арене. */
export interface DebugCard {
  /** Индекс ячейки в пуле: им же карта берётся через `take`. */
  i: number;
  /** Строковый идентификатор пари и его человеческое имя. */
  bet: string;
  name: string;
  category: number;
  x: number;
  y: number;
  /** Номер игрока-владельца или −1 у общей. */
  owner: number;
  /** Сколько тиков карте осталось лежать. */
  ticksLeft: number;
}

/**
 * Активное пари игрока.
 *
 * Всё, что видно на экране, обязано быть доступно как JSON (DEVLOOP §7), а на
 * плашке пари видно ровно это: категория, кон, состояние, счётчик, растущая
 * потенциальная выплата и — у сорванного — насколько близко было.
 */
export interface DebugBet {
  /** Номер слота у игрока: им пари обналичивается через `cashout`. */
  slot: number;
  /** Индекс в каталоге и его строковый идентификатор. */
  bet: number;
  id: string;
  name: string;
  category: number;
  /** Множитель обычным числом, не в Q16.16. */
  multiplier: number;
  stake: number;
  state: (typeof BET_STATES)[number];
  counter: number;
  /** Цель счётчикового пари. Ноль — не счётчиковое. */
  target: number;
  /** Прогресс `q` в процентах (ECONOMY §9А). */
  q: number;
  /** Сколько дадут прямо сейчас за «Забрать». */
  cashOut: number;
  /** Сколько дадут, если дожать. */
  payout: number;
  /** Насколько близко было, в процентах. */
  nearMiss: number;
}

export interface DebugState {
  tick: number;
  seed: number;
  hash: string;
  playerCount: number;
  /** Ход забега: комната, волна, счёт убийств. */
  /** Номер этажа, с единицы. Комната нумеруется ВНУТРИ него. */
  floor: number;
  room: number;
  wave: number;
  /** Фаза забега: дверь, бой, расчёт, награда, босс, плата, итоги. */
  phase: number;
  /** Раскладка арены: номер шаблона и его отражение (0..3). */
  template: number;
  flip: number;
  kills: number;
  enemies: { i: number; type: number; hp: number; x: number; y: number; phase: number }[];
  bullets: number;
  chipsOnFloor: number;
  players: {
    i: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
    aimX: number;
    aimY: number;
    hearts: number;
    chips: number;
    alive: boolean;
    invulnerable: boolean;
    /** Тир кона, выбранный до входа в комнату. */
    appetite: number;
    /**
     * Схема ввода этого игрока: 0 геймпад, 1 клавиатура, 2 тач.
     *
     * Наружу отдаётся потому, что от неё зависит раскладка карт (матрица
     * «пари × схема», GDD §9.5), а проверить её иначе нечем: схема приезжает
     * кадром ввода и в живой игре меняется молча.
     */
    scheme: number;
    /** Активные и уже разрешённые пари этого игрока. */
    bets: DebugBet[];
  }[];
  /** Карты, лежащие на арене прямо сейчас. */
  cards: DebugCard[];
  /**
   * Чем занят Туз: жест и реплика под ним.
   *
   * В кадре реплики пока нет — текст приезжает со шрифтом в стадии F2, — а
   * проверять правило дозировки надо уже сейчас: «чем сильнее игрок
   * пострадал, тем мягче» ловится только на живом забеге, не в юните.
   *
   * Присутствие и точка стояния отдаются вместе с жестом, и это не полнота
   * ради полноты. Отладочному интерфейсу нечем было ответить на вопрос «Туз
   * сейчас на арене?» — а именно он и оказался нужен, когда владелец сказал,
   * что Туза не видно: без этого признака нельзя ни отличить «его нет» от «он
   * есть, но неразличим», ни поставить проверку на видимость.
   */
  ace: { gesture: number; bark: string; onArena: boolean; x: number; y: number };
}

export interface DebugApi {
  readonly ready: Promise<void>;
  readonly build: string;
  readonly version: string;
  readonly sha: string;
  newRun(o?: { seed?: number; players?: number }): void;
  tick(n?: number): void;
  /**
   * Подать ввод за игрока. Значения направлений — обычные числа −1..1,
   * `buttons` — маска Btn. `null` снимает подмену.
   */
  input(
    player: number,
    frame: { move?: [number, number]; aim?: [number, number]; buttons?: number } | null,
  ): void;
  play(): void;
  pause(): void;
  isPaused(): boolean;
  state(): DebugState;
  hash(): string;
  perf(): { fps: number; particles: number; shapes: number; dropped: number };
  /** Поставить врагов вокруг игрока. Без волн — ровно тех, кого попросили. */
  spawn(type: EnemyName, count?: number): void;
  /** Убрать с арены всё, кроме игроков. */
  clear(): void;
  /** Включить или выключить пополнение арены волнами. */
  waves(on?: boolean): void;
  /**
   * Выдать ресурсы: отладка экономики без десяти минут игры.
   *
   * Номер игрока необязателен и по умолчанию нулевой — но обязан быть: в
   * коопе «выдать фишки» без адресата проверяет ровно один сценарий из
   * четырёх, а кооп-экономика (общая доля заведения, ставки на напарника)
   * начинается там, где кошельки разные.
   */
  give(o: { chips?: number; hearts?: number }, player?: number): void;

  // --- Пари: версия называется «Ставка», и отладка обязана её доставать ---

  /** Что сейчас лежит на арене: пари, место, владелец, оставшиеся тики. */
  cards(): DebugCard[];
  /**
   * Положить карту в названную точку. Без владельца — общая.
   *
   * Пари задаётся строкой из каталога (`no_damage`, `under_45s`, …).
   */
  spawnCard(bet: string, x: number, y: number, owner?: number): DebugCard | null;
  /**
   * Подобрать карту от лица игрока.
   *
   * Без номера карты — та, на которой игрок стоит, ровно как в бою. С
   * номером игрок сначала переставляется на карту: подбор всё равно идёт
   * через ядро, поэтому и лимит пари, и чужая персональная карта, и списание
   * кона работают как в настоящей игре.
   */
  take(player: number, cardId?: number): boolean;
  /** Обналичить пари. Без номера слота — самое выгодное. */
  cashout(player: number, betSlot?: number): { slot: number; q: number; payout: number } | null;
  /** Задать аппетит: 0 скромно, 1 нормально, 2 по-крупному. */
  setAppetite(player: number, tier: number): void;
  /** Выключить звук: он мешает, когда агент гоняет сотню прогонов. */
  mute(on?: boolean): void;
  /** Нарисовать кадр немедленно: в невидимой вкладке кадров не бывает. */
  render(): void;
  /** Нагрузить сцену для замера бюджета кадра: враги и частицы разом. */
  stress(o?: { enemies?: number; particles?: number }): void;
  /**
   * Кадр сеткой средних цветов — снимок картинки для визуальной регрессии.
   *
   * Отдаёт клиент, а не тест: канвас низколатентный, и снаружи его буфер
   * читается через раз (см. `Renderer.frameGrid`).
   */
  frameGrid(cols?: number, rows?: number): number[][];
  /** События с указанного тика включительно. Без аргумента — все. */
  events(sinceTick?: number): SimEvent[];
  replay(): string;
  stable(on?: boolean): void;
}

function cardsOf(s: SimState): DebugCard[] {
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
function betsOf(s: SimState, player: number): DebugBet[] {
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

function snapshot(s: SimState, hash: string, bark: string): DebugState {
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
  };
}

export function installDebugApi(loop: GameLoop): void {
  const api: DebugApi = {
    ready: Promise.resolve(),
    build: BUILD,
    version: VERSION,
    sha: GIT_SHA,

    newRun(o) {
      loop.restart(o?.seed ?? loop.state.seed, o?.players ?? loop.state.playerCount);
      log('new_run', { seed: loop.state.seed, players: loop.state.playerCount });
    },

    tick(n = 1) {
      loop.advance(n);
    },

    input(player, frame) {
      if (frame === null) {
        loop.setInput(player, null);
        return;
      }
      const [mx, my] = frame.move ?? [0, 0];
      const [ax, ay] = frame.aim ?? [0, 0];
      loop.setInput(player, {
        moveX: fromFloat(mx),
        moveY: fromFloat(my),
        aimX: fromFloat(ax),
        aimY: fromFloat(ay),
        buttons: frame.buttons ?? 0,
      });
    },

    play: () => loop.play(),
    pause: () => loop.pause(),
    isPaused: () => loop.isPaused,
    state: () => snapshot(loop.state, loop.hash(), loop.feedback.bark),
    hash: () => loop.hash(),
    perf: () => ({
      fps: loop.fps,
      particles: loop.particles.count,
      shapes: loop.shapeCount,
      // Ненулевое значение означает, что кадр обрезан и картинка неполна:
      // без него бенч и визуальная регрессия сравнивали бы урезанный кадр,
      // не зная об этом.
      dropped: loop.droppedShapes,
    }),

    spawn(type, count = 1) {
      const t = ENEMY_TYPES[type];
      if (t === undefined) throw new Error(`неизвестный враг «${String(type)}»`);
      const s = loop.state;
      // По кругу вокруг игрока, но не ближе честной дистанции спавна:
      // отладка не должна создавать ситуаций, невозможных в игре.
      for (let n = 0; n < count; n++) {
        const a = (n / count) * Math.PI * 2;
        spawnEnemy(
          s,
          t,
          fromFloat(toFloat(s.pX[0]) + Math.cos(a) * 300),
          fromFloat(toFloat(s.pY[0]) + Math.sin(a) * 300),
        );
      }
      log('spawn', { type, count });
    },

    clear() {
      clearArena(loop.state);
      log('clear', {});
    },

    waves(on = true) {
      setSpawning(loop.state, on);
      log('waves', { on });
    },

    give(o, player = 0) {
      const s = loop.state;
      if (player < 0 || player >= s.playerCount) {
        throw new Error(`нет игрока ${player}: в забеге их ${s.playerCount}`);
      }
      if (o.chips !== undefined) s.pChips[player] += o.chips;
      if (o.hearts !== undefined) s.pHearts[player] += o.hearts;
      log('give', { player, chips: o.chips ?? 0, hearts: o.hearts ?? 0 });
    },

    cards: () => cardsOf(loop.state),

    spawnCard(bet, x, y, owner = SHARED) {
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

    take(player, cardId) {
      const s = loop.state;
      if (cardId !== undefined) {
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

    cashout(player, betSlot) {
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

    setAppetite(player, tier) {
      if (tier < 0 || tier > 2) throw new Error(`аппетит ${tier}: есть 0, 1 и 2`);
      loop.setAppetite(player, tier);
      // Немедленно, а не со следующего тика: агент вызывает setAppetite и
      // тут же take(), и кон обязан списаться уже новый.
      loop.state.pAppetite[player] = tier;
      log('set_appetite', { player, tier });
    },

    mute(on = true) {
      loop.audio.setMuted(on);
    },

    render: () => loop.renderOnce(),

    stress(o) {
      loop.stress(o?.enemies ?? 200, o?.particles ?? 2000);
      log('stress', { enemies: o?.enemies ?? 200, particles: o?.particles ?? 2000 });
    },
    events: (sinceTick) => loop.events.since(sinceTick),

    replay() {
      /*
       * Лог инпутов — это и есть баг-репорт: по нему забег воспроизводится
       * тик в тик.
       *
       * Возвращать надо весь лог, а не заголовок от него. Прежняя версия
       * отдавала сид, число тиков и версию сборки — то есть ровно ту часть,
       * по которой ничего воспроизвести нельзя, — и обещание в этом
       * комментарии было ложным.
       *
       * Сериализует ядро: там же лежит RLE по неизменным кадрам (стик подолгу
       * держит направление, и повторов в живом забеге большинство), и там же
       * `deserialize`, который этот текст читает. Результат принимается
       * раннером как есть: `npm run sim -- --replay <файл>`.
       */
      return serialize(loop.snapshotReplay());
    },

    frameGrid(cols = 16, rows = 9) {
      return loop.frameGrid(cols, rows);
    },

    stable(on = true) {
      // Режим стабильного кадра: тряска, вспышки и хитстоп выключаются,
      // чтобы скриншоты сравнивались между версиями. Частицы при этом
      // остаются — они и есть предмет сравнения, — но камера стоит.
      loop.feel.stable = on;
      document.documentElement.dataset.stable = on ? '1' : '';
    },
  };

  (window as unknown as Record<string, unknown>).__DOD__ = api;
  log('debug_api_ready', { build: BUILD });
}

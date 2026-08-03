/**
 * Сценарии — записанные проверки поведения, которые читаются человеком.
 *
 * Сценарий отвечает на вопрос «что игра делает», а golden-реплей — на вопрос
 * «делает ли она это ровно так же, как вчера». Первое ловит неверное
 * поведение, второе — изменившееся; ни одно не заменяет другое.
 *
 * Формат намеренно скучный JSON без выражений и условий: сценарий обязан
 * читаться как протокол, а не исполняться как программа. Всё, чего нельзя
 * выразить парой «подать ввод — прошагать — проверить», пишется юнит-тестом.
 */

import {
  Btn,
  createState,
  EnemyPhase,
  EnemyType,
  EntityFlag,
  MAX_CHIPS,
  MAX_ENEMIES,
  MAX_BULLETS,
  Meta,
  clearArena,
  fromFloat,
  hashHex,
  type InputFrame,
  makeFrame,
  setSpawning,
  type SimState,
  spawnEnemy,
  spawnPlayers,
  step,
  toFloat,
} from '../../sim/src/index';

/** Враги по именам: номер типа в сценарии читается не лучше маски кнопок. */
const ENEMY_TYPES: Record<string, EnemyType> = {
  wedge: EnemyType.Wedge,
  brick: EnemyType.Brick,
  fuse: EnemyType.Fuse,
  клин: EnemyType.Wedge,
  кирпич: EnemyType.Brick,
  фитиль: EnemyType.Fuse,
};

/** Фазы автомата по именам — сценарий читается как протокол, а не как код. */
const PHASES: Record<string, EnemyPhase> = {
  idle: EnemyPhase.Idle,
  telegraph: EnemyPhase.Telegraph,
  attack: EnemyPhase.Attack,
  recover: EnemyPhase.Recover,
};

/** Кнопки по именам: маска в сценарии нечитаема и потому запрещена. */
const BUTTONS: Record<string, Btn> = {
  fire: Btn.Fire,
  dash: Btn.Dash,
  take: Btn.Take,
  cashout: Btn.CashOut,
  inspect: Btn.Inspect,
  accept: Btn.Accept,
  decline: Btn.Decline,
  revive: Btn.Revive,
  ping: Btn.Ping,
};

/** Границы величины. Обе стороны необязательны: часто важна только одна. */
export interface Range {
  min?: number;
  max?: number;
}

export interface Expectation {
  player?: number;
  /** Сколько врагов на арене. */
  enemies?: Range;
  /** Сколько снарядов в воздухе. */
  bullets?: Range;
  /** Сколько фишек лежит на полу. */
  chipsOnFloor?: Range;
  /** Убито врагов за забег. */
  kills?: Range;
  /** Состояние конкретного врага по порядковому номеру среди живых. */
  enemy?: {
    index?: number;
    hp?: Range;
    x?: Range;
    y?: Range;
    /** Имя фазы автомата: idle / telegraph / attack / recover. */
    phase?: string;
  };
  x?: Range;
  y?: Range;
  /** Пройденное расстояние от точки появления. */
  travelled?: Range;
  hearts?: Range;
  chips?: Range;
  alive?: boolean;
  invulnerable?: boolean;
  /** Хеш состояния целиком: точная привязка к моменту. */
  hash?: string;
}

export type Step =
  | {
      input: {
        player?: number;
        move?: [number, number];
        aim?: [number, number];
        buttons?: string[];
      };
    }
  | { clearInput: { player?: number } }
  | { tick: number }
  /** Поставить игрока в точку — чтобы не описывать дорогу до неё вводом. */
  | { place: { player?: number; x: number; y: number } }
  /** Поставить врага. Имя типа, а не номер: номер в протоколе нечитаем. */
  | { spawn: { type: string; x: number; y: number; count?: number } }
  /** Убрать с арены всё, кроме игроков. */
  | { clear: true }
  | { expect: Expectation };

export interface Scenario {
  name: string;
  seed?: number;
  players?: number;
  /**
   * Пополнять ли арену волнами. По умолчанию НЕТ.
   *
   * Сценарий проверяет одно названное поведение, и набежавшая волна делает его
   * проверкой чего-то другого: «рывок покрывает втрое больше ходьбы» перестаёт
   * быть про рывок, стоит на пути оказаться Клину. Кому нужны волны — тот
   * просит их явно.
   */
  waves?: boolean;
  steps: Step[];
}

export interface ScenarioResult {
  name: string;
  ok: boolean;
  ticks: number;
  hash: string;
  failures: string[];
}

function buttonMask(names: readonly string[]): number {
  let mask = 0;
  for (const n of names) {
    const b = BUTTONS[n.toLowerCase()];
    if (b === undefined) throw new Error(`неизвестная кнопка «${n}»`);
    mask |= b;
  }
  return mask;
}

/** Проверка попадания в границы. Возвращает описание провала или null. */
function checkRange(label: string, value: number, r: Range): string | null {
  if (r.min !== undefined && value < r.min)
    return `${label} = ${round(value)}, ожидалось ≥ ${r.min}`;
  if (r.max !== undefined && value > r.max)
    return `${label} = ${round(value)}, ожидалось ≤ ${r.max}`;
  return null;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

const countActive = (flags: Uint8Array, limit: number): number => {
  let n = 0;
  for (let i = 0; i < limit; i++) if (flags[i]) n++;
  return n;
};

/** Индекс n-го живого врага: сценарий считает врагов, а не ячейки пула. */
function nthEnemy(s: SimState, n: number): number {
  let seen = 0;
  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (!s.eActive[i]) continue;
    if (seen === n) return i;
    seen++;
  }
  return -1;
}

function checkEnemy(s: SimState, e: NonNullable<Expectation['enemy']>): string[] {
  const out: string[] = [];
  const n = e.index ?? 0;
  const i = nthEnemy(s, n);
  if (i < 0) return [`врага ${n} нет: на арене ${countActive(s.eActive, MAX_ENEMIES)}`];

  if (e.hp) push(out, checkRange(`здоровье врага ${n}`, s.eHP[i], e.hp));
  if (e.x) push(out, checkRange(`x врага ${n}`, toFloat(s.eX[i]), e.x));
  if (e.y) push(out, checkRange(`y врага ${n}`, toFloat(s.eY[i]), e.y));
  if (e.phase !== undefined) {
    const want = PHASES[e.phase.toLowerCase()];
    if (want === undefined) throw new Error(`неизвестная фаза «${e.phase}»`);
    if (s.ePhase[i] !== want) {
      const actual = Object.keys(PHASES).find((k) => PHASES[k] === s.ePhase[i]) ?? s.ePhase[i];
      out.push(`фаза врага ${n} = ${String(actual)}, ожидалась ${e.phase}`);
    }
  }
  return out;
}

function checkExpectation(
  s: SimState,
  e: Expectation,
  spawn: readonly { x: number; y: number }[],
): string[] {
  const out: string[] = [];

  if (e.enemies)
    push(out, checkRange('врагов на арене', countActive(s.eActive, MAX_ENEMIES), e.enemies));
  if (e.bullets) push(out, checkRange('снарядов', countActive(s.bActive, MAX_BULLETS), e.bullets));
  if (e.chipsOnFloor) {
    push(out, checkRange('фишек на полу', countActive(s.cActive, MAX_CHIPS), e.chipsOnFloor));
  }
  if (e.kills) push(out, checkRange('убито врагов', s.meta[Meta.Kills], e.kills));
  if (e.enemy) out.push(...checkEnemy(s, e.enemy));

  const i = e.player ?? 0;
  if (i >= s.playerCount) return [`игрока ${i} нет: в забеге ${s.playerCount}`];

  const x = toFloat(s.pX[i]);
  const y = toFloat(s.pY[i]);

  if (e.x) push(out, checkRange(`x игрока ${i}`, x, e.x));
  if (e.y) push(out, checkRange(`y игрока ${i}`, y, e.y));
  if (e.travelled) {
    const dx = x - spawn[i].x;
    const dy = y - spawn[i].y;
    push(out, checkRange(`путь игрока ${i}`, Math.sqrt(dx * dx + dy * dy), e.travelled));
  }
  if (e.hearts) push(out, checkRange(`сердца игрока ${i}`, s.pHearts[i], e.hearts));
  if (e.chips) push(out, checkRange(`фишки игрока ${i}`, s.pChips[i], e.chips));

  if (e.alive !== undefined) {
    const alive = (s.pFlags[i] & EntityFlag.Alive) !== 0;
    if (alive !== e.alive) out.push(`игрок ${i}: жив = ${alive}, ожидалось ${e.alive}`);
  }
  if (e.invulnerable !== undefined) {
    const inv = (s.pFlags[i] & EntityFlag.Invulnerable) !== 0;
    if (inv !== e.invulnerable)
      out.push(`игрок ${i}: неуязвим = ${inv}, ожидалось ${e.invulnerable}`);
  }
  if (e.hash !== undefined) {
    const h = hashHex(s);
    if (h !== e.hash) out.push(`хеш ${h}, ожидался ${e.hash}`);
  }
  return out;
}

const push = (out: string[], msg: string | null): void => {
  if (msg !== null) out.push(msg);
};

/**
 * Прогнать сценарий.
 *
 * Провалы собираются все до единого, а не бросаются первым: увидеть сразу
 * весь список расхождений дешевле, чем чинить их по одному и перезапускать.
 */
export function runScenario(sc: Scenario): ScenarioResult {
  const s = createState(sc.seed ?? 1, sc.players ?? 1);
  spawnPlayers(s);
  setSpawning(s, sc.waves === true);

  const spawn = Array.from({ length: s.playerCount }, (_, i) => ({
    x: toFloat(s.pX[i]),
    y: toFloat(s.pY[i]),
  }));

  const frames: InputFrame[] = Array.from({ length: s.playerCount }, makeFrame);
  const failures: string[] = [];

  for (const [n, st] of sc.steps.entries()) {
    const where = `шаг ${n + 1}`;
    try {
      if ('input' in st) {
        const f = frames[st.input.player ?? 0];
        if (st.input.move) {
          f.moveX = fromFloat(st.input.move[0]);
          f.moveY = fromFloat(st.input.move[1]);
        }
        if (st.input.aim) {
          f.aimX = fromFloat(st.input.aim[0]);
          f.aimY = fromFloat(st.input.aim[1]);
        }
        if (st.input.buttons) f.buttons = buttonMask(st.input.buttons);
      } else if ('clearInput' in st) {
        const f = frames[st.clearInput.player ?? 0];
        f.moveX = f.moveY = f.aimX = f.aimY = f.buttons = 0;
      } else if ('tick' in st) {
        for (let t = 0; t < st.tick; t++) step(s, frames);
      } else if ('place' in st) {
        const i = st.place.player ?? 0;
        s.pX[i] = fromFloat(st.place.x);
        s.pY[i] = fromFloat(st.place.y);
        s.pVX[i] = 0;
        s.pVY[i] = 0;
      } else if ('spawn' in st) {
        const type = ENEMY_TYPES[st.spawn.type.toLowerCase()];
        if (type === undefined) throw new Error(`неизвестный враг «${st.spawn.type}»`);
        for (let n = 0; n < (st.spawn.count ?? 1); n++) {
          spawnEnemy(s, type, fromFloat(st.spawn.x), fromFloat(st.spawn.y));
        }
      } else if ('clear' in st) {
        clearArena(s);
      } else {
        for (const msg of checkExpectation(s, st.expect, spawn)) {
          failures.push(`${where} (тик ${s.tick}): ${msg}`);
        }
      }
    } catch (err) {
      failures.push(`${where}: ${String(err)}`);
      break;
    }
  }

  return { name: sc.name, ok: failures.length === 0, ticks: s.tick, hash: hashHex(s), failures };
}

/** Разбор с внятной ошибкой: сценарии правят руками, и опечатки неизбежны. */
export function parseScenario(json: string, source: string): Scenario {
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch (e) {
    // Исходная ошибка едет причиной, а не только строкой в сообщении: в ней
    // позиция сбоя, а без неё опечатку в сценарии на сотню строк искать
    // глазами.
    throw new Error(`${source}: не разбирается как JSON — ${String(e)}`, { cause: e });
  }
  const sc = o as Partial<Scenario>;
  if (typeof sc.name !== 'string' || !sc.name) throw new Error(`${source}: нет поля name`);
  if (!Array.isArray(sc.steps)) throw new Error(`${source}: нет массива steps`);
  return sc as Scenario;
}

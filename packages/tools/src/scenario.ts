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
  EntityFlag,
  fromFloat,
  hashHex,
  type InputFrame,
  makeFrame,
  type SimState,
  spawnPlayers,
  step,
  toFloat,
} from '../../sim/src/index';

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
  | { expect: Expectation };

export interface Scenario {
  name: string;
  seed?: number;
  players?: number;
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

function checkExpectation(
  s: SimState,
  e: Expectation,
  spawn: readonly { x: number; y: number }[],
): string[] {
  const out: string[] = [];
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
    throw new Error(`${source}: не разбирается как JSON — ${String(e)}`);
  }
  const sc = o as Partial<Scenario>;
  if (typeof sc.name !== 'string' || !sc.name) throw new Error(`${source}: нет поля name`);
  if (!Array.isArray(sc.steps)) throw new Error(`${source}: нет массива steps`);
  return sc as Scenario;
}

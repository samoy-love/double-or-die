/**
 * Кадр ввода — единица симуляции, сети и реплея одновременно.
 *
 * Любое новое действие обязано попасть в маску: то, чего здесь нет, не
 * существует ни для golden-тестов, ни для сетевой игры. Маска входит в
 * PROTOCOL_VERSION и в версию формата реплея, поэтому её изменение делает
 * старых клиентов несовместимыми ЯВНО, а не через десинк на тридцатой секунде.
 */

import type { Fx } from './fixed';

export const enum Btn {
  Fire = 1 << 0,
  Dash = 1 << 1,
  /** Подобрать карту, на которой стоишь. Подтверждение, а не наезд. */
  Take = 1 << 2,
  /** «Забрать» — обналичить своё пари. */
  CashOut = 1 << 3,
  /** Рассмотреть карту (удержание). */
  Inspect = 1 << 4,
  /** Принять «Удвоим?». */
  Accept = 1 << 5,
  /** Отказаться. */
  Decline = 1 << 6,
  /** Воскресить напарника (удержание). */
  Revive = 1 << 7,
  /** Аппетит: два бита на три тира. */
  AppetiteLo = 1 << 8,
  AppetiteHi = 1 << 9,
  Ping = 1 << 10,
  /** Эмоция: три бита на восемь штук. */
  Emote0 = 1 << 11,
  Emote1 = 1 << 12,
  Emote2 = 1 << 13,
  /**
   * Схема ввода: два бита на геймпад, клавиатуру и тач.
   *
   * Живёт в кадре ввода, а не в состоянии, ровно потому, что это свойство
   * ввода: игрок берётся за геймпад посреди забега, и реплей обязан
   * переиграть и это. Схема решает, какие пари ему вообще предлагать —
   * матрица «пари × схема» (GDD §9.5).
   */
  Scheme0 = 1 << 14,
  Scheme1 = 1 << 15,
}

export const APPETITE_SHIFT = 8;
export const APPETITE_MASK = 0b11;
export const EMOTE_SHIFT = 11;
export const EMOTE_MASK = 0b111;
export const SCHEME_SHIFT = 14;
export const SCHEME_MASK = 0b11;

/**
 * Один кадр ввода одного игрока.
 *
 * Номер тика не хранится: он задан позицией кадра в потоке. Это экономит
 * четверть трафика и делает невозможным рассинхрон нумерации.
 */
export interface InputFrame {
  /** Направление движения, нормализованное. */
  moveX: Fx;
  moveY: Fx;
  /** Направление прицела, нормализованное. */
  aimX: Fx;
  aimY: Fx;
  /** Битовая маска из Btn. */
  buttons: number;
}

export const EMPTY_INPUT: Readonly<InputFrame> = Object.freeze({
  moveX: 0,
  moveY: 0,
  aimX: 0,
  aimY: 0,
  buttons: 0,
});

export const isDown = (f: InputFrame, b: Btn): boolean => (f.buttons & b) !== 0;

/**
 * Тир кона из кадра, СО СДВИГОМ НА ЕДИНИЦУ: 0 — «молчит», 1..3 — тиры 0..2.
 *
 * Два бита дают четыре значения, а тиров три — и четвёртое значение обязано
 * означать «игрок сейчас ничего не выбирает», иначе защёлка не отличит выбор
 * от отпущенной кнопки. Наивная раскладка «биты и есть номер тира» стоила
 * ровно одного тира: ноль читался как молчание, и «Скромно» нельзя было
 * выбрать ЯВНО — крестовина вниз до упора и клавиша `1` не делали ничего.
 * Молчаливо потерянным оказался самый нужный тир: в начале забега кошелёк
 * мал, и Келли (ECONOMY §7) велит ставить именно скромно.
 *
 * Возвращает −1, когда игрок молчит: вызывающий сам решает, что с этим
 * делать, и не путает молчание с нулевым тиром.
 */
export const appetiteOf = (f: InputFrame): number => {
  const raw = (f.buttons >> APPETITE_SHIFT) & APPETITE_MASK;
  return raw === 0 ? -1 : raw - 1;
};

/** Уложить тир в биты кадра. Обратная к `appetiteOf`, живёт рядом с ней. */
export const withAppetite = (buttons: number, tier: number): number =>
  (buttons & ~(APPETITE_MASK << APPETITE_SHIFT)) | ((tier + 1) << APPETITE_SHIFT);

export const schemeOf = (f: InputFrame): number => (f.buttons >> SCHEME_SHIFT) & SCHEME_MASK;

/**
 * Кадры пакуются в плоский Int32Array: пять слов на кадр на игрока.
 * Такой лог копируется одним `set()` и сжимается RLE по неизменным кадрам —
 * стик подолгу держит направление, и повторов в реальном забеге большинство.
 */
export const WORDS_PER_FRAME = 5;

export function writeFrame(buf: Int32Array, offset: number, f: InputFrame): void {
  buf[offset] = f.moveX;
  buf[offset + 1] = f.moveY;
  buf[offset + 2] = f.aimX;
  buf[offset + 3] = f.aimY;
  buf[offset + 4] = f.buttons;
}

export function readFrame(buf: Int32Array, offset: number, out: InputFrame): InputFrame {
  out.moveX = buf[offset];
  out.moveY = buf[offset + 1];
  out.aimX = buf[offset + 2];
  out.aimY = buf[offset + 3];
  out.buttons = buf[offset + 4];
  return out;
}

export const makeFrame = (): InputFrame => ({
  moveX: 0,
  moveY: 0,
  aimX: 0,
  aimY: 0,
  buttons: 0,
});

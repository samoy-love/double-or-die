/**
 * Хитбоксы главного меню — одни числа на рендер, клик и наведение.
 *
 * Раньше они были вписаны трижды (renderer.ts рисует, loop.ts кликает и
 * наводит) и один раз уже разошлись: кнопка «Играть» сдвинулась влево ради
 * второго пункта меню, а клик остался на старом месте. Общая константа не
 * чинит рассинхрон сама по себе, но убирает его причину — переписывать три
 * копии вручную при следующей правке компоновки.
 *
 * Координаты — смещение от центра арены (`w/2`, `h/2`), не абсолютные: меню
 * рисуется в размере арены, а не в фиксированных 1920×1080.
 */
import { lineStep, TEXT } from './typography';
import { summaryLineCount, type SimState } from '@dod/sim';

export interface ScreenButton {
  readonly dx: number;
  /** Смещение по вертикали от центра арены. Ноль — кнопка на средней линии. */
  readonly dy?: number;
  readonly halfW: number;
  readonly halfH: number;
}

export const MENU_PLAY_BUTTON: ScreenButton = { dx: -130, halfW: 170, halfH: 52 };
export const MENU_SETTINGS_BUTTON: ScreenButton = { dx: 190, halfW: 130, halfH: 44 };

/**
 * Кнопки экрана паузы: продолжить, настройки, справка.
 *
 * Те же три прямоугольника, что рисует `drawPauseScreen`, и по той же причине
 * общие: мышь в этой игре есть всегда (UX §2), а нарисованная кнопка, которая
 * не нажимается, — обещание, которого интерфейс не держит.
 */
/**
 * «Ещё разок» на экране итогов.
 *
 * `dy` вместо `dx`: кнопка стоит по центру и ниже середины, а не сбоку, — у
 * этой одной прямоугольник не совпадает по вертикали с центром арены.
 *
 * Базовое смещение — под ОДНУ строку разбивки источников ключей плюс подпись
 * «Отдано заведению» (самый частый случай: забег без апгрейдов на пари/боссов
 * не даёт). Раньше `dy` было числом без этой оговорки — кнопка стояла на
 * фиксированном месте, а блок разбивки рос вниз с числом ненулевых
 * источников (пари/фишки/боссы, до трёх строк) и с строкой «минимум 1» —
 * при трёх строках кнопка ложилась поверх «Отдано заведению», обрезая число.
 */
const AGAIN_BUTTON_BASE_DY = 214;
const AGAIN_BUTTON_BASE_LINES = 1;

/** «Ещё разок» — прямоугольник сдвинут вниз ровно на рост блока разбивки. */
export function againButtonFor(s: SimState): ScreenButton {
  // Число строк — из `packages/sim` (`summaryLineCount`), не своя копия:
  // хитбокс клика (`loop.ts`) и рисунок (`renderer.ts`) обязаны сходиться в
  // одном прямоугольнике, и раньше это гарантировалось только тем, что обе
  // копии формулы правили синхронно вручную — рассинхрон уже случался (iter-3
  // ТЗ-17).
  const extra = Math.max(0, summaryLineCount(s) - AGAIN_BUTTON_BASE_LINES);
  return { dx: 0, dy: AGAIN_BUTTON_BASE_DY + extra * lineStep(TEXT.body), halfW: 220, halfH: 52 };
}

export const PAUSE_BUTTONS: readonly ScreenButton[] = [
  { dx: -420, halfW: 180, halfH: 56 },
  { dx: 0, halfW: 180, halfH: 56 },
  { dx: 420, halfW: 180, halfH: 56 },
];

/** Попадает ли точка `(px, py)` в кнопку экрана с центром `(cx, cy)`. */
export const hitButton = (
  px: number,
  py: number,
  cx: number,
  cy: number,
  btn: ScreenButton,
): boolean =>
  Math.abs(px - (cx + btn.dx)) <= btn.halfW && Math.abs(py - (cy + (btn.dy ?? 0))) <= btn.halfH;

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
export interface ScreenButton {
  readonly dx: number;
  readonly halfW: number;
  readonly halfH: number;
}

export const MENU_PLAY_BUTTON: ScreenButton = { dx: -130, halfW: 170, halfH: 52 };
export const MENU_SETTINGS_BUTTON: ScreenButton = { dx: 190, halfW: 130, halfH: 44 };

/** Попадает ли точка `(px, py)` в кнопку экрана с центром `(cx, cy)`. */
export const hitButton = (
  px: number,
  py: number,
  cx: number,
  cy: number,
  btn: ScreenButton,
): boolean => Math.abs(px - (cx + btn.dx)) <= btn.halfW && Math.abs(py - cy) <= btn.halfH;

/**
 * Ощущение удара: хитстоп, тряска камеры, вспышка экрана.
 *
 * Числа — из таблицы сочности GDD §6, и они не «на глаз»: ощущение боя на 70%
 * состоит из обратной связи, а не из формы врагов (PRODUCTION §4). Это тот
 * слой, ради которого версия 0.2.0 вообще существует.
 *
 * Хитстоп останавливает ЧАСЫ, а не симуляцию: тик по-прежнему ровно 1/60, их
 * просто становится меньше в секунду. Замедлять сам тик нельзя — это сломало
 * бы детерминизм и лишило смысла реплеи (TECH §7.1А).
 *
 * **Фотосенситивная безопасность — не полировка, а требование к публичным
 * версиям** (UX §5). Полноэкранных строб нет вовсе, вспышки ограничены по
 * частоте и яркости прямо здесь, а не «когда дойдут руки в 0.12.0»: игра с
 * казино-эстетикой без этой защиты — риск здоровью.
 */

import { PALETTE, type Rgb } from './palette';

/** Не чаще трёх вспышек в секунду — базовый фотосенситивный порог. */
const MIN_FLASH_INTERVAL = 1 / 3;
/** Потолок яркости вспышки. Полноэкранного белого не бывает ни при каких. */
const MAX_FLASH_ALPHA = 0.32;
/** Потолок хитстопа за кадр: цепочка событий не должна вешать картинку. */
const MAX_HITSTOP = 0.12;

export class Feel {
  /** Сколько секунд картинка стоит. */
  private hitstop = 0;
  private shakeAmplitude = 0;
  private shakeLeft = 0;
  private shakeTotal = 0;
  private shakeSeed = 1;

  private flashAlpha = 0;
  private flashDecay = 1;
  private flashColour: Rgb = PALETTE.danger;
  private sinceFlash = MIN_FLASH_INTERVAL;

  /** Смещение камеры в единицах арены — читается рендером. */
  offsetX = 0;
  offsetY = 0;

  /** Стабильный кадр: тряска, вспышки и хитстоп выключены для скриншотов. */
  stable = false;

  /**
   * Интенсивность вспышек, 0..1. Приезжает из сейва игрока (`save.ts`).
   *
   * Множитель, а не «выключено/включено»: у чувствительности к мерцанию нет
   * двух состояний, и игрок, которому больно от полной вспышки, обычно
   * доволен четвертью. Ноль остаётся честным нулём — вспышки не случается
   * вовсе, а не случается незаметная.
   */
  flashScale = 1;

  /** Остановить картинку на `seconds`. Значения — из таблицы GDD §6. */
  freeze(seconds: number): void {
    if (this.stable) return;
    this.hitstop = Math.min(MAX_HITSTOP, Math.max(this.hitstop, seconds));
  }

  /** Тряхнуть камеру: амплитуда в единицах арены, длительность в секундах. */
  shake(amplitude: number, seconds: number): void {
    if (this.stable) return;
    // Сильная тряска не отменяется слабой: удар по игроку важнее, чем
    // попадание по врагу, случившееся кадром позже.
    if (amplitude < this.shakeAmplitude && this.shakeLeft > 0) return;
    this.shakeAmplitude = amplitude;
    this.shakeLeft = seconds;
    this.shakeTotal = seconds;
  }

  /**
   * Вспышка экрана. Отказывает молча, если предыдущая была слишком недавно, —
   * это и есть ограничение частоты, а не пожелание в документе.
   */
  flash(colour: Rgb, alpha: number): void {
    if (this.stable || this.flashScale <= 0) return;
    if (this.sinceFlash < MIN_FLASH_INTERVAL) return;
    this.sinceFlash = 0;
    this.flashColour = colour;
    this.flashAlpha = Math.min(MAX_FLASH_ALPHA, alpha) * this.flashScale;
    this.flashDecay = this.flashAlpha / 0.25;
  }

  /** Идёт ли сейчас хитстоп: цикл в это время не делает тиков. */
  get frozen(): boolean {
    return this.hitstop > 0;
  }

  get screenFlash(): { colour: Rgb; alpha: number } | null {
    return this.flashAlpha > 0.001 ? { colour: this.flashColour, alpha: this.flashAlpha } : null;
  }

  /** Шаг по реальному времени. Возвращает время, «дошедшее» до симуляции. */
  advance(dt: number): number {
    this.sinceFlash += dt;

    if (this.flashAlpha > 0) this.flashAlpha = Math.max(0, this.flashAlpha - this.flashDecay * dt);

    if (this.shakeLeft > 0) {
      this.shakeLeft = Math.max(0, this.shakeLeft - dt);
      const t = this.shakeLeft / this.shakeTotal;
      const a = this.shakeAmplitude * t * t;
      // Собственный генератор, а не Math.random: тряска должна быть
      // одинаковой при одинаковом ходе кадров, иначе скриншоты не сравнить.
      this.shakeSeed = (this.shakeSeed * 1103515245 + 12345) & 0x7fffffff;
      const n1 = ((this.shakeSeed >> 8) & 0xffff) / 0x8000 - 1;
      this.shakeSeed = (this.shakeSeed * 1103515245 + 12345) & 0x7fffffff;
      const n2 = ((this.shakeSeed >> 8) & 0xffff) / 0x8000 - 1;
      this.offsetX = n1 * a;
      this.offsetY = n2 * a;
      if (this.shakeLeft === 0) this.shakeAmplitude = 0;
    } else {
      this.offsetX = 0;
      this.offsetY = 0;
    }

    if (this.hitstop > 0) {
      this.hitstop = Math.max(0, this.hitstop - dt);
      return 0;
    }
    return dt;
  }
}

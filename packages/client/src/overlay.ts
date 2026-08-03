/**
 * Отладочный оверлей и уведомление об обновлении.
 *
 * Оверлей показывает то, по чему видно, что симуляция жива и детерминирована:
 * номер тика и хеш состояния. Хеш здесь не для красоты — по нему глазами
 * сверяются два запуска, когда тест уже упал и нужно понять, где именно.
 */

import type { GameLoop } from './loop';
import { BUILD } from './version';

export class Overlay {
  private readonly el: HTMLElement;
  private readonly update: HTMLElement;
  private timer = 0;

  constructor(
    private readonly loop: GameLoop,
    private readonly debug: boolean,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'overlay';
    this.el.hidden = !debug;

    this.update = document.createElement('div');
    this.update.className = 'update';
    this.update.hidden = true;

    document.body.append(this.el, this.update);
  }

  start(): void {
    if (!this.debug) return;
    // Раз в четверть секунды: чаще незачем, а перерисовка DOM в кадре
    // игры — лишняя работа на ровном месте.
    this.timer = window.setInterval(() => this.render(), 250);
    this.render();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private render(): void {
    const s = this.loop.state;
    this.el.textContent =
      `${BUILD}  ·  тик ${s.tick}  ·  ${this.loop.fps} FPS  ·  ` +
      `сид ${s.seed}  ·  игроков ${s.playerCount}  ·  ${this.loop.hash()}` +
      (this.loop.isPaused ? '  ·  ПАУЗА' : '');
  }

  /**
   * Ненавязчивая отметка о новой версии.
   *
   * Не перезагружаем сами: выдёргивать игрока из забега ради обновления
   * хуже, чем подождать, пока он перезагрузится сам.
   */
  showUpdate(build: string): void {
    this.update.hidden = false;
    this.update.textContent = `Доступна новая версия (${build}) — обновите страницу`;
    this.update.onclick = () => location.reload();
  }
}

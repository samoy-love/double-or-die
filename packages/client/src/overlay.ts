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
  private readonly halt: HTMLElement;
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

    this.halt = document.createElement('div');
    this.halt.className = 'halt';
    this.halt.hidden = true;

    document.body.append(this.el, this.update, this.halt);
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
    // Сняли паузу — плашка уходит. Висящая после возобновления, она врала бы о
    // текущем состоянии; если инвариант нарушен до сих пор, следующий же тик
    // остановит цикл снова и вернёт её.
    if (!this.loop.isPaused) this.halt.hidden = true;

    const s = this.loop.state;
    this.el.textContent =
      `${BUILD}  ·  тик ${s.tick}  ·  ${this.loop.fps} FPS  ·  ` +
      `сид ${s.seed}  ·  игроков ${s.playerCount}  ·  ${this.loop.hash()}` +
      // Обрезанный кадр — это неполная картинка, и молчать о ней нельзя.
      // Показывается, только когда есть о чём: строка про ноль потерянных
      // фигур каждый кадр приучает не читать всю строку целиком.
      (this.loop.droppedShapes > 0 ? `  ·  ПОТЕРЯНО ФИГУР ${this.loop.droppedShapes}` : '') +
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

  /**
   * Симуляция остановлена нарушенным инвариантом.
   *
   * Плашка нужна ровно потому, что остановка ничем другим не выглядит. Цикл
   * встаёт, кадр замирает, причина уходит в консоль — а игрок видит картинку,
   * которая перестала отвечать, и ни одного объяснения. На экране расчёта это
   * прочиталось как «экран, который невозможно пропустить», и на поиск ушёл
   * вечер не в ту сторону.
   *
   * Сид и тик здесь по той же причине, по которой они обязательны в
   * `[DOD:INVARIANT]`: без них забег невоспроизводим, а значит дефект не
   * найти. Игрок перепишет их в баг-репорт с экрана, а не из devtools, куда
   * он не пойдёт.
   *
   * Живёт только в dev-сборке — там же, где живут сами инварианты
   * (`loop.ts`): в релизе проверка вырезана, и останавливаться нечему.
   */
  showHalt(message: string, seed: number, tick: number): void {
    this.halt.hidden = false;
    this.halt.innerHTML =
      '<b>Симуляция остановлена: нарушен инвариант</b>\n\n' +
      `${escapeHtml(message)}\n\n` +
      `сид ${seed} · тик ${tick} · сборка ${BUILD}\n` +
      'Это дефект ядра, а не ваш ход. P или Esc — продолжить, F5 — начать заново.';
  }
}

/**
 * Текст инварианта приходит из `String(error)` и в разметку попадает как
 * текст, а не как разметка. Своих угловых скобок он не содержит, но полагаться
 * на это нельзя: сообщение собирается из состояния, а состояние в дальнейшем
 * будет приходить и по сети (0.9.0).
 */
const escapeHtml = (v: string): string =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

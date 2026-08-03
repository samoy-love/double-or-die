/**
 * Слой ввода: геймпад, клавиатура и мышь → единый InputFrame.
 *
 * Нормализация происходит ДО симуляции — ядро не должно знать, откуда пришло
 * направление. Это же делает InputFrame единицей сети и реплея.
 */

import { Btn, fromFloat, type InputFrame, makeFrame } from '../../sim/src/index';

/** Радиальная мёртвая зона: квадратная врёт на диагоналях. */
const DEADZONE = 0.18;
/** Буфер ввода прощает раннее нажатие рывка (6 кадров). */
const BUFFER_TICKS = 6;

interface Held {
  dash: number;
  take: number;
  cashOut: number;
}

export class InputSource {
  private readonly frame: InputFrame = makeFrame();
  private readonly keys = new Set<string>();
  private mouseX = 0;
  private mouseY = 0;
  private mouseDown = false;
  private readonly held: Held = { dash: 0, take: 0, cashOut: 0 };
  private firstInput: (() => void) | null = null;

  /**
   * Позвать один раз, как только игрок что-нибудь нажал.
   *
   * Нужно звуку: Web Audio не запускается до жеста пользователя, и контекст,
   * созданный на загрузке, остаётся навсегда приостановленным.
   */
  onFirstInput(fn: () => void): void {
    this.firstInput = fn;
  }

  private touched(): void {
    if (!this.firstInput) return;
    const fn = this.firstInput;
    this.firstInput = null;
    fn();
  }

  attach(canvas: HTMLCanvasElement): void {
    window.addEventListener('keydown', (e) => {
      this.touched();
      this.keys.add(e.code);
      // Пробел и стрелки скроллят страницу — в игре это раздражает.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouseX = ((e.clientX - r.left) / r.width) * 1920;
      this.mouseY = ((e.clientY - r.top) / r.height) * 1080;
    });
    canvas.addEventListener('mousedown', () => {
      this.touched();
      this.mouseDown = true;
    });
    window.addEventListener('mouseup', () => (this.mouseDown = false));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Собрать кадр для игрока. `px`/`py` — его позиция в единицах арены. */
  poll(px: number, py: number): InputFrame {
    const pad = navigator.getGamepads?.()[0] ?? null;
    const f = this.frame;

    let mx = 0;
    let my = 0;
    let ax = 0;
    let ay = 0;
    let buttons = 0;

    if (pad) {
      if (pad.buttons.some((btn) => btn.pressed)) this.touched();
      [mx, my] = applyDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
      [ax, ay] = applyDeadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
      if ((pad.buttons[7]?.value ?? 0) > 0.5) buttons |= Btn.Fire;
      if (pad.buttons[0]?.pressed) this.held.dash = BUFFER_TICKS;
      if (pad.buttons[2]?.pressed) this.held.take = BUFFER_TICKS;
      if (pad.buttons[4]?.pressed) this.held.cashOut = BUFFER_TICKS;
      if (pad.buttons[3]?.pressed) buttons |= Btn.Accept;
      if (pad.buttons[1]?.pressed) buttons |= Btn.Decline;
    }

    // Клавиатура дополняет геймпад, а не спорит с ним: подключить пад
    // посреди игры можно, и раскладка не должна отваливаться.
    if (mx === 0 && my === 0) {
      const kx = (this.k('KeyD') ? 1 : 0) - (this.k('KeyA') ? 1 : 0);
      const ky = (this.k('KeyS') ? 1 : 0) - (this.k('KeyW') ? 1 : 0);
      [mx, my] = normalizeF(kx, ky);
    }
    if (ax === 0 && ay === 0) {
      [ax, ay] = normalizeF(this.mouseX - px, this.mouseY - py);
    }
    if (this.mouseDown) buttons |= Btn.Fire;
    if (this.k('Space')) this.held.dash = BUFFER_TICKS;
    if (this.k('KeyX')) this.held.take = BUFFER_TICKS;
    if (this.k('ShiftLeft') || this.k('ShiftRight')) this.held.cashOut = BUFFER_TICKS;
    if (this.k('KeyE')) buttons |= Btn.Accept;
    if (this.k('KeyQ')) buttons |= Btn.Decline;

    // Буферизованные действия срабатывают один раз и гаснут — так раннее
    // нажатие прощается, но не залипает.
    if (this.held.dash > 0) {
      buttons |= Btn.Dash;
      this.held.dash--;
    }
    if (this.held.take > 0) {
      buttons |= Btn.Take;
      this.held.take--;
    }
    if (this.held.cashOut > 0) {
      buttons |= Btn.CashOut;
      this.held.cashOut--;
    }

    f.moveX = fromFloat(mx);
    f.moveY = fromFloat(my);
    f.aimX = fromFloat(ax);
    f.aimY = fromFloat(ay);
    f.buttons = buttons;
    return f;
  }

  private k(code: string): boolean {
    return this.keys.has(code);
  }
}

/** Радиальная мёртвая зона с ремапом остатка в 0..1. */
function applyDeadzone(x: number, y: number): [number, number] {
  const len = Math.hypot(x, y);
  if (len < DEADZONE) return [0, 0];
  const scaled = (len - DEADZONE) / (1 - DEADZONE);
  return [(x / len) * scaled, (y / len) * scaled];
}

function normalizeF(x: number, y: number): [number, number] {
  const len = Math.hypot(x, y);
  if (len === 0) return [0, 0];
  return [x / len, y / len];
}

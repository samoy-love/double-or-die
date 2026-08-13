/**
 * Крупье: тело, жесты, реплика.
 *
 * `drawAce` читает `batch`/`text` напрямую и зовёт `drawEyes` — то, чего в
 * `RenderKit` нет и не должно быть (см. комментарий у интерфейса в
 * `renderer.ts`). Принимает сам `Renderer`, а не кит, как соседние экраны в
 * `screens/run.ts`. Перенос буквальный: тело не менялось, только `this.` →
 * `rend.`.
 */
import { AceGesture, EntityFlag, CARD, Meta, toFloat, type SimState } from '@dod/sim';
import type { Feedback } from '../feedback';
import { Shape } from '../gl/batch';
import { Face } from '../gl/text';
import { PALETTE } from '../palette';
import { TEXT } from '../typography';
import { entity, clamp01, glow, channels } from '../gl/primitives';
import { drawEyes } from './arena';
import type { Renderer } from '../renderer';

export function drawAce(rend: Renderer, s: SimState, fb: Feedback): void {
  if (s.meta[Meta.AceX] === 0) return;
  const b = rend.batch;
  let x = toFloat(s.meta[Meta.AceX]);
  const y = toFloat(s.meta[Meta.AceY]);
  const g = s.meta[Meta.AceGesture] as AceGesture;
  // Покачивание: он живой и ему скучно, пока игрок воюет. Жест этот покой
  // и ломает — тем и читается.
  let bob = Math.sin(s.tick * 0.05) * 6;
  let tilt = 0;
  let jitter = 0;
  if (g === AceGesture.Yawn) bob = Math.sin(s.tick * 0.02) * 10 - 4;
  if (g === AceGesture.Applaud || g === AceGesture.Ovation) {
    // Подпрыгивает: модуль синуса — прыжок, а не качание.
    bob = Math.abs(Math.sin(s.tick * 0.28)) * (g === AceGesture.Ovation ? 26 : 16);
  }
  if (g === AceGesture.TurnAway) tilt = 0.25;
  if (g === AceGesture.Fidget) {
    jitter = Math.sin(s.tick * 0.9) * 3;
    tilt = Math.sin(s.tick * 0.45) * 0.12;
  }
  x += jitter;

  /*
   * Тулья и поля цилиндра — над лицом, а не вместо него.
   *
   * До этой правки Крупье был одним боксом с глазами прямо на нём: с шага
   * назад он читался как плывущий прямоугольник, а не персонаж. Цилиндр
   * остаётся его отличительным силуэтом (GDD §17А), но теперь сидит на
   * круглом лице, как и положено головному убору — форма читается сразу,
   * без подписи.
   *
   * Тулья короче прежней (20 вместо 26): освободившееся место уходит лицу.
   * Кремовый несущий контур в 4 единицы — тот же, что и раньше; на трёх он
   * выходил в два пикселя реального экрана, и Крупье не было видно вовсе.
   */
  // Ореол при активном жесте: тело Крупье ~35×50px на игровом разрешении
  // теряется на общем фоне без него (GDD §17А, ТЗ-3 iter-3) — тот же приём,
  // что уже поднимает вес игрока/снарядов/фишек (см. `glow` выше).
  if (g !== AceGesture.None) {
    glow(b, Shape.Circle, x, y + bob + 12, 34, PALETTE.ace, 0.22);
  }

  entity(b, Shape.Box, x, y + bob - 6, 20, 20, tilt, PALETTE.ace, 0.85);
  b.push(Shape.Box, x, y + bob + 12, 30, 5, tilt, ...channels(PALETTE.ace), 0.85, 0, 0, 0, 0, 0);
  entity(b, Shape.Circle, x, y + bob + 32, 17, 17, 0, PALETTE.ace, 0.85);

  /*
   * Глаза: обычно смотрит на игрока — за ним и пришёл.
   *
   * На БЛИЖАЙШЕГО живого, а не на первого по номеру. Взгляд — половина
   * характера Крупье (GDD §17А), и вчетвером «всегда на P1» читается не как
   * внимание, а как поломка: заведение пялится в одну точку, пока рядом
   * умирает кто-то другой. Мёртвые из счёта выбывают: смотреть на тело —
   * это уже другой жест, и он не заказан.
   */
  let dx = 0;
  let dy = 0;
  let near = -1;
  for (let p = 0; p < s.playerCount; p++) {
    if ((s.pFlags[p] & EntityFlag.Alive) === 0) continue;
    const px = toFloat(s.pX[p]) - x;
    const py = toFloat(s.pY[p]) - y;
    const d = px * px + py * py;
    if (near < 0 || d < near) {
      near = d;
      dx = px;
      dy = py;
    }
  }
  const len = Math.hypot(dx, dy) || 1;
  const look = g === AceGesture.TurnAway ? -1 : 1;
  if (g !== AceGesture.Yawn) {
    // Глаза на круге-лице (y+bob+32), не на тулье — ТЗ-1 iter-3: тулья
    // занимает y+bob-26..y+bob+14, лицо y+bob+15..y+bob+49.
    drawEyes(rend, x, y + bob + 32, 9, (look * dx) / len, (look * dy) / len, 6, false);
  } else {
    // Зевает: щёлки вместо глаз и открытый рот — на лице же.
    const e = PALETTE.pupil;
    for (const sx of [-5, 5]) {
      b.push(Shape.Box, x + sx, y + bob + 32, 5, 1.5, 0, e.r, e.g, e.b, 0.9, 0, 0, 0, 0, 0);
    }
    const m = 3 + Math.abs(Math.sin(s.tick * 0.02)) * 4;
    b.push(Shape.Circle, x, y + bob + 22, m, m, 0, e.r, e.g, e.b, 0.9, 0, 0, 0, 0, 0);
  }

  // Перчатки: хлопают в ладоши на провале и на овации, показывают палец
  // вниз, когда игрок соскочил в шаге от куша.
  if (g === AceGesture.Applaud || g === AceGesture.Ovation) {
    const spread = 10 + Math.abs(Math.cos(s.tick * 0.28)) * 10;
    for (const sx of [-spread, spread]) {
      b.push(
        Shape.Circle,
        x + sx,
        y + bob - 14,
        6,
        6,
        0,
        ...channels(PALETTE.ace),
        0.95,
        0,
        0,
        0,
        0,
        0,
      );
    }
  }
  if (g === AceGesture.ThumbsDown) {
    // Кулак + палец вниз из двух примитивов, в кремовой палитре перчаток
    // (PALETTE.ace), не в PALETTE.danger — красный путал жест с боевым
    // телеграфом атаки (ТЗ-2 iter-3).
    const c = PALETTE.ace;
    b.push(Shape.Box, x + 22, y + bob - 10, 7, 7, 0, c.r, c.g, c.b, 0.95, 0, 0, 0, 0, 0);
    b.push(Shape.Box, x + 22, y + bob - 1, 3, 6, 0, c.r, c.g, c.b, 0.95, 0, 0, 0, 0, 0);
  }

  if (s.meta[Meta.TossAt] !== 0) {
    const left = Math.max(0, s.meta[Meta.TossAt] - s.tick);
    // Длительность берётся у того, кто её назначил. Зашитая тридцатка
    // совпадала с ней случайно, и правка телеграфа в конфиге молча
    // разъехалась бы с кольцом, которое этот телеграф и показывает.
    const t = clamp01(1 - left / CARD.aceTelegraphTicks);
    const c = PALETTE.card;
    b.push(
      Shape.Ring,
      x,
      y + bob - 40,
      10 + 22 * t,
      10 + 22 * t,
      0,
      0,
      0,
      0,
      0,
      3,
      c.r,
      c.g,
      c.b,
      0.8 - 0.5 * t,
    );
  }

  /*
   * Реплика — подписью под Крупье, и только пока он на арене.
   *
   * Своего таймера у неё нет намеренно. Крупье уходит через три секунды после
   * выхода (PRODUCTION §3), и реплика уходит вместе с ним: второй счётчик
   * жил бы своей жизнью и однажды оставил бы фразу висеть над пустым полом.
   *
   * Реплика — приправа к жесту, а не его замена (GDD §17А), поэтому она
   * мельче HUD и приглушена: тело Крупье остаётся главным, а строка читается
   * тем, кто успел на неё посмотреть. Субтитры для тех, кто не слышит, —
   * отдельная настройка со своим кеглем и фоном (UX §5).
   */
  if (fb.bark !== '') {
    const c = PALETTE.hudText;
    /*
     * Реплика зажимается в границы арены по своей измеренной ширине.
     *
     * Она центрируется по фигуре, а фигура выходит к самой кромке: у левого
     * края реплика начиналась за экраном и читалась с середины слова. Поле
     * в 40 единиц — то же, что у игровой зоны.
     */
    const half = rend.text.width(fb.bark, TEXT.body, Face.Ui) / 2;
    const pad = 40;
    const arenaW = toFloat(s.arenaW);
    const bx = Math.min(Math.max(x, pad + half), arenaW - pad - half);
    rend.text.push(fb.bark, bx, y + bob + 62, TEXT.body, Face.Ui, c.r, c.g, c.b, 0.9, 'center');
  }
}

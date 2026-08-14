/**
 * Крупье: тело, жесты, реплика.
 *
 * `drawAce` читает `batch`/`text` напрямую и зовёт `drawEyes` — то, чего в
 * `RenderKit` нет и не должно быть (см. комментарий у интерфейса в
 * `renderer.ts`). Принимает сам `Renderer`, а не кит, как соседние экраны в
 * `screens/run.ts`.
 */
import { AceGesture, EntityFlag, CARD, Meta, toFloat, type SimState } from '@dod/sim';
import type { Feedback } from '../feedback';
import { Shape, type ShapeBatch } from '../gl/batch';
import { Face } from '../gl/text';
import { PALETTE } from '../palette';
import { TEXT } from '../typography';
import { entity, clamp01, glow, channels } from '../gl/primitives';
import type { Renderer } from '../renderer';

/**
 * Глаза Крупье: НЕПОДВИЖНАЯ пара плюс зрачок, смещённый в сторону взгляда.
 *
 * Не переиспользует `drawEyes` (`screens/arena.ts`) специально: та ставит
 * саму пару глаз ПЕРПЕНДИКУЛЯРНО направлению взгляда — приём, рассчитанный
 * на существ без верха и низа (враги, Желешка), которые могут «смотреть»
 * туда и разворачиваться вместе со взглядом всем телом. У Крупье есть
 * голова с фиксированным верхом (цилиндр) и лицо на строго определённом
 * месте под ним, и та же формула при взгляде вниз или по диагонали
 * разворачивала пару глаз в вертикальную линию — на лице это читается не
 * как взгляд в сторону, а как повреждённое лицо (владелец, iter-9: «глаза
 * ужасные, как у камбалы, повёрнутые на бок»). Здесь склеры стоят на
 * фиксированной горизонтали всегда, а взгляд несёт только зрачок,
 * смещённый внутри склеры, — тот же приём, что в любой мультипликации.
 */
function drawAceEyes(b: ShapeBatch, x: number, y: number, gx: number, gy: number): void {
  const scleraR = 6.5;
  const pupilR = 3;
  const reach = scleraR - pupilR - 0.5;
  const eye = PALETTE.eye;
  const pupil = PALETTE.pupil;
  for (const sx of [-9, 9]) {
    const ex = x + sx;
    b.push(Shape.Circle, ex, y, scleraR, scleraR, 0, ...channels(eye), 1, 0, 0, 0, 0, 0);
    b.push(
      Shape.Circle,
      ex + gx * reach,
      y + gy * reach,
      pupilR,
      pupilR,
      0,
      ...channels(pupil),
      1,
      0,
      0,
      0,
      0,
      0,
    );
  }
}

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
   * Силуэт целиком: цилиндр внахлёст с лицом, а не отдельно висящие фигуры.
   *
   * Прежняя сборка (тулья-бокс, поля-бокс, лицо-круг) стояла тремя фигурами
   * с зазорами между ними — с шага назад читалась как случайный набор
   * примитивов, а не персонаж (владелец, iter-9: «сейчас это набор
   * геометрических фигур»). Здесь то же самое количество примитивов, но
   * трогающихся друг друга по вертикали БЕЗ зазора: поля садятся на нижний
   * край тульи, лицо начинается на верхнем крае полей — три фигуры читаются
   * одной формой ровно потому, что нигде не видно фона между ними.
   *
   * Пип туза на лбу тульи (GDD §17А: «туз на тулье») — единственная деталь,
   * которой у Крупье не было ВООБЩЕ: до этой правки «Крупье» отличался от
   * безымянного цилиндра только текстом реплики. Ромб через повёрнутый на
   * 45° квадрат — других способов нарисовать пип без кривых в этой палитре
   * примитивов (`gl/batch.ts`) нет, и ромб — единственная форма из четырёх
   * карточных мастей, которая получается из квадрата поворотом, а не дугой.
   */
  const crownY = y + bob - 20;
  const bandY = y + bob - 2;
  const brimY = y + bob + 8;
  const faceY = y + bob + 30;

  // Ореол при активном жесте: тело Крупье теряется на общем фоне без него
  // (GDD §17А, ТЗ-3 iter-3) — тот же приём, что уже поднимает вес игрока,
  // снарядов и фишек (см. `glow` выше). Центр и радиус растянуты под новый,
  // более высокий силуэт (цилиндр вместо низкой тульи).
  if (g !== AceGesture.None) {
    glow(b, Shape.Circle, x, y + bob + 8, 40, PALETTE.ace, 0.22);
  }

  entity(b, Shape.Box, x, crownY, 15, 20, tilt, PALETTE.ace, 0.9);
  b.push(Shape.Box, x, bandY, 15.5, 3, tilt, ...channels(PALETTE.accent), 0.95, 0, 0, 0, 0, 0);
  b.push(
    Shape.Box,
    x,
    bandY,
    3.5,
    3.5,
    tilt + Math.PI / 4,
    ...channels(PALETTE.ace),
    0.95,
    0,
    0,
    0,
    0,
    0,
  );
  entity(b, Shape.Box, x, brimY, 32, 5, tilt, PALETTE.ace, 0.9);
  // Второй, более тонкий контур полей чуть ниже основного — край цилиндра
  // читается ТОЛЩИНОЙ, а не одной плоской линией (владелец, iter-9: «сделай
  // более сложную рисовку»).
  entity(b, Shape.Box, x, brimY + 5, 26, 2, tilt, PALETTE.ace, 0.6);
  entity(b, Shape.Circle, x, faceY, 18, 18, 0, PALETTE.ace, 0.9);

  /*
   * Бабочка на воротнике — костюмная деталь дилера (GDD §17А зовёт его
   * «Крупье», не просто цилиндром), а заодно и единственный элемент силуэта
   * ниже лица: без неё фигура обрывается на подбородке, что на общем плане
   * читается как обрезанный кадр, а не как «у него нет тела по замыслу».
   * Два треугольника остриями друг к другу и узел-квадрат между ними — тот
   * же набор примитивов, что у пипа туза (без кривых в этой палитре форм).
   */
  const bowY = faceY + 21;
  b.push(Shape.Triangle, x - 7, bowY, 8, 6, tilt, ...channels(PALETTE.accent), 0.9, 0, 0, 0, 0, 0);
  b.push(
    Shape.Triangle,
    x + 7,
    bowY,
    8,
    6,
    tilt + Math.PI,
    ...channels(PALETTE.accent),
    0.9,
    0,
    0,
    0,
    0,
    0,
  );
  b.push(Shape.Box, x, bowY, 2.5, 2.5, tilt, ...channels(PALETTE.ace), 0.95, 0, 0, 0, 0, 0);

  /*
   * Перчатки — часть силуэта ВСЕГДА, а не только во время жеста.
   *
   * GDD §17А называет их постоянной приметой («парящий цилиндр... с белыми
   * перчатками»), а рисовались они только внутри `if (g === Applaud...)` —
   * в состоянии покоя Крупье вообще не имел рук. Разнос от центра (28) взят
   * заметно шире прежних 10–20 у аплодисментов намеренно: на том разносе
   * ладони наезжали на тулью (её полуширина 15), и находка со снимка
   * приближённого кадра (`ace-gesture-applaud-zoom`) — сросшиеся с тульёй
   * перчатки — читалась не как хлопок, а как поломка силуэта.
   */
  const restHandY = y + bob + 34;
  const handColour = PALETTE.ace;
  if (g === AceGesture.Applaud || g === AceGesture.Ovation) {
    // Хлопок НАД цилиндром, а не сбоку от него: ладони идут от разноса покоя
    // к точке схождения над тульёй — то же движение, что и настоящий хлопок.
    // Верх тульи — `crownY − 20` (полувысота 20), цель хлопка ещё на 10 выше
    // него, иначе смыкание останется на уровне полей, а не над цилиндром.
    const crownTop = crownY - 20;
    const t = clamp01(Math.abs(Math.sin(s.tick * 0.28)));
    const spread = 26 - 22 * t;
    const clapY = restHandY - (restHandY - (crownTop - 10)) * t;
    for (const sx of [-spread, spread]) {
      b.push(Shape.Circle, x + sx, clapY, 7, 7, 0, ...channels(handColour), 0.95, 0, 0, 0, 0, 0);
    }
  } else if (g === AceGesture.ThumbsDown) {
    // Левая ладонь остаётся в покое, правая складывается в кулак с пальцем
    // вниз — жест читается ОДНОЙ рукой, вторая не отвлекает симметрией.
    b.push(Shape.Circle, x - 28, restHandY, 7, 7, 0, ...channels(handColour), 0.95, 0, 0, 0, 0, 0);
    const fx = x + 28;
    b.push(Shape.Box, fx, restHandY - 4, 7, 7, 0, ...channels(handColour), 0.95, 0, 0, 0, 0, 0);
    b.push(Shape.Box, fx, restHandY + 6, 3, 6, 0, ...channels(handColour), 0.95, 0, 0, 0, 0, 0);
  } else {
    // Покой (и суета — дрожь общего `jitter` уже сдвигает всю фигуру целиком,
    // рукам отдельной анимации не нужно): обе ладони на своих местах.
    for (const sx of [-28, 28]) {
      b.push(
        Shape.Circle,
        x + sx,
        restHandY,
        7,
        7,
        0,
        ...channels(handColour),
        0.85,
        0,
        0,
        0,
        0,
        0,
      );
    }
  }

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
  /*
   * Брови — то немногое, что переводит «шарик с глазами» в «характер».
   * Скептический наклон по умолчанию (внешние концы выше внутренних) читает
   * Крупье как оценивающего, а не безучастного; жесты сдвигают наклон и
   * высоту — тем же приёмом, что мимика бровей работает у живых актёров:
   * положение глаз не меняется вовсе, меняется только то, что над ними.
   */
  let browTilt = 0.18;
  let browY = -12;
  if (g === AceGesture.ThumbsDown) browTilt = -0.32;
  if (g === AceGesture.Applaud || g === AceGesture.Ovation) {
    browTilt = -0.1;
    browY = -14;
  }
  if (g !== AceGesture.Yawn) {
    for (const side of [-1, 1]) {
      b.push(
        Shape.Box,
        x + side * 9,
        faceY + browY,
        5,
        1.6,
        side * browTilt,
        ...channels(PALETTE.pupil),
        0.85,
        0,
        0,
        0,
        0,
        0,
      );
    }
    drawAceEyes(b, x, faceY, (look * dx) / len, (look * dy) / len);
  } else {
    // Зевает: щёлки вместо глаз и открытый рот — на лице же.
    const e = PALETTE.pupil;
    for (const sx of [-9, 9]) {
      b.push(Shape.Box, x + sx, faceY, 6, 1.5, 0, e.r, e.g, e.b, 0.9, 0, 0, 0, 0, 0);
    }
    const m = 3 + Math.abs(Math.sin(s.tick * 0.02)) * 4;
    b.push(Shape.Circle, x, faceY + 9, m, m, 0, e.r, e.g, e.b, 0.9, 0, 0, 0, 0, 0);
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

/**
 * Боевой HUD: сердца, кошелёк, аппетит, волны, статус, плашки пари.
 *
 * Как и `screens/run.ts`, функции здесь читают `batch`/`text`/`scheme`
 * напрямую — то, что в `RenderKit` не входит (см. `renderer.ts`, комментарий
 * к интерфейсу), — и принимают вместо кита сам `Renderer`. Перенос почти
 * буквальный: тела методов не менялись, только `this.` → `r.`.
 */
import {
  aceCardAt,
  BETS,
  BetProgress,
  BetState,
  MAX_ACTIVE_BETS,
  Curse,
  WAVE,
  MAX_UPGRADE_SLOTS,
  FX_ONE,
  cashOutValue,
  nearMissOf,
  EntityFlag,
  InputScheme,
  ROOMS_PER_FLOOR,
  TICK_HZ,
  Meta,
  PLAYER,
  RunPhase,
  stakeFor,
  type SimState,
} from '@dod/sim';
import type { Feedback } from '../feedback';
import { Shape } from '../gl/batch';
import { Face } from '../gl/text';
import { t, type StringKey } from '../i18n';
import { ENTITY_FILL, PALETTE, type Rgb } from '../palette';
import { lineStep, TEXT } from '../typography';
import { entity, edgeSafeX, clamp01, channels, drawNumber, drawMultiplier } from '../gl/primitives';
import { categoryColour, drawBetIcon } from './betHelpers';
import { drawAceBetScreen, drawSettlement } from './run';
import type { Renderer } from '../renderer';

/**
 * Полувысота цифры в HUD.
 *
 * Правило UX §4 — минимум 24 px при 1080p, «читается с дивана в двух
 * метрах». Первая версия рисовала цифры вдвое мельче, и на деле их не было
 * видно вовсе: палочка толщиной в полторы условные единицы на реальном экране
 * тоньше пикселя и просто не попадает в растр.
 */
const HUD_DIGIT = 13;

/** Тиров кона три: Скромно / Нормально / По-крупному (GDD §9.3). */
const APPETITE_TIERS = 3;

/**
 * Плашка активного пари: полуширина подробной и сжатой, полувысота, зазор.
 *
 * Подробная плашка показывает сделку целиком — пари, множитель, кон и растущий
 * куш, — но вчетвером их четыре штуки в колонке шириной 240 единиц, и подробных
 * туда влезает одна. Остальные сжимаются до иконки с множителем: ровно то, что
 * UX §4 и предписывает («не больше восьми видимых элементов, детали — по
 * удержанию»). В соло и вдвоём места хватает всем, и сжимать нечего.
 */
const PLAQUE_WIDE = 44;
const PLAQUE_TIGHT = 20;
const PLAQUE_HALF_H = 25;
const PLAQUE_GAP = 6;

/**
 * Имена проклятий из словаря — таблицей, а не вычисляемым ключом.
 *
 * Та же причина, что у дверей: перечисление в сборке ради шести строк держать
 * незачем, а опечатка в ключе падает линтером словаря, а не пустой надписью на
 * экране.
 */
const CURSE_NAME: Readonly<Partial<Record<Curse, StringKey>>> = {
  [Curse.Blood]: 'curse.blood',
  [Curse.Hustle]: 'curse.hustle',
  [Curse.LeadFeet]: 'curse.lead_feet',
  [Curse.Frozen]: 'curse.frozen',
  [Curse.Blackout]: 'curse.blackout',
  [Curse.Commission]: 'curse.commission',
};

/**
 * Строка боевого HUD целиком: сердца, кошелёк, аппетит, кон, волны, комната,
 * статус, куш «Забрать/дожать», Ставка Крупье/расчёт и отсчёт после гибели.
 *
 * Порядок вызовов сохранён буквально — расчёт СТАРШЕ Ставки Крупье, экран
 * ровно один в кадре (см. комментарий у вызова `drawSettlement`/
 * `drawAceBetScreen` ниже).
 */
export function drawHud(
  r: Renderer,
  s: SimState,
  w: number,
  h: number,
  fb: Feedback,
  cashOutTarget = -1,
): void {
  const b = r.batch;
  /*
   * 34, а не меньше: рамка арены (`drawFloor`) — один гигантский `Shape.Box`
   * на весь стол, а скругление угла в шейдере (`gl/batch.ts`) — фиксированные
   * 25% МЕНЬШЕЙ полустороны фигуры. На арене 1920×1080 это ~134 единицы
   * радиуса — на порядок больше, чем у любой карточки интерфейса, для
   * которой формула и подобрана. При верхней строке HUD близко к 0 дуга
   * скругления проходила почти через сами сердца в углу (проверено прямым
   * рендером — на левом верхнем сердце дуга давала зазор около 9 единиц).
   * Трогать общую формулу шейдера нельзя — она общая на все прямоугольники
   * игры, от кнопок до этой рамки, — поэтому строка просто отодвинута вниз
   * настолько, чтобы лечь за дугой, и не настолько, чтобы над ней вырос
   * пустой отступ: первая правка (75) убирала пересечение с запасом в 4
   * раза больше нужного и читалась как отдельный зазор над HUD, а не как
   * его положение. 60 даёт тот же зазор от дуги (~9 единиц), что раньше
   * был у самой границы, но уже с внешней стороны от неё.
   */
  const top = 60;

  for (let i = 0; i < s.playerCount; i++) {
    const colour = PALETTE.player[i] as Rgb;
    const baseX = edgeSafeX(w) + i * 240;
    /*
     * Колонка мёртвого гаснет целиком.
     *
     * Сердца пустели, но всё остальное — кошелёк, аппетит, плашки — жило
     * прежней яркостью, и колонка выглядела колонкой живого. В коопе это
     * прямая ложь: рядом с именем напарника надо видеть, что он лежит.
     */
    const alive = (s.pFlags[i] & EntityFlag.Alive) !== 0;
    if (!alive) {
      const d = PALETTE.hudDim;
      for (const angle of [Math.PI / 4, -Math.PI / 4]) {
        b.push(Shape.Box, baseX + 34, top, 30, 3, angle, d.r, d.g, d.b, 0.8, 0, 0, 0, 0, 0);
      }
      continue;
    }
    for (let n = 0; n < PLAYER.startHearts; n++) {
      const full = n < s.pHearts[i];
      /*
       * Сердце в новом языке: тёмное поле с обводкой своего цвета, а полное
       * от пустого отличается ЯДРОМ внутри.
       *
       * Раньше разницу нёс цвет заливки, и с общей тёмной заливкой она
       * исчезла бы вовсе: сердце — тот показатель, ради которого игрок косит
       * глазом в бою, и различать его по яркости одной обводки значит не
       * различать никак. Ядро — второй признак к яркости контура, то же
       * двойное кодирование, что и везде.
       */
      const hx = baseX + n * 34;
      entity(b, Shape.Hexagon, hx, top, 13, 13, 0, colour, full ? 1 : 0.45, 3);
      if (full) {
        // Ядро крупнее прежних шести единиц: на 1080p это было шесть
        // пикселей, то есть «двойное кодирование» держалось на пятнышке,
        // которое в бою не разглядеть.
        b.push(Shape.Hexagon, hx, top, 9, 9, 0, colour.r, colour.g, colour.b, 1, 0, 0, 0, 0, 0);
      }
    }
    // Кошелёк рядом со своими сердцами: чьи фишки — видно без подписи.
    drawNumber(b, s.pChips[i], baseX + 150, top, HUD_DIGIT, PALETTE.chip);

    /*
     * Аппетит — тремя пипсами рядом с кошельком.
     *
     * Кон объявлен настоящим решением (ECONOMY §7), а решение, которого не
     * видно, решением не является: игрок нажимал крестовину и не мог
     * убедиться, что попал. Пипсы стоят вплотную к кошельку намеренно —
     * тир и есть то, что из кошелька уйдёт за следующую карту.
     */
    for (let tier = 0; tier < APPETITE_TIERS; tier++) {
      const on = tier <= s.pAppetite[i];
      const c = PALETTE.chip;
      const px = baseX + 196 + tier * 13;
      const ph = 4 + tier * 3;
      // Тот же приём, что у сердец: выбранный тир отличается ядром, а не
      // одной лишь яркостью контура. Пипс шириной 4 единицы обводится
      // двойкой, а не четвёркой, — четвёрка на такой ширине и есть заливка.
      entity(b, Shape.Box, px, top + 4, 4, ph, 0, c, on ? 1 : 0.45, 2);
      if (on) b.push(Shape.Box, px, top + 4, 1.6, ph - 3, 0, c.r, c.g, c.b, 1, 0, 0, 0, 0, 0);
    }
    /*
     * Сам кон — числом ПОД пипсами, а не сбоку от них.
     *
     * Три штриха по четыре единицы шириной были единственной индикацией
     * решения, объявленного настоящим (ECONOMY §7): попал игрок в нужный
     * тир или нет, по ним не видно вовсе. Число говорит то же самое и
     * тем же языком, что кошелёк рядом, — семисегментным табло. Раньше
     * стояло справа от пипсов (`baseX + 250`) — при шаге колонки в 240
     * единиц (см. `baseX` выше) это уже территория СЛЕДУЮЩЕГО игрока, и на
     * трёх-четырёх колонках двузначный кон слипался с сердцами соседа
     * (iter-7/iter-8, readability). Строкой ниже пипсов номер остаётся в
     * границах своей колонки при любом их числе.
     */
    drawNumber(b, stakeFor(s, i), baseX + 196, top + 18, 9, PALETTE.hudDim, 0.9);
    drawBets(r, s, i, baseX, top + 46, i === 0 ? cashOutTarget : -1);
  }

  /*
   * Долг, проклятие и купленные апгрейды — правая половина верхней полосы.
   *
   * Ни одного из трёх в интерфейсе не было вовсе, хотя все три меняют бой
   * прямо сейчас. Проклятие «Свинцовые ноги» отключает рывок — и без
   * подписи это неотличимо от сломанной кнопки; «Заморозка» запрещает
   * подбирать фишки; долг обещает Долговую яму вместо одной из дверей.
   * Апгрейды же игрок покупает весь забег и нигде их больше не видит.
   *
   * Буквы здесь есть, и это единственное отступление от «в бою букв нет»
   * (UX §4) — по той же причине, по какой имя пари подписано над картой:
   * пиктограммы у проклятий нет, а «условия пересмотрены» игрок обязан
   * прочитать один раз, а не разгадывать весь бой. Строка стоит в углу,
   * приглушённой, и не спорит с ареной.
   */
  drawStatus(r, s, w, top);
  drawCurseVignette(r, s, w, h);

  // Волна — пипсами справа: сколько всего и сколько прошло.
  const waves = WAVE.wavesPerRoom;
  for (let n = 0; n < waves; n++) {
    const done = n < s.meta[Meta.Wave];
    const c = PALETTE.hudText;
    const wx = w - edgeSafeX(w) - (waves - 1 - n) * 26;
    entity(b, Shape.Circle, wx, top, 8, 8, 0, c, done ? 0.9 : 0.5, 2);
    // Пройденная волна — с ядром: те же два признака, что у сердец и пипсов.
    if (done) b.push(Shape.Circle, wx, top, 3.5, 3.5, 0, c.r, c.g, c.b, 1, 0, 0, 0, 0, 0);
  }
  /*
   * Комната — числом «из восьми», а не одинокой цифрой.
   *
   * Голая «1» у правого края не говорила ни о чём: сколько всего комнат на
   * этаже, игрок ниоткуда не знает, а знать обязан — от этого зависит,
   * копить кон или тратить. Дробь читается тем же табло, что кошелёк.
   */
  const roomX = w - edgeSafeX(w) - waves * 26 - 96;
  drawNumber(b, s.meta[Meta.Room], roomX, top, HUD_DIGIT, PALETTE.hudDim);
  const d = PALETTE.hudDim;
  b.push(Shape.Box, roomX + 16, top, 8, 1.6, -Math.PI / 3, d.r, d.g, d.b, 0.7, 0, 0, 0, 0, 0);
  drawNumber(b, ROOMS_PER_FLOOR, roomX + 34, top, HUD_DIGIT, PALETTE.hudDim, 0.7);

  drawCashOutSummary(r, s);
  /*
   * Ставка Крупье СТАРШЕ расчёта, и экран в кадре ровно один.
   *
   * Оба рисовались безусловно и накладывались друг на друга: титул на титул,
   * красный кон поверх строки расчёта, а подпись «подтвердить» —
   * перечёркнутая числом. Хуже вёрстки было то, что `Confirm` в таком кадре
   * означал две вещи сразу: пропуск расчёта и принятие пари на четверть
   * кошелька. Расчёт ничего не ждёт и кончается сам, Ставка требует
   * решения — поэтому уступает расчёт.
   */
  if (aceCardAt(s) >= 0) drawAceBetScreen(r, s, w, h, fb);
  else drawSettlement(r, s, w, h, fb);

  /*
   * Отсчёт после гибели: сколько осталось до итогов.
   *
   * Раньше это поле означало «сейчас перезапустимся», и кольцо честно
   * отсчитывало перезапуск. В 0.4.0 перезапуск заменён концом забега, поле
   * осталось — и кольцо начало отсчитывать до нуля, замирать на нём и
   * ничего не объяснять: игрок видел красный ноль и застывший бой. Теперь
   * оно рисуется ТОЛЬКО пока идёт отсчёт, а на нуле его сменяет экран
   * итогов.
   */
  if (s.meta[Meta.RestartAt] !== 0 && s.meta[Meta.Phase] !== RunPhase.Summary) {
    const left = Math.max(0, s.meta[Meta.RestartAt] - s.tick);
    const c = PALETTE.danger;
    /*
     * Отсчёт назван словами, а не оставлен голым кольцом с цифрой.
     *
     * Кольцо с числом — уже занятая форма: ровно так выглядит обратный
     * отсчёт паузы на расчёте. Одна форма означала «сейчас продолжим» и «вы
     * погибли», и игрок не мог понять, ведёт ли это к возрождению, к итогам
     * или к перезапуску. Затемнение здесь тоже обязательно: бой продолжался
     * вокруг и спорил с единственным, что в этот момент важно.
     */
    r.dim(w, h);
    r.screenTitle(t('death.title'), w, h / 2 - 150);
    r.screenLine(t('death.hint'), w, h / 2 - 92, PALETTE.hudDim, TEXT.subtitle);
    b.push(Shape.Ring, w / 2, h / 2, 60, 60, 0, 0, 0, 0, 0, 6, c.r, c.g, c.b, 0.9);
    drawNumber(b, Math.ceil(left / TICK_HZ), w / 2, h / 2, 42, PALETTE.hudText);
  }

  r.drawRunScreens(s, w, h, fb);
}

/**
 * Тьма (GDD §11): виньетка по кромке экрана на всю проклятую комнату.
 *
 * Только в бою (`RunPhase.Fight`) — на экранах двери, лавки и расчёта
 * проклятие уже снято по смыслу (`CurseRoom` считает именно бой), а
 * рисовать поверх чужого экрана нечего. Фигуры те же кольца, что у
 * `screenBase`: по PRODUCTION §4 шейдерная виньетка здесь запрещена, а
 * несколько полупрозрачных боксов у кромки дают тот же эффект дешевле.
 *
 * Цвет и альфа заметно выше, чем у постоянной виньетки пола (`drawFloor`,
 * те же кольца у тех же кромок): первая итерация каталога съёмки
 * (`curse-blackout.png` против `fight.png`) показала, что чёрная виньетка
 * поверх и без того тёмного фона арены (`PALETTE.background`) складывается
 * с фоновой виньеткой пола неотличимо — проклятие называет себя в HUD, но
 * не читается на самой арене. Фиолетовый оттенок вместо чёрного и тройная
 * альфа дают сигнал, узнаваемый как ЭФФЕКТ, а не как более тёмный пол.
 */
export function drawCurseVignette(r: Renderer, s: SimState, w: number, h: number): void {
  if (s.meta[Meta.Phase] !== RunPhase.Fight) return;
  if (s.meta[Meta.Curse] !== Curse.Blackout || s.meta[Meta.CurseRoom] !== 1) return;

  const b = r.batch;
  const cx = w / 2;
  const cy = h / 2;
  const rings = 4;
  // Тёмно-фиолетовый, а не чёрный: чёрный сливается с фоном арены
  // (PALETTE.background), фиолетовый читается отдельным слоем поверх него.
  // Каналы — доли [0, 1], как у всего Rgb в этом файле (`palette.ts`), а не
  // байты 0–255: перепутанные один раз, они клэмпятся до белого/пурпурного
  // мусора по кромке экрана вместо мягкого оттенка.
  const tint = { r: 46 / 255, g: 10 / 255, b: 64 / 255 };
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    // Кольца полос у каждой из четырёх кромок, а не сплошной бокс: сплошная
    // заливка легла бы и на центр арены, где идёт сам бой. Каждое кольцо —
    // тоньше и темнее предыдущего, так виньетка сгущается ровно к краю.
    const depth = (0.06 + 0.11 * t) * Math.min(cx, cy);
    const alpha = 0.34 * (1 - t * 0.55);
    b.push(
      Shape.Box,
      cx,
      depth / 2,
      cx,
      depth / 2,
      0,
      tint.r,
      tint.g,
      tint.b,
      alpha,
      0,
      0,
      0,
      0,
      0,
    );
    b.push(
      Shape.Box,
      cx,
      h - depth / 2,
      cx,
      depth / 2,
      0,
      tint.r,
      tint.g,
      tint.b,
      alpha,
      0,
      0,
      0,
      0,
      0,
    );
    b.push(
      Shape.Box,
      depth / 2,
      cy,
      depth / 2,
      cy,
      0,
      tint.r,
      tint.g,
      tint.b,
      alpha,
      0,
      0,
      0,
      0,
      0,
    );
    b.push(
      Shape.Box,
      w - depth / 2,
      cy,
      depth / 2,
      cy,
      0,
      tint.r,
      tint.g,
      tint.b,
      alpha,
      0,
      0,
      0,
      0,
      0,
    );
  }
}

/**
 * Подсказка обучения — одной строкой над нижней кромкой арены.
 *
 * Место выбрано так, чтобы её было видно, не отрывая глаз от боя, и чтобы
 * она не спорила с самим боем: ниже игровой гущи, выше кромки. Подложка
 * обязательна — строка ложится на арену, где под ней бывает что угодно.
 *
 * Буквы здесь есть, и это осознанное исключение из «в бою букв нет»
 * (UX §4): урок живёт ровно до того момента, как игрок нажмёт нужную
 * кнопку, а научить кнопке формой нельзя — форма и есть то, чего игрок ещё
 * не знает.
 */
export function drawCoach(r: Renderer, text: string, w: number, h: number): void {
  if (text === '') return;
  const b = r.batch;
  const cx = w / 2;
  const cy = h - 96;
  const halfW = r.text.width(text, TEXT.body, Face.Ui) / 2 + 28;
  const gold = PALETTE.accent;
  b.push(
    Shape.Box,
    cx,
    cy,
    halfW,
    26,
    0,
    ...channels(ENTITY_FILL),
    0.88,
    2,
    gold.r,
    gold.g,
    gold.b,
    0.55,
  );
  const c = PALETTE.hudText;
  r.text.push(text, cx, cy, TEXT.body, Face.Ui, c.r, c.g, c.b, 0.95, 'center');
}

/**
 * Проклятие, долг и купленные апгрейды — одной строкой под волнами.
 *
 * Пиктограмма апгрейда общая («плюс в кольце»), как и на витрине: своих
 * значков у апгрейдов нет, а выдуманный на глаз врал бы о том, что именно
 * куплено. Здесь важно ЧИСЛО купленного и сам факт, что покупки не пропали.
 */
export function drawStatus(r: Renderer, s: SimState, w: number, top: number): void {
  const b = r.batch;
  const curse = s.meta[Meta.Curse] as Curse;
  let y = top + 34;

  if (curse !== Curse.None) {
    const key = CURSE_NAME[curse];
    if (key) {
      const c = PALETTE.danger;
      r.text.push(t(key), w - edgeSafeX(w), y, TEXT.body, Face.Ui, c.r, c.g, c.b, 0.95, 'right');
      y += lineStep(TEXT.body);
    }
  }
  if (s.meta[Meta.Debt] > 0) {
    const c = PALETTE.hudDim;
    r.text.push(
      t('hud.debt'),
      w - edgeSafeX(w),
      y,
      TEXT.body,
      Face.Ui,
      c.r,
      c.g,
      c.b,
      0.9,
      'right',
    );
    y += lineStep(TEXT.body);
  }

  let owned = 0;
  for (let i = 0; i < MAX_UPGRADE_SLOTS; i++) {
    if (s.pUpgrades[i] !== 0) owned++;
  }
  if (owned === 0) return;
  const c = PALETTE.hudDim;
  for (let i = 0; i < owned; i++) {
    const x = w - edgeSafeX(w) - 6 - i * 28;
    b.push(Shape.Ring, x, y + 8, 10, 10, 0, 0, 0, 0, 0, 2.5, c.r, c.g, c.b, 0.85);
    b.push(Shape.Box, x, y + 8, 5, 1.6, 0, c.r, c.g, c.b, 0.85, 0, 0, 0, 0, 0);
    b.push(Shape.Box, x, y + 8, 1.6, 5, 0, c.r, c.g, c.b, 0.85, 0, 0, 0, 0, 0);
  }
}

/**
 * Общая сумма «Забрать/дожать» — баннер по центру нижней кромки.
 *
 * До сих пор эта сумма нигде не складывалась: каждая плашка сама по себе
 * называла свою выплату (`drawBets`), а решение «жать сейчас или ещё
 * потерпеть» игрок собирал в уме по нескольким числам сразу. Макет
 * («Дизайн игры «Забег»», 1a/1d-A) держит на этот случай отдельный баннер:
 * одна сумма сейчас, одна — если дожать все пари до конца.
 *
 * Только для локального игрока (индекс 0): решение «жать Забрать»
 * принимает тот, чья рука на кнопке, и сумма чужого кошелька здесь не при
 * чём.
 *
 * Букв нет — тот же столп, что у всего боевого HUD: только глиф кнопки и
 * два числа, большее золотом (то, что дадут сейчас), меньшее тусклым (то,
 * что дадут, если дожать всё).
 */
export function drawCashOutSummary(r: Renderer, s: SimState): void {
  const player = 0;
  let now = 0;
  let full = 0;
  let count = 0;
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    const k = player * MAX_ACTIVE_BETS + i;
    if (s.aState[k] !== BetState.Active) continue;
    // Ставку Крупье не обналичить — тот же фильтр, что у `cashOutBest`
    // (кон отрицательный: он чужой, «Забрать» не платит по нему ничего).
    // Без него баннер посчитал бы чужую ставку в общую сумму «дожать».
    if (s.aStake[k] < 0) continue;
    now += cashOutValue(s, player, i);
    full += Math.trunc((s.aStake[k] * BETS[s.aBet[k]].multiplier) / FX_ONE);
    count++;
  }
  if (count === 0) return;

  const b = r.batch;
  /*
   * Баннер переехал из игрового поля в HUD.
   *
   * Он стоял по центру нижней кромки — то есть поверх пола, там, где ходят
   * враги и летят снаряды: сумма куша спорила с боем ровно в тех кадрах,
   * когда решение «жать или терпеть» и принимается. Место у левой колонки
   * игрока: там же его сердца, кошелёк и плашки пари.
   */
  const cx = 190;
  const cy = 156;
  const halfW = 150;
  const halfH = 26;
  const gold = PALETTE.accent;
  b.push(
    Shape.Box,
    cx,
    cy,
    halfW,
    halfH,
    0,
    ...channels(ENTITY_FILL),
    0.82,
    2,
    gold.r,
    gold.g,
    gold.b,
    0.5,
  );

  /*
   * Глиф называет КНОПКУ, а не просто «что-то нажать».
   *
   * Оправа без содержимого сообщала ровно ноль: `Shift` и `LB` не названы
   * больше нигде в бою, и пустой квадрат читался украшением. Теперь внутри
   * оправы стоит знак: шеврон вверх — это `Shift`, две планки — `LB`
   * (плечевая кнопка). Буквами набирать нельзя — правило «в бою букв нет»
   * (UX §4), и оно тут работает: знак опознаётся быстрее слова.
   */
  const glyphX = cx - halfW + 26;
  const pad = r.scheme === InputScheme.Gamepad;
  if (pad) {
    // Плечевая кнопка: скруглённая планка с полосой сверху.
    b.push(Shape.Ring, glyphX, cy, 13, 13, 0, 0, 0, 0, 0, 3, gold.r, gold.g, gold.b, 0.9);
    b.push(Shape.Box, glyphX, cy - 4, 7, 1.8, 0, gold.r, gold.g, gold.b, 0.95, 0, 0, 0, 0, 0);
    b.push(Shape.Box, glyphX, cy + 3, 7, 1.8, 0, gold.r, gold.g, gold.b, 0.95, 0, 0, 0, 0, 0);
  } else {
    entity(b, Shape.Box, glyphX, cy, 13, 13, 0, gold, 0.9, 3);
    // Шеврон вверх — тот же знак, что напечатан на клавише Shift.
    for (const dx of [-3.2, 3.2]) {
      b.push(
        Shape.Box,
        glyphX + dx,
        cy - 1,
        5,
        1.8,
        dx < 0 ? -Math.PI / 4 : Math.PI / 4,
        gold.r,
        gold.g,
        gold.b,
        0.95,
        0,
        0,
        0,
        0,
        0,
      );
    }
    b.push(Shape.Box, glyphX, cy + 5, 6, 1.8, 0, gold.r, gold.g, gold.b, 0.95, 0, 0, 0, 0, 0);
  }

  drawNumber(b, now, glyphX + 56, cy, 20, PALETTE.chip);
  drawNumber(b, full, cx + halfW - 34, cy, 12, PALETTE.hudDim);
}

/**
 * Плашки активных пари игрока — под его сердцами и кошельком.
 *
 * Пятого числа здесь нет намеренно. Полная выплата за дожатое пари — это кон,
 * умноженный на множитель, то есть она уже сказана двумя показанными числами;
 * а вот шкала «дожать или соскочить» словами не говорится, и её несёт полоса
 * прогресса по нижней кромке плашки. Убран отсюда и одинокий глиф «Забрать»,
 * который стоял ПОСЛЕ последней плашки и не относился ни к одному числу:
 * кольцо переехало к тому кушу, про который кнопка и говорит.
 *
 * Плашка дышит: близкое к провалу пари дрожит, выигранное золотится.
 * Текста здесь нет по той же причине, что и на карте: пари читается
 * пиктограммой и цветом рамки, а имя ждёт расчёта.
 */
export function drawBets(
  r: Renderer,
  s: SimState,
  player: number,
  x: number,
  y: number,
  highlightSlot = -1,
): void {
  const b = r.batch;
  let cursor = x;
  let n = 0;

  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    const k = player * MAX_ACTIVE_BETS + i;
    const state = s.aState[k] as BetState;
    if (state === BetState.None) continue;

    const spec = BETS[s.aBet[k]];
    const colour = categoryColour(spec.category);
    // Вчетвером колонка игрока — 240 единиц, а сборка — до четырёх пари:
    // подробных плашек туда влезает ОДНА. Остальные сжимаются до иконки с
    // множителем (UX §4: «чужие — сжатыми иконками», детали по удержанию).
    const compact = s.playerCount > 2 && n > 0;
    const hw = compact ? PLAQUE_TIGHT : PLAQUE_WIDE;
    const cx = cursor + hw;
    cursor += hw * 2 + PLAQUE_GAP;
    n++;

    const won = state === BetState.Won || state === BetState.Cashed;
    const lost = state === BetState.Lost;
    // Дрожь достаётся только тому, что ещё можно потерять: проигранное
    // трясти незачем, оно уже проиграно.
    const shiver = state === BetState.Active && (s.tick >> 1) % 2 === 0 ? 1.5 : 0;
    const alpha = lost ? 0.25 : 1;
    const cxs = cx + shiver;
    /*
     * Выигранное золотится ОБВОДКОЙ, а не заливкой.
     *
     * Заливка у плашки теперь общая и тёмная, и «золотится» переехало туда,
     * где у неё вообще остался цвет, — в несущую рамку. Категория при этом не
     * теряется: её несёт пиктограмма, которая красится своим цветом всегда, а
     * заодно это единственный способ показать исход, не тратя второй цвет.
     */
    const frame = won ? PALETTE.chip : colour;

    entity(b, Shape.Box, cxs, y, hw, PLAQUE_HALF_H, 0, frame, alpha, 3);

    // Поштучный забор (доступность): выбранная крестовиной плашка обведена
    // вторым, более крупным контуром снаружи — иначе включённая настройка
    // работала бы вслепую, и «Забрать» цепляло бы непонятно что.
    if (i === highlightSlot) {
      const hi = PALETTE.hudText;
      b.push(
        Shape.Box,
        cxs,
        y,
        hw + 5,
        PLAQUE_HALF_H + 5,
        0,
        0,
        0,
        0,
        0,
        2,
        hi.r,
        hi.g,
        hi.b,
        alpha * 0.9,
      );
    }

    // Полоса прогресса по нижней кромке: та же `q`, по которой считается
    // выплата за «Забрать» (ECONOMY §9А). Она и есть шкала «сначала терпи,
    // потом решай» — без неё растущее число не с чем сравнить.
    const q = clamp01(nearMissOf(s, player, i) / FX_ONE);
    const barW = hw - 6;
    const barY = y + PLAQUE_HALF_H - 5;
    b.push(
      Shape.Box,
      cxs,
      barY,
      barW,
      2.5,
      0,
      colour.r,
      colour.g,
      colour.b,
      alpha * 0.2,
      0,
      0,
      0,
      0,
      0,
    );
    if (q > 0.01) {
      b.push(
        Shape.Box,
        cxs - barW + barW * q,
        barY,
        barW * q,
        2.5,
        0,
        colour.r,
        colour.g,
        colour.b,
        alpha * 0.9,
        0,
        0,
        0,
        0,
        0,
      );
    }

    if (compact) {
      // Сжатая: что взято и под какой коэффициент. Числа сделки уезжают в
      // подробную плашку — врать теснотой хуже, чем недоговорить.
      drawBetIcon(b, s.aBet[k], cxs, y - 9, 9, colour, ENTITY_FILL, alpha);
      drawMultiplier(b, spec.multiplier / FX_ONE, cxs - 14, y + 11, 6, PALETTE.hudText, alpha);
      continue;
    }

    // Верхняя строка: пари, его коэффициент и кон. Всё, что уже решено.
    // Цифры кремовые: поле плашки стало тёмным, и чернила на нём пропадают.
    drawBetIcon(b, s.aBet[k], cxs - 32, y - 11, 9, colour, ENTITY_FILL, alpha);
    drawMultiplier(b, spec.multiplier / FX_ONE, cxs - 17, y - 11, 7.5, PALETTE.hudText, alpha);
    drawNumber(b, s.aStake[k], cxs + 32, y - 11, 7, PALETTE.hudDim, alpha * 0.85);

    /*
     * На нижней строке живут два разных числа, и путать их нельзя.
     *
     * Пока пари цело — потенциальная выплата: сколько дадут, если забрать
     * прямо сейчас. Она растёт по мере выполнения и есть видимая шкала
     * риска, тот самый второй конец «дожать или соскочить»; кольцо слева от
     * неё — глиф «Забрать», и стоит он именно у этого числа.
     *
     * Когда сорвано — near-miss в процентах: насколько близко было. Именно
     * почти-выигрыш заставляет нажать «ещё разок» (GDD §9.3), и показать
     * его надо там, где игрок и так смотрит.
     */
    if (state === BetState.Active) {
      // Кольцо снова кремовое: плашка стала тёмной, и чернильный глиф на ней
      // пропадал бы ровно так же, как кремовый пропадал на кремовой. Место
      // при этом прежнее — вплотную к тому кушу, про который кнопка говорит.
      const c = PALETTE.hudText;
      b.push(Shape.Ring, cxs - 32, y + 11, 7, 7, 0, 0, 0, 0, 0, 3, c.r, c.g, c.b, alpha * 0.8);
    }
    const value = lost
      ? Math.round((nearMissOf(s, player, i) / FX_ONE) * 100)
      : state === BetState.Active
        ? cashOutValue(s, player, i)
        : Math.trunc((s.aStake[k] * spec.multiplier) / FX_ONE);
    // Куш золотом, сорванное — алым: число на тёмной плашке само называет
    // свою природу, а не берёт цвет у подложки, которой больше нет.
    drawNumber(b, value, cxs + 2, y + 11, 10, lost ? PALETTE.loss : PALETTE.chip, alpha);

    /*
     * Счётчиковое пари показывает счёт ЧИСЛАМИ: «сколько из трёх».
     *
     * Требование UX §4 — «прогресс пари виден численно там, где это
     * счётчик». Полоса прогресса у «Подрывника» и есть тот же счёт, но два
     * взрыва из трёх на глаз от одного не отличить, а решение «дожимать или
     * забрать» на этой разнице и стоит.
     */
    /*
     * У темпового пари на плашке — СЕКУНДЫ, а не одна полоса прогресса.
     *
     * «Быстрее 45 секунд» показывалось полосой в две с половиной единицы
     * высотой: на глаз «осталось десять секунд» от «осталось тридцать» не
     * отличается, а решение «дожимать или забрать» стоит ровно на этой
     * разнице. На расчёте near-miss честно даётся в секундах — в бою их не
     * было.
     */
    if (spec.progress === BetProgress.Time) {
      const dim = PALETTE.hudDim;
      const leftTicks = Math.max(0, spec.limitTicks - (s.tick - s.aTakenAt[k]));
      drawNumber(b, Math.ceil(leftTicks / TICK_HZ), cxs + 30, y + 11, 7, dim, alpha);
    }

    if (spec.progress === BetProgress.Counter) {
      const dim = PALETTE.hudDim;
      drawNumber(b, s.aCounter[k], cxs + 26, y + 11, 6, dim, alpha);
      b.push(
        Shape.Box,
        cxs + 33,
        y + 11,
        5,
        1.4,
        -Math.PI / 3,
        dim.r,
        dim.g,
        dim.b,
        alpha,
        0,
        0,
        0,
        0,
        0,
      );
      drawNumber(b, spec.target, cxs + 40, y + 11, 6, dim, alpha);
    }
  }
}

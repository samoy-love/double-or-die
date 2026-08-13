/**
 * Плашки, пиктограммы и подписи пари/дверей/апгрейдов.
 *
 * Знают игровые типы (`SimState`, `BetCategory`, `DoorType`…), но не сам
 * `Renderer` — вынесены как чистые функции без обращения к состоянию класса
 * (см. разведку переноса).
 */
import {
  BETS,
  DoorType,
  BetCategory,
  BetId,
  BetState,
  EnemyType,
  MAX_ACTIVE_BETS,
  MAX_CARDS,
  Meta,
  UPGRADES,
  sellCandidate,
  type SimState,
} from '@dod/sim';
import { Shape, ShapeBatch } from '../gl/batch';
import { t, type StringKey } from '../i18n';
import { PALETTE, type Rgb } from '../palette';

/**
 * Сколько строк покажет экран расчёта. Ноль — экрана нет.
 *
 * Одна функция на два места намеренно: по этому же признаку решается, рисовать
 * Крупье в общем слое или поверх затемнения. Две копии условия разъехались бы на
 * первой же правке, и он оказался бы либо нарисован дважды, либо не нарисован
 * вовсе — причём заметить это можно только глазами.
 */
export function settlementRows(s: SimState): number {
  if (s.meta[Meta.Wave] !== 0 || s.meta[Meta.NextWaveAt] === 0) return 0;
  // Первая комната приходит с пустыми слотами, и затемнять кадр ради пустоты —
  // только мешать.
  let rows = 0;
  for (let p = 0; p < s.playerCount; p++) {
    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      if (s.aState[p * MAX_ACTIVE_BETS + i] !== BetState.None) rows++;
    }
  }
  return rows;
}

/**
 * Есть ли среди строк расчёта хоть одно неразрешённое пари.
 *
 * Титул экрана называет ТО, что происходит, и состояний у экрана два: пари ещё
 * живы (пауза, итога нет) — или все разрешены (расчёт). Номер волны этого не
 * различает: экран рисуется только при нулевой волне.
 */
export function settlementHasActive(s: SimState): boolean {
  for (let p = 0; p < s.playerCount; p++) {
    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      if (s.aState[p * MAX_ACTIVE_BETS + i] === BetState.Active) return true;
    }
  }
  return false;
}

/**
 * Индекс пари «Не заходи в красную зону» в каталоге.
 *
 * По строковому идентификатору, а не числом: порядок в `content/bets.json`
 * меняется от правки каталога, и зашитый номер молча начал бы показывать
 * разметку от чужого пари. Ищется один раз на загрузку модуля.
 */
const RED_ZONE_BET = BETS.findIndex((spec) => String(spec.id) === 'no_red_zone');

/**
 * Сколько фишек у стола всего.
 *
 * Плата и цены в лавке считаются от общего кошелька: доля заведения общая, а
 * кошельки раздельные (GDD §14). Одна функция на оба экрана — иначе они
 * разошлись бы в первой же правке состава.
 */
export function walletOf(s: SimState): number {
  let total = 0;
  for (let i = 0; i < s.playerCount; i++) total += s.pChips[i];
  return total;
}

/**
 * Что заведение даёт за апгрейд в торге и КАКОЙ апгрейд уйдёт.
 *
 * Считает ядро (`sellCandidate`), а не экран. Своя копия правила здесь уже
 * была и уже врала: клиент брал самый дорогой апгрейд стола, а продаёт ядро
 * самый дешёвый из тех, которых хватает на недостачу. То есть экран называл
 * цену, которую игрок не получит, за товар, который не уйдёт, — из двух
 * половин сделки не совпадала ни одна.
 *
 * Игрок здесь локальный (индекс 0): решение принимает тот, чья рука на
 * кнопке, а продаётся апгрейд именно нажавшего (`stepHouseCut`).
 *
 * Ноль означает «продавать нечего», и карточка на экране гаснет.
 */
export function buybackOf(s: SimState, shortfall: number): { name: string; price: number } {
  const { upgrade, price } = sellCandidate(s, 0, shortfall);
  return { name: upgrade > 0 ? upgradeName(upgrade - 1) : '', price };
}

/** Есть ли красная зона в этой комнате: карта на полу или активное пари. */
export function redZoneInPlay(s: SimState): boolean {
  if (RED_ZONE_BET < 0) return false;
  for (let i = 0; i < MAX_CARDS; i++) {
    if (s.kActive[i] && s.kBet[i] === RED_ZONE_BET) return true;
  }
  for (let p = 0; p < s.playerCount; p++) {
    for (let n = 0; n < MAX_ACTIVE_BETS; n++) {
      const k = p * MAX_ACTIVE_BETS + n;
      if (s.aState[k] === BetState.Active && s.aBet[k] === RED_ZONE_BET) return true;
    }
  }
  return false;
}

/** Цвет категории пари: живёт во внутренней рамке, иконке и луче, но не в силуэте. */
export const categoryColour = (c: BetCategory): Rgb =>
  c === BetCategory.Style
    ? PALETTE.betStyle
    : c === BetCategory.Tempo
      ? PALETTE.betTempo
      : c === BetCategory.Space
        ? PALETTE.betSpace
        : c === BetCategory.Greed
          ? PALETTE.betGreed
          : c === BetCategory.Tricks
            ? PALETTE.betTricks
            : PALETTE.betSilly;

/**
 * Пиктограмма ПАРИ, а не категории (PRODUCTION §3, «Иконки пари — пиктограммы
 * из примитивов»).
 *
 * Категорий шесть и пари шесть, но один к одному они не ложатся: «Без урона» и
 * «Без рывка» обе относятся к Стилю, то есть с иконкой категории выглядели на
 * карте ОДИНАКОВО. Игрок физически не мог отличить «пройду без урона» от
 * «пройду без рывка» — два разных обязательства с разной ценой, — и владелец
 * сформулировал итог прямо: «не понятно, на что я беру ставку с этой картой».
 *
 * Смысл иконки должен угадываться, а не заучиваться (столп №5, читаемость за
 * 0.2 секунды): сердце, стрелка, часы, зона, монета, взрыв. Цвет категории при
 * этом остаётся вторым признаком — двойное кодирование формой И цветом
 * обязательно (GDD §21).
 *
 * `back` — цвет поля, на котором рисуют: им прорезается перечёркивание, иначе
 * запретительная черта тонет в самом глифе. С 0.4.0 это общая тёмная заливка
 * везде, где иконка живёт, — на карте, на плашке и в строке расчёта.
 *
 * Пари вне каталога 0.3.0 честно откатывается к форме категории: новое пари в
 * `content/bets.json` не должно оставлять карту без иконки вовсе.
 */
export function drawBetIcon(
  b: ShapeBatch,
  bet: number,
  x: number,
  y: number,
  s: number,
  c: Rgb,
  back: Rgb,
  a: number,
): void {
  const thin = Math.max(1.4, s * 0.11);

  switch (bet) {
    case BetId.NoDamage: {
      // Сердце: две дольки сверху и клин книзу. Перечёркнуто — урона не будет.
      for (const side of [-1, 1]) {
        b.push(
          Shape.Circle,
          x + side * s * 0.4,
          y - s * 0.3,
          s * 0.48,
          s * 0.48,
          0,
          c.r,
          c.g,
          c.b,
          a,
          0,
          0,
          0,
          0,
          0,
        );
      }
      // Вершиной вниз: поворот на +π/2, потому что ось Y экрана смотрит вниз.
      b.push(
        Shape.Triangle,
        x,
        y + s * 0.28,
        s * 0.7,
        s * 0.7,
        Math.PI / 2,
        c.r,
        c.g,
        c.b,
        a,
        0,
        0,
        0,
        0,
        0,
      );
      drawSlash(b, x, y, s, c, back, a);
      return;
    }

    case BetId.NoDash: {
      // Рывок: стрелка со следами скорости позади. Без следов она читается как
      // просто «направление», а запрещён здесь именно рывок.
      b.push(Shape.Capsule, x - s * 0.15, y, s * 0.62, thin, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
      b.push(
        Shape.Triangle,
        x + s * 0.68,
        y,
        s * 0.42,
        s * 0.42,
        0,
        c.r,
        c.g,
        c.b,
        a,
        0,
        0,
        0,
        0,
        0,
      );
      for (const side of [-1, 1]) {
        b.push(
          Shape.Capsule,
          x - s * 0.82,
          y + side * s * 0.44,
          s * 0.3,
          thin * 0.8,
          0,
          c.r,
          c.g,
          c.b,
          a,
          0,
          0,
          0,
          0,
          0,
        );
      }
      drawSlash(b, x, y, s, c, back, a);
      return;
    }

    case BetId.Under45s: {
      // Часы: циферблат и две стрелки. Единственная пустая внутри иконка —
      // отсюда и берётся отличие от зоны, которая залита.
      b.push(
        Shape.Ring,
        x,
        y,
        s * 0.92,
        s * 0.92,
        0,
        0,
        0,
        0,
        0,
        Math.max(2, s * 0.24),
        c.r,
        c.g,
        c.b,
        a,
      );
      b.push(Shape.Box, x, y - s * 0.28, thin, s * 0.4, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
      b.push(Shape.Box, x + s * 0.24, y, s * 0.34, thin, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
      return;
    }

    case BetId.NoRedZone: {
      // Зона: заливка вполсилы и ровный контур — тот же язык, которым красная
      // зона нарисована на полу (GDD §21). Перечёркнута: туда нельзя.
      b.push(
        Shape.Circle,
        x,
        y,
        s * 0.88,
        s * 0.88,
        0,
        c.r,
        c.g,
        c.b,
        a * 0.42,
        Math.max(2, s * 0.2),
        c.r,
        c.g,
        c.b,
        a,
      );
      drawSlash(b, x, y, s, c, back, a);
      return;
    }

    case BetId.AllChips: {
      // Монета и три стрелки, сходящиеся к ней: собрать ВСЁ, а не просто фишку.
      b.push(Shape.Circle, x, y, s * 0.42, s * 0.42, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
      const arrows: readonly [number, number, number][] = [
        [-s * 0.86, 0, 0],
        [s * 0.86, 0, Math.PI],
        [0, -s * 0.86, Math.PI / 2],
      ];
      for (const [dx, dy, angle] of arrows) {
        b.push(
          Shape.Triangle,
          x + dx,
          y + dy,
          s * 0.32,
          s * 0.32,
          angle,
          c.r,
          c.g,
          c.b,
          a,
          0,
          0,
          0,
          0,
          0,
        );
      }
      return;
    }

    case BetId.Demolitionist: {
      // Круг Фитиля с разлетающимися лучами. Лучи идут насквозь, а тело сверху
      // залито цветом подложки: без этого звёздочка читается как звёздочка, а
      // подрывать надо именно Фитилём.
      for (const angle of [0, Math.PI / 4, Math.PI / 2, -Math.PI / 4]) {
        b.push(Shape.Capsule, x, y, s * 0.98, thin * 0.9, angle, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
      }
      b.push(
        Shape.Circle,
        x,
        y,
        s * 0.4,
        s * 0.4,
        0,
        back.r,
        back.g,
        back.b,
        a,
        Math.max(2, s * 0.2),
        c.r,
        c.g,
        c.b,
        a,
      );
      return;
    }

    default:
      b.push(categoryShape(BETS[bet].category), x, y, s, s, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
  }
}

/**
 * Перечёркивание: две полосы, широкая цветом подложки и тонкая цветом поверх.
 *
 * Одной полосой не выходит: цветом категории она тонет в залитом глифе, цветом
 * подложки — исчезает за пределами глифа. Пара даёт линию, которая видна и на
 * сердце, и на кремовом поле рядом с ним.
 */
export function drawSlash(
  b: ShapeBatch,
  x: number,
  y: number,
  s: number,
  c: Rgb,
  back: Rgb,
  a: number,
): void {
  const angle = -Math.PI / 4;
  b.push(
    Shape.Capsule,
    x,
    y,
    s * 1.12,
    Math.max(2.4, s * 0.2),
    angle,
    back.r,
    back.g,
    back.b,
    a,
    0,
    0,
    0,
    0,
    0,
  );
  b.push(
    Shape.Capsule,
    x,
    y,
    s * 1.04,
    Math.max(1.2, s * 0.09),
    angle,
    c.r,
    c.g,
    c.b,
    a,
    0,
    0,
    0,
    0,
    0,
  );
}

/**
 * Имя пари из словаря по идентификатору каталога.
 *
 * `name` в `content/bets.json` служебный: он живёт в отчётах балансировщика и
 * в сценариях и не переводится. На экран идёт `bet.<id>.name` из словаря —
 * иначе английская сборка показывала бы русское условие.
 *
 * Приведение ключа безопасно и проверено не здесь: генератор контента валит
 * сборку, если у пари из каталога нет строки, а у строки — пари (`npm run
 * check:content`). Держать тот же список ещё и типом значило бы дублировать
 * данные ради приведения, которого всё равно не избежать.
 */
export const betName = (id: string): string => t(`bet.${id}.name` as StringKey);

/**
 * Имя апгрейда из словаря по идентификатору каталога.
 *
 * Ровно та же причина, что у `betName`: `name` в `content/upgrades.json`
 * служебный и не переводится, а на витрину идёт `upgrade.<id>.name`. Паритет
 * ключа и каталога держит генератор контента, а не это приведение.
 */
export const upgradeName = (index: number): string =>
  t(`upgrade.${String(UPGRADES[index].id)}.name` as StringKey);

/** Что апгрейд делает — той же парой «каталог + словарь», что и имя. */
export const upgradeDesc = (index: number): string =>
  t(`upgrade.${String(UPGRADES[index].id)}.desc` as StringKey);

/**
 * Имя типа двери из словаря.
 *
 * Таблицей, а не вычисляемым ключом: типов шесть, они перечислением, и
 * `door.type.${DoorType[i]}` потребовал бы держать в сборке объект
 * перечисления ради шести строк. Заодно опечатка в ключе ловится линтером
 * словаря, а не пустой надписью на экране.
 */
const DOOR_NAME: Readonly<Partial<Record<DoorType, StringKey>>> = {
  [DoorType.Fight]: 'door.type.fight',
  [DoorType.Fat]: 'door.type.fat',
  [DoorType.Shop]: 'door.type.shop',
  [DoorType.Gift]: 'door.type.gift',
  [DoorType.DebtPit]: 'door.type.pit',
};

/**
 * Имени у «События» нет намеренно.
 *
 * Ядро эту дверь не выкладывает вовсе (`doors.ts` её не выдаёт ни одним
 * путём), а имя-заглушка в словаре обещало содержание, которого не написано:
 * первый же взгляд на список дверей находил термин, за которым ничего нет.
 * Тип остаётся в перечислении — он в плане 0.7.0, — но словарь молчит, пока
 * молчит ядро. Строка вернётся вместе с содержанием, а не раньше.
 */
export const doorTypeName = (type: DoorType): string => {
  const key = DOOR_NAME[type];
  return key ? t(key) : '';
};

/**
 * Подсказка «что за дверью» — по той же таблице, что и имя.
 *
 * Раньше пояснение получала только Долговая яма — единственная дверь, с
 * которой начал новичок жаловался, что не понимает происходящего. Но
 * «Жирный бой», «Лавка» и «Дар» новому игроку говорят не больше пустого
 * имени: чем они отличаются от «Боя», по одному слову не угадать. `door.
 * type.event` не в списке: у него нет содержания (GDD §5), объяснять нечего.
 */
const DOOR_HINT: Readonly<Partial<Record<DoorType, StringKey>>> = {
  [DoorType.Fight]: 'door.type.fight.hint',
  [DoorType.Fat]: 'door.type.fat.hint',
  [DoorType.Shop]: 'door.type.shop.hint',
  [DoorType.Gift]: 'door.type.gift.hint',
  [DoorType.DebtPit]: 'door.type.pit.hint',
};

export const doorTypeHint = (type: DoorType): string | null => {
  const key = DOOR_HINT[type];
  return key ? t(key) : null;
};

/**
 * Что за дверью — пиктограммой на её лице.
 *
 * Дверь была тремя пустыми прямоугольниками, различимыми только подписью, и
 * это главный ритмический выбор забега: игрок делает его двадцать один раз за
 * забег и каждый раз читает мелкий текст вместо того, чтобы узнавать форму.
 *
 * Формы взяты из языка, который игрок уже выучил: враг — треугольник Клина,
 * деньги — круг фишки, подарок — коробка с лентой, долг — звенья цепи. Ничего
 * нового изобретать не пришлось, кроме цепи, которой в игре ещё не было.
 */
export function drawDoorIcon(
  b: ShapeBatch,
  type: DoorType,
  x: number,
  y: number,
  c: Rgb,
  a: number,
  /**
   * Масштаб интерфейса (UX §5). Пиктограмма растёт вместе с карточкой, в
   * которой лежит: рамка шла через `sx/sy/sz`, а значок — прямым `push`, и
   * при 150% он оставался прежним посреди выросшей двери.
   */
  k = 1,
): void {
  const wedge = (dx: number, size: number): void => {
    b.push(
      Shape.Triangle,
      x + dx * k,
      y,
      size * k,
      size * k,
      Math.PI / 2,
      0,
      0,
      0,
      0,
      4 * k,
      c.r,
      c.g,
      c.b,
      a,
    );
  };
  if (type === DoorType.Fight) {
    wedge(0, 42);
    return;
  }
  if (type === DoorType.Fat) {
    // Два клина: «врагов больше» — то же самое, чего дверь и обещает.
    wedge(-26, 34);
    wedge(26, 34);
    return;
  }
  if (type === DoorType.Shop) {
    // Монета: кольцо фишки с ядром — тот же язык, что у самой фишки.
    b.push(Shape.Ring, x, y, 40 * k, 40 * k, 0, 0, 0, 0, 0, 5 * k, c.r, c.g, c.b, a);
    b.push(Shape.Circle, x, y, 12 * k, 12 * k, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
    return;
  }
  if (type === DoorType.Gift) {
    // Коробка с лентой: квадрат и перекрестье.
    b.push(Shape.Box, x, y, 38 * k, 38 * k, 0, 0, 0, 0, 0, 5 * k, c.r, c.g, c.b, a);
    b.push(Shape.Box, x, y, 38 * k, 3 * k, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
    b.push(Shape.Box, x, y, 3 * k, 38 * k, 0, c.r, c.g, c.b, a, 0, 0, 0, 0, 0);
    return;
  }
  if (type === DoorType.DebtPit) {
    // Два звена цепи: долг — единственное, что тянет игрока назад.
    b.push(Shape.Ring, x - 20 * k, y, 22 * k, 22 * k, 0, 0, 0, 0, 0, 5 * k, c.r, c.g, c.b, a);
    b.push(Shape.Ring, x + 20 * k, y, 22 * k, 22 * k, 0, 0, 0, 0, 0, 5 * k, c.r, c.g, c.b, a);
    return;
  }
  // Событие: ромб — форма, не занятая ни врагом, ни валютой.
  b.push(Shape.Box, x, y, 30 * k, 30 * k, Math.PI / 4, 0, 0, 0, 0, 5 * k, c.r, c.g, c.b, a);
}

/** Форма иконки: категория обязана читаться и без цвета (GDD §21). */
export const categoryShape = (c: BetCategory): Shape =>
  c === BetCategory.Style
    ? Shape.Hexagon
    : c === BetCategory.Tempo
      ? Shape.Triangle
      : c === BetCategory.Space
        ? Shape.Box
        : c === BetCategory.Greed
          ? Shape.Circle
          : c === BetCategory.Tricks
            ? Shape.Capsule
            : Shape.Ring;

export const enemyColour = (type: EnemyType): Rgb =>
  type === EnemyType.Wedge
    ? PALETTE.enemyWedge
    : type === EnemyType.Brick
      ? PALETTE.enemyBrick
      : PALETTE.enemyFuse;

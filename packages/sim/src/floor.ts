/**
 * Конец этажа: доля заведения, торг и долг.
 *
 * Главный и почти единственный источник давления в соло. Ставки в этой игре
 * щедрые — у всех пари положительное матожидание, — и если бы давление жило
 * в них, механика превратилась бы в наказание: игрок пробует рисковать,
 * статистически проигрывает и перестаёт (ECONOMY §3). Поэтому давит счёт от
 * заведения, растущий быстрее дохода, а не казино.
 *
 * Отдельный модуль по той же причине, что и `run.ts`: конец этажа знают и
 * волны, и босс, и оба лежат ниже по графу импортов. Модуль, не тянущий ни
 * того, ни другого, могут звать оба.
 */

import { APPETITE, HOUSE, LEG_UP, MAX_ACTIVE_BETS } from './config';
import { Btn, type InputFrame } from './input';
import { Stream, nextInt } from './rng';
import { BetState, Curse, Meta, RunPhase, type SimState } from './state';

/**
 * Сколько заведение просит в конце этажа: `20 × (F+1)²`, с кооп-множителем.
 *
 * Формула, а не таблица из трёх чисел, и это не косметика: ECONOMY §15
 * объявляет кривую платы главным рычагом настройки, а рычага из констант не
 * бывает — крутить можно было только каждое число отдельно, теряя форму
 * кривой. Здесь у неё два параметра: высота и крутизна.
 */
export function houseCut(floor: number, players: number): number {
  const base = HOUSE.base * (floor + 1) ** HOUSE.power;
  const coop = 100 + HOUSE.coopGrowthPct * (players - 1);
  return Math.trunc((base * coop) / 100);
}

/** Сколько у стола денег всего: плата общая, кошельки раздельные (GDD §14). */
function purse(s: SimState): number {
  let total = 0;
  for (let i = 0; i < s.playerCount; i++) total += s.pChips[i];
  return total;
}

/**
 * Этаж кончился — заведение берёт своё.
 *
 * Вызывается после смерти босса и до перехода на следующий этаж: плата
 * относится к пройденному этажу, а не к будущему.
 */
export function enterHouseCut(s: SimState): void {
  s.meta[Meta.Phase] = RunPhase.HouseCut;
  s.meta[Meta.PhaseUntil] = 0;
  s.meta[Meta.HouseCut] = houseCut(s.meta[Meta.Floor], s.playerCount);
}

/** Хватает ли стола на плату. */
export const canPay = (s: SimState): boolean => purse(s) >= s.meta[Meta.HouseCut];

/**
 * Заплатить: списывается со всех кошельков поровну, сколько есть.
 *
 * Плата общая, а кошельки раздельные — «скидываются как договорятся»
 * (GDD §14). Договариваться в 0.4.0 некому, составов больше одного нет, но
 * правило записано так, чтобы кооп 0.5.0 не переписывал списание.
 */
export function payHouseCut(s: SimState): void {
  let left = s.meta[Meta.HouseCut];
  for (let i = 0; i < s.playerCount && left > 0; i++) {
    const take = Math.min(s.pChips[i], left);
    s.pChips[i] -= take;
    left -= take;
  }
  s.meta[Meta.PaidToAce] += s.meta[Meta.HouseCut] - left;
  s.meta[Meta.HouseCut] = 0;
}

/**
 * Уйти в долг: недостача остаётся висеть, а на комнату ложится проклятие.
 *
 * Долг **не стакается**: проклятие ровно одно одновременно, спираль неудач
 * запрещена дизайном (GDD §11). Экономический смысл долга — отнятый ТЕМП, а
 * не деньги: игрок теряет комнату слабым, но не выбывает.
 */
export function takeDebt(s: SimState): void {
  const shortfall = s.meta[Meta.HouseCut] - purse(s);
  // Всё, что есть, всё равно уходит: в долг записывается только недостача.
  payHouseCut(s);
  s.meta[Meta.Debt] = Math.max(0, shortfall);

  /*
   * Проклятие выбирается из потока `loot`.
   *
   * Не из `waves` и не из `bets`: оно не меняет ни состав волны, ни раскладку
   * карт, а правка любой из тех систем не должна двигать то, какое проклятие
   * выпадет (TECH §2.3).
   */
  s.meta[Meta.Curse] = Curse.Blood + nextInt(s.rng, Stream.Loot, Curse.Commission);
  /*
   * Проклятие живёт одну комнату, и считается это ВХОДАМИ, а не номерами.
   *
   * Номер комнаты сбрасывается на каждом этаже, а долг вешается ровно на
   * границе этажей — «следующая комната» оказывается первой комнатой
   * следующего этажа, то есть номером МЕНЬШИМ, чем у комнаты, где долг взяли.
   * Сравнение номеров на этом и сломалось: проклятие пережило свой срок и
   * повисло навсегда. Ноль здесь означает «комната проклятия ещё не начата».
   */
  s.meta[Meta.CurseRoom] = 0;
}

/**
 * Снять проклятие, если его комната прошла.
 *
 * Зовётся началом комнаты: «погашается прохождением следующей комнаты»
 * (GDD §11) означает, что действует оно ровно на одну.
 */
export function expireCurse(s: SimState): void {
  if (s.meta[Meta.Curse] === Curse.None) return;

  if (s.meta[Meta.CurseRoom] === 0) {
    // Первый вход после долга — это и есть проклятая комната.
    s.meta[Meta.CurseRoom] = 1;
    return;
  }

  // Второй вход означает, что проклятая комната пройдена.
  s.meta[Meta.Curse] = Curse.None;
  s.meta[Meta.CurseRoom] = 0;
  // Долг гасится вместе с проклятием: он и был проклятием на комнату.
  s.meta[Meta.Debt] = 0;
}

/**
 * Экран платы: заплатить или пойти в долг.
 *
 * Ждёт игрока, а не часов, по той же причине, что и дверь: экран, решающий
 * сам, превращает выбор в реакцию. Третий вариант торга — продать апгрейд —
 * приедет вместе с лавкой: продавать пока нечего.
 */
export function stepHouseCut(s: SimState, inputs: readonly InputFrame[]): boolean {
  if (s.meta[Meta.Phase] !== RunPhase.HouseCut) return false;

  for (let i = 0; i < s.playerCount; i++) {
    const pressed = inputs[i].buttons & ~s.pPrevButtons[i];
    s.pPrevButtons[i] = inputs[i].buttons;

    if ((pressed & Btn.Confirm) !== 0) {
      if (canPay(s)) payHouseCut(s);
      else takeDebt(s);
      return true;
    }
    /*
     * Отказ — это тоже долг, а не выход.
     *
     * Кнопка «отказаться» на экране платы означает «иди в долг»: уйти с
     * этажа, не рассчитавшись, нельзя, и делать вид, что можно, — значит
     * обещать выход, которого нет.
     */
    if ((pressed & Btn.Cancel) !== 0) {
      takeDebt(s);
      return true;
    }
  }
  return false;
}

/**
 * Провалено пари — следующий стол обязан содержать трамплин.
 *
 * Отметка ставится в момент расчёта, а не раздачи: между ними целый экран, и
 * намерение, не записанное в состояние, до раздачи не доживает.
 */
export function markLegUp(s: SimState): void {
  s.meta[Meta.LegUp] = 1;
}

/** Нужен ли трамплин в этой раздаче, и снять отметку. */
export function takeLegUp(s: SimState): boolean {
  if (s.meta[Meta.LegUp] === 0) return false;
  s.meta[Meta.LegUp] = 0;
  return true;
}

/**
 * Кон трамплина: всегда самый скромный тир, каким бы ни был аппетит.
 *
 * Трамплин — подставленное плечо, а не повод рискнуть ещё раз тому, кто
 * только что проиграл. Но это по-прежнему ПАРИ, и кон платит игрок:
 * бесплатная карта выглядела бы тем же жестом, а считалась бы подарком — и
 * шла бы ровно тому, кого доля заведения должна прижимать.
 */
export const legUpStake = (s: SimState, player: number): number =>
  Math.min(APPETITE[LEG_UP.tier], s.pChips[player]);

/** Провалил ли игрок хоть одно пари в этом расчёте. */
export function anyBetLost(s: SimState): boolean {
  for (let i = 0; i < s.playerCount * MAX_ACTIVE_BETS; i++) {
    if (s.aState[i] === BetState.Lost) return true;
  }
  return false;
}

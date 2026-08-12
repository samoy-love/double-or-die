/**
 * Выбор двери между комнатами.
 *
 * Единственное решение забега, которое принимается НЕ под обстрелом, и потому
 * единственное, которому позволено требовать чтения (UX §3). Всё остальное —
 * подбор карты, «Забрать», ответ на «Удвоим?» — читается мгновенно и жмётся
 * одной кнопкой.
 *
 * Сюда же переезжает выбор аппетита. До 0.4.0 его заменяла защёлка прямо в
 * бою: экрана двери не существовало, и «одно нажатие на всю комнату» держалось
 * тем, что ядро меняло тир только по явному нажатию (GDD §9.3). Правило
 * осталось тем же, а место у него теперь своё.
 */

import { APPETITE_DEFAULT, DOORS, ROOMS_PER_FLOOR } from './config';
import { Btn, appetiteOf, type InputFrame } from './input';
import { Stream, nextInt } from './rng';
import { freezeArena } from './run';
import { DoorType, MAX_DOORS, Meta, RunPhase, type SimState } from './state';

/**
 * Предложить двери.
 *
 * Поток `layout` — тот же, что раскладывает арены, и это не экономия на
 * потоках: дверь решает, КАКОЙ будет следующая комната, то есть принадлежит
 * раскладке забега, а не его наполнению. Отдельный поток здесь не нужен, а
 * взятый чужой (`waves`, `bets`) связал бы выбор двери с составом волны — и
 * правка одной системы двигала бы другую, ровно то, от чего разделение
 * потоков и защищает (TECH §2.3).
 */
export function offerDoors(s: SimState): void {
  // Комната кончена — гасим то, что от неё осталось лететь (см. freezeArena).
  freezeArena(s);
  s.meta[Meta.Phase] = RunPhase.Door;
  s.meta[Meta.PhaseUntil] = 0;
  s.meta[Meta.DoorPick] = -1;

  /*
   * Аппетит сбрасывается вместе с открытием экрана, а не с началом комнаты.
   *
   * «Новая комната — новое решение о размере кона» (GDD §9.3) осталось тем же
   * правилом, но момент у него теперь другой: решение принимается ЗДЕСЬ.
   * Сброс, оставленный на старте комнаты, стирал бы только что сделанный
   * выбор — игрок жал «По-крупному» и входил в бой со «Скромно».
   *
   * Умолчание — самый скромный тир: молчание игрока не имеет права стоить ему
   * пятидесяти фишек за карту.
   */
  s.pAppetite.fill(APPETITE_DEFAULT);

  const nextRoom = s.meta[Meta.Room] + 1;
  for (let i = 0; i < MAX_DOORS; i++) s.doorType[i] = pickType(s, i, nextRoom);

  /*
   * Долг съедает одну из трёх дверей, а не добавляет четвёртую.
   *
   * Выход из долга обязан стоить выбора: дверь, добавленная сверху, делала бы
   * долг бесплатным неудобством, а он должен забирать темп (ECONOMY §10).
   * Съедается последняя — первые две уже прошли проверку на повтор типа.
   */
  if (s.meta[Meta.Debt] > 0) s.doorType[MAX_DOORS - 1] = DoorType.DebtPit;
}

/**
 * Тип для одной двери с двумя правилами поверх весов.
 *
 * Первое: **два одинаковых типа в наборе не предлагаются**. Иначе выбор из
 * трёх регулярно оказывается выбором из двух, а иногда из одного, и экран
 * перестаёт быть решением.
 *
 * Второе: **Лавка гарантирована не позже пятой комнаты и ещё раз не позже
 * восьмой**. Без гарантии этаж, где Лавка не выпала, оставляет игрока с полным
 * кошельком перед долей заведения и без единого апгрейда — то есть наказывает
 * за чужой бросок кубика. Две лавки за этаж это и есть те три-четыре апгрейда
 * за забег, из которых посчитан профиль «умеренного» (ECONOMY §6).
 */
function pickType(s: SimState, slot: number, nextRoom: number): number {
  if (slot === 0 && shopOverdue(s, nextRoom)) return DoorType.Shop;

  for (let attempt = 0; attempt < DOORS.pickAttempts; attempt++) {
    const type = weighted(s);
    let taken = false;
    for (let i = 0; i < slot; i++) if (s.doorType[i] === type) taken = true;
    if (!taken) return type;
  }

  /*
   * Попытки кончились — берём первый свободный тип по порядку.
   *
   * Детерминированный запасной путь обязателен: цикл «крутить, пока не
   * выпадет неповторяющийся» на вырожденных весах не кончается никогда, а
   * ядру нельзя ни зависнуть, ни обратиться к RNG непредсказуемое число раз —
   * от числа обращений зависит весь дальнейший забег.
   */
  for (let type = DoorType.Fight; type <= DoorType.Gift; type++) {
    let taken = false;
    for (let i = 0; i < slot; i++) if (s.doorType[i] === type) taken = true;
    if (!taken) return type;
  }
  return DoorType.Fight;
}

/**
 * Пора ли выдать Лавку принудительно.
 *
 * Считается по последней комнате, где она была: два окна на этаж — до пятой и
 * до восьмой. Комната, в которой Лавку уже дали, запоминается прямо в типе
 * комнаты, поэтому отдельного слота состояния не потребовалось.
 */
function shopOverdue(s: SimState, nextRoom: number): boolean {
  const since = nextRoom - s.meta[Meta.LastShopRoom];
  if (nextRoom >= DOORS.shopBy && s.meta[Meta.LastShopRoom] === 0) return true;
  return nextRoom >= ROOMS_PER_FLOOR && since >= DOORS.shopBy;
}

/** Тип по весам. Событие весит ноль и не выпадает — содержания у него нет. */
function weighted(s: SimState): number {
  let total = 0;
  for (const w of DOORS.weights) total += w;
  let roll = nextInt(s.rng, Stream.Layout, total);
  for (let type = 0; type < DOORS.weights.length; type++) {
    roll -= DOORS.weights[type];
    if (roll < 0) return type;
  }
  return DoorType.Fight;
}

/**
 * Экран двери ждёт игрока, а не часов.
 *
 * Пяти секунд из GDD §5 здесь нет намеренно: это оценка длительности для
 * бюджета времени, а не таймер. Дверь, закрывающаяся сама, превращает выбор в
 * реакцию — и первый же отвлёкшийся игрок обнаруживает, что за него решили.
 */
export function stepDoors(s: SimState, inputs: readonly InputFrame[]): boolean {
  if (s.meta[Meta.Phase] !== RunPhase.Door) return false;

  let confirmed = false;
  for (let i = 0; i < s.playerCount; i++) {
    const pressed = inputs[i].buttons & ~s.pPrevButtons[i];
    s.pPrevButtons[i] = inputs[i].buttons;

    if ((pressed & Btn.NavLeft) !== 0) moveFocus(s, -1);
    if ((pressed & Btn.NavRight) !== 0) moveFocus(s, 1);

    /*
     * Аппетит выбирается здесь же, тем же нажатием крестовины, что и в бою.
     *
     * Тир едет битами кадра со сдвигом на единицу (`appetiteOf`), поэтому
     * молчание игрока отличается от выбора «Скромно», и защёлка работает
     * так же, как работала в бою: выбор держится до следующего явного
     * нажатия. Правило «одно нажатие на всю комнату» не изменилось —
     * изменилось только место, где нажимают (GDD §9.3).
     */
    const tier = appetiteOf(inputs[i]);
    if (tier >= 0) s.pAppetite[i] = tier;

    /*
     * Подтверждает ЛЮБОЙ игрок, и это то же правило, что у «Удвоим?»: Крупье
     * обращается к столу, и первый согласившийся решает за всех (GDD §14).
     * Ждать всех четверых на экране двери значило бы ждать самого медленного
     * двадцать один раз за забег.
     */
    if ((pressed & Btn.Confirm) !== 0 && s.meta[Meta.DoorPick] >= 0) confirmed = true;
  }
  return confirmed;
}

/** Перевести фокус, упираясь в края. Перенос по кругу здесь врёт о числе дверей. */
function moveFocus(s: SimState, delta: number): void {
  const cur = s.meta[Meta.DoorPick];
  const next = cur < 0 ? (delta > 0 ? 0 : MAX_DOORS - 1) : cur + delta;
  if (next < 0 || next >= MAX_DOORS) return;
  s.meta[Meta.DoorPick] = next;
}

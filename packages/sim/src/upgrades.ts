/**
 * Лавка, Дар и апгрейды: что продаётся, почём и что от этого меняется в бою.
 *
 * Дверь «Лавка» обещает **бой, а после него магазин** (GDD §5), поэтому лавка
 * — это фаза `Reward`, а не отдельный экран между комнатами: игрок платит за
 * силу тем же кошельком, которым платит долю заведения, и решение «апгрейд
 * или плата» и есть смысл двери (ECONOMY §3).
 *
 * Правил торговли ровно три, и каждое куплено разбором вырожденного случая:
 *
 *   — **три предложения из шести.** Шесть из шести — это прайс-лист: игрок с
 *     деньгами покупал бы всё нужное сразу и переставал бы выбирать между
 *     апгрейдом и долей заведения (ECONOMY §5).
 *   — **без повторов уже купленного.** Второй экземпляр складывался бы в
 *     разгон, которого в экономике нет, а слот занимал бы честно.
 *   — **кошелёк не уходит в минус.** Крупье в кредит не принимает (ECONOMY §10),
 *     и лавка здесь не исключение: не хватило — не продано.
 *
 * Дверь «Дар» обещает то же самое бесплатно (GDD §5) и потому живёт здесь же,
 * тем же прилавком и той же фазой: отличие ровно одно — цена не берётся. Всё
 * остальное — три предложения, отказ от повторов, потолок слотов — Дару нужно
 * ровно так же, как лавке, и разведённое по двум экранам разъехалось бы на
 * первой же правке.
 *
 * Сами товары, их цены и величины эффектов сюда не вписаны: они данные
 * (`content/upgrades.json`), и правит их балансировщик.
 */

import { CHIP, HOUSE, PISTOL, PLAYER, UPGRADE } from './config';
import { type Fx, fromInt } from './fixed';
import { Btn, type InputFrame } from './input';
import { Stream, nextInt } from './rng';
import { freezeArena } from './run';
import { DoorType, MAX_UPGRADE_SLOTS, Meta, RunPhase, SHOP_SLOTS, type SimState } from './state';
import { UPGRADES, UPGRADE_COUNT, UpgradeEffect, type UpgradeSpec } from './upgrades.generated';

export {
  UPGRADES,
  UPGRADE_COUNT,
  UpgradeEffect,
  UpgradeId,
  type UpgradeSpec,
} from './upgrades.generated';

export const upgradeAt = (index: number): UpgradeSpec => UPGRADES[index];

/**
 * Цена на этаже `F`: `база × 1.5^(F−1)`, усечённая вниз.
 *
 * Считается целыми: полтора живут парой чисел в конфиге, а не дробью, потому
 * что дробное умножение в ядре расходится между движками. Усечение вниз — то
 * же самое, что стоит в таблице расходов ECONOMY §5 (45 → 67 → 101).
 *
 * `winStreak` — необязательная скидка «На кураже» (`UPGRADE.
 * winStreakDiscountPctPerStreak/Cap`), применяется ТОЛЬКО ценой прилавка
 * (вызывающий её опускает у `buybackOf`): выкуп заведением считается от
 * полной цены, скидка на покупку не должна тайком удешевлять и продажу.
 */
export function priceOf(base: number, floor: number, winStreak = 0): number {
  let num = base;
  let den = 1;
  for (let f = 1; f < floor; f++) {
    num *= UPGRADE.priceGrowthNum;
    den *= UPGRADE.priceGrowthDen;
  }
  const full = Math.trunc(num / den);
  const streak = Math.min(winStreak, UPGRADE.winStreakDiscountCap);
  if (streak <= 0) return full;
  const discountPct = streak * UPGRADE.winStreakDiscountPctPerStreak;
  return full - Math.trunc((full * discountPct) / 100);
}

/**
 * Сколько заведение даёт за апгрейд: половина цены ТЕКУЩЕГО этажа (ECONOMY §10).
 *
 * Цена берётся от того этажа, на котором торгуются, а не от того, где купили:
 * так правило проще (не надо помнить, где что куплено) и щедрее там, где игрок
 * и беднеет. Обратное — считать по этажу покупки — превращало бы ранние
 * покупки в ловушку.
 */
export const buybackPriceOf = (base: number, floor: number): number =>
  Math.trunc((priceOf(base, floor) * HOUSE.buybackPct) / 100);

// ---------------------------------------------------------------------------
// Купленное
// ---------------------------------------------------------------------------

const slot = (player: number, n: number): number => player * MAX_UPGRADE_SLOTS + n;

/** Есть ли у игрока названный апгрейд. Слоты хранят индекс со сдвигом на единицу. */
export function hasUpgrade(s: SimState, player: number, upgrade: number): boolean {
  for (let i = 0; i < MAX_UPGRADE_SLOTS; i++) {
    if (s.pUpgrades[slot(player, i)] === upgrade + 1) return true;
  }
  return false;
}

/** Сколько апгрейдов у игрока. Потолок — двенадцать слотов (GDD §12). */
export function upgradeCount(s: SimState, player: number): number {
  let n = 0;
  for (let i = 0; i < MAX_UPGRADE_SLOTS; i++) {
    if (s.pUpgrades[slot(player, i)] !== 0) n++;
  }
  return n;
}

/**
 * Выдать апгрейд, не беря денег. Публично: этим пользуются сценарии и Дар.
 *
 * Возвращает false, если апгрейд уже есть или слоты кончились. Сердце
 * начисляется ЗДЕСЬ, а не при следующем спавне: «единственная покупка,
 * работающая после ошибки» (ECONOMY §5) обязана работать в той же комнате, в
 * которой куплена, иначе она работает до ошибки, как и все остальные.
 */
export function grantUpgrade(s: SimState, player: number, upgrade: number): boolean {
  if (upgrade < 0 || upgrade >= UPGRADE_COUNT) return false;
  if (hasUpgrade(s, player, upgrade)) return false;

  for (let i = 0; i < MAX_UPGRADE_SLOTS; i++) {
    if (s.pUpgrades[slot(player, i)] !== 0) continue;
    s.pUpgrades[slot(player, i)] = upgrade + 1;
    const spec = UPGRADES[upgrade];
    if (spec.effect === UpgradeEffect.Heart) {
      const want = s.pHearts[player] + spec.value;
      s.pHearts[player] = want > UPGRADE.maxHearts ? UPGRADE.maxHearts : want;
    }
    return true;
  }
  return false;
}

/**
 * Отдать апгрейд заведению: слот пустеет, эффект уходит вместе с ним.
 *
 * Сердце снимается ЗДЕСЬ по той же причине, по какой начисляется в
 * `grantUpgrade`: оставленное, оно превратило бы торг в станок — купить сердце,
 * продать его обратно и оставить себе здоровье стоило бы половины ценника и
 * повторялось бы каждый этаж.
 *
 * Последнее сердце не забирается: экран платы не боевой, и смерть от нажатия
 * кнопки на нём была бы смертью в интерфейсе, а не в игре. Ноль здесь означал
 * бы ещё и живого игрока без здоровья — состояние, которое ловит инвариант.
 */
function revokeSlot(s: SimState, player: number, n: number): void {
  const held = s.pUpgrades[slot(player, n)];
  if (held === 0) return;
  s.pUpgrades[slot(player, n)] = 0;

  const spec = UPGRADES[held - 1];
  if (spec.effect === UpgradeEffect.Heart) {
    const left = s.pHearts[player] - spec.value;
    s.pHearts[player] = left < 1 ? 1 : left;
  }
}

/**
 * Что дороже отдать: тот, кто ближе закрывает недостачу.
 *
 * Выбирать игроку нечем — на экране платы нет ни списка, ни фокуса (см.
 * `stepHouseCut`), — поэтому выбирает правило, и оно обязано выбирать то же,
 * что выбрал бы игрок: самый дешёвый из тех, кого хватает, а если не хватает
 * никого — самый дорогой, чтобы недостача сократилась сильнее всего.
 */
function preferable(candidate: number, current: number, shortfall: number): boolean {
  const candidateEnough = candidate >= shortfall;
  const currentEnough = current >= shortfall;
  if (candidateEnough !== currentEnough) return candidateEnough;
  return candidateEnough ? candidate < current : candidate > current;
}

/**
 * Продать апгрейд заведению. Возвращает выручку; ноль — продавать нечего.
 *
 * Третий выход торга (ECONOMY §10). Ноль — не ошибка вызывающего, а законный
 * ответ: у игрока может не быть ни одного апгрейда, и торг обязан это пережить.
 */
export function sellUpgrade(s: SimState, player: number, shortfall: number): number {
  const { slot: pick, price } = sellCandidate(s, player, shortfall);
  if (pick < 0) return 0;
  revokeSlot(s, player, pick);
  s.pChips[player] += price;
  return price;
}

/**
 * КАКОЙ апгрейд уйдёт с молотка и за сколько — без самой продажи.
 *
 * Выделено из `sellUpgrade` ради экрана торга: он писал «Продать апгрейд» и
 * цену, не называя товар, и игрок расставался с неизвестной покупкой. Правило
 * выбора обязано быть одно на обоих: экран, считающий по своей копии правила,
 * рано или поздно назовёт не тот апгрейд, который потом продастся, — и это
 * хуже, чем не называть вовсе.
 *
 * `slot < 0` означает «продавать нечего» — законный ответ, а не ошибка.
 */
export function sellCandidate(
  s: SimState,
  player: number,
  shortfall: number,
): { slot: number; upgrade: number; price: number } {
  const floor = s.meta[Meta.Floor];
  let pick = -1;
  let upgrade = 0;
  let price = 0;

  for (let i = 0; i < MAX_UPGRADE_SLOTS; i++) {
    const held = s.pUpgrades[slot(player, i)];
    if (held === 0) continue;
    const offer = buybackPriceOf(UPGRADES[held - 1].base, floor);
    // Равные ценники разрешаются младшим слотом: две базы по 40 в каталоге
    // есть, и без этого порядок зависел бы от порядка покупок.
    if (pick < 0 || preferable(offer, price, shortfall)) {
      pick = i;
      upgrade = held;
      price = offer;
    }
  }

  return { slot: pick, upgrade, price };
}

/**
 * Величина эффекта у игрока, ноль — эффекта нет.
 *
 * Поиск идёт по ЭФФЕКТУ, а не по номеру апгрейда: код боя не должен знать, в
 * какой строке каталога лежит магнит. Каталог гарантирует, что эффект в нём
 * ровно один (`content/upgrades.schema.md`), поэтому первый найденный и есть
 * ответ.
 */
function valueOf(s: SimState, player: number, effect: UpgradeEffect): number {
  for (let i = 0; i < MAX_UPGRADE_SLOTS; i++) {
    const u = s.pUpgrades[slot(player, i)];
    if (u === 0) continue;
    const spec = UPGRADES[u - 1];
    if (spec.effect === effect) return spec.value;
  }
  return 0;
}

/** Лучшая величина эффекта за столом — для того, что принадлежит не игроку, а миру. */
function valueOfTable(s: SimState, effect: UpgradeEffect): number {
  let best = 0;
  for (let p = 0; p < s.playerCount; p++) {
    const v = valueOf(s, p, effect);
    if (v > best) best = v;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Эффекты в бою
// ---------------------------------------------------------------------------

/**
 * Урон пули игрока.
 *
 * Целый: здоровье врагов считается целыми очками, и дробить их нечем. Поэтому
 * проценты каталога подобраны так, чтобы делиться нацело — +20% от десяти дают
 * ровно двенадцать, и усекать нечего (ECONOMY §5). Усечение здесь оставлено
 * страховкой на случай нового товара, а не рабочим режимом: цену усечения
 * стережёт тест, а не внимательность правящего каталог.
 */
export function damageOf(s: SimState, player: number): number {
  if (player < 0) return PISTOL.damage;
  const pct = valueOf(s, player, UpgradeEffect.Damage);
  return pct === 0 ? PISTOL.damage : Math.trunc((PISTOL.damage * pct) / 100);
}

/** Откат рывка в тиках: главный инструмент выживания дешевеет на треть. */
export function dashCooldownOf(s: SimState, player: number): number {
  const pct = valueOf(s, player, UpgradeEffect.DashCooldown);
  return pct === 0 ? PLAYER.dashCooldownTicks : Math.trunc((PLAYER.dashCooldownTicks * pct) / 100);
}

/**
 * Радиус подбора фишек.
 *
 * Магнит задаёт радиус целиком, а не прибавку к нему: «Магнит 250 u» — это
 * ответ, а не поправка, и записанный прибавкой он менялся бы вместе с базовым
 * радиусом, который трогают ради ощущения подбора, а не ради экономики.
 */
export function pickupRadiusOf(s: SimState, player: number): Fx {
  const units = valueOf(s, player, UpgradeEffect.Magnet);
  return units === 0 ? CHIP.pickupRadius : fromInt(units);
}

/** Скорость бега. Разгон и трение не трогаются: меняется потолок, а не ощущение. */
export function moveSpeedOf(s: SimState, player: number): Fx {
  const pct = valueOf(s, player, UpgradeEffect.Speed);
  return pct === 0 ? PLAYER.speed : Math.trunc((PLAYER.speed * pct) / 100);
}

/**
 * Шанс выпадения фишки, в процентах.
 *
 * Считается по СТОЛУ, а не по игроку, и это не упрощение: фишка падает из
 * врага, а не из игрока, и спросить её, чьим выстрелом убит враг, в момент
 * дропа уже нельзя — цепная детонация Фитилей убивает вовсе без выстрела.
 * Берётся лучший за столом: в коопе апгрейд одного не имеет права ухудшать
 * дроп остальным.
 *
 * Целый по той же причине, что и урон: бросок идёт по сотне, и дробной доли
 * процента в ней нет. Дробить сотню нельзя — это сдвинуло бы каждый бросок
 * потока `loot` во всех уже записанных реплеях, поэтому целым подобран сам
 * процент каталога: 25 × 148% = ровно 37.
 */
export function dropChancePctOf(s: SimState): number {
  const pct = valueOfTable(s, UpgradeEffect.Drop);
  return pct === 0 ? CHIP.dropChancePct : Math.trunc((CHIP.dropChancePct * pct) / 100);
}

// ---------------------------------------------------------------------------
// Прилавок: лавка и Дар
// ---------------------------------------------------------------------------

/**
 * Что ещё имеет смысл выкладывать на прилавок.
 *
 * Буфер на модуле, а не массив на вызов: ядру запрещено аллоцировать, и хотя
 * лавка открывается раз в комнату, исключений из запрета не бывает — они и
 * превращаются в правило.
 */
const pool = new Int32Array(UPGRADE_COUNT);

/**
 * Куплен ли апгрейд ВСЕМИ за столом.
 *
 * Не «хоть кем-то»: прилавок один на всех, а слоты у каждого свои, и товар,
 * убранный из-за чужой покупки, оставил бы напарника без апгрейда, которого у
 * него нет. Пока он нужен хоть кому-то, он лежит; купить второй раз не даст
 * `canBuy`.
 */
function ownedByAll(s: SimState, upgrade: number): boolean {
  for (let p = 0; p < s.playerCount; p++) {
    if (!hasUpgrade(s, p, upgrade)) return false;
  }
  return true;
}

/**
 * Разложить прилавок: три предложения из шести, с ценниками или без.
 *
 * Ассортимент берётся из потока `shop` и ниоткуда больше (TECH §2.3): правка
 * волн, раскладки карт или дропа не имеет права двигать то, что лежит на
 * прилавке, — иначе один и тот же сид перестаёт давать один и тот же забег.
 *
 * Выбор без возврата: вытянутый товар заменяется последним из оставшихся, и
 * два одинаковых ценника на одном прилавке невозможны.
 */
function layOut(s: SimState, priced: boolean): void {
  // Комната кончена — гасим летящее (см. freezeArena в run.ts).
  freezeArena(s);
  s.meta[Meta.Phase] = RunPhase.Reward;
  s.meta[Meta.PhaseUntil] = 0;
  s.shopItem.fill(0);
  s.shopPrice.fill(0);
  // Фокус — тот же слот состояния, что у двери: экран лавки такой же выбор из
  // трёх, а второй счётчик того же самого стоил бы слота в хеше.
  s.meta[Meta.DoorPick] = -1;

  let free = 0;
  for (let u = 0; u < UPGRADE_COUNT; u++) {
    if (!ownedByAll(s, u)) pool[free++] = u;
  }

  const floor = s.meta[Meta.Floor];
  for (let i = 0; i < SHOP_SLOTS && free > 0; i++) {
    const pick = nextInt(s.rng, Stream.Shop, free);
    const upgrade = pool[pick];
    pool[pick] = pool[--free];
    s.shopItem[i] = upgrade + 1;
    if (priced) {
      s.shopPrice[i] = priceOf(UPGRADES[upgrade].base, floor, s.meta[Meta.WinStreak]);
    }
  }
}

/** Открыть лавку: три товара из шести по ценам текущего этажа. */
export function openShop(s: SimState): void {
  layOut(s, true);
}

/**
 * Открыть Дар: те же три предложения, но даром. Возвращает false, если экрана
 * не будет.
 *
 * **Ценника нет вовсе, а не «ноль фишек».** Показывать цену там, где её не
 * берут, значит показывать столбец, который между тремя предложениями не
 * различает ничего, — а игрок читает его первым, потому что на соседнем экране
 * читает именно его. Пустой `shopPrice` при занятом `shopItem` и есть тот
 * признак, по которому экран рисует «бесплатно»: отдельный флаг стоил бы слота
 * в хеше ради того, что и так видно.
 *
 * **Давать нечего — экран не открывается.** Все шесть апгрейдов у стола —
 * случай редкий, но не невозможный (две лавки на этаж плюс Дары), и прилавок,
 * открытый пустым, обещал бы выбор из трёх и не дал бы ни одного. Комната
 * тогда остаётся обычным боем, и забег идёт к следующей двери.
 */
export function openGift(s: SimState): boolean {
  let any = false;
  for (let u = 0; u < UPGRADE_COUNT && !any; u++) any = !ownedByAll(s, u);
  if (!any) return false;

  /*
   * Тип комнаты — единственное, чем Дар отличается от лавки в состоянии.
   *
   * Своего слота у экрана нет и не будет: свободных в `Meta` не осталось, а
   * расширение раскладки валит все двадцать эталонов. Проставляется он здесь,
   * рядом с открытием, а не только в конце боя, чтобы признак и его смысл
   * нельзя было развести по разным файлам.
   */
  s.meta[Meta.RoomType] = DoorType.Gift;
  layOut(s, false);
  return true;
}

/** Открыт ли Дар, а не лавка: за Дар не платят и берут с него ровно одно. */
export const giftOpen = (s: SimState): boolean =>
  s.meta[Meta.Phase] === RunPhase.Reward && s.meta[Meta.RoomType] === DoorType.Gift;

/**
 * Убрать прилавок.
 *
 * Фокус гасится вместе с ним, и это не уборка на всякий случай: тот же слот
 * читает начало комнаты, решая, какую дверь выбрали. Фокус, оставшийся от
 * лавки, назначил бы следующей комнате тип двери, которую никто не выбирал.
 */
export function closeReward(s: SimState): void {
  s.shopItem.fill(0);
  s.shopPrice.fill(0);
  s.meta[Meta.DoorPick] = -1;
}

/**
 * Можно ли взять то, что лежит в слоте: товар, деньги, слот и без повтора.
 *
 * Дар проверяется тем же кодом, и это не экономия на строчках: проверка на
 * кошелёк при нулевом ценнике проходит сама, а вот отказ от второго экземпляра
 * и потолок двенадцати слотов нужны подарку ровно так же, как покупке.
 */
export function canBuy(s: SimState, player: number, index: number): boolean {
  if (index < 0 || index >= SHOP_SLOTS) return false;
  const item = s.shopItem[index];
  if (item === 0) return false;
  if (s.shopPrice[index] > s.pChips[player]) return false;
  if (hasUpgrade(s, player, item - 1)) return false;
  return upgradeCount(s, player) < MAX_UPGRADE_SLOTS;
}

/**
 * Купить. Возвращает false, если купить было нельзя — и тогда не меняет ничего.
 *
 * Проверка и списание живут в одной паре функций намеренно: разъехавшись, они
 * дают либо кошелёк в минус, либо снятые деньги без товара, и оба случая
 * видны только в деньгах, то есть не видны вовсе.
 */
export function buyUpgrade(s: SimState, player: number, index: number): boolean {
  if (!canBuy(s, player, index)) return false;
  const upgrade = s.shopItem[index] - 1;
  if (!grantUpgrade(s, player, upgrade)) return false;

  s.pChips[player] -= s.shopPrice[index];
  // Товар с прилавка уходит: второго экземпляра у лавки нет, а пустой слот
  // честно показывает, что здесь уже купили.
  s.shopItem[index] = 0;
  s.shopPrice[index] = 0;
  return true;
}

/**
 * Экран награды: фокус крестовиной, взятие подтверждением, выход отказом.
 *
 * Ждёт игрока, а не часов, по той же причине, что дверь и экран платы: экран,
 * закрывающийся сам, превращает выбор в реакцию. Возвращает true в тот тик,
 * когда с него уходят.
 *
 * ДАР ЗАКРЫВАЕТСЯ ВЗЯТЫМ АПГРЕЙДОМ, лавка — нет. Дверь обещала «бесплатный
 * апгрейд на выбор из 3» (GDD §5), то есть один из трёх, а не три из трёх:
 * прилавок с нулевыми ценниками, из которого можно не уходить, выдал бы
 * половину каталога разом — и Лавка перестала бы быть стоком фишек, ради
 * которого она стоит на пути к доле заведения (ECONOMY §5). В лавке той же
 * роли играет цена, и уходить оттуда после первой покупки не за что.
 *
 * Дар при этом один на стол, а не на игрока: экран закрывает первый взявший —
 * то же правило, что у двери и у «Удвоим?», где Крупье обращается к столу, а
 * решает первый согласившийся (GDD §14).
 */
export function stepReward(s: SimState, inputs: readonly InputFrame[]): boolean {
  if (s.meta[Meta.Phase] !== RunPhase.Reward) return false;
  const gift = giftOpen(s);

  for (let i = 0; i < s.playerCount; i++) {
    const pressed = inputs[i].buttons & ~s.pPrevButtons[i];
    s.pPrevButtons[i] = inputs[i].buttons;

    if ((pressed & Btn.NavLeft) !== 0) moveFocus(s, -1);
    if ((pressed & Btn.NavRight) !== 0) moveFocus(s, 1);
    if ((pressed & Btn.Confirm) !== 0 && buyUpgrade(s, i, s.meta[Meta.DoorPick]) && gift) {
      return true;
    }
    /*
     * Отказ — это выход, и он законный.
     *
     * Не купить — нормальное решение: фишки конвертируются в ключи в конце
     * забега (ECONOMY §12), и «унести» конкурирует с «потратить» на равных.
     * Экран, из которого нельзя уйти без покупки, отнял бы ровно это решение.
     *
     * С Дара уходить не за чем, но выход обязан быть и там: слоты когда-нибудь
     * упрутся в потолок двенадцати, и экран, требующий взять то, что взять
     * нельзя, встал бы намертво.
     */
    if ((pressed & Btn.Cancel) !== 0) return true;
  }
  return false;
}

/** Перевести фокус, упираясь в края: перенос по кругу врёт о числе товаров. */
function moveFocus(s: SimState, delta: number): void {
  const cur = s.meta[Meta.DoorPick];
  // Первое нажатие ставит фокус на элемент СО СТОРОНЫ ЖЕСТА, а не на
  // противоположный: «влево» из пустого фокуса прыгало на крайний правый, и
  // это читалось не правилом, а промахом ввода. Упор в край не изменился.
  const next = cur < 0 ? (delta > 0 ? SHOP_SLOTS - 1 : 0) : cur + delta;
  if (next < 0 || next >= SHOP_SLOTS) return;
  s.meta[Meta.DoorPick] = next;
}

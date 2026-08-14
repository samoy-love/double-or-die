/**
 * Инварианты состояния — самый дешёвый уровень тестирования.
 *
 * Включены в dev-сборке и проверяются каждый тик. Ловят целый класс багов в
 * момент возникновения, а не через десять минут игры, когда причина уже
 * потеряна. В продакшене вырезаются целиком.
 *
 * Правила честности из DIFFICULTY §7 проверяются здесь же, а не только
 * сценариями: непроходимая комбинация врагов обязана становиться падающим
 * тестом, а не жалобой в отзывах.
 */

import { ACE } from './bets';
import { BET_COUNT, InputScheme } from './bets.generated';
import { UPGRADE_COUNT } from './upgrades.generated';
import {
  ACE_BET,
  APPETITE,
  BOSS,
  FLOORS_PER_RUN,
  MAX_ACTIVE_BETS,
  ROOMS_PER_FLOOR,
} from './config';
import { onScreenCap } from './enemies';
import {
  AceGesture,
  ARENA_H,
  BetState,
  ARENA_W,
  Curse,
  DoorType,
  EntityFlag,
  MAX_BALLS,
  MAX_CARDS,
  MAX_CHIPS,
  MAX_DOORS,
  MAX_ENEMIES,
  MAX_BULLETS,
  MAX_UPGRADE_SLOTS,
  Meta,
  RunPhase,
  SECTOR_COUNT,
  SHOP_SLOTS,
  type SimState,
} from './state';

export class InvariantError extends Error {
  constructor(
    message: string,
    readonly tick: number,
  ) {
    super(`[tick ${tick}] ${message}`);
    this.name = 'InvariantError';
  }
}

/**
 * Вынесено из checkInvariants намеренно: замыкание внутри функции создаётся
 * при каждом вызове, а проверка идёт по тику. Ядру аллоцировать в горячем
 * пути запрещено, и запрет проверяется тестом.
 */
function fail(m: string, tick: number): never {
  throw new InvariantError(m, tick);
}

/*
 * Потолка телеграфов здесь нет намеренно.
 *
 * Правило «не больше трёх объявленных атак на игрока» — это ограничение на
 * МОМЕНТ ОБЪЯВЛЕНИЯ, и держится оно в enemies.ts. Инвариантом по состоянию
 * его не выразить: коридор тарана задан при объявлении и дальше не меняется, а
 * игрок волен вбежать в него сам — и тогда «четвёртая угроза на игроке»
 * означает его собственное решение, а не дефект симуляции. Проверка,
 * падающая от действий игрока, перестаёт быть инвариантом и начинает быть
 * шумом.
 *
 * Само правило проверяется тестом на объявление (tests/enemies.test.ts), а его
 * следствие — тем, что безопасная точка достижима всегда (D4, --safety).
 */

/**
 * Проверить состояние. Бросает при нарушении — это дефект симуляции,
 * а не ситуация, которую нужно обрабатывать.
 */
export function checkInvariants(s: SimState): void {
  if (s.tick < 0) fail('номер тика отрицательный', s.tick);
  if (s.playerCount < 1 || s.playerCount > 4) {
    fail(`игроков ${s.playerCount}, ожидалось 1..4`, s.tick);
  }

  for (let i = 0; i < s.playerCount; i++) {
    if (s.pHearts[i] < 0) fail(`у игрока ${i} отрицательное здоровье`, s.tick);
    if (s.pChips[i] < 0) fail(`у игрока ${i} отрицательный кошелёк`, s.tick);
    // Границы с запасом: выход за них означает сломанную физику,
    // а не законное движение по краю.
    if (s.pX[i] < -ARENA_W || s.pX[i] > ARENA_W * 2) fail(`игрок ${i} вне арены по X`, s.tick);
    if (s.pY[i] < -ARENA_H || s.pY[i] > ARENA_H * 2) fail(`игрок ${i} вне арены по Y`, s.tick);
    // Живой с нулём сердец — это состояние, которого не бывает: смерть
    // наступает в тот же тик, что и последнее попадание.
    if (s.pHearts[i] === 0 && (s.pFlags[i] & EntityFlag.Alive) !== 0) {
      fail(`игрок ${i} жив без сердец`, s.tick);
    }
  }

  let enemies = 0;
  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (!s.eActive[i]) continue;
    enemies++;
    if (s.eHP[i] <= 0) fail(`враг ${i} активен с нулевым здоровьем`, s.tick);
  }

  const cap = onScreenCap(s.playerCount);
  if (enemies > cap) fail(`врагов на арене ${enemies}, потолок ${cap} (D9)`, s.tick);

  let bullets = 0;
  for (let i = 0; i < MAX_BULLETS; i++) {
    if (!s.bActive[i]) continue;
    bullets++;
    // Строго меньше: снаряд со сроком, равным текущему тику, гасится в
    // начале СЛЕДУЮЩЕГО шага снарядов и до тех пор законно жив. Инвариант
    // ловит переживших свой срок, а не тех, чей срок наступил только что.
    if (s.bDeadline[i] < s.tick) fail(`снаряд ${i} активен после истечения срока`, s.tick);
  }
  if (bullets > MAX_BULLETS) fail(`снарядов ${bullets}, потолок ${MAX_BULLETS}`, s.tick);

  for (let i = 0; i < MAX_CHIPS; i++) {
    if (!s.cActive[i]) continue;
    if (s.cValue[i] <= 0) fail(`фишка ${i} с неположительным номиналом`, s.tick);
  }

  if (s.meta[Meta.Room] < 1) fail(`номер комнаты ${s.meta[Meta.Room]}`, s.tick);
  if (s.meta[Meta.WaveBudget] < 0) fail('бюджет волны ушёл в минус', s.tick);

  checkBets(s);
  checkAce(s);
  checkRun(s);
}

/**
 * Забег как целое: этаж, фаза, экономика этажа, босс.
 *
 * Слоты заведены в 0.4.0 разом и заполняются по мере того, как доезжают
 * механики. Проверки написаны сразу на все — именно затем, чтобы механика,
 * доехавшая последней, не оказалась единственной непокрытой.
 */
function checkRun(s: SimState): void {
  const floor = s.meta[Meta.Floor];
  if (floor < 1 || floor > FLOORS_PER_RUN) {
    fail(`этаж ${floor}, а их ${FLOORS_PER_RUN}`, s.tick);
  }
  if (s.meta[Meta.Room] > ROOMS_PER_FLOOR) {
    fail(`комната ${s.meta[Meta.Room]} на этаже из ${ROOMS_PER_FLOOR}`, s.tick);
  }

  const phase = s.meta[Meta.Phase];
  if (phase < RunPhase.Door || phase > RunPhase.Summary) fail(`фаза забега ${phase}`, s.tick);

  const room = s.meta[Meta.RoomType];
  if (room < DoorType.Fight || room > DoorType.DebtPit) fail(`тип комнаты ${room}`, s.tick);

  /*
   * Слот выбора делят дверь и лавка, и это единственное поле в состоянии со
   * смыслом, зависящим от фазы.
   *
   * Свободных слотов в `Meta` не осталось, а лавке фокус нужен по-настоящему:
   * товаров три, их листают и подтверждают. Дверь и лавка при этом никогда не
   * открыты одновременно, так что поле физически одно.
   *
   * Опасность у такого совмещения ровно одна, и она тихая: фокус, не погашенный
   * на выходе из лавки, доживает до следующей двери и читается как уже
   * сделанный выбор — игрок получает комнату, которую не выбирал, и понять это
   * по кадру невозможно. Гашение делается руками, поэтому здесь оно и
   * проверяется: вне двух своих фаз слот обязан быть пуст.
   */
  const pick = s.meta[Meta.DoorPick];
  const focused = phase === RunPhase.Door || phase === RunPhase.Reward;
  const slots = phase === RunPhase.Reward ? SHOP_SLOTS : MAX_DOORS;
  if (pick < -1 || pick >= slots) fail(`выбран пункт ${pick} из ${slots}`, s.tick);
  if (!focused && pick !== -1) {
    fail(`фокус ${pick} пережил свой экран: фаза ${phase}`, s.tick);
  }
  for (let i = 0; i < MAX_DOORS; i++) {
    const d = s.doorType[i];
    if (d < DoorType.Fight || d > DoorType.DebtPit) fail(`дверь ${i} предлагает тип ${d}`, s.tick);
  }

  // Долг не уходит в минус и не стакается: проклятие ровно одно (GDD §11).
  if (s.meta[Meta.Debt] < 0) fail('долг ушёл в минус', s.tick);
  const curse = s.meta[Meta.Curse];
  if (curse < Curse.None || curse > Curse.Commission) fail(`проклятие ${curse}`, s.tick);
  if (s.meta[Meta.HouseCut] < 0) fail('доля заведения отрицательная', s.tick);

  /*
   * Босс: запас прочности не выходит за свой потолок.
   *
   * Встречная ставка лечит его на 15%, и без верхней границы выигранная у
   * игрока ставка тихо поднимала бы полосу выше начала боя — то есть бой
   * становился бы длиннее, чем задуман, ровно в том месте, где игрок
   * отступил.
   */
  const hp = s.meta[Meta.BossHP];
  const maxHp = s.meta[Meta.BossMaxHP];
  if (hp < 0) fail('у босса отрицательный запас прочности', s.tick);
  if (hp > maxHp) fail(`у босса ${hp} прочности при потолке ${maxHp}`, s.tick);
  if (maxHp === 0 && hp !== 0) fail('босс жив, не будучи выпущенным', s.tick);

  const bossPhase = s.meta[Meta.BossPhase];
  if (bossPhase < 0 || bossPhase > BOSS.phases) fail(`фаза босса ${bossPhase}`, s.tick);
  // Фаза без тела и тело без фазы — разные поломки, но обе означают босса,
  // которого невозможно ни убить, ни увидеть.
  if ((bossPhase === 0) !== (maxHp === 0)) {
    fail(`фаза босса ${bossPhase} при потолке прочности ${maxHp}`, s.tick);
  }

  const bet = s.meta[Meta.CounterBetBroken];
  if (bet < 0 || bet > 2) fail(`исход встречной ставки ${bet}`, s.tick);
  if (bet !== 0 && maxHp === 0) fail('встречная ставка без босса', s.tick);

  for (let i = 0; i < MAX_BALLS; i++) {
    if (!s.ballActive[i]) continue;
    // Шар, переживший бой, — это снаряд в комнате, где стрелять некому.
    if (maxHp === 0) fail(`шар ${i} на арене без босса`, s.tick);
    const sector = s.ballSector[i];
    if (sector < 0 || sector >= SECTOR_COUNT) fail(`шар ${i} метит в сектор ${sector}`, s.tick);
  }

  // Провал всегда один: два одновременных вырезают из колеса четверть
  // (GDD §8.1). Сектор, который возвращается раньше, чем проваливается, —
  // дыра в полу навсегда.
  let fallen = 0;
  for (let i = 0; i < SECTOR_COUNT; i++) {
    if (s.sectorFallAt[i] === 0) continue;
    if (maxHp === 0) fail(`сектор ${i} провален без босса`, s.tick);
    if (s.sectorRestoreAt[i] <= s.sectorFallAt[i]) {
      fail(`сектор ${i} возвращается раньше, чем проваливается`, s.tick);
    }
    fallen++;
  }
  if (fallen > 1) fail(`провалено секторов ${fallen}, а их бывает один`, s.tick);

  /*
   * Апгрейды: индекс со сдвигом на единицу, ноль — пустой слот.
   *
   * Повтор проверяется здесь, а не только в лавке: второй экземпляр удвоил бы
   * эффект и занял бы слот, а увидеть это можно было бы только в деньгах и во
   * времени убийства — то есть нигде.
   */
  for (let p = 0; p < s.playerCount; p++) {
    for (let i = 0; i < MAX_UPGRADE_SLOTS; i++) {
      const u = s.pUpgrades[p * MAX_UPGRADE_SLOTS + i];
      if (u < 0 || u > UPGRADE_COUNT) fail(`у игрока ${p} в слоте ${i} апгрейд ${u}`, s.tick);
      if (u === 0) continue;
      for (let j = 0; j < i; j++) {
        if (s.pUpgrades[p * MAX_UPGRADE_SLOTS + j] === u) {
          fail(`у игрока ${p} апгрейд ${u} куплен дважды`, s.tick);
        }
      }
    }
  }

  /*
   * Прилавок: товар из каталога, цена неотрицательная, пустой слот без цены.
   *
   * Цена без товара — не мелочь: интерфейс подписывает ею кнопку, и игрок
   * увидел бы ценник на пустом месте, а покупка сняла бы деньги ни за что.
   */
  const gift = s.meta[Meta.Phase] === RunPhase.Reward && s.meta[Meta.RoomType] === DoorType.Gift;
  for (let i = 0; i < SHOP_SLOTS; i++) {
    const item = s.shopItem[i];
    if (item < 0 || item > UPGRADE_COUNT) fail(`в лавке слот ${i} с товаром ${item}`, s.tick);
    if (s.shopPrice[i] < 0) fail(`в лавке слот ${i} с ценой ${s.shopPrice[i]}`, s.tick);
    if (item === 0 && s.shopPrice[i] !== 0) fail(`в лавке слот ${i} с ценой без товара`, s.tick);
    /*
     * У Дара ценников нет, и это проверяется, потому что на нуле держится
     * показ: отдельного признака «бесплатно» в состоянии не заведено, экран
     * читает пустую цену при занятом слоте. Ненулевой ценник на Даре означал
     * бы, что с подарка просят денег.
     */
    if (gift && s.shopPrice[i] !== 0) fail(`Дар просит ${s.shopPrice[i]} за слот ${i}`, s.tick);
  }

  if (s.meta[Meta.Earned] < 0) fail('заработано за забег ушло в минус', s.tick);
  if (s.meta[Meta.PaidToAce] < 0) fail('отдано Крупье ушло в минус', s.tick);
  if (s.meta[Meta.Keys] < 0) fail('ключей за забег меньше нуля', s.tick);
}

/**
 * Ставочная часть состояния.
 *
 * Появилась в 0.3.0 и до сих пор не была покрыта ничем: инварианты проверяли
 * мир версии «Тир». Здесь дешёвые проверки на то, что слот пари вообще
 * осмыслен, — ошибка в них не видна ни в бою, ни в логе, только в деньгах.
 */
function checkBets(s: SimState): void {
  for (let p = 0; p < s.playerCount; p++) {
    /*
     * Схема ввода приезжает ДВУМЯ битами маски, то есть принимает 0..3, а
     * схем три. Четвёртое значение даёт `1 << 3` — бит, которого нет ни в
     * одной `schemeMask`, и матрица «пари × схема ввода» молча перестаёт
     * фильтровать: игрок получает пари, невыполнимое его руками, ровно там,
     * где матрица и заводилась, чтобы этого не случилось (GDD §9.5).
     */
    if (s.pScheme[p] < 0 || s.pScheme[p] > InputScheme.Touch) {
      fail(`у игрока ${p} схема ввода ${s.pScheme[p]}, а их ${InputScheme.Touch + 1}`, s.tick);
    }
    if (s.pAppetite[p] < 0 || s.pAppetite[p] >= APPETITE.length) {
      fail(`у игрока ${p} аппетит ${s.pAppetite[p]}, тиров ${APPETITE.length}`, s.tick);
    }

    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      const k = p * MAX_ACTIVE_BETS + i;
      const state = s.aState[k];
      if (state < BetState.None || state > BetState.Cashed) {
        fail(`пари ${i} игрока ${p} в состоянии ${state}`, s.tick);
      }
      if (state === BetState.None) continue;
      /*
       * Знак кона говорит, ЧЕЙ он (bets.ts, `aceStakeAt`).
       *
       * Положительный — кон игрока: он списан с кошелька при подборе, а
       * кошелёк в минус не уходит, потому что Крупье в кредит не принимает
       * (GDD §11). Отрицательный — кон Крупье в Ставке Крупье: тот не списан ни с
       * кого и потому потолком кошелька не ограничен. Ограничен он другим — и
       * это проверяется здесь, потому что ошибка в нём не видна ни в бою, ни в
       * логе, только в деньгах: `min(40 × этаж, 25% кошелька)` не может
       * превысить первое слагаемое ни при каком кошельке (ECONOMY §10А).
       */
      const ace = -s.aStake[k];
      if (ace > ACE_BET.stakePerFloor * s.meta[Meta.Floor]) {
        fail(`Ставка Крупье у игрока ${p} на ${ace} при потолке этажа`, s.tick);
      }
      /*
       * Кон игрока ограничен сверху верхним тиром аппетита.
       *
       * Проверка вернулась намеренно. Знак кона стал признаком владельца, и
       * прежний инвариант «кон не бывает отрицательным» пришлось снять — но
       * вместе с ним со стороны игрока пропала ЛЮБАЯ граница, и кон в
       * миллион перестал ловиться. Потолок здесь честный: `stakeFor` возвращает
       * `min(тир, кошелёк)`, а тиров три и верхний известен (ECONOMY §7).
       */
      const top = APPETITE[APPETITE.length - 1];
      if (s.aStake[k] > top) {
        fail(`кон ${s.aStake[k]} у пари ${i} игрока ${p} выше верхнего тира ${top}`, s.tick);
      }
      if (s.aBet[k] < 0 || s.aBet[k] >= BET_COUNT) {
        fail(`пари ${i} игрока ${p} ссылается на несуществующее пари ${s.aBet[k]}`, s.tick);
      }
      if (s.aCounter[k] < 0) fail(`у пари ${i} игрока ${p} отрицательный счётчик`, s.tick);
    }
  }
}

/** Крупье: жест, бюджет выходов и его собственная ставка. */
function checkAce(s: SimState): void {
  const g = s.meta[Meta.AceGesture];
  if (g < AceGesture.None || g > AceGesture.Ovation) fail(`жест Крупье ${g}`, s.tick);

  /*
   * Его карта на арене одна, и его ставок у игрока не больше одной.
   *
   * Ставит он раз в два-три боя, и второе предложение поверх первого означало
   * бы либо потерянное решение игрока, либо два кона по четверти кошелька в
   * одной комнате — то есть дисперсию, которой в ECONOMY §10А нет.
   */
  let offers = 0;
  for (let i = 0; i < MAX_CARDS; i++) {
    if (!s.kActive[i]) continue;
    if (s.kOwner[i] < ACE || s.kOwner[i] >= s.playerCount) {
      fail(`карта ${i} принадлежит ${s.kOwner[i]}`, s.tick);
    }
    if (s.kOwner[i] === ACE) offers++;
  }
  if (offers > 1) fail(`карт Крупье на арене ${offers}, а бывает одна`, s.tick);

  for (let p = 0; p < s.playerCount; p++) {
    let taken = 0;
    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      const k = p * MAX_ACTIVE_BETS + i;
      if (s.aState[k] === BetState.Active && s.aStake[k] < 0) taken++;
    }
    if (taken > 1) fail(`у игрока ${p} ${taken} Ставки Крупье сразу`, s.tick);
  }
  if (s.meta[Meta.DeathStreak] < 0) fail('серия смертей ушла в минус', s.tick);
  if (s.meta[Meta.WinStreak] < 0) fail('серия выигранных пари ушла в минус', s.tick);
  if (s.meta[Meta.AceCameos] < 0) fail('счётчик выходов Крупье ушёл в минус', s.tick);
  // Тело без позиции и позиция без тела — разные поломки, но обе означают,
  // что клиент нарисует Крупье не там, где он есть.
  if (s.meta[Meta.AceX] === 0 && s.meta[Meta.AceGesture] !== AceGesture.None) {
    fail('жест играется на пустой арене', s.tick);
  }
}

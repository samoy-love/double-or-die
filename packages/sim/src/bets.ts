/**
 * Пари: карты на арене, активные ставки, прогресс и расчёт.
 *
 * Главное решение версии записано в GDD §9.1 и держится здесь: **отдельного
 * экрана ставок нет**. Карта — это место на арене, до которого надо добежать,
 * а решение «брать или не брать» — пространственное, а не меню. Из этого
 * следует всё остальное в файле: карта живёт как сущность симуляции, тает по
 * тикам, подбирается кнопкой, а не наездом, и разрешение одновременного
 * подбора обязано быть детерминированным.
 *
 * Кон списывается в момент подбора и никогда не превышает кошелёк: Крупье в
 * кредит не принимает, и поэтому провал пари не создаёт долга (GDD §11).
 *
 * Здесь же живёт **Ставка Крупье** (GDD §12А.1): раз в два-три боя он кладёт
 * СВОЮ карту и ставит против игрока из своего кармана. Новой системы она не
 * требует — условие берётся из того же каталога, — и меняет ровно две вещи:
 * источник карты (`kOwner === ACE`) и направление выплаты (один к одному из
 * его кошелька, а не кон × множитель из своего).
 */

import {
  RED_ZONE_RADIUS,
  clampX,
  clampY,
  isFreeSpot,
  maxX,
  maxY,
  redZoneX,
  redZoneY,
} from './arena';
import { BET_COUNT, BETS, BetId, BetProgress, type BetSpec } from './bets.generated';
import {
  ACE_BET,
  APPETITE,
  ARENA_PAD,
  CARD,
  MAX_ACTIVE_BETS,
  PLAYER,
  ROOMS_PER_FLOOR,
} from './config';
import { markLegUp } from './floor';
import { add, div, FX_ONE, type Fx, mul, sub } from './fixed';
import { Stream, nextInt } from './rng';
import {
  AceGesture,
  BetState,
  DoorType,
  EntityFlag,
  MAX_CARDS,
  Meta,
  RunPhase,
  type SimState,
} from './state';
import { within } from './trig';

export {
  BETS,
  BET_COUNT,
  BetId,
  BetProgress,
  BetCategory,
  InputScheme,
  type BetSpec,
} from './bets.generated';

/** Общая карта: досталась тому, кто добежал. */
export const SHARED = -1;

/**
 * Карта Крупье: он выложил СВОЮ и ставит против игрока (GDD §12А.1).
 *
 * Ещё одно отрицательное значение владельца, а не новый слот состояния и не
 * новый массив: и то и другое меняет длину хеша, то есть валит все двадцать
 * эталонов. Карта Крупье — это карта: у неё есть пари, срок и место, а «чья
 * она» и так живёт в `kOwner`. Отрицательные значения там уже означают «не
 * персональная», и второе просто уточняет, чья именно.
 *
 * Телом её никто не подбирает: `tryTakeCard` берёт только свою и общую, а
 * решение по этой принимается кнопкой на экране — «Принять» или
 * «Отказаться» (`acceptAceBet` / `declineAceBet`).
 */
export const ACE = -2;

export const betAt = (index: number): BetSpec => BETS[index];

/** Слот активного пари игрока `p` под номером `n`. */
const slot = (p: number, n: number): number => p * MAX_ACTIVE_BETS + n;

/** Размер кона по выбранному аппетиту, но не больше кошелька. */
export function stakeFor(s: SimState, player: number): number {
  const tier = Math.min(APPETITE.length - 1, Math.max(0, s.pAppetite[player]));
  return Math.min(APPETITE[tier], s.pChips[player]);
}

// ---------------------------------------------------------------------------
// Ставка Крупье
// ---------------------------------------------------------------------------

/**
 * Его кон: `min(40 × этаж, 25% кошелька игрока)` (ECONOMY §10А).
 *
 * Доля кошелька — не осторожность, а условие работоспособности: на первом
 * этаже ставка в сорок превысила бы стартовые тридцать фишек, и одна карта
 * Крупье вносила бы дисперсию уровня самого рискового профиля игры.
 */
export function aceStakeFor(s: SimState, player: number): number {
  const byFloor = ACE_BET.stakePerFloor * s.meta[Meta.Floor];
  const byWallet = Math.trunc((s.pChips[player] * ACE_BET.stakeWalletPct) / 100);
  return byFloor < byWallet ? byFloor : byWallet;
}

/**
 * Выходит ли Крупье со своей картой в бою номер `fight` (сквозной за забег).
 *
 * «Одна карта на 2–3 боя» (ECONOMY §10А) — это две на каждые пять, и здесь
 * они разносятся по пяти боям равномерно. Промежутки получаются 2 и 3
 * попеременно, а не в среднем: два боя подряд без карты и три подряд без карты
 * — разные ощущения, и «в среднем 2.5» позволило бы обоим сойтись в одном
 * забеге до пяти.
 *
 * ЧИСТАЯ ФУНКЦИЯ, и это несущее свойство, а не аккуратность. Счётчик «боёв с
 * прошлой карты» пришлось бы держать слотом состояния — то есть менять длину
 * `meta` и хеш, — а заодно он стал бы вторым источником истины о номере боя,
 * который уже записан этажом и комнатой.
 */
export const aceBetDue = (fight: number): boolean =>
  fight >= ACE_BET.firstFight &&
  ((fight - ACE_BET.firstFight) * ACE_BET.offersPerPeriod) % ACE_BET.offerPeriod <
    ACE_BET.offersPerPeriod;

/**
 * Крупье выкладывает свою карту в начале комнаты, если ей срок.
 *
 * Не посреди боя, и это следствие того, что решение теперь принимается
 * ЭКРАНОМ: «Принять» или «Отказаться» — выбор, который читают, а не хватают
 * телом. Пауза перед первой волной для него и существует, поэтому и срок
 * карты — ровно до первой волны: не ответил — значит отказался, и это не
 * стоит ему ничего (GDD §12А.1).
 *
 * У босса своей карты он не кладёт: там уже идёт встречная ставка босса
 * (GDD §8.1), и два предложения на один бой превращают выбор в очередь.
 *
 * Нищему он не предлагает: кон считается долей кошелька, и при пустом
 * кармане ставка вырождается в ноль против нуля — жест без содержания.
 */
export function offerAceBet(s: SimState): void {
  if (s.meta[Meta.Phase] === RunPhase.Boss) return;
  const fight = (s.meta[Meta.Floor] - 1) * ROOMS_PER_FLOOR + s.meta[Meta.Room];
  if (!aceBetDue(fight)) return;

  let worth = 0;
  for (let p = 0; p < s.playerCount; p++) {
    if ((s.pFlags[p] & EntityFlag.Alive) === 0) continue;
    if (aceStakeFor(s, p) > worth) worth = aceStakeFor(s, p);
  }
  if (worth === 0) return;

  const bet = pickBet(s, ACE);
  if (bet < 0) return;
  layAceCard(s, bet, s.meta[Meta.NextWaveAt]);
}

/**
 * Положить карту Крупье в названный срок. Публично: этим пользуются сценарии.
 *
 * Ложится в центр арены и без поиска свободного места — в отличие от карт
 * раскладки. Это не карта на полу, за которой бегут: это его карта на столе,
 * и её показывает экран. Заодно точка получается чистой функцией от арены, а
 * не третьим обращением к RNG за одну комнату.
 */
export const layAceCard = (s: SimState, bet: number, deadline: number): number =>
  putCard(s, bet, ACE, deadline, s.arenaW >> 1, s.arenaH >> 1);

/** Лежащая карта Крупье или −1. Она всегда одна: это проверяет инвариант. */
export function aceCardAt(s: SimState): number {
  for (let i = 0; i < MAX_CARDS; i++) {
    if (s.kActive[i] && s.kOwner[i] === ACE) return i;
  }
  return -1;
}

/**
 * Кон Крупье по слоту активного пари. Ноль — пари обычное, кон игрока.
 *
 * **Знак кона говорит, ЧЕЙ он.** Кон игрока списывается с кошелька при
 * подборе и потому неотрицателен всегда; кон Крупье не списывается ни с кого и
 * записывается отрицательным. Одно поле вместо второго — потому что второе
 * означало бы новый массив состояния, то есть новую длину хеша и
 * ре-бейзлайн всех эталонов ради одного бита. Смысл при этом не двоится:
 * «сколько поставлено» и «кем поставлено» — про одну и ту же сумму.
 */
export const aceStakeAt = (s: SimState, player: number, n: number): number => {
  const v = s.aStake[slot(player, n)];
  return v < 0 ? -v : 0;
};

/**
 * Принять Ставку Крупье. Возвращает false, если принимать нечего или нечем.
 *
 * Кон при принятии ФИКСИРУЕТСЯ: кошелёк за бой меняется, а сумма, о которой
 * договорились, — нет. Иначе выплата зависела бы от того, сколько фишек игрок
 * успел подобрать после рукопожатия.
 *
 * С кошелька при этом не списывается ничего: ставит он, и списывать пока
 * нечего. Проигрыш заберёт своё в `loseBet` — и не больше, чем есть.
 */
export function acceptAceBet(s: SimState, player: number): boolean {
  const card = aceCardAt(s);
  if (card < 0) return false;
  if ((s.pFlags[player] & EntityFlag.Alive) === 0) return false;
  if (activeCount(s, player) >= MAX_ACTIVE_BETS) return false;

  const stake = aceStakeFor(s, player);
  if (stake <= 0) return false;
  if (!takeBet(s, player, s.kBet[card], -stake)) return false;

  s.kActive[card] = 0;
  return true;
}

/**
 * Отказаться. **Без штрафа** — это правило, а не поблажка (GDD §12А.1).
 *
 * Игрока не спрашивают, кто отказался: ставит Крупье против стола, и одного
 * «нет» хватает, чтобы карты не стало. Молчание до первой волны означает то
 * же самое и стоит столько же — ноль.
 */
export function declineAceBet(s: SimState): boolean {
  const card = aceCardAt(s);
  if (card < 0) return false;
  s.kActive[card] = 0;
  return true;
}

/**
 * Проигранная Ставка Крупье: он забирает эквивалент — но не больше, чем есть.
 *
 * **Кошелёк в минус не уходит никогда** (ECONOMY §10, «Крупье в кредит не
 * принимает»). Кон здесь не списан заранее, как у обычного пари, поэтому
 * правило приходится держать в момент расчёта: между рукопожатием и провалом
 * игрок мог потратиться в лавке или потерять фишки Вьюну.
 */
function payAce(s: SimState, player: number, k: number): void {
  const owed = -s.aStake[k];
  if (owed <= 0) return;
  const paid = owed < s.pChips[player] ? owed : s.pChips[player];
  s.pChips[player] -= paid;
  s.meta[Meta.PaidToAce] += paid;
}

/**
 * Забег кончился со Ставкой Крупье на руках — он забирает своё.
 *
 * Отдельная функция, потому что конец забега разрешает пари сам (`endRun`) и
 * мимо `loseBet`: там уже не важен ни near-miss, ни счётчик проигранных, а
 * вот деньги важны. Пари, застигнутое концом, не выполнено — значит выиграл он.
 */
export function payAceOnRunEnd(s: SimState): void {
  for (let p = 0; p < s.playerCount; p++) {
    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      const k = slot(p, i);
      if (s.aState[k] !== BetState.Active) continue;
      payAce(s, p, k);
    }
  }
}

// ---------------------------------------------------------------------------
// Раскладка
// ---------------------------------------------------------------------------

/**
 * Разложить карты в начале комнаты: `игроков + 2`.
 *
 * Формула держит две вещи разом (GDD §9.1). Каждому хватает хотя бы на одну —
 * доступ к главной механике игры не может зависеть от того, кто быстрее
 * бегает. И карт всегда меньше, чем хочется: соло-игрок не может взять все и
 * жадничает осознанно, а вчетвером хорошие карты становятся предметом гонки.
 *
 * Персональные карты выдаются по одной на игрока, остальные — общие.
 */
export function dealCards(s: SimState): void {
  clearCards(s);

  // Жирный бой добавляет ровно одну карту сверх обычной раскладки (GDD §5) —
  // добровольная сложность за деньги должна и платить щедрее по картам, не
  // только числом врагов.
  const fatBonus = s.meta[Meta.RoomType] === DoorType.Fat ? 1 : 0;
  const total = Math.min(MAX_CARDS, s.playerCount + CARD.extraCards + fatBonus);
  for (let i = 0; i < total; i++) {
    const owner = i < s.playerCount ? i : SHARED;
    dealOne(s, owner);
  }

  /*
   * Персональная карта каждому — это не пожелание, а несущее правило
   * (GDD §9.1): доступ к главной механике игры не может зависеть ни от того,
   * кто быстрее бегает, ни от того, как легли случайные точки. Раскладка
   * обязана лечь сама, но проверка стоит копейки, а незамеченный пропуск
   * стоил бы игроку целой комнаты без ставок.
   */
  for (let p = 0; p < s.playerCount; p++) {
    if (hasCardFor(s, p)) continue;
    dealOne(s, p);
  }

  // Подброс Крупье посреди боя и весь его бюджет выходов живут в `resetAce`:
  // раздача идёт ПОСЛЕ расчёта, а Крупье выходит принимать расчёт — сброс на
  // этом месте стирал бы его ровно тогда, когда он нужен.
}

/**
 * Сбросить Крупье к началу комнаты: присутствие, бюджет выходов и ЖЕСТ.
 *
 * Жест сбрасывается вместе с телом, и это не уборка на всякий случай. Пока
 * этого не было, `startRoom` оставлял запрещённое состояние: расчёт прошлой
 * комнаты срывает недожатые пари, каждый срыв зовёт `gesture()`, тот выводит
 * Крупье ради аплодисментов — а раздача карт двумя строками ниже убирала тело и
 * оставляла жест. `AceX` ноль, `AceGesture` «аплодирует»: ровно ту пару
 * запрещает инвариант «жест играется на пустой арене» (invariants.ts). В
 * dev-сборке он останавливал цикл прямо на экране расчёта, и игрок оставался
 * с кадром, который нечем пропустить; ботом ловилось в каждом пятом забеге.
 *
 * Живёт отдельно от `dealCards`, потому что зовётся РАНЬШЕ расчёта: Крупье
 * выходит принимать его уже с чистым бюджетом новой комнаты (`startRoom`).
 * Пока сброс сидел внутри раздачи, он приходился на момент ПОСЛЕ расчёта и
 * стирал именно то, ради чего Крупье выходил.
 */
export function resetAce(s: SimState): void {
  s.meta[Meta.TossAt] = 0;
  s.meta[Meta.AceX] = 0;
  s.meta[Meta.AceY] = 0;
  s.meta[Meta.AceLeaveAt] = 0;
  s.meta[Meta.AceTossed] = 0;
  s.meta[Meta.AceCameos] = 0;
  s.meta[Meta.AceCameoAt] = 0;
  s.meta[Meta.AceMoods] = 0;
  s.meta[Meta.AceGesture] = AceGesture.None;
  s.meta[Meta.AceGestureUntil] = 0;
}

/**
 * Крупье выходит ПРИНЯТЬ РАСЧЁТ.
 *
 * Заведение показывается, когда сводят книги, — и это не украшение экрана
 * итогов, а его смысл. Провал пари зовёт аплодисменты (`loseBet`), но звать
 * их было некому: тело на арене отсутствовало, а выход «на настроение» тратил
 * единственный бюджет реакции и всё равно стирался раздачей карт. В итоге
 * самый драматичный момент комнаты — «сколько не хватило» — проходил в
 * тишине, при том что GDD §17А объявляет комедию из правил несущей частью
 * игры.
 *
 * Зовётся ДО `settleBets`: тело обязано стоять раньше, чем полетят жесты,
 * иначе каждый из них снова уйдёт в `moodCameo` и съест реакцию боя.
 *
 * Выходит только когда есть что считать. Перед первой комнатой забега слоты
 * пусты, панель расчёта не рисуется — и Крупье, пришедший к пустому столу, был бы
 * ровно той декорацией, от которой правило «пришёл и ушёл» защищает.
 */
export function aceAtSettlement(s: SimState): void {
  let pending = 0;
  for (let k = 0; k < s.playerCount * MAX_ACTIVE_BETS; k++) {
    if (s.aState[k] === BetState.Active) pending++;
  }
  if (pending === 0) return;
  if (!enterAce(s)) return;
  // Уходит по тем же часам, что и с любого выхода: телеграф плюс три секунды.
  // Пауза расчёта длиннее (пять секунд), так что уход виден игроку целиком —
  // заведение приняло ставки и удалилось, а не растворилось со сменой экрана.
  s.meta[Meta.AceLeaveAt] = s.tick + CARD.aceTelegraphTicks + CARD.aceStayTicks;
}

/**
 * Положить одну карту, если для неё нашлось пари.
 *
 * Пустая рука — законный исход, а не сбой: `pickBet` скорее не даст ничего,
 * чем выдаст пари, невыполнимое на схеме владельца. Карты не станет; карта,
 * которую нельзя отыграть, была бы хуже (GDD §9.5).
 */
function dealOne(s: SimState, owner: number): void {
  const bet = pickBet(s, owner);
  if (bet < 0) return;
  placeCard(s, bet, owner, s.tick + CARD.lifeTicks);
}

function hasCardFor(s: SimState, player: number): boolean {
  for (let i = 0; i < MAX_CARDS; i++) {
    if (s.kActive[i] && s.kOwner[i] === player) return true;
  }
  return false;
}

/**
 * Крупье на арене: приходит к середине боя и бросает карту.
 *
 * Он не мешает бою — не коллизится, неуязвим, рисуется ниже боевых сущностей
 * (GDD §12А.1). Злорадство даётся отзывчивостью, а не хитбоксом: перекрывать
 * обзор в игре, где читаемость объявлена столпом, недопустимо.
 *
 * Точка подброса — ЧИСТАЯ ФУНКЦИЯ от состояния, а не обращение к общему RNG
 * (TECH §2.3): «Крупье кладёт карту в опасное место» обязано воспроизводиться в
 * реплее один в один и одинаково у всех пиров.
 */
function stepAce(s: SimState): void {
  const leaveAt = s.meta[Meta.AceLeaveAt];

  /*
   * Отработал — уходит.
   *
   * Пришёл он бросить карту, а не досмотреть бой: цилиндр, зависший у стены
   * до конца комнаты, перестаёт быть событием и становится частью интерьера,
   * а вместе с ним обесцениваются и жесты, которые он играет телом
   * (GDD §12А.1, §17А). «Больше не придёт с картой» живёт отдельным полем
   * `AceTossed`, а не отрицательной позицией: выход ради жеста и выход ради
   * подброса — разные события, и пока оба смысла делили одно поле, первый же
   * жест отменял подброс.
   */
  if (leaveAt > 0 && s.tick >= leaveAt) {
    s.meta[Meta.AceX] = 0;
    s.meta[Meta.AceY] = 0;
    s.meta[Meta.AceLeaveAt] = 0;
    // Тик ухода — точка отсчёта паузы между выходами: приходить снова сразу
    // же значит не уходить.
    s.meta[Meta.AceCameoAt] = s.tick;
    s.meta[Meta.AceGesture] = AceGesture.None;
    s.meta[Meta.AceGestureUntil] = 0;
    return;
  }

  // Уже объявил — ждём конца телеграфа и бросаем.
  if (s.meta[Meta.TossAt] !== 0) {
    if (s.tick < s.meta[Meta.TossAt]) return;
    s.meta[Meta.TossAt] = 0;
    s.meta[Meta.AceTossed] = 1;
    placeCard(s, pickBet(s, SHARED), SHARED, s.tick + CARD.lifeTicks);
    return;
  }

  // Он уже на арене — выходить второй раз неоткуда.
  if (s.meta[Meta.AceX] !== 0) return;

  // Подброс — один за комнату, ровно на середине зачищенной угрозы.
  if (s.meta[Meta.AceTossed] !== 0) return;
  const total = s.meta[Meta.RoomThreat];
  if (total <= 0) return;
  if (s.meta[Meta.ThreatCleared] * 100 < total * CARD.tossAtThreatPct) return;
  if (!enterAce(s)) return;

  s.meta[Meta.TossAt] = s.tick + CARD.aceTelegraphTicks;
  s.meta[Meta.AceLeaveAt] = s.tick + CARD.aceTelegraphTicks + CARD.aceStayTicks;
}

/**
 * Вывести Крупье на арену. Возвращает false, если выходить нельзя.
 *
 * Точка стояния — ЧИСТАЯ ФУНКЦИЯ от положения всех живых игроков. Считать её
 * по игроку 0 нельзя даже в соло, где это работает случайно: в коопе «дальняя
 * стена» первого игрока бывает ближней для четвёртого, и Крупье вставал бы
 * посреди чужого боя — то есть ровно там, где обещано, что его не будет.
 * Центр масс живых даёт одну точку на всю команду и не зависит от нумерации.
 *
 * Выходов за комнату не больше `aceCameosPerRoom`, и между ними держится
 * пауза: Крупье, мелькающий у стены каждые пару секунд, перестаёт быть событием
 * ровно так же, как Крупье, зависший там навсегда.
 */
function enterAce(s: SimState): boolean {
  if (s.meta[Meta.AceCameos] >= CARD.aceCameosPerRoom) return false;
  const last = s.meta[Meta.AceCameoAt];
  if (last !== 0 && s.tick - last < CARD.aceCameoGapTicks) return false;

  let alive = 0;
  let sumX = 0;
  let sumY = 0;
  for (let p = 0; p < s.playerCount; p++) {
    if ((s.pFlags[p] & EntityFlag.Alive) === 0) continue;
    sumX += s.pX[p];
    sumY += s.pY[p];
    alive++;
  }
  if (alive === 0) return false;
  const midX = Math.trunc(sumX / alive) | 0;
  const midY = Math.trunc(sumY / alive) | 0;

  // Встаёт у края — там, куда команда смотрит меньше всего: у дальней от неё
  // стены по горизонтали и на её же высоте.
  s.meta[Meta.AceX] = midX > s.arenaW >> 1 ? fromUnits(90) : sub(s.arenaW, fromUnits(90));
  s.meta[Meta.AceY] = midY;
  s.meta[Meta.AceCameos]++;
  return true;
}

/**
 * Выход «на настроение»: Крупье приходит ОТРЕАГИРОВАТЬ, а не бросить карту.
 *
 * Без него четыре жеста из шести были мёртвым кодом. Замер до правки: Крупье на
 * арене 7% времени, из шести жестов срабатывали два — зевок, отворачивание,
 * палец вниз и овация не случались ни разу за пять минут, потому что и
 * `gesture()`, и `stepGestures` выходят при пустой арене, а приходил он один
 * раз за комнату и на три секунды. «Комедия из правил» (GDD §17А) при этом
 * молчала почти весь бой.
 *
 * Приходит он не мгновенно: телеграф тот же, что у подброса, — свист и
 * появление у стены. Реакция с опозданием на полсекунды честнее реакции из
 * ниоткуда, и это тот же сигнал, который игрок уже выучил.
 */
function moodCameo(s: SimState, g: AceGesture): void {
  if (s.meta[Meta.AceX] !== 0) return;
  if (s.meta[Meta.AceMoods] >= CARD.aceMoodCameos) return;
  if (!enterAce(s)) return;

  s.meta[Meta.AceMoods]++;
  s.meta[Meta.AceLeaveAt] = s.tick + CARD.aceTelegraphTicks + CARD.aceStayTicks;
  // Жест ставится с задержкой на телеграф: тело должно доехать раньше, чем
  // начнёт играть.
  s.meta[Meta.AceGesture] = g;
  s.meta[Meta.AceGestureUntil] = s.tick + CARD.aceTelegraphTicks + CARD.gestureTicks;
}

/**
 * Выбрать пари для карты.
 *
 * Конфликтующие вместе не выпадают: матрица конфликтов — данные, и здесь она
 * только применяется. Пари, уже лежащее на арене или взятое кем-то, второй раз
 * не выдаётся — иначе стол вырождается в четыре одинаковые карты.
 */
/**
 * Буфер подходящих пари.
 *
 * Предаллоцирован на модуле, а не собирается массивом на каждый вызов:
 * раскладка идёт в начале комнаты, а подброс Крупье — прямо посреди боя, и
 * аллокация в горячем пути ядру запрещена (TECH §4, tests/allocations).
 */
const freeBets = new Int32Array(BET_COUNT);

function pickBet(s: SimState, owner: number): number {
  let free = 0;
  for (let b = 0; b < BET_COUNT; b++) {
    if (!betAvailable(s, b, owner)) continue;
    freeBets[free++] = b;
  }

  if (free === 0) {
    /*
     * Стол вырожден: всё, что было можно, уже лежит или взято. Повтор пари
     * допускаем — карта лучше пустого места, — а вот схему ввода нет:
     * невыполнимое пари это не жадный выбор игрока, а сломанная карта
     * (GDD §9.5).
     */
    for (let b = 0; b < BET_COUNT; b++) {
      if (!schemeBlocked(s, b, owner)) freeBets[free++] = b;
    }
    /*
     * Выдать нечего — значит карты не будет, и это законный исход.
     *
     * Раньше здесь стоял `return 0`, то есть первое пари каталога В ОБХОД
     * схемы — ровно то, что абзацем выше объявлено недопустимым. Случай
     * достижим: на таче с автоогнём весь каталог может оказаться закрытым
     * матрицей, и тогда «сломанная карта» досталась бы игроку именно там, где
     * матрица и заводилась, чтобы этого не случилось.
     */
    if (free === 0) return -1;
  }

  return freeBets[nextInt(s.rng, Stream.Bets, free)];
}

/**
 * Годится ли пари для карты, предназначенной `owner` (`SHARED` — общей).
 *
 * Сравнения идут ЧИСЛАМИ: номер пари против номера, конфликты — битовой
 * маской. Строковый идентификатор остаётся в данных и в отладке, а проверка,
 * которая исполняется на каждой выдаваемой карте, обязана быть числовой
 * (TECH §4).
 */
function betAvailable(s: SimState, bet: number, owner: number): boolean {
  if (schemeBlocked(s, bet, owner)) return false;
  // Красной зоны на боссовой арене нет — значит нет и пари на неё (GDD §8.1).
  // Пари, условие которого выполняется само собой, — это не выбор, а подарок.
  if (bet === BetId.NoRedZone && s.meta[Meta.Phase] === RunPhase.Boss) return false;
  // Конфликты взаимны — это проверяет схема, — поэтому одной маски хватает.
  const mask = BETS[bet].conflictMask;

  for (let i = 0; i < MAX_CARDS; i++) {
    if (!s.kActive[i]) continue;
    if (s.kBet[i] === bet) return false;
    if ((mask & (1 << s.kBet[i])) !== 0) return false;
  }
  for (let i = 0; i < s.playerCount * MAX_ACTIVE_BETS; i++) {
    if (s.aState[i] !== BetState.Active) continue;
    if (s.aBet[i] === bet) return false;
    if ((mask & (1 << s.aBet[i])) !== 0) return false;
  }
  return true;
}

/**
 * Невыполнимо ли пари на схеме ввода того, кому карта достанется.
 *
 * Матрица «пари × схема ввода» (GDD §9.5) существует затем, чтобы игрок не
 * получал карту, которую физически не может отыграть: пари на контроль
 * выстрелов бессмысленно на таче с автоогнём. Общая карта достаётся тому, кто
 * добежал, то есть любому, — поэтому она отбраковывается, если невыполнима
 * хоть у кого-то за столом: гонка за карту, которую половина стола отыграть
 * не может, честной не бывает.
 *
 * Карта Крупье проверяется по тому же правилу и по той же причине: он ставит
 * против стола целиком, и принять его пари вправе любой. Отсюда проверка «не
 * персональная», а не «общая»: владельцев без имени два, и оба означают, что
 * играть это придётся кому-то из живых, а кому — заранее неизвестно.
 */
function schemeBlocked(s: SimState, bet: number, owner: number): boolean {
  const mask = BETS[bet].schemeMask;
  if (mask === 0) return false;
  if (owner >= 0) return (mask & (1 << s.pScheme[owner])) !== 0;
  for (let p = 0; p < s.playerCount; p++) {
    if ((mask & (1 << s.pScheme[p])) !== 0) return true;
  }
  return false;
}

/*
 * Отдельной функции «объявить схему» здесь нет намеренно.
 *
 * Схема приезжает битами кадра ввода (`Btn.Scheme0/1`) и зеркалится в
 * `s.pScheme` в обработке ввода каждый тик. Сеттер поверх этого лгал бы:
 * выставленное им значение молча затиралось бы следующим же кадром.
 */

/**
 * Положить карту в свободное место.
 *
 * «Раскладка честная»: карты разносятся по арене и не ложатся ни друг на
 * друга, ни под ноги игроку — иначе один игрок систематически оказывается
 * ближе к лучшей карте, а в соло карта, упавшая на голову, перестаёт быть
 * решением.
 */
export function placeCard(s: SimState, bet: number, owner: number, deadline: number): number {
  // Первые попытки идут с ПОЛНЫМ требованием к разносу, и только когда они
  // кончились, требование начинает падать. Порядок важен: пока честная точка
  // находится, раскладка обязана оставаться честной, а поблажка — оставаться
  // тем, чем она является, аварийным выходом.
  for (let attempt = 0; attempt < CARD.placeAttempts * 2; attempt++) {
    const x = add(fromUnits(60), fromUnits(nextInt(s.rng, Stream.Cards, unitsOf(s.arenaW) - 120)));
    const y = add(fromUnits(60), fromUnits(nextInt(s.rng, Stream.Cards, unitsOf(s.arenaH) - 120)));
    if (!isFreeSpot(s, x, y, CARD.radius)) continue;
    if (tooCrowded(s, x, y, spacingFor(attempt))) continue;

    return putCard(s, bet, owner, deadline, x, y);
  }

  /*
   * Случайные точки кончились — перебираем сетку.
   *
   * К RNG здесь не обращаемся, и причина не в детерминизме: он цел и так —
   * цикл случайных попыток выше уже тратит по два обращения на попытку, то
   * есть их число ЗАВИСИТ от того, сколько раз не повезло, и это нормально.
   * Поток `Cards` — чистая функция состояния, и одинаковое состояние даёт
   * одинаковое число обращений.
   *
   * Причина в другом: случайные точки кончились, и продолжать бросать их
   * бессмысленно — место либо есть, либо его нет. Фиксированный обход находит
   * его за один проход, если оно вообще существует, и не зависит от везения.
   */
  const step = fromUnits(CARD.placeScanStep);
  const floor = minSpacing();
  const x0 = add(ARENA_PAD, CARD.radius);
  const y0 = add(ARENA_PAD, CARD.radius);
  for (let y = y0; y <= sub(maxY(s), CARD.radius); y = add(y, step)) {
    for (let x = x0; x <= sub(maxX(s), CARD.radius); x = add(x, step)) {
      if (!isFreeSpot(s, x, y, CARD.radius)) continue;
      if (tooCrowded(s, x, y, floor)) continue;
      return putCard(s, bet, owner, deadline, x, y);
    }
  }

  // Свободного места нет вовсе — такого на аренах 0.3.0 не бывает, но карта
  // обязана лечь: «каждому хватает хотя бы на одну» (GDD §9.1) не имеет
  // оговорки «если повезло с геометрией».
  return putCard(
    s,
    bet,
    owner,
    deadline,
    clampX(s, s.arenaW >> 1, CARD.radius),
    clampY(s, s.arenaH >> 1, CARD.radius),
  );
}

/** Ближе этого карта не ложится ни при каких обстоятельствах: тела пересекутся. */
const minSpacing = (): Fx => add(CARD.radius, PLAYER.radius);

/**
 * Требование к разносу на попытке номер `attempt`.
 *
 * Держится полным, пока идут первые `placeAttempts` попыток, дальше падает на
 * четверть каждые восемь и упирается в сумму радиусов. Тридцать две неудачи
 * подряд означают, что арена забита картами и телами, а не что раскладке не
 * повезло, — и в этой ситуации карта, легшая теснее, лучше карты, не легшей
 * вовсе: без неё ломается несущее правило GDD §9.1.
 */
function spacingFor(attempt: number): Fx {
  if (attempt < CARD.placeAttempts) return CARD.minSpacing;
  const relaxed = CARD.minSpacing - (CARD.minSpacing >> 2) * ((attempt - CARD.placeAttempts) >> 3);
  const floor = minSpacing();
  return relaxed < floor ? floor : relaxed;
}

/**
 * Положить карту в названную точку.
 *
 * Отдельно от раскладки затем, что сценарию нужна ровно эта точка: «карта в
 * двух шагах справа» — проверяемое условие, а «карта где-то на арене» —
 * нет. Свободное место здесь не ищется намеренно: сценарий отвечает за то,
 * куда кладёт, и молчаливый сдвиг карты сделал бы его проверкой другого.
 */
export function putCard(
  s: SimState,
  bet: number,
  owner: number,
  deadline: number,
  x: Fx,
  y: Fx,
): number {
  for (let i = 0; i < MAX_CARDS; i++) {
    if (s.kActive[i]) continue;
    s.kX[i] = x;
    s.kY[i] = y;
    s.kBet[i] = bet;
    s.kOwner[i] = owner;
    s.kDeadline[i] = deadline;
    s.kActive[i] = 1;
    return i;
  }
  return -1;
}

const unitsOf = (v: Fx): number => v >> 16;
const fromUnits = (v: number): Fx => (v << 16) | 0;

function tooCrowded(s: SimState, x: Fx, y: Fx, spacing: Fx): boolean {
  for (let p = 0; p < s.playerCount; p++) {
    if (within(sub(x, s.pX[p]), sub(y, s.pY[p]), spacing)) return true;
  }
  for (let i = 0; i < MAX_CARDS; i++) {
    if (!s.kActive[i]) continue;
    if (within(sub(x, s.kX[i]), sub(y, s.kY[i]), spacing)) return true;
  }
  return false;
}

export function clearCards(s: SimState): void {
  s.kActive.fill(0);
}

// ---------------------------------------------------------------------------
// Подбор
// ---------------------------------------------------------------------------

/**
 * Попытка подобрать карту, на которой стоит игрок.
 *
 * Подбор — подтверждение кнопкой, а не касание (UX §2). Иначе уворот рывком
 * навязывал бы нежеланное пари и ломал бы «Не подбирай ничего»; заодно
 * дискретное событие даёт сети однозначное разрешение гонки за карту.
 *
 * Одновременный подбор разрешается детерминированно: побеждает меньшая
 * дистанция до центра карты, при равенстве — меньший номер игрока (TECH §7.4).
 * Здесь это выражено порядком обхода: игроки идут по возрастанию номера, и
 * первый, кто дотянулся, забирает карту в тот же тик.
 */
export function tryTakeCard(s: SimState, player: number): boolean {
  if ((s.pFlags[player] & EntityFlag.Alive) === 0) return false;
  if (activeCount(s, player) >= MAX_ACTIVE_BETS) return false;

  let best = -1;
  let bestDist = 0;
  for (let i = 0; i < MAX_CARDS; i++) {
    if (!s.kActive[i]) continue;
    // Чужую персональную взять нельзя: она и лежит для того, чтобы каждому
    // досталась хотя бы одна.
    if (s.kOwner[i] !== SHARED && s.kOwner[i] !== player) continue;
    const dx = sub(s.kX[i], s.pX[player]);
    const dy = sub(s.kY[i], s.pY[player]);
    if (!within(dx, dy, CARD.pickupRadius)) continue;
    const d = mul(dx, dx) + mul(dy, dy);
    if (best < 0 || d < bestDist) {
      best = i;
      bestDist = d;
    }
  }
  if (best < 0) return false;

  const stake = stakeFor(s, player);
  // Кон никогда не превышает кошелёк — Крупье в кредит не принимает. Нулевой
  // кошелёк не запрещает брать карту: пари на ноль ничего не стоит и ничего
  // не приносит, но и запрещать игроку рисковать нечем — запрет читался бы
  // как поломка.
  if (!takeBet(s, player, s.kBet[best], stake)) return false;

  s.pChips[player] -= stake;
  s.kActive[best] = 0;
  return true;
}

function activeCount(s: SimState, player: number): number {
  let n = 0;
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    if (s.aState[slot(player, i)] === BetState.Active) n++;
  }
  return n;
}

/** Завести активное пари. Публично: этим пользуются сценарии и отладка. */
export function takeBet(s: SimState, player: number, bet: number, stake: number): boolean {
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    const k = slot(player, i);
    if (s.aState[k] === BetState.Active) continue;
    s.aBet[k] = bet;
    s.aStake[k] = stake;
    s.aState[k] = BetState.Active;
    s.aCounter[k] = 0;
    s.aTakenAt[k] = s.tick;
    s.aThreatAt[k] = s.meta[Meta.ThreatCleared];
    s.meta[Meta.BetsTaken]++;
    // Комната, в которой брали пари: по ней Крупье считает, скучно ему или нет.
    s.meta[Meta.LastBetRoom] = s.meta[Meta.Room];
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Прогресс и обналичивание
// ---------------------------------------------------------------------------

/**
 * Доля пройденного под риском пути, `q ∈ [0, 1]` в Q16.16 (ECONOMY §9А).
 *
 * Начислять её за то, чего игрок ещё не сделал, нельзя: иначе «взять и сразу
 * забрать» становится безрисковой прибылью, а кнопка «Забрать» — обязательной.
 */
export function progressOf(s: SimState, player: number, n: number): Fx {
  const k = slot(player, n);
  if (s.aState[k] === BetState.None) return 0;
  const spec = BETS[s.aBet[k]];

  switch (spec.progress) {
    case BetProgress.Time: {
      const passed = s.tick - s.aTakenAt[k];
      return clamp01(div(fromUnits(passed), fromUnits(spec.limitTicks)));
    }
    case BetProgress.Counter:
      return clamp01(div(fromUnits(s.aCounter[k]), fromUnits(spec.target)));
    default: {
      // Удержания и пространственные: доля зачищенного бюджета угрозы комнаты,
      // считая от момента взятия. Пари, взятое в середине боя, не получает
      // прогресс за то, что было до него.
      const total = s.meta[Meta.RoomThreat] - s.aThreatAt[k];
      if (total <= 0) return 0;
      const done = s.meta[Meta.ThreatCleared] - s.aThreatAt[k];
      return clamp01(div(fromUnits(done), fromUnits(total)));
    }
  }
}

const clamp01 = (v: Fx): Fx => (v < 0 ? 0 : v > FX_ONE ? FX_ONE : v);

/**
 * Выплата за обналичивание: `кон × (1 + q × (M − 1) / 2)`.
 *
 * Половина причитавшейся прибыли — не произвольное число. Без привязки к
 * прогрессу «Забрать» вырождается: подобрать карту ×3 и тут же нажать кнопку
 * давало бы безрисковые +100% кона против +14% за честное удержание.
 */
export function cashOutValue(s: SimState, player: number, n: number): number {
  const k = slot(player, n);
  // За Ставку Крупье «Забрать» не платит ничего: кон чужой. Ноль здесь, а не
  // только в самой кнопке, потому что этим числом интерфейс подписывает
  // кнопку — и подписать её частью чужих денег он не имеет права.
  if (s.aStake[k] < 0) return 0;
  const spec = BETS[s.aBet[k]];
  const q = progressOf(s, player, n);
  const half = div(sub(spec.multiplier, FX_ONE), fromUnits(2));
  const factor = add(FX_ONE, mul(q, half));
  return Math.trunc((s.aStake[k] * factor) / FX_ONE);
}

/**
 * «Забрать»: обналичить своё пари досрочно.
 *
 * Обналичивается только личное пари — командные закрыть нельзя, в этом их риск
 * и причина повышенного множителя (GDD §9.1). Командных ставок в 0.3.0 ещё
 * нет, но правило заводится сразу: оно про то, чьё пари, а не про то, какие
 * бывают.
 */
export function cashOut(s: SimState, player: number, n: number): number {
  const k = slot(player, n);
  if (s.aState[k] !== BetState.Active) return 0;
  // Ставку Крупье не обналичить: «Забрать» возвращает СВОЙ кон с долей прибыли,
  // а этот кон не твой. Соскочить с чужой ставки, забрав часть чужих денег, —
  // не досрочный расчёт, а печатный станок.
  if (s.aStake[k] < 0) return 0;
  const payout = cashOutValue(s, player, n);
  s.pChips[player] += payout;
  s.aState[k] = BetState.Cashed;
  s.meta[Meta.BetsCashed]++;
  // Соскочил в шаге от полной выплаты — молчаливый палец вниз.
  if (progressOf(s, player, n) * 100 >= FX_ONE * CARD.cashOutTellPct) {
    gesture(s, AceGesture.ThumbsDown);
  }
  return payout;
}

/** Обналичить самое выгодное из активных пари: кнопка одна, пари несколько. */
export function cashOutBest(s: SimState, player: number): number {
  let best = -1;
  let bestValue = 0;
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    if (s.aState[slot(player, i)] !== BetState.Active) continue;
    // Ставка Крупье обналичиванию не подлежит — и в выбор «самого выгодного»
    // не входит: иначе одна кнопка молча пропускала бы ход.
    if (s.aStake[slot(player, i)] < 0) continue;
    const v = cashOutValue(s, player, i);
    if (best < 0 || v > bestValue) {
      best = i;
      bestValue = v;
    }
  }
  return best < 0 ? 0 : cashOut(s, player, best);
}

// ---------------------------------------------------------------------------
// Условия пари
// ---------------------------------------------------------------------------

/**
 * Сорвать пари: хук детекции из каталога (GDD §9.5).
 *
 * Пари называется НОМЕРОМ, а не строкой. Хуки зовутся каждый тик и на каждом
 * игроке — «не заходи в красную зону» проверяется, пока игрок стоит в ней, —
 * и сравнение строк там стоит дороже самой проверки. Числовые
 * идентификаторы, кроме того, механически переводятся в C# при возможном
 * порте ядра (TECH §4).
 */
export function failBetId(s: SimState, player: number, bet: BetId): void {
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    const k = slot(player, i);
    if (s.aState[k] !== BetState.Active) continue;
    if (s.aBet[k] !== bet) continue;
    loseBet(s, player, i);
  }
}

/**
 * То же по строковому идентификатору — для сценариев, отладки и тестов.
 *
 * Тонкая обёртка и ничего больше: в горячем пути ей делать нечего, поиск идёт
 * по таблице, построенной один раз при загрузке модуля.
 */
export function failBet(s: SimState, player: number, id: string): void {
  const bet = betIdOf(id);
  if (bet >= 0) failBetId(s, player, bet);
}

/** Номер пари по строковому идентификатору, −1 — такого пари нет. */
export function betIdOf(id: string): number {
  const bet = BET_INDEX.get(id);
  return bet === undefined ? -1 : bet;
}

/** Таблица строится один раз: в тике ей делать нечего. */
const BET_INDEX = new Map<string, number>(BETS.map((b, i) => [b.id, i]));

/**
 * Проиграть пари, запомнив, насколько близко было.
 *
 * Прогресс снимается ЗДЕСЬ, а не на экране расчёта: к расчёту зачищенная
 * угроза уже другая, счётчик обнулён, и «не хватило четырёх секунд»
 * восстановить будет неоткуда.
 *
 * Счётчик проигранных тоже растёт здесь, и это единственное место, где он
 * растёт. Пока его вёл один расчёт комнаты, пари, сорванные по ходу боя,
 * в статистику не попадали вовсе: `BetsTaken` переставал сходиться с суммой
 * исходов, а на этих числах стоят ограничители G6/G10/G14 и отчёт раннера —
 * то есть врал не счётчик, а весь балансный контур.
 */
function loseBet(s: SimState, player: number, n: number): void {
  const k = slot(player, n);
  s.aNearMiss[k] = progressOf(s, player, n);
  s.aState[k] = BetState.Lost;
  s.meta[Meta.BetsLost]++;
  // Выиграл Крупье — забирает эквивалент из кошелька игрока. У обычного пари кон
  // списан ещё при подборе, и здесь не происходит ничего.
  payAce(s, player, k);
  gesture(s, AceGesture.Applaud);
}

/**
 * Поставить жест Крупье.
 *
 * Жесты за счёт игрока — аплодисменты провалу, палец вниз, овация нелепой
 * смерти — молча пропускаются, пока идёт серия смертей. Это не мягкость:
 * после третьей смерти подряд издёвка перестаёт читаться как шутка и
 * становится поводом закрыть игру (GDD §17А, границы).
 *
 * Жест не перебивает жест: начатое дочитывается до конца, иначе на бурном
 * тике Крупье дёргается кадр и не показывает ничего.
 */
function gesture(s: SimState, g: AceGesture): void {
  if (s.tick < s.meta[Meta.AceGestureUntil]) return;
  /*
   * Дозировка: жесты за счёт игрока пропускаются, пока идёт серия смертей.
   *
   * Это не мягкость. После третьей смерти подряд издёвка перестаёт читаться
   * как шутка и становится поводом закрыть игру (GDD §17А, границы). Проверка
   * стоит ДО выхода на арену: приходить, чтобы промолчать, — худший из
   * возможных вариантов, он превращает Крупье в декорацию именно в тот момент,
   * когда игроку и без него плохо.
   */
  const mocking =
    g === AceGesture.Applaud || g === AceGesture.ThumbsDown || g === AceGesture.Ovation;
  if (mocking && s.meta[Meta.DeathStreak] >= CARD.mercyDeathStreak) return;

  /*
   * Тела на арене нет — значит, надо прийти.
   *
   * Реплика без актёра превратилась бы в закадровый голос, которым Крупье по
   * замыслу не является: юмор играется телом (GDD §17А). Но и молчать нельзя —
   * пока `gesture()` просто выходил при пустой арене, четыре жеста из шести
   * не срабатывали ни разу за пять минут игры. Поэтому событие, достойное
   * реакции, приводит его самого — с тем же телеграфом, что у подброса.
   */
  if (s.meta[Meta.AceX] === 0) {
    moodCameo(s, g);
    return;
  }
  s.meta[Meta.AceGesture] = g;
  s.meta[Meta.AceGestureUntil] = s.tick + CARD.gestureTicks;
}

/**
 * Жесты, которые не привязаны к событию, а следуют из положения дел.
 *
 * Считаются каждый тик из состояния и потому переигрываются вместе с боем.
 * Порядок — приоритет: скука перекрывается всем, что происходит на самом деле.
 */
function stepGestures(s: SimState): void {
  if (s.tick < s.meta[Meta.AceGestureUntil]) return;
  s.meta[Meta.AceGesture] = AceGesture.None;
  /*
   * Эти жесты играются, только пока он УЖЕ на арене, и ради них он не выходит.
   *
   * Зевок, отворачивание и суета — не реакция на событие, а то, чем занят
   * стоящий рядом человек: они верны всё время, пока верно положение дел.
   * Дай им звать его — и первое же затянувшееся состояние потратит
   * единственный выход «на настроение», после чего аплодисменты провалу и
   * овация нелепой смерти не случатся уже никогда. Замер показал ровно это:
   * присутствие выросло, а видов жестов стало ОДИН из шести вместо двух.
   * Выход стоит тратить на событие, а не на фон.
   */
  if (s.meta[Meta.AceX] === 0) return;

  // Игрок вот-вот сорвёт куш — Крупье отворачивается и делает вид, что занят.
  for (let p = 0; p < s.playerCount; p++) {
    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      const k = slot(p, i);
      if (s.aState[k] !== BetState.Active) continue;
      if (progressOf(s, p, i) * 100 >= FX_ONE * CARD.turnAwayPct) {
        gesture(s, AceGesture.TurnAway);
        return;
      }
    }
  }

  // Третья комната вхолостую: карты лежат, игрок мимо. Демонстративная скука.
  if (s.meta[Meta.Room] - s.meta[Meta.LastBetRoom] >= CARD.boredomRooms) {
    gesture(s, AceGesture.Yawn);
    return;
  }

  // Игрок в плюсе по сальдо — заведение нервничает.
  let chipsTotal = 0;
  for (let p = 0; p < s.playerCount; p++) chipsTotal += s.pChips[p];
  if (s.meta[Meta.BetsWon] + s.meta[Meta.BetsCashed] > s.meta[Meta.BetsLost] && chipsTotal > 0) {
    gesture(s, AceGesture.Fidget);
  }
}

/** Игрок погиб особенно нелепо — стоя в шаге от выигрыша. */
export function aceOnDeath(s: SimState, player: number): void {
  s.meta[Meta.DeathStreak]++;
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    const k = slot(player, i);
    if (s.aState[k] !== BetState.Active) continue;
    // Порог тот же, что у «соскочил на самом краю»: овация — это реакция на
    // потерю почти выигранного, и «почти» здесь обязано значить то же самое,
    // что при обналичивании. Разные числа означали бы, что одна и та же
    // близость к кушу считается близкой или нет в зависимости от того, чем
    // всё кончилось.
    if (progressOf(s, player, i) * 100 >= FX_ONE * CARD.cashOutTellPct) {
      s.meta[Meta.AceGestureUntil] = 0;
      gesture(s, AceGesture.Ovation);
      return;
    }
  }
}

/** Продвинуть счётчиковое пари. Выполнение проверяется на расчёте. */
export function advanceBetId(s: SimState, player: number, bet: BetId, by = 1): void {
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    const k = slot(player, i);
    if (s.aState[k] !== BetState.Active) continue;
    if (s.aBet[k] !== bet) continue;
    s.aCounter[k] += by;
  }
}

/** То же по строковому идентификатору — для сценариев и отладки. */
export function advanceBet(s: SimState, player: number, id: string, by = 1): void {
  const bet = betIdOf(id);
  if (bet >= 0) advanceBetId(s, player, bet, by);
}

/**
 * Рассчитать пари погибшего — ПО СОСТОЯНИЮ НА МОМЕНТ ГИБЕЛИ.
 *
 * «Мёртвый не выигрывает ничего»: комнату он не прошёл, а пари проверяют, КАК
 * он её пройдёт. Раньше это правило держал один расчёт комнаты, и держал оно
 * его через флаг «жив» — а перезапуск забега ставит этот флаг обратно ДО
 * расчёта. В итоге пари, оставшиеся активными в момент смерти, при следующем
 * старте засчитывались как выигранные: тот самый печатный станок, который
 * расчёт и был призван закрыть.
 *
 * Лечится это здесь, а не порядком вызовов в перезапуске: расчёт по флагу
 * зависит от того, когда его позвали, а расчёт в момент смерти — ни от чего.
 * Заодно near-miss снимается там, где ему и место: «не хватило четырёх
 * секунд» считается от последнего живого тика, а не от старта новой комнаты.
 */
export function loseBetsOnDeath(s: SimState, player: number): void {
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    if (s.aState[slot(player, i)] !== BetState.Active) continue;
    loseBet(s, player, i);
  }
}

/**
 * Условия, которые проверяются каждый тик, а не событием.
 *
 * Их всего два, и оба про положение: красная зона и истёкшее время. Остальные
 * пари срываются событиями — уроном, рывком, пропавшей фишкой, — и ловятся
 * там, где эти события происходят.
 */
export function stepBets(s: SimState): void {
  for (let p = 0; p < s.playerCount; p++) {
    if ((s.pFlags[p] & EntityFlag.Alive) === 0) continue;

    if (inRedZone(s, p)) failBetId(s, p, BetId.NoRedZone);

    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      const k = slot(p, i);
      if (s.aState[k] !== BetState.Active) continue;
      const spec = BETS[s.aBet[k]];
      // Темповое пари срывается само, когда время вышло: near-miss на экране
      // расчёта показывает, насколько не хватило.
      if (spec.progress === BetProgress.Time && s.tick - s.aTakenAt[k] > spec.limitTicks) {
        loseBet(s, p, i);
      }
    }
  }

  stepCards(s);
  stepAce(s);
  stepGestures(s);
}

/**
 * Стоит ли игрок в красной зоне.
 *
 * На боссовой арене её нет вовсе (GDD §8.1), и «нет зоны» обязано означать
 * «в неё нельзя войти», а не «круг не нарисован»: иначе пари срывалось бы о
 * разметку, которой на полу не существует.
 */
export const inRedZone = (s: SimState, player: number): boolean =>
  s.meta[Meta.Phase] !== RunPhase.Boss &&
  within(sub(s.pX[player], redZoneX(s)), sub(s.pY[player], redZoneY(s)), RED_ZONE_RADIUS);

/** Карты тают. Луч гаснет за три секунды до конца — предупреждение без HUD. */
function stepCards(s: SimState): void {
  for (let i = 0; i < MAX_CARDS; i++) {
    if (!s.kActive[i]) continue;
    if (s.tick >= s.kDeadline[i]) s.kActive[i] = 0;
  }
}

/**
 * Расчёт в конце комнаты.
 *
 * Всё, что дожило активным, засчитывается: пари проверяют, как игрок прошёл
 * комнату, а комната пройдена. Счётчиковые проверяются по цели, остальные — по
 * тому, что их никто не сорвал.
 *
 * **Мёртвый не выигрывает ничего.** Комнату он не прошёл, а значит и пари на
 * то, КАК он её пройдёт, не выполнено — включая «Без урона», которое иначе
 * засчитывалось бы игроку, погибшему от урона. Дефект нашёлся жадным ботом:
 * доля успеха выходила 0.73 против целевых 38–55% из ECONOMY §2, то есть
 * ставки превращались в печатный станок ровно в тех забегах, где игрок
 * проигрывал.
 *
 * Пари погибшего сюда, как правило, уже не доходят: они рассчитываются в
 * момент гибели (`loseBetsOnDeath`), потому что флаг «жив» к началу следующей
 * комнаты успевает вернуться. Проверка по флагу остаётся вторым рубежом — на
 * случай смерти, пришедшей не через урон.
 */
export function settleBets(s: SimState): void {
  for (let p = 0; p < s.playerCount; p++) {
    const alive = (s.pFlags[p] & EntityFlag.Alive) !== 0;
    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      const k = slot(p, i);
      if (s.aState[k] !== BetState.Active) continue;
      const spec = BETS[s.aBet[k]];

      const won =
        alive && (spec.progress === BetProgress.Counter ? s.aCounter[k] >= spec.target : true);
      if (won) {
        s.aState[k] = BetState.Won;
        /*
         * Выплата Ставки Крупье — ОДИН К ОДНОМУ и из его кармана (ECONOMY §10А).
         *
         * Не кон × множитель: множитель каталога посчитан для пари, где кон
         * уже списан с игрока и возвращается вместе с прибылью. Здесь кон не
         * списывался ни с кого, и та же формула отдала бы игроку тройную
         * сумму за пари, в которое он не вложил ничего.
         */
        const ace = -s.aStake[k];
        s.pChips[p] += ace > 0 ? ace : Math.trunc((s.aStake[k] * spec.multiplier) / FX_ONE);
        s.meta[Meta.BetsWon]++;
      } else {
        loseBet(s, p, i);
        /*
         * Провал обязывает следующий стол содержать трамплин (GDD §11).
         *
         * Отметка ставится здесь, в момент расчёта, а не при раздаче: между
         * ними целый экран двери, и намерение, не записанное в состояние, до
         * раздачи не доживает. Спираль неудач запрещена дизайном, но трамплин
         * остаётся ПАРИ — кон платит игрок, иначе двенадцать проваленных
         * ставок за забег превращаются в двенадцать подарков тому, кого доля
         * заведения должна прижимать.
         */
        markLegUp(s);
      }
    }
  }
}

/** Освободить слоты: новая комната — новые пари. */
/**
 * Убрать разрешённые пари, не трогая живые.
 *
 * Разница не косметическая. Карты новой комнаты лежат уже во время расчёта, и
 * игрок вправе взять одну, пока читает итоги прошлой, — а бой начинается
 * через пять секунд. Полная очистка на первой волне съедала бы именно такое
 * пари: взял, побежал, а его нет.
 */
export function clearSettled(s: SimState): void {
  for (let k = 0; k < s.playerCount * MAX_ACTIVE_BETS; k++) {
    if (s.aState[k] === BetState.Active) continue;
    s.aState[k] = BetState.None;
    s.aCounter[k] = 0;
    s.aStake[k] = 0;
    s.aNearMiss[k] = 0;
  }
}

/**
 * Насколько близко было к победе, `q` в Q16.16.
 *
 * Для проигранного — снимок на момент срыва, для остальных — текущий
 * прогресс. Экран расчёта показывает по нему «не хватило четырёх секунд».
 */
export function nearMissOf(s: SimState, player: number, n: number): Fx {
  const k = slot(player, n);
  return s.aState[k] === BetState.Lost ? s.aNearMiss[k] : progressOf(s, player, n);
}

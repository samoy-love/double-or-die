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
 * Кон списывается в момент подбора и никогда не превышает кошелёк: Туз в
 * кредит не принимает, и поэтому провал пари не создаёт долга (GDD §11).
 */

import { clampX, clampY, isFreeSpot, maxX, maxY } from './arena';
import { BET_COUNT, BETS, BetId, BetProgress, type BetSpec } from './bets.generated';
import { APPETITE, ARENA_PAD, CARD, MAX_ACTIVE_BETS, PLAYER, RED_ZONE } from './config';
import { add, div, FX_ONE, type Fx, mul, sub } from './fixed';
import { Stream, nextInt } from './rng';
import { AceGesture, BetState, EntityFlag, MAX_CARDS, Meta, type SimState } from './state';
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

export const betAt = (index: number): BetSpec => BETS[index];

/** Слот активного пари игрока `p` под номером `n`. */
const slot = (p: number, n: number): number => p * MAX_ACTIVE_BETS + n;

/** Размер кона по выбранному аппетиту, но не больше кошелька. */
export function stakeFor(s: SimState, player: number): number {
  const tier = Math.min(APPETITE.length - 1, Math.max(0, s.pAppetite[player]));
  return Math.min(APPETITE[tier], s.pChips[player]);
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

  const total = Math.min(MAX_CARDS, s.playerCount + CARD.extraCards);
  for (let i = 0; i < total; i++) {
    const owner = i < s.playerCount ? i : SHARED;
    placeCard(s, pickBet(s, owner), owner, s.tick + CARD.lifeTicks);
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
    placeCard(s, pickBet(s, p), p, s.tick + CARD.lifeTicks);
  }

  // Туз подбрасывает карту в середине схватки: решения перестают быть
  // разовыми и превращаются в поток. Момент — по зачищенной угрозе, а не по
  // таймеру: середина боя это половина комнаты, а не полторы минуты.
  s.meta[Meta.TossAt] = 0;
  s.meta[Meta.AceX] = 0;
  s.meta[Meta.AceY] = 0;
  s.meta[Meta.AceLeaveAt] = 0;
}

function hasCardFor(s: SimState, player: number): boolean {
  for (let i = 0; i < MAX_CARDS; i++) {
    if (s.kActive[i] && s.kOwner[i] === player) return true;
  }
  return false;
}

/**
 * Туз на арене: приходит к середине боя и бросает карту.
 *
 * Он не мешает бою — не коллизится, неуязвим, рисуется ниже боевых сущностей
 * (GDD §12А.1). Злорадство даётся отзывчивостью, а не хитбоксом: перекрывать
 * обзор в игре, где читаемость объявлена столпом, недопустимо.
 *
 * Точка подброса — ЧИСТАЯ ФУНКЦИЯ от состояния, а не обращение к общему RNG
 * (TECH §2.3): «Туз кладёт карту в опасное место» обязано воспроизводиться в
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
   * (GDD §12А.1, §17А). Место ухода помечается −1, а не нулём: обнулённая
   * позиция иначе читалась бы как «он ещё не приходил», и подбросов за
   * комнату стало бы сколько угодно.
   */
  if (leaveAt > 0 && s.tick >= leaveAt) {
    s.meta[Meta.AceX] = 0;
    s.meta[Meta.AceY] = 0;
    s.meta[Meta.AceLeaveAt] = -1;
    s.meta[Meta.AceGesture] = AceGesture.None;
    s.meta[Meta.AceGestureUntil] = 0;
    return;
  }

  // Уже объявил — ждём конца телеграфа и бросаем.
  if (s.meta[Meta.TossAt] !== 0) {
    if (s.tick < s.meta[Meta.TossAt]) return;
    s.meta[Meta.TossAt] = 0;
    placeCard(s, pickBet(s, SHARED), SHARED, s.tick + CARD.lifeTicks);
    return;
  }

  // Один подброс за комнату, ровно на середине зачищенной угрозы.
  if (leaveAt !== 0) return;
  const total = s.meta[Meta.RoomThreat];
  if (total <= 0) return;
  if (s.meta[Meta.ThreatCleared] * 100 < total * CARD.tossAtThreatPct) return;

  /*
   * Точка стояния — чистая функция от положения ВСЕХ живых игроков.
   *
   * Считать её по игроку 0 нельзя даже в соло, где это работает случайно: в
   * коопе «дальняя стена» первого игрока бывает ближней для четвёртого, и Туз
   * вставал бы посреди чужого боя — то есть ровно там, где обещано, что его
   * не будет. Центр масс живых даёт одну точку на всю команду и не зависит
   * от нумерации.
   */
  let alive = 0;
  let sumX = 0;
  let sumY = 0;
  for (let p = 0; p < s.playerCount; p++) {
    if ((s.pFlags[p] & EntityFlag.Alive) === 0) continue;
    sumX += s.pX[p];
    sumY += s.pY[p];
    alive++;
  }
  if (alive === 0) return;
  const midX = Math.trunc(sumX / alive) | 0;
  const midY = Math.trunc(sumY / alive) | 0;

  // Встаёт у края — там, куда команда смотрит меньше всего: у дальней от неё
  // стены по горизонтали и на её же высоте.
  const far = midX > s.arenaW >> 1 ? fromUnits(90) : sub(s.arenaW, fromUnits(90));
  s.meta[Meta.AceX] = far;
  s.meta[Meta.AceY] = midY;
  s.meta[Meta.TossAt] = s.tick + CARD.aceTelegraphTicks;
  s.meta[Meta.AceLeaveAt] = s.tick + CARD.aceTelegraphTicks + CARD.aceStayTicks;
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
 * раскладка идёт в начале комнаты, а подброс Туза — прямо посреди боя, и
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
    if (free === 0) return 0;
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
 */
function schemeBlocked(s: SimState, bet: number, owner: number): boolean {
  const mask = BETS[bet].schemeMask;
  if (mask === 0) return false;
  if (owner !== SHARED) return (mask & (1 << s.pScheme[owner])) !== 0;
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
   * К RNG здесь не обращаемся намеренно: число обращений к потоку `Cards`
   * иначе зависело бы от того, сколько раз не повезло, и раскладка перестала
   * бы воспроизводиться в реплее. Порядок обхода фиксирован, поэтому результат
   * — чистая функция от геометрии и от того, что уже лежит.
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
  // Кон никогда не превышает кошелёк — Туз в кредит не принимает. Нулевой
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
    // Комната, в которой брали пари: по ней Туз считает, скучно ему или нет.
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
  const payout = cashOutValue(s, player, n);
  s.pChips[player] += payout;
  s.aState[k] = BetState.Cashed;
  s.meta[Meta.BetsCashed]++;
  // Соскочил в шаге от полной выплаты — молчаливый палец вниз.
  if (progressOf(s, player, n) * 100 >= FX_ONE * CARD.bigWinPct) {
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
  gesture(s, AceGesture.Applaud);
}

/**
 * Поставить жест Тузу.
 *
 * Жесты за счёт игрока — аплодисменты провалу, палец вниз, овация нелепой
 * смерти — молча пропускаются, пока идёт серия смертей. Это не мягкость:
 * после третьей смерти подряд издёвка перестаёт читаться как шутка и
 * становится поводом закрыть игру (GDD §17А, границы).
 *
 * Жест не перебивает жест: начатое дочитывается до конца, иначе на бурном
 * тике Туз дёргается кадр и не показывает ничего.
 */
function gesture(s: SimState, g: AceGesture): void {
  // Пустой арены это не касается: жест — это то, что делает тело, а тела на
  // арене нет. Реплика без актёра превратилась бы в закадровый голос, которым
  // Туз по замыслу не является.
  if (s.meta[Meta.AceX] === 0) return;
  if (s.tick < s.meta[Meta.AceGestureUntil]) return;
  const мимо =
    s.meta[Meta.DeathStreak] >= CARD.mercyDeathStreak &&
    (g === AceGesture.Applaud || g === AceGesture.ThumbsDown || g === AceGesture.Ovation);
  if (мимо) return;
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
  if (s.meta[Meta.AceX] === 0) return;

  // Игрок вот-вот сорвёт куш — Туз отворачивается и делает вид, что занят.
  for (let p = 0; p < s.playerCount; p++) {
    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      const k = slot(p, i);
      if (s.aState[k] !== BetState.Active) continue;
      if (progressOf(s, p, i) * 100 >= FX_ONE * CARD.bigWinPct) {
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
  let выиграно = 0;
  for (let p = 0; p < s.playerCount; p++) выиграно += s.pChips[p];
  if (s.meta[Meta.BetsWon] + s.meta[Meta.BetsCashed] > s.meta[Meta.BetsLost] && выиграно > 0) {
    gesture(s, AceGesture.Fidget);
  }
}

/** Игрок погиб особенно нелепо — стоя в шаге от выигрыша. */
export function aceOnDeath(s: SimState, player: number): void {
  s.meta[Meta.DeathStreak]++;
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    const k = slot(player, i);
    if (s.aState[k] !== BetState.Active) continue;
    if (progressOf(s, player, i) * 100 >= FX_ONE * CARD.bigWinPct) {
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

export const inRedZone = (s: SimState, player: number): boolean =>
  within(sub(s.pX[player], RED_ZONE.x), sub(s.pY[player], RED_ZONE.y), RED_ZONE.radius);

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
        s.pChips[p] += Math.trunc((s.aStake[k] * spec.multiplier) / FX_ONE);
        s.meta[Meta.BetsWon]++;
      } else {
        loseBet(s, p, i);
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

export function clearBets(s: SimState): void {
  for (let p = 0; p < s.playerCount * MAX_ACTIVE_BETS; p++) {
    s.aState[p] = BetState.None;
    s.aCounter[p] = 0;
    s.aStake[p] = 0;
    s.aNearMiss[p] = 0;
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

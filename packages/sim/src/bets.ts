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

import { isFreeSpot } from './arena';
import { BETS, BetProgress, type BetSpec } from './bets.generated';
import { APPETITE, CARD, MAX_ACTIVE_BETS, RED_ZONE } from './config';
import { add, div, FX_ONE, type Fx, mul, sub } from './fixed';
import { Stream, nextInt } from './rng';
import { BetState, EntityFlag, MAX_CARDS, Meta, type SimState } from './state';
import { within } from './trig';

export { BETS, BetProgress, BetCategory, type BetSpec } from './bets.generated';

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
    placeCard(s, pickBet(s), owner, s.tick + CARD.lifeTicks);
  }

  // Туз подбрасывает карту в середине схватки: решения перестают быть
  // разовыми и превращаются в поток. Момент — по зачищенной угрозе, а не по
  // таймеру: середина боя это половина комнаты, а не полторы минуты.
  s.meta[Meta.TossAt] = 0;
}

/**
 * Выбрать пари для карты.
 *
 * Конфликтующие вместе не выпадают: матрица конфликтов — данные, и здесь она
 * только применяется. Пари, уже лежащее на арене или взятое кем-то, второй раз
 * не выдаётся — иначе стол вырождается в четыре одинаковые карты.
 */
function pickBet(s: SimState): number {
  const free: number[] = [];
  for (let b = 0; b < BETS.length; b++) {
    if (!betAvailable(s, b)) continue;
    free.push(b);
  }
  if (free.length === 0) return nextInt(s.rng, Stream.Bets, BETS.length);
  return free[nextInt(s.rng, Stream.Bets, free.length)];
}

function betAvailable(s: SimState, bet: number): boolean {
  const spec = BETS[bet];

  for (let i = 0; i < MAX_CARDS; i++) {
    if (!s.kActive[i]) continue;
    if (s.kBet[i] === bet) return false;
    if (spec.conflicts.includes(BETS[s.kBet[i]].id)) return false;
  }
  for (let i = 0; i < s.playerCount * MAX_ACTIVE_BETS; i++) {
    if (s.aState[i] !== BetState.Active) continue;
    if (s.aBet[i] === bet) return false;
    if (spec.conflicts.includes(BETS[s.aBet[i]].id)) return false;
  }
  return true;
}

/**
 * Положить карту в свободное место.
 *
 * «Раскладка честная»: карты разносятся по арене и не ложатся ни друг на
 * друга, ни под ноги игроку — иначе один игрок систематически оказывается
 * ближе к лучшей карте, а в соло карта, упавшая на голову, перестаёт быть
 * решением.
 */
export function placeCard(s: SimState, bet: number, owner: number, deadline: number): number {
  for (let attempt = 0; attempt < 32; attempt++) {
    const x = add(fromUnits(60), fromUnits(nextInt(s.rng, Stream.Cards, unitsOf(s.arenaW) - 120)));
    const y = add(fromUnits(60), fromUnits(nextInt(s.rng, Stream.Cards, unitsOf(s.arenaH) - 120)));
    if (!isFreeSpot(s, x, y, CARD.radius)) continue;
    if (tooCrowded(s, x, y)) continue;

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
  return -1;
}

const unitsOf = (v: Fx): number => v >> 16;
const fromUnits = (v: number): Fx => (v << 16) | 0;

function tooCrowded(s: SimState, x: Fx, y: Fx): boolean {
  for (let p = 0; p < s.playerCount; p++) {
    if (within(sub(x, s.pX[p]), sub(y, s.pY[p]), CARD.minSpacing)) return true;
  }
  for (let i = 0; i < MAX_CARDS; i++) {
    if (!s.kActive[i]) continue;
    if (within(sub(x, s.kX[i]), sub(y, s.kY[i]), CARD.minSpacing)) return true;
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

/** Сорвать пари по идентификатору: хук детекции из каталога (GDD §9.5). */
export function failBet(s: SimState, player: number, id: string): void {
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    const k = slot(player, i);
    if (s.aState[k] !== BetState.Active) continue;
    if (BETS[s.aBet[k]].id !== id) continue;
    s.aState[k] = BetState.Lost;
  }
}

/** Продвинуть счётчиковое пари. Выполнение проверяется на расчёте. */
export function advanceBet(s: SimState, player: number, id: string, by = 1): void {
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    const k = slot(player, i);
    if (s.aState[k] !== BetState.Active) continue;
    if (BETS[s.aBet[k]].id !== id) continue;
    s.aCounter[k] += by;
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

    if (inRedZone(s, p)) failBet(s, p, 'no_red_zone');

    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      const k = slot(p, i);
      if (s.aState[k] !== BetState.Active) continue;
      const spec = BETS[s.aBet[k]];
      // Темповое пари срывается само, когда время вышло: near-miss на экране
      // расчёта показывает, насколько не хватило.
      if (spec.progress === BetProgress.Time && s.tick - s.aTakenAt[k] > spec.limitTicks) {
        s.aState[k] = BetState.Lost;
      }
    }
  }

  stepCards(s);
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
 */
export function settleBets(s: SimState): void {
  for (let p = 0; p < s.playerCount; p++) {
    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      const k = slot(p, i);
      if (s.aState[k] !== BetState.Active) continue;
      const spec = BETS[s.aBet[k]];

      const won = spec.progress === BetProgress.Counter ? s.aCounter[k] >= spec.target : true;
      if (won) {
        s.aState[k] = BetState.Won;
        s.pChips[p] += Math.trunc((s.aStake[k] * spec.multiplier) / FX_ONE);
        s.meta[Meta.BetsWon]++;
      } else {
        s.aState[k] = BetState.Lost;
        s.meta[Meta.BetsLost]++;
      }
    }
  }
}

/** Освободить слоты: новая комната — новые пари. */
export function clearBets(s: SimState): void {
  for (let p = 0; p < s.playerCount * MAX_ACTIVE_BETS; p++) {
    if (s.aState[p] === BetState.Lost) s.meta[Meta.BetsLost]++;
    s.aState[p] = BetState.None;
    s.aCounter[p] = 0;
    s.aStake[p] = 0;
  }
}

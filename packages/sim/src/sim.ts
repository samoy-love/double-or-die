/**
 * Тик симуляции.
 *
 * Чистая функция от состояния и кадров ввода: одинаковый вход даёт одинаковый
 * выход на любой платформе. Ни `window`, ни `Date.now()`, ни `Math.random()`
 * здесь быть не может — это ловит линтер, а не совесть.
 *
 * Здесь же — рамка забега: он кончается победой на третьем этаже или смертью,
 * и в обоих случаях кончается ЯВНО. До 0.4.0 смерть тихо начинала забег
 * заново, и у забега не было ни итогов, ни ключей, ни причины вернуться.
 */

import { pushOutOfColumns, pushedX, pushedY } from './arena';
import {
  PISTOL,
  PLAYER,
  RESTART_DELAY_TICKS,
  START_CHIPS,
  START_SPREAD,
  WAVE,
  roomGapTicksFor,
} from './config';
import { BetId, cashOutBest, failBetId, stepBets, tryTakeCard } from './bets';
import { stepBoss } from './boss';
import { fire, stepBullets, stepChips } from './combat';
import { clearArena, startRoom, stepEnemies } from './enemies';
import { add, FX_ONE, mul, sub } from './fixed';
import { endRun } from './run';
import { normalize, normX, normY, within } from './trig';
import { type InputFrame, Btn, appetiteOf, isDown, schemeOf } from './input';
import { Curse, DoorType, EntityFlag, Meta, RunPhase, type SimState } from './state';

/** Поставить игроков в стартовые позиции и начать первую комнату. */
export function spawnPlayers(s: SimState): void {
  const cx = s.arenaW >> 1;
  const cy = s.arenaH >> 1;
  const spread = START_SPREAD;

  for (let i = 0; i < s.playerCount; i++) {
    // Раскладка по кругу, детерминированная: без обращения к RNG.
    const offX = i === 0 || i === 3 ? -spread : spread;
    const offY = i < 2 ? -spread : spread;
    s.pX[i] = s.playerCount === 1 ? cx : add(cx, offX);
    s.pY[i] = s.playerCount === 1 ? cy : add(cy, offY);
    s.pVX[i] = 0;
    s.pVY[i] = 0;
    s.pAimX[i] = FX_ONE;
    s.pAimY[i] = 0;
    s.pHearts[i] = PLAYER.startHearts;
    s.pFlags[i] = EntityFlag.Alive;
    s.pInvulUntil[i] = 0;
    s.pDashReady[i] = 0;
    s.pDashUntil[i] = 0;
    s.pRagdollUntil[i] = 0;
    // Оружие готово с первого тика: игрок появляется на арене, где уже есть
    // враги, и «первый выстрел через десять тиков» ощущается осечкой.
    s.pShotAcc[i] = PLAYER.shotReserve * FX_ONE;
    // Стартовый капитал выдаётся ЗДЕСЬ, а не при создании состояния, и это
    // важно: эта же функция перезапускает забег после гибели всех. Кошелёк,
    // выданный один раз, оставил бы воскресшего нищим — то есть без ставок,
    // ради которых он и вернулся (ECONOMY §4).
    s.pChips[i] = START_CHIPS;
  }

  s.meta[Meta.SeenTypes] = 0;
  s.meta[Meta.Kills] = 0;
  s.meta[Meta.RestartAt] = 0;

  /*
   * Забег как целое: этаж, фаза, экономика и босс.
   *
   * Обнуляется здесь, а не при создании состояния, по той же причине, что и
   * кошелёк: эта функция ещё и перезапускает забег после гибели всех. Долг,
   * проклятие и купленные апгрейды, пережившие смерть, означали бы, что новый
   * забег начинается с чужого хвоста, — а забег обязан начинаться с нуля,
   * иначе ни сид, ни реплей не описывают его целиком.
   *
   * Большая часть этих полей в 0.4.0 ещё никем не читается: раскладка
   * заведена разом, чтобы ре-бейзлайн эталонов случился один раз, а не по
   * разу на каждую доехавшую механику.
   */
  s.meta[Meta.Floor] = 1;
  s.meta[Meta.Phase] = RunPhase.Fight;
  s.meta[Meta.PhaseUntil] = 0;
  s.meta[Meta.RoomType] = DoorType.Fight;
  s.meta[Meta.DoorPick] = -1;
  s.meta[Meta.Debt] = 0;
  s.meta[Meta.Curse] = Curse.None;
  s.meta[Meta.CurseRoom] = 0;
  s.meta[Meta.HouseCut] = 0;
  s.meta[Meta.LegUp] = 0;
  s.meta[Meta.Template] = 0;
  s.meta[Meta.Flip] = 0;
  s.meta[Meta.BossHP] = 0;
  s.meta[Meta.BossMaxHP] = 0;
  s.meta[Meta.BossPhase] = 0;
  s.meta[Meta.BossPhaseUntil] = 0;
  s.meta[Meta.CounterBetUntil] = 0;
  s.meta[Meta.CounterBetBroken] = 0;
  s.meta[Meta.Earned] = 0;
  s.meta[Meta.PaidToAce] = 0;
  s.meta[Meta.Keys] = 0;
  s.meta[Meta.Victory] = 0;
  s.meta[Meta.BossesBeaten] = 0;
  s.pUpgrades.fill(0);
  s.doorType.fill(DoorType.Fight);
  s.shopItem.fill(0);
  s.shopPrice.fill(0);

  clearArena(s);
  startRoom(s, 1);
}

/**
 * Один тик. `inputs[i]` — кадр игрока i за ЭТОТ тик.
 *
 * Порядок обработки фиксирован и важен: он часть контракта детерминизма.
 * Менять его — ломать все golden-реплеи.
 *
 * Сначала игроки, потом враги, потом снаряды: так выстрел, сделанный в этом
 * тике, ещё не успевает попасть, а враг, начавший рывок, летит с того места,
 * где игрок его видел. Обратный порядок дал бы попадания «до нажатия».
 */
export function step(s: SimState, inputs: readonly InputFrame[]): void {
  /*
   * Забег кончился — мир останавливается.
   *
   * Не «продолжает считаться в фоне под экраном итогов»: враги доигрывали бы
   * бой с трупом, снаряды летели бы, фишки тлели, а хеш состояния менялся бы
   * каждый тик после конца. Реплей от этого перестаёт сходиться на длинных
   * прогонах по причине, к самому забегу отношения не имеющей.
   *
   * Тик при этом продолжает идти: время на экране итогов — тоже время, и
   * клиент отсчитывает по нему свои паузы.
   */
  if (s.meta[Meta.Phase] === RunPhase.Summary) {
    s.tick++;
    return;
  }

  stepPlayers(s, inputs);
  stepEnemies(s);
  stepBoss(s);
  stepBullets(s);
  stepChips(s);
  stepBets(s);
  stepRunEnd(s);
  s.tick++;
}

/**
 * Гибель всех игроков — конец забега.
 *
 * Живёт в симуляции, а не в клиенте: реплей обязан переигрываться целиком,
 * включая то, что было после смерти.
 *
 * До 0.4.0 здесь стоял тихий перезапуск: через три секунды `spawnPlayers`
 * начинал забег заново. Для версии без структуры это было честно — играть
 * было не во что, кроме бесконечной череды комнат, — но забег, начинающийся
 * сам, не имеет ни итогов, ни ключей, ни причины вернуться. Ворота 0.4.0
 * требуют, чтобы больше шестидесяти процентов плейтестеров начинали второй
 * забег ДОБРОВОЛЬНО, а добровольность того, что случается само, измерить
 * нечем.
 *
 * Пауза перед итогами осталась и осталась по прежней причине: мгновенный
 * переход читается как сбой, а не как смерть. «Последняя сделка» (GDD §12А.3)
 * встанет ровно в эту паузу в 0.6.0.
 */
function stepRunEnd(s: SimState): void {
  if (s.meta[Meta.Phase] === RunPhase.Summary) return;

  if (s.meta[Meta.RestartAt] !== 0) {
    if (s.tick < s.meta[Meta.RestartAt]) return;
    s.meta[Meta.Deaths]++;
    endRun(s, false);
    return;
  }

  for (let i = 0; i < s.playerCount; i++) {
    if ((s.pFlags[i] & EntityFlag.Alive) !== 0) return;
  }
  s.meta[Meta.RestartAt] = s.tick + RESTART_DELAY_TICKS;
}

function stepPlayers(s: SimState, inputs: readonly InputFrame[]): void {
  for (let i = 0; i < s.playerCount; i++) {
    if ((s.pFlags[i] & EntityFlag.Alive) === 0) continue;

    const inp = inputs[i];
    const dashing = s.tick < s.pDashUntil[i];
    const ragdoll = s.tick < s.pRagdollUntil[i];

    if (inp.aimX !== 0 || inp.aimY !== 0) {
      normalize(inp.aimX, inp.aimY);
      s.pAimX[i] = normX;
      s.pAimY[i] = normY;
    }

    if (ragdoll) {
      // Кувырок: управление отнято, скорость гасится своим трением.
      // Унижение вместо наказания — механика Fall Guys (GDD §6).
      s.pVX[i] = sub(s.pVX[i], mul(s.pVX[i], PLAYER.ragdollFriction));
      s.pVY[i] = sub(s.pVY[i], mul(s.pVY[i], PLAYER.ragdollFriction));
      applyVelocity(s, i);
    } else if (dashing) {
      // Во время рывка направление зафиксировано — скорость уже задана.
      applyVelocity(s, i);
    } else if (tryDash(s, i, inp)) {
      // Рывок начался прямо сейчас: обычное движение в этот тик не
      // применяется. Иначе ограничение скорости в applyMovement срежет
      // разгон обратно до ходьбы, и рывка не будет вовсе.
      applyVelocity(s, i);
    } else {
      applyMovement(s, i, inp);
    }

    if (s.tick >= s.pRagdollUntil[i]) s.pFlags[i] &= ~EntityFlag.Ragdoll;
    stepShooting(s, i, inp, ragdoll);
    stepBetInput(s, i, inp);
    updateInvulnerability(s, i);
  }

  separatePlayers(s);
}

/**
 * Стрельба: темп 6.5/с накапливается дробно, но первый выстрел мгновенный.
 *
 * Заряд копится ВСЕГДА и упирается в потолок в один выстрел. Из этого следуют
 * оба нужных свойства сразу: одиночное нажатие стреляет в тот же тик, потому
 * что полный заряд уже накоплен, а минута ходьбы не превращается в залп,
 * потому что больше одного выстрела впрок не копится.
 *
 * Первая версия обнуляла заряд при отпущенном курке и копила его с нуля при
 * зажатом. Темп при удержании выходил верный, а короткий клик не давал
 * выстрела ВООБЩЕ: за три тика до целого заряда не доходило, и игрок жал
 * кнопку впустую. В твин-стике это ощущается как сломанное оружие, и никакой
 * темп стрельбы этого не оправдывает.
 *
 * Остаток после выстрела переносится в следующий тик, и это не мелочь: 65536
 * делится на такт 7101 с остатком, и обрезка давала шестьдесят выстрелов за
 * десять секунд вместо шестидесяти пяти. Темп стрельбы — опорное число всей
 * модели сложности (DIFFICULTY §1), и потеря семи процентов тихо смещает
 * время убийства каждого врага в игре.
 */
function stepShooting(s: SimState, i: number, inp: InputFrame, ragdoll: boolean): void {
  // Кувырок отнимает и стрельбу: управление на это время отнято целиком.
  if (ragdoll) return;

  s.pShotAcc[i] += PISTOL.fireRate;

  if (!isDown(inp, Btn.Fire)) {
    // Потолок работает только при отпущенном курке — и только здесь.
    // Обрезка при зажатом съедала бы дробный остаток такта, а из него
    // складывается сам темп: 60 выстрелов за десять секунд вместо 65.
    const reserve = PLAYER.shotReserve * FX_ONE;
    if (s.pShotAcc[i] > reserve) s.pShotAcc[i] = reserve;
    return;
  }

  if (s.pShotAcc[i] < FX_ONE) return;
  s.pShotAcc[i] -= FX_ONE;
  fire(s, i);
}

/**
 * Ставочные кнопки: подобрать карту, забрать, выбрать аппетит.
 *
 * Обе — дискретные события по фронту нажатия, а не по удержанию: карта
 * подбирается подтверждением (UX §2), а «Забрать» не должно срабатывать
 * дважды от одного нажатия и сжигать второе пари.
 */
function stepBetInput(s: SimState, i: number, inp: InputFrame): void {
  const pressed = inp.buttons & ~s.pPrevButtons[i];
  s.pPrevButtons[i] = inp.buttons;

  /*
   * Аппетит ЗАЩЁЛКИВАЕТСЯ: меняется он только явным нажатием и держится до
   * следующего (GDD §9.3, UX §2).
   *
   * Чтение битов маски каждый тик выглядит тем же самым, но означает другое:
   * маска описывает нажатое ПРЯМО СЕЙЧАС, и стоило игроку отпустить
   * крестовину, как аппетит молча падал обратно в «Скромно» — то есть выбор,
   * объявленный решением на весь бой, жил ровно столько, сколько держали
   * кнопку. Своего экрана двери в 0.3.0 ещё нет, и защёлка здесь — он и есть:
   * сбрасывает выбор только начало комнаты (`startRoom`).
   */
  const tier = appetiteOf(inp);
  if (tier >= 0) s.pAppetite[i] = tier;
  // Схема ввода — свойство кадра, а не настройка клиента: игрок берётся за
  // геймпад посреди забега, и раскладка обязана это учесть уже в следующей
  // комнате. Матрица «пари × схема» (GDD §9.5) решает, что ему предлагать.
  s.pScheme[i] = schemeOf(inp);

  if ((pressed & Btn.Take) !== 0) tryTakeCard(s, i);
  if ((pressed & Btn.CashOut) !== 0) cashOutBest(s, i);
  if ((pressed & Btn.Accept) !== 0) skipSettlement(s);
}

/**
 * Пропустить экран расчёта.
 *
 * Не раньше секунды после его появления, и это не придирка: RT на геймпаде
 * держат зажатым ради автоогня, и мгновенный пропуск проскакивал бы near-miss
 * — тот самый показ «не хватило четырёх секунд», ради которого экран и
 * существует (UX §6).
 */
function skipSettlement(s: SimState): void {
  const at = s.meta[Meta.NextWaveAt];
  if (at === 0 || s.meta[Meta.Wave] !== 0) return;
  // Длительность паузы берётся у той же развилки, что её и назначила: в первой
  // комнате она короче, и чужое число дало бы «уже секунда прошла» на первом
  // же тике.
  const shown = roomGapTicksFor(s.meta[Meta.Room]) - (at - s.tick);
  if (shown < WAVE.settleSkipAfterTicks) return;
  s.meta[Meta.NextWaveAt] = s.tick + 1;
}

/** Возвращает true, если рывок начался в этом тике. */
function tryDash(s: SimState, i: number, inp: InputFrame): boolean {
  if (!isDown(inp, Btn.Dash)) return false;
  if (s.tick < s.pDashReady[i]) return false;

  // Рывок идёт в направлении движения, а при его отсутствии — в направлении
  // прицела: иначе стоящий на месте игрок не может уйти от снаряда.
  let dx = inp.moveX;
  let dy = inp.moveY;
  if (dx === 0 && dy === 0) {
    dx = s.pAimX[i];
    dy = s.pAimY[i];
  }
  normalize(dx, dy);
  const nx = normX;
  const ny = normY;
  if (nx === 0 && ny === 0) return false;

  const perTick = Math.trunc(PLAYER.dashDistance / PLAYER.dashTicks);
  s.pVX[i] = mul(nx, perTick);
  s.pVY[i] = mul(ny, perTick);
  s.pDashUntil[i] = s.tick + PLAYER.dashTicks;
  s.pDashReady[i] = s.tick + PLAYER.dashCooldownTicks;
  // «Без рывка» дорого стоит именно потому, что рывок — главный инструмент
  // выживания: отказ от него меняет то, КАК играешь (GDD §9).
  failBetId(s, i, BetId.NoDash);
  s.pInvulUntil[i] = Math.max(s.pInvulUntil[i], s.tick + PLAYER.dashTicks + PLAYER.dashCoyoteTicks);
  s.pFlags[i] |= EntityFlag.Invulnerable;
  return true;
}

function applyMovement(s: SimState, i: number, inp: InputFrame): void {
  normalize(inp.moveX, inp.moveY);
  const nx = normX;
  const ny = normY;

  if (nx !== 0 || ny !== 0) {
    s.pVX[i] = add(s.pVX[i], mul(nx, PLAYER.accel));
    s.pVY[i] = add(s.pVY[i], mul(ny, PLAYER.accel));

    // Ограничение по модулю: без него диагональ быстрее прямой.
    const vx = s.pVX[i];
    const vy = s.pVY[i];
    normalize(vx, vy);
    const cx = normX;
    const cy = normY;
    const speed2 = mul(vx, vx) + mul(vy, vy);
    const cap2 = mul(PLAYER.speed, PLAYER.speed);
    if (speed2 > cap2) {
      s.pVX[i] = mul(cx, PLAYER.speed);
      s.pVY[i] = mul(cy, PLAYER.speed);
    }
  } else {
    s.pVX[i] = sub(s.pVX[i], mul(s.pVX[i], PLAYER.friction));
    s.pVY[i] = sub(s.pVY[i], mul(s.pVY[i], PLAYER.friction));
  }

  applyVelocity(s, i);
}

function applyVelocity(s: SimState, i: number): void {
  pushOutOfColumns(s, add(s.pX[i], s.pVX[i]), add(s.pY[i], s.pVY[i]), PLAYER.radius);
  s.pX[i] = pushedX;
  s.pY[i] = pushedY;
}

/**
 * Игроки толкаются, но не проходят друг сквозь друга (GDD §14).
 *
 * Толкание — не мелочь удобства: на нём стоит саботаж в коопе, и оно должно
 * работать одинаково у всех, то есть жить в симуляции.
 *
 * Толчок проходит через `pushOutOfColumns`, а не через одно обрезание по
 * границам арены. Обрезание держит игрока внутри стен и ничего не знает про
 * колонны — а значит напарник мог втолкнуть его ВНУТРЬ колонны, объявленной
 * укрытием: снаряды там гаснут, враги туда не идут, и сидящий в камне игрок
 * неуязвим. Саботаж в коопе задуман как толчок под таран, а не как способ
 * спрятать напарника в стене.
 */
function separatePlayers(s: SimState): void {
  if (s.playerCount < 2) return;
  const minDist = add(PLAYER.radius, PLAYER.radius);

  for (let i = 0; i < s.playerCount; i++) {
    if ((s.pFlags[i] & EntityFlag.Alive) === 0) continue;
    for (let j = i + 1; j < s.playerCount; j++) {
      if ((s.pFlags[j] & EntityFlag.Alive) === 0) continue;
      const dx = sub(s.pX[i], s.pX[j]);
      const dy = sub(s.pY[i], s.pY[j]);
      if (!within(dx, dy, minDist)) continue;
      normalize(dx, dy);
      if (normX === 0 && normY === 0) continue;
      const px = mul(normX, PLAYER.pushSpeed);
      const py = mul(normY, PLAYER.pushSpeed);
      pushOutOfColumns(s, add(s.pX[i], px), add(s.pY[i], py), PLAYER.radius);
      s.pX[i] = pushedX;
      s.pY[i] = pushedY;
      pushOutOfColumns(s, sub(s.pX[j], px), sub(s.pY[j], py), PLAYER.radius);
      s.pX[j] = pushedX;
      s.pY[j] = pushedY;
    }
  }
}

function updateInvulnerability(s: SimState, i: number): void {
  if (s.tick >= s.pInvulUntil[i]) s.pFlags[i] &= ~EntityFlag.Invulnerable;
}

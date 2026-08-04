/**
 * Обратная связь: превращает изменения состояния в частицы, тряску и звук.
 *
 * События ВЫВОДЯТСЯ из состояния, а не эмитятся симуляцией, — по той же
 * причине, по которой так устроен журнал событий: ядру запрещено аллоцировать,
 * а список событий это объекты и строки. Плата известна и принята: обратная
 * связь описывает наблюдаемые изменения, а не намерения кода.
 *
 * Числа хитстопа и тряски — таблица сочности из GDD §6, целиком:
 *
 *   попадание по врагу  20 мс   —              вспышка врага 60 мс, скваш 1.15
 *   убийство            40 мс   3 u / 0.12 с   12 частиц, дроп фишек
 *   урон игроку         70 мс   10 u / 0.25 с  вспышка экрана, виньетка
 *   взрыв Фитиля        50 мс   8 u / 0.20 с   ударная волна-кольцо
 */

import {
  AceGesture,
  BETS,
  BetState,
  CARD,
  FX_ONE,
  cashOutValue,
  MAX_ACTIVE_BETS,
  MAX_CARDS,
  EnemyPhase,
  EnemyType,
  EntityFlag,
  MAX_CHIPS,
  MAX_ENEMIES,
  MAX_PLAYERS,
  MAX_SPAWNS,
  Meta,
  type SimState,
  toFloat,
} from '../../sim/src/index';
import type { Audio } from './audio';
import { pickBark, severityOf } from './barks';
import type { Feel } from './feel';
import { PALETTE, type Rgb } from './palette';
import { ParticleShape, type Particles } from './particles';

/** Длительность белой вспышки попадания, секунды (GDD §6). */
const HIT_FLASH = 0.06;
/** Скваш при попадании: 1.15× по одной оси. */
const HIT_SQUASH = 0.15;

const rand = (): number => Math.random() * 2 - 1;

/**
 * Высота звука по типу врага.
 *
 * Звук здесь несёт данные: в каше из двадцати смертей игрок различает, кого
 * убил, не глядя на экран. Клин мелкий и звонкий, Кирпич тяжёлый и низкий,
 * Фитиль между ними — та же иерархия, что в их формах и в их угрозе.
 */
const PITCH: Record<number, number> = {
  [EnemyType.Wedge]: 1.18,
  [EnemyType.Brick]: 0.82,
  [EnemyType.Fuse]: 1,
};

export class Feedback {
  /** Остаток вспышки на каждом враге, секунды. Читает рендер. */
  readonly enemyFlash = new Float32Array(MAX_ENEMIES);
  readonly enemySquash = new Float32Array(MAX_ENEMIES);
  readonly playerSquash = new Float32Array(MAX_PLAYERS);

  private readonly prevHP = new Int32Array(MAX_ENEMIES);
  private readonly prevActive = new Uint8Array(MAX_ENEMIES);
  private readonly prevType = new Int32Array(MAX_ENEMIES);
  private readonly prevPhase = new Int32Array(MAX_ENEMIES);
  private readonly prevX = new Int32Array(MAX_ENEMIES);
  private readonly prevY = new Int32Array(MAX_ENEMIES);

  private readonly prevHearts = new Int32Array(MAX_PLAYERS);
  private readonly prevShotAcc = new Int32Array(MAX_PLAYERS);
  private readonly prevAlive = new Uint8Array(MAX_PLAYERS);
  private readonly prevChips = new Int32Array(MAX_PLAYERS);

  private readonly prevCardActive = new Uint8Array(MAX_CARDS);
  private readonly prevBetState = new Int32Array(MAX_PLAYERS * MAX_ACTIVE_BETS);
  private readonly prevChipActive = new Uint8Array(MAX_CHIPS);
  private readonly prevSpawnActive = new Uint8Array(MAX_SPAWNS);
  private prevWave = 0;
  private prevGesture = AceGesture.None;
  /** Был ли Туз на арене в прошлом тике: его выход обязан звучать один раз. */
  private prevAceOnArena = false;

  /**
   * Чем кончилось каждое пари — для экрана расчёта.
   *
   * Снимается в момент перехода, а не читается на расчёте, и по той же
   * причине, по которой ядро снимает там near-miss: обналиченная выплата
   * считается от прогресса, а прогресс к концу комнаты уже другой. Сумма,
   * показанная игроку, обязана быть той, что ему заплатили.
   */
  readonly betPayout = new Int32Array(MAX_PLAYERS * MAX_ACTIVE_BETS);
  /**
   * Тик, на котором пари сорвалось.
   *
   * Из него получается «не хватило N секунд» для темповых: разница между
   * срывом и концом комнаты и есть то, сколько игроку не хватило. Ядру этот
   * счёт не нужен — это чисто показ, — а без него near-miss темпового пари
   * читался бы как «100%», потому что время у него вышло целиком.
   */
  readonly betLostTick = new Int32Array(MAX_PLAYERS * MAX_ACTIVE_BETS);
  private barkOccasion = 0;
  /**
   * Реплика, которой Туз сопроводил текущий жест.
   *
   * Пока её видно только в отладочном интерфейсе: текст в кадр приезжает со
   * шрифтом и словарём в стадии F2 (PRODUCTION §4). Выбор реплики от этого не
   * зависит и работает уже сейчас — иначе в F2 пришлось бы вместе со шрифтом
   * отлаживать и правило дозировки.
   */
  bark = '';
  private takenThisTick = false;
  private primed = false;

  constructor(
    private readonly particles: Particles,
    private readonly feel: Feel,
    private readonly audio: Audio,
  ) {}

  reset(s: SimState): void {
    this.particles.clear();
    this.enemyFlash.fill(0);
    this.enemySquash.fill(0);
    this.playerSquash.fill(0);
    this.betPayout.fill(0);
    this.betLostTick.fill(0);
    this.prevAceOnArena = s.meta[Meta.AceX] !== 0;
    this.primed = false;
    this.remember(s);
    this.primed = true;
  }

  /** Затухание вспышек идёт по реальному времени, а не по тикам. */
  frame(dt: number): void {
    for (let i = 0; i < MAX_ENEMIES; i++) {
      if (this.enemyFlash[i] > 0) this.enemyFlash[i] = Math.max(0, this.enemyFlash[i] - dt);
      if (this.enemySquash[i] > 0) this.enemySquash[i] = Math.max(0, this.enemySquash[i] - dt * 6);
    }
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (this.playerSquash[i] > 0)
        this.playerSquash[i] = Math.max(0, this.playerSquash[i] - dt * 5);
    }
  }

  /** Вызывается после каждого тика симуляции. */
  observe(s: SimState): void {
    if (!this.primed) {
      this.remember(s);
      this.primed = true;
      return;
    }

    // Списание кона видно только сравнением с прошлым тиком, а сравнивать
    // приходится ДО того, как прошлое перезапишется. Подбор карты — это
    // единственное, что уменьшает кошелёк: фишки его только пополняют.
    this.takenThisTick = false;
    for (let p = 0; p < s.playerCount; p++) {
      if (s.pChips[p] < this.prevChips[p]) this.takenThisTick = true;
    }

    this.observeEnemies(s);
    this.observePlayers(s);
    this.observeChips(s);
    this.observeCards(s);
    this.observeBets(s);
    this.observeWaves(s);
    this.observeAce(s);
    this.remember(s);
  }

  /**
   * Жесты Туза: звук и реплика.
   *
   * Жест выбран симуляцией и потому одинаков в реплее; клиенту остаётся его
   * озвучить. Реплики идут по кругу, а не наугад: случайный выбор повторяет
   * строку дважды подряд заметно чаще, чем кажется, и это читается как «у
   * него их всего две».
   */
  private observeAce(s: SimState): void {
    /*
     * Появление Туза — шорох и его смешок (GDD §22).
     *
     * Это пространственный сигнал «сейчас будет карта», а не украшение:
     * между выходом и подбросом проходит полсекунды телеграфа, и услышать
     * его игрок обязан раньше, чем увидит, — он в это время смотрит на бой,
     * а Туз встаёт у дальней стены.
     */
    const onArena = s.meta[Meta.AceX] !== 0;
    if (onArena && !this.prevAceOnArena) this.audio.play('aceAppear');
    this.prevAceOnArena = onArena;

    const g = s.meta[Meta.AceGesture] as AceGesture;
    if (g === this.prevGesture) return;
    this.prevGesture = g;
    if (g === AceGesture.None) return;

    let chips = 0;
    for (let p = 0; p < s.playerCount; p++) chips += s.pChips[p];
    this.bark = pickBark(g, this.barkOccasion++, severityOf(s.meta[Meta.DeathStreak], chips));
    this.audio.play('aceGesture');
  }

  private observeEnemies(s: SimState): void {
    for (let i = 0; i < MAX_ENEMIES; i++) {
      const was = this.prevActive[i] !== 0;
      const now = s.eActive[i] !== 0;

      if (was && now) {
        if (s.eHP[i] < this.prevHP[i]) {
          this.onHit(i, toFloat(s.eX[i]), toFloat(s.eY[i]));
          continue;
        }
        // Объявленная атака обязана звучать: часть угроз игрок считывает,
        // не глядя на экран, и телеграф — первая из них.
        if (s.ePhase[i] === EnemyPhase.Telegraph && this.prevPhase[i] !== EnemyPhase.Telegraph) {
          this.audio.play('telegraph', PITCH[s.eType[i]] ?? 1);
        }
        continue;
      }

      if (!was || now) continue;

      const x = toFloat(this.prevX[i]);
      const y = toFloat(this.prevY[i]);
      // Фитиль, дошедший до конца телеграфа, не убит — он взорвался, и это
      // совсем другое событие: ударная волна вместо горсти осколков.
      if (this.prevType[i] === EnemyType.Fuse && this.prevPhase[i] === EnemyPhase.Telegraph) {
        this.onExplosion(x, y);
      } else {
        this.onKill(x, y, this.prevType[i]);
      }
    }
  }

  private onHit(i: number, x: number, y: number): void {
    this.feel.freeze(0.02);
    this.enemyFlash[i] = HIT_FLASH;
    this.enemySquash[i] = HIT_SQUASH;
    this.audio.play('hit');
    for (let n = 0; n < 3; n++) {
      this.particles.spawn(
        ParticleShape.Dot,
        x,
        y,
        rand() * 260,
        rand() * 260,
        5,
        0.18,
        PALETTE.bullet,
      );
    }
  }

  private onKill(x: number, y: number, type: number): void {
    this.feel.freeze(0.04);
    this.feel.shake(3, 0.12);
    this.audio.play('kill', PITCH[type] ?? 1);
    // Двенадцать осколков — число из таблицы сочности, не «на глаз».
    for (let n = 0; n < 12; n++) {
      const a = (n / 12) * Math.PI * 2 + rand() * 0.3;
      const speed = 260 + Math.random() * 260;
      this.particles.spawn(
        ParticleShape.Shard,
        x,
        y,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        9,
        0.42,
        PALETTE.enemy,
        -8,
        3.2,
        rand() * 14,
      );
    }
    this.particles.spawn(ParticleShape.Ring, x, y, 0, 0, 20, 0.24, PALETTE.enemyAlt, 260);
  }

  private onExplosion(x: number, y: number): void {
    this.feel.freeze(0.05);
    this.feel.shake(8, 0.2);
    this.audio.play('explosion');
    // Кольцо ударной волны растёт ровно до боевого радиуса взрыва: игрок
    // должен видеть ту зону, которая его задела, а не декоративную.
    this.particles.spawn(ParticleShape.Ring, x, y, 0, 0, 30, 0.3, PALETTE.danger, 520);
    for (let n = 0; n < 16; n++) {
      const a = (n / 16) * Math.PI * 2;
      const speed = 420 + Math.random() * 300;
      this.particles.spawn(
        ParticleShape.Dot,
        x,
        y,
        Math.cos(a) * speed,
        Math.sin(a) * speed,
        12,
        0.36,
        PALETTE.danger,
        -14,
        2.6,
      );
    }
  }

  private observePlayers(s: SimState): void {
    for (let i = 0; i < s.playerCount; i++) {
      const x = toFloat(s.pX[i]);
      const y = toFloat(s.pY[i]);

      // Выстрел виден по тому, что накопленная доля сбросилась через целую.
      if (s.pShotAcc[i] < this.prevShotAcc[i]) {
        this.audio.play('shot');
        const ax = toFloat(s.pAimX[i]);
        const ay = toFloat(s.pAimY[i]);
        this.particles.spawn(
          ParticleShape.Dot,
          x + ax * 28,
          y + ay * 28,
          ax * 120,
          ay * 120,
          7,
          0.07,
          PALETTE.bullet,
          -40,
        );
      }

      if (s.pHearts[i] < this.prevHearts[i]) {
        this.feel.freeze(0.07);
        this.feel.shake(10, 0.25);
        this.feel.flash(PALETTE.danger, 0.3);
        this.playerSquash[i] = 0.3;
        this.audio.play('hurt');
      }

      const alive = (s.pFlags[i] & EntityFlag.Alive) !== 0;
      if (this.prevAlive[i] !== 0 && !alive) {
        this.audio.play('death');
        this.feel.shake(14, 0.4);
        for (let n = 0; n < 20; n++) {
          const a = (n / 20) * Math.PI * 2;
          const speed = 200 + Math.random() * 340;
          this.particles.spawn(
            ParticleShape.Shard,
            x,
            y,
            Math.cos(a) * speed,
            Math.sin(a) * speed,
            10,
            0.7,
            PALETTE.player[i] as Rgb,
            -6,
            2.4,
            rand() * 12,
          );
        }
      }

      if (s.pChips[i] > this.prevChips[i]) this.audio.play('pickup');
    }
  }

  private observeChips(s: SimState): void {
    for (let i = 0; i < MAX_CHIPS; i++) {
      // Появившаяся фишка подпрыгивает искрой: её нельзя спутать с картой
      // пари, и разный визуальный класс закладывается уже сейчас (GDD §21).
      if (s.cActive[i] !== 0 && this.prevChipActive[i] === 0) {
        this.particles.spawn(
          ParticleShape.Dot,
          toFloat(s.cX[i]),
          toFloat(s.cY[i]),
          rand() * 90,
          rand() * 90,
          6,
          0.25,
          PALETTE.chip,
          -10,
        );
      }
    }
  }

  /**
   * Карты: появление, подбор и угасание.
   *
   * Исчезнувшая карта — это либо подбор, либо истёкший срок, и звучать они
   * обязаны по-разному: одно решение игрока, другое — упущенная возможность.
   * Различаем по кошельку: подбор списывает кон.
   */
  private observeCards(s: SimState): void {
    for (let i = 0; i < MAX_CARDS; i++) {
      const was = this.prevCardActive[i] !== 0;
      const now = s.kActive[i] !== 0;

      if (!was && now) {
        // Новая карта посреди боя — это подброс Туза: в начале комнаты они
        // появляются все разом, и там звучит раскладка, а не подброс.
        if (this.primed && s.tick > s.meta[Meta.RoomStartTick] + 60) {
          this.audio.play('cardToss');
          this.particles.spawn(
            ParticleShape.Ring,
            toFloat(s.kX[i]),
            toFloat(s.kY[i]),
            0,
            0,
            10,
            0.4,
            PALETTE.card,
            180,
          );
        }
        continue;
      }
      // Истлевшая карта звучит НЕ так, как предупреждение о том, что она
      // вот-вот истлеет: одно — «беги, если хочешь успеть», другое — «уже
      // нет». Одним звуком на оба игрок перестаёт различать шанс и его
      // потерю, а карта только этим таймером и давит.
      if (was && !now && this.takenThisTick) this.audio.play('cardTake');
      else if (was && !now) this.audio.play('cardExpire');
    }

    // Предупреждение об истечении: угасающий звон за три секунды до конца.
    for (let i = 0; i < MAX_CARDS; i++) {
      if (!s.kActive[i]) continue;
      if (s.kDeadline[i] - s.tick === CARD.fadeTicks) this.audio.play('cardFade');
    }
  }

  /** Пари: взятие, обналичивание и расчёт слышны отдельно друг от друга. */
  private observeBets(s: SimState): void {
    for (let k = 0; k < s.playerCount * MAX_ACTIVE_BETS; k++) {
      const was = this.prevBetState[k] as BetState;
      const now = s.aState[k] as BetState;
      if (now === BetState.None) {
        // Новая комната стёрла слоты — стираем и хвосты прошлой.
        this.betPayout[k] = 0;
        this.betLostTick[k] = 0;
      }
      if (was === now) continue;

      const player = Math.trunc(k / MAX_ACTIVE_BETS);
      const n = k % MAX_ACTIVE_BETS;
      const spec = BETS[s.aBet[k]];

      if (now === BetState.Cashed) {
        // Выплату считаем ДО того, как прогресс уедет вместе с комнатой.
        this.betPayout[k] = cashOutValue(s, player, n);
        this.audio.play('cashOut');
      } else if (now === BetState.Won) {
        this.betPayout[k] = Math.trunc((s.aStake[k] * spec.multiplier) / FX_ONE);
        this.audio.play('betWon');
      } else if (now === BetState.Lost && was === BetState.Active) {
        this.betPayout[k] = 0;
        this.betLostTick[k] = s.tick;
        this.audio.play('betLost');
      }
    }
  }

  private observeWaves(s: SimState): void {
    for (let i = 0; i < MAX_SPAWNS; i++) {
      if (s.spActive[i] !== 0 && this.prevSpawnActive[i] === 0) this.audio.play('spawn');
    }
    if (s.meta[Meta.Wave] !== this.prevWave && s.meta[Meta.Wave] !== 0) this.audio.play('wave');
  }

  private remember(s: SimState): void {
    this.prevHP.set(s.eHP);
    this.prevActive.set(s.eActive);
    this.prevType.set(s.eType);
    this.prevPhase.set(s.ePhase);
    this.prevX.set(s.eX);
    this.prevY.set(s.eY);
    this.prevHearts.set(s.pHearts);
    this.prevShotAcc.set(s.pShotAcc);
    this.prevChips.set(s.pChips);
    for (let i = 0; i < MAX_PLAYERS; i++) {
      this.prevAlive[i] = (s.pFlags[i] & EntityFlag.Alive) !== 0 ? 1 : 0;
    }
    this.prevCardActive.set(s.kActive);
    this.prevBetState.set(s.aState);
    this.prevChipActive.set(s.cActive);
    this.prevSpawnActive.set(s.spActive);
    this.prevWave = s.meta[Meta.Wave];
  }
}

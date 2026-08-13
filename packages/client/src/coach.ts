/**
 * Обучение действием: подсказка появляется там, где решение и принимается.
 *
 * Справка (экран «Как играть») — резервный текстовый путь, к которому
 * возвращаются, когда действия оказалось недостаточно (UX §7). Она не решает
 * главную задачу: игрок, впервые попавший в бой, не знает ни что подобрать
 * карту можно кнопкой, ни что куш можно забрать досрочно, — а читать справку
 * до боя он не обязан и по замыслу не должен (GDD §23: на нулевой секунде
 * игрок жмёт одну кнопку и оказывается в бою).
 *
 * Отсюда три правила, по которым здесь всё устроено.
 *
 * **Урок привязан к состоянию, а не к таймеру.** «Возьмите карту» показывается
 * ровно тогда, когда игрок стоит на карте, а «Забрать» — когда у него есть
 * что забирать. Подсказка, висящая по расписанию, учит не механике, а
 * терпению.
 *
 * **Урок исчезает, когда выполнен.** Признак выполнения — то же состояние:
 * карта подобрана, рывок сделан, пари обналичено. Подсказка, которую надо
 * закрывать вручную, превращается в модальное окно посреди боя — ровно то,
 * что запрещает принцип «опасным должен быть поступок, а не интерфейс»
 * (UX §1.3).
 *
 * **Выученное не повторяется.** Пройденные уроки живут в профиле игрока, а не
 * в забеге: во втором забеге «WASD — идти» — это шум, а не обучение.
 *
 * Модуль ничего не рисует и не знает про рендер: он отвечает на единственный
 * вопрос «какую строку показывать сейчас», а рисует её HUD.
 */

import { Btn, type InputFrame, Meta, RunPhase, type SimState } from '@dod/sim';
import {
  EntityFlag,
  MAX_ACTIVE_BETS,
  MAX_CARDS,
  MAX_ENEMIES,
  BetState,
  CARD,
  PLAYER,
  toFloat,
} from '@dod/sim';
import type { StringKey } from './strings.generated';

/** Идентификаторы уроков. Строкой, потому что они же уезжают в профиль. */
export type LessonId = 'move' | 'card' | 'take' | 'dash' | 'cashout' | 'settle' | 'door' | 'pause';

interface Lesson {
  readonly id: LessonId;
  /** Показывать ли урок прямо сейчас. */
  readonly when: (s: SimState, ctx: Context) => boolean;
  /** Урок пройден и больше не нужен — ни в этом забеге, ни в следующих. */
  readonly done: (s: SimState, ctx: Context) => boolean;
  /**
   * Сколько тиков урок висит, даже если не выполнен.
   *
   * Ноль — «висит, пока условие верно». Ограничение нужно тем урокам, чьё
   * выполнение невозможно увидеть состоянием: «пауза» нажимается вне
   * симуляции, и ждать её вечно значит держать строку на экране весь забег.
   */
  readonly ticks: number;
  /**
   * Урок считается пройденным, как только показан целиком.
   *
   * Нужен там, где выполнения не существует в состоянии: «Расчёт: чем
   * кончились пари» ничего не требует нажать, а «Выберите дверь» игрок и так
   * выберет — иначе забег не пойдёт. Без этого признака такой урок не
   * попадал в выученные НИКОГДА: закрывался он только по таймеру, а по
   * таймеру запоминания не происходит. На двадцать первой двери подсказка
   * «выберите дверь» — уже не обучение, а шум, из-за которого перестают
   * читать и полезные строки.
   */
  readonly once?: boolean;
}

interface Context {
  /**
   * Кадр ввода локального игрока: по нему видно, что игрок уже пробовал.
   *
   * Больше в контексте ничего нет намеренно. Тик показа сюда просился, но
   * читать его уроку нельзя: срок жизни задаётся полем `ticks` и считается
   * снаружи, и второй способ отмерить то же время означал бы два ответа на
   * вопрос «урок ещё висит?».
   */
  readonly buttons: number;
}

/** Стоит ли игрок на карте, которую может взять. */
function onCard(s: SimState): boolean {
  const pickup = toFloat(CARD.pickupRadius);
  for (let i = 0; i < MAX_CARDS; i++) {
    if (!s.kActive[i]) continue;
    if (s.kOwner[i] > 0) continue;
    const dx = toFloat(s.pX[0]) - toFloat(s.kX[i]);
    const dy = toFloat(s.pY[0]) - toFloat(s.kY[i]);
    if (dx * dx + dy * dy <= pickup * pickup) return true;
  }
  return false;
}

/** Есть ли на арене хоть одна карта, доступная локальному игроку. */
function cardOnFloor(s: SimState): boolean {
  for (let i = 0; i < MAX_CARDS; i++) {
    if (s.kActive[i] && s.kOwner[i] <= 0) return true;
  }
  return false;
}

/** Сколько пари игрок держит прямо сейчас. */
function activeBets(s: SimState): number {
  let n = 0;
  for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
    if (s.aState[i] === BetState.Active) n++;
  }
  return n;
}

const inFight = (s: SimState): boolean =>
  s.meta[Meta.Phase] === RunPhase.Fight && (s.pFlags[0] & EntityFlag.Alive) !== 0;

/** Есть ли на арене хоть один живой враг. */
function enemiesAlive(s: SimState): boolean {
  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (s.eActive[i]) return true;
  }
  return false;
}

/**
 * Порядок важен: первый подходящий урок и показывается.
 *
 * Сверху — то, без чего нельзя двигаться дальше, снизу — то, что уточняет.
 * Одновременно на экране всегда один урок: две строки в бою — это уже чтение,
 * а читать под обстрелом игрок не будет (UX §1.3).
 */
const LESSONS: readonly Lesson[] = [
  {
    // Движение и огонь: первое, что вообще нужно. Выученным урок считает
    // ВЫСТРЕЛ, а не шаг: ход живёт в осях, а не в кнопке, и «сдвинулся» от
    // «стоит на месте с зажатым стиком» состоянием не отличить. Выстрел —
    // единственное здесь, что игрок мог сделать только намеренно.
    id: 'move',
    when: (s) => inFight(s),
    done: (_s, ctx) => (ctx.buttons & Btn.Fire) !== 0,
    ticks: 0,
  },
  {
    // Карта лежит на арене, но игрок к ней не подошёл.
    id: 'card',
    when: (s) => inFight(s) && cardOnFloor(s) && !onCard(s) && activeBets(s) === 0,
    done: (s) => onCard(s) || activeBets(s) > 0,
    ticks: 0,
  },
  {
    // Игрок стоит на карте — момент, ради которого правило «подбор кнопкой»
    // и заведено (UX §2, правило ввода №2).
    id: 'take',
    when: (s) => inFight(s) && onCard(s),
    done: (s) => activeBets(s) > 0,
    ticks: 0,
  },
  {
    // Рывок: показывается, когда игрок уже получил урон — то есть когда цена
    // незнания стала наглядной.
    id: 'dash',
    when: (s) => inFight(s) && s.pHearts[0] < PLAYER.startHearts,
    done: (_s, ctx) => (ctx.buttons & Btn.Dash) !== 0,
    ticks: 600,
  },
  {
    // «Забрать» — центральный глагол игры, и учить его надо на живом пари.
    id: 'cashout',
    when: (s) => inFight(s) && activeBets(s) > 0,
    done: (_s, ctx) => (ctx.buttons & Btn.CashOut) !== 0,
    ticks: 900,
  },
  // Три урока ниже ничего не требуют нажать: они называют экран, на который
  // игрок и так попадёт. Показываются один раз за профиль (`once`).
  {
    id: 'settle',
    when: (s) => s.meta[Meta.Phase] === RunPhase.Fight && s.meta[Meta.NextWaveAt] > s.tick,
    done: () => false,
    ticks: 300,
    once: true,
  },
  {
    id: 'door',
    when: (s) => s.meta[Meta.Phase] === RunPhase.Door,
    done: () => false,
    ticks: 600,
    once: true,
  },
  {
    // Показывается только между волнами: посреди боя с живыми врагами таймер
    // истёк бы незамеченным, а второго шанса у уроков с `once` нет.
    id: 'pause',
    when: (s) => inFight(s) && s.meta[Meta.Room] >= 2 && !enemiesAlive(s),
    done: () => false,
    ticks: 420,
    once: true,
  },
];

/** Идентификаторы, которые существуют на самом деле: фильтр для сохранения. */
const KNOWN: ReadonlySet<LessonId> = new Set(LESSONS.map((l) => l.id));

/**
 * Какую подсказку показывать — и когда её забыть.
 *
 * Состояние снаружи только одно: множество выученного, приходящее из профиля
 * и туда же уезжающее. Всё остальное выводится из симуляции.
 */
export class Coach {
  private readonly learned = new Set<LessonId>();
  private current: LessonId | null = null;
  private since = 0;
  private buttons = 0;
  /** Кого позвать, когда урок пройден: профиль обязан это запомнить. */
  private onLearn: ((id: LessonId) => void) | null = null;

  /**
   * Что игрок уже знает — из сохранения.
   *
   * Чужие строки отбрасываются, и это не паранойя про испорченный файл.
   * Список уроков меняется между версиями, а сохранение переживает обновление:
   * достаточно переименовать урок, и старый профиль принесёт идентификатор,
   * которого больше нет. Он лёг бы в множество наравне с настоящими, добил
   * `learned.size` до `LESSONS.length` — и обучение выключилось бы целиком,
   * молча, у игрока, который его не проходил.
   */
  restore(ids: readonly string[]): void {
    for (const id of ids) {
      if (KNOWN.has(id as LessonId)) this.learned.add(id as LessonId);
    }
  }

  learnedList(): LessonId[] {
    return [...this.learned];
  }

  onLearned(fn: (id: LessonId) => void): void {
    this.onLearn = fn;
  }

  /**
   * Обучение целиком выключается, когда игрок его прошёл.
   *
   * Проверяется по числу уроков, а не по флагу «туториал пройден»: список
   * растёт, и флаг рассинхронизировался бы с ним в первой же правке.
   */
  get finished(): boolean {
    return this.learned.size >= LESSONS.length;
  }

  /**
   * Обновить состояние по тику.
   *
   * `frame` — кадр ввода локального игрока: по нему видно, что игрок
   * действительно нажал кнопку, о которой урок говорит. Состояние симуляции
   * этого не хранит — нажатие живёт один тик, — и именно поэтому кадр
   * приходит сюда, а не выводится из `SimState`.
   */
  observe(s: SimState, frame: InputFrame): void {
    if (this.finished) return;
    this.buttons |= frame.buttons;

    const ctx: Context = { buttons: this.buttons };

    if (this.current !== null) {
      const lesson = LESSONS.find((l) => l.id === this.current);
      if (!lesson) {
        this.current = null;
      } else {
        const expired = lesson.ticks > 0 && s.tick - this.since > lesson.ticks;
        const done = lesson.done(s, ctx);
        if (done || expired) {
          /*
           * Выученным считается пройденный урок, а не просроченный: у
           * просроченного будет второй шанс в следующей комнате.
           *
           * Исключение — уроки с `once`: выполнить их нечем, и «второй шанс»
           * для них означает показ в каждом забеге до скончания века.
           */
          if (done || lesson.once) {
            this.learned.add(lesson.id);
            this.onLearn?.(lesson.id);
          }
          this.current = null;
          this.buttons = 0;
        } else if (!lesson.when(s, ctx)) {
          this.current = null;
          this.buttons = 0;
        }
        if (this.current !== null) return;
      }
    }

    for (const lesson of LESSONS) {
      if (this.learned.has(lesson.id)) continue;
      if (!lesson.when(s, { buttons: 0 })) continue;
      this.current = lesson.id;
      this.since = s.tick;
      this.buttons = 0;
      return;
    }
  }

  /** Ключ строки текущего урока по схеме ввода, либо `null`. */
  key(pad: boolean): StringKey | null {
    if (this.current === null) return null;
    return `coach.${this.current}.${pad ? 'pad' : 'key'}` as StringKey;
  }

  /**
   * Объявить всё обучение пройденным — для съёмки и сценариев.
   *
   * Ровно то состояние, в котором игра живёт со второго забега: подсказок нет.
   * Снимать боевые экраны с висящим уроком значило бы ревьюить не игру, а
   * первую минуту первого забега.
   */
  teachAll(): void {
    for (const lesson of LESSONS) this.learned.add(lesson.id);
    this.current = null;
  }

  /** Объявить пройденным один урок: так снимается следующий по очереди. */
  teach(id: string): void {
    if (!KNOWN.has(id as LessonId)) return;
    this.learned.add(id as LessonId);
    if (this.current === id) this.current = null;
  }

  /** Забыть всё: съёмка первого забега начинается с чистого листа. */
  forget(): void {
    this.learned.clear();
    this.current = null;
  }

  reset(): void {
    this.current = null;
    this.buttons = 0;
    this.since = 0;
  }
}

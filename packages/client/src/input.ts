/**
 * Слой ввода: геймпад, клавиатура и мышь → единый InputFrame.
 *
 * Нормализация происходит ДО симуляции — ядро не должно знать, откуда пришло
 * направление. Это же делает InputFrame единицей сети и реплея.
 */

import {
  withAppetite,
  Btn,
  fromFloat,
  type InputFrame,
  InputScheme,
  makeFrame,
  SCHEME_SHIFT,
} from '@dod/sim';

/** Радиальная мёртвая зона: квадратная врёт на диагоналях. */
const DEADZONE = 0.18;
/** Буфер ввода прощает раннее нажатие рывка (6 кадров). */
const BUFFER_TICKS = 6;

/** Три тира кона: Скромно / Нормально / По-крупному (GDD §9.3). */
const APPETITE_TIERS = 3;

/**
 * Сколько мышь должна проехать, чтобы отобрать схему у геймпада.
 *
 * В единицах арены, то есть в тех же, в которых считается прицел. Порог, а не
 * любое движение: мышь дёргается от толчка стола и от переключения окон, и
 * геймпадному игроку это молча меняло бы схему ввода — а вместе с ней и то,
 * какие пари ему вообще разрешено выдавать (GDD §9.5).
 */
const MOUSE_WAKE = 12;

/** Номера кнопок в стандартной раскладке Gamepad API. */
const PAD_DPAD_UP = 12;
const PAD_DPAD_DOWN = 13;
const PAD_START_BTN = 9;
/**
 * Кнопки экранных решений: RB подтверждает, B отказывает.
 *
 * Ни одной из четырёх лицевых взять нельзя, и это следствие правила «смысл
 * бита не зависит от того, что сейчас на экране» (UX §2). A — рывок, X —
 * подбор карты, Y — «Удвоим?» и пропуск расчёта: каждая из них живёт В БОЮ, а
 * Ставка Туза предлагается экраном ПОВЕРХ боя (GDD §12А.1) и принимается тем
 * же битом `Confirm`. Общая кнопка означала бы, что уворот рывком подписывает
 * пари на четверть кошелька, — ровно тот дефект, ради которого экранные биты и
 * заводились отдельными.
 *
 * B — исключение, и оно обосновано совпадением смысла: и «Отказаться» от
 * «Удвоим?», и `Cancel` на экране означают «нет». Совпавшие действия не могут
 * навредить друг другу — в отличие от рывка и согласия, которые не имеют
 * общего ничего.
 */
const PAD_CONFIRM_BTN = 5;
const PAD_CANCEL_BTN = 1;

/**
 * Порог горизонтали, за которым фокус переезжает на соседний элемент.
 *
 * Осознанно грубый: экраны выбирают из трёх, и промахнуться пальцем по стику
 * дороже, чем нажать второй раз. Уровень, а не фронт: фронт нажатия считает
 * ядро (`pressed = buttons & ~pPrevButtons`), и второй счётчик в клиенте
 * означал бы два разных ответа на вопрос «сколько раз нажали».
 */
const NAV_AXIS = 0.5;

/**
 * Экранные действия и их раскладка — по строке на действие (UX §2).
 *
 * Таблица, а не пятнадцать `if` подряд, ровно потому, что она и есть та самая
 * таблица из UX §2, у которой «нет права на пустую клетку»: принцип 1
 * («всё, что доступно с геймпада, доступно с клавиатуры и мыши») проверяется
 * машиной по этим полям (`tests/navigation.test.ts`), а не вычиткой перед
 * выпуском. Появилась кнопка на геймпаде — пустой список клавиш роняет тест.
 *
 * Горизонталь отдельным полем: она приходит и с левого стика, и с `A`/`D`
 * одним и тем же числом (`moveX`), поэтому одно правило закрывает обе схемы —
 * «двигаешь влево — выбираешь левое».
 */
export interface ScreenBinding {
  /** Бит кадра ввода, см. `Btn`. */
  readonly bit: number;
  /** Кнопки геймпада в стандартной раскладке. */
  readonly pad: readonly number[];
  /** Коды клавиш (`KeyboardEvent.code`). */
  readonly keys: readonly string[];
  /** Знак горизонтали движения: 0 — действие горизонталью не вызывается. */
  readonly axis: -1 | 0 | 1;
}

export const SCREEN_BINDINGS: readonly ScreenBinding[] = [
  // Крестовина ← → здесь намеренно не занята: горизонталь крестовины обещана
  // эмоциям в 0.5.0 (UX §2), а стик и `A`/`D` дают тот же жест обеим схемам.
  { bit: Btn.NavLeft, pad: [], keys: ['ArrowLeft'], axis: -1 },
  { bit: Btn.NavRight, pad: [], keys: ['ArrowRight'], axis: 1 },
  { bit: Btn.Confirm, pad: [PAD_CONFIRM_BTN], keys: ['Enter', 'NumpadEnter'], axis: 0 },
  { bit: Btn.Cancel, pad: [PAD_CANCEL_BTN], keys: ['KeyQ'], axis: 0 },
];

/**
 * Своя маска для кнопок, которым нужен фронт нажатия.
 *
 * Gamepad API не даёт событий вовсе — только уровень при опросе, — поэтому
 * фронт считаем сами. Кон и пауза обязаны срабатывать один раз на нажатие:
 * удержание крестовины иначе пролистало бы все три тира за десятую секунды,
 * а удержание Start мигало бы паузой шестьдесят раз в секунду.
 */
const PAD_UP = 1 << 0;
const PAD_DOWN = 1 << 1;
const PAD_START = 1 << 2;

interface Held {
  dash: number;
  take: number;
  cashOut: number;
}

export class InputSource {
  private readonly frame: InputFrame = makeFrame();
  private readonly keys = new Set<string>();
  private mouseX = 0;
  private mouseY = 0;
  private mouseDown = false;
  private readonly held: Held = { dash: 0, take: 0, cashOut: 0 };
  private firstInput: (() => void) | null = null;
  private pauseToggle: (() => void) | null = null;

  /**
   * Схема ввода — устройство ПОСЛЕДНЕГО действия, а не список подключённого.
   *
   * Считать схему по наличию геймпада нельзя: пад может лежать подключённым
   * весь вечер, пока играют мышью, и объявленная по нему «геймпадная» схема
   * выдала бы игроку пари, невыполнимое его руками (матрица «пари × схема»,
   * GDD §9.5). Поэтому схему меняет только сам ввод: нажатие клавиши, тап,
   * заметное движение мыши, отклонённый стик.
   *
   * До первого ввода — клавиатура: в вебе это самый частый вход, и она
   * равноправна с геймпадом по UX §1. Значение уезжает в маску КАЖДЫЙ кадр,
   * потому что схема — свойство кадра: игрок берётся за геймпад посреди
   * забега, и реплей обязан переиграть в том числе это (TECH §6).
   */
  private scheme: InputScheme = InputScheme.Keyboard;

  /** Абсолютный тир, запрошенный игроком с прошлого опроса. −1 — не запрошен. */
  private appetitePick = -1;
  /** Сдвиг тира: крестовина вверх-вниз и колесо двигают выбор от текущего. */
  private appetiteStep = 0;
  /** Кнопки пада прошлого опроса: см. `PAD_UP` — фронт считаем сами. */
  private padPrev = 0;

  /**
   * Позвать один раз, как только игрок что-нибудь нажал.
   *
   * Нужно звуку: Web Audio не запускается до жеста пользователя, и контекст,
   * созданный на загрузке, остаётся навсегда приостановленным.
   */
  onFirstInput(fn: () => void): void {
    this.firstInput = fn;
  }

  /**
   * Пауза — «везде и всегда» (UX §2), и в маску ввода она не едет.
   *
   * Пауза останавливает часы клиента, а не симуляцию: тик в реплее от неё не
   * меняется, и бит в кадре ввода означал бы, что запись зависит от того,
   * отходил ли игрок за чаем.
   */
  onPause(fn: () => void): void {
    this.pauseToggle = fn;
  }

  private touched(): void {
    if (!this.firstInput) return;
    const fn = this.firstInput;
    this.firstInput = null;
    fn();
  }

  attach(canvas: HTMLCanvasElement): void {
    window.addEventListener('keydown', (e) => {
      this.touched();
      // Множество нажатого — заодно и детектор фронта: автоповтор клавиатуры
      // шлёт keydown десятками в секунду, а выбор кона обязан быть одним
      // событием на одно нажатие.
      const fresh = !this.keys.has(e.code);
      this.keys.add(e.code);
      this.scheme = InputScheme.Keyboard;
      if (fresh) {
        this.appetiteKey(e.code);
        // Дубль паузы на `P` обязателен: в веб-сборке Esc выбивает из
        // полноэкранного режима и снимает захват курсора, и до игры он
        // доходит не всегда (UX §2).
        if (e.code === 'Escape' || e.code === 'KeyP') this.pauseToggle?.();
      }
      // Пробел и стрелки скроллят страницу — в игре это раздражает.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));

    /*
     * Потеря фокуса снимает ВЕСЬ ввод, а не только клавиши.
     *
     * Отпускание за пределами вкладки до неё не доходит: свернул игру с
     * зажатой кнопкой мыши — и `mouseup` уходит операционной системе, а игра
     * остаётся с намертво зажатым курком. Вернувшись, игрок стреляет без
     * нажатия и не может это прекратить, потому что отпускать уже нечего.
     *
     * `visibilitychange` нужен рядом с `blur` не для полноты: сворачивание
     * окна и переключение вкладки — разные события, и приходит из них не
     * всегда оба.
     */
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });

    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * 1920;
      const y = ((e.clientY - r.top) / r.height) * 1080;
      if (Math.hypot(x - this.mouseX, y - this.mouseY) > MOUSE_WAKE) {
        this.scheme = InputScheme.Keyboard;
      }
      this.mouseX = x;
      this.mouseY = y;
    });
    /*
     * Кнопки мыши разведены по номеру, а не свалены в одну.
     *
     * По UX §2 ЛКМ — огонь, ПКМ — рывок. Раньше `mousedown` выставлял курок
     * не глядя на `e.button`, а контекстное меню было подавлено, — и правая
     * кнопка молча стреляла вместо уворота: игрок жал «уйти с линии огня» и
     * получал ровно обратное. Отпускание тоже адресное, иначе `mouseup` от
     * одной кнопки снимал бы и другую.
     */
    canvas.addEventListener('mousedown', (e) => {
      this.touched();
      this.scheme = InputScheme.Keyboard;
      if (e.button === 0) this.mouseDown = true;
      // Рывок буферизуется по нажатию: удержание ПКМ не должно кувыркать
      // без остановки, как удержание Space его не кувыркает.
      if (e.button === 2) this.held.dash = BUFFER_TICKS;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseDown = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Колесо — второй путь к аппетиту на КБМ (UX §2). Вверх крупнее, вниз
    // скромнее: то же направление, что у крестовины, чтобы привычка одна.
    canvas.addEventListener(
      'wheel',
      (e) => {
        this.scheme = InputScheme.Keyboard;
        this.appetiteStep += e.deltaY < 0 ? 1 : -1;
      },
      { passive: true },
    );

    /*
     * Тач объявляется схемой, хотя виртуальных стиков ещё нет.
     *
     * Схема решает не только раскладку, но и то, какие пари игроку выдавать:
     * «Молчун» и «Не больше 20 выстрелов» на таче с автоогнём невыполнимы
     * (GDD §9.5). Промолчать здесь значило бы записать планшетного игрока
     * геймпадным — и в реплей, и в хеш состояния.
     */
    canvas.addEventListener(
      'touchstart',
      () => {
        this.touched();
        this.scheme = InputScheme.Touch;
      },
      { passive: true },
    );
  }

  /**
   * Клавиши выбора кона: `1`, `2`, `3` — по тиру на клавишу (UX §2).
   *
   * Ряд цифр, а не одна кнопка-перебор: схем управления две, и в обеих кон
   * выбирается АДРЕСНО — крестовиной на геймпаде, цифрой на клавиатуре.
   * Перебор по кругу одной клавишей был частью отменённой схемы «только
   * клавиатура»; мышь есть всегда, и заводить ради неё вторую логику выбора
   * значило бы держать в игре раскладку, которой никто не играет.
   */
  private appetiteKey(code: string): void {
    if (code === 'Digit1' || code === 'Numpad1') this.appetitePick = 0;
    else if (code === 'Digit2' || code === 'Numpad2') this.appetitePick = 1;
    else if (code === 'Digit3' || code === 'Numpad3') this.appetitePick = 2;
  }

  /**
   * Тир, который игрок выбрал с прошлого тика. −1 — не выбирал.
   *
   * `current` приходит из состояния симуляции, а не из памяти клиента, потому
   * что защёлка живёт там: начало комнаты возвращает кон в «Скромно»
   * (GDD §9.3), и относительный шаг обязан считаться от того значения, которое
   * действительно в силе, иначе крестовина через комнату промахивается.
   */
  private pickAppetite(current: number): number {
    let tier = this.appetitePick;
    /*
     * Шаг УПИРАЕТСЯ в край, а не переносится по кругу.
     *
     * Перенос стоил бы игроку кошелька: «скромнее» на нижнем тире прыгало бы
     * сразу в «по-крупному», то есть жест «поставлю поменьше» списывал бы
     * впятеро больше. Молчание при упоре — правильная цена: на клавиатуре
     * мимо неё есть прямой путь (цифра бьёт в тир адресно), а на геймпаде
     * крестовина доводит до края и там останавливается.
     */
    if (this.appetiteStep !== 0) {
      const from = tier >= 0 ? tier : current;
      tier = Math.max(0, Math.min(APPETITE_TIERS - 1, from + this.appetiteStep));
    }
    this.appetitePick = -1;
    this.appetiteStep = 0;
    return tier;
  }

  /**
   * Собрать кадр для игрока.
   *
   * `px`/`py` — его позиция в единицах арены, `appetite` — тир кона, который
   * сейчас держит защёлка симуляции (нужен относительному выбору).
   */
  poll(px: number, py: number, appetite: number): InputFrame {
    const pad = navigator.getGamepads?.()[0] ?? null;
    const f = this.frame;

    let mx = 0;
    let my = 0;
    let ax = 0;
    let ay = 0;
    let buttons = 0;

    if (pad) {
      const padButtons = pad.buttons.some((btn) => btn.pressed);
      if (padButtons) this.touched();
      [mx, my] = applyDeadzone(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
      [ax, ay] = applyDeadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
      /*
       * Геймпад забирает схему НЕ фактом подключения, а работой.
       *
       * Отклонённый стик считается работой наравне с нажатой кнопкой:
       * игрок, который держит направление, руки с пада не снял. Мёртвая
       * зона уже отсекла дрейф стика, поэтому лежащий на столе пад схему
       * не отбирает и мышь у игрока не отнимает.
       */
      if (padButtons || mx !== 0 || my !== 0 || ax !== 0 || ay !== 0) {
        this.scheme = InputScheme.Gamepad;
      }
      if ((pad.buttons[7]?.value ?? 0) > 0.5) buttons |= Btn.Fire;
      if (pad.buttons[0]?.pressed) this.held.dash = BUFFER_TICKS;
      if (pad.buttons[2]?.pressed) this.held.take = BUFFER_TICKS;
      if (pad.buttons[4]?.pressed) this.held.cashOut = BUFFER_TICKS;
      if (pad.buttons[3]?.pressed) buttons |= Btn.Accept;
      if (pad.buttons[1]?.pressed) buttons |= Btn.Decline;
      // Рассмотреть карту — удержание RT: тот же триггер, что огонь, только
      // долгий. Механики замедления в ядре ещё нет, но бит обязан быть в
      // маске — иначе действия не существует ни для сети, ни для реплея.
      if ((pad.buttons[7]?.value ?? 0) > 0.9) buttons |= Btn.Inspect;
      // Крестовина вверх-вниз двигает кон на тир, Start ставит паузу — и то
      // и другое строго по фронту нажатия.
      let level = 0;
      if (pad.buttons[PAD_DPAD_UP]?.pressed) level |= PAD_UP;
      if (pad.buttons[PAD_DPAD_DOWN]?.pressed) level |= PAD_DOWN;
      if (pad.buttons[PAD_START_BTN]?.pressed) level |= PAD_START;
      const fresh = level & ~this.padPrev;
      if ((fresh & PAD_UP) !== 0) this.appetiteStep += 1;
      if ((fresh & PAD_DOWN) !== 0) this.appetiteStep -= 1;
      if ((fresh & PAD_START) !== 0) this.pauseToggle?.();
      this.padPrev = level;
    } else {
      this.padPrev = 0;
    }

    // Клавиатура дополняет геймпад, а не спорит с ним: подключить пад
    // посреди игры можно, и раскладка не должна отваливаться.
    if (mx === 0 && my === 0) {
      const kx = (this.k('KeyD') ? 1 : 0) - (this.k('KeyA') ? 1 : 0);
      const ky = (this.k('KeyS') ? 1 : 0) - (this.k('KeyW') ? 1 : 0);
      [mx, my] = normalizeF(kx, ky);
    }
    /*
     * Прицел: стик, а если стика нет — мышь. Третьего пути нет намеренно.
     *
     * Схем управления две — геймпад и клавиатура с мышью, — и режима «только
     * клавиатура» не будет: мышь есть всегда. Прицел стрелками стоял здесь
     * ради него и был бы теперь хуже, чем бесполезен: стрелки перебивали бы
     * мышь у игрока, который просто задел их, а прицел мышью — единственный
     * прицел этой схемы.
     */
    if (ax === 0 && ay === 0) {
      [ax, ay] = normalizeF(this.mouseX - px, this.mouseY - py);
    }
    // Огонь — ЛКМ (UX §2). Клавиши огня нет по той же причине, что и прицела
    // стрелками: стрелять без мыши в этой игре некому.
    if (this.mouseDown) buttons |= Btn.Fire;
    if (this.k('Space')) this.held.dash = BUFFER_TICKS;
    if (this.k('KeyX')) this.held.take = BUFFER_TICKS;
    if (this.k('ShiftLeft') || this.k('ShiftRight')) this.held.cashOut = BUFFER_TICKS;
    if (this.k('KeyE')) buttons |= Btn.Accept;
    if (this.k('KeyQ')) buttons |= Btn.Decline;
    // Не `Alt`: он уводит фокус в меню браузера и ОС (UX §2).
    if (this.k('KeyF')) buttons |= Btn.Inspect;

    /*
     * Экранные действия: выбор, подтверждение, отказ.
     *
     * До этой правки биты `NavLeft`/`NavRight`/`Confirm`/`Cancel` существовали
     * только в ядре: экран двери читал их, а класть их в кадр было некому — и
     * единственное решение забега, принимаемое не под обстрелом, руками не
     * принималось вовсе. Боты жали его вслепую, поэтому прогоны шли, а человек
     * упирался в замерший бой.
     *
     * Биты уровневые, а не по фронту: ядро само считает фронт
     * (`pressed = buttons & ~pPrevButtons`), и удержание стика двигает фокус
     * ровно на один элемент.
     */
    for (const b of SCREEN_BINDINGS) {
      if (b.axis !== 0 && b.axis * mx > NAV_AXIS) buttons |= b.bit;
      for (const code of b.keys) if (this.k(code)) buttons |= b.bit;
      if (!pad) continue;
      for (const i of b.pad) if (pad.buttons[i]?.pressed) buttons |= b.bit;
    }

    // Буферизованные действия срабатывают один раз и гаснут — так раннее
    // нажатие прощается, но не залипает.
    if (this.held.dash > 0) {
      buttons |= Btn.Dash;
      this.held.dash--;
    }
    if (this.held.take > 0) {
      buttons |= Btn.Take;
      this.held.take--;
    }
    if (this.held.cashOut > 0) {
      buttons |= Btn.CashOut;
      this.held.cashOut--;
    }

    /*
     * Аппетит: два бита на три тира — и нулевые биты означают «ничего не
     * нажато», а не «выбран нижний тир».
     *
     * Защёлка в ядре меняет `pAppetite` только когда игрок ЯВНО выбрал тир,
     * иначе отпущенная крестовина сбрасывала бы кон обратно каждый тик. Чтобы
     * молчание отличалось от выбора, кодировка сдвинута на единицу: ноль в
     * битах — «ничего не нажимаю», единица и дальше — тиры. Поэтому все три
     * тира выбираются явно, включая «Скромно», а укладкой занимается
     * `withAppetite` из ядра — своей правды о коне клиент не заводит.
     */
    const tier = this.pickAppetite(appetite);
    if (tier >= 0) buttons = withAppetite(buttons, tier);

    // Схема ввода едет в КАЖДОМ кадре: это его свойство, а не настройка
    // клиента (TECH §6). Ядро зеркалит её в `pScheme`, и по ней раскладка
    // решает, какие пари игроку вообще предлагать (GDD §9.5).
    buttons |= this.scheme << SCHEME_SHIFT;

    f.moveX = fromFloat(mx);
    f.moveY = fromFloat(my);
    f.aimX = fromFloat(ax);
    f.aimY = fromFloat(ay);
    f.buttons = buttons;
    return f;
  }

  /** Схема, которой играют прямо сейчас: нужна интерфейсу для глифов кнопок. */
  get inputScheme(): InputScheme {
    return this.scheme;
  }

  /** Снять всё удерживаемое: клавиши, мышь и буферизованные нажатия. */
  private releaseAll(): void {
    this.keys.clear();
    this.mouseDown = false;
    this.held.dash = 0;
    this.held.take = 0;
    this.held.cashOut = 0;
  }

  private k(code: string): boolean {
    return this.keys.has(code);
  }
}

/** Радиальная мёртвая зона с ремапом остатка в 0..1. */
function applyDeadzone(x: number, y: number): [number, number] {
  const len = Math.hypot(x, y);
  if (len < DEADZONE) return [0, 0];
  const scaled = (len - DEADZONE) / (1 - DEADZONE);
  return [(x / len) * scaled, (y / len) * scaled];
}

function normalizeF(x: number, y: number): [number, number] {
  const len = Math.hypot(x, y);
  if (len === 0) return [0, 0];
  return [x / len, y / len];
}

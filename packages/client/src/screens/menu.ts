/**
 * Экраны меню, паузы, настроек и справки.
 *
 * Функции над `RenderKit` — методы не завязаны на состояние батча/арены,
 * доступное через `kit` (см. `renderer.ts` для контракта). Перенос почти
 * буквальный: тела методов не менялись, только `this.` → `kit.`.
 */
import { APPETITE, InputScheme } from '@dod/sim';
import { t, type StringKey } from '../i18n';
import { PALETTE } from '../palette';
import { lineStep, SCREEN, TEXT } from '../typography';
import { MENU_PLAY_BUTTON, MENU_SETTINGS_BUTTON, PAUSE_BUTTONS } from '../menuLayout';
import type { RenderKit, MenuOverlay } from '../renderer';

/**
 * Главное меню: одна крупная кнопка «Играть», остальное мельче (UX §6).
 *
 * Выбора персонажа и сложности здесь нет и в 0.4.0 не будет — на нулевой
 * секунде игрок жмёт одну кнопку и оказывается в бою (GDD §23). «Выбор
 * режима», обещанный той же таблицей после первого забега, не нарисован
 * намеренно: режимов до кооперативa 0.5.0 не существует, а кнопка, которая
 * ничего не делает, дороже отсутствующей (UX §2).
 *
 * Второй элемент — «Настройки» — появился вместе с поштучным забором:
 * первой настройкой, которую вообще есть где переключить. Фокус между
 * ними — горизонталь (`NavLeft`/`NavRight`, `loop.ts`), «Играть» им не
 * теряет доминирования: она крупнее и стоит первой по чтению слева направо.
 */
export function drawMenuScreen(kit: RenderKit, w: number, h: number, overlay: MenuOverlay): void {
  kit.dim(w, h);
  kit.screenTitle(t('menu.title'), w, h / 2 - 190, TEXT.hero);
  kit.screenLine(t('menu.tagline'), w, h / 2 - 120, PALETTE.hudDim, TEXT.subtitle);

  // Кнопка крупная не для красоты: она главная, и её размер — весь ответ
  // на вопрос «что тут делать в первую очередь». Прямоугольник общий с
  // `loop.ts` (клик, наведение) — см. `menuLayout.ts`.
  const playX = w / 2 + MENU_PLAY_BUTTON.dx;
  const c = kit.screenCard(
    playX,
    h / 2,
    MENU_PLAY_BUTTON.halfW,
    MENU_PLAY_BUTTON.halfH,
    overlay.focus === 0,
  );
  kit.label(t('menu.play'), playX, h / 2, TEXT.button, c);

  const settingsX = w / 2 + MENU_SETTINGS_BUTTON.dx;
  const cs = kit.screenCard(
    settingsX,
    h / 2,
    MENU_SETTINGS_BUTTON.halfW,
    MENU_SETTINGS_BUTTON.halfH,
    overlay.focus === 1,
  );
  kit.label(t('menu.settings'), settingsX, h / 2, TEXT.card, cs);

  // Клик работает только на этом экране (боя тут точно нет), поэтому
  // подсказка своя, а не общий confirmHint (UX §2).
  const pad = kit.scheme === InputScheme.Gamepad;
  kit.screenLine(
    pad ? t('screen.confirm.pad') : t('menu.confirm.key'),
    w,
    h / 2 + 130,
    PALETTE.hudDim,
  );
  kit.screenLine(
    pad ? t('menu.tutorial.pad') : t('menu.tutorial.key'),
    w,
    h / 2 + 130 + SCREEN.hintStep,
    PALETTE.hudDim,
  );
}

/**
 * Пауза: часы забега остановлены, и об этом сказано экраном.
 *
 * До этого пауза была НЕВИДИМОЙ: `Esc` останавливал часы, а надпись «ПАУЗА»
 * жила в отладочном оверлее, который в релизе скрыт. Со стороны это выглядит
 * замершим кадром без причины — тем же способом, каким однажды уже выглядела
 * остановка по нарушенному инварианту, и вечер ушёл на поиск несуществующей
 * кнопки.
 *
 * Отсюда же открываются настройки и справка: UX §5 требует настройки из
 * паузы («не только из главного меню»), а UX §7 — глоссарий по подсказке на
 * паузе. Главного меню в забеге нет вовсе, и без этого экрана обе двери были
 * закрыты до перезагрузки страницы.
 */
export function drawPauseScreen(kit: RenderKit, w: number, h: number, overlay: MenuOverlay): void {
  kit.dim(w, h);
  kit.screenTitle(t('pause.title'), w, h / 2 + SCREEN.titleY);
  kit.screenLine(t('pause.hint'), w, h / 2 + SCREEN.subtitleY, PALETTE.hudDim, TEXT.subtitle);

  const items: StringKey[] = ['pause.resume', 'settings.title', 'tutorial.title'];
  for (let i = 0; i < items.length; i++) {
    // Прямоугольники общие с кликом и наведением (`menuLayout.ts`): у меню
    // они уже один раз разъехались с отрисовкой, и второй раз заводить ту
    // же ошибку незачем.
    const btn = PAUSE_BUTTONS[i];
    const x = w / 2 + btn.dx;
    const c = kit.screenCard(x, h / 2, btn.halfW, btn.halfH, overlay.pauseFocus === i);
    kit.label(t(items[i]), x, h / 2, TEXT.card, c);
  }

  kit.selectHint(w, h / 2 + SCREEN.hintY);
  kit.confirmHint(w, h / 2 + SCREEN.hintY + SCREEN.hintStep);
}

/**
 * Настройки: сегодня один пункт — поштучный забор пари (доступность).
 *
 * Экран заведён под один тумблер, а не под три вкладки из UX §6, — те три
 * (Игра / Управление / Доступность) появятся вместе со вторым и третьим
 * пунктом, которого сегодня нет ни одного. Пустая вкладка хуже отсутствующей
 * (UX §2).
 */
export function drawSettingsScreen(
  kit: RenderKit,
  w: number,
  h: number,
  overlay: MenuOverlay,
): void {
  kit.dim(w, h);
  kit.screenTitle(t('settings.title'), w, h / 2 + SCREEN.titleY);

  /*
   * Пункты списком, а не одним тумблером.
   *
   * Пунктов стало два, и «подтверждение переключает единственную строку»
   * перестало работать: горизонталь выбирает пункт, подтверждение меняет
   * его значение. Вкладок (Игра / Управление / Доступность) по-прежнему
   * нет — их заводят, когда пунктов станет столько, что список перестанет
   * читаться целиком (UX §6).
   */
  const items: [string, string][] = [
    [
      t(overlay.cashOutFocusedOnly ? 'settings.cashout_focus.on' : 'settings.cashout_focus.off'),
      kit.scheme === InputScheme.Gamepad
        ? t('settings.cashout_focus.desc.pad')
        : t('settings.cashout_focus.desc.key'),
    ],
    [t('settings.ui_scale', { value: overlay.uiScale }), t('settings.ui_scale.desc')],
  ];

  const step = 200;
  const top = h / 2 - 90;
  for (let i = 0; i < items.length; i++) {
    const y = top + i * step;
    const c = kit.screenCard(w / 2, y, 460, 78, overlay.settingsFocus === i);
    kit.label(items[i][0], w / 2, y - 26, TEXT.card, c);
    kit.wrapped(items[i][1], w / 2, y + 26, 840, TEXT.body, PALETTE.hudDim);
  }

  kit.screenLine(t('settings.hint'), w, h / 2 + SCREEN.hintY, PALETTE.hudDim);
  kit.cancelHint(w, h / 2 + SCREEN.hintY + SCREEN.hintStep);
}

/**
 * Туториал/глоссарий: карточка на термин, название и одна строка объяснения.
 *
 * Не заменяет обучение действием (§23 GDD) — это резервный текстовый путь
 * для тех, кому первых 10 минут не хватило (playtest 0.3.1: 20 забегов, и
 * смысл механик так и не сложился). Открывается из меню, ничего не решает,
 * закрывается тем же отказом, что и открылся (UX §7).
 */
export function drawTutorialScreen(
  kit: RenderKit,
  w: number,
  h: number,
  overlay: MenuOverlay,
): void {
  kit.dim(w, h);
  if (overlay.tutorialControls) {
    drawControlsPage(kit, w, h);
    return;
  }
  /*
   * Двенадцать терминов, а не девять.
   *
   * Не хватало ровно того словаря, которым подписаны все числа на плашках:
   * «Забрать» — центрального глагола игры, «Кон» и «Фишки». Игрок читал
   * справку и всё равно не знал, что означает растущее число рядом с
   * кольцом в бою.
   */
  const terms: [StringKey, StringKey][] = [
    ['tutorial.ace.name', 'tutorial.ace.desc'],
    ['tutorial.bet.name', 'tutorial.bet.desc'],
    ['tutorial.stake.name', 'tutorial.stake.desc'],
    ['tutorial.appetite.name', 'tutorial.appetite.desc'],
    ['tutorial.cashout.name', 'tutorial.cashout.desc'],
    ['tutorial.chips.name', 'tutorial.chips.desc'],
    ['tutorial.house_cut.name', 'tutorial.house_cut.desc'],
    ['tutorial.trampoline.name', 'tutorial.trampoline.desc'],
    ['tutorial.debt_pit.name', 'tutorial.debt_pit.desc'],
    ['tutorial.keys.name', 'tutorial.keys.desc'],
    ['tutorial.fat_fight.name', 'tutorial.fat_fight.desc'],
    ['tutorial.gift.name', 'tutorial.gift.desc'],
  ];

  /*
   * Раскладка считается, а не вписана числами.
   *
   * Вписанной она разъезжалась дважды и в обе стороны: подзаголовок стоял на
   * фиксированной высоте, а сетка начиналась выше, чем он кончался, — и
   * «Термины стола — коротко» читалось поверх первого ряда карточек; при
   * 150% та же сетка вылезала за оба края экрана, и крайние столбцы теряли
   * по слову. Высота карточки берётся из числа строк описания (их считает
   * `wrapLines`), высота экрана — из суммы блоков, и каждый следующий блок
   * ставится под предыдущим, а не по памяти о том, где предыдущий кончался.
   */
  const cols = 3;
  const rows = Math.ceil(terms.length / cols);
  const cardW = 500;
  const gutter = 60;
  const wrapW = cardW - 60;
  const padY = 26;
  const nameGap = 12;
  const rowGap = 22;
  const nameStep = lineStep(TEXT.card);
  const descStep = lineStep(TEXT.body);

  // Тиры аппетита подставляются из конфига, а не вписаны в строку: баланс
  // правит их в одном месте, а не в двух, забывая про второе.
  const descs = terms.map(([, descKey]) =>
    descKey === 'tutorial.appetite.desc'
      ? t(descKey, { tier1: APPETITE[0], tier2: APPETITE[1], tier3: APPETITE[2] })
      : t(descKey),
  );
  const lines = descs.map((d) => Math.max(1, kit.wrapLines(d, wrapW, TEXT.body).length));

  // Ряд высок ровно настолько, насколько высока его самая многословная
  // карточка: соседи по ряду обязаны стоять одной высотой, а вот соседние
  // ряды — нет, и на этом экономится полсотни единиц по вертикали.
  const rowH: number[] = [];
  for (let r = 0; r < rows; r++) {
    let maxLines = 1;
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (i < lines.length) maxLines = Math.max(maxLines, lines[i]);
    }
    rowH.push(padY * 2 + nameStep + nameGap + maxLines * descStep);
  }

  const gridH = rowH.reduce((a, b) => a + b, 0) + rowGap * (rows - 1);
  const gridW = cols * cardW + (cols - 1) * gutter;
  const titleH = lineStep(TEXT.title);
  const subH = lineStep(TEXT.subtitle);
  const hintH = lineStep(TEXT.body);
  const blockH = titleH + 16 + subH + 34 + gridH + 34 + hintH * 2;

  kit.withUiScale(kit.fitScale(gridW + 64, blockH + 48), () => {
    let y = h / 2 - blockH / 2;
    kit.screenTitle(t('tutorial.title'), w, y + titleH / 2);
    y += titleH + 16;
    kit.screenLine(t('tutorial.hint'), w, y + subH / 2, PALETTE.hudDim, TEXT.subtitle);
    y += subH + 34;

    for (let r = 0; r < rows; r++) {
      const top = y;
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (i >= terms.length) break;
        const x = w / 2 + (c - (cols - 1) / 2) * (cardW + gutter);
        const card = kit.screenCard(x, top + rowH[r] / 2, cardW / 2, rowH[r] / 2, false);
        kit.label(t(terms[i][0]), x, top + padY + nameStep / 2, TEXT.card, card);
        kit.wrapped(
          descs[i],
          x,
          top + padY + nameStep + nameGap + (lines[i] * descStep) / 2,
          wrapW,
          TEXT.body,
          PALETTE.hudDim,
        );
      }
      y += rowH[r] + rowGap;
    }

    y += 34 - rowGap;
    kit.screenLine(t('tutorial.page.hint'), w, y + hintH / 2, PALETTE.hudDim);
    kit.cancelHint(w, y + hintH + hintH / 2);
  });
}

/**
 * Вторая страница справки — управление, обе схемы разом.
 *
 * Единственное место в игре, где названы WASD, мышь, `X` и `Shift`. До неё
 * управление не называлось нигде: игрок узнавал о подборе карты по глифу над
 * ней, а о «Забрать» — ниоткуда, при том что это центральный глагол игры.
 *
 * Колонки ОБЕ и всегда, а не по текущей схеме ввода: таблица UX §2 не имеет
 * права на пустую клетку, и справка — то место, где это видно глазом. Игрок
 * с падом в руках заодно видит, что мышью то же самое доступно.
 */
export function drawControlsPage(kit: RenderKit, w: number, h: number): void {
  const rows: [StringKey, StringKey, StringKey][] = [
    ['controls.move', 'controls.move.pad', 'controls.move.key'],
    ['controls.aim', 'controls.aim.pad', 'controls.aim.key'],
    ['controls.fire', 'controls.fire.pad', 'controls.fire.key'],
    ['controls.dash', 'controls.dash.pad', 'controls.dash.key'],
    ['controls.take', 'controls.take.pad', 'controls.take.key'],
    ['controls.cashout', 'controls.cashout.pad', 'controls.cashout.key'],
    ['controls.appetite', 'controls.appetite.pad', 'controls.appetite.key'],
    ['controls.screen', 'controls.screen.pad', 'controls.screen.key'],
    ['controls.cancel', 'controls.cancel.pad', 'controls.cancel.key'],
    ['controls.pause', 'controls.pause.pad', 'controls.pause.key'],
  ];

  /*
   * Ширина таблицы — её собственная, и она же зажимает масштаб.
   *
   * Три колонки по 460 единиц расходятся от центра, и при 150% левая уезжала
   * за край экрана вместе с названием действия, а нижние подсказки — под
   * него. Считаем, что таблице нужно, и просим у `fitScale` столько
   * увеличения, сколько под это есть места.
   */
  const colW = 460;
  const step = 54;
  const titleH = lineStep(TEXT.title);
  const headH = lineStep(TEXT.card);
  const hintH = lineStep(TEXT.body);
  const tableH = headH + 52 + (rows.length - 1) * step;
  const blockH = titleH + 34 + tableH + 40 + hintH * 2;

  kit.withUiScale(kit.fitScale(colW * 3 + 64, blockH + 48), () => {
    let y = h / 2 - blockH / 2;
    kit.screenTitle(t('tutorial.page.controls'), w, y + titleH / 2);
    y += titleH + 34;

    const colAction = w / 2 - colW * 1.5;
    const colPad = w / 2 - colW / 2;
    const colKey = w / 2 + colW / 2;
    const head = y + headH / 2;

    const dim = PALETTE.hudDim;
    const bright = PALETTE.hudText;
    kit.label(t('controls.pad'), colPad, head, TEXT.card, bright, 'left');
    kit.label(t('controls.key'), colKey, head, TEXT.card, bright, 'left');

    for (let i = 0; i < rows.length; i++) {
      const ry = head + 52 + i * step;
      const [action, padKey, keyKey] = rows[i];
      kit.label(t(action), colAction, ry, TEXT.body, dim, 'left', 0.9);
      kit.label(t(padKey), colPad, ry, TEXT.body, bright, 'left', 0.95);
      kit.label(t(keyKey), colKey, ry, TEXT.body, bright, 'left', 0.95);
    }

    y += tableH + 40;
    kit.screenLine(t('tutorial.page.hint'), w, y + hintH / 2, PALETTE.hudDim);
    kit.cancelHint(w, y + hintH + hintH / 2);
  });
}

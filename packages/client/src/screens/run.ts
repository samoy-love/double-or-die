/**
 * Экраны прогонки: дверь, лавка, плата заведению, итоги, расчёт, ставка Крупье.
 *
 * Большинство функций — над `RenderKit` (см. `renderer.ts` за контрактом),
 * ровно как экраны меню. Часть экранов (`drawDoorScreen`, `drawAppetite`,
 * `drawShopScreen`, `drawHouseCutScreen`, `drawSettlement`, `drawAceBetScreen`)
 * читают `batch`/`text` напрямую и зовут `drawAce` (`screens/ace.ts`) — то,
 * что в `RenderKit` не входит (см. `renderer.ts`, комментарий к интерфейсу),
 * — и принимают вместо кита сам `Renderer` (он реализует и `RenderKit`,
 * второго параллельного интерфейса не заводим). Перенос почти буквальный:
 * тела методов не менялись, только `this.` → `r.`/`kit.`.
 */
import {
  aceCardAt,
  aceStakeFor,
  APPETITE,
  BETS,
  BetProgress,
  BetState,
  DoorType,
  MAX_DOORS,
  HOUSE,
  MAX_ACTIVE_BETS,
  SHOP_SLOTS,
  giftOpen,
  ROOMS_PER_FLOOR,
  FX_ONE,
  cashOutValue,
  nearMissOf,
  InputScheme,
  KEYS,
  Meta,
  Obligation,
  summaryLineCount,
  TICK_HZ,
  type SimState,
} from '@dod/sim';
import type { Feedback } from '../feedback';
import { againButtonFor } from '../menuLayout';
import { Shape, type ShapeBatch } from '../gl/batch';
import { Face } from '../gl/text';
import { t, type StringKey } from '../i18n';
import { ENTITY_FILL, PALETTE, type Rgb } from '../palette';
import { lineStep, SCREEN, TEXT } from '../typography';
import { BUILD } from '../version';
import { entity, drawNumber, drawMultiplier } from '../gl/primitives';
import {
  walletOf,
  buybackOf,
  categoryColour,
  drawBetIcon,
  betName,
  upgradeName,
  upgradeDesc,
  doorTypeName,
  doorTypeHint,
  drawDoorIcon,
  settlementRows,
  settlementHasActive,
} from './betHelpers';
import type { RenderKit, Renderer } from '../renderer';
import { drawAce } from './ace';

/**
 * Выбор двери: три карточки, выбранная — золотом.
 *
 * Золото здесь то же, что подсвечивает ближайшую карту на арене: «вот это
 * возьмётся, если нажать». Игрок уже выучил его в бою, и заводить второй
 * язык подсветки ради экрана значило бы учить заново.
 */
export function drawDoorScreen(r: Renderer, s: SimState, w: number, h: number): void {
  r.screenBase(w, h, PALETTE.accent);
  /*
   * Раскладка считается от КРОМОК, а не от центра.
   *
   * Нижняя граница — блок подсказок, прижатый к кромке (UX §4): две строки,
   * «выбрать» и «подтвердить». Над ним снизу вверх встают плитки аппетита,
   * над ними ряд дверей. Пока всё стояло на смещениях от `h / 2`, тело
   * экрана росло вниз и выдавливало подсказки: на 1280×800 «Enter/Tab —
   * подтвердить» срезалась по середине букв, а при 150% пропадала целиком.
   */
  const hintsY = r.hintsTop(2);
  const appetiteY = hintsY - 172;
  const cardY = h / 2 - 78;
  const halfW = 150;
  const gap = 420;
  const saved = r.beginScreen(gap + halfW, h / 2 + SCREEN.titleY - TEXT.title, hintsY + 24);

  // Титул и подсказка — на общих полосах каркаса (`SCREEN`), как у всех
  // экранов: заголовок обязан стоять там же, где на предыдущем, иначе он
  // прыгает по экрану при каждом переходе.
  r.screenTitle(t('door.title'), w, h / 2 + SCREEN.titleY);
  r.screenLine(t('door.hint'), w, h / 2 + SCREEN.subtitleY, PALETTE.hudDim, TEXT.subtitle);

  /*
   * Где игрок находится — строкой под подсказкой.
   *
   * Дверь и тир кона выбирались без единой цифры о собственном положении:
   * ни этажа, ни комнаты, ни кошелька (боевой HUD в этот момент под
   * затемнением). «Заведение не возвращает выбор» — это интонация, а не
   * сведения, по которым выбор делают.
   */
  r.screenLine(
    t('door.where', {
      floor: s.meta[Meta.Floor],
      room: s.meta[Meta.Room],
      rooms: ROOMS_PER_FLOOR,
      chips: walletOf(s),
    }),
    w,
    h / 2 + SCREEN.subtitleY + 40,
    PALETTE.hudDim,
  );

  const pick = s.meta[Meta.DoorPick];
  /*
   * Шаг между дверями считается от их ширины, а не подбирается.
   *
   * Имя двери набрано телом шкалы (24), подпись — им же в две строки, и
   * прежние 250 единиц шага при полуширине 96 оставляли под подпись 230 —
   * то есть «Бой, а после — три апгрейда на выбор» ложилось в четыре
   * строки и налезало на соседнюю дверь.
   */
  const nameY = cardY + 148;
  /*
   * Подписи трёх дверей выровнены по ВЕРХУ блока, а не по его центру.
   *
   * Три равноправных варианта одного выбора читаются одним рядом: у
   * «Жирного боя» описание в две строки, у «Боя» в одну, и центрирование
   * опускало однострочное на полстроки ниже соседних — ряд выглядел
   * сбитым, хотя разница была только в длине текста. Высота блока берётся
   * из числа строк (UX §5), а не подбирается.
   */
  const hintTop = nameY + 42;
  for (let i = 0; i < MAX_DOORS; i++) {
    const x = w / 2 + (i - (MAX_DOORS - 1) / 2) * gap;
    const chosen = i === pick;
    const colour = r.screenCard(x, cardY, halfW, 140, chosen);
    drawDoorIcon(
      r.batch,
      s.doorType[i] as DoorType,
      r.sx(x),
      r.sy(cardY),
      colour,
      chosen ? 1 : 0.85,
      r.getUiScale(),
    );
    r.label(
      doorTypeName(s.doorType[i] as DoorType),
      x,
      nameY,
      TEXT.card,
      colour,
      'center',
      chosen ? 1 : 0.85,
    );
    /*
     * Подпись под именем — у каждой двери, не только у Долговой ямы.
     *
     * «Жирный бой» и «Лавка» новичку говорят не больше пустого имени: без
     * пояснения он выбирает дверь по названию наугад, а не по содержанию
     * (UX §1.2 — контекст виден всегда). Долговая яма отличалась раньше не
     * потому, что важнее прочих, а потому, что первой получила жалобу —
     * остальные четыре молчали тем же молчанием, просто его не заметили.
     */
    const hint = doorTypeHint(s.doorType[i] as DoorType);
    if (hint) r.wrappedTop(hint, x, hintTop, gap - 60, TEXT.body, colour, 0.85);
  }
  drawAppetite(r, s, w, appetiteY);
  r.selectHint(w, hintsY);
  r.confirmHint(w, hintsY + SCREEN.hintStep);
  r.setUiScale(saved);
}

/**
 * Аппетит — три плитки на экране двери, где его и выбирают.
 *
 * UX §2 и §6 помещают выбор тира сюда и сброс в «Скромно» — на открытие
 * двери. На экране при этом не было ни плиток, ни текущего тира, ни имени
 * клавиши: решение, объявленное настоящим (ECONOMY §7), принималось
 * вслепую — единственная его индикация, три пипса в боевом HUD, в этот
 * момент лежит под затемнением экрана.
 *
 * Числа тиров берутся из конфига, а не вписаны: баланс правит их в одном
 * месте (`APPETITE`), и вторая копия молча разошлась бы с первой.
 */
export function drawAppetite(r: Renderer, s: SimState, w: number, y: number): void {
  const pad = r.scheme === InputScheme.Gamepad;
  r.screenLine(t('appetite.title'), w, y, PALETTE.hudDim, TEXT.body);

  const tiers: StringKey[] = ['appetite.tier.1', 'appetite.tier.2', 'appetite.tier.3'];
  const current = s.pAppetite[0];
  const purse = walletOf(s);
  const gap = 340;
  for (let i = 0; i < tiers.length; i++) {
    const x = w / 2 + (i - (tiers.length - 1) / 2) * gap;
    /*
     * Недостижимый тир гасится штриховкой, как и всё недоступное на этих
     * экранах (`docs/UX.md` §5) — раньше «По-крупному 50» при кошельке 30
     * выглядело обычной доступной плиткой, хотя `stakeFor()` реально
     * списывает `min(50, кошелёк)=30`: решение объявлено настоящим
     * (ECONOMY §7), и число рядом с ним обязано быть тем самым, что спишут.
     */
    const affordable = APPETITE[i] <= purse;
    const c = r.screenCard(x, y + 60, 150, 38, i === current, affordable);
    // Имя тира слева, число кона справа: они не спорят за середину плитки,
    // и «По-крупному» перестаёт налезать на «50».
    r.label(t(tiers[i]), x - 118, y + 60, TEXT.body, c, 'left', affordable ? 1 : 0.85);
    drawNumber(r.batch, Math.min(APPETITE[i], purse), r.sx(x + 112), r.sy(y + 60), r.sz(15), c);
  }

  r.screenLine(pad ? t('appetite.hint.pad') : t('appetite.hint.key'), w, y + 112, PALETTE.hudDim);
}

/**
 * Лавка: три карточки товара с ценой (UX §6, GDD §5).
 *
 * Экран читает состояние и ничего не решает: что лежит в слоте
 * (`shopItem`, индекс апгрейда плюс единица), сколько просят (`shopPrice`) и
 * что уже куплено (`pUpgrades`). Пустой слот — проданный товар, и он
 * остаётся на экране пустой рамкой: исчезнувшая карточка сдвинула бы
 * соседние под пальцем игрока.
 *
 * Имя товара — из словаря по ключу `upgrade.<id>.name` (`upgradeName`
 * ниже): `name` в `content/upgrades.json` служебный и не переводится,
 * подписывать им витрину значило бы выдумывать текст в коде мимо словаря
 * (UX §8).
 *
 * Цена красится алым, когда не хватает: решение здесь одно — «беру или
 * коплю», — и оно считается в уме из двух чисел, цены и кошелька.
 */
export function drawShopScreen(r: Renderer, s: SimState, w: number, h: number): void {
  r.dim(w, h);
  /*
   * «Дар» — не лавка, и называть себя лавкой не имеет права.
   *
   * Экран один на обе двери (`RunPhase.Reward`), и до сих пор он всегда
   * писал «Лавка · Заведение не торгуется», а `priceTag` рисовал каждому
   * подарку золотой ценник «0». Бесплатный подарок выглядел товаром по
   * нулевой цене, да ещё и с предложением «уйти без покупки».
   */
  const gift = giftOpen(s);
  r.screenTitle(gift ? t('gift.title') : t('shop.title'), w, h / 2 + SCREEN.titleY);
  r.screenLine(
    gift ? t('gift.hint') : t('shop.hint'),
    w,
    h / 2 + SCREEN.subtitleY,
    PALETTE.hudDim,
    TEXT.subtitle,
  );

  const purse = walletOf(s);
  const pick = s.meta[Meta.DoorPick];
  // Шаг и полуширина — те же, что у дверей: витрина и дверь показывают одно
  // и то же действие («выбери одно из трёх»), и разная сетка читалась бы
  // как разный по смыслу экран.
  const gap = 420;
  const cardY = h / 2 - 60;

  for (let i = 0; i < SHOP_SLOTS; i++) {
    const x = w / 2 + (i - (SHOP_SLOTS - 1) / 2) * gap;
    const item = s.shopItem[i];
    const sold = item === 0;
    const price = s.shopPrice[i];
    const afford = !sold && price <= purse;
    const c = r.screenCard(x, cardY, 150, 160, i === pick, !sold);

    if (sold) {
      r.label(t('shop.sold'), x, cardY, TEXT.body, c, 'center', 0.85);
      continue;
    }

    // Пиктограмма товара — «плюс в кольце»: апгрейд прибавляет. Форма
    // общая на все шесть намеренно: своих пиктограмм у апгрейдов нет, а
    // выдуманная «на глаз» врала бы о том, что именно покупают, — имя под
    // ней говорит это точно.
    // Кольцо меньше прежнего: на карточке теперь три уровня текста — имя в
    // две строки, описание в две и цена, — и место для них взято у
    // пиктограммы, одинаковой у всех шести товаров.
    const ring = 24;
    const iconY = cardY - 118;
    r.batch.push(
      Shape.Ring,
      r.sx(x),
      r.sy(iconY),
      r.sz(ring),
      r.sz(ring),
      0,
      0,
      0,
      0,
      0,
      r.sz(4),
      c.r,
      c.g,
      c.b,
      1,
    );
    r.batch.push(
      Shape.Box,
      r.sx(x),
      r.sy(iconY),
      r.sz(11),
      r.sz(3),
      0,
      c.r,
      c.g,
      c.b,
      1,
      0,
      0,
      0,
      0,
      0,
    );
    r.batch.push(
      Shape.Box,
      r.sx(x),
      r.sy(iconY),
      r.sz(3),
      r.sz(11),
      0,
      c.r,
      c.g,
      c.b,
      1,
      0,
      0,
      0,
      0,
      0,
    );

    /*
     * Имя товара — из словаря по идентификатору каталога, как у пари.
     *
     * `name` в `content/upgrades.json` служебный: он для отчётов
     * балансировщика и сценариев и не переводится. Английская сборка,
     * взявшая его на витрину, показала бы «Кулдаун рывка −30%».
     *
     * Строка переносится по словам: «Кулдаун рывка −30%» в карточку шириной
     * 200 единиц не влезает ни в одном языке, а немецкий держит +40%
     * (UX §4). Резать многоточием нечего — товар опознаётся именно именем.
     */
    r.wrapped(upgradeName(item - 1), x, cardY - 50, 270, TEXT.card, c);
    /*
     * Что апгрейд делает — строкой под именем.
     *
     * «Магнит» и «Дроп +48%» новичку не говорят ничего: двери пояснение уже
     * получили (UX §1.2 — контекст виден всегда), а витрина, где расстаются
     * с фишками, стояла с голыми именами.
     */
    r.wrapped(upgradeDesc(item - 1), x, cardY + 40, 280, TEXT.body, PALETTE.hudDim, 0.85);
    // Цена терракотой, когда не хватает: тот же экономический минус, что и
    // недостача на плате заведению, near-miss и кон Крупье (PALETTE.loss) —
    // алый (`danger`) занят объявленной атакой и здесь означал бы то же,
    // что и телеграф удара, хотя опасности тут никакой нет.
    if (!gift) r.priceTag(price, x, cardY + 118, 20, afford ? PALETTE.chip : PALETTE.loss);
  }

  // Зазор до подсказок: число кошелька набрано крупно, и подсказка,
  // поставленная вплотную, читается его подписью, а не отдельной строкой.
  // У Дара кошелёк ни при чём: он ничего не спишет.
  const next = gift
    ? h / 2 + 200
    : r.screenValue(t('house.purse'), purse, w, h / 2 + 150, 22, PALETTE.chip) + 20;
  r.selectHint(w, next);
  r.confirmHint(w, next + SCREEN.hintStep);
  // Уйти без покупки — законное решение, и о нём надо сказать: фишки
  // конвертируются в ключи в конце забега (ECONOMY §12), и «унести»
  // конкурирует с «потратить» на равных.
  if (!gift) {
    r.screenLine(t('shop.leave'), w, next + SCREEN.hintStep * 2);
    r.cancelHint(w, next + SCREEN.hintStep * 3);
  }
}

/**
 * Плата в конце этажа и торг, если не хватило.
 *
 * Пока хватает, решение одно и экран отвечает тремя числами: сколько просят,
 * сколько есть, что будет по нажатию. Не хватило — это уже не отказ в
 * обслуживании, а торг: Крупье выкладывает три выхода (GDD §12А.2), и экран
 * обязан показать все три, включая тот, которым игрок не воспользуется.
 *
 * Продажа апгрейда гаснет, когда продавать нечего: вариант, недоступный по
 * состоянию, обязан выглядеть недоступным — иначе игрок ищет причину в
 * кнопке, а её там нет.
 */
export function drawHouseCutScreen(r: Renderer, s: SimState, w: number, h: number): void {
  r.dim(w, h);
  const purse = walletOf(s);
  const cut = s.meta[Meta.HouseCut];
  const enough = purse >= cut;

  r.screenTitle(enough ? t('house.title') : t('haggle.title'), w, h / 2 + SCREEN.titleY);
  // Заголовок называет ЧТО происходит, подпись — ПОЧЕМУ: без нужного
  // разъяснения число «Доля заведения» падает как штраф без причины, а не
  // как правило, известное заранее (UX §1.2 — контекст виден всегда).
  r.screenLine(
    enough ? t('house.hint') : t('haggle.hint'),
    w,
    h / 2 + SCREEN.subtitleY,
    PALETTE.hudDim,
    TEXT.subtitle,
  );

  let y = r.screenValue(t('house.cut'), cut, w, h / 2 - 200, 30, PALETTE.accent);
  y = r.screenValue(t('house.purse'), purse, w, y, 22, PALETTE.chip);

  if (enough) {
    r.screenLine(t('house.pay'), w, y + 20, PALETTE.accent, TEXT.card);
    r.confirmHint(w, y + 20 + SCREEN.hintStep * 2);
    return;
  }

  /*
   * Недостача и множитель принудительного пари стоят РЯДОМ, одной строкой.
   *
   * Раньше множитель дублировался вторым числом под средним вариантом
   * торга (`row + 108`) — туда же, где двухстрочный заголовок «Взять пари
   * в следующей комнате» переносился по словам, и на 1280×800 буквы
   * ложились поверх цифр. Недостача и её множитель — одно и то же число
   * сделки («кон принудительного пари = недостача, ×2», ECONOMY §10А), и
   * им незачем жить в двух местах экрана: рядом с недостачей она видна
   * один раз и ни с чем не сталкивается.
   */
  const shortSize = 22;
  const shortY = y;
  y = r.screenValue(t('house.short'), cut - purse, w, y, shortSize, PALETTE.loss, PALETTE.loss);
  drawMultiplier(
    r.batch,
    HOUSE.forcedBetMultiplier,
    r.sx(w / 2 + 64),
    r.sy(shortY + shortSize + TEXT.body),
    r.sz(shortSize - 4),
    PALETTE.loss,
  );

  /*
   * Три варианта торга — карточками в ряд, как двери, но БЕЗ бегающего
   * фокуса, и это не упрощение вёрстки.
   *
   * В ядре у торга своей навигации нет: вариант выбирается КНОПКОЙ, а не
   * курсором (`stepHouseCut`). Нарисованный поверх этого фокус выбирал бы
   * что-то одно, а нажатие делало бы своё — экран врал бы ровно там, где
   * игрок расстаётся с этажом. Поэтому у каждой карточки написана своя
   * кнопка, и написана она по текущей схеме ввода.
   *
   * Порядок карточек задан их кнопками, а не ценой варианта. Выкуп апгрейда
   * висит на горизонтали (на торге она свободна: фокуса здесь нет), а
   * горизонталь — это направление, и означать она имеет право только то, что
   * лежит СЛЕВА. Поэтому выкуп крайний левый, а пари — в середине, где
   * подтверждение и не спорит ни с какой стороной. Золотом при этом
   * по-прежнему пари: тот же язык, что на двери и на прилавке, «вот это
   * возьмётся, если нажать», — и это лучший из трёх выходов, потому что
   * оставляет игроку шанс рассчитаться.
   */
  const pad = r.scheme === InputScheme.Gamepad;
  /*
   * Что заведение даёт за апгрейд — половина цены текущего этажа
   * (ECONOMY §10), и ноль означает «продавать нечего».
   *
   * Число названо, а не спрятано за словом «продать»: торг — это размен, и
   * сравнить его не с чем, пока обе стороны сделки не показаны. Недостача
   * стоит строкой выше, цена выкупа — под карточкой, и решение «хватит ли»
   * считается в уме, как и на прилавке.
   */
  const sale = buybackOf(s, cut - purse);
  const options: readonly [string, string, boolean, boolean, number][] = [
    [
      // Товар назван по имени: «продать апгрейд» не говорит, с чем игрок
      // расстаётся, а выбирает его правило, а не он сам.
      sale.price > 0 ? t('haggle.sell.named', { name: sale.name }) : t('haggle.sell'),
      sale.price > 0 ? (pad ? t('screen.sell.pad') : t('screen.sell.key')) : t('haggle.empty'),
      sale.price > 0,
      false,
      sale.price,
    ],
    [t('haggle.bet'), pad ? t('screen.confirm.pad') : t('screen.confirm.key'), true, true, 0],
    [t('house.debt'), pad ? t('screen.cancel.pad') : t('screen.cancel.key'), true, false, 0],
  ];
  /*
   * Ширина ряда считается от кромки экрана, а не вписана числом на глаз.
   *
   * Прежние `gap=480`, `halfW=210` клали правый край крайней карточки на
   * 1330 при ширине арены 1280 (deck) — карточка «Взять в долг» обрезалась
   * кромкой окна, а не редким разрешением: на fhd/qhd/uhd запаса хватало,
   * и находка не всплывала, пока каталог не снял её именно на deck.
   */
  const cardHalfW = 160;
  const gap = cardHalfW * 2 + 100;
  // Ряд выходов ниже недостачи, а не вплотную к ней: карточка обрезала
  // верхними кромками само число, ради которого торг и открылся.
  const row = y + 110;
  for (let i = 0; i < options.length; i++) {
    const [label, button, available, primary, value] = options[i];
    const x = w / 2 + (i - (options.length - 1) / 2) * gap;
    const c = r.screenCard(x, row, cardHalfW, 86, primary, available);
    r.wrapped(label, x, row - 24, cardHalfW * 2 - 40, TEXT.body, c, available ? 1 : 0.85);
    const dim = PALETTE.hudDim;
    // Имя кнопки — тем же телом, что и остальные подсказки клавиш: это
    // единственное, что говорит, ЧЕМ выбирается вариант, и мельче прочего
    // текста оно быть не имеет права.
    r.label(button, x, row + 42, TEXT.body, dim, 'center', available ? 0.9 : 0.85);
    // Цена выкупа — фишками, под своей карточкой: заведение платит, значит
    // число золотое, как и всё, что в кошелёк приходит.
    if (value > 0) r.priceTag(value, x, row + 108, 18, PALETTE.chip);
  }
}

/**
 * Итоги: чем кончился забег и что игрок унёс.
 *
 * Отдельный экран, а не строка поверх боя. Забег обязан кончаться ЯВНО:
 * ворота версии меряют, сколько игроков начинают второй ДОБРОВОЛЬНО, а
 * добровольность невозможно измерить у того, кто не понял, что предыдущий
 * закончился.
 */
export function drawSummaryScreen(
  kit: RenderKit,
  s: SimState,
  w: number,
  h: number,
  fb: Feedback,
): void {
  kit.dim(w, h);
  const won = s.meta[Meta.Victory] !== 0;

  // Исход забега — верхняя ступень шкалы, а не 34: это кульминация забега,
  // и мельче титула заставки она стоять не может.
  kit.screenTitle(won ? t('summary.victory') : t('summary.death'), w, h / 2 + SCREEN.titleY);

  /*
   * Near-miss забега — подзаголовком под титулом (ТЗ-13 iter-3, GDD §9.3).
   *
   * Формула: последнее пари, которое было ещё Активным в момент конца
   * забега, — не любое проигранное за весь забег. Отличить одно от другого
   * можно только по тику: `endRun` (packages/sim/src/run.ts) переводит все
   * ещё активные пари в `Lost` ОДНИМ тиком, и `Feedback.runEndTick`
   * запоминает именно этот тик на клиенте (числу там не место в `Meta` —
   * оно чисто показ, а новый слот стоил бы ре-бейзлайна всех golden).
   * Нашлось — показываем тем же приёмом, что и `drawSettlement`
   * (процент/секунды + значок единицы); не нашлось — строки не будет
   * вовсе, как и у остальных строк этого экрана без данных.
   */
  if (fb.runEndTick !== 0) {
    let nmPlayer = -1;
    let nmSlot = -1;
    for (let p = 0; p < s.playerCount; p++) {
      for (let n = 0; n < MAX_ACTIVE_BETS; n++) {
        const k = p * MAX_ACTIVE_BETS + n;
        if (s.aState[k] !== BetState.Lost) continue;
        if (fb.betLostTick[k] !== fb.runEndTick) continue;
        nmPlayer = p;
        nmSlot = n;
      }
    }
    if (nmPlayer >= 0) {
      // nearMissOf хранит ДОЛЮ ВЫПОЛНЕННОГО (0 — не начато, 100 — почти
      // выигран), а строка говорит о недостаче — переворачиваем здесь, а не
      // меняем смысл самой величины: на расчёте (drawSettlement) она же
      // читается голой цифрой без слова «не хватило», и там разворот не нужен.
      const pct = 100 - Math.round((nearMissOf(s, nmPlayer, nmSlot) / FX_ONE) * 100);
      kit.screenLine(
        t('summary.nearmiss', { pct }),
        w,
        h / 2 + SCREEN.titleY + 40,
        PALETTE.loss,
        TEXT.subtitle,
      );
    }
  }

  // Ключи — крупнее всего остального: это единственное, что игрок уносит из
  // забега (ECONOMY §12), и на скриншоте видно должно быть именно их.
  let y = kit.screenValue(
    t('summary.floor'),
    s.meta[Meta.Floor],
    w,
    h / 2 - 250,
    26,
    PALETTE.hudText,
  );
  y = kit.screenValue(t('summary.keys'), s.meta[Meta.Keys], w, y, 44, PALETTE.accent);

  /*
   * Разбивка источников ключей: считается той же формулой, что и ядро
   * (`keysEarned` в packages/sim/src/run.ts, ECONOMY §12), но не вызывает
   * её напрямую — экран итогов не пересчитывает забег, а читает готовые
   * поля состояния, из которых формула и складывается.
   */
  let chips = 0;
  for (let i = 0; i < s.playerCount; i++) chips += s.pChips[i];
  const fromBets = Math.trunc(s.meta[Meta.BetsWon] / KEYS.betsPerKey);
  const fromChips = Math.trunc(chips / KEYS.chipsPerKey);
  const fromBosses = KEYS.perBoss * s.meta[Meta.BossesBeaten];

  /*
   * Разбивка идёт строками тела шкалы, а нулевые источники не печатаются
   * вовсе.
   *
   * «Пари выполнено: 0 · +0» — строка, которая ничего не сообщает и при этом
   * занимает место рядом с числом, ради которого экран существует. Правило
   * тут уже было заведено для «минимума за забег», просто применялось к
   * одной строке из четырёх.
   */
  const step = lineStep(TEXT.body);
  let lineY = y;
  const breakdown: [string, number][] = [
    [t('summary.keys.bets', { n: s.meta[Meta.BetsWon], k: fromBets }), s.meta[Meta.BetsWon]],
    [t('summary.keys.chips', { n: chips, k: fromChips }), chips],
    [
      t('summary.keys.boss', { n: s.meta[Meta.BossesBeaten], k: fromBosses }),
      s.meta[Meta.BossesBeaten],
    ],
  ];
  let visibleLines = 0;
  for (const [line, count] of breakdown) {
    if (count === 0) continue;
    kit.screenLine(line, w, lineY, PALETTE.hudDim);
    lineY += step;
    visibleLines++;
  }
  // Пол в 1 ключ показан отдельной строкой, только когда он реально
  // сработал — иначе разбивка показывала бы «минимум», даже когда сумма
  // источников уже его перекрыла, и строки не сходились бы с Meta.Keys.
  const floorShown = fromBets + fromChips + fromBosses < KEYS.floor;
  if (floorShown) {
    kit.screenLine(t('summary.keys.floor'), w, lineY, PALETTE.hudDim);
    lineY += step;
    visibleLines++;
  }
  // Дедуп с `summaryLineCount` (packages/sim/src/run.ts), которую отдельно
  // зовёт `menuLayout.ts` для хитбокса кнопки «Ещё разок»: количество
  // фактически напечатанных строк обязано совпадать с тем, что она
  // возвращает, иначе кнопка снова наедет на текст (iter-3 ТЗ-17).
  if (__DEV_BUILD__ && visibleLines !== summaryLineCount(s)) {
    console.error(`summary lines: ${visibleLines}, summaryLineCount: ${summaryLineCount(s)}`);
  }
  kit.screenValue(t('summary.paid'), s.meta[Meta.PaidToAce], w, lineY + 16, 22, PALETTE.hudDim);

  // «Ещё разок» доминирует на экране итогов — цикл «ещё разок» и есть то,
  // ради чего игра существует (UX §6).
  // Прямоугольник кнопки — общий с кликом (`menuLayout.ts`, `loop.ts`),
  // поэтому и считается он ОДНОЙ функцией (`againButtonFor`) от того же
  // состояния: раньше место было постоянным числом, а блок разбивки над
  // ним рос вниз с числом источников ключей — на трёх строках кнопка
  // ложилась поверх «Отдано заведению», а клик и рисунок расходились бы,
  // если бы им поправили только рисунок.
  const AGAIN_BUTTON = againButtonFor(s);
  const againY = h / 2 + (AGAIN_BUTTON.dy ?? 0);
  const c = kit.screenCard(w / 2, againY, AGAIN_BUTTON.halfW, AGAIN_BUTTON.halfH, true);
  kit.label(t('summary.again'), w / 2, againY, TEXT.button, c);
  kit.confirmHint(w, againY + AGAIN_BUTTON.halfH + SCREEN.hintStep);
  /*
   * С итогов обязан быть выход НЕ в новый забег.
   *
   * Обрабатывалось только подтверждение, то есть игрок, однажды нажавший
   * «Играть», больше никогда не видел ни меню, ни справки, ни настроек — до
   * перезагрузки страницы. «Ещё разок» при этом остаётся доминирующим:
   * выход назван строкой, а не второй кнопкой того же веса (UX §6).
   */
  kit.menuHint(w, againY + AGAIN_BUTTON.halfH + SCREEN.hintStep * 2);
  /*
   * Сид и сборка — мелкой строкой внизу.
   *
   * Экран итогов обещан «скриншотопригодным кадром» (UX §6), а кадр без сида
   * не воспроизводится: ни «повтори мой вечер» другу, ни баг-репорт по нему
   * не собрать. Версия здесь по той же причине, по которой она обязательна в
   * `[DOD:INVARIANT]`.
   */
  kit.screenLine(t('summary.seed', { seed: s.seed, build: BUILD }), w, h - 56, PALETTE.chrome);
}

/**
 * Исход пари формой: выиграно, обналичено, провалено.
 *
 * Формой, а не словом: три исхода различаются мгновенно и на любом языке, а
 * пять секунд расчёта — это не то время, за которое читают три подписи
 * подряд. Шрифт этого не отменил, он лишь снял оправдание.
 */
export function drawOutcome(b: ShapeBatch, state: BetState, x: number, y: number): void {
  if (state === BetState.Won) {
    // Шестиугольник с ядром против пустого кольца обналиченного: исход
    // по-прежнему различается ФОРМОЙ, а не только цветом, — заливка у обоих
    // теперь общая, и разница «полный / пустой» держится на ядре.
    const c = PALETTE.chip;
    entity(b, Shape.Hexagon, x, y, 11, 11, 0, c, 1, 3);
    b.push(Shape.Hexagon, x, y, 4.5, 4.5, 0, c.r, c.g, c.b, 1, 0, 0, 0, 0, 0);
    return;
  }
  if (state === BetState.Cashed) {
    // Соскочил сам: кольцо, а не полная фигура — куш взят не весь.
    const c = PALETTE.chip;
    b.push(Shape.Ring, x, y, 11, 11, 0, 0, 0, 0, 0, 4, c.r, c.g, c.b, 1);
    return;
  }
  if (state === BetState.Active) {
    /*
     * Пари ещё в игре — пустой шестиугольник приглушённым.
     *
     * Раньше сюда проваливалось всё, кроме выигранного и обналиченного, и
     * живое пари на паузе между волнами рисовалось ПЕРЕЧЁРКНУТЫМ: экран
     * объявлял проигранным то, что игрок держит и может забрать. Форма та
     * же, что у сердца и у выигрыша, но без ядра — «решится позже».
     */
    const c = PALETTE.hudDim;
    entity(b, Shape.Hexagon, x, y, 11, 11, 0, c, 0.8, 3);
    return;
  }
  const d = PALETTE.danger;
  for (const angle of [Math.PI / 4, -Math.PI / 4]) {
    b.push(Shape.Box, x, y, 12, 2.5, angle, d.r, d.g, d.b, 1, 0, 0, 0, 0, 0);
  }
}

/**
 * Экран расчёта — пауза между комнатами (UX §6).
 *
 * Пять секунд, за которые игрок обязан прочитать, чем кончились его пари.
 * Главное здесь не выигранное, а сорванное: near-miss в процентах — «не
 * хватило чуть-чуть» — и есть то, что заставляет пойти в следующую комнату
 * (GDD §9.3). Показывать его мельком в углу боевого HUD бессмысленно: в бою
 * туда никто не смотрит.
 *
 * Экран не модальный и ничего не ждёт: пауза кончается сама. Пропуск живёт
 * в симуляции и открывается через секунду — зажатый огонь иначе пролистал бы
 * расчёт раньше, чем игрок успел его увидеть.
 */
export function drawSettlement(r: Renderer, s: SimState, w: number, h: number, fb: Feedback): void {
  const rows = settlementRows(s);
  if (rows === 0) return;

  const b = r.batch;
  /*
   * Затемнение — общее с остальными экранами, а не своё.
   *
   * Своё здесь и было: 0.72 против 0.82 у двери, платы и итогов, — то есть
   * пять экранов забега затемняли бой по-разному, и разница читалась как
   * разное состояние игры. Расчёт верстался раньше остальных, и общего
   * помощника на тот момент не существовало; теперь он есть, и держать
   * четвёртое число незачем.
   */
  r.dim(w, h);

  /*
   * Крупье — ПОВЕРХ затемнения, а не под ним.
   *
   * Он выходит принимать расчёт (`aceAtSettlement` в ядре), то есть в этот
   * момент он и есть событие на экране. Затемнение в 0.72 съедало бы его
   * почти целиком: 0.85 собственной непрозрачности превращаются под ним в
   * четверть, и заведение, пришедшее похлопать провалу, снова стало бы
   * невидимым — ровно тем, из-за чего эта фигура и переделывалась.
   *
   * Дешевле, чем кажется: несколько фигур на пять секунд паузы, и только
   * когда расчёту есть что показать.
   */
  drawAce(r, s, fb);

  /*
   * Титул экрана — акцидентной гарнитурой, и это её единственная работа.
   *
   * Ар-деко говорит голосом заведения там, где текст читают не спеша: на
   * титуле, а не в строке HUD. В бою она была бы хуже интерфейсной по
   * единственному критерию, который в бою важен, — скорости опознания.
   */
  /*
   * Титул называет ТО, что происходит: пауза между волнами или расчёт.
   *
   * Экран один и тот же, а состояния два: между волнами пари ещё живы и
   * ничем не кончились, в конце комнаты они разрешены. «Расчёт» над живыми
   * строками обещал итог, которого ещё нет, — и игрок, увидев его дважды
   * за комнату, переставал верить титулу вообще.
   */
  /*
   * Признак — состояние самих пари, а НЕ номер волны.
   *
   * По волне это не выражается вовсе: экран живёт только при нулевой волне
   * (`settlementRows`), поэтому условие `Wave < wavesPerRoom` истинно всегда
   * и «Расчёт» не показывался никогда. Разделяет состояния то, что экран и
   * показывает: пока хоть одна строка активна, итога ещё нет — это пауза;
   * когда все строки разрешены (выиграно, сорвано, обналичено), на экране
   * ровно расчёт.
   */
  const anyActive = settlementHasActive(s);
  r.screenTitle(anyActive ? t('pause.title') : t('settlement.title'), w, h / 2 - rows * 34 - 64);

  // Плашки те же, что в бою, только крупнее и по центру: игрок узнаёт их
  // мгновенно, потому что весь бой смотрел ровно на эти формы.
  let line = 0;
  for (let p = 0; p < s.playerCount; p++) {
    const colour = PALETTE.player[p] as Rgb;
    for (let i = 0; i < MAX_ACTIVE_BETS; i++) {
      const k = p * MAX_ACTIVE_BETS + i;
      const state = s.aState[k] as BetState;
      if (state === BetState.None) continue;

      const spec = BETS[s.aBet[k]];
      const cat = categoryColour(spec.category);
      const y = h / 2 - (rows - 1) * 34 + line * 68;
      line++;
      const lost = state === BetState.Lost;
      const won = state === BetState.Won || state === BetState.Cashed;

      // Метка игрока слева: в кооперативе строк вчетверо больше, и чьё это
      // пари должно читаться без счёта строк. Тот же шестиугольник, что и в
      // боевом HUD, и в том же языке — иначе своя метка выглядела бы на
      // расчёте чужой.
      // Левее плашки, а не на её кромке: полуширина строки — ровно 190, и
      // метка стояла под собственным контуром строки.
      entity(b, Shape.Hexagon, w / 2 - 215, y, 10, 10, 0, colour, 1, 3);
      // Строка — та же плашка, что в бою: тёмное поле, рамка цветом
      // категории, у взятого куша — золотая.
      entity(b, Shape.Box, w / 2, y, 190, 26, 0, won ? PALETTE.chip : cat, lost ? 0.4 : 1, 3);
      // Та же пиктограмма, что на карте и на плашке: игрок узнаёт своё пари,
      // а не разгадывает его в третий раз.
      drawBetIcon(b, s.aBet[k], w / 2 - 160, y, 14, cat, ENTITY_FILL, 1);

      /*
       * Имя пари — своей колонкой слева от расписки, а не внутри плашки.
       *
       * Внутри места нет: плашка занята коном, множителем, исходом и
       * выплатой, и втиснутое между ними имя пришлось бы резать многоточием
       * уже в русском, не говоря о немецком с его +40% (GLOSSARY, п. 7).
       * Колонка слева даёт 230 единиц — двадцать восемь знаков кеглем 13 с
       * запасом на перевод, — и читается как графа расписки, чем и является.
       *
       * Приглушённое у сорванного: строка расчёта отвечает на вопрос
       * «сколько», а не «что», и имя не имеет права спорить с выплатой.
       */
      const name = lost ? PALETTE.hudDim : PALETTE.hudText;
      // Колонка имени отодвинута левее: имя набрано телом шкалы (24), и
      // двадцать восемь знаков правила GLOSSARY §7 требуют не 230 единиц, а
      // около 370 — прежняя колонка резала имя серединой расписки.
      r.text.push(betName(spec.id), w / 2 - 560, y, TEXT.body, Face.Ui, name.r, name.g, name.b, 1);

      /*
       * Строка расчёта читается слева направо как расписка: кон, множитель,
       * исход, выплата — и у сорванного отдельно, насколько не хватило.
       *
       * «Выиграно / провалено / обналичено» несёт форма исхода, а не слово,
       * и со шрифтом это не изменилось: заполненный шестиугольник — взял
       * куш, кольцо — соскочил сам, перечёркнутое — сорвал. Ровно те же три
       * формы, что игрок видел на плашке весь бой.
       */
      drawNumber(b, s.aStake[k], w / 2 - 120, y, 11, PALETTE.hudDim);
      drawMultiplier(b, spec.multiplier / FX_ONE, w / 2 - 82, y, 11, PALETTE.hudText);
      drawOutcome(b, state, w / 2 - 8, y);
      // Выплата: у обналиченного и выигранного она разная, и берётся та,
      // что игроку действительно заплатили (снята в момент перехода).
      // Золотом — это фишки, и на тёмной строке им есть где светиться.
      /*
       * У неразрешённого пари выплаты ещё нет, и показывается «Забрать».
       *
       * Пауза между волнами — это тот же экран расчёта, но пари в нём живые:
       * `fb.betPayout` у них ноль, и строка сообщала «выплата 0» рядом с
       * перечёркнутым исходом, то есть объявляла проигранным то, что игрок
       * ещё держит. Число живого пари — его текущий куш, приглушённый: он
       * ещё не в кошельке.
       */
      const active = state === BetState.Active;
      drawNumber(
        b,
        active ? cashOutValue(s, p, i) : fb.betPayout[k],
        w / 2 + 110,
        y,
        18,
        lost || active ? PALETTE.hudDim : PALETTE.chip,
      );

      if (!lost) continue;

      /*
       * Near-miss — главное, ради чего экран существует (GDD §9.3).
       *
       * У темповых пари он показывается В СЕКУНДАХ, а не в процентах, и это
       * не украшение: их `q` — доля прошедшего времени, и в момент, когда
       * время вышло, она равна единице. «Сто процентов» под перечёркнутым
       * исходом — вранье; «не хватило четырёх секунд» — правда, и считается
       * она разницей между срывом и концом комнаты.
       *
       * Ноль секунд означает, что темповое пари сорвалось не по времени, а
       * вместе с игроком на самом расчёте, — там честнее проценты: время у
       * него ещё оставалось.
       */
      const seconds = Math.max(
        0,
        Math.round((s.meta[Meta.RoomStartTick] - fb.betLostTick[k]) / TICK_HZ),
      );
      const time = spec.progress === BetProgress.Time && seconds > 0;
      drawNumber(
        b,
        time ? seconds : Math.round((nearMissOf(s, p, i) / FX_ONE) * 100),
        w / 2 + 235,
        y,
        15,
        PALETTE.loss,
      );
      // Метка единицы измерения: кольцо — секунды (циферблат), две точки
      // столбиком — проценты. Без неё «4» и «40» читаются одинаково.
      const d = PALETTE.loss;
      if (time) {
        b.push(Shape.Ring, w / 2 + 285, y, 9, 9, 0, 0, 0, 0, 0, 3, d.r, d.g, d.b, 0.9);
      } else {
        for (const dy of [-7, 7]) {
          b.push(Shape.Circle, w / 2 + 285, y + dy, 3.5, 3.5, 0, d.r, d.g, d.b, 0.9, 0, 0, 0, 0, 0);
        }
      }
    }
  }

  // Кольцо обратного отсчёта: пауза видимо кончается, а не висит.
  const left = Math.max(0, s.meta[Meta.NextWaveAt] - s.tick);
  const ring = PALETTE.hudText;
  b.push(
    Shape.Ring,
    w / 2,
    h / 2 + rows * 34 + 46,
    16,
    16,
    0,
    0,
    0,
    0,
    0,
    3,
    ring.r,
    ring.g,
    ring.b,
    0.7,
  );
  drawNumber(b, Math.ceil(left / TICK_HZ), w / 2, h / 2 + rows * 34 + 46, 14, PALETTE.hudText);

  /*
   * Трамплин — объясняет молчаливое правило симуляции: провал обязывает
   * следующий стол содержать лёгкое пари ×1.5 (ECONOMY §10, GDD §11).
   *
   * Только для Obligation.LegUp, а не Forced: принудительное пари торга
   * занимает тот же слот меты и сильнее трамплина (floor.ts:210-213), и у
   * него уже есть собственный экран (house/haggle) — здесь эти подписи
   * взаимоисключающие, дублировать вторую нельзя.
   *
   * Ниже кольца обратного отсчёта, а не рядом: строки пари занимают всё до
   * h/2 + rows*34, само кольцо стоит на h/2 + rows*34 + 46, и подпись под
   * ним на +46 больше не задевает ни ряды, ни число в кольце.
   */
  if ((s.meta[Meta.LegUp] as Obligation) === Obligation.LegUp) {
    r.screenLine(t('settlement.legup'), w, h / 2 + rows * 34 + 100, PALETTE.accent);
  }
}

/**
 * Ставка Крупье: он выложил свою карту и ставит против игрока (GDD §12А.1).
 *
 * Решение принимается ЭКРАНОМ, не подбором с пола, — `bets.ts` прямо
 * исключает эту карту из `drawCards` с комментарием «её показывает свой
 * экран». Раньше этого экрана не было вовсе: `Confirm`/`Cancel` уже читались
 * ядром (`acceptAceBet`/`declineAceBet` в `sim.ts`) и бесшумно решали за
 * игрока судьбу четверти его кошелька — нажатие Enter в паузе перед первой
 * волной могло принять или отклонить пари, о существовании которого игрок
 * не подозревал.
 *
 * Кон — свой у каждого игрока (`aceStakeFor`), поэтому называется кон
 * ЛОКАЛЬНОГО игрока: это тот, кому кнопка в руках прямо сейчас, и число
 * обязано отвечать на его собственный вопрос «сколько я поставлю», а не на
 * средний по столу.
 */
export function drawAceBetScreen(
  r: Renderer,
  s: SimState,
  w: number,
  h: number,
  fb: Feedback,
): void {
  const card = aceCardAt(s);
  if (card < 0) return;

  r.dim(w, h);
  // Крупье — поверх затемнения, тем же приёмом, что и на расчёте: под 0.82
  // затемнения его 0.85 непрозрачности превращаются в четверть и он снова
  // становится незаметен — ровно то событие, ради которого экран и открыт.
  drawAce(r, s, fb);

  r.screenTitle(t('ace_bet.title'), w, h / 2 + SCREEN.titleY);
  r.wrapped(t('ace_bet.desc'), w / 2, h / 2 + SCREEN.subtitleY, 1000, TEXT.body, PALETTE.hudDim);

  /*
   * НА ЧТО ставит Крупье — плашкой пари, той же формы, что в бою.
   *
   * Экран называл кон и множитель, но не пари: игрок подписывал сделку, не
   * зная её условия, при том что цена решения — четверть кошелька. Форма
   * взята боевая намеренно: игрок весь бой смотрел ровно на неё и узнаёт
   * пиктограмму раньше, чем дочитает имя.
   */
  const spec = BETS[s.kBet[card]];
  const cat = categoryColour(spec.category);
  const rowY = h / 2 - 150;
  entity(r.batch, Shape.Box, w / 2, rowY, 260, 30, 0, cat, 1, 3);
  drawBetIcon(r.batch, s.kBet[card], w / 2 - 220, rowY, 15, cat, ENTITY_FILL, 1);
  r.text.push(
    betName(spec.id),
    w / 2 - 190,
    rowY,
    TEXT.body,
    Face.Ui,
    PALETTE.hudText.r,
    PALETTE.hudText.g,
    PALETTE.hudText.b,
    1,
  );
  drawMultiplier(r.batch, spec.multiplier / FX_ONE, w / 2 + 190, rowY, 16, PALETTE.hudText);

  // Кон Крупье — не потеря игрока (это его собственные деньги, не списание
  // с кошелька, ECONOMY §10А), поэтому цвет фишек, а не PALETTE.loss —
  // тот занят экономическим минусом ИГРОКА (недостача, near-miss, кон,
  // поставленный ПРОТИВ него после проигрыша), а здесь наоборот, это то,
  // что игрок может ОБОБРАТЬ, приняв пари.
  const stake = aceStakeFor(s, 0);
  r.screenValue(t('ace_bet.stake'), stake, w, h / 2 - 70, 30, PALETTE.chip);

  /*
   * Сколько осталось молчать — кольцом обратного отсчёта.
   *
   * Экран обещает «смолчите — карта уйдёт вместе с волной, без потерь», и
   * молчание здесь такое же решение, как согласие, — но времени на него не
   * показывалось нисколько. Кольцо то же, что на расчёте: пауза видимо
   * кончается, а не висит.
   */
  const left = Math.max(0, s.kDeadline[card] - s.tick);
  const ring = PALETTE.hudDim;
  r.batch.push(
    Shape.Ring,
    w / 2,
    h / 2 + 120,
    22,
    22,
    0,
    0,
    0,
    0,
    0,
    3,
    ring.r,
    ring.g,
    ring.b,
    0.7,
  );
  drawNumber(r.batch, Math.ceil(left / TICK_HZ), w / 2, h / 2 + 120, 16, PALETTE.hudText);

  r.confirmHint(w, h / 2 + SCREEN.hintY);
  r.cancelHint(w, h / 2 + SCREEN.hintY + SCREEN.hintStep);
}

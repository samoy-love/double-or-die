/**
 * Арена и бой: пол, красная зона, колесо, босс, карты, метки спавна,
 * телеграфы, фишки, враги, глаза, игроки, сделки, снаряды, частицы, экранные
 * эффекты.
 *
 * Почти все функции читают `batch`/`text` и внутреннее состояние сглаживания
 * (`prevX`/`prevEX`/`enemyFacing`/`seenEnemy`/…) напрямую — то, что в
 * `RenderKit` не входит (см. `renderer.ts`), — и принимают вместо кита сам
 * `Renderer`, как и `screens/run.ts`. Параметр назван `rend`, а не `r`, как в
 * остальных `screens/*.ts`: тела метода в изобилии используют `r` для
 * радиуса сущности (`const r = toFloat(stats.radius)` и т. п.), и обычное имя
 * увело бы это внутрь тени. Перенос почти буквальный: тела функций не
 * менялись, только `this.` → `rend.` и внутренние вызовы
 * `this.drawX(...)` → `drawX(rend, ...)`.
 */
import {
  ACE,
  ANGLE_FULL,
  BALL,
  BETS,
  BOSS,
  CARD,
  ENEMIES,
  EnemyPhase,
  EnemyType,
  EntityFlag,
  FAIRNESS,
  FUSE,
  FX_ONE,
  InputScheme,
  MAX_BALLS,
  MAX_BULLETS,
  MAX_CARDS,
  MAX_CHIPS,
  MAX_ENEMIES,
  MAX_SPAWNS,
  Meta,
  PLAYER,
  RED_ZONE_RADIUS,
  RunPhase,
  SECTOR_COUNT,
  TICK_HZ,
  WEDGE,
  bossStunned,
  columnX,
  columnY,
  counterBetRunning,
  redZoneX,
  redZoneY,
  sectorAngle,
  stakeFor,
  templateOf,
  toFloat,
  wheelAngle,
  wheelRadius,
  wheelX,
  wheelY,
  type SimState,
} from '@dod/sim';
import { DEAL_LIFE, type Feedback } from '../feedback';
import type { Feel } from '../feel';
import { Shape } from '../gl/batch';
import { Face } from '../gl/text';
import {
  entity,
  clamp01,
  glow,
  channels,
  drawNumber,
  drawMultiplier,
  lerp,
  STROKE,
} from '../gl/primitives';
import { t } from '../i18n';
import { ENTITY_FILL, PALETTE, type Rgb } from '../palette';
import { ParticleShape, type Particles } from '../particles';
import { lineStep, TEXT } from '../typography';
import { categoryColour, drawBetIcon, betName, redZoneInPlay, enemyColour } from './betHelpers';
import type { Renderer } from '../renderer';

export function drawFloor(rend: Renderer, w: number, h: number, s: SimState): void {
  const b = rend.batch;
  b.push(Shape.Box, w / 2, h / 2, w / 2, h / 2, 0, ...channels(PALETTE.floor), 1, 0, 0, 0, 0, 0);

  /*
   * Виньетка пола — приближение фигурами, не проход поверх кадра.
   *
   * PRODUCTION §4 держит настоящую виньетку в F4/0.12.0 намеренно: она там
   * шейдерный проход, а «виньетка, нарисованная фигурой, — это тёмная
   * полоса с резким краем» (см. предупреждение в шапке файла). Это
   * предупреждение здесь и проверяется — приближение сделано МНОГИМИ
   * тонкими нарастающими кольцами, а не одним толстым, ровно чтобы не
   * получить ту самую полосу. Когда дойдёт очередь до настоящего
   * шейдерного прохода, эти кольца снимаются одной правкой — они не часть
   * сцены, а костыль под её текущий инструмент.
   */
  {
    const vg = PALETTE.vignette;
    const cx = w / 2;
    const cy = h * 0.46;
    const rings = 6;
    for (let i = 0; i < rings; i++) {
      const t = i / (rings - 1);
      const half = lerp(w * 0.34, w * 0.72, t);
      b.push(
        Shape.Box,
        cx,
        cy,
        half,
        half * (h / w),
        0,
        vg.r,
        vg.g,
        vg.b,
        0,
        0.05 + t * 0.1,
        vg.r,
        vg.g,
        vg.b,
        0.05 + t * 0.09,
      );
    }
  }

  /*
   * Сетка: по ней читается масштаб и скорость собственного движения — но
   * читается боковым зрением, а не разглядыванием. Раньше линии стояли на
   * полной непрозрачности того же тона, что и заливка колонн, — на полу это
   * читалось не сеткой ориентиров, а решёткой поверх арены. Макет
   * («Дизайн игры «Забег»», 1a) держит её на 3.5% белого: едва заметный
   * штрих, который замечаешь, только повернув голову. Роль колонн у
   * `PALETTE.grid` не трогаем — там он остаётся полноценной заливкой.
   */
  const step = 120;
  const g = PALETTE.chrome;
  /*
   * Сетка поднята до различимой.
   *
   * На 3.5% белого (grid × 0.16) её не было видно вовсе — ни боковым
   * зрением, ни прямым, — то есть роль «по ней читается масштаб и скорость
   * собственного движения» не исполнялась, а стоимость кадра платилась.
   * Хром вместо тона колонн: у колонн он остаётся заливкой, и одинаковый
   * цвет линии и препятствия — это как раз то, из-за чего сетку и
   * приглушали до невидимости.
   */
  const gridAlpha = 0.28;
  for (let x = step; x < w; x += step) {
    b.push(Shape.Box, x, h / 2, 1, h / 2, 0, g.r, g.g, g.b, gridAlpha, 0, 0, 0, 0, 0);
  }
  for (let y = step; y < h; y += step) {
    b.push(Shape.Box, w / 2, y, w / 2, 1, 0, g.r, g.g, g.b, gridAlpha, 0, 0, 0, 0, 0);
  }

  /*
   * Рамка арены — тот же приём, что в макете (stroke `#2f3542` вокруг всего
   * поля): без неё край арены обозначен только обрывом сетки, и на широком
   * экране игровая зона сливается с летрбоксом. Заливки нет — только
   * контур: рамка обозначает границу, а не рисует вторую панель поверх пола.
   */
  const border = PALETTE.chrome;
  b.push(
    Shape.Box,
    w / 2,
    h / 2,
    w / 2 - 4,
    h / 2 - 4,
    0,
    0,
    0,
    0,
    0,
    6,
    border.r,
    border.g,
    border.b,
    1,
  );

  /*
   * Дуги стола — фон, который перестал быть пустотой.
   *
   * Пол был чёрным прямоугольником с еле видимой сеткой: арена читалась
   * «страшной» не из-за формы сущностей, а из-за того, что вокруг них не
   * было ничего. Три концентрических кольца от центра дают столу форму, не
   * добавляя ни одного нового цвета и оставаясь ниже всего остального по
   * яркости — декор в иерархии стоит предпоследним, перед фоном (GDD §21).
   */
  {
    const ring = PALETTE.chrome;
    const cx = w / 2;
    const cy = h / 2;
    for (let i = 1; i <= 3; i++) {
      const rr = (Math.min(w, h) / 2) * (0.42 + i * 0.18);
      b.push(Shape.Ring, cx, cy, rr, rr, 0, 0, 0, 0, 0, 1.5, ring.r, ring.g, ring.b, 0.2);
    }
  }

  drawRedZone(rend, s);

  // Колонны берутся из шаблона текущей комнаты и уже с отражением: рисовать
  // их по базовым координатам значило бы показать не ту арену, на которой
  // идёт бой.
  for (const c of templateOf(s).columns) {
    const cx = toFloat(columnX(c, s));
    const cy = toFloat(columnY(c, s));
    const hw = toFloat(c.halfW);
    const hh = toFloat(c.halfH);
    entity(b, Shape.Box, cx, cy, hw, hh, 0, PALETTE.grid);
    /*
     * Внутренняя штриховка — признак «это укрытие», общий у всех колонн.
     *
     * Мелкие квадраты и широкие плиты одного шаблона выглядели двумя
     * разными сущностями: одинаковый стиль, разный габарит и ни одного
     * признака, говорящего, что оба держат пулю. Диагональ читается
     * «сплошное», и она же отличает колонну от пустой рамки экрана,
     * нарисованной тем же контуром.
     */
    const g2 = PALETTE.chrome;
    const stripes = Math.max(2, Math.min(7, Math.round(hw / 26)));
    // Наклон мелкий, длина — от меньшей стороны: штриховка обязана лежать
    // ВНУТРИ колонны, иначе она читается не заливкой, а торчащими усами.
    const tilt = Math.PI / 9;
    const half = Math.min(hh * 0.62, hw * 1.4);
    for (let n = 1; n < stripes; n++) {
      const t = n / stripes;
      b.push(
        Shape.Box,
        cx - hw * 0.82 + 2 * hw * 0.82 * t,
        cy,
        1.4,
        half,
        tilt,
        g2.r,
        g2.g,
        g2.b,
        0.5,
        0,
        0,
        0,
        0,
        0,
      );
    }
  }
}

/**
 * Красная зона — разметка пари, а не опасность, и рисуется только по делу.
 *
 * Два дефекта было сразу, и оба владелец увидел на первом же плейтесте.
 *
 * Первый: круг висел на полу ВСЕГДА, даже когда ни у кого не было пари «Не
 * заходи в красную зону», — то есть игра размечала запрет, которого нет.
 * Отсюда и вопрос «зачем он?»: правильный ответ на него — не подпись, а
 * отсутствие круга. Зона выводится из состояния: она нужна, пока пари лежит
 * картой на арене (решение принимают ДО нажатия X, значит и границу надо
 * видеть до него) или уже активно у кого-то из игроков.
 *
 * Второй: заливка шла алым по яркости телеграфа, а алый в этой игре занят
 * объявленной атакой (`PALETTE.danger`). Зона урона не наносит — она стоит
 * фишек, а не сердец, — и читаться как угроза не имеет права: столп №5,
 * читаемость превыше красоты. Поэтому глухой винный `PALETTE.redZone` и
 * ровный контур без пульсации: пульсация здесь — язык «сейчас ударит», и
 * занимать его нечем.
 *
 * Заливка с 0.4.0 общая тёмная, а не винная вполсилы: цветная плёнка поверх
 * пола читалась как второй пол, а границу — то единственное, что игроку тут
 * надо знать, — несёт контур. Затемнение против общего фона говорит «сюда
 * нельзя», не занимая под это ни одного цвета.
 *
 * Координаты НЕ масштабируются составом, в отличие от колонн: `inRedZone`
 * в ядре сравнивает позицию с абсолютными `RED_ZONE.x/y`, и нарисованный со
 * множителем круг вчетвером лежал бы не там, где срывается пари.
 */
export function drawRedZone(rend: Renderer, s: SimState): void {
  if (!redZoneInPlay(s)) return;
  const c = PALETTE.redZone;
  const x = toFloat(redZoneX(s));
  const y = toFloat(redZoneY(s));
  const r = toFloat(RED_ZONE_RADIUS);
  entity(rend.batch, Shape.Circle, x, y, r, r, 0, c, 0.55);
}

/**
 * Колесо: обод, разметка секторов и провалившийся сектор.
 *
 * Отрисовка нарочно скупая — колесо обязано ЧИТАТЬСЯ, а не выглядеть.
 * Вращается разметка (GDD §8.1), поэтому спицы едут, а обод стоит: если
 * когда-нибудь поедет обод, значит вращать начали геометрию, и это будет
 * видно глазом раньше, чем упадёт тест.
 *
 * Визуал доводится отдельным изменением: здесь ровно столько, чтобы бой
 * можно было играть.
 */
export function drawWheel(rend: Renderer, s: SimState): void {
  if (s.meta[Meta.Phase] !== RunPhase.Boss) return;
  const b = rend.batch;
  const cx = toFloat(wheelX(s));
  const cy = toFloat(wheelY(s));
  const r = toFloat(wheelRadius(s));
  const g = PALETTE.grid;

  b.push(Shape.Ring, cx, cy, r, r, 0, 0, 0, 0, 0, STROKE, g.r, g.g, g.b, 1);

  const turn = (Math.PI * 2) / SECTOR_COUNT;
  const base = (wheelAngle(s) * Math.PI * 2) / ANGLE_FULL;
  for (let i = 0; i < SECTOR_COUNT; i++) {
    const a = base + turn * i;
    b.push(
      Shape.Capsule,
      cx + (Math.cos(a) * r) / 2,
      cy + (Math.sin(a) * r) / 2,
      r / 2,
      1.5,
      a,
      g.r,
      g.g,
      g.b,
      0.8,
      0,
      0,
      0,
      0,
      0,
    );
  }

  for (let i = 0; i < SECTOR_COUNT; i++) {
    if (s.sectorFallAt[i] === 0 || s.tick >= s.sectorRestoreAt[i]) continue;
    const a = base + turn * i + turn / 2;
    // Телеграф алый и пульсирующий — это язык «сейчас ударит» (GDD §21).
    // Провалившийся сектор уже не угроза, а дыра: он рисуется фоном.
    const falling = s.tick < s.sectorFallAt[i];
    // Провалившийся сектор — дыра, и в новом языке её несёт контур цветом
    // хрома: раньше дыра заливалась фоном, а фон отличается от пола на ΔE 1,
    // то есть края у неё не было вовсе. Хром, а не цвет разметки: спицы и
    // обод уже разметка, и дыра обязана отличаться от них, а не сливаться.
    const c = falling ? PALETTE.danger : PALETTE.chrome;
    const alpha = falling ? 0.5 + 0.25 * Math.sin(s.tick / 4) : 1;
    const half = r * Math.sin(Math.PI / SECTOR_COUNT);
    entity(
      b,
      Shape.Capsule,
      cx + (Math.cos(a) * r) / 2,
      cy + (Math.sin(a) * r) / 2,
      r / 2,
      half,
      a,
      c,
      alpha,
    );
  }
}

/**
 * Босс, шары и полоса прочности.
 *
 * Метка приземления рисуется кругом ударной волны, а не точкой: игрок обязан
 * видеть ОБЛАСТЬ, из которой надо уйти, — ровно ту, по которой считается
 * достижимость безопасной точки (DIFFICULTY §8).
 */
export function drawBoss(rend: Renderer, s: SimState): void {
  if (s.meta[Meta.BossMaxHP] === 0) return;
  const b = rend.batch;
  const cx = toFloat(wheelX(s));
  const cy = toFloat(wheelY(s));
  const body = PALETTE.enemyAlt;
  const stunned = bossStunned(s);

  // Оглушённый босс гаснет обводкой, а не заливкой: заливка у всех одна, и
  // приглушать в нём нечего, кроме несущего цвета.
  entity(
    b,
    Shape.Circle,
    cx,
    cy,
    toFloat(BOSS.radius),
    toFloat(BOSS.radius),
    0,
    body,
    stunned ? 0.4 : 1,
  );

  for (let i = 0; i < MAX_BALLS; i++) {
    if (!s.ballActive[i]) continue;
    const left = s.ballLandAt[i] - s.tick;
    if (left <= BALL.telegraphTicks && !stunned) {
      const a = (sectorAngle(s, s.ballSector[i]) * Math.PI * 2) / ANGLE_FULL;
      const rim = toFloat(wheelRadius(s)) - toFloat(BALL.radius);
      const blast = toFloat(BALL.blastRadius);
      const d = PALETTE.danger;
      const urgency = clamp01(1 - left / BALL.telegraphTicks);
      b.push(
        Shape.Circle,
        cx + Math.cos(a) * rim,
        cy + Math.sin(a) * rim,
        blast,
        blast,
        0,
        d.r,
        d.g,
        d.b,
        0.08 + 0.14 * urgency,
        2,
        d.r,
        d.g,
        d.b,
        0.3 + 0.5 * urgency,
      );
    }
    // Шар — не снаряд по языку отрисовки, хотя и ведёт себя как снаряд:
    // радиус 16 держит обводку без потери формы, и поблажка, выданная пуле
    // радиусом 6, ему не нужна.
    entity(
      b,
      Shape.Circle,
      toFloat(s.ballX[i]),
      toFloat(s.ballY[i]),
      toFloat(BALL.radius),
      toFloat(BALL.radius),
      0,
      PALETTE.bullet,
    );
  }

  // Полоса прочности: одна на всех, потому что босс один на всех. Дорожка
  // живёт по общему правилу, сама полоса остаётся сплошной — она сообщает
  // длину, и обводка отняла бы у неё единственный признак.
  const width = 600;
  const share = s.meta[Meta.BossHP] / s.meta[Meta.BossMaxHP];
  const x = toFloat(s.arenaW) / 2;
  entity(b, Shape.Box, x, 46, width / 2, 9, 0, PALETTE.hudDim, 1, 2);
  b.push(
    Shape.Box,
    x - (width / 2) * (1 - share),
    46,
    (width / 2) * share,
    9,
    0,
    ...channels(counterBetRunning(s) ? PALETTE.hudDim : PALETTE.enemy),
    1,
    0,
    0,
    0,
    0,
    0,
  );

  // Фаза 2 (70% запаса): встречная ставка объявляется на 10 секунд, шары
  // смыкаются в кольцо (GDD §8.1). Полоса прочности выше уже гаснет до
  // hudDim на это время — баннер объясняет, что это значит и чем кончится,
  // раз выбор здесь не кнопкой, а позицией игрока (UX §2, принцип 2).
  if (counterBetRunning(s)) {
    const seconds = Math.ceil((s.meta[Meta.CounterBetUntil] - s.tick) / TICK_HZ);
    /*
     * Баннер живёт в той же системе координат, что полоса прочности над
     * ним, — в координатах АРЕНЫ, без масштаба интерфейса.
     *
     * Через `screenLine` он шёл мимо: та отсчитывает `y` от центра арены
     * (`540 + (y − 540)·uiScale`), а баннер стоит у верхней кромки — и при
     * 150% строка уезжала на отрицательный `y`, то есть за верхний край.
     * Пропадала при этом ЕДИНСТВЕННАЯ механика босса с решением: полоса
     * гасла в `hudDim`, а что это значит, не сообщал никто.
     */
    rend.hudLine(t('boss.counter_bet.label', { seconds }), x, 96, PALETTE.hudText, TEXT.card);
    rend.hudLine(t('boss.counter_bet.hint'), x, 96 + lineStep(TEXT.body), PALETTE.hudDim);
  }
}

/**
 * Карты пари: лицо с контуром, иконка пари, вертикальный луч и подсветка.
 *
 * Луч — не украшение. Карта и фишка обе подбираются с пола, и путать их
 * нельзя (GDD §21): фишки мелкие, золотым кольцом, россыпью; карта крупная, с
 * лучом, который виден сквозь толпу даже вчетвером на полной арене.
 *
 * Подсветка — не украшение тем более. Карта не подбирается наездом: наезд
 * подсвечивает, берут кнопкой (UX §2, правило ввода №2). Пока подсветки не
 * было, второй половины этого правила не существовало вовсе — карта
 * выглядела одинаково издали и под ногами, и на живом плейтесте её приняли
 * за декорацию, «через которую можно пройти, и она ничего не делает».
 * Надписи на карте нет и со шрифтом: в бою читают форму и движение, а не
 * буквы (UX §1, столп 3). Вся нагрузка на масштаб, дыхание, кольцо и глиф
 * кнопки — имя пари игрок увидит на расчёте, где на чтение есть время.
 */
/**
 * Карты пари на арене. `onlyHighlighted` — второй проход поверх игроков.
 */
export function drawCards(rend: Renderer, s: SimState, onlyHighlighted = false): void {
  const b = rend.batch;
  const pickup = toFloat(CARD.pickupRadius);

  for (let i = 0; i < MAX_CARDS; i++) {
    if (!s.kActive[i]) continue;
    /*
     * Карта Крупье на полу не рисуется: её показывает свой экран.
     *
     * Она лежит в том же массиве и по тем же правилам живёт по сроку, но
     * подобрать её нельзя (`tryTakeCard`), и нарисованная на арене она
     * обещала бы кнопку, которой нет, — то есть врала бы ровно тем
     * способом, который запрещает подсветка подбора ниже.
     */
    if (s.kOwner[i] === ACE) continue;
    const x = toFloat(s.kX[i]);
    const y = toFloat(s.kY[i]);
    const spec = BETS[s.kBet[i]];
    const colour = categoryColour(spec.category);
    const left = s.kDeadline[i] - s.tick;

    /*
     * Последние три секунды карты читаются двумя признаками сразу.
     *
     * Луч и раньше «гас» — но исчезал разом, целиком, без предупреждения о
     * предупреждении: только что стоял столб света, и вот его нет. Владелец
     * на плейтесте не понял ни что это было, ни что оно значило. Теперь луч
     * ОСЕДАЕТ: высота падает вместе с остатком срока, то есть сам столб и
     * есть шкала времени, — и вдобавок мигает вместе с рамкой карты.
     * Двойное кодирование здесь обязательно ровно потому, что надписи
     * запрещены (UX §4).
     *
     * Мигание — 2 Гц, вдвое ниже потолка фотосенситивной безопасности в
     * 3 Гц (UX §5), и это не полноэкранная вспышка, а предмет на полу.
     */
    const dying = left <= CARD.fadeTicks;
    const share = dying ? Math.max(0, left / CARD.fadeTicks) : 1;
    const blink = dying && (s.tick % 30) - 15 < 0;
    const beamH = 150 * share;
    if (beamH > 1) {
      const beamA = dying ? (blink ? 0.5 : 0.1) : 0.22;
      /*
       * Луч СУЖАЕТСЯ кверху, а не стоит прямоугольной полосой.
       *
       * Полосой он был неотличим по форме от телеграфа удара — те же
       * прямоугольники, разница только в цвете и наклоне, — а это два
       * противоположных по смыслу знака: «приз» и «сейчас ударит». Конус
       * читается «отсюда светит вверх», и спутать его с линией удара
       * нельзя даже боковым зрением.
       *
       * Треугольником одной фигурой не выходит: у него равные стороны, а
       * нужен узкий клин. Собираем из четырёх сегментов с убывающей
       * шириной — тот же приём, что у виньетки пола, и по той же причине.
       */
      const seg = 4;
      for (let n = 0; n < seg; n++) {
        const t0 = n / seg;
        const t1 = (n + 1) / seg;
        const halfW = 5 * (1 - t0 * 0.75);
        b.push(
          Shape.Box,
          x,
          y - beamH * ((t0 + t1) / 2),
          halfW,
          (beamH * (t1 - t0)) / 2,
          0,
          colour.r,
          colour.g,
          colour.b,
          beamA * (1 - t0 * 0.5),
          0,
          0,
          0,
          0,
          0,
        );
      }
    }

    /*
     * Взять карту может не всякий, кто на ней стоит: персональная карта
     * чужому не даётся (`kOwner`). Подсвечивать её тому, кто её не получит,
     * значит врать кнопкой — а обещание кнопки и есть единственный текст,
     * который в этой версии игроку показан.
     */
    let taker = -1;
    for (let p = 0; p < s.playerCount; p++) {
      if ((s.pFlags[p] & EntityFlag.Alive) === 0) continue;
      if (s.kOwner[i] >= 0 && s.kOwner[i] !== p) continue;
      const dx = toFloat(s.pX[p]) - x;
      const dy = toFloat(s.pY[p]) - y;
      if (dx * dx + dy * dy <= pickup * pickup) {
        taker = p;
        break;
      }
    }

    // Второй проход рисует только карту под ногами: остальные уже под
    // игроками, и рисовать их дважды значит платить за то же самое.
    if (onlyHighlighted && taker < 0) continue;

    // Дыхание подсвеченной карты: живое движение читается боковым зрением
    // там, где не читается ни цвет, ни размер.
    const breath = taker >= 0 ? 1.12 + Math.sin(s.tick * 0.14) * 0.05 : 1;
    const r = toFloat(CARD.radius) * breath;
    const edgeA = dying && !blink ? 0.4 : 1;
    // Лицо карты чуть шире прежнего: на нём теперь стоит множитель, а
    // множитель — обещание карты, и печатать его мельче цифр в HUD значит
    // печатать его нечитаемым.
    const fw = r * 0.86;
    const fh = r * 1.04;

    /*
     * Карта в языке 0.4.0: тёмное лицо и кремовый несущий контур.
     *
     * Кремовый переехал с заливки на обводку, и это не перестановка ради
     * единообразия. Подложка перестала быть цветом вовсе — она общая у всех
     * сущностей арены, — а «карта против фишки», пару которых гейт держит по
     * жёсткому порогу, теперь разводится именно контуром. Категорию несёт
     * рамка на ступень внутрь, иконка и луч: ровно те три места, что и
     * раньше (GDD §21), просто рамка стала внутренней — снаружи стоит
     * кремовый силуэт, по которому карта опознаётся как карта.
     */
    // Ореол карты — тем же кремовым, что и её силуэт: карта обязана быть
    // видна издалека, ради неё игрок и бежит в простреливаемый угол.
    // Кругом, а не прямоугольником: `Shape.Box` в ореоле даёт вторую рамку
    // вокруг карты, то есть ровно ту «мишень», от которой карту избавляли,
    // убирая лишние кольца. Круглое пятно читается свечением.
    glow(b, Shape.Circle, x, y, fh * 1.05, PALETTE.card, 0.2);
    entity(b, Shape.Box, x, y, fw, fh, 0, PALETTE.card, edgeA);

    /*
     * Кольца «цены места» здесь больше нет.
     *
     * Вокруг одной карты стояло до пяти концентрических контуров: лицо,
     * внутренняя рамка категории, «цена места», кольцо владельца и ореол
     * берущего. Читалось это мишенью, а не предметом, и три кольца разного
     * смысла отличались только радиусом. Пространственный риск и без того
     * нарисован — самой красной зоной, внутри которой карта и лежит.
     */

    b.push(
      Shape.Box,
      x,
      y,
      fw - STROKE,
      fh - STROKE,
      0,
      0,
      0,
      0,
      0,
      2.5,
      colour.r,
      colour.g,
      colour.b,
      edgeA,
    );
    // Пиктограмма ПАРИ, а не категории: «Без урона» и «Без рывка» обе из
    // Стиля и с иконкой категории были неразличимы (см. `drawBetIcon`).
    drawBetIcon(b, s.kBet[i], x, y - fh * 0.34, fh * 0.34, colour, ENTITY_FILL, edgeA);

    /*
     * Сделка сообщается ДО подбора, и на карте живёт ровно два числа.
     *
     * «Карта — это место на арене» (GDD §9.1): решение бежать за ней или нет
     * и есть центральное решение игры, а принималось оно вслепую — на карте
     * не было ни кона, ни множителя. Показываем то, без чего сделку не
     * оценить: МНОЖИТЕЛЬ на лице карты (это её обещание, и место ему там же,
     * где значение на игральной карте) и ЦЕНУ под картой, на полу, золотом —
     * цена про кошелёк игрока, а не про карту, и путать эти две вещи нельзя.
     *
     * Больше не помещается ничего, и это не теснота, а иерархия яркости
     * (GDD §21): карты стоят НИЖЕ снарядов и телеграфов, и третье число на
     * полу начало бы спорить с боем за внимание. Возможная выплата
     * сознательно не показана — она равна кону, умноженному на множитель, то
     * есть уже сказана этими двумя числами.
     */
    // Множитель кремовым, а не чернилами: лицо карты стало тёмным, и
    // чернильные цифры на нём пропадали бы ровно так же, как раньше
    // пропадали кремовые на кремовом.
    drawMultiplier(
      b,
      spec.multiplier / FX_ONE,
      x - fw * 0.66,
      y + fh * 0.5,
      fh * 0.26,
      PALETTE.card,
      edgeA,
    );

    /*
     * Цена — та, что спишется у того, кому карта достанется.
     *
     * `stakeFor` зависит от кошелька и аппетита, то есть у четверых она
     * четыре разных числа. Персональная карта отвечает на вопрос сама,
     * общая — только когда ответ однозначен: игрок на ней стоит или он за
     * столом один. Иначе цены нет вовсе: «стоит 10» для чужого кошелька
     * было бы ровно тем враньём, из-за которого игрок и не понимает сделку.
     */
    const payer =
      s.kOwner[i] >= 0 ? s.kOwner[i] : taker >= 0 ? taker : s.playerCount === 1 ? 0 : -1;
    if (payer >= 0) {
      const ps = fh * 0.28;
      const py = y + fh + ps * 1.9;
      const ch = PALETTE.chip;
      b.push(
        Shape.Circle,
        x - ps * 2.2,
        py,
        ps * 0.6,
        ps * 0.6,
        0,
        ch.r,
        ch.g,
        ch.b,
        edgeA * 0.9,
        0,
        0,
        0,
        0,
        0,
      );
      drawNumber(b, stakeFor(s, payer), x + ps * 0.5, py, ps, ch, edgeA * 0.9);
    }
    // Персональная карта помечена цветом своего игрока: чужую не взять.
    if (s.kOwner[i] >= 0) {
      const own = PALETTE.player[s.kOwner[i]] as Rgb;
      b.push(Shape.Ring, x, y, r * 1.25, r * 1.25, 0, 0, 0, 0, 0, 3, own.r, own.g, own.b, 0.9);
    }

    if (taker >= 0) {
      // Кольцо-ореол цветом взявшего: в коопе видно не только ЧТО можно
      // взять, но и КОМУ. Остаётся ниже игроков и снарядов по яркости
      // (GDD §21) — подсветка не имеет права спорить с боем.
      const own = PALETTE.player[taker] as Rgb;
      const halo = r * 1.55 + Math.sin(s.tick * 0.14) * 3;
      b.push(Shape.Ring, x, y, halo, halo, 0, 0, 0, 0, 0, 3, own.r, own.g, own.b, 0.55);
      drawTakeGlyph(rend, x, y - r * 2.2, s.pScheme[taker]);

      /*
       * Имя пари — как только есть кому его взять (playtest: «поднимая
       * карты пари непонятно, что я поднимаю»).
       *
       * Раньше имя показывалось только по удержанию «рассмотреть»
       * (`Btn.Inspect`), и тот же плейтест повторил жалобу уже после этого
       * фикса: скрытая по умолчанию подсказка не помогает игроку, который
       * не знает, что её нужно вызывать. Правило «в бою букв нет» (UX §1,
       * столп 3) получает то же единственное исключение, что и раньше, —
       * оно просто больше не спрятано за отдельной кнопкой. Момент, когда
       * имя нужно, — ровно тот, когда карту вообще можно взять: глиф
       * «Забрать» уже стоит над ней, а решение бежать сюда или мимо
       * принимается ДО нажатия кнопки, а не после.
       */
      const c = PALETTE.hudText;
      rend.text.push(
        betName(spec.id),
        x,
        y - r * 2.2 - 32,
        TEXT.body,
        Face.Ui,
        c.r,
        c.g,
        c.b,
        0.95,
        'center',
      );
    }
  }
}

/**
 * Глиф «чем берут»: буква X в квадрате клавиши, треугольник-триггер в круге
 * геймпада.
 *
 * Оправа и есть весь язык: круг — кнопка геймпада, квадрат — клавиша, голое
 * кольцо — тап по таче, где буквы нет вовсе. Схема берётся из состояния
 * (`pScheme`), а туда её кладёт кадр ввода, — поэтому игрок, взявшийся за
 * геймпад посреди боя, видит смену глифа сразу, а не после перезапуска.
 * Подбор на паде живёт на LT, а не на лицевой X (см. комментарий у
 * `PAD_CONFIRM_BTN` в input.ts) — буква X там означала бы кнопку, а не
 * триггер, поэтому геймпадный глиф рисуется отдельной фигурой.
 */
export function drawTakeGlyph(rend: Renderer, x: number, y: number, scheme: number): void {
  const b = rend.batch;
  const c = PALETTE.hudText;
  // Оправа по схеме: круг — геймпад, квадрат — клавиша, и у тача СВОЯ форма
  // — голое кольцо без штриха внутри, а не квадрат клавиши без буквы: тач
  // не жмёт кнопку, он касается самой карты (GDD §21).
  const frame =
    scheme === InputScheme.Gamepad
      ? Shape.Circle
      : scheme === InputScheme.Touch
        ? Shape.Ring
        : Shape.Box;
  b.push(frame, x, y, 15, 15, 0, 0, 0, 0, 0, 3, c.r, c.g, c.b, 0.95);
  if (scheme === InputScheme.Touch) return;
  if (scheme === InputScheme.Gamepad) {
    b.push(Shape.Triangle, x, y, 8, 8, -Math.PI / 2, c.r, c.g, c.b, 0.95, 0, 0, 0, 0, 0);
    return;
  }
  // Буква X двумя перекрещенными планками, а не глифом из атласа: это
  // обозначение КЛАВИШИ, и она обязана выглядеть одинаково в любом языке и
  // при любой гарнитуре — включая шрифт для дислексии (UX §5).
  for (const a of [Math.PI / 4, -Math.PI / 4]) {
    b.push(Shape.Box, x, y, 8, 1.6, a, c.r, c.g, c.b, 0.95, 0, 0, 0, 0, 0);
  }
}

/**
 * Крупье на арене.
 *
 * Рисуется НИЖЕ боевых сущностей и полупрозрачным: он второй игрок за
 * столом, а не препятствие, и перекрывать снаряды ему нельзя — читаемость
 * объявлена столпом дизайна (GDD §12А.1). Своя цветовая ниша, кремовая с
 * угольным, выводит его из спектров и врагов, и игроков.
 *
 * Пока он замахивается, над ним растёт кольцо: подброс телеграфируется за
 * полсекунды, чтобы карта не падала сюрпризом.
 */
/**
 * Публичный, а не через `RenderKit`: расчёт и Ставка Крупье (`screens/run.ts`)
 * рисуют его поверх своего затемнения тем же приёмом, что и раньше, когда
 * оба были методами этого класса. `RenderKit` — контракт раскладки, а не
 * список всего, что класс умеет рисовать (см. комментарий у `batch`).
 */
export function drawSpawnMarks(rend: Renderer, s: SimState): void {
  for (let i = 0; i < MAX_SPAWNS; i++) {
    if (!s.spActive[i]) continue;
    const left = Math.max(0, s.spAt[i] - s.tick);
    /*
     * Доля дожидания — от настоящей длительности предупреждения, и зажатая
     * в 0..1.
     *
     * Метки ставятся не в один тик (`WAVE.spawnStaggerTicks`): последняя в
     * пачке ждёт своего срока на четверть секунды дольше первой. Зашитая
     * тридцатка знала только про `spawnMarkTicks`, поэтому у отложенных
     * меток доля уходила в минус, и кольцо раздувалось вдвое против
     * задуманного — предупреждение врало о том, сколько осталось.
     */
    const t = clamp01(1 - left / FAIRNESS.spawnMarkTicks);
    const c = PALETTE.spawnMark;
    rend.batch.push(
      Shape.Ring,
      toFloat(s.spX[i]),
      toFloat(s.spY[i]),
      14 + 26 * (1 - t),
      14 + 26 * (1 - t),
      0,
      0,
      0,
      0,
      0,
      STROKE,
      c.r,
      c.g,
      c.b,
      0.35 + 0.5 * t,
    );
  }
}

/**
 * Телеграфы: объявленная атака обязана быть видна.
 *
 * Геометрия повторяет ту, по которой считается урон, — коридор тарана,
 * радиус взрыва, линия выстрела. Расходиться им нельзя: телеграф, не
 * совпадающий с ударом, хуже отсутствующего, потому что учит неправде.
 */
export function drawTelegraphs(rend: Renderer, s: SimState, alpha: number): void {
  const b = rend.batch;
  const d = PALETTE.danger;

  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (!s.eActive[i] || s.ePhase[i] !== EnemyPhase.Telegraph) continue;
    const a = rend.seenEnemy[i] ? alpha : 1;
    const x = lerp(rend.prevEX[i], toFloat(s.eX[i]), a);
    const y = lerp(rend.prevEY[i], toFloat(s.eY[i]), a);
    const stats = ENEMIES[s.eType[i]];
    const left = Math.max(0, s.ePhaseUntil[i] - s.tick);
    /*
     * Пульсация — не украшение: по ней читается, сколько осталось.
     *
     * Знаменатель — НАСТОЯЩАЯ длительность этого телеграфа, а не базовая из
     * каталога. У новичка она в полтора раза длиннее (`noviceTelegraphPct`),
     * и на базовой доля уходила в минус: первую половину своего телеграфа
     * новичок светился с нулевой прозрачностью, то есть был невидим.
     *
     * Ирония в том, что растянутый телеграф — это и есть весь туториал по
     * врагам (DIFFICULTY §7): игрок один раз видит Фитиль в упор и понимает,
     * что круг с фитилём взрывается. Единственное появление, ради которого
     * правило заведено, показывалось хуже всех остальных.
     */
    const novice = (s.eFlags[i] & EntityFlag.Novice) !== 0;
    const full = novice
      ? Math.trunc((stats.telegraphTicks * FAIRNESS.noviceTelegraphPct) / 100)
      : stats.telegraphTicks;
    const urgency = clamp01(1 - left / Math.max(1, full));
    const dx = toFloat(s.eDirX[i]);
    const dy = toFloat(s.eDirY[i]);

    if (s.eType[i] === EnemyType.Fuse) {
      const r = toFloat(FUSE.blastRadius);
      b.push(Shape.Ring, x, y, r, r, 0, 0, 0, 0, 0, STROKE + 2, d.r, d.g, d.b, 0.3 + 0.6 * urgency);
      continue;
    }

    const len =
      s.eType[i] === EnemyType.Wedge
        ? toFloat(WEDGE.dashSpeed) * stats.attackTicks
        : toFloat(s.arenaW);
    const width = s.eType[i] === EnemyType.Wedge ? toFloat(stats.radius) : 7;
    const angle = Math.atan2(dy, dx);
    b.push(
      Shape.Capsule,
      x + (dx * len) / 2,
      y + (dy * len) / 2,
      len / 2 + width,
      width,
      angle,
      d.r,
      d.g,
      d.b,
      0.1 + 0.16 * urgency,
      2,
      d.r,
      d.g,
      d.b,
      0.35 + 0.45 * urgency,
    );

    /*
     * Штриховка поперёк линии удара — второй признак опасной зоны.
     *
     * UX §4 требует у опасных зон двойного кодирования: цвет **и**
     * штриховка. Цветом было, штриховки не было, и телеграф отличался от
     * луча над картой пари только оттенком — то есть для дальтоника не
     * отличался ничем, кроме положения. Полосы идут поперёк направления
     * удара и сгущаются по мере приближения атаки: рисунок сам показывает,
     * КУДА ударит и КОГДА.
     */
    const step = 42;
    const bars = Math.min(14, Math.floor(len / step));
    const hatch = 0.25 + 0.4 * urgency;
    for (let n = 1; n <= bars; n++) {
      const t = (n * step) / len;
      b.push(
        Shape.Box,
        x + dx * len * t,
        y + dy * len * t,
        1.6,
        width * 0.9,
        angle,
        d.r,
        d.g,
        d.b,
        hatch,
        0,
        0,
        0,
        0,
        0,
      );
    }
  }
}

export function drawChips(rend: Renderer, s: SimState): void {
  const c = PALETTE.chip;
  for (let i = 0; i < MAX_CHIPS; i++) {
    if (!s.cActive[i]) continue;
    const x = toFloat(s.cX[i]);
    const y = toFloat(s.cY[i]);
    // Мигание за полсекунды до исчезновения: предупреждение без интерфейса.
    const left = s.cDeadline[i] - s.tick;
    if (left < 30 && (s.tick >> 2) % 2 === 0) continue;
    // Золото ушло с заливки на обводку: россыпь фишек была самым ярким
    // пятном на полу и спорила по яркости со снарядами, хотя стоит в
    // иерархии ниже игроков и карт (GDD §21). Кольцо той же ширины, что у
    // всех, оставляет фишку узнаваемой и возвращает её на своё место.
    glow(rend.batch, Shape.Circle, x, y, 11, c, 0.22);
    entity(rend.batch, Shape.Circle, x, y, 11, 11, 0, c);
  }
}

// -------------------------------------------------------------------------
// Сущности
// -------------------------------------------------------------------------

export function drawEnemies(rend: Renderer, s: SimState, alpha: number, fb: Feedback): void {
  const b = rend.batch;

  for (let i = 0; i < MAX_ENEMIES; i++) {
    if (!s.eActive[i]) continue;
    const a = rend.seenEnemy[i] ? alpha : 1;
    const x = lerp(rend.prevEX[i], toFloat(s.eX[i]), a);
    const y = lerp(rend.prevEY[i], toFloat(s.eY[i]), a);
    const type = s.eType[i] as EnemyType;
    const stats = ENEMIES[type];
    const r = toFloat(stats.radius);

    const flash = fb.enemyFlash[i] > 0;
    const colour = enemyColour(type);
    const squash = fb.enemySquash[i];
    /*
     * Слабый ореол врага.
     *
     * Слабее, чем у игрока и снарядов, и это иерархия, а не экономия
     * (GDD §21): враг обязан читаться силуэтом в толпе, но спорить по
     * яркости с тем, во что игрок целится, ему нельзя.
     */
    glow(b, Shape.Circle, x, y, r * 0.9, colour, 0.22);

    // Фитиль пульсирует всегда, а с подожжённым фитилём — вдвое чаще:
    // «сейчас рванёт» должно читаться и без телеграфа под ним.
    const lit = type === EnemyType.Fuse && s.ePhase[i] === EnemyPhase.Telegraph;
    const pulse = type === EnemyType.Fuse ? 1 + 0.12 * Math.sin(s.tick * (lit ? 0.6 : 0.2)) : 1;

    const vx = toFloat(s.eVX[i]);
    const vy = toFloat(s.eVY[i]);
    if (s.ePhase[i] === EnemyPhase.Telegraph || s.ePhase[i] === EnemyPhase.Attack) {
      // Направление удара зафиксировано на весь телеграф — доворот сюда
      // мгновенный и есть сам телеграф, сглаживать нечего.
      rend.enemyFacing[i] = Math.atan2(toFloat(s.eDirY[i]), toFloat(s.eDirX[i]));
    } else if (vx * vx + vy * vy > 0.01) {
      /*
       * Поле потока (`nav.ts`) отдаёт одно из восьми направлений к ячейке с
       * наименьшей стоимостью — и на плато, где у соседних ячеек стоимость
       * почти равна, счёт может качнуться в другую сторону от тика к тику.
       * Скорость при этом не падает (враг всё так же идёт на полной
       * скорости), поэтому проверка «скорость мала — не поворачивать»
       * (выше) эту дрожь не ловит: она не про модуль скорости, а про её
       * направление. Сглаживаем сам угол — короткой дугой, не через ноль, —
       * так гонка тик-в-тик усредняется, а настоящий поворот всё ещё
       * дочитывается за несколько кадров, не за один.
       */
      const target = Math.atan2(vy, vx);
      const prev = rend.enemyFacing[i];
      let diff = target - prev;
      diff = ((diff + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (diff < -Math.PI) diff += Math.PI * 2;
      rend.enemyFacing[i] = prev + diff * 0.25;
    }
    const facing = rend.enemyFacing[i];

    const shape =
      type === EnemyType.Wedge
        ? Shape.Triangle
        : type === EnemyType.Brick
          ? Shape.Box
          : Shape.Circle;
    const rot = type === EnemyType.Brick ? 0 : facing;

    /*
     * Тип врага несёт форма, цвет — второй признак, и с 0.4.0 он живёт в
     * обводке (GDD §21). Двойное кодирование от этого не пострадало:
     * треугольник, квадрат и круг различаются силуэтом, а силуэт как раз и
     * стал тем, что рисуется.
     *
     * Вспышка попадания — единственное место, где заливка врага не общая:
     * «попал» читается телом, а не каймой, и белая вспышка на четверть
     * секунды для того и заведена. Обводка при этом остаётся своей — иначе в
     * момент попадания пропадал бы тип того, в кого попали.
     */
    b.push(
      shape,
      x,
      y,
      r * pulse * (1 + squash),
      r * pulse * (1 - squash * 0.6),
      rot,
      ...channels(flash ? PALETTE.bullet : ENTITY_FILL),
      1,
      STROKE,
      colour.r,
      colour.g,
      colour.b,
      1,
    );

    drawEyes(rend, x, y, r * 0.45, Math.cos(facing), Math.sin(facing), r * 0.26, lit);
  }
}

/** Глаза следят за целью: без них фигуры — это фигуры, а не существа. */
export function drawEyes(
  rend: Renderer,
  x: number,
  y: number,
  offset: number,
  dirX: number,
  dirY: number,
  size: number,
  squint: boolean,
): void {
  const b = rend.batch;
  // Пара глаз ставится перпендикулярно взгляду, зрачок смещён по взгляду.
  const px = -dirY;
  const py = dirX;
  for (const side of [-1, 1]) {
    const ex = x + dirX * offset * 0.6 + px * offset * side;
    const ey = y + dirY * offset * 0.6 + py * offset * side;
    b.push(
      Shape.Circle,
      ex,
      ey,
      size,
      size * (squint ? 0.45 : 1),
      0,
      ...channels(PALETTE.eye),
      1,
      0,
      0,
      0,
      0,
      0,
    );
    b.push(
      Shape.Circle,
      ex + dirX * size * 0.4,
      ey + dirY * size * 0.4,
      size * 0.5,
      size * 0.5 * (squint ? 0.45 : 1),
      0,
      ...channels(PALETTE.pupil),
      1,
      0,
      0,
      0,
      0,
      0,
    );
  }
}

export function drawPlayers(rend: Renderer, s: SimState, alpha: number, fb: Feedback): void {
  const b = rend.batch;

  for (let i = 0; i < s.playerCount; i++) {
    if ((s.pFlags[i] & EntityFlag.Alive) === 0) continue;

    const a = rend.seenPlayers ? alpha : 1;
    const x = lerp(rend.prevX[i], toFloat(s.pX[i]), a);
    const y = lerp(rend.prevY[i], toFloat(s.pY[i]), a);
    const colour = PALETTE.player[i] as Rgb;
    const invul = (s.pFlags[i] & EntityFlag.Invulnerable) !== 0;
    const r = toFloat(PLAYER.visualRadius);

    // Нимб: игрок обязан быть различим в толпе всегда (GDD §21). Заливка
    // даёт пятно, ореол — мягкий край: вместе они читаются свечением, а не
    // вторым кругом вокруг персонажа.
    b.push(
      Shape.Circle,
      x,
      y,
      r * 1.6,
      r * 1.6,
      0,
      colour.r,
      colour.g,
      colour.b,
      0.16,
      0,
      0,
      0,
      0,
      0,
    );
    glow(b, Shape.Circle, x, y, r * 1.1, colour, 0.4);

    // Растяжение по направлению движения плюс сжатие от удара — squash and
    // stretch, из-за которого капля читается как живая, а не как круг.
    const vx = toFloat(s.pVX[i]);
    const vy = toFloat(s.pVY[i]);
    const speed = Math.hypot(vx, vy);
    const stretch = Math.min(0.28, speed * 0.05) - fb.playerSquash[i];

    /*
     * Кувырок: два оборота за отведённые 0.6 с.
     *
     * Отброс ударной волной не наносит урона сверх одного сердца — он
     * унижает, а не наказывает (GDD §6). Унижение это читается ровно
     * кувырком: без него отброшенный игрок выглядит просто скользящим, и
     * механика Fall Guys, ради которой всё затевалось, не считывается.
     */
    const ragdollLeft = Math.max(0, s.pRagdollUntil[i] - s.tick);
    const tumbling = ragdollLeft > 0;
    const tumble = tumbling ? (1 - ragdollLeft / PLAYER.ragdollTicks) * Math.PI * 4 : 0;

    const angle = tumbling ? tumble : speed > 0.01 ? Math.atan2(vy, vx) : 0;

    // Мигание при неуязвимости — по номеру тика, а не по времени: так
    // картинка совпадает с состоянием, а не живёт своей жизнью.
    const alphaBody = invul && (s.tick >> 2) % 2 === 0 ? 0.45 : 1;

    // Свой цвет переехал с тела на обводку, и правило «игрок всегда различим
    // в толпе» (GDD §21) держится теперь ею и нимбом: белая обводка,
    // одинаковая у всех четверых, различала игроков между собой хуже, чем их
    // собственные цвета, ради которых она и стояла.
    entity(
      b,
      Shape.Circle,
      x,
      y,
      r * (1 + stretch),
      r * (1 - stretch * 0.7),
      angle,
      colour,
      alphaBody,
    );

    // В кувырке глаза едут вместе с телом и жмурятся: смотреть на прицел
    // в этот момент нечем, управления всё равно нет.
    const ax = tumbling ? Math.cos(tumble) : toFloat(s.pAimX[i]);
    const ay = tumbling ? Math.sin(tumble) : toFloat(s.pAimY[i]);
    drawEyes(rend, x, y, r * 0.42, ax, ay, r * 0.3, invul || tumbling);
  }
}

/**
 * Заключённая сделка: всплывает над головой того, кто взял карту.
 *
 * Подбор был молчаливым: кон списывался без единого признака, и игрок не
 * видел ни того, что потерял, ни того, что ему обещали. Здесь показаны обе
 * стороны разом — «минус кон» и «плюс куш, если дожмёшь», — и показаны той же
 * плашкой, что стоит в HUD: игрок обязан узнать взятое пари, а не разгадывать
 * его заново.
 *
 * Рисуется НИЖЕ снарядов и выше игроков: это сообщение о решении, а не
 * участник боя, и перекрывать снаряды ему нельзя (GDD §21).
 */
export function drawDeals(rend: Renderer, s: SimState, fb: Feedback): void {
  const b = rend.batch;

  for (let p = 0; p < s.playerCount; p++) {
    const life = fb.dealLife[p];
    if (life <= 0) continue;
    // Плашка всплывает и в конце гаснет: движение вверх читается как «ушло в
    // HUD», где пари и живёт весь остальной бой.
    const t = clamp01(1 - life / DEAL_LIFE);
    const a = Math.min(1, life / 0.3) * 0.95;
    /*
     * Плашка сделки зажата в арену: у самой кромки она наполовину уезжала
     * за край, и игрок, взявший карту в углу, не видел, что именно списали.
     */
    const arenaW = toFloat(s.arenaW);
    const arenaH = toFloat(s.arenaH);
    const x = Math.min(Math.max(toFloat(s.pX[p]), 60), arenaW - 60);
    const y = Math.min(Math.max(toFloat(s.pY[p]) - 62 - 26 * t, 40), arenaH - 40);
    const bet = fb.dealBet[p];
    const colour = categoryColour(BETS[bet].category);

    // Та же плашка, что в HUD и на расчёте, и в том же языке: тёмное поле с
    // несущей рамкой цветом категории.
    entity(b, Shape.Box, x, y, 52, 24, 0, colour, a, 3);
    drawBetIcon(b, bet, x - 36, y - 11, 9, colour, ENTITY_FILL, a);
    drawMultiplier(b, BETS[bet].multiplier / FX_ONE, x - 22, y - 11, 7, PALETTE.hudText, a);

    // Кон ушёл — треугольник вниз мутным; куш придёт — треугольник вверх
    // золотом. Направление читается быстрее знака и не требует перевода.
    const dim = PALETTE.hudDim;
    b.push(
      Shape.Triangle,
      x - 44,
      y + 11,
      4.5,
      4.5,
      Math.PI / 2,
      dim.r,
      dim.g,
      dim.b,
      a,
      0,
      0,
      0,
      0,
      0,
    );
    // Число красится в цвет своей стрелки: на тёмном поле чернила не видны
    // вовсе, а раскрасить оба числа одним кремовым значило бы потерять
    // разницу между «ушло» и «придёт», которую стрелки как раз и несут.
    drawNumber(b, fb.dealStake[p], x - 28, y + 11, 8, dim, a);
    const ch = PALETTE.chip;
    b.push(Shape.Triangle, x - 2, y + 11, 5, 5, -Math.PI / 2, ch.r, ch.g, ch.b, a, 0, 0, 0, 0, 0);
    drawNumber(b, fb.dealPayout[p], x + 26, y + 11, 9, ch, a);
  }
}

/**
 * Снаряды — объявленное исключение из «тёмной заливки и несущей обводки».
 *
 * Пуля игрока рисуется капсулой с полутолщиной 6 единиц. Обводка в 4 съела
 * бы её почти целиком: от снаряда осталась бы тёмная сердцевина в пару
 * единиц с каймой, то есть точка. Между «единообразием языка» и правилом
 * «снаряды всегда светлее и ярче всего остального» (GDD §21) выбрано
 * правило: оно про то, выживет игрок или нет, а язык — про то, как это
 * выглядит.
 *
 * Ничего не теряется и по существу. Тёмная заливка нужна там, где цветов
 * много и роль надо опознать; у снаряда роль ровно одна — «в меня сейчас
 * прилетит», — и различать её надо не с другой ролью, а с полом, что
 * сплошная заливка и делает лучше всего.
 */
export function drawBullets(rend: Renderer, s: SimState, alpha: number): void {
  const c = PALETTE.bullet;
  const e = PALETTE.danger;
  for (let i = 0; i < MAX_BULLETS; i++) {
    if (!s.bActive[i]) continue;
    const a = rend.seenBullet[i] ? alpha : 1;
    const x = lerp(rend.prevBX[i], toFloat(s.bX[i]), a);
    const y = lerp(rend.prevBY[i], toFloat(s.bY[i]), a);
    const vx = toFloat(s.bVX[i]);
    const vy = toFloat(s.bVY[i]);
    const enemy = s.bOwner[i] < 0;
    const colour = enemy ? e : c;
    // Снаряд вытянут по своей скорости: так видно, куда он летит, ещё до
    // того, как игрок успел проследить траекторию.
    const len = enemy ? 14 : 22;
    // Снаряды — самое яркое на экране всегда (UX §4), и ореол это правило
    // не нарушает, а исполняет: он делает их заметнее прочего, не отнимая
    // яркости у остальных.
    glow(rend.batch, Shape.Circle, x, y, enemy ? 9 : 7, colour, 0.5);
    rend.batch.push(
      Shape.Capsule,
      x,
      y,
      len,
      enemy ? 9 : 6,
      Math.atan2(vy, vx),
      colour.r,
      colour.g,
      colour.b,
      1,
      0,
      0,
      0,
      0,
      0,
    );
  }
}

export function drawParticles(rend: Renderer, particles: Particles): void {
  const b = rend.batch;
  particles.each((shape, x, y, size, angle, r, g, bl, a) => {
    if (shape === ParticleShape.Ring) {
      b.push(Shape.Ring, x, y, size, size, 0, 0, 0, 0, 0, STROKE, r, g, bl, a);
      return;
    }
    const s = shape === ParticleShape.Shard ? Shape.Box : Shape.Circle;
    b.push(
      s,
      x,
      y,
      size,
      size * (shape === ParticleShape.Shard ? 0.45 : 1),
      angle,
      r,
      g,
      bl,
      a,
      0,
      0,
      0,
      0,
      0,
    );
  });
}

export function drawScreenEffects(rend: Renderer, feel: Feel, w: number, h: number): void {
  const b = rend.batch;
  const flash = feel.screenFlash;
  if (flash) {
    const c = flash.colour;
    b.push(Shape.Box, w / 2, h / 2, w, h, 0, c.r, c.g, c.b, flash.alpha, 0, 0, 0, 0, 0);
  }
  /*
   * Виньетки здесь нет намеренно.
   *
   * Одной фигурой она получается не мягким затемнением, а тёмной полосой с
   * резким внутренним краем: поле расстояния даёт ровно ту границу, которую
   * ему задали. Настоящая виньетка — это шейдерный проход поверх кадра, и он
   * стоит в стадии F4 вместе с зерном и свечением (PRODUCTION §4). Полоса
   * вместо неё не украшает, а мешает читаемости, объявленной столпом дизайна.
   */
}

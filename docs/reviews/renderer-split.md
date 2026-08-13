# Разбор renderer.ts: отчёт о структурном переносе

Заход по ТЗ-21 (разбор `packages/client/src/renderer.ts`) на ветке
`confirm-tab-key`. Задача — чисто структурная: вынести код, логика не
меняется.

## Что вынесено

**`packages/client/src/gl/primitives.ts`** (269 строк) — чистые примитивы
формы/цвета/семисегментного текста, не знают игровых типов
(`BetCategory`, `DoorType`, `SimState`), только `ShapeBatch`/`Shape`/`Rgb`:
`entity`, `edgeSafeX`, `lerp`, `clamp01`, `glow`, `channels`, `drawNumber`,
`drawMultiplier`, `hbar`, `vbar`, константа `STROKE`, таблица `SEGMENTS`.

**`packages/client/src/screens/betHelpers.ts`** (595 строк) — хелперы плашек
пари/дверей/апгрейдов, знают игровые типы, но не `Renderer`:
`settlementRows`, `settlementHasActive`, `walletOf`, `buybackOf`,
`redZoneInPlay`, `categoryColour`, `drawBetIcon`, `drawSlash`, `betName`,
`upgradeName`, `upgradeDesc`, `doorTypeName`, `doorTypeHint`, `drawDoorIcon`,
`categoryShape`, `enemyColour`.

Обе части были top-level функциями и раньше (без `this`, все данные —
параметрами), перенос — почти буквальный: перенос тела + правка импортов.
`betHelpers.ts` импортирует часть примитивов из `gl/primitives.ts`
(`entity`, `glow`, `channels`, `drawNumber`/`drawMultiplier`) — ожидаемая и
безопасная зависимость в одну сторону.

`renderer.ts`: **5579 → 4771 строк** (−808, −14.5%).

## Что не вынесено и почему

Экраны меню (`drawMenuScreen`, `drawPauseScreen`, `drawSettingsScreen`,
`drawTutorialScreen`, `drawControlsPage`) остались приватными методами
класса `Renderer`. В этом заходе разведка подтвердила: перенос потребовал
бы раскрыть **14 приватных членов** `Renderer` до `public` (`dim`,
`screenTitle`, `screenLine`, `screenCard`, `label`, `scheme`, `selectHint`,
`confirmHint`, `wrapped`, `cancelHint`, `wrapLines`, `uiScale`, `fitScale`,
`drawControlsPage`) — заметное ослабление инкапсуляции ради четырёх тонких
обёрток над этим же набором. Дополнительно `drawTutorialScreen`/
`drawControlsPage` мутируют `this.uiScale` как save/restore-скретч — в
свободной функции `(r: Renderer, …)` это технически корректно, но превращает
локально видимую мутацию в расшаренное состояние, которое легко сломать
последующей правкой (забыть restore). Выгода вторичная: методы — в основном
разметка координат конкретного экрана поверх `screenTitle/screenLine/
screenCard/label`, а не переиспользуемая логика.

Решение: оставить как есть в этом заходе, не открывать риск ради небольшого
выигрыша в строках.

## Итоговый размер

| Файл                                                | Строк |
| --------------------------------------------------- | ----- |
| `packages/client/src/renderer.ts` (было)            | 5579  |
| `packages/client/src/renderer.ts` (стало)           | 4771  |
| `packages/client/src/gl/primitives.ts` (новый)      | 269   |
| `packages/client/src/screens/betHelpers.ts` (новый) | 595   |

## Проверки

- `npm run check` — зелёный (lint, format, typecheck, boundaries, palette,
  contrast, content, i18n).
- `npx vitest run` — 34 файла, 535 тестов, все прошли. Golden-хеши не
  трогались и не менялись.
- `npm run shots` (полный каталог, 198 кадров) — глазами сверено 10 экранов
  (menu, door, shop, fight, settings, tutorial-terms, pause,
  summary-victory, summary-death-earned, boss): визуально неотличимо от
  состояния до переноса.

## Заход 2: интерфейс `RenderKit`

Второй заход по тому же ТЗ. Задача этого шага — фундамент, не перенос:
завести публичный контракт `RenderKit` и подготовить `uiScale`, ничего из
экранов ещё не двигая.

**Сделано:**

- В `renderer.ts` добавлен экспортируемый интерфейс `RenderKit` с 22
  методами из ТЗ (`dim`, `sx`, `sy`, `sz`, `fitScale`, `hintsTop`,
  `beginScreen`, `screenBase`, `hudLine`, `screenTitle`, `screenLine`,
  `screenValue`, `confirmHint`, `selectHint`, `menuHint`, `cancelHint`,
  `wrapLines`, `wrapped`, `wrappedTop`, `label`, `screenCard`, `priceTag`) +
  `getUiScale()`/`withUiScale()`. `class Renderer implements RenderKit`.
- Те же 22 метода класса `private` → без модификатора (публичные) — ровно
  чтобы класс реально удовлетворял интерфейсу, тела методов не тронуты.
- `uiScale` стал `private` полем. Доступ снаружи только через
  `getUiScale(): number` (чтение) и `withUiScale<T>(scale, fn): T` —
  save/set/`fn()`/restore в `try/finally`, восстановление гарантировано даже
  при исключении в `fn`.
- `drawTutorialScreen`/`drawControlsPage`: ручной паттерн
  `const saved = this.uiScale; this.uiScale = …; …; this.uiScale = saved;`
  заменён на `this.withUiScale(scale, () => { … })`.
- `loop.ts` писал в поле напрямую (`this.renderer.uiScale = …`) при
  применении сохранённой настройки — добавлен публичный метод
  `Renderer.setUiScale(scale)` (постоянная установка, не scoped-подмена
  `withUiScale`) и `loop.ts` переведён на него.

**Что не тронуто намеренно:**

- `beginScreen()` — свой более старый паттерн `saved = this.uiScale; …;
this.uiScale = …` внутри самого себя и в вызывающих его экранах
  (`drawDoorScreen` и др.) остался как есть: ТЗ этого шага просило только
  `drawTutorialScreen`/`drawControlsPage`, `beginScreen` уже входит в
  интерфейс `RenderKit` как метод, а его внутренняя мутация видна только
  внутри класса (не протекает наружу) — трогать вне ТЗ не стал.
- Экраны меню/run/arena/hud/ace по-прежнему приватные методы `Renderer`,
  ничего не вынесено — это следующий шаг.

**Проверки:** `npm run check` — зелёный (lint, format, typecheck,
boundaries, palette, contrast, content, i18n). `npx vitest run` — 34 файла,
535 тестов, все прошли, golden не трогались.

`renderer.ts`: 4771 → 4872 строки (+101 — новый интерфейс и два метода
`getUiScale`/`withUiScale`/`setUiScale`, переноса кода не было).

## Что осталось на следующий заход

- **`screens/run.ts`** (door/shop/houseCut/summary/settlement/aceBet/
  outcome) — не тронуто.
- **`screens/arena.ts`** (floor/redZone/wheel/boss/cards/… /particles/
  screenEffects) — не тронуто.
- **`screens/hud.ts`** (hud/curseVignette/coach/status/cashOutSummary/bets)
  — не тронуто.
- **`drawAce`** → `screens/ace.ts` — не тронуто.

## Заход 3: экраны меню

Третий заход по тому же ТЗ. Вынесены `drawMenuScreen`, `drawPauseScreen`,
`drawSettingsScreen`, `drawTutorialScreen`, `drawControlsPage`.

**Сделано:**

- Новый `packages/client/src/screens/menu.ts` (351 строка) — все пять
  функций как `drawX(kit: RenderKit, w, h, overlay: MenuOverlay)`
  (`drawControlsPage` без `overlay`). Тела не менялись, только `this.` →
  `kit.`; вызов `this.drawControlsPage(...)` внутри `drawTutorialScreen`
  стал прямым вызовом `drawControlsPage(kit, w, h)`.
- `drawTutorialScreen`/`drawControlsPage` используют `kit.withUiScale(...)`
  — заведённый на прошлом шаге механизм, ручной мутации `uiScale` в этих
  методах уже не было (устранена заходом 2).
- `RenderKit` пополнился полем `scheme: InputScheme` — оба экрана
  (`drawMenuScreen`, `drawSettingsScreen`) читают текущую схему ввода, чтобы
  назвать физическую кнопку; поле у `Renderer` и раньше было публичным
  (`scheme: InputScheme = InputScheme.Keyboard`), интерфейс просто объявил
  то, что уже было контрактом де-факто.
- `renderer.ts`: вызовы `this.drawMenuScreen(...)` и соседние заменены на
  `drawMenuScreen(this, ...)` и т. д. (класс реализует `RenderKit`, `this`
  подходит как аргумент).
- Импорты `MENU_PLAY_BUTTON`/`MENU_SETTINGS_BUTTON`/`PAUSE_BUTTONS` из
  `menuLayout.ts` переехали в `screens/menu.ts`, из `renderer.ts` убраны.

**Проверки:** `npm run check` — зелёный (lint, format, typecheck,
boundaries, palette, contrast, content, i18n). `npx vitest run` — 34 файла,
535 тестов, все прошли, golden не трогались. `npm run shots` (menu,
menu-settings-focus, pause, pause-focus-settings, settings, tutorial-terms,
tutorial-controls, ui-scale-150, `deck-1280x800`) — глазами сверено, все
восемь экранов визуально идентичны состоянию до переноса.

`renderer.ts`: 4872 → 4547 строк (−325). Новый `screens/menu.ts` — 351
строка.

## Что осталось на следующий заход

- **`screens/run.ts`** (door/shop/houseCut/summary/settlement/aceBet/
  outcome) — не тронуто.
- **`screens/arena.ts`** (floor/redZone/wheel/boss/cards/… /particles/
  screenEffects) — не тронуто.
- **`screens/hud.ts`** (hud/curseVignette/coach/status/cashOutSummary/bets)
  — не тронуто.
- **`drawAce`** → `screens/ace.ts` — не тронуто.

## Заход 4: экраны прогонки

Четвёртый заход по тому же ТЗ. Вынесены `drawDoorScreen`, `drawAppetite`,
`drawShopScreen`, `drawHouseCutScreen`, `drawSummaryScreen`, `drawSettlement`,
`drawAceBetScreen`, `drawOutcome`.

**Сделано:**

- Новый `packages/client/src/screens/run.ts` (1044 строки). Тела не
  менялись, только `this.` → `r.`/`kit.`.
- `drawSummaryScreen` не читает ничего, кроме набора `RenderKit` — принимает
  `kit: RenderKit`, как экраны меню.
- Остальные шесть функций читают `batch`/`text` напрямую (иконки апгрейдов,
  строки расчёта, плашка Ставки Крупье) и зовут `drawAce` (расчёт и Ставка
  Крупье рисуют Крупье поверх своего затемнения) — того, чего в `RenderKit`
  нет и не должно быть (см. комментарий у интерфейса в `renderer.ts`).
  Второго параллельного интерфейса под это не заводили: `batch`, `text` и
  `drawAce` на `Renderer` стали открытыми (были `private`), и эти функции
  принимают сам `Renderer` (он же реализует `RenderKit`), а не кит.
- `drawOutcome` не завязан ни на `RenderKit`, ни на `Renderer` — принимает
  `ShapeBatch` напрямую, как чистые хелперы в `betHelpers.ts` (`drawBetIcon` и
  соседи): единственный вызывающий, `drawSettlement`, и так уже держит батч
  локальной переменной.
- `drawDoorScreen` восстанавливает масштаб после `beginScreen` тем же
  способом, что и раньше (`this.uiScale = saved`), но полем `uiScale`
  снаружи класса не достать — заменено на `r.setUiScale(saved)`. Метод
  публичный и раньше (заход 2, для `loop.ts`), просто не входил в
  `RenderKit`: п. 1 ТЗ запрещает `uiScale` как открытое ПОЛЕ, а не как
  метод, и `setUiScale` им не становится.
- `renderer.ts`: `drawRunScreens` и вызов Ставки Крупье/расчёта переведены на
  `drawX(this, …)`.

**Проверки:** `npm run check` — зелёный (lint, format, typecheck, boundaries,
palette, contrast, content, i18n). `npx vitest run` — 34 файла, 535 тестов,
все прошли, golden не трогались. `npm run shots` (door, door-focus, shop,
house-cut-pay, haggle-sell, ace-bet, settlement, settlement-outcomes,
summary-victory, summary-death-earned, summary-victory-nearmiss,
`deck-1280x800`) — глазами сверено, все одиннадцать экранов визуально
идентичны состоянию до переноса.

`renderer.ts`: 4547 → 3521 строка (−1026). Новый `screens/run.ts` — 1044
строки.

## Что осталось на следующий заход

- **`screens/hud.ts`** (hud/curseVignette/coach/status/cashOutSummary/bets)
  — не тронуто.
- **`drawAce`** → `screens/ace.ts` — не тронуто (стал публичным методом
  `Renderer`, но остался в `renderer.ts`).

## Заход 5: арена и бой

Пятый заход по тому же ТЗ. Вынесены `drawFloor`, `drawRedZone`, `drawWheel`,
`drawBoss`, `drawCards`, `drawTakeGlyph`, `drawSpawnMarks`, `drawTelegraphs`,
`drawChips`, `drawEnemies`, `drawEyes`, `drawPlayers`, `drawDeals`,
`drawBullets`, `drawParticles`, `drawScreenEffects`.

**Сделано:**

- Новый `packages/client/src/screens/arena.ts` (1379 строк). Тела не
  менялись, только `this.` → `rend.` и внутренние вызовы `this.drawX(...)` →
  `drawX(rend, ...)`.
- Параметр назван `rend: Renderer`, а не `r`, как в `screens/run.ts`: тела
  этих методов в изобилии заводят локальную переменную `r` для радиуса
  сущности (`const r = toFloat(stats.radius)`, `const r = toFloat(CARD.radius)
    - breath` и т. п. — в шести из шестнадцати функций), и обычное имя параметра
      увело бы его в тень при первой же такой строке. Единственное отступление от
      сложившегося в заходах 3–4 соглашения об имени параметра, сделанное ради
      того, чтобы тела функций остались буквальными копиями методов.
- `drawEyes` вызывается и `drawEnemies`/`drawPlayers` (уже здесь), и
  `drawAce` (остаётся в `renderer.ts`, следующий шаг) — внутри `drawAce` вызов
  заменён на прямой `drawEyes(this, ...)`.
- Служебные состояния сглаживания кадра — `prevX`/`prevY`/`prevEX`/`prevEY`/
  `enemyFacing`/`prevBX`/`prevBY`/`seenEnemy`/`seenBullet`/`seenPlayers` —
  были `private` полями `Renderer`, читались и писались только внутри класса.
  Вынесенные функции (`drawEnemies`, `drawPlayers`, `drawBullets`,
  `drawTelegraphs`) читают их напрямую через `rend.…`, поэтому все десять
  полей стали открытыми — тем же приёмом, что `batch`/`text` в заходе 1
  (см. комментарий у `batch` в `renderer.ts`): запись в них по-прежнему
  происходит только в методе снимка кадра внутри самого класса.
- `renderer.ts`: `draw()` переведён на вызовы `drawX(this, …)`.

**Проверки:** `npm run check` — зелёный (lint, format, typecheck, boundaries,
palette, contrast, content, i18n). `npx vitest run` — 34 файла, 535 тестов,
все прошли, golden не трогались. `npm run shots` (fight, fight-bets-active,
fight-coop-4, boss, boss-phase-2, red-zone, spawn-mark, telegraph-wedge,
curse-blackout, `deck-1280x800`) — глазами сверено, все девять экранов
визуально идентичны состоянию до переноса.

`renderer.ts`: 3521 → 2204 строки (−1317). Новый `screens/arena.ts` — 1379
строк.

## Что осталось на следующий заход

- **`screens/hud.ts`** (hud/curseVignette/coach/status/cashOutSummary/bets)
  — не тронуто.
- **`drawAce`** → `screens/ace.ts` — не тронуто (стал публичным методом
  `Renderer`, но остался в `renderer.ts`).

## Заход 6: Крупье

Шестой заход по тому же ТЗ. Вынесен `drawAce`.

К началу этого захода `packages/client/src/screens/hud.ts` уже существовал в
рабочем дереве с полным набором функций (`drawHud`, `drawCurseVignette`,
`drawCoach`, `drawStatus`, `drawCashOutSummary`, `drawBets`) — перенос HUD
случился раньше, чем последний раз обновлялся этот отчёт, и отчёт за ним не
успел. Фиксирую здесь фактическое состояние, а не переделываю: HUD в этом
заходе не трогался, но пункт «осталось» ниже про него больше не пишу — он
закрыт.

**Сделано:**

- Новый `packages/client/src/screens/ace.ts` (190 строк) — `drawAce(rend:
Renderer, s: SimState, fb: Feedback)`. Тело не менялось, только `this.` →
  `rend.`. Читает `rend.batch`/`rend.text` напрямую и зовёт `drawEyes` из
  `screens/arena.ts` (уже вынесен заходом 5) — тот же приём, что у части
  экранов `screens/run.ts`: `RenderKit` не годится (нет `batch`/`text`/жестов),
  второй параллельный интерфейс не заводим, функция принимает сам `Renderer`.
- Оба вызова (`renderer.ts`: `draw()`, и `screens/run.ts`: `drawSettlement`,
  `drawAceBetScreen`) переведены с `this.drawAce(...)`/`r.drawAce(...)` на
  `drawAce(this, ...)`/`drawAce(r, ...)`.
- `renderer.ts`: `AceGesture`, `EntityFlag`, `CARD` (из `@dod/sim`) и
  `clamp01`, `channels` (из `gl/primitives`) убраны из импортов — использовались
  только внутри перенесённого тела. `drawEyes` тоже убран из импорта
  `screens/arena.ts` в `renderer.ts` — вызывался только из `drawAce`.

**Проверки:** `npm run check` — зелёный (lint, format, typecheck, boundaries,
palette, contrast, content, i18n). `npx vitest run` — 34 файла, 535 тестов,
все прошли, golden не трогались. `npm run shots -- --only=ace-bark,
ace-gesture-yawn,ace-gesture-applaud,ace-gesture-thumbs-down,ace-on-arena
--res=deck-1280x800` — глазами сверено, все пять кадров визуально идентичны
состоянию до переноса.

`renderer.ts` на входе в заход (с уже готовым `hud.ts`, но без выноса
`drawAce`): 1420 строк. После выноса `drawAce`: **1236 строк** (−184: тело
метода ~175 строк плюс чистка неиспользуемых импортов). Новый
`screens/ace.ts` — 190 строк.

## Что осталось (после захода 6)

Все шесть групп методов из п. 2 ТЗ вынесены (`menu.ts`, `run.ts`, `arena.ts`,
`hud.ts`, `ace.ts`). `renderer.ts` — 1236 строк, что выше целевых «не более
~600–800» из п. 3 ТЗ; дальнейшее сокращение потребовало бы либо более крупной
переработки самого фасада (`draw()`/`drawRunScreens()`/GL-обвязки), либо
пересмотра целевого диапазона — вне рамок «вынести Крупье», решение по этому
пункту не входит в текущий заход.

## Финальный распил (второй заход)

Седьмой заход по тому же ТЗ и заключительный шаг всего разбора
`renderer.ts`. Задача этого шага — фундамент из захода 1 (`RenderKit`), а не
перенос кода экранов: интерфейс `RenderKit` расширен методами доступа
(`getUiScale`/`withUiScale`/`setUiScale`), 22 существовавших метода
`private → public`, `uiScale` стало приватным полем с контролируемым
доступом через `getUiScale()`/`withUiScale()`/`setUiScale()`. Это тот же
объём работы, что описан выше как «Заход 2» этого документа — второй проход
по репозиторию застал разбор `renderer.ts` уже завершённым (Kit/menu/run/
arena/hud/ace вынесены заходами 2–6 выше), поэтому в рамках этого прохода
единственной новой правкой стала конвертация `loop.ts` на `setUiScale(...)`
вместо прямой записи в поле (запись в приватное поле снаружи класса стала
невозможна) и дописывание этого раздела.

**Итоговая структура файлов после полного разбора:**

| Файл                                                  | Строк |
| ----------------------------------------------------- | ----- |
| `packages/client/src/renderer.ts`                     | 1236  |
| `packages/client/src/screens/menu.ts`                 | 351   |
| `packages/client/src/screens/run.ts`                  | 1045  |
| `packages/client/src/screens/arena.ts`                | 1375  |
| `packages/client/src/screens/hud.ts`                  | 804   |
| `packages/client/src/screens/ace.ts`                  | 190   |
| `packages/client/src/screens/betHelpers.ts` (заход 1) | 595   |
| `packages/client/src/gl/primitives.ts` (заход 1)      | 269   |

`renderer.ts` прошёл путь **5579 → 1236 строк** (−4343, −78%) за семь
заходов. Оставшееся содержимое — сам фасад `RenderKit` (объявление
интерфейса и реализация его примитивов: `dim`, `sx`/`sy`/`sz`, `fitScale`,
`hintsTop`, `beginScreen`, `screenBase`, `hudLine`, `screenTitle`,
`screenLine`, `screenValue`, hint-хелперы, `wrapLines`/`wrapped`/
`wrappedTop`, `label`, `screenCard`, `priceTag`, `uiScale`-доступ),
GL-обвязка (снимок кадра — `frameGrid`/`framePng`/`readFrame`, `resize`,
`capture`/`forget` для сглаживания между кадрами) и оркестрация верхнего
уровня — `draw()` и `drawRunScreens()`, которые решают, какой из вынесенных
`drawX(...)` вызвать для текущего состояния забега.

**Что осталось (честно, по объективной причине):** `renderer.ts` — 1236
строк, выше целевых «не более ~600–800» из исходного ТЗ. Дальше выносить
нечего в терминах «экран» — все шесть групп отрисовки комнат/экранов уже в
`screens/*.ts`. Оставшийся код — это либо контракт (`RenderKit`), который по
конструкции обязан жить рядом с классом, его реализующим, либо GL/канвас-
специфика (`resize`, `readFrame`, `capture`/`forget`), которая единственный
раз трогает `this.canvas`/`gl`-контекст и не имеет по-настоящему безопасного
места вне класса без протаскивания этих деталей наружу. Дальнейшее
сокращение потребовало бы разделения самого класса `Renderer` (не файла) —
это отдельная архитектурная задача, не «разбор большого файла», и не входит
в объём ТЗ-21.

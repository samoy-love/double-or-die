/**
 * СГЕНЕРИРОВАННЫЙ ФАЙЛ. Правьте content/strings.json и запускайте npm run content.
 *
 * Весь видимый игроку текст живёт данными (UX §8), а клиенту нужен модуль с
 * типизированными ключами: опечатка в ключе обязана падать компиляцией, а не
 * пустым местом на экране, замеченным на языке, на котором никто не играл.
 * Расхождение источника и этого файла ловит CI.
 */

/** Языки версии 0.4.0. Первый — исходник, с которого переводят остальные. */
export const LANGS = ['ru', 'en'] as const;

export type Lang = (typeof LANGS)[number];

/** Ключ словаря. Список закрыт: строки вне его в игре не бывает. */
export type StringKey =
  | 'ace.bark.applaud.1'
  | 'ace.bark.applaud.2'
  | 'ace.bark.applaud.3'
  | 'ace.bark.fidget.1'
  | 'ace.bark.fidget.2'
  | 'ace.bark.fidget.3'
  | 'ace.bark.ovation.1'
  | 'ace.bark.ovation.2'
  | 'ace.bark.ovation.3'
  | 'ace.bark.thumbs_down.1'
  | 'ace.bark.thumbs_down.2'
  | 'ace.bark.thumbs_down.3'
  | 'ace.bark.turn_away.1'
  | 'ace.bark.turn_away.2'
  | 'ace.bark.turn_away.3'
  | 'ace.bark.yawn.1'
  | 'ace.bark.yawn.2'
  | 'ace.bark.yawn.3'
  | 'bet.all_chips.name'
  | 'bet.demolitionist.name'
  | 'bet.no_damage.name'
  | 'bet.no_dash.name'
  | 'bet.no_red_zone.name'
  | 'bet.under_45s.name'
  | 'error.webgl2'
  | 'overlay.dropped'
  | 'overlay.halt.hint'
  | 'overlay.halt.report'
  | 'overlay.halt.title'
  | 'overlay.halt.where'
  | 'overlay.paused'
  | 'overlay.stats'
  | 'overlay.update'
  | 'settlement.title';

export const STRINGS: Record<Lang, Readonly<Record<StringKey, string>>> = {
  ru: {
    'ace.bark.applaud.1': 'Бывает. Со всеми бывает.',
    'ace.bark.applaud.2': 'Заведение благодарит за доверие.',
    'ace.bark.applaud.3': 'Я бы сказал «не повезло», но мы оба знаем, что это не так.',
    'ace.bark.fidget.1': 'Хороший вечер. У вас.',
    'ace.bark.fidget.2': 'Это временно. Это всегда временно.',
    'ace.bark.fidget.3': 'Кто-то же должен выигрывать. Иногда.',
    'ace.bark.ovation.1': 'Достойно. Правда.',
    'ace.bark.ovation.2': 'Такое не отрепетируешь.',
    'ace.bark.ovation.3': 'Браво. Стоя. Я даже встал.',
    'ace.bark.thumbs_down.1': 'Осторожность — тоже стратегия.',
    'ace.bark.thumbs_down.2': 'Ещё шаг оставался. Один.',
    'ace.bark.thumbs_down.3': 'Соскок. Так и запишем.',
    'ace.bark.turn_away.1': 'Ничего не вижу. Совершенно ничем не занят.',
    'ace.bark.turn_away.2': 'Кажется, у меня срочное дело в другом конце арены.',
    'ace.bark.turn_away.3': 'Не смотрю. И вам не советую.',
    'ace.bark.yawn.1': 'Я подожду. Мне спешить некуда.',
    'ace.bark.yawn.2': 'Карты, между прочим, не бесплатные. Хотя нет, бесплатные.',
    'ace.bark.yawn.3': 'Третья комната. Я уже начал полировать перчатки.',
    'bet.all_chips.name': 'Собери все фишки',
    'bet.demolitionist.name': 'Подрывник',
    'bet.no_damage.name': 'Без урона',
    'bet.no_dash.name': 'Без рывка',
    'bet.no_red_zone.name': 'Не заходи в красную зону',
    'bet.under_45s.name': 'Быстрее 45 секунд',
    'error.webgl2':
      'WebGL2 недоступен: без него игра не рисуется. Обновите браузер или включите аппаратное ускорение.',
    'overlay.dropped': 'ПОТЕРЯНО ФИГУР {count}',
    'overlay.halt.hint':
      'Это дефект ядра, а не ваш ход. P или Esc — продолжить, F5 — начать заново.',
    'overlay.halt.report': 'Баг-репорт сохранён: {file}',
    'overlay.halt.title': 'Симуляция остановлена: нарушен инвариант',
    'overlay.halt.where': 'сид {seed} · тик {tick} · сборка {build}',
    'overlay.paused': 'ПАУЗА',
    'overlay.stats':
      '{build}  ·  тик {tick}  ·  {fps} FPS  ·  сид {seed}  ·  игроков {players}  ·  {hash}',
    'overlay.update': 'Доступна новая версия ({build}) — обновите страницу',
    'settlement.title': 'Расчёт',
  },
  en: {
    'ace.bark.applaud.1': 'It happens. It happens to everyone.',
    'ace.bark.applaud.2': 'The house thanks you for your trust.',
    'ace.bark.applaud.3': 'I would say bad luck, but we both know better.',
    'ace.bark.fidget.1': 'A fine evening. For you.',
    'ace.bark.fidget.2': 'This is temporary. It is always temporary.',
    'ace.bark.fidget.3': 'Somebody has to win. Occasionally.',
    'ace.bark.ovation.1': 'Worthy. Genuinely.',
    'ace.bark.ovation.2': 'That one cannot be rehearsed.',
    'ace.bark.ovation.3': 'Bravo. Standing. I even got up.',
    'ace.bark.thumbs_down.1': 'Caution is a strategy too.',
    'ace.bark.thumbs_down.2': 'One step short. One.',
    'ace.bark.thumbs_down.3': 'Cashed out. So noted.',
    'ace.bark.turn_away.1': 'Seeing nothing. Occupied with nothing whatsoever.',
    'ace.bark.turn_away.2': 'I seem to have urgent business across the arena.',
    'ace.bark.turn_away.3': 'Not looking. Not recommending it either.',
    'ace.bark.yawn.1': 'I can wait. Time is on the house.',
    'ace.bark.yawn.2': 'The cards are not free, you know. Correction: they are.',
    'ace.bark.yawn.3': 'Third room. I have started polishing the gloves.',
    'bet.all_chips.name': 'Collect Every Chip',
    'bet.demolitionist.name': 'Demolitionist',
    'bet.no_damage.name': 'No Damage',
    'bet.no_dash.name': 'No Dash',
    'bet.no_red_zone.name': 'Stay Out of the Red Zone',
    'bet.under_45s.name': 'Under 45 Seconds',
    'error.webgl2':
      'WebGL2 is unavailable: the game cannot draw without it. Update the browser or enable hardware acceleration.',
    'overlay.dropped': 'SHAPES DROPPED {count}',
    'overlay.halt.hint':
      'This is a core defect, not your move. P or Esc to continue, F5 to start over.',
    'overlay.halt.report': 'Bug report saved: {file}',
    'overlay.halt.title': 'Simulation halted: invariant broken',
    'overlay.halt.where': 'seed {seed} · tick {tick} · build {build}',
    'overlay.paused': 'PAUSED',
    'overlay.stats':
      '{build}  ·  tick {tick}  ·  {fps} FPS  ·  seed {seed}  ·  players {players}  ·  {hash}',
    'overlay.update': 'A new build ({build}) is available — reload the page',
    'settlement.title': 'Settlement',
  },
};

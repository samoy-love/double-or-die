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
  | 'ace_bet.desc'
  | 'ace_bet.stake'
  | 'ace_bet.title'
  | 'bet.all_chips.name'
  | 'bet.demolitionist.name'
  | 'bet.no_damage.name'
  | 'bet.no_dash.name'
  | 'bet.no_red_zone.name'
  | 'bet.under_45s.name'
  | 'boss.counter_bet.hint'
  | 'boss.counter_bet.label'
  | 'door.hint'
  | 'door.title'
  | 'door.type.event'
  | 'door.type.fat'
  | 'door.type.fight'
  | 'door.type.gift'
  | 'door.type.pit'
  | 'door.type.pit.hint'
  | 'door.type.shop'
  | 'error.webgl2'
  | 'haggle.bet'
  | 'haggle.empty'
  | 'haggle.sell'
  | 'haggle.title'
  | 'house.cut'
  | 'house.debt'
  | 'house.pay'
  | 'house.purse'
  | 'house.short'
  | 'house.title'
  | 'menu.confirm.key'
  | 'menu.play'
  | 'menu.settings'
  | 'menu.tagline'
  | 'menu.title'
  | 'menu.tutorial.key'
  | 'menu.tutorial.pad'
  | 'overlay.dropped'
  | 'overlay.halt.hint'
  | 'overlay.halt.report'
  | 'overlay.halt.title'
  | 'overlay.halt.where'
  | 'overlay.paused'
  | 'overlay.stats'
  | 'overlay.update'
  | 'screen.cancel.key'
  | 'screen.cancel.pad'
  | 'screen.confirm.key'
  | 'screen.confirm.pad'
  | 'screen.sell.key'
  | 'screen.sell.pad'
  | 'settings.cashout_focus.desc'
  | 'settings.cashout_focus.off'
  | 'settings.cashout_focus.on'
  | 'settings.title'
  | 'settlement.legup'
  | 'settlement.title'
  | 'shop.hint'
  | 'shop.leave'
  | 'shop.sold'
  | 'shop.title'
  | 'summary.again'
  | 'summary.death'
  | 'summary.floor'
  | 'summary.keys'
  | 'summary.keys.bets'
  | 'summary.keys.boss'
  | 'summary.keys.chips'
  | 'summary.keys.floor'
  | 'summary.paid'
  | 'summary.victory'
  | 'tutorial.ace.desc'
  | 'tutorial.ace.name'
  | 'tutorial.appetite.desc'
  | 'tutorial.appetite.name'
  | 'tutorial.bet.desc'
  | 'tutorial.bet.name'
  | 'tutorial.debt_pit.desc'
  | 'tutorial.debt_pit.name'
  | 'tutorial.fat_fight.desc'
  | 'tutorial.fat_fight.name'
  | 'tutorial.gift.desc'
  | 'tutorial.gift.name'
  | 'tutorial.hint'
  | 'tutorial.house_cut.desc'
  | 'tutorial.house_cut.name'
  | 'tutorial.keys.desc'
  | 'tutorial.keys.name'
  | 'tutorial.title'
  | 'tutorial.trampoline.desc'
  | 'tutorial.trampoline.name'
  | 'upgrade.damage_up.name'
  | 'upgrade.dash_cooldown.name'
  | 'upgrade.drop_up.name'
  | 'upgrade.extra_heart.name'
  | 'upgrade.magnet.name'
  | 'upgrade.speed_up.name';

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
    'ace_bet.desc':
      'Ставит против вас без вашего согласия. Смолчите — карта уйдёт вместе с волной, без потерь',
    'ace_bet.stake': 'Его кон',
    'ace_bet.title': 'Крупье предлагает пари',
    'bet.all_chips.name': 'Собери все фишки',
    'bet.demolitionist.name': 'Подрывник',
    'bet.no_damage.name': 'Без урона',
    'bet.no_dash.name': 'Без рывка',
    'bet.no_red_zone.name': 'Не заходи в красную зону',
    'bet.under_45s.name': 'Быстрее 45 секунд',
    'boss.counter_bet.hint':
      'Заденешь босса — сорвёшь её и оглушишь на 4 с; выждешь — он подлечится на 15%',
    'boss.counter_bet.label': 'Встречная ставка — {seconds} с',
    'door.hint': 'Заведение не возвращает выбор',
    'door.title': 'Выбирайте дверь',
    'door.type.event': 'Событие',
    'door.type.fat': 'Жирный бой',
    'door.type.fight': 'Бой',
    'door.type.gift': 'Дар',
    'door.type.pit': 'Долговая яма',
    'door.type.pit.hint': 'Тяжелее боя, снимает проклятие',
    'door.type.shop': 'Лавка',
    'error.webgl2':
      'WebGL2 недоступен: без него игра не рисуется. Обновите браузер или включите аппаратное ускорение.',
    'haggle.bet': 'Взять пари в следующей комнате',
    'haggle.empty': 'Продавать нечего',
    'haggle.sell': 'Продать апгрейд',
    'haggle.title': 'Крупье предлагает выбор',
    'house.cut': 'Доля заведения',
    'house.debt': 'Взять в долг',
    'house.pay': 'Заплатить',
    'house.purse': 'В кошельке',
    'house.short': 'Не хватает',
    'house.title': 'Стол берёт своё',
    'menu.confirm.key': 'Enter/Space или клик — играть',
    'menu.play': 'Играть',
    'menu.settings': 'Настройки',
    'menu.tagline': 'Сложность выбираете вы',
    'menu.title': 'Double or Die',
    'menu.tutorial.key': 'Q — как играть',
    'menu.tutorial.pad': 'B — как играть',
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
    'screen.cancel.key': 'Q — отказаться',
    'screen.cancel.pad': 'B — отказаться',
    'screen.confirm.key': 'Enter/Tab — подтвердить',
    'screen.confirm.pad': 'RB — подтвердить',
    'screen.sell.key': 'Стрелка влево — продать',
    'screen.sell.pad': 'Стик влево — продать',
    'settings.cashout_focus.desc':
      '«Забрать» берёт пари, выбранное крестовиной ← →, вместо самого выгодного',
    'settings.cashout_focus.off': 'Поштучный забор: выключен',
    'settings.cashout_focus.on': 'Поштучный забор: включён',
    'settings.title': 'Настройки',
    'settlement.legup': 'Трамплин: следующее пари — лёгкое, ×1.5',
    'settlement.title': 'Расчёт',
    'shop.hint': 'Заведение не торгуется',
    'shop.leave': 'Уйти без покупки',
    'shop.sold': 'Продано',
    'shop.title': 'Лавка',
    'summary.again': 'Ещё разок',
    'summary.death': 'Мёртвый не выигрывает',
    'summary.floor': 'Этаж',
    'summary.keys': 'Ключи за забег',
    'summary.keys.bets': 'Пари выполнено: {n} · +{k}',
    'summary.keys.boss': 'Боссов побеждено: {n} · +{k}',
    'summary.keys.chips': 'Фишки унесены: {n} · +{k}',
    'summary.keys.floor': 'Минимум за забег · +1',
    'summary.paid': 'Отдано заведению',
    'summary.victory': 'Вы ушли своими ногами',
    'tutorial.ace.desc': 'Дилер за столом. Следит за вами и комментирует ходы',
    'tutorial.ace.name': 'Крупье',
    'tutorial.appetite.desc':
      'Выбор размера будущей ставки перед комнатой: скромно ({tier1}), нормально ({tier2}), по-крупному ({tier3}) — кон никогда не больше кошелька',
    'tutorial.appetite.name': 'Аппетит',
    'tutorial.bet.desc':
      'Карта на полу — условие на бой. Подобрали кнопкой — кон списан, выполнили условие — забрали с множителем',
    'tutorial.bet.name': 'Пари',
    'tutorial.debt_pit.desc':
      'Появляется вместо одной из трёх дверей, только пока вы должны. Тяжелее обычного боя, но снимает проклятие — как и любая пройденная комната',
    'tutorial.debt_pit.name': 'Долговая яма',
    'tutorial.fat_fight.desc':
      '+50% врагов и +100% выплата за комнату, лишняя карта пари в придачу',
    'tutorial.fat_fight.name': 'Жирный бой',
    'tutorial.gift.desc':
      'Дверь после боя: бесплатный апгрейд на выбор из трёх, без повторов уже взятого',
    'tutorial.gift.name': 'Дар',
    'tutorial.hint': 'Термины стола — коротко. Учится игра действием, это лишь справка',
    'tutorial.house_cut.desc':
      'Плата за этаж из выигрыша. Не хватает — торг: продать апгрейд, взять пари или уйти в долг',
    'tutorial.house_cut.name': 'Доля заведения',
    'tutorial.keys.desc':
      'Валюта прогресса между забегами: за выполненные пари и победу над боссом',
    'tutorial.keys.name': 'Ключи',
    'tutorial.title': 'Как играть',
    'tutorial.trampoline.desc':
      'После провала пари следующая комната даёт лёгкую ставку — трудности не идут подряд',
    'tutorial.trampoline.name': 'Трамплин',
    'upgrade.damage_up.name': 'Урон +20%',
    'upgrade.dash_cooldown.name': 'Кулдаун рывка −30%',
    'upgrade.drop_up.name': 'Дроп +48%',
    'upgrade.extra_heart.name': '+1 сердце',
    'upgrade.magnet.name': 'Магнит',
    'upgrade.speed_up.name': 'Скорость +15%',
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
    'ace_bet.desc':
      'Betting against you without asking. Stay silent and the card leaves with the wave, no cost',
    'ace_bet.stake': 'His stake',
    'ace_bet.title': 'The Ace offers a bet',
    'bet.all_chips.name': 'Collect Every Chip',
    'bet.demolitionist.name': 'Demolitionist',
    'bet.no_damage.name': 'No Damage',
    'bet.no_dash.name': 'No Dash',
    'bet.no_red_zone.name': 'Stay Out of the Red Zone',
    'bet.under_45s.name': 'Under 45 Seconds',
    'boss.counter_bet.hint':
      'Hit the boss to break it and stun him for 4s; wait it out and he heals 15%',
    'boss.counter_bet.label': 'Counter bet — {seconds}s',
    'door.hint': 'The house does not refund choices',
    'door.title': 'Choose a door',
    'door.type.event': 'Event',
    'door.type.fat': 'Fat fight',
    'door.type.fight': 'Fight',
    'door.type.gift': 'Gift',
    'door.type.pit': 'Debt pit',
    'door.type.pit.hint': 'Harder fight, clears the curse',
    'door.type.shop': 'Shop',
    'error.webgl2':
      'WebGL2 is unavailable: the game cannot draw without it. Update the browser or enable hardware acceleration.',
    'haggle.bet': 'Take a bet in the next room',
    'haggle.empty': 'Nothing to sell',
    'haggle.sell': 'Sell an upgrade',
    'haggle.title': 'The Ace offers a choice',
    'house.cut': 'House cut',
    'house.debt': 'Go into debt',
    'house.pay': 'Pay up',
    'house.purse': 'In the purse',
    'house.short': 'Short',
    'house.title': 'The house takes its cut',
    'menu.confirm.key': 'Enter/Space or click to play',
    'menu.play': 'Play',
    'menu.settings': 'Settings',
    'menu.tagline': 'You pick the difficulty',
    'menu.title': 'Double or Die',
    'menu.tutorial.key': 'Q — how to play',
    'menu.tutorial.pad': 'B — how to play',
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
    'screen.cancel.key': 'Q to decline',
    'screen.cancel.pad': 'B to decline',
    'screen.confirm.key': 'Enter/Tab to confirm',
    'screen.confirm.pad': 'RB to confirm',
    'screen.sell.key': 'Left arrow to sell',
    'screen.sell.pad': 'Stick left to sell',
    'settings.cashout_focus.desc':
      '"Cash out" takes the bet chosen with the D-pad ← →, instead of the most valuable one',
    'settings.cashout_focus.off': 'Focused cash out: off',
    'settings.cashout_focus.on': 'Focused cash out: on',
    'settings.title': 'Settings',
    'settlement.legup': 'Leg up: next bet is easy, ×1.5',
    'settlement.title': 'Settlement',
    'shop.hint': 'The house does not haggle',
    'shop.leave': 'Leave empty-handed',
    'shop.sold': 'Sold',
    'shop.title': 'Shop',
    'summary.again': 'One more',
    'summary.death': 'The dead do not collect',
    'summary.floor': 'Floor',
    'summary.keys': 'Keys earned',
    'summary.keys.bets': 'Bets completed: {n} · +{k}',
    'summary.keys.boss': 'Bosses beaten: {n} · +{k}',
    'summary.keys.chips': 'Chips carried out: {n} · +{k}',
    'summary.keys.floor': 'Run minimum · +1',
    'summary.paid': 'Paid to the house',
    'summary.victory': 'You walked out on your own',
    'tutorial.ace.desc': 'The dealer at the table. Watches you play and comments on it',
    'tutorial.ace.name': 'Ace',
    'tutorial.appetite.desc':
      'Pick the size of your next bet before a room: modest ({tier1}), normal ({tier2}), go big ({tier3}) — the stake never exceeds your wallet',
    'tutorial.appetite.name': 'Appetite',
    'tutorial.bet.desc':
      'A card on the floor is a condition for the fight. Pick it up — the stake is locked in; clear it — collect at the multiplier',
    'tutorial.bet.name': 'Bet',
    'tutorial.debt_pit.desc':
      'Replaces one of the three doors, only while you\'re in debt. Harder than a normal fight, but clears the curse — same as any cleared room',
    'tutorial.debt_pit.name': 'Debt pit',
    'tutorial.fat_fight.desc': '+50% enemies and +100% room payout, plus an extra bet card',
    'tutorial.fat_fight.name': 'Fat fight',
    'tutorial.gift.desc':
      'A door after the fight: a free upgrade, pick one of three, no repeats of what you already own',
    'tutorial.gift.name': 'Gift',
    'tutorial.hint':
      'Table terms, in short. The game is learned by doing — this is just a reference',
    'tutorial.house_cut.desc':
      'A payment out of your winnings at the end of a floor. Short on chips — haggle: sell an upgrade, take a bet, or go into debt',
    'tutorial.house_cut.name': 'House cut',
    'tutorial.keys.desc':
      'Currency for progress between runs: earned from cleared bets and boss wins',
    'tutorial.keys.name': 'Keys',
    'tutorial.title': 'How to play',
    'tutorial.trampoline.desc':
      'After a failed bet, the next room offers an easy one — losses don\'t chain',
    'tutorial.trampoline.name': 'Leg up',
    'upgrade.damage_up.name': 'Damage +20%',
    'upgrade.dash_cooldown.name': 'Dash Cooldown −30%',
    'upgrade.drop_up.name': 'Chip Drop +48%',
    'upgrade.extra_heart.name': '+1 Heart',
    'upgrade.magnet.name': 'Magnet',
    'upgrade.speed_up.name': 'Speed +15%',
  },
};

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
  | 'appetite.hint.key'
  | 'appetite.hint.pad'
  | 'appetite.tier.1'
  | 'appetite.tier.2'
  | 'appetite.tier.3'
  | 'appetite.title'
  | 'bet.all_chips.name'
  | 'bet.demolitionist.name'
  | 'bet.no_damage.name'
  | 'bet.no_dash.name'
  | 'bet.no_red_zone.name'
  | 'bet.under_45s.name'
  | 'boss.counter_bet.hint'
  | 'boss.counter_bet.label'
  | 'coach.card.key'
  | 'coach.card.pad'
  | 'coach.cashout.key'
  | 'coach.cashout.pad'
  | 'coach.dash.key'
  | 'coach.dash.pad'
  | 'coach.door.key'
  | 'coach.door.pad'
  | 'coach.move.key'
  | 'coach.move.pad'
  | 'coach.pause.key'
  | 'coach.pause.pad'
  | 'coach.settle.key'
  | 'coach.settle.pad'
  | 'coach.take.key'
  | 'coach.take.pad'
  | 'controls.accept'
  | 'controls.accept.key'
  | 'controls.accept.pad'
  | 'controls.aim'
  | 'controls.aim.key'
  | 'controls.aim.pad'
  | 'controls.appetite'
  | 'controls.appetite.key'
  | 'controls.appetite.pad'
  | 'controls.cancel'
  | 'controls.cancel.key'
  | 'controls.cancel.pad'
  | 'controls.cashout'
  | 'controls.cashout.key'
  | 'controls.cashout.pad'
  | 'controls.dash'
  | 'controls.dash.key'
  | 'controls.dash.pad'
  | 'controls.fire'
  | 'controls.fire.key'
  | 'controls.fire.pad'
  | 'controls.key'
  | 'controls.move'
  | 'controls.move.key'
  | 'controls.move.pad'
  | 'controls.pad'
  | 'controls.pause'
  | 'controls.pause.key'
  | 'controls.pause.pad'
  | 'controls.screen'
  | 'controls.screen.key'
  | 'controls.screen.pad'
  | 'controls.take'
  | 'controls.take.key'
  | 'controls.take.pad'
  | 'curse.blackout'
  | 'curse.blood'
  | 'curse.commission'
  | 'curse.frozen'
  | 'curse.hustle'
  | 'curse.lead_feet'
  | 'death.hint'
  | 'death.title'
  | 'door.hint'
  | 'door.title'
  | 'door.type.fat'
  | 'door.type.fat.hint'
  | 'door.type.fight'
  | 'door.type.fight.hint'
  | 'door.type.gift'
  | 'door.type.gift.hint'
  | 'door.type.pit'
  | 'door.type.pit.hint'
  | 'door.type.shop'
  | 'door.type.shop.hint'
  | 'door.where'
  | 'error.webgl2'
  | 'gift.hint'
  | 'gift.title'
  | 'haggle.bet'
  | 'haggle.empty'
  | 'haggle.hint'
  | 'haggle.sell'
  | 'haggle.sell.named'
  | 'haggle.title'
  | 'house.cut'
  | 'house.debt'
  | 'house.hint'
  | 'house.pay'
  | 'house.purse'
  | 'house.short'
  | 'house.title'
  | 'hud.debt'
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
  | 'pause.hint'
  | 'pause.resume'
  | 'pause.title'
  | 'screen.cancel.key'
  | 'screen.cancel.pad'
  | 'screen.confirm.key'
  | 'screen.confirm.pad'
  | 'screen.menu.key'
  | 'screen.menu.pad'
  | 'screen.select.key'
  | 'screen.select.pad'
  | 'screen.sell.key'
  | 'screen.sell.pad'
  | 'settings.cashout_focus.desc.key'
  | 'settings.cashout_focus.desc.pad'
  | 'settings.cashout_focus.off'
  | 'settings.cashout_focus.on'
  | 'settings.hint'
  | 'settings.title'
  | 'settings.ui_scale'
  | 'settings.ui_scale.desc'
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
  | 'summary.nearmiss'
  | 'summary.paid'
  | 'summary.seed'
  | 'summary.victory'
  | 'tutorial.ace.desc'
  | 'tutorial.ace.name'
  | 'tutorial.appetite.desc'
  | 'tutorial.appetite.name'
  | 'tutorial.bet.desc'
  | 'tutorial.bet.name'
  | 'tutorial.cashout.desc'
  | 'tutorial.cashout.name'
  | 'tutorial.chips.desc'
  | 'tutorial.chips.name'
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
  | 'tutorial.page.controls'
  | 'tutorial.page.hint'
  | 'tutorial.page.terms'
  | 'tutorial.stake.desc'
  | 'tutorial.stake.name'
  | 'tutorial.title'
  | 'tutorial.trampoline.desc'
  | 'tutorial.trampoline.name'
  | 'upgrade.damage_up.desc'
  | 'upgrade.damage_up.name'
  | 'upgrade.dash_cooldown.desc'
  | 'upgrade.dash_cooldown.name'
  | 'upgrade.drop_up.desc'
  | 'upgrade.drop_up.name'
  | 'upgrade.extra_heart.desc'
  | 'upgrade.extra_heart.name'
  | 'upgrade.magnet.desc'
  | 'upgrade.magnet.name'
  | 'upgrade.speed_up.desc'
  | 'upgrade.speed_up.name';

export const STRINGS: Record<Lang, Readonly<Record<StringKey, string>>> = {
  ru: {
    'ace.bark.applaud.1': 'Бывает. У меня — часто.',
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
    'appetite.hint.key': '1 / 2 / 3 — тир кона',
    'appetite.hint.pad': 'Крестовина ↑ ↓ — тир кона',
    'appetite.tier.1': 'Скромно',
    'appetite.tier.2': 'Нормально',
    'appetite.tier.3': 'По-крупному',
    'appetite.title': 'Аппетит на комнату',
    'bet.all_chips.name': 'Собери все фишки',
    'bet.demolitionist.name': 'Подрывник',
    'bet.no_damage.name': 'Без урона',
    'bet.no_dash.name': 'Без рывка',
    'bet.no_red_zone.name': 'Не заходи в красную зону',
    'bet.under_45s.name': 'Быстрее 45 секунд',
    'boss.counter_bet.hint':
      'Заденешь босса — сорвёшь её и оглушишь на 4 с; выждешь — он подлечится на 15%',
    'boss.counter_bet.label': 'Встречная ставка — {seconds} с',
    'coach.card.key': 'На полу карта пари. Подойдите и встаньте на неё',
    'coach.card.pad': 'На полу карта пари. Подойдите и встаньте на неё',
    'coach.cashout.key': 'Shift — забрать сейчас, не дожидаясь конца',
    'coach.cashout.pad': 'LB — забрать сейчас, не дожидаясь конца',
    'coach.dash.key': 'Space или ПКМ — рывок: он проносит сквозь снаряды',
    'coach.dash.pad': 'A — рывок: он проносит сквозь снаряды',
    'coach.door.key': 'Выберите дверь и тир кона: он спишется за каждую карту',
    'coach.door.pad': 'Выберите дверь и тир кона: он спишется за каждую карту',
    'coach.move.key': 'WASD — идти, мышь — целиться, ЛКМ — огонь',
    'coach.move.pad': 'Левый стик — идти, правый — целиться, RT — огонь',
    'coach.pause.key': 'Esc или P — пауза: там настройки и справка',
    'coach.pause.pad': 'Start — пауза: там настройки и справка',
    'coach.settle.key': 'Расчёт: чем кончились пари. Красным — насколько не хватило',
    'coach.settle.pad': 'Расчёт: чем кончились пари. Красным — насколько не хватило',
    'coach.take.key': 'X — взять пари: кон спишется, условие пойдёт',
    'coach.take.pad': 'LT — взять пари: кон спишется, условие пойдёт',
    'controls.accept': 'Принять «Удвоим?»',
    'controls.accept.key': 'E',
    'controls.accept.pad': 'Y',
    'controls.aim': 'Прицел',
    'controls.aim.key': 'Мышь',
    'controls.aim.pad': 'Правый стик',
    'controls.appetite': 'Аппетит',
    'controls.appetite.key': '1 / 2 / 3',
    'controls.appetite.pad': 'Крестовина ↑ ↓',
    'controls.cancel': 'Отказаться',
    'controls.cancel.key': 'Q',
    'controls.cancel.pad': 'B',
    'controls.cashout': 'Забрать',
    'controls.cashout.key': 'Shift',
    'controls.cashout.pad': 'LB',
    'controls.dash': 'Рывок',
    'controls.dash.key': 'Space или ПКМ',
    'controls.dash.pad': 'A',
    'controls.fire': 'Огонь',
    'controls.fire.key': 'ЛКМ',
    'controls.fire.pad': 'RT',
    'controls.key': 'Клавиатура и мышь',
    'controls.move': 'Движение',
    'controls.move.key': 'WASD',
    'controls.move.pad': 'Левый стик',
    'controls.pad': 'Геймпад',
    'controls.pause': 'Пауза',
    'controls.pause.key': 'Esc или P',
    'controls.pause.pad': 'Start',
    'controls.screen': 'Выбор на экране',
    'controls.screen.key': '← → или A / D, Enter/Tab',
    'controls.screen.pad': 'Стик ← →, RB',
    'controls.take': 'Подобрать карту',
    'controls.take.key': 'X, стоя на карте',
    'controls.take.pad': 'LT, стоя на карте',
    'curse.blackout': 'Тьма',
    'curse.blood': 'Кровью',
    'curse.commission': 'Комиссия',
    'curse.frozen': 'Заморозка',
    'curse.hustle': 'Суета',
    'curse.lead_feet': 'Свинцовые ноги',
    'death.hint': 'Итоги через',
    'death.title': 'Клиент закончился',
    'door.hint': 'Заведение не возвращает выбор',
    'door.title': 'Выбирайте дверь',
    'door.type.fat': 'Жирный бой',
    'door.type.fat.hint': 'Больше врагов, лишняя карта пари',
    'door.type.fight': 'Бой',
    'door.type.fight.hint': 'Обычная комната',
    'door.type.gift': 'Дар',
    'door.type.gift.hint': 'Бой, а после — апгрейд бесплатно',
    'door.type.pit': 'Долговая яма',
    'door.type.pit.hint': 'Тяжелее боя: +25% выплаты, снимает проклятие',
    'door.type.shop': 'Лавка',
    'door.type.shop.hint': 'Бой, а после — три апгрейда на выбор',
    'door.where': 'Этаж {floor} · комната {room} из {rooms} · кошелёк {chips}',
    'error.webgl2':
      'WebGL2 недоступен: без него игра не рисуется. Обновите браузер или включите аппаратное ускорение.',
    'gift.hint': 'Заведение угощает: апгрейд бесплатно',
    'gift.title': 'Дар',
    'haggle.bet': 'Взять пари в следующей комнате',
    'haggle.empty': 'Продавать нечего',
    'haggle.hint': 'Не хватает на оплату — выберите один из трёх выходов',
    'haggle.sell': 'Продать апгрейд',
    'haggle.sell.named': 'Продать: {name}',
    'haggle.title': 'Крупье предлагает выбор',
    'house.cut': 'Доля заведения',
    'house.debt': 'Взять в долг — позже появится долговая яма',
    'house.hint': 'Плата за этаж назначена заранее и растёт — один раз, на выходе',
    'house.pay': 'Заплатить',
    'house.purse': 'В кошельке',
    'house.short': 'Не хватает',
    'house.title': 'Стол берёт своё',
    'hud.debt': 'Долг',
    'menu.confirm.key': 'Enter/Tab или клик — играть',
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
    'pause.hint': 'Забег ждёт. Часы остановлены',
    'pause.resume': 'Продолжить',
    'pause.title': 'Пауза',
    'screen.cancel.key': 'Q — отказаться',
    'screen.cancel.pad': 'B — отказаться',
    'screen.confirm.key': 'Enter/Tab — подтвердить',
    'screen.confirm.pad': 'RB — подтвердить',
    'screen.menu.key': 'Q — в меню',
    'screen.menu.pad': 'B — в меню',
    'screen.select.key': '← → — выбрать',
    'screen.select.pad': 'Стик ← → — выбрать',
    'screen.sell.key': 'Стрелка влево — продать',
    'screen.sell.pad': 'Стик влево — продать',
    'settings.cashout_focus.desc.key':
      '«Забрать» берёт пари, выбранное стрелками ← →, вместо самого выгодного',
    'settings.cashout_focus.desc.pad':
      '«Забрать» берёт пари, выбранное крестовиной ← →, вместо самого выгодного',
    'settings.cashout_focus.off': 'Поштучный забор: выключен',
    'settings.cashout_focus.on': 'Поштучный забор: включён',
    'settings.hint': '← → — пункт, Enter/Tab — переключить',
    'settings.title': 'Настройки',
    'settings.ui_scale': 'Масштаб интерфейса: {value}%',
    'settings.ui_scale.desc':
      'Крупнее весь текст и карточки экранов. Меньше 100% не бывает: ниже нарушается минимум в 24 px',
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
    'summary.nearmiss': 'Не хватило {pct}% до последнего пари',
    'summary.paid': 'Отдано заведению',
    'summary.seed': 'сид {seed} · сборка {build}',
    'summary.victory': 'Вы ушли своими ногами',
    'tutorial.ace.desc': 'Дилер за столом. Следит за вами и комментирует ходы',
    'tutorial.ace.name': 'Крупье',
    'tutorial.appetite.desc': 'Размер кона перед комнатой: {tier1}, {tier2} или {tier3}',
    'tutorial.appetite.name': 'Аппетит',
    'tutorial.bet.desc': 'Карта на полу — условие на бой. Выполнил — забрал с множителем',
    'tutorial.bet.name': 'Пари',
    'tutorial.cashout.desc':
      'Обналичить пари не дожидаясь конца: чем больше сделано, тем больше дадут',
    'tutorial.cashout.name': 'Забрать',
    'tutorial.chips.desc': 'Валюта стола: коны, лавка, доля заведения. Остаток уходит в ключи',
    'tutorial.chips.name': 'Фишки',
    'tutorial.debt_pit.desc':
      'Дверь, пока вы должны: тяжелее боя, но +25% выплаты и снятие проклятия',
    'tutorial.debt_pit.name': 'Долговая яма',
    'tutorial.fat_fight.desc': '+50% врагов, +100% выплата и лишняя карта пари',
    'tutorial.fat_fight.name': 'Жирный бой',
    'tutorial.gift.desc': 'Бой, а после — бесплатный апгрейд на выбор из трёх',
    'tutorial.gift.name': 'Дар',
    'tutorial.hint': 'Термины стола — коротко. Учится игра действием, это лишь справка',
    'tutorial.house_cut.desc': 'Назначенная плата за этаж, растёт с этажами. Не хватает — торг',
    'tutorial.house_cut.name': 'Доля заведения',
    'tutorial.keys.desc': 'Валюта между забегами: за пари и за победу над боссом',
    'tutorial.keys.name': 'Ключи',
    'tutorial.page.controls': 'Управление',
    'tutorial.page.hint': '← → — другая страница',
    'tutorial.page.terms': 'Термины',
    'tutorial.stake.desc': 'Сколько списано за карту. Куш — кон, умноженный на множитель',
    'tutorial.stake.name': 'Кон',
    'tutorial.title': 'Как играть',
    'tutorial.trampoline.desc': 'После провала следующее пари лёгкое: беды не идут подряд',
    'tutorial.trampoline.name': 'Трамплин',
    'upgrade.damage_up.desc': 'Пуля бьёт сильнее',
    'upgrade.damage_up.name': 'Урон +20%',
    'upgrade.dash_cooldown.desc': 'Рывок восстанавливается быстрее',
    'upgrade.dash_cooldown.name': 'Кулдаун рывка −30%',
    'upgrade.drop_up.desc': 'Враги чаще роняют фишки',
    'upgrade.drop_up.name': 'Дроп +48%',
    'upgrade.extra_heart.desc': 'Ещё одно сердце, максимум пять',
    'upgrade.extra_heart.name': '+1 сердце',
    'upgrade.magnet.desc': 'Фишки притягиваются издалека',
    'upgrade.magnet.name': 'Магнит',
    'upgrade.speed_up.desc': 'Желешка бегает быстрее',
    'upgrade.speed_up.name': 'Скорость +15%',
  },
  en: {
    'ace.bark.applaud.1': 'It happens. To me, often.',
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
    'appetite.hint.key': '1 / 2 / 3 for the stake tier',
    'appetite.hint.pad': 'D-pad ↑ ↓ for the stake tier',
    'appetite.tier.1': 'Modest',
    'appetite.tier.2': 'Normal',
    'appetite.tier.3': 'Go big',
    'appetite.title': 'Appetite for this room',
    'bet.all_chips.name': 'Collect Every Chip',
    'bet.demolitionist.name': 'Demolitionist',
    'bet.no_damage.name': 'No Damage',
    'bet.no_dash.name': 'No Dash',
    'bet.no_red_zone.name': 'Stay Out of the Red Zone',
    'bet.under_45s.name': 'Under 45 Seconds',
    'boss.counter_bet.hint':
      'Hit the boss to break it and stun him for 4s; wait it out and he heals 15%',
    'boss.counter_bet.label': 'Counter bet — {seconds}s',
    'coach.card.key': 'A bet card on the floor. Walk over and stand on it',
    'coach.card.pad': 'A bet card on the floor. Walk over and stand on it',
    'coach.cashout.key': 'Shift cashes out now, without waiting for the end',
    'coach.cashout.pad': 'LB cashes out now, without waiting for the end',
    'coach.dash.key': 'Space or RMB to dash: it carries you through bullets',
    'coach.dash.pad': 'A to dash: it carries you through bullets',
    'coach.door.key': 'Pick a door and a stake tier: it is paid per card',
    'coach.door.pad': 'Pick a door and a stake tier: it is paid per card',
    'coach.move.key': 'WASD to move, mouse to aim, LMB to fire',
    'coach.move.pad': 'Left stick to move, right to aim, RT to fire',
    'coach.pause.key': 'Esc or P pauses: settings and help live there',
    'coach.pause.pad': 'Start pauses: settings and help live there',
    'coach.settle.key': 'Settlement: how the bets ended. Red is how much was missing',
    'coach.settle.pad': 'Settlement: how the bets ended. Red is how much was missing',
    'coach.take.key': 'X takes the bet: the stake is paid, the condition starts',
    'coach.take.pad': 'LT takes the bet: the stake is paid, the condition starts',
    'controls.accept': 'Accept “Double or nothing?”',
    'controls.accept.key': 'E',
    'controls.accept.pad': 'Y',
    'controls.aim': 'Aim',
    'controls.aim.key': 'Mouse',
    'controls.aim.pad': 'Right stick',
    'controls.appetite': 'Appetite',
    'controls.appetite.key': '1 / 2 / 3',
    'controls.appetite.pad': 'D-pad ↑ ↓',
    'controls.cancel': 'Decline',
    'controls.cancel.key': 'Q',
    'controls.cancel.pad': 'B',
    'controls.cashout': 'Cash out',
    'controls.cashout.key': 'Shift',
    'controls.cashout.pad': 'LB',
    'controls.dash': 'Dash',
    'controls.dash.key': 'Space or RMB',
    'controls.dash.pad': 'A',
    'controls.fire': 'Fire',
    'controls.fire.key': 'LMB',
    'controls.fire.pad': 'RT',
    'controls.key': 'Keyboard and mouse',
    'controls.move': 'Move',
    'controls.move.key': 'WASD',
    'controls.move.pad': 'Left stick',
    'controls.pad': 'Gamepad',
    'controls.pause': 'Pause',
    'controls.pause.key': 'Esc or P',
    'controls.pause.pad': 'Start',
    'controls.screen': 'Choosing on a screen',
    'controls.screen.key': '← → or A / D, Enter/Tab',
    'controls.screen.pad': 'Stick ← →, RB',
    'controls.take': 'Pick up a card',
    'controls.take.key': 'X, standing on it',
    'controls.take.pad': 'LT, standing on it',
    'curse.blackout': 'Blackout',
    'curse.blood': 'Paid in Blood',
    'curse.commission': 'Commission',
    'curse.frozen': 'Frozen Assets',
    'curse.hustle': 'Hustle',
    'curse.lead_feet': 'Lead Feet',
    'death.hint': 'Results in',
    'death.title': 'The client is done',
    'door.hint': 'The house does not refund choices',
    'door.title': 'Choose a door',
    'door.type.fat': 'Fat fight',
    'door.type.fat.hint': 'More enemies, an extra bet card',
    'door.type.fight': 'Fight',
    'door.type.fight.hint': 'A regular room',
    'door.type.gift': 'Gift',
    'door.type.gift.hint': 'Fight, then a free upgrade',
    'door.type.pit': 'Debt pit',
    'door.type.pit.hint': 'Harder fight: +25% payout, clears the curse',
    'door.type.shop': 'Shop',
    'door.type.shop.hint': 'Fight, then three upgrades to choose from',
    'door.where': 'Floor {floor} · room {room} of {rooms} · purse {chips}',
    'error.webgl2':
      'WebGL2 is unavailable: the game cannot draw without it. Update the browser or enable hardware acceleration.',
    'gift.hint': 'On the house: an upgrade for free',
    'gift.title': 'Gift',
    'haggle.bet': 'Take a bet in the next room',
    'haggle.empty': 'Nothing to sell',
    'haggle.hint': 'Short on the payment — pick one of three ways out',
    'haggle.sell': 'Sell an upgrade',
    'haggle.sell.named': 'Sell: {name}',
    'haggle.title': 'The Ace offers a choice',
    'house.cut': 'House cut',
    'house.debt': 'Go into debt — a debt pit door will follow',
    'house.hint': 'A fixed fee for the floor, growing — paid once, on the way out',
    'house.pay': 'Pay up',
    'house.purse': 'In the purse',
    'house.short': 'Short',
    'house.title': 'The house takes its cut',
    'hud.debt': 'Debt',
    'menu.confirm.key': 'Enter/Tab or click to play',
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
    'pause.hint': 'The run waits. The clock is stopped',
    'pause.resume': 'Resume',
    'pause.title': 'Paused',
    'screen.cancel.key': 'Q to decline',
    'screen.cancel.pad': 'B to decline',
    'screen.confirm.key': 'Enter/Tab to confirm',
    'screen.confirm.pad': 'RB to confirm',
    'screen.menu.key': 'Q for the menu',
    'screen.menu.pad': 'B for the menu',
    'screen.select.key': '← → to choose',
    'screen.select.pad': 'Stick ← → to choose',
    'screen.sell.key': 'Left arrow to sell',
    'screen.sell.pad': 'Stick left to sell',
    'settings.cashout_focus.desc.key':
      '"Cash out" takes the bet chosen with ← →, instead of the most valuable one',
    'settings.cashout_focus.desc.pad':
      '"Cash out" takes the bet chosen with the D-pad ← →, instead of the most valuable one',
    'settings.cashout_focus.off': 'Focused cash out: off',
    'settings.cashout_focus.on': 'Focused cash out: on',
    'settings.hint': '← → for the item, Enter/Tab to change',
    'settings.title': 'Settings',
    'settings.ui_scale': 'Interface scale: {value}%',
    'settings.ui_scale.desc':
      'Bigger text and cards on every screen. Never below 100%: that would break the 24 px minimum',
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
    'summary.nearmiss': '{pct}% short of the last bet',
    'summary.paid': 'Paid to the house',
    'summary.seed': 'seed {seed} · build {build}',
    'summary.victory': 'You walked out on your own',
    'tutorial.ace.desc': 'The dealer at the table. Watches you play and comments on it',
    'tutorial.ace.name': 'Ace',
    'tutorial.appetite.desc': 'Stake size, picked before a room: {tier1}, {tier2} or {tier3}',
    'tutorial.appetite.name': 'Appetite',
    'tutorial.bet.desc': 'A card on the floor is a condition. Clear it, collect the multiplier',
    'tutorial.bet.name': 'Bet',
    'tutorial.cashout.desc': 'Collect a bet before it ends: the more you did, the more you get',
    'tutorial.cashout.name': 'Cash out',
    'tutorial.chips.desc': 'The table currency: stakes, shop, house cut. Leftovers become keys',
    'tutorial.chips.name': 'Chips',
    'tutorial.debt_pit.desc':
      'A door while you owe: harder fight, but +25% payout and the curse cleared',
    'tutorial.debt_pit.name': 'Debt pit',
    'tutorial.fat_fight.desc': '+50% enemies, +100% payout, one extra bet card',
    'tutorial.fat_fight.name': 'Fat fight',
    'tutorial.gift.desc': 'Fight, then a free upgrade — one of three',
    'tutorial.gift.name': 'Gift',
    'tutorial.hint':
      'Table terms, in short. The game is learned by doing — this is just a reference',
    'tutorial.house_cut.desc': 'A set fee per floor, larger each floor. Short — haggle',
    'tutorial.house_cut.name': 'House cut',
    'tutorial.keys.desc': 'Currency between runs: from cleared bets and boss wins',
    'tutorial.keys.name': 'Keys',
    'tutorial.page.controls': 'Controls',
    'tutorial.page.hint': '← → for the other page',
    'tutorial.page.terms': 'Terms',
    'tutorial.stake.desc': 'What a card costs you. The pot is the stake times the multiplier',
    'tutorial.stake.name': 'Stake',
    'tutorial.title': 'How to play',
    'tutorial.trampoline.desc': 'After a failed bet the next one is easy: losses do not chain',
    'tutorial.trampoline.name': 'Leg up',
    'upgrade.damage_up.desc': 'Your bullets hit harder',
    'upgrade.damage_up.name': 'Damage +20%',
    'upgrade.dash_cooldown.desc': 'The dash comes back sooner',
    'upgrade.dash_cooldown.name': 'Dash Cooldown −30%',
    'upgrade.drop_up.desc': 'Enemies drop chips more often',
    'upgrade.drop_up.name': 'Chip Drop +48%',
    'upgrade.extra_heart.desc': 'One more heart, five at most',
    'upgrade.extra_heart.name': '+1 Heart',
    'upgrade.magnet.desc': 'Chips are pulled in from farther away',
    'upgrade.magnet.name': 'Magnet',
    'upgrade.speed_up.desc': 'The blob runs faster',
    'upgrade.speed_up.name': 'Speed +15%',
  },
};

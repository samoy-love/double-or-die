/**
 * Словарь строк: единственный способ получить букву на экран.
 *
 * Правило «весь текст через словарь» (UX §8) держится не совестью, а тремя
 * вещами сразу: ключи типизированы, поэтому опечатка падает компиляцией;
 * словарь генерируется из `content/strings.json`, поэтому переводчику не надо
 * открывать TypeScript; линтер `check:i18n` валит сборку на видимой строке,
 * вписанной мимо словаря.
 *
 * Язык выбирается один раз на загрузку и не меняется на лету. Смена языка
 * посреди забега потребовала бы пересобрать атлас глифов и перемерить каждую
 * надпись в кадре — работы на версию, а выгоды на ноль: язык выбирают в меню
 * до игры, а не между волнами.
 */

import { LANGS, STRINGS, type Lang, type StringKey } from './strings.generated';

export type { Lang, StringKey };

/**
 * Русский — исходник словаря, и он же запасной вариант.
 *
 * Непереведённый язык обязан показать русскую строку, а не ключ: `ace.bark.
 * yawn.2` на экране — это дефект, который игрок не отличит от поломки игры,
 * тогда как чужой язык он хотя бы опознает.
 */
const FALLBACK: Lang = LANGS[0];

let current: Lang = FALLBACK;

/**
 * Язык сборки: параметр URL сильнее языка браузера.
 *
 * `?lang=en` нужен агенту и плейтесту — переключить язык одним переходом, без
 * настроек ОС. Экран настроек приезжает позже и будет писать сюда же.
 */
export function detectLang(search: string, preferred: readonly string[]): Lang {
  const asked = new URLSearchParams(search).get('lang');
  if (isLang(asked)) return asked;
  for (const tag of preferred) {
    // `ru-RU` и `en-GB` — это тоже `ru` и `en`: регион не меняет ни одной
    // строки словаря, а требовать точного совпадения значит показать русскую
    // сборку всей Британии.
    const base = tag.toLowerCase().split('-')[0];
    if (isLang(base)) return base;
  }
  return FALLBACK;
}

export function setLang(lang: Lang): void {
  current = lang;
}

export function lang(): Lang {
  return current;
}

/**
 * Строка по ключу с именованными подстановками.
 *
 * Подстановки именованные, а не позиционные, потому что порядок слов — первое,
 * что меняется при переводе: «осталось 4 секунды» и «4 seconds left» ставят
 * число в разные места одной фразы.
 *
 * Пропущенный аргумент оставляет `{имя}` в строке, а не подставляет пустоту:
 * дыра в фразе читается как опечатка перевода и уходит в тикет к переводчику,
 * тогда как видимое `{seed}` ведёт туда, где его забыли передать.
 */
export function t(key: StringKey, params?: Readonly<Record<string, string | number>>): string {
  const value = STRINGS[current][key] || STRINGS[FALLBACK][key];
  if (!params) return value;
  return value.replace(/\{([a-z][a-zA-Z0-9]*)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined ? whole : String(v);
  });
}

/**
 * Все буквы, которые сборка вообще способна показать.
 *
 * Атлас глифов растрируется один раз на загрузку, и знать заранее, что в него
 * класть, можно ровно потому, что весь текст лежит словарём. Цифры и знаки
 * пунктуации добавляются отдельно: они приходят из чисел в кадре, а не из
 * словаря, и в строках могут не встретиться ни разу.
 */
export function charset(): string {
  const chars = new Set<string>('0123456789+-−×%:.,!?()«»„“”\'"/ …—–');
  for (const key of Object.keys(STRINGS[current]) as StringKey[]) {
    for (const ch of STRINGS[current][key]) chars.add(ch);
  }
  chars.delete(' ');
  return [...chars].sort().join('');
}

function isLang(v: string | null): v is Lang {
  return v !== null && (LANGS as readonly string[]).includes(v);
}

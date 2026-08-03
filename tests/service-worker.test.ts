/**
 * Политика кеширования service worker.
 *
 * Тест существует из-за дефекта, дожившего до игроков: воркер отдавал из кеша
 * всё, кроме манифеста версии, — включая `index.html`, у которого хеша в имени
 * нет. Манифест приходил свежий, страница оставалась старой, и надпись
 * «доступна новая версия» висела вечно, не снимаясь перезагрузкой: перезагрузку
 * обслуживал тот же кеш.
 *
 * Обычным импортом воркер не проверить — это классический скрипт, а не модуль.
 * Поэтому файл читается с диска и исполняется с подставным `self`: проверяется
 * ровно тот код, который уедет в раздачу, а не его копия в тесте.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';

type Strategy = 'cache-first' | 'network-first';

let strategyFor: (pathname: string, mode: string) => Strategy;
let source: string;

beforeAll(() => {
  source = readFileSync(join(__dirname, '..', 'public', 'sw.js'), 'utf8');

  const self: Record<string, unknown> = {
    addEventListener: () => undefined,
    skipWaiting: () => undefined,
    clients: { claim: () => undefined },
  };
  // Функция-обёртка вместо eval в области теста: воркер обращается только к
  // `self`, и ничего из окружения теста ему видеть не нужно.
  new Function('self', 'caches', 'location', 'fetch', source)(self, {}, { origin: '' }, () => {});
  strategyFor = self.__strategyFor as typeof strategyFor;
});

describe('кеширование service worker', () => {
  it('переход по адресу идёт в сеть', () => {
    // Тот самый случай: index.html без хеша в имени. Из кеша он запирает
    // игрока на старой версии навсегда.
    expect(strategyFor('/', 'navigate')).toBe('network-first');
    expect(strategyFor('/index.html', 'navigate')).toBe('network-first');
  });

  it('манифесты идут в сеть', () => {
    expect(strategyFor('/version.json', 'cors')).toBe('network-first');
    expect(strategyFor('/build.json', 'cors')).toBe('network-first');
  });

  it('сам воркер идёт в сеть', () => {
    // Закешированный воркер не заменить ничем: он обслуживает и запрос
    // собственного обновления.
    expect(strategyFor('/sw.js', 'no-cors')).toBe('network-first');
  });

  it('ассеты с хешем в имени берутся из кеша', () => {
    // Ради этого кеш и нужен: повторный заход мгновенный, а протухнуть такой
    // файл не может — либо он тот же, либо у него другое имя.
    expect(strategyFor('/assets/index.DkhEfxkX.js', 'no-cors')).toBe('cache-first');
    expect(strategyFor('/assets/index.6YlfVQNl.css', 'no-cors')).toBe('cache-first');
  });

  it('незнакомое берётся из сети, а не из кеша', () => {
    // Умолчание падает в безопасную сторону: лишний запрос дешевле, чем файл,
    // который нельзя обновить.
    expect(strategyFor('/favicon.ico', 'no-cors')).toBe('network-first');
    expect(strategyFor('/что-то-новое.json', 'cors')).toBe('network-first');
  });

  it('имя кеша сменилось вместе с политикой', () => {
    // Иначе у тех, кто уже застрял, останется лежать старый index.html,
    // и новая политика ему не поможет.
    expect(source).toContain("const CACHE = 'dod-v2'");
  });
});

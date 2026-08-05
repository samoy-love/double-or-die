/**
 * Паритет словаря как гейт.
 *
 * Языки лежат отдельными таблицами ради переводчика, который работает с языком
 * целиком (`content/strings.schema.md`). Плата за это — ключ, забытый в одной
 * из таблиц: игра на этом языке покажет вместо фразы русский исходник или,
 * хуже, пустое место, и заметит это только тот, кто на этом языке играет.
 *
 * Генератор проверяет ровно то же самое и валит `npm run check:content`. Здесь
 * проверка повторяется намеренно: словарь правят чаще, чем вспоминают про
 * отдельную команду, а прогон тестов запускают все.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LANGS, STRINGS } from '@dod/client/strings.generated';

const ROOT = join(import.meta.dirname, '..');

interface Source {
  version: number;
  languages: Record<string, Record<string, string>>;
}

const source = JSON.parse(readFileSync(join(ROOT, 'content', 'strings.json'), 'utf8')) as Source;

interface Catalog {
  bets: { id: string; name: string }[];
}

const catalog = JSON.parse(readFileSync(join(ROOT, 'content', 'bets.json'), 'utf8')) as Catalog;

/** Имена подстановок строки: сравнивается набор, а не порядок. */
const placeholders = (v: string): string[] =>
  [...v.matchAll(/\{([a-z][a-zA-Z0-9]*)\}/g)].map((m) => m[1]).sort();

const base = LANGS[0];
const baseKeys = Object.keys(source.languages[base]).sort();

describe('словарь строк', () => {
  it('языки словаря — те же, что знает клиент', () => {
    expect(Object.keys(source.languages).sort()).toEqual([...LANGS].sort());
  });

  it('во всех языках один и тот же набор ключей', () => {
    for (const lang of LANGS) {
      expect(Object.keys(source.languages[lang]).sort(), lang).toEqual(baseKeys);
    }
  });

  it('ни одна строка не пуста и не разорвана переносом', () => {
    for (const lang of LANGS) {
      for (const key of baseKeys) {
        const value = source.languages[lang][key];
        expect(value.trim(), `${lang}: ${key}`).not.toBe('');
        expect(value.includes('\n'), `${lang}: ${key}`).toBe(false);
      }
    }
  });

  it('подстановки не теряются при переводе', () => {
    for (const key of baseKeys) {
      const want = placeholders(source.languages[base][key]);
      for (const lang of LANGS) {
        expect(placeholders(source.languages[lang][key]), `${lang}: ${key}`).toEqual(want);
      }
    }
  });

  /*
   * Сгенерированный модуль — это то, что реально попадает в сборку. Проверять
   * только источник значит проверять файл, который игра не читает.
   */
  it('сгенерированный модуль совпадает с источником', () => {
    for (const lang of LANGS) {
      expect(Object.keys(STRINGS[lang]).sort(), lang).toEqual(baseKeys);
      for (const key of baseKeys) {
        expect(STRINGS[lang][key as keyof (typeof STRINGS)[typeof lang]], `${lang}: ${key}`).toBe(
          source.languages[lang][key],
        );
      }
    }
  });

  it('у каждого пари из каталога есть переведённое имя', () => {
    const expected = catalog.bets.map((b) => `bet.${b.id}.name`).sort();
    expect(baseKeys.filter((k) => /^bet\..+\.name$/.test(k))).toEqual(expected);
  });

  /*
   * Условие на карте — не длиннее 28 знаков (GLOSSARY, п. 7), и это касается
   * не только русского исходника: макет держит +40% под немецкий, а не под
   * произвольную длину.
   */
  it('имя пари влезает в карту на всех языках', () => {
    for (const lang of LANGS) {
      for (const bet of catalog.bets) {
        const value = source.languages[lang][`bet.${bet.id}.name`];
        expect(value.length, `${lang}: ${bet.id} — «${value}»`).toBeLessThanOrEqual(28);
      }
    }
  });
});

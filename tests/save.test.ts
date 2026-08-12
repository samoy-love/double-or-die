/**
 * Сейв и миграции.
 *
 * Требование плана версии — «миграции: каждая пара версий открывается»
 * (ROADMAP §0.4.0), поэтому образцы ниже заведены **на каждую схему**, которая
 * когда-либо писалась на диск игрока, и каждый прогоняется до текущей. Ни один
 * образец отсюда не удаляется: удалить его — значит перестать проверять сейв,
 * который у кого-то до сих пор лежит.
 *
 * Вторая половина файла — про битый сейв. Он редактируется в блокноте и
 * специально не защищается (SECURITY §6), значит на вход придёт что угодно, и
 * ни один из этих случаев не имеет права уронить игру.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAVE,
  Profile,
  SAVE_BAK_KEY,
  SAVE_KEY,
  SAVE_VERSION,
  type SaveStorage,
  clearSave,
  loadSave,
  parseSave,
  writeSave,
} from '@dod/client/save';

/** Хранилище в памяти: тесты бегут в Node, где localStorage не существует. */
function fakeStorage(
  seed: Record<string, string> = {},
): SaveStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/**
 * Образец сейва каждой схемы — ровно в том виде, в каком его писала игра.
 *
 * Числа выбраны так, чтобы миграция была видна: язык не умолчательный, звук в
 * v1 выключен, Ключей ненулевое количество.
 */
const SAMPLES: Record<number, unknown> = {
  1: { version: 1, lang: 'en', muted: true, keys: 12 },
  2: {
    version: 2,
    lang: 'en',
    settings: { volume: 0.25, flash: 0.5 },
    keys: 12,
    runs: 4,
  },
};

describe('миграции сейва', () => {
  it('образец есть для каждой схемы от первой до текущей', () => {
    // Гейт на будущее: новая схема без образца означает непроверенную
    // миграцию, а узнать об этом на сейве игрока дороже всего.
    for (let v = 1; v <= SAVE_VERSION; v++)
      expect(SAMPLES[v], `нет образца схемы v${v}`).toBeDefined();
  });

  for (let v = 1; v <= SAVE_VERSION; v++) {
    it(`сейв схемы v${v} открывается текущей игрой`, () => {
      const s = parseSave(JSON.stringify(SAMPLES[v]));
      expect(s.version).toBe(SAVE_VERSION);
      // Мета-прогресс переживает миграцию — ради этого она и существует.
      expect(s.keys).toBe(12);
      expect(s.lang).toBe('en');
      expect(s.settings.volume).toBeGreaterThanOrEqual(0);
      expect(s.settings.flash).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(s.runs)).toBe(true);
    });
  }

  it('выключенный в v1 звук остаётся выключенным', () => {
    // Игрок выключил звук осознанно. Вернуть ему семьдесят процентов при
    // обновлении — разбудить того, кто играл в наушниках.
    expect(parseSave(JSON.stringify(SAMPLES[1])).settings.volume).toBe(0);
  });

  it('v1 не знал вспышек и забегов — они приезжают умолчаниями', () => {
    const s = parseSave(JSON.stringify(SAMPLES[1]));
    expect(s.settings.flash).toBe(DEFAULT_SAVE.settings.flash);
    expect(s.runs).toBe(0);
  });
});

describe('битый и чужой сейв', () => {
  const broken: Record<string, string> = {
    'обрезанный JSON': '{"version":2,"keys":',
    'не объект': '"строка"',
    массив: '[]',
    'без версии': '{"keys":3}',
    'версия строкой': '{"version":"2"}',
    'версия из будущего': `{"version":${SAVE_VERSION + 1},"keys":3}`,
    'чужие данные': '{"token":"abc","cart":[1,2,3]}',
  };

  for (const [name, raw] of Object.entries(broken)) {
    it(`${name}: разбор отвергает, игра получает умолчания`, () => {
      expect(() => parseSave(raw)).toThrow();
      const r = loadSave(fakeStorage({ [SAVE_KEY]: raw }));
      expect(r.source).toBe('defaults');
      expect(r.problem).toBeTruthy();
      expect(r.save).toEqual(DEFAULT_SAVE);
    });
  }

  it('битый основной сейв откатывается на копию', () => {
    const storage = fakeStorage({
      [SAVE_KEY]: '{"version":2,"keys":',
      [SAVE_BAK_KEY]: JSON.stringify(SAMPLES[2]),
    });
    const r = loadSave(storage);
    expect(r.source).toBe('backup');
    expect(r.save.keys).toBe(12);
  });

  it('первый запуск — умолчания и ни одной жалобы', () => {
    const r = loadSave(fakeStorage());
    expect(r.source).toBe('defaults');
    expect(r.problem).toBeUndefined();
  });

  it('хранилища нет вовсе — игра всё равно играется', () => {
    // Приватный режим браузера: обращение к localStorage бросает, а не
    // возвращает null.
    const r = loadSave(null);
    expect(r.save).toEqual(DEFAULT_SAVE);
    expect(writeSave(r.save, null)).toBe(false);
  });

  it('отредактированные в блокноте числа чинятся, а не теряют профиль', () => {
    const s = parseSave(
      JSON.stringify({
        version: 2,
        lang: 'кленовый',
        settings: { volume: 42, flash: -1 },
        keys: -5,
        runs: 2.7,
      }),
    );
    expect(s.lang).toBe(DEFAULT_SAVE.lang);
    expect(s.settings.volume).toBe(1);
    expect(s.settings.flash).toBe(0);
    expect(s.keys).toBe(0);
    expect(s.runs).toBe(2);
  });
});

describe('запись сейва', () => {
  it('предыдущий сейв уезжает в копию', () => {
    const storage = fakeStorage({ [SAVE_KEY]: JSON.stringify(SAMPLES[2]) });
    writeSave({ ...DEFAULT_SAVE, keys: 99, settings: { ...DEFAULT_SAVE.settings } }, storage);
    expect(loadSave(storage).save.keys).toBe(99);
    expect(parseSave(storage.data.get(SAVE_BAK_KEY)!).keys).toBe(12);
  });

  it('профиль пишет каждое изменение и читается заново', () => {
    const storage = fakeStorage();
    const p = new Profile(storage);
    p.countRun();
    p.addKeys(7);
    p.set({ lang: 'en', settings: { flash: 0 } });

    const again = new Profile(storage);
    expect(again.save).toEqual({
      version: SAVE_VERSION,
      lang: 'en',
      settings: {
        volume: DEFAULT_SAVE.settings.volume,
        flash: 0,
        cashOutFocusedOnly: DEFAULT_SAVE.settings.cashOutFocusedOnly,
      },
      keys: 7,
      runs: 1,
    });
  });

  it('сброс убирает и сейв, и копию', () => {
    const storage = fakeStorage({ [SAVE_KEY]: '{}', [SAVE_BAK_KEY]: '{}' });
    clearSave(storage);
    expect(storage.data.size).toBe(0);
  });
});

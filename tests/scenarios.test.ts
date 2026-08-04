/**
 * Сценарии как гейт.
 *
 * Сценарий отвечает на вопрос «что игра делает» словами, которые понятны без
 * чтения кода. Ради этого он и лежит отдельным файлом: правка баланса или
 * механики обязана менять читаемый документ, а не только числа в тесте.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseScenario, runScenario } from '../packages/tools/src/scenario';

const DIR = join(__dirname, 'scenarios');

/**
 * Сценарии собираются вместе с подкаталогами.
 *
 * Их становится много, и раскладывать по темам («bets», дальше «arena»,
 * «coop») — единственный способ оставить каталог читаемым. Плоский список
 * молча пропустил бы целую папку: гейт, который чего-то не видит, хуже
 * отсутствующего.
 */
const files = collect(DIR).sort();

function collect(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...collect(full, `${prefix}${e}/`));
    else if (e.endsWith('.json')) out.push(prefix + e);
  }
  return out;
}

describe('сценарии', () => {
  it('сценарии на месте', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s', (f) => {
    const sc = parseScenario(readFileSync(join(DIR, f), 'utf8'), f);
    const r = runScenario(sc);
    // Провалы выводятся списком целиком: чинить их по одному, перезапуская
    // прогон после каждого, дороже ровно во столько раз, сколько их есть.
    expect(r.failures).toEqual([]);
  });

  it('ловит несбывшееся ожидание', () => {
    const r = runScenario({
      name: 'заведомо ложное',
      steps: [{ tick: 60 }, { expect: { player: 0, travelled: { min: 10_000 } } }],
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/путь игрока 0/);
  });

  it('отвергает неизвестную кнопку, а не игнорирует её', () => {
    const r = runScenario({
      name: 'опечатка в кнопке',
      steps: [{ input: { player: 0, buttons: ['fier'] } }],
    });
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toMatch(/неизвестная кнопка/);
  });

  it('внятно отказывается разбирать испорченный файл', () => {
    expect(() => parseScenario('{ это не json', 'x.json')).toThrow(/не разбирается как JSON/);
    expect(() => parseScenario('{"steps":[]}', 'x.json')).toThrow(/нет поля name/);
  });
});

/**
 * Строгий разбор структуры.
 *
 * Худший дефект тестовой оснастки — не упавший сценарий, а зелёный, который
 * ничего не проверил: `"heart"` вместо `"hearts"` молча пропускалось, и файл
 * попадал в накапливаемый набор как покрытие, которым не является. Поэтому
 * опечатка в ИМЕНИ ПОЛЯ обязана валить разбор ровно так же, как опечатка в
 * имени врага, и сообщение обязано называть файл, шаг, само имя и ближайшее
 * известное — иначе искать её в сценарии на сотню строк дороже, чем написать
 * его заново.
 */
describe('строгий разбор сценария', () => {
  const parse =
    (o: unknown): (() => unknown) =>
    () =>
      parseScenario(JSON.stringify(o), 'x.json');

  const withStep = (step: unknown): unknown => ({ name: 'проба', steps: [{ tick: 1 }, step] });

  it('неизвестное поле ожидания валит разбор и подсказывает похожее', () => {
    expect(parse(withStep({ expect: { heart: { min: 1 } } }))).toThrow(
      /x\.json: шаг 2:.*неизвестное поле «heart».*hearts/s,
    );
    expect(parse(withStep({ expect: { bets: { chip: { min: 1 } } } }))).toThrow(
      /неизвестное поле «chip»/,
    );
    expect(parse(withStep({ expect: { cards: { totall: { min: 1 } } } }))).toThrow(
      /неизвестное поле «totall».*total/s,
    );
  });

  it('неизвестный ключ шага валит разбор', () => {
    expect(parse(withStep({ tik: 10 }))).toThrow(/неизвестный ключ шага «tik».*tick/s);
    expect(parse(withStep({ spwan: { type: 'клин', x: 1, y: 1 } }))).toThrow(
      /неизвестный ключ шага «spwan»/,
    );
  });

  it('неизвестное поле в блоке врага валит разбор', () => {
    expect(parse(withStep({ expect: { enemy: { phaze: 'idle' } } }))).toThrow(
      /неизвестное поле «phaze».*phase/s,
    );
  });

  it('опечатка в имени валит разбор так же, как опечатка в поле', () => {
    expect(parse(withStep({ spawn: { type: 'клим', x: 1, y: 1 } }))).toThrow(
      /неизвестное имя «клим».*клин/s,
    );
    expect(parse(withStep({ expect: { bets: { id: 'no_damag' } } }))).toThrow(
      /неизвестное имя «no_damag».*no_damage/s,
    );
    expect(parse(withStep({ expect: { bets: { state: 'wonn' } } }))).toThrow(
      /неизвестное имя «wonn».*won/s,
    );
    expect(parse(withStep({ input: { buttons: ['fier'] } }))).toThrow(/неизвестное имя «fier»/);
  });

  it('неверный тип значения валит разбор', () => {
    expect(parse(withStep({ tick: '60' }))).toThrow(/нужно целое, а не строка/);
    expect(parse(withStep({ expect: { hearts: 3 } }))).toThrow(/нужен объект, а не число/);
    expect(parse(withStep({ expect: { alive: 'да' } }))).toThrow(/нужно true или false/);
    expect(parse(withStep({ expect: { hearts: { min: 'три' } } }))).toThrow(/нужно число/);
    expect(parse(withStep({ input: { move: [1] } }))).toThrow(/нужна пара чисел/);
  });

  it('обязательное поле шага не пропускается молча', () => {
    expect(parse(withStep({ card: { id: 'no_dash', x: 10 } }))).toThrow(
      /нет обязательного поля «y»/,
    );
    expect(parse(withStep({ spawn: { x: 10, y: 10 } }))).toThrow(/нет обязательного поля «type»/);
  });

  it('шаг с двумя действиями отвергается: порядок в нём неочевиден', () => {
    expect(parse(withStep({ tick: 1, clear: true }))).toThrow(/сразу несколько действий/);
    expect(parse(withStep({}))).toThrow(/пустой шаг/);
  });

  it('неизвестное поле самого сценария валит разбор', () => {
    expect(parse({ name: 'проба', step: [], steps: [] })).toThrow(
      /неизвестное поле сценария «step».*steps/s,
    );
    expect(parse({ name: 'проба', players: 9, steps: [] })).toThrow(/players: 9 больше 4/);
  });

  it('исправный сценарий по-прежнему разбирается', () => {
    const sc = parseScenario(
      JSON.stringify({
        name: 'проба',
        seed: 2,
        players: 1,
        waves: false,
        steps: [
          { chips: { amount: 100 } },
          { bet: { id: 'no_dash', stake: 10 } },
          { appetite: { tier: 'по-крупному' } },
          { expect: { bets: { id: 'no_dash', state: 'active', taken: { min: 1 } } } },
        ],
      }),
      'x.json',
    );
    expect(runScenario(sc).failures).toEqual([]);
  });
});

/**
 * Обучение действием: правила показа подсказок.
 *
 * Проверяется не текст (он в словаре и проверяется i18n), а три обещания
 * `coach.ts`, каждое из которых легко нарушить одной правкой условия:
 * подсказка привязана к состоянию, исчезает по выполнению и не возвращается в
 * следующем забеге.
 */

import { describe, expect, it } from 'vitest';
import {
  Btn,
  createState,
  type InputFrame,
  makeFrame,
  Meta,
  RunPhase,
  type SimState,
  spawnPlayers,
} from '../packages/sim/src/index';
import { Coach } from '../packages/client/src/coach';

function fight(): SimState {
  const s = createState(7, 1);
  spawnPlayers(s);
  s.meta[Meta.Phase] = RunPhase.Fight;
  return s;
}

const frame = (buttons = 0): InputFrame => ({ ...makeFrame(), buttons });

describe('обучение действием', () => {
  it('первый урок — движение и огонь', () => {
    const c = new Coach();
    c.observe(fight(), frame());
    expect(c.key(false)).toBe('coach.move.key');
    // Схема ввода меняет строку, а не урок: кнопка физическая, урок общий.
    expect(c.key(true)).toBe('coach.move.pad');
  });

  it('урок закрывается самим действием, а не таймером', () => {
    const c = new Coach();
    const s = fight();
    c.observe(s, frame());
    expect(c.key(false)).toBe('coach.move.key');

    s.tick += 1;
    c.observe(s, frame(Btn.Fire));
    s.tick += 1;
    c.observe(s, frame());
    expect(c.key(false), 'урок остался после выполнения').not.toBe('coach.move.key');
    expect(c.learnedList()).toContain('move');
  });

  it('выученное не показывается заново', () => {
    const c = new Coach();
    c.restore(['move']);
    const s = fight();
    c.observe(s, frame());
    expect(c.key(false)).not.toBe('coach.move.key');
  });

  it('вне боя боевых уроков нет', () => {
    const c = new Coach();
    const s = fight();
    s.meta[Meta.Phase] = RunPhase.Door;
    c.observe(s, frame());
    // На экране двери свой урок, и он не про движение.
    expect(c.key(false)).toBe('coach.door.key');
  });

  it('пройденное обучение выключается целиком', () => {
    const c = new Coach();
    c.restore(['move', 'card', 'take', 'dash', 'cashout', 'settle', 'door', 'pause']);
    expect(c.finished).toBe(true);
    c.observe(fight(), frame());
    expect(c.key(false)).toBeNull();
  });

  it('урок без действия запоминается по первому показу', () => {
    /*
     * «Выберите дверь» нечем выполнить: игрок и так выберет, иначе забег не
     * пойдёт. Такой урок обязан уйти навсегда после первого показа — иначе он
     * всплывал бы на каждой из двадцати одной двери забега, и это не
     * обучение, а шум.
     */
    const c = new Coach();
    const s = fight();
    s.meta[Meta.Phase] = RunPhase.Door;
    c.observe(s, frame());
    expect(c.key(false)).toBe('coach.door.key');

    // Ждём дольше срока показа: урок закрывается по времени.
    s.tick += 601;
    c.observe(s, frame());
    expect(c.key(false), 'урок остался на экране').not.toBe('coach.door.key');
    expect(c.learnedList(), 'показанный урок не запомнился').toContain('door');
  });

  it('«пауза» не запоминается, если истекла во время активной волны', () => {
    /*
     * Урок «пауза» ничем не выполняется (как «дверь»/«расчёт»), поэтому если
     * его таймер истечёт посреди боя с живыми врагами, он мог бы уйти в
     * выученные незамеченным — и больше никогда не показаться, потому что
     * `once: true`.
     */
    const c = new Coach();
    const s = fight();
    s.meta[Meta.Room] = 2;
    s.eActive[0] = 1; // на арене живой враг — волна идёт

    c.observe(s, frame());
    // Урок про паузу не показывается, пока враги живы: сейчас всплыл 'move'.
    expect(c.key(false)).not.toBe('coach.pause.key');

    s.tick += 421;
    c.observe(s, frame());
    expect(c.learnedList(), 'урок пометился пройденным во время боя').not.toContain('pause');
  });

  it('«пауза» показывается и запоминается между волнами', () => {
    const c = new Coach();
    c.restore(['move', 'card', 'take', 'dash', 'cashout', 'settle', 'door']);
    const s = fight();
    s.meta[Meta.Room] = 2;
    // Врагов на арене нет — пауза между волнами.

    c.observe(s, frame());
    expect(c.key(false)).toBe('coach.pause.key');

    s.tick += 421;
    c.observe(s, frame());
    expect(c.learnedList()).toContain('pause');
  });

  it('новый забег не наследует висящий урок', () => {
    const c = new Coach();
    const s = fight();
    c.observe(s, frame());
    expect(c.key(false)).not.toBeNull();
    c.reset();
    expect(c.key(false)).toBeNull();
  });
});

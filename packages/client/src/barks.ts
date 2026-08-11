/**
 * Контекстные реплики Крупье.
 *
 * Реплика — приправа к жесту, а не его замена. Юмор в этой игре играется
 * телом (GDD §17А): зевок читается на любом языке, стареет медленнее и
 * попадает в клипы, а строка требует переводчика с чувством юмора на семь
 * языков. Поэтому жест живёт в симуляции и виден всегда, а реплика лишь
 * подписывается под ним.
 *
 * Отсюда и разделение: выбор реплики — чистая функция от жеста и номера
 * повода, и он здесь; сам текст живёт словарём (UX §8), а на экран его кладёт
 * рендер под Крупье. Здесь остаются только КЛЮЧИ: список реплик — это порядок
 * дозировки, а не перевод, и правка перевода не имеет права трогать код.
 *
 * Границы (GDD §17А): Крупье смеётся над ситуацией и над собой, но не над
 * игроком, и чем сильнее игрок пострадал, тем мягче реплика. Первая строка
 * каждого списка — самая мягкая: её и берут, когда дела у игрока плохи.
 */

import { AceGesture } from '@dod/sim';
import { t, type StringKey } from './i18n';

/**
 * Реплики по жестам, внутри — от мягкой к дерзкой.
 *
 * Список не пуст ни у одного настоящего жеста намеренно: молчащий жест
 * невозможно отличить от несработавшего, и дефект «Крупье перестал реагировать»
 * нашёлся бы только по жалобе.
 */
const LINES: Record<AceGesture, readonly StringKey[]> = {
  [AceGesture.None]: [],
  [AceGesture.Yawn]: ['ace.bark.yawn.1', 'ace.bark.yawn.2', 'ace.bark.yawn.3'],
  [AceGesture.Applaud]: ['ace.bark.applaud.1', 'ace.bark.applaud.2', 'ace.bark.applaud.3'],
  [AceGesture.TurnAway]: ['ace.bark.turn_away.1', 'ace.bark.turn_away.2', 'ace.bark.turn_away.3'],
  [AceGesture.Fidget]: ['ace.bark.fidget.1', 'ace.bark.fidget.2', 'ace.bark.fidget.3'],
  [AceGesture.ThumbsDown]: [
    'ace.bark.thumbs_down.1',
    'ace.bark.thumbs_down.2',
    'ace.bark.thumbs_down.3',
  ],
  [AceGesture.Ovation]: ['ace.bark.ovation.1', 'ace.bark.ovation.2', 'ace.bark.ovation.3'],
};

/**
 * Выбрать реплику.
 *
 * `severity` — насколько игроку сейчас плохо, от 0 до 1: смерти подряд,
 * пустой кошелёк, сорванное крупное пари. Чем хуже, тем ближе к началу
 * списка, то есть тем мягче. Это не украшение: после третьей смерти подряд
 * издёвка перестаёт быть шуткой и становится поводом закрыть игру.
 *
 * `occasion` — порядковый номер повода. Реплики идут по кругу, а не наугад:
 * случайный выбор повторяет одну и ту же строку дважды подряд заметно чаще,
 * чем кажется, и именно это читается как «у него их всего две».
 */
export function pickBark(gesture: AceGesture, occasion: number, severity = 0): string {
  const lines = LINES[gesture];
  if (lines.length === 0) return '';
  // Верхняя доступная дерзость: при severity = 1 остаётся только первая,
  // самая мягкая строка.
  const ceiling = Math.max(1, Math.round(lines.length * (1 - clamp01(severity))));
  return t(lines[mod(occasion, ceiling)]);
}

/** Насколько игроку сейчас плохо: 0 — всё хорошо, 1 — хуже некуда. */
export function severityOf(deathStreak: number, chips: number): number {
  const byDeaths = clamp01(deathStreak / 3);
  const byPurse = chips <= 0 ? 0.5 : 0;
  return clamp01(Math.max(byDeaths, byPurse));
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const mod = (v: number, n: number): number => ((v % n) + n) % n;

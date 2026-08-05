/**
 * Ядро симуляции Double or Die.
 *
 * Чистый TypeScript без единой зависимости. Не знает ни про рендер, ни про
 * ввод, ни про сеть — это цена, за которую куплены реплеи, античит, онлайн,
 * Monte-Carlo балансировка и портируемость на консоли.
 *
 * Правила модуля (проверяются линтером):
 *   — никаких window, document, Math.random, Date.now, performance.now;
 *   — никакой тригонометрии из Math: только таблицы из trig.ts;
 *   — время только в тиках, никаких секунд;
 *   — ноль аллокаций в горячем пути.
 */

export * from './fixed';
export * from './trig';
export * from './rng';
export * from './input';
export * from './config';
export * from './state';
export * from './arena';
export * from './combat';
export * from './nav';
export * from './enemies';
export * from './boss';
export * from './bets';
export * from './upgrades';
export * from './doors';
export * from './floor';
export * from './run';
export * from './sim';
export * from './replay';
export * from './invariants';

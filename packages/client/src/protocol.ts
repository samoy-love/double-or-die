/**
 * Протокол консоли: по префиксу агент отличает интересное от шума.
 *
 * Браузерная консоль — единственный канал, который агент читает без
 * дополнительных инструментов, и он же забит сообщениями Vite, расширений и
 * самого браузера. Поэтому у нас ровно три префикса и ни одного свободного
 * формата: `[DOD]` — событие, `[DOD:ERROR]` — сбой, `[DOD:INVARIANT]` —
 * нарушенный инвариант симуляции.
 *
 * Разделение ERROR и INVARIANT не косметика. Сбой может быть внешним:
 * не отдался манифест, отвалилась сеть. Нарушенный инвариант — всегда дефект
 * ядра, и реагировать на него нужно иначе: не «повторить», а «остановиться и
 * записать сид».
 */

export const log = (name: string, props?: Record<string, unknown>): void =>
  console.log(`[DOD] ${JSON.stringify({ name, ...props })}`);

export const logError = (name: string, props?: Record<string, unknown>): void =>
  console.error(`[DOD:ERROR] ${JSON.stringify({ name, ...props })}`);

/**
 * Нарушенный инвариант. Сид и тик обязательны: без них сообщение бесполезно —
 * забег невоспроизводим, а значит дефект не найти.
 */
export const logInvariant = (message: string, seed: number, tick: number): void =>
  console.error(`[DOD:INVARIANT] ${JSON.stringify({ message, seed, tick })}`);

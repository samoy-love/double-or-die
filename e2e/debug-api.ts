/**
 * Типы отладочного интерфейса для сквозных тестов.
 *
 * Объявлены отдельным файлом, а не по месту: `page.evaluate()` разбирается
 * babel-парсером Playwright, и сложные встроенные приведения типов он не
 * принимает. Заодно тесты перестают знать про `unknown` и читаются как код,
 * а не как борьба с типизацией.
 */

export interface DebugApi {
  newRun(o?: { seed?: number; players?: number }): void;
  tick(n?: number): void;
  play(): void;
  pause(): void;
  render(): void;
  mute(on?: boolean): void;
  waves(on?: boolean): void;
  clear(): void;
  stress(o?: { enemies?: number; particles?: number }): void;
  /** Стабильный кадр: тряска, вспышки и хитстоп выключены. */
  stable(on?: boolean): void;
  /** Открыть плату за этаж входом ядра: экран платы стоит за боссом. */
  houseCut(): void;
  /** Выдать фишки: ими проверяется развилка «хватает / торг». */
  give(o: { chips?: number; hearts?: number }, player?: number): void;
  /** Снимок кадра сеткой средних цветов: визуальная регрессия. */
  frameGrid(cols?: number, rows?: number): number[][];
  perf(): { fps: number; particles: number; shapes: number };
  /**
   * Состояние забега: фаза, этаж, комната и прочее счётное.
   *
   * Список полей здесь НАМЕРЕННО короче настоящего: тестам нужно то, по чему
   * они доводят забег до нужного места, а не весь снимок. Полное объявление
   * живёт в `packages/client/src/debug.ts`, и это дублирование уже один раз
   * отстало — метод появился там и не появился здесь, из-за чего сквозные
   * тесты перестали собираться. Держать копию в синхроне обязан тот, кто
   * правит оригинал.
   */
  state(): { phase: number; floor: number; room: number; wave: number; tick: number };
}

declare global {
  interface Window {
    __DOD__?: DebugApi;
  }
}

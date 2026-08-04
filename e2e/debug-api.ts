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
  /** Снимок кадра сеткой средних цветов: визуальная регрессия. */
  frameGrid(cols?: number, rows?: number): number[][];
  perf(): { fps: number; particles: number; shapes: number };
}

declare global {
  interface Window {
    __DOD__?: DebugApi;
  }
}

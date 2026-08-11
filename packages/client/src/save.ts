/**
 * Локальный сейв: язык, настройки, ключи, счётчик забегов.
 *
 * Сейв — единственное, что переживает вкладку, и потому единственное, что
 * невозможно починить выкаткой: у игрока на диске уже лежит файл, записанный
 * прошлой сборкой. Отсюда два правила, заданных [TECH §9](../../../docs/TECH.md).
 *
 * Первое: **у формата есть номер, и ни одна миграция не удаляется**. Сейв
 * двухлетней давности обязан открыться, поэтому переход между версиями —
 * цепочка функций `v1→v2→…`, а не «прочитать как получится».
 *
 * Второе: **битый сейв не роняет игру**. Он редактируется в блокноте, и это
 * осознанно не защищается ([SECURITY §6](../../../docs/SECURITY.md)) — значит,
 * на вход рано или поздно придёт что угодно: обрезанный JSON, чужой ключ
 * `localStorage`, значение из будущей версии. Любой из этих случаев обязан
 * кончиться играбельной игрой, а не белым экраном.
 */

/** Номер схемы, в которой игра пишет сейв сегодня. */
export const SAVE_VERSION = 2;

/** Ключ в localStorage и его резервная копия (TECH §9: `.bak` всегда рядом). */
export const SAVE_KEY = 'dod.save';
export const SAVE_BAK_KEY = 'dod.save.bak';

/** Языки словаря 0.4.0. Выбор игрока переживает вкладку, потому и в сейве. */
export type Lang = 'ru' | 'en';
const LANGS: readonly Lang[] = ['ru', 'en'];

export interface Settings {
  /** Громкость мастер-шины, 0..1. */
  volume: number;
  /**
   * Интенсивность вспышек, 0..1.
   *
   * Ноль — вспышек нет вовсе: это не «настройка вкуса», а требование
   * доступности ([UX](../../../docs/UX.md)), и потому хранится наравне со
   * звуком, а не выводится из него.
   */
  flash: number;
  /**
   * Поштучный забор пари (доступность, выключено по умолчанию).
   *
   * По умолчанию «Забрать» цепляет самое выгодное активное пари
   * (`cashOutBest`). Игроку с моторными или когнитивными ограничениями
   * сложно оценить, какое пари сейчас «самое выгодное», за доли секунды в
   * бою; включённая настройка отдаёт крестовину ← → под выбор цели, и
   * «Забрать» берёт ровно то пари, что выбрано (`packages/sim/src/input.ts`).
   */
  cashOutFocusedOnly: boolean;
}

export interface Save {
  /** Номер схемы этого сейва. Всегда `SAVE_VERSION` после загрузки. */
  version: number;
  lang: Lang;
  settings: Settings;
  /** Накопленные Ключи — мета-валюта, переживающая забег. */
  keys: number;
  /** Сколько забегов сыграно. Считает игра, а не игрок. */
  runs: number;
}

export const DEFAULT_SAVE: Readonly<Save> = Object.freeze({
  version: SAVE_VERSION,
  lang: 'ru' as Lang,
  settings: Object.freeze({ volume: 0.7, flash: 1, cashOutFocusedOnly: false }),
  keys: 0,
  runs: 0,
});

/**
 * Минимум от `Storage`, которым пользуется этот модуль.
 *
 * Хранилище приходит параметром, а не берётся из `window` намертво: тесты
 * бегут в Node, где `localStorage` не существует вовсе, а миграции — ровно то,
 * что обязано проверяться без браузера ([DEVLOOP §1](../../../docs/DEVLOOP.md)).
 */
export interface SaveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Хранилище браузера, если оно доступно.
 *
 * В приватном режиме и при запрете сторонних данных обращение к
 * `localStorage` бросает — не возвращает `null`, а именно бросает. Игра при
 * этом обязана идти дальше: сейв нужен между сессиями, а сыграть забег можно и
 * без него.
 */
export function browserStorage(): SaveStorage | null {
  try {
    const s = globalThis.localStorage;
    return s ? s : null;
  } catch {
    return null;
  }
}

/**
 * Миграции: с версии `N` на `N+1`, по одной на пару.
 *
 * Именно по одной, а не «из любой в текущую»: цепочка из шагов проверяется
 * покаждой паре версий, и добавление третьей схемы не требует переписывать
 * переход с первой. Ни один шаг отсюда не удаляется никогда.
 */
const MIGRATIONS: Record<number, (o: Record<string, unknown>) => Record<string, unknown>> = {
  /*
   * v1 → v2.
   *
   * v1 знал только «звук выключен» и не знал ни громкости, ни вспышек, ни
   * счётчика забегов. Настройки заодно переехали в свой объект: их будет
   * больше (ремап, доступность, TECH §9), и плоский корень означал бы, что
   * каждая новая настройка неотличима от поля прогресса.
   *
   * `muted: true` превращается в нулевую громкость, а не в умолчание: игрок
   * выключил звук осознанно, и вернуть ему 70% при обновлении — это разбудить
   * ночью того, кто играл в наушниках.
   */
  1: (o) => ({
    version: 2,
    lang: o.lang,
    settings: { volume: o.muted === true ? 0 : DEFAULT_SAVE.settings.volume, flash: 1 },
    keys: o.keys,
    runs: 0,
  }),
};

/** Сейв не из этой игры или не из этого мира. */
export class BadSaveError extends Error {}

/**
 * Разобрать и домигрировать текст сейва. Бросает `BadSaveError` на всём, что
 * сейвом не является.
 *
 * Числа при этом **чинятся, а не отвергаются**: громкость 42 или отрицательные
 * Ключи — это отредактированный в блокноте файл, и потерять из-за одного поля
 * весь профиль игрока хуже, чем зажать это поле в границы. Отвергается только
 * то, по чему нельзя понять, сейв ли это вообще: не JSON, не объект, номер
 * схемы неизвестен.
 */
export function parseSave(raw: string): Save {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    throw new BadSaveError('сейв не разбирается как JSON');
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) {
    throw new BadSaveError('сейв не объект');
  }

  let cur = o as Record<string, unknown>;
  const v = cur.version;
  if (!Number.isInteger(v) || (v as number) < 1) {
    throw new BadSaveError(`версия схемы сейва ${String(v)}, ожидалось целое от 1`);
  }
  /*
   * Сейв из будущего не мигрируется вперёд и не читается «как получится».
   *
   * Это откат сборки — обычное дело (TECH §8.5), — и старый клиент физически
   * не знает, что означают поля новой схемы. Прочитать их наугад значит тихо
   * испортить профиль, который после возврата на новую сборку был бы цел.
   */
  if ((v as number) > SAVE_VERSION) {
    throw new BadSaveError(`сейв версии ${String(v)}, игра знает до ${SAVE_VERSION}`);
  }

  for (let from = v as number; from < SAVE_VERSION; from++) {
    const step = MIGRATIONS[from];
    if (!step) throw new BadSaveError(`нет миграции с версии ${from}`);
    cur = step(cur);
  }

  return normalize(cur);
}

/** Привести домигрированный объект к валидному сейву, зажав числа в границы. */
function normalize(o: Record<string, unknown>): Save {
  const settings = (
    typeof o.settings === 'object' && o.settings !== null ? o.settings : {}
  ) as Record<string, unknown>;
  return {
    version: SAVE_VERSION,
    lang: LANGS.includes(o.lang as Lang) ? (o.lang as Lang) : DEFAULT_SAVE.lang,
    settings: {
      volume: unit(settings.volume, DEFAULT_SAVE.settings.volume),
      flash: unit(settings.flash, DEFAULT_SAVE.settings.flash),
      cashOutFocusedOnly: bool(settings.cashOutFocusedOnly, DEFAULT_SAVE.settings.cashOutFocusedOnly),
    },
    keys: count(o.keys),
    runs: count(o.runs),
  };
}

/** Доля 0..1: не число — умолчание, число за границей — граница. */
function unit(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(1, Math.max(0, v));
}

/** Неотрицательное целое: Ключей и забегов не бывает −3 и не бывает 1.5. */
function count(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.trunc(v));
}

/** Булев флаг: не булево значение в сейве — умолчание. */
function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export interface LoadResult {
  save: Save;
  /** Откуда взялось: основной ключ, копия или умолчания. */
  source: 'save' | 'backup' | 'defaults';
  /** Почему не сработал основной ключ. Пусто, когда всё в порядке. */
  problem?: string | undefined;
}

/**
 * Прочитать сейв. Не бросает никогда.
 *
 * Порядок ровно такой: основной ключ, затем `.bak`, затем умолчания. Копия
 * здесь не перестраховка — она единственное, что отличает «игра потеряла
 * настройки» от «игра потеряла весь мета-прогресс»: битым файл чаще всего
 * оказывается после обрыва записи, и предыдущий снимок в этот момент цел.
 */
export function loadSave(storage: SaveStorage | null = browserStorage()): LoadResult {
  if (!storage) return { save: clone(DEFAULT_SAVE), source: 'defaults' };

  const main = read(storage, SAVE_KEY);
  if (main.save) return { save: main.save, source: 'save' };

  const bak = read(storage, SAVE_BAK_KEY);
  if (bak.save) return { save: bak.save, source: 'backup', problem: main.problem };

  // Ни того, ни другого. Первый запуск и битый файл дают один и тот же
  // играбельный результат и различаются только полем `problem`: на первом
  // запуске жаловаться не на что.
  return { save: clone(DEFAULT_SAVE), source: 'defaults', problem: main.problem ?? bak.problem };
}

function read(storage: SaveStorage, key: string): { save?: Save; problem?: string } {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch (e) {
    return { problem: String(e) };
  }
  // Ключа нет — это не проблема, а первый запуск: жаловаться не на что.
  if (raw === null) return {};
  try {
    return { save: parseSave(raw) };
  } catch (e) {
    return { problem: `${key}: ${String(e)}` };
  }
}

/**
 * Записать сейв, сдвинув предыдущий в копию.
 *
 * Копия делается ДО записи и из того, что реально лежало на диске, а не из
 * объекта в памяти: смысл копии — пережить именно неудачную запись.
 */
export function writeSave(save: Save, storage: SaveStorage | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    const prev = storage.getItem(SAVE_KEY);
    if (prev !== null) storage.setItem(SAVE_BAK_KEY, prev);
    storage.setItem(SAVE_KEY, JSON.stringify({ ...save, version: SAVE_VERSION }));
    return true;
  } catch {
    // Квота исчерпана или запись запрещена. Игра идёт дальше без сейва —
    // молча: сообщение об этом на каждом сохранении настроек хуже потери
    // настроек.
    return false;
  }
}

/** Стереть сейв вместе с копией. Нужно и игроку, и тестам. */
export function clearSave(storage: SaveStorage | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(SAVE_KEY);
    storage.removeItem(SAVE_BAK_KEY);
  } catch {
    // Стереть нечем — стирать нечего.
  }
}

function clone(s: Readonly<Save>): Save {
  return { ...s, settings: { ...s.settings } };
}

/**
 * Профиль игрока в памяти: читается один раз, пишется на каждое изменение.
 *
 * Отдельный класс, а не голые функции в вызывающем коде, ровно потому, что
 * счётчик забегов и Ключи меняются из разных мест забега, а запись обязана
 * оставаться одна.
 */
export class Profile {
  readonly source: LoadResult['source'];
  readonly problem: string | undefined;
  private data: Save;

  constructor(private readonly storage: SaveStorage | null = browserStorage()) {
    const r = loadSave(storage);
    this.data = r.save;
    this.source = r.source;
    this.problem = r.problem;
  }

  get save(): Readonly<Save> {
    return this.data;
  }

  set(patch: Partial<Omit<Save, 'version' | 'settings'>> & { settings?: Partial<Settings> }): void {
    this.data = normalize({
      ...this.data,
      ...patch,
      settings: { ...this.data.settings, ...patch.settings },
      version: SAVE_VERSION,
    } as unknown as Record<string, unknown>);
    writeSave(this.data, this.storage);
  }

  /** Забег начался. Считается на старте: до итогов игрок может закрыть вкладку. */
  countRun(): void {
    this.set({ runs: this.data.runs + 1 });
  }

  /** Унесённые из забега Ключи. */
  addKeys(n: number): void {
    this.set({ keys: this.data.keys + n });
  }
}

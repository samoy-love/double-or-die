/**
 * Баг-репорт в один клик: файл, который игрок отправляет сам.
 *
 * Телеметрии в 0.4.0 нет — ни своего ingest, ни Sentry, и это решение, а не
 * отставание ([ROADMAP §0.4.0](../../../docs/ROADMAP.md),
 * [SECURITY §10](../../../docs/SECURITY.md)): версию играют разработчик и
 * плейтест-канал из пяти–десяти человек, у которых можно просто спросить.
 * Поэтому репорт **не уходит никуда** — он скачивается на диск игрока, и
 * дальше игрок решает сам.
 *
 * Полезная нагрузка одна: детерминированный лог инпутов. По нему забег
 * переигрывается тик в тик (`npm run sim -- --replay <файл>`), то есть
 * отвечает и на те вопросы, которых никто не задавал в момент записи, — чего
 * событийный поток не умеет. Всё остальное в файле нужно ровно затем, чтобы
 * этот лог было чем переиграть: с другой версией сборки или конфига он не
 * сойдётся, и «не воспроизводится» чаще всего означает «у нас разные сборки».
 *
 * **Ничего личного в файл не попадает** ([SECURITY §8](../../../docs/SECURITY.md)):
 * ни адреса страницы, ни строки браузера, ни содержимого сейва, ни путей.
 * Список полей ниже закрытый — новое поле добавляется осознанно, а не «заодно
 * пригодится».
 */

import { serialize } from '@dod/sim/replay';
import { CONFIG_VERSION, PROTOCOL_VERSION } from '@dod/shared';
import { log } from './protocol';
import { BUILD, GIT_SHA, VERSION } from './version';

/** Версия формата самого репорта: его читает человек и раннер. */
export const REPORT_FORMAT = 1;

/** Почему собран отчёт. */
export type ReportReason = 'manual' | 'invariant';

export interface BugReport {
  kind: 'dod-bug-report';
  format: number;
  reason: ReportReason;
  /** Текст нарушенного инварианта. Пусто, когда репорт собран руками. */
  message?: string;

  /** Версия игры, коммит и их связка — то же, что в отладочном оверлее. */
  version: string;
  sha: string;
  build: string;
  /** Версии, без совпадения которых лог не переигрывается (TECH §2.5, §8.3). */
  protocolVersion: number;
  configVersion: string;

  /** Забег: сид, состав, длина и хеш состояния на момент отчёта. */
  seed: number;
  playerCount: number;
  tick: number;
  hash: string;

  /** Лог инпутов целиком, сериализованный ядром (RLE по неизменным кадрам). */
  replay: string;
}

/**
 * Что баг-репорту нужно от игры.
 *
 * Структурный тип, а не сам `GameLoop`: отчёт собирается и проверяется без
 * браузера, а цикл без канваса не создать.
 */
export interface ReportSubject {
  readonly state: { readonly seed: number; readonly playerCount: number; readonly tick: number };
  snapshotReplay(): Parameters<typeof serialize>[0];
  hash(): string;
}

/** Собрать отчёт. Чистая функция: ничего не скачивает и не пишет в консоль. */
export function buildReport(
  subject: ReportSubject,
  reason: ReportReason,
  message?: string,
): BugReport {
  const s = subject.state;
  return {
    kind: 'dod-bug-report',
    format: REPORT_FORMAT,
    reason,
    ...(message ? { message } : {}),
    version: VERSION,
    sha: GIT_SHA,
    build: BUILD,
    protocolVersion: PROTOCOL_VERSION,
    configVersion: CONFIG_VERSION,
    seed: s.seed,
    playerCount: s.playerCount,
    tick: s.tick,
    hash: subject.hash(),
    replay: serialize(subject.snapshotReplay()),
  };
}

/**
 * Имя файла: сид, тик и коммит.
 *
 * Именно эти три числа спрашивают первыми, и они обязаны читаться до
 * открытия файла — в чат репорт попадает вложением, а не текстом. Ни имени
 * игрока, ни даты в имени нет: первое — персональные данные, второе врёт
 * (часы на машине игрока произвольны), а порядок отчётов и так виден по тику.
 */
export function reportFileName(r: BugReport): string {
  return `dod-bug-${r.seed}-t${r.tick}-${r.sha}.json`;
}

/**
 * Скачать отчёт файлом.
 *
 * Через `Blob` и ссылку, а не `fetch` куда-нибудь: файл не покидает машину
 * игрока вовсе — ни на наш сервер, ни на чужой. Возвращает собранный отчёт,
 * чтобы вызывающий мог показать его номер и не собирать второй раз.
 */
export function downloadBugReport(
  subject: ReportSubject,
  reason: ReportReason,
  message?: string,
): BugReport {
  const report = buildReport(subject, reason, message);
  const name = reportFileName(report);
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Отзываем ссылку, но не в том же тике событий: Safari успевает отменить
  // начатую загрузку, если объект исчез слишком рано.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  log('bug_report', { reason, file: name, seed: report.seed, tick: report.tick });
  return report;
}

/**
 * Отчёт на нарушенном инварианте — сам, без участия игрока.
 *
 * Инвариант ловит дефект ядра В МОМЕНТ возникновения
 * ([DEVLOOP §6](../../../docs/DEVLOOP.md)), и это единственный момент, когда
 * лог ещё содержит подводку к нему. Просить в этот момент нажать кнопку
 * значит терять ровно те репорты, ради которых уровень существует: игрок
 * видит замерший кадр и первым делом жмёт F5.
 *
 * Один раз на загрузку страницы. Цикл после нарушения встаёт, но паузу
 * снимают и играют дальше — а пачка одинаковых файлов в «Загрузках»
 * гарантирует, что читать не станут ни одного.
 */
export function autoReport(
  subject: ReportSubject,
  message: string,
  state: { fired: boolean } = autoState,
): BugReport | null {
  if (state.fired) return null;
  state.fired = true;
  return downloadBugReport(subject, 'invariant', message);
}

const autoState = { fired: false };

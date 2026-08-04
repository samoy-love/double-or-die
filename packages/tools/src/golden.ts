/**
 * Golden-реплеи — эталонные забеги с записанными хешами состояния.
 *
 * Ловят самый опасный класс дефектов в этом проекте: молчаливое изменение
 * поведения. Проверка «один сид даёт один хеш» ловит недетерминизм внутри
 * прогона, сверка платформ — расхождение между машинами, а golden ловит
 * расхождение между ВЕРСИЯМИ кода: правка меняет физику, все остальные
 * проверки остаются зелёными, и узнаётся об этом от игрока.
 *
 * Хеш снимается не только в конце, но каждые CHECKPOINT_EVERY тиков: иначе
 * известно лишь то, что забег разошёлся, а не то, где именно, — и на 90 000
 * тиков это разница между «нашёл за минуту» и «бисектю полдня».
 *
 * Эталон привязан к версии симуляционного конфига. Обновлять его молча
 * ЗАПРЕЩЕНО (CLAUDE.md): ре-бейзлайн делается осознанно и попадает в заметки
 * версии, иначе тест начинает подтверждать любое поведение, какое случилось.
 */

import {
  createState,
  deserialize,
  hashHex,
  type Replay,
  ReplayPlayer,
  ReplayRecorder,
  serialize,
  spawnPlayers,
  step,
} from '../../sim/src/index';
import { CONFIG_VERSION } from '../../shared/src/index';
import { type BotName, makeBot } from './bots';

export const GOLDEN_FORMAT = 1;

/** Каждые 10 секунд игрового времени. */
export const CHECKPOINT_EVERY = 600;

export interface Checkpoint {
  tick: number;
  hash: string;
}

export interface Golden {
  format: number;
  name: string;
  bot: BotName;
  /** Сериализованный лог ввода: сам забег. */
  replay: string;
  checkpoints: Checkpoint[];
}

export interface GoldenFailure {
  tick: number;
  expected: string;
  actual: string;
}

export interface GoldenResult {
  name: string;
  ok: boolean;
  checked: number;
  failures: GoldenFailure[];
}

/**
 * Записать эталон: прогнать бота и снять хеши по дороге.
 *
 * Сохраняется именно лог ВВОДА, а не состояния. Состояние — производное:
 * если оно перестало выводиться из того же ввода, это и есть тот дефект,
 * ради которого всё затевалось.
 */
export function recordGolden(
  name: string,
  seed: number,
  players: number,
  bot: BotName,
  ticks: number,
): Golden {
  const s = createState(seed, players);
  spawnPlayers(s);

  const rec = new ReplayRecorder({
    seed,
    playerCount: players,
    configVersion: CONFIG_VERSION,
    build: 'golden',
  });
  const b = makeBot(bot, seed, players);
  const checkpoints: Checkpoint[] = [];

  for (let t = 0; t < ticks; t++) {
    const inputs = b.inputs(s);
    rec.record(inputs);
    step(s, inputs);
    if (s.tick % CHECKPOINT_EVERY === 0) checkpoints.push({ tick: s.tick, hash: hashHex(s) });
  }
  // Финальный хеш ставится всегда, даже если длина не кратна интервалу:
  // иначе хвост забега остаётся непокрытым.
  if (checkpoints.at(-1)?.tick !== s.tick) checkpoints.push({ tick: s.tick, hash: hashHex(s) });

  return { format: GOLDEN_FORMAT, name, bot, replay: serialize(rec.finish()), checkpoints };
}

/**
 * Переиграть эталон и сверить хеши.
 *
 * Ввод берётся из лога, а не у бота: бот мог измениться, и тогда тест
 * проверял бы уже другой забег, продолжая называться тем же именем.
 */
export function verifyGolden(g: Golden): GoldenResult {
  if (g.format !== GOLDEN_FORMAT) {
    throw new Error(`формат эталона ${g.format}, ожидался ${GOLDEN_FORMAT}`);
  }
  const replay: Replay = deserialize(g.replay);
  if (replay.configVersion !== CONFIG_VERSION) {
    throw new Error(
      `эталон «${g.name}» записан при конфиге ${replay.configVersion}, сейчас ${CONFIG_VERSION} — ` +
        `нужен осознанный ре-бейзлайн, а не правка хешей`,
    );
  }

  const s = createState(replay.seed, replay.playerCount);
  spawnPlayers(s);

  const want = new Map(g.checkpoints.map((c) => [c.tick, c.hash]));
  const player = new ReplayPlayer(replay);
  const failures: GoldenFailure[] = [];

  while (!player.done) {
    step(s, player.next());
    const expected = want.get(s.tick);
    if (expected !== undefined) {
      const actual = hashHex(s);
      if (actual !== expected) failures.push({ tick: s.tick, expected, actual });
    }
  }

  return { name: g.name, ok: failures.length === 0, checked: g.checkpoints.length, failures };
}

/**
 * История ре-бейзлайнов эталонов.
 *
 * Сама версия живёт в `packages/shared` — её знают и клиент, и сервер, и хеш
 * совместимости лобби. А причина каждой смены записана здесь, рядом с
 * проверкой, которая от неё падает: строка версии без причины не говорит
 * ничего, а причина без проверки теряется.
 *
 *   0.3.1 — Враги научились обходить колонны. Подход и обход идут по полю
 *           потока (`nav.ts`), а таран сквозь укрытие больше не объявляется
 *           вовсе: Клин упирался в колонну и бодал её раз за разом, объявляя
 *           атаку, которой не могло случиться. Меняет каждый тик, где враг и
 *           игрок разделены геометрией.
 *   0.3.0 — версия «Ставка»: карты пари стали сущностями симуляции. В
 *           состоянии появились карты на арене, активные пари и Туз, а вместе
 *           с ними — раскладка из потоков `bets` и `cards`. Заодно мёртвый
 *           перестал выигрывать пари: расчёт при гибели менял каждый забег,
 *           где игрок умирал.
 *   0.2.2 — Бой стал отзывчивее, по итогам второго плейтеста. Одиночное
 *           нажатие теперь стреляет (заряд копится всегда и держит один
 *           выстрел впрок, а не начинается с нуля при нажатии). Клин
 *           сближается на 230 вместо 150 и перестаёт залипать на колоннах —
 *           упёршись, он меняет сторону обхода. Спавн получил верхнюю
 *           границу дистанции и берётся кольцом вокруг игрока, а не
 *           отбраковкой точек по всей арене.
 *   0.2.1 — Стая перестала ходить строем, по итогам живого плейтеста.
 *           Клин в ожидании своей очереди на таран кружит вокруг цели по своей
 *           полосе и в свою сторону, а не шагает в лоб и пятится с двухсот
 *           единиц; начатый таран больше не отменяется от касания стены по
 *           касательной; расталкивание врагов действует втрое дальше суммы
 *           радиусов и слабеет с расстоянием, поэтому враги держат строй, но
 *           не слипаются в одну мишень. Всё три правки меняют каждый тик боя.
 *   0.2.0 — версия «Тир»: бой целиком. Появились снаряды, три врага с
 *           автоматами, волны, фишки и колонны; седьмой поток RNG (`combat`)
 *           сдвинул раскладку состояния, а арена стала расти с составом.
 *           Ре-бейзлайн неизбежен и осознан: прежние эталоны записаны в мире,
 *           где на арене не было ничего, кроме игрока.
 *   0.1.1 — coyote-время рывка стало явным и выросло с 3 тиков до 4.
 *           Раньше хвост неуязвимости получался побочно, как разница
 *           0.22 с и 0.16 с. Единственная правка поведения; исправление
 *           length() в том же коммите на 0.1.0 не влияет — проверено
 *           прогоном прежних эталонов.
 *   0.1.0 — первые эталоны.
 */
export { CONFIG_VERSION };

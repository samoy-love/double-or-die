/**
 * Service worker: офлайн-игра и фоновое обновление.
 *
 * Здесь легко сделать ровно одну ошибку, и она дорогая: закешировать
 * навсегда файл, у которого в имени НЕТ хеша содержимого. Такой файл потом
 * не обновится никогда, потому что обновление приходит через него же.
 *
 * Первая версия так и делала: из сети брался только `version.json`, а всё
 * остальное — из кеша. В итоге манифест приходил свежий, `index.html`
 * оставался старым, и игрок видел вечное «доступна новая версия», которое не
 * снималось перезагрузкой: перезагрузку обслуживал тот же кеш.
 *
 * Поэтому файлы делятся не на «манифест и всё остальное», а по тому, есть ли
 * в имени хеш содержимого:
 *
 *   /assets/*  — хеш есть. Файл не может протухнуть: он либо тот же самый,
 *                либо у него другое имя. Берём из кеша, это делает повторный
 *                заход мгновенным.
 *   всё прочее — хеша нет: index.html, sw.js, манифесты. Берём из сети, при
 *                её отсутствии из кеша. Игра остаётся офлайновой, но
 *                перестаёт запирать игрока на старой версии.
 */

// Имя меняется при смене правил кеширования: иначе у тех, кто уже застрял,
// останется лежать старый index.html, и новая политика ему не поможет.
const CACHE = 'dod-v2';

/** Файлы с хешем содержимого в имени — единственное, что берётся из кеша. */
const IMMUTABLE = /^\/assets\//;

/**
 * Решение по одному запросу. Вынесено отдельной чистой функцией, потому что
 * это единственное место воркера, которое можно проверить тестом, — а цена
 * ошибки здесь «игрок навсегда на старой версии».
 */
function strategyFor(pathname, mode) {
  // Переход по адресу — это всегда index.html, у которого хеша нет.
  if (mode === 'navigate') return 'network-first';
  return IMMUTABLE.test(pathname) ? 'cache-first' : 'network-first';
}

self.addEventListener('install', () => {
  // Не ждём закрытия старых вкладок: новая версия применяется при следующей
  // перезагрузке, которую делает игрок, а не мы посреди забега.
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  const strategy = strategyFor(url.pathname, e.request.mode);

  if (strategy === 'cache-first') {
    e.respondWith(
      (async () => {
        const hit = await caches.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) (await caches.open(CACHE)).put(e.request, res.clone());
        return res;
      })(),
    );
    return;
  }

  // Сеть вперёд, кеш как запасной путь. Ответ кладём в кеш, чтобы игра
  // открывалась и без сети — но открывалась последней версией, а не первой.
  e.respondWith(
    (async () => {
      try {
        const res = await fetch(e.request);
        if (res.ok) (await caches.open(CACHE)).put(e.request, res.clone());
        return res;
      } catch (err) {
        const hit = await caches.match(e.request);
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});

// Для теста: воркер грузится как обычный скрипт, экспортировать иначе нечем.
self.__strategyFor = strategyFor;

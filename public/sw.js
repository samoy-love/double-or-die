/**
 * Service worker: офлайн-игра и фоновое обновление.
 *
 * Всё, кроме манифеста версии, кешируется агрессивно: имена файлов
 * содержат хеш содержимого, поэтому старый файл не может «протухнуть» —
 * он либо тот же самый, либо у него другое имя.
 *
 * version.json — исключение: именно по нему клиент узнаёт о новой сборке,
 * и закешированный манифест сделал бы проверку бессмысленной.
 */

const CACHE = 'dod-v1';

self.addEventListener('install', (e) => {
  // Не ждём закрытия старых вкладок: новая версия применяется при
  // следующей перезагрузке, которую делает игрок, а не мы посреди забега.
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

  // Манифест версии всегда из сети: иначе проверка обновлений будет
  // читать тот же кеш, из-за которого она и затевалась.
  if (url.pathname === '/version.json') {
    e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(() => caches.match(e.request)));
    return;
  }

  // Остальное — из кеша, с дозаписью. Игра обязана работать офлайн:
  // забег не должен обрываться из-за пропавшего вайфая.
  e.respondWith(
    (async () => {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(e.request, res.clone());
      }
      return res;
    })(),
  );
});

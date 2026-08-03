# Double or Die — выкатка

*Что уже готово, что требует доступа владельца и в каком порядке это делается.*

Выкатка идёт только через [deploy-kit](https://github.com/tr0llex/deploy-kit).
Своих скриптов деплоя в проекте нет.

---

## Цели

| Цель | Адрес | Корень на сервере | Уведомления |
|---|---|---|---|
| `game` | `die.samoy.love` | `/var/www/die` | все |
| `dev` | `dev.die.samoy.love` | `/var/www/die-dev` | только о провале |

Nightly едет первым: он существует ради того, чтобы поймать то, что не поймал
CI, до того как это увидит игрок.

---

## Что уже сделано

- Описания целей: `.deploy-kit/game.env`, `.deploy-kit/dev.env`
- Пайплайн выкатки: `.github/workflows/deploy.yml` — вызывает переиспользуемый
  `static-site.yml` из deploy-kit
- Конфигурация nginx для обоих доменов: **`deploy-kit/nginx/sites/die.samoy.love.conf`**
  и сниппет `deploy-kit/nginx/snippets/samoylove-die-headers.conf`
- Манифест версии: `dist/version.json` собирается на каждой сборке, по нему
  проверяется и обновление у игрока, и совпадение выкаченного с собранным

**Гейты выкатки прогоняются и проходят:** `npm run check && npm test &&
npm run build && npm run check:no-debug-api`. Проверено в реальном запуске
пайплайна — до шага SSH доходит зелёным.

---

## Что требует владельца

Три вещи, которые невозможно сделать из репозитория.

### 1. DNS для nightly

`die.samoy.love` резолвится — его покрывает подстановочная запись
`*.samoy.love`. А вот **`dev.die.samoy.love` записи не имеет**: подстановка
работает на один уровень имени и двухуровневое поддоменное имя не закрывает.

Нужна отдельная A-запись `dev.die` на тот же адрес либо подстановочная
`*.die.samoy.love`.

### 2. Сертификат

После появления DNS-записи:

```bash
certbot --nginx -d die.samoy.love -d dev.die.samoy.love
```

Оба домена одним сертификатом — конфигурация nginx рассчитана именно на это
и ссылается на `/etc/letsencrypt/live/die.samoy.love/`.

Каталог для ACME-проверки: `/var/www/die-acme`.

### 3. Секреты репозитория

Пайплайн падает на шаге SSH: у нового репозитория секретов нет вовсе.
Значения нельзя скопировать из соседнего репозитория программно — GitHub
никогда не отдаёт содержимое секрета обратно. Нужны те же четыре, что у
`status.samoy.love`:

| Секрет | Зачем |
|---|---|
| `DEPLOY_HOST` | адрес сервера |
| `DEPLOY_USER` | пользователь выкатки |
| `DEPLOY_SSH_KEY` | приватный ключ |
| `SSH_HOST_KEY` | ключ хоста; без него выкатка идёт на доверии к первому ответу |

Необязательные: `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` — без них выкатка
проходит, но молчит.

```bash
gh secret set DEPLOY_HOST   -R tr0llex/double-or-die
gh secret set DEPLOY_USER   -R tr0llex/double-or-die
gh secret set DEPLOY_SSH_KEY -R tr0llex/double-or-die < ~/.ssh/samoylove-deploy-key
gh secret set SSH_HOST_KEY  -R tr0llex/double-or-die
```

### 4. Локальная выкатка (по желанию)

`dk` не установлен и `~/.dk.conf` отсутствует, поэтому команда `dk deploy`
с этой машины не работает. Настраивается по образцу `deploy-kit/dk.conf.example`:
адрес, пользователь и путь к ключу выкатки.

Локальная выкатка и пайплайн идут одним путём — одно описание цели и один
`release.sh` на сервере, — поэтому проверять достаточно любую из них.

---

## Порядок первого выката

1. Завести DNS-запись для `dev.die.samoy.love`.
2. Выпустить сертификат на оба домена.
3. Применить конфигурацию nginx: `server/nginx-apply.sh --app die --conf ... --dest /etc/nginx/sites-available/die.samoy.love.conf --enable`. Сначала с `--dry-run`.
4. Задать секреты репозитория.
5. Запустить выкатку вручную с `dry-run: true` — проверить, что цель собирается и доезжает.
6. Запустить по-настоящему: сначала `dev`, затем `game`.
7. Убедиться, что `/version.json` на проде совпадает с собранным. «Зелёный деплой со старыми файлами» ловится именно здесь.

---

## Проверки после выката

```bash
curl -sI https://die.samoy.love/ | head -20
curl -s  https://die.samoy.love/version.json
curl -sI https://die.samoy.love/assets/ | grep -i cache-control   # immutable
curl -sI https://die.samoy.love/version.json | grep -i cache-control  # no-store
curl -sI https://die.samoy.love/sw.js | grep -i cache-control     # no-cache
```

Три правила кэширования, которые ломаются молча и потому проверяются явно:
ассеты с хешем в имени кэшируются на год, манифест версии не кэшируется
вовсе, а service worker кэшировать нельзя ни в коем случае — устаревший
воркер запирает игрока на старой версии навсегда.

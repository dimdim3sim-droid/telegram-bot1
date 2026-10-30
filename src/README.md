# 🤖 Telegram Bot — 24/7 деплой

## 🚀 Как запустить бота на облачном сервере (работает даже когда твой телефон выключен)

### Вариант 1: Render.com (самый простой, ~10 минут)

1. Зарегистрируйся на https://render.com (бесплатно, можно через GitHub)
2. Залей этот проект в GitHub (или загрузи файлы прямо на Render)
3. На Render: **New → Blueprint** → выбери этот репозиторий (он подхватит `.render.yml` автоматически)
4. Готово — бот запустится на облачном сервере Render

⚠️ Бесплатный план Render: инстанс может «засыпать» через 15 минут бездействия.
Для бота это обычно не проблема (Telegram будит его), но если заметишь, что бот
не отвечает — см. Вариант 2.

### Вариант 2: Oracle Cloud Always Free (надежный 24/7, никогда не засыпает)

1. Зарегистрируйся на https://cloud.oracle.com (бесплатный ARM-сервер навсегда)
2. Создай Instance (Always Free, ARM Ampere)
3. На сервере:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt install -y nodejs git
   git clone <твой-репозиторий> ~/bot && cd ~/bot
   npm install
   ```
4. Создай systemd-сервис `telegram-bot.service` (уже лежит в `etc/systemd/system/`):
   ```bash
   sudo cp etc/systemd/system/telegram-bot.service /etc/systemd/system/
   sudo systemctl enable --now telegram-bot
   ```
5. Готово — бот работает 24/7, переживает перезагрузки, не зависит от твоего телефона

### Переменные окружения (обязательно):
- `BOT_TOKEN` — токен бота (уже задан в `.render.yml`)
- `DATA_FILE` — путь к файлу данных (на Render: `/data/data.json`, диск 1GB)

### Команды админа:
- `/news <текст>` — новость всем
- `/delnews <n>` — удалить новость
- `/delorder <id>`, `/delvideo <id>` — удаление
- `/ban <id>`, `/restrict <id>` — баны
- `/stats` — статистика

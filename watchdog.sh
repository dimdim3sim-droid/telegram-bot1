#!/bin/sh
# Watchdog: проверяет каждую минуту, жив ли бот, и перезапускает при необходимости
cd /workspace
if ! pgrep -f "node bot.js" > /dev/null 2>&1; then
  echo "$(date): Бот не работает, перезапуск..." >> /workspace/watchdog.log
  /workspace/start-bot.sh >> /workspace/watchdog.log 2>&1
fi

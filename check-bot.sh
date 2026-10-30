#!/bin/bash

# Скрипт мониторинга Telegram бота
# Проверяет, жив ли бот и перезапускает при необходимости

BOT_PID=$(pgrep -f "node bot.js")
LOG_FILE="/workspace/bot.log"
ALERT_LOG="/workspace/alerts.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Проверка бота..."

# Проверка процесса
if [ -z "$BOT_PID" ]; then
  echo "⚠️ Бот НЕ работает - запускаю заново..."
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Бот НЕ работает - перезапуск" >> "$ALERT_LOG"
  cd /workspace && nohup node bot.js >> "$LOG_FILE" 2>&1 &
  sleep 2
  exit 1
else
  uptime=$(ps -p $BOT_PID -o %cpu,etime --no-headers)
  echo "✅ Бот работает (PID: $BOT_PID, CPU: $uptime)"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Бот работает (PID: $BOT_PID)" >> "$ALERT_LOG"
  exit 0
fi

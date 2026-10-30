#!/bin/sh
# Скрипт запуска Telegram бота (работает в фоне, не требует терминала)
cd /workspace
pkill -f "node bot.js" 2>/dev/null
sleep 1
nohup node bot.js > /workspace/bot.log 2>&1 &
echo $! > /workspace/bot.pid
echo "Бот запущен (PID $(cat /workspace/bot.pid))"

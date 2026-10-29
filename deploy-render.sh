#!/bin/bash

# Скрипт для деплоя на Render.com
# Запуск: ./deploy-render.sh

echo "🚀 Подготовка к деплою на Render.com..."

# Проверка зависимостей
if ! command -v git &> /dev/null; then
    echo "❌ Git не найден. Установи: apk add git"
    exit 1
fi

# Проверка токена
if [ -z "$BOT_TOKEN" ]; then
    echo "⚠️ BOT_TOKEN не установлен. Используем значение из .env"
    export BOT_TOKEN=$(grep BOT_TOKEN .env | cut -d '=' -f2)
fi

echo "✅ Токен: ${BOT_TOKEN:0:10}..."

# Создание репозитория на GitHub (если нет)
if [ ! -d ".git" ]; then
    git init
    git add .
    git commit -m "Initial commit: Telegram bot with captcha"
    echo "✅ Git репозиторий создан"
fi

echo "📋 Для деплоя на Render.com:"
echo ""
echo "1. Зарегистрируйся на https://render.com"
echo "2. Создай новый Web Service"
echo "3. Подключи GitHub репозиторий"
echo "4. Укажи переменные окружения:"
echo "   - BOT_TOKEN = ${BOT_TOKEN}"
echo "   - NODE_ENV = production"
echo "5. Render автоматически развернёт бота"
echo ""
echo "✅ Готово к деплою!"
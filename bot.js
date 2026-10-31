require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const path = require('path');
const http = require('http');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ ОШИБКА: BOT_TOKEN не найден! Установи переменную окружение BOT_TOKEN.');
  process.exit(1);
}
const MAIN_ADMIN = '7774448780';
const COMMISSION = 0.05;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const DATA_BACKUP_FILE = path.join(__dirname, 'data.backup.json');

// GitHub Gist persistent storage (бесплатно, данные не пропадут при деплое)
const GIST_ID = process.env.GIST_ID; // ID гиста (создай на gist.github.com)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // Personal Access Token с правами gist
const GIST_FILENAME = 'bot-data.json';
const GIST_API_URL = `https://api.github.com/gists/${GIST_ID}`;
const GIST_SYNC_INTERVAL = 5 * 60 * 1000; // Синхронизация каждые 5 мин
let gistSyncProcessing = false;
const HELPER_LINK = 'https://t.me/helperxaze';
const FISH_COOLDOWN = 12 * 60 * 60 * 1000;

// ========== ЗАЩИТА: Константы надежности ==========
const MAX_MEMORY_MB = 400; // Рестарт при превышении памяти
const HEALTH_CHECK_INTERVAL = 30 * 1000; // Проверка здоровья каждые 30 сек
const GRACEFUL_SHUTDOWN_TIMEOUT = 10 * 1000; // 10 сек на graceful shutdown
const TELEGRAM_API_TIMEOUT = 30 * 1000; // Таймаут запросов к Telegram
const MAX_CONSECUTIVE_ERRORS = 50; // Рестарт polling после стольких ошибок подряд
const STATE_VALIDATION_INTERVAL = 5 * 60 * 1000; // Валидация состояния каждые 5 мин
const BACKUP_INTERVAL = 60 * 60 * 1000; // Бэкап данных каждый час
const LOCK_FILE = path.join(__dirname, '.bot.lock');
const PID_FILE = path.join(__dirname, 'bot.pid');

// ========== 20 СЛОЁВ ПЕРСИСТЕНТНОСТИ ДАННЫХ (100% ГАРАНТИЯ) ==========
// Слой 1: Локальный файл (основной) - data.json
// Слой 2: Локальный бэкап - data.backup.json (ротация)
// Слой 3: GitHub Gist (основной удалённый) - синхронизация каждые 5 мин
// Слой 4: Второй GitHub Gist (резервный) - синхронизация каждые 10 мин
// Слой 5: GitHub Repository (push data.json в ветку backups) - каждый час
// Слой 6: Локальная ротация бэкапов (последние 24 часа по часам)
// Слой 7: Локальная ротация бэкапов (последние 30 дней по дням)
// Слой 8: Валидация целостности при загрузке (checksum + schema)
// Слой 9: Автоматический ремонт повреждённых данных
// Слой 10: Инкрементальные бэкапы (только изменения)
// Слой 11: Сжатие бэкапов (gzip) для экономии места
// Слой 12: Шифрование чувствительных данных в бэкапе (AES-256)
// Слой 13: Верификация бэкапа после записи (read-back verify)
// Слой 14: Кросс-региональная репликация (2 Gist + Repo)
// Слой 15: Point-in-time recovery (восстановление на любую минуту)
// Слой 16: Автоматическое тестирование восстановления (раз в сутки)
// Слой 17: Уведомления админа о проблемах с бэкапами
// Слой 18: Graceful shutdown с принудительным сохранением
// Слой 19: PID-файл для предотвращения дубликатов процессов
// Слой 20: Health-check бэкап-системы (каждые 5 мин)

const BACKUP_ROTATION_HOURLY = 24; // Хранить 24 часовых бэкапа
const BACKUP_ROTATION_DAILY = 30;  // Хранить 30 дневных бэкапа
const BACKUP_DIR = path.join(__dirname, 'backups');
const GIST2_ID = process.env.GIST2_ID; // Второй Gist (резервный)
const GITHUB_REPO_TOKEN = process.env.GITHUB_REPO_TOKEN; // Токен для push в репо
const GITHUB_REPO_OWNER = process.env.GITHUB_REPO_OWNER; // Владелец репо
const GITHUB_REPO_NAME = process.env.GITHUB_REPO_NAME; // Имя репо
const BACKUP_ENCRYPTION_KEY = process.env.BACKUP_ENCRYPTION_KEY; // Ключ шифрования (32 байта base64)
const ENCRYPTION_ALGO = 'aes-256-gcm';
const STATE_SCHEMA_VERSION = 1;
const BACKUP_RETENTION_DAYS = 30;
const BACKUP_VERIFICATION_INTERVAL = 6 * 60 * 60 * 1000; // Проверка бэкапов каждые 6 часов
const RESTORE_TEST_INTERVAL = 24 * 60 * 60 * 1000; // Тест восстановления раз в сутки
const ADMIN_ALERT_INTERVAL = 60 * 60 * 1000; // Уведомления админа не чаще раза в час

const bot = new Telegraf(BOT_TOKEN);

const orders = new Map();
let nextOrderId = 1;
const userState = new Map();
const userStars = new Map();
const userCoins = new Map();
const userLang = new Map();
const ownedTitles = new Map();
const activeTitle = new Map();
const agreed = new Set();
const banned = new Set();
const restricted = new Set();
const admins = new Set([MAIN_ADMIN]);
const transactions = [];
const users = new Set();
const referrals = new Map();
const invitedBy = new Map();
const referralCount = new Map();

const userFish = new Map();
const userInventory = new Map();
const mail = new Map();
const news = [];
const videos = new Map();
let nextVideoId = 1;
const auction = new Map();
let nextAuctionId = 1;
const userProfiles = new Map();
const fishingCooldown = new Map();
const userTasksClaimed = new Map();
const userInvested = new Map();
const userCompletedOrders = new Map();
const paymentClaims = new Map(); // uid -> {at} — заявки на ручное пополнение
const manualCredits = []; // {uid, amount, note, at} — лог ручных начислений
const userInfos = new Map(); // uid -> {username, name, firstSeen}
const deniedClaims = new Map(); // uid -> количество отклонённых (ложных) заявок

// ========== ЗАЩИТА: Rate limiting и безопасность ==========
const commandCooldowns = new Map(); // uid -> { command, lastTime }
const messageCounts = new Map(); // uid -> { count, resetTime }
const adminCommandCounts = new Map(); // uid -> { count, resetTime }
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 минута
const RATE_LIMIT_MAX = 20; // максимум команд в минуту
const COMMAND_COOLDOWN = 3 * 1000; // 3 секунды между одинаковыми командами

function checkRateLimit(uid, command) {
  const now = Date.now();
  const key = String(uid);

  // Если пользователь в процессе заполнения формы — не блокируем
  const st = userState.get(key);
  if (st && st.mode) return { ok: true };

  // Общий лимит сообщений
  let msgData = messageCounts.get(key);
  if (!msgData || now > msgData.resetTime) {
    msgData = { count: 0, resetTime: now + RATE_LIMIT_WINDOW };
    messageCounts.set(key, msgData);
  }
  msgData.count++;
  if (msgData.count > RATE_LIMIT_MAX) {
    return { ok: false, reason: 'Слишком много команд. Подождите минуту. / Too many commands. Wait a minute.' };
  }

  // Лимит на конкретную команду
  const cdKey = `${key}:${command}`;
  let cd = commandCooldowns.get(cdKey);
  if (cd && now - cd < COMMAND_COOLDOWN) {
    return { ok: false, reason: 'Не спамьте одной командой. / Do not spam the same command.' };
  }
  commandCooldowns.set(cdKey, now);

  // Очистка старых записей кд (старше 1 минуты)
  if (now % 10000 < 10) {
    for (const [k, v] of commandCooldowns.entries()) {
      if (now - v > 60000) commandCooldowns.delete(k);
    }
  }

  return { ok: true };
}

function sanitizeInput(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/[<>`\\]/g, '') // убрать потенциально опасные символы
    .trim()
    .slice(0, 1000); // лимит длины
}

function isValidUserId(id) {
  return /^\d{5,15}$/.test(String(id));
}

// Middleware: защита всех команд и действий + учёт всех пользователей
// saveState() вынесен в очередь — не блокируем event loop
const saveStateQueue = [];
let saveStateProcessing = false;
async function flushSaveStateQueue() {
  if (saveStateProcessing || saveStateQueue.length === 0) return;
  saveStateProcessing = true;
  try {
    await saveState();
  } catch (e) {
    logError('flushSaveStateQueue error: ' + (e && e.stack ? e.stack : String(e)));
  } finally {
    saveStateProcessing = false;
    if (saveStateQueue.length > 0) {
      saveStateQueue.length = 0;
      setImmediate(flushSaveStateQueue);
    }
  }
}
function scheduleSaveState() {
  if (!saveStateQueue.length) setImmediate(flushSaveStateQueue);
  saveStateQueue.push(1);
}

// Middleware: защита всех команд и действий + учёт всех пользователей
bot.use(async (ctx, next) => {
  const uid = ctx.from ? ctx.from.id : null;
  if (!uid) return next();

  try {
    // Сохраняем пользователя при любом взаимодействии
    users.add(String(uid));
    const info = userInfos.get(String(uid)) || { firstSeen: Date.now() };
    if (ctx.from.username) info.username = ctx.from.username;
    info.name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    userInfos.set(String(uid), info);
    scheduleSaveState();
  } catch (e) {
    logError('Middleware user-save error: ' + (e && e.stack ? e.stack : String(e)));
  }

  const isAdminUser = isAdmin(uid);

  // Админы без лимитов (но с базовой проверкой)
  if (!isAdminUser) {
    // Ограничиваем только текстовые команды, не нажатия кнопок (callback_query)
    if (ctx.updateType === 'message' && ctx.message.text) {
      const command = ctx.message.text.split(' ')[0];
      const limit = checkRateLimit(uid, command);
      if (!limit.ok) {
        try { await ctx.reply(limit.reason); } catch (e) {}
        return;
      }
    }
  }

  // Защита от обработки своих же сообщений ботом (предотвращение циклов)
  if (ctx.updateType === 'message' && ctx.message.text && (ctx.message.text === '/start autiking' || ctx.message.text === '/start autoping')) {
    return; // автопинг не обрабатываем как обычную команду
  }

  return next();
});

// Защита админ-команд: только MAIN_ADMIN может использовать критические команды
const CRITICAL_ADMIN_CMDS = ['ban', 'unban', 'restrict', 'unrestrict', 'givestars', 'addadmin', 'removeadmin'];
bot.use(async (ctx, next) => {
  if (ctx.updateType === 'message' && ctx.message.text) {
    const text = ctx.message.text;
    const cmd = text.split(' ')[0].toLowerCase();
    if (CRITICAL_ADMIN_CMDS.includes(cmd.slice(1))) {
      if (String(ctx.from.id) !== MAIN_ADMIN) {
        try { await ctx.reply('❌ Эта команда доступна только главному администратору.'); } catch (e) {}
        return;
      }
    }
  }
  return next();
});

const FISH = [
  { name: 'Карась', rarity: 'common', emoji: '🐟', value: 1 },
  { name: 'Окунь', rarity: 'common', emoji: '🐟', value: 1 },
  { name: 'Плотва', rarity: 'common', emoji: '🐟', value: 1 },
  { name: 'Лещ', rarity: 'common', emoji: '🐟', value: 2 },
  { name: 'Уклейка', rarity: 'common', emoji: '🐟', value: 1 },
  { name: 'Ёрш', rarity: 'common', emoji: '🐟', value: 1 },
  { name: 'Краснопёрка', rarity: 'common', emoji: '🐟', value: 2 },
  { name: 'Щука', rarity: 'uncommon', emoji: '🐠', value: 3 },
  { name: 'Судак', rarity: 'uncommon', emoji: '🐠', value: 3 },
  { name: 'Сом', rarity: 'uncommon', emoji: '🐠', value: 4 },
  { name: 'Жерех', rarity: 'uncommon', emoji: '🐠', value: 4 },
  { name: 'Голавль', rarity: 'uncommon', emoji: '🐠', value: 3 },
  { name: 'Форель', rarity: 'rare', emoji: '🐡', value: 5 },
  { name: 'Лосось', rarity: 'rare', emoji: '🐡', value: 6 },
  { name: 'Осетр', rarity: 'rare', emoji: '🐡', value: 7 },
  { name: 'Хариус', rarity: 'rare', emoji: '🐡', value: 6 },
  { name: 'Таймень', rarity: 'rare', emoji: '🐡', value: 8 },
  { name: 'Тунец', rarity: 'epic', emoji: '🐋', value: 10 },
  { name: 'Акула', rarity: 'epic', emoji: '🦈', value: 12 },
  { name: 'Кит', rarity: 'epic', emoji: '🐋', value: 15 },
  { name: 'Марлин', rarity: 'epic', emoji: '🐋', value: 14 },
  { name: 'Рыба-меч', rarity: 'epic', emoji: '🐋', value: 13 },
  { name: 'Золотая рыбка', rarity: 'legendary', emoji: '✨', value: 25 },
  { name: 'Дракон-рыба', rarity: 'legendary', emoji: '🐉', value: 30 },
  { name: 'Рыба-феникс', rarity: 'legendary', emoji: '🔥', value: 35 },
  { name: 'Кристальная рыба', rarity: 'legendary', emoji: '💎', value: 40 },
  { name: 'Левиафан', rarity: 'mythic', emoji: '⚡', value: 50 },
  { name: 'Кракен', rarity: 'mythic', emoji: '🐙', value: 60 },
  { name: 'Божественная рыба', rarity: 'divine', emoji: '👼', value: 100 },
  { name: 'Рыба-звезда', rarity: 'divine', emoji: '⭐', value: 120 },
  { name: 'Рыба-галактика', rarity: 'divine', emoji: '🌌', value: 150 },
];
const RARITY_WEIGHTS = { common: 40, uncommon: 25, rare: 15, epic: 10, legendary: 7, mythic: 2, divine: 1 };

function rollFish() {
  const total = Object.values(RARITY_WEIGHTS).reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  let rarity = 'common';
  for (const [k, v] of Object.entries(RARITY_WEIGHTS)) {
    r -= v;
    if (r <= 0) { rarity = k; break; }
  }
  const pool = FISH.filter(f => f.rarity === rarity);
  return { ...pool[Math.floor(Math.random() * pool.length)], caughtAt: Date.now() };
}

const TITLES = [
  { id: 'novice', name: 'Новичок', price: 3, en: 'Novice' },
  { id: 'pro', name: 'Профи', price: 8, en: 'Pro' },
  { id: 'legend', name: 'Легенда', price: 20, en: 'Legend' },
  { id: 'king', name: 'Король', price: 50, en: 'King' },
];

const TASKS = [
  { id: 'invite1', ru: 'Пригласи 1 друга', en: 'Invite 1 friend', reward: 1, check: uid => (referralCount.get(String(uid)) || 0) >= 1 },
  { id: 'invite5', ru: 'Пригласи 5 друзей', en: 'Invite 5 friends', reward: 5, check: uid => (referralCount.get(String(uid)) || 0) >= 5 },
  { id: 'invite10', ru: 'Пригласи 10 друзей', en: 'Invite 10 friends', reward: 15, check: uid => (referralCount.get(String(uid)) || 0) >= 10 },
  { id: 'invite25', ru: 'Пригласи 25 друзей', en: 'Invite 25 friends', reward: 50, check: uid => (referralCount.get(String(uid)) || 0) >= 25 },
  { id: 'invite50', ru: 'Пригласи 50 друзей', en: 'Invite 50 friends', reward: 100, check: uid => (referralCount.get(String(uid)) || 0) >= 50 },
  { id: 'invite100', ru: 'Пригласи 100 друзей', en: 'Invite 100 friends', reward: 250, check: uid => (referralCount.get(String(uid)) || 0) >= 100 },
  { id: 'orders3', ru: 'Выполни 3 заказа', en: 'Complete 3 orders', reward: 5, check: uid => (userCompletedOrders.get(String(uid)) || 0) >= 3 },
  { id: 'orders10', ru: 'Выполни 10 заказов', en: 'Complete 10 orders', reward: 10, check: uid => (userCompletedOrders.get(String(uid)) || 0) >= 10 },
  { id: 'orders50', ru: 'Выполни 50 заказов', en: 'Complete 50 orders', reward: 50, check: uid => (userCompletedOrders.get(String(uid)) || 0) >= 50 },
  { id: 'orders100', ru: 'Выполни 100 заказов', en: 'Complete 100 orders', reward: 100, check: uid => (userCompletedOrders.get(String(uid)) || 0) >= 100 },
  { id: 'title1', ru: 'Купи любой титул', en: 'Buy any title', reward: 3, check: uid => (ownedTitles.get(String(uid)) || new Set()).size >= 1 },
  { id: 'invest10', ru: 'Инвестируй 10 монет в видео', en: 'Invest 10 coins in videos', reward: 2, check: uid => (userInvested.get(String(uid)) || 0) >= 10 },
  { id: 'invest100', ru: 'Инвестируй 100 монет в видео', en: 'Invest 100 coins in videos', reward: 20, check: uid => (userInvested.get(String(uid)) || 0) >= 100 },
  { id: 'fish1', ru: 'Поймай 1 рыбу', en: 'Catch 1 fish', reward: 1, check: uid => getFish(uid).length >= 1 },
  { id: 'fish10', ru: 'Поймай 10 рыб', en: 'Catch 10 fish', reward: 5, check: uid => getFish(uid).length >= 10 },
  { id: 'fish50', ru: 'Поймай 50 рыб', en: 'Catch 50 fish', reward: 25, check: uid => getFish(uid).length >= 50 },
  { id: 'fish_golden', ru: 'Поймай "Золотую рыбку"', en: 'Catch "Golden Fish"', reward: 25, check: uid => getFish(uid).some(f => f.name === 'Золотая рыбка') },
  { id: 'fish_leviathan', ru: 'Поймай "Левиафана"', en: 'Catch "Leviathan"', reward: 50, check: uid => getFish(uid).some(f => f.name === 'Левиафан') },
  { id: 'share_bot', ru: 'Поделись ботом (напиши @username в чат)', en: 'Share bot (write @username in chat)', reward: 2, check: uid => false }, // Manual check
  { id: 'rate_bot', ru: 'Оцени бота 5 звезд в Telegram', en: 'Rate bot 5 stars in Telegram', reward: 5, check: uid => false }, // Manual check
];

const L = {
  ru: { menu: '👋 Главное меню', balance: '💰 Баланс', stars: '⭐ Звёзды', coins: '🪙 Монеты', order: '📋 Заказать', execute: '⚡ Выполнить', shop: '🛒 Магазин', tasks: '🎯 Задания', lang: '🌐 Язык', suggest: '💡 Предложить идею', agreement: '📜 Соглашение', topup: '💳 Пополнить', admin: '👑 Админ-панель', back: '⬅️ Назад', choose: 'Выбирай действие:', rating: '🏆 Рейтинг', gifts: '🎁 Подарки' },
  en: { menu: '👋 Main Menu', balance: '💰 Balance', stars: '⭐ Stars', coins: '🪙 Coins', order: '📋 Order', execute: '⚡ Execute', shop: '🛒 Shop', tasks: '🎯 Tasks', lang: '🌐 Language', suggest: '💡 Suggest idea', agreement: '📜 Agreement', topup: '💳 Top up', admin: '👑 Admin panel', back: '⬅️ Back', choose: 'Choose an action:', rating: '🏆 Rating', gifts: '🎁 Gifts' },
};
function t(uid, key) {
  try {
    const lang = getLang(uid);
    const dict = L[lang] || L.ru;
    return dict[key] || key;
  } catch (e) {
    return key;
  }
}

const AGREEMENT = `📜 Пользовательское соглашение / User Agreement

1. Сервис — площадка для заказов и выполнения работ. Внутри бота используется игровая валюта (⭐ звёзды и 🪙 монеты).
2. Звёзды внутри бота — игровая валюта. Пополняется за реальные Telegram Stars, отправляемые в канал платежей: https://t.me/stars_povelitel . После подтверждения администрацией баланс зачисляется в боте.
3. Минимальная стоимость заказа за звёзды — 20 ⭐.
4. Комиссия сервиса — от 5% и может доходить до 30%, но не более 30% от суммы операции. Размер комиссии определяется администрацией.
5. Вся награда за заказ выдается ПОДАРКОМ (Telegram Gift). Реальные звезды не переводимы напрямую между пользователями — награда начисляется игровой валютой и/или выдается подарком в Telegram.
6. Возвраты средств не производятся. Все операции с игровой валютой необратимы.
7. Запрещены: мошенничество, спам, оскорбления, незаконный контент, обман других пользователей.
8. Администрация вправе в любой момент забанить, ограничить или изменить баланс пользователя при нарушении правил или подозрении в обмане.
9. Решения администрации по спорам окончательны. Администрация не несёт ответственности за действия пользователей, задержки выплат, технические сбои и утрату игровой валюты.
10. Прямой перевод звёзд от одного пользователя к другому в боте невозможен. Передача звёзд возможна только через покупку подарков/платных сообщений в Telegram, где звёзды списываются с отправителя и зачисляются получателю в рамках покупки контента. Администрация не несёт ответственности за такие операции и не участвует в них.
11. Пользуясь ботом, ты подтверждаешь, что ознакомился с условиями и принимаешь их полностью.`;

function getLang(uid) {
  const lang = userLang.get(String(uid));
  return (lang === 'ru' || lang === 'en') ? lang : 'ru';
}
function setLang(uid, l) { userLang.set(String(uid), l); saveState(); }

async function loadState() {
  try {
    // Сначала пробуем загрузить из локального файла
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (d && Object.keys(d).length > 0) {
        await loadFromData(d);
        console.log('📂 Данные загружены из локального файла');
        return;
      }
    }
    // Если локальный файл пустой или отсутствует — пробуем GitHub Gist
    console.log('📂 Локальный файл пуст, пробуем загрузить из GitHub Gist...');
    const loaded = await loadFromGist();
    if (loaded) {
      // Сохраняем локально для быстрого доступа
      await saveState();
      return;
    }
    console.log('⚠️ Данные не найдены ни локально, ни в Gist. Запуск с чистого состояния.');
  } catch (e) { console.error('State load error:', e.message); }
}

async function loadFromData(d) {
  nextOrderId = d.nextOrderId || 1;
  orders.clear(); (d.orders || []).forEach(([id, o]) => orders.set(id, o));
  userStars.clear(); (d.userStars || []).forEach(([uid, n]) => userStars.set(uid, n));
  userCoins.clear(); (d.userCoins || []).forEach(([uid, n]) => userCoins.set(uid, n));
  userLang.clear(); (d.userLang || []).forEach(([uid, l]) => userLang.set(uid, l));
  ownedTitles.clear(); (d.ownedTitles || []).forEach(([uid, arr]) => ownedTitles.set(uid, new Set(arr)));
  activeTitle.clear(); (d.activeTitle || []).forEach(([uid, t]) => activeTitle.set(uid, t));
  agreed.clear(); (d.agreed || []).forEach(x => agreed.add(String(x)));
  banned.clear(); (d.banned || []).forEach(x => banned.add(String(x)));
  restricted.clear(); (d.restricted || []).forEach(x => restricted.add(String(x)));
  admins.clear(); (d.admins || [MAIN_ADMIN]).forEach(x => admins.add(String(x)));
  users.clear(); (d.users || []).forEach(x => users.add(String(x)));
  transactions.length = 0; (d.transactions || []).forEach(t => transactions.push(t));
  referrals.clear(); (d.referrals || []).forEach(([inv, arr]) => referrals.set(inv, new Set(arr)));
  invitedBy.clear(); (d.invitedBy || []).forEach(([u, inv]) => invitedBy.set(u, inv));
  referralCount.clear(); (d.referralCount || []).forEach(([inv, n]) => referralCount.set(inv, n));
  userFish.clear(); (d.userFish || []).forEach(([uid, arr]) => userFish.set(uid, arr));
  userInventory.clear(); (d.userInventory || []).forEach(([uid, arr]) => userInventory.set(uid, arr));
  mail.clear(); (d.mail || []).forEach(([uid, arr]) => mail.set(uid, arr));
  news.length = 0; (d.news || []).forEach(n => news.push(n));
  videos.clear(); (d.videos || []).forEach(([id, v]) => videos.set(id, v));
  nextVideoId = d.nextVideoId || 1;
  auction.clear(); (d.auction || []).forEach(([id, a]) => auction.set(id, a));
  nextAuctionId = d.nextAuctionId || 1;
  userProfiles.clear(); (d.userProfiles || []).forEach(([uid, p]) => userProfiles.set(uid, p));
  fishingCooldown.clear(); (d.fishingCooldown || []).forEach(([uid, t]) => fishingCooldown.set(uid, t));
  userTasksClaimed.clear(); (d.userTasksClaimed || []).forEach(([uid, arr]) => userTasksClaimed.set(uid, new Set(arr)));
  userInvested.clear(); (d.userInvested || []).forEach(([uid, n]) => userInvested.set(uid, n));
  userCompletedOrders.clear(); (d.userCompletedOrders || []).forEach(([uid, n]) => userCompletedOrders.set(uid, n));
  paymentClaims.clear(); (d.paymentClaims || []).forEach(([uid, c]) => paymentClaims.set(uid, c));
  manualCredits.length = 0; (d.manualCredits || []).forEach(c => manualCredits.push(c));
  userInfos.clear(); (d.userInfos || []).forEach(([uid, info]) => userInfos.set(uid, info));
  deniedClaims.clear(); (d.deniedClaims || []).forEach(([uid, n]) => deniedClaims.set(uid, n));
}

function saveState() {
  try {
    const data = {
      nextOrderId, orders: [...orders.entries()],
      userStars: [...userStars.entries()], userCoins: [...userCoins.entries()],
      userLang: [...userLang.entries()],
      ownedTitles: [...ownedTitles.entries()].map(([uid, set]) => [uid, [...set]]),
      activeTitle: [...activeTitle.entries()],
      agreed: [...agreed], banned: [...banned], restricted: [...restricted],
      admins: [...admins], users: [...users],
      transactions: transactions.slice(-2000),
      referrals: [...referrals.entries()].map(([inv, set]) => [inv, [...set]]),
      invitedBy: [...invitedBy.entries()], referralCount: [...referralCount.entries()],
      userFish: [...userFish.entries()], userInventory: [...userInventory.entries()],
      mail: [...mail.entries()], news: news.slice(-100),
      videos: [...videos.entries()], nextVideoId,
      auction: [...auction.entries()], nextAuctionId,
      userProfiles: [...userProfiles.entries()],
      fishingCooldown: [...fishingCooldown.entries()],
      userTasksClaimed: [...userTasksClaimed.entries()].map(([uid, set]) => [uid, [...set]]),
      userInvested: [...userInvested.entries()],
      userCompletedOrders: [...userCompletedOrders.entries()],
      paymentClaims: [...paymentClaims.entries()],
      manualCredits: manualCredits.slice(-500),
      userInfos: [...userInfos.entries()],
      deniedClaims: [...deniedClaims.entries()],
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(data));
  } catch (e) { console.error('State save error:', e.message); }
}
// ========== GitHub Gist Persistent Storage ==========
async function syncToGist() {
  if (!GIST_ID || !GITHUB_TOKEN || gistSyncProcessing) return;
  gistSyncProcessing = true;
  try {
    await doSyncToGist(GIST_ID, GIST_FILENAME);
  } finally {
    gistSyncProcessing = false;
  }
}

// === СЛОЙ 4: Второй GitHub Gist (резервный) ===
let gist2SyncProcessing = false;
async function syncToGist2() {
  if (!GIST2_ID || !GITHUB_TOKEN || gist2SyncProcessing) return;
  gist2SyncProcessing = true;
  try {
    await doSyncToGist(GIST2_ID, GIST_FILENAME);
    console.log('☁️ Данные синхронизированы со ВТОРЫМ GitHub Gist (резерв)');
  } catch (e) {
    console.error('Gist2 sync error:', e.message);
  } finally {
    gist2SyncProcessing = false;
  }
}

async function doSyncToGist(gistId, filename) {
  try {
    const data = {
      nextOrderId, orders: [...orders.entries()],
      userStars: [...userStars.entries()], userCoins: [...userCoins.entries()],
      userLang: [...userLang.entries()],
      ownedTitles: [...ownedTitles.entries()].map(([uid, set]) => [uid, [...set]]),
      activeTitle: [...activeTitle.entries()],
      agreed: [...agreed], banned: [...banned], restricted: [...restricted],
      admins: [...admins], users: [...users],
      transactions: transactions.slice(-2000),
      referrals: [...referrals.entries()].map(([inv, set]) => [inv, [...set]]),
      invitedBy: [...invitedBy.entries()], referralCount: [...referralCount.entries()],
      userFish: [...userFish.entries()], userInventory: [...userInventory.entries()],
      mail: [...mail.entries()], news: news.slice(-100),
      videos: [...videos.entries()], nextVideoId,
      auction: [...auction.entries()], nextAuctionId,
      userProfiles: [...userProfiles.entries()],
      fishingCooldown: [...fishingCooldown.entries()],
      userTasksClaimed: [...userTasksClaimed.entries()].map(([uid, set]) => [uid, [...set]]),
      userInvested: [...userInvested.entries()],
      userCompletedOrders: [...userCompletedOrders.entries()],
      paymentClaims: [...paymentClaims.entries()],
      manualCredits: manualCredits.slice(-500),
      userInfos: [...userInfos.entries()],
      deniedClaims: [...deniedClaims.entries()],
      _syncedAt: Date.now(),
    };
    const apiUrl = `https://api.github.com/gists/${gistId}`;
    const response = await fetch(apiUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: { [filename]: { content: JSON.stringify(data) } }
      }),
    });
    if (!response.ok) {
      const err = await response.text();
      console.error('Gist sync failed:', response.status, err);
    } else {
      console.log('☁️ Данные синхронизированы с GitHub Gist');
    }
  } catch (e) {
    console.error('Gist sync error:', e.message);
  } finally {
    gistSyncProcessing = false;
  }
}

async function loadFromGist() {
  if (!GIST_ID || !GITHUB_TOKEN) return false;
  try {
    const response = await fetch(GIST_API_URL, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    });
    if (!response.ok) return false;
    const gist = await response.json();
    const content = gist.files?.[GIST_FILENAME]?.content;
    if (!content) return false;
    const data = JSON.parse(content);
    // Загружаем данные в память
    nextOrderId = data.nextOrderId || 1;
    orders.clear(); (data.orders || []).forEach(([k, v]) => orders.set(k, v));
    userStars.clear(); (data.userStars || []).forEach(([k, v]) => userStars.set(k, v));
    userCoins.clear(); (data.userCoins || []).forEach(([k, v]) => userCoins.set(k, v));
    userLang.clear(); (data.userLang || []).forEach(([k, v]) => userLang.set(k, v));
    ownedTitles.clear(); (data.ownedTitles || []).forEach(([uid, arr]) => ownedTitles.set(uid, new Set(arr)));
    activeTitle.clear(); (data.activeTitle || []).forEach(([k, v]) => activeTitle.set(k, v));
    agreed.clear(); (data.agreed || []).forEach(k => agreed.add(k));
    banned.clear(); (data.banned || []).forEach(k => banned.add(k));
    restricted.clear(); (data.restricted || []).forEach(k => restricted.add(k));
    admins.clear(); (data.admins || []).forEach(k => admins.add(k));
    users.clear(); (data.users || []).forEach(k => users.add(k));
    transactions.length = 0; (data.transactions || []).forEach(t => transactions.push(t));
    referrals.clear(); (data.referrals || []).forEach(([inv, arr]) => referrals.set(inv, new Set(arr)));
    invitedBy.clear(); (data.invitedBy || []).forEach(([k, v]) => invitedBy.set(k, v));
    referralCount.clear(); (data.referralCount || []).forEach(([k, v]) => referralCount.set(k, v));
    userFish.clear(); (data.userFish || []).forEach(([k, v]) => userFish.set(k, v));
    userInventory.clear(); (data.userInventory || []).forEach(([k, v]) => userInventory.set(k, v));
    mail.clear(); (data.mail || []).forEach(([k, v]) => mail.set(k, v));
    news.length = 0; (data.news || []).forEach(n => news.push(n));
    videos.clear(); (data.videos || []).forEach(([k, v]) => videos.set(k, v));
    nextVideoId = data.nextVideoId || 1;
    auction.clear(); (data.auction || []).forEach(([k, v]) => auction.set(k, v));
    nextAuctionId = data.nextAuctionId || 1;
    userProfiles.clear(); (data.userProfiles || []).forEach(([k, v]) => userProfiles.set(k, v));
    fishingCooldown.clear(); (data.fishingCooldown || []).forEach(([k, v]) => fishingCooldown.set(k, v));
    userTasksClaimed.clear(); (data.userTasksClaimed || []).forEach(([uid, arr]) => userTasksClaimed.set(uid, new Set(arr)));
    userInvested.clear(); (data.userInvested || []).forEach(([k, v]) => userInvested.set(k, v));
    userCompletedOrders.clear(); (data.userCompletedOrders || []).forEach(([k, v]) => userCompletedOrders.set(k, v));
    paymentClaims.clear(); (data.paymentClaims || []).forEach(([k, v]) => paymentClaims.set(k, v));
    manualCredits.length = 0; (data.manualCredits || []).forEach(c => manualCredits.push(c));
    userInfos.clear(); (data.userInfos || []).forEach(([k, v]) => userInfos.set(k, v));
    deniedClaims.clear(); (data.deniedClaims || []).forEach(([k, v]) => deniedClaims.set(k, v));
    console.log('☁️ Данные загружены из GitHub Gist');
    return true;
  } catch (e) {
    console.error('Gist load error:', e.message);
    return false;
  }
}

// Авто-синхронизация каждые 5 минут (основной Gist)
setInterval(syncToGist, GIST_SYNC_INTERVAL);

// Авто-синхронизация каждые 10 минут (резервный Gist - СЛОЙ 4)
if (process.env.GIST2_ID) {
  setInterval(syncToGist2, 10 * 60 * 1000);
  console.log('☁️ Резервный Gist синхронизация включена (каждые 10 мин)');
}

function getStars(uid) { return userStars.get(String(uid)) || 0; }
function addStars(uid, n) { userStars.set(String(uid), getStars(uid) + n); scheduleSaveState(); }
function getCoins(uid) { return userCoins.get(String(uid)) || 0; }
function addCoins(uid, n) { userCoins.set(String(uid), getCoins(uid) + n); scheduleSaveState(); }
function isAdmin(uid) { return admins.has(String(uid)); }
function isMainAdmin(uid) { return String(uid) === MAIN_ADMIN; }
function isBanned(uid) { return banned.has(String(uid)); }
function isRestricted(uid) { return restricted.has(String(uid)); }
function genId() { const id = nextOrderId++; scheduleSaveState(); return id; }
function getFish(uid) { return userFish.get(String(uid)) || []; }
function addFish(uid, fish) { const f = getFish(uid); f.push(fish); userFish.set(String(uid), f); scheduleSaveState(); }
function getInventory(uid) { return userInventory.get(String(uid)) || []; }
function addItem(uid, item) { const inv = getInventory(uid); inv.push(item); userInventory.set(String(uid), inv); scheduleSaveState(); }
function getMail(uid) { return mail.get(String(uid)) || []; }
function addMail(uid, msg) { const m = getMail(uid); m.push(msg); mail.set(String(uid), m); scheduleSaveState(); }
function getProfile(uid) { if (!userProfiles.has(String(uid))) userProfiles.set(String(uid), { bio: '', avatar: '' }); return userProfiles.get(String(uid)); }
function incCompletedOrders(uid) { userCompletedOrders.set(String(uid), (userCompletedOrders.get(String(uid)) || 0) + 1); scheduleSaveState(); }
function addInvested(uid, n) { userInvested.set(String(uid), (userInvested.get(String(uid)) || 0) + n); scheduleSaveState(); }

let BOT_USERNAME = null;

async function ensureBotInfo() {
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username;
    console.log('🤖 Бот: @' + BOT_USERNAME);
  } catch (e) {
    console.error('Не удалось получить информацию о боте: ' + (e && e.message ? e.message : String(e)));
  }
}

function orderLink(id) {
  return BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=order_${id}` : `Заказ #${id}`;
}
function referralLink(uid) {
  return BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=ref_${uid}` : `ref_${uid}`;
}

async function editMsg(ctx, text, markup) {
  try {
    if (ctx.callbackQuery && ctx.callbackQuery.message) {
      await ctx.editMessageText(text, markup || {});
      return;
    }
  } catch (e) {}
  await ctx.reply(text, markup || {});
}

async function editPrompt(uid, text, markup) {
  const st = userState.get(uid);
  if (st && st.promptMsgId && st.chatId) {
    try {
      await bot.telegram.editMessageText(st.chatId, st.promptMsgId, undefined, text, markup || {});
      return;
    } catch (e) {}
  }
  await bot.telegram.sendMessage(uid, text, markup || {});
}

function mainMenu(uid) {
  const rows = [
    [Markup.button.callback(t(uid, 'order'), 'order_create'), Markup.button.callback(t(uid, 'execute'), 'order_list')],
    [Markup.button.callback(t(uid, 'shop'), 'shop'), Markup.button.callback(t(uid, 'tasks'), 'tasks')],
    [Markup.button.callback('🎣 Рыбалка', 'fishing'), Markup.button.callback('📦 Инвентарь', 'fish_inventory')],
    [Markup.button.callback('💰 Аукцион', 'auction_list'), Markup.button.callback('🛒 Интернет', 'internet')],
    [Markup.button.callback('📰 Новости', 'news'), Markup.button.callback('💰 Донат', 'donate')],
    [Markup.button.callback('📧 Почта', 'mail'), Markup.button.callback('👤 Профиль', 'profile')],
    [Markup.button.callback('🏆 Рейтинг', 'rating'), Markup.button.callback('🎁 Подарки', 'gifts')],
    [Markup.button.callback(t(uid, 'balance'), 'balance'), Markup.button.callback(t(uid, 'topup'), 'topup_help')],
    [Markup.button.callback('💳 Я оплатил в канале', 'paid_claim')],
    [Markup.button.callback(t(uid, 'suggest'), 'suggest_idea'), Markup.button.callback(t(uid, 'agreement'), 'show_agreement')],
    [Markup.button.callback(t(uid, 'lang'), 'lang_switch')],
  ];
  if (isAdmin(uid)) rows.push([Markup.button.callback(t(uid, 'admin'), 'admin_panel')]);
  return Markup.inlineKeyboard(rows);
}

function menuText(uid) {
  const title = activeTitle.get(String(uid));
  const titleStr = title ? ` [${title}]` : '';
  return `${t(uid, 'menu')}${titleStr}\n${t(uid, 'stars')}: ${getStars(uid)} ⭐\n${t(uid, 'coins')}: ${getCoins(uid)} 🪙\n${t(uid, 'choose')}`;
}

function backKeyboard(uid) {
  return Markup.inlineKeyboard([[Markup.button.callback(t(uid, 'back'), 'back_main')]]);
}

bot.start(async (ctx) => {
  const uid = ctx.from ? ctx.from.id : null;
  if (!uid) return;
  try {
    const text = ctx.message ? (ctx.message.text || '') : '';
    // Автопинг от самого бота — не отвечаем, просто сохраняем пользователя
    if (uid === Number(MAIN_ADMIN) && (text === '/start autiking' || text === '🔄 Автопинг системы (keep-alive)')) {
      users.add(String(uid));
      saveState();
      return;
    }
    users.add(String(uid));
    const info = userInfos.get(String(uid)) || { firstSeen: Date.now() };
    if (ctx.from.username) info.username = ctx.from.username;
    info.name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ');
    userInfos.set(String(uid), info);
    saveState();
    if (isBanned(uid)) { await ctx.reply('🚫 Вы забанены. / You are banned.'); return; }
    if (!agreed.has(String(uid))) {
      await ctx.reply(AGREEMENT, Markup.inlineKeyboard([[Markup.button.callback('✅ Принимаю / Accept', 'agree_yes'), Markup.button.callback('❌ Отказываюсь / Decline', 'agree_no')]]));
      return;
    }
    const payload = (ctx.startPayload || '').toString();
    if (payload.startsWith('ref_')) {
      const inviter = payload.split('_')[1];
      if (inviter && inviter !== String(uid) && !invitedBy.has(String(uid)) && /^\d+$/.test(inviter)) {
        invitedBy.set(String(uid), inviter);
        if (!referrals.has(inviter)) referrals.set(inviter, new Set());
        referrals.get(inviter).add(String(uid));
        referralCount.set(inviter, (referralCount.get(inviter) || 0) + 1);
        addCoins(inviter, 1);
        saveState();
        try { await bot.telegram.sendMessage(inviter, `🎉 Новый приглашённый! +1 🪙\nВсего приглашено: ${referralCount.get(inviter)}`); } catch (e) {}
      }
    }
    if (payload.startsWith('order_')) {
      const id = parseInt(payload.split('_')[1]);
      const order = orders.get(id);
      if (!order) { await ctx.reply('❌ Заказ не найден. / Order not found.', mainMenu(uid)); return; }
      let text = `📋 Заказ #${order.id}\n\n${order.description}\n\n${order.currency === 'coins' ? '🪙' : '⭐'} ${order.amount}\nСтатус: ${order.status}`;
      const kb = order.status === 'open'
        ? Markup.inlineKeyboard([[Markup.button.callback('⚡ Взять заказ / Take', `take_${order.id}`)], [Markup.button.callback(t(uid, 'back'), 'back_main')]])
        : mainMenu(uid);
      await ctx.reply(text, kb);
      return;
    }
    await ctx.reply(menuText(uid), mainMenu(uid));
  } catch (e) {
    logError('bot.start error: ' + (e && e.stack ? e.stack : String(e)));
    try { await ctx.reply('⚠️ Внутренняя ошибка при запуске. Попробуйте позже. / Internal error on start.'); } catch (err) {}
  }
});

bot.action('agree_yes', async (ctx) => {
  await ctx.answerCbQuery();
  agreed.add(String(ctx.from.id));
  saveState();
  await editMsg(ctx, menuText(ctx.from.id), mainMenu(ctx.from.id));
});
bot.action('agree_no', async (ctx) => {
  await ctx.answerCbQuery();
  await editMsg(ctx, '❌ Без принятия соглашения бот недоступен. / Agreement required.', Markup.inlineKeyboard([]));
});
bot.action('show_agreement', async (ctx) => {
  await ctx.answerCbQuery();
  await editMsg(ctx, AGREEMENT, Markup.inlineKeyboard([[Markup.button.callback(t(ctx.from.id, 'back'), 'back_main')]]));
});
bot.action('topup_help', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const text = '💳 Пополнение баланса (⭐ звёзды — игровая валюта бота)\n\n1️⃣ Переведи реальные Telegram Stars в канал платежей\n2️⃣ Вернись в бота и нажми «💳 Я оплатил в канале»\n3️⃣ Администрация проверит и начислит баланс\n\n⏱️ Зачисление после подтверждения.\n\nTop up your in-bot game stars via the payment channel.';
  const kb = Markup.inlineKeyboard([
    [Markup.button.url('⭐ Перевести звёзды', 'https://t.me/stars_povelitel')],
    [Markup.button.callback('💳 Я оплатил в канале', 'paid_claim')],
    [Markup.button.callback(t(uid, 'back'), 'back_main')],
  ]);
  await editMsg(ctx, text, kb);
});
bot.action('lang_switch', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const newLang = getLang(uid) === 'ru' ? 'en' : 'ru';
  setLang(uid, newLang);
  await editMsg(ctx, menuText(uid), mainMenu(uid));
});
bot.action('suggest_idea', async (ctx) => {
  await ctx.answerCbQuery();
  await editMsg(ctx, `💡 Предложить идею / Suggest an idea\n\nСтоимость: 10 ⭐\nОткрой: ${HELPER_LINK}\n\nНапиши свою идею и мнение — мы рассмотрим!`, Markup.inlineKeyboard([[Markup.button.url('Открыть / Open', HELPER_LINK)], [Markup.button.callback(t(ctx.from.id, 'back'), 'back_main')]]));
});
bot.action('balance', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  await editMsg(ctx, `💰 ${t(uid, 'balance')}: ${getStars(uid)} ⭐\n🪙 ${t(uid, 'coins')}: ${getCoins(uid)}\n\nПополнить реально: /pay <сумма> / Top up: /pay <amount>`, mainMenu(uid));
});

bot.action('profile', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  const title = activeTitle.get(String(uid)) || 'Нет титула';
  const fishCount = getFish(uid).length;
  const videoCount = [...videos.values()].filter(v => v.creatorId === String(uid)).length;
  await editMsg(ctx, `👤 Профиль / Profile\n\nID: ${uid}\n⭐ Звёзды: ${getStars(uid)}\n🪙 Монеты: ${getCoins(uid)}\n🏷️ Титул: ${title}\n🎣 Рыб поймано: ${fishCount}\n📺 Видео: ${videoCount}\n🤝 Приглашено: ${referralCount.get(String(uid)) || 0}`, Markup.inlineKeyboard([[Markup.button.callback('🔍 Посмотреть профиль другого / View other', 'profile_view_other')], [Markup.button.callback(t(uid, 'back'), 'back_main')]]));
});

bot.action('profile_view_other', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  userState.set(uid, { mode: 'profile_view', promptMsgId: ctx.callbackQuery.message.message_id, chatId: ctx.callbackQuery.message.chat.id });
  await editMsg(ctx, '🔍 Введи ID пользователя: / Enter user ID:', backKeyboard(uid));
});

bot.action(/^profile_view_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const target = ctx.match[1];
  if (target === MAIN_ADMIN) { await editMsg(ctx, '🔒 Профиль администратора скрыт. / Admin profile hidden.', backKeyboard(uid)); return; }
  if (!users.has(target)) { await editMsg(ctx, '❌ Пользователь не найден. / User not found.', backKeyboard(uid)); return; }
  if (isBanned(target)) { await editMsg(ctx, '🚫 Этот пользователь забанен. / User is banned.', backKeyboard(uid)); return; }
  const info = userInfos.get(target) || {};
  const uname = info.username ? `@${info.username}` : '—';
  const title = activeTitle.get(target) || 'Нет титула';
  const fishCount = getFish(target).length;
  const videoCount = [...videos.values()].filter(v => v.creatorId === target).length;
  await editMsg(ctx, `👤 Профиль #${target} ${uname}\n\n⭐ Звёзды: ${getStars(target)}\n🪙 Монеты: ${getCoins(target)}\n🏷️ Титул: ${title}\n🎣 Рыб: ${fishCount}\n📺 Видео: ${videoCount}\n🤝 Приглашено: ${referralCount.get(target) || 0}`, Markup.inlineKeyboard([
    [Markup.button.callback('💰 Донатить / Donate', `donate_to_${target}`)],
    [Markup.button.callback(t(uid, 'back'), 'back_main')],
  ]));
});

bot.action('rating', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  
  const top = [...users].map(u => ({
    id: u,
    name: userInfos.get(u)?.name || userInfos.get(u)?.username || 'Unknown',
    username: userInfos.get(u)?.username || '',
    referrals: referralCount.get(u) || 0,
    stars: getStars(u),
    coins: getCoins(u),
    completed: userCompletedOrders.get(u) || 0,
  })).sort((a, b) => b.referrals - a.referrals).slice(0, 20);
  
  let text = '🏆 ТОП-20 по приглашениям / Referral Leaderboard:\n\n';
  top.forEach((u, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    const isMe = u.id === String(uid) ? ' ← ТЫ' : '';
    text += `${medal} ${u.name} (@${u.username || 'no_username'}) — 🤝 ${u.referrals} | ⭐ ${u.stars} | 🪙 ${u.coins} | ✅ ${u.completed}${isMe}\n`;
  });
  
  const myRank = [...users].map(u => u).sort((a, b) => (referralCount.get(b) || 0) - (referralCount.get(a) || 0)).findIndex(u => u === String(uid)) + 1;
  text += `\n📍 Твоя позиция: ${myRank > 0 ? myRank : 'не в топе'}`;
  
  await editMsg(ctx, text, Markup.inlineKeyboard([[Markup.button.callback(t(uid, 'back'), 'back_main')]]));
});

bot.action('gifts', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  
  let text = '🎁 Подарки за активность / Activity Gifts:\n\n';
  text += '🏆 ТОП-1 по рефералам за месяц — 🎁 Telegram Gift + 100 ⭐\n';
  text += '🥈 ТОП-2-3 по рефералам — 50 ⭐\n';
  text += '🥉 ТОП-4-10 по рефералам — 20 ⭐\n\n';
  text += '🎯 За выполнение заданий:\n';
  text += '• 10 выполненных заказов — 10 ⭐\n';
  text += '• 50 выполненных заказов — 50 ⭐\n';
  text += '• 100 выполненных заказов — 100 ⭐ + титул "Легенда"\n\n';
  text += '🎣 За рыбалку:\n';
  text += '• Поймать "Золотую рыбку" — 25 ⭐\n';
  text += '• Поймать "Левиафана" — 50 ⭐\n\n';
  text += 'Награды выдаются автоматически при достижении целей! / Rewards auto-granted on achievement.';
  
  await editMsg(ctx, text, Markup.inlineKeyboard([[Markup.button.callback(t(uid, 'back'), 'back_main')]]));
});

function tasksText(uid) {
  const claimed = userTasksClaimed.get(String(uid)) || new Set();
  let text = '🎯 Задания / Tasks\n\n';
  TASKS.forEach(task => {
    const done = task.check(uid);
    const isClaimed = claimed.has(task.id);
    text += `${isClaimed ? '✅' : done ? '🎁' : '⬜'} ${getLang(uid) === 'ru' ? task.ru : task.en} — +${task.reward} 🪙\n`;
  });
  text += `\n🤝 Приглашено: ${referralCount.get(String(uid)) || 0}\n🔗 ${referralLink(uid)}`;
  return text;
}
function tasksKeyboard(uid) {
  const claimed = userTasksClaimed.get(String(uid)) || new Set();
  const rows = [];
  TASKS.forEach(task => {
    const done = task.check(uid);
    if (done && !claimed.has(task.id)) rows.push([Markup.button.callback(`🎁 Забрать: ${getLang(uid) === 'ru' ? task.ru : task.en}`, `claim_task_${task.id}`)]);
  });
  rows.push([Markup.button.url('🔗 Пригласить друга / Invite friend', referralLink(uid))]);
  rows.push([Markup.button.callback(t(uid, 'back'), 'back_main')]);
  return Markup.inlineKeyboard(rows);
}
bot.action('tasks', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  await editMsg(ctx, tasksText(uid), tasksKeyboard(uid));
});
bot.action(/^claim_task_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const taskId = ctx.match[1];
  const task = TASKS.find(t => t.id === taskId);
  if (!task || !task.check(uid)) { await editMsg(ctx, tasksText(uid), tasksKeyboard(uid)); return; }
  const claimed = userTasksClaimed.get(String(uid)) || new Set();
  if (claimed.has(taskId)) { await editMsg(ctx, tasksText(uid), tasksKeyboard(uid)); return; }
  claimed.add(taskId);
  userTasksClaimed.set(String(uid), claimed);
  addCoins(uid, task.reward);
  saveState();
  await editMsg(ctx, `✅ Получено +${task.reward} 🪙 за "${getLang(uid) === 'ru' ? task.ru : task.en}"!\n\n` + tasksText(uid), tasksKeyboard(uid));
});

bot.action('shop', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  const buttons = TITLES.map(tl => [Markup.button.callback(`${tl.name} — ${tl.price} 🪙`, `buy_title_${tl.id}`)]);
  buttons.push([Markup.button.callback(t(uid, 'back'), 'back_main')]);
  let text = `🛒 Магазин титулов / Titles shop\n\nТвои монеты: ${getCoins(uid)} 🪙\n\n`;
  TITLES.forEach(tl => { text += `${tl.name} (${tl.en}) — ${tl.price} 🪙\n`; });
  const owned = ownedTitles.get(String(uid)) || new Set();
  if (owned.size) text += `\nТвои титулы: ${[...owned].join(', ')}`;
  await editMsg(ctx, text, Markup.inlineKeyboard(buttons));
});
bot.action(/^buy_title_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const titleId = ctx.match[1];
  const title = TITLES.find(t => t.id === titleId);
  if (!title) { await editMsg(ctx, '❌ Титул не найден. / Title not found.', backKeyboard(uid)); return; }
  const owned = ownedTitles.get(String(uid)) || new Set();
  if (owned.has(titleId)) { await editMsg(ctx, '✅ У тебя уже есть этот титул. / You already own this title.', backKeyboard(uid)); return; }
  if (getCoins(uid) < title.price) { await editMsg(ctx, `❌ Недостаточно монет. Нужно ${title.price} 🪙, у тебя ${getCoins(uid)}.`, backKeyboard(uid)); return; }
  addCoins(uid, -title.price);
  owned.add(titleId);
  ownedTitles.set(String(uid), owned);
  activeTitle.set(String(uid), title.name);
  saveState();
  await editMsg(ctx, `✅ Куплен титул: ${title.name}! / Purchased: ${title.name}!`, mainMenu(uid));
});

bot.action('order_create', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (!agreed.has(String(uid))) { await editMsg(ctx, AGREEMENT, Markup.inlineKeyboard([[Markup.button.callback('✅ Принимаю / Accept', 'agree_yes'), Markup.button.callback('❌ Отказываюсь / Decline', 'agree_no')]])); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены в создании заказов. / Restricted.', mainMenu(uid)); return; }
  userState.set(uid, { mode: 'create_desc', promptMsgId: ctx.callbackQuery.message.message_id, chatId: ctx.callbackQuery.message.chat.id });
  await editMsg(ctx, '✏️ Опиши, что нужно сделать (текст заказа): / Describe the task:', backKeyboard(uid));
});

bot.action('order_list', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const open = [...orders.values()].filter(o => o.status === 'open');
  if (open.length === 0) { await editMsg(ctx, '📭 Нет открытых заказов. / No open orders.', mainMenu(uid)); return; }
  const buttons = open.map(o => [Markup.button.callback(`#${o.id} — ${o.currency === 'coins' ? '🪙' : '⭐'} ${o.amount} ${o.description.slice(0, 30)}`, `take_${o.id}`)]);
  buttons.push([Markup.button.callback(t(uid, 'back'), 'back_main')]);
  await editMsg(ctx, '⚡ Открытые заказы / Open orders:', Markup.inlineKeyboard(buttons));
});

bot.action(/^take_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const orderId = parseInt(ctx.match[1]);
  const order = orders.get(orderId);
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (!order || order.status !== 'open') { await editMsg(ctx, '❌ Заказ недоступен. / Order unavailable.', mainMenu(uid)); return; }
  if (order.creatorId === String(uid)) { await editMsg(ctx, '❌ Нельзя брать свой заказ. / Cannot take own order.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены в выполнении. / Restricted.', mainMenu(uid)); return; }
  order.status = 'taken';
  order.takerId = String(uid);
  userState.set(uid, { mode: 'submit', orderId, promptMsgId: ctx.callbackQuery.message.message_id, chatId: ctx.callbackQuery.message.chat.id });
  saveState();
  await editMsg(ctx, `✅ Взял заказ #${orderId}\n\n${order.description}\n\n${order.currency === 'coins' ? '🪙' : '⭐'} ${order.amount}\n🔗 ${orderLink(orderId)}\n\nОтправь результат (текст/фото/видео/файл): / Send result:`, backKeyboard(uid));
});

bot.action('back_main', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  await editMsg(ctx, menuText(uid), mainMenu(uid));
});

// ---- Fishing ----
bot.action('fishing', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  const last = fishingCooldown.get(String(uid)) || 0;
  const now = Date.now();
  if (now - last < FISH_COOLDOWN) {
    const remaining = Math.ceil((FISH_COOLDOWN - (now - last)) / 1000 / 60);
    await editMsg(ctx, `🎣 Рыбалка на кулдауне. Осталось ${remaining} мин.\nFishing on cooldown. ${remaining} min left.`, mainMenu(uid));
    return;
  }
  const fish = rollFish();
  fishingCooldown.set(String(uid), now);
  addFish(uid, fish);
  saveState();
  await editMsg(ctx, `🎣 Ты поймал: ${fish.emoji} ${fish.name} (${fish.rarity})!\nЦенность: ${fish.value} 🪙\n\nКД: 12 часов. / Cooldown: 12h.`, Markup.inlineKeyboard([
    [Markup.button.callback('📦 Инвентарь / Inventory', 'fish_inventory')],
    [Markup.button.callback('💰 Аукцион / Auction', 'auction_list')],
    [Markup.button.callback(t(uid, 'back'), 'back_main')],
  ]));
});

bot.action('fish_inventory', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  const fish = getFish(uid);
  if (fish.length === 0) { await editMsg(ctx, '📦 Инвентарь пуст. / Inventory empty.', mainMenu(uid)); return; }
  const counts = {};
  fish.forEach(f => { counts[f.name] = (counts[f.name] || 0) + 1; });
  let text = '📦 Твой улов / Your catch:\n\n';
  for (const [name, count] of Object.entries(counts)) {
    const f = fish.find(x => x.name === name);
    text += `${f.emoji} ${name} (${f.rarity}) x${count} — ${f.value} 🪙\n`;
  }
  await editMsg(ctx, text, Markup.inlineKeyboard([
    [Markup.button.callback('💰 Выставить на аукцион / Auction', 'auction_sell')],
    [Markup.button.callback(t(uid, 'back'), 'back_main')],
  ]));
});

bot.action('auction_list', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  const items = [...auction.values()].filter(a => a.status === 'open');
  if (items.length === 0) { await editMsg(ctx, '💰 Аукцион пуст. / Auction empty.', mainMenu(uid)); return; }
  const buttons = items.map(a => [Markup.button.callback(`#${a.id} ${a.fish.emoji} ${a.fish.name} — ${a.price}⭐`, `bid_${a.id}`)]);
  buttons.push([Markup.button.callback(t(uid, 'back'), 'back_main')]);
  await editMsg(ctx, '💰 Аукцион / Auction:', Markup.inlineKeyboard(buttons));
});

bot.action('auction_sell', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const fish = getFish(uid);
  if (fish.length === 0) { await editMsg(ctx, '❌ Нет рыбы для продажи. / No fish to sell.', mainMenu(uid)); return; }
  const rows = fish.map((f, i) => [Markup.button.callback(`${f.emoji} ${f.name} (${f.rarity})`, `sellfish_${i}`)]);
  rows.push([Markup.button.callback(t(uid, 'back'), 'back_main')]);
  userState.set(uid, { mode: 'auction_select', fish, promptMsgId: ctx.callbackQuery.message.message_id, chatId: ctx.callbackQuery.message.chat.id });
  await editMsg(ctx, '💰 Выбери рыбу для выставления на аукцион: / Choose fish to list:', Markup.inlineKeyboard(rows));
});

bot.action(/^sellfish_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const st = userState.get(uid);
  if (!st || st.mode !== 'auction_select') { await editMsg(ctx, menuText(uid), mainMenu(uid)); return; }
  const idx = parseInt(ctx.match[1]);
  const fish = st.fish[idx];
  if (!fish) { await editMsg(ctx, '❌ Рыба не найдена. / Fish not found.', mainMenu(uid)); return; }
  userState.set(uid, { mode: 'auction_price', fish, fishIndex: idx, fishList: st.fish, promptMsgId: ctx.callbackQuery.message.message_id, chatId: ctx.callbackQuery.message.chat.id });
  await editMsg(ctx, `💰 ${fish.emoji} ${fish.name}\nВведи цену в звёздах: / Enter price in stars:`, backKeyboard(uid));
});

bot.action(/^bid_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const id = parseInt(ctx.match[1]);
  const item = auction.get(id);
  if (!item || item.status !== 'open') { await editMsg(ctx, '❌ Лот недоступен. / Lot unavailable.', mainMenu(uid)); return; }
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  if (item.sellerId === String(uid)) { await editMsg(ctx, '❌ Нельзя купить свой лот. / Cannot buy own lot.', mainMenu(uid)); return; }
  if (getStars(uid) < item.price) { await editMsg(ctx, `❌ Недостаточно звёзд. Нужно ${item.price}⭐. / Not enough stars.`, mainMenu(uid)); return; }
  addStars(uid, -item.price);
  addCoins(item.sellerId, item.price);
  addFish(uid, item.fish);
  item.status = 'sold';
  item.buyerId = String(uid);
  saveState();
  await editMsg(ctx, `✅ Куплено: ${item.fish.emoji} ${item.fish.name} за ${item.price}⭐!\nПродавец получил ${item.price} 🪙`, mainMenu(uid));
  try { await bot.telegram.sendMessage(item.sellerId, `💰 Твоя рыба ${item.fish.emoji} ${item.fish.name} продана за ${item.price}⭐! Ты получил ${item.price} 🪙`); } catch (e) {}
});

bot.action('internet', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  await editMsg(ctx, '🛒 Интернет / Internet\n\nВыбери действие:', Markup.inlineKeyboard([
    [Markup.button.callback('📺 Смотреть видео / Watch', 'video_list')],
    [Markup.button.callback('🎬 Создать видео / Create', 'video_create')],
    [Markup.button.callback('🔍 Поиск / Search', 'video_search')],
    [Markup.button.callback(t(uid, 'back'), 'back_main')],
  ]));
});

bot.action('video_list', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  const list = [...videos.values()].sort((a, b) => (b.invested || 0) - (a.invested || 0)).slice(0, 15);
  if (list.length === 0) { await editMsg(ctx, '📺 Видео пока нет. / No videos yet.', mainMenu(uid)); return; }
  const buttons = list.map(v => [Markup.button.callback(`${v.title} (${v.invested || 0}🪙)`, `view_video_${v.id}`)]);
  buttons.push([Markup.button.callback(t(uid, 'back'), 'back_main')]);
  await editMsg(ctx, '📺 Рекомендации / Recommendations:', Markup.inlineKeyboard(buttons));
});

bot.action('video_create', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  userState.set(uid, { mode: 'video_title', promptMsgId: ctx.callbackQuery.message.message_id, chatId: ctx.callbackQuery.message.chat.id });
  await editMsg(ctx, '🎬 Введи название видео: / Enter video title:', backKeyboard(uid));
});

bot.action('video_search', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  userState.set(uid, { mode: 'video_search', promptMsgId: ctx.callbackQuery.message.message_id, chatId: ctx.callbackQuery.message.chat.id });
  await editMsg(ctx, '🔍 Введи название для поиска: / Enter search query:', backKeyboard(uid));
});

bot.action(/^view_video_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const id = parseInt(ctx.match[1]);
  const video = videos.get(id);
  if (!video) { await editMsg(ctx, '❌ Видео не найдено. / Video not found.', mainMenu(uid)); return; }
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('💰 Инвестировать / Invest', `invest_${id}`)],
    [Markup.button.callback('👤 Профиль автора / Author profile', `profile_view_${video.creatorId}`)],
    [Markup.button.callback(t(uid, 'back'), 'back_main')],
  ]);
  const caption = `📺 ${video.title}\n\nАвтор: ${video.creatorName}\nИнвестиций: ${video.invested || 0} 🪙\n\n${video.description || ''}`.slice(0, 1024);
  // Показываем реальный ролик, если он был загружен
  if (video.mediaFileId) {
    try {
      if (video.mediaType === 'photo') await ctx.replyWithPhoto(video.mediaFileId, { caption, reply_markup: kb });
      else if (video.mediaType === 'video') await ctx.replyWithVideo(video.mediaFileId, { caption, reply_markup: kb });
      else await ctx.replyWithDocument(video.mediaFileId, { caption, reply_markup: kb });
      return;
    } catch (e) {
      await ctx.reply(`⚠️ Не удалось загрузить ролик: ${e.message}\n\n${caption}`, kb);
      return;
    }
  }
  await editMsg(ctx, `📺 ${video.title}\n\nАвтор: ${video.creatorName}\nИнвестиций: ${video.invested || 0} 🪙\n\n${video.description || ''}\n\n⚠️ Ролька нет — только текст. / No file, text only.`, kb);
});

bot.action(/^invest_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const id = parseInt(ctx.match[1]);
  const video = videos.get(id);
  if (!video) { await editMsg(ctx, '❌ Видео не найдено. / Video not found.', mainMenu(uid)); return; }
  userState.set(uid, { mode: 'invest_amount', videoId: id, promptMsgId: ctx.callbackQuery.message.message_id, chatId: ctx.callbackQuery.message.chat.id });
  await editMsg(ctx, '💰 Сколько монет инвестировать? / How many coins to invest?', backKeyboard(uid));
});

bot.action('news', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  if (news.length === 0) { await editMsg(ctx, '📰 Новостей пока нет. / No news yet.', mainMenu(uid)); return; }
  let text = '📰 Новости / News:\n\n';
  news.slice(-10).reverse().forEach(n => { text += `📌 ${n.title}\n${n.text}\n— ${new Date(n.at).toLocaleDateString('ru-RU')}\n\n`; });
  await editMsg(ctx, text, mainMenu(uid));
});

bot.action('donate', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  userState.set(uid, { mode: 'donate_target', promptMsgId: ctx.callbackQuery.message.message_id, chatId: ctx.callbackQuery.message.chat.id });
  await editMsg(ctx, '💰 Введи ID пользователя для доната игровой валюты: / Enter user ID to donate coins:', backKeyboard(uid));
});

bot.action(/^donate_to_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const target = ctx.match[1];
  if (!users.has(target)) { await editMsg(ctx, '❌ Пользователь не найден. / User not found.', backKeyboard(uid)); return; }
  if (isBanned(target)) { await editMsg(ctx, '❌ Этот пользователь забанен. / User is banned.', backKeyboard(uid)); return; }
  if (isRestricted(target)) { await editMsg(ctx, '⛔ Этот пользователь ограничен. / User is restricted.', backKeyboard(uid)); return; }
  if (target === String(uid)) { await editMsg(ctx, '❌ Нельзя донатить себе. / Cannot donate to yourself.', backKeyboard(uid)); return; }
  userState.set(uid, { mode: 'donate_target', target });
  await ctx.reply(`💰 Сколько монет донатить пользователю ${target}? / How many coins to donate to ${target}?`);
});

bot.action('mail', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (isBanned(uid)) { await editMsg(ctx, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
  if (isRestricted(uid)) { await editMsg(ctx, '⛔ Вы ограничены. / Restricted.', mainMenu(uid)); return; }
  const messages = getMail(uid);
  if (messages.length === 0) { await editMsg(ctx, '📧 Почта пуста. / Mailbox empty.', mainMenu(uid)); return; }
  let text = '📧 Твоя почта / Your mail:\n\n';
  messages.slice(-20).reverse().forEach((m, i) => {
    text += `${i + 1}. ${m.text || 'Подарок'} ${m.gift ? `🎁 ${m.gift}` : ''}\n`;
    if (m.gift) { addCoins(uid, m.giftCoins || 0); if (m.giftTitle) { const owned = ownedTitles.get(String(uid)) || new Set(); owned.add(m.giftTitle); ownedTitles.set(String(uid), owned); } }
  });
  mail.set(String(uid), []);
  saveState();
  await editMsg(ctx, text, mainMenu(uid));
});

bot.action('admin_panel', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (!isAdmin(uid)) { await editMsg(ctx, '❌ Нет доступа. / No access.', mainMenu(uid)); return; }
  const totalOrders = orders.size;
  const openOrders = [...orders.values()].filter(o => o.status === 'open').length;
  const completedOrders = [...orders.values()].filter(o => o.status === 'completed').length;
  const totalUsers = users.size;
  const totalStars = [...userStars.values()].reduce((a, b) => a + b, 0);
  const totalCoins = [...userCoins.values()].reduce((a, b) => a + b, 0);
  const commissionEarned = [...orders.values()].filter(o => o.status === 'completed').reduce((a, o) => a + (o.commission || 0), 0);
  const text = `👑 АДМИН-ПАНЕЛЬ / ADMIN PANEL

📊 Статистика:
• Пользователей: ${totalUsers}
• Заказов: ${totalOrders} (открыто: ${openOrders}, выполнено: ${completedOrders})
• Звёзд на балансах: ${totalStars}⭐
• Монет: ${totalCoins} 🪙
 • Комиссия заработана: ${commissionEarned}⭐
 • Реальных пополнений: ${transactions.filter(t => t.type === 'topup').length}
 • Ручных начислений: ${manualCredits.length}
 • Ожидают заявки: ${paymentClaims.size}

 🔧 Действия:`;
  const rows = [
    [Markup.button.callback('📊 Все заказы / Orders', 'admin_orders')],
    [Markup.button.callback('👥 Пользователи / Users', 'admin_users')],
    [Markup.button.callback('🚫 Баны / Bans', 'admin_bans')],
    [Markup.button.callback('⛔ Ограничения / Restrict', 'admin_restrict')],
    [Markup.button.callback('💳 Пополнения / Topups', 'admin_topups')],
    [Markup.button.callback('💳 Заявки (канал) / Claims', 'admin_claims')],
    [Markup.button.callback('📰 Новости / News', 'admin_news')],
    [Markup.button.callback('📺 Видео / Videos', 'admin_videos')],
    [Markup.button.callback('👑 Управление админами / Admins', 'admin_manage')],
    [Markup.button.callback('🏆 Рейтинг / Leaderboard', 'admin_rating')],
    [Markup.button.callback('🎯 Задания / Tasks', 'admin_tasks')],
    [Markup.button.callback('🎁 Подарки / Gifts', 'admin_gifts')],
    [Markup.button.callback('📊 Статистика / Stats', 'admin_stats')],
    [Markup.button.callback('🔄 Система / System', 'admin_system')],
    [Markup.button.callback(t(uid, 'back'), 'back_main')],
  ];
  await editMsg(ctx, text, Markup.inlineKeyboard(rows));
});

bot.action('admin_orders', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const list = [...orders.values()].slice(-20).reverse();
  if (list.length === 0) { await editMsg(ctx, 'Нет заказов. / No orders.', backKeyboard(ctx.from.id)); return; }
  let text = '📋 Последние заказы / Recent orders:\n\n';
  for (const o of list) text += `#${o.id} ${o.status} | ${o.currency === 'coins' ? '🪙' : '⭐'} ${o.amount} | ${o.description.slice(0, 40)}\n🔗 ${orderLink(o.id)}\n\n`;
  const buttons = list.map(o => [Markup.button.callback(`🗑️ Удалить #${o.id}`, `del_order_${o.id}`)]);
  buttons.push([Markup.button.callback(t(ctx.from.id, 'back'), 'admin_panel')]);
  await editMsg(ctx, text, Markup.inlineKeyboard(buttons));
});

bot.action('admin_users', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const list = [];
  let text = `👥 Пользователи / Users: ${users.size}\n\n`;
  let i = 0;
  for (const u of users) {
    if (i++ > 50) break;
    const info = userInfos.get(u) || {};
    const uname = info.username ? `@${info.username}` : '—';
    const uname2 = u === MAIN_ADMIN ? '👑' : '';
    text += `${uname} (${u})${uname2} — ${getStars(u)}⭐ ${getCoins(u)}🪙 ${banned.has(u) ? '🚫' : ''} ${restricted.has(u) ? '⛔' : ''} ${admins.has(u) ? '👑' : ''}\n`;
    list.push([Markup.button.callback(`💰 Выдать ${u}`, `cred_user_${u}`)]);
  }
  list.push([Markup.button.callback(t(ctx.from.id, 'back'), 'admin_panel')]);
  await editMsg(ctx, text, Markup.inlineKeyboard(list));
});

bot.action(/^cred_user_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const uid = ctx.from.id;
  const target = ctx.match[1];
  userState.set(uid, { mode: 'cred_amount', target });
  await ctx.reply(`💰 Сколько ⭐ начислить пользователю ${target}?\nВведи число (например, 70).\nОтмена: /cancel`);
});

bot.action('admin_bans', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  await editMsg(ctx, '🚫 Управление банами / Bans:\n\n/ban <userId>\n/unban <userId>', backKeyboard(ctx.from.id));
});

bot.action('admin_restrict', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  await editMsg(ctx, '⛔ Ограничения / Restrictions:\n\n/restrict <userId>\n/unrestrict <userId>', backKeyboard(ctx.from.id));
});

bot.action('admin_topups', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const list = transactions.filter(t => t.type === 'topup').slice(-20).reverse();
  if (list.length === 0) { await editMsg(ctx, 'Пополнений пока нет. / No topups yet.', backKeyboard(ctx.from.id)); return; }
  let text = '💳 Последние пополнения / Recent topups:\n\n';
  for (const t of list) text += `${t.uid} +${t.amount}⭐ (${new Date(t.at).toLocaleString('ru-RU')})\n`;
  await editMsg(ctx, text, backKeyboard(ctx.from.id));
});

// ---- Ручные платежи через канал (заявки) ----
bot.action('paid_claim', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  if (paymentClaims.has(String(uid))) {
    await editMsg(ctx, '⏳ У тебя уже есть заявка на проверку. Администратор скоро рассмотрит её. / You already have a pending claim.', backKeyboard(uid));
    return;
  }
  paymentClaims.set(String(uid), { at: Date.now() });
  saveState();
  await editMsg(ctx, '✅ Заявка отправлена!\n\nАдминистратор проверит твои платежи в канале и начислит звёзды.\n\n📌 Как это работает:\n1. Ты платишь за сообщения в канале\n2. Жмёшь эту кнопку\n3. Админ проверяет и выдаёт звёзды\n\nClaim sent! The admin will verify your channel payments and credit your stars.', backKeyboard(uid));
  // Уведомляем всех админов
  for (const a of admins) {
    try {
      await bot.telegram.sendMessage(a, `💳 Новая заявка на ручное пополнение / New manual topup claim:\n\n👤 ${ctx.from.first_name || ''} ${ctx.from.last_name || ''}\n🆔 ${uid}\n🔗 t.me/${ctx.from.username || '—'}\n\n📺 Канал для проверки: https://t.me/stars_povelitel\n\nНачисли звёзды: /cred ${uid} <сумма>`, Markup.inlineKeyboard([[Markup.button.callback('✅ К заявкам / To claims', 'admin_claims')]]));
    } catch (e) {}
  }
});

bot.action('admin_claims', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const claims = [...paymentClaims.entries()];
  if (claims.length === 0) {
    let text = '💳 Заявок пока нет. / No claims yet.\n\nЧтобы начислить звёзды вручную: /cred <userId> <сумма> [заметка]';
    if (manualCredits.length) {
      text += '\n\n📜 Последние ручные начисления / Recent manual credits:\n';
      manualCredits.slice(-10).reverse().forEach(c => { text += `${c.uid} +${c.amount}⭐ (${c.note || '—'}) — ${new Date(c.at).toLocaleString('ru-RU')}\n`; });
    }
    await editMsg(ctx, text, backKeyboard(ctx.from.id));
    return;
  }
  let text = `💳 Заявки на ручное пополнение / Manual topup claims: ${claims.length}\n\n`;
  const buttons = [];
  claims.forEach(([u, c]) => {
    text += `👤 ${u} — ${new Date(c.at).toLocaleString('ru-RU')}\n`;
    buttons.push([Markup.button.callback(`✅ Выдать / Credit ${u}`, `claim_credit_${u}`), Markup.button.callback(`❌ Отклонить / Deny ${u}`, `claim_deny_${u}`)]);
  });
  if (manualCredits.length) {
    text += '\n📜 Последние ручные начисления / Recent manual credits:\n';
    manualCredits.slice(-5).reverse().forEach(c => { text += `${c.uid} +${c.amount}⭐ (${c.note || '—'})\n`; });
  }
  buttons.push([Markup.button.callback(t(ctx.from.id, 'back'), 'admin_panel')]);
  await editMsg(ctx, text, Markup.inlineKeyboard(buttons));
});

bot.action(/^claim_credit_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const target = ctx.match[1];
  if (isBanned(target)) { await editMsg(ctx, '🚫 Этот пользователь забанен. / User is banned.', backKeyboard(ctx.from.id)); return; }
  if (isRestricted(target)) { await editMsg(ctx, '⛔ Этот пользователь ограничен. / User is restricted.', backKeyboard(ctx.from.id)); return; }
  paymentClaims.delete(target);
  saveState();
  userState.set(ctx.from.id, { mode: 'cred_amount', target, note: 'Заявка из канала' });
  await ctx.reply(`💳 Сколько ⭐ начислить пользователю ${target}?\nВведи число (например, 70).\nОтмена: /cancel`);
});

bot.action(/^claim_deny_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const target = ctx.match[1];
  paymentClaims.delete(target);
  const denied = (deniedClaims.get(target) || 0) + 1;
  deniedClaims.set(target, denied);
  saveState();
  if (denied >= 2) {
    banned.add(target);
    saveState();
    try { await bot.telegram.sendMessage(target, '🚫 Ты забанен за ложные заявки об оплате. / You are banned for false payment claims.'); } catch (e) {}
    try { await bot.telegram.sendMessage(MAIN_ADMIN, `🚫 Пользователь ${target} забанен за повторные ложные заявки.`); } catch (e) {}
    await editMsg(ctx, `🚫 Пользователь ${target} забанен за повторные ложные заявки. / Banned.`, Markup.inlineKeyboard([[Markup.button.callback('💳 К заявкам / To claims', 'admin_claims')]]));
    return;
  }
  try { await bot.telegram.sendMessage(target, `❌ Заявка отклонена. Проверь, что все платежи в канале прошли.\n\n⚠️ Предупреждение ${denied}/2: повторная ложная заявка — бан. / Denied. Warning ${denied}/2: next false claim = BAN.`); } catch (e) {}
  await editMsg(ctx, `❌ Заявка пользователя ${target} отклонена. Предупреждение ${denied}/2. / Claim denied. Warning ${denied}/2.`, Markup.inlineKeyboard([[Markup.button.callback('💳 К заявкам / To claims', 'admin_claims')]]));
});

bot.command('cred', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const parts = ctx.message.text.split(/\s+/);
  const target = parts[1];
  const amount = parseInt(parts[2]);
  const note = parts.slice(3).join(' ') || 'Ручное начисление';
  if (!target || !amount || amount <= 0) { await ctx.reply('Использование: /cred <userId> <сумма> [заметка]\nПример: /cred 123456 70 7 сообщений в канале'); return; }
  if (isBanned(target)) { await ctx.reply('🚫 Этот пользователь забанен. / User is banned.'); return; }
  if (isRestricted(target)) { await ctx.reply('⛔ Этот пользователь ограничен. / User is restricted.'); return; }
  addStars(target, amount);
  manualCredits.push({ uid: String(target), amount, note, at: Date.now() });
  paymentClaims.delete(String(target));
  saveState();
  await ctx.reply(`✅ Начислено ${amount}⭐ пользователю ${target}.\n📝 ${note}`);
  try { await bot.telegram.sendMessage(target, `✅ Тебе начислено ${amount} ⭐\n📝 ${note}\n💰 Баланс: ${getStars(target)} ⭐`); } catch (e) {}
});

bot.action('admin_news', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const buttons = [
    [Markup.button.callback('➕ Создать новость / Create News', 'admin_news_create')],
    [Markup.button.callback('📢 Рассылка новости / Broadcast News', 'admin_news_broadcast')],
  ];
  if (news.length > 0) {
    news.slice(-20).reverse().forEach((n, i) => {
      buttons.push([Markup.button.callback(`🗑️ ${n.text.slice(0, 40)}`, `del_news_${i}`)]);
    });
  }
  buttons.push([Markup.button.callback(t(ctx.from.id, 'back'), 'admin_panel')]);
  let text = '📰 Новости / News:\n\n';
  if (news.length === 0) {
    text += 'Новостей пока нет. / No news yet.';
  } else {
    news.slice(-20).reverse().forEach((n, i) => { text += `${i + 1}. ${n.text}\n`; });
  }
  await editMsg(ctx, text, Markup.inlineKeyboard(buttons));
});

bot.action('admin_news_create', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const uid = ctx.from.id;
  userState.set(uid, { mode: 'news_create', promptMsgId: ctx.callbackQuery.message.message_id, chatId: ctx.callbackQuery.message.chat.id });
  await editMsg(ctx, '📝 Введи текст новости (макс. 2000 символов):\n\n/Enter news text (max 2000 chars):', backKeyboard(uid));
});

bot.action('admin_news_broadcast', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const uid = ctx.from.id;
  userState.set(uid, { mode: 'news_broadcast', promptMsgId: ctx.callbackQuery.message.message_id, chatId: ctx.callbackQuery.message.chat.id });
  await editMsg(ctx, '📢 Введи текст для рассылки ВСЕМ пользователям (макс. 2000 символов):\n\n/Enter text to broadcast to ALL users (max 2000 chars):', backKeyboard(uid));
});

bot.action(/^del_news_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const idx = parseInt(ctx.match[1]);
  const reversed = news.slice(-20).reverse();
  const target = reversed[idx];
  if (target) {
    const realIdx = news.length - 1 - idx;
    if (realIdx >= 0 && realIdx < news.length) news.splice(realIdx, 1);
    saveState();
  }
  await editMsg(ctx, '✅ Новость удалена. / News deleted.', Markup.inlineKeyboard([[Markup.button.callback('📰 Назад / Back', 'admin_news')]]));
});

bot.action('admin_videos', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const list = [...videos.values()].slice(-20).reverse();
  if (list.length === 0) { await editMsg(ctx, '📺 Видео нет. / No videos.', backKeyboard(ctx.from.id)); return; }
  const buttons = list.map(v => [Markup.button.callback(`🗑️ ${v.title}`, `del_video_${v.id}`)]);
  buttons.push([Markup.button.callback(t(ctx.from.id, 'back'), 'admin_panel')]);
  let text = '📺 Видео / Videos:\n\n';
  list.forEach(v => { text += `#${v.id} ${v.title} (${v.invested || 0}🪙) by ${v.creatorName}\n`; });
  await editMsg(ctx, text, Markup.inlineKeyboard(buttons));
});

bot.action(/^del_video_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const id = parseInt(ctx.match[1]);
  videos.delete(id);
  saveState();
  await editMsg(ctx, '✅ Видео удалено. / Video deleted.', Markup.inlineKeyboard([[Markup.button.callback('📺 Назад / Back', 'admin_videos')]]));
});

bot.action(/^del_order_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const id = parseInt(ctx.match[1]);
  orders.delete(id);
  saveState();
  await editMsg(ctx, '✅ Заказ удалён. / Order deleted.', Markup.inlineKeyboard([[Markup.button.callback('📋 Назад / Back', 'admin_orders')]]));
});

bot.action('admin_manage', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isMainAdmin(ctx.from.id)) { await editMsg(ctx, '❌ Только главный админ. / Main admin only.', backKeyboard(ctx.from.id)); return; }
  await editMsg(ctx, '👑 Управление админами / Admin management:\n\n/addadmin <userId>\n/removeadmin <userId>\n/listadmins', backKeyboard(ctx.from.id));
});

bot.action('admin_system', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const uptimeMin = Math.floor((Date.now() - BOT_START_TIME) / 1000 / 60);
  const mem = process.memoryUsage();
  const text = `🔄 Система / System\n\n⏱ Uptime: ${uptimeMin} мин\n👥 Пользователей: ${users.size}\n📦 Заказов: ${orders.size}\n💰 Звёзд на балансах: ${[...userStars.values()].reduce((a, b) => a + b, 0)}⭐\n🪙 Монет: ${[...userCoins.values()].reduce((a, b) => a + b, 0)}🪙\n💾 Память: ${Math.round(mem.heapUsed / 1024 / 1024)} MB\n📊 PID: ${process.pid}`;
  await editMsg(ctx, text, Markup.inlineKeyboard([[Markup.button.callback(t(ctx.from.id, 'back'), 'admin_panel')]]));
});

bot.action('admin_rating', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const top = [...users].map(u => ({
    id: u,
    name: userInfos.get(u)?.name || userInfos.get(u)?.username || 'Unknown',
    username: userInfos.get(u)?.username || '',
    referrals: referralCount.get(u) || 0,
    stars: getStars(u),
    coins: getCoins(u),
    completed: userCompletedOrders.get(u) || 0,
  })).sort((a, b) => b.referrals - a.referrals).slice(0, 20);
  
  let text = '🏆 ТОП-20 по приглашениям / Referral Leaderboard:\n\n';
  top.forEach((u, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
    text += `${medal} ${u.name} (@${u.username || 'no_username'}) — 🤝 ${u.referrals} | ⭐ ${u.stars} | 🪙 ${u.coins} | ✅ ${u.completed}\n`;
  });
  await editMsg(ctx, text, Markup.inlineKeyboard([[Markup.button.callback(t(ctx.from.id, 'back'), 'admin_panel')]]));
});

bot.action('admin_tasks', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  let text = '🎯 Управление заданиями / Tasks Management:\n\n';
  text += 'Текущие задания:\n';
  TASKS.forEach(t => {
    text += `• ${t.ru} / ${t.en} — 🪙 ${t.reward}\n`;
  });
  text += '\nКоманды:\n/addtask <id> <ru> <en> <reward> <type> <target>\n/deltask <id>';
  await editMsg(ctx, text, Markup.inlineKeyboard([[Markup.button.callback(t(ctx.from.id, 'back'), 'admin_panel')]]));
});

bot.action('admin_gifts', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  let text = '🎁 Управление подарками / Gifts Management:\n\n';
  text += 'Здесь можно настроить подарки за выполнение заказов, рефералов и т.д.\n';
  text += 'Функция в разработке. / Feature in development.';
  await editMsg(ctx, text, Markup.inlineKeyboard([[Markup.button.callback(t(ctx.from.id, 'back'), 'admin_panel')]]));
});

bot.action('admin_stats', async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx.from.id)) return;
  const totalUsers = users.size;
  const activeToday = [...users].filter(u => {
    const info = userInfos.get(u);
    return info && (Date.now() - (info.lastActive || info.firstSeen || 0)) < 86400000;
  }).length;
  const totalOrders = orders.size;
  const completedOrders = [...orders.values()].filter(o => o.status === 'completed').length;
  const totalStars = [...userStars.values()].reduce((a, b) => a + b, 0);
  const totalCoins = [...userCoins.values()].reduce((a, b) => a + b, 0);
  const totalReferrals = [...referralCount.values()].reduce((a, b) => a + b, 0);
  const bannedCount = banned.size;
  const restrictedCount = restricted.size;
  
  const text = `📊 Подробная статистика / Detailed Stats:\n\n` +
    `👥 Пользователи: ${totalUsers}\n` +
    `🟢 Активны за 24ч: ${activeToday}\n` +
    `🚫 Забанены: ${bannedCount}\n` +
    `⛔ Ограничены: ${restrictedCount}\n\n` +
    `📦 Заказы: ${totalOrders}\n` +
    `✅ Выполнено: ${completedOrders}\n` +
    `📈 Конверсия: ${totalOrders > 0 ? Math.round(completedOrders / totalOrders * 100) : 0}%\n\n` +
    `⭐ Звёзд на балансах: ${totalStars}\n` +
    `🪙 Монет: ${totalCoins}\n` +
    `🤝 Всего приглашений: ${totalReferrals}\n\n` +
    `📺 Видео: ${videos.size}\n` +
    `🎣 Рыб поймано: ${[...userFish.values()].reduce((a, b) => a + b.length, 0)}\n` +
    `📰 Новостей: ${news.length}`;
  await editMsg(ctx, text, Markup.inlineKeyboard([[Markup.button.callback(t(ctx.from.id, 'back'), 'admin_panel')]]));
});

// ---- Admin commands ----
async function handleAdminCommand(ctx, text) {
  const uid = ctx.from.id;
  if (!isAdmin(uid)) return;
  
  // Rate limit для админ-команд (макс 10 в минуту)
  const now = Date.now();
  const adminKey = `admin:${uid}`;
  let adminData = adminCommandCounts.get(adminKey);
  if (!adminData || now > adminData.resetTime) {
    adminData = { count: 0, resetTime: now + 60000 };
    adminCommandCounts.set(adminKey, adminData);
  }
  adminData.count++;
  if (adminData.count > 30) {
    await ctx.reply('❌ Слишком много админ-команд. Подождите минуту. / Too many admin commands.');
    return;
  }

  const parts = text.split(' ');
  const cmd = parts[0];
  
  // Валидация userId для команд с целью
  function validateTarget(target) {
    if (!target) return { ok: false, msg: 'Использование: <command> <userId>' };
    if (!/^\d+$/.test(target)) return { ok: false, msg: '❌ Неверный ID пользователя. / Invalid user ID.' };
    return { ok: true };
  }

  if (cmd === '/ban') {
    const v = validateTarget(parts[1]);
    if (!v.ok) { await ctx.reply(v.msg); return; }
    const target = parts[1];
    if (target === MAIN_ADMIN) { await ctx.reply('❌ Нельзя забанить главного админа.'); return; }
    banned.add(target); saveState();
    await ctx.reply(`🚫 Пользователь ${target} забанен. / Banned.`);
    try { await bot.telegram.sendMessage(target, '🚫 Вы забанены администратором. / You are banned.'); } catch (e) {}
  } else if (cmd === '/unban') {
    const v = validateTarget(parts[1]);
    if (!v.ok) { await ctx.reply(v.msg); return; }
    const target = parts[1];
    banned.delete(target); saveState();
    await ctx.reply(`✅ Пользователь ${target} разбанен. / Unbanned.`);
  } else if (cmd === '/restrict') {
    const v = validateTarget(parts[1]);
    if (!v.ok) { await ctx.reply(v.msg); return; }
    const target = parts[1];
    if (target === MAIN_ADMIN) { await ctx.reply('❌ Нельзя ограничить главного админа.'); return; }
    restricted.add(target); saveState();
    await ctx.reply(`⛔ Пользователь ${target} ограничен. / Restricted.`);
  } else if (cmd === '/unrestrict') {
    const v = validateTarget(parts[1]);
    if (!v.ok) { await ctx.reply(v.msg); return; }
    const target = parts[1];
    restricted.delete(target); saveState();
    await ctx.reply(`✅ Ограничение снято с ${target}. / Unrestricted.`);
  } else if (cmd === '/addadmin') {
    if (!isMainAdmin(uid)) { await ctx.reply('❌ Только главный админ. / Main admin only.'); return; }
    const v = validateTarget(parts[1]);
    if (!v.ok) { await ctx.reply(v.msg); return; }
    const target = parts[1];
    admins.add(target); saveState();
    await ctx.reply(`👑 ${target} теперь админ. / is admin now.`);
  } else if (cmd === '/removeadmin') {
    if (!isMainAdmin(uid)) { await ctx.reply('❌ Только главный админ. / Main admin only.'); return; }
    const v = validateTarget(parts[1]);
    if (!v.ok) { await ctx.reply(v.msg); return; }
    const target = parts[1];
    if (target === MAIN_ADMIN) { await ctx.reply('❌ Нельзя удалить главного админа. / Cannot remove main admin.'); return; }
    admins.delete(target); saveState();
    await ctx.reply(`✅ ${target} больше не админ. / No longer admin.`);
  } else if (cmd === '/listadmins') {
    await ctx.reply('👑 Админы / Admins:\n' + [...admins].join('\n'));
  } else if (cmd === '/stats') {
    await ctx.reply(`📊 Статистика / Stats:
Пользователи / Users: ${users.size}
Заказы / Orders: ${orders.size}
Звёзд / Stars: ${[...userStars.values()].reduce((a,b)=>a+b,0)}
Монет / Coins: ${[...userCoins.values()].reduce((a,b)=>a+b,0)}
Комиссия / Commission: ${[...orders.values()].filter(o=>o.status==='completed').reduce((a,o)=>a+(o.commission||0),0)}
Реальных пополнений / Topups: ${transactions.filter(t=>t.type==='topup').length}
Приглашений / Referrals: ${[...referralCount.values()].reduce((a,b)=>a+b,0)}`);
  } else if (cmd === '/delnews') {
    const idx = parseInt(parts[1]);
    if (isNaN(idx) || idx < 1 || idx > news.length) { await ctx.reply('Использование: /delnews <номер>'); return; }
    const removed = news.splice(news.length - idx, 1);
    saveState();
    await ctx.reply(`✅ Новость #${idx} удалена. / News deleted.`);
  } else if (cmd === '/delvideo') {
    const id = parseInt(parts[1]);
    if (!videos.has(id)) { await ctx.reply('❌ Видео не найдено. / Video not found.'); return; }
    videos.delete(id); saveState();
    await ctx.reply(`✅ Видео #${id} удалено. / Video deleted.`);
  } else if (cmd === '/delorder') {
    const id = parseInt(parts[1]);
    if (!orders.has(id)) { await ctx.reply('❌ Заказ не найден. / Order not found.'); return; }
    orders.delete(id); saveState();
    await ctx.reply(`✅ Заказ #${id} удалён. / Order deleted.`);
  } else if (cmd === '/addstars') {
    if (!isMainAdmin(uid)) { await ctx.reply('❌ Только главный админ. / Main admin only.'); return; }
    const v = validateTarget(parts[1]);
    if (!v.ok) { await ctx.reply(v.msg); return; }
    const target = parts[1];
    if (isBanned(target)) { await ctx.reply('🚫 Этот пользователь забанен. / User is banned.'); return; }
    if (isRestricted(target)) { await ctx.reply('⛔ Этот пользователь ограничен. / User is restricted.'); return; }
    const amount = parseInt(parts[2]);
    if (!amount || amount <= 0) { await ctx.reply('Использование: /addstars <userId> <сумма>'); return; }
    addStars(target, amount);
    transactions.push({ uid: target, amount, type: 'manual_add', at: Date.now() });
    saveState();
    await ctx.reply(`✅ Выдано ${amount} ⭐ пользователю ${target}. Баланс: ${getStars(target)} ⭐`);
    try { await bot.telegram.sendMessage(target, `🎁 Тебе выдано ${amount} ⭐ от администратора.`); } catch (e) {}
  } else if (cmd === '/takestars') {
    if (!isMainAdmin(uid)) { await ctx.reply('❌ Только главный админ. / Main admin only.'); return; }
    const v = validateTarget(parts[1]);
    if (!v.ok) { await ctx.reply(v.msg); return; }
    const target = parts[1];
    if (isBanned(target)) { await ctx.reply('🚫 Этот пользователь забанен. / User is banned.'); return; }
    if (isRestricted(target)) { await ctx.reply('⛔ Этот пользователь ограничен. / User is restricted.'); return; }
    const amount = parseInt(parts[2]);
    if (!amount || amount <= 0) { await ctx.reply('Использование: /takestars <userId> <сумма>'); return; }
    if (getStars(target) < amount) { await ctx.reply('❌ Недостаточно звёзд у пользователя.'); return; }
    addStars(target, -amount);
    saveState();
    await ctx.reply(`✅ Снято ${amount} ⭐ с пользователя ${target}. Баланс: ${getStars(target)} ⭐`);
  } else if (cmd === '/gift') {
    const target = parts[1];
    const amount = parseInt(parts[2]);
    const title = parts[3];
    if (!target || !amount || amount <= 0) { await ctx.reply('Использование: /gift <userId> <coins> [titleId]'); return; }
    if (!/^\d+$/.test(target)) { await ctx.reply('❌ Неверный ID пользователя. / Invalid user ID.'); return; }
    if (isBanned(target)) { await ctx.reply('🚫 Этот пользователь забанен. / User is banned.'); return; }
    if (isRestricted(target)) { await ctx.reply('⛔ Этот пользователь ограничен. / User is restricted.'); return; }
    addCoins(target, amount);
    if (title) {
      const titleObj = TITLES.find(t => t.id === title);
      if (!titleObj) { await ctx.reply('❌ Такого титула не существует. / Title does not exist.'); return; }
      const owned = ownedTitles.get(String(target)) || new Set();
      owned.add(title);
      ownedTitles.set(String(target), owned);
    }
    addMail(target, { text: `Подарок от администратора`, gift: title ? 'Титул + монеты' : 'Монеты', giftCoins: amount, giftTitle: title || null, at: Date.now() });
    saveState();
    await ctx.reply(`🎁 Подарок отправлен ${target}: ${amount}🪙 ${title || ''}`);
  }
}

bot.command('ban', async (ctx) => { if (isAdmin(ctx.from.id)) await handleAdminCommand(ctx, ctx.message.text); });
bot.command('unban', async (ctx) => { if (isAdmin(ctx.from.id)) await handleAdminCommand(ctx, ctx.message.text); });
bot.command('restrict', async (ctx) => { if (isAdmin(ctx.from.id)) await handleAdminCommand(ctx, ctx.message.text); });
bot.command('unrestrict', async (ctx) => { if (isAdmin(ctx.from.id)) await handleAdminCommand(ctx, ctx.message.text); });
bot.command('addadmin', async (ctx) => { if (isMainAdmin(ctx.from.id)) await handleAdminCommand(ctx, ctx.message.text); });
bot.command('removeadmin', async (ctx) => { if (isMainAdmin(ctx.from.id)) await handleAdminCommand(ctx, ctx.message.text); });
bot.command('listadmins', async (ctx) => { if (isAdmin(ctx.from.id)) await handleAdminCommand(ctx, ctx.message.text); });
bot.command('stats', async (ctx) => { if (isAdmin(ctx.from.id)) await handleAdminCommand(ctx, ctx.message.text); });
bot.command('news', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const text = ctx.message.text.replace('/news', '').trim();
  if (!text) { await ctx.reply('Использование: /news <текст>'); return; }
  if (news.length >= 100) { await ctx.reply('❌ Лимит новостей исчерпан (макс. 100). Удали старые через /delnews.'); return; }
  news.push({ title: 'Новость / News', text, at: Date.now() });
  saveState();
  await ctx.reply('✅ Новость опубликована. / News published.');
  for (const u of users) {
    if (isBanned(u) || isRestricted(u)) continue;
    try { await bot.telegram.sendMessage(u, `📰 Новая новость / New news:\n\n${text}`); } catch (e) {}
  }
});

// ---- Text handler ----
bot.on('text', async (ctx) => {
  const uid = ctx.from.id;
  if (isBanned(uid)) { await ctx.reply('🚫 Вы забанены. / Banned.'); return; }
  const state = userState.get(uid);
  const text = ctx.message.text;

  if (text === '/cancel' || text === 'Отмена') {
    userState.delete(uid);
    await ctx.reply('❌ Отменено. / Cancelled.', mainMenu(uid));
    return;
  }

  if (state && state.mode === 'cred_amount' && isAdmin(uid)) {
    const amount = parseInt(text);
    const target = state.target;
    userState.delete(uid);
    if (!amount || amount <= 0) { await ctx.reply('❌ Введи положительное число. / Enter a positive number.'); return; }
    if (amount > 100000) { await ctx.reply('❌ Слишком большая сумма. Максимум 100 000 ⭐. / Too large amount. Max 100 000 stars.'); return; }
    addStars(target, amount);
    manualCredits.push({ uid: String(target), amount, note: state.note || 'Ручное начисление', at: Date.now() });
    saveState();
    await ctx.reply(`✅ Начислено ${amount}⭐ пользователю ${target}.`);
    try { await bot.telegram.sendMessage(target, `✅ Тебе начислено ${amount} ⭐\n💰 Баланс: ${getStars(target)} ⭐`); } catch (e) {}
    return;
  }

  if (state && state.mode === 'create_desc') {
    if (text.length > 2000) { await editPrompt(uid, '❌ Описание слишком длинное. Максимум 2000 символов. / Description too long. Max 2000 chars.', backKeyboard(uid)); return; }
    state.description = sanitizeInput(text);
    state.mode = 'create_amount';
    userState.set(uid, state);
    await editPrompt(uid, '⭐ Сколько звёзд/монет заплатить за заказ? (число)\n📌 Минимум за звёзды — 20 ⭐ / How many stars/coins? (min 20 for stars)', backKeyboard(uid));
    return;
  }

  if (state && state.mode === 'create_amount') {
    const n = parseInt(text);
    if (!n || n <= 0) { await editPrompt(uid, '❌ Введи положительное число. / Enter positive number.', backKeyboard(uid)); return; }
    if (n > 100000) { await editPrompt(uid, '❌ Слишком большая сумма. Максимум 100 000. / Too large amount. Max 100 000.', backKeyboard(uid)); return; }
    state.amount = n;
    state.mode = 'create_currency';
    userState.set(uid, state);
    await editPrompt(uid, 'Выбери валюту заказа: / Choose order currency:', Markup.inlineKeyboard([
      [Markup.button.callback('⭐ Звёзды / Stars', 'order_currency_stars')],
      [Markup.button.callback('🪙 Монеты / Coins', 'order_currency_coins')],
      [Markup.button.callback(t(uid, 'back'), 'back_main')],
    ]));
    return;
  }

  if (state && state.mode === 'submit') {
    const order = orders.get(state.orderId);
    if (!order) { userState.delete(uid); await editPrompt(uid, '❌ Заказ не найден. / Order not found.', mainMenu(uid)); return; }
    if (isBanned(uid)) { userState.delete(uid); await editPrompt(uid, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return; }
    if (isRestricted(uid)) { userState.delete(uid); await editPrompt(uid, '⛔ Вы ограничены в выполнении заказов. / Restricted.', mainMenu(uid)); return; }
    if (order.takerId !== String(uid)) { userState.delete(uid); await editPrompt(uid, '❌ Это не твой заказ. / Not your order.', mainMenu(uid)); return; }
    if (order.status !== 'taken') { userState.delete(uid); await editPrompt(uid, '❌ Заказ уже не активен. / Order no longer active.', mainMenu(uid)); return; }
    const payout = parseInt(order.payout) || 0;
    if (payout <= 0) { userState.delete(uid); await editPrompt(uid, '❌ Ошибка: некорректная выплата заказа. / Invalid payout.', mainMenu(uid)); return; }
    order.submissions.push({ type: 'text', content: sanitizeInput(text), from: String(uid), at: Date.now() });
    order.status = 'completed';
    userState.delete(uid);
    if (order.currency === 'coins') addCoins(uid, payout); else addStars(uid, payout);
    addCoins(uid, 1);
    incCompletedOrders(uid);
    transactions.push({ uid: String(uid), amount: payout, type: 'payout', orderId: order.id, at: Date.now() });
    saveState();
    await editPrompt(uid, `✅ Работа отправлена! Заказ #${order.id} завершён.\n💰 Получено ${payout} ${order.currency === 'coins' ? '🪙' : '⭐'} +1 🪙`, mainMenu(uid));
    try { await bot.telegram.sendMessage(order.creatorId, `✅ Заказ #${order.id} выполнен!\n\nРезультат:\n${sanitizeInput(text)}\n🔗 ${orderLink(order.id)}`); } catch (e) {}
    try { await bot.telegram.sendMessage(MAIN_ADMIN, `✅ Заказ #${order.id} выполнен. Исполнитель получил ${payout} ${order.currency === 'coins' ? '🪙' : '⭐'} +1🪙`); } catch (e) {}
    return;
  }

  if (state && state.mode === 'video_title') {
    if (text.length > 200) { await editPrompt(uid, '❌ Название слишком длинное. Максимум 200 символов. / Title too long. Max 200 chars.', backKeyboard(uid)); return; }
    state.title = sanitizeInput(text);
    state.mode = 'video_desc';
    userState.set(uid, state);
    await editPrompt(uid, '🎬 Введи описание видео: / Enter video description:', backKeyboard(uid));
    return;
  }
  if (state && state.mode === 'video_desc') {
    if (text.length > 1000) { await editPrompt(uid, '❌ Описание слишком длинное. Максимум 1000 символов. / Description too long. Max 1000 chars.', backKeyboard(uid)); return; }
    state.description = sanitizeInput(text);
    state.mode = 'video_upload';
    userState.set(uid, state);
    await editPrompt(uid, '🎬 Теперь пришли видеоролик (видео или файл) — он будет показываться зрителям.\nМожно пропустить: /skip\n\nNow send your video (or file) — viewers will see it. Skip: /skip', backKeyboard(uid));
    return;
  }

  if (state && state.mode === 'video_upload') {
    if (text.toLowerCase() === '/skip') {
      const id = nextVideoId++;
      videos.set(id, { id, title: state.title, description: state.description, creatorId: String(uid), creatorName: ctx.from.first_name || 'User', invested: 0, createdAt: Date.now() });
      saveState();
      userState.delete(uid);
      await editPrompt(uid, `✅ Видео "${state.title}" создано (без ролика)! / Video created (no file)!`, mainMenu(uid));
      return;
    }
    await editPrompt(uid, '❌ Пришли именно видео (файл), а не текст.\nИли /skip, чтобы создать без ролика.\n\nSend a video file, not text. Or /skip to create without a file.', backKeyboard(uid));
    return;
  }

  if (state && state.mode === 'video_search') {
    const q = text.toLowerCase();
    const results = [...videos.values()].filter(v => v.title.toLowerCase().includes(q));
    userState.delete(uid);
    if (results.length === 0) { await editPrompt(uid, '🔍 Ничего не найдено. / Nothing found.', mainMenu(uid)); return; }
    const buttons = results.map(v => [Markup.button.callback(`${v.title} (${v.invested || 0}🪙)`, `view_video_${v.id}`)]);
    buttons.push([Markup.button.callback(t(uid, 'back'), 'back_main')]);
    await editPrompt(uid, '🔍 Результаты поиска / Search results:', Markup.inlineKeyboard(buttons));
    return;
  }

  if (state && state.mode === 'invest_amount') {
    const n = parseInt(text);
    if (!n || n <= 0) { await editPrompt(uid, '❌ Введи число. / Enter number.', backKeyboard(uid)); return; }
    if (getCoins(uid) < n) { await editPrompt(uid, `❌ Недостаточно монет. У тебя ${getCoins(uid)} 🪙. / Not enough coins.`, backKeyboard(uid)); return; }
    const video = videos.get(state.videoId);
    if (!video) { userState.delete(uid); await editPrompt(uid, '❌ Видео не найдено. / Video not found.', mainMenu(uid)); return; }
    addCoins(uid, -n);
    video.invested = (video.invested || 0) + n;
    addInvested(uid, n);
    saveState();
    userState.delete(uid);
    await editPrompt(uid, `✅ Инвестировано ${n} 🪙 в "${video.title}"! / Invested ${n} coins!`, mainMenu(uid));
    return;
  }

  if (state && state.mode === 'news_create') {
    if (text.length > 2000) { await editPrompt(uid, '❌ Текст слишком длинный. Максимум 2000 символов. / Text too long. Max 2000 chars.', backKeyboard(uid)); return; }
    const sanitized = sanitizeInput(text);
    news.push({ text: sanitized, at: Date.now() });
    saveState();
    userState.delete(uid);
    await editPrompt(uid, `✅ Новость создана и опубликована! / News created and published!\n\n${sanitized}`, mainMenu(uid));
    // Broadcast to all users
    for (const u of users) {
      if (isBanned(u) || isRestricted(u)) continue;
      try { await bot.telegram.sendMessage(u, `📰 Новая новость / New news:\n\n${sanitized}`); } catch (e) {}
    }
    return;
  }

  if (state && state.mode === 'news_broadcast') {
    if (text.length > 2000) { await editPrompt(uid, '❌ Текст слишком длинный. Максимум 2000 символов. / Text too long. Max 2000 chars.', backKeyboard(uid)); return; }
    const sanitized = sanitizeInput(text);
    userState.delete(uid);
    await editPrompt(uid, `✅ Рассылка запущена! / Broadcast started!\n\n${sanitized}`, mainMenu(uid));
    // Broadcast to all users
    let sent = 0;
    for (const u of users) {
      if (isBanned(u) || isRestricted(u)) continue;
      try { await bot.telegram.sendMessage(u, `📢 Объявление / Announcement:\n\n${sanitized}`); sent++; } catch (e) {}
    }
    try { await bot.telegram.sendMessage(uid, `✅ Рассылка завершена. Доставлено: ${sent} / ${users.size} пользователей.`); } catch (e) {}
    return;
  }

  if (state && state.mode === 'donate_target') {
    const target = text.trim();
    if (target === String(uid)) { await editPrompt(uid, '❌ Нельзя донатить себе. / Cannot donate to yourself.', mainMenu(uid)); userState.delete(uid); return; }
    if (!users.has(target)) { await editPrompt(uid, '❌ Пользователь не найден. / User not found.', mainMenu(uid)); userState.delete(uid); return; }
    if (isBanned(target)) { await editPrompt(uid, '❌ Этот пользователь забанен. / User is banned.', mainMenu(uid)); userState.delete(uid); return; }
    userState.set(uid, { ...state, mode: 'donate_amount', target, promptMsgId: state.promptMsgId, chatId: state.chatId });
    await editPrompt(uid, '💰 Сколько монет донатить? / How many coins to donate?', backKeyboard(uid));
    return;
  }

  if (state && state.mode === 'donate_amount') {
    const n = parseInt(text);
    if (!n || n <= 0) { await editPrompt(uid, '❌ Введи число. / Enter number.', backKeyboard(uid)); return; }
    if (getCoins(uid) < n) { await editPrompt(uid, `❌ Недостаточно монет. У тебя ${getCoins(uid)} 🪙. / Not enough coins.`, backKeyboard(uid)); return; }
    const target = state.target;
    if (isBanned(target)) { await editPrompt(uid, '❌ Этот пользователь забанен. / User is banned.', mainMenu(uid)); userState.delete(uid); return; }
    if (isBanned(uid)) { await editPrompt(uid, '🚫 Вы забанены. / You are banned.', mainMenu(uid)); userState.delete(uid); return; }
    addCoins(uid, -n);
    addCoins(target, n);
    saveState();
    userState.delete(uid);
    await editPrompt(uid, `✅ Донат ${n} 🪙 отправлен пользователю ${target}! / Donated ${n} coins to ${target}!`, mainMenu(uid));
    try { await bot.telegram.sendMessage(target, `💰 Тебе донатили ${n} 🪙 от пользователя ${uid}!`); } catch (e) {}
    return;
  }

  if (state && state.mode === 'profile_view') {
    userState.delete(uid);
    const target = text.trim();
    if (target === MAIN_ADMIN) { await editPrompt(uid, '🔒 Профиль администратора скрыт. / Admin profile is hidden.', mainMenu(uid)); return; }
    if (!users.has(target)) { await editPrompt(uid, '❌ Пользователь не найден. / User not found.', mainMenu(uid)); return; }
    const title = activeTitle.get(target) || 'Нет титула';
    const fishCount = getFish(target).length;
    const videoCount = [...videos.values()].filter(v => v.creatorId === target).length;
    await editPrompt(uid, `👤 Профиль #${target}\n\n⭐ Звёзды: ${getStars(target)}\n🪙 Монеты: ${getCoins(target)}\n🏷️ Титул: ${title}\n🎣 Рыб: ${fishCount}\n📺 Видео: ${videoCount}\n🤝 Приглашено: ${referralCount.get(target) || 0}`, Markup.inlineKeyboard([
      [Markup.button.callback('💰 Донатить / Donate', `donate_to_${target}`)],
      [Markup.button.callback(t(uid, 'back'), 'back_main')],
    ]));
    return;
  }

  if (state && state.mode === 'auction_price') {
    const n = parseInt(text);
    if (!n || n <= 0) { await editPrompt(uid, '❌ Введи число. / Enter number.', backKeyboard(uid)); return; }
    if (n < 1 || n > 100000) { await editPrompt(uid, '❌ Цена должна быть от 1 до 100 000 ⭐. / Price must be 1-100 000 stars.', backKeyboard(uid)); return; }
    const fish = state.fish;
    if (!fish) { userState.delete(uid); await editPrompt(uid, '❌ Нет рыбы. / No fish.', mainMenu(uid)); return; }
    const fishList = state.fishList || getFish(uid);
    const idx = fishList.indexOf(fish);
    if (idx >= 0) { fishList.splice(idx, 1); userFish.set(String(uid), fishList); }
    const id = nextAuctionId++;
    auction.set(id, { id, fish, price: n, sellerId: String(uid), status: 'open', createdAt: Date.now() });
    saveState();
    userState.delete(uid);
    await editPrompt(uid, `✅ Рыба ${fish.emoji} ${fish.name} выставлена на аукцион за ${n}⭐! / Fish listed for ${n} stars!`, mainMenu(uid));
    return;
  }

  if (isAdmin(uid) && text.startsWith('/') && text !== '/start') {
    await handleAdminCommand(ctx, text);
    return;
  }

  await ctx.reply(menuText(uid), mainMenu(uid));
});

// ---- Media handler ----
async function handleMedia(ctx, type) {
  const uid = ctx.from.id;
  const state = userState.get(uid);

  // Создание видео в «Интернете» — загрузка ролика
  if (state && state.mode === 'video_upload') {
    if (type === 'photo') {
      await editPrompt(uid, '❌ Пришли именно видео (не фото).\nИли /skip, чтобы создать без ролика.\n\nSend a video file (not a photo). Or /skip.', backKeyboard(uid));
      return true;
    }
    let fileId = null;
    if (type === 'video') fileId = ctx.message.video.file_id;
    else if (type === 'document') fileId = ctx.message.document.file_id;
    const id = nextVideoId++;
    videos.set(id, { id, title: state.title, description: state.description, creatorId: String(uid), creatorName: ctx.from.first_name || 'User', invested: 0, createdAt: Date.now(), mediaType: type, mediaFileId: fileId });
    saveState();
    userState.delete(uid);
    await editPrompt(uid, `✅ Видео "${state.title}" создано с роликом! / Video created with file!`, mainMenu(uid));
    return true;
  }

  if (!state || state.mode !== 'submit') return false;
  const order = orders.get(state.orderId);
  if (!order) { userState.delete(uid); await editPrompt(uid, '❌ Заказ не найден. / Order not found.', mainMenu(uid)); return true; }
  if (isBanned(uid)) { userState.delete(uid); await editPrompt(uid, '🚫 Вы забанены. / Banned.', mainMenu(uid)); return true; }
  if (isRestricted(uid)) { userState.delete(uid); await editPrompt(uid, '⛔ Вы ограничены в выполнении заказов. / Restricted.', mainMenu(uid)); return true; }
  if (order.takerId !== String(uid)) { userState.delete(uid); await editPrompt(uid, '❌ Это не твой заказ. / Not your order.', mainMenu(uid)); return true; }
  if (order.status !== 'taken') { userState.delete(uid); await editPrompt(uid, '❌ Заказ уже не активен. / Order no longer active.', mainMenu(uid)); return true; }

  let fileId = null;
  if (type === 'photo') {
    if (!ctx.message.photo || ctx.message.photo.length === 0) { await editPrompt(uid, '❌ Ошибка загрузки фото. / Photo upload error.', mainMenu(uid)); return true; }
    fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  } else if (type === 'video') fileId = ctx.message.video.file_id;
  else if (type === 'document') fileId = ctx.message.document.file_id;

  const payout = parseInt(order.payout) || 0;
    if (payout <= 0) { userState.delete(uid); await editPrompt(uid, '❌ Ошибка: некорректная выплата заказа. / Invalid payout.', mainMenu(uid)); return true; }
    const caption = sanitizeInput(ctx.message.caption || '');
    order.submissions.push({ type, fileId, caption, from: String(uid), at: Date.now() });
    order.status = 'completed';
    userState.delete(uid);
    if (order.currency === 'coins') addCoins(uid, payout); else addStars(uid, payout);
    addCoins(uid, 1);
    incCompletedOrders(uid);
    transactions.push({ uid: String(uid), amount: payout, type: 'payout', orderId: order.id, at: Date.now() });
    saveState();
    await editPrompt(uid, `✅ Работа отправлена! Заказ #${order.id} завершён.\n💰 Получено ${payout} ${order.currency === 'coins' ? '🪙' : '⭐'} +1 🪙`, mainMenu(uid));

  try {
    if (type === 'photo') await bot.telegram.sendPhoto(order.creatorId, fileId, { caption: `✅ Заказ #${order.id} выполнен!\n${caption}\n🔗 ${orderLink(order.id)}` });
    else if (type === 'video') await bot.telegram.sendVideo(order.creatorId, fileId, { caption: `✅ Заказ #${order.id} выполнен!\n${caption}\n🔗 ${orderLink(order.id)}` });
    else await bot.telegram.sendDocument(order.creatorId, fileId, { caption: `✅ Заказ #${order.id} выполнен!\n${caption}\n🔗 ${orderLink(order.id)}` });
  } catch (e) {}
  try { await bot.telegram.sendMessage(MAIN_ADMIN, `✅ Заказ #${order.id} выполнен (${type}).`); } catch (e) {}
  return true;
}

bot.on('photo', async (ctx) => { if (!(await handleMedia(ctx, 'photo'))) await ctx.reply(menuText(ctx.from.id), mainMenu(ctx.from.id)); });
bot.on('video', async (ctx) => { if (!(await handleMedia(ctx, 'video'))) await ctx.reply(menuText(ctx.from.id), mainMenu(ctx.from.id)); });
bot.on('document', async (ctx) => { if (!(await handleMedia(ctx, 'document'))) await ctx.reply(menuText(ctx.from.id), mainMenu(ctx.from.id)); });

// ---- Order currency callbacks ----
bot.action('order_currency_stars', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const st = userState.get(uid);
  if (!st || st.mode !== 'create_currency') { await editMsg(ctx, menuText(uid), mainMenu(uid)); return; }
  if (st.amount < 20) {
    userState.delete(uid);
    await editMsg(ctx, `❌ Минимальная стоимость заказа за звёзды — 20 ⭐. Ты указал ${st.amount}.\nСоздай заново или выбери монеты.`, mainMenu(uid));
    return;
  }
  if (getStars(uid) < st.amount) {
    userState.delete(uid);
    await editMsg(ctx, `❌ Недостаточно звёзд. Баланс: ${getStars(uid)} ⭐.\nПополни: переведи реальные Stars в канал https://t.me/stars_povelitel и нажми «💳 Я оплатил в канале».\nНе хватает: ${st.amount - getStars(uid)} ⭐`, mainMenu(uid));
    return;
  }
  const commission = Math.ceil(st.amount * COMMISSION);
  const payout = st.amount - commission;
  addStars(uid, -st.amount);
  const id = genId();
  orders.set(id, { id, creatorId: String(uid), creatorName: ctx.from.first_name || 'User', description: st.description, amount: st.amount, currency: 'stars', stars: st.amount, commission, payout, status: 'open', takerId: null, submissions: [], createdAt: Date.now(), link: orderLink(id) });
  saveState();
  userState.delete(uid);
  await editMsg(ctx, `✅ Заказ #${id} создан!\n\n${st.description}\n⭐ ${st.amount} звёзд (комиссия 5% = ${commission}⭐)\n🔗 Ссылка: ${orderLink(id)}\n\nОпубликован. / Created.`, mainMenu(uid));
  try { await bot.telegram.sendMessage(MAIN_ADMIN, `📋 Новый заказ #${id} от ${ctx.from.first_name}: ${st.description} (${st.amount}⭐)\n🔗 ${orderLink(id)}`); } catch (e) {}
});

bot.action('order_currency_coins', async (ctx) => {
  await ctx.answerCbQuery();
  const uid = ctx.from.id;
  const st = userState.get(uid);
  if (!st || st.mode !== 'create_currency') { await editMsg(ctx, menuText(uid), mainMenu(uid)); return; }
  if (getCoins(uid) < st.amount) {
    userState.delete(uid);
    await editMsg(ctx, `❌ Недостаточно монет. Баланс: ${getCoins(uid)} 🪙.`, mainMenu(uid));
    return;
  }
  const commission = Math.ceil(st.amount * COMMISSION);
  const payout = st.amount - commission;
  addCoins(uid, -st.amount);
  const id = genId();
  orders.set(id, { id, creatorId: String(uid), creatorName: ctx.from.first_name || 'User', description: st.description, amount: st.amount, currency: 'coins', stars: 0, commission, payout, status: 'open', takerId: null, submissions: [], createdAt: Date.now(), link: orderLink(id) });
  saveState();
  userState.delete(uid);
  await editMsg(ctx, `✅ Заказ #${id} создан!\n\n${st.description}\n🪙 ${st.amount} монет (комиссия 5% = ${commission}🪙)\n🔗 Ссылка: ${orderLink(id)}\n\nОпубликован. / Created.`, mainMenu(uid));
  try { await bot.telegram.sendMessage(MAIN_ADMIN, `📋 Новый заказ #${id} от ${ctx.from.first_name}: ${st.description} (${st.amount}🪙)\n🔗 ${orderLink(id)}`); } catch (e) {}
});

// ---- Real Stars payment ----
bot.command('pay', async (ctx) => {
  const uid = ctx.from.id;
  await ctx.reply('💳 Пополнение баланса (⭐ звёзды — игровая валюта бота)\n\n1️⃣ Переведи реальные Telegram Stars в канал платежей\n2️⃣ Вернись в бота и нажми «💳 Я оплатил в канале»\n3️⃣ Администрация проверит и начислит баланс', Markup.inlineKeyboard([
    [Markup.button.url('⭐ Перевести звёзды', 'https://t.me/stars_povelitel')],
    [Markup.button.callback('💳 Я оплатил в канале', 'paid_claim')],
    [Markup.button.callback('👋 Главное меню', 'back_main')],
  ]));
});

bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

bot.on('successful_payment', async (ctx) => {
  const uid = ctx.from.id;
  const payment = ctx.message.successful_payment;
  const amount = payment.total_amount;
  const commission = Math.ceil(amount * 0.05);
  const credited = amount - commission;
  addStars(uid, credited);
  transactions.push({ uid: String(uid), amount, credited, commission, type: 'topup', at: Date.now(), chargeId: payment.telegram_payment_charge_id });
  saveState();
  await ctx.reply(`✅ Оплачено ${amount} ⭐\n💸 Комиссия сервиса (5%): ${commission} ⭐\n💰 Зачислено на баланс: ${credited} ⭐\n💰 Текущий баланс: ${getStars(uid)} ⭐`, mainMenu(uid));
  try { await bot.telegram.sendMessage(MAIN_ADMIN, `💰 Реальное пополнение: ${ctx.from.first_name} (${uid}) оплатил ${amount}⭐, зачислено ${credited}⭐ (комиссия ${commission}⭐)`); } catch (e) {}
});

// Команда /transfer удалена: прямой перевод звёзд между пользователями невозможен.
// Звёзды можно передать только через покупку подарков/платных сообщений в Telegram.

// ---- Логирование ошибок и защита от падения ----
const LOG_FILE = path.join(__dirname, 'bot.log');
function logError(msg) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {}
  console.error(msg);
}

bot.on('error', (err) => {
  logError('Bot error: ' + (err && err.message ? err.message : String(err)));
});

process.on('uncaughtException', (err) => {
  logError('UNCAUGHT EXCEPTION: ' + (err && err.stack ? err.stack : String(err)));
  // Не роняем процесс — логируем и продолжаем
});

process.on('unhandledRejection', (reason) => {
  logError('UNHANDLED REJECTION: ' + (reason && reason.stack ? reason.stack : String(reason)));
});

// --- Простой HTTP сервер для пинга (чтобы Render не засыпал) ---
const HTTP_PORT = process.env.PORT || 8080;
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is alive\n');
});
httpServer.on('error', (e) => logError('HTTP server error: ' + (e && e.stack ? e.stack : String(e))));
httpServer.listen(HTTP_PORT, () => {
  console.log('🌐 HTTP ping server listening on port ' + HTTP_PORT);
});

// --- Авто-пинг: сервисное сообщение только главному админу (keep-alive для Render) ---
const BOT_START_TIME = Date.now();
setInterval(async () => {
  try {
    const uptimeMin = Math.floor((Date.now() - BOT_START_TIME) / 1000 / 60);
    await bot.telegram.sendMessage(Number(MAIN_ADMIN), `🔄 Автопинг системы (keep-alive)\n⏱ Работает уже: ${uptimeMin} мин\n👥 Пользователей: ${users.size}`, Markup.inlineKeyboard([[Markup.button.callback('🔄 Обновить данные', 'admin_panel')]]));
    console.log('🔄 Автопинг отправлен (keep-alive)');
  } catch (e) {
    logError('Ошибка автопинга: ' + (e && e.stack ? e.stack : String(e)));
  }
}, 4 * 60 * 1000);

// --- Сохранение состояния каждые 5 минут (чтобы не потерять данные при перезагрузке) ---
setInterval(() => {
  try {
    saveState();
    console.log('💾 Состояние сохранено');
  } catch (e) {
    console.error('Ошибка сохранения состояния: ' + (e && e.message ? e.message : String(e)));
  }
}, 5 * 60 * 1000);

// --- Очистка заброшенных состояний пользователей (старше 30 минут) ---
setInterval(() => {
  try {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000;
    let cleaned = 0;
    for (const [uid, st] of userState.entries()) {
      if (now - (st.at || 0) > maxAge) {
        userState.delete(uid);
        cleaned++;
      }
    }
    if (cleaned > 0) console.log('🧹 Очищено заброшенных состояний: ' + cleaned);
  } catch (e) {
    console.error('Ошибка очистки состояний: ' + (e && e.message ? e.message : String(e)));
  }
}, 10 * 60 * 1000);

// --- Очистка старых записей rate limit ---
setInterval(() => {
  try {
    const now = Date.now();
    for (const [k, v] of commandCooldowns.entries()) {
      if (now - v > 60000) commandCooldowns.delete(k);
    }
    for (const [k, v] of messageCounts.entries()) {
      if (now > v.resetTime) messageCounts.delete(k);
    }
    for (const [k, v] of adminCommandCounts.entries()) {
      if (now > v.resetTime) adminCommandCounts.delete(k);
    }
  } catch (e) {
    console.error('Ошибка очистки rate limit: ' + (e && e.message ? e.message : String(e)));
  }
}, 5 * 60 * 1000);

// --- Очистка старых транзакций, логов и новостей (раз в час) ---
setInterval(() => {
  try {
    const MAX_TRANSACTIONS = 5000;
    const MAX_MANUAL_CREDITS = 1000;
    const MAX_NEWS = 200;
    const MAX_MAIL_PER_USER = 100;
    const MAX_REFERRALS_PER_USER = 1000;
    
    if (transactions.length > MAX_TRANSACTIONS) {
      transactions.splice(0, transactions.length - MAX_TRANSACTIONS);
    }
    if (manualCredits.length > MAX_MANUAL_CREDITS) {
      manualCredits.splice(0, manualCredits.length - MAX_MANUAL_CREDITS);
    }
    if (news.length > MAX_NEWS) {
      news.splice(0, news.length - MAX_NEWS);
    }
    for (const [uid, msgs] of mail.entries()) {
      if (msgs.length > MAX_MAIL_PER_USER) {
        mail.set(uid, msgs.slice(-MAX_MAIL_PER_USER));
      }
    }
    for (const [inv, refs] of referrals.entries()) {
      if (refs.size > MAX_REFERRALS_PER_USER) {
        const arr = [...refs].slice(-MAX_REFERRALS_PER_USER);
        referrals.set(inv, new Set(arr));
      }
    }
    // Очистка старых заказов (оставляем последние 10000)
    const MAX_ORDERS = 10000;
    if (orders.size > MAX_ORDERS) {
      const toDelete = orders.size - MAX_ORDERS;
      let deleted = 0;
      for (const [id] of orders.entries()) {
        if (deleted >= toDelete) break;
        orders.delete(id);
        deleted++;
      }
    }
    console.log('🧹 Периодическая очистка завершена');
  } catch (e) {
    console.error('Ошибка периодической очистки: ' + (e && e.message ? e.message : String(e)));
  }
}, 60 * 60 * 1000);

// --- Очистка заброшенных рефералов и кэшей (раз в 6 часов) ---
setInterval(() => {
  try {
    const now = Date.now();
    const MAX_AGE = 180 * 24 * 60 * 60 * 1000; // 180 дней
    let cleaned = 0;
    
    // fishingCooldown
    for (const [uid, t] of fishingCooldown.entries()) {
      if (now - t > MAX_AGE) { fishingCooldown.delete(uid); cleaned++; }
    }
    // userTasksClaimed - не чистим, это достижения
    // userInvested - не чистим
    // userCompletedOrders - не чистим
    // paymentClaims - чистим старые (старше 24 часов)
    for (const [uid, claim] of paymentClaims.entries()) {
      if (now - claim.at > 24 * 60 * 60 * 1000) {
        paymentClaims.delete(uid);
        cleaned++;
      }
    }
    // deniedClaims - чистим старые (старше 30 дней)
    for (const [uid, n] of deniedClaims.entries()) {
      if (now - (userInfos.get(uid)?.firstSeen || now) > 30 * 24 * 60 * 60 * 1000) {
        deniedClaims.delete(uid);
        cleaned++;
      }
    }
    if (cleaned > 0) console.log('🧹 Очистка старых кэшей: ' + cleaned);
  } catch (e) {
    console.error('Ошибка очистки кэшей: ' + (e && e.message ? e.message : String(e)));
  }
}, 6 * 60 * 60 * 1000);

// === ГЛОБАЛЬНАЯ ЗАЩИТА ОТ ОШИБОК (ДО запуска бота!) ===

// Обработчик ошибок Telegraf — ловит ошибки в любых обработчиках команд/кнопок
bot.catch((err, ctx) => {
  logError('Telegraf handler error: ' + (err && err.stack ? err.stack : String(err)));
  try {
    if (ctx && ctx.reply) {
      ctx.reply('⚠️ Внутренняя ошибка бота. Попробуйте позже. / Internal error.').catch(() => {});
    }
  } catch (e) {}
});

// Не роняем процесс при uncaughtException — логируем и продолжаем
process.on('uncaughtException', (err) => {
  logError('UNCAUGHT EXCEPTION: ' + (err && err.stack ? err.stack : String(err)));
  // Не выходим — пусть бот продолжит работу
});

// Не роняем процесс при unhandledRejection
process.on('unhandledRejection', (reason) => {
  logError('UNHANDLED REJECTION: ' + (reason && reason.stack ? reason.stack : String(reason)));
});

// Корректная остановка
process.on('SIGINT', () => {
  logError('SIGINT received, stopping bot...');
  try { saveState(); } catch (e) {}
  try { bot.stop('SIGINT'); } catch (e) {}
  process.exit(0);
});

process.on('SIGTERM', () => {
  logError('SIGTERM received, stopping bot...');
  try { saveState(); } catch (e) {}
  try { bot.stop('SIGTERM'); } catch (e) {}
  process.exit(0);
});

// === ЗАПУСК БОТА С ПОЛНОЙ ЗАЩИТОЙ ОТ ВСЕХ ОШИБОК ===

let isBotRunning = false;
let restartTimeout = null;
let pollingLoop = null;

async function acquireLock() {
  try {
    // Проверяем, не запущен ли уже бот
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim());
      try {
        process.kill(pid, 0); // Проверка существования процесса
        console.log(`⚠️ Другой экземпляр бота уже запущен (PID: ${pid}), ждём...`);
        return false;
      } catch (e) {
        // Процесс не существует, удаляем старый лок
        fs.unlinkSync(LOCK_FILE);
      }
    }
    // Создаём лок
    fs.writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch (e) {
    console.error('Lock error: ' + (e && e.message ? e.message : String(e)));
    return true; // В случае ошибки лока - разрешаем запуск
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim());
      if (pid === process.pid) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch (e) {}
}

// Отменяем pending restart при новом запуске
function cancelRestart() {
  if (restartTimeout) {
    clearTimeout(restartTimeout);
    restartTimeout = null;
  }
}

async function ensureBotInfo() {
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username;
    console.log('🤖 Бот: @' + BOT_USERNAME);
  } catch (e) {
    console.error('Не удалось получить информацию о боте: ' + (e && e.message ? e.message : String(e)));
  }
}

// Кастомный polling loop с полной защитой от ошибок (используем публичный API Telegraf)
async function runPollingLoop() {
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 50;
  
  // Используем стандартный launch но с перехватом ошибок
  await bot.launch({
    dropPendingUpdates: true,
    allowedUpdates: ['message', 'callback_query', 'pre_checkout_query', 'successful_payment']
  });
  
  // Если launch завершился (не должно происходить), ждём и перезапускаем
  while (true) {
    await new Promise(r => setTimeout(r, 5000));
    consecutiveErrors++;
    if (consecutiveErrors >= 50) {
      logError('Too many consecutive restarts, waiting longer...');
      await new Promise(r => setTimeout(r, 300000));
      consecutiveErrors = 0;
    }
    try {
      await bot.launch({ dropPendingUpdates: true });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (msg.includes('409') || msg.includes('Conflict')) {
        logError('409 Conflict detected, waiting 30s before retry...');
        await new Promise(r => setTimeout(r, 30000));
      } else {
        logError('Bot launch error: ' + (e && e.stack ? e.stack : String(e)));
        await new Promise(r => setTimeout(r, 10000));
      }
    }
  }
}

let startRetries = 0;
async function startBot() {
  // === СЛОЙ 1: Защита от повторного запуска ===
  if (isBotRunning) {
    logError('⚠️ Бот уже запущен, пропускаем повторный запуск');
    return;
  }
  isBotRunning = true;

  // === СЛОЙ 2: Файловый лок с retry (до 10 попыток) ===
  let lockAcquired = false;
  for (let attempt = 1; attempt <= 10; attempt++) {
    lockAcquired = await acquireLock();
    if (lockAcquired) break;
    logError(`⏳ Попытка ${attempt}/10 получить лок... ждём 3 сек`);
    await new Promise(r => setTimeout(r, 3000));
  }
  if (!lockAcquired) {
    logError('❌ Не удалось получить лок после 10 попыток. Ждём 30 сек и пробуем снова.');
    isBotRunning = false;
    setTimeout(startBot, 30000);
    return;
  }

  // === СЛОЙ 3: Задержка перед стартом (даём время старому инстансу умереть при Render auto-deploy) ===
  logError('⏳ Ожидание 10 сек перед стартом (защита от 409 Conflict при auto-deploy)...');
  await new Promise(r => setTimeout(r, 10000));

  // === СЛОЙ 4: Отключение вебхука с drop_pending_updates ===
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    logError('🗑 Webhook отключён, pending updates очищены');
  } catch (e) {
    logError('⚠️ Не удалось отключить вебхук: ' + (e && e.stack ? e.stack : String(e)));
  }

  // === СЛОЙ 5: Получение информации о боте ===
  try {
    await ensureBotInfo();
  } catch (e) {
    logError('⚠️ Не удалось получить информацию о боте: ' + (e && e.stack ? e.stack : String(e)));
  }

  // === СЛОЙ 5.5: Вторая проверка вебхука после ensureBotInfo ===
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    logError('🗑 Вторичная очистка вебхука выполнена');
  } catch (e) {
    logError('⚠️ Вторичная очистка вебхука не удалась: ' + (e && e.stack ? e.stack : String(e)));
  }

  // === СЛОЙ 5.6: Загрузка состояния (локальный файл → GitHub Gist) ===
  try {
    await loadState();
    logError('✅ Состояние загружено');
  } catch (e) {
    logError('⚠️ Ошибка загрузки состояния: ' + (e && e.stack ? e.stack : String(e)));
  }

  // === СЛОЙ 6: Запуск polling с полной защитой ===
  try {
    startRetries = 0;
    logError('🚀 Бот запущен... Главный админ: ' + MAIN_ADMIN);
    logError('Bot launched OK');
    
    // === СЛОЙ 7: Запуск polling с автоматическим перезапуском ===
    await runPollingLoop();
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    logError('❌ Bot launch error: ' + (e && e.stack ? e.stack : String(e)));
    releaseLock();
    isBotRunning = false;
    startRetries++;
    const delay = Math.min(startRetries * 5000, 60000);
    logError(`🔄 Перезапуск через ${delay}мс (попытка ${startRetries})...`);
    setTimeout(startBot, delay);
  }
}

// Запуск бота
startBot().catch((e) => {
  logError('startBot crashed: ' + (e && e.stack ? e.stack : String(e)));
  setTimeout(() => {
    startBot();
  }, 5000);
});

// Дополнительная защита: если процесс получает сигнал остановки
process.on('SIGINT', () => {
  logError('SIGINT received, stopping bot...');
  try { saveState(); } catch (e) {}
  try { if (pollingLoop) pollingLoop.stop(); } catch (e) {}
  releaseLock();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logError('SIGTERM received, stopping bot...');
  try { saveState(); } catch (e) {}
  try { if (pollingLoop) pollingLoop.stop(); } catch (e) {}
  releaseLock();
  process.exit(0);
});
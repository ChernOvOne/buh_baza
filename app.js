require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const bcrypt       = require('bcryptjs');
const path         = require('path');
const cron         = require('node-cron');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: false }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Хэшируем пароль при старте ──────────────────────────────────────────────
;(async () => {
  if (!process.env.ADMIN_PASSWORD) {
    console.error('❌ Не задан ADMIN_PASSWORD в .env');
    process.exit(1);
  }
  process.env.ADMIN_HASH = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
  console.log('✅ Пароль настроен');
})();

// ── API роуты ────────────────────────────────────────────────────────────────
app.use('/api', require('./routes/api'));

// ── Страницы ─────────────────────────────────────────────────────────────────
const auth = require('./middleware/auth');

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/', auth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', auth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Cron: ежедневный отчёт ───────────────────────────────────────────────────
const hour   = process.env.REPORT_HOUR   || 18;
const minute = process.env.REPORT_MINUTE || 0;

cron.schedule(`${minute} ${hour} * * *`, async () => {
  if (!process.env.TG_BOT_TOKEN || !process.env.TG_CHANNEL_ID) return;
  try {
    const { sendDailyReport } = require('./services/telegram');
    await sendDailyReport();
  } catch (e) {
    console.error('Cron error:', e.message);
  }
}, { timezone: 'Europe/Moscow' });

console.log(`⏰ Ежедневный отчёт: ${hour}:${String(minute).padStart(2,'0')} МСК`);

// ── Запуск ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
});

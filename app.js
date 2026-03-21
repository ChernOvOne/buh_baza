require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const bcrypt       = require('bcryptjs');
const path         = require('path');
const cron         = require('node-cron');
const fs           = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(cors({ origin: false }));

// Статика — без авто-index чтобы / не открывалась без токена
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Загруженные чеки — только с токеном (защита)
const auth = require('./middleware/auth');
app.use('/uploads', auth, express.static(path.join(__dirname, 'uploads')));

// Хэшируем пароль при старте
;(async () => {
  if (!process.env.ADMIN_PASSWORD) { console.error('❌ Нет ADMIN_PASSWORD в .env'); process.exit(1); }
  process.env.ADMIN_HASH = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
  console.log('✅ Пароль настроен');
})();

// API
app.use('/api', require('./routes/api'));

// Страницы
app.get('/login',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/',           auth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard',  auth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/index.html', auth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Cron: ежедневный отчёт
const hour   = process.env.REPORT_HOUR   || 18;
const minute = process.env.REPORT_MINUTE || 0;
cron.schedule(`${minute} ${hour} * * *`, async () => {
  if (!process.env.TG_BOT_TOKEN || !process.env.TG_CHANNEL_ID) return;
  try { await require('./services/telegram').sendDailyReport(); }
  catch(e) { console.error('Cron error:', e.message); }
}, { timezone: 'Europe/Moscow' });
console.log(`⏰ Отчёт в ${hour}:${String(minute).padStart(2,'0')} МСК`);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 http://localhost:${PORT}`));

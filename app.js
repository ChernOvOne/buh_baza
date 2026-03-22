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
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const auth = require('./middleware/auth');
app.use('/uploads', auth, express.static(path.join(__dirname, 'uploads')));

app.use('/api', require('./routes/api'));

// Pages
app.get('/login',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/invite/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'invite.html')));
app.get('/',           auth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/index.html', auth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Cron
const hour   = process.env.REPORT_HOUR   || 18;
const minute = process.env.REPORT_MINUTE || 0;
cron.schedule(`${minute} ${hour} * * *`, async () => {
  try { await require('./services/telegram').sendDailyReport(); }
  catch(e) { console.error('Cron error:', e.message); }
}, { timezone: 'Europe/Moscow' });

// ── Запускаем сервер ТОЛЬКО после готовности хэша ────────────────────────
async function start() {
  if (!process.env.ADMIN_PASSWORD) {
    console.error('❌ Нет ADMIN_PASSWORD в .env');
    process.exit(1);
  }

  // Хэш вычисляем ДО старта сервера — гарантия что при первом запросе он готов
  process.env.ADMIN_HASH = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
  console.log('✅ Пароль настроен');

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 http://localhost:${PORT}`);
    console.log(`⏰ Отчёт в ${hour}:${String(minute).padStart(2,'0')} МСК`);
  });

  // Bot стартует после сервера
  setTimeout(() => {
    try { require('./services/bot').startBot(); }
    catch(e) { console.error('Bot start error:', e.message); }
  }, 1000);
}

start();

require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const bcrypt       = require('bcryptjs');
const path         = require('path');
const cron         = require('node-cron');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(cors({ origin: false }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const auth = require('./middleware/auth');
app.use('/uploads', auth, express.static(path.join(__dirname, 'uploads')));
app.use('/api', require('./routes/api'));

// Страницы
app.get('/login',         (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/invite/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'invite.html')));
app.get('/',              auth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/index.html',    auth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Cron
const hour   = process.env.REPORT_HOUR   || 18;
const minute = process.env.REPORT_MINUTE || 0;
cron.schedule(`${minute} ${hour} * * *`, async () => {
  try { await require('./services/telegram').sendDailyReport(); }
  catch(e) { console.error('Cron error:', e.message); }
}, { timezone: 'Europe/Moscow' });

async function start() {
  if (!process.env.ADMIN_PASSWORD) {
    console.error('❌ ADMIN_PASSWORD не задан в .env');
    process.exit(1);
  }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 10) {
    console.error('❌ JWT_SECRET не задан или слишком короткий в .env');
    process.exit(1);
  }

  // Хэш ПЕРЕД стартом сервера
  process.env.ADMIN_HASH = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
  console.log('✅ Пароль хэширован');

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Запущен на порту ${PORT}`);
    console.log(`⏰ Отчёт в ${hour}:${String(minute).padStart(2,'0')} МСК`);
  });

  setTimeout(() => {
    try { require('./services/bot').startBot(); }
    catch(e) { console.error('Bot error:', e.message); }
  }, 2000);
}

start().catch(e => { console.error(e); process.exit(1); });

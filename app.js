require('dotenv').config();
const express      = require('express');
const cookieParser = require('cookie-parser');
const bcrypt       = require('bcryptjs');
const jwt          = require('jsonwebtoken');
const path         = require('path');
const cron         = require('node-cron');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const auth = require('./middleware/auth');
const { getCookieOpts } = require('./middleware/auth');
app.use('/uploads', auth, express.static(path.join(__dirname, 'uploads')));
app.use('/api', require('./routes/api'));

app.get('/login',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/invite/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'invite.html')));

// Одноразовая ссылка для входа через TG бот
app.get('/invite/login/:token', (req, res) => {
  try {
    const decoded = jwt.verify(req.params.token, process.env.JWT_SECRET);
    if (!decoded.partner_id) return res.redirect('/login');
    const token = jwt.sign({ partner_id: decoded.partner_id, role: decoded.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.cookie('token', token, getCookieOpts());
    res.redirect('/');
  } catch {
    res.redirect('/login?error=expired');
  }
});

app.get('/',           auth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/index.html', auth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const hour   = process.env.REPORT_HOUR   || 18;
const minute = process.env.REPORT_MINUTE || 0;
cron.schedule(`${minute} ${hour} * * *`, async () => {
  try { await require('./services/telegram').sendDailyReport(); }
  catch(e) { console.error('Cron:', e.message); }
}, { timezone: 'Europe/Moscow' });

async function start() {
  if (!process.env.ADMIN_PASSWORD) { console.error('❌ ADMIN_PASSWORD не задан'); process.exit(1); }
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 10) { console.error('❌ JWT_SECRET не задан'); process.exit(1); }
  process.env.ADMIN_HASH = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
  console.log('✅ Пароль готов');
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => console.log(`🚀 http://localhost:${PORT}`));
  setTimeout(() => { try { require('./services/bot').startBot(); } catch(e) { console.error('Bot:', e.message); } }, 2000);
}
start().catch(e => { console.error(e); process.exit(1); });

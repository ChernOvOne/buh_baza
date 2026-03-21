const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database/db');
const auth = require('../middleware/auth');

// ─── AUTH ────────────────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  const { password } = req.body;
  const valid = await bcrypt.compare(password, process.env.ADMIN_HASH);
  if (!valid) return res.status(401).json({ error: 'Неверный пароль' });
  const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' });
  res.json({ ok: true });
});

router.post('/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

// ─── DAILY ENTRIES ───────────────────────────────────────────────────────────
router.get('/daily', auth, (req, res) => {
  const { month, year } = req.query;
  let stmt, rows;
  if (month && year) {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    stmt = db.prepare("SELECT * FROM daily_entries WHERE date LIKE ? ORDER BY date DESC");
    rows = stmt.all(`${prefix}%`);
  } else {
    stmt = db.prepare("SELECT * FROM daily_entries ORDER BY date DESC LIMIT 60");
    rows = stmt.all();
  }
  res.json(rows);
});

router.post('/daily', auth, (req, res) => {
  const { date, revenue, expense, incas_artem, incas_roman, incas_mikhail, note } = req.body;
  try {
    const stmt = db.prepare(`
      INSERT INTO daily_entries (date, revenue, expense, incas_artem, incas_roman, incas_mikhail, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        revenue=excluded.revenue, expense=excluded.expense,
        incas_artem=excluded.incas_artem, incas_roman=excluded.incas_roman,
        incas_mikhail=excluded.incas_mikhail, note=excluded.note
    `);
    stmt.run(date, revenue||0, expense||0, incas_artem||0, incas_roman||0, incas_mikhail||0, note||'');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/daily/:id', auth, (req, res) => {
  db.prepare("DELETE FROM daily_entries WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ─── ACCOUNT EXPENSES ────────────────────────────────────────────────────────
router.get('/expenses', auth, (req, res) => {
  const { month, year } = req.query;
  let rows;
  if (month && year) {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    rows = db.prepare("SELECT * FROM account_expenses WHERE date LIKE ? ORDER BY date DESC").all(`${prefix}%`);
  } else {
    rows = db.prepare("SELECT * FROM account_expenses ORDER BY date DESC LIMIT 100").all();
  }
  res.json(rows);
});

router.post('/expenses', auth, (req, res) => {
  const { date, category, description, amount, receipt_url } = req.body;
  try {
    const r = db.prepare("INSERT INTO account_expenses (date,category,description,amount,receipt_url) VALUES (?,?,?,?,?)").run(
      date, category, description, amount, receipt_url||''
    );
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/expenses/:id', auth, (req, res) => {
  db.prepare("DELETE FROM account_expenses WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ─── ADS ─────────────────────────────────────────────────────────────────────
router.get('/ads', auth, (req, res) => {
  const { month, year } = req.query;
  let rows;
  if (month && year) {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    rows = db.prepare("SELECT * FROM ads WHERE date LIKE ? ORDER BY date DESC").all(`${prefix}%`);
  } else {
    rows = db.prepare("SELECT * FROM ads ORDER BY date DESC LIMIT 100").all();
  }
  res.json(rows);
});

router.post('/ads', auth, (req, res) => {
  const { date, format, amount, name, subscribers_gain, channel_url, screenshot_url } = req.body;
  try {
    const r = db.prepare("INSERT INTO ads (date,format,amount,name,subscribers_gain,channel_url,screenshot_url) VALUES (?,?,?,?,?,?,?)").run(
      date, format||'', amount, name, subscribers_gain||0, channel_url||'', screenshot_url||''
    );
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/ads/:id', auth, (req, res) => {
  db.prepare("DELETE FROM ads WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ─── INVESTMENTS ─────────────────────────────────────────────────────────────
router.get('/investments', auth, (req, res) => {
  const { month, year } = req.query;
  let rows;
  if (month && year) {
    const prefix = `${year}-${String(month).padStart(2, '0')}`;
    rows = db.prepare("SELECT * FROM investments WHERE date LIKE ? ORDER BY date DESC").all(`${prefix}%`);
  } else {
    rows = db.prepare("SELECT * FROM investments ORDER BY date DESC LIMIT 100").all();
  }
  res.json(rows);
});

router.post('/investments', auth, (req, res) => {
  const { date, type, category, amount, receipt_url, note } = req.body;
  try {
    const r = db.prepare("INSERT INTO investments (date,type,category,amount,receipt_url,note) VALUES (?,?,?,?,?,?)").run(
      date, type, category, amount, receipt_url||'', note||''
    );
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/investments/:id', auth, (req, res) => {
  db.prepare("DELETE FROM investments WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

// ─── STATISTICS ───────────────────────────────────────────────────────────────
router.get('/stats', auth, (req, res) => {
  // Сводка по месяцам
  const monthly = db.prepare(`
    SELECT
      strftime('%Y-%m', date) as month,
      SUM(revenue)   as total_revenue,
      SUM(expense)   as total_expense,
      SUM(incas_artem+incas_roman+incas_mikhail) as total_incas,
      COUNT(*)       as days_count,
      AVG(revenue)   as avg_daily,
      MAX(revenue)   as max_day
    FROM daily_entries
    GROUP BY strftime('%Y-%m', date)
    ORDER BY month
  `).all();

  // Расходы по категориям за текущий месяц
  const thisMonth = new Date().toISOString().slice(0, 7);
  const expByCategory = db.prepare(`
    SELECT category, SUM(amount) as total
    FROM account_expenses
    WHERE date LIKE ?
    GROUP BY category
  `).all(`${thisMonth}%`);

  // Итог по рекламе
  const adStats = db.prepare(`
    SELECT
      strftime('%Y-%m', date) as month,
      SUM(amount) as total_spent,
      SUM(subscribers_gain) as total_subs,
      COUNT(*) as campaigns
    FROM ads
    GROUP BY month
    ORDER BY month
  `).all();

  // Баланс текущего месяца
  const balance = db.prepare(`
    SELECT
      SUM(revenue) as revenue,
      SUM(expense) as expense,
      SUM(revenue) - SUM(expense) as net
    FROM daily_entries
    WHERE date LIKE ?
  `).get(`${thisMonth}%`);

  res.json({ monthly, expByCategory, adStats, balance });
});

// ─── SEND REPORT MANUALLY ─────────────────────────────────────────────────────
router.post('/report/send', auth, async (req, res) => {
  try {
    const { sendDailyReport } = require('../services/telegram');
    await sendDailyReport();
    res.json({ ok: true, message: 'Отчёт отправлен!' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

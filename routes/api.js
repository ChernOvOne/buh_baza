const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('../database/db');
const auth = require('../middleware/auth');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, `file_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => { const ok = /jpeg|jpg|png|gif|webp|pdf/.test(file.mimetype); cb(ok ? null : new Error('Only images/PDF'), ok); }
});

const qs = (m, y) => (m && y) ? `${y}-${String(m).padStart(2,'0')}` : null;

// AUTH
router.post('/auth/login', async (req, res) => {
  const valid = await bcrypt.compare(req.body.password, process.env.ADMIN_HASH);
  if (!valid) return res.status(401).json({ error: 'Неверный пароль' });
  const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 30*24*3600*1000, sameSite: 'lax' });
  res.json({ ok: true });
});
router.post('/auth/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

// SETTINGS
router.get('/settings', auth, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  for (const r of rows) { try { obj[r.key] = JSON.parse(r.value); } catch { obj[r.key] = r.value; } }
  res.json(obj);
});
router.post('/settings', auth, (req, res) => {
  const ups = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    for (const [key, val] of Object.entries(req.body)) {
      ups.run(key, typeof val === 'object' ? JSON.stringify(val) : String(val));
    }
  })();
  // Restart bot if token changed
  if (req.body.tg_bot_token) {
    try { require('../services/bot').restartBot(); } catch(e) {}
  }
  res.json({ ok: true });
});

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

// PARTNERS
router.get('/partners', auth, (req, res) => res.json(db.prepare('SELECT * FROM partners ORDER BY sort_order,id').all()));
router.post('/partners', auth, (req, res) => {
  const { name, role, share_type, share_value, color, tg_chat_id, sort_order } = req.body;
  try {
    const r = db.prepare(`INSERT INTO partners (name,role,share_type,share_value,color,tg_chat_id,sort_order) VALUES (?,?,?,?,?,?,?)`).run(name, role||'owner', share_type||'none', share_value||0, color||'#00e5ff', tg_chat_id||'', sort_order||0);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
router.put('/partners/:id', auth, (req, res) => {
  const { name, role, share_type, share_value, color, tg_chat_id, sort_order, active } = req.body;
  db.prepare(`UPDATE partners SET name=?,role=?,share_type=?,share_value=?,color=?,tg_chat_id=?,sort_order=?,active=? WHERE id=?`).run(name, role, share_type, share_value||0, color, tg_chat_id||'', sort_order||0, active??1, req.params.id);
  res.json({ ok: true });
});
router.delete('/partners/:id', auth, (req, res) => { db.prepare('DELETE FROM partners WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// DAILY
router.get('/daily', auth, (req, res) => {
  const { month, year } = req.query;
  const prefix = qs(month, year);
  const rows = prefix
    ? db.prepare("SELECT * FROM daily_entries WHERE date LIKE ? ORDER BY date DESC").all(`${prefix}%`)
    : db.prepare("SELECT * FROM daily_entries ORDER BY date DESC LIMIT 62").all();
  const withP = rows.map(r => ({ ...r, partner_withdrawals: db.prepare(`SELECT pd.*, p.name, p.color, p.role FROM partner_daily pd JOIN partners p ON p.id=pd.partner_id WHERE pd.date=?`).all(r.date) }));
  res.json(withP);
});
router.post('/daily', auth, (req, res) => {
  const { date, revenue, expense, note, partner_withdrawals } = req.body;
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO daily_entries (date,revenue,expense,note) VALUES (?,?,?,?) ON CONFLICT(date) DO UPDATE SET revenue=excluded.revenue,expense=excluded.expense,note=excluded.note`).run(date, revenue||0, expense||0, note||'');
      if (Array.isArray(partner_withdrawals)) {
        db.prepare('DELETE FROM partner_daily WHERE date=?').run(date);
        const ins = db.prepare(`INSERT INTO partner_daily (date,partner_id,amount,type,note) VALUES (?,?,?,?,?)`);
        for (const pw of partner_withdrawals) { if (pw.amount > 0) ins.run(date, pw.partner_id, pw.amount, pw.type||'withdrawal', pw.note||''); }
      }
    })();
    // Notify TG if enabled
    const notifyNew = getSetting('notify_new_entry', false);
    if (notifyNew) {
      try {
        const { notifyNewEntry } = require('../services/bot');
        notifyNewEntry({ date, revenue: revenue||0, expense: expense||0, note });
      } catch(e) {}
    }
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
// INLINE EDIT daily
router.patch('/daily/:id', auth, (req, res) => {
  const allowed = ['revenue','expense','note'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'No valid fields' });
  const sets = updates.map(([k]) => `${k}=?`).join(',');
  db.prepare(`UPDATE daily_entries SET ${sets} WHERE id=?`).run(...updates.map(([,v]) => v), req.params.id);
  res.json({ ok: true });
});
router.delete('/daily/:id', auth, (req, res) => {
  const row = db.prepare('SELECT date FROM daily_entries WHERE id=?').get(req.params.id);
  if (row) db.prepare('DELETE FROM partner_daily WHERE date=?').run(row.date);
  db.prepare('DELETE FROM daily_entries WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// EXPENSES
router.get('/expenses', auth, (req, res) => {
  const prefix = qs(req.query.month, req.query.year);
  res.json(prefix ? db.prepare("SELECT * FROM account_expenses WHERE date LIKE ? ORDER BY date DESC").all(`${prefix}%`) : db.prepare("SELECT * FROM account_expenses ORDER BY date DESC LIMIT 100").all());
});
router.post('/expenses', auth, (req, res) => {
  const { date, category, description, amount, receipt_url } = req.body;
  try {
    const r = db.prepare(`INSERT INTO account_expenses (date,category,description,amount,receipt_url) VALUES (?,?,?,?,?)`).run(date, category, description, amount, receipt_url||'');
    // Notify
    const notifyExp = getSetting('notify_new_expense', false);
    if (notifyExp) {
      try { require('../services/bot').notifyNewExpense({ date, category, description, amount }); } catch(e) {}
    }
    // Check budget limit
    try {
      const month = date.slice(0,7);
      const budget = db.prepare(`SELECT amount FROM budgets WHERE month=? AND type=?`).get(month, `cat_${category}`);
      if (budget) {
        const spent = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM account_expenses WHERE date LIKE ? AND category=?`).get(`${month}%`, category).total;
        if (spent > budget.amount) {
          const notifyBudget = getSetting('notify_budget_exceeded', false);
          if (notifyBudget) require('../services/bot').notifyBudgetExceeded(category, spent, budget.amount);
        }
      }
    } catch(e) {}
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
router.patch('/expenses/:id', auth, (req, res) => {
  const allowed = ['amount','description','category','date'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  const sets = updates.map(([k]) => `${k}=?`).join(',');
  db.prepare(`UPDATE account_expenses SET ${sets} WHERE id=?`).run(...updates.map(([,v]) => v), req.params.id);
  res.json({ ok: true });
});
router.delete('/expenses/:id', auth, (req, res) => {
  const row = db.prepare('SELECT receipt_file FROM account_expenses WHERE id=?').get(req.params.id);
  if (row?.receipt_file) { const fp = path.join(__dirname, '..', 'uploads', row.receipt_file); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
  db.prepare('DELETE FROM account_expenses WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// FILE UPLOAD (generic)
router.post('/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const r = db.prepare(`INSERT INTO receipt_files (filename,original_name,mimetype,size,linked_type,linked_id) VALUES (?,?,?,?,?,?)`).run(req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.body.type||null, req.body.id||null);
  // Link to record
  if (req.body.type === 'expense' && req.body.id) db.prepare('UPDATE account_expenses SET receipt_file=? WHERE id=?').run(req.file.filename, req.body.id);
  if (req.body.type === 'ad' && req.body.id) db.prepare('UPDATE ads SET screenshot_file=? WHERE id=?').run(req.file.filename, req.body.id);
  if (req.body.type === 'investment' && req.body.id) db.prepare('UPDATE investments SET receipt_file=? WHERE id=?').run(req.file.filename, req.body.id);
  res.json({ ok: true, filename: req.file.filename, url: `/uploads/${req.file.filename}` });
});

// RECEIPTS GALLERY
router.get('/receipts', auth, (req, res) => res.json(db.prepare('SELECT * FROM receipt_files ORDER BY uploaded_at DESC LIMIT 200').all()));
router.delete('/receipts/:filename', auth, (req, res) => {
  const fp = path.join(__dirname, '..', 'uploads', req.params.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.prepare('DELETE FROM receipt_files WHERE filename=?').run(req.params.filename);
  res.json({ ok: true });
});

// ADS
router.get('/ads', auth, (req, res) => {
  const prefix = qs(req.query.month, req.query.year);
  res.json(prefix ? db.prepare("SELECT * FROM ads WHERE date LIKE ? ORDER BY date DESC").all(`${prefix}%`) : db.prepare("SELECT * FROM ads ORDER BY date DESC LIMIT 100").all());
});
router.post('/ads', auth, (req, res) => {
  const { date, format, amount, name, subscribers_gain, channel_url, screenshot_url } = req.body;
  try {
    const r = db.prepare(`INSERT INTO ads (date,format,amount,name,subscribers_gain,channel_url,screenshot_url) VALUES (?,?,?,?,?,?,?)`).run(date, format||'', amount, name, subscribers_gain||0, channel_url||'', screenshot_url||'');
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
router.patch('/ads/:id', auth, (req, res) => {
  const allowed = ['amount','name','format','subscribers_gain'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  const sets = updates.map(([k]) => `${k}=?`).join(',');
  db.prepare(`UPDATE ads SET ${sets} WHERE id=?`).run(...updates.map(([,v]) => v), req.params.id);
  res.json({ ok: true });
});
router.delete('/ads/:id', auth, (req, res) => { db.prepare('DELETE FROM ads WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// ROI Analytics
router.get('/ads/roi', auth, (req, res) => {
  const { year } = req.query;
  const y = year || new Date().getFullYear();
  const adsByMonth = db.prepare(`SELECT strftime('%Y-%m',date) as month, SUM(amount) as ad_spend, SUM(subscribers_gain) as subs FROM ads WHERE date LIKE ? GROUP BY month ORDER BY month`).all(`${y}%`);
  const revenueByMonth = db.prepare(`SELECT strftime('%Y-%m',date) as month, SUM(revenue) as revenue FROM daily_entries WHERE date LIKE ? GROUP BY month ORDER BY month`).all(`${y}%`);
  const revMap = Object.fromEntries(revenueByMonth.map(r => [r.month, r.revenue]));
  const result = adsByMonth.map(a => ({ ...a, revenue: revMap[a.month] || 0, roi: a.ad_spend > 0 ? (((revMap[a.month]||0) - a.ad_spend) / a.ad_spend * 100).toFixed(1) : null }));
  res.json(result);
});

// INVESTMENTS
router.get('/investments', auth, (req, res) => {
  const prefix = qs(req.query.month, req.query.year);
  const base = `SELECT i.*, p.name as partner_name, p.color as partner_color FROM investments i LEFT JOIN partners p ON p.id=i.partner_id`;
  res.json(prefix ? db.prepare(`${base} WHERE i.date LIKE ? ORDER BY i.date DESC`).all(`${prefix}%`) : db.prepare(`${base} ORDER BY i.date DESC LIMIT 100`).all());
});
router.post('/investments', auth, (req, res) => {
  const { date, partner_id, type, category, amount, receipt_url, note } = req.body;
  try {
    const r = db.prepare(`INSERT INTO investments (date,partner_id,type,category,amount,receipt_url,note) VALUES (?,?,?,?,?,?,?)`).run(date, partner_id||null, type||'expense', category||'', amount, receipt_url||'', note||'');
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
router.delete('/investments/:id', auth, (req, res) => { db.prepare('DELETE FROM investments WHERE id=?').run(req.params.id); res.json({ ok: true }); });

router.get('/investor-summary', auth, (req, res) => {
  const investors = db.prepare("SELECT * FROM partners WHERE role='investor' AND active=1").all();
  res.json(investors.map(p => {
    const invested = db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM investments WHERE partner_id=? AND type='invested'`).get(p.id).t;
    const returned = db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM investments WHERE partner_id=? AND type='returned'`).get(p.id).t + db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM partner_daily WHERE partner_id=? AND type='investment_return'`).get(p.id).t;
    return { ...p, invested, returned, remaining: Math.max(0, invested - returned) };
  }));
});

// MONTHLY STATS
router.get('/monthly-stats', auth, (req, res) => res.json(db.prepare('SELECT * FROM monthly_stats ORDER BY month').all()));
router.post('/monthly-stats', auth, (req, res) => {
  const { month, avg_check, payment_count, refunds, tag_paid, online_users, online_week, channel_subscribers, notes } = req.body;
  db.prepare(`INSERT INTO monthly_stats (month,avg_check,payment_count,refunds,tag_paid,online_users,online_week,channel_subscribers,notes) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(month) DO UPDATE SET avg_check=excluded.avg_check,payment_count=excluded.payment_count,refunds=excluded.refunds,tag_paid=excluded.tag_paid,online_users=excluded.online_users,online_week=excluded.online_week,channel_subscribers=excluded.channel_subscribers,notes=excluded.notes`).run(month, avg_check||null, payment_count||null, refunds||null, tag_paid||null, online_users||null, online_week||null, channel_subscribers||null, notes||'');
  res.json({ ok: true });
});

// BUDGETS
router.get('/budgets', auth, (req, res) => {
  const { month } = req.query;
  res.json(month ? db.prepare('SELECT * FROM budgets WHERE month=?').all(month) : db.prepare('SELECT * FROM budgets ORDER BY month DESC').all());
});
router.post('/budgets', auth, (req, res) => {
  const { month, type, amount } = req.body;
  db.prepare('INSERT OR REPLACE INTO budgets (month,type,amount) VALUES (?,?,?)').run(month, type, amount||0);
  res.json({ ok: true });
});
router.delete('/budgets/:id', auth, (req, res) => { db.prepare('DELETE FROM budgets WHERE id=?').run(req.params.id); res.json({ ok: true }); });

// STATS / DASHBOARD
router.get('/stats', auth, (req, res) => {
  const { month, year } = req.query;
  const prefix = qs(month, year) || new Date().toISOString().slice(0,7);
  const balance = db.prepare(`SELECT SUM(revenue) as revenue, SUM(expense) as expense, SUM(revenue)-SUM(expense) as net FROM daily_entries WHERE date LIKE ?`).get(`${prefix}%`);
  const accExp = db.prepare(`SELECT SUM(amount) as total, COUNT(*) as cnt FROM account_expenses WHERE date LIKE ?`).get(`${prefix}%`);
  const expByCat = db.prepare(`SELECT category, SUM(amount) as total FROM account_expenses WHERE date LIKE ? GROUP BY category`).all(`${prefix}%`);
  const monthly = db.prepare(`SELECT strftime('%Y-%m',date) as month, SUM(revenue) as total_revenue, SUM(expense) as total_expense, COUNT(*) as days_count, AVG(revenue) as avg_daily, MAX(revenue) as max_day FROM daily_entries GROUP BY strftime('%Y-%m',date) ORDER BY month`).all();
  const adStats = db.prepare(`SELECT strftime('%Y-%m',date) as month, SUM(amount) as total_spent, SUM(subscribers_gain) as total_subs, COUNT(*) as campaigns FROM ads GROUP BY month ORDER BY month`).all();
  const today = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
  const daysPassed = today.getDate();
  const avgDay = (balance?.revenue || 0) / Math.max(daysPassed, 1);
  const forecast = Math.round(avgDay * daysInMonth);
  const partners = db.prepare('SELECT * FROM partners WHERE active=1 ORDER BY sort_order,id').all();
  const partnerMonthly = partners.map(p => ({ ...p, month_total: db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM partner_daily WHERE partner_id=? AND date LIKE ?`).get(p.id, `${prefix}%`).t }));
  // Sparkline data (last 14 days)
  const sparkData = db.prepare(`SELECT date, revenue, expense FROM daily_entries WHERE date >= date('now','-14 days') ORDER BY date`).all();
  res.json({ balance, accExp, expByCat, monthly, adStats, forecast, daysInMonth, daysPassed, partnerMonthly, sparkData });
});

// HEATMAP
router.get('/heatmap', auth, (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const rows = db.prepare(`SELECT date, revenue FROM daily_entries WHERE date LIKE ? ORDER BY date`).all(`${year}%`);
  res.json(rows);
});

// SEARCH
router.get('/search', auth, (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const like = `%${q}%`;
  const results = [];
  db.prepare(`SELECT id,'expense' as type, date, description as title, amount FROM account_expenses WHERE description LIKE ? OR category LIKE ? LIMIT 10`).all(like, like).forEach(r => results.push(r));
  db.prepare(`SELECT id,'ad' as type, date, name as title, amount FROM ads WHERE name LIKE ? OR channel_url LIKE ? LIMIT 10`).all(like, like).forEach(r => results.push(r));
  db.prepare(`SELECT id,'daily' as type, date, note as title, revenue as amount FROM daily_entries WHERE note LIKE ? OR date LIKE ? LIMIT 10`).all(like, like).forEach(r => results.push(r));
  results.sort((a,b) => b.date?.localeCompare(a.date));
  res.json({ results: results.slice(0, 20) });
});

// DISTRIBUTION CALC
router.post('/distribution/calculate', auth, (req, res) => {
  const { net_profit } = req.body;
  if (!net_profit) return res.status(400).json({ error: 'net_profit required' });
  const partners = db.prepare("SELECT * FROM partners WHERE active=1 AND share_type != 'none' ORDER BY sort_order").all();
  let remaining = net_profit;
  const result = [];
  for (const p of partners.filter(x => x.share_type === 'fixed')) {
    const amount = Math.min(p.share_value, remaining);
    result.push({ ...p, amount, pct: (amount / net_profit * 100).toFixed(1) });
    remaining -= amount;
  }
  for (const p of partners.filter(x => x.share_type === 'percent')) {
    const amount = remaining * (p.share_value / 100);
    result.push({ ...p, amount: Math.round(amount * 100) / 100, pct: p.share_value });
  }
  res.json({ net_profit, distribution: result, undistributed: remaining });
});

// EXPORT
router.get('/export/json', auth, (req, res) => {
  const backup = { exported_at: new Date().toISOString(), partners: db.prepare('SELECT * FROM partners').all(), daily_entries: db.prepare('SELECT * FROM daily_entries').all(), partner_daily: db.prepare('SELECT * FROM partner_daily').all(), account_expenses: db.prepare('SELECT * FROM account_expenses').all(), investments: db.prepare('SELECT * FROM investments').all(), ads: db.prepare('SELECT * FROM ads').all(), monthly_stats: db.prepare('SELECT * FROM monthly_stats').all() };
  res.setHeader('Content-Disposition', `attachment; filename="baza_backup_${new Date().toISOString().slice(0,10)}.json"`);
  res.json(backup);
});
router.get('/export/excel', auth, async (req, res) => {
  try {
    const buf = await require('../services/excel').generateMonthlyExcel(req.query.year || new Date().getFullYear(), req.query.month || new Date().getMonth()+1);
    const mn = `${req.query.year||new Date().getFullYear()}_${String(req.query.month||new Date().getMonth()+1).padStart(2,'0')}`;
    res.setHeader('Content-Disposition', `attachment; filename="baza_${mn}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
router.post('/import/json', auth, (req, res) => {
  const data = req.body;
  const results = { daily: 0, expenses: 0, ads: 0 };
  try {
    db.transaction(() => {
      if (Array.isArray(data.daily_entries)) { const ins = db.prepare(`INSERT OR IGNORE INTO daily_entries (date,revenue,expense,note) VALUES (?,?,?,?)`); for (const r of data.daily_entries) { ins.run(r.date, r.revenue||0, r.expense||0, r.note||''); results.daily++; } }
      if (Array.isArray(data.account_expenses)) { const ins = db.prepare(`INSERT INTO account_expenses (date,category,description,amount,receipt_url) VALUES (?,?,?,?,?)`); for (const r of data.account_expenses) { ins.run(r.date, r.category||'Прочее', r.description||'', r.amount||0, r.receipt_url||''); results.expenses++; } }
      if (Array.isArray(data.ads)) { const ins = db.prepare(`INSERT INTO ads (date,format,amount,name,subscribers_gain,channel_url) VALUES (?,?,?,?,?,?)`); for (const r of data.ads) { ins.run(r.date, r.format||'', r.amount||0, r.name||'', r.subscribers_gain||0, r.channel_url||''); results.ads++; } }
    })();
    res.json({ ok: true, imported: results });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.post('/report/send', auth, async (req, res) => {
  try { await require('../services/telegram').sendDailyReport(); res.json({ ok: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

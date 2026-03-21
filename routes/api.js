const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const db       = require('../database/db');
const auth     = require('../middleware/auth');

// ── Multer для чеков ──────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = `receipt_${Date.now()}${ext}`;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /jpeg|jpg|png|gif|webp|pdf/.test(file.mimetype);
    cb(ok ? null : new Error('Только изображения и PDF'), ok);
  }
});

const qs = (m, y) => {
  if (!m || !y) return null;
  return `${y}-${String(m).padStart(2,'0')}`;
};

// ── AUTH ──────────────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  const { password } = req.body;
  const valid = await bcrypt.compare(password, process.env.ADMIN_HASH);
  if (!valid) return res.status(401).json({ error: 'Неверный пароль' });
  const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly: true, maxAge: 30*24*3600*1000, sameSite: 'lax' });
  res.json({ ok: true });
});
router.post('/auth/logout', (req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

// ── PARTNERS ──────────────────────────────────────────────────────────────
router.get('/partners', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM partners ORDER BY sort_order,id').all());
});
router.post('/partners', auth, (req, res) => {
  const { name, role, share_type, share_value, color, tg_chat_id, sort_order } = req.body;
  try {
    const r = db.prepare(`INSERT INTO partners (name,role,share_type,share_value,color,tg_chat_id,sort_order)
                          VALUES (?,?,?,?,?,?,?)`).run(name, role||'owner', share_type||'none',
                          share_value||0, color||'#00e5ff', tg_chat_id||'', sort_order||0);
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
router.put('/partners/:id', auth, (req, res) => {
  const { name, role, share_type, share_value, color, tg_chat_id, sort_order, active } = req.body;
  try {
    db.prepare(`UPDATE partners SET name=?,role=?,share_type=?,share_value=?,color=?,
                tg_chat_id=?,sort_order=?,active=? WHERE id=?`)
      .run(name, role, share_type, share_value||0, color, tg_chat_id||'',
           sort_order||0, active??1, req.params.id);
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
router.delete('/partners/:id', auth, (req, res) => {
  db.prepare('DELETE FROM partners WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── DAILY ENTRIES ─────────────────────────────────────────────────────────
router.get('/daily', auth, (req, res) => {
  const { month, year } = req.query;
  const prefix = qs(month, year);
  const rows = prefix
    ? db.prepare("SELECT * FROM daily_entries WHERE date LIKE ? ORDER BY date DESC").all(`${prefix}%`)
    : db.prepare("SELECT * FROM daily_entries ORDER BY date DESC LIMIT 62").all();
  // Обогащаем снятиями партнёров
  const withPartners = rows.map(r => {
    const pw = db.prepare(`SELECT pd.*, p.name, p.color, p.role FROM partner_daily pd
                           JOIN partners p ON p.id=pd.partner_id WHERE pd.date=?`).all(r.date);
    return { ...r, partner_withdrawals: pw };
  });
  res.json(withPartners);
});

router.post('/daily', auth, (req, res) => {
  const { date, revenue, expense, note, partner_withdrawals } = req.body;
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO daily_entries (date,revenue,expense,note)
                  VALUES (?,?,?,?)
                  ON CONFLICT(date) DO UPDATE SET
                    revenue=excluded.revenue, expense=excluded.expense, note=excluded.note`)
        .run(date, revenue||0, expense||0, note||'');

      if (Array.isArray(partner_withdrawals)) {
        db.prepare('DELETE FROM partner_daily WHERE date=?').run(date);
        const ins = db.prepare(`INSERT INTO partner_daily (date,partner_id,amount,type,note)
                                VALUES (?,?,?,?,?)`);
        for (const pw of partner_withdrawals) {
          if (pw.amount > 0) ins.run(date, pw.partner_id, pw.amount, pw.type||'withdrawal', pw.note||'');
        }
      }
    })();
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

router.delete('/daily/:id', auth, (req, res) => {
  const row = db.prepare('SELECT date FROM daily_entries WHERE id=?').get(req.params.id);
  if (row) db.prepare('DELETE FROM partner_daily WHERE date=?').run(row.date);
  db.prepare('DELETE FROM daily_entries WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── ACCOUNT EXPENSES ──────────────────────────────────────────────────────
router.get('/expenses', auth, (req, res) => {
  const { month, year } = req.query;
  const prefix = qs(month, year);
  const rows = prefix
    ? db.prepare("SELECT * FROM account_expenses WHERE date LIKE ? ORDER BY date DESC").all(`${prefix}%`)
    : db.prepare("SELECT * FROM account_expenses ORDER BY date DESC LIMIT 100").all();
  res.json(rows);
});
router.post('/expenses', auth, (req, res) => {
  const { date, category, description, amount, receipt_url } = req.body;
  try {
    const r = db.prepare(`INSERT INTO account_expenses (date,category,description,amount,receipt_url)
                          VALUES (?,?,?,?,?)`).run(date, category, description, amount, receipt_url||'');
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
router.delete('/expenses/:id', auth, (req, res) => {
  const row = db.prepare('SELECT receipt_file FROM account_expenses WHERE id=?').get(req.params.id);
  if (row?.receipt_file) {
    const fp = path.join(__dirname, '..', 'uploads', row.receipt_file);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.prepare('DELETE FROM account_expenses WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── RECEIPT UPLOAD ────────────────────────────────────────────────────────
router.post('/receipts/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  const r = db.prepare(`INSERT INTO receipt_files (filename,original_name,mimetype,size)
                        VALUES (?,?,?,?)`).run(req.file.filename, req.file.originalname,
                        req.file.mimetype, req.file.size);
  // Если передан expense_id — привязываем
  if (req.body.expense_id) {
    db.prepare('UPDATE account_expenses SET receipt_file=? WHERE id=?')
      .run(req.file.filename, req.body.expense_id);
  }
  res.json({ ok: true, filename: req.file.filename, url: `/uploads/${req.file.filename}` });
});
router.get('/receipts', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM receipt_files ORDER BY uploaded_at DESC LIMIT 100').all());
});

// ── ADS ───────────────────────────────────────────────────────────────────
router.get('/ads', auth, (req, res) => {
  const { month, year } = req.query;
  const prefix = qs(month, year);
  const rows = prefix
    ? db.prepare("SELECT * FROM ads WHERE date LIKE ? ORDER BY date DESC").all(`${prefix}%`)
    : db.prepare("SELECT * FROM ads ORDER BY date DESC LIMIT 100").all();
  res.json(rows);
});
router.post('/ads', auth, (req, res) => {
  const { date, format, amount, name, subscribers_gain, channel_url, screenshot_url } = req.body;
  try {
    const r = db.prepare(`INSERT INTO ads (date,format,amount,name,subscribers_gain,channel_url,screenshot_url)
                          VALUES (?,?,?,?,?,?,?)`).run(date, format||'', amount, name,
                          subscribers_gain||0, channel_url||'', screenshot_url||'');
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
router.delete('/ads/:id', auth, (req, res) => {
  db.prepare('DELETE FROM ads WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── INVESTMENTS ───────────────────────────────────────────────────────────
router.get('/investments', auth, (req, res) => {
  const { month, year } = req.query;
  const prefix = qs(month, year);
  const base = `SELECT i.*, p.name as partner_name, p.color as partner_color
                FROM investments i LEFT JOIN partners p ON p.id=i.partner_id`;
  const rows = prefix
    ? db.prepare(`${base} WHERE i.date LIKE ? ORDER BY i.date DESC`).all(`${prefix}%`)
    : db.prepare(`${base} ORDER BY i.date DESC LIMIT 100`).all();
  res.json(rows);
});
router.post('/investments', auth, (req, res) => {
  const { date, partner_id, type, category, amount, receipt_url, note } = req.body;
  try {
    const r = db.prepare(`INSERT INTO investments (date,partner_id,type,category,amount,receipt_url,note)
                          VALUES (?,?,?,?,?,?,?)`).run(date, partner_id||null, type||'expense',
                          category||'', amount, receipt_url||'', note||'');
    res.json({ ok: true, id: r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: e.message }); }
});
router.delete('/investments/:id', auth, (req, res) => {
  db.prepare('DELETE FROM investments WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── INVESTOR SUMMARY ──────────────────────────────────────────────────────
router.get('/investor-summary', auth, (req, res) => {
  const investors = db.prepare("SELECT * FROM partners WHERE role='investor' AND active=1").all();
  const result = investors.map(p => {
    const invested = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM investments
                                 WHERE partner_id=? AND type='invested'`).get(p.id).total;
    const returned = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM investments
                                 WHERE partner_id=? AND type='returned'`).get(p.id).total
                   + db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM partner_daily
                                 WHERE partner_id=? AND type='investment_return'`).get(p.id).total;
    return { ...p, invested, returned, remaining: Math.max(0, invested - returned) };
  });
  res.json(result);
});

// ── MONTHLY STATS ─────────────────────────────────────────────────────────
router.get('/monthly-stats', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM monthly_stats ORDER BY month').all());
});
router.post('/monthly-stats', auth, (req, res) => {
  const { month, avg_check, payment_count, refunds, tag_paid,
          online_users, online_week, channel_subscribers, notes } = req.body;
  try {
    db.prepare(`INSERT INTO monthly_stats
                  (month,avg_check,payment_count,refunds,tag_paid,online_users,online_week,channel_subscribers,notes)
                VALUES (?,?,?,?,?,?,?,?,?)
                ON CONFLICT(month) DO UPDATE SET
                  avg_check=excluded.avg_check, payment_count=excluded.payment_count,
                  refunds=excluded.refunds, tag_paid=excluded.tag_paid,
                  online_users=excluded.online_users, online_week=excluded.online_week,
                  channel_subscribers=excluded.channel_subscribers, notes=excluded.notes`)
      .run(month, avg_check||null, payment_count||null, refunds||null,
           tag_paid||null, online_users||null, online_week||null,
           channel_subscribers||null, notes||'');
    res.json({ ok: true });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ── STATS / DASHBOARD ─────────────────────────────────────────────────────
router.get('/stats', auth, (req, res) => {
  const { month, year } = req.query;
  const prefix = qs(month, year) || new Date().toISOString().slice(0,7);

  const balance = db.prepare(`SELECT SUM(revenue) as revenue, SUM(expense) as expense,
                               SUM(revenue)-SUM(expense) as net
                               FROM daily_entries WHERE date LIKE ?`).get(`${prefix}%`);

  const accExp = db.prepare(`SELECT SUM(amount) as total, COUNT(*) as cnt
                              FROM account_expenses WHERE date LIKE ?`).get(`${prefix}%`);

  const expByCat = db.prepare(`SELECT category, SUM(amount) as total
                                FROM account_expenses WHERE date LIKE ?
                                GROUP BY category`).all(`${prefix}%`);

  const monthly = db.prepare(`SELECT strftime('%Y-%m',date) as month,
                               SUM(revenue) as total_revenue, SUM(expense) as total_expense,
                               COUNT(*) as days_count, AVG(revenue) as avg_daily, MAX(revenue) as max_day
                               FROM daily_entries GROUP BY strftime('%Y-%m',date) ORDER BY month`).all();

  const adStats = db.prepare(`SELECT strftime('%Y-%m',date) as month,
                               SUM(amount) as total_spent, SUM(subscribers_gain) as total_subs,
                               COUNT(*) as campaigns FROM ads GROUP BY month ORDER BY month`).all();

  // Прогноз до конца месяца
  const today = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
  const daysPassed  = today.getDate();
  const avgDay = (balance?.revenue || 0) / Math.max(daysPassed, 1);
  const forecast = Math.round(avgDay * daysInMonth);

  // Партнёры с итогами по месяцу
  const partners = db.prepare('SELECT * FROM partners WHERE active=1 ORDER BY sort_order,id').all();
  const partnerMonthly = partners.map(p => {
    const total = db.prepare(`SELECT COALESCE(SUM(amount),0) as total FROM partner_daily
                              WHERE partner_id=? AND date LIKE ?`).get(p.id, `${prefix}%`).total;
    return { ...p, month_total: total };
  });

  res.json({ balance, accExp, expByCat, monthly, adStats, forecast, daysInMonth, daysPassed, partnerMonthly });
});

// ── DISTRIBUTION CALCULATOR ───────────────────────────────────────────────
router.post('/distribution/calculate', auth, (req, res) => {
  const { net_profit } = req.body;
  if (!net_profit) return res.status(400).json({ error: 'net_profit required' });

  const partners = db.prepare("SELECT * FROM partners WHERE active=1 AND share_type != 'none' ORDER BY sort_order").all();
  let remaining = net_profit;
  const result = [];

  // Сначала фиксированные
  for (const p of partners.filter(x => x.share_type === 'fixed')) {
    const amount = Math.min(p.share_value, remaining);
    result.push({ ...p, amount, pct: (amount / net_profit * 100).toFixed(1) });
    remaining -= amount;
  }
  // Потом процентные (от остатка)
  for (const p of partners.filter(x => x.share_type === 'percent')) {
    const amount = remaining * (p.share_value / 100);
    result.push({ ...p, amount: Math.round(amount * 100) / 100, pct: p.share_value });
  }

  res.json({ net_profit, distribution: result, undistributed: remaining });
});

// ── EXPORT JSON (полный бэкап) ────────────────────────────────────────────
router.get('/export/json', auth, (req, res) => {
  const backup = {
    exported_at: new Date().toISOString(),
    partners:         db.prepare('SELECT * FROM partners').all(),
    daily_entries:    db.prepare('SELECT * FROM daily_entries').all(),
    partner_daily:    db.prepare('SELECT * FROM partner_daily').all(),
    account_expenses: db.prepare('SELECT * FROM account_expenses').all(),
    investments:      db.prepare('SELECT * FROM investments').all(),
    ads:              db.prepare('SELECT * FROM ads').all(),
    monthly_stats:    db.prepare('SELECT * FROM monthly_stats').all(),
  };
  res.setHeader('Content-Disposition', `attachment; filename="baza_backup_${new Date().toISOString().slice(0,10)}.json"`);
  res.json(backup);
});

// ── EXPORT EXCEL ──────────────────────────────────────────────────────────
router.get('/export/excel', auth, async (req, res) => {
  const { month, year } = req.query;
  try {
    const { generateMonthlyExcel } = require('../services/excel');
    const buf = await generateMonthlyExcel(
      year  || new Date().getFullYear(),
      month || new Date().getMonth() + 1
    );
    const mn = `${year||new Date().getFullYear()}_${String(month||new Date().getMonth()+1).padStart(2,'0')}`;
    res.setHeader('Content-Disposition', `attachment; filename="baza_${mn}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── IMPORT CSV/JSON ───────────────────────────────────────────────────────
router.post('/import/json', auth, (req, res) => {
  const data = req.body;
  const results = { daily: 0, expenses: 0, ads: 0, investments: 0 };
  try {
    db.transaction(() => {
      if (Array.isArray(data.daily_entries)) {
        const ins = db.prepare(`INSERT OR IGNORE INTO daily_entries (date,revenue,expense,note) VALUES (?,?,?,?)`);
        for (const r of data.daily_entries) { ins.run(r.date, r.revenue||0, r.expense||0, r.note||''); results.daily++; }
      }
      if (Array.isArray(data.account_expenses)) {
        const ins = db.prepare(`INSERT INTO account_expenses (date,category,description,amount,receipt_url) VALUES (?,?,?,?,?)`);
        for (const r of data.account_expenses) { ins.run(r.date, r.category||'Прочее', r.description||'', r.amount||0, r.receipt_url||''); results.expenses++; }
      }
      if (Array.isArray(data.ads)) {
        const ins = db.prepare(`INSERT INTO ads (date,format,amount,name,subscribers_gain,channel_url) VALUES (?,?,?,?,?,?)`);
        for (const r of data.ads) { ins.run(r.date, r.format||'', r.amount||0, r.name||'', r.subscribers_gain||0, r.channel_url||''); results.ads++; }
      }
    })();
    res.json({ ok: true, imported: results });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// ── SEND REPORT ───────────────────────────────────────────────────────────
router.post('/report/send', auth, async (req, res) => {
  try {
    await require('../services/telegram').sendDailyReport();
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

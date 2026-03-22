const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const db       = require('../database/db');
const auth     = require('../middleware/auth');
const { authEditor, authAdmin } = require('../middleware/auth');

// ── Multer ────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { const d=path.join(__dirname,'..','uploads'); if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true}); cb(null,d); },
    filename: (req, file, cb) => cb(null, `file_${Date.now()}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 15*1024*1024 },
  fileFilter: (req, file, cb) => { const ok=/jpeg|jpg|png|gif|webp|pdf/.test(file.mimetype); cb(ok?null:new Error('Images/PDF only'), ok); }
});

// ── Audit logger ──────────────────────────────────────────────────────────
function audit(req, action, entity, entity_id, details) {
  try {
    db.prepare(`INSERT INTO audit_log (user_id,action,entity,entity_id,details,ip) VALUES (?,?,?,?,?,?)`).run(
      req.user?.id||null, action, entity||null, entity_id||null,
      details ? JSON.stringify(details) : null,
      req.headers['x-forwarded-for']?.split(',')[0] || req.connection?.remoteAddress
    );
  } catch(e) {}
}

function getSetting(key, fallback=null) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

const qs = (m,y) => (m&&y) ? `${y}-${String(m).padStart(2,'0')}` : null;

// ── AUTH ──────────────────────────────────────────────────────────────────

// Настройки cookie — secure нужен на HTTPS
function cookieOpts() {
  const isHttps = process.env.COOKIE_SECURE === 'true'
    || process.env.NODE_ENV === 'production'
    || (process.env.SITE_URL || '').startsWith('https');
  return {
    httpOnly: true,
    maxAge: 30 * 24 * 3600 * 1000,
    sameSite: isHttps ? 'none' : 'lax',
    secure: isHttps,
    path: '/',
  };
}

router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Введи логин и пароль' });

  // ── Admin через ADMIN_PASSWORD из .env ─────────────────────────────────
  if (username === 'admin' && process.env.ADMIN_PASSWORD) {
    const validDirect = (password === process.env.ADMIN_PASSWORD);
    let validHash = false;
    if (process.env.ADMIN_HASH) {
      try { validHash = await bcrypt.compare(password, process.env.ADMIN_HASH); } catch {}
    }
    if (validDirect || validHash) {
      let user = db.prepare("SELECT * FROM users WHERE username='admin'").get();
      if (!user) {
        const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
        db.prepare("INSERT OR IGNORE INTO users (username,password,role,active) VALUES ('admin',?,'admin',1)").run(hash);
        user = db.prepare("SELECT * FROM users WHERE username='admin'").get();
      }
      if (!user) return res.status(500).json({ error: 'Ошибка создания пользователя' });
      const token = jwt.sign({ user_id: user.id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30d' });
      res.cookie('token', token, cookieOpts());
      try { audit(req, 'login', 'user', user.id, { username: 'admin' }); } catch {}
      return res.json({ ok: true, role: 'admin', username: 'admin' });
    }
    return res.status(401).json({ error: 'Неверный пароль' });
  }

  // ── Обычный пользователь из БД ─────────────────────────────────────────
  const user = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  if (!user || !user.password) return res.status(401).json({ error: 'Пользователь не найден' });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: 'Неверный пароль' });
  const token = jwt.sign({ user_id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, cookieOpts());
  try { audit(req, 'login', 'user', user.id, { username: user.username }); } catch {}
  res.json({ ok: true, role: user.role, username: user.username });
});

// Telegram auth (widget callback)
router.post('/auth/telegram', async (req, res) => {
  const { id, first_name, last_name, username, photo_url, hash, auth_date } = req.body;
  const botToken = getSetting('tg_bot_token') || process.env.TG_BOT_TOKEN;
  if (!botToken) return res.status(503).json({ error: 'Бот не настроен' });

  // Verify TG signature
  const secret = crypto.createHash('sha256').update(botToken).digest();
  const dataStr = Object.entries({ id, first_name, last_name, username, photo_url, auth_date })
    .filter(([,v]) => v != null).sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}=${v}`).join('\n');
  const expectedHash = crypto.createHmac('sha256', secret).update(dataStr).digest('hex');
  if (expectedHash !== hash) return res.status(401).json({ error: 'Подпись TG не прошла' });
  if (Date.now()/1000 - +auth_date > 86400) return res.status(401).json({ error: 'Токен TG устарел' });

  let user = db.prepare('SELECT * FROM users WHERE tg_id=?').get(String(id));
  if (!user) return res.status(403).json({ error: 'Нет доступа. Запросите приглашение у администратора.' });
  if (!user.active) return res.status(403).json({ error: 'Аккаунт деактивирован' });
  
  db.prepare('UPDATE users SET tg_username=?,tg_name=?,tg_avatar=? WHERE id=?').run(
    username||null, [first_name,last_name].filter(Boolean).join(' '), photo_url||null, user.id
  );
  const token = jwt.sign({ user_id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly:true, maxAge:30*24*3600*1000, sameSite:'lax' });
  audit(req,'login_tg','user',user.id,{tg_id:id,username});
  res.json({ ok:true, role:user.role, name:[first_name,last_name].filter(Boolean).join(' ') });
});

router.post('/auth/logout', auth, (req, res) => {
  audit(req,'logout','user',req.user?.id);
  res.clearCookie('token');
  res.json({ ok:true });
});

router.get('/auth/me', auth, (req, res) => {
  const u = db.prepare('SELECT id,username,tg_id,tg_username,tg_name,tg_avatar,role,last_seen FROM users WHERE id=?').get(req.user.id);
  res.json(u || req.user);
});

// ── USER MANAGEMENT (admin) ───────────────────────────────────────────────
router.get('/users', authAdmin, (req, res) => {
  res.json(db.prepare('SELECT id,username,tg_id,tg_username,tg_name,role,active,created_at,last_seen FROM users ORDER BY id').all());
});
router.post('/users', authAdmin, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username и password обязательны' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = db.prepare('INSERT INTO users (username,password,role) VALUES (?,?,?)').run(username, hash, role||'viewer');
    audit(req,'create_user','user',r.lastInsertRowid,{username,role});
    res.json({ ok:true, id:r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error: 'Имя занято: '+e.message }); }
});
router.put('/users/:id', authAdmin, async (req, res) => {
  const { role, active, password } = req.body;
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE users SET password=? WHERE id=?').run(hash, req.params.id);
  }
  if (role !== undefined) db.prepare('UPDATE users SET role=? WHERE id=?').run(role, req.params.id);
  if (active !== undefined) db.prepare('UPDATE users SET active=? WHERE id=?').run(active?1:0, req.params.id);
  audit(req,'update_user','user',req.params.id,{role,active});
  res.json({ ok:true });
});
router.delete('/users/:id', authAdmin, (req, res) => {
  if (+req.params.id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить себя' });
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  audit(req,'delete_user','user',req.params.id);
  res.json({ ok:true });
});

// ── INVITES ────────────────────────────────────────────────────────────────
router.get('/invites', authAdmin, (req, res) => {
  res.json(db.prepare(`SELECT i.*,u.username as used_by_name FROM invites i LEFT JOIN users u ON u.id=i.used_by ORDER BY i.id DESC LIMIT 50`).all());
});
router.post('/invites', authAdmin, (req, res) => {
  const { role, note, hours } = req.body;
  const token = crypto.randomBytes(20).toString('hex');
  const expires = new Date(Date.now() + (hours||24)*3600*1000).toISOString();
  db.prepare('INSERT INTO invites (token,role,created_by,expires_at,note) VALUES (?,?,?,?,?)').run(token, role||'viewer', req.user.id, expires, note||'');
  const siteUrl = getSetting('site_url') || 'https://hiprpol.hideyou.top';
  audit(req,'create_invite','invite',null,{role,token});
  res.json({ ok:true, token, url: `${siteUrl}/invite/${token}` });
});
router.delete('/invites/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM invites WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

// Claim invite (public endpoint — user visits link, then TG-authenticates)
router.get('/invites/check/:token', (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE token=?').get(req.params.token);
  if (!inv) return res.status(404).json({ error: 'Приглашение не найдено' });
  if (inv.used_at) return res.status(410).json({ error: 'Приглашение уже использовано' });
  if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: 'Приглашение истекло' });
  res.json({ ok:true, role: inv.role, note: inv.note });
});
router.post('/invites/use/:token', async (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE token=?').get(req.params.token);
  if (!inv || inv.used_at || new Date(inv.expires_at) < new Date())
    return res.status(410).json({ error: 'Приглашение недействительно' });
  const { tg_id, tg_username, tg_name, tg_avatar } = req.body;
  if (!tg_id) return res.status(400).json({ error: 'tg_id required' });
  
  let user = db.prepare('SELECT * FROM users WHERE tg_id=?').get(String(tg_id));
  if (user) {
    db.prepare('UPDATE users SET role=?,active=1 WHERE id=?').run(inv.role, user.id);
  } else {
    const r = db.prepare('INSERT INTO users (tg_id,tg_username,tg_name,tg_avatar,role) VALUES (?,?,?,?,?)').run(String(tg_id), tg_username||null, tg_name||null, tg_avatar||null, inv.role);
    user = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
  }
  db.prepare('UPDATE invites SET used_at=datetime("now"),used_by=? WHERE id=?').run(user.id, inv.id);
  const token = jwt.sign({ user_id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, { httpOnly:true, maxAge:30*24*3600*1000, sameSite:'lax' });
  res.json({ ok:true, role: user.role });
});

// ── AUDIT LOG ──────────────────────────────────────────────────────────────
router.get('/audit', authAdmin, (req, res) => {
  const { limit, offset } = req.query;
  const rows = db.prepare(`
    SELECT a.*, u.username, u.tg_username, u.role as user_role
    FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
    ORDER BY a.id DESC LIMIT ? OFFSET ?
  `).all(+limit||100, +offset||0);
  const total = db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c;
  res.json({ rows, total });
});

// ── SETTINGS ──────────────────────────────────────────────────────────────
router.get('/settings', auth, (req, res) => {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const obj = {};
  for (const r of rows) { try { obj[r.key]=JSON.parse(r.value); } catch { obj[r.key]=r.value; } }
  // Hide webhook secret from non-admins
  if (req.user.role !== 'admin') { delete obj.webhook_secret; delete obj.tg_bot_token; }
  res.json(obj);
});
router.post('/settings', authAdmin, (req, res) => {
  const ups = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  db.transaction(() => {
    for (const [k,v] of Object.entries(req.body))
      ups.run(k, typeof v==='object' ? JSON.stringify(v) : String(v));
  })();
  audit(req,'update_settings',null,null,{keys:Object.keys(req.body)});
  if (req.body.tg_bot_token) { try { require('../services/bot').restartBot(); } catch(e) {} }
  res.json({ ok:true });
});

// ── WEBHOOK (payment receiver) ────────────────────────────────────────────
router.post('/webhook/payment', async (req, res) => {
  const secret = getSetting('webhook_secret');
  if (secret) {
    const sigHeader = req.headers['x-webhook-secret'] || req.headers['x-signature'];
    if (sigHeader !== secret) {
      console.warn('[Webhook] Invalid secret from', req.ip);
      return res.status(401).json({ error: 'Invalid secret' });
    }
  }
  const body = req.body;
  const mode = body.mode || body.test ? 'test' : 'live';
  try {
    const payment = {
      payment_id:     body.payment_id || body.id || `auto_${Date.now()}`,
      amount:         parseFloat(body.amount || body.sum || 0),
      currency:       body.currency || 'RUB',
      customer_id:    body.customer_id || body.user_id || body.client_id || null,
      customer_email: body.email || body.customer_email || null,
      customer_name:  body.name || body.customer_name || body.fullname || null,
      product:        body.product || body.description || body.item || null,
      status:         body.status || 'success',
      mode,
      raw:            JSON.stringify(body),
    };
    if (payment.amount <= 0) return res.status(400).json({ error: 'amount must be > 0' });
    db.prepare(`INSERT OR IGNORE INTO payments (payment_id,amount,currency,customer_id,customer_email,customer_name,product,status,mode,raw)
                VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      payment.payment_id, payment.amount, payment.currency, payment.customer_id,
      payment.customer_email, payment.customer_name, payment.product,
      payment.status, payment.mode, payment.raw
    );
    // Add to daily revenue if live
    const autoAdd = getSetting('webhook_auto_revenue', true);
    if (autoAdd && mode === 'live' && payment.status === 'success') {
      const today = new Date().toISOString().slice(0,10);
      db.prepare(`INSERT INTO daily_entries (date,revenue,expense,note) VALUES (?,?,0,'')
                  ON CONFLICT(date) DO UPDATE SET revenue=revenue+excluded.revenue`).run(today, payment.amount);
    }
    // Notify
    const notify = getSetting('notify_new_payment', true);
    if (notify && mode === 'live') {
      try {
        const { sendMsg, getMainChannel } = require('../services/bot');
        const ch = getMainChannel();
        if (ch) sendMsg(ch, `💳 <b>Новая оплата!</b>\n💰 ${payment.amount.toLocaleString('ru')} ${payment.currency}\n👤 ${payment.customer_name||payment.customer_email||payment.customer_id||'—'}\n📦 ${payment.product||'—'}`);
      } catch(e) {}
    }
    console.log(`[Webhook] Payment received: ${payment.amount} ${payment.currency} mode=${mode}`);
    res.json({ ok:true, received: true, mode });
  } catch(e) {
    console.error('[Webhook] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/webhook/payments', authAdmin, (req, res) => {
  const { mode, limit } = req.query;
  const rows = mode
    ? db.prepare('SELECT * FROM payments WHERE mode=? ORDER BY received_at DESC LIMIT ?').all(mode, +limit||100)
    : db.prepare('SELECT * FROM payments ORDER BY received_at DESC LIMIT ?').all(+limit||100);
  const stats = db.prepare(`SELECT mode, COUNT(*) as cnt, SUM(amount) as total FROM payments WHERE status='success' GROUP BY mode`).all();
  res.json({ payments: rows, stats });
});
router.delete('/webhook/payments/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM payments WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

// ── PARTNERS ──────────────────────────────────────────────────────────────
router.get('/partners', auth, (req, res) => res.json(db.prepare('SELECT * FROM partners ORDER BY sort_order,id').all()));
router.post('/partners', authAdmin, (req, res) => {
  const { name,role,share_type,share_value,color,tg_chat_id,sort_order } = req.body;
  try {
    const r = db.prepare(`INSERT INTO partners (name,role,share_type,share_value,color,tg_chat_id,sort_order) VALUES (?,?,?,?,?,?,?)`).run(name,role||'owner',share_type||'none',share_value||0,color||'#00e5ff',tg_chat_id||'',sort_order||0);
    audit(req,'create_partner','partner',r.lastInsertRowid,{name});
    res.json({ ok:true, id:r.lastInsertRowid });
  } catch(e) { res.status(400).json({ error:e.message }); }
});
router.put('/partners/:id', authAdmin, (req, res) => {
  const { name,role,share_type,share_value,color,tg_chat_id,sort_order,active } = req.body;
  db.prepare(`UPDATE partners SET name=?,role=?,share_type=?,share_value=?,color=?,tg_chat_id=?,sort_order=?,active=? WHERE id=?`).run(name,role,share_type,share_value||0,color,tg_chat_id||'',sort_order||0,active??1,req.params.id);
  audit(req,'update_partner','partner',req.params.id,{name});
  res.json({ ok:true });
});
router.delete('/partners/:id', authAdmin, (req, res) => {
  db.prepare('DELETE FROM partners WHERE id=?').run(req.params.id);
  audit(req,'delete_partner','partner',req.params.id);
  res.json({ ok:true });
});

// ── DAILY ─────────────────────────────────────────────────────────────────
router.get('/daily', auth, (req, res) => {
  const prefix = qs(req.query.month, req.query.year);
  const rows = prefix
    ? db.prepare("SELECT * FROM daily_entries WHERE date LIKE ? ORDER BY date DESC").all(`${prefix}%`)
    : db.prepare("SELECT * FROM daily_entries ORDER BY date DESC LIMIT 62").all();
  const withP = rows.map(r => ({ ...r, partner_withdrawals: db.prepare(`SELECT pd.*,p.name,p.color,p.role FROM partner_daily pd JOIN partners p ON p.id=pd.partner_id WHERE pd.date=?`).all(r.date) }));
  res.json(withP);
});
router.post('/daily', authEditor, (req, res) => {
  const { date,revenue,expense,note,partner_withdrawals } = req.body;
  try {
    db.transaction(() => {
      db.prepare(`INSERT INTO daily_entries (date,revenue,expense,note) VALUES (?,?,?,?) ON CONFLICT(date) DO UPDATE SET revenue=excluded.revenue,expense=excluded.expense,note=excluded.note`).run(date,revenue||0,expense||0,note||'');
      if (Array.isArray(partner_withdrawals)) {
        db.prepare('DELETE FROM partner_daily WHERE date=?').run(date);
        const ins = db.prepare(`INSERT INTO partner_daily (date,partner_id,amount,type,note) VALUES (?,?,?,?,?)`);
        for (const pw of partner_withdrawals) { if(pw.amount>0) ins.run(date,pw.partner_id,pw.amount,pw.type||'withdrawal',pw.note||''); }
      }
    })();
    audit(req,'upsert_daily','daily',null,{date,revenue,expense});
    res.json({ ok:true });
  } catch(e) { res.status(400).json({ error:e.message }); }
});
router.patch('/daily/:id', authEditor, (req, res) => {
  const allowed=['revenue','expense','note'];
  const updates=Object.entries(req.body).filter(([k])=>allowed.includes(k));
  if(!updates.length) return res.status(400).json({error:'No valid fields'});
  db.prepare(`UPDATE daily_entries SET ${updates.map(([k])=>k+'=?').join(',')} WHERE id=?`).run(...updates.map(([,v])=>v),req.params.id);
  audit(req,'edit_daily','daily',req.params.id,Object.fromEntries(updates));
  res.json({ ok:true });
});
router.delete('/daily/:id', authEditor, (req, res) => {
  const row = db.prepare('SELECT date FROM daily_entries WHERE id=?').get(req.params.id);
  if(row) db.prepare('DELETE FROM partner_daily WHERE date=?').run(row.date);
  db.prepare('DELETE FROM daily_entries WHERE id=?').run(req.params.id);
  audit(req,'delete_daily','daily',req.params.id,{date:row?.date});
  res.json({ ok:true });
});

// ── EXPENSES ──────────────────────────────────────────────────────────────
router.get('/expenses', auth, (req,res) => {
  const prefix=qs(req.query.month,req.query.year);
  res.json(prefix?db.prepare("SELECT * FROM account_expenses WHERE date LIKE ? ORDER BY date DESC").all(`${prefix}%`):db.prepare("SELECT * FROM account_expenses ORDER BY date DESC LIMIT 100").all());
});
router.post('/expenses', authEditor, (req,res) => {
  const {date,category,description,amount,receipt_url}=req.body;
  try {
    const r=db.prepare(`INSERT INTO account_expenses (date,category,description,amount,receipt_url) VALUES (?,?,?,?,?)`).run(date,category,description,amount,receipt_url||'');
    audit(req,'create_expense','expense',r.lastInsertRowid,{date,category,amount});
    const notifyExp=getSetting('notify_new_expense',false);
    if(notifyExp){try{require('../services/bot').notifyNewExpense({date,category,description,amount});}catch(e){}}
    // Check budget
    try{const month=date.slice(0,7);const budget=db.prepare(`SELECT amount FROM budgets WHERE month=? AND type=?`).get(month,`cat_${category}`);if(budget){const spent=db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM account_expenses WHERE date LIKE ? AND category=?`).get(`${month}%`,category).t;if(spent>budget.amount){const nb=getSetting('notify_budget_exceeded',false);if(nb)require('../services/bot').notifyBudgetExceeded(category,spent,budget.amount);}}}catch(e){}
    res.json({ ok:true, id:r.lastInsertRowid });
  } catch(e){res.status(400).json({error:e.message});}
});
router.patch('/expenses/:id', authEditor, (req,res) => {
  const allowed=['amount','description','category','date'];
  const updates=Object.entries(req.body).filter(([k])=>allowed.includes(k));
  db.prepare(`UPDATE account_expenses SET ${updates.map(([k])=>k+'=?').join(',')} WHERE id=?`).run(...updates.map(([,v])=>v),req.params.id);
  audit(req,'edit_expense','expense',req.params.id,Object.fromEntries(updates));
  res.json({ ok:true });
});
router.delete('/expenses/:id', authEditor, (req,res) => {
  const row=db.prepare('SELECT receipt_file FROM account_expenses WHERE id=?').get(req.params.id);
  if(row?.receipt_file){const fp=path.join(__dirname,'..','uploads',row.receipt_file);if(fs.existsSync(fp))fs.unlinkSync(fp);}
  db.prepare('DELETE FROM account_expenses WHERE id=?').run(req.params.id);
  audit(req,'delete_expense','expense',req.params.id);
  res.json({ ok:true });
});

// ── FILE UPLOAD ────────────────────────────────────────────────────────────
router.post('/upload', authEditor, upload.single('file'), (req,res) => {
  if(!req.file) return res.status(400).json({error:'No file'});
  const r=db.prepare(`INSERT INTO receipt_files (filename,original_name,mimetype,size,linked_type,linked_id) VALUES (?,?,?,?,?,?)`).run(req.file.filename,req.file.originalname,req.file.mimetype,req.file.size,req.body.type||null,req.body.id||null);
  if(req.body.type==='expense'&&req.body.id) db.prepare('UPDATE account_expenses SET receipt_file=? WHERE id=?').run(req.file.filename,req.body.id);
  if(req.body.type==='ad'&&req.body.id) db.prepare('UPDATE ads SET screenshot_file=? WHERE id=?').run(req.file.filename,req.body.id);
  if(req.body.type==='investment'&&req.body.id) db.prepare('UPDATE investments SET receipt_file=? WHERE id=?').run(req.file.filename,req.body.id);
  audit(req,'upload_file','file',r.lastInsertRowid,{filename:req.file.filename,type:req.body.type});
  res.json({ ok:true, filename:req.file.filename, url:`/uploads/${req.file.filename}` });
});
router.get('/receipts', auth, (req,res) => res.json(db.prepare('SELECT * FROM receipt_files ORDER BY uploaded_at DESC LIMIT 200').all()));
router.delete('/receipts/:filename', authEditor, (req,res) => {
  const fp=path.join(__dirname,'..','uploads',req.params.filename);
  if(fs.existsSync(fp))fs.unlinkSync(fp);
  db.prepare('DELETE FROM receipt_files WHERE filename=?').run(req.params.filename);
  res.json({ ok:true });
});

// ── ADS ───────────────────────────────────────────────────────────────────
router.get('/ads', auth, (req,res) => {
  const prefix=qs(req.query.month,req.query.year);
  res.json(prefix?db.prepare("SELECT * FROM ads WHERE date LIKE ? ORDER BY date DESC").all(`${prefix}%`):db.prepare("SELECT * FROM ads ORDER BY date DESC LIMIT 100").all());
});
router.post('/ads', authEditor, (req,res) => {
  const {date,format,amount,name,subscribers_gain,channel_url,screenshot_url}=req.body;
  try{
    const r=db.prepare(`INSERT INTO ads (date,format,amount,name,subscribers_gain,channel_url,screenshot_url) VALUES (?,?,?,?,?,?,?)`).run(date,format||'',amount,name,subscribers_gain||0,channel_url||'',screenshot_url||'');
    audit(req,'create_ad','ad',r.lastInsertRowid,{date,name,amount});
    res.json({ ok:true, id:r.lastInsertRowid });
  }catch(e){res.status(400).json({error:e.message});}
});
router.patch('/ads/:id', authEditor, (req,res) => {
  const allowed=['amount','name','format','subscribers_gain'];
  const updates=Object.entries(req.body).filter(([k])=>allowed.includes(k));
  db.prepare(`UPDATE ads SET ${updates.map(([k])=>k+'=?').join(',')} WHERE id=?`).run(...updates.map(([,v])=>v),req.params.id);
  res.json({ ok:true });
});
router.delete('/ads/:id', authEditor, (req,res) => {
  db.prepare('DELETE FROM ads WHERE id=?').run(req.params.id);
  audit(req,'delete_ad','ad',req.params.id);
  res.json({ ok:true });
});
router.get('/ads/roi', auth, (req,res) => {
  const y=req.query.year||new Date().getFullYear();
  const adsByMonth=db.prepare(`SELECT strftime('%Y-%m',date) as month,SUM(amount) as ad_spend,SUM(subscribers_gain) as subs FROM ads WHERE date LIKE ? GROUP BY month ORDER BY month`).all(`${y}%`);
  const revMap=Object.fromEntries(db.prepare(`SELECT strftime('%Y-%m',date) as month,SUM(revenue) as revenue FROM daily_entries WHERE date LIKE ? GROUP BY month`).all(`${y}%`).map(r=>[r.month,r.revenue]));
  res.json(adsByMonth.map(a=>({...a,revenue:revMap[a.month]||0,roi:a.ad_spend>0?(((revMap[a.month]||0)-a.ad_spend)/a.ad_spend*100).toFixed(1):null})));
});

// ── INVESTMENTS ────────────────────────────────────────────────────────────
router.get('/investments', auth, (req,res) => {
  const prefix=qs(req.query.month,req.query.year);
  const base=`SELECT i.*,p.name as partner_name,p.color as partner_color FROM investments i LEFT JOIN partners p ON p.id=i.partner_id`;
  res.json(prefix?db.prepare(`${base} WHERE i.date LIKE ? ORDER BY i.date DESC`).all(`${prefix}%`):db.prepare(`${base} ORDER BY i.date DESC LIMIT 100`).all());
});
router.post('/investments', authEditor, (req,res) => {
  const {date,partner_id,type,category,amount,receipt_url,note}=req.body;
  try{
    const r=db.prepare(`INSERT INTO investments (date,partner_id,type,category,amount,receipt_url,note) VALUES (?,?,?,?,?,?,?)`).run(date,partner_id||null,type||'expense',category||'',amount,receipt_url||'',note||'');
    audit(req,'create_investment','investment',r.lastInsertRowid,{date,type,amount});
    res.json({ ok:true, id:r.lastInsertRowid });
  }catch(e){res.status(400).json({error:e.message});}
});
router.delete('/investments/:id', authEditor, (req,res) => {
  db.prepare('DELETE FROM investments WHERE id=?').run(req.params.id);
  audit(req,'delete_investment','investment',req.params.id);
  res.json({ ok:true });
});
router.get('/investor-summary', auth, (req,res) => {
  const investors=db.prepare("SELECT * FROM partners WHERE role='investor' AND active=1").all();
  res.json(investors.map(p=>({...p,invested:db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM investments WHERE partner_id=? AND type='invested'`).get(p.id).t,returned:db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM investments WHERE partner_id=? AND type='returned'`).get(p.id).t+db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM partner_daily WHERE partner_id=? AND type='investment_return'`).get(p.id).t})).map(p=>({...p,remaining:Math.max(0,p.invested-p.returned)})));
});

// ── MONTHLY STATS ──────────────────────────────────────────────────────────
router.get('/monthly-stats', auth, (req,res) => res.json(db.prepare('SELECT * FROM monthly_stats ORDER BY month').all()));
router.post('/monthly-stats', authEditor, (req,res) => {
  const {month,avg_check,payment_count,refunds,tag_paid,online_users,online_week,channel_subscribers,notes}=req.body;
  db.prepare(`INSERT INTO monthly_stats (month,avg_check,payment_count,refunds,tag_paid,online_users,online_week,channel_subscribers,notes) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(month) DO UPDATE SET avg_check=excluded.avg_check,payment_count=excluded.payment_count,refunds=excluded.refunds,tag_paid=excluded.tag_paid,online_users=excluded.online_users,online_week=excluded.online_week,channel_subscribers=excluded.channel_subscribers,notes=excluded.notes`).run(month,avg_check||null,payment_count||null,refunds||null,tag_paid||null,online_users||null,online_week||null,channel_subscribers||null,notes||'');
  res.json({ ok:true });
});

// ── BUDGETS ────────────────────────────────────────────────────────────────
router.get('/budgets', auth, (req,res) => { const {month}=req.query; res.json(month?db.prepare('SELECT * FROM budgets WHERE month=?').all(month):db.prepare('SELECT * FROM budgets ORDER BY month DESC').all()); });
router.post('/budgets', authEditor, (req,res) => { const {month,type,amount}=req.body; db.prepare('INSERT OR REPLACE INTO budgets (month,type,amount) VALUES (?,?,?)').run(month,type,amount||0); res.json({ ok:true }); });

// ── STATS ──────────────────────────────────────────────────────────────────
router.get('/stats', auth, (req,res) => {
  const {month,year}=req.query;
  const prefix=qs(month,year)||new Date().toISOString().slice(0,7);
  const balance=db.prepare(`SELECT SUM(revenue) as revenue,SUM(expense) as expense,SUM(revenue)-SUM(expense) as net FROM daily_entries WHERE date LIKE ?`).get(`${prefix}%`);
  const accExp=db.prepare(`SELECT SUM(amount) as total,COUNT(*) as cnt FROM account_expenses WHERE date LIKE ?`).get(`${prefix}%`);
  const expByCat=db.prepare(`SELECT category,SUM(amount) as total FROM account_expenses WHERE date LIKE ? GROUP BY category`).all(`${prefix}%`);
  const monthly=db.prepare(`SELECT strftime('%Y-%m',date) as month,SUM(revenue) as total_revenue,SUM(expense) as total_expense,COUNT(*) as days_count,AVG(revenue) as avg_daily,MAX(revenue) as max_day FROM daily_entries GROUP BY strftime('%Y-%m',date) ORDER BY month`).all();
  const adStats=db.prepare(`SELECT strftime('%Y-%m',date) as month,SUM(amount) as total_spent,SUM(subscribers_gain) as total_subs,COUNT(*) as campaigns FROM ads GROUP BY month ORDER BY month`).all();
  const today=new Date();
  const daysInMonth=new Date(today.getFullYear(),today.getMonth()+1,0).getDate();
  const daysPassed=today.getDate();
  const avgDay=(balance?.revenue||0)/Math.max(daysPassed,1);
  const partners=db.prepare('SELECT * FROM partners WHERE active=1 ORDER BY sort_order,id').all();
  const partnerMonthly=partners.map(p=>({...p,month_total:db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM partner_daily WHERE partner_id=? AND date LIKE ?`).get(p.id,`${prefix}%`).t}));
  const sparkData=db.prepare(`SELECT date,revenue,expense FROM daily_entries WHERE date >= date('now','-14 days') ORDER BY date`).all();
  // Payments stats
  const paymentsMonth=db.prepare(`SELECT COUNT(*) as cnt, COALESCE(SUM(amount),0) as total FROM payments WHERE received_at LIKE ? AND status='success' AND mode='live'`).get(`${prefix}%`);
  res.json({ balance,accExp,expByCat,monthly,adStats,forecast:Math.round(avgDay*daysInMonth),daysInMonth,daysPassed,partnerMonthly,sparkData,paymentsMonth });
});

router.get('/heatmap', auth, (req,res) => {
  const year=req.query.year||new Date().getFullYear();
  res.json(db.prepare(`SELECT date,revenue FROM daily_entries WHERE date LIKE ? ORDER BY date`).all(`${year}%`));
});

router.get('/search', auth, (req,res) => {
  const q=(req.query.q||'').trim();
  if(q.length<2) return res.json({results:[]});
  const like=`%${q}%`;
  const results=[];
  db.prepare(`SELECT id,'expense' as type,date,description as title,amount FROM account_expenses WHERE description LIKE ? OR category LIKE ? LIMIT 8`).all(like,like).forEach(r=>results.push(r));
  db.prepare(`SELECT id,'ad' as type,date,name as title,amount FROM ads WHERE name LIKE ? OR channel_url LIKE ? LIMIT 8`).all(like,like).forEach(r=>results.push(r));
  db.prepare(`SELECT id,'daily' as type,date,note as title,revenue as amount FROM daily_entries WHERE note LIKE ? OR date LIKE ? LIMIT 8`).all(like,like).forEach(r=>results.push(r));
  db.prepare(`SELECT id,'payment' as type,received_at as date,customer_name as title,amount FROM payments WHERE customer_name LIKE ? OR customer_email LIKE ? OR product LIKE ? LIMIT 6`).all(like,like,like).forEach(r=>results.push(r));
  results.sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  res.json({ results:results.slice(0,20) });
});

router.post('/distribution/calculate', auth, (req,res) => {
  const {net_profit}=req.body;
  if(!net_profit) return res.status(400).json({error:'net_profit required'});
  const partners=db.prepare("SELECT * FROM partners WHERE active=1 AND share_type!='none' ORDER BY sort_order").all();
  let remaining=net_profit; const result=[];
  for(const p of partners.filter(x=>x.share_type==='fixed')){const amount=Math.min(p.share_value,remaining);result.push({...p,amount,pct:(amount/net_profit*100).toFixed(1)});remaining-=amount;}
  for(const p of partners.filter(x=>x.share_type==='percent')){const amount=remaining*(p.share_value/100);result.push({...p,amount:Math.round(amount*100)/100,pct:p.share_value});}
  res.json({net_profit,distribution:result,undistributed:remaining});
});

// ── EXPORT / IMPORT ────────────────────────────────────────────────────────
router.get('/export/json', authAdmin, (req,res) => {
  const backup={exported_at:new Date().toISOString(),partners:db.prepare('SELECT * FROM partners').all(),daily_entries:db.prepare('SELECT * FROM daily_entries').all(),partner_daily:db.prepare('SELECT * FROM partner_daily').all(),account_expenses:db.prepare('SELECT * FROM account_expenses').all(),investments:db.prepare('SELECT * FROM investments').all(),ads:db.prepare('SELECT * FROM ads').all(),monthly_stats:db.prepare('SELECT * FROM monthly_stats').all()};
  res.setHeader('Content-Disposition',`attachment; filename="baza_backup_${new Date().toISOString().slice(0,10)}.json"`);
  res.json(backup);
});
router.get('/export/excel', auth, async (req,res) => {
  try{
    const buf=await require('../services/excel').generateMonthlyExcel(req.query.year||new Date().getFullYear(),req.query.month||new Date().getMonth()+1);
    const mn=`${req.query.year||new Date().getFullYear()}_${String(req.query.month||new Date().getMonth()+1).padStart(2,'0')}`;
    res.setHeader('Content-Disposition',`attachment; filename="baza_${mn}.xlsx"`);
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  }catch(e){res.status(500).json({error:e.message});}
});
router.post('/import/json', authAdmin, (req,res) => {
  const data=req.body; const results={daily:0,expenses:0,ads:0};
  try{
    db.transaction(()=>{
      if(Array.isArray(data.daily_entries)){const ins=db.prepare(`INSERT OR IGNORE INTO daily_entries (date,revenue,expense,note) VALUES (?,?,?,?)`);for(const r of data.daily_entries){ins.run(r.date,r.revenue||0,r.expense||0,r.note||'');results.daily++;}}
      if(Array.isArray(data.account_expenses)){const ins=db.prepare(`INSERT INTO account_expenses (date,category,description,amount,receipt_url) VALUES (?,?,?,?,?)`);for(const r of data.account_expenses){ins.run(r.date,r.category||'Прочее',r.description||'',r.amount||0,r.receipt_url||'');results.expenses++;}}
      if(Array.isArray(data.ads)){const ins=db.prepare(`INSERT INTO ads (date,format,amount,name,subscribers_gain,channel_url) VALUES (?,?,?,?,?,?)`);for(const r of data.ads){ins.run(r.date,r.format||'',r.amount||0,r.name||'',r.subscribers_gain||0,r.channel_url||'');results.ads++;}}
    })();
    audit(req,'import_json',null,null,results);
    res.json({ ok:true, imported:results });
  }catch(e){res.status(400).json({error:e.message});}
});
router.post('/report/send', authAdmin, async (req,res) => {
  try{ await require('../services/telegram').sendDailyReport(); audit(req,'send_report'); res.json({ ok:true }); }
  catch(e){ res.status(500).json({ error:e.message }); }
});

module.exports = router;

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
const { authEditor, authAdmin, getCookieOpts } = require('../middleware/auth');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => { const d=path.join(__dirname,'..','uploads'); if(!fs.existsSync(d))fs.mkdirSync(d,{recursive:true}); cb(null,d); },
    filename: (req, file, cb) => cb(null, `file_${Date.now()}${path.extname(file.originalname)}`)
  }),
  limits: { fileSize: 15*1024*1024 },
  fileFilter: (req, file, cb) => { const ok=/jpeg|jpg|png|gif|webp|pdf/.test(file.mimetype); cb(ok?null:new Error('Only images/PDF'), ok); }
});

function audit(req, action, entity, entity_id, details) {
  try { db.prepare(`INSERT INTO audit_log (partner_id,action,entity,entity_id,details,ip) VALUES (?,?,?,?,?,?)`).run(req.user?.id||null,action,entity||null,entity_id||null,details?JSON.stringify(details):null,req.headers['x-forwarded-for']?.split(',')[0]||req.connection?.remoteAddress); } catch {}
}
function getSetting(key, fallback=null) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if(!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

// ── AUTH ────────────────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Введи логин и пароль' });

  // Сначала проверяем admin через .env (обратная совместимость)
  if (username === 'admin' && process.env.ADMIN_PASSWORD) {
    const valid = (password === process.env.ADMIN_PASSWORD)
      || (process.env.ADMIN_HASH && await bcrypt.compare(password, process.env.ADMIN_HASH).catch(()=>false));
    if (valid) {
      // Найти или создать партнёра admin
      let p = db.prepare("SELECT * FROM partners WHERE username='admin'").get();
      if (!p) {
        const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
        db.prepare(`INSERT OR IGNORE INTO partners (name,username,password,access_role,role,active,sort_order) VALUES ('admin','admin',?,'admin','owner',1,0)`).run(hash);
        p = db.prepare("SELECT * FROM partners WHERE username='admin'").get();
      }
      if (!p) return res.status(500).json({ error: 'Ошибка создания пользователя' });
      const token = jwt.sign({ partner_id: p.id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30d' });
      res.cookie('token', token, getCookieOpts());
      try { audit(req,'login','partner',p.id,{username:'admin'}); } catch {}
      return res.json({ ok:true, role:'admin', name:'admin' });
    }
    return res.status(401).json({ error: 'Неверный пароль' });
  }

  // Обычный партнёр с логином/паролем
  const p = db.prepare('SELECT * FROM partners WHERE username=? AND active=1').get(username);
  if (!p || !p.password) return res.status(401).json({ error: 'Пользователь не найден' });
  const valid = await bcrypt.compare(password, p.password);
  if (!valid) return res.status(401).json({ error: 'Неверный пароль' });
  const token = jwt.sign({ partner_id: p.id, role: p.access_role }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, getCookieOpts());
  try { audit(req,'login','partner',p.id,{username:p.username}); } catch {}
  res.json({ ok:true, role:p.access_role, name:p.name });
});

router.post('/auth/logout', auth, (req,res) => {
  try { audit(req,'logout','partner',req.user?.id); } catch {}
  res.clearCookie('token'); res.json({ ok:true });
});

router.get('/auth/me', auth, (req,res) => {
  const p = db.prepare('SELECT id,name,role,access_role,color,tg_id,tg_username,tg_avatar,last_seen FROM partners WHERE id=?').get(req.user.id);
  if (!p) return res.json({ id:req.user.id, role:req.user.role, name:req.user.name });
  res.json({ ...p, role: p.access_role });
});

// ── CATEGORIES ──────────────────────────────────────────────────────────────
router.get('/categories', auth, (req,res) => res.json(db.prepare('SELECT * FROM categories WHERE active=1 ORDER BY sort_order,id').all()));
router.post('/categories', authAdmin, (req,res) => {
  const {name,direction,color,icon,sort_order} = req.body;
  try {
    const r = db.prepare('INSERT INTO categories (name,direction,color,icon,sort_order) VALUES (?,?,?,?,?)').run(name,direction||'expense',color||'#8892b0',icon||'◈',sort_order||0);
    audit(req,'create_category','category',r.lastInsertRowid,{name});
    res.json({ ok:true, id:r.lastInsertRowid });
  } catch(e){ res.status(400).json({ error:e.message }); }
});
router.put('/categories/:id', authAdmin, (req,res) => {
  const {name,direction,color,icon,sort_order,active} = req.body;
  db.prepare('UPDATE categories SET name=?,direction=?,color=?,icon=?,sort_order=?,active=? WHERE id=?').run(name,direction,color,icon,sort_order||0,active??1,req.params.id);
  res.json({ ok:true });
});
router.delete('/categories/:id', authAdmin, (req,res) => {
  const sys = db.prepare('SELECT system FROM categories WHERE id=?').get(req.params.id);
  if (sys?.system) return res.status(400).json({ error:'Системную категорию нельзя удалить' });
  db.prepare('UPDATE categories SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

// ── PARTNERS ────────────────────────────────────────────────────────────────
router.get('/partners', auth, (req,res) => {
  const partners = db.prepare('SELECT id,name,role,access_role,color,tg_id,tg_username,tg_name,tg_avatar,username,phone,email,note,active,sort_order,created_at,last_seen FROM partners ORDER BY sort_order,id').all();
  // Добавляем финансовую сводку
  const result = partners.map(p => {
    const totalIn  = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE partner_id=? AND direction='in'").get(p.id).t;
    const totalOut = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE partner_id=? AND direction='out'").get(p.id).t;
    const invested = db.prepare("SELECT COALESCE(SUM(t.amount),0) as v FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.partner_id=? AND c.name='Вложение инвестора'").get(p.id).v;
    const returned = db.prepare("SELECT COALESCE(SUM(t.amount),0) as v FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.partner_id=? AND c.name='Возврат инвестору'").get(p.id).v;
    return { ...p, total_in: totalIn, total_out: totalOut, invested, returned, inv_remaining: Math.max(0, invested - returned) };
  });
  res.json(result);
});

router.post('/partners', authAdmin, async (req,res) => {
  const {name,role,access_role,share_type,share_value,color,tg_id,username,password,phone,email,note,sort_order} = req.body;
  try {
    let hash = null;
    if (password) hash = await bcrypt.hash(password, 10);
    const r = db.prepare(`INSERT INTO partners (name,role,access_role,share_type,share_value,color,tg_id,username,password,phone,email,note,sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      name, role||'owner', access_role||'viewer', share_type||'none', share_value||0,
      color||'#00e5ff', tg_id||null, username||null, hash, phone||null, email||null, note||null, sort_order||0
    );
    audit(req,'create_partner','partner',r.lastInsertRowid,{name});
    res.json({ ok:true, id:r.lastInsertRowid });
  } catch(e){ res.status(400).json({ error:e.message }); }
});

router.put('/partners/:id', authAdmin, async (req,res) => {
  const {name,role,access_role,share_type,share_value,color,tg_id,username,password,phone,email,note,sort_order,active} = req.body;
  try {
    let hash = null;
    if (password) hash = await bcrypt.hash(password, 10);
    if (hash) {
      db.prepare(`UPDATE partners SET name=?,role=?,access_role=?,share_type=?,share_value=?,color=?,tg_id=?,username=?,password=?,phone=?,email=?,note=?,sort_order=?,active=? WHERE id=?`).run(name,role,access_role,share_type,share_value||0,color,tg_id||null,username||null,hash,phone||null,email||null,note||null,sort_order||0,active??1,req.params.id);
    } else {
      db.prepare(`UPDATE partners SET name=?,role=?,access_role=?,share_type=?,share_value=?,color=?,tg_id=?,username=?,phone=?,email=?,note=?,sort_order=?,active=? WHERE id=?`).run(name,role,access_role,share_type,share_value||0,color,tg_id||null,username||null,phone||null,email||null,note||null,sort_order||0,active??1,req.params.id);
    }
    audit(req,'update_partner','partner',req.params.id,{name});
    res.json({ ok:true });
  } catch(e){ res.status(400).json({ error:e.message }); }
});

router.delete('/partners/:id', authAdmin, (req,res) => {
  if (+req.params.id === req.user.id) return res.status(400).json({ error:'Нельзя удалить себя' });
  db.prepare('UPDATE partners SET active=0 WHERE id=?').run(req.params.id);
  audit(req,'delete_partner','partner',req.params.id);
  res.json({ ok:true });
});

// Генерация пароля для партнёра
router.post('/partners/:id/gen-password', authAdmin, async (req,res) => {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const raw = Array.from(crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(10)) : require('crypto').randomBytes(10)).map(b => chars[b % chars.length]).join('');
  const hash = await bcrypt.hash(raw, 10);
  const p = db.prepare('SELECT * FROM partners WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error:'Не найден' });
  let uname = p.username;
  if (!uname) {
    uname = p.name.toLowerCase().replace(/\s+/g,'_').replace(/[^a-z0-9_]/g,'') || `user_${p.id}`;
    db.prepare('UPDATE partners SET username=? WHERE id=?').run(uname, req.params.id);
  }
  db.prepare('UPDATE partners SET password=? WHERE id=?').run(hash, req.params.id);
  res.json({ ok:true, username: uname, password: raw });
});

// ── INVITES ────────────────────────────────────────────────────────────────
router.get('/invites', authAdmin, (req,res) => res.json(db.prepare('SELECT i.*,p.name as partner_name FROM invites i LEFT JOIN partners p ON p.id=i.partner_id ORDER BY i.id DESC LIMIT 50').all()));

router.post('/invites', authAdmin, async (req,res) => {
  const { partner_id, access_role, note, hours } = req.body;
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + (hours||48)*3600*1000).toISOString();
  db.prepare('INSERT INTO invites (token,partner_id,access_role,created_by,expires_at,note) VALUES (?,?,?,?,?,?)').run(token, partner_id||null, access_role||'viewer', req.user.id, expires, note||'');
  const siteUrl = getSetting('site_url') || process.env.SITE_URL || 'https://hiprpol.hideyou.top';
  const botToken = getSetting('tg_bot_token') || process.env.TG_BOT_TOKEN;
  let botName = null;
  if (botToken) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const d = await r.json();
      if (d.ok) botName = d.result.username;
    } catch {}
  }
  const webUrl = `${siteUrl}/invite/${token}`;
  const botUrl = botName ? `https://t.me/${botName}?start=${token}` : null;
  audit(req,'create_invite','invite',null,{access_role,partner_id});
  res.json({ ok:true, token, web_url: webUrl, bot_url: botUrl });
});

router.delete('/invites/:id', authAdmin, (req,res) => {
  db.prepare('DELETE FROM invites WHERE id=?').run(req.params.id);
  res.json({ ok:true });
});

router.get('/invites/check/:token', (req,res) => {
  const inv = db.prepare('SELECT i.*,p.name as partner_name FROM invites i LEFT JOIN partners p ON p.id=i.partner_id WHERE i.token=?').get(req.params.token);
  if (!inv) return res.status(404).json({ error:'Приглашение не найдено' });
  if (inv.used_at) return res.status(410).json({ error:'Приглашение уже использовано' });
  if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error:'Приглашение истекло' });
  res.json({ ok:true, access_role:inv.access_role, note:inv.note, partner_name:inv.partner_name });
});

// Использование инвайта через TG (бот вызывает этот эндпоинт)
router.post('/invites/use/:token', async (req,res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE token=?').get(req.params.token);
  if (!inv || inv.used_at || new Date(inv.expires_at) < new Date())
    return res.status(410).json({ error:'Приглашение недействительно' });

  const { tg_id, tg_username, tg_name, tg_avatar } = req.body;
  if (!tg_id) return res.status(400).json({ error:'tg_id required' });

  let partner;
  if (inv.partner_id) {
    // Привязываем TG к существующему партнёру
    partner = db.prepare('SELECT * FROM partners WHERE id=?').get(inv.partner_id);
    if (partner) {
      db.prepare('UPDATE partners SET tg_id=?,tg_username=?,tg_name=?,tg_avatar=?,access_role=?,active=1 WHERE id=?').run(
        String(tg_id), tg_username||null, tg_name||null, tg_avatar||null, inv.access_role, partner.id
      );
    }
  } else {
    // Ищем по tg_id или создаём нового
    partner = db.prepare('SELECT * FROM partners WHERE tg_id=?').get(String(tg_id));
    if (!partner) {
      const r = db.prepare('INSERT INTO partners (name,tg_id,tg_username,tg_name,tg_avatar,access_role,role) VALUES (?,?,?,?,?,?,?)').run(
        tg_name || tg_username || `user_${tg_id}`, String(tg_id), tg_username||null, tg_name||null, tg_avatar||null, inv.access_role, 'other'
      );
      partner = db.prepare('SELECT * FROM partners WHERE id=?').get(r.lastInsertRowid);
    } else {
      db.prepare('UPDATE partners SET access_role=?,tg_name=?,tg_username=?,tg_avatar=? WHERE id=?').run(inv.access_role, tg_name||null, tg_username||null, tg_avatar||null, partner.id);
    }
  }

  if (!partner) return res.status(500).json({ error:'Ошибка' });
  db.prepare('UPDATE invites SET used_at=datetime("now") WHERE id=?').run(inv.id);

  const token = jwt.sign({ partner_id: partner.id, role: partner.access_role || inv.access_role }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.cookie('token', token, getCookieOpts());
  res.json({ ok:true, role: inv.access_role, name: partner.name });
});

// ── TRANSACTIONS ────────────────────────────────────────────────────────────
router.get('/transactions', auth, (req,res) => {
  const { month, year, direction, category_id, partner_id } = req.query;
  let sql = `SELECT t.*, c.name as cat_name, c.color as cat_color, c.icon as cat_icon, p.name as partner_name, p.color as partner_color FROM transactions t LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN partners p ON p.id=t.partner_id WHERE 1=1`;
  const params = [];
  if (month && year) { sql += ` AND t.date LIKE ?`; params.push(`${year}-${String(month).padStart(2,'0')}%`); }
  if (direction)   { sql += ` AND t.direction=?`; params.push(direction); }
  if (category_id) { sql += ` AND t.category_id=?`; params.push(category_id); }
  if (partner_id)  { sql += ` AND t.partner_id=?`; params.push(partner_id); }
  sql += ` ORDER BY t.date DESC, t.id DESC LIMIT 500`;
  res.json(db.prepare(sql).all(...params));
});

router.post('/transactions', authEditor, (req,res) => {
  const { date, direction, amount, category_id, partner_id, note, receipt_url, mode } = req.body;
  if (!date || !direction || !amount) return res.status(400).json({ error:'date, direction, amount обязательны' });
  try {
    const r = db.prepare(`INSERT INTO transactions (date,direction,amount,category_id,partner_id,note,receipt_url,mode,created_by) VALUES (?,?,?,?,?,?,?,?,?)`).run(date,direction,amount,category_id||null,partner_id||null,note||'',receipt_url||'',mode||'live',req.user?.id||null);
    audit(req,'create_tx','transaction',r.lastInsertRowid,{date,direction,amount});
    // TG notify
    const notifyNew = getSetting('notify_new_expense', false);
    if (notifyNew && direction === 'out') {
      const cat = category_id ? db.prepare('SELECT name FROM categories WHERE id=?').get(category_id) : null;
      const prt = partner_id ? db.prepare('SELECT name FROM partners WHERE id=?').get(partner_id) : null;
      try { require('../services/bot').notifyNewExpense({ date, category:cat?.name||'—', description:note||'—', amount }); } catch {}
    }
    res.json({ ok:true, id:r.lastInsertRowid });
  } catch(e){ res.status(400).json({ error:e.message }); }
});

router.patch('/transactions/:id', authEditor, (req,res) => {
  const allowed = ['date','direction','amount','category_id','partner_id','note','receipt_url'];
  const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
  if (!updates.length) return res.status(400).json({ error:'Нет полей' });
  db.prepare(`UPDATE transactions SET ${updates.map(([k])=>k+'=?').join(',')} WHERE id=?`).run(...updates.map(([,v])=>v), req.params.id);
  audit(req,'edit_tx','transaction',req.params.id);
  res.json({ ok:true });
});

router.delete('/transactions/:id', authEditor, (req,res) => {
  const row = db.prepare('SELECT receipt_file FROM transactions WHERE id=?').get(req.params.id);
  if (row?.receipt_file) { const fp=path.join(__dirname,'..','uploads',row.receipt_file); if(fs.existsSync(fp))fs.unlinkSync(fp); }
  db.prepare('DELETE FROM transactions WHERE id=?').run(req.params.id);
  audit(req,'delete_tx','transaction',req.params.id);
  res.json({ ok:true });
});

// ── STATS ───────────────────────────────────────────────────────────────────
router.get('/stats', auth, (req,res) => {
  const { month, year } = req.query;
  const prefix = (month && year) ? `${year}-${String(month).padStart(2,'0')}` : new Date().toISOString().slice(0,7);

  const income  = db.prepare(`SELECT COALESCE(SUM(amount),0) as t, COUNT(*) as c FROM transactions WHERE direction='in' AND date LIKE ? AND mode='live'`).get(`${prefix}%`);
  const expense = db.prepare(`SELECT COALESCE(SUM(amount),0) as t, COUNT(*) as c FROM transactions WHERE direction='out' AND date LIKE ? AND mode='live'`).get(`${prefix}%`);
  const byCategory = db.prepare(`SELECT c.id, c.name, c.color, c.icon, c.direction, COALESCE(SUM(t.amount),0) as total FROM transactions t JOIN categories c ON c.id=t.category_id WHERE t.date LIKE ? AND t.mode='live' GROUP BY c.id ORDER BY total DESC`).all(`${prefix}%`);
  const monthly = db.prepare(`SELECT strftime('%Y-%m',date) as month, SUM(CASE WHEN direction='in' THEN amount ELSE 0 END) as income, SUM(CASE WHEN direction='out' THEN amount ELSE 0 END) as expense, COUNT(*) as cnt FROM transactions WHERE mode='live' GROUP BY strftime('%Y-%m',date) ORDER BY month`).all();
  const partners = db.prepare('SELECT * FROM partners WHERE active=1 ORDER BY sort_order,id').all();
  const partnerMonth = partners.map(p => ({
    ...p,
    month_in:  db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE partner_id=? AND direction='in' AND date LIKE ? AND mode='live'`).get(p.id, `${prefix}%`).t,
    month_out: db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE partner_id=? AND direction='out' AND date LIKE ? AND mode='live'`).get(p.id, `${prefix}%`).t,
  }));
  const sparkData = db.prepare(`SELECT date, SUM(CASE WHEN direction='in' THEN amount ELSE 0 END) as income, SUM(CASE WHEN direction='out' THEN amount ELSE 0 END) as expense FROM transactions WHERE date >= date('now','-14 days') AND mode='live' GROUP BY date ORDER BY date`).all();
  const today = new Date();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
  const daysPassed  = today.getDate();
  const avgDay = income.t / Math.max(daysPassed, 1);
  // Investments global
  const totalInvested = db.prepare(`SELECT COALESCE(SUM(t.amount),0) as v FROM transactions t JOIN categories c ON c.id=t.category_id WHERE c.name='Вложение инвестора' AND t.mode='live'`).get().v;
  const totalReturned = db.prepare(`SELECT COALESCE(SUM(t.amount),0) as v FROM transactions t JOIN categories c ON c.id=t.category_id WHERE c.name='Возврат инвестору' AND t.mode='live'`).get().v;
  res.json({ income, expense, byCategory, monthly, partnerMonth, sparkData, daysInMonth, daysPassed, forecast: Math.round(avgDay*daysInMonth), totalInvested, totalReturned, invRemaining: Math.max(0, totalInvested-totalReturned) });
});

router.get('/heatmap', auth, (req,res) => {
  const year = req.query.year || new Date().getFullYear();
  res.json(db.prepare(`SELECT date, SUM(CASE WHEN direction='in' THEN amount ELSE 0 END) as revenue FROM transactions WHERE date LIKE ? AND mode='live' GROUP BY date ORDER BY date`).all(`${year}%`));
});

router.get('/search', auth, (req,res) => {
  const q = (req.query.q||'').trim();
  if (q.length < 2) return res.json({ results:[] });
  const like = `%${q}%`;
  const txs = db.prepare(`SELECT t.id,'tx' as type,t.date,t.note as title,t.amount,t.direction,c.name as cat,c.icon FROM transactions t LEFT JOIN categories c ON c.id=t.category_id WHERE t.note LIKE ? OR c.name LIKE ? OR t.date LIKE ? ORDER BY t.date DESC LIMIT 15`).all(like,like,like);
  const ads = db.prepare(`SELECT id,'ad' as type,date,name as title,amount,null as direction,null as cat,null as icon FROM ads WHERE name LIKE ? LIMIT 8`).all(like);
  const prt = db.prepare(`SELECT id,'partner' as type,null as date,name as title,null as amount,null as direction,role as cat,null as icon FROM partners WHERE name LIKE ? AND active=1 LIMIT 5`).all(like);
  res.json({ results: [...txs,...ads,...prt].slice(0,25) });
});

// ── ADS ─────────────────────────────────────────────────────────────────────
router.get('/ads', auth, (req,res) => {
  const {month,year} = req.query;
  const prefix = (month&&year) ? `${year}-${String(month).padStart(2,'0')}` : null;
  res.json(prefix ? db.prepare("SELECT * FROM ads WHERE date LIKE ? ORDER BY date DESC").all(`${prefix}%`) : db.prepare("SELECT * FROM ads ORDER BY date DESC LIMIT 100").all());
});
router.post('/ads', authEditor, (req,res) => {
  const {date,format,amount,name,subscribers_gain,channel_url,screenshot_url} = req.body;
  try { const r = db.prepare(`INSERT INTO ads (date,format,amount,name,subscribers_gain,channel_url,screenshot_url) VALUES (?,?,?,?,?,?,?)`).run(date,format||'',amount,name,subscribers_gain||0,channel_url||'',screenshot_url||''); audit(req,'create_ad','ad',r.lastInsertRowid,{name,amount}); res.json({ ok:true, id:r.lastInsertRowid }); }
  catch(e){ res.status(400).json({ error:e.message }); }
});
router.patch('/ads/:id', authEditor, (req,res) => {
  const allowed=['amount','name','format','subscribers_gain'];
  const updates=Object.entries(req.body).filter(([k])=>allowed.includes(k));
  db.prepare(`UPDATE ads SET ${updates.map(([k])=>k+'=?').join(',')} WHERE id=?`).run(...updates.map(([,v])=>v),req.params.id);
  res.json({ ok:true });
});
router.delete('/ads/:id', authEditor, (req,res) => { db.prepare('DELETE FROM ads WHERE id=?').run(req.params.id); res.json({ ok:true }); });
router.get('/ads/roi', auth, (req,res) => {
  const y = req.query.year||new Date().getFullYear();
  const ads = db.prepare(`SELECT strftime('%Y-%m',date) as month,SUM(amount) as ad_spend,SUM(subscribers_gain) as subs FROM ads WHERE date LIKE ? GROUP BY month ORDER BY month`).all(`${y}%`);
  const revMap = Object.fromEntries(db.prepare(`SELECT strftime('%Y-%m',date) as month, SUM(CASE WHEN direction='in' THEN amount ELSE 0 END) as income FROM transactions WHERE date LIKE ? AND mode='live' GROUP BY month`).all(`${y}%`).map(r=>[r.month,r.income]));
  res.json(ads.map(a=>({...a,income:revMap[a.month]||0,roi:a.ad_spend>0?(((revMap[a.month]||0)-a.ad_spend)/a.ad_spend*100).toFixed(1):null})));
});

// ── MONTHLY STATS ────────────────────────────────────────────────────────────
router.get('/monthly-stats', auth, (req,res) => res.json(db.prepare('SELECT * FROM monthly_stats ORDER BY month').all()));
router.post('/monthly-stats', authEditor, (req,res) => {
  const {month,avg_check,payment_count,refunds,online_users,channel_subscribers,notes} = req.body;
  db.prepare(`INSERT INTO monthly_stats (month,avg_check,payment_count,refunds,online_users,channel_subscribers,notes) VALUES (?,?,?,?,?,?,?) ON CONFLICT(month) DO UPDATE SET avg_check=excluded.avg_check,payment_count=excluded.payment_count,refunds=excluded.refunds,online_users=excluded.online_users,channel_subscribers=excluded.channel_subscribers,notes=excluded.notes`).run(month,avg_check||null,payment_count||null,refunds||null,online_users||null,channel_subscribers||null,notes||'');
  res.json({ ok:true });
});

// ── FILE UPLOAD ───────────────────────────────────────────────────────────────
router.post('/upload', authEditor, upload.single('file'), (req,res) => {
  if (!req.file) return res.status(400).json({ error:'No file' });
  const r = db.prepare(`INSERT INTO receipt_files (filename,original_name,mimetype,size,linked_type,linked_id) VALUES (?,?,?,?,?,?)`).run(req.file.filename,req.file.originalname,req.file.mimetype,req.file.size,req.body.type||null,req.body.id||null);
  if (req.body.type==='transaction'&&req.body.id) db.prepare('UPDATE transactions SET receipt_file=? WHERE id=?').run(req.file.filename,req.body.id);
  if (req.body.type==='ad'&&req.body.id) db.prepare('UPDATE ads SET screenshot_file=? WHERE id=?').run(req.file.filename,req.body.id);
  audit(req,'upload_file','file',r.lastInsertRowid,{filename:req.file.filename});
  res.json({ ok:true, filename:req.file.filename, url:`/uploads/${req.file.filename}` });
});

router.get('/receipts', auth, (req,res) => {
  const rows = db.prepare(`SELECT rf.*, t.date as tx_date, t.amount as tx_amount, t.note as tx_note, c.name as cat_name, c.icon as cat_icon FROM receipt_files rf LEFT JOIN transactions t ON t.id=rf.linked_id AND rf.linked_type='transaction' LEFT JOIN categories c ON c.id=t.category_id ORDER BY rf.uploaded_at DESC LIMIT 200`).all();
  res.json(rows);
});
router.delete('/receipts/:filename', authEditor, (req,res) => {
  const fp = path.join(__dirname,'..','uploads',req.params.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.prepare('DELETE FROM receipt_files WHERE filename=?').run(req.params.filename);
  res.json({ ok:true });
});

// ── PUBLIC bot info (для страницы приглашения — только имя, не токен) ──────────
router.get('/bot-info', async (req, res) => {
  const tok = getSetting('tg_bot_token') || process.env.TG_BOT_TOKEN;
  const siteUrl = getSetting('site_url') || process.env.SITE_URL || '';
  if (!tok) return res.json({ ok: false });
  try {
    const nodeFetch = require('node-fetch');
    const r = await nodeFetch(`https://api.telegram.org/bot${tok}/getMe`);
    const d = await r.json();
    if (d.ok) return res.json({ ok: true, username: d.result.username, name: d.result.first_name, site_url: siteUrl });
    res.json({ ok: false });
  } catch { res.json({ ok: false }); }
});

// ── SETTINGS ─────────────────────────────────────────────────────────────────
router.get('/settings', auth, (req,res) => {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  const obj = {};
  for (const r of rows) { try { obj[r.key]=JSON.parse(r.value); } catch { obj[r.key]=r.value; } }
  if (req.user.role !== 'admin') { delete obj.webhook_secret; delete obj.tg_bot_token; }
  res.json(obj);
});
router.post('/settings', authAdmin, (req,res) => {
  const ups = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  db.transaction(() => { for(const [k,v] of Object.entries(req.body)) ups.run(k,typeof v==='object'?JSON.stringify(v):String(v)); })();
  audit(req,'update_settings',null,null,{keys:Object.keys(req.body)});
  if (req.body.tg_bot_token) { try { require('../services/bot').restartBot(); } catch {} }
  res.json({ ok:true });
});

// ── WEBHOOK ───────────────────────────────────────────────────────────────────
router.post('/webhook/payment', async (req,res) => {
  const secret = getSetting('webhook_secret');
  if (secret && (req.headers['x-webhook-secret']||req.headers['x-signature']) !== secret)
    return res.status(401).json({ error:'Invalid secret' });
  const body = req.body;
  const mode = body.mode || (body.test ? 'test' : 'live');
  try {
    const amount = parseFloat(body.amount||body.sum||0);
    if (amount <= 0) return res.status(400).json({ error:'amount must be > 0' });
    const payment_id = body.payment_id||body.id||`auto_${Date.now()}`;
    const catIncome = db.prepare("SELECT id FROM categories WHERE name='Оплата VPN' LIMIT 1").get();
    db.prepare(`INSERT OR IGNORE INTO transactions (date,direction,amount,category_id,note,payment_id,mode) VALUES (?,?,?,?,?,?,?)`).run(new Date().toISOString().slice(0,10),'in',amount,catIncome?.id||null,[body.customer_name,body.product].filter(Boolean).join(' — ')||'Webhook',payment_id,mode);
    if (mode==='live') {
      const notify=getSetting('notify_new_payment',true);
      if(notify){try{const{sendMsg,getMainChannel}=require('../services/bot');const ch=getMainChannel();if(ch)sendMsg(ch,`💳 <b>Оплата!</b>\n💰 ${amount.toLocaleString('ru')} ₽\n👤 ${body.customer_name||body.email||'—'}\n📦 ${body.product||'—'}`);}catch{}}
    }
    res.json({ ok:true, mode });
  } catch(e){ res.status(500).json({ error:e.message }); }
});
router.get('/webhook/payments', authAdmin, (req,res) => {
  const {mode} = req.query;
  const rows = mode ? db.prepare("SELECT * FROM transactions WHERE payment_id IS NOT NULL AND mode=? ORDER BY created_at DESC LIMIT 100").all(mode) : db.prepare("SELECT * FROM transactions WHERE payment_id IS NOT NULL ORDER BY created_at DESC LIMIT 100").all();
  const stats = db.prepare(`SELECT mode, COUNT(*) as cnt, SUM(amount) as total FROM transactions WHERE payment_id IS NOT NULL AND direction='in' GROUP BY mode`).all();
  res.json({ payments:rows, stats });
});

// ── AUDIT ─────────────────────────────────────────────────────────────────────
router.get('/audit', authAdmin, (req,res) => {
  const {limit,offset}=req.query;
  const rows=db.prepare(`SELECT a.*,p.name as partner_name,p.access_role as user_role FROM audit_log a LEFT JOIN partners p ON p.id=a.partner_id ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(+limit||100,+offset||0);
  res.json({ rows, total:db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c });
});

// ── EXPORT / IMPORT ────────────────────────────────────────────────────────────
router.get('/export/json', authAdmin, (req,res) => {
  const backup={exported_at:new Date().toISOString(),transactions:db.prepare('SELECT * FROM transactions').all(),categories:db.prepare('SELECT * FROM categories').all(),partners:db.prepare('SELECT id,name,role,color,sort_order FROM partners').all(),ads:db.prepare('SELECT * FROM ads').all(),monthly_stats:db.prepare('SELECT * FROM monthly_stats').all()};
  res.setHeader('Content-Disposition',`attachment; filename="baza_backup_${new Date().toISOString().slice(0,10)}.json"`);
  res.json(backup);
});
router.post('/import/json', authAdmin, (req,res) => {
  const data=req.body; const results={transactions:0,ads:0};
  try {
    db.transaction(()=>{
      if(Array.isArray(data.transactions)){const ins=db.prepare(`INSERT OR IGNORE INTO transactions (date,direction,amount,category_id,note,payment_id) VALUES (?,?,?,?,?,?)`);for(const r of data.transactions){ins.run(r.date,r.direction||'in',r.amount||0,r.category_id||null,r.note||'',r.payment_id||null);results.transactions++;}}
      if(Array.isArray(data.ads)){const ins=db.prepare(`INSERT INTO ads (date,format,amount,name,subscribers_gain,channel_url) VALUES (?,?,?,?,?,?)`);for(const r of data.ads){ins.run(r.date,r.format||'',r.amount||0,r.name||'',r.subscribers_gain||0,r.channel_url||'');results.ads++;}}
    })();
    audit(req,'import_json',null,null,results);
    res.json({ ok:true, imported:results });
  } catch(e){ res.status(400).json({ error:e.message }); }
});
router.post('/report/send', authAdmin, async (req,res) => {
  try { await require('../services/telegram').sendDailyReport(); audit(req,'send_report'); res.json({ ok:true }); }
  catch(e){ res.status(500).json({ error:e.message }); }
});

module.exports = router;

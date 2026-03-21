const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
const uploadsDir = path.join(__dirname, '..', 'uploads');
[dataDir, uploadsDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const db = new Database(path.join(dataDir, 'accounting.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT UNIQUE,
    password    TEXT,
    tg_id       TEXT UNIQUE,
    tg_username TEXT,
    tg_name     TEXT,
    tg_avatar   TEXT,
    role        TEXT NOT NULL DEFAULT 'viewer'
                  CHECK(role IN ('admin','editor','viewer')),
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now')),
    last_seen   TEXT
  );
  CREATE TABLE IF NOT EXISTS invites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT NOT NULL UNIQUE,
    role       TEXT NOT NULL DEFAULT 'viewer',
    created_by INTEGER REFERENCES users(id),
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    used_by    INTEGER REFERENCES users(id),
    note       TEXT
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action     TEXT NOT NULL,
    entity     TEXT,
    entity_id  INTEGER,
    details    TEXT,
    ip         TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id  TEXT UNIQUE,
    amount      REAL NOT NULL,
    currency    TEXT DEFAULT 'RUB',
    customer_id TEXT,
    customer_email TEXT,
    customer_name  TEXT,
    product     TEXT,
    status      TEXT DEFAULT 'success',
    raw         TEXT,
    mode        TEXT DEFAULT 'live',
    received_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS partners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('investor','owner','employee')),
    share_type TEXT NOT NULL DEFAULT 'none' CHECK(share_type IN ('percent','fixed','none')),
    share_value REAL NOT NULL DEFAULT 0,
    color TEXT NOT NULL DEFAULT '#00e5ff',
    tg_chat_id TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS daily_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    revenue REAL NOT NULL DEFAULT 0,
    expense REAL NOT NULL DEFAULT 0,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS partner_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    amount REAL NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT 'withdrawal' CHECK(type IN ('withdrawal','dividend','investment_return')),
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS account_expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('Реклама','Сервера','LeadTex','ФНС','ТГ Прем','СКАМ','Прочее')),
    description TEXT NOT NULL,
    amount REAL NOT NULL,
    receipt_url TEXT,
    receipt_file TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS investments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
    type TEXT NOT NULL DEFAULT 'expense' CHECK(type IN ('invested','returned','expense')),
    category TEXT,
    amount REAL NOT NULL,
    receipt_url TEXT,
    receipt_file TEXT,
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS ads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    format TEXT,
    amount REAL NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    subscribers_gain INTEGER DEFAULT 0,
    channel_url TEXT,
    screenshot_url TEXT,
    screenshot_file TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS monthly_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL UNIQUE,
    avg_check REAL, payment_count INTEGER, refunds REAL,
    tag_paid INTEGER, online_users INTEGER, online_week INTEGER,
    channel_subscribers INTEGER, notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS receipt_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL, original_name TEXT, mimetype TEXT, size INTEGER,
    linked_type TEXT, linked_id INTEGER,
    uploaded_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS budgets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0,
    UNIQUE(month, type)
  );
`);

function migrate() {
  const cols = db.pragma('table_info(daily_entries)').map(r => r.name);
  if (!cols.includes('incas_artem')) return;
  const partnerCount = db.prepare('SELECT COUNT(*) as c FROM partners').get().c;
  if (partnerCount === 0) {
    ['Артём','Роман','Михаил'].forEach((n,i) => {
      const role = n === 'Роман' ? 'investor' : 'owner';
      const color = ['#00e5ff','#f97316','#00f5a0'][i];
      db.prepare(`INSERT INTO partners (name,role,share_type,share_value,color,sort_order) VALUES (?,?,?,?,?,?)`).run(n,role,'none',0,color,i+1);
    });
  }
  const artem = db.prepare("SELECT id FROM partners WHERE name='Артём' LIMIT 1").get();
  const roman = db.prepare("SELECT id FROM partners WHERE name='Роман' LIMIT 1").get();
  const misha = db.prepare("SELECT id FROM partners WHERE name='Михаил' LIMIT 1").get();
  if (!db.prepare('SELECT COUNT(*) as c FROM partner_daily').get().c) {
    const rows = db.prepare('SELECT * FROM daily_entries').all();
    const ins = db.prepare(`INSERT OR IGNORE INTO partner_daily (date,partner_id,amount,type) VALUES (?,?,?,?)`);
    db.transaction(() => {
      for (const r of rows) {
        if (r.incas_artem > 0 && artem) ins.run(r.date, artem.id, r.incas_artem, 'withdrawal');
        if (r.incas_roman > 0 && roman) ins.run(r.date, roman.id, r.incas_roman, 'investment_return');
        if (r.incas_mikhail > 0 && misha) ins.run(r.date, misha.id, r.incas_mikhail, 'withdrawal');
      }
    })();
  }
}
try { migrate(); } catch(e) { console.error('Migration warning:', e.message); }

module.exports = db;

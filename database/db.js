const Database = require('better-sqlite3');
const path = require('path');
const fs   = require('fs');

const dataDir    = path.join(__dirname, '..', 'data');
const uploadsDir = path.join(__dirname, '..', 'uploads');
[dataDir, uploadsDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const db = new Database(path.join(dataDir, 'accounting.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- Категории (создаёт и редактирует админ)
  CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    direction  TEXT NOT NULL DEFAULT 'expense' CHECK(direction IN ('income','expense','both')),
    color      TEXT NOT NULL DEFAULT '#8892b0',
    icon       TEXT NOT NULL DEFAULT '◈',
    sort_order INTEGER NOT NULL DEFAULT 0,
    active     INTEGER NOT NULL DEFAULT 1,
    system     INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Партнёры (объединяет партнёров и пользователей)
  CREATE TABLE IF NOT EXISTS partners (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('investor','owner','employee','other')),
    access_role     TEXT NOT NULL DEFAULT 'viewer' CHECK(access_role IN ('admin','editor','viewer','none')),
    share_type      TEXT NOT NULL DEFAULT 'none' CHECK(share_type IN ('percent','fixed','none')),
    share_value     REAL NOT NULL DEFAULT 0,
    color           TEXT NOT NULL DEFAULT '#00e5ff',
    tg_id           TEXT UNIQUE,
    tg_username     TEXT,
    tg_name         TEXT,
    tg_avatar       TEXT,
    username        TEXT UNIQUE,
    password        TEXT,
    phone           TEXT,
    email           TEXT,
    note            TEXT,
    active          INTEGER NOT NULL DEFAULT 1,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now')),
    last_seen       TEXT
  );

  -- Приглашения
  CREATE TABLE IF NOT EXISTS invites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    token      TEXT NOT NULL UNIQUE,
    partner_id INTEGER REFERENCES partners(id) ON DELETE CASCADE,
    access_role TEXT NOT NULL DEFAULT 'viewer',
    created_by INTEGER REFERENCES partners(id),
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    note       TEXT
  );

  -- Единая таблица транзакций
  CREATE TABLE IF NOT EXISTS transactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT NOT NULL,
    direction    TEXT NOT NULL CHECK(direction IN ('in','out')),
    amount       REAL NOT NULL,
    category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    partner_id   INTEGER REFERENCES partners(id) ON DELETE SET NULL,
    note         TEXT,
    receipt_url  TEXT,
    receipt_file TEXT,
    payment_id   TEXT UNIQUE,
    mode         TEXT DEFAULT 'live' CHECK(mode IN ('live','test')),
    created_by   INTEGER REFERENCES partners(id) ON DELETE SET NULL,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  -- Реклама
  CREATE TABLE IF NOT EXISTS ads (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    date             TEXT NOT NULL,
    format           TEXT,
    amount           REAL NOT NULL DEFAULT 0,
    name             TEXT NOT NULL,
    subscribers_gain INTEGER DEFAULT 0,
    channel_url      TEXT,
    screenshot_url   TEXT,
    screenshot_file  TEXT,
    created_at       TEXT DEFAULT (datetime('now'))
  );

  -- Ручная статистика по месяцам
  CREATE TABLE IF NOT EXISTS monthly_stats (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    month               TEXT NOT NULL UNIQUE,
    avg_check           REAL,
    payment_count       INTEGER,
    refunds             REAL,
    online_users        INTEGER,
    channel_subscribers INTEGER,
    notes               TEXT,
    created_at          TEXT DEFAULT (datetime('now'))
  );

  -- Файлы чеков
  CREATE TABLE IF NOT EXISTS receipt_files (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    filename       TEXT NOT NULL,
    original_name  TEXT,
    mimetype       TEXT,
    size           INTEGER,
    linked_type    TEXT,
    linked_id      INTEGER,
    uploaded_at    TEXT DEFAULT (datetime('now'))
  );

  -- Настройки
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Журнал действий
  CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
    action     TEXT NOT NULL,
    entity     TEXT,
    entity_id  INTEGER,
    details    TEXT,
    ip         TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Дефолтные категории ───────────────────────────────────────────────────
function seedCategories() {
  const cnt = db.prepare('SELECT COUNT(*) as c FROM categories').get().c;
  if (cnt > 0) return;
  const cats = [
    // Доходы
    ['Оплата VPN',         'income',  '#00f5a0', '💳', 1, 1],
    ['Вложение инвестора', 'income',  '#fbbf24', '💼', 2, 1],
    ['Прочий доход',       'income',  '#a78bfa', '📥', 3, 1],
    // Расходы
    ['Реклама',            'expense', '#f97316', '📣', 10, 1],
    ['Сервера',            'expense', '#00e5ff', '🖥', 11, 1],
    ['LeadTex',            'expense', '#00f5a0', '🔗', 12, 1],
    ['ФНС / Налоги',       'expense', '#ff3060', '🏛', 13, 1],
    ['TG Premium',         'expense', '#7c3aed', '✈', 14, 1],
    ['Возврат инвестору',  'expense', '#fbbf24', '↩', 15, 1],
    ['Выплата партнёру',   'expense', '#8892b0', '👤', 16, 1],
    ['СКАМ / Убытки',      'expense', '#ff3060', '⚠', 17, 1],
    ['Прочий расход',      'expense', '#4a5068', '◈', 18, 1],
  ];
  const ins = db.prepare('INSERT INTO categories (name,direction,color,icon,sort_order,system) VALUES (?,?,?,?,?,?)');
  db.transaction(() => { cats.forEach(c => ins.run(...c)); })();
  console.log('✅ Дефолтные категории созданы');
}

// ── Миграция из старых таблиц ─────────────────────────────────────────────
function migrate() {
  seedCategories();

  // Миграция partners → добавляем недостающие колонки если нужно
  const pCols = db.pragma('table_info(partners)').map(r => r.name);
  if (!pCols.includes('access_role')) {
    try {
      db.exec(`ALTER TABLE partners ADD COLUMN access_role TEXT NOT NULL DEFAULT 'viewer'`);
      db.exec(`ALTER TABLE partners ADD COLUMN tg_id TEXT`);
      db.exec(`ALTER TABLE partners ADD COLUMN tg_username TEXT`);
      db.exec(`ALTER TABLE partners ADD COLUMN tg_name TEXT`);
      db.exec(`ALTER TABLE partners ADD COLUMN tg_avatar TEXT`);
      db.exec(`ALTER TABLE partners ADD COLUMN username TEXT`);
      db.exec(`ALTER TABLE partners ADD COLUMN password TEXT`);
      db.exec(`ALTER TABLE partners ADD COLUMN phone TEXT`);
      db.exec(`ALTER TABLE partners ADD COLUMN email TEXT`);
      db.exec(`ALTER TABLE partners ADD COLUMN note TEXT`);
    } catch(e) {}
  }

  // Создаём дефолтных партнёров если нет
  const pCnt = db.prepare('SELECT COUNT(*) as c FROM partners').get().c;
  if (pCnt === 0) {
    db.prepare(`INSERT INTO partners (name,role,access_role,color,sort_order) VALUES ('Артём','owner','admin','#00e5ff',1)`).run();
    db.prepare(`INSERT INTO partners (name,role,access_role,color,sort_order) VALUES ('Роман','investor','viewer','#f97316',2)`).run();
    db.prepare(`INSERT INTO partners (name,role,access_role,color,sort_order) VALUES ('Михаил','owner','editor','#00f5a0',3)`).run();
  }

  // Миграция users → partners
  const hasTbl = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get();
  if (hasTbl) {
    const users = db.prepare('SELECT * FROM users').all();
    for (const u of users) {
      if (!u.username) continue;
      const exists = db.prepare("SELECT id FROM partners WHERE username=?").get(u.username);
      if (!exists) {
        db.prepare(`INSERT OR IGNORE INTO partners (name,username,password,access_role,active,tg_id,tg_username,tg_name) VALUES (?,?,?,?,?,?,?,?)`).run(
          u.tg_name || u.username, u.username, u.password,
          u.role || 'viewer', u.active ?? 1, u.tg_id || null, u.tg_username || null, u.tg_name || null
        );
      }
    }
    // Мигрируем invites
    const hasInvOld = db.pragma('table_info(invites)').map(r => r.name);
    if (hasInvOld.includes('created_by')) {
      try {
        const oldInvites = db.prepare('SELECT * FROM invites').all();
        for (const inv of oldInvites) {
          const exists = db.prepare('SELECT id FROM invites WHERE token=?').get(inv.token);
          if (!exists) {
            db.prepare(`INSERT OR IGNORE INTO invites (token,access_role,expires_at,used_at,note) VALUES (?,?,?,?,?)`).run(
              inv.token, inv.role || 'viewer', inv.expires_at, inv.used_at || null, inv.note || null
            );
          }
        }
      } catch(e) {}
    }
  }

  // Миграция daily_entries + account_expenses → transactions
  const txCnt = db.prepare('SELECT COUNT(*) as c FROM transactions').get().c;
  if (txCnt === 0) {
    const hasDaily = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_entries'").get();
    const hasExp   = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='account_expenses'").get();

    const catIncome  = db.prepare("SELECT id FROM categories WHERE name='Оплата VPN' LIMIT 1").get();
    const catExpOther= db.prepare("SELECT id FROM categories WHERE name='Прочий расход' LIMIT 1").get();
    const catCatMap  = { 'Реклама':'Реклама','Сервера':'Сервера','LeadTex':'LeadTex','ФНС':'ФНС / Налоги','ТГ Прем':'TG Premium','СКАМ':'СКАМ / Убытки','Прочее':'Прочий расход' };

    if (hasDaily) {
      const rows = db.prepare('SELECT * FROM daily_entries').all();
      const ins  = db.prepare(`INSERT OR IGNORE INTO transactions (date,direction,amount,category_id,note,payment_id) VALUES (?,?,?,?,?,?)`);
      db.transaction(() => {
        for (const r of rows) {
          if (r.revenue > 0) ins.run(r.date, 'in',  r.revenue, catIncome?.id || null, r.note || '', `migrated_rev_${r.id}`);
          if (r.expense > 0) ins.run(r.date, 'out', r.expense, catExpOther?.id || null, r.note || '', `migrated_exp_${r.id}`);
        }
      })();
    }

    if (hasExp) {
      const rows = db.prepare('SELECT * FROM account_expenses').all();
      const ins  = db.prepare(`INSERT OR IGNORE INTO transactions (date,direction,amount,category_id,note,receipt_url,receipt_file,payment_id) VALUES (?,?,?,?,?,?,?,?)`);
      db.transaction(() => {
        for (const r of rows) {
          const catName = catCatMap[r.category] || 'Прочий расход';
          const cat = db.prepare('SELECT id FROM categories WHERE name=? LIMIT 1').get(catName);
          ins.run(r.date, 'out', r.amount, cat?.id || catExpOther?.id || null, r.description || '', r.receipt_url || '', r.receipt_file || '', `migrated_ae_${r.id}`);
        }
      })();
    }

    // Миграция investments
    const hasInv = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='investments'").get();
    if (hasInv) {
      const rows = db.prepare('SELECT i.*, p.id as pid FROM investments i LEFT JOIN partners p ON p.id=i.partner_id').all();
      const ins  = db.prepare(`INSERT OR IGNORE INTO transactions (date,direction,amount,category_id,partner_id,note,receipt_url,payment_id) VALUES (?,?,?,?,?,?,?,?)`);
      db.transaction(() => {
        for (const r of rows) {
          const catName = r.type === 'invested' ? 'Вложение инвестора' : r.type === 'returned' ? 'Возврат инвестору' : 'Прочий расход';
          const cat = db.prepare('SELECT id FROM categories WHERE name=? LIMIT 1').get(catName);
          const dir = r.type === 'invested' ? 'in' : 'out';
          ins.run(r.date, dir, r.amount, cat?.id || null, r.pid || null, r.note || '', r.receipt_url || '', `migrated_inv_${r.id}`);
        }
      })();
    }

    console.log('✅ Транзакции мигрированы');
  }
}

try { migrate(); } catch(e) { console.error('Migration error:', e.message); }

module.exports = db;

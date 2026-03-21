const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const db = new Database(path.join(dataDir, 'accounting.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- Партнёры (заменяет захардкоженных Артём/Роман/Михаил)
  CREATE TABLE IF NOT EXISTS partners (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT 'owner'
                 CHECK(role IN ('investor','owner','employee')),
    share_type TEXT NOT NULL DEFAULT 'none'
                 CHECK(share_type IN ('percent','fixed','none')),
    share_value REAL NOT NULL DEFAULT 0,
    color      TEXT NOT NULL DEFAULT '#00e5ff',
    tg_chat_id TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Ежедневные записи (доход/расход)
  CREATE TABLE IF NOT EXISTS daily_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT NOT NULL UNIQUE,
    revenue    REAL NOT NULL DEFAULT 0,
    expense    REAL NOT NULL DEFAULT 0,
    note       TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- Снятия по партнёрам (гибко — любой тип, любой партнёр)
  CREATE TABLE IF NOT EXISTS partner_daily (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    date           TEXT NOT NULL,
    partner_id     INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
    amount         REAL NOT NULL DEFAULT 0,
    type           TEXT NOT NULL DEFAULT 'withdrawal'
                     CHECK(type IN ('withdrawal','dividend','investment_return')),
    note           TEXT,
    created_at     TEXT DEFAULT (datetime('now'))
  );

  -- Расходы со счёта
  CREATE TABLE IF NOT EXISTS account_expenses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT NOT NULL,
    category     TEXT NOT NULL
                   CHECK(category IN ('Реклама','Сервера','LeadTex','ФНС','ТГ Прем','СКАМ','Прочее')),
    description  TEXT NOT NULL,
    amount       REAL NOT NULL,
    receipt_url  TEXT,
    receipt_file TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  -- Инвестиции (трекер вложений/возвратов по партнёру)
  CREATE TABLE IF NOT EXISTS investments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    date         TEXT NOT NULL,
    partner_id   INTEGER REFERENCES partners(id) ON DELETE SET NULL,
    type         TEXT NOT NULL DEFAULT 'expense'
                   CHECK(type IN ('invested','returned','expense')),
    category     TEXT,
    amount       REAL NOT NULL,
    receipt_url  TEXT,
    receipt_file TEXT,
    note         TEXT,
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
    created_at       TEXT DEFAULT (datetime('now'))
  );

  -- Ручные KPI по месяцам (Статистика)
  CREATE TABLE IF NOT EXISTS monthly_stats (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    month                TEXT NOT NULL UNIQUE,
    avg_check            REAL,
    payment_count        INTEGER,
    refunds              REAL,
    tag_paid             INTEGER,
    online_users         INTEGER,
    online_week          INTEGER,
    channel_subscribers  INTEGER,
    notes                TEXT,
    created_at           TEXT DEFAULT (datetime('now'))
  );

  -- Загруженные файлы-чеки
  CREATE TABLE IF NOT EXISTS receipt_files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    filename      TEXT NOT NULL,
    original_name TEXT,
    mimetype      TEXT,
    size          INTEGER,
    uploaded_at   TEXT DEFAULT (datetime('now'))
  );
`);

// ── Миграция: переносим старые инкас-колонки в partner_daily ──────────────
function migrate() {
  const cols = db.pragma('table_info(daily_entries)').map(r => r.name);

  const hasOldCols = cols.includes('incas_artem');
  if (!hasOldCols) return;

  const partnerCount = db.prepare('SELECT COUNT(*) as c FROM partners').get().c;
  if (partnerCount === 0) {
    // Создаём дефолтных партнёров
    db.prepare(`INSERT INTO partners (name,role,share_type,share_value,color,sort_order)
                VALUES (?,?,?,?,?,?)`).run('Артём',  'owner',    'none', 0, '#00e5ff', 1);
    db.prepare(`INSERT INTO partners (name,role,share_type,share_value,color,sort_order)
                VALUES (?,?,?,?,?,?)`).run('Роман',  'investor', 'none', 0, '#f97316', 2);
    db.prepare(`INSERT INTO partners (name,role,share_type,share_value,color,sort_order)
                VALUES (?,?,?,?,?,?)`).run('Михаил', 'owner',    'none', 0, '#00f5a0', 3);
    console.log('✅ Созданы дефолтные партнёры: Артём, Роман, Михаил');
  }

  const artem  = db.prepare("SELECT id FROM partners WHERE name='Артём'  LIMIT 1").get();
  const roman  = db.prepare("SELECT id FROM partners WHERE name='Роман'  LIMIT 1").get();
  const misha  = db.prepare("SELECT id FROM partners WHERE name='Михаил' LIMIT 1").get();

  const migratedCount = db.prepare('SELECT COUNT(*) as c FROM partner_daily').get().c;
  if (migratedCount === 0) {
    const rows = db.prepare('SELECT * FROM daily_entries').all();
    const ins  = db.prepare(`INSERT OR IGNORE INTO partner_daily (date,partner_id,amount,type)
                              VALUES (?,?,?,?)`);
    let n = 0;
    db.transaction(() => {
      for (const r of rows) {
        if (r.incas_artem  > 0 && artem) { ins.run(r.date, artem.id,  r.incas_artem,  'withdrawal'); n++; }
        if (r.incas_roman  > 0 && roman) { ins.run(r.date, roman.id,  r.incas_roman,  'investment_return'); n++; }
        if (r.incas_mikhail> 0 && misha) { ins.run(r.date, misha.id,  r.incas_mikhail,'withdrawal'); n++; }
      }
    })();
    if (n > 0) console.log(`✅ Мигрировано ${n} записей инкассации в partner_daily`);
  }
}

try { migrate(); } catch(e) { console.error('Migration warning:', e.message); }

module.exports = db;

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'accounting.db');

// Создаём папку data если нет
const fs = require('fs');
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

// Производительность
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Создаём таблицы
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_entries (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    date      TEXT NOT NULL UNIQUE,
    revenue   REAL NOT NULL DEFAULT 0,
    expense   REAL NOT NULL DEFAULT 0,
    incas_artem   REAL NOT NULL DEFAULT 0,
    incas_roman   REAL NOT NULL DEFAULT 0,
    incas_mikhail REAL NOT NULL DEFAULT 0,
    note      TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS account_expenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,
    category    TEXT NOT NULL CHECK(category IN ('Реклама','Сервера','LeadTex','ФНС','ТГ Прем','СКАМ','Прочее')),
    description TEXT NOT NULL,
    amount      REAL NOT NULL,
    receipt_url TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ads (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    date             TEXT NOT NULL,
    format           TEXT,
    amount           REAL NOT NULL,
    name             TEXT NOT NULL,
    subscribers_gain INTEGER DEFAULT 0,
    channel_url      TEXT,
    screenshot_url   TEXT,
    created_at       TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS investments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,
    type        TEXT NOT NULL,
    category    TEXT NOT NULL CHECK(category IN ('Реклама','Сервера','LeadTex','ФНС','ТГ Прем','Розыгрыш','СКАМ','Прочее')),
    amount      REAL NOT NULL,
    receipt_url TEXT,
    note        TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );
`);

module.exports = db;

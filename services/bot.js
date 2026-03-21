const fetch = require('node-fetch');
const db = require('../database/db');

let polling = false;
let lastUpdateId = 0;
let botToken = null;

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function getToken() {
  return getSetting('tg_bot_token') || process.env.TG_BOT_TOKEN;
}

function getMainChannel() {
  return getSetting('tg_main_channel') || process.env.TG_CHANNEL_ID;
}

const API = (method) => `https://api.telegram.org/bot${getToken()}/${method}`;

async function sendMsg(chatId, text, opts = {}) {
  if (!getToken() || !chatId) return;
  try {
    await fetch(API('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...opts })
    });
  } catch(e) { console.error('Bot send error:', e.message); }
}

async function sendDoc(chatId, buffer, filename, caption = '') {
  if (!getToken() || !chatId) return;
  const FormData = require('form-data');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('document', buffer, { filename });
  try {
    await fetch(API('sendDocument'), { method: 'POST', body: form });
  } catch(e) { console.error('Bot doc error:', e.message); }
}

function parseEntry(text) {
  const t = text.trim().toLowerCase();
  // "12500 доход" or "доход 12500"
  const revenueMatch = t.match(/(?:доход|выручка|поступление)\s*([\d\s]+(?:\.\d+)?)|^([\d\s]+(?:\.\d+)?)\s+(?:доход|выручка)/);
  if (revenueMatch) {
    const amount = parseFloat((revenueMatch[1] || revenueMatch[2]).replace(/\s/g, ''));
    return { type: 'revenue', amount };
  }
  // "5000 расход реклама яндекс" or "расход 5000 реклама"
  const expenseMatch = t.match(/(?:расход|трата|оплата)\s*([\d\s]+(?:\.\d+)?)\s*(.*)?|^([\d\s]+(?:\.\d+)?)\s+(?:расход|трата)\s*(.*)?/);
  if (expenseMatch) {
    const amount = parseFloat((expenseMatch[1] || expenseMatch[3] || '0').replace(/\s/g, ''));
    const descRaw = (expenseMatch[2] || expenseMatch[4] || '').trim();
    const cats = { 'реклама': 'Реклама', 'сервер': 'Сервера', 'хостинг': 'Сервера', 'лидтекс': 'LeadTex', 'leadtex': 'LeadTex', 'фнс': 'ФНС', 'налог': 'ФНС', 'тг': 'ТГ Прем', 'telegram': 'ТГ Прем' };
    let category = 'Прочее';
    for (const [k, v] of Object.entries(cats)) { if (descRaw.includes(k)) { category = v; break; } }
    return { type: 'expense', amount, description: descRaw || category, category };
  }
  // "снятие 30000 артём" 
  const withdrawMatch = t.match(/(?:снятие|снял|вывод|инкас)\s*([\d\s]+(?:\.\d+)?)\s*(.*)?/);
  if (withdrawMatch) {
    const amount = parseFloat(withdrawMatch[1].replace(/\s/g, ''));
    const name = (withdrawMatch[2] || '').trim();
    return { type: 'withdrawal', amount, partnerName: name };
  }
  return null;
}

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const text = msg.text || '';
  const today = new Date().toISOString().slice(0, 10);

  if (text === '/start' || text === '/help') {
    await sendMsg(chatId, `🤖 <b>BAZA Bot</b>

<b>Команды:</b>
/today — сводка за сегодня
/month — сводка за месяц
/report — отправить отчёт
/help — эта справка

<b>Быстрый ввод:</b>
<code>доход 12500</code>
<code>расход 5000 реклама яндекс</code>
<code>расход 3000 сервера fornex</code>
<code>снятие 30000 артём</code>

Данные сохраняются за сегодняшнюю дату.`);
    return;
  }

  if (text === '/today') {
    const entry = db.prepare("SELECT * FROM daily_entries WHERE date=?").get(today);
    const exp = db.prepare("SELECT SUM(amount) as t FROM account_expenses WHERE date=?").get(today);
    const net = (entry?.revenue || 0) - (entry?.expense || 0);
    await sendMsg(chatId, `📊 <b>Сегодня ${today}</b>

💰 Доход:  <b>${(entry?.revenue||0).toLocaleString('ru')} ₽</b>
💸 Расход: <b>${(entry?.expense||0).toLocaleString('ru')} ₽</b>
✅ Чистый: <b>${net.toLocaleString('ru')} ₽</b>
🧾 Со счёта: <b>${(exp?.t||0).toLocaleString('ru')} ₽</b>`);
    return;
  }

  if (text === '/month') {
    const prefix = today.slice(0, 7);
    const b = db.prepare("SELECT SUM(revenue) as r, SUM(expense) as e FROM daily_entries WHERE date LIKE ?").get(`${prefix}%`);
    const acc = db.prepare("SELECT SUM(amount) as t FROM account_expenses WHERE date LIKE ?").get(`${prefix}%`);
    const net = (b?.r||0) - (b?.e||0);
    await sendMsg(chatId, `📅 <b>Месяц ${prefix}</b>

💰 Выручка:  <b>${(b?.r||0).toLocaleString('ru')} ₽</b>
💸 Расход:   <b>${(b?.e||0).toLocaleString('ru')} ₽</b>
✅ Чистый:   <b>${net.toLocaleString('ru')} ₽</b>
🧾 Со счёта: <b>${(acc?.t||0).toLocaleString('ru')} ₽</b>`);
    return;
  }

  if (text === '/report') {
    await sendMsg(chatId, '⏳ Генерирую отчёт...');
    try {
      const { sendDailyReport } = require('./telegram');
      await sendDailyReport();
      await sendMsg(chatId, '✅ Отчёт отправлен!');
    } catch(e) { await sendMsg(chatId, '❌ Ошибка: ' + e.message); }
    return;
  }

  // Natural language
  const parsed = parseEntry(text);
  if (!parsed) { await sendMsg(chatId, '❓ Не понял. Напиши /help для справки.'); return; }

  try {
    if (parsed.type === 'revenue') {
      db.prepare(`INSERT INTO daily_entries (date,revenue,expense,note) VALUES (?,?,0,'') ON CONFLICT(date) DO UPDATE SET revenue=revenue+excluded.revenue`).run(today, parsed.amount);
      await sendMsg(chatId, `✅ <b>Доход записан</b>\n💰 +${parsed.amount.toLocaleString('ru')} ₽ за ${today}`);
    } else if (parsed.type === 'expense') {
      db.prepare(`INSERT INTO account_expenses (date,category,description,amount) VALUES (?,?,?,?)`).run(today, parsed.category, parsed.description, parsed.amount);
      await sendMsg(chatId, `✅ <b>Расход записан</b>\n💸 ${parsed.amount.toLocaleString('ru')} ₽ — ${parsed.description}\nКатегория: ${parsed.category}`);
    } else if (parsed.type === 'withdrawal') {
      let partner = null;
      if (parsed.partnerName) {
        const all = db.prepare('SELECT * FROM partners WHERE active=1').all();
        partner = all.find(p => p.name.toLowerCase().includes(parsed.partnerName)) || null;
      }
      if (partner) {
        db.prepare(`INSERT INTO partner_daily (date,partner_id,amount,type) VALUES (?,?,?,'withdrawal')`).run(today, partner.id, parsed.amount);
        await sendMsg(chatId, `✅ <b>Снятие записано</b>\n👤 ${partner.name}: ${parsed.amount.toLocaleString('ru')} ₽`);
      } else {
        await sendMsg(chatId, `❓ Партнёр "${parsed.partnerName}" не найден. Доступные: ${db.prepare('SELECT name FROM partners WHERE active=1').all().map(p=>p.name).join(', ')}`);
      }
    }
  } catch(e) { await sendMsg(chatId, '❌ Ошибка сохранения: ' + e.message); }
}

async function poll() {
  if (!polling) return;
  const token = getToken();
  if (!token) { setTimeout(poll, 5000); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=20&limit=10`, { timeout: 25000 });
    if (!r.ok) { setTimeout(poll, 3000); return; }
    const data = await r.json();
    if (data.ok && data.result?.length) {
      for (const update of data.result) {
        lastUpdateId = update.update_id;
        if (update.message) await handleMessage(update.message);
      }
    }
  } catch(e) { /* network errors are normal */ }
  if (polling) setTimeout(poll, 1000);
}

function startBot() {
  if (polling) return;
  const token = getToken();
  if (!token) { console.log('⚠️  TG Bot token not set — bot inactive'); return; }
  polling = true;
  console.log('🤖 Telegram bot started (polling)');
  poll();
}

function stopBot() { polling = false; }

function restartBot() { stopBot(); setTimeout(startBot, 1000); }

// Notification helpers
async function notifyNewEntry({ date, revenue, expense, note }) {
  const channel = getMainChannel();
  if (!channel || !getToken()) return;
  await sendMsg(channel, `📝 <b>Новая запись</b> ${date}\n💰 ${revenue.toLocaleString('ru')} ₽ доход\n💸 ${expense.toLocaleString('ru')} ₽ расход${note ? '\n📌 ' + note : ''}`);
}

async function notifyNewExpense({ date, category, description, amount }) {
  const channel = getMainChannel();
  if (!channel || !getToken()) return;
  await sendMsg(channel, `🧾 <b>Новый расход</b> ${date}\n💸 ${amount.toLocaleString('ru')} ₽ — ${description}\nКатегория: ${category}`);
  // Also notify each partner who has tg_chat_id set
  const notifyPartners = getSetting('notify_partners_expenses', false);
  if (notifyPartners) {
    const partners = db.prepare('SELECT * FROM partners WHERE active=1 AND tg_chat_id IS NOT NULL AND tg_chat_id != ""').all();
    for (const p of partners) {
      await sendMsg(p.tg_chat_id, `🧾 <b>Расход компании</b>\n${date}: ${description} — ${amount.toLocaleString('ru')} ₽ (${category})`);
    }
  }
}

async function notifyBudgetExceeded(category, spent, limit) {
  const channel = getMainChannel();
  if (!channel || !getToken()) return;
  await sendMsg(channel, `🚨 <b>Превышен лимит!</b>\nКатегория: ${category}\nЛимит: ${limit.toLocaleString('ru')} ₽\nФакт: ${spent.toLocaleString('ru')} ₽ (+${(spent-limit).toLocaleString('ru')} ₽)`);
}

async function sendDailyToPartners(reportText, pdfBuf, xlsBuf) {
  const partners = db.prepare('SELECT * FROM partners WHERE active=1 AND tg_chat_id IS NOT NULL AND tg_chat_id != ""').all();
  const sendReports = getSetting('notify_partner_daily_report', false);
  if (!sendReports || !getToken()) return;
  const today = new Date().toISOString().slice(0,10);
  for (const p of partners) {
    try {
      await sendMsg(p.tg_chat_id, reportText);
      if (pdfBuf) await sendDoc(p.tg_chat_id, pdfBuf, `report_${today}.pdf`, `📄 PDF отчёт`);
    } catch(e) {}
  }
}

module.exports = { startBot, stopBot, restartBot, sendMsg, sendDoc, notifyNewEntry, notifyNewExpense, notifyBudgetExceeded, sendDailyToPartners, getToken, getMainChannel };

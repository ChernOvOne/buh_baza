const fetch = require('node-fetch');
const db    = require('../database/db');

let polling = false, lastUpdateId = 0;

function getSetting(key, fallback=null) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function getToken() { return getSetting('tg_bot_token') || process.env.TG_BOT_TOKEN; }
function getMainChannel() { return getSetting('tg_main_channel') || process.env.TG_CHANNEL_ID; }
const API = m => `https://api.telegram.org/bot${getToken()}/${m}`;

async function sendMsg(chatId, text, opts={}) {
  if (!getToken()||!chatId) return;
  try { await fetch(API('sendMessage'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:chatId,text,parse_mode:'HTML',...opts})}); }
  catch(e) { console.error('Bot sendMsg error:', e.message); }
}
async function sendDoc(chatId, buffer, filename, caption='') {
  if (!getToken()||!chatId) return;
  const FormData = require('form-data');
  const form = new FormData();
  form.append('chat_id',String(chatId)); form.append('caption',caption); form.append('document',buffer,{filename});
  try { await fetch(API('sendDocument'),{method:'POST',body:form}); } catch {}
}

function parseEntry(text) {
  const t = text.trim().toLowerCase();
  const rev = t.match(/(?:доход|выручка|оплата)\s*([\d\s]+(?:\.\d+)?)|^([\d\s]+(?:\.\d+)?)\s+(?:доход|выручка)/);
  if (rev) return { type:'income', amount:parseFloat((rev[1]||rev[2]).replace(/\s/g,'')) };
  const exp = t.match(/(?:расход|трата|оплата\s+чего)\s*([\d\s]+(?:\.\d+)?)\s*(.*)?|^([\d\s]+(?:\.\d+)?)\s+(?:расход|трата)\s*(.*)?/);
  if (exp) {
    const amount = parseFloat((exp[1]||exp[3]||'0').replace(/\s/g,''));
    const descRaw = (exp[2]||exp[4]||'').trim();
    const catMap = {'реклама':'Реклама','сервер':'Сервера','хостинг':'Сервера','лидтекс':'LeadTex','фнс':'ФНС / Налоги','налог':'ФНС / Налоги','тг':'TG Premium'};
    let catName = 'Прочий расход';
    for (const [k,v] of Object.entries(catMap)) { if(descRaw.includes(k)){catName=v;break;} }
    const cat = db.prepare('SELECT id FROM categories WHERE name=? LIMIT 1').get(catName);
    return { type:'expense', amount, note:descRaw||catName, category_id:cat?.id||null };
  }
  return null;
}

async function handleMessage(msg) {
  const chatId = msg.chat?.id, text = msg.text||'';
  const today  = new Date().toISOString().slice(0,10);

  // ── Инвайт через /start TOKEN ──────────────────────────────────────────
  if (text.startsWith('/start ')) {
    const token = text.slice(7).trim();
    if (token.length > 10) {
      const inv = db.prepare('SELECT * FROM invites WHERE token=?').get(token);
      if (!inv || inv.used_at || new Date(inv.expires_at) < new Date()) {
        await sendMsg(chatId, '❌ Приглашение недействительно или уже использовано.');
        return;
      }
      // Привязываем TG пользователя
      const tg_id   = String(msg.from.id);
      const tg_name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
      const tg_user = msg.from.username;
      let partner;
      if (inv.partner_id) {
        partner = db.prepare('SELECT * FROM partners WHERE id=?').get(inv.partner_id);
        if (partner) db.prepare('UPDATE partners SET tg_id=?,tg_username=?,tg_name=?,access_role=?,active=1 WHERE id=?').run(tg_id, tg_user||null, tg_name, inv.access_role, partner.id);
      } else {
        partner = db.prepare('SELECT * FROM partners WHERE tg_id=?').get(tg_id);
        if (!partner) {
          const r = db.prepare('INSERT INTO partners (name,tg_id,tg_username,tg_name,access_role,role) VALUES (?,?,?,?,?,?)').run(tg_name||tg_user||`user_${tg_id}`,tg_id,tg_user||null,tg_name,inv.access_role,'other');
          partner = db.prepare('SELECT * FROM partners WHERE id=?').get(r.lastInsertRowid);
        } else {
          db.prepare('UPDATE partners SET access_role=?,tg_name=?,tg_username=? WHERE id=?').run(inv.access_role, tg_name, tg_user||null, partner.id);
        }
      }
      db.prepare('UPDATE invites SET used_at=datetime("now") WHERE id=?').run(inv.id);
      // Генерируем одноразовую ссылку для входа
      const jwt = require('jsonwebtoken');
      const loginToken = jwt.sign({ partner_id:partner.id, role:inv.access_role, one_time:true }, process.env.JWT_SECRET||'dev', { expiresIn:'15m' });
      const siteUrl = getSetting('site_url')||process.env.SITE_URL||'https://hiprpol.hideyou.top';
      await sendMsg(chatId, `✅ <b>Доступ получен!</b>\n\nРоль: <b>${inv.access_role}</b>\n\nНажми кнопку для входа на сайт (ссылка действует 15 минут):`, {
        reply_markup: JSON.stringify({ inline_keyboard: [[{ text: '🚀 Войти в BAZA', url: `${siteUrl}/invite/login/${loginToken}` }]] })
      });
      return;
    }
  }

  if (text === '/start') {
    await sendMsg(chatId, `🤖 <b>BAZA Bot</b>\n\n<b>Команды:</b>\n/today — сводка за сегодня\n/month — сводка за месяц\n/report — отправить отчёт\n\n<b>Быстрый ввод:</b>\n<code>доход 12500</code>\n<code>расход 5000 реклама</code>`);
    return;
  }

  if (text === '/today') {
    const inc = db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE direction='in' AND date=? AND mode='live'`).get(today).t;
    const exp = db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE direction='out' AND date=? AND mode='live'`).get(today).t;
    await sendMsg(chatId, `📊 <b>${today}</b>\n\n💰 Приход:  <b>${inc.toLocaleString('ru')} ₽</b>\n💸 Расход:  <b>${exp.toLocaleString('ru')} ₽</b>\n✅ Баланс: <b>${(inc-exp).toLocaleString('ru')} ₽</b>`);
    return;
  }
  if (text === '/month') {
    const prefix = today.slice(0,7);
    const inc = db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE direction='in' AND date LIKE ? AND mode='live'`).get(`${prefix}%`).t;
    const exp = db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE direction='out' AND date LIKE ? AND mode='live'`).get(`${prefix}%`).t;
    await sendMsg(chatId, `📅 <b>${prefix}</b>\n\n💰 Приход:  <b>${inc.toLocaleString('ru')} ₽</b>\n💸 Расход:  <b>${exp.toLocaleString('ru')} ₽</b>\n✅ Итого: <b>${(inc-exp).toLocaleString('ru')} ₽</b>`);
    return;
  }
  if (text === '/report') {
    await sendMsg(chatId, '⏳ Отправляю...');
    try { await require('./telegram').sendDailyReport(); await sendMsg(chatId, '✅ Отчёт отправлен!'); }
    catch(e) { await sendMsg(chatId, '❌ ' + e.message); }
    return;
  }

  const parsed = parseEntry(text);
  if (!parsed) { await sendMsg(chatId, '❓ Не понял. Напиши /help'); return; }
  try {
    if (parsed.type === 'income') {
      const cat = db.prepare("SELECT id FROM categories WHERE name='Оплата VPN' LIMIT 1").get();
      db.prepare(`INSERT INTO transactions (date,direction,amount,category_id,note,mode) VALUES (?,?,?,?,?,?)`).run(today,'in',parsed.amount,cat?.id||null,'Бот: доход','live');
      await sendMsg(chatId, `✅ Записано\n💰 +${parsed.amount.toLocaleString('ru')} ₽ — доход`);
    } else {
      db.prepare(`INSERT INTO transactions (date,direction,amount,category_id,note,mode) VALUES (?,?,?,?,?,?)`).run(today,'out',parsed.amount,parsed.category_id||null,parsed.note||'Бот: расход','live');
      await sendMsg(chatId, `✅ Записано\n💸 ${parsed.amount.toLocaleString('ru')} ₽ — ${parsed.note}`);
    }
  } catch(e) { await sendMsg(chatId, '❌ Ошибка: ' + e.message); }
}

async function poll() {
  if (!polling) return;
  const token = getToken();
  if (!token) { setTimeout(poll, 10000); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId+1}&timeout=20&limit=10`, { timeout: 25000 });
    if (r.ok) {
      const data = await r.json();
      if (data.ok && data.result?.length) {
        for (const upd of data.result) { lastUpdateId = upd.update_id; if (upd.message) await handleMessage(upd.message); }
      }
    }
  } catch {}
  if (polling) setTimeout(poll, 1000);
}

function startBot() {
  if (polling) return;
  if (!getToken()) { console.log('⚠️  TG токен не настроен'); return; }
  polling = true;
  console.log('🤖 Telegram бот запущен');
  poll();
}
function stopBot()    { polling = false; }
function restartBot() { stopBot(); setTimeout(startBot, 1500); }

async function notifyNewExpense({ date, category, description, amount }) {
  const ch = getMainChannel(); if (!ch) return;
  await sendMsg(ch, `🧾 <b>Новый расход</b>\n${date}: ${description} — ${amount.toLocaleString('ru')} ₽\n${category}`);
}
async function notifyBudgetExceeded(category, spent, limit) {
  const ch = getMainChannel(); if (!ch) return;
  await sendMsg(ch, `🚨 <b>Лимит превышен!</b>\n${category}: ${spent.toLocaleString('ru')} ₽ (лимит: ${limit.toLocaleString('ru')} ₽)`);
}

module.exports = { startBot, stopBot, restartBot, sendMsg, sendDoc, getToken, getMainChannel, notifyNewExpense, notifyBudgetExceeded };

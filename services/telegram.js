const fetch = require('node-fetch');
const FormData = require('form-data');
const db = require('../database/db');

const TG_API = () => `https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}`;

async function sendMessage(text, parse_mode = 'HTML') {
  const r = await fetch(`${TG_API()}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TG_CHANNEL_ID,
      text,
      parse_mode,
    }),
  });
  return r.json();
}

async function sendDocument(buffer, filename, caption = '') {
  const form = new FormData();
  form.append('chat_id', process.env.TG_CHANNEL_ID);
  form.append('caption', caption, { contentType: 'text/plain' });
  form.append('document', buffer, { filename, contentType: filename.endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

  const r = await fetch(`${TG_API()}/sendDocument`, { method: 'POST', body: form });
  return r.json();
}

async function sendDailyReport() {
  const { generateDailyPDF } = require('./pdf');
  const { generateMonthlyExcel } = require('./excel');

  const today = new Date().toISOString().slice(0, 10);
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;

  const entry = db.prepare("SELECT * FROM daily_entries WHERE date=?").get(today);
  const expenses = db.prepare("SELECT * FROM account_expenses WHERE date=?").all(today);

  const totalIncas = entry ? entry.incas_artem + entry.incas_roman + entry.incas_mikhail : 0;
  const net        = entry ? entry.revenue - entry.expense : 0;

  // Сообщение-сводка
  const text = `
<b>📊 ЕЖЕДНЕВНЫЙ ОТЧЁТ</b>
━━━━━━━━━━━━━━━━━━━━━
📅 Дата: <b>${today}</b>

💰 Доход:     <b>${(entry?.revenue || 0).toLocaleString('ru', { minimumFractionDigits: 2 })} ₽</b>
💸 Расход:    <b>${(entry?.expense || 0).toLocaleString('ru', { minimumFractionDigits: 2 })} ₽</b>
✅ Чистый:    <b>${net.toLocaleString('ru', { minimumFractionDigits: 2 })} ₽</b>

👥 Инкассация:
  • Артём:  <b>${(entry?.incas_artem || 0).toLocaleString('ru', { minimumFractionDigits: 2 })} ₽</b>
  • Роман:  <b>${(entry?.incas_roman || 0).toLocaleString('ru', { minimumFractionDigits: 2 })} ₽</b>
  • Михаил: <b>${(entry?.incas_mikhail || 0).toLocaleString('ru', { minimumFractionDigits: 2 })} ₽</b>
  ━━ Итого: <b>${totalIncas.toLocaleString('ru', { minimumFractionDigits: 2 })} ₽</b>

${expenses.length > 0 ? `🧾 Расходы со счёта (${expenses.length} шт.):\n` + expenses.map(e => `  • ${e.category}: ${e.description} — <b>${e.amount.toLocaleString('ru', { minimumFractionDigits: 2 })} ₽</b>`).join('\n') : ''}
━━━━━━━━━━━━━━━━━━━━━
🤖 AccountingService`;

  await sendMessage(text);

  // PDF за сегодня
  try {
    const pdf = await generateDailyPDF(today);
    await sendDocument(pdf, `report_${today}.pdf`, `📄 PDF отчёт за ${today}`);
  } catch (e) {
    console.error('PDF error:', e.message);
  }

  // Excel за текущий месяц
  try {
    const xlsx = await generateMonthlyExcel(year, month);
    await sendDocument(xlsx, `monthly_${year}_${String(month).padStart(2, '0')}.xlsx`, `📊 Excel отчёт за месяц`);
  } catch (e) {
    console.error('Excel error:', e.message);
  }

  console.log(`[${new Date().toISOString()}] Отчёт отправлен в Telegram`);
}

async function testConnection() {
  try {
    const r = await fetch(`${TG_API()}/getMe`);
    const data = await r.json();
    return data.ok ? data.result : null;
  } catch { return null; }
}

module.exports = { sendDailyReport, sendMessage, testConnection };

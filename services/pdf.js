const PDFDocument = require('pdfkit');
const db = require('../database/db');
const path = require('path');
const fs = require('fs');

// Шрифт с кириллицей — встроенный Helvetica не поддерживает, используем системный
function getFontPath() {
  const candidates = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

async function generateDailyPDF(date) {
  const entry = db.prepare("SELECT * FROM daily_entries WHERE date=?").get(date);
  const expenses = db.prepare("SELECT * FROM account_expenses WHERE date=?").all(date);
  const fontPath = getFontPath();

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Отчёт ${date}` } });

    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 100;
    const registerFont = (name, style = 'normal') => {
      if (fontPath) try { doc.registerFont(name, fontPath); } catch {}
    };

    // Цвета
    const BG    = '#0a0a12';
    const CARD  = '#111120';
    const ACC   = '#00d4ff';
    const GREEN = '#00ff88';
    const RED   = '#ff4d4d';
    const GOLD  = '#ffd700';
    const GRAY  = '#8892a4';
    const WHITE = '#e2e8f0';

    // Фон
    doc.rect(0, 0, doc.page.width, doc.page.height).fill(BG);

    // Заголовок
    doc.rect(50, 50, W, 70).fill(CARD).stroke('#1a1a2e');
    if (fontPath) doc.registerFont('main', fontPath);

    doc.fillColor(ACC)
       .fontSize(22)
       .font(fontPath ? 'main' : 'Helvetica-Bold')
       .text('ФИНАНСОВЫЙ ОТЧЁТ', 50, 65, { width: W, align: 'center' });

    doc.fillColor(GRAY)
       .fontSize(11)
       .text(`Дата: ${date}  •  Сформирован: ${new Date().toLocaleString('ru')}`, 50, 95, { width: W, align: 'center' });

    // ── Карточки KPI ───────────────────────────────────────────────────────
    let y = 140;
    const net = (entry?.revenue || 0) - (entry?.expense || 0);
    const totalIncas = (entry?.incas_artem || 0) + (entry?.incas_roman || 0) + (entry?.incas_mikhail || 0);

    const kpis = [
      { label: 'Доход',       value: entry?.revenue  || 0, color: GREEN,  col: 0 },
      { label: 'Расход',      value: entry?.expense  || 0, color: RED,    col: 1 },
      { label: 'Чистый',      value: net,                  color: net >= 0 ? GREEN : RED, col: 2 },
      { label: 'Инкасс.',     value: totalIncas,           color: GOLD,   col: 3 },
    ];

    const cardW = (W - 30) / 4;
    kpis.forEach((k) => {
      const cx = 50 + k.col * (cardW + 10);
      doc.rect(cx, y, cardW, 70).fill(CARD).stroke('#1a1a2e');
      doc.fillColor(GRAY).fontSize(9).font(fontPath ? 'main' : 'Helvetica')
         .text(k.label, cx, y + 12, { width: cardW, align: 'center' });
      doc.fillColor(k.color).fontSize(16).font(fontPath ? 'main' : 'Helvetica-Bold')
         .text(`${k.value.toLocaleString('ru', { minimumFractionDigits: 2 })} ₽`, cx, y + 32, { width: cardW, align: 'center' });
    });
    y += 90;

    // ── Инкас по партнёрам ─────────────────────────────────────────────────
    if (entry && (entry.incas_artem + entry.incas_roman + entry.incas_mikhail) > 0) {
      doc.rect(50, y, W, 28).fill('#0f1a2e');
      doc.fillColor(ACC).fontSize(12).font(fontPath ? 'main' : 'Helvetica-Bold')
         .text('Инкассация по партнёрам', 60, y + 8);
      y += 35;

      const partners = [
        { name: 'Артём',  val: entry.incas_artem   },
        { name: 'Роман',  val: entry.incas_roman   },
        { name: 'Михаил', val: entry.incas_mikhail },
      ];
      partners.forEach(p => {
        if (p.val > 0) {
          doc.fillColor(WHITE).fontSize(10).font(fontPath ? 'main' : 'Helvetica')
             .text(`  ${p.name}:`, 60, y, { continued: true });
          doc.fillColor(GOLD).text(`  ${p.val.toLocaleString('ru', { minimumFractionDigits: 2 })} ₽`, { align: 'right' });
          y += 18;
        }
      });
    }

    // ── Расходы со счёта ───────────────────────────────────────────────────
    if (expenses.length > 0) {
      y += 10;
      doc.rect(50, y, W, 28).fill('#0f1a2e');
      doc.fillColor(ACC).fontSize(12).font(fontPath ? 'main' : 'Helvetica-Bold')
         .text('Расходы со счёта', 60, y + 8);
      y += 35;

      // Шапка таблицы
      doc.rect(50, y, W, 20).fill('#1a1a2e');
      doc.fillColor(GRAY).fontSize(9)
         .text('Категория', 60, y + 5, { width: 100 })
         .text('Описание', 160, y + 5, { width: W - 160 - 80 })
         .text('Сумма', 50 + W - 80, y + 5, { width: 80, align: 'right' });
      y += 22;

      let totalExp = 0;
      expenses.forEach((e, i) => {
        totalExp += e.amount;
        const rowBg = i % 2 === 0 ? '#0d0d1a' : '#111124';
        doc.rect(50, y, W, 18).fill(rowBg);
        doc.fillColor(GRAY).fontSize(9).font(fontPath ? 'main' : 'Helvetica')
           .text(e.category, 60, y + 4, { width: 100 });
        doc.fillColor(WHITE)
           .text(e.description, 160, y + 4, { width: W - 160 - 80 });
        doc.fillColor(RED)
           .text(`${e.amount.toLocaleString('ru', { minimumFractionDigits: 2 })} ₽`, 50 + W - 80, y + 4, { width: 80, align: 'right' });
        y += 20;
      });

      // Итог
      doc.rect(50, y, W, 22).fill('#0f3460');
      doc.fillColor(GOLD).fontSize(11).font(fontPath ? 'main' : 'Helvetica-Bold')
         .text('ИТОГО РАСХОДОВ:', 60, y + 5)
         .text(`${totalExp.toLocaleString('ru', { minimumFractionDigits: 2 })} ₽`, 50 + W - 120, y + 5, { width: 110, align: 'right' });
      y += 30;
    }

    // ── Примечание ─────────────────────────────────────────────────────────
    if (entry?.note) {
      y += 10;
      doc.rect(50, y, W, 40).fill(CARD).stroke('#1a1a2e');
      doc.fillColor(GRAY).fontSize(9).text('Примечание:', 60, y + 8);
      doc.fillColor(WHITE).text(entry.note, 60, y + 20, { width: W - 20 });
      y += 48;
    }

    // ── Подпись ────────────────────────────────────────────────────────────
    doc.rect(50, doc.page.height - 60, W, 30).fill(CARD);
    doc.fillColor(GRAY).fontSize(8)
       .text(`AccountingService • ${new Date().toLocaleString('ru')}`, 50, doc.page.height - 48, { width: W, align: 'center' });

    doc.end();
  });
}

async function generateMonthlyPDF(year, month) {
  const prefix    = `${year}-${String(month).padStart(2, '0')}`;
  const monthName = new Date(year, month - 1).toLocaleString('ru', { month: 'long', year: 'numeric' });
  const entries   = db.prepare("SELECT * FROM daily_entries WHERE date LIKE ? ORDER BY date").all(`${prefix}%`);
  const expenses  = db.prepare("SELECT * FROM account_expenses WHERE date LIKE ? ORDER BY date").all(`${prefix}%`);
  const fontPath  = getFontPath();

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Отчёт ${monthName}` } });
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 80;
    const BG = '#0a0a12', CARD = '#111120', ACC = '#00d4ff';
    const GREEN = '#00ff88', RED = '#ff4d4d', GOLD = '#ffd700', GRAY = '#8892a4', WHITE = '#e2e8f0';

    if (fontPath) doc.registerFont('main', fontPath);
    const F = (b) => fontPath ? 'main' : (b ? 'Helvetica-Bold' : 'Helvetica');

    doc.rect(0, 0, doc.page.width, doc.page.height).fill(BG);

    // Заголовок
    doc.rect(40, 40, W, 65).fill(CARD);
    doc.fillColor(ACC).fontSize(20).font(F(true))
       .text(`ОТЧЁТ ЗА ${monthName.toUpperCase()}`, 40, 55, { width: W, align: 'center' });
    doc.fillColor(GRAY).fontSize(10).font(F())
       .text(`Сформирован: ${new Date().toLocaleString('ru')}`, 40, 85, { width: W, align: 'center' });

    // Итоги месяца
    const totalRevenue = entries.reduce((s, e) => s + e.revenue, 0);
    const totalExpense = entries.reduce((s, e) => s + e.expense, 0);
    const totalIncas   = entries.reduce((s, e) => s + e.incas_artem + e.incas_roman + e.incas_mikhail, 0);
    const totalExpAcc  = expenses.reduce((s, e) => s + e.amount, 0);
    const net          = totalRevenue - totalExpense;
    const avgDay       = entries.length ? totalRevenue / entries.length : 0;

    let y = 125;
    const kw = (W - 20) / 3;
    [
      { l: 'Выручка',     v: totalRevenue, c: GREEN },
      { l: 'Расход (нал)',v: totalExpense, c: RED   },
      { l: 'Чистый',      v: net,          c: net >= 0 ? GREEN : RED },
    ].forEach((k, i) => {
      const cx = 40 + i * (kw + 10);
      doc.rect(cx, y, kw, 62).fill(CARD);
      doc.fillColor(GRAY).fontSize(9).font(F()).text(k.l, cx, y + 10, { width: kw, align: 'center' });
      doc.fillColor(k.c).fontSize(15).font(F(true))
         .text(`${k.v.toLocaleString('ru', { minimumFractionDigits: 2 })} ₽`, cx, y + 30, { width: kw, align: 'center' });
    });
    y += 72;

    [
      { l: 'Расходы со счёта', v: totalExpAcc, c: RED  },
      { l: 'Инкассация',       v: totalIncas,  c: GOLD },
      { l: 'Средняя в день',   v: avgDay,      c: ACC  },
    ].forEach((k, i) => {
      const cx = 40 + i * (kw + 10);
      doc.rect(cx, y, kw, 62).fill(CARD);
      doc.fillColor(GRAY).fontSize(9).font(F()).text(k.l, cx, y + 10, { width: kw, align: 'center' });
      doc.fillColor(k.c).fontSize(15).font(F(true))
         .text(`${k.v.toLocaleString('ru', { minimumFractionDigits: 2 })} ₽`, cx, y + 30, { width: kw, align: 'center' });
    });
    y += 78;

    // Таблица по дням
    doc.rect(40, y, W, 24).fill('#0f1a2e');
    doc.fillColor(ACC).fontSize(11).font(F(true)).text('Ежедневные данные', 50, y + 6);
    y += 28;

    // Заголовки таблицы
    const cols = [
      { h: 'Дата',   w: 75  },
      { h: 'Доход',  w: 100 },
      { h: 'Расход', w: 100 },
      { h: 'Чистый', w: 100 },
      { h: 'Инкас',  w: 100 },
    ];
    let cx = 40;
    doc.rect(40, y, W, 18).fill('#1a1a2e');
    cols.forEach(c => {
      doc.fillColor(GRAY).fontSize(8).font(F(true)).text(c.h, cx + 4, y + 4, { width: c.w - 4 });
      cx += c.w;
    });
    y += 20;

    entries.forEach((e, i) => {
      if (y > doc.page.height - 80) {
        doc.addPage();
        doc.rect(0, 0, doc.page.width, doc.page.height).fill(BG);
        y = 40;
      }
      const rowNet   = e.revenue - e.expense;
      const rowIncas = e.incas_artem + e.incas_roman + e.incas_mikhail;
      const rowBg    = i % 2 === 0 ? '#0d0d1a' : '#111124';
      doc.rect(40, y, W, 17).fill(rowBg);

      cx = 40;
      const vals = [e.date, e.revenue, e.expense, rowNet, rowIncas];
      const colors = [WHITE, GREEN, RED, rowNet >= 0 ? GREEN : RED, GOLD];
      cols.forEach((c, ci) => {
        const v = vals[ci];
        const txt = typeof v === 'number' ? `${v.toLocaleString('ru', { minimumFractionDigits: 2 })} ₽` : v;
        doc.fillColor(colors[ci]).fontSize(8).font(F()).text(txt, cx + 4, y + 4, { width: c.w - 8 });
        cx += c.w;
      });
      y += 18;
    });

    doc.end();
  });
}

module.exports = { generateDailyPDF, generateMonthlyPDF };

const ExcelJS = require('exceljs');
const db = require('../database/db');

async function generateMonthlyExcel(year, month) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'AccountingService';
  workbook.created = new Date();

  const monthName = new Date(year, month - 1).toLocaleString('ru', { month: 'long', year: 'numeric' });
  const prefix = `${year}-${String(month).padStart(2, '0')}`;

  // ── Стили ──────────────────────────────────────────────────────────────────
  const headerFill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a2e' } };
  const accentFill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0f3460' } };
  const greenFill    = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0d3b2e' } };
  const redFill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3b0d0d' } };
  const headerFont   = { bold: true, color: { argb: 'FF00d4ff' }, size: 11 };
  const whiteFont    = { color: { argb: 'FFe2e8f0' }, size: 10 };
  const greenFont    = { color: { argb: 'FF00ff88' }, bold: true };
  const redFont      = { color: { argb: 'FFff4d4d' }, bold: true };
  const border       = { top: { style: 'thin', color: { argb: 'FF2a2a3e' } }, bottom: { style: 'thin', color: { argb: 'FF2a2a3e' } }, left: { style: 'thin', color: { argb: 'FF2a2a3e' } }, right: { style: 'thin', color: { argb: 'FF2a2a3e' } } };
  const numFmt       = '#,##0.00 "₽"';

  // ── Лист 1: Ежедневные записи ─────────────────────────────────────────────
  const ws1 = workbook.addWorksheet(`📅 ${monthName}`, {
    pageSetup: { fitToPage: true, fitToWidth: 1 },
    properties: { tabColor: { argb: 'FF00d4ff' } }
  });

  const entries = db.prepare("SELECT * FROM daily_entries WHERE date LIKE ? ORDER BY date").all(`${prefix}%`);

  ws1.columns = [
    { header: 'Дата',           key: 'date',          width: 14 },
    { header: 'Доход',          key: 'revenue',        width: 16 },
    { header: 'Расход',         key: 'expense',        width: 16 },
    { header: 'Чистый',         key: 'net',            width: 16 },
    { header: 'Инкас Артём',    key: 'incas_artem',    width: 16 },
    { header: 'Инкас Роман',    key: 'incas_roman',    width: 16 },
    { header: 'Инкас Михаил',   key: 'incas_mikhail',  width: 16 },
    { header: 'Всего инкас',    key: 'total_incas',    width: 16 },
    { header: 'Примечание',     key: 'note',           width: 30 },
  ];

  // Заголовок
  ws1.getRow(1).eachCell(cell => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.border = border;
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  ws1.getRow(1).height = 24;

  let totalRevenue = 0, totalExpense = 0, totalIncas = 0;
  entries.forEach((e, i) => {
    const net = e.revenue - e.expense;
    const incas = e.incas_artem + e.incas_roman + e.incas_mikhail;
    totalRevenue += e.revenue;
    totalExpense += e.expense;
    totalIncas   += incas;

    const row = ws1.addRow({
      date:         e.date,
      revenue:      e.revenue,
      expense:      e.expense,
      net:          net,
      incas_artem:  e.incas_artem,
      incas_roman:  e.incas_roman,
      incas_mikhail: e.incas_mikhail,
      total_incas:  incas,
      note:         e.note || '',
    });

    const bg = i % 2 === 0 ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0d0d1a' } }
                           : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF111124' } };

    row.eachCell(cell => {
      cell.fill = bg;
      cell.font = whiteFont;
      cell.border = border;
    });

    // Цвет чистой прибыли
    const netCell = row.getCell('net');
    netCell.font = net >= 0 ? greenFont : redFont;
    netCell.fill = net >= 0 ? greenFill : redFill;

    // Формат чисел
    ['revenue','expense','net','incas_artem','incas_roman','incas_mikhail','total_incas'].forEach(k => {
      row.getCell(k).numFmt = numFmt;
    });
    row.height = 20;
  });

  // Итоговая строка
  const totalRow = ws1.addRow({
    date: 'ИТОГО',
    revenue: totalRevenue,
    expense: totalExpense,
    net: totalRevenue - totalExpense,
    total_incas: totalIncas,
  });
  totalRow.eachCell(cell => {
    cell.fill = accentFill;
    cell.font = { bold: true, color: { argb: 'FFffd700' }, size: 11 };
    cell.border = border;
  });
  ['revenue','expense','net','total_incas'].forEach(k => {
    totalRow.getCell(k).numFmt = numFmt;
  });
  totalRow.height = 22;

  // ── Лист 2: Расходы со счёта ─────────────────────────────────────────────
  const ws2 = workbook.addWorksheet('💸 Расходы', {
    properties: { tabColor: { argb: 'FFff4d4d' } }
  });

  const expenses = db.prepare("SELECT * FROM account_expenses WHERE date LIKE ? ORDER BY date").all(`${prefix}%`);

  ws2.columns = [
    { header: 'Дата',        key: 'date',        width: 14 },
    { header: 'Категория',   key: 'category',    width: 14 },
    { header: 'Описание',    key: 'description', width: 35 },
    { header: 'Сумма',       key: 'amount',      width: 16 },
    { header: 'Чек',         key: 'receipt_url', width: 40 },
  ];
  ws2.getRow(1).eachCell(cell => {
    cell.fill = headerFill; cell.font = headerFont; cell.border = border;
    cell.alignment = { horizontal: 'center' };
  });
  ws2.getRow(1).height = 24;

  let totalExp = 0;
  expenses.forEach((e, i) => {
    totalExp += e.amount;
    const row = ws2.addRow(e);
    const bg = i % 2 === 0 ? { type:'pattern',pattern:'solid',fgColor:{argb:'FF0d0d1a'} }
                           : { type:'pattern',pattern:'solid',fgColor:{argb:'FF111124'} };
    row.eachCell(cell => { cell.fill = bg; cell.font = whiteFont; cell.border = border; });
    row.getCell('amount').numFmt = numFmt;
    row.getCell('amount').font = redFont;
    row.height = 20;
  });

  const expTotal = ws2.addRow({ date: 'ИТОГО', amount: totalExp });
  expTotal.eachCell(c => { c.fill = accentFill; c.font = { bold:true, color:{argb:'FFffd700'} }; c.border = border; });
  expTotal.getCell('amount').numFmt = numFmt;

  // ── Лист 3: Сводка ────────────────────────────────────────────────────────
  const ws3 = workbook.addWorksheet('📊 Сводка', {
    properties: { tabColor: { argb: 'FF00ff88' } }
  });

  const expByCategory = db.prepare(`
    SELECT category, SUM(amount) as total FROM account_expenses WHERE date LIKE ? GROUP BY category
  `).all(`${prefix}%`);

  ws3.columns = [
    { header: 'Показатель', key: 'label', width: 28 },
    { header: 'Значение',   key: 'value', width: 20 },
  ];
  ws3.getRow(1).eachCell(cell => {
    cell.fill = headerFill; cell.font = headerFont; cell.border = border;
    cell.alignment = { horizontal: 'center' };
  });

  const totalNet = totalRevenue - totalExpense;
  const avgDay = entries.length > 0 ? totalRevenue / entries.length : 0;

  const summaryRows = [
    ['Период', monthName],
    ['Всего доходов', totalRevenue],
    ['Всего расходов (нал)', totalExpense],
    ['Чистая прибыль (нал)', totalNet],
    ['Расходы со счёта', totalExp],
    ['Средняя выручка в день', avgDay],
    ['Дней с данными', entries.length],
    ['', ''],
    ['— По категориям расходов —', ''],
    ...expByCategory.map(r => [r.category, r.total]),
  ];

  summaryRows.forEach((r, i) => {
    const row = ws3.addRow({ label: r[0], value: r[1] });
    const bg = i % 2 === 0 ? { type:'pattern',pattern:'solid',fgColor:{argb:'FF0d0d1a'} }
                           : { type:'pattern',pattern:'solid',fgColor:{argb:'FF111124'} };
    row.eachCell(c => { c.fill = bg; c.font = whiteFont; c.border = border; });
    if (typeof r[1] === 'number') row.getCell('value').numFmt = numFmt;
    if (r[0].includes('Чистая') || r[0].includes('прибыль')) {
      row.getCell('value').font = totalNet >= 0 ? greenFont : redFont;
    }
  });

  const buf = await workbook.xlsx.writeBuffer();
  return buf;
}

module.exports = { generateMonthlyExcel };

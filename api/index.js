// Vercel-compatible server using sql.js (pure JavaScript SQLite)
// No native modules required - works in Vercel serverless functions
const express = require('express');
const initSqlJs = require('sql.js/dist/sql-asm.js');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3456;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// sql.js wrapper to mimic better-sqlite3 API
class DB {
  constructor(sqlJsDb) { this.db = sqlJsDb; }
  pragma(str) { this.db.exec('PRAGMA ' + str); }
  exec(sql) { this.db.exec(sql); }
  prepare(sql) {
    const db = this.db;
    return {
      all(...params) {
        const stmt = db.prepare(sql);
        if (params.length) stmt.bind(params);
        const results = [];
        while (stmt.step()) results.push(stmt.getAsObject());
        stmt.free();
        return results;
      },
      get(...params) {
        const stmt = db.prepare(sql);
        if (params.length) stmt.bind(params);
        let result = undefined;
        if (stmt.step()) result = stmt.getAsObject();
        stmt.free();
        return result;
      },
      run(...params) {
        db.run(sql, params);
        const changes = db.getRowsModified();
        let lastInsertRowid = 0;
        try { const r = db.exec('SELECT last_insert_rowid()'); if (r.length && r[0].values.length) lastInsertRowid = r[0].values[0][0]; } catch(e) {}
        return { changes, lastInsertRowid };
      }
    };
  }
}

let db;

async function initDB() {
  const SQL = await initSqlJs();
  const sqlDb = new SQL.Database();
  db = new DB(sqlDb);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_number INTEGER NOT NULL, entry_date TEXT NOT NULL, entry_month INTEGER NOT NULL, entry_year INTEGER NOT NULL, tea_qty INTEGER DEFAULT 0, breakfast_qty INTEGER DEFAULT 0, lunch_qty INTEGER DEFAULT 0, dinner_qty INTEGER DEFAULT 0, snacks_qty INTEGER DEFAULT 0, other_description TEXT DEFAULT '', other_amount REAL DEFAULT 0, daily_total REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(employee_number, entry_date))`);

  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value REAL NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS employees (employee_number INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT '')`);
  db.exec(`CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_number INTEGER NOT NULL, month INTEGER NOT NULL, year INTEGER NOT NULL, amount_paid REAL DEFAULT 0, status TEXT DEFAULT 'unpaid', note TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(employee_number, month, year))`);
  db.exec(`CREATE TABLE IF NOT EXISTS pending_carry (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_number INTEGER NOT NULL, from_month INTEGER NOT NULL, from_year INTEGER NOT NULL, pending_amount REAL DEFAULT 0, carried_to_month INTEGER NOT NULL, carried_to_year INTEGER NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')), UNIQUE(employee_number, from_month, from_year))`);
  db.exec(`CREATE TABLE IF NOT EXISTS online_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL UNIQUE, employee_name TEXT NOT NULL DEFAULT '', phone_number TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '', items TEXT NOT NULL DEFAULT '[]', total_amount REAL DEFAULT 0, status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS menu_items (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, icon TEXT DEFAULT '🍽️', price REAL DEFAULT 0, available INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now','localtime')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS serial_register (serial_no INTEGER PRIMARY KEY, employee_name TEXT DEFAULT '', phone_number TEXT DEFAULT '', department TEXT DEFAULT '', status TEXT DEFAULT 'Vacant', joining_date TEXT DEFAULT '', leaving_date TEXT DEFAULT '', current_employee TEXT DEFAULT '')`);
  db.exec(`CREATE TABLE IF NOT EXISTS serial_history (id INTEGER PRIMARY KEY AUTOINCREMENT, serial_no INTEGER NOT NULL, employee_name TEXT DEFAULT '', phone_number TEXT DEFAULT '', department TEXT DEFAULT '', joining_date TEXT DEFAULT '', leaving_date TEXT DEFAULT '', status TEXT DEFAULT 'Left Company', closed_at TEXT DEFAULT (datetime('now','localtime')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS complaints (id INTEGER PRIMARY KEY AUTOINCREMENT, employee_name TEXT NOT NULL DEFAULT '', phone_number TEXT NOT NULL DEFAULT '', department TEXT DEFAULT '', category TEXT DEFAULT 'general', subject TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', status TEXT DEFAULT 'open', admin_reply TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime')))`);
  db.exec(`CREATE TABLE IF NOT EXISTS booking_settings (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_open INTEGER DEFAULT 1, start_time TEXT DEFAULT '08:00', end_time TEXT DEFAULT '20:00', closed_message TEXT DEFAULT 'Booking is currently closed.', updated_at TEXT DEFAULT (datetime('now','localtime')))`);

  // Seed defaults
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries({ tea: 10, breakfast: 30, lunch: 80, dinner: 80, snacks: 20 })) insertSetting.run(k, v);
  insertSetting.run('password', 0);

  const menuCount = db.prepare('SELECT COUNT(*) as count FROM menu_items').get();
  if (menuCount.count === 0) {
    const insertMenu = db.prepare('INSERT INTO menu_items (name, icon, price, available, sort_order) VALUES (?, ?, ?, ?, ?)');
    insertMenu.run('Tea', '☕', 10, 1, 1);
    insertMenu.run('Breakfast', '🥪', 30, 1, 2);
    insertMenu.run('Lunch', '🍛', 80, 1, 3);
    insertMenu.run('Dinner', '🍲', 80, 1, 4);
    insertMenu.run('Snacks', '🍪', 20, 1, 5);
  }

  const serialCount = db.prepare('SELECT COUNT(*) as count FROM serial_register').get();
  if (serialCount.count === 0) {
    const insertSerial = db.prepare('INSERT OR IGNORE INTO serial_register (serial_no, status) VALUES (?, ?)');
    for (let i = 1; i <= 500; i++) insertSerial.run(i, 'Vacant');
  }

  const bookingCount = db.prepare('SELECT COUNT(*) as count FROM booking_settings').get();
  if (bookingCount.count === 0) {
    db.prepare('INSERT INTO booking_settings (id, booking_open, start_time, end_time, closed_message) VALUES (1, 1, ?, ?, ?)').run('08:00', '20:00', 'Booking is currently closed.');
  }
}

// Prices
let PRICES = {};
function loadPrices() { const rows = db.prepare('SELECT key, value FROM settings').all(); PRICES = {}; for (const r of rows) PRICES[r.key] = r.value; }

function getMonthName(m) { return ['','January','February','March','April','May','June','July','August','September','October','November','December'][m] || ''; }

function calcMonthBill(empNo, month, year) {
  const entries = db.prepare('SELECT COALESCE(SUM(daily_total), 0) as total FROM entries WHERE employee_number = ? AND entry_month = ? AND entry_year = ?').get(empNo, month, year);
  const carryRow = db.prepare('SELECT COALESCE(SUM(pending_amount), 0) as total FROM pending_carry WHERE employee_number = ? AND carried_to_month = ? AND carried_to_year = ?').get(empNo, month, year);
  return { current_month_bill: entries.total, carry_forward: carryRow.total, total_bill: entries.total + carryRow.total };
}

function processCarryForward(empNo, fromMonth, fromYear, toMonth, toYear) {
  const bill = calcMonthBill(empNo, fromMonth, fromYear);
  const paid = db.prepare('SELECT COALESCE(SUM(amount_paid), 0) as total FROM payments WHERE employee_number = ? AND month = ? AND year = ?').get(empNo, fromMonth, fromYear);
  const pending = bill.total_bill - paid.total;
  if (pending > 0) {
    const existing = db.prepare('SELECT id FROM pending_carry WHERE employee_number = ? AND from_month = ? AND from_year = ?').get(empNo, fromMonth, fromYear);
    if (existing) db.prepare('UPDATE pending_carry SET pending_amount = ?, carried_to_month = ?, carried_to_year = ? WHERE id = ?').run(pending, toMonth, toYear, existing.id);
    else db.prepare('INSERT INTO pending_carry (employee_number, from_month, from_year, pending_amount, carried_to_month, carried_to_year) VALUES (?, ?, ?, ?, ?, ?)').run(empNo, fromMonth, fromYear, pending, toMonth, toYear);
  }
}

// SSE
let sseClients = [];
function sendSSE(event, data) { const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; sseClients = sseClients.filter(c => { try { c.res.write(payload); return true; } catch(e) { return false; } }); }

// ═══════════════════════════════════════════════════════════════════
//  API ROUTES (same as server.js)
// ═══════════════════════════════════════════════════════════════════

app.get('/api/today', (_req, res) => {
  const now = new Date();
  const day = String(now.getDate()).padStart(2,'0'); const month = String(now.getMonth()+1).padStart(2,'0'); const year = now.getFullYear();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  res.json({ date: `${day} ${months[now.getMonth()]} ${year}`, iso: `${year}-${month}-${day}`, month: now.getMonth()+1, year });
});

app.get('/api/prices', (_req, res) => { loadPrices(); res.json({ tea: PRICES.tea, breakfast: PRICES.breakfast, lunch: PRICES.lunch, dinner: PRICES.dinner, snacks: PRICES.snacks }); });

app.post('/api/prices', (req, res) => {
  const { prices } = req.body; if (!prices) return res.status(400).json({ error: 'Invalid' });
  const updateStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(prices)) { if (['tea','breakfast','lunch','dinner','snacks'].includes(k)) updateStmt.run(k, parseFloat(v)||0); }
  loadPrices(); res.json({ success: true });
});

app.get('/api/password', (_req, res) => { const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('password'); res.json({ password: row ? String(row.value) : '0' }); });
app.post('/api/password', (req, res) => { const { password } = req.body; if (password === undefined) return res.status(400).json({ error: 'Required' }); db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('password', password); res.json({ success: true }); });
app.post('/api/password/verify', (req, res) => { const { password } = req.body; const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('password'); const storedPw = row ? String(row.value) : '0'; if (String(password) === storedPw) res.json({ valid: true }); else res.status(401).json({ valid: false }); });

app.get('/api/employees/:empNo', (req, res) => { const empNo = parseInt(req.params.empNo,10); if (!empNo||empNo<1||empNo>300) return res.status(400).json({error:'Invalid'}); const row = db.prepare('SELECT * FROM employees WHERE employee_number = ?').get(empNo); res.json(row || { employee_number: empNo, name: '' }); });
app.get('/api/employees', (_req, res) => { res.json(db.prepare('SELECT * FROM employees ORDER BY employee_number ASC').all()); });

app.get('/api/entry/:empNo', (req, res) => {
  const empNo = parseInt(req.params.empNo,10); if (!empNo||empNo<1||empNo>300) return res.status(400).json({error:'Invalid'});
  const now = new Date(); const day = String(now.getDate()).padStart(2,'0'); const month = String(now.getMonth()+1).padStart(2,'0'); const year = now.getFullYear();
  const todayISO = `${year}-${month}-${day}`;
  const row = db.prepare('SELECT * FROM entries WHERE employee_number = ? AND entry_date = ?').get(empNo, todayISO);
  if (row) return res.json(row);
  res.json({ employee_number: empNo, entry_date: todayISO, entry_month: now.getMonth()+1, entry_year: year, tea_qty:0, breakfast_qty:0, lunch_qty:0, dinner_qty:0, snacks_qty:0, other_description:'', other_amount:0, daily_total:0 });
});

app.get('/api/entry/:empNo/:date', (req, res) => {
  const empNo = parseInt(req.params.empNo,10); const date = req.params.date;
  if (!empNo||empNo<1||empNo>300) return res.status(400).json({error:'Invalid'});
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({error:'Invalid date'});
  const row = db.prepare('SELECT * FROM entries WHERE employee_number = ? AND entry_date = ?').get(empNo, date);
  if (row) return res.json(row);
  const parts = date.split('-');
  res.json({ employee_number: empNo, entry_date: date, entry_month: parseInt(parts[1],10), entry_year: parseInt(parts[0],10), tea_qty:0, breakfast_qty:0, lunch_qty:0, dinner_qty:0, snacks_qty:0, other_description:'', other_amount:0, daily_total:0 });
});

app.post('/api/entry', (req, res) => {
  const { employee_number, entry_date, tea_qty, breakfast_qty, lunch_qty, dinner_qty, snacks_qty, other_description, other_amount } = req.body;
  if (!employee_number || employee_number < 1 || employee_number > 300) return res.status(400).json({error:'Invalid'});
  let entryDate, currentMonth, currentYear;
  if (entry_date && /^\d{4}-\d{2}-\d{2}$/.test(entry_date)) { entryDate = entry_date; const p = entry_date.split('-'); currentMonth = parseInt(p[1],10); currentYear = parseInt(p[0],10); }
  else { const now = new Date(); entryDate = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; currentMonth = now.getMonth()+1; currentYear = now.getFullYear(); }
  const tQ=parseInt(tea_qty)||0, bQ=parseInt(breakfast_qty)||0, lQ=parseInt(lunch_qty)||0, dQ=parseInt(dinner_qty)||0, sQ=parseInt(snacks_qty)||0, oAmt=parseFloat(other_amount)||0;
  const dailyTotal = tQ*PRICES.tea + bQ*PRICES.breakfast + lQ*PRICES.lunch + dQ*PRICES.dinner + sQ*PRICES.snacks + oAmt;
  db.prepare(`INSERT INTO entries (employee_number, entry_date, entry_month, entry_year, tea_qty, breakfast_qty, lunch_qty, dinner_qty, snacks_qty, other_description, other_amount, daily_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(employee_number, entry_date) DO UPDATE SET tea_qty=excluded.tea_qty, breakfast_qty=excluded.breakfast_qty, lunch_qty=excluded.lunch_qty, dinner_qty=excluded.dinner_qty, snacks_qty=excluded.snacks_qty, other_description=excluded.other_description, other_amount=excluded.other_amount, daily_total=excluded.daily_total`).run(employee_number, entryDate, currentMonth, currentYear, tQ, bQ, lQ, dQ, sQ, other_description||'', oAmt, dailyTotal);
  res.json({ success: true, daily_total: dailyTotal });
});

app.delete('/api/entry/:empNo/:date', (req, res) => {
  const empNo = parseInt(req.params.empNo,10); const date = req.params.date;
  if (!empNo||empNo<1||empNo>300) return res.status(400).json({error:'Invalid'});
  const result = db.prepare('DELETE FROM entries WHERE employee_number = ? AND entry_date = ?').run(empNo, date);
  if (result.changes > 0) res.json({ success: true }); else res.status(404).json({ error: 'Not found' });
});

app.get('/api/history/:empNo', (req, res) => {
  const empNo = parseInt(req.params.empNo,10); if (!empNo||empNo<1||empNo>300) return res.status(400).json({error:'Invalid'});
  const now = new Date(); const cm = now.getMonth()+1, cy = now.getFullYear();
  const monthEntries = db.prepare('SELECT * FROM entries WHERE employee_number = ? AND entry_month = ? AND entry_year = ? ORDER BY entry_date DESC').all(empNo, cm, cy);
  const monthlyTotal = monthEntries.reduce((s,e) => s+e.daily_total, 0);
  const allTimeRow = db.prepare('SELECT COALESCE(SUM(daily_total), 0) as total FROM entries WHERE employee_number = ?').get(empNo);
  res.json({ employee_number: empNo, current_month: cm, current_year: cy, month_entries: monthEntries, monthly_total: monthlyTotal, all_time_total: allTimeRow.total });
});

app.get('/api/records/gross/:year/:month', (req, res) => {
  const year = parseInt(req.params.year,10), month = parseInt(req.params.month,10);
  const entries = db.prepare('SELECT employee_number, SUM(tea_qty) as tea_qty, SUM(breakfast_qty) as breakfast_qty, SUM(lunch_qty) as lunch_qty, SUM(dinner_qty) as dinner_qty, SUM(snacks_qty) as snacks_qty, SUM(other_amount) as other_amount, SUM(daily_total) as total FROM entries WHERE entry_year = ? AND entry_month = ? GROUP BY employee_number ORDER BY employee_number ASC').all(year, month);
  const grandTotal = entries.reduce((s,e) => s+e.total, 0);
  res.json({ year, month, month_name: getMonthName(month), employees: entries, count: entries.length, grand_total: grandTotal });
});

app.get('/api/records/gross/:year', (req, res) => {
  const year = parseInt(req.params.year,10);
  const monthlyData = db.prepare('SELECT entry_month, SUM(daily_total) as total, COUNT(DISTINCT employee_number) as emp_count FROM entries WHERE entry_year = ? GROUP BY entry_month ORDER BY entry_month ASC').all(year);
  const entries = db.prepare('SELECT employee_number, SUM(tea_qty) as tea_qty, SUM(breakfast_qty) as breakfast_qty, SUM(lunch_qty) as lunch_qty, SUM(dinner_qty) as dinner_qty, SUM(snacks_qty) as snacks_qty, SUM(other_amount) as other_amount, SUM(daily_total) as total FROM entries WHERE entry_year = ? GROUP BY employee_number ORDER BY employee_number ASC').all(year);
  const grandTotal = entries.reduce((s,e) => s+e.total, 0);
  res.json({ year, monthly_data: monthlyData, employees: entries, count: entries.length, grand_total: grandTotal });
});

app.get('/api/records/:empNo/:year', (req, res) => {
  const empNo = parseInt(req.params.empNo,10), year = parseInt(req.params.year,10);
  if (!empNo||empNo<1||empNo>300) return res.status(400).json({error:'Invalid'});
  const monthlyData = db.prepare('SELECT entry_month, SUM(tea_qty) as tea_qty, SUM(breakfast_qty) as breakfast_qty, SUM(lunch_qty) as lunch_qty, SUM(dinner_qty) as dinner_qty, SUM(snacks_qty) as snacks_qty, SUM(other_amount) as other_amount, SUM(daily_total) as total FROM entries WHERE employee_number = ? AND entry_year = ? GROUP BY entry_month ORDER BY entry_month ASC').all(empNo, year);
  const yearlyTotal = monthlyData.reduce((s,e) => s+e.total, 0);
  const h1 = monthlyData.filter(e=>e.entry_month>=1&&e.entry_month<=6).reduce((s,e)=>s+e.total,0);
  const h2 = monthlyData.filter(e=>e.entry_month>=7&&e.entry_month<=12).reduce((s,e)=>s+e.total,0);
  res.json({ employee_number: empNo, year, monthly_data: monthlyData, yearly_total: yearlyTotal, h1_total: h1, h2_total: h2 });
});

app.get('/api/payments/:empNo/:year/:month', (req, res) => {
  const empNo = parseInt(req.params.empNo,10), year = parseInt(req.params.year,10), month = parseInt(req.params.month,10);
  if (!empNo||empNo<1||empNo>300) return res.status(400).json({error:'Invalid'});
  if (month > 1) processCarryForward(empNo, month-1, year, month, year);
  else if (year > 2020) processCarryForward(empNo, 12, year-1, 1, year);
  const bill = calcMonthBill(empNo, month, year);
  const paymentRow = db.prepare('SELECT * FROM payments WHERE employee_number = ? AND month = ? AND year = ?').get(empNo, month, year);
  const amountPaid = paymentRow ? paymentRow.amount_paid : 0;
  const status = paymentRow ? paymentRow.status : 'unpaid';
  const pending = Math.max(0, bill.total_bill - amountPaid);
  const empRow = db.prepare('SELECT name FROM employees WHERE employee_number = ?').get(empNo);
  const paymentHistory = db.prepare('SELECT * FROM payments WHERE employee_number = ? ORDER BY year DESC, month DESC LIMIT 12').all(empNo);
  res.json({ employee_number: empNo, employee_name: empRow?empRow.name:'', month, year, month_name: getMonthName(month), current_month_bill: bill.current_month_bill, carry_forward: bill.carry_forward, total_bill: bill.total_bill, amount_paid: amountPaid, status, pending_amount: pending, payment_history: paymentHistory });
});

app.post('/api/payments', (req, res) => {
  const { employee_number, month, year, amount_paid, status, note } = req.body;
  if (!employee_number||employee_number<1||employee_number>300) return res.status(400).json({error:'Invalid'});
  if (!month||!year) return res.status(400).json({error:'Month/year required'});
  db.prepare('INSERT INTO payments (employee_number, month, year, amount_paid, status, note) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(employee_number, month, year) DO UPDATE SET amount_paid=excluded.amount_paid, status=excluded.status, note=excluded.note').run(employee_number, month, year, parseFloat(amount_paid)||0, status||'unpaid', note||'');
  const nextMonth = month===12?1:month+1; const nextYear = month===12?year+1:year;
  processCarryForward(employee_number, month, year, nextMonth, nextYear);
  res.json({ success: true });
});

app.get('/api/payments/pending/all/:year', (req, res) => {
  const year = parseInt(req.params.year,10); if (!year) return res.status(400).json({error:'Year required'});
  const now = new Date(); const currentMonth = now.getMonth()+1; const maxMonth = (year === now.getFullYear()) ? currentMonth : 12;
  const allEmps = db.prepare('SELECT DISTINCT employee_number FROM entries ORDER BY employee_number ASC').all();
  const results = [];
  for (const emp of allEmps) {
    const empNo = emp.employee_number; let totalBill = 0, totalPaid = 0;
    for (let m = 1; m <= maxMonth; m++) {
      if (m > 1) processCarryForward(empNo, m-1, year, m, year);
      else if (year > 2020) processCarryForward(empNo, 12, year-1, 1, year);
      totalBill += calcMonthBill(empNo, m, year).total_bill;
      const payRow = db.prepare('SELECT COALESCE(SUM(amount_paid), 0) as total FROM payments WHERE employee_number = ? AND month = ? AND year = ?').get(empNo, m, year);
      totalPaid += payRow.total;
    }
    const pending = Math.max(0, totalBill - totalPaid);
    if (pending > 0 || totalBill > 0) {
      const empRow = db.prepare('SELECT name FROM employees WHERE employee_number = ?').get(empNo);
      results.push({ employee_number: empNo, employee_name: empRow?empRow.name:'', total_bill: totalBill, total_paid: totalPaid, total_pending: pending });
    }
  }
  const grandTotalPending = results.reduce((s,r) => s+r.total_pending, 0);
  res.json({ year, employees: results, count: results.length, grand_total_pending: grandTotalPending });
});

app.get('/api/employees/:empNo', (req, res) => { const empNo = parseInt(req.params.empNo,10); if (!empNo||empNo<1||empNo>300) return res.status(400).json({error:'Invalid'}); const row = db.prepare('SELECT * FROM employees WHERE employee_number = ?').get(empNo); res.json(row || { employee_number: empNo, name: '' }); });

// MENU APIs
app.get('/api/menu', (_req, res) => { try { res.json(db.prepare('SELECT * FROM menu_items ORDER BY sort_order ASC, id ASC').all()); } catch(e) { res.status(500).json({error:e.message}); } });
app.get('/api/menu/available', (_req, res) => { try { res.json(db.prepare('SELECT * FROM menu_items WHERE available = 1 ORDER BY sort_order ASC, id ASC').all()); } catch(e) { res.status(500).json({error:e.message}); } });
app.post('/api/menu', (req, res) => { const { name, icon, price, available } = req.body; if (!name) return res.status(400).json({error:'Name required'}); const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM menu_items').get(); const r = db.prepare('INSERT INTO menu_items (name, icon, price, available, sort_order) VALUES (?, ?, ?, ?, ?)').run(name.trim(), icon||'🍽️', parseFloat(price)||0, available!==undefined?(available?1:0):1, (maxOrder.m||0)+1); res.json({ success: true, item: db.prepare('SELECT * FROM menu_items WHERE id = ?').get(r.lastInsertRowid) }); });
app.put('/api/menu/:id', (req, res) => { const { id } = req.params; const { name, icon, price, available, sort_order } = req.body; const existing = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id); if (!existing) return res.status(404).json({error:'Not found'}); db.prepare('UPDATE menu_items SET name=?, icon=?, price=?, available=?, sort_order=? WHERE id=?').run(name?name.trim():existing.name, icon||existing.icon, price!==undefined?parseFloat(price):existing.price, available!==undefined?(available?1:0):existing.available, sort_order!==undefined?parseInt(sort_order):existing.sort_order, id); res.json({ success: true, item: db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id) }); });
app.delete('/api/menu/:id', (req, res) => { const result = db.prepare('DELETE FROM menu_items WHERE id = ?').run(req.params.id); if (result.changes===0) return res.status(404).json({error:'Not found'}); res.json({ success: true }); });

// ONLINE ORDERS
app.get('/api/orders/stream', (req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }); res.write('event: connected\ndata: {"msg":"connected"}\n\n'); const client = { id: Date.now(), res }; sseClients.push(client); req.on('close', () => { sseClients = sseClients.filter(c => c.id !== client.id); }); });

app.post('/api/orders', (req, res) => {
  const { employeeName, phoneNumber, department, items, totalAmount } = req.body;
  if (!employeeName || !items || items.length === 0) return res.status(400).json({ error: 'Missing fields' });
  const now = new Date(); const orderId = `ORD-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(Math.floor(Math.random()*9000)+1000)}`;
  const createdAt = now.toISOString().replace('T',' ').substring(0,19);
  db.prepare('INSERT INTO online_orders (order_id, employee_name, phone_number, department, items, total_amount, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, "pending", ?, ?)').run(orderId, employeeName, phoneNumber||'', department||'', JSON.stringify(items), totalAmount||0, createdAt, createdAt);
  const newOrder = db.prepare('SELECT * FROM online_orders WHERE order_id = ?').get(orderId); newOrder.items = JSON.parse(newOrder.items);
  sendSSE('new-order', newOrder); res.json({ success: true, order: newOrder });
});

app.get('/api/orders', (req, res) => { const { date, status } = req.query; let query = 'SELECT * FROM online_orders'; let params = []; let conditions = []; if (date) { conditions.push('DATE(created_at) = ?'); params.push(date); } if (status && status !== 'all') { conditions.push('status = ?'); params.push(status); } if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND '); query += ' ORDER BY created_at DESC'; const orders = db.prepare(query).all(...params); orders.forEach(o => { o.items = JSON.parse(o.items); }); res.json(orders); });

app.put('/api/orders/:id/status', (req, res) => { const { id } = req.params; const { status } = req.body; const valid = ['pending','accepted','preparing','ready','completed','cancelled']; if (!valid.includes(status)) return res.status(400).json({error:'Invalid'}); const now = new Date().toISOString().replace('T',' ').substring(0,19); db.prepare('UPDATE online_orders SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id); const order = db.prepare('SELECT * FROM online_orders WHERE id = ?').get(id); if (!order) return res.status(404).json({error:'Not found'}); order.items = JSON.parse(order.items); sendSSE('status-update', order); res.json({ success: true, order }); });

app.get('/api/orders/stats', (req, res) => { const date = req.query.date || new Date().toISOString().substring(0,10); const total = db.prepare('SELECT COUNT(*) as c FROM online_orders WHERE DATE(created_at) = ?').get(date); const pending = db.prepare("SELECT COUNT(*) as c FROM online_orders WHERE DATE(created_at) = ? AND status = 'pending'").get(date); const preparing = db.prepare("SELECT COUNT(*) as c FROM online_orders WHERE DATE(created_at) = ? AND status = 'preparing'").get(date); const ready = db.prepare("SELECT COUNT(*) as c FROM online_orders WHERE DATE(created_at) = ? AND status = 'ready'").get(date); res.json({ date, total: total.c, pending: pending.c, preparing: preparing.c, ready: ready.c }); });

// BOOKING & COMPLAINTS
app.get('/complaints', (_req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'complaints.html')); });
app.get('/api/complaints', (req, res) => { const { status, category } = req.query; let query = 'SELECT * FROM complaints'; let params = []; let conditions = []; if (status && status !== 'all') { conditions.push('status = ?'); params.push(status); } if (category && category !== 'all') { conditions.push('category = ?'); params.push(category); } if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND '); query += ' ORDER BY created_at DESC'; try { res.json(db.prepare(query).all(...params)); } catch(err) { res.status(500).json({error:err.message}); } });
app.post('/api/complaints', (req, res) => { const { employee_name, phone_number, department, category, subject, description } = req.body; if (!subject||!description) return res.status(400).json({error:'Required'}); try { const now = new Date().toISOString().replace('T',' ').substring(0,19); const r = db.prepare("INSERT INTO complaints (employee_name, phone_number, department, category, subject, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)").run(employee_name||'', phone_number||'', department||'', category||'general', subject, description, now, now); res.json({ success: true, complaint: db.prepare('SELECT * FROM complaints WHERE id = ?').get(r.lastInsertRowid) }); } catch(err) { res.status(500).json({error:err.message}); } });
app.put('/api/complaints/:id', (req, res) => { const { id } = req.params; const { status, admin_reply } = req.body; try { const existing = db.prepare('SELECT * FROM complaints WHERE id = ?').get(id); if (!existing) return res.status(404).json({error:'Not found'}); const now = new Date().toISOString().replace('T',' ').substring(0,19); db.prepare('UPDATE complaints SET status = ?, admin_reply = ?, updated_at = ? WHERE id = ?').run(status||existing.status, admin_reply!==undefined?admin_reply:existing.admin_reply, now, id); res.json({ success: true, complaint: db.prepare('SELECT * FROM complaints WHERE id = ?').get(id) }); } catch(err) { res.status(500).json({error:err.message}); } });
app.get('/api/booking-settings', (_req, res) => { try { res.json(db.prepare('SELECT * FROM booking_settings WHERE id = 1').get() || {}); } catch(err) { res.status(500).json({error:err.message}); } });
app.post('/api/booking-settings', (req, res) => { const { booking_open, start_time, end_time, closed_message } = req.body; try { const now = new Date().toISOString().replace('T',' ').substring(0,19); db.prepare('UPDATE booking_settings SET booking_open = ?, start_time = ?, end_time = ?, closed_message = ?, updated_at = ? WHERE id = 1').run(booking_open?1:0, start_time||'08:00', end_time||'20:00', closed_message||'', now); res.json({ success: true, settings: db.prepare('SELECT * FROM booking_settings WHERE id = 1').get() }); } catch(err) { res.status(500).json({error:err.message}); } });
app.get('/api/booking-open', (_req, res) => { try { const row = db.prepare('SELECT * FROM booking_settings WHERE id = 1').get(); if (!row||!row.booking_open) return res.json({open:false, message:row?row.closed_message:'Closed'}); const now = new Date(); const cur = now.getHours()*60+now.getMinutes(); const [sh,sm] = row.start_time.split(':').map(Number); const [eh,em] = row.end_time.split(':').map(Number); if (cur>=sh*60+sm&&cur<eh*60+em) res.json({open:true, start_time:row.start_time, end_time:row.end_time}); else res.json({open:false, message:row.closed_message||'Closed'}); } catch(err) { res.status(500).json({error:err.message}); } });

// SERIAL REGISTER
app.get('/api/serial-register', (req, res) => { const page = parseInt(req.query.page)||1; const limit = parseInt(req.query.limit)||25; const search = req.query.search||''; const statusFilter = req.query.status||''; const offset = (page-1)*limit; let query = 'SELECT * FROM serial_register'; let countQuery = 'SELECT COUNT(*) as total FROM serial_register'; let conditions = []; let params = []; if (search) { conditions.push('(serial_no LIKE ? OR employee_name LIKE ? OR phone_number LIKE ? OR department LIKE ?)'); const s = `%${search}%`; params.push(s,s,s,s); } if (statusFilter && statusFilter !== 'all') { conditions.push('status = ?'); params.push(statusFilter); } if (conditions.length > 0) { const where = ' WHERE ' + conditions.join(' AND '); query += where; countQuery += where; } const total = db.prepare(countQuery).get(...params).total; query += ' ORDER BY serial_no ASC LIMIT ? OFFSET ?'; params.push(limit, offset); const rows = db.prepare(query).all(...params); res.json({ data: rows, total, page, limit, totalPages: Math.ceil(total/limit) }); });
app.get('/api/serial-register/stats/all', (_req, res) => { const total = db.prepare('SELECT COUNT(*) as c FROM serial_register').get().c; const active = db.prepare("SELECT COUNT(*) as c FROM serial_register WHERE status = 'Active'").get().c; const left = db.prepare("SELECT COUNT(*) as c FROM serial_register WHERE status = 'Left Company'").get().c; const vacant = db.prepare("SELECT COUNT(*) as c FROM serial_register WHERE status = 'Vacant'").get().c; res.json({ total, active, left, vacant }); });
app.get('/api/serial-register/:serialNo', (req, res) => { const sn = parseInt(req.params.serialNo,10); if (!sn||sn<1||sn>500) return res.status(400).json({error:'Invalid'}); const row = db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(sn); if (!row) return res.status(404).json({error:'Not found'}); res.json(row); });
app.post('/api/serial-register', (req, res) => { const { serial_no, employee_name, phone_number, department, joining_date } = req.body; const sn = parseInt(serial_no,10); if (!sn||sn<1||sn>500) return res.status(400).json({error:'Invalid'}); if (!employee_name||!employee_name.trim()) return res.status(400).json({error:'Name required'}); const existing = db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(sn); if (!existing) return res.status(404).json({error:'Not found'}); if (existing.current_employee&&existing.current_employee.trim()&&existing.status==='Active') return res.status(400).json({error:'occupied',previousName:existing.current_employee}); const now = new Date().toISOString().replace('T',' ').substring(0,19); const jd = joining_date||new Date().toISOString().substring(0,10); db.prepare("UPDATE serial_register SET employee_name=?, phone_number=?, department=?, status='Active', joining_date=?, leaving_date='', current_employee=? WHERE serial_no=?").run(employee_name.trim(), phone_number||'', department||'', jd, employee_name.trim(), sn); res.json({ success: true, data: db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(sn) }); });
app.post('/api/serial-register/:serialNo/leave', (req, res) => { const sn = parseInt(req.params.serialNo,10); const { leaving_date } = req.body; if (!sn||sn<1||sn>500) return res.status(400).json({error:'Invalid'}); const existing = db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(sn); if (!existing) return res.status(404).json({error:'Not found'}); if (existing.status!=='Active') return res.status(400).json({error:'No active employee'}); const now = new Date().toISOString().replace('T',' ').substring(0,19); const ld = leaving_date||new Date().toISOString().substring(0,10); db.prepare("INSERT INTO serial_history (serial_no, employee_name, phone_number, department, joining_date, leaving_date, status, closed_at) VALUES (?, ?, ?, ?, ?, ?, 'Left Company', ?)").run(sn, existing.employee_name, existing.phone_number||'', existing.department, existing.joining_date, ld, now); db.prepare("UPDATE serial_register SET status='Left Company', leaving_date=?, current_employee='' WHERE serial_no=?").run(ld, sn); res.json({ success: true, data: db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(sn) }); });
app.post('/api/serial-register/:serialNo/new-record', (req, res) => { const sn = parseInt(req.params.serialNo,10); const { employee_name, phone_number, department, joining_date } = req.body; if (!sn||sn<1||sn>500) return res.status(400).json({error:'Invalid'}); if (!employee_name||!employee_name.trim()) return res.status(400).json({error:'Name required'}); const existing = db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(sn); if (!existing) return res.status(404).json({error:'Not found'}); const now = new Date().toISOString().replace('T',' ').substring(0,19); const jd = joining_date||new Date().toISOString().substring(0,10); if (existing.status==='Active'&&existing.current_employee&&existing.current_employee.trim()) { db.prepare("INSERT INTO serial_history (serial_no, employee_name, phone_number, department, joining_date, leaving_date, status, closed_at) VALUES (?, ?, ?, ?, ?, ?, 'Left Company', ?)").run(sn, existing.employee_name, existing.phone_number||'', existing.department, existing.joining_date, jd, now); } db.prepare("UPDATE serial_register SET employee_name=?, phone_number=?, department=?, status='Active', joining_date=?, leaving_date='', current_employee=? WHERE serial_no=?").run(employee_name.trim(), phone_number||'', department||'', jd, employee_name.trim(), sn); res.json({ success: true, data: db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(sn) }); });
app.get('/api/serial-register/:serialNo/history', (req, res) => { const sn = parseInt(req.params.serialNo,10); if (!sn||sn<1||sn>500) return res.status(400).json({error:'Invalid'}); res.json(db.prepare('SELECT * FROM serial_history WHERE serial_no = ? ORDER BY closed_at DESC').all(sn)); });
app.put('/api/serial-register/:serialNo', (req, res) => { const sn = parseInt(req.params.serialNo,10); const { employee_name, phone_number, department } = req.body; if (!sn||sn<1||sn>500) return res.status(400).json({error:'Invalid'}); const existing = db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(sn); if (!existing) return res.status(404).json({error:'Not found'}); db.prepare('UPDATE serial_register SET employee_name=?, phone_number=?, department=?, current_employee=? WHERE serial_no=?').run(employee_name!==undefined?employee_name.trim():existing.employee_name, phone_number!==undefined?phone_number:(existing.phone_number||''), department!==undefined?department:existing.department, employee_name!==undefined?employee_name.trim():existing.current_employee, sn); res.json({ success: true, data: db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(sn) }); });

// SERVE PAGES
app.get('/', (_req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'entry.html')); });
app.get('/payment', (_req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'payment.html')); });
app.get('/records', (_req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'records.html')); });
app.get('/records/:empNo', (_req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'emp-records.html')); });
app.get('/settings', (_req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'settings.html')); });
app.get('/pending', (_req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'pending.html')); });
app.get('/online-orders', (_req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'online-orders.html')); });
app.get('/user-ordering', (_req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'user-ordering.html')); });
app.get('/serial-register', (_req, res) => { res.sendFile(path.join(__dirname, '..', 'public', 'serial-register.html')); });

// Initialize DB and start server
const handler = async (req, res) => {
  if (!db) await initDB();
  app(req, res);
};

// For local dev
if (require.main === module) {
  initDB().then(() => {
    loadPrices();
    app.listen(PORT, '0.0.0.0', () => console.log(`Server running on http://localhost:${PORT}`));
  });
}

module.exports = handler;

const express = require('express');
const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const multer = require('multer');
const path = require('path');
const app = express();
const PORT = 3456;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer for Excel uploads (stored in memory)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Local time helper (avoids UTC timezone mismatch)
function nowStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

// ─── DATABASE SETUP ───────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'canteen.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_number INTEGER NOT NULL,
    entry_date TEXT NOT NULL,
    entry_month INTEGER NOT NULL,
    entry_year INTEGER NOT NULL,
    tea_qty INTEGER DEFAULT 0,
    breakfast_qty INTEGER DEFAULT 0,
    lunch_qty INTEGER DEFAULT 0,
    dinner_qty INTEGER DEFAULT 0,
    snacks_qty INTEGER DEFAULT 0,
    other_description TEXT DEFAULT '',
    other_amount REAL DEFAULT 0,
    daily_total REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(employee_number, entry_date)
  );
`);

// ─── CONFIGURABLE PRICES ──────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value REAL NOT NULL
  );
`);

// Seed default prices if not present
const defaultPrices = { tea: 10, breakfast: 30, lunch: 80, dinner: 80, snacks: 20 };
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(defaultPrices)) {
  insertSetting.run(k, v);
}

// Seed default password if not present
insertSetting.run('password', 988388); // password = 988388

// ─── EMPLOYEES TABLE (for name lookup from Excel) ────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    employee_number INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT ''
  );
`);

// ─── PAYMENTS TABLE ───────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_number INTEGER NOT NULL,
    month INTEGER NOT NULL,
    year INTEGER NOT NULL,
    amount_paid REAL DEFAULT 0,
    status TEXT DEFAULT 'unpaid',
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(employee_number, month, year)
  );
`);

// ─── PENDING CARRY-FORWARD TABLE ──────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS pending_carry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_number INTEGER NOT NULL,
    from_month INTEGER NOT NULL,
    from_year INTEGER NOT NULL,
    pending_amount REAL DEFAULT 0,
    carried_to_month INTEGER NOT NULL,
    carried_to_year INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(employee_number, from_month, from_year)
  );
`);

// ─── ONLINE ORDERS TABLE ────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS online_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL UNIQUE,
    employee_name TEXT NOT NULL DEFAULT '',
    phone_number TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    items TEXT NOT NULL DEFAULT '[]',
    total_amount REAL DEFAULT 0,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// Add phone_number column if missing (migration)
try { db.exec('ALTER TABLE online_orders ADD COLUMN phone_number TEXT DEFAULT ""'); } catch(e) {}
try { db.exec('ALTER TABLE online_orders ADD COLUMN employee_id TEXT DEFAULT ""'); } catch(e) {}

// ─── COMPLAINTS / REPORTS TABLE ──────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS complaints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_name TEXT NOT NULL DEFAULT '',
    phone_number TEXT NOT NULL DEFAULT '',
    department TEXT DEFAULT '',
    category TEXT DEFAULT 'general',
    subject TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT DEFAULT 'open',
    admin_reply TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// ─── BOOKING SETTINGS TABLE ──────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS booking_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_open INTEGER DEFAULT 1,
    start_time TEXT DEFAULT '08:00',
    end_time TEXT DEFAULT '20:00',
    closed_message TEXT DEFAULT 'Booking is currently closed. Please try again during operating hours.',
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// Seed default booking settings if empty
const bookingCount = db.prepare('SELECT COUNT(*) as count FROM booking_settings').get();
if (bookingCount.count === 0) {
  db.prepare('INSERT INTO booking_settings (id, booking_open, start_time, end_time, closed_message) VALUES (1, 1, ?, ?, ?)').run('08:00', '20:00', 'Booking is currently closed. Please try again during operating hours.');
}

// ─── MENU ITEMS TABLE (for online ordering) ──────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '🍽️',
    price REAL DEFAULT 0,
    available INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// Seed default menu items if empty
const menuCount = db.prepare('SELECT COUNT(*) as count FROM menu_items').get();
if (menuCount.count === 0) {
  const insertMenu = db.prepare('INSERT INTO menu_items (name, icon, price, available, sort_order) VALUES (?, ?, ?, ?, ?)');
  const seedTx = db.transaction(() => {
    insertMenu.run('Tea', '☕', 10, 1, 1);
    insertMenu.run('Breakfast', '🥪', 30, 1, 2);
    insertMenu.run('Lunch', '🍛', 80, 1, 3);
    insertMenu.run('Dinner', '🍲', 80, 1, 4);
    insertMenu.run('Snacks', '🍪', 20, 1, 5);
  });
  seedTx();
}

// ─── SSE: Real-time event system ────────────────────────────────
let sseClients = [];

function sendSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(client => {
    try {
      client.res.write(payload);
      return true;
    } catch (e) {
      return false;
    }
  });
}

// Load prices from DB
let PRICES = {};
function loadPrices() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  PRICES = {};
  for (const r of rows) PRICES[r.key] = r.value;
}
loadPrices();

// ─── Helper: calculate daily total ────────────────────────────────
function calcTotal(entry) {
  return (
    (entry.tea_qty || 0) * PRICES.tea +
    (entry.breakfast_qty || 0) * PRICES.breakfast +
    (entry.lunch_qty || 0) * PRICES.lunch +
    (entry.dinner_qty || 0) * PRICES.dinner +
    (entry.snacks_qty || 0) * PRICES.snacks +
    (entry.other_amount || 0)
  );
}

function getMonthName(m) {
  const months = ['','January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  return months[m] || '';
}

// ─── Helper: Calculate bill for a month including carry-forward ───
function calcMonthBill(empNo, month, year) {
  // Current month entries
  const entries = db.prepare(
    'SELECT COALESCE(SUM(daily_total), 0) as total FROM entries WHERE employee_number = ? AND entry_month = ? AND entry_year = ?'
  ).get(empNo, month, year);
  const currentBill = entries.total;

  // Pending from previous months (carry-forward)
  const carryRow = db.prepare(
    'SELECT COALESCE(SUM(pending_amount), 0) as total FROM pending_carry WHERE employee_number = ? AND carried_to_month = ? AND carried_to_year = ?'
  ).get(empNo, month, year);
  const carryForward = carryRow.total;

  return {
    current_month_bill: currentBill,
    carry_forward: carryForward,
    total_bill: currentBill + carryForward
  };
}

// ─── Helper: Process carry-forward for new month ──────────────────
function processCarryForward(empNo, fromMonth, fromYear, toMonth, toYear) {
  const bill = calcMonthBill(empNo, fromMonth, fromYear);
  const paid = db.prepare(
    'SELECT COALESCE(SUM(amount_paid), 0) as total FROM payments WHERE employee_number = ? AND month = ? AND year = ?'
  ).get(empNo, fromMonth, fromYear);
  const pending = bill.total_bill - paid.total;

  if (pending > 0) {
    // Check if carry-forward already exists for this source month
    const existing = db.prepare(
      'SELECT id FROM pending_carry WHERE employee_number = ? AND from_month = ? AND from_year = ?'
    ).get(empNo, fromMonth, fromYear);

    if (existing) {
      db.prepare('UPDATE pending_carry SET pending_amount = ?, carried_to_month = ?, carried_to_year = ? WHERE id = ?')
        .run(pending, toMonth, toYear, existing.id);
    } else {
      db.prepare(
        'INSERT INTO pending_carry (employee_number, from_month, from_year, pending_amount, carried_to_month, carried_to_year) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(empNo, fromMonth, fromYear, pending, toMonth, toYear);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════════

// ─── API: Get today's date info ───────────────────────────────────
app.get('/api/today', (_req, res) => {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const months = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December',
  ];
  res.json({
    date: `${day} ${months[now.getMonth()]} ${year}`,
    iso: `${year}-${month}-${day}`,
    month: now.getMonth() + 1,
    year,
  });
});

// ─── API: Get item prices ─────────────────────────────────────────
app.get('/api/prices', (_req, res) => {
  loadPrices();
  res.json({ tea: PRICES.tea, breakfast: PRICES.breakfast, lunch: PRICES.lunch, dinner: PRICES.dinner, snacks: PRICES.snacks });
});

// ─── API: Update prices ──────────────────────────────────────────
app.post('/api/prices', (req, res) => {
  const { prices } = req.body;
  if (!prices || typeof prices !== 'object') {
    return res.status(400).json({ error: 'Invalid prices object' });
  }

  const updateStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(prices)) {
      if (['tea','breakfast','lunch','dinner','snacks'].includes(k)) {
        updateStmt.run(k, parseFloat(v) || 0);
      }
    }
  });
  tx();

  loadPrices();
  res.json({ success: true, prices: { tea: PRICES.tea, breakfast: PRICES.breakfast, lunch: PRICES.lunch, dinner: PRICES.dinner, snacks: PRICES.snacks } });
});

// ─── API: Get / Update password ───────────────────────────────────
app.get('/api/password', (_req, res) => {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('password');
  res.json({ password: row ? String(row.value) : '0' });
});

app.post('/api/password', (req, res) => {
  const { password } = req.body;
  if (password === undefined || password === null) {
    return res.status(400).json({ error: 'Password required' });
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('password', password);
  res.json({ success: true, message: 'Password updated. All pages now use the new password.' });
});

app.post('/api/password/verify', (req, res) => {
  const { password } = req.body;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('password');
  const storedPw = row ? String(row.value) : '0';
  if (String(password) === storedPw) {
    res.json({ valid: true });
  } else {
    res.status(401).json({ valid: false, error: 'Incorrect password' });
  }
});

// ─── API: Employee names ──────────────────────────────────────────
app.get('/api/employees/:empNo', (req, res) => {
  const empNo = parseInt(req.params.empNo, 10);
  if (!empNo || empNo < 1 || empNo > 1000) {
    return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  }
  const row = db.prepare('SELECT * FROM employees WHERE employee_number = ?').get(empNo);
  if (row) {
    res.json(row);
  } else {
    res.json({ employee_number: empNo, name: '' });
  }
});

app.get('/api/employees', (_req, res) => {
  const rows = db.prepare('SELECT * FROM employees ORDER BY employee_number ASC').all();
  res.json(rows);
});

// ─── API: Upload Excel for employee names ─────────────────────────
app.post('/api/employees/upload', upload.single('excelFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);

    let count = 0;
    const insertEmp = db.prepare(
      'INSERT INTO employees (employee_number, name) VALUES (?, ?) ON CONFLICT(employee_number) DO UPDATE SET name = excluded.name'
    );

    const tx = db.transaction(() => {
      for (const row of data) {
        // Try common column names: empNo/emp_no/employee_number/number + name/employee_name
        const empNo = row.empNo || row.emp_no || row.employee_number || row.number || row.Number || row['Emp No'] || row['Employee No'] || row['Employee Number'];
        const name = row.name || row.Name || row.employee_name || row['Employee Name'] || row['Name'] || '';
        if (empNo) {
          const parsed = parseInt(empNo, 10);
          if (parsed >= 1 && parsed <= 300) {
            insertEmp.run(parsed, String(name).trim());
            count++;
          }
        }
      }
    });
    tx();

    res.json({ success: true, message: `Uploaded ${count} employee(s) from Excel.`, count });
  } catch (err) {
    res.status(500).json({ error: 'Failed to parse Excel file: ' + err.message });
  }
});

// ─── API: Get or create today's entry for employee ────────────────
app.get('/api/entry/:empNo', (req, res) => {
  const empNo = parseInt(req.params.empNo, 10);
  if (!empNo || empNo < 1 || empNo > 1000) {
    return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  }

  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const todayISO = `${year}-${month}-${day}`;
  const currentMonth = now.getMonth() + 1;

  const row = db.prepare(
    'SELECT * FROM entries WHERE employee_number = ? AND entry_date = ?'
  ).get(empNo, todayISO);

  if (row) {
    return res.json(row);
  }

  res.json({
    employee_number: empNo,
    entry_date: todayISO,
    entry_month: currentMonth,
    entry_year: year,
    tea_qty: 0,
    breakfast_qty: 0,
    lunch_qty: 0,
    dinner_qty: 0,
    snacks_qty: 0,
    other_description: '',
    other_amount: 0,
    daily_total: 0,
  });
});

// ─── API: Get entry by date (for editing past entries) ────────────
app.get('/api/entry/:empNo/:date', (req, res) => {
  const empNo = parseInt(req.params.empNo, 10);
  const date = req.params.date; // YYYY-MM-DD
  if (!empNo || empNo < 1 || empNo > 1000) {
    return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format (YYYY-MM-DD)' });
  }

  const row = db.prepare(
    'SELECT * FROM entries WHERE employee_number = ? AND entry_date = ?'
  ).get(empNo, date);

  if (row) {
    return res.json(row);
  }

  const parts = date.split('-');
  res.json({
    employee_number: empNo,
    entry_date: date,
    entry_month: parseInt(parts[1], 10),
    entry_year: parseInt(parts[0], 10),
    tea_qty: 0,
    breakfast_qty: 0,
    lunch_qty: 0,
    dinner_qty: 0,
    snacks_qty: 0,
    other_description: '',
    other_amount: 0,
    daily_total: 0,
  });
});

// ─── API: Save / Update today's entry ─────────────────────────────
app.post('/api/entry', (req, res) => {
  const {
    employee_number,
    entry_date,
    tea_qty,
    breakfast_qty,
    lunch_qty,
    dinner_qty,
    snacks_qty,
    other_description,
    other_amount,
  } = req.body;

  if (!employee_number || employee_number < 1 || employee_number > 1000) {
    return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  }

  let entryDate, currentMonth, currentYear;
  if (entry_date && /^\d{4}-\d{2}-\d{2}$/.test(entry_date)) {
    entryDate = entry_date;
    const parts = entry_date.split('-');
    currentMonth = parseInt(parts[1], 10);
    currentYear = parseInt(parts[0], 10);
  } else {
    const now = new Date();
    const day = String(now.getDate()).padStart(2, '0');
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const year = now.getFullYear();
    entryDate = `${year}-${month}-${day}`;
    currentMonth = now.getMonth() + 1;
    currentYear = year;
  }

  const tQ = parseInt(tea_qty) || 0;
  const bQ = parseInt(breakfast_qty) || 0;
  const lQ = parseInt(lunch_qty) || 0;
  const dQ = parseInt(dinner_qty) || 0;
  const sQ = parseInt(snacks_qty) || 0;
  const oAmt = parseFloat(other_amount) || 0;

  const dailyTotal =
    tQ * PRICES.tea +
    bQ * PRICES.breakfast +
    lQ * PRICES.lunch +
    dQ * PRICES.dinner +
    sQ * PRICES.snacks +
    oAmt;

  const stmt = db.prepare(`
    INSERT INTO entries
      (employee_number, entry_date, entry_month, entry_year,
       tea_qty, breakfast_qty, lunch_qty, dinner_qty, snacks_qty,
       other_description, other_amount, daily_total)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(employee_number, entry_date) DO UPDATE SET
      tea_qty         = excluded.tea_qty,
      breakfast_qty   = excluded.breakfast_qty,
      lunch_qty       = excluded.lunch_qty,
      dinner_qty      = excluded.dinner_qty,
      snacks_qty      = excluded.snacks_qty,
      other_description = excluded.other_description,
      other_amount    = excluded.other_amount,
      daily_total     = excluded.daily_total
  `);

  stmt.run(
    employee_number, entryDate, currentMonth, currentYear,
    tQ, bQ, lQ, dQ, sQ,
    other_description || '', oAmt, dailyTotal
  );

  res.json({ success: true, daily_total: dailyTotal });
});

// ─── API: Delete entry ────────────────────────────────────────────
app.delete('/api/entry/:empNo/:date', (req, res) => {
  const empNo = parseInt(req.params.empNo, 10);
  const date = req.params.date;
  if (!empNo || empNo < 1 || empNo > 1000) {
    return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Invalid date format' });
  }

  const result = db.prepare(
    'DELETE FROM entries WHERE employee_number = ? AND entry_date = ?'
  ).run(empNo, date);

  if (result.changes > 0) {
    res.json({ success: true, message: 'Entry deleted' });
  } else {
    res.status(404).json({ error: 'Entry not found' });
  }
});

// ─── API: Get employee history (monthly, half-yearly, yearly) ─────
app.get('/api/history/:empNo', (req, res) => {
  const empNo = parseInt(req.params.empNo, 10);
  if (!empNo || empNo < 1 || empNo > 1000) {
    return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  }

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  const monthEntries = db.prepare(
    `SELECT * FROM entries WHERE employee_number = ? AND entry_month = ? AND entry_year = ? ORDER BY entry_date DESC`
  ).all(empNo, currentMonth, currentYear);

  const monthlyTotal = monthEntries.reduce((sum, e) => sum + e.daily_total, 0);

  const allTimeRow = db.prepare(
    'SELECT COALESCE(SUM(daily_total), 0) as total FROM entries WHERE employee_number = ?'
  ).get(empNo);

  res.json({
    employee_number: empNo,
    current_month: currentMonth,
    current_year: currentYear,
    month_entries: monthEntries,
    monthly_total: monthlyTotal,
    all_time_total: allTimeRow.total,
  });
});

// ─── API: History with period filter ──────────────────────────────
app.get('/api/history/:empNo/:period/:year/:month', (req, res) => {
  const empNo = parseInt(req.params.empNo, 10);
  const period = req.params.period;
  const year = parseInt(req.params.year, 10);
  const month = parseInt(req.params.month, 10) || null;

  if (!empNo || empNo < 1 || empNo > 1000) {
    return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  }

  let query, params, startDate, endDate, label;

  if (period === 'monthly') {
    query = `SELECT * FROM entries WHERE employee_number = ? AND entry_year = ? AND entry_month = ? ORDER BY entry_date ASC`;
    params = [empNo, year, month];
    startDate = `${year}-${String(month).padStart(2,'0')}-01`;
    endDate = `${year}-${String(month).padStart(2,'0')}-31`;
    label = `${getMonthName(month)} ${year}`;
  } else if (period === 'half-yearly') {
    const half = month || 1;
    const startM = half === 1 ? 1 : 7;
    const endM = half === 1 ? 6 : 12;
    query = `SELECT * FROM entries WHERE employee_number = ? AND entry_year = ? AND entry_month >= ? AND entry_month <= ? ORDER BY entry_date ASC`;
    params = [empNo, year, startM, endM];
    startDate = `${year}-${String(startM).padStart(2,'0')}-01`;
    endDate = `${year}-${String(endM).padStart(2,'0')}-31`;
    label = `H${half} ${year}`;
  } else if (period === 'yearly') {
    query = `SELECT * FROM entries WHERE employee_number = ? AND entry_year = ? ORDER BY entry_date ASC`;
    params = [empNo, year];
    startDate = `${year}-01-01`;
    endDate = `${year}-12-31`;
    label = `${year}`;
  } else {
    return res.status(400).json({ error: 'Invalid period' });
  }

  const entries = db.prepare(query).all(...params);
  const total = entries.reduce((sum, e) => sum + e.daily_total, 0);

  const breakdown = {
    tea: entries.reduce((s, e) => s + e.tea_qty, 0),
    breakfast: entries.reduce((s, e) => s + e.breakfast_qty, 0),
    lunch: entries.reduce((s, e) => s + e.lunch_qty, 0),
    dinner: entries.reduce((s, e) => s + e.dinner_qty, 0),
    snacks: entries.reduce((s, e) => s + e.snacks_qty, 0),
    other_total: entries.reduce((s, e) => s + e.other_amount, 0),
  };

  res.json({
    employee_number: empNo,
    period, year, month, label,
    entries, total, breakdown,
    item_totals: {
      tea: breakdown.tea * PRICES.tea,
      breakfast: breakdown.breakfast * PRICES.breakfast,
      lunch: breakdown.lunch * PRICES.lunch,
      dinner: breakdown.dinner * PRICES.dinner,
      snacks: breakdown.snacks * PRICES.snacks,
    },
  });
});

// ─── API: All employees gross records (monthly) ───────────────────
app.get('/api/records/gross/:year/:month', (req, res) => {
  const year = parseInt(req.params.year, 10);
  const month = parseInt(req.params.month, 10);

  const entries = db.prepare(
    `SELECT employee_number,
            SUM(tea_qty) as tea_qty,
            SUM(breakfast_qty) as breakfast_qty,
            SUM(lunch_qty) as lunch_qty,
            SUM(dinner_qty) as dinner_qty,
            SUM(snacks_qty) as snacks_qty,
            SUM(other_amount) as other_amount,
            SUM(daily_total) as total
     FROM entries
     WHERE entry_year = ? AND entry_month = ?
     GROUP BY employee_number
     ORDER BY employee_number ASC`
  ).all(year, month);

  const grandTotal = entries.reduce((sum, e) => sum + e.total, 0);

  res.json({ year, month, month_name: getMonthName(month), employees: entries, count: entries.length, grand_total: grandTotal });
});

// ─── API: All employees yearly gross ──────────────────────────────
app.get('/api/records/gross/:year', (req, res) => {
  const year = parseInt(req.params.year, 10);

  const monthlyData = db.prepare(
    `SELECT entry_month, SUM(daily_total) as total, COUNT(DISTINCT employee_number) as emp_count FROM entries WHERE entry_year = ? GROUP BY entry_month ORDER BY entry_month ASC`
  ).all(year);

  const entries = db.prepare(
    `SELECT employee_number, SUM(tea_qty) as tea_qty, SUM(breakfast_qty) as breakfast_qty, SUM(lunch_qty) as lunch_qty, SUM(dinner_qty) as dinner_qty, SUM(snacks_qty) as snacks_qty, SUM(other_amount) as other_amount, SUM(daily_total) as total FROM entries WHERE entry_year = ? GROUP BY employee_number ORDER BY employee_number ASC`
  ).all(year);

  const grandTotal = entries.reduce((sum, e) => sum + e.total, 0);

  res.json({ year, monthly_data: monthlyData, employees: entries, count: entries.length, grand_total: grandTotal });
});

// ─── API: Individual employee breakdown ───────────────────────────
app.get('/api/records/:empNo/:year', (req, res) => {
  const empNo = parseInt(req.params.empNo, 10);
  const year = parseInt(req.params.year, 10);
  if (!empNo || empNo < 1 || empNo > 1000) {
    return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  }

  const monthlyData = db.prepare(
    `SELECT entry_month, SUM(tea_qty) as tea_qty, SUM(breakfast_qty) as breakfast_qty, SUM(lunch_qty) as lunch_qty, SUM(dinner_qty) as dinner_qty, SUM(snacks_qty) as snacks_qty, SUM(other_amount) as other_amount, SUM(daily_total) as total FROM entries WHERE employee_number = ? AND entry_year = ? GROUP BY entry_month ORDER BY entry_month ASC`
  ).all(empNo, year);

  const yearlyTotal = monthlyData.reduce((sum, e) => sum + e.total, 0);
  const h1Total = monthlyData.filter(e => e.entry_month >= 1 && e.entry_month <= 6).reduce((sum, e) => sum + e.total, 0);
  const h2Total = monthlyData.filter(e => e.entry_month >= 7 && e.entry_month <= 12).reduce((sum, e) => sum + e.total, 0);

  res.json({ employee_number: empNo, year, monthly_data: monthlyData, yearly_total: yearlyTotal, h1_total: h1Total, h2_total: h2Total });
});

// ═══════════════════════════════════════════════════════════════════
//  PAYMENT APIs
// ═══════════════════════════════════════════════════════════════════

// ─── API: Get payment status for an employee (specific month) ─────
app.get('/api/payments/:empNo/:year/:month', (req, res) => {
  const empNo = parseInt(req.params.empNo, 10);
  const year = parseInt(req.params.year, 10);
  const month = parseInt(req.params.month, 10);

  if (!empNo || empNo < 1 || empNo > 1000) {
    return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  }

  // Process carry-forward from previous month
  if (month > 1) {
    processCarryForward(empNo, month - 1, year, month, year);
  } else {
    // January -> check December of previous year
    processCarryForward(empNo, 12, year - 1, month, year);
  }

  const bill = calcMonthBill(empNo, month, year);

  const paymentRow = db.prepare(
    'SELECT * FROM payments WHERE employee_number = ? AND month = ? AND year = ?'
  ).get(empNo, month, year);

  const amountPaid = paymentRow ? paymentRow.amount_paid : 0;
  const status = paymentRow ? paymentRow.status : 'unpaid';
  const note = paymentRow ? paymentRow.note : '';
  const pending = Math.max(0, bill.total_bill - amountPaid);

  // Employee name
  const empRow = db.prepare('SELECT name FROM employees WHERE employee_number = ?').get(empNo);
  const empName = empRow ? empRow.name : '';

  // Payment history for this employee
  const paymentHistory = db.prepare(
    'SELECT * FROM payments WHERE employee_number = ? ORDER BY year DESC, month DESC LIMIT 12'
  ).all(empNo);

  res.json({
    employee_number: empNo,
    employee_name: empName,
    month, year,
    month_name: getMonthName(month),
    current_month_bill: bill.current_month_bill,
    carry_forward: bill.carry_forward,
    total_bill: bill.total_bill,
    amount_paid: amountPaid,
    status, // 'paid', 'unpaid', 'partial'
    note,
    pending_amount: pending,
    payment_history: paymentHistory,
  });
});

// ─── API: Record a payment ────────────────────────────────────────
app.post('/api/payments', (req, res) => {
  const { employee_number, month, year, amount_paid, status, note } = req.body;

  if (!employee_number || employee_number < 1 || employee_number > 1000) {
    return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  }
  if (!month || !year) {
    return res.status(400).json({ error: 'Month and year required' });
  }

  const stmt = db.prepare(`
    INSERT INTO payments (employee_number, month, year, amount_paid, status, note)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(employee_number, month, year) DO UPDATE SET
      amount_paid = excluded.amount_paid,
      status = excluded.status,
      note = excluded.note
  `);

  stmt.run(employee_number, month, year, parseFloat(amount_paid) || 0, status || 'unpaid', note || '');

  // After payment, process carry-forward to next month
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  processCarryForward(employee_number, month, year, nextMonth, nextYear);

  res.json({ success: true, message: 'Payment recorded' });
});

// ─── API: Get all pending amounts across all employees ────────────
app.get('/api/payments/pending/all', (_req, res) => {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();

  // Get all employees who have any entries
  const allEmps = db.prepare(
    'SELECT DISTINCT employee_number FROM entries ORDER BY employee_number ASC'
  ).all();

  const results = [];

  for (const emp of allEmps) {
    const empNo = emp.employee_number;
    let totalBillAllMonths = 0;
    let totalPaidAllMonths = 0;

    // Check each month of current year that has passed
    for (let m = 1; m <= currentMonth; m++) {
      // Process carry-forward
      if (m > 1) {
        processCarryForward(empNo, m - 1, currentYear, m, currentYear);
      }
      const bill = calcMonthBill(empNo, m, currentYear);
      totalBillAllMonths += bill.total_bill;

      const payRow = db.prepare(
        'SELECT COALESCE(SUM(amount_paid), 0) as total FROM payments WHERE employee_number = ? AND month = ? AND year = ?'
      ).get(empNo, m, currentYear);
      totalPaidAllMonths += payRow.total;
    }

    // Also check carry-forward from previous year's December
    const prevCarry = db.prepare(
      'SELECT COALESCE(SUM(pending_amount), 0) as total FROM pending_carry WHERE employee_number = ? AND carried_to_year = ?'
    ).get(empNo, currentYear);

    const totalPending = Math.max(0, totalBillAllMonths + (prevCarry ? prevCarry.total : 0) - totalPaidAllMonths);

    // Also get pending from previous years that haven't been resolved
    const olderPending = db.prepare(
      'SELECT COALESCE(SUM(pending_amount), 0) as total FROM pending_carry WHERE employee_number = ? AND carried_to_year < ?'
    ).get(empNo, currentYear);

    const grandPending = totalPending + (olderPending ? olderPending.total : 0);

    if (grandPending > 0 || totalBillAllMonths > 0) {
      const empRow = db.prepare('SELECT name FROM employees WHERE employee_number = ?').get(empNo);
      results.push({
        employee_number: empNo,
        employee_name: empRow ? empRow.name : '',
        total_bill: totalBillAllMonths,
        total_paid: totalPaidAllMonths,
        total_pending: grandPending,
      });
    }
  }

  const grandTotalPending = results.reduce((sum, r) => sum + r.total_pending, 0);

  res.json({
    month: currentMonth,
    year: currentYear,
    month_name: getMonthName(currentMonth),
    employees: results,
    count: results.length,
    grand_total_pending: grandTotalPending,
  });
});

// ─── API: Get all pending for specific year ───────────────────────
app.get('/api/payments/pending/all/:year', (req, res) => {
  const year = parseInt(req.params.year, 10);
  if (!year) return res.status(400).json({ error: 'Year required' });

  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  const maxMonth = (year === currentYear) ? currentMonth : 12;

  const allEmps = db.prepare(
    'SELECT DISTINCT employee_number FROM entries ORDER BY employee_number ASC'
  ).all();

  const results = [];

  for (const emp of allEmps) {
    const empNo = emp.employee_number;
    let totalBill = 0;
    let totalPaid = 0;

    for (let m = 1; m <= maxMonth; m++) {
      // Process carry-forward for each month
      if (m > 1) {
        processCarryForward(empNo, m - 1, year, m, year);
      } else if (year > 2020) {
        // January: check Dec of previous year
        processCarryForward(empNo, 12, year - 1, 1, year);
      }

      const bill = calcMonthBill(empNo, m, year);
      totalBill += bill.total_bill;

      const payRow = db.prepare(
        'SELECT COALESCE(SUM(amount_paid), 0) as total FROM payments WHERE employee_number = ? AND month = ? AND year = ?'
      ).get(empNo, m, year);
      totalPaid += payRow.total;
    }

    const pending = Math.max(0, totalBill - totalPaid);
    if (pending > 0 || totalBill > 0) {
      const empRow = db.prepare('SELECT name FROM employees WHERE employee_number = ?').get(empNo);
      results.push({
        employee_number: empNo,
        employee_name: empRow ? empRow.name : '',
        total_bill: totalBill,
        total_paid: totalPaid,
        total_pending: pending,
      });
    }
  }

  const grandTotalPending = results.reduce((sum, r) => sum + r.total_pending, 0);

  res.json({
    year,
    employees: results,
    count: results.length,
    grand_total_pending: grandTotalPending,
  });
});

// ─── API: Excel export for individual employee ────────────────────
app.get('/api/export/:empNo', (req, res) => {
  const empNo = parseInt(req.params.empNo, 10);
  const period = req.query.period || 'monthly';
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);
  const half = parseInt(req.query.half, 10) || 1;

  if (!empNo || empNo < 1 || empNo > 1000) {
    return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  }

  let query, params, title;

  if (period === 'monthly') {
    query = `SELECT * FROM entries WHERE employee_number = ? AND entry_year = ? AND entry_month = ? ORDER BY entry_date ASC`;
    params = [empNo, year, month];
    title = `Employee ${empNo} - ${getMonthName(month)} ${year}`;
  } else if (period === 'half-yearly') {
    const startM = half === 1 ? 1 : 7;
    const endM = half === 1 ? 6 : 12;
    query = `SELECT * FROM entries WHERE employee_number = ? AND entry_year = ? AND entry_month >= ? AND entry_month <= ? ORDER BY entry_date ASC`;
    params = [empNo, year, startM, endM];
    title = `Employee ${empNo} - H${half} ${year}`;
  } else {
    query = `SELECT * FROM entries WHERE employee_number = ? AND entry_year = ? ORDER BY entry_date ASC`;
    params = [empNo, year];
    title = `Employee ${empNo} - Year ${year}`;
  }

  const entries = db.prepare(query).all(...params);

  const excelData = [];
  excelData.push({ 'Item': title, '': '', '': '', '': '', '': '', '': '', '': '' });
  excelData.push({ 'Item': `Canteen Bill - Employee #${empNo}`, '': '', '': '', '': '', '': '', '': '', '': '' });
  excelData.push({ '': '', '': '', '': '', '': '', '': '', '': '', '': '' });
  excelData.push({
    'Date': 'Date', 'Tea (Qty)': 'Tea (Qty)', 'Breakfast (Qty)': 'Breakfast (Qty)', 'Lunch (Qty)': 'Lunch (Qty)', 'Dinner (Qty)': 'Dinner (Qty)', 'Snacks (Qty)': 'Snacks (Qty)', 'Other Description': 'Other Description', 'Other Amount': 'Other Amount', 'Daily Total': 'Daily Total',
  });

  let grandTotal = 0;
  for (const e of entries) {
    grandTotal += e.daily_total;
    excelData.push({
      'Date': e.entry_date, 'Tea (Qty)': e.tea_qty, 'Breakfast (Qty)': e.breakfast_qty, 'Lunch (Qty)': e.lunch_qty, 'Dinner (Qty)': e.dinner_qty, 'Snacks (Qty)': e.snacks_qty, 'Other Description': e.other_description || '', 'Other Amount': e.other_amount || 0, 'Daily Total': e.daily_total,
    });
  }

  excelData.push({ '': '', '': '', '': '', '': '', '': '', '': '', '': '' });
  excelData.push({ 'Date': 'TOTAL', 'Daily Total': grandTotal });
  excelData.push({ '': '' });
  excelData.push({ 'Date': 'RATE CARD' });
  excelData.push({ 'Date': 'Tea', 'Tea (Qty)': `₹${PRICES.tea}` });
  excelData.push({ 'Date': 'Breakfast', 'Tea (Qty)': `₹${PRICES.breakfast}` });
  excelData.push({ 'Date': 'Lunch', 'Tea (Qty)': `₹${PRICES.lunch}` });
  excelData.push({ 'Date': 'Dinner', 'Tea (Qty)': `₹${PRICES.dinner}` });
  excelData.push({ 'Date': 'Snacks', 'Tea (Qty)': `₹${PRICES.snacks}` });

  const ws = XLSX.utils.json_to_sheet(excelData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Bill');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=Employee_${empNo}_${title.replace(/\s+/g, '_')}.xlsx`);
  res.send(buf);
});

// ─── API: Excel export for gross records ──────────────────────────
app.get('/api/export/gross/:year/:month', (req, res) => {
  const year = parseInt(req.params.year, 10);
  const month = parseInt(req.params.month, 10);

  const entries = db.prepare(
    `SELECT employee_number, SUM(tea_qty) as tea_qty, SUM(breakfast_qty) as breakfast_qty, SUM(lunch_qty) as lunch_qty, SUM(dinner_qty) as dinner_qty, SUM(snacks_qty) as snacks_qty, SUM(other_amount) as other_amount, SUM(daily_total) as total FROM entries WHERE entry_year = ? AND entry_month = ? GROUP BY employee_number ORDER BY employee_number ASC`
  ).all(year, month);

  const grandTotal = entries.reduce((sum, e) => sum + e.total, 0);

  const excelData = [];
  excelData.push({ 'Item': `Gross Canteen Records - ${getMonthName(month)} ${year}` });
  excelData.push({ '': '' });
  excelData.push({ 'Employee No': 'Employee No', 'Tea (Qty)': 'Tea (Qty)', 'Breakfast (Qty)': 'Breakfast (Qty)', 'Lunch (Qty)': 'Lunch (Qty)', 'Dinner (Qty)': 'Dinner (Qty)', 'Snacks (Qty)': 'Snacks (Qty)', 'Other Amount': 'Other Amount', 'Total': 'Total' });

  for (const e of entries) {
    excelData.push({ 'Employee No': e.employee_number, 'Tea (Qty)': e.tea_qty, 'Breakfast (Qty)': e.breakfast_qty, 'Lunch (Qty)': e.lunch_qty, 'Dinner (Qty)': e.dinner_qty, 'Snacks (Qty)': e.snacks_qty, 'Other Amount': e.other_amount, 'Total': e.total });
  }

  excelData.push({ '': '' });
  excelData.push({ 'Employee No': `TOTAL (${entries.length} employees)`, 'Total': grandTotal });

  const ws = XLSX.utils.json_to_sheet(excelData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Gross Records');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=Gross_Records_${getMonthName(month)}_${year}.xlsx`);
  res.send(buf);
});

// ═══════════════════════════════════════════════════════════════════
//  ONLINE ORDERS APIs
// ═══════════════════════════════════════════════════════════════════

// ─── SSE Endpoint (real-time updates) ──────────────────────────
app.get('/api/orders/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('event: connected\ndata: {"msg":"connected"}\n\n');

  const client = { id: Date.now(), res };
  sseClients.push(client);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== client.id);
  });
});

// ─── Create a new order ────────────────────────────────────────
app.post('/api/orders', (req, res) => {
  const { employeeName, phoneNumber, department, items, totalAmount } = req.body;

  if (!employeeName || !items || items.length === 0) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const now = new Date();
  const orderId = `ORD-${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
  const createdAt = nowStr();

  try {
    db.prepare(`
      INSERT INTO online_orders (order_id, employee_name, phone_number, department, items, total_amount, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(orderId, employeeName, phoneNumber || '', department || '', JSON.stringify(items), totalAmount || 0, createdAt, createdAt);

    const newOrder = db.prepare('SELECT * FROM online_orders WHERE order_id = ?').get(orderId);
    newOrder.items = JSON.parse(newOrder.items);

    // Notify all SSE clients
    sendSSE('new-order', newOrder);

    res.json({ success: true, order: newOrder });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get orders (with optional date filter) ────────────────────
app.get('/api/orders', (req, res) => {
  const { date, status } = req.query;
  let query = 'SELECT * FROM online_orders';
  let params = [];
  let conditions = [];

  if (date) {
    conditions.push('DATE(created_at) = ?');
    params.push(date);
  }
  if (status && status !== 'all') {
    conditions.push('status = ?');
    params.push(status);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  query += ' ORDER BY created_at DESC';

  try {
    const orders = db.prepare(query).all(...params);
    orders.forEach(o => { o.items = JSON.parse(o.items); });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update order status ───────────────────────────────────────
app.put('/api/orders/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const validStatuses = ['pending', 'accepted', 'preparing', 'ready', 'completed', 'cancelled'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

  try {
    const result = db.prepare('UPDATE online_orders SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = db.prepare('SELECT * FROM online_orders WHERE id = ?').get(id);
    order.items = JSON.parse(order.items);

    // Notify all SSE clients
    sendSSE('status-update', order);

    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get order stats ──────────────────────────────────────────
app.get('/api/orders/stats', (req, res) => {
  const { date } = req.query;
  const targetDate = date || new Date().toISOString().substring(0, 10);

  try {
    const total = db.prepare('SELECT COUNT(*) as count FROM online_orders WHERE DATE(created_at) = ?').get(targetDate);
    const pending = db.prepare("SELECT COUNT(*) as count FROM online_orders WHERE DATE(created_at) = ? AND status = 'pending'").get(targetDate);
    const accepted = db.prepare("SELECT COUNT(*) as count FROM online_orders WHERE DATE(created_at) = ? AND status = 'accepted'").get(targetDate);
    const preparing = db.prepare("SELECT COUNT(*) as count FROM online_orders WHERE DATE(created_at) = ? AND status = 'preparing'").get(targetDate);
    const ready = db.prepare("SELECT COUNT(*) as count FROM online_orders WHERE DATE(created_at) = ? AND status = 'ready'").get(targetDate);
    const completed = db.prepare("SELECT COUNT(*) as count FROM online_orders WHERE DATE(created_at) = ? AND status = 'completed'").get(targetDate);

    res.json({
      date: targetDate,
      total: total.count,
      pending: pending.count,
      accepted: accepted.count,
      preparing: preparing.count,
      ready: ready.count,
      completed: completed.count
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  MENU ITEMS APIs
// ═══════════════════════════════════════════════════════════════════

// ─── Get all menu items ──────────────────────────────────────
app.get('/api/menu', (_req, res) => {
  try {
    const items = db.prepare('SELECT * FROM menu_items ORDER BY sort_order ASC, id ASC').all();
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get only available menu items (for user app) ─────────────
app.get('/api/menu/available', (_req, res) => {
  try {
    const items = db.prepare('SELECT * FROM menu_items WHERE available = 1 ORDER BY sort_order ASC, id ASC').all();
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Add a new menu item ──────────────────────────────────────
app.post('/api/menu', (req, res) => {
  const { name, icon, price, available } = req.body;
  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Item name is required' });
  }
  try {
    const maxOrder = db.prepare('SELECT MAX(sort_order) as max_order FROM menu_items').get();
    const sortOrder = (maxOrder.max_order || 0) + 1;
    const result = db.prepare('INSERT INTO menu_items (name, icon, price, available, sort_order) VALUES (?, ?, ?, ?, ?)')
      .run(name.trim(), icon || '🍽️', parseFloat(price) || 0, available !== undefined ? (available ? 1 : 0) : 1, sortOrder);
    const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, item });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update a menu item ──────────────────────────────────────
app.put('/api/menu/:id', (req, res) => {
  const { id } = req.params;
  const { name, icon, price, available, sort_order } = req.body;
  try {
    const existing = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Item not found' });

    db.prepare('UPDATE menu_items SET name = ?, icon = ?, price = ?, available = ?, sort_order = ? WHERE id = ?')
      .run(
        name !== undefined ? name.trim() : existing.name,
        icon !== undefined ? icon : existing.icon,
        price !== undefined ? parseFloat(price) : existing.price,
        available !== undefined ? (available ? 1 : 0) : existing.available,
        sort_order !== undefined ? parseInt(sort_order) : existing.sort_order,
        id
      );
    const updated = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
    res.json({ success: true, item: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete a menu item ──────────────────────────────────────
app.delete('/api/menu/:id', (req, res) => {
  const { id } = req.params;
  try {
    const result = db.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ success: true, message: 'Item deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════
//  EMPLOYEE SERIAL REGISTER
// ═══════════════════════════════════════════════════════════════════

// Create tables
// Master serial register: 500 permanent serial numbers
db.exec(`
  CREATE TABLE IF NOT EXISTS serial_register (
    serial_no INTEGER PRIMARY KEY,
    employee_name TEXT DEFAULT '',
    phone_number TEXT DEFAULT '',
    department TEXT DEFAULT '',
    status TEXT DEFAULT 'Vacant',
    joining_date TEXT DEFAULT '',
    leaving_date TEXT DEFAULT '',
    current_employee TEXT DEFAULT ''
  );
`);

// Migration: add phone_number if missing, drop old employee_id
try { db.exec('ALTER TABLE serial_register ADD COLUMN phone_number TEXT DEFAULT ""'); } catch(e) {}
try {
  // Copy employee_id to phone_number if phone_number is empty
  db.exec("UPDATE serial_register SET phone_number = employee_id WHERE phone_number = '' AND employee_id != ''");
} catch(e) {}

// Employee history for each serial number
db.exec(`
  CREATE TABLE IF NOT EXISTS serial_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_no INTEGER NOT NULL,
    employee_name TEXT DEFAULT '',
    phone_number TEXT DEFAULT '',
    department TEXT DEFAULT '',
    joining_date TEXT DEFAULT '',
    leaving_date TEXT DEFAULT '',
    status TEXT DEFAULT 'Left Company',
    closed_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

// Migration: add phone_number to serial_history if missing
try { db.exec('ALTER TABLE serial_history ADD COLUMN phone_number TEXT DEFAULT ""'); } catch(e) {}
try { db.exec("UPDATE serial_history SET phone_number = employee_id WHERE phone_number = '' AND employee_id != ''"); } catch(e) {}

// Seed 500 serial numbers if not present
const serialCount = db.prepare('SELECT COUNT(*) as count FROM serial_register').get();
if (serialCount.count === 0) {
  const insertSerial = db.prepare('INSERT OR IGNORE INTO serial_register (serial_no, status) VALUES (?, ?)');
  const seedTx = db.transaction(() => {
    for (let i = 1; i <= 1000; i++) {
      insertSerial.run(i, 'Vacant');
    }
  });
  seedTx();
}

// ─── API: Get all serial registers (paginated, searchable) ───
app.get('/api/serial-register', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 25;
  const search = req.query.search || '';
  const statusFilter = req.query.status || '';
  const offset = (page - 1) * limit;

  let query = 'SELECT * FROM serial_register';
  let countQuery = 'SELECT COUNT(*) as total FROM serial_register';
  let conditions = [];
  let params = [];

  if (search) {
    conditions.push('(serial_no LIKE ? OR employee_name LIKE ? OR employee_id LIKE ? OR department LIKE ?)');
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }
  if (statusFilter && statusFilter !== 'all') {
    conditions.push('status = ?');
    params.push(statusFilter);
  }

  if (conditions.length > 0) {
    const where = ' WHERE ' + conditions.join(' AND ');
    query += where;
    countQuery += where;
  }

  const total = db.prepare(countQuery).get(...params).total;
  query += ' ORDER BY serial_no ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows = db.prepare(query).all(...params);
  res.json({
    data: rows,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit)
  });
});

// ─── API: Serial register stats ─────────────────────────────
app.get('/api/serial-register/stats/all', (_req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM serial_register').get().count;
  const active = db.prepare("SELECT COUNT(*) as count FROM serial_register WHERE status = 'Active'").get().count;
  const left = db.prepare("SELECT COUNT(*) as count FROM serial_register WHERE status = 'Left Company'").get().count;
  const vacant = db.prepare("SELECT COUNT(*) as count FROM serial_register WHERE status = 'Vacant'").get().count;

  res.json({ total, active, left, vacant });
});

// ─── API: Get single serial register entry ──────────────────
app.get('/api/serial-register/:serialNo', (req, res) => {
  const serialNo = parseInt(req.params.serialNo, 10);
  if (!serialNo || serialNo < 1 || serialNo > 1000) {
    return res.status(400).json({ error: 'Invalid serial number (1-500)' });
  }
  const row = db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(serialNo);
  if (!row) return res.status(404).json({ error: 'Serial number not found' });
  res.json(row);
});

// ─── API: Assign employee to serial number ──────────────────
app.post('/api/serial-register', (req, res) => {
  const { serial_no, employee_name, phone_number, department, joining_date } = req.body;
  const serialNo = parseInt(serial_no, 10);

  if (!serialNo || serialNo < 1 || serialNo > 1000) {
    return res.status(400).json({ error: 'Invalid serial number (1-500)' });
  }
  if (!employee_name || employee_name.trim() === '') {
    return res.status(400).json({ error: 'Employee name is required' });
  }

  const existing = db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(serialNo);
  if (!existing) return res.status(404).json({ error: 'Serial number not found' });

  // Check if there's an active employee already
  if (existing.current_employee && existing.current_employee.trim() !== '' && existing.status === 'Active') {
    return res.status(400).json({
      error: 'occupied',
      previousName: existing.current_employee,
      message: `This serial number is currently assigned to ${existing.current_employee}. Close the existing record first.`
    });
  }

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const jDate = joining_date || new Date().toISOString().substring(0, 10);

  db.prepare(`
    UPDATE serial_register
    SET employee_name = ?, phone_number = ?, department = ?, status = 'Active',
        joining_date = ?, leaving_date = '', current_employee = ?
    WHERE serial_no = ?
  `).run(employee_name.trim(), phone_number || '', department || '', jDate, employee_name.trim(), serialNo);

  const updated = db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(serialNo);
  res.json({ success: true, data: updated });
});

// ─── API: Mark employee as left ─────────────────────────────
app.post('/api/serial-register/:serialNo/leave', (req, res) => {
  const serialNo = parseInt(req.params.serialNo, 10);
  const { leaving_date } = req.body;

  if (!serialNo || serialNo < 1 || serialNo > 1000) {
    return res.status(400).json({ error: 'Invalid serial number (1-500)' });
  }

  const existing = db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(serialNo);
  if (!existing) return res.status(404).json({ error: 'Serial number not found' });
  if (existing.status !== 'Active') return res.status(400).json({ error: 'No active employee to mark as left' });

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const lDate = leaving_date || new Date().toISOString().substring(0, 10);

  // Move to history
  db.prepare(`
    INSERT INTO serial_history (serial_no, employee_name, phone_number, department, joining_date, leaving_date, status, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'Left Company', ?)
  `).run(serialNo, existing.employee_name, existing.phone_number || '', existing.department, existing.joining_date, lDate, now);

  // Clear current record
  db.prepare(`
    UPDATE serial_register
    SET status = 'Left Company', leaving_date = ?, employee_name = ?, phone_number = ?, department = ?, current_employee = ''
    WHERE serial_no = ?
  `).run(lDate, existing.employee_name, existing.phone_number || '', existing.department, serialNo);

  const updated = db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(serialNo);
  res.json({ success: true, data: updated });
});

// ─── API: Start new record for existing serial (reassign) ────
app.post('/api/serial-register/:serialNo/new-record', (req, res) => {
  const serialNo = parseInt(req.params.serialNo, 10);
  const { employee_name, phone_number, department, joining_date } = req.body;

  if (!serialNo || serialNo < 1 || serialNo > 1000) {
    return res.status(400).json({ error: 'Invalid serial number (1-500)' });
  }
  if (!employee_name || employee_name.trim() === '') {
    return res.status(400).json({ error: 'Employee name is required' });
  }

  const existing = db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(serialNo);
  if (!existing) return res.status(404).json({ error: 'Serial number not found' });

  const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
  const jDate = joining_date || new Date().toISOString().substring(0, 10);

  // If there's an active employee, move them to history first
  if (existing.status === 'Active' && existing.current_employee && existing.current_employee.trim() !== '') {
    db.prepare(`
      INSERT INTO serial_history (serial_no, employee_name, phone_number, department, joining_date, leaving_date, status, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'Left Company', ?)
    `).run(serialNo, existing.employee_name, existing.phone_number || '', existing.department, existing.joining_date, jDate, now);
  }

  // Start new record
  db.prepare(`
    UPDATE serial_register
    SET employee_name = ?, phone_number = ?, department = ?, status = 'Active',
        joining_date = ?, leaving_date = '', current_employee = ?
    WHERE serial_no = ?
  `).run(employee_name.trim(), phone_number || '', department || '', jDate, employee_name.trim(), serialNo);

  const updated = db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(serialNo);
  res.json({ success: true, data: updated });
});

// ─── API: Get history for a serial number ────────────────────
app.get('/api/serial-register/:serialNo/history', (req, res) => {
  const serialNo = parseInt(req.params.serialNo, 10);
  if (!serialNo || serialNo < 1 || serialNo > 1000) {
    return res.status(400).json({ error: 'Invalid serial number (1-500)' });
  }

  const history = db.prepare('SELECT * FROM serial_history WHERE serial_no = ? ORDER BY closed_at DESC').all(serialNo);
  res.json(history);
});

// ─── API: Update serial register entry ───────────────────────
app.put('/api/serial-register/:serialNo', (req, res) => {
  const serialNo = parseInt(req.params.serialNo, 10);
  const { employee_name, phone_number, department } = req.body;

  if (!serialNo || serialNo < 1 || serialNo > 1000) {
    return res.status(400).json({ error: 'Invalid serial number (1-500)' });
  }

  const existing = db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(serialNo);
  if (!existing) return res.status(404).json({ error: 'Serial number not found' });

  db.prepare(`
    UPDATE serial_register
    SET employee_name = ?, phone_number = ?, department = ?, current_employee = ?
    WHERE serial_no = ?
  `).run(
    employee_name !== undefined ? employee_name.trim() : existing.employee_name,
    phone_number !== undefined ? phone_number : existing.phone_number || '',
    department !== undefined ? department : existing.department,
    employee_name !== undefined ? employee_name.trim() : existing.current_employee,
    serialNo
  );

  const updated = db.prepare('SELECT * FROM serial_register WHERE serial_no = ?').get(serialNo);
  res.json({ success: true, data: updated });
});

// ═══════════════════════════════════════════════════════════════════
//  SERVE PAGES
// ═══════════════════════════════════════════════════════════════════
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'entry.html'));
});

app.get('/payment', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});

app.get('/records', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'records.html'));
});

app.get('/records/:empNo', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'emp-records.html'));
});

app.get('/settings', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.get('/pending', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pending.html'));
});

app.get('/online-orders', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'online-orders.html'));
});

app.get('/user-ordering', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'user-ordering.html'));
});

// ─── Serve serial register page ─────────────────────────────
app.get('/serial-register', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'serial-register.html'));
});

// ═══════════════════════════════════════════════════════════════════
//  Start ────────────────────────────────────────────────────────


// ─── Complaints page ───────────────────────────────────────
app.get('/complaints', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'complaints.html'));
});

app.get('/feedback', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'feedback.html'));
});

app.get('/developer', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'developer.html'));
});

// ─── Complaints APIs ───────────────────────────────────────
app.get('/api/complaints', (req, res) => {
  const { status, category } = req.query;
  let query = 'SELECT * FROM complaints';
  let params = [];
  let conditions = [];
  if (status && status !== 'all') { conditions.push('status = ?'); params.push(status); }
  if (category && category !== 'all') { conditions.push('category = ?'); params.push(category); }
  if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY created_at DESC';
  try { res.json(db.prepare(query).all(...params)); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/complaints', (req, res) => {
  const { employee_name, phone_number, department, category, subject, description } = req.body;
  if (!subject || !description) return res.status(400).json({ error: 'Subject and description required' });
  try {
    const now = nowStr();
    const r = db.prepare("INSERT INTO complaints (employee_name, phone_number, department, category, subject, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)").run(employee_name || '', phone_number || '', department || '', category || 'general', subject, description, now, now);
    res.json({ success: true, complaint: db.prepare('SELECT * FROM complaints WHERE id = ?').get(r.lastInsertRowid) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/complaints/:id', (req, res) => {
  const { id } = req.params;
  const { status, admin_reply } = req.body;
  try {
    const existing = db.prepare('SELECT * FROM complaints WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const now = nowStr();
    db.prepare('UPDATE complaints SET status = ?, admin_reply = ?, updated_at = ? WHERE id = ?').run(status || existing.status, admin_reply !== undefined ? admin_reply : existing.admin_reply, now, id);
    res.json({ success: true, complaint: db.prepare('SELECT * FROM complaints WHERE id = ?').get(id) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Booking Settings APIs ─────────────────────────────────
app.get('/api/booking-settings', (_req, res) => {
  try { res.json(db.prepare('SELECT * FROM booking_settings WHERE id = 1').get() || {}); } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/booking-settings', (req, res) => {
  const { booking_open, start_time, end_time, closed_message } = req.body;
  try {
    const now = nowStr();
    db.prepare('UPDATE booking_settings SET booking_open = ?, start_time = ?, end_time = ?, closed_message = ?, updated_at = ? WHERE id = 1').run(booking_open ? 1 : 0, start_time || '08:00', end_time || '20:00', closed_message || '', now);
    res.json({ success: true, settings: db.prepare('SELECT * FROM booking_settings WHERE id = 1').get() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/booking-open', (_req, res) => {
  try {
    const row = db.prepare('SELECT * FROM booking_settings WHERE id = 1').get();
    if (!row || !row.booking_open) return res.json({ open: false, message: row ? row.closed_message : 'Booking closed' });
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = row.start_time.split(':').map(Number);
    const [eh, em] = row.end_time.split(':').map(Number);
    if (cur >= sh * 60 + sm && cur < eh * 60 + em) res.json({ open: true, start_time: row.start_time, end_time: row.end_time });
    else res.json({ open: false, message: row.closed_message || 'Booking is only open from ' + row.start_time + ' to ' + row.end_time });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIP = iface.address;
        break;
      }
    }
  }
  console.log(`\n  🍽️  Digital Canteen Book is running!\n`);
  console.log(`  📱 Phone access:  http://${localIP}:${PORT}/user-ordering`);
  console.log(`  💻 Computer:      http://localhost:${PORT}`);
  console.log(`  ⚙️  Settings:      http://localhost:${PORT}/settings`);
  console.log(`  📋 Online Orders: http://localhost:${PORT}/online-orders\n`);
});

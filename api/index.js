// ═══════════════════════════════════════════════════════════════════
//  Vercel-compatible server using Firebase Firestore
//  No native modules — pure JavaScript, works on Vercel serverless
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { initializeApp } = require('firebase/app');
const {
  getFirestore, collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, limit, startAfter, enableIndexedDbPersistence
} = require('firebase/firestore');

// ═══════════════════════════════════════════════════════════════════
//  SECURITY IMPORTS
// ═══════════════════════════════════════════════════════════════════
const { initFirebaseAdmin, requireAuth, requirePermission } = require('../security/auth');

// ─── Dual Auth: Password-based fallback for when Firebase Admin is unavailable ──
let cachedPassword = null;
async function verifyAdminPassword(req, res, next) {
  // Check X-Admin-Password header (from auth.js or password modal)
  const pwHeader = req.headers['x-admin-password'];
  if (!pwHeader) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    if (!cachedPassword) {
      const pwDoc = await getDocById(C.settings, 'password');
      cachedPassword = pwDoc ? String(pwDoc.value) : '988388';
    }
    if (String(pwHeader) === String(cachedPassword)) {
      req.user = { uid: 'password-auth', role: 'ADMIN', name: 'Admin', email: '', permissions: [] };
      return next();
    }
    return res.status(401).json({ error: 'Invalid password' });
  } catch (err) {
    return res.status(500).json({ error: 'Auth check failed' });
  }
}

// Combined auth: try Firebase token first, fall back to password
function dualAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const pwHeader = req.headers['x-admin-password'];

  // If Bearer token present, try Firebase Auth
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return requireAuth(req, res, next);
  }

  // If password header present, try password auth
  if (pwHeader) {
    return verifyAdminPassword(req, res, next);
  }

  // No auth at all
  return res.status(401).json({ error: 'Authentication required' });
}
const { orderLimiter, publicReadLimiter, apiLimiter } = require('../security/rateLimit');
const { validateEntry, validateOrder, validateSerialRegister, validatePayment, validateMenu, validateComplaint } = require('../security/validation');
const { initAudit, auditMiddleware, ACTIONS } = require('../security/audit');

const app = express();
const PORT = process.env.PORT || 3456;

// ─── Body size limit (10MB) ──────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// ─── Security Headers ─────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// ─── Initialize Firebase Admin + Audit ─────────────────────────
try {
  initFirebaseAdmin();
  const { getFirestore } = require('firebase-admin/firestore');
  initAudit(getFirestore());
} catch (err) {
  console.error('Security init warning:', err.message);
}

// ─── Audit middleware for all requests ─────────────────────────
app.use(auditMiddleware);

// ═══════════════════════════════════════════════════════════════════
//  FIREBASE CONFIG
// ═══════════════════════════════════════════════════════════════════
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || 'AIzaSyCqiJDd9mijLa3AV3S7JgyLlkkoCODFlJk',
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'canteen-app-bbaf5.firebaseapp.com',
  projectId: process.env.FIREBASE_PROJECT_ID || 'canteen-app-bbaf5',
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'canteen-app-bbaf5.firebasestorage.app',
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '793607116131',
  appId: process.env.FIREBASE_APP_ID || '1:793607116131:web:0097a1db298778fa43af56',
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// ═══════════════════════════════════════════════════════════════════
//  HELPER: Firestore query wrappers (mimic better-sqlite3 API)
// ═══════════════════════════════════════════════════════════════════
const C = {
  entries: 'entries',
  settings: 'settings',
  employees: 'employees',
  payments: 'payments',
  pendingCarry: 'pending_carry',
  onlineOrders: 'online_orders',
  menuItems: 'menu_items',
  serialRegister: 'serial_register',
  serialHistory: 'serial_history',
  complaints: 'complaints',
  bookingSettings: 'booking_settings',
  subscription: 'subscription',
  paymentHistory: 'payment_history',
  users: 'users',
};

// Get all docs - NO orderBy in Firestore (avoids composite index issues)
async function getAll(collName, filters = [], orderField = null, orderAsc = true, limitN = null) {
  let q = collection(db, collName);
  const constraints = [];
  for (const f of filters) {
    if (f.op && f.value !== undefined && f.value !== null && f.value !== 'all') {
      constraints.push(where(f.field, f.op, f.value));
    }
  }
  if (constraints.length > 0) q = query(q, ...constraints);
  const snap = await getDocs(q);
  let results = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (orderField) results.sort((a, b) => {
    const av = a[orderField] || 0, bv = b[orderField] || 0;
    return orderAsc ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1);
  });
  if (limitN) results = results.slice(0, limitN);
  return results;
}

// Get a single doc by ID
async function getDocById(collName, docId) {
  const snap = await getDoc(doc(db, collName, String(docId)));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

// Set a doc (create or overwrite)
async function setDocData(collName, docId, data) {
  await setDoc(doc(db, collName, String(docId)), data, { merge: true });
}

// Add a new doc with auto-ID
async function addDocData(collName, data) {
  const ref = await addDoc(collection(db, collName), data);
  return ref.id;
}

// Update a doc
async function updateDocData(collName, docId, data) {
  await updateDoc(doc(db, collName, String(docId)), data);
}

// Delete a doc
async function deleteDocData(collName, docId) {
  await deleteDoc(doc(db, collName, String(docId)));
}

// Sum a field across filtered docs
async function sumField(collName, field, filters = []) {
  const rows = await getAll(collName, filters);
  return rows.reduce((s, r) => s + (parseFloat(r[field]) || 0), 0);
}

// Count docs with filters
async function countDocs(collName, filters = []) {
  const rows = await getAll(collName, filters);
  return rows.length;
}

// ═══════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════
let PRICES = { tea: 10, breakfast: 30, lunch: 80, dinner: 80, snacks: 20, night_snack: 25 };

async function loadPrices() {
  const rows = await getAll(C.settings);
  for (const r of rows) PRICES[r.key] = parseFloat(r.value) || 0;
}

function getMonthName(m) {
  return ['', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'][m] || '';
}

function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

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

async function calcMonthBill(empNo, month, year) {
  const entries = await getAll(C.entries, [
    { field: 'employee_number', op: '==', value: empNo },
    { field: 'entry_month', op: '==', value: month },
    { field: 'entry_year', op: '==', value: year },
  ]);
  const currentBill = entries.reduce((s, e) => s + (e.daily_total || 0), 0);

  const carry = await getAll(C.pendingCarry, [
    { field: 'employee_number', op: '==', value: empNo },
    { field: 'carried_to_month', op: '==', value: month },
    { field: 'carried_to_year', op: '==', value: year },
  ]);
  const carryForward = carry.reduce((s, c) => s + (c.pending_amount || 0), 0);

  return { current_month_bill: currentBill, carry_forward: carryForward, total_bill: currentBill + carryForward };
}

async function processCarryForward(empNo, fromMonth, fromYear, toMonth, toYear) {
  const bill = calcMonthBillRaw(await getAll(C.entries, [
    { field: 'employee_number', op: '==', value: empNo },
    { field: 'entry_month', op: '==', value: fromMonth },
    { field: 'entry_year', op: '==', value: fromYear },
  ]));
  const carryData = await getAll(C.pendingCarry, [
    { field: 'employee_number', op: '==', value: empNo },
    { field: 'carried_to_month', op: '==', value: fromMonth },
    { field: 'carried_to_year', op: '==', value: fromYear },
  ]);
  const carryForward = carryData.reduce((s, c) => s + (c.pending_amount || 0), 0);
  const totalBill = bill + carryForward;

  const payData = await getAll(C.payments, [
    { field: 'employee_number', op: '==', value: empNo },
    { field: 'month', op: '==', value: fromMonth },
    { field: 'year', op: '==', value: fromYear },
  ]);
  const paid = payData.reduce((s, p) => s + (p.amount_paid || 0), 0);
  const pending = totalBill - paid;

  if (pending > 0) {
    const existing = await getAll(C.pendingCarry, [
      { field: 'employee_number', op: '==', value: empNo },
      { field: 'from_month', op: '==', value: fromMonth },
      { field: 'from_year', op: '==', value: fromYear },
    ]);
    const docId = existing.length > 0 ? existing[0].id : `${empNo}_${fromMonth}_${fromYear}`;
    await setDocData(C.pendingCarry, docId, {
      employee_number: empNo, from_month: fromMonth, from_year: fromYear,
      pending_amount: pending, carried_to_month: toMonth, carried_to_year: toYear,
      created_at: nowStr(),
    });
  }
}

function calcMonthBillRaw(entries) {
  return entries.reduce((s, e) => s + (e.daily_total || 0), 0);
}

// ═══════════════════════════════════════════════════════════════════
//  AUTO-CLEANUP: Delete data older than 1 year
// ═══════════════════════════════════════════════════════════════════
async function cleanupOldData() {
  try {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const cutoffYear = oneYearAgo.getFullYear();
    const cutoffMonth = oneYearAgo.getMonth() + 1;
    const cutoffDate = `${cutoffYear}-${String(cutoffMonth).padStart(2, '0')}-31`;

    console.log(`🧹 Cleaning up data older than ${cutoffDate}...`);

    // Clean old entries
    const oldEntries = await getAll(C.entries, [
      { field: 'entry_year', op: '<', value: cutoffYear },
    ]);
    // Also get entries from cutoff year but before cutoff month
    const oldEntriesMonth = await getAll(C.entries, [
      { field: 'entry_year', op: '==', value: cutoffYear },
      { field: 'entry_month', op: '<', value: cutoffMonth },
    ]);
    const entriesToDelete = [...oldEntries, ...oldEntriesMonth];
    for (const entry of entriesToDelete) {
      await deleteDocData(C.entries, entry.id);
    }

    // Clean old payments
    const oldPayments = await getAll(C.payments, [
      { field: 'year', op: '<', value: cutoffYear },
    ]);
    const oldPaymentsMonth = await getAll(C.payments, [
      { field: 'year', op: '==', value: cutoffYear },
      { field: 'month', op: '<', value: cutoffMonth },
    ]);
    const paymentsToDelete = [...oldPayments, ...oldPaymentsMonth];
    for (const payment of paymentsToDelete) {
      await deleteDocData(C.payments, payment.id);
    }

    // Clean old carry-forward
    const oldCarry = await getAll(C.pendingCarry, [
      { field: 'from_year', op: '<', value: cutoffYear },
    ]);
    for (const carry of oldCarry) {
      await deleteDocData(C.pendingCarry, carry.id);
    }

    // Clean old online orders (keep for 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const oldOrders = await getAll(C.onlineOrders);
    let ordersDeleted = 0;
    for (const order of oldOrders) {
      if (order.created_at) {
        const orderDate = new Date(order.created_at);
        if (orderDate < sixMonthsAgo) {
          await deleteDocData(C.onlineOrders, order.id);
          ordersDeleted++;
        }
      }
    }

    console.log(`✅ Cleanup complete: ${entriesToDelete.length} entries, ${paymentsToDelete.length} payments, ${oldCarry.length} carry-forward, ${ordersDeleted} old orders deleted`);
  } catch (err) {
    console.error('⚠️ Cleanup error:', err.message);
  }
}

// Run cleanup daily (check every 6 hours)
setInterval(cleanupOldData, 6 * 60 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════
//  SSE (Server-Sent Events) for real-time order updates
// ═══════════════════════════════════════════════════════════════════
let sseClients = [];
function sendSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(c => {
    try { c.res.write(payload); return true; } catch (e) { return false; }
  });
}

// ═══════════════════════════════════════════════════════════════════
//  ADMIN API PROTECTION MIDDLEWARE
// ═══════════════════════════════════════════════════════════════════
// Public endpoints that do NOT require authentication
const PUBLIC_GET_PATHS = ['/today', '/prices', '/menu/available', '/booking-open', '/serial-register/lookup', '/password', '/password/default', '/serial-register/stats/all', '/menu'];
const PUBLIC_POST_PATHS = ['/orders', '/complaints', '/password/verify', '/feedback'];

app.use('/api', (req, res, next) => {
  const path = req.path;

  // Allow public GET endpoints
  if (req.method === 'GET' && PUBLIC_GET_PATHS.includes(path)) return next();

  // Allow public POST endpoints (order creation, complaint submission)
  if (req.method === 'POST' && PUBLIC_POST_PATHS.includes(path)) return next();

  // Allow public order tracking (new endpoint)
  if (req.method === 'GET' && path.startsWith('/orders/track/')) return next();

  // Allow public serial-register lookup
  if (req.method === 'GET' && path.startsWith('/serial-register/lookup/')) return next();

  // Allow SSE stream (needed for real-time order updates on admin page)
  if (path === '/orders/stream') return next();

  // Allow public serial-register stats (needed by serial-register page before password entry)
  if (req.method === 'GET' && path === '/serial-register/stats/all') return next();

  // Allow public serial-register list (for browsing before auth)
  if (req.method === 'GET' && path === '/serial-register') return next();

  // Allow viewing complaints/feedback (QR-submitted feedback from phone)
  if (req.method === 'GET' && path === '/complaints') return next();

  // Allow subscription status check (public for access control)
  if (req.method === 'GET' && path === '/subscription') return next();
  if (req.method === 'GET' && path === '/subscription/check') return next();

  // Allow password reset for lockout recovery
  if (req.method === 'POST' && path === '/password/reset') return next();

  // Allow user authentication endpoints (public)
  if (req.method === 'POST' && path === '/users/register') return next();
  if (req.method === 'POST' && path === '/users/login') return next();
  if (req.method === 'POST' && path === '/users/verify') return next();
  if (req.method === 'GET' && path === '/users/pending') return next();
  if (req.method === 'GET' && path === '/users/all') return next();
  if (req.method === 'POST' && path.startsWith('/users/approve/')) return next();
  if (req.method === 'POST' && path.startsWith('/users/reject/')) return next();
  if (req.method === 'POST' && path.startsWith('/users/pause/')) return next();
  if (req.method === 'POST' && path.startsWith('/users/resume/')) return next();
  if (req.method === 'POST' && path.startsWith('/users/delete/')) return next();
  if (req.method === 'POST' && path.startsWith('/users/role/')) return next();

  // Allow public serial-register single entry lookup
  if (req.method === 'GET' && /^\/serial-register\/\d+/.test(path)) return next();

  // Everything else requires authentication (Firebase token OR password)
  dualAuth(req, res, next);
});

// ═══════════════════════════════════════════════════════════════════
//  SEED DEFAULT DATA (runs once)
// ═══════════════════════════════════════════════════════════════════
async function seedDefaults() {
  // Prices - seed defaults if settings collection is empty
  const existingPrices = await getAll(C.settings);
  if (existingPrices.length === 0) {
    for (const [k, v] of Object.entries({ tea: 10, breakfast: 30, lunch: 80, dinner: 80, snacks: 20 })) {
      await setDocData(C.settings, k, { key: k, value: v });
    }
  }
  // Always ensure password is set to 988388
  await setDocData(C.settings, 'password', { key: 'password', value: '988388' });

  // Menu
  const menu = await getAll(C.menuItems);
  if (menu.length === 0) {
    const items = [
      { name: 'Tea', icon: '☕', price: 10, available: 1, sort_order: 1 },
      { name: 'Breakfast', icon: '🥪', price: 30, available: 1, sort_order: 2 },
      { name: 'Lunch', icon: '🍛', price: 80, available: 1, sort_order: 3 },
      { name: 'Dinner', icon: '🍲', price: 80, available: 1, sort_order: 4 },
      { name: 'Snacks', icon: '🍪', price: 20, available: 1, sort_order: 5 },
    ];
    for (const item of items) await addDocData(C.menuItems, item);
  }

  // Serial register - add missing serials up to 1000 (preserves existing data)
  const serials = await getAll(C.serialRegister);
  const existingSerialNos = new Set(serials.map(s => s.serial_no));
  let addedSerials = 0;
  for (let i = 1; i <= 1000; i++) {
    if (!existingSerialNos.has(i)) {
      await setDocData(C.serialRegister, String(i), { serial_no: i, employee_name: '', phone_number: '', department: '', status: 'Vacant', joining_date: '', leaving_date: '', current_employee: '' });
      addedSerials++;
    }
  }
  if (addedSerials > 0) console.log(`📇 Added ${addedSerials} new serial slots (total: ${serials.length + addedSerials})`);

  // Booking settings
  const booking = await getDocById(C.bookingSettings, '1');
  if (!booking) {
    await setDocData(C.bookingSettings, '1', { booking_open: 1, start_time: '08:00', end_time: '20:00', closed_message: 'Booking is currently closed.', updated_at: nowStr() });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  API ROUTES
// ═══════════════════════════════════════════════════════════════════

// ─── Today ────────────────────────────────────────────────────────
app.get('/api/today', (_req, res) => {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  res.json({ date: `${day} ${months[now.getMonth()]} ${year}`, iso: `${year}-${month}-${day}`, month: now.getMonth() + 1, year });
});

// ─── Prices ───────────────────────────────────────────────────────
app.get('/api/prices', async (_req, res) => {
  await loadPrices();
  res.json(PRICES);
});

app.post('/api/prices', async (req, res) => {
  const { prices } = req.body;
  if (!prices || typeof prices !== 'object') return res.status(400).json({ error: 'Invalid prices' });
  const prevPrices = { ...PRICES };
  for (const [k, v] of Object.entries(prices)) {
    if (['tea','breakfast','lunch','dinner','snacks','night_snack'].includes(k)) {
      const numVal = parseFloat(v);
      if (isNaN(numVal) || numVal < 0 || numVal > 9999) continue;
      await setDocData(C.settings, k, { key: k, value: numVal });
      PRICES[k] = numVal;
    }
  }
  await req.audit(ACTIONS.PRICES_UPDATED, 'settings', 'prices', prevPrices, { ...PRICES });
  res.json({ success: true });
});

// ─── Password ─────────────────────────────────────────────────────
app.get('/api/password', async (_req, res) => {
  // Return masked password for backward compatibility (actual auth now uses Firebase)
  res.json({ password: '•••••' });
});

// ─── Public: Get default password hint (for first-time setup) ──
app.get('/api/password/default', async (_req, res) => {
  try {
    const row = await getDocById(C.settings, 'password');
    const storedPw = row ? String(row.value) : '988388';
    res.json({ default: storedPw });
  } catch (err) {
    res.json({ default: '988388' });
  }
});

app.post('/api/password', async (req, res) => {
  const { password } = req.body;
  if (password === undefined || password === null) return res.status(400).json({ error: 'Password required' });
  // Get previous value for audit
  const prevPw = await getDocById(C.settings, 'password');
  await setDocData(C.settings, 'password', { key: 'password', value: String(password) });
  // Audit log
  await req.audit(ACTIONS.PASSWORD_CHANGED, 'settings', 'password', { value: prevPw ? '***' : null }, { value: '***' });
  res.json({ success: true });
});

app.post('/api/password/verify', async (req, res) => {
  try {
    const { password } = req.body;
    const row = await getDocById(C.settings, 'password');
    // Handle both number and string stored passwords
    const storedPw = row ? String(row.value) : '988388';
    if (String(password) === storedPw) {
      res.json({ valid: true });
    } else {
      res.status(401).json({ valid: false, error: 'Invalid password' });
    }
  } catch (err) {
    console.error('Password verify error:', err.message);
    // Fallback: allow default password if DB is unavailable
    if (String(req.body.password) === '988388') {
      res.json({ valid: true });
    } else {
      res.status(500).json({ valid: false, error: 'Auth service unavailable' });
    }
  }
});

// ─── Public: Reset password to default (for lockout recovery) ──
app.post('/api/password/reset', async (req, res) => {
  try {
    const { currentPassword } = req.body;
    // Only allow reset if current password matches (or DB is unavailable)
    const row = await getDocById(C.settings, 'password');
    const storedPw = row ? String(row.value) : '988388';
    if (currentPassword && String(currentPassword) === storedPw) {
      await setDocData(C.settings, 'password', { key: 'password', value: '988388' });
      res.json({ success: true, message: 'Password reset to 988388' });
    } else {
      res.status(400).json({ error: 'Current password is incorrect' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Reset failed' });
  }
});

// ─── Employees ────────────────────────────────────────────────────
app.get('/api/employees', async (_req, res) => {
  const rows = await getAll(C.employees, [], 'employee_number', true);
  res.json(rows);
});

app.get('/api/employees/:empNo', async (req, res) => {
  const empNo = parseInt(req.params.empNo, 10);
  if (!empNo || empNo < 1 || empNo > 1000) return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  const row = await getDocById(C.employees, empNo);
  res.json(row || { employee_number: empNo, name: '' });
});

app.post('/api/employees', async (req, res) => {
  const { employee_number, name } = req.body;
  if (!employee_number || employee_number < 1 || employee_number > 1000) return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  const prevEmp = await getDocById(C.employees, employee_number);
  await setDocData(C.employees, employee_number, {
    employee_number, name: (name || '').trim(),
    status: 'active', // Employee data protection: default active status
    updated_at: nowStr(),
  });
  await req.audit(prevEmp ? ACTIONS.EMPLOYEE_UPDATED : ACTIONS.EMPLOYEE_CREATED, 'employees', employee_number, prevEmp, { employee_number, name });
  res.json({ success: true });
});

// ─── Entry (today / specific date) ────────────────────────────────
app.get('/api/entry/:empNo', async (req, res) => {
  const empNo = parseInt(req.params.empNo, 10);
  if (!empNo || empNo < 1 || empNo > 1000) return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  const today = todayISO();
  const docId = `${empNo}_${today}`;
  const row = await getDocById(C.entries, docId);
  if (row) return res.json(row);
  const now = new Date();
  res.json({ employee_number: empNo, entry_date: today, entry_month: now.getMonth() + 1, entry_year: now.getFullYear(),
    tea_qty: 0, breakfast_qty: 0, lunch_qty: 0, dinner_qty: 0, snacks_qty: 0, night_snack_qty: 0, other_description: '', other_amount: 0, custom_items: '', daily_total: 0 });
});

app.get('/api/entry/:empNo/:date', async (req, res) => {
  const empNo = parseInt(req.params.empNo, 10);
  const date = req.params.date;
  if (!empNo || empNo < 1 || empNo > 1000) return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
  const docId = `${empNo}_${date}`;
  const row = await getDocById(C.entries, docId);
  if (row) return res.json(row);
  const parts = date.split('-');
  res.json({ employee_number: empNo, entry_date: date, entry_month: parseInt(parts[1], 10), entry_year: parseInt(parts[0], 10),
    tea_qty: 0, breakfast_qty: 0, lunch_qty: 0, dinner_qty: 0, snacks_qty: 0, night_snack_qty: 0, other_description: '', other_amount: 0, custom_items: '', daily_total: 0 });
});

// Save entry (POST) - with validation
app.post('/api/entry', validateEntry, async (req, res) => {
  try {
    await loadPrices();
    const { employee_number, entry_date, tea_qty, breakfast_qty, lunch_qty, dinner_qty, snacks_qty, night_snack_qty, other_description, other_amount, custom_items } = req.body;
    if (!employee_number || employee_number < 1 || employee_number > 1000) return res.status(400).json({ error: 'Invalid employee number (1-1000)' });

    let entryDate, currentMonth, currentYear;
    if (entry_date && /^\d{4}-\d{2}-\d{2}$/.test(entry_date)) {
      entryDate = entry_date;
      const p = entry_date.split('-');
      currentMonth = parseInt(p[1], 10);
      currentYear = parseInt(p[0], 10);
    } else {
      const now = new Date();
      entryDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      currentMonth = now.getMonth() + 1;
      currentYear = now.getFullYear();
    }

    const tQ = parseInt(tea_qty) || 0;
    const nsQ = parseInt(night_snack_qty) || 0;
    const bQ = parseInt(breakfast_qty) || 0;
    const lQ = parseInt(lunch_qty) || 0;
    const dQ = parseInt(dinner_qty) || 0;
    const sQ = parseInt(snacks_qty) || 0;
    const oAmt = parseFloat(other_amount) || 0;

    const dailyTotal = tQ * (PRICES.tea || 10) + nsQ * (PRICES.night_snack || 25) + bQ * (PRICES.breakfast || 30) + lQ * (PRICES.lunch || 80) + dQ * (PRICES.dinner || 80) + sQ * (PRICES.snacks || 20) + oAmt;

    const docId = `${employee_number}_${entryDate}`;
    await setDocData(C.entries, docId, {
      employee_number, entry_date: entryDate, entry_month: currentMonth, entry_year: currentYear,
      tea_qty: tQ, breakfast_qty: bQ, lunch_qty: lQ, dinner_qty: dQ, snacks_qty: sQ, night_snack_qty: nsQ,
      other_description: other_description || '', other_amount: oAmt, custom_items: custom_items || '', daily_total: dailyTotal,
      created_at: nowStr(),
    });

    // Also save employee name if not exists
    const empDoc = await getDocById(C.employees, employee_number);
    if (!empDoc) {
      await setDocData(C.employees, employee_number, { employee_number, name: '' });
    }

    res.json({ success: true, daily_total: dailyTotal });
  } catch (err) {
    console.error('Entry save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Delete entry (with audit logging)
app.delete('/api/entry/:empNo/:date', async (req, res) => {
  const empNo = parseInt(req.params.empNo, 10);
  const date = req.params.date;
  if (!empNo || empNo < 1 || empNo > 1000) return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  if (!/\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date format' });
  const docId = `${empNo}_${date}`;
  const existing = await getDocById(C.entries, docId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  await deleteDocData(C.entries, docId);
  await req.audit('entry_deleted', 'entries', docId, existing, null);
  res.json({ success: true });
});



// ─── Calendar: get all entry dates for employee in a month ─────
app.get('/api/calendar/:empNo/:year/:month', async (req, res) => {
  try {
    const empNo = parseInt(req.params.empNo, 10);
    const year = parseInt(req.params.year, 10);
    const month = parseInt(req.params.month, 10);
    if (!empNo || empNo < 1 || empNo > 1000) return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
    const allEntries = await getAll(C.entries, [
      { field: 'employee_number', op: '==', value: empNo },
      { field: 'entry_year', op: '==', value: year },
      { field: 'entry_month', op: '==', value: month },
    ]);
    const dates = allEntries.map(e => ({ date: e.entry_date, total: e.daily_total }));
    res.json({ employee_number: empNo, year, month, dates });
  } catch (err) {
    console.error('Calendar error:', err);
    res.status(500).json({ error: err.message });
  }
});
// ─── History (current month for employee) ─────────────────────────
app.get('/api/history/:empNo', async (req, res) => {
  const empNo = parseInt(req.params.empNo, 10);
  if (!empNo || empNo < 1 || empNo > 1000) return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  const now = new Date();
  const cm = now.getMonth() + 1, cy = now.getFullYear();
  const allEntries = await getAll(C.entries, [
    { field: 'employee_number', op: '==', value: empNo },
  ]);
  const monthEntries = allEntries.filter(e => e.entry_month === cm && e.entry_year === cy).sort((a, b) => (b.entry_date || '').localeCompare(a.entry_date || ''));
  const monthlyTotal = monthEntries.reduce((s, e) => s + (e.daily_total || 0), 0);
  const allTimeTotal = allEntries.reduce((s, e) => s + (e.daily_total || 0), 0);
  res.json({ employee_number: empNo, current_month: cm, current_year: cy, month_entries: monthEntries, monthly_total: monthlyTotal, all_time_total: allTimeTotal });
});

// ─── Records ──────────────────────────────────────────────────────
app.get('/api/records/gross/:year/:month', async (req, res) => {
  const year = parseInt(req.params.year, 10), month = parseInt(req.params.month, 10);
  const allEntries = await getAll(C.entries, [
    { field: 'entry_year', op: '==', value: year },
    { field: 'entry_month', op: '==', value: month },
  ]);
  // Group by employee
  const empMap = {};
  for (const e of allEntries) {
    const en = e.employee_number;
    if (!empMap[en]) empMap[en] = { employee_number: en, tea_qty: 0, breakfast_qty: 0, lunch_qty: 0, dinner_qty: 0, snacks_qty: 0, other_amount: 0, total: 0 };
    empMap[en].tea_qty += e.tea_qty || 0;
    empMap[en].breakfast_qty += e.breakfast_qty || 0;
    empMap[en].lunch_qty += e.lunch_qty || 0;
    empMap[en].dinner_qty += e.dinner_qty || 0;
    empMap[en].snacks_qty += e.snacks_qty || 0;
    empMap[en].other_amount += e.other_amount || 0;
    empMap[en].total += e.daily_total || 0;
  }
  const employees = Object.values(empMap).sort((a, b) => a.employee_number - b.employee_number);
  const grandTotal = employees.reduce((s, e) => s + e.total, 0);
  res.json({ year, month, month_name: getMonthName(month), employees, count: employees.length, grand_total: grandTotal });
});

app.get('/api/records/gross/:year', async (req, res) => {
  const year = parseInt(req.params.year, 10);
  const allEntries = await getAll(C.entries, [{ field: 'entry_year', op: '==', value: year }]);
  // Monthly data
  const monthMap = {};
  for (const e of allEntries) {
    const m = e.entry_month;
    if (!monthMap[m]) monthMap[m] = { entry_month: m, total: 0, empSet: new Set() };
    monthMap[m].total += e.daily_total || 0;
    monthMap[m].empSet.add(e.employee_number);
  }
  const monthlyData = Object.values(monthMap).map(m => ({ entry_month: m.entry_month, total: m.total, emp_count: m.empSet.size })).sort((a, b) => a.entry_month - b.entry_month);
  // Employee totals
  const empMap = {};
  for (const e of allEntries) {
    const en = e.employee_number;
    if (!empMap[en]) empMap[en] = { employee_number: en, tea_qty: 0, breakfast_qty: 0, lunch_qty: 0, dinner_qty: 0, snacks_qty: 0, other_amount: 0, total: 0 };
    empMap[en].tea_qty += e.tea_qty || 0;
    empMap[en].breakfast_qty += e.breakfast_qty || 0;
    empMap[en].lunch_qty += e.lunch_qty || 0;
    empMap[en].dinner_qty += e.dinner_qty || 0;
    empMap[en].snacks_qty += e.snacks_qty || 0;
    empMap[en].other_amount += e.other_amount || 0;
    empMap[en].total += e.daily_total || 0;
  }
  const employees = Object.values(empMap).sort((a, b) => a.employee_number - b.employee_number);
  const grandTotal = employees.reduce((s, e) => s + e.total, 0);
  res.json({ year, monthly_data: monthlyData, employees, count: employees.length, grand_total: grandTotal });
});

app.get('/api/records/:empNo/:year', async (req, res) => {
  const empNo = parseInt(req.params.empNo, 10), year = parseInt(req.params.year, 10);
  if (!empNo || empNo < 1 || empNo > 1000) return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
  const allEntries = await getAll(C.entries, [
    { field: 'employee_number', op: '==', value: empNo },
    { field: 'entry_year', op: '==', value: year },
  ]);
  const monthMap = {};
  for (const e of allEntries) {
    const m = e.entry_month;
    if (!monthMap[m]) monthMap[m] = { entry_month: m, tea_qty: 0, breakfast_qty: 0, lunch_qty: 0, dinner_qty: 0, snacks_qty: 0, other_amount: 0, total: 0 };
    monthMap[m].tea_qty += e.tea_qty || 0;
    monthMap[m].breakfast_qty += e.breakfast_qty || 0;
    monthMap[m].lunch_qty += e.lunch_qty || 0;
    monthMap[m].dinner_qty += e.dinner_qty || 0;
    monthMap[m].snacks_qty += e.snacks_qty || 0;
    monthMap[m].other_amount += e.other_amount || 0;
    monthMap[m].total += e.daily_total || 0;
  }
  const monthlyData = Object.values(monthMap).sort((a, b) => a.entry_month - b.entry_month);
  const yearlyTotal = monthlyData.reduce((s, e) => s + e.total, 0);
  const h1 = monthlyData.filter(e => e.entry_month >= 1 && e.entry_month <= 6).reduce((s, e) => s + e.total, 0);
  const h2 = monthlyData.filter(e => e.entry_month >= 7 && e.entry_month <= 12).reduce((s, e) => s + e.total, 0);
  res.json({ employee_number: empNo, year, monthly_data: monthlyData, yearly_total: yearlyTotal, h1_total: h1, h2_total: h2 });
});

// ─── Pending (all employees) - OPTIMIZED: fetch all data first, calc in JS ──
app.get('/api/payments/pending/all/:year', async (req, res) => {
  try {
    const year = parseInt(req.params.year, 10);
    if (!year) return res.status(400).json({ error: 'Year required' });
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const maxMonth = (year === now.getFullYear()) ? currentMonth : 12;

    // Fetch ALL data in just 3 queries (instead of hundreds)
    const [allEntries, allPayments, allEmployees] = await Promise.all([
      getAll(C.entries, [{ field: 'entry_year', op: '==', value: year }]),
      getAll(C.payments, [{ field: 'year', op: '==', value: year }]),
      getAll(C.employees),
    ]);

    const empNames = {};
    for (const e of allEmployees) empNames[e.employee_number] = e.name || '';
    const empNos = [...new Set(allEntries.map(e => e.employee_number))].sort((a, b) => a - b);
    const results = [];

    for (const empNo of empNos) {
      let totalBill = 0;
      for (let m = 1; m <= maxMonth; m++) {
        const empEntries = allEntries.filter(e => e.employee_number === empNo && e.entry_month === m);
        totalBill += empEntries.reduce((s, e) => s + (e.daily_total || 0), 0);
      }
      const empPayments = allPayments.filter(p => p.employee_number === empNo);
      const totalPaid = empPayments.reduce((s, p) => s + (p.amount_paid || 0), 0);
      const pending = Math.max(0, totalBill - totalPaid);
      if (pending > 0 || totalBill > 0) {
        results.push({ employee_number: empNo, employee_name: empNames[empNo] || '', total_bill: totalBill, total_paid: totalPaid, total_pending: pending });
      }
    }
    const grandTotalPending = results.reduce((s, r) => s + r.total_pending, 0);
    res.json({ year, employees: results, count: results.length, grand_total_pending: grandTotalPending });
  } catch (err) {
    console.error('Pending fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Payments ─────────────────────────────────────────────────────
app.get('/api/payments/:empNo/:year/:month', async (req, res) => {
  try {
    const empNo = parseInt(req.params.empNo, 10), year = parseInt(req.params.year, 10), month = parseInt(req.params.month, 10);
    if (!empNo || empNo < 1 || empNo > 1000) return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
    if (month > 1) await processCarryForward(empNo, month - 1, year, month, year);
    else if (year > 2020) await processCarryForward(empNo, 12, year - 1, 1, year);
    const bill = await calcMonthBill(empNo, month, year);
    const payData = await getAll(C.payments, [
      { field: 'employee_number', op: '==', value: empNo },
      { field: 'month', op: '==', value: month },
      { field: 'year', op: '==', value: year },
    ]);
    const amountPaid = payData.length > 0 ? payData[0].amount_paid : 0;
    const status = payData.length > 0 ? payData[0].status : 'unpaid';
    const pending = Math.max(0, bill.total_bill - amountPaid);
    const empRow = await getDocById(C.employees, empNo);
    const paymentHistory = await getAll(C.payments, [
      { field: 'employee_number', op: '==', value: empNo },
    ], 'year', false);
    // Enrich history with bill data (avoid N+1 calls from frontend)
    const enrichedHistory = [];
    for (const p of paymentHistory.slice(0, 12)) {
      const pBill = await calcMonthBill(empNo, p.month, p.year);
      enrichedHistory.push({ ...p, total_bill: pBill.total_bill, current_month_bill: pBill.current_month_bill, carry_forward: pBill.carry_forward });
    }
    res.json({
      employee_number: empNo, employee_name: empRow ? empRow.name : '', month, year, month_name: getMonthName(month),
      current_month_bill: bill.current_month_bill, carry_forward: bill.carry_forward, total_bill: bill.total_bill,
      amount_paid: amountPaid, status, pending_amount: pending, payment_history: enrichedHistory,
    });
  } catch (err) {
    console.error('Payment fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/payments', validatePayment, async (req, res) => {
  try {
    const { employee_number, month, year, amount_paid, status, note } = req.body;
    if (!employee_number || employee_number < 1 || employee_number > 1000) return res.status(400).json({ error: 'Invalid employee number (1-1000)' });
    if (!month || !year) return res.status(400).json({ error: 'Month/year required' });
    const docId = `${employee_number}_${month}_${year}`;
    const prevPayment = await getDocById(C.payments, docId);
    await setDocData(C.payments, docId, {
      employee_number, month, year,
      amount_paid: parseFloat(amount_paid) || 0,
      status: status || 'unpaid',
      note: (note || '').substring(0, 500),
      created_at: nowStr(),
    });
    await req.audit(prevPayment ? ACTIONS.PAYMENT_UPDATED : ACTIONS.PAYMENT_RECORDED, 'payments', docId, prevPayment, { employee_number, month, year, amount_paid, status });
    const nextMonth = month === 12 ? 1 : month + 1;
    const nextYear = month === 12 ? year + 1 : year;
    await processCarryForward(employee_number, month, year, nextMonth, nextYear);
    res.json({ success: true });
  } catch (err) {
    console.error('Payment save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Menu ─────────────────────────────────────────────────────────
app.get('/api/menu', async (_req, res) => {
  const items = await getAll(C.menuItems, [], 'sort_order', true);
  res.json(items);
});

app.get('/api/menu/available', async (_req, res) => {
  const items = await getAll(C.menuItems, [{ field: 'available', op: '==', value: 1 }], 'sort_order', true);
  res.json(items);
});

app.post('/api/menu', validateMenu, async (req, res) => {
  try {
    const { name, icon, price, available } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const existing = await getAll(C.menuItems);
    const maxOrder = existing.length > 0 ? Math.max(...existing.map(i => i.sort_order || 0)) : 0;
    const data = { name: name.trim(), icon: icon || '🍽️', price: parseFloat(price) || 0, available: available !== undefined ? (available ? 1 : 0) : 1, sort_order: maxOrder + 1 };
    const newId = await addDocData(C.menuItems, data);
    await req.audit(ACTIONS.MENU_CREATED, 'menu_items', newId, null, data);
    res.json({ success: true, item: { id: newId, ...data } });
  } catch (err) {
    console.error('Menu add error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/menu/:id', validateMenu, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await getDocById(C.menuItems, id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const updates = {
      name: req.body.name ? req.body.name.trim() : existing.name,
      icon: req.body.icon || existing.icon,
      price: req.body.price !== undefined ? parseFloat(req.body.price) : existing.price,
      available: req.body.available !== undefined ? (req.body.available ? 1 : 0) : existing.available,
      sort_order: req.body.sort_order !== undefined ? parseInt(req.body.sort_order) : existing.sort_order,
    };
    await updateDocData(C.menuItems, id, updates);
    await req.audit(ACTIONS.MENU_UPDATED, 'menu_items', id, existing, updates);
    res.json({ success: true, item: { id, ...updates } });
  } catch (err) {
    console.error('Menu update error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/menu/:id', async (req, res) => {
  try {
    const existing = await getDocById(C.menuItems, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await deleteDocData(C.menuItems, req.params.id);
    await req.audit(ACTIONS.MENU_DELETED, 'menu_items', req.params.id, existing, null);
    res.json({ success: true });
  } catch (err) {
    console.error('Menu delete error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Online Orders ────────────────────────────────────────────────
app.get('/api/orders/stream', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  res.write('event: connected\ndata: {"msg":"connected"}\n\n');
  const client = { id: Date.now(), res };
  sseClients.push(client);
  req.on('close', () => { sseClients = sseClients.filter(c => c.id !== client.id); });
});

app.post('/api/orders', orderLimiter, validateOrder, async (req, res) => {
  try {
    const { employeeName, phoneNumber, department, items, totalAmount } = req.body;

    // ─── DUPLICATE ORDER PROTECTION ──────────────────────────
    // Check if same employee already placed an order today
    const todayDate = new Date().toISOString().substring(0, 10);
    const existingOrders = await getAll(C.onlineOrders);
    const todayOrders = existingOrders.filter(o =>
      o.created_at && o.created_at.startsWith(todayDate) &&
      (o.employee_name || '').toLowerCase() === employeeName.toLowerCase() &&
      o.status !== 'cancelled'
    );
    if (todayOrders.length > 0) {
      return res.status(409).json({
        error: 'duplicate_order',
        message: `You have already placed an order today (${todayOrders[0].order_id}). Only one order per employee per day is allowed.`,
      });
    }

    // ─── BOOKING TIME VALIDATION (server-side) ──────────────
    const bookingSettings = await getDocById(C.bookingSettings, '1');
    if (bookingSettings && !bookingSettings.booking_open) {
      return res.status(403).json({ error: 'Booking is currently closed' });
    }
    if (bookingSettings && bookingSettings.start_time && bookingSettings.end_time) {
      const now2 = new Date();
      const curMin = now2.getHours() * 60 + now2.getMinutes();
      const [sh, sm] = (bookingSettings.start_time || '08:00').split(':').map(Number);
      const [eh, em] = (bookingSettings.end_time || '20:00').split(':').map(Number);
      if (curMin < sh * 60 + sm || curMin >= eh * 60 + em) {
        return res.status(403).json({ error: 'Ordering is only allowed between ' + bookingSettings.start_time + ' and ' + bookingSettings.end_time });
      }
    }

    // ─── VALIDATE MENU ITEMS against actual menu ────────────
    const menuItems = await getAll(C.menuItems, [{ field: 'available', op: '==', value: 1 }]);
    const validMenuIds = new Set(menuItems.map(m => String(m.id)));
    const validMenuNames = new Set(menuItems.map(m => (m.name || '').toLowerCase()));
    for (const item of items) {
      if (item.id && !validMenuIds.has(String(item.id)) && !validMenuNames.has((item.name || '').toLowerCase())) {
        return res.status(400).json({ error: `Invalid menu item: ${item.name}` });
      }
      // Ensure price matches server-side
      const serverItem = menuItems.find(m => String(m.id) === String(item.id) || (m.name || '').toLowerCase() === (item.name || '').toLowerCase());
      if (serverItem) {
        item.price = serverItem.price; // Use server price, not client-submitted price
      }
    }

    const now = new Date();
    const orderId = `ORD-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
    const createdAt = nowStr();

    // Recalculate total on server-side
    const serverTotal = items.reduce((sum, item) => sum + (item.price || 0) * (item.quantity || 1), 0);

    const data = {
      order_id: orderId, employee_name: employeeName, phone_number: phoneNumber || '',
      department: department || '', items: JSON.stringify(items), total_amount: serverTotal,
      status: 'pending', created_at: createdAt, updated_at: createdAt,
    };
    await setDocData(C.onlineOrders, orderId, data);
    data.items = items;
    sendSSE('new-order', data);
    res.json({ success: true, order: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Public Order Tracking (by order ID) ──────────────────
app.get('/api/orders/track/:orderId', async (req, res) => {
  try {
    const orderId = req.params.orderId;
    if (!orderId || !orderId.startsWith('ORD-')) {
      return res.status(400).json({ error: 'Invalid order ID' });
    }
    const order = await getDocById(C.onlineOrders, orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    try { order.items = JSON.parse(order.items); } catch (e) { order.items = []; }
    // Return only safe fields (no phone numbers or other employees' data)
    res.json({
      order_id: order.order_id,
      status: order.status,
      items: order.items,
      total_amount: order.total_amount,
      created_at: order.created_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin: List all orders (requires auth) ────────────────
app.get('/api/orders', async (req, res) => {
  try {
    const { date, status } = req.query;
    const filters = [];
    if (status && status !== 'all') filters.push({ field: 'status', op: '==', value: status });
    let orders = await getAll(C.onlineOrders, filters, 'created_at', false);
    if (date) orders = orders.filter(o => o.created_at && o.created_at.startsWith(date));
    orders.forEach(o => { try { o.items = JSON.parse(o.items); } catch (e) { o.items = []; } });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const valid = ['pending', 'accepted', 'preparing', 'ready', 'completed', 'cancelled'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const order = await getDocById(C.onlineOrders, id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  const prevStatus = order.status;
  await updateDocData(C.onlineOrders, id, { status, updated_at: nowStr() });
  await req.audit(status === 'cancelled' ? ACTIONS.ORDER_CANCELLED : ACTIONS.ORDER_STATUS_CHANGED, 'online_orders', id, { status: prevStatus }, { status });
  order.status = status;
  try { order.items = JSON.parse(order.items); } catch (e) { order.items = []; }
  sendSSE('status-update', order);
  res.json({ success: true, order });
});

app.get('/api/orders/stats', async (req, res) => {
  const date = req.query.date || new Date().toISOString().substring(0, 10);
  const allOrders = await getAll(C.onlineOrders);
  const dayOrders = allOrders.filter(o => o.created_at && o.created_at.startsWith(date));
  res.json({
    date,
    total: dayOrders.length,
    pending: dayOrders.filter(o => o.status === 'pending').length,
    preparing: dayOrders.filter(o => o.status === 'preparing').length,
    ready: dayOrders.filter(o => o.status === 'ready').length,
  });
});

// ─── Complaints ───────────────────────────────────────────────────
app.get('/api/complaints', async (req, res) => {
  const { status, category } = req.query;
  const filters = [];
  if (status && status !== 'all') filters.push({ field: 'status', op: '==', value: status });
  if (category && category !== 'all') filters.push({ field: 'category', op: '==', value: category });
  const rows = await getAll(C.complaints, filters, 'created_at', false);
  res.json(rows);
});

app.post('/api/complaints', validateComplaint, async (req, res) => {
  const { employee_name, employee_number, phone_number, department, category, subject, description, rating } = req.body;
  if (!subject || !description) return res.status(400).json({ error: 'Subject and description required' });
  const now = nowStr();
  const data = {
    employee_name: employee_name || '',
    employee_number: parseInt(employee_number) || 0,
    phone_number: phone_number || '', department: department || '',
    category: category || 'general',
    rating: Math.max(0, Math.min(5, parseInt(rating) || 0)),
    subject, description, status: 'open', admin_reply: '',
    created_at: now, updated_at: now,
  };
  const newId = await addDocData(C.complaints, data);
  await req.audit(ACTIONS.COMPLAINT_CREATED, 'complaints', newId, null, { subject, employee_name, rating });
  res.json({ success: true, complaint: { id: newId, ...data } });
});

app.put('/api/complaints/:id', validateComplaint, async (req, res) => {
  const existing = await getDocById(C.complaints, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const updates = {
    status: req.body.status || existing.status,
    admin_reply: req.body.admin_reply !== undefined ? req.body.admin_reply : existing.admin_reply,
    updated_at: nowStr(),
  };
  await updateDocData(C.complaints, req.params.id, updates);
  await req.audit(ACTIONS.COMPLAINT_REPLIED, 'complaints', req.params.id, existing, updates);
  res.json({ success: true, complaint: { id: req.params.id, ...existing, ...updates } });
});

// ─── Booking Settings ─────────────────────────────────────────────
app.get('/api/booking-settings', async (_req, res) => {
  const row = await getDocById(C.bookingSettings, '1');
  res.json(row || { booking_open: 1, start_time: '08:00', end_time: '20:00', closed_message: 'Booking is closed.' });
});

app.post('/api/booking-settings', async (req, res) => {
  const prevSettings = await getDocById(C.bookingSettings, '1');
  const { booking_open, start_time, end_time, closed_message, timer_end } = req.body;
  await setDocData(C.bookingSettings, '1', {
    booking_open: booking_open ? 1 : 0, start_time: start_time || '08:00',
    end_time: end_time || '20:00', closed_message: closed_message || '',
    timer_end: timer_end || null, updated_at: nowStr(),
  });
  await req.audit(ACTIONS.BOOKING_SETTINGS_CHANGED, 'booking_settings', '1', prevSettings, { booking_open, start_time, end_time });
  const row = await getDocById(C.bookingSettings, '1');
  res.json({ success: true, settings: row });
});

app.get('/api/booking-open', async (_req, res) => {
  try {
    const row = await getDocById(C.bookingSettings, '1');
    if (!row || !row.booking_open) return res.json({ open: false, message: row ? row.closed_message : 'Closed' });
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = (row.start_time || '08:00').split(':').map(Number);
    const [eh, em] = (row.end_time || '20:00').split(':').map(Number);
    const startMin = sh * 60 + sm;
    const endMin = eh * 60 + em;
    if (cur >= startMin && cur < endMin) {
      // Calculate remaining time in ms
      const endTimeMs = new Date(now);
      endTimeMs.setHours(eh, em, 0, 0);
      const remaining = endTimeMs.getTime() - now.getTime();
      res.json({ open: true, start_time: row.start_time, end_time: row.end_time, timer_end: endTimeMs.getTime(), remaining });
    } else {
      res.json({ open: false, message: row.closed_message || 'Closed' });
    }
  } catch (err) {
    console.error('Booking open error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Serial Register ──────────────────────────────────────────────
app.get('/api/serial-register', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limitN = parseInt(req.query.limit) || 25;
  const search = req.query.search || '';
  const statusFilter = req.query.status || '';
  const filters = [];
  if (statusFilter && statusFilter !== 'all') filters.push({ field: 'status', op: '==', value: statusFilter });
  let rows = await getAll(C.serialRegister, filters, 'serial_no', true);
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter(r =>
      String(r.serial_no).includes(s) || (r.employee_name || '').toLowerCase().includes(s) ||
      (r.phone_number || '').includes(s) || (r.department || '').toLowerCase().includes(s)
    );
  }
  const total = rows.length;
  const start = (page - 1) * limitN;
  const paged = rows.slice(start, start + limitN);
  res.json({ data: paged, total, page, limit: limitN, totalPages: Math.ceil(total / limitN) });
});

app.get('/api/serial-register/stats/all', async (_req, res) => {
  const rows = await getAll(C.serialRegister);
  const total = rows.length;
  const active = rows.filter(r => r.status === 'Active').length;
  const left = rows.filter(r => r.status === 'Left Company').length;
  const vacant = rows.filter(r => r.status === 'Vacant').length;
  res.json({ total, active, left, vacant });
});

app.get('/api/serial-register/lookup/:serialNo', async (req, res) => {
  const sn = parseInt(req.params.serialNo, 10);
  if (!sn || sn < 1 || sn > 1000) return res.status(400).json({ error: 'Invalid serial number (1-1000)' });
  const row = await getDocById(C.serialRegister, String(sn));
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.get('/api/serial-register/:serialNo', async (req, res) => {
  const sn = parseInt(req.params.serialNo, 10);
  if (!sn || sn < 1 || sn > 1000) return res.status(400).json({ error: 'Invalid serial number (1-1000)' });
  const row = await getDocById(C.serialRegister, String(sn));
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

app.post('/api/serial-register', validateSerialRegister, async (req, res) => {
  const { serial_no, employee_name, phone_number, department, joining_date } = req.body;
  const sn = parseInt(serial_no, 10);
  if (!sn || sn < 1 || sn > 1000) return res.status(400).json({ error: 'Invalid serial number (1-1000)' });
  if (!employee_name || !employee_name.trim()) return res.status(400).json({ error: 'Name required' });
  const existing = await getDocById(C.serialRegister, String(sn));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (existing.current_employee && existing.current_employee.trim() && existing.status === 'Active')
    return res.status(400).json({ error: 'occupied', previousName: existing.current_employee });
  const jd = joining_date || new Date().toISOString().substring(0, 10);
  const data = {
    serial_no: sn, employee_name: employee_name.trim(), phone_number: phone_number || '',
    department: department || '', status: 'Active', joining_date: jd, leaving_date: '', current_employee: employee_name.trim(),
  };
  await setDocData(C.serialRegister, String(sn), data);
  await req.audit(ACTIONS.SERIAL_ASSIGNED, 'serial_register', String(sn), existing, data);
  res.json({ success: true, data });
});

app.post('/api/serial-register/:serialNo/leave', async (req, res) => {
  try {
    const sn = parseInt(req.params.serialNo, 10);
    if (!sn || sn < 1 || sn > 1000) return res.status(400).json({ error: 'Invalid serial number (1-1000)' });
    const existing = await getDocById(C.serialRegister, String(sn));
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (existing.status !== 'Active') return res.status(400).json({ error: 'No active employee' });
    const ld = req.body.leaving_date || new Date().toISOString().substring(0, 10);
    // Save to history first (employee history is NEVER lost)
    try {
      await addDocData(C.serialHistory, {
        serial_no: sn, employee_name: existing.employee_name || '', phone_number: existing.phone_number || '',
        department: existing.department || '', joining_date: existing.joining_date || '', leaving_date: ld,
        status: 'Left Company', closed_at: nowStr(),
      });
    } catch (histErr) { console.error('History save error:', histErr.message); }
    // Reset to Vacant (but keep record of who was here in the register too)
    const prevData = { ...existing };
    await setDocData(C.serialRegister, String(sn), { serial_no: sn, employee_name: '', phone_number: '', department: '', status: 'Vacant', joining_date: '', leaving_date: '', current_employee: '' });
    await req.audit(ACTIONS.SERIAL_LEFT, 'serial_register', String(sn), prevData, { status: 'Vacant', leaving_date: ld });
    res.json({ success: true, data: { serial_no: sn, status: 'Vacant' } });
  } catch (err) {
    console.error('Leave error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/serial-register/:serialNo/new-record', validateSerialRegister, async (req, res) => {
  const sn = parseInt(req.params.serialNo, 10);
  if (!sn || sn < 1 || sn > 1000) return res.status(400).json({ error: 'Invalid serial number (1-1000)' });
  if (!req.body.employee_name || !req.body.employee_name.trim()) return res.status(400).json({ error: 'Name required' });
  const existing = await getDocById(C.serialRegister, String(sn));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const jd = req.body.joining_date || new Date().toISOString().substring(0, 10);
  // CRITICAL: Save previous employee to history before reassignment
  if (existing.status === 'Active' && existing.current_employee && existing.current_employee.trim()) {
    await addDocData(C.serialHistory, {
      serial_no: sn, employee_name: existing.employee_name || '', phone_number: existing.phone_number || '',
      department: existing.department || '', joining_date: existing.joining_date || '', leaving_date: jd,
      status: 'Left Company', closed_at: nowStr(),
    });
  }
  const prevData = { ...existing };
  const data = {
    serial_no: sn, employee_name: req.body.employee_name.trim(), phone_number: req.body.phone_number || '',
    department: req.body.department || '', status: 'Active', joining_date: jd, leaving_date: '', current_employee: req.body.employee_name.trim(),
  };
  await setDocData(C.serialRegister, String(sn), data);
  await req.audit(ACTIONS.SERIAL_REASSIGNED, 'serial_register', String(sn), prevData, data);
  res.json({ success: true, data });
});

app.get('/api/serial-register/:serialNo/history', async (req, res) => {
  const sn = parseInt(req.params.serialNo, 10);
  if (!sn || sn < 1 || sn > 1000) return res.status(400).json({ error: 'Invalid serial number (1-1000)' });
  const rows = await getAll(C.serialHistory, [{ field: 'serial_no', op: '==', value: sn }], 'closed_at', false);
  res.json(rows);
});

app.put('/api/serial-register/:serialNo', async (req, res) => {
  const sn = parseInt(req.params.serialNo, 10);
  if (!sn || sn < 1 || sn > 1000) return res.status(400).json({ error: 'Invalid serial number (1-1000)' });
  const existing = await getDocById(C.serialRegister, String(sn));
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const updates = {};
  if (req.body.employee_name !== undefined) updates.employee_name = req.body.employee_name.trim();
  if (req.body.phone_number !== undefined) updates.phone_number = req.body.phone_number;
  if (req.body.department !== undefined) updates.department = req.body.department;
  if (req.body.employee_name !== undefined) updates.current_employee = req.body.employee_name.trim();
  await updateDocData(C.serialRegister, String(sn), updates);
  const updated = await getDocById(C.serialRegister, String(sn));
  res.json({ success: true, data: updated });
});

// ─── Custom Entry Menu Items (for employee entry page) ────────
app.get('/api/entry-menu', async (_req, res) => {
  const items = await getAll(C.menuItems, [], 'sort_order', true);
  res.json(items);
});

app.post('/api/entry-menu', async (req, res) => {
  try {
    const { name, icon, price, field_key } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const existing = await getAll(C.menuItems);
    const maxOrder = existing.length > 0 ? Math.max(...existing.map(i => i.sort_order || 0)) : 0;
    const data = {
      name: name.trim(),
      icon: icon || '🍽️',
      price: parseFloat(price) || 0,
      available: 1,
      sort_order: maxOrder + 1,
      field_key: field_key || 'custom_' + Date.now(),
      type: 'entry_menu',
    };
    const newId = await addDocData(C.menuItems, data);
    res.json({ success: true, item: { id: newId, ...data } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/entry-menu/:id', async (req, res) => {
  try {
    const existing = await getDocById(C.menuItems, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name.trim();
    if (req.body.icon !== undefined) updates.icon = req.body.icon;
    if (req.body.price !== undefined) updates.price = parseFloat(req.body.price);
    if (req.body.available !== undefined) updates.available = req.body.available ? 1 : 0;
    if (req.body.sort_order !== undefined) updates.sort_order = parseInt(req.body.sort_order);
    await updateDocData(C.menuItems, req.params.id, updates);
    const updated = await getDocById(C.menuItems, req.params.id);
    res.json({ success: true, item: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/entry-menu/:id', async (req, res) => {
  try {
    const existing = await getDocById(C.menuItems, req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    await deleteDocData(C.menuItems, req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  ADMIN USER MANAGEMENT (Developer only)
// ═══════════════════════════════════════════════════════════════════

// List all admin users
app.get('/api/admin/users', requireAuth, requirePermission('developer:manage'), async (req, res) => {
  try {
    const { getFirestore } = require('firebase-admin/firestore');
    const adminDb = getFirestore();
    const snap = await adminDb.collection('admin_users').get();
    const users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create/update admin user
app.post('/api/admin/users', requireAuth, requirePermission('developer:manage'), async (req, res) => {
  try {
    const { uid, email, name, role, active } = req.body;
    if (!uid || !email) return res.status(400).json({ error: 'UID and email required' });
    const validRoles = ['DEVELOPER', 'SUPER_ADMIN', 'ADMIN', 'CANTEEN_STAFF'];
    if (role && !validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const { getFirestore } = require('firebase-admin/firestore');
    const adminDb = getFirestore();

    await adminDb.collection('admin_users').doc(uid).set({
      email, name: name || '', role: role || 'ADMIN', active: active !== false,
      updated_at: nowStr(),
    }, { merge: true });

    await req.audit(ACTIONS.EMPLOYEE_UPDATED, 'admin_users', uid, null, { email, role });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete admin user
app.delete('/api/admin/users/:uid', requireAuth, requirePermission('developer:manage'), async (req, res) => {
  try {
    const { uid } = req.params;
    if (!uid) return res.status(400).json({ error: 'UID required' });
    // Prevent deleting yourself
    if (uid === req.user.uid) return res.status(400).json({ error: 'Cannot remove your own account' });

    const { getFirestore } = require('firebase-admin/firestore');
    const adminDb = getFirestore();
    await adminDb.collection('admin_users').doc(uid).delete();

    await req.audit(ACTIONS.EMPLOYEE_DELETED, 'admin_users', uid, null, null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get audit logs
app.get('/api/admin/audit-logs', requireAuth, requirePermission('developer:manage'), async (req, res) => {
  try {
    const { getFirestore } = require('firebase-admin/firestore');
    const adminDb = getFirestore();
    const snap = await adminDb.collection('audit_logs').orderBy('timestamp', 'desc').limit(100).get();
    const logs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  USER AUTHENTICATION & MANAGEMENT
// ═══════════════════════════════════════════════════════════════════

// Simple hash function for passwords (SHA-256)
function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

// Seed default developer account if no users exist
async function seedDefaultDeveloper() {
  try {
    const defaultEmail = 'sattu@developer.com';
    const defaultPw = 'developer@2026';
    // Always ensure developer account exists (even if other users exist)
    const existing = await getDocById(C.users, defaultEmail);
    if (!existing) {
      await setDocData(C.users, defaultEmail, {
        email: defaultEmail,
        name: 'Satu (Developer)',
        password: hashPassword(defaultPw),
        role: 'DEVELOPER',
        status: 'approved',
        active: true,
        createdAt: nowStr(),
        updatedAt: nowStr(),
      });
      console.log(`\n  🛠️  Default developer account created:`);
      console.log(`     Email: ${defaultEmail}`);
      console.log(`     Password: ${defaultPw}`);
      console.log(`     ⚠️  Change this password after first login!\n`);
    } else {
      // Ensure developer account is always approved and active
      if (existing.status !== 'approved' || existing.active === false) {
        await updateDocData(C.users, defaultEmail, {
          status: 'approved',
          active: true,
          role: 'DEVELOPER',
          updatedAt: nowStr(),
        });
        console.log(`  🛠️  Developer account re-activated: ${defaultEmail}`);
      }
    }
  } catch (err) {
    console.error('Seed developer error:', err.message);
  }
}

// ─── User Register ─────────────────────────────────────────
app.post('/api/users/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    if (!email.includes('@')) return res.status(400).json({ error: 'Invalid email format' });

    const emailLower = email.toLowerCase().trim();
    const existing = await getDocById(C.users, emailLower);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    await setDocData(C.users, emailLower, {
      email: emailLower,
      name: (name || '').trim(),
      password: hashPassword(password),
      role: 'ADMIN',
      status: 'pending',
      active: true,
      createdAt: nowStr(),
      updatedAt: nowStr(),
    });

    res.json({ success: true, message: 'Account created! Waiting for developer approval.', status: 'pending' });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─── User Login ────────────────────────────────────────────
app.post('/api/users/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const emailLower = email.toLowerCase().trim();
    const user = await getDocById(C.users, emailLower);
    if (!user) {
      console.log('Login failed: user not found:', emailLower);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Check password
    const hashedInput = hashPassword(password);
    console.log('Login attempt:', emailLower, 'hash match:', hashedInput === user.password);
    if (hashedInput !== user.password) {
      // Fallback: also try plain text comparison for legacy passwords
      if (password === user.password) {
        console.log('Login via plain text match (legacy)');
      } else {
        console.log('Password mismatch. Input hash:', hashedInput, 'Stored hash:', user.password);
        return res.status(401).json({ error: 'Invalid email or password' });
      }
    }

    // Check if active
    if (user.active === false) return res.status(403).json({ error: 'Your account has been paused. Contact developer.', status: 'paused' });

    // Check approval status
    if (user.status !== 'approved') return res.status(403).json({ error: 'Account pending approval. Wait for developer to approve.', status: user.status });

    // Update last login
    await updateDocData(C.users, emailLower, { lastLogin: nowStr(), updatedAt: nowStr() });

    // Return user info (without password)
    const { password: _, ...safeUser } = user;
    res.json({ success: true, user: safeUser });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── User Verify (for auth.js) ─────────────────────────────
app.post('/api/users/verify', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(401).json({ valid: false });

    const emailLower = email.toLowerCase().trim();
    const user = await getDocById(C.users, emailLower);
    if (!user) return res.status(401).json({ valid: false });

    const hashedInput = hashPassword(password);
    if (hashedInput !== user.password) return res.status(401).json({ valid: false });
    if (user.active === false) return res.status(403).json({ valid: false, error: 'Account paused' });
    if (user.status !== 'approved') return res.status(403).json({ valid: false, error: 'Pending approval' });

    const { password: _, ...safeUser } = user;
    res.json({ valid: true, user: safeUser });
  } catch (err) {
    res.status(500).json({ valid: false });
  }
});

// ─── Get pending users (developer only) ────────────────────
app.get('/api/users/pending', async (req, res) => {
  try {
    const users = await getAll(C.users, [{ field: 'status', op: '==', value: 'pending' }]);
    const safeUsers = users.map(({ password, ...u }) => u);
    res.json(safeUsers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get all users (developer only) ────────────────────────
app.get('/api/users/all', async (req, res) => {
  try {
    const users = await getAll(C.users);
    const safeUsers = users.map(({ password, ...u }) => u);
    res.json(safeUsers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Approve user (developer only) ─────────────────────────
app.post('/api/users/approve/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const user = await getDocById(C.users, email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await updateDocData(C.users, email, { status: 'approved', updatedAt: nowStr() });
    res.json({ success: true, message: 'User approved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Reject user (developer only) ──────────────────────────
app.post('/api/users/reject/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const user = await getDocById(C.users, email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await updateDocData(C.users, email, { status: 'rejected', updatedAt: nowStr() });
    res.json({ success: true, message: 'User rejected' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Pause/Resume user (developer only) ────────────────────
app.post('/api/users/pause/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    await updateDocData(C.users, email, { active: false, updatedAt: nowStr() });
    res.json({ success: true, message: 'User paused' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/users/resume/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    await updateDocData(C.users, email, { active: true, updatedAt: nowStr() });
    res.json({ success: true, message: 'User resumed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Delete user (developer only) ──────────────────────────
app.post('/api/users/delete/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const user = await getDocById(C.users, email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'DEVELOPER') return res.status(400).json({ error: 'Cannot delete developer account' });
    await deleteDocData(C.users, email);
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Change user role (developer only) ─────────────────────
app.post('/api/users/role/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const { role } = req.body;
    const validRoles = ['DEVELOPER', 'SUPER_ADMIN', 'ADMIN', 'CANTEEN_STAFF'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });
    await updateDocData(C.users, email, { role, updatedAt: nowStr() });
    res.json({ success: true, message: 'Role updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  SUBSCRIPTION & BILLING (Razorpay Integration)
// ═══════════════════════════════════════════════════════════════════

// Subscription plan config (easy to change later)
const SUBSCRIPTION_PLAN = {
  name: 'Canteen Management Monthly',
  amount: 4999, // ₹4,999 in paise
  currency: 'INR',
  duration: 30, // days
};

// Razorpay config from environment variables
// IMPORTANT: Set these in your Vercel/Hosting environment variables:
//   RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxxx
//   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

// Helper: Make Razorpay API call
async function razorpayAPI(method, endpoint, data = null) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(RAZORPAY_KEY_ID + ':' + RAZORPAY_KEY_SECRET).toString('base64');
    const options = {
      hostname: 'api.razorpay.com',
      path: '/v1' + endpoint,
      method: method,
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Invalid JSON from Razorpay'));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

// Helper: Verify Razorpay payment signature
function verifyRazorpaySignature(orderId, paymentId, signature) {
  if (!RAZORPAY_KEY_SECRET) return false;
  const body = orderId + '|' + paymentId;
  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');
  return expectedSignature === signature;
}

// Helper: Get or create subscription document
async function getSubscription() {
  let sub = await getDocById(C.subscription, 'main');
  if (!sub) {
    // Create default expired subscription
    const defaultSub = {
      status: 'expired',
      planName: SUBSCRIPTION_PLAN.name,
      amount: SUBSCRIPTION_PLAN.amount,
      startDate: '',
      expiryDate: '',
      lastPaymentId: '',
      lastOrderId: '',
      updatedAt: nowStr(),
    };
    await setDocData(C.subscription, 'main', defaultSub);
    sub = { id: 'main', ...defaultSub };
  }
  return sub;
}

// Helper: Check if subscription is active
function isSubscriptionActive(sub) {
  if (!sub || sub.status !== 'active') return false;
  if (!sub.expiryDate) return false;
  const expiry = new Date(sub.expiryDate);
  return expiry > new Date();
}

// ─── Subscription API: Get current status (PUBLIC) ──────────
app.get('/api/subscription', async (_req, res) => {
  try {
    const sub = await getSubscription();
    const active = isSubscriptionActive(sub);
    const now = new Date();
    let daysRemaining = 0;
    if (active && sub.expiryDate) {
      const expiry = new Date(sub.expiryDate);
      daysRemaining = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
    }
    const renewWarning = daysRemaining > 0 && daysRemaining <= 3;
    res.json({
      status: active ? 'active' : 'expired',
      planName: sub.planName || SUBSCRIPTION_PLAN.name,
      amount: sub.amount || SUBSCRIPTION_PLAN.amount,
      startDate: sub.startDate || '',
      expiryDate: sub.expiryDate || '',
      daysRemaining,
      renewWarning,
      monthlyPrice: SUBSCRIPTION_PLAN.amount,
      razorpayKeyId: RAZORPAY_KEY_ID || 'rzp_test_demo',
    });
  } catch (err) {
    console.error('Subscription fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Subscription API: Create Razorpay Order (requires auth) ──
app.post('/api/subscription/create-order', async (req, res) => {
  try {
    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      return res.status(503).json({ error: 'Razorpay not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET environment variables.' });
    }
    const order = await razorpayAPI('POST', '/orders', {
      amount: SUBSCRIPTION_PLAN.amount,
      currency: SUBSCRIPTION_PLAN.currency,
      receipt: 'sub_' + Date.now(),
      notes: { plan: SUBSCRIPTION_PLAN.name },
    });
    if (order.error) {
      return res.status(500).json({ error: order.error.description || 'Failed to create order' });
    }
    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

// ─── Subscription API: Verify Payment & Activate (requires auth) ──
app.post('/api/subscription/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details' });
    }
    // SECURITY: Verify payment signature on server-side
    const isValid = verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    if (!isValid) {
      return res.status(400).json({ error: 'Invalid payment signature. Payment verification failed.' });
    }
    // Payment verified - activate subscription
    const now = new Date();
    const startDate = now.toISOString().substring(0, 10);
    const expiryDate = new Date(now.getTime() + SUBSCRIPTION_PLAN.duration * 24 * 60 * 60 * 1000);
    const expiryDateStr = expiryDate.toISOString().substring(0, 10);
    await setDocData(C.subscription, 'main', {
      status: 'active',
      planName: SUBSCRIPTION_PLAN.name,
      amount: SUBSCRIPTION_PLAN.amount,
      startDate,
      expiryDate: expiryDateStr,
      lastPaymentId: razorpay_payment_id,
      lastOrderId: razorpay_order_id,
      updatedAt: nowStr(),
    });
    // Save payment history
    await addDocData(C.paymentHistory, {
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      amount: SUBSCRIPTION_PLAN.amount,
      status: 'success',
      planName: SUBSCRIPTION_PLAN.name,
      paymentDate: nowStr(),
      createdAt: nowStr(),
    });
    res.json({
      success: true,
      message: `Payment successful! Your subscription is active for the next ${SUBSCRIPTION_PLAN.duration} days.`,
      expiryDate: expiryDateStr,
    });
  } catch (err) {
    console.error('Verify payment error:', err);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

// ─── Subscription API: Get payment history ──────────────────
app.get('/api/subscription/history', async (_req, res) => {
  try {
    const history = await getAll(C.paymentHistory, [], 'createdAt', false);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Subscription API: Check access (middleware helper) ──────
app.get('/api/subscription/check', async (_req, res) => {
  try {
    const sub = await getSubscription();
    const active = isSubscriptionActive(sub);
    res.json({ active, status: active ? 'active' : 'expired' });
  } catch (err) {
    res.status(500).json({ active: true, status: 'error' }); // Fail-open for user experience
  }
});

// ═══════════════════════════════════════════════════════════════════
//  SERVE PAGES
// ═══════════════════════════════════════════════════════════════════
const PUBLIC = path.join(__dirname, '..', 'public');

// ─── Auth page ──────────────────────────────────────────────
app.get('/auth', (_req, res) => res.sendFile(path.join(PUBLIC, 'auth.html')));

// ─── Server-side auth verification endpoint ─────────────────
app.get('/api/auth/verify', requireAuth, (req, res) => {
  res.json({ valid: true, user: { uid: req.user.uid, email: req.user.email, role: req.user.role, name: req.user.name } });
});

// ─── Missing page routes ─────────────────────────────────────
app.get('/entry', (_req, res) => res.sendFile(path.join(PUBLIC, 'entry.html')));
app.get('/emp-records', (_req, res) => res.sendFile(path.join(PUBLIC, 'emp-records.html')));

app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC, 'entry.html')));
app.get('/payment', (_req, res) => res.sendFile(path.join(PUBLIC, 'payment.html')));
app.get('/records', (_req, res) => res.sendFile(path.join(PUBLIC, 'records.html')));
app.get('/records/:empNo', (_req, res) => res.sendFile(path.join(PUBLIC, 'emp-records.html')));
app.get('/settings', (_req, res) => res.sendFile(path.join(PUBLIC, 'settings.html')));
app.get('/pending', (_req, res) => res.sendFile(path.join(PUBLIC, 'pending.html')));
app.get('/online-orders', (_req, res) => res.sendFile(path.join(PUBLIC, 'online-orders.html')));
app.get('/user-ordering', (_req, res) => res.sendFile(path.join(PUBLIC, 'user-ordering.html')));
app.get('/serial-register', (_req, res) => res.sendFile(path.join(PUBLIC, 'serial-register.html')));
app.get('/complaints', (_req, res) => res.sendFile(path.join(PUBLIC, 'complaints.html')));
app.get('/feedback', (_req, res) => res.sendFile(path.join(PUBLIC, 'feedback.html')));
app.get('/developer', (_req, res) => res.sendFile(path.join(PUBLIC, 'developer.html')));
app.get('/subscription', (_req, res) => res.sendFile(path.join(PUBLIC, 'subscription.html')));
app.get('/approval-pending', (_req, res) => res.sendFile(path.join(PUBLIC, 'approval-pending.html')));

// ═══════════════════════════════════════════════════════════════════
//  VERCEL HANDLER + LOCAL DEV
// ═══════════════════════════════════════════════════════════════════
let initialized = false;
const handler = async (req, res) => {
  if (!initialized) {
    try { await loadPrices(); } catch (e) { console.log('Seed prices:', e.message); }
    try { await seedDefaults(); } catch (e) { console.log('Seed defaults:', e.message); }
    try { await seedDefaultDeveloper(); } catch (e) { console.log('Seed developer:', e.message); }
    // Run initial cleanup of old data (older than 1 year)
    cleanupOldData().catch(() => {});
    initialized = true;
  }
  return app(req, res);
};

if (require.main === module) {
  loadPrices().then(() => seedDefaults()).then(() => {
    // Run initial cleanup of old data (older than 1 year)
    cleanupOldData().catch(() => {});
    app.listen(PORT, '0.0.0.0', () => console.log(`🔥 Server running on http://localhost:${PORT}`));
  }).catch(err => console.error('Init error:', err));
}

module.exports = handler;

// ═══════════════════════════════════════════════════════════════════
//  Input Validation & Sanitization Helpers
//  - Validate employee numbers, serial numbers, dates, etc.
//  - Sanitize string inputs to prevent injection
//  - Whitelist allowed fields for each endpoint
// ═══════════════════════════════════════════════════════════════════

// ─── Validators ─────────────────────────────────────────────────

function isValidEmployeeNumber(empNo) {
  const n = parseInt(empNo, 10);
  return Number.isInteger(n) && n >= 1 && n <= 1000;
}

function isValidSerialNumber(sn) {
  const n = parseInt(sn, 10);
  return Number.isInteger(n) && n >= 1 && n <= 1000;
}

function isValidDate(dateStr) {
  return typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}

function isValidMonth(m) {
  const n = parseInt(m, 10);
  return Number.isInteger(n) && n >= 1 && n <= 12;
}

function isValidYear(y) {
  const n = parseInt(y, 10);
  return Number.isInteger(n) && n >= 2020 && n <= 2099;
}

function isValidTime(timeStr) {
  return typeof timeStr === 'string' && /^\d{2}:\d{2}$/.test(timeStr);
}

function isValidOrderStatus(status) {
  return ['pending', 'accepted', 'preparing', 'ready', 'completed', 'cancelled'].includes(status);
}

function isValidComplaintStatus(status) {
  return ['open', 'in_progress', 'resolved', 'closed'].includes(status);
}

// ─── Sanitizers ─────────────────────────────────────────────────

function sanitizeString(str, maxLength = 500) {
  if (typeof str !== 'string') return '';
  // Remove null bytes and trim
  return str.replace(/\0/g, '').trim().substring(0, maxLength);
}

function sanitizePhone(phone) {
  if (typeof phone !== 'string') return '';
  // Allow only digits, spaces, hyphens, plus
  return phone.replace(/[^0-9+\-\s]/g, '').trim().substring(0, 20);
}

function sanitizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase().substring(0, 254);
}

function parsePositiveInt(val, min = 0, max = 9999) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function parsePositiveFloat(val, min = 0, max = 999999) {
  const n = parseFloat(val);
  if (isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

// ─── Field Whitelisting ─────────────────────────────────────────
// Only allow expected fields to be written to the database
// Prevents mass assignment attacks

function pickFields(obj, allowedFields) {
  if (!obj || typeof obj !== 'object') return {};
  const result = {};
  for (const key of allowedFields) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}

function stripUnknownFields(obj, allowedFields) {
  if (!obj || typeof obj !== 'object') return {};
  const cleaned = {};
  for (const key of Object.keys(obj)) {
    if (allowedFields.includes(key)) {
      cleaned[key] = obj[key];
    }
  }
  return cleaned;
}

// ─── Validation Middleware Factories ─────────────────────────────

function validateEntry(req, res, next) {
  const { employee_number, entry_date, tea_qty, breakfast_qty, lunch_qty, dinner_qty, snacks_qty, other_amount } = req.body;

  if (employee_number !== undefined && !isValidEmployeeNumber(employee_number)) {
    return res.status(400).json({ error: 'Invalid employee number (must be 1-1000)' });
  }
  if (entry_date !== undefined && entry_date !== '' && !isValidDate(entry_date)) {
    return res.status(400).json({ error: 'Invalid date format (YYYY-MM-DD)' });
  }

  // Ensure quantities are non-negative integers
  const qtyFields = ['tea_qty', 'breakfast_qty', 'lunch_qty', 'dinner_qty', 'snacks_qty'];
  for (const f of qtyFields) {
    if (req.body[f] !== undefined) {
      req.body[f] = parsePositiveInt(req.body[f], 0, 100);
    }
  }
  if (req.body.other_amount !== undefined) {
    req.body.other_amount = parsePositiveFloat(req.body.other_amount, 0, 9999);
  }
  if (req.body.other_description !== undefined) {
    req.body.other_description = sanitizeString(req.body.other_description, 200);
  }
  if (req.body.night_snack_qty !== undefined) {
    req.body.night_snack_qty = parsePositiveInt(req.body.night_snack_qty, 0, 100);
  }

  next();
}

function validateOrder(req, res, next) {
  const { employeeName, phoneNumber, department, items, totalAmount } = req.body;

  if (!employeeName || typeof employeeName !== 'string' || employeeName.trim().length === 0) {
    return res.status(400).json({ error: 'Employee name is required' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one item is required' });
  }
  if (items.length > 20) {
    return res.status(400).json({ error: 'Too many items (max 20)' });
  }

  // Sanitize fields
  req.body.employeeName = sanitizeString(employeeName, 100);
  req.body.phoneNumber = sanitizePhone(phoneNumber || '');
  req.body.department = sanitizeString(department || '', 100);
  req.body.totalAmount = parsePositiveFloat(totalAmount, 0, 99999);

  // Validate each item
  for (const item of items) {
    if (!item.name || typeof item.name !== 'string') {
      return res.status(400).json({ error: 'Each item must have a valid name' });
    }
    item.name = sanitizeString(item.name, 100);
    item.price = parsePositiveFloat(item.price, 0, 9999);
    item.quantity = parsePositiveInt(item.quantity, 1, 50);
    item.id = item.id ? sanitizeString(String(item.id), 50) : '';
  }

  // Strip any unexpected fields from items
  const allowedItemFields = ['id', 'name', 'price', 'quantity', 'icon'];
  req.body.items = items.map(item => pickFields(item, allowedItemFields));

  next();
}

function validateSerialRegister(req, res, next) {
  const { serial_no, employee_name, phone_number, department, joining_date, leaving_date } = req.body;

  if (serial_no !== undefined && !isValidSerialNumber(serial_no)) {
    return res.status(400).json({ error: 'Invalid serial number (must be 1-1000)' });
  }
  if (employee_name !== undefined) {
    req.body.employee_name = sanitizeString(employee_name, 200);
    if (req.body.employee_name.length === 0 && req.method === 'POST') {
      return res.status(400).json({ error: 'Employee name is required' });
    }
  }
  if (phone_number !== undefined) {
    req.body.phone_number = sanitizePhone(phone_number);
  }
  if (department !== undefined) {
    req.body.department = sanitizeString(department, 200);
  }
  if (joining_date !== undefined && joining_date !== '' && !isValidDate(joining_date)) {
    return res.status(400).json({ error: 'Invalid joining date format' });
  }
  if (leaving_date !== undefined && leaving_date !== '' && !isValidDate(leaving_date)) {
    return res.status(400).json({ error: 'Invalid leaving date format' });
  }

  next();
}

function validatePayment(req, res, next) {
  const { employee_number, month, year, amount_paid, status } = req.body;

  if (employee_number !== undefined && !isValidEmployeeNumber(employee_number)) {
    return res.status(400).json({ error: 'Invalid employee number (must be 1-1000)' });
  }
  if (month !== undefined && !isValidMonth(month)) {
    return res.status(400).json({ error: 'Invalid month (must be 1-12)' });
  }
  if (year !== undefined && !isValidYear(year)) {
    return res.status(400).json({ error: 'Invalid year' });
  }
  if (amount_paid !== undefined) {
    req.body.amount_paid = parsePositiveFloat(amount_paid, 0, 999999);
  }
  if (status !== undefined) {
    const validStatuses = ['paid', 'unpaid', 'partial'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid payment status' });
    }
  }
  if (req.body.note !== undefined) {
    req.body.note = sanitizeString(req.body.note, 500);
  }

  next();
}

function validateMenu(req, res, next) {
  if (req.body.name !== undefined) {
    req.body.name = sanitizeString(req.body.name, 100);
    if (req.body.name.length === 0 && req.method === 'POST') {
      return res.status(400).json({ error: 'Menu item name is required' });
    }
  }
  if (req.body.icon !== undefined) {
    req.body.icon = sanitizeString(req.body.icon, 10);
  }
  if (req.body.price !== undefined) {
    req.body.price = parsePositiveFloat(req.body.price, 0, 9999);
  }
  if (req.body.sort_order !== undefined) {
    req.body.sort_order = parsePositiveInt(req.body.sort_order, 0, 999);
  }

  next();
}

function validateComplaint(req, res, next) {
  if (req.body.subject !== undefined) {
    req.body.subject = sanitizeString(req.body.subject, 200);
  }
  if (req.body.description !== undefined) {
    req.body.description = sanitizeString(req.body.description, 2000);
  }
  if (req.body.employee_name !== undefined) {
    req.body.employee_name = sanitizeString(req.body.employee_name, 200);
  }
  if (req.body.phone_number !== undefined) {
    req.body.phone_number = sanitizePhone(req.body.phone_number);
  }
  if (req.body.department !== undefined) {
    req.body.department = sanitizeString(req.body.department, 200);
  }
  if (req.body.category !== undefined) {
    req.body.category = sanitizeString(req.body.category, 50);
  }
  if (req.body.admin_reply !== undefined) {
    req.body.admin_reply = sanitizeString(req.body.admin_reply, 2000);
  }

  next();
}

// ─── Middleware: Block unexpected fields on sensitive endpoints ───
function blockUnexpectedFields(allowedFields) {
  return (req, res, next) => {
    if (req.body && typeof req.body === 'object') {
      const unexpected = Object.keys(req.body).filter(k => !allowedFields.includes(k));
      if (unexpected.length > 0) {
        // Remove unexpected fields silently
        for (const key of unexpected) {
          delete req.body[key];
        }
      }
    }
    next();
  };
}

module.exports = {
  isValidEmployeeNumber,
  isValidSerialNumber,
  isValidDate,
  isValidMonth,
  isValidYear,
  isValidTime,
  isValidOrderStatus,
  isValidComplaintStatus,
  sanitizeString,
  sanitizePhone,
  sanitizeEmail,
  parsePositiveInt,
  parsePositiveFloat,
  pickFields,
  stripUnknownFields,
  validateEntry,
  validateOrder,
  validateSerialRegister,
  validatePayment,
  validateMenu,
  validateComplaint,
  blockUnexpectedFields,
};

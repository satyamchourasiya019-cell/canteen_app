// ═══════════════════════════════════════════════════════════════════
//  Audit Log System
//  - Records all important admin actions
//  - Immutable (non-editable by normal users)
//  - Stores previous and new values for data changes
// ═══════════════════════════════════════════════════════════════════

let firestore = null;

function initAudit(db) {
  firestore = db;
}

// ─── Audit Action Constants ─────────────────────────────────────
const ACTIONS = {
  // Employee
  EMPLOYEE_CREATED: 'employee_created',
  EMPLOYEE_UPDATED: 'employee_updated',
  EMPLOYEE_DELETED: 'employee_deleted',
  EMPLOYEE_UPLOADED: 'employees_uploaded',

  // Serial Register
  SERIAL_ASSIGNED: 'serial_assigned',
  SERIAL_LEFT: 'serial_left',
  SERIAL_REASSIGNED: 'serial_reassigned',
  SERIAL_UPDATED: 'serial_updated',

  // Menu
  MENU_CREATED: 'menu_created',
  MENU_UPDATED: 'menu_updated',
  MENU_DELETED: 'menu_deleted',

  // Orders
  ORDER_CREATED: 'order_created',
  ORDER_STATUS_CHANGED: 'order_status_changed',
  ORDER_CANCELLED: 'order_cancelled',

  // Payments
  PAYMENT_RECORDED: 'payment_recorded',
  PAYMENT_UPDATED: 'payment_updated',

  // Settings
  PRICES_UPDATED: 'prices_updated',
  PASSWORD_CHANGED: 'password_changed',
  BOOKING_SETTINGS_CHANGED: 'booking_settings_changed',

  // Complaints
  COMPLAINT_CREATED: 'complaint_created',
  COMPLAINT_REPLIED: 'complaint_replied',
  COMPLAINT_STATUS_CHANGED: 'complaint_status_changed',

  // Auth
  ADMIN_LOGIN: 'admin_login',
  ADMIN_LOGIN_FAILED: 'admin_login_failed',

  // System
  DATA_EXPORTED: 'data_exported',
  SETTINGS_VIEWED: 'settings_viewed',
};

// ─── Log an audit event ─────────────────────────────────────────
async function logAudit({
  user_id = '',
  user_email = '',
  user_name = '',
  action = '',
  resource_type = '',
  resource_id = '',
  previous_value = null,
  new_value = null,
  ip_address = '',
  user_agent = '',
  metadata = {},
} = {}) {
  if (!firestore) {
    console.warn('Audit log skipped: Firestore not initialized');
    return;
  }

  try {
    const entry = {
      user_id: String(user_id).substring(0, 128),
      user_email: String(user_email).substring(0, 254),
      user_name: String(user_name).substring(0, 200),
      action: String(action),
      resource_type: String(resource_type),
      resource_id: String(resource_id).substring(0, 200),
      previous_value: previous_value || null,
      new_value: new_value || null,
      ip_address: String(ip_address).substring(0, 45),
      user_agent: String(user_agent).substring(0, 500),
      metadata: metadata || {},
      timestamp: (() => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')} ${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')}:${String(n.getSeconds()).padStart(2,'0')}`; })(),
    };

    await firestore.collection('audit_logs').add(entry);
  } catch (err) {
    // Audit logging should never crash the main operation
    console.error('Audit log error:', err.message);
  }
}

// ─── Helper: Get user info from request ──────────────────────────
function getUserInfo(req) {
  if (!req.user) return {};
  return {
    user_id: req.user.uid || '',
    user_email: req.user.email || '',
    user_name: req.user.name || '',
    ip_address: req.ip || req.connection?.remoteAddress || '',
    user_agent: req.headers['user-agent'] || '',
  };
}

// ─── Express middleware: Attach audit logger to request ──────────
function auditMiddleware(req, res, next) {
  req.audit = async (action, resourceType, resourceId, prevVal, newVal, metadata = {}) => {
    await logAudit({
      ...getUserInfo(req),
      action,
      resource_type: resourceType,
      resource_id: String(resourceId),
      previous_value: prevVal,
      new_value: newVal,
      metadata,
    });
  };
  next();
}

module.exports = {
  initAudit,
  logAudit,
  getUserInfo,
  auditMiddleware,
  ACTIONS,
};

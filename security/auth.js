// ═══════════════════════════════════════════════════════════════════
//  Firebase Admin SDK + Auth Middleware
//  - Token verification (Firebase ID tokens)
//  - Role-based access control (RBAC)
//  - Session validation
// ═══════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');

// ─── Initialize Firebase Admin SDK ──────────────────────────────
let adminInitialized = false;

function initFirebaseAdmin() {
  if (adminInitialized) return;
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: process.env.FIREBASE_PROJECT_ID || 'canteen-app-bbaf5',
      });
    } else {
      // Local development: use project ID only (ADC or emulator)
      admin.initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID || 'canteen-app-bbaf5',
      });
    }
    adminInitialized = true;
    console.log('✅ Firebase Admin SDK initialized');
  } catch (err) {
    console.error('⚠️ Firebase Admin SDK init failed:', err.message);
    console.log('   Auth middleware will deny all admin requests until configured.');
  }
}

// ─── Role Definitions ───────────────────────────────────────────
const ROLES = {
  DEVELOPER: {
    permissions: [
      'employees:read', 'employees:write', 'employees:delete',
      'serial:read', 'serial:write', 'serial:history',
      'menu:read', 'menu:write', 'menu:delete',
      'orders:read', 'orders:write', 'orders:cancel',
      'payments:read', 'payments:write',
      'settings:read', 'settings:write',
      'reports:read', 'reports:export',
      'complaints:read', 'complaints:write',
      'audit:read', 'users:manage', 'booking:write',
      'developer:manage', 'developer:panel',
    ],
  },
  SUPER_ADMIN: {
    permissions: [
      'employees:read', 'employees:write', 'employees:delete',
      'serial:read', 'serial:write', 'serial:history',
      'menu:read', 'menu:write', 'menu:delete',
      'orders:read', 'orders:write', 'orders:cancel',
      'payments:read', 'payments:write',
      'settings:read', 'settings:write',
      'reports:read', 'reports:export',
      'complaints:read', 'complaints:write',
      'audit:read', 'users:manage', 'booking:write',
    ],
  },
  ADMIN: {
    permissions: [
      'employees:read', 'employees:write',
      'serial:read', 'serial:write',
      'menu:read', 'menu:write',
      'orders:read', 'orders:write',
      'payments:read', 'payments:write',
      'reports:read', 'reports:export',
      'complaints:read', 'complaints:write',
      'booking:write',
    ],
  },
  CANTEEN_STAFF: {
    permissions: [
      'orders:read', 'orders:write',
      'menu:read',
      'complaints:read',
    ],
  },
};

// ─── Middleware: Verify Firebase ID Token ────────────────────────
function requireAuth(req, res, next) {
  if (!adminInitialized) {
    return res.status(503).json({ error: 'Authentication service unavailable' });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  if (!idToken) {
    return res.status(401).json({ error: 'Invalid authentication token' });
  }

  admin.auth().verifyIdToken(idToken)
    .then(async (decodedToken) => {
      req.user = {
        uid: decodedToken.uid,
        email: decodedToken.email || '',
        email_verified: decodedToken.email_verified || false,
      };

      // Look up admin user record for role
      try {
        const { getFirestore } = require('firebase-admin/firestore');
        const db = getFirestore();
        const userDoc = await db.collection('admin_users').doc(decodedToken.uid).get();

        if (!userDoc.exists) {
          return res.status(403).json({ error: 'User not authorized as admin' });
        }

        const userData = userDoc.data();
        if (userData.active === false) {
          return res.status(403).json({ error: 'Admin account is deactivated' });
        }

        req.user.role = userData.role || 'CANTEEN_STAFF';
        req.user.name = userData.name || '';
        req.user.permissions = ROLES[req.user.role]?.permissions || [];

        next();
      } catch (dbErr) {
        console.error('Auth lookup error:', dbErr.message);
        return res.status(500).json({ error: 'Authentication lookup failed' });
      }
    })
    .catch((err) => {
      console.error('Token verification failed:', err.message);
      return res.status(401).json({ error: 'Invalid or expired authentication token' });
    });
}

// ─── Middleware: Require specific permission ─────────────────────
function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.user || !req.user.permissions) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const hasPermission = permissions.some(p => req.user.permissions.includes(p));
    if (!hasPermission) {
      return res.status(403).json({ error: 'Insufficient permissions for this action' });
    }

    next();
  };
}

// ─── Middleware: Require specific role (minimum level) ───────────
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient role level' });
    }
    next();
  };
}

// ─── Utility: Get admin Firestore instance ──────────────────────
function getAdminFirestore() {
  if (!adminInitialized) throw new Error('Firebase Admin not initialized');
  return getFirestore();
}

module.exports = {
  initFirebaseAdmin,
  requireAuth,
  requirePermission,
  requireRole,
  getAdminFirestore,
  ROLES,
  admin,
};

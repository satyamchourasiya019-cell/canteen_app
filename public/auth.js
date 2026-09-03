// ═══════════════════════════════════════════════════════════════════
//  Auth.js - Frontend Auth Helper
//  - Wraps all fetch() calls with Bearer token
//  - Manages session (auto-refresh, timeout, logout)
//  - Redirects unauthenticated users to /auth
//  - Attach to every admin page via <script src="/auth.js"></script>
// ═══════════════════════════════════════════════════════════════════
(function () {
  // ─── Config ──────────────────────────────────────────────────
  const SESSION_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours max session
  const REFRESH_INTERVAL_MS = 30 * 60 * 1000;    // Refresh token every 30 min
  const AUTH_PAGE = '/auth';

  // ─── Firebase Config ────────────────────────────────────────
  const firebaseConfig = {
    apiKey: "AIzaSyCqiJDd9mijLa3AV3S7JgyLlkkoCODFlJk",
    authDomain: "canteen-app-bbaf5.firebaseapp.com",
    projectId: "canteen-app-bbaf5",
    storageBucket: "canteen-app-bbaf5.firebasestorage.app",
    messagingSenderId: "793607116131",
    appId: "1:793607116131:web:0097a1db298778fa43af56",
  };

  // ─── Initialize Firebase if not already ──────────────────────
  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }
  const auth = firebase.auth();

  // ─── State ──────────────────────────────────────────────────
  let currentToken = localStorage.getItem('fbAuthToken') || null;
  let sessionTimer = null;
  let refreshTimer = null;
  let loginTime = parseInt(localStorage.getItem('fbLoginTime') || '0', 10);

  // ─── Helper: Get current token (fresh) ──────────────────────
  async function getToken() {
    try {
      const user = auth.currentUser;
      if (user) {
        const token = await user.getIdToken(true);
        currentToken = token;
        localStorage.setItem('fbAuthToken', token);
        return token;
      }
    } catch (err) {
      console.error('Token refresh failed:', err);
    }
    return currentToken;
  }

  // ─── Helper: Get stored user info ───────────────────────────
  function getUser() {
    try {
      return JSON.parse(localStorage.getItem('fbUser') || 'null');
    } catch { return null; }
  }

  // ─── Helper: Logout ─────────────────────────────────────────
  function logout() {
    auth.signOut().catch(() => {});
    localStorage.removeItem('fbAuthToken');
    localStorage.removeItem('fbUser');
    localStorage.removeItem('fbLoginTime');
    currentToken = null;
    clearInterval(sessionTimer);
    clearInterval(refreshTimer);
    window.location.href = AUTH_PAGE;
  }

  // ─── Helper: Check session timeout ──────────────────────────
  function checkSession() {
    if (loginTime && Date.now() - loginTime > SESSION_TIMEOUT_MS) {
      logout();
    }
  }

  // ─── Wrap fetch with auth headers ───────────────────────────
  const originalFetch = window.fetch;
  window.fetch = async function (url, options = {}) {
    // Get the token (try to refresh if stale)
    let token = currentToken;
    try {
      const user = auth.currentUser;
      if (user) {
        token = await user.getIdToken(false);
        currentToken = token;
        localStorage.setItem('fbAuthToken', token);
      }
    } catch (e) {
      // Use stored token as fallback
    }

    // Add auth header to all requests
    if (token) {
      options.headers = options.headers || {};
      if (typeof options.headers === 'Headers') {
        options.headers.set('Authorization', 'Bearer ' + token);
      } else {
        options.headers['Authorization'] = 'Bearer ' + token;
      }
    }

    try {
      const response = await originalFetch(url, options);

      // If 401, redirect to auth
      if (response.status === 401) {
        const clone = response.clone();
        try {
          const body = await clone.json();
          if (body.error === 'Authentication required' || body.error === 'Invalid or expired authentication token') {
            logout();
            return response;
          }
        } catch {}
      }

      return response;
    } catch (err) {
      throw err;
    }
  };

  // ─── Auth State Change Handler ──────────────────────────────
  auth.onAuthStateChanged(async (user) => {
    if (!user) {
      // Not logged in - redirect to auth page
      // But allow public pages (user-ordering) to work without auth
      const path = window.location.pathname.toLowerCase();
      const publicPages = ['/user-ordering', '/auth'];
      const isPublicPage = publicPages.some(p => path === p || path === p + '.html');

      if (!isPublicPage) {
        window.location.href = AUTH_PAGE;
      }
      return;
    }

    // User is logged in - verify they're an authorized admin
    try {
      const token = await user.getIdToken(true);
      currentToken = token;
      localStorage.setItem('fbAuthToken', token);

      // Check admin_users collection
      const db = firebase.firestore();
      const userDoc = await db.collection('admin_users').doc(user.uid).get();

      if (!userDoc.exists) {
        // Not an admin - sign out
        await auth.signOut();
        localStorage.removeItem('fbAuthToken');
        localStorage.removeItem('fbUser');
        window.location.href = AUTH_PAGE;
        return;
      }

      const userData = userDoc.data();
      if (userData.active === false) {
        await auth.signOut();
        localStorage.removeItem('fbAuthToken');
        localStorage.removeItem('fbUser');
        alert('Your admin account has been deactivated.');
        window.location.href = AUTH_PAGE;
        return;
      }

      // Store user info
      localStorage.setItem('fbUser', JSON.stringify({
        uid: user.uid,
        email: user.email,
        role: userData.role,
        name: userData.name,
      }));

      // Set session start time
      if (!loginTime) {
        loginTime = Date.now();
        localStorage.setItem('fbLoginTime', String(loginTime));
      }

      // Start session timer
      checkSession();
      clearInterval(sessionTimer);
      sessionTimer = setInterval(checkSession, 60 * 1000);

      // Start token refresh timer
      clearInterval(refreshTimer);
      refreshTimer = setInterval(async () => {
        try {
          const freshToken = await user.getIdToken(true);
          currentToken = freshToken;
          localStorage.setItem('fbAuthToken', freshToken);
        } catch (e) {
          console.warn('Auto-refresh token failed:', e);
        }
      }, REFRESH_INTERVAL_MS);

    } catch (err) {
      console.error('Auth verification failed:', err);
    }
  });

  // ─── Expose globals ─────────────────────────────────────────    window.CanteenAuth = {
    getToken,
    getUser,
    logout,
    isAdmin: () => {
      const user = getUser();
      return user && ['DEVELOPER', 'SUPER_ADMIN', 'ADMIN', 'CANTEEN_STAFF'].includes(user.role);
    },
    hasRole: (role) => {
      const user = getUser();
      return user && user.role === role;
    },
    hasPermission: (permission) => {
      const user = getUser();
      if (!user) return false;
      const roleHierarchy = {
        DEVELOPER: ['employees:read','employees:write','employees:delete','serial:read','serial:write','serial:history','menu:read','menu:write','menu:delete','orders:read','orders:write','orders:cancel','payments:read','payments:write','settings:read','settings:write','reports:read','reports:export','complaints:read','complaints:write','audit:read','users:manage','booking:write','developer:manage','developer:panel'],
        SUPER_ADMIN: ['employees:read','employees:write','employees:delete','serial:read','serial:write','serial:history','menu:read','menu:write','menu:delete','orders:read','orders:write','orders:cancel','payments:read','payments:write','settings:read','settings:write','reports:read','reports:export','complaints:read','complaints:write','audit:read','users:manage','booking:write'],
        ADMIN: ['employees:read','employees:write','serial:read','serial:write','menu:read','menu:write','orders:read','orders:write','payments:read','payments:write','reports:read','reports:export','complaints:read','complaints:write','booking:write'],
        CANTEEN_STAFF: ['orders:read','orders:write','menu:read','complaints:read'],
      };
      return (roleHierarchy[user.role] || []).includes(permission);
    },
  };
})();

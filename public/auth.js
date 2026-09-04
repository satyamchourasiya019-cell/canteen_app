// ═══════════════════════════════════════════════════════════════════
//  Auth.js - Frontend Auth Helper (Email + Password based)
//  - Wraps all fetch() calls with auth headers
//  - Manages session (timeout, logout)
//  - Redirects unauthenticated users to /auth
//  - Attach to every admin page via <script src="/auth.js"></script>
// ═══════════════════════════════════════════════════════════════════
(function () {
  const SESSION_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours max session
  const AUTH_PAGE = '/auth';

  let adminEmail = localStorage.getItem('adminEmail') || null;
  let adminPassword = localStorage.getItem('adminPassword') || null;
  let adminUser = null;
  try { adminUser = JSON.parse(localStorage.getItem('adminUser') || 'null'); } catch(e) {}
  let loginTime = parseInt(localStorage.getItem('adminLoginTime') || '0', 10);
  let _isLoggingOut = false; // Prevent multiple logout calls

  // ─── Helper: Get stored password ─────────────────────────────
  function getPassword() { return adminPassword; }
  function getEmail() { return adminEmail; }

  // ─── Helper: Get stored user info ────────────────────────────
  function getUser() { return adminUser || { role: 'ADMIN', name: 'Admin', email: adminEmail || '' }; }

  // ─── Helper: Logout ──────────────────────────────────────────
  function logout() {
    if (_isLoggingOut) return;
    _isLoggingOut = true;
    adminEmail = null;
    adminPassword = null;
    adminUser = null;
    localStorage.removeItem('adminEmail');
    localStorage.removeItem('adminPassword');
    localStorage.removeItem('adminLoginTime');
    localStorage.removeItem('adminUser');
    window.location.href = AUTH_PAGE;
  }

  // ─── Helper: Check session timeout ──────────────────────────
  function checkSession() {
    if (loginTime && Date.now() - loginTime > SESSION_TIMEOUT_MS) logout();
  }

  // ─── Wrap fetch with auth headers ───────────────────────────
  const originalFetch = window.fetch;
  window.fetch = async function (url, options = {}) {
    // Add auth headers to all requests
    if (adminEmail && adminPassword) {
      options.headers = options.headers || {};
      if (typeof options.headers === 'Headers') {
        options.headers.set('X-Admin-Email', adminEmail);
        options.headers.set('X-Admin-Password', adminPassword);
      } else {
        options.headers['X-Admin-Email'] = adminEmail;
        options.headers['X-Admin-Password'] = adminPassword;
      }
    }

    try {
      const response = await originalFetch(url, options);
      // Only auto-logout on 401 for API calls that require auth
      // Do NOT auto-logout during page load to prevent logout loops
      if (response.status === 401 && !_isLoggingOut) {
        const urlStr = String(url);
        // Skip auto-logout for auth-related endpoints and during initial page load
        const skipAutoLogout = urlStr.includes('/api/users/verify') ||
                               urlStr.includes('/api/password/verify') ||
                               urlStr.includes('/api/users/login') ||
                               urlStr.includes('/api/password/default');
        if (!skipAutoLogout) {
          const clone = response.clone();
          try {
            const body = await clone.json();
            if (body.error === 'Authentication required' || body.error === 'Invalid password' || body.error === 'Invalid email or password') {
              // Don't logout immediately - mark session as invalid
              // The next navigation will redirect to auth
              console.warn('⚠️ Auth check failed for:', urlStr, body.error);
              // Only logout if this is a clearly protected API call
              if (urlStr.includes('/api/')) {
                logout();
              }
            }
          } catch {}
        }
      }
      return response;
    } catch (err) {
      throw err;
    }
  };

  // ─── Check auth on page load ────────────────────────────────
  if (adminEmail && adminPassword) {
    // Trust stored credentials - don't verify on every page load
    // This prevents the logout loop caused by race conditions
    checkSession();
    setInterval(checkSession, 60 * 1000);

    // Background verify (non-blocking, doesn't affect page load)
    fetch('/api/users/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    }).then(r => r.json()).then(data => {
      if (data.valid) {
        // Update user info if available
        if (data.user) {
          adminUser = data.user;
          localStorage.setItem('adminUser', JSON.stringify(data.user));
        }
      }
      // Even if verify fails, keep the session alive
      // User can continue using the app
      // Session will expire naturally after timeout
    }).catch(() => {
      // Network error - keep session alive
      console.log('ℹ️ Background auth check failed (network), session kept alive');
    });
  } else {
    // Not logged in - check if this is a public page
    const path = window.location.pathname.toLowerCase();
    const publicPages = ['/user-ordering', '/auth', '/feedback', '/subscription', '/approval-pending', '/qr-links'];
    const isPublicPage = publicPages.some(p => path === p || path === p + '.html');

    if (!isPublicPage) {
      window.location.href = AUTH_PAGE;
    }
  }

  // ─── Expose globals ──────────────────────────────────────────
  window.CanteenAuth = {
    getToken: () => adminPassword,
    getEmail: () => adminEmail,
    getUser,
    logout,
    isAdmin: () => !!adminEmail && !!adminPassword,
    hasRole: (role) => {
      const user = getUser();
      return user && user.role === role;
    },
    hasPermission: () => true,
  };
})();

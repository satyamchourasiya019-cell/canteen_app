// ═══════════════════════════════════════════════════════════════════
//  Auth.js - Frontend Auth Helper (Password-based)
//  - Wraps all fetch() calls with X-Admin-Password header
//  - Manages session (timeout, logout)
//  - Redirects unauthenticated users to /auth
//  - Attach to every admin page via <script src="/auth.js"></script>
// ═══════════════════════════════════════════════════════════════════
(function () {
  const SESSION_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours max session
  const AUTH_PAGE = '/auth';

  let adminPassword = localStorage.getItem('adminPassword') || null;
  let loginTime = parseInt(localStorage.getItem('adminLoginTime') || '0', 10);

  // ─── Helper: Get stored password ─────────────────────────────
  function getPassword() {
    return adminPassword;
  }

  // ─── Helper: Get stored user info ────────────────────────────
  function getUser() {
    return { role: 'ADMIN', name: 'Admin' };
  }

  // ─── Helper: Logout ──────────────────────────────────────────
  function logout() {
    adminPassword = null;
    localStorage.removeItem('adminPassword');
    localStorage.removeItem('adminLoginTime');
    window.location.href = AUTH_PAGE;
  }

  // ─── Helper: Check session timeout ──────────────────────────
  function checkSession() {
    if (loginTime && Date.now() - loginTime > SESSION_TIMEOUT_MS) {
      logout();
    }
  }

  // ─── Wrap fetch with password auth headers ───────────────────
  const originalFetch = window.fetch;
  window.fetch = async function (url, options = {}) {
    // Add password header to all requests
    if (adminPassword) {
      options.headers = options.headers || {};
      if (typeof options.headers === 'Headers') {
        options.headers.set('X-Admin-Password', adminPassword);
      } else {
        options.headers['X-Admin-Password'] = adminPassword;
      }
    }

    try {
      const response = await originalFetch(url, options);

      // If 401, redirect to auth
      if (response.status === 401) {
        const clone = response.clone();
        try {
          const body = await clone.json();
          if (body.error === 'Authentication required' || body.error === 'Invalid password') {
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

  // ─── Check auth on page load ────────────────────────────────
  if (adminPassword) {
    // Verify password is still valid
    fetch('/api/password/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: adminPassword }),
    }).then(r => r.json()).then(data => {
      if (!data.valid) {
        logout();
        return;
      }
      // Start session timer
      checkSession();
      setInterval(checkSession, 60 * 1000);
    }).catch(() => {
      // Network error - allow continued use
      checkSession();
      setInterval(checkSession, 60 * 1000);
    });
  } else {
    // Not logged in - check if this is a public page
    const path = window.location.pathname.toLowerCase();
    const publicPages = ['/user-ordering', '/auth', '/feedback', '/subscription'];
    const isPublicPage = publicPages.some(p => path === p || path === p + '.html');

    if (!isPublicPage) {
      window.location.href = AUTH_PAGE;
    }
  }

  // ─── Expose globals ──────────────────────────────────────────
  window.CanteenAuth = {
    getToken: () => adminPassword,
    getUser,
    logout,
    isAdmin: () => !!adminPassword,
    hasRole: () => true,
    hasPermission: () => true,
  };
})();

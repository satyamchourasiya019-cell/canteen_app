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

  // ─── Helper: Get stored password ─────────────────────────────
  function getPassword() { return adminPassword; }
  function getEmail() { return adminEmail; }

  // ─── Helper: Get stored user info ────────────────────────────
  function getUser() { return adminUser || { role: 'ADMIN', name: 'Admin', email: adminEmail || '' }; }

  // ─── Helper: Logout ──────────────────────────────────────────
  function logout() {
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
      // If 401, redirect to auth
      if (response.status === 401) {
        const clone = response.clone();
        try {
          const body = await clone.json();
          if (body.error === 'Authentication required' || body.error === 'Invalid password' || body.error === 'Invalid email or password') {
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
  if (adminEmail && adminPassword) {
    // Verify credentials are still valid
    fetch('/api/users/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: adminEmail, password: adminPassword }),
    }).then(r => r.json()).then(data => {
      if (!data.valid) {
        logout();
        return;
      }
      // Update user info if available
      if (data.user) {
        adminUser = data.user;
        localStorage.setItem('adminUser', JSON.stringify(data.user));
      }
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

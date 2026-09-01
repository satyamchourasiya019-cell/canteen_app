// ═══════════════════════════════════════════════════════════════════
//  GLOBAL NOTIFICATION SYSTEM for Online Orders
//  Include this script on any page to get real-time order alerts
// ═══════════════════════════════════════════════════════════════════
(function() {
  // ─── Create notification popup HTML ────────────────────────────
  const notifCSS = document.createElement('style');
  notifCSS.textContent = `
    .order-notif-bar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
      background: linear-gradient(135deg, #059669 0%, #10b981 100%);
      color: #fff; padding: 16px 20px; display: flex; align-items: center;
      gap: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      transform: translateY(-100%); transition: transform 0.4s cubic-bezier(0.34,1.56,0.64,1);
      font-family: 'Segoe UI', system-ui, sans-serif; cursor: pointer;
    }
    .order-notif-bar.show { transform: translateY(0); }
    .order-notif-bar .notif-icon { font-size: 2rem; flex-shrink: 0; }
    .order-notif-bar .notif-body { flex: 1; }
    .order-notif-bar .notif-title { font-size: 1rem; font-weight: 800; }
    .order-notif-bar .notif-detail { font-size: 0.85rem; opacity: 0.9; margin-top: 2px; }
    .order-notif-bar .notif-close {
      background: rgba(255,255,255,0.2); border: none; color: #fff;
      width: 32px; height: 32px; border-radius: 50%; font-size: 1.2rem;
      cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
    }
    .order-notif-bar .notif-count {
      background: #fff; color: #059669; font-weight: 900; font-size: 0.8rem;
      padding: 2px 8px; border-radius: 10px; flex-shrink: 0;
    }
  `;
  document.head.appendChild(notifCSS);

  // ─── Create popup element ──────────────────────────────────────
  const popup = document.createElement('div');
  popup.className = 'order-notif-bar';
  popup.innerHTML = `
    <span class="notif-icon">🔔</span>
    <div class="notif-body">
      <div class="notif-title" id="notifTitle">New Order Received!</div>
      <div class="notif-detail" id="notifDetail">Loading...</div>
    </div>
    <span class="notif-count" id="notifCount"></span>
    <button class="notif-close" onclick="window._closeNotif()">✕</button>
  `;
  document.body.appendChild(popup);

  let notifTimeout = null;
  let orderCount = 0;

  window._closeNotif = function() {
    popup.classList.remove('show');
    if (notifTimeout) clearTimeout(notifTimeout);
  };

  function showNotification(order) {
    orderCount++;
    const items = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []);
    const itemList = items.map(i => i.name || i).join(', ');
    
    document.getElementById('notifTitle').textContent = `🔔 New Order: ${order.order_id}`;
    document.getElementById('notifDetail').textContent = `${order.employee_name} — ${itemList || 'Order placed'} (₹${order.total_amount || 0})`;
    document.getElementById('notifCount').textContent = orderCount;
    
    popup.classList.add('show');
    if (notifTimeout) clearTimeout(notifTimeout);
    notifTimeout = setTimeout(() => popup.classList.remove('show'), 8000);
  }

  // ─── Play notification sound ───────────────────────────────────
  function playNotifSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Happy notification ding
      const notes = [523.25, 659.25, 783.99]; // C5, E5, G5
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.15);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + i * 0.15 + 0.3);
        osc.start(ctx.currentTime + i * 0.15);
        osc.stop(ctx.currentTime + i * 0.15 + 0.3);
      });
    } catch (e) {}
  }

  // ─── Connect to SSE stream ─────────────────────────────────────
  let eventSource = null;
  let reconnectTimer = null;

  function connectSSE() {
    if (eventSource) { try { eventSource.close(); } catch(e) {} }
    eventSource = new EventSource('/api/orders/stream');
    
    eventSource.addEventListener('connected', function() {
      console.log('🔔 Notification system connected');
    });
    
    eventSource.addEventListener('new-order', function(e) {
      try {
        const order = JSON.parse(e.data);
        playNotifSound();
        showNotification(order);
      } catch (err) {}
    });
    
    eventSource.addEventListener('status-update', function(e) {
      try {
        const order = JSON.parse(e.data);
        // Update badge count on online-orders page
        const badge = document.getElementById('orderBadge');
        if (badge && order.status === 'pending') {
          badge.textContent = parseInt(badge.textContent || '0') + 1;
          badge.style.display = 'flex';
        }
      } catch (err) {}
    });
    
    eventSource.onerror = function() {
      if (eventSource) eventSource.close();
      // Reconnect after 3 seconds
      reconnectTimer = setTimeout(connectSSE, 3000);
    };
  }

  // ─── Also poll for new orders every 30s as backup ──────────────
  let lastPollCount = 0;
  async function pollOrders() {
    try {
      const today = new Date().toISOString().substring(0, 10);
      const res = await fetch(`/api/orders/stats?date=${today}`);
      const stats = await res.json();
      if (stats.pending > lastPollCount && lastPollCount > 0) {
        // New order detected via polling
        playNotifSound();
        document.getElementById('notifTitle').textContent = '🔔 New Order Received!';
        document.getElementById('notifDetail').textContent = `${stats.pending} pending orders today`;
        document.getElementById('notifCount').textContent = stats.pending;
        popup.classList.add('show');
        if (notifTimeout) clearTimeout(notifTimeout);
        notifTimeout = setTimeout(() => popup.classList.remove('show'), 8000);
      }
      lastPollCount = stats.pending;
    } catch (e) {}
  }

  // ─── Init ──────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function() {
    connectSSE();
    setInterval(pollOrders, 30000);
    pollOrders();
  });

  // If DOM already loaded
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    connectSSE();
    setInterval(pollOrders, 30000);
  }

  // ─── Request notification permission (for browser notifications) ──
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  // Also send browser notification
  window._sendBrowserNotif = function(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/logo.svg', badge: '/logo.svg' });
    }
  };
})();

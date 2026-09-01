// ═══════════════════════════════════════════════════════════════════
//  BEAUTIFUL DATE + LIVE CLOCK BANNER
//  Include this on any page - replaces #dateBanner with live clock
// ═══════════════════════════════════════════════════════════════════
(function() {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const shortDays = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  // Add styles
  const css = document.createElement('style');
  css.textContent = `
    .date-banner {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: #fff;
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
      box-shadow: 0 4px 15px rgba(102, 126, 234, 0.3);
      position: relative;
      overflow: hidden;
    }
    .date-banner::before {
      content: '';
      position: absolute;
      top: -50%;
      right: -10%;
      width: 200px;
      height: 200px;
      background: rgba(255,255,255,0.08);
      border-radius: 50%;
    }
    .date-banner::after {
      content: '';
      position: absolute;
      bottom: -60%;
      left: -5%;
      width: 150px;
      height: 150px;
      background: rgba(255,255,255,0.05);
      border-radius: 50%;
    }
    .db-left {
      display: flex;
      align-items: center;
      gap: 12px;
      z-index: 1;
    }
    .db-day-icon {
      font-size: 2.2rem;
      filter: drop-shadow(0 2px 4px rgba(0,0,0,0.2));
    }
    .db-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .db-day-name {
      font-size: 0.85rem;
      font-weight: 600;
      opacity: 0.85;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .db-date {
      font-size: 1.15rem;
      font-weight: 800;
      text-shadow: 0 1px 3px rgba(0,0,0,0.15);
    }
    .db-right {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 2px;
      z-index: 1;
    }
    .db-clock {
      font-size: 1.8rem;
      font-weight: 900;
      font-variant-numeric: tabular-nums;
      letter-spacing: 2px;
      text-shadow: 0 2px 6px rgba(0,0,0,0.2);
      background: rgba(255,255,255,0.15);
      padding: 4px 16px;
      border-radius: 10px;
      backdrop-filter: blur(4px);
    }
    .db-clock-sec {
      font-size: 0.9rem;
      font-weight: 600;
      opacity: 0.7;
      font-variant-numeric: tabular-nums;
    }
  `;
  document.head.appendChild(css);

  function getDayEmoji(d) {
    const emojis = ['😴','💼','💼','💼','💼','💼','🎉'];
    return emojis[d.getDay()];
  }

  function updateBanner() {
    const banner = document.getElementById('dateBanner');
    if (!banner) return;

    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    const dayEmoji = getDayEmoji(now);

    banner.innerHTML = \`
      <div class="db-left">
        <span class="db-day-icon">\${dayEmoji}</span>
        <div class="db-info">
          <span class="db-day-name">\${days[now.getDay()]}</span>
          <span class="db-date">\${now.getDate()} \${months[now.getMonth()]} \${now.getFullYear()}</span>
        </div>
      </div>
      <div class="db-right">
        <div class="db-clock">\${h}:\${m}:\${s}</div>
        <span class="db-clock-sec">\${shortDays[now.getDay()]} • Week \${Math.ceil(now.getDate() / 7)}</span>
      </div>
    \`;
  }

  updateBanner();
  setInterval(updateBanner, 1000);
})();

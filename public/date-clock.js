// Date + Live Clock - no CSS conflicts
(function() {
  function updateClock() {
    var el = document.getElementById('dateBanner');
    if (!el) return;
    var now = new Date();
    var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var emojis = ['😴','💼','💼','💼','💼','💼','🎉'];
    var h = String(now.getHours()).padStart(2,'0');
    var m = String(now.getMinutes()).padStart(2,'0');
    var s = String(now.getSeconds()).padStart(2,'0');
    el.style.cssText = 'background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:#fff;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;border-radius:0;box-shadow:0 2px 10px rgba(102,126,234,0.3);';
    el.innerHTML = '<div style="display:flex;align-items:center;gap:12px;"><span style="font-size:2rem;">' + emojis[now.getDay()] + '</span><div><div style="font-size:0.8rem;font-weight:600;opacity:0.85;text-transform:uppercase;letter-spacing:1px;">' + days[now.getDay()] + '</div><div style="font-size:1.1rem;font-weight:800;">' + now.getDate() + ' ' + months[now.getMonth()] + ' ' + now.getFullYear() + '</div></div></div><div style="text-align:right;"><div style="font-size:1.8rem;font-weight:900;font-variant-numeric:tabular-nums;letter-spacing:2px;background:rgba(255,255,255,0.15);padding:4px 16px;border-radius:10px;">' + h + ':' + m + ':' + s + '</div><div style="font-size:0.75rem;opacity:0.7;margin-top:2px;">Week ' + Math.ceil(now.getDate()/7) + '</div></div>';
  }
  updateClock();
  setInterval(updateClock, 1000);
})();

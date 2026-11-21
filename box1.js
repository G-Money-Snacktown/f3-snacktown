/* ============================================================
   F3 Snacktown - Regional Data Box 1 (7 stats), front end  box1.js
   Draws the 7 stats into a slot on the PAX > Region Stats tab.
   Reads /.netlify/functions/bq-region-box1. No secrets in this file.
   Uses the site's own colors and fonts (CSS variables from index.html).
   ============================================================ */
(function () {
  'use strict';

  var API = '/.netlify/functions/bq-region-box1';
  var BUSY = 'Region stats are updating, try again soon.';
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  var ROWS = [
    ['Total Workouts', 'total_workouts'],
    ['Total Posts',    'total_posts'],
    ['Active PAX',     'active_pax'],
    ['Unique Qs',      'unique_qs'],
    ['Total FNGs',     'total_fngs'],
    ['AO Count',       'ao_count_90d'],
    ['Avg Attendance', 'avg_attendance']
  ];

  var CSS =
    '.box1{max-width:420px;margin-bottom:28px;border:1px solid var(--border);background:var(--dark3)}' +
    '.box1-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px;border-bottom:1px solid var(--border)}' +
    '.box1-row:last-of-type{border-bottom:none}' +
    '.box1-label{font-family:"Barlow Condensed",sans-serif;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}' +
    '.box1-value{font-family:"Bebas Neue",sans-serif;font-size:26px;line-height:1;color:var(--white);text-align:right}' +
    '.box1-unit{font-family:"Barlow Condensed",sans-serif;font-size:14px;font-weight:700;letter-spacing:.08em;color:var(--muted);margin-left:6px}' +
    '.box1-updated{padding:8px 18px;border-top:1px solid var(--border);font-family:"Barlow Condensed",sans-serif;font-size:11px;letter-spacing:.06em;color:var(--muted);text-align:right}' +
    '.box1-msg{padding:24px 18px;font-family:"Barlow Condensed",sans-serif;font-size:14px;color:var(--muted)}';

  function addCss() {
    if (document.getElementById('box1-css')) return;
    var s = document.createElement('style');
    s.id = 'box1-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function fmt(key, n) {
    if (typeof n !== 'number' || isNaN(n)) return '&ndash;';
    if (key === 'avg_attendance') return n.toFixed(1) + '<span class="box1-unit">PAX</span>';
    return n.toLocaleString('en-US');
  }

  function msg(slot, text) {
    slot.innerHTML = '<div class="box1"><div class="box1-msg">' + esc(text) + '</div></div>';
  }

  function render(slot) {
    if (!slot) return;
    addCss();
    msg(slot, 'Loading\u2026');
    fetch(API)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var html = '<div class="box1">';
        ROWS.forEach(function (row) {
          html += '<div class="box1-row"><span class="box1-label">' + row[0] + '</span>' +
                  '<span class="box1-value">' + fmt(row[1], d[row[1]]) + '</span></div>';
        });
        var dt = d.updated ? new Date(d.updated) : null;
        if (dt && !isNaN(dt)) {
          html += '<div class="box1-updated">Updated ' + MONTHS[dt.getMonth()] + ' ' + dt.getDate() + ', ' + dt.getFullYear() + '</div>';
        }
        html += '</div>';
        slot.innerHTML = html;
      })
      .catch(function (err) {
        console.error('Box 1 failed:', err);
        msg(slot, BUSY);
      });
  }

  window.F3Box1 = { render: render };
})();

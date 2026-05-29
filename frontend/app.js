/* ─── Config ──────────────────────────────────────────────────────────── */
const API = '/api';

/* ─── State ───────────────────────────────────────────────────────────── */
let deadlines = [];
let countdownInterval = null;
let selectedColor = '#6366f1';
let selectedReminders = [];
let currentDetailId = null;
let detailInterval = null;

/* ─── Utility ─────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');

// API возвращает naive datetime без 'Z' — принудительно трактуем как UTC
function parseApiDate(str) {
  if (!str) return new Date(NaN);
  if (!str.endsWith('Z') && !str.match(/[+-]\d{2}:\d{2}$/)) str += 'Z';
  return new Date(str);
}

function formatDate(iso) {
  const d = parseApiDate(iso);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function urgencyClass(r) {
  if (r.is_past) return 'badge-past';
  if (r.total_seconds < 3600) return 'badge-red';
  if (r.total_seconds < 86400) return 'badge-orange';
  if (r.total_seconds < 604800) return 'badge-yellow';
  return 'badge-green';
}

function urgencyLabel(r) {
  if (r.is_past) return 'Прошёл';
  if (r.total_seconds < 3600) return 'Срочно';
  if (r.total_seconds < 86400) return 'Сегодня';
  if (r.total_seconds < 604800) return 'На неделе';
  return 'Впереди';
}

function computeRemaining(deadlineAt) {
  const now = Date.now();
  const target = parseApiDate(deadlineAt).getTime();
  const diff = target - now;
  const is_past = diff <= 0;
  const abs = Math.abs(Math.floor(diff / 1000));
  return {
    days: Math.floor(abs / 86400),
    hours: Math.floor((abs % 86400) / 3600),
    minutes: Math.floor((abs % 3600) / 60),
    seconds: abs % 60,
    total_seconds: abs,
    is_past,
  };
}

function reminderLabel(r) {
  if (r.type === 'before_minutes') {
    const m = r.offset_minutes;
    if (m >= 1440) return `За ${m / 1440}д`;
    if (m >= 60) return `За ${m / 60}ч`;
    return `За ${m}м`;
  }
  return `Ежедн. ${r.daily_time}`;
}

/* ─── Toast ───────────────────────────────────────────────────────────── */
function toast(msg, type = 'success') {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* ─── API Calls ───────────────────────────────────────────────────────── */
async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function loadDeadlines() {
  try {
    deadlines = await apiFetch('/deadlines');
    render();
  } catch (e) {
    toast('Ошибка загрузки: ' + e.message, 'error');
  }
}

/* ─── Render ──────────────────────────────────────────────────────────── */
function render() {
  renderSummary();
  renderGrid();
}

function renderSummary() {
  const bar = $('summaryBar');
  const total = deadlines.length;
  const urgent = deadlines.filter(d => {
    const r = computeRemaining(d.deadline_at);
    return !r.is_past && r.total_seconds < 86400;
  }).length;
  const past = deadlines.filter(d => computeRemaining(d.deadline_at).is_past).length;

  if (total === 0) { bar.innerHTML = ''; return; }

  bar.innerHTML = `
    <div class="summary-pill">
      <span class="summary-dot" style="background:#6366f1"></span>
      ${total} дедлайн${ending(total)}
    </div>
    ${urgent ? `<div class="summary-pill">
      <span class="summary-dot" style="background:#f97316"></span>
      ${urgent} срочн${urgentEnding(urgent)}
    </div>` : ''}
    ${past ? `<div class="summary-pill">
      <span class="summary-dot" style="background:#55556a"></span>
      ${past} прошл${pastEnding(past)}
    </div>` : ''}
  `;
}

function ending(n) {
  if (n % 10 === 1 && n % 100 !== 11) return '';
  if ([2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100)) return 'а';
  return 'ов';
}
function urgentEnding(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'ый';
  if ([2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100)) return 'ых';
  return 'ых';
}
function pastEnding(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'ий';
  if ([2,3,4].includes(n % 10) && ![12,13,14].includes(n % 100)) return 'их';
  return 'их';
}

function renderGrid() {
  const grid = $('deadlinesGrid');
  const empty = $('emptyState');

  if (deadlines.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    clearInterval(countdownInterval);
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = deadlines.map(cardHTML).join('');

  clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    deadlines.forEach(dl => {
      const el = document.querySelector(`[data-id="${dl.id}"] .countdown-units`);
      if (!el) return;
      const r = computeRemaining(dl.deadline_at);
      el.innerHTML = countdownUnitsHTML(r, dl.color);
      const badge = document.querySelector(`[data-id="${dl.id}"] .card-badge`);
      if (badge) {
        badge.className = `card-badge ${urgencyClass(r)}`;
        badge.textContent = urgencyLabel(r);
      }
    });
  }, 1000);
}

function cardHTML(dl) {
  const r = computeRemaining(dl.deadline_at);
  const color = dl.color || '#6366f1';
  return `
    <div class="card" data-id="${dl.id}" style="--card-color:${color}" onclick="openDetail(${dl.id})">
      <div class="card-header">
        <div class="card-title">${escHtml(dl.title)}</div>
        <div class="card-badge ${urgencyClass(r)}">${urgencyLabel(r)}</div>
      </div>
      ${dl.description ? `<div class="card-desc">${escHtml(dl.description)}</div>` : ''}
      <div class="card-countdown">
        <div class="countdown-label">${r.is_past ? 'Прошёл' : 'Осталось'}</div>
        <div class="countdown-units">${countdownUnitsHTML(r, color)}</div>
      </div>
      <div class="card-footer">
        <div class="card-date">${formatDate(dl.deadline_at)}</div>
        <div class="card-reminders">
          ${dl.reminders.map(rem => `<span class="reminder-tag">${reminderLabel(rem)}</span>`).join('')}
        </div>
      </div>
    </div>
  `;
}

function countdownUnitsHTML(r, color) {
  if (r.is_past) return `<div class="countdown-unit"><div class="countdown-num" style="color:var(--text-muted)">—</div></div>`;
  const units = [];
  if (r.days > 0 || true) {
    if (r.days > 0) units.push([pad(r.days), 'дней']);
    units.push([pad(r.hours), 'ч']);
    units.push([pad(r.minutes), 'мин']);
    units.push([pad(r.seconds), 'сек']);
  }
  return units.map(([n, label]) => `
    <div class="countdown-unit">
      <div class="countdown-num" style="color:${color}">${n}</div>
      <div class="countdown-sub">${label}</div>
    </div>
  `).join('');
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/* ─── Detail Modal ────────────────────────────────────────────────────── */
function openDetail(id) {
  const dl = deadlines.find(d => d.id === id);
  if (!dl) return;
  currentDetailId = id;
  const color = dl.color || '#6366f1';

  $('detailTitle').textContent = dl.title;
  const r = computeRemaining(dl.deadline_at);

  $('detailBody').innerHTML = `
    <div class="detail-meta">
      <span class="detail-dot" style="background:${color}"></span>
      ${formatDate(dl.deadline_at)}
    </div>
    ${dl.description ? `<div class="detail-desc">${escHtml(dl.description)}</div>` : ''}
    <div class="detail-countdown">
      <div class="detail-countdown-label">${r.is_past ? 'Прошёл' : 'Осталось'}</div>
      <div class="detail-countdown-units" id="detailUnits">${detailUnitsHTML(r, color)}</div>
    </div>
    ${dl.reminders.length ? `
      <div class="detail-reminders">
        <div class="detail-reminders-label">Напоминания</div>
        <div class="detail-reminder-list">
          ${dl.reminders.map(rem => `<span class="reminder-tag">${reminderLabel(rem)}</span>`).join('')}
        </div>
      </div>
    ` : ''}
  `;

  clearInterval(detailInterval);
  detailInterval = setInterval(() => {
    const units = $('detailUnits');
    if (units) {
      const fresh = computeRemaining(dl.deadline_at);
      units.innerHTML = detailUnitsHTML(fresh, color);
    }
  }, 1000);

  $('detailOverlay').classList.remove('hidden');
}

function detailUnitsHTML(r, color) {
  if (r.is_past) return `<div class="detail-unit"><div class="detail-num" style="color:var(--text-muted)">—</div><div class="detail-sub">прошёл</div></div>`;
  const parts = [];
  if (r.days > 0) parts.push([r.days, 'дней']);
  parts.push([pad(r.hours), 'часов']);
  parts.push([pad(r.minutes), 'минут']);
  parts.push([pad(r.seconds), 'секунд']);
  return parts.map(([n, l]) => `
    <div class="detail-unit">
      <div class="detail-num" style="color:${color}">${n}</div>
      <div class="detail-sub">${l}</div>
    </div>
  `).join('');
}

function closeDetail() {
  $('detailOverlay').classList.add('hidden');
  clearInterval(detailInterval);
  currentDetailId = null;
}

/* ─── Create / Edit Form ──────────────────────────────────────────────── */
function openModal(dl = null) {
  const form = $('deadlineForm');
  form.reset();
  selectedReminders = [];
  selectedColor = dl?.color || '#6366f1';

  // color swatches
  document.querySelectorAll('.color-swatch').forEach(s => {
    s.classList.toggle('active', s.dataset.color === selectedColor);
  });

  // chips
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));

  if (dl) {
    $('modalTitle').textContent = 'Редактировать';
    $('submitBtn').textContent = 'Сохранить';
    $('editId').value = dl.id;
    $('titleInput').value = dl.title;
    $('descInput').value = dl.description || '';
    // Показываем время в локальной зоне браузера для datetime-local инпута
    const utcMs = parseApiDate(dl.deadline_at).getTime();
    const localDate = new Date(utcMs - new Date().getTimezoneOffset() * 60000);
    $('datetimeInput').value = localDate.toISOString().slice(0, 16);

    selectedReminders = dl.reminders.map(r => ({ ...r, _existing: true }));
  } else {
    $('modalTitle').textContent = 'Новый дедлайн';
    $('submitBtn').textContent = 'Создать';
    $('editId').value = '';
    // Предзаполняем «сейчас + 1 час» в локальном времени браузера
    const now = new Date();
    const localNow = new Date(now.getTime() - now.getTimezoneOffset() * 60000 + 3600000);
    $('datetimeInput').value = localNow.toISOString().slice(0, 16);
  }

  $('customDailyRow').classList.add('hidden');
  renderSelectedReminders();
  $('modalOverlay').classList.remove('hidden');
  setTimeout(() => $('titleInput').focus(), 80);
}

function closeModal() {
  $('modalOverlay').classList.add('hidden');
}

function renderSelectedReminders() {
  const container = $('selectedReminders');
  container.innerHTML = selectedReminders.map((r, i) => `
    <span class="selected-reminder-tag">
      ${reminderLabel(r)}
      <button type="button" onclick="removeReminder(${i})">×</button>
    </span>
  `).join('');
}

function removeReminder(i) {
  selectedReminders.splice(i, 1);
  renderSelectedReminders();
}

/* ─── Form Submit ─────────────────────────────────────────────────────── */
$('deadlineForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id = $('editId').value;
  const title = $('titleInput').value.trim();
  const description = $('descInput').value.trim();
  const datetimeLocal = $('datetimeInput').value;
  const deadline_at = new Date(datetimeLocal).toISOString();

  const btn = $('submitBtn');
  btn.disabled = true;
  btn.textContent = '…';

  try {
    let dl;
    if (id) {
      dl = await apiFetch(`/deadlines/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ title, description, deadline_at, color: selectedColor }),
      });
      // sync reminders: delete all then re-add (simplest approach)
      for (const r of dl.reminders) {
        await apiFetch(`/reminders/${r.id}`, { method: 'DELETE' });
      }
    } else {
      dl = await apiFetch('/deadlines', {
        method: 'POST',
        body: JSON.stringify({ title, description, deadline_at, color: selectedColor }),
      });
    }

    for (const r of selectedReminders) {
      const body = { type: r.type };
      if (r.type === 'before_minutes') body.offset_minutes = r.offset_minutes;
      else body.daily_time = r.daily_time;
      await apiFetch(`/deadlines/${dl.id}/reminders`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    }

    toast(id ? 'Дедлайн обновлён' : 'Дедлайн создан');
    closeModal();
    await loadDeadlines();
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = id ? 'Сохранить' : 'Создать';
  }
});

/* ─── Delete ──────────────────────────────────────────────────────────── */
$('deleteBtn').addEventListener('click', async () => {
  if (!currentDetailId) return;
  const dl = deadlines.find(d => d.id === currentDetailId);
  if (!confirm(`Удалить дедлайн «${dl?.title}»?`)) return;
  try {
    await apiFetch(`/deadlines/${currentDetailId}`, { method: 'DELETE' });
    toast('Дедлайн удалён');
    closeDetail();
    await loadDeadlines();
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
});

$('editBtn').addEventListener('click', () => {
  const dl = deadlines.find(d => d.id === currentDetailId);
  if (!dl) return;
  closeDetail();
  openModal(dl);
});

/* ─── Event Wiring ────────────────────────────────────────────────────── */
$('openModalBtn').addEventListener('click', () => openModal());
$('emptyAddBtn').addEventListener('click', () => openModal());
$('closeModalBtn').addEventListener('click', closeModal);
$('cancelFormBtn').addEventListener('click', closeModal);
$('closeDetailBtn').addEventListener('click', closeDetail);

$('modalOverlay').addEventListener('click', e => { if (e.target === $('modalOverlay')) closeModal(); });
$('detailOverlay').addEventListener('click', e => { if (e.target === $('detailOverlay')) closeDetail(); });

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeDetail(); }
});

// color swatches
document.querySelectorAll('.color-swatch').forEach(swatch => {
  swatch.addEventListener('click', () => {
    selectedColor = swatch.dataset.color;
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    swatch.classList.add('active');
  });
});

// reminder chips
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const type = chip.dataset.type;
    const offset = chip.dataset.offset ? parseInt(chip.dataset.offset) : null;
    const time = chip.dataset.time || null;

    const exists = selectedReminders.some(r =>
      r.type === type &&
      (type === 'before_minutes' ? r.offset_minutes === offset : r.daily_time === time)
    );

    if (exists) {
      selectedReminders = selectedReminders.filter(r => !(
        r.type === type &&
        (type === 'before_minutes' ? r.offset_minutes === offset : r.daily_time === time)
      ));
      chip.classList.remove('active');
    } else {
      selectedReminders.push({ type, offset_minutes: offset, daily_time: time });
      chip.classList.add('active');
    }
    renderSelectedReminders();
  });
});

// custom interval ("за N времени")
function parseIntervalToMinutes(text) {
  text = (text || '').toLowerCase().trim();
  if (/^\d+$/.test(text)) {
    const v = parseInt(text);
    return v > 0 ? v : null;
  }
  let total = 0, found = false;
  const re = /(\d+)\s*([а-яёa-z]+)/g;
  let mt;
  while ((mt = re.exec(text)) !== null) {
    const n = parseInt(mt[1]);
    const u = mt[2][0];
    if (u === 'д' || u === 'd') { total += n * 1440; found = true; }
    else if (u === 'ч' || u === 'h') { total += n * 60; found = true; }
    else if (u === 'м' || u === 'm') { total += n; found = true; }
  }
  return (found && total > 0) ? total : null;
}

$('toggleCustomInterval').addEventListener('click', () => {
  $('customIntervalRow').classList.toggle('hidden');
  if (!$('customIntervalRow').classList.contains('hidden')) {
    $('customInterval').focus();
  }
});

$('addCustomInterval').addEventListener('click', () => {
  const minutes = parseIntervalToMinutes($('customInterval').value);
  if (!minutes) {
    toast('Не понял интервал. Примеры: 90, 3ч, 1д 6ч', 'error');
    return;
  }
  const exists = selectedReminders.some(r => r.type === 'before_minutes' && r.offset_minutes === minutes);
  if (!exists) {
    selectedReminders.push({ type: 'before_minutes', offset_minutes: minutes, daily_time: null });
    renderSelectedReminders();
  }
  $('customIntervalRow').classList.add('hidden');
  $('customInterval').value = '';
});

/* ─── Boot ────────────────────────────────────────────────────────────── */
loadDeadlines();
// refresh data from server every 30s to stay in sync
setInterval(loadDeadlines, 30000);

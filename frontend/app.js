/* ─── Config ─────────────────────────────────────────────────────────── */
const API = '/api';

/* ─── State ──────────────────────────────────────────────────────────── */
let deadlines      = [];
let selectedColor  = '#6366f1';
let selectedReminders = [];
let currentDetailId   = null;
let viewMode          = localStorage.getItem('viewMode') || 'grid';
let focusIndex        = 0;
let tickTimer         = null;
let byId              = {};

/* ─── Utility ────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit'
  });
}

function computeRemaining(deadlineAt) {
  const diff = new Date(deadlineAt).getTime() - Date.now();
  const isPast = diff <= 0;
  const abs = Math.abs(Math.floor(diff / 1000));
  return {
    days: Math.floor(abs / 86400),
    hours: Math.floor((abs % 86400) / 3600),
    minutes: Math.floor((abs % 3600) / 60),
    seconds: abs % 60,
    total_seconds: abs,
    is_past: isPast,
  };
}

function urgencyClass(r) {
  if (r.is_past)                       return 'badge-past';
  if (r.total_seconds < 3600)          return 'badge-red';
  if (r.total_seconds < 86400)         return 'badge-orange';
  if (r.total_seconds < 604800)        return 'badge-yellow';
  return 'badge-green';
}
function urgencyLabel(r) {
  if (r.is_past)                       return 'Прошёл';
  if (r.total_seconds < 3600)          return 'Срочно';
  if (r.total_seconds < 86400)         return 'Сегодня';
  if (r.total_seconds < 604800)        return 'На неделе';
  return 'Впереди';
}

function reminderLabel(r) {
  if (r.type === 'before_minutes') {
    const m = r.offset_minutes;
    if (m >= 1440) return `За ${m / 1440}д`;
    if (m >= 60)   return `За ${m / 60}ч`;
    return `За ${m}м`;
  }
  return `Ежедн. ${r.daily_time}`;
}

function progressPct(dl) {
  const created = new Date(dl.created_at).getTime();
  const deadline = new Date(dl.deadline_at).getTime();
  const now = Date.now();
  if (deadline <= created) return 100;
  return Math.min(100, Math.max(0, ((now - created) / (deadline - created)) * 100));
}

/* ─── Ripple effect on buttons ───────────────────────────────────────── */
function addRipple(e) {
  const btn = e.currentTarget;
  const rect = btn.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height) * 1.6;
  const r = document.createElement('span');
  r.className = 'ripple';
  r.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX-rect.left-size/2}px;top:${e.clientY-rect.top-size/2}px`;
  btn.appendChild(r);
  r.addEventListener('animationend', () => r.remove());
}
document.querySelectorAll('.btn-add, .btn-primary, .btn-danger').forEach(b => b.addEventListener('click', addRipple));

/* ─── Toast ──────────────────────────────────────────────────────────── */
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
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, 3200);
}

/* ─── API ────────────────────────────────────────────────────────────── */
async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' }, ...opts,
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
    byId = Object.fromEntries(deadlines.map(d => [d.id, d]));
    render();
  } catch (e) {
    toast('Ошибка загрузки: ' + e.message, 'error');
  }
}

/* ─── Countdown HTML builder ─────────────────────────────────────────── */
function cdUnitsHTML(r, color, { compact = false, big = false } = {}) {
  if (r.is_past) {
    return `<div class="cd-unit"><div class="cd-num" style="color:var(--text-muted)">—</div></div>`;
  }
  const units = [];
  if (r.days > 0)                                  units.push([pad(r.days),    'дней']);
  if (!compact || r.days < 100)                    units.push([pad(r.hours),   'ч']);
  if (!compact || r.days === 0)                    units.push([pad(r.minutes), 'мин']);
  if (!compact || (r.days === 0 && r.hours === 0)) units.push([pad(r.seconds), 'сек']);

  const maxUnits = compact ? 3 : 4;
  const display = units.slice(0, maxUnits);

  return display.map(([n, label], i) => `
    <div class="cd-unit" style="--i:${i}">
      <div class="cd-num" style="color:${color}" data-val="${n}">${n}</div>
      <div class="cd-sub">${label}</div>
    </div>
  `).join('');
}

/* ─── Tick: animate only digits that changed ─────────────────────────── */
function tickAllClocks() {
  const active = deadlines.filter(d => !d.archived);

  // grid cards
  active.forEach(dl => {
    const card = document.querySelector(`[data-id="${dl.id}"]`);
    if (!card) return;
    const r = computeRemaining(dl.deadline_at);

    // update badge
    const badge = card.querySelector('.card-badge');
    if (badge) {
      const newCls = urgencyClass(r);
      if (!badge.classList.contains(newCls)) {
        badge.className = `card-badge ${newCls}`;
        badge.textContent = urgencyLabel(r);
        badge.classList.add('pulse');
        badge.addEventListener('animationend', () => badge.classList.remove('pulse'), { once: true });
      }
    }

    // update digits with flip animation
    tickDigits(card, r, dl.color);
  });

  // focus card
  const focusEl = document.querySelector('.focus-countdown');
  if (focusEl) {
    const dl = active[focusIndex];
    if (dl) {
      const r = computeRemaining(dl.deadline_at);
      tickDigits(focusEl, r, dl.color);
      // progress bar
      const fill = document.querySelector('.focus-progress-fill');
      if (fill) fill.style.width = progressPct(dl) + '%';
    }
  }

  // detail modal
  const detailUnits = document.querySelector('#detailUnits');
  if (detailUnits && currentDetailId) {
    const dl = byId[currentDetailId];
    if (dl) {
      const r = computeRemaining(dl.deadline_at);
      tickDigits(detailUnits, r, dl.color);
    }
  }
}

function tickDigits(container, r, color) {
  const units = container.querySelectorAll('.cd-num');
  const vals  = [
    r.is_past ? null : (r.days > 0 ? pad(r.days) : null),
    r.is_past ? null : pad(r.hours),
    r.is_past ? null : pad(r.minutes),
    r.is_past ? null : pad(r.seconds),
  ].filter(v => v !== null);

  units.forEach((el, i) => {
    const newVal = vals[i];
    if (newVal !== undefined && el.dataset.val !== newVal) {
      el.dataset.val = newVal;
      el.textContent = newVal;
      el.classList.remove('tick');
      void el.offsetWidth; // reflow to restart animation
      el.classList.add('tick');
      el.addEventListener('animationend', () => el.classList.remove('tick'), { once: true });
    }
  });
}

/* ─── Start/stop tick loop ───────────────────────────────────────────── */
function startTicking() {
  clearInterval(tickTimer);
  tickTimer = setInterval(tickAllClocks, 1000);
}

/* ─── Render ─────────────────────────────────────────────────────────── */
function render() {
  renderSummary();
  if (viewMode === 'focus') renderFocus();
  else renderGrid();
  renderArchive();
  startTicking();
}

/* ─── Summary bar ────────────────────────────────────────────────────── */
function renderSummary() {
  const bar = $('summaryBar');
  const active = deadlines.filter(d => !d.archived);
  const total  = active.length;
  if (total === 0) { bar.innerHTML = ''; return; }

  const urgent = active.filter(d => {
    const r = computeRemaining(d.deadline_at);
    return !r.is_past && r.total_seconds < 86400;
  }).length;
  const past = active.filter(d => computeRemaining(d.deadline_at).is_past).length;

  const pills = [
    { color: '#6366f1', text: `${total} дедлайн${endN(total)}` },
    urgent ? { color: '#f97316', text: `${urgent} срочн${urgEnd(urgent)}` } : null,
    past   ? { color: '#55556a', text: `${past} прошл${pastEnd(past)}` } : null,
  ].filter(Boolean);

  bar.innerHTML = pills.map((p, i) => `
    <div class="summary-pill" style="--i:${i}">
      <span class="summary-dot" style="background:${p.color}"></span>
      ${p.text}
    </div>
  `).join('');
}

function endN(n) {
  if (n % 10 === 1 && n % 100 !== 11) return '';
  if ([2,3,4].includes(n%10) && ![12,13,14].includes(n%100)) return 'а';
  return 'ов';
}
function urgEnd(n) { return [2,3,4].includes(n%10) && ![12,13,14].includes(n%100) ? 'ых' : 'ых'; }
function pastEnd(n) { return [2,3,4].includes(n%10) && ![12,13,14].includes(n%100) ? 'их' : 'их'; }

/* ─── Grid view ──────────────────────────────────────────────────────── */
function renderGrid() {
  const grid  = $('deadlinesGrid');
  const empty = $('emptyState');
  const active = deadlines.filter(d => !d.archived);

  if (active.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = active.map((dl, i) => cardHTML(dl, i)).join('');

  // click handlers (event delegation)
  grid.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => openDetail(Number(card.dataset.id)));
  });
}

function cardHTML(dl, i = 0) {
  const r = computeRemaining(dl.deadline_at);
  const color = dl.color || '#6366f1';
  const desc = dl.description ? `<div class="card-desc">${escHtml(dl.description)}</div>` : '';
  const remTags = dl.reminders.map(rem =>
    `<span class="reminder-tag">${reminderLabel(rem)}</span>`
  ).join('');

  return `
    <div class="card" data-id="${dl.id}" style="--card-color:${color};--i:${i}">
      <div class="card-header">
        <div class="card-title">${escHtml(dl.title)}</div>
        <div class="card-badge ${urgencyClass(r)}">${urgencyLabel(r)}</div>
      </div>
      ${desc}
      <div class="card-countdown">
        <div class="countdown-label">${r.is_past ? 'Прошёл' : 'Осталось'}</div>
        <div class="countdown">${cdUnitsHTML(r, color)}</div>
      </div>
      <div class="card-footer">
        <div class="card-date">${formatDate(dl.deadline_at)}</div>
        <div class="card-reminders">${remTags}</div>
      </div>
    </div>
  `;
}

/* ─── Archive ────────────────────────────────────────────────────────── */
function renderArchive() {
  const section = $('archiveSection');
  const grid    = $('archiveGrid');
  const count   = $('archiveCount');
  const archived = deadlines.filter(d => d.archived);

  if (archived.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  count.textContent = archived.length;
  grid.innerHTML = archived.map((dl, i) => cardHTML(dl, i)).join('');
  grid.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => openDetail(Number(card.dataset.id)));
  });
}

$('archiveToggle').addEventListener('click', () => {
  const grid     = $('archiveGrid');
  const toggle   = $('archiveToggle');
  const expanded = toggle.getAttribute('aria-expanded') === 'true';
  toggle.setAttribute('aria-expanded', String(!expanded));
  grid.classList.toggle('hidden', expanded);
});

/* ─── Focus view ─────────────────────────────────────────────────────── */
function renderFocus(dir = 0) {
  const stage = $('focusStage');
  const nav   = $('focusNav');
  const dots  = $('focusDots');
  const active = deadlines.filter(d => !d.archived);

  if (active.length === 0) {
    stage.innerHTML = '<div class="empty-state" style="min-height:40vh"><div class="empty-icon">◎</div><h2>Нет дедлайнов</h2></div>';
    nav.classList.add('hidden');
    return;
  }

  if (focusIndex >= active.length) focusIndex = active.length - 1;
  const dl    = active[focusIndex];
  const color = dl.color || '#6366f1';
  const r     = computeRemaining(dl.deadline_at);

  // animation direction
  const aniClass = dir > 0 ? 'enter-right' : dir < 0 ? 'enter-left' : 'enter';

  stage.innerHTML = `
    <div class="focus-card ${aniClass}" style="--card-color:${color}">
      <div class="focus-badge ${urgencyClass(r)}">${urgencyLabel(r)}</div>
      <div class="focus-title">${escHtml(dl.title)}</div>
      ${dl.description ? `<div class="focus-desc">${escHtml(dl.description)}</div>` : ''}
      <div class="focus-countdown countdown">
        ${cdUnitsHTML(r, color)}
      </div>
      <div class="focus-progress">
        <div class="focus-progress-fill" style="width:${progressPct(dl)}%"></div>
      </div>
      <div class="focus-meta">${formatDate(dl.deadline_at)}</div>
      <div class="focus-actions">
        <button class="btn-ghost" onclick="openDetail(${dl.id})">Подробнее</button>
        <button class="btn-primary" onclick="openModalEdit(${dl.id})">Изменить</button>
      </div>
    </div>
  `;

  // dots
  dots.innerHTML = active.map((_, i) => `
    <div class="focus-dot ${i === focusIndex ? 'active' : ''}" data-idx="${i}"></div>
  `).join('');
  dots.querySelectorAll('.focus-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      const idx = Number(dot.dataset.idx);
      const d = idx > focusIndex ? 1 : -1;
      focusIndex = idx;
      renderFocus(d);
    });
  });

  nav.classList.toggle('hidden', active.length <= 1);
}

function focusGo(dir) {
  const active = deadlines.filter(d => !d.archived);
  focusIndex = (focusIndex + dir + active.length) % active.length;
  renderFocus(dir);
}

$('focusPrev').addEventListener('click', () => focusGo(-1));
$('focusNext').addEventListener('click', () => focusGo(1));

/* ─── Touch swipe for focus view ─────────────────────────────────────── */
let swipeStartX = 0;
let swipeStartY = 0;
$('focusView').addEventListener('touchstart', e => {
  swipeStartX = e.touches[0].clientX;
  swipeStartY = e.touches[0].clientY;
}, { passive: true });
$('focusView').addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - swipeStartX;
  const dy = e.changedTouches[0].clientY - swipeStartY;
  // only horizontal swipes with enough distance
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    focusGo(dx < 0 ? 1 : -1);
  }
}, { passive: true });

/* ─── View mode toggle ───────────────────────────────────────────────── */
function setViewMode(mode) {
  viewMode = mode;
  localStorage.setItem('viewMode', mode);
  const gridView  = $('gridView');
  const focusView = $('focusView');

  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
    btn.setAttribute('aria-selected', String(btn.dataset.mode === mode));
  });

  if (mode === 'focus') {
    gridView.classList.add('hidden');
    focusView.classList.remove('hidden');
    renderFocus();
  } else {
    focusView.classList.add('hidden');
    gridView.classList.remove('hidden');
    renderGrid();
    renderSummary();
  }
  startTicking();
}

document.querySelectorAll('.view-btn').forEach(btn => {
  btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
});

// apply initial mode without triggering animation twice
setViewMode(viewMode);

/* ─── Keyboard navigation ────────────────────────────────────────────── */
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeModal(); closeDetail(); }
  const modalOpen = !$('modalOverlay').classList.contains('hidden') ||
                    !$('detailOverlay').classList.contains('hidden');
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  if (viewMode === 'focus' && !modalOpen && !typing) {
    if (e.key === 'ArrowLeft')  focusGo(-1);
    if (e.key === 'ArrowRight') focusGo(1);
  }
});

/* ─── Detail modal ───────────────────────────────────────────────────── */
function openDetail(id) {
  const dl = byId[id];
  if (!dl) return;
  currentDetailId = id;
  const color = dl.color || '#6366f1';
  const r = computeRemaining(dl.deadline_at);

  $('detailTitle').textContent = dl.title;
  $('detailBody').innerHTML = `
    <div class="detail-meta">
      <span class="detail-dot" style="background:${color}"></span>
      ${formatDate(dl.deadline_at)}
    </div>
    ${dl.description ? `<div class="detail-desc">${escHtml(dl.description)}</div>` : ''}
    <div class="detail-countdown">
      <div class="detail-countdown-label">${r.is_past ? 'Прошёл' : 'Осталось'}</div>
      <div class="countdown" id="detailUnits">${cdUnitsHTML(r, color)}</div>
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

  $('archiveBtn').textContent = dl.archived ? 'Разархивировать' : 'Архивировать';
  showOverlay($('detailOverlay'));
}

function closeDetail() {
  hideOverlay($('detailOverlay'));
  currentDetailId = null;
}

/* ─── Create / edit form ─────────────────────────────────────────────── */
function openModal(dl = null) {
  const form = $('deadlineForm');
  form.reset();
  selectedReminders = [];
  selectedColor = dl?.color || '#6366f1';

  document.querySelectorAll('.color-swatch').forEach(s =>
    s.classList.toggle('active', s.dataset.color === selectedColor)
  );
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));

  if (dl) {
    $('modalTitle').textContent = 'Редактировать';
    $('submitBtn').textContent  = 'Сохранить';
    $('editId').value           = dl.id;
    $('titleInput').value       = dl.title;
    $('descInput').value        = dl.description || '';
    const local = new Date(dl.deadline_at);
    local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
    $('datetimeInput').value = local.toISOString().slice(0, 16);
    selectedReminders = dl.reminders.map(r => ({ ...r, _existing: true }));
  } else {
    $('modalTitle').textContent = 'Новый дедлайн';
    $('submitBtn').textContent  = 'Создать';
    $('editId').value           = '';
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset() + 60);
    $('datetimeInput').value = now.toISOString().slice(0, 16);
  }

  $('customIntervalRow').classList.add('hidden');
  renderSelectedReminders();
  showOverlay($('modalOverlay'));
  setTimeout(() => $('titleInput').focus(), 120);
}

function openModalEdit(id) {
  const dl = byId[id];
  if (dl) openModal(dl);
}

function closeModal() { hideOverlay($('modalOverlay')); }

/* ─── Animated overlay open / close ─────────────────────────────────── */
function showOverlay(overlay) {
  overlay.classList.remove('hidden', 'closing');
  overlay.classList.add('open');
}
function hideOverlay(overlay) {
  overlay.classList.add('closing');
  overlay.addEventListener('animationend', () => {
    overlay.classList.add('hidden');
    overlay.classList.remove('closing', 'open');
  }, { once: true });
}

/* ─── Selected reminders ─────────────────────────────────────────────── */
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

/* ─── Custom interval parser (e.g. "3ч", "90", "1д 6ч") ─────────────── */
function parseInterval(s) {
  let mins = 0;
  s.replace(/(\d+)\s*д/g,  (_, n) => { mins += +n * 1440; });
  s.replace(/(\d+)\s*ч/g,  (_, n) => { mins += +n * 60; });
  s.replace(/(\d+)\s*м/g,  (_, n) => { mins += +n; });
  if (mins === 0 && /^\d+$/.test(s.trim())) mins = +s.trim();
  return mins;
}

/* ─── Form submit ────────────────────────────────────────────────────── */
$('deadlineForm').addEventListener('submit', async e => {
  e.preventDefault();
  const id          = $('editId').value;
  const title       = $('titleInput').value.trim();
  const description = $('descInput').value.trim();
  const deadline_at = new Date($('datetimeInput').value).toISOString();
  const btn         = $('submitBtn');
  btn.disabled = true;
  btn.textContent = '…';

  try {
    let dl;
    if (id) {
      dl = await apiFetch(`/deadlines/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ title, description, deadline_at, color: selectedColor }),
      });
      for (const r of dl.reminders) await apiFetch(`/reminders/${r.id}`, { method: 'DELETE' });
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
      await apiFetch(`/deadlines/${dl.id}/reminders`, { method: 'POST', body: JSON.stringify(body) });
    }

    toast(id ? 'Дедлайн обновлён' : 'Дедлайн создан');
    closeModal();
    await loadDeadlines();
  } catch (err) {
    toast('Ошибка: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = id ? 'Сохранить' : 'Создать';
  }
});

/* ─── Delete ─────────────────────────────────────────────────────────── */
$('deleteBtn').addEventListener('click', async () => {
  if (!currentDetailId) return;
  const dl = byId[currentDetailId];
  if (!confirm(`Удалить «${dl?.title}»?`)) return;
  try {
    // animate card out before removing
    const card = document.querySelector(`[data-id="${currentDetailId}"]`);
    if (card) {
      card.classList.add('removing');
      await new Promise(r => setTimeout(r, 280));
    }
    await apiFetch(`/deadlines/${currentDetailId}`, { method: 'DELETE' });
    toast('Дедлайн удалён');
    closeDetail();
    await loadDeadlines();
  } catch (err) {
    toast('Ошибка: ' + err.message, 'error');
  }
});

/* ─── Archive/unarchive ──────────────────────────────────────────────── */
$('archiveBtn').addEventListener('click', async () => {
  if (!currentDetailId) return;
  const dl = byId[currentDetailId];
  if (!dl) return;
  try {
    await apiFetch(`/deadlines/${currentDetailId}`, {
      method: 'PUT',
      body: JSON.stringify({ archived: !dl.archived }),
    });
    toast(dl.archived ? 'Разархивировано' : 'Архивировано');
    closeDetail();
    await loadDeadlines();
  } catch (err) {
    toast('Ошибка: ' + err.message, 'error');
  }
});

/* ─── Edit from detail ───────────────────────────────────────────────── */
$('editBtn').addEventListener('click', () => {
  const dl = byId[currentDetailId];
  if (!dl) return;
  closeDetail();
  setTimeout(() => openModal(dl), 220);
});

/* ─── Color swatches ─────────────────────────────────────────────────── */
document.querySelectorAll('.color-swatch').forEach(swatch => {
  swatch.addEventListener('click', () => {
    selectedColor = swatch.dataset.color;
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    swatch.classList.add('active');
  });
});

/* ─── Reminder chips ─────────────────────────────────────────────────── */
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const type   = chip.dataset.type;
    const offset = chip.dataset.offset ? parseInt(chip.dataset.offset) : null;
    const time   = chip.dataset.time || null;
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

/* ─── Custom interval ────────────────────────────────────────────────── */
$('toggleCustomInterval').addEventListener('click', () => {
  const row = $('customIntervalRow');
  row.classList.toggle('hidden');
  if (!row.classList.contains('hidden')) $('customInterval').focus();
});

$('addCustomInterval').addEventListener('click', () => {
  const val  = $('customInterval').value.trim();
  if (!val) return;
  const mins = parseInterval(val);
  if (mins <= 0) { toast('Не понял интервал. Пример: 3ч, 90, 1д 6ч', 'error'); return; }
  const exists = selectedReminders.some(r => r.type === 'before_minutes' && r.offset_minutes === mins);
  if (!exists) {
    selectedReminders.push({ type: 'before_minutes', offset_minutes: mins, daily_time: null });
    renderSelectedReminders();
  }
  $('customIntervalRow').classList.add('hidden');
  $('customInterval').value = '';
});

/* ─── Modal event wiring ─────────────────────────────────────────────── */
$('openModalBtn').addEventListener('click',  () => openModal());
$('emptyAddBtn').addEventListener('click',   () => openModal());
$('closeModalBtn').addEventListener('click', closeModal);
$('cancelFormBtn').addEventListener('click', closeModal);
$('closeDetailBtn').addEventListener('click', closeDetail);

$('modalOverlay').addEventListener('click',  e => { if (e.target === $('modalOverlay'))  closeModal(); });
$('detailOverlay').addEventListener('click', e => { if (e.target === $('detailOverlay')) closeDetail(); });

/* ─── Boot ───────────────────────────────────────────────────────────── */
loadDeadlines();
setInterval(loadDeadlines, 30000);

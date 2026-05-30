/* ─── Config ──────────────────────────────────────────────────────────── */
const API = '/api';

/* ─── State ───────────────────────────────────────────────────────────── */
let deadlines = [];
let countdownInterval = null;
let selectedColor = '#6366f1';
let selectedReminders = [];
let currentDetailId = null;
let detailInterval = null;
let viewMode = localStorage.getItem('viewMode') || 'grid';
let focusIndex = 0;

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
  renderFocus();
  applyViewMode();
  startTicking();
}

function startTicking() {
  clearInterval(countdownInterval);
  countdownInterval = setInterval(updateAllClocks, 1000);
  updateAllClocks();
}

// Единый тик: обновляет все часы на странице (и в сетке, и в фокусе) + бейджи и прогресс
function updateAllClocks() {
  const byId = {};
  deadlines.forEach(d => (byId[d.id] = d));

  document.querySelectorAll('.flip-clock[data-deadline-id]').forEach(clock => {
    const dl = byId[clock.dataset.deadlineId];
    if (dl) tickClock(clock, computeRemaining(dl.deadline_at));
  });

  document.querySelectorAll('.card[data-id], .focus-card[data-id]').forEach(node => {
    const dl = byId[node.dataset.id];
    if (!dl) return;
    const r = computeRemaining(dl.deadline_at);
    const badge = node.querySelector('.card-badge');
    if (badge) {
      badge.className = `card-badge ${urgencyClass(r)}`;
      badge.textContent = urgencyLabel(r);
    }
    const fill = node.querySelector('.card-progress-fill');
    if (fill) fill.style.width = progressPct(dl) + '%';
    const pctLabel = node.querySelector('.focus-progress-pct');
    if (pctLabel) pctLabel.textContent = Math.round(progressPct(dl)) + '%';
  });
}

function renderSummary() {
  const bar = $('summaryBar');
  const active = deadlines.filter(d => !d.archived);
  const total = active.length;
  const urgent = active.filter(d => {
    const r = computeRemaining(d.deadline_at);
    return !r.is_past && r.total_seconds < 86400;
  }).length;
  const past = active.filter(d => computeRemaining(d.deadline_at).is_past).length;

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
  const archiveSection = $('archiveSection');
  const archiveGrid = $('archiveGrid');

  const active = deadlines.filter(d => !d.archived);
  const archived = deadlines.filter(d => d.archived);

  // Активные
  if (active.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    grid.innerHTML = active.map(cardHTML).join('');
  }

  // Архив
  if (archived.length === 0) {
    archiveSection.classList.add('hidden');
    archiveGrid.innerHTML = '';
  } else {
    archiveSection.classList.remove('hidden');
    $('archiveCount').textContent = archived.length;
    archiveGrid.innerHTML = archived.map(cardHTML).join('');
  }
}

function cardHTML(dl, index = 0) {
  const r = computeRemaining(dl.deadline_at);
  const color = dl.color || '#6366f1';
  return `
    <div class="card" data-id="${dl.id}" style="--card-color:${color};--i:${index}" onclick="openDetail(${dl.id})">
      <div class="card-header">
        <div class="card-title">${escHtml(dl.title)}</div>
        <div class="card-badge ${urgencyClass(r)}">${urgencyLabel(r)}</div>
      </div>
      ${dl.description ? `<div class="card-desc">${escHtml(dl.description)}</div>` : ''}
      <div class="card-countdown">
        ${clockHTML(r, { id: dl.id, compact: true })}
      </div>
      <div class="card-progress"><div class="card-progress-fill" style="width:${progressPct(dl)}%"></div></div>
      <div class="card-footer">
        <div class="card-date">${formatDate(dl.deadline_at)}</div>
        <div class="card-reminders">
          ${dl.reminders.map(rem => `<span class="reminder-tag">${reminderLabel(rem)}</span>`).join('')}
        </div>
      </div>
    </div>
  `;
}

/* ─── Flip Clock ──────────────────────────────────────────────────────── */
// compact (сетка): максимум 3 разряда — дни→д/ч/м или ч/м/с — чтобы всегда влезало.
// полный (фокус/деталь): д/ч/м/с.
function clockUnits(r, compact) {
  const u = [];
  if (r.days > 0) {
    u.push({ key: 'd', label: 'дней', value: String(r.days).padStart(2, '0') });
    u.push({ key: 'h', label: 'час', value: pad(r.hours) });
    u.push({ key: 'm', label: 'мин', value: pad(r.minutes) });
    if (!compact) u.push({ key: 's', label: 'сек', value: pad(r.seconds) });
  } else {
    u.push({ key: 'h', label: 'час', value: pad(r.hours) });
    u.push({ key: 'm', label: 'мин', value: pad(r.minutes) });
    u.push({ key: 's', label: 'сек', value: pad(r.seconds) });
  }
  return u;
}

function clockSig(units) {
  return units.map(u => u.key + u.value.length).join('|');
}

function unitHTML(u) {
  const cells = [...u.value]
    .map(ch => `<span class="flip-cell"><span class="flip-num">${ch}</span></span>`)
    .join('');
  return `<div class="flip-unit" data-key="${u.key}">
    <div class="flip-cells">${cells}</div>
    <div class="flip-label">${u.label}</div>
  </div>`;
}

function clockInnerHTML(r, compact) {
  if (r.is_past) return `<div class="flip-past">Срок прошёл</div>`;
  return clockUnits(r, compact)
    .map((u, i) => (i > 0 ? '<span class="flip-colon">:</span>' : '') + unitHTML(u))
    .join('');
}

// Контейнер часов: data-sig/past/compact нужны для дифф-обновления без полной перерисовки
function clockHTML(r, { cls = '', id = null, compact = false } = {}) {
  const sig = r.is_past ? 'past' : clockSig(clockUnits(r, compact));
  const idAttr = id != null ? ` data-deadline-id="${id}"` : '';
  return `<div class="flip-clock ${cls}"${idAttr} data-sig="${sig}" data-past="${r.is_past}" data-compact="${compact}">${clockInnerHTML(r, compact)}</div>`;
}

// Обновляет только изменившиеся цифры, подсвечивая их флип-анимацией
function tickClock(container, r) {
  const compact = container.dataset.compact === 'true';
  const past = r.is_past;
  if ((container.dataset.past === 'true') !== past) {
    container.dataset.past = String(past);
    container.dataset.sig = past ? 'past' : clockSig(clockUnits(r, compact));
    container.innerHTML = clockInnerHTML(r, compact);
    return;
  }
  if (past) return;

  const units = clockUnits(r, compact);
  const sig = clockSig(units);
  if (container.dataset.sig !== sig) {
    container.dataset.sig = sig;
    container.innerHTML = clockInnerHTML(r, compact);
    return;
  }

  units.forEach(u => {
    const unitEl = container.querySelector(`.flip-unit[data-key="${u.key}"]`);
    if (!unitEl) return;
    const cells = unitEl.querySelectorAll('.flip-cell');
    [...u.value].forEach((ch, i) => {
      const cell = cells[i];
      if (!cell) return;
      const numEl = cell.querySelector('.flip-num');
      if (numEl.textContent !== ch) {
        numEl.textContent = ch;
        cell.classList.remove('flip');
        void cell.offsetWidth; // форсируем reflow, чтобы перезапустить анимацию
        cell.classList.add('flip');
      }
    });
  });
}

function progressPct(dl) {
  const created = parseApiDate(dl.created_at).getTime();
  const target = parseApiDate(dl.deadline_at).getTime();
  const now = Date.now();
  if (!created || target <= created) return now >= target ? 100 : 0;
  if (now >= target) return 100;
  if (now <= created) return 0;
  return ((now - created) / (target - created)) * 100;
}

/* ─── Focus View ──────────────────────────────────────────────────────── */
function activeDeadlines() {
  return deadlines.filter(d => !d.archived);
}

function renderFocus() {
  const stage = $('focusStage');
  const nav = $('focusNav');
  const list = activeDeadlines();

  if (list.length === 0) {
    stage.innerHTML = `
      <div class="focus-empty">
        <div class="empty-icon">◎</div>
        <h2>Нет активных дедлайнов</h2>
        <p>Добавь дедлайн, чтобы он появился здесь крупным планом</p>
        <button class="btn-add" onclick="openModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Добавить дедлайн
        </button>
      </div>`;
    nav.classList.add('hidden');
    return;
  }

  if (focusIndex >= list.length) focusIndex = 0;
  if (focusIndex < 0) focusIndex = list.length - 1;
  const dl = list[focusIndex];

  stage.innerHTML = focusCardHTML(dl);

  if (list.length > 1) {
    nav.classList.remove('hidden');
    $('focusDots').innerHTML = list
      .map((_, i) => `<button class="focus-dot ${i === focusIndex ? 'active' : ''}" data-i="${i}" aria-label="Дедлайн ${i + 1}"></button>`)
      .join('');
  } else {
    nav.classList.add('hidden');
  }
}

function focusCardHTML(dl) {
  const r = computeRemaining(dl.deadline_at);
  const color = dl.color || '#6366f1';
  const list = activeDeadlines();
  return `
    <div class="focus-card" data-id="${dl.id}" style="--card-color:${color}">
      <div class="focus-head">
        <span class="focus-counter">${focusIndex + 1} / ${list.length}</span>
        <span class="card-badge ${urgencyClass(r)}">${urgencyLabel(r)}</span>
      </div>
      <h1 class="focus-title">${escHtml(dl.title)}</h1>
      ${dl.description ? `<p class="focus-desc">${escHtml(dl.description)}</p>` : ''}
      <div class="focus-clock-wrap">
        <div class="focus-clock-label">${r.is_past ? 'Статус' : 'До дедлайна'}</div>
        ${clockHTML(r, { cls: 'xl', id: dl.id, compact: false })}
      </div>
      <div class="focus-progress">
        <div class="card-progress"><div class="card-progress-fill" style="width:${progressPct(dl)}%"></div></div>
        <span class="focus-progress-pct">${Math.round(progressPct(dl))}%</span>
      </div>
      <div class="focus-foot">
        <span class="focus-date">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          ${formatDate(dl.deadline_at)}
        </span>
        ${dl.reminders.length ? `<span class="focus-reminders">${dl.reminders.map(rem => `<span class="reminder-tag">${reminderLabel(rem)}</span>`).join('')}</span>` : ''}
      </div>
      <div class="focus-actions">
        <button class="btn-ghost" onclick="openDetail(${dl.id})">Подробнее</button>
        <button class="btn-primary" onclick="editFromFocus(${dl.id})">Редактировать</button>
      </div>
    </div>`;
}

function editFromFocus(id) {
  const dl = deadlines.find(d => d.id === id);
  if (dl) openModal(dl);
}

function focusGo(delta) {
  const list = activeDeadlines();
  if (list.length === 0) return;
  focusIndex = (focusIndex + delta + list.length) % list.length;
  renderFocus();
  startTicking();
}

/* ─── View Mode ───────────────────────────────────────────────────────── */
function applyViewMode() {
  $('focusView').classList.toggle('hidden', viewMode !== 'focus');
  $('gridView').classList.toggle('hidden', viewMode !== 'grid');
  document.querySelectorAll('#viewToggle .view-btn').forEach(b => {
    const on = b.dataset.mode === viewMode;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
}

function setViewMode(mode) {
  viewMode = mode;
  localStorage.setItem('viewMode', mode);
  applyViewMode();
  startTicking();
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
  $('archiveBtn').textContent = dl.archived ? 'Вернуть из архива' : 'Архивировать';

  $('detailBody').innerHTML = `
    <div class="detail-meta">
      <span class="detail-dot" style="background:${color}"></span>
      ${formatDate(dl.deadline_at)}
    </div>
    ${dl.description ? `<div class="detail-desc">${escHtml(dl.description)}</div>` : ''}
    <div class="detail-countdown" style="--card-color:${color}">
      <div class="detail-countdown-label">${r.is_past ? 'Статус' : 'До дедлайна'}</div>
      ${clockHTML(r, { cls: 'lg', compact: false })}
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
    const clock = $('detailOverlay').querySelector('.flip-clock');
    if (clock) tickClock(clock, computeRemaining(dl.deadline_at));
  }, 1000);

  $('detailOverlay').classList.remove('hidden');
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

  $('customIntervalRow').classList.add('hidden');
  document.querySelectorAll('.chip').forEach(c => {
    const offset = c.dataset.offset ? parseInt(c.dataset.offset) : null;
    const active = selectedReminders.some(r => r.type === 'before_minutes' && r.offset_minutes === offset);
    c.classList.toggle('active', active);
  });
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

/* ─── Archive / Restore ───────────────────────────────────────────────── */
$('archiveBtn').addEventListener('click', async () => {
  if (!currentDetailId) return;
  const dl = deadlines.find(d => d.id === currentDetailId);
  if (!dl) return;
  const next = !dl.archived;
  try {
    // Минимальный PUT только с archived: серверный update не трогает
    // напоминания (их синкает только форма редактирования), так что они
    // сохраняются.
    await apiFetch(`/deadlines/${currentDetailId}`, {
      method: 'PUT',
      body: JSON.stringify({ archived: next }),
    });
    toast(next ? 'Перенесено в архив' : 'Возвращено из архива');
    closeDetail();
    await loadDeadlines();
  } catch (e) {
    toast('Ошибка: ' + e.message, 'error');
  }
});

$('archiveToggle').addEventListener('click', () => {
  const grid = $('archiveGrid');
  const btn = $('archiveToggle');
  const open = grid.classList.toggle('hidden');
  btn.setAttribute('aria-expanded', String(!open));
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
  // Стрелки листают дедлайны в фокус-режиме (если не открыта модалка/поле ввода)
  if (viewMode === 'focus' && !document.querySelector('.modal-overlay:not(.hidden)')
      && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) {
    if (e.key === 'ArrowLeft') focusGo(-1);
    if (e.key === 'ArrowRight') focusGo(1);
  }
});

// Переключатель Фокус / Сетка
document.querySelectorAll('#viewToggle .view-btn').forEach(btn => {
  btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
});

// Навигация в фокус-режиме
$('focusPrev').addEventListener('click', () => focusGo(-1));
$('focusNext').addEventListener('click', () => focusGo(1));
$('focusDots').addEventListener('click', e => {
  const dot = e.target.closest('.focus-dot');
  if (!dot) return;
  focusIndex = parseInt(dot.dataset.i);
  renderFocus();
  startTicking();
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

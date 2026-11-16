import {
  PHASES, CUSTOM_COLORS, MAX_CUSTOM, DEFAULT_SETTINGS, DEFAULT_STATE, todayKey, phaseMs, formatMs,
  findCustom, isWork, phaseLabel, phaseMinutes, COLOR_SETS, IDEAS,
} from '../shared.js';

const $ = (id) => document.getElementById(id);
const R = 104;
const CIRC = 2 * Math.PI * R;
const PRESETS = { work: [15, 25, 45, 60], break: [5, 10, 15, 30] };
const tabOrder = () => ['focus', 'short', ...(settings.custom || []).map((c) => c.id)];
const MANTRAS = {
  focus: ['One thing at a time.', 'Deep work mode. Notifications can wait.', 'Small steps, steady progress.'],
  short: ['Stand up, stretch, breathe.', 'Look away from the screen for a bit.', 'Grab some water.'],
  rest: ['You earned this. Take a real break.', 'Walk around, reset your mind.', 'Rest is part of the work.'],
};

const progress = $('progress');
progress.style.strokeDasharray = CIRC;

let state = { ...DEFAULT_STATE };
let settings = { ...DEFAULT_SETTINGS };
let stats = {};
let raf = null;
let editing = false;

const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

// ---------- static ring ticks ----------
(function drawTicks() {
  const g = $('ticks');
  const ns = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0;
    const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
    const r1 = 120, r2 = major ? 126 : 123.5;
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', 130 + r1 * Math.cos(a));
    l.setAttribute('y1', 130 + r1 * Math.sin(a));
    l.setAttribute('x2', 130 + r2 * Math.cos(a));
    l.setAttribute('y2', 130 + r2 * Math.sin(a));
    if (major) l.classList.add('major');
    g.appendChild(l);
  }
})();

// ---------- data ----------
async function refresh() {
  const data = await chrome.storage.local.get(['state', 'settings', 'stats']);
  state = { ...DEFAULT_STATE, ...data.state };
  settings = { ...DEFAULT_SETTINGS, ...data.settings };
  stats = data.stats || {};
  render();
}

function totalMs() {
  return phaseMs(state.phase, settings);
}

function remainingMs() {
  if (state.status === 'running') return Math.max(0, state.endTime - Date.now());
  return state.remainingMs ?? totalMs();
}

// ---------- render ----------
function renderTime() {
  const left = remainingMs();
  const frac = Math.min(1, Math.max(0, left / Math.max(totalMs(), left, 1)));
  if (!editing) $('time').textContent = formatMs(left);
  progress.style.strokeDashoffset = CIRC * (1 - frac);
  $('head').style.transform = `rotate(${frac * 360 - 90}deg)`;
  if (state.status === 'running') {
    document.title = `${formatMs(left)} · ${phaseLabel(state.phase, settings)}`;
    raf = requestAnimationFrame(renderTime);
  }
}

function render() {
  cancelAnimationFrame(raf);
  const b = document.body;
  const custom = findCustom(state.phase, settings);
  b.dataset.phase = custom ? 'custom' : state.phase;
  if (custom) applyCustomColors(custom);
  for (const s of ['idle', 'running', 'paused']) b.classList.toggle(s, state.status === s);
  setCharged(isWork(state.phase, settings) && state.status === 'running');

  renderTabs();
  const idx = tabOrder().indexOf(state.phase);

  $('phaseLabel').textContent = state.status === 'paused' ? 'Paused' : phaseLabel(state.phase, settings);
  $('mainLabel').textContent = state.status === 'running' ? 'Pause' : state.status === 'paused' ? 'Resume' : 'Start';
  $('editHint').textContent = state.status === 'idle' ? 'click to edit' : 'click to change time left';

  // presets (shown when idle)
  const presets = $('presets');
  presets.replaceChildren(
    ...(state.status === 'idle' ? PRESETS[isWork(state.phase, settings) ? 'work' : 'break'] : []).map((m) => {
      const btn = document.createElement('button');
      btn.textContent = `${m} min`;
      if (phaseMinutes(state.phase, settings) === m) btn.className = 'on';
      btn.addEventListener('click', () => send('setMinutes', { minutes: m }));
      return btn;
    })
  );

  // mantra stays stable per phase within a popup open
  const list = MANTRAS[state.phase] || (custom?.kind === 'break' ? MANTRAS.rest : [`All in on ${custom?.name}.`, 'One task, full attention.', 'Small steps, steady progress.']);
  $('mantra').textContent = list[(new Date().getHours() + idx) % list.length];
  $('mantra').hidden = state.status === 'idle';
  presets.hidden = state.status !== 'idle';

  $('dots').hidden = true;

  // today + week
  const today = stats[todayKey()] || { sessions: 0, minutes: 0 };
  $('statSessions').textContent = today.sessions;
  $('statMinutes').textContent = Math.round(today.minutes);
  $('statStreak').textContent = streak();
  $('goalFill').style.width = `${Math.min(100, (today.sessions / settings.dailyGoal) * 100)}%`;
  $('goalText').textContent = `${today.sessions} of ${settings.dailyGoal}`;
  renderWeek();

  renderTime();
}

function renderWeek() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push({ n: stats[todayKey(d)]?.sessions || 0, today: i === 0, label: d.toLocaleDateString(undefined, { weekday: 'short' }) });
  }
  const max = Math.max(4, ...days.map((d) => d.n));
  $('week').replaceChildren(
    ...days.map((d) => {
      const i = document.createElement('i');
      i.style.height = `${Math.max(3, (d.n / max) * 36)}px`;
      i.title = `${d.label}: ${d.n} session${d.n === 1 ? '' : 's'}`;
      if (d.n) i.classList.add('has');
      if (d.today) i.classList.add('now');
      return i;
    })
  );
}

function streak() {
  let count = 0;
  const d = new Date();
  if (!stats[todayKey(d)]?.sessions) d.setDate(d.getDate() - 1);
  while (stats[todayKey(d)]?.sessions) {
    count++;
    d.setDate(d.getDate() - 1);
  }
  return count;
}

// ---------- tabs: Focus, Break, then your custom tabs ----------
function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function applyCustomColors(c) {
  const { a1, a2 } = CUSTOM_COLORS[c.color % CUSTOM_COLORS.length];
  const b = document.body.style;
  b.setProperty('--c1', a1);
  b.setProperty('--c2', a2);
  b.setProperty('--cglow', hexToRgba(a1, 0.35));
  b.setProperty('--ctint', hexToRgba(a1, 0.14));
}

function renderTabs() {
  const seg = $('seg');
  const customs = settings.custom || [];
  const pill = document.createElement('span');
  pill.className = 'seg-pill';
  pill.setAttribute('aria-hidden', 'true');
  const buttons = tabOrder().map((phase) => {
    const btn = document.createElement('button');
    btn.setAttribute('role', 'tab');
    btn.dataset.phase = phase;
    btn.setAttribute('aria-selected', String(phase === state.phase));
    const c = findCustom(phase, settings);
    if (c) {
      const sw = document.createElement('i');
      sw.className = 'swatch';
      sw.style.background = sw.style.color = CUSTOM_COLORS[c.color % CUSTOM_COLORS.length].a1;
      btn.append(sw, c.name);
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = '×';
      del.title = `Delete "${c.name}"`;
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteCustom(c.id);
      });
      btn.append(del);
    } else {
      btn.textContent = PHASES[phase].label;
    }
    btn.addEventListener('click', () => send('setPhase', { phase }));
    return btn;
  });
  seg.replaceChildren(pill, ...buttons);

  const addBtn = $('addBtn');
  addBtn.disabled = customs.length >= MAX_CUSTOM;
  addBtn.title = addBtn.disabled ? `Up to ${MAX_CUSTOM} custom tabs` : 'New tab (N)';

  if (justAdded) {
    const added = buttons.find((x) => x.dataset.phase === justAdded);
    if (added) {
      added.classList.add('pop');
      if (!sel0(added)) added.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    justAdded = null;
  }
  seg.classList.toggle('overflow', seg.scrollWidth > seg.clientWidth + 1);
  // Place the sliding pill under the selected tab and keep it in view.
  const sel = buttons.find((x) => x.dataset.phase === state.phase);
  if (sel) {
    pill.style.setProperty('--x', `${sel.offsetLeft}px`);
    pill.style.setProperty('--w', `${sel.offsetWidth}px`);
    const left = sel.offsetLeft - 8;
    const right = sel.offsetLeft + sel.offsetWidth + 8 - seg.clientWidth;
    if (seg.scrollLeft > left) seg.scrollLeft = left;
    else if (seg.scrollLeft < right) seg.scrollLeft = right;
  }
}
function sel0(el) {
  return el.getAttribute('aria-selected') === 'true';
}
$('seg').addEventListener('scroll', (e) => {
  const seg = e.currentTarget;
  seg.classList.toggle('at-end', seg.scrollLeft + seg.clientWidth >= seg.scrollWidth - 2);
});

let justAdded = null;
let addKind = 'work';

function openAddTab(kind) {
  if ((settings.custom || []).length >= MAX_CUSTOM || $('timerView').hidden) return;
  setAddKind(kind || 'work');
  $('addName').value = '';
  $('addTab').hidden = false;
  $('addBtn').classList.add('open');
  $('addName').focus();
}

function closeAddTab() {
  if ($('addTab').hidden) return;
  $('addTab').hidden = true;
  $('addBtn').classList.remove('open');
}

function setAddKind(kind) {
  addKind = kind;
  $('addTab').dataset.kind = kind;
  document.querySelectorAll('.cat button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
  $('addName').placeholder = kind === 'work' ? 'Name, e.g. PR Review' : 'Name, e.g. Coffee';
  $('addMin').value = kind === 'work' ? 25 : 10;
  const taken = new Set((settings.custom || []).map((c) => c.name.toLowerCase()));
  $('ideas').replaceChildren(
    ...IDEAS[kind]
      .filter(([name]) => !taken.has(name.toLowerCase()))
      .map(([name, mins]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = `<span></span><small>${mins}m</small>`;
        b.firstChild.textContent = name;
        b.title = `Add "${name}" (${mins} min)`;
        b.addEventListener('click', () => {
          closeAddTab();
          createCustom(name, mins, kind);
        });
        return b;
      })
  );
}

async function createCustom(name, minutes, kind = 'work') {
  const customs = [...(settings.custom || [])];
  const used = new Set(customs.map((c) => c.color));
  const pool = COLOR_SETS[kind];
  const color = pool.find((i) => !used.has(i)) ?? pool[customs.length % pool.length];
  const tab = { id: `c_${Date.now().toString(36)}`, name, minutes, color, kind };
  customs.push(tab);
  justAdded = tab.id;
  await chrome.storage.local.set({ settings: { ...settings, custom: customs } });
  await send('setPhase', { phase: tab.id });
}

async function deleteCustom(id) {
  const customs = (settings.custom || []).filter((c) => c.id !== id);
  await chrome.storage.local.set({ settings: { ...settings, custom: customs } });
}

$('addBtn').addEventListener('click', () => ($('addTab').hidden ? openAddTab() : closeAddTab()));
document.querySelectorAll('.cat button').forEach((b) => b.addEventListener('click', () => {
  setAddKind(b.dataset.kind);
  $('addName').focus();
}));
document.addEventListener('pointerdown', (e) => {
  if (!$('addTab').hidden && !e.target.closest('#addTab, #addBtn')) closeAddTab();
});
$('addCancel').addEventListener('click', closeAddTab);
$('addTab').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAddTab(); }
  else if (e.key === 'Tab' && e.shiftKey && e.target === $('addName')) { e.preventDefault(); setAddKind(addKind === 'work' ? 'break' : 'work'); }
});
$('addTab').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('addName').value.trim().replace(/\s+/g, ' ');
  const minutes = Math.min(180, Math.max(1, Math.round(Number($('addMin').value) || 25)));
  if (!name) return $('addName').focus();
  closeAddTab();
  await createCustom(name, minutes, addKind);
});

// ---------- charged focus: a bold lightning bolt strikes across the dial ----------
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let charged = false;
let strikeTimer = null;

function setCharged(on) {
  if (on === charged) return;
  charged = on;
  document.body.classList.toggle('charged', on);
  clearTimeout(strikeTimer);
  if (on && !reducedMotion) strikeTimer = setTimeout(strikeLoop, 250); // strike as focus starts
}

function strikeLoop() {
  if (!charged) return;
  strike();
  strikeTimer = setTimeout(strikeLoop, 5000 + Math.random() * 4000);
}

function strike() {
  const bolt = $('bolt');
  bolt.classList.remove('strike');
  void bolt.getBoundingClientRect(); // restart the animation
  bolt.classList.add('strike');
}

// ---------- editable time ----------
const timeBtn = $('time');
const editForm = $('timeEdit');
const input = $('timeInput');

function openEditor() {
  if (editing) return;
  editing = true;
  const left = remainingMs();
  const secs = Math.ceil(left / 1000);
  input.value = secs % 60 === 0 ? String(secs / 60) : formatMs(left);
  timeBtn.hidden = true;
  editForm.hidden = false;
  $('editHint').textContent = 'Enter to save · Esc to cancel';
  $('editHint').classList.add('on');
  input.focus();
  input.select();
}

function closeEditor() {
  editing = false;
  editForm.hidden = true;
  timeBtn.hidden = false;
  $('editHint').classList.remove('on');
  render();
}

// Accepts "25", "25:30", "1:05", "90" (minutes); returns minutes or null.
function parseTime(v) {
  const t = v.trim().replace(/[.,]/g, ':');
  let m;
  if ((m = t.match(/^(\d{1,3})$/))) return Number(m[1]);
  if ((m = t.match(/^(\d{1,3}):(\d{1,2})$/))) return Number(m[1]) + Math.min(59, Number(m[2])) / 60;
  return null;
}

timeBtn.addEventListener('click', openEditor);
input.addEventListener('input', () => {
  input.value = input.value.replace(/[^\d:.,]/g, '').slice(0, 6);
});
editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const minutes = parseTime(input.value);
  if (minutes && minutes > 0 && minutes <= 180) {
    await send('setMinutes', { minutes });
    closeEditor();
  } else {
    input.animate([{ transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'none' }], { duration: 220 });
  }
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeEditor();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const cur = parseTime(input.value) ?? remainingMs() / 60000;
    const step = (e.shiftKey ? 5 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
    input.value = String(Math.min(180, Math.max(1, Math.round(cur) + step)));
  }
});
input.addEventListener('blur', () => {
  if (!editing) return;
  const m = parseTime(input.value);
  if (m && m > 0 && m <= 180) editForm.requestSubmit();
  else closeEditor();
});

function nudge(deltaMin) {
  const cur = remainingMs() / 60000;
  const next = state.status === 'idle' ? Math.round(cur) + deltaMin : cur + deltaMin;
  send('setMinutes', { minutes: Math.min(180, Math.max(1, next)) });
}

// ---------- controls ----------
$('mainBtn').addEventListener('click', () => send(state.status === 'running' ? 'pause' : 'start'));
$('resetBtn').addEventListener('click', () => send('reset'));
$('skipBtn').addEventListener('click', () => send('skip'));

document.addEventListener('keydown', (e) => {
  if (editing || $('timerView').hidden || e.target.closest('input')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (e.code === 'Space') { e.preventDefault(); $('mainBtn').click(); }
  else if (k === 'arrowup') { e.preventDefault(); nudge(e.shiftKey ? 5 : 1); }
  else if (k === 'arrowdown') { e.preventDefault(); nudge(e.shiftKey ? -5 : -1); }
  else if (k === 'e' || k === 'enter') { e.preventDefault(); openEditor(); }
  else if (k === 'r') send('reset');
  else if (k === 's') send('skip');
  else if (k === 'n') { e.preventDefault(); openAddTab(); }
  else if (k === 'b') { e.preventDefault(); openAddTab('break'); }
  else if (k === 'arrowleft' || k === 'arrowright') {
    e.preventDefault();
    const order = tabOrder();
    const i = order.indexOf(state.phase) + (k === 'arrowright' ? 1 : -1);
    send('setPhase', { phase: order[(i + order.length) % order.length] });
  }
  else if (/^\d$/.test(k)) openEditor(); // the typed digit replaces the selected value
});

// ---------- settings ----------
const form = $('settingsForm');
function renderCustomRows() {
  const g = $('customGroup');
  const customs = settings.custom || [];
  if (!customs.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'No custom tabs yet. Use + next to the tabs to add a Focus tab like "PR Review" or a Break like "Coffee".';
    return g.replaceChildren(p);
  }
  g.replaceChildren(
    ...customs.map((c) => {
      const row = document.createElement('div');
      row.className = 'crow';
      row.dataset.id = c.id;
      row.innerHTML = `<i class="swatch"></i><span class="kind" title="${c.kind === 'break' ? 'Break' : 'Focus'}">${c.kind === 'break' ? '☕' : '⚡'}</span><input class="cname" maxlength="18" aria-label="Tab name" />
        <span class="num"><button type="button" data-step="-1">−</button><input type="number" class="cmin" min="1" max="180" aria-label="Minutes" /><button type="button" data-step="1">+</button></span>
        <button type="button" class="remove" title="Delete tab" aria-label="Delete tab">×</button>`;
      row.querySelector('.swatch').style.background = CUSTOM_COLORS[c.color % CUSTOM_COLORS.length].a1;
      row.querySelector('.cname').value = c.name;
      row.querySelector('.cmin').value = Math.round(c.minutes * 100) / 100;
      row.querySelector('.remove').addEventListener('click', () => row.remove());
      return row;
    })
  );
}

function showSettings(show) {
  closeAddTab();
  $('timerView').hidden = show;
  $('settingsView').hidden = !show;
  if (!show) return render();
  renderCustomRows();
  for (const [k, v] of Object.entries(settings)) {
    const el = form.elements[k];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = Math.round(Number(v) * 100) / 100;
  }
}
$('settingsBtn').addEventListener('click', () => showSettings($('settingsView').hidden));
$('backBtn').addEventListener('click', () => showSettings(false));
form.addEventListener('click', (e) => {
  const step = e.target.closest('[data-step]');
  if (!step) return;
  const el = step.parentElement.querySelector('input');
  el.value = Math.min(Number(el.max), Math.max(Number(el.min), Math.round(Number(el.value) || 0) + Number(step.dataset.step)));
});
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = { ...settings };
  next.custom = [...$('customGroup').querySelectorAll('.crow')].map((row) => {
    const old = findCustom(row.dataset.id, settings);
    const mins = Number(row.querySelector('.cmin').value);
    return {
      ...old,
      name: row.querySelector('.cname').value.trim() || old.name,
      minutes: Number.isFinite(mins) && mins > 0 ? Math.min(180, mins) : old.minutes,
    };
  });
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') next[el.name] = el.checked;
    else {
      const n = Number(el.value);
      next[el.name] = Number.isFinite(n) && n > 0 ? Math.min(Number(el.max), Math.max(Number(el.min), n)) : DEFAULT_SETTINGS[el.name];
    }
  }
  await chrome.storage.local.set({ settings: next });
  showSettings(false);
});

chrome.storage.onChanged.addListener((_c, area) => area === 'local' && refresh());
refresh();

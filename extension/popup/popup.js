import { PHASES, DEFAULT_SETTINGS, DEFAULT_STATE, todayKey, phaseMs, formatMs } from '../shared.js';

const $ = (id) => document.getElementById(id);
const R = 104;
const CIRC = 2 * Math.PI * R;
const PHASE_ORDER = ['focus', 'short', 'long'];
const PRESETS = { focus: [15, 25, 45, 60], short: [3, 5, 10], long: [15, 20, 30] };
const MANTRAS = {
  focus: ['One thing at a time.', 'Deep work mode. Notifications can wait.', 'Small steps, steady progress.'],
  short: ['Stand up, stretch, breathe.', 'Look away from the screen for a bit.', 'Grab some water.'],
  long: ['You earned this. Take a real break.', 'Walk around, reset your mind.', 'Rest is part of the work.'],
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
    document.title = `${formatMs(left)} · ${PHASES[state.phase].label}`;
    raf = requestAnimationFrame(renderTime);
  }
}

function render() {
  cancelAnimationFrame(raf);
  const b = document.body;
  b.dataset.phase = state.phase;
  for (const s of ['idle', 'running', 'paused']) b.classList.toggle(s, state.status === s);
  setCharged(state.phase === 'focus' && state.status === 'running');

  // segmented control
  const idx = PHASE_ORDER.indexOf(state.phase);
  document.querySelector('.seg').style.setProperty('--i', idx);
  document.querySelectorAll('.seg button').forEach((btn) =>
    btn.setAttribute('aria-selected', String(btn.dataset.phase === state.phase))
  );

  $('phaseLabel').textContent = state.status === 'paused' ? 'Paused' : PHASES[state.phase].label;
  $('mainLabel').textContent = state.status === 'running' ? 'Pause' : state.status === 'paused' ? 'Resume' : 'Start';
  $('editHint').textContent = state.status === 'idle' ? 'click to edit' : 'click to change time left';

  // presets (shown when idle)
  const presets = $('presets');
  presets.replaceChildren(
    ...(state.status === 'idle' ? PRESETS[state.phase] : []).map((m) => {
      const btn = document.createElement('button');
      btn.textContent = `${m} min`;
      if (Number(settings[state.phase]) === m) btn.className = 'on';
      btn.addEventListener('click', () => send('setMinutes', { minutes: m }));
      return btn;
    })
  );

  // mantra stays stable per phase within a popup open
  const list = MANTRAS[state.phase];
  $('mantra').textContent = list[(new Date().getHours() + idx) % list.length];
  $('mantra').hidden = state.status === 'idle';
  presets.hidden = state.status !== 'idle';

  // cycle dots
  $('dots').replaceChildren(
    ...Array.from({ length: settings.longEvery }, (_, i) => {
      const d = document.createElement('i');
      if (i < state.cycle) d.className = 'on';
      return d;
    })
  );

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

// ---------- lightning: a charged look while a focus session is running ----------
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let charged = false;
let strikeTimer = null;

function setCharged(on) {
  if (on === charged) return;
  charged = on;
  document.body.classList.toggle('charged', on);
  clearTimeout(strikeTimer);
  if (on && !reducedMotion) {
    strikeTimer = setTimeout(strikeLoop, 350); // a first strike right as focus starts
  }
}

function strikeLoop() {
  if (!charged) return;
  strike();
  if (Math.random() < 0.35) setTimeout(strike, 180 + Math.random() * 220); // occasional double strike
  strikeTimer = setTimeout(strikeLoop, 3200 + Math.random() * 4500);
}

// Builds a jagged bolt from a point on the ring outward, with a small branch.
function boltPoints(angle, r0, r1, segs, jitter) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const r = r0 + (r1 - r0) * t;
    const off = i === 0 ? 0 : (Math.random() - 0.5) * jitter * (1 - t * 0.3);
    const a = angle + off / r;
    pts.push([130 + r * Math.cos(a), 130 + r * Math.sin(a)]);
  }
  return pts;
}

function strike() {
  const svg = $('bolts');
  const ns = 'http://www.w3.org/2000/svg';
  // Mostly strike from the ring's moving head, sometimes from anywhere on the ring.
  const frac = Math.min(1, remainingMs() / Math.max(totalMs(), 1));
  const headAngle = (frac * 360 - 90) * (Math.PI / 180);
  const angle = Math.random() < 0.6 ? headAngle : Math.random() * Math.PI * 2;

  const main = boltPoints(angle, 112, 160 + Math.random() * 26, 8, 36);
  const k = 2 + Math.floor(Math.random() * 3);
  const [bx, by] = main[k];
  const bAngle = Math.atan2(by - 130, bx - 130) + (Math.random() < 0.5 ? -0.35 : 0.35);
  const branch = boltPoints(bAngle, Math.hypot(bx - 130, by - 130), 158, 4, 20);
  branch[0] = [bx, by];

  const g = document.createElementNS(ns, 'g');
  for (const pts of [main, branch]) {
    const d = 'M' + pts.map((p) => p.map((n) => n.toFixed(1)).join(' ')).join(' L');
    for (const cls of ['glow', 'core']) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', cls);
      if (pts === branch) path.style.strokeWidth = cls === 'core' ? '1' : '4';
      g.appendChild(path);
    }
  }
  svg.appendChild(g);
  setTimeout(() => g.remove(), 850);

  // Screen flash centred on the strike, and a quick surge on the ring.
  const flash = $('flash');
  const dial = document.querySelector('.dial').getBoundingClientRect();
  const fx = dial.left + dial.width / 2 + Math.cos(angle) * dial.width * 0.55;
  const fy = dial.top + dial.height / 2 + Math.sin(angle) * dial.height * 0.55;
  flash.style.setProperty('--fx', `${(fx / innerWidth) * 100}%`);
  flash.style.setProperty('--fy', `${(fy / innerHeight) * 100}%`);
  flash.classList.remove('on');
  void flash.offsetWidth;
  flash.classList.add('on');
  document.body.classList.add('zapped');
  setTimeout(() => document.body.classList.remove('zapped'), 260);
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
document.querySelectorAll('.seg button').forEach((btn) =>
  btn.addEventListener('click', () => send('setPhase', { phase: btn.dataset.phase }))
);

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
  else if (k === 'arrowleft' || k === 'arrowright') {
    e.preventDefault();
    const i = PHASE_ORDER.indexOf(state.phase) + (k === 'arrowright' ? 1 : -1);
    send('setPhase', { phase: PHASE_ORDER[(i + 3) % 3] });
  }
  else if (/^\d$/.test(k)) openEditor(); // the typed digit replaces the selected value
});

// ---------- settings ----------
const form = $('settingsForm');
function showSettings(show) {
  $('timerView').hidden = show;
  $('settingsView').hidden = !show;
  if (!show) return;
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

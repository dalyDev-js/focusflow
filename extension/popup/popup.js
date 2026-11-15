import { PHASES, DEFAULT_SETTINGS, DEFAULT_STATE, todayKey, phaseMs, formatMs } from '../shared.js';

const $ = (id) => document.getElementById(id);
const app = $('app');
const progress = $('progress');
const CIRC = 2 * Math.PI * 96;
progress.style.strokeDasharray = CIRC;

let state = { ...DEFAULT_STATE };
let settings = { ...DEFAULT_SETTINGS };
let stats = {};
let raf = null;

const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });

async function refresh() {
  const data = await chrome.storage.local.get(['state', 'settings', 'stats']);
  state = { ...DEFAULT_STATE, ...data.state };
  settings = { ...DEFAULT_SETTINGS, ...data.settings };
  stats = data.stats || {};
  render();
}

function remainingMs() {
  if (state.status === 'running') return Math.max(0, state.endTime - Date.now());
  return state.remainingMs ?? phaseMs(state.phase, settings);
}

function renderTime() {
  const total = phaseMs(state.phase, settings);
  const left = remainingMs();
  $('time').textContent = formatMs(left);
  progress.style.strokeDashoffset = CIRC * (1 - left / total);
  if (state.status === 'running') raf = requestAnimationFrame(renderTime);
}

function render() {
  cancelAnimationFrame(raf);
  app.dataset.phase = state.phase;
  app.classList.toggle('running', state.status === 'running');
  app.classList.toggle('paused', state.status === 'paused');

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.setAttribute('aria-selected', String(b.dataset.phase === state.phase));
  });
  $('phaseLabel').textContent = state.status === 'paused' ? 'Paused' : PHASES[state.phase].label;
  $('mainBtn').textContent =
    state.status === 'running' ? 'Pause' : state.status === 'paused' ? 'Resume' : 'Start';

  const dots = $('dots');
  dots.replaceChildren(
    ...Array.from({ length: settings.longEvery }, (_, i) => {
      const d = document.createElement('i');
      if (i < state.cycle) d.className = 'on';
      return d;
    })
  );

  const today = stats[todayKey()] || { sessions: 0, minutes: 0 };
  $('statSessions').textContent = today.sessions;
  $('statMinutes').textContent = today.minutes;
  $('statStreak').textContent = streak();
  $('goalFill').style.width = `${Math.min(100, (today.sessions / settings.dailyGoal) * 100)}%`;
  $('goalText').textContent = `${today.sessions} / ${settings.dailyGoal} daily goal`;

  renderTime();
}

function streak() {
  let count = 0;
  const d = new Date();
  if (!stats[todayKey(d)]?.sessions) d.setDate(d.getDate() - 1); // today not done yet is fine
  while (stats[todayKey(d)]?.sessions) {
    count++;
    d.setDate(d.getDate() - 1);
  }
  return count;
}

// ---------- timer controls ----------
$('mainBtn').addEventListener('click', () => send(state.status === 'running' ? 'pause' : 'start'));
$('resetBtn').addEventListener('click', () => send('reset'));
$('skipBtn').addEventListener('click', () => send('skip'));
document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => send('setPhase', { phase: b.dataset.phase }))
);
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !$('timerView').hidden) {
    e.preventDefault();
    $('mainBtn').click();
  }
});

// ---------- settings ----------
const form = $('settingsForm');
function showSettings(show) {
  $('timerView').hidden = show;
  $('settingsView').hidden = !show;
  if (show) {
    for (const [k, v] of Object.entries(settings)) {
      const el = form.elements[k];
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = v;
    }
  }
}
$('settingsBtn').addEventListener('click', () => showSettings($('settingsView').hidden));
$('cancelSettings').addEventListener('click', () => showSettings(false));
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = { ...settings };
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') next[el.name] = el.checked;
    else {
      const n = Math.round(Number(el.value));
      const min = Number(el.min), max = Number(el.max);
      next[el.name] = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : DEFAULT_SETTINGS[el.name];
    }
  }
  await chrome.storage.local.set({ settings: next });
  showSettings(false);
});

chrome.storage.onChanged.addListener((_c, area) => area === 'local' && refresh());
refresh();

import {
  COLOR_SETS,
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  IDEAS,
  MAX_CUSTOM,
  PHASES,
  type CustomTab,
  type Kind,
  type Message,
  type Phase,
  type Settings,
  type Stats,
  type TimerState,
  customColors,
  findCustom,
  formatMs,
  isBuiltIn,
  isWork,
  loadAll,
  phaseLabel,
  phaseMinutes,
  phaseMs,
  todayKey,
} from '../shared';

/** Looks up an element by id; the popup markup is static, so a miss is a bug. */
function $<T extends Element = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from popup.html`);
  return el as unknown as T;
}

const R = 104;
const CIRC = 2 * Math.PI * R;
const PRESETS: Record<Kind, number[]> = { work: [15, 25, 45, 60], break: [5, 10, 15, 30] };
const MANTRAS = {
  focus: ['One thing at a time.', 'Deep work mode. Notifications can wait.', 'Small steps, steady progress.'],
  short: ['Stand up, stretch, breathe.', 'Look away from the screen for a bit.', 'Grab some water.'],
  rest: ['You earned this. Take a real break.', 'Walk around, reset your mind.', 'Rest is part of the work.'],
};

const progress = $<SVGCircleElement>('progress');
progress.style.strokeDasharray = String(CIRC);

let state: TimerState = { ...DEFAULT_STATE };
let settings: Settings = { ...DEFAULT_SETTINGS };
let stats: Stats = {};
let raf = 0;
let editing = false;

const send = (msg: Message): Promise<unknown> => chrome.runtime.sendMessage(msg);
const tabOrder = (): Phase[] => ['focus', 'short', ...settings.custom.map((c) => c.id)];

// ---------- static ring ticks ----------
(function drawTicks() {
  const g = $<SVGGElement>('ticks');
  const ns = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0;
    const a = (i / 60) * Math.PI * 2 - Math.PI / 2;
    const r1 = 120;
    const r2 = major ? 126 : 123.5;
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', String(130 + r1 * Math.cos(a)));
    l.setAttribute('y1', String(130 + r1 * Math.sin(a)));
    l.setAttribute('x2', String(130 + r2 * Math.cos(a)));
    l.setAttribute('y2', String(130 + r2 * Math.sin(a)));
    if (major) l.classList.add('major');
    g.appendChild(l);
  }
})();

// ---------- data ----------
async function refresh(): Promise<void> {
  ({ state, settings, stats } = await loadAll());
  render();
}

const totalMs = (): number => phaseMs(state.phase, settings);

function remainingMs(): number {
  if (state.status === 'running' && state.endTime !== null) return Math.max(0, state.endTime - Date.now());
  return state.remainingMs ?? totalMs();
}

// ---------- render ----------
function renderTime(): void {
  const left = remainingMs();
  const frac = Math.min(1, Math.max(0, left / Math.max(totalMs(), left, 1)));
  if (!editing) $('time').textContent = formatMs(left);
  progress.style.strokeDashoffset = String(CIRC * (1 - frac));
  $<SVGGElement>('head').style.transform = `rotate(${frac * 360 - 90}deg)`;
  if (state.status === 'running') {
    document.title = `${formatMs(left)} · ${phaseLabel(state.phase, settings)}`;
    raf = requestAnimationFrame(renderTime);
  }
}

function render(): void {
  cancelAnimationFrame(raf);
  const b = document.body;
  const custom = findCustom(state.phase, settings);
  b.dataset.phase = custom ? 'custom' : state.phase;
  if (custom) applyCustomColors(custom);
  for (const s of ['idle', 'running', 'paused'] as const) b.classList.toggle(s, state.status === s);
  setCharged(isWork(state.phase, settings) && state.status === 'running');

  renderTabs();
  const idx = Math.max(0, tabOrder().indexOf(state.phase));

  $('phaseLabel').textContent = state.status === 'paused' ? 'Paused' : phaseLabel(state.phase, settings);
  $('mainLabel').textContent = state.status === 'running' ? 'Pause' : state.status === 'paused' ? 'Resume' : 'Start';
  $('editHint').textContent = state.status === 'idle' ? 'click to edit' : 'click to change time left';

  // Presets (shown when idle) or a mantra (while a session runs).
  const presets = $('presets');
  const kind: Kind = isWork(state.phase, settings) ? 'work' : 'break';
  presets.replaceChildren(
    ...(state.status === 'idle' ? PRESETS[kind] : []).map((m) => {
      const btn = document.createElement('button');
      btn.textContent = `${m} min`;
      if (phaseMinutes(state.phase, settings) === m) btn.className = 'on';
      btn.addEventListener('click', () => void send({ type: 'setMinutes', minutes: m }));
      return btn;
    })
  );
  const list =
    isBuiltIn(state.phase)
      ? MANTRAS[state.phase]
      : custom?.kind === 'break'
        ? MANTRAS.rest
        : [`All in on ${custom?.name ?? 'this'}.`, 'One task, full attention.', 'Small steps, steady progress.'];
  $('mantra').textContent = list[(new Date().getHours() + idx) % list.length];
  $('mantra').hidden = state.status === 'idle';
  presets.hidden = state.status !== 'idle';
  $('dots').hidden = true;

  // Today + week
  const today = stats[todayKey()] ?? { sessions: 0, minutes: 0 };
  $('statSessions').textContent = String(today.sessions);
  $('statMinutes').textContent = String(Math.round(today.minutes));
  $('statStreak').textContent = String(streak());
  $('goalFill').style.width = `${Math.min(100, (today.sessions / settings.dailyGoal) * 100)}%`;
  $('goalText').textContent = `${today.sessions} of ${settings.dailyGoal}`;
  renderWeek();

  renderTime();
}

function renderWeek(): void {
  const days = Array.from({ length: 7 }, (_, k) => {
    const i = 6 - k;
    const d = new Date();
    d.setDate(d.getDate() - i);
    return {
      n: stats[todayKey(d)]?.sessions ?? 0,
      today: i === 0,
      label: d.toLocaleDateString(undefined, { weekday: 'short' }),
    };
  });
  const max = Math.max(4, ...days.map((d) => d.n));
  $('week').replaceChildren(
    ...days.map((d) => {
      const bar = document.createElement('i');
      bar.style.height = `${Math.max(3, (d.n / max) * 36)}px`;
      bar.title = `${d.label}: ${d.n} session${d.n === 1 ? '' : 's'}`;
      if (d.n) bar.classList.add('has');
      if (d.today) bar.classList.add('now');
      return bar;
    })
  );
}

function streak(): number {
  let count = 0;
  const d = new Date();
  if (!stats[todayKey(d)]?.sessions) d.setDate(d.getDate() - 1); // today not done yet is fine
  while (stats[todayKey(d)]?.sessions) {
    count++;
    d.setDate(d.getDate() - 1);
  }
  return count;
}

// ---------- tabs: Focus, Break, then your custom tabs ----------
function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function applyCustomColors(tab: CustomTab): void {
  const { a1, a2 } = customColors(tab);
  const s = document.body.style;
  s.setProperty('--c1', a1);
  s.setProperty('--c2', a2);
  s.setProperty('--cglow', hexToRgba(a1, 0.35));
  s.setProperty('--ctint', hexToRgba(a1, 0.14));
}

let justAdded: string | null = null;
let addKind: Kind = 'work';

function renderTabs(): void {
  const seg = $('seg');
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
      sw.style.background = sw.style.color = customColors(c).a1;
      const del = document.createElement('span');
      del.className = 'del';
      del.textContent = '×';
      del.title = `Delete "${c.name}"`;
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        void deleteCustom(c.id);
      });
      btn.append(sw, c.name, del);
    } else if (isBuiltIn(phase)) {
      btn.textContent = PHASES[phase].label;
    }
    btn.addEventListener('click', () => void send({ type: 'setPhase', phase }));
    return btn;
  });
  seg.replaceChildren(pill, ...buttons);

  const addBtn = $<HTMLButtonElement>('addBtn');
  addBtn.disabled = settings.custom.length >= MAX_CUSTOM;
  addBtn.title = addBtn.disabled ? `Up to ${MAX_CUSTOM} custom tabs` : 'New tab (N)';

  if (justAdded) {
    buttons.find((x) => x.dataset.phase === justAdded)?.classList.add('pop');
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

$('seg').addEventListener('scroll', (e) => {
  const seg = e.currentTarget as HTMLElement;
  seg.classList.toggle('at-end', seg.scrollLeft + seg.clientWidth >= seg.scrollWidth - 2);
});

// ---------- + menu: create a Focus or Break tab ----------
const addForm = $<HTMLFormElement>('addTab');
const addName = $<HTMLInputElement>('addName');
const addMin = $<HTMLInputElement>('addMin');

function openAddTab(kind: Kind = 'work'): void {
  if (settings.custom.length >= MAX_CUSTOM || $('timerView').hidden) return;
  setAddKind(kind);
  addName.value = '';
  addForm.hidden = false;
  $('addBtn').classList.add('open');
  addName.focus();
}

function closeAddTab(): void {
  if (addForm.hidden) return;
  addForm.hidden = true;
  $('addBtn').classList.remove('open');
}

function setAddKind(kind: Kind): void {
  addKind = kind;
  addForm.dataset.kind = kind;
  document
    .querySelectorAll<HTMLButtonElement>('.cat button')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.kind === kind)));
  addName.placeholder = kind === 'work' ? 'Name, e.g. PR Review' : 'Name, e.g. Coffee';
  addMin.value = kind === 'work' ? '25' : '10';
  const taken = new Set(settings.custom.map((c) => c.name.toLowerCase()));
  $('ideas').replaceChildren(
    ...IDEAS[kind]
      .filter(([name]) => !taken.has(name.toLowerCase()))
      .map(([name, mins]) => {
        const b = document.createElement('button');
        b.type = 'button';
        const label = document.createElement('span');
        label.textContent = name;
        const small = document.createElement('small');
        small.textContent = `${mins}m`;
        b.append(label, small);
        b.title = `Add "${name}" (${mins} min)`;
        b.addEventListener('click', () => {
          closeAddTab();
          void createCustom(name, mins, kind);
        });
        return b;
      })
  );
}

async function createCustom(name: string, minutes: number, kind: Kind): Promise<void> {
  const used = new Set(settings.custom.map((c) => c.color));
  const pool = COLOR_SETS[kind];
  const color = pool.find((i) => !used.has(i)) ?? pool[settings.custom.length % pool.length];
  const tab: CustomTab = { id: `c_${Date.now().toString(36)}`, name, minutes, color, kind };
  justAdded = tab.id;
  await chrome.storage.local.set({ settings: { ...settings, custom: [...settings.custom, tab] } });
  await send({ type: 'setPhase', phase: tab.id });
}

async function deleteCustom(id: string): Promise<void> {
  await chrome.storage.local.set({ settings: { ...settings, custom: settings.custom.filter((c) => c.id !== id) } });
}

$('addBtn').addEventListener('click', () => (addForm.hidden ? openAddTab() : closeAddTab()));
document.querySelectorAll<HTMLButtonElement>('.cat button').forEach((b) =>
  b.addEventListener('click', () => {
    setAddKind(b.dataset.kind === 'break' ? 'break' : 'work');
    addName.focus();
  })
);
document.addEventListener('pointerdown', (e) => {
  if (!addForm.hidden && !(e.target as Element).closest('#addTab, #addBtn')) closeAddTab();
});
$('addCancel').addEventListener('click', closeAddTab);
addForm.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeAddTab();
  } else if (e.key === 'Tab' && e.shiftKey && e.target === addName) {
    e.preventDefault();
    setAddKind(addKind === 'work' ? 'break' : 'work');
  }
});
addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = addName.value.trim().replace(/\s+/g, ' ');
  const minutes = Math.min(180, Math.max(1, Math.round(Number(addMin.value) || 25)));
  if (!name) return addName.focus();
  closeAddTab();
  void createCustom(name, minutes, addKind);
});

// ---------- charged focus: the bolt beside the logo strikes every few seconds ----------
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let charged = false;
let strikeTimer: ReturnType<typeof setTimeout> | undefined;

function setCharged(on: boolean): void {
  if (on === charged) return;
  charged = on;
  document.body.classList.toggle('charged', on);
  clearTimeout(strikeTimer);
  if (on && !reducedMotion) strikeTimer = setTimeout(strikeLoop, 250); // strike as focus starts
}

function strikeLoop(): void {
  if (!charged) return;
  const bolt = $<SVGSVGElement>('bolt');
  bolt.classList.remove('strike');
  void bolt.getBoundingClientRect(); // restart the animation
  bolt.classList.add('strike');
  strikeTimer = setTimeout(strikeLoop, 5000 + Math.random() * 4000);
}

// ---------- editable time ----------
const timeBtn = $<HTMLButtonElement>('time');
const editForm = $<HTMLFormElement>('timeEdit');
const input = $<HTMLInputElement>('timeInput');

function openEditor(): void {
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

function closeEditor(): void {
  editing = false;
  editForm.hidden = true;
  timeBtn.hidden = false;
  $('editHint').classList.remove('on');
  render();
}

/** Accepts "25", "25:30", "1:05", "90" (minutes) and returns minutes, or null. */
function parseTime(v: string): number | null {
  const t = v.trim().replace(/[.,]/g, ':');
  let m = t.match(/^(\d{1,3})$/);
  if (m) return Number(m[1]);
  m = t.match(/^(\d{1,3}):(\d{1,2})$/);
  if (m) return Number(m[1]) + Math.min(59, Number(m[2])) / 60;
  return null;
}

const validMinutes = (m: number | null): m is number => m !== null && m > 0 && m <= 180;

timeBtn.addEventListener('click', openEditor);
input.addEventListener('input', () => {
  input.value = input.value.replace(/[^\d:.,]/g, '').slice(0, 6);
});
editForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const minutes = parseTime(input.value);
  if (validMinutes(minutes)) {
    void send({ type: 'setMinutes', minutes }).then(closeEditor);
  } else {
    input.animate([{ transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'none' }], {
      duration: 220,
    });
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
  if (validMinutes(parseTime(input.value))) editForm.requestSubmit();
  else closeEditor();
});

function nudge(deltaMin: number): void {
  const cur = remainingMs() / 60000;
  const next = state.status === 'idle' ? Math.round(cur) + deltaMin : cur + deltaMin;
  void send({ type: 'setMinutes', minutes: Math.min(180, Math.max(1, next)) });
}

// ---------- controls & keyboard ----------
$('mainBtn').addEventListener('click', () => void send({ type: state.status === 'running' ? 'pause' : 'start' }));
$('resetBtn').addEventListener('click', () => void send({ type: 'reset' }));
$('skipBtn').addEventListener('click', () => void send({ type: 'skip' }));

document.addEventListener('keydown', (e) => {
  if (editing || $('timerView').hidden || (e.target as Element).closest('input')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (e.code === 'Space') {
    e.preventDefault();
    $('mainBtn').click();
  } else if (k === 'arrowup' || k === 'arrowdown') {
    e.preventDefault();
    nudge((e.shiftKey ? 5 : 1) * (k === 'arrowup' ? 1 : -1));
  } else if (k === 'e' || k === 'enter') {
    e.preventDefault();
    openEditor();
  } else if (k === 'r') {
    void send({ type: 'reset' });
  } else if (k === 's') {
    void send({ type: 'skip' });
  } else if (k === 'n' || k === 'b') {
    e.preventDefault();
    openAddTab(k === 'b' ? 'break' : 'work');
  } else if (k === 'arrowleft' || k === 'arrowright') {
    e.preventDefault();
    const order = tabOrder();
    const i = order.indexOf(state.phase) + (k === 'arrowright' ? 1 : -1);
    void send({ type: 'setPhase', phase: order[(i + order.length) % order.length] });
  } else if (/^\d$/.test(k)) {
    openEditor(); // the typed digit replaces the selected value
  }
});

// ---------- settings ----------
const form = $<HTMLFormElement>('settingsForm');
type NumericSetting = 'focus' | 'short' | 'dailyGoal';
type BoolSetting = 'autoStartBreaks' | 'autoStartFocus' | 'sound';
const NUMERIC: NumericSetting[] = ['focus', 'short', 'dailyGoal'];
const BOOLEAN: BoolSetting[] = ['autoStartBreaks', 'autoStartFocus', 'sound'];
const field = (name: string): HTMLInputElement => form.elements.namedItem(name) as HTMLInputElement;

function renderCustomRows(): void {
  const g = $('customGroup');
  if (!settings.custom.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'No custom tabs yet. Use + next to the tabs to add a Focus tab like "PR Review" or a Break like "Coffee".';
    g.replaceChildren(p);
    return;
  }
  g.replaceChildren(
    ...settings.custom.map((c) => {
      const row = document.createElement('div');
      row.className = 'crow';
      row.dataset.id = c.id;
      const isBreak = c.kind === 'break';
      row.innerHTML = `<i class="swatch"></i><span class="kind" title="${isBreak ? 'Break' : 'Focus'}">${isBreak ? '☕' : '⚡'}</span><input class="cname" maxlength="18" aria-label="Tab name" />
        <span class="num"><button type="button" data-step="-1">−</button><input type="number" class="cmin" min="1" max="180" aria-label="Minutes" /><button type="button" data-step="1">+</button></span>
        <button type="button" class="remove" title="Delete tab" aria-label="Delete tab">×</button>`;
      row.querySelector<HTMLElement>('.swatch')!.style.background = customColors(c).a1;
      row.querySelector<HTMLInputElement>('.cname')!.value = c.name;
      row.querySelector<HTMLInputElement>('.cmin')!.value = String(Math.round(c.minutes * 100) / 100);
      row.querySelector('.remove')!.addEventListener('click', () => row.remove());
      return row;
    })
  );
}

function showSettings(show: boolean): void {
  closeAddTab();
  $('timerView').hidden = show;
  $('settingsView').hidden = !show;
  if (!show) return render();
  renderCustomRows();
  for (const k of NUMERIC) field(k).value = String(Math.round(settings[k] * 100) / 100);
  for (const k of BOOLEAN) field(k).checked = settings[k];
}

$('settingsBtn').addEventListener('click', () => showSettings($('settingsView').hidden));
$('backBtn').addEventListener('click', () => showSettings(false));
form.addEventListener('click', (e) => {
  const step = (e.target as Element).closest<HTMLElement>('[data-step]');
  const el = step?.parentElement?.querySelector('input');
  if (!step || !el) return;
  const next = Math.round(Number(el.value) || 0) + Number(step.dataset.step);
  el.value = String(Math.min(Number(el.max), Math.max(Number(el.min), next)));
});
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const next: Settings = { ...settings };
  next.custom = [...$('customGroup').querySelectorAll<HTMLElement>('.crow')].flatMap((row) => {
    const old = findCustom(row.dataset.id ?? '', settings);
    if (!old) return [];
    const mins = Number(row.querySelector<HTMLInputElement>('.cmin')!.value);
    const name = row.querySelector<HTMLInputElement>('.cname')!.value.trim();
    return [{ ...old, name: name || old.name, minutes: Number.isFinite(mins) && mins > 0 ? Math.min(180, mins) : old.minutes }];
  });
  for (const k of NUMERIC) {
    const el = field(k);
    const n = Number(el.value);
    next[k] = Number.isFinite(n) && n > 0 ? Math.min(Number(el.max), Math.max(Number(el.min), n)) : DEFAULT_SETTINGS[k];
  }
  for (const k of BOOLEAN) next[k] = field(k).checked;
  void chrome.storage.local.set({ settings: next }).then(() => showSettings(false));
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') void refresh();
});
void refresh();

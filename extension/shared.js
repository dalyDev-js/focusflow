// Shared constants and helpers used by the service worker and the popup.

// Two built-in tabs. Everything else is a custom tab in one of two categories.
export const PHASES = {
  focus: { label: 'Focus', color: '#ff5c66' },
  short: { label: 'Break', color: '#23cdaa' },
};

export const CATEGORIES = {
  work: { label: 'Focus', icon: '⚡' },
  break: { label: 'Break', icon: '☕' },
};

// Colour pairs for custom tabs: warm/bright for focus, cool/calm for breaks.
export const CUSTOM_COLORS = [
  { a1: '#ffb547', a2: '#ff7a2f' }, // 0 amber   (focus)
  { a1: '#ff7ad9', a2: '#b46bff' }, // 1 pink    (focus)
  { a1: '#4dd7ff', a2: '#3d7bff' }, // 2 sky     (focus)
  { a1: '#ffd84d', a2: '#ff9f1c' }, // 3 gold    (focus)
  { a1: '#ff8a8a', a2: '#e0477a' }, // 4 rose    (focus)
  { a1: '#8c9cff', a2: '#a66bff' }, // 5 violet  (break)
  { a1: '#b7f34d', a2: '#2fcf7d' }, // 6 lime    (break)
  { a1: '#6fe7d9', a2: '#2aa7c9' }, // 7 teal    (break)
  { a1: '#a3b8ff', a2: '#6c8cff' }, // 8 periwinkle (break)
];
export const COLOR_SETS = { work: [0, 1, 2, 3, 4], break: [5, 6, 7, 8] };

// Name ideas shown in the + menu for each category.
export const IDEAS = {
  work: [['PR Review', 30], ['Deep work', 50], ['Emails', 15], ['Study', 45], ['Meeting prep', 20], ['Writing', 40]],
  break: [['Long break', 15], ['Coffee', 10], ['Walk', 15], ['Stretch', 3], ['Lunch', 45], ['Power nap', 20]],
};

export const MAX_CUSTOM = 8;

export const DEFAULT_SETTINGS = {
  focus: 25,
  short: 5,
  autoStartBreaks: false,
  autoStartFocus: false,
  sound: true,
  dailyGoal: 8,
  custom: [], // [{ id, name, minutes, color, kind: 'work' | 'break' }]
};

export const DEFAULT_STATE = {
  phase: 'focus', // 'focus' | 'short' | a custom tab id
  lastWork: 'focus', // focus tab to return to after a break
  lastBreak: 'short', // break tab to go to after a focus session
  status: 'idle', // idle | running | paused
  endTime: null, // epoch ms while running
  remainingMs: null, // ms left while paused / idle
};

export function findCustom(phase, settings) {
  return (settings.custom || []).find((c) => c.id === phase) || null;
}

export function phaseExists(phase, settings) {
  return Boolean(PHASES[phase] || findCustom(phase, settings));
}

// Focus and focus-category tabs are "work"; Break and break-category tabs are breaks.
export function isWork(phase, settings) {
  if (phase === 'focus') return true;
  if (phase === 'short') return false;
  return findCustom(phase, settings)?.kind !== 'break';
}

export function phaseLabel(phase, settings) {
  return PHASES[phase]?.label ?? findCustom(phase, settings)?.name ?? 'Focus';
}

export function phaseColor(phase, settings) {
  if (PHASES[phase]) return PHASES[phase].color;
  const c = findCustom(phase, settings);
  return c ? CUSTOM_COLORS[c.color % CUSTOM_COLORS.length].a1 : PHASES.focus.color;
}

export function phaseMinutes(phase, settings) {
  const c = findCustom(phase, settings);
  return Number(c ? c.minutes : settings[phase] ?? settings.focus);
}

export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function phaseMs(phase, settings) {
  return Math.round(phaseMinutes(phase, settings) * 60 * 1000);
}

export function formatMs(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

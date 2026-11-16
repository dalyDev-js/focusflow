// Shared constants and helpers used by the service worker and the popup.

export const PHASES = {
  focus: { label: 'Focus', color: '#ff5c66' },
  short: { label: 'Short break', color: '#23cdaa' },
  long: { label: 'Long break', color: '#8c78ff' },
};

// Colour pairs for custom tabs, picked in order as tabs are created.
export const CUSTOM_COLORS = [
  { a1: '#ffb547', a2: '#ff7a2f' }, // amber
  { a1: '#ff7ad9', a2: '#b46bff' }, // pink
  { a1: '#4dd7ff', a2: '#3d7bff' }, // sky
  { a1: '#b7f34d', a2: '#2fcf7d' }, // lime
  { a1: '#ffd84d', a2: '#ff9f1c' }, // gold
  { a1: '#ff8a8a', a2: '#e0477a' }, // rose
];

export const MAX_CUSTOM = 6;

export const DEFAULT_SETTINGS = {
  focus: 25,
  short: 5,
  long: 15,
  longEvery: 4,
  autoStartBreaks: false,
  autoStartFocus: false,
  sound: true,
  dailyGoal: 8,
  custom: [], // [{ id, name, minutes, color }]
  breaks: { short: false, long: false }, // break tabs are opt-in via quick add
};

export const DEFAULT_STATE = {
  phase: 'focus', // 'focus' | 'short' | 'long' | a custom tab id
  lastWork: 'focus', // the work tab to return to after a break
  status: 'idle', // idle | running | paused
  endTime: null, // epoch ms while running
  remainingMs: null, // ms left while paused / idle
  cycle: 0, // completed work sessions in the current long-break cycle
};

export function findCustom(phase, settings) {
  return (settings.custom || []).find((c) => c.id === phase) || null;
}

export function breakEnabled(phase, settings) {
  return Boolean(settings.breaks?.[phase]);
}

export function phaseExists(phase, settings) {
  if (phase === 'focus') return true;
  if (phase === 'short' || phase === 'long') return breakEnabled(phase, settings);
  return Boolean(findCustom(phase, settings));
}

// Ready-made tabs offered as dashed "quick add" chips until the user adds them.
export const SUGGESTIONS = [
  { key: 'short', name: 'Short break', break: true },
  { key: 'long', name: 'Long break', break: true },
  { key: 'pr', name: 'PR Review', minutes: 30 },
  { key: 'email', name: 'Emails', minutes: 15 },
  { key: 'deep', name: 'Deep work', minutes: 50 },
];

// Focus and every custom tab are "work" sessions; short and long are breaks.
export function isWork(phase) {
  return phase !== 'short' && phase !== 'long';
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

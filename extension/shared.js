// Shared constants and helpers used by the service worker and the popup.

export const PHASES = {
  focus: { label: 'Focus', color: '#ff6b5b' },
  short: { label: 'Short break', color: '#3ecf8e' },
  long: { label: 'Long break', color: '#5b8cff' },
};

export const DEFAULT_SETTINGS = {
  focus: 25,
  short: 5,
  long: 15,
  longEvery: 4,
  autoStartBreaks: false,
  autoStartFocus: false,
  sound: true,
  dailyGoal: 8,
};

export const DEFAULT_STATE = {
  phase: 'focus',
  status: 'idle', // idle | running | paused
  endTime: null, // epoch ms while running
  remainingMs: null, // ms left while paused / idle
  cycle: 0, // completed focus sessions in the current long-break cycle
};

export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function phaseMs(phase, settings) {
  return Math.round(Number(settings[phase]) * 60 * 1000);
}

export function formatMs(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

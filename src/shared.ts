// Shared types, constants and helpers used by the service worker and the popup.

export type BuiltInPhase = 'focus' | 'short';
/** A built-in tab, or the id of a custom tab (e.g. "c_lz3k9a"). */
export type Phase = BuiltInPhase | (string & {});
export type Kind = 'work' | 'break';
export type Status = 'idle' | 'running' | 'paused';

export interface CustomTab {
  id: string;
  name: string;
  minutes: number;
  color: number; // index into CUSTOM_COLORS
  kind: Kind;
}

export interface Settings {
  focus: number;
  short: number;
  autoStartBreaks: boolean;
  autoStartFocus: boolean;
  sound: boolean;
  dailyGoal: number;
  custom: CustomTab[];
}

export interface TimerState {
  phase: Phase;
  lastWork: Phase; // focus tab to return to after a break
  lastBreak: Phase; // break tab to go to after a focus session
  status: Status;
  endTime: number | null; // epoch ms while running
  remainingMs: number | null; // ms left while paused / idle
}

export interface DayStats {
  sessions: number;
  minutes: number;
  byTab?: Record<string, number>;
}
export type Stats = Record<string, DayStats>;

/** Messages the popup and service worker exchange. */
export type Message =
  | { type: 'start' | 'pause' | 'reset' | 'skip' | 'toggle' }
  | { type: 'setPhase'; phase: Phase }
  | { type: 'setMinutes'; minutes: number };

export type OffscreenMessage = { target: 'offscreen'; type: 'chime'; kind: 'focus' | 'break' };

// Two built-in tabs. Everything else is a custom tab in one of two categories.
export const PHASES: Record<BuiltInPhase, { label: string; color: string }> = {
  focus: { label: 'Focus', color: '#ff5c66' },
  short: { label: 'Break', color: '#23cdaa' },
};

export const CATEGORIES: Record<Kind, { label: string; icon: string }> = {
  work: { label: 'Focus', icon: '⚡' },
  break: { label: 'Break', icon: '☕' },
};

// Colour pairs for custom tabs: warm/bright for focus, cool/calm for breaks.
export const CUSTOM_COLORS: readonly { a1: string; a2: string }[] = [
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
export const COLOR_SETS: Record<Kind, number[]> = { work: [0, 1, 2, 3, 4], break: [5, 6, 7, 8] };

// Name ideas shown in the + menu for each category: [name, minutes].
export const IDEAS: Record<Kind, [string, number][]> = {
  work: [['PR Review', 30], ['Deep work', 50], ['Emails', 15], ['Study', 45], ['Meeting prep', 20], ['Writing', 40]],
  break: [['Long break', 15], ['Coffee', 10], ['Walk', 15], ['Stretch', 3], ['Lunch', 45], ['Power nap', 20]],
};

export const MAX_CUSTOM = 8;

export const DEFAULT_SETTINGS: Settings = {
  focus: 25,
  short: 5,
  autoStartBreaks: false,
  autoStartFocus: false,
  sound: true,
  dailyGoal: 8,
  custom: [],
};

export const DEFAULT_STATE: TimerState = {
  phase: 'focus',
  lastWork: 'focus',
  lastBreak: 'short',
  status: 'idle',
  endTime: null,
  remainingMs: null,
};

export const isBuiltIn = (phase: Phase): phase is BuiltInPhase => phase === 'focus' || phase === 'short';

export function findCustom(phase: Phase, settings: Settings): CustomTab | null {
  return settings.custom.find((c) => c.id === phase) ?? null;
}

export function phaseExists(phase: Phase, settings: Settings): boolean {
  return isBuiltIn(phase) || findCustom(phase, settings) !== null;
}

/** Focus and focus-category tabs are "work"; Break and break-category tabs are breaks. */
export function isWork(phase: Phase, settings: Settings): boolean {
  if (phase === 'focus') return true;
  if (phase === 'short') return false;
  return findCustom(phase, settings)?.kind !== 'break';
}

export function phaseLabel(phase: Phase, settings: Settings): string {
  if (isBuiltIn(phase)) return PHASES[phase].label;
  return findCustom(phase, settings)?.name ?? 'Focus';
}

export function customColors(tab: CustomTab): { a1: string; a2: string } {
  return CUSTOM_COLORS[tab.color % CUSTOM_COLORS.length];
}

export function phaseColor(phase: Phase, settings: Settings): string {
  if (isBuiltIn(phase)) return PHASES[phase].color;
  const c = findCustom(phase, settings);
  return c ? customColors(c).a1 : PHASES.focus.color;
}

export function phaseMinutes(phase: Phase, settings: Settings): number {
  if (isBuiltIn(phase)) return Number(settings[phase]);
  return Number(findCustom(phase, settings)?.minutes ?? settings.focus);
}

export function phaseMs(phase: Phase, settings: Settings): number {
  return Math.round(phaseMinutes(phase, settings) * 60 * 1000);
}

export function todayKey(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function formatMs(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Reads everything from storage and fills in defaults (also migrates older versions). */
export async function loadAll(): Promise<{ state: TimerState; settings: Settings; stats: Stats }> {
  const data = (await chrome.storage.local.get(['state', 'settings', 'stats'])) as {
    state?: Partial<TimerState>;
    settings?: Partial<Settings>;
    stats?: Stats;
  };
  const settings: Settings = { ...DEFAULT_SETTINGS, ...data.settings };
  settings.custom = (settings.custom ?? []).map((c) => ({ ...c, kind: c.kind ?? 'work' }));
  return {
    state: { ...DEFAULT_STATE, ...data.state },
    settings,
    stats: data.stats ?? {},
  };
}

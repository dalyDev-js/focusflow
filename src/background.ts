import {
  type Message,
  type OffscreenMessage,
  type Phase,
  type Settings,
  type Stats,
  type TimerState,
  findCustom,
  isBuiltIn,
  isWork,
  loadAll as load,
  phaseColor,
  phaseExists,
  phaseLabel,
  phaseMinutes,
  phaseMs,
  todayKey,
} from './shared';

const END_ALARM = 'phase-end';
const TICK_ALARM = 'badge-tick';
const NOTIFICATION_ID = 'focusflow-phase';

// Every state change runs through this queue. Without it, the end alarm and the
// badge tick could both see an expired timer at the same moment and advance twice
// (two notifications, double-counted stats, a skipped phase).
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function saveState(state: TimerState): Promise<void> {
  await chrome.storage.local.set({ state });
  await updateBadge(state);
}

async function clearAlarms(): Promise<void> {
  await chrome.alarms.clear(END_ALARM);
  await chrome.alarms.clear(TICK_ALARM);
}

function toIdle(state: TimerState): void {
  state.status = 'idle';
  state.endTime = null;
  state.remainingMs = null;
}

// ---------- badge ----------
async function updateBadge(state: TimerState, settings?: Settings): Promise<void> {
  settings ??= (await load()).settings;
  await chrome.action.setBadgeBackgroundColor({ color: phaseColor(state.phase, settings) });
  await chrome.action.setBadgeTextColor?.({ color: '#ffffff' });

  let text = '';
  if (state.status === 'running' && state.endTime !== null) {
    text = `${Math.max(0, Math.ceil((state.endTime - Date.now()) / 60000))}m`;
  } else if (state.status === 'paused') {
    text = '❚❚';
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setTitle({
    title: `FocusFlow · ${phaseLabel(state.phase, settings)}${state.status === 'running' ? ' (running)' : ''}`,
  });
}

// ---------- timer actions ----------
async function start(): Promise<void> {
  const { state, settings } = await load();
  if (state.status === 'running') return;
  const remaining = state.remainingMs ?? phaseMs(state.phase, settings);
  state.status = 'running';
  state.endTime = Date.now() + remaining;
  state.remainingMs = null;
  await chrome.alarms.create(END_ALARM, { when: state.endTime });
  await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
  await saveState(state);
}

async function pause(): Promise<void> {
  const { state } = await load();
  if (state.status !== 'running' || state.endTime === null) return;
  state.status = 'paused';
  state.remainingMs = Math.max(0, state.endTime - Date.now());
  state.endTime = null;
  await clearAlarms();
  await saveState(state);
}

async function toggle(): Promise<void> {
  return (await load()).state.status === 'running' ? pause() : start();
}

async function reset(): Promise<void> {
  const { state } = await load();
  toIdle(state);
  await clearAlarms();
  await saveState(state);
}

async function setPhase(phase: Phase): Promise<void> {
  const { state, settings } = await load();
  if (!phaseExists(phase, settings)) return;
  state.phase = phase;
  if (isWork(phase, settings)) state.lastWork = phase;
  else state.lastBreak = phase;
  toIdle(state);
  await clearAlarms();
  await saveState(state);
}

// Manually edit the time from the popup. Idle: changes that tab's default length.
// Running or paused: changes only the time left in the current session.
async function setMinutes(minutes: number): Promise<void> {
  const ms = Math.round(Math.min(180, Math.max(1 / 60, Number(minutes))) * 60000);
  if (!Number.isFinite(ms)) return;
  const { state, settings } = await load();
  if (state.status === 'idle') {
    const mins = Math.round((ms / 60000) * 100) / 100;
    const custom = findCustom(state.phase, settings);
    if (custom) custom.minutes = mins;
    else if (isBuiltIn(state.phase)) settings[state.phase] = mins;
    await chrome.storage.local.set({ settings });
    await saveState(state);
    return;
  }
  if (state.status === 'running') {
    state.endTime = Date.now() + ms;
    await chrome.alarms.create(END_ALARM, { when: state.endTime });
  } else {
    state.remainingMs = ms;
  }
  await saveState(state);
}

/**
 * Moves to the next tab. `completed` is true when the timer actually ran out
 * (counts toward stats), false when the user skipped.
 */
async function advance(completed: boolean): Promise<void> {
  const { state, settings, stats } = await load();
  if (completed && !(state.status === 'running' && state.endTime !== null && state.endTime <= Date.now() + 1000)) return;
  const finished = state.phase;
  const finishedWork = isWork(finished, settings);

  if (finishedWork) {
    if (completed) await recordSession(finished, settings, stats);
    state.lastWork = finished;
    // Go to the break tab you used last (e.g. "Coffee"), or the default Break.
    state.phase = phaseExists(state.lastBreak, settings) ? state.lastBreak : 'short';
  } else {
    // After a break, go back to whatever you were working on (e.g. "PR Review").
    state.phase = phaseExists(state.lastWork, settings) ? state.lastWork : 'focus';
  }

  toIdle(state);
  await clearAlarms();
  await saveState(state);

  if (completed) {
    await notify(finished, state.phase, settings);
    if (settings.sound) await playChime(finishedWork ? 'break' : 'focus');
  }

  const autoStart = isWork(state.phase, settings) ? settings.autoStartFocus : settings.autoStartBreaks;
  if (autoStart) await start();
}

async function recordSession(phase: Phase, settings: Settings, stats: Stats): Promise<void> {
  const key = todayKey();
  const day = stats[key] ?? { sessions: 0, minutes: 0 };
  const mins = phaseMinutes(phase, settings);
  const label = phaseLabel(phase, settings);
  day.sessions += 1;
  day.minutes += mins;
  day.byTab = { ...day.byTab, [label]: (day.byTab?.[label] ?? 0) + mins };
  stats[key] = day;
  // Keep about two months of history.
  for (const old of Object.keys(stats).sort().slice(0, -60)) delete stats[old];
  await chrome.storage.local.set({ stats });
}

// ---------- notifications ----------
async function notify(finished: Phase, next: Phase, settings: Settings): Promise<void> {
  const name = phaseLabel(finished, settings);
  const nextName = phaseLabel(next, settings);
  const nextMins = phaseMinutes(next, settings);
  const nextSession = nextName === 'Focus' ? 'focus session' : `${nextName} session`;

  const { title, message } = isWork(finished, settings)
    ? {
        title: `${name === 'Focus' ? 'Focus session' : name} done 🎉`,
        message:
          next === 'short'
            ? `Nice! Take a ${nextMins} minute break. Stretch, breathe, drink water.`
            : `Nice work! Time for ${nextName} (${nextMins} min).`,
      }
    : { title: `${name} is over ☕`, message: `Recharged? Ready for a ${nextMins} minute ${nextSession}?` };

  await chrome.notifications.clear(NOTIFICATION_ID);
  await chrome.notifications.create(NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 2,
    requireInteraction: true,
    buttons: [{ title: `Start ${nextName}` }, { title: 'Dismiss' }],
  });
}

chrome.notifications.onButtonClicked.addListener((id, index) => {
  void chrome.notifications.clear(id);
  if (index === 0) void serial(start);
});

chrome.notifications.onClicked.addListener((id) => void chrome.notifications.clear(id));

// ---------- sound (offscreen document; MV3 service workers can't play audio) ----------
async function playChime(kind: OffscreenMessage['kind']): Promise<void> {
  try {
    if (!(await chrome.offscreen.hasDocument())) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'Play a short chime when a session ends.',
      });
    }
    const msg: OffscreenMessage = { target: 'offscreen', type: 'chime', kind };
    await chrome.runtime.sendMessage(msg);
  } catch (err) {
    console.warn('FocusFlow: could not play chime', err);
  }
}

// ---------- events ----------
chrome.alarms.onAlarm.addListener((alarm) => {
  void serial(async () => {
    if (alarm.name === END_ALARM) {
      await advance(true);
    } else if (alarm.name === TICK_ALARM) {
      const { state, settings } = await load();
      if (state.status === 'running' && state.endTime !== null && state.endTime <= Date.now()) await advance(true);
      else await updateBadge(state, settings);
    }
  });
});

function handle(msg: Message): Promise<void> {
  switch (msg.type) {
    case 'start':
      return start();
    case 'pause':
      return pause();
    case 'toggle':
      return toggle();
    case 'reset':
      return reset();
    case 'skip':
      return advance(false);
    case 'setPhase':
      return setPhase(msg.phase);
    case 'setMinutes':
      return setMinutes(msg.minutes);
  }
}

chrome.runtime.onMessage.addListener((msg: Message | OffscreenMessage, _sender, sendResponse) => {
  if ('target' in msg) return false; // meant for the offscreen document
  serial(() => handle(msg)).then(
    () => sendResponse({ ok: true }),
    (e: unknown) => sendResponse({ ok: false, error: String(e) })
  );
  return true; // keep the channel open for the async response
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-timer') void serial(toggle);
});

// When a tab is deleted, move away from it and forget it as the last focus/break tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  void serial(async () => {
    const { state, settings } = await load();
    let dirty = false;
    if (!phaseExists(state.lastWork, settings)) {
      state.lastWork = 'focus';
      dirty = true;
    }
    if (!phaseExists(state.lastBreak, settings)) {
      state.lastBreak = 'short';
      dirty = true;
    }
    if (!phaseExists(state.phase, settings)) {
      state.phase = state.lastWork;
      toIdle(state);
      await clearAlarms();
      dirty = true;
    }
    if (dirty) await saveState(state);
    else await updateBadge(state, settings);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  void serial(async () => {
    const { state, settings } = await load();
    // Migrate older versions (long breaks and opt-in breaks are gone).
    if (!phaseExists(state.phase, settings)) {
      state.phase = 'focus';
      toIdle(state);
    }
    if (!phaseExists(state.lastWork, settings)) state.lastWork = 'focus';
    if (!phaseExists(state.lastBreak, settings)) state.lastBreak = 'short';
    const clean: Settings = {
      focus: settings.focus,
      short: settings.short,
      autoStartBreaks: settings.autoStartBreaks,
      autoStartFocus: settings.autoStartFocus,
      sound: settings.sound,
      dailyGoal: settings.dailyGoal,
      custom: settings.custom,
    };
    await chrome.storage.local.set({ state, settings: clean });
    await updateBadge(state, clean);
  });
});

chrome.runtime.onStartup.addListener(() => {
  void serial(async () => {
    const { state, settings } = await load();
    if (state.status === 'running' && state.endTime !== null && state.endTime <= Date.now()) await advance(true);
    else await updateBadge(state, settings);
  });
});

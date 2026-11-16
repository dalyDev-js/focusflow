import {
  DEFAULT_SETTINGS, DEFAULT_STATE, todayKey, phaseMs, phaseMinutes, phaseLabel, phaseColor,
  phaseExists, findCustom, isWork, breakEnabled,
} from './shared.js';

const END_ALARM = 'phase-end';
const TICK_ALARM = 'badge-tick';
const NOTIFICATION_ID = 'focusflow-phase';

// Every state change runs through this queue. Without it, the end alarm and the
// badge tick could both see an expired timer at the same moment and advance twice
// (two notifications, double-counted stats, a skipped phase).
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// ---------- storage helpers ----------
async function load() {
  const { state, settings, stats } = await chrome.storage.local.get(['state', 'settings', 'stats']);
  return {
    state: { ...DEFAULT_STATE, ...state },
    settings: { ...DEFAULT_SETTINGS, ...settings },
    stats: stats || {},
  };
}

async function saveState(state) {
  await chrome.storage.local.set({ state });
  await updateBadge(state);
}

// ---------- badge ----------
async function updateBadge(state, settings) {
  settings ??= (await load()).settings;
  const color = phaseColor(state.phase, settings);
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });

  if (state.status === 'running') {
    const mins = Math.max(0, Math.ceil((state.endTime - Date.now()) / 60000));
    await chrome.action.setBadgeText({ text: `${mins}m` });
  } else if (state.status === 'paused') {
    await chrome.action.setBadgeText({ text: '❚❚' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
  await chrome.action.setTitle({
    title: `FocusFlow · ${phaseLabel(state.phase, settings)}${state.status === 'running' ? ' (running)' : ''}`,
  });
}

// ---------- timer actions ----------
async function start() {
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

async function pause() {
  const { state } = await load();
  if (state.status !== 'running') return;
  state.status = 'paused';
  state.remainingMs = Math.max(0, state.endTime - Date.now());
  state.endTime = null;
  await chrome.alarms.clear(END_ALARM);
  await chrome.alarms.clear(TICK_ALARM);
  await saveState(state);
}

async function reset() {
  const { state } = await load();
  state.status = 'idle';
  state.endTime = null;
  state.remainingMs = null;
  await chrome.alarms.clear(END_ALARM);
  await chrome.alarms.clear(TICK_ALARM);
  await saveState(state);
}

async function setPhase(phase) {
  const { state, settings } = await load();
  if (!phaseExists(phase, settings)) return;
  state.phase = phase;
  if (isWork(phase)) state.lastWork = phase;
  state.status = 'idle';
  state.endTime = null;
  state.remainingMs = null;
  await chrome.alarms.clear(END_ALARM);
  await chrome.alarms.clear(TICK_ALARM);
  await saveState(state);
}

// Manually edit the time from the popup. Idle: changes that phase's default length.
// Running or paused: changes only the time left in the current session.
async function setMinutes(minutes) {
  const ms = Math.round(Math.min(180, Math.max(0.0167, Number(minutes))) * 60000);
  if (!Number.isFinite(ms)) return;
  const { state, settings } = await load();
  if (state.status === 'idle') {
    const mins = Math.round((ms / 60000) * 100) / 100;
    const custom = findCustom(state.phase, settings);
    if (custom) custom.minutes = mins;
    else settings[state.phase] = mins;
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

// Moves to the next phase. `completed` is true when the timer actually ran out
// (counts toward stats), false when the user skipped.
async function advance(completed) {
  const { state, settings, stats } = await load();
  if (completed && !(state.status === 'running' && state.endTime <= Date.now() + 1000)) return;
  const finished = state.phase;

  if (isWork(finished)) {
    if (completed) {
      const key = todayKey();
      const day = stats[key] || { sessions: 0, minutes: 0 };
      const mins = phaseMinutes(finished, settings);
      day.sessions += 1;
      day.minutes += mins;
      const label = phaseLabel(finished, settings);
      day.byTab = { ...day.byTab, [label]: (day.byTab?.[label] || 0) + mins };
      stats[key] = day;
      pruneStats(stats);
      await chrome.storage.local.set({ stats });
    }
    state.lastWork = finished;
    state.cycle = (state.cycle || 0) + 1;
    // Breaks only happen if you added them as tabs; otherwise stay on the same tab.
    if (breakEnabled('long', settings) && state.cycle >= settings.longEvery) {
      state.phase = 'long';
      state.cycle = 0;
    } else if (breakEnabled('short', settings)) {
      state.phase = 'short';
    } else {
      state.phase = finished;
      if (!breakEnabled('long', settings)) state.cycle = 0;
    }
  } else {
    // After a break, go back to whatever you were working on (e.g. "PR Review").
    state.phase = phaseExists(state.lastWork, settings) ? state.lastWork : 'focus';
  }

  state.status = 'idle';
  state.endTime = null;
  state.remainingMs = null;
  await chrome.alarms.clear(END_ALARM);
  await chrome.alarms.clear(TICK_ALARM);
  await saveState(state);

  if (completed) {
    await notify(finished, state.phase, settings);
    if (settings.sound) await playChime(isWork(finished) ? 'break' : 'focus');
  }

  // Never auto-restart the same work tab back to back (no break in between).
  const sameTab = isWork(finished) && state.phase === finished;
  const autoStart = !sameTab && (isWork(state.phase) ? settings.autoStartFocus : settings.autoStartBreaks);
  if (autoStart) await start();
}

function pruneStats(stats) {
  const keys = Object.keys(stats).sort();
  while (keys.length > 60) delete stats[keys.shift()];
}

// ---------- notifications ----------
async function notify(finished, next, settings) {
  const nextName = phaseLabel(next, settings);
  const nextMins = phaseMinutes(next, settings);
  const work = nextName === 'Focus' ? 'focus session' : `${nextName} session`;
  let m;
  if (isWork(finished)) {
    const name = phaseLabel(finished, settings);
    m = {
      title: `${name === 'Focus' ? 'Focus session' : name} done 🎉`,
      message: isWork(next)
        ? `Nice work! Ready for another ${nextMins} minute ${work}?`
        : next === 'long'
          ? `Great work! Time for a ${nextMins} minute long break.`
          : `Nice! Take a ${nextMins} minute break. Stretch, breathe, drink water.`,
    };
  } else if (finished === 'short') {
    m = { title: 'Break is over ☕', message: `Ready for another ${nextMins} minute ${work}?` };
  } else {
    m = { title: 'Long break is over 🌿', message: `Recharged? Let's start a fresh ${nextMins} minute ${work}.` };
  }
  await chrome.notifications.clear(NOTIFICATION_ID);
  await chrome.notifications.create(NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: m.title,
    message: m.message,
    priority: 2,
    requireInteraction: true,
    buttons: [{ title: isWork(next) ? (next === finished ? 'Go again' : `Start ${nextName}`) : 'Start break' }, { title: 'Dismiss' }],
  });
}

chrome.notifications.onButtonClicked.addListener(async (id, index) => {
  chrome.notifications.clear(id);
  if (index === 0) await serial(start);
});

chrome.notifications.onClicked.addListener((id) => chrome.notifications.clear(id));

// ---------- sound (offscreen document, MV3 service workers can't play audio) ----------
async function playChime(kind) {
  try {
    const exists = await chrome.offscreen.hasDocument?.();
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['AUDIO_PLAYBACK'],
        justification: 'Play a short chime when a Pomodoro phase ends.',
      });
    }
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'chime', kind });
  } catch (err) {
    console.warn('FocusFlow: could not play chime', err);
  }
}

// ---------- events ----------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  await serial(async () => {
    if (alarm.name === END_ALARM) {
      await advance(true);
    } else if (alarm.name === TICK_ALARM) {
      const { state } = await load();
      if (state.status === 'running' && state.endTime <= Date.now()) await advance(true);
      else await updateBadge(state);
    }
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;
  const actions = {
    start,
    pause,
    reset,
    skip: () => advance(false),
    setPhase: () => setPhase(msg.phase),
    setMinutes: () => setMinutes(msg.minutes),
    toggle: async () => ((await load()).state.status === 'running' ? pause() : start()),
  };
  const fn = actions[msg?.type];
  if (!fn) return false;
  serial(fn).then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-timer') return;
  await serial(async () => ((await load()).state.status === 'running' ? pause() : start()));
});

// When settings change: if the current custom tab was deleted, fall back to Focus.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  serial(async () => {
    const { state, settings } = await load();
    if (!phaseExists(state.phase, settings)) {
      await setPhase(phaseExists(state.lastWork, settings) ? state.lastWork : 'focus');
    }
    else await updateBadge(state, settings);
    if (!phaseExists(state.lastWork, settings)) {
      const fresh = (await load()).state;
      fresh.lastWork = 'focus';
      await chrome.storage.local.set({ state: fresh });
    }
  });
});

chrome.runtime.onInstalled.addListener(async () => {
  const { state, settings } = await load();
  await chrome.storage.local.set({ state, settings });
  await updateBadge(state);
});

chrome.runtime.onStartup.addListener(() =>
  serial(async () => {
    const { state } = await load();
    if (state.status === 'running' && state.endTime <= Date.now()) await advance(true);
    else await updateBadge(state);
  })
);

import { PHASES, DEFAULT_SETTINGS, DEFAULT_STATE, todayKey, phaseMs } from './shared.js';

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
async function updateBadge(state) {
  const color = PHASES[state.phase].color;
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
    title: `FocusFlow · ${PHASES[state.phase].label}${state.status === 'running' ? ' (running)' : ''}`,
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
  if (!PHASES[phase]) return;
  const { state } = await load();
  state.phase = phase;
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
    settings[state.phase] = Math.round((ms / 60000) * 100) / 100;
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

  if (finished === 'focus') {
    if (completed) {
      const key = todayKey();
      const day = stats[key] || { sessions: 0, minutes: 0 };
      day.sessions += 1;
      day.minutes += Number(settings.focus);
      stats[key] = day;
      pruneStats(stats);
      await chrome.storage.local.set({ stats });
    }
    state.cycle = (state.cycle || 0) + 1;
    if (state.cycle >= settings.longEvery) {
      state.phase = 'long';
      state.cycle = 0;
    } else {
      state.phase = 'short';
    }
  } else {
    state.phase = 'focus';
  }

  state.status = 'idle';
  state.endTime = null;
  state.remainingMs = null;
  await chrome.alarms.clear(END_ALARM);
  await chrome.alarms.clear(TICK_ALARM);
  await saveState(state);

  if (completed) {
    await notify(finished, state.phase, settings);
    if (settings.sound) await playChime(finished === 'focus' ? 'break' : 'focus');
  }

  const autoStart = state.phase === 'focus' ? settings.autoStartFocus : settings.autoStartBreaks;
  if (autoStart) await start();
}

function pruneStats(stats) {
  const keys = Object.keys(stats).sort();
  while (keys.length > 60) delete stats[keys.shift()];
}

// ---------- notifications ----------
async function notify(finished, next, settings) {
  const messages = {
    focus: {
      title: 'Focus session done 🎉',
      message:
        next === 'long'
          ? `Great work! Time for a ${settings.long} minute long break.`
          : `Nice! Take a ${settings.short} minute break. Stretch, breathe, drink water.`,
    },
    short: { title: 'Break is over ☕', message: `Ready for another ${settings.focus} minute focus session?` },
    long: { title: 'Long break is over 🌿', message: `Recharged? Let's start a fresh ${settings.focus} minute focus round.` },
  };
  const m = messages[finished];
  await chrome.notifications.clear(NOTIFICATION_ID);
  await chrome.notifications.create(NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: m.title,
    message: m.message,
    priority: 2,
    requireInteraction: true,
    buttons: [{ title: next === 'focus' ? 'Start focus' : 'Start break' }, { title: 'Dismiss' }],
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

// When settings change, an idle timer should show the new duration.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && changes.settings) {
    const { state } = await load();
    if (state.status === 'idle') await updateBadge(state);
  }
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

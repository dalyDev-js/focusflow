// Plays a soft synthesized chime (no audio files needed).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'chime') return;
  const ctx = new AudioContext();
  // Rising notes = back to focus, falling notes = time to rest.
  const notes = msg.kind === 'focus' ? [523.25, 659.25, 783.99] : [783.99, 659.25, 523.25];
  notes.forEach((freq, i) => {
    const t = ctx.currentTime + i * 0.22;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 1);
  });
  setTimeout(() => ctx.close(), 2000);
});

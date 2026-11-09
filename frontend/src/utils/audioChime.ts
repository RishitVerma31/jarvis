/**
 * Synthetic acoustic chime generator using Web Audio API.
 * Emits a crisp, futuristic Jarvis activation chime upon wake-word detection.
 */

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!sharedAudioCtx) {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioContextClass) {
      sharedAudioCtx = new AudioContextClass();
    }
  }
  if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

export function primeAudioContext(): void {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    ctx.resume().catch(() => {});
  }
}

export function playJarvisWakeChime(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  const now = ctx.currentTime;

  // Primary tone (587 Hz - D5)
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(587.33, now);
  osc1.frequency.exponentialRampToValueAtTime(880.0, now + 0.12); // Ramp to A5

  gain1.gain.setValueAtTime(0.001, now);
  gain1.gain.exponentialRampToValueAtTime(0.2, now + 0.02);
  gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

  osc1.connect(gain1);
  gain1.connect(ctx.destination);

  osc1.start(now);
  osc1.stop(now + 0.36);

  // Sub-harmonic shimmer (1174 Hz - D6)
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(1174.66, now + 0.04);

  gain2.gain.setValueAtTime(0.001, now + 0.04);
  gain2.gain.exponentialRampToValueAtTime(0.08, now + 0.06);
  gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.38);

  osc2.connect(gain2);
  gain2.connect(ctx.destination);

  osc2.start(now + 0.04);
  osc2.stop(now + 0.39);
}


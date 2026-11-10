/**
 * Audio playback utility for Base64 PCM/WAV speech payloads using Web Audio API.
 * Handles Base64 conversion, WAV decoding, iOS Safari W3C AudioSession lifecycle routing,
 * single-instance playback coordination, and clean cancellation.
 */

let sharedAudioContext: AudioContext | null = null;
let activeStopFn: (() => void) | null = null;
let isCurrentlyPlaying = false;

/**
 * Safely update W3C AudioSession type on iOS Safari without throwing.
 */
function setAudioSessionType(type: 'playback' | 'play-and-record'): boolean {
  if (typeof navigator === 'undefined') return false;
  if (!('audioSession' in navigator)) return false;

  try {
    const nav = navigator as unknown as { audioSession: { type: string } };
    if (nav.audioSession && nav.audioSession.type !== type) {
      nav.audioSession.type = type;
      return true;
    }
  } catch (err) {
    console.warn('[AudioSession] Failed to set type to', type, err);
  }
  return false;
}

/**
 * Convert a Base64 string to an ArrayBuffer safely.
 * Works across modern browsers (atob) and Node.js testing environments (Buffer).
 * Throws an Error if input is empty, invalid, or malformed.
 */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  if (typeof base64 !== 'string' || !base64.trim()) {
    throw new Error('Base64 input must be a non-empty string.');
  }

  // Base64 format validation (standard base64 chars + padding)
  const trimmed = base64.trim();
  const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  if (trimmed.length % 4 !== 0 || !base64Regex.test(trimmed)) {
    throw new Error('Invalid Base64 string format.');
  }

  if (typeof window !== 'undefined' && typeof window.atob === 'function') {
    const binaryString = window.atob(trimmed);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }

  // Node.js test environment fallback
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(trimmed, 'base64');
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  throw new Error('No Base64 decoder available in the current environment.');
}

/**
 * Return the shared AudioContext instance, creating or resuming it as necessary.
 * Supports standard AudioContext and iOS Safari's webkitAudioContext.
 */
export function getPlaybackAudioContext(): AudioContext | null {
  if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
    if (sharedAudioContext.state === 'suspended') {
      sharedAudioContext.resume().catch(() => {});
    }
    return sharedAudioContext;
  }

  const AudioContextClass =
    typeof window !== 'undefined'
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      : (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext ||
        (globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioContextClass) return null;

  sharedAudioContext = new AudioContextClass();

  if (sharedAudioContext.state === 'suspended') {
    sharedAudioContext.resume().catch(() => {});
  }

  return sharedAudioContext;
}

/**
 * Test helper to inject or clear the shared AudioContext instance.
 */
export function setPlaybackAudioContextForTesting(ctx: AudioContext | null): void {
  sharedAudioContext = ctx;
  activeStopFn = null;
  isCurrentlyPlaying = false;
}

/**
 * Return whether Kokoro audio is currently playing.
 */
export function isAudioPlaying(): boolean {
  return isCurrentlyPlaying;
}

/**
 * Immediately stop any currently playing Kokoro audio and restore audio session.
 */
export function stopAudioPlayback(): void {
  if (activeStopFn) {
    const stop = activeStopFn;
    activeStopFn = null;
    stop();
  }
}

/**
 * Wrapper for decodeAudioData supporting both Promise and legacy callback syntax.
 */
function decodeAudioDataSafe(ctx: AudioContext, buffer: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const onResolve = (decoded: AudioBuffer) => {
      if (!settled) {
        settled = true;
        resolve(decoded);
      }
    };

    const onReject = (err: unknown) => {
      if (!settled) {
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };

    try {
      const res = ctx.decodeAudioData(buffer, onResolve, onReject);
      if (res && typeof (res as Promise<AudioBuffer>).then === 'function') {
        (res as Promise<AudioBuffer>).then(onResolve).catch(onReject);
      }
    } catch (err) {
      onReject(err);
    }
  });
}

export interface PlayAudioOptions {
  autoRestoreSession?: boolean;
  watchdogDelayMs?: number;
}

/**
 * Play Base64-encoded WAV audio through the Web Audio API.
 * Ensures any previous playback is stopped before starting new audio.
 *
 * @param base64Audio Base64-encoded WAV audio data
 * @param onStart Optional callback invoked when playback begins
 * @param onEnd Optional callback invoked when playback finishes naturally
 * @param onError Optional callback invoked if decoding or playback fails
 * @param options Optional playback configuration (e.g. autoRestoreSession, watchdogDelayMs)
 * @returns A cancellation function that immediately stops playback without triggering onEnd
 */
export function playBase64WavAudio(
  base64Audio: string,
  onStart?: () => void,
  onEnd?: () => void,
  onError?: (error: unknown) => void,
  options?: PlayAudioOptions
): () => void {
  // Stop any currently active playback before starting a new one
  stopAudioPlayback();

  const autoRestoreSession = options?.autoRestoreSession ?? true;
  let isCancelled = false;
  let hasSettled = false;
  let sourceNode: AudioBufferSourceNode | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  const clearWatchdog = () => {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  };

  const safeEnd = () => {
    clearWatchdog();
    if (hasSettled) return;
    hasSettled = true;
    isCurrentlyPlaying = false;
    activeStopFn = null;
    if (autoRestoreSession) {
      setAudioSessionType('play-and-record');
    }
    onEnd?.();
  };

  const safeError = (err: unknown) => {
    clearWatchdog();
    if (hasSettled) return;
    hasSettled = true;
    isCurrentlyPlaying = false;
    activeStopFn = null;
    if (autoRestoreSession) {
      setAudioSessionType('play-and-record');
    }
    onError?.(err);
  };

  const cancelPlayback = () => {
    clearWatchdog();
    if (hasSettled || isCancelled) return;
    isCancelled = true;
    hasSettled = true;
    isCurrentlyPlaying = false;

    if (sourceNode) {
      try {
        sourceNode.onended = null;
        sourceNode.stop();
        sourceNode.disconnect();
      } catch {
        // Ignore if already stopped or disconnected
      }
      sourceNode = null;
    }

    activeStopFn = null;
    setAudioSessionType('play-and-record');
  };

  activeStopFn = cancelPlayback;

  // 1. Validate Base64 string input
  let arrayBuffer: ArrayBuffer;
  try {
    arrayBuffer = base64ToArrayBuffer(base64Audio);
  } catch (err) {
    safeError(err);
    return cancelPlayback;
  }

  // 2. Obtain AudioContext
  const ctx = getPlaybackAudioContext();
  if (!ctx) {
    safeError(new Error('AudioContext is unavailable in this environment.'));
    return cancelPlayback;
  }

  // 3. Set iOS audio session to playback mode so sound routes to loudspeaker
  setAudioSessionType('playback');

  // 4. Decode and play asynchronously
  (async () => {
    try {
      const audioBuffer = await decodeAudioDataSafe(ctx, arrayBuffer);

      if (isCancelled) {
        // Playback was aborted while decode was in-flight
        setAudioSessionType('play-and-record');
        return;
      }

      // Resume context if suspended by browser autoplay policy
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch (resumeErr) {
          console.warn('[AudioPlayback] Failed to resume suspended AudioContext:', resumeErr);
        }
      }

      if (isCancelled) {
        setAudioSessionType('play-and-record');
        return;
      }

      // If the context remains suspended, audio cannot play; report controlled error
      if (ctx.state === 'suspended') {
        safeError(
          new Error('AudioContext resume failed or blocked by autoplay policy; context remains suspended.')
        );
        return;
      }

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      sourceNode = source;

      source.onended = () => {
        clearWatchdog();
        sourceNode = null;
        if (!isCancelled) {
          safeEnd();
        }
      };

      isCurrentlyPlaying = true;
      onStart?.();
      source.start(0);

      // Duration-based safety watchdog (audio duration + dynamic grace period)
      const durationSec = audioBuffer.duration || 0;
      const watchdogTimeoutMs =
        options?.watchdogDelayMs ??
        (Math.round(durationSec * 1000) + Math.max(1200, Math.round(durationSec * 150)));

      watchdogTimer = setTimeout(() => {
        watchdogTimer = null;
        if (!isCancelled && !hasSettled) {
          console.warn(
            `[AudioPlayback] Safety watchdog fired: AudioBufferSourceNode.onended missed after ${watchdogTimeoutMs}ms.`
          );
          if (sourceNode) {
            try {
              sourceNode.onended = null;
              sourceNode.stop();
              sourceNode.disconnect();
            } catch {
              // Ignore if already stopped
            }
            sourceNode = null;
          }
          safeEnd();
        }
      }, watchdogTimeoutMs);
    } catch (err) {
      if (!isCancelled) {
        safeError(err);
      }
    }
  })();

  return cancelPlayback;
}

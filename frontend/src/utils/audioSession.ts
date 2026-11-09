/**
 * iOS Safari W3C AudioSession management utility.
 * Manages iOS AVAudioSession routing between 'playback' (loudspeaker)
 * and 'play-and-record' (microphone streaming).
 */

export type AudioSessionType = 'auto' | 'playback' | 'play-and-record' | 'ambient';

export function setAudioSessionType(type: AudioSessionType): boolean {
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

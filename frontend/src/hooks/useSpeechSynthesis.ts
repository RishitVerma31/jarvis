/**
 * Custom hook managing Web Speech API Text-to-Speech (TTS).
 * Provides clean Jarvis voice articulation and acoustic loop suppression.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { primeAudioContext } from '../utils/audioChime';
import { setAudioSessionType } from '../utils/audioSession';

/**
 * Strip Markdown tokens, fenced code blocks, and URLs so Jarvis speaks naturally.
 */
function cleanMarkdownForSpeech(text: string): string {
  return text
    // Remove fenced code blocks completely (Jarvis shouldn't read raw code aloud)
    .replace(/```[\s\S]*?```/g, 'Code block omitted.')
    // Remove inline code
    .replace(/`([^`]+)`/g, '$1')
    // Remove Markdown links [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove bare URLs
    .replace(/https?:\/\/\S+/g, 'link')
    // Remove headers (# Header)
    .replace(/^#{1,6}\s+/gm, '')
    // Remove bold and italics
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    // Remove blockquotes
    .replace(/^\s*>\s+/gm, '')
    // Clean up excessive whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

export function useSpeechSynthesis() {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(false);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const selectedVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const activeUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const speakDispatchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Helper to find preferred Jarvis voice
  const findPreferredVoice = (voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null => {
    if (!voices || voices.length === 0) return null;
    const preferredNames = ['Daniel', 'Oliver', 'Arthur', 'George', 'Samantha', 'Karen'];
    for (const name of preferredNames) {
      const found = voices.find((v) => v.name.includes(name) && v.lang.startsWith('en'));
      if (found) return found;
    }
    return voices.find((v) => v.lang === 'en-GB') || voices.find((v) => v.lang.startsWith('en')) || null;
  };

  // Load and pick Jarvis voice
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return;
    }

    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      setAvailableVoices(voices);
      selectedVoiceRef.current = findPreferredVoice(voices);
    };

    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;

    return () => {
      if (speakDispatchTimerRef.current) {
        clearTimeout(speakDispatchTimerRef.current);
        speakDispatchTimerRef.current = null;
      }
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
      }
      if (typeof window !== 'undefined') {
        (window as unknown as { __jarvis_active_utterance: SpeechSynthesisUtterance | null }).__jarvis_active_utterance = null;
        if ('speechSynthesis' in window) {
          window.speechSynthesis.cancel();
        }
      }
    };
  }, []);

  /**
   * Prime/unlock audio playback and Web Speech API on iOS Safari / WebKit.
   * iOS requires user activation within a touch/click event to authorize speech playback.
   */
  const unlockAudio = useCallback(() => {
    if (typeof window === 'undefined') return false;

    // 1. Prime SpeechSynthesis with an empty/silent utterance inside user gesture
    if ('speechSynthesis' in window) {
      try {
        const silentUtterance = new SpeechSynthesisUtterance(' ');
        silentUtterance.volume = 0.01;
        silentUtterance.rate = 10;
        window.speechSynthesis.speak(silentUtterance);
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      } catch (err) {
        console.warn('[SpeechSynthesis] Failed to prime utterance:', err);
      }
    }

    // 2. Prime Web Audio AudioContext if available
    try {
      primeAudioContext();
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioContextClass) {
        const tempCtx = new AudioContextClass();
        if (tempCtx.state === 'suspended') {
          tempCtx.resume().catch(() => {});
        }
        const buffer = tempCtx.createBuffer(1, 1, 22050);
        const source = tempCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(tempCtx.destination);
        source.start(0);
        setTimeout(() => {
          tempCtx.close().catch(() => {});
        }, 300);
      }
    } catch (err) {
      console.warn('[SpeechSynthesis] Failed to prime Web Audio:', err);
    }

    setIsAudioUnlocked(true);
    return true;
  }, []);

  const stopSpeaking = useCallback(() => {
    if (speakDispatchTimerRef.current) {
      clearTimeout(speakDispatchTimerRef.current);
      speakDispatchTimerRef.current = null;
    }
    if (fallbackTimerRef.current) {
      clearTimeout(fallbackTimerRef.current);
      fallbackTimerRef.current = null;
    }
    if (activeUtteranceRef.current) {
      activeUtteranceRef.current.onstart = null;
      activeUtteranceRef.current.onend = null;
      activeUtteranceRef.current.onerror = null;
      activeUtteranceRef.current = null;
    }
    if (typeof window !== 'undefined') {
      (window as unknown as { __jarvis_active_utterance: SpeechSynthesisUtterance | null }).__jarvis_active_utterance = null;
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    }
    setIsSpeaking(false);
  }, []);

  const speak = useCallback(
    (text: string, onStart?: () => void, onEnd?: () => void) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
        onEnd?.();
        return;
      }

      const cleanText = cleanMarkdownForSpeech(text);
      if (!cleanText) {
        onEnd?.();
        return;
      }

      // Clear any pending timer or previous utterance handlers
      if (speakDispatchTimerRef.current) {
        clearTimeout(speakDispatchTimerRef.current);
        speakDispatchTimerRef.current = null;
      }

      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }

      if (activeUtteranceRef.current) {
        activeUtteranceRef.current.onstart = null;
        activeUtteranceRef.current.onend = null;
        activeUtteranceRef.current.onerror = null;
        activeUtteranceRef.current = null;
      }

      // Set iOS audio session to playback mode so sound routes to loudspeaker
      setAudioSessionType('playback');

      const utterance = new SpeechSynthesisUtterance(cleanText);

      // Retain active utterance reference to prevent Chromium/WebKit garbage-collection bug
      activeUtteranceRef.current = utterance;
      if (typeof window !== 'undefined') {
        (window as unknown as { __jarvis_active_utterance: SpeechSynthesisUtterance | null }).__jarvis_active_utterance = utterance;
      }

      // Dynamically resolve voice if voices were loaded asynchronously on iOS
      if (!selectedVoiceRef.current && window.speechSynthesis.getVoices) {
        const voices = window.speechSynthesis.getVoices();
        if (voices.length > 0) {
          selectedVoiceRef.current = findPreferredVoice(voices);
        }
      }

      if (selectedVoiceRef.current) {
        utterance.voice = selectedVoiceRef.current;
      }

      // Iron Man Jarvis persona parameters
      utterance.pitch = 0.95; // Slightly deeper, refined resonance
      utterance.rate = 1.05; // Articulate, measured pace

      let hasCompleted = false;

      const cleanupAndComplete = (invokeCallback: boolean) => {
        if (hasCompleted) return;
        hasCompleted = true;

        if (speakDispatchTimerRef.current) {
          clearTimeout(speakDispatchTimerRef.current);
          speakDispatchTimerRef.current = null;
        }

        if (fallbackTimerRef.current) {
          clearTimeout(fallbackTimerRef.current);
          fallbackTimerRef.current = null;
        }

        if (activeUtteranceRef.current === utterance) {
          activeUtteranceRef.current = null;
          if (typeof window !== 'undefined') {
            (window as unknown as { __jarvis_active_utterance: SpeechSynthesisUtterance | null }).__jarvis_active_utterance = null;
          }
        }

        setIsSpeaking(false);

        if (invokeCallback) {
          onEnd?.();
        }
      };

      utterance.onstart = () => {
        setIsSpeaking(true);
        onStart?.();
      };

      utterance.onend = () => {
        cleanupAndComplete(true);
      };

      utterance.onerror = (err) => {
        // If cancelled via stopSpeaking/cancel(), 'canceled' or 'interrupted' is raised
        if (err.error === 'canceled' || err.error === 'interrupted') {
          cleanupAndComplete(false);
        } else {
          console.warn('[SpeechSynthesis] Utterance error:', err);
          cleanupAndComplete(true);
        }
      };

      // Fallback safety timeout in case WebKit drops onend event (prevents permanent speaking lock)
      const wordCount = cleanText.split(/\s+/).filter(Boolean).length;
      const estimatedDurationMs = Math.max(5000, (wordCount / 2) * 1000 + 4000);
      fallbackTimerRef.current = setTimeout(() => {
        console.warn('[SpeechSynthesis] Utterance safety fallback timer fired');
        cleanupAndComplete(true);
      }, estimatedDurationMs);

      const dispatchSpeak = () => {
        if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
        window.speechSynthesis.speak(utterance);
        if (window.speechSynthesis.paused) {
          window.speechSynthesis.resume();
        }
      };

      // Guard against WebKit cancel() -> speak() native audio thread queue race condition
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.cancel();
        speakDispatchTimerRef.current = setTimeout(() => {
          speakDispatchTimerRef.current = null;
          dispatchSpeak();
        }, 60);
      } else {
        dispatchSpeak();
      }
    },
    []
  );

  /**
   * User-triggered speech test to prime audio and verify output volume/clarity.
   */
  const testSpeech = useCallback(
    (text = 'J.A.R.V.I.S. audio online.') => {
      primeAudioContext();
      setIsAudioUnlocked(true);
      setAudioSessionType('playback');
      speak(text);
    },
    [speak]
  );

  return {
    speak,
    stopSpeaking,
    unlockAudio,
    testSpeech,
    isSpeaking,
    isAudioUnlocked,
    availableVoices,
  };
}

/**
 * Custom hook managing Web Speech API Text-to-Speech (TTS).
 * Provides clean Jarvis voice articulation and acoustic loop suppression.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

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
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const selectedVoiceRef = useRef<SpeechSynthesisVoice | null>(null);

  // Load and pick Jarvis voice
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return;
    }

    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      setAvailableVoices(voices);

      // Search for British / refined English voices (Daniel, Samantha, Oliver, etc.)
      const preferredNames = ['Daniel', 'Oliver', 'Arthur', 'George', 'Samantha', 'Karen'];
      let found: SpeechSynthesisVoice | undefined;

      for (const name of preferredNames) {
        found = voices.find((v) => v.name.includes(name) && v.lang.startsWith('en'));
        if (found) break;
      }

      if (!found) {
        // Fallback to any en-GB or en-US voice
        found = voices.find((v) => v.lang === 'en-GB') || voices.find((v) => v.lang.startsWith('en'));
      }

      selectedVoiceRef.current = found || null;
    };

    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;

    return () => {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const stopSpeaking = useCallback(() => {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
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

      // Cancel any ongoing speech
      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(cleanText);

      if (selectedVoiceRef.current) {
        utterance.voice = selectedVoiceRef.current;
      }

      // Iron Man Jarvis persona parameters
      utterance.pitch = 0.95; // Slightly deeper, refined resonance
      utterance.rate = 1.05; // Articulate, measured pace

      utterance.onstart = () => {
        setIsSpeaking(true);
        onStart?.();
      };

      utterance.onend = () => {
        setIsSpeaking(false);
        onEnd?.();
      };

      utterance.onerror = (err) => {
        console.warn('[SpeechSynthesis] Utterance error:', err);
        setIsSpeaking(false);
        onEnd?.();
      };

      window.speechSynthesis.speak(utterance);
    },
    []
  );

  return {
    speak,
    stopSpeaking,
    isSpeaking,
    availableVoices,
  };
}

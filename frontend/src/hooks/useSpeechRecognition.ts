import { useState, useEffect, useRef, useCallback } from 'react';

// SpeechRecognition type declarations for browser compatibility
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string; message?: string }) => void) | null;
  onresult: ((event: {
    resultIndex: number;
    results: {
      length: number;
      item: (index: number) => {
        isFinal: boolean;
        item: (idx: number) => { transcript: string };
      };
      [index: number]: {
        isFinal: boolean;
        [idx: number]: { transcript: string };
      };
    };
  }) => void) | null;
}

interface WindowWithSpeech extends Window {
  SpeechRecognition?: { new (): SpeechRecognitionInstance };
  webkitSpeechRecognition?: { new (): SpeechRecognitionInstance };
}

export function useSpeechRecognition() {
  const [isListening, setIsListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const onTranscriptRef = useRef<((text: string) => void) | null>(null);

  const SpeechRecognitionClass =
    typeof window !== 'undefined'
      ? (window as unknown as WindowWithSpeech).SpeechRecognition ||
        (window as unknown as WindowWithSpeech).webkitSpeechRecognition
      : undefined;

  const isSupported = Boolean(SpeechRecognitionClass);

  useEffect(() => {
    if (!SpeechRecognitionClass) return;

    try {
      const recognition = new SpeechRecognitionClass();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      recognition.onstart = () => {
        setIsListening(true);
        setError(null);
      };

      recognition.onresult = (event) => {
        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const item = event.results[i];
          if (item.isFinal) {
            finalTranscript += item[0].transcript;
          } else {
            interimTranscript += item[0].transcript;
          }
        }

        const currentText = finalTranscript || interimTranscript;
        if (currentText && onTranscriptRef.current) {
          onTranscriptRef.current(currentText);
        }
      };

      recognition.onerror = (event) => {
        if (event.error === 'no-speech') {
          // Normal silence, no error needed
          return;
        }
        if (event.error === 'not-allowed' || event.error === 'permission-denied') {
          setError('Microphone access denied. Please grant permission in browser settings.');
        } else {
          setError(`Speech recognition error: ${event.error}`);
        }
        setIsListening(false);
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    } catch (err) {
      setError('Failed to initialize speech recognition engine.');
    }

    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // Ignore abort errors on cleanup
        }
      }
    };
  }, [SpeechRecognitionClass]);

  const startListening = useCallback(
    (onTranscript: (text: string) => void) => {
      setError(null);
      onTranscriptRef.current = onTranscript;

      if (!recognitionRef.current) {
        if (!isSupported) {
          setError('Speech recognition is not supported in this browser.');
        }
        return;
      }

      try {
        recognitionRef.current.start();
      } catch (err) {
        // Recognition may already be running
        try {
          recognitionRef.current.stop();
          setTimeout(() => recognitionRef.current?.start(), 150);
        } catch {
          setError('Could not start microphone listener.');
        }
      }
    },
    [isSupported]
  );

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Ignore stop errors
      }
    }
    setIsListening(false);
  }, []);

  const toggleListening = useCallback(
    (onTranscript: (text: string) => void) => {
      if (isListening) {
        stopListening();
      } else {
        startListening(onTranscript);
      }
    },
    [isListening, startListening, stopListening]
  );

  return {
    isListening,
    error,
    isSupported,
    startListening,
    stopListening,
    toggleListening,
  };
}


/**
 * Hook coordinating microphone streaming, Voice WebSocket,
 * conversation state machine, and audio visualizer levels.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { VoiceSocket } from '../services/voiceSocket';
import { playJarvisWakeChime } from '../utils/audioChime';
import { setAudioSessionType } from '../utils/audioSession';
import {
  playBase64WavAudio,
  stopAudioPlayback,
  isAudioPlaying,
  getPlaybackAudioContext,
} from '../utils/audioPlayback';
import { useSpeechSynthesis } from './useSpeechSynthesis';
import { useUIStore } from '../stores/useUIStore';
import type { MessageSchema, SessionDetailResponse } from '../types/api';
import type { VoiceMetrics, VoiceServerEvent, VoiceState } from '../types/voice';

/**
 * Resample Float32 audio chunk to 16kHz 16-bit little-endian PCM.
 */
function resampleTo16kPCM(
  inputBuffer: Float32Array,
  inputSampleRate: number
): Int16Array {
  const outputSampleRate = 16000;
  if (inputSampleRate === outputSampleRate) {
    const pcm = new Int16Array(inputBuffer.length);
    for (let i = 0; i < inputBuffer.length; i++) {
      const s = Math.max(-1, Math.min(1, inputBuffer[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return pcm;
  }

  const sampleRatio = inputSampleRate / outputSampleRate;
  const outputLength = Math.round(inputBuffer.length / sampleRatio);
  const pcm = new Int16Array(outputLength);

  let offsetResult = 0;
  let offsetInput = 0;

  while (offsetResult < outputLength) {
    const nextOffsetInput = Math.round((offsetResult + 1) * sampleRatio);
    let accum = 0;
    let count = 0;
    for (let i = offsetInput; i < nextOffsetInput && i < inputBuffer.length; i++) {
      accum += inputBuffer[i];
      count++;
    }
    const sample = count > 0 ? accum / count : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    pcm[offsetResult] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    offsetResult++;
    offsetInput = nextOffsetInput;
  }

  return pcm;
}

export function useVoiceAssistant() {
  const queryClient = useQueryClient();
  const {
    activeSessionId,
    setActiveSessionId,
    isVoiceModeActive,
    setVoiceModeActive,
    isVoiceMuted,
    setVoiceMuted,
  } = useUIStore();

  const [voiceState, setVoiceState] = useState<VoiceState>('STANDBY');
  const [statusMessage, setStatusMessage] = useState<string>('Voice Assistant offline');
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [lastMetrics, setLastMetrics] = useState<VoiceMetrics | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const voiceSocketRef = useRef<VoiceSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const isCapturingRef = useRef<boolean>(false);
  const isStreamingPausedRef = useRef<boolean>(false);
  const echoBufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAudioPlaybackStopRef = useRef<(() => void) | null>(null);
  const currentTurnIdRef = useRef<number>(0);

  // Keep ref to latest session ID without triggering effect re-execution
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  // Keep refs for audio processor callback so it reads latest state without rebuilding node
  const isVoiceModeActiveRef = useRef(isVoiceModeActive);
  useEffect(() => {
    isVoiceModeActiveRef.current = isVoiceModeActive;
  }, [isVoiceModeActive]);

  const isVoiceMutedRef = useRef(isVoiceMuted);
  useEffect(() => {
    isVoiceMutedRef.current = isVoiceMuted;
  }, [isVoiceMuted]);

  const {
    speak,
    stopSpeaking: stopSpeechSynthesis,
    isSpeaking: isBrowserSpeaking,
    unlockAudio: baseUnlockAudio,
    testSpeech,
    isAudioUnlocked,
  } = useSpeechSynthesis();

  // Stop all active Kokoro audio playback and browser speech synthesis cleanly
  const cancelAllSpeech = useCallback(() => {
    currentTurnIdRef.current++;

    if (echoBufferTimerRef.current) {
      clearTimeout(echoBufferTimerRef.current);
      echoBufferTimerRef.current = null;
    }

    if (activeAudioPlaybackStopRef.current) {
      activeAudioPlaybackStopRef.current();
      activeAudioPlaybackStopRef.current = null;
    }
    stopAudioPlayback();
    stopSpeechSynthesis();

    isStreamingPausedRef.current = false;
    setAudioSessionType('play-and-record');
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
    }
  }, [stopSpeechSynthesis]);

  const handleStopSpeaking = useCallback(() => {
    cancelAllSpeech();
    if (voiceSocketRef.current?.isConnected()) {
      voiceSocketRef.current.sendMessage({ type: 'stop_speaking' });
    }
    setVoiceState('WAKE_LISTENING');
    setStatusMessage('Standing by. Listening for "Hey Jarvis".');
  }, [cancelAllSpeech]);

  const emergencyStop = useCallback(() => {
    cancelAllSpeech();
    if (voiceSocketRef.current?.isConnected()) {
      voiceSocketRef.current.sendMessage({ type: 'emergency_stop' });
    }
    setVoiceState('WAKE_LISTENING');
    setStatusMessage('Emergency stop triggered. Standing by.');
  }, [cancelAllSpeech]);

  const handleUnlockAudio = useCallback(() => {
    try {
      getPlaybackAudioContext();
    } catch {
      // Best-effort priming
    }
    return baseUnlockAudio();
  }, [baseUnlockAudio]);

  const handleTestSpeech = useCallback(() => {
    cancelAllSpeech();
    return testSpeech();
  }, [cancelAllSpeech, testSpeech]);

  // Keep active session synced to WebSocket
  useEffect(() => {
    if (activeSessionId && voiceSocketRef.current?.isConnected()) {
      voiceSocketRef.current.sendMessage({
        type: 'set_session',
        session_id: activeSessionId,
      });
    }
  }, [activeSessionId]);

  // Handle server events
  const handleServerEvent = useCallback(
    (event: VoiceServerEvent) => {
      switch (event.type) {
        case 'state_change':
          setVoiceState(event.state);
          if (event.message) {
            setStatusMessage(event.message);
          }
          break;

        case 'wake_detected':
          setVoiceState('WAKE_DETECTED');
          setStatusMessage(`"Hey Jarvis" detected! (${Math.round(event.score * 100)}% match)`);
          playJarvisWakeChime();
          break;

        case 'transcription':
          setStatusMessage(`Recognized: "${event.text}"`);
          break;

        case 'chat_response': {
          setVoiceState('SPEAKING');
          const targetSessionId = event.session_id;

          if (!activeSessionIdRef.current) {
            setActiveSessionId(targetSessionId);
          }

          if (event.metrics) {
            setLastMetrics(event.metrics);
          }

          // Hydrate conversation cache immediately
          queryClient.setQueryData<SessionDetailResponse | null>(
            ['session', targetSessionId],
            (old) => {
              const now = event.created_at || new Date().toISOString();
              const userMsg: MessageSchema = {
                id: Date.now() - 1,
                role: 'user',
                content: event.user_message,
                created_at: now,
              };
              const assistantMsg: MessageSchema = {
                id: Date.now(),
                role: 'assistant',
                content: event.reply,
                created_at: now,
              };

              if (!old) {
                return {
                  session_id: targetSessionId,
                  title: event.user_message.slice(0, 50),
                  created_at: now,
                  updated_at: now,
                  total_messages: 2,
                  messages: [userMsg, assistantMsg],
                };
              }

              return {
                ...old,
                updated_at: now,
                total_messages: old.total_messages + 2,
                messages: [...old.messages, userMsg, assistantMsg],
              };
            }
          );

          queryClient.invalidateQueries({ queryKey: ['sessions'] });

          // Cancel any previous speech or audio playback and assign new turn ID
          cancelAllSpeech();
          const turnId = currentTurnIdRef.current;

          // Mute hardware microphone track before starting speech to release acoustic loopback
          if (mediaStreamRef.current) {
            mediaStreamRef.current.getAudioTracks().forEach((track) => {
              track.enabled = false;
            });
          }
          isStreamingPausedRef.current = true;

          // Speak reply with acoustic loopback prevention and single-dispatch guard
          let ttsCompletedDispatched = false;
          const sendTTSCompleted = () => {
            if (currentTurnIdRef.current !== turnId) return;
            if (ttsCompletedDispatched) return;
            ttsCompletedDispatched = true;
            activeAudioPlaybackStopRef.current = null;
            isStreamingPausedRef.current = false;

            // 1. Restore iOS audio session to play-and-record for voice input
            setAudioSessionType('play-and-record');

            // 2. Re-enable hardware microphone track after speech completes
            if (mediaStreamRef.current) {
              mediaStreamRef.current.getAudioTracks().forEach((track) => {
                track.enabled = true;
              });
            }

            // 3. Signal tts_completed to backend
            if (voiceSocketRef.current?.isConnected()) {
              voiceSocketRef.current.sendMessage({ type: 'tts_completed' });
            }
          };

          // 300ms acoustic echo suppression buffer delay
          const scheduleTTSCompletion = () => {
            if (currentTurnIdRef.current !== turnId) return;
            if (echoBufferTimerRef.current) {
              clearTimeout(echoBufferTimerRef.current);
            }
            echoBufferTimerRef.current = setTimeout(() => {
              if (currentTurnIdRef.current !== turnId) return;
              echoBufferTimerRef.current = null;
              sendTTSCompleted();
            }, 300);
          };

          // Fallback to browser SpeechSynthesis if Kokoro audio fails or is absent
          const fallbackToSpeechSynthesis = (reason?: unknown) => {
            if (currentTurnIdRef.current !== turnId) return;
            console.warn('[VoiceAssistant] Kokoro playback failed, falling back to browser SpeechSynthesis:', reason);
            activeAudioPlaybackStopRef.current = null;
            try {
              speak(
                event.reply,
                () => {
                  if (currentTurnIdRef.current !== turnId) return;
                  isStreamingPausedRef.current = true;
                },
                () => {
                  scheduleTTSCompletion();
                }
              );
            } catch (fallbackErr) {
              console.error('[VoiceAssistant] Fallback speech synthesis failed:', fallbackErr);
              cancelAllSpeech();
            }
          };

          if (event.audio && typeof event.audio === 'string' && event.audio.trim().length > 0) {
            try {
              let playbackCancelled = false;
              const cancelAudio = playBase64WavAudio(
                event.audio,
                () => {
                  if (currentTurnIdRef.current !== turnId) return;
                  isStreamingPausedRef.current = true;
                },
                () => {
                  if (currentTurnIdRef.current !== turnId) return;
                  activeAudioPlaybackStopRef.current = null;
                  scheduleTTSCompletion();
                },
                (err) => {
                  playbackCancelled = true;
                  fallbackToSpeechSynthesis(err);
                },
                { autoRestoreSession: false }
              );
              if (!playbackCancelled) {
                activeAudioPlaybackStopRef.current = cancelAudio;
              } else {
                activeAudioPlaybackStopRef.current = null;
              }
            } catch (err) {
              fallbackToSpeechSynthesis(err);
            }
          } else {
            speak(
              event.reply,
              () => {
                if (currentTurnIdRef.current !== turnId) return;
                isStreamingPausedRef.current = true;
              },
              () => {
                scheduleTTSCompletion();
              }
            );
          }
          break;
        }

        case 'empty_speech':
          setStatusMessage(event.message || 'No speech detected.');
          break;

        case 'error':
          setVoiceState('ERROR');
          setErrorMessage(event.message);
          cancelAllSpeech();
          break;
      }
    },
    [cancelAllSpeech, queryClient, setActiveSessionId, speak]
  );

  // Teardown microphone and audio pipeline cleanly
  const stopAudioCapture = useCallback(() => {
    isCapturingRef.current = false;

    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.onaudioprocess = null;
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }

    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (audioContextRef.current) {
      if (audioContextRef.current.state !== 'closed') {
        audioContextRef.current.close().catch(() => {});
      }
      audioContextRef.current = null;
    }

    setAudioLevel(0);
  }, []);

  // Setup microphone and streaming (guarded against multiple concurrent instances)
  const startAudioCapture = useCallback(async () => {
    // Prevent multiple simultaneous audio capture pipelines
    if (isCapturingRef.current || audioContextRef.current) {
      return;
    }
    isCapturingRef.current = true;

    try {
      setAudioSessionType('play-and-record');
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // If capture was stopped while getUserMedia was pending, discard stream immediately
      if (!isCapturingRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      mediaStreamRef.current = stream;

      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioContextClass();
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;

      // 4096 samples per buffer is a good balance between latency and JS overhead (~85ms @ 48kHz)
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      scriptProcessorRef.current = processor;

      processor.onaudioprocess = (e) => {
        if (!isVoiceModeActiveRef.current || isVoiceMutedRef.current || isStreamingPausedRef.current) {
          setAudioLevel(0);
          return;
        }

        const inputData = e.inputBuffer.getChannelData(0);

        // Compute RMS audio level for waveform animation
        let sumSquares = 0;
        for (let i = 0; i < inputData.length; i++) {
          sumSquares += inputData[i] * inputData[i];
        }
        const rms = Math.sqrt(sumSquares / inputData.length);
        setAudioLevel(Math.min(1.0, rms * 6.0));

        // Resample and send to WebSocket
        const pcm16 = resampleTo16kPCM(inputData, audioCtx.sampleRate);
        voiceSocketRef.current?.sendAudio(pcm16);
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);
    } catch (err) {
      isCapturingRef.current = false;
      console.error('[VoiceAssistant] Microphone access denied or failed:', err);
      setVoiceState('ERROR');
      setErrorMessage('Microphone access denied. Please grant microphone permission.');
      setVoiceModeActive(false);
    }
  }, [setVoiceModeActive]);

  // Synchronize Voice mode on/off
  useEffect(() => {
    if (isVoiceModeActive) {
      setErrorMessage(null);
      if (!voiceSocketRef.current) {
        voiceSocketRef.current = new VoiceSocket();
      }

      const removeEventListener = voiceSocketRef.current.addEventListener(handleServerEvent);
      const removeConnectionListener = voiceSocketRef.current.addConnectionListener((connected) => {
        if (!connected) {
          cancelAllSpeech();
        }
      });
      voiceSocketRef.current.connect();

      if (activeSessionIdRef.current) {
        voiceSocketRef.current.sendMessage({
          type: 'set_session',
          session_id: activeSessionIdRef.current,
        });
      }

      startAudioCapture();

      return () => {
        cancelAllSpeech();
        removeEventListener();
        removeConnectionListener();
        stopAudioCapture();
      };
    } else {
      cancelAllSpeech();
      stopAudioCapture();
      setAudioSessionType('auto');
      if (voiceSocketRef.current) {
        voiceSocketRef.current.disconnect();
        voiceSocketRef.current = null;
      }
      setVoiceState('STANDBY');
      setStatusMessage('Voice Assistant offline');
    }
  }, [isVoiceModeActive, cancelAllSpeech, handleServerEvent, startAudioCapture, stopAudioCapture]);

  // Handle Mute toggle
  const toggleMute = useCallback(() => {
    const newMuted = !isVoiceMuted;
    setVoiceMuted(newMuted);
    if (voiceSocketRef.current?.isConnected()) {
      voiceSocketRef.current.sendMessage({
        type: newMuted ? 'mute' : 'unmute',
      });
    }
  }, [isVoiceMuted, setVoiceMuted]);

  return {
    voiceState,
    statusMessage,
    audioLevel,
    lastMetrics,
    errorMessage,
    isSpeaking: isBrowserSpeaking || isAudioPlaying() || voiceState === 'SPEAKING',
    isVoiceModeActive,
    isVoiceMuted,
    isAudioUnlocked,
    unlockAudio: handleUnlockAudio,
    testSpeech: handleTestSpeech,
    setVoiceModeActive,
    toggleMute,
    emergencyStop,
    stopSpeaking: handleStopSpeaking,
  };
}

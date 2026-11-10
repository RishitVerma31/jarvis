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
  const [isFollowUp, setIsFollowUp] = useState<boolean>(false);

  const voiceSocketRef = useRef<VoiceSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const isCapturingRef = useRef<boolean>(false);
  const isStreamingPausedRef = useRef<boolean>(false);
  const echoBufferTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ackTimeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeAudioPlaybackStopRef = useRef<(() => void) | null>(null);
  const currentTurnIdRef = useRef<number>(0);
  const settledTurnIdRef = useRef<number | null>(null);
  const retryCountPerTurnRef = useRef<Map<number, number>>(new Map());
  const hasInitializedStartupRef = useRef<boolean>(false);

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

  const isBrowserSpeakingRef = useRef(isBrowserSpeaking);
  useEffect(() => {
    isBrowserSpeakingRef.current = isBrowserSpeaking;
  }, [isBrowserSpeaking]);

  // Stop all active Kokoro audio playback and browser speech synthesis cleanly
  const cancelAllSpeech = useCallback(() => {
    currentTurnIdRef.current++;
    settledTurnIdRef.current = null;
    retryCountPerTurnRef.current.clear();

    if (echoBufferTimerRef.current) {
      clearTimeout(echoBufferTimerRef.current);
      echoBufferTimerRef.current = null;
    }

    if (ackTimeoutTimerRef.current) {
      clearTimeout(ackTimeoutTimerRef.current);
      ackTimeoutTimerRef.current = null;
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
    setIsFollowUp(false);
    if (voiceSocketRef.current?.isConnected()) {
      voiceSocketRef.current.sendMessage({ type: 'stop_speaking' });
    }
    setVoiceState('WAKE_LISTENING');
    setStatusMessage('Standing by. Listening for "Hey Jarvis".');
  }, [cancelAllSpeech]);

  const emergencyStop = useCallback(() => {
    cancelAllSpeech();
    setIsFollowUp(false);
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

  // Safe state resynchronization if backend tts_completed acknowledgement times out
  const handleAckTimeout = useCallback(
    (timedOutTurnId: number) => {
      // 1. Guard against stale or already-settled turns
      if (currentTurnIdRef.current !== timedOutTurnId) {
        return;
      }

      const retryCount = retryCountPerTurnRef.current.get(timedOutTurnId) ?? 0;
      if (retryCount >= 1) {
        console.warn(
          `[VoiceAssistant] TTS completion acknowledgement retry timed out for turn ${timedOutTurnId}. Maintaining safe muted state.`
        );
        setStatusMessage('Speech completion unacknowledged. Tap stop or emergency stop to reset.');
        return;
      }

      console.warn(
        `[VoiceAssistant] TTS completed acknowledgement timed out for turn ${timedOutTurnId}. Initiating safe state resynchronization.`
      );

      // 2. Do NOT blindly enable microphone tracks or resume PCM transmission!
      // 3. Inspect socket connection health
      if (!voiceSocketRef.current?.isConnected()) {
        console.warn(
          '[VoiceAssistant] Voice WebSocket is disconnected during ack timeout. Performing controlled reconnection.'
        );
        cancelAllSpeech();
        voiceSocketRef.current?.reconnect();
        return;
      }

      // 4. Connection is healthy: query authoritative backend state
      voiceSocketRef.current.sendMessage({
        type: 'get_state',
      });
    },
    [cancelAllSpeech]
  );

  // Handle server events
  const handleServerEvent = useCallback(
    (event: VoiceServerEvent) => {
      switch (event.type) {
        case 'state_change': {
          // 1. Guard against stale or unversioned turn events BEFORE modifying any UI or audio state.
          // Legitimate initial events occur ONLY ONCE during startup initialization.
          const isInitialEvent =
            !hasInitializedStartupRef.current &&
            (Boolean(event.initial) ||
              (currentTurnIdRef.current === 0 && (event.turn_id === undefined || event.turn_id === 0)));

          if (isInitialEvent) {
            hasInitializedStartupRef.current = true;
          } else {
            // Missing turn_id on active session events is rejected
            if (event.turn_id === undefined) {
              console.warn(
                `[VoiceAssistant] Rejecting unversioned state_change (${event.state}) during active turn ${currentTurnIdRef.current}:`,
                event
              );
              break;
            }

            // Older turn_id is strictly rejected, EVEN IF the event carries initial: true
            if (event.turn_id < currentTurnIdRef.current) {
              console.warn(
                `[VoiceAssistant] Rejecting stale state_change (${event.state}) for turn ${event.turn_id} (active turn is ${currentTurnIdRef.current}):`,
                event
              );
              break;
            }
          }

          // 2. Event is valid: advance currentTurnIdRef if the event brings a newer turn_id
          if (event.turn_id !== undefined && event.turn_id > currentTurnIdRef.current) {
            currentTurnIdRef.current = event.turn_id;
          }

          // Clear any pending ack timeout timer if we received a valid WAKE_LISTENING transition for current turn
          if (event.state === 'WAKE_LISTENING' && ackTimeoutTimerRef.current) {
            clearTimeout(ackTimeoutTimerRef.current);
            ackTimeoutTimerRef.current = null;
          }

          // 3. Mutate React UI state (only reached if event passed validation)
          setVoiceState(event.state);
          if (event.message) {
            setStatusMessage(event.message);
          }
          setIsFollowUp(Boolean(event.follow_up));

          // 4. States where microphone PCM streaming MUST remain active: WAKE_LISTENING, RECORDING
          if (event.state === 'WAKE_LISTENING' || event.state === 'RECORDING') {
            // Restore iOS audio session to play-and-record for voice input
            setAudioSessionType('play-and-record');

            // Re-enable hardware microphone track
            if (mediaStreamRef.current) {
              mediaStreamRef.current.getAudioTracks().forEach((track) => {
                track.enabled = true;
              });
            }

            // Resume/keep PCM streaming active to WebSocket
            isStreamingPausedRef.current = false;

          // 5. States where microphone PCM streaming MUST be paused: TRANSCRIBING, PROCESSING, SPEAKING, MUTED
          } else if (
            event.state === 'TRANSCRIBING' ||
            event.state === 'PROCESSING' ||
            event.state === 'SPEAKING' ||
            event.state === 'MUTED'
          ) {
            // Mute hardware microphone tracks during speech output or when user-muted to eliminate acoustic loopback
            if (
              mediaStreamRef.current &&
              (event.state === 'SPEAKING' || event.state === 'MUTED')
            ) {
              mediaStreamRef.current.getAudioTracks().forEach((track) => {
                track.enabled = false;
              });
            }

            // Pause PCM transmission while backend processes or speaks
            isStreamingPausedRef.current = true;

            // Phase 1 Recovery Correction:
            // If backend reports SPEAKING for the exact turn whose local playback has already settled,
            // resend tts_completed exactly once for that turn.
            if (
              event.state === 'SPEAKING' &&
              event.turn_id !== undefined &&
              event.turn_id === currentTurnIdRef.current &&
              settledTurnIdRef.current === event.turn_id &&
              !isAudioPlaying() &&
              !isBrowserSpeakingRef.current
            ) {
              const currentRetries = retryCountPerTurnRef.current.get(event.turn_id) ?? 0;
              if (currentRetries === 0) {
                retryCountPerTurnRef.current.set(event.turn_id, 1);
                console.warn(
                  `[VoiceAssistant] Backend still in SPEAKING for settled turn ${event.turn_id}; retrying tts_completed (attempt 1/1).`
                );
                if (voiceSocketRef.current?.isConnected()) {
                  voiceSocketRef.current.sendMessage({
                    type: 'tts_completed',
                    turn_id: event.turn_id,
                  });
                }

                // Arm bounded timeout for the retry acknowledgement
                if (ackTimeoutTimerRef.current) {
                  clearTimeout(ackTimeoutTimerRef.current);
                }
                const ackTimeoutMs =
                  (globalThis as unknown as { __JARVIS_ACK_TIMEOUT_MS__?: number })
                    .__JARVIS_ACK_TIMEOUT_MS__ ?? 2500;
                const turnToRetry = event.turn_id;
                ackTimeoutTimerRef.current = setTimeout(() => {
                  ackTimeoutTimerRef.current = null;
                  handleAckTimeout(turnToRetry);
                }, ackTimeoutMs);
              } else {
                console.warn(
                  `[VoiceAssistant] Backend still in SPEAKING for turn ${event.turn_id} after retry; retaining safe muted state.`
                );
                setStatusMessage('Speech completion unacknowledged. Tap stop or emergency stop to reset.');
              }
            }
          }
          break;
        }

        case 'wake_detected':
          setIsFollowUp(false);
          setVoiceState('WAKE_DETECTED');
          setStatusMessage(`"Hey Jarvis" detected! (${Math.round(event.score * 100)}% match)`);
          playJarvisWakeChime();
          break;

        case 'transcription':
          setStatusMessage(`Recognized: "${event.text}"`);
          break;

        case 'chat_response': {
          setIsFollowUp(false);
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
          const turnId = event.turn_id ?? currentTurnIdRef.current;
          currentTurnIdRef.current = turnId;

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
            settledTurnIdRef.current = turnId;
            activeAudioPlaybackStopRef.current = null;

            // Signal tts_completed to backend with active turnId.
            // Hardware mic and PCM streaming remain paused until backend acknowledges WAKE_LISTENING!
            if (voiceSocketRef.current?.isConnected()) {
              voiceSocketRef.current.sendMessage({
                type: 'tts_completed',
                turn_id: turnId,
              });
            }

            // Schedule bounded safety timeout waiting for backend acknowledgement
            if (ackTimeoutTimerRef.current) {
              clearTimeout(ackTimeoutTimerRef.current);
            }
            const ackTimeoutMs =
              (globalThis as unknown as { __JARVIS_ACK_TIMEOUT_MS__?: number })
                .__JARVIS_ACK_TIMEOUT_MS__ ?? 2500;
            ackTimeoutTimerRef.current = setTimeout(() => {
              ackTimeoutTimerRef.current = null;
              handleAckTimeout(turnId);
            }, ackTimeoutMs);
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
          setIsFollowUp(false);
          setStatusMessage(event.message || 'No speech detected.');
          break;

        case 'error':
          setIsFollowUp(false);
          setVoiceState('ERROR');
          setErrorMessage(event.message);
          cancelAllSpeech();
          break;
      }
    },
    [cancelAllSpeech, handleAckTimeout, queryClient, setActiveSessionId, speak]
  );

  // Teardown microphone and audio pipeline cleanly
  const stopAudioCapture = useCallback(() => {
    isCapturingRef.current = false;
    settledTurnIdRef.current = null;
    retryCountPerTurnRef.current.clear();

    if (ackTimeoutTimerRef.current) {
      clearTimeout(ackTimeoutTimerRef.current);
      ackTimeoutTimerRef.current = null;
    }

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
          hasInitializedStartupRef.current = false;
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
        hasInitializedStartupRef.current = false;
      };
    } else {
      cancelAllSpeech();
      stopAudioCapture();
      setAudioSessionType('auto');
      if (voiceSocketRef.current) {
        voiceSocketRef.current.disconnect();
        voiceSocketRef.current = null;
      }
      hasInitializedStartupRef.current = false;
      currentTurnIdRef.current = 0;
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
    isFollowUp,
    unlockAudio: handleUnlockAudio,
    testSpeech: handleTestSpeech,
    setVoiceModeActive,
    toggleMute,
    emergencyStop,
    stopSpeaking: handleStopSpeaking,
  };
}

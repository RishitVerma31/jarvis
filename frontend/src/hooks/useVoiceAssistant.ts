/**
 * Hook coordinating microphone streaming, Voice WebSocket,
 * conversation state machine, and audio visualizer levels.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { VoiceSocket } from '../services/voiceSocket';
import { playJarvisWakeChime } from '../utils/audioChime';
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

  const { speak, stopSpeaking, isSpeaking } = useSpeechSynthesis();

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

          // Speak reply with acoustic loopback prevention and single-dispatch guard
          let ttsCompletedDispatched = false;
          const sendTTSCompleted = () => {
            if (ttsCompletedDispatched) return;
            ttsCompletedDispatched = true;
            isStreamingPausedRef.current = false;
            if (voiceSocketRef.current?.isConnected()) {
              voiceSocketRef.current.sendMessage({ type: 'tts_completed' });
            }
          };

          speak(
            event.reply,
            () => {
              isStreamingPausedRef.current = true;
            },
            () => {
              // Acoustic echo suppression buffer delay
              setTimeout(() => {
                sendTTSCompleted();
              }, 300);
            }
          );
          break;
        }

        case 'empty_speech':
          setStatusMessage(event.message || 'No speech detected.');
          break;

        case 'error':
          setVoiceState('ERROR');
          setErrorMessage(event.message);
          break;
      }
    },
    [queryClient, setActiveSessionId, speak]
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
      voiceSocketRef.current.connect();

      if (activeSessionIdRef.current) {
        voiceSocketRef.current.sendMessage({
          type: 'set_session',
          session_id: activeSessionIdRef.current,
        });
      }

      startAudioCapture();

      return () => {
        removeEventListener();
        stopAudioCapture();
      };
    } else {
      stopSpeaking();
      stopAudioCapture();
      if (voiceSocketRef.current) {
        voiceSocketRef.current.disconnect();
        voiceSocketRef.current = null;
      }
      setVoiceState('STANDBY');
      setStatusMessage('Voice Assistant offline');
    }
  }, [isVoiceModeActive, handleServerEvent, startAudioCapture, stopAudioCapture, stopSpeaking]);

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

  // Emergency stop
  const emergencyStop = useCallback(() => {
    stopSpeaking();
    isStreamingPausedRef.current = false;
    if (voiceSocketRef.current?.isConnected()) {
      voiceSocketRef.current.sendMessage({ type: 'emergency_stop' });
    }
    setVoiceState('WAKE_LISTENING');
    setStatusMessage('Emergency stop triggered. Standing by.');
  }, [stopSpeaking]);

  return {
    voiceState,
    statusMessage,
    audioLevel,
    lastMetrics,
    errorMessage,
    isSpeaking,
    isVoiceModeActive,
    isVoiceMuted,
    setVoiceModeActive,
    toggleMute,
    emergencyStop,
    stopSpeaking,
  };
}

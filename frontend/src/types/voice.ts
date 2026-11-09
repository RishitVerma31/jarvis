/**
 * Type definitions for Jarvis Voice Assistant (Stage 2.6).
 */

export type VoiceState =
  | 'STANDBY'
  | 'WAKE_LISTENING'
  | 'WAKE_DETECTED'
  | 'RECORDING'
  | 'TRANSCRIBING'
  | 'PROCESSING'
  | 'SPEAKING'
  | 'MUTED'
  | 'ERROR';

export interface VoiceMetrics {
  stt_latency_ms?: number;
  llm_latency_ms?: number;
  tts_latency_ms?: number;
}

export interface VoiceStateChangeEvent {
  type: 'state_change';
  state: VoiceState;
  message?: string;
}

export interface VoiceWakeDetectedEvent {
  type: 'wake_detected';
  score: number;
}

export interface VoiceTranscriptionEvent {
  type: 'transcription';
  text: string;
  latency_ms?: number;
}

export interface VoiceChatResponseEvent {
  type: 'chat_response';
  reply: string;
  user_message: string;
  session_id: string;
  model?: string;
  created_at: string;
  audio?: string;
  audio_mime?: string;
  voice?: string;
  metrics?: VoiceMetrics;
}

export interface VoiceEmptySpeechEvent {
  type: 'empty_speech';
  message: string;
}

export interface VoiceErrorEvent {
  type: 'error';
  message: string;
}

export interface VoicePongEvent {
  type: 'pong';
}

export type VoiceServerEvent =
  | VoiceStateChangeEvent
  | VoiceWakeDetectedEvent
  | VoiceTranscriptionEvent
  | VoiceChatResponseEvent
  | VoiceEmptySpeechEvent
  | VoiceErrorEvent
  | VoicePongEvent;

export type VoiceClientMessage =
  | { type: 'set_session'; session_id: string }
  | { type: 'mute' }
  | { type: 'unmute' }
  | { type: 'emergency_stop' }
  | { type: 'stop_speaking' }
  | { type: 'tts_completed' }
  | { type: 'resume' }
  | { type: 'ping' };


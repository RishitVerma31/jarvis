/**
 * Voice controls and telemetry widget for Project Jarvis.
 */

import React from 'react';
import { Mic, MicOff, Square, Zap, Volume2, AlertCircle } from 'lucide-react';
import { VoiceWaveform } from './VoiceWaveform';
import { useVoiceAssistant } from '../../hooks/useVoiceAssistant';

export const VoiceControls: React.FC = () => {
  const {
    voiceState,
    statusMessage,
    audioLevel,
    lastMetrics,
    errorMessage,
    isVoiceModeActive,
    isVoiceMuted,
    setVoiceModeActive,
    toggleMute,
    emergencyStop,
  } = useVoiceAssistant();

  const getStateBadge = () => {
    switch (voiceState) {
      case 'WAKE_LISTENING':
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-cyan-950/40 px-2.5 py-0.5 text-xs font-medium text-cyan-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400" />
            Listening for "Hey Jarvis"
          </span>
        );
      case 'WAKE_DETECTED':
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-950/50 px-2.5 py-0.5 text-xs font-semibold text-amber-300 animate-pulse">
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            Wake Word Detected!
          </span>
        );
      case 'RECORDING':
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-950/50 px-2.5 py-0.5 text-xs font-medium text-sky-300">
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-sky-400" />
            Listening to speech...
          </span>
        );
      case 'TRANSCRIBING':
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-purple-500/30 bg-purple-950/40 px-2.5 py-0.5 text-xs font-medium text-purple-300">
            <span className="h-1.5 w-1.5 animate-spin rounded-full border-t border-purple-400" />
            Transcribing...
          </span>
        );
      case 'PROCESSING':
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-purple-500/30 bg-purple-950/40 px-2.5 py-0.5 text-xs font-medium text-purple-300">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-purple-400" />
            Jarvis processing...
          </span>
        );
      case 'SPEAKING':
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-950/50 px-2.5 py-0.5 text-xs font-medium text-sky-200">
            <Volume2 className="h-3 w-3 animate-pulse text-sky-400" />
            Speaking...
          </span>
        );
      case 'MUTED':
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-950/40 px-2.5 py-0.5 text-xs font-medium text-red-300">
            <MicOff className="h-3 w-3 text-red-400" />
            Muted
          </span>
        );
      case 'ERROR':
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-950/50 px-2.5 py-0.5 text-xs font-medium text-red-300">
            <AlertCircle className="h-3 w-3 text-red-400" />
            Voice Error
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex items-center gap-2">
      {/* Voice Mode Toggle Button */}
      <button
        type="button"
        onClick={() => setVoiceModeActive(!isVoiceModeActive)}
        title={isVoiceModeActive ? 'Disable hands-free voice mode' : 'Enable hands-free voice mode ("Hey Jarvis")'}
        className={`relative flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all duration-200 ${
          isVoiceModeActive
            ? 'border border-cyan-500/40 bg-cyan-950/40 text-cyan-300 shadow-[0_0_12px_rgba(6,182,212,0.25)]'
            : 'border border-slate-700 bg-slate-800/80 text-slate-400 hover:border-slate-600 hover:text-slate-200'
        }`}
      >
        <Mic className={`h-3.5 w-3.5 ${isVoiceModeActive ? 'text-cyan-400 animate-pulse' : ''}`} />
        <span>Voice Mode</span>
        {isVoiceModeActive && (
          <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shadow-[0_0_6px_rgb(6,182,212)]" />
        )}
      </button>

      {/* Active Voice Controls HUD */}
      {isVoiceModeActive && (
        <div
          title={statusMessage}
          className="flex items-center gap-2 rounded-lg border border-cyan-500/20 bg-slate-900/90 px-2 py-1 shadow-inner backdrop-blur-md"
        >
          {/* Animated Waveform */}
          <VoiceWaveform state={voiceState} audioLevel={audioLevel} />

          {/* Current State Badge */}
          {getStateBadge()}

          {/* Mute / Unmute Button */}
          <button
            type="button"
            onClick={toggleMute}
            title={isVoiceMuted ? 'Unmute microphone' : 'Mute microphone'}
            className={`rounded p-1 text-xs transition-colors ${
              isVoiceMuted
                ? 'bg-red-900/40 text-red-300 hover:bg-red-800/50'
                : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
            }`}
          >
            {isVoiceMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          </button>

          {/* Emergency Stop Button (active during processing/speaking) */}
          {(voiceState === 'RECORDING' ||
            voiceState === 'PROCESSING' ||
            voiceState === 'SPEAKING' ||
            voiceState === 'TRANSCRIBING') && (
            <button
              type="button"
              onClick={emergencyStop}
              title="Emergency Stop: Abort voice command / stop speaking"
              className="flex items-center gap-1 rounded bg-red-950/80 border border-red-500/40 px-1.5 py-0.5 text-[10px] font-semibold text-red-300 hover:bg-red-900/80 transition-colors"
            >
              <Square className="h-2.5 w-2.5 fill-current" />
              Stop
            </button>
          )}

          {/* Latency Telemetry Pill */}
          {lastMetrics && (lastMetrics.stt_latency_ms || lastMetrics.llm_latency_ms) && (
            <span
              title={`Speech Recognition: ${lastMetrics.stt_latency_ms?.toFixed(0)}ms | Inference: ${lastMetrics.llm_latency_ms?.toFixed(0)}ms`}
              className="hidden lg:flex items-center gap-1 text-[10px] text-slate-400 font-mono bg-slate-950/60 px-1.5 py-0.5 rounded border border-slate-800"
            >
              <Zap className="h-2.5 w-2.5 text-amber-400" />
              <span>STT: {lastMetrics.stt_latency_ms?.toFixed(0)}ms</span>
              <span className="text-slate-600">|</span>
              <span>LLM: {lastMetrics.llm_latency_ms?.toFixed(0)}ms</span>
            </span>
          )}
        </div>
      )}

      {/* Error message tooltip/indicator */}
      {errorMessage && (
        <span className="text-xs text-red-400 font-mono bg-red-950/60 border border-red-800/60 px-2 py-0.5 rounded">
          {errorMessage}
        </span>
      )}
    </div>
  );
};

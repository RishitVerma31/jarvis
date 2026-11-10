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
    isFollowUp,
    unlockAudio,
    testSpeech,
    setVoiceModeActive,
    toggleMute,
    emergencyStop,
  } = useVoiceAssistant();

  const handleToggleVoice = () => {
    // Prime audio engine inside user touch/click gesture for iOS Safari compatibility
    unlockAudio();
    setVoiceModeActive(!isVoiceModeActive);
  };

  const getStateBadge = () => {
    switch (voiceState) {
      case 'WAKE_LISTENING':
        if (isFollowUp) {
          return (
            <span className="flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-950/40 px-2 sm:px-2.5 py-0.5 text-xs font-medium text-emerald-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 shrink-0" />
              <span className="hidden sm:inline">Follow-up active (5s)</span>
              <span className="sm:hidden">Follow-up</span>
            </span>
          );
        }
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-cyan-500/30 bg-cyan-950/40 px-2 sm:px-2.5 py-0.5 text-xs font-medium text-cyan-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-400 shrink-0" />
            <span className="hidden sm:inline">Listening for "Hey Jarvis"</span>
            <span className="sm:hidden">Listening</span>
          </span>
        );
      case 'WAKE_DETECTED':
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-950/50 px-2 sm:px-2.5 py-0.5 text-xs font-semibold text-amber-300 animate-pulse">
            <span className="h-2 w-2 rounded-full bg-amber-400 shrink-0" />
            <span className="hidden sm:inline">Wake Word Detected!</span>
            <span className="sm:hidden">Awake!</span>
          </span>
        );
      case 'RECORDING':
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-950/50 px-2 sm:px-2.5 py-0.5 text-xs font-medium text-sky-300">
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-sky-400 shrink-0" />
            <span className="hidden sm:inline">Listening to speech...</span>
            <span className="sm:hidden">Recording</span>
          </span>
        );
      case 'TRANSCRIBING':
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-purple-500/30 bg-purple-950/40 px-2 sm:px-2.5 py-0.5 text-xs font-medium text-purple-300">
            <span className="h-1.5 w-1.5 animate-spin rounded-full border-t border-purple-400 shrink-0" />
            <span className="hidden sm:inline">Transcribing...</span>
            <span className="sm:hidden">STT...</span>
          </span>
        );
      case 'PROCESSING':
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-purple-500/30 bg-purple-950/40 px-2 sm:px-2.5 py-0.5 text-xs font-medium text-purple-300">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-purple-400 shrink-0" />
            <span className="hidden sm:inline">Jarvis processing...</span>
            <span className="sm:hidden">Thinking...</span>
          </span>
        );
      case 'SPEAKING':
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-950/50 px-2 sm:px-2.5 py-0.5 text-xs font-medium text-sky-200">
            <Volume2 className="h-3 w-3 animate-pulse text-sky-400 shrink-0" />
            <span className="hidden sm:inline">Speaking...</span>
            <span className="sm:hidden">Speaking</span>
          </span>
        );
      case 'MUTED':
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-950/40 px-2 sm:px-2.5 py-0.5 text-xs font-medium text-red-300">
            <MicOff className="h-3 w-3 text-red-400 shrink-0" />
            Muted
          </span>
        );
      case 'ERROR':
        return (
          <span className="flex items-center gap-1.5 rounded-full border border-red-500/40 bg-red-950/50 px-2 sm:px-2.5 py-0.5 text-xs font-medium text-red-300">
            <AlertCircle className="h-3 w-3 text-red-400 shrink-0" />
            Error
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      {/* Voice Mode Toggle Button (Touch friendly with 44px minimum height) */}
      <button
        type="button"
        onClick={handleToggleVoice}
        title={isVoiceModeActive ? 'Disable hands-free voice mode' : 'Enable hands-free voice mode ("Hey Jarvis")'}
        className={`relative flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 min-h-[44px] min-w-[44px] text-xs font-medium transition-all duration-200 cursor-pointer ${
          isVoiceModeActive
            ? 'border border-cyan-500/40 bg-cyan-950/40 text-cyan-300 shadow-[0_0_12px_rgba(6,182,212,0.25)]'
            : 'border border-slate-700 bg-slate-800/80 text-slate-400 hover:border-slate-600 hover:text-slate-200'
        }`}
      >
        <Mic className={`h-4 w-4 shrink-0 ${isVoiceModeActive ? 'text-cyan-400 animate-pulse' : ''}`} />
        <span className="hidden sm:inline">Voice Mode</span>
        <span className="sm:hidden font-mono text-[11px]">Voice</span>
        {isVoiceModeActive && (
          <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shadow-[0_0_6px_rgb(6,182,212)] shrink-0" />
        )}
      </button>

      {/* Active Voice Controls HUD */}
      {isVoiceModeActive && (
        <div
          title={statusMessage}
          className="flex items-center gap-1.5 sm:gap-2 rounded-lg border border-cyan-500/20 bg-slate-900/90 px-1.5 sm:px-2 py-1 shadow-inner backdrop-blur-md"
        >
          {/* Animated Waveform */}
          <VoiceWaveform state={voiceState} audioLevel={audioLevel} />

          {/* Current State Badge */}
          {getStateBadge()}

          {/* Live Status Message (prominently visible in header on md+ screens) */}
          <span className="hidden md:inline-block text-xs font-mono text-cyan-200/90 max-w-[200px] lg:max-w-[300px] truncate pl-1 border-l border-cyan-500/20">
            {statusMessage}
          </span>

          {/* Voice Speaker Test Button (Touch-friendly voice test on iOS Safari) */}
          <button
            type="button"
            onClick={() => testSpeech()}
            title="Test J.A.R.V.I.S. speech audio output"
            aria-label="Test Jarvis voice output"
            className="flex items-center justify-center min-w-[36px] min-h-[36px] sm:min-w-[32px] sm:min-h-[32px] rounded p-1 text-slate-400 hover:text-cyan-300 hover:bg-cyan-950/40 transition-colors cursor-pointer"
          >
            <Volume2 className="h-3.5 w-3.5 text-cyan-400" />
          </button>

          {/* Mute / Unmute Button */}
          <button
            type="button"
            onClick={toggleMute}
            title={isVoiceMuted ? 'Unmute microphone' : 'Mute microphone'}
            className={`flex items-center justify-center min-w-[36px] min-h-[36px] sm:min-w-[32px] sm:min-h-[32px] rounded p-1 text-xs transition-colors cursor-pointer ${
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
              className="flex items-center gap-1 rounded bg-red-950/80 border border-red-500/40 px-2 py-1 min-h-[32px] text-[10px] font-semibold text-red-300 hover:bg-red-900/80 transition-colors cursor-pointer"
            >
              <Square className="h-2.5 w-2.5 fill-current" />
              <span>Stop</span>
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

      {/* Error message indicator */}
      {errorMessage && (
        <span className="hidden sm:inline-block text-xs text-red-400 font-mono bg-red-950/60 border border-red-800/60 px-2 py-0.5 rounded max-w-[200px] truncate">
          {errorMessage}
        </span>
      )}
    </div>
  );
};

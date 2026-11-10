/**
 * Jarvis Live Voice Pipeline Activity HUD Card.
 * Renders real-time feedback for wake-word detection, speech recording,
 * STT transcription, LLM processing, and TTS vocalization.
 */

import React from 'react';
import {
  Mic,
  Volume2,
  Cpu,
  Radio,
  Square,
  Zap,
  Sparkles,
  AlertCircle,
  Loader2,
  MicOff,
} from 'lucide-react';
import { useUIStore } from '../../stores/useUIStore';
import { VoiceWaveform } from './VoiceWaveform';

export const VoiceActivityHUD: React.FC = () => {
  const {
    isVoiceModeActive,
    voiceState,
    voiceStatusMessage,
    voiceTranscript,
    voiceAudioLevel,
    voiceLastMetrics,
    voiceIsFollowUp,
    triggerEmergencyStop,
  } = useUIStore();

  // Only display when Voice Mode is active AND there is ongoing voice activity
  const isActivelyEngaged =
    isVoiceModeActive &&
    voiceState !== 'STANDBY' &&
    !(voiceState === 'WAKE_LISTENING' && !voiceIsFollowUp);

  if (!isActivelyEngaged) {
    return null;
  }

  // Visual theming based on current voice pipeline phase
  const getPhaseTheme = () => {
    switch (voiceState) {
      case 'WAKE_DETECTED':
        return {
          title: 'WAKE WORD DETECTED',
          subtitle: 'Acoustic matrix engaged • Initializing command receiver',
          borderColor: 'border-amber-500/50',
          bgGradient: 'from-amber-950/70 via-slate-900/90 to-slate-950/90',
          badgeBg: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
          glowShadow: 'shadow-[0_0_30px_rgba(245,158,11,0.25)]',
          icon: <Sparkles className="w-4 h-4 text-amber-400 animate-pulse" />,
        };
      case 'RECORDING':
        return {
          title: 'LISTENING FOR COMMAND',
          subtitle: 'Streaming microphone audio • Speak directive clearly',
          borderColor: 'border-sky-500/50',
          bgGradient: 'from-sky-950/70 via-slate-900/90 to-slate-950/90',
          badgeBg: 'bg-sky-500/20 text-sky-300 border-sky-500/40',
          glowShadow: 'shadow-[0_0_30px_rgba(14,165,233,0.25)]',
          icon: <Mic className="w-4 h-4 text-sky-400 animate-bounce" />,
        };
      case 'TRANSCRIBING':
        return {
          title: 'TRANSCRIBING SPEECH',
          subtitle: 'Whisper neural STT • Converting speech audio to tokens',
          borderColor: 'border-purple-500/50',
          bgGradient: 'from-purple-950/70 via-slate-900/90 to-slate-950/90',
          badgeBg: 'bg-purple-500/20 text-purple-300 border-purple-500/40',
          glowShadow: 'shadow-[0_0_30px_rgba(168,85,247,0.25)]',
          icon: <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />,
        };
      case 'PROCESSING':
        return {
          title: 'JARVIS PROCESSING DIRECTIVE',
          subtitle: 'Ollama neural matrix • Formulating computational response',
          borderColor: 'border-purple-500/60',
          bgGradient: 'from-purple-950/80 via-slate-900/90 to-slate-950/90',
          badgeBg: 'bg-purple-500/25 text-purple-200 border-purple-500/50',
          glowShadow: 'shadow-[0_0_35px_rgba(168,85,247,0.35)]',
          icon: <Cpu className="w-4 h-4 text-purple-300 animate-pulse" />,
        };
      case 'SPEAKING':
        return {
          title: 'VOCALIZING RESPONSE',
          subtitle: 'Kokoro neural audio synthesis • Microphone muted',
          borderColor: 'border-cyan-500/50',
          bgGradient: 'from-cyan-950/70 via-slate-900/90 to-slate-950/90',
          badgeBg: 'bg-cyan-500/20 text-cyan-200 border-cyan-500/40',
          glowShadow: 'shadow-[0_0_30px_rgba(6,182,212,0.25)]',
          icon: <Volume2 className="w-4 h-4 text-cyan-400 animate-pulse" />,
        };
      case 'WAKE_LISTENING':
        return {
          title: 'FOLLOW-UP WINDOW ACTIVE',
          subtitle: '5-second open dialogue window • Say your next query directly',
          borderColor: 'border-emerald-500/50',
          bgGradient: 'from-emerald-950/60 via-slate-900/90 to-slate-950/90',
          badgeBg: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
          glowShadow: 'shadow-[0_0_30px_rgba(16,185,129,0.25)]',
          icon: <Radio className="w-4 h-4 text-emerald-400 animate-ping" />,
        };
      case 'MUTED':
        return {
          title: 'MICROPHONE MUTED',
          subtitle: 'Input stream paused • Tap unmute to restore listening',
          borderColor: 'border-red-500/40',
          bgGradient: 'from-red-950/60 via-slate-900/90 to-slate-950/90',
          badgeBg: 'bg-red-500/20 text-red-300 border-red-500/40',
          glowShadow: 'shadow-[0_0_20px_rgba(239,68,68,0.2)]',
          icon: <MicOff className="w-4 h-4 text-red-400" />,
        };
      case 'ERROR':
        return {
          title: 'VOICE PIPELINE ALERT',
          subtitle: 'An unexpected processing event occurred',
          borderColor: 'border-rose-500/50',
          bgGradient: 'from-rose-950/70 via-slate-900/90 to-slate-950/90',
          badgeBg: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
          glowShadow: 'shadow-[0_0_25px_rgba(244,63,94,0.3)]',
          icon: <AlertCircle className="w-4 h-4 text-rose-400" />,
        };
      default:
        return {
          title: 'VOICE PIPELINE ACTIVE',
          subtitle: 'Synchronizing voice telemetry',
          borderColor: 'border-cyan-500/30',
          bgGradient: 'from-slate-900 to-slate-950',
          badgeBg: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30',
          glowShadow: '',
          icon: <Radio className="w-4 h-4 text-cyan-400" />,
        };
    }
  };

  const theme = getPhaseTheme();
  const canAbort =
    voiceState === 'RECORDING' ||
    voiceState === 'TRANSCRIBING' ||
    voiceState === 'PROCESSING' ||
    voiceState === 'SPEAKING';

  return (
    <div
      className={`w-full max-w-2xl mx-auto my-3 rounded-2xl border ${theme.borderColor} bg-gradient-to-b ${theme.bgGradient} ${theme.glowShadow} backdrop-blur-xl p-3 sm:p-4 transition-all duration-300 animate-in fade-in slide-in-from-top-2 select-none`}
    >
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        {/* Left Phase Badge & Description */}
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative shrink-0">
            <VoiceWaveform state={voiceState} audioLevel={voiceAudioLevel} />
          </div>

          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-[11px] font-mono tracking-wider font-semibold uppercase ${theme.badgeBg}`}
              >
                {theme.icon}
                <span>{theme.title}</span>
              </span>

              {/* Follow-up indicator chip */}
              {voiceIsFollowUp && voiceState === 'WAKE_LISTENING' && (
                <span className="text-[10px] font-mono text-emerald-300 bg-emerald-950/80 border border-emerald-500/30 px-2 py-0.5 rounded-full animate-pulse">
                  5s Active
                </span>
              )}
            </div>

            <p className="text-xs text-slate-300 font-sans truncate">
              {voiceStatusMessage || theme.subtitle}
            </p>
          </div>
        </div>

        {/* Right Action Controls & Telemetry */}
        <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
          {/* Latency telemetry chip */}
          {voiceLastMetrics && (voiceLastMetrics.stt_latency_ms || voiceLastMetrics.llm_latency_ms) && (
            <div className="hidden md:flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-950/70 border border-slate-800 text-[10px] font-mono text-slate-400">
              <Zap className="w-3 h-3 text-amber-400" />
              <span>STT: {voiceLastMetrics.stt_latency_ms?.toFixed(0)}ms</span>
              <span className="text-slate-600">|</span>
              <span>LLM: {voiceLastMetrics.llm_latency_ms?.toFixed(0)}ms</span>
            </div>
          )}

          {/* Quick Emergency Abort Button */}
          {canAbort && (
            <button
              type="button"
              onClick={triggerEmergencyStop}
              title="Abort voice command immediately"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-950/80 hover:bg-red-900 border border-red-500/40 text-red-200 text-xs font-semibold shadow-sm transition-all cursor-pointer min-h-[36px]"
            >
              <Square className="w-3 h-3 fill-current" />
              <span>Abort</span>
            </button>
          )}
        </div>
      </div>

      {/* Real-time Recognized Speech Transcript Preview */}
      {voiceTranscript && (
        <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-start gap-2">
          <span className="text-[11px] font-mono uppercase tracking-wider text-cyan-400 font-semibold shrink-0 pt-0.5">
            Heard:
          </span>
          <p className="text-xs font-mono text-cyan-100 bg-slate-950/60 border border-cyan-500/20 px-2.5 py-1 rounded-lg flex-1 break-words">
            "{voiceTranscript}"
          </p>
        </div>
      )}
    </div>
  );
};


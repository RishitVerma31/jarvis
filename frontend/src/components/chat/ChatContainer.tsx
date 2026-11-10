import React, { useEffect, useRef } from 'react';
import { Shield, Cpu, Activity, Database } from 'lucide-react';
import type { ChatMessage } from '../../hooks/useChat';
import { MessageBubble } from './MessageBubble';
import { useHealth } from '../../hooks/useHealth';
import { VoiceActivityHUD } from '../voice/VoiceActivityHUD';

interface ChatContainerProps {
  messages: ChatMessage[];
  onSuggestionClick?: (prompt: string) => void;
}

export const ChatContainer: React.FC<ChatContainerProps> = ({
  messages,
  onSuggestionClick,
}) => {
  const bottomRef = useRef<HTMLDivElement>(null);
  const { data: health, isLoading, isError } = useHealth();

  // Auto-scroll to bottom whenever messages update
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  let telemetryText = 'Synchronizing telemetry...';
  let telemetryColor = 'text-cyan-400';
  let dotColor = 'bg-cyan-400';

  if (isLoading) {
    telemetryText = 'Synchronizing telemetry...';
    telemetryColor = 'text-cyan-400';
    dotColor = 'bg-cyan-400 animate-pulse';
  } else if (isError || !health) {
    telemetryText = 'Host Link Lost • Cannot connect to Windows backend server';
    telemetryColor = 'text-rose-400';
    dotColor = 'bg-rose-400';
  } else if (
    health.status === 'healthy' &&
    health.backend === 'healthy' &&
    health.database === 'connected' &&
    health.ollama?.status === 'connected'
  ) {
    telemetryText = `J.A.R.V.I.S. Systems Online • All Protocols Nominal • Model: ${health.ollama.target_model}`;
    telemetryColor = 'text-emerald-400';
    dotColor = 'bg-emerald-400 shadow-[0_0_8px_#34d399]';
  } else if (health.backend === 'healthy') {
    telemetryText = `System Degraded • ${health.ollama?.detail || 'Inference engine disconnected'}`;
    telemetryColor = 'text-amber-400';
    dotColor = 'bg-amber-400 shadow-[0_0_8px_#fbbf24]';
  } else {
    telemetryText = 'System Error • Backend diagnostics failed';
    telemetryColor = 'text-rose-400';
    dotColor = 'bg-rose-400';
  }

  // If no messages yet, display the Stark Industries Arc Reactor Welcome Screen
  if (messages.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6 flex flex-col items-center justify-center relative select-none">
        {/* Subtle Background Radial Energy Field */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(6,182,212,0.08)_0%,transparent_70%)] pointer-events-none" />

        <div className="w-full max-w-2xl px-2 z-20">
          <VoiceActivityHUD />
        </div>

        <div className="max-w-2xl w-full text-center space-y-5 sm:space-y-7 relative z-10 py-4">
          {/* Holographic Arc Reactor Core with Multi-Ring Rotation */}
          <div className="relative inline-flex items-center justify-center py-1 sm:py-2">
            {/* Outer dashed spinning ring */}
            <div className="absolute w-24 h-24 sm:w-32 sm:h-32 rounded-full border border-dashed border-cyan-400/30 animate-arc-spin pointer-events-none" />

            {/* Middle counter-spinning ring with tick marks */}
            <div className="absolute w-20 h-20 sm:w-28 sm:h-28 rounded-full border border-dotted border-cyan-300/40 animate-arc-spin-reverse pointer-events-none" />

            {/* Inner glowing pulse ring */}
            <div className="w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-cyan-950/60 border-2 border-cyan-400/80 flex items-center justify-center shadow-[0_0_35px_rgba(6,182,212,0.6)] animate-pulse-glow relative">
              {/* Center reactor core */}
              <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-full bg-gradient-to-tr from-cyan-400 to-sky-200 shadow-[0_0_20px_#22d3ee] flex items-center justify-center">
                <div className="w-3.5 h-3.5 sm:w-4 sm:h-4 rounded-full bg-slate-950/80 border border-cyan-200" />
              </div>

              {/* Crosshair accents */}
              <div className="absolute w-full h-[1px] bg-cyan-400/30" />
              <div className="absolute h-full w-[1px] bg-cyan-400/30" />
            </div>

            {/* Ambient cyan bloom */}
            <div className="absolute -inset-4 rounded-full bg-cyan-500/15 blur-2xl -z-10" />
          </div>

          {/* Stark Industries Salutation */}
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-cyan-500/30 bg-cyan-950/40 text-[10px] sm:text-[11px] font-mono tracking-widest text-cyan-300 uppercase shadow-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
              <span>STARK INDUSTRIES • J.A.R.V.I.S. ONLINE</span>
            </div>

            <h1 className="text-xl sm:text-2xl md:text-3xl font-bold tracking-tight text-slate-100 font-sans px-2">
              Good day, Sir. All systems operating at peak efficiency.
            </h1>
            <p className="text-xs sm:text-sm text-cyan-100/70 max-w-lg mx-auto font-sans leading-relaxed px-2">
              Just A Rather Very Intelligent System. Ready to run computational directives, synthesize intelligence, or execute complex workflows.
            </p>
          </div>

          {/* High-Tech Tactical Hologram Suggestion Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3 text-left pt-1">
            <button
              type="button"
              onClick={() => onSuggestionClick?.('J.A.R.V.I.S., give me a full tactical status report on system capabilities.')}
              className="p-3.5 sm:p-4 rounded-xl sm:rounded-2xl border border-cyan-900/40 bg-slate-900/40 hover:border-cyan-400/60 hover:shadow-[0_0_20px_rgba(6,182,212,0.25)] transition-all duration-300 group text-left cursor-pointer min-h-[48px]"
            >
              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center mb-2.5 sm:mb-3 group-hover:scale-110 group-hover:text-cyan-300 transition-all">
                <Cpu className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              </div>
              <div className="text-[10px] font-mono tracking-wider text-cyan-400 uppercase font-semibold">
                TACTICAL REPORT
              </div>
              <h2 className="text-xs font-semibold text-slate-100 mt-0.5">System Status</h2>
              <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                Run diagnostics on your autonomous neural matrix and capabilities.
              </p>
            </button>

            <button
              type="button"
              onClick={() => onSuggestionClick?.("Explain the physics of Tony Stark's arc reactor and clean energy generation.")}
              className="p-3.5 sm:p-4 rounded-xl sm:rounded-2xl border border-cyan-900/40 bg-slate-900/40 hover:border-cyan-400/60 hover:shadow-[0_0_20px_rgba(6,182,212,0.25)] transition-all duration-300 group text-left cursor-pointer min-h-[48px]"
            >
              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center mb-2.5 sm:mb-3 group-hover:scale-110 group-hover:text-cyan-300 transition-all">
                <Shield className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              </div>
              <div className="text-[10px] font-mono tracking-wider text-cyan-400 uppercase font-semibold">
                STARK RESEARCH
              </div>
              <h2 className="text-xs font-semibold text-slate-100 mt-0.5">Arc Reactor Physics</h2>
              <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                Analyze palladium core ionization and magnetic confinement principles.
              </p>
            </button>

            <button
              type="button"
              onClick={() => onSuggestionClick?.('Write a high-performance Python algorithm using asyncio for concurrent telemetry processing.')}
              className="p-3.5 sm:p-4 rounded-xl sm:rounded-2xl border border-cyan-900/40 bg-slate-900/40 hover:border-cyan-400/60 hover:shadow-[0_0_20px_rgba(6,182,212,0.25)] transition-all duration-300 group text-left cursor-pointer min-h-[48px]"
            >
              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center justify-center mb-2.5 sm:mb-3 group-hover:scale-110 group-hover:text-cyan-300 transition-all">
                <Database className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              </div>
              <div className="text-[10px] font-mono tracking-wider text-cyan-400 uppercase font-semibold">
                CODE SYNTHESIS
              </div>
              <h2 className="text-xs font-semibold text-slate-100 mt-0.5">Async Telemetry</h2>
              <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                Generate optimized async Python algorithms for concurrent operations.
              </p>
            </button>
          </div>

          {/* System HUD Live Status Pulse */}
          <div className="inline-flex items-center gap-2 px-3 sm:px-4 py-1.5 sm:py-2 rounded-xl border border-cyan-900/50 bg-slate-950/70 text-[11px] sm:text-xs font-mono shadow-md max-w-full truncate">
            <Activity className={`w-3.5 h-3.5 ${telemetryColor} animate-pulse shrink-0`} />
            <span className={`w-2 h-2 rounded-full ${dotColor} shrink-0`} />
            <span className={`${telemetryColor} truncate`}>{telemetryText}</span>
          </div>
        </div>
      </div>
    );
  }

  // Active Chat Message Feed
  return (
    <div className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-6 space-y-4 sm:space-y-5">
      <div className="max-w-3xl mx-auto space-y-4 sm:space-y-5">
        <VoiceActivityHUD />
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        <div ref={bottomRef} className="h-4" />
      </div>
    </div>
  );
};

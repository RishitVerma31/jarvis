import React from 'react';
import { PanelLeftClose, PanelLeft, Bot, Cpu, RotateCw, Database, Server, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useUIStore } from '../../stores/useUIStore';
import { StatusBadge } from '../common/StatusBadge';
import { useHealth } from '../../hooks/useHealth';
import { VoiceControls } from '../voice/VoiceControls';

export const Header: React.FC = () => {
  const { isSidebarOpen, toggleSidebar, isAuthenticated, setAuthModalOpen } = useUIStore();
  const { data: health, isLoading, isError, refetch, isFetching } = useHealth();

  const activeModel = health?.ollama?.target_model || 'qwen2.5:3b';
  const isOllamaConnected = health?.ollama?.status === 'connected';
  const isDbConnected = health?.database === 'connected';
  const isBackendOnline = health?.backend === 'healthy';

  return (
    <header className="h-14 border-b border-cyan-900/30 bg-slate-950/80 backdrop-blur-xl px-4 flex items-center justify-between z-10 shrink-0 select-none">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggleSidebar}
          className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-cyan-950/40 hover:border-cyan-800/40 border border-transparent transition-all"
          title={isSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-label={isSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
        >
          {isSidebarOpen ? (
            <PanelLeftClose className="w-5 h-5" />
          ) : (
            <PanelLeft className="w-5 h-5" />
          )}
        </button>

        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-cyan-600/30 to-sky-400/20 border border-cyan-400/40 flex items-center justify-center text-cyan-300 shadow-[0_0_15px_rgba(6,182,212,0.3)]">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm tracking-wider text-slate-100 font-sans">
                J.A.R.V.I.S.
              </span>
              <span className="text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded bg-cyan-950/70 text-cyan-300 font-mono border border-cyan-700/40 shadow-sm">
                MK VII
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Voice Assistant HUD & Controls */}
      <div className="flex items-center justify-center">
        <VoiceControls />
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        {/* Real-time Telemetry: Backend & Database Indicators */}
        <div className="hidden lg:flex items-center gap-2 px-2.5 py-1 rounded-full border border-slate-800 bg-slate-900/40 text-[11px] font-mono text-slate-400">
          <span
            className="flex items-center gap-1"
            title={isBackendOnline ? 'Backend: Healthy' : 'Backend: Disconnected'}
          >
            <Server className="w-3 h-3 text-slate-400" />
            <span className={isBackendOnline ? 'text-emerald-400' : 'text-rose-400'}>
              API
            </span>
          </span>
          <span className="text-slate-600">•</span>
          <span
            className="flex items-center gap-1"
            title={isDbConnected ? 'SQLite: Connected' : 'SQLite: Disconnected'}
          >
            <Database className="w-3 h-3 text-slate-400" />
            <span className={isDbConnected ? 'text-emerald-400' : 'text-rose-400'}>
              DB
            </span>
          </span>
        </div>

        {/* Real-time Active Model Indicator */}
        <div className="hidden md:flex items-center gap-1.5 px-3 py-1 rounded-full border border-cyan-800/40 bg-slate-900/50 text-xs text-slate-300 shadow-sm">
          <Cpu className="w-3.5 h-3.5 text-cyan-400" />
          <span className="font-mono text-[11px] text-cyan-400">Model:</span>
          <span className="font-medium font-mono text-slate-200">
            {activeModel}
          </span>
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isOllamaConnected ? 'bg-emerald-400' : 'bg-amber-400'
            }`}
            title={isOllamaConnected ? 'Ollama Online' : 'Ollama Offline / Degraded'}
          />
        </div>

        {/* Security / Clearance Passkey Badge */}
        <button
          type="button"
          onClick={() => setAuthModalOpen(true)}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs font-mono transition-all cursor-pointer ${
            isAuthenticated
              ? 'border-emerald-800/40 bg-emerald-950/20 text-emerald-300 hover:bg-emerald-900/30'
              : 'border-amber-800/50 bg-amber-950/30 text-amber-300 hover:bg-amber-900/40 animate-pulse'
          }`}
          title={isAuthenticated ? 'Security: Clearance Verified (Click to manage)' : 'Security: Authorization Required (Click to enter passkey)'}
        >
          {isAuthenticated ? (
            <>
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span className="hidden sm:inline text-[11px] font-semibold">SECURE</span>
            </>
          ) : (
            <>
              <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
              <span className="hidden sm:inline text-[11px] font-semibold">LOCKED</span>
            </>
          )}
        </button>

        {/* Visual State: Green (Healthy) / Amber (Degraded) / Red (Unreachable) */}
        <StatusBadge
          health={health}
          isLoading={isLoading}
          isError={isError}
        />

        {/* Manual Refresh Button */}
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-cyan-950/40 disabled:opacity-50 transition-all border border-transparent hover:border-cyan-800/40"
          title="Refresh telemetry"
          aria-label="Refresh telemetry"
        >
          <RotateCw className={`w-4 h-4 ${isFetching ? 'animate-spin text-cyan-400' : ''}`} />
        </button>
      </div>
    </header>
  );
};

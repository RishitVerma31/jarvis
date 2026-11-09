import React from 'react';
import { Plus, MessageSquare, Database, Server, Cpu, ShieldCheck } from 'lucide-react';
import { useUIStore } from '../../stores/useUIStore';
import { useHealth } from '../../hooks/useHealth';
import { useSessions } from '../../hooks/useSessions';

interface SidebarProps {
  onNewConversation?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ onNewConversation }) => {
  const { isSidebarOpen, activeSessionId, setActiveSessionId } = useUIStore();
  const { data: health, isError: isHealthError } = useHealth();
  const { data: sessions, isLoading: isLoadingSessions } = useSessions();

  if (!isSidebarOpen) {
    return null;
  }

  // Derive dynamic service statuses with J.A.R.V.I.S. branding
  const backendStatusText = isHealthError
    ? 'Link Terminated'
    : health?.backend === 'healthy'
      ? 'J.A.R.V.I.S. Core Online'
      : 'Synchronizing...';

  const neuralCoreText = isHealthError
    ? 'Neural Matrix Offline'
    : health?.ollama?.status === 'connected'
      ? `Neural Matrix Active (${health.ollama.target_model})`
      : health?.ollama?.status === 'unavailable'
        ? 'Neural Engine Inactive'
        : 'Calibrating...';

  const vaultText = isHealthError
    ? 'Archives Standby'
    : health?.database === 'connected'
      ? 'Memory Vault Secured'
      : 'Accessing...';

  // Format date helper (e.g. "Nov 9, 18:47")
  const formatSessionDate = (isoStr: string) => {
    try {
      const date = new Date(isoStr);
      const isToday = new Date().toDateString() === date.toDateString();
      if (isToday) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  };

  return (
    <aside className="w-72 border-r border-cyan-900/30 bg-slate-950/90 flex flex-col shrink-0 h-full select-none transition-all duration-300 backdrop-blur-xl z-20">
      {/* Stark New Protocol Button */}
      <div className="p-3">
        <button
          type="button"
          onClick={onNewConversation}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-gradient-to-r from-cyan-600/20 via-sky-500/15 to-cyan-600/20 hover:from-cyan-600/30 hover:to-sky-500/30 text-cyan-300 border border-cyan-500/40 hover:border-cyan-400 text-xs font-semibold tracking-wide uppercase transition-all shadow-sm hover:shadow-[0_0_15px_rgba(6,182,212,0.25)] active:scale-[0.98] cursor-pointer"
        >
          <Plus className="w-4 h-4 text-cyan-400" />
          <span>Initialize Protocol</span>
        </button>
      </div>

      {/* Archives Header */}
      <div className="px-4 py-2 flex items-center justify-between text-[10px] font-mono font-semibold tracking-widest uppercase text-cyan-400/80">
        <span>ARCHIVES & DIRECTIVES</span>
        <span className="text-[10px] text-cyan-500/60 font-mono">
          {sessions ? `${sessions.length} SAVED` : 'ENCRYPTED'}
        </span>
      </div>

      {/* Dynamic Session List Feed */}
      <div className="flex-1 overflow-y-auto px-2 space-y-1">
        {isLoadingSessions ? (
          /* Loading Skeletons */
          <div className="p-3 space-y-2">
            <div className="h-10 rounded-xl bg-slate-900/50 border border-slate-800 animate-pulse" />
            <div className="h-10 rounded-xl bg-slate-900/50 border border-slate-800 animate-pulse" />
            <div className="h-10 rounded-xl bg-slate-900/50 border border-slate-800 animate-pulse" />
          </div>
        ) : sessions && sessions.length > 0 ? (
          sessions.map((session) => {
            const isActive = activeSessionId === session.session_id;
            const dateStr = formatSessionDate(session.updated_at);
            const title = session.title || session.session_id;

            return (
              <button
                key={session.session_id}
                type="button"
                onClick={() => setActiveSessionId(session.session_id)}
                className={`w-full text-left p-2.5 rounded-xl border transition-all duration-200 cursor-pointer group flex flex-col gap-1 ${
                  isActive
                    ? 'border-cyan-400/60 bg-cyan-950/40 text-slate-100 shadow-[0_0_15px_rgba(6,182,212,0.2)]'
                    : 'border-slate-800/80 bg-slate-900/30 hover:border-cyan-900/60 hover:bg-slate-900/60 text-slate-300'
                }`}
                title={title}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 truncate">
                    <MessageSquare
                      className={`w-3.5 h-3.5 shrink-0 ${
                        isActive ? 'text-cyan-400' : 'text-slate-500 group-hover:text-cyan-400'
                      }`}
                    />
                    <span className="truncate text-xs font-medium">
                      {title}
                    </span>
                  </div>

                  <span
                    className={`text-[9px] font-mono px-1.5 py-0.5 rounded-full shrink-0 border ${
                      isActive
                        ? 'bg-cyan-900/50 text-cyan-300 border-cyan-500/40'
                        : 'bg-slate-800/60 text-slate-400 border-slate-700/50'
                    }`}
                  >
                    {session.message_count}
                  </span>
                </div>

                <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono pl-5 pr-1">
                  <span className="truncate max-w-[130px]">
                    {session.last_message || 'Empty directive'}
                  </span>
                  <span>{dateStr}</span>
                </div>
              </button>
            );
          })
        ) : (
          /* Empty Session Vault */
          <div className="p-4 text-center rounded-xl border border-dashed border-cyan-900/40 bg-slate-900/20 text-slate-400 text-xs my-2">
            <p className="font-medium text-slate-300 text-[11px] font-mono uppercase tracking-wider">
              No Prior Directives
            </p>
            <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
              New conversations will automatically be archived in SQLite.
            </p>
          </div>
        )}
      </div>

      {/* High-Tech Telemetry Footer */}
      <div className="p-3.5 border-t border-cyan-900/30 bg-slate-900/30 space-y-2 text-[11px] font-mono">
        <div className="flex items-center gap-2 text-slate-300">
          <Server className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span className="truncate">{backendStatusText}</span>
        </div>
        <div className="flex items-center gap-2 text-slate-300">
          <Cpu className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span className="truncate">{neuralCoreText}</span>
        </div>
        <div className="flex items-center gap-2 text-slate-300">
          <Database className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span className="truncate">{vaultText}</span>
        </div>
        <div className="pt-1 flex items-center gap-1.5 text-[10px] text-cyan-500/70 border-t border-cyan-900/30">
          <ShieldCheck className="w-3 h-3 text-cyan-400" />
          <span>STARK PROTOCOL VERIFIED</span>
        </div>
      </div>
    </aside>
  );
};

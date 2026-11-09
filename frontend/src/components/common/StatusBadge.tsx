import React from 'react';
import type { HealthResponse } from '../../types/api';

interface StatusBadgeProps {
  health?: HealthResponse | null;
  isLoading?: boolean;
  isError?: boolean;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  health,
  isLoading = false,
  isError = false,
}) => {
  // Determine overall status category and telemetry details
  let status: 'loading' | 'healthy' | 'degraded' | 'offline' = 'loading';
  let label = 'Connecting...';
  let detail = 'Connecting to Jarvis backend...';

  if (isLoading) {
    status = 'loading';
    label = 'Connecting...';
    detail = 'Querying backend /health telemetry...';
  } else if (isError || !health) {
    status = 'offline';
    label = 'Backend Unreachable';
    detail = 'Cannot connect to FastAPI backend server. Verify Windows host is running at http://192.168.1.8:8000';
  } else if (
    health.status === 'healthy' &&
    health.backend === 'healthy' &&
    health.database === 'connected' &&
    health.ollama?.status === 'connected'
  ) {
    status = 'healthy';
    label = 'All Systems Healthy';
    detail = `Backend: Healthy • DB: Connected • Ollama: Connected (${health.ollama.target_model})`;
  } else if (health.backend === 'healthy') {
    status = 'degraded';
    if (health.ollama?.status !== 'connected') {
      label = 'Ollama Unavailable';
      detail = health.ollama?.detail || 'Ollama is offline or unreachable on Windows host';
    } else if (health.database !== 'connected') {
      label = 'Database Error';
      detail = 'SQLite database connectivity failure';
    } else {
      label = 'System Degraded';
      detail = health.ollama?.detail || 'One or more dependencies are degraded';
    }
  } else {
    status = 'offline';
    label = 'Backend Unhealthy';
    detail = 'FastAPI reported unhealthy system state';
  }

  const getStyles = () => {
    switch (status) {
      case 'healthy':
        return {
          dot: 'bg-emerald-400 shadow-[0_0_8px_#34d399]',
          text: 'text-emerald-300',
          bg: 'bg-emerald-950/40 border-emerald-700/50 shadow-[0_0_12px_rgba(16,185,129,0.2)]',
        };
      case 'degraded':
        return {
          dot: 'bg-amber-400 shadow-[0_0_8px_#fbbf24]',
          text: 'text-amber-300',
          bg: 'bg-amber-950/40 border-amber-700/50 shadow-[0_0_12px_rgba(245,158,11,0.2)]',
        };
      case 'offline':
        return {
          dot: 'bg-rose-400 shadow-[0_0_8px_#fb7185]',
          text: 'text-rose-300',
          bg: 'bg-rose-950/40 border-rose-700/50 shadow-[0_0_12px_rgba(244,63,94,0.2)]',
        };
      case 'loading':
      default:
        return {
          dot: 'bg-sky-400 shadow-[0_0_8px_#38bdf8]',
          text: 'text-sky-300',
          bg: 'bg-sky-950/30 border-sky-800/40 shadow-sm',
        };
    }
  };

  const styles = getStyles();

  return (
    <div
      className={`inline-flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1 rounded-full border text-xs font-mono font-medium transition-all ${styles.bg}`}
      title={detail}
    >
      <span className={`w-2 h-2 rounded-full shadow-sm animate-pulse shrink-0 ${styles.dot}`} />
      <span className={`hidden sm:inline ${styles.text}`}>{label}</span>
      {detail && (
        <span className="hidden xl:inline-block text-slate-400 font-mono text-[10px] truncate max-w-[220px]">
          [{detail}]
        </span>
      )}
    </div>
  );
};

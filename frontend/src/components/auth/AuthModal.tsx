import React, { useState, useEffect } from 'react';
import { Shield, ShieldAlert, ShieldCheck, KeyRound, Eye, EyeOff, X, Lock, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { useUIStore } from '../../stores/useUIStore';
import { setAuthToken, clearAuthToken, isAuthenticated as checkIsAuth } from '../../services/auth';
import { apiClient } from '../../services/apiClient';
import { useQueryClient } from '@tanstack/react-query';

export const AuthModal: React.FC = () => {
  const queryClient = useQueryClient();
  const { isAuthModalOpen, setAuthModalOpen, isAuthenticated, setAuthenticated } = useUIStore();

  const [inputKey, setInputKey] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Sync stored passkey state on mount or modal open
  useEffect(() => {
    const hasToken = checkIsAuth();
    setAuthenticated(hasToken);
  }, [setAuthenticated]);

  // Reset form when modal opens
  useEffect(() => {
    if (isAuthModalOpen) {
      setInputKey('');
      setErrorMessage(null);
      setSuccessMessage(null);
    }
  }, [isAuthModalOpen]);

  if (!isAuthModalOpen) {
    return null;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanKey = inputKey.trim();

    if (!cleanKey) {
      setErrorMessage('Please enter an authorization passkey.');
      return;
    }

    setIsValidating(true);
    setErrorMessage(null);
    setSuccessMessage(null);

    try {
      // Validate the passkey against the protected health endpoint
      await apiClient.getHealth(cleanKey);

      // Validation succeeded: save passkey
      setAuthToken(cleanKey);
      setAuthenticated(true);
      setSuccessMessage('Access granted. Security clearance verified.');

      // Refresh data
      queryClient.invalidateQueries({ queryKey: ['health'] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });

      setTimeout(() => {
        setAuthModalOpen(false);
        setSuccessMessage(null);
      }, 700);
    } catch (err: unknown) {
      console.warn('[AuthModal] Verification failed:', err);
      setErrorMessage('ACCESS DENIED: Invalid authorization passkey.');
    } finally {
      setIsValidating(false);
    }
  };

  const handleClearAuth = () => {
    clearAuthToken();
    setAuthenticated(false);
    setInputKey('');
    setErrorMessage(null);
    setSuccessMessage('Passkey cleared. System locked.');
    queryClient.clear();
  };

  const handleClose = () => {
    // Only allow manual dismissal if already authenticated
    if (isAuthenticated) {
      setAuthModalOpen(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md animate-fade-in pt-[env(safe-area-inset-top)] pb-[calc(1rem+env(safe-area-inset-bottom))]">
      <div
        className="relative w-full max-w-[94vw] sm:max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border border-cyan-500/40 bg-gradient-to-b from-slate-900 via-slate-950 to-slate-950 p-4 sm:p-6 shadow-[0_0_50px_rgba(6,182,212,0.25)] text-slate-100"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
      >
        {/* Holographic decorative grid line */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-cyan-400 to-transparent opacity-80" />

        {/* Close Button (only available when authenticated) */}
        {isAuthenticated && (
          <button
            type="button"
            onClick={handleClose}
            className="absolute top-3 right-3 sm:top-4 sm:right-4 p-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-cyan-950/40 border border-transparent hover:border-cyan-800/40 transition-all cursor-pointer"
            title="Close dialog"
            aria-label="Close dialog"
          >
            <X className="w-5 h-5" />
          </button>
        )}

        {/* Header HUD */}
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-600/30 to-sky-400/20 border border-cyan-400/50 flex items-center justify-center text-cyan-300 shadow-[0_0_20px_rgba(6,182,212,0.4)] shrink-0">
            {isAuthenticated ? (
              <ShieldCheck className="w-5 h-5 text-emerald-400" />
            ) : (
              <Shield className="w-5 h-5 text-cyan-400" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 id="auth-modal-title" className="text-sm font-bold tracking-wider text-slate-100 font-mono uppercase">
                Security Protocol
              </h2>
              <span className="text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded bg-cyan-950/70 text-cyan-300 font-mono border border-cyan-700/40">
                MK VII
              </span>
            </div>
            <p className="text-xs text-slate-400">
              {isAuthenticated
                ? 'System clearance verified. Manage your passkey below.'
                : 'Enter your passkey to establish a secure link with JARVIS.'}
            </p>
          </div>
        </div>

        {/* Current Status Pill */}
        <div className="mb-5 flex items-center justify-between px-3.5 py-2 rounded-lg border border-slate-800 bg-slate-900/60 font-mono text-xs">
          <span className="text-slate-400 flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5 text-cyan-400" /> Clearance Status:
          </span>
          {isAuthenticated ? (
            <span className="text-emerald-400 font-semibold flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> AUTHORIZED
            </span>
          ) : (
            <span className="text-amber-400 font-semibold flex items-center gap-1">
              <ShieldAlert className="w-3.5 h-3.5" /> LOCKED
            </span>
          )}
        </div>

        {/* Error / Success Notifications */}
        {errorMessage && (
          <div className="mb-4 flex items-center gap-2 p-3 rounded-lg border border-rose-500/40 bg-rose-950/40 text-rose-300 text-xs font-mono animate-shake">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
            <span>{errorMessage}</span>
          </div>
        )}

        {successMessage && (
          <div className="mb-4 flex items-center gap-2 p-3 rounded-lg border border-emerald-500/40 bg-emerald-950/40 text-emerald-300 text-xs font-mono">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="passkey-input"
              className="block text-xs font-mono uppercase tracking-wider text-slate-300 mb-1.5"
            >
              {isAuthenticated ? 'Update Authorization Passkey' : 'Authorization Passkey'}
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-cyan-400">
                <KeyRound className="w-4 h-4" />
              </div>
              <input
                id="passkey-input"
                type={showPassword ? 'text' : 'password'}
                value={inputKey}
                onChange={(e) => setInputKey(e.target.value)}
                placeholder="Enter JARVIS_API_KEY..."
                disabled={isValidating}
                autoFocus
                className="w-full pl-9 pr-11 py-2.5 rounded-xl bg-slate-900/90 border border-slate-700/80 text-[16px] sm:text-sm text-slate-100 placeholder-slate-500 font-mono focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition-all shadow-inner"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
                className="absolute inset-y-0 right-0 pr-3 flex items-center min-w-[44px] min-h-[44px] justify-center text-slate-400 hover:text-cyan-300 transition-colors cursor-pointer"
                title={showPassword ? 'Hide passkey' : 'Show passkey'}
                aria-label={showPassword ? 'Hide passkey' : 'Show passkey'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-slate-500">
              Configured on the Windows host in <code className="text-cyan-400/90 font-mono">D:\Jarvis\app\.env</code> as <code className="text-cyan-400/90 font-mono">JARVIS_API_KEY</code>.
            </p>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button
              type="submit"
              disabled={isValidating || !inputKey.trim()}
              className="flex-1 flex items-center justify-center gap-2 py-3 px-4 min-h-[44px] rounded-xl bg-gradient-to-r from-cyan-600 to-sky-600 hover:from-cyan-500 hover:to-sky-500 text-white text-xs font-mono font-semibold uppercase tracking-wider transition-all shadow-[0_0_20px_rgba(6,182,212,0.3)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {isValidating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin text-cyan-200" />
                  <span>Verifying...</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4" />
                  <span>Authorize Access</span>
                </>
              )}
            </button>

            {isAuthenticated && (
              <button
                type="button"
                onClick={handleClearAuth}
                disabled={isValidating}
                className="px-4 py-3 min-h-[44px] rounded-xl border border-rose-800/50 bg-rose-950/30 hover:bg-rose-900/40 text-rose-300 text-xs font-mono transition-all cursor-pointer"
                title="Lock system and delete stored passkey"
              >
                Lock
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};

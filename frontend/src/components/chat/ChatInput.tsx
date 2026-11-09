import React, { useEffect, useRef } from 'react';
import { Send, CornerDownLeft, Sparkles, Mic, MicOff } from 'lucide-react';
import { useUIStore } from '../../stores/useUIStore';
import { primeAudioContext } from '../../utils/audioChime';

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export const ChatInput: React.FC<ChatInputProps> = ({ onSend, disabled = false }) => {
  const { draftMessage, setDraftMessage, isVoiceModeActive, toggleVoiceMode } = useUIStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-expand textarea up to ~130px (approx 5-6 lines), then allow smooth scrolling
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const computedHeight = Math.min(Math.max(el.scrollHeight, 42), 130);
    el.style.height = `${computedHeight}px`;
  }, [draftMessage]);

  const handleSubmit = () => {
    const trimmed = draftMessage.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setDraftMessage('');
    if (textareaRef.current) {
      textareaRef.current.style.height = '42px';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleToggleVoice = () => {
    primeAudioContext();
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      try {
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0.01;
        u.rate = 10;
        window.speechSynthesis.speak(u);
      } catch {}
    }
    toggleVoiceMode();
  };

  return (
    <div className="px-3 pt-2 pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:p-4 border-t border-cyan-900/30 bg-slate-950/85 backdrop-blur-xl shrink-0">
      <div className="max-w-3xl mx-auto space-y-2">
        {/* Stark Industries High-Tech Input Console */}
        <div className="relative flex items-end gap-2 p-1.5 sm:p-2 rounded-2xl border border-cyan-800/40 bg-slate-900/60 shadow-[0_4px_24px_-4px_rgba(0,0,0,0.6)] focus-within:border-cyan-400 focus-within:shadow-[0_0_20px_rgba(6,182,212,0.25)] transition-all duration-300">
          <div className="absolute -top-1 left-6 w-8 h-[2px] bg-cyan-400/60 blur-[1px]" />

          <textarea
            ref={textareaRef}
            value={draftMessage}
            onChange={(e) => setDraftMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              disabled
                ? 'J.A.R.V.I.S. is synthesizing directive...'
                : 'At your service, Sir. Enter a command or query...'
            }
            disabled={disabled}
            rows={1}
            className="flex-1 min-h-[42px] max-h-[130px] bg-transparent resize-none px-3 py-2 text-[16px] sm:text-sm text-slate-100 placeholder-slate-500 focus:outline-none overflow-y-auto leading-relaxed disabled:opacity-50 font-sans"
          />

          <button
            type="button"
            onClick={handleToggleVoice}
            className={`p-2 sm:p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl border transition-all shrink-0 cursor-pointer ${
              isVoiceModeActive
                ? 'border-cyan-500/50 bg-cyan-950/60 text-cyan-300 shadow-[0_0_12px_rgba(6,182,212,0.3)] animate-pulse'
                : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:text-slate-200 hover:border-slate-700'
            }`}
            title={isVoiceModeActive ? 'Disable hands-free voice mode' : 'Enable hands-free voice ("Hey Jarvis")'}
            aria-label={isVoiceModeActive ? 'Disable voice mode' : 'Enable voice mode'}
          >
            {isVoiceModeActive ? <Mic className="w-4 h-4 text-cyan-400" /> : <MicOff className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={!draftMessage.trim() || disabled}
            className="p-2 sm:p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-xl bg-gradient-to-tr from-cyan-600 to-sky-500 hover:from-cyan-500 hover:to-sky-400 disabled:opacity-30 disabled:hover:from-cyan-600 disabled:hover:to-sky-500 text-slate-950 font-semibold transition-all shrink-0 shadow-lg shadow-cyan-500/20 active:scale-95 cursor-pointer disabled:cursor-not-allowed"
            title={disabled ? 'Synthesizing...' : 'Transmit command'}
            aria-label="Send message"
          >
            <Send className="w-4 h-4 fill-slate-950" />
          </button>
        </div>

        <div className="flex items-center justify-between text-[11px] text-slate-400 px-2 font-mono">
          <div className="flex items-center gap-1.5">
            <CornerDownLeft className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
            <span className="hidden sm:inline">Press Enter to transmit • Shift + Enter for newline</span>
            <span className="sm:hidden">Tap transmit to send</span>
          </div>
          <div className="flex items-center gap-1 text-cyan-400/80">
            <Sparkles className="w-3 h-3 text-cyan-400 shrink-0" />
            <span>J.A.R.V.I.S. Neural Core</span>
          </div>
        </div>
      </div>
    </div>
  );
};

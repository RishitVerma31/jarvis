import React, { useState } from 'react';
import { Bot, User, AlertCircle, Copy, Check } from 'lucide-react';
import type { ChatMessage } from '../../hooks/useChat';
import { MarkdownView } from './MarkdownView';

interface MessageBubbleProps {
  message: ChatMessage;
}

export const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
  const [copied, setCopied] = useState(false);
  const isUser = message.role === 'user';

  // Format timestamp (e.g., "18:59")
  const formattedTime = new Date(message.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const handleCopy = async () => {
    if (!message.content || message.isPending || message.isError) return;
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = message.content;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (isUser) {
    return (
      <div className="flex items-start justify-end gap-3 max-w-3xl ml-auto w-full group">
        <div className="flex flex-col items-end max-w-[85%] sm:max-w-[75%] space-y-1">
          <div className="px-4 py-3 rounded-2xl rounded-tr-sm bg-cyan-950/40 border border-cyan-700/50 text-slate-100 text-sm leading-relaxed shadow-sm shadow-cyan-950/20 backdrop-blur-md">
            <p className="whitespace-pre-wrap break-words font-sans">{message.content}</p>
          </div>
          <span className="text-[10px] text-slate-400 font-mono pr-1">
            {formattedTime}
          </span>
        </div>

        <div className="w-8 h-8 rounded-xl bg-slate-800 border border-slate-700 text-slate-300 flex items-center justify-center shrink-0 shadow-sm mt-0.5">
          <User className="w-4 h-4 text-cyan-400" />
        </div>
      </div>
    );
  }

  // Assistant (J.A.R.V.I.S.) Message Bubble with Markdown & Code Rendering
  return (
    <div className="flex items-start gap-3 max-w-3xl mr-auto w-full group">
      {/* J.A.R.V.I.S. Arc Reactor Icon */}
      <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-cyan-600/30 to-sky-400/20 border border-cyan-400/50 text-cyan-300 flex items-center justify-center shrink-0 shadow-[0_0_12px_rgba(6,182,212,0.3)] mt-0.5">
        <Bot className="w-4 h-4" />
      </div>

      <div className="flex flex-col items-start max-w-[88%] sm:max-w-[85%] space-y-1 w-full min-w-0">
        {/* Header with Title, Timestamp, and Copy Action */}
        <div className="flex items-center justify-between w-full pl-1 pr-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold tracking-wider text-cyan-300 font-sans">
              J.A.R.V.I.S.
            </span>
            <span className="text-[10px] text-slate-400 font-mono">
              {formattedTime}
            </span>
          </div>

          {!message.isPending && !message.isError && (
            <button
              type="button"
              onClick={handleCopy}
              className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 flex items-center gap-1 text-[11px] font-mono text-slate-400 hover:text-cyan-300 transition-all p-1.5 min-h-[32px] rounded hover:bg-slate-800/60 cursor-pointer"
              title="Copy entire response to clipboard"
              aria-label="Copy response"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span className="text-emerald-400 text-[10px]">Copied</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span className="text-[10px]">Copy All</span>
                </>
              )}
            </button>
          )}
        </div>

        {/* Message Content Container */}
        <div
          className={`w-full px-4 py-3.5 rounded-2xl rounded-tl-sm text-sm leading-relaxed backdrop-blur-md transition-all shadow-sm ${
            message.isError
              ? 'bg-rose-950/30 border border-rose-800/50 text-rose-200'
              : 'bg-slate-900/65 border border-cyan-900/40 text-slate-100 shadow-[0_2px_12px_rgba(0,0,0,0.3)]'
          }`}
        >
          {message.isPending ? (
            /* Thinking / Synthesis Indicator */
            <div className="flex items-center gap-3 py-1">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce [animation-delay:-0.3s]" />
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce [animation-delay:-0.15s]" />
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce" />
              </div>
              <span className="text-xs font-mono text-cyan-300/80 tracking-wide">
                J.A.R.V.I.S. is synthesizing directive...
              </span>
            </div>
          ) : message.isError ? (
            /* Error Card */
            <div className="flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="font-semibold text-xs text-rose-300">Directive Failure</p>
                <p className="text-xs text-rose-200/90 whitespace-pre-wrap break-words font-sans">
                  {message.content}
                </p>
              </div>
            </div>
          ) : (
            /* Rich Markdown Rendering with Syntax Highlighting and Code Copy */
            <MarkdownView content={message.content} />
          )}
        </div>
      </div>
    </div>
  );
};

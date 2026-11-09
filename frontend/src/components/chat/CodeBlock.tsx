import React, { useState, useMemo } from 'react';
import { Copy, Check, Terminal } from 'lucide-react';
import Prism from 'prismjs';

// Language definitions for Prism
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-markdown';

interface CodeBlockProps {
  language?: string;
  value: string;
}

// Map common aliases to Prism grammar keys
const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ps: 'powershell',
  ps1: 'powershell',
  yml: 'yaml',
  md: 'markdown',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  cplusplus: 'cpp',
  'c++': 'cpp',
};

// Safe recursive renderer converting Prism Tokens to pure React JSX nodes (No dangerouslySetInnerHTML)
function renderPrismToken(token: string | Prism.Token, key: string): React.ReactNode {
  if (typeof token === 'string') {
    return token;
  }

  const tokenClass = `token ${token.type} ${token.alias || ''}`.trim();

  if (Array.isArray(token.content)) {
    return (
      <span key={key} className={tokenClass}>
        {token.content.map((item, index) => renderPrismToken(item, `${key}-${index}`))}
      </span>
    );
  }

  if (typeof token.content === 'object' && token.content !== null) {
    return (
      <span key={key} className={tokenClass}>
        {renderPrismToken(token.content as Prism.Token, `${key}-inner`)}
      </span>
    );
  }

  return (
    <span key={key} className={tokenClass}>
      {String(token.content)}
    </span>
  );
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ language = 'text', value }) => {
  const [copied, setCopied] = useState(false);

  // Normalize language identifier
  const rawLang = (language || 'text').toLowerCase().replace(/^language-/, '');
  const cleanLang = LANGUAGE_ALIASES[rawLang] || rawLang;

  // Resolve grammar or fallback gracefully to text
  const tokens = useMemo(() => {
    const grammar = Prism.languages[cleanLang] || Prism.languages.text;
    try {
      if (!grammar) {
        return [value];
      }
      return Prism.tokenize(value, grammar);
    } catch {
      return [value];
    }
  }, [value, cleanLang]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      try {
        const textarea = document.createElement('textarea');
        textarea.value = value;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Gracefully handle clipboard failure
      }
    }
  };

  const displayLanguage = (rawLang || 'text').toUpperCase();

  return (
    <div className="my-3 rounded-xl border border-cyan-900/40 bg-slate-950/95 overflow-hidden shadow-lg shadow-black/40 group/code max-w-full">
      {/* Stark Code Card Header */}
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-slate-900/80 border-b border-cyan-900/30 text-xs font-mono select-none">
        <div className="flex items-center gap-2">
          <Terminal className="w-3.5 h-3.5 text-cyan-400" />
          <span className="text-[11px] font-semibold tracking-wider text-cyan-300">
            {displayLanguage}
          </span>
        </div>

        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2.5 py-1 min-h-[32px] rounded-md text-[11px] font-mono text-slate-400 hover:text-cyan-200 hover:bg-slate-800/80 transition-all cursor-pointer"
          title="Copy code to clipboard"
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-400 font-medium">Copied</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5 text-slate-400 group-hover/code:text-cyan-300" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code Body with Horizontal Scroll */}
      <div className="p-3.5 overflow-x-auto text-xs leading-relaxed font-mono">
        <pre className="text-slate-200">
          <code className={`language-${cleanLang}`}>
            {tokens.map((token, index) => renderPrismToken(token, `token-${index}`))}
          </code>
        </pre>
      </div>
    </div>
  );
};

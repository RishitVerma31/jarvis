import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';

interface MarkdownViewProps {
  content: string;
}

export const MarkdownView: React.FC<MarkdownViewProps> = ({ content }) => {
  return (
    <div className="markdown-body font-sans text-sm leading-relaxed text-slate-100 break-words overflow-hidden">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Code blocks and inline code
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const isInline = !match && !String(children).includes('\n');

            if (isInline) {
              return (
                <code
                  className="px-1.5 py-0.5 mx-0.5 rounded-md bg-slate-800/90 text-cyan-300 font-mono text-[12px] border border-cyan-900/50 shadow-xs"
                  {...props}
                >
                  {children}
                </code>
              );
            }

            const language = match ? match[1] : 'text';
            const codeString = String(children).replace(/\n$/, '');

            return <CodeBlock language={language} value={codeString} />;
          },

          // Tables
          table({ children }) {
            return (
              <div className="overflow-x-auto my-3 rounded-xl border border-cyan-900/40 bg-slate-900/40 shadow-sm max-w-full">
                <table className="w-full text-left text-xs border-collapse font-sans">
                  {children}
                </table>
              </div>
            );
          },
          thead({ children }) {
            return (
              <thead className="bg-slate-900/90 border-b border-cyan-800/40 text-cyan-300 font-mono text-[11px] uppercase tracking-wider">
                {children}
              </thead>
            );
          },
          th({ children }) {
            return <th className="px-3.5 py-2.5 font-semibold text-cyan-300">{children}</th>;
          },
          td({ children }) {
            return (
              <td className="px-3.5 py-2 border-b border-slate-800/50 text-slate-200">
                {children}
              </td>
            );
          },

          // Headings
          h1({ children }) {
            return (
              <h1 className="text-lg md:text-xl font-bold tracking-tight text-slate-100 mt-4 mb-2 border-b border-cyan-900/30 pb-1.5 flex items-center gap-2">
                <span className="w-1.5 h-4 bg-cyan-400 rounded-full" />
                <span>{children}</span>
              </h1>
            );
          },
          h2({ children }) {
            return (
              <h2 className="text-base md:text-lg font-semibold tracking-tight text-cyan-200 mt-3.5 mb-2 flex items-center gap-2">
                <span className="w-1.5 h-3.5 bg-cyan-500/80 rounded-full" />
                <span>{children}</span>
              </h2>
            );
          },
          h3({ children }) {
            return (
              <h3 className="text-sm md:text-base font-semibold text-cyan-300 mt-3 mb-1.5">
                {children}
              </h3>
            );
          },
          h4({ children }) {
            return (
              <h4 className="text-xs md:text-sm font-semibold text-cyan-400 mt-2.5 mb-1">
                {children}
              </h4>
            );
          },

          // Lists
          ul({ children }) {
            return (
              <ul className="space-y-1.5 my-2.5 list-disc list-inside text-slate-200 pl-1">
                {children}
              </ul>
            );
          },
          ol({ children }) {
            return (
              <ol className="space-y-1.5 my-2.5 list-decimal list-inside text-slate-200 pl-1">
                {children}
              </ol>
            );
          },
          li({ children }) {
            return <li className="leading-relaxed">{children}</li>;
          },

          // Blockquotes
          blockquote({ children }) {
            return (
              <blockquote className="border-l-2 border-cyan-400 bg-cyan-950/20 px-4 py-2 rounded-r-xl my-3 text-xs text-cyan-100/90 italic">
                {children}
              </blockquote>
            );
          },

          // Emphasis
          strong({ children }) {
            return <strong className="font-semibold text-cyan-200">{children}</strong>;
          },
          em({ children }) {
            return <em className="italic text-slate-200">{children}</em>;
          },

          // Paragraphs
          p({ children }) {
            return <p className="leading-relaxed my-2">{children}</p>;
          },

          // Links (Safe attributes)
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-cyan-400 hover:text-cyan-300 underline underline-offset-4 decoration-cyan-500/40 hover:decoration-cyan-300 transition-colors"
              >
                {children}
              </a>
            );
          },

          // Horizontal rule
          hr() {
            return <hr className="my-4 border-cyan-900/40" />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
};

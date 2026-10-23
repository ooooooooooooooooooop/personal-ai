import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Copy, Check } from 'lucide-react';

function CodeBlock({ node, inline, className, children, ...props }) {
  const [copied, setCopied] = useState(false);
  const match = /language-(\w+)/.exec(className || '');
  const codeText = String(children).replace(/\n$/, '');

  const handleCopy = () => {
    navigator.clipboard?.writeText(codeText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!inline && match) {
    return (
      <div className="my-3 rounded-xl border border-app bg-card overflow-hidden shadow-card text-xs">
        <div className="h-8 px-3 bg-[var(--border)] border-b border-app flex items-center justify-between text-[11px] text-muted font-mono">
          <span>{match[1]}</span>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 hover:text-main transition-colors"
          >
            {copied ? (
              <>
                <Check className="w-3 h-3 text-emerald-400" />
                <span className="text-emerald-400">已复制</span>
              </>
            ) : (
              <>
                <Copy className="w-3 h-3" />
                <span>复制代码</span>
              </>
            )}
          </button>
        </div>
        <pre className="p-3.5 overflow-x-auto font-mono text-main text-[11px] leading-relaxed selection:bg-[#6e77e8]/30">
          <code>{children}</code>
        </pre>
      </div>
    );
  }

  return (
    <code
      className="px-1.5 py-0.5 rounded-md bg-elev border border-app text-indigo-400 dark:text-indigo-300 font-mono text-[11px]"
      {...props}
    >
      {children}
    </code>
  );
}

export function MarkdownContent({ content }) {
  const text = typeof content === 'string'
    ? content
    : (typeof content?.content === 'string'
      ? content.content
      : (typeof content?.text === 'string'
        ? content.text
        : (Array.isArray(content)
          ? content.map((c) => (typeof c === 'string' ? c : (c?.text || c?.content || JSON.stringify(c)))).join('')
          : (content && typeof content === 'object' ? JSON.stringify(content, null, 2) : (content ? String(content) : '')))));

  return (
    <div className="prose dark:prose-invert max-w-none text-main text-xs leading-relaxed space-y-2 selection:bg-[#6e77e8]/30">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: CodeBlock,
          p: ({ children }) => <p className="mb-2 leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="list-disc pl-5 my-2 space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal pl-5 my-2 space-y-1">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          h1: ({ children }) => <h1 className="text-base font-bold text-white mt-4 mb-2">{children}</h1>,
          h2: ({ children }) => <h2 className="text-sm font-semibold text-white mt-3 mb-1.5">{children}</h2>,
          h3: ({ children }) => <h3 className="text-xs font-semibold text-white/95 mt-2 mb-1">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-[#6e77e8] pl-3 py-0.5 my-2 text-white/60 italic bg-[#6e77e8]/5 rounded-r">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto rounded-lg border border-white/[0.08]">
              <table className="w-full text-left text-xs border-collapse">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-white/[0.04] text-white/70 border-b border-white/[0.08]">{children}</thead>,
          th: ({ children }) => <th className="p-2.5 font-semibold text-[11px]">{children}</th>,
          td: ({ children }) => <td className="p-2.5 border-t border-white/[0.04] text-white/80">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

import React, { useState } from 'react';
import { Sparkles, ChevronDown, ChevronRight, Lightbulb, Compass, ListOrdered, CheckCircle2, Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { extractThinkingStructure } from '../../lib/tool-feedback';

export function ThinkingBlock({ content = '', duration = 0, isStreaming = false, tools = [], userPrompt = '' }) {
  const [expanded, setExpanded] = useState(false);

  const text = typeof content === 'string'
    ? content
    : (typeof content?.thinking === 'string'
      ? content.thinking
      : (typeof content?.content === 'string'
        ? content.content
        : (Array.isArray(content)
          ? content.map((c) => (typeof c === 'string' ? c : (c?.text || c?.thinking || c?.content || ''))).join('')
          : (content && typeof content === 'object' ? JSON.stringify(content, null, 2) : (content ? String(content) : '')))));

  if (!text && !isStreaming) return null;

  const isRunning = isStreaming || (tools && tools.some((t) => t.status === 'running'));
  const { summary, steps } = extractThinkingStructure(text, tools, userPrompt, isRunning);

  const isAllStepsDone = steps.length > 0 && steps.every((s) => typeof s === 'object' ? s.isDone : false);
  const isConcluded = !isRunning && (isAllStepsDone || (tools.length > 0 && tools.every((t) => t.status === 'done')));

  return (
    <div className="my-1.5 rounded-xl bg-[var(--bg-elev)] border border-app/60 hover:border-app transition-colors overflow-hidden text-xs shadow-xs">
      {/* 顶栏开关：默认极简紧凑单行 */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors select-none text-left cursor-pointer group"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 text-sub min-w-0">
          <Sparkles className={cn(
            "w-3.5 h-3.5 shrink-0",
            isRunning ? "text-amber-400 animate-spin" : "text-[#818cf8]"
          )} />
          <span className="font-medium text-[11px] text-main/90 group-hover:text-main truncate">
            {isRunning ? '正在推导思考与实施规划…' : '深度思考过程'}
          </span>
          {isConcluded && !isRunning && (
            <span className="text-[9.5px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.2 rounded border border-emerald-500/20 font-mono shrink-0">
              已完成
            </span>
          )}
          {duration > 0 && (
            <span className="text-[10px] text-muted font-mono shrink-0">
              · {duration}s
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-[10.5px] text-muted group-hover:text-sub shrink-0 font-medium">
          <span>{expanded ? '收起思考' : '展开思考'}</span>
          <ChevronRight className={cn(
            "w-3.5 h-3.5 transition-transform duration-200",
            expanded && "rotate-90"
          )} />
        </div>
      </button>

      {/* 仅在展开时展示思考结构与推导细节 */}
      {expanded && (
        <div className="px-3.5 py-2.5 bg-[var(--bg-card)]/40 border-t border-app space-y-2 text-[11px] text-sub leading-relaxed font-sans">
          {summary && (
            <div className="flex items-start gap-1.5 p-2 rounded-lg bg-[var(--bg-elev)] border border-app/50">
              <Lightbulb className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <span className="text-muted mr-1 font-medium text-[10px]">思考脉络:</span>
                <span className="font-medium text-main/90">
                  {summary}
                </span>
              </div>
            </div>
          )}

          {steps.length > 0 && (
            <div className="flex items-start gap-1.5 pt-0.5">
              <ListOrdered className="w-3.5 h-3.5 shrink-0 mt-0.5 text-sky-400" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-muted mr-1 font-medium text-[10px]">实施步骤规划:</span>
                  <span className="text-[10px] font-mono text-muted">
                    {steps.filter(s => typeof s === 'object' ? s.isDone : false).length}/{steps.length} 项完成
                  </span>
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {steps.map((st, i) => {
                    const stepText = typeof st === 'string' ? st : st.content;
                    const stepDone = typeof st === 'object' ? st.isDone : isConcluded;
                    return (
                      <span
                        key={i}
                        className={cn(
                          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border shadow-xs transition-colors",
                          stepDone
                            ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/25"
                            : "bg-sky-500/10 text-sky-200 border-sky-500/20"
                        )}
                      >
                        {stepDone ? (
                          <Check className="w-2.5 h-2.5 text-emerald-400 shrink-0" />
                        ) : (
                          <span className="text-sky-400 font-semibold">{i + 1}.</span>
                        )}
                        <span className="max-w-[240px] truncate" title={stepText}>{stepText}</span>
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* 完整推导思考链文本 */}
          <div className="p-2.5 rounded-lg border border-app/60 bg-black/25 text-sub font-mono text-[11px] leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto">
            {text || '正在生成推导思考链…'}
          </div>
        </div>
      )}
    </div>
  );
}

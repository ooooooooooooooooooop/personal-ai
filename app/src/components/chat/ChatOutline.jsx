import React, { useMemo } from 'react';
import { PanelRightClose, Sparkles, AlertCircle, CheckCircle2, MessageSquare } from 'lucide-react';
import { cn } from '../../lib/utils';
import { extractTurns } from '../../lib/turns';

export { extractTurns };

function formatTurnTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const timeStr = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (isToday) return timeStr;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${timeStr}`;
}

/**
 * ChatOutline 对话目录侧栏：
 * 快速定位问答轮次，展示每轮问答的执行步数、状态、用户问题摘要与时间。
 */
export function ChatOutline({
  messages = [],
  running = false,
  activeTurnId = null,
  onSelectTurn,
  onClose,
}) {
  const turns = useMemo(() => extractTurns(messages, running), [messages, running]);

  return (
    <aside
      className="w-72 md:w-80 border-l border-[var(--border)] bg-[var(--bg-side)] flex flex-col h-full shrink-0 select-none overflow-hidden transition-all duration-200 z-10"
      aria-label="对话目录"
    >
      {/* 目录顶栏 */}
      <div className="h-11 px-3.5 border-b border-[var(--border)] flex items-center justify-between bg-[var(--bg-elev)] shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-xs text-main tracking-tight">对话目录</span>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-medium bg-[var(--bg-card)] border border-[var(--border)] text-sub">
            {turns.length}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-[var(--bg-card)] text-muted hover:text-main transition-colors"
          title="收起对话目录"
          aria-label="收起对话目录"
        >
          <PanelRightClose className="w-4 h-4" />
        </button>
      </div>

      {/* 目录列表 */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 scrollbar-thin">
        {turns.length === 0 ? (
          <div className="h-48 flex flex-col items-center justify-center text-muted text-xs gap-2 px-4 text-center">
            <MessageSquare className="w-6 h-6 text-muted/50" />
            <span>当前会话暂无问答轮次</span>
            <span className="text-[11px] text-muted/70">发送消息后即可快速在此索引定位</span>
          </div>
        ) : (
          turns.map((turn, idx) => {
            const isActive = activeTurnId === turn.id || (!activeTurnId && idx === turns.length - 1);
            const isInterrupted = turn.status === 'interrupted';
            const isRunning = turn.status === 'running';
            const isError = turn.status === 'error';

            return (
              <div
                key={turn.id}
                onClick={() => onSelectTurn?.(turn)}
                className={cn(
                  'group relative p-2.5 rounded-lg border text-left cursor-pointer transition-all duration-150',
                  isActive
                    ? 'border-l-2 border-l-[var(--accent)] border-[var(--border-strong)] bg-[var(--bg-elev)] shadow-xs'
                    : 'border-l-2 border-l-transparent border-transparent hover:border-[var(--border)] hover:bg-[var(--bg-elev)]/60'
                )}
              >
                {/* 顶行：时间和提问气泡 */}
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="text-[11px] text-muted shrink-0 font-medium">
                    你 · {formatTurnTime(turn.timestamp)}
                  </span>
                  <div
                    className="max-w-[150px] truncate px-2 py-0.5 rounded bg-[var(--bg-card)] border border-[var(--border)] text-main text-[11px] font-medium text-right group-hover:border-[var(--accent)]/40 transition-colors"
                    title={turn.prompt}
                  >
                    {turn.prompt}
                  </div>
                </div>

                {/* 底行：步数与状态/回复片段 */}
                <div className="flex items-start gap-1.5 min-w-0">
                  <div className="flex items-center gap-1 shrink-0 text-[11px] font-mono mt-0.5">
                    <span className="text-[var(--accent)]">✳️</span>
                    <span className={cn('font-medium', isRunning ? 'text-[#a5b4fc]' : 'text-sub')}>
                      {isRunning ? '处理中' : `${turn.stepCount || 1} 步`}
                    </span>
                    <span className="text-muted/60">•</span>
                  </div>

                  <div className="flex-1 min-w-0">
                    {isRunning ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-[#a5b4fc] font-medium animate-pulse">
                        <Sparkles className="w-3 h-3" />
                        深度处理中…
                      </span>
                    ) : isInterrupted ? (
                      <span className="text-[11px] text-[var(--red-text)] font-medium">
                        已中断
                      </span>
                    ) : isError ? (
                      <span className="inline-flex items-center gap-1 text-[11px] text-[var(--red-text)]">
                        <AlertCircle className="w-3 h-3 shrink-0" />
                        执行异常
                      </span>
                    ) : turn.responseExcerpt ? (
                      <p className="text-[11px] text-sub line-clamp-2 leading-relaxed break-words">
                        {turn.responseExcerpt}
                      </p>
                    ) : (
                      <span className="text-[11px] text-muted italic">
                        已完成
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

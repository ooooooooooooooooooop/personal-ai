import React from 'react';
import { Sparkles, ListOrdered } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * 顶栏（类似 Codex 极简内容标题栏）：
 * 保持简洁优雅，无多余冗余切换器与返回按钮（返回统一收纳至最顶部系统级菜单栏）
 * 1. 视图/对话标题与执行状态
 * 2. 对话目录抽屉切换
 */
export function TopBar({
  title = '新对话',
  activeBody = '',
  activeModel = '',
  onSelectBody,
  running = false,
  turnDuration = 0,
  hasPendingAsk = false,
  currentView = 'chat',
  showOutline = false,
  onToggleOutline,
  turnCount = 0,
  securityMode = 'manual',
  autoReviewModel = '',
  onSelectSecurity,
}) {
  return (
    <header className="h-11 border-b border-app bg-app px-4 flex items-center justify-between shrink-0 drag-region select-none">
      <div className="flex items-center gap-2 no-drag min-w-0">
        <h2 className="text-xs font-semibold text-main tracking-tight truncate">{title}</h2>
        {hasPendingAsk ? (
          <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-[var(--amber-text)] text-[11px] font-medium shrink-0 animate-pulse">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span>已暂停 · 等待审批</span>
          </div>
        ) : running ? (
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[var(--accent-glow)] border border-[var(--accent)]/40 text-[var(--accent)] text-[11px] font-mono shrink-0">
            <Sparkles className="w-3 h-3 animate-pulse" />
            <span>执行中 · {turnDuration}s</span>
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-2 no-drag">
        {/* 对话目录切换按钮 */}
        {currentView === 'chat' && (
          <button
            onClick={onToggleOutline}
            className={cn(
              'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border transition-colors cursor-pointer',
              showOutline
                ? 'bg-[var(--accent-glow)] border-[var(--accent)] text-main font-medium shadow-xs'
                : 'bg-[var(--bg-elev)] hover:bg-[var(--bg-card)] border-app text-sub hover:text-main'
            )}
            title={showOutline ? '收起对话目录' : '展开对话目录'}
            aria-label="切换对话目录"
          >
            <ListOrdered className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span>目录</span>
            {turnCount > 0 && (
              <span className="text-[10px] font-mono px-1 py-0.2 rounded bg-[var(--border)] text-sub">
                {turnCount}
              </span>
            )}
          </button>
        )}
      </div>
    </header>
  );
}

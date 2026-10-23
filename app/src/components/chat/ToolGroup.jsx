import React, { useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Check,
  CheckCircle2,
  AlertCircle,
  FilePen,
  BookOpen,
  Terminal,
  ListChecks,
  Activity,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { ToolCard } from './ToolCard';
import { analyzeToolGroup } from '../../lib/tool-feedback';

function groupParsedSteps(parsed = []) {
  const groups = [];
  let currentMemoryBatch = null;

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    const isInternalCognitive = item.category?.isMemory || item.name === 'world_model';

    if (isInternalCognitive) {
      if (!currentMemoryBatch) {
        currentMemoryBatch = {
          type: 'memory_batch',
          items: [item],
          startIndex: i + 1,
        };
        groups.push(currentMemoryBatch);
      } else {
        currentMemoryBatch.items.push(item);
      }
    } else {
      currentMemoryBatch = null;
      groups.push({
        type: 'step',
        item,
        index: i + 1,
      });
    }
  }

  return groups;
}

export function ToolGroup({ tools = [], isRunning = false, userPrompt = '' }) {
  const [expanded, setExpanded] = useState(false);
  const [showRawTools, setShowRawTools] = useState(false);
  const [expandedBatches, setExpandedBatches] = useState(new Set());

  if (!tools || tools.length === 0) return null;

  const totalSteps = tools.length;
  const analysis = analyzeToolGroup(tools, userPrompt, isRunning);
  const completedCount = tools.filter((t) => t.status === 'done' || t.status === 'error').length;
  const percent = Math.min(100, Math.round((completedCount / totalSteps) * 100));

  const hasTodos = analysis.todos && analysis.todos.length > 0;
  const todoCompletedCount = hasTodos
    ? analysis.todos.filter((t) => t.status === 'completed' || t.status === 'done').length
    : 0;

  const runningIndex = tools.findIndex((t) => t.status === 'running');
  const activeParsed = runningIndex >= 0
    ? analysis.parsed[runningIndex]
    : (isRunning ? analysis.parsed[analysis.parsed.length - 1] : null);
  const currentStepNum = runningIndex >= 0 ? runningIndex + 1 : Math.min(completedCount + 1, totalSteps);

  const hasErrors = analysis.errors.length > 0;
  const stepGroups = groupParsedSteps(analysis.parsed);

  const toggleBatch = (batchId) => {
    setExpandedBatches((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  };

  return (
    <div className="my-1.5 rounded-xl border border-app/60 hover:border-app transition-colors bg-[var(--bg-elev)] overflow-hidden text-xs shadow-xs">
      {/* 顶栏控制：状态、精简摘要与折叠切换（默认单行极简） */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center justify-between text-xs text-sub hover:text-main hover:bg-[var(--bg-card)] transition-colors select-none cursor-pointer group"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              'w-2 h-2 rounded-full shrink-0',
              isRunning
                ? 'bg-amber-400 animate-pulse'
                : hasErrors
                ? 'bg-rose-400'
                : 'bg-emerald-400'
            )}
          />
          <span className="font-semibold text-main/90 group-hover:text-main text-[11.5px] truncate">
            {isRunning
              ? `正在执行操作 (${completedCount}/${totalSteps} 步 · ${percent}%)`
              : hasErrors
              ? `执行遇到异常 (${completedCount}/${totalSteps} 步)`
              : `已完成 ${totalSteps} 步执行操作`}
          </span>

          {/* 重点摘要徽章（仅在未展开时显示 1~2 个关键产物，绝不堆叠） */}
          {!expanded && !isRunning && analysis.summaryBadges?.length > 0 && (
            <div className="hidden sm:flex items-center gap-1.5 shrink-0 ml-1">
              {analysis.summaryBadges.slice(0, 2).map((b, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[10px] font-mono bg-white/[0.04] border border-white/5 text-sub"
                >
                  <span className="opacity-70">{b.sub}</span>
                  <span className="opacity-40">·</span>
                  <span className="max-w-[140px] truncate text-main/90">{b.label}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          {isRunning ? (
            <span className="text-[10px] text-amber-400 bg-amber-400/10 px-1.5 py-0.2 rounded border border-amber-400/20 font-mono animate-pulse">
              执行中
            </span>
          ) : hasErrors ? (
            <span className="text-[10px] text-rose-400 bg-rose-400/10 px-1.5 py-0.2 rounded border border-rose-400/20 font-mono">
              {analysis.errors.length} 处异常
            </span>
          ) : (
            <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.2 rounded border border-emerald-500/20 font-mono">
              全部完成
            </span>
          )}
          <span className="text-[10.5px] text-muted group-hover:text-sub font-medium ml-1">
            {expanded ? '收起明细' : '展开明细'}
          </span>
          <ChevronRight
            className={cn(
              'w-3.5 h-3.5 text-muted transition-transform duration-200',
              expanded && 'rotate-90'
            )}
          />
        </div>
      </button>

      {/* 执行中即时进度条与当前实施项 */}
      {isRunning && (
        <>
          <div className="w-full bg-white/5 h-0.5 overflow-hidden">
            <div
              className="bg-gradient-to-r from-amber-400 to-emerald-400 h-full transition-all duration-300"
              style={{ width: `${Math.max(8, percent)}%` }}
            />
          </div>
          {activeParsed && (
            <div className="px-3 py-1.5 bg-amber-500/5 border-t border-amber-500/15 text-[11px] text-sub flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-ping shrink-0" />
                <span className="text-muted text-[10px] shrink-0 font-medium">当前实施:</span>
                <span className="font-mono text-main text-[11px] truncate">
                  第 {currentStepNum}/{totalSteps} 步 · {activeParsed.category.actionLabel}
                </span>
              </div>
              <span className="text-[10px] font-mono text-amber-400 shrink-0 font-medium ml-2">
                进行中…
              </span>
            </div>
          )}
        </>
      )}

      {/* 仅在用户主动展开时，展示结构化步骤与详情 */}
      {expanded && (
        <div className="px-3.5 py-3 bg-[var(--bg-card)]/40 border-t border-app space-y-3 text-xs">
          {/* 1. 核心结论一句话 */}
          {analysis.headline && (
            <div className="flex items-center gap-1.5 p-2 rounded-lg bg-[var(--bg-elev)] border border-app/50 text-[11px]">
              {hasErrors ? (
                <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              )}
              <span className="text-muted font-medium shrink-0">实施摘要:</span>
              <span className="text-main font-medium truncate">{analysis.headline}</span>
            </div>
          )}

          {/* 2. 计划实施任务清单 (todos，若有) */}
          {hasTodos && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-semibold text-main">
                <div className="flex items-center gap-1.5">
                  <ListChecks className="w-3.5 h-3.5 text-sky-400" />
                  <span>任务推进清单</span>
                </div>
                <span className="text-[10px] font-mono text-muted">
                  {todoCompletedCount}/{analysis.todos.length} 完成
                </span>
              </div>
              <div className="space-y-1">
                {analysis.todos.map((todo, idx) => {
                  const isDone = todo.status === 'completed' || todo.status === 'done';
                  const isInProg = todo.status === 'in_progress' || todo.status === 'active';
                  return (
                    <div
                      key={idx}
                      className={cn(
                        "flex items-center justify-between gap-2 py-1 px-2 rounded-lg border text-[11px]",
                        isDone
                          ? "bg-emerald-500/5 border-emerald-500/15"
                          : isInProg
                          ? "bg-amber-500/5 border-amber-500/20"
                          : "bg-[var(--bg-elev)] border-app/40"
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        {isDone ? (
                          <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                        ) : (
                          <span className="w-1.5 h-1.5 rounded-full bg-muted/40 shrink-0" />
                        )}
                        <span className={cn('truncate', isDone ? 'text-main font-medium' : 'text-sub')}>
                          {todo.content}
                        </span>
                      </div>
                      <span className="text-[9.5px] font-mono text-muted shrink-0">
                        {isDone ? '已达成' : '推进中'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* 3. 操作执行明细 (智能聚合重复内部认知调用) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px] font-semibold text-main">
              <div className="flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                <span>操作执行明细 (共 {totalSteps} 步)</span>
              </div>
              <span className="text-[10px] text-muted font-mono">{completedCount}/{totalSteps} 步完成</span>
            </div>

            <div className="space-y-1">
              {stepGroups.map((g, gIdx) => {
                if (g.type === 'memory_batch') {
                  const isBatchExpanded = expandedBatches.has(`batch-${gIdx}`);
                  return (
                    <div key={gIdx} className="rounded-lg border border-app/50 bg-[var(--bg-elev)] overflow-hidden">
                      <button
                        type="button"
                        onClick={() => toggleBatch(`batch-${gIdx}`)}
                        className="w-full flex items-center justify-between py-1.5 px-2 hover:bg-white/[0.02] text-left cursor-pointer transition-colors"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Activity className="w-3.5 h-3.5 text-[#818cf8] shrink-0" />
                          <span className="font-mono text-main text-[11px] truncate">
                            认知状态同步与推演（已完成 {g.items.length} 次状态记录）
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-[10px] text-muted shrink-0 font-mono">
                          <span>{isBatchExpanded ? '收起' : `展开 ${g.items.length} 步`}</span>
                          <ChevronDown className={cn('w-3 h-3 transition-transform', isBatchExpanded && 'rotate-180')} />
                        </div>
                      </button>

                      {isBatchExpanded && (
                        <div className="p-2 border-t border-app/40 space-y-1 bg-black/20">
                          {g.items.map((it, itIdx) => (
                            <div key={itIdx} className="flex items-center justify-between gap-2 text-[10.5px] text-sub py-0.5 px-1">
                              <span className="font-mono text-muted">{g.startIndex + itIdx}.</span>
                              <span className="truncate flex-1 font-mono">{it.category.actionLabel}</span>
                              <span className="text-[9.5px] font-mono text-emerald-400">已记录</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                }

                const p = g.item;
                return (
                  <div key={gIdx} className="flex items-center justify-between gap-2 py-1 px-2 rounded-lg bg-[var(--bg-elev)] border border-app/60 text-sub">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <span className="font-mono text-[10px] text-muted w-5 shrink-0">{g.index}.</span>
                      <span className="font-mono text-main truncate text-[11px]" title={p.category.actionLabel}>
                        {p.category.actionLabel}
                      </span>
                    </div>
                    <span className={cn(
                      "text-[9.5px] font-mono px-1.5 py-0.2 rounded border shrink-0",
                      p.outcome.isError
                        ? "bg-rose-500/10 text-rose-300 border-rose-500/20"
                        : p.outcome.isRunning
                        ? "bg-amber-500/10 text-amber-300 border-amber-500/20 animate-pulse"
                        : "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                    )}>
                      {p.outcome.badge || '已完成'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 4. 底层参数与技术日志（二次折叠抽屉） */}
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowRawTools(!showRawTools)}
              className="text-[10.5px] font-mono text-muted hover:text-main flex items-center gap-1 transition-colors cursor-pointer"
            >
              <span>{showRawTools ? '收起完整调用参数与日志' : '查看完整调用参数与控制台回执 (ToolCards)'}</span>
              <ChevronDown className={cn('w-3 h-3 transition-transform', showRawTools && 'rotate-180')} />
            </button>
            {showRawTools && (
              <div className="mt-2 space-y-2 p-2 rounded-lg bg-black/30 border border-app/50">
                {tools.map((tool, idx) => (
                  <ToolCard
                    key={idx}
                    tool={tool.name}
                    args={tool.args}
                    result={tool.result}
                    status={tool.status}
                    exitCode={tool.exitCode}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

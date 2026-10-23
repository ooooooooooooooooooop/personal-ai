import React, { useState } from 'react';
import {
  Terminal,
  FileSearch,
  FileEdit,
  Eye,
  Check,
  AlertCircle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { cn } from '../../lib/utils';

export function ToolCard({
  tool = 'bash',
  args = {},
  result = '',
  status = 'done', // running, done, error
  exitCode = 0,
}) {
  const [expanded, setExpanded] = useState(false);

  const textResult = typeof result === 'string'
    ? result
    : (typeof result?.content === 'string'
      ? result.content
      : (Array.isArray(result?.content)
        ? result.content.map((c) => (typeof c === 'string' ? c : (c?.text || c?.content || JSON.stringify(c)))).join('\n')
        : (result !== undefined && result !== null && typeof result === 'object' ? JSON.stringify(result, null, 2) : (result ? String(result) : ''))));

  // Categorize tool verb & icon
  const getToolMeta = () => {
    const safeArgs = args && typeof args === 'object' ? args : {};
    const t = tool?.toLowerCase?.() || '';
    switch (t) {
      case 'bash':
      case 'run_command':
      case 'cmd':
      case 'exec':
        return {
          label: '运行命令',
          icon: Terminal,
          cmd: safeArgs.CommandLine || safeArgs.command || safeArgs.cmd || safeArgs.toolSummary || '',
        };
      case 'read':
      case 'read_file':
      case 'view_file':
      case 'get_file':
        return {
          label: '查阅代码',
          icon: Eye,
          cmd: safeArgs.AbsolutePath || safeArgs.Path || safeArgs.path || safeArgs.file || '查阅核心代码上下文',
        };
      case 'write':
      case 'edit':
      case 'replace_file_content':
      case 'write_to_file':
      case 'edit_file':
      case 'write_file':
        return {
          label: '修改代码',
          icon: FileEdit,
          cmd: safeArgs.TargetFile || safeArgs.Path || safeArgs.path || safeArgs.file || '实施文件改动',
        };
      case 'repo_map':
        return {
          label: '工程代码架构全景扫描',
          icon: FileSearch,
          cmd: safeArgs.subdir ? `扫描目录: ${safeArgs.subdir}` : '全工程架构拓扑扫描',
        };
      case 'search_web':
      case 'search':
        return {
          label: '检索信息',
          icon: FileSearch,
          cmd: safeArgs.query || '',
        };
      case 'world_model':
        return {
          label: safeArgs.subject ? `世界模型推演: ${safeArgs.subject}` : '世界模型认知推演',
          icon: Eye,
          cmd: safeArgs.subject || (safeArgs.op ? `认知操作: ${safeArgs.op}` : '维护世界模型认知'),
        };
      case 'update_todos':
      case 'todos':
        return {
          label: '任务计划清单',
          icon: FileEdit,
          cmd: Array.isArray(safeArgs.todos) ? `${safeArgs.todos.length} 项实施规划` : '更新执行任务',
        };
      case 'fast_context':
        return {
          label: '代码上下文检索',
          icon: FileSearch,
          cmd: safeArgs.query || safeArgs.subdir || '快速索引相关源码',
        };
      default:
        return {
          label: tool || '工具执行',
          icon: Terminal,
          cmd: typeof safeArgs === 'object'
            ? Object.keys(safeArgs).map((k) => `${k}: ${typeof safeArgs[k] === 'object' ? JSON.stringify(safeArgs[k]).slice(0, 30) : safeArgs[k]}`).slice(0, 2).join(', ')
            : String(safeArgs),
        };
    }
  };

  const meta = getToolMeta();
  const Icon = meta.icon;
  const isError = status === 'error' || (exitCode !== undefined && exitCode !== 0);

  return (
    <div className="my-1.5 rounded-lg bg-[var(--bg-elev)] border border-app overflow-hidden text-xs shadow-xs">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-[var(--bg-card)] transition-colors select-none text-left"
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-2.5 truncate max-w-[82%]">
          <div className="w-5 h-5 rounded bg-[var(--border)] flex items-center justify-center shrink-0">
            <Icon className="w-3 h-3 text-[var(--accent)]" />
          </div>
          <span className="font-semibold text-main text-[11px] shrink-0">
            {meta.label}
          </span>
          <span className="font-mono text-muted truncate text-[11px]" title={meta.cmd}>
            {meta.cmd}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {status === 'running' && (
            <span className="text-[10px] text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded border border-amber-400/20 font-mono animate-pulse">
              执行中
            </span>
          )}
          {!isError && status === 'done' && (
            <span className="flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-400/10 px-1.5 py-0.5 rounded border border-emerald-400/20 font-mono">
              <Check className="w-2.5 h-2.5" />
              已完成
            </span>
          )}
          {isError && (
            <span className="flex items-center gap-1 text-[10px] text-rose-400 bg-rose-400/10 px-1.5 py-0.5 rounded border border-rose-400/20 font-mono">
              <AlertCircle className="w-2.5 h-2.5" />
              异常
            </span>
          )}
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-muted" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-muted" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-app bg-black/25">
          {/* 参数预览 */}
          {args && Object.keys(args).length > 0 && (
            <div className="px-3 py-2 border-b border-app/50 font-mono text-[10px] text-sub space-y-1">
              <div className="text-muted font-medium font-sans">输入参数:</div>
              <pre className="whitespace-pre-wrap break-all max-h-36 overflow-y-auto bg-black/20 p-1.5 rounded">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}
          {/* 执行结果 */}
          {textResult && (
            <div className="px-3 py-2 font-mono text-[11px] text-sub leading-relaxed max-h-60 overflow-y-auto whitespace-pre-wrap">
              <div className="text-muted font-medium font-sans mb-1 text-[10px]">输出回执:</div>
              <pre className="whitespace-pre-wrap break-all bg-black/20 p-1.5 rounded">
                {textResult}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

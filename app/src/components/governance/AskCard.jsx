import React, { useState } from 'react';
import { ShieldAlert, Check, X, Edit3, Terminal, FileCode, AlertTriangle } from 'lucide-react';
import { cn } from '../../lib/utils';

export function AskCard({
  id = 'ask-1',
  tool = 'bash',
  command = '',
  rule = '',
  summary = '',
  detail = '',
  args = {},
  risk = 'high',
  riskUnits = [],
  onResolve,
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 提取目标路径（如果存在）
  const targetPath = args?.path || args?.target || args?.file || args?.filePath || '';

  // 提取友好的工具中文名称
  const getToolDisplayName = (t) => {
    const raw = String(t || '').toLowerCase();
    if (raw.includes('bash') || raw.includes('command') || raw === 'run_command' || raw === 'exec') {
      return '系统命令执行 (Bash / Terminal)';
    }
    if (raw.includes('write') || raw === 'file_write') {
      return '文件写入 / 创建 (write_file)';
    }
    if (raw.includes('edit') || raw === 'file_edit') {
      return '修改现有文件 (edit_file)';
    }
    if (raw.includes('read') || raw === 'file_read') {
      return '读取文件 (read_file)';
    }
    return t || '操作执行';
  };

  // 避免空对象 "{}" 显示为命令
  let initialCmd = command;
  if (!initialCmd || initialCmd === '{}' || initialCmd.trim() === '') {
    if (summary && summary.trim()) {
      initialCmd = summary;
    } else if (targetPath) {
      initialCmd = targetPath;
    } else if (args && Object.keys(args).length > 0) {
      initialCmd = JSON.stringify(args, null, 2);
    } else {
      initialCmd = `${tool} 执行请求`;
    }
  }

  const [editedCmd, setEditedCmd] = useState(initialCmd);

  // 首用反馈规则：如果 summary 与命令载荷重复，不单独显示 .ask-summary
  const isDuplicateSummary = !summary || summary === editedCmd || summary === initialCmd;

  const handleAction = async (decision) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await onResolve?.({ id, decision, command: editedCmd });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ask-card my-3 p-3.5 rounded-xl bg-[var(--bg-elev)] border border-amber-500/40 shadow-[0_4px_24px_-4px_rgba(245,158,11,0.15)] text-xs text-main rim-highlight">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-[var(--amber-text)] font-semibold text-xs">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>安全治理拦截 · 需要操作员审批</span>
        </div>
        <span className="px-2 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/25 text-[var(--amber-text)] font-mono text-[10px]">
          {risk === 'high' ? '高风险操作' : risk === 'critical' ? '严苛管控' : '待审批'}
        </span>
      </div>

      {/* 审批主体说明（明确说明审批什么工具、什么动作、什么目标） */}
      <div className="mb-3 p-2.5 rounded-lg bg-[var(--bg-card)] border border-app space-y-1.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted">申请工具：</span>
          <span className="font-mono font-medium text-main bg-black/20 px-1.5 py-0.5 rounded border border-white/5">
            {getToolDisplayName(tool)}
          </span>
        </div>
        {targetPath && (
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted">操作目标：</span>
            <span
              className="font-mono text-main bg-black/20 px-1.5 py-0.5 rounded border border-white/5 truncate max-w-[280px]"
              title={targetPath}
            >
              {targetPath}
            </span>
          </div>
        )}
        {rule && (
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-muted">拦截规则：</span>
            <span className="font-mono text-amber-300/80 text-[10px]">
              {rule}
            </span>
          </div>
        )}
        {!isDuplicateSummary && summary && (
          <div className="ask-summary text-sub text-[11px] pt-1 border-t border-app leading-relaxed">
            <span className="font-semibold text-main mr-1">操作说明:</span>
            {summary}
          </div>
        )}
        {detail && detail !== summary && (
          <p className="text-[11px] text-muted leading-relaxed">
            {detail}
          </p>
        )}
      </div>

      {/* Command Payload Box */}
      <div className="text-[11px] text-muted mb-1 flex items-center justify-between">
        <span>核验载荷内容：</span>
        <span className="text-[10px] text-muted">可点击右侧图标修改参数后再批准</span>
      </div>
      <div className="mb-3 p-2.5 rounded-lg bg-black/40 border border-white/[0.08] font-mono text-xs text-amber-200/90 leading-relaxed overflow-x-auto flex items-center justify-between">
        {isEditing ? (
          <input
            type="text"
            value={editedCmd}
            onChange={(e) => setEditedCmd(e.target.value)}
            className="ask-edit w-full bg-transparent border-none outline-none text-amber-200 font-mono text-xs"
            autoFocus
          />
        ) : (
          <code className="ask-cmd break-all whitespace-pre-wrap">{editedCmd}</code>
        )}
        <button
          onClick={() => setIsEditing(!isEditing)}
          className="ask-edit-toggle ml-2 p-1 rounded hover:bg-white/10 text-white/40 hover:text-white transition-colors shrink-0 cursor-pointer"
          title="修改参数"
          aria-label="修改参数"
        >
          <Edit3 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-2 justify-end">
        <button
          onClick={() => handleAction('deny')}
          disabled={submitting}
          data-a="deny"
          className="ask-btn px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] disabled:opacity-50 text-white/70 hover:text-white border border-white/[0.08] font-medium transition-colors flex items-center gap-1.5 cursor-pointer"
        >
          <X className="w-3 h-3 text-rose-400" />
          拒绝
        </button>
        <button
          onClick={() => handleAction('allow_session')}
          disabled={submitting}
          data-a="allow_session"
          className="ask-btn px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/[0.1] disabled:opacity-50 text-white/90 border border-white/[0.1] font-medium transition-colors cursor-pointer"
        >
          本次会话允许
        </button>
        <button
          onClick={() => handleAction('allow_once')}
          disabled={submitting}
          data-a="allow"
          className="ask-btn px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium shadow-[0_0_12px_rgba(16,185,129,0.35)] transition-all active:scale-[0.98] flex items-center gap-1.5 cursor-pointer"
        >
          <Check className="w-3.5 h-3.5" />
          {submitting ? '提交中…' : '批准执行'}
        </button>
      </div>
    </div>
  );
}

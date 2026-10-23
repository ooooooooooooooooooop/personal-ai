import React, { useState } from 'react';
import { FilePen, FilePlus2, FileX2, Undo2, ArrowRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { sendCmd } from '../../lib/api';

const OP = {
  create: { label: '新建', icon: FilePlus2 },
  write: { label: '写入', icon: FilePen },
  backup: { label: '修改', icon: FilePen },
  delete: { label: '删除', icon: FileX2 },
};

const base = (p) => String(p ?? '').split(/[\\/]/).pop();

/**
 * 一轮结束后"它改了什么、能不能撤"——直接挂在那轮回复下面，不用去别的页面找。
 * 回执按 toolCallId 精确归属（FileOpsGuard 记录），不靠时间猜。
 * 撤销走 fileops_undo_call（恢复本身也有回执，可再撤回），需二次确认。
 */
export function TurnChanges({ tools = [], fileopsByCall = {}, onView, onUndone }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const callIds = tools.map((t) => t?.id).filter((id) => id && fileopsByCall[id]?.length);
  if (!callIds.length && !result) return null;

  // 同一文件被多次改动只算一次，显示最后一次操作
  const byTarget = new Map();
  for (const id of callIds) {
    for (const op of fileopsByCall[id]) {
      if (OP[op.op]) byTarget.set(op.target, op);
    }
  }
  const files = [...byTarget.values()];

  const handleUndo = async () => {
    if (!confirming) { setConfirming(true); return; }
    setConfirming(false);
    setBusy(true);
    let restored = 0;
    const failed = [];
    for (const id of [...callIds].reverse()) {
      const r = await sendCmd('fileops_undo_call', { toolCallId: id });
      if (r.success) {
        restored += r.data?.restored?.length ?? 0;
        for (const s of r.data?.skipped ?? []) failed.push(s.reason);
      } else {
        failed.push(r.error || '撤销被拒绝');
      }
    }
    setBusy(false);
    setResult(failed.length
      ? { ok: false, text: `已撤销 ${restored} 处，${failed.length} 处未能恢复：${failed[0]}` }
      : { ok: true, text: `已撤销这一轮的 ${restored} 处改动` });
    onUndone?.();
  };

  if (result) {
    return (
      <div
        data-turn-changes="done"
        className={cn('mt-1 text-[11px]', result.ok ? 'text-[var(--green-text)]' : 'text-[var(--red-text)]')}
      >
        {result.text}
      </div>
    );
  }

  const shown = files.slice(0, 3);
  return (
    <div
      data-turn-changes={files.length}
      className="mt-1 flex items-center gap-2 flex-wrap px-2.5 py-1.5 rounded-lg bg-[var(--bg-elev)] border border-[var(--border)] text-[11px]"
    >
      <span className="text-sub font-medium">这一轮改了 {files.length} 个文件</span>
      {shown.map((op) => {
        const Icon = OP[op.op].icon;
        return (
          <span key={op.target} className="flex items-center gap-1 font-mono text-main" title={`${OP[op.op].label} ${op.target}`}>
            <Icon className="w-3 h-3 text-muted" />
            {base(op.target)}
          </span>
        );
      })}
      {files.length > shown.length && <span className="text-muted">等</span>}
      <span className="flex-1" />
      <button
        type="button"
        onClick={onView}
        className="flex items-center gap-1 px-2 py-0.5 rounded text-[var(--accent)] hover:bg-[var(--accent-glow)] transition-colors"
      >
        查看改动 <ArrowRight className="w-3 h-3" />
      </button>
      <button
        type="button"
        onClick={handleUndo}
        onBlur={() => setConfirming(false)}
        disabled={busy}
        className={cn(
          'flex items-center gap-1 px-2 py-0.5 rounded border transition-colors disabled:opacity-60',
          confirming
            ? 'bg-rose-600 hover:bg-rose-500 border-rose-500 text-white'
            : 'border-transparent text-sub hover:text-[var(--red-text)] hover:border-rose-500/40'
        )}
      >
        <Undo2 className="w-3 h-3" />
        {busy ? '撤销中…' : confirming ? '确认撤销这一轮？' : '撤销'}
      </button>
    </div>
  );
}

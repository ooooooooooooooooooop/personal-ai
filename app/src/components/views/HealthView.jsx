import React, { useState, useEffect } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, CircleDashed, Info, RefreshCw } from 'lucide-react';
import { cn } from '../../lib/utils';
import { probeHealth, runHealthAction, relTime } from '../../lib/health';
import { AuditView } from './AuditView';

const TONE = {
  ok: { icon: CheckCircle2, color: 'text-[var(--green-text)]', label: '正常' },
  warn: { icon: AlertTriangle, color: 'text-[var(--amber-text)]', label: '需要处理' },
  err: { icon: XCircle, color: 'text-[var(--red-text)]', label: '异常' },
  info: { icon: Info, color: 'text-muted', label: '提示' },
  unknown: { icon: CircleDashed, color: 'text-muted', label: '未知' },
};
const ORDER = { err: 0, warn: 1, unknown: 2, info: 3, ok: 4 };

/**
 * 健康页回答三件事：正常吗 → 哪里不正常 → 怎么办。
 * 结论在最上；有问题的排前面且带出路按钮；未取得的如实写"未知"。
 * 「事件记录」是查原因的地方（原审计页），同属"出了什么事"这一个问题。
 * 注：引擎切换统一归属于侧栏左下角常驻按钮，此处不重复堆叠切换控件。
 */
export function HealthView({ initialTab = 'status', onNavigate, refreshNonce = 0 }) {
  const [tab, setTab] = useState(initialTab === 'events' ? 'events' : 'status');
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null);

  const refresh = async () => {
    setLoading(true);
    try { setHealth(await probeHealth()); } finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, [refreshNonce]);

  const handleAction = async (item) => {
    const a = item.action;
    if (a?.kind === 'nav') { onNavigate?.(a.view); return; }
    setBusy(item.id);
    try { await runHealthAction(a); } finally { setBusy(null); refresh(); }
  };

  const overall = health?.overall ?? 'unknown';
  const V = TONE[overall];
  const items = [...(health?.items ?? [])].sort((a, b) => ORDER[a.tone] - ORDER[b.tone]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-app text-xs text-main">
      <div className="px-6 pt-5 pb-0 border-b border-[var(--border)] shrink-0">
        <div className="max-w-3xl mx-auto">
          <h2 className="text-sm font-bold text-main mb-3">系统健康</h2>
          <div className="flex gap-1" role="tablist">
            {[{ id: 'status', label: '状态' }, { id: 'events', label: '事件记录' }].map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'px-3 py-2 text-xs border-b-2 -mb-px transition-colors',
                  tab === t.id ? 'border-[var(--accent)] text-main font-medium' : 'border-transparent text-sub hover:text-main'
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tab === 'events' ? (
        <AuditView embedded />
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          <div className="max-w-3xl mx-auto space-y-4">
            {/* 结论 */}
            <div
              id="health-verdict"
              className="p-4 rounded-xl bg-[var(--bg-elev)] border border-[var(--border)] shadow-card flex items-center gap-3"
            >
              <V.icon className={cn('w-6 h-6 shrink-0', V.color)} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-main">{health?.label ?? '正在检查…'}</div>
                {health && (
                  <div className="text-[11px] text-muted mt-0.5">检查于 {relTime(health.at)}</div>
                )}
              </div>
              <button
                onClick={refresh}
                disabled={loading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--bg)] hover:bg-[var(--bg-side)] border border-[var(--border)] text-main transition-colors disabled:opacity-60"
              >
                <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
                重新检查
              </button>
            </div>

            {/* 逐项 */}
            <ul className="rounded-xl bg-[var(--bg-elev)] border border-[var(--border)] shadow-card divide-y divide-[var(--border)]">
              {items.map((it) => {
                const T = TONE[it.tone];
                return (
                  <li key={it.id} data-health-item={it.id} className="px-4 py-3 flex items-center gap-3">
                    <T.icon className={cn('w-4 h-4 shrink-0', T.color)} />
                    <div className="w-20 shrink-0 font-medium text-main">{it.name}</div>
                    <div className="flex-1 min-w-0">
                      <div className={cn('text-[11px]', it.tone === 'err' ? 'text-[var(--red-text)]' : 'text-sub')}>{it.text}</div>
                      {it.detail && <div className="text-[10px] text-muted font-mono truncate mt-0.5" title={it.detail}>{it.detail}</div>}
                    </div>
                    {it.action && (
                      <button
                        onClick={() => handleAction(it)}
                        disabled={busy === it.id}
                        className="shrink-0 px-3 py-1 rounded-md disabled:opacity-60 text-white text-[11px] font-medium transition-colors cursor-pointer bg-[#4f58c7] hover:bg-[#4338ca]"
                      >
                        {busy === it.id ? '处理中…' : it.action.label}
                      </button>
                    )}
                  </li>
                );
              })}
              {!items.length && <li className="px-4 py-3 text-muted">正在检查…</li>}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

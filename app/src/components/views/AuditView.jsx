import React, { useState, useEffect } from 'react';
import { RefreshCw, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { sendCmd } from '../../lib/api';

/**
 * 事件记录 = 出事后查"当时发生了什么"。
 * 按人能理解的类别筛选；每行一句话摘要；原始记录点开才看（取证需要，但不该迎面甩一屏 JSON）。
 */
const CATEGORIES = [
  { id: 'approval', label: '审批', re: /ASK|DECISION|APPROV|PENDING|GOV_DENY|DENY|ALLOW/ },
  { id: 'file', label: '文件操作', re: /FILE|FILEOPS|RESTORE|UNDO|RECYCLE/ },
  { id: 'engine', label: '引擎', re: /BODY|HANDOFF|LEASE|RESPAWN|SPAWN/ },
  { id: 'model', label: '模型与服务', re: /MODEL|PROVIDER|AUTH|KEY/ },
  { id: 'upkeep', label: '备份与自检', re: /BACKUP|GOV_|SYNC|COGNITION|WM_/ },
  { id: 'budget', label: '用量', re: /BUDGET|USAGE|RATE_LIMIT/ },
];

const categoryOf = (kind = '') => CATEGORIES.find((c) => c.re.test(String(kind).toUpperCase()))?.label ?? '其他';

function summarize(ev) {
  const d = ev.data;
  if (d == null) return '';
  if (typeof d === 'string') return d.slice(0, 120);
  const pick = [d.summary, d.tool, d.toolName, d.target, d.path, d.body, d.provider && d.model ? `${d.provider}/${d.model}` : d.provider, d.lane, d.reason, d.error, d.host]
    .find((v) => typeof v === 'string' && v);
  return pick ? pick.slice(0, 120) : '';
}

const PAGE = 100;

export function AuditView({ embedded = false }) {
  const [events, setEvents] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cat, setCat] = useState('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(null);

  const load = async (append = false) => {
    setLoading(true);
    setError(null);
    const res = await sendCmd('audit_tail', { n: PAGE, before: append ? events.length : 0 });
    if (res.success) {
      const evs = Array.isArray(res.data) ? res.data : (res.data?.events ?? []);
      // 新的在上
      const page = [...evs].reverse();
      setEvents((prev) => (append ? [...prev, ...page] : page));
      setHasMore(Boolean(res.data?.hasMore));
    } else {
      setError(res.error || '读取事件记录失败');
      if (!append) setEvents([]);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const q = query.trim().toLowerCase();
  const filtered = events.filter((e) => {
    if (cat !== 'all' && categoryOf(e.kind) !== cat) return false;
    if (q && !`${e.kind} ${summarize(e)}`.toLowerCase().includes(q)) return false;
    return true;
  });

  return (
    <div className={cn('flex-1 flex flex-col overflow-hidden text-xs text-main', !embedded && 'bg-app')}>
      <div className="px-6 py-3 border-b border-[var(--border)] shrink-0">
        <div className="max-w-3xl mx-auto flex items-center gap-2 flex-wrap">
          {[{ label: '全部' }, ...CATEGORIES, { label: '其他' }].map((c) => {
            const id = c.label === '全部' ? 'all' : c.label;
            return (
              <button
                key={id}
                onClick={() => setCat(id)}
                aria-pressed={cat === id}
                className={cn(
                  'px-2.5 py-1 rounded-full text-[11px] border transition-colors',
                  cat === id
                    ? 'bg-[var(--accent-glow)] border-[var(--accent)]/50 text-main font-medium'
                    : 'border-[var(--border)] text-sub hover:text-main'
                )}
              >
                {c.label}
              </button>
            );
          })}
          <span className="flex-1" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索…"
            aria-label="搜索事件记录"
            className="w-40 px-2.5 py-1 bg-[var(--bg)] border border-[var(--border-strong)] focus:border-[var(--accent)] rounded-lg text-xs text-main outline-none"
          />
          <button
            onClick={() => load()}
            className="p-1.5 rounded hover:bg-[var(--border)] text-sub hover:text-main transition-colors"
            title="刷新"
            aria-label="刷新事件记录"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="max-w-3xl mx-auto">
          {error && <div className="mb-3 text-[var(--red-text)]">{error}</div>}
          {!filtered.length && !loading && !error && (
            <div className="p-10 text-center text-muted">{events.length ? '没有符合条件的记录' : '还没有事件记录'}</div>
          )}
          <ul className="rounded-xl border border-[var(--border)] bg-[var(--bg-elev)] divide-y divide-[var(--border)] overflow-hidden">
            {filtered.map((ev, idx) => {
              const key = `${ev.ts}-${idx}`;
              const isOpen = open === key;
              return (
                <li key={key}>
                  <button
                    onClick={() => setOpen(isOpen ? null : key)}
                    aria-expanded={isOpen}
                    className="w-full px-3 py-2 flex items-center gap-3 text-left hover:bg-[var(--bg-side)] transition-colors"
                  >
                    <ChevronRight className={cn('w-3 h-3 text-muted shrink-0 transition-transform', isOpen && 'rotate-90')} />
                    <span className="w-28 shrink-0 text-[10px] font-mono text-muted">
                      {ev.ts ? new Date(ev.ts).toLocaleString() : '时间未知'}
                    </span>
                    <span className="w-16 shrink-0 text-[11px] text-sub">{categoryOf(ev.kind)}</span>
                    <span className="flex-1 min-w-0 truncate text-[11px] text-main">
                      <span className="font-mono text-muted mr-2">{ev.kind || 'EVENT'}</span>
                      {summarize(ev)}
                    </span>
                  </button>
                  {isOpen && (
                    <pre className="mx-3 mb-3 p-2.5 rounded-lg bg-[var(--bg)] border border-[var(--border)] text-[11px] font-mono text-sub whitespace-pre-wrap break-all">
                      {typeof ev.data === 'string' ? ev.data : JSON.stringify(ev.data ?? {}, null, 2)}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
          {hasMore && (
            <button
              onClick={() => load(true)}
              disabled={loading}
              className="mt-3 w-full py-2 text-[11px] text-sub hover:text-main border border-[var(--border)] rounded-lg transition-colors disabled:opacity-60"
            >
              {loading ? '加载中…' : '加载更早的记录'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

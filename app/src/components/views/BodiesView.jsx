import React, { useState, useEffect } from 'react';
import { Cpu, Check, AlertCircle, ArrowRight, RefreshCw, ChevronRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import { sendCmd, subscribeEvents } from '../../lib/api';

// 能力名人话化：引擎差异要让主人看得懂"换过去会少什么"，不是甩内部标记
const CAP_LABEL = {
  final_post_extension_guard: '扩展后的最终安全复核',
  canonical_prediction_binding: '认知预测绑定',
  loop_observability: '执行过程可观测',
  provider_request_audit: '模型请求审计',
  compaction_governance: '上下文压缩受治理',
  durable_jobs: '后台任务可持久',
  mcp_native: '原生 MCP 工具',
  agent_loop: '自主执行循环',
  tool_surface: '工具调用',
  web_ui: '自带网页界面',
  channels: '多通道接入',
  tool_decide: '工具调用审批',
  schema_revalidation: '参数二次校验',
  deny_hide: '拒绝工具不可见',
  fileops_guard: '文件改动可撤销',
  audit: '审计记录',
  compaction_hooks: '压缩钩子',
  continuation_steer: '执行中追加指示',
  usage_accounting: '用量记账',
};
const LEVEL = { supported: 2, partial: 1, unsupported: 0 };
const LEVEL_LABEL = { supported: '支持', partial: '部分', unsupported: '不支持' };

const PHASE = {
  prepared: '准备', quiesced: '暂停当前活动', checkpointed: '保存进度',
  released: '交出控制权', acquired: '新引擎接管', resumed: '恢复会话', verified: '核对完成',
};

function capsOf(b) {
  return { ...(b?.facts?.verified_capabilities ?? {}), ...(b?.facts?.governance_coverage ?? {}) };
}

function formatReason(r) {
  if (!r) return '';
  if (r.includes('final_post_extension_guard') || r.includes('unsupported on body dsh')) {
    return 'DSH 缺少扩展后复合安全复核，属于生产任务安全门禁阻断 (fail-closed)';
  }
  if (r.includes('provider_request_audit')) {
    return '缺少统一模型请求审计支持';
  }
  return r;
}

/**
 * AI 引擎：回答"现在用的是哪个、能不能换、换了会少什么"。
 * 嵌在设置的「AI 引擎」页签里（低频操作），顶栏引擎 chip 直达。
 */
export function BodiesView({ embedded = false }) {
  const [bodies, setBodies] = useState([]);
  const [currentBodyId, setCurrentBodyId] = useState(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState(null);
  const [phase, setPhase] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchBodies = async () => {
    setLoading(true);
    setError(null);
    const [listRes, curRes] = await Promise.all([sendCmd('body_list'), sendCmd('body_current')]);
    if (listRes.success) {
      const list = Array.isArray(listRes.data) ? listRes.data : (listRes.data?.bodies ?? []);
      setBodies(list);
      const act = list.find((b) => b.current);
      if (act) setCurrentBodyId(act.body_id);
    } else {
      setError(listRes.error || '读取引擎列表失败');
      setBodies([]);
    }
    if (curRes.success && curRes.data?.body_id) {
      setCurrentBodyId(curRes.data.body_id);
      if (curRes.data.switching) setSwitching(true);
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchBodies();
    const unsub = subscribeEvents((rec) => {
      if (rec.type !== 'supervisor') return;
      const ev = rec.event;
      const kind = ev?.kind;
      if (kind === 'handoff_phase' || kind === 'HANDOFF_PHASE') {
        const p = ev.phase;
        if (p === 'verified' || p === 'HANDOFF_COMPLETED') {
          setSwitching(false); setPhase(null); fetchBodies();
        } else if (p === 'failed' || p === 'HANDOFF_FAILED') {
          setSwitching(false); setPhase(null);
          setError(`切换失败：${ev.reason || ev.error || '已回退到原引擎'}`);
          fetchBodies();
        } else {
          setPhase(PHASE[p] ?? p);
        }
      } else if (kind === 'select_done' || kind === 'SELECT_DONE') {
        setSwitching(false); setPhase(null); fetchBodies();
      } else if (kind === 'select_failed' || kind === 'SELECT_FAILED') {
        setSwitching(false); setPhase(null);
        setError(`切换失败：${ev.error || '已回退到原引擎'}`);
        fetchBodies();
      } else if (kind === 'select_start' || kind === 'SELECT_START') {
        setSwitching(true);
      } else if (kind === 'body_exited') {
        if (!ev.expected) {
          setError('引擎意外退出，正在自动重启…');
        }
        fetchBodies();
      } else if (kind === 'body_respawned' || kind === 'body_started') {
        setError(null); fetchBodies();
      }
    });
    return () => unsub();
  }, []);

  const handleSwitch = async (targetId) => {
    if (!targetId || targetId === currentBodyId || switching) return;
    setSwitching(true);
    setError(null);
    setPhase('请求切换');
    const res = await sendCmd('body_select', { body_id: targetId });
    if (res.success) {
      await fetchBodies();
    } else {
      setError(`切换被拒绝：${res.error || '未知原因'}`);
    }
    setSwitching(false);
    setPhase(null);
  };

  const current = bodies.find((b) => (b.body_id || b.id) === currentBodyId);
  const curCaps = capsOf(current);

  return (
    <div className={cn('text-xs text-main', !embedded && 'flex-1 overflow-y-auto p-6')}>
      <div className={cn(!embedded && 'max-w-3xl mx-auto')}>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-sm font-bold text-main mb-1">AI 引擎</h2>
            <p className="text-muted text-[11px]">执行任务的底层引擎。换引擎会保留当前会话并核对接管结果。</p>
          </div>
          <button
            onClick={fetchBodies}
            className="shrink-0 p-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] hover:bg-[var(--bg-card)] text-sub hover:text-main transition-colors"
            title="刷新"
            aria-label="刷新引擎状态"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[var(--red-text)] flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-muted hover:text-main" aria-label="关闭">✕</button>
          </div>
        )}

        {switching && (
          <div className="mb-4 p-3 rounded-lg bg-[var(--accent-glow)] border border-[var(--accent)]/40 flex items-center gap-2">
            <RefreshCw className="w-3.5 h-3.5 animate-spin text-[var(--accent)]" />
            <span>正在切换引擎{phase ? `：${phase}` : '…'}</span>
          </div>
        )}

        {bodies.length === 0 ? (
          <div className="p-8 text-center text-muted rounded-xl border border-dashed border-[var(--border-strong)]">
            {loading ? '正在读取…' : '没有发现可用的 AI 引擎'}
          </div>
        ) : (
          <div className="space-y-3">
            {bodies.map((b) => {
              const id = b.body_id || b.id;
              const isActive = id === currentBodyId || b.current;
              const installed = Boolean(b.installed);
              const eligible = Boolean(b.eligibility?.eligible);
              const reason = b.eligibility?.failClosed?.[0]?.reason || b.install_hint;
              const caps = capsOf(b);
              // 换过去会变弱的能力：相对当前引擎
              const weaker = isActive ? [] : Object.keys(CAP_LABEL)
                .filter((k) => k in curCaps && k in caps && (LEVEL[caps[k]] ?? 0) < (LEVEL[curCaps[k]] ?? 0));
              const allCaps = Object.keys(caps).filter((k) => CAP_LABEL[k]);

              return (
                <div
                  key={id}
                  data-body={id}
                  className={cn(
                    'p-4 rounded-xl border bg-[var(--bg-elev)] shadow-card',
                    isActive ? 'border-[var(--accent)]' : 'border-[var(--border)]'
                  )}
                >
                  <div className="flex items-center gap-3">
                    <Cpu className={cn('w-5 h-5 shrink-0', isActive ? 'text-[var(--accent)]' : 'text-muted')} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-main text-sm">{b.label || id}</h3>
                        {isActive && (
                          <span className="flex items-center gap-1 px-1.5 py-px rounded bg-emerald-500/15 text-[var(--green-text)] text-[10px] font-medium">
                            <Check className="w-3 h-3" />正在使用
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] mt-0.5">
                        {!installed ? (
                          <span className="text-[var(--amber-text)]">未安装{reason ? `：${reason}` : ''}</span>
                        ) : !eligible ? (
                          <span className="text-[var(--amber-text)]">当前不能作为主执行引擎{reason ? `：${formatReason(reason)}` : ''}</span>
                        ) : isActive ? (
                          <span className="text-sub">正在执行你的任务</span>
                        ) : weaker.length ? (
                          <span className="text-sub">
                            可以切换；换过去会弱化：{weaker.slice(0, 3).map((k) => CAP_LABEL[k]).join('、')}
                            {weaker.length > 3 ? ` 等 ${weaker.length} 项` : ''}
                          </span>
                        ) : (
                          <span className="text-sub">可以切换，能力不弱于当前引擎</span>
                        )}
                      </div>
                    </div>
                    {!isActive && (
                      <button
                        onClick={() => handleSwitch(id)}
                        disabled={switching || !eligible || !installed}
                        className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#4f58c7] hover:bg-[#4338ca] disabled:bg-[var(--border)] disabled:text-muted disabled:cursor-not-allowed text-white text-xs font-medium transition-colors"
                      >
                        切换到 {b.label || id}
                        <ArrowRight className="w-3 h-3" />
                      </button>
                    )}
                  </div>

                  {allCaps.length > 0 && (
                    <details className="mt-3 group">
                      <summary className="list-none cursor-pointer flex items-center gap-1 text-[11px] text-muted hover:text-sub">
                        <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" />
                        能力明细
                      </summary>
                      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
                        {allCaps.map((k) => (
                          <div key={k} className="flex items-center justify-between text-[11px]">
                            <span className="text-sub">{CAP_LABEL[k]}</span>
                            <span className={cn(
                              caps[k] === 'supported' ? 'text-[var(--green-text)]'
                                : caps[k] === 'partial' ? 'text-[var(--amber-text)]' : 'text-muted'
                            )}>
                              {LEVEL_LABEL[caps[k]] ?? String(caps[k])}
                            </span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import { Palette, ShieldCheck, ShieldAlert, Zap, AlertCircle, Check, ChevronDown, RefreshCw, Bot } from 'lucide-react';
import { cn } from '../../lib/utils';
import { sendCmd } from '../../lib/api';

const RISK_LABEL = {
  benign: '常规操作',
  mutating: '改文件',
  destructive: '删除/覆盖',
  network: '联网',
  privilege: '提权',
  exec: '执行命令',
  unknown: '未识别的操作',
};
const ACTION_LABEL = { allow: '直接放行', deny: '一律拒绝', ask: '先问我' };
const ACTION_TONE = {
  allow: 'text-[var(--green-text)]',
  deny: 'text-[var(--red-text)]',
  ask: 'text-[var(--amber-text)]',
};

const SECURITY_MODES = [
  {
    id: 'manual',
    title: '人工确认审批',
    badge: '默认推荐',
    badgeTone: 'bg-[var(--border)] text-sub',
    icon: ShieldAlert,
    iconTone: 'text-amber-400',
    desc: '高危操作（文件删除/修改、系统提权、命令执行）将弹出确认卡片，由您审查后放行。',
  },
  {
    id: 'full_access',
    title: '完全访问（免审批）',
    badge: '全自动化',
    badgeTone: 'bg-amber-500/15 text-[var(--amber-text)] border-amber-500/30',
    icon: Zap,
    iconTone: 'text-[var(--amber-text)]',
    desc: '直接放行全部工具调用与命令执行，任务零阻塞全自动连续推进，适用于可信沙箱环境。',
  },
  {
    id: 'auto_review',
    title: '自动审查（智能风控）',
    badge: '模型托管',
    badgeTone: 'bg-[var(--accent-glow)] text-[var(--accent-text)] border-[var(--accent)]/30',
    icon: ShieldCheck,
    iconTone: 'text-[var(--accent)]',
    desc: '操作交由指定的安全审查模型实时评估意图与破坏性，校验安全后自动放行执行。',
  },
];

/**
 * 设置：纯粹的全局环境偏好（外观、安全规则）。
 * 项目管理统一在左侧侧栏，AI 引擎统一在右上角，模型统一在模型管理。
 */
export function SettingsView({ initialTab = null, availableModels = [] }) {
  const [activeTab, setActiveTab] = useState(
    initialTab && ['appearance', 'security'].includes(initialTab) ? initialTab : 'appearance'
  );
  const [policy, setPolicy] = useState(null);
  const [policyError, setPolicyError] = useState(null);
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('pai_theme') || 'dark';
    } catch {
      return 'dark';
    }
  });

  // 安全模式与审查模型状态
  const [securityMode, setSecurityMode] = useState(() => {
    try {
      return localStorage.getItem('pai_security_mode') || 'manual';
    } catch {
      return 'manual';
    }
  });

  const [autoReviewModel, setAutoReviewModel] = useState(() => {
    try {
      return localStorage.getItem('pai_auto_review_model') || '';
    } catch {
      return '';
    }
  });

  const [modelsList, setModelsList] = useState(availableModels || []);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saveTip, setSaveTip] = useState(false);

  const tabs = [
    { id: 'appearance', label: '外观', icon: Palette },
    { id: 'security', label: '安全规则', icon: ShieldCheck },
  ];

  // 读取底层策略
  useEffect(() => {
    if (activeTab !== 'security') return;
    if (!policy) {
      sendCmd('policy_status').then((r) => {
        if (r.success && r.data) {
          setPolicy(r.data);
          setPolicyError(null);
        } else {
          setPolicyError(r.error || '读取安全规则失败');
        }
      });
    }

    // 获取可用审查模型列表
    fetchModels();
  }, [activeTab]);

  const fetchModels = async () => {
    setLoadingModels(true);
    try {
      const res = await sendCmd('model_list');
      if (res.success && Array.isArray(res.data?.models)) {
        setModelsList(res.data.models);
        // 如果当前未设置审查模型，自动选择第一个可用模型
        if (!autoReviewModel && res.data.models.length > 0) {
          const first = res.data.models[0].id || res.data.models[0].name;
          setAutoReviewModel(first);
          try {
            localStorage.setItem('pai_auto_review_model', first);
          } catch {}
        }
      }
    } catch (err) {
      console.warn('获取模型列表失败:', err);
    } finally {
      setLoadingModels(false);
    }
  };

  const handleSetTheme = (t) => {
    setTheme(t);
    try {
      localStorage.setItem('pai_theme', t);
      document.documentElement.classList.toggle('light', t === 'light');
      document.documentElement.classList.toggle('dark', t !== 'light');
      document.documentElement.setAttribute('data-theme', t);
    } catch {}
  };

  const handleSelectSecurityMode = (mode) => {
    setSecurityMode(mode);
    try {
      localStorage.setItem('pai_security_mode', mode);
      window.dispatchEvent(
        new CustomEvent('pai_security_policy_change', {
          detail: { mode, reviewModel: autoReviewModel },
        })
      );
    } catch {}
    triggerSaved();
  };

  const handleSelectReviewModel = (modelId) => {
    setAutoReviewModel(modelId);
    try {
      localStorage.setItem('pai_auto_review_model', modelId);
      window.dispatchEvent(
        new CustomEvent('pai_security_policy_change', {
          detail: { mode: securityMode, reviewModel: modelId },
        })
      );
    } catch {}
    triggerSaved();
  };

  const triggerSaved = () => {
    setSaveTip(true);
    setTimeout(() => setSaveTip(false), 2000);
  };

  const riskRows = Object.entries(policy?.riskActions ?? {});
  const denied = policy?.deniedTools ?? [];
  const b = policy?.budget;
  const budgetParts = b
    ? [
        b.maxTokensPerSession && `每会话 ${b.maxTokensPerSession} tokens`,
        b.maxCostPerSessionUsd && `每会话 $${b.maxCostPerSessionUsd}`,
        b.maxCallsPerSession && `每会话 ${b.maxCallsPerSession} 次调用`,
      ].filter(Boolean)
    : [];

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* 左侧设置导航 */}
      <div className="w-48 border-r border-[var(--border)] bg-[var(--bg-side)] text-main p-3 space-y-1 shrink-0 select-none">
        <h3 className="px-2 pt-1 pb-2 text-[11px] font-semibold text-muted uppercase tracking-wider">
          系统设置
        </h3>
        {tabs.map((t) => {
          const Icon = t.icon;
          const sel = activeTab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={cn(
                'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition-colors',
                sel
                  ? 'bg-[var(--bg)] text-main font-semibold border border-[var(--border-strong)] shadow-sm'
                  : 'text-sub hover:bg-[var(--bg)] hover:text-main border border-transparent'
              )}
            >
              <Icon className="w-4 h-4 text-sub" />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* 右侧设置主内容 */}
      <div className="flex-1 overflow-y-auto p-6 text-xs text-main bg-app">
        <div className="max-w-2xl space-y-6">
          {activeTab === 'appearance' && (
            <>
              <div>
                <h2 className="text-sm font-bold text-main mb-1">外观</h2>
                <p className="text-muted text-[11px]">自定义客户端界面主题显示风格。</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { id: 'dark', name: '深色', desc: '暗色背景，适合长时间使用' },
                  { id: 'light', name: '浅色', desc: '明亮背景，适合光线充足的环境' },
                ].map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => handleSetTheme(t.id)}
                    aria-pressed={theme === t.id}
                    className={cn(
                      'p-3.5 rounded-xl border text-left transition-colors bg-[var(--bg-elev)] cursor-pointer',
                      theme === t.id
                        ? 'border-[var(--accent)] shadow-sm'
                        : 'border-[var(--border)] hover:border-[var(--border-strong)]'
                    )}
                  >
                    <span className="font-semibold text-main block mb-0.5">{t.name}</span>
                    <span className="text-[11px] text-muted">{t.desc}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          {activeTab === 'security' && (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-sm font-bold text-main mb-1">安全规则与风控模式</h2>
                  <p className="text-muted text-[11px]">
                    控制 AI 执行命令、调用工具以及改动文件时的治理放行机制。
                  </p>
                </div>
                {saveTip && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 animate-in fade-in">
                    <Check className="w-3 h-3" /> 已保存生效
                  </span>
                )}
              </div>

              {/* 核心模式选择单选卡片 */}
              <div className="space-y-3">
                <div className="text-[11px] font-semibold text-muted uppercase tracking-wider">
                  执行治理模式
                </div>
                <div className="grid grid-cols-1 gap-2.5">
                  {SECURITY_MODES.map((mode) => {
                    const Icon = mode.icon;
                    const isSelected = securityMode === mode.id;

                    return (
                      <div
                        key={mode.id}
                        onClick={() => handleSelectSecurityMode(mode.id)}
                        className={cn(
                          'p-3.5 rounded-xl border text-left transition-all cursor-pointer relative',
                          isSelected
                            ? 'bg-[var(--bg-elev)] border-[var(--accent)] shadow-sm ring-1 ring-[var(--accent)]/30'
                            : 'bg-[var(--bg-elev)]/50 border-[var(--border)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-elev)]'
                        )}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3">
                            <div
                              className={cn(
                                'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 bg-[var(--bg-card)] border border-[var(--border)]',
                                isSelected ? mode.iconTone : 'text-muted'
                              )}
                            >
                              <Icon className="w-4 h-4" />
                            </div>
                            <div className="space-y-0.5">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-main text-xs">{mode.title}</span>
                                <span
                                  className={cn(
                                    'text-[10px] px-1.5 py-0.2 rounded border font-medium',
                                    mode.badgeTone
                                  )}
                                >
                                  {mode.badge}
                                </span>
                              </div>
                              <p className="text-[11px] text-muted leading-relaxed">{mode.desc}</p>
                            </div>
                          </div>

                          <div className="shrink-0 mt-1">
                            <div
                              className={cn(
                                'w-4 h-4 rounded-full border flex items-center justify-center transition-colors',
                                isSelected
                                  ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                                  : 'border-muted/50 bg-transparent'
                              )}
                            >
                              {isSelected && <Check className="w-2.5 h-2.5 stroke-[3]" />}
                            </div>
                          </div>
                        </div>

                        {/* 自动审查模式下的模型选择下拉框 */}
                        {mode.id === 'auto_review' && isSelected && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className="mt-3.5 pt-3.5 border-t border-[var(--border)] space-y-2 animate-in fade-in duration-200"
                          >
                            <div className="flex items-center justify-between">
                              <label
                                htmlFor="review-model-select"
                                className="text-[11px] font-medium text-main flex items-center gap-1.5"
                              >
                                <Bot className="w-3.5 h-3.5 text-[var(--accent)]" />
                                审查模型（下拉选择）：
                              </label>
                              <button
                                type="button"
                                onClick={fetchModels}
                                disabled={loadingModels}
                                className="text-[11px] text-sub hover:text-main flex items-center gap-1 hover:underline disabled:opacity-50"
                                title="刷新可用模型列表"
                              >
                                <RefreshCw className={cn('w-3 h-3', loadingModels && 'animate-spin')} />
                                刷新列表
                              </button>
                            </div>

                            <div className="relative">
                              <select
                                id="review-model-select"
                                value={autoReviewModel}
                                onChange={(e) => handleSelectReviewModel(e.target.value)}
                                className="w-full px-3 py-2 bg-[var(--bg)] border border-[var(--border-strong)] focus:border-[var(--accent)] rounded-lg text-xs text-main outline-none appearance-none cursor-pointer pr-8 font-mono shadow-xs"
                              >
                                {modelsList.length === 0 ? (
                                  <>
                                    <option value="gemini-2.5-flash">gemini-2.5-flash（默认快速模型）</option>
                                    <option value="claude-3-5-sonnet">claude-3-5-sonnet</option>
                                    <option value="gpt-4o">gpt-4o</option>
                                    <option value="deepseek-chat">deepseek-chat</option>
                                  </>
                                ) : (
                                  modelsList.map((m) => {
                                    const val = m.id || m.name;
                                    const label = m.name ? `${m.name} (${m.provider || 'default'})` : val;
                                    return (
                                      <option key={val} value={val}>
                                        {label}
                                      </option>
                                    );
                                  })
                                )}
                              </select>
                              <ChevronDown className="w-4 h-4 text-muted absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                            </div>
                            <p className="text-[10px] text-muted leading-normal">
                              当产生高危或写操作审批时，系统将使用该模型自动执行快速意图审计，放行可信操作。
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 底层策略文件规则（展示本机 policy.json 基准） */}
              <div className="space-y-2 pt-2">
                <div className="text-[11px] font-semibold text-muted uppercase tracking-wider">
                  底层策略基准 (policy.json)
                </div>

                {policyError ? (
                  <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[var(--red-text)] flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{policyError}</span>
                  </div>
                ) : !policy ? (
                  <div className="text-muted py-2">读取底层策略中…</div>
                ) : (
                  <div className="rounded-xl bg-[var(--bg-elev)] border border-[var(--border)] shadow-xs divide-y divide-[var(--border)]">
                    {riskRows.map(([risk, act]) => (
                      <div key={risk} className="px-4 py-2 flex items-center justify-between">
                        <span className="text-main">{RISK_LABEL[risk] ?? risk}</span>
                        <span className={cn('font-medium', ACTION_TONE[act] ?? 'text-sub')}>
                          {ACTION_LABEL[act] ?? act}
                        </span>
                      </div>
                    ))}
                    {!riskRows.length && <div className="px-4 py-2 text-muted">没有按风险分类的规则</div>}
                    <div className="px-4 py-2 flex items-center justify-between gap-4">
                      <span className="text-main shrink-0">禁用的工具</span>
                      <span className="text-sub text-right">{denied.length ? denied.join('、') : '无'}</span>
                    </div>
                    <div className="px-4 py-2 flex items-center justify-between gap-4">
                      <span className="text-main shrink-0">用量上限</span>
                      <span className="text-sub text-right">
                        {budgetParts.length ? budgetParts.join(' · ') : '不设上限（用量仍全部记账）'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

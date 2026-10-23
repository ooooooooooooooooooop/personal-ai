import React, { useState, useEffect, useCallback } from 'react';
import {
  Boxes, RefreshCw, Plus, Trash2, Check, AlertCircle, Cpu, Eye, EyeOff, Star,
} from 'lucide-react';
import { cn, isPrivateBaseUrl } from '../../lib/utils';
import { sendCmd } from '../../lib/api';

/**
 * 模型管理（一级页面）：提供方与模型的真实控制台。
 * 列表/删除/设为默认在主页直接完成；"添加"只是一个入口——
 * 实际添加（配置提供方 → 拉取目录 → 勾选 → 批量入库）在展开的添加面板里完成。
 * 所有数据来自 model_status/model_list，不接受任何写死占位。
 */
export function ModelsView() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [providers, setProviders] = useState([]);
  const [current, setCurrent] = useState(null);
  const [notice, setNotice] = useState(null); // {kind:'ok'|'err', text}
  const [confirmDelete, setConfirmDelete] = useState(null); // `${provider}/${id}`
  const [confirmDeleteProvider, setConfirmDeleteProvider] = useState(null); // providerId
  const [busyKey, setBusyKey] = useState(null);

  // 添加面板（入口 → 具体表单）
  const [panelOpen, setPanelOpen] = useState(false);
  const [pProvider, setPProvider] = useState('');
  const [pBaseUrl, setPBaseUrl] = useState('');
  const [pApi, setPApi] = useState('openai-completions');
  const [pKey, setPKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [pAllowPrivate, setPAllowPrivate] = useState(false);
  const [pCompat, setPCompat] = useState('default');
  const [pingState, setPingState] = useState(null); // {ok, text}
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [fetched, setFetched] = useState([]);
  const [picked, setPicked] = useState(() => new Set());
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const st = await sendCmd('model_status');
      if (st.success && st.data) {
        setProviders(Array.isArray(st.data.providers) ? st.data.providers : []);
        setCurrent(st.data.current ?? null);
      } else {
        setError(st.error || '模型状态读取失败');
        setProviders([]);
      }
    } catch (e) {
      setError(e?.message || '模型状态读取失败');
      setProviders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // "我的提供方"：已配置凭据的、OAuth 的、或指向本机/内网的自托管端点。
  // 内网但无凭据的也要列出——那正是需要补凭据的半成品配置（2026-10-19 cpa 案例）。
  // 已清空全部模型的提供方（如删除所有 Anthropic 预置模型后）不在此占位。
  const myProviders = providers.filter(
    (p) => (p.hasAuth || p.oauth || isPrivateBaseUrl(p.baseUrl || '')) &&
      ((p.models && p.models.length > 0) || isPrivateBaseUrl(p.baseUrl || ''))
  );

  const isCurrent = (p, m) => current && current.provider === p && (current.id === m || current.model === m);

  const handleSetDefault = async (providerId, modelId) => {
    const key = `set:${providerId}/${modelId}`;
    setBusyKey(key);
    setNotice(null);
    try {
      const r = await sendCmd('model_set', { provider: providerId, model: modelId });
      if (r.success) {
        setNotice({ kind: 'ok', text: `默认模型已切换为 ${providerId}/${modelId}` });
        await load();
      } else {
        setNotice({ kind: 'err', text: `切换失败：${r.error || '请求未被接受'}` });
      }
    } finally {
      setBusyKey(null);
    }
  };

  const handleDelete = async (providerId, modelId) => {
    const key = `${providerId}/${modelId}`;
    if (confirmDelete !== key) {
      setConfirmDelete(key);
      return;
    }
    setConfirmDelete(null);
    setBusyKey(`del:${key}`);
    setNotice(null);
    try {
      const r = await sendCmd('provider_model_delete', { provider: providerId, model: modelId });
      if (r.success && r.data?.ok !== false) {
        setNotice({ kind: 'ok', text: `已删除模型 ${key}` });
        await load();
      } else {
        setNotice({ kind: 'err', text: `删除失败：${r.error || r.data?.error || '请求未被接受'}` });
      }
    } finally {
      setBusyKey(null);
    }
  };

  const handleDeleteProvider = async (providerId) => {
    if (confirmDeleteProvider !== providerId) {
      setConfirmDeleteProvider(providerId);
      return;
    }
    setConfirmDeleteProvider(null);
    setBusyKey(`delprov:${providerId}`);
    setNotice(null);
    try {
      const r = await sendCmd('provider_delete', { provider: providerId });
      if (r.success && r.data?.ok !== false) {
        setNotice({ kind: 'ok', text: `已删除提供方 ${providerId}` });
        await load();
      } else {
        setNotice({ kind: 'err', text: `删除失败：${r.error || r.data?.error || '请求未被接受'}` });
      }
    } finally {
      setBusyKey(null);
    }
  };

  const resetFetch = () => {
    setFetched([]);
    setPicked(new Set());
    setFetchError(null);
    setPingState(null);
  };

  const handlePing = async () => {
    setPingState(null);
    const r = await sendCmd('model_ping', {
      provider: pProvider,
      ...(pKey && !pKey.startsWith('$') ? { key: pKey } : {}),
      ...(pBaseUrl ? { baseUrl: pBaseUrl } : {}),
    });
    const d = r.data ?? {};
    if (r.success && d.ok !== false && d.reachable !== false) {
      setPingState({ ok: true, text: `连接正常${d.ms != null ? ` · ${d.ms}ms` : ''}` });
    } else {
      setPingState({ ok: false, text: `连接失败：${d.error || r.error || `HTTP ${d.httpStatus ?? '?'}`}` });
    }
  };

  const handleFetch = async () => {
    if (!pProvider || fetching) return;
    setFetching(true);
    setFetchError(null);
    try {
      const r = await sendCmd('provider_models_fetch', {
        provider: pProvider,
        ...(pBaseUrl ? { baseUrl: pBaseUrl } : {}),
        ...(pKey && !pKey.startsWith('$') ? { key: pKey } : {}),
      });
      const d = r.data ?? {};
      if (!r.success || d.ok === false) {
        const raw = String(d.error || r.error || '请求未被接受');
        const hint = /403|private|loopback|私有|内网/i.test(raw)
          ? ' — 若这是本机/内网端点，请先勾选「允许私有网络地址」重试'
          : '';
        setFetchError(`拉取失败：${raw}${hint}`);
        setFetched([]);
        return;
      }
      const ids = Array.isArray(d.models) ? d.models : [];
      const det = d.details ?? {};
      setFetched(ids.map((id) => ({ id, ...(det[id] ?? {}) })));
      setPicked(new Set());
      if (!ids.length) setFetchError('端点返回了空的模型列表');
    } catch (e) {
      setFetchError(`拉取失败：${e?.message ?? e}`);
    } finally {
      setFetching(false);
    }
  };

  const togglePicked = (id) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSaveProvider = async () => {
    if (!pProvider || saving) return;
    setSaving(true);
    setNotice(null);
    const isMoonshot = /(kimi|moonshot|k3)\b/i.test(pProvider);
    const compatDecl = pCompat === 'no-developer-role' || isMoonshot ? { supportsDeveloperRole: false } : null;
    const exists = myProviders.some((p) => p.id === pProvider);
    try {
      // 1. 密钥（本地无鉴权代理留空即可——占位由 auth 链处理）
      if (pKey && !pKey.startsWith('$')) {
        const rk = await sendCmd('auth_set_key', { provider: pProvider, key: pKey });
        if (!rk.success || rk.data?.hasAuth === false) {
          setNotice({ kind: 'err', text: `密钥保存失败：${rk.error || rk.data?.error || '被拒绝'}` });
          return;
        }
      }
      // 2. 已存在的提供方走批量添加；新提供方走 provider_add 一并登记连接配置
      const pickedIds = [...picked];
      const details = {};
      for (const id of pickedIds) {
        const f = fetched.find((x) => x.id === id);
        if (!f) continue;
        const modelIsMoonshot = isMoonshot || /(kimi|moonshot|k3)\b/i.test(id);
        const effectiveCompat = compatDecl || (modelIsMoonshot ? { supportsDeveloperRole: false } : null);
        details[id] = {
          ...(f.contextWindow ? { contextWindow: f.contextWindow } : {}),
          ...(f.maxTokens ? { maxTokens: f.maxTokens } : {}),
          ...(f.reasoning !== undefined ? { reasoning: f.reasoning } : {}),
          ...(effectiveCompat ? { compat: effectiveCompat } : {}),
        };
      }
      if (exists) {
        if (pickedIds.length) {
          const ra = await sendCmd('provider_models_add', {
            provider: pProvider,
            models: pickedIds,
            ...(Object.keys(details).length ? { modelDetails: details } : {}),
          });
          if (!ra.success || ra.data?.ok === false) {
            setNotice({ kind: 'err', text: `批量添加失败：${ra.error || ra.data?.error || '被拒绝'}` });
            return;
          }
        }
      } else {
        if (!pBaseUrl) {
          setNotice({ kind: 'err', text: '新提供方需要填写 Base URL' });
          return;
        }
        if (!pickedIds.length) {
          setNotice({ kind: 'err', text: '请先拉取目录并至少勾选 1 个模型' });
          return;
        }
        const rp = await sendCmd('provider_add', {
          provider: pProvider,
          baseUrl: pBaseUrl,
          api: pApi,
          model: pickedIds[0],
          models: pickedIds,
          ...(Object.keys(details).length ? { modelDetails: details } : {}),
          ...(pAllowPrivate ? { allowPrivateNetwork: true } : {}),
          ...(compatDecl ? { compat: compatDecl } : {}),
        });
        if (!rp.success || rp.data?.ok === false) {
          setNotice({ kind: 'err', text: `提供方保存失败：${rp.error || rp.data?.error || '被拒绝'}` });
          return;
        }
      }
      setNotice({ kind: 'ok', text: `已保存 ${pProvider}${pickedIds.length ? `，入库 ${pickedIds.length} 个模型` : ''}` });
      setPanelOpen(false);
      resetFetch();
      setPKey('');
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6 text-xs text-main bg-app">
      <div className="max-w-3xl mx-auto space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-main mb-1 flex items-center gap-2">
              <Boxes className="w-4 h-4 text-[var(--accent)]" />
              模型管理
            </h2>
            <p className="text-muted text-[11px]">
              提供方与模型的真实控制台：数据全部来自运行时状态，删除需二次确认。
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={load}
              className="p-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] hover:bg-[var(--bg-card)] text-sub hover:text-main transition-colors"
              title="刷新"
              aria-label="刷新模型状态"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
            </button>
            <button
              id="models-add-toggle"
              type="button"
              onClick={() => setPanelOpen((v) => !v)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#4f58c7] hover:bg-[#4338ca] text-white text-xs font-medium transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{panelOpen ? '收起添加面板' : '添加提供方 / 模型'}</span>
            </button>
          </div>
        </div>

        {notice && (
          <div className={cn(
            'p-2.5 rounded-lg border text-[11px] flex items-center gap-1.5',
            notice.kind === 'ok'
              ? 'bg-emerald-500/10 border-emerald-500/30 text-[var(--green-text)]'
              : 'bg-rose-500/10 border-rose-500/30 text-[var(--red-text)]'
          )}>
            {notice.kind === 'ok' ? <Check className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
            <span>{notice.text}</span>
          </div>
        )}

        {error && (
          <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[var(--red-text)] flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            <span>{error}</span>
          </div>
        )}

        {/* 当前生效 */}
        <div className="p-4 rounded-xl bg-[var(--bg-elev)] border border-[var(--border)] shadow-card">
          <div className="text-[11px] text-muted mb-1.5">当前生效模型</div>
          {current ? (
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-[var(--accent)]" />
              <span className="font-mono text-sm text-main">{current.provider}/{current.id ?? current.model}</span>
              {current.reasoning === true && (
                <span className="text-[10px] px-1.5 py-px rounded bg-[var(--accent-glow)] text-[var(--accent)]">推理</span>
              )}
            </div>
          ) : (
            <div className="text-muted text-[11px]">{loading ? '读取中…' : '未选择模型'}</div>
          )}
        </div>

        {/* 添加面板 */}
        {panelOpen && (
          <div className="p-4 rounded-xl bg-[var(--bg-elev)] border border-[var(--accent)]/40 space-y-3.5 shadow-card">
            <div className="text-[11px] font-semibold text-main">添加提供方 / 批量入库模型</div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="mp-provider" className="block text-main text-[11px] font-medium mb-1.5">提供方 ID</label>
                <input
                  id="mp-provider"
                  type="text"
                  value={pProvider}
                  onChange={(e) => { setPProvider(e.target.value.trim()); resetFetch(); }}
                  placeholder="如 cpa / openai / 自定义 id"
                  list="mp-provider-ids"
                  className="w-full bg-[var(--bg)] border border-[var(--border-strong)] focus:border-[var(--accent)] rounded-lg px-3 py-1.5 text-xs text-main outline-none font-mono"
                />
                <datalist id="mp-provider-ids">
                  {providers.map((p) => <option key={p.id} value={p.id} />)}
                </datalist>
              </div>
              <div>
                <label htmlFor="mp-api" className="block text-main text-[11px] font-medium mb-1.5">API 协议</label>
                <select
                  id="mp-api"
                  value={pApi}
                  onChange={(e) => setPApi(e.target.value)}
                  className="w-full bg-[var(--bg)] border border-[var(--border-strong)] focus:border-[var(--accent)] rounded-lg px-3 py-1.5 text-xs text-main outline-none"
                >
                  <option value="openai-completions">openai-completions（OpenAI 兼容）</option>
                  <option value="openai-responses">openai-responses</option>
                  <option value="anthropic-messages">anthropic-messages（Claude 兼容）</option>
                  <option value="google-generative-ai">google-generative-ai（Gemini）</option>
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="mp-baseurl" className="block text-main text-[11px] font-medium mb-1.5">Base URL</label>
              <input
                id="mp-baseurl"
                type="text"
                value={pBaseUrl}
                onChange={(e) => {
                  const v = e.target.value;
                  setPBaseUrl(v);
                  if (isPrivateBaseUrl(v)) setPAllowPrivate(true);
                }}
                placeholder="https://api.openai.com/v1 或 http://127.0.0.1:8317/v1"
                className="w-full bg-[var(--bg)] border border-[var(--border-strong)] focus:border-[var(--accent)] rounded-lg px-3 py-1.5 text-xs text-main outline-none font-mono"
              />
            </div>

            <div>
              <label htmlFor="mp-key" className="block text-main text-[11px] font-medium mb-1.5">API 密钥（本机无鉴权代理可留空）</label>
              <div className="relative">
                <input
                  id="mp-key"
                  type={showKey ? 'text' : 'password'}
                  value={pKey}
                  onChange={(e) => setPKey(e.target.value)}
                  placeholder="sk-... 粘贴有效凭据"
                  className="w-full bg-[var(--bg)] border border-[var(--border-strong)] focus:border-[var(--accent)] rounded-lg pl-3 pr-9 py-1.5 text-xs text-main outline-none font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2.5 top-2 text-muted hover:text-main"
                  aria-label={showKey ? '隐藏密钥' : '显示密钥'}
                >
                  {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            <div className="flex items-start gap-2">
              <input
                id="mp-allow-private"
                type="checkbox"
                checked={pAllowPrivate}
                onChange={(e) => setPAllowPrivate(e.target.checked)}
                className="mt-0.5 accent-[#6e77e8]"
              />
              <label htmlFor="mp-allow-private" className="text-main text-[11px] leading-snug">
                本机/内网自托管端点（允许私有网络地址）
                <span className="block text-muted text-[10px]">
                  指向 127.0.0.1 / 局域网 的端点必须显式允许，否则注册与请求会被出口守卫拒绝（HTTP 403）
                </span>
              </label>
            </div>

            <div>
              <label htmlFor="mp-compat" className="block text-main text-[11px] font-medium mb-1.5">兼容性预设</label>
              <select
                id="mp-compat"
                value={pCompat}
                onChange={(e) => setPCompat(e.target.value)}
                className="w-full bg-[var(--bg)] border border-[var(--border-strong)] focus:border-[var(--accent)] rounded-lg px-3 py-1.5 text-xs text-main outline-none"
              >
                <option value="default">默认（标准 OpenAI 兼容）</option>
                <option value="no-developer-role">上游不接受 developer 角色（自托管代理转发 kimi/moonshot 等）</option>
              </select>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <button
                id="mp-ping"
                type="button"
                onClick={handlePing}
                disabled={!pProvider}
                className="px-3 py-1.5 rounded-lg bg-[var(--bg)] hover:bg-[var(--bg-side)] disabled:opacity-50 text-main text-xs border border-[var(--border)] transition-colors"
              >
                测试连接
              </button>
              <button
                id="models-fetch-models"
                type="button"
                onClick={handleFetch}
                disabled={fetching || !pProvider}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--bg)] hover:bg-[var(--bg-side)] disabled:opacity-50 text-main text-xs border border-[var(--border)] transition-colors"
              >
                <RefreshCw className={cn('w-3.5 h-3.5 text-[var(--accent)]', fetching && 'animate-spin')} />
                <span>{fetching ? '正在拉取…' : '拉取模型目录'}</span>
              </button>
              {pingState && (
                <span className={cn('text-[11px]', pingState.ok ? 'text-[var(--green-text)]' : 'text-[var(--red-text)]')}>
                  {pingState.text}
                </span>
              )}
            </div>

            {fetchError && (
              <p className="text-[11px] text-[var(--red-text)] leading-snug flex items-start gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
                <span>{fetchError}</span>
              </p>
            )}

            {fetched.length > 0 && (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--bg)] overflow-hidden">
                <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--border)] text-[11px] text-muted">
                  <span>端点返回 {fetched.length} 个模型，勾选后批量入库</span>
                  <button
                    type="button"
                    onClick={() => setPicked((prev) => (prev.size === fetched.length ? new Set() : new Set(fetched.map((f) => f.id))))}
                    className="text-[var(--accent)] hover:underline"
                  >
                    {picked.size === fetched.length ? '清空' : '全选'}
                  </button>
                </div>
                <ul className="max-h-44 overflow-y-auto divide-y divide-[var(--border)]">
                  {fetched.map((f) => (
                    <li key={f.id} data-fetched-model={f.id}>
                      <label className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-[var(--bg-side)]">
                        <input
                          type="checkbox"
                          checked={picked.has(f.id)}
                          onChange={() => togglePicked(f.id)}
                          className="accent-[#6e77e8]"
                        />
                        <span className="font-mono text-[11px] text-main flex-1 truncate">{f.id}</span>
                        {f.reasoning === true && (
                          <span className="text-[10px] px-1.5 py-px rounded bg-[var(--accent-glow)] text-[var(--accent)]">推理</span>
                        )}
                        {f.contextWindow > 0 && (
                          <span className="text-[10px] text-muted font-mono">{Math.round(f.contextWindow / 1024)}K</span>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex justify-end">
              <button
                id="models-save-add"
                type="button"
                onClick={handleSaveProvider}
                disabled={saving || !pProvider}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#4f58c7] hover:bg-[#4338ca] disabled:opacity-50 text-white font-medium text-xs transition-colors"
              >
                <Check className="w-3.5 h-3.5" />
                <span>{saving ? '保存中…' : `保存${picked.size ? `并入库 ${picked.size} 个模型` : ''}`}</span>
              </button>
            </div>
          </div>
        )}

        {/* 我的提供方 */}
        <div className="space-y-3">
          <h3 className="text-[11px] font-semibold text-muted uppercase tracking-wider">我的提供方</h3>
          {loading && myProviders.length === 0 && (
            <div className="text-muted text-[11px]">读取中…</div>
          )}
          {!loading && myProviders.length === 0 && !error && (
            <div className="p-4 rounded-xl border border-dashed border-[var(--border-strong)] text-muted text-[11px]">
              还没有已配置的提供方。点击右上角「添加提供方 / 模型」开始接入。
            </div>
          )}
          {myProviders.map((p) => (
            <div key={p.id} className="rounded-xl bg-[var(--bg-elev)] border border-[var(--border)] shadow-card overflow-hidden">
              <div className="px-4 py-3 flex items-center gap-2.5 border-b border-[var(--border)]">
                <span className="font-semibold text-main text-xs font-mono">{p.id}</span>
                {p.api && <span className="text-[10px] px-1.5 py-px rounded bg-[var(--bg)] text-muted font-mono">{p.api}</span>}
                {p.hasAuth ? (
                  <span className="text-[10px] px-1.5 py-px rounded bg-emerald-500/15 text-[var(--green-text)]">凭据已配置</span>
                ) : (
                  <span className="text-[10px] px-1.5 py-px rounded bg-amber-500/15 text-[var(--amber-text)]">凭据缺失</span>
                )}
                {p.baseUrl && (
                  <span className="text-[10px] text-muted font-mono truncate flex-1">{p.baseUrl}</span>
                )}
                <span className="text-[10px] text-muted ml-auto mr-1">{p.models?.length ?? 0} 个模型</span>
                <button
                  type="button"
                  disabled={busyKey !== null}
                  onClick={() => handleDeleteProvider(p.id)}
                  className={cn(
                    'flex items-center gap-1 px-2 py-0.5 rounded text-[10px] border transition-colors disabled:opacity-50',
                    confirmDeleteProvider === p.id
                      ? 'text-white bg-rose-600 hover:bg-rose-500 border-rose-500'
                      : 'text-muted hover:text-[var(--red-text)] border-transparent hover:border-rose-500/40'
                  )}
                  aria-label={`删除提供方 ${p.id}`}
                >
                  <Trash2 className="w-3 h-3" />
                  <span>{confirmDeleteProvider === p.id ? '确认删除提供方？' : '删除提供方'}</span>
                </button>
              </div>
              <ul className="divide-y divide-[var(--border)]">
                {(p.models ?? []).map((m) => {
                  const mid = m.id ?? m.name;
                  const key = `${p.id}/${mid}`;
                  const cur = isCurrent(p.id, mid);
                  return (
                    <li key={mid} data-model-row={key} className="px-4 py-2 flex items-center gap-2.5">
                      {cur && <Star className="w-3.5 h-3.5 text-[var(--accent)] fill-current" />}
                      <span className={cn('font-mono text-[11px] flex-1 truncate', cur ? 'text-main font-semibold' : 'text-main')}>{mid}</span>
                      {(m.reasoning === true) && (
                        <span className="text-[10px] px-1.5 py-px rounded bg-[var(--accent-glow)] text-[var(--accent)]">推理</span>
                      )}
                      {Number(m.contextWindow) > 0 && (
                        <span className="text-[10px] text-muted font-mono">{Math.round(Number(m.contextWindow) / 1024)}K</span>
                      )}
                      {!cur && (
                        <button
                          type="button"
                          disabled={busyKey !== null}
                          onClick={() => handleSetDefault(p.id, mid)}
                          className="px-2 py-1 rounded-md text-[10px] text-[var(--accent)] hover:bg-[var(--accent-glow)] border border-transparent hover:border-[var(--accent)]/40 transition-colors disabled:opacity-50"
                        >
                          设为默认
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busyKey !== null}
                        onClick={() => handleDelete(p.id, mid)}
                        className={cn(
                          'flex items-center gap-1 px-2 py-1 rounded-md text-[10px] border transition-colors disabled:opacity-50',
                          confirmDelete === key
                            ? 'text-white bg-rose-600 hover:bg-rose-500 border-rose-500'
                            : 'text-muted hover:text-[var(--red-text)] border-transparent hover:border-rose-500/40'
                        )}
                        aria-label={`删除模型 ${key}`}
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>{confirmDelete === key ? '确认删除？' : '删除'}</span>
                      </button>
                    </li>
                  );
                })}
                {(p.models ?? []).length === 0 && (
                  <li className="px-4 py-2 text-muted text-[11px]">该提供方下没有入库模型</li>
                )}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

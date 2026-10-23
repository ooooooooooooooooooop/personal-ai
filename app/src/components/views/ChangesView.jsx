import React, { useState, useEffect } from 'react';
import {
  FileText,
  FileCode,
  RotateCcw,
  Copy,
  Check,
  Clock,
  RefreshCw,
  AlertCircle,
  Inbox,
  CheckCircle2,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { sendCmd } from '../../lib/api';

export function ChangesView() {
  const [artifacts, setArtifacts] = useState([]);
  const [fileops, setFileops] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedItem, setSelectedItem] = useState(null);
  const [viewContent, setViewContent] = useState('');
  const [copied, setCopied] = useState(false);
  const [actionNotice, setActionNotice] = useState(null);
  const [restoring, setRestoring] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    setActionNotice(null);

    let artErr = null;
    let fopsErr = null;

    try {
      const artRes = await fetch('/api/artifacts');
      if (artRes.ok) {
        const artData = await artRes.json();
        setArtifacts(Array.isArray(artData.artifacts) ? artData.artifacts : []);
      } else {
        artErr = `产物服务响应异常 (HTTP ${artRes.status})`;
        setArtifacts([]);
      }
    } catch (e) {
      artErr = `无法连接产物服务: ${e.message}`;
      setArtifacts([]);
    }

    try {
      const fRes = await sendCmd('fileops_list');
      if (fRes.success) {
        const rawOps = Array.isArray(fRes.data)
          ? fRes.data
          : Array.isArray(fRes.data?.ops)
          ? fRes.data.ops
          : [];
        setFileops(rawOps);
      } else {
        fopsErr = fRes.error || '获取文件改动回执失败';
        setFileops([]);
      }
    } catch (e) {
      fopsErr = `文件改动服务异常: ${e.message}`;
      setFileops([]);
    } finally {
      setLoading(false);
    }

    if (fopsErr || artErr) {
      setError([fopsErr, artErr].filter(Boolean).join(' | '));
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const combinedItems = [
    ...artifacts.map((a) => ({
      type: 'artifact',
      id: a.path,
      file: a.path.split(/[/\\]/).pop(),
      fullPath: a.path,
      time: a.mtime ? new Date(a.mtime).toLocaleTimeString() : '刚刚',
      size: a.bytes ? `${Math.round(a.bytes / 1024)} KB` : '产物',
    })),
    ...fileops.map((f) => ({
      type: 'fileop',
      id: f.receiptId,
      receiptId: f.receiptId,
      file: f.path ? f.path.split(/[/\\]/).pop() : (f.file || f.target || '未命名改动'),
      fullPath: f.path || f.file || f.target,
      time: f.timestamp || f.at ? new Date(f.timestamp || f.at).toLocaleTimeString() : '刚刚',
      size: f.op || '改动',
    })),
  ];

  useEffect(() => {
    if (!combinedItems.length) {
      setSelectedItem(null);
      setViewContent('');
      return;
    }
    if (!selectedItem || !combinedItems.find((i) => i.id === selectedItem.id)) {
      setSelectedItem(combinedItems[0]);
    }
  }, [combinedItems.length]);

  useEffect(() => {
    if (!selectedItem) {
      setViewContent('');
      return;
    }

    if (selectedItem.type === 'artifact') {
      fetch(`/api/artifact?path=${encodeURIComponent(selectedItem.fullPath)}`)
        .then((r) => (r.ok ? r.text() : `无法读取产物内容 (HTTP ${r.status})`))
        .then((text) => setViewContent(text))
        .catch((err) => setViewContent(`产物读取失败: ${err.message}`));
    } else if (selectedItem.type === 'fileop') {
      sendCmd('fileops_diff', { receiptId: selectedItem.receiptId })
        .then((r) => {
          if (r.success && r.data?.diff) {
            setViewContent(r.data.diff);
          } else {
            setViewContent(r.error ? `Diff 获取失败: ${r.error}` : '暂无差异内容');
          }
        })
        .catch((err) => setViewContent(`Diff 获取失败: ${err.message}`));
    }
  }, [selectedItem?.id]);

  const handleRestore = async () => {
    if (!selectedItem || selectedItem.type !== 'fileop') return;
    setRestoring(true);
    setActionNotice(null);
    try {
      const res = await sendCmd('fileops_restore', { receiptId: selectedItem.receiptId });
      if (res.success) {
        setActionNotice({ ok: true, text: `已成功回退改动：${selectedItem.file}` });
        await fetchData();
      } else {
        setActionNotice({ ok: false, text: `回退失败：${res.error || '可能存在外部冲突'}` });
      }
    } catch (e) {
      setActionNotice({ ok: false, text: `回退异常：${e.message}` });
    } finally {
      setRestoring(false);
    }
  };

  const handleCopy = () => {
    if (!viewContent) return;
    try {
      navigator.clipboard.writeText(viewContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* File List Pane */}
      <div className="w-80 border-r border-app bg-[var(--bg-side)] flex flex-col shrink-0 select-none">
        <div className="p-3 border-b border-app flex items-center justify-between">
          <h3 className="text-xs font-semibold text-main">变更文件与产物</h3>
          <button
            onClick={fetchData}
            className="p-1 rounded hover:bg-[var(--bg-card)] text-sub hover:text-main transition-colors"
            title="刷新产物列表"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {combinedItems.length === 0 ? (
            <div className="p-6 text-center text-muted text-xs flex flex-col items-center gap-2">
              <Inbox className="w-6 h-6 text-muted" />
              <span>{loading ? '正在读取变更与产物…' : '暂无文件改动或导出产物'}</span>
            </div>
          ) : (
            combinedItems.map((item) => {
              const isSelected = selectedItem?.id === item.id;
              return (
                <div
                  key={item.id}
                  onClick={() => setSelectedItem(item)}
                  className={cn(
                    'p-2.5 rounded-lg text-xs cursor-pointer border transition-all',
                    isSelected
                      ? 'bg-[var(--bg-card)] border-[var(--accent)] shadow-sm text-main font-medium'
                      : 'border-transparent text-sub hover:bg-[var(--bg-card)] hover:text-main'
                  )}
                >
                  <div className="flex items-center justify-between mb-1 truncate">
                    <span className="font-semibold text-main truncate flex items-center gap-1.5">
                      {item.type === 'artifact' ? (
                        <FileText className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      ) : (
                        <FileCode className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                      )}
                      <span className="truncate">{item.file}</span>
                    </span>
                    <span className="px-1.5 py-0.5 rounded bg-[var(--border)] text-[10px] font-mono text-muted">
                      {item.size}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-muted font-mono">
                    <span className="truncate">{item.type === 'artifact' ? '导出的工作产物' : '可逆写入改动'}</span>
                    <span>{item.time}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Content & Action Pane */}
      <div className="flex-1 flex flex-col bg-app overflow-hidden">
        {error && (
          <div className="p-2.5 bg-rose-500/20 border-b border-rose-500/30 text-xs text-[var(--red-text)] flex items-center justify-between">
            <span className="flex items-center gap-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              {error}
            </span>
            <button onClick={() => setError(null)} className="text-sub hover:text-main">✕</button>
          </div>
        )}

        {actionNotice && (
          <div
            className={cn(
              'p-2.5 border-b text-xs flex items-center justify-between',
              actionNotice.ok
                ? 'bg-emerald-500/20 border-emerald-500/30 text-[var(--green-text)]'
                : 'bg-rose-500/20 border-rose-500/30 text-[var(--red-text)]'
            )}
          >
            <span>{actionNotice.text}</span>
            <button onClick={() => setActionNotice(null)} className="text-sub hover:text-main">✕</button>
          </div>
        )}

        {/* Content Header */}
        <div className="h-11 px-4 border-b border-app flex items-center justify-between bg-[var(--bg-side)] select-none">
          <div className="flex items-center gap-2 truncate">
            <span className="font-mono text-xs text-main font-medium truncate">
              {selectedItem ? selectedItem.fullPath : '未选中项'}
            </span>
          </div>

          {selectedItem && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopy}
                className="px-2.5 py-1 rounded bg-[var(--bg-elev)] hover:bg-[var(--bg-card)] text-main text-xs border border-app transition-colors flex items-center gap-1.5 cursor-pointer"
                title="复制内容"
              >
                {copied ? <Check className="w-3 h-3 text-[var(--green-text)]" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? '已复制' : '复制'}</span>
              </button>

              {selectedItem.type === 'fileop' && (
                <button
                  onClick={handleRestore}
                  disabled={restoring}
                  className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-[var(--amber-text)] text-xs border border-amber-500/30 transition-colors flex items-center gap-1.5 cursor-pointer"
                  title="撤销本次改动"
                >
                  <RotateCcw className={cn('w-3 h-3', restoring && 'animate-spin')} />
                  <span>{restoring ? '撤销中…' : '撤销此改动'}</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-auto p-4 bg-[var(--bg)] font-mono text-xs leading-relaxed text-main">
          {!selectedItem ? (
            <div className="h-full flex items-center justify-center text-muted">
              从左侧列表选择产物或改动以查看明细
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-all">{viewContent || '加载中…'}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

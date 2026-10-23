import React, { useState, useRef, useEffect } from 'react';
import {
  ArrowUp,
  Square,
  Paperclip,
  Cpu,
  ChevronDown,
  Sparkles,
  X,
  Check,
  Boxes,
} from 'lucide-react';
import { cn } from '../../lib/utils';

const THINKING_LABEL = { off: '关', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };
const DEFAULT_LEVELS = ['off', 'low', 'medium', 'high'];

export function Composer({
  onSend,
  onStop,
  running = false,
  stopping = false,
  hasPendingAsk = false,
  activeSessionId = 'default',
  activeModel = '',
  activeProvider = '',
  availableModels = [],
  thinkingLevel = '',
  supportedThinkingLevels = null,
  executionMode = 'execute',
  onSelectModel,
  onOpenModelPicker,
  onSelectThinking,
  onChangeMode,
  onManageModels,
  draftToInject = '',
}) {
  // 选择器：点 chip 打开列表、选中即生效；Esc / 点外部关闭
  const [menu, setMenu] = useState(null); // 'model' | 'thinking' | null
  const [modelQuery, setModelQuery] = useState('');
  const [menuBusy, setMenuBusy] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenu(null); };
    const onKey = (e) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const openMenu = (m) => {
    if (menu === m) { setMenu(null); return; }
    setModelQuery('');
    setMenu(m);
    if (m === 'model') onOpenModelPicker?.();
  };

  const pick = async (fn) => {
    setMenuBusy(true);
    const ok = await fn();
    setMenuBusy(false);
    if (ok !== false) setMenu(null);
  };

  const levels = supportedThinkingLevels?.length ? supportedThinkingLevels : DEFAULT_LEVELS;
  const q = modelQuery.trim().toLowerCase();
  const modelGroups = availableModels
    .filter((m) => !q || `${m.provider}/${m.id || m.name}`.toLowerCase().includes(q))
    .reduce((acc, m) => { (acc[m.provider || '未知提供方'] ??= []).push(m); return acc; }, {});
  const draftKey = `pai_draft_${activeSessionId || 'default'}`;
  const [text, setText] = useState(() => {
    try {
      return localStorage.getItem(draftKey) || '';
    } catch {
      return '';
    }
  });

  const [attachments, setAttachments] = useState([]);
  const [isComposing, setIsComposing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  // Load draft when activeSessionId changes
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`pai_draft_${activeSessionId || 'default'}`) || '';
      setText(saved);
    } catch {
      setText('');
    }
    setAttachments([]);
  }, [activeSessionId]);

  // Inject suggestion without auto-sending (D06 / V410)
  useEffect(() => {
    if (draftToInject) {
      setText(draftToInject);
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }
  }, [draftToInject]);

  // Auto-grow textarea & persist draft
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(
        textareaRef.current.scrollHeight,
        180
      )}px`;
    }
    try {
      const currentKey = `pai_draft_${activeSessionId || 'default'}`;
      if (text) {
        localStorage.setItem(currentKey, text);
      } else {
        localStorage.removeItem(currentKey);
      }
    } catch {}
  }, [text, activeSessionId]);

  const handleKeyDown = (e) => {
    // Prevent send during IME composition (Chinese Pinyin Enter)
    if (isComposing) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  /**
   * 统一处理文件与剪贴板图片：读取为 base64 附着项，限制 8MB
   */
  const processFiles = async (files) => {
    if (!files || !files.length) return;
    const maxSizeBytes = 8 * 1024 * 1024;
    const valid = [];

    for (const file of files) {
      if (file.size > maxSizeBytes) {
        alert(`文件 ${file.name || '附件'} 超过 8MB 大小限制，已被跳过`);
        continue;
      }
      let base64 = '';
      try {
        base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const res = reader.result;
            const b64 = typeof res === 'string' ? res.split(',')[1] : '';
            resolve(b64);
          };
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
      } catch {
        base64 = '';
      }

      // 处理剪贴板粘贴截图等无名图片
      const isScreenshot = !file.name || file.name === 'image.png' || file.name === 'blob';
      const displayName = isScreenshot
        ? `截图-${new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '')}.png`
        : file.name;

      valid.push({
        name: displayName,
        size: file.size,
        bytes: file.size,
        type: file.type || (isScreenshot ? 'image/png' : 'application/octet-stream'),
        mime: file.type || (isScreenshot ? 'image/png' : 'application/octet-stream'),
        data: base64,
        path: file.path || undefined,
        file,
      });
    }

    if (valid.length > 0) {
      setAttachments((prev) => [...prev, ...valid]);
    }
  };

  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    await processFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /**
   * 支持通过 Ctrl+V 直接粘贴剪贴板中的图片/截图
   */
  const handlePaste = async (e) => {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    const items = Array.from(clipboardData.items || []);
    const files = [];

    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }

    if (files.length === 0 && clipboardData.files?.length) {
      files.push(...Array.from(clipboardData.files));
    }

    if (files.length > 0) {
      const hasImage = files.some((f) => f.type.startsWith('image/'));
      if (hasImage) {
        // 如果剪贴板中没有纯文本，则阻止默认输入行为，避免向输入框注入异常字符
        const plainText = clipboardData.getData('text/plain');
        if (!plainText) {
          e.preventDefault();
        }
        await processFiles(files);
      }
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const droppedFiles = Array.from(e.dataTransfer?.files || []);
    if (droppedFiles.length > 0) {
      await processFiles(droppedFiles);
    }
  };

  const removeAttachment = (index) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) {
      if (running) {
        onStop?.();
      }
      return;
    }

    const currentText = trimmed;
    const currentAtts = [...attachments];

    // 发送前暂存并在界面上即时响应
    setText('');
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    const ok = await onSend?.(currentText, currentAtts);
    if (ok === false) {
      // V402: 发送失败（如 503/网络中断），必须恢复输入文本、待发送附件与持久草稿
      setText(currentText);
      setAttachments(currentAtts);
      try {
        localStorage.setItem(`pai_draft_${activeSessionId || 'default'}`, currentText);
      } catch {}
    } else {
      try {
        localStorage.removeItem(`pai_draft_${activeSessionId || 'default'}`);
      } catch {}
    }
  };

  return (
    <div className="w-full max-w-3xl mx-auto px-4 pb-4 select-none">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'rounded-2xl bg-[var(--bg-elev)]/95 backdrop-blur-xl border border-[var(--border-strong)] shadow-dock p-3 text-xs transition-all focus-within:border-[#6e77e8] focus-within:shadow-[0_16px_40px_-8px_rgba(110,119,232,0.2)]',
          isDragging && 'border-[#6e77e8] bg-[#6e77e8]/10 ring-2 ring-[#6e77e8]/30'
        )}
      >
        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2 pb-2 border-b border-[var(--border)]">
            {attachments.map((att, idx) => {
              const isImg = att.type?.startsWith('image/') || att.mime?.startsWith('image/');
              return (
                <span
                  key={idx}
                  className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[var(--bg-side)] text-main text-[11px] font-mono border border-[var(--border)] shadow-xs"
                >
                  {isImg && att.data ? (
                    <img
                      src={`data:${att.mime || att.type || 'image/png'};base64,${att.data}`}
                      alt={att.name}
                      className="w-4 h-4 object-cover rounded border border-white/10 shrink-0"
                    />
                  ) : (
                    <Paperclip className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                  )}
                  <span className="truncate max-w-[150px]">{att.name}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(idx)}
                    className="hover:text-[var(--red-text)] text-muted transition-colors ml-0.5"
                    aria-label={`移除附件 ${att.name}`}
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {/* Main Text Input */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          rows={1}
          aria-label="输入指令或问题"
          placeholder="给 Personal AI 下达指令或提出问题… (输入 @ 引用文件，支持 Ctrl+V 粘贴截图)"
          className="w-full bg-transparent text-[var(--text-primary)] placeholder:text-[var(--text-muted)] resize-none outline-none text-xs leading-relaxed max-h-44 overflow-y-auto selection:bg-[#6e77e8]/40 font-sans"
        />

        {/* Hidden File Input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileSelect}
          className="hidden"
          id="pai-file-attachment-input"
          aria-label="上传附件"
        />

        {/* Bottom Action Bar */}
        <div className="mt-2 pt-2 border-t border-[var(--border)] flex items-center justify-between">
          {/* Left Controls: Model, Thinking, Mode */}
          {/* 不能 overflow-x-auto：会把向上弹出的选择器裁掉（另一轴被算成 auto） */}
          <div className="flex items-center gap-1.5 py-0.5 min-w-0 flex-wrap">
            {/* Attachment Button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-1.5 rounded-md hover:bg-white/[0.08] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              title="附着文件 (@)"
              aria-label="附着文件"
            >
              <Paperclip className="w-3.5 h-3.5" />
            </button>

            <div ref={menuRef} className="relative flex items-center gap-1.5">
              {/* 模型选择器 */}
              <button
                id="composer-model-chip"
                type="button"
                onClick={() => openMenu('model')}
                aria-haspopup="listbox"
                aria-expanded={menu === 'model'}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--bg-side)] hover:bg-[var(--border)] border border-[var(--border)] text-[var(--text-primary)] text-[11px] font-mono transition-colors"
                title="选择模型"
              >
                <Cpu className="w-3 h-3 text-[var(--accent)]" />
                <span className="truncate max-w-[140px]">{activeModel || '未选择模型'}</span>
                <ChevronDown className="w-2.5 h-2.5 text-[var(--text-muted)]" />
              </button>

              {/* 思考等级：只列当前模型真正支持的 */}
              <button
                type="button"
                onClick={() => openMenu('thinking')}
                aria-haspopup="listbox"
                aria-expanded={menu === 'thinking'}
                className="flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--bg-side)] hover:bg-[var(--border)] border border-[var(--border)] text-[var(--text-primary)] text-[11px] transition-colors"
                title="选择思考等级"
              >
                <Sparkles className="w-3 h-3 text-[var(--amber)]" />
                <span>思考：{THINKING_LABEL[thinkingLevel] ?? (thinkingLevel || '未知')}</span>
                <ChevronDown className="w-2.5 h-2.5 text-[var(--text-muted)]" />
              </button>

              {menu === 'model' && (
                <div
                  id="composer-model-menu"
                  className="absolute bottom-full left-0 mb-2 w-72 rounded-xl bg-[var(--bg-elev)] border border-[var(--border-strong)] shadow-xl overflow-hidden z-20"
                >
                  {availableModels.length > 8 && (
                    <div className="p-2 border-b border-[var(--border)]">
                      <input
                        autoFocus
                        type="text"
                        value={modelQuery}
                        onChange={(e) => setModelQuery(e.target.value)}
                        placeholder="搜索模型…"
                        aria-label="搜索模型"
                        className="w-full px-2.5 py-1 bg-[var(--bg)] border border-[var(--border-strong)] focus:border-[var(--accent)] rounded-md text-xs text-main outline-none"
                      />
                    </div>
                  )}
                  <div className="max-h-64 overflow-y-auto py-1" role="listbox" aria-label="可用模型">
                    {Object.entries(modelGroups).map(([prov, list]) => (
                      <div key={prov} role="group" aria-label={prov}>
                        <div aria-hidden="true" className="px-3 pt-2 pb-1 text-[10px] font-semibold text-muted uppercase tracking-wider">{prov}</div>
                        {list.map((m) => {
                          const mid = m.id || m.name;
                          const sel = mid === activeModel && (m.provider || '') === (activeProvider || m.provider || '');
                          return (
                            <button
                              key={`${prov}/${mid}`}
                              type="button"
                              role="option"
                              aria-selected={sel}
                              disabled={menuBusy}
                              onClick={() => (sel ? setMenu(null) : pick(() => onSelectModel?.(m.provider, mid)))}
                              className={cn(
                                'w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] font-mono transition-colors disabled:opacity-60',
                                sel ? 'text-main bg-[var(--accent-glow)]' : 'text-sub hover:bg-[var(--bg-side)] hover:text-main'
                              )}
                            >
                              <Check className={cn('w-3 h-3 shrink-0', sel ? 'text-[var(--accent)]' : 'opacity-0')} />
                              <span className="truncate">{mid}</span>
                            </button>
                          );
                        })}
                      </div>
                    ))}
                    {!Object.keys(modelGroups).length && (
                      <div className="px-3 py-3 text-[11px] text-muted">
                        {availableModels.length ? '没有匹配的模型' : '还没有可用的模型'}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => { setMenu(null); onManageModels?.(); }}
                    className="w-full flex items-center gap-2 px-3 py-2 border-t border-[var(--border)] text-[11px] text-[var(--accent)] hover:bg-[var(--bg-side)] transition-colors"
                  >
                    <Boxes className="w-3.5 h-3.5" />
                    {availableModels.length ? '管理模型…' : '去接入模型…'}
                  </button>
                </div>
              )}

              {menu === 'thinking' && (
                <div
                  className="absolute bottom-full left-0 mb-2 w-40 rounded-xl bg-[var(--bg-elev)] border border-[var(--border-strong)] shadow-xl py-1 z-20"
                  role="listbox"
                  aria-label="思考等级"
                >
                  {levels.map((lv) => {
                    const sel = lv === thinkingLevel;
                    return (
                      <button
                        key={lv}
                        type="button"
                        role="option"
                        aria-selected={sel}
                        disabled={menuBusy}
                        onClick={() => (sel ? setMenu(null) : pick(() => onSelectThinking?.(lv)))}
                        className={cn(
                          'w-full flex items-center gap-2 px-3 py-1.5 text-left text-[11px] transition-colors disabled:opacity-60',
                          sel ? 'text-main bg-[var(--accent-glow)]' : 'text-sub hover:bg-[var(--bg-side)] hover:text-main'
                        )}
                      >
                        <Check className={cn('w-3 h-3 shrink-0', sel ? 'text-[var(--accent)]' : 'opacity-0')} />
                        {THINKING_LABEL[lv] ?? lv}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right Control: Send & Stop Buttons */}
          <div className="flex items-center gap-1.5">
            {hasPendingAsk && (
              <span className="text-[11px] text-[var(--amber-text)] font-medium animate-pulse hidden md:inline-block mr-1">
                ⏸️ 等待操作员审批
              </span>
            )}
            <span className="text-[11px] text-[var(--text-muted)] hidden sm:inline-block font-mono mr-1">
              Shift+Enter 换行
            </span>
            {running && (
              <button
                type="button"
                onClick={onStop}
                disabled={stopping}
                className="flex items-center gap-1 px-2 py-1 rounded-md bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 hover:text-white text-[11px] font-medium transition-all active:scale-95 cursor-pointer"
                title={stopping ? '正在停止…' : '立即停止执行'}
                aria-label={stopping ? '正在停止…' : '立即停止执行'}
              >
                <Square className={cn("w-3 h-3 fill-current", stopping && "animate-pulse")} />
                <span>{stopping ? '停止中…' : '停止'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!running && !text.trim() && attachments.length === 0}
              className={cn(
                'w-7 h-7 rounded-lg flex items-center justify-center transition-all active:scale-95',
                text.trim() || attachments.length > 0
                  ? 'bg-[#6e77e8] hover:bg-[#5b64dc] text-white shadow-[0_0_12px_rgba(110,119,232,0.4)]'
                  : 'bg-white/[0.08] text-white/40 cursor-not-allowed'
              )}
              title="发送指令 (Enter)"
              aria-label="发送指令"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

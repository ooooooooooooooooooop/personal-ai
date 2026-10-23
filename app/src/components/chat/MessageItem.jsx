import React, { useState, useEffect } from 'react';
import { Copy, Check, User, Bot, Sparkles, AlertCircle, ZoomIn, X, ChevronDown } from 'lucide-react';
import { cn, cleanDisplayContent } from '../../lib/utils';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolGroup } from './ToolGroup';
import { AskCard } from '../governance/AskCard';
import { MarkdownContent } from './MarkdownContent';
import { TurnChanges } from './TurnChanges';

export function MessageItem({ message, userPrompt = '', onResolveAsk, fileopsByCall, onViewChanges, onChangesUndone, isHighlighted = false }) {
  const [copied, setCopied] = useState(false);
  const [previewImage, setPreviewImage] = useState(null); // { src, name }
  const [showErrorDetail, setShowErrorDetail] = useState(false);
  const isUser = message.role === 'user';

  useEffect(() => {
    if (!previewImage) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') setPreviewImage(null);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [previewImage]);

  // 安全提取纯文本内容并清洗框架元数据，杜绝无意义内部标签污染界面
  const rawContent = typeof message.content === 'string'
    ? message.content
    : (typeof message.content?.content === 'string'
      ? message.content.content
      : (typeof message.content?.text === 'string'
        ? message.content.text
        : (Array.isArray(message.content)
          ? message.content.map((c) => (typeof c === 'string' ? c : (c?.text || c?.content || JSON.stringify(c)))).join('')
          : (message.content && typeof message.content === 'object' ? JSON.stringify(message.content, null, 2) : (message.content ? String(message.content) : '')))));

  const renderableContent = cleanDisplayContent(rawContent);

  const renderableThinking = typeof message.thinking === 'string'
    ? message.thinking
    : (typeof message.thinking?.thinking === 'string'
      ? message.thinking.thinking
      : (typeof message.thinking?.content === 'string'
        ? message.thinking.content
        : (message.thinking && typeof message.thinking === 'object' ? JSON.stringify(message.thinking, null, 2) : (message.thinking ? String(message.thinking) : ''))));

  const rawErr = message.errorMessage || message.error;
  const renderableError = typeof rawErr === 'string'
    ? rawErr
    : (rawErr && typeof rawErr === 'object' ? JSON.stringify(rawErr, null, 2) : (rawErr ? String(rawErr) : null));

  const modelLabel = typeof message.model === 'string'
    ? message.model
    : (message.model?.id || (message.model ? JSON.stringify(message.model) : null));

  const handleCopy = () => {
    navigator.clipboard?.writeText(renderableContent || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      id={`msg-${message.id}`}
      className={cn(
        'group py-3 px-4 flex gap-3 transition-all duration-300 text-xs leading-relaxed scroll-mt-6 rounded-xl',
        isUser ? 'flex-row-reverse bg-transparent' : 'flex-row bg-transparent',
        isHighlighted && 'ring-2 ring-[var(--accent)] bg-[var(--accent)]/10 shadow-sm'
      )}
    >
      {/* Avatar */}
      <div
        className={cn(
          'w-7 h-7 rounded-xl flex items-center justify-center shrink-0 mt-0.5 text-xs font-semibold shadow-sm',
          isUser
            ? 'bg-[#6e77e8] text-white shadow-[0_2px_8px_rgba(110,119,232,0.3)]'
            : 'bg-gradient-to-br from-[#6e77e8] to-[#4f46e5] text-white shadow-[0_0_12px_rgba(110,119,232,0.3)]'
        )}
      >
        {isUser ? <User className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
      </div>

      {/* Content Body */}
      <div
        className={cn(
          'flex-1 overflow-hidden space-y-1.5',
          isUser ? 'flex flex-col items-end text-right' : 'text-left space-y-2'
        )}
      >
        {/* Name & Time Header */}
        <div className={cn('flex items-center gap-2', isUser && 'flex-row-reverse')}>
          <span className="font-semibold text-main">
            {isUser ? '我' : 'Personal AI'}
          </span>
          {modelLabel && !isUser && (
            <span className="font-mono text-[10px] text-muted bg-elev px-1.5 py-0.5 rounded border border-app">
              {modelLabel}
            </span>
          )}
          <button
            onClick={handleCopy}
            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--border)] text-muted hover:text-main transition-opacity"
            title="复制内容"
          >
            {copied ? (
              <Check className="w-3 h-3 text-emerald-400" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
        </div>

        {/* Thinking Block (if any) */}
        {renderableThinking && (
          <ThinkingBlock
            content={renderableThinking}
            duration={message.thinkingDuration}
            isStreaming={message.thinkingStreaming}
            tools={message.tools}
            userPrompt={userPrompt}
          />
        )}

        {/* Tool Invocations (Folded Group by default) */}
        {message.tools?.length > 0 && (
          <ToolGroup
            tools={message.tools}
            isRunning={message.tools.some((t) => t.status === 'running')}
            userPrompt={userPrompt}
          />
        )}

        {/* Governance ASK Cards (if any) */}
        {message.askCard && (
          <AskCard
            id={message.askCard.id}
            tool={message.askCard.tool}
            command={message.askCard.command}
            rule={message.askCard.rule}
            summary={message.askCard.summary}
            detail={message.askCard.detail}
            args={message.askCard.args}
            risk={message.askCard.risk}
            riskUnits={message.askCard.riskUnits}
            onResolve={onResolveAsk}
          />
        )}

        {/* Main Text Content */}
        {renderableContent && (
          isUser ? (
            <div className="bg-[#6e77e8]/15 border border-[#6e77e8]/30 text-white rounded-2xl rounded-tr-xs px-4 py-2.5 max-w-[85%] text-left whitespace-pre-wrap selection:bg-[#6e77e8]/40 font-sans leading-relaxed shadow-sm">
              {renderableContent}
            </div>
          ) : (
            <MarkdownContent content={renderableContent} />
          )
        )}

        {/* 附件与图片展示 */}
        {message.attachments?.length > 0 && (
          <div className={cn('flex flex-wrap gap-2 pt-1 pb-1', isUser && 'justify-end')}>
            {message.attachments.map((att, idx) => {
              const isObj = typeof att === 'object' && att !== null;
              const rawName = isObj ? att.name : att;
              const name = typeof rawName === 'string' ? rawName : (rawName ? JSON.stringify(rawName) : '附件');
              const mime = isObj ? (att.mime || att.type) : '';
              const data = isObj ? att.data : null;
              const url = isObj ? att.url : null;
              const path = isObj ? att.path : null;
              const isImg = (mime && typeof mime === 'string' && mime.startsWith('image/')) || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name || '');

              const imgSrc = data
                ? (typeof data === 'string' && data.startsWith('data:') ? data : `data:${mime || 'image/png'};base64,${data}`)
                : (url || (path ? `/api/artifact?path=${encodeURIComponent(path)}` : null));

              if (isImg && imgSrc) {
                return (
                  <div
                    key={idx}
                    onClick={() => setPreviewImage({ src: imgSrc, name })}
                    className="group/img relative rounded-xl overflow-hidden border border-app bg-elev p-1 flex items-center gap-2 max-w-sm shadow-xs cursor-zoom-in hover:border-[#6e77e8]/60 transition-all"
                    title="点击放大预览"
                  >
                    <img
                      src={imgSrc}
                      alt={name}
                      className="max-h-48 max-w-full rounded-lg object-contain bg-black/20 group-hover/img:scale-[1.01] transition-transform"
                    />
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/img:opacity-100 transition-opacity flex items-center justify-center text-white gap-1.5 text-xs font-medium backdrop-blur-[1px]">
                      <ZoomIn className="w-4 h-4" />
                      <span>点击放大</span>
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={idx}
                  className="rounded-xl overflow-hidden border border-app bg-elev p-1.5 flex items-center gap-2 max-w-sm shadow-xs"
                >
                  <div className="flex items-center gap-1.5 text-[11px] font-mono text-sub px-2 py-1">
                    <span>{isImg ? '🖼' : '📄'}</span>
                    <span className="truncate max-w-[200px]">{name}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Model Error or Interrupted Card */}
        {renderableError && (() => {
          if (/aborted|request was aborted|abort/i.test(renderableError)) {
            return (
              <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[var(--amber-text)] flex items-center gap-2 text-xs">
                <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
                <div className="flex-1">
                  <span className="font-semibold mr-1">执行已中止</span>
                  <span className="text-muted text-[11px]">（会话切换或操作员中断）</span>
                </div>
              </div>
            );
          }

          const isTokenExpired = /refresh_token_expired|session has expired|invalid_refresh_token/i.test(renderableError);
          const isAuthUnavailable = /auth_unavailable|no auth available/i.test(renderableError);
          const isConnRefused = /ECONNREFUSED|connect ECONNREFUSED/i.test(renderableError);

          let errorTitle = '模型调用异常';
          let errorHint = null;

          if (isTokenExpired) {
            errorTitle = '模型上游账号授权已过期 (refresh_token_expired)';
            errorHint = '当前模型的 OAuth Token 已失效。建议：请在模型代理工具 (EasyCLIProxyAPI) 中重新授权登录该账号；或在下方模型菜单直接切换为已就绪的 Kimi (kimi-k2.8 / kimi-k3)。';
          } else if (isAuthUnavailable) {
            errorTitle = '模型上游认证不可用 (auth_unavailable)';
            errorHint = '未获取到当前模型的有效认证凭据。建议在下方模型菜单切换为其他可用模型，或在代理工具中检查该账号状态。';
          } else if (isConnRefused) {
            errorTitle = '无法连接到模型代理服务 (Connection Refused)';
            errorHint = '本地代理端口未响应，请检查 EasyCLIProxyAPI 或本地模型服务是否已启动。';
          }

          return (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-[var(--red-text)] flex items-start gap-2.5 text-xs shadow-sm">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <div className="space-y-1.5 overflow-hidden flex-1">
                <div className="font-semibold text-rose-300">{errorTitle}</div>
                {errorHint && (
                  <div className="text-[11.5px] text-rose-200/90 leading-relaxed bg-rose-950/30 border border-rose-500/20 rounded-lg p-2">
                    {errorHint}
                  </div>
                )}
                <div>
                  <button
                    onClick={() => setShowErrorDetail((v) => !v)}
                    className="flex items-center gap-1 text-[10.5px] text-rose-300/80 hover:text-rose-200 font-mono transition-colors"
                  >
                    <span>{showErrorDetail ? '收起技术错误详情' : '展开技术错误详情'}</span>
                    <ChevronDown className={cn('w-3 h-3 transition-transform', showErrorDetail && 'rotate-180')} />
                  </button>
                  {showErrorDetail && (
                    <div className="mt-1.5 p-2 rounded-lg bg-black/40 border border-rose-500/20 font-mono text-[10px] break-words whitespace-pre-wrap text-rose-200/80 max-h-48 overflow-y-auto">
                      {renderableError}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Empty assistant fallback */}
        {!isUser && !renderableContent && !renderableThinking && !message.tools?.length && !message.askCard && !renderableError && (
          <div className="text-muted italic text-[11px]">
            （未收到模型回复内容）
          </div>
        )}

        {/* 这一轮的文件改动：在哪轮发生就在哪轮下面显示 */}
        {!isUser && message.tools?.length > 0 && (
          <TurnChanges
            tools={message.tools}
            fileopsByCall={fileopsByCall}
            onView={onViewChanges}
            onUndone={onChangesUndone}
          />
        )}
      </div>

      {/* 图片全屏放大预览 Modal */}
      {previewImage && (
        <div
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex flex-col items-center justify-center p-4 select-none animate-in fade-in duration-200"
          onClick={() => setPreviewImage(null)}
        >
          <div className="absolute top-4 right-4 flex items-center gap-2 z-10">
            <span className="text-white/70 text-xs font-mono max-w-md truncate px-3 py-1.5 rounded-lg bg-white/10 backdrop-blur-xs">
              {previewImage.name}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                setPreviewImage(null);
              }}
              className="p-2 rounded-xl bg-white/15 hover:bg-white/25 text-white transition-colors"
              title="关闭 (ESC)"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <div
            className="max-w-[92vw] max-h-[88vh] flex items-center justify-center p-2 cursor-default"
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={previewImage.src}
              alt={previewImage.name}
              className="max-w-full max-h-[85vh] rounded-xl object-contain shadow-2xl border border-white/10"
            />
          </div>
        </div>
      )}
    </div>
  );
}

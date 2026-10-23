import React, { useState, useRef, useEffect } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  PanelLeft,
  FileText,
  FolderOpen,
  Download,
  Edit2,
  RefreshCw,
  Sun,
  Moon,
  ShieldCheck,
  Brain,
  Boxes,
  Palette,
  MessageSquare,
  HelpCircle,
  Activity,
  Check,
} from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * 顶部系统级菜单栏（类似 Codex / VSCode 的原生极简风格）
 * 包含：后退、前进、折叠/展开侧栏、文件、编辑、视图、帮助
 */
export function TopMenuBar({
  canGoBack = false,
  canGoForward = false,
  onGoBack,
  onGoForward,
  showSidebar = true,
  onToggleSidebar,
  onNewSession,
  onPickDirectory,
  onSelectView,
  onToggleOutline,
  onToggleTheme,
  currentTheme = 'dark',
  activeSession = null,
  onClearDraft,
  onExportSession,
  onRenameSession,
}) {
  const [activeMenu, setActiveMenu] = useState(null); // 'file' | 'edit' | 'view' | 'help' | null
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const menuBarRef = useRef(null);

  // 点击外部或按 Esc 关闭下拉菜单
  useEffect(() => {
    if (!activeMenu) return;
    const handleDown = (e) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target)) {
        setActiveMenu(null);
      }
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') setActiveMenu(null);
    };
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [activeMenu]);

  const toggleMenu = (name) => {
    setActiveMenu((curr) => (curr === name ? null : name));
  };

  const handleMenuHover = (name) => {
    if (activeMenu) {
      setActiveMenu(name);
    }
  };

  const closeMenu = () => setActiveMenu(null);

  return (
    <div
      ref={menuBarRef}
      className="h-8 border-b border-app bg-[var(--bg-side)] px-2.5 flex items-center justify-between text-xs select-none drag-region shrink-0 z-40 text-sub"
    >
      {/* 左侧控制区：前进、后退、折叠侧栏、菜单栏 */}
      <div className="flex items-center gap-1 no-drag">
        {/* 后退与前进 */}
        <button
          type="button"
          onClick={onGoBack}
          disabled={!canGoBack}
          className={cn(
            'p-1 rounded transition-colors',
            canGoBack
              ? 'text-main hover:bg-[var(--bg-card)] cursor-pointer'
              : 'text-sub opacity-30 cursor-not-allowed hover:bg-transparent'
          )}
          title="后退 (Alt+Left)"
          aria-label="后退"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={onGoForward}
          disabled={!canGoForward}
          className={cn(
            'p-1 rounded transition-colors',
            canGoForward
              ? 'text-main hover:bg-[var(--bg-card)] cursor-pointer'
              : 'text-sub opacity-30 cursor-not-allowed hover:bg-transparent'
          )}
          title="前进 (Alt+Right)"
          aria-label="前进"
        >
          <ArrowRight className="w-3.5 h-3.5" />
        </button>

        {/* 侧栏折叠切换按钮 */}
        <button
          type="button"
          onClick={onToggleSidebar}
          className={cn(
            'p-1 rounded hover:bg-[var(--bg-card)] transition-colors mr-1.5',
            showSidebar ? 'text-sub hover:text-main' : 'text-[var(--accent)] bg-[var(--accent-glow)]'
          )}
          title={showSidebar ? '收起侧边栏 (Ctrl+B)' : '展开侧边栏 (Ctrl+B)'}
          aria-label="切换侧边栏"
        >
          <PanelLeft className="w-3.5 h-3.5" />
        </button>

        {/* 菜单项组 */}
        <div className="flex items-center gap-0.5 relative text-[11px]">
          {/* 1. 文件菜单 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => toggleMenu('file')}
              onMouseEnter={() => handleMenuHover('file')}
              className={cn(
                'px-2 py-0.5 rounded transition-colors',
                activeMenu === 'file'
                  ? 'bg-[var(--bg-card)] text-main font-medium'
                  : 'hover:bg-[var(--bg-card)] hover:text-main'
              )}
            >
              文件
            </button>
            {activeMenu === 'file' && (
              <div className="absolute top-full left-0 mt-1 w-52 bg-[var(--bg-elev)] border border-[var(--border-strong)] rounded-lg shadow-2xl py-1 z-50 text-xs text-main">
                <button
                  type="button"
                  onClick={() => { closeMenu(); onNewSession?.(); }}
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <span className="flex items-center gap-2">
                    <FileText className="w-3.5 h-3.5 text-muted" />
                    <span>新建对话</span>
                  </span>
                  <span className="text-[10px] text-muted font-mono">Ctrl+N</span>
                </button>
                <button
                  type="button"
                  onClick={() => { closeMenu(); onPickDirectory?.(); }}
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <span className="flex items-center gap-2">
                    <FolderOpen className="w-3.5 h-3.5 text-muted" />
                    <span>选择工作目录…</span>
                  </span>
                  <span className="text-[10px] text-muted font-mono">Ctrl+O</span>
                </button>
                <div className="border-t border-app my-1" />
                <button
                  type="button"
                  onClick={() => { closeMenu(); onRenameSession?.(); }}
                  disabled={!activeSession}
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left disabled:opacity-40"
                >
                  <span className="flex items-center gap-2">
                    <Edit2 className="w-3.5 h-3.5 text-muted" />
                    <span>重命名会话…</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => { closeMenu(); onExportSession?.(); }}
                  disabled={!activeSession}
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left disabled:opacity-40"
                >
                  <span className="flex items-center gap-2">
                    <Download className="w-3.5 h-3.5 text-muted" />
                    <span>导出当前对话</span>
                  </span>
                </button>
                <div className="border-t border-app my-1" />
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <span className="flex items-center gap-2">
                    <RefreshCw className="w-3.5 h-3.5 text-muted" />
                    <span>重新加载界面</span>
                  </span>
                  <span className="text-[10px] text-muted font-mono">F5</span>
                </button>
              </div>
            )}
          </div>

          {/* 2. 编辑菜单 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => toggleMenu('edit')}
              onMouseEnter={() => handleMenuHover('edit')}
              className={cn(
                'px-2 py-0.5 rounded transition-colors',
                activeMenu === 'edit'
                  ? 'bg-[var(--bg-card)] text-main font-medium'
                  : 'hover:bg-[var(--bg-card)] hover:text-main'
              )}
            >
              编辑
            </button>
            {activeMenu === 'edit' && (
              <div className="absolute top-full left-0 mt-1 w-48 bg-[var(--bg-elev)] border border-[var(--border-strong)] rounded-lg shadow-2xl py-1 z-50 text-xs text-main">
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    document.execCommand('copy');
                  }}
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <span>复制</span>
                  <span className="text-[10px] text-muted font-mono">Ctrl+C</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    closeMenu();
                    document.execCommand('selectAll');
                  }}
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <span>全选</span>
                  <span className="text-[10px] text-muted font-mono">Ctrl+A</span>
                </button>
                <div className="border-t border-app my-1" />
                <button
                  type="button"
                  onClick={() => { closeMenu(); onClearDraft?.(); }}
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <span>清空当前输入草稿</span>
                </button>
              </div>
            )}
          </div>

          {/* 3. 视图菜单 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => toggleMenu('view')}
              onMouseEnter={() => handleMenuHover('view')}
              className={cn(
                'px-2 py-0.5 rounded transition-colors',
                activeMenu === 'view'
                  ? 'bg-[var(--bg-card)] text-main font-medium'
                  : 'hover:bg-[var(--bg-card)] hover:text-main'
              )}
            >
              视图
            </button>
            {activeMenu === 'view' && (
              <div className="absolute top-full left-0 mt-1 w-52 bg-[var(--bg-elev)] border border-[var(--border-strong)] rounded-lg shadow-2xl py-1 z-50 text-xs text-main">
                <button
                  type="button"
                  onClick={() => { closeMenu(); onSelectView?.('chat'); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <MessageSquare className="w-3.5 h-3.5 text-muted" />
                  <span>对话工作台</span>
                </button>
                <button
                  type="button"
                  onClick={() => { closeMenu(); onToggleSidebar?.(); }}
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <span className="flex items-center gap-2">
                    <PanelLeft className="w-3.5 h-3.5 text-muted" />
                    <span>{showSidebar ? '收起侧边栏' : '展开侧边栏'}</span>
                  </span>
                  <span className="text-[10px] text-muted font-mono">Ctrl+B</span>
                </button>
                <button
                  type="button"
                  onClick={() => { closeMenu(); onToggleOutline?.(); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <FileText className="w-3.5 h-3.5 text-muted" />
                  <span>对话目录索引</span>
                </button>
                <div className="border-t border-app my-1" />
                <button
                  type="button"
                  onClick={() => { closeMenu(); onSelectView?.('cognition'); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <Brain className="w-3.5 h-3.5 text-muted" />
                  <span>AI 长期记忆与习惯</span>
                </button>
                <button
                  type="button"
                  onClick={() => { closeMenu(); onSelectView?.('models'); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <Boxes className="w-3.5 h-3.5 text-muted" />
                  <span>模型管理</span>
                </button>
                <button
                  type="button"
                  onClick={() => { closeMenu(); onSelectView?.('appearance'); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <Palette className="w-3.5 h-3.5 text-muted" />
                  <span>外观设置</span>
                </button>
                <button
                  type="button"
                  onClick={() => { closeMenu(); onSelectView?.('security'); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-muted" />
                  <span>安全规则</span>
                </button>
                <div className="border-t border-app my-1" />
                <button
                  type="button"
                  onClick={() => { closeMenu(); onToggleTheme?.(); }}
                  className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <span className="flex items-center gap-2">
                    {currentTheme === 'light' ? (
                      <Moon className="w-3.5 h-3.5 text-muted" />
                    ) : (
                      <Sun className="w-3.5 h-3.5 text-amber-400" />
                    )}
                    <span>切换主题 ({currentTheme === 'light' ? '浅色' : '深色'})</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* 4. 帮助菜单 */}
          <div className="relative">
            <button
              type="button"
              onClick={() => toggleMenu('help')}
              onMouseEnter={() => handleMenuHover('help')}
              className={cn(
                'px-2 py-0.5 rounded transition-colors',
                activeMenu === 'help'
                  ? 'bg-[var(--bg-card)] text-main font-medium'
                  : 'hover:bg-[var(--bg-card)] hover:text-main'
              )}
            >
              帮助
            </button>
            {activeMenu === 'help' && (
              <div className="absolute top-full left-0 mt-1 w-48 bg-[var(--bg-elev)] border border-[var(--border-strong)] rounded-lg shadow-2xl py-1 z-50 text-xs text-main">
                <button
                  type="button"
                  onClick={() => { closeMenu(); onSelectView?.('health'); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <Activity className="w-3.5 h-3.5 text-emerald-400" />
                  <span>系统健康与事件诊断</span>
                </button>
                <button
                  type="button"
                  onClick={() => { closeMenu(); setShortcutsOpen(true); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <HelpCircle className="w-3.5 h-3.5 text-muted" />
                  <span>快捷键参考</span>
                </button>
                <div className="border-t border-app my-1" />
                <button
                  type="button"
                  onClick={() => { closeMenu(); setAboutOpen(true); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--bg-card)] transition-colors text-left"
                >
                  <span>关于 Personal AI</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 顶部中央至右侧原生拖拽空白区（Codex 标杆：右侧为系统原生窗口最小化/最大化/关闭按钮保留空间） */}
      <div className="flex-1 h-full drag-region min-w-8" />

      {/* 快捷键参考模态框 */}
      {shortcutsOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-center justify-center p-4 no-drag">
          <div className="bg-[var(--bg-elev)] border border-[var(--border-strong)] rounded-xl max-w-sm w-full p-4 shadow-xl space-y-3">
            <div className="flex items-center justify-between pb-2 border-b border-app">
              <h3 className="font-semibold text-main text-xs flex items-center gap-2">
                <HelpCircle className="w-4 h-4 text-[var(--accent)]" />
                快捷键参考
              </h3>
              <button
                type="button"
                onClick={() => setShortcutsOpen(false)}
                className="text-sub hover:text-main text-xs"
              >
                ✕
              </button>
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex items-center justify-between py-1 border-b border-app/40">
                <span className="text-sub">发送消息</span>
                <span className="font-mono text-[11px] bg-[var(--bg-card)] px-1.5 py-0.5 rounded border border-app text-main">Enter</span>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-app/40">
                <span className="text-sub">换行</span>
                <span className="font-mono text-[11px] bg-[var(--bg-card)] px-1.5 py-0.5 rounded border border-app text-main">Shift + Enter</span>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-app/40">
                <span className="text-sub">展开/收起侧边栏</span>
                <span className="font-mono text-[11px] bg-[var(--bg-card)] px-1.5 py-0.5 rounded border border-app text-main">Ctrl + B</span>
              </div>
              <div className="flex items-center justify-between py-1 border-b border-app/40">
                <span className="text-sub">新建对话</span>
                <span className="font-mono text-[11px] bg-[var(--bg-card)] px-1.5 py-0.5 rounded border border-app text-main">Ctrl + N</span>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-sub">关闭弹窗 / 下拉</span>
                <span className="font-mono text-[11px] bg-[var(--bg-card)] px-1.5 py-0.5 rounded border border-app text-main">Esc</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 关于弹窗 */}
      {aboutOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-center justify-center p-4 no-drag">
          <div className="bg-[var(--bg-elev)] border border-[var(--border-strong)] rounded-xl max-w-sm w-full p-4 shadow-xl space-y-3 text-center">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#6e77e8] to-[#4f46e5] flex items-center justify-center mx-auto text-white shadow-md">
              <span className="font-bold text-sm">PAI</span>
            </div>
            <div>
              <h3 className="font-bold text-main text-sm">Personal AI</h3>
              <p className="text-[11px] text-muted mt-0.5">个人智能中枢控制宿主与桌面工作台</p>
            </div>
            <div className="text-[11px] text-sub bg-[var(--bg-card)] p-2.5 rounded-lg border border-app text-left space-y-1">
              <div><strong>执行身份：</strong>中立宿主 (Host) + 多身体适配</div>
              <div><strong>架构标准：</strong>零外部依赖 · 真七态交接 · 本地事实源</div>
            </div>
            <button
              type="button"
              onClick={() => setAboutOpen(false)}
              className="px-4 py-1.5 rounded-lg bg-[var(--bg-card)] hover:bg-[var(--border)] border border-app text-xs font-medium text-main transition-colors"
            >
              确定
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

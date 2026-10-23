import React, { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Search,
  MessageSquare,
  MessageSquarePlus,
  Activity,
  FileCode2,
  Brain,
  Settings,
  Pin,
  Folder,
  ChevronDown,
  Boxes,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  CircleDashed,
  Archive,
  Trash2,
  RotateCcw,
  FolderInput,
  MoreHorizontal,
  FolderPlus,
  Loader2,
  Palette,
  ShieldCheck,
  Cpu,
} from 'lucide-react';
import { cn, normPath, samePath } from '../../lib/utils';
import { sendCmd, pickDirectory } from '../../lib/api';
import { probeHealth, runHealthAction, relTime } from '../../lib/health';

const HEALTH_ICON = { ok: CheckCircle2, warn: AlertTriangle, err: XCircle, unknown: CircleDashed };
const HEALTH_COLOR = {
  ok: 'text-[var(--green-text)]',
  warn: 'text-[var(--amber-text)]',
  err: 'text-[var(--red-text)]',
  unknown: 'text-muted',
};

function projectName(dir) {
  if (!dir) return '通用项目';
  const clean = dir.replace(/[\\/]+$/, '');
  return clean.split(/[\\/]/).pop() || dir;
}

/**
 * 完全对齐 Codex 标杆的侧栏：
 * 1. 彻底移除左上角多余的 Personal AI 标题和收起侧栏按钮
 * 2. 移除独立的“新建对话”大按钮行
 * 3. 增加“最近”栏（支持折叠）
 * 4. “项目”栏支持折叠，且“新建项目”作为项目标题旁 hover 才显示的隐藏标签
 * 5. 每个具体项目名称旁边，新建对话(+)与详情(...)也是 hover 放上去才显示的隐藏标签
 * 6. 项目下无对话时显示“暂无聊天”
 */
export function Sidebar({
  sessions = [],
  activeSessionId,
  running = false,
  activeBody = 'pi',
  onSelectBody,
  onSelectSession,
  onNewSession,
  onPinSession,
  onArchiveSession,
  onDeleteSession,
  onSwitchProject,
  onChangeSessionProject,
  currentView,
  onSelectView,
  workdir = '',
  refreshNonce = 0,
}) {
  const [filter, setFilter] = useState('');
  const [health, setHealth] = useState(null);
  const [badges, setBadges] = useState({ jobsOpen: 0, jobsStale: 0, pending: 0 });
  const [busyAction, setBusyAction] = useState(null);

  // 折叠状态
  const [recentCollapsed, setRecentCollapsed] = useState(false);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState(new Set());
  const [showArchived, setShowArchived] = useState(false);

  // 弹窗状态
  const [workspaces, setWorkspaces] = useState([]);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [moveSessionModal, setMoveSessionModal] = useState(null); // { session }
  const [projectDetailModal, setProjectDetailModal] = useState(null); // { path, name, count }

  // 对话右键上下文菜单（满足保持优雅，切换目录保留对话右键）
  const [contextMenu, setContextMenu] = useState(null); // { x, y, session }
  const contextMenuRef = useRef(null);

  useEffect(() => {
    if (!contextMenu) return;
    const handleClose = (e) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target)) {
        setContextMenu(null);
      }
    };
    const handleKey = (e) => {
      if (e.key === 'Escape') setContextMenu(null);
    };
    document.addEventListener('mousedown', handleClose);
    document.addEventListener('keydown', handleKey);
    window.addEventListener('scroll', handleClose, true);
    return () => {
      document.removeEventListener('mousedown', handleClose);
      document.removeEventListener('keydown', handleKey);
      window.removeEventListener('scroll', handleClose, true);
    };
  }, [contextMenu]);

  const refreshWorkspaces = async () => {
    try {
      const res = await sendCmd('workspace_list');
      if (res.success && Array.isArray(res.data?.workspaces)) {
        setWorkspaces(res.data.workspaces);
      }
    } catch {}
  };

  const refreshHealth = async () => {
    try { setHealth(await probeHealth()); } catch {}
  };

  const refreshBadges = async () => {
    const [tasks, wm] = await Promise.all([
      sendCmd('task_list'),
      sendCmd('world_model_status', { limit: 1 }),
    ]);
    const list = tasks.success && Array.isArray(tasks.data) ? tasks.data : [];
    const open = list.filter((t) => (t.state ?? 'open') === 'open');
    const proposals = wm.success && Array.isArray(wm.data?.proposals) ? wm.data.proposals : [];
    setBadges({
      jobsOpen: open.filter((t) => !t.stale).length,
      jobsStale: open.filter((t) => t.stale).length,
      pending: proposals.filter((p) => p.status === 'proposed').length,
    });
  };

  useEffect(() => {
    refreshWorkspaces();
    refreshHealth();
    refreshBadges();
    const h = setInterval(refreshHealth, 60_000);
    const b = setInterval(refreshBadges, 15_000);
    return () => { clearInterval(h); clearInterval(b); };
  }, []);

  useEffect(() => {
    if (refreshNonce === 0) return;
    refreshWorkspaces();
    refreshHealth();
    refreshBadges();
  }, [refreshNonce]);

  const handleHealthAction = async (item) => {
    const a = item.action;
    if (!a) return;
    if (a.kind === 'nav') { onSelectView(a.view); return; }
    setBusyAction(item.id);
    try {
      await runHealthAction(a);
    } finally {
      setBusyAction(null);
      refreshHealth();
    }
  };

  const handleOpenNewProject = async () => {
    const dir = await pickDirectory();
    if (dir) {
      await sendCmd('workspace_add', { path: dir });
      if (onSwitchProject) await onSwitchProject(dir);
      await refreshWorkspaces();
    }
  };

  const toggleSingleProjectCollapse = (key) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // 整理所有已知项目列表（使用 normPath 统一去重，避免 Windows 盘符大小写或斜杠造成分身）
  const allProjectPaths = [];
  const seenNormPaths = new Set();
  const rawCandidatePaths = [
    ...(workdir ? [workdir] : []),
    ...workspaces.map((w) => w.path),
    ...sessions.map((s) => s.cwd).filter(Boolean),
  ];
  for (const raw of rawCandidatePaths) {
    if (!raw) continue;
    const n = normPath(raw);
    if (!seenNormPaths.has(n)) {
      seenNormPaths.add(n);
      allProjectPaths.push(raw);
    }
  }

  if (allProjectPaths.length === 0 && workdir) {
    allProjectPaths.push(workdir);
  }

  // 会话过滤
  const matchesSearch = (s) =>
    !filter.trim() || s.title?.toLowerCase().includes(filter.toLowerCase());

  const activeSessions = sessions.filter((s) => !s.archived && matchesSearch(s));
  const archivedSessions = sessions.filter((s) => s.archived && matchesSearch(s));

  // 置顶对话与最近活跃对话
  const pinnedSessions = activeSessions.filter((s) => s.pinned);
  const sortedByTime = [...activeSessions].sort((a, b) =>
    String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
  );
  // 最近栏展示最近活跃的 6 条对话
  const recentSessions = sortedByTime.slice(0, 6);

  // 独立快速对话（默认无项目绑定，纯粹自由开聊）
  const standaloneSessions = activeSessions.filter((s) => !s.cwd);

  // 各项目的对话映射（按规范化路径聚合，杜绝跨项目闪现和匹配失效）
  const projectGroups = {};
  for (const p of allProjectPaths) {
    projectGroups[normPath(p)] = [];
  }

  for (const s of activeSessions) {
    if (!s.cwd) continue; // 快速独立会话不强行塞入任何项目文件夹
    const sNorm = normPath(s.cwd);
    if (projectGroups[sNorm]) {
      projectGroups[sNorm].push(s);
    }
  }

  for (const normKey of Object.keys(projectGroups)) {
    projectGroups[normKey].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
    });
  }

  const overall = health?.overall ?? 'unknown';
  const HealthIcon = HEALTH_ICON[overall];
  const healthTitle = health ? `${health.label}（检查于 ${relTime(health.at)}）` : '正在检查…';

  const renderSessionItem = (s, showProjectTag = false) => {
    const isActive = s.id === activeSessionId && currentView === 'chat';
    const isRunning = (running && s.id === activeSessionId) || Boolean(s.running) || s.status === 'running';
    return (
      <div
        key={s.id}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setContextMenu({ x: e.clientX, y: e.clientY, session: s });
        }}
        className={cn(
          'group relative w-full rounded-md text-xs flex items-center justify-between transition-all px-2 py-1',
          isActive
            ? 'bg-[var(--accent-glow)] text-main font-medium border border-[var(--accent)]/40 shadow-xs'
            : 'text-sub hover:bg-[var(--border)] hover:text-main border border-transparent'
        )}
      >
        <button
          onClick={() => { onSelectSession(s.path || s.id); onSelectView('chat'); }}
          className="flex-1 flex items-center gap-1.5 truncate text-left mr-1 py-0.5"
          title={`${s.title || '无标题对话'}${s.cwd ? `\n[项目: ${projectName(s.cwd)}]` : ''}`}
        >
          {s.pinned && (
            <Pin className="w-3 h-3 text-[var(--accent)] shrink-0" />
          )}
          {isRunning && (
            <Loader2 className="w-3 h-3 text-[var(--accent)] animate-spin shrink-0" title="正在运行中" />
          )}
          <span className="truncate">{s.title || '无标题对话'}</span>
          {showProjectTag && s.cwd && s.cwd !== workdir && (
            <span className="text-[10px] text-muted truncate max-w-[70px] ml-1">
              · {projectName(s.cwd)}
            </span>
          )}
        </button>

        {/* 悬浮操作按钮组 */}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onPinSession?.(s.path, !s.pinned); }}
            className={cn('p-1 rounded hover:bg-[var(--bg)] transition-colors', s.pinned ? 'text-[var(--accent)]' : 'text-muted hover:text-main')}
            title={s.pinned ? '取消置顶' : '置顶'}
            aria-label={s.pinned ? '取消置顶' : '置顶'}
          >
            <Pin className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setMoveSessionModal(s); }}
            className="p-1 rounded hover:bg-[var(--bg)] text-muted hover:text-[var(--accent)] transition-colors"
            title="移动到其他项目"
            aria-label="移动到其他项目"
          >
            <FolderInput className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onArchiveSession?.(s.path, true); }}
            className="p-1 rounded hover:bg-[var(--bg)] text-muted hover:text-[var(--accent)] transition-colors"
            title="归档"
            aria-label="归档对话"
          >
            <Archive className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setDeleteConfirm(s); }}
            className="p-1 rounded hover:bg-[var(--bg)] text-muted hover:text-rose-400 transition-colors"
            title="删除"
            aria-label="删除对话"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  };

  return (
    <aside className="w-64 h-full bg-side border-r border-app flex flex-col justify-between shrink-0 select-none">
      {/* 顶部操作区：新建聊天（默认无项目，快速开启纯净对话） + 搜索栏 */}
      <div className="p-2.5 pb-2 space-y-2 border-b border-app">
        <button
          type="button"
          onClick={() => {
            onNewSession?.();
            onSelectView?.('chat');
          }}
          className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-[var(--bg-card)] hover:bg-[var(--border)] border border-app text-main text-xs font-medium transition-colors cursor-pointer select-none shadow-xs"
          title="新建对话 (默认无项目，快速直接开聊)"
          aria-label="新建对话"
        >
          <MessageSquarePlus className="w-3.5 h-3.5 text-[var(--accent)]" />
          <span>新建聊天</span>
        </button>

        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-muted" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索聊天…"
            aria-label="搜索聊天"
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-app hover:bg-elev focus:bg-elev border border-app focus:border-[var(--accent)] rounded-md text-main placeholder:text-muted outline-none transition-all"
          />
        </div>
      </div>

      {/* 核心列表区：快速对话 (无项目) + 置顶 (最上) + 项目 (中间主体) + 最近 (最下) */}
      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-3">
        {/* 0. 快速独立对话（默认无项目，直接开启的对话） */}
        {standaloneSessions.length > 0 && (
          <div className="space-y-0.5">
            <div className="px-2 py-0.5 text-[11px] font-medium text-muted">
              快速对话
            </div>
            <div className="space-y-0.5">
              {standaloneSessions.map((s) => renderSessionItem(s, false))}
            </div>
          </div>
        )}

        {/* 1. 置顶栏 (若有置顶会话，置于最顶端) */}
        {pinnedSessions.length > 0 && (
          <div className="space-y-0.5">
            <div className="px-2 py-1 text-[11px] font-medium text-muted">
              置顶
            </div>
            <div className="space-y-0.5">
              {pinnedSessions.map((s) => renderSessionItem(s, true))}
            </div>
          </div>
        )}

        {/* 2. 项目栏 (核心主体，可折叠) */}
        <div className="space-y-1">
          <div className="group/projheader flex items-center justify-between px-2 py-1 text-[11px] font-medium text-muted hover:text-main">
            <button
              onClick={() => setProjectsCollapsed(!projectsCollapsed)}
              className="flex-1 flex items-center gap-1 text-left"
            >
              <ChevronDown className={cn('w-3 h-3 transition-transform', projectsCollapsed && '-rotate-90')} />
              <span>项目</span>
            </button>

            {/* 新建项目隐藏标签：放上去才显示 */}
            <button
              onClick={handleOpenNewProject}
              className="opacity-0 group-hover/projheader:opacity-100 transition-opacity p-0.5 rounded hover:bg-[var(--border)] text-muted hover:text-main"
              title="新建/打开项目"
              aria-label="新建项目"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

          {!projectsCollapsed && (
            <div className="space-y-1">
              {allProjectPaths.map((pKey) => {
                const isSingleCollapsed = collapsedProjects.has(pKey);
                const isCurrentActive = samePath(pKey, workdir);
                const pName = projectName(pKey);
                const pSessions = projectGroups[normPath(pKey)] || [];

                return (
                  <div key={pKey} className="space-y-0.5">
                    {/* 项目条目：放上去才显示新建对话(+)和详情(...)标签 */}
                    <div
                      className={cn(
                        'group/projitem w-full flex items-center justify-between px-2 py-1.5 rounded-md text-xs transition-colors select-none',
                        isCurrentActive
                          ? 'bg-[var(--bg-elev)] text-main font-medium'
                          : 'text-sub hover:bg-[var(--border)] hover:text-main'
                      )}
                    >
                      <button
                        onClick={() => toggleSingleProjectCollapse(pKey)}
                        className="flex-1 flex items-center gap-1.5 truncate text-left mr-1"
                        title={pKey}
                      >
                        <Folder className="w-3.5 h-3.5 shrink-0 text-muted group-hover/projitem:text-main" />
                        <span className="truncate">{pName}</span>
                      </button>

                      {/* 放上去才显示的新建对话与更多按钮 */}
                      <div className="flex items-center gap-0.5 opacity-0 group-hover/projitem:opacity-100 transition-opacity shrink-0">
                        <button
                          onClick={() => {
                            setProjectDetailModal({ path: pKey, name: pName, count: pSessions.length });
                          }}
                          className="p-1 rounded hover:bg-[var(--bg)] text-muted hover:text-main"
                          title="项目选项"
                          aria-label="项目选项"
                        >
                          <MoreHorizontal className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => {
                            onNewSession(pKey);
                            onSelectView('chat');
                          }}
                          className="p-1 rounded hover:bg-[var(--bg)] text-muted hover:text-[var(--accent)]"
                          title={`在此项目新建对话`}
                          aria-label="新建对话"
                        >
                          <Plus className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* 项目下的对话列表 */}
                    {!isSingleCollapsed && (
                      <div className="pl-3.5 space-y-0.5 py-0.5">
                        {pSessions.length === 0 ? (
                          <div className="py-0.5 px-2 text-[11px] text-muted/50 select-none">
                            暂无聊天
                          </div>
                        ) : (
                          pSessions.map((s) => renderSessionItem(s, false))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 3. 最近栏 (放在最下面，可折叠) */}
        <div className="space-y-0.5 pt-2 border-t border-app">
          <button
            onClick={() => setRecentCollapsed(!recentCollapsed)}
            className="w-full flex items-center justify-between px-2 py-1 text-[11px] font-medium text-muted hover:text-main transition-colors"
          >
            <span className="flex items-center gap-1">
              <ChevronDown className={cn('w-3 h-3 transition-transform', recentCollapsed && '-rotate-90')} />
              <span>最近</span>
            </span>
          </button>

          {!recentCollapsed && (
            <div className="space-y-0.5">
              {recentSessions.length === 0 ? (
                <div className="px-3 py-1 text-[11px] text-muted/60 select-none">
                  暂无最近聊天
                </div>
              ) : (
                recentSessions.map((s) => renderSessionItem(s, true))
              )}
            </div>
          )}
        </div>

        {/* 4. 已归档栏 (可折叠) */}
        {archivedSessions.length > 0 && (
          <div className="pt-2 border-t border-app mt-2">
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="w-full flex items-center justify-between px-2 py-1 text-xs text-muted hover:text-main rounded hover:bg-[var(--border)] transition-colors"
            >
              <span className="flex items-center gap-1.5">
                <Archive className="w-3 h-3 text-muted" />
                已归档 ({archivedSessions.length})
              </span>
              <ChevronDown className={cn('w-3 h-3 transition-transform', !showArchived && '-rotate-90')} />
            </button>

            {showArchived && (
              <div className="space-y-0.5 mt-1 pl-1">
                {archivedSessions.map((s) => (
                  <div
                    key={s.id}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setContextMenu({ x: e.clientX, y: e.clientY, session: s });
                    }}
                    className="group flex items-center justify-between px-2 py-1 rounded-md hover:bg-[var(--border)] text-muted hover:text-main text-xs transition-colors select-none"
                  >
                    <span className="truncate flex-1" title={s.title}>{s.title || '无标题任务'}</span>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <button
                        onClick={() => onArchiveSession?.(s.path, false)}
                        className="p-1 rounded hover:bg-[var(--bg)] text-muted hover:text-[var(--accent)] transition-colors"
                        title="恢复"
                        aria-label="恢复归档"
                      >
                        <RotateCcw className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => setDeleteConfirm(s)}
                        className="p-1 rounded hover:bg-[var(--bg)] text-muted hover:text-rose-400 transition-colors"
                        title="彻底删除"
                        aria-label="彻底删除"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部系统状态与引擎栏：一切正常与 PI 放在同一列/同一行 */}
      <div className="p-2 border-t border-app flex items-center justify-between gap-1.5 shrink-0">
        {/* 健康状态行 */}
        <button
          id="sidebar-health"
          onClick={() => onSelectView('health')}
          title={healthTitle}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs transition-colors border flex-1 min-w-0 text-left cursor-pointer',
            currentView === 'health'
              ? 'bg-[var(--bg-card)] border-[var(--border-strong)] text-main font-medium'
              : 'border-transparent hover:bg-[var(--bg-card)]'
          )}
        >
          <HealthIcon className={cn('w-3.5 h-3.5 shrink-0', HEALTH_COLOR[overall])} />
          <span className={cn('truncate text-xs', overall === 'err' ? 'text-[var(--red-text)]' : 'text-sub')}>
            {health?.label ?? '正在检查…'}
          </span>
        </button>

        {/* PI 引擎徽标（点击管理与切换） */}
        <button
          id="sidebar-engine"
          onClick={onSelectBody}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-[var(--bg-card)] hover:bg-[var(--border)] border border-[var(--border-strong)] text-main transition-colors shrink-0 font-mono font-semibold uppercase tracking-wider cursor-pointer"
          title={`当前 AI 引擎：${activeBody || 'pi'}（点击管理与切换）`}
          aria-label="管理与切换 AI 引擎"
        >
          <Cpu className="w-3 h-3 text-[var(--accent)]" />
          <span>{activeBody || 'pi'}</span>
        </button>
      </div>

      {health?.problems?.filter((p) => p.action).map((p) => (
        <div key={p.id} className="flex items-center justify-between gap-2 px-3 py-1 bg-amber-500/10 border-t border-amber-500/20 text-[11px]">
          <span className="text-amber-300 truncate">{p.name}</span>
          <button
            onClick={() => handleHealthAction(p)}
            disabled={busyAction === p.id}
            className="shrink-0 px-2 py-0.5 rounded bg-[#4f58c7] hover:bg-[#4338ca] disabled:opacity-60 text-white text-[10px] font-medium transition-colors"
          >
            {busyAction === p.id ? '处理中…' : p.action.label}
          </button>
        </div>
      ))}

      {/* 项目详情浮层卡片 (Codex 样式) */}
      {projectDetailModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[var(--bg-elev)] border border-[var(--border-strong)] rounded-xl max-w-sm w-full p-4 shadow-xl space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-main text-sm flex items-center gap-2">
                <Folder className="w-4 h-4 text-[var(--accent)]" />
                {projectDetailModal.name}
              </h3>
              <button
                onClick={() => setProjectDetailModal(null)}
                className="text-sub hover:text-main text-xs"
              >
                ✕
              </button>
            </div>
            <div className="space-y-1.5 text-xs text-sub py-1">
              <div className="flex items-center gap-2">
                <span className="text-muted">会话数量:</span>
                <span className="text-main font-mono">{projectDetailModal.count} 次聊天</span>
              </div>
              <div className="space-y-0.5">
                <span className="text-muted block">物理路径:</span>
                <code className="block bg-app px-2 py-1 rounded text-[11px] font-mono text-main break-all border border-app select-all">
                  {projectDetailModal.path}
                </code>
              </div>
            </div>
            <div className="flex justify-between items-center pt-2 border-t border-app">
              <div className="flex items-center gap-2">
                {!samePath(projectDetailModal.path, workdir) ? (
                  <button
                    onClick={async () => {
                      const target = projectDetailModal.path;
                      setProjectDetailModal(null);
                      if (onSwitchProject) await onSwitchProject(target);
                    }}
                    className="px-3 py-1.5 rounded-lg bg-[var(--accent)] hover:opacity-90 text-white text-xs font-medium transition-colors"
                  >
                    设为当前工作区
                  </button>
                ) : (
                  <span className="text-[11px] text-[var(--green-text)] font-medium">当前活动工作区</span>
                )}

                {!samePath(projectDetailModal.path, workdir) ? (
                  <button
                    onClick={async () => {
                      if (confirm(`确定从项目列表中移除「${projectDetailModal.name}」吗？（不会删除实际磁盘文件）`)) {
                        await sendCmd('workspace_remove', { path: projectDetailModal.path });
                        await refreshWorkspaces();
                        setProjectDetailModal(null);
                      }
                    }}
                    className="px-2.5 py-1.5 rounded-lg border border-rose-500/30 hover:bg-rose-500/10 text-xs text-rose-400 hover:text-rose-300 transition-colors flex items-center gap-1"
                    title="从侧边栏列表中移除此项目"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>移除项目</span>
                  </button>
                ) : (
                  allProjectPaths.length > 1 && (
                    <button
                      onClick={async () => {
                        const other = allProjectPaths.find((p) => !samePath(p, workdir));
                        if (confirm(`「${projectDetailModal.name}」是当前活动项目。点击确定将先切换到「${projectName(other)}」并从列表中移除此项目。`)) {
                          if (onSwitchProject) await onSwitchProject(other);
                          await sendCmd('workspace_remove', { path: projectDetailModal.path });
                          await refreshWorkspaces();
                          setProjectDetailModal(null);
                        }
                      }}
                      className="px-2.5 py-1.5 rounded-lg border border-rose-500/30 hover:bg-rose-500/10 text-xs text-rose-400 hover:text-rose-300 transition-colors flex items-center gap-1"
                      title="切换并从列表中移除此项目"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>移除项目</span>
                    </button>
                  )
                )}
              </div>
              <button
                onClick={() => setProjectDetailModal(null)}
                className="px-3 py-1.5 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-card)] text-xs text-sub transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 对话右键上下文菜单（保持优雅，切换目录保留对话右键） */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          style={{
            top: Math.min(contextMenu.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 220),
            left: Math.min(contextMenu.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 220),
          }}
          className="fixed z-50 w-52 bg-[var(--bg-elev)] border border-[var(--border-strong)] rounded-xl shadow-2xl py-1 text-xs select-none backdrop-blur-md"
        >
          <div className="px-3 py-1.5 text-[10px] text-muted truncate border-b border-app font-semibold">
            {contextMenu.session.title || '对话操作'}
          </div>
          <button
            onClick={() => {
              const s = contextMenu.session;
              setContextMenu(null);
              setMoveSessionModal(s);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-main hover:bg-[var(--bg-card)] transition-colors cursor-pointer"
          >
            <FolderInput className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span>切换目录 / 移动到项目…</span>
          </button>
          <button
            onClick={() => {
              const s = contextMenu.session;
              setContextMenu(null);
              onPinSession?.(s.path, !s.pinned);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-main hover:bg-[var(--bg-card)] transition-colors cursor-pointer"
          >
            <Pin className="w-3.5 h-3.5 text-muted" />
            <span>{contextMenu.session.pinned ? '取消置顶' : '置顶对话'}</span>
          </button>
          <button
            onClick={() => {
              const s = contextMenu.session;
              setContextMenu(null);
              onArchiveSession?.(s.path, !contextMenu.session.archived);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-main hover:bg-[var(--bg-card)] transition-colors cursor-pointer"
          >
            <Archive className="w-3.5 h-3.5 text-muted" />
            <span>{contextMenu.session.archived ? '取消归档' : '归档对话'}</span>
          </button>
          <div className="border-t border-app my-1" />
          <button
            onClick={() => {
              const s = contextMenu.session;
              setContextMenu(null);
              setDeleteConfirm(s);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>删除对话</span>
          </button>
        </div>
      )}

      {/* 转移对话至其他项目弹窗 */}
      {moveSessionModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[var(--bg-elev)] border border-[var(--border-strong)] rounded-xl max-w-sm w-full p-4 shadow-xl space-y-3">
            <h3 className="font-semibold text-main text-sm flex items-center gap-2">
              <FolderInput className="w-4 h-4 text-[var(--accent)]" />
              将对话移动到项目
            </h3>
            <p className="text-xs text-sub leading-relaxed">
              选择对话「<span className="text-main font-medium">{moveSessionModal.title || '此对话'}</span>」归属的目标项目：
            </p>
            <div className="max-h-48 overflow-y-auto space-y-1 py-1">
              {allProjectPaths.map((p) => {
                const isCur = (moveSessionModal.cwd || workdir) === p;
                return (
                  <button
                    key={p}
                    onClick={async () => {
                      const target = moveSessionModal;
                      setMoveSessionModal(null);
                      if (onChangeSessionProject) {
                        await onChangeSessionProject(target.path, p);
                      }
                    }}
                    className={cn(
                      'w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs text-left transition-colors border',
                      isCur
                        ? 'border-[var(--accent)] bg-[var(--accent-glow)] text-main font-medium'
                        : 'border-[var(--border)] hover:bg-[var(--bg-card)] text-sub hover:text-main'
                    )}
                  >
                    <span className="truncate flex-1 font-mono">{projectName(p)}</span>
                    {isCur && <span className="text-[10px] text-[var(--accent)] ml-2">当前归属</span>}
                  </button>
                );
              })}
            </div>
            <div className="flex justify-between items-center pt-2 border-t border-app">
              <button
                onClick={async () => {
                  const target = moveSessionModal;
                  const dir = await pickDirectory();
                  if (dir) {
                    setMoveSessionModal(null);
                    await sendCmd('workspace_add', { path: dir });
                    if (onChangeSessionProject) {
                      await onChangeSessionProject(target.path, dir);
                    }
                  }
                }}
                className="text-xs text-[var(--accent)] hover:underline flex items-center gap-1"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                选择新目录…
              </button>
              <button
                onClick={() => setMoveSessionModal(null)}
                className="px-3 py-1.5 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-card)] text-xs text-sub transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除会话确认弹窗 */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[var(--bg-elev)] border border-[var(--border-strong)] rounded-xl max-w-sm w-full p-4 shadow-xl space-y-3">
            <h3 className="font-semibold text-main text-sm flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-rose-500" />
              确认删除对话
            </h3>
            <p className="text-xs text-sub leading-relaxed">
              确定要删除对话「<span className="text-main font-medium">{deleteConfirm.title || '该对话'}</span>」吗？
              <br />此操作将永久移除该历史会话记录，无法恢复。
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-3 py-1.5 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-card)] text-xs text-sub hover:text-main transition-colors"
              >
                取消
              </button>
              <button
                onClick={async () => {
                  const target = deleteConfirm;
                  setDeleteConfirm(null);
                  if (onDeleteSession) await onDeleteSession(target.path);
                }}
                className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-medium transition-colors"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

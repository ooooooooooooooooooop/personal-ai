import React from 'react';
import {
  Home,
  MessageSquarePlus,
  Brain,
  ShieldCheck,
  Boxes,
  Palette,
  Settings,
} from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * 最左侧独立图标导航列（Codex 标杆）：
 * 1. 独立极简列，仅保留图标
 * 2. 鼠标悬浮即刻浮现功能文字提示
 * 3. 顶部包含专属首页图标（回到主对话工作台）
 * 4. 彻底删除后台任务、文件变更等非必要入口，专注于核心工作流与系统设置
 */
export function NavigationRail({
  currentView = 'chat',
  onSelectView,
  onNewSession,
}) {
  const topItems = [
    {
      id: 'chat',
      label: '首页',
      icon: Home,
      onClick: () => onSelectView('chat'),
      isSpecialHome: true,
    },
    {
      id: 'new-chat',
      label: '新建对话',
      icon: MessageSquarePlus,
      onClick: () => {
        onNewSession?.();
        onSelectView('chat');
      },
    },
    {
      id: 'cognition',
      label: '认知与记忆',
      icon: Brain,
      onClick: () => onSelectView('cognition'),
    },
  ];

  const bottomItems = [
    {
      id: 'security',
      label: '安全规则',
      icon: ShieldCheck,
      onClick: () => onSelectView('security'),
    },
    {
      id: 'models',
      label: '模型管理',
      icon: Boxes,
      onClick: () => onSelectView('models'),
    },
    {
      id: 'appearance',
      label: '外观设置',
      icon: Palette,
      onClick: () => onSelectView('appearance'),
    },
    {
      id: 'health',
      label: '系统健康与设置',
      icon: Settings,
      onClick: () => onSelectView('health'),
    },
  ];

  return (
    <aside
      id="nav-rail"
      className="w-12 bg-[var(--bg-side)] border-r border-app flex flex-col items-center py-2 shrink-0 select-none z-30"
      aria-label="主功能导航"
    >
      {/* 顶部主功能图标组 */}
      <nav className="flex flex-col items-center gap-1.5 w-full px-1.5" aria-label="核心功能">
        {topItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <div key={item.id} className="relative group flex items-center justify-center">
              <button
                type="button"
                onClick={item.onClick}
                aria-label={item.label}
                title={item.label}
                className={cn(
                  'w-9 h-9 rounded-xl flex items-center justify-center transition-all cursor-pointer',
                  item.isSpecialHome && isActive
                    ? 'bg-[var(--accent)] text-white shadow-sm'
                    : isActive
                    ? 'bg-[var(--bg-card)] text-[var(--accent)] border border-[var(--border-strong)] shadow-xs'
                    : 'text-sub hover:text-main hover:bg-[var(--bg-card)]'
                )}
              >
                <Icon className="w-4 h-4" />
                <span className="sr-only">{item.label}</span>
              </button>

              {/* 悬浮气泡提示 */}
              <div className="pointer-events-none absolute left-full ml-2.5 px-2.5 py-1 rounded-md bg-[var(--bg-elev)] text-main text-xs border border-[var(--border-strong)] shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150 whitespace-nowrap z-50">
                {item.label}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* 底部设置与管理图标组 */}
      <nav className="flex flex-col items-center gap-1.5 w-full px-1.5" aria-label="管理与设置">
        {bottomItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <div key={item.id} className="relative group flex items-center justify-center">
              <button
                type="button"
                onClick={item.onClick}
                aria-label={item.label}
                title={item.label}
                className={cn(
                  'w-9 h-9 rounded-xl flex items-center justify-center transition-all cursor-pointer',
                  isActive
                    ? 'bg-[var(--bg-card)] text-[var(--accent)] border border-[var(--border-strong)] shadow-xs'
                    : 'text-sub hover:text-main hover:bg-[var(--bg-card)]'
                )}
              >
                <Icon className="w-4 h-4" />
                <span className="sr-only">{item.label}</span>
              </button>

              {/* 悬浮气泡提示 */}
              <div className="pointer-events-none absolute left-full ml-2.5 px-2.5 py-1 rounded-md bg-[var(--bg-elev)] text-main text-xs border border-[var(--border-strong)] shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150 whitespace-nowrap z-50">
                {item.label}
              </div>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

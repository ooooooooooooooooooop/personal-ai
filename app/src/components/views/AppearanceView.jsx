import React, { useState, useEffect } from 'react';
import { Palette, Check, Sun, Moon } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * 外观设置视图：独立的第一级视图
 * 直接展示主题偏好与界面显示样式
 */
export function AppearanceView() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('pai_theme') || 'dark';
    } catch {
      return 'dark';
    }
  });

  const handleSetTheme = (t) => {
    setTheme(t);
    try {
      localStorage.setItem('pai_theme', t);
      document.documentElement.classList.toggle('light', t === 'light');
      document.documentElement.classList.toggle('dark', t !== 'light');
      document.documentElement.setAttribute('data-theme', t);
      window.dispatchEvent(new CustomEvent('pai_theme_changed', { detail: { theme: t } }));
    } catch {}
  };

  useEffect(() => {
    const handleThemeChange = (e) => {
      if (e.detail?.theme) setTheme(e.detail.theme);
    };
    window.addEventListener('pai_theme_changed', handleThemeChange);
    return () => window.removeEventListener('pai_theme_changed', handleThemeChange);
  }, []);

  return (
    <div className="flex-1 overflow-y-auto p-6 text-xs text-main bg-app select-none">
      <div className="max-w-2xl space-y-6">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Palette className="w-5 h-5 text-[var(--accent)]" />
            <h2 className="text-base font-bold text-main">外观</h2>
          </div>
          <p className="text-muted text-xs">自定义客户端界面主题显示风格。</p>
        </div>

        <div className="space-y-3">
          <h3 className="text-xs font-semibold text-muted uppercase tracking-wider">
            主题方案
          </h3>
          <div className="grid grid-cols-2 gap-3">
            {[
              {
                id: 'dark',
                name: '深色模式',
                desc: '暗色背景，沉浸舒适，适合低光环境',
                icon: Moon,
              },
              {
                id: 'light',
                name: '浅色模式',
                desc: '明亮背景，清晰雅致，适合光线充足环境',
                icon: Sun,
              },
            ].map((t) => {
              const Icon = t.icon;
              const isSelected = theme === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handleSetTheme(t.id)}
                  aria-pressed={isSelected}
                  className={cn(
                    'p-4 rounded-xl border text-left transition-all bg-[var(--bg-elev)] cursor-pointer relative',
                    isSelected
                      ? 'border-[var(--accent)] shadow-sm ring-1 ring-[var(--accent)]/30'
                      : 'border-[var(--border)] hover:border-[var(--border-strong)]'
                  )}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2.5 mb-2">
                      <div
                        className={cn(
                          'w-7 h-7 rounded-lg flex items-center justify-center',
                          isSelected
                            ? 'bg-[var(--accent-glow)] text-[var(--accent)]'
                            : 'bg-[var(--bg-card)] text-muted'
                        )}
                      >
                        <Icon className="w-4 h-4" />
                      </div>
                      <span className="font-semibold text-main text-xs">{t.name}</span>
                    </div>
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
                  <p className="text-[11px] text-muted leading-relaxed">{t.desc}</p>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export default AppearanceView;

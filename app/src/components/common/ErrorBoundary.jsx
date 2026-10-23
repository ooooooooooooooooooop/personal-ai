import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('[React ErrorBoundary caught error]:', error, errorInfo);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen flex flex-col items-center justify-center bg-[#0e0e12] text-[#f4f4f7] p-6 text-center select-none font-sans">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/25 flex items-center justify-center text-amber-400 mb-4 shadow-[0_0_24px_rgba(245,158,11,0.2)]">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h1 className="text-base font-semibold mb-2 text-white">界面渲染遇到异常</h1>
          <p className="text-xs text-white/60 max-w-md mb-6 leading-relaxed">
            {this.state.error?.message || '组件在渲染过程中发生未预期的错误，但后台核心服务仍正常运行。'}
          </p>
          <div className="flex items-center gap-3">
            <button
              onClick={this.handleReload}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#6e77e8] hover:bg-[#5b64dc] text-white text-xs font-medium shadow-[0_0_16px_rgba(110,119,232,0.4)] transition-all active:scale-95 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>重新加载界面</span>
            </button>
            <button
              onClick={() => {
                try {
                  for (let i = localStorage.length - 1; i >= 0; i--) {
                    const key = localStorage.key(i);
                    if (key && (key.startsWith('pai_') || key.startsWith('draft_'))) {
                      localStorage.removeItem(key);
                    }
                  }
                } catch {}
                window.location.reload();
              }}
              className="px-3.5 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.1] text-white/70 hover:text-white text-xs font-medium border border-white/[0.08] transition-all cursor-pointer"
            >
              <span>重置缓存并重载</span>
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

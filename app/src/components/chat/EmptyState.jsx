import React from 'react';
import { HelpCircle, FileText, CheckCircle2, Terminal } from 'lucide-react';

export function EmptyState({ onSelectPrompt, workdir }) {
  const suggestions = [
    {
      title: '帮我梳理一个问题',
      desc: '分析技术架构、重构路线或系统瓶颈',
      prompt: '请帮我梳理当前代码库的架构设计与潜在优化点。',
      icon: HelpCircle,
    },
    {
      title: '整理这份资料',
      desc: '提炼核心要点、输出结构化文档或汇报',
      prompt: '请分析当前工作区中的设计文档并总结核心规范与待办事项。',
      icon: FileText,
    },
    {
      title: '推进一个任务',
      desc: '编写代码、执行自动化测试或排查报错',
      prompt: '请检查当前前端测试与代码质量门禁，并指出可优化项。',
      icon: CheckCircle2,
    },
  ];

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 text-center max-w-2xl mx-auto">
      {/* Brand Icon & Welcome */}
      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#6e77e8] to-[#4f46e5] flex items-center justify-center shadow-[0_0_24px_rgba(110,119,232,0.35)] mb-4">
        <Terminal className="w-6 h-6 text-white" />
      </div>
      <h1 className="text-xl font-bold tracking-tight text-main mb-2">
        今天有什么可以帮你的？
      </h1>
      <p className="text-xs text-sub max-w-md mb-8">
        Personal AI 承接技术讨论、代码编写、深度研究与系统治理。
      </p>

      {/* 3 PRD Recommendations */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 w-full">
        {suggestions.map((s, idx) => {
          const Icon = s.icon;
          return (
            <button
              key={idx}
              onClick={() => onSelectPrompt(s.prompt)}
              className="flex flex-col text-left p-3.5 rounded-xl bg-elev hover:bg-card active:scale-[0.98] border border-app hover:border-[#6e77e8] shadow-card transition-all group rim-highlight"
            >
              <div className="w-7 h-7 rounded-lg bg-[var(--border)] group-hover:bg-[#6e77e8]/20 flex items-center justify-center mb-2.5 transition-colors">
                <Icon className="w-4 h-4 text-sub group-hover:text-[#6e77e8] transition-colors" />
              </div>
              <span className="text-xs font-semibold text-main mb-1">
                {s.title}
              </span>
              <span className="text-[11px] text-muted leading-relaxed">
                {s.desc}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

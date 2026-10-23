import React, { useState, useEffect } from 'react';
import {
  Brain,
  Sparkles,
  RefreshCw,
  Send,
  BookOpen,
  ChevronDown,
  Info,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { sendCmd } from '../../lib/api';

/**
 * 将原始编译简报解析为人能通俗看懂的分类卡片
 */
function parseBriefingSections(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const lines = raw.split('\n');
  const sections = [];
  let currentTitle = '概览';
  let currentLines = [];

  for (const line of lines) {
    if (line.startsWith('## ') || line.startsWith('# ')) {
      if (currentLines.length > 0) {
        sections.push({ title: currentTitle, text: currentLines.join('\n').trim() });
        currentLines = [];
      }
      currentTitle = line.replace(/^#+\s*/, '').replace(/^\d+[\.\s]*/, '').trim();
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0) {
    sections.push({ title: currentTitle, text: currentLines.join('\n').trim() });
  }

  // 人性化分类标题与引导词映射（彻底破除技术黑话）
  const SECTION_META = {
    'Identity': {
      title: 'AI 身份与系统记忆版本',
      tag: '系统定位',
      hint: '记录 AI 助理在本项目中的角色定位与认知基座。',
    },
    'Current Best Models': {
      title: '已记住的核心偏好与经验',
      tag: '核心经验',
      hint: 'AI 在实战中提炼并确认有效的长期记忆与操作习惯。',
    },
    'Task-Relevant Values / Constraints': {
      title: '工作规范与行为约束',
      tag: '开发规范',
      hint: '你明确要求 AI 遵守的代码规范、架构要求与红线。',
    },
    'Reliability Alerts': {
      title: '已知踩坑记录与避坑警报',
      tag: '避坑指南',
      hint: '过去任务中暴露出的技术问题或需要警惕的潜在隐患。',
    },
    'Unresolved First': {
      title: '正在观察的探索假设',
      tag: '待定经验',
      hint: 'AI 尚在观察验证中的推测，随后续交互会进一步确认或修正。',
    },
    'Corrections & Superseded': {
      title: '历史纠错与认知更正',
      tag: '纠偏记录',
      hint: '过去被你纠正过的错误认识，已废弃旧观点，不再重蹈覆辙。',
    },
    'Retrieval Pointers': {
      title: '本地知识索引',
      tag: '知识指向',
      hint: '指向机器深层认知库的文件路径与上下文检索点。',
    },
  };

  return sections.map((s) => {
    const meta = SECTION_META[s.title] || {
      title: s.title,
      tag: '通用记忆',
      hint: '',
    };
    return {
      title: meta.title,
      tag: meta.tag,
      hint: meta.hint,
      rawTitle: s.title,
      text: s.text,
    };
  }).filter((s) => s.text.length > 0);
}

/**
 * 现代认知与长期记忆面板：
 * 1. 人话化、白话化呈现 AI 的长期记忆与习惯备忘（打破“世界模型”等学术黑话门槛）
 * 2. 彻底删除人工审批/裁决机制（全自动沉淀与自适应学习）
 * 3. 支持随时教 AI 记住新规矩或进行认知纠偏（平等的提议机制，AI 自主审辨采纳）
 */
export function CognitionView() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionNotice, setActionNotice] = useState(null);
  const [proposalText, setProposalText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [showRawBriefing, setShowRawBriefing] = useState(false);

  const fetchStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await sendCmd('world_model_status', { limit: 50 });
      if (res.success && res.data) {
        setData(res.data);
      } else {
        setError(res.error || '获取长期记忆状态失败');
      }
    } catch (err) {
      setError(err.message || '网络连接异常');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  // 运行记忆整理周期（全程全自动）
  const handleTriggerCycle = async () => {
    setSubmitting(true);
    try {
      const res = await sendCmd('cognition_run');
      if (res.success) {
        setActionNotice({ ok: true, text: '已触发自动化整理周期，AI 正在从近期交互中同步长期记忆。' });
        await fetchStatus();
      } else {
        setActionNotice({ ok: false, text: `整理失败：${res.error || '可能尚在冷却期'}` });
      }
    } catch (err) {
      setActionNotice({ ok: false, text: `网络错误：${err.message}` });
    } finally {
      setSubmitting(false);
    }
  };

  // 提交认知建议与提议（教 AI 记住规矩）
  const handleSuggestCorrection = async (e) => {
    e.preventDefault();
    if (!proposalText.trim() || submitting) return;
    setSubmitting(true);
    try {
      const autoId = `user-guide-${Date.now().toString(36)}`;
      const res = await sendCmd('proposal_correct', {
        model_id: autoId,
        proposition: proposalText.trim(),
        reason: '用户向 AI 提出的经验建议与规矩备忘',
      });
      if (res.success) {
        setActionNotice({
          ok: true,
          text: '新规矩已成功提交！AI 会将其存入长期记忆，并在之后的所有对话中自动遵守。',
        });
        setProposalText('');
        await fetchStatus();
      } else {
        setActionNotice({ ok: false, text: `提交失败：${res.error || '未知原因'}` });
      }
    } catch (err) {
      setActionNotice({ ok: false, text: `提交异常：${err.message}` });
    } finally {
      setSubmitting(false);
    }
  };

  const briefing = data?.briefing;
  const sections = parseBriefingSections(briefing);

  return (
    <div className="flex-1 flex flex-col bg-app overflow-hidden text-xs text-main">
      {/* 顶部标题栏 */}
      <div className="p-4 border-b border-app bg-[var(--bg-side)] flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-sm font-bold text-main flex items-center gap-2">
            <Brain className="w-4 h-4 text-[var(--accent)]" />
            AI 长期记忆与认知经验 (世界模型 · World Model)
          </h2>
          <p className="text-sub text-[11px] mt-0.5">
            AI 跨会话沉淀的知识备忘录：自动提取对话经验与你的个性化习惯，随用随记，免去重复提示。
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleTriggerCycle}
            disabled={submitting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--bg-card)] hover:bg-[var(--border)] text-main border border-app font-medium transition-all cursor-pointer"
            title="触发一次记忆整理与长期记忆同步"
          >
            <Sparkles className="w-3.5 h-3.5 text-[var(--accent)]" />
            <span>整理并同步记忆</span>
          </button>
          <button
            type="button"
            onClick={fetchStatus}
            className="p-1.5 rounded-md hover:bg-[var(--bg-card)] text-sub hover:text-main transition-colors cursor-pointer"
            title="刷新"
            aria-label="刷新"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {actionNotice && (
        <div
          className={cn(
            'px-4 py-2 border-b text-xs flex items-center justify-between',
            actionNotice.ok
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
              : 'bg-rose-500/10 border-rose-500/20 text-rose-400'
          )}
        >
          <span>{actionNotice.text}</span>
          <button type="button" onClick={() => setActionNotice(null)} className="text-sub hover:text-main cursor-pointer">✕</button>
        </div>
      )}

      {/* 主体滚动区 */}
      <div className="flex-1 overflow-y-auto p-6 max-w-4xl mx-auto w-full space-y-6">
        {/* 通俗大白话导读卡片 */}
        <div className="p-4 rounded-xl bg-[var(--bg-elev)] border border-app shadow-xs space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-main">
            <Info className="w-4 h-4 text-[var(--accent)] shrink-0" />
            <span>通俗读懂：什么是 AI 长期记忆？它对你有什么用？</span>
          </div>
          <p className="text-xs text-sub leading-relaxed">
            普通 AI 对话是<strong>“聊完就忘”</strong>的，关闭窗口后你交待过的代码风格和习惯全没了。
            <strong>Personal AI 会在后台自动把你的开发习惯、项目偏好、避坑经验沉淀在此处。</strong>
            下次无论你创建什么新对话，它都会自动记着这些规矩，无需每次重复强调，做到<strong>“越用越默契”</strong>。
          </p>
        </div>

        {/* 一、AI 当前掌握的认知与经验卡片 */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold text-main flex items-center gap-2 uppercase tracking-wider">
              <BookOpen className="w-4 h-4 text-[var(--accent)]" />
              当前生效的记忆备忘
            </h3>
            {briefing && (
              <button
                type="button"
                onClick={() => setShowRawBriefing(!showRawBriefing)}
                className="text-[11px] text-muted hover:text-main transition-colors flex items-center gap-1 cursor-pointer"
              >
                <span>{showRawBriefing ? '收起机器编译原文' : '查看机器编译原文'}</span>
                <ChevronDown className={cn('w-3 h-3 transition-transform', showRawBriefing && 'rotate-180')} />
              </button>
            )}
          </div>

          {sections.length > 0 ? (
            <div className="grid grid-cols-1 gap-3">
              {sections.map((sec, idx) => (
                <div
                  key={idx}
                  className="p-4 rounded-xl border border-app bg-[var(--bg-card)] shadow-xs space-y-2"
                >
                  <div className="flex items-center justify-between pb-1.5 border-b border-app/60">
                    <div className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
                      <span className="font-semibold text-main text-xs">{sec.title}</span>
                    </div>
                    {sec.tag && (
                      <span className="text-[10px] px-2 py-0.5 rounded bg-[var(--bg-elev)] border border-app text-sub font-mono">
                        {sec.tag}
                      </span>
                    )}
                  </div>
                  {sec.hint && (
                    <div className="text-[11px] text-muted italic">
                      {sec.hint}
                    </div>
                  )}
                  <div className="text-xs leading-relaxed text-sub whitespace-pre-wrap font-sans pt-1">
                    {sec.text}
                  </div>
                </div>
              ))}
            </div>
          ) : briefing ? (
            <div className="p-4 rounded-xl border border-app bg-[var(--bg-card)] text-sub leading-relaxed whitespace-pre-wrap">
              {briefing}
            </div>
          ) : (
            <div className="p-10 text-center text-muted border border-dashed border-app rounded-xl space-y-2">
              <Brain className="w-8 h-8 text-muted mx-auto" />
              <div className="font-medium text-xs text-main">AI 正在根据交互全自动沉淀长期记忆</div>
              <div className="text-[11px] text-muted">暂无编译生成的记忆卡片，执行几次日常任务后系统将自主提炼</div>
            </div>
          )}

          {/* 底层原始 Markdown 折叠项 */}
          {showRawBriefing && briefing && (
            <div className="p-4 rounded-xl border border-app bg-[var(--bg-elev)] font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted">
              {briefing}
            </div>
          )}
        </div>

        {/* 二、教 AI 记住新规矩 / 经验纠偏 */}
        <div className="p-4 rounded-xl bg-[var(--bg-card)] border border-app shadow-xs space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-main text-xs flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-[var(--accent)]" />
              教 AI 记住新规矩 / 经验纠偏
            </h3>
            <span className="text-[10px] text-sub bg-[var(--bg-elev)] px-2 py-0.5 rounded border border-app">
              全自动生效 · 永久记住
            </span>
          </div>

          <p className="text-[11px] text-muted leading-relaxed">
            直接告诉 AI 你希望它长期记住的偏好（例如：“以后写前端请优先遵循极简规范”、“不要随意引入未确认的依赖”、“排查问题前先看测试”）。
            写入后，AI 会在后续所有新对话中自主遵循。
          </p>

          <form onSubmit={handleSuggestCorrection} className="space-y-3 pt-1">
            <textarea
              rows={3}
              placeholder="例如：请记住，在本项目中所有组件必须保持无多余打包、代码风格保持优雅，不要随意新增冗余图标..."
              value={proposalText}
              onChange={(e) => setProposalText(e.target.value)}
              className="w-full px-3 py-2 bg-[var(--bg-elev)] border border-app focus:border-[var(--accent)] rounded-lg text-xs text-main placeholder:text-muted outline-none transition-all leading-relaxed"
              aria-label="输入希望 AI 记住的新规矩"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!proposalText.trim() || submitting}
                className="px-4 py-2 bg-[var(--accent)] hover:opacity-90 disabled:opacity-40 text-white rounded-lg text-xs font-medium transition-all shadow-xs flex items-center gap-1.5 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                <span>写入 AI 长期记忆</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

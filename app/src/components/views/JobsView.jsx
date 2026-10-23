import React, { useState, useEffect } from 'react';
import {
  Activity,
  CheckCircle2,
  Clock,
  Play,
  XCircle,
  PauseCircle,
  Send,
  RefreshCw,
  AlertCircle,
  Inbox,
  Terminal,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { sendCmd } from '../../lib/api';

export function JobsView() {
  const [tasks, setTasks] = useState([]);
  const [activeTaskId, setActiveTaskId] = useState(null);
  const [taskDetail, setTaskDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [actionNotice, setActionNotice] = useState(null);

  const fetchTasks = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await sendCmd('task_list');
      if (res.success) {
        const rawList = Array.isArray(res.data)
          ? res.data
          : Array.isArray(res.data?.tasks)
          ? res.data.tasks
          : [];
        const normalized = rawList.map((t) => {
          const tid = t.task_id || t.taskId || t.id;
          return {
            ...t,
            task_id: tid,
            id: tid,
            title: t.title || t.name || `任务 ${tid}`,
            state: t.state || t.status || 'open',
          };
        });
        setTasks(normalized);
        if (normalized.length > 0 && !activeTaskId) {
          setActiveTaskId(normalized[0].task_id);
        }
      } else {
        setError(res.error || '获取任务列表失败');
        setTasks([]);
      }
    } catch (err) {
      setError(err.message || '获取任务列表失败');
      setTasks([]);
    } finally {
      setLoading(false);
    }
  };

  const fetchTaskEvents = async (taskId) => {
    if (!taskId) return;
    try {
      const res = await sendCmd('task_events', { taskId: String(taskId) });
      if (res.success && res.data) {
        setTaskDetail(res.data);
        setDetailError(null);
      } else {
        setDetailError(res.error || '获取任务事件失败');
      }
    } catch (e) {
      setDetailError(e?.message || '获取任务事件失败');
    }
  };

  useEffect(() => {
    fetchTasks();
  }, []);

  useEffect(() => {
    if (activeTaskId) {
      setTaskDetail(null);
      setDetailError(null);
      fetchTaskEvents(activeTaskId);
      const timer = setInterval(() => {
        fetchTaskEvents(activeTaskId);
      }, 3000);
      return () => clearInterval(timer);
    }
  }, [activeTaskId]);

  const handleSendInput = async (e) => {
    e.preventDefault();
    if (!inputText.trim() || !activeTaskId || sending) return;
    setSending(true);
    setActionNotice(null);
    try {
      const res = await sendCmd('task_send', { taskId: activeTaskId, body: inputText.trim() });
      if (res.success) {
        setInputText('');
        setActionNotice('指示已送达任务邮箱');
        await fetchTaskEvents(activeTaskId);
      } else {
        setError(res.error || '向任务发送指示失败');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setSending(false);
    }
  };

  const handleInterruptTask = async () => {
    if (!activeTaskId) return;
    setActionNotice(null);
    try {
      const res = await sendCmd('task_interrupt', { taskId: activeTaskId });
      if (res.success) {
        setActionNotice('已向任务绑定的后台作业发送打断信号');
        await fetchTaskEvents(activeTaskId);
        await fetchTasks();
      } else {
        setError(res.error || '打断任务失败');
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const handleCloseTask = async () => {
    if (!activeTaskId) return;
    setActionNotice(null);
    try {
      const res = await sendCmd('task_close', { taskId: activeTaskId });
      if (res.success) {
        setActionNotice('任务已被标记为关闭 (closed)');
        await fetchTaskEvents(activeTaskId);
        await fetchTasks();
      } else {
        setError(res.error || '关闭任务失败');
      }
    } catch (err) {
      setError(err.message);
    }
  };

  const activeTask = tasks.find((t) => t.task_id === activeTaskId);
  const isClosed = taskDetail?.task?.state === 'closed' || activeTask?.state === 'closed';

  const rows = taskDetail
    ? [
        ...(taskDetail.inbox || []).map((m) => ({
          tag: '→ 指示',
          type: 'in',
          body: m.body,
          ts: m.ts,
        })),
        ...(taskDetail.outbox || []).map((m) => ({
          tag: '← 回报',
          type: 'out',
          body: m.body,
          ts: m.ts,
        })),
        ...(taskDetail.events || []).map((ev) => ({
          tag: ev.kind || '事件',
          type: 'event',
          body: ev.data?.note || ev.data?.body || JSON.stringify(ev.data || {}),
          ts: ev.ts,
        })),
      ].sort((a, b) => (a.ts || '').localeCompare(b.ts || ''))
    : [];

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Task List Sidebar */}
      <div className="w-80 border-r border-app bg-[var(--bg-side)] flex flex-col shrink-0 select-none">
        <div className="p-3 border-b border-app flex items-center justify-between">
          <div>
            <h3 className="text-xs font-semibold text-main">后台任务与执行</h3>
            <span className="text-[11px] text-muted">多步任务推进与检查点</span>
          </div>
          <button
            onClick={fetchTasks}
            className="p-1 rounded hover:bg-[var(--bg-card)] text-sub hover:text-main transition-colors"
            title="刷新任务列表"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {tasks.length === 0 ? (
            <div className="p-8 text-center text-muted text-xs flex flex-col items-center gap-2">
              <Inbox className="w-6 h-6 text-muted" />
              <span>当前无运行中或待处理的后台任务</span>
              <span className="text-[11px] text-muted">自然语言创建的委派子任务将在此列出</span>
            </div>
          ) : (
            tasks.map((task) => {
              const tid = task.task_id;
              const isSelected = activeTaskId === tid;
              const status = task.state || 'open';
              return (
                <div
                  key={tid}
                  onClick={() => setActiveTaskId(tid)}
                  className={cn(
                    'p-2.5 rounded-lg text-xs cursor-pointer border transition-all',
                    isSelected
                      ? 'bg-[var(--bg-card)] border-[var(--accent)] shadow-sm text-main font-medium'
                      : 'border-transparent text-sub hover:bg-[var(--bg-card)] hover:text-main'
                  )}
                >
                  <div className="flex items-center justify-between mb-1 truncate">
                    <span className="font-semibold text-main truncate">
                      {task.title || `任务 ${tid}`}
                    </span>
                    <span
                      className={cn(
                        'px-1.5 py-0.5 rounded text-[10px] font-mono font-medium',
                        status === 'closed'
                          ? 'bg-[var(--border)] text-muted'
                          : status === 'blocked'
                          ? 'bg-amber-500/20 text-[var(--amber-text)]'
                          : 'bg-[var(--accent-glow)] text-[var(--accent)] border border-[var(--accent)]/30'
                      )}
                    >
                      {status}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-muted font-mono">
                    <span className="truncate">{tid}</span>
                    <span>{task.updatedAt ? new Date(task.updatedAt).toLocaleTimeString() : '刚刚'}</span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Task Details Pane */}
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
          <div className="p-2.5 bg-emerald-500/20 border-b border-emerald-500/30 text-xs text-[var(--green-text)] flex items-center justify-between">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
              {actionNotice}
            </span>
            <button onClick={() => setActionNotice(null)} className="text-sub hover:text-main">✕</button>
          </div>
        )}

        {/* Task Header */}
        <div className="h-11 px-4 border-b border-app flex items-center justify-between bg-[var(--bg-side)] select-none">
          <div className="flex items-center gap-2 truncate">
            <Terminal className="w-4 h-4 text-[var(--accent)]" />
            <span className="font-mono text-xs text-main font-medium truncate">
              {activeTaskId ? `任务上下文：${activeTaskId}` : '未选中任务'}
            </span>
          </div>
          {activeTaskId && !isClosed && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleInterruptTask}
                className="px-2.5 py-1 rounded bg-amber-500/20 hover:bg-amber-500/30 text-amber-200 text-xs border border-amber-500/30 transition-colors flex items-center gap-1.5"
                title="向执行中的作业发送中断信号"
              >
                <PauseCircle className="w-3.5 h-3.5" />
                中断执行
              </button>
              <button
                onClick={handleCloseTask}
                className="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 text-xs border border-rose-500/30 transition-colors flex items-center gap-1.5"
                title="将任务邮箱置为关闭状态"
              >
                <XCircle className="w-3.5 h-3.5" />
                关闭任务
              </button>
            </div>
          )}
        </div>

        {/* Event / Message Stream */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {!activeTaskId ? (
            <div className="h-full flex items-center justify-center text-muted text-xs">
              选择左侧任务以查看执行日志与交互记录
            </div>
          ) : detailError && rows.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-[var(--red-text)] text-xs gap-2">
              <AlertCircle className="w-5 h-5 text-[var(--red-text)]" />
              <span>任务详情读取失败：{detailError}</span>
            </div>
          ) : rows.length === 0 ? (
            <div className="h-full flex items-center justify-center text-muted text-xs">
              该任务尚未产生交互消息或事件
            </div>
          ) : (
            <>
              {detailError && (
                <div className="p-2 mb-2 rounded bg-amber-500/15 border border-amber-500/30 text-[11px] text-[var(--amber-text)] flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0 text-[var(--amber-text)]" />
                  <span>最新事件同步失败（{detailError}），当前显示为历史缓存详情</span>
                </div>
              )}
              {rows.map((row, idx) => (
              <div
                key={idx}
                className={cn(
                  'p-2.5 rounded-lg border text-xs font-mono leading-relaxed',
                  row.type === 'in'
                    ? 'bg-blue-500/10 border-blue-500/30 text-blue-100'
                    : row.type === 'out'
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-100'
                    : 'bg-white/[0.04] border-white/[0.08] text-white/90'
                )}
              >
                <div className="flex items-center justify-between mb-1 text-[11px] text-white/60">
                  <span className="font-semibold text-white/80">{row.tag}</span>
                  <span>{row.ts ? new Date(row.ts).toLocaleTimeString() : ''}</span>
                </div>
                <div className="whitespace-pre-wrap break-all">{row.body}</div>
              </div>
            ))}
            </>
          )}
        </div>

        {/* Send Input to Task */}
        {activeTaskId && (
          <form onSubmit={handleSendInput} className="p-3 border-t border-app bg-[var(--bg-side)] flex gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              disabled={isClosed}
              placeholder={isClosed ? '任务已关闭，不可追加指示' : '追加给该子任务的指示…'}
              className="flex-1 px-3 py-1.5 bg-[var(--bg)] border border-[var(--border-strong)] focus:border-[var(--accent)] rounded-lg text-xs text-main placeholder:text-muted outline-none disabled:opacity-40"
            />
            <button
              type="submit"
              disabled={isClosed || !inputText.trim() || sending}
              className="px-3.5 py-1.5 bg-[#6e77e8] hover:bg-[#5b64dc] text-white rounded-lg text-xs font-medium flex items-center gap-1.5 disabled:opacity-40 transition-colors shadow-sm cursor-pointer"
            >
              <Send className="w-3.5 h-3.5" />
              发送指示
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

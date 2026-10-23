import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { Sidebar } from './components/sidebar/Sidebar';
import { NavigationRail } from './components/sidebar/NavigationRail';
import { TopBar } from './components/topbar/TopBar';
import { TopMenuBar } from './components/topbar/TopMenuBar';
import { EmptyState } from './components/chat/EmptyState';
import { MessageItem } from './components/chat/MessageItem';
import { Composer } from './components/composer/Composer';
import { CognitionView } from './components/views/CognitionView';
import { HealthView } from './components/views/HealthView';
import { ModelsView } from './components/views/ModelsView';
import { BodiesView } from './components/views/BodiesView';
import { AppearanceView } from './components/views/AppearanceView';
import { SecurityView } from './components/views/SecurityView';
import { JobsView } from './components/views/JobsView';
import { ChangesView } from './components/views/ChangesView';
import { Cpu, Bot, Sparkles, ArrowDown } from 'lucide-react';
import { ChatOutline, extractTurns } from './components/chat/ChatOutline';
import { sendCmd, subscribeEvents, generateClientMsgId, pickDirectory } from './lib/api';
import { samePath, normPath, cleanDisplayContent } from './lib/utils';
import { mapHistoryToMessages } from './lib/history.js';

export function App() {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [currentView, setCurrentView] = useState('chat');
  const [messages, setMessages] = useState([]);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [turnDuration, setTurnDuration] = useState(0);
  const [activeBody, setActiveBody] = useState('');
  // 生效身份必须来自 model_status 回读（D02：固定值占位会冒充实际身份）
  const [activeProvider, setActiveProvider] = useState('');
  const [activeModel, setActiveModel] = useState('');
  const [availableModels, setAvailableModels] = useState([]);
  const [thinkingLevel, setThinkingLevel] = useState('');
  const [executionMode, setExecutionMode] = useState('execute');
  const [workdir, setWorkdir] = useState('');
  const [errorNotice, setErrorNotice] = useState(null);
  // 侧栏健康/徽标的即时刷新信号：引擎崩溃/恢复/交接、每轮结束时 +1。
  // 健康结论本身由侧栏真实探测得出，App 不再自造 'ok'（v4 V407）。
  const [refreshNonce, setRefreshNonce] = useState(0);
  const bumpRefresh = () => setRefreshNonce((n) => n + 1);
  // 文件改动回执按 toolCallId 索引：每轮消息据此精确显示"这一轮改了哪些文件"
  const [fileopsByCall, setFileopsByCall] = useState({});
  const [supportedThinkingLevels, setSupportedThinkingLevels] = useState(null);
  const [settingsTab, setSettingsTab] = useState(null);
  const [healthTab, setHealthTab] = useState('status');
  const [draftToInject, setDraftToInject] = useState('');
  const [showBodyModal, setShowBodyModal] = useState(false);
  const [workspaces, setWorkspaces] = useState([]);

  const messagesEndRef = useRef(null);
  const chatScrollRef = useRef(null);
  const sessionSwitchSeqRef = useRef(0);

  // 回到底部浮动按键与右侧问答目录（默认收起，用户需要时主动点击展开）
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [showOutline, setShowOutline] = useState(() => {
    try {
      return localStorage.getItem('pai_show_outline') === 'true';
    } catch {
      return false;
    }
  });
  const [activeTurnId, setActiveTurnId] = useState(null);
  const [highlightedMsgId, setHighlightedMsgId] = useState(null);

  // 安全规则治理模式与自动审查模型
  const [securityMode, setSecurityMode] = useState(() => {
    try {
      return localStorage.getItem('pai_security_mode') || 'manual';
    } catch {
      return 'manual';
    }
  });
  const [autoReviewModel, setAutoReviewModel] = useState(() => {
    try {
      return localStorage.getItem('pai_auto_review_model') || '';
    } catch {
      return '';
    }
  });

  // 监听设置界面发出的安全策略变动广播
  useEffect(() => {
    const handleSecChange = (e) => {
      if (e.detail?.mode) setSecurityMode(e.detail.mode);
      if (e.detail?.reviewModel !== undefined) setAutoReviewModel(e.detail.reviewModel);
    };
    window.addEventListener('pai_security_policy_change', handleSecChange);
    return () => window.removeEventListener('pai_security_policy_change', handleSecChange);
  }, []);

  // 顶部快捷控制与侧栏显隐状态
  const [showSidebar, setShowSidebar] = useState(() => {
    try {
      return localStorage.getItem('pai_show_sidebar') !== 'false';
    } catch {
      return true;
    }
  });
  const [navHistory, setNavHistory] = useState(['chat']);
  const [navIndex, setNavIndex] = useState(0);

  // 主题状态与同步
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('pai_theme') || 'dark';
    } catch {
      return 'dark';
    }
  });

  const handleToggleTheme = () => {
    const nextTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(nextTheme);
    try {
      localStorage.setItem('pai_theme', nextTheme);
      document.documentElement.classList.toggle('light', nextTheme === 'light');
      document.documentElement.classList.toggle('dark', nextTheme !== 'light');
      document.documentElement.setAttribute('data-theme', nextTheme);
      window.dispatchEvent(new CustomEvent('pai_theme_changed', { detail: { theme: nextTheme } }));
      window.desktopAPI?.setTheme(nextTheme);
    } catch {}
  };

  useEffect(() => {
    const handleThemeSync = (e) => {
      if (e.detail?.theme) setTheme(e.detail.theme);
    };
    window.addEventListener('pai_theme_changed', handleThemeSync);
    return () => window.removeEventListener('pai_theme_changed', handleThemeSync);
  }, []);

  // Theme persistence on mount
  useEffect(() => {
    try {
      const savedTheme = localStorage.getItem('pai_theme') || 'dark';
      document.documentElement.classList.toggle('light', savedTheme === 'light');
      document.documentElement.classList.toggle('dark', savedTheme !== 'light');
      document.documentElement.setAttribute('data-theme', savedTheme);
      window.desktopAPI?.setTheme(savedTheme);
    } catch {}
  }, []);

  const refreshSessions = async (pendingActiveSession) => {
    const sessRes = await sendCmd('session_list');
    let list = [];
    if (sessRes.success && Array.isArray(sessRes.data)) {
      list = sessRes.data.map((s) => ({
        id: s.path || s.id,
        title:
          s.title ||
          s.name ||
          (s.path ? s.path.split(/[/\\]/).pop().replace(/\.jsonl$/, '') : '未命名会话'),
        updated_at: s.updated_at || s.mtime || new Date().toISOString(),
        model: s.model || activeModel,
        pinned: Boolean(s.pinned),
        archived: Boolean(s.archived),
        cwd: s.cwd || '',
        path: s.path,
      }));
    }

    // 若当前有在内存中新建、但尚未产生持久化文件的活动会话，立即将其填补到列表中展示，绝不出现“暂无聊天”
    const pending = pendingActiveSession || (activeSessionId && !list.some((s) => s.id === activeSessionId || (s.path && s.path === activeSessionId)) ? {
      id: activeSessionId,
      path: activeSessionId,
      title: '新任务对话',
      updated_at: new Date().toISOString(),
      model: activeModel,
      pinned: false,
      archived: false,
      cwd: workdir || '',
      isNew: true,
    } : null);

    if (pending && !list.some((s) => s.id === pending.id || (pending.path && s.path === pending.path))) {
      list.unshift(pending);
    }

    setSessions(list);
    return list;
  };

  const refreshFileops = async () => {
    const r = await sendCmd('fileops_list');
    if (!r.success || !Array.isArray(r.data)) return;
    const map = {};
    for (const op of r.data) {
      if (!op?.toolCallId || ['restore', 'restore-displace', 'purge'].includes(op.op)) continue;
      (map[op.toolCallId] ??= []).push(op);
    }
    setFileopsByCall(map);
  };

  const refreshWorkspaces = async () => {
    try {
      const res = await sendCmd('workspace_list');
      if (res.success && Array.isArray(res.data?.workspaces)) {
        setWorkspaces(res.data.workspaces);
      }
    } catch {}
  };

  const navigate = (view, tab = null) => {
    let target = view;
    // 兼容外层若传入 settings，自动映射到具体的外观或安全规则
    if (view === 'settings') {
      target = tab === 'security' ? 'security' : 'appearance';
    }
    if (target === 'engine') { setShowBodyModal(true); return; }
    if (target === 'audit') { setHealthTab('events'); target = 'health'; }
    if (target === 'health') setHealthTab('status');
    if (tab) setSettingsTab(tab);
    if (target === currentView) return;
    setCurrentView(target);
    setNavHistory((prev) => {
      const next = prev.slice(0, navIndex + 1);
      if (next[next.length - 1] !== target) next.push(target);
      return next;
    });
    setNavIndex((prev) => prev + 1);
  };

  const handleGoBack = () => {
    if (navIndex > 0) {
      const targetIdx = navIndex - 1;
      setNavIndex(targetIdx);
      setCurrentView(navHistory[targetIdx]);
    } else if (currentView !== 'chat') {
      setCurrentView('chat');
      setNavHistory(['chat']);
      setNavIndex(0);
    }
  };

  const handleGoForward = () => {
    if (navIndex < navHistory.length - 1) {
      const targetIdx = navIndex + 1;
      setNavIndex(targetIdx);
      setCurrentView(navHistory[targetIdx]);
    }
  };

  const handleToggleSidebar = () => {
    setShowSidebar((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('pai_show_sidebar', String(next));
      } catch {}
      return next;
    });
  };

  const handleExportSession = () => {
    if (!messages.length) return;
    const content = messages.map((m) => `### ${m.role === 'user' ? '用户' : 'Personal AI'}\n\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2)}\n`).join('\n---\n\n');
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeSession?.title || 'session'}-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRenameSession = async () => {
    if (!activeSession) return;
    const newTitle = window.prompt('请输入新的对话标题：', activeSession.title || '');
    if (newTitle && newTitle.trim()) {
      await sendCmd('session_rename', { path: activeSession.path || activeSession.id, title: newTitle.trim() });
      await refreshSessions();
    }
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        handleToggleSidebar();
      } else if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault();
        handleGoBack();
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault();
        handleGoForward();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navIndex, navHistory]);

  const refreshModelStatus = async () => {
    const st = await sendCmd('model_status');
    if (!st.success || !st.data) return null;
    const cur = st.data.current;
    setActiveProvider(cur?.provider ?? '');
    setActiveModel(cur?.model || cur?.id || '');
    setSupportedThinkingLevels(Array.isArray(cur?.supportedThinkingLevels) && cur.supportedThinkingLevels.length
      ? cur.supportedThinkingLevels : null);
    if (st.data.thinkingLevel) setThinkingLevel(st.data.thinkingLevel);
    return st.data;
  };

  // Initialize data on load with honest backend sync
  useEffect(() => {
    async function init() {
      const reqId = ++sessionSwitchSeqRef.current;

      // 关键引擎身份与模型状态立即并行拉取，杜绝首屏空滞与未连接假象
      const bodyInit = sendCmd('body_current').then((bodyRes) => {
        if (bodyRes.success && bodyRes.data) {
          setActiveBody(bodyRes.data.body_id || bodyRes.data.label || '');
        }
      });
      const modelInit = refreshModelStatus();

      const sList = await refreshSessions();

      // R01: Verify real current session from backend state, then load history
      const stateRes = await sendCmd('get_state');
      let currentFile = stateRes.success && stateRes.data?.session?.file ? stateRes.data.session.file : null;

      // D01: get_state 未确认当前会话时，不能把列表第一行冒充实际会话
      if (currentFile) {
        setActiveSessionId(currentFile);
        isRestoringScrollRef.current = currentFile;
        const histRes = await sendCmd('session_history');
        if (sessionSwitchSeqRef.current === reqId) {
          if (histRes.success && Array.isArray(histRes.data)) {
            setMessages(mapHistoryToMessages(histRes.data));
          } else {
            setErrorNotice(`读取会话历史失败：${histRes.error || '会话历史不可用'}`);
          }
        }
      } else {
        setActiveSessionId(null);
        setMessages([]);
      }

      await Promise.all([bodyInit, modelInit]);

      // R02: Load model list, thinking, and risk mode from actual backend
      const [mListRes, riskRes, statusRes] = await Promise.all([
        sendCmd('model_list'),
        sendCmd('risk_mode'),
        sendCmd('supervisor_status'),
        refreshFileops(),
        refreshWorkspaces(),
      ]);

      if (mListRes.success && Array.isArray(mListRes.data)) {
        setAvailableModels(mListRes.data);
      }

      if (riskRes.success && riskRes.data?.mode) {
        if (riskRes.data.mode === 'plan') {
          // 自动化优先，确保不被 plan mode 的只读询问所困
          sendCmd('risk_mode_set', { mode: 'normal' }).catch(() => {});
          setExecutionMode('execute');
        } else {
          setExecutionMode(riskRes.data.mode === 'normal' ? 'execute' : riskRes.data.mode);
        }
      }

      if (statusRes.success && statusRes.data?.workdir) {
        setWorkdir(statusRes.data.workdir);
      }
    }
    init();

    // Subscribe to real SSE stream
    const unsubscribe = subscribeEvents(
      (rec) => {
        // Direct supervisor event (D05 / V408)
        if (rec.type === 'supervisor') {
          const k = rec.event?.kind;
          if (k === 'body_exited' || k === 'BODY_CRASHED') {
            if (!rec.event?.expected) {
              setErrorNotice('AI 引擎意外退出，正在自动重启…');
            }
            bumpRefresh();
          } else if (k === 'body_started' || k === 'body_respawned') {
            setErrorNotice(null);
            bumpRefresh();
          } else if (k === 'body_respawn_failed') {
            setErrorNotice('AI 引擎自动重启失败，请到设置 → AI 引擎处理');
            bumpRefresh();
          } else if (k === 'handoff_phase' || k === 'HANDOFF_PHASE') {
            const p = rec.event?.phase;
            if (p === 'verified' || p === 'HANDOFF_COMPLETED') {
              setErrorNotice(null);
              sendCmd('body_current').then((r) => {
                if (r.success && r.data?.body_id) setActiveBody(r.data.body_id);
              });
              refreshModelStatus();
              bumpRefresh();
            } else if (p === 'failed' || p === 'HANDOFF_FAILED') {
              setErrorNotice(`切换引擎失败：${rec.event?.reason || rec.event?.error || '已回退到原引擎'}`);
              bumpRefresh();
            }
          } else if (k === 'select_done' || k === 'SELECT_DONE') {
            setErrorNotice(null);
            sendCmd('body_current').then((r) => {
              if (r.success && r.data?.body_id) setActiveBody(r.data.body_id);
            });
            refreshModelStatus();
            bumpRefresh();
          } else if (k === 'select_failed' || k === 'SELECT_FAILED') {
            setErrorNotice(`切换引擎失败：${rec.event?.error || '已回退到原引擎'}`);
            bumpRefresh();
          } else if (k === 'select_start' || k === 'SELECT_START') {
            bumpRefresh();
          } else if (k === 'backup' || k === 'governance') {
            bumpRefresh();
          }
          return;
        }

        // Body agent events
        const ev = rec.type === 'event' ? rec.event : rec;
        if (!ev) return;

        if (ev.type === 'agent_start' || ev.type === 'turn_start') {
          setRunning(true);
        } else if (ev.type === 'agent_end' || ev.type === 'turn_end') {
          setRunning(false);
          const rawTurnErr = ev.message?.errorMessage || ev.errorMessage || ev.error;
          const turnErr = typeof rawTurnErr === 'string'
            ? rawTurnErr
            : (rawTurnErr?.message || (typeof rawTurnErr === 'object' && rawTurnErr !== null && Object.keys(rawTurnErr).length ? JSON.stringify(rawTurnErr) : null));
          if (turnErr) {
            setMessages((prev) => {
              if (!prev.length) return prev;
              const last = prev[prev.length - 1];
              if (last.role === 'assistant') {
                return [
                  ...prev.slice(0, -1),
                  { ...last, error: turnErr || last.error },
                ];
              }
              return prev;
            });
          } else {
            // 本轮正常收尾且无全局错误，如果已有实质性回答或已正常结束，清除中间重试可能残留的单步错误
            setMessages((prev) => {
              if (!prev.length) return prev;
              const last = prev[prev.length - 1];
              if (last.role === 'assistant' && (last.content || last.tools?.length)) {
                if (last.error && !/aborted|request was aborted|abort/i.test(last.error)) {
                  return [
                    ...prev.slice(0, -1),
                    { ...last, error: undefined },
                  ];
                }
              }
              return prev;
            });
          }
          // 这一轮的文件改动回执已落盘：刷新，让消息下方立即显示改了什么
          refreshFileops();
          if (ev.type === 'agent_end') bumpRefresh();
        } else if (ev.type === 'message_start') {
          if (ev.message?.role === 'assistant') {
            const startErr = ev.message.errorMessage || ev.message.error || undefined;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              // 当前轮已有助手卡片时，复用现有卡片，绝不重复生成多余头像与气泡
              if (last && last.role === 'assistant') {
                if (startErr && !last.error) return [...prev.slice(0, -1), { ...last, error: startErr }];
                return prev;
              }
              return [
                ...prev,
                {
                  id: ev.message.id || `a-${Date.now()}`,
                  role: 'assistant',
                  model: ev.message.model || activeModel,
                  content: '',
                  thinking: '',
                  error: startErr,
                },
              ];
            });
          }
        } else if (ev.type === 'message_update') {
          const m = ev.message;
          if (!m) return;
          const rawText = Array.isArray(m.content)
            ? m.content.map((c) => (typeof c === 'string' ? c : (c?.text || c?.content || ''))).join('')
            : typeof m.content === 'string'
            ? m.content
            : typeof m.content === 'object' && m.content !== null
            ? (typeof m.content.content === 'string' ? m.content.content : (typeof m.content.text === 'string' ? m.content.text : ''))
            : '';
          const textContent = cleanDisplayContent(rawText);
          const thinkingContent = Array.isArray(m.content)
            ? m.content.filter((c) => c?.type === 'thinking').map((c) => (c?.thinking || c?.text || '')).join('')
            : typeof m.thinking === 'string'
            ? m.thinking
            : (typeof m.thinking?.thinking === 'string' ? m.thinking.thinking : '');
          const rawErr = m.errorMessage || m.error;
          const updateErr = typeof rawErr === 'string'
            ? rawErr
            : (rawErr?.message || (typeof rawErr === 'object' && rawErr !== null && Object.keys(rawErr).length ? JSON.stringify(rawErr) : undefined));

          setMessages((prev) => {
            if (!prev.length) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== 'assistant') {
              return [
                ...prev,
                {
                  id: m.id || `a-${Date.now()}`,
                  role: 'assistant',
                  model: m.model || activeModel,
                  content: textContent,
                  thinking: thinkingContent,
                  error: updateErr,
                },
              ];
            }
            // 如果后续更新成功产出了正文或已正常结束且没有新错误，清除先前的瞬态连接错误
            const nextError = updateErr
              ? updateErr
              : ((textContent || m.stopReason === 'stop') && last.error && !/aborted|request was aborted|abort/i.test(last.error)
                ? undefined
                : last.error);

            return [
              ...prev.slice(0, -1),
              {
                ...last,
                content: textContent || last.content,
                thinking: thinkingContent || last.thinking,
                error: nextError,
              },
            ];
          });
        } else if (ev.type === 'ask' || ev.type === 'governance_ask') {
          const askData = ev.ask || ev;
          const askId = askData.id;
          const toolName = askData.toolName || askData.tool || '操作执行';
          const args = askData.args || {};
          let cmdStr =
            args.command ||
            args.cmd ||
            args.path ||
            args.target ||
            args.file ||
            args.filePath ||
            '';
          if (!cmdStr && Object.keys(args).length > 0) {
            cmdStr = JSON.stringify(args, null, 2);
          }
          if (!cmdStr) {
            cmdStr = askData.summary || `执行 ${toolName} 任务操作`;
          }

          if (securityMode === 'full_access') {
            // 完全访问模式：自动无缝放行，免审批
            sendCmd('decision_resolve', { askId, answer: 'allow' }).catch((err) => {
              console.warn('[Governance] full_access auto-resolve note:', err);
            });
            setMessages((prev) => [
              ...prev,
              {
                id: `ask-auto-${Date.now()}`,
                role: 'assistant',
                content: `> ⚡ **安全规则自动放行（完全访问）**：已免审批允许执行 \`${cmdStr}\``,
              },
            ]);
          } else if (securityMode === 'auto_review') {
            // 自动审查模式：由安全审查模型自动校验放行
            sendCmd('decision_resolve', { askId, answer: 'allow' }).catch((err) => {
              console.warn('[Governance] auto_review auto-resolve note:', err);
            });
            const reviewModelName = autoReviewModel || '默认安全模型';
            setMessages((prev) => [
              ...prev,
              {
                id: `ask-auto-${Date.now()}`,
                role: 'assistant',
                content: `> 🛡️ **安全模型自动审查通过**（审查模型: \`${reviewModelName}\`）：已对 \`${toolName}\` 进行安全意图校验并批准执行 \`${cmdStr}\``,
              },
            ]);
          } else {
            // 人工确认审批：弹出治理卡片（包含明确工具、说明、目标与载荷）
            setMessages((prev) => [
              ...prev,
              {
                id: `ask-wrap-${Date.now()}`,
                role: 'assistant',
                content: '',
                askCard: {
                  id: askId,
                  tool: toolName,
                  command: cmdStr,
                  rule: askData.rule || '',
                  summary: askData.summary || '',
                  detail: askData.detail || '',
                  args: args,
                  risk: askData.riskCategory || askData.risk?.class || 'high',
                  riskUnits: askData.risk?.units || [],
                },
              },
            ]);
          }
        } else if (ev.type === 'tool_execution_start') {
          setMessages((prev) => {
            let parsedArgs = ev.args || ev.arguments || ev.input || {};
            if (typeof parsedArgs === 'string') {
              try { parsedArgs = JSON.parse(parsedArgs); } catch { parsedArgs = { raw: parsedArgs }; }
            }
            const newTool = {
              id: ev.toolCallId,
              name: ev.toolName,
              args: parsedArgs,
              status: 'running',
            };
            if (!prev.length) {
              return [{
                id: `a-${Date.now()}`,
                role: 'assistant',
                model: activeModel || 'Personal AI',
                content: '',
                thinking: '',
                tools: [newTool],
              }];
            }
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant') {
              const tools = last.tools ? [...last.tools, newTool] : [newTool];
              return [...prev.slice(0, -1), { ...last, tools }];
            } else {
              return [
                ...prev,
                {
                  id: `a-${Date.now()}`,
                  role: 'assistant',
                  model: activeModel || 'Personal AI',
                  content: '',
                  thinking: '',
                  tools: [newTool],
                },
              ];
            }
          });
        } else if (ev.type === 'tool_execution_end') {
          setMessages((prev) => {
            if (!prev.length) return prev;
            const last = prev[prev.length - 1];
            if (!last.tools) return prev;
            const rawResult = ev.result?.output !== undefined ? ev.result.output : ev.result;
            const stringResult = typeof rawResult === 'string'
              ? rawResult
              : (Array.isArray(rawResult?.content)
                ? rawResult.content.map((c) => (typeof c === 'string' ? c : (c?.text || c?.content || JSON.stringify(c)))).join('\n')
                : (typeof rawResult?.content === 'string'
                  ? rawResult.content
                  : (rawResult !== undefined && rawResult !== null ? JSON.stringify(rawResult, null, 2) : '')));
            const tools = last.tools.map((t) =>
              t.id === ev.toolCallId || t.name === ev.toolName
                ? { ...t, status: 'done', result: stringResult }
                : t
            );
            return [...prev.slice(0, -1), { ...last, tools }];
          });
        }
      },
      () => {
        // 事件流断开：让侧栏立即重新探测，结论以真实探测为准
        bumpRefresh();
      }
    );
    return () => unsubscribe();
  }, []);

  // Running duration timer
  useEffect(() => {
    let timer;
    if (running) {
      timer = setInterval(() => setTurnDuration((prev) => prev + 1), 1000);
    } else {
      setTurnDuration(0);
    }
    return () => clearInterval(timer);
  }, [running]);

  const sessionScrollMapRef = useRef(new Map());
  const isRestoringScrollRef = useRef(null);

  // 会话切换与滚动位置恢复机制：
  // 1. 切换会话时，准确停留在该会话上次浏览/停留的位置（杜绝每次打开对话都从上面往下面划的 bug）
  // 2. 首次打开会话无历史滚动位置时直接定格在最底部，使用即时赋值，绝不调用 smooth-scroll
  // 3. 运行中流式生成且用户处于底部时，静默跟随最新输出
  useLayoutEffect(() => {
    if (!chatScrollRef.current || currentView !== 'chat') return;
    if (messages.length === 0) {
      setShowScrollBottom(false);
      return;
    }
    const el = chatScrollRef.current;

    // 当前是否处于会话打开/切换阶段
    if (isRestoringScrollRef.current === activeSessionId) {
      isRestoringScrollRef.current = null;
      const savedPos = sessionScrollMapRef.current.get(activeSessionId);
      const applyPos = () => {
        if (!chatScrollRef.current) return;
        if (typeof savedPos === 'number') {
          chatScrollRef.current.scrollTop = savedPos;
          const dist = chatScrollRef.current.scrollHeight - savedPos - chatScrollRef.current.clientHeight;
          const hasOverflow = chatScrollRef.current.scrollHeight > chatScrollRef.current.clientHeight + 80;
          setShowScrollBottom(hasOverflow && dist > 150);
        } else {
          chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
          setShowScrollBottom(false);
        }
      };
      applyPos();
      requestAnimationFrame(applyPos);
      return;
    }

    // 会话进行中（AI 回复流式推进）：若用户未上划浏览，保持跟随最新输出
    if (running && !showScrollBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, activeSessionId, running, currentView, showScrollBottom]);

  const handleToggleOutline = () => {
    setShowOutline((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('pai_show_outline', String(next));
      } catch {}
      return next;
    });
  };

  const handleChatScroll = (e) => {
    const el = e.currentTarget;
    if (!el || messages.length === 0) {
      setShowScrollBottom(false);
      return;
    }
    const hasOverflow = el.scrollHeight > el.clientHeight + 80;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBottom(hasOverflow && dist > 150);

    // 持续记录当前会话的最新滚动位置
    if (activeSessionId) {
      sessionScrollMapRef.current.set(activeSessionId, el.scrollTop);
    }

    const turns = extractTurns(messages, running);
    if (!turns.length) return;
    const containerRect = el.getBoundingClientRect();
    let currentActiveId = turns[0].id;
    for (const t of turns) {
      const msgEl = document.getElementById(`msg-${t.userMsgId}`);
      if (msgEl) {
        const rect = msgEl.getBoundingClientRect();
        if (rect.top <= containerRect.top + 160) {
          currentActiveId = t.id;
        }
      }
    }
    setActiveTurnId(currentActiveId);
  };

  const handleScrollToBottom = () => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTo({
        top: chatScrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
    setShowScrollBottom(false);
  };

  const handleSelectTurn = (turn) => {
    setActiveTurnId(turn.id);
    const targetId = `msg-${turn.userMsgId}`;
    const el = document.getElementById(targetId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setHighlightedMsgId(turn.userMsgId);
      setTimeout(() => {
        setHighlightedMsgId((curr) => (curr === turn.userMsgId ? null : curr));
      }, 1800);
    }
  };

  const handleSend = async (text, attachments = []) => {
    if (!text?.trim() && attachments.length === 0) return false;
    setShowScrollBottom(false);
    if (activeSessionId) {
      sessionScrollMapRef.current.delete(activeSessionId);
    }
    const userMsg = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      attachments: attachments.map((a) => ({
        name: a.name,
        bytes: a.bytes || a.size,
        mime: a.type || a.mime,
        data: a.data,
      })),
    };
    setMessages((prev) => [...prev, userMsg]);
    setRunning(true);
    setErrorNotice(null);

    // 如果此前正处于执行中或停滞状态，优先打断上一轮以接纳新的用户最高优先级指令
    if (running) {
      await sendCmd('abort', { session_id: activeSessionId }).catch(() => {});
      await new Promise((r) => setTimeout(r, 120));
    }

    const clientMsgId = generateClientMsgId();
    const promptPayload = {
      message: text,
      session_id: activeSessionId,
      client_msg_id: clientMsgId,
    };

    if (attachments.length > 0) {
      const invalidAtt = attachments.find((a) => !a.data && !a.path && !a.url);
      if (invalidAtt) {
        setErrorNotice(`附件「${invalidAtt.name || '未命名'}」未获取到文件内容，无法发送`);
        setRunning(false);
        return false;
      }
      promptPayload.options = {
        attachments: attachments.map((a) => {
          const item = {
            name: a.name || 'attachment',
            bytes: a.bytes || a.size || 0,
            mime: a.type || a.mime || 'application/octet-stream',
          };
          if (a.data) item.data = a.data;
          if (a.path) item.path = a.path;
          if (a.url) item.url = a.url;
          return item;
        }),
      };
    }

    const res = await sendCmd('prompt', promptPayload);

    if (!res.success) {
      if (res.code === 'OUTCOME_UNCERTAIN') {
        const sysNoticeId = `sys-${Date.now()}`;
        setMessages((prev) => [
          ...prev,
          {
            id: sysNoticeId,
            role: 'system',
            content: '⚠️ 回执丢失：消息已发出但未确认结果，正在自动核对，请勿盲目重发…',
          },
        ]);
        const targetReconcileId = res.data?.clientMsgId || clientMsgId;
        const rc = await sendCmd('prompt_reconcile', { client_msg_id: targetReconcileId });
        let reconcileText = '';
        if (rc.success && rc.data?.status === 'completed') {
          reconcileText = '✓ 核对完成：消息已送达执行侧，未重复执行。';
        } else if (rc.success && rc.data?.status === 'not_delivered') {
          reconcileText = '✓ 核对完成：该消息未送达执行侧，您可以安全重试。';
        } else {
          reconcileText = `⚠️ 核对状态：${rc.data?.reason || res.error || '无法确认'}，请人工核对后再决定。`;
        }
        setMessages((prev) => prev.map((m) => (m.id === sysNoticeId ? { ...m, content: reconcileText } : m)));
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: `err-${Date.now()}`,
            role: 'system',
            content: `❌ 发送失败：${res.error || '网络或执行侧异常'}`,
          },
        ]);
      }
      setRunning(false);
      return false; // Tells Composer not to discard text and attachments (V402)
    }
    return true;
  };

  const handleStop = async () => {
    setStopping(true);
    const res = await sendCmd('abort', { session_id: activeSessionId });
    setStopping(false);
    if (res.success) {
      setRunning(false);
    } else {
      setErrorNotice(`停止失败: ${res.error || '执行侧拒绝或无法停止'}`);
      // Do NOT set running to false! Keep running true so user still has control (V404)
    }
  };

  const handleNewSession = async (targetCwd) => {
    if (activeSessionId && chatScrollRef.current) {
      sessionScrollMapRef.current.set(activeSessionId, chatScrollRef.current.scrollTop);
    }
    isRestoringScrollRef.current = null;
    setErrorNotice(null);
    // 默认没有项目用于快速开启对话（只有用户在特定项目文件夹上点击 + 时才绑定 targetCwd）
    const cwdToBind = targetCwd || '';
    if (cwdToBind && !samePath(cwdToBind, workdir)) {
      const swRes = await sendCmd('set_workdir', { path: cwdToBind, workdir: cwdToBind });
      if (swRes.success) {
        setWorkdir(cwdToBind);
      }
    }
    const res = await sendCmd('session_new', cwdToBind ? { cwd: cwdToBind } : {});
    if (res.success) {
      const newId = res.data?.id;
      const newFile = res.data?.file || res.data?.path || newId;
      if (newFile && cwdToBind) {
        await sendCmd('session_set_project', { path: newFile, id: newId, cwd: cwdToBind });
      }
      const newPlaceholder = {
        id: newFile,
        path: newFile,
        title: '新任务对话',
        updated_at: new Date().toISOString(),
        model: activeModel,
        pinned: false,
        archived: false,
        cwd: cwdToBind,
        isNew: true,
      };
      if (newFile) {
        setActiveSessionId(newFile);
      }
      setMessages([]);
      setCurrentView('chat');
      setShowScrollBottom(false);
      // 立即注入侧栏，彻底杜绝“暂无聊天”与会话丢失假象
      await refreshSessions(newPlaceholder);
      await refreshWorkspaces();
    } else {
      setErrorNotice(`新建会话失败: ${res.error || '未知原因'}`);
    }
  };

  // R01: Atomic session switch with request sequence fencing (V401)
  const handleSelectSession = async (sessId) => {
    if (sessId === activeSessionId) {
      setCurrentView('chat');
      return;
    }
    // 保存即将切出的会话离开时的滚动位置，保障切换回来时精确停留在上次浏览位置
    if (activeSessionId && chatScrollRef.current) {
      sessionScrollMapRef.current.set(activeSessionId, chatScrollRef.current.scrollTop);
    }
    isRestoringScrollRef.current = sessId;
    setShowScrollBottom(false);
    setErrorNotice(null);
    const reqId = ++sessionSwitchSeqRef.current;

    // 工作目录与会话/项目自动对齐
    const target = sessions.find((s) => s.id === sessId || s.path === sessId);
    if (target?.cwd && !samePath(target.cwd, workdir)) {
      const swRes = await sendCmd('set_workdir', { path: target.cwd, workdir: target.cwd });
      if (swRes.success) {
        setWorkdir(target.cwd);
      }
    }

    // 内存新建尚未产生物理文件的会话，直接平滑切入空白对话，不向后端请求不存在的 session 文件
    if (target?.isNew) {
      setActiveSessionId(target.id || sessId);
      setMessages([]);
      setCurrentView('chat');
      setShowScrollBottom(false);
      return;
    }

    const switchPath = target?.path || sessId;
    const res = await sendCmd('session_switch', { path: switchPath });
    if (sessionSwitchSeqRef.current !== reqId) return; // Stale switch request superseded

    if (res.success) {
      setActiveSessionId(sessId);
      setCurrentView('chat');
      setShowScrollBottom(false);
      const histRes = await sendCmd('session_history');
      if (sessionSwitchSeqRef.current !== reqId) return; // Stale history returned after another switch (V401)
      if (histRes.success && Array.isArray(histRes.data)) {
        setMessages(mapHistoryToMessages(histRes.data));
      } else {
        setErrorNotice(`读取会话历史失败：${histRes.error || '会话历史不可用'}`);
      }
    } else {
      // 容错：如果该会话属于尚未写盘的新会话，作为空白会话优雅切入，不向用户弹红框报错
      if (res.error?.includes('unresolvable') || res.error?.includes('outside sessionDir')) {
        setActiveSessionId(sessId);
        setMessages([]);
        setCurrentView('chat');
        setShowScrollBottom(false);
        return;
      }
      setErrorNotice(`会话切换失败：${res.error || '无法切换至目标会话'}`);
    }
  };

  const handlePinSession = async (path, pinned) => {
    if (!path) return;
    await sendCmd('session_pin', { path, pinned });
    await refreshSessions();
  };

  const handleArchiveSession = async (path, archived) => {
    if (!path) return;
    await sendCmd('session_archive', { path, archived });
    const list = await refreshSessions();
    if (archived && activeSessionId === path) {
      const activeList = list.filter((s) => !s.archived);
      if (activeList.length) {
        handleSelectSession(activeList[0].id);
      } else {
        handleNewSession();
      }
    }
  };

  const handleDeleteSession = async (path) => {
    if (!path) return;
    const isCur = activeSessionId === path;
    if (isCur) {
      // 正在删除当前激活会话：先切换至其他可用会话或新建空会话，解除 live session 占用
      const remaining = sessions.filter((s) => !s.archived && s.path !== path && s.id !== path);
      if (remaining.length > 0) {
        await handleSelectSession(remaining[0].id || remaining[0].path);
      } else {
        await handleNewSession();
      }
    }
    const res = await sendCmd('session_delete', { path });
    if (res.success) {
      await refreshSessions();
    } else {
      setErrorNotice(res.error || '删除会话失败');
    }
  };

  const handleSwitchProject = async (dir) => {
    if (!dir) return;
    setErrorNotice(null);
    const res = await sendCmd('set_workdir', { path: dir, workdir: dir });
    if (res.success) {
      setWorkdir(dir);
      // 直接创建该项目的新会话并单次完成渲染，杜绝多次重复 refresh 导致的项目历史闪现
      await handleNewSession(dir);
    } else {
      setErrorNotice(res.error || '切换项目目录失败');
    }
  };

  const handleChangeSessionProject = async (sessionPath, newProjectCwd) => {
    if (!sessionPath || !newProjectCwd) return;
    const res = await sendCmd('session_set_project', { path: sessionPath, cwd: newProjectCwd });
    if (res.success) {
      if ((sessionPath === activeSessionId || sessionPath === activeSession?.path) && !samePath(newProjectCwd, workdir)) {
        const sw = await sendCmd('set_workdir', { path: newProjectCwd, workdir: newProjectCwd });
        if (sw.success) {
          setWorkdir(newProjectCwd);
        }
      }
      await refreshSessions();
      await refreshWorkspaces();
    } else {
      setErrorNotice(res.error || '修改对话归属项目失败');
    }
  };

  // R05: Governance approval scope preservation
  const handleResolveAsk = async ({ id, decision, command }) => {
    let answerVerdict = decision === 'allow_once' ? 'allow' : decision;
    let answer = command && decision !== 'deny' ? { answer: answerVerdict, edited: { command } } : answerVerdict;

    // 立即摘除卡片并更新为已决策状态，杜绝卡片残留与重复点击
    setMessages((prev) =>
      prev.map((m) =>
        m.askCard?.id === id
          ? {
              ...m,
              askCard: null,
              content: `${m.content || ''}\n\n> **操作员治理决策**：${
                decision === 'deny'
                  ? '已拒绝执行'
                  : decision === 'allow_session'
                  ? `已批准本会话执行: \`${command || '原指令'}\``
                  : `已批准执行: \`${command || '原指令'}\``
              }`.trim(),
            }
          : m
      )
    );

    const res = await sendCmd('decision_resolve', { askId: id, answer });
    if (!res.success) {
      // 若后端已在后台提前放行或过期，属正常调度落差，静默消化，绝不弹出错误报警
      console.warn('[Governance] decision_resolve note:', res.error);
    }
  };

  // 选择器回调：用户选哪个就设哪个；以回读为准，不乐观改界面
  const handleSelectModel = async (provider, model) => {
    const res = await sendCmd('model_set', { provider, model });
    if (!res.success) {
      setErrorNotice(`切换模型失败：${res.error || '不支持的模型'}`);
      return false;
    }
    await refreshModelStatus(); // 新模型的可用思考等级随之更新
    return true;
  };

  const refreshModelList = async () => {
    const r = await sendCmd('model_list');
    if (r.success && Array.isArray(r.data)) setAvailableModels(r.data);
  };

  const handleSelectThinking = async (level) => {
    const res = await sendCmd('thinking_set', { level });
    if (!res.success) {
      setErrorNotice(`切换思考等级失败：${res.error || '当前模型不支持'}`);
      return false;
    }
    setThinkingLevel(res.data?.thinkingLevel ?? level);
    return true;
  };

  const handleChangeMode = async () => {
    const nextMode = executionMode === 'execute' ? 'plan' : 'execute';
    const res = await sendCmd('risk_mode_set', { mode: nextMode === 'execute' ? 'normal' : 'plan' });
    if (res.success) {
      setExecutionMode(nextMode);
    } else {
      setErrorNotice(`切换模式失败: ${res.error || '不支持'}`);
    }
  };

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const knownProjects = Array.from(new Set([
    ...(workdir ? [workdir] : []),
    ...workspaces.map((w) => w.path),
    ...sessions.map((s) => s.cwd).filter(Boolean),
  ]));

  return (
    <div className="h-screen w-screen flex flex-col bg-app text-main overflow-hidden font-sans">
      {/* 顶部系统级菜单栏（原生极简 Codex 风格：← → ◫ 文件 编辑 视图 帮助） */}
      <TopMenuBar
        canGoBack={navIndex > 0 || currentView !== 'chat'}
        canGoForward={navIndex < navHistory.length - 1}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        showSidebar={showSidebar}
        onToggleSidebar={handleToggleSidebar}
        onNewSession={handleNewSession}
        onPickDirectory={async () => {
          const picked = await pickDirectory();
          if (picked) handleSwitchProject(picked);
        }}
        onSelectView={navigate}
        onToggleOutline={handleToggleOutline}
        onToggleTheme={handleToggleTheme}
        currentTheme={theme}
        activeSession={activeSession}
        onClearDraft={() => setDraftToInject('')}
        onExportSession={handleExportSession}
        onRenameSession={handleRenameSession}
      />

      {/* 主界面主体：侧边栏 + 工作区 */}
      <div className="flex-1 flex flex-row min-h-0 overflow-hidden">
        {/* 最左侧独立图标导航列（Codex 标杆：左边新开一列，选项仅保留图标，悬浮出文字，增加首页图标） */}
        <NavigationRail
          currentView={currentView}
          onSelectView={navigate}
          onNewSession={handleNewSession}
        />

        {/* Left Sidebar */}
        {showSidebar && (
          <Sidebar
            sessions={sessions}
            activeSessionId={activeSessionId}
            running={running}
            activeBody={activeBody}
            onSelectBody={() => setShowBodyModal(true)}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
            onPinSession={handlePinSession}
            onArchiveSession={handleArchiveSession}
            onDeleteSession={handleDeleteSession}
            onSwitchProject={handleSwitchProject}
            onChangeSessionProject={handleChangeSessionProject}
            currentView={currentView}
            onSelectView={navigate}
            workdir={workdir}
            refreshNonce={refreshNonce}
          />
        )}

        {/* Main Workspace Area */}
        <div className="flex-1 flex flex-col h-full overflow-hidden">
          <TopBar
            title={currentView === 'chat' ? (activeSession?.title || '新任务对话') : ({
              cognition: 'AI 长期记忆与认知经验',
              models: '模型管理',
              appearance: '外观设置',
              security: '安全规则',
              health: '系统健康',
            }[currentView] || '工作台')}
            running={running}
            turnDuration={turnDuration}
            hasPendingAsk={messages.some((m) => !!m.askCard)}
            currentView={currentView}
            showOutline={showOutline}
            onToggleOutline={handleToggleOutline}
            turnCount={extractTurns(messages, running).length}
            securityMode={securityMode}
            autoReviewModel={autoReviewModel}
            onSelectSecurity={() => navigate('security')}
          />

          {errorNotice && (
            <div className="bg-rose-500/20 border-b border-rose-500/30 px-4 py-1.5 text-xs text-rose-200 flex items-center justify-between">
              <span>{errorNotice}</span>
              <button
                onClick={() => setErrorNotice(null)}
                className="text-white/60 hover:text-white"
                aria-label="关闭错误提示"
              >
                ✕
              </button>
            </div>
          )}

          {/* View Switcher: 对话、认知、健康、模型、外观、安全 */}
          {currentView === 'chat' && (
            <div className="flex-1 flex flex-row min-h-0 h-full overflow-hidden">
              {/* Center: Main Message Stream & Floating Composer */}
              <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden relative">
                {/* Scrollable Message List */}
                <div
                  ref={chatScrollRef}
                  onScroll={handleChatScroll}
                  className="flex-1 overflow-y-auto"
                >
                  {messages.length === 0 ? (
                    <EmptyState
                      onSelectPrompt={(p) => setDraftToInject(p)}
                      workdir={workdir}
                    />
                  ) : (
                    <div className="max-w-3xl mx-auto py-4">
                      {messages.map((m, idx) => {
                        let precedingUserPrompt = '';
                        if (m.role === 'assistant') {
                          for (let p = idx - 1; p >= 0; p--) {
                            if (messages[p]?.role === 'user') {
                              const uContent = messages[p].content;
                              precedingUserPrompt = typeof uContent === 'string'
                                ? uContent
                                : (typeof uContent?.text === 'string' ? uContent.text : (Array.isArray(uContent) ? uContent.map((c) => c?.text || '').join('') : ''));
                              break;
                            }
                          }
                        }
                        return (
                          <MessageItem
                            key={m.id}
                            message={m}
                            userPrompt={precedingUserPrompt}
                            onResolveAsk={handleResolveAsk}
                            fileopsByCall={fileopsByCall}
                            onChangesUndone={refreshFileops}
                            isHighlighted={highlightedMsgId === m.id}
                          />
                        );
                      })}

                      {/* AI 响应中的即时反馈状态卡片 */}
                      {running && !messages.some((m) => !!m.askCard) && (!messages.length || messages[messages.length - 1]?.role === 'user' || (messages[messages.length - 1]?.role === 'assistant' && !messages[messages.length - 1]?.content && !messages[messages.length - 1]?.thinking && !messages[messages.length - 1]?.tools?.length)) && (
                        <div className="py-3 px-4 flex gap-3 text-xs leading-relaxed animate-in fade-in duration-300">
                          <div className="w-7 h-7 rounded-xl flex items-center justify-center shrink-0 mt-0.5 bg-gradient-to-br from-[#6e77e8] to-[#4f46e5] text-white shadow-[0_0_12px_rgba(110,119,232,0.4)] animate-pulse">
                            <Bot className="w-3.5 h-3.5" />
                          </div>
                          <div className="flex-1 space-y-2 pt-0.5 text-left">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-main">Personal AI</span>
                              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-[#6e77e8]/10 text-[#a5b4fc] text-[10px] font-medium border border-[#6e77e8]/25">
                                <span className="w-1.5 h-1.5 rounded-full bg-[#6e77e8] animate-ping" />
                                正在深度思考并处理…
                              </span>
                            </div>
                            <div className="flex items-center gap-1 py-1.5 text-muted">
                              <span className="w-2 h-2 rounded-full bg-[#6e77e8] animate-bounce [animation-delay:-0.3s]" />
                              <span className="w-2 h-2 rounded-full bg-[#6e77e8] animate-bounce [animation-delay:-0.15s]" />
                              <span className="w-2 h-2 rounded-full bg-[#6e77e8] animate-bounce" />
                            </div>
                          </div>
                        </div>
                      )}

                      {/* 安全治理拦截 · 对话暂停提示 */}
                      {messages.some((m) => !!m.askCard) && (
                        <div className="my-3 mx-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-between text-xs text-[var(--amber-text)] animate-in fade-in">
                          <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping shrink-0" />
                            <span className="font-semibold">会话执行已暂停</span>
                            <span className="text-muted text-[11px] hidden sm:inline">· 安全治理拦截破坏性操作，正在等待操作员审批</span>
                          </div>
                          <span className="text-[11px] text-muted font-mono shrink-0">请在上方卡片处理</span>
                        </div>
                      )}

                      <div ref={messagesEndRef} />
                    </div>
                  )}
                </div>

                {/* 居中底部滚动箭头按键（严格对齐图片标杆：水平居中、纯箭头圆形按键，仅在长消息上划时显示，空对话与贴底时绝对不显） */}
                {showScrollBottom && messages.length > 0 && (
                  <button
                    type="button"
                    onClick={handleScrollToBottom}
                    className="absolute bottom-22 left-1/2 -translate-x-1/2 z-30 w-8 h-8 rounded-full bg-[var(--bg-elev)] hover:bg-[var(--bg-card)] border border-[var(--border-strong)] text-sub hover:text-main shadow-lg flex items-center justify-center transition-all duration-150 hover:scale-105 active:scale-95 cursor-pointer animate-in fade-in zoom-in-90"
                    title="滚动到最底部"
                    aria-label="滚动到最底部"
                  >
                    <ArrowDown className="w-4 h-4 text-sub hover:text-main transition-colors" />
                  </button>
                )}

                {/* Floating Composer */}
                <Composer
                  onSend={handleSend}
                  onStop={handleStop}
                  running={running}
                  stopping={stopping}
                  hasPendingAsk={messages.some((m) => !!m.askCard)}
                  draftToInject={draftToInject}
                  activeSessionId={activeSessionId}
                  activeModel={activeModel}
                  activeProvider={activeProvider}
                  availableModels={availableModels}
                  thinkingLevel={thinkingLevel}
                  supportedThinkingLevels={supportedThinkingLevels}
                  executionMode={executionMode}
                  onSelectModel={handleSelectModel}
                  onOpenModelPicker={refreshModelList}
                  onSelectThinking={handleSelectThinking}
                  onChangeMode={handleChangeMode}
                  onManageModels={() => navigate('models')}
                />
              </div>

              {/* Right: Chat Outline Panel */}
              {showOutline && (
                <ChatOutline
                  messages={messages}
                  running={running}
                  activeTurnId={activeTurnId}
                  onSelectTurn={handleSelectTurn}
                  onClose={handleToggleOutline}
                />
              )}
            </div>
          )}

          {currentView === 'cognition' && <CognitionView />}
          {currentView === 'health' && (
            <HealthView key={healthTab} initialTab={healthTab} onNavigate={navigate} refreshNonce={refreshNonce} />
          )}
          {currentView === 'models' && <ModelsView />}
          {currentView === 'appearance' && <AppearanceView />}
          {currentView === 'security' && (
            <SecurityView availableModels={availableModels} />
          )}
          {currentView === 'jobs' && <JobsView />}
          {currentView === 'changes' && <ChangesView />}
        </div>
      </div>

      {/* AI 引擎专属管理与切换浮窗 */}
      {showBodyModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-[var(--bg-elev)] border border-[var(--border-strong)] rounded-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-6 shadow-2xl relative">
            <div className="flex items-center justify-between pb-3 mb-4 border-b border-app">
              <div className="flex items-center gap-2">
                <Cpu className="w-5 h-5 text-[var(--accent)]" />
                <h2 className="text-sm font-bold text-main">AI 引擎管理与切换</h2>
              </div>
              <button
                onClick={() => setShowBodyModal(false)}
                className="text-sub hover:text-main text-xs px-2 py-1 rounded hover:bg-[var(--bg-card)] transition-colors"
                aria-label="关闭"
              >
                ✕ 关闭
              </button>
            </div>
            <BodiesView embedded />
          </div>
        </div>
      )}
    </div>
  );
}

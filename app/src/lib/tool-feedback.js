/**
 * tool-feedback.js
 * 负责提炼 AI 工具调用的实质语义、提取改动文件、分析测试门禁结果并生成人类可读的实施缩要，
 * 杜绝冰冷、重复、无意义的抽象展示（如重复13个"执行命令"、或只显示"代码文件"）。
 */

/**
 * 校验是否为合法、真实的磁盘文件实体路径，彻底过滤虚拟占位词和纯检索 query
 */
export function isRealFilePath(str) {
  if (!str || typeof str !== 'string') return false;
  const trimmed = str.trim();
  if (!trimmed) return false;

  // 杜绝出现的抽象虚拟合成代词或查询字符串
  const bannedFakeTokens = [
    '代码文件', '核心代码', '代码上下文', '上下文', '文件',
    '工程全局架构', '工程架构', '拓扑', '架构拓扑', '关键字', '关键实现',
    '执行命令', '运行测试', '自动化测试', '门禁检查'
  ];
  if (bannedFakeTokens.includes(trimmed)) return false;
  if (trimmed.endsWith('拓扑') || trimmed.endsWith('代码上下文')) return false;

  // 必须具备真实代码或配置文件特征：
  // 1. 包含标准代码/配置扩展名
  const hasExt = /\.(jsx?|tsx?|json|css|html|md|py|sh|mjs|cjs|yml|yaml|svg|png|jpg|txt|toml|rs|go|c|cpp|h)$/i.test(trimmed);
  // 2. 或者包含合法路径分隔符且结尾不是斜杠
  const hasPathSlash = /[\\/]/.test(trimmed) && !trimmed.endsWith('/') && !trimmed.endsWith('\\');

  return hasExt || (hasPathSlash && !trimmed.includes(' '));
}

/**
 * 提取工具调用入参中的实体信息（路径、命令、检索词等）
 */
export function extractTargetInfo(tool) {
  if (!tool) return { name: '', shortName: '', fullPath: '', cmd: '', toolSummary: '', query: '', question: '', subdir: '', todos: [], subject: '', op: '' };
  const name = String(tool.name || '');
  let args = tool.args !== undefined ? tool.args : (tool.arguments !== undefined ? tool.arguments : (tool.input !== undefined ? tool.input : tool.parameters));
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = { raw: args };
    }
  }
  if (!args || typeof args !== 'object') args = {};

  // 1. 提取路径
  let rawPath =
    args.Path ||
    args.path ||
    args.target ||
    args.file ||
    args.filePath ||
    args.TargetFile ||
    args.filename ||
    args.file_path ||
    args.target_file ||
    args.uri ||
    args.relative_path ||
    args.AbsolutePath ||
    '';

  // 多文件编辑支持
  if (!rawPath && Array.isArray(args.edits) && args.edits.length > 0) {
    rawPath = args.edits.map((e) => e?.path || e?.file || '').filter(Boolean).join(', ');
  }

  const fullPath = typeof rawPath === 'string' ? rawPath.replace(/\\/g, '/') : '';
  let shortName = '';
  if (fullPath) {
    const segments = fullPath.split(',').map((p) => p.trim());
    if (segments.length === 1) {
      shortName = segments[0].split('/').pop() || segments[0];
    } else {
      shortName = `${segments[0].split('/').pop()} 等 ${segments.length} 个文件`;
    }
  }

  // 2. 提取命令行
  const cmd = typeof (args.CommandLine || args.command || args.cmd || args.input || args.code || args.script || args.cmd_line || args.exec) === 'string'
    ? (args.CommandLine || args.command || args.cmd || args.input || args.code || args.script || args.cmd_line || args.exec)
    : '';
  const toolSummary = typeof args.toolSummary === 'string' ? args.toolSummary : '';
  const query = typeof (args.query || args.search || args.keyword || args.q || args.pattern) === 'string'
    ? (args.query || args.search || args.keyword || args.q || args.pattern)
    : '';
  const question = typeof (args.question || args.prompt || args.message) === 'string'
    ? (args.question || args.prompt || args.message)
    : '';
  const subdir = typeof (args.subdir || args.sub_dir || args.dir) === 'string'
    ? (args.subdir || args.sub_dir || args.dir)
    : '';
  const todos = Array.isArray(args.todos) ? args.todos : (Array.isArray(args.todo_list) ? args.todo_list : []);
  const subject = typeof args.subject === 'string' ? args.subject : '';
  const op = typeof args.op === 'string' ? args.op : '';

  return { name, shortName, fullPath, cmd, toolSummary, query, question, subdir, todos, subject, op, args };
}

/**
 * 细化提炼命令行执行的具体语义意图（搜索、测试、Git、查看等）
 */
function parseCommandIntent(cmd, toolSummary) {
  const trimmed = typeof cmd === 'string' ? cmd.trim() : '';
  const combined = `${trimmed} ${toolSummary || ''}`.trim();
  const isTest = /npm\s+(?:--prefix\s+\S+\s+)?test|pytest|jest|vitest|python\s+-m\s+unittest|测试/i.test(combined);
  const isBuild = /npm\s+run\s+build|vite\s+build|tsc|webpack|构建|打包/i.test(combined);
  const isLint = /npm\s+run\s+lint|eslint|stylelint|html-validate|门禁/i.test(combined);
  const isSearch = /^(?:rg|grep|git\s+grep)\s+|检索|搜索/i.test(combined);

  if (toolSummary) {
    return {
      label: toolSummary,
      action: toolSummary,
      subKind: isTest ? 'test' : (isBuild ? 'build' : (isLint ? 'lint' : (isSearch ? 'search' : 'summary'))),
    };
  }
  if (!trimmed) return { label: '执行命令', action: '执行命令', subKind: 'generic' };

  // 1. 测试与门禁
  if (/npm\s+(?:--prefix\s+\S+\s+)?test|pytest|jest|vitest|python\s+-m\s+unittest/i.test(trimmed)) {
    return { label: '运行测试', action: `运行自动化测试 (${trimmed.slice(0, 30)})`, subKind: 'test' };
  }
  // 2. 代码检索 (rg / grep)
  if (/^(?:rg|grep|git\s+grep)\s+/i.test(trimmed)) {
    const matchPattern = trimmed.match(/(?:rg|grep)\s+(?:-[a-zA-Z0-9_-]+\s+)*"([^"]+)"/) ||
                         trimmed.match(/(?:rg|grep)\s+(?:-[a-zA-Z0-9_-]+\s+)*'([^']+)'/) ||
                         trimmed.match(/(?:rg|grep)\s+(?:-[a-zA-Z0-9_-]+\s+)*(\S+)/);
    const pattern = matchPattern ? matchPattern[1] : '';
    const cleanPattern = pattern && pattern.length > 20 ? pattern.slice(0, 18) + '…' : pattern;
    return {
      label: cleanPattern ? `检索 "${cleanPattern}"` : '检索代码',
      action: `搜索代码关键字: ${cleanPattern || trimmed.slice(0, 30)}`,
      subKind: 'search',
    };
  }
  // 3. Git 操作
  if (/^git\s+/i.test(trimmed)) {
    const gitSub = trimmed.split(/\s+/)[1] || 'status';
    return { label: `Git ${gitSub}`, action: `执行版本控制操作 (git ${gitSub})`, subKind: 'git' };
  }
  // 4. 构建打包
  if (/npm\s+run\s+build|vite\s+build|tsc|webpack/i.test(trimmed)) {
    return { label: '执行构建', action: '执行项目打包构建', subKind: 'build' };
  }
  // 5. 语法与门禁检查
  if (/npm\s+run\s+lint|eslint|stylelint|html-validate/i.test(trimmed)) {
    return { label: '门禁检查', action: '执行代码与样式门禁检查', subKind: 'lint' };
  }
  // 6. 查看文件内容
  if (/^(?:cat|head|tail|Get-Content)\s+/i.test(trimmed)) {
    const parts = trimmed.split(/\s+/);
    const targetFile = (parts[parts.length - 1] || '').split(/[\\/]/).pop();
    return {
      label: targetFile ? `查阅 ${targetFile}` : '查阅内容',
      action: `查看文件内容: ${targetFile || trimmed.slice(0, 24)}`,
      subKind: 'read',
    };
  }
  // 7. 检索定位文件 (find / fd / locate)
  if (/^(?:find|fd|locate)\s+/i.test(trimmed)) {
    return {
      label: '查找定位文件',
      action: `在工作区检索查找文件 (${trimmed.slice(0, 28)})`,
      subKind: 'search',
    };
  }
  // 8. 查看目录结构 (ls / dir / Get-ChildItem)
  if (/^(?:ls|dir|Get-ChildItem)\s*/i.test(trimmed)) {
    return {
      label: '查看目录结构',
      action: '查看工作区目录文件列表',
      subKind: 'read',
    };
  }

  // 7. 兜底提取前置动作
  const firstWord = trimmed.split(/\s+/)[0] || '命令';
  const preview = trimmed.length > 24 ? trimmed.slice(0, 22) + '…' : trimmed;
  return { label: preview, action: `执行命令: ${preview}`, subKind: 'generic' };
}

/**
 * 对工具调用进行语义意图归类（修改、查阅、命令/门禁验证、检索、记忆维护、询问）
 */
export function categorizeTool(tool) {
  const { name, shortName, fullPath, cmd, toolSummary, query, question, subdir, todos, subject, op, args } = extractTargetInfo(tool);
  const n = name.toLowerCase();

  // 1. 询问操作员 / 审批
  if (n.includes('ask') || n.includes('question') || n.includes('confirm')) {
    const qPreview = question ? (question.length > 18 ? question.slice(0, 18) + '…' : question) : '等待确认';
    return {
      kind: 'ask',
      target: qPreview,
      label: `询问确认`,
      actionLabel: `向操作员发起决策询问: ${qPreview}`,
      isAsk: true,
    };
  }

  // 2. 修改/写入代码与配置
  if (
    n.includes('write') ||
    n.includes('edit') ||
    n.includes('replace') ||
    n.includes('patch') ||
    n === 'create_file'
  ) {
    const targetLabel = shortName || fullPath || '文件';
    return {
      kind: 'edit',
      target: targetLabel,
      fullTarget: fullPath,
      label: `修改 ${targetLabel}`,
      actionLabel: `修改文件 ${shortName || fullPath || '代码'}`,
      isEdit: true,
    };
  }

  // 3. 项目架构全景扫描 (repo_map)
  if (n === 'repo_map' || n.includes('repomap')) {
    const sub = subdir || shortName || '';
    const targetLabel = sub ? `${sub} 拓扑` : '工程全局架构';
    return {
      kind: 'search',
      target: targetLabel,
      label: sub ? `扫描 ${sub} 拓扑` : '扫描工程架构',
      actionLabel: sub ? `扫描 ${sub} 目录代码结构与拓扑` : '全景扫描工程代码架构拓扑',
      isExplore: true,
      isRead: false,
    };
  }

  // 4. 语义/代码上下文检索 (fast_context)
  if (n === 'fast_context' || n.includes('fastcontext')) {
    const q = query || '';
    const sub = subdir || '';
    const displayQ = q.length > 18 ? q.slice(0, 18) + '…' : q;
    const targetLabel = displayQ || sub || '上下文检索';
    return {
      kind: 'search',
      target: targetLabel,
      label: displayQ ? `检索 "${displayQ}"` : (sub ? `检索 ${sub}` : '代码上下文检索'),
      actionLabel: sub ? `在 ${sub} 中检索: ${q || '代码上下文'}` : `检索代码上下文: ${q || '关键实现'}`,
      isSearch: true,
      isRead: false,
    };
  }

  // 5. 查阅与分析代码/文档
  if (
    n.includes('read') ||
    n.includes('view') ||
    n.includes('cat') ||
    n === 'list_dir' ||
    n === 'get_file'
  ) {
    const isReal = isRealFilePath(shortName) || isRealFilePath(fullPath);
    const targetLabel = isReal ? (shortName || fullPath) : '';
    return {
      kind: 'read',
      target: targetLabel,
      fullTarget: fullPath,
      label: targetLabel ? `查阅 ${targetLabel}` : '查阅代码',
      actionLabel: targetLabel ? `查阅分析 ${targetLabel}` : '查阅代码与配置',
      isRead: Boolean(targetLabel && isReal),
    };
  }

  // 6. 搜索与信息检索 (rg / grep / search)
  if (n.includes('search') || n.includes('find') || n.includes('grep')) {
    const q = query || shortName || '关键字';
    const displayQ = q.length > 16 ? q.slice(0, 16) + '…' : q;
    return {
      kind: 'search',
      target: q,
      label: `检索 "${displayQ}"`,
      actionLabel: `检索相关信息: ${q}`,
      isSearch: true,
      isRead: false,
    };
  }

  // 7. 任务计划与实施清单 (update_todos)
  if (n === 'update_todos' || n === 'todos' || n === 'todo_list') {
    const completedCount = todos.filter((t) => t.status === 'completed' || t.status === 'done').length;
    const active = todos.find((t) => t.status === 'in_progress' || t.status === 'active')?.content || '';
    const isAllDone = completedCount === todos.length && todos.length > 0;
    const actionLabel = isAllDone
      ? `确认计划全项达成 (${completedCount}/${todos.length})`
      : active
      ? `推进实施计划: ${active}`
      : (todos.length ? `制定任务实施计划 (${todos.length} 项)` : '制定并更新任务实施计划');
    return {
      kind: 'plan',
      target: active || (todos.length ? `${completedCount}/${todos.length} 任务` : '任务清单'),
      label: isAllDone ? `计划全部达成 (${completedCount}/${todos.length})` : (todos.length ? `实施计划 (${completedCount}/${todos.length})` : '更新实施计划'),
      actionLabel,
      todos,
      isPlan: true,
    };
  }

  // 8. 状态与认知 (world_model)
  if (n.includes('world_model')) {
    const displaySub = subject ? (subject.length > 18 ? subject.slice(0, 18) + '…' : subject) : '';
    let label = '世界模型';
    let actionLabel = '世界模型认知推演';
    if (op === 'predict') {
      label = displaySub ? `推演: ${displaySub}` : '认知预测推演';
      actionLabel = subject ? `认知推演: ${subject}` : '发起认知状态推演';
    } else if (op === 'observe') {
      label = displaySub ? `观测回填: ${displaySub}` : '世界模型观测回填';
      actionLabel = subject ? `观测回填: ${subject}` : '回填客观执行观测';
    } else if (op === 'activate') {
      label = `激活 ${args?.mode || 'core'} 模式`;
      actionLabel = `激活认知世界模型 (${args?.mode || 'core'} 模式)`;
    } else {
      label = displaySub ? `认知状态: ${displaySub}` : '认知状态';
      actionLabel = subject ? `世界模型更新: ${subject}` : '更新世界模型认知状态';
    }
    return {
      kind: 'memory',
      target: displaySub || '认知记忆',
      label,
      actionLabel,
      subject,
      isMemory: true,
    };
  }

  // 9. 命令执行、自动化测试与门禁验证
  if (n.includes('bash') || n.includes('command') || n === 'exec' || n === 'run') {
    const cmdIntent = parseCommandIntent(cmd, toolSummary);
    return {
      kind: 'cmd',
      target: cmdIntent.label,
      cmd,
      toolSummary,
      label: cmdIntent.label,
      actionLabel: cmdIntent.action,
      isTest: cmdIntent.subKind === 'test',
      isBuild: cmdIntent.subKind === 'build',
      isLint: cmdIntent.subKind === 'lint',
      isSearch: cmdIntent.subKind === 'search',
      subKind: cmdIntent.subKind,
      isCmd: true,
    };
  }

  // 兜底
  return {
    kind: 'other',
    target: name,
    label: name,
    actionLabel: `调用工具 ${name}`,
  };
}

/**
 * 解析单个步骤的执行真实产出与验证结论
 */
export function parseToolOutcome(tool, category) {
  if (tool.status === 'running') {
    return { status: 'running', text: '正在执行中…', badge: '执行中', isRunning: true };
  }

  const isErr = tool.status === 'error' || (tool.exitCode !== undefined && tool.exitCode !== 0);
  if (isErr) {
    const rawResult = typeof tool.result === 'string' ? tool.result : '';
    const errSnippet = rawResult.slice(0, 80).replace(/\r?\n/g, ' ') || '操作未成功';
    return { status: 'error', text: errSnippet, badge: '异常', isError: true };
  }

  const res = typeof tool.result === 'string' ? tool.result : '';

  // 测试与门禁结果提炼
  if (category.isTest) {
    const failMatch = res.match(/(\d+)\s+failed|fail\s+(\d+)|FAIL/i);
    if (failMatch && Number(failMatch[1] || failMatch[2]) > 0) {
      return { status: 'error', text: `${failMatch[0]} 项未通过`, badge: '未通过', isError: true };
    }
    const passMatch = res.match(/(\d+)\s+passed|pass\s+(\d+)|(\d+)\s*项.*全部通过|all\s+(\d+)\s+tests passed/i);
    if (passMatch) {
      const count = passMatch[1] || passMatch[2] || passMatch[3] || passMatch[4] || '';
      return {
        status: 'done',
        text: count ? `${count} 项测试通过 · 0 报错` : '测试全部通过 · 0 报错',
        badge: '测试通过',
        isPass: true,
      };
    }
    if (/ok|pass|passed|0 fail/i.test(res)) {
      return { status: 'done', text: '全部测试通过 · 0 报错', badge: '通过', isPass: true };
    }
    return { status: 'done', text: '测试执行完毕', badge: '已完成', isPass: true };
  }

  // 构建与打包结果提炼
  if (category.isBuild) {
    const timeMatch = res.match(/built in (\d+m?s)/i);
    return {
      status: 'done',
      text: timeMatch ? `构建成功 (${timeMatch[1]})` : '构建打包成功',
      badge: '构建成功',
      isPass: true,
    };
  }

  // 代码风格与门禁检查
  if (category.isLint) {
    return { status: 'done', text: '门禁检查正常 · 无代码违规', badge: '门禁通过', isPass: true };
  }

  // 检索代码结果提炼
  if (category.isSearch || category.kind === 'search') {
    return { status: 'done', text: '检索完成', badge: '已检索', isPass: true };
  }

  // 代码修改保存
  if (category.isEdit) {
    return { status: 'done', text: '文件已更新并保存', badge: '已修改', isPass: true };
  }

  // 代码查阅提取
  if (category.isRead) {
    return { status: 'done', text: '已提取上下文逻辑', badge: '已查阅', isPass: true };
  }

  // 询问操作员
  if (category.isAsk) {
    return { status: 'done', text: '已收到操作员决策反馈', badge: '已反馈', isPass: true };
  }

  return { status: 'done', text: '执行成功', badge: '已完成', isPass: true };
}

/**
 * 合并整轮工具调用中出现的所有 update_todos 状态，提取最新的计划清单
 * 确保已经完成的任务保持 completed，绝不在后续轮次被覆盖回待办或进行中
 */
export function extractMergedTodos(parsedTools = [], isRunning = false) {
  const planTools = parsedTools.filter((item) => item.category?.isPlan && Array.isArray(item.category.todos));
  if (planTools.length === 0) return [];

  // 获取最后一个 todo 工具调用的任务列表
  const lastTodos = planTools[planTools.length - 1].category.todos || [];

  // 创建 Map 记录每个任务项的最优状态（若曾经或最新标记为 completed，保留已完成）
  const todoMap = new Map();
  for (const tool of planTools) {
    const list = tool.category.todos || [];
    for (const td of list) {
      const content = typeof td === 'string' ? td : td?.content || '';
      if (!content) continue;
      const status = td.status || 'pending';
      if (!todoMap.has(content)) {
        todoMap.set(content, { ...td, content, status });
      } else {
        const existing = todoMap.get(content);
        if (status === 'completed' || status === 'done') {
          existing.status = 'completed';
        } else if (existing.status !== 'completed' && (status === 'in_progress' || status === 'active')) {
          existing.status = 'in_progress';
        }
      }
    }
  }

  const merged = lastTodos.map((td) => {
    const content = typeof td === 'string' ? td : td?.content || '';
    return todoMap.get(content) || td;
  });

  return merged;
}

/**
 * 分析整轮工具链的实质结果，生成结构化实施计划缩要。
 * 智能聚合重复命令（例如13次代码检索合并为一个检索徽章，绝不输出13个重复卡片）。
 */
export function analyzeToolGroup(tools = [], userPrompt = '', isRunning = false) {
  const parsed = tools.map((t) => {
    const category = categorizeTool(t);
    const outcome = parseToolOutcome(t, category);
    return { ...t, category, outcome };
  });

  // 1. 去重收集修改的文件实体（仅限真实代码文件）
  const modifiedMap = new Map();
  for (const item of parsed) {
    if (item.category.isEdit && isRealFilePath(item.category.target)) {
      const key = item.category.fullTarget || item.category.target;
      if (!modifiedMap.has(key)) {
        modifiedMap.set(key, {
          name: item.category.target,
          path: item.category.fullTarget || item.category.target,
          status: item.outcome.status,
          outcome: item.outcome.text,
        });
      }
    }
  }
  const modifiedFiles = Array.from(modifiedMap.values());

  // 2. 去重收集查阅的参考文件实体（严格限制真实文件，绝不允许虚拟占位词）
  const inspectedMap = new Map();
  for (const item of parsed) {
    if (item.category.isRead && isRealFilePath(item.category.target)) {
      const key = item.category.fullTarget || item.category.target;
      if (!inspectedMap.has(key) && !modifiedMap.has(key)) {
        inspectedMap.set(key, {
          name: item.category.target,
          path: item.category.fullTarget || item.category.target,
          status: item.outcome.status,
        });
      }
    }
  }
  const inspectedFiles = Array.from(inspectedMap.values());

  // 3. 提取关键测试、构建与门禁验证
  const verificationCommands = parsed
    .filter((item) => item.category.isTest || item.category.isBuild || item.category.isLint)
    .map((item) => ({
      cmd: item.category.target,
      fullCmd: item.category.cmd,
      summary: item.category.toolSummary || item.category.label,
      outcome: item.outcome.text,
      badge: item.outcome.badge,
      isPass: item.outcome.isPass,
      isError: item.outcome.isError,
    }));

  // 4. 统计代码检索/排查调用的次数（如多个 rg/grep/fast_context 调用合并显示）
  const searchCommandsCount = parsed.filter(
    (item) => item.category.isSearch || item.category.kind === 'search'
  ).length;
  const exploreCount = parsed.filter((item) => item.category.isExplore).length;

  // 5. 提取并合并最新任务计划 (update_todos) 与世界模型认知推演主题
  const todos = extractMergedTodos(parsed, isRunning);
  const worldModelSubjects = [...new Set(parsed.filter((i) => i.category.subject).map((i) => i.category.subject))];

  // 6. 统计询问操作员或世界模型调用
  const askCount = parsed.filter((item) => item.category.isAsk).length;
  const memoryCount = parsed.filter((item) => item.category.isMemory).length;

  const errors = parsed.filter((item) => item.outcome.isError);

  // 7. 生成一句有实质意义的人类可读结论缩要（彻底消灭无意义冰冷计数器与通用空话）
  let headline = '';
  if (errors.length > 0) {
    headline = `⚠️ 执行遇到异常：${errors[0].category.label} (${errors[0].outcome.text})`;
  } else if (modifiedFiles.length > 0 && verificationCommands.length > 0) {
    const topMod = modifiedFiles.map((f) => f.name).slice(0, 2).join('、');
    const extraMod = modifiedFiles.length > 2 ? ` 等 ${modifiedFiles.length} 个文件` : '';
    const topVerify = verificationCommands[0].summary || verificationCommands[0].cmd;
    headline = `已修改 ${topMod}${extraMod} · 验证通过 (${topVerify})`;
  } else if (modifiedFiles.length > 0) {
    const topMod = modifiedFiles.map((f) => f.name).slice(0, 3).join('、');
    const extraMod = modifiedFiles.length > 3 ? ` 等 ${modifiedFiles.length} 处` : '';
    headline = `已完成代码修改：${topMod}${extraMod}`;
  } else if (verificationCommands.length > 0) {
    const topVerify = verificationCommands[0].summary || verificationCommands[0].cmd;
    headline = `已完成执行验证：${topVerify} (${verificationCommands[0].outcome})`;
  } else if (todos.length > 0) {
    const active = todos.find((t) => t.status === 'in_progress' || t.status === 'active')?.content;
    const completedCount = todos.filter((t) => t.status === 'completed' || t.status === 'done').length;
    if (completedCount === todos.length && todos.length > 0) {
      headline = `实施计划已全部达成 (共 ${todos.length} 项任务全部完成)`;
    } else if (active) {
      headline = `正在推进计划：${active} (${completedCount}/${todos.length})`;
    } else {
      headline = `已按计划实施：优先推进 ${todos[0]?.content || '核心任务'} (共 ${todos.length} 项)`;
    }
  } else if (worldModelSubjects.length > 0) {
    headline = `已完成认知推演与调研：${worldModelSubjects[0]}`;
  } else if (inspectedFiles.length > 0) {
    const topFiles = inspectedFiles.map((f) => f.name).slice(0, 3).join('、');
    const extraFiles = inspectedFiles.length > 3 ? ` 等 ${inspectedFiles.length} 个文件` : '';
    const searchNote = searchCommandsCount > 0 ? ` · 完成 ${searchCommandsCount} 次代码排查` : '';
    headline = `已查阅分析 ${topFiles}${extraFiles}${searchNote}`;
  } else if (searchCommandsCount > 0 || exploreCount > 0) {
    headline = `已完成代码排查与架构扫描 (共 ${searchCommandsCount + exploreCount} 次检索)`;
  } else if (userPrompt) {
    const promptIntent = extractUserPromptIntent(userPrompt);
    headline = `已围绕“${promptIntent}”完成本轮全部执行操作（共 ${tools.length} 步）`;
  } else {
    headline = `已完成本轮全部执行操作（共 ${tools.length} 步）`;
  }

  // 8. 生成最多 4 项聚合摘要徽章，保证界面干净清爽
  const summaryBadges = [];

  // (1) 计划徽章
  if (todos.length > 0) {
    const compCount = todos.filter((t) => t.status === 'completed' || t.status === 'done').length;
    const allDone = compCount === todos.length;
    summaryBadges.push({
      type: allDone ? 'verify' : 'ask',
      label: '实施计划',
      sub: allDone ? '全部完成' : `${compCount}/${todos.length} 项完成`,
      title: todos.map((t) => t.content).join('；'),
    });
  }

  // (2) 修改的文件徽章
  for (const file of modifiedFiles.slice(0, 2)) {
    summaryBadges.push({
      type: 'edit',
      label: file.name,
      sub: '修改',
      title: `修改代码文件: ${file.path}`,
    });
  }
  if (modifiedFiles.length > 2) {
    summaryBadges.push({
      type: 'edit',
      label: `另 ${modifiedFiles.length - 2} 个文件`,
      sub: '修改',
      title: modifiedFiles.map((f) => f.name).join(', '),
    });
  }

  // (3) 验证/测试门禁徽章
  for (const v of verificationCommands.slice(0, 2)) {
    summaryBadges.push({
      type: v.isError ? 'error' : 'verify',
      label: v.summary,
      sub: v.outcome,
      title: v.fullCmd || v.cmd,
    });
  }

  // (4) 查阅的参考文件徽章
  for (const file of inspectedFiles.slice(0, 2)) {
    if (summaryBadges.length >= 4) break;
    summaryBadges.push({
      type: 'read',
      label: file.name,
      sub: '查阅',
      title: `查阅参考: ${file.path}`,
    });
  }

  // (5) 聚合代码排查/检索徽章
  if ((searchCommandsCount > 0 || exploreCount > 0) && summaryBadges.length < 4) {
    const totalSearches = searchCommandsCount + exploreCount;
    summaryBadges.push({
      type: 'search',
      label: `代码排查与架构`,
      sub: `${totalSearches} 次调用`,
      title: `执行了 ${totalSearches} 次拓扑扫描与关键字检索`,
    });
  }

  // (6) 认知与状态徽章
  if (memoryCount > 0 && summaryBadges.length < 4) {
    const firstSubject = worldModelSubjects[0];
    summaryBadges.push({
      type: 'memory',
      label: firstSubject ? (firstSubject.length > 12 ? firstSubject.slice(0, 12) + '…' : firstSubject) : '世界模型',
      sub: `${memoryCount} 次状态推进`,
      title: firstSubject || '认知推演与状态推进',
    });
  }

  // 9. 智能阶段与里程碑聚合 (Phases & Milestones)
  const phases = [];
  if (todos.length > 0) {
    phases.push({
      id: 'plan',
      title: '实施计划清单与推进',
      badge: `${todos.filter((t) => t.status === 'completed' || t.status === 'done').length}/${todos.length} 完成`,
      isPlan: true,
      items: todos.map((t) => ({ text: t.content, status: t.status })),
    });
  } else if (worldModelSubjects.length > 0) {
    phases.push({
      id: 'memory',
      title: '认知推演与意图分析',
      badge: `${worldModelSubjects.length} 项推演`,
      items: worldModelSubjects.map((s) => ({ text: s, status: 'done' })),
    });
  }

  if (exploreCount > 0 || searchCommandsCount > 0 || inspectedFiles.length > 0) {
    const items = [];
    if (exploreCount > 0) items.push({ text: `全景扫描工程代码架构与接口拓扑 (${exploreCount} 次)`, status: 'done' });
    if (searchCommandsCount > 0) items.push({ text: `执行关键代码与语义检索 (${searchCommandsCount} 次)`, status: 'done' });
    for (const f of inspectedFiles) {
      items.push({ text: `查阅分析 ${f.name}`, status: 'done' });
    }
    phases.push({
      id: 'explore',
      title: '代码结构调研与上下文排查',
      badge: `${exploreCount + searchCommandsCount + inspectedFiles.length} 项操作`,
      items,
    });
  }

  if (modifiedFiles.length > 0) {
    phases.push({
      id: 'edit',
      title: '代码方案修改与实施',
      badge: `已修改 ${modifiedFiles.length} 处`,
      items: modifiedFiles.map((f) => ({ text: `修改文件 ${f.name}`, status: f.status })),
    });
  }

  if (verificationCommands.length > 0) {
    const passCount = verificationCommands.filter((v) => v.isPass).length;
    phases.push({
      id: 'verify',
      title: '自动化测试与门禁验证',
      badge: `${passCount}/${verificationCommands.length} 通过`,
      items: verificationCommands.map((v) => ({ text: `${v.summary}: ${v.outcome}`, status: v.isPass ? 'done' : 'error' })),
    });
  }

  return {
    parsed,
    modifiedFiles,
    inspectedFiles,
    verificationCommands,
    commands: verificationCommands,
    searchCommandsCount,
    exploreCount,
    todos,
    worldModelSubjects,
    phases,
    errors,
    headline,
    summaryBadges: summaryBadges.slice(0, 4), // 限制最多 4 个聚合徽章，保证界面永远清爽
  };
}

/**
 * 常见英文工程思维标题的本地化语义映射
 */
export function mapThinkingSectionToChinese(str) {
  if (!str) return '';
  const s = str.trim();
  if (/[\u4e00-\u9fa5]/.test(s)) return s;
  const lower = s.toLowerCase();

  if (lower.includes('project state') || lower.includes('workspace')) return '检查工作区与工程当前状态';
  if (lower.includes('project review') || lower.includes('repo inspection')) return '规划代码全景排查路径';
  if (lower.includes('relevant file') || lower.includes('adapter file') || lower.includes('locating app file')) return '定位并查阅相关核心实现代码';
  if (lower.includes('conversation storage') || lower.includes('session storage')) return '分析会话存储与持久化逻辑';
  if (lower.includes('evidence before edit') || lower.includes('check evidence')) return '梳理代码改动依据与方案';
  if (lower.includes('brief') || lower.includes('requirement')) return '分析当前需求与目标规范';
  if (lower.includes('running test') || lower.includes('test suite') || lower.includes('verifying')) return '运行测试套件验证业务改动';
  if (lower.includes('implement') || lower.includes('editing')) return '实施具体代码改动落地';
  if (lower.includes('locat') || lower.includes('search') || lower.includes('find')) return '排查检索目标代码位置';
  return s.length <= 40 ? s : '';
}

/**
 * 从用户提问中提炼出具体的目标研究课题，坚决杜绝"推导任务目标与实施路径规划"这类空洞废话
 */
export function extractUserPromptIntent(prompt) {
  if (!prompt || typeof prompt !== 'string') return '';
  const clean = prompt
    .replace(/<[^>]+>/g, '')
    .replace(/^#+\s+/gm, '')
    .trim();
  if (!clean) return '';

  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  const numberedItems = [];
  for (const l of lines) {
    const match = l.match(/^(?:(?:\d+[\.、\)])|(?:[①②③④⑤⑥⑦⑧⑨⑩])|(?:[-*•]\s+))(.*)/);
    if (match && match[1]) {
      const itemText = match[1].trim();
      if (itemText.length >= 2 && itemText.length <= 60) {
        numberedItems.push(itemText);
      }
    }
  }

  if (numberedItems.length > 0) {
    if (numberedItems.length === 1) {
      return `排查并解决：${numberedItems[0]}`;
    }
    const previewItems = numberedItems.slice(0, 2).map((it, i) => `${i + 1}. ${it.length > 24 ? it.slice(0, 22) + '…' : it}`).join('；');
    const extra = numberedItems.length > 2 ? ` 等 ${numberedItems.length} 项` : '';
    return `研究与处理：${previewItems}${extra}`;
  }

  const firstLine = lines[0] || '';
  if (firstLine.length <= 36) {
    return `排查并解决：${firstLine}`;
  }
  return `针对需求：“${firstLine.slice(0, 30)}…” 展开方案分析`;
}

/**
 * 从模型推导内容、本轮工具及用户输入中提取人类能真正看懂的思考思路与计划
 * 彻底消灭千篇一律的固定假文案（如"推导任务目标与实施路径规划"）
 */
export function extractThinkingStructure(raw, tools = [], userPrompt = '', isRunning = false) {
  let summary = '';
  let steps = [];

  // 1. 优先提取本轮工具调用中的任务规划清单 (update_todos / todos)
  const planTools = tools.filter((t) => {
    const n = String(t.name || '').toLowerCase();
    return n === 'update_todos' || n === 'todos';
  });

  if (planTools.length > 0) {
    const lastPlan = planTools[planTools.length - 1];
    const args = lastPlan.args || lastPlan.arguments || lastPlan.input || {};
    const todoList = Array.isArray(args.todos) ? args.todos : (Array.isArray(args.todo_list) ? args.todo_list : []);

    // 统计各任务项在全部 update_todos 调用中的最新完成状态
    const statusMap = new Map();
    for (const pt of planTools) {
      const pArgs = pt.args || pt.arguments || pt.input || {};
      const pList = Array.isArray(pArgs.todos) ? pArgs.todos : (Array.isArray(pArgs.todo_list) ? pArgs.todo_list : []);
      pList.forEach((ptd) => {
        const content = typeof ptd === 'string' ? ptd : ptd?.content || '';
        const status = ptd.status || 'pending';
        if (status === 'completed' || status === 'done') {
          statusMap.set(content, 'completed');
        } else if (!statusMap.has(content) || statusMap.get(content) !== 'completed') {
          statusMap.set(content, status);
        }
      });
    }

    if (todoList.length > 0) {
      steps = todoList.map((td) => {
        const content = typeof td === 'string' ? td : td?.content || '';
        const status = statusMap.get(content) || td.status || 'pending';
        return {
          content,
          status,
          isDone: status === 'completed' || status === 'done',
        };
      });

      const active = steps.find((s) => s.status === 'in_progress' || s.status === 'active')?.content;
      const completedCount = steps.filter((s) => s.isDone).length;
      const isAllDone = completedCount === steps.length && steps.length > 0;

      if (isAllDone) {
        summary = `已完成全部实施计划（共 ${steps.length} 项任务全部达成）`;
      } else if (active) {
        summary = `正在推进：${active}`;
      } else {
        summary = `已制定实施计划：优先推进 ${steps[0]?.content || '核心任务'}`;
      }
    }
  }

  // 2. 提取世界模型认知推演主题 (world_model predict subject)
  if (!summary) {
    const wmTool = tools.find((t) => {
      const n = String(t.name || '').toLowerCase();
      return n.includes('world_model');
    });
    if (wmTool) {
      const args = wmTool.args || wmTool.arguments || wmTool.input || {};
      if (args.subject && typeof args.subject === 'string' && args.subject.trim()) {
        summary = `认知推演：${args.subject.trim()}`;
      }
    }
  }

  // 3. 提取正在查阅/修改的真实代码文件作为思路支撑
  const inspectedFiles = [];
  const modifiedFiles = [];
  for (const t of tools) {
    const cat = categorizeTool(t);
    if (cat.isRead && isRealFilePath(cat.target)) {
      if (!inspectedFiles.includes(cat.target)) inspectedFiles.push(cat.target);
    }
    if (cat.isEdit && isRealFilePath(cat.target)) {
      if (!modifiedFiles.includes(cat.target)) modifiedFiles.push(cat.target);
    }
  }

  // 4. 解析推导文本中的中文核心分析句子
  if (raw && typeof raw === 'string') {
    const clean = raw
      .replace(/<[^>]+>/g, '')
      .replace(/```[\s\S]*?```/g, '')
      .trim();

    if (clean) {
      const lines = clean
        .split('\n')
        .map((l) => l.trim().replace(/^#{1,6}\s+/, '').replace(/^[*_`]+|[*_`]+$/g, ''))
        .filter(Boolean);

      // 提取中文核心分析句子（排查、解决、定位、实现、梳理）
      if (!summary) {
        for (const l of lines) {
          const hasChinese = /[\u4e00-\u9fa5]/.test(l);
          if (
            hasChinese &&
            l.length >= 8 &&
            l.length <= 120 &&
            !/^\d+[\.、]/.test(l) &&
            (l.includes('分析') ||
              l.includes('计划') ||
              l.includes('核心') ||
              l.includes('定位') ||
              l.includes('解决') ||
              l.includes('排查') ||
              l.includes('实现') ||
              l.includes('梳理') ||
              l.includes('针对'))
          ) {
            summary = l;
            break;
          }
        }
      }

      // 提取文本中的明确步骤项（若无 update_todos）
      if (steps.length === 0) {
        for (const l of lines) {
          if (steps.length >= 4) break;
          const stepMatch = l.match(/^(?:(?:\d+[\.、])|(?:步骤[一二三四五\d]+[:：])|(?:[-*]\s+))(.*)/);
          if (stepMatch && stepMatch[1]) {
            const stepText = stepMatch[1].trim();
            if (stepText.length >= 4 && stepText.length <= 80 && (/[\u4e00-\u9fa5]/.test(stepText) || !/^(?:I|The|We|You)\s+/i.test(stepText))) {
              steps.push(stepText);
            }
          }
        }
      }

      // 从 Markdown 粗体标题提炼高阶步骤
      if (steps.length === 0) {
        const boldMatches = [...raw.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1].trim());
        for (const b of boldMatches) {
          if (steps.length >= 3) break;
          const mapped = mapThinkingSectionToChinese(b);
          if (mapped && !steps.includes(mapped)) {
            steps.push(mapped);
          }
        }
      }
    }
  }

  // 5. 若仍无 summary，必须优先从用户输入意图提取明确的研究课题！
  if (!summary && userPrompt) {
    const promptIntent = extractUserPromptIntent(userPrompt);
    if (promptIntent) {
      summary = promptIntent;
    }
  }

  // 6. 若无用户提问，利用真实操作的代码文件生成有具体依据的思路
  if (!summary) {
    if (modifiedFiles.length > 0) {
      summary = `修改并落地方案：${modifiedFiles.slice(0, 2).join('、')}${modifiedFiles.length > 2 ? ` 等 ${modifiedFiles.length} 个文件` : ''}`;
    } else if (inspectedFiles.length > 0) {
      summary = `排查关键代码与逻辑：${inspectedFiles.slice(0, 2).join('、')}${inspectedFiles.length > 2 ? ` 等 ${inspectedFiles.length} 个组件` : ''}`;
    } else if (userPrompt) {
      summary = `针对需求：“${userPrompt.trim().slice(0, 28)}…” 展开推导`;
    } else {
      summary = '正在分析当前任务目标与工程代码实现';
    }
  }

  return { summary, steps };
}

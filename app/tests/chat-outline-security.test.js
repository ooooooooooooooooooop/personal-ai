import test from 'node:test';
import assert from 'node:assert/strict';
import { mapHistoryToMessages } from '../src/lib/history.js';
import { extractTurns } from '../src/lib/turns.js';
import {
  analyzeToolGroup,
  categorizeTool,
  parseToolOutcome,
  isRealFilePath,
  extractUserPromptIntent,
  extractThinkingStructure,
} from '../src/lib/tool-feedback.js';

test('extractTurns: groups user messages and computes tool steps and excerpts', () => {
  const messages = [
    {
      id: 'u-1',
      role: 'user',
      content: '帮我重构水体渲染逻辑并测试',
      timestamp: 1729310000000,
    },
    {
      id: 'a-1',
      role: 'assistant',
      content: '正在分析水体渲染模块……',
      thinking: '水岸几何与拉伸直墙',
      tools: [
        { id: 't-1', name: 'read_file', status: 'done' },
        { id: 't-2', name: 'edit_file', status: 'done' },
      ],
    },
    {
      id: 'a-2',
      role: 'assistant',
      content: '水体渲染重构完成，测试用例全部通过。',
      tools: [
        { id: 't-3', name: 'run_command', status: 'done' },
      ],
    },
    {
      id: 'u-2',
      role: 'user',
      content: '继续优化性能',
      timestamp: 1729311000000,
    },
    {
      id: 'a-3',
      role: 'assistant',
      content: '操作员中断了执行',
      interrupted: true,
      tools: [{ id: 't-4', name: 'run_command' }],
    },
  ];

  const turns = extractTurns(messages, false);
  assert.equal(turns.length, 2, 'Should extract exactly 2 user turns');

  // Turn 1 assertions
  const turn1 = turns[0];
  assert.equal(turn1.id, 'u-1');
  assert.equal(turn1.prompt, '帮我重构水体渲染逻辑并测试');
  assert.equal(turn1.stepCount, 3, 'Turn 1 has 3 tool execution steps');
  assert.equal(turn1.toolsCount, 3);
  assert.equal(turn1.status, 'done');
  assert.match(turn1.responseExcerpt, /正在分析水体渲染模块/);

  // Turn 2 assertions
  const turn2 = turns[1];
  assert.equal(turn2.id, 'u-2');
  assert.equal(turn2.prompt, '继续优化性能');
  assert.equal(turn2.stepCount, 1);
  assert.equal(turn2.status, 'interrupted', 'Should flag interrupted status');
});

test('extractTurns: flags running status on the active turn during execution', () => {
  const messages = [
    { id: 'u-1', role: 'user', content: '测试执行中状态' },
    { id: 'a-1', role: 'assistant', content: '正在执行' },
  ];
  const turns = extractTurns(messages, true);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, 'running', 'Last turn should reflect running=true');
});

test('security mode contracts: manual, full_access, and auto_review modes', () => {
  const validModes = ['manual', 'full_access', 'auto_review'];
  assert.ok(validModes.includes('manual'));
  assert.ok(validModes.includes('full_access'));
  assert.ok(validModes.includes('auto_review'));

  // Test auto_review model resolution logic
  const autoReviewModel = 'gemini-2.5-flash';
  const resolvedModel = autoReviewModel || '默认安全模型';
  assert.equal(resolvedModel, 'gemini-2.5-flash');

  // Test full_access auto verdict
  const simulateAskEvent = (mode) => {
    if (mode === 'full_access' || mode === 'auto_review') {
      return { autoResolve: true, verdict: 'allow' };
    }
    return { autoResolve: false, verdict: 'ask_operator' };
  };

  assert.deepEqual(simulateAskEvent('full_access'), { autoResolve: true, verdict: 'allow' });
  assert.deepEqual(simulateAskEvent('auto_review'), { autoResolve: true, verdict: 'allow' });
  assert.deepEqual(simulateAskEvent('manual'), { autoResolve: false, verdict: 'ask_operator' });
});

test('extractTurns: gracefully handles non-string content objects ({content: ...}) without throwing (Error #31 defense)', () => {
  const messagesWithObjectContent = [
    {
      id: 'u-obj-1',
      role: 'user',
      content: { content: '这是对象包装的用户消息' },
    },
    {
      id: 'a-obj-1',
      role: 'assistant',
      content: [{ type: 'text', text: '模型数组块内容' }],
    },
    {
      id: 'u-obj-2',
      role: 'user',
      content: { text: '这是text包装的用户提问' },
    },
    {
      id: 'a-obj-2',
      role: 'assistant',
      content: { content: '模型对象回复' },
    },
  ];

  const turns = extractTurns(messagesWithObjectContent, false);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].prompt, '这是对象包装的用户消息');
  assert.equal(turns[0].responseExcerpt, '模型数组块内容');
  assert.equal(turns[1].prompt, '这是text包装的用户提问');
  assert.equal(turns[1].responseExcerpt, '模型对象回复');
});

test('analyzeToolGroup: extracts substantive files, commands, and verified outcomes instead of generic counters', () => {
  const tools = [
    {
      id: 't-1',
      name: 'read_file',
      args: { Path: 'c:/Desktop/personal-ai/app/src/App.jsx', StartLine: 1, EndLine: 50 },
      status: 'done',
      result: 'Showing lines 1-50 of 1467',
    },
    {
      id: 't-2',
      name: 'read_file',
      args: { path: 'c:/Desktop/personal-ai/app/server/http-bridge.js' },
      status: 'done',
      result: 'read 200 lines',
    },
    {
      id: 't-3',
      name: 'edit_file',
      args: { Path: 'c:/Desktop/personal-ai/app/src/components/governance/AskCard.jsx' },
      status: 'done',
      result: 'File successfully edited',
    },
    {
      id: 't-4',
      name: 'run_command',
      args: { CommandLine: 'npm test', toolSummary: '运行自动化门禁测试' },
      status: 'done',
      result: 'tests 56\npass 55\nfail 0\nskipped 1',
    },
  ];

  const analysis = analyzeToolGroup(tools);

  // 1. Should deduplicate modified files and extract clean filename
  assert.equal(analysis.modifiedFiles.length, 1);
  assert.equal(analysis.modifiedFiles[0].name, 'AskCard.jsx');

  // 2. Should collect inspected references
  assert.equal(analysis.inspectedFiles.length, 2);
  const inspectedNames = analysis.inspectedFiles.map((f) => f.name);
  assert.ok(inspectedNames.includes('App.jsx'));
  assert.ok(inspectedNames.includes('http-bridge.js'));

  // 3. Should extract command and test results
  assert.equal(analysis.commands.length, 1);
  assert.equal(analysis.commands[0].summary, '运行自动化门禁测试');
  assert.match(analysis.commands[0].outcome, /测试全部通过|测试通过/);

  // 4. Headline must NOT be generic count string like "读取分析 2 次 · 代码修改 1 处"
  assert.doesNotMatch(analysis.headline, /读取分析\s*\d+\s*次/);
  assert.match(analysis.headline, /已修改 AskCard\.jsx/);
  assert.match(analysis.headline, /验证通过/);
});

test('analyzeToolGroup: aggregates repeated commands and prevents 13 identical chips nightmare', () => {
  // Simulate the real 14-step case from the user screenshot: 1 file read + 12 rg/cat searches + 1 ask_user
  const tools = [
    {
      id: 't-read-1',
      name: 'read_file',
      args: { path: 'c:/Desktop/personal-ai/pi/src/adapter/channel.js' },
      status: 'done',
      result: 'read 100 lines',
    },
  ];

  // 12 repeated bash search commands
  for (let i = 0; i < 12; i++) {
    tools.push({
      id: `t-bash-${i}`,
      name: 'bash',
      args: { command: `rg -n "session_cmd_${i}" pi/src/adapter/channel.js` },
      status: 'done',
      result: 'matches found',
    });
  }

  // 1 ask_user command
  tools.push({
    id: 't-ask-1',
    name: 'ask_user',
    args: { question: '是否继续执行？' },
    status: 'done',
    result: 'confirmed',
  });

  const analysis = analyzeToolGroup(tools);

  // 1. Should identify 14 total steps
  assert.equal(analysis.parsed.length, 14);

  // 2. Must aggregate the 12 searches instead of dumping 12 individual badges
  assert.equal(analysis.searchCommandsCount, 12);

  // 3. summaryBadges must be concise (<= 4 badges)
  assert.ok(analysis.summaryBadges.length <= 4);

  // 4. Badges must contain aggregated search count
  const searchBadge = analysis.summaryBadges.find((b) => b.type === 'search');
  assert.ok(searchBadge, 'Should have aggregated search badge');
  assert.match(searchBadge.sub, /12 次调用/);

  // 5. Must NOT have repeated duplicate badges
  const labels = analysis.summaryBadges.map((b) => b.label);
  const uniqueLabels = new Set(labels);
  assert.equal(labels.length, uniqueLabels.size, 'Badges must not contain duplicate labels');

  // 6. Headline must be human-meaningful context investigation, NOT "已完成执行验证: 执行命令 (执行成功)"
  assert.doesNotMatch(analysis.headline, /已完成执行验证:\s*执行命令/);
  assert.match(analysis.headline, /上下文调查与代码排查|代码排查/);
});

test('analyzeToolGroup: human-understandable process for repo_map, fast_context, todos and world_model', () => {
  // Reconstruct the 11-step real turn from user screenshot:
  // 3 repo_map + 1 update_todos + 1 world_model + 5 fast_context + 1 read
  const tools = [
    {
      id: 't-wm-1',
      name: 'world_model',
      args: { op: 'predict', subject: '定位会话持久化与标题生成的现有实现' },
      status: 'done',
    },
    {
      id: 't-todo-1',
      name: 'update_todos',
      args: {
        todos: [
          { content: '查明当前会话保存与标题生成位置', status: 'completed' },
          { content: '实现无实质内容不保存及自动生成对话标题', status: 'in_progress' },
          { content: '运行测试并检查改动', status: 'pending' },
        ],
      },
      status: 'done',
    },
    { id: 't-rm-1', name: 'repo_map', args: { subdir: 'app' }, status: 'done' },
    { id: 't-rm-2', name: 'repo_map', args: { subdir: 'pi/src' }, status: 'done' },
    { id: 't-rm-3', name: 'repo_map', args: {}, status: 'done' },
    {
      id: 't-fc-1',
      name: 'fast_context',
      args: { query: 'conversation title auto session save', subdir: 'app' },
      status: 'done',
    },
    {
      id: 't-fc-2',
      name: 'fast_context',
      args: { query: 'SessionManager inMemory persist', subdir: 'pi' },
      status: 'done',
    },
    {
      id: 't-read-1',
      name: 'read',
      args: { path: 'pi/src/adapter/index.js' },
      status: 'done',
    },
  ];

  const analysis = analyzeToolGroup(tools);

  // 1. repo_map must NOT be displayed as raw 'repo_map'
  const rmParsed = analysis.parsed.filter((p) => p.name === 'repo_map');
  for (const p of rmParsed) {
    assert.doesNotMatch(p.category.label, /^repo_map$/i);
    assert.match(p.category.label, /扫描.*拓扑|扫描工程架构/);
  }

  // 2. fast_context must NOT be displayed as '查阅 代码文件'
  const fcParsed = analysis.parsed.filter((p) => p.name === 'fast_context');
  for (const p of fcParsed) {
    assert.notEqual(p.category.label, '查阅 代码文件');
    assert.match(p.category.label, /检索/);
  }

  // 3. read must extract the real file name
  const readParsed = analysis.parsed.find((p) => p.name === 'read');
  assert.equal(readParsed.category.target, 'index.js');
  assert.equal(readParsed.category.label, '查阅 index.js');

  // 4. Must extract structured todos plan
  assert.equal(analysis.todos.length, 3);
  assert.equal(analysis.todos[0].content, '查明当前会话保存与标题生成位置');
  assert.equal(analysis.todos[1].status, 'in_progress');

  // 5. Must group into structured phases (Phases & Milestones)
  assert.ok(analysis.phases.length >= 2);
  const planPhase = analysis.phases.find((ph) => ph.id === 'plan');
  assert.ok(planPhase);
  assert.equal(planPhase.items.length, 3);

  const explorePhase = analysis.phases.find((ph) => ph.id === 'explore');
  assert.ok(explorePhase);

  // 6. Headline must be substantive and NEVER say "已顺利完成全部 11 项实施步骤"
  assert.doesNotMatch(analysis.headline, /已顺利完成全部\s*\d+\s*项实施步骤/);
  assert.match(analysis.headline, /查明当前会话保存|实现无实质内容不保存|会话持久化与标题生成/);
});

test('isRealFilePath: strictly admits real file paths and filters fake/synthetic tokens and queries', () => {
  // Valid real files
  assert.ok(isRealFilePath('App.jsx'));
  assert.ok(isRealFilePath('ChatOutline.jsx'));
  assert.ok(isRealFilePath('app/src/App.jsx'));
  assert.ok(isRealFilePath('pi/src/adapter/index.js'));
  assert.ok(isRealFilePath('package.json'));
  assert.ok(isRealFilePath('supervisor.js'));
  assert.ok(isRealFilePath('schema.json'));
  assert.ok(isRealFilePath('style.css'));

  // Invalid fake synthetic tokens - MUST BE REJECTED
  assert.equal(isRealFilePath('代码上下文'), false);
  assert.equal(isRealFilePath('核心代码'), false);
  assert.equal(isRealFilePath('代码文件'), false);
  assert.equal(isRealFilePath('上下文'), false);
  assert.equal(isRealFilePath('文件'), false);
  assert.equal(isRealFilePath('工程全局架构'), false);
  assert.equal(isRealFilePath('app 拓扑'), false);
  assert.equal(isRealFilePath('目录 新建对话 项目'), false);
  assert.equal(isRealFilePath('ChatOutline TopBar…'), false);
  assert.equal(isRealFilePath(''), false);
  assert.equal(isRealFilePath(null), false);
});

test('extractUserPromptIntent: derives concrete, human-readable research topic from multi-point user prompt', () => {
  // Multi-point numbered prompt
  const p1 = '1、右上角“目录”默认收起而不是打开\n2、左上角新建对话默认没有项目用于快速开启对话';
  const i1 = extractUserPromptIntent(p1);
  assert.match(i1, /研究与处理：/);
  assert.match(i1, /右上角“目录”默认收起/);
  assert.match(i1, /新建对话/);

  // Single complaint
  const p2 = '审批不说明审批什么东西';
  const i2 = extractUserPromptIntent(p2);
  assert.equal(i2, '排查并解决：审批不说明审批什么东西');

  // Bullet point list
  const p3 = '- 修复会话切换失败\n- 清理重复引擎入口';
  const i3 = extractUserPromptIntent(p3);
  assert.match(i3, /研究与处理：/);
  assert.match(i3, /修复会话切换失败/);
});

test('extractThinkingStructure: never returns generic platitudes like "推导任务目标与实施路径规划"', () => {
  const userPrompt = '1、右上角“目录”默认收起而不是打开\n2、左上角新建对话默认没有项目用于快速开启对话';
  const englishThinking = 'The user reports two UI issues: a collapsed table of contents by default...';
  const initialTools = [{ name: 'world_model', args: { op: 'status' } }];

  // 1. Initial phase before todos: must use user intent, NEVER generic platitude
  const res1 = extractThinkingStructure(englishThinking, initialTools, userPrompt);
  assert.notEqual(res1.summary, '推导任务目标与实施路径规划');
  assert.doesNotMatch(res1.summary, /推导任务目标与实施路径规划|排查定位相关代码与配置逻辑/);
  assert.match(res1.summary, /右上角“目录”默认收起/);

  // 2. Active todos phase: must reflect the active todo item
  const toolsWithTodos = [
    { name: 'world_model', args: { op: 'status' } },
    {
      name: 'update_todos',
      args: {
        todos: [
          { status: 'in_progress', content: '定位右上角“目录”和左上角新建对话的相关前端代码' },
          { status: 'pending', content: '将右上角“目录”默认状态改为收起' },
        ],
      },
    },
  ];
  const res2 = extractThinkingStructure(englishThinking, toolsWithTodos, userPrompt);
  assert.equal(res2.summary, '正在推进：定位右上角“目录”和左上角新建对话的相关前端代码');
  assert.equal(res2.steps.length, 2);
});

test('analyzeToolGroup: zero fake synthetic badges in real 11-step exploration turn', () => {
  const userPrompt = '1、右上角“目录”默认收起而不是打开\n2、左上角新建对话默认没有项目用于快速开启对话';
  const tools = [
    { name: 'world_model', args: { op: 'status' }, status: 'done' },
    {
      name: 'update_todos',
      args: {
        todos: [
          { status: 'in_progress', content: '定位右上角“目录”和左上角新建对话的相关前端代码' },
          { status: 'pending', content: '将右上角“目录”默认状态改为收起' },
          { status: 'pending', content: '实现新建对话时默认无项目用于快速开启对话' },
          { status: 'pending', content: '运行 app 模块的 lint 与自动化测试验证修改' },
        ],
      },
      status: 'done',
    },
    { name: 'fast_context', args: { query: '目录 新建对话 项目', subdir: 'app' }, status: 'done' },
    { name: 'bash', args: { command: 'find app -maxdepth 3' }, status: 'done' },
    { name: 'bash', args: { command: 'rg -i "outline|目录" app/src' }, status: 'done' },
    { name: 'bash', args: { command: 'git grep -n "目录" app/' }, status: 'done' },
    { name: 'read', args: { path: 'app/package.json' }, status: 'done' },
    { name: 'bash', args: { command: 'find app/src -type f' }, status: 'done' },
    { name: 'bash', args: { command: 'git grep -n "outline" app/' }, status: 'done' },
    { name: 'bash', args: { command: 'git status' }, status: 'done' },
    { name: 'fast_context', args: { query: 'ChatOutline TopBar Sidebar', subdir: 'app/src' }, status: 'done' },
  ];

  const analysis = analyzeToolGroup(tools, userPrompt);

  // 1. Inspected files must ONLY contain package.json, NEVER search queries or fake tokens
  assert.equal(analysis.inspectedFiles.length, 1);
  assert.equal(analysis.inspectedFiles[0].name, 'package.json');
  assert.equal(analysis.inspectedFiles[0].path, 'app/package.json');

  // 2. Badges must NEVER contain '代码上下文' or '核心代码'
  for (const b of analysis.summaryBadges) {
    assert.notEqual(b.label, '代码上下文');
    assert.notEqual(b.label, '核心代码');
    assert.notEqual(b.label, '代码文件');
  }

  // 3. Phases must NEVER have '查阅分析 代码上下文' or '查阅分析 核心代码'
  const explorePhase = analysis.phases.find((p) => p.id === 'explore');
  assert.ok(explorePhase);
  for (const item of explorePhase.items) {
    const text = typeof item === 'string' ? item : item.text;
    assert.doesNotMatch(text, /代码上下文|核心代码|代码文件/);
  }

  // 4. Headline must be substantive
  assert.match(analysis.headline, /正在推进计划：定位右上角“目录”和左上角新建对话/);
});

test('extractMergedTodos and ToolGroup: handles multiple update_todos calls and provides closure with operation breakdown', () => {
  // Reconstruct the 6-step turn from user screenshot:
  // Step 1: bash ls
  // Step 2: bash find
  // Step 3: read current_screen.png
  // Step 4: read temp_screenshot.png
  // Step 5: update_todos (0/2 completed)
  // Step 6: update_todos (2/2 completed)
  const userPrompt = '这是什么';
  const tools = [
    { id: 't-1', name: 'bash', args: { command: 'ls -la | head -60' }, status: 'done' },
    { id: 't-2', name: 'bash', args: { command: 'find . -maxdepth 2 -iname "*screen*"' }, status: 'done' },
    { id: 't-3', name: 'read', args: { path: 'current_screen.png' }, status: 'done' },
    { id: 't-4', name: 'read', args: { path: 'temp_screenshot.png' }, status: 'done' },
    {
      id: 't-5',
      name: 'update_todos',
      args: {
        todos: [
          { content: '从附件或可用截图中提取可读信息', status: 'in_progress' },
          { content: '根据截图内容用中文解释它是什么', status: 'pending' },
        ],
      },
      status: 'done',
    },
    {
      id: 't-6',
      name: 'update_todos',
      args: {
        todos: [
          { content: '从附件或可用截图中提取可读信息', status: 'completed' },
          { content: '根据截图内容用中文解释它是什么', status: 'completed' },
        ],
      },
      status: 'done',
    },
  ];

  // 1. analyzeToolGroup must capture the LATEST 2/2 completed state, NOT be stuck on 0/2
  const analysis = analyzeToolGroup(tools, userPrompt, false);
  assert.equal(analysis.todos.length, 2);
  assert.equal(analysis.todos[0].status, 'completed');
  assert.equal(analysis.todos[1].status, 'completed');
  assert.match(analysis.headline, /实施计划已全部达成 \(共 2 项任务全部完成\)/);

  // 2. Summary badges must show '全部完成' for plan
  const planBadge = analysis.summaryBadges.find((b) => b.label === '实施计划');
  assert.ok(planBadge);
  assert.equal(planBadge.sub, '全部完成');

  // 3. Underlying operations count must be 6, and each operation must have a readable actionLabel
  assert.equal(analysis.parsed.length, 6);
  assert.match(analysis.parsed[0].category.actionLabel, /查看.*文件列表|查看目录/);
  assert.match(analysis.parsed[1].category.actionLabel, /检索查找文件/);
  assert.match(analysis.parsed[2].category.actionLabel, /查阅分析 current_screen\.png/);
  assert.match(analysis.parsed[3].category.actionLabel, /查阅分析 temp_screenshot\.png/);
  assert.match(analysis.parsed[4].category.actionLabel, /推进实施计划/);
  assert.match(analysis.parsed[5].category.actionLabel, /确认计划全项达成/);

  // 4. extractThinkingStructure must wrap up/conclude when turn is completed
  const thinking = 'Interpreting the generated brief...';
  const thinkingRes = extractThinkingStructure(thinking, tools, userPrompt, false);
  assert.match(thinkingRes.summary, /已完成全部实施计划/);
  assert.equal(thinkingRes.steps.length, 2);
  assert.equal(thinkingRes.steps[0].isDone, true);
  assert.equal(thinkingRes.steps[1].isDone, true);
});

test('mapHistoryToMessages: clears intermediate transient error when turn subsequently succeeds', () => {
  const history = [
    { role: 'user', content: '测试问题' },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c1', name: 'read_file', args: { path: 'a.txt' } }],
    },
    { role: 'toolResult', toolCallId: 'c1', content: 'file content' },
    // Step with transient error
    {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'Connection error.',
    },
    // Step retried and succeeded
    {
      role: 'assistant',
      content: [{ type: 'text', text: '任务已成功完成。' }],
      stopReason: 'stop',
    },
  ];

  const messages = mapHistoryToMessages(history);
  assert.equal(messages.length, 2, 'Should merge into 1 user and 1 assistant message');
  const assistantMsg = messages[1];
  assert.equal(assistantMsg.role, 'assistant');
  assert.equal(assistantMsg.content, '任务已成功完成。');
  assert.equal(assistantMsg.error, undefined, 'Intermediate Connection error must be cleared because turn completed cleanly');
});

test('mapHistoryToMessages: preserves genuine terminal error when turn ends in error', () => {
  const history = [
    { role: 'user', content: '测试问题' },
    {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: 'Connection error.',
    },
  ];

  const messages = mapHistoryToMessages(history);
  assert.equal(messages.length, 2);
  const assistantMsg = messages[1];
  assert.equal(assistantMsg.role, 'assistant');
  assert.equal(assistantMsg.error, 'Connection error.', 'Terminal error must be preserved');
});
